#!/usr/bin/env node
// =============================================================================
// architect-pilot-metrics.js — Métricas del piloto del rol `architect` (#3644)
// (Historia madre #3615, paraguas #3559, foundation #3613, gate #3614)
// =============================================================================
//
// Computa las 4 métricas requeridas por CA-PO-PILOT-METRICS leyendo
// **exclusivamente** desde fuentes append-only (CA-IMPL-PILOT-METRICS-SOURCE,
// A08 Integrity):
//
//   1. `.pipeline/audit/architect-tokens.jsonl` (writer en `lib/architect-audit.js`).
//   2. `.pipeline/audit/prompt-injection-attempts.jsonl` (lazy creation; ENOENT → 0).
//
// PROHIBIDO leer de:
//   - `.pipeline/logs/*.log`            (no append-only, rotable, tampering ex-post posible).
//   - `pipeline-state-*.json`           (snapshots mutables).
//   - `.pipeline/metrics/snapshot*.json` (agregados mutables).
//
// La policy se enforza con `lib/__tests__/architect-pilot-metrics.test.js`
// (policy-as-test con grep de regex prohibidas sobre el source de este script).
//
// -----------------------------------------------------------------------------
// CLI
// -----------------------------------------------------------------------------
//
//   node .pipeline/scripts/architect-pilot-metrics.js [opts]
//
//   --since=ISO8601               Filtrar tokens desde esa fecha (default: sin filtro).
//   --limit=N                     Limitar piloto a los N issues con label
//                                 `architect:enabled` más recientes (default: 5).
//   --update-rollout-plan         Editar `docs/pipeline/architect-rollout-plan.md`
//                                 reemplazando idempotentemente el bloque entre
//                                 los marcadores `<!-- pilot-metrics:auto -->` y
//                                 `<!-- /pilot-metrics:auto -->`.
//   --pipeline-dir=PATH           Override `.pipeline/` (testing).
//   --rollout-plan-path=PATH      Override path del rollout-plan.md (testing).
//   --no-gh                       No invocar `gh` (testing / pre-piloto).
//                                 Usa la lista vacía de issues piloto → métricas 0.
//   --json-only                   Suprimir el bloque markdown en stdout.
//
// Salida default a stdout:
//   {
//     "computed_at": "...",
//     "since": "...",
//     "limit": N,
//     "pilot_issues": [{ "number": 1234, "createdAt": "...", "closedAt": "..." }, ...],
//     "metrics": {
//       "latency_criterios_to_signoff_min": { "p50": ..., "p95": ..., "n": ... },
//       "rejection_rate_fase2": { "value": 0.xx, "n": ... },
//       "cost_usd_total": ...,
//       "ratio_qa_passed_no_rebote": { "value": 0.xx, "n": ... },
//       "injection_attempts_n": ...
//     },
//     "data_sources": {
//       "latency": "append-only",
//       "rejection_rate_fase2": "append-only",
//       "cost_usd_total": "append-only",
//       "ratio_qa_passed_no_rebote": "gh-api-mutable",
//       "injection_attempts_n": "append-only"
//     },
//     "markdown_block": "<!-- pilot-metrics:auto -->\n..."
//   }
//
// Exit codes:
//   0 — éxito (al menos JSON emitido).
//   2 — `gh` CLI no disponible y `--no-gh` no fue pasado.
//   3 — error de IO sobre el rollout-plan al hacer `--update-rollout-plan`.
//
// =============================================================================
'use strict';

// Las únicas dependencias permitidas son built-in. NO usamos snapshot, logs ni
// metrics agregados — sólo audit/*.jsonl + gh CLI para el cruce de labels.
const fs = require('fs');
const path = require('path');
const child_process = require('child_process');

// -----------------------------------------------------------------------------
// Constantes
// -----------------------------------------------------------------------------

const MARKER_BEGIN = '<!-- pilot-metrics:auto -->';
const MARKER_END = '<!-- /pilot-metrics:auto -->';
const PILOT_LABEL = 'architect:enabled';
const DEFAULT_LIMIT = 5;

// Resolver el repo root como ../../ desde este script (`.pipeline/scripts/`).
const REPO_ROOT_DEFAULT = path.resolve(__dirname, '..', '..');
const PIPELINE_DIR_DEFAULT = path.join(REPO_ROOT_DEFAULT, '.pipeline');
const ROLLOUT_PLAN_DEFAULT = path.join(
    REPO_ROOT_DEFAULT, 'docs', 'pipeline', 'architect-rollout-plan.md'
);

