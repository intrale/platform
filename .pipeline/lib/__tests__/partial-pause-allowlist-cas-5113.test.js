// =============================================================================
// partial-pause-allowlist-cas-5113.test.js — CA-A4 / SEC-5 sobre el CAMINO REAL
//
// El suite del backend (`operational-state-backend-5113.test.js`) prueba que el
// CAS funciona cuando alguien le pasa `expectedVersion` a mano. Esto prueba lo
// otro, que es lo que CA-A4 pide de verdad: que los MUTADORES DE LA ALLOWLIST
// se lo pasen. Sin este suite, el backend puede tener un CAS impecable y la
// allowlist escribirse igual de forma incondicional — que es exactamente el
// defecto que se coló en la primera pasada de #5113.
//
// Por qué importa: la allowlist es el único estado del pipeline que es un
// CONTROL DE ACCESO. Decide qué issues se entregan a agentes con capacidad de
// escribir código, abrir PRs y tocar AWS (precedente #5060: ~320 agentes
// despachados). Un lost update ahí no pierde un dato: revierte una autorización
// y evade el gate de autoría de #3625 por carrera, con el audit trail
// registrando "sin cambios" mientras hubo un removal efectivo.
//
// La carrera se reproduce de forma DETERMINISTA: el driver del host A tiene un
// gancho que, después de su primera lectura de la allowlist, deja escribir al
// host B. Es la ventana real del dominio (leer previous → gate → escribir), no
// la ventana interna del backend (getItem → putItem).
//
// Ejecutar:
//   node --test .pipeline/lib/__tests__/partial-pause-allowlist-cas-5113.test.js
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
const PARTIAL_PAUSE_PATH = require.resolve('../partial-pause');

const PROJECT_ID = 'intrale-platform';
const SK_ALLOWLIST = 'coord#partial-pause';

/**
 * Una "instancia del pipeline": su propia copia del par
 * `partial-pause` + `operational-state-backend`, con el driver que se le
 * inyecte. Dos instancias con el MISMO objeto driver comparten el store —
 * igual que dos hosts contra la misma tabla— pero NO comparten el índice de
 * versiones en memoria, que es justo lo que hace observable el lost update.
 *
 * @param {object} driver
 */
function montarInstancia(driver) {
    delete require.cache[BACKEND_PATH];
    delete require.cache[PARTIAL_PAUSE_PATH];
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
    const pp = require('../partial-pause');
    return { backend, pp };
}

/**
 * Envuelve un driver para disparar `fn()` UNA sola vez, justo después de la
 * primera lectura de la allowlist. Es la interposición que vuelve determinista
 * la carrera entre el snapshot del dominio y su escritura.
 *
 * @param {object} driver
 * @param {Function} fn
 */
function interponerTrasPrimeraLectura(driver, fn) {
    let disparado = false;
    return {
        ...driver,
        getItem(spec, key) {
            const res = driver.getItem(spec, key);
            if (!disparado && key && String(key.SK).includes('partial-pause')) {
                disparado = true;
                fn();
            }
            return res;
        },
    };
}

/** Estado de la allowlist tal como está en el store, sin pasar por ningún caché. */
function allowlistEnElStore(driver) {
    const raw = driver._raw(PROJECT_ID, SK_ALLOWLIST);
    if (!raw) return null;
    return { issues: raw.body.value.allowed_issues, version: raw.body.version };
}

function enTmp(env, fn) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-allowlist-cas-5113-'));
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

const REMOTO = { PIPELINE_OPSTATE_DURABLE: '1' };
const LOCAL = { PIPELINE_OPSTATE_DURABLE: '0' };

// -----------------------------------------------------------------------------
// CA-A4 · el vector completo: lost update + evasión del gate de autoría
// -----------------------------------------------------------------------------

