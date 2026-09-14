// =============================================================================
// operational-state-backend-5113.test.js — CA-A1 / CA-A4 / CA-A6 / CA-A9
//
// La capa de storage del estado operativo (#5113): round-trip por los dos modos,
// mapeo de versión ISO ↔ entero, CAS con expectedVersion y redacción previa a
// la escritura remota.
//
// Ejecutar:
//   node --test .pipeline/lib/__tests__/operational-state-backend-5113.test.js
// =============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createFakeSyncDynamoDriver } = require('./fixtures/fake-sync-dynamo-driver');
const { withEnv } = require('../test-helpers/with-env');

const BACKEND_PATH = require.resolve('../operational-state-backend');

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
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opstate-backend-5113-'));
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
 */
function remoteBackend() {
    const backend = freshBackend();
    const driver = createFakeSyncDynamoDriver();
    backend._setDriverForTests({
        driver,
        spec: { type: 'dynamodb_table', tableName: 'tabla-fake', keys: [] },
        projectId: PROJECT_ID,
        instanceId: PROJECT_ID,
        atomicUpdate: true,
    });
    return { backend, driver };
}

function stateWithIso(iso, extra = {}) {
    return {
        version: '1.0',
        meta: { created_at: iso, updated_at: iso, updated_by: 'test', source: 'fixture' },
        active_wave: null,
        planned_waves: [],
        archived_waves: [],
        dependencies: [],
        ...extra,
    };
}

// -----------------------------------------------------------------------------
// CA-A1 · round-trip por los dos modos, con la MISMA API
// -----------------------------------------------------------------------------

test('CA-A1: round-trip en modo filesystem — lo que se escribe es lo que se lee', () => enTmp({ PIPELINE_OPSTATE_DURABLE: '0' }, (dir) => {
    const backend = freshBackend();
    assert.equal(backend.isRemote(), false);

    assert.equal(backend.readKey(backend.KEYS.WAVES), null, 'sin estado previo lee null');

    const state = stateWithIso('2026-09-08T10:00:00.000Z');
    const res = backend.writeKey(backend.KEYS.WAVES, state, backend.UNCONDITIONAL_WRITE);
    assert.equal(res.ok, true);

    // El archivo existe físicamente y el contenido coincide.
    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'waves.json'), 'utf8'));
    assert.deepEqual(onDisk, state);
    assert.deepEqual(backend.readKey(backend.KEYS.WAVES), state);
}));

test('CA-A1: round-trip en modo remoto — la MISMA API resuelve contra el store', () => enTmp({ PIPELINE_OPSTATE_DURABLE: '1' }, (dir) => {
    const { backend, driver } = remoteBackend();
    assert.equal(backend.isRemote(), true);
    assert.equal(backend.readKey(backend.KEYS.WAVES), null, 'partición vacía lee null');

    const state = stateWithIso('2026-09-08T11:00:00.000Z');
    const res = backend.writeKey(backend.KEYS.WAVES, state, backend.UNCONDITIONAL_WRITE);
    assert.equal(res.ok, true);
    assert.equal(res.version, 1, 'primera escritura arranca en versión 1');

    assert.deepEqual(backend.readKey(backend.KEYS.WAVES), state);

    // Y NO se tocó el filesystem: el archivo local no existe (CA-C1).
    assert.equal(fs.existsSync(path.join(dir, 'waves.json')), false,
        'con el flag encendido NO se escribe el archivo local');

    // El ítem quedó en la partición del proyecto, con el SK canónico.
    const raw = driver._raw(PROJECT_ID, 'coord#waves');
    assert.ok(raw, 'el ítem vive bajo PK=projectId / SK=coord#waves');
    assert.equal(raw.entityType, 'coordination');
    assert.equal(raw.projectId, PROJECT_ID);
}));

test('CA-A1: la allowlist usa la misma superficie y su propia clave', () => enTmp({ PIPELINE_OPSTATE_DURABLE: '1' }, () => {
    const { backend, driver } = remoteBackend();
    const marker = { allowed_issues: [5113], allowed_skills: ['pipeline-dev'], source: 'telegram' };
    assert.equal(backend.writeKey(backend.KEYS.PARTIAL_PAUSE, marker, backend.UNCONDITIONAL_WRITE).ok, true);
    assert.deepEqual(backend.readKey(backend.KEYS.PARTIAL_PAUSE), marker);
    assert.ok(driver._raw(PROJECT_ID, 'coord#partial-pause'), 'SK propio de la allowlist');
    // Las dos claves NO se pisan.
    assert.equal(backend.readKey(backend.KEYS.WAVES), null);
}));

