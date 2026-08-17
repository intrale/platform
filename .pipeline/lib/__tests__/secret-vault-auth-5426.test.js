// =============================================================================
// Tests del bootstrap de credencial raíz por host — #5426 (TRAMO 2 de #5339)
// node --test  (entra por el glob existente de `npm run test:pipeline`)
// =============================================================================
//
// Lo que estos tests defienden, en una línea: **el ambiente TRANSPORTA material
// de credencial, pero nunca ELIGE con qué principal corre la AWS CLI que lee el
// vault.**
//
// NINGÚN test requiere red ni cuenta AWS. El camino aws-cli se ejerce con
// `execFileSync` inyectado, y el call-site de producción (`credentials.js`) se
// ejerce con `vaultConfig` inyectada y el `process.env` del propio proceso de
// test — que es justamente donde se inyecta el `AWS_PROFILE=default` hostil.
//
// Mapa de criterios:
//   CA-11(a)  los 4 valores del enum construyen el runner con su señal
//   CA-11(b)  `authMode` vacío / fuera del enum falla NOMBRANDO `vault.authMode`
//   CA-11(c)  el mensaje de error no dice `aws login` ni nombra perfiles
//   CA-12(b)  `hostId` se resuelve en runtime; el valor no sale de config.yaml
//   CA-12(e)  `hostId` no resoluble falla nombrando `vault.hostId`, sin `hosts//`
//   CA-13(a)  `AWS_PROFILE=default` del padre NO llega al hijo
//   CA-13(b)  la verificación corre sobre el call-site real de `credentials.js`
//   CA-13(c)  `AWS_CONFIG_FILE`/`AWS_SHARED_CREDENTIALS_FILE` se calculan en código
//   CA-14     `buildAwsScopedEnv` no se ensancha: el vault tiene builder propio
// =============================================================================
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const {
    VAULT_AUTH_MODES,
    VAULT_READONLY_COMMANDS,
    VAULT_ERROR_CODES,
    buildVaultAwsEnv,
    assertVaultAuthConfig,
    resolveVaultHostId,
    createAwsCliVaultRunner,
    createSecretVault,
    createInMemoryVaultDriver,
} = require('../secret-vault');

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

const REGION = 'us-east-2';

// Ambiente de origen HOSTIL: trae todo lo que un atacante con capacidad de
// escribir variables de entorno pondría para elegirle el principal al vault.
// `default` es el caso peligroso de verdad: en el host real ese perfil resuelve
// a un principal muy por encima del rol de lectura (T2-1).
function envHostil(extra = {}) {
    return {
        AWS_PROFILE: 'default',
        AWS_CONFIG_FILE: 'C:/tmp/evil-config',
        AWS_SHARED_CREDENTIALS_FILE: 'C:/tmp/evil-creds',
        AWS_ENDPOINT_URL: 'http://attacker.local:9999',
        TELEGRAM_BOT_TOKEN: 'CANARIO-TELEGRAM',
        PATH: '/evil/bin',
        ...extra,
    };
}

function cfgBase(extra = {}) {
    return {
        enabled: true,
        prefix: '/intrale',
        projectId: 'intrale',
        hostId: 'HOST-DE-TEST',
        cache_ttl_seconds: 300,
        required_scopes: [],
        shared_secrets: [],
        region: REGION,
        ...extra,
    };
}

// Señal de ambiente que cada modo necesita, para el test de construcción feliz.
const SENAL_POR_MODO = Object.freeze({
    'assume-role-chain': {},
    'session-token': {
        AWS_ACCESS_KEY_ID: 'ASIA-TEST',
        AWS_SECRET_ACCESS_KEY: 'SECRET-TEST',
        AWS_SESSION_TOKEN: 'TOKEN-TEST',
    },
    'static-key': { AWS_ACCESS_KEY_ID: 'AKIA-TEST', AWS_SECRET_ACCESS_KEY: 'SECRET-TEST' },
    'instance-profile': {},
});

function cfgDeModo(modo) {
    return cfgBase(modo === 'assume-role-chain'
        ? { authMode: modo, awsProfile: 'perfil-vault-test' }
        : { authMode: modo });
}

