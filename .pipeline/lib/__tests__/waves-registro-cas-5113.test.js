// =============================================================================
// waves-registro-cas-5113.test.js — CA-A4 sobre el CAMINO REAL de mutación del
// REGISTRO DE OLAS.
//
// Es el espejo de `partial-pause-allowlist-cas-5113.test.js` para la otra mitad
// del criterio. CA-A4 dice, textual: "Todo read-modify-write de allowlist Y DE
// REGISTRO DE OLAS pasa por compareAndSet con expectedVersion". La primera
// pasada cerró la mitad de la allowlist; la mitad del registro de olas quedó con
// el mismo defecto intacto, y QA lo reprodujo:
//
//   SEED  -> ola 1 en el store: [1] (version 1)
//   [1] hostA leyo el registro de olas: [1] (version 1)
//   [2] hostB agrega el issue 200 -> store ahora [1,200] (version 2)
//   [3] hostA agrega el issue 100 -> ACEPTADO (no hubo conflicto)
//   ESTADO FINAL: [1,100]  <- el alta de hostB se perdio EN SILENCIO
//
// La causa: los mutadores calientes del Pulpo (`addIssueToWave`,
// `markIssuesCompletedInActiveWave`, `setWaveStalled`, …) nunca pasaron
// `metadata.expectedVersion` — que es el If-Match OPCIONAL del dominio (#4372),
// no un CAS. Sin él, el backend rellena el hueco con la versión que él mismo
// relee un instante antes del `putItem`, así que la `ConditionExpression` se
// cumple SIEMPRE y el write es efectivamente incondicional.
//
// Estos tests ejercitan la API pública de olas (la que llama el Pulpo), no el
// backend: el backend ya tiene su suite y prueba que el CAS funciona cuando
// alguien le pasa la versión a mano. Acá se prueba lo que CA-A4 pide de verdad,
// que es que los mutadores se la pasen.
//
// Ejecutar:
//   node --test .pipeline/lib/__tests__/waves-registro-cas-5113.test.js
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
const WAVES_PATH = require.resolve('../waves');

const PROJECT_ID = 'intrale-platform';
const SK_WAVES = 'coord#waves';

/** Estado inicial válido: ola 1 activa con un solo issue. */
function seedState(issues) {
    const ahora = new Date().toISOString();
    return {
        version: '1.0',
        meta: {
            created_at: ahora, updated_at: ahora, updated_by: 'test', source: 'fixture',
            next_wave_number: 2,
        },
        active_wave: {
            number: 1,
            name: 'ola de prueba',
            started_at: ahora,
            issues: issues.map((n) => ({ number: n })),
        },
        planned_waves: [],
        archived_waves: [],
        dependencies: [],
    };
}

/**
 * Una "instancia del pipeline": su propia carpeta local (⇒ su propio lockfile,
 * o sea otro host) y su propia copia del par `waves` + `operational-state-backend`,
 * contra el MISMO objeto driver. Compartir el store sin compartir el índice de
 * versiones en memoria es exactamente lo que hace observable el lost update.
 *
 * @param {object} driver
 * @param {string} dir  carpeta local de esta instancia
 */
function montarInstancia(driver, dir) {
    return withEnv({ PIPELINE_DIR_OVERRIDE: dir, PIPELINE_OPSTATE_DURABLE: '1' }, () => {
        delete require.cache[BACKEND_PATH];
        delete require.cache[WAVES_PATH];
        // eslint-disable-next-line global-require
        const backend = require('../operational-state-backend');
        backend._setDriverForTests({
            driver,
            spec: { type: 'dynamodb_table', tableName: 'tabla-fake', keys: [] },
            projectId: PROJECT_ID,
            instanceId: PROJECT_ID,
            atomicUpdate: true,
        });
        // eslint-disable-next-line global-require
        const waves = require('../waves');
        return {
            backend,
            waves,
            dir,
            /** Corre `fn` con el entorno (carpeta local) de ESTA instancia. */
            en(fn) {
                return withEnv(
                    { PIPELINE_DIR_OVERRIDE: dir, PIPELINE_OPSTATE_DURABLE: '1' },
                    () => fn(waves, backend),
                );
            },
        };
    });
}

