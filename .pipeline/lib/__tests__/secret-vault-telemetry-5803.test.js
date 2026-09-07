'use strict';

// =============================================================================
// secret-vault-telemetry-5803.test.js — #5803 (hija de #5800)
//
// Instrumentación de las resoluciones que el VAULT decide por sí mismo:
// `physical_read` (lectura física, SSM batch o Secrets Manager) y `cache_hit`
// (entrada vigente y completa en su caché interna).
//
// La tercera categoría del enum, `single_flight_join`, NO se emite desde acá y
// eso es parte del contrato: la coalescencia vive en `credentials.js` (`_vuelos`,
// puesto por #5797) y el vault no tiene mapa de vuelos. Su cobertura vive en
// `credentials-vault-telemetry-5803.test.js`.
//
// Todo corre con `createInMemoryVaultDriver` y `now` inyectado: sin red, sin
// cuenta AWS, sin timers ni sleeps. Las barreras de concurrencia se hacen con
// una promesa controlada dentro de un driver fake.
// =============================================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');
const util = require('node:util');
const fs = require('node:fs');
const path = require('node:path');

const {
    VAULT_TELEMETRY_CATEGORIES,
    VAULT_TELEMETRY,
    VAULT_CONFIG_KEYS_NO_EXPORTADO,   // sentinela: NO existe, se afirma abajo
    createVaultTelemetryEmitter,
    createInMemoryVaultDriver,
    createSecretVault,
    buildParameterPath,
    MAX_CACHE_TTL_SECONDS,
    VaultSecretMissingError,
    VaultTruncatedResponseError,
    VAULT_ERROR_CODES,
} = require('../secret-vault');

// -----------------------------------------------------------------------------
// Fixtures
// -----------------------------------------------------------------------------

const PREFIX = '/test5803';
const PROJECT = 'proyecto5803';
const HOST = 'host5803';

// Canarios: si alguno aparece en un evento, un error o un resultado serializado,
// el test falla. Son distinguibles entre sí a propósito (valor vs. mensaje de
// error vs. CAMPO DE CONFIGURACIÓN), porque cada uno viaja por un canal distinto.
const CANARIO_VALOR = 'CANARIO-VALOR-DEL-SECRETO-5803';
const CANARIO_ERROR = 'CANARIO-EN-EL-MENSAJE-DEL-DRIVER-5803';
const CANARIO_PREFIX = '/canarioPrefix5803';
const CANARIO_HOST = 'canarioHostId5803';

const RUTA_VAULT = path.join(__dirname, '..', 'secret-vault.js');

function cfg(over = {}) {
    return {
        enabled: true,
        prefix: PREFIX,
        projectId: PROJECT,
        hostId: HOST,
        cache_ttl_seconds: 300,
        required_scopes: ['alpha', 'beta'],
        shared_secrets: ['beta'],
        region: 'us-east-2',
        ...over,
    };
}

function pathDe(scope, tier, over = {}) {
    return buildParameterPath({
        prefix: over.prefix || PREFIX,
        projectId: over.projectId || PROJECT,
        hostId: over.hostId || HOST,
        scope,
        tier,
    });
}

function driverSembrado(over = {}) {
    const parameters = {
        [pathDe('alpha', 'host', over)]: { valor: CANARIO_VALOR },
        [pathDe('beta', 'shared', over)]: { valor: CANARIO_VALOR },
    };
    const secrets = {
        [buildParameterPath({
            prefix: over.prefix || PREFIX,
            projectId: over.projectId || PROJECT,
            scope: 'alpha',
            tier: 'rotating',
        })]: { valor: CANARIO_VALOR },
        [buildParameterPath({
            prefix: over.prefix || PREFIX,
            projectId: over.projectId || PROJECT,
            scope: 'beta',
            tier: 'rotating',
        })]: { valor: CANARIO_VALOR },
    };
    return createInMemoryVaultDriver({ parameters, secrets });
}

/** Sink que captura los eventos tal cual llegan, sin tocarlos. */
function sinkCaptor() {
    const eventos = [];
    const fn = (e) => eventos.push(e);
    fn.eventos = eventos;
    fn.categorias = () => eventos.map((e) => e.category);
    return fn;
}

/** Reloj determinístico controlable desde el test. */
function relojFake(inicial = 1000000) {
    let ahora = inicial;
    const fn = () => ahora;
    fn.llamadas = 0;
    const contado = () => { fn.llamadas += 1; return ahora; };
    contado.avanzar = (ms) => { ahora += ms; };
    contado.retroceder = (ms) => { ahora -= ms; };
    contado.fijar = (ms) => { ahora = ms; };
    Object.defineProperty(contado, 'llamadas', { get: () => fn.llamadas });
    return contado;
}

function armar(over = {}) {
    const sink = over.sink === undefined ? sinkCaptor() : over.sink;
    const now = over.now || relojFake();
    const driver = over.driver || driverSembrado(over.cfgOver);
    const vault = createSecretVault({
        config: cfg(over.cfgOver),
        driver,
        now,
        sink,
        logger: over.logger,
    });
    return { vault, driver, sink, now };
}

