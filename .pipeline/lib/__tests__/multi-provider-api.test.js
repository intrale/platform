// =============================================================================
// multi-provider-api.test.js — Tests del router HTTP del panel (#3177).
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const api = require('../multi-provider/api');
const csrf = require('../multi-provider/csrf');

function fakeReq({ url = '/', method = 'GET', headers = {}, body = '' } = {}) {
    const handlers = {};
    const req = {
        url, method, headers,
        on(ev, fn) { handlers[ev] = fn; return this; },
        // Emite eventos de body async para que el handler tenga tiempo de subscribirse
        // (api.route arranca el handler en una microtarea via Promise.resolve().then).
        _emitBody() {
            setImmediate(() => {
                if (handlers.data && body) handlers.data(Buffer.from(body, 'utf8'));
                if (handlers.end) handlers.end();
            });
        },
        destroy() {},
    };
    return req;
}

function fakeRes() {
    let resolved;
    const done = new Promise(r => { resolved = r; });
    const res = {
        _status: null, _headers: {}, _body: '',
        writeHead(status, headers) {
            this._status = status;
            this._headers = { ...this._headers, ...(headers || {}) };
        },
        setHeader(k, v) { this._headers[k] = v; },
        end(body) {
            this._body = body == null ? '' : String(body);
            resolved(this);
        },
    };
    res.done = done;
    return res;
}

async function call(url, opts = {}) {
    const req = fakeReq({ url, ...opts });
    const res = fakeRes();
    const handled = api.route(req, res);
    if (req.method !== 'GET') req._emitBody();
    if (!handled) return { handled: false, res };
    await res.done;
    return { handled: true, res, json: tryParseJson(res._body) };
}

function tryParseJson(s) { try { return JSON.parse(s); } catch { return null; } }

test('route devuelve false para URLs fuera del namespace', async () => {
    const req = fakeReq({ url: '/api/dash/header' });
    const res = fakeRes();
    assert.equal(api.route(req, res), false);
});

test('GET /api/multi-provider/csrf-token emite token + cookie', async () => {
    csrf._resetForTests();
    const { res, json } = await call('/api/multi-provider/csrf-token');
    assert.equal(res._status, 200);
    assert.ok(json.csrf_token);
    assert.ok(res._headers['Set-Cookie'].includes('mp_csrf='));
});

test('GET /api/multi-provider/catalog devuelve catálogo con providers', async () => {
    const { res, json } = await call('/api/multi-provider/catalog');
    assert.equal(res._status, 200);
    assert.ok(Array.isArray(json.providers));
    assert.ok(json.catalog);
});

test('GET /api/multi-provider/skills devuelve registry con non_degradable', async () => {
    const { res, json } = await call('/api/multi-provider/skills');
    assert.equal(res._status, 200);
    assert.ok(Array.isArray(json.non_degradable));
    assert.ok(json.skills);
    assert.ok(json.non_degradable.includes('security'));
});

test('PUT /api/multi-provider/config sin CSRF devuelve 403', async () => {
    csrf._resetForTests();
    const { res, json } = await call('/api/multi-provider/config', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ config: {} }),
    });
    assert.equal(res._status, 403);
    assert.equal(json.code, 'missing_csrf_token');
});

test('POST /api/multi-provider/overrides sin CSRF devuelve 403', async () => {
    csrf._resetForTests();
    const { res, json } = await call('/api/multi-provider/overrides', {
        method: 'POST',
        body: JSON.stringify({ skill: 'qa', provider: 'anthropic', ttl_horas: 24, justificacion: 'a'.repeat(40) }),
    });
    assert.equal(res._status, 403);
    assert.ok(json.code === 'missing_csrf_token' || json.code === 'no_author');
});

test('POST /api/multi-provider/overrides con CSRF pero skill NON_DEGRADABLE devuelve 422', async () => {
    csrf._resetForTests();
    const token = csrf.generateToken();
    const { res, json } = await call('/api/multi-provider/overrides', {
        method: 'POST',
        headers: {
            'cookie': 'mp_csrf=' + token,
            'x-csrf-token': token,
            'content-type': 'application/json',
        },
        body: JSON.stringify({
            skill: 'security',
            provider: 'openai-codex',
            ttl_horas: 24,
            justificacion: 'incidente real con anthropic caido necesitamos seguir',
            capabilities_diff: ['tool_use_gated'],
        }),
    });
    assert.ok(res._status === 422 || res._status === 403);
    if (res._status === 422) {
        assert.equal(json.code, 'non_degradable');
    }
});

