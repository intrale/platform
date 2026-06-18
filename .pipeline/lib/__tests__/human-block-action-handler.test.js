// Tests de .pipeline/lib/human-block-action-handler.js (issue #4068)
// Cubren el gate CA-Sec del endpoint POST /api/human-block/action:
// 403 no-loopback / 403 cross-origin / 415 Content-Type / 400 issue inválido /
// 400 action inválida / 401 token inválido-expirado-reusado / happy-path con
// ejecución + audit. Token y módulos inyectados → test hermético.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

const { handle } = require('../human-block-action-handler');
const { createTokenSigner } = require('../action-token');
const realHumanBlock = require('../human-block');

function tmpNonceFile() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hbah-'));
    return path.join(dir, 'used.jsonl');
}

// Fake response que captura status + body.
function fakeRes() {
    return {
        statusCode: null,
        body: null,
        writeHead(code) { this.statusCode = code; return this; },
        end(payload) { this.body = payload ? JSON.parse(payload) : null; this._done = true; },
    };
}

// Fake request: EventEmitter con headers/method/socket; emite el body en next tick.
function fakeReq({ method = 'POST', remote = '127.0.0.1', headers = {}, body = '' } = {}) {
    const req = new EventEmitter();
    req.method = method;
    req.socket = { remoteAddress: remote };
    req.headers = Object.assign({ 'content-type': 'application/json' }, headers);
    req.destroy = () => {};
    process.nextTick(() => {
        if (body) req.emit('data', Buffer.from(body));
        req.emit('end');
    });
    return req;
}

// humanBlock parcial: validación real + ejecución/audit capturadas.
function fakeHumanBlock() {
    const executed = [];
    const audited = [];
    return {
        executed, audited,
        isQuickAction: realHumanBlock.isQuickAction,
        executeQuickAction: ({ issue, action }) => { executed.push({ issue, action }); return { ok: true, action, issue, msg: `ok ${action} #${issue}` }; },
        auditQuickAction: (entry) => { audited.push(entry); return entry; },
    };
}

function makeDeps(nonceFile) {
    const signer = createTokenSigner({ secret: 'test-secret', nonceFile: nonceFile || tmpNonceFile() });
    const hb = fakeHumanBlock();
    return { signer, hb, deps: { actionToken: signer, humanBlock: hb, log: () => {} } };
}

// Helper: corre handle y espera al end async.
function run(req, deps) {
    const res = fakeRes();
    return new Promise((resolve) => {
        const orig = res.end.bind(res);
        res.end = (p) => { orig(p); resolve(res); };
        handle(req, res, deps);
    });
}

test('403 si la request NO es loopback', async () => {
    const { deps } = makeDeps();
    const res = await run(fakeReq({ remote: '10.0.0.5' }), deps);
    assert.equal(res.statusCode, 403);
});

test('403 si Origin es cross-origin', async () => {
    const { deps } = makeDeps();
    const res = await run(fakeReq({ headers: { origin: 'http://evil.example.com' } }), deps);
    assert.equal(res.statusCode, 403);
});

test('415 si Content-Type no es application/json', async () => {
    const { deps } = makeDeps();
    const res = await run(fakeReq({ headers: { 'content-type': 'text/plain' } }), deps);
    assert.equal(res.statusCode, 415);
});

test('405 si el método no es POST', async () => {
    const { deps } = makeDeps();
    const res = await run(fakeReq({ method: 'GET' }), deps);
    assert.equal(res.statusCode, 405);
});

test('400 si issue no es ^\\d+$', async () => {
    const { signer, deps } = makeDeps();
    const token = signer.sign({ issue: 5, action: 'unblock' });
    const res = await run(fakeReq({ body: JSON.stringify({ issue: '5x', action: 'unblock', token }) }), deps);
    assert.equal(res.statusCode, 400);
});

test('400 si action está fuera de la allowlist', async () => {
    const { deps } = makeDeps();
    const res = await run(fakeReq({ body: JSON.stringify({ issue: '5', action: 'pausar', token: 'x' }) }), deps);
    assert.equal(res.statusCode, 400);
});

