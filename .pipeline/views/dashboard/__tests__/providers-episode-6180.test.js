// =============================================================================
// providers-episode-6180.test.js — Indicador PERMANENTE de motor en /providers.
//
// Parte 2 del split de #6151. La parte 1 (#6179) dejó la política de emisión y
// `readEpisode()`; acá se verifica la capa de presentación: que el operador
// pueda contestar "¿con qué motor estoy corriendo?, ¿desde cuándo?, ¿por qué no
// está el principal?" mirando el dashboard.
//
// Suite propia y NO ampliación de `providers.test.js` (351 líneas, cubre
// #4201/#5888): mismo criterio que `desync-block-banner-5724.test.js`.
//
// Qué protege cada bloque
// -----------------------
//   CA-1  los tres ejes visibles (motor · desde cuándo · motivo) en respaldo.
//   CA-2  el panel se alimenta de `readEpisode()`, no de un parseo propio.
//   CA-3  estado ausente / corrupto / módulo ausente → no lanza, el resto de
//         `/providers` sigue rindiendo.
//   CA-4  SEC-3: cero ids crudos, cero secretos (lista CENTRALIZADA).
//   CA-5  todo valor dinámico escapado / fuera-de-enum jamás llega al HTML.
//   CA-6  castellano de operador, sin identificadores crudos.
//   UX-3  las 4 causas + `null` rinden SU texto, distinto entre sí.
//   UX-3-bis los 3 escalones rinden título y descripción distintos.
//   UX-4  `since` inválido NO se muestra como "ahora".
//   UX-7  anti-deriva: los textos salen de `copy.json`, no de literales.
//
// El modo de falla que esta suite existe para atrapar es MUDO: si el contrato
// del episodio se lee mal, el colector degrada fail-closed y el panel dice
// "estado no disponible" el 100 % de las veces — con la suite en verde si los
// tests sólo comprobaran "hay panel". Por eso cada aserción es sobre el TEXTO
// esperado, no sobre la existencia del markup.
//
// El stub de `readEpisode()` se hace mutando el método del módulo compartido
// por require.cache: `providers.js` lo requiere ADENTRO de la función, así que
// ve la mutación. Misma técnica que `providers.test.js` con `secrets-rw`.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

// SEC-P2-6 — `require` en el TOPE y SIN try/catch. Con `try { require } catch
// { return }` el assert anti-fuga se auto-apaga el día que el helper se mueve:
// la suite queda verde sobre un control que ya no corre. Si falta, tiene que
// romper acá.
const { assertCopyLimpio } = require('../../../lib/__tests__/helpers/forbidden-copy-patterns.js');

const PROVIDERS_PATH = path.resolve(__dirname, '..', 'providers.js');
const EPISODE_PATH = path.resolve(__dirname, '..', '..', '..', 'lib', 'fallback-episode-state.js');
const COPY_PATH = path.resolve(__dirname, '..', '..', '..', 'assets', 'copy', 'fallback-episode', 'copy.json');
const ROUTES_PATH = path.resolve(__dirname, '..', '..', '..', 'lib', 'dashboard-routes.js');
const SECRETS_PATH = path.resolve(__dirname, '..', '..', '..', 'lib', 'multi-provider', 'secrets-rw.js');

const providers = require(PROVIDERS_PATH);
const episodeState = require(EPISODE_PATH);
const COPY = require(COPY_PATH);
const secrets = require(SECRETS_PATH);

const ORIGINAL_READ_EPISODE = episodeState.readEpisode;
const ORIGINAL_LIST_KEYS = secrets.listKeys;

const HORA = 3600 * 1000;
const XSS = '"><img src=x onerror=alert(1)>';

function setEpisode(episode, reason) {
    episodeState.readEpisode = () => ({ episode, reason: reason || null, file: '(stub)' });
}
function setReadEpisodeImpl(fn) { episodeState.readEpisode = fn; }
function restoreEpisode() { episodeState.readEpisode = ORIGINAL_READ_EPISODE; }

