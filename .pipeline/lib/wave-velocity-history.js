'use strict';

// =============================================================================
// wave-velocity-history.js — #4532 — Serie histórica de velocidad CROSS-OLA.
//
// La velocidad de la ola se define como "% de avance por issue por minuto"
// (`velocityPctPerMin`): la pendiente de `avancePct` sobre el tiempo, donde
// `avancePct` YA está normalizado por issue (es (cerrados·100 + Σ%activos)/N).
// Este módulo persiste esas muestras ENTRE olas para que una ola nueva —sin
// snapshots propios todavía— arranque con una ESTIMACIÓN PREVIA (promedio
// histórico cross-ola) en vez de mostrar "—" hasta juntar puntos (issue #4532,
// punto 5). El ETA de una ola nueva se puede derivar de esa estimación desde el
// primer tick.
//
// Store: `.pipeline/wave-velocity-history.jsonl` (gitignored — efímero por
// máquina, se regenera). Shape por línea: `{ ts, waveKey, velocityPctPerMin }`
// — SÓLO primitivos numéricos (nunca strings libres/metadata de issues).
//
// Reglas inquebrantables:
//   - Sólo se registran muestras POSITIVAS y finitas. Rebotes / `/wave add`
//     producen pendiente ≤ 0 (el avancePct baja al crecer el denominador); esas
//     NO se registran, así el histórico jamás se contamina con velocidades
//     negativas (issue #4532 — "robusta a rebotes, sin velocidades negativas").
//   - `getHistoricalVelocity()` promedia las últimas K muestras (cross-ola), o
//     devuelve null si no hay ninguna.
//   - Append-only con cota dura + retención temporal. Best-effort: NUNCA tira ni
//     rompe al caller (el pipeline no puede morir por telemetría).
//   - Cero deps npm — sólo `fs` y `path` del core.
// =============================================================================

const fs = require('fs');
const path = require('path');

// Retención: 90 días de historia de velocidad (cross-ola, cambia lento).
const RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
// Cota dura de líneas para acotar el archivo (una ola aporta ~pocas muestras).
const MAX_LINES = 2000;
// Pruning oportunista cada N appends (amortiza el costo de reescritura).
const PRUNE_EVERY_N = 50;
// Ventana de muestras para el promedio histórico (últimas K positivas).
const HISTORICAL_WINDOW = 20;

let _appendCounter = 0;

function pipelineRoot(pipelineRootArg) {
    if (pipelineRootArg) return pipelineRootArg;
    if (process.env.PIPELINE_ROOT_OVERRIDE) return process.env.PIPELINE_ROOT_OVERRIDE;
    if (process.env.PIPELINE_DIR_OVERRIDE) return process.env.PIPELINE_DIR_OVERRIDE;
    return path.join(__dirname, '..');
}

function storePath(pipelineRootArg) {
    return path.join(pipelineRoot(pipelineRootArg), 'wave-velocity-history.jsonl');
}

function isValidWaveKey(k) {
    return Number.isInteger(k) && k > 0;
}

function isPositiveFinite(n) {
    return typeof n === 'number' && Number.isFinite(n) && n > 0;
}

function isFiniteNumber(n) {
    return typeof n === 'number' && Number.isFinite(n);
}

/**
 * Registra una muestra de velocidad. Sólo persiste muestras positivas y finitas
 * (una pendiente ≤ 0 por rebote / `/wave add` se descarta silenciosamente para
 * no contaminar el histórico). Devuelve `true` si registró, `false` si descartó
 * o falló (nunca tira).
 *
 * @param {{pipelineRoot?:string, waveKey:number, velocityPctPerMin:number, now?:number}} args
 * @returns {boolean}
 */
function recordSample({ pipelineRoot: pipelineRootArg, waveKey, velocityPctPerMin, now } = {}) {
    if (!isValidWaveKey(waveKey)) return false;
    if (!isPositiveFinite(velocityPctPerMin)) return false; // robusto a rebotes
    const ts = isFiniteNumber(now) ? now : Date.now();

    const rec = { ts, waveKey, velocityPctPerMin };
    const file = storePath(pipelineRootArg);
    try {
        fs.appendFileSync(file, JSON.stringify(rec) + '\n');
    } catch {
        return false;
    }
    _appendCounter++;
    if (_appendCounter >= PRUNE_EVERY_N) {
        _appendCounter = 0;
        try { pruneStore({ pipelineRoot: pipelineRootArg, now: ts }); } catch { /* no-op */ }
    }
    return true;
}

/**
 * Lee todas las muestras válidas (tolerante a líneas corruptas), ordenadas por
 * `ts` ascendente. Filtra opcionalmente por `waveKey`.
 *
 * @param {{pipelineRoot?:string, waveKey?:number}} args
 * @returns {Array<{ts:number, waveKey:number, velocityPctPerMin:number}>}
 */
