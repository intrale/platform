// =============================================================================
// delivery-status.js — Fuente ÚNICA del estado "Entregado" (#5629).
//
// PROBLEMA QUE RESUELVE
// --------------------
// El estado "Entregado" se derivaba tres veces, cada una por su cuenta:
//
//   1. `wave-snapshot.js`      → `isClosedFromLabel || hasEntregaProcesada`
//   2. `dashboard-routes.js`   → `state === 'CLOSED'` (entregados / enrichWaveIssue)
//   3. `pipeline-redesign.js`  → `status === 'completed' || merged === true`
//
// Tres derivaciones ⇒ tres respuestas distintas para el MISMO issue. El
// 2026-08-06 sobre la Ola 9.4: #5220 y #5244 se pintaban 100% en la columna
// Entregado con sus PRs (#5277, #5280) sin mergear y los issues ABIERTOS en
// GitHub; #5242 se pintaba Entregado mientras un agente lo trabajaba.
//
// REGLAS (no negociables)
// -----------------------
// R1. `CLOSED` en GitHub es fuente de verdad de entrega, y le gana a labels
//     residuales y a fases cacheadas. Principio ya fijado por #4099 y #4732;
//     este módulo lo extiende a los markers de la fase de entrega.
//
// R2. `delivery_merge_sha` es la ÚNICA señal LOCAL de merge real: presente ⇒
//     merge confirmado, ausente/nulo ⇒ NO mergeado. `delivery.js` lo escribe
//     exclusivamente en la rama `merged` del gate — nunca en `no-qa-gate`,
//     `needs-human`, `blocked` ni `conflict` — así que discrimina merge real de
//     merge frenado sin ambigüedad. Sirve además para cerrar la ventana del TTL
//     de 1h de `.issue-title-cache.json`: un PR mergeado hace un minuto ya
//     tiene SHA aunque el cache siga reportando el issue como OPEN.
//
// R3. PROHIBIDO inferir el estado de entrega parseando la prosa de `motivo`, o
//     tomando `resultado: aprobado` del marker como sinónimo de merge. Ese fue
//     exactamente el bug: los markers de #5220/#5244 decían `aprobado` con el
//     motivo confesando "merge bloqueado". Antecedente explícito de #5516:
//     interpretar texto libre genera falsos positivos. Este módulo NO recibe ni
//     mira `motivo`/`resultado` — la prohibición es estructural, no una
//     convención que haya que recordar.
//
// R4. La mera PRESENCIA de un marker procesado en `desarrollo/entrega` NO es
//     entrega. El marker sobrevive a los rebotes: si el issue vuelve a una fase
//     anterior, el cierre histórico le ganaba a la `faseActual` viva y el issue
//     se dibujaba en Entregado al 100% con un agente trabajándolo.
//
// Función PURA: no toca disco ni red, no lanza. Ante input inválido degrada a
// "no entregado" (fail-closed: preferimos mostrar en curso algo ya entregado
// antes que dar por entregado algo que no lo está).
// =============================================================================

'use strict';

// Clave de la fase de entrega dentro de `issueMatrix[id].fases`.
const DELIVERY_PHASE_KEY = 'desarrollo/entrega';

// Un SHA de git: hex de 7 (short) a 40 (full) caracteres. Validar el FORMATO
// evita que un placeholder tipo "(sin merge)", "null", "pending" o una cadena
// vacía cuente como merge por el solo hecho de ser truthy.
const MERGE_SHA_RE = /^[0-9a-f]{7,40}$/;

// Estados de work-file en los que el marker ya tiene el veredicto escrito.
// `delivery.js` escribe el marker en el `finally` mientras el archivo está en
// `trabajando/`; el pulpo lo mueve a `listo/` y luego a `procesado/`.
const MARKER_READY_STATES = new Set(['listo', 'procesado']);