test('CA-A4: el alta autorizada por otra instancia NO se pierde — el write stale se rechaza', () => enTmp(REMOTO, () => {
    const store = createFakeSyncDynamoDriver();
    const hostB = montarInstancia(store);

    // Semilla: la ola arranca con [1, 2].
    const seed = hostB.pp.setPartialPause([1, 2], {
        source: 'wave:promote', authorizedBy: 'wave-promote', justification: 'seed de la ola',
    });
    assert.equal(seed.ok, true);
    assert.deepEqual(allowlistEnElStore(store).issues, [1, 2]);

    // El host A trabaja con una vista que, entre su lectura y su escritura, queda
    // vieja: el host B suma el issue 3 CON autoría en el medio.
    let altaDeB = null;
    const driverA = interponerTrasPrimeraLectura(store, () => {
        altaDeB = hostB.pp.setPartialPause([1, 2, 3], {
            source: 'wave:promote', authorizedBy: 'wave-promote', justification: 'alta autorizada',
        });
    });
    const hostA = montarInstancia(driverA);

    // El host A reescribe la foto que leyó ANTES del alta de B, y sin autoría:
    // como su `previous` es [1,2] y su `current` es [1,2], el gate de #3625 no
    // ve removal alguno y lo deja pasar. Lo único que puede frenarlo es el CAS.
    const res = hostA.pp.setPartialPause([1, 2], {
        source: 'wave:promote', justification: 'escritura con foto vieja',
    });

    assert.equal(altaDeB && altaDeB.ok, true, 'el alta del host B sí se aplicó');
    assert.equal(res.ok, false, 'la escritura con versión stale NO se aplica');
    assert.equal(res.conflict, true, 'se rechaza por conflicto de versión, no en silencio');

    const final = allowlistEnElStore(store);
    assert.deepEqual(final.issues, [1, 2, 3],
        'ninguna de las dos altas se pierde: el issue 3 sigue en la ola');
    assert.equal(final.version, 2, 'la versión vigente es la del host B');
}));

test('CA-A4: el removal por carrera queda bloqueado — el gate de autoría no es evadible', () => enTmp(REMOTO, () => {
    const store = createFakeSyncDynamoDriver();
    const hostB = montarInstancia(store);
    hostB.pp.setPartialPause([1, 2, 3], {
        source: 'wave:promote', authorizedBy: 'wave-promote', justification: 'seed',
    });

    // B saca el 3 CON autoría; A viene con la foto de antes y lo re-agrega sin
    // autoría. Sin CAS, el estado del store termina siendo el de A: el removal
    // autorizado se revierte por carrera.
    const driverA = interponerTrasPrimeraLectura(store, () => {
        hostB.pp.setPartialPause([1, 2], {
            source: 'wave:promote', authorizedBy: 'wave-promote', justification: 'baja autorizada',
        });
    });
    const hostA = montarInstancia(driverA);

    const res = hostA.pp.setPartialPause([1, 2, 3], {
        source: 'wave:promote', justification: 'foto vieja',
    });
    assert.equal(res.ok, false);
    assert.equal(res.conflict, true);
    assert.deepEqual(allowlistEnElStore(store).issues, [1, 2],
        'la baja autorizada por B sigue vigente: el issue 3 NO volvió a la ola');
}));

test('CA-A4: setPartialPauseAtomic también condiciona por versión (mismo vector)', () => enTmp(REMOTO, () => {
    const store = createFakeSyncDynamoDriver();
    const hostB = montarInstancia(store);
    hostB.pp.setPartialPauseAtomic([1, 2], {
        source: 'wave:promote', authorizedBy: 'wave-promote', justification: 'seed',
    });

    const driverA = interponerTrasPrimeraLectura(store, () => {
        hostB.pp.setPartialPauseAtomic([1, 2, 3], {
            source: 'wave:promote', authorizedBy: 'wave-promote', justification: 'alta autorizada',
        });
    });
    const hostA = montarInstancia(driverA);

    const res = hostA.pp.setPartialPauseAtomic([1, 2], {
        source: 'wave:promote', justification: 'foto vieja',
    });
    assert.equal(res.ok, false);
    assert.equal(res.conflict, true);
    assert.deepEqual(allowlistEnElStore(store).issues, [1, 2, 3]);
}));

