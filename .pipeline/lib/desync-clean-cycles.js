// =============================================================================
// desync-clean-cycles.js — Contador de ciclos limpios para gating PR2 (#3617,
// REQ-SEC-6 + CA-PO-6).
//
// Por qué este módulo existe
// --------------------------
// El plan de migración separa la entrega en dos PRs:
//
//   PR1 (este issue, #3617): bootstrap + audit + fail-closed + desync alerta.
//                            Mantiene el fallback legacy en `getAllowlist()`.
//   PR2 (issue separado):    elimina el fallback de getAllowlist() → solo
//                            waves.json. Recuperabilidad comprometida si algo
//                            sale mal.
//
// REQ-SEC-6 pide que ANTES de mergear PR2 verifiquemos empíricamente que el
// sistema corrió 3+ ciclos consecutivos sin desync (waves y partial-pause
// equivalentes). Este módulo lleva ese contador en filesystem persistente.
//
// Archivo
// -------
//   `.pipeline/_desync-clean-cycles.counter` — JSON simple:
//     {
//       "count": 3,
//       "last_tick_at": "ISO timestamp",
//       "last_reset_at": "ISO timestamp",
//       "last_state_hash": "SHA-256 del estado del último tick (para no contar 2× el mismo boot)",
//       "history": [{ ts, action: 'inc'|'reset', from, to }]   // truncado a últimos 50
//     }
//
// API
// ---
//   recordCleanCycle(stateHash) → { count, action } incrementa si stateHash es nuevo
//   recordDirtyCycle()          → { count } resetea a 0
//   readCounter()               → estado actual
//   resetCounter()              → fuerza count=0 (para tests)
// =============================================================================

'use strict';

const fs = require('fs');
const path = require('path');

const COUNTER_BASENAME = '_desync-clean-cycles.counter';
const HISTORY_MAX = 50;

function pipelineDir() {
    if (process.env.PIPELINE_DIR_OVERRIDE) return process.env.PIPELINE_DIR_OVERRIDE;
    return path.join(__dirname, '..');
}

function counterPath() {
    return path.join(pipelineDir(), COUNTER_BASENAME);
}

function nowIso() {
    return new Date().toISOString();
}

function defaultCounter() {
    return {
        count: 0,
        last_tick_at: null,
        last_reset_at: nowIso(),
        last_state_hash: null,
        history: [],
    };
}

function readCounter() {
    if (!fs.existsSync(counterPath())) return defaultCounter();
    try {
        const raw = fs.readFileSync(counterPath(), 'utf8');
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object') return defaultCounter();
        // Tolerar shape parcial.
        return {
            count: Number.isInteger(parsed.count) ? parsed.count : 0,
            last_tick_at: parsed.last_tick_at || null,
            last_reset_at: parsed.last_reset_at || null,
            last_state_hash: parsed.last_state_hash || null,
            history: Array.isArray(parsed.history) ? parsed.history.slice(-HISTORY_MAX) : [],
        };
    } catch {
        return defaultCounter();
    }
}

function writeCounter(counter) {
    try {
        // Truncar history defensivamente.
        if (Array.isArray(counter.history) && counter.history.length > HISTORY_MAX) {
            counter.history = counter.history.slice(-HISTORY_MAX);
        }
        fs.writeFileSync(counterPath(), JSON.stringify(counter, null, 2));
    } catch (err) {
        console.warn(`[desync-clean-cycles] no se pudo persistir counter: ${err.message}`);
    }
}

/**
 * Incrementa el contador si el stateHash es distinto al del último tick.
 * Esto evita que el mismo boot incremente N veces si el operador re-corre
 * detect múltiples veces sin cambiar el estado.
 *
 * @param {string} stateHash — hash determinístico del estado actual
 * @returns {{ count: number, action: 'inc' | 'duplicate' }}
 */
function recordCleanCycle(stateHash) {
    const c = readCounter();
    if (stateHash && c.last_state_hash === stateHash) {
        return { count: c.count, action: 'duplicate' };
    }
    const prev = c.count;
    c.count = prev + 1;
    c.last_tick_at = nowIso();
    c.last_state_hash = stateHash || null;
    c.history.push({ ts: c.last_tick_at, action: 'inc', from: prev, to: c.count });
    writeCounter(c);
    return { count: c.count, action: 'inc' };
}

/**
 * Resetea el contador. Llamado cuando detect devuelve desync=true.
 *
 * @returns {{ count: 0 }}
 */
function recordDirtyCycle() {
    const c = readCounter();
    const prev = c.count;
    if (prev === 0) {
        // No-op pero igual actualizamos last_reset_at para visibilidad.
        c.last_reset_at = nowIso();
        writeCounter(c);
        return { count: 0 };
    }
    c.count = 0;
    c.last_reset_at = nowIso();
    c.last_state_hash = null;
    c.history.push({ ts: c.last_reset_at, action: 'reset', from: prev, to: 0 });
    writeCounter(c);
    return { count: 0 };
}

function resetCounter() {
    const c = defaultCounter();
    writeCounter(c);
}

module.exports = {
    recordCleanCycle,
    recordDirtyCycle,
    readCounter,
    resetCounter,
    COUNTER_BASENAME,
    _internal: { counterPath, pipelineDir },
};
