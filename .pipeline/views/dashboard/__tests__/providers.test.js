// =============================================================================
// Tests SSR de la pantalla Providers (Multi-Provider) — rediseño MIZPÁ #4201.
//
// El rediseño reemplaza la vista de credenciales-solo (#3737) por la consola
// unificada multi-provider del mockup `providers-redesign-v2`: una fila por
// proveedor con key+fp, salud+barra de cuota, tier, catálogo y kill-switch;
// banner de misión que diagnostica la cadena; franja «Por agente» al pie.
//
// Cubre los criterios de aceptación del issue + invariantes de seguridad que
// se conservan del diseño anterior:
//   CA-1  SIN pestañas internas (sin solapas mp-tab / role=tab / data-tab).
//   CA-2  una fila por proveedor (key, salud, tier, catálogo, kill-switch).
//   CA-3  banner de misión que diagnostica con métricas reales.
//   CA-4  franja «Por agente»: cadena DEFAULT + agentes que la pisan.
//   CA-5  lenguaje MIZPÁ (marca, tagline, multiproyecto, miga de pan, nav).
//   SEC   anti-leak (masked, nunca key completa), XSS escapado, sin inputs de
//         password, sin handlers inline, sin recomputar masking.
//   A3    renderInert() visible (nunca pantalla en blanco).
//   Smoke E2E vía dashboard-routes.handle(): /providers, ?view=providers y
//         /dashboard/partial?view=providers → 200 + anti-leak 0.
//
// node:test (sin Jest). El stub de `secrets-rw.listKeys()` se hace mutando el
// método del módulo compartido por require.cache — providers.js sostiene la
// MISMA referencia. Los fixtures nunca usan shape de key real (no dispara el
// precommit-secret-scan).
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const PROVIDERS_PATH = path.resolve(__dirname, '..', 'providers.js');
const SECRETS_PATH = path.resolve(__dirname, '..', '..', '..', 'lib', 'multi-provider', 'secrets-rw.js');
const ROUTES_PATH = path.resolve(__dirname, '..', '..', '..', 'lib', 'dashboard-routes.js');

const providers = require(PROVIDERS_PATH);
const secrets = require(SECRETS_PATH);
const ORIGINAL_LIST_KEYS = secrets.listKeys;

// Regex canónico de "key completa": una credencial real tiene >= 20 chars
// contiguos de la clase; el masked los rompe con ****.
const FULL_KEY_RE = /sk-(ant-)?[A-Za-z0-9_-]{20,}/g;

const XSS_BODY = '<script>alert(1)</script>';
const XSS_ATTR = '"><img src=x onerror=alert(1)>';

function setListKeys(impl) { secrets.listKeys = impl; }
function restoreListKeys() { secrets.listKeys = ORIGINAL_LIST_KEYS; }

function fakeEntry(provider, label, status, opts) {
    const o = opts || {};
    const present = status === 'present';
    return {
        provider,
        label,
        editable: o.editable !== undefined ? o.editable : true,
        reason: o.reason || null,
        status,
        masked: present ? (o.masked || 'abc123****wxyz') : null,
        fingerprint: present ? (o.fingerprint || 'a1b2c3d4e5f6a7b8') : null,
    };
}

function mixedEntries() {
    return [
        fakeEntry('anthropic', 'Anthropic', 'absent', { editable: false, reason: 'OAuth/MAX' }),
        fakeEntry('openai', 'OpenAI / Codex', 'present'),
        fakeEntry('gemini-google', 'Gemini (Google AI Studio)', 'present'),
        fakeEntry('cerebras', 'Cerebras', 'present'),
        fakeEntry('nvidia-nim', 'NVIDIA NIM', 'absent'),
    ];
}

// ─────────────────────────── Unit (render directo) ───────────────────────────

test('documento HTML completo con title de la ventana', () => {
    const html = providers.renderProviders();
    assert.ok(html.startsWith('<!DOCTYPE html>'), 'debe ser documento HTML completo');
    assert.ok(html.includes('<title>Intrale · Providers</title>'), 'falta el title');
    assert.ok(html.length > 5000, 'el render no debe estar vacío');
});

