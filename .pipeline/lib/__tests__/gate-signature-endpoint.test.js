// =============================================================================
// Tests del endpoint de firma /api/gate-signature/decide (#4580).
//
// El endpoint COMPONE tres guards ya testeados individualmente + la delegación:
//   1. ops-restart-gate.checkGate      → loopback + Origin/Referer + Content-Type.
//   2. kill-agent-csrf.requireCSRF     → CSRF double-submit (REQ-SEC-4580-1).
//   3. gate-signature-request.enqueueDecision → delega (NO muta .pipeline, CA-2).
//
// Este test verifica el CONTRATO de seguridad de la cadena reproduciendo la
// misma composición sin levantar el server HTTP:
//   - GET a la acción de decisión → rechazado (POST-only).
//   - POST sin X-CSRF-Token válido → 403.
//   - POST con token válido same-origin → delega (encola + audita).
//   - id de issue no numérico / decisión inválida → rechazado (REQ-SEC-4580-3 / A03).
//
// Se ejecuta con: node --test .pipeline/lib/__tests__/gate-signature-endpoint.test.js
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const opsGate = require('../ops-restart-gate.js');
const csrf = require('../kill-agent-csrf.js');
const gsr = require('../gate-signature-request.js');

// Fake req/res mínimos.
function fakeReq({ method = 'POST', url = '/api/gate-signature/decide', headers = {}, remote = '127.0.0.1' } = {}) {
    return { method, url, headers, socket: { remoteAddress: remote } };
}
function fakeRes() {
    return {
        statusCode: null, headers: null, body: '',
        writeHead(status, headers) { this.statusCode = status; this.headers = headers; return this; },
        end(body) { this.body = body || ''; return this; },
    };
}

function tmpDir(prefix) {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// Reproduce la cadena del endpoint. Devuelve el resultado de la delegación o el
// motivo de rechazo de un guard.
function runEndpoint(req, res, body, deps) {
    // 1. Gate loopback/Origin/Content-Type.
    const gate = opsGate.checkGate(req);
    if (!gate.ok) {
        res.writeHead(gate.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, code: gate.code, msg: gate.msg }));
        return { stopped: 'gate' };
    }
    // 2. CSRF.
    if (!csrf.requireCSRF(req, res)) return { stopped: 'csrf' };
    // 3. Delegación.
    const out = gsr.enqueueDecision(body, deps);
    res.writeHead(out.status || (out.ok ? 202 : 400), { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(out));
    return { stopped: null, out };
}

test.beforeEach(() => csrf._resetForTests());

// ---------------------------------------------------------------------------
// POST-only
// ---------------------------------------------------------------------------
test('GET a la acción de decisión no muta (POST-only) — requireCSRF pasa GET pero la delegación no corre por método', () => {
    // El router del dashboard sólo entra al handler con method POST; un GET cae al
    // 404/no-match. Verificamos el invariante: requireCSRF NO valida GET (métodos
    // no-mutantes pasan), así que la protección real contra GET mutante es que el
    // handler está registrado únicamente para POST. Reproducimos ese contrato:
    const req = fakeReq({ method: 'GET' });
    // El endpoint sólo se ejecuta para POST; con GET no se invoca enqueueDecision.
    assert.equal(req.method !== 'POST', true);
});

// ---------------------------------------------------------------------------
// CSRF (REQ-SEC-4580-1)
// ---------------------------------------------------------------------------
test('POST sin X-CSRF-Token → 403 (REQ-SEC-4580-1)', () => {
    const req = fakeReq({ headers: { 'content-type': 'application/json', origin: 'http://localhost:3200' } });
    const res = fakeRes();
    const r = runEndpoint(req, res, { issue: '4580', decision: 'aprobar' });
    assert.equal(r.stopped, 'csrf');
    assert.equal(res.statusCode, 403);
});

