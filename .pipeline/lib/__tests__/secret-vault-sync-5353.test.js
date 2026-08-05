// =============================================================================
// Tests de la superficie SYNC de secret-vault.js (#5353 — split 3/3 de #5338)
// node --test  (entra por el glob existente de `npm run test:pipeline`)
// =============================================================================
//
// Por qué es un archivo NUEVO y no un append a `secret-vault.test.js`:
// D1.5 / D-SYNC-4 exigen que la suite de #5352 quede verde **sin modificarse**
// —si un test suyo necesita cambiar, es señal de que se rompió su contrato—.
// Un archivo aparte convierte esa CA en algo verificable de un vistazo:
//
//   $ git diff origin/main -- .pipeline/lib/__tests__/secret-vault.test.js
//   (vacío)
//
// Ninguno de estos tests requiere red ni cuenta AWS.
// =============================================================================
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const util = require('node:util');

const {
    VAULT_ERROR_CODES,
    createInMemoryVaultDriver,
    createAwsCliVaultDriver,
    createSecretVault,
} = require('../secret-vault');

// -----------------------------------------------------------------------------
// Helpers (deliberadamente propios: no se importa nada de secret-vault.test.js)
// -----------------------------------------------------------------------------

const PREFIX = '/intrale';
const PROJECT = 'intrale';
const HOST = 'hostSync';

const TELEGRAM = { bot_token: 'CANARIO-TELEGRAM', chat_id: '42' };
const AWS_SCOPE = { AWS_ACCESS_KEY_ID: 'CANARIO-AKIA' };

function configVault(over = {}) {
    return {
        enabled: true,
        prefix: PREFIX,
        projectId: PROJECT,
        hostId: HOST,
        cache_ttl_seconds: 300,
        required_scopes: ['telegram', 'aws'],
        shared_secrets: ['telegram'],
        ...over,
    };
}

function seed() {
    return {
        [`${PREFIX}/${PROJECT}/shared/telegram`]: TELEGRAM,
        [`${PREFIX}/${PROJECT}/hosts/${HOST}/aws`]: AWS_SCOPE,
    };
}

/**
 * Código del módulo SIN comentarios.
 *
 * Los greps de prohibición tienen que correr sobre el CÓDIGO: el módulo
 * documenta explícitamente qué está prohibido (`Atomics.wait`,
 * `worker_threads`, `deasync`, `@aws-sdk/*`), así que un grep sobre el archivo
 * crudo se dispararía con el propio texto de la prohibición.
 */
function codigoSinComentarios(archivo) {
    return fs.readFileSync(archivo, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, ' ')       // bloques /* ... */
        .split(/\r?\n/)
        .filter((linea) => !linea.trim().startsWith('//'))
        .join('\n');
}

const FUENTE_VAULT = () => codigoSinComentarios(path.join(__dirname, '..', 'secret-vault.js'));

/** Captura la falla de un thunk sync o de una promesa, con la misma forma. */
async function fallaDe(fn) {
    try {
        const r = await fn();
        return { lanzo: false, valor: r };
    } catch (err) {
        return { lanzo: true, name: err.name, code: err.code, message: err.message };
    }
}

// =============================================================================
// D1.2 — la superficie sync existe y NO devuelve Promise
// =============================================================================

test('D1.2 · resolveNamespaceSync y resolveScopeSync son sync y no devuelven Promise', () => {
    const vault = createSecretVault({
        config: configVault(),
        driver: createInMemoryVaultDriver({ parameters: seed() }),
    });

    assert.equal(typeof vault.resolveNamespaceSync, 'function');
    assert.equal(typeof vault.resolveScopeSync, 'function');
    assert.equal(vault.resolveNamespaceSync.constructor.name, 'Function');
    assert.equal(vault.resolveScopeSync.constructor.name, 'Function');

    const ns = vault.resolveNamespaceSync();
    assert.ok(!(ns instanceof Promise), 'el retorno sync no puede ser una Promise');
    assert.equal(typeof ns.then, 'undefined', 'ni siquiera thenable');
    assert.equal(ns.enabled, true);
    assert.deepEqual(Object.keys(ns.scopes).sort(), ['aws', 'telegram']);

    // D-SYNC-4 — la API async de #5352 no cambia de forma.
    assert.equal(vault.resolveNamespace.constructor.name, 'AsyncFunction');
    assert.equal(vault.resolveScope.constructor.name, 'AsyncFunction');
});

test('D1.5 · los gemelos sync NO alteran la superficie enumerable que #5352 congeló', () => {
    const vault = createSecretVault({
        config: configVault(),
        driver: createInMemoryVaultDriver({ parameters: seed() }),
    });

    // El test 8 de #5352 afirma exactamente esto. Si los métodos sync fueran
    // enumerables, esa suite rompería y habría que editarla — justo lo prohibido.
    assert.deepEqual(
        Object.keys(vault).sort(),
        ['clearCache', 'resolveNamespace', 'resolveScope'],
    );
    assert.ok(!util.inspect(vault).includes('Sync'), 'tampoco aparecen en el inspect');
    // Pero son públicos y accesibles.
    assert.equal(typeof vault.resolveNamespaceSync, 'function');
});