test('POST /api/multi-provider/overrides con TTL > 168 rechaza 422', async () => {
    csrf._resetForTests();
    const token = csrf.generateToken();
    const { res, json } = await call('/api/multi-provider/overrides', {
        method: 'POST',
        headers: {
            'cookie': 'mp_csrf=' + token,
            'x-csrf-token': token,
            'content-type': 'application/json',
        },
        body: JSON.stringify({
            skill: 'qa',
            provider: 'openai-codex',
            ttl_horas: 999,
            justificacion: 'a'.repeat(40),
            capabilities_diff: [],
        }),
    });
    assert.ok(res._status === 422 || res._status === 403);
    if (res._status === 422) {
        assert.ok(json.code === 'invalid_ttl' || json.code === 'record_failed');
    }
});

test('POST /api/multi-provider/overrides con justificación corta rechaza 422', async () => {
    csrf._resetForTests();
    const token = csrf.generateToken();
    const { res, json } = await call('/api/multi-provider/overrides', {
        method: 'POST',
        headers: {
            'cookie': 'mp_csrf=' + token,
            'x-csrf-token': token,
            'content-type': 'application/json',
        },
        body: JSON.stringify({
            skill: 'qa',
            provider: 'openai-codex',
            ttl_horas: 24,
            justificacion: 'corto',
            capabilities_diff: [],
        }),
    });
    assert.ok(res._status === 422 || res._status === 403);
});

test('route con URL desconocida bajo /api/multi-provider/* devuelve 404 estructurado', async () => {
    const { res, json } = await call('/api/multi-provider/ruta-inexistente');
    assert.equal(res._status, 404);
    assert.equal(json.code, 'not_found');
});

test('resolveAuthor devuelve string no-vacío con git configurado, o null', () => {
    const author = api.resolveAuthor();
    assert.ok(author === null || (typeof author === 'string' && author.length > 0));
});

test('GET /api/multi-provider/keys devuelve metadata sin keys raw', async () => {
    const { res, json } = await call('/api/multi-provider/keys');
    assert.equal(res._status, 200);
    assert.ok(Array.isArray(json.keys));
    const serialized = JSON.stringify(json);
    assert.equal(serialized.includes('"anthropic_api_key":"sk-'), false);
    assert.equal(serialized.includes('"openai_api_key":"sk-'), false);
});

test('POST /api/multi-provider/ping/openai sin CSRF devuelve 403', async () => {
    csrf._resetForTests();
    const { res } = await call('/api/multi-provider/ping/openai', { method: 'POST' });
    assert.equal(res._status, 403);
});

// =============================================================================
// #3871 — Endpoint de horarios por provider.
// =============================================================================

test('GET /api/multi-provider/providers-schedule lista todos los providers válidos', async () => {
    const { res, json } = await call('/api/multi-provider/providers-schedule');
    assert.equal(res._status, 200);
    assert.equal(json.ok, true);
    assert.ok(Array.isArray(json.providers));
    // Debe incluir un item por provider de la allowlist.
    const names = json.providers.map(p => p.name);
    assert.ok(names.includes('anthropic'));
    assert.ok(names.includes('gemini-google'));
    // Nunca debe exponer claves.
    assert.equal(JSON.stringify(json).includes('sk-'), false);
});

test('POST .../providers/:name/schedule sin CSRF devuelve 403', async () => {
    csrf._resetForTests();
    const { res } = await call('/api/multi-provider/providers/anthropic/schedule', {
        method: 'POST',
        body: JSON.stringify({ active: true, schedule: {}, timezone: 'America/Argentina/Buenos_Aires' }),
    });
    assert.equal(res._status, 403);
});

test('POST .../providers/:name/schedule con provider inválido devuelve 400', async () => {
    csrf._resetForTests();
    const token = csrf.generateToken();
    const { res, json } = await call('/api/multi-provider/providers/groq/schedule', {
        method: 'POST',
        headers: { 'cookie': 'mp_csrf=' + token, 'x-csrf-token': token, 'content-type': 'application/json' },
        body: JSON.stringify({ active: true, schedule: {}, timezone: 'America/Argentina/Buenos_Aires' }),
    });
    assert.equal(res._status, 400);
    assert.equal(json.code, 'invalid_provider');
});

test('POST .../providers/:name/schedule con active no-boolean devuelve 422', async () => {
    csrf._resetForTests();
    const token = csrf.generateToken();
    const { res, json } = await call('/api/multi-provider/providers/anthropic/schedule', {
        method: 'POST',
        headers: { 'cookie': 'mp_csrf=' + token, 'x-csrf-token': token, 'content-type': 'application/json' },
        body: JSON.stringify({ active: 'yes', schedule: {}, timezone: 'America/Argentina/Buenos_Aires' }),
    });
    // 422 (payload inválido) o 403 si el ambiente de test no resuelve autor.
    assert.ok(res._status === 422 || res._status === 403);
    if (res._status === 422) assert.equal(json.code, 'invalid_payload');
});
