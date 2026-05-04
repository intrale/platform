// Tests del detector de anomalías de consumo (#2891 PR-B).
// Cubre los criterios CA-2.2 (warmup), CA-2.3 (intervalo configurable),
// CA-2.4 (threshold relativo + mínimo absoluto) y CA-2.5 (persistencia).
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'anomaly-'));
fs.mkdirSync(path.join(TMP_DIR, '.pipeline', 'metrics'), { recursive: true });

// Forzamos el detector a buscar archivos en el TMP_DIR. PIPELINE_REPO_ROOT lo
// usa el módulo para resolver SNAPSHOT_FILE / HISTORY_FILE — pero en estos
// tests construimos el detector con paths explícitos para no depender del env.
process.env.PIPELINE_REPO_ROOT = TMP_DIR;

delete require.cache[require.resolve('../anomaly-detector')];
const detectorMod = require('../anomaly-detector');
const { AnomalyDetector, evaluate, validateConfig, persistEvaluation, DEFAULTS } = detectorMod;

// Snapshot sintético construido por los tests. No tocamos el aggregator real:
// el detector solo necesita { hourlySeries, currentHour, hourlyMeta }.
function snapshotWith({ hour, baseline, actual, daysWithData }) {
    const HH = String(hour).padStart(2, '0');
    const series = {};
    for (let h = 0; h < 24; h++) {
        const KH = String(h).padStart(2, '0');
        series[KH] = { cost_usd: 0, tokens: 0, sessions: 0, samples: 0 };
    }
    series[HH] = { cost_usd: baseline, tokens: 1000, sessions: 5, samples: 7 };
    return {
        hourlySeries: series,
        hourlyMeta: { lookbackDays: 7, daysWithData, windowStart: '2026-04-01T00:00:00Z', windowEnd: '2026-04-08T00:00:00Z' },
        currentHour: { hour: HH, date: '2026-04-30', cost_usd: actual, tokens: 0, sessions: 0, ts: '2026-04-30T14:35:00Z' },
    };
}

function nowAt(hour) {
    return new Date(Date.UTC(2026, 3, 30, hour, 0, 0, 0));
}

test('validateConfig usa defaults cuando no hay input', () => {
    const { config, warnings } = validateConfig({});
    assert.deepEqual(config, DEFAULTS);
    assert.equal(warnings.length, 0);
});

test('validateConfig clampa valores fuera de rango y reporta warning', () => {
    const { config, warnings } = validateConfig({
        intervalMin: 999,    // > 240
        pctThreshold: 0.001, // < 0.05
        warmupDays: -5,      // < 0
        lookbackDays: 100,   // > 30
    });
    assert.equal(config.intervalMin, DEFAULTS.intervalMin, 'intervalMin debe caer al default');
    assert.equal(config.pctThreshold, DEFAULTS.pctThreshold, 'pctThreshold debe caer al default');
    assert.equal(config.warmupDays, DEFAULTS.warmupDays);
    assert.equal(config.lookbackDays, DEFAULTS.lookbackDays);
    assert.equal(warnings.length, 4, 'cada valor inválido genera un warning');
});

test('validateConfig acepta valores en rango sin warnings', () => {
    const { config, warnings } = validateConfig({
        intervalMin: 5,
        pctThreshold: 1.0,
        warmupDays: 14,
        lookbackDays: 14,
        minUsdToAlert: 0.25,
        minAbsUsdPerHour: 5.0,
    });
    assert.equal(config.intervalMin, 5);
    assert.equal(config.pctThreshold, 1.0);
    assert.equal(warnings.length, 0);
});

test('validateConfig nunca tira con input nulo o no-objeto', () => {
    assert.doesNotThrow(() => validateConfig(null));
    assert.doesNotThrow(() => validateConfig(undefined));
    assert.doesNotThrow(() => validateConfig('rompeme'));
    assert.doesNotThrow(() => validateConfig(42));
    const { config } = validateConfig(null);
    assert.deepEqual(config, DEFAULTS);
});

test('CA-2.4 threshold relativo dispara cuando actual > baseline*(1+pct)', () => {
    const snapshot = snapshotWith({ hour: 14, baseline: 1.0, actual: 2.0, daysWithData: 7 });
    const result = evaluate({ snapshot, now: nowAt(14), config: { pctThreshold: 0.5 } });
    assert.equal(result.alerted, true);
    assert.equal(result.reason, 'relative_threshold_breach');
    assert.equal(result.ratio, 2.0);
});

test('CA-2.4 threshold relativo NO dispara cuando actual está apenas por encima del piso', () => {
    const snapshot = snapshotWith({ hour: 14, baseline: 1.0, actual: 1.4, daysWithData: 7 });
    const result = evaluate({ snapshot, now: nowAt(14), config: { pctThreshold: 0.5 } });
    assert.equal(result.alerted, false);
    assert.equal(result.reason, 'within_threshold');
});

