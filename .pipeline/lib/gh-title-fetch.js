// =============================================================================
// gh-title-fetch.js — Clasificación de respuestas/errores de `gh` al poblar el
// issue-title-cache (#4566).
//
// PROBLEMA (incidente 2026-07-08): un hipo transitorio de `gh` (rate-limit / red
// / timeout) hacía que el handler de error confundiera "el comando gh falló" con
// "el issue no existe" y persistiera cada issue como `{ notFound: true }` — una
// negative-cache PERMANENTE (title-cache-freshness nunca la re-consultaba). Un
// fallo de 3 segundos envenenó los 31 issues de la ola y clavó el avance en 12%.
//
// SOLUCIÓN: estas funciones PURAS distinguen tres estados por issue:
//   - GOOD        → hay datos (title/state/labels) → se cachea.
//   - notFound    → 404 GENUINO (issue borrado): evidencia real de NOT_FOUND.
//   - transient   → error transitorio (rate-limit/red/timeout/body ilegible):
//                   NO se envenena. Se conserva la entrada previa buena; si no
//                   hay, se marca `{ transientError: true }` que SÍ se reintenta.
//
// Se comparten entre el path sync (`fetchIssueTitles`) y el async
// (`fetchIssueTitlesAsync`) de dashboard.js para que el fix cubra AMBOS (#4128).
// =============================================================================

'use strict';

// Evidencia de 404 GENUINO en GraphQL error.type / stderr de `gh issue view`.
const NOT_FOUND_RE = /NOT_FOUND|Could not resolve to an? (Issue|node)/i;
// Errores transitorios conocidos (rate-limit / red / timeout / 5xx). Un error
// que matchea esto NUNCA debe interpretarse como 404 aunque también mencione algo.
// #4732 — `ENOENT` (binario `gh` ausente en el PATH) debe clasificarse como
// transitorio: un spawn fallido NO es evidencia de que el issue no exista. Sin
// esto, "gh no está en el PATH" caía por la rama de 404 genuino y envenenaba el
// caché con `notFound`. Se agregan `ENOENT` y `spawn <cmd> ENOENT`.
const TRANSIENT_RE = /RATE_LIMITED|rate limit|timeout|timed out|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|ENOENT|spawn\s+\S+\s+ENOENT|EAI_AGAIN|network|socket hang up|\b50[234]\b|Bad gateway|Service unavailable|Internal Server Error|abuse detection/i;

/**
 * Construye la entrada de cache "buena" a partir del nodo de issue devuelto por
 * GraphQL o por `gh issue view --json`.
 * @param {object} val - nodo con { number|title, state, labels }
 * @param {number} now - epoch ms
 */
function buildGoodEntry(val, now) {
    // labels puede venir como { nodes: [...] } (GraphQL) o [...] (gh issue view --json)
    const rawLabels = Array.isArray(val.labels) ? val.labels : (val.labels?.nodes || []);
    return {
        title: val.title || '',
        state: val.state, // #3905 — OPEN | CLOSED
        labels: rawLabels.map(l => (typeof l === 'string' ? l : l.name)).filter(Boolean),
        fetchedAt: now,
    };
}

/**
 * Parsea el stdout de `gh api graphql`, tolerante a exit≠0 (gh imprime el body
 * en stdout aunque la respuesta contenga `errors` GraphQL).
 *
 * @param {string} out - stdout crudo del comando
 * @returns {{ok:boolean, repo:(object|null), notFoundAliases:Set<string>, transient:boolean}}
 *   - ok:false  → body ilegible (fallo real del comando) → tratar todo como transitorio.
 *   - transient → hubo error top-level no-404 (rate-limit, etc.) o `repository:null`.
 *   - notFoundAliases → aliases (`i0`,`i1`,…) con evidencia de 404 GENUINO.
 */
