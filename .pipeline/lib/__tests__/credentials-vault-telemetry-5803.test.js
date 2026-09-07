'use strict';

// =============================================================================
// credentials-vault-telemetry-5803.test.js — #5803 (hija de #5800)
//
// Las DOS decisiones que toma `credentials.js` y el vault no puede ver:
//
//   D1  join de un vuelo en curso (`_vuelos`, puesto por #5797) → single_flight_join
//   D2  hit de `_vaultMemo` vigente (el vault ni se construye)  → cache_hit
//
// Regla de dueño único: esta capa emite SÓLO cuando la resolución NO llega al
// vault. Si llega, emite el vault. Las ramas son mutuamente excluyentes por
// construcción, así que no hay doble conteo posible — y eso es lo que estos
// tests afirman contando eventos Y llamadas al driver a la vez.
//
// Lo que NO se hace acá, y se verifica con grep estático: contadores propios,
// literales de categoría, objetos de evento armados a mano, y wrappers sobre el
// sink que le pasa al vault (CA-17).
// =============================================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const sv = require('../secret-vault');
const { buildParameterPath, createInMemoryVaultDriver, VAULT_TELEMETRY, VAULT_TELEMETRY_CATEGORIES } = sv;
const {
    resolveInstanceVault,
    resolveInstanceVaultAsync,
    resolveVaultOnly,
    vaultScopePlan,
    resetVaultCacheAll,
} = require('../credentials');

const RUTA_CREDENTIALS = path.join(__dirname, '..', 'credentials.js');

const PREFIX = '/test5803cr';
const HOST = 'host5803cr';
const PROYECTO = 'proyecto5803cr';

const CANARIO_VALOR = 'CANARIO-VALOR-CREDENTIALS-5803';
const CANARIO_PREFIX = '/canarioPrefixCr5803';
const CANARIO_HOST = 'canarioHostIdCr5803';

function cfg(over = {}) {
    return {
        enabled: true,
        prefix: PREFIX,
        projectId: 'kernel',
        hostId: HOST,
        cache_ttl_seconds: 300,
        required_scopes: [],
        shared_secrets: [],
        ...over,
    };
}

function driverSembrado({ prefix = PREFIX, hostId = HOST } = {}) {
    const parameters = {};
    for (const scope of ['alpha', 'beta']) {
        parameters[buildParameterPath({
            prefix, projectId: PROYECTO, hostId, scope, tier: 'host',
        })] = { valor: CANARIO_VALOR };
    }
    const secrets = {};
    for (const scope of ['gamma']) {
        secrets[buildParameterPath({
            prefix, projectId: PROYECTO, scope, tier: 'rotating',
        })] = { valor: CANARIO_VALOR };
    }
    return createInMemoryVaultDriver({ parameters, secrets });
}

function sinkCaptor() {
    const eventos = [];
    const fn = (e) => eventos.push(e);
    fn.eventos = eventos;
    fn.categorias = () => eventos.map((e) => e.category);
    fn.contar = (cat) => eventos.filter((e) => e.category === cat).length;
    return fn;
}

function relojFake(inicial = 1000000) {
    let ahora = inicial;
    const fn = () => ahora;
    fn.avanzar = (ms) => { ahora += ms; };
    return fn;
}

function opts(over = {}) {
    return {
        vaultConfig: cfg(over.cfgOver),
        vaultDriver: over.driver,
        logger: over.logger || (() => {}),
        now: over.now,
        vaultSink: over.sink,
        ...(over.extra || {}),
    };
}

/** Espía sobre `createSecretVault` — patrón de `credentials-vault-5219.test.js`. */
function espiarVaults() {
    const original = sv.createSecretVault;
    const creados = [];
    sv.createSecretVault = (args) => {
        creados.push({ sink: args && args.sink, projectId: args && args.config && args.config.projectId });
        return original(args);
    };
    return { creados, restaurar() { sv.createSecretVault = original; } };
}

// =============================================================================
// CA-3 (redefinido) — coalescencia REAL, que es lo que el vault no puede ver
// =============================================================================