/**
 * Envuelve un driver para disparar `fn()` UNA sola vez, justo después de la
 * primera lectura del registro de olas. Es la interposición que vuelve
 * determinista la carrera entre el snapshot del dominio y su escritura.
 */
function interponerTrasPrimeraLectura(driver, fn) {
    let disparado = false;
    return {
        ...driver,
        getItem(spec, key) {
            const res = driver.getItem(spec, key);
            if (!disparado && key && String(key.SK).includes('waves')) {
                disparado = true;
                fn();
            }
            return res;
        },
    };
}

/** Registro de olas tal como está en el store, sin pasar por ningún caché. */
function olasEnElStore(driver) {
    const raw = driver._raw(PROJECT_ID, SK_WAVES);
    if (!raw) return null;
    const activa = raw.body.value.active_wave;
    return {
        issues: (activa && activa.issues ? activa.issues : []).map((i) => Number(i.number)),
        version: raw.body.version,
    };
}

/** Dos carpetas locales distintas = dos lockfiles distintos = dos hosts. */
function conDosHosts(fn) {
    const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'waves-cas-5113-a-'));
    const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'waves-cas-5113-b-'));
    try {
        return fn(dirA, dirB);
    } finally {
        for (const d of [dirA, dirB]) {
            try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
        }
    }
}

/** Siembra el registro de olas en el store con la versión 1. */
function sembrar(host, issues) {
    const res = host.en((_w, backend) => backend.writeKey(backend.KEYS.WAVES, seedState(issues), 0));
    assert.equal(res.ok, true, 'el seed del registro de olas se escribió');
    return res;
}

// -----------------------------------------------------------------------------
// CA-A4 · el vector reportado por QA, literal
// -----------------------------------------------------------------------------

test('CA-A4: el alta de otra instancia NO se pierde — el add con versión stale se rechaza', () => conDosHosts((dirA, dirB) => {
    const store = createFakeSyncDynamoDriver();
    const hostB = montarInstancia(store, dirB);
    sembrar(hostB, [1]);

    // Entre la lectura de A y su escritura, B agrega el issue 200.
    let altaDeB = null;
    const driverA = interponerTrasPrimeraLectura(store, () => {
        altaDeB = hostB.en((w) => w.addIssueToWave(1, { number: 200 }, { source: 'hostB' }));
    });
    const hostA = montarInstancia(driverA, dirA);

    assert.throws(
        () => hostA.en((w) => w.addIssueToWave(1, { number: 100 }, { source: 'hostA' })),
        (err) => err.code === 'EWAVES_VERSION_CONFLICT',
        'el alta de A sobre una foto vieja se rechaza por conflicto, no se aplica en silencio',
    );

    assert.equal(altaDeB && altaDeB.added, true, 'el alta del host B sí se aplicó');
    const final = olasEnElStore(store);
    assert.deepEqual(final.issues, [1, 200],
        'ninguna de las dos altas se pierde silenciosamente: la de B sigue en la ola');
    assert.equal(final.version, 2, 'la versión vigente es la del host B');
}));

