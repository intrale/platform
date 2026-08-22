// =============================================================================
// ensure-npm-in-path.js — helper compartido para tests que invocan npm/node
//
// Contexto (rebote #4732):
// Cuando el pulpo corre como servicio Windows, su `process.env.PATH` puede no
// incluir el directorio de Node (`C:\Program Files\nodejs`, que contiene
// `npm.cmd`). Ese PATH stripped se hereda al child de `node --test` que
// spawnea el tester determinístico. Los tests del pipeline que hacen
// `execSync('npm ci ...')` o `spawnSync('npm', ...)` — ej. la demo del ciclo
// del kernel en `fixtures/demo/run-cycle.js` — fallan con
// `"npm" no se reconoce como un comando interno o externo`.
//
// Es la MISMA causa raíz que git en #2891 (ver `ensure-git-in-path.js`); este
// helper es su análogo para `npm`/`node`.
//
// Diseño:
//   1) Si `npm` ya resuelve con el env actual: no toca nada.
//   2) Si no: el proceso que corre ES node, así que su binario vive junto a
//      `npm`/`npm.cmd` (`path.dirname(process.execPath)`). Prependemos ese dir
//      al PATH. Solo prepende: si npm estaba accesible por otra ruta, sigue
//      funcionando.
//
// Expone DOS variantes (espejo de `ensure-git-in-path.js`):
//   - `ensureNpmInEnv(env)` muta el `env` recibido (para usar en spawn).
//   - `ensureNpmInProcessPath()` muta `process.env.PATH` (se llama una sola
//     vez al tope del archivo de tests, antes del primer `execSync('npm ...')`).
//
// IMPORTANTE: aplicando el fix dentro de los tests mismos (que corren desde el
// worktree del agente) NO dependemos de que el tester de `main` tenga el fix —
// resuelve el "deadlock" de la fase verificacion igual que el helper de git.
// =============================================================================

'use strict';

const path = require('path');
const { spawnSync } = require('child_process');

/**
 * Verifica si `npm --version` funciona con el env dado.
 * En Windows `npm` es `npm.cmd`, así que probamos con `shell: true` para que
 * el resolvedor del sistema encuentre el `.cmd` (idéntico a como lo invoca
 * `execSync('npm ci')`).
 * Retorna true si está disponible, false si falta.
 */
function npmWorks(env) {
    try {
        const probe = spawnSync('npm --version', {
            env, shell: true, windowsHide: true, encoding: 'utf8',
        });
        return probe.status === 0;
    } catch {
        return false;
    }
}

/**
 * Muta `env` prependiendo el directorio de Node (que contiene `npm`) al PATH
 * si `npm` no resuelve. Devuelve el mismo `env` (mutado).
 *
 * - Si npm ya funciona con el env actual: no toca nada.
 * - Si no: prepende `path.dirname(process.execPath)` (dir del binario node en
 *   ejecución), donde vive `npm`/`npm.cmd`.
 */
function ensureNpmInEnv(env) {
    if (!env) return env;
    if (npmWorks(env)) return env;

    const nodeBinDir = path.dirname(process.execPath);
    if (nodeBinDir) {
        env.PATH = `${nodeBinDir}${path.delimiter}${env.PATH || ''}`;
    }
    return env;
}

/**
 * Versión que muta `process.env` directamente.
 * Útil para invocar UNA SOLA VEZ al inicio de un archivo de tests, antes de
 * cualquier `execSync('npm ...')` que herede del proceso actual.
 *
 * Idempotente: llamadas subsecuentes son no-op si npm ya funciona.
 */
function ensureNpmInProcessPath() {
    ensureNpmInEnv(process.env);
}

module.exports = {
    ensureNpmInEnv,
    ensureNpmInProcessPath,
    npmWorks,
};