test('CA-3 · N llamadas concurrentes dan 1 physical_read + (N-1) single_flight_join, con UNA sola llamada batch', async () => {
    resetVaultCacheAll();
    let liberar;
    const barrera = new Promise((res) => { liberar = res; });
    const base = driverSembrado();
    const driver = {
        kind: 'barrera',
        calls: base.calls,
        async getParametersByPath(root, o) {
            await barrera;
            return base.getParametersByPath(root, o);
        },
        getSecretValue: (...a) => base.getSecretValue(...a),
    };
    const sink = sinkCaptor();

    const N = 5;
    const pedidos = Array.from({ length: N }, () => resolveInstanceVaultAsync(
        { projectId: PROYECTO, scopes: ['alpha'] },
        opts({ driver, sink, now: relojFake() }),
    ));
    liberar();
    const resultados = await Promise.all(pedidos);

    for (const r of resultados) assert.strictEqual(r.ok, true, JSON.stringify(r));

    assert.strictEqual(sink.contar(VAULT_TELEMETRY.PHYSICAL_READ), 1, 'una sola lectura física');
    assert.strictEqual(sink.contar(VAULT_TELEMETRY.SINGLE_FLIGHT_JOIN), N - 1, 'los N-1 restantes se colgaron del vuelo');
    assert.strictEqual(sink.contar(VAULT_TELEMETRY.CACHE_HIT), 0, 'nadie llegó a la memo: el vuelo estaba en curso');
    assert.strictEqual(sink.eventos.length, N, 'exactamente un evento por pedido: sin doble conteo entre capas');

    // Y el driver recibió UNA sola llamada batch: la coalescencia es real, no
    // una etiqueta sobre N lecturas.
    assert.strictEqual(driver.calls.length, 1);
});

test('CA-3 · un joiner NO construye instancia de vault (por eso su cache_hit no tiene otro dueño)', async () => {
    resetVaultCacheAll();
    let liberar;
    const barrera = new Promise((res) => { liberar = res; });
    const base = driverSembrado();
    const driver = {
        kind: 'barrera2',
        calls: base.calls,
        async getParametersByPath(root, o) { await barrera; return base.getParametersByPath(root, o); },
    };
    const sink = sinkCaptor();
    const espia = espiarVaults();
    try {
        const pedidos = Array.from({ length: 4 }, () => resolveInstanceVaultAsync(
            { projectId: PROYECTO, scopes: ['alpha'] },
            opts({ driver, sink, now: relojFake() }),
        ));
        liberar();
        await Promise.all(pedidos);
        assert.strictEqual(espia.creados.length, 1, 'sólo el dueño del vuelo construye el vault');
    } finally {
        espia.restaurar();
    }
});

// =============================================================================
// CA-2b — hit de memo: un `cache_hit`, cero driver, cero vault
// =============================================================================

test('CA-2b · el hit de memo emite exactamente un cache_hit, sin tocar el driver ni el vault', () => {
    resetVaultCacheAll();
    const driver = driverSembrado();
    const sink = sinkCaptor();
    const now = relojFake();

    const primera = resolveInstanceVault({ projectId: PROYECTO, scopes: ['alpha'] }, opts({ driver, sink, now }));
    assert.strictEqual(primera.ok, true);
    assert.deepEqual(sink.categorias(), [VAULT_TELEMETRY.PHYSICAL_READ]);
    const llamadasTrasLaPrimera = driver.calls.length;

    const espia = espiarVaults();
    try {
        now.avanzar(1000);
        const segunda = resolveInstanceVault({ projectId: PROYECTO, scopes: ['alpha'] }, opts({ driver, sink, now }));
        assert.strictEqual(segunda.ok, true);
        assert.strictEqual(espia.creados.length, 0, 'el hit de memo no construye vault');
    } finally {
        espia.restaurar();
    }

    assert.deepEqual(sink.categorias(), [VAULT_TELEMETRY.PHYSICAL_READ, VAULT_TELEMETRY.CACHE_HIT]);
    assert.strictEqual(driver.calls.length, llamadasTrasLaPrimera, 'cero llamadas al driver');
});

test('CA-2b · el hit de memo del camino ASYNC también emite un solo cache_hit', async () => {
    resetVaultCacheAll();
    const driver = driverSembrado();
    const sink = sinkCaptor();
    const now = relojFake();

    await resolveInstanceVaultAsync({ projectId: PROYECTO, scopes: ['alpha'] }, opts({ driver, sink, now }));
    now.avanzar(1000);
    await resolveInstanceVaultAsync({ projectId: PROYECTO, scopes: ['alpha'] }, opts({ driver, sink, now }));

    assert.deepEqual(sink.categorias(), [VAULT_TELEMETRY.PHYSICAL_READ, VAULT_TELEMETRY.CACHE_HIT]);
    assert.strictEqual(driver.calls.length, 1);
});

