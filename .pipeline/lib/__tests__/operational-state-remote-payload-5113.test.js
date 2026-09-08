// =============================================================================
// operational-state-remote-payload-5113.test.js — CA-A5 (#5113)
//
// VALIDACION DEL PAYLOAD REMOTO, ANTES DE `JSON.parse` Y ANTES DE ACEPTARLO.
//
// Por que este test existe
// ------------------------
// El estado operativo pasa a vivir en una tabla de DynamoDB. Desde ese momento
// el payload que alimenta la allowlist de ejecucion y el registro de olas deja
// de ser un archivo del host y pasa a ser ENTRADA REMOTA: un item de otro
// origen, uno envenenado o uno sobredimensionado no puede convertirse en una
// autorizacion de dispatch ni en un registro de olas a medias.
//
// Las tres cotas que cubre la suite, todas fail-closed:
//   1. BYTES sobre el stdout CRUDO de la CLI, ANTES del `JSON.parse` (el guard
//      que envuelve al runner en `resolveDriver`). Rechazar sin parsear es
//      distinto de parsear y despues decidir que era muy grande.
//   2. CARDINALIDAD de `allowed_issues` / `allowed_skills`. Una allowlist con
//      50k entradas no es un estado valido: es una allowlist envenenada.
//   3. SCHEMA. Lo que no es un objeto con las colecciones en la forma esperada
//      se descarta ENTERO — nunca se acepta "la parte buena".
//
// Ejecutar:
//   node --test .pipeline/lib/__tests__/operational-state-remote-payload-5113.test.js
// =============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');

const { createFakeSyncDynamoDriver } = require('./fixtures/fake-sync-dynamo-driver');
const { withEnv } = require('../test-helpers/with-env');

const BACKEND_PATH = require.resolve('../operational-state-backend');
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

const PROJECT_ID = 'intrale-platform';

function freshBackend() {
    delete require.cache[BACKEND_PATH];
    // eslint-disable-next-line global-require
    return require('../operational-state-backend');
}

/**
 * Corre `fn(dir)` con un tmpdir propio y el entorno AISLADO por `withEnv`
 * (#6258): las variables se restauran pase lo que pase, asi que el resultado de
 * un test no depende del orden en que corrio ni del entorno del proceso que lo
 * lanza. `undefined` BORRA la variable — es como se pide "ausente".
 *
 * El flag de sustrato viaja por `env` y NO se escribe a mano dentro del test:
 * un `process.env` suelto en el cuerpo sobrevive al test que lo escribio y
 * contamina a los que siguen.
 *
 * @param {Object<string, string|undefined>} env
 * @param {(dir: string) => void} fn
 */
function enTmp(env, fn) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opstate-payload-5113-'));
    try {
        return withEnv({
            PIPELINE_DIR_OVERRIDE: dir,
            PIPELINE_OPSTATE_DURABLE: undefined,
            ...env,
        }, () => fn(dir));
    } finally {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
}

/**
 * Monta el backend en modo remoto con un driver fake inyectado. El flag ya
 * viene puesto por `enTmp({ PIPELINE_OPSTATE_DURABLE: '1' })`: montar el driver
 * y declarar el entorno son responsabilidades distintas.
 *
 * El sink de degradacion se inyecta SIEMPRE: un rechazo de payload reporta
 * degradacion, y sin sink propio el backend cablearia el canal real
 * (`kernel-degradation-alert` + Telegram) desde un test.
 */
function remoteBackend() {
    const backend = freshBackend();
    const driver = createFakeSyncDynamoDriver();
    const degradaciones = [];
    backend.setDegradationSink({ onDegraded: (err, ctx) => degradaciones.push({ err, ctx }) });
    backend._setDriverForTests({
        driver,
        spec: { type: 'dynamodb_table', tableName: 'tabla-fake', keys: [] },
        projectId: PROJECT_ID,
        instanceId: PROJECT_ID,
        atomicUpdate: true,
    });
    return { backend, driver, degradaciones };
}

/** Siembra un item de coordinacion CRUDO en el store fake, saltando el write. */
function sembrar(driver, key, value, version = 1) {
    // eslint-disable-next-line global-require
    const coord = require('../kernel-coordination-store');
    driver._seed(coord.buildCoordinationEnvelope({
        projectId: PROJECT_ID, key, value, version, instanceId: PROJECT_ID, updatedAt: Date.now(),
    }));
}

