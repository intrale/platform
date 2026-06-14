// =============================================================================
// evidence-cache.js — Memoizador TTL en memoria para shell-outs de git/gh
// del verificador adversarial Sherlock (#3924, EP2-H4).
//
// PROBLEMA QUE RESUELVE
// ---------------------
// El verificador independiente (`sherlock-independent-verifier.js`) y el árbitro
// canónico (`canonical-facts.js`) shellean `git`/`gh` con un presupuesto de
// evidencia. En Windows, con git/gh "fríos", muchas verificaciones cercanas
// repiten el MISMO comando (mismos args normalizados, mismo cwd) y agotan el
// presupuesto → `not_verifiable`. Y `not_verifiable` nunca contradice, así que
// Sherlock verifica menos de lo que aparenta.
//
// SOLUCIÓN
// --------
// Envolver las impls inyectables (`defaultGitImpl`/`defaultGhApi`) con un
// memoizador TTL en memoria. Dos verificaciones cercanas que ejecutan el mismo
// comando reusan el resultado, liberando presupuesto para fuentes nuevas.
//
// INVARIANTES DE SEGURIDAD (REQ-SEC-1..5 de `security`, ver issue #3924)
// ----------------------------------------------------------------------
//   - REQ-SEC-1: la clave deriva SOLO de `(bin, cwd, args[])` ya normalizados.
//     NUNCA se interpola texto crudo del claim/systemState. Incluye `cwd` para
//     no colisionar entre worktrees/repos distintos (anti cache-poisoning).
//   - REQ-SEC-2: TTL corto (≤ 5–10 s, default 7 s). SOLO memoria, NUNCA persiste
//     a disco. Vida ≤ proceso. Mitiga caché stale enmascarando fraude (A08).
//   - REQ-SEC-3: fail-open hacia ejecución LIVE ante miss o error de la capa de
//     caché. La caché JAMÁS produce un verdict por sí sola. Cachea SOLO
//     resultados completos y exitosos (`res.ok === true`); nunca timeout,
//     `not_verifiable` o parciales (propagaría lo que CA-3 busca reducir).
//   - REQ-SEC-4: caché acotada — `maxEntries` con evicción LRU + expiración TTL
//     (anti-DoS de memoria). El `maxBuffer` de execFile lo conserva la impl real.
//
// CONTRATO
// --------
// Misma firma que las impls reales: `({ args, cwd, timeoutMs }) → {ok,stdout,code}`.
// Drop-in: el wrapper es transparente para el caller.
// =============================================================================
'use strict';

// REQ-SEC-2 — TTL corto, scope de ráfaga. Entre 5 y 10 s: dedup de
// verificaciones cercanas sin arriesgar evidencia stale (merge/push/cierre de PR
// cambian el estado git/gh entre verificaciones lejanas).
const DEFAULT_TTL_MS = 7000;

// REQ-SEC-4 — cota anti-DoS de memoria. Evicción LRU al superar el máximo.
const DEFAULT_MAX_ENTRIES = 128;

// -----------------------------------------------------------------------------
// makeCachedImpl — envuelve una impl real con memoización TTL + LRU.
//
// @param realImpl  función async `({args,cwd,timeoutMs}) → {ok,stdout,code}`.
// @param opts.ttlMs       TTL en ms (default DEFAULT_TTL_MS).
// @param opts.maxEntries  máximo de entradas en memoria (default DEFAULT_MAX_ENTRIES).
// @param opts.now         reloj inyectable para tests (default Date.now).
// @param opts.bin         etiqueta del binario ('git' | 'gh') — parte de la key
//                         para que comandos de binarios distintos no colisionen.
// @returns función async con el mismo contrato que realImpl.
// -----------------------------------------------------------------------------
function makeCachedImpl(realImpl, opts = {}) {
    if (typeof realImpl !== 'function') {
        throw new TypeError('makeCachedImpl: realImpl debe ser una función');
    }
    const ttlMs = Number.isFinite(opts.ttlMs) ? opts.ttlMs : DEFAULT_TTL_MS;
    const maxEntries = Number.isFinite(opts.maxEntries) && opts.maxEntries > 0
        ? Math.floor(opts.maxEntries)
        : DEFAULT_MAX_ENTRIES;
    const now = typeof opts.now === 'function' ? opts.now : Date.now;
    const bin = opts.bin == null ? '' : String(opts.bin);

    // Map mantiene orden de inserción → lo usamos para LRU: en cada hit se
    // re-inserta la entrada al final; la evicción borra la primera (más vieja).
    const store = new Map(); // key → { at, value }

    // REQ-SEC-1 — key derivada SOLO de (bin, cwd, args). `args` ya viene
    // normalizado por las allowlists de los callers (issueNumber entero, SHA_RE,
    // pid/run-id enteros). No se interpola texto crudo acá.
    function keyOf(params) {
        const cwd = params && params.cwd != null ? String(params.cwd) : '';
        const args = params && Array.isArray(params.args) ? params.args : [];
        return JSON.stringify([bin, cwd, args]);
    }

    async function cachedImpl(params) {
        // REQ-SEC-3 — cualquier fallo de la CAPA de caché (cómputo de key,
        // operaciones de Map) cae a ejecución live. La caché nunca decide sola.
        let key;
        try {
            key = keyOf(params);
        } catch {
            return realImpl(params); // fail-open
        }

        try {
            const hit = store.get(key);
            if (hit && (now() - hit.at) < ttlMs) {
                // LRU touch: mover al final reinsertando.
                store.delete(key);
                store.set(key, hit);
                return hit.value;
            }
            // Entrada vencida: descartarla explícitamente.
            if (hit) store.delete(key);
        } catch {
            return realImpl(params); // fail-open ante error de la capa de caché
        }

        // Miss (o expiry) → ejecución LIVE. La impl real es fail-open por
        // contrato (errores → {ok:false}); si aun así lanzara, propagamos el
        // resultado live de un reintento en vez de fabricar un verdict.
        let res;
        try {
            res = await realImpl(params);
        } catch {
            return realImpl(params); // REQ-SEC-3: nunca un verdict cacheado
        }

        // REQ-SEC-3 — cachear SOLO resultados completos y exitosos. timeout /
        // not_verifiable / exit-code≠0 (ok:false) NO se cachean.
        if (res && res.ok === true) {
            try {
                store.set(key, { at: now(), value: res });
                // REQ-SEC-4 — evicción LRU: si excede el máximo, borrar la más
                // vieja (primera clave del Map).
                while (store.size > maxEntries) {
                    const oldest = store.keys().next().value;
                    store.delete(oldest);
                }
            } catch {
                // Un fallo al cachear no debe afectar el resultado live.
            }
        }
        return res;
    }

    // Helpers de introspección para tests / debugging (no usados en runtime).
    cachedImpl._cacheSize = () => store.size;
    cachedImpl._cacheClear = () => store.clear();

    return cachedImpl;
}

module.exports = {
    makeCachedImpl,
    DEFAULT_TTL_MS,
    DEFAULT_MAX_ENTRIES,
};