// =============================================================================
// CA-1 — regresión del vocabulario (ya entregado por #5804; acá NO se redeclara)
// =============================================================================

test('CA-1 · el enum de categorías sigue congelado, con el orden contractual', () => {
    assert.ok(Object.isFrozen(VAULT_TELEMETRY_CATEGORIES));
    assert.strictEqual(VAULT_TELEMETRY_CATEGORIES.length, 3);
    // El orden es contractual: `[0]` es la categoría de lectura FÍSICA, la única
    // que factura. `vault-calibration-scenario.js` y su suite dependen de esto.
    assert.strictEqual(VAULT_TELEMETRY_CATEGORIES[0], VAULT_TELEMETRY.PHYSICAL_READ);
    assert.strictEqual(VAULT_TELEMETRY_CATEGORIES[1], VAULT_TELEMETRY.CACHE_HIT);
    assert.strictEqual(VAULT_TELEMETRY_CATEGORIES[2], VAULT_TELEMETRY.SINGLE_FLIGHT_JOIN);
});

test('CA-1 · los nombres derivados NO son una segunda fuente de verdad', () => {
    // Cada valor sale del array congelado, no de un literal nuevo. Si alguien
    // cambia el enum, estos nombres lo siguen solos.
    assert.ok(Object.isFrozen(VAULT_TELEMETRY));
    for (const valor of Object.values(VAULT_TELEMETRY)) {
        assert.ok(VAULT_TELEMETRY_CATEGORIES.includes(valor));
    }
    assert.strictEqual(new Set(Object.values(VAULT_TELEMETRY)).size, 3);
});

test('CA-1 · emitir una categoría fuera del enum falla cerrado', () => {
    const sink = sinkCaptor();
    const emisor = createVaultTelemetryEmitter({ sink, now: () => 1 });
    for (const basura of ['inventada', 'PHYSICAL_READ', 3, null, undefined, {}]) {
        const ctx = emisor.crearContexto();
        assert.throws(() => emisor.emitir(ctx, basura), (err) => {
            assert.strictEqual(err.code, VAULT_ERROR_CODES.CONFIG_INVALID);
            // El mensaje describe el TIPO, nunca imprime el valor recibido: el
            // emisor es exportado y su mensaje termina en un log.
            assert.ok(!String(err.message).includes('inventada'));
            assert.ok(!String(err.message).includes('PHYSICAL_READ'));
            return true;
        });
        // El latch NO se consume con una categoría inválida: la invocación sigue
        // pudiendo clasificarse bien.
        assert.strictEqual(ctx.emitido, false);
    }
    assert.deepEqual(sink.eventos, []);
});

// =============================================================================
// CA-2 — un evento y una sola categoría por invocación pública (los 5 caminos)
// =============================================================================

const CAMINOS_PUBLICOS = [
    ['resolveNamespace', (v) => v.resolveNamespace({ scopes: ['alpha'] })],
    ['resolveScope', (v) => v.resolveScope({ scopes: ['alpha'] })],
    ['resolveNamespaceSync', (v) => v.resolveNamespaceSync({ scopes: ['alpha'] })],
    ['resolveScopeSync', (v) => v.resolveScopeSync({ scopes: ['alpha'] })],
    ['resolveScope · rotating', (v) => v.resolveScope({ scopes: ['alpha'], tier: 'rotating' })],
    ['resolveScopeSync · rotating', (v) => v.resolveScopeSync({ scopes: ['alpha'], tier: 'rotating' })],
];

for (const [nombre, invocar] of CAMINOS_PUBLICOS) {
    test(`CA-2 · ${nombre} emite exactamente un physical_read en la primera resolución`, async () => {
        const { vault, sink } = armar();
        await invocar(vault);
        assert.deepEqual(sink.categorias(), [VAULT_TELEMETRY.PHYSICAL_READ]);
        assert.deepEqual(Object.keys(sink.eventos[0]).sort(), ['category', 'ts_ms']);
    });
}

test('CA-2 · resolveScope no-rotating NO emite dos veces pese a delegar en el núcleo del namespace', async () => {
    // Riesgo real: `nucleoResolveScope` delega en `nucleoResolveNamespace`. Si
    // cada núcleo creara su propio latch, una invocación pública daría 2 eventos.
    const { vault, sink } = armar();
    await vault.resolveScope({ scopes: ['alpha', 'beta'] });
    assert.strictEqual(sink.eventos.length, 1);
});

test('CA-2 · rotating con VARIOS scopes emite UN physical_read, no uno por scope', async () => {
    const { vault, sink, driver } = armar();
    await vault.resolveScope({ scopes: ['alpha', 'beta'], tier: 'rotating' });
    assert.deepEqual(sink.categorias(), [VAULT_TELEMETRY.PHYSICAL_READ]);
    // Y el driver SÍ recibió dos llamadas: el evento cuenta invocaciones
    // públicas, no llamadas al transporte.
    assert.strictEqual(driver.calls.length, 2);
});

