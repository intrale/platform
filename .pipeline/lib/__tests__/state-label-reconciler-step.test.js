'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'v3-state-labels-'));
const PIPELINE = path.join(TMP_DIR, '.pipeline');
const GH_QUEUE = path.join(PIPELINE, 'servicios', 'github', 'pendiente');

fs.mkdirSync(GH_QUEUE, { recursive: true });
fs.mkdirSync(path.join(PIPELINE, 'desarrollo', 'dev', 'pendiente'), { recursive: true });
fs.mkdirSync(path.join(PIPELINE, 'desarrollo', 'validacion', 'bloqueado-humano'), { recursive: true });
fs.mkdirSync(path.join(PIPELINE, 'definicion', 'analisis', 'bloqueado-humano'), { recursive: true });

process.env.CLAUDE_PROJECT_DIR = TMP_DIR;
process.env.PIPELINE_REPO_ROOT = TMP_DIR;
process.env.PIPELINE_STATE_DIR = PIPELINE;
process.env.PIPELINE_MAIN_ROOT = TMP_DIR;

delete require.cache[require.resolve('../../servicio-reconciler')];
const reconciler = require('../../servicio-reconciler');

function clearGhQueue() {
  for (const f of fs.readdirSync(GH_QUEUE)) {
    try { fs.unlinkSync(path.join(GH_QUEUE, f)); } catch {}
  }
}

function listGhQueue() {
  return fs.readdirSync(GH_QUEUE)
    .filter(f => f.endsWith('.json'))
    .map(f => JSON.parse(fs.readFileSync(path.join(GH_QUEUE, f), 'utf8')));
}

test('reconcileStateLabelsStep encola remove-label needs-human y audita por cola segura', () => {
  clearGhQueue();
  const audits = [];
  const result = reconciler.reconcileStateLabelsStep([
    { number: 4661, labels: ['needs-human', 'epic', 'area:infra'] },
  ], {
    resolveSources: () => ({ isEpic: true, epicChildrenAllDone: true, hasActiveHumanMarker: false }),
    logAudit: (entry) => audits.push(entry),
  });

  assert.equal(result.removed, 1);
  assert.equal(result.removedIssues.has(4661), true);
  assert.deepEqual(listGhQueue(), [{ action: 'remove-label', issue: 4661, label: 'needs-human' }]);
  assert.equal(audits.length, 1);
  assert.equal(audits[0].oracle, 'epic-children-all-done');
});

test('reconcileStateLabelsStep no encola qa ni blocked:dependencies', () => {
  clearGhQueue();
  const result = reconciler.reconcileStateLabelsStep([
    { number: 4662, labels: ['qa:pending', 'blocked:dependencies', 'area:infra'] },
  ], {
    resolveSources: () => ({ isEpic: true, epicChildrenAllDone: true, hasActiveHumanMarker: false }),
  });

  assert.equal(result.removed, 0);
  assert.deepEqual(listGhQueue(), []);
});

test('resolveEpicStateSources usa hijos de split y title-cache con fail-closed', () => {
  const childrenMap = new Map([[4661, [4662, 4663]]]);
  const issueStates = { 4662: { state: 'closed' }, 4663: { labels: ['status:done'] } };
  const sources = reconciler.resolveEpicStateSources(
    { number: 4661, labels: ['needs-human'] },
    { childrenMap, issueStates, blockedByIssue: new Map() },
  );

  assert.deepEqual(sources, {
    isEpic: true,
    epicChildrenAllDone: true,
    hasActiveHumanMarker: false,
  });
});
