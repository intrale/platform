'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  RECONCILABLE_STATE_LABELS,
  isReconciliableStateLabel,
  reconcileStateLabels,
} = require('./label-reconciler-core');

test('needs-human + epico con todos los hijos CLOSED remueve label y audita', () => {
  const rec = reconcileStateLabels({
    issue: 4661,
    currentLabels: ['needs-human', 'epic'],
    sources: { isEpic: true, epicChildrenAllDone: true, hasActiveHumanMarker: false },
  });
  assert.deepEqual(rec.toRemove, ['needs-human']);
  assert.deepEqual(rec.toAdd, []);
  assert.equal(rec.audit.length, 1);
  assert.equal(rec.audit[0].label, 'needs-human');
  assert.equal(rec.audit[0].action, 'remove');
  assert.equal(rec.audit[0].oracle, 'epic-children-all-done');
});

test('needs-human + hijo abierto o no verificable no remueve', () => {
  for (const epicChildrenAllDone of [false, undefined, null]) {
    const rec = reconcileStateLabels({
      issue: 4661,
      currentLabels: ['needs-human'],
      sources: { isEpic: true, epicChildrenAllDone, hasActiveHumanMarker: false },
    });
    assert.deepEqual(rec.toRemove, []);
    assert.deepEqual(rec.audit, []);
  }
});

test('estado de hijos ausente o ilegible es fail-closed', () => {
  const rec = reconcileStateLabels({
    issue: 4661,
    currentLabels: ['needs-human'],
    sources: { isEpic: true },
  });
  assert.deepEqual(rec.toRemove, []);
});

test('hasActiveHumanMarker true nunca remueve aunque los hijos esten Done', () => {
  const rec = reconcileStateLabels({
    issue: 4661,
    currentLabels: ['needs-human'],
    sources: { isEpic: true, epicChildrenAllDone: true, hasActiveHumanMarker: true },
  });
  assert.deepEqual(rec.toRemove, []);
});

test('labels de contenido nunca aparecen en toRemove', () => {
  const contentLabels = ['area:infra', 'app:client', 'enhancement', 'bug', 'size:M', 'priority:medium', 'tipo:infra', 'source:intake', 'epic'];
  const rec = reconcileStateLabels({
    issue: 1,
    currentLabels: ['needs-human', ...contentLabels],
    sources: { isEpic: true, epicChildrenAllDone: true, hasActiveHumanMarker: false },
  });
  for (const label of contentLabels) {
    assert.equal(rec.toRemove.includes(label), false, `${label} no debe removerse`);
  }
});

test('qa:* no se remueve; blocked:dependencies en issue ABIERTO sigue siendo dominio delegado', () => {
  // Issue abierto (sin señal de cierre): blocked:dependencies NO se toca.
  const rec = reconcileStateLabels({
    issue: 1,
    currentLabels: ['needs-human', 'qa:pending', 'qa:failed', 'blocked:dependencies'],
    sources: { isEpic: true, epicChildrenAllDone: true, hasActiveHumanMarker: false },
  });
  assert.equal(rec.toRemove.includes('qa:pending'), false);
  assert.equal(rec.toRemove.includes('qa:failed'), false);
  assert.equal(rec.toRemove.includes('blocked:dependencies'), false);
});

// #4732 (CA-3) — issue CLOSED: se remueve el label residual blocked:dependencies.
test('reconcileStateLabels remueve blocked:dependencies cuando el issue esta CLOSED (state)', () => {
  const rec = reconcileStateLabels({
    issue: 4685,
    currentLabels: ['blocked:dependencies', 'area:infra'],
    sources: { state: 'CLOSED' },
  });
  assert.ok(rec.toRemove.includes('blocked:dependencies'), 'debe removerse el label residual');
  assert.equal(rec.toRemove.includes('area:infra'), false, 'labels de contenido no se tocan');
  const entry = rec.audit.find((a) => a.label === 'blocked:dependencies');
  assert.ok(entry, 'debe auditar la remocion');
  assert.equal(entry.action, 'remove');
  assert.equal(entry.oracle, 'issue-closed');
  assert.equal(entry.issue, 4685);
});

test('reconcileStateLabels remueve blocked:dependencies con sources.isClosed === true', () => {
  const rec = reconcileStateLabels({
    issue: 4696,
    currentLabels: ['blocked:dependencies'],
    sources: { isClosed: true },
  });
  assert.deepEqual(rec.toRemove, ['blocked:dependencies']);
  assert.equal(rec.audit[0].oracle, 'issue-closed');
});

test('reconcileStateLabels NO remueve blocked:dependencies sin senal de cierre (fail-closed)', () => {
  for (const sources of [{}, { state: 'OPEN' }, { isClosed: false }, { state: 'open' }]) {
    const rec = reconcileStateLabels({
      issue: 1,
      currentLabels: ['blocked:dependencies'],
      sources,
    });
    assert.deepEqual(rec.toRemove, [], `no debe remover con sources=${JSON.stringify(sources)}`);
  }
});

test('allowlist reconciliable incluye needs-human y blocked:dependencies (#4732)', () => {
  assert.deepEqual(RECONCILABLE_STATE_LABELS, ['needs-human', 'blocked:dependencies']);
  assert.equal(isReconciliableStateLabel('needs-human'), true);
  assert.equal(isReconciliableStateLabel('blocked:dependencies'), true);
  assert.equal(isReconciliableStateLabel('qa:pending'), false);
  assert.equal(isReconciliableStateLabel('area:infra'), false);
});
