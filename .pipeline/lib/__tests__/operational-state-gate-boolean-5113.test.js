// =============================================================================
// operational-state-gate-boolean-5113.test.js — CA-A2 (#5113)
//
// TEST DE CONTRATO del gate de dispatch.
//
// `isIssueAllowed()` / `isSkillAllowed()` devuelven `boolean` ESTRICTO, en modo
// filesystem y con el estado viviendo en el store remoto por igual.
//
// Por qué este test existe y por qué es bloqueante
// ------------------------------------------------
// `if (ops.isIssueAllowed(n))` sobre una `Promise` es SIEMPRE `true`. Un cambio
// de tipo de retorno convierte el gate en fail-OPEN silencioso sin que ningún
// test de dominio se ponga rojo: `assert.ok(allowed)` pasa igual con una Promise
// pendiente. Eso es el incidente #5060 (~320 agentes despachados sobre ~100
// issues del backlog histórico) reproducido por un refactor inocente.
//
// Por eso se assertea `typeof === 'boolean'` explícitamente y se rechaza
// cualquier thenable, en vez de confiar en que el valor "se comporte bien".
//
// Ejecutar:
//   node --test .pipeline/lib/__tests__/operational-state-gate-boolean-5113.test.js
// =============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createFakeSyncDynamoDriver } = require('./fixtures/fake-sync-dynamo-driver');
const { withEnv } = require('../test-helpers/with-env');

const PROJECT_ID = 'intrale-platform';

const MODULES = [
    require.resolve('../operational-state-backend'),
    require.resolve('../partial-pause'),
    require.resolve('../waves'),
    require.resolve('../operational-state'),
    require.resolve('../project-context'),
];

function freshModules() {
    for (const m of MODULES) delete require.cache[m];
    /* eslint-disable global-require */
    return {
        backend: require('../operational-state-backend'),
        partialPause: require('../partial-pause'),
        opState: require('../operational-state'),
    };
    /* eslint-enable global-require */
}

/**
 * Corre `fn(dir)` con un tmpdir propio y el entorno AISLADO por `withEnv`
 * (#6258): las tres variables se restauran pase lo que pase, asi que el
 * resultado de un test no depende del orden en que corrio ni del entorno del
 * proceso que lo lanza. `undefined` BORRA la variable — es como se pide
 * "ausente".
 *
 * El flag de sustrato viaja por `env` y NO se escribe a mano dentro del test:
 * un `process.env` suelto en el cuerpo sobrevive al test que lo escribio y
 * contamina a los que siguen.
 *
 * @param {Object<string, string|undefined>} env
 * @param {(dir: string) => void} fn
 */
function enTmp(env, fn) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opstate-gate-5113-'));
    try {
        return withEnv({
            PIPELINE_DIR_OVERRIDE: dir,
            PIPELINE_OPSTATE_DURABLE: undefined,
            PIPELINE_ALLOW_UNSCOPED_DISPATCH: undefined,
            ...env,
        }, () => fn(dir));
    } finally {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
}

function mountRemote(backend, { failWith = null } = {}) {
    const driver = createFakeSyncDynamoDriver({ failWith });
    backend._setDriverForTests({
        driver,
        spec: { type: 'dynamodb_table', tableName: 'tabla-fake', keys: [] },
        projectId: PROJECT_ID,
        instanceId: PROJECT_ID,
        atomicUpdate: true,
    });
    return driver;
}

/** Aserción dura: boolean estricto y NO thenable. */
function assertStrictBoolean(valor, etiqueta) {
    assert.equal(typeof valor, 'boolean',
        `${etiqueta}: el gate DEBE devolver boolean estricto, devolvió ${typeof valor}`);
    assert.equal(valor === null || valor === undefined, false, `${etiqueta}: no puede ser nullish`);
    // OJO: `valor && valor.then` corta en corto con `false` y devuelve `false`,
    // no `undefined` — el optional chaining es obligatorio para que la asercion
    // valga tanto para un gate que permite como para uno que deniega.
    assert.equal(typeof valor?.then, 'undefined',
        `${etiqueta}: un thenable convierte el gate en fail-OPEN silencioso (#5060)`);
}

// -----------------------------------------------------------------------------
// Modo filesystem — la línea base que no puede regresionar
// -----------------------------------------------------------------------------

test('CA-A2 (fs): isIssueAllowed / isSkillAllowed devuelven boolean estricto en los tres modos', () => enTmp({ PIPELINE_OPSTATE_DURABLE: '0' }, (dir) => {
    const { backend, partialPause } = freshModules();
    assert.equal(backend.isRemote(), false);

    // running (sin allowlist): fail-closed post-#5060 ⇒ false, pero BOOLEAN.
    assertStrictBoolean(partialPause.isIssueAllowed(5113), 'running/issue');
    assert.equal(partialPause.isIssueAllowed(5113), false);
    assertStrictBoolean(partialPause.isSkillAllowed('pipeline-dev'), 'running/skill');

    // partial_pause
    partialPause.setPartialPause([5113], { source: 'test', authorizedBy: 'wave:promote' });
    assertStrictBoolean(partialPause.isIssueAllowed(5113), 'partial/issue-dentro');
    assert.equal(partialPause.isIssueAllowed(5113), true);
    assertStrictBoolean(partialPause.isIssueAllowed(9999), 'partial/issue-fuera');
    assert.equal(partialPause.isIssueAllowed(9999), false);

    // paused (halt total): `.paused` es filesystem SIEMPRE (D-3).
    fs.writeFileSync(path.join(dir, '.paused'), new Date().toISOString());
    assertStrictBoolean(partialPause.isIssueAllowed(5113), 'paused/issue');
    assert.equal(partialPause.isIssueAllowed(5113), false);
    assertStrictBoolean(partialPause.isSkillAllowed('pipeline-dev'), 'paused/skill');
    assert.equal(partialPause.isSkillAllowed('pipeline-dev'), false);
}));