// =============================================================================
// 1 · CA-11(a) — los CUATRO valores del enum construyen el runner
// =============================================================================

test('1 · CA-11(a) · los 4 mecanismos del enum construyen el runner con su señal', () => {
    assert.ok(Object.isFrozen(VAULT_AUTH_MODES), 'el enum está congelado');
    assert.deepEqual([...VAULT_AUTH_MODES], [
        'assume-role-chain', 'session-token', 'static-key', 'instance-profile',
    ]);

    for (const modo of VAULT_AUTH_MODES) {
        let spawns = 0;
        const runner = createAwsCliVaultRunner(
            envHostil(SENAL_POR_MODO[modo]),
            cfgDeModo(modo),
            { execFileSync: () => { spawns += 1; return '{}'; } },
        );
        assert.equal(runner.kind, 'aws-cli-runner', `modo ${modo}: runner no construido`);
        assert.equal(spawns, 0, `modo ${modo}: construir el runner no spawnea`);
    }
});

test('1b · `assume-role-chain` SIN claves estáticas en el ambiente construye OK', () => {
    // Es el caso que el guard viejo rechazaba por construcción: el host real no
    // deja par estático en el ambiente, su identidad vive en el perfil.
    const runner = createAwsCliVaultRunner(
        { PATH: '/bin' },   // ni una sola AWS_*
        cfgBase({ authMode: 'assume-role-chain', awsProfile: 'perfil-vault-test' }),
        { execFileSync: () => '{}' },
    );
    assert.equal(runner.kind, 'aws-cli-runner');
});

// =============================================================================
// 2 · CA-11(b) — el simétrico: sin señal positiva, falla NOMBRANDO la clave
// =============================================================================

test('2 · CA-11(b) · authMode vacío, ausente o fuera del enum falla nombrando vault.authMode', () => {
    const invalidos = [
        undefined,
        null,
        '',
        'aws-login',            // el mecanismo que sugería el mensaje viejo
        'ASSUME-ROLE-CHAIN',    // el enum es exacto, no case-insensitive
        'assume-role-chain ',   // ni tolera espacios
        true,
        { authMode: 'assume-role-chain' },
    ];
    for (const valor of invalidos) {
        assert.throws(
            () => createAwsCliVaultRunner({ PATH: '/bin' }, cfgBase({ authMode: valor }), {
                execFileSync: () => { throw new Error('no debería spawnear'); },
            }),
            (e) => {
                assert.equal(e.code, VAULT_ERROR_CODES.CONFIG_INVALID);
                assert.equal(e.clave, 'vault.authMode');
                assert.match(e.message, /vault\.authMode/);
                // La remediación nombra la CLAVE DE CONFIG, no «faltan variables»:
                // un operador no puede accionar sobre la ausencia de algo que
                // nunca supo que tenía que estar.
                assert.match(e.message, /\.pipeline\/config\.yaml/);
                return true;
            },
            `valor no rechazado: ${JSON.stringify(valor)}`,
        );
    }
});

test('2b · la firma vieja (región como string) NO se acepta por compatibilidad', () => {
    // Aceptar un string obligaría a asumir un `authMode` implícito, y un modo de
    // identidad implícito es exactamente lo que T2-2 prohíbe. Falla ruidoso.
    assert.throws(
        () => createAwsCliVaultRunner({ AWS_ACCESS_KEY_ID: 'k', AWS_SECRET_ACCESS_KEY: 's' },
            REGION, { execFileSync: () => '{}' }),
        (e) => {
            assert.equal(e.clave, 'vault.authMode');
            return true;
        },
    );
});

