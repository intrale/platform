// =============================================================================
// waves-integridad-redaccion-5113.test.js — CA-A1 (#5113 rev-9)
//
// EL SELLO DE INTEGRIDAD TIENE QUE CUBRIR LO QUE REALMENTE SE PERSISTE.
//
// Por que existe este test
// ------------------------
// QA reprodujo, en modo remoto, un `mismatch` de integridad sobre un registro de
// olas que NADIE habia tocado:
//
//   1. `waves.js` sellaba el estado con `computeIntegrityHash(state)`.
//   2. `operational-state-backend.writeKey` aplicaba DESPUES `redactBeforeWrite`
//      sobre el payload (CA-A9), asi que un `source` con forma de secreto se
//      guardaba como "[REDACTED]".
//   3. Lo persistido dejaba de ser lo hasheado => `checkStateIntegrity()`
//      devolvia `mismatch` en el boot siguiente y el Pulpo alertaba al operador
//      por un tampering inexistente.
//
// El costo real no es el log: es que un control de integridad que grita en falso
// (#4370) entrena al operador a ignorarlo, y ahi deja de proteger contra el
// tampering de verdad.
//
// La suite cubre las dos mitades, porque cada una sola admite un falso verde:
//   - integridad `ok` con un `source` secreto  -> sin la otra mitad, se aprueba
//     "arreglando" el bug a fuerza de NO redactar (y filtrando el secreto).
//   - el secreto NO queda en el store          -> sin la primera, se aprueba
//     redactando y dejando el hash roto.
//
// Ejecutar:
//   node --test .pipeline/lib/__tests__/waves-integridad-redaccion-5113.test.js
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

// Token con forma de secreto real (patron por proveedor, no entropia dudosa):
// es exactamente la clase de valor que la redaccion tiene que atrapar.
const SECRETO = 'sk-ant-api03-' + 'A'.repeat(48);

/** Estado inicial valido: una ola activa, sin dependencias. */
function seedState() {
    const ahora = new Date().toISOString();
    return {
        version: '1.0',
        meta: {
            created_at: ahora, updated_at: ahora, updated_by: 'test', source: 'fixture',
            next_wave_number: 2,
        },
        active_wave: { number: 1, name: 'ola de prueba', started_at: ahora, issues: [{ number: 1 }] },
        planned_waves: [],
        archived_waves: [],
        dependencies: [],
    };
}

/**
 * Monta una instancia del pipeline en `dir` con el sustrato indicado. Con
 * `driver` = store remoto; sin el = filesystem local.
 *
 * El par `waves` + `operational-state-backend` se recarga junto: `waves.js`
 * captura el backend en un `require` de nivel superior, asi que refrescar uno
 * solo dejaria a waves hablandole a la instancia vieja.
 */
function montarInstancia({ dir, driver }) {
    const env = { PIPELINE_DIR_OVERRIDE: dir, PIPELINE_OPSTATE_DURABLE: driver ? '1' : undefined };
    return withEnv(env, () => {
        delete require.cache[BACKEND_PATH];
        delete require.cache[WAVES_PATH];
        // eslint-disable-next-line global-require
        const backend = require('../operational-state-backend');
        if (driver) {
            backend._setDriverForTests({
                driver,
                spec: { type: 'dynamodb_table', tableName: 'tabla-fake', keys: [] },
                projectId: PROJECT_ID,
                instanceId: PROJECT_ID,
                atomicUpdate: true,
            });
        }
        // eslint-disable-next-line global-require
        const waves = require('../waves');
        return {
            backend,
            waves,
            en(fn) { return withEnv(env, () => fn(waves, backend)); },
        };
    });
}

/** Corre `fn(host, driver, dir)` con tmpdir propio y limpieza garantizada. */
function conHost({ remoto }, fn) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'waves-integridad-5113-'));
    const driver = remoto ? createFakeSyncDynamoDriver() : null;
    try {
        const host = montarInstancia({ dir, driver });
        host.en((_w, backend) => {
            const res = backend.writeKey(backend.KEYS.WAVES, seedState(), remoto ? 0 : undefined);
            assert.equal(res.ok, true, 'el seed del registro de olas se escribio');
        });
        return fn(host, driver, dir);
    } finally {
        delete require.cache[BACKEND_PATH];
        delete require.cache[WAVES_PATH];
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
}

/** Estado tal cual quedo en el sustrato, sin pasar por ningun cache del proceso. */
function estadoPersistido(host, driver, dir) {
    if (driver) {
        const raw = driver._raw(PROJECT_ID, SK_WAVES);
        assert.ok(raw, 'hay un item de registro de olas en el store');
        return raw.body.value;
    }
    return JSON.parse(fs.readFileSync(path.join(dir, 'waves.json'), 'utf8'));
}