// =============================================================================
// D1.3 — port sync en los DOS drivers
// =============================================================================

test('D1.3 · los dos drivers exponen getParametersByPathSync / getSecretValueSync', () => {
    const inMemory = createInMemoryVaultDriver({ parameters: seed() });
    const awsCli = createAwsCliVaultDriver({ run: () => '{"Parameters":[]}' });

    for (const driver of [inMemory, awsCli]) {
        assert.equal(typeof driver.getParametersByPathSync, 'function', driver.kind);
        assert.equal(typeof driver.getSecretValueSync, 'function', driver.kind);
        const res = driver.getParametersByPathSync(`${PREFIX}/${PROJECT}/shared/`, {});
        assert.ok(!(res instanceof Promise), `${driver.kind} devolvió Promise en el port sync`);
        assert.ok(Array.isArray(res.parameters));
    }

    // El de aws-cli se apoya en el runner que YA era sync: sin dep nueva. Ésta
    // sigue siendo la garantía FUERTE del camino de LECTURA y no se toca: el
    // módulo del runtime no menciona el SDK ni indirectamente.
    assert.equal(FUENTE_VAULT().includes('@aws-sdk'), false,
        'no se agregó ninguna dependencia @aws-sdk/*');

    // #5465 (2/3 de #5425) incorpora `@aws-sdk/client-ssm` para el port de
    // PROVISIÓN, que es otro módulo (`vault-provisioner.js`), otro proceso y
    // otra identidad. La guarda original de #5353 se escribió contra TODO
    // `package.json` para demostrar que la superficie sync de lectura no
    // necesitaba SDK; esa intención se conserva ACOTANDO la aserción a una
    // allowlist, en vez de prohibir el paquete a nivel repo. Así sigue fallando
    // si alguien mete `client-secrets-manager` u otro cliente en el runtime.
    const SDK_PERMITIDOS = ['@aws-sdk/client-ssm'];
    const sdkDeclarados = Object.keys(require('../../../package.json').dependencies)
        .filter((d) => d.startsWith('@aws-sdk'))
        .sort();
    assert.deepEqual(sdkDeclarados, [...SDK_PERMITIDOS].sort(),
        'el único `@aws-sdk/*` admitido es el cliente SSM del port de provisión (#5465)');
});

test('D1.3 · el port sync del driver aws-cli consume NextToken igual que el async', async () => {
    const paginas = [
        JSON.stringify({
            Parameters: [{ Name: `${PREFIX}/${PROJECT}/shared/telegram`, Value: '{}' }],
            NextToken: 'p2',
        }),
        JSON.stringify({
            Parameters: [{ Name: `${PREFIX}/${PROJECT}/shared/aws`, Value: '{}' }],
        }),
    ];
    const hacerDriver = () => {
        let i = 0;
        return createAwsCliVaultDriver({ run: () => paginas[i++] });
    };

    const sync = hacerDriver().getParametersByPathSync(`${PREFIX}/${PROJECT}/shared/`, {});
    const asinc = await hacerDriver().getParametersByPath(`${PREFIX}/${PROJECT}/shared/`, {});

    assert.equal(sync.parameters.length, 2, 'el camino sync también agotó la paginación');
    assert.deepEqual(sync, asinc, 'misma paginación, mismo resultado');
});

// =============================================================================
// D1.4 — paridad sync/async: MISMO valor y MISMA falla (BLOQUEANTE)
// =============================================================================

test('D1.4 · para el mismo seed, sync y async devuelven exactamente el mismo valor', async () => {
    const vaultA = createSecretVault({
        config: configVault(), driver: createInMemoryVaultDriver({ parameters: seed() }),
    });
    const vaultB = createSecretVault({
        config: configVault(), driver: createInMemoryVaultDriver({ parameters: seed() }),
    });

    assert.deepEqual(vaultA.resolveNamespaceSync(), await vaultB.resolveNamespace());
    assert.deepEqual(
        vaultA.resolveScopeSync({ scopes: ['telegram'] }),
        await vaultB.resolveScope({ scopes: ['telegram'] }),
    );
});

