// =============================================================================
// config-manifest-side.test.js — #5174 rev-1 · REQ-SEC-C2 / CA-8
// =============================================================================
//
// El rebote rev-1 encontró el agujero: `assertSide(productDoc, 'producto')` sólo
// miraba el slice `productConfig`, así que TODO el top-level del manifiesto
// entraba sin chequeo y sin traza. Dos consecuencias, las dos reproducidas:
//
//   1. `firma_operador: {enabled:false}` —lado autoridad— se aceptaba callado.
//   2. `repos.allowlist` —la frontera de ejecución de código, según el propio
//      `repo-target.js:13-14`— quedaba fuera de todo control del arranque.
//
// Y el `productConfigNote` del archivo afirmaba lo contrario de lo que el código
// hacía, que es el modo de falla que el issue prohíbe con todas las letras:
// «ignorar en silencio es indistinguible de un ataque exitoso desde el log».
//
// Este archivo FIJA las dos decisiones para que no se puedan revertir en silencio:
// la forma cerrada del manifiesto, y el alcance exacto de la excepción de
// migración de `repos.*`.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const resolver = require('../config-resolver');
const { AUTHORITY_PREFIXES } = require('../config-schema');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

const KERNEL_BASE = [
    'circuit_breaker:',
    '  infra_escalate_threshold: 3',
    '  auto_resume_ok_threshold: 2',
    'pipelines:',
    '  desarrollo:',
    '    fases: [dev]',
    '',
].join('\n');

const PRODUCTO_BASE = {
    pipelines: { desarrollo: { skills_por_fase: { dev: ['pipeline-dev'] } } },
};

// Bloque `repos` coherente, calcado del real: sirve de línea de base sana para
// que cada test mute UNA cosa y el rojo apunte a esa cosa.
const REPOS_SANO = Object.freeze({
    primary: 'intrale/platform',
    allowlist: ['intrale/platform', 'intrale/kernel'],
    intake: ['intrale/platform'],
});

/**
 * Siembra un sandbox con el manifiesto ESCRITO A MANO: `seedProductManifest`
 * emite sólo `{productConfig}` y acá lo que se ejercita es justamente el resto
 * del top-level.
 *
 * @param {string} nombre
 * @param {object} [topLevel] - claves del top-level del manifiesto.
 * @param {object} [slice] - contenido de `productConfig`.
 * @returns {string} pipelineDir del sandbox.
 */
function sembrar(nombre, topLevel = {}, slice = PRODUCTO_BASE) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `cfgmanifest-${nombre}-`));
    const pipelineDir = path.join(root, '.pipeline');
    fs.mkdirSync(pipelineDir, { recursive: true });
    fs.writeFileSync(path.join(pipelineDir, 'config.yaml'), KERNEL_BASE, 'utf8');
    fs.writeFileSync(
        resolver.productPathFor(pipelineDir),
        JSON.stringify({ ...topLevel, [resolver.PRODUCT_CONFIG_KEY]: slice }, null, 2),
        'utf8',
    );
    return pipelineDir;
}

/** Resuelve capturando la violación, o `null` si el arranque pasó. */
function violacionDe(pipelineDir) {
    resolver.clearCache();
    try {
        resolver.resolve({ pipelineDir, reload: true });
        return null;
    } catch (e) {
        assert.ok(resolver.isConfigViolation(e), `esperaba violación tipada, salió ${e && e.name}`);
        return e;
    }
}

const ENV_LIMPIO = ['PIPELINE_DIR_OVERRIDE', 'PIPELINE_STATE_DIR', 'PIPELINE_REPO_ROOT'];
let guardado = {};
let trazas = [];

test.beforeEach(() => {
    guardado = {};
    for (const k of ENV_LIMPIO) { guardado[k] = process.env[k]; delete process.env[k]; }
    trazas = [];
    resolver.clearCache();
    resolver._resetTraceState();
    resolver.setTraceSink((linea, nivel) => { trazas.push({ linea, nivel }); });
});

test.afterEach(() => {
    for (const k of ENV_LIMPIO) {
        if (guardado[k] === undefined) delete process.env[k];
        else process.env[k] = guardado[k];
    }
    resolver.clearCache();
});

test.after(() => { resolver.setTraceSink(null); });

// -----------------------------------------------------------------------------
// 1 · REQ-SEC-C2 — el top-level del manifiesto tiene forma CERRADA
// -----------------------------------------------------------------------------

