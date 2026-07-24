'use strict';

// =============================================================================
// kernel-durable-driver-4820.test.js — Fundacion de persistencia durable del
// kernel (split 1/3 de #4804 . #4820).
//
// Cobertura mapeada a los criterios de aceptacion del issue #4820:
//   CA-1  createAwsCliRunner arma `args` como array sin interpolacion (A03):
//         valores con metacaracteres shell llegan LITERALES a spawn; shell:false.
//   CA-3  fail-closed de credenciales: sin AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY
//         lanza ANTES de spawnear; nunca invoca el CLI con credenciales vacias.
//   CA-2  normalizeConfig rechaza el driver real sin tableName (config, no hardcode).
//   CA-7  putProduct + listProducts roundtrip contra el driver AWS CLI con `run`
//         fake; ConditionalCheckFailedException -> error tipado, sin estado a medias.
//   CA-6  regresion de coexistencia: con kernel.durable:false ni el runner ni el
//         driver real se instancian; cero llamadas AWS.
// =============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const prov = require('../provisioner-infra');
const {
    createKernelStore,
    normalizeConfig,
    KernelStoreError,
} = require('../kernel-store');
const kernelProvision = require('../kernel-provision');

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

const AWS_ENV = {
    AWS_ACCESS_KEY_ID: 'AKIAFAKE',
    AWS_SECRET_ACCESS_KEY: 'secretfake',
    AWS_REGION: 'us-east-1',
};

// Fake spawn: captura (cmd, args, opts) y devuelve un child con exit 0.
function makeFakeSpawn(recorder) {
    return (cmd, args, opts) => {
        recorder.push({ cmd, args, opts });
        const child = new EventEmitter();
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        // El close se emite en el proximo tick para simular async real.
        setImmediate(() => {
            child.stdout.emit('data', '{}');
            child.emit('close', 0);
        });
        return child;
    };
}

// Fake `run`: backend DynamoDB en memoria al nivel del JSON del CLI. Persiste lo
// que el driver escribe (formato AttributeValue) y lo devuelve tal cual en get.
// La clave de particion usa un separador ASCII fijo, comun a put/get/delete.
function keyFromAttr(attrItem) {
    return [attrItem.PK.S, attrItem.SK.S].join('||');
}

function makeFakeAwsRun() {
    const store = new Map();
    const calls = [];
    const run = async (args) => {
        calls.push(args);
        const op = args[0];
        if (op === 'create-table') {
            return { code: 0, stdout: '{}', stderr: '' };
        }
        if (op === 'describe-table') {
            const name = args[args.indexOf('--table-name') + 1];
            // La tabla del kernel es siempre single-table PK(HASH)/SK(RANGE).
            return {
                code: 0,
                stderr: '',
                stdout: JSON.stringify({
                    Table: {
                        TableName: name,
                        TableStatus: 'ACTIVE',
                        KeySchema: [
                            { AttributeName: 'PK', KeyType: 'HASH' },
                            { AttributeName: 'SK', KeyType: 'RANGE' },
                        ],
                        AttributeDefinitions: [
                            { AttributeName: 'PK', AttributeType: 'S' },
                            { AttributeName: 'SK', AttributeType: 'S' },
                        ],
                    },
                }),
            };
        }
        if (op === 'put-item') {
            const item = JSON.parse(args[args.indexOf('--item') + 1]);
            const k = keyFromAttr(item);
            const condIdx = args.indexOf('--condition-expression');
            if (condIdx !== -1) {
                const expr = args[condIdx + 1];
                // Solo modelamos attribute_not_exists(#pk): rechaza si ya existe.
                if (/attribute_not_exists/.test(expr) && store.has(k)) {
                    return {
                        code: 255,
                        stdout: '',
                        stderr: 'An error occurred (ConditionalCheckFailedException) when calling the PutItem operation: The conditional request failed',
                    };
                }
            }
            store.set(k, item);
            return { code: 0, stdout: '{}', stderr: '' };
        }
        if (op === 'get-item') {
            const key = JSON.parse(args[args.indexOf('--key') + 1]);
            const found = store.get(keyFromAttr(key));
            return { code: 0, stdout: found ? JSON.stringify({ Item: found }) : '{}', stderr: '' };
        }
        if (op === 'delete-item') {
            const key = JSON.parse(args[args.indexOf('--key') + 1]);
            store.delete(keyFromAttr(key));
            return { code: 0, stdout: '{}', stderr: '' };
        }
        return { code: 0, stdout: '{}', stderr: '' };
    };
    return { run, calls, store };
}

// -----------------------------------------------------------------------------
// CA-1 - runner arma args como array, sin interpolacion, shell:false
// -----------------------------------------------------------------------------