/** Episodio válido según `isValidEpisode` de la parte 1. */
function fakeEpisode(over) {
    const o = over || {};
    const now = Date.now();
    return {
        version: 1,
        mode: o.mode !== undefined ? o.mode : 'respaldo',
        tier: o.tier !== undefined ? o.tier : 'respaldo_pago',
        cause: o.cause !== undefined ? o.cause : 'cuota',
        since: o.since !== undefined ? o.since : now - 3 * HORA,
        lastNotifiedAt: now,
        evento: 'entra_respaldo',
        heartbeatMs: 6 * HORA,
    };
}

/** Panel renderizado atravesando el colector real (CA-2). */
function panel(episode, reason, now) {
    setEpisode(episode, reason);
    try {
        const ref = Number.isFinite(now) ? now : Date.now();
        return providers.renderEngineIndicator(providers.collectFallbackEpisode(), ref);
    } finally {
        restoreEpisode();
    }
}

// ───────────────────────── CA-1 · respaldo activo ─────────────────────────

test('CA-1 · episodio de respaldo activo muestra motor, desde cuándo y motivo', () => {
    const html = panel(fakeEpisode({ tier: 'respaldo_pago', cause: 'cuota' }));

    assert.ok(html.includes('prov-engine'), 'el panel se monta');
    assert.ok(html.includes('is-fallback'), 'variante de respaldo');
    assert.ok(html.includes('RESPALDO'), 'la placa dice que hay un respaldo en curso');
    assert.ok(html.includes('MOTOR EN USO'), 'eje 1 · con qué motor corre');
    assert.ok(html.includes('DESDE CUÁNDO'), 'eje 2 · desde cuándo');
    assert.ok(html.includes('MOTIVO'), 'eje 3 · por qué no está el principal');
    assert.ok(html.includes('hace 3 h'), 'el "desde cuándo" se rinde relativo');
    assert.ok(html.includes(COPY.motivos.cuota), 'el motivo sale del copy canónico');
    assert.ok(html.includes(COPY.titulares.sostenido.respaldo_pago), 'titular de estado SOSTENIDO');
});

test('CA-2 · el panel se alimenta de readEpisode(), no de un parseo propio', () => {
    let llamado = 0;
    setReadEpisodeImpl(() => {
        llamado += 1;
        return { episode: fakeEpisode({ cause: 'reposo' }), reason: null, file: '(stub)' };
    });
    try {
        const modelo = providers.collectFallbackEpisode();
        assert.equal(llamado, 1, 'el colector llama exactamente una vez a readEpisode()');
        assert.equal(modelo.mode, 'fallback');
        assert.equal(modelo.cause, 'reposo');
    } finally {
        restoreEpisode();
    }
});

// ───────────────── UX-3 · las 4 causas + null, cada una con SU texto ─────────────────

test('UX-3 · cada uno de los 4 cause (más null) rinde su copy esperado y distinto', () => {
    // `disponible` NO entra: `CAUSES` de la parte 1 tiene cuatro entradas y el
    // validador de shape rechaza cualquier otra. La quinta clave del copy es
    // `desconocida`, que es lo que rinde `cause: null` (CA-12 de #6179).
    const casos = [
        ['reposo', COPY.motivos.reposo],
        ['cuota', COPY.motivos.cuota],
        ['transitoria', COPY.motivos.transitoria],
        ['auth', COPY.motivos.auth],
        [null, COPY.motivos.desconocida],
    ];
    const vistos = new Set();
    for (const [cause, esperado] of casos) {
        const html = panel(fakeEpisode({ cause }));
        assert.ok(
            html.includes(esperado),
            `cause=${String(cause)} debe rendir "${esperado}"`,
        );
        vistos.add(esperado);
        // El defecto histórico: TODAS las causas cayendo al default y nadie
        // notándolo porque "hay texto en castellano".
        if (cause !== null) {
            assert.ok(
                !html.includes(COPY.motivos.desconocida),
                `cause=${cause} NO puede caer al motivo por defecto`,
            );
        }
    }
    assert.equal(vistos.size, 5, 'los cinco textos son distintos entre sí');
});

