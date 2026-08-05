// =============================================================================
// Tests de lib/secret-vault.js (#5352 — split 2/3 de #5338)
// node --test  (entra por el glob existente de `npm run test:pipeline`)
// =============================================================================
//
// 17 tests: los 16 de la tabla de "Detalles Técnicos" (rev-1 del arquitecto) +
// el test 17 que introduce CA-29.
//
// NINGÚN test requiere red ni cuenta AWS: el driver in-memory cubre el contrato
// y el camino aws-cli se ejerce con `execFileSync` / `run` inyectados. El test
// 13 (paridad de drivers) es el que evita la "cobertura ilusoria": sin él los
// demás corren sólo contra el fake y no prueban el driver que va a producción.
// =============================================================================
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const util = require('node:util');

const {
    VAULT_READONLY_COMMANDS,
    VAULT_ERROR_CODES,
    VAULT_TIERS,
    VAULT_TIER_SERVICE,
    MAX_CACHE_TTL_SECONDS,
    buildParameterPath,
    validateVaultNamespace,
    createInMemoryVaultDriver,
    createAwsCliVaultDriver,
    createAwsCliVaultRunner,
    createSecretVault,
    VaultSecretMissingError,
    VaultCliError,
    VaultTruncatedResponseError,
} = require('../secret-vault');

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

const PREFIX = '/intrale';
const PROJECT = 'intrale';
const HOST_A = 'hostA';
const HOST_B = 'hostB';

const TELEGRAM = { bot_token: 'CANARIO-TELEGRAM', chat_id: '42' };
const AWS_SCOPE = { AWS_ACCESS_KEY_ID: 'CANARIO-AKIA', AWS_SECRET_ACCESS_KEY: 'CANARIO-SECRET' };

function configVault(over = {}) {
    return {
        enabled: true,
        prefix: PREFIX,
        projectId: PROJECT,
        hostId: HOST_A,
        cache_ttl_seconds: 300,
        required_scopes: ['telegram', 'aws'],
        shared_secrets: ['telegram'],
        region: 'us-east-2',
        ...over,
    };
}

/** Siembra el namespace completo del host A (telegram compartido, aws por host). */
function seedHostA() {
    return {
        [`${PREFIX}/${PROJECT}/shared/telegram`]: TELEGRAM,
        [`${PREFIX}/${PROJECT}/hosts/${HOST_A}/aws`]: AWS_SCOPE,
    };
}

/** Runner fake que devuelve JSON canned y registra cada invocación. */
function fakeRunner(respuestas) {
    const calls = [];
    return {
        calls,
        run(service, args) {
            calls.push({ service, args: args.slice() });
            const clave = `${service} ${args[0]}`;
            const r = respuestas[clave];
            if (typeof r === 'function') return r(args, calls.length);
            return r == null ? '{}' : r;
        },
    };
}

/** Respuesta SSM canned a partir de un mapa `path -> objeto`. */
function ssmParameters(mapa, extra = {}) {
    return JSON.stringify({
        Parameters: Object.entries(mapa).map(([Name, value]) => ({
            Name, Value: typeof value === 'string' ? value : JSON.stringify(value), Type: 'SecureString',
        })),
        ...extra,
    });
}

/** Logger fake: guarda TODO lo que se le pasa para poder buscar canarios. */
function fakeLogger() {
    const entradas = [];
    const push = (nivel) => (msg, meta) => entradas.push({ nivel, msg, meta });
    return { entradas, info: push('info'), warn: push('warn'), error: push('error') };
}

// =============================================================================
// 1 · D5 — resolución exitosa por scope declarado
// =============================================================================

test('1 · resuelve los scopes declarados y no hidrata nada más (D5)', async () => {
    const driver = createInMemoryVaultDriver({ parameters: seedHostA() });
    const vault = createSecretVault({ config: configVault(), driver });

    const res = await vault.resolveNamespace();

    assert.deepEqual(Object.keys(res.scopes).sort(), ['aws', 'telegram']);
    assert.deepEqual(res.scopes.telegram, TELEGRAM);
    assert.deepEqual(res.tiers, { telegram: 'shared', aws: 'host' });

    // No existe un camino que hidrate de una las 13 vars de ENV_MAPPING (G-5):
    // pedir un scope no declarado es un error, no una resolución silenciosa.
    await assert.rejects(
        () => vault.resolveScope({ scopes: ['google_drive'] }),
        (e) => e.code === VAULT_ERROR_CODES.CONFIG_INVALID && /required_scopes/.test(e.message),
    );

    // CA-6 — el módulo resuelve scopes, no variables una por una. El conteo se
    // deriva: desde #5217 `ENV_MAPPING` (lo que se hidrata) es un subconjunto de
    // `ENV_DESCRIPTORS` (el inventario), así que hardcodear un número acá haría
    // fallar este test cada vez que se agrega o se desengancha un secreto.
    const { ENV_MAPPING, ENV_DESCRIPTORS, seHidrata } = require('../credentials');
    const hidratables = Object.values(ENV_DESCRIPTORS).filter(seHidrata).length;
    assert.equal(Object.keys(ENV_MAPPING).length, hidratables);
    assert.ok(hidratables < Object.keys(ENV_DESCRIPTORS).length,
        'el inventario es mayor que lo hidratado: Drive se resuelve bajo demanda');
});

// =============================================================================
// 2 · fail-closed — secreto ausente lanza VaultSecretMissingError (CA-21/CA-32)
// =============================================================================

test('2 · secreto ausente lanza VaultSecretMissingError nombrando el scope y el tier', async () => {
    const parcial = seedHostA();
    delete parcial[`${PREFIX}/${PROJECT}/hosts/${HOST_A}/aws`];
    const vault = createSecretVault({
        config: configVault(),
        driver: createInMemoryVaultDriver({ parameters: parcial }),
    });

    await assert.rejects(() => vault.resolveNamespace(), (e) => {
        assert.ok(e instanceof VaultSecretMissingError);
        assert.equal(e.name, 'VaultSecretMissingError');
        assert.equal(e.code, VAULT_ERROR_CODES.SECRET_MISSING);
        assert.equal(e.scope, 'aws');
        assert.equal(e.tier, 'host');
        // Nombra el scope y la remediación, nunca un valor.
        assert.match(e.message, /scope="aws"/);
        assert.match(e.message, /tier="host"/);
        assert.match(e.message, /subir el parámetro al vault/);
        // CA-32 — `redactAwsEvidence` enmascara el account id, NO la jerarquía:
        // la ruta lógica se muestra a propósito (es topología, no secreto).
        assert.match(e.message, /\/intrale\/intrale\/hosts\/hostA\/aws/);
        assert.ok(!e.message.includes('CANARIO'), 'ningún valor de secreto en el mensaje');
        return true;
    });
});

test('2b · nunca devuelve cadena vacía ni default ante un scope faltante', async () => {
    const vault = createSecretVault({
        config: configVault({ required_scopes: ['telegram'], shared_secrets: ['telegram'] }),
        driver: createInMemoryVaultDriver({ parameters: {} }),
    });
    let resultado = 'no-se-resolvio';
    try {
        resultado = await vault.resolveScope({ scopes: ['telegram'] });
    } catch (e) {
        assert.ok(e instanceof VaultSecretMissingError);
    }
    assert.equal(resultado, 'no-se-resolvio', 'no debe devolver "" ni {}');
});

