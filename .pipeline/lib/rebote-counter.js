// .pipeline/lib/rebote-counter.js
// =============================================================================
// Contador de rebotes por issue (#6296, SEC-E — extraído de `pulpo.js`).
//
// POR QUÉ EXISTE
// --------------
// El conteo de `rebote_numero` vivía INLINE dentro del loop de barrido de
// `pulpo.js`, inalcanzable desde cualquier otro módulo. #6296 agrega un segundo
// productor de rebotes (el dep `rebote` del reconciler de fases varadas) y un
// contador paralelo es tan malo como no contar: abre exactamente el loop
// infinito que el circuit breaker existe para cerrar.
//
// Una sola función, dos consumidores: `pulpo.js` (barrido) y
// `stuck-reconciler-deps.js` (self-healing).
//
// SEMÁNTICA (preservada tal cual del original, no es refactor de comportamiento)
// -----------------------------------------------------------------------------
//  - Sólo cuentan contra el breaker genérico los rebotes de tipo `codigo`
//    (`rebote_tipo` ausente ⇒ `codigo`, criterio #2 de #2317).
//  - Los de tipo `infra` van a un contador SEPARADO (`rebote_numero_infra`) con
//    su propio cap duro (#2335 CA5-CA6).
//  - `diffHashPrevio` es el del rebote MÁS RECIENTE (el de mayor número), no el
//    último leído: el orden de `readdirSync` no es semántico.
//  - Se barren `pendiente`/`trabajando`/`procesado` de la fase destino. El IO
//    entra por parámetros → testeable sin FS real.
// =============================================================================

'use strict';

const path = require('path');

const ESTADOS_BARRIDOS = ['pendiente', 'trabajando', 'procesado'];

/**
 * Cuenta los rebotes previos de un issue en la fase de rechazo.
 *
 * @param {object}   args
 * @param {object}   args.fs            módulo fs (inyectable)
 * @param {Function} args.fasePath      (pipeline, fase) → path de la fase
 * @param {Function} args.readYamlSafe  (filepath) → objeto (nunca lanza)
 * @param {string}   args.pipeline
 * @param {string}   args.faseRechazo   fase destino del rebote (ej. `dev`)
 * @param {string|number} args.issue
 * @returns {{reboteCount:number, reboteInfraCount:number, diffHashPrevio:string|null, prevMotivos:string[]}}
 */
function contarRebotes(args = {}) {
    const { fs, fasePath, readYamlSafe, pipeline, faseRechazo, issue } = args;

    let reboteCount = 0;
    let reboteInfraCount = 0;
    let diffHashPrevio = null;
    const prevMotivos = [];

    // Fail-closed hacia "no sé": sin las piezas de IO no se puede contar, y
    // devolver ceros haría que el caller crea que nunca hubo rebotes. El caller
    // NO debe rebotar con un conteo que no pudo hacer; por eso `contable: false`.
    if (!fs || typeof fasePath !== 'function' || typeof readYamlSafe !== 'function'
        || !pipeline || !faseRechazo || issue == null) {
        return { reboteCount, reboteInfraCount, diffHashPrevio, prevMotivos, contable: false };
    }

    const prefijo = String(issue) + '.';
    for (const estado of ESTADOS_BARRIDOS) {
        const dir = path.join(fasePath(pipeline, faseRechazo), estado);
        let entries;
        try { entries = fs.readdirSync(dir); } catch { continue; }
        for (const f of entries) {
            if (!f.startsWith(prefijo)) continue;
            let data;
            try { data = readYamlSafe(path.join(dir, f)) || {}; } catch { continue; }
            const tipoPrevio = data.rebote_tipo || 'codigo';
            if (tipoPrevio === 'infra') {
                if (data.rebote_numero_infra && data.rebote_numero_infra > reboteInfraCount) {
                    reboteInfraCount = data.rebote_numero_infra;
                }
                continue; // NO cuenta contra el breaker genérico
            }
            if (data.rebote_numero && data.rebote_numero > reboteCount) {
                reboteCount = data.rebote_numero;
                diffHashPrevio = data.diff_hash_previo || diffHashPrevio;
            }
            if (data.motivo_rechazo) prevMotivos.push(String(data.motivo_rechazo));
        }
    }

    return { reboteCount, reboteInfraCount, diffHashPrevio, prevMotivos, contable: true };
}

/**
 * #4707 CA-4 (movido acá por #6296) — cap del circuit breaker de rebotes con
 * clamp fail-closed. Un valor inválido (0, negativo, NaN, string, Infinity) o
 * ausente cae al default 3. Cota superior sana de 20 para que un cap enorme de
 * config no neutralice el breaker (DoS de cuota).
 *
 * Vivía en `pulpo.js`. Se mueve al mismo módulo que el contador porque el dep
 * `rebote` del reconciler necesita CONTAR y CORTAR con exactamente los mismos
 * números que el barrido: un cap distinto en cada camino es un breaker que no
 * corta.
 *
 * @param {object} config — objeto de config del pipeline (loadConfig()).
 * @returns {number} entero en [1, 20].
 */
function resolveRebotesMax(config) {
    const raw = config && config.circuit_breaker && config.circuit_breaker.rebotes_max;
    const n = Number(raw);
    if (!Number.isInteger(n) || !Number.isFinite(n) || n < 1) return 3; // fail-closed
    return Math.min(n, 20); // cota superior sana — un cap enorme no desactiva el breaker
}

module.exports = { contarRebotes, resolveRebotesMax, ESTADOS_BARRIDOS };