test('CA-2.4 mínimo absoluto: no alerta aunque haya pico relativo si actual ≤ minUsdToAlert', () => {
    // baseline=$0.001, actual=$0.30 → ratio=300x pero $0.30 < $0.50 → no alerta.
    const snapshot = snapshotWith({ hour: 14, baseline: 0.001, actual: 0.30, daysWithData: 7 });
    const result = evaluate({ snapshot, now: nowAt(14), config: { pctThreshold: 0.5, minUsdToAlert: 0.50 } });
    assert.equal(result.alerted, false);
    assert.equal(result.reason, 'below_min_usd');
});

test('CA-2.2 grace period: durante warmup solo dispara con minAbsUsdPerHour', () => {
    // daysWithData=2 < warmupDays=7 → estamos en warmup. Solo importa actual > minAbsUsdPerHour.
    const lowSnapshot = snapshotWith({ hour: 14, baseline: 0.0, actual: 1.5, daysWithData: 2 });
    const lowResult = evaluate({ snapshot: lowSnapshot, now: nowAt(14), config: { warmupDays: 7, minAbsUsdPerHour: 2.0 } });
    assert.equal(lowResult.alerted, false, 'actual=$1.50 < minAbsUsdPerHour=$2 durante warmup → no alerta');
    assert.equal(lowResult.reason, 'warmup_within_absolute');
    assert.equal(lowResult.warmup, true);

    const highSnapshot = snapshotWith({ hour: 14, baseline: 0.0, actual: 5.0, daysWithData: 2 });
    const highResult = evaluate({ snapshot: highSnapshot, now: nowAt(14), config: { warmupDays: 7, minAbsUsdPerHour: 2.0 } });
    assert.equal(highResult.alerted, true, 'actual=$5 > minAbsUsdPerHour=$2 durante warmup → alerta');
    assert.equal(highResult.reason, 'warmup_absolute_breach');
});

test('CA-2.2 fuera de warmup: el threshold absoluto NO se aplica solo, manda el relativo', () => {
    // daysWithData=10 ≥ warmupDays=7 → NO warmup. Aunque actual > minAbsUsdPerHour,
    // si baseline también es alto (gasto típico de esa hora), no se alerta.
    const snapshot = snapshotWith({ hour: 14, baseline: 5.0, actual: 5.5, daysWithData: 10 });
    const result = evaluate({ snapshot, now: nowAt(14), config: { warmupDays: 7, minAbsUsdPerHour: 2.0, pctThreshold: 0.5 } });
    assert.equal(result.alerted, false, 'fuera de warmup: ratio=1.1 está dentro del +50%');
    assert.equal(result.reason, 'within_threshold');
});

test('evaluate maneja baseline=0 con actual>0 como ratio Infinity', () => {
    const snapshot = snapshotWith({ hour: 3, baseline: 0, actual: 1.5, daysWithData: 7 });
    const result = evaluate({ snapshot, now: nowAt(3), config: { pctThreshold: 0.5, minUsdToAlert: 0.50 } });
    assert.equal(result.alerted, true, 'actual > 0.50 piso y baseline=0 → relative_threshold_breach');
    assert.equal(result.reason, 'relative_threshold_breach');
    assert.equal(result.ratio, null, 'ratio Infinity se serializa como null');
});

test('evaluate sin snapshot devuelve record con baseline=0 y reason coherente', () => {
    const result = evaluate({ snapshot: null, now: nowAt(14), config: {} });
    assert.equal(result.baseline_usd, 0);
    assert.equal(result.actual_usd, 0);
    // sin snapshot.hourlyMeta → daysWithData=0 → en warmup → actual=0 < minAbsUsdPerHour → no alerta
    assert.equal(result.alerted, false);
    assert.equal(result.warmup, true);
});

test('CA-2.5 persistEvaluation escribe shape canónico al archivo histórico', () => {
    const tmpFile = path.join(TMP_DIR, 'history-test.jsonl');
    const record = evaluate({
        snapshot: snapshotWith({ hour: 10, baseline: 1.0, actual: 2.5, daysWithData: 7 }),
        now: nowAt(10),
        config: { pctThreshold: 0.5 },
    });
    persistEvaluation(record, tmpFile);
    const lines = fs.readFileSync(tmpFile, 'utf8').split('\n').filter(Boolean);
    assert.equal(lines.length, 1);
    const parsed = JSON.parse(lines[0]);
    // Shape exacta del contrato CA-2.5 + type discriminator.
    assert.deepEqual(Object.keys(parsed).sort(), ['actual_usd', 'alerted', 'baseline_usd', 'hour', 'ratio', 'ts', 'type']);
    assert.equal(parsed.type, 'anomaly');
    assert.equal(parsed.hour, '10');
    assert.equal(parsed.alerted, true);
    assert.equal(parsed.baseline_usd, 1.0);
    assert.equal(parsed.actual_usd, 2.5);
    // Ningún campo "warmup" o "reason" — esos son internos, NO contrato persistente.
    assert.equal(parsed.warmup, undefined);
    assert.equal(parsed.reason, undefined);
});

