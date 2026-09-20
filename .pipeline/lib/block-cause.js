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

module.exports = { BLOCK_CAUSE_ENUM, normalizeBlockCause };