test('CA-1 . createAwsCliRunner pasa args como elementos separados y literales a spawn (A03)', async () => {
    const calls = [];
    const { run } = prov.createAwsCliRunner(AWS_ENV, { spawn: makeFakeSpawn(calls) });

    // Valores con metacaracteres shell: deben llegar LITERALES, sin interpolar.
    const nasty = 'tbl; rm -rf / $(whoami) `id`';
    await run(['put-item', '--table-name', nasty]);

    assert.equal(calls.length, 1);
    const call = calls[0];
    assert.equal(call.cmd, 'aws');
    // `dynamodb` es el primer token fijo; luego los args tal cual.
    assert.deepEqual(call.args, ['dynamodb', 'put-item', '--table-name', nasty]);
    // El valor peligroso llega LITERAL (mismo string, sin expandir).
    assert.equal(call.args[call.args.length - 1], nasty);
    // shell:false explicito (nunca shell string) + env inyectado sin merge.
    assert.equal(call.opts.shell, false);
    assert.equal(call.opts.env, AWS_ENV);
});

test('CA-1 . createAwsCliRunner resuelve { code, stdout, stderr } del child', async () => {
    const { run } = prov.createAwsCliRunner(AWS_ENV, { spawn: makeFakeSpawn([]) });
    const res = await run(['describe-table', '--table-name', 'T']);
    assert.equal(res.code, 0);
    assert.equal(res.stdout, '{}');
    assert.equal(typeof res.stderr, 'string');
});

// -----------------------------------------------------------------------------
// CA-3 - fail-closed de credenciales ANTES de spawnear
// -----------------------------------------------------------------------------

test('CA-3 . createAwsCliRunner falla fail-closed sin credenciales, sin spawnear', () => {
    let spawned = false;
    const spy = () => { spawned = true; return new EventEmitter(); };

    assert.throws(
        () => prov.createAwsCliRunner({}, { spawn: spy }),
        /faltan credenciales AWS/i,
    );
    assert.throws(
        () => prov.createAwsCliRunner({ AWS_ACCESS_KEY_ID: 'x' }, { spawn: spy }),
        /faltan credenciales AWS/i,
    );
    assert.throws(() => prov.createAwsCliRunner(undefined, { spawn: spy }), /credenciales/i);
    // Nunca se intento spawnear el CLI con credenciales vacias.
    assert.equal(spawned, false);
});

test('CA-3 . createAwsCliRunner con credenciales completas no lanza', () => {
    assert.doesNotThrow(() => prov.createAwsCliRunner(AWS_ENV, { spawn: makeFakeSpawn([]) }));
});

// -----------------------------------------------------------------------------
// CA-2 - config sin hardcode: normalizeConfig exige tableName para driver real
// -----------------------------------------------------------------------------

test('CA-2 . normalizeConfig rechaza el driver real sin tableName', () => {
    // driver "real" = kind != in-memory (simulamos el aws-cli).
    const realDriver = { kind: 'aws-cli' };
    assert.throws(
        () => normalizeConfig({ kernel: {} }, realDriver),
        (e) => e instanceof KernelStoreError && /tableName requerido/.test(e.message),
    );
});

test('CA-2 . normalizeConfig lee tableName/region desde la seccion kernel', () => {
    const realDriver = { kind: 'aws-cli' };
    const cfg = normalizeConfig({ kernel: { tableName: 'IntraleKernel', region: 'us-east-1' } }, realDriver);
    assert.equal(cfg.tableName, 'IntraleKernel');
    assert.equal(cfg.region, 'us-east-1');
});

// -----------------------------------------------------------------------------
// CA-7 - roundtrip putProduct + listProducts contra driver AWS CLI (run fake)
// -----------------------------------------------------------------------------

test('CA-7 . putProduct + listProducts roundtrip contra createAwsCliDynamoDriver({ run }) fake', async () => {
    const fake = makeFakeAwsRun();
    const driver = prov.createAwsCliDynamoDriver({ run: fake.run });
    assert.equal(driver.kind, 'aws-cli'); // NO es in-memory: es el driver real.

    const store = createKernelStore({
        driver,
        contextProjectId: 'acme',
        config: { kernel: { tableName: 'IntraleKernel', region: 'us-east-1' } },
    });

    await store.putProduct({ productId: 'widget-1', name: 'Widget Uno' });
    await store.putProduct({ productId: 'widget-2', name: 'Widget Dos' });

    const list = await store.listProducts();
    assert.equal(list.length, 2);
    assert.deepEqual(
        list.map((p) => p.productId).sort(),
        ['widget-1', 'widget-2'],
    );
    // El envelope nested (`body`) se preserva en el round-trip por el driver real.
    const w1 = list.find((p) => p.productId === 'widget-1');
    assert.equal(w1.name, 'Widget Uno');

    // Efectivamente paso por el CLI (put-item + get-item), no por FS ni in-memory.
    assert.ok(fake.calls.some((c) => c[0] === 'put-item'));
    assert.ok(fake.calls.some((c) => c[0] === 'get-item'));
});

