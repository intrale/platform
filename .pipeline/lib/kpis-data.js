// =============================================================================
// kpis-data.js — Slice de datos de la ventana KPIs / endpoint /metrics.
//
// Issue: #3733 (split de #3715 — extracción ventana KPIs del monolito
// dashboard.js + reincorporación del link a /metrics).
//
// Diseño (decisión cerrada #1 del issue): este módulo es DATA-ONLY y testeable
// en aislamiento. Porta `getMetricsData()` (que vivía inline en dashboard.js)
// a `getMetricsSlice(ctx)` con inyección de dependencias por `ctx` — sin
// closures sobre globals de dashboard.js (mitiga R4). NO toca el `kpisSlice`
// de lib/dashboard-slices.js (DORA + tokens24h + bouncePct); ambos slices
// coexisten y la vista los compone.
//
// Contrato del retorno (idéntico al getMetricsData() histórico, NO cambia):
//   { snapshots, etaAverages, entregas, tokenEstimates,
//     totalProcessed, totalRejected, agentPerf }
//
// Seguridad: los session IDs SIEMPRE se truncan a 8 chars antes de salir del
// slice (CA-17, paridad con dashboard.js:7489 histórico). El render aplica
// además `safeSessionId` (defense in depth).
//
// R7 — Performance: `getMetricsData()` lee `metrics-history.jsonl` + escanea
// `desarrollo/*/procesado` por todos los issues. Para no recomputar en cada
// poll del cliente, cacheamos 30s con invalidación por `mtime` del JSONL. El
// header `Cache-Control: no-store` del endpoint NO contradice este cache: son
// capas distintas (server-side memo vs caché de intermediarios HTTP).
// =============================================================================
'use strict';

const fs = require('node:fs');
const path = require('node:path');

// Cache opcional 30s con invalidación por mtime del JSONL — mitiga R7.
const CACHE_TTL_MS = 30 * 1000;
let _cache = { at: 0, mtime: 0, value: null };

// Para tests: permite resetear el cache entre casos.
function _resetCache() {
    _cache = { at: 0, mtime: 0, value: null };
}

/**
 * Construye el slice de métricas históricas para la ventana KPIs y el
 * endpoint /metrics. Equivalente funcional 1:1 del histórico
 * `dashboard.js::getMetricsData()`, con dependencias inyectadas por `ctx`.
 *
 * @param {object} ctx
 * @param {string}   ctx.PIPELINE                 — path absoluto a `.pipeline`.
 * @param {function} ctx.getPipelineState         — () => state (usa state.etaAverages).
 * @param {function} ctx.loadConfig               — () => config (config.pipelines).
 * @param {function} ctx.listWorkFiles            — (dir) => string[] de archivos de trabajo.
 * @param {function} ctx.fileStat                 — (file) => {ctimeMs, birthtimeMs, ...} | null.
 * @param {function} ctx.readYamlSafe             — (file) => objeto YAML parseado.
 * @param {function} ctx.inferHistoricalActivity  — () => snapshots inferidos.
 * @param {object}   [ctx._fs]                    — inyección de fs para tests (default node:fs).
 * @returns {{snapshots:Array, etaAverages:object, entregas:Array,
 *            tokenEstimates:object, totalProcessed:number, totalRejected:number,
 *            agentPerf:object}}
 */
