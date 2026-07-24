'use strict';

// =============================================================================
// dashboard-thresholds.js — #3961 EP8-H8 (CA-6 / CA-9 / SEC-3).
//
// Carga y valida los umbrales configurables de los KPIs del dashboard desde el
// bloque `dashboard.thresholds` de config.yaml. Migra los targets antes
// hardcodeados (SHERLOCK_PRECISION_TARGET / _SAME_PROVIDER de dashboard-slices.js
// y los targets DORA de dashboard.js) a configuración.
//
// Contrato de seguridad (SEC-3 / CA-9):
//   - Coerción numérica: cualquier valor no-numérico/NaN cae al DEFAULT seguro.
//   - Clamp de rango: valores fuera del [min,max] declarado se acotan al borde.
//   - Default seguro si la clave falta.
//   - Merge resistente a prototype pollution: SOLO se leen claves de la
//     allowlist (DEFS); nunca se itera el objeto de config con keys arbitrarias,
//     así que `__proto__`/`constructor`/`prototype` no pueden contaminar nada.
//   - El valor devuelto es siempre un number plano; el caller NO debe interpolar
//     config cruda en HTML — estos números se renderizan con escape igual.
// =============================================================================

// Definición canónica: clave → { def, min, max }. La allowlist de claves vive
// EXCLUSIVAMENTE acá. Agregar un umbral nuevo = agregar una entrada acá.
const DEFS = {
    sherlock_precision_target:      { def: 0.90, min: 0,   max: 1 },
    sherlock_precision_alert_below: { def: 0.80, min: 0,   max: 1 },
    sherlock_same_provider_target:  { def: 0.10, min: 0,   max: 1 },
    voice_p95_max_ms:               { def: 8000, min: 0,   max: 600000 },
    deliverables_min_pct:           { def: 80,   min: 0,   max: 100 },
    dora_lead_time_max_h:           { def: 6,    min: 0,   max: 720 },
    dora_throughput_min_per_day:    { def: 2,    min: 0,   max: 1000 },
    dora_fail_rate_max_pct:         { def: 15,   min: 0,   max: 100 },
};

// Claves peligrosas que jamás deben leerse del bloque de config (defensa en
// profundidad: aunque sólo iteramos DEFS, nunca leemos estas como umbral).
const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

function _coerceClamp(raw, def, min, max) {
    // Coerción numérica estricta: number directo o string numérica. Cualquier
    // otra cosa (objeto, array, boolean, null, undefined, NaN, Infinity) → def.
    let n;
    if (typeof raw === 'number') n = raw;
    else if (typeof raw === 'string' && raw.trim() !== '') n = Number(raw);
    else return def;
    if (!Number.isFinite(n)) return def;
    if (n < min) return min;
    if (n > max) return max;
    return n;
}

/**
 * Resuelve los umbrales del dashboard a partir de un objeto de config ya
 * parseado (el mismo `state.config` / `ctx.config` que usan los slices).
 *
 * @param {object|null} config - Config completa (con bloque `dashboard.thresholds`).
 * @returns {object} - Objeto plano (Object.create(null)) con TODAS las claves de
 *                     DEFS, cada una un number validado. Nunca lanza.
 */
function loadThresholds(config) {
    const out = Object.create(null);
    let block = null;
    try {
        const dash = config && typeof config === 'object' ? config.dashboard : null;
        block = dash && typeof dash === 'object' ? dash.thresholds : null;
    } catch { block = null; }
    for (const key of Object.keys(DEFS)) {
        const { def, min, max } = DEFS[key];
        let raw;
        if (block && typeof block === 'object'
            && !FORBIDDEN_KEYS.has(key)
            && Object.prototype.hasOwnProperty.call(block, key)) {
            raw = block[key];
        }
        out[key] = _coerceClamp(raw, def, min, max);
    }
    return out;
}

module.exports = { loadThresholds, DEFS, _coerceClamp };
