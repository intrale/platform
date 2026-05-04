#!/usr/bin/env node
// .pipeline/anomaly-detector.js — Detector reactivo de consumo anómalo (#2891 PR-B)
//
// Lee `.pipeline/metrics/snapshot.json` (producido por aggregator.js), compara
// el costo de la hora actual contra el baseline horario (rolling window 7-14
// días) y persiste cada evaluación en `.pipeline/metrics-history.jsonl` con
// shape `{ type, ts, hour, baseline_usd, actual_usd, ratio, alerted }`.
//
// **NO** dispara canales de alerta (Telegram / banner / etc) — eso queda para
// PR-C (#2882). Este detector solo persiste evaluaciones y emite eventos
// internos via EventEmitter para que el integrador (pulpo.js o un servicio
// dedicado) los consuma cuando se quiera enchufar canales.
//
// Modos:
//   node anomaly-detector.js                  → daemon: corre cada intervalMin
//   node anomaly-detector.js --once           → una evaluación y exit
//   node anomaly-detector.js --interval 5     → override intervalMin (1-240)
//   node anomaly-detector.js --threshold 0.7  → override pctThreshold (0.05-5.0)
//
// La configuración por defecto vive en config.yaml bajo `anomaly_detector`.
// Cualquier valor inválido cae al default (con warning en stderr) — nunca
// detiene la ejecución por una config rota: el detector debe seguir corriendo.

'use strict';

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const REPO_ROOT = process.env.PIPELINE_REPO_ROOT || process.cwd();
const PIPELINE_DIR = path.join(REPO_ROOT, '.pipeline');
const SNAPSHOT_FILE = path.join(PIPELINE_DIR, 'metrics', 'snapshot.json');
const HISTORY_FILE = path.join(PIPELINE_DIR, 'metrics-history.jsonl');
const CONFIG_FILE = path.join(PIPELINE_DIR, 'config.yaml');

// Defaults — ver issue #2882 (épico) para rationale.
//   pctThreshold: actual > baseline * (1 + 0.5) → +50% sobre baseline
//   minUsdToAlert: piso absoluto: si actual ≤ 0.50 USD/hora, no se alerta
//                  ni siquiera si supera el threshold relativo (evita ruido)
//   warmupDays: durante los primeros N días con poca historia, solo se
//               alerta si actual supera minAbsUsdPerHour (umbral grueso)
//   minAbsUsdPerHour: umbral absoluto durante warmup (más permisivo)
//   intervalMin: cadencia del cron interno
//   lookbackDays: ventana del baseline (también usada por aggregator)
const DEFAULTS = Object.freeze({
    intervalMin: 10,
    pctThreshold: 0.5,
    warmupDays: 7,
    lookbackDays: 7,
    minUsdToAlert: 0.5,
    minAbsUsdPerHour: 2.0,
});

// Rangos válidos. Inputs fuera de rango se reemplazan por DEFAULTS y se loguea
// un warning. Esto es seguridad: nadie inyecta `intervalMin: -1` y rompe el
// pipeline. El criterio de aceptación CA-2.3 manda intervalMin ∈ [1, 240] y
// pctThreshold ∈ [0.05, 5.0].
const RANGES = Object.freeze({
    intervalMin: [1, 240],
    pctThreshold: [0.05, 5.0],
    warmupDays: [0, 90],
    lookbackDays: [1, 30],
    minUsdToAlert: [0, 1000],
    minAbsUsdPerHour: [0, 1000],
});

function clamp(name, value, fallback) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    const [lo, hi] = RANGES[name];
    if (n < lo || n > hi) return fallback;
    return n;
}

// validateConfig: NUNCA tira; reemplaza valores rotos por defaults.
// Devuelve { config: {...}, warnings: [...] } para que el caller pueda loguear.
function validateConfig(input) {
    const raw = input && typeof input === 'object' ? input : {};
    const warnings = [];
    const config = {};
    for (const key of Object.keys(DEFAULTS)) {
        if (raw[key] === undefined || raw[key] === null) {
            config[key] = DEFAULTS[key];
            continue;
        }
        const clamped = clamp(key, raw[key], DEFAULTS[key]);
        if (clamped !== Number(raw[key])) {
            warnings.push(`config.${key}=${raw[key]} fuera de rango ${RANGES[key].join('-')}, usando default ${DEFAULTS[key]}`);
        }
        config[key] = clamped;
    }
    // Floor a entero donde corresponde (intervalo y días son discretos)
    config.intervalMin = Math.floor(config.intervalMin);
    config.warmupDays = Math.floor(config.warmupDays);
    config.lookbackDays = Math.floor(config.lookbackDays);
    return { config, warnings };
}