test('UX-3-bis · los 3 escalones rinden título y descripción distintos', () => {
    const tiers = ['respaldo_pago', 'gratuito_con_herramientas', 'gratuito_sin_herramientas'];
    const titulos = new Set();
    const descs = new Set();
    for (const tier of tiers) {
        const html = panel(fakeEpisode({ tier }));
        assert.ok(html.includes(COPY.titulares.sostenido[tier]), `titular de ${tier}`);
        assert.ok(html.includes(COPY.consecuencias[tier]), `consecuencia de ${tier}`);
        titulos.add(COPY.titulares.sostenido[tier]);
        descs.add(COPY.consecuencias[tier]);
    }
    assert.equal(titulos.size, 3, 'tres titulares distintos');
    assert.equal(descs.size, 3, 'tres consecuencias distintas');

    // El escalón que cambia lo que el operador puede esperar: un panel que
    // dijera sólo "corriendo con un motor de respaldo" mientras el trabajo está
    // parado informa tranquilidad donde hay bloqueo.
    const sinTools = panel(fakeEpisode({ tier: 'gratuito_sin_herramientas' }));
    assert.ok(
        /no editan archivos ni corren tests/.test(sinTools),
        'el escalón sin herramientas advierte que el trabajo queda parado',
    );
});

// ───────────────────────── Escenario 2 · primario ─────────────────────────

test('CA-1 · en primario el panel no sugiere degradación alguna', () => {
    const html = panel(fakeEpisode({ mode: 'primario', tier: null, cause: null }));

    assert.ok(html.includes('is-primary'), 'variante de principal');
    assert.ok(html.includes('El pipeline está corriendo con el motor principal'));
    assert.ok(html.includes('TODO NORMAL'));
    assert.ok(html.includes('SITUACIÓN'), 'el campo 3 es SITUACIÓN, no un motivo');
    assert.ok(!html.includes('MOTIVO'), 'en primario no hay motivo que mostrar');
    assert.ok(!html.includes('is-fallback') && !html.includes('is-unknown'));

    // UX-2 — ningún texto de la tabla de motivos.
    for (const motivo of Object.values(COPY.motivos)) {
        assert.ok(!html.includes(motivo), `no puede aparecer el motivo "${motivo}"`);
    }
    // Las ÚNICAS menciones de "respaldo" son las dos negaciones del contrato de
    // copy: la placa `SIN RESPALDO ACTIVO` y la descripción "No hay ningún
    // respaldo activo.". Ninguna afirma un respaldo en curso.
    const menciones = html.match(/respaldo/gi) || [];
    assert.equal(menciones.length, 2, 'sólo las dos negaciones del contrato');
    assert.ok(html.includes('SIN RESPALDO ACTIVO'));
    assert.ok(html.includes('No hay ningún respaldo activo.'));
});

// ───────────────── CA-3 · degradación sin tumbar la vista ─────────────────

test('CA-3 · estado ausente o corrupto no lanza y el resto de la vista se renderiza', () => {
    for (const reason of ['ausente', 'ilegible', 'shape_invalido']) {
        setEpisode(null, reason);
        try {
            const modelo = providers.collectFallbackEpisode();
            assert.equal(modelo.mode, 'unavailable', `reason=${reason} → sin dato`);
            assert.equal(modelo.unknownReason, reason, 'el reason del lector viaja al modelo');

            const html = providers.bodyHtml(providers.buildProvidersModel(), Date.now());
            assert.ok(html.includes('ESTADO NO DISPONIBLE'), 'el indicador informa que no hay dato');
            assert.ok(html.includes('id="providers-list"'), 'la lista de proveedores sigue');
            assert.ok(html.includes('Por agente'), 'la franja «Por agente» sigue');
            assert.ok(html.includes('id="prov-mission"'), 'el banner de misión sigue');
        } finally {
            restoreEpisode();
        }
    }
});