const ISO = '2026-09-08T10:00:00.000Z';

function markerLegitimo(extra = {}) {
    return {
        allowed_issues: [5113, 5126],
        allowed_skills: ['pipeline-dev'],
        created_at: ISO,
        source: 'telegram',
        ...extra,
    };
}

function issues(n, desde = 1) {
    return Array.from({ length: n }, (_, i) => desde + i);
}

function skills(n) {
    return Array.from({ length: n }, (_, i) => `skill-${i}`);
}

// -----------------------------------------------------------------------------
// CA-A5 · Cota de BYTES sobre el stdout CRUDO, ANTES del `JSON.parse`
//
// Estos tests NO inyectan el driver fake: ejercitan el driver REAL de produccion
// (`resolveDriver` -> `createAwsCliRunnerSync` + `createAwsCliDynamoDriverSync`),
// que es donde vive el guard. Lo unico que se sustituye es
// `child_process.spawnSync`, o sea la frontera con la AWS CLI: si el guard se
// sacara del medio, el stdout llegaria a `parseCliResult`, que hace
// `JSON.parse(out)` sin preguntar por el tamano.
// -----------------------------------------------------------------------------

/**
 * Prepara un pipelineDir con la config MINIMA que exige el driver real
 * (`kernel.coordinationTableName`) y el manifiesto de producto que el
 * config-resolver reclama junto al kernel ("reubica ambos o ninguno").
 */
function conConfigDeDriverReal(fn) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opstate-payload-cli-5113-'));
    fs.writeFileSync(path.join(dir, 'config.yaml'), [
        'kernel:',
        '  tableName: "tabla-no-repudio-fake"',
        '  coordinationTableName: "tabla-coordinacion-fake"',
        '  region: "us-east-2"',
        '',
    ].join('\n'));
    fs.copyFileSync(path.join(REPO_ROOT, 'pipeline.config.json'), path.join(dir, 'pipeline.config.json'));
    try {
        return withEnv({
            PIPELINE_DIR_OVERRIDE: dir,
            PIPELINE_OPSTATE_DURABLE: '1',
            // El contexto de proyecto se resuelve por host-fallback: un
            // `PIPELINE_PROJECT_ID` heredado del proceso que corre los tests, sin
            // su binding de spawn, haria fallar la resolucion por otra razon.
            PIPELINE_PROJECT_ID: undefined,
            PIPELINE_PROJECT_BINDING: undefined,
            // Credenciales de mentira: el runner exige claves estaticas antes de
            // spawnear (fail-closed) y aca nunca se spawnea nada real.
            AWS_ACCESS_KEY_ID: 'clave-de-mentira-para-el-test',
            AWS_SECRET_ACCESS_KEY: 'valor-de-mentira-para-el-test',
        }, () => {
            // eslint-disable-next-line global-require
            require('../project-context')._resetForTests();
            return fn(dir);
        });
    } finally {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
}

/** Sustituye `child_process.spawnSync` por `fake` y lo restaura pase lo que pase. */
function conSpawnSync(fake, fn) {
    const original = childProcess.spawnSync;
    childProcess.spawnSync = fake;
    try { return fn(); } finally { childProcess.spawnSync = original; }
}

/** Corre `fn` espiando `JSON.parse`; devuelve el largo del string mas grande parseado. */
function espiandoJsonParse(fn) {
    const original = JSON.parse;
    let mayor = 0;
    JSON.parse = function espia(texto, ...resto) {
        if (typeof texto === 'string' && texto.length > mayor) mayor = texto.length;
        return original.call(JSON, texto, ...resto);
    };
    try { fn(); } finally { JSON.parse = original; }
    return mayor;
}

/** Respuesta que devolveria `aws dynamodb get-item` para un item de coordinacion. */
function stdoutDeGetItem(key, value, version) {
    /* eslint-disable global-require */
    const coord = require('../kernel-coordination-store');
    const { toAttrValues } = require('../provisioner-infra');
    /* eslint-enable global-require */
    const item = coord.buildCoordinationEnvelope({
        projectId: PROJECT_ID, key, value, version, instanceId: PROJECT_ID, updatedAt: Date.now(),
    });
    return JSON.stringify({ Item: toAttrValues(item) });
}