test('D-3 / SEC-7: `.paused` NO es una clave del backend y no puede resolverse', () => enTmp({ PIPELINE_OPSTATE_DURABLE: '0' }, () => {
    const backend = freshBackend();
    assert.equal(Object.values(backend.KEYS).includes('paused'), false);
    assert.equal(Object.keys(backend.FILE_FOR_KEY).includes('.paused'), false);
    for (const candidata of ['paused', '.paused', 'full-pause']) {
        assert.throws(() => backend.fileFor(candidata), /clave de estado desconocida/,
            `\`${candidata}\` no puede resolverse: el halt total es filesystem SIEMPRE (D-3)`);
    }
}));

// -----------------------------------------------------------------------------
// CA-A6 · mapeo de versión ISO ↔ entero incremental
// -----------------------------------------------------------------------------

test('CA-A6: el ISO se preserva en el value y el entero del store es el autoritativo', () => enTmp({ PIPELINE_OPSTATE_DURABLE: '1' }, () => {
    const { backend } = remoteBackend();
    const iso1 = '2026-09-08T12:00:00.000Z';
    assert.equal(backend.writeKey(backend.KEYS.WAVES, stateWithIso(iso1), backend.UNCONDITIONAL_WRITE).version, 1);

    const leido = backend.readKeyWithVersion(backend.KEYS.WAVES);
    assert.equal(leido.version, 1, 'la versión que se expone en remoto es el entero');
    assert.equal(leido.value.meta.updated_at, iso1, 'el ISO viaja intacto dentro del value');
    assert.equal(backend.isoVersionOf(leido.value), iso1);

    // Segundo write: el entero incrementa, el ISO nuevo se preserva.
    const iso2 = '2026-09-08T12:05:00.000Z';
    assert.equal(backend.writeKey(backend.KEYS.WAVES, stateWithIso(iso2), backend.UNCONDITIONAL_WRITE).version, 2);
    const leido2 = backend.readKeyWithVersion(backend.KEYS.WAVES);
    assert.equal(leido2.version, 2);
    assert.equal(leido2.value.meta.updated_at, iso2);
}));

test('CA-A6: round-trip del mapeo — un ISO vigente traduce al entero; uno stale es conflicto', () => enTmp({ PIPELINE_OPSTATE_DURABLE: '1' }, () => {
    const { backend } = remoteBackend();
    const iso = '2026-09-08T13:00:00.000Z';
    backend.writeKey(backend.KEYS.WAVES, stateWithIso(iso), backend.UNCONDITIONAL_WRITE);
    backend.readKeyWithVersion(backend.KEYS.WAVES); // refresca el índice

    const par = backend.versionPairOf(backend.KEYS.WAVES);
    assert.deepEqual(par, { intVersion: 1, isoVersion: iso });

    // ISO vigente → entero.
    assert.equal(backend.toRemoteExpectedVersion(backend.KEYS.WAVES, iso), 1);
    // Entero → tal cual.
    assert.equal(backend.toRemoteExpectedVersion(backend.KEYS.WAVES, 7), 7);
    // Sin If-Match → undefined (read-modify-write con la versión leída).
    assert.equal(backend.toRemoteExpectedVersion(backend.KEYS.WAVES, null), undefined);
    assert.equal(backend.toRemoteExpectedVersion(backend.KEYS.WAVES, undefined), undefined);
    // ISO stale → null, que el write traduce a conflicto.
    assert.equal(backend.toRemoteExpectedVersion(backend.KEYS.WAVES, '1999-01-01T00:00:00.000Z'), null);
}));

// -----------------------------------------------------------------------------
// CA-A4 · CAS con expectedVersion: el write stale se RECHAZA, no se aplica
// -----------------------------------------------------------------------------