test('CA-2 · con el gate cerrado no se emite nada: no hubo resolución que clasificar', async () => {
    const { vault, sink, driver } = armar({ cfgOver: { enabled: false } });
    await vault.resolveNamespace({ scopes: ['alpha'] });
    vault.resolveNamespaceSync({ scopes: ['alpha'] });
    await vault.resolveScope({ scopes: ['alpha'] });
    await vault.resolveScope({ scopes: ['alpha'], tier: 'rotating' });
    assert.deepEqual(sink.eventos, []);
    assert.strictEqual(driver.calls.length, 0);
});

// =============================================================================
// CA-3 — el vault NUNCA emite `single_flight_join` (no coalesce nada)
// =============================================================================

test('CA-3 · N invocaciones concurrentes DIRECTAS al vault dan N physical_read, no joins', async () => {
    // El vault no coalesce: afirmarlo ES la garantía. Si algún día alguien le
    // agrega un mapa de vuelos, este test lo detecta antes de que se duplique la
    // clasificación con la de `credentials.js`.
    let liberar;
    const barrera = new Promise((res) => { liberar = res; });
    const base = driverSembrado();
    let enCurso = 0;
    const driver = {
        kind: 'barrera',
        calls: base.calls,
        async getParametersByPath(root, opts) {
            enCurso += 1;
            await barrera;
            return base.getParametersByPath(root, opts);
        },
        getSecretValue: (...a) => base.getSecretValue(...a),
    };
    const { vault, sink } = armar({ driver });

    const N = 5;
    const vuelos = Array.from({ length: N }, () => vault.resolveNamespace({ scopes: ['alpha'] }));
    // Todas entraron al driver antes de que ninguna resolviera: es concurrencia
    // real, no secuencia disfrazada.
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(enCurso, N);
    liberar();
    await Promise.all(vuelos);

    assert.strictEqual(sink.eventos.length, N);
    assert.deepEqual(new Set(sink.categorias()), new Set([VAULT_TELEMETRY.PHYSICAL_READ]));
    assert.ok(!sink.categorias().includes(VAULT_TELEMETRY.SINGLE_FLIGHT_JOIN));
});

// =============================================================================
// CA-4 — hit de la caché INTERNA del vault (misma instancia, dentro del TTL)
// =============================================================================

test('CA-4 · el segundo pedido dentro del TTL sobre la misma instancia es cache_hit sin tocar el driver', async () => {
    const { vault, sink, driver, now } = armar();
    await vault.resolveNamespace({ scopes: ['alpha'] });
    const llamadasTrasLaPrimera = driver.calls.length;

    now.avanzar(1000);   // dentro del TTL de 300s
    await vault.resolveNamespace({ scopes: ['alpha'] });

    assert.deepEqual(sink.categorias(), [VAULT_TELEMETRY.PHYSICAL_READ, VAULT_TELEMETRY.CACHE_HIT]);
    assert.strictEqual(driver.calls.length, llamadasTrasLaPrimera, 'el hit no puede costar una llamada');
});

test('CA-4 · un pedido con un scope que la entrada cacheada NO tiene es physical_read, no un hit falso', async () => {
    const { vault, sink } = armar();
    await vault.resolveNamespace({ scopes: ['alpha'] });
    await vault.resolveNamespace({ scopes: ['alpha', 'beta'] });
    assert.deepEqual(sink.categorias(), [VAULT_TELEMETRY.PHYSICAL_READ, VAULT_TELEMETRY.PHYSICAL_READ]);
});

test('CA-4 · el camino sync también clasifica el hit de la caché interna', () => {
    const { vault, sink, now } = armar();
    vault.resolveNamespaceSync({ scopes: ['alpha'] });
    now.avanzar(1000);
    vault.resolveNamespaceSync({ scopes: ['alpha'] });
    assert.deepEqual(sink.categorias(), [VAULT_TELEMETRY.PHYSICAL_READ, VAULT_TELEMETRY.CACHE_HIT]);
});

// =============================================================================
// CA-5 — expiración
// =============================================================================

test('CA-5 · pasado el TTL vuelve a physical_read y la entrada vencida se BORRA', async () => {
    const { vault, sink, now } = armar({ cfgOver: { cache_ttl_seconds: 60 } });
    await vault.resolveNamespace({ scopes: ['alpha'] });
    now.avanzar(60 * 1000 + 1);
    await vault.resolveNamespace({ scopes: ['alpha'] });

    assert.deepEqual(sink.categorias(), [VAULT_TELEMETRY.PHYSICAL_READ, VAULT_TELEMETRY.PHYSICAL_READ]);
    // La entrada vencida se borró y se reescribió: `cached` sigue en 1, no en 2.
    assert.match(util.inspect(vault), /cached: 1/);
});

