// =============================================================================
// opstate-brazos-fail-closed-5113.test.js — #5113 rev-12
//
// QUÉ PRUEBA — Y POR QUÉ ASÍ
// --------------------------
// R-5 · `brazoIntake` quedaba FAIL-OPEN bajo degradación del estado operativo.
// El issue endureció los dos gates PUROS (`isIssueAllowedInState` /
// `isSkillAllowedInState`) y no revisó a los consumidores que miran sólo `mode`.
// Con el store caído el modo colapsa a `'running'` POR DISEÑO (el estado local
// stale es una autorización revocada, no un dato viejo), así que `allowlistSet`
// quedaba `null` = "sin filtro" y el intake ingería el backlog `Ready` COMPLETO:
// workfiles en `pendiente/` y mutaciones de labels en GitHub, sin saber cuál es
// la ola vigente. Es la forma de #5060 una capa más arriba.
//
// R-6 · El loop de despacho leía el estado UNA VEZ POR CANDIDATO, teniendo el
// snapshot del tick ya tomado en `ppStateForPriority`. En modo remoto cada
// lectura es un `spawnSync` BLOQUEANTE de la AWS CLI (`timeout: 20000`) y las
// lecturas degradadas NUNCA se memoizan: con la cola real (~200 pendientes) eso
// son hasta 200 spawns por tick, el tick supera los 180 s del watchdog de
// liveness y el Pulpo entra en el bucle de muerte documentado en `pulpo.js`.
//
// POR QUÉ ASÍ — el brazo se EXTRAE del fuente vigente de `pulpo.js` y se monta
// con dependencias dobles (mismo patrón que `credential-retry-orphan-guard-5796`).
// Una réplica del bloque a mano sería ciega a lo que hace el brazo real: si
// alguien saca el guard o lo pone después de un efecto, este test tiene que
// fallar.
//
// Ejecución: `node --test .pipeline/tests/opstate-brazos-fail-closed-5113.test.js`
// =============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const PULPO_PATH = path.join(__dirname, '..', 'pulpo.js');
const PULPO_SRC = fs.readFileSync(PULPO_PATH, 'utf8');

/**
 * Extrae el fuente de una función top-level de `pulpo.js`. El corte se ancla en
 * el primer `\n}` en columna 0: dentro de la función todo está indentado.
 */
function fuenteDeFuncion(nombre) {
    const firma = new RegExp(`(?:^|\\n)(?:async )?function ${nombre}\\(`);
    const m0 = firma.exec(PULPO_SRC);
    assert.ok(m0, `No se encontró \`function ${nombre}(\` en pulpo.js — ¿cambió de nombre?`);
    const inicio = m0.index + (m0[0].startsWith('\n') ? 1 : 0);
    const m = /\r?\n\}\r?\n/.exec(PULPO_SRC.slice(inicio));
    assert.ok(m, `No se encontró el cierre de \`${nombre}\`.`);
    return PULPO_SRC.slice(inicio, inicio + m.index + m[0].length);
}

/**
 * Despoja comentarios: el conteo de llamadas tiene que mirar CODIGO. Los
 * comentarios de este mismo fix nombran `getPipelineMode()` en prosa, y contar
 * esas menciones convertiria al test en un detector de documentacion.
 */
function sinComentarios(src) {
    return String(src)
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(new RegExp('^[ \t]*//[^\r\n]*', 'gm'), '');
}

// -----------------------------------------------------------------------------
// R-5 · brazoIntake
// -----------------------------------------------------------------------------

/**
 * Monta el `brazoIntake` REAL con dependencias dobles. Lo único falso es el
 * mundo exterior (GitHub, filesystem, reloj); la lógica del guard es la del
 * fuente vigente.
 *
 * @param {{mode:string, degraded:boolean, allowedIssues?:number[]}} pipelineMode
 * @returns {{correr:Function, llamadasGh:string[], logs:string[]}}
 */
function montarIntake(pipelineMode) {
    const llamadasGh = [];
    const logs = [];

    const sandbox = {
        // Estado del módulo que el brazo toca.
        lastIntakeTime: 0,
        Date,
        JSON,
        partialPause: { getPipelineMode: () => pipelineMode },
        log: (comp, msg) => logs.push(`${comp}: ${msg}`),
        repoTarget: {
            getIntakeRepos: () => ['intrale/platform'],
            isRepoAllowed: () => true,
        },
        buildIntakeSearchQueries: () => ['is:open'],
        ghThrottle: () => {},
        _ghExecSyncGuarded: (cmd) => { llamadasGh.push(cmd); return '[]'; },
        GH_BIN: 'gh',
        INTAKE_GH_LIST_LIMIT: 50,
        ROOT: process.cwd(),
    };

    const nombres = Object.keys(sandbox);
    const fuente = fuenteDeFuncion('brazoIntake');
    const factory = new Function(...nombres, `${fuente}\nreturn brazoIntake;`);
    const brazo = factory(...nombres.map((n) => sandbox[n]));

    return {
        correr: (config) => brazo(config),
        llamadasGh,
        logs,
    };
}

const CONFIG_INTAKE = {
    timeouts: { intake_interval_seconds: 0 },
    intake: { desarrollo: { label: 'Ready', fase_entrada: 'dev' } },
    pipelines: { desarrollo: { fases: ['dev'] } },
};

