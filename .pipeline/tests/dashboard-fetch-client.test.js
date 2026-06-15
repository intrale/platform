'use strict';

// =============================================================================
// Tests del wrapper único de fetch JSON del dashboard V3 — EP8-H0 (#3953, CA-2).
//
// FETCH_CLIENT_JS es código de cliente embebido como string. Se ejecuta acá en
// un DOM falso mínimo para validar el comportamiento real:
//   - éxito → devuelve el JSON y limpia el banner stale.
//   - fallo HTTP / red → devuelve null (el render sigue con el dato previo) y
//     muestra el banner discreto genérico.
//   - el detalle del error va SOLO a consola, NUNCA al DOM (R3).
//   - POST/DELETE adjuntan X-CSRF-Token desde <meta name="csrf-token"> (R2);
//     GET no.
//   - renderStaleBanner() emite el markup SSR con mensaje genérico.
//
// Ejecutar: node --test .pipeline/tests/dashboard-fetch-client.test.js
// =============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');

const { FETCH_CLIENT_JS, renderStaleBanner, STALE_MESSAGE } = require('../views/dashboard/fetch-client.js');

// --- DOM falso mínimo --------------------------------------------------------
function makeFakeEl(tag) {
    return {
        tagName: tag,
        id: '',
        className: '',
        hidden: false,
        textContent: '',
        _innerHTML: '',
        attrs: {},
        children: [],
        set innerHTML(v) { this._innerHTML = v; },
        get innerHTML() { return this._innerHTML; },
        setAttribute(k, v) { this.attrs[k] = v; },
        appendChild(c) { this.children.push(c); },
    };
}

// Recolecta todo el textContent del subárbol (para inspeccionar el banner que
// ahora se construye por DOM, sin innerHTML).
function collectText(el) {
    if (!el) return '';
    let t = el.textContent || '';
    for (const c of (el.children || [])) t += collectText(c);
    return t;
}

function makeFakeDom({ csrfToken } = {}) {
    const byId = {};
    const body = makeFakeEl('body');
    const origAppend = body.appendChild.bind(body);
    body.appendChild = (el) => { origAppend(el); if (el.id) byId[el.id] = el; };
    const document = {
        body,
        getElementById: (id) => byId[id] || null,
        createElement: (tag) => makeFakeEl(tag),
        createElementNS: (_ns, tag) => makeFakeEl(tag),
        querySelector: (sel) => {
            if (sel === 'meta[name="csrf-token"]' && csrfToken) return { content: csrfToken };
            return null;
        },
    };
    return { document, byId };
}

// Compila el wrapper en un sandbox con los globals que usa.
function loadClient({ fetchImpl, csrfToken } = {}) {
    const { document } = makeFakeDom({ csrfToken });
    const warnings = [];
    const consoleStub = { warn: (...a) => warnings.push(a) };
    const factory = new Function(
        'fetch', 'document', 'console',
        FETCH_CLIENT_JS + '\nreturn { fetchJson, showStaleBanner, clearStaleBanner, nhCsrfHeaders };'
    );
    const api = factory(fetchImpl, document, consoleStub);
    return { api, document, warnings };
}

// --- Tests -------------------------------------------------------------------

test('renderStaleBanner emite el banner SSR oculto con mensaje genérico', () => {
    const html = renderStaleBanner();
    assert.match(html, /id="in-stale-banner"/);
    assert.match(html, /hidden/);
    assert.match(html, /role="status"/);
    assert.match(html, new RegExp(STALE_MESSAGE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(html, /<use href="#ic-warn"/);
});

test('fetchJson devuelve el JSON parseado en éxito y deja el banner limpio', async () => {
    const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ hello: 'world' }) });
    const { api, document } = loadClient({ fetchImpl });
    const out = await api.fetchJson('/api/x');
    assert.deepEqual(out, { hello: 'world' });
    const banner = document.getElementById('in-stale-banner');
    // En éxito no se fuerza la creación del banner; si existe, debe estar oculto.
    if (banner) assert.equal(banner.hidden, true);
});

test('fetchJson devuelve null y muestra el banner ante error HTTP (CA-2)', async () => {
    const fetchImpl = async () => ({ ok: false, status: 500, json: async () => ({}) });
    const { api, document, warnings } = loadClient({ fetchImpl });
    const out = await api.fetchJson('/api/x');
    assert.equal(out, null, 'debe devolver null para no romper el render');
    const banner = document.getElementById('in-stale-banner');
    assert.ok(banner, 'el banner stale debe existir');
    assert.equal(banner.hidden, false, 'el banner debe estar visible');
    // Detalle SOLO a consola (R3).
    assert.equal(warnings.length, 1, 'el detalle del error va a consola');
});

test('fetchJson NO vuelca el detalle del error al DOM (R3)', async () => {
    const fetchImpl = async () => { throw new Error('ECONNREFUSED 127.0.0.1:9999 /home/secret/path'); };
    const { api, document } = loadClient({ fetchImpl });
    await api.fetchJson('/api/x');
    const banner = document.getElementById('in-stale-banner');
    const bannerText = collectText(banner);
    assert.ok(bannerText.includes(STALE_MESSAGE), 'el banner muestra el mensaje genérico');
    assert.ok(!bannerText.includes('ECONNREFUSED'), 'el stack/detalle NO debe llegar al DOM');
    assert.ok(!bannerText.includes('/home/secret/path'), 'los paths internos NO deben llegar al DOM');
});

test('fetchJson adjunta X-CSRF-Token en POST (R2)', async () => {
    let captured = null;
    const fetchImpl = async (url, opts) => { captured = opts; return { ok: true, status: 200, json: async () => ({}) }; };
    const { api } = loadClient({ fetchImpl, csrfToken: 'tok-123' });
    await api.fetchJson('/api/pause', { method: 'POST' });
    assert.ok(captured.headers, 'debe haber headers');
    assert.equal(captured.headers['X-CSRF-Token'], 'tok-123');
});

test('fetchJson adjunta X-CSRF-Token en DELETE (R2)', async () => {
    let captured = null;
    const fetchImpl = async (url, opts) => { captured = opts; return { ok: true, status: 200, json: async () => ({}) }; };
    const { api } = loadClient({ fetchImpl, csrfToken: 'tok-xyz' });
    await api.fetchJson('/api/dash/quota/calibrate', { method: 'DELETE' });
    assert.equal(captured.headers['X-CSRF-Token'], 'tok-xyz');
});

test('fetchJson NO adjunta X-CSRF-Token en GET', async () => {
    let captured = null;
    const fetchImpl = async (url, opts) => { captured = opts; return { ok: true, status: 200, json: async () => ({}) }; };
    const { api } = loadClient({ fetchImpl, csrfToken: 'tok-123' });
    await api.fetchJson('/api/dash/header');
    const hasCsrf = captured.headers && captured.headers['X-CSRF-Token'];
    assert.ok(!hasCsrf, 'GET no debe llevar X-CSRF-Token');
});

test('fetchJson usa cache:no-store por default', async () => {
    let captured = null;
    const fetchImpl = async (url, opts) => { captured = opts; return { ok: true, status: 200, json: async () => ({}) }; };
    const { api } = loadClient({ fetchImpl });
    await api.fetchJson('/api/x');
    assert.equal(captured.cache, 'no-store');
});
