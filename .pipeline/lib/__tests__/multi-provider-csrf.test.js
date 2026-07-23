// =============================================================================
// multi-provider-csrf.test.js — Tests del módulo CSRF (#3177 + #3191).
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const csrf = require('../multi-provider/csrf');

function fakeReq({ method = 'POST', cookie = '', header = '' } = {}) {
    const headers = {};
    if (cookie) headers.cookie = cookie;
    if (header) headers['x-csrf-token'] = header;
    return { method, headers };
}

function fakeRes() {
    const res = {
        _status: null, _headers: {}, _body: '',
        writeHead(status, headers) { this._status = status; this._headers = { ...this._headers, ...(headers || {}) }; },
        setHeader(k, v) { this._headers[k] = v; },
        end(body) { this._body = body || ''; },
    };
    return res;
}

test('generateToken devuelve un string base64url no vacío', () => {
    csrf._resetForTests();
    const t = csrf.generateToken();
    assert.equal(typeof t, 'string');
    assert.ok(t.length >= 24);
    assert.match(t, /^[A-Za-z0-9_-]+$/);
});

test('verifyToken devuelve true para token recién emitido', () => {
    csrf._resetForTests();
    const t = csrf.generateToken();
    assert.equal(csrf.verifyToken(t), true);
});

test('verifyToken devuelve false para token desconocido', () => {
    csrf._resetForTests();
    assert.equal(csrf.verifyToken('not-a-real-token'), false);
});

test('verifyToken devuelve false después de TTL expirado', () => {
    csrf._resetForTests();
    const t = csrf.generateToken({ now: 1000 });
    assert.equal(csrf.verifyToken(t, { now: 1000 + 3600000 }), true);
    assert.equal(csrf.verifyToken(t, { now: 1000 + 5 * 3600000 }), false);
});

test('requireCSRF deja pasar GET sin headers', () => {
    csrf._resetForTests();
    const req = fakeReq({ method: 'GET' });
    const res = fakeRes();
    assert.equal(csrf.requireCSRF(req, res), true);
    assert.equal(res._status, null);
});

test('requireCSRF bloquea POST sin cookie ni header', () => {
    csrf._resetForTests();
    const req = fakeReq({ method: 'POST' });
    const res = fakeRes();
    assert.equal(csrf.requireCSRF(req, res), false);
    assert.equal(res._status, 403);
    const parsed = JSON.parse(res._body);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.code, 'missing_csrf_token');
});

test('requireCSRF bloquea POST con cookie sin header (double-submit)', () => {
    csrf._resetForTests();
    const t = csrf.generateToken();
    const req = fakeReq({ method: 'POST', cookie: 'mp_csrf=' + t });
    const res = fakeRes();
    assert.equal(csrf.requireCSRF(req, res), false);
    assert.equal(res._status, 403);
});

test('requireCSRF bloquea POST con cookie y header distintos', () => {
    csrf._resetForTests();
    const t = csrf.generateToken();
    const req = fakeReq({ method: 'POST', cookie: 'mp_csrf=' + t, header: 'distinto' });
    const res = fakeRes();
    assert.equal(csrf.requireCSRF(req, res), false);
    assert.equal(res._status, 403);
    const parsed = JSON.parse(res._body);
    assert.equal(parsed.code, 'csrf_mismatch');
});

test('requireCSRF deja pasar POST con cookie y header matcheados y token vigente', () => {
    csrf._resetForTests();
    const t = csrf.generateToken();
    const req = fakeReq({ method: 'POST', cookie: 'mp_csrf=' + t, header: t });
    const res = fakeRes();
    assert.equal(csrf.requireCSRF(req, res), true);
    assert.equal(res._status, null);
});

test('requireCSRF bloquea POST con token desconocido (forjado)', () => {
    csrf._resetForTests();
    const fake = 'forjado-no-emitido';
    const req = fakeReq({ method: 'POST', cookie: 'mp_csrf=' + fake, header: fake });
    const res = fakeRes();
    assert.equal(csrf.requireCSRF(req, res), false);
    assert.equal(res._status, 403);
    const parsed = JSON.parse(res._body);
    assert.equal(parsed.code, 'csrf_expired');
});

test('readCookie parsea cookies con espacios y múltiples valores', () => {
    const req = { headers: { cookie: 'session=abc; mp_csrf=tok123; other=x' } };
    assert.equal(csrf.readCookie(req, 'mp_csrf'), 'tok123');
    assert.equal(csrf.readCookie(req, 'session'), 'abc');
    assert.equal(csrf.readCookie(req, 'missing'), null);
});

test('issueTokenResponse setea cookie con Path y SameSite y devuelve JSON', () => {
    csrf._resetForTests();
    const req = fakeReq({ method: 'GET' });
    const res = fakeRes();
    csrf.issueTokenResponse(req, res);
    assert.equal(res._status, 200);
    assert.ok(res._headers['Set-Cookie'].includes('mp_csrf='));
    assert.ok(res._headers['Set-Cookie'].includes('Path=/api/multi-provider'));
    assert.ok(res._headers['Set-Cookie'].includes('SameSite=Strict'));
    const parsed = JSON.parse(res._body);
    assert.ok(parsed.csrf_token);
    assert.equal(csrf.verifyToken(parsed.csrf_token), true);
});