// -----------------------------------------------------------------------------
// CLI parser (sin deps)
// -----------------------------------------------------------------------------

function parseArgs(argv) {
    const out = {
        since: null,
        limit: DEFAULT_LIMIT,
        updateRolloutPlan: false,
        pipelineDir: PIPELINE_DIR_DEFAULT,
        rolloutPlanPath: ROLLOUT_PLAN_DEFAULT,
        useGh: true,
        jsonOnly: false,
    };
    for (const a of argv) {
        if (a === '--update-rollout-plan') out.updateRolloutPlan = true;
        else if (a === '--no-gh') out.useGh = false;
        else if (a === '--json-only') out.jsonOnly = true;
        else if (a.startsWith('--since=')) out.since = a.slice('--since='.length);
        else if (a.startsWith('--limit=')) out.limit = Math.max(1, parseInt(a.slice('--limit='.length), 10) || DEFAULT_LIMIT);
        else if (a.startsWith('--pipeline-dir=')) out.pipelineDir = a.slice('--pipeline-dir='.length);
        else if (a.startsWith('--rollout-plan-path=')) out.rolloutPlanPath = a.slice('--rollout-plan-path='.length);
    }
    return out;
}

// -----------------------------------------------------------------------------
// JSONL reader append-only (tolera ENOENT → [], lanza si línea está corrupta)
// -----------------------------------------------------------------------------

function readJsonlSafe(filePath) {
    if (!fs.existsSync(filePath)) return [];
    const raw = fs.readFileSync(filePath, 'utf8');
    return raw
        .split('\n')
        .filter(line => line.trim().length > 0)
        .map(line => JSON.parse(line));
}

// -----------------------------------------------------------------------------
// gh subprocess (consulta de labels — el único cruce no append-only, marcado
// como `gh-api-mutable` en el output JSON)
// -----------------------------------------------------------------------------

function fetchPilotIssuesViaGh(limit) {
    let result;
    try {
        result = child_process.spawnSync(
            'gh',
            [
                'issue', 'list',
                '--label', PILOT_LABEL,
                '--state', 'all',
                '--limit', String(limit),
                '--json', 'number,createdAt,closedAt,labels',
            ],
            { encoding: 'utf8' }
        );
    } catch (err) {
        // ENOENT del spawn (gh no en PATH).
        const msg = `gh CLI no disponible — pre-checklist: export PATH=/c/Workspaces/gh-cli/bin:$PATH (err: ${err.message})`;
        const e = new Error(msg);
        e.code = 'GH_UNAVAILABLE';
        throw e;
    }
    if (result.error && result.error.code === 'ENOENT') {
        const msg = `gh CLI no disponible — pre-checklist: export PATH=/c/Workspaces/gh-cli/bin:$PATH`;
        const e = new Error(msg);
        e.code = 'GH_UNAVAILABLE';
        throw e;
    }
    if (result.status !== 0) {
        const e = new Error(`gh issue list falló (exit=${result.status}): ${result.stderr || result.stdout}`);
        e.code = 'GH_FAILED';
        throw e;
    }
    try {
        return JSON.parse(result.stdout);
    } catch (err) {
        throw new Error(`gh devolvió JSON inválido: ${err.message}`);
    }
}

// -----------------------------------------------------------------------------
// Métricas
// -----------------------------------------------------------------------------

/**
 * Percentil simple (P50 = mediana, P95 ≈ percentil 95 con interpolación lineal).
 * Devuelve `null` si el array está vacío.
 */
function percentile(sortedValues, p) {
    if (sortedValues.length === 0) return null;
    if (sortedValues.length === 1) return sortedValues[0];
    const idx = (sortedValues.length - 1) * p;
    const lo = Math.floor(idx);
    const hi = Math.ceil(idx);
    if (lo === hi) return sortedValues[lo];
    const frac = idx - lo;
    return sortedValues[lo] + (sortedValues[hi] - sortedValues[lo]) * frac;
}

/**
 * Devuelve minutos entre dos timestamps ISO8601. NaN si alguno es inválido.
 */
function minutesBetween(fromIso, toIso) {
    const from = Date.parse(fromIso);
    const to = Date.parse(toIso);
    if (!Number.isFinite(from) || !Number.isFinite(to)) return NaN;
    return (to - from) / 60000;
}

