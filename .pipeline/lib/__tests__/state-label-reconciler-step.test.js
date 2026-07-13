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

test('resolveEpicStateSources usa hijos de split y estados frescos del cache', () => {
  const NOW = 1_776_810_000_000;
  const childrenMap = new Map([[4661, [4662, 4663]]]);
  const issueStates = {
    4662: { state: 'closed', fetchedAt: NOW },
    4663: { labels: ['status:done'], fetchedAt: NOW },
  };
  const sources = reconciler.resolveEpicStateSources(
    { number: 4661, labels: ['needs-human'] },
    { childrenMap, issueStates, blockedByIssue: new Map(), now: NOW },
  );

  assert.deepEqual(sources, {
    isEpic: true,
    epicChildrenAllDone: true,
    hasActiveHumanMarker: false,
  });
});

// #4672 — Cache stale: resolveEpicStateSources debe re-pedir estados live y, si
// el fetcher live confirma CLOSED, recién ahí abrir. Cache viejo NO alcanza.
test('resolveEpicStateSources refetchea live cuando el cache esta stale', () => {
  const NOW = 1_776_810_000_000;
  const STALE = NOW - 3600000 - 1; // fuera de la ventana de 1h
  const childrenMap = new Map([[4661, [4662, 4663]]]);
  const issueStates = {
    4662: { state: 'closed', fetchedAt: STALE },
    4663: { state: 'closed', fetchedAt: STALE },
  };
  const fetched = [];
  const sources = reconciler.resolveEpicStateSources(
    { number: 4661, labels: ['needs-human'] },
    {
      childrenMap,
      issueStates,
      blockedByIssue: new Map(),
      now: NOW,
      fetchIssueState: (num, now) => { fetched.push(num); return { state: 'CLOSED', fetchedAt: now }; },
    },
  );

  assert.deepEqual(fetched, [4662, 4663]);
  assert.equal(sources.epicChildrenAllDone, true);
});

// #4672 (security A01) — FAIL-CLOSED: si el fetch live no es autoritativo (gh
// devuelve UNKNOWN → fetcher devuelve null) y el cache esta stale, NO se abre el
// gate humano aunque el cache diga CLOSED.
test('resolveEpicStateSources FAIL-CLOSED con cache stale y fetch live no autoritativo', () => {
  const NOW = 1_776_810_000_000;
  const STALE = NOW - 3600000 - 1;
  const childrenMap = new Map([[4661, [4662]]]);
  const issueStates = { 4662: { state: 'closed', fetchedAt: STALE } };
  const sources = reconciler.resolveEpicStateSources(
    { number: 4661, labels: ['needs-human'] },
    {
      childrenMap,
      issueStates,
      blockedByIssue: new Map(),
      now: NOW,
      fetchIssueState: () => null, // gh UNKNOWN / error → no autoritativo
    },
  );

  assert.equal(sources.epicChildrenAllDone, false);
});

// #4672 — Sin `needs-human` no hay motivo (ni riesgo) de resolver hijos: el
// oráculo devuelve false sin tocar `gh` (evita IO y falla cerrado).
test('resolveEpicStateSources no resuelve hijos cuando el issue no tiene needs-human', () => {
  const NOW = 1_776_810_000_000;
  const childrenMap = new Map([[4661, [4662]]]);
  let called = false;
  const sources = reconciler.resolveEpicStateSources(
    { number: 4661, labels: ['epic'] },
    {
      childrenMap,
      issueStates: {},
      blockedByIssue: new Map(),
      now: NOW,
      fetchIssueState: () => { called = true; return { state: 'CLOSED', fetchedAt: NOW }; },
    },
  );

  assert.equal(called, false);
  assert.equal(sources.epicChildrenAllDone, false);
});
