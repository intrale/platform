'use strict';

// =============================================================================
// api.test.js — Tests de los handlers HTTP de cost-anomaly (#3735, CA-3.4).
//
// Cubre las 3 defensas CSRF obligatorias de la receta:
//   - D1: Sec-Fetch-Site cross-site  → 403
//   - D2: Content-Type form-urlencoded → 415
//   - D3: hours fuera de {1,4,24}     → 400
// + casos de borde: header ausente permitido, ack form-urlencoded → 415,
//   ruta desconocida → 404, snooze válido pasa las defensas.
//
// Los rechazos D1/D2/D3 ocurren ANTES de tocar el estado de rest-mode-state,
// así que no necesitan un pipelineDir real. Para el happy-path del snooze se usa
// un pipelineDir temporal con un alert activo sintético.
// =============================================================================

const { test } = require('node:test');
const assert = require('node:assert');
const { Readable } = require('node:stream');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const api = require('../api');

// --- Fakes de req/res -------------------------------------------------------

// Crea un req simulado: stream readable con headers/method/url. Si hay body, se
// emite como chunk único.
function fakeReq({ method = 'GET', url = '/', headers = {}, body = null } = {}) {
    const lower = {};
    for (const k of Object.keys(headers)) lower[k.toLowerCase()] = headers[k];
    const req = Readable.from(body != null ? [Buffer.from(body)] : []);
    req.method = method;
    req.url = url;
    req.headers = lower;
    // destroy ya existe en Readable; lo dejamos.
    return req;
}

// Captura la respuesta. resolve() se cumple cuando se llama end().
function fakeRes() {
    const captured = { status: null, headers: null, body: '' };
    let resolveDone;
    const done = new Promise((r) => { resolveDone = r; });
    const res = {
        writeHead(status, headers) { captured.status = status; captured.headers = headers; },
        end(chunk) { if (chunk) captured.body += chunk; resolveDone(); },
        get json() { try { return JSON.parse(captured.body); } catch { return null; } },
    };
    return { res, captured, done };
}

async function runRoute(reqOpts, opts) {
    const req = fakeReq(reqOpts);
    const { res, captured, done } = fakeRes();
    const handled = api.route(req, res, opts);
    await done;
    return { handled, captured, json: (() => { try { return JSON.parse(captured.body); } catch { return null; } })() };
}

// --- D1: Sec-Fetch-Site ------------------------------------------------------

test('D1 — POST snooze con Sec-Fetch-Site cross-site responde 403', async () => {
    const { handled, captured, json } = await runRoute({
        method: 'POST',
        url: '/api/cost-anomaly/snooze',
        headers: { 'Sec-Fetch-Site': 'cross-site', 'Content-Type': 'application/json' },
        body: JSON.stringify({ hours: 1 }),
    });
    assert.strictEqual(handled, true);
    assert.strictEqual(captured.status, 403);
    assert.strictEqual(json.reason, 'cross_site_blocked');
});

test('D1 — POST ack con Sec-Fetch-Site same-site (CSRF vector) responde 403', async () => {
    const { captured } = await runRoute({
        method: 'POST',
        url: '/api/cost-anomaly/ack',
        headers: { 'Sec-Fetch-Site': 'same-site' },
    });
    assert.strictEqual(captured.status, 403);
});

test('D1 — same-origin pasa la defensa (no es 403)', async () => {
    const { captured } = await runRoute({
        method: 'POST',
        url: '/api/cost-anomaly/snooze',
        headers: { 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json' },
        body: JSON.stringify({ hours: 999 }),
    }, { pipelineDir: os.tmpdir() });
    assert.notStrictEqual(captured.status, 403);
});

test('D1 — header ausente (curl/no-browser) se permite', async () => {
    const { captured } = await runRoute({
        method: 'POST',
        url: '/api/cost-anomaly/snooze',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hours: 999 }),
    }, { pipelineDir: os.tmpdir() });
    assert.notStrictEqual(captured.status, 403);
});

// --- D2: Content-Type --------------------------------------------------------

test('D2 — POST snooze con Content-Type form-urlencoded responde 415', async () => {
    const { captured, json } = await runRoute({
        method: 'POST',
        url: '/api/cost-anomaly/snooze',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'hours=1',
    });
    assert.strictEqual(captured.status, 415);
    assert.strictEqual(json.reason, 'unsupported_media_type');
});

test('D2 — POST ack con Content-Type form-urlencoded responde 415', async () => {
    const { captured } = await runRoute({
        method: 'POST',
        url: '/api/cost-anomaly/ack',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'x=1',
    });
    assert.strictEqual(captured.status, 415);
});

