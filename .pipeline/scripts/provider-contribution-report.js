#!/usr/bin/env node
// =============================================================================
// provider-contribution-report.js — Reporte de aporte real por proveedor (#6145)
// =============================================================================
//
// CLI READ-ONLY sobre el pipeline. Responde la pregunta del operador
// "¿que proveedores me estan costando mas de lo que aportan?" con la tabla de
// CA-1, la separacion de costo de CA-2 y el veredicto de permanencia de CA-6.
//
// LO QUE ESTE SCRIPT **NO** HACE (CA-7, REQ-SEC-3):
//   - No modifica `config.yaml` ni `agent-models.json`.
//   - No modifica `.pipeline/state/multi-provider-health.json`.
//   - No escribe en `.pipeline/logs/cross-provider-dispatch-*.jsonl`.
//   - No desactiva, reordena ni da de baja ningun proveedor.
//
// La UNICA escritura posible es OPT-IN (`--registrar`) y va a un audit
// append-only con hash-chain (`.pipeline/audit/provider-permanence.jsonl`) via
// `lib/audit-log.appendChained`. Nunca `writeFileSync` sobre ese path.
//
// FUENTE: `.pipeline/logs/cross-provider-dispatch-*.jsonl` (hash-chain).
// PROHIBIDO `.claude/activity-log.jsonl` — ver cabecera del modulo y el test
// de policy `el modulo no lee activity-log.jsonl`.
//
// -----------------------------------------------------------------------------
// USO
// -----------------------------------------------------------------------------
//
//   node .pipeline/scripts/provider-contribution-report.js [opts]
//
//   --dias=N              Ventana en dias (default 30, minimo exigido por CA-1).
//   --hasta=YYYY-MM-DD    Fin de la ventana (default: ahora).
//   --compacto            Tabla de 4 columnas (terminales angostas, CA-UX).
//   --json                Emitir SOLO el JSON canonico (sin texto para humanos).
//   --registrar           Registrar la decision en el audit append-only (CA-8).
//   --pipeline-dir=PATH   Override de `.pipeline/` (tests).
//   --umbral-muestra=N    Override de `min_sample`.
//   --umbral-tasa=F       Override de `min_contribution_rate` (0..1).
//   --umbral-dias=N       Override de `max_days_without_win`.
//
// Exit codes:
//   0 — reporte emitido.
//   1 — error de IO irrecuperable.
//   2 — ventana sin archivos verificables (todo `no evaluable`; no se decide).
//
// =============================================================================
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const contribution = require('../lib/multi-provider/provider-contribution');
const auditLog = require('../lib/audit-log');

const AUDIT_FILE = 'provider-permanence.jsonl';

// -----------------------------------------------------------------------------
// parseArgs
// -----------------------------------------------------------------------------

function parseArgs(argv) {
    const out = {
        dias: contribution.DEFAULT_WINDOW_DAYS,
        hasta: null,
        compacto: false,
        json: false,
        registrar: false,
        pipelineDir: path.resolve(__dirname, '..'),
        overrides: {},
    };
    for (const raw of argv || []) {
        const [k, v] = raw.includes('=') ? [raw.slice(0, raw.indexOf('=')), raw.slice(raw.indexOf('=') + 1)] : [raw, null];
        switch (k) {
            case '--dias': {
                const n = Number(v);
                if (Number.isFinite(n) && n > 0) out.dias = Math.floor(n);
                break;
            }
            case '--hasta': out.hasta = v; break;
            case '--compacto': out.compacto = true; break;
            case '--json': out.json = true; break;
            case '--registrar': out.registrar = true; break;
            case '--pipeline-dir': if (v) out.pipelineDir = v; break;
            case '--umbral-muestra': {
                const n = Number(v);
                if (Number.isFinite(n) && n >= 0) out.overrides.min_sample = Math.floor(n);
                break;
            }
            case '--umbral-tasa': {
                const n = Number(v);
                if (Number.isFinite(n) && n >= 0 && n <= 1) out.overrides.min_contribution_rate = n;
                break;
            }
            case '--umbral-dias': {
                const n = Number(v);
                if (Number.isFinite(n) && n >= 0) out.overrides.max_days_without_win = Math.floor(n);
                break;
            }
            default: break;
        }
    }
    return out;
}

// -----------------------------------------------------------------------------
// Lecturas auxiliares (best-effort, nunca tiran)
// -----------------------------------------------------------------------------

/** Umbrales de `multi_provider.permanence` en config.yaml. Sin YAML parser
 *  disponible el CLI cae a los defaults del modulo, que ya son conservadores. */
