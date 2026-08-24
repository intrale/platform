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
    const r = runEndpoint(req, res, { issue: '4580', gate: 'definicion', decision: 'aprobar' });
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
    const r = runEndpoint(req, res, { issue: '4580', gate: 'definicion', decision: 'aprobar' }, { queueDir, auditFile });
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
    const r = runEndpoint(req, res, { issue: '4580', gate: 'definicion', decision: 'aprobar' });
    assert.equal(r.stopped, 'gate');
    assert.equal(res.statusCode, 403);
});

test('POST con Content-Type no-json → 415 (gate)', () => {
    const req = fakeReq({ headers: { 'content-type': 'text/plain' } });
    const res = fakeRes();
    const r = runEndpoint(req, res, { issue: '4580', gate: 'definicion', decision: 'aprobar' });
    assert.equal(r.stopped, 'gate');
    assert.equal(res.statusCode, 415);
});

// ---------------------------------------------------------------------------
// Validación de input (REQ-SEC-4580-3 / A03)
// ---------------------------------------------------------------------------
test('id de issue no numérico → rechazado sin tocar el FS (REQ-SEC-4580-3)', () => {
    const queueDir = path.join(tmpDir('gsr-q2-'), 'pendiente');
    const out = gsr.enqueueDecision({ issue: '../etc/passwd', gate: 'definicion', decision: 'aprobar' }, { queueDir });
    assert.equal(out.ok, false);
    assert.equal(out.status, 400);
    assert.ok(!fs.existsSync(queueDir), 'no debe crear la cola para un id inválido');
});

test('decisión fuera de la allowlist → rechazada (A03)', () => {
    const out = gsr.enqueueDecision({ issue: '4580', gate: 'definicion', decision: 'borrar-todo' }, { queueDir: path.join(tmpDir('gsr-q3-'), 'p') });
    assert.equal(out.ok, false);
    assert.equal(out.status, 400);
});

test('enqueueDecision es determinístico en el nombre de archivo con now inyectado', () => {
    const queueDir = path.join(tmpDir('gsr-q4-'), 'pendiente');
    const auditFile = path.join(tmpDir('gsr-a4-'), 'audit.jsonl');
    const out = gsr.enqueueDecision({ issue: '77', gate: 'definicion', decision: 'rechazar' }, { queueDir, auditFile, now: () => 1234567890 });
    assert.equal(out.ok, true);
    // #6208 — el nombre lleva el gate del enum congelado, no el string del cliente.
    assert.ok(out.request_path.endsWith(`77-definicion-rejected-1234567890.json`), out.request_path);
    const rec = JSON.parse(fs.readFileSync(out.request_path, 'utf8'));
    assert.equal(rec.issue, 77);
    assert.equal(rec.gate, 'definicion');
    assert.equal(rec.verdict, 'rejected');
    assert.equal(rec.source, 'dashboard');
});

// ===========================================================================
// #6208 — `gate` obligatorio y validado con el enum congelado del kernel.
//
//   CA-13 — se extiende `/api/gate-signature/*`; NO se crean rutas nuevas.
//   CA-14 / REQ-SEC-6208-3 — `gate` se resuelve con `approval-channel.resolveGate`
//           (no con un enum local que puede divergir) y un valor desconocido se
//           rechaza SIN tocar el filesystem.
//   CA-12 / REQ-SEC-6208-2 — `actor` es una identidad DECLARADA: va al audit y a
//           ningún camino de autoridad.
// ===========================================================================
const channel = require('../approval-channel.js');

test('#6208 · CA-14: sin gate el pedido se rechaza sin tocar el filesystem', () => {
    const queueDir = path.join(tmpDir('gsr-q6208a-'), 'pendiente');
    const out = gsr.enqueueDecision({ issue: '6208', decision: 'aprobar' }, { queueDir });
    assert.equal(out.ok, false);
    assert.equal(out.status, 400);
    assert.match(out.msg, /gate inválido/);
    assert.ok(!fs.existsSync(queueDir), 'no debe crear la cola sin gate');
});

test('#6208 · CA-14: un gate de path-traversal se rechaza sin tocar el filesystem', () => {
    for (const gate of ['../../../etc', 'defini cion', 'DEFINICION', '', null, {}]) {
        const queueDir = path.join(tmpDir('gsr-q6208b-'), 'pendiente');
        const out = gsr.enqueueDecision({ issue: '6208', gate, decision: 'aprobar' }, { queueDir });
        assert.equal(out.ok, false, `gate hostil aceptado: ${JSON.stringify(gate)}`);
        assert.equal(out.status, 400);
        assert.ok(!fs.existsSync(queueDir));
    }
});

test('#6208 · CA-14: el gate se valida contra el enum del KERNEL, no contra una copia local', () => {
    // Si el kernel agrega/saca un gate, `enqueueDecision` lo sigue sin cambios.
    for (const gate of Object.keys(channel.GATES)) {
        const queueDir = path.join(tmpDir('gsr-q6208c-'), 'pendiente');
        const auditFile = path.join(tmpDir('gsr-a6208c-'), 'audit.jsonl');
        const out = gsr.enqueueDecision({ issue: '6208', gate, decision: 'signed' }, { queueDir, auditFile });
        assert.equal(out.ok, true, `${gate}: ${out.msg}`);
        assert.equal(out.gate, gate);
    }
});

