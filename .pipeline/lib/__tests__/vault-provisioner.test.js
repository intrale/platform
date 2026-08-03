// =============================================================================
// Tests de lib/vault-provisioner.js (#5465 — split 2/3 de #5425)
// node --test  (entra por el glob existente de `npm run test:pipeline`)
// =============================================================================
//
// NINGÚN test requiere red, cuenta AWS ni `@aws-sdk/client-ssm` instalado: el
// port se ejerce con un fake propio y el adapter real se ejerce inyectando los
// constructores de comando. Ese último es el que evita la "cobertura ilusoria":
// sin él, todo correría contra el fake y el adapter que va a producción quedaría
// sin una sola aserción sobre la forma de los comandos que emite.
//
// El fake es PROPIO a propósito: `createInMemoryVaultDriver` pertenece al
// runtime de LECTURA y ampliarlo con verbos de escritura sería mover la frontera
// que este split viene a sostener.
// =============================================================================
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const util = require('node:util');

const {
    VAULT_PROVISION_STATES,
    VAULT_PROVISION_ERROR_CODES,
    VaultProvisionError,
    createVaultProvisioner,
    createAwsSsmProvisionDriver,
} = require('../vault-provisioner');

// -----------------------------------------------------------------------------
// Constantes y fakes
// -----------------------------------------------------------------------------

const CMK = 'arn:aws:kms:us-east-1:111122223333:key/1a2b3c4d-0000-0000-0000-abcdefabcdef';
const PRINCIPAL_PROVISION = 'arn:aws:sts::111122223333:assumed-role/intrale-vault-provisioning/op';
const PRINCIPAL_RUNTIME = 'arn:aws:sts::111122223333:assumed-role/intrale-pipeline-runtime/agent';

// Canario: si aparece en CUALQUIER superficie observable, hay fuga.
const CANARIO = 'CANARIO-valor-secreto-9f3a1c7e';

const CONFIG_BASE = Object.freeze({
    prefix: '/intrale',
    projectId: 'platform',
    hostId: 'ws-01',
    kmsKeyId: CMK,
    provisioningPrincipal: PRINCIPAL_PROVISION,
});

/**
 * Fake del port SSM. Cuenta llamadas y guarda los argumentos exactos para poder
 * afirmar sobre ellos. Devuelve campos DE MÁS (`Value`, `$metadata`) en la
 * metadata justamente para probar que la proyección por allowlist los descarta.
 */
function fakeSsmPort({ inicial = null, fallarEn = null } = {}) {
    let store = inicial ? { ...inicial } : null;
    const llamadas = { get: 0, put: 0, meta: 0, ultimoGet: null, ultimoPut: null };

    return {
        llamadas,
        verStore: () => (store ? { ...store } : null),

        async getParameter({ Name, WithDecryption }) {
            llamadas.get += 1;
            llamadas.ultimoGet = { Name, WithDecryption };
            if (fallarEn === 'get') {
                const e = new Error(`boom del SDK con el valor ${CANARIO} adentro`);
                e.name = 'InternalServerError';
                e.$metadata = { httpStatusCode: 500, requestId: 'req-1' };
                throw e;
            }
            return store ? { ...store } : null;
        },

        async putParameter(params) {
            llamadas.put += 1;
            llamadas.ultimoPut = { ...params };
            if (fallarEn === 'put') {
                const e = new Error(`boom del SDK con el valor ${CANARIO} adentro`);
                e.name = 'ThrottlingException';
                e.$metadata = { httpStatusCode: 400, requestId: 'req-2' };
                throw e;
            }
            store = {
                Value: params.Value,
                Type: params.Type,
                Version: store ? store.Version + 1 : 1,
            };
            return { Version: store.Version };
        },

        async getParameterMetadata() {
            llamadas.meta += 1;
            if (!store) return null;
            // Campos de más, a propósito.
            return {
                Type: store.Type,
                Version: store.Version,
                Value: store.Value,
                $metadata: { httpStatusCode: 200, requestId: 'req-3' },
            };
        },
    };
}