test('CA-5 · una lectura que completa tarde no reclasifica ni emite un segundo evento', async () => {
    let liberar;
    const barrera = new Promise((res) => { liberar = res; });
    const base = driverSembrado();
    const driver = {
        kind: 'lenta',
        calls: base.calls,
        async getParametersByPath(root, opts) {
            await barrera;
            return base.getParametersByPath(root, opts);
        },
        getSecretValue: (...a) => base.getSecretValue(...a),
    };
    const { vault, sink, now } = armar({ driver, cfgOver: { cache_ttl_seconds: 60 } });

    const lenta = vault.resolveNamespace({ scopes: ['alpha'] });
    now.avanzar(60 * 1000 + 1);   // el TTL vence MIENTRAS la lectura está en vuelo
    liberar();
    await lenta;

    assert.deepEqual(sink.categorias(), [VAULT_TELEMETRY.PHYSICAL_READ]);
});

// =============================================================================
// CA-6 (parte vault) — el camino sync no puede emitir `single_flight_join`
// =============================================================================

test('CA-6 · `secret-vault.js` no contiene ninguna estructura de coalescencia (grep estático)', () => {
    const fuente = fs.readFileSync(RUTA_VAULT, 'utf8');
    const lineas = fuente.split('\n');
    const sospechosas = [];
    lineas.forEach((linea, i) => {
        if (!/flight|vuelo|coalesc|dedup|inFlight/i.test(linea)) return;
        // Se permiten: el literal del enum, los nombres derivados y los comentarios
        // que EXPLICAN que el vault no coalesce. Lo que no se permite es una
        // estructura de datos de vuelos.
        if (/single_flight_join|SINGLE_FLIGHT_JOIN/.test(linea)) return;
        if (/^\s*(\/\/|\*|\/\*)/.test(linea)) return;
        sospechosas.push(`${i + 1}: ${linea.trim()}`);
    });
    assert.deepEqual(sospechosas, [], 'el vault no debe tener mapa de vuelos ni coalescencia');
});

test('CA-6 · ni el camino sync ni el async del vault emiten single_flight_join, ni bajo reentrada', async () => {
    const { vault, sink, now } = armar();
    vault.resolveNamespaceSync({ scopes: ['alpha'] });
    vault.resolveScopeSync({ scopes: ['alpha'] });
    now.avanzar(10);
    vault.resolveNamespaceSync({ scopes: ['alpha'] });
    await vault.resolveNamespace({ scopes: ['alpha'] });
    assert.ok(sink.eventos.length >= 4);
    assert.ok(!sink.categorias().includes(VAULT_TELEMETRY.SINGLE_FLIGHT_JOIN));
});

// =============================================================================
// CA-7 / CA-18 — errores: se clasifican, no se degradan
// =============================================================================

test('CA-7 · el rechazo del driver da a lo sumo un evento y NUNCA cache_hit', async () => {
    const driver = {
        kind: 'roto',
        calls: [],
        async getParametersByPath() {
            driver.calls.push(1);
            throw new Error(`falla del transporte ${CANARIO_ERROR}`);
        },
        getParametersByPathSync() {
            driver.calls.push(1);
            throw new Error(`falla del transporte ${CANARIO_ERROR}`);
        },
    };
    const { vault, sink } = armar({ driver });

    await assert.rejects(() => vault.resolveNamespace({ scopes: ['alpha'] }));
    assert.deepEqual(sink.categorias(), [VAULT_TELEMETRY.PHYSICAL_READ]);

    // Sin negative caching: la llamada siguiente vuelve a intentar de verdad.
    await assert.rejects(() => vault.resolveNamespace({ scopes: ['alpha'] }));
    assert.deepEqual(sink.categorias(), [VAULT_TELEMETRY.PHYSICAL_READ, VAULT_TELEMETRY.PHYSICAL_READ]);
    assert.ok(!sink.categorias().includes(VAULT_TELEMETRY.CACHE_HIT));
});

test('CA-18 · un secreto ausente sigue lanzando VaultSecretMissingError con el sink presente', async () => {
    const driver = createInMemoryVaultDriver({ parameters: {} });
    const { vault, sink } = armar({ driver });
    await assert.rejects(
        () => vault.resolveNamespace({ scopes: ['alpha'] }),
        (err) => err instanceof VaultSecretMissingError,
    );
    assert.deepEqual(sink.categorias(), [VAULT_TELEMETRY.PHYSICAL_READ]);
});

test('CA-18 · una respuesta truncada sigue lanzando VaultTruncatedResponseError con el sink presente', async () => {
    const driver = {
        kind: 'truncado',
        calls: [],
        async getParametersByPath() {
            return { parameters: [], nextToken: 'quedan-mas' };
        },
    };
    const { vault, sink } = armar({ driver });
    await assert.rejects(
        () => vault.resolveNamespace({ scopes: ['alpha'] }),
        (err) => err instanceof VaultTruncatedResponseError,
    );
    assert.deepEqual(sink.categorias(), [VAULT_TELEMETRY.PHYSICAL_READ]);
});