/**
 * Calcula las 4 métricas requeridas por CA-PO-PILOT-METRICS sobre el set de
 * issues piloto (subset con label `architect:enabled`).
 *
 * @param {Array} tokens          Records de architect-tokens.jsonl.
 * @param {Array} injections      Records de prompt-injection-attempts.jsonl.
 * @param {Array} pilotIssues     Lista de issues con label architect:enabled
 *                                (devuelta por gh; vacía si --no-gh).
 * @returns {object} metrics
 */
function computeMetrics(tokens, injections, pilotIssues) {
    const pilotIds = new Set(pilotIssues.map(i => Number(i.number)));
    const issueIndex = new Map(pilotIssues.map(i => [Number(i.number), i]));

    const pilotTokens = tokens.filter(t => pilotIds.has(Number(t.issue_id)));

    // 1. Latencia criterios → signoff (P50 / P95).
    //
    //    Para cada record con phase="criterios" y decision="signoff", calcular
    //    minutos transcurridos entre createdAt del issue y timestamp del signoff.
    //    Si no se conoce createdAt (issue no está en la lista del piloto, o
    //    --no-gh), el record se ignora para latencia.
    const latencies = [];
    for (const rec of pilotTokens) {
        if (rec.phase !== 'criterios' || rec.decision !== 'signoff') continue;
        const issue = issueIndex.get(Number(rec.issue_id));
        if (!issue || !issue.createdAt || !rec.timestamp) continue;
        const mins = minutesBetween(issue.createdAt, rec.timestamp);
        if (Number.isFinite(mins) && mins >= 0) latencies.push(mins);
    }
    latencies.sort((a, b) => a - b);
    const latencyP50 = percentile(latencies, 0.50);
    const latencyP95 = percentile(latencies, 0.95);

    // 2. Tasa de rechazo en Fase 2 (rebotes / total Fase 2).
    //
    //    Fase 2 = phase="aprobacion". Numerador: decision="rebote". Denominador:
    //    cualquier decisión registrada en aprobacion.
    const fase2Total = pilotTokens.filter(t => t.phase === 'aprobacion').length;
    const fase2Rebotes = pilotTokens.filter(
        t => t.phase === 'aprobacion' && t.decision === 'rebote'
    ).length;
    const rejectionRate = fase2Total > 0 ? (fase2Rebotes / fase2Total) : null;

    // 3. Costo USD agregado del piloto (suma sobre todos los tokens del piloto,
    //    todas las fases). El cost_usd ya incluye el modelo aplicable + cache.
    const costUsdTotal = pilotTokens.reduce(
        (acc, t) => acc + (Number.isFinite(t.cost_usd) ? t.cost_usd : 0),
        0
    );

    // 4. Ratio qa:passed sin rebote architect.
    //
    //    Numerador: issues piloto con label `qa:passed` Y sin rebote architect
    //    (sin record en architect-tokens con phase="aprobacion" y decision="rebote").
    //    Denominador: total issues piloto.
    //
    //    NOTA: esta métrica cruza con labels de gh (mutable). Marcada como
    //    `gh-api-mutable` en `data_sources` — informativa, no decisoria para el
    //    go/no-go integrity-critical (CA-PO-PILOT-DECISION-TRACEABLE).
    const issuesConRebote = new Set(
        pilotTokens
            .filter(t => t.phase === 'aprobacion' && t.decision === 'rebote')
            .map(t => Number(t.issue_id))
    );
    let qaPassedSinRebote = 0;
    for (const issue of pilotIssues) {
        const labels = Array.isArray(issue.labels) ? issue.labels : [];
        const hasQaPassed = labels.some(l => l && l.name === 'qa:passed');
        const tieneRebote = issuesConRebote.has(Number(issue.number));
        if (hasQaPassed && !tieneRebote) qaPassedSinRebote += 1;
    }
    const ratioQaPassed = pilotIssues.length > 0
        ? (qaPassedSinRebote / pilotIssues.length)
        : null;

    return {
        latency_criterios_to_signoff_min: {
            p50: latencyP50,
            p95: latencyP95,
            n: latencies.length,
        },
        rejection_rate_fase2: {
            value: rejectionRate,
            n: fase2Total,
            rebotes: fase2Rebotes,
        },
        cost_usd_total: Math.round(costUsdTotal * 100) / 100,
        ratio_qa_passed_no_rebote: {
            value: ratioQaPassed,
            n: pilotIssues.length,
            qa_passed_count: qaPassedSinRebote,
        },
        injection_attempts_n: injections.length,
    };
}