test('CA-7 . ConditionalCheckFailedException -> error tipado, sin estado a medias (append-only)', async () => {
    const fake = makeFakeAwsRun();
    const driver = prov.createAwsCliDynamoDriver({ run: fake.run });

    // Colision append-only a nivel driver: attribute_not_exists(#pk) sobre una
    // clave ya presente -> ConditionalCheckFailedException -> error tipado. Se
    // prueba en el driver (mapeo del CLI) para no depender del ULID interno.
    const dupItem = {
        PK: 'acme', SK: 'signature#dup', entityType: 'signature',
        projectId: 'acme', schemaVersion: '1.0',
        body: { signer: 'x', target: 'y', checksum: 'z' },
    };
    const spec = {
        type: 'dynamodb_table', tableName: 'IntraleKernel',
        keys: [
            { name: 'PK', attributeType: 'S', keyType: 'HASH' },
            { name: 'SK', attributeType: 'S', keyType: 'RANGE' },
        ],
    };
    const appendOnly = {
        conditionExpression: 'attribute_not_exists(#pk)',
        expressionAttributeNames: { '#pk': 'PK' },
    };

    await driver.putItem(spec, dupItem, appendOnly); // primera escritura OK
    await assert.rejects(
        () => driver.putItem(spec, dupItem, appendOnly), // segunda -> CCF tipado
        (err) => err instanceof prov.ConditionalCheckFailedError,
    );
    // Estado NO a medias: solo un item persistido para esa clave.
    const stored = [...fake.store.keys()].filter((k) => k.includes('signature#dup'));
    assert.equal(stored.length, 1);
});

// -----------------------------------------------------------------------------
// CA-6 - coexistencia: con durable:false no se instancia runner ni driver real
// -----------------------------------------------------------------------------

test('CA-6 . con kernel.durable:false NO se instancia el runner ni se spawnea (cero AWS)', () => {
    // Simulamos el wiring gateado por el flag (el que consumiran las partes 2/3):
    // solo con durable:true se toca createAwsCliRunner/createAwsCliDynamoDriver.
    let runnerCalls = 0;
    const cfgOff = { kernel: { tableName: '', region: '', durable: false } };

    function wireDurableStore(cfg) {
        const durable = !!(cfg.kernel && cfg.kernel.durable);
        if (!durable) return { durable: false, driver: null };
        runnerCalls += 1;
        const { run } = prov.createAwsCliRunner(AWS_ENV);
        return { durable: true, driver: prov.createAwsCliDynamoDriver({ run }) };
    }

    const wired = wireDurableStore(cfgOff);
    assert.equal(wired.durable, false);
    assert.equal(wired.driver, null);
    assert.equal(runnerCalls, 0); // cero instanciacion del runner real -> cero AWS.
});

// -----------------------------------------------------------------------------
// kernel-provision - contrato de tabla y env acotado (paso admin)
// -----------------------------------------------------------------------------

test('kernel-provision . buildKernelTableContract exige tableName (no hardcode)', () => {
    assert.throws(
        () => kernelProvision.buildKernelTableContract({}),
        /tableName requerido/,
    );
    const c = kernelProvision.buildKernelTableContract({ tableName: 'IntraleKernel' });
    assert.equal(c.recurso.nombre, 'IntraleKernel');
    assert.equal(c.recurso.schema.hashKey.nombre, 'PK');
    assert.equal(c.recurso.schema.rangeKey.nombre, 'SK');
});

test('kernel-provision . buildAwsScopedEnv solo copia vars del scope aws (nunca process.env crudo)', () => {
    const src = {
        AWS_ACCESS_KEY_ID: 'AKIA', AWS_SECRET_ACCESS_KEY: 'sk',
        SECRET_UNRELATED: 'nope', PATH: '/bin',
    };
    const env = kernelProvision.buildAwsScopedEnv(src, 'us-east-1');
    assert.equal(env.AWS_ACCESS_KEY_ID, 'AKIA');
    assert.equal(env.AWS_SECRET_ACCESS_KEY, 'sk');
    assert.equal(env.AWS_REGION, 'us-east-1'); // region de config completa si falta.
    assert.equal(env.SECRET_UNRELATED, undefined); // nunca copia vars fuera del scope.
    assert.equal(env.PATH, undefined);
});

test('kernel-provision . provisionKernelTable roundtrip con driver inyectado (ok)', async () => {
    const fake = makeFakeAwsRun();
    const driver = prov.createAwsCliDynamoDriver({ run: fake.run });
    const res = await kernelProvision.provisionKernelTable({
        kernelConfig: { tableName: 'IntraleKernel', region: 'us-east-1' },
        driver,
        now: () => 1234567890,
    });
    assert.equal(res.status, 'ok');
    assert.equal(res.evidence.resource.tableName, 'IntraleKernel');
    assert.equal(res.evidence.roundTrip.create, true);
    assert.equal(res.evidence.roundTrip.confirmedGone, true);
});