test('2c · `assume-role-chain` sin `vault.awsProfile` falla nombrando esa clave', () => {
    for (const perfil of [undefined, '', null]) {
        assert.throws(
            () => createAwsCliVaultRunner({ PATH: '/bin' },
                cfgBase({ authMode: 'assume-role-chain', awsProfile: perfil }),
                { execFileSync: () => '{}' }),
            (e) => {
                assert.equal(e.clave, 'vault.awsProfile');
                return true;
            },
            `perfil no rechazado: ${JSON.stringify(perfil)}`,
        );
    }
    // Y un nombre de perfil con forma de path o de flag tampoco pasa: ese valor
    // termina en el ambiente de un proceso hijo.
    for (const perfil of ['../otro', '-perfil', 'con espacio', 'a/b']) {
        assert.throws(
            () => createAwsCliVaultRunner({ PATH: '/bin' },
                cfgBase({ authMode: 'assume-role-chain', awsProfile: perfil }),
                { execFileSync: () => '{}' }),
            (e) => e.clave === 'vault.awsProfile',
            `perfil no rechazado: ${perfil}`,
        );
    }
});

test('2d · `awsProfile` con un modo que no resuelve por perfil se rechaza', () => {
    // Perfil + material de credencial en el mismo ambiente es ambiguo: la CLI
    // resuelve por el material y el perfil queda de adorno, mientras el operador
    // que lo escribió cree estar usando el rol.
    assert.throws(
        () => createAwsCliVaultRunner(
            { AWS_ACCESS_KEY_ID: 'k', AWS_SECRET_ACCESS_KEY: 's' },
            cfgBase({ authMode: 'static-key', awsProfile: 'perfil-vault-test' }),
            { execFileSync: () => '{}' },
        ),
        (e) => e.clave === 'vault.awsProfile',
    );
});

test('2e · el modo declarado sin su señal en el ambiente falla cerrado', () => {
    const sinSenal = [
        ['session-token', { AWS_ACCESS_KEY_ID: 'k', AWS_SECRET_ACCESS_KEY: 's' }], // falta el token
        ['static-key', { AWS_ACCESS_KEY_ID: 'k' }],                                 // falta el secret
        ['static-key', {}],
    ];
    for (const [modo, env] of sinSenal) {
        assert.throws(
            () => createAwsCliVaultRunner(env, cfgBase({ authMode: modo }), {
                execFileSync: () => { throw new Error('no debería spawnear'); },
            }),
            (e) => {
                assert.equal(e.clave, 'vault.credenciales');
                assert.match(e.message, /credenciales AWS/);
                return true;
            },
            `modo ${modo} aceptado sin señal`,
        );
    }
});

// =============================================================================
// 3 · CA-11(c) — el mensaje de error no hace reconocimiento
// =============================================================================

test('3 · CA-11(c) · ningún mensaje dice `aws login` ni nombra un perfil del host', () => {
    const mensajes = [];
    const capturar = (fn) => { try { fn(); } catch (e) { mensajes.push(e.message); } };

    capturar(() => createAwsCliVaultRunner({}, cfgBase({ authMode: '' }), {}));
    capturar(() => createAwsCliVaultRunner({}, cfgBase({ authMode: 'static-key' }), {}));
    capturar(() => createAwsCliVaultRunner({}, cfgBase({ authMode: 'session-token' }), {}));
    capturar(() => createAwsCliVaultRunner({}, cfgBase({
        authMode: 'assume-role-chain', awsProfile: '',
    }), {}));
    capturar(() => createAwsCliVaultRunner(envHostil(), cfgBase({ authMode: 'nope' }), {}));
    assert.ok(mensajes.length >= 5, 'se capturaron los mensajes de las ramas de falla');

    for (const m of mensajes) {
        assert.ok(!/aws login/i.test(m), `el mensaje sugiere \`aws login\`: ${m}`);
        // Ningún nombre de perfil del host: ni el que vino por config, ni el que
        // vino por el ambiente. Un mensaje de error viaja a logs y a Telegram.
        assert.ok(!/\bdefault\b/.test(m), `el mensaje nombra un perfil: ${m}`);
        assert.ok(!/perfil-vault-test/.test(m), `el mensaje nombra un perfil: ${m}`);
    }

    // Y el módulo entero dejó de sugerir la remediación que no satisfacía al
    // guard que la emitía.
    const fuente = fs.readFileSync(path.join(__dirname, '..', 'secret-vault.js'), 'utf8');
    assert.ok(!/`aws login`/.test(fuente), 'el módulo ya no sugiere `aws login`');
});

