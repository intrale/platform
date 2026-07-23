// .pipeline/lib/__tests__/restart-orphan-annotator.test.js
// =============================================================================
// Tests del helper `restart-orphan-annotator.js` — issue #2374 Parte 1.
//
// Asegura que cuando un restart interrumpe agentes en vuelo:
//   - Sus YAMLs en `trabajando/` se mueven a `pendiente/`.
//   - El contenido del YAML SE PRESERVA íntegro (no perdemos `rebote_numero`,
//     `motivo_rechazo`, etc).
//   - Se anota `restart_interrupted: true` y `restart_at: <ISO>` para que el
//     agente re-lanzado sepa que fue un corte por restart.
//   - Es idempotente: dos restarts consecutivos sin que el agente arranque no
//     duplican las claves.
//   - Defensive: archivos no-YAML caen al rename atómico clásico (preserva
//     comportamiento histórico).
// =============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  annotateAndMoveOrphans,
  annotateContent,
  AGENTE_FILE_REGEX,
} = require('../restart-orphan-annotator');

function freshTmpDir(prefix = 'v3-restart-annot-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function setupPipelineRoot(tmpRoot, pipeline, fase, files) {
  const trabajando = path.join(tmpRoot, pipeline, fase, 'trabajando');
  const pendiente = path.join(tmpRoot, pipeline, fase, 'pendiente');
  fs.mkdirSync(trabajando, { recursive: true });
  fs.mkdirSync(pendiente, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(trabajando, name), content);
  }
  return { trabajando, pendiente };
}

// =============================================================================
// CONTENIDO ANOTADO
// =============================================================================

test('annotateContent agrega las claves al final de un YAML', () => {
  const raw = 'issue: 2159\nfase: entrega\npipeline: desarrollo';
  const out = annotateContent(raw, '2026-05-15T00:00:00Z');
  assert.match(out, /restart_interrupted: true/);
  assert.match(out, /restart_at: '2026-05-15T00:00:00Z'/);
  // El contenido original sigue presente íntegro
  assert.match(out, /issue: 2159/);
  assert.match(out, /fase: entrega/);
  assert.match(out, /pipeline: desarrollo/);
});

test('annotateContent es idempotente (no duplica si ya tiene la marca)', () => {
  const raw = "issue: 1\nrestart_interrupted: true\nrestart_at: '2026-01-01T00:00:00Z'\n";
  const out = annotateContent(raw, '2026-05-15T00:00:00Z');
  assert.equal(out, raw, 'segundo restart no debe agregar otra marca');
  const occurrences = (out.match(/restart_interrupted:/g) || []).length;
  assert.equal(occurrences, 1, 'restart_interrupted debe aparecer una sola vez');
});

test('annotateContent maneja YAML con trailing newlines sin duplicarlas', () => {
  const raw = 'issue: 2159\n\n\n';
  const out = annotateContent(raw, '2026-05-15T00:00:00Z');
  // No queremos `\n\n\nrestart_...` — recortamos el whitespace final.
  assert.match(out, /issue: 2159\nrestart_interrupted/);
});

// =============================================================================
// AGENTE_FILE_REGEX — filtro de archivos válidos
// =============================================================================

test('AGENTE_FILE_REGEX acepta nombres canónicos issue.skill', () => {
  assert.ok(AGENTE_FILE_REGEX.test('1915.qa'));
  assert.ok(AGENTE_FILE_REGEX.test('2441.guru'));
  assert.ok(AGENTE_FILE_REGEX.test('2159.delivery'));
  assert.ok(AGENTE_FILE_REGEX.test('5.pipeline-dev'));
});

test('AGENTE_FILE_REGEX rechaza .gitkeep, README y otros no-agentes', () => {
  assert.ok(!AGENTE_FILE_REGEX.test('.gitkeep'));
  assert.ok(!AGENTE_FILE_REGEX.test('README.md'));
  assert.ok(!AGENTE_FILE_REGEX.test('1915'));
  assert.ok(!AGENTE_FILE_REGEX.test('.hidden'));
  assert.ok(!AGENTE_FILE_REGEX.test('a.b.c'));
  assert.ok(!AGENTE_FILE_REGEX.test('1234.QA')); // case-sensitive: skills son lowercase
});