test('CA-A5 (control positivo): un item legitimo del driver REAL se parsea y llega al caller', () => conConfigDeDriverReal(() => {
    const stdout = stdoutDeGetItem('waves', {
        version: '1.0', meta: { updated_at: ISO }, planned_waves: [], archived_waves: [], dependencies: [],
    }, 3);

    let spawns = 0;
    conSpawnSync(() => { spawns += 1; return { status: 0, stdout, stderr: '' }; }, () => {
        const backend = freshBackend();
        backend.setDegradationSink({ onDegraded: () => {} });
        const leido = backend.readKeyWithVersion(backend.KEYS.WAVES);

        assert.equal(spawns > 0, true, 'el driver REAL se uso: hubo trafico contra la CLI');
        assert.equal(leido.degraded, false, 'un payload dentro de la cota no degrada');
        assert.equal(leido.error, null);
        assert.equal(leido.version, 3, 'la version entera del store es la autoritativa');
        assert.equal(leido.value.meta.updated_at, ISO);
    });
}));

test('CA-A5: un stdout sobredimensionado se RECHAZA antes del `JSON.parse` (cero parseos del payload)', () => conConfigDeDriverReal(() => {
    // Payload por lo demas PERFECTO: mismo shape que el del control positivo,
    // solo que gigante. Si el rechazo no fuera por tamano, la lectura tendria
    // exito — por eso este test no puede pasar por accidente.
    const stdout = stdoutDeGetItem('waves', {
        version: '1.0',
        meta: { updated_at: ISO },
        planned_waves: [],
        archived_waves: [],
        dependencies: [],
        relleno: 'x'.repeat(600 * 1024),
    }, 3);

    let spawns = 0;
    conSpawnSync(() => { spawns += 1; return { status: 0, stdout, stderr: '' }; }, () => {
        const backend = freshBackend();
        const degradaciones = [];
        backend.setDegradationSink({ onDegraded: (err, ctx) => degradaciones.push({ err, ctx }) });

        let leido;
        const mayorParseado = espiandoJsonParse(() => {
            leido = backend.readKeyWithVersion(backend.KEYS.WAVES);
        });

        assert.equal(spawns > 0, true, 'la respuesta gigante SI viajo por el driver real');
        assert.equal(leido.value, null, 'fail-closed: no se acepta nada del item sobredimensionado');
        assert.equal(leido.version, null);
        assert.equal(leido.degraded, true, 'el rechazo se reporta como degradacion, no se traga');
        assert.match(leido.error.message, /supera la cota/);
        assert.match(leido.error.message, /NO se parsea/);
        assert.equal(degradaciones.length, 1, 'el operador se entera del rechazo');

        // EL PUNTO DEL TEST: el stdout gigante nunca entro a `JSON.parse`.
        assert.equal(mayorParseado < stdout.length, true,
            `el payload de ${stdout.length} chars no puede haberse parseado (mayor parseado: ${mayorParseado})`);
    });
}));

test('CA-A5: la cota previa al parse cubre la clave mas grande (no vuelve ilegible un estado legitimo)', () => enTmp({ PIPELINE_OPSTATE_DURABLE: '0' }, () => {
    const backend = freshBackend();
    // El guard del runner corta sobre el envelope COMPLETO de la CLI, asi que su
    // cota se deriva de la cota por clave mas grande: si fuera menor, un estado
    // legitimo del tamano maximo permitido quedaria irrecuperable.
    const maxPorClave = Math.max(...Object.values(backend.MAX_BYTES_FOR_KEY));
    assert.equal(maxPorClave, backend.MAX_BYTES_FOR_KEY[backend.KEYS.WAVES]);
    assert.equal(maxPorClave > backend.MAX_BYTES_FOR_KEY[backend.KEYS.PARTIAL_PAUSE], true,
        'el registro de olas admite mas que la allowlist: el archivo real ronda los 31 KB y crece');
}));

// -----------------------------------------------------------------------------
// CA-A5 · Paridad de la cota de la allowlist con el marker de pausa (#5399)
// -----------------------------------------------------------------------------