function fakeIdentity(arn, { fallar = false } = {}) {
    return {
        async resolveArn() {
            if (fallar) throw new Error(`STS falló con sesión ${CANARIO}`);
            return arn;
        },
    };
}

function fakeOverwriteAuthority(respuesta) {
    const estado = { llamadas: 0, ultimo: null };
    return {
        estado,
        async authorize({ path }) {
            estado.llamadas += 1;
            estado.ultimo = { path };
            if (typeof respuesta === 'function') return respuesta({ path });
            return respuesta;
        },
    };
}

function armar({ ssm, identityArn = PRINCIPAL_PROVISION, autoriza = false, config = {} } = {}) {
    const puerto = ssm || fakeSsmPort();
    const authority = fakeOverwriteAuthority(autoriza);
    const prov = createVaultProvisioner({
        ssm: puerto,
        identity: fakeIdentity(identityArn),
        overwriteAuthority: authority,
        config: { ...CONFIG_BASE, ...config },
    });
    return { prov, ssm: puerto, authority };
}

/** Junta todas las superficies observables de un error o resultado. */
function superficies(x) {
    const partes = [util.inspect(x, { depth: 10 })];
    if (x && typeof x === 'object') {
        if (typeof x.message === 'string') partes.push(x.message);
        if (typeof x.stack === 'string') partes.push(x.stack);
        if (x.cause !== undefined) partes.push(util.inspect(x.cause, { depth: 10 }));
        try { partes.push(JSON.stringify(x)); } catch { /* circular: ya cubierto por inspect */ }
    }
    return partes.join('\n');
}

// -----------------------------------------------------------------------------
// 1-3 — Estados idempotentes
// -----------------------------------------------------------------------------

test('crea el parámetro con SecureString, CMK explícita y Overwrite:true', async () => {
    const { prov, ssm } = armar();

    const r = await prov.provisionSecret({ tier: 'shared', scope: 'telegram-token', value: 's3cr3t' });

    assert.equal(r.estado, VAULT_PROVISION_STATES.CREATED);
    assert.equal(r.path, '/intrale/platform/shared/telegram-token');
    assert.equal(ssm.llamadas.put, 1);
    // Los cuatro campos POSITIVOS de la escritura.
    assert.equal(ssm.llamadas.ultimoPut.Type, 'SecureString');
    assert.equal(ssm.llamadas.ultimoPut.KeyId, CMK);
    assert.equal(ssm.llamadas.ultimoPut.Overwrite, true);
    assert.equal(ssm.llamadas.ultimoPut.Name, '/intrale/platform/shared/telegram-token');
});

test('una repetición idéntica devuelve `sin cambios` sin ejecutar PutParameter ni subir versión', async () => {
    const ssm = fakeSsmPort({ inicial: { Value: 's3cr3t', Type: 'SecureString', Version: 7 } });
    const { prov } = armar({ ssm });

    const r = await prov.provisionSecret({ tier: 'shared', scope: 'telegram-token', value: 's3cr3t' });

    assert.equal(r.estado, VAULT_PROVISION_STATES.UNCHANGED);
    assert.equal(ssm.llamadas.put, 0, 'no debe escribir');
    assert.equal(r.metadata.Version, 7, 'la versión no aumenta');
});

test('un valor distinto CON capability devuelve `sobrescrito` y avanza la versión', async () => {
    const ssm = fakeSsmPort({ inicial: { Value: 'viejo', Type: 'SecureString', Version: 4 } });
    const { prov, authority } = armar({ ssm, autoriza: true });

    const r = await prov.provisionSecret({ tier: 'shared', scope: 'telegram-token', value: 'nuevo' });

    assert.equal(r.estado, VAULT_PROVISION_STATES.OVERWRITTEN);
    assert.equal(r.metadata.Version, 5);
    assert.equal(ssm.llamadas.put, 1);
    assert.equal(authority.estado.llamadas, 1);
    assert.equal(authority.estado.ultimo.path, '/intrale/platform/shared/telegram-token');
});

