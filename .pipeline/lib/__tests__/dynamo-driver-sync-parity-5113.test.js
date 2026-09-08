// =============================================================================
// dynamo-driver-sync-parity-5113.test.js — #5113
//
// PARIDAD ENTRE EL DRIVER ASINCRONO Y SU ESPEJO SINCRONO.
//
// Por que existe este archivo
// ---------------------------
// #5113 sumo un driver DynamoDB SINCRONO (`spawnSync`) porque el gate de
// dispatch tiene que seguir devolviendo `boolean` estricto con el estado
// operativo viviendo en el store: convertir la cadena a `async` obligaria a
// `await` en los consumidores y cualquier olvido es fail-OPEN silencioso.
//
// El riesgo que eso introduce es la DIVERGENCIA: dos implementaciones del mismo
// `ConditionExpression` derivan con el tiempo y una de las dos se queda sin la
// garantia anti-inyeccion. La mitigacion es estructural — los args los arman
// funciones puras COMPARTIDAS — y estos tests son lo que la sostiene: si alguien
// duplica la logica en el camino sincrono "para no tocar el async", se ponen en
// rojo.
//
// No alcanza con leer el codigo y ver que hoy comparten: la propiedad que
// importa es que SIGAN compartiendo.
//
// Ejecutar:
//   node --test .pipeline/lib/__tests__/dynamo-driver-sync-parity-5113.test.js
// =============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const infra = require('../provisioner-infra');

const SPEC = Object.freeze({
    type: 'dynamodb_table',
    tableName: 'intrale-kernel-coordination',
    keys: [],
});

/**
 * Captura los args que cada driver le pasa a su runner, para el MISMO input.
 * Los runners son fakes: nada sale a la red ni al `aws` real.
 */
function argsDeAmbosCaminos(invocar) {
    const capturadosAsync = [];
    const capturadosSync = [];

    const driverAsync = infra.createAwsCliDynamoDriver({
        run: async (args) => { capturadosAsync.push(args); return {}; },
    });
    const driverSync = infra.createAwsCliDynamoDriverSync({
        runSync: (args) => { capturadosSync.push(args); return {}; },
    });

    return Promise.resolve(invocar(driverAsync))
        .then(() => { invocar(driverSync); })
        .then(() => ({ async: capturadosAsync, sync: capturadosSync }));
}

// -----------------------------------------------------------------------------
// Paridad de args, operacion por operacion
// -----------------------------------------------------------------------------

test('putItem: los dos caminos emiten EXACTAMENTE los mismos args', async () => {
    const item = { PK: 'proj#intrale', SK: 'opstate#waves', version: 3, payload: '{"a":1}' };
    const { async: a, sync: s } = await argsDeAmbosCaminos((d) => d.putItem(SPEC, item));
    assert.deepEqual(s, a, 'un put que diverge entre async y sync es una garantia perdida');
    assert.equal(a.length, 1);
    assert.equal(a[0][0], 'put-item');
});

test('putItem CONDICIONAL: la ConditionExpression y sus valores son identicos', async () => {
    // Es el caso critico: el CAS es lo que reemplaza a `withLockSync` como
    // primitiva de exclusion en regimen remoto. Si el camino sincrono perdiera
    // la condicion, escribiria a ciegas y el lost update volveria en silencio.
    const opts = {
        conditionExpression: 'attribute_not_exists(#v) OR #v = :esperada',
        expressionAttributeNames: { '#v': 'version' },
        expressionAttributeValues: { ':esperada': 7 },
    };
    const { async: a, sync: s } = await argsDeAmbosCaminos(
        (d) => d.putItem(SPEC, { PK: 'p', SK: 's' }, opts));

    assert.deepEqual(s, a);
    assert.ok(a[0].includes('--condition-expression'),
        'el put condicional DEBE viajar con su ConditionExpression');
    assert.ok(a[0].includes(opts.conditionExpression));
    assert.ok(a[0].includes('--expression-attribute-values'));
    assert.ok(a[0].includes('--expression-attribute-names'));
});

