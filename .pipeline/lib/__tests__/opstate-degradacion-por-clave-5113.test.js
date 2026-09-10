// =============================================================================
// opstate-degradacion-por-clave-5113.test.js — #5113 rev-12
//
// QUÉ PRUEBA — Y POR QUÉ ASÍ
// --------------------------
// Los hallazgos R-2, R-3, R-4 y el default de `parseCliResult` del review rev-10
// tienen todos la misma forma: el pipeline AFIRMA salud que no verificó, o
// PIERDE una señal de caída que sí tuvo. Ninguno se cae con estruendo — los
// cuatro terminan en un tablero verde con el dispatch denegado, que es el
// síntoma exacto que CA-UX1 y CA-UX2 existen para eliminar.
//
//   R-2 · la degradación era un slot GLOBAL sin clave, y cualquier acceso sano
//         la borraba entera. `waves` y `partial-pause` son dos ítems
//         independientes del store: los brazos previos del tick leen `waves`
//         SIEMPRE (`getActiveWave()`), así que una allowlist caída se blanqueaba
//         sola antes de que el gate de dispatch mirara el chip.
//   R-3 · `degraded: false` NO es salud: es "este proceso todavía no vio fallar
//         nada". Un dashboard recién reiniciado con el store caído pintaba verde
//         y afirmaba "sonda en verde" sin haber sondeado.
//   R-4 · el copy del estado operativo pisaba INCONDICIONALMENTE la acción del
//         template, y con eso se perdían las dos cosas que sacan al operador del
//         incidente: que el halt dejó `.paused` (que el restart no levanta) y la
//         excepción `config_incompleta` (CA-5 del PO).
//   parseCliResult · un `code` no numérico (hijo muerto por señal) se leía como
//         exit 0 ⇒ "clave ausente" ⇒ el pipeline operando sin ninguna ola.
//
// La degradación se produce SIEMPRE por el camino real (una operación del
// driver que falla), nunca marcándola a mano: marcarla probaría el cartel, no
// el mecanismo que lo enciende.
//
// Ejecución: `node --test .pipeline/lib/__tests__/opstate-degradacion-por-clave-5113.test.js`
// =============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { withEnv } = require('../test-helpers/with-env');
const { createFakeSyncDynamoDriver } = require('./fixtures/fake-sync-dynamo-driver');

const PROJECT_ID = 'intrale-platform';

function enTmp(env, fn) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opstate-degkey-5113-'));
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

function freshModules() {
    for (const k of Object.keys(require.cache)) {
        if (k.includes(`${path.sep}.pipeline${path.sep}lib${path.sep}`)) delete require.cache[k];
    }
    /* eslint-disable global-require */
    return {
        backend: require('../operational-state-backend'),
        slices: require('../dashboard-slices'),
    };
    /* eslint-enable global-require */
}

/**
 * Driver que se cae SÓLO para una clave. Es la forma real de la degradación
 * parcial: throttling sobre un SK caliente, o un payload que viola las cotas de
 * CA-A5. El resto del estado sigue respondiendo perfecto — que es justo lo que
 * hacía desaparecer la señal.
 */
function driverConUnaClaveCaida(base, claveCaida, err) {
    const caida = (key) => String(key && key.SK).includes(claveCaida);
    return {
        ...base,
        getItem(spec, key) { if (caida(key)) throw err; return base.getItem(spec, key); },
        putItem(spec, item, opts) { return base.putItem(spec, item, opts); },
        deleteItem(spec, key, opts) { return base.deleteItem(spec, key, opts); },
    };
}

function montar(backend, driver) {
    const degradaciones = [];
    backend.setDegradationSink({ onDegraded: (err, ctx) => degradaciones.push({ err, ctx }) });
    backend._setDriverForTests({
        driver,
        spec: { type: 'dynamodb_table', tableName: 'tabla-fake', keys: [] },
        projectId: PROJECT_ID,
        instanceId: PROJECT_ID,
        atomicUpdate: true,
    });
    return degradaciones;
}

// -----------------------------------------------------------------------------
// R-2 · la degradación es POR CLAVE
// -----------------------------------------------------------------------------