test('CA-3 · readEpisode() que lanza degrada el panel sin romper /providers', () => {
    setReadEpisodeImpl(() => { throw new Error('estado ilegible'); });
    try {
        assert.doesNotThrow(() => providers.collectFallbackEpisode());
        assert.equal(providers.collectFallbackEpisode().mode, 'unavailable');
        const html = providers.bodyHtml(providers.buildProvidersModel(), Date.now());
        assert.ok(html.includes('ESTADO NO DISPONIBLE'));
        assert.ok(html.includes('id="providers-list"'));
    } finally {
        restoreEpisode();
    }
});

test('CA-3 · módulo fallback-episode-state ausente degrada sin tumbar la vista', () => {
    // El `require` del módulo de la parte 1 vive ADENTRO del try del colector,
    // no en el tope del archivo. Si estuviera en el tope, un árbol sin ese
    // módulo tumbaría TODO providers.js al cargarse, no sólo este panel.
    const origLoad = Module._load;
    Module._load = function (request) {
        if (String(request).includes('fallback-episode-state')) {
            const e = new Error("Cannot find module '../../lib/fallback-episode-state.js'");
            e.code = 'MODULE_NOT_FOUND';
            throw e;
        }
        return origLoad.apply(this, arguments);
    };
    try {
        assert.doesNotThrow(() => providers.collectFallbackEpisode());
        assert.equal(providers.collectFallbackEpisode().mode, 'unavailable');
        const html = providers.bodyHtml(providers.buildProvidersModel(), Date.now());
        assert.ok(html.includes('ESTADO NO DISPONIBLE'), 'panel degradado');
        assert.ok(html.includes('id="providers-list"'), 'el resto de la vista intacto');
    } finally {
        Module._load = origLoad;
    }
});

test('SEC-P2-2 · cause="__proto__" no lanza y cae al copy por defecto', () => {
    let html;
    assert.doesNotThrow(() => { html = panel(fakeEpisode({ cause: '__proto__' })); });
    assert.ok(html.includes(COPY.motivos.desconocida), 'cae al motivo por defecto');
    assert.ok(!/__proto__/.test(html), 'no filtra la clave cruda');
    assert.ok(!/function Object\(\)/.test(html), 'no imprime nada del prototipo');

    // Mismo control sobre `tier`, que también es clave de lookup.
    let html2;
    assert.doesNotThrow(() => { html2 = panel(fakeEpisode({ tier: 'constructor' })); });
    assert.ok(!/function Object\(\)/.test(html2));
    assert.ok(html2.includes(COPY.titulares.sostenido.gratuito_sin_herramientas),
        'un escalón fuera del enum se describe como el MÁS degradado, nunca de menos');
});

// ───────────────── UX-4 · `since` inválido no se lee como "ahora" ─────────────────

test('UX-4 · since futuro, NaN o no parseable cae a estado no disponible', () => {
    const now = Date.now();
    const invalidos = [
        ['futuro', () => fakeEpisode({ since: now + 5 * 60 * 1000 })],
        ['NaN', () => fakeEpisode({ since: Number.NaN })],
        ['cero', () => fakeEpisode({ since: 0 })],
        ['negativo', () => fakeEpisode({ since: -1 })],
        // Una fecha ISO es el desvío MÁS probable: `since` es epoch numérico y
        // el pseudocódigo de la definición asumía string.
        ['string ISO', () => fakeEpisode({ since: new Date(now - HORA).toISOString() })],
        ['ausente', () => { const ep = fakeEpisode(); delete ep.since; return ep; }],
    ];
    for (const [label, build] of invalidos) {
        const html = panel(build(), null, now);
        assert.ok(html.includes('is-unknown'), `since ${label} → estado sin datos`);
        // El modo de falla REAL: `relativeTime` clampea las diferencias
        // negativas y devuelve "ahora", así que un episodio viejo o corrupto se
        // vería como recién iniciado. Eso PARECE normal, y es lo peor.
        assert.ok(!/>ahora</.test(html), `since ${label} no puede rendirse como "ahora"`);
        assert.ok(!/<div class="prov-wm-v"[^>]*><\/div>/.test(html), 'ningún campo vacío');
    }
});

