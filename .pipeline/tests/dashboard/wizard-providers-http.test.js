// =============================================================================
// wizard-providers-http.test.js — integración sobre wizard-session.route().
//
// Cubre CA-7 (Cache-Control: no-store), CA-9 (CSRF/Origin → 403), el happy path
// de los 4 pasos (persistencia + masking en la respuesta) y la defensa de
// allowlist de provider (R#4 → 409). Sin puppeteer: se monta el flow real sobre
// la base y se ejercita vía HTTP fake.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ws = require('../../lib/wizard-session');
const providers = require('../../lib/wizards/providers');
const { fakeHttpReq, fakeHttpRes } = require('../../lib/__tests__/_test-helpers');

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'wz-providers-http-')); }

function seedFlow(dir) {
    const credentialsPath = path.join(dir, 'credentials.json');
    fs.writeFileSync(credentialsPath, JSON.stringify({
        telegram: { bot_token: 'TG' },
        providers: { openai: { api_key: 'sk-' + 'O'.repeat(48) }, anthropic: { api_key: 'sk-ant-' + 'A'.repeat(48) } },
    }, null, 2), 'utf8');
    ws._resetForTests();
    ws._setAuditDirForTests(fs.mkdtempSync(path.join(os.tmpdir(), 'wz-base-audit-')));
    ws.registerFlow('providers', providers.createFlow({ credentialsPath, auditDir: dir }));
    return credentialsPath;
}

function validHeaders(extra = {}) {
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

async function call({ headers, body }) {
    const req = fakeHttpReq({ url: '/dashboard/wizard/providers/step', method: 'POST', headers, body });
    const res = fakeHttpRes();
    const handled = ws.route(req, res);
    if (!handled) return { handled: false, res };
    req._emitBody();
    await res.done;
    let json = null;
    try { json = JSON.parse(res._body); } catch { /* sin json */ }
    return { handled: true, res, json };
}

test('POST sin CSRF → 403 (CA-9)', async () => {
    seedFlow(tmpDir());
    const headers = validHeaders();
    delete headers['x-csrf-token'];
    const { res } = await call({ headers, body: JSON.stringify({ step: 0, params: { provider: 'openai' } }) });
    assert.equal(res._status, 403);
});

test('toda respuesta lleva Cache-Control: no-store (CA-7)', async () => {
    seedFlow(tmpDir());
    const { res } = await call({ headers: validHeaders(), body: JSON.stringify({ step: 0, params: { provider: 'openai' } }) });
    assert.equal(res._status, 200);
    assert.equal(res._headers['Cache-Control'], 'no-store');
});

test('provider fuera de la allowlist → 409 sin tocar disco (R#4)', async () => {
    const dir = tmpDir();
    const credentialsPath = seedFlow(dir);
    const before = fs.readFileSync(credentialsPath, 'utf8');
    const { res } = await call({ headers: validHeaders(), body: JSON.stringify({ step: 0, params: { provider: '../etc/passwd' } }) });
    assert.equal(res._status, 409);
    assert.equal(fs.readFileSync(credentialsPath, 'utf8'), before);
});

test('happy path 4 pasos: rota, responde masked y persiste (CA-3/CA-5/CA-6)', async () => {
    const dir = tmpDir();
    const credentialsPath = seedFlow(dir);
    const newKey = 'sk-' + 'N'.repeat(44) + 'LAST';

    const s0 = await call({ headers: validHeaders(), body: JSON.stringify({ step: 0, params: { provider: 'openai' } }) });
    assert.equal(s0.res._status, 200);
    const sid = s0.json.wizard_session_id;
    assert.ok(sid);

    const s1 = await call({ headers: validHeaders(), body: JSON.stringify({ step: 1, wizard_session_id: sid, params: { provider: 'openai', action: 'rotate' } }) });
    assert.equal(s1.res._status, 200);

    const s2 = await call({ headers: validHeaders(), body: JSON.stringify({ step: 2, wizard_session_id: sid, params: { provider: 'openai', action: 'rotate', api_key: newKey } }) });
    assert.equal(s2.res._status, 200);
    assert.equal(s2.json.result.masked_new, 'sk-•••••LAST');
    // La respuesta NUNCA trae la key cruda.
    assert.ok(!s2.res._body.includes(newKey));

    const s3 = await call({ headers: validHeaders(), body: JSON.stringify({ step: 3, wizard_session_id: sid, params: { provider: 'openai', action: 'rotate', confirm: true } }) });
    assert.equal(s3.res._status, 200);
    assert.equal(s3.json.result.ok, true);
    assert.ok(!s3.res._body.includes(newKey));

    const data = JSON.parse(fs.readFileSync(credentialsPath, 'utf8'));
    assert.equal(data.providers.openai.api_key, newKey);
    assert.equal(data.telegram.bot_token, 'TG');
});

test('key con formato inválido en step 2 → 409 (CA-4)', async () => {
    const dir = tmpDir();
    seedFlow(dir);
    const s0 = await call({ headers: validHeaders(), body: JSON.stringify({ step: 0, params: { provider: 'openai' } }) });
    const sid = s0.json.wizard_session_id;
    await call({ headers: validHeaders(), body: JSON.stringify({ step: 1, wizard_session_id: sid, params: { provider: 'openai', action: 'rotate' } }) });
    const s2 = await call({ headers: validHeaders(), body: JSON.stringify({ step: 2, wizard_session_id: sid, params: { provider: 'openai', action: 'rotate', api_key: 'sk-short' } }) });
    assert.equal(s2.res._status, 409);
});