// =============================================================================
// 3 · CA-3 del madre / SEC-3 — acceso cruzado entre namespaces denegado
// =============================================================================

test('3 · el host B no puede leer el namespace del host A (aislamiento SEC-3)', async () => {
    const driver = createInMemoryVaultDriver({ parameters: seedHostA() });
    const vaultB = createSecretVault({ config: configVault({ hostId: HOST_B }), driver });

    await assert.rejects(() => vaultB.resolveNamespace(), (e) => {
        assert.ok(e instanceof VaultSecretMissingError);
        assert.equal(e.scope, 'aws');
        return true;
    });

    // El barrido del host B nunca tocó la raíz del host A ni la del proyecto.
    const roots = driver.calls.map((c) => c.root);
    assert.ok(roots.includes(`${PREFIX}/${PROJECT}/hosts/${HOST_B}/`));
    assert.ok(!roots.some((r) => r.includes(HOST_A)), 'no barrió el namespace ajeno');
    assert.ok(!roots.includes(`${PREFIX}/${PROJECT}/`), 'nunca la raíz a nivel proyecto');

    // Y la raíz a nivel proyecto es INCONSTRUIBLE (CA-7).
    assert.throws(
        () => buildParameterPath({ prefix: PREFIX, projectId: PROJECT, tier: 'rotating', root: true }),
        /recursivo/,
    );
    assert.throws(
        () => buildParameterPath({ prefix: PREFIX, projectId: PROJECT, scope: '', tier: 'shared' }),
        /vault\.scope/,
    );
});

test('3b · resolveNamespace emite A LO SUMO DOS llamadas batch (SEC-3)', async () => {
    const driver = createInMemoryVaultDriver({ parameters: seedHostA() });
    const vault = createSecretVault({ config: configVault(), driver });
    await vault.resolveNamespace();
    const barridos = driver.calls.filter((c) => c.op === 'getParametersByPath');
    assert.equal(barridos.length, 2, 'una raíz shared + una raíz host, nunca una por variable');
    assert.deepEqual(barridos.map((c) => c.root).sort(), [
        `${PREFIX}/${PROJECT}/hosts/${HOST_A}/`,
        `${PREFIX}/${PROJECT}/shared/`,
    ]);
});

// =============================================================================
// 4 · allowlist — `ssm put-parameter` rechazado ANTES de spawnear
// =============================================================================

test('4 · la allowlist rechaza `ssm put-parameter` antes de spawnear', () => {
    let spawns = 0;
    const runner = createAwsCliVaultRunner(
        { AWS_ACCESS_KEY_ID: 'k', AWS_SECRET_ACCESS_KEY: 's' },
        'us-east-2',
        { execFileSync: () => { spawns += 1; return '{}'; } },
    );

    assert.throws(() => runner.run('ssm', ['put-parameter', '--name', 'x']), (e) => {
        assert.equal(e.code, VAULT_ERROR_CODES.CONFIG_INVALID);
        assert.match(e.message, /allowlist read-only/);
        return true;
    });
    assert.throws(() => runner.run('ssm', ['delete-parameter']), /allowlist read-only/);
    assert.throws(() => runner.run('iam', ['list-users']), /allowlist read-only/);
    assert.equal(spawns, 0, 'no se spawneó ni un proceso hijo');

    // La allowlist está congelada y es exactamente la declarada.
    assert.ok(Object.isFrozen(VAULT_READONLY_COMMANDS));
    assert.deepEqual([...VAULT_READONLY_COMMANDS], [
        'ssm get-parameters-by-path', 'ssm get-parameter', 'secretsmanager get-secret-value',
    ]);
    assert.ok(!VAULT_READONLY_COMMANDS.includes('ssm put-parameter'));
});

// =============================================================================
// 5 · A03 — spawn sin shell, args como array, timeout y maxBuffer explícitos
// =============================================================================

test('5 · el spawn va sin shell, con args como array, timeout y maxBuffer explícitos', () => {
    let visto = null;
    const runner = createAwsCliVaultRunner(
        { AWS_ACCESS_KEY_ID: 'k', AWS_SECRET_ACCESS_KEY: 's' },
        'us-east-2',
        { execFileSync: (bin, args, opts) => { visto = { bin, args, opts }; return '{}'; } },
    );
    runner.run('ssm', ['get-parameters-by-path', '--path', '/intrale/intrale/shared/', '--recursive']);

    assert.equal(visto.bin, 'aws');
    assert.ok(Array.isArray(visto.args), 'args como array, jamás un shell string');
    assert.equal(visto.args[0], 'ssm');
    assert.equal(visto.opts.shell, false);
    assert.equal(typeof visto.opts.timeout, 'number');
    assert.ok(visto.opts.timeout > 0 && visto.opts.timeout <= 5000);
    assert.equal(typeof visto.opts.maxBuffer, 'number');
    assert.equal(visto.opts.windowsHide, true);
    // SEC-5 — flags fijados explícitamente.
    assert.ok(visto.args.includes('--region') && visto.args.includes('us-east-2'));
    assert.ok(visto.args.includes('--output') && visto.args.includes('json'));
    assert.ok(visto.args.includes('--no-cli-pager'));
});

// =============================================================================
// 6 · D8 + SEC-5 — segmentos y prefix inválidos rechazados ANTES de concatenar
// =============================================================================

