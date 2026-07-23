'use strict';

// =============================================================================
// matrix-history.js — Serie temporal del `matrixCounts` (skill × fase) de la
// Matriz. EP8-H6 (#3959, épica #3952) — CA-2 (tendencia ▲▼ por celda vs 24h).
// -----------------------------------------------------------------------------
// Clon directo de `reconciler-history.js` (mismo patrón `recordSnapshot` /
// `readSeries` debounceado a ~1/hora). Persiste un snapshot horario del conteo
// por celda en `.pipeline/matrix-history.jsonl`:
//
//   { ts, total, counts: { 'desarrollo/dev': { 'backend-dev': 3, ... }, ... } }
//
// El append está DEBOUNCEADO (~1 snapshot/hora por default): el handler del
// endpoint `/api/dash/pipeline` lo alimenta en cada refresh del dashboard sin
// inflar el archivo. La flecha de tendencia de cada celda compara el conteo
// actual contra `baselineCounts()` (≈valor de 24 h atrás).
//
// Seguridad (alineado con el análisis de `security`/`guru`):
//   - Persiste UN ÚNICO archivo (`matrix-history.jsonl`). Las keys de
//     fase/skill van como CONTENIDO JSON, nunca como nombre de archivo → no hay
//     path traversal por keys controladas externamente.
//   - `_normalizeCounts` acota las keys (longitud, sin saltos de línea) y los
//     valores (enteros finitos ≥0) — igual que `_normalizeBreakdown` del clon.
//   - Sin `eval`/`Function` sobre el contenido del snapshot.
//
// Sin bind de paths a tiempo de carga: `opts.pipelineDir`, `opts.now` y
// `opts.minIntervalMs` hacen el comportamiento determinístico en tests.
// =============================================================================

const fs = require('node:fs');
const path = require('node:path');

const STORE_NAME = 'matrix-history.jsonl';
const DEFAULT_WINDOW_MS = 7 * 24 * 3600 * 1000;   // 7 días
const DEFAULT_MIN_INTERVAL_MS = 3600 * 1000;       // 1 snapshot/hora
const DEFAULT_TARGET_AGE_MS = 24 * 3600 * 1000;    // tendencia vs 24h
const DEFAULT_TOLERANCE_MS = 6 * 3600 * 1000;      // ventana ±6h alrededor de 24h
const MAX_LINES = 20000;
const MAX_KEY_LEN = 60;

function resolvePipelineDir(opts) {
    if (opts && opts.pipelineDir) return opts.pipelineDir;
    // __dirname = .pipeline/lib → padre = .pipeline
    return path.resolve(__dirname, '..');
}

function storePath(opts) {
    return path.join(resolvePipelineDir(opts), STORE_NAME);
}

function _sanitizeKey(k) {
    return String(k).replace(/[\r\n\t]+/g, ' ').slice(0, MAX_KEY_LEN);
}

// Sanitiza el conteo anidado: `{ faseKey: { skill: n } }`. Keys string
// acotadas, valores numéricos finitos ≥0. Celdas vacías (sin valores válidos)
// se descartan para no inflar el snapshot.
function _normalizeCounts(counts) {
    const out = {};
    if (!counts || typeof counts !== 'object') return out;
    for (const [faseKey, bySkill] of Object.entries(counts)) {
        if (!bySkill || typeof bySkill !== 'object') continue;
        const cell = {};
        for (const [skill, v] of Object.entries(bySkill)) {
            const n = Number(v);
            if (Number.isFinite(n) && n > 0) cell[_sanitizeKey(skill)] = Math.floor(n);
        }
        if (Object.keys(cell).length) out[_sanitizeKey(faseKey)] = cell;
    }
    return out;
}

function _sumCounts(counts) {
    let total = 0;
    for (const bySkill of Object.values(counts)) {
        for (const n of Object.values(bySkill)) total += n;
    }
    return total;
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

/**
 * Registra un snapshot del `matrixCounts` SI pasó `minIntervalMs` desde el
 * último (debounce). No bloquea ni tira si el FS falla.
 *
 * @param {object} matrixCounts — `{ faseKey: { skill: n } }`.
 * @param {object} [opts] — { pipelineDir, now, minIntervalMs }.
 * @returns {object|null} el snapshot persistido, o null si se debounceó/falló.
 */
function recordSnapshot(matrixCounts, opts) {
    const o = opts || {};
    const now = typeof o.now === 'number' ? o.now : Date.now();
    const minInterval = typeof o.minIntervalMs === 'number' ? o.minIntervalMs : DEFAULT_MIN_INTERVAL_MS;

    const last = _lastEntry(o);
    if (last && last.ts) {
        const lastTs = Date.parse(last.ts);
        if (Number.isFinite(lastTs) && (now - lastTs) < minInterval) return null; // debounce
    }

    const counts = _normalizeCounts(matrixCounts);
    const total = _sumCounts(counts);

    const record = { ts: new Date(now).toISOString(), total, counts };
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
 * @returns {{ points: Array<{ts,total,counts}>, totals:number[], windowDays:number }}
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
        points.push({ ts: ev.ts, total: Number(ev.total) || 0, counts: ev.counts || {} });
    }
    points.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
    return {
        points,
        totals: points.map(p => p.total),
        windowDays: Math.round(windowMs / (24 * 3600 * 1000)),
    };
}

/**
 * Devuelve el `counts` del snapshot más cercano a `now - targetAgeMs` (≈24 h por
 * default), siempre que caiga dentro de `±toleranceMs`. Es la base contra la que
 * la Matriz dibuja la flecha ▲▼ por celda. Si no hay ningún snapshot dentro de
 * la ventana, devuelve `null` (la UI degrada sin flecha — CA-2).
 *
 * @param {object} [opts] — { pipelineDir, now, targetAgeMs, toleranceMs }.
 * @returns {object|null} `{ faseKey: { skill: n } }` de ≈24h atrás, o null.
 */
function baselineCounts(opts) {
    const o = opts || {};
    const now = typeof o.now === 'number' ? o.now : Date.now();
    const targetAgeMs = typeof o.targetAgeMs === 'number' ? o.targetAgeMs : DEFAULT_TARGET_AGE_MS;
    const toleranceMs = typeof o.toleranceMs === 'number' ? o.toleranceMs : DEFAULT_TOLERANCE_MS;
    const target = now - targetAgeMs;

    // Leer una ventana suficiente para cubrir el punto objetivo + tolerancia.
    const series = readSeries({ ...o, now, windowMs: targetAgeMs + toleranceMs + 1000 });
    let best = null;
    let bestDist = Infinity;
    for (const p of series.points) {
        const t = Date.parse(p.ts);
        if (!Number.isFinite(t)) continue;
        const dist = Math.abs(t - target);
        if (dist <= toleranceMs && dist < bestDist) {
            bestDist = dist;
            best = p;
        }
    }
    return best ? best.counts : null;
}

module.exports = {
    recordSnapshot,
    readSeries,
    baselineCounts,
    storePath,
    DEFAULT_WINDOW_MS,
    DEFAULT_MIN_INTERVAL_MS,
    DEFAULT_TARGET_AGE_MS,
    DEFAULT_TOLERANCE_MS,
};