test('getItem: los dos caminos piden lectura consistente', async () => {
    const { async: a, sync: s } = await argsDeAmbosCaminos((d) => d.getItem(SPEC, { PK: 'p', SK: 's' }));
    assert.deepEqual(s, a);
    // Sin `--consistent-read` una lectura eventual puede devolver una allowlist
    // vieja: un dato stale del gate no es "un dato viejo", es una autorizacion
    // revocada que vuelve a estar vigente.
    assert.ok(a[0].includes('--consistent-read'),
        'el estado operativo NO se lee con consistencia eventual');
});

test('deleteItem CONDICIONAL: paridad del delete por ownership', async () => {
    const opts = {
        conditionExpression: '#v = :esperada',
        expressionAttributeNames: { '#v': 'version' },
        expressionAttributeValues: { ':esperada': 2 },
    };
    const { async: a, sync: s } = await argsDeAmbosCaminos(
        (d) => d.deleteItem(SPEC, { PK: 'p', SK: 's' }, opts));

    assert.deepEqual(s, a);
    assert.ok(a[0].includes('--condition-expression'),
        'borrar sin condicion permite pisar un item que cambio bajo los pies');
});

// -----------------------------------------------------------------------------
// La garantia anti-inyeccion (A03)
// -----------------------------------------------------------------------------

test('los args son ELEMENTOS SEPARADOS del array, nunca un string de shell', async () => {
    // La defensa contra inyeccion no es escapar: es que ningun valor sea
    // interpretado por un shell. Cada flag y cada valor viajan como elemento
    // propio, y `spawn`/`spawnSync` corren con `shell: false`.
    const hostil = 'valor"; rm -rf / #';
    const { async: a, sync: s } = await argsDeAmbosCaminos(
        (d) => d.putItem(SPEC, { PK: hostil, SK: 's' }));

    assert.deepEqual(s, a);
    for (const args of [a[0], s[0]]) {
        assert.ok(Array.isArray(args), 'los args DEBEN ser un array, no un string');
        for (const arg of args) {
            assert.equal(typeof arg, 'string', 'cada arg viaja como string suelto');
        }
        // El payload hostil viaja DENTRO del JSON del item, como dato — nunca
        // concatenado dentro del comando.
        const itemIdx = args.indexOf('--item');
        assert.ok(itemIdx >= 0);
        const parsed = JSON.parse(args[itemIdx + 1]);
        assert.equal(JSON.stringify(parsed).includes('rm -rf'), true,
            'el string hostil sobrevive como DATO, sin haber sido interpretado');
    }
});

test('ambos drivers exponen la misma superficie de operaciones de item', () => {
    const a = infra.createAwsCliDynamoDriver({ run: async () => ({}) });
    const s = infra.createAwsCliDynamoDriverSync({ runSync: () => ({}) });
    for (const op of ['putItem', 'getItem', 'deleteItem']) {
        assert.equal(typeof a[op], 'function', `el driver async debe exponer ${op}`);
        assert.equal(typeof s[op], 'function', `el driver sync debe exponer ${op}`);
    }
    // Y el sincrono NO devuelve thenables: es el punto entero de su existencia.
    const r = s.getItem(SPEC, { PK: 'p', SK: 's' });
    assert.equal(typeof (r && r.then), 'undefined',
        'el driver sync no puede devolver una Promise: rompe el contrato boolean del gate');
});

test('las funciones puras de armado de args estan EXPORTADAS y son deterministas', () => {
    // Exportarlas es lo que permite que haya UNA sola definicion consumida por
    // los dos drivers. Si dejaran de estarlo, la duplicacion vuelve a ser el
    // camino de menor resistencia.
    for (const fn of ['buildPutItemArgs', 'buildGetItemArgs', 'buildDeleteItemArgs']) {
        assert.equal(typeof infra[fn], 'function', `${fn} debe estar exportada`);
    }
    const item = { PK: 'p', SK: 's', n: 1 };
    assert.deepEqual(infra.buildPutItemArgs(SPEC, item), infra.buildPutItemArgs(SPEC, item));
    assert.deepEqual(infra.buildGetItemArgs(SPEC, item), infra.buildGetItemArgs(SPEC, item));
});