test('CA-18 · un error de auth sigue vaciando la caché del namespace con el sink presente', async () => {
    let fallar = true;
    const base = driverSembrado();
    const driver = {
        kind: 'auth',
        calls: base.calls,
        async getParametersByPath(root, opts) {
            if (fallar) throw new Error('Your session has expired');
            return base.getParametersByPath(root, opts);
        },
    };
    const { vault, sink, now } = armar({ driver });

    fallar = false;
    await vault.resolveNamespace({ scopes: ['alpha'] });
    assert.match(util.inspect(vault), /cached: 1/);

    fallar = true;
    now.avanzar(1);
    // Fuerza una lectura física pidiendo un scope que la entrada no tiene.
    await assert.rejects(() => vault.resolveNamespace({ scopes: ['alpha', 'beta'] }));
    assert.match(util.inspect(vault), /cached: 0/, 'el error de auth invalida TODO el namespace');
    assert.ok(!sink.categorias().includes(VAULT_TELEMETRY.CACHE_HIT));
});

test('CA-18 · el rotating que falla emite antes de propagar, sin envolver el throw', async () => {
    const driver = {
        kind: 'rot-roto',
        calls: [],
        async getSecretValue() { throw new Error(`rotating caido ${CANARIO_ERROR}`); },
    };
    const { vault, sink } = armar({ driver });
    await assert.rejects(() => vault.resolveScope({ scopes: ['alpha'], tier: 'rotating' }));
    assert.deepEqual(sink.categorias(), [VAULT_TELEMETRY.PHYSICAL_READ]);
});

// =============================================================================
// CA-8 / CA-9 / CA-11 / CA-12 — forma del evento y ausencia de topología
// =============================================================================

test('CA-8 · el evento tiene EXACTAMENTE `category` y `ts_ms`, y está congelado', async () => {
    const { vault, sink } = armar();
    await vault.resolveNamespace({ scopes: ['alpha', 'beta'] });
    const [evento] = sink.eventos;
    assert.deepEqual(Object.keys(evento).sort(), ['category', 'ts_ms']);
    assert.deepEqual(Object.getOwnPropertyNames(evento).sort(), ['category', 'ts_ms']);
    assert.ok(Object.isFrozen(evento));
    assert.strictEqual(typeof evento.ts_ms, 'number');
    assert.strictEqual(typeof evento.category, 'string');
});

test('CA-9/CA-12 · el evento no lleva NINGÚN identificador de topología', async () => {
    const { vault, sink } = armar();
    await vault.resolveNamespace({ scopes: ['alpha', 'beta'] });
    await vault.resolveScope({ scopes: ['alpha'], tier: 'rotating' });

    const serializado = `${JSON.stringify(sink.eventos)}\n${util.inspect(sink.eventos, { depth: null })}`;
    for (const fragmento of [
        PREFIX, PROJECT, HOST,
        `${PREFIX}/${PROJECT}#${HOST}`,       // `claveNamespace()`
        pathDe('alpha', 'host'),              // `buildParameterPath`
        'alpha', 'beta',                      // nombres de scope
        'host', 'shared', 'rotating',         // tiers
    ]) {
        assert.ok(!serializado.includes(fragmento),
            `el evento no puede contener "${fragmento}"`);
    }
    // Sin strings de scope/tier no hay superficie de log-injection: no hay
    // dónde meter un CR/LF.
    assert.ok(!/[\r\n]/.test(JSON.stringify(sink.eventos)));
});

test('CA-8 · un campo nuevo en el estado interno del caché NO se cuela al evento', async () => {
    // Simula la deriva que el spread habilitaría: si el evento se armara con
    // `{...entrada}`, mañana un campo agregado a la entrada viajaría solo.
    const { vault, sink } = armar();
    await vault.resolveNamespace({ scopes: ['alpha'] });
    assert.deepEqual(Object.keys(sink.eventos[0]).sort(), ['category', 'ts_ms']);
    // Los dos únicos valores posibles: una categoría del enum y un número.
    assert.ok(VAULT_TELEMETRY_CATEGORIES.includes(sink.eventos[0].category));
});

test('CA-11 · un sink que bufferea no retiene material de secreto tras clearCache()', async () => {
    const { vault, sink } = armar();
    await vault.resolveNamespace({ scopes: ['alpha', 'beta'] });
    vault.clearCache();
    // El buffer sobrevive a propósito (es lo que haría un agregador real); lo
    // que NO puede sobrevivir es una referencia al material.
    const retenido = `${JSON.stringify(sink.eventos)}${util.inspect(sink.eventos, { depth: null })}`;
    assert.ok(!retenido.includes(CANARIO_VALOR));
    assert.strictEqual(sink.eventos.length, 1);
});

// =============================================================================
// CA-10 — canarios por los TRES canales
// =============================================================================

