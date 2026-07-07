'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const {
  phaseNeedsWorktree,
  phaseUsesExistingWorktree,
  phaseRunsInIssueWorktree,
  EXISTING_WORKTREE_PHASES,
} = require('../phase-workspace');

// Orden real de fases del pipeline `desarrollo` (config.yaml línea 14).
const FASES_DESARROLLO = ['validacion', 'dev', 'build', 'verificacion', 'linteo', 'aprobacion', 'entrega'];

test('solo dev crea un worktree nuevo', () => {
  assert.strictEqual(phaseNeedsWorktree('dev'), true);
  for (const fase of FASES_DESARROLLO.filter((f) => f !== 'dev')) {
    assert.strictEqual(phaseNeedsWorktree(fase), false, `${fase} no debe crear worktree`);
  }
});

test('verificacion reutiliza el worktree del issue (regresión #4532)', () => {
  // El bug: verificacion (tester/security/qa) corría en ROOT y evaluaba la rama
  // de otro agente, rechazando aunque el fix estaba en el worktree del issue.
  assert.strictEqual(phaseUsesExistingWorktree('verificacion'), true);
});

test('todas las fases post-dev que tocan código del issue reutilizan su worktree', () => {
  for (const fase of ['build', 'verificacion', 'linteo', 'aprobacion', 'entrega']) {
    assert.strictEqual(phaseUsesExistingWorktree(fase), true, `${fase} debe reutilizar worktree`);
  }
});

test('validacion (pre-dev) NO corre en el worktree del issue', () => {
  // validacion precede a dev: el worktree del issue todavía no existe.
  assert.strictEqual(phaseUsesExistingWorktree('validacion'), false);
  assert.strictEqual(phaseNeedsWorktree('validacion'), false);
  assert.strictEqual(phaseRunsInIssueWorktree('validacion'), false);
});

test('phaseRunsInIssueWorktree cubre dev + todas las fases post-dev', () => {
  // Toda fase entre dev (inclusive) y entrega (inclusive) dispone del worktree.
  for (const fase of ['dev', 'build', 'verificacion', 'linteo', 'aprobacion', 'entrega']) {
    assert.strictEqual(phaseRunsInIssueWorktree(fase), true, `${fase} corre en el worktree del issue`);
  }
  assert.strictEqual(phaseRunsInIssueWorktree('validacion'), false);
});

test('no hay solapamiento: ninguna fase crea y reutiliza a la vez', () => {
  assert.strictEqual(EXISTING_WORKTREE_PHASES.includes('dev'), false);
});

test('fases desconocidas corren en ROOT (no en el worktree del issue)', () => {
  for (const fase of ['', 'analisis', 'criterios', 'sizing', 'desconocida']) {
    assert.strictEqual(phaseRunsInIssueWorktree(fase), false, `${fase} debe caer a ROOT`);
  }
});