test('CA-A4: un write con versión stale devuelve conflicto y NO pisa el estado', () => enTmp({ PIPELINE_OPSTATE_DURABLE: '1' }, () => {
    const { backend, driver } = remoteBackend();
    backend.writeKey(backend.KEYS.PARTIAL_PAUSE, { allowed_issues: [1] }, backend.UNCONDITIONAL_WRITE);   // v1
    backend.writeKey(backend.KEYS.PARTIAL_PAUSE, { allowed_issues: [1, 2] }, backend.UNCONDITIONAL_WRITE); // v2

    // Escritor con versión vieja (1): debe ser rechazado.
    const res = backend.writeKey(backend.KEYS.PARTIAL_PAUSE, { allowed_issues: [1, 99] }, 1);
    assert.equal(res.ok, false);
    assert.equal(res.conflict, true, 'el CAS rechaza el write stale');
    assert.equal(res.version, 2, 'devuelve la versión vigente para que el caller reintente');

    // El estado NO cambió: el alta del segundo escritor no se perdió.
    assert.deepEqual(backend.readKey(backend.KEYS.PARTIAL_PAUSE), { allowed_issues: [1, 2] });
    assert.equal(driver._raw(PROJECT_ID, 'coord#partial-pause').body.version, 2);
}));

test('CA-A4: un ISO stale como expectedVersion también es conflicto (If-Match del dominio)', () => enTmp({ PIPELINE_OPSTATE_DURABLE: '1' }, () => {
    const { backend } = remoteBackend();
    backend.writeKey(backend.KEYS.WAVES, stateWithIso('2026-09-08T14:00:00.000Z'), backend.UNCONDITIONAL_WRITE);
    backend.readKeyWithVersion(backend.KEYS.WAVES);
    backend.writeKey(backend.KEYS.WAVES, stateWithIso('2026-09-08T14:10:00.000Z'), backend.UNCONDITIONAL_WRITE);
    backend.readKeyWithVersion(backend.KEYS.WAVES);

    const res = backend.writeKey(
        backend.KEYS.WAVES, stateWithIso('2026-09-08T14:20:00.000Z'), '2026-09-08T14:00:00.000Z',
    );
    assert.equal(res.ok, false);
    assert.equal(res.conflict, true);
    // El estado vigente sigue siendo el segundo write.
    assert.equal(backend.readKey(backend.KEYS.WAVES).meta.updated_at, '2026-09-08T14:10:00.000Z');
}));

test('CA-A4: la condición que viaja al driver es el CAS por versión, no un write ciego', () => enTmp({ PIPELINE_OPSTATE_DURABLE: '1' }, () => {
    const { backend, driver } = remoteBackend();
    backend.writeKey(backend.KEYS.WAVES, stateWithIso('2026-09-08T15:00:00.000Z'), backend.UNCONDITIONAL_WRITE);
    backend.writeKey(backend.KEYS.WAVES, stateWithIso('2026-09-08T15:01:00.000Z'), backend.UNCONDITIONAL_WRITE);

    const puts = driver._calls.filter((c) => c.op === 'putItem');
    assert.equal(puts.length, 2);
    assert.equal(puts[0].condOpts.conditionExpression, 'attribute_not_exists(#pk)',
        'la creación es create-once: un solo ganador');
    assert.equal(puts[1].condOpts.conditionExpression, '#b.#v = :ev',
        'la actualización es compare-and-set por versión');
    assert.equal(puts[1].condOpts.expressionAttributeValues[':ev'], 1);
}));

test('CA-A4: delete condicional — no se borra un ítem que cambió bajo los pies', () => enTmp({ PIPELINE_OPSTATE_DURABLE: '1' }, () => {
    const { backend } = remoteBackend();
    backend.writeKey(backend.KEYS.PARTIAL_PAUSE, { allowed_issues: [1] }, backend.UNCONDITIONAL_WRITE);   // v1
    backend.writeKey(backend.KEYS.PARTIAL_PAUSE, { allowed_issues: [1, 2] }, backend.UNCONDITIONAL_WRITE); // v2

    const stale = backend.deleteKey(backend.KEYS.PARTIAL_PAUSE, 1);
    assert.equal(stale.ok, false);
    assert.equal(stale.conflict, true);
    assert.ok(backend.readKey(backend.KEYS.PARTIAL_PAUSE), 'el ítem sigue vivo');

    const ok = backend.deleteKey(backend.KEYS.PARTIAL_PAUSE, 2);
    assert.equal(ok.ok, true);
    assert.equal(ok.existed, true);
    assert.equal(backend.readKey(backend.KEYS.PARTIAL_PAUSE), null);
}));

// -----------------------------------------------------------------------------
// CA-A9 · redacción de secretos antes de la escritura remota
// -----------------------------------------------------------------------------

