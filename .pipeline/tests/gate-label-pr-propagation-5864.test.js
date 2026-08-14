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

// ============================================================================
// RUNTIME REAL de la fase `entrega` — `skills-deterministicos/delivery.js`.
// ============================================================================
//
// El provider determinístico resuelve el skill como
// `PIPELINE/skills-deterministicos/<skill>.js`
// (`lib/agent-launcher/providers/deterministic.js:resolveDeterministicScript`).
// `.pipeline/delivery.js` es el CLI manual del skill `/delivery` (#2870) y NO
// se ejecuta en la fase `entrega`: por eso CA-1 se cierra acá, en el módulo que
// el pipeline sí ejecuta, y justo antes de que la Fase 5 lea el snapshot del PR.
const runtimeDelivery = require('../skills-deterministicos/delivery');

test('el módulo que el pipeline ejecuta en `entrega` expone la propagación', () => {
  assert.equal(typeof runtimeDelivery.buildPrGatePropagation, 'function');
  assert.equal(typeof runtimeDelivery.propagateGateLabelToPr, 'function');
});

// --- CA-1 · regresión del caso real #5519 / #5788 / #5790 -------------------
for (const { issue, pr } of [{ issue: 5400, pr: 5519 }, { issue: 5723, pr: 5788 }, { issue: 5708, pr: 5790 }]) {
  test(`CA-1 (runtime): issue #${issue} en qa:passed etiqueta al PR #${pr} que sólo tenía needs-definition`, () => {
    const res = runtimeDelivery.buildPrGatePropagation({
      issue, prNumber: pr, branch: `agent/${issue}-pipeline-dev`,
      issueLabels: [{ name: 'qa:passed' }, { name: 'Ready' }],
      prLabels: ['needs-definition'],
    });
    assert.deepEqual(res, { ok: true, target: 'qa:passed', toAdd: ['qa:passed'], toRemove: [] });
  });
}

test('CA-1 (runtime): qa:skipped también viaja del issue al PR', () => {
  const res = runtimeDelivery.buildPrGatePropagation({
    issue: 5864, prNumber: 5900, branch: 'agent/5864-pipeline-dev',
    issueLabels: ['qa:skipped', 'area:pipeline'], prLabels: [],
  });
  assert.equal(res.ok, true);
  assert.equal(res.target, 'qa:skipped');
  assert.equal(runtimeDelivery.hasQaGate([res.target]), true);
});

// --- CA-4 / SEC-4 · exclusión mutua sobre los labels DEL PR ----------------
test('CA-4 (runtime): PR que arrastraba qa:failed queda sólo con qa:passed', () => {
  const res = runtimeDelivery.buildPrGatePropagation({
    issue: 5864, prNumber: 5900, branch: 'agent/5864-pipeline-dev',
    issueLabels: ['qa:passed'], prLabels: ['qa:failed', 'needs-definition'],
  });
  assert.equal(res.ok, true);
  assert.deepEqual(res.toRemove, ['qa:failed']);
  assert.deepEqual(res.toAdd, ['qa:passed']);
  const projected = new Set(['qa:failed', 'needs-definition']);
  for (const l of res.toRemove) projected.delete(l);
  for (const l of res.toAdd) projected.add(l);
  assert.equal(projected.has('qa:failed') && projected.has('qa:passed'), false);
});

// --- SEC-1 · el vínculo lo hace la rama, nunca el `Closes #<n>` del cuerpo --
test('SEC-1 (runtime): el prefijo exige el separador — 586 / 58640 no matchean el 5864', () => {
  for (const branch of ['agent/586-x', 'agent/58640-x', 'main', 'feature/5864-x', 'agent/9999-otro', '']) {
    const res = runtimeDelivery.buildPrGatePropagation({
      issue: 5864, prNumber: 5900, branch, issueLabels: ['qa:passed'], prLabels: [],
    });
    assert.equal(res.ok, false, `la rama "${branch}" no debió resolver`);
    assert.equal(res.reason, 'rama_no_corresponde_al_issue');
  }
});

// --- CA-3 / SEC-2 · fail-closed: jamás se infiere aprobación ---------------
test('CA-3 (runtime): issue sin label de gate no escribe nada en el PR', () => {
  assert.deepEqual(runtimeDelivery.buildPrGatePropagation({
    issue: 5864, prNumber: 5900, branch: 'agent/5864-pipeline-dev',
    issueLabels: ['Ready', 'area:pipeline'], prLabels: [],
  }), { ok: false, reason: 'issue_sin_label_de_gate' });
});