test('CA-A4: el cierre de issues con versión stale no revierte lo que otra instancia escribió', () => conDosHosts((dirA, dirB) => {
    const store = createFakeSyncDynamoDriver();
    const hostB = montarInstancia(store, dirB);
    sembrar(hostB, [1, 2]);

    const driverA = interponerTrasPrimeraLectura(store, () => {
        hostB.en((w) => w.addIssueToWave(1, { number: 300 }, { source: 'hostB' }));
    });
    const hostA = montarInstancia(driverA, dirA);

    // `markIssuesCompletedInActiveWave` es uno de los mutadores calientes:
    // lo llaman `pulpo.js` y `wave-dispatch.js` en cada tick.
    assert.throws(
        () => hostA.en((w) => w.markIssuesCompletedInActiveWave([1], { source: 'hostA' })),
        (err) => err.code === 'EWAVES_VERSION_CONFLICT',
    );

    assert.deepEqual(olasEnElStore(store).issues, [1, 2, 300],
        'el alta de B sobrevive: A no pisó el registro con su foto vieja');
}));

test('CA-A4: setWaveStalled tampoco escribe sin condición de versión', () => conDosHosts((dirA, dirB) => {
    const store = createFakeSyncDynamoDriver();
    const hostB = montarInstancia(store, dirB);
    sembrar(hostB, [1]);

    const driverA = interponerTrasPrimeraLectura(store, () => {
        hostB.en((w) => w.addIssueToWave(1, { number: 200 }, { source: 'hostB' }));
    });
    const hostA = montarInstancia(driverA, dirA);

    assert.throws(
        () => hostA.en((w) => w.setWaveStalled(1, { reason: 'sin agentes', updated_by: 'hostA' })),
        (err) => err.code === 'EWAVES_VERSION_CONFLICT',
    );
    assert.deepEqual(olasEnElStore(store).issues, [1, 200]);
}));

// -----------------------------------------------------------------------------
// Anti-regresión estructural: la condición que efectivamente viaja al driver
// -----------------------------------------------------------------------------

test('CA-A4 (caso negativo): el putItem de las olas lleva la versión del SNAPSHOT, no una releída', () => conDosHosts((dirA) => {
    const store = createFakeSyncDynamoDriver();
    const host = montarInstancia(store, dirA);
    sembrar(host, [1]);

    host.en((w) => w.addIssueToWave(1, { number: 2 }, { source: 'unico' }));

    const puts = store._calls.filter((c) => c.op === 'putItem');
    assert.equal(puts.length, 2, 'seed + el add');
    assert.equal(puts[0].condOpts.conditionExpression, 'attribute_not_exists(#pk)',
        'la creación del registro de olas es create-once: un solo ganador entre hosts');
    assert.equal(puts[1].condOpts.conditionExpression, '#b.#v = :ev',
        'la mutación sale como compare-and-set, NO como write incondicional');
    assert.equal(puts[1].condOpts.expressionAttributeValues[':ev'], 1,
        'la condición usa la versión que el mutador leyó, que es sobre la que decidió');
}));

test('CA-A4 (caso negativo): la escritura stale ni siquiera llega al driver', () => conDosHosts((dirA, dirB) => {
    // El discriminante real. Si el mutador NO propaga `expectedVersion`, el
    // backend rellena el hueco con la versión que relee un instante antes del
    // `putItem`, la condición se cumple y aparece un TERCER `putItem` (con
    // `:ev` = 2, la versión de B) que pisa el estado. Con la versión del
    // snapshot, el conflicto se detecta antes y ese putItem no existe.
    const store = createFakeSyncDynamoDriver();
    const hostB = montarInstancia(store, dirB);
    sembrar(hostB, [1]);

    const driverA = interponerTrasPrimeraLectura(store, () => {
        hostB.en((w) => w.addIssueToWave(1, { number: 200 }, { source: 'hostB' }));
    });
    const hostA = montarInstancia(driverA, dirA);
    try {
        hostA.en((w) => w.addIssueToWave(1, { number: 100 }, { source: 'hostA' }));
    } catch { /* el conflicto es el punto del test; se asserta abajo por los puts */ }

    const puts = store._calls.filter((c) => c.op === 'putItem');
    assert.equal(puts.length, 2, 'sólo el seed y el write legítimo de B llegaron al store');
    assert.ok(
        !puts.some((p) => p.condOpts
            && p.condOpts.expressionAttributeValues
            && p.condOpts.expressionAttributeValues[':ev'] === 2),
        'ningún putItem viajó con la versión RELEÍDA por el backend (write incondicional encubierto)',
    );
}));