test('CA-A9: un token embebido en `justification` NO llega al ítem escrito', () => enTmp({ PIPELINE_OPSTATE_DURABLE: '1' }, () => {
    const { backend, driver } = remoteBackend();
    const token = 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'; // secret-scan:ignore — literal sintetico: es el insumo del test de redaccion (CA-A9)
    backend.writeKey(backend.KEYS.PARTIAL_PAUSE, {
        allowed_issues: [5113],
        justification: `habilito la ola con ${token} para el smoke`,
        source: 'telegram',
    }, backend.UNCONDITIONAL_WRITE);

    const raw = driver._raw(PROJECT_ID, 'coord#partial-pause');
    const serializado = JSON.stringify(raw);
    assert.equal(serializado.includes(token), false, 'el token no puede quedar persistido');
    assert.ok(raw.body.value.justification.length > 0, 'el campo sigue existiendo, redactado');
}));

test('CA-A9: la redacción NO destruye texto normal ni campos ajenos', () => enTmp({ PIPELINE_OPSTATE_DURABLE: '0' }, () => {
    const backend = freshBackend();
    const value = {
        allowed_issues: [5113, 5126],
        justification: 'add issue #5113 -> ola 9.4',
        source: 'telegram',
        wave_name: 'Ola 9.4',
    };
    const out = backend.redactBeforeWrite(value);
    assert.equal(out.justification, 'add issue #5113 -> ola 9.4');
    assert.equal(out.source, 'telegram');
    assert.deepEqual(out.allowed_issues, [5113, 5126]);
    assert.equal(out.wave_name, 'Ola 9.4');
}));

// -----------------------------------------------------------------------------
// CA-C1 · el flag es ÚNICO: gatea lectura y escritura juntas
// -----------------------------------------------------------------------------

test('CA-C1: el flag es único — con él encendido no queda camino de lectura al filesystem', () => enTmp({ PIPELINE_OPSTATE_DURABLE: '1' }, (dir) => {
    // Estado local PREEXISTENTE, con contenido distinguible.
    fs.writeFileSync(path.join(dir, 'waves.json'),
        JSON.stringify(stateWithIso('1999-01-01T00:00:00.000Z')));
    fs.writeFileSync(path.join(dir, '.partial-pause.json'),
        JSON.stringify({ allowed_issues: [666] }));

    const { backend } = remoteBackend();

    // Con el flag ON, el estado local es INVISIBLE: se lee el store (vacío).
    assert.equal(backend.readKey(backend.KEYS.WAVES), null,
        'el archivo local NO se lee cuando el flag está encendido');
    assert.equal(backend.readKey(backend.KEYS.PARTIAL_PAUSE), null);
    assert.equal(backend.existsKey(backend.KEYS.PARTIAL_PAUSE), false);

    // Y las escrituras tampoco vuelven al archivo: sigue con el contenido viejo.
    backend.writeKey(backend.KEYS.PARTIAL_PAUSE, { allowed_issues: [5113] }, backend.UNCONDITIONAL_WRITE);
    const local = JSON.parse(fs.readFileSync(path.join(dir, '.partial-pause.json'), 'utf8'));
    assert.deepEqual(local, { allowed_issues: [666] },
        'el archivo local no se toca: no hay dos fuentes de verdad');
    assert.deepEqual(backend.readKey(backend.KEYS.PARTIAL_PAUSE), { allowed_issues: [5113] });
}));

test('CA-C1 / R8: apagar el flag devuelve el pipeline a filesystem sin perder el archivo local', () => enTmp({ PIPELINE_OPSTATE_DURABLE: '1' }, (dir) => {
    fs.writeFileSync(path.join(dir, '.partial-pause.json'),
        JSON.stringify({ allowed_issues: [4242] }));
    const { backend } = remoteBackend();
    backend.writeKey(backend.KEYS.PARTIAL_PAUSE, { allowed_issues: [5113] }, backend.UNCONDITIONAL_WRITE);

    // Rollback: se baja el flag (equivale a `durable: false` + restart).
    withEnv({ PIPELINE_OPSTATE_DURABLE: '0' }, () => {
        backend.invalidateConfigCache();
        assert.equal(backend.isRemote(), false);
        assert.deepEqual(backend.readKey(backend.KEYS.PARTIAL_PAUSE), { allowed_issues: [4242] },
            'vuelve a operar desde filesystem con el estado local consistente');
    });
}));