test('UX-4 · el render revalida `since` aunque le pasen un modelo armado a mano', () => {
    const now = Date.now();
    const html = providers.renderEngineIndicator(
        { mode: 'fallback', tier: 'respaldo_pago', cause: 'cuota', since: now + 10 * 60 * 1000 },
        now,
    );
    assert.ok(html.includes('is-unknown'), 'segunda barrera sobre since');
    assert.ok(!/>ahora</.test(html));
});

// ───────────────── SEC-P2-3 · los tres estados se distinguen ─────────────────

test('SEC-P2-3 · los tres estados son visualmente distinguibles', () => {
    const now = Date.now();
    const a = panel(fakeEpisode({ mode: 'primario', tier: null, cause: null }), null, now);
    const b = panel(fakeEpisode({ mode: 'respaldo' }), null, now);
    const c = panel(null, 'ausente', now);

    // Señal 1 — clase de variante (color).
    assert.ok(a.includes('is-primary') && !a.includes('is-fallback') && !a.includes('is-unknown'));
    assert.ok(b.includes('is-fallback') && !b.includes('is-primary') && !b.includes('is-unknown'));
    assert.ok(c.includes('is-unknown') && !c.includes('is-primary') && !c.includes('is-fallback'));

    // Señal 2 — glifo de la placa. El color NUNCA es el único portador del
    // estado (WCAG 1.4.1): en escala de grises los tres siguen distinguiéndose.
    assert.ok(a.includes('>✓<') && b.includes('>⚠<') && c.includes('>?<'));

    // Señal 3 — texto de placa y chip.
    assert.ok(a.includes('PRINCIPAL') && a.includes('TODO NORMAL'));
    assert.ok(b.includes('RESPALDO') && b.includes('FUNCIONANDO CON RESPALDO'));
    assert.ok(c.includes('SIN DATOS') && c.includes('ESTADO NO DISPONIBLE'));

    assert.notEqual(a, b);
    assert.notEqual(b, c);
    assert.notEqual(a, c);
});

