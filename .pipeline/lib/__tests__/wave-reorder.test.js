// =============================================================================
// wave-reorder.test.js — Priorización wave-scoped desde el dashboard (#4369).
//
// Cubre la lógica server-side que respalda POST /api/waves/:num/reorder:
//   (1) validateWaveReorder (SEC-1/CA-5): rechaza no-numéricos, duplicados,
//       issues fuera de la ola y conjuntos incompletos; acepta permutación
//       exacta de la membresía (CA-2).
//   (2) reorderWithinSubset + validación → membresía de la ola idéntica en
//       conjunto tras reorder (CA-6).
//   (3) CSRF del endpoint mutador: POST sin token → 403 (CA-7), reusando el
//       mecanismo compartido de lib/kill-agent-csrf.js.
//
// Ejecutar:  node --test .pipeline/lib/__tests__/wave-reorder.test.js
// =============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const issueOrder = require('../issue-order');
const csrf = require('../kill-agent-csrf');

function tmpFile() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wave-reorder-'));
    return path.join(dir, 'order.json');
}

// Membresía de ejemplo (equivalente a active_wave.issues[].number como string).
const MEMBERSHIP = ['4350', '4351', '4360', '4369'];

// ── (1) validateWaveReorder — SEC-1 / CA-5 ─────────────────────────────────

test('validateWaveReorder acepta una permutación exacta de la membresía (CA-2/CA-5)', () => {
    const r = issueOrder.validateWaveReorder(MEMBERSHIP, ['4369', '4350', '4360', '4351']);
    assert.equal(r.ok, true);
});

test('validateWaveReorder rechaza elementos no numéricos (SEC-1)', () => {
    const r = issueOrder.validateWaveReorder(MEMBERSHIP, ['4369', '../../x', '4360', '4351']);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'non-numeric');
});

test('validateWaveReorder rechaza duplicados (SEC-1)', () => {
    const r = issueOrder.validateWaveReorder(MEMBERSHIP, ['4369', '4369', '4360', '4351']);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'duplicates');
});

test('validateWaveReorder rechaza issues fuera de la ola (SEC-1/CA-6)', () => {
    const r = issueOrder.validateWaveReorder(MEMBERSHIP, ['4369', '9999', '4360', '4351']);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'not-in-wave');
});

test('validateWaveReorder rechaza conjunto incompleto (falta un miembro) (CA-6)', () => {
    const r = issueOrder.validateWaveReorder(MEMBERSHIP, ['4369', '4350', '4360']);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'incomplete-set');
});

test('validateWaveReorder rechaza order que no es array', () => {
    const r = issueOrder.validateWaveReorder(MEMBERSHIP, null);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'order-not-array');
});

// ── (2) Membresía intacta tras reorder — CA-6 ──────────────────────────────

test('reorder válido preserva la membresía de la ola (mismo conjunto, sin duplicados) (CA-6)', () => {
    const f = tmpFile();
    // order[] global con issues de la ola intercalados con no-miembros.
    const state = { version: 1, order: ['700', '4350', '3935', '4351', '4360', '4019', '4369'] };
    const newOrder = ['4369', '4360', '4351', '4350'];
    assert.equal(issueOrder.validateWaveReorder(MEMBERSHIP, newOrder).ok, true);
    issueOrder.reorderWithinSubset(state, MEMBERSHIP, newOrder, f);
    // La membresía persistida sigue siendo el mismo conjunto exacto.
    const persisted = issueOrder.load(f).order;
    const membersInOrder = persisted.filter(n => MEMBERSHIP.includes(n));
    assert.deepEqual([...membersInOrder].sort(), [...MEMBERSHIP].sort());
    assert.equal(new Set(membersInOrder).size, MEMBERSHIP.length); // sin duplicados
    // Los no-miembros conservan su secuencia relativa (CA-4).
    const nonMembers = persisted.filter(n => !MEMBERSHIP.includes(n));
    assert.deepEqual(nonMembers, ['700', '3935', '4019']);
});

// ── (3) CSRF del endpoint mutador — CA-7 ───────────────────────────────────

function fakeRes() {
    return {
        statusCode: null,
        headers: null,
        body: '',
        writeHead(code, headers) { this.statusCode = code; this.headers = headers; },
        end(payload) { this.body = payload || ''; },
    };
}

test('requireCSRF rechaza POST sin token con 403 (CA-7)', () => {
    csrf._resetForTests();
    const req = { method: 'POST', headers: {} };
    const res = fakeRes();
    const ok = csrf.requireCSRF(req, res);
    assert.equal(ok, false);
    assert.equal(res.statusCode, 403);
});

test('requireCSRF rechaza POST con header pero sin cookie con 403 (CA-7)', () => {
    csrf._resetForTests();
    const tok = csrf.generateToken();
    const req = { method: 'POST', headers: { 'x-csrf-token': tok } };
    const res = fakeRes();
    const ok = csrf.requireCSRF(req, res);
    assert.equal(ok, false);
    assert.equal(res.statusCode, 403);
});

test('requireCSRF acepta POST con token válido en header y cookie (CA-7)', () => {
    csrf._resetForTests();
    const tok = csrf.generateToken();
    const req = { method: 'POST', headers: { 'x-csrf-token': tok, cookie: 'ka_csrf=' + encodeURIComponent(tok) } };
    const res = fakeRes();
    const ok = csrf.requireCSRF(req, res);
    assert.equal(ok, true);
    assert.equal(res.statusCode, null); // no respondió error
});

test('requireCSRF rechaza token que no fue emitido por este server (CA-7)', () => {
    csrf._resetForTests();
    const fake = 'no-emitido-por-el-server';
    const req = { method: 'POST', headers: { 'x-csrf-token': fake, cookie: 'ka_csrf=' + fake } };
    const res = fakeRes();
    const ok = csrf.requireCSRF(req, res);
    assert.equal(ok, false);
    assert.equal(res.statusCode, 403);
});