// -----------------------------------------------------------------------------
// 4 — Autorización: NO la decide el caller (REQ-SEC-5465-1)
// -----------------------------------------------------------------------------

test('un valor distinto SIN capability no escribe y falla con OVERWRITE_DENIED', async () => {
    const ssm = fakeSsmPort({ inicial: { Value: 'viejo', Type: 'SecureString', Version: 4 } });
    const { prov } = armar({ ssm, autoriza: false });

    await assert.rejects(
        () => prov.provisionSecret({ tier: 'shared', scope: 'telegram-token', value: 'nuevo' }),
        (e) => e.code === VAULT_PROVISION_ERROR_CODES.OVERWRITE_DENIED,
    );
    assert.equal(ssm.llamadas.put, 0);
});

test('la capability sólo autoriza con `true` estricto: un truthy no alcanza', async () => {
    const ssm = fakeSsmPort({ inicial: { Value: 'viejo', Type: 'SecureString', Version: 1 } });
    const prov = createVaultProvisioner({
        ssm,
        identity: fakeIdentity(PRINCIPAL_PROVISION),
        overwriteAuthority: { async authorize() { return 'sí'; } },
        config: CONFIG_BASE,
    });

    await assert.rejects(
        () => prov.provisionSecret({ tier: 'shared', scope: 'x', value: 'nuevo' }),
        (e) => e.code === VAULT_PROVISION_ERROR_CODES.OVERWRITE_DENIED,
    );
    assert.equal(ssm.llamadas.put, 0);
});

test('el payload es cerrado: `allowOverwrite` o `kmsKeyId` propios son rechazo, no campos ignorados', async () => {
    const { prov, ssm } = armar();

    for (const extra of [{ allowOverwrite: true }, { kmsKeyId: 'arn:aws:kms:otra' }, { principal: PRINCIPAL_PROVISION }]) {
        await assert.rejects(
            () => prov.provisionSecret({ tier: 'shared', scope: 'x', value: 'v', ...extra }),
            (e) => e.code === VAULT_PROVISION_ERROR_CODES.PAYLOAD_INVALID,
        );
    }
    assert.equal(ssm.llamadas.get, 0, 'ni siquiera se lee');
    assert.equal(ssm.llamadas.put, 0);
});

// -----------------------------------------------------------------------------
// 5-7 — Rechazos previos a cualquier llamada AWS
// -----------------------------------------------------------------------------

test('la identidad runtime se rechaza sin emitir una sola llamada a SSM', async () => {
    const ssm = fakeSsmPort();
    const { prov } = armar({ ssm, identityArn: PRINCIPAL_RUNTIME });

    await assert.rejects(
        () => prov.provisionSecret({ tier: 'shared', scope: 'x', value: 'v' }),
        (e) => e.code === VAULT_PROVISION_ERROR_CODES.IDENTITY_DENIED,
    );
    assert.equal(ssm.llamadas.get, 0);
    assert.equal(ssm.llamadas.put, 0);
});

test('una identidad no verificable (STS falla o devuelve vacío) falla cerrado', async () => {
    for (const identity of [fakeIdentity(PRINCIPAL_PROVISION, { fallar: true }), fakeIdentity('')]) {
        const ssm = fakeSsmPort();
        const prov = createVaultProvisioner({
            ssm,
            identity,
            overwriteAuthority: fakeOverwriteAuthority(true),
            config: CONFIG_BASE,
        });
        await assert.rejects(
            () => prov.provisionSecret({ tier: 'shared', scope: 'x', value: 'v' }),
            (e) => e.code === VAULT_PROVISION_ERROR_CODES.IDENTITY_DENIED,
        );
        assert.equal(ssm.llamadas.get, 0);
    }
});

test('sin CMK explícita el provisionador no se construye (falla cerrado)', () => {
    for (const kmsKeyId of [undefined, '', null]) {
        assert.throws(
            () => createVaultProvisioner({
                ssm: fakeSsmPort(),
                identity: fakeIdentity(PRINCIPAL_PROVISION),
                overwriteAuthority: fakeOverwriteAuthority(true),
                config: { ...CONFIG_BASE, kmsKeyId },
            }),
            (e) => e.code === VAULT_PROVISION_ERROR_CODES.CMK_INVALID,
        );
    }
});