test('A11Y · el panel es una región con nombre accesible y el glifo es decorativo', () => {
    const html = panel(fakeEpisode());
    assert.ok(html.includes('role="region"'));
    assert.ok(html.includes('aria-label="Motor con el que está corriendo el pipeline"'));
    assert.ok(/prov-btag-n" aria-hidden="true"/.test(html), 'el glifo no se lee dos veces');
    assert.ok(!/ on[a-z]+=/.test(html), 'sin handlers inline (CSP-friendly)');
});

// ───────────────── CA-4 / SEC-3 · anti-fuga y anti-jerga ─────────────────

test('CA-4 · el HTML del panel no filtra ids crudos ni secretos, en ningún estado', () => {
    // Alcance deliberado: el PANEL. El resto de `/providers` es la consola de
    // proveedores y nombra proveedores por diseño; lo que este issue introduce
    // es este payload, y es el que no puede llevar ids ni secretos (SEC-3).
    const casos = [];
    for (const cause of ['reposo', 'cuota', 'transitoria', 'auth', null]) {
        for (const tier of ['respaldo_pago', 'gratuito_con_herramientas', 'gratuito_sin_herramientas']) {
            casos.push(panel(fakeEpisode({ tier, cause })));
        }
    }
    casos.push(panel(fakeEpisode({ mode: 'primario', tier: null, cause: null })));
    casos.push(panel(null, 'ausente'));
    casos.push(panel(null, 'ilegible'));

    for (const html of casos) {
        assertCopyLimpio(assert, html, 'panel de motor de /providers');
        assert.ok(!/anthropic|openai|codex|cerebras|gemini|nvidia|kimi|moonshot|groq/i.test(html),
            'ningún id ni nombre de proveedor');
        assert.ok(!/state\/fallback-episode\.json/.test(html),
            'ninguna ruta del archivo de estado');
        assert.ok(!/\btier\b|\bcause\b|\bepisode\b|\bprovider\b/i.test(html),
            'ningún identificador crudo del payload en el texto visible');
    }
});

test('CA-5 · un valor fuera del enum jamás llega al HTML (tier y cause)', () => {
    const html = panel(fakeEpisode({ tier: XSS, cause: XSS }));
    assert.ok(!html.includes('<img'), 'nada de markup inyectado');
    assert.ok(!html.includes('onerror'), 'nada de handlers inyectados');
    assert.ok(!html.includes('alert(1)'), 'el payload crudo no aparece');
    // El valor no se escapa: directamente NO se imprime. `tier` y `cause` son
    // SÓLO claves de lookup; lo que se rinde es el literal del copy.
    assert.ok(html.includes(COPY.motivos.desconocida));
    assert.ok(html.includes(COPY.titulares.sostenido.gratuito_sin_herramientas));

    // Y el mismo control sobre el `mode`, que decide la variante.
    const html2 = panel(fakeEpisode({ mode: XSS }));
    assert.ok(html2.includes('is-unknown'), 'un mode desconocido cae a "sin datos"');
    assert.ok(!html2.includes('<img'));
});

// ───────────────── UX-7 · anti-deriva contra copy.json ─────────────────

test('UX-7 · los textos del panel salen de copy.json, no de literales inlineados', () => {
    // Sin este control, la divergencia palabra-por-palabra entre el dashboard y
    // el aviso de Telegram —que ya pasó una vez en este mismo issue— vuelve al
    // primer retoque de copy, y nadie se entera hasta que el operador lee dos
    // cosas distintas del mismo hecho en el mismo minuto.
    const fuente = fs.readFileSync(PROVIDERS_PATH, 'utf8');
    const canonicos = [
        ...Object.values(COPY.motivos),
        ...Object.values(COPY.titulares.sostenido),
        ...Object.values(COPY.consecuencias),
    ];
    for (const texto of canonicos) {
        assert.ok(
            !fuente.includes(texto),
            `providers.js no puede inlinear el copy canónico: "${texto}"`,
        );
    }
    assert.ok(
        fuente.includes("require('../../assets/copy/fallback-episode/copy.json')"),
        'el panel consume el asset de copy, que es la fuente única',
    );
});

// ───────────────────────── Smoke E2E por la ruta real ─────────────────────────

function startEphemeralServer() {
    delete require.cache[require.resolve(ROUTES_PATH)];
    const dashRoutes = require(ROUTES_PATH);
    const fakeCtx = { getState: () => ({}), PIPELINE: '', ROOT: '', GH_BIN: '' };
    const server = http.createServer((req, res) => {
        try {
            if (dashRoutes.handle(req, res, fakeCtx)) return;
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('not found');
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'text/plain' });
            res.end('server error: ' + e.message);
        }
    });
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
    });
}

function get(port, urlPath) {
    return new Promise((resolve, reject) => {
        const req = http.request(
            { host: '127.0.0.1', port, path: urlPath, method: 'GET', agent: false, headers: { Connection: 'close' } },
            (res) => {
                const chunks = [];
                res.on('data', (c) => chunks.push(c));
                res.on('end', () => resolve({ statusCode: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
            },
        );
        req.on('error', reject);
        req.end();
    });
}

test('Smoke · GET /providers → 200 con el indicador de motor montado', async () => {
    secrets.listKeys = () => [];
    setEpisode(fakeEpisode({ tier: 'gratuito_sin_herramientas', cause: 'reposo' }));
    const { server, port } = await startEphemeralServer();
    try {
        const r = await get(port, '/providers');
        assert.equal(r.statusCode, 200);
        assert.ok(r.body.includes('id="prov-engine"'), 'el indicador viaja en la respuesta HTTP');
        assert.ok(r.body.includes(COPY.motivos.reposo), 'con su motivo en castellano');
        assert.ok(r.body.includes('id="providers-list"'), 'y el resto de la ventana intacto');
        assert.ok(r.body.includes('.prov-engine.is-fallback'), 'el CSS del panel viaja en el documento');
    } finally {
        if (typeof server.closeIdleConnections === 'function') server.closeIdleConnections();
        await new Promise((resolve) => server.close(() => resolve()));
        restoreEpisode();
        secrets.listKeys = ORIGINAL_LIST_KEYS;
    }
});
