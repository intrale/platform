// =============================================================================
// wizard-session.test.js — 21 tests del security plan (#3724 / CA-G3).
//
// Cubre: CSRF (HMAC HttpOnly), Sec-Fetch-Site, Origin allowlist, métodos,
// content-type, flow allowlist, step range, idempotencia (secuencial +
// concurrente), timeout 15min, session-fixation, body cap, rate-limit,
// redacción de audit, hash-chain y uso de `crypto.timingSafeEqual`.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const { fakeHttpReq, fakeHttpRes } = require('./_test-helpers');
const ws = require('../wizard-session');
const audit = require('../audit-log');

const TMP_AUDIT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'wizard-audit-'));

// Construye headers CSRF válidos (cookie + token derivado) + same-origin.
function validSecurityHeaders(extra = {}) {
    const { raw } = ws._csrf.newCsrfCookie();
    const token = ws._csrf.deriveCsrfToken(raw);
    return {
        cookie: `wizard_csrf=${raw}`,
        'x-csrf-token': token,
        'sec-fetch-site': 'same-origin',
        origin: 'http://127.0.0.1:3200',
        'content-type': 'application/json',
        ...extra,
    };
}

// Ejecuta una request contra el router y espera la respuesta.
async function call({ url = '/dashboard/wizard/__test/step', method = 'POST', headers = {}, body = '' } = {}) {
    const req = fakeHttpReq({ url, method, headers, body });
    const res = fakeHttpRes();
    const handled = ws.route(req, res);
    if (!handled) return { handled: false, res };
    if (method === 'POST') req._emitBody();
    await res.done;
    let json = null;
    try { json = JSON.parse(res._body); } catch { /* sin body json */ }
    return { handled: true, res, json };
}

// Flow de test fresco. `counter` cuenta ejecuciones reales de executeStep.
function freshFlow({ maxStep = 5 } = {}) {
    ws._resetForTests();
    ws._setAuditDirForTests(TMP_AUDIT_DIR);
    ws._allowTestFlow('__test');
    const state = { counter: 0 };
    ws.registerFlow('__test', {
        maxStep,
        validateStep: (step) => step >= 0 && step <= maxStep,
        executeStep: (session, step) => { state.counter += 1; return { step, ok: true, n: state.counter }; },
    });
    return state;
}

// Crea una sesión (step 0) y devuelve su id.
async function startSession() {
    const { json } = await call({ headers: validSecurityHeaders(), body: JSON.stringify({ step: 0 }) });
    return json.wizard_session_id;
}

test('1 · CSRF positivo (cookie + header HMAC válido) → 200', async () => {
    freshFlow();
    const { res, json } = await call({ headers: validSecurityHeaders(), body: JSON.stringify({ step: 0 }) });
    assert.equal(res._status, 200);
    assert.equal(json.status, 'ok');
    assert.ok(json.wizard_session_id);
});

test('2 · CSRF negativo — sin header → 403', async () => {
    freshFlow();
    const { raw } = ws._csrf.newCsrfCookie();
    const headers = validSecurityHeaders();
    headers.cookie = `wizard_csrf=${raw}`;
    delete headers['x-csrf-token'];
    const { res } = await call({ headers, body: JSON.stringify({ step: 0 }) });
    assert.equal(res._status, 403);
});

test('3 · CSRF negativo — header HMAC inválido → 403', async () => {
    freshFlow();
    const headers = validSecurityHeaders();
    headers['x-csrf-token'] = 'token-falso-invalido';
    const { res } = await call({ headers, body: JSON.stringify({ step: 0 }) });
    assert.equal(res._status, 403);
});

test('4 · CSRF negativo — cookie missing → 403', async () => {
    freshFlow();
    const headers = validSecurityHeaders();
    delete headers.cookie;
    const { res } = await call({ headers, body: JSON.stringify({ step: 0 }) });
    assert.equal(res._status, 403);
});

test('5 · Sec-Fetch-Site: cross-site → 403', async () => {
    freshFlow();
    const headers = validSecurityHeaders({ 'sec-fetch-site': 'cross-site' });
    const { res } = await call({ headers, body: JSON.stringify({ step: 0 }) });
    assert.equal(res._status, 403);
});

test('6 · Sec-Fetch-Site: same-origin → 200', async () => {
    freshFlow();
    const headers = validSecurityHeaders({ 'sec-fetch-site': 'same-origin' });
    const { res } = await call({ headers, body: JSON.stringify({ step: 0 }) });
    assert.equal(res._status, 200);
});

