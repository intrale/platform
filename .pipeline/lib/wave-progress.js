// =============================================================================
// wave-progress.js — Serie temporal de avance de ola (#4039).
//
// Único módulo autorizado a ESCRIBIR sobre `.pipeline/wave-progress.jsonl`.
// Vive separado de `eta-wave.js` justamente para no romper el contrato
// read-only de ese módulo (guru#2 / SEC-1 / CA-7): `eta-wave.js` solo LEE esta
// serie; acá se hace el `appendFileSync` + pruning (writes).
//
// Cada línea del store es un registro JSONL con SOLO primitivos validados:
//   { ts:number, waveKey:number(entero), avancePct:number(finito) }
//
// Contratos de seguridad (SEC-2..SEC-5 / CA-10..CA-13):
//   - SEC-2: cada línea se escribe con `JSON.stringify(obj) + '\n'` sobre el
//     objeto completo (escapa `\n` embebidos). NUNCA por concatenación de
//     strings. No se persisten strings libres (nombre/goal de ola).
//   - SEC-3: `waveKey` validado como entero; el path del store es FIJO,
//     nunca interpolado con input → sin path traversal.
//   - SEC-4: pruning por waveKey cerrado + antigüedad → cota de crecimiento.
//   - SEC-5: sin paths absolutos, hostnames ni usernames en el store ni en
//     logs; logs solo agregados (counts).
//   - SEC-6: lectura tolerante a línea corrupta (descartar, no crashea).
// =============================================================================

'use strict';

const fs = require('fs');
const path = require('path');

// ─── Constantes ────────────────────────────────────────────────────────────

// Retención de líneas de olas NO activas. Las líneas de la ola activa nunca se
// podan (se necesitan para medir el ritmo); las de olas viejas se descartan
// pasada esta ventana. Las olas duran horas, 7 días es holgura amplia.
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

// Cota dura de líneas del store (defensa DoS / SEC-4). Si el archivo la supera,
// el pruning recorta dejando las más recientes.
const MAX_LINES = 5000;

// Cada cuántos appends corremos el pruning oportunista. El archivo es chico
// (una línea por refresh, ~30s) así que reescribirlo cada N appends es barato.
const PRUNE_EVERY_N = 50;

let _appendCounter = 0;

// ─── Paths (con override por env para tests) ───────────────────────────────

function pipelineRoot(pipelineRootArg) {
    if (pipelineRootArg) return pipelineRootArg;
    if (process.env.PIPELINE_ROOT_OVERRIDE) return process.env.PIPELINE_ROOT_OVERRIDE;
    // .pipeline/lib/wave-progress.js → root = ../..
    return path.join(__dirname, '..', '..');
}

function pipelineDir(pipelineRootArg) { return path.join(pipelineRoot(pipelineRootArg), '.pipeline'); }

// Path FIJO (SEC-3 / CA-11): jamás se interpola input en el nombre.
function storePath(pipelineRootArg) { return path.join(pipelineDir(pipelineRootArg), 'wave-progress.jsonl'); }

// ─── Validación de inputs ──────────────────────────────────────────────────

function isValidWaveKey(k) {
    return typeof k === 'number' && Number.isInteger(k) && k > 0;
}

function isFiniteNumber(n) {
    return typeof n === 'number' && Number.isFinite(n);
}

// ─── appendSnapshot (CA-3 / CA-10 / CA-11 / CA-14) ─────────────────────────

/**
 * Agrega un punto a la serie temporal de avance de la ola.
 *
 * Valida estrictamente los inputs: `waveKey` debe ser entero positivo y
 * `avancePct` un número finito. Cualquier input inválido → no escribe y
 * devuelve `false` (CA-11/CA-14), nunca lanza.
 *
 * La línea se serializa con `JSON.stringify` del objeto completo + `\n`
 * (CA-10/SEC-2). `appendFileSync` de una línea completa es atómico, lo que
 * permite múltiples writers (loop de dashboard + handler de `/wave`) sin
 * corromper líneas.
 *
 * @param {{pipelineRoot?:string, waveKey:number, avancePct:number, now?:number}} args
 * @returns {boolean} true si escribió
 */
function appendSnapshot({ pipelineRoot: pipelineRootArg, waveKey, avancePct, now } = {}) {
    if (!isValidWaveKey(waveKey)) return false;        // CA-11
    if (!isFiniteNumber(avancePct)) return false;      // CA-10/CA-14
    const ts = isFiniteNumber(now) ? now : Date.now();

    const rec = { ts, waveKey, avancePct };            // SOLO primitivos (SEC-2)
    const file = storePath(pipelineRootArg);
    try {
        fs.appendFileSync(file, JSON.stringify(rec) + '\n');  // objeto completo, nunca concat
    } catch {
        return false;  // FS no disponible → no rompemos al caller
    }

    // Pruning oportunista (CA-12 / SEC-4): cada N appends mantenemos la cota.
    _appendCounter++;
    if (_appendCounter >= PRUNE_EVERY_N) {
        _appendCounter = 0;
        try { pruneStore({ pipelineRoot: pipelineRootArg, activeWaveKey: waveKey, now: ts }); } catch { /* no-op */ }
    }
    return true;
}