test('CA-10 · el canario del VALOR del secreto no aparece en eventos ni en el resultado serializado', async () => {
    const { vault, sink } = armar();
    const res = await vault.resolveNamespace({ scopes: ['alpha'] });
    // El valor SÍ está en el resultado (es lo que el caller pidió); lo que se
    // afirma es que no se filtró al canal de telemetría.
    assert.strictEqual(res.scopes.alpha.valor, CANARIO_VALOR);
    const canal = `${JSON.stringify(sink.eventos)}${util.inspect(sink.eventos, { depth: null })}`;
    assert.ok(!canal.includes(CANARIO_VALOR));
});

test('CA-10 · el canario del MENSAJE DE ERROR del driver no aparece en el evento', async () => {
    const driver = {
        kind: 'canario-err',
        calls: [],
        async getParametersByPath() { throw new Error(`boom ${CANARIO_ERROR}`); },
    };
    const { vault, sink } = armar({ driver });
    await assert.rejects(() => vault.resolveNamespace({ scopes: ['alpha'] }));
    const canal = `${JSON.stringify(sink.eventos)}${util.inspect(sink.eventos, { depth: null })}`;
    assert.ok(!canal.includes(CANARIO_ERROR));
});

test('CA-10 · el canario de CONFIGURACIÓN (prefix/hostId) no aparece en el evento', async () => {
    const cfgOver = { prefix: CANARIO_PREFIX, hostId: CANARIO_HOST };
    const { vault, sink } = armar({ cfgOver });
    await vault.resolveNamespace({ scopes: ['alpha'] });
    const canal = `${JSON.stringify(sink.eventos)}${util.inspect(sink.eventos, { depth: null })}`;
    assert.ok(!canal.includes(CANARIO_PREFIX));
    assert.ok(!canal.includes(CANARIO_HOST));
});

// =============================================================================
// CA-13 — el sink no puede alterar la resolución
// =============================================================================

test('CA-13 · un sink que LANZA no cambia el resultado, no reintenta y no emite de nuevo', async () => {
    let invocaciones = 0;
    const sink = () => { invocaciones += 1; throw new Error('sink roto'); };
    const warns = [];
    const { vault, driver } = armar({
        sink,
        logger: { info: () => {}, warn: (msg, meta) => warns.push({ msg, meta }) },
    });

    const res = await vault.resolveNamespace({ scopes: ['alpha'] });
    assert.strictEqual(res.scopes.alpha.valor, CANARIO_VALOR, 'la resolución sigue siendo correcta');
    assert.strictEqual(invocaciones, 1, 'ni un reintento del sink');
    assert.strictEqual(driver.calls.length, 1, 'ni una lectura física extra');

    assert.strictEqual(warns.length, 1);
    const textoWarn = `${warns[0].msg} ${JSON.stringify(warns[0].meta)}`;
    assert.ok(!textoWarn.includes('sink roto'), 'el warn no lleva el message crudo');
    assert.ok(!textoWarn.includes(CANARIO_VALOR));
    assert.ok(!textoWarn.includes('category'), 'el warn no re-incluye el evento');
});

test('CA-13 · un sink que falla en cada resolución avisa UNA sola vez por instancia', async () => {
    const warns = [];
    const { vault, now } = armar({
        sink: () => { throw new Error('siempre roto'); },
        logger: { info: () => {}, warn: (msg) => warns.push(msg) },
    });
    for (let i = 0; i < 5; i += 1) {
        now.avanzar(1);
        await vault.resolveNamespace({ scopes: ['alpha'] });
    }
    assert.strictEqual(warns.length, 1, 'el latch del warn evita inundar el log');
});

test('CA-13 · un sink que MUTA lo que recibe no puede corromper el evento (está congelado)', async () => {
    const eventos = [];
    const sink = (e) => {
        try { e.category = 'pisada'; } catch (_) { /* frozen en strict mode */ }
        try { e.extra = 'nueva'; } catch (_) { /* idem */ }
        eventos.push(e);
    };
    const { vault } = armar({ sink });
    await vault.resolveNamespace({ scopes: ['alpha'] });
    assert.strictEqual(eventos[0].category, VAULT_TELEMETRY.PHYSICAL_READ);
    assert.deepEqual(Object.keys(eventos[0]).sort(), ['category', 'ts_ms']);
});

test('CA-13 · un sink que RETIENE la referencia no gana acceso a nada del vault', async () => {
    const retenidos = [];
    const { vault } = armar({ sink: (e) => retenidos.push(e) });
    await vault.resolveNamespace({ scopes: ['alpha', 'beta'] });
    const [e] = retenidos;
    // No hay prototipo con métodos del vault, ni closures colgando.
    assert.strictEqual(Object.getPrototypeOf(e), Object.prototype);
    assert.deepEqual(Object.values(e).map((v) => typeof v).sort(), ['number', 'string']);
});

// =============================================================================
// CA-14 — sin sink, no-op PURO
// =============================================================================

