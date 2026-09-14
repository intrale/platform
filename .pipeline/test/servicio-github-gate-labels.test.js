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

for (const target of ['issue', 'pr']) {
  test(`#7206 cola ${target}: prefijos distintos y revocación reintentada tras re-ratificar`, () => {
    const { pipeline, service } = loadServiceWithTempState();
    const queue = path.join(pipeline, 'servicios/github');
    const ghClient = fakeGithubClient({ 7206: ['qa:pending'] });
    ghClient.editPullRequest = ghClient.editIssue;
    ghClient.getPrLabels = ghClient.getIssueLabels;
    const oldName = '7206-seal-caduco-gate-20260912200000000.json';
    const newName = '7206-reratificado-gate-20260912200100000.json';
    const order = (label) => ({ action: 'label', issue: 7206, target, label, origen: 'gate-caducidad-sello' });
    const enqueue = (name, data) => fs.writeFileSync(path.join(queue, 'pendiente', name), JSON.stringify(data));
    enqueue(oldName, order('qa:pending'));
    enqueue(newName, order('qa:passed'));
    console.log('Orden filesystem:', fs.readdirSync(path.join(queue, 'pendiente')));
    service.processQueue({ ghClient });
    assert.deepEqual(ghClient.getIssueLabels(7206), ['qa:passed']);
    assert.equal(JSON.parse(fs.readFileSync(path.join(queue, 'listo', oldName))).discarded, 'superseded-gate-order');
    // Simula reinicio real del módulo y reintento tardío con nombre original.
    const servicePath = require.resolve('../servicio-github');
    delete require.cache[servicePath];
    enqueue(oldName, { ...order('qa:pending'), retries: 1 });
    require(servicePath).processQueue({ ghClient });
    assert.deepEqual(ghClient.getIssueLabels(7206), ['qa:passed']);
    console.log(`${target}: qa:passed después de cola y reintento tras reinicio`);
    // Una caducidad realmente posterior conserva su capacidad de cerrar QA.
    enqueue('7206-seal-caduco-gate-20260912200200000.json', order('qa:pending'));
    require(servicePath).processQueue({ ghClient });
    assert.deepEqual(ghClient.getIssueLabels(7206), ['qa:pending']);
  });
}

test('#7206 fallo parcial: mismo intento puede completar; una orden vieja no puede revocar', () => {
  const { pipeline, service } = loadServiceWithTempState();
  const queue = path.join(pipeline, 'servicios/github');
  const ghClient = fakeGithubClient({ 7206: ['qa:pending'] });
  const edit = ghClient.editIssue;
  let fail = true;
  ghClient.editIssue = function (issue, change) {
    if (change.addLabel === 'qa:passed' && fail) { fail = false; throw new Error('API temporal'); }
    return edit.call(this, issue, change);
  };
  for (const [name, label] of [
    ['7206-seal-caduco-gate-20260912200000000.json', 'qa:pending'],
    ['7206-reratificado-gate-20260912200100000.json', 'qa:passed'],
  ]) fs.writeFileSync(path.join(queue, 'pendiente', name), JSON.stringify({ action: 'label', issue: 7206, label, origen: 'gate-caducidad-sello' }));
  service.processQueue({ ghClient });
  service.processQueue({ ghClient });
  assert.deepEqual(ghClient.getIssueLabels(7206), ['qa:passed']);
});
