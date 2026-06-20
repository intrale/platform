// =============================================================================
// Tests del disclaimer F-7 — envío optimista (#4105 · EP2-H5b · CA-11)
//
// F-7 es el estado "pendiente" del envío optimista: se libera la respuesta YA
// con ⏳ y la verificación sigue en background. NO reusa F-6 (caso terminal).
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const sv = require('../sherlock-verifier');

test('F-7: constante exportada con el texto exacto del CA-11 (⏳)', () => {
  assert.equal(typeof sv.DISCLAIMER_F7_PENDING_VERIFICATION, 'string');
  assert.ok(sv.DISCLAIMER_F7_PENDING_VERIFICATION.includes('⏳'));
  assert.ok(sv.DISCLAIMER_F7_PENDING_VERIFICATION.includes('Te respondo ya así no esperás'));
  assert.ok(sv.DISCLAIMER_F7_PENDING_VERIFICATION.includes('si algo no cuadra, te lo corrijo acá mismo'));
});

test('F-7: applyDisclaimer(PENDING_VERIFICATION) anexa el aviso ⏳', () => {
  const out = sv.applyDisclaimer('Respuesta', sv.DISCLAIMER_TYPES.PENDING_VERIFICATION);
  assert.ok(out.startsWith('Respuesta'));
  assert.ok(out.includes('⏳'));
});

test('F-7: NO reusa F-6 (textos distintos)', () => {
  assert.notEqual(sv.DISCLAIMER_F7_PENDING_VERIFICATION, sv.DISCLAIMER_F6_VERIFICATION_FAILED);
});

test('F-7: PENDING_VERIFICATION es un tipo de disclaimer registrado', () => {
  assert.equal(sv.DISCLAIMER_TYPES.PENDING_VERIFICATION, 'pending-verification');
});

test('F-5 sigue siendo el de edición de texto; voz tiene follow-up propio', () => {
  // texto reusa F-5
  assert.ok(sv.DISCLAIMER_F5_PERSISTENT_INCONSISTENCY.includes('Ajusté la respuesta con el verificador'));
  // voz usa el follow-up nuevo
  assert.equal(typeof sv.CORRECTION_FOLLOWUP_VOICE, 'string');
  assert.ok(sv.CORRECTION_FOLLOWUP_VOICE.includes('Revisé lo que te respondí recién'));
});