for (const modo of ['remoto', 'filesystem']) {
    const remoto = modo === 'remoto';

    // -------------------------------------------------------------------------
    // CA-A1 · el vector que reprodujo QA
    // -------------------------------------------------------------------------
    test(`CA-A1 (${modo}): un source con forma de secreto no rompe el sello de integridad`,
        () => conHost({ remoto }, (host, driver, dir) => {
            host.en((w) => w.addDependency(5113, [5126], { source: SECRETO }));

            const chequeo = host.en((w) => w.checkStateIntegrity());
            assert.equal(chequeo.status, 'ok',
                'el estado recien escrito por el propio pipeline verifica ok '
                + `(status=${chequeo.status}${chequeo.expected ? ` esperado=${chequeo.expected} actual=${chequeo.actual}` : ''})`);

            // Mitad 2: el sello no se salvo a costa de filtrar el secreto.
            const persistido = estadoPersistido(host, driver, dir);
            const entrada = persistido.dependencies.find((d) => Number(d.parent) === 5113);
            assert.ok(entrada, 'la dependencia quedo declarada');
            assert.equal(entrada.source, '[REDACTED]', 'el token no quedo en el estado persistido');
            assert.doesNotMatch(JSON.stringify(persistido), /sk-ant-api03/,
                'el token no aparece en ningun campo del estado persistido');
        }));

    // -------------------------------------------------------------------------
    // Control negativo: sin secreto de por medio, nada cambia
    // -------------------------------------------------------------------------
    test(`CA-A1 (${modo}): un source normal se preserva intacto y tambien verifica ok`,
        () => conHost({ remoto }, (host, driver, dir) => {
            host.en((w) => w.addDependency(5113, [5126], { source: 'split-auto' }));

            assert.equal(host.en((w) => w.checkStateIntegrity()).status, 'ok');
            const persistido = estadoPersistido(host, driver, dir);
            const entrada = persistido.dependencies.find((d) => Number(d.parent) === 5113);
            assert.equal(entrada.source, 'split-auto',
                'la redaccion no toca texto que no parece secreto');
        }));
}

// -----------------------------------------------------------------------------
// Efecto de borde del fix, cubierto para que no vuelva: si el `source` se
// redactara recien al persistir, la idempotencia de `addDependency` compararia
// el valor CRUDO contra la entry ya guardada (redactada), no encontraria nunca
// la existente y fragmentaria el rastro en una entry nueva por cada llamada.
// -----------------------------------------------------------------------------
test('CA-A1: repetir la misma dependencia con un source secreto no duplica la entry',
    () => conHost({ remoto: true }, (host, driver) => {
        host.en((w) => w.addDependency(5113, [5126], { source: SECRETO }));
        const segunda = host.en((w) => w.addDependency(5113, [5126], { source: SECRETO }));

        assert.deepEqual(segunda.added, [], 'la segunda declaracion es no-op');
        const persistido = estadoPersistido(host, driver);
        const delPadre = persistido.dependencies.filter((d) => Number(d.parent) === 5113);
        assert.equal(delPadre.length, 1, 'quedo una sola entry para el par (parent, source)');
        assert.equal(host.en((w) => w.checkStateIntegrity()).status, 'ok');
    }));

// -----------------------------------------------------------------------------
// La propiedad que hace que el fix no se pueda re-romper por deriva: lo que la
// capa de storage redacta al escribir tiene que ser PUNTO FIJO sobre el estado
// que waves.js ya sello. Si alguien suma un campo a REDACTED_FIELDS por un
// camino distinto, esto se pone en rojo antes que el boot del operador.
// -----------------------------------------------------------------------------
test('el estado sellado es punto fijo de la redaccion de la capa de storage',
    () => conHost({ remoto: true }, (host, driver) => {
        host.en((w) => w.addDependency(5113, [5126], { source: SECRETO, note: SECRETO }));

        const persistido = estadoPersistido(host, driver);
        const reRedactado = host.en((_w, backend) => backend.redactBeforeWrite(persistido));
        assert.deepEqual(reRedactado, persistido,
            'redactar de nuevo lo persistido no lo cambia: el hash sigue describiendo el payload');
    }));

// -----------------------------------------------------------------------------
// `redactInPlace` es la variante que usa waves.js ANTES de sellar: tiene que
// preservar identidad y propiedades de simbolo. Un clon perderia la version del
// sustrato adosada al state (`CAS_VERSION`) y el write remoto saldria sin
// `expectedVersion` — o sea, cambiaria un falso mismatch por una carrera real.
// -----------------------------------------------------------------------------
test('redactInPlace muta el objeto y conserva las propiedades de simbolo', () => {
    delete require.cache[BACKEND_PATH];
    // eslint-disable-next-line global-require
    const backend = require('../operational-state-backend');
    try {
        const VERSION = Symbol('version-del-sustrato');
        const state = { meta: { source: SECRETO }, dependencies: [{ parent: 1, source: SECRETO }] };
        Object.defineProperty(state, VERSION, { value: 42, enumerable: true, configurable: true });

        const salida = backend.redactInPlace(state);

        assert.equal(salida, state, 'devuelve el MISMO objeto, no un clon');
        assert.equal(state[VERSION], 42, 'la version adosada sobrevive a la redaccion');
        assert.equal(state.meta.source, '[REDACTED]');
        assert.equal(state.dependencies[0].source, '[REDACTED]');
        assert.deepEqual(backend.redactBeforeWrite(state), JSON.parse(JSON.stringify(state)),
            'in-place y clon producen exactamente el mismo resultado');
    } finally {
        delete require.cache[BACKEND_PATH];
    }
});
