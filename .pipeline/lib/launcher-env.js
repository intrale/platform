// Copyright (c) 2026 Leonel Larreta
// SPDX-License-Identifier: LicenseRef-Proprietary

'use strict';

/**
 * #7636 · CA-7 — ALCANCE: este módulo arma el env de los SERVICIOS DE
 * CONFIANZA del pipeline (servicios, brazos, scripts propios del Pulpo), NO el
 * de los agentes LLM. El env de un agente LLM lo arma `build-child-env.js`
 * (`buildChildEnv` con scopes por rol/fase, o `buildMinimalCliEnv` para los
 * jueces/resúmenes), y con `pipeline.env_isolation_enabled: true` se verifica
 * con `assertChildEnvMinimal`. Nada de acá cambia ese contrato.
 *
 * #7112 · CA-6 / CA-7.2 — ENV QUE UN LANZADOR ENTREGA A SUS HIJOS.
 *
 * Dos piezas, una por extremo de la cadena de declaración de ambiente:
 *
 * 1. `declararRaiz(processEnv)` — para los entrypoints que un humano o el SO
 *    ejecutan y que no tienen a nadie arriba que declare por ellos:
 *    `restart.js`, `rollback.js` (emergencia: lo corre el operador a mano o lo
 *    spawnea restart.js ya declarado), `quota-snapshot-scheduler.js` como main
 *    (tarea programada de Windows, `scripts/register-quota-snapshot-task.ps1`),
 *    `delivery.js` como main (CLI manual del skill `/delivery` en la sesión
 *    interactiva del operador; #7112 rebote rev-3, G1), y los `.ps1` de tareas
 *    programadas — `watchdog.ps1`, `watchdog-supervisor.ps1`, `launch.ps1` —
 *    que lo hacen en PowerShell con el mismo contrato. Sólo ahí
 *    es legítimo el literal `productivo`, y sólo si la variable NO venía seteada
 *    (`??=`): #7111 puede lanzar un pipeline de pruebas declarando `pruebas`
 *    explícito y este helper lo respeta. Esa declaración fija sólo el MODO: el
 *    DIRECTORIO de pruebas viaja por `PIPELINE_DIR_OVERRIDE` (lo emite
 *    `provision-test-env --print-env`); `PIPELINE_REPO_ROOT` nunca lo aporta en
 *    pruebas (SEC-9 estricto de `pipeline-env`). Un módulo cargado por un test
 *    (no main) NUNCA declara: cae al dir del runner o falla ruidoso.
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
