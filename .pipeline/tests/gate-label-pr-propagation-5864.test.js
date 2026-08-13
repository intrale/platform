'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { applyGateLabelAction } = require('../servicio-github');
process.env.PULPO_NO_AUTOSTART = '1';
const { gatePrPropagationDecision } = require('../pulpo');

function fakeGithubClient(initialLabels) {
  const labels = new Set(initialLabels); const calls = [];
  return { labels, calls,
    getPrLabels() { calls.push('getPrLabels'); return [...labels]; },
    getIssueLabels() { calls.push('getIssueLabels'); return []; },
    editPullRequest(_number, { addLabel, removeLabel }) {
      calls.push(removeLabel ? `pr:remove:${removeLabel}` : `pr:add:${addLabel}`);
      if (removeLabel) labels.delete(removeLabel); if (addLabel) labels.add(addLabel);
    },
    editIssue() { calls.push('editIssue'); },
    listLabels() { return [{ name: 'qa:passed' }]; },
    createLabel() { return { created: true }; },
  };
}

test('issue aprobado se propaga al PR y conserva labels no relacionados', () => {
  const ghClient = fakeGithubClient(['needs-definition']);
  assert.equal(applyGateLabelAction({ action: 'label', issue: 5519, target: 'pr', label: 'qa:passed' }, ghClient), true);
  assert.deepEqual([...ghClient.labels].sort(), ['needs-definition', 'qa:passed']);
  assert.equal(ghClient.calls.includes('editIssue'), false);
});

test('PR con qa:failed elimina el incompatible antes de agregar qa:passed', () => {
  const ghClient = fakeGithubClient(['qa:failed']);
  applyGateLabelAction({ action: 'label', issue: 5788, target: 'pr', label: 'qa:passed' }, ghClient);
  assert.deepEqual([...ghClient.labels], ['qa:passed']);
  assert.deepEqual(ghClient.calls.filter((c) => c.startsWith('pr:')), ['pr:remove:qa:failed', 'pr:add:qa:passed']);
  assert.equal(ghClient.calls.includes('getIssueLabels'), false);
});

test('acción no-gate destinada a PR no usa la API de issues', () => {
  const ghClient = fakeGithubClient([]);
  assert.equal(applyGateLabelAction({ action: 'label', issue: 5790, target: 'pr', label: 'needs-human' }, ghClient), false);
  assert.equal(ghClient.calls.includes('editIssue'), false);
});

for (const reason of ['fetch_failed', 'ambiguous_match', 'cross_repository']) {
  test(`pulpo retiene la promoción cuando la resolución estricta falla con ${reason}`, () => {
    const retentions = [];
    const decision = gatePrPropagationDecision(
      { ok: false, reason, detail: 'evidencia' },
      { retain: (code, detail) => retentions.push({ code, detail }) },
    );
    assert.deepEqual(decision, {
      allowPromotion: false,
      propagate: false,
      code: `pr-propagation-${reason}`,
      detail: 'evidencia',
    });
    assert.deepEqual(retentions, [{ code: `pr-propagation-${reason}`, detail: 'evidencia' }]);
  });
}

// El PR lo crea `delivery.js` en `entrega`, la ÚLTIMA fase; GATE 0 corre al
// promover `verificacion`. "Todavía no hay PR" es el caso normal en ese punto:
// retenerlo dejaría a todo issue clavado en waiting-operator (pipeline caído).
test('pulpo no retiene por no_strict_match: en GATE 0 el PR todavía no existe', () => {
  const retentions = [];
  const decision = gatePrPropagationDecision(
    { ok: false, reason: 'no_strict_match' },
    { retain: (code, detail) => retentions.push({ code, detail }) },
  );
  assert.deepEqual(decision, {
    allowPromotion: true,
    propagate: false,
    code: 'pr-propagation-no_strict_match',
    detail: null,
  });
  assert.deepEqual(retentions, []);
});

