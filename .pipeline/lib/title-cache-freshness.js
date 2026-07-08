// =============================================================================
// title-cache-freshness.js — Predicado de frescura del issue-title-cache (#4099).
//
// El cuadro de estado de la ola (`wave`) lee labels/state desde
// `.issue-title-cache.json`. Antes una entrada con `state` quedaba congelada
// para siempre (TITLE_CACHE_TTL definido pero nunca usado en dashboard.js), así
// un issue que se cerraba o le cambiaban los labels en GitHub nunca se
// refrescaba (caso #4050).
//
// Este módulo concentra la decisión "¿hay que re-pedir esta entrada a `gh`?"
// como FUNCIÓN PURA, para reusarla desde dashboard.js y cubrirla con tests
// determinísticos (CA-3).
//
// Reglas (en orden):
//   1. sin entrada en cache              → refetch
//   2. error transitorio (`transientError`) → refetch (#4566: se reintenta ya)
//   3. negative cache (`notFound: true`) → refetch sólo tras TTL negativo largo
//      (#4566: SEC-3 no martillar gh, PERO auto-curar envenenamientos históricos;
//       antes NUNCA se re-consultaba y un blip de gh clavaba la métrica de ola)
//   4. entrada pre-#3905 (sin `state`)   → refetch (para poblar state)
//   5. entrada vencida (now - fetchedAt > ttlMs) → refetch
//   6. entrada fresca con `state`        → NO refetch
// =============================================================================

'use strict';

const DEFAULT_TITLE_CACHE_TTL_MS = 3600000;   // 1 hora (alineado con dashboard.js)
// #4566 — TTL de la negative-cache. Un `notFound` legítimo (issue borrado) se
// re-verifica sólo cada 24h (no martilla gh), pero una entrada envenenada por un
// fallo transitorio se auto-cura en ≤24h sin intervención manual.
const DEFAULT_NEGATIVE_CACHE_TTL_MS = 86400000; // 24 horas

/**
 * ¿Hay que re-pedir esta entrada del title-cache a `gh`?
 *
 * @param {object|undefined} entry  - entrada cacheada: { state, labels, notFound, transientError, fetchedAt }
 * @param {object} [opts]
 * @param {number} [opts.now]            - epoch ms (default Date.now())
 * @param {number} [opts.ttlMs]          - TTL positivo en ms (default 1h)
 * @param {number} [opts.negativeTtlMs]  - TTL de la negative-cache en ms (default 24h)
 * @returns {boolean} true si debe refetchearse
 */
function needsRefetch(entry, opts = {}) {
    const now = typeof opts.now === 'number' ? opts.now : Date.now();
    const ttlMs = Number.isFinite(opts.ttlMs) && opts.ttlMs > 0 ? opts.ttlMs : DEFAULT_TITLE_CACHE_TTL_MS;
    const negTtlMs = Number.isFinite(opts.negativeTtlMs) && opts.negativeTtlMs > 0
        ? opts.negativeTtlMs : DEFAULT_NEGATIVE_CACHE_TTL_MS;

    if (!entry) return true;                                         // 1. sin cache
    if (entry.transientError) return true;                          // 2. error transitorio (#4566): reintentar ya
    if (entry.notFound) {                                            // 3. negative cache con TTL largo (#4566)
        return (now - (entry.fetchedAt || 0)) > negTtlMs;
    }
    if (entry.state === undefined) return true;                     // 4. entradas pre-#3905
    return (now - (entry.fetchedAt || 0)) > ttlMs;                  // 5/6. TTL positivo
}

module.exports = { needsRefetch, DEFAULT_TITLE_CACHE_TTL_MS, DEFAULT_NEGATIVE_CACHE_TTL_MS };
