// .pipeline/lib/__tests__/convergence-detector.test.js
// =============================================================================
// Tests de lib/convergence-detector.js — issue #4160.
//
// Cubre el gate de auto-promoción por convergencia, con foco en los invariantes
// de seguridad (RIESGO-1: security nunca auto-promueve; RIESGO-3: issue numérico;
// RIESGO-5: hash estable bajo whitespace; fail-closed en todos los casos).
// =============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  computeDiffHash,
  isConvergent,
  isEligibleForAutoPromote,
  DEFAULT_EXCLUDE_SKILLS,
} = require('../convergence-detector');

// --- Fake execSync: simula `git worktree list` + `git diff` deterministas. ---
function makeFakeExecSync(diffOutput, { worktreeFound = true } = {}) {
  return function fakeExecSync(cmd) {
    if (cmd.includes('git worktree list')) {
      return worktreeFound
        ? 'worktree C:/Workspaces/Intrale/platform.agent-4160-foo\nHEAD abc\n'
        : 'worktree C:/Workspaces/Intrale/platform\nHEAD abc\n';
    }
    if (cmd.includes('git diff')) {
      return diffOutput;
    }
    throw new Error('comando inesperado: ' + cmd);
  };
}

// ============================ computeDiffHash ================================

test('computeDiffHash produce el mismo hash bajo cambios whitespace-only (RIESGO-5)', () => {
  // Como usamos --ignore-all-space en el comando real, el fake devuelve el
  // output ya normalizado por git. Verificamos que mismo contenido → mismo hash.
  const a = computeDiffHash('4160', { execSyncImpl: makeFakeExecSync('diff --git a/x b/x\n+linea\n') });
  const b = computeDiffHash('4160', { execSyncImpl: makeFakeExecSync('diff --git a/x b/x\n+linea\n') });
  assert.equal(a.known, true);
  assert.equal(a.hash, b.hash);
  assert.match(a.hash, /^[0-9a-f]{64}$/);
});

test('computeDiffHash distingue diffs de contenido distinto', () => {
  const a = computeDiffHash('4160', { execSyncImpl: makeFakeExecSync('+linea A\n') });
  const b = computeDiffHash('4160', { execSyncImpl: makeFakeExecSync('+linea B\n') });
  assert.notEqual(a.hash, b.hash);
});

test('computeDiffHash rechaza issue no numérico (RIESGO-3)', () => {
  assert.throws(
    () => computeDiffHash('4160; rm -rf /', { execSyncImpl: makeFakeExecSync('') }),
    /numérico/,
  );
  assert.throws(() => computeDiffHash('abc', { execSyncImpl: makeFakeExecSync('') }), /numérico/);
});

test('computeDiffHash acepta issue numérico como number', () => {
  const r = computeDiffHash(4160, { execSyncImpl: makeFakeExecSync('+x\n') });
  assert.equal(r.known, true);
});

test('computeDiffHash fail-closed si no resuelve worktree', () => {
  const r = computeDiffHash('4160', { execSyncImpl: makeFakeExecSync('', { worktreeFound: false }) });
  assert.deepEqual(r, { hash: null, known: false });
});

test('computeDiffHash fail-closed si execSync lanza', () => {
  const r = computeDiffHash('4160', {
    execSyncImpl: () => { throw new Error('git no disponible'); },
  });
  assert.deepEqual(r, { hash: null, known: false });
});

// ============================== isConvergent =================================

test('isConvergent true sólo con los 4 factores presentes', () => {
  assert.equal(isConvergent({
    prevHash: 'h1', currentHash: 'h1', hasNewObservation: false, buildGreen: true,
  }), true);
});

test('isConvergent false si los hashes difieren', () => {
  assert.equal(isConvergent({
    prevHash: 'h1', currentHash: 'h2', hasNewObservation: false, buildGreen: true,
  }), false);
});

test('isConvergent false si hay observación nueva', () => {
  assert.equal(isConvergent({
    prevHash: 'h1', currentHash: 'h1', hasNewObservation: true, buildGreen: true,
  }), false);
});

test('isConvergent false si build no está verde (fail-closed)', () => {
  assert.equal(isConvergent({
    prevHash: 'h1', currentHash: 'h1', hasNewObservation: false, buildGreen: false,
  }), false);
  // buildGreen distinto de boolean true tampoco vale.
  assert.equal(isConvergent({
    prevHash: 'h1', currentHash: 'h1', hasNewObservation: false, buildGreen: 'true',
  }), false);
});