// =============================================================================
// FLUJO COMPLETO — mover + anotar
// =============================================================================

test('mueve archivos de trabajando/ a pendiente/ con marca de restart', () => {
  const root = freshTmpDir();
  setupPipelineRoot(root, 'desarrollo', 'entrega', {
    '2159.delivery': 'issue: 2159\nfase: entrega\npipeline: desarrollo\n',
  });

  const result = annotateAndMoveOrphans({
    pipelineRoot: root,
    pipelinesScan: ['desarrollo'],
    restartAt: '2026-05-15T12:00:00Z',
  });

  assert.equal(result.movedCount, 1);
  const trabajando = path.join(root, 'desarrollo', 'entrega', 'trabajando', '2159.delivery');
  const pendiente = path.join(root, 'desarrollo', 'entrega', 'pendiente', '2159.delivery');
  assert.ok(!fs.existsSync(trabajando), 'archivo origen debe haberse borrado');
  assert.ok(fs.existsSync(pendiente), 'archivo destino debe existir en pendiente');

  const content = fs.readFileSync(pendiente, 'utf8');
  assert.match(content, /issue: 2159/);
  assert.match(content, /restart_interrupted: true/);
  assert.match(content, /restart_at: '2026-05-15T12:00:00Z'/);
});

test('preserva contenido original íntegro (rebote_numero, motivo_rechazo, etc)', () => {
  const root = freshTmpDir();
  const original = [
    'issue: 2159',
    'fase: entrega',
    'pipeline: desarrollo',
    'rebote: true',
    'rebote_numero: 2',
    'rebote_tipo: infra',
    "motivo_rechazo: 'watchdog timeout 90min'",
    'rechazado_en_fase: entrega',
    '',
  ].join('\n');
  setupPipelineRoot(root, 'desarrollo', 'entrega', {
    '2159.delivery': original,
  });

  annotateAndMoveOrphans({
    pipelineRoot: root,
    pipelinesScan: ['desarrollo'],
    restartAt: '2026-05-15T12:00:00Z',
  });

  const content = fs.readFileSync(
    path.join(root, 'desarrollo', 'entrega', 'pendiente', '2159.delivery'),
    'utf8',
  );
  // Cada clave original debe estar presente.
  for (const key of ['rebote: true', 'rebote_numero: 2', 'rebote_tipo: infra', 'rechazado_en_fase: entrega']) {
    assert.ok(content.includes(key), `falta la clave preservada "${key}"`);
  }
});

test('idempotencia: dos restarts consecutivos no duplican la marca', () => {
  const root = freshTmpDir();
  setupPipelineRoot(root, 'desarrollo', 'dev', {
    '42.backend-dev': 'issue: 42\nfase: dev\npipeline: desarrollo\n',
  });

  // Primer restart
  annotateAndMoveOrphans({
    pipelineRoot: root,
    pipelinesScan: ['desarrollo'],
    restartAt: '2026-05-15T10:00:00Z',
  });

  // Simulación: el agente no arrancó todavía, restart segundo lo agarra en pendiente.
  // Para reproducir un escenario válido del helper movemos manualmente al trabajando
  // de nuevo (como si el pulpo hubiera empezado y matado al child sin que el agente
  // llegara a hacer trabajo real).
  const pendientePath = path.join(root, 'desarrollo', 'dev', 'pendiente', '42.backend-dev');
  const trabajandoPath = path.join(root, 'desarrollo', 'dev', 'trabajando', '42.backend-dev');
  fs.renameSync(pendientePath, trabajandoPath);

  // Segundo restart
  annotateAndMoveOrphans({
    pipelineRoot: root,
    pipelinesScan: ['desarrollo'],
    restartAt: '2026-05-15T11:00:00Z',
  });

  const content = fs.readFileSync(pendientePath, 'utf8');
  const occurrences = (content.match(/restart_interrupted:/g) || []).length;
  assert.equal(occurrences, 1, 'restart_interrupted no debe duplicarse en restarts consecutivos');
});

