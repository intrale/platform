'use strict';

// =============================================================================
// scratch-dirs.js — Predicado compartido: "¿este directorio es un scratchpad
// de agente?" (#6190)
//
// POR QUE EXISTE
// --------------
// Varios guards estructurales barren el arbol de `.pipeline/` buscando
// ofensores en codigo de PRODUCCION (`config-resolver-guard`, el barrido de
// lectores de `secrets-manifest`, el guard de productores de dropfiles de
// #6226). Cada uno traia su PROPIA lista hardcodeada de directorios a saltear,
// y las tres listas estaban desincronizadas entre si:
//
//   - `config-resolver-guard.test.js` salteaba `_tmp` (con el comentario
//     "son worktrees de agentes (copias del repo)") pero no `tmp5173`.
//   - `secrets-manifest.js` salteaba `_tmp` (documentado como "el scratchpad
//     de los agentes") pero no `tmp-review-5217`.
//   - `dropfile-productores-6226.test.js` no salteaba ninguno de los dos.
//
// Consecuencia observada: cualquier agente que dejaba una copia del repo bajo
// `.pipeline/_tmp/<algo>/` o un scratchpad `.pipeline/tmp-review-<issue>/`
// ponia en rojo guards de issues COMPLETAMENTE AJENOS, porque el barrido
// encontraba "ofensores" dentro de codigo que ni siquiera es del repo. Eso fue
// exactamente lo que freno a #6190: 17 tests en rojo, 0 causados por el codigo
// del issue.
//
// La intencion de excluir scratchpads ya existia en 2 de los 3 guards; lo que
// faltaba era UNA sola definicion de que cuenta como scratchpad. Este modulo es
// esa definicion: fuente unica, sin estado, sin `fs`, sin red.
//
// CONVENCION RECONOCIDA
// ---------------------
// Los agentes crean scratchpads en la raiz de `.pipeline/` con dos formas:
//   - `_tmp/`            — scratchpad compartido (parcialmente commiteado)
//   - `tmp*`             — `tmp5173`, `tmp-5351`, `tmp-review-5245`,
//                          `tmp-po-5641`, `tmp-ux-5242`, `tmp-ruleset`, ...
//
// Verificado contra el arbol trackeado: dentro de las raices que estos guards
// barren (`.pipeline/`, `qa/`) NO existe ningun directorio de produccion cuyo
// nombre empiece con `tmp`. El unico `tmp/` trackeado del repo es
// `.claude/tmp/`, que queda fuera de esas raices. Por eso el prefijo alcanza y
// no hace falta enumerar sufijos (una lista de sufijos se desincronizaria de
// nuevo, que es el bug que este modulo viene a cerrar).
// =============================================================================

// Directorios que nunca son codigo de produccion, mas alla del scratchpad:
// dependencias, salidas y superficie de test.
const NON_PRODUCTION_DIRS = Object.freeze([
    'node_modules',
    '__tests__',
    '.git',
]);

/**
 * ¿El nombre de directorio corresponde a un scratchpad de agente?
 *
 * Recibe el NOMBRE del directorio (`entry.name`), no una ruta completa: los
 * barridos son recursivos y deciden por nivel.
 *
 * @param {string} name nombre del directorio
 * @returns {boolean}
 */
function isScratchDirName(name) {
    if (typeof name !== 'string' || name === '') return false;
    if (name === '_tmp') return true;
    return name.startsWith('tmp');
}

/**
 * ¿Hay que saltear este directorio en un barrido de codigo de produccion?
 *
 * Une el scratchpad de agente con los directorios que nunca son produccion.
 * Los guards pueden sumar sus propias exclusiones ademas de esta.
 *
 * @param {string} name nombre del directorio
 * @returns {boolean}
 */
function isNonProductionDirName(name) {
    if (typeof name !== 'string' || name === '') return false;
    if (NON_PRODUCTION_DIRS.includes(name)) return true;
    return isScratchDirName(name);
}

module.exports = {
    NON_PRODUCTION_DIRS,
    isScratchDirName,
    isNonProductionDirName,
};
