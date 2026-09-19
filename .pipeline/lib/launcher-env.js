'use strict';

/**
 * #7112 · CA-6 / CA-7.2 — ENV QUE UN LANZADOR ENTREGA A SUS HIJOS.
 *
 * Dos piezas, una por extremo de la cadena de declaración de ambiente:
 *
 * 1. `declararRaiz(processEnv)` — para los TRES entrypoints que un humano o el
 *    SO ejecutan y que no tienen a nadie arriba que declare por ellos:
 *    `restart.js`, `watchdog.ps1` y `launch.ps1` (los `.ps1` lo hacen en
 *    PowerShell, mismo contrato). Sólo ahí es legítimo el literal `productivo`,
 *    y sólo si la variable NO venía seteada (`??=`): #7111 puede lanzar un
 *    pipeline de pruebas declarando `pruebas` explícito y este helper lo respeta.
 *
 * 2. `envDeLanzador({ processEnv, repoRoot, extra })` — para todo proceso que
 *    un lanzador ya declarado spawnea (servicios, brazos, agentes): la
 *    declaración va EXPLÍCITA con el modo que el propio lanzador resolvió
 *    (`pipelineEnv.resolve(processEnv).modo`), nunca la heredada ni un literal,
 *    y siempre acompañada de `PIPELINE_REPO_ROOT` (CA-7.3). Delega en
 *    `build-child-env.conDeclaracionExplicita`, que es la misma regla que aplica
 *    el launcher de agentes en sus dos caminos.
 *
 * @module launcher-env
 */

const pipelineEnv = require('./pipeline-env');
const { conDeclaracionExplicita } = require('./build-child-env');

/**
 * Declara `productivo` si nadie declaró nada. Muta `processEnv` a propósito:
 * es el env del proceso que va a spawnear y del que heredan sus hijos.
 *
 * @param {object} [processEnv=process.env]
 * @returns {{declarado: boolean, valor: string}} `declarado: true` si esta
 *   llamada puso el valor; `false` si ya venía (se respeta tal cual).
 */
function declararRaiz(processEnv = process.env) {
    const actual = processEnv[pipelineEnv.ENV_AMBIENTE];
    if (typeof actual === 'string' && actual.trim()) {
        return { declarado: false, valor: actual };
    }
    processEnv[pipelineEnv.ENV_AMBIENTE] = pipelineEnv.VALOR_PRODUCTIVO;
    return { declarado: true, valor: pipelineEnv.VALOR_PRODUCTIVO };
}

/**
 * Env para un hijo del lanzador.
 *
 * @param {{processEnv?: object, repoRoot: string, extra?: object}} p
 * @returns {object} copia nueva: `processEnv` no se muta.
 */
function envDeLanzador({ processEnv = process.env, repoRoot, extra = {} } = {}) {
    if (typeof repoRoot !== 'string' || !repoRoot.trim()) {
        throw new TypeError('[launcher-env] envDeLanzador: falta `repoRoot` (raíz del repo principal, CA-7.3)');
    }
    return conDeclaracionExplicita(
        { ...processEnv, PIPELINE_REPO_ROOT: repoRoot, ...extra },
        processEnv,
    );
}

module.exports = { declararRaiz, envDeLanzador };