test('REQ-SEC-C2 · una clave desconocida en el top-level del manifiesto rompe el arranque', () => {
    const e = violacionDe(sembrar('desconocida', { cualquier_cosa: { x: 1 } }));
    assert.ok(e, 'una clave fuera de la forma cerrada NO puede entrar en silencio');
    assert.match(e.message, /cualquier_cosa/, 'el mensaje tiene que nombrar la clave');
    assert.match(e.message, /\.pipeline\/config\.yaml/, 'y el archivo destino');
});

test('REQ-SEC-C2 · CADA clave de autoridad en el TOP-LEVEL del manifiesto rompe el arranque', () => {
    // El gemelo del test del slice (`config-resolver-authority.test.js`), por el
    // camino que rev-1 dejaba abierto. Se itera sobre la lista congelada para que
    // una clave de autoridad nueva quede cubierta el día que se agregue.
    assert.ok(AUTHORITY_PREFIXES.length >= 14, 'la lista congelada no puede venir vacía');

    for (const prefijo of AUTHORITY_PREFIXES) {
        const raiz = prefijo.split('.')[0];
        if (resolver.MANIFEST_KEYS.includes(raiz)) continue; // colisión de nombre: caso 3
        const e = violacionDe(sembrar('autoridad-top', { [raiz]: { enabled: false } }));
        assert.ok(e, `'${raiz}' en el top-level tiene que romper el arranque`);
        assert.match(e.message, new RegExp(raiz), `'${raiz}': el mensaje debe nombrar la clave`);
        // El destino SIEMPRE es el kernel, nunca el manifiesto: es la pieza
        // accionable del CA-4 y la que vale para las dos formas de prefijo.
        assert.match(e.message, /\.pipeline\/config\.yaml/,
            `'${raiz}': el mensaje debe nombrar el archivo destino`);
        // Para los prefijos de autoridad de PRIMER NIVEL el lado se nombra tal
        // cual. Los anidados (`architect.poll_cap_min`) tienen raíz de lado
        // kernel — mismo archivo destino, así que el operador no queda peor.
        if (!prefijo.includes('.')) {
            assert.match(e.message, /autoridad/, `'${raiz}': el mensaje debe nombrar el lado correcto`);
        }
    }
});

test('REQ-SEC-C2 · el rechazo del top-level nombra el MANIFIESTO, no el kernel', () => {
    const dir = sembrar('nombra-archivo', { firma_operador: { enabled: false } });
    const e = violacionDe(dir);
    assert.equal(e.archivo, resolver.productPathFor(dir),
        'el error nombra el archivo QUE FALLÓ');
});

test('REQ-SEC-C2 · el rechazo del top-level NO vuelca el valor crudo (SEC-2)', () => {
    const SECRETO = 'CHAT-ID-SECRETO-9988776655';
    const e = violacionDe(sembrar('sin-valor', { telegram_intruso: { chat_id: SECRETO } }));
    assert.ok(e);
    assert.ok(!e.message.includes(SECRETO),
        'el error viaja al log y a Telegram: nunca puede traer el valor del manifiesto');
});

test('REQ-SEC-C2 · el manifiesto REAL del repo pasa la forma cerrada', () => {
    // Guarda de paridad (CA-2): si alguien agrega una clave al manifiesto real y
    // no la enumera, este test es el que lo dice — no un arranque en producción.
    const real = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, resolver.PRODUCT_FILENAME), 'utf8'));
    const huerfanas = Object.keys(real).filter((k) => !resolver.MANIFEST_KEYS.includes(k));
    assert.deepEqual(huerfanas, [],
        'toda clave del manifiesto real tiene que estar enumerada en MANIFEST_KEYS');
});

// -----------------------------------------------------------------------------
// 2 · CA-8 — la decisión sobre `repos.*`, fijada
// -----------------------------------------------------------------------------
//
// DECISIÓN: `repos.primary` / `repos.allowlist` / `repos.intake` son lado
// AUTORIDAD (frontera de ejecución de código) y viven en el manifiesto por una
// EXCEPCIÓN DE MIGRACIÓN acotada, trazada y chequeada. El cierre —mudarlas al
// kernel— es de #4694. Los tests de acá abajo son lo que impide que la excepción
// se vuelva silenciosa o se ensanche sin que nadie se entere.

