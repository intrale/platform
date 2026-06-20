'use strict';

// =============================================================================
// reconciler-history.js — Serie temporal del breakdown stale-orders del
// reconciler. EP8-H7 (#3960, épica #3952) — CA-4.
// -----------------------------------------------------------------------------
// Persiste un snapshot periódico del breakdown por motivo en
// `.pipeline/reconciler-history.jsonl` (patrón `metrics-history.jsonl`):
//
//   { ts, total, byReason: { duplicado: 91, timeout: 41, ... } }
//
// El append está DEBOUNCEADO (~1 snapshot/hora por default): el hook que lo
// alimenta puede llamarse en cada refresh del dashboard sin inflar el archivo.
// El sparkline de 7 d en `ops.js` lee de acá vía `readSeries()`.
//
// Sin bind de paths a tiempo de carga: `opts.pipelineDir`, `opts.now` y
// `opts.minIntervalMs` hacen el comportamiento determinístico en tests.
// =============================================================================

const fs = require('node:fs');
const path = require('node:path');

const STORE_NAME = 'reconciler-history.jsonl';
const DEFAULT_WINDOW_MS = 7 * 24 * 3600 * 1000;   // 7 días
const DEFAULT_MIN_INTERVAL_MS = 3600 * 1000;       // 1 snapshot/hora
const MAX_LINES = 20000;

function resolvePipelineDir(opts) {
    if (opts && opts.pipelineDir) return opts.pipelineDir;
    // __dirname = .pipeline/lib → padre = .pipeline
    return path.resolve(__dirname, '..');
}

function storePath(opts) {
    return path.join(resolvePipelineDir(opts), STORE_NAME);
}

function _lastEntry(opts) {
    const file = storePath(opts);
    let raw;
    try { raw = fs.readFileSync(file, 'utf8'); }
    catch { return null; }
    const lines = raw.split(/\r?\n/).filter(Boolean);
    if (!lines.length) return null;
    try { return JSON.parse(lines[lines.length - 1]); }
    catch { return null; }
}

// Sanitiza el breakdown: claves string acotadas, valores numéricos finitos ≥0.
function _normalizeBreakdown(byReason) {
    const out = {};
    if (!byReason || typeof byReason !== 'object') return out;
    for (const [k, v] of Object.entries(byReason)) {
        const key = String(k).replace(/[\r\n\t]+/g, ' ').slice(0, 60);
        const n = Number(v);
        if (Number.isFinite(n) && n >= 0) out[key] = Math.floor(n);
    }
    return out;
}

/**
 * Registra un snapshot del breakdown stale-orders SI pasó `minIntervalMs` desde
 * el último (debounce). No bloquea ni tira si el FS falla.
 *
 * @param {{ total:number, by_reason?:object, byReason?:object }} breakdown
 * @param {object} [opts] — { pipelineDir, now, minIntervalMs }.
 * @returns {object|null} el snapshot persistido, o null si se debounceó.
 */
function recordSnapshot(breakdown, opts) {
    const o = opts || {};
    const now = typeof o.now === 'number' ? o.now : Date.now();
    const minInterval = typeof o.minIntervalMs === 'number' ? o.minIntervalMs : DEFAULT_MIN_INTERVAL_MS;

    const last = _lastEntry(o);
    if (last && last.ts) {
        const lastTs = Date.parse(last.ts);
        if (Number.isFinite(lastTs) && (now - lastTs) < minInterval) return null; // debounce
    }

    const b = breakdown || {};
    const byReason = _normalizeBreakdown(b.byReason || b.by_reason);
    let total = Number(b.total);
    if (!Number.isFinite(total) || total < 0) {
        total = Object.values(byReason).reduce((a, n) => a + n, 0);
    } else {
        total = Math.floor(total);
    }

    const record = { ts: new Date(now).toISOString(), total, byReason };
    const file = storePath(o);
    try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.appendFileSync(file, JSON.stringify(record) + '\n', 'utf8');
    } catch { return null; }
    return record;
}

/**
 * Lee la serie temporal en una ventana (default 7 d), ordenada por ts asc.
 *
 * @param {object} [opts] — { pipelineDir, now, windowMs }.
 * @returns {{ points: Array<{ts,total,byReason}>, totals:number[], windowDays:number }}
 */
function readSeries(opts) {
    const o = opts || {};
    const now = typeof o.now === 'number' ? o.now : Date.now();
    const windowMs = typeof o.windowMs === 'number' ? o.windowMs : DEFAULT_WINDOW_MS;
    const cutoff = now - windowMs;

    const file = storePath(o);
    let raw;
    try { raw = fs.readFileSync(file, 'utf8'); }
    catch { return { points: [], totals: [], windowDays: Math.round(windowMs / (24 * 3600 * 1000)) }; }

    const lines = raw.split(/\r?\n/).filter(Boolean).slice(-MAX_LINES);
    const points = [];
    for (const line of lines) {
        let ev;
        try { ev = JSON.parse(line); } catch { continue; }
        const t = ev && ev.ts ? Date.parse(ev.ts) : NaN;
        if (!Number.isFinite(t) || t < cutoff) continue;
        points.push({ ts: ev.ts, total: Number(ev.total) || 0, byReason: ev.byReason || {} });
    }
    points.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
    return {
        points,
        totals: points.map(p => p.total),
        windowDays: Math.round(windowMs / (24 * 3600 * 1000)),
    };
}

module.exports = {
    recordSnapshot,
    readSeries,
    storePath,
    DEFAULT_WINDOW_MS,
    DEFAULT_MIN_INTERVAL_MS,
};
