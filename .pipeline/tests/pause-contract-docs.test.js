// .pipeline/tests/pause-contract-docs.test.js
// =============================================================================
// Tests de contrato del documento `docs/pipeline-v3-pause-rebote.md`
// — issue #2374, Parte 2.
//
// El documento es el contrato escrito de qué hace `.paused` y dónde re-encola
// un rebote según tipo. Estos tests aseguran que:
//   1. El doc existe.
//   2. Cubre las superficies clave (intake, lanzamiento, barrido, huérfanos,
//      agentes en vuelo, exit handler).
//   3. Cubre la diferencia infra vs código.
//   4. Apunta a los tests que congelan cada parte del contrato.
//
// Si alguien borra o vacía el doc, este test falla y obliga a actualizar el
// contrato en otro lado antes de poder cerrar el cambio.
// =============================================================================

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const DOC_PATH = path.join(ROOT, 'docs', 'pipeline-v3-pause-rebote.md');

function readDoc() {
  return fs.readFileSync(DOC_PATH, 'utf8');
}

test('doc del contrato pause+rebote existe', () => {
  assert.ok(fs.existsSync(DOC_PATH), `falta archivo: ${DOC_PATH}`);
  const stat = fs.statSync(DOC_PATH);
  assert.ok(stat.size > 1000, 'doc del contrato es sospechosamente corto');
});

test('doc cubre superficies del .paused (intake, lanzamiento, barrido, huérfanos)', () => {
  const doc = readDoc();
  for (const surface of ['Intake', 'Lanzamiento', 'Barrido', 'brazoHuerfanos']) {
    assert.ok(
      new RegExp(`\\b${surface}`, 'i').test(doc),
      `doc no menciona la superficie "${surface}" del contrato de pausa`
    );
  }
});

test('doc aclara qué pasa con agentes en vuelo y exit handler', () => {
  const doc = readDoc();
  assert.ok(/[Aa]gentes en vuelo/.test(doc), 'doc no aclara comportamiento de agentes en vuelo');
  assert.ok(/[Ee]xit handler/.test(doc) || /child\.on\('exit'/.test(doc),
    'doc no aclara que el exit handler corre durante la pausa');
});

test('doc declara la precedencia paused > partial_pause > running', () => {
  const doc = readDoc();
  assert.ok(/paused > partial_pause > running/.test(doc),
    'doc no documenta la precedencia explícita del estado');
});

test('doc cubre clasificación infra vs código (Parte 3 #2374)', () => {
  const doc = readDoc();
  assert.ok(/\binfra\b/i.test(doc), 'doc no menciona la categoría infra');
  assert.ok(/\bc[oó]digo\b/i.test(doc) || /\bcode\b/i.test(doc), 'doc no menciona la categoría código/code');
  assert.ok(/faseRechazo/.test(doc), 'doc no menciona la variable faseRechazo (destino código)');
  assert.ok(/MISMA fase/i.test(doc) || /misma fase/i.test(doc),
    'doc no menciona "misma fase" como destino para rebote infra');
});

test('doc apunta a los tests que congelan el contrato', () => {
  const doc = readDoc();
  assert.ok(/rebote-destino\.test\.js/.test(doc),
    'doc no referencia el test de destino de rebote');
  assert.ok(/partial-pause\.test\.js/.test(doc),
    'doc no referencia el test de la tabla de pausa');
});

test('doc cita el incidente #2159 (motivación histórica)', () => {
  const doc = readDoc();
  assert.ok(/#?2159/.test(doc),
    'doc no cita #2159 (delivery muerto por timeout de CI, origen de la historia)');
});

test('doc cita el circuit breaker separado de infra (MAX_REBOTES_INFRA, infra_escalate_threshold)', () => {
  const doc = readDoc();
  assert.ok(/MAX_REBOTES_INFRA/.test(doc),
    'doc no cita MAX_REBOTES_INFRA (cap duro independiente del de código)');
  assert.ok(/infra_escalate_threshold/.test(doc),
    'doc no cita infra_escalate_threshold (escala blanda a needs-human)');
});