test('R-2: un read sano de `waves` NO borra la degradación de la allowlist', () => enTmp({ PIPELINE_OPSTATE_DURABLE: '1' }, () => {
    const { backend } = freshModules();
    const base = createFakeSyncDynamoDriver();
    const throttling = new Error('ProvisionedThroughputExceededException (test)');
    montar(backend, driverConUnaClaveCaida(base, 'partial-pause', throttling));

    // [1] La allowlist se cae: el gate tiene que bloquear.
    const allowlist = backend.readKeyWithVersion(backend.KEYS.PARTIAL_PAUSE);
    assert.equal(allowlist.degraded, true);
    assert.equal(backend.describeMode().degraded, true);
    assert.deepEqual(backend.describeMode().degradedKeys, ['partial-pause']);

    // [2] Otro brazo del MISMO tick lee `waves` y el store le responde bien.
    //     Éste es el paso que antes blanqueaba todo.
    const waves = backend.readKeyWithVersion(backend.KEYS.WAVES);
    assert.equal(waves.degraded, false, 'la clave sana tiene que leerse sin degradar');

    // [3] La allowlist SIGUE caída, y el chip y el gate lo tienen que seguir viendo.
    assert.equal(backend.describeMode().degraded, true,
        'un read sano de otra clave borró la degradación: el operador vería el tablero '
        + 'en verde con el dispatch 100% denegado');
    assert.deepEqual(backend.describeMode().degradedKeys, ['partial-pause']);
    assert.equal(backend.isDegraded('partial-pause'), true);
    assert.equal(backend.isDegraded('waves'), false, 'la clave sana no puede figurar como caída');
    assert.equal(backend.readKeyWithVersion(backend.KEYS.PARTIAL_PAUSE).degraded, true);
}));

test('R-2: recuperada la clave caída, la señal se apaga sola (y sólo esa clave)', () => enTmp({ PIPELINE_OPSTATE_DURABLE: '1' }, () => {
    const { backend } = freshModules();
    const base = createFakeSyncDynamoDriver();
    let caido = true;
    montar(backend, {
        ...base,
        getItem(spec, key) {
            if (caido && String(key.SK).includes('partial-pause')) throw new Error('ETIMEDOUT (test)');
            return base.getItem(spec, key);
        },
    });

    assert.equal(backend.readKeyWithVersion(backend.KEYS.PARTIAL_PAUSE).degraded, true);
    assert.equal(backend.describeMode().degraded, true);

    caido = false;
    // La ausencia legítima (clave todavía no migrada) TAMBIÉN es una respuesta
    // del store: no es degradación y tiene que limpiar el rastro de esa clave.
    const relectura = backend.readKeyWithVersion(backend.KEYS.PARTIAL_PAUSE);
    assert.equal(relectura.degraded, false);
    assert.equal(backend.describeMode().degraded, false, 'la degradación quedó pegada tras la recuperación');
    assert.deepEqual(backend.describeMode().degradedKeys, []);
}));

test('R-2: `getDegradations` nombra QUÉ clave se cayó y con qué causa', () => enTmp({ PIPELINE_OPSTATE_DURABLE: '1' }, () => {
    const { backend } = freshModules();
    const base = createFakeSyncDynamoDriver();
    montar(backend, driverConUnaClaveCaida(base, 'waves', new Error('ETIMEDOUT (test)')));

    backend.readKeyWithVersion(backend.KEYS.WAVES);
    const detalle = backend.getDegradations();
    assert.deepEqual(Object.keys(detalle), ['waves']);
    assert.equal(detalle.waves.stage, 'read:waves');
    assert.equal(typeof detalle.waves.cause, 'string');
    assert.ok(detalle.waves.at > 0);
}));

// -----------------------------------------------------------------------------
// R-3 · el chip no afirma salud que nadie verificó
// -----------------------------------------------------------------------------

test('R-3: proceso remoto SIN ningún acceso al store ⇒ "sin verificar", no "en línea"', () => enTmp({ PIPELINE_OPSTATE_DURABLE: '1' }, () => {
    const { backend, slices } = freshModules();
    backend._resetRemoteObservedForTests();

    // Estado de un dashboard recién levantado por `restart.js`: modo remoto,
    // cero lecturas, cero degradaciones. Antes esto pintaba verde.
    const desc = backend.describeMode();
    assert.equal(desc.mode, 'remote');
    assert.equal(desc.degraded, false);
    assert.equal(desc.observed, false);

    const chip = slices.resolveOpstateProvenance({ ...desc, cutoverWindow: false });
    assert.equal(chip.state, 'remote_unverified');
    assert.match(chip.label, /sin verificar/i);
    assert.notEqual(chip.tone, 'ok', 'no puede pintar verde sin una sola lectura del store');
    assert.doesNotMatch(chip.detail, /sonda/i,
        'el copy no puede afirmar una sonda que no existe');
}));

test('R-3: después de una lectura real que responde, el chip sí dice "en línea"', () => enTmp({ PIPELINE_OPSTATE_DURABLE: '1' }, () => {
    const { backend, slices } = freshModules();
    backend._resetRemoteObservedForTests();
    montar(backend, createFakeSyncDynamoDriver());

    backend.readKeyWithVersion(backend.KEYS.WAVES);   // el store respondió

    const chip = slices.resolveOpstateProvenance({ ...backend.describeMode(), cutoverWindow: false });
    assert.equal(chip.state, 'remote_ok');
    assert.equal(chip.tone, 'ok');
    assert.equal(chip.alertable, false);
}));