/**
 * Normaliza un `delivery_merge_sha` crudo a string válido o null.
 * Sin heurísticas de texto: o parece un SHA, o no cuenta (R2/R3).
 *
 * @param {*} value — valor crudo del marker.
 * @returns {string|null} SHA en minúsculas, o null si no es un SHA válido.
 */
function normalizeMergeSha(value) {
    if (typeof value !== 'string') return null;
    const clean = value.trim().toLowerCase();
    if (!clean) return null;
    return MERGE_SHA_RE.test(clean) ? clean : null;
}

/**
 * Extrae el `delivery_merge_sha` de la entrada de matriz de un issue.
 *
 * Recorre las entradas de la fase de entrega y devuelve el primer SHA válido.
 * Ignora por completo `resultado` y `motivo` (R3).
 *
 * @param {object|null} matrixEntry — `state.issueMatrix[id]`.
 * @returns {string|null}
 */
function extractMergeSha(matrixEntry) {
    if (!matrixEntry || typeof matrixEntry !== 'object') return null;
    const fases = matrixEntry.fases;
    if (!fases || typeof fases !== 'object') return null;
    const entries = fases[DELIVERY_PHASE_KEY];
    if (!Array.isArray(entries)) return null;

    for (const entry of entries) {
        if (!entry || typeof entry !== 'object') continue;
        // Sólo markers con veredicto ya escrito. Un archivo en `pendiente/` o
        // `trabajando/` todavía no tiene SHA (y si lo tuviera, sería el de una
        // corrida anterior).
        if (entry.estado && !MARKER_READY_STATES.has(entry.estado)) continue;
        const sha = normalizeMergeSha(entry.delivery_merge_sha);
        if (sha) return sha;
    }
    return null;
}

/**
 * Regla única de "Entregado": cerrado en GitHub (R1) O con merge SHA
 * estructurado (R2). Nada más cuenta.
 *
 * @param {{closedInGitHub?: boolean, mergeSha?: string|null}} input
 * @returns {boolean}
 */
function isDelivered(input) {
    const o = input || {};
    if (o.closedInGitHub === true) return true;
    return normalizeMergeSha(o.mergeSha) !== null;
}

/**
 * Deriva el estado de entrega completo de un issue. ESTE es el punto de entrada
 * que deben usar las tres vistas — no re-derivar la regla en el call site.
 *
 * @param {object} opts
 * @param {number|string} opts.id           — número de issue.
 * @param {Set|Array|null} [opts.closedSet] — issues CLOSED en GitHub.
 * @param {object|null} [opts.matrixEntry]  — `state.issueMatrix[id]`.
 * @returns {{delivered:boolean, closedInGitHub:boolean, mergeSha:string|null, source:string}}
 *          `source`: 'github-closed' | 'merge-sha' | 'none'.
 */
function deriveDeliveryState(opts) {
    const o = opts || {};
    const id = Number(o.id);

    let closedInGitHub = false;
    if (Number.isFinite(id)) {
        const cs = o.closedSet;
        if (cs instanceof Set) closedInGitHub = cs.has(id) || cs.has(String(id));
        else if (Array.isArray(cs)) closedInGitHub = cs.some((v) => Number(v) === id);
    }

    const mergeSha = extractMergeSha(o.matrixEntry);
    const delivered = closedInGitHub || mergeSha !== null;

    let source = 'none';
    // `github-closed` tiene precedencia como etiqueta de origen porque es la
    // fuente de verdad (R1); `merge-sha` es la señal local que se le adelanta
    // durante la ventana del TTL del title-cache (R2).
    if (closedInGitHub) source = 'github-closed';
    else if (mergeSha) source = 'merge-sha';

    return { delivered, closedInGitHub, mergeSha, source };
}

module.exports = {
    DELIVERY_PHASE_KEY,
    MERGE_SHA_RE,
    normalizeMergeSha,
    extractMergeSha,
    isDelivered,
    deriveDeliveryState,
};