test('CA-A4: el clear masivo con versión stale no borra la allowlist ajena', () => enTmp(REMOTO, () => {
    const store = createFakeSyncDynamoDriver();
    const hostB = montarInstancia(store);
    hostB.pp.setPartialPause([1, 2], {
        source: 'wave:promote', authorizedBy: 'wave-promote', justification: 'seed',
    });

    const driverA = interponerTrasPrimeraLectura(store, () => {
        hostB.pp.setPartialPause([1, 2, 3], {
            source: 'wave:promote', authorizedBy: 'wave-promote', justification: 'alta autorizada',
        });
    });
    const hostA = montarInstancia(driverA);

    const res = hostA.pp.clearPartialPause({
        source: 'resume:operator', authorizedBy: 'resume:operator', justification: 'clear con foto vieja',
    });
    assert.equal(res.ok, false);
    assert.equal(res.conflict, true, 'el delete es condicional, no un unlink ciego');
    assert.deepEqual(allowlistEnElStore(store).issues, [1, 2, 3],
        'la allowlist que B acaba de mutar sigue en pie');
}));

// -----------------------------------------------------------------------------
// Anti-regresión estructural: la condición que efectivamente viaja al driver
// -----------------------------------------------------------------------------

test('CA-A4 (caso negativo): el putItem de la allowlist lleva la versión del SNAPSHOT, no una releída', () => enTmp(REMOTO, () => {
    const store = createFakeSyncDynamoDriver();
    const host = montarInstancia(store);

    host.pp.setPartialPause([1], {
        source: 'wave:promote', authorizedBy: 'wave-promote', justification: 'v1',
    });
    host.pp.setPartialPause([1, 2], {
        source: 'wave:promote', authorizedBy: 'wave-promote', justification: 'v2',
    });

    const puts = store._calls.filter((c) => c.op === 'putItem');
    assert.equal(puts.length, 2);
    assert.equal(puts[0].condOpts.conditionExpression, 'attribute_not_exists(#pk)',
        'la creación de la allowlist es create-once: un solo ganador entre hosts');
    assert.equal(puts[1].condOpts.conditionExpression, '#b.#v = :ev',
        'la actualización sale como compare-and-set, NO como write incondicional');
    assert.equal(puts[1].condOpts.expressionAttributeValues[':ev'], 1,
        'la condición usa la versión que el mutador leyó, que es la que evaluó el gate');
}));

test('CA-A4 (caso negativo): la escritura stale ni siquiera llega al driver', () => enTmp(REMOTO, () => {
    // El discriminante real: si el mutador NO propaga `expectedVersion`, el
    // backend rellena el hueco con la versión que él mismo relee un instante
    // antes del `putItem`, la condición se cumple siempre y aparece un TERCER
    // `putItem` (con `:ev` = la versión de B) que pisa el estado. Con el
    // `expectedVersion` del snapshot, el conflicto se detecta antes y ese
    // putItem no existe.
    const store = createFakeSyncDynamoDriver();
    const hostB = montarInstancia(store);
    hostB.pp.setPartialPause([1, 2], {
        source: 'wave:promote', authorizedBy: 'wave-promote', justification: 'v1',
    });

    const driverA = interponerTrasPrimeraLectura(store, () => {
        hostB.pp.setPartialPause([1, 2, 3], {
            source: 'wave:promote', authorizedBy: 'wave-promote', justification: 'v2',
        });
    });
    const hostA = montarInstancia(driverA);
    hostA.pp.setPartialPause([1, 2], { source: 'wave:promote', justification: 'foto vieja' });

    const puts = store._calls.filter((c) => c.op === 'putItem');
    assert.equal(puts.length, 2, 'sólo los dos writes legítimos de B llegaron al store');
    assert.ok(
        !puts.some((p) => p.condOpts
            && p.condOpts.expressionAttributeValues
            && p.condOpts.expressionAttributeValues[':ev'] === 2),
        'ningún putItem viajó con la versión RELEÍDA por el backend (write incondicional encubierto)',
    );
}));

