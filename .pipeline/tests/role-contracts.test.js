// Tests de contrato de los roles del pipeline.
// Asegura que PO y UX (y otros roles que valen como gates de aprobacion)
// se mantengan simetricos en su clasificacion de scope (PASO 0.A) — sino
// vuelve la asimetria que rompio el ciclo de aprobacion del issue #2523.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const ROLES_DIR = path.join(ROOT, '.pipeline', 'roles');

function readRole(name) {
  return fs.readFileSync(path.join(ROLES_DIR, name), 'utf8');
}

test('rol UX expone PASO 0.A para clasificar scope antes de exigir video', () => {
  const ux = readRole('ux.md');
  assert.ok(/PASO 0\.A/.test(ux), 'falta seccion "PASO 0.A" en ux.md');
  assert.ok(
    /Clasificar scope/i.test(ux),
    'falta titulo "Clasificar scope" en PASO 0.A de ux.md'
  );
});

test('rol UX reconoce qa:skipped como atajo legitimo (PASO 0.A)', () => {
  const ux = readRole('ux.md');
  assert.ok(/qa:skipped/.test(ux), 'rol UX no menciona qa:skipped');
});

test('rol UX reconoce area:infra y area:pipeline sin app:* como scope sin video', () => {
  const ux = readRole('ux.md');
  assert.ok(/area:infra/.test(ux), 'rol UX no contempla area:infra');
  assert.ok(/area:pipeline/.test(ux), 'rol UX no contempla area:pipeline');
  assert.ok(
    /app:\*/.test(ux),
    'rol UX no menciona la condicion "sin app:*"'
  );
});

test('rol UX ofrece path de evaluacion sin video (PASO 2-bis)', () => {
  const ux = readRole('ux.md');
  assert.ok(/PASO 2-bis/.test(ux), 'falta PASO 2-bis en rol UX');
  assert.ok(
    /assets.+mockups|mockups.+assets/i.test(ux),
    'PASO 2-bis no describe evaluacion via assets+mockups'
  );
});

test('rol PO mantiene PASO 0.A (espejo del rol UX)', () => {
  const po = readRole('po.md');
  assert.ok(/PASO 0\.A/.test(po), 'rol PO perdio PASO 0.A — asimetria peligrosa');
  assert.ok(/qa:skipped/.test(po), 'rol PO no menciona qa:skipped');
});

test('simetria UX <-> PO: ambos roles aceptan los mismos atajos de scope', () => {
  const ux = readRole('ux.md');
  const po = readRole('po.md');

  // Las dos condiciones criticas que NO pueden divergir:
  const ATAJOS = [
    /qa:skipped/,
    /area:infra/,
    // "sin app:*" o "NO tiene ningun app:*" (con o sin acentos / backticks)
    /(?:sin|no tiene)[^.\n]*app:\*/i,
  ];

  for (const re of ATAJOS) {
    assert.ok(re.test(ux), `rol UX perdio el atajo ${re}`);
    assert.ok(re.test(po), `rol PO perdio el atajo ${re}`);
  }
});

test('rol UX prohibe contradecir al PO en aprobacion (regla de simetria)', () => {
  const ux = readRole('ux.md');
  // Esta regla nueva evita que UX rebote por video cuando PO ya aplico qa:skipped
  // siguiendo la regla de CLAUDE.md.
  assert.ok(
    /simetr[ií]a con el rol PO|simetr[ií]a con PO|respetar.*simetr[ií]a.*PO/i.test(ux),
    'rol UX no tiene la regla de simetria con PO — riesgo de bloqueo cruzado'
  );
});