test('CA-A5: la cota de la allowlist remota es 64 KB, en paridad con `MAX_PAUSE_MARKER_BYTES` (#5399)', () => enTmp({ PIPELINE_OPSTATE_DURABLE: '0' }, () => {
    const backend = freshBackend();
    // eslint-disable-next-line global-require
    const { MAX_PAUSE_MARKER_BYTES } = require('../partial-pause');

    assert.equal(backend.MAX_BYTES_FOR_KEY[backend.KEYS.PARTIAL_PAUSE], 64 * 1024);
    assert.equal(backend.MAX_BYTES_FOR_KEY[backend.KEYS.PARTIAL_PAUSE], MAX_PAUSE_MARKER_BYTES,
        'mover el sustrato no puede aflojar la cota que ya regia sobre el marker local');
}));

// -----------------------------------------------------------------------------
// CA-A5 · Cota de BYTES sobre el value ya materializado (lectura y escritura)
// -----------------------------------------------------------------------------

test('CA-A5: un item de allowlist que supera los 64 KB se descarta entero al leerlo', () => enTmp({ PIPELINE_OPSTATE_DURABLE: '1' }, () => {
    const { backend, driver, degradaciones } = remoteBackend();
    sembrar(driver, 'partial-pause', markerLegitimo({ justification: 'y'.repeat(70 * 1024) }));

    const leido = backend.readKeyWithVersion(backend.KEYS.PARTIAL_PAUSE);
    assert.equal(leido.value, null, 'no se acepta "la parte buena" del item sobredimensionado');
    assert.equal(leido.degraded, true);
    assert.match(leido.error.message, /CA-A5/);
    assert.match(leido.error.message, /supera la cota de 65536/);
    assert.equal(degradaciones.length, 1);
    assert.equal(degradaciones[0].ctx.stage, 'opstate:read:partial-pause');
}));

test('CA-A5: tampoco se ESCRIBE un item sobredimensionado (no se deja el estado ilegible)', () => enTmp({ PIPELINE_OPSTATE_DURABLE: '1' }, () => {
    const { backend, driver } = remoteBackend();
    const res = backend.writeKey(backend.KEYS.PARTIAL_PAUSE,
        markerLegitimo({ justification: 'z'.repeat(70 * 1024) }));

    assert.equal(res.ok, false);
    assert.match(res.error.message, /escritura remota rechazada \(CA-A5\)/);
    assert.equal(driver._calls.some((c) => c.op === 'putItem'), false,
        'el rechazo ocurre ANTES de tocar el store: no hay putItem');
    assert.equal(backend.readKey(backend.KEYS.PARTIAL_PAUSE), null, 'la particion quedo intacta');
}));

// -----------------------------------------------------------------------------
// CA-A5 · Cardinalidad de `allowed_issues` / `allowed_skills`
// -----------------------------------------------------------------------------

test('CA-A5: `allowed_issues` por encima de la cota se rechaza; exactamente en la cota se acepta', () => enTmp({ PIPELINE_OPSTATE_DURABLE: '1' }, () => {
    const { backend } = remoteBackend();
    const max = backend.MAX_ALLOWED_ISSUES;
    assert.equal(max, 500, 'la cota declarada de issues es 500');

    const enLaCota = backend.validateRemoteValue(backend.KEYS.PARTIAL_PAUSE, { allowed_issues: issues(max) });
    assert.equal(enLaCota.ok, true, 'el limite es inclusivo: la ola mas grande admisible sigue operando');

    const pasada = backend.validateRemoteValue(backend.KEYS.PARTIAL_PAUSE, { allowed_issues: issues(max + 1) });
    assert.equal(pasada.ok, false);
    assert.match(pasada.reason, new RegExp(`${max + 1} entradas supera la cota de ${max}`));
}));

test('CA-A5: `allowed_skills` por encima de la cota se rechaza; exactamente en la cota se acepta', () => enTmp({ PIPELINE_OPSTATE_DURABLE: '1' }, () => {
    const { backend } = remoteBackend();
    const max = backend.MAX_ALLOWED_SKILLS;
    assert.equal(max, 100, 'la cota declarada de skills es 100');

    assert.equal(backend.validateRemoteValue(backend.KEYS.PARTIAL_PAUSE, { allowed_skills: skills(max) }).ok, true);

    const pasada = backend.validateRemoteValue(backend.KEYS.PARTIAL_PAUSE, { allowed_skills: skills(max + 1) });
    assert.equal(pasada.ok, false);
    assert.match(pasada.reason, new RegExp(`${max + 1} entradas supera la cota de ${max}`));
}));

