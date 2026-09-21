// =============================================================================
// #7439 — Causa estructurada de un bloqueo humano (`cause` del `.reason.json`).
//
// MÓDULO HOJA: cero `require`. No es prolijidad, es una restricción de carga.
// `human-block.js` requiere `decision-card.js` en top-level; si `decision-card`
// importara el enum desde `human-block`, Node resolvería el ciclo entregando un
// `module.exports` parcial (`{}`) y el enum llegaría `undefined` a `normalizar`
// → toda `cause` colapsaría a `null` y la ficha `decision` no saldría nunca,
// sin ningún error visible. Mismo patrón que `sello-evidencia-state.js`.
//
// El enum es CERRADO y el campo se normaliza en escritura Y en lectura
// (RS-C.1): un `.reason.json` editado a mano o corrupto no produce una causa
// que ningún call-site escribió. Importa porque `cause` es la llave del filtro
// de auto-levantamiento de #7440 (RS-4.1): lo que se relaje acá se hereda allá.
// =============================================================================
'use strict';

/** Causas conocidas. Una sola por ahora: el gate de decisión de arquitectura. */
const BLOCK_CAUSE_ENUM = Object.freeze(['design-decision']);

/**
 * Normaliza un valor de `cause`: string EXACTO dentro del enum, o `null`.
 * Sin `trim` a propósito (`' design-decision'` → `null`): un valor que no es
 * byte a byte el del enum no lo escribió este código.
 * @param {*} v
 * @returns {string|null}
 */
function normalizeBlockCause(v) {
    return (typeof v === 'string' && BLOCK_CAUSE_ENUM.includes(v)) ? v : null;
}

/**
 * #7440 rev-2 — keys de señal del detector persistidas en el marker (`signals`
 * del `.reason.json`). Misma familia que `cause`: campo estructurado que sólo
 * escribe el gate de decisión y que se normaliza en escritura Y en lectura.
 *
 * Cerrado por FORMA (identificador corto: `/^[a-z0-9][a-z0-9-]{0,39}$/`) y por
 * TOPE (8), nunca texto libre: un `.reason.json` editado a mano no puede meter
 * prosa en el comentario de traza de GitHub (UX-C). Lo que no cumple la forma
 * se descarta en silencio; no-array ⇒ `[]`. Dedup preservando el orden.
 */
const SIGNAL_KEY_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const MAX_SIGNALS = 8;

/**
 * @param {*} v
 * @returns {string[]}
 */
function normalizeBlockSignals(v) {
    if (!Array.isArray(v)) return [];
    const out = [];
    for (const s of v) {
        if (out.length >= MAX_SIGNALS) break;
        if (typeof s === 'string' && SIGNAL_KEY_RE.test(s) && !out.includes(s)) out.push(s);
    }
    return out;
}

module.exports = { BLOCK_CAUSE_ENUM, normalizeBlockCause, normalizeBlockSignals, MAX_SIGNALS };
