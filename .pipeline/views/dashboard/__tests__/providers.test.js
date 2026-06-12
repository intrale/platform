// =============================================================================
// Tests SSR de la ventana Providers (#3737, split del épico #3715).
//
// Cubre el set CA-PRV + SEC del análisis de #3737:
//   1. renderProviders con 5 entries mixtas → 5 cards con data-provider.
//   2. Estado vacío ([]) → #providers-list sin crash + leyenda visible.
//   3. listKeys() lanza → bloque data-load-error + role="alert" (CA-A3 / SEC-7).
//   4. Payload XSS canónico en label + reason NO ejecutable (CA-D1 / SEC-1).
//   5. Anti-leak SEC-1: masked (no full key) → 0 matches del regex de key.
//   6. Smoke E2E vía dashboard-routes.handle(): /dashboard?view=providers y
//      /dashboard/partial?view=providers → 200, anti-leak 0 (CA-PRV-3 / CA-PRV-18).
//   7. SEC-2 / CA-PRV-6 estático: el fuente no tiene <input password> ni <textarea>.
//   8. (omitido) SEC-3 POST: la vista NO agrega endpoint POST propio — reusa
//      `/api/multi-provider/reload` (ya cubierto por api.js). No aplica acá.
//   9. Anthropic locked (R7): editable:false → provider-locked, sin rotate btn.
//  10. IDs DOM invariantes: #providers-list y #providers-legend exactamente 1 vez.
//  11. Tooltips (CA-PRV-12): cada <button> tiene title + aria-label no vacíos.
//
// node:test (sin Jest). No arranca dashboard.js (side effects). El stub de
// `secrets-rw.listKeys()` se hace mutando el método del módulo compartido por
// require.cache — providers.js sostiene la MISMA referencia (CA-D1 fixtures
// nunca usan shape de key real → no dispara precommit-secret-scan, R8).
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

// Regex canónico de "key completa" (mismo que R8 del issue). Una credencial
// real tiene >= 20 chars contiguos de la clase; el masked los rompe con ****.
const FULL_KEY_RE = /sk-(ant-)?[A-Za-z0-9_-]{20,}/g;

// Payloads XSS (paridad con ops.test.js / home.test.js).
const XSS_BODY = '<script>alert(1)</script>';
const XSS_ATTR = '"><img src=x onerror=alert(1)>';

function setListKeys(impl) { secrets.listKeys = impl; }
function restoreListKeys() { secrets.listKeys = ORIGINAL_LIST_KEYS; }

// Fixture de un entry con el shape que devuelve listKeys() (sin la key cruda).
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

// EP1-H2 (#3917): se retiró el fixture 'elevenlabs' (provider pago deprecado).
// El set refleja los 5 providers LLM reales del ranking multi-provider.
function mixedEntries() {
    return [
        fakeEntry('anthropic', 'Anthropic', 'present', { editable: false, reason: 'OAuth/MAX' }),
        fakeEntry('openai', 'OpenAI / Codex', 'present'),
        fakeEntry('gemini-google', 'Gemini (Google AI Studio)', 'placeholder'),
        fakeEntry('cerebras', 'Cerebras', 'placeholder'),
        fakeEntry('nvidia-nim', 'NVIDIA NIM', 'absent'),
    ];
}

// ─────────────────────────── Unit (render directo) ───────────────────────────

test('CA-PRV-1 · 5 entries mixtas → 5 cards con data-provider', () => {
    setListKeys(() => mixedEntries());
    try {
        const html = providers.renderProviders();
        assert.ok(html.startsWith('<!DOCTYPE html>'), 'debe ser documento HTML completo');
        assert.ok(html.includes('<title>Intrale · Providers</title>'), 'falta el title de la ventana');
        const cards = html.match(/<article class="provider-card"/g) || [];
        assert.equal(cards.length, 5, 'deben renderizarse exactamente 5 cards');
        for (const p of ['anthropic', 'openai', 'gemini-google', 'cerebras', 'nvidia-nim']) {
            assert.ok(html.includes('data-provider="' + p + '"'), 'falta data-provider para ' + p);
        }
        // Badges de estado presentes (los 3 labels).
        assert.ok(html.includes('>CONFIGURADO<'), 'falta badge CONFIGURADO');
        assert.ok(html.includes('>PLACEHOLDER<'), 'falta badge PLACEHOLDER');
        assert.ok(html.includes('>AUSENTE<'), 'falta badge AUSENTE');
    } finally { restoreListKeys(); }
});

test('CA-PRV-2 · estado vacío ([]) → #providers-list sin crash + leyenda', () => {
    setListKeys(() => []);
    try {
        const html = providers.renderProviders();
        assert.ok(html.includes('id="providers-list"'), 'falta el contenedor de lista');
        assert.ok(!/<article class="provider-card"/.test(html), 'no debe haber cards con lista vacía');
        assert.ok(html.includes('id="providers-legend"'), 'la leyenda debe seguir visible');
    } finally { restoreListKeys(); }
});