test('D2 — application/json con charset pasa la defensa', async () => {
    const { captured } = await runRoute({
        method: 'POST',
        url: '/api/cost-anomaly/snooze',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ hours: 999 }),
    }, { pipelineDir: os.tmpdir() });
    assert.notStrictEqual(captured.status, 415);
});

// --- D3: whitelist de hours --------------------------------------------------

test('D3 — POST snooze con hours:999 responde 400', async () => {
    const { captured, json } = await runRoute({
        method: 'POST',
        url: '/api/cost-anomaly/snooze',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hours: 999 }),
    }, { pipelineDir: os.tmpdir() });
    assert.strictEqual(captured.status, 400);
    assert.strictEqual(json.reason, 'invalid_hours');
    assert.deepStrictEqual(json.allowed, [1, 4, 24]);
});

test('D3 — hours:2 (no en whitelist) responde 400', async () => {
    const { captured } = await runRoute({
        method: 'POST',
        url: '/api/cost-anomaly/snooze',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hours: 2 }),
    }, { pipelineDir: os.tmpdir() });
    assert.strictEqual(captured.status, 400);
});

test('D3 — body JSON inválido responde 400', async () => {
    const { captured, json } = await runRoute({
        method: 'POST',
        url: '/api/cost-anomaly/snooze',
        headers: { 'Content-Type': 'application/json' },
        body: '{ not json',
    }, { pipelineDir: os.tmpdir() });
    assert.strictEqual(captured.status, 400);
    assert.strictEqual(json.reason, 'invalid_json');
});

// --- Routing -----------------------------------------------------------------

test('route() devuelve false para URLs ajenas', async () => {
    const req = fakeReq({ method: 'GET', url: '/api/otra-cosa' });
    const { res } = fakeRes();
    assert.strictEqual(api.route(req, res, {}), false);
});

test('route() responde 404 para ruta del prefijo pero desconocida', async () => {
    const { captured, json } = await runRoute({
        method: 'GET',
        url: '/api/cost-anomaly/inexistente',
    });
    assert.strictEqual(captured.status, 404);
    assert.strictEqual(json.reason, 'not_found');
});

// --- Happy path snooze (con alert activo sintético) -------------------------

test('snooze con hours válido + alert activo responde 200 y persiste snoozed_until', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cost-anomaly-test-'));
    // Sembramos un alert activo en el archivo que lee rest-mode-state
    // (statePath = <pipelineDir>/rest-mode.json).
    const statePath = path.join(dir, 'rest-mode.json');
    fs.writeFileSync(statePath, JSON.stringify({
        alert: { active: true, ratio: 2.0, actual_usd: 5, baseline_usd: 2, top_skills: [] },
    }));

    const { captured, json } = await runRoute({
        method: 'POST',
        url: '/api/cost-anomaly/snooze',
        headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin' },
        body: JSON.stringify({ hours: 4 }),
    }, { pipelineDir: dir });

    assert.strictEqual(captured.status, 200);
    assert.strictEqual(json.ok, true);
    assert.ok(json.state && json.state.snoozed_until, 'snoozed_until debe persistirse');
    fs.rmSync(dir, { recursive: true, force: true });
});

// --- Unidad de las defensas (sin HTTP) --------------------------------------

test('checkSecFetchSite — clasifica valores correctamente', () => {
    assert.strictEqual(api.checkSecFetchSite({ headers: {} }), null);
    assert.strictEqual(api.checkSecFetchSite({ headers: { 'sec-fetch-site': 'same-origin' } }), null);
    assert.strictEqual(api.checkSecFetchSite({ headers: { 'sec-fetch-site': 'none' } }), null);
    assert.strictEqual(api.checkSecFetchSite({ headers: { 'sec-fetch-site': 'cross-site' } }).status, 403);
    assert.strictEqual(api.checkSecFetchSite({ headers: { 'sec-fetch-site': 'same-site' } }).status, 403);
});

test('checkContentType — clasifica valores correctamente', () => {
    assert.strictEqual(api.checkContentType({ headers: {} }), null);
    assert.strictEqual(api.checkContentType({ headers: { 'content-type': 'application/json' } }), null);
    assert.strictEqual(api.checkContentType({ headers: { 'content-type': 'application/json; charset=utf-8' } }), null);
    assert.strictEqual(api.checkContentType({ headers: { 'content-type': 'application/x-www-form-urlencoded' } }).status, 415);
    assert.strictEqual(api.checkContentType({ headers: { 'content-type': 'text/plain' } }).status, 415);
});