test('6 · segmentos y prefix inválidos se rechazan antes de construir el path', () => {
    const base = { prefix: PREFIX, projectId: PROJECT, hostId: HOST_A, tier: 'shared' };

    for (const scope of ['../otro', 'a/b', '', 'host.local', null, undefined, 'con espacio']) {
        assert.throws(() => buildParameterPath({ ...base, scope }), /vault\.scope/,
            `scope inválido no rechazado: ${JSON.stringify(scope)}`);
    }
    for (const prefix of ['intrale', '/intrale/', '/', '', '/intra le', null, '/intrale/../etc']) {
        assert.throws(() => buildParameterPath({ ...base, prefix, scope: 'telegram' }), /vault\.prefix/,
            `prefix inválido no rechazado: ${JSON.stringify(prefix)}`);
    }
    for (const hostId of ['', 'host.local', '../otro', null]) {
        assert.throws(
            () => buildParameterPath({ ...base, tier: 'host', hostId, scope: 'telegram' }),
            /vault\.hostId/,
        );
    }
    assert.throws(() => buildParameterPath({ ...base, projectId: 'pro/yecto', scope: 'x' }),
        /vault\.projectId/);

    // SEC-5 en el runner: `file://` y flags desconocidos se rechazan sin spawnear.
    let spawns = 0;
    const runner = createAwsCliVaultRunner(
        { AWS_ACCESS_KEY_ID: 'k', AWS_SECRET_ACCESS_KEY: 's' },
        'us-east-2',
        { execFileSync: () => { spawns += 1; return '{}'; } },
    );
    assert.throws(() => runner.run('ssm', ['get-parameter', '--secret-id', 'file:///etc/passwd']),
        /file:\/\//);
    assert.throws(() => runner.run('ssm', ['get-parameter', '--profile', 'admin']),
        /no es un flag conocido/);
    assert.equal(spawns, 0);
});

// =============================================================================
// 7 · SEC-6 — caché: TTL, aislamiento por namespace, invalidación, tope duro
// =============================================================================

test('7 · la caché respeta el TTL, no cruza namespaces y tiene tope duro de 300 s', async () => {
    let ahora = 1_000_000;
    const driver = createInMemoryVaultDriver({ parameters: seedHostA() });
    const vault = createSecretVault({ config: configVault(), driver, now: () => ahora });

    await vault.resolveNamespace();
    const tras1 = driver.calls.length;
    await vault.resolveNamespace();
    assert.equal(driver.calls.length, tras1, '2 lecturas dentro del TTL ⇒ 1 sola invocación');

    // Pasado el TTL la entrada se BORRA y se vuelve a leer.
    ahora += 301 * 1000;
    await vault.resolveNamespace();
    assert.ok(driver.calls.length > tras1, 'expirado el TTL vuelve a leer');

    // Un hit NO cruza namespaces: otro vault con otro hostId no reusa nada.
    const driverB = createInMemoryVaultDriver({ parameters: seedHostA() });
    const vaultB = createSecretVault({ config: configVault({ hostId: HOST_B }), driver: driverB });
    await assert.rejects(() => vaultB.resolveNamespace(), VaultSecretMissingError);

    // clearCache fuerza relectura.
    const antes = driver.calls.length;
    vault.clearCache();
    await vault.resolveNamespace();
    assert.ok(driver.calls.length > antes, 'clearCache invalida');

    // Tope duro: un TTL > 300 s se RECHAZA (no se recorta en silencio).
    assert.equal(MAX_CACHE_TTL_SECONDS, 300);
    assert.throws(
        () => createSecretVault({ config: configVault({ cache_ttl_seconds: 301 }), driver }),
        (e) => {
            assert.equal(e.code, VAULT_ERROR_CODES.CONFIG_INVALID);
            assert.match(e.message, /vault\.cache_ttl_seconds/);
            assert.match(e.message, /tope duro de 300/);
            return true;
        },
    );
});

test('7b · sin negative caching: un miss no se cachea', async () => {
    const driver = createInMemoryVaultDriver({ parameters: {} });
    const vault = createSecretVault({
        config: configVault({ required_scopes: ['telegram'], shared_secrets: ['telegram'] }),
        driver,
    });
    await assert.rejects(() => vault.resolveNamespace(), VaultSecretMissingError);
    const tras1 = driver.calls.length;
    await assert.rejects(() => vault.resolveNamespace(), VaultSecretMissingError);
    assert.ok(driver.calls.length > tras1, 'el miss NO quedó cacheado: se reintentó de verdad');
});

// =============================================================================
// 8 · SEC-6(d) + CA-20/CA-30 — util.inspect no filtra valores y SÍ observa
// =============================================================================

test('8 · util.inspect del vault muestra la forma positiva y ningún valor', async () => {
    const logger = fakeLogger();
    const vault = createSecretVault({
        config: configVault(),
        driver: createInMemoryVaultDriver({ parameters: seedHostA() }),
        logger,
    });
    await vault.resolveNamespace();

    const salida = util.inspect(vault, { depth: null });

    // Negativo (CA-20): ni un valor de secreto, ni el Map de la caché.
    assert.ok(!salida.includes('CANARIO'), 'ningún valor de secreto en el inspect');
    assert.ok(!/Map\(/.test(salida), 'el Map de la caché no se serializa');
    assert.ok(!salida.includes('bot_token'), 'ni siquiera las claves internas del scope');

    // Positivo (CA-30): la forma exacta que el operador necesita para diagnosticar.
    assert.match(salida, /^SecretVault \{/);
    assert.match(salida, /enabled: true/);
    assert.match(salida, /scopes: \[ 'telegram', 'aws' \]/);
    assert.match(salida, /cached: 1/);
    assert.match(salida, /ttl_s: 300/);
    assert.ok(salida !== '[SecretVault]' && salida !== 'SecretVault {}', 'no puede ser opaco');

    // El Map no es propiedad enumerable ni exportada del objeto.
    assert.deepEqual(Object.keys(vault).sort(), ['clearCache', 'resolveNamespace', 'resolveScope']);
    for (const v of Object.values(vault)) assert.ok(!(v instanceof Map));

    // CA-23 — al logger van SÓLO nombres de scope.
    const logSerializado = JSON.stringify(logger.entradas);
    assert.ok(logger.entradas.length > 0, 'el vault sí loguea (observabilidad)');
    assert.ok(logSerializado.includes('telegram'), 'los NOMBRES de scope sí');
    assert.ok(!logSerializado.includes('CANARIO'), 'los VALORES nunca');
});

// =============================================================================
// 9 · SEC-1 + CA-31 — el canario del stdout no sobrevive al camino de error
// =============================================================================

test('9 · el stdout de la CLI nunca sobrevive al error (SEC-1) y el stderr accionable sí (CA-31)', () => {
    const CANARIO = 'SUPERSECRETO-CANARIO';
    const logger = fakeLogger();

    // (a) exit ≠ 0 con stdout parcial ya descifrado.
    const runnerExit = createAwsCliVaultRunner(
        { AWS_ACCESS_KEY_ID: 'k', AWS_SECRET_ACCESS_KEY: 's' },
        'us-east-2',
        {
            execFileSync: () => {
                const err = new Error(`Command failed: aws ssm get-parameter ${CANARIO}`);
                err.status = 255;
                err.stdout = CANARIO;
                err.output = [null, CANARIO, 'User: arn:aws:iam::123456789012:user/qa is not '
                    + 'authorized to perform: ssm:GetParameter'];
                err.stderr = 'User: arn:aws:iam::123456789012:user/qa is not authorized to '
                    + 'perform: ssm:GetParameter on resource: '
                    + 'arn:aws:ssm:us-east-2:123456789012:parameter/intrale/intrale/shared/telegram';
                throw err;
            },
        },
    );

    let capturado = null;
    try {
        runnerExit.run('ssm', ['get-parameter', '--secret-id', 'x']);
    } catch (e) {
        capturado = e;
        logger.error('vault: fallo', { error: e.name, code: e.code });
    }

    assert.ok(capturado instanceof VaultCliError);
    assert.equal(capturado.code, VAULT_ERROR_CODES.CLI);
    // SEC-1 — el canario no aparece por NINGUNA de las tres vías conocidas.
    const inspeccionado = util.inspect(capturado, { depth: null });
    assert.ok(!inspeccionado.includes(CANARIO), 'canario en util.inspect(err, {depth:null})');
    assert.ok(!String(capturado.stack).includes(CANARIO), 'canario en err.stack');
    assert.ok(!JSON.stringify(logger.entradas).includes(CANARIO), 'canario en el logger');
    assert.equal(capturado.stdout, undefined);
    assert.equal(capturado.output, undefined);

    // CA-31 — lo accionable SÍ se preserva: el verbo denegado (desambigua
    // `ssm:GetParameter` de `kms:Decrypt`) y el account id enmascarado.
    assert.match(capturado.message, /ssm:GetParameter/);
    assert.match(capturado.message, /<ACCT>/);
    assert.ok(!capturado.message.includes('123456789012'), 'account id en claro');
    assert.match(capturado.message, /Remediación/);

    // (b) kill por timeout — también deja stdout parcial adjunto.
    const runnerTimeout = createAwsCliVaultRunner(
        { AWS_ACCESS_KEY_ID: 'k', AWS_SECRET_ACCESS_KEY: 's' },
        'us-east-2',
        {
            execFileSync: () => {
                const err = new Error('Command failed: aws ssm get-parameters-by-path');
                err.killed = true;
                err.status = null;
                err.signal = 'SIGTERM';
                err.stdout = CANARIO;
                err.stderr = '';
                throw err;
            },
        },
    );
    let porTimeout = null;
    try {
        runnerTimeout.run('ssm', ['get-parameters-by-path', '--path', '/intrale/intrale/shared/']);
    } catch (e) { porTimeout = e; }

    assert.ok(porTimeout instanceof VaultCliError);
    assert.ok(!util.inspect(porTimeout, { depth: null }).includes(CANARIO));
    assert.ok(!String(porTimeout.stack).includes(CANARIO));
    assert.match(porTimeout.message, /timeout/);

    // (c) CA-31 — la remediación textual del stderr se preserva tal cual.
    const runnerSesion = createAwsCliVaultRunner(
        { AWS_ACCESS_KEY_ID: 'k', AWS_SECRET_ACCESS_KEY: 's' },
        'us-east-2',
        {
            execFileSync: () => {
                const err = new Error('Command failed');
                err.status = 253;
                err.stdout = CANARIO;
                err.stderr = 'Your session has expired. Please reauthenticate using: aws login';
                throw err;
            },
        },
    );
    assert.throws(() => runnerSesion.run('ssm', ['get-parameter', '--secret-id', 'x']), (e) => {
        assert.match(e.message, /Your session has expired/);
        assert.match(e.message, /aws login/);
        assert.ok(!e.message.includes(CANARIO));
        return true;
    });
});

// =============================================================================
// 10 · SEC-2 — el env del spawn se arma por allowlist
// =============================================================================

test('10 · el env del spawn se arma por allowlist: AWS_ENDPOINT_URL/AWS_CONFIG_FILE no llegan al hijo', () => {
    let envVisto = null;
    const entrada = {
        AWS_ACCESS_KEY_ID: 'AKIA-TEST',
        AWS_SECRET_ACCESS_KEY: 'SECRET-TEST',
        AWS_SESSION_TOKEN: 'TOKEN-TEST',
        AWS_ENDPOINT_URL: 'http://attacker.local:9999',
        AWS_CONFIG_FILE: 'C:/tmp/evil-config',
        AWS_SHARED_CREDENTIALS_FILE: 'C:/tmp/evil-creds',
        PATH: '/evil/bin',
        TELEGRAM_BOT_TOKEN: 'CANARIO-TELEGRAM',
    };
    const runner = createAwsCliVaultRunner(entrada, 'us-east-2', {
        execFileSync: (bin, args, opts) => { envVisto = opts.env; return '{}'; },
    });
    runner.run('ssm', ['get-parameters-by-path', '--path', '/intrale/intrale/shared/', '--recursive']);

    assert.equal(envVisto.AWS_ENDPOINT_URL, undefined, 'endpoint redirigible NO llega al hijo');
    assert.equal(envVisto.AWS_CONFIG_FILE, undefined);
    assert.equal(envVisto.AWS_SHARED_CREDENTIALS_FILE, undefined);
    assert.equal(envVisto.TELEGRAM_BOT_TOKEN, undefined, 'ningún secreto de otro scope');
    assert.equal(envVisto.AWS_ACCESS_KEY_ID, 'AKIA-TEST');
    assert.equal(envVisto.AWS_REGION, 'us-east-2');
    // El env es una allowlist chica, no un merge de todo el ambiente.
    for (const k of Object.keys(envVisto)) assert.match(k, /^AWS_/);

    // Fail-closed: sin credenciales no se spawnea.
    assert.throws(
        () => createAwsCliVaultRunner({ AWS_REGION: 'us-east-2' }, 'us-east-2', {
            execFileSync: () => { throw new Error('no debería spawnear'); },
        }),
        /credenciales AWS/,
    );
});

test('10b · los greps del pre-checklist dan sin hits sobre el propio módulo (CA-8/10/14)', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const fuente = fs.readFileSync(path.join(__dirname, '..', 'secret-vault.js'), 'utf8');

    // CA-8 — ni siquiera se nombra el ambiente global: no hay dónde asignarle.
    assert.ok(!/process\s*\.\s*env/.test(fuente), 'CA-8: el módulo no debe tocar el ambiente global');
    // CA-10 — nunca se habilita el shell.
    assert.ok(!/shell\s*:\s*true/.test(fuente), 'CA-10: prohibido habilitar el shell');
    // CA-14 — los flags de paginación acotada no aparecen NI como literal: la
    // allowlist de flags ya los rechaza, así que una denylist sería redundante.
    assert.ok(!/-{2}no-paginate/.test(fuente), 'CA-14: sin flag de paginación desactivada');
    assert.ok(!/-{2}max-items/.test(fuente), 'CA-14: sin flag de items acotados');

    // Y se comprueba por COMPORTAMIENTO, no sólo por grep: el runner los rechaza.
    let spawns = 0;
    const runner = createAwsCliVaultRunner(
        { AWS_ACCESS_KEY_ID: 'k', AWS_SECRET_ACCESS_KEY: 's' },
        'us-east-2',
        { execFileSync: () => { spawns += 1; return '{}'; } },
    );
    for (const flag of ['--no-paginate', '--max-items', '--query', '--debug', '--endpoint-url']) {
        assert.throws(
            () => runner.run('ssm', ['get-parameters-by-path', '--path', '/intrale/intrale/shared/', flag]),
            /no es un flag conocido/,
            `flag no rechazado: ${flag}`,
        );
    }
    assert.equal(spawns, 0, 'ninguno llegó a spawnear');
});

// =============================================================================
// 11 · SEC-4 — NextToken: se consume o se lanza error, jamás parcial silencioso
// =============================================================================

test('11 · el driver aws-cli consume NextToken hasta agotarlo y nunca devuelve parcial', async () => {
    const pagina1 = ssmParameters(
        { [`${PREFIX}/${PROJECT}/shared/telegram`]: TELEGRAM },
        { NextToken: 'tok-2' },
    );
    const pagina2 = ssmParameters({ [`${PREFIX}/${PROJECT}/shared/providers`]: { p: 1 } });

    const runner = fakeRunner({
        'ssm get-parameters-by-path': (args, n) => {
            if (n === 1) {
                assert.ok(!args.includes('--starting-token'), 'la 1ra página no lleva token');
                return pagina1;
            }
            assert.ok(args.includes('--starting-token'), 'la 2da página sigue el NextToken');
            assert.equal(args[args.indexOf('--starting-token') + 1], 'tok-2');
            return pagina2;
        },
    });
    const driver = createAwsCliVaultDriver({ run: runner.run });
    const res = await driver.getParametersByPath(`${PREFIX}/${PROJECT}/shared/`);

    assert.equal(runner.calls.length, 2, 'consumió las dos páginas');
    assert.deepEqual(res.parameters.map((p) => p.name).sort(), [
        `${PREFIX}/${PROJECT}/shared/providers`,
        `${PREFIX}/${PROJECT}/shared/telegram`,
    ]);

    // Prohibidos por contrato (SEC-4).
    for (const call of runner.calls) {
        assert.ok(!call.args.includes('--no-paginate'));
        assert.ok(!call.args.includes('--max-items'));
    }

    // Un driver que devuelve un token SIN consumir ⇒ error de truncación, jamás
    // «secreto ausente»: son remediaciones opuestas.
    const parcial = {
        kind: 'parcial',
        calls: [],
        async getParametersByPath(root) {
            return { parameters: [], nextToken: 'tok-9' };
        },
        async getSecretValue() { return null; },
    };
    const vault = createSecretVault({
        config: configVault({ required_scopes: ['telegram'], shared_secrets: ['telegram'] }),
        driver: parcial,
    });
    await assert.rejects(() => vault.resolveNamespace(), (e) => {
        assert.ok(e instanceof VaultTruncatedResponseError);
        assert.equal(e.code, VAULT_ERROR_CODES.TRUNCATED_RESPONSE);
        assert.ok(!(e instanceof VaultSecretMissingError));
        assert.match(e.message, /NO subir parámetros/);
        return true;
    });

    // maxBuffer desbordado ⇒ truncación, no «CLI rota» ni «secreto ausente».
    const runnerENOBUFS = createAwsCliVaultRunner(
        { AWS_ACCESS_KEY_ID: 'k', AWS_SECRET_ACCESS_KEY: 's' },
        'us-east-2',
        {
            execFileSync: () => {
                const err = new Error('spawnSync aws ENOBUFS');
                err.code = 'ENOBUFS';
                err.stdout = 'SUPERSECRETO-CANARIO';
                throw err;
            },
        },
    );
    assert.throws(
        () => runnerENOBUFS.run('ssm', ['get-parameters-by-path', '--path', '/intrale/intrale/shared/']),
        (e) => {
            assert.ok(e instanceof VaultTruncatedResponseError);
            assert.ok(!util.inspect(e, { depth: null }).includes('SUPERSECRETO-CANARIO'));
            return true;
        },
    );
});

// =============================================================================
// 12 · SEC-6(a) — la familia de errores de auth invalida la caché
// =============================================================================

// Driver conmutable: sirve el namespace del host A y, en modo `auth`, falla con
// el stderr que se le pida. Permite ejercer la invalidación con una secuencia
// REAL: el error de auth tiene que ocurrir en una lectura que efectivamente
// llegue al driver (una servida de la caché nunca fallaría).
function driverConmutable(stderrAuth) {
    const estado = { modo: 'ok', calls: [] };
    return {
        estado,
        kind: 'conmutable',
        async getParametersByPath(root) {
            estado.calls.push({ root });
            if (estado.modo === 'auth') {
                throw new VaultCliError({
                    service: 'ssm', verb: 'get-parameters-by-path', exitCode: 255,
                    stderr: stderrAuth, scopes: ['telegram'],
                });
            }
            const params = [];
            for (const [name, value] of Object.entries(seedHostA())) {
                if (name.startsWith(root)) params.push({ name, value: JSON.stringify(value) });
            }
            return { parameters: params };
        },
        async getSecretValue() { return null; },
    };
}

test('12 · ExpiredToken y "session has expired" invalidan la caché igual que AccessDenied', async () => {
    for (const stderr of [
        'An error occurred (AccessDeniedException) when calling GetParametersByPath',
        'An error occurred (ExpiredTokenException): The security token included in the request is expired',
        'Your session has expired. Please reauthenticate using: aws login',
        'An error occurred (UnrecognizedClientException): The security token included is invalid',
        'An error occurred (InvalidClientTokenId): The security token included is invalid',
    ]) {
        const driver = driverConmutable(stderr);
        const vault = createSecretVault({ config: configVault(), driver });

        // 1) `telegram` queda cacheado (1 barrido: sólo la raíz shared).
        await vault.resolveScope({ scopes: ['telegram'] });
        const trasPrimera = driver.estado.calls.length;
        await vault.resolveScope({ scopes: ['telegram'] });
        assert.equal(driver.estado.calls.length, trasPrimera, 'la 2da lectura sale de la caché');

        // 2) Se pide un scope que la caché NO tiene (`aws`): esa lectura sí
        //    llega al driver y ahí caduca la sesión.
        driver.estado.modo = 'auth';
        await assert.rejects(() => vault.resolveScope({ scopes: ['telegram', 'aws'] }), VaultCliError);

        // 3) La credencial muerta invalidó el namespace ENTERO: `telegram`, que
        //    estaba cacheado y válido, se vuelve a leer. Si no se invalidara, el
        //    vault seguiría sirviendo de una caché cuya sesión ya no existe.
        driver.estado.modo = 'ok';
        const antes = driver.estado.calls.length;
        await vault.resolveScope({ scopes: ['telegram'] });
        assert.ok(driver.estado.calls.length > antes, `no invalidó con: ${stderr}`);
    }
});

test('12c · un error que NO es de auth deja la caché intacta', async () => {
    // El matcher es de FAMILIA de auth, no un "borrá ante cualquier error":
    // tirar la caché por un throttling transitorio multiplicaría las llamadas
    // justo cuando AWS está pidiendo que bajen.
    const driver = driverConmutable('An error occurred (ThrottlingException): Rate exceeded');
    const vault = createSecretVault({ config: configVault(), driver });

    await vault.resolveScope({ scopes: ['telegram'] });
    driver.estado.modo = 'auth';   // el "auth" de este driver es un throttling
    await assert.rejects(() => vault.resolveScope({ scopes: ['telegram', 'aws'] }), VaultCliError);

    driver.estado.modo = 'ok';
    const antes = driver.estado.calls.length;
    await vault.resolveScope({ scopes: ['telegram'] });
    assert.equal(driver.estado.calls.length, antes, 'el hit de `telegram` sobrevivió');
});

test('12b · CA-22 — un error de auth se propaga, jamás se degrada a vacío ni a "ausente"', async () => {
    const driver = {
        kind: 'denegado',
        async getParametersByPath() {
            throw new VaultCliError({
                service: 'ssm', verb: 'get-parameters-by-path', exitCode: 255,
                stderr: 'An error occurred (AccessDeniedException)', scopes: ['telegram'],
            });
        },
        async getSecretValue() { return null; },
    };
    const vault = createSecretVault({
        config: configVault({ required_scopes: ['telegram'], shared_secrets: ['telegram'] }),
        driver,
    });
    await assert.rejects(() => vault.resolveScope({ scopes: ['telegram'] }), (e) => {
        assert.ok(e instanceof VaultCliError);
        assert.ok(!(e instanceof VaultSecretMissingError), 'no se disfraza de "secreto ausente"');
        return true;
    });
});

// =============================================================================
// 13 · G-2 — PARIDAD DE DRIVERS (obligatorio: sin esto, cobertura ilusoria)
// =============================================================================

test('13 · in-memory y aws-cli devuelven la MISMA estructura para el mismo caso', async () => {
    const config = configVault();

    const enMemoria = createInMemoryVaultDriver({ parameters: seedHostA() });

    const runner = fakeRunner({
        'ssm get-parameters-by-path': (args) => {
            const root = args[args.indexOf('--path') + 1];
            const mapa = {};
            for (const [name, value] of Object.entries(seedHostA())) {
                if (name.startsWith(root)) mapa[name] = value;
            }
            return ssmParameters(mapa);
        },
    });
    const porCli = createAwsCliVaultDriver({ run: runner.run });

    const a = await createSecretVault({ config, driver: enMemoria }).resolveNamespace();
    const b = await createSecretVault({ config, driver: porCli }).resolveNamespace();

    assert.deepEqual(a, b, 'los dos drivers deben devolver exactamente lo mismo');
    assert.deepEqual(b.scopes.telegram, TELEGRAM);
    assert.equal(typeof b.scopes.aws, 'object', 'YA PARSEADO, no un string JSON');

    // Y también a nivel driver: `value` es SIEMPRE string con JSON serializado.
    const rawMem = await enMemoria.getParametersByPath(`${PREFIX}/${PROJECT}/shared/`);
    const rawCli = await porCli.getParametersByPath(`${PREFIX}/${PROJECT}/shared/`);
    assert.deepEqual(rawMem, rawCli);
    for (const p of rawMem.parameters) assert.equal(typeof p.value, 'string');

    // JSON inválido ⇒ ERROR, nunca scope vacío — en AMBOS drivers.
    const rotoMem = createInMemoryVaultDriver({
        parameters: { [`${PREFIX}/${PROJECT}/shared/telegram`]: '{no-es-json' },
    });
    const runnerRoto = fakeRunner({
        'ssm get-parameters-by-path': () => ssmParameters({
            [`${PREFIX}/${PROJECT}/shared/telegram`]: '{no-es-json',
        }),
    });
    const cfgSolo = configVault({ required_scopes: ['telegram'], shared_secrets: ['telegram'] });
    for (const driver of [rotoMem, createAwsCliVaultDriver({ run: runnerRoto.run })]) {
        const vault = createSecretVault({ config: cfgSolo, driver });
        await assert.rejects(() => vault.resolveScope({ scopes: ['telegram'] }), (e) => {
            assert.ok(e instanceof VaultCliError, 'JSON inválido debe ser error tipado');
            assert.match(e.message, /no es JSON válido/);
            assert.ok(!e.message.includes('no-es-json'), 'el valor crudo no sale del módulo');
            return true;
        });
    }
});

// =============================================================================
// 14 · G-3 — tier explícito y convención de barra inicial
// =============================================================================

test('14 · el tier es explícito: rotating sin barra inicial, shared/host con barra', () => {
    const base = { prefix: PREFIX, projectId: PROJECT, hostId: HOST_A, scope: 'telegram' };

    const compartido = buildParameterPath({ ...base, tier: 'shared' });
    const porHost = buildParameterPath({ ...base, tier: 'host' });
    const rotativo = buildParameterPath({ ...base, tier: 'rotating' });

    assert.equal(compartido, '/intrale/intrale/shared/telegram');
    assert.equal(porHost, '/intrale/intrale/hosts/hostA/telegram');
    assert.equal(rotativo, 'intrale/intrale/rotating/telegram');
    assert.ok(compartido.startsWith('/'), 'SSM: CON barra inicial');
    assert.ok(porHost.startsWith('/'), 'SSM: CON barra inicial');
    assert.ok(!rotativo.startsWith('/'), 'Secrets Manager: SIN barra inicial');

    // Tier desconocido / ausente ⇒ error. NUNCA se infiere de la presencia de hostId.
    for (const tier of [undefined, null, '', 'shared-host', 'SHARED', 'rotante', 42]) {
        assert.throws(() => buildParameterPath({ ...base, tier }), /vault\.tier/,
            `tier inválido no rechazado: ${JSON.stringify(tier)}`);
    }
    // Con hostId presente pero tier `shared`, el path NO incluye el host: la
    // presencia de hostId no decide nada.
    assert.ok(!buildParameterPath({ ...base, tier: 'shared' }).includes(HOST_A));
});

// =============================================================================
// 15 · D4 — con el gate cerrado, CERO llamadas
// =============================================================================

test('15 · con vault.enabled:false no se invoca el driver ni una sola vez', async () => {
    const driver = createInMemoryVaultDriver({ parameters: seedHostA() });
    const espia = {
        kind: 'espia',
        calls: [],
        async getParametersByPath(...a) { this.calls.push(a); return driver.getParametersByPath(...a); },
        async getSecretValue(...a) { this.calls.push(a); return driver.getSecretValue(...a); },
    };
    const vault = createSecretVault({ config: configVault({ enabled: false }), driver: espia });

    const ns = await vault.resolveNamespace();
    const sc = await vault.resolveScope({ scopes: ['telegram'] });
    vault.clearCache();

    assert.equal(espia.calls.length, 0, 'ni una llamada con el gate cerrado');
    assert.equal(driver.calls.length, 0);
    assert.equal(ns.enabled, false);
    assert.deepEqual(ns.scopes, {});
    assert.deepEqual(sc, {});

    // Fail-closed del gate: sólo el booleano `true` exacto lo abre.
    for (const v of ['true', 1, {}, [], 'yes', null, undefined]) {
        const w = createSecretVault({ config: configVault({ enabled: v }), driver: espia });
        assert.equal((await w.resolveNamespace()).enabled, false, `gate abierto por ${util.inspect(v)}`);
    }
    assert.equal(espia.calls.length, 0);
});

// =============================================================================
// 16 · D9 — Secrets Manager con --version-stage AWSCURRENT y sin --version-id
// =============================================================================

test('16 · Secrets Manager se lee con --version-stage AWSCURRENT y sin --version-id', async () => {
    const runner = fakeRunner({
        'secretsmanager get-secret-value': () => JSON.stringify({
            Name: 'intrale/intrale/rotating/providers',
            SecretString: JSON.stringify({ anthropic: 'CANARIO-KEY' }),
        }),
    });
    const driver = createAwsCliVaultDriver({ run: runner.run });
    const vault = createSecretVault({
        config: configVault({ required_scopes: ['providers'], shared_secrets: [] }),
        driver,
    });

    const res = await vault.resolveScope({ scopes: ['providers'], tier: 'rotating' });
    assert.deepEqual(res.providers, { anthropic: 'CANARIO-KEY' });

    assert.equal(runner.calls.length, 1);
    const { service, args } = runner.calls[0];
    assert.equal(service, 'secretsmanager');
    assert.equal(args[0], 'get-secret-value');
    assert.equal(args[args.indexOf('--secret-id') + 1], 'intrale/intrale/rotating/providers');
    assert.ok(args.includes('--version-stage'));
    assert.equal(args[args.indexOf('--version-stage') + 1], 'AWSCURRENT');
    assert.ok(!args.includes('--version-id'), 'fijar una versión congelaría la rotación');

    // Y el verbo está en la allowlist read-only.
    assert.ok(VAULT_READONLY_COMMANDS.includes('secretsmanager get-secret-value'));
});

// =============================================================================
// 17 · CA-29 — validación de config al ENCENDER el gate
// =============================================================================

test('17 · con el gate encendido, una config inválida falla nombrando la clave de config', () => {
    const driver = createInMemoryVaultDriver({ parameters: seedHostA() });

    // El valor que el snippet original commiteaba (`<host>`) NO valida.
    for (const [over, clave] of [
        [{ hostId: '' }, 'vault.hostId'],
        [{ hostId: '<host>' }, 'vault.hostId'],
        [{ hostId: 'host.local' }, 'vault.hostId'],
        [{ prefix: '' }, 'vault.prefix'],
        [{ prefix: 'intrale' }, 'vault.prefix'],
        [{ prefix: '/intrale/' }, 'vault.prefix'],
        [{ projectId: '' }, 'vault.projectId'],
        [{ cache_ttl_seconds: 0 }, 'vault.cache_ttl_seconds'],
        [{ cache_ttl_seconds: 3600 }, 'vault.cache_ttl_seconds'],
        [{ required_scopes: 'telegram' }, 'vault.required_scopes'],
        [{ shared_secrets: ['no-declarado'] }, 'vault.shared_secrets'],
    ]) {
        assert.throws(
            () => createSecretVault({ config: configVault(over), driver }),
            (e) => {
                assert.equal(e.name, 'VaultConfigError');
                assert.equal(e.code, VAULT_ERROR_CODES.CONFIG_INVALID);
                assert.ok(e.message.includes(`\`${clave}\``),
                    `el mensaje debe nombrar ${clave}: ${e.message}`);
                assert.ok(!/\^\[A-Za-z0-9/.test(e.message),
                    'el mensaje NO puede ser el regex crudo: no es accionable');
                assert.match(e.message, /\.pipeline\/config\.yaml/);
                return true;
            },
            `config inválida no rechazada: ${util.inspect(over)}`,
        );
    }

    // Con el gate CERRADO no se valida nada y no se emite ninguna llamada
    // (coherente con CA-25): el `hostId: ""` que se commitea no voltea el boot.
    const cerrado = createSecretVault({
        config: configVault({ enabled: false, hostId: '', prefix: '', cache_ttl_seconds: 99999 }),
        driver,
    });
    assert.equal(typeof cerrado.resolveNamespace, 'function');
    assert.equal(driver.calls.length, 0);
});

// =============================================================================
// CA-24 / CA-29 — la sección `vault:` commiteada es la que el módulo espera
// =============================================================================

test('CA-24 · config.yaml trae la sección vault: con el gate cerrado y hostId vacío', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const yaml = require('js-yaml');
    const cfg = yaml.load(
        fs.readFileSync(path.join(__dirname, '..', '..', 'config.yaml'), 'utf8'),
    );

    assert.ok(cfg.vault, 'la sección `vault:` debe existir en config.yaml');
    assert.equal(cfg.vault.enabled, false, 'el gate se commitea CERRADO (D4)');
    assert.equal(cfg.vault.hostId, '', 'CA-29: hostId VACÍO, nunca un placeholder');
    assert.equal(cfg.vault.prefix, '/intrale');
    assert.equal(cfg.vault.projectId, 'intrale');
    assert.ok(cfg.vault.cache_ttl_seconds <= MAX_CACHE_TTL_SECONDS);
    assert.ok(Array.isArray(cfg.vault.required_scopes));
    assert.ok(Array.isArray(cfg.vault.shared_secrets));
    assert.equal(cfg.vault.region, undefined, 'la región se REUTILIZA de kernel.region');
    assert.equal(cfg.kernel.region, 'us-east-2');

    // El config commiteado construye un vault sin explotar (gate cerrado).
    const vault = createSecretVault({
        config: cfg.vault,
        driver: createInMemoryVaultDriver({ parameters: {} }),
    });
    assert.match(util.inspect(vault), /enabled: false/);
});

// =============================================================================
// #5464 (1/3 de #5425) — validación canónica del namespace, exportada
// =============================================================================
//
// Estos tests fijan por regresión las dos mitades del split: que el helper
// exportado construye por la implementación canónica (no por una copia), y que
// exportarlo NO abrió la frontera read-only del runtime.

test('5464-1 · shared y host se construyen con la implementación canónica', () => {
    const base = { prefix: PREFIX, projectId: PROJECT, hostId: HOST_A };

    const compartido = validateVaultNamespace({ ...base, scope: 'telegram', tier: 'shared' });
    const porHost = validateVaultNamespace({ ...base, scope: 'aws', tier: 'host' });

    // Mismo path que `buildParameterPath`: es EL MISMO constructor, no un gemelo.
    assert.equal(compartido.path, buildParameterPath({ ...base, scope: 'telegram', tier: 'shared' }));
    assert.equal(porHost.path, buildParameterPath({ ...base, scope: 'aws', tier: 'host' }));
    assert.equal(compartido.path, '/intrale/intrale/shared/telegram');
    assert.equal(porHost.path, '/intrale/intrale/hosts/hostA/aws');

    // Descriptor completo: tier, destino y namespace explícitos.
    assert.equal(compartido.service, 'ssm');
    assert.equal(porHost.service, 'ssm');
    assert.equal(compartido.tier, 'shared');
    assert.equal(porHost.hostId, HOST_A);
    assert.equal(compartido.hostId, null, 'shared no está segmentado por host');
    assert.equal(compartido.scope, 'telegram');
    assert.equal(compartido.root, false);
    assert.ok(Object.isFrozen(compartido), 'el descriptor no se muta después de validar');

    // Raíces recursivas: las mismas que usa el barrido batch del runtime.
    const raizCompartida = validateVaultNamespace({ ...base, tier: 'shared', root: true });
    const raizHost = validateVaultNamespace({ ...base, tier: 'host', root: true });
    assert.equal(raizCompartida.path, '/intrale/intrale/shared/');
    assert.equal(raizHost.path, `/intrale/intrale/hosts/${HOST_A}/`);
    assert.equal(raizHost.scope, null, 'una raíz no tiene nombre lógico');
    assert.equal(raizHost.root, true);

    // SEC-3 — la raíz a nivel proyecto sigue siendo INCONSTRUIBLE por acá.
    for (const p of [raizCompartida.path, raizHost.path, compartido.path, porHost.path]) {
        assert.notEqual(p, `${PREFIX}/${PROJECT}/`);
    }
});

test('5464-2 · prefijos, segmentos y nombres fuera del proyecto se rechazan antes de todo acceso remoto', () => {
    const base = { prefix: PREFIX, projectId: PROJECT, hostId: HOST_A, tier: 'shared' };

    // Testigos de que el rechazo es ANTERIOR a cualquier I/O: si el helper
    // tocara el driver o la CLI, estos contadores dejarían de ser 0.
    const driver = createInMemoryVaultDriver({ parameters: seedHostA() });
    let spawns = 0;
    const runner = createAwsCliVaultRunner(
        { AWS_ACCESS_KEY_ID: 'k', AWS_SECRET_ACCESS_KEY: 's' },
        'us-east-2',
        { execFileSync: () => { spawns += 1; return '{}'; } },
    );

    const invalidos = [
        // nombre lógico fuera del proyecto
        ...['../otro', 'a/b', '', 'host.local', null, undefined, 'con espacio']
            .map((scope) => [{ ...base, scope }, /vault\.scope/]),
        // prefijo fuera del proyecto
        ...['intrale', '/intrale/', '/', '', '/intrale/../etc', '/intra le', null]
            .map((prefix) => [{ ...base, prefix, scope: 'telegram' }, /vault\.prefix/]),
        // namespace fuera del proyecto
        [{ ...base, projectId: 'pro/yecto', scope: 'telegram' }, /vault\.projectId/],
        [{ ...base, projectId: '..', scope: 'telegram' }, /vault\.projectId/],
        [{ ...base, tier: 'host', hostId: '../hostB', scope: 'telegram' }, /vault\.hostId/],
        [{ ...base, tier: 'host', hostId: '', scope: 'telegram' }, /vault\.hostId/],
        // tier inválido: nunca se infiere de la presencia de hostId
        ...[undefined, null, '', 'SHARED', 'rotante', 42]
            .map((tier) => [{ ...base, tier, scope: 'telegram' }, /vault\.tier/]),
        // `root` ambiguo: la raíz recursiva se pide explícitamente
        [{ ...base, root: 'true' }, /vault\.root/],
        [{ ...base, root: 1, scope: 'telegram' }, /vault\.root/],
    ];

    for (const [args, clave] of invalidos) {
        assert.throws(() => validateVaultNamespace(args), (e) => {
            assert.equal(e.name, 'VaultConfigError', `no es error tipado: ${util.inspect(args)}`);
            assert.equal(e.code, VAULT_ERROR_CODES.CONFIG_INVALID);
            assert.match(e.message, clave);
            // El mensaje nombra la CLAVE de config, nunca el regex crudo.
            assert.ok(!e.message.includes('A-Za-z0-9'), 'el regex crudo no sale del módulo');
            return true;
        }, `entrada inválida no rechazada: ${util.inspect(args)}`);
    }

    // Sin argumentos tampoco devuelve un descriptor a medias: falla cerrado.
    assert.throws(() => validateVaultNamespace(), /vault\.tier/);

    assert.equal(driver.calls.length, 0, 'validar no leyó del driver');
    assert.equal(spawns, 0, 'validar no spawneó la CLI');
});

test('5464-3 · rotating sigue reconocido por el runtime, sin incorporar escritura', async () => {
    const rotativo = validateVaultNamespace({
        prefix: PREFIX, projectId: PROJECT, scope: 'google_drive', tier: 'rotating',
    });

    assert.equal(rotativo.path, 'intrale/intrale/rotating/google_drive');
    assert.ok(!rotativo.path.startsWith('/'), 'Secrets Manager: SIN barra inicial');
    assert.equal(rotativo.service, 'secretsmanager');
    assert.equal(rotativo.hostId, null);
    // Secrets Manager se lee por nombre exacto: no hay raíz recursiva.
    assert.throws(
        () => validateVaultNamespace({ prefix: PREFIX, projectId: PROJECT, tier: 'rotating', root: true }),
        /vault\.tier/,
    );

    // El destino por tier está declarado para TODOS los tiers y para ninguno
    // más: un tier nuevo sin destino rompe acá en vez de mandar el pedido al
    // servicio equivocado en producción.
    assert.deepEqual(Object.keys(VAULT_TIER_SERVICE).sort(), [...VAULT_TIERS].sort());
    assert.ok(Object.isFrozen(VAULT_TIER_SERVICE));
    for (const service of Object.values(VAULT_TIER_SERVICE)) {
        assert.ok(['ssm', 'secretsmanager'].includes(service));
    }

    // Y el camino de LECTURA de `rotating` sigue funcionando por Secrets Manager.
    const vault = createSecretVault({
        config: configVault({ required_scopes: ['google_drive'], shared_secrets: [] }),
        driver: createInMemoryVaultDriver({
            secrets: { [rotativo.path]: { refresh_token: 'CANARIO-GD' } },
        }),
    });
    const res = await vault.resolveScope({ scopes: ['google_drive'], tier: 'rotating' });
    assert.deepEqual(res.google_drive, { refresh_token: 'CANARIO-GD' });
});

test('5464-4 · exportar el validador no agregó verbos de escritura al runtime', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const fuente = fs.readFileSync(path.join(__dirname, '..', 'secret-vault.js'), 'utf8');
    const escrituras = ['put-parameter', 'put-secret-value', 'create-secret',
        'delete-parameter', 'update-secret', 'label-parameter-version'];

    // La allowlist sigue siendo EXACTAMENTE la de #5352.
    assert.deepEqual([...VAULT_READONLY_COMMANDS], [
        'ssm get-parameters-by-path', 'ssm get-parameter', 'secretsmanager get-secret-value',
    ]);
    for (const verbo of escrituras) {
        assert.ok(!VAULT_READONLY_COMMANDS.some((c) => c.includes(verbo)),
            `la allowlist incorporó escritura: ${verbo}`);
    }

    // El runner los rechaza por COMPORTAMIENTO, sin spawnear.
    let spawns = 0;
    const runner = createAwsCliVaultRunner(
        { AWS_ACCESS_KEY_ID: 'k', AWS_SECRET_ACCESS_KEY: 's' },
        'us-east-2',
        { execFileSync: () => { spawns += 1; return '{}'; } },
    );
    for (const verbo of escrituras) {
        assert.throws(() => runner.run('ssm', [verbo, '--name', 'x']), /allowlist read-only/,
            `verbo de escritura no rechazado: ${verbo}`);
        assert.throws(() => runner.run('secretsmanager', [verbo]), /allowlist read-only/);
    }
    assert.equal(spawns, 0, 'ningún verbo de escritura llegó a spawnear');

    // Los drivers del runtime siguen exponiendo SÓLO lectura.
    for (const driver of [
        createInMemoryVaultDriver({ parameters: seedHostA() }),
        createAwsCliVaultDriver({ run: () => '{}' }),
    ]) {
        const metodos = Object.keys(driver).filter((k) => typeof driver[k] === 'function');
        assert.deepEqual(metodos.sort(), [
            'getParametersByPath', 'getParametersByPathSync', 'getSecretValue', 'getSecretValueSync',
        ], `el driver ${driver.kind} expone métodos fuera del contrato de lectura`);
    }

    // Los regex NO se exportan: exportarlos habilitaría la copia que el helper
    // viene a evitar (el consumidor debe pasar por `validateVaultNamespace`).
    const exportado = require('../secret-vault');
    for (const [clave, valor] of Object.entries(exportado)) {
        assert.ok(!(valor instanceof RegExp), `se exportó un regex crudo: ${clave}`);
    }

    // El módulo tampoco nombra un verbo de escritura fuera de un comentario.
    for (const linea of fuente.split('\n')) {
        const codigo = linea.trim();
        if (codigo.startsWith('//') || codigo.startsWith('*')) continue;
        for (const verbo of escrituras) {
            assert.ok(!codigo.includes(verbo), `verbo de escritura en el código: ${codigo}`);
        }
    }
});