test('CA-A3 / SEC-7 · listKeys() lanza → data-load-error + role="alert"', () => {
    setListKeys(() => { throw new Error('boom_credentials'); });
    try {
        const html = providers.renderProviders();
        assert.ok(html.includes('data-load-error="true"'), 'falta el marcador de error de carga');
        assert.ok(html.includes('role="alert"'), 'el bloque de error debe ser un alert ARIA');
        assert.ok(html.includes('boom_credentials'), 'debe mostrar el motivo escapado');
        assert.ok(!/<article class="provider-card"/.test(html), 'no debe renderizar cards en error');
    } finally { restoreListKeys(); }
});

test('CA-D1 / SEC-1 · payload XSS en label + reason NO es ejecutable', () => {
    setListKeys(() => [
        fakeEntry(XSS_ATTR, XSS_BODY, 'present', { editable: false, reason: XSS_ATTR }),
    ]);
    try {
        const html = providers.renderProviders();
        assert.ok(!html.includes(XSS_BODY), 'el <script> crudo NO debe aparecer');
        assert.ok(html.includes('&lt;script&gt;'), 'el <script> debe aparecer escapado');
        assert.ok(!html.includes('onerror=alert(1)>'), 'el payload rompe-atributo NO debe quedar crudo');
        assert.ok(!html.includes('<img src=x'), 'no debe inyectarse un <img> ejecutable');
        assert.ok(!html.includes('&amp;amp;'), 'sin doble-escape de &');
    } finally { restoreListKeys(); }
});

test('SEC-1 / CA-PRV-5 · masked (no full key) → 0 matches del regex de key', () => {
    setListKeys(() => [
        fakeEntry('openai', 'OpenAI / Codex', 'present', { masked: 'sk-fake123456****wxyz' }),
    ]);
    try {
        const html = providers.renderProviders();
        const matches = html.match(FULL_KEY_RE) || [];
        assert.equal(matches.length, 0, 'no debe haber ninguna key completa en el HTML');
        // El masked sí se muestra (preview enmascarado).
        assert.ok(html.includes('sk-fake123456****wxyz'), 'el preview enmascarado debe mostrarse');
    } finally { restoreListKeys(); }
});

test('R7 · anthropic (editable:false) → provider-locked, sin rotate btn', () => {
    setListKeys(() => [
        fakeEntry('anthropic', 'Anthropic', 'present', { editable: false, reason: 'OAuth/MAX login' }),
        fakeEntry('openai', 'OpenAI / Codex', 'present'),
    ]);
    try {
        const html = providers.renderProviders();
        assert.ok(html.includes('provider-locked'), 'anthropic debe mostrar el candado (locked)');
        // El rotate btn NO debe apuntar a anthropic.
        assert.ok(!/data-action="open-rotate-modal" data-provider="anthropic"/.test(html),
            'anthropic NO debe tener botón de rotación');
        // openai (editable) SÍ tiene rotate btn.
        assert.ok(/data-action="open-rotate-modal" data-provider="openai"/.test(html),
            'openai (editable) debe tener botón de rotación');
    } finally { restoreListKeys(); }
});

test('CA-PRV · IDs DOM invariantes: #providers-list y #providers-legend 1 vez', () => {
    setListKeys(() => mixedEntries());
    try {
        const html = providers.renderProviders();
        const list = html.match(/id="providers-list"/g) || [];
        const legend = html.match(/id="providers-legend"/g) || [];
        assert.equal(list.length, 1, '#providers-list debe aparecer exactamente 1 vez');
        assert.equal(legend.length, 1, '#providers-legend debe aparecer exactamente 1 vez');
    } finally { restoreListKeys(); }
});

test('CA-PRV-12 · cada <button> tiene title + aria-label no vacíos', () => {
    setListKeys(() => mixedEntries());
    try {
        const html = providers.renderProviders();
        const buttons = html.match(/<button[^>]*>/g) || [];
        assert.ok(buttons.length >= 1, 'debe haber al menos un botón (rotate / close modal)');
        for (const b of buttons) {
            assert.match(b, /title="[^"]+"/, 'todo <button> debe tener title no vacío: ' + b);
            assert.match(b, /aria-label="[^"]+"/, 'todo <button> debe tener aria-label no vacío: ' + b);
        }
        // El rotate btn cumple el orden title→aria-label exigido por el smoke.
        assert.match(html, /<button[^>]+title="[^"]+"[^>]+aria-label="[^"]+"/);
    } finally { restoreListKeys(); }
});