function readThresholds(pipelineDir, fsImpl) {
    const _fs = fsImpl || fs;
    const base = { ...contribution.DEFAULT_THRESHOLDS };
    const cfgPath = path.join(pipelineDir, 'config.yaml');
    try {
        if (!_fs.existsSync(cfgPath)) return base;
        // Parser dedicado y acotado: solo la subseccion `permanence:` dentro de
        // `multi_provider:`. Evita cargar js-yaml (el CLI debe poder correr aun
        // con el pipeline detenido) y evita ejecutar tags YAML arbitrarios.
        const text = _fs.readFileSync(cfgPath, 'utf8');
        const mp = /^multi_provider:\s*$/m.exec(text);
        if (!mp) return base;
        const rest = text.slice(mp.index);
        const perm = /^ {2}permanence:\s*$/m.exec(rest);
        if (!perm) return base;
        const block = rest.slice(perm.index + perm[0].length);
        const lines = block.split('\n');
        for (const line of lines) {
            if (/^\s*$/.test(line) || /^\s*#/.test(line)) continue;
            const m = /^ {4}([a-z_]+):\s*([^#\s]+)/.exec(line);
            if (!m) break;                            // fin de la subseccion
            const [, key, rawVal] = m;
            if (rawVal === 'true' || rawVal === 'false') base[key] = rawVal === 'true';
            else if (Number.isFinite(Number(rawVal))) base[key] = Number(rawVal);
        }
    } catch { /* fail-safe: defaults */ }
    return base;
}

/**
 * Proveedores declarados. Un proveedor esta plenamente declarado cuando
 * aparece en DOS lugares:
 *
 *   1. `agent-models.json` — de donde sale `billing` (paid/free).
 *   2. `config.yaml` — donde vive su calibracion operativa (TTL de cuota,
 *      umbrales de alerta). Sin esto el criterio lo evaluaria contra umbrales
 *      inexistentes.
 *
 * `kimi-moonshot` es el caso real: participa del dispatch y esta en
 * `agent-models.json`, pero **no** en `config.yaml` (#6153). Por eso su
 * veredicto es `sin_declarar` y nunca `candidato_baja`.
 */
function readDeclaredProviders(pipelineDir, fsImpl) {
    const _fs = fsImpl || fs;
    const out = Object.create(null);
    const inConfig = readProvidersDeclaredInConfig(pipelineDir, _fs);
    const file = path.join(pipelineDir, 'agent-models.json');
    try {
        if (!_fs.existsSync(file)) return out;
        const parsed = JSON.parse(_fs.readFileSync(file, 'utf8'));
        for (const [name, def] of Object.entries((parsed && parsed.providers) || {})) {
            // `deterministic` no es un proveedor de la cadena LLM: es el
            // ejecutor local sin modelo. No participa del criterio.
            if (name === 'deterministic') continue;
            out[name] = {
                billing: def && def.billing ? def.billing : null,
                model: def && def.model,
                declaredInConfig: inConfig.size === 0 ? true : inConfig.has(name),
            };
        }
    } catch { /* fail-safe */ }
    return out;
}

/**
 * Nombres de proveedor nombrados en `config.yaml`. Barrido textual acotado a
 * los bloques por-proveedor conocidos (`ttl_by_provider`, `quota_alert`) —
 * suficiente para distinguir "calibrado" de "ausente" sin cargar un parser YAML.
 * Ante cualquier problema devuelve un set vacio, que el caller interpreta como
 * "no se pudo determinar" y NO degrada a `sin_declarar` (fail-safe).
 */
function readProvidersDeclaredInConfig(pipelineDir, fsImpl) {
    const _fs = fsImpl || fs;
    const found = new Set();
    const cfgPath = path.join(pipelineDir, 'config.yaml');
    try {
        if (!_fs.existsSync(cfgPath)) return found;
        const text = _fs.readFileSync(cfgPath, 'utf8');
        for (const blockKey of ['ttl_by_provider', 'quota_alert']) {
            const re = new RegExp(`^(\\s*)${blockKey}:\\s*$`, 'm');
            const m = re.exec(text);
            if (!m) continue;
            const indent = m[1].length;
            const lines = text.slice(m.index + m[0].length).split('\n');
            for (const line of lines) {
                if (/^\s*$/.test(line) || /^\s*#/.test(line)) continue;
                const item = /^(\s*)([A-Za-z0-9_-]+):/.exec(line);
                if (!item || item[1].length <= indent) break;   // fin del bloque
                found.add(item[2]);
            }
        }
    } catch { /* fail-safe: set vacio */ }
    return found;
}

function readHealthSnapshot(pipelineDir, fsImpl) {
    const _fs = fsImpl || fs;
    const file = path.join(pipelineDir, 'state', 'multi-provider-health.json');
    try {
        if (!_fs.existsSync(file)) return null;
        const parsed = JSON.parse(_fs.readFileSync(file, 'utf8'));
        return parsed && Array.isArray(parsed.providers) ? parsed : null;
    } catch {
        return null;
    }
}

// -----------------------------------------------------------------------------
// buildReport — nucleo puro
// -----------------------------------------------------------------------------

function buildReport(opts) {
    const _fs = opts.fsImpl || fs;
    const now = Number.isFinite(opts.now) ? opts.now : Date.now();
    const to = opts.hasta ? Date.parse(`${opts.hasta}T23:59:59.999Z`) : now;
    const toMs = Number.isFinite(to) ? to : now;
    const from = toMs - opts.dias * contribution.MS_PER_DAY;

    const { entries, integrity } = contribution.readWindow({
        pipelineDir: opts.pipelineDir,
        from,
        to: toMs,
        fsImpl: _fs,
        auditLog: opts.auditLog || auditLog,
    });

    const healthSnapshot = readHealthSnapshot(opts.pipelineDir, _fs);
    const declared = opts.declared || readDeclaredProviders(opts.pipelineDir, _fs);
    const thresholds = { ...readThresholds(opts.pipelineDir, _fs), ...(opts.overrides || {}) };

    const metrics = contribution.computeContribution(entries, { now, healthSnapshot });
    const verdicts = contribution.evaluatePermanence(metrics, thresholds, {
        chainOk: integrity.chainOk,
        declared,
        now,
    });
    const failoverCost = contribution.computeFailoverCost(entries);

    return {
        computedAt: new Date(now).toISOString(),
        window: {
            days: opts.dias,
            from: new Date(from).toISOString(),
            to: new Date(toMs).toISOString(),
        },
        source: '.pipeline/logs/cross-provider-dispatch-*.jsonl',
        integrity,
        thresholds,
        metrics,
        verdicts,
        failoverCost,
        table: contribution.renderMarkdownTable(metrics, { verdicts, compact: opts.compacto }),
        conclusion: buildConclusion({ verdicts, integrity, failoverCost, window: { from, to: toMs } }),
    };
}

/**
 * CA-10 + CA-UX-3 — la conclusion PRECEDE a la evidencia y esta en lenguaje
 * llano. Si nadie sale de la cadena, esa frase aparece literal y primera.
 */
function buildConclusion(ctx) {
    const { verdicts, integrity, failoverCost } = ctx;
    const V = contribution.VERDICT;
    const all = Object.values(verdicts);
    const by = (v) => all.filter((x) => x.verdict === v).map((x) => x.provider).sort();

    const candidatos = by(V.CANDIDATO_BAJA);
    const acotados = by(V.ROL_ACOTADO);
    const mantener = by(V.MANTENER);
    const noEval = by(V.NO_EVALUABLE);
    const sinDeclarar = by(V.SIN_DECLARAR);

    const lines = [];
    lines.push(
        candidatos.length === 0
            ? 'No se propone dar de baja a ningún proveedor en esta ventana.'
            : `Se proponen como candidatos a baja: ${candidatos.join(', ')}.`,
    );
    if (mantener.length) lines.push(`Se mantienen sin cambios: ${mantener.join(', ')}.`);
    if (acotados.length) {
        lines.push(
            `Quedan con rol acotado (aportan poco por una causa propia, no del proveedor): ${acotados.join(', ')}.`,
        );
    }
    if (noEval.length) {
        lines.push(`Sin muestra suficiente para decidir (no evaluable, nunca "no aporta"): ${noEval.join(', ')}.`);
    }
    if (sinDeclarar.length) {
        lines.push(`Despachan pero no están declarados en configuración (#6153): ${sinDeclarar.join(', ')}.`);
    }
    if (failoverCost && failoverCost.scheduleGating && failoverCost.scheduleGating.pct !== null) {
        lines.push(
            `El ${String(failoverCost.scheduleGating.pct).replace('.', ',')} % del gating de la ventana es `
            + 'política horaria, no proveedores muertos: ese costo no es imputable a los gratuitos.',
        );
    }
    if (!integrity.chainOk) {
        lines.push(
            'ATENCIÓN: la cadena de hash de la ventana no verificó '
            + `(${integrity.brokenFiles.length} archivo/s con integridad rota). `
            + 'Por eso ningún proveedor es evaluable y no se decide nada.',
        );
    }
    return lines;
}

// -----------------------------------------------------------------------------
// Render para humanos (CA-UX-3/4/6)
// -----------------------------------------------------------------------------

const RULE = '═'.repeat(76);

function renderHuman(report, argvLine) {
    const out = [];
    out.push(RULE);
    out.push(' APORTE REAL POR PROVEEDOR — ventana '
        + `${report.window.from.slice(0, 10)} → ${report.window.to.slice(0, 10)} (${report.window.days} días)`);
    out.push(` Fuente: ${report.source}  ·  hash-chain: ${report.integrity.chainOk ? 'OK' : 'ROTA'}`
        + ` (${report.integrity.filesChecked} archivo/s)`);
    // CA-UX-6 — el comando exacto que regenera el reporte, copiable tal cual.
    out.push(` Regenerar: ${argvLine}`);
    out.push(RULE);
    out.push('');
    out.push(' CONCLUSIÓN');
    report.conclusion.forEach((l, i) => out.push(` ${i + 1}. ${l}`));
    out.push('');
    out.push(report.table);
    out.push('');
    out.push(' COSTO DE FAILOVER POR CAUSA (CA-2) — el total NO es culpa de los gratuitos');
    const fc = report.failoverCost;
    const bucket = (label, b) => `   ${label.padEnd(26, '.')} ${String(b.events).padStart(7)} eventos`
        + ` (${b.pct === null ? contribution.ABSENCE.SIN_MUESTRA : String(b.pct).replace('.', ',')} %)`;
    out.push(bucket('política horaria ', fc.scheduleGating));
    out.push(bucket('bloqueo por proveedor ', fc.providerBlocking));
    out.push(bucket('dispatch resuelto ', fc.wins));
    out.push(bucket('cadena agotada ', fc.chainExhausted));
    out.push('');
    out.push(' MOTIVO DEL VEREDICTO POR PROVEEDOR');
    for (const v of Object.values(report.verdicts).sort((a, b) => (a.provider < b.provider ? -1 : 1))) {
        out.push(`   ${v.provider}: ${v.verdictLabel}`);
        for (const r of v.reasons) out.push(`     · ${r}`);
    }
    out.push('');
    out.push(` Umbrales aplicados: min_sample=${report.thresholds.min_sample}`
        + ` · min_contribution_rate=${report.thresholds.min_contribution_rate}`
        + ` · max_days_without_win=${report.thresholds.max_days_without_win}`
        + ` · enabled=${report.thresholds.enabled}`);
    out.push(' Este reporte MARCA candidatos; no da de baja a nadie. La baja es un PR de configuración.');
    return out.join('\n');
}

// -----------------------------------------------------------------------------
// Audit append-only (CA-8)
// -----------------------------------------------------------------------------

function registrarDecision(report, opts) {
    const _fs = opts.fsImpl || fs;
    const _auditLog = opts.auditLog || auditLog;
    const file = path.join(opts.pipelineDir, 'audit', AUDIT_FILE);
    try {
        _fs.mkdirSync(path.dirname(file), { recursive: true });
    } catch { /* best-effort */ }

    // SOLO metadatos y veredictos (REQ-SEC-1): nada de texto de prompts.
    const entry = {
        event: 'provider_permanence_evaluated',
        issue: '6145',
        window_from: report.window.from,
        window_to: report.window.to,
        window_days: report.window.days,
        source: report.source,
        chain_ok: report.integrity.chainOk,
        files_checked: report.integrity.filesChecked,
        broken_files: report.integrity.brokenFiles,
        thresholds: report.thresholds,
        verdicts: Object.fromEntries(
            Object.values(report.verdicts).map((v) => [v.provider, {
                verdict: v.verdict,
                declared: v.declared,
                billing: v.billing,
                evidence: v.evidence,
            }]),
        ),
        executed_action: 'none',   // CA-6/REQ-SEC-3: marca, no ejecuta.
    };
    // Append-only con hash-chain. NUNCA `writeFileSync` sobre este path.
    return _auditLog.appendChained({ file, entry, fsImpl: _fs });
}

// -----------------------------------------------------------------------------
// main
// -----------------------------------------------------------------------------

function main(argv) {
    const args = parseArgs(argv || process.argv.slice(2));
    let report;
    try {
        report = buildReport(args);
    } catch (err) {
        process.stderr.write(`[provider-contribution-report] ${err.message}\n`);
        return 1;
    }

    if (args.registrar) {
        try {
            registrarDecision(report, args);
        } catch (err) {
            process.stderr.write(`[provider-contribution-report] audit: ${err.message}\n`);
        }
    }

    if (args.json) {
        process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    } else {
        const cmd = `node .pipeline/scripts/provider-contribution-report.js --dias=${args.dias}`;
        process.stdout.write(`${renderHuman(report, cmd)}\n`);
    }

    return report.integrity.chainOk ? 0 : 2;
}

module.exports = {
    parseArgs,
    readThresholds,
    readDeclaredProviders,
    readHealthSnapshot,
    buildReport,
    buildConclusion,
    renderHuman,
    registrarDecision,
    main,
    AUDIT_FILE,
};

if (require.main === module) {
    process.exitCode = main();
}
