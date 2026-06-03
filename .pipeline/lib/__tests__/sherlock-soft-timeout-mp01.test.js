// =============================================================================
// sherlock-soft-timeout-mp01.test.js — MP-01/MP-02 (#3803)
//
// El orquestador del Commander corre el bloque Sherlock contra un reloj de
// release (Promise.race). El bug raíz del "no pude verificar" recurrente era
// que el reloj (antes 120s, MENOR que el presupuesto del cliente de 180s+
// reelaboración) podía ganar la carrera y disparar un F-6 espurio aunque
// Sherlock ya hubiese resuelto con OK.
//
// `shouldEmitSoftTimeoutDisclaimer(softTimedOut, resolved)` centraliza la
// decisión: el disclaimer SOLO se emite cuando el reloj ganó SIN verdict.
// Si Sherlock resolvió, se honra su resultado real (nunca se pisa un OK).
// =============================================================================
'use strict';

process.env.PULPO_NO_AUTOSTART = '1';

const test = require('node:test');
const assert = require('node:assert/strict');

const pulpo = require('../../pulpo.js');
const { shouldEmitSoftTimeoutDisclaimer } = pulpo;

test('emite F-6 cuando el soft-timeout gana SIN verdict (cuelgue genuino)', () => {
  assert.equal(shouldEmitSoftTimeoutDisclaimer(true, false), true);
});

test('NO emite F-6 espurio cuando el reloj gana pero Sherlock ya resolvió', () => {
  // Causa raíz del "no pude verificar": el verdict real manda, no el reloj.
  assert.equal(shouldEmitSoftTimeoutDisclaimer(true, true), false);
});

test('NO emite F-6 cuando no hubo soft-timeout (flujo normal con verdict)', () => {
  assert.equal(shouldEmitSoftTimeoutDisclaimer(false, true), false);
});

test('NO emite F-6 cuando no hubo soft-timeout ni verdict (sin carrera)', () => {
  assert.equal(shouldEmitSoftTimeoutDisclaimer(false, false), false);
});

test('coerce de valores falsy/undefined → trata como sin timeout', () => {
  assert.equal(shouldEmitSoftTimeoutDisclaimer(undefined, undefined), false);
  assert.equal(shouldEmitSoftTimeoutDisclaimer(null, false), false);
});
