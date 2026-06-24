// .pipeline/lib/__tests__/observation-classifier.test.js
// =============================================================================
// Tests de lib/observation-classifier.js — issue #4160.
//
// Verifica la clasificación accionable vs ruido y el invariante RIESGO-2
// (security con claim empírico → siempre accionable).
// =============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { classifyObservation, normalizeMotivo } = require('../observation-classifier');

// ----------------------------- Accionable ----------------------------------

test('observación con archivo:línea → accionable', () => {
  const r = classifyObservation({
    motivo: 'El método falla en pulpo.js:4120 cuando issue es null',
    skill: 'tester',
  });
  assert.equal(r.accionable, true);
  assert.match(r.razon, /archivo:línea/);
});

test('observación con comando de verificación → accionable', () => {
  const r = classifyObservation({
    motivo: 'Corré ./gradlew :users:test y verás que falla',
    skill: 'tester',
  });
  assert.equal(r.accionable, true);
});

test('observación que cita un CA fallido → accionable', () => {
  const r = classifyObservation({
    motivo: 'No cumple CA-3: el dev no recibe el motivo previo',
    skill: 'qa',
  });
  assert.equal(r.accionable, true);
});

// ------------------------------- Ruido --------------------------------------

test('observación estilística sin defecto → ruido', () => {
  const r = classifyObservation({
    motivo: 'El código podría ser más prolijo y elegante en general',
    skill: 'tester',
  });
  assert.equal(r.accionable, false);
});

test('motivo vacío → ruido', () => {
  assert.equal(classifyObservation({ motivo: '', skill: 'qa' }).accionable, false);
  assert.equal(classifyObservation({ motivo: '   ', skill: 'qa' }).accionable, false);
});

test('repetición textual de observación previa ya resuelta → ruido', () => {
  const prev = ['El código podría ser más prolijo y elegante en general'];
  const r = classifyObservation({
    motivo: 'El código podría ser más prolijo y ELEGANTE en general',
    skill: 'tester',
    prevMotivos: prev,
  });
  assert.equal(r.accionable, false);
  assert.match(r.razon, /repetici/i);
});

// ------------------------- RIESGO-2: security --------------------------------

test('security con claim empírico (CVE) → siempre accionable', () => {
  const r = classifyObservation({
    motivo: 'Dependencia vulnerable a CVE-2024-1234',
    skill: 'security',
  });
  assert.equal(r.accionable, true);
  assert.match(r.razon, /RIESGO-2/);
});

test('security con secret hardcodeado → siempre accionable', () => {
  const r = classifyObservation({
    motivo: 'Hay un token hardcodeado en el código',
    skill: 'security',
  });
  assert.equal(r.accionable, true);
});

test('security con claim empírico NO se descarta por repetición', () => {
  const r = classifyObservation({
    motivo: 'Hay un secret hardcodeado',
    skill: 'security',
    prevMotivos: ['Hay un secret hardcodeado'],
  });
  // Aunque se repita, un claim de seguridad sigue siendo accionable.
  assert.equal(r.accionable, true);
});

test('security sin claim empírico ni anclaje → ruido (no toda mención de security es claim)', () => {
  const r = classifyObservation({
    motivo: 'Sería bueno revisar la seguridad general algún día',
    skill: 'security',
  });
  assert.equal(r.accionable, false);
});

// ------------------------------ helpers -------------------------------------

test('normalizeMotivo colapsa whitespace y baja a minúsculas', () => {
  assert.equal(normalizeMotivo('  Hola   MUNDO\n\t'), 'hola mundo');
  assert.equal(normalizeMotivo(null), '');
});