// -----------------------------------------------------------------------------
// Renderizado del bloque markdown idempotente
// -----------------------------------------------------------------------------

function fmtNum(v, digits = 2) {
    if (v == null || !Number.isFinite(v)) return 'n/d';
    return v.toFixed(digits);
}

function fmtPct(v, digits = 1) {
    if (v == null || !Number.isFinite(v)) return 'n/d';
    return `${(v * 100).toFixed(digits)}%`;
}

function renderMarkdownBlock(payload) {
    const m = payload.metrics;
    const lat = m.latency_criterios_to_signoff_min;
    const rej = m.rejection_rate_fase2;
    const qa = m.ratio_qa_passed_no_rebote;

    // Tabla limitada a ASCII estable + valores crudos para trazabilidad
    // (CA-PO-PILOT-DECISION-TRACEABLE).
    const lines = [];
    lines.push(MARKER_BEGIN);
    lines.push('');
    lines.push('### Métricas del piloto (datos reales, auto-generadas)');
    lines.push('');
    lines.push(`_Generado: ${payload.computed_at}_`);
    lines.push(`_Issues piloto considerados: ${payload.pilot_issues.length} (label \`${PILOT_LABEL}\`, limit=${payload.limit})_`);
    if (payload.since) lines.push(`_Ventana desde: ${payload.since}_`);
    lines.push('');
    lines.push('| Métrica | Valor | n | Umbral | Fuente |');
    lines.push('|---|---|---|---|---|');
    lines.push(`| Latencia P50 criterios→signoff (min) | ${fmtNum(lat.p50, 1)} | ${lat.n} | informativo | append-only |`);
    lines.push(`| Latencia P95 criterios→signoff (min) | ${fmtNum(lat.p95, 1)} | ${lat.n} | informativo (n<10 indicativo) | append-only |`);
    lines.push(`| Tasa rechazo Fase 2 | ${fmtPct(rej.value)} | ${rej.n} | < 30% | append-only |`);
    lines.push(`| Costo USD agregado piloto | $${fmtNum(m.cost_usd_total, 2)} | ${lat.n + rej.n} entries | ±30% vs $29/día×piloto | append-only |`);
    lines.push(`| Ratio qa:passed sin rebote architect | ${fmtPct(qa.value)} | ${qa.n} | informativo | gh-api-mutable |`);
    lines.push(`| Intentos prompt-injection registrados | ${m.injection_attempts_n} | — | informativo | append-only |`);
    lines.push('');
    lines.push('**Issues considerados:** ' + (payload.pilot_issues.length === 0
        ? '_(ninguno — el piloto aún no se ejecutó o no hay issues con el label)_'
        : payload.pilot_issues.map(i => `#${i.number}`).join(', ')));
    lines.push('');
    lines.push('> **Nota sobre integridad (A08):** los valores marcados como `append-only` provienen exclusivamente de `.pipeline/audit/architect-tokens.jsonl` y `.pipeline/audit/prompt-injection-attempts.jsonl`. El valor marcado como `gh-api-mutable` cruza con labels GitHub (informativo, no decisorio para el go/no-go).');
    lines.push('');
    lines.push('> **Nota estadística:** con `n<10` los percentiles son indicativos, no robustos. Re-evaluar tras 4 semanas post-go-live total con `n>30` (alineado con el spike #3526).');
    lines.push('');
    lines.push(MARKER_END);
    return lines.join('\n');
}

// -----------------------------------------------------------------------------
// Inyección idempotente en el rollout-plan.md
// -----------------------------------------------------------------------------