test('CA-C1: el flag es estricto — sólo el booleano `true` exacto enciende el modo remoto', () => enTmp({ PIPELINE_OPSTATE_DURABLE: '0' }, () => {
    const backend = freshBackend();
    for (const valor of ['1', 'true', 'sí', 'yes', '0', '']) {
        if (valor === '1') continue; // el override por env sí acepta '1' a propósito
        withEnv({ PIPELINE_OPSTATE_DURABLE: valor }, () => {
            assert.equal(backend.isRemote(), false,
                `PIPELINE_OPSTATE_DURABLE=${JSON.stringify(valor)} NO debe encender el modo remoto`);
        });
    }
}));

// -----------------------------------------------------------------------------
// CA-B2 · sin escritura condicional NO se escribe
//
// `buildCasWriteOptions()` devuelve `{}` cuando `atomicUpdate` es falso: la
// escritura saldria sin `ConditionExpression`, o sea a ciegas. En regimen
// remoto el CAS ES la exclusion mutua (`withLockSync` es local por PID y entre
// hosts no excluye nada), asi que escribir sin condicion no es "un poco menos
// seguro": es simular una garantia inexistente y reabrir el lost update en
// silencio.
//
// El driver real afirma `atomicUpdate: true` explicito, pero
// `kernel-coordination-store.js` lo DERIVA de `!isInMemory`. Un driver futuro
// que repita esa derivacion degradaria el CAS sin que nadie se entere, y por eso
// la garantia se verifica en el PUNTO DE USO en vez de asumirse.
// -----------------------------------------------------------------------------

test('CA-B2: con `atomicUpdate` falso la escritura remota se RECHAZA, no sale a ciegas', () => enTmp({ PIPELINE_OPSTATE_DURABLE: '1' }, () => {
    const backend = freshBackend();
    const driver = createFakeSyncDynamoDriver();
    backend._setDriverForTests({
        driver,
        spec: { type: 'dynamodb_table', tableName: 'tabla-fake', keys: [] },
        projectId: PROJECT_ID,
        instanceId: PROJECT_ID,
        atomicUpdate: false,   // <- el driver NO garantiza escritura condicional
    });

    const res = backend.writeKey(backend.KEYS.PARTIAL_PAUSE, { allowed_issues: [5113] }, backend.UNCONDITIONAL_WRITE);
    assert.equal(res.ok, false, 'sin CAS la escritura no puede prosperar');
    assert.ok(res.error instanceof Error);
    assert.match(res.error.message, /CA-B2|atomicUpdate|condicional/i,
        'el error tiene que nombrar la garantia que falta, no ser un fallo generico');

    // Y lo que importa de verdad: NO se escribio nada en el store.
    assert.equal(backend.readKey(backend.KEYS.PARTIAL_PAUSE), null,
        'una escritura rechazada no puede haber dejado el item igual');
}));

test('CA-B2: la baja remota tambien exige CAS — un delete ciego borra lo que otro escribio', () => enTmp({ PIPELINE_OPSTATE_DURABLE: '1' }, () => {
    // Primero se escribe CON garantia, para tener algo que borrar.
    const backend = freshBackend();
    const driver = createFakeSyncDynamoDriver();
    const montar = (atomicUpdate) => backend._setDriverForTests({
        driver,
        spec: { type: 'dynamodb_table', tableName: 'tabla-fake', keys: [] },
        projectId: PROJECT_ID,
        instanceId: PROJECT_ID,
        atomicUpdate,
    });

    montar(true);
    assert.equal(backend.writeKey(backend.KEYS.PARTIAL_PAUSE, { allowed_issues: [5113] }, backend.UNCONDITIONAL_WRITE).ok, true);

    // Ahora degrada la garantia: el delete tiene que negarse.
    montar(false);
    const res = backend.deleteKey(backend.KEYS.PARTIAL_PAUSE);
    assert.equal(res.ok, false, 'sin CAS no se borra: podria pisar la baja de otra instancia');

    montar(true);
    assert.deepEqual(backend.readKey(backend.KEYS.PARTIAL_PAUSE), { allowed_issues: [5113] },
        'el item sigue vivo: el delete rechazado no borro nada');
}));