test('CA-A5: una allowlist envenenada por cardinalidad NO autoriza a nadie (ni a los issues legitimos)', () => enTmp({ PIPELINE_OPSTATE_DURABLE: '1' }, () => {
    const { backend, driver, degradaciones } = remoteBackend();
    // 5113 es un issue REAL de la ola y aparece primero en una lista envenenada.
    // Aceptar "los primeros N" seria exactamente el fallo que la cota evita.
    sembrar(driver, 'partial-pause', {
        allowed_issues: [5113, ...issues(backend.MAX_ALLOWED_ISSUES, 900000)],
        source: 'origen-desconocido',
    });

    const leido = backend.readKeyWithVersion(backend.KEYS.PARTIAL_PAUSE);
    assert.equal(leido.value, null, 'el item se descarta ENTERO, no se trunca');
    assert.equal(leido.degraded, true);
    assert.match(leido.error.message, /allowed_issues con 501 entradas/);
    assert.equal(degradaciones.length, 1);
}));

test('CA-A5: la cardinalidad excesiva tampoco se puede escribir', () => enTmp({ PIPELINE_OPSTATE_DURABLE: '1' }, () => {
    const { backend, driver } = remoteBackend();

    const porIssues = backend.writeKey(backend.KEYS.PARTIAL_PAUSE,
        { allowed_issues: issues(backend.MAX_ALLOWED_ISSUES + 1) });
    assert.equal(porIssues.ok, false);
    assert.match(porIssues.error.message, /allowed_issues/);

    const porSkills = backend.writeKey(backend.KEYS.PARTIAL_PAUSE,
        { allowed_skills: skills(backend.MAX_ALLOWED_SKILLS + 1) });
    assert.equal(porSkills.ok, false);
    assert.match(porSkills.error.message, /allowed_skills/);

    assert.equal(driver._calls.some((c) => c.op === 'putItem'), false,
        'ninguna de las dos escrituras llego al store');
}));

test('CA-A5: el registro de olas tiene su propia cota de cardinalidad por coleccion', () => enTmp({ PIPELINE_OPSTATE_DURABLE: '1' }, () => {
    const { backend } = remoteBackend();
    for (const bucket of ['planned_waves', 'archived_waves', 'dependencies']) {
        const enLaCota = backend.validateRemoteValue(backend.KEYS.WAVES, { [bucket]: issues(500) });
        assert.equal(enLaCota.ok, true, `${bucket} en la cota se acepta`);

        const pasada = backend.validateRemoteValue(backend.KEYS.WAVES, { [bucket]: issues(501) });
        assert.equal(pasada.ok, false, `${bucket} pasado de cota se rechaza`);
        assert.match(pasada.reason, new RegExp(`^${bucket} con 501 entradas`));
    }
}));

// -----------------------------------------------------------------------------
// CA-A5 · Schema: lo que no tiene la forma esperada se descarta ENTERO
// -----------------------------------------------------------------------------

test('CA-A5: un valor remoto que no es objeto plano se rechaza (array, primitivo, null)', () => enTmp({ PIPELINE_OPSTATE_DURABLE: '1' }, () => {
    const { backend } = remoteBackend();
    for (const basura of [null, undefined, [], [5113], 'allowed_issues=5113', 42, true]) {
        const res = backend.validateRemoteValue(backend.KEYS.PARTIAL_PAUSE, basura);
        assert.equal(res.ok, false, `${String(basura)} no es un estado valido`);
        assert.match(res.reason, /no es un objeto/);
    }
}));

test('CA-A5: las colecciones de la allowlist deben ser arrays: cualquier otra forma se rechaza', () => enTmp({ PIPELINE_OPSTATE_DURABLE: '1' }, () => {
    const { backend } = remoteBackend();

    for (const valor of ['5113', 5113, { 0: 5113 }, true]) {
        const porIssues = backend.validateRemoteValue(backend.KEYS.PARTIAL_PAUSE, { allowed_issues: valor });
        assert.equal(porIssues.ok, false);
        assert.match(porIssues.reason, /allowed_issues no es un array/);

        const porSkills = backend.validateRemoteValue(backend.KEYS.PARTIAL_PAUSE, { allowed_skills: valor });
        assert.equal(porSkills.ok, false);
        assert.match(porSkills.reason, /allowed_skills no es un array/);
    }

    // Ausentes SI es valido: un marker sin `allowed_skills` es el caso normal.
    assert.equal(backend.validateRemoteValue(backend.KEYS.PARTIAL_PAUSE, { allowed_issues: [5113] }).ok, true);
    assert.equal(backend.validateRemoteValue(backend.KEYS.PARTIAL_PAUSE, {}).ok, true);
}));