function readSamples({ pipelineRoot: pipelineRootArg, waveKey } = {}) {
    const file = storePath(pipelineRootArg);
    let raw;
    try { raw = fs.readFileSync(file, 'utf8'); }
    catch { return []; }

    const filterKey = isValidWaveKey(waveKey) ? waveKey : null;
    const out = [];
    for (const line of raw.split('\n')) {
        if (!line) continue;
        let rec;
        try { rec = JSON.parse(line); } catch { continue; }
        if (!rec || typeof rec !== 'object') continue;
        if (!isValidWaveKey(rec.waveKey)) continue;
        if (!isFiniteNumber(rec.ts) || !isPositiveFinite(rec.velocityPctPerMin)) continue;
        if (filterKey !== null && rec.waveKey !== filterKey) continue;
        out.push({ ts: rec.ts, waveKey: rec.waveKey, velocityPctPerMin: rec.velocityPctPerMin });
    }
    out.sort((a, b) => a.ts - b.ts);
    return out;
}

/**
 * Estimación histórica de velocidad (cross-ola): promedio de las últimas
 * `HISTORICAL_WINDOW` muestras positivas. Una ola nueva la usa como punto de
 * partida para velocidad/ETA antes de tener snapshots propios.
 *
 * @param {{pipelineRoot?:string, excludeWaveKey?:number, sampleWindow?:number}} args
 * @returns {number|null} velocidad en %/issue/min, o null si no hay muestras.
 */
function getHistoricalVelocity({ pipelineRoot: pipelineRootArg, excludeWaveKey, sampleWindow } = {}) {
    let samples = readSamples({ pipelineRoot: pipelineRootArg });
    if (isValidWaveKey(excludeWaveKey)) {
        samples = samples.filter((s) => s.waveKey !== excludeWaveKey);
    }
    if (samples.length === 0) return null;
    const window = Number.isInteger(sampleWindow) && sampleWindow > 0 ? sampleWindow : HISTORICAL_WINDOW;
    const recent = samples.slice(-window);
    const sum = recent.reduce((acc, s) => acc + s.velocityPctPerMin, 0);
    const avg = sum / recent.length;
    return Number.isFinite(avg) && avg > 0 ? avg : null;
}

/**
 * Reescribe el store descartando muestras más viejas que `RETENTION_MS` y
 * aplicando la cota dura `MAX_LINES` (conserva las más recientes). Idempotente,
 * best-effort: nunca tira. Devuelve counts agregados (sin contenido raw).
 *
 * @param {{pipelineRoot?:string, now?:number}} args
 * @returns {{kept:number, dropped:number}}
 */
function pruneStore({ pipelineRoot: pipelineRootArg, now } = {}) {
    const ts = isFiniteNumber(now) ? now : Date.now();
    const file = storePath(pipelineRootArg);
    let raw;
    try { raw = fs.readFileSync(file, 'utf8'); }
    catch { return { kept: 0, dropped: 0 }; }

    const lines = raw.split('\n').filter(Boolean);
    let kept = [];
    for (const line of lines) {
        let rec;
        try { rec = JSON.parse(line); } catch { continue; }
        if (!rec || typeof rec !== 'object') continue;
        if (!isValidWaveKey(rec.waveKey)) continue;
        if (!isFiniteNumber(rec.ts) || !isPositiveFinite(rec.velocityPctPerMin)) continue;
        if ((ts - rec.ts) > RETENTION_MS) continue; // fuera de retención
        kept.push(rec);
    }
    const droppedByRetention = lines.length - kept.length;
    // Cota dura: quedarse con las más recientes.
    kept.sort((a, b) => a.ts - b.ts);
    let droppedByCap = 0;
    if (kept.length > MAX_LINES) {
        droppedByCap = kept.length - MAX_LINES;
        kept = kept.slice(kept.length - MAX_LINES);
    }
    try {
        const body = kept.map((r) => JSON.stringify({ ts: r.ts, waveKey: r.waveKey, velocityPctPerMin: r.velocityPctPerMin })).join('\n');
        fs.writeFileSync(file, kept.length ? body + '\n' : '');
    } catch { /* best-effort */ }
    return { kept: kept.length, dropped: droppedByRetention + droppedByCap };
}

module.exports = {
    recordSample,
    readSamples,
    getHistoricalVelocity,
    pruneStore,
    RETENTION_MS,
    MAX_LINES,
    PRUNE_EVERY_N,
    HISTORICAL_WINDOW,
    _internal: {
        storePath,
        pipelineRoot,
        isValidWaveKey,
        isPositiveFinite,
        _resetCounter: () => { _appendCounter = 0; },
    },
};
