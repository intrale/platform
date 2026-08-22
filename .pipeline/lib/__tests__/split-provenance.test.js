// =============================================================================
// split-provenance.test.js — Issue #4525
//
// Unit del predicado puro `filterSplitChildren` (+ `parentOfSplitChild`):
// decide POR ISSUE si un extra de la allowlist es hijo VERIFICABLE de un split
// del propio pipeline (`authorization_ttls[n].parent ∈ ola` Y `authorized_by`
// matchea `recursive-deps:from-<parent>` con el MISMO parent).
//
// Cubre RS-1 (cross-check anti-forja), RS-2 (default-deny binding por issue),
// RS-4 (no gatea sobre expires_at), RS-5 (validación de tipos).
//
// Ejecutar:
//   node --test .pipeline/lib/__tests__/split-provenance.test.js
// =============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const sp = require('../split-provenance');

// Helper: entry de authorization_ttls con provenance de split coherente.
function ttl(parent, over = {}) {
    return {
        parent,
        authorized_by: `recursive-deps:from-${parent}`,
        expires_at: '2999-01-01T00:00:00Z',
        created_at: '2026-07-06T06:09:00Z',
        ...over,
    };
}

// -----------------------------------------------------------------------------
// Happy path
// -----------------------------------------------------------------------------

test('filterSplitChildren: todos hijos de split (padre en la ola) → devuelve todos', () => {
    const authorizationTtls = { 4523: ttl(4509), 4524: ttl(4509) };
    const out = sp.filterSplitChildren([4523, 4524], { authorizationTtls, activeWaveIssues: [4509] });
    assert.deepEqual(out, [4523, 4524]);
});

test('filterSplitChildren: devuelve ordenado ascendente y sin duplicados', () => {
    const authorizationTtls = { 4524: ttl(4509), 4523: ttl(4509) };
    const out = sp.filterSplitChildren([4524, 4523, 4524], { authorizationTtls, activeWaveIssues: [4509] });
    assert.deepEqual(out, [4523, 4524]);
});

test('filterSplitChildren: hijos de DISTINTOS padres, ambos en la ola → ambos', () => {
    const authorizationTtls = { 4523: ttl(4509), 4600: ttl(4510) };
    const out = sp.filterSplitChildren([4523, 4600], { authorizationTtls, activeWaveIssues: [4509, 4510] });
    assert.deepEqual(out, [4523, 4600]);
});

// -----------------------------------------------------------------------------
// RS-2 — default-deny / binding por issue
// -----------------------------------------------------------------------------

test('filterSplitChildren: mixto — uno con provenance, otro sin ttl → sólo el trazable', () => {
    const authorizationTtls = { 4523: ttl(4509) }; // 4524 no tiene entry
    const out = sp.filterSplitChildren([4523, 4524], { authorizationTtls, activeWaveIssues: [4509] });
    assert.deepEqual(out, [4523]);
});

test('filterSplitChildren: parent fuera de la ola → excluido', () => {
    const authorizationTtls = { 4523: ttl(4509) };
    const out = sp.filterSplitChildren([4523], { authorizationTtls, activeWaveIssues: [9999] });
    assert.deepEqual(out, []);
});

test('filterSplitChildren: ola vacía → nada trazable', () => {
    const authorizationTtls = { 4523: ttl(4509) };
    const out = sp.filterSplitChildren([4523], { authorizationTtls, activeWaveIssues: [] });
    assert.deepEqual(out, []);
});

test('filterSplitChildren: authorization_ttls vacío/purgado (RS-4 fail-safe) → []', () => {
    const out = sp.filterSplitChildren([4523, 4524], { authorizationTtls: {}, activeWaveIssues: [4509] });
    assert.deepEqual(out, []);
});

// -----------------------------------------------------------------------------
// RS-1 — cross-check anti-forja (crítico)
// -----------------------------------------------------------------------------

test('RS-1: parent:4509 en la ola pero authorized_by:"recursive-deps:from-9999" → excluido', () => {
    const authorizationTtls = {
        4523: { parent: 4509, authorized_by: 'recursive-deps:from-9999' },
    };
    const out = sp.filterSplitChildren([4523], { authorizationTtls, activeWaveIssues: [4509] });
    assert.deepEqual(out, [], 'el string del authorized_by no coincide con el campo parent → forja');
});