test('CA-8 · la excepción de `repos` está ACOTADA a las sub-claves enumeradas', () => {
    assert.deepEqual(
        [...resolver.REPOS_GRANDFATHERED_SUBKEYS].sort(),
        ['allowlist', 'default_base_ref', 'intake', 'note', 'primary'],
        'ensanchar la excepción tiene que ser una decisión explícita, no un descuido',
    );
    // Y el bloque real del repo no puede haberla desbordado.
    const real = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, resolver.PRODUCT_FILENAME), 'utf8'));
    const fuera = Object.keys(real[resolver.REPOS_AUTHORITY_KEY] || {})
        .filter((k) => !resolver.REPOS_GRANDFATHERED_SUBKEYS.includes(k));
    assert.deepEqual(fuera, [], 'el bloque real desbordó la excepción enumerada');
});

test('CA-8 · una sub-clave NUEVA bajo `repos` rompe el arranque', () => {
    const e = violacionDe(sembrar('subclave-nueva', {
        repos: { ...REPOS_SANO, exec_token_scope: 'write' },
    }));
    assert.ok(e, 'la excepción no puede crecer sola: lo no enumerado se rechaza');
    assert.match(e.message, /exec_token_scope/);
    assert.match(e.message, /autoridad/);
});

test('CA-8 · un repo de `intake` que no está en `allowlist` rompe el arranque', () => {
    const e = violacionDe(sembrar('intake-colgado', {
        repos: { ...REPOS_SANO, intake: ['intrale/platform', 'atacante/malicioso'] },
    }));
    assert.ok(e, 'no se consulta ningún repo que no esté allowlisted');
    assert.match(e.message, /intake/);
    assert.ok(!e.message.includes('atacante/malicioso'),
        'se nombra el índice, nunca el valor (SEC-2)');
});

test('CA-8 · un `primary` fuera de `allowlist` rompe el arranque', () => {
    const e = violacionDe(sembrar('primary-colgado', {
        repos: { ...REPOS_SANO, primary: 'atacante/malicioso' },
    }));
    assert.ok(e);
    assert.match(e.message, /primary/);
});

test('CA-8 · la excepción NO es silenciosa: se trazea con nivel alerta en el arranque', () => {
    const dir = sembrar('traza', { repos: { ...REPOS_SANO } });
    assert.equal(violacionDe(dir), null, 'un bloque `repos` coherente arranca');

    const alerta = trazas.find((t) => t.nivel === 'alerta' && /repos/.test(t.linea));
    assert.ok(alerta, 'sin traza, la excepción sería indistinguible de un descuido desde el log');
    assert.match(alerta.linea, /frontera de ejecución de código/);
    assert.match(alerta.linea, /#4694/, 'la traza nombra el issue que cierra la excepción');
});

test('CA-8 · el bloque real del repo satisface las invariantes de la frontera', () => {
    // La afirmación que el rebote pedía «verificada, no declarada»: hoy, sobre el
    // manifiesto de producción, `intake ⊆ allowlist` y `primary ∈ allowlist`.
    const real = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, resolver.PRODUCT_FILENAME), 'utf8'));
    const repos = real[resolver.REPOS_AUTHORITY_KEY] || {};
    const permitidos = new Set(repos.allowlist || []);
    for (const r of repos.intake || []) {
        assert.ok(permitidos.has(r), `intake '${r}' no está en allowlist`);
    }
    assert.ok(permitidos.has(repos.primary), `primary '${repos.primary}' no está en allowlist`);
});

// -----------------------------------------------------------------------------
// 3 · Lo que la forma cerrada NO puede hacer — dicho explícito
// -----------------------------------------------------------------------------

test('CA-8 · agregar un repo bien formado a `allowlist` NO lo detecta el arranque', () => {
    // Este test documenta el LÍMITE de la decisión, y existe para que nadie lea
    // los de arriba como «la allowlist está protegida». Ninguna validación de
    // config puede distinguir un repo legítimo de uno hostil: la allowlist es
    // una decisión, y su control es la revisión del cambio (+ la traza de
    // alerta de arriba, que la hace visible en cada arranque).
    const dir = sembrar('allowlist-ampliada', {
        repos: { ...REPOS_SANO, allowlist: [...REPOS_SANO.allowlist, 'atacante/malicioso'] },
    });
    assert.equal(violacionDe(dir), null,
        'si esto empieza a fallar, cambió la decisión de CA-8 y hay que actualizarla acá y en la doc');
});
