// #2893 — Tests para resolveDeterministicScript: preferir worktree del
// issue cuando existe el script ahí, fallback a ROOT en otro caso.
//
// Motiva el fix del rebote: la verificacion corre desde ROOT (main) y
// usa la versión vieja de tester.js / builder.js / etc. Si un agente
// pipeline-dev modifica el script, el fix tiene que tomar efecto antes
// del merge para que la verificacion pueda aprobarlo.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

process.env.PULPO_NO_AUTOSTART = '1';
const pulpo = require('../pulpo.js');
const { resolveDeterministicScript } = pulpo;

// Fakes inyectables — evitamos depender de git real / fs real.
function fakeExecSyncReturning(out) {
  return () => out;
}
function fakeExecSyncThrowing() {
  return () => { throw new Error('git not available'); };
}
function fakeFs(existingPaths) {
  const set = new Set(existingPaths);
  return { existsSync: (p) => set.has(p) };
}

const ROOT = '/repo/platform';
const PIPELINE = path.join(ROOT, '.pipeline');

test('resolveDeterministicScript devuelve script de ROOT cuando no hay worktree del issue', () => {
  const result = resolveDeterministicScript({
    skill: 'tester',
    issue: 9999,
    ROOT,
    PIPELINE,
    execSyncImpl: fakeExecSyncReturning('worktree /repo/platform\nHEAD abc123\n\n'),
    fsImpl: fakeFs([path.join(PIPELINE, 'skills-deterministicos', 'tester.js')]),
  });
  assert.equal(result, path.join(PIPELINE, 'skills-deterministicos', 'tester.js'));
});

test('resolveDeterministicScript devuelve script del worktree cuando matchea el patrón y existe', () => {
  const wtRoot = '/repo/platform.agent-2893-pipeline-dev';
  const wtScript = path.join(wtRoot, '.pipeline', 'skills-deterministicos', 'tester.js');
  let hitWith = null;
  const result = resolveDeterministicScript({
    skill: 'tester',
    issue: 2893,
    ROOT,
    PIPELINE,
    execSyncImpl: fakeExecSyncReturning(
      'worktree /repo/platform\nHEAD abc123\n\n' +
      `worktree ${wtRoot}\nHEAD def456\nbranch refs/heads/agent/2893-pipeline-dev\n\n`
    ),
    fsImpl: fakeFs([wtScript, path.join(PIPELINE, 'skills-deterministicos', 'tester.js')]),
    onWorktreeHit: (wt) => { hitWith = wt; },
  });
  assert.equal(result, wtScript);
  assert.equal(hitWith, wtRoot, 'callback onWorktreeHit recibe el worktree path');
});

test('resolveDeterministicScript fallback a ROOT cuando worktree existe pero el script NO está', () => {
  const wtRoot = '/repo/platform.agent-2893-pipeline-dev';
  const rootScript = path.join(PIPELINE, 'skills-deterministicos', 'tester.js');
  const result = resolveDeterministicScript({
    skill: 'tester',
    issue: 2893,
    ROOT,
    PIPELINE,
    execSyncImpl: fakeExecSyncReturning(
      `worktree /repo/platform\nHEAD abc123\n\nworktree ${wtRoot}\nHEAD def456\n\n`
    ),
    // Sólo existe el script de ROOT, no el del worktree
    fsImpl: fakeFs([rootScript]),
  });
  assert.equal(result, rootScript);
});

test('resolveDeterministicScript fallback a ROOT cuando git worktree list lanza excepción', () => {
  const rootScript = path.join(PIPELINE, 'skills-deterministicos', 'tester.js');
  const result = resolveDeterministicScript({
    skill: 'tester',
    issue: 2893,
    ROOT,
    PIPELINE,
    execSyncImpl: fakeExecSyncThrowing(),
    fsImpl: fakeFs([rootScript]),
  });
  assert.equal(result, rootScript);
});

test('resolveDeterministicScript matchea worktree por número de issue (no se confunde con otros)', () => {
  // El patrón es `platform.agent-<issue>-` así que issue 2893 NO debe
  // matchear el worktree de issue 28930 (que empieza con 2893 también).
  const otherWt = '/repo/platform.agent-28930-android-dev';
  const targetWt = '/repo/platform.agent-2893-pipeline-dev';
  const targetScript = path.join(targetWt, '.pipeline', 'skills-deterministicos', 'tester.js');
  const otherScript = path.join(otherWt, '.pipeline', 'skills-deterministicos', 'tester.js');
  const rootScript = path.join(PIPELINE, 'skills-deterministicos', 'tester.js');
  const result = resolveDeterministicScript({
    skill: 'tester',
    issue: 2893,
    ROOT,
    PIPELINE,
    execSyncImpl: fakeExecSyncReturning(
      `worktree /repo/platform\nHEAD abc\n\n` +
      `worktree ${otherWt}\nHEAD ddd\n\n` +
      `worktree ${targetWt}\nHEAD eee\n\n`
    ),
    fsImpl: fakeFs([targetScript, otherScript, rootScript]),
  });
  assert.equal(result, targetScript, 'debe elegir el worktree correcto, no uno con número similar');
});

test('resolveDeterministicScript devuelve ROOT cuando no se pasa issue', () => {
  const rootScript = path.join(PIPELINE, 'skills-deterministicos', 'builder.js');
  const result = resolveDeterministicScript({
    skill: 'builder',
    issue: null,
    ROOT,
    PIPELINE,
    execSyncImpl: fakeExecSyncReturning(''),
    fsImpl: fakeFs([rootScript]),
  });
  assert.equal(result, rootScript);
});

test('resolveDeterministicScript funciona para todos los skills determinísticos esperados', () => {
  const skills = ['tester', 'builder', 'linter', 'delivery'];
  for (const skill of skills) {
    const wtRoot = '/repo/platform.agent-2893-pipeline-dev';
    const wtScript = path.join(wtRoot, '.pipeline', 'skills-deterministicos', `${skill}.js`);
    const result = resolveDeterministicScript({
      skill,
      issue: 2893,
      ROOT,
      PIPELINE,
      execSyncImpl: fakeExecSyncReturning(`worktree ${wtRoot}\nHEAD abc\n\n`),
      fsImpl: fakeFs([wtScript]),
    });
    assert.equal(result, wtScript, `worktree-first debe funcionar para skill=${skill}`);
  }
});