test('7 · Origin no allowlisted (http://evil.local:3200) → 403', async () => {
    freshFlow();
    const headers = validSecurityHeaders({ origin: 'http://evil.local:3200' });
    const { res } = await call({ headers, body: JSON.stringify({ step: 0 }) });
    assert.equal(res._status, 403);
});

test('8 · Método GET → 405', async () => {
    freshFlow();
    const { res } = await call({ method: 'GET', headers: validSecurityHeaders() });
    assert.equal(res._status, 405);
});

test('9 · Content-Type ≠ application/json → 415', async () => {
    freshFlow();
    const headers = validSecurityHeaders({ 'content-type': 'text/plain' });
    const { res } = await call({ headers, body: JSON.stringify({ step: 0 }) });
    assert.equal(res._status, 415);
});

test('10 · Flow no allowed (__proto__, ../x) → 404', async () => {
    freshFlow();
    const a = await call({ url: '/dashboard/wizard/__proto__/step', headers: validSecurityHeaders(), body: JSON.stringify({ step: 0 }) });
    assert.equal(a.res._status, 404);
    const b = await call({ url: '/dashboard/wizard/..%2Fx/step', headers: validSecurityHeaders(), body: JSON.stringify({ step: 0 }) });
    assert.equal(b.res._status, 404);
});

test('11 · Step inválido: no-entero → 400; fuera de rango → 409', async () => {
    freshFlow({ maxStep: 3 });
    const id = await startSession();
    const noInt = await call({ headers: validSecurityHeaders(), body: JSON.stringify({ wizard_session_id: id, step: 1.5 }) });
    assert.equal(noInt.res._status, 400);
    const over = await call({ headers: validSecurityHeaders(), body: JSON.stringify({ wizard_session_id: id, step: 99 }) });
    assert.equal(over.res._status, 409);
    const neg = await call({ headers: validSecurityHeaders(), body: JSON.stringify({ wizard_session_id: id, step: -1 }) });
    assert.equal(neg.res._status, 409);
});

test('12 · Idempotencia: doble POST (session_id, step=N) → acción 1 sola vez', async () => {
    const state = freshFlow();
    const id = await startSession();
    const baseCounter = state.counter;
    const first = await call({ headers: validSecurityHeaders(), body: JSON.stringify({ wizard_session_id: id, step: 2 }) });
    const second = await call({ headers: validSecurityHeaders(), body: JSON.stringify({ wizard_session_id: id, step: 2 }) });
    assert.equal(first.res._status, 200);
    assert.equal(second.res._status, 200);
    assert.equal(state.counter - baseCounter, 1, 'executeStep corrió una sola vez');
    assert.deepEqual(first.json.result, second.json.result, 'response result idéntica');
    assert.equal(second.json.status, 'idempotent_replay');
});

test('13 · Concurrencia idem: Promise.all mismo (session_id, step) → 1 acción (mutex)', async () => {
    const state = freshFlow();
    const id = await startSession();
    const baseCounter = state.counter;
    const [a, b] = await Promise.all([
        call({ headers: validSecurityHeaders(), body: JSON.stringify({ wizard_session_id: id, step: 1 }) }),
        call({ headers: validSecurityHeaders(), body: JSON.stringify({ wizard_session_id: id, step: 1 }) }),
    ]);
    assert.equal(a.res._status, 200);
    assert.equal(b.res._status, 200);
    assert.equal(state.counter - baseCounter, 1, 'mutex evitó doble ejecución');
    assert.deepEqual(a.json.result, b.json.result);
});

test('14 · Timeout 15min → 410 + remove del store', async () => {
    freshFlow();
    const id = await startSession();
    const realNow = Date.now;
    try {
        Date.now = () => realNow() + ws.SESSION_TTL_MS + 1000;
        const { res } = await call({ headers: validSecurityHeaders(), body: JSON.stringify({ wizard_session_id: id, step: 1 }) });
        assert.equal(res._status, 410);
        // tras el 410 la sesión fue eliminada: un nuevo POST al mismo id → 404.
        const again = await call({ headers: validSecurityHeaders(), body: JSON.stringify({ wizard_session_id: id, step: 1 }) });
        assert.equal(again.res._status, 404);
    } finally {
        Date.now = realNow;
    }
});

test('15 · Session unknown (id válido pero inexistente, step > 0) → 404', async () => {
    freshFlow();
    const { res } = await call({ headers: validSecurityHeaders(), body: JSON.stringify({ wizard_session_id: 'no-existe-en-store', step: 1 }) });
    assert.equal(res._status, 404);
});