function injectBlockIntoRolloutPlan(filePath, block) {
    let content;
    try {
        content = fs.readFileSync(filePath, 'utf8');
    } catch (err) {
        const e = new Error(`No se pudo leer rollout-plan en "${filePath}": ${err.message}`);
        e.code = 'ROLLOUT_PLAN_READ';
        throw e;
    }

    const beginIdx = content.indexOf(MARKER_BEGIN);
    const endIdx = content.indexOf(MARKER_END);

    let updated;
    if (beginIdx === -1 || endIdx === -1 || endIdx <= beginIdx) {
        // No hay marker → agregar al final como sección nueva (defensa: si los
        // marcadores no existen, el bloque queda añadido y el siguiente run lo
        // reemplaza in-place).
        const sep = content.endsWith('\n') ? '\n' : '\n\n';
        updated = content + sep + block + '\n';
    } else {
        const before = content.slice(0, beginIdx);
        const after = content.slice(endIdx + MARKER_END.length);
        updated = before + block + after;
    }

    if (updated === content) return { changed: false, path: filePath };

    fs.writeFileSync(filePath, updated, 'utf8');
    return { changed: true, path: filePath };
}

// -----------------------------------------------------------------------------
// Pipeline principal (re-usable desde tests)
// -----------------------------------------------------------------------------

/**
 * Ejecuta el cómputo completo de métricas con opciones.
 *
 * @param {object} opts
 * @param {string} opts.pipelineDir
 * @param {string|null} opts.since
 * @param {number} opts.limit
 * @param {boolean} opts.useGh
 * @returns {{ payload: object, markdown: string }}
 */
function runMetrics(opts) {
    const auditDir = path.join(opts.pipelineDir, 'audit');
    const tokensPath = path.join(auditDir, 'architect-tokens.jsonl');
    const injectionsPath = path.join(auditDir, 'prompt-injection-attempts.jsonl');

    let tokens = readJsonlSafe(tokensPath);
    const injections = readJsonlSafe(injectionsPath);

    // Filtro por --since.
    if (opts.since) {
        const sinceTs = Date.parse(opts.since);
        if (Number.isFinite(sinceTs)) {
            tokens = tokens.filter(t => Date.parse(t.timestamp) >= sinceTs);
        }
    }

    let pilotIssues = [];
    if (opts.useGh) {
        pilotIssues = fetchPilotIssuesViaGh(opts.limit);
    }

    const metrics = computeMetrics(tokens, injections, pilotIssues);

    const payload = {
        computed_at: new Date().toISOString(),
        since: opts.since || null,
        limit: opts.limit,
        pilot_issues: pilotIssues.map(i => ({
            number: i.number,
            createdAt: i.createdAt || null,
            closedAt: i.closedAt || null,
        })),
        metrics: metrics,
        data_sources: {
            latency: 'append-only',
            rejection_rate_fase2: 'append-only',
            cost_usd_total: 'append-only',
            ratio_qa_passed_no_rebote: 'gh-api-mutable',
            injection_attempts_n: 'append-only',
        },
    };

    const markdown = renderMarkdownBlock(payload);
    payload.markdown_block = markdown;

    return { payload, markdown };
}

// -----------------------------------------------------------------------------
// Entry point CLI
// -----------------------------------------------------------------------------

function main() {
    const args = parseArgs(process.argv.slice(2));

    let result;
    try {
        result = runMetrics(args);
    } catch (err) {
        if (err.code === 'GH_UNAVAILABLE' || err.code === 'GH_FAILED') {
            process.stderr.write(`[architect-pilot-metrics] ${err.message}\n`);
            process.exit(2);
        }
        throw err;
    }

    if (args.updateRolloutPlan) {
        try {
            const r = injectBlockIntoRolloutPlan(args.rolloutPlanPath, result.markdown);
            process.stderr.write(
                `[architect-pilot-metrics] ${r.changed ? 'actualizado' : 'sin cambios'}: ${r.path}\n`
            );
        } catch (err) {
            process.stderr.write(`[architect-pilot-metrics] ${err.message}\n`);
            process.exit(3);
        }
    }

    // Stdout: JSON canónico (incluye el bloque markdown como string para
    // pipeable a `jq -r .markdown_block`).
    const out = args.jsonOnly
        ? { ...result.payload, markdown_block: undefined }
        : result.payload;
    process.stdout.write(JSON.stringify(out, null, 2) + '\n');
}

// -----------------------------------------------------------------------------
// Exports (tests) — el módulo es CLI cuando se ejecuta directo.
// -----------------------------------------------------------------------------

module.exports = {
    parseArgs,
    readJsonlSafe,
    computeMetrics,
    renderMarkdownBlock,
    injectBlockIntoRolloutPlan,
    runMetrics,
    percentile,
    minutesBetween,
    MARKER_BEGIN,
    MARKER_END,
    PILOT_LABEL,
};

if (require.main === module) {
    main();
}