test('CA-A5: un item con schema invalido se descarta al leerlo y degrada (no se acepta a medias)', () => enTmp({ PIPELINE_OPSTATE_DURABLE: '1' }, () => {
    const { backend, driver, degradaciones } = remoteBackend();
    sembrar(driver, 'partial-pause', { allowed_issues: { 0: 5113 }, allowed_skills: ['pipeline-dev'] });

    const leido = backend.readKeyWithVersion(backend.KEYS.PARTIAL_PAUSE);
    assert.equal(leido.value, null);
    assert.equal(leido.degraded, true);
    assert.match(leido.error.message, /allowed_issues no es un array/);
    assert.equal(degradaciones.length, 1);
    assert.equal(backend.existsKey(backend.KEYS.PARTIAL_PAUSE), false,
        'un item rechazado no "existe" para el resto del pipeline');
}));

test('CA-A5: el registro de olas rechaza colecciones que no son arrays', () => enTmp({ PIPELINE_OPSTATE_DURABLE: '1' }, () => {
    const { backend } = remoteBackend();
    for (const bucket of ['planned_waves', 'archived_waves', 'dependencies']) {
        const res = backend.validateRemoteValue(backend.KEYS.WAVES, { [bucket]: { uno: 1 } });
        assert.equal(res.ok, false);
        assert.match(res.reason, new RegExp(`^${bucket} no es un array`));
    }
}));

// -----------------------------------------------------------------------------
// CA-A5 · El payload legitimo pasa: la cota no puede ser un freno de mano
// -----------------------------------------------------------------------------

test('CA-A5: un payload legitimo se acepta en el round-trip completo (write + read)', () => enTmp({ PIPELINE_OPSTATE_DURABLE: '1' }, () => {
    const { backend, degradaciones } = remoteBackend();
    const marker = markerLegitimo({ justification: 'habilito la ola 9.4 con los issues acordados' });

    assert.equal(backend.validateRemoteValue(backend.KEYS.PARTIAL_PAUSE, marker).ok, true);

    const escrito = backend.writeKey(backend.KEYS.PARTIAL_PAUSE, marker);
    assert.equal(escrito.ok, true);
    assert.equal(escrito.version, 1);

    const leido = backend.readKeyWithVersion(backend.KEYS.PARTIAL_PAUSE);
    assert.deepEqual(leido.value, marker);
    assert.equal(leido.degraded, false);
    assert.equal(leido.error, null);
    assert.equal(backend.existsKey(backend.KEYS.PARTIAL_PAUSE), true);
    assert.equal(degradaciones.length, 0, 'un estado legitimo no genera ruido de degradacion');
    assert.equal(backend.getLastDegradation(), null);
}));

test('CA-A5: un registro de olas realista (decenas de olas y dependencias) pasa la cota', () => enTmp({ PIPELINE_OPSTATE_DURABLE: '1' }, () => {
    const { backend } = remoteBackend();
    const estado = {
        version: '1.0',
        meta: { created_at: ISO, updated_at: ISO, updated_by: 'test', source: 'fixture' },
        active_wave: { wave_number: 9.4, wave_name: 'Ola 9.4', issues: issues(40, 5100) },
        planned_waves: Array.from({ length: 30 }, (_, i) => ({
            wave_number: i, wave_name: `Ola ${i}`, goal: 'objetivo de la ola', issues: issues(25, 1000 + i * 25),
        })),
        archived_waves: [],
        dependencies: Array.from({ length: 60 }, (_, i) => ({ from: 5100 + i, to: 5200 + i, kind: 'hard' })),
    };

    assert.equal(backend.validateRemoteValue(backend.KEYS.WAVES, estado).ok, true);
    assert.equal(backend.writeKey(backend.KEYS.WAVES, estado).ok, true);
    assert.deepEqual(backend.readKey(backend.KEYS.WAVES), estado);
}));