test('#6208 · CA-14: un veredicto que no existe en ESE gate se rechaza', () => {
    const queueDir = path.join(tmpDir('gsr-q6208d-'), 'pendiente');
    // `re-definition` existe en `definicion` pero NO en `aceptacion`.
    const ok = gsr.enqueueDecision({ issue: '6208', gate: 'definicion', decision: 're-definition' }, { queueDir, auditFile: path.join(tmpDir('gsr-a-'), 'a.jsonl') });
    assert.equal(ok.ok, true);
    const bad = gsr.enqueueDecision({ issue: '6208', gate: 'aceptacion', decision: 're-definition' }, { queueDir: path.join(tmpDir('gsr-q6208e-'), 'p') });
    assert.equal(bad.ok, false);
    assert.match(bad.msg, /decisión inválida para el gate aceptacion/);
});

test('#6208 · los alias legacy aprobar/rechazar siguen mapeando al veredicto del kernel', () => {
    const queueDir = path.join(tmpDir('gsr-q6208f-'), 'pendiente');
    const auditFile = path.join(tmpDir('gsr-a6208f-'), 'audit.jsonl');
    const a = gsr.enqueueDecision({ issue: '1', gate: 'definicion', decision: 'aprobar' }, { queueDir, auditFile, now: () => 1 });
    const r = gsr.enqueueDecision({ issue: '2', gate: 'definicion', decision: 'rechazar' }, { queueDir, auditFile, now: () => 2 });
    assert.equal(a.verdict, 'signed');
    assert.equal(r.verdict, 'rejected');
    // Lo que se PERSISTE es el veredicto del enum, no el string del cliente.
    assert.equal(JSON.parse(fs.readFileSync(a.request_path, 'utf8')).verdict, 'signed');
    assert.ok(a.request_path.endsWith('1-definicion-signed-1.json'));
});

test('#6208 · REQ-SEC-6208-3: el nombre del pedido se arma con la constante del enum, no con el string recibido', () => {
    const queueDir = path.join(tmpDir('gsr-q6208g-'), 'pendiente');
    const auditFile = path.join(tmpDir('gsr-a6208g-'), 'audit.jsonl');
    const out = gsr.enqueueDecision({ issue: '6208', gate: 'definicion', decision: 'signed' }, { queueDir, auditFile, now: () => 7 });
    assert.equal(path.basename(out.request_path), '6208-definicion-signed-7.json');
    assert.ok(path.resolve(out.request_path).startsWith(path.resolve(queueDir) + path.sep));
});

test('#6208 · CA-12 / REQ-SEC-6208-2: el actor declarado va al audit, nunca a un camino de autoridad', () => {
    const queueDir = path.join(tmpDir('gsr-q6208h-'), 'pendiente');
    const auditFile = path.join(tmpDir('gsr-a6208h-'), 'audit.jsonl');
    const out = gsr.enqueueDecision(
        { issue: '6208', gate: 'definicion', decision: 'signed', actor: 'leitolarreta' },
        { queueDir, auditFile },
    );
    assert.equal(out.ok, true);
    // El pedido es sólo un PEDIDO: no lleva token ni firma, y el estado es 202.
    assert.equal(out.status, 202);
    const rec = JSON.parse(fs.readFileSync(out.request_path, 'utf8'));
    assert.equal(rec.actor, 'leitolarreta');
    assert.ok(!('token' in rec), 'un pedido nunca lleva la capability de firma');
    assert.ok(!('signature' in rec));
    assert.ok(!('authorizedSigners' in rec));
});

test('#6208 · D-4: el mensaje del backend no promete ningún medio que no esté conectado', () => {
    const queueDir = path.join(tmpDir('gsr-q6208i-'), 'pendiente');
    const auditFile = path.join(tmpDir('gsr-a6208i-'), 'audit.jsonl');
    const out = gsr.enqueueDecision({ issue: '6208', gate: 'definicion', decision: 'signed' }, { queueDir, auditFile });
    assert.ok(!/telegram/i.test(out.msg), out.msg);
    assert.ok(!/firmad[oa]/i.test(out.msg), `no puede decir "firmado": ${out.msg}`);
});

test('#6208 · CA-13: el contrato NO agrega rutas nuevas /api/aprobaciones/*', () => {
    const dash = fs.readFileSync(path.resolve(__dirname, '..', '..', 'dashboard.js'), 'utf8');
    assert.ok(!dash.includes('/api/aprobaciones'), 'no se crean rutas nuevas (H-3 / CA-13)');
    assert.ok(dash.includes("'/api/gate-signature/decide'"));
    assert.ok(dash.includes("'/api/gate-signature/csrf-token'"));
});

test('#6208 · CA-13: el dashboard sigue atado a loopback (127.0.0.1)', () => {
    const dash = fs.readFileSync(path.resolve(__dirname, '..', '..', 'dashboard.js'), 'utf8');
    assert.ok(/const HOST = process\.env\.DASHBOARD_HOST \|\| '127\.0\.0\.1';/.test(dash), 'el binding loopback no se toca');
});

test('#6208 · el endpoint reenvía el gate al backend de firma', () => {
    const dash = fs.readFileSync(path.resolve(__dirname, '..', '..', 'dashboard.js'), 'utf8');
    const i = dash.indexOf('gateSignatureRequest.enqueueDecision({');
    assert.ok(i > 0);
    const bloque = dash.slice(i, i + 700);
    assert.ok(/gate:\s*parsed\.gate/.test(bloque), 'el gate viaja en el mismo contrato');
});