test('pulpo sólo propaga cuando el resolvedor estricto confirma el PR', () => {
  let retained = false;
  assert.deepEqual(gatePrPropagationDecision(
    { ok: true, pr: { number: 5788 } },
    { retain: () => { retained = true; } },
  ), {
    allowPromotion: true,
    propagate: true,
  });
  assert.equal(retained, false);
});

// ---- Propagación desde `entrega` (delivery.js), donde el PR ya existe -------

const { buildPrGatePropagation } = require('../delivery');

test('delivery propaga el label vigente del issue al PR recién creado (caso #5519/#5788/#5790)', () => {
  const res = buildPrGatePropagation({
    issue: '5400',
    prNumber: '5519',
    branch: 'agent/5400-pipeline-dev',
    issueLabels: [{ name: 'needs-definition' }, { name: 'qa:passed' }],
  });
  assert.deepEqual(res, {
    ok: true,
    action: { action: 'label', issue: 5519, target: 'pr', label: 'qa:passed' },
  });
});

test('delivery propaga qa:failed sin invertir la autoridad (issue → PR)', () => {
  const res = buildPrGatePropagation({
    issue: 5723,
    prNumber: 5788,
    branch: 'agent/5723-pipeline-dev',
    issueLabels: ['qa:failed'],
  });
  assert.equal(res.ok, true);
  assert.equal(res.action.label, 'qa:failed');
  assert.equal(res.action.issue, 5788);
});

test('delivery no propaga si el issue no tiene label de gate (fail-closed)', () => {
  const res = buildPrGatePropagation({
    issue: 5864, prNumber: 5900, branch: 'agent/5864-pipeline-dev',
    issueLabels: [{ name: 'bug' }, { name: 'area:pipeline' }],
  });
  assert.deepEqual(res, { ok: false, reason: 'issue_sin_label_de_gate' });
});

test('delivery no propaga si el issue trae labels de gate en conflicto', () => {
  const res = buildPrGatePropagation({
    issue: 5864, prNumber: 5900, branch: 'agent/5864-pipeline-dev',
    issueLabels: ['qa:passed', 'qa:failed'],
  });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'labels_de_gate_en_conflicto');
  assert.deepEqual(res.labels, ['qa:passed', 'qa:failed']);
});

// SEC-1: el vínculo lo da la rama, no el cuerpo del PR ("Closes #<aprobado>").
test('delivery no propaga a un PR cuya rama no corresponde al issue aprobado', () => {
  const res = buildPrGatePropagation({
    issue: 5400, prNumber: 5999, branch: 'feature/otra-cosa',
    issueLabels: ['qa:passed'],
  });
  assert.deepEqual(res, { ok: false, reason: 'rama_no_corresponde_al_issue', branch: 'feature/otra-cosa' });
});

test('delivery no propaga sin PR resoluble ni sin issue', () => {
  assert.deepEqual(
    buildPrGatePropagation({ issue: 5864, prNumber: null, branch: 'agent/5864-x', issueLabels: ['qa:passed'] }),
    { ok: false, reason: 'pr_no_resuelto' },
  );
  assert.deepEqual(
    buildPrGatePropagation({ issue: null, prNumber: 5900, branch: 'agent/5864-x', issueLabels: ['qa:passed'] }),
    { ok: false, reason: 'sin_issue' },
  );
});

// La orden encolada por delivery, ejecutada por el worker, deja el PR con el
// label correcto y sin tocar la API de issues (SEC-5) — cierre punta a punta.
test('la orden que encola delivery termina etiquetando el PR vía el worker', () => {
  const res = buildPrGatePropagation({
    issue: 5708, prNumber: 5790, branch: 'agent/5708-pipeline-dev',
    issueLabels: ['qa:passed'],
  });
  const ghClient = fakeGithubClient(['needs-definition', 'qa:failed']);
  assert.equal(applyGateLabelAction(res.action, ghClient), true);
  assert.deepEqual([...ghClient.labels].sort(), ['needs-definition', 'qa:passed']);
  assert.equal(ghClient.calls.includes('editIssue'), false);
});
