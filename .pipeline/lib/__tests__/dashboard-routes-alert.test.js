// =============================================================================
// dashboard-routes-alert.test.js — #3954 EP8-H1 CA-12.
//
// Endpoints mutantes ack/snooze (PRIMEROS POST del dashboard). Verifica el
// cinturón de gates replicado de `/dashboard/partial`:
//   - método incorrecto → 405
//   - no-loopback       → 403 (REQ-SEC-1/7, independiente del bind)
//   - cross-site        → 403 (anti-CSRF, REQ-SEC-1)
//   - Content-Type no JSON → 415
//   - body sobre el cap → 413 (REQ-SEC-8)
//   - snooze fuera de allowlist → 400
//   - actor grabado server-side ignora el actor del body (REQ-SEC-3)
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'v3-routes-alert-'));
process.env.PIPELINE_DIR_OVERRIDE = TMP_DIR;
fs.mkdirSync(path.join(TMP_DIR, 'audit'), { recursive: true });

delete require.cache[require.resolve('../alert-tray-audit')];
delete require.cache[require.resolve('../audit-log')];
delete require.cache[require.resolve('../dashboard-routes')];

const routes = require('../dashboard-routes');
const ata = require('../alert-tray-audit');
const handleAlertMutation = routes._internal.handleAlertMutation;
const ALERT_BODY_MAX_BYTES = routes._internal.ALERT_BODY_MAX_BYTES;

function resetFs() {
    const { AUDIT_FILE } = ata._paths();
    try { fs.unlinkSync(AUDIT_FILE); } catch {}
    try { fs.unlinkSync(AUDIT_FILE + '.lock'); } catch {}
}

// Fake req: EventEmitter con socket/headers/method/url + destroy().
function makeReq({ method = 'POST', url = '/dashboard/alert/ack', remoteAddress = '127.0.0.1', headers = {} } = {}) {
    const req = new EventEmitter();
    req.method = method;
    req.url = url;
    req.headers = Object.assign({ 'content-type': 'application/json' }, headers);
    req.socket = { remoteAddress };
    req.destroyed = false;
    req.destroy = () => { req.destroyed = true; };
    return req;
}

// Fake res que captura statusCode + body y resuelve una promesa en end().
function makeRes() {
    let resolve;
    const done = new Promise((r) => { resolve = r; });
    const res = {
        statusCode: null,
        headers: null,
        body: '',
        writeHead(status, headers) { this.statusCode = status; this.headers = headers; },
        end(chunk) { if (chunk) this.body += chunk; resolve(); },
        done,
    };
    return res;
}

// Helper: invoca el handler y, si hay body, lo emite tras adjuntar listeners.
async function invoke(reqOpts, body) {
    resetFs();
    const req = makeReq(reqOpts);
    const res = makeRes();
    const handled = handleAlertMutation(req, res);
    // Emitir el body en el próximo tick (el handler ya adjuntó listeners).
    if (body !== undefined) {
        process.nextTick(() => {
            req.emit('data', Buffer.from(body));
            req.emit('end');
        });
    }
    await res.done;
    return { handled, res, req };
}

test('ruta ajena no se maneja (devuelve false)', () => {
    const req = makeReq({ url: '/api/dash/header' });
    const res = makeRes();
    assert.equal(handleAlertMutation(req, res), false);
});

test('método incorrecto → 405', async () => {
    const { handled, res } = await invoke({ method: 'GET' });
    assert.equal(handled, true);
    assert.equal(res.statusCode, 405);
});

test('no-loopback → 403 (REQ-SEC-1/7)', async () => {
    const { res } = await invoke({ remoteAddress: '10.0.0.5' });
    assert.equal(res.statusCode, 403);
});

test('cross-site (Sec-Fetch-Site) → 403 (anti-CSRF)', async () => {
    const { res } = await invoke({ headers: { 'sec-fetch-site': 'cross-site' } });
    assert.equal(res.statusCode, 403);
});

test('Content-Type no JSON → 415', async () => {
    const { res } = await invoke({ headers: { 'content-type': 'text/plain' } });
    assert.equal(res.statusCode, 415);
});

test('body sobre el cap → 413 (REQ-SEC-8)', async () => {
    const big = 'x'.repeat(ALERT_BODY_MAX_BYTES + 10);
    const { res, req } = await invoke({ url: '/dashboard/alert/ack' }, JSON.stringify({ alertId: 'a', justification: big }));
    assert.equal(res.statusCode, 413);
    assert.equal(req.destroyed, true, 'la conexión se corta ante body grande');
});

test('ack válido → 200 + persiste con actor server-side fijo', async () => {
    const { res } = await invoke({ url: '/dashboard/alert/ack' }, JSON.stringify({ alertId: 'cuota:exhausted', actor: 'attacker' }));
    assert.equal(res.statusCode, 200);
    const entries = ata.tail(1);
    assert.equal(entries[0].actor, 'operador-local', 'el actor del body se ignora (REQ-SEC-3)');
    assert.equal(entries[0].action, 'ack');
});

test('snooze válido (4h) → 200', async () => {
    const { res } = await invoke({ url: '/dashboard/alert/snooze' }, JSON.stringify({ alertId: 'infra:dns', hours: 4 }));
    assert.equal(res.statusCode, 200);
    assert.equal(ata.tail(1)[0].snooze_hours, 4);
});

test('snooze fuera de allowlist → 400', async () => {
    const { res } = await invoke({ url: '/dashboard/alert/snooze' }, JSON.stringify({ alertId: 'infra:dns', hours: 2 }));
    assert.equal(res.statusCode, 400);
});

test('alertId inválido → 400', async () => {
    const { res } = await invoke({ url: '/dashboard/alert/ack' }, JSON.stringify({ alertId: '../etc' }));
    assert.equal(res.statusCode, 400);
});

test('JSON inválido → 400', async () => {
    const { res } = await invoke({ url: '/dashboard/alert/ack' }, '{not-json');
    assert.equal(res.statusCode, 400);
});

test('respuestas mutantes llevan no-store + nosniff', async () => {
    const { res } = await invoke({ url: '/dashboard/alert/ack' }, JSON.stringify({ alertId: 'pulpo:down' }));
    assert.match(res.headers['Cache-Control'], /no-store/);
    assert.equal(res.headers['X-Content-Type-Options'], 'nosniff');
});
