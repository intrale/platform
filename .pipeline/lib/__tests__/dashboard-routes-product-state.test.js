'use strict';

// =============================================================================
// dashboard-routes-product-state.test.js — #4764 (split 3/3 de #4689)
//
// Cobertura del endpoint de estado SEGMENTADO por producto
// (/api/dash/product-state + alias /api/product-state). Verifica el contrato
// fail-closed (A01 · CA-4):
//   - filtra por `projectId` autorizado y devuelve SÓLO su estado.
//   - sin `projectId` (o inválido/inexistente) → _status 403, NUNCA el agregado.
//   - anti-IDOR: un `projectId` fuera del contexto autorizado → 403.
//
// node --test .pipeline/lib/__tests__/dashboard-routes-product-state.test.js
// =============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');

const { _internal } = require('../dashboard-routes');
const route = _internal.API_ROUTES['/api/dash/product-state'];
const alias = _internal.API_ROUTES['/api/product-state'];

// Helpers -------------------------------------------------------------------
function q(params) {
    const usp = new URLSearchParams();
    for (const [k, v] of Object.entries(params || {})) usp.set(k, v);
    return usp;
}
const STATE = {
    productState: {
        acme: { metrics: { rebotes: 1 }, tokens: { in: 100, out: 50 }, times: { p50: 30 }, phase: 'dev', audit: [{ action: 'a-only' }] },
        globex: { metrics: { rebotes: 9 }, tokens: { in: 999, out: 999 }, phase: 'qa', audit: [{ action: 'b-only' }] },
    },
};

test('los routes /api/dash/product-state y /api/product-state están registrados', () => {
    assert.equal(typeof route, 'function');
    assert.equal(typeof alias, 'function');
});

test('CA-4.1 · con projectId autorizado devuelve SÓLO el estado de ese producto', () => {
    const out = route(STATE, {}, q({ projectId: 'acme' }));
    assert.equal(out._status, undefined, 'éxito → sin _status (HTTP 200)');
    assert.equal(out.projectId, 'acme');
    assert.deepEqual(out.tokens, { in: 100, out: 50 });
    assert.deepEqual(out.audit, [{ action: 'a-only' }]);
    // No filtra datos de B.
    const s = JSON.stringify(out);
    assert.ok(!s.includes('999') && !s.includes('globex') && !s.includes('b-only'), 'sin datos de B');
});

test('CA-4.3 · sin projectId → _status 403 y NUNCA el agregado global', () => {
    const out = route(STATE, {}, q({}));
    assert.equal(out._status, 403);
    assert.equal(out.error, 'forbidden');
    const s = JSON.stringify(out);
    assert.ok(!s.includes('acme') && !s.includes('globex'), 'no devuelve el agregado');
});

test('CA-4.3 · projectId inexistente → 403 (no fallback al agregado)', () => {
    const out = route(STATE, {}, q({ projectId: 'no-existe' }));
    assert.equal(out._status, 403);
});

test('A03 · projectId con traversal/separadores → 403 sin indexar el store', () => {
    for (const bad of ['../evil', 'a/b', 'x\\y', '..', 'ACME']) {
        const out = route(STATE, {}, q({ projectId: bad }));
        assert.equal(out._status, 403, `id inseguro ${bad} → 403`);
    }
});

test('CA-4.2 · anti-IDOR: contexto autorizado sólo para A → pedir B da 403', () => {
    const ctx = { authorizedProjectIds: ['acme'] };
    const okA = route(STATE, ctx, q({ projectId: 'acme' }));
    assert.equal(okA.projectId, 'acme');
    const denyB = route(STATE, ctx, q({ projectId: 'globex' }));
    assert.equal(denyB._status, 403, 'B no autorizado en contexto de A');
});

test('fail-closed cuando no hay productState en el estado (nunca agregado)', () => {
    const out = route({}, {}, q({ projectId: 'acme' }));
    assert.equal(out._status, 403);
});

test('el alias /api/product-state se comporta igual que el canónico', () => {
    const a = route(STATE, {}, q({ projectId: 'acme' }));
    const b = alias(STATE, {}, q({ projectId: 'acme' }));
    assert.deepEqual(a, b);
});