test('R-5: con el estado operativo DEGRADADO, el intake no consulta ni ingiere nada', () => {
    const { correr, llamadasGh, logs } = montarIntake({
        mode: 'running', allowedIssues: [], allowedSkills: [], degraded: true,
    });

    correr(CONFIG_INTAKE);

    assert.equal(llamadasGh.length, 0,
        'el intake consultó GitHub con el estado operativo caído: ingiere el backlog Ready entero '
        + 'porque no puede saber cuál es la ola vigente');
    assert.ok(logs.some((l) => /degradad/i.test(l)),
        'el skip tiene que dejar traza: una cola quieta sin causa declarada es indistinguible de un cuelgue');
});

test('R-5: sin degradación, el intake sigue funcionando igual que siempre', () => {
    const { correr, llamadasGh } = montarIntake({
        mode: 'running', allowedIssues: [], allowedSkills: [], degraded: false,
    });

    correr(CONFIG_INTAKE);

    assert.ok(llamadasGh.length > 0,
        'el guard no puede frenar el camino sano: eso dejaría al pipeline sin intake');
});

test('R-5: en pausa total el intake sigue sin correr (comportamiento previo intacto)', () => {
    const { correr, llamadasGh } = montarIntake({
        mode: 'paused', allowedIssues: [], allowedSkills: [], degraded: false,
    });
    correr(CONFIG_INTAKE);
    assert.equal(llamadasGh.length, 0);
});

test('R-5: el guard de degradación corre ANTES de cualquier efecto', () => {
    // Orden dentro del fuente: `degraded` tiene que evaluarse antes de que
    // aparezca la primera consulta a GitHub. Un guard correcto pero ubicado
    // después del efecto no protege nada.
    const fuente = fuenteDeFuncion('brazoIntake');
    const iGuard = fuente.indexOf('degraded === true');
    const iEfecto = fuente.indexOf('_ghExecSyncGuarded');
    assert.ok(iGuard > 0, 'desapareció el guard de degradación del intake');
    assert.ok(iEfecto > 0, 'no se encontró la consulta a GitHub (¿cambió el helper?)');
    assert.ok(iGuard < iEfecto, 'el guard quedó DESPUÉS del efecto que debía prevenir');
});

test('R-5 (hermano): el brazo de desbloqueo también frena bajo degradación', () => {
    // Los reaps de este brazo QUITAN labels de bloqueo en GitHub. Con
    // `allowlistSet: null` dejan de acotarse a la ola vigente y destraban issues
    // ajenos: misma clase de daño que el intake.
    const fuente = fuenteDeFuncion('brazoDesbloqueoImpl');
    const iGuard = fuente.indexOf('degraded === true');
    const iReap = fuente.indexOf('reapStaleHumanBlocks');
    assert.ok(iGuard > 0, 'el brazo de desbloqueo quedó fail-open bajo degradación');
    assert.ok(iReap > 0);
    assert.ok(iGuard < iReap, 'el guard tiene que correr antes del primer reap');
});

// -----------------------------------------------------------------------------
// R-6 · una lectura del estado por TICK, no por candidato
// -----------------------------------------------------------------------------

test('R-6: el loop de despacho NO relee el estado operativo por candidato', () => {
    // El cuerpo real vive en `brazoLanzamientoImpl`; `brazoLanzamiento` es el
    // envoltorio que instala la instrumentación de dispatch-cause.
    const fuente = fuenteDeFuncion('brazoLanzamientoImpl');

    const iSnapshot = fuente.indexOf('ppStateForPriority');
    assert.ok(iSnapshot > 0, 'desapareció el snapshot del estado por tick');

    const iLoop = fuente.indexOf('for (const candidate of candidates)');
    assert.ok(iLoop > 0, 'no se encontró el loop de despacho — ¿cambió su forma?');
    assert.ok(iSnapshot < iLoop, 'el snapshot tiene que tomarse ANTES del loop');

    // La aserción central: dentro del loop no puede quedar ninguna lectura del
    // estado. En modo remoto cada una es un `spawnSync` bloqueante de 20 s.
    const cuerpoDelLoop = sinComentarios(fuente.slice(iLoop));
    assert.equal(
        cuerpoDelLoop.includes('getPipelineMode()'), false,
        'volvió una lectura del estado operativo DENTRO del loop de candidatos: con ~200 '
        + 'pendientes son ~200 spawnSync bloqueantes por tick, el tick supera los 180s del '
        + 'watchdog de liveness y el Pulpo entra en bucle de muerte',
    );

    // Y exactamente una lectura por tick en todo el brazo.
    const lecturas = (sinComentarios(fuente).match(/getPipelineMode\(\)/g) || []).length;
    assert.equal(lecturas, 1,
        `el brazo hace ${lecturas} lecturas del estado por tick; el contrato es 1`);
});

test('R-6: el gate por candidato sigue usando la variante PURA del estado', () => {
    // El ahorro no puede pagarse aflojando el gate: `isIssueAllowedInState` es
    // la misma tabla de verdad (incluido el fail-closed de #5060 sobre
    // `running`), sólo que sin releer el sustrato.
    const fuente = fuenteDeFuncion('brazoLanzamientoImpl');
    assert.ok(fuente.includes('isIssueAllowedInState(issue, modeState)'),
        'el gate por issue cambió de forma: revisar que siga siendo fail-closed');
    assert.equal(fuente.includes('partialPause.isIssueAllowed('), false,
        'volvió la variante que relee el sustrato por issue');
});