test('R-3: con el store caído el chip sigue siendo "sin respuesta" (la degradación gana)', () => enTmp({ PIPELINE_OPSTATE_DURABLE: '1' }, () => {
    const { backend, slices } = freshModules();
    backend._resetRemoteObservedForTests();
    montar(backend, createFakeSyncDynamoDriver({ failWith: new Error('ETIMEDOUT (test)') }));

    backend.readKeyWithVersion(backend.KEYS.WAVES);

    const chip = slices.resolveOpstateProvenance({ ...backend.describeMode(), cutoverWindow: false });
    assert.equal(chip.state, 'remote_down');
    assert.equal(chip.tone, 'bad');
    assert.equal(chip.alertable, true);
}));

// -----------------------------------------------------------------------------
// R-4 · la alerta tiene que nombrar la pausa, y respetar `config_incompleta`
// -----------------------------------------------------------------------------

test('R-4: el halt del estado operativo dice que quedó PAUSADO y cómo reanudar', () => {
    const { formatDegradationAlert } = require('../kernel-degradation-alert');
    const texto = formatDegradationAlert({
        cause: 'red', aborted: true, operationalState: true, correlationId: 'abc123',
    });

    assert.match(texto, /pausad/i, 'el operador no se entera de que el pipeline quedó frenado');
    assert.match(texto, /\.paused|reanudar/i, 'sin el paso de reanudación el pipeline queda muerto en silencio');
    assert.match(texto, /operational_state\.durable/, 'y sigue teniendo que apagar el flag');
});

test('R-4: sin abort, el copy NO habla de una pausa que no existe', () => {
    const { formatDegradationAlert } = require('../kernel-degradation-alert');
    const texto = formatDegradationAlert({ cause: 'red', aborted: false, operationalState: true });

    assert.doesNotMatch(texto, /\.paused/,
        'anunciar una pausa inexistente manda al operador a borrar un marker que no está');
    assert.match(texto, /operational_state\.durable/);
});

test('R-4 / CA-5: con `config_incompleta` NO se manda a apagar el flag', () => {
    const { formatDegradationAlert } = require('../kernel-degradation-alert');

    const sigue = formatDegradationAlert({ cause: 'config_incompleta', aborted: false, operationalState: true });
    assert.match(sigue, /coordinationTableName/, 'la acción real es completar la config');
    assert.doesNotMatch(sigue, /a `false`/,
        'CA-5 prohíbe la acción "volvé el flag a false" para esta causa');

    const abortado = formatDegradationAlert({ cause: 'config_incompleta', aborted: true, operationalState: true });
    assert.match(abortado, /coordinationTableName/);
    assert.match(abortado, /pausad/i);
    assert.match(abortado, /reanudar/i);
});

test('CA-UX5: el mensaje que sale al canal de Telegram no lleva backticks literales', () => {
    const backend = require('../operational-state-backend');
    const { formatDegradationAlert } = require('../kernel-degradation-alert');

    const crudo = formatDegradationAlert({ cause: 'red', aborted: true, operationalState: true });
    assert.ok(crudo.includes('`'), 'el template SÍ está escrito en Markdown (premisa del test)');

    // El canal escapa el texto entero: lo que no despojemos acá le llega al
    // operador con la barra invertida a la vista.
    const plano = backend._plainForTelegram(crudo);
    assert.equal(plano.includes('`'), false, 'quedaron backticks que el canal va a escapar');
    assert.match(plano, /operational_state\.durable/, 'el contenido no se toca, sólo los delimitadores');
    assert.match(plano, /reanudar/);
});

// -----------------------------------------------------------------------------
// `parseCliResult` · un resultado malformado es FALLO, no éxito
// -----------------------------------------------------------------------------

test('parseCliResult: un `code` no numérico se trata como fallo, no como éxito', () => {
    const { parseCliResult } = require('../provisioner-infra');

    // Exactamente lo que devuelve el runner cuando el hijo muere por señal.
    assert.throws(
        () => parseCliResult({ code: null, stdout: '', stderr: '' }, ['get-item']),
        /malformado|sin exit code/i,
        'un resultado que no sabemos leer se estaba interpretando como "clave ausente"',
    );
    assert.throws(() => parseCliResult(undefined, ['get-item']), /malformado|sin exit code/i);
    assert.throws(() => parseCliResult({ code: 'x' }, ['put-item']), /malformado|sin exit code/i);
});

test('parseCliResult: el camino feliz y el mapeo del CAS no cambian', () => {
    const { parseCliResult, ConditionalCheckFailedError } = require('../provisioner-infra');

    assert.deepEqual(parseCliResult({ code: 0, stdout: '{"Item":{}}' }, ['get-item']), { Item: {} });
    assert.deepEqual(parseCliResult({ code: 0, stdout: '' }, ['get-item']), {},
        'stdout vacío con exit 0 SIGUE siendo "clave ausente" — es una condición legítima');
    assert.throws(
        () => parseCliResult({ code: 255, stderr: 'ConditionalCheckFailedException' }, ['put-item']),
        (e) => e instanceof ConditionalCheckFailedError,
    );
});