test('401 con copy amable si el token es inválido', async () => {
    const { hb, deps } = makeDeps();
    const res = await run(fakeReq({ body: JSON.stringify({ issue: '5', action: 'unblock', token: 'v1.bad.sig' }) }), deps);
    assert.equal(res.statusCode, 401);
    assert.equal(res.body.reason, 'invalid');
    assert.match(res.body.msg, /Enlace inválido/);
    // CA-SEC-2: el rechazo también se auditó como unauthorized.
    assert.ok(hb.audited.some(a => a.result_status === 'unauthorized'));
    assert.equal(hb.executed.length, 0, 'no ejecutó nada');
});

test('401 si el token expiró', async () => {
    let clock = 1_000_000;
    const signer = createTokenSigner({ secret: 's', nonceFile: tmpNonceFile(), ttlMs: 1000, now: () => clock });
    const hb = fakeHumanBlock();
    const token = signer.sign({ issue: 5, action: 'unblock' });
    clock += 5000;
    const res = await run(fakeReq({ body: JSON.stringify({ issue: '5', action: 'unblock', token }) }), { actionToken: signer, humanBlock: hb });
    assert.equal(res.statusCode, 401);
    assert.equal(res.body.reason, 'expired');
});

test('401 replayed si el token ya fue usado', async () => {
    const nonceFile = tmpNonceFile();
    const { signer, deps } = makeDeps(nonceFile);
    const token = signer.sign({ issue: 5, action: 'unblock' });
    const first = await run(fakeReq({ body: JSON.stringify({ issue: '5', action: 'unblock', token }) }), deps);
    assert.equal(first.statusCode, 200);
    const second = await run(fakeReq({ body: JSON.stringify({ issue: '5', action: 'unblock', token }) }), deps);
    assert.equal(second.statusCode, 401);
    assert.equal(second.body.reason, 'replayed');
});

test('401 mismatch si el token es de otro issue/action (binding)', async () => {
    const { signer, hb, deps } = makeDeps();
    const token = signer.sign({ issue: 5, action: 'unblock' }); // token para issue 5
    const res = await run(fakeReq({ body: JSON.stringify({ issue: '6', action: 'unblock', token }) }), deps);
    assert.equal(res.statusCode, 401);
    assert.equal(res.body.reason, 'mismatch');
    assert.equal(hb.executed.length, 0);
});

test('400 si el body no es JSON válido', async () => {
    const { deps } = makeDeps();
    const res = await run(fakeReq({ body: '{no-json' }), deps);
    assert.equal(res.statusCode, 400);
});

test('500 si executeQuickAction devuelve ok:false', async () => {
    const signer = createTokenSigner({ secret: 's', nonceFile: tmpNonceFile() });
    const hb = fakeHumanBlock();
    hb.executeQuickAction = ({ issue, action }) => { hb.executed.push({ issue, action }); return { ok: false, error: 'falló adrede' }; };
    const token = signer.sign({ issue: 5, action: 'unblock' });
    const res = await run(fakeReq({ body: JSON.stringify({ issue: '5', action: 'unblock', token }) }), { actionToken: signer, humanBlock: hb });
    assert.equal(res.statusCode, 500);
    assert.ok(hb.audited.some(a => a.result_status === 'error'));
});

test('500 si executeQuickAction lanza', async () => {
    const signer = createTokenSigner({ secret: 's', nonceFile: tmpNonceFile() });
    const hb = fakeHumanBlock();
    hb.executeQuickAction = () => { throw new Error('boom'); };
    const token = signer.sign({ issue: 5, action: 'unblock' });
    const res = await run(fakeReq({ body: JSON.stringify({ issue: '5', action: 'unblock', token }) }), { actionToken: signer, humanBlock: hb });
    assert.equal(res.statusCode, 500);
});

test('happy-path: token válido ejecuta la acción y asienta audit authorized', async () => {
    const { signer, hb, deps } = makeDeps();
    const token = signer.sign({ issue: 4068, action: 'priorizar' });
    const res = await run(fakeReq({ body: JSON.stringify({ issue: '4068', action: 'priorizar', token }) }), deps);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.ok, true);
    assert.deepEqual(hb.executed, [{ issue: 4068, action: 'priorizar' }]);
    const authd = hb.audited.find(a => a.result_status === 'authorized');
    assert.ok(authd, 'auditó authorized');
    assert.equal(authd.from, 'dashboard-local', 'identidad server-derived');
    assert.equal(authd.remote_address, '127.0.0.1');
});