test('CA-A4: la creación concurrente del registro de olas tiene un solo ganador', () => conDosHosts((dirA, dirB) => {
    const store = createFakeSyncDynamoDriver();
    const hostB = montarInstancia(store, dirB);

    // A arranca sobre partición vacía; B crea el registro en el medio.
    const driverA = interponerTrasPrimeraLectura(store, () => {
        hostB.en((w) => w.ensureWavesFile());
    });
    const hostA = montarInstancia(driverA, dirA);
    const res = hostA.en((w) => w.ensureWavesFile());

    assert.equal(res.created, false, 'el segundo creador no pisa al primero');
    assert.equal(res.reason, 'exists');
    assert.equal(olasEnElStore(store).version, 1, 'hubo una sola creación');
}));

// -----------------------------------------------------------------------------
// CA-A7 · degradación del sustrato → NO se escribe (fail-closed)
// -----------------------------------------------------------------------------

test('CA-A7: si el store degrada, el registro de olas no se pisa con el estado vacío', () => conDosHosts((dirA) => {
    const store = createFakeSyncDynamoDriver();
    const host = montarInstancia(store, dirA);
    sembrar(host, [1, 2, 3]);

    // Con el store caído, `loadWaves()` degrada a `emptyState()`. Sin el
    // fail-closed, el mutador escribiría ESE estado vacío encima del real y se
    // llevaría puesta la ola entera.
    store._setFailure(new Error('DynamoDB no responde'));
    assert.throws(
        () => host.en((w) => w.save({ updated_by: 'hostA', source: 'con el store caído' })),
        (err) => err.code === 'EWAVES_STORE' || /degrad/i.test(err.message),
        'no se persiste un estado que no se pudo leer',
    );

    store._clearFailure();
    assert.deepEqual(olasEnElStore(store).issues, [1, 2, 3], 'la ola quedó intacta');
    assert.equal(olasEnElStore(store).version, 1, 'no hubo ningún write durante la degradación');
}));

test('CA-A4: un state armado a mano no puede persistirse sin versión del sustrato', () => conDosHosts((dirA) => {
    const store = createFakeSyncDynamoDriver();
    const host = montarInstancia(store, dirA);
    sembrar(host, [1]);

    // El state no salió de `loadWaves()`, así que no trae versión adosada: el
    // write saldría sin condición. Se rechaza ruidosamente en vez de
    // reintroducir el lost update en silencio.
    assert.throws(
        () => host.en((w) => w._internal.saveState(seedState([1, 2]), { updated_by: 'hostA' })),
        (err) => err.code === 'EWAVES_NO_CAS_VERSION',
    );
    assert.deepEqual(olasEnElStore(store).issues, [1], 'el registro no cambió');
}));

// -----------------------------------------------------------------------------
// El If-Match del dominio (#4372) sigue mandando cuando el caller lo pasa
// -----------------------------------------------------------------------------

test('#4372 sigue vigente: el If-Match explícito del caller tiene precedencia', () => conDosHosts((dirA) => {
    const store = createFakeSyncDynamoDriver();
    const host = montarInstancia(store, dirA);
    sembrar(host, [1]);

    // If-Match stale (un ISO que no es el vigente) ⇒ conflicto ANTES de escribir.
    assert.throws(
        () => host.en((w) => w.addIssueToWave(1, { number: 2 }, {
            expectedVersion: '1999-01-01T00:00:00.000Z',
        })),
        (err) => err.code === 'EWAVES_VERSION_CONFLICT',
    );

    // If-Match vigente ⇒ pasa.
    const vigente = host.en((w) => w.loadWaves().meta.updated_at);
    const ok = host.en((w) => w.addIssueToWave(1, { number: 2 }, { expectedVersion: vigente }));
    assert.equal(ok.added, true);
    assert.deepEqual(olasEnElStore(store).issues, [1, 2]);
}));