test('isConvergent false si algún hash es null (fail-closed)', () => {
  assert.equal(isConvergent({
    prevHash: null, currentHash: 'h1', hasNewObservation: false, buildGreen: true,
  }), false);
  assert.equal(isConvergent({
    prevHash: 'h1', currentHash: null, hasNewObservation: false, buildGreen: true,
  }), false);
});

// ======================= isEligibleForAutoPromote ===========================

test('isEligibleForAutoPromote false si algún rechazo viene de security (RIESGO-1)', () => {
  const r = isEligibleForAutoPromote({
    rechazos: [
      { skill: 'tester', accionable: false },
      { skill: 'security', accionable: false },
    ],
  });
  assert.equal(r.eligible, false);
  assert.match(r.razon, /security/);
});

test('isEligibleForAutoPromote false si algún rechazo es accionable', () => {
  const r = isEligibleForAutoPromote({
    rechazos: [{ skill: 'tester', accionable: true }],
  });
  assert.equal(r.eligible, false);
  assert.match(r.razon, /accionable/);
});

test('isEligibleForAutoPromote true si todos son ruido y ninguno es security', () => {
  const r = isEligibleForAutoPromote({
    rechazos: [
      { skill: 'tester', accionable: false },
      { skill: 'qa', accionable: false },
    ],
  });
  assert.equal(r.eligible, true);
});

test('isEligibleForAutoPromote false sin rechazos (fail-closed)', () => {
  assert.equal(isEligibleForAutoPromote({ rechazos: [] }).eligible, false);
  assert.equal(isEligibleForAutoPromote({}).eligible, false);
});

test('isEligibleForAutoPromote excluye security por default aunque config esté vacía', () => {
  assert.ok(DEFAULT_EXCLUDE_SKILLS.includes('security'));
  const r = isEligibleForAutoPromote({
    rechazos: [{ skill: 'SECURITY', accionable: false }],
    excludeSkills: [],
  });
  assert.equal(r.eligible, false);
});

test('isEligibleForAutoPromote respeta excludeSkills custom', () => {
  const r = isEligibleForAutoPromote({
    rechazos: [{ skill: 'qa', accionable: false }],
    excludeSkills: ['qa'],
  });
  assert.equal(r.eligible, false);
});

test('isEligibleForAutoPromote tolera entradas null/sin skill (defensivo)', () => {
  const r = isEligibleForAutoPromote({
    rechazos: [null, { accionable: false }, { skill: 'tester', accionable: false }],
  });
  // null y objeto sin skill se tratan como skill desconocido no-excluido y no-accionable.
  assert.equal(r.eligible, true);
});

// =========================== decideAutoPromote ==============================

const { decideAutoPromote } = require('../convergence-detector');

test('decideAutoPromote no promueve si no es elegible (corta antes de convergencia)', () => {
  const r = decideAutoPromote({
    rechazos: [{ skill: 'security', accionable: false, motivo: 'x' }],
    prevMotivos: ['x'],
    diffHashPrevio: 'h1',
    currentHash: 'h1',
    buildGreen: true,
  });
  assert.equal(r.promote, false);
  assert.equal(r.hasNewObservation, null);
  assert.match(r.razon, /security/);
});

test('decideAutoPromote promueve con elegible + convergente', () => {
  const r = decideAutoPromote({
    rechazos: [{ skill: 'tester', accionable: false, motivo: 'ruido' }],
    prevMotivos: ['ruido'],
    diffHashPrevio: 'h1',
    currentHash: 'h1',
    buildGreen: true,
  });
  assert.equal(r.promote, true);
  assert.equal(r.hasNewObservation, false);
});

test('decideAutoPromote detecta observación nueva → no promueve', () => {
  const r = decideAutoPromote({
    rechazos: [{ skill: 'tester', accionable: false, motivo: 'motivo nuevo distinto' }],
    prevMotivos: ['otro motivo viejo'],
    diffHashPrevio: 'h1',
    currentHash: 'h1',
    buildGreen: true,
  });
  assert.equal(r.promote, false);
  assert.equal(r.hasNewObservation, true);
});

test('decideAutoPromote con args vacíos no rompe (fail-closed)', () => {
  const r = decideAutoPromote();
  assert.equal(r.promote, false);
});
