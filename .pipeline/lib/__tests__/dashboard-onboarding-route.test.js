'use strict';

// =============================================================================
// dashboard-onboarding-route.test.js — la vista `?view=onboarding` (#4778) queda
// cableada en el router del dashboard (allowlist de slugs + render SSR).
//
// Cobertura:
//   - CA-1.1 / CA-5.2 : la UI de alta se sirve desde el router (sin editar archivos).
//   - SEC-7a : la vista embebe el flujo POST + CSRF (no hay disparador GET mutante).
//   - CA-S1  : slug en la allowlist (partial endpoint no 400) — reusa el gate existente.
// =============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');

function fresh() {
    delete require.cache[require.resolve('../dashboard-routes')];
    return require('../dashboard-routes');
}
function fakeRes() {
    return {
        statusCode: null, headers: null, body: '',
        writeHead(s, h) { this.statusCode = s; this.headers = h; },
        end(c) { if (c !== undefined) this.body += String(c); },
    };
}
function fakeReq(opts) {
    const o = opts || {};
    return { method: o.method || 'GET', url: o.url || '/dashboard', socket: { remoteAddress: o.remoteAddress || '127.0.0.1' }, headers: o.headers || {} };
}
const fakeCtx = { getState: () => ({}), PIPELINE: '', ROOT: '', GH_BIN: '' };

test('CA-1.1: GET /dashboard?view=onboarding → 200 con el wizard SSR', () => {
    const { handle } = fresh();
    const req = fakeReq({ url: '/dashboard?view=onboarding' });
    const res = fakeRes();
    const handled = handle(req, res, fakeCtx);
    assert.equal(handled, true);
    assert.equal(res.statusCode, 200);
    assert.ok(res.body.includes('id="ow-form"'), 'debe renderizar el form del wizard');
    assert.ok(res.body.includes('Onboarding de producto'));
});

test('SEC-7a: la vista embebe POST /api/product/onboard + CSRF, sin GET mutante', () => {
    const { handle } = fresh();
    const req = fakeReq({ url: '/dashboard?view=onboarding' });
    const res = fakeRes();
    handle(req, res, fakeCtx);
    assert.ok(res.body.includes('/api/product/onboard'));
    assert.ok(res.body.includes('/api/product/csrf-token'));
    assert.ok(res.body.includes('X-CSRF-Token'));
    assert.ok(res.body.includes("method: 'POST'"));
});

test('CA-S1: onboarding es un slug de la allowlist (partial desde loopback no da 400)', () => {
    const { handle } = fresh();
    const req = fakeReq({ url: '/dashboard/partial?view=onboarding', headers: { 'sec-fetch-site': 'same-origin' } });
    const res = fakeRes();
    const handled = handle(req, res, fakeCtx);
    assert.equal(handled, true);
    assert.notEqual(res.statusCode, 400, 'slug conocido no debe dar bad request');
    assert.equal(res.statusCode, 200);
});