// -----------------------------------------------------------------------------
// La versión adosada no contamina el estado persistido
// -----------------------------------------------------------------------------

test('la versión adosada es invisible al estado que se persiste y al integrity_hash', () => conDosHosts((dirA) => {
    const store = createFakeSyncDynamoDriver();
    const host = montarInstancia(store, dirA);
    sembrar(host, [1]);
    host.en((w) => w.addIssueToWave(1, { number: 2 }, { source: 'unico' }));

    const persistido = store._raw(PROJECT_ID, SK_WAVES).body.value;
    assert.deepEqual(Object.getOwnPropertySymbols(persistido), [],
        'el ítem del store no arrastra ninguna clave de símbolo');
    assert.deepEqual(
        Object.keys(persistido).sort(),
        ['active_wave', 'archived_waves', 'dependencies', 'integrity_hash', 'meta', 'planned_waves', 'version'],
        'el shape persistido es exactamente el de siempre',
    );

    // El sello de integridad sigue verificando: si el símbolo entrara en
    // `canonicalStringify`, el hash recomputado al leer no coincidiría.
    const verif = host.en((w) => w.verifyIntegrityHash(persistido));
    assert.equal(verif.status, 'ok', 'el integrity_hash no se ve afectado por la versión adosada');
    assert.doesNotThrow(() => host.en((w) => w.loadStateStrict()));
}));

test('la versión adosada sobrevive al spread: un state re-armado sigue condicionando el write', () => conDosHosts((dirA, dirB) => {
    const store = createFakeSyncDynamoDriver();
    const hostB = montarInstancia(store, dirB);
    sembrar(hostB, [1]);

    const driverA = interponerTrasPrimeraLectura(store, () => {
        hostB.en((w) => w.addIssueToWave(1, { number: 200 }, { source: 'hostB' }));
    });
    const hostA = montarInstancia(driverA, dirA);

    // `{...state}` copia los símbolos ENUMERABLES: es la razón por la que la
    // marca no es `enumerable: false`. Con un state re-armado así, el write
    // tiene que seguir saliendo condicionado.
    assert.throws(
        () => hostA.en((w) => {
            const copia = { ...w.loadWaves() };
            copia.active_wave.issues.push({ number: 100 });
            return w._internal.saveState(copia, { updated_by: 'hostA' });
        }),
        (err) => err.code === 'EWAVES_VERSION_CONFLICT',
    );
    assert.deepEqual(olasEnElStore(store).issues, [1, 200]);
}));

// -----------------------------------------------------------------------------
// Modo filesystem · el comportamiento NO cambia (el flag llega en false)
// -----------------------------------------------------------------------------

test('modo filesystem: propagar la versión es inocuo — las olas se mutan igual', () => conDosHosts((dirA) => {
    withEnv({ PIPELINE_DIR_OVERRIDE: dirA, PIPELINE_OPSTATE_DURABLE: '0' }, () => {
        delete require.cache[BACKEND_PATH];
        delete require.cache[WAVES_PATH];
        // eslint-disable-next-line global-require
        const w = require('../waves');

        fs.writeFileSync(path.join(dirA, 'waves.json'), JSON.stringify(seedState([1]), null, 2));

        assert.equal(w.addIssueToWave(1, { number: 2 }, { source: 'local' }).added, true);
        assert.equal(w.addIssueToWave(1, { number: 3 }, { source: 'local' }).added, true);

        const enDisco = JSON.parse(fs.readFileSync(path.join(dirA, 'waves.json'), 'utf8'));
        assert.deepEqual(enDisco.active_wave.issues.map((i) => i.number), [1, 2, 3],
            'dos writes consecutivos del mismo host, sin conflictos espurios');
    });
}));
