'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { allChildrenDone, isFreshEntry, DEFAULT_FRESHNESS_MS } = require('./epic-children-oracle');

const NOW = 1_776_810_000_000;
const fresh = (extra) => ({ fetchedAt: NOW, ...extra });

test('allChildrenDone devuelve false con array vacio', () => {
  assert.equal(allChildrenDone({ children: [], issueStates: {}, now: NOW }), false);
});

test('allChildrenDone devuelve false con estado desconocido', () => {
  assert.equal(allChildrenDone({ children: [4662], issueStates: {}, now: NOW }), false);
  assert.equal(allChildrenDone({
    children: [4662],
    issueStates: { 4662: fresh({ state: 'OPEN' }) },
    now: NOW,
  }), false);
});

test('allChildrenDone devuelve true cuando todos estan CLOSED o Done con entradas frescas', () => {
  assert.equal(allChildrenDone({
    children: [4662, '4663', 4664],
    issueStates: {
      4662: fresh({ state: 'CLOSED' }),
      4663: fresh({ state: 'closed' }),
      4664: fresh({ labels: ['status:done'] }),
    },
    now: NOW,
  }), true);
});

test('allChildrenDone falla cerrado con hijo no numerico o sin estados', () => {
  assert.equal(allChildrenDone({ children: ['abc'], issueStates: { abc: fresh({ state: 'CLOSED' }) }, now: NOW }), false);
  assert.equal(allChildrenDone({ children: [1], issueStates: null, now: NOW }), false);
});

// #4672 (security A01) — El corazón del fix: aunque un hijo figure CLOSED, si su
// entrada de cache NO tiene frescura verificable, el oráculo NO debe abrir el gate.
test('allChildrenDone FAIL-CLOSED ante cache viejo aunque diga CLOSED', () => {
  const staleEntry = { state: 'CLOSED', fetchedAt: NOW - DEFAULT_FRESHNESS_MS - 1 };
  assert.equal(allChildrenDone({
    children: [4662],
    issueStates: { 4662: staleEntry },
    now: NOW,
  }), false);
});

test('allChildrenDone FAIL-CLOSED cuando la entrada no tiene fetchedAt', () => {
  assert.equal(allChildrenDone({
    children: [4662],
    issueStates: { 4662: { state: 'CLOSED' } },
    now: NOW,
  }), false);
});

test('allChildrenDone FAIL-CLOSED con estado como string crudo (no verificable)', () => {
  // Un string 'CLOSED' no lleva `fetchedAt` → frescura no verificable.
  assert.equal(allChildrenDone({
    children: [4662],
    issueStates: { 4662: 'CLOSED' },
    now: NOW,
  }), false);
});

test('allChildrenDone FAIL-CLOSED si UN solo hijo esta stale (resto fresco)', () => {
  assert.equal(allChildrenDone({
    children: [4662, 4663],
    issueStates: {
      4662: fresh({ state: 'CLOSED' }),
      4663: { state: 'CLOSED', fetchedAt: NOW - DEFAULT_FRESHNESS_MS - 1 },
    },
    now: NOW,
  }), false);
});

test('isFreshEntry: verdadero solo para objeto con fetchedAt dentro de la ventana', () => {
  assert.equal(isFreshEntry({ fetchedAt: NOW }, NOW, DEFAULT_FRESHNESS_MS), true);
  assert.equal(isFreshEntry({ fetchedAt: NOW - DEFAULT_FRESHNESS_MS - 1 }, NOW, DEFAULT_FRESHNESS_MS), false);
  assert.equal(isFreshEntry({ state: 'CLOSED' }, NOW, DEFAULT_FRESHNESS_MS), false);
  assert.equal(isFreshEntry('CLOSED', NOW, DEFAULT_FRESHNESS_MS), false);
  assert.equal(isFreshEntry(null, NOW, DEFAULT_FRESHNESS_MS), false);
});
