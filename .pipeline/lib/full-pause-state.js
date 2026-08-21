// =============================================================================
// #5179 CA-6b — Lectura FAIL-CLOSED del halt total (`mode === 'paused'`).
//
// Vive en su propio módulo por dos razones concretas:
//
//   1. `dashboard.js` y `restart.js` necesitan exactamente la misma decisión.
//      Duplicar el try/catch en los dos archivos hace que la próxima corrección
//      se aplique en uno solo — y el que quede atrás vuelve a ser fail-open sin
//      que nada avise.
//   2. Ninguno de esos dos archivos es importable desde un test: no exportan
//      nada y arrancan el servidor / ejecutan el switch de `process.argv` al ser
//      requeridos. Sin este módulo, el camino degradado no tiene forma de
//      probarse, y un fail-closed no verificado es una intención, no una
//      garantía.
//
// POR QUÉ FAIL-CLOSED
// -------------------
// Si el envoltorio no carga, o `getDispatchState()` tira (estado corrupto,
// permisos, disco), la respuesta es `true` (PAUSADO). Degradar a `false` sería
// reportar "en marcha" con el estado indeterminado: exactamente el fail-open que
// #6080 abrió contra `dashboard-slices.js`. El costo de los dos errores no es
// simétrico — decir "pausado" de más molesta; decir "en marcha" de más hace que
// el operador crea que frenó el pipeline cuando no lo frenó, y que un /restart
// suelte una pausa vigente (#5399).
// =============================================================================
'use strict';

/**
 * ¿Hay halt total activo?
 *
 * @param {{ stateMod?: object }} [opts] — `stateMod` es el seam de inyección que
 *        usan los tests para forzar el camino degradado.
 * @returns {boolean} `true` si está pausado O si el estado no se pudo determinar.
 */
function isFullPauseActive(opts = {}) {
    try {
        const stateMod = opts.stateMod || require('./operational-state');
        return stateMod.getDispatchState().mode === 'paused';
    } catch {
        return true;   // indeterminado ⇒ fail-closed (jamás "en marcha")
    }
}

module.exports = { isFullPauseActive };
