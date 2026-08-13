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

test('#4851: onboarding conserva 5 pasos y expone los campos del descriptor completo', () => {
    const { handle } = fresh();
    const req = fakeReq({ url: '/dashboard?view=onboarding' });
    const res = fakeRes();
    handle(req, res, fakeCtx);
    const steps = [...res.body.matchAll(/class="ow-step-num"/g)];
    assert.equal(steps.length, 5, 'debe mantener exactamente 5 pasos');
    for (const id of ['ow-repo-baseref', 'ow-repo-alt-baseref', 'ow-pr-policy', 'ow-board-labels', 'ow-provider-order', 'ow-auth-signers', 'ow-auth-gate2']) {
        assert.ok(res.body.includes(`id="${id}"`), `falta ${id}`);
    }
    assert.ok(res.body.includes('data-provider-id="anthropic"'));
    assert.ok(res.body.includes('data-provider-id="openai-codex"'));
    assert.ok(res.body.includes('data-provider-id="gemini-google"'));
    assert.ok(res.body.includes('data-provider-id="cerebras"'));
    assert.ok(res.body.includes('data-provider-id="nvidia-nim"'));
    assert.ok(res.body.includes('function owMoveProvider('));
    assert.ok(res.body.includes('function owProviderKey('));
    // #5724 rev-3 empezó a inlinear el sprite de íconos COMPLETO en el documento
    // de la vista (el banner de desync usa `<use href="#ic-pause-lock">` y sin el
    // sprite en el documento el símbolo no resuelve). Ese sprite es compartido por
    // todo el dashboard y trae `ic-provider-groq` + su comentario: Groq sigue vivo
    // como provider free en la vista multi-provider, así que el ícono debe seguir
    // existiendo. Lo que #4851 prohíbe es que Groq aparezca como OPCIÓN del wizard,
    // no que el sprite compartido pierda su símbolo — por eso la aserción se evalúa
    // sobre el documento con el sprite descontado, más un chequeo explícito de que
    // no hay provider `groq` ofrecido en el orden de providers.
    let sprite = '';
    try { sprite = require('../../views/dashboard/nav-tabs').loadIconSprite(); } catch { /* sin sprite: se evalúa el documento entero */ }
    const bodySinSprite = sprite ? res.body.split(sprite).join('') : res.body;
    assert.ok(bodySinSprite.length < res.body.length, 'el sprite debe haberse recortado antes del assert');
    assert.ok(bodySinSprite.includes('id="ow-form"'), 'recortar el sprite no debe llevarse el wizard');
    assert.ok(!/groq/i.test(bodySinSprite), 'Groq/groq no debe aparecer en UI/script del wizard');
    assert.ok(!res.body.includes('data-provider-id="groq"'), 'Groq no debe ser opción del orden de providers');
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
