// =============================================================================
// recommendation-labels.js — Fuente ÚNICA del discriminador
// "issue de recomendación" vs "bloqueo real" (#5337, CA-6).
//
// Contexto del problema (medido el 2026-08-01 sobre el repo real):
//
//     needs-human total ................. 880
//     de esos tipo:recomendacion ........ 865
//     bloqueos reales ...................  15   (1,7%)
//
// El label `needs-human` se usa para DOS cosas distintas:
//   1. Bloqueo real: el pipeline se frenó y necesita una acción del operador.
//   2. Recomendación de agente (guru/security/po/ux/review): backlog que espera
//      triaje, sin ningún agente frenado atrás.
//
// Mezclarlas hace que la notificación de bloqueo nazca ahogada en 98,3% de
// ruido. El discriminador ya existía duplicado en `servicio-reconciler.js` y
// (inline) en `views/dashboard/bloqueados.js`; una tercera copia en
// `human-block.js` habría sido una tercera fuente de verdad que se desincroniza.
//
// Este módulo es deliberadamente MINÚSCULO y sin dependencias: `human-block.js`
// es una librería base que el propio reconciler consume, así que requerir el
// reconciler desde ahí habría creado un ciclo de `require` y arrastrado un
// módulo de servicio pesado. Un módulo hoja no tiene ese problema.
// =============================================================================

'use strict';

// Labels que marcan un issue como recomendación de agente (no un bloqueo).
// `source:recommendation` es el histórico; `tipo:recomendacion` el vigente.
// Ambos se mantienen: hay issues abiertos con uno, otro, o los dos.
const RECOMMENDATION_LABELS = new Set(['source:recommendation', 'tipo:recomendacion']);

// Label que un humano aplica al aprobar la recomendación. A partir de ahí el
// issue deja de ser "backlog esperando triaje" y entra al flujo normal, así que
// ya NO se filtra como recomendación.
const RECOMMENDATION_APPROVED_LABEL = 'recommendation:approved';

/**
 * Normaliza una lista de labels heterogénea a nombres string.
 *
 * GitHub devuelve labels como `[{name, color, ...}]` en `gh issue list --json
 * labels`, pero varias partes del pipeline ya los aplanaron a `['a','b']`.
 * Aceptar ambas formas evita que el filtro falle silenciosamente (que es la
 * peor falla posible acá: dejaría pasar las 865 recomendaciones).
 *
 * @param {Array<string|{name?:string}>} labels
 * @returns {string[]} nombres de label, sin vacíos.
 */
function normalizeLabelNames(labels) {
    if (!Array.isArray(labels)) return [];
    const out = [];
    for (const l of labels) {
        if (typeof l === 'string') {
            const s = l.trim();
            if (s) out.push(s);
        } else if (l && typeof l === 'object' && typeof l.name === 'string') {
            const s = l.name.trim();
            if (s) out.push(s);
        }
    }
    return out;
}

/**
 * ¿Este issue es una recomendación de agente pendiente de triaje?
 *
 * Devuelve `false` si la recomendación ya fue aprobada por un humano
 * (`recommendation:approved`): en ese caso es trabajo real del pipeline y un
 * bloqueo suyo sí merece notificación.
 *
 * @param {Array<string|{name?:string}>} labels
 * @returns {boolean}
 */
function isRecommendationIssue(labels) {
    const names = normalizeLabelNames(labels);
    if (names.includes(RECOMMENDATION_APPROVED_LABEL)) return false;
    for (const n of names) {
        if (RECOMMENDATION_LABELS.has(n)) return true;
    }
    return false;
}

module.exports = {
    RECOMMENDATION_LABELS,
    RECOMMENDATION_APPROVED_LABEL,
    normalizeLabelNames,
    isRecommendationIssue,
};