// -----------------------------------------------------------------------------
// Modo remoto — el contrato NO cambia de tipo al mover el sustrato
// -----------------------------------------------------------------------------

test('CA-A2 (remoto): el gate sigue siendo boolean estricto con el estado en el store', () => enTmp({ PIPELINE_OPSTATE_DURABLE: '1' }, () => {
    const { backend, partialPause } = freshModules();
    mountRemote(backend);

    // Sin allowlist en el store: deniega, pero BOOLEAN.
    assertStrictBoolean(partialPause.isIssueAllowed(5113), 'remoto/sin-allowlist');
    assert.equal(partialPause.isIssueAllowed(5113), false);

    backend.writeKey(backend.KEYS.PARTIAL_PAUSE, {
        allowed_issues: [5113], allowed_skills: ['pipeline-dev'], source: 'test',
    });

    assertStrictBoolean(partialPause.isIssueAllowed(5113), 'remoto/dentro');
    assert.equal(partialPause.isIssueAllowed(5113), true, 'el issue de la ola se despacha');
    assertStrictBoolean(partialPause.isIssueAllowed(9999), 'remoto/fuera');
    assert.equal(partialPause.isIssueAllowed(9999), false, 'un issue fuera de la ola es denegado');

    assertStrictBoolean(partialPause.isSkillAllowed('pipeline-dev'), 'remoto/skill-dentro');
    assert.equal(partialPause.isSkillAllowed('pipeline-dev'), true);
    assertStrictBoolean(partialPause.isSkillAllowed('otro-skill'), 'remoto/skill-fuera');
    assert.equal(partialPause.isSkillAllowed('otro-skill'), false);
}));

test('CA-A2 (remoto): con el store CAÍDO el gate sigue devolviendo boolean, y deniega', () => enTmp({ PIPELINE_OPSTATE_DURABLE: '1' }, () => {
    const { backend, partialPause } = freshModules();
    mountRemote(backend, { failWith: new Error('ETIMEDOUT: no hubo respuesta de red') });

    const r = partialPause.isIssueAllowed(5113);
    assertStrictBoolean(r, 'remoto-degradado');
    assert.equal(r, false, 'degradación ⇒ denegar (CA-A7), nunca un valor ambiguo');
}));

test('CA-A2: las variantes `...InState` también son boolean estricto (mismo contrato)', () => enTmp({ PIPELINE_OPSTATE_DURABLE: '0' }, () => {
    const { partialPause } = freshModules();
    const estado = {
        mode: 'partial_pause', allowedIssues: [5113], allowedSkills: ['pipeline-dev'],
    };
    assertStrictBoolean(partialPause.isIssueAllowedInState(5113, estado), 'inState/issue');
    assertStrictBoolean(partialPause.isIssueAllowedInState(1, estado), 'inState/issue-fuera');
    assertStrictBoolean(partialPause.isSkillAllowedInState('pipeline-dev', estado), 'inState/skill');
    assertStrictBoolean(partialPause.isSkillAllowedInState('otro', estado), 'inState/skill-fuera');
    // Entradas basura: boolean igual, nunca undefined ni throw.
    assertStrictBoolean(partialPause.isIssueAllowedInState(null, estado), 'inState/null');
    assertStrictBoolean(partialPause.isIssueAllowedInState('abc', estado), 'inState/no-numérico');
    assertStrictBoolean(partialPause.isSkillAllowedInState('', estado), 'inState/skill-vacío');
}));

test('CA-A2: la fachada `operational-state` tampoco cambia de tipo en modo remoto', () => enTmp({ PIPELINE_OPSTATE_DURABLE: '1' }, () => {
    const { backend, opState } = freshModules();
    mountRemote(backend);
    backend.writeKey(backend.KEYS.PARTIAL_PAUSE, { allowed_issues: [5113] });

    assertStrictBoolean(opState.isIssueAllowed(5113), 'fachada/dentro');
    assert.equal(opState.isIssueAllowed(5113), true);
    assertStrictBoolean(opState.isIssueAllowed(9999), 'fachada/fuera');
    assert.equal(opState.isIssueAllowed(9999), false);
}));

test('CA-A2: ninguna de las cuatro funciones del gate está declarada async', () => enTmp({ PIPELINE_OPSTATE_DURABLE: '0' }, () => {
    const { partialPause } = freshModules();
    const AsyncFunction = (async () => {}).constructor;
    for (const nombre of ['isIssueAllowed', 'isIssueAllowedInState', 'isSkillAllowed', 'isSkillAllowedInState']) {
        const fn = partialPause[nombre];
        assert.equal(typeof fn, 'function', `${nombre} debe existir`);
        assert.equal(fn instanceof AsyncFunction, false,
            `${nombre} NO puede ser async: su retorno se consume en contexto booleano`);
        assert.equal(fn.constructor.name, 'Function', `${nombre} debe ser una función sincrónica común`);
    }
}));