test('CA-A4: la creación concurrente de la allowlist tiene un solo ganador', () => enTmp(REMOTO, () => {
    const store = createFakeSyncDynamoDriver();
    const hostB = montarInstancia(store);

    // A arranca sobre partición vacía; B crea la allowlist en el medio.
    const driverA = interponerTrasPrimeraLectura(store, () => {
        hostB.pp.setPartialPause([7], {
            source: 'wave:promote', authorizedBy: 'wave-promote', justification: 'crea primero',
        });
    });
    const hostA = montarInstancia(driverA);

    const res = hostA.pp.setPartialPause([9], {
        source: 'wave:promote', authorizedBy: 'wave-promote', justification: 'crea segundo',
    });
    assert.equal(res.ok, false, 'el segundo creador no pisa al primero');
    assert.equal(res.conflict, true);
    assert.deepEqual(allowlistEnElStore(store).issues, [7]);
}));

// -----------------------------------------------------------------------------
// CA-A7 · degradación del sustrato → NO se escribe (fail-closed)
// -----------------------------------------------------------------------------

test('CA-A7: si el sustrato degrada, la allowlist no se muta a ciegas', () => enTmp(REMOTO, () => {
    const store = createFakeSyncDynamoDriver();
    const host = montarInstancia(store);
    host.pp.setPartialPause([1, 2], {
        source: 'wave:promote', authorizedBy: 'wave-promote', justification: 'seed',
    });

    store._setFailure(new Error('DynamoDB no responde'));
    const res = host.pp.setPartialPause([1, 2, 3], {
        source: 'wave:promote', authorizedBy: 'wave-promote', justification: 'con el store caído',
    });
    assert.equal(res.ok, false);
    assert.equal(res.degraded, true,
        'no se escribe sobre un estado que no se pudo leer: es fail-open sobre un control de acceso');

    store._clearFailure();
    assert.deepEqual(allowlistEnElStore(store).issues, [1, 2], 'el estado quedó intacto');
}));

// -----------------------------------------------------------------------------
// Modo filesystem · el comportamiento NO cambia (el flag llega en false)
// -----------------------------------------------------------------------------

test('modo filesystem: propagar expectedVersion es inocuo — el marker se escribe igual', () => enTmp(LOCAL, (dir) => {
    delete require.cache[BACKEND_PATH];
    delete require.cache[PARTIAL_PAUSE_PATH];
    // eslint-disable-next-line global-require
    const pp = require('../partial-pause');

    const alta = pp.setPartialPause([1, 2], {
        source: 'wave:promote', authorizedBy: 'wave-promote', justification: 'seed local',
    });
    assert.equal(alta.ok, true);
    assert.deepEqual(alta.allowedIssues, [1, 2]);

    const marker = JSON.parse(fs.readFileSync(path.join(dir, '.partial-pause.json'), 'utf8'));
    assert.deepEqual(marker.allowed_issues, [1, 2]);

    // Segunda escritura sobre el marker existente: sigue sin conflicto, porque
    // en modo fs la exclusión la da `withLockSync` y `expectedVersion` se ignora.
    const segunda = pp.setPartialPause([1, 2, 3], {
        source: 'wave:promote', authorizedBy: 'wave-promote', justification: 'alta local',
    });
    assert.equal(segunda.ok, true);
    assert.equal(segunda.conflict, undefined);
    assert.deepEqual(
        JSON.parse(fs.readFileSync(path.join(dir, '.partial-pause.json'), 'utf8')).allowed_issues,
        [1, 2, 3],
    );

    const clear = pp.clearPartialPause({
        source: 'resume:operator', authorizedBy: 'resume:operator', justification: 'clear local',
    });
    assert.equal(clear.ok, true);
    assert.equal(clear.existed, true);
    assert.equal(fs.existsSync(path.join(dir, '.partial-pause.json')), false);
}));