// =============================================================================
// 4 · CA-13(a)/(c) + T2-1 — el ambiente no elige la autoridad
// =============================================================================

test('4 · CA-13(a) · AWS_PROFILE=default del ambiente NO llega al hijo', () => {
    let envVisto = null;
    const runner = createAwsCliVaultRunner(
        envHostil(),
        cfgBase({ authMode: 'assume-role-chain', awsProfile: 'perfil-vault-test' }),
        { execFileSync: (bin, args, opts) => { envVisto = opts.env; return '{}'; } },
    );
    runner.run('ssm', ['get-parameters-by-path', '--path', '/intrale/intrale/shared/', '--recursive']);

    assert.equal(envVisto.AWS_PROFILE, 'perfil-vault-test', 'el perfil sale de config');
    assert.notEqual(envVisto.AWS_PROFILE, 'default');
    assert.ok(!JSON.stringify(envVisto).includes('default'),
        'ni una sola clave del env del hijo trae `default`');

    // CA-13(c) — las rutas de resolución de identidad se CALCULAN, no se copian.
    assert.equal(envVisto.AWS_CONFIG_FILE, path.join(os.homedir(), '.aws', 'config'));
    assert.equal(envVisto.AWS_SHARED_CREDENTIALS_FILE,
        path.join(os.homedir(), '.aws', 'credentials'));
    assert.notEqual(envVisto.AWS_CONFIG_FILE, 'C:/tmp/evil-config');
    assert.notEqual(envVisto.AWS_SHARED_CREDENTIALS_FILE, 'C:/tmp/evil-creds');

    // El resto del ambiente hostil no sobrevive.
    assert.equal(envVisto.AWS_ENDPOINT_URL, undefined);
    assert.equal(envVisto.TELEGRAM_BOT_TOKEN, undefined);
    assert.equal(envVisto.PATH, undefined);
    for (const k of Object.keys(envVisto)) assert.match(k, /^AWS_/);
});

test('4b · en modo por perfil, un par estático heredado NO le puede ganar al rol', () => {
    // La AWS CLI le da precedencia al par del ambiente por encima del perfil. Si
    // el builder copiara el material en modo `assume-role-chain`, un par estático
    // heredado del padre elegiría el principal igual — el mismo agujero de
    // T2-1, entrando por la otra puerta.
    const env = buildVaultAwsEnv(
        envHostil({ AWS_ACCESS_KEY_ID: 'AKIA-DEL-PADRE', AWS_SECRET_ACCESS_KEY: 'SECRET-DEL-PADRE' }),
        cfgBase({ authMode: 'assume-role-chain', awsProfile: 'perfil-vault-test' }),
    );
    assert.equal(env.AWS_ACCESS_KEY_ID, undefined);
    assert.equal(env.AWS_SECRET_ACCESS_KEY, undefined);
    assert.equal(env.AWS_SESSION_TOKEN, undefined);
    assert.equal(env.AWS_PROFILE, 'perfil-vault-test');

    // `instance-profile` tampoco: la identidad sale de la metadata del host.
    const envIP = buildVaultAwsEnv(
        envHostil({ AWS_ACCESS_KEY_ID: 'AKIA-DEL-PADRE', AWS_SECRET_ACCESS_KEY: 'S' }),
        cfgBase({ authMode: 'instance-profile' }),
    );
    // Ninguna credencial heredada y ningún perfil: eso es lo que este test mide.
    // El env NO se agota en `AWS_REGION` a propósito — lleva además el corte de
    // la cadena por archivos, sin el cual la CLI resolvería contra `~/.aws`
    // (ver 4e, que es donde esa parte se verifica).
    assert.equal(envIP.AWS_ACCESS_KEY_ID, undefined);
    assert.equal(envIP.AWS_SECRET_ACCESS_KEY, undefined);
    assert.equal(envIP.AWS_SESSION_TOKEN, undefined);
    assert.equal(envIP.AWS_PROFILE, undefined);
});