test('un path inválido se rechaza antes de cualquier acceso remoto', async () => {
    const ssm = fakeSsmPort();
    const { prov } = armar({ ssm });

    for (const scope of ['../otro-proyecto', 'con/barra', '', 'punto.punto']) {
        await assert.rejects(() => prov.provisionSecret({ tier: 'shared', scope, value: 'v' }));
    }
    assert.equal(ssm.llamadas.get, 0);
    assert.equal(ssm.llamadas.put, 0);
});

test('el tier `rotating` se rechaza: vive en Secrets Manager, no en este port', async () => {
    const ssm = fakeSsmPort();
    const { prov } = armar({ ssm });

    await assert.rejects(
        () => prov.provisionSecret({ tier: 'rotating', scope: 'x', value: 'v' }),
        (e) => e.code === VAULT_PROVISION_ERROR_CODES.TIER_UNSUPPORTED,
    );
    assert.equal(ssm.llamadas.get, 0);
    assert.equal(ssm.llamadas.put, 0);
});

// -----------------------------------------------------------------------------
// 8 — Verificación posterior (REQ-SEC-5465-6)
// -----------------------------------------------------------------------------

test('la verificación posterior proyecta SÓLO Type y Version', async () => {
    const { prov } = armar();
    const r = await prov.provisionSecret({ tier: 'shared', scope: 'x', value: 'v' });

    assert.deepEqual(Object.keys(r.metadata).sort(), ['Type', 'Version']);
    assert.deepEqual(Object.keys(r).sort(), ['estado', 'metadata', 'path', 'scope', 'tier']);
    assert.equal(r.metadata.Type, 'SecureString');
});

test('la verificación posterior no descifra: pide metadata sin WithDecryption', async () => {
    const ssm = fakeSsmPort();
    const { prov } = armar({ ssm });
    await prov.provisionSecret({ tier: 'shared', scope: 'x', value: 'v' });

    assert.equal(ssm.llamadas.meta, 1, 'usa el método de metadata, no un get descifrado');
    // La única lectura descifrada es la comparación previa, en memoria.
    assert.equal(ssm.llamadas.get, 1);
    assert.equal(ssm.llamadas.ultimoGet.WithDecryption, true);
});

test('si el parámetro no queda como SecureString, la verificación falla cerrada', async () => {
    const ssm = fakeSsmPort();
    // El backend "acepta" el put pero degrada el tipo.
    const original = ssm.putParameter.bind(ssm);
    ssm.putParameter = async (p) => original({ ...p, Type: 'String' });

    const { prov } = armar({ ssm });
    await assert.rejects(
        () => prov.provisionSecret({ tier: 'shared', scope: 'x', value: 'v' }),
        (e) => e.code === VAULT_PROVISION_ERROR_CODES.VERIFY_FAILED,
    );
});

test('un parámetro preexistente en texto plano NO cuenta como `sin cambios`', async () => {
    // Mismo valor, pero `String`: está expuesto y hay que repararlo. Reparar es
    // sobrescribir, y sobrescribir exige capability.
    const ssm = fakeSsmPort({ inicial: { Value: 'v', Type: 'String', Version: 2 } });
    const { prov } = armar({ ssm, autoriza: true });

    const r = await prov.provisionSecret({ tier: 'shared', scope: 'x', value: 'v' });

    assert.equal(r.estado, VAULT_PROVISION_STATES.OVERWRITTEN);
    assert.equal(ssm.llamadas.ultimoPut.Type, 'SecureString');
});

// -----------------------------------------------------------------------------
// 9 — Concurrencia por nombre (REQ-SEC-5465-4)
// -----------------------------------------------------------------------------