test('archivos no-YAML caen al rename clásico (preserva comportamiento histórico)', () => {
  const root = freshTmpDir();
  setupPipelineRoot(root, 'desarrollo', 'entrega', {
    '2159.delivery': '!@#binary garbage no es yaml!@#',
  });

  const result = annotateAndMoveOrphans({
    pipelineRoot: root,
    pipelinesScan: ['desarrollo'],
    restartAt: '2026-05-15T12:00:00Z',
  });

  assert.equal(result.movedCount, 1);
  const pendiente = path.join(root, 'desarrollo', 'entrega', 'pendiente', '2159.delivery');
  assert.ok(fs.existsSync(pendiente), 'el archivo debe moverse igualmente para no perderse');
  const content = fs.readFileSync(pendiente, 'utf8');
  // No anota porque no parece YAML; el contenido se preserva tal cual.
  assert.equal(content, '!@#binary garbage no es yaml!@#');
});

test('filtra .gitkeep y archivos no-agente', () => {
  const root = freshTmpDir();
  setupPipelineRoot(root, 'desarrollo', 'entrega', {
    '2159.delivery': 'issue: 2159\n',
    '.gitkeep': '',
    'README.md': 'docs',
  });

  const result = annotateAndMoveOrphans({
    pipelineRoot: root,
    pipelinesScan: ['desarrollo'],
    restartAt: '2026-05-15T12:00:00Z',
  });

  assert.equal(result.movedCount, 1, 'sólo el archivo de agente debe contar');
  const trabajando = path.join(root, 'desarrollo', 'entrega', 'trabajando');
  assert.ok(fs.existsSync(path.join(trabajando, '.gitkeep')));
  assert.ok(fs.existsSync(path.join(trabajando, 'README.md')));
});

test('barre múltiples pipelines (desarrollo + definicion) sin colisión', () => {
  const root = freshTmpDir();
  setupPipelineRoot(root, 'desarrollo', 'entrega', {
    '2159.delivery': 'issue: 2159\nfase: entrega\n',
  });
  setupPipelineRoot(root, 'definicion', 'analisis', {
    '3000.guru': 'issue: 3000\nfase: analisis\n',
  });

  const result = annotateAndMoveOrphans({
    pipelineRoot: root,
    pipelinesScan: ['desarrollo', 'definicion'],
    restartAt: '2026-05-15T12:00:00Z',
  });

  assert.equal(result.movedCount, 2);
  assert.ok(fs.existsSync(path.join(root, 'desarrollo', 'entrega', 'pendiente', '2159.delivery')));
  assert.ok(fs.existsSync(path.join(root, 'definicion', 'analisis', 'pendiente', '3000.guru')));
});

test('no-op cuando trabajando/ está vacío', () => {
  const root = freshTmpDir();
  setupPipelineRoot(root, 'desarrollo', 'entrega', {});

  const result = annotateAndMoveOrphans({
    pipelineRoot: root,
    pipelinesScan: ['desarrollo'],
    restartAt: '2026-05-15T12:00:00Z',
  });

  assert.equal(result.movedCount, 0);
});

test('no falla si el pipeline scaneado no existe en disco', () => {
  const root = freshTmpDir();
  // No creamos `definicion/`.
  setupPipelineRoot(root, 'desarrollo', 'entrega', {
    '2159.delivery': 'issue: 2159\n',
  });

  const result = annotateAndMoveOrphans({
    pipelineRoot: root,
    pipelinesScan: ['desarrollo', 'definicion'],
    restartAt: '2026-05-15T12:00:00Z',
  });

  assert.equal(result.movedCount, 1);
});

test('throws si falta pipelineRoot', () => {
  assert.throws(
    () => annotateAndMoveOrphans({}),
    /pipelineRoot/,
  );
});

test('default scan desarrollo+definicion cuando no se especifica pipelinesScan', () => {
  const root = freshTmpDir();
  setupPipelineRoot(root, 'desarrollo', 'entrega', {
    '2159.delivery': 'issue: 2159\n',
  });
  setupPipelineRoot(root, 'definicion', 'analisis', {
    '3000.guru': 'issue: 3000\n',
  });

  const result = annotateAndMoveOrphans({
    pipelineRoot: root,
    restartAt: '2026-05-15T12:00:00Z',
  });

  assert.equal(result.movedCount, 2);
});