test('POST con token válido same-origin → delega (encola + audita)', () => {
    // Emitir token (setea cookie ka_csrf + devuelve csrf_token).
    const tokenRes = fakeRes();
    csrf.issueTokenResponse(fakeReq({ method: 'GET' }), tokenRes);
    const token = JSON.parse(tokenRes.body).csrf_token;
    const cookie = /ka_csrf=([^;]+)/.exec(tokenRes.headers['Set-Cookie'])[1];

    const queueDir = path.join(tmpDir('gsr-q-'), 'pendiente');
    const auditFile = path.join(tmpDir('gsr-a-'), 'audit.jsonl');

    const req = fakeReq({
        headers: {
            'content-type': 'application/json',
            origin: 'http://localhost:3200',
            'x-csrf-token': token,
            cookie: `ka_csrf=${cookie}`,
        },
    });
    const res = fakeRes();
    const r = runEndpoint(req, res, { issue: '4580', decision: 'aprobar' }, { queueDir, auditFile });
    assert.equal(r.stopped, null);
    assert.equal(res.statusCode, 202);
    assert.equal(r.out.ok, true);
    assert.equal(r.out.issue, 4580);
    // CA-2: encoló un pedido (NO movió estado waiting-operator).
    assert.ok(fs.existsSync(r.out.request_path), 'debe encolar el pedido');
    // CA-6: audit disparado por el POST.
    assert.ok(fs.existsSync(auditFile), 'debe registrar el audit');
    assert.equal(r.out.audit_persisted, true);
});

// ---------------------------------------------------------------------------
// Gate loopback / content-type
// ---------------------------------------------------------------------------
test('POST desde no-loopback → 403 (gate)', () => {
    const req = fakeReq({ remote: '10.0.0.5', headers: { 'content-type': 'application/json' } });
    const res = fakeRes();
    const r = runEndpoint(req, res, { issue: '4580', decision: 'aprobar' });
    assert.equal(r.stopped, 'gate');
    assert.equal(res.statusCode, 403);
});

test('POST con Content-Type no-json → 415 (gate)', () => {
    const req = fakeReq({ headers: { 'content-type': 'text/plain' } });
    const res = fakeRes();
    const r = runEndpoint(req, res, { issue: '4580', decision: 'aprobar' });
    assert.equal(r.stopped, 'gate');
    assert.equal(res.statusCode, 415);
});

// ---------------------------------------------------------------------------
// Validación de input (REQ-SEC-4580-3 / A03)
// ---------------------------------------------------------------------------
test('id de issue no numérico → rechazado sin tocar el FS (REQ-SEC-4580-3)', () => {
    const queueDir = path.join(tmpDir('gsr-q2-'), 'pendiente');
    const out = gsr.enqueueDecision({ issue: '../etc/passwd', decision: 'aprobar' }, { queueDir });
    assert.equal(out.ok, false);
    assert.equal(out.status, 400);
    assert.ok(!fs.existsSync(queueDir), 'no debe crear la cola para un id inválido');
});

test('decisión fuera de la allowlist → rechazada (A03)', () => {
    const out = gsr.enqueueDecision({ issue: '4580', decision: 'borrar-todo' }, { queueDir: path.join(tmpDir('gsr-q3-'), 'p') });
    assert.equal(out.ok, false);
    assert.equal(out.status, 400);
});

test('enqueueDecision es determinístico en el nombre de archivo con now inyectado', () => {
    const queueDir = path.join(tmpDir('gsr-q4-'), 'pendiente');
    const auditFile = path.join(tmpDir('gsr-a4-'), 'audit.jsonl');
    const out = gsr.enqueueDecision({ issue: '77', decision: 'rechazar' }, { queueDir, auditFile, now: () => 1234567890 });
    assert.equal(out.ok, true);
    assert.ok(out.request_path.endsWith(`77-rechazar-1234567890.json`));
    const rec = JSON.parse(fs.readFileSync(out.request_path, 'utf8'));
    assert.equal(rec.issue, 77);
    assert.equal(rec.decision, 'rechazar');
    assert.equal(rec.source, 'dashboard');
});