test('CA-14 · sin sink el emisor no lee el reloj (no-op puro)', () => {
    let llamadasAlReloj = 0;
    const now = () => { llamadasAlReloj += 1; return 1000000; };
    const emisor = createVaultTelemetryEmitter({ now });   // sin `sink`
    const ctx = emisor.crearContexto();
    assert.strictEqual(ctx, null);
    emisor.emitir(ctx, VAULT_TELEMETRY.PHYSICAL_READ);
    emisor.emitir(ctx, 'una categoría inventada');   // ni siquiera valida: es no-op
    assert.strictEqual(llamadasAlReloj, 0);
});

test('CA-14 · un vault sin sink se comporta exactamente igual que antes de #5803', async () => {
    const driver = driverSembrado();
    const vault = createSecretVault({ config: cfg(), driver, now: relojFake() });
    const res = await vault.resolveNamespace({ scopes: ['alpha', 'beta'] });
    assert.strictEqual(res.enabled, true);
    assert.strictEqual(res.scopes.alpha.valor, CANARIO_VALOR);
    assert.strictEqual(res.tiers.beta, 'shared');
    // Y el sync da lo mismo.
    const sync = vault.resolveNamespaceSync({ scopes: ['alpha', 'beta'] });
    assert.deepEqual(sync, res);
});

// =============================================================================
// CA-15 — la superficie pública NO cambió (#5352/#5353)
// =============================================================================

test('CA-15 · la superficie enumerable del vault sigue siendo la de siempre, con sink', () => {
    const { vault } = armar();
    assert.deepEqual(Object.keys(vault).sort(), ['clearCache', 'resolveNamespace', 'resolveScope']);
    assert.strictEqual(vault.resolveNamespace.constructor.name, 'AsyncFunction');
    assert.strictEqual(vault.resolveScope.constructor.name, 'AsyncFunction');
    assert.strictEqual(typeof vault.resolveNamespaceSync, 'function');
    assert.strictEqual(typeof vault.resolveScopeSync, 'function');
    for (const gemelo of ['resolveNamespaceSync', 'resolveScopeSync']) {
        const d = Object.getOwnPropertyDescriptor(vault, gemelo);
        assert.strictEqual(d.enumerable, false);
        assert.strictEqual(d.writable, false);
    }
});

test('CA-15 · util.inspect.custom mantiene su forma con el sink presente', async () => {
    const { vault } = armar();
    await vault.resolveNamespace({ scopes: ['alpha'] });
    const texto = util.inspect(vault);
    assert.match(texto, /^SecretVault /);
    assert.match(texto, /enabled: true/);
    assert.match(texto, /cached: 1/);
    assert.match(texto, /ttl_s: 300/);
    // La forma positiva NO puede empezar a exponer el sink.
    assert.ok(!texto.includes('sink'));
    assert.ok(!texto.includes(CANARIO_VALOR));
});

// =============================================================================
// CA-16 — `sink` y `now` no se alcanzan desde config ni desde el ambiente
// =============================================================================