test('CA-3 (runtime): sin PR resoluble no se escribe ningún label', () => {
  assert.equal(runtimeDelivery.buildPrGatePropagation({
    issue: 5864, prNumber: null, branch: 'agent/5864-pipeline-dev', issueLabels: ['qa:passed'],
  }).reason, 'pr_no_resuelto');
  assert.equal(runtimeDelivery.buildPrGatePropagation({
    issue: null, prNumber: 5900, branch: 'agent/5864-pipeline-dev', issueLabels: ['qa:passed'],
  }).reason, 'sin_issue');
});

test('SEC-2 (runtime): issue con señal positiva y negativa a la vez no toca el PR', () => {
  const res = runtimeDelivery.buildPrGatePropagation({
    issue: 5864, prNumber: 5900, branch: 'agent/5864-pipeline-dev',
    issueLabels: ['qa:passed', 'qa:failed'], prLabels: [],
  });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'labels_de_gate_en_conflicto');
});

test('SEC-3 (runtime): la verdad negativa se propaga y deja el gate cerrado', () => {
  const res = runtimeDelivery.buildPrGatePropagation({
    issue: 5864, prNumber: 5900, branch: 'agent/5864-pipeline-dev',
    issueLabels: ['qa:failed'], prLabels: ['qa:passed'],
  });
  assert.equal(res.ok, true);
  assert.equal(res.target, 'qa:failed');
  assert.deepEqual(res.toRemove, ['qa:passed']);
  assert.equal(runtimeDelivery.hasQaGate([res.target]), false);
});

test('idempotencia (runtime): PR ya reconciliado no dispara ninguna escritura', () => {
  assert.deepEqual(runtimeDelivery.buildPrGatePropagation({
    issue: 5864, prNumber: 5900, branch: 'agent/5864-pipeline-dev',
    issueLabels: ['qa:passed'], prLabels: ['qa:passed', 'needs-definition'],
  }), { ok: false, reason: 'pr_ya_reconciliado', labels: ['qa:passed'] });
});

// --- SEC-5 · la escritura va por la API de PRs, jamás por la de issues -----
function fakeGhRunner(prLabels, editExit = 0) {
  const calls = [];
  const runner = (ghArgs) => {
    calls.push(ghArgs);
    if (ghArgs[0] === 'pr' && ghArgs[1] === 'view') {
      return { exit_code: 0, stderr: '', stdout: JSON.stringify({ labels: prLabels.map((name) => ({ name })) }) };
    }
    return { exit_code: editExit, stdout: '', stderr: editExit ? 'boom' : '' };
  };
  return { runner, calls };
}

test('SEC-5 (runtime): la propagación usa `gh pr edit`, nunca `gh issue edit`', () => {
  const { runner, calls } = fakeGhRunner(['qa:failed']);
  const applied = runtimeDelivery.propagateGateLabelToPr({
    issue: 5864, prNumber: 5900, branch: 'agent/5864-pipeline-dev',
    issueLabels: ['qa:passed'], log: () => {}, ghImpl: runner,
  });
  assert.deepEqual(applied, ['qa:passed']);
  assert.deepEqual(
    calls.find((a) => a[1] === 'edit'),
    ['pr', 'edit', '5900', '--remove-label', 'qa:failed', '--add-label', 'qa:passed'],
  );
  assert.equal(calls.some((a) => a[0] === 'issue'), false);
});

test('SEC-7 (runtime): si `gh pr edit` falla no se reporta label aplicado y queda el motivo', () => {
  const { runner } = fakeGhRunner([], 1);
  const logs = [];
  const applied = runtimeDelivery.propagateGateLabelToPr({
    issue: 5864, prNumber: 5900, branch: 'agent/5864-pipeline-dev',
    issueLabels: ['qa:passed'], log: (m) => logs.push(m), ghImpl: runner,
  });
  assert.deepEqual(applied, []);
  assert.match(logs.join('\n'), /gh pr edit fall/);
});

test('la propagación nunca es fatal: una excepción de gh se traga y el gate sigue cerrado', () => {
  const logs = [];
  const applied = runtimeDelivery.propagateGateLabelToPr({
    issue: 5864, prNumber: 5900, branch: 'agent/5864-pipeline-dev',
    issueLabels: ['qa:passed'], log: (m) => logs.push(m),
    ghImpl: () => { throw new Error('ENOENT gh'); },
  });
  assert.deepEqual(applied, []);
  assert.equal(logs.length > 0, true);
});

// ---- CLI manual `/delivery` (`.pipeline/delivery.js`, #2870) ---------------
// Segundo punto de entrada, invocado a mano por el skill `/delivery`. No es el
// camino del pipeline (ver bloque de arriba), pero cierra el mismo tramo.

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