test('4c · los modos con material sí lo transportan, y sólo el que corresponde', () => {
    const envSesion = buildVaultAwsEnv(
        envHostil({
            AWS_ACCESS_KEY_ID: 'ASIA-X', AWS_SECRET_ACCESS_KEY: 'S', AWS_SESSION_TOKEN: 'T',
        }),
        cfgBase({ authMode: 'session-token' }),
    );
    assert.equal(envSesion.AWS_SESSION_TOKEN, 'T');
    assert.equal(envSesion.AWS_PROFILE, undefined, 'sin perfil: el modo no resuelve por perfil');
    assert.equal(envSesion.AWS_CONFIG_FILE, undefined);

    const envStatic = buildVaultAwsEnv(
        envHostil({ AWS_ACCESS_KEY_ID: 'AKIA-X', AWS_SECRET_ACCESS_KEY: 'S', AWS_SESSION_TOKEN: 'T' }),
        cfgBase({ authMode: 'static-key' }),
    );
    assert.equal(envStatic.AWS_ACCESS_KEY_ID, 'AKIA-X');
    assert.equal(envStatic.AWS_SESSION_TOKEN, undefined,
        '`static-key` no transporta token de sesión: sería otro mecanismo');
});

test('4d · un sourceEnv que no es objeto no cae al ambiente global', () => {
    for (const malo of [undefined, null, 'process.env', 42, ['AWS_PROFILE']]) {
        assert.throws(
            () => createAwsCliVaultRunner(malo, cfgDeModo('static-key'), {}),
            (e) => e.clave === 'vault.env',
            `sourceEnv aceptado: ${JSON.stringify(malo)}`,
        );
    }
    // Y el builder, llamado directo, tampoco: devuelve el env mínimo, nunca el
    // del proceso.
    const env = buildVaultAwsEnv(null, cfgBase({ authMode: 'static-key' }));
    assert.deepEqual(Object.keys(env), ['AWS_REGION']);
});

test('4e · en `instance-profile` el ambiente del hijo NO puede resolver contra ~/.aws', () => {
    // El caso negativo del modo que no deja señal: su guard en
    // `assertVaultAuthSignal` es incondicionalmente verde (el rol se resuelve por
    // metadata del host), así que si el builder no corta la cadena basada en
    // ARCHIVOS, la AWS CLI arranca sin material y sin destino y baja por su
    // cadena por defecto hasta `~/.aws/config` — resolviendo contra `[default]`,
    // que en un host de desarrollo está muy por encima del rol de lectura.
    const env = buildVaultAwsEnv(
        envHostil({ AWS_ACCESS_KEY_ID: 'AKIA-PADRE', AWS_SECRET_ACCESS_KEY: 'S-PADRE' }),
        cfgBase({ authMode: 'instance-profile' }),
    );

    // (a) sin destino de perfil: nadie le elige el principal.
    assert.equal(env.AWS_PROFILE, undefined,
        '`instance-profile` no resuelve por perfil: setearlo elegiría el principal');

    // (b) sin material heredado: un par estático del padre no le puede ganar
    //     al rol de instancia.
    assert.equal(env.AWS_ACCESS_KEY_ID, undefined);
    assert.equal(env.AWS_SECRET_ACCESS_KEY, undefined);
    assert.equal(env.AWS_SESSION_TOKEN, undefined);

    // (c) el corazón del caso: la cadena por archivos apunta a algo que NO EXISTE,
    //     y en particular NO al `~/.aws` real del host.
    const homeAws = path.join(os.homedir(), '.aws');
    for (const clave of ['AWS_CONFIG_FILE', 'AWS_SHARED_CREDENTIALS_FILE']) {
        const valor = env[clave];
        assert.ok(valor, `${clave} sin valor: la CLI caería a su default (~/.aws)`);
        assert.equal(fs.existsSync(valor), false,
            `${clave} apunta a un archivo que EXISTE: ${valor}`);
        assert.notEqual(valor, path.join(homeAws, 'config'));
        assert.notEqual(valor, path.join(homeAws, 'credentials'));
    }

    // (d) y no se copió nada del ambiente hostil: los valores son calculados.
    assert.notEqual(env.AWS_CONFIG_FILE, 'C:/tmp/evil-config');
    assert.notEqual(env.AWS_SHARED_CREDENTIALS_FILE, 'C:/tmp/evil-creds');
    assert.equal(env.AWS_ENDPOINT_URL, undefined);

    // (e) el env completo se agota en region + los dos cortes de cadena.
    assert.deepEqual(Object.keys(env).sort(),
        ['AWS_CONFIG_FILE', 'AWS_REGION', 'AWS_SHARED_CREDENTIALS_FILE']);
});

