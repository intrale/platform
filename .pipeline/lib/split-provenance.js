// =============================================================================
// split-provenance.js — Predicado de "hijo verificable de un split del propio
// pipeline" para el desync ADITIVO (issue #4525).
//
// Por qué existe
// --------------
// El detector de desync (`desync-detector.js`) clasifica como `ambiguo` toda
// divergencia aditiva con un issue ABIERTO extra en la allowlist que no está en
// la ola activa (fail-safe OWASP A08, #3518/#4350). Eso frena TODO el dispatch
// hasta corrección manual (`BLOQUEADO POR DESYNC`).
//
// El caso #4439 (`legit-add-trace.js`) resuelve el subcaso "aditivo legítimo"
// pero se apoya en el audit encadenado con TTL corto (90 s). El incidente del
// 2026-07-06 (+5 h frenado) es exactamente el gap donde ese TTL venció: al
// hacer el split de #4509 se sumaron #4523/#4524 a la allowlist con provenance
// `recursive-deps:from-4509`, pero la traza `wave-add` caducó y la divergencia
// cayó a `ambiguo`.
//
// Este módulo decide, POR ISSUE, si un extra de la allowlist es hijo VERIFICABLE
// de un split del propio pipeline: existe `authorization_ttls[n].parent` que
// pertenece a la ola activa Y `authorized_by` matchea `recursive-deps:from-<parent>`
// con el MISMO parent. Es un check ESTRUCTURAL/PROVENANCE-based (durable), no
// time-bounded como #4439. Complementa #4439, no lo reemplaza.
//
// Reglas de seguridad (RS-1..RS-5, del análisis de security del issue)
// --------------------------------------------------------------------
//   - RS-1: la provenance NO se confía sólo por la presencia del campo `parent`.
//     Se cross-checkea que `authorized_by` matchee `recursive-deps:from-<parent>`
//     y que `<parent>` del string coincida con el campo `parent`. Confiar sólo
//     en `parent` deja abierta la inyección de un `parent` arbitrario apuntando
//     a un issue de la ola → bypass del gate humano.
//   - RS-2: default-deny estricto. Cualquier issue sin provenance verificable se
//     EXCLUYE del subconjunto. El binding es POR ISSUE (no all-or-nothing): la
//     decisión de bloqueo global la toma el consumidor (pulpo).
//   - RS-4: la decisión NO se gatea sobre `expires_at`. El check es la relación
//     estructural `parent ∈ ola`. Si el cron purga `authorization_ttls`, la
//     provenance desaparece y degrada a bloqueo (fail-safe), nunca a
//     auto-incorporación silenciosa.
//   - RS-5: validación defensiva de tipos (`parent` entero, issue-numbers
//     enteros). Evita amplificación de dispatch ante un `added` malformado.
//
// Este módulo es PURO: sin red, sin GitHub, sin I/O de secrets, sin escritura
// de estado. Sólo LEE los objetos que le pasan y devuelve el subconjunto
// trazable. Estilo `lib/legit-add-trace.js`.
// =============================================================================

'use strict';

const { RECURSIVE_DEPS_RE } = require('./partial-pause-audit');

/**
 * Normaliza un valor a entero > 0 o null (no confía en el input, RS-5).
 * @param {*} v
 * @returns {number|null}
 */
function toPositiveInt(v) {
    if (typeof v === 'number') return Number.isInteger(v) && v > 0 ? v : null;
    if (typeof v === 'string') {
        const n = Number(v.trim());
        return Number.isInteger(n) && n > 0 ? n : null;
    }
    return null;
}

/**
 * Devuelve el SUBCONJUNTO de `added` cuyos issues son hijos VERIFICABLES de un
 * split del propio pipeline. Un issue N califica sii TODAS estas condiciones:
 *   1. `authorizationTtls[N]` existe y `authorizationTtls[N].parent` es entero > 0 (RS-5).
 *   2. Ese `parent` pertenece a `activeWaveIssues` (padre ya en la ola).
 *   3. `authorizationTtls[N].authorized_by` matchea `recursive-deps:from-<parent>`
 *      con `Number(<parent>) === parent` (RS-1, cross-check anti-forja).
 *
 * Cualquier fallo/indeterminación EXCLUYE al candidato (fail-safe RS-2). NO
 * gatea sobre `expires_at` (RS-4).
 *
 * @param {Array<number|string>} added — issues extra en la allowlist (probe.added).
 * @param {object} ctx
 * @param {Object} [ctx.authorizationTtls] — mapa `{ [issue]: { parent, authorized_by, ... } }`.
 * @param {Array<number|string>} [ctx.activeWaveIssues] — números de issue de la ola activa.
 * @returns {number[]} subconjunto trazable, ordenado ascendente y sin duplicados.
 */
function filterSplitChildren(added, ctx = {}) {
    const list = Array.isArray(added) ? added : [];
    if (list.length === 0) return [];

    const authorizationTtls = (ctx.authorizationTtls && typeof ctx.authorizationTtls === 'object')
        ? ctx.authorizationTtls
        : {};
    const inWave = new Set(
        (Array.isArray(ctx.activeWaveIssues) ? ctx.activeWaveIssues : [])
            .map(toPositiveInt)
            .filter(Boolean)
    );

    const result = new Set();
    for (const raw of list) {
        const n = toPositiveInt(raw);
        if (!n) continue;                                            // RS-5: issue inválido → excluir

        const ttl = authorizationTtls[String(n)];
        if (!ttl || typeof ttl !== 'object') continue;               // sin provenance → excluir (RS-2)

        const parent = toPositiveInt(ttl.parent);
        if (!parent) continue;                                       // RS-5: parent no entero → excluir
        if (!inWave.has(parent)) continue;                           // parent fuera de la ola → excluir

        // RS-1: cross-check anti-forja. No basta con que exista `parent`: el
        // `authorized_by` debe llevar la marca de origen del split del propio
        // pipeline (`recursive-deps:from-<parent>`) con el MISMO parent.
        const m = RECURSIVE_DEPS_RE.exec(String(ttl.authorized_by || ''));
        if (!m || Number(m[1]) !== parent) continue;

        result.add(n);
    }
    return [...result].sort((a, b) => a - b);
}

/**
 * Devuelve el `parent` verificable de un issue hijo de split, o null si no lo
 * tiene. Útil para el consumidor (pulpo) al declarar la dependencia. Aplica el
 * mismo cross-check RS-1/RS-5 que `filterSplitChildren`.
 *
 * @param {number|string} child
 * @param {Object} authorizationTtls
 * @returns {number|null}
 */
function parentOfSplitChild(child, authorizationTtls) {
    const n = toPositiveInt(child);
    if (!n) return null;
    const ttls = (authorizationTtls && typeof authorizationTtls === 'object') ? authorizationTtls : {};
    const ttl = ttls[String(n)];
    if (!ttl || typeof ttl !== 'object') return null;
    const parent = toPositiveInt(ttl.parent);
    if (!parent) return null;
    const m = RECURSIVE_DEPS_RE.exec(String(ttl.authorized_by || ''));
    if (!m || Number(m[1]) !== parent) return null;
    return parent;
}

module.exports = {
    filterSplitChildren,
    parentOfSplitChild,
    // Exportado para tests.
    toPositiveInt,
};
