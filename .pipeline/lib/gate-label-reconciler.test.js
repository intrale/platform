// .pipeline/lib/gate-label-reconciler.test.js
// Tests node --test del dueño único de labels de gate (#4572, SEC-R4 / CA-3).
// Cobertura objetivo: 100% de ramas.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const {
  GATE_LABELS,
  targetLabelFor,
  assertMutualExclusion,
  reconcileGateLabels,
  buildLabelActions,
} = require('./gate-label-reconciler');

// ----------------------------------------------------------------------------
// targetLabelFor — mapeo veredicto → label
// ----------------------------------------------------------------------------

test('targetLabelFor mapea pass/fail/requires-operator/desconocido', () => {
  assert.strictEqual(targetLabelFor('pass'), 'qa:passed');
  assert.strictEqual(targetLabelFor('fail'), 'qa:failed');
  assert.strictEqual(targetLabelFor('requires-operator'), 'qa:pending');
  assert.strictEqual(targetLabelFor('lo-que-sea'), 'qa:pending'); // fail-closed
});

// ----------------------------------------------------------------------------
// reconcileGateLabels — remove-then-add + exclusión mutua (CA-3)
// ----------------------------------------------------------------------------

test('reconcileGateLabels: verdict pass sobre issue con qa:failed remueve failed y agrega passed', () => {
  const rec = reconcileGateLabels({ currentLabels: ['qa:failed', 'area:pipeline'], verdict: 'pass' });
  assert.deepStrictEqual(rec.toRemove, ['qa:failed']);
  assert.deepStrictEqual(rec.toAdd, ['qa:passed']);
  assert.strictEqual(rec.target, 'qa:passed');
});

test('reconcileGateLabels: verdict fail sobre issue con qa:passed remueve passed y agrega failed', () => {
  const rec = reconcileGateLabels({ currentLabels: ['qa:passed'], verdict: 'fail' });
  assert.deepStrictEqual(rec.toRemove, ['qa:passed']);
  assert.deepStrictEqual(rec.toAdd, ['qa:failed']);
});

test('reconcileGateLabels: requires-operator apunta a qa:pending, no a passed', () => {
  const rec = reconcileGateLabels({ currentLabels: ['qa:passed', 'qa:failed'], verdict: 'requires-operator' });
  assert.strictEqual(rec.target, 'qa:pending');
  assert.deepStrictEqual(rec.toAdd, ['qa:pending']);
  // Debe remover AMBOS labels de gate ilegales presentes.
  assert.deepStrictEqual(rec.toRemove.sort(), ['qa:failed', 'qa:passed']);
});

test('reconcileGateLabels: idempotente si el target ya está y no hay otros de gate', () => {
  const rec = reconcileGateLabels({ currentLabels: ['qa:passed'], verdict: 'pass' });
  assert.deepStrictEqual(rec.toAdd, []);
  assert.deepStrictEqual(rec.toRemove, []);
});

test('reconcileGateLabels: sin labels actuales agrega solo el target', () => {
  const rec = reconcileGateLabels({ verdict: 'pass' });
  assert.deepStrictEqual(rec.toAdd, ['qa:passed']);
  assert.deepStrictEqual(rec.toRemove, []);
});

test('reconcileGateLabels: currentLabels no-array se trata como vacío', () => {
  const rec = reconcileGateLabels({ currentLabels: null, verdict: 'fail' });
  assert.deepStrictEqual(rec.toAdd, ['qa:failed']);
});

test('reconcileGateLabels: convergencia bajo doble aplicación (race ≤3 agentes)', () => {
  const start = ['qa:failed'];
  // Primera reconciliación con verdict pass.
  const rec1 = reconcileGateLabels({ currentLabels: start, verdict: 'pass' });
  // Aplicar acciones al estado.
  let state = new Set(start);
  for (const l of rec1.toRemove) state.delete(l);
  for (const l of rec1.toAdd) state.add(l);
  assert.ok(state.has('qa:passed') && !state.has('qa:failed'));
  // Segunda reconciliación desde el estado ya convergido: no-op.
  const rec2 = reconcileGateLabels({ currentLabels: [...state], verdict: 'pass' });
  assert.deepStrictEqual(rec2.toAdd, []);
  assert.deepStrictEqual(rec2.toRemove, []);
});

test('reconcileGateLabels: nunca deja qa:passed y qa:failed coexistiendo', () => {
  // Cualquier veredicto sobre un estado ya envenenado debe limpiarlo.
  for (const verdict of ['pass', 'fail', 'requires-operator']) {
    const rec = reconcileGateLabels({ currentLabels: ['qa:passed', 'qa:failed'], verdict });
    const projected = new Set(['qa:passed', 'qa:failed']);
    for (const l of rec.toRemove) projected.delete(l);
    for (const l of rec.toAdd) projected.add(l);
    assert.ok(!(projected.has('qa:passed') && projected.has('qa:failed')),
      `verdict ${verdict} dejó combinación ilegal`);
  }
});

// El validador es defensa en profundidad: en el flujo normal remove-then-add
// nunca produce la combinación ilegal, pero verificamos que la salvaguarda
// interna existe cubriendo GATE_LABELS exportado.
test('GATE_LABELS expone los tres labels bajo dominio del reconciliador', () => {
  assert.deepStrictEqual(GATE_LABELS, ['qa:passed', 'qa:failed', 'qa:pending']);
});

// ----------------------------------------------------------------------------
// assertMutualExclusion — guard directo (SEC-R4)
// ----------------------------------------------------------------------------

test('assertMutualExclusion lanza ante qa:passed + qa:failed juntos', () => {
  assert.throws(() => assertMutualExclusion(['qa:passed', 'qa:failed']), /combinación ilegal/);
  assert.throws(() => assertMutualExclusion(new Set(['qa:passed', 'qa:failed']), { target: 'x' }), /ilegal/);
});

test('assertMutualExclusion no lanza ante estados legales', () => {
  assert.doesNotThrow(() => assertMutualExclusion(['qa:passed']));
  assert.doesNotThrow(() => assertMutualExclusion(['qa:failed', 'qa:pending']));
  assert.doesNotThrow(() => assertMutualExclusion(null));
  assert.doesNotThrow(() => assertMutualExclusion(new Set(['qa:pending'])));
});

// ----------------------------------------------------------------------------
// buildLabelActions — formato de queue del servicio-github
// ----------------------------------------------------------------------------

test('buildLabelActions emite remove-label antes de label (remove-then-add)', () => {
  const rec = reconcileGateLabels({ currentLabels: ['qa:failed'], verdict: 'pass' });
  const actions = buildLabelActions({ issue: '4572', reconciliation: rec });
  assert.strictEqual(actions.length, 2);
  assert.deepStrictEqual(actions[0], { action: 'remove-label', issue: 4572, label: 'qa:failed' });
  assert.deepStrictEqual(actions[1], { action: 'label', issue: 4572, label: 'qa:passed' });
});

test('buildLabelActions sin reconciliation devuelve []', () => {
  assert.deepStrictEqual(buildLabelActions({ issue: 1 }), []);
});

test('buildLabelActions sin argumentos devuelve []', () => {
  assert.deepStrictEqual(buildLabelActions(), []);
});