test('4f · ningún modo deja el ambiente sin material Y sin corte de cadena a la vez', () => {
    // La invariante que generaliza 4e: para CADA modo del enum, o el hijo lleva
    // material de credencial, o lleva un destino de archivos explícito. Nunca
    // ninguno de los dos — ese hueco es el que devuelve la elección al disco.
    for (const modo of VAULT_AUTH_MODES) {
        const env = buildVaultAwsEnv(envHostil(SENAL_POR_MODO[modo]),
            cfgDeModo(modo));
        const llevaMaterial = !!(env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY);
        const llevaDestino = !!env.AWS_CONFIG_FILE && !!env.AWS_SHARED_CREDENTIALS_FILE;
        assert.ok(llevaMaterial || llevaDestino,
            `modo ${modo}: el hijo arranca sin material y sin destino, `
            + `la CLI resolvería contra ~/.aws — env: ${JSON.stringify(env)}`);
    }
});

// =============================================================================
// 5 · CA-13(b) — la verificación corre sobre el CALL-SITE REAL de producción
// =============================================================================

test('5 · CA-13(b) · el call-site de credentials.js no propaga AWS_PROFILE del padre', () => {
    // Sin este test, un dev que implemente sólo `secret-vault.js` cierra todos
    // los criterios en verde con el agujero abierto en `credentials.js` (G-1).
    const credentials = require('../credentials');
    const previo = process.env.AWS_PROFILE;
    process.env.AWS_PROFILE = 'default';        // el ambiente hostil, de verdad
    try {
        const visto = [];
        // Se fuerza el camino del runner real: `vaultDriver` NO se inyecta, así
        // que `resolverVault` construye el runner de producción. El spawn se
        // intercepta por el error que produce la CLI ausente, y lo que se mide
        // es que el guard haya llegado con la config y no con `process.env`.
        const res = credentials.loadIntoEnv({
            env: {},
            vaultConfig: cfgBase({
                enabled: true,
                authMode: 'assume-role-chain',
                awsProfile: 'perfil-vault-test',
                hostId: 'HOST-DE-TEST',
            }),
            logger: (m) => visto.push(m),
        });
        // El vault falla (no hay cuenta AWS en el test), pero falla DESPUÉS del
        // guard y sin haber tomado el perfil del ambiente: si lo hubiera tomado,
        // el mensaje o el estado nombrarían `default`.
        const texto = JSON.stringify({ res, visto });
        assert.ok(!/"default"/.test(texto), 'el perfil del ambiente se filtró al vault');
    } finally {
        if (previo === undefined) delete process.env.AWS_PROFILE;
        else process.env.AWS_PROFILE = previo;
        credentials.resetVaultMemo && credentials.resetVaultMemo();
    }
});

