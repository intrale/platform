// =============================================================================
// Tests brazo-desbloqueo-core.js — decisión pura de desbloqueo (EP5-H1, #3938)
//
// Cubre:
//   CA-4 · selectMarkersToRelease: libera markers cuando TODAS las deps están
//          CLOSED; mantiene bloqueados los que tienen alguna dep abierta o de
//          estado desconocido (fail-closed).
//   CA-4 · Caracterización: releaseDependencyBlockToPendiente reingresa los
//          work-files de bloqueado-dependencias/ a pendiente/ (integración FS
//          con tmp aislado, sin tocar la cola real).
//
// Fixtures con valores dummy, sin tokens reales (CA-8).
// =============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { selectMarkersToRelease, allDepsClosed } = require('../brazo-desbloqueo-core');

// -----------------------------------------------------------------------------
// allDepsClosed
// -----------------------------------------------------------------------------
test('allDepsClosed: todas CLOSED → true', () => {
  assert.equal(allDepsClosed([1234, 5678], { 1234: 'CLOSED', 5678: 'CLOSED' }), true);
});

test('allDepsClosed: alguna OPEN → false (fail-closed)', () => {
  assert.equal(allDepsClosed([1234, 5678], { 1234: 'CLOSED', 5678: 'OPEN' }), false);
});

test('allDepsClosed: dep de estado desconocido → false (fail-closed)', () => {
  assert.equal(allDepsClosed([1234, 9999], { 1234: 'CLOSED' }), false);
});

test('allDepsClosed: sin deps numéricas → false (no libera por este camino)', () => {
  assert.equal(allDepsClosed([], { 1234: 'CLOSED' }), false);
  assert.equal(allDepsClosed(null, {}), false);
});

test('allDepsClosed: normaliza claves string/number', () => {
  assert.equal(allDepsClosed(['1234'], { 1234: 'CLOSED' }), true);
  assert.equal(allDepsClosed([1234], { '1234': 'CLOSED' }), true);
});

// -----------------------------------------------------------------------------
// CA-4 · selectMarkersToRelease
// -----------------------------------------------------------------------------
test('CA-4: libera el marker con todas las deps CLOSED, mantiene el resto', () => {
  const markers = [
    { issue: 100, deps: [10, 11] },   // todas closed → release
    { issue: 200, deps: [20, 21] },   // 21 open → blocked
    { issue: 300, deps: [30] },       // unknown → blocked
  ];
  const issueStates = {
    10: 'CLOSED', 11: 'CLOSED',
    20: 'CLOSED', 21: 'OPEN',
    // 30 ausente (unknown)
  };
  const { toRelease, blocked } = selectMarkersToRelease({ markers, issueStates });

  assert.deepEqual(toRelease.map((m) => m.issue), [100]);
  assert.deepEqual(blocked.map((m) => m.issue).sort(), [200, 300]);
  // El blocked reporta las deps que siguen abiertas/desconocidas.
  const b200 = blocked.find((m) => m.issue === 200);
  assert.deepEqual(b200.openDeps, ['21']);
  const b300 = blocked.find((m) => m.issue === 300);
  assert.deepEqual(b300.openDeps, ['30']);
});

test('CA-4: ningún marker se libera si todos tienen deps abiertas', () => {
  const markers = [{ issue: 1, deps: [2] }, { issue: 3, deps: [4] }];
  const { toRelease } = selectMarkersToRelease({ markers, issueStates: { 2: 'OPEN', 4: 'OPEN' } });
  assert.equal(toRelease.length, 0);
});

test('CA-4: defensivo ante input vacío/no-array', () => {
  assert.deepEqual(selectMarkersToRelease({}), { toRelease: [], blocked: [] });
  assert.deepEqual(selectMarkersToRelease({ markers: null, issueStates: null }), { toRelease: [], blocked: [] });
});

test('selectMarkersToRelease ignora markers sin issue', () => {
  const { toRelease, blocked } = selectMarkersToRelease({
    markers: [{ deps: [1] }, null, { issue: 5, deps: [6] }],
    issueStates: { 6: 'CLOSED' },
  });
  assert.deepEqual(toRelease.map((m) => m.issue), [5]);
  assert.equal(blocked.length, 0);
});

// -----------------------------------------------------------------------------
// CA-4 · Caracterización: reingreso real a pendiente/ (rebote-classifier FS)
// -----------------------------------------------------------------------------
test('CA-4: releaseDependencyBlockToPendiente reingresa work-files a pendiente/', () => {
  // Aislar PIPELINE en tmp (mismo patrón que rebote-classifier.test.js).
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'v3-desbloqueo-core-'));
  fs.mkdirSync(path.join(TMP, '.claude'), { recursive: true });
  process.env.CLAUDE_PROJECT_DIR = TMP;
  process.env.PIPELINE_REPO_ROOT = TMP;
  // Requerir DESPUÉS de fijar env (trace.REPO_ROOT se resuelve al cargar).
  delete require.cache[require.resolve('../traceability')];
  delete require.cache[require.resolve('../rebote-classifier')];
  const reboteClassifier = require('../rebote-classifier');

  const pipeline = 'desarrollo';
  const phase = 'dev';
  const issue = 4242;
  const blockedDir = path.join(TMP, '.pipeline', pipeline, phase, reboteClassifier.DEPS_BLOCK_SUBDIR);
  const pendienteDir = path.join(TMP, '.pipeline', pipeline, phase, 'pendiente');
  fs.mkdirSync(blockedDir, { recursive: true });

  // Work-file dummy bloqueado por dependencias (sin secrets, CA-8).
  const wf = path.join(blockedDir, `${issue}.pipeline-dev`);
  fs.writeFileSync(wf, 'issue: 4242\nfase: dev\npipeline: desarrollo\n', 'utf8');

  const res = reboteClassifier.releaseDependencyBlockToPendiente({ issue });

  assert.ok(res && res.moved >= 1, 'debe mover al menos un archivo');
  // El work-file ahora está en pendiente/, ya no en bloqueado-dependencias/.
  assert.ok(fs.existsSync(path.join(pendienteDir, `${issue}.pipeline-dev`)), 'reingresado a pendiente/');
  assert.ok(!fs.existsSync(wf), 'ya no está en bloqueado-dependencias/');

  // Limpieza de cache para no contaminar otros tests del mismo proceso.
  delete require.cache[require.resolve('../rebote-classifier')];
  delete require.cache[require.resolve('../traceability')];
});
