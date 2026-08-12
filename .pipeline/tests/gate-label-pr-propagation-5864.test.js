'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { applyGateLabelAction } = require('../servicio-github');

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
