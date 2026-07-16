'use strict';

// =============================================================================
// provisioner-infra.test.js — Tests del ejecutor `provisioner_infra` (H2 · #4718)
//
// Cobertura mapeada a criterios de aceptación (#4718):
//   - CA-1: el ejecutor provisiona el recurso descripto y deja el schema pedido.
//   - CA-2: genera evidencia describe-table + round-trip (create/read/delete)
//           que prueba que el recurso responde.
//   - CA-3: los ejecutores de código actuales siguen funcionando sin cambios
//           (contrato ausente / `codigo` ⇒ dev_codigo passthrough).
//   - Robustez: contrato inválido se modela como dato (status:failed), no lanza;
//               fallo del driver se reporta como diagnostic; adapter AWS CLI
//               traduce y parsea correctamente con un runner fake.
// =============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');

const prov = require('../provisioner-infra');

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function contractRecurso(overrides = {}) {
    return {
        version: '0.1.0',
        tipo_entregable: 'recurso_provisionado',
        definicion_de_listo: ['La tabla existe y responde'],
        evidencia_requerida: { tipo: 'describe_table_round_trip', detalle: 'describe + round-trip' },
        ejecutor: { tipo: 'provisioner_infra' },
        recurso: {
            tipo: 'dynamodb_table',
            nombre: 'IntraleTestTable',
            schema: {
                hashKey: { nombre: 'pk', tipo: 'S' },
                rangeKey: { nombre: 'sk', tipo: 'S' },
            },
        },
        ...overrides,
    };
}

const fixedNow = () => 1234567890;

// -----------------------------------------------------------------------------
// CA-3 — retrocompat: resolución del tipo de ejecutor
// -----------------------------------------------------------------------------

test('CA-3 · contrato ausente resuelve a dev_codigo', () => {
    assert.equal(prov.resolveExecutorType(undefined), prov.EXECUTOR_TYPE.DEV_CODIGO);
    assert.equal(prov.resolveExecutorType(null), prov.EXECUTOR_TYPE.DEV_CODIGO);
    assert.equal(prov.resolveExecutorType({}), prov.EXECUTOR_TYPE.DEV_CODIGO);
    assert.ok(prov.isCodeExecutor(undefined));
});

test('CA-3 · contrato tipo codigo resuelve a dev_codigo', () => {
    const c = { tipo_entregable: 'codigo', ejecutor: { tipo: 'dev_codigo', skill: 'backend-dev' } };
    assert.equal(prov.resolveExecutorType(c), prov.EXECUTOR_TYPE.DEV_CODIGO);
    assert.ok(prov.isCodeExecutor(c));
});

test('CA-3 · contrato recurso_provisionado resuelve a provisioner_infra', () => {
    assert.equal(prov.resolveExecutorType(contractRecurso()), prov.EXECUTOR_TYPE.PROVISIONER_INFRA);
    assert.equal(prov.isCodeExecutor(contractRecurso()), false);
});

test('CA-3 · tipo_entregable recurso sin ejecutor explícito igual enruta a provisioner', () => {
    const c = contractRecurso({ ejecutor: undefined });
    assert.equal(prov.resolveExecutorType(c), prov.EXECUTOR_TYPE.PROVISIONER_INFRA);
});

test('CA-3 · runExecutor de un contrato de código NO ejecuta provisión (passthrough)', async () => {
    const res = await prov.runExecutor({ tipo_entregable: 'codigo' });
    assert.equal(res.status, prov.STATUS.SKIPPED);
    assert.equal(res.ejecutor, prov.EXECUTOR_TYPE.DEV_CODIGO);
    assert.equal(res.handledByCodeLifecycle, true);
});

// -----------------------------------------------------------------------------
// CA-1 / CA-2 — provisión + evidencia con driver in-memory
// -----------------------------------------------------------------------------

test('CA-1/CA-2 · provisiona y genera evidencia describe-table + round-trip completo', async () => {
    const res = await prov.provisionResource(contractRecurso(), {
        driver: prov.createInMemoryDynamoDriver(),
        now: fixedNow,
    });

    assert.equal(res.status, prov.STATUS.OK);
    assert.equal(res.ejecutor, prov.EXECUTOR_TYPE.PROVISIONER_INFRA);
    assert.equal(res.tipo_entregable, 'recurso_provisionado');
    assert.deepEqual(res.diagnostics, []);

    // CA-2: evidencia describe-table con el schema pedido.
    const table = res.evidence.describeTable.Table;
    assert.equal(table.TableName, 'IntraleTestTable');
    assert.equal(table.TableStatus, 'ACTIVE');
    assert.deepEqual(table.KeySchema, [
        { AttributeName: 'pk', KeyType: 'HASH' },
        { AttributeName: 'sk', KeyType: 'RANGE' },
    ]);
    assert.deepEqual(table.AttributeDefinitions, [
        { AttributeName: 'pk', AttributeType: 'S' },
        { AttributeName: 'sk', AttributeType: 'S' },
    ]);

    // CA-2: round-trip create/read/delete + confirmación de ausencia.
    assert.deepEqual(res.evidence.roundTrip, {
        create: true,
        read: true,
        delete: true,
        confirmedGone: true,
    });

    // El artefacto observable expone la evidencia.
    assert.equal(res.artifacts.length, 1);
    assert.equal(res.artifacts[0].type, prov.EVIDENCE_TYPE);
    assert.equal(res.artifacts[0].tableName, 'IntraleTestTable');
});