test('16 · Session fixation: step 0 con id provisto → server lo ignora y emite uno nuevo', async () => {
    freshFlow();
    const provided = 'cliente-eligio-este-id';
    const { res, json } = await call({ headers: validSecurityHeaders(), body: JSON.stringify({ step: 0, wizard_session_id: provided }) });
    assert.equal(res._status, 200);
    assert.notEqual(json.wizard_session_id, provided);
    assert.ok(json.wizard_session_id.length > 0);
});

test('17 · Body > 8KB → 413', async () => {
    freshFlow();
    const big = JSON.stringify({ step: 0, blob: 'x'.repeat(ws.MAX_BODY_BYTES + 100) });
    const { res } = await call({ headers: validSecurityHeaders(), body: big });
    assert.equal(res._status, 413);
});

test('18 · Rate limit: 31 sesiones nuevas del mismo Origin en 1 min → 31ª → 429', async () => {
    freshFlow();
    let last;
    for (let i = 0; i < ws.RATE_LIMIT_PER_MIN + 1; i++) {
        last = await call({ headers: validSecurityHeaders(), body: JSON.stringify({ step: 0 }) });
    }
    assert.equal(last.res._status, 429);
});

test('19 · Redacción audit: api_key y jwt no aparecen en claro en el NDJSON', async () => {
    freshFlow();
    const apiKey = 'sk-ant-supersecreto1234567890abcdef';
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.firmaSecreta';
    const ymd = new Date().toISOString().slice(0, 10);
    const file = path.join(TMP_AUDIT_DIR, `wizard-audit-${ymd}.ndjson`);
    if (fs.existsSync(file)) fs.unlinkSync(file);
    const id = await startSession();
    await call({ headers: validSecurityHeaders(), body: JSON.stringify({ wizard_session_id: id, step: 1, params: { api_key: apiKey, jwt } }) });
    const content = fs.readFileSync(file, 'utf8');
    assert.equal(content.includes(apiKey), false, 'api_key no debe aparecer en claro');
    assert.equal(content.includes(jwt), false, 'jwt no debe aparecer en claro');
    assert.ok(content.includes('[REDACTED]'), 'debe haber marcador de redacción');
});

test('20 · Hash-chain audit: 3 entries → verifyChain ok', async () => {
    freshFlow({ maxStep: 3 });
    const ymd = new Date().toISOString().slice(0, 10);
    const file = path.join(TMP_AUDIT_DIR, `wizard-chain-test-${process.pid}.ndjson`);
    if (fs.existsSync(file)) fs.unlinkSync(file);
    // Aislamos en un archivo propio re-apuntando el dir de audit a un subdir único.
    const subdir = fs.mkdtempSync(path.join(TMP_AUDIT_DIR, 'chain-'));
    ws._setAuditDirForTests(subdir);
    const id = await startSession();
    await call({ headers: validSecurityHeaders(), body: JSON.stringify({ wizard_session_id: id, step: 1 }) });
    await call({ headers: validSecurityHeaders(), body: JSON.stringify({ wizard_session_id: id, step: 2 }) });
    const chainFile = path.join(subdir, `wizard-audit-${ymd}.ndjson`);
    const result = audit.verifyChain(chainFile);
    assert.equal(result.ok, true);
    assert.equal(result.entriesChecked, 3);
    ws._setAuditDirForTests(TMP_AUDIT_DIR);
});

test('21 · crypto.timingSafeEqual se usa para comparar el CSRF', async () => {
    freshFlow();
    const original = crypto.timingSafeEqual;
    let called = false;
    crypto.timingSafeEqual = (a, b) => { called = true; return original(a, b); };
    try {
        await call({ headers: validSecurityHeaders(), body: JSON.stringify({ step: 0 }) });
    } finally {
        crypto.timingSafeEqual = original;
    }
    assert.equal(called, true, 'verifyCsrf debe usar crypto.timingSafeEqual, no === ni Buffer.compare');
});

test('extra · todo setInterval del módulo usa .unref() (no bloquea shutdown)', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'wizard-session.js'), 'utf8');
    const intervals = src.match(/setInterval\s*\([^)]*\)/g) || [];
    assert.ok(intervals.length >= 1, 'debe existir al menos un setInterval (sweeper)');
    // Cada setInterval debe estar inmediatamente seguido de `.unref()`.
    const withUnref = src.match(/setInterval\s*\([^;]*\)\.unref\(\)/g) || [];
    assert.equal(withUnref.length, intervals.length, 'todos los setInterval deben encadenar .unref()');
});