function getMetricsSlice(ctx) {
    if (!ctx || !ctx.PIPELINE) {
        // Fallback inerte: nunca tirar desde acá (el caller en dashboard.js ya
        // tiene su propio fallback, pero defendemos por las dudas).
        return _emptySlice();
    }

    const _fs = ctx._fs || fs;
    const PIPELINE = ctx.PIPELINE;
    const metricsFile = path.join(PIPELINE, 'metrics-history.jsonl');

    // --- Cache lookup (R7) -------------------------------------------------
    let mtime = 0;
    try { mtime = _fs.statSync(metricsFile).mtimeMs; } catch { /* archivo ausente */ }
    const now = Date.now();
    if (_cache.value && (now - _cache.at) < CACHE_TTL_MS && _cache.mtime === mtime) {
        return _cache.value;
    }

    const {
        getPipelineState,
        loadConfig,
        listWorkFiles,
        fileStat,
        readYamlSafe,
        inferHistoricalActivity,
    } = ctx;

    // --- Snapshots del Pulpo (pulse) --------------------------------------
    let snapshots = [];
    try {
        const lines = _fs.readFileSync(metricsFile, 'utf8').split('\n').filter(Boolean);
        for (const l of lines) {
            try { snapshots.push(JSON.parse(l)); } catch { /* línea corrupta */ }
        }
    } catch { /* archivo ausente */ }

    // El archivo mezcla dos shapes: pulse del Pulpo ({ts,cpu,mem,agents,level})
    // y anomaly del detector (#2891). El dashboard solo consume pulse.
    snapshots = snapshots.filter(s => typeof s.cpu === 'number' && typeof s.mem === 'number' && typeof s.ts === 'number');

    // Si no hay snapshots reales, inferir actividad histórica desde archivos.
    if (snapshots.length < 10 && typeof inferHistoricalActivity === 'function') {
        const inferred = inferHistoricalActivity();
        if (Array.isArray(inferred) && inferred.length > snapshots.length) snapshots = inferred;
    }

    // --- Promedios de duración por fase/skill (reusa ETA) -----------------
    const state = typeof getPipelineState === 'function' ? getPipelineState() : {};
    const etaAverages = (state && state.etaAverages) || {};

    // --- Throughput: entregas procesadas ---------------------------------
    const entregas = [];
    try {
        const dir = path.join(PIPELINE, 'desarrollo', 'entrega', 'procesado');
        for (const f of listWorkFiles(dir)) {
            const st = fileStat(path.join(dir, f));
            if (st) entregas.push({ issue: f.split('.')[0], ts: st.ctimeMs });
        }
    } catch { /* dir ausente */ }
    entregas.sort((a, b) => a.ts - b.ts);

    // --- Cuota Anthropic estimada (del activity log) ----------------------
    const tokenEstimates = { totalSessions: 0, totalTools: 0, totalEstimatedTokens: 0, bySession: [] };
    try {
        const archiveFile = path.join(path.dirname(PIPELINE), '.claude', 'activity-log.archive.jsonl');
        const lines = _fs.readFileSync(archiveFile, 'utf8').split('\n').filter(Boolean);
        const sessions = {};
        for (const l of lines) {
            try {
                const d = JSON.parse(l);
                if (!d.session) continue;
                if (!sessions[d.session]) sessions[d.session] = { tools: 0, firstTs: d.ts, lastTs: d.ts };
                sessions[d.session].tools++;
                sessions[d.session].lastTs = d.ts;
            } catch { /* línea corrupta */ }
        }
        for (const [id, s] of Object.entries(sessions)) {
            const durSeg = typeof s.firstTs === 'string' && typeof s.lastTs === 'string'
                ? (new Date(s.lastTs) - new Date(s.firstTs)) / 1000
                : typeof s.firstTs === 'number' ? (s.lastTs - s.firstTs) / 1000 : 0;
            const estimated = Math.round((durSeg * 15) + (s.tools * 500));
            tokenEstimates.totalSessions++;
            tokenEstimates.totalTools += s.tools;
            tokenEstimates.totalEstimatedTokens += estimated;
            // CA-17 — session ID truncado a 8 chars (paridad histórica).
            tokenEstimates.bySession.push({ id: String(id).slice(0, 8), tools: s.tools, durMin: Math.round(durSeg / 60), tokens: estimated });
        }
    } catch { /* archivo ausente */ }

    // --- Tasa de rebotes + agent performance ------------------------------
    let totalProcessed = 0, totalRejected = 0;
    const config = typeof loadConfig === 'function' ? loadConfig() : { pipelines: {} };
    const allFases = [];
    for (const [pName, pConfig] of Object.entries((config && config.pipelines) || {})) {
        for (const fase of (pConfig.fases || [])) allFases.push({ pipeline: pName, fase });
    }
    const agentPerf = {};
    for (const { pipeline: pName, fase } of allFases) {
        for (const estado of ['procesado', 'listo']) {
            const dir = path.join(PIPELINE, pName, fase, estado);
            for (const f of listWorkFiles(dir)) {
                totalProcessed++;
                const data = readYamlSafe(path.join(dir, f));
                if (data && data.resultado === 'rechazado') totalRejected++;

                const skill = f.split('.').slice(1).join('.');
                if (!skill) continue;
                if (!agentPerf[skill]) agentPerf[skill] = { issues: 0, rejected: 0, totalDurMs: 0, durCount: 0, toolCalls: 0 };
                agentPerf[skill].issues++;
                if (data && data.resultado === 'rechazado') agentPerf[skill].rejected++;
                const st = fileStat(path.join(dir, f));
                if (st) {
                    const dur = st.ctimeMs - st.birthtimeMs;
                    if (dur > 5000 && dur < 4 * 3600000) {
                        agentPerf[skill].totalDurMs += dur;
                        agentPerf[skill].durCount++;
                    }
                }
            }
        }
    }

    // Enriquecer con tool calls del activity log.
    try {
        const archiveFile = path.join(path.dirname(PIPELINE), '.claude', 'activity-log.archive.jsonl');
        const lines = _fs.readFileSync(archiveFile, 'utf8').split('\n').filter(Boolean);
        const sessionSkill = {};
        for (const l of lines) {
            try {
                const d = JSON.parse(l);
                if (d.session && d.skill) sessionSkill[d.session] = d.skill;
                if (d.session && d.tool) {
                    const sk = sessionSkill[d.session] || d.session;
                    if (agentPerf[sk]) agentPerf[sk].toolCalls++;
                }
            } catch { /* línea corrupta */ }
        }
    } catch { /* archivo ausente */ }

    const result = { snapshots, etaAverages, entregas, tokenEstimates, totalProcessed, totalRejected, agentPerf };
    _cache = { at: now, mtime, value: result };
    return result;
}

function _emptySlice() {
    return {
        snapshots: [],
        etaAverages: {},
        entregas: [],
        tokenEstimates: { totalSessions: 0, totalTools: 0, totalEstimatedTokens: 0, bySession: [] },
        totalProcessed: 0,
        totalRejected: 0,
        agentPerf: {},
    };
}

module.exports = { getMetricsSlice, _emptySlice, _resetCache };
