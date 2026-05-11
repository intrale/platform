// =============================================================================
// Tests quota-adapters/openai-codex.js — stub M2a (#3092)
//
// Cubre:
//
//   * Stub devuelve `not_implemented` con `pct: null` (NO 0).
//   * Hard cap del budget USD se enforce desde M2a (security CA-#2).
//   * Mensaje de errorReason apunta a #3075 (M2b) para que el operador
//     sepa qué destrabar.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

function freshAdapter() {
    delete require.cache[require.resolve('../../quota-adapters/openai-codex')];
    delete require.cache[require.resolve('../../quota-adapters/_shape')];
    return require('../../quota-adapters/openai-codex');
}

test('openai-codex stub devuelve adapterStatus=not_implemented con pct null', () => {
    const adapter = freshAdapter();
    const r = adapter({});
    assert.equal(r.provider, 'openai-codex');
    assert.equal(r.adapterStatus, 'not_implemented');
    assert.equal(r.pct, null, 'pct DEBE ser null para distinguir de "0% real"');
    assert.equal(r.hoursUsed7d, null);
    assert.match(r.errorReason, /#3075|M2b/);
});

test('openai-codex acepta budget válido y sigue devolviendo not_implemented', () => {
    const adapter = freshAdapter();
    const r = adapter({ budgetUsd: 50 });
    assert.equal(r.adapterStatus, 'not_implemented');
});

test('openai-codex rechaza budget negativo / no-numérico (security CA-#2)', () => {
    const adapter = freshAdapter();
    for (const bad of [-1, 'fifty', NaN, Infinity, [], {}]) {
        const r = adapter({ budgetUsd: bad });
        assert.equal(r.adapterStatus, 'error',
            `budget ${JSON.stringify(bad)} debe ser rechazado`);
        assert.match(r.errorReason, /budgetUsd/);
    }
});

test('openai-codex rechaza budget que excede el cap hardcoded (security CA-#2)', () => {
    const adapter = freshAdapter();
    const cap = adapter.MAX_MONTHLY_BUDGET_USD;
    assert.equal(typeof cap, 'number');
    assert.ok(cap > 0 && cap <= 10000, 'cap razonable hardcoded');

    const r = adapter({ budgetUsd: cap + 1 });
    assert.equal(r.adapterStatus, 'error');
    assert.match(r.errorReason, /cap|excede/);
});

test('openai-codex acepta budget exactamente igual al cap (boundary)', () => {
    const adapter = freshAdapter();
    const cap = adapter.MAX_MONTHLY_BUDGET_USD;
    const r = adapter({ budgetUsd: cap });
    assert.equal(r.adapterStatus, 'not_implemented',
        `budget = cap (${cap}) debe ser aceptado`);
});

test('openai-codex acepta budget=0 (operador deshabilita gasto)', () => {
    const adapter = freshAdapter();
    const r = adapter({ budgetUsd: 0 });
    assert.equal(r.adapterStatus, 'not_implemented');
});

test('openai-codex stub mantiene shape canónico (todos los campos presentes)', () => {
    const adapter = freshAdapter();
    const r = adapter({});
    // Verificar campos del envelope multi-provider
    assert.equal(r.schemaVersion, 2);
    assert.deepEqual(r.breakdown, []);
    // Y campos null para distinguir degradado de "0% real"
    assert.equal(r.effectiveLimitHours, null);
    assert.equal(r.observedMaxHours, null);
    assert.equal(r.session.pct, null);
    assert.equal(r.session.status, 'unknown'); // not_implemented mapea a unknown en quota status
});