function readSnapshotSafe(file) {
    try {
        const raw = fs.readFileSync(file, 'utf8');
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' ? parsed : null;
    } catch (e) {
        return null;
    }
}

// evaluate({ snapshot, now, config }) → record
// Determinístico y puro: dado el mismo snapshot/now/config, devuelve el mismo
// record. No hace I/O. Por eso es trivial de testear.
function evaluate({ snapshot, now, config }) {
    const { config: cfg } = validateConfig(config || {});
    const _now = now instanceof Date ? now : new Date(now || Date.now());
    const HH = String(_now.getUTCHours()).padStart(2, '0');

    const series = (snapshot && snapshot.hourlySeries) || {};
    const hourly = series[HH] || { cost_usd: 0, samples: 0 };
    const baseline = Number(hourly.cost_usd || 0);

    const currentHour = (snapshot && snapshot.currentHour) || {};
    const actual = Number(currentHour.cost_usd || 0);

    // ratio: ¿cuántas veces la baseline estamos consumiendo?
    // Si baseline=0 y actual>0 → ratio Infinity (nunca antes hubo nada acá).
    let ratio;
    if (baseline > 0) ratio = actual / baseline;
    else if (actual > 0) ratio = Infinity;
    else ratio = 0;

    const meta = (snapshot && snapshot.hourlyMeta) || {};
    const daysWithData = Number(meta.daysWithData || 0);
    const inWarmup = daysWithData < cfg.warmupDays;

    let alerted = false;
    let reason;
    if (inWarmup) {
        // Warmup: solo dispara si supera umbral absoluto grueso. Evita ruido
        // mientras todavía no hay baseline confiable.
        if (actual > cfg.minAbsUsdPerHour) {
            alerted = true;
            reason = 'warmup_absolute_breach';
        } else {
            reason = 'warmup_within_absolute';
        }
    } else if (actual <= cfg.minUsdToAlert) {
        // Por debajo del piso de "vale la pena alertar". Evita ruido en
        // franjas vacías donde +1000% sobre $0.001 se dispararía sin sentido.
        reason = 'below_min_usd';
    } else if (actual > baseline * (1 + cfg.pctThreshold)) {
        alerted = true;
        reason = 'relative_threshold_breach';
    } else {
        reason = 'within_threshold';
    }

    return {
        type: 'anomaly',
        ts: _now.toISOString(),
        hour: HH,
        baseline_usd: round4(baseline),
        actual_usd: round4(actual),
        ratio: Number.isFinite(ratio) ? round3(ratio) : null,
        alerted,
        reason,
        warmup: inWarmup,
        days_with_data: daysWithData,
    };
}

function round4(n) { return Math.round(Number(n) * 10000) / 10000; }
function round3(n) { return Math.round(Number(n) * 1000) / 1000; }

// persistEvaluation: append-only. NUNCA persiste paths absolutos ni secretos
// (preparado para sanitización en PR-C). El record contiene solo numéricos +
// hora + flag — explícitamente seguro para replicar.
function persistEvaluation(record, file) {
    const target = file || HISTORY_FILE;
    const dir = path.dirname(target);
    try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { /* ignore */ }
    // Solo el contrato CA-2.5 + type discriminator. Otros campos del record
    // (warmup, reason, days_with_data) son útiles para debugging pero NO van
    // al jsonl: ese es contrato canónico hacia los lectores existentes.
    const payload = {
        type: 'anomaly',
        ts: record.ts,
        hour: record.hour,
        baseline_usd: record.baseline_usd,
        actual_usd: record.actual_usd,
        ratio: record.ratio,
        alerted: !!record.alerted,
    };
    fs.appendFileSync(target, JSON.stringify(payload) + '\n', 'utf8');
}