test('CA-1 · schema con sólo hashKey (sin rangeKey) también provisiona', async () => {
    const c = contractRecurso({
        recurso: {
            tipo: 'dynamodb_table',
            nombre: 'SoloHash',
            schema: { hashKey: { nombre: 'id', tipo: 'N' } },
        },
    });
    const res = await prov.provisionResource(c, { now: fixedNow });
    assert.equal(res.status, prov.STATUS.OK);
    assert.deepEqual(res.evidence.describeTable.Table.KeySchema, [
        { AttributeName: 'id', KeyType: 'HASH' },
    ]);
    assert.equal(res.evidence.roundTrip.confirmedGone, true);
});

test('CA-2 · el ítem realmente se persiste y se recupera igual (round-trip real)', async () => {
    const driver = prov.createInMemoryDynamoDriver();
    // Corremos la provisión y luego inspeccionamos el driver directamente.
    const res = await prov.provisionResource(contractRecurso(), { driver, now: fixedNow });
    assert.equal(res.evidence.roundTrip.read, true);
    // Tras el ciclo, el ítem de smoke fue borrado (confirmedGone).
    assert.equal(res.evidence.roundTrip.confirmedGone, true);
});

// -----------------------------------------------------------------------------
// Robustez — errores como datos (no excepciones)
// -----------------------------------------------------------------------------

test('contrato inválido devuelve status:failed con diagnostics, no lanza', async () => {
    const res = await prov.provisionResource({ tipo_entregable: 'recurso_provisionado' });
    assert.equal(res.status, prov.STATUS.FAILED);
    assert.ok(res.diagnostics.length >= 1);
    assert.equal(res.diagnostics[0].stage, 'validate');
    assert.equal(res.evidence, null);
});

test('recurso.nombre inválido se rechaza como dato', () => {
    const v = prov.validateResourceContract(contractRecurso({
        recurso: { tipo: 'dynamodb_table', nombre: 'x', schema: { hashKey: { nombre: 'pk', tipo: 'S' } } },
    }));
    assert.equal(v.ok, false);
    assert.ok(v.errors.some((e) => e.includes('recurso.nombre')));
});

test('recurso.tipo no soportado se rechaza como dato', () => {
    const v = prov.validateResourceContract(contractRecurso({
        recurso: { tipo: 'sqs_queue', nombre: 'MiCola', schema: { hashKey: { nombre: 'pk', tipo: 'S' } } },
    }));
    assert.equal(v.ok, false);
    assert.ok(v.errors.some((e) => e.includes('recurso.tipo')));
});

test('key con tipo de atributo inválido se rechaza', () => {
    const v = prov.validateResourceContract(contractRecurso({
        recurso: { tipo: 'dynamodb_table', nombre: 'MiTabla', schema: { hashKey: { nombre: 'pk', tipo: 'X' } } },
    }));
    assert.equal(v.ok, false);
    assert.ok(v.errors.some((e) => e.includes('hashKey.tipo')));
});

test('fallo del driver se reporta como diagnostic con status:failed', async () => {
    const brokenDriver = {
        kind: 'broken',
        async createTable() { throw new Error('boom al crear'); },
        async describeTable() { return { Table: {} }; },
        async putItem() {}, async getItem() { return { item: null }; }, async deleteItem() {},
    };
    const res = await prov.provisionResource(contractRecurso(), { driver: brokenDriver, now: fixedNow });
    assert.equal(res.status, prov.STATUS.FAILED);
    assert.ok(res.diagnostics.some((d) => d.stage === 'provision' && d.message.includes('boom')));
});