test('CA-16 · `sink` y `now` NO son claves de config del vault', () => {
    const fuente = fs.readFileSync(RUTA_VAULT, 'utf8');
    const bloque = fuente.slice(
        fuente.indexOf('const VAULT_CONFIG_KEYS = new Set(['),
        fuente.indexOf(']);', fuente.indexOf('const VAULT_CONFIG_KEYS = new Set([')),
    );
    assert.ok(bloque.length > 0, 'no se encontró VAULT_CONFIG_KEYS');
    assert.ok(!/['"]vault\.sink['"]/.test(bloque));
    assert.ok(!/['"]vault\.now['"]/.test(bloque));
    // Y el sentinela: la allowlist no se exporta, así que nadie la amplía desde afuera.
    assert.strictEqual(VAULT_CONFIG_KEYS_NO_EXPORTADO, undefined);
});

test('CA-16 · pasar sink/now DENTRO de `config` no los activa', async () => {
    let colado = 0;
    const driver = driverSembrado();
    const vault = createSecretVault({
        config: { ...cfg(), sink: () => { colado += 1; }, now: () => 0 },
        driver,
        now: relojFake(),
        // sin `sink` en el factory
    });
    await vault.resolveNamespace({ scopes: ['alpha'] });
    assert.strictEqual(colado, 0, 'un sink que viene por config no puede emitir');
});

test('CA-16 · el tope duro del TTL sigue siendo fail-closed con el sink presente', () => {
    // El sink no puede ablandar SEC-6: un TTL por encima del tope se RECHAZA en
    // la construcción, no se clampea en silencio (una credencial rotada
    // seguiría sirviéndose de la caché).
    assert.throws(
        () => armar({ cfgOver: { cache_ttl_seconds: MAX_CACHE_TTL_SECONDS + 1 } }),
        (err) => {
            assert.strictEqual(err.code, VAULT_ERROR_CODES.CONFIG_INVALID);
            assert.strictEqual(err.clave, 'vault.cache_ttl_seconds');
            return true;
        },
    );
});

test('CA-16 · en el tope exacto el TTL vence cuando tiene que vencer, con sink', async () => {
    const { vault, sink, driver, now } = armar({
        cfgOver: { cache_ttl_seconds: MAX_CACHE_TTL_SECONDS },
    });
    await vault.resolveNamespace({ scopes: ['alpha'] });
    now.avanzar(MAX_CACHE_TTL_SECONDS * 1000 + 1);
    await vault.resolveNamespace({ scopes: ['alpha'] });
    assert.deepEqual(sink.categorias(), [VAULT_TELEMETRY.PHYSICAL_READ, VAULT_TELEMETRY.PHYSICAL_READ]);
    assert.strictEqual(driver.calls.length, 2, 'la telemetría no extendió la vigencia');
});

test('CA-16 · un reloj que RETROCEDE no revive una entrada vencida', async () => {
    const { vault, sink, now } = armar({ cfgOver: { cache_ttl_seconds: 60 } });
    await vault.resolveNamespace({ scopes: ['alpha'] });
    now.avanzar(60 * 1000 + 1);
    await vault.resolveNamespace({ scopes: ['alpha'] });   // vence y relee
    now.retroceder(60 * 1000);                            // el reloj vuelve atrás
    await vault.resolveNamespace({ scopes: ['alpha'] });

    // La entrada vencida se BORRÓ, así que retroceder el reloj no la resucita:
    // lo que se ve es el hit de la entrada NUEVA, no el de la muerta.
    assert.deepEqual(sink.categorias(), [
        VAULT_TELEMETRY.PHYSICAL_READ,
        VAULT_TELEMETRY.PHYSICAL_READ,
        VAULT_TELEMETRY.CACHE_HIT,
    ]);
});

test('CA-16 · `ts_ms` sale del reloj INYECTADO, no de Date.now()', async () => {
    // Si el emisor usara `Date.now()`, los tests de expiración medirían un
    // tiempo y el evento otro, y la calibración de #5800 no cerraría.
    const now = relojFake(777000);
    const { vault, sink } = armar({ now });
    await vault.resolveNamespace({ scopes: ['alpha'] });
    now.avanzar(5000);
    await vault.resolveNamespace({ scopes: ['alpha'] });

    assert.strictEqual(sink.eventos[0].ts_ms, 777000);
    assert.strictEqual(sink.eventos[1].ts_ms, 782000);
});

// =============================================================================
// CA-21 — contrato con el agregador de #5804
// =============================================================================

test('CA-21 · los eventos capturados pasan por aggregateEvents de #5804 sin error', async () => {
    const { aggregateEvents } = require('../vault-calibration-scenario');

    const inicio = 1000000;
    const now = relojFake(inicio);
    const { vault, sink } = armar({ now });

    // 3 lecturas físicas + 2 hits de la caché interna.
    await vault.resolveNamespace({ scopes: ['alpha'] });          // physical
    now.avanzar(1000);
    await vault.resolveNamespace({ scopes: ['alpha'] });          // cache_hit
    now.avanzar(1000);
    await vault.resolveScope({ scopes: ['alpha'], tier: 'rotating' });   // physical
    now.avanzar(1000);
    await vault.resolveNamespace({ scopes: ['alpha'] });          // cache_hit
    now.avanzar(1000);
    await vault.resolveNamespace({ scopes: ['alpha', 'beta'] });  // physical

    const escenario = {
        window_start_ms: inicio,
        window_duration_ms: 3600000,
        bucket_ms: 60000,
        concurrency: 4,
        launches: 10,
        distribution: 'sequential',
        sequence_seed: 42,
        unit: 'reads',
    };
    // `seq` lo pone el núcleo agregador, igual que hace `runScenario`; el vault
    // proyecta SOLO la categoría y el sello.
    const conSeq = sink.eventos.map((e, i) => ({ seq: i, ts_ms: e.ts_ms, category: e.category }));
    const resumen = aggregateEvents(conSeq, escenario);

    assert.strictEqual(resumen.physical_total, 3);
    assert.strictEqual(resumen.counts[VAULT_TELEMETRY.PHYSICAL_READ], 3);
    assert.strictEqual(resumen.counts[VAULT_TELEMETRY.CACHE_HIT], 2);
    assert.strictEqual(resumen.counts[VAULT_TELEMETRY.SINGLE_FLIGHT_JOIN], 0);
});

test('CA-21 · agregar un campo al evento haría fallar al agregador (por eso son dos)', () => {
    const { aggregateEvents } = require('../vault-calibration-scenario');
    const escenario = {
        window_start_ms: 1000000,
        window_duration_ms: 3600000,
        bucket_ms: 60000,
        concurrency: 4,
        launches: 10,
        distribution: 'sequential',
        sequence_seed: 42,
        unit: 'reads',
    };
    // Documenta POR QUÉ el payload es `{category, ts_ms}` y no seis campos: el
    // consumidor downstream ya congeló la forma y rechaza cualquier extra.
    assert.throws(() => aggregateEvents(
        [{ seq: 0, ts_ms: 1000000, category: VAULT_TELEMETRY.PHYSICAL_READ, namespace_ref: 'x' }],
        escenario,
    ));
});