// loadConfigFromYaml: lee `anomaly_detector` de `.pipeline/config.yaml`.
// Si yaml no está o el archivo no existe, devuelve {} (defaults).
function loadConfigFromYaml(file) {
    const target = file || CONFIG_FILE;
    try {
        if (!fs.existsSync(target)) return {};
        const yaml = require('js-yaml');
        const parsed = yaml.load(fs.readFileSync(target, 'utf8')) || {};
        return parsed.anomaly_detector || {};
    } catch (e) {
        return {};
    }
}

class AnomalyDetector extends EventEmitter {
    constructor(options) {
        super();
        const opts = options || {};
        this.snapshotPath = opts.snapshotPath || SNAPSHOT_FILE;
        this.historyPath = opts.historyPath || HISTORY_FILE;
        const validated = validateConfig(opts.config || {});
        this.config = validated.config;
        this.warnings = validated.warnings;
        this.timer = null;
        this.lastEvaluation = null;
    }

    runOnce(now) {
        const snapshot = readSnapshotSafe(this.snapshotPath) || {};
        const evaluation = evaluate({
            snapshot,
            now: now || new Date(),
            config: this.config,
        });
        try {
            persistEvaluation(evaluation, this.historyPath);
        } catch (e) {
            this.emit('error', e);
        }
        this.lastEvaluation = evaluation;
        this.emit('evaluation', evaluation);
        if (evaluation.alerted) this.emit('anomaly', evaluation);
        return evaluation;
    }

    start() {
        if (this.timer) return;
        const tick = () => {
            try { this.runOnce(); }
            catch (e) { this.emit('error', e); }
        };
        // Primera corrida inmediata para que el dashboard tenga señal pronto.
        tick();
        this.timer = setInterval(tick, this.config.intervalMin * 60 * 1000);
        // unref → no impedir que el proceso muera si solo queda este timer.
        if (this.timer.unref) this.timer.unref();
    }

    stop() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }
}

// CLI entry — solo cuando se invoca como script principal.
function parseCliArgs(argv) {
    const args = { once: false, configOverride: {} };
    for (let i = 2; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--once') args.once = true;
        else if (a === '--interval' && argv[i + 1]) { args.configOverride.intervalMin = parseInt(argv[++i], 10); }
        else if (a === '--threshold' && argv[i + 1]) { args.configOverride.pctThreshold = parseFloat(argv[++i]); }
        else if (a === '--warmup-days' && argv[i + 1]) { args.configOverride.warmupDays = parseInt(argv[++i], 10); }
        else if (a === '--lookback-days' && argv[i + 1]) { args.configOverride.lookbackDays = parseInt(argv[++i], 10); }
        else if (a === '--min-usd' && argv[i + 1]) { args.configOverride.minUsdToAlert = parseFloat(argv[++i]); }
        else if (a === '--help' || a === '-h') {
            process.stdout.write('Uso: anomaly-detector.js [--once] [--interval min] [--threshold pct] [--warmup-days N] [--lookback-days N] [--min-usd USD]\n');
            process.exit(0);
        }
    }
    return args;
}

function main() {
    const args = parseCliArgs(process.argv);
    const yamlConfig = loadConfigFromYaml();
    const merged = Object.assign({}, yamlConfig, args.configOverride);
    const detector = new AnomalyDetector({ config: merged });
    for (const w of detector.warnings) process.stderr.write(`[anomaly-detector] WARN: ${w}\n`);

    detector.on('evaluation', (e) => {
        process.stdout.write(`[anomaly-detector] ${JSON.stringify({ ts: e.ts, hour: e.hour, baseline_usd: e.baseline_usd, actual_usd: e.actual_usd, ratio: e.ratio, alerted: e.alerted, reason: e.reason })}\n`);
    });
    detector.on('error', (e) => {
        process.stderr.write(`[anomaly-detector] ERROR: ${e.message}\n`);
    });

    if (args.once) {
        detector.runOnce();
        return;
    }
    detector.start();
    process.on('SIGINT', () => { detector.stop(); process.exit(0); });
    process.on('SIGTERM', () => { detector.stop(); process.exit(0); });
}

if (require.main === module) {
    main();
}

module.exports = {
    AnomalyDetector,
    evaluate,
    validateConfig,
    persistEvaluation,
    loadConfigFromYaml,
    DEFAULTS,
    RANGES,
    HISTORY_FILE,
    SNAPSHOT_FILE,
};