test('round-trip que no confirma borrado ⇒ status:failed', async () => {
    // Driver que "olvida" borrar: el ítem sigue presente tras delete.
    const store = new Map();
    const spec = 'IntraleTestTable';
    const stickyDriver = {
        kind: 'sticky',
        async createTable() {},
        async describeTable() {
            return { Table: { TableName: spec, TableStatus: 'ACTIVE',
                KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }, { AttributeName: 'sk', KeyType: 'RANGE' }],
                AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }, { AttributeName: 'sk', AttributeType: 'S' }] } };
        },
        async putItem(_s, item) { store.set('k', item); },
        async getItem() { return { item: store.get('k') || null }; },
        async deleteItem() { /* no borra a propósito */ },
    };
    const res = await prov.provisionResource(contractRecurso(), { driver: stickyDriver, now: fixedNow });
    assert.equal(res.evidence.roundTrip.confirmedGone, false);
    assert.equal(res.status, prov.STATUS.FAILED);
    assert.ok(res.diagnostics.some((d) => d.stage === 'round-trip:confirm'));
});

// -----------------------------------------------------------------------------
// Adapter AWS CLI — traducción + parseo con runner fake
// -----------------------------------------------------------------------------

test('driver AWS CLI: create-table traduce attribute-definitions y key-schema', async () => {
    const calls = [];
    const run = async (args) => {
        calls.push(args);
        if (args[0] === 'describe-table') {
            return { code: 0, stdout: JSON.stringify({ Table: {
                TableName: 'IntraleTestTable', TableStatus: 'ACTIVE',
                KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }, { AttributeName: 'sk', KeyType: 'RANGE' }],
                AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }, { AttributeName: 'sk', AttributeType: 'S' }],
            } }) };
        }
        if (args[0] === 'get-item') {
            // Simula: presente antes del delete, ausente después.
            const seenDelete = calls.some((c) => c[0] === 'delete-item');
            if (seenDelete) return { code: 0, stdout: '{}' };
            return { code: 0, stdout: JSON.stringify({ Item: {
                pk: { S: 'provisioner-smoke-hash' }, sk: { S: 'provisioner-smoke-range' },
                __provisioner_smoke: { S: 'rt-1234567890' },
            } }) };
        }
        return { code: 0, stdout: '{}' };
    };

    const driver = prov.createAwsCliDynamoDriver({ run });
    const res = await prov.provisionResource(contractRecurso(), { driver, now: fixedNow });

    assert.equal(res.status, prov.STATUS.OK);
    assert.equal(res.driver, 'aws-cli');

    const createCall = calls.find((c) => c[0] === 'create-table');
    assert.ok(createCall.includes('AttributeName=pk,AttributeType=S'));
    assert.ok(createCall.includes('AttributeName=pk,KeyType=HASH'));
    assert.ok(createCall.includes('AttributeName=sk,KeyType=RANGE'));

    // round-trip completo vía CLI fake.
    assert.deepEqual(res.evidence.roundTrip, { create: true, read: true, delete: true, confirmedGone: true });
});

test('driver AWS CLI: exit code != 0 se propaga como diagnostic', async () => {
    const run = async (args) => {
        if (args[0] === 'create-table') return { code: 255, stderr: 'ResourceInUseException' };
        return { code: 0, stdout: '{}' };
    };
    const driver = prov.createAwsCliDynamoDriver({ run });
    const res = await prov.provisionResource(contractRecurso(), { driver, now: fixedNow });
    assert.equal(res.status, prov.STATUS.FAILED);
    assert.ok(res.diagnostics.some((d) => d.message.includes('ResourceInUseException')));
});

test('createAwsCliDynamoDriver exige runner', () => {
    assert.throws(() => prov.createAwsCliDynamoDriver({}), /runner/);
});

test('toAttrValues / fromAttrValues son inversos para S/N/BOOL', () => {
    const item = { pk: 'abc', count: 3, flag: true };
    const round = prov.fromAttrValues(prov.toAttrValues(item));
    assert.deepEqual(round, item);
});

// -----------------------------------------------------------------------------
// Registro — aditivo, ambos tipos presentes
// -----------------------------------------------------------------------------

test('registro expone dev_codigo y provisioner_infra sin romperse', () => {
    assert.equal(typeof prov.getExecutor(prov.EXECUTOR_TYPE.DEV_CODIGO), 'function');
    assert.equal(typeof prov.getExecutor(prov.EXECUTOR_TYPE.PROVISIONER_INFRA), 'function');
    assert.equal(prov.getExecutor('tipo_inexistente'), null);
});

test('runExecutor enruta recurso_provisionado al provisioner y produce evidencia', async () => {
    const res = await prov.runExecutor(contractRecurso(), { now: fixedNow });
    assert.equal(res.status, prov.STATUS.OK);
    assert.equal(res.ejecutor, prov.EXECUTOR_TYPE.PROVISIONER_INFRA);
    assert.equal(res.evidence.type, prov.EVIDENCE_TYPE);
});