test('CA-2b · el hit de memo es el único hit de caché del camino productivo', () => {
    // Cada resolución que llega al vault construye una instancia NUEVA, y dentro
    // de una instancia el núcleo corre a lo sumo una vez. Sin D2, `cache_hit`
    // sería una categoría muerta y la calibración de #5800 no podría explicar
    // el ahorro. Esto lo documenta y lo afirma.
    resetVaultCacheAll();
    const driver = driverSembrado();
    const sink = sinkCaptor();
    const now = relojFake();
    const espia = espiarVaults();
    try {
        for (let i = 0; i < 4; i += 1) {
            now.avanzar(10);
            resolveInstanceVault({ projectId: PROYECTO, scopes: ['alpha'] }, opts({ driver, sink, now }));
        }
        assert.strictEqual(espia.creados.length, 1, 'sólo el MISS construye vault');
    } finally {
        espia.restaurar();
    }
    assert.strictEqual(sink.contar(VAULT_TELEMETRY.PHYSICAL_READ), 1);
    assert.strictEqual(sink.contar(VAULT_TELEMETRY.CACHE_HIT), 3);
});

// =============================================================================
// CA-6 (parte credentials) — el camino sync jamás emite `single_flight_join`
// =============================================================================

test('CA-6 · `resolverVaultConPlan` (sync) no toca `_vuelos` (grep estático sobre el cuerpo)', () => {
    const fuente = fs.readFileSync(RUTA_CREDENTIALS, 'utf8');
    const inicio = fuente.indexOf('function resolverVaultConPlan(args, logger) {');
    assert.ok(inicio > 0, 'no se encontró `resolverVaultConPlan`');
    const fin = fuente.indexOf('async function resolverVaultConPlanAsync', inicio);
    assert.ok(fin > inicio, 'no se encontró el final del cuerpo sync');
    const cuerpoSync = fuente.slice(inicio, fin);
    assert.ok(!/_vuelos/.test(cuerpoSync), 'el camino sync no puede consultar el registro de vuelos');
    assert.ok(!/SINGLE_FLIGHT_JOIN/.test(cuerpoSync), 'el camino sync no puede emitir la categoría de join');
});

test('CA-6 · el camino sync nunca emite single_flight_join, ni con reentrada ni con memo caliente', () => {
    resetVaultCacheAll();
    const driver = driverSembrado();
    const sink = sinkCaptor();
    const now = relojFake();
    for (let i = 0; i < 6; i += 1) {
        now.avanzar(5);
        resolveInstanceVault({ projectId: PROYECTO, scopes: ['alpha'] }, opts({ driver, sink, now }));
    }
    assert.strictEqual(sink.contar(VAULT_TELEMETRY.SINGLE_FLIGHT_JOIN), 0);
    assert.strictEqual(sink.eventos.length, 6, 'un evento por pedido, ni más ni menos');
});

// =============================================================================
// CA-17 (redefinido) — `credentials.js` no cuenta, no reclasifica, no observa
// =============================================================================

test('CA-17a · `credentials.js` no contiene ningún literal de categoría', () => {
    const fuente = fs.readFileSync(RUTA_CREDENTIALS, 'utf8');
    for (const categoria of VAULT_TELEMETRY_CATEGORIES) {
        assert.ok(!fuente.includes(`'${categoria}'`), `literal '${categoria}' en credentials.js`);
        assert.ok(!fuente.includes(`"${categoria}"`), `literal "${categoria}" en credentials.js`);
        assert.ok(!fuente.includes(`\`${categoria}\``), `literal \`${categoria}\` en credentials.js`);
    }
});

test('CA-17a · `credentials.js` no arma objetos de evento a mano ni lleva contadores propios', () => {
    const fuente = fs.readFileSync(RUTA_CREDENTIALS, 'utf8');
    // Armar el evento a mano sería reimplementar la emisión: la única
    // construcción de `{category, ts_ms}` vive en `secret-vault.js`.
    assert.ok(!/category\s*:/.test(fuente), 'credentials.js no debe construir el payload del evento');
    assert.ok(!/ts_ms\s*:/.test(fuente), 'credentials.js no debe sellar el evento');
    // Y no puede tener su propio agregado: contar es trabajo de #5805.
    assert.ok(!/VAULT_TELEMETRY_CATEGORIES/.test(fuente), 'credentials.js no enumera el vocabulario');
});

