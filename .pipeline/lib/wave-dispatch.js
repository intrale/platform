'use strict';

// =============================================================================
// wave-dispatch.js — #4436
//
// Realineación reductiva de la allowlist a la ola ACTIVA (re-kick / relanzar el
// despacho). Extraído de `pulpo.js:realignAllowlistToActiveWave` (#4350) a un
// módulo `lib/` reusable y testeable para que la ventana Roadmap del dashboard
// (#4436) pueda "relanzar el despacho de la ola activa" sin duplicar lógica ni
// bajar a la consola. `pulpo.js` ahora delega en este módulo (single source of
// truth del algoritmo de realineación).
//
// Carve-out SEC-1..SEC-6 (heredado de #4350): la realineación SOLO reduce basura
// y repuebla con los issues ABIERTOS de una ola ya promovida atómicamente. Nunca
// otorga permisos nuevos ajenos. El walk recursivo (hijos/deps) y el filtro de
// cerrados corren acá, con el predicado `isClosed` inyectado (title-cache, sin
// GitHub en el hot path); `waves.js` jamás ve la red. La mutación pasa SIEMPRE
// por el gate auditado de `partial-pause` (authorizedBy válido → habilita los
// removals de cerrados/ajenos).
// =============================================================================

const partialPause = require('./partial-pause');

/**
 * Realinea reductivamente la allowlist a la ola activa (relanzar despacho).
 *
 * @param {Object} [opts]
 * @param {function(number):boolean} [opts.isClosed] — predicado de "issue cerrado"
 *        (típicamente el title-cache local). Si falta, ningún issue se descarta
 *        por cerrado (fail-safe SEC-4: indeterminado NO se remueve).
 * @param {Object} [opts.desync] — `{ added, removed }` de una divergencia previa,
 *        sólo para trazabilidad en la justificación. Opcional (el dashboard no lo
 *        provee: re-kick manual sin divergencia detectada).
 * @param {string} [opts.authorizedBy='wave-promote'] — autoría validada vs enum.
 *        El dashboard pasa `'dispatch:dashboard'`; el Pulpo `'wave-promote'`.
 * @param {string} [opts.source='wave-promote:realign'] — origen de la mutación.
 * @param {string} [opts.justification] — razón libre (sanitizada por el audit).
 * @returns {{ ok: boolean, reason?: string, msg?: string, allowlist?: number[], activeWave?: number }}
 */
function realignActiveWaveDispatch(opts = {}) {
    const isClosed = typeof opts.isClosed === 'function' ? opts.isClosed : null;
    const desync = opts.desync || null;
    const authorizedBy = opts.authorizedBy || 'wave-promote';
    const source = opts.source || 'wave-promote:realign';

    const waves = require('./waves');
    const recursivePromote = require('./allowlist-recursive-promote');

    const active = waves.getActiveWave();
    if (!active || !Array.isArray(active.issues)) {
        return { ok: false, reason: 'no_active_wave' };
    }

    // 1. Semilla = issues abiertos (no completados) de la ola activa, enteros
    //    positivos (SEC-3).
    const seed = active.issues
        .filter((i) => i && i.status !== 'completed')
        .map((i) => Number(i.number))
        .filter((n) => Number.isInteger(n) && n > 0);

    // 2. Expandir hijos/deps recursivos (walk puro, sin TTL) usando el grafo
    //    dependencies[] de waves.json (filesystem propio). Excluye cerrados con
    //    fail-safe: indeterminado NO se remueve (SEC-4).
    const getDeps = (n) => { try { return waves.getBlockingIssues(n); } catch { return []; } };
    const expanded = recursivePromote.expandRecursiveOpenIssues({ seedIssues: seed, isClosed, getDeps });

    // Fail-safe: NUNCA vaciar la allowlist por un realineo (podría congelar el
    // pipeline). Set vacío → no tocar, dejar traza para el humano.
    if (expanded.length === 0) {
        return { ok: false, reason: 'empty_expansion' };
    }

    // 3. Mutación SOLO por el gate auditado (SEC-2). El authorizedBy válido
    //    habilita los removals de los cerrados/ajenos.
    const res = partialPause.setPartialPause(expanded, {
        source,
        authorizedBy,
        justification: opts.justification || (
            `Realineación reductiva a ola ${active.number} (#4350/#4436). ` +
            `extras_removidos=${JSON.stringify((desync && desync.added) || [])} ` +
            `faltantes_repuestos=${JSON.stringify((desync && desync.removed) || [])}`
        ),
    });
    if (res && res.rejected) {
        return { ok: false, reason: 'gate_rejected', msg: res.msg };
    }
    return { ok: true, allowlist: expanded, activeWave: active.number };
}

module.exports = { realignActiveWaveDispatch };
