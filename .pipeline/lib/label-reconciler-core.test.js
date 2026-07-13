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

test('qa:* y blocked:dependencies son dominio delegado y no se remueven', () => {
  const rec = reconcileStateLabels({
    issue: 1,
    currentLabels: ['needs-human', 'qa:pending', 'qa:failed', 'blocked:dependencies'],
    sources: { isEpic: true, epicChildrenAllDone: true, hasActiveHumanMarker: false },
  });
  assert.equal(rec.toRemove.includes('qa:pending'), false);
  assert.equal(rec.toRemove.includes('qa:failed'), false);
  assert.equal(rec.toRemove.includes('blocked:dependencies'), false);
});

test('allowlist hardcodeado solo incluye needs-human', () => {
  assert.deepEqual(RECONCILABLE_STATE_LABELS, ['needs-human']);
  assert.equal(isReconciliableStateLabel('needs-human'), true);
  assert.equal(isReconciliableStateLabel('qa:pending'), false);
  assert.equal(isReconciliableStateLabel('blocked:dependencies'), false);
  assert.equal(isReconciliableStateLabel('area:infra'), false);
});