// ─── readSnapshots (reader tolerante) ──────────────────────────────────────

/**
 * Lee la serie completa (o filtrada por `waveKey`) de forma tolerante a
 * líneas corruptas (SEC-6): cada línea se parsea con try/catch; una línea
 * inválida se descarta sin abortar.
 *
 * `eta-wave.js` NO usa este reader (stremea el JSONL por su cuenta para
 * respetar su patrón readline); esta función existe para tests y consumidores
 * que ya están del lado de escritura.
 *
 * @param {{pipelineRoot?:string, waveKey?:number}} [args]
 * @returns {Array<{ts:number, waveKey:number, avancePct:number}>} ordenada por ts asc
 */
function readSnapshots({ pipelineRoot: pipelineRootArg, waveKey } = {}) {
    const file = storePath(pipelineRootArg);
    let raw;
    try { raw = fs.readFileSync(file, 'utf8'); }
    catch { return []; }

    const filterKey = isValidWaveKey(waveKey) ? waveKey : null;
    const out = [];
    for (const line of raw.split('\n')) {
        if (!line) continue;
        let rec;
        try { rec = JSON.parse(line); } catch { continue; }   // SEC-6
        if (!rec || typeof rec !== 'object') continue;
        if (!isValidWaveKey(rec.waveKey)) continue;
        if (!isFiniteNumber(rec.ts) || !isFiniteNumber(rec.avancePct)) continue;
        if (filterKey !== null && rec.waveKey !== filterKey) continue;
        out.push({ ts: rec.ts, waveKey: rec.waveKey, avancePct: rec.avancePct });
    }
    out.sort((a, b) => a.ts - b.ts);
    return out;
}

// ─── pruneStore (CA-12 / SEC-4) ────────────────────────────────────────────

/**
 * Reescribe el store descartando líneas de olas NO activas más viejas que
 * `RETENTION_MS`. Las líneas de la ola activa (`activeWaveKey`) se conservan
 * siempre. Adicionalmente impone una cota dura `MAX_LINES`, dejando las más
 * recientes.
 *
 * Es idempotente y tolerante: si el archivo no existe, no hace nada.
 *
 * @param {{pipelineRoot?:string, activeWaveKey:number, now?:number}} args
 * @returns {{kept:number, dropped:number}} counts agregados (sin contenido raw, SEC-5)
 */
function pruneStore({ pipelineRoot: pipelineRootArg, activeWaveKey, now } = {}) {
    const file = storePath(pipelineRootArg);
    let raw;
    try { raw = fs.readFileSync(file, 'utf8'); }
    catch { return { kept: 0, dropped: 0 }; }

    const ts = isFiniteNumber(now) ? now : Date.now();
    const cutoff = ts - RETENTION_MS;
    const active = isValidWaveKey(activeWaveKey) ? activeWaveKey : null;

    let kept = [];
    let dropped = 0;
    for (const line of raw.split('\n')) {
        if (!line) continue;
        let rec;
        try { rec = JSON.parse(line); } catch { dropped++; continue; }  // corrupta → fuera
        if (!rec || !isValidWaveKey(rec.waveKey) || !isFiniteNumber(rec.ts) || !isFiniteNumber(rec.avancePct)) {
            dropped++;
            continue;
        }
        // Mantener si es la ola activa O si es reciente (CA-12).
        const keep = (active !== null && rec.waveKey === active) || rec.ts >= cutoff;
        if (keep) kept.push(line);
        else dropped++;
    }

    // Cota dura de líneas: dejar las más recientes.
    if (kept.length > MAX_LINES) {
        dropped += kept.length - MAX_LINES;
        kept = kept.slice(kept.length - MAX_LINES);
    }

    if (dropped === 0) return { kept: kept.length, dropped: 0 };

    try {
        fs.writeFileSync(file, kept.length ? kept.join('\n') + '\n' : '');
    } catch {
        return { kept: kept.length, dropped: 0 };  // no pudimos reescribir → estado previo intacto
    }
    return { kept: kept.length, dropped };
}

// ─── Exports ──────────────────────────────────────────────────────────────

module.exports = {
    appendSnapshot,
    readSnapshots,
    pruneStore,
    // Constantes / helpers expuestos para tests
    RETENTION_MS,
    MAX_LINES,
    PRUNE_EVERY_N,
    _internal: {
        storePath,
        pipelineDir,
        isValidWaveKey,
        isFiniteNumber,
        _resetCounter: () => { _appendCounter = 0; },
    },
};