test('persistEvaluation NO escribe paths absolutos ni secretos en el record', () => {
    const tmpFile = path.join(TMP_DIR, 'history-safety.jsonl');
    const record = evaluate({
        snapshot: snapshotWith({ hour: 14, baseline: 1.0, actual: 2.0, daysWithData: 7 }),
        now: nowAt(14),
        config: {},
    });
    persistEvaluation(record, tmpFile);
    const content = fs.readFileSync(tmpFile, 'utf8');
    assert.ok(!content.includes(TMP_DIR), 'el record persistido NO incluye paths absolutos');
    assert.ok(!content.includes('Workspaces'), 'no debe filtrar paths del repo');
});

test('AnomalyDetector.runOnce lee snapshot y emite eventos', () => {
    // Setup: escribir snapshot sintético con pico
    const snapshotFile = path.join(TMP_DIR, '.pipeline', 'metrics', 'snapshot-test.json');
    fs.writeFileSync(snapshotFile, JSON.stringify(snapshotWith({ hour: 14, baseline: 1.0, actual: 3.0, daysWithData: 7 })));
    const historyFile = path.join(TMP_DIR, '.pipeline', 'metrics', 'history-test.jsonl');
    try { fs.unlinkSync(historyFile); } catch (e) {}

    const detector = new AnomalyDetector({
        snapshotPath: snapshotFile,
        historyPath: historyFile,
        config: { pctThreshold: 0.5 },
    });
    const evaluations = [];
    const anomalies = [];
    detector.on('evaluation', (e) => evaluations.push(e));
    detector.on('anomaly', (e) => anomalies.push(e));

    const result = detector.runOnce(nowAt(14));
    assert.equal(result.alerted, true);
    assert.equal(evaluations.length, 1, 'siempre emite evaluation');
    assert.equal(anomalies.length, 1, 'también emite anomaly cuando alerted=true');
    assert.ok(fs.existsSync(historyFile), 'persiste al historyFile');
});

test('AnomalyDetector.runOnce con consumo bajo NO emite anomaly', () => {
    const snapshotFile = path.join(TMP_DIR, '.pipeline', 'metrics', 'snapshot-low.json');
    fs.writeFileSync(snapshotFile, JSON.stringify(snapshotWith({ hour: 14, baseline: 1.0, actual: 1.1, daysWithData: 7 })));
    const historyFile = path.join(TMP_DIR, '.pipeline', 'metrics', 'history-low.jsonl');
    try { fs.unlinkSync(historyFile); } catch (e) {}

    const detector = new AnomalyDetector({
        snapshotPath: snapshotFile,
        historyPath: historyFile,
        config: { pctThreshold: 0.5 },
    });
    const anomalies = [];
    detector.on('anomaly', (e) => anomalies.push(e));
    const result = detector.runOnce(nowAt(14));
    assert.equal(result.alerted, false);
    assert.equal(anomalies.length, 0, 'no emite anomaly cuando está dentro del threshold');
    // Pero SÍ persistió el chequeo (CA-2.5: TODO chequeo se persiste, alertado o no).
    const lines = fs.readFileSync(historyFile, 'utf8').split('\n').filter(Boolean);
    assert.equal(lines.length, 1, 'persiste también las evaluaciones que no alertan');
});

test('AnomalyDetector.runOnce con snapshot ausente no tira y persiste un eval con baseline=0', () => {
    const missingSnapshot = path.join(TMP_DIR, 'no-existe.json');
    const historyFile = path.join(TMP_DIR, '.pipeline', 'metrics', 'history-nosnap.jsonl');
    try { fs.unlinkSync(historyFile); } catch (e) {}

    const detector = new AnomalyDetector({
        snapshotPath: missingSnapshot,
        historyPath: historyFile,
        config: {},
    });
    assert.doesNotThrow(() => detector.runOnce(nowAt(14)));
    assert.ok(fs.existsSync(historyFile));
});

test('CA-2.3 intervalMin default es 10 y se respeta tras validación', () => {
    const detector = new AnomalyDetector({ config: {} });
    assert.equal(detector.config.intervalMin, 10);
    detector.stop();
});

test('CA-2.3 intervalMin fuera de rango cae al default con warning', () => {
    const detector = new AnomalyDetector({ config: { intervalMin: 9999 } });
    assert.equal(detector.config.intervalMin, DEFAULTS.intervalMin);
    assert.ok(detector.warnings.length > 0, 'debe reportar warning de clamp');
    detector.stop();
});
