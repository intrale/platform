const { test } = require('node:test');
const assert = require('node:assert/strict');

const { classifyRoutingMismatch } = require('../routing-classifier');

// Motivo real extraído del rechazo de #2334 por backend-dev (2026-04-20).
const MOTIVO_2334 = `[backend-dev] Issue fuera de alcance de backend-dev. El alcance 100% declarado en el issue es Node.js del pipeline (.pipeline/servicio-telegram.js, .pipeline/servicio-drive.js, .pipeline/servicio-github.js, stream-filter sobre .pipeline/logs/, tests con node --test), que es dominio exclusivo del rol pipeline-dev segun .pipeline/roles/pipeline-dev.md. backend-dev solo implementa Ktor/Kotlin (./gradlew :backend:build, :users:build) y el issue no toca ningun archivo .kt. Accion correcta: agregar label "area:pipeline" al issue #2334 para que el Pulpo lo rutee a pipeline-dev.`;

test('detecta "fuera de alcance" en motivo real de #2334', () => {
  const r = classifyRoutingMismatch(MOTIVO_2334);
  assert.equal(r.isRouting, true);
  assert.equal(r.skillSugerido, 'pipeline-dev');
  assert.equal(r.labelSugerido, 'area:pipeline');
});

test('detecta "out of scope" en inglés', () => {
  const r = classifyRoutingMismatch('[android-dev] Out of scope — should route to backend-dev.');
  assert.equal(r.isRouting, true);
  assert.equal(r.skillSugerido, 'backend-dev');
});

test('detecta "corresponde a" con skill explícito', () => {
  const r = classifyRoutingMismatch('Este issue corresponde a web-dev, no a backend-dev.');
  assert.equal(r.isRouting, true);
  assert.equal(r.skillSugerido, 'web-dev');
});

test('detecta "dominio exclusivo de X"', () => {
  const r = classifyRoutingMismatch('Es dominio exclusivo del rol pipeline-dev según .pipeline/roles/.');
  assert.equal(r.isRouting, true);
  assert.equal(r.skillSugerido, 'pipeline-dev');
});

test('detecta sugerencia de label "agregar area:X"', () => {
  const r = classifyRoutingMismatch('Agregar label "area:pipeline" al issue para que el Pulpo lo rutee correctamente.');
  assert.equal(r.isRouting, true);
  assert.equal(r.labelSugerido, 'area:pipeline');
});

test('NO es routing: motivo de infra (ECONNREFUSED)', () => {
  const r = classifyRoutingMismatch('[backend-dev] ECONNREFUSED contra api.github.com — no puedo leer el issue.');
  assert.equal(r.isRouting, false);
  assert.equal(r.skillSugerido, null);
  assert.equal(r.labelSugerido, null);
});

test('NO es routing: motivo de defecto de código real', () => {
  const r = classifyRoutingMismatch('[tester] Test unitario fallido: expected true, got false en AuthServiceTest.kt:42.');
  assert.equal(r.isRouting, false);
});

test('NO es routing: motivo de QA con screenshot faltante', () => {
  const r = classifyRoutingMismatch('[ux] No se encontró video de QA en qa-2371.mp4 — no puedo evaluar la experiencia.');
  assert.equal(r.isRouting, false);
});

test('robusto a input vacío o no-string', () => {
  assert.equal(classifyRoutingMismatch('').isRouting, false);
  assert.equal(classifyRoutingMismatch(null).isRouting, false);
  assert.equal(classifyRoutingMismatch(undefined).isRouting, false);
  assert.equal(classifyRoutingMismatch(123).isRouting, false);
});

test('isRouting=true pero sin skill extraíble (routing genérico)', () => {
  const r = classifyRoutingMismatch('Fuera de alcance — no corresponde a este agente.');
  assert.equal(r.isRouting, true);
  assert.equal(r.skillSugerido, null);
});

test('skill extraído solo si es skill conocido (no falso positivo)', () => {
  const r = classifyRoutingMismatch('Corresponde a un-skill-inventado-xyz.');
  assert.equal(r.isRouting, true);
  assert.equal(r.skillSugerido, null, 'no debería extraer skills desconocidos');
});

test('label extraído solo si es área conocida', () => {
  const r = classifyRoutingMismatch('Fuera de alcance — agregar area:inventada.');
  assert.equal(r.isRouting, true);
  assert.equal(r.labelSugerido, null);
});