test('5b · el call-site pasa la config del vault, no sólo la región', () => {
    // Verificación estructural, para que el acotamiento no se pueda deshacer sin
    // que un test lo note: el runner se construye con el OBJETO de config del
    // vault, y jamás con `cfg.region` pelada.
    //
    // El nombre del local NO es parte del criterio. #5426 lo introdujo como
    // `cfgHost` (f92d25644); después `main` refactorizó `credentials.js` en los
    // splits #5219 (a219ea460) y #5900 (f899e6893) y lo renombró a `cfg`,
    // conservando la semántica —y hasta el comentario `#5426 · SEC-2/G-1` que
    // explica que el 2º argumento dejó de ser la región—. Anclar el assert al
    // identificador hacía que el merge con main diera rojo sin que nada del
    // acotamiento se hubiera aflojado: un falso positivo.
    //
    // Lo que SÍ es criterio (CA-13/G-1) y queda asertado: que el 2º argumento
    // sea el objeto de config y no `.region` ni un string. La garantía de
    // comportamiento —que `AWS_PROFILE=default` del ambiente no se filtre— la
    // cubre el test 5, que ejercita el call-site de verdad.
    const fuente = fs.readFileSync(path.join(__dirname, '..', 'credentials.js'), 'utf8');
    assert.match(fuente, /createAwsCliVaultRunner\(process\.env,\s*cfg(?:Host)?\)/,
        'el call-site debe entregarle la config del vault al runner');
    assert.ok(!/createAwsCliVaultRunner\(process\.env,\s*cfg\.region\)/.test(fuente),
        'el call-site no puede volver a pasar sólo la región');
    // Ningún literal en el 2º argumento: un string ahí es exactamente el modo de
    // identidad implícito que T2-2 prohíbe.
    assert.ok(!/createAwsCliVaultRunner\(process\.env,\s*['"`]/.test(fuente),
        'el call-site no puede pasar un literal en lugar de la config');
});

// =============================================================================
// 6 · CA-12 — el hostId se resuelve en runtime y NUNCA se commitea
// =============================================================================

test('6 · CA-12(b) · el hostId se resuelve en runtime cuando config lo habilita', () => {
    assert.equal(
        resolveVaultHostId({ hostId: '', hostIdFromHostname: true }, { hostname: () => 'HOST-A' }),
        'HOST-A',
    );
    // Un `hostId` declarado gana: el runtime es el default, no un override.
    assert.equal(
        resolveVaultHostId({ hostId: 'EXPLICITO', hostIdFromHostname: true },
            { hostname: () => 'HOST-A' }),
        'EXPLICITO',
    );
    // Sin la señal positiva NO se resuelve solo: si fuera implícito, un `hostId`
    // vacío dejaría de distinguirse de «sin configurar» y se perdería el
    // fail-closed que hoy nombra la clave.
    assert.equal(resolveVaultHostId({ hostId: '' }, { hostname: () => 'HOST-A' }), '');
    assert.equal(
        resolveVaultHostId({ hostId: '', hostIdFromHostname: 'true' },
            { hostname: () => 'HOST-A' }),
        '', 'el string "true" no habilita nada: fail-closed sobre el booleano exacto',
    );
});

test('6b · CA-12(e) · hostId no resoluble falla nombrando vault.hostId, sin namespace colapsado', () => {
    const construir = (hostId) => createSecretVault({
        config: cfgBase({ hostId, authMode: 'static-key' }),
        driver: createInMemoryVaultDriver({}),
    });
    for (const malo of ['', '   ', 'host.local', '../otro', 'hosts//']) {
        assert.throws(construir.bind(null, malo), (e) => {
            assert.equal(e.clave, 'vault.hostId');
            assert.match(e.message, /vault\.hostId/);
            return true;
        }, `hostId aceptado: ${JSON.stringify(malo)}`);
    }
    // Un hostname que no resuelve deja el hostId vacío, y el vacío ya falla.
    assert.equal(resolveVaultHostId({ hostId: '', hostIdFromHostname: true }, {
        hostname: () => { throw new Error('sin hostname'); },
    }), '');
    assert.equal(resolveVaultHostId({ hostId: '', hostIdFromHostname: true }, {
        hostname: () => undefined,
    }), '');
});

test('6c · CA-12(b/c) · config.yaml commitea el MECANISMO y nunca el hostname', () => {
    const yaml = fs.readFileSync(
        path.join(__dirname, '..', '..', 'config.yaml'), 'utf8',
    );
    const bloque = yaml.slice(yaml.indexOf('\nvault:'));
    assert.match(bloque, /^\s{2}hostId:\s*""\s*$/m,
        'CA-12(b): `vault.hostId` se commitea VACÍO — el repo es público');
    assert.match(bloque, /^\s{2}hostIdFromHostname:\s*true\s*$/m,
        'el mecanismo sí se commitea: el alta no requiere editar config.yaml');
    assert.match(bloque, /^\s{2}awsProfile:\s*""\s*$/m,
        'el nombre de perfil es un dato local del host, no se commitea');
    assert.match(bloque, /^\s{2}authMode:\s*"assume-role-chain"\s*$/m,
        'D7: el mecanismo elegido queda declarado y es del enum');

    // El hostname de ESTA máquina no puede aparecer en el archivo trackeado.
    const host = os.hostname();
    if (host && host.length >= 4) {
        assert.ok(!new RegExp(host, 'i').test(yaml),
            'T2-5: el hostname de la máquina no puede estar en config.yaml');
    }
});

// =============================================================================
// 7 · CA-14 — no-regresión: el builder compartido no se ensancha
// =============================================================================

test('7 · CA-14 · el vault tiene builder propio y no importa el compartido', () => {
    const fuente = fs.readFileSync(path.join(__dirname, '..', 'secret-vault.js'), 'utf8');
    assert.ok(!/require\(['"]\.\/kernel-provision['"]\)/.test(fuente),
        'CA-14: `secret-vault.js` no puede depender del builder compartido');

    // Y el compartido sigue siendo el de siempre: copia el scope `aws` tal cual,
    // AWS_PROFILE incluido. Ensancharlo movería el blast radius a #5126, que hoy
    // está dormido y se cobraría semanas después como halt del pipeline.
    const { buildAwsScopedEnv } = require('../kernel-provision');
    const compartido = buildAwsScopedEnv({ AWS_PROFILE: 'default', AWS_ACCESS_KEY_ID: 'k' }, REGION);
    assert.equal(compartido.AWS_PROFILE, 'default',
        'el builder compartido NO cambió de comportamiento');

    // El del vault, con la misma entrada, descarta el perfil del ambiente.
    const propio = buildVaultAwsEnv({ AWS_PROFILE: 'default', AWS_ACCESS_KEY_ID: 'k' },
        cfgBase({ authMode: 'assume-role-chain', awsProfile: 'perfil-vault-test' }));
    assert.equal(propio.AWS_PROFILE, 'perfil-vault-test');
});

// =============================================================================
// 8 · La superficie de escritura no se movió ni un milímetro
// =============================================================================

test('8 · el tramo no agregó verbos: la allowlist sigue teniendo los 3 de lectura', () => {
    assert.ok(Object.isFrozen(VAULT_READONLY_COMMANDS));
    assert.deepEqual([...VAULT_READONLY_COMMANDS], [
        'ssm get-parameters-by-path',
        'ssm get-parameter',
        'secretsmanager get-secret-value',
    ]);

    // Y el runner los sigue rechazando en caliente, con el mecanismo nuevo.
    let spawns = 0;
    const runner = createAwsCliVaultRunner(
        { PATH: '/bin' },
        cfgBase({ authMode: 'assume-role-chain', awsProfile: 'perfil-vault-test' }),
        { execFileSync: () => { spawns += 1; return '{}'; } },
    );
    for (const verbo of ['put-parameter', 'delete-parameter', 'label-parameter']) {
        assert.throws(() => runner.run('ssm', [verbo, '--path', '/x']), /allowlist read-only/);
    }
    assert.throws(() => runner.run('secretsmanager', ['put-secret-value']), /allowlist read-only/);
    assert.throws(() => runner.run('iam', ['create-access-key']), /allowlist read-only/);
    assert.equal(spawns, 0, 'ni un proceso hijo para un verbo de escritura');
});

// =============================================================================
// 9 · Cobertura declarada: las 5 ramas del guard, enumeradas
// =============================================================================

test('9 · las 5 ramas de `assertVaultAuthConfig` están cubiertas (4 del enum + inválido)', () => {
    const vistas = new Set();
    for (const modo of VAULT_AUTH_MODES) {
        assertVaultAuthConfig(cfgDeModo(modo));   // no lanza
        vistas.add(modo);
    }
    assert.equal(vistas.size, 4);
    assert.throws(() => assertVaultAuthConfig(cfgBase({ authMode: 'inexistente' })),
        (e) => e.clave === 'vault.authMode');
});