test('CA-B2: `atomicUpdate` se exige ESTRICTO — un truthy cualquiera no alcanza', () => enTmp({ PIPELINE_OPSTATE_DURABLE: '1' }, () => {
    // Mismo criterio fail-closed que el flag de cutover: la garantia se declara
    // con el booleano exacto. `'true'`, `1` o `{}` son formas de "creo que si".
    for (const valor of ['true', 1, {}, 'si', undefined, null]) {
        const backend = freshBackend();
        backend._setDriverForTests({
            driver: createFakeSyncDynamoDriver(),
            spec: { type: 'dynamodb_table', tableName: 'tabla-fake', keys: [] },
            projectId: PROJECT_ID,
            instanceId: PROJECT_ID,
            atomicUpdate: valor,
        });
        const res = backend.writeKey(backend.KEYS.WAVES, stateWithIso('2026-09-08T12:00:00.000Z'), backend.UNCONDITIONAL_WRITE);
        assert.equal(res.ok, false,
            `atomicUpdate=${JSON.stringify(valor)} NO puede habilitar la escritura remota`);
    }
}));

// -----------------------------------------------------------------------------
// CA-B5 · el estado remoto queda aislado por `projectId`
//
// Es la composicion de las dos dimensiones ortogonales: la §12 del contrato
// (#5110) decide COMO se particiona el estado; la §13 (#5113) decide DONDE vive.
// En modo remoto la particion es la PK del item, y tiene que aislar igual de
// fuerte que las carpetas separadas del modo filesystem.
//
// Si no aislara, dos proyectos compartirian registro de olas y allowlist: el
// dispatch de uno decidiria sobre el backlog del otro.
// -----------------------------------------------------------------------------

test('CA-B5: dos proyectos escriben el mismo key sin pisarse (aislados por PK)', () => enTmp({ PIPELINE_OPSTATE_DURABLE: '1' }, () => {
    // Un solo store fisico compartido: es el escenario real del multi-instancia.
    const driver = createFakeSyncDynamoDriver();
    const spec = { type: 'dynamodb_table', tableName: 'tabla-fake', keys: [] };

    const montar = (projectId) => {
        const backend = freshBackend();
        backend._setDriverForTests({ driver, spec, projectId, instanceId: projectId, atomicUpdate: true });
        return backend;
    };

    const alfa = montar('proyecto-alfa');
    assert.equal(alfa.writeKey(alfa.KEYS.PARTIAL_PAUSE, { allowed_issues: [111] }, alfa.UNCONDITIONAL_WRITE).ok, true);

    const beta = montar('proyecto-beta');
    // Beta no ve nada: su particion esta vacia aunque el store ya tenga datos.
    assert.equal(beta.readKey(beta.KEYS.PARTIAL_PAUSE), null,
        'un proyecto no puede leer la allowlist de otro');
    assert.equal(beta.writeKey(beta.KEYS.PARTIAL_PAUSE, { allowed_issues: [222] }, beta.UNCONDITIONAL_WRITE).ok, true);

    // Y la escritura de beta no piso la de alfa.
    const alfa2 = montar('proyecto-alfa');
    assert.deepEqual(alfa2.readKey(alfa2.KEYS.PARTIAL_PAUSE), { allowed_issues: [111] },
        'la allowlist de alfa sobrevive intacta a la escritura de beta');

    const beta2 = montar('proyecto-beta');
    assert.deepEqual(beta2.readKey(beta2.KEYS.PARTIAL_PAUSE), { allowed_issues: [222] });
}));

test('CA-B5: el aislamiento vale tambien para el registro de olas', () => enTmp({ PIPELINE_OPSTATE_DURABLE: '1' }, () => {
    const driver = createFakeSyncDynamoDriver();
    const spec = { type: 'dynamodb_table', tableName: 'tabla-fake', keys: [] };
    const montar = (projectId) => {
        const backend = freshBackend();
        backend._setDriverForTests({ driver, spec, projectId, instanceId: projectId, atomicUpdate: true });
        return backend;
    };

    const alfa = montar('proyecto-alfa');
    alfa.writeKey(alfa.KEYS.WAVES, stateWithIso('2026-09-08T10:00:00.000Z'), alfa.UNCONDITIONAL_WRITE);

    const beta = montar('proyecto-beta');
    assert.equal(beta.readKey(beta.KEYS.WAVES), null, 'beta arranca sin olas propias');

    // La version es POR PARTICION: beta arranca en 1, no continua la de alfa.
    const res = beta.writeKey(beta.KEYS.WAVES, stateWithIso('2026-09-08T11:00:00.000Z'), beta.UNCONDITIONAL_WRITE);
    assert.equal(res.ok, true);
    assert.equal(res.version, 1,
        'el contador de version no puede ser global: seria un canal entre proyectos');
}));