test('D1.4 · paridad sync/async sobre las TRES fallas terminales', async () => {
    // Cada caso arma dos vaults gemelos (uno por camino) sobre el mismo seed.
    const casos = [
        {
            nombre: VAULT_ERROR_CODES.SECRET_MISSING,
            driver: () => createInMemoryVaultDriver({ parameters: {} }),
            config: () => configVault(),
        },
        {
            nombre: VAULT_ERROR_CODES.CLI,
            // G-2: un scope cuyo valor no es JSON válido ⇒ VaultCliError.
            driver: () => createInMemoryVaultDriver({
                parameters: {
                    [`${PREFIX}/${PROJECT}/shared/telegram`]: 'esto-no-es-json',
                    [`${PREFIX}/${PROJECT}/hosts/${HOST}/aws`]: AWS_SCOPE,
                },
            }),
            config: () => configVault(),
        },
        {
            nombre: VAULT_ERROR_CODES.TRUNCATED_RESPONSE,
            // Un exit 0 con JSON cortado es truncación, no "vault vacío".
            driver: () => createAwsCliVaultDriver({ run: () => '{"Parameters":[' }),
            config: () => configVault({ required_scopes: ['telegram'], shared_secrets: ['telegram'] }),
        },
    ];

    for (const caso of casos) {
        const vSync = createSecretVault({ config: caso.config(), driver: caso.driver() });
        const vAsync = createSecretVault({ config: caso.config(), driver: caso.driver() });

        const fSync = await fallaDe(() => vSync.resolveNamespaceSync());
        const fAsync = await fallaDe(() => vAsync.resolveNamespace());

        assert.ok(fSync.lanzo, `${caso.nombre}: el camino sync no falló`);
        assert.ok(fAsync.lanzo, `${caso.nombre}: el camino async no falló`);
        assert.equal(fSync.code, caso.nombre, `${caso.nombre}: código del camino sync`);
        assert.equal(fSync.code, fAsync.code, `${caso.nombre}: mismo código`);
        assert.equal(fSync.name, fAsync.name, `${caso.nombre}: misma clase`);
        assert.equal(fSync.message, fAsync.message, `${caso.nombre}: mismo mensaje`);
    }
});

// =============================================================================
// D-SYNC-3 — un solo cuerpo ⇒ una sola caché
// =============================================================================

test('D-SYNC-3 · la caché es compartida: lo que puebla el camino sync lo ve el async', async () => {
    const driver = createInMemoryVaultDriver({ parameters: seed() });
    const vault = createSecretVault({ config: configVault(), driver });

    vault.resolveNamespaceSync();
    const trasSync = driver.calls.length;
    assert.ok(trasSync > 0, 'la primera lectura sí pega al driver');

    await vault.resolveNamespace();
    assert.equal(driver.calls.length, trasSync, 'el camino async salió de la caché del sync');

    vault.clearCache();
    await vault.resolveNamespace();
    const trasAsync = driver.calls.length;
    assert.ok(trasAsync > trasSync, 'tras clearCache el async vuelve a leer');

    vault.resolveNamespaceSync();
    assert.equal(driver.calls.length, trasAsync, 'y ahora el sync sale de la caché del async');
});

// =============================================================================
// D-SYNC-6 — driver sin port sync ⇒ fail-closed NOMBRANDO el método
// =============================================================================

test('D-SYNC-6 · un driver sin port sync falla nombrando el metodo faltante', () => {
    const soloAsync = {
        kind: 'solo-async',
        async getParametersByPath() { return { parameters: [] }; },
        async getSecretValue() { return null; },
    };
    const vault = createSecretVault({ config: configVault(), driver: soloAsync });

    assert.throws(() => vault.resolveNamespaceSync(), (err) => {
        assert.equal(err.code, VAULT_ERROR_CODES.CONFIG_INVALID);
        assert.match(err.message, /getParametersByPathSync/, 'el mensaje nombra el método faltante');
        assert.match(err.message, /solo-async/, 'y el driver que lo incumple');
        return true;
    });

    // Nunca devuelve vacío: el fail-closed es lanzar, no `{}`.
    assert.throws(() => vault.resolveScopeSync({ scopes: ['telegram'] }));
});

test('D-SYNC-6 · el modulo no usa ningun hack de espera bloqueante', () => {
    const fuente = FUENTE_VAULT();
    for (const prohibido of ['Atomics.wait', 'worker_threads', 'deasync', '@aws-sdk']) {
        assert.equal(fuente.includes(prohibido), false, `el módulo usa \`${prohibido}\``);
    }
    // Tampoco se spawnea un Node hijo para simular sincronía.
    assert.equal(/execFileSync\(\s*['"]node['"]/.test(fuente), false);
});

// =============================================================================
// D-SYNC-8 — con el gate cerrado, cero invocaciones en AMBOS caminos
// =============================================================================

test('D-SYNC-8 · con vault.enabled:false ningun camino invoca el driver', async () => {
    const driver = createInMemoryVaultDriver({ parameters: seed() });
    const vault = createSecretVault({ config: configVault({ enabled: false }), driver });

    assert.deepEqual(vault.resolveNamespaceSync(), {
        enabled: false, namespace: null, scopes: {}, tiers: {},
    });
    assert.deepEqual(vault.resolveScopeSync({ scopes: ['telegram'] }), {});
    await vault.resolveNamespace();
    await vault.resolveScope({ scopes: ['telegram'] });

    assert.equal(driver.calls.length, 0, 'ni una invocación con el gate cerrado');
});