test('CA-17b · el MISMO callable de sink llega al vault, por identidad referencial y sin wrapper', () => {
    resetVaultCacheAll();
    const driver = driverSembrado();
    const sink = sinkCaptor();
    const espia = espiarVaults();
    try {
        resolveInstanceVault({ projectId: PROYECTO, scopes: ['alpha'] }, opts({ driver, sink, now: relojFake() }));
        assert.strictEqual(espia.creados.length, 1);
        assert.strictEqual(espia.creados[0].sink, sink,
            'el sink viaja por identidad: envolverlo sería observar lo que el vault emite');
    } finally {
        espia.restaurar();
    }
});

test('CA-17c · sin `vaultSink` no se emite nada y el comportamiento es idéntico al de hoy', async () => {
    resetVaultCacheAll();
    const driver = driverSembrado();
    const conSink = sinkCaptor();

    const sinSink = resolveInstanceVault({ projectId: PROYECTO, scopes: ['alpha'] },
        opts({ driver, now: relojFake() }));
    resetVaultCacheAll();
    const con = resolveInstanceVault({ projectId: PROYECTO, scopes: ['alpha'] },
        opts({ driver, sink: conSink, now: relojFake() }));

    assert.deepEqual(sinSink, con, 'la instrumentación es observación PURA');
    assert.strictEqual(conSink.eventos.length, 1);

    // Y el gemelo async, igual.
    resetVaultCacheAll();
    const asyncSinSink = await resolveInstanceVaultAsync({ projectId: PROYECTO, scopes: ['alpha'] },
        opts({ driver, now: relojFake() }));
    assert.deepEqual(asyncSinSink, sinSink);
});

test('CA-17c · un sink que LANZA no rompe la resolución de credentials', async () => {
    resetVaultCacheAll();
    const driver = driverSembrado();
    const logs = [];
    const sink = () => { throw new Error('sink roto'); };
    const now = relojFake();

    const primera = await resolveInstanceVaultAsync({ projectId: PROYECTO, scopes: ['alpha'] },
        opts({ driver, sink, now, logger: (m) => logs.push(String(m)) }));
    assert.strictEqual(primera.ok, true);

    now.avanzar(10);
    const hit = await resolveInstanceVaultAsync({ projectId: PROYECTO, scopes: ['alpha'] },
        opts({ driver, sink, now, logger: (m) => logs.push(String(m)) }));
    assert.strictEqual(hit.ok, true, 'el hit de memo tampoco se rompe');

    // El aviso sale redactado: sin el evento y sin el message crudo del sink.
    const texto = logs.join('\n');
    assert.ok(!texto.includes('sink roto'));
    assert.ok(!texto.includes(CANARIO_VALOR));
});

// =============================================================================
// CA-20 — dos lecturas físicas cuando el plan tiene SSM *y* rotating
// =============================================================================

// El plan GLOBAL de producción ya mezcla los dos backends (`google_drive` vive
// en SSM y en Secrets Manager), así que CA-20 se ejerce sobre el camino real, no
// sobre un plan inventado para el test.
const PLAN_GLOBAL = vaultScopePlan();
const SCOPES_GLOBALES = [...new Set([...PLAN_GLOBAL.ssm, ...PLAN_GLOBAL.secretsmanager])];

function cfgGlobal(over = {}) {
    return cfg({
        projectId: PROYECTO,
        required_scopes: SCOPES_GLOBALES,
        shared_secrets: [],          // todo tier `host`: simplifica el sembrado
        ...over,
    });
}

/** Siembra el namespace COMPLETO que el plan global de producción exige. */
function driverGlobal({ prefix = PREFIX, hostId = HOST } = {}) {
    const parameters = {};
    for (const scope of PLAN_GLOBAL.ssm) {
        parameters[buildParameterPath({
            prefix, projectId: PROYECTO, hostId, scope, tier: 'host',
        })] = { bot_token: CANARIO_VALOR, chat_id: CANARIO_VALOR, valor: CANARIO_VALOR };
    }
    const secrets = {};
    for (const scope of PLAN_GLOBAL.secretsmanager) {
        secrets[buildParameterPath({
            prefix, projectId: PROYECTO, scope, tier: 'rotating',
        })] = { valor: CANARIO_VALOR };
    }
    return createInMemoryVaultDriver({ parameters, secrets });
}