test('RS-1: authorized_by con formato ajeno (no recursive-deps) → excluido', () => {
    const authorizationTtls = {
        4523: { parent: 4509, authorized_by: 'wave-promote' },
        4524: { parent: 4509, authorized_by: 'commander:leo' },
    };
    const out = sp.filterSplitChildren([4523, 4524], { authorizationTtls, activeWaveIssues: [4509] });
    assert.deepEqual(out, []);
});

test('RS-1: authorized_by ausente/vacío → excluido', () => {
    const authorizationTtls = {
        4523: { parent: 4509 },
        4524: { parent: 4509, authorized_by: '' },
    };
    const out = sp.filterSplitChildren([4523, 4524], { authorizationTtls, activeWaveIssues: [4509] });
    assert.deepEqual(out, []);
});

// -----------------------------------------------------------------------------
// RS-5 — validación de tipos
// -----------------------------------------------------------------------------

test('RS-5: parent no entero → excluido', () => {
    const authorizationTtls = {
        4523: { parent: '4509abc', authorized_by: 'recursive-deps:from-4509' },
        4524: { parent: 4509.5, authorized_by: 'recursive-deps:from-4509' },
        4525: { parent: null, authorized_by: 'recursive-deps:from-4509' },
    };
    const out = sp.filterSplitChildren([4523, 4524, 4525], { authorizationTtls, activeWaveIssues: [4509] });
    assert.deepEqual(out, []);
});

test('RS-5: parent como string numérico válido → aceptado (normalizado)', () => {
    // El campo parent puede llegar como string "4509"; se normaliza a entero y,
    // si el authorized_by cross-checkea, califica.
    const authorizationTtls = {
        4523: { parent: '4509', authorized_by: 'recursive-deps:from-4509' },
    };
    const out = sp.filterSplitChildren([4523], { authorizationTtls, activeWaveIssues: [4509] });
    assert.deepEqual(out, [4523]);
});

test('RS-5: issue number inválido en added → ignorado sin romper', () => {
    const authorizationTtls = { 4523: ttl(4509) };
    const out = sp.filterSplitChildren([4523, 'basura', null, -5, 0], { authorizationTtls, activeWaveIssues: [4509] });
    assert.deepEqual(out, [4523]);
});

test('filterSplitChildren: activeWaveIssues como strings numéricos → normaliza', () => {
    const authorizationTtls = { 4523: ttl(4509) };
    const out = sp.filterSplitChildren([4523], { authorizationTtls, activeWaveIssues: ['4509'] });
    assert.deepEqual(out, [4523]);
});

// -----------------------------------------------------------------------------
// Entradas degeneradas
// -----------------------------------------------------------------------------

test('filterSplitChildren: added vacío/null → []', () => {
    assert.deepEqual(sp.filterSplitChildren([], { authorizationTtls: { 4523: ttl(4509) }, activeWaveIssues: [4509] }), []);
    assert.deepEqual(sp.filterSplitChildren(null, { authorizationTtls: {}, activeWaveIssues: [] }), []);
    assert.deepEqual(sp.filterSplitChildren(undefined, {}), []);
});

test('filterSplitChildren: ctx ausente → [] sin romper', () => {
    assert.deepEqual(sp.filterSplitChildren([4523]), []);
});

test('filterSplitChildren: authorizationTtls no-objeto → [] (defensivo)', () => {
    assert.deepEqual(sp.filterSplitChildren([4523], { authorizationTtls: 'x', activeWaveIssues: [4509] }), []);
});

// -----------------------------------------------------------------------------
// parentOfSplitChild — mismo cross-check, devuelve el parent
// -----------------------------------------------------------------------------

test('parentOfSplitChild: hijo verificable → devuelve el parent', () => {
    const authorizationTtls = { 4523: ttl(4509) };
    assert.equal(sp.parentOfSplitChild(4523, authorizationTtls), 4509);
});

test('parentOfSplitChild: forja (authorized_by no coincide) → null', () => {
    const authorizationTtls = { 4523: { parent: 4509, authorized_by: 'recursive-deps:from-1' } };
    assert.equal(sp.parentOfSplitChild(4523, authorizationTtls), null);
});

test('parentOfSplitChild: sin entry → null', () => {
    assert.equal(sp.parentOfSplitChild(4523, {}), null);
    assert.equal(sp.parentOfSplitChild(4523, null), null);
});
