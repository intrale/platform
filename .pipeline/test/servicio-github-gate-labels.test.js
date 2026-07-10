'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function loadServiceWithTempState() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'svc-github-gate-'));
  const pipeline = path.join(root, '.pipeline');
  for (const dir of [
    'servicios/github/pendiente',
    'servicios/github/trabajando',
    'servicios/github/listo',
    'servicios/github/fallido',
    'logs',
  ]) {
    fs.mkdirSync(path.join(pipeline, dir), { recursive: true });
  }

  process.env.PIPELINE_STATE_DIR = pipeline;
  const servicePath = path.resolve(__dirname, '..', 'servicio-github.js');
  delete require.cache[servicePath];
  const service = require(servicePath);
  service._resetLabelCacheForTests();
  return { root, pipeline, service };
}

function fakeGithubClient(initialLabels) {
  const labelsByIssue = new Map(Object.entries(initialLabels).map(([k, v]) => [String(k), new Set(v)]));
  const calls = [];
  return {
    calls,
    listLabels() {
      return [];
    },
    createLabel(name) {
      calls.push(['createLabel', name]);
      return { created: true };
    },
    getIssueLabels(issue) {
      return [...(labelsByIssue.get(String(issue)) || new Set())];
    },
    editIssue(issue, { addLabel, removeLabel } = {}) {
      const key = String(issue);
      if (!labelsByIssue.has(key)) labelsByIssue.set(key, new Set());
      const labels = labelsByIssue.get(key);
      if (removeLabel) {
        calls.push(['removeLabel', issue, removeLabel]);
        labels.delete(removeLabel);
      }
      if (addLabel) {
        calls.push(['addLabel', issue, addLabel]);
        labels.add(addLabel);
      }
    },
    commentIssue() {},
    createIssue() {
      return { number: 1, url: 'https://example.test/1' };
    },
  };
}

test('servicio-github normaliza label legacy qa:passed con remove-then-add', () => {
  const { pipeline, service } = loadServiceWithTempState();
  const pending = path.join(pipeline, 'servicios/github/pendiente', '1.json');
  fs.writeFileSync(pending, JSON.stringify({ action: 'label', issue: 4572, label: 'qa:passed' }));
  const ghClient = fakeGithubClient({ 4572: ['qa:failed', 'area:pipeline'] });

  service.processQueue({ ghClient });

  assert.deepEqual(
    ghClient.calls.filter((c) => c[0] === 'removeLabel' || c[0] === 'addLabel'),
    [
      ['removeLabel', 4572, 'qa:failed'],
      ['addLabel', 4572, 'qa:passed'],
    ],
  );
  const listo = JSON.parse(fs.readFileSync(path.join(pipeline, 'servicios/github/listo', '1.json'), 'utf8'));
  assert.equal(listo.gate_reconciled, true);
  assert.deepEqual(listo.gate_reconciled_from, ['qa:failed', 'area:pipeline']);
});

test('servicio-github bloquea remove-label legacy de labels QA', () => {
  const { pipeline, service } = loadServiceWithTempState();
  const pending = path.join(pipeline, 'servicios/github/pendiente', '2.json');
  fs.writeFileSync(pending, JSON.stringify({ action: 'remove-label', issue: 4572, label: 'qa:passed' }));
  const ghClient = fakeGithubClient({ 4572: ['qa:passed'] });

  service.processQueue({ ghClient });

  assert.deepEqual(ghClient.calls.filter((c) => c[0] === 'removeLabel' || c[0] === 'addLabel'), []);
  const listo = JSON.parse(fs.readFileSync(path.join(pipeline, 'servicios/github/listo', '2.json'), 'utf8'));
  assert.equal(listo.discarded, 'legacy-gate-label-remove-blocked');
});