test('dos writers concurrentes sobre el mismo nombre se serializan: un solo Put', async () => {
    const ssm = fakeSsmPort();
    const { prov } = armar({ ssm, autoriza: true });

    const [a, b] = await Promise.all([
        prov.provisionSecret({ tier: 'shared', scope: 'x', value: 'mismo' }),
        prov.provisionSecret({ tier: 'shared', scope: 'x', value: 'mismo' }),
    ]);

    assert.equal(ssm.llamadas.put, 1, 'el segundo ve el valor del primero y no reescribe');
    const estados = [a.estado, b.estado].sort();
    assert.deepEqual(estados, [VAULT_PROVISION_STATES.CREATED, VAULT_PROVISION_STATES.UNCHANGED].sort());
    assert.equal(ssm.verStore().Version, 1, 'sin falso doble bump de versión');
});

test('una falla en un nombre no traba las provisiones siguientes de ese nombre', async () => {
    const ssm = fakeSsmPort();
    const { prov } = armar({ ssm });

    await assert.rejects(() => prov.provisionSecret({ tier: 'shared', scope: 'x', value: 42 }));
    const r = await prov.provisionSecret({ tier: 'shared', scope: 'x', value: 'ok' });
    assert.equal(r.estado, VAULT_PROVISION_STATES.CREATED);
});

// -----------------------------------------------------------------------------
// 10 — Canario de no fuga (REQ-SEC-5465-5)
// -----------------------------------------------------------------------------

test('el valor no aparece en el resultado de una provisión exitosa', async () => {
    const { prov } = armar();
    const r = await prov.provisionSecret({ tier: 'shared', scope: 'x', value: CANARIO });

    assert.ok(!superficies(r).includes(CANARIO), 'el valor se filtró en el resultado');
});

test('el valor no aparece en los errores de GetParameter ni de PutParameter', async () => {
    for (const fallarEn of ['get', 'put']) {
        const ssm = fakeSsmPort({ fallarEn });
        const { prov } = armar({ ssm });

        const err = await prov
            .provisionSecret({ tier: 'shared', scope: 'x', value: CANARIO })
            .then(() => null, (e) => e);

        assert.ok(err instanceof VaultProvisionError, `${fallarEn}: debe traducirse a VaultProvisionError`);
        assert.equal(err.code, VAULT_PROVISION_ERROR_CODES.BACKEND);
        const s = superficies(err);
        assert.ok(!s.includes(CANARIO), `${fallarEn}: el valor se filtró`);
        assert.ok(!s.includes('$metadata'), `${fallarEn}: se filtró la respuesta AWS`);
        assert.ok(!s.includes('requestId'), `${fallarEn}: se filtró el requestId`);
        assert.equal(err.cause, undefined, `${fallarEn}: no debe encadenar el error del SDK`);
    }
});

test('el valor no aparece cuando falla la verificación de identidad', async () => {
    const prov = createVaultProvisioner({
        ssm: fakeSsmPort(),
        identity: fakeIdentity(PRINCIPAL_PROVISION, { fallar: true }),
        overwriteAuthority: fakeOverwriteAuthority(true),
        config: CONFIG_BASE,
    });

    const err = await prov
        .provisionSecret({ tier: 'shared', scope: 'x', value: CANARIO })
        .then(() => null, (e) => e);

    assert.ok(!superficies(err).includes(CANARIO));
});

test('el error de identidad denegada no filtra el ARN efectivo recibido', async () => {
    const { prov } = armar({ identityArn: PRINCIPAL_RUNTIME });

    const err = await prov
        .provisionSecret({ tier: 'shared', scope: 'x', value: 'v' })
        .then(() => null, (e) => e);

    assert.ok(!superficies(err).includes(PRINCIPAL_RUNTIME),
        'el ARN efectivo no debe terminar en un log compartido');
});

// -----------------------------------------------------------------------------
// 11 — Paridad del adapter real (evita cobertura ilusoria)
// -----------------------------------------------------------------------------