test('SEC-2 / CA-PRV-6 estático · el fuente no tiene <input password> ni <textarea>', () => {
    const src = fs.readFileSync(PROVIDERS_PATH, 'utf8');
    assert.equal((src.match(/<input[^>]+type=["']password["']/g) || []).length, 0,
        'la vista read-only NO debe declarar inputs de password');
    assert.equal((src.match(/<textarea/g) || []).length, 0,
        'la vista read-only NO debe declarar textareas');
    // R3 — sin handlers inline (compat CSP estricto #3688).
    assert.equal((src.match(/onclick=|onload=|onerror=|javascript:/g) || []).length, 0,
        'sin handlers inline ni javascript: URIs');
    // R1 — sin recomputar masking en la vista.
    assert.equal((src.match(/maskValue/g) || []).length, 0,
        'la vista NUNCA debe recomputar el masking (fuente única secrets-rw)');
});

test('UX-3737 · tokens --provider-* DEFINIDOS en el documento (no solo referenciados)', () => {
    // Regresión del rechazo UX 2026-06-10: la vista referenciaba
    // var(--provider-anthropic) sin inyectar design-tokens.css → --row-accent
    // guaranteed-invalid → todas las cards caían al gris var(--in-border).
    // Acá se exige la DEFINICIÓN del token (con ":") en el HTML servido.
    setListKeys(() => mixedEntries());
    try {
        const html = providers.renderProviders();
        for (const token of ['--provider-anthropic:', '--provider-gemini:', '--provider-cerebras:', '--provider-nvidia-nim:', '--provider-unknown:']) {
            assert.ok(html.includes(token), 'el documento debe DEFINIR ' + token.slice(0, -1) + ' (design-tokens.css inyectado)');
        }
        // El render inerte tampoco debe perder los tokens.
        const inert = providers.renderInert('boom');
        assert.ok(inert.includes('--provider-anthropic:'), 'renderInert debe incluir design-tokens.css');
    } finally { restoreListKeys(); }
});

test('CA-A3 · renderInert() retorna HTML visible "Ventana Providers no disponible"', () => {
    const html = providers.renderInert('require failed');
    assert.ok(html.includes('<h1>Ventana Providers no disponible</h1>'), 'falta el título inerte');
    assert.ok(html.includes('require failed'), 'debe mostrar el motivo');
    assert.ok(html.length > 100, 'el render inerte NO debe quedar vacío (SEC-7)');
    // Escapa el motivo (no refleja XSS crudo).
    const xss = providers.renderInert(XSS_BODY);
    assert.ok(!xss.includes(XSS_BODY), 'el motivo no debe reflejar el <script> crudo');
    assert.ok(xss.includes('&lt;script&gt;'), 'el motivo debe ir escapado');
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
        // #3737 (rebote rev-2) — `agent: false` + `Connection: close`: sin esto
        // el globalAgent de Node >= 19 mantiene el socket keep-alive vivo y
        // `server.close()` queda esperando el drain (hasta keepAliveTimeout).
        // Bajo el runner del tester (sin --test-force-exit hasta que este
        // branch mergee) cualquier handle residual puede colgar la batería
        // entera: el reporter junit bufferea todo y el run muere a los 12min
        // con XML vacío (exit 124). Cero handles residuales acá.
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
    // closeIdleConnections (Node >= 18.2) destruye sockets keep-alive idle que
    // de otro modo demoran/bloquean el callback de close() (ver nota en get()).
    if (typeof server.closeIdleConnections === 'function') server.closeIdleConnections();
    return new Promise((resolve) => server.close(() => resolve()));
}

test('CA-PRV-3 · GET /dashboard?view=providers → 200 con #providers-list', async () => {
    setListKeys(() => mixedEntries());
    const { server, port } = await startEphemeralServer();
    try {
        const r = await get(port, '/dashboard?view=providers');
        assert.equal(r.statusCode, 200);
        assert.ok(r.body.includes('<title>Intrale · Providers</title>'), 'el router ?view=providers debe rendir Providers');
        assert.ok(r.body.includes('id="providers-list"'), 'debe contener el ID DOM canónico de la lista');
    } finally {
        await closeServer(server);
        restoreListKeys();
    }
});

test('CA-PRV-3 · GET /dashboard/partial?view=providers (loopback) → 200', async () => {
    setListKeys(() => mixedEntries());
    const { server, port } = await startEphemeralServer();
    try {
        const r = await get(port, '/dashboard/partial?view=providers');
        assert.equal(r.statusCode, 200, 'el partial loopback debe devolver 200');
        assert.equal(r.headers['cache-control'], 'no-store, no-cache, must-revalidate');
        assert.ok(r.body.includes('id="providers-list"'), 'el partial debe contener la lista');
    } finally {
        await closeServer(server);
        restoreListKeys();
    }
});

test('SEC-1 · anti-leak cross-route: /dashboard?view=providers → 0 keys completas', async () => {
    setListKeys(() => [
        fakeEntry('openai', 'OpenAI / Codex', 'present', { masked: 'sk-fake123456****wxyz' }),
        fakeEntry('cerebras', 'Cerebras', 'present', { masked: 'csk-aa11****zz99' }),
    ]);
    const { server, port } = await startEphemeralServer();
    try {
        for (const url of ['/dashboard?view=providers', '/providers', '/dashboard/partial?view=providers']) {
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