function parseGraphqlBody(out) {
    let parsed = null;
    try { parsed = out ? JSON.parse(out) : null; } catch { parsed = null; }
    if (!parsed || typeof parsed !== 'object') {
        return { ok: false, repo: null, notFoundAliases: new Set(), transient: true };
    }
    const repo = parsed.data && typeof parsed.data === 'object' ? parsed.data.repository : undefined;
    const errors = Array.isArray(parsed.errors) ? parsed.errors : [];
    const notFoundAliases = new Set();
    let transient = false;
    for (const er of errors) {
        const type = String(er && er.type || '');
        const msg = String(er && er.message || '');
        const text = type + ' ' + msg;
        const p = Array.isArray(er && er.path) ? er.path : [];
        const alias = p[p.length - 1];
        if (NOT_FOUND_RE.test(text) && !TRANSIENT_RE.test(text)) {
            if (alias) notFoundAliases.add(String(alias));
        } else {
            // Cualquier otro error top-level (RATE_LIMITED, INTERNAL, etc.) = transitorio.
            transient = true;
        }
    }
    // `repository: null` (típico de RATE_LIMITED / auth transitorio a nivel raíz)
    // envenenaba todo el batch antes de este fix. Es transitorio, no un 404.
    if (repo === null) transient = true;
    return { ok: true, repo: repo || null, notFoundAliases, transient };
}

/**
 * Aplica el resultado del batch GraphQL al cache SIN envenenar en errores
 * transitorios. Muta `cache`.
 *
 * @param {object} cache - mapa id → entrada (contiene entradas previas)
 * @param {Array<string|number>} batch - ids del batch, en el mismo orden que los aliases i0..iN
 * @param {object} body - salida de parseGraphqlBody
 * @param {number} now - epoch ms
 */
function applyGraphqlBatch(cache, batch, body, now) {
    const { repo, notFoundAliases, transient } = body;
    batch.forEach((id, i) => {
        const alias = 'i' + i;
        const key = String(id);
        const val = repo ? repo[alias] : undefined;
        if (val && val.number) {
            cache[key] = buildGoodEntry(val, now);
        } else if (notFoundAliases.has(alias) && !transient) {
            // 404 GENUINO: sólo si NO hubo error transitorio global en la respuesta.
            cache[key] = { title: '', labels: [], notFound: true, fetchedAt: now };
        } else {
            // Transitorio: preservar la entrada previa buena; si no hay usable,
            // marcar transientError (freshness lo reintenta).
            markTransient(cache, key, now);
        }
    });
}

/**
 * Clasifica el error de un `gh issue view` 1×1 en el fallback.
 * @param {Error} err - error de exec (puede traer .stderr / .message)
 * @returns {'notfound'|'transient'}
 */
function classify1x1Error(err) {
    const stderr = String(err && err.stderr || '');
    const msg = String(err && err.message || '');
    const stdout = String(err && err.stdout || '');
    const text = stderr + '\n' + msg + '\n' + stdout;
    // Sólo 404 genuino si hay evidencia explícita y NINGÚN indicio transitorio.
    if (NOT_FOUND_RE.test(text) && !TRANSIENT_RE.test(text)) return 'notfound';
    return 'transient';
}

/**
 * Aplica el error de un fallback 1×1 al cache. Muta `cache`.
 * @param {object} cache
 * @param {string|number} id
 * @param {Error} err
 * @param {number} now
 */
function applyFallbackError(cache, id, err, now) {
    const key = String(id);
    if (classify1x1Error(err) === 'notfound') {
        cache[key] = { title: '', labels: [], notFound: true, fetchedAt: now };
    } else {
        markTransient(cache, key, now);
    }
}

/**
 * Marca una entrada como transitoria SIN pisar una entrada previa buena o un
 * 404 genuino previo. Sólo escribe transientError si no hay dato utilizable.
 */
function markTransient(cache, key, now) {
    const prev = cache[key];
    // Conservar entrada previa con datos reales (buena) o 404 genuino previo.
    if (prev && (prev.state !== undefined || prev.notFound)) return;
    cache[key] = {
        title: (prev && prev.title) || '',
        labels: (prev && prev.labels) || [],
        transientError: true,
        fetchedAt: now,
    };
}

module.exports = {
    NOT_FOUND_RE,
    TRANSIENT_RE,
    buildGoodEntry,
    parseGraphqlBody,
    applyGraphqlBatch,
    classify1x1Error,
    applyFallbackError,
    markTransient,
};