test('el adapter real emite GetParameter/PutParameter con la forma exacta esperada', async () => {
    const emitidos = [];
    class FakeGetParameterCommand {
        constructor(input) { this.tipo = 'get'; this.input = input; emitidos.push(this); }
    }
    class FakePutParameterCommand {
        constructor(input) { this.tipo = 'put'; this.input = input; emitidos.push(this); }
    }

    const client = {
        async send(cmd) {
            if (cmd.tipo === 'put') return { Version: 3 };
            return { Parameter: { Value: 'v', Type: 'SecureString', Version: 3 }, $metadata: { requestId: 'r' } };
        },
    };

    const driver = createAwsSsmProvisionDriver({
        client,
        commands: {
            GetParameterCommand: FakeGetParameterCommand,
            PutParameterCommand: FakePutParameterCommand,
        },
    });

    await driver.putParameter({
        Name: '/intrale/platform/shared/x', Value: 'v', Type: 'SecureString', KeyId: CMK, Overwrite: true,
    });
    assert.deepEqual(emitidos.at(-1).input, {
        Name: '/intrale/platform/shared/x', Value: 'v', Type: 'SecureString', KeyId: CMK, Overwrite: true,
    });

    await driver.getParameter({ Name: '/intrale/platform/shared/x', WithDecryption: true });
    assert.equal(emitidos.at(-1).input.WithDecryption, true);

    const meta = await driver.getParameterMetadata({ Name: '/intrale/platform/shared/x' });
    assert.equal(emitidos.at(-1).input.WithDecryption, false, 'la verificación NO descifra');
    assert.deepEqual(Object.keys(meta).sort(), ['Type', 'Version'], 'proyecta sólo Type y Version');
});

test('el adapter real traduce ParameterNotFound a null, no a excepción', async () => {
    class FakeGetParameterCommand { constructor(input) { this.input = input; } }
    const client = {
        async send() {
            const e = new Error('no está');
            e.name = 'ParameterNotFound';
            throw e;
        },
    };
    const driver = createAwsSsmProvisionDriver({
        client,
        commands: { GetParameterCommand: FakeGetParameterCommand, PutParameterCommand: class {} },
    });

    assert.equal(await driver.getParameter({ Name: '/x', WithDecryption: true }), null);
});

test('el adapter real no devuelve la respuesta cruda de AWS', async () => {
    class FakeGetParameterCommand { constructor(input) { this.input = input; } }
    const client = {
        async send() {
            return {
                Parameter: { Value: CANARIO, Type: 'SecureString', Version: 1, ARN: 'arn:aws:ssm:...' },
                $metadata: { httpStatusCode: 200, requestId: 'req-x' },
            };
        },
    };
    const driver = createAwsSsmProvisionDriver({
        client,
        commands: { GetParameterCommand: FakeGetParameterCommand, PutParameterCommand: class {} },
    });

    const r = await driver.getParameter({ Name: '/x', WithDecryption: true });
    assert.deepEqual(Object.keys(r).sort(), ['Type', 'Value', 'Version']);
    assert.ok(!Object.prototype.hasOwnProperty.call(r, '$metadata'));
    assert.ok(!Object.prototype.hasOwnProperty.call(r, 'ARN'));
});

// -----------------------------------------------------------------------------
// 12 — Frontera read-only intacta
// -----------------------------------------------------------------------------

test('el runtime de lectura sigue sin exponer verbos de escritura', () => {
    const secretVault = require('../secret-vault');

    assert.deepEqual(
        [...secretVault.VAULT_READONLY_COMMANDS].sort(),
        ['secretsmanager get-secret-value', 'ssm get-parameter', 'ssm get-parameters-by-path'].sort(),
        'la allowlist read-only no incorpora escritura',
    );
    const driver = secretVault.createInMemoryVaultDriver({});
    assert.equal(typeof driver.putParameter, 'undefined', 'el driver de lectura no aprovisiona');
});

test('el tier `host` construye el path segmentado por host con el validador canónico', async () => {
    const { prov } = armar();
    const r = await prov.provisionSecret({ tier: 'host', scope: 'db-pass', value: 'v' });

    assert.equal(r.path, '/intrale/platform/hosts/ws-01/db-pass');
    assert.equal(r.tier, 'host');
});