test('CA-1 · sin pestañas internas (mp-tab / role=tab / data-tab)', () => {
    const html = providers.renderProviders();
    assert.ok(!/class="mp-tab/.test(html), 'sin solapas mp-tab heredadas');
    assert.ok(!/role="tab"/.test(html), 'sin role=tab — todo de corrido');
    assert.ok(!/data-tab=/.test(html), 'sin selector de paneles data-tab');
});

test('CA-2 · una fila por proveedor con key, salud, tier, catálogo y kill-switch', () => {
    setListKeys(() => mixedEntries());
    try {
        const html = providers.renderProviders();
        const rows = (html.match(/<article class="prov-row"/g) || []).length;
        assert.equal(rows, 5, '5 proveedores gestionados, una fila cada uno');
        assert.ok(html.includes('id="providers-list"'), 'contenedor de lista presente');
        assert.match(html, /prov-tier/, 'badge de tier');
        assert.match(html, /prov-quota-fill/, 'barra de cuota/carga');
        assert.match(html, /prov-model|prov-models-empty/, 'catálogo de modelos en línea');
        assert.match(html, /data-action="toggle-kill"/, 'kill-switch por fila');
        // Tiers canónicos del negocio.
        assert.match(html, /PLAN MAX/, 'Claude = PLAN MAX');
        assert.match(html, /PAGO/, 'Codex = PAGO');
        assert.match(html, /FREE/, 'free tiers');
        // Los 5 providers canónicos por data-provider.
        for (const p of ['anthropic', 'openai', 'gemini-google', 'cerebras', 'nvidia-nim']) {
            assert.ok(html.includes('data-provider="' + p + '"'), 'falta data-provider ' + p);
        }
    } finally { restoreListKeys(); }
});

test('CA-2b · Anthropic/OAuth muestra "OAuth / MAX" sin API key ni input', () => {
    setListKeys(() => [fakeEntry('anthropic', 'Anthropic', 'absent', { editable: false, reason: 'OAuth/MAX' })]);
    try {
        const html = providers.renderProviders();
        assert.match(html, /OAuth \/ MAX/, 'Anthropic se muestra como OAuth/MAX');
    } finally { restoreListKeys(); }
});

test('CA-3 · banner de misión diagnostica cadena degradada con métricas', () => {
    const meta = {
        total: 5, healthy: 4,
        degraded: [{ name: 'Gemini', healthReason: 'timeout' }],
        absorber: { name: 'Codex', loadPct: 40 },
        defaultProvider: 'anthropic',
        defaultChain: ['Claude', 'Codex', 'Gemini', 'Cerebras', 'NVIDIA NIM'],
        agents: ['backend-dev'], healthTs: null, dispatchTotal: 570,
    };
    const banner = providers.renderMissionBanner(meta);
    assert.match(banner, /degradada/, 'diagnostica cadena degradada');
    assert.match(banner, /Gemini/, 'nombra al provider afectado');
    assert.match(banner, /4 <span class="u">de 5/, 'sanos N/total');
    assert.match(banner, /Codex/, 'nombra quién absorbe el fallback');
    assert.match(banner, /40%/, 'nivel de absorción del fallback');
    assert.match(banner, /is-degraded/, 'estilo degradado');
});

test('CA-3b · banner en calma cuando no hay degradados', () => {
    const meta = {
        total: 5, healthy: 5, degraded: [],
        absorber: { name: 'Claude', loadPct: 12 },
        defaultProvider: 'anthropic',
        defaultChain: ['Claude'], agents: [], healthTs: null, dispatchTotal: 100,
    };
    const banner = providers.renderMissionBanner(meta);
    assert.match(banner, /sana/, 'la cadena está sana');
    assert.match(banner, /is-calm/, 'estilo calmo');
    assert.ok(!/degradada/.test(banner), 'sin mención de degradación');
});

test('CA-4 · franja por agente con cadena DEFAULT y agentes que la pisan', () => {
    const meta = { defaultChain: ['Claude', 'Codex', 'Gemini'], agents: ['backend-dev', 'qa', 'po'] };
    const strip = providers.renderAgentStrip(meta);
    assert.match(strip, /prov-chain/, 'render de la cadena DEFAULT');
    assert.match(strip, /Claude/);
    assert.match(strip, /backend-dev/);
    assert.match(strip, /qa/);
    assert.match(strip, /Por agente/);
});

test('CA-5 · lenguaje MIZPÁ (marca, tagline, multiproyecto, miga de pan, nav)', () => {
    const html = providers.renderProviders();
    assert.match(html, /MIZPÁ/, 'marca');
    assert.match(html, /atalaya de agentes/, 'tagline');
    assert.match(html, /mz-projsel/, 'selector multiproyecto');
    assert.match(html, /mz-crumb/, 'miga de pan');
    assert.match(html, /class="v3-tab/, 'nav tabs');
    // La nav marca Providers como activa.
    assert.match(html, /aria-current="page"/, 'tab activa');
});

test('SEC · payload XSS en datos del provider NO es ejecutable', () => {
    const evil = '<img src=x onerror=alert(1)>"';
    const p = {
        key: 'anthropic', disabledKey: 'anthropic', name: evil, accent: 'var(--provider-anthropic)',
        tier: 'PLAN MAX', tierKind: 'max', tierIcon: '🟦',
        masked: evil, fingerprint: evil, keyStatus: 'present', editable: true,
        reason: null, authMode: null, freeTierNotes: null,
        healthState: 'green', healthReason: evil, lastChecked: null,
        loadPct: 10, dispatches24h: 5, hasTraffic: true, models: [evil], disabled: false,
    };
    const row = providers.renderProviderRow(p);
    assert.ok(!/<img src=x onerror/.test(row), 'el payload no se inyecta como HTML');
    assert.match(row, /&lt;img/, 'queda escapado');
});

test('SEC · masked se muestra pero nunca una key completa', () => {
    setListKeys(() => [fakeEntry('openai', 'OpenAI / Codex', 'present', { masked: 'sk-fake123456****wxyz' })]);
    try {
        const html = providers.renderProviders();
        const matches = html.match(FULL_KEY_RE) || [];
        assert.equal(matches.length, 0, 'no debe haber ninguna key completa');
        assert.ok(html.includes('sk-fake123456****wxyz'), 'el preview enmascarado se muestra');
    } finally { restoreListKeys(); }
});

test('SEC estático · sin inputs de password, sin textarea, sin handlers inline', () => {
    const src = fs.readFileSync(PROVIDERS_PATH, 'utf8');
    assert.equal((src.match(/<input[^>]+type=["']password["']/g) || []).length, 0, 'sin inputs password');
    assert.equal((src.match(/<textarea/g) || []).length, 0, 'sin textareas');
    assert.equal((src.match(/onclick=|onload=|javascript:/g) || []).length, 0, 'sin handlers inline');
    assert.equal((src.match(/maskValue/g) || []).length, 0, 'no recomputa masking (fuente única secrets-rw)');
});

test('UX · tokens --provider-* DEFINIDOS en el documento (no solo referenciados)', () => {
    const html = providers.renderProviders();
    for (const token of ['--provider-anthropic:', '--provider-gemini:', '--provider-cerebras:', '--provider-nvidia-nim:', '--provider-unknown:']) {
        assert.ok(html.includes(token), 'el documento debe DEFINIR ' + token.slice(0, -1));
    }
    const inert = providers.renderInert('boom');
    assert.ok(inert.includes('--provider-anthropic:'), 'renderInert incluye design-tokens.css');
});

test('A3 · renderInert() retorna HTML visible "Ventana Providers no disponible"', () => {
    const html = providers.renderInert('require failed');
    assert.ok(html.includes('<h1>Ventana Providers no disponible</h1>'), 'título inerte');
    assert.ok(html.includes('require failed'), 'muestra el motivo');
    assert.ok(html.length > 100, 'no queda vacío');
    const xss = providers.renderInert(XSS_BODY);
    assert.ok(!xss.includes(XSS_BODY), 'no refleja el <script> crudo');
    assert.ok(xss.includes('&lt;script&gt;'), 'el motivo va escapado');
});

test('buildProvidersModel nunca lanza y devuelve el set canónico', () => {
    const model = providers.buildProvidersModel();
    assert.ok(Array.isArray(model.providers));
    assert.equal(model.providers.length, 5);
    assert.deepEqual(model.providers.map((p) => p.name), ['Claude', 'Codex', 'Gemini', 'Cerebras', 'NVIDIA NIM']);
    assert.ok(model.meta.absorber, 'identifica al absorber');
    assert.ok(typeof model.meta.healthy === 'number');
    assert.ok(Array.isArray(model.meta.agents));
});

// ─────────────────────────── Smoke E2E (router) ───────────────────────────

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
        const req = http.request({ host: '127.0.0.1', port, path: urlPath, method: 'GET', agent: false, headers: { Connection: 'close' } }, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
        });
        req.on('error', reject);
        req.end();
    });
}

function closeServer(server) {
    if (typeof server.closeIdleConnections === 'function') server.closeIdleConnections();
    return new Promise((resolve) => server.close(() => resolve()));
}

test('Smoke · GET /providers → 200 con la lista y el banner', async () => {
    setListKeys(() => mixedEntries());
    const { server, port } = await startEphemeralServer();
    try {
        const r = await get(port, '/providers');
        assert.equal(r.statusCode, 200);
        assert.ok(r.body.includes('<title>Intrale · Providers</title>'), 'rinde Providers');
        assert.ok(r.body.includes('id="providers-list"'), 'lista presente');
        assert.ok(r.body.includes('prov-mission'), 'banner de misión presente');
    } finally {
        await closeServer(server);
        restoreListKeys();
    }
});

test('Smoke · GET /dashboard?view=providers → 200', async () => {
    setListKeys(() => mixedEntries());
    const { server, port } = await startEphemeralServer();
    try {
        const r = await get(port, '/dashboard?view=providers');
        assert.equal(r.statusCode, 200);
        assert.ok(r.body.includes('id="providers-list"'), 'ID DOM canónico de la lista');
    } finally {
        await closeServer(server);
        restoreListKeys();
    }
});

test('SEC · anti-leak cross-route: 0 keys completas en cada ruta', async () => {
    setListKeys(() => [
        fakeEntry('openai', 'OpenAI / Codex', 'present', { masked: 'sk-fake123456****wxyz' }),
        fakeEntry('cerebras', 'Cerebras', 'present', { masked: 'csk-aa11****zz99' }),
    ]);
    const { server, port } = await startEphemeralServer();
    try {
        for (const url of ['/providers', '/dashboard?view=providers', '/dashboard/partial?view=providers']) {
            const r = await get(port, url);
            assert.equal(r.statusCode, 200, url + ' debe responder 200');
            const matches = r.body.match(FULL_KEY_RE) || [];
            assert.equal(matches.length, 0, 'ninguna key completa en ' + url);
        }
    } finally {
        await closeServer(server);
        restoreListKeys();
    }
});
