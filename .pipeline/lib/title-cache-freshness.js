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
//   2. negative cache (`notFound: true`) → NO refetch (SEC-3: no martillar gh)
//   3. entrada pre-#3905 (sin `state`)   → refetch (para poblar state)
//   4. entrada vencida (now - fetchedAt > ttlMs) → refetch
//   5. entrada fresca con `state`        → NO refetch
// =============================================================================

'use strict';

const DEFAULT_TITLE_CACHE_TTL_MS = 3600000; // 1 hora (alineado con dashboard.js)

/**
 * ¿Hay que re-pedir esta entrada del title-cache a `gh`?
 *
 * @param {object|undefined} entry  - entrada cacheada: { state, labels, notFound, fetchedAt }
 * @param {object} [opts]
 * @param {number} [opts.now]   - epoch ms (default Date.now())
 * @param {number} [opts.ttlMs] - TTL en ms (default 1h)
 * @returns {boolean} true si debe refetchearse
 */
function needsRefetch(entry, opts = {}) {
    const now = typeof opts.now === 'number' ? opts.now : Date.now();
    const ttlMs = Number.isFinite(opts.ttlMs) && opts.ttlMs > 0 ? opts.ttlMs : DEFAULT_TITLE_CACHE_TTL_MS;

    if (!entry) return true;                                  // 1. sin cache
    if (entry.notFound) return false;                         // 2. negative cache
    if (entry.state === undefined) return true;               // 3. entradas pre-#3905
    return (now - (entry.fetchedAt || 0)) > ttlMs;            // 4/5. TTL
}

module.exports = { needsRefetch, DEFAULT_TITLE_CACHE_TTL_MS };
