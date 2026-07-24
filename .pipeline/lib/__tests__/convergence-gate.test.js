// .pipeline/lib/__tests__/convergence-gate.test.js
// =============================================================================
// Test funcional del gate de auto-promoción por convergencia (#4160, CA-4).
//
// Reproduce la composición exacta que hace pulpo.js: clasifica los rechazos con
// observation-classifier, computa el diff-hash con execSync fake, y decide con
// convergence.decideAutoPromote. Cubre los dos escenarios autoritativos:
//   1. Dos rebotes con mismo diff + build verde + sin observación nueva (ruido)
//      → AUTO-PROMUEVE.
//   2. Rebote de `security` con claim empírico → NO auto-promueve (sigue el
//      circuit breaker) — invariante RIESGO-1.
// =============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const convergence = require('../convergence-detector');
const { classifyObservation } = require('../observation-classifier');

// Fake execSync determinista para computeDiffHash.
function makeFakeExecSync(diffOutput) {
  return (cmd) => {
    if (cmd.includes('git worktree list')) {
      return 'worktree C:/Workspaces/Intrale/platform.agent-4154-foo\nHEAD x\n';
    }
    if (cmd.includes('git diff')) return diffOutput;
    throw new Error('cmd inesperado');
  };
}

// Replica la composición del gate de pulpo.js (clasificar → hash → decidir).
function evaluarGate({ rechazos, prevMotivos, diffHashPrevio, buildGreen, execSyncImpl }) {
  const clasificados = rechazos.map(r => {
    const { accionable } = classifyObservation({ motivo: r.motivo, skill: r.skill, prevMotivos });
    return { skill: r.skill, accionable, motivo: r.motivo };
  });
  const currentDiff = convergence.computeDiffHash('4154', { execSyncImpl });
  return convergence.decideAutoPromote({
    rechazos: clasificados,
    prevMotivos,
    diffHashPrevio,
    currentHash: currentDiff.hash,
    buildGreen,
  });
}

test('CA-4: dos rebotes con mismo diff + build verde + ruido → auto-promueve', () => {
  const diff = 'diff --git a/x b/x\n+linea\n';
  // Primer ciclo: computamos el hash que se habría persistido como diff_hash_previo.
  const hashPrevio = convergence.computeDiffHash('4154', { execSyncImpl: makeFakeExecSync(diff) }).hash;

  // Segundo ciclo: el dev NO cambió el diff (mismo output), observación es ruido
  // y ya apareció en el ciclo previo.
  const motivoRuido = 'El código podría ser más prolijo en general';
  const decision = evaluarGate({
    rechazos: [{ skill: 'tester', motivo: motivoRuido }],
    prevMotivos: [motivoRuido],
    diffHashPrevio: hashPrevio,
    buildGreen: true,
    execSyncImpl: makeFakeExecSync(diff),
  });
  assert.equal(decision.promote, true);
  assert.match(decision.razon, /convergencia/);
});

test('CA-4 / RIESGO-1: rebote de security con claim → NO auto-promueve', () => {
  const diff = 'diff --git a/x b/x\n+linea\n';
  const hashPrevio = convergence.computeDiffHash('4154', { execSyncImpl: makeFakeExecSync(diff) }).hash;

  const motivoSec = 'Hay un token hardcodeado en config.js';
  const decision = evaluarGate({
    rechazos: [{ skill: 'security', motivo: motivoSec }],
    prevMotivos: [motivoSec],
    diffHashPrevio: hashPrevio,
    buildGreen: true,
    execSyncImpl: makeFakeExecSync(diff),
  });
  assert.equal(decision.promote, false);
  assert.match(decision.razon, /security/);
});

test('no auto-promueve si el diff cambió entre rebotes (dev sí corrigió)', () => {
  const hashPrevio = convergence.computeDiffHash('4154', {
    execSyncImpl: makeFakeExecSync('+version vieja\n'),
  }).hash;
  const motivoRuido = 'Comentario estilístico sin defecto concreto';
  const decision = evaluarGate({
    rechazos: [{ skill: 'qa', motivo: motivoRuido }],
    prevMotivos: [motivoRuido],
    diffHashPrevio: hashPrevio,
    buildGreen: true,
    execSyncImpl: makeFakeExecSync('+version nueva\n'), // diff distinto
  });
  assert.equal(decision.promote, false);
});

test('no auto-promueve si aparece una observación accionable nueva', () => {
  const diff = '+x\n';
  const hashPrevio = convergence.computeDiffHash('4154', { execSyncImpl: makeFakeExecSync(diff) }).hash;
  const decision = evaluarGate({
    rechazos: [{ skill: 'tester', motivo: 'Falla en pulpo.js:99 con NPE' }], // accionable
    prevMotivos: ['otra cosa vieja'],
    diffHashPrevio: hashPrevio,
    buildGreen: true,
    execSyncImpl: makeFakeExecSync(diff),
  });
  assert.equal(decision.promote, false);
  assert.match(decision.razon, /accionable/);
});

test('no auto-promueve si el build no está verde (fail-closed)', () => {
  const diff = '+x\n';
  const hashPrevio = convergence.computeDiffHash('4154', { execSyncImpl: makeFakeExecSync(diff) }).hash;
  const motivoRuido = 'Observación estilística general';
  const decision = evaluarGate({
    rechazos: [{ skill: 'tester', motivo: motivoRuido }],
    prevMotivos: [motivoRuido],
    diffHashPrevio: hashPrevio,
    buildGreen: false,
    execSyncImpl: makeFakeExecSync(diff),
  });
  assert.equal(decision.promote, false);
});

test('no auto-promueve en el primer rebote (sin diff_hash_previo)', () => {
  const diff = '+x\n';
  const motivoRuido = 'Observación estilística general';
  const decision = evaluarGate({
    rechazos: [{ skill: 'tester', motivo: motivoRuido }],
    prevMotivos: [],
    diffHashPrevio: null, // primer rebote, no hay con qué comparar
    buildGreen: true,
    execSyncImpl: makeFakeExecSync(diff),
  });
  assert.equal(decision.promote, false);
});