test('CA-20 · el plan global (SSM + rotating) produce DOS physical_read: son dos lecturas reales', () => {
    resetVaultCacheAll();
    assert.ok(PLAN_GLOBAL.ssm.length > 0 && PLAN_GLOBAL.secretsmanager.length > 0,
        'el plan global de producción debe mezclar los dos backends para que CA-20 tenga sentido');

    const driver = driverGlobal();
    const sink = sinkCaptor();
    const valor = resolveVaultOnly('telegram.bot_token', {
        vaultConfig: cfgGlobal(),
        vaultDriver: driver,
        logger: () => {},
        now: relojFake(),
        vaultSink: sink,
    });
    assert.strictEqual(valor, CANARIO_VALOR);

    // `leerPayload` invoca `resolveScope` DOS veces (una por backend), y cada
    // invocación pública es una decisión distinta. Contar una sola subestimaría
    // el tráfico físico que #5800 quiere medir — por eso el invariante es «un
    // evento por DECISIÓN», no «un evento por resolución».
    assert.strictEqual(sink.contar(VAULT_TELEMETRY.PHYSICAL_READ), 2);
    assert.strictEqual(sink.eventos.length, 2);
    // Dos llamadas al transporte: una batch a SSM y una a Secrets Manager.
    assert.strictEqual(driver.calls.length, 2);
});

test('CA-20 · la segunda resolución del plan global es UN solo cache_hit, no dos', () => {
    // El corolario del invariante: el memo de credentials cubre el pedido
    // ENTERO (los dos backends), así que el hit es una sola decisión.
    resetVaultCacheAll();
    const driver = driverGlobal();
    const sink = sinkCaptor();
    const now = relojFake();
    const pedir = () => resolveVaultOnly('telegram.bot_token', {
        vaultConfig: cfgGlobal(), vaultDriver: driver, logger: () => {}, now, vaultSink: sink,
    });

    pedir();
    now.avanzar(1000);
    pedir();

    assert.strictEqual(sink.contar(VAULT_TELEMETRY.PHYSICAL_READ), 2, 'las dos de la primera pasada');
    assert.strictEqual(sink.contar(VAULT_TELEMETRY.CACHE_HIT), 1, 'un solo hit: el memo cubre el pedido entero');
    assert.strictEqual(driver.calls.length, 2, 'la segunda pasada no costó transporte');
});

// =============================================================================
// Canario de CONFIGURACIÓN extremo a extremo, por el camino global
// =============================================================================

test('el canario de configuración no aparece en los eventos del camino global', () => {
    resetVaultCacheAll();
    const driver = driverGlobal({ prefix: CANARIO_PREFIX, hostId: CANARIO_HOST });
    const sink = sinkCaptor();
    const valor = resolveVaultOnly('telegram.bot_token', {
        vaultConfig: cfgGlobal({ prefix: CANARIO_PREFIX, hostId: CANARIO_HOST }),
        vaultDriver: driver,
        logger: () => {},
        now: relojFake(),
        vaultSink: sink,
    });
    assert.strictEqual(valor, CANARIO_VALOR);

    assert.ok(sink.eventos.length > 0);
    const canal = JSON.stringify(sink.eventos);
    assert.ok(!canal.includes(CANARIO_PREFIX));
    assert.ok(!canal.includes(CANARIO_HOST));
    assert.ok(!canal.includes(CANARIO_VALOR));
    assert.ok(!canal.includes(PROYECTO));
    for (const scope of SCOPES_GLOBALES) assert.ok(!canal.includes(scope));
    for (const e of sink.eventos) {
        assert.deepEqual(Object.keys(e).sort(), ['category', 'ts_ms']);
    }
});

test('con el gate del vault cerrado no se emite un solo evento por el camino global', () => {
    resetVaultCacheAll();
    const sink = sinkCaptor();
    assert.throws(() => resolveVaultOnly('telegram.bot_token', {
        vaultConfig: cfg({ enabled: false }),
        logger: () => {},
        vaultSink: sink,
    }));
    assert.deepEqual(sink.eventos, [], 'sin resolución no hay nada que clasificar');
});
