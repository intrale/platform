'use strict';

// =============================================================================
// historico.test.js — Issue #4136 (frontera activo/histórico).
//   node --test .pipeline/test/historico.test.js
//
// Cubre los CA-7 del PO:
//   - moverAHistorico mueve preservando contenido + registro append-only
//   - archivarIssueTerminado NO archiva un issue con archivos en trabajando
//   - archivarIssueTerminado archiva todas las fases de un issue cerrado
//   - leerHistorico rechaza issue no numérico / traversal ../ / fase fuera de allowlist
// =============================================================================

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const historico = require('../lib/historico');

// Config mínima espejo de config.yaml (fases reales).
const CONFIG = {
  pipelines: {
    definicion: { fases: ['analisis', 'criterios', 'sizing'] },
    desarrollo: { fases: ['validacion', 'dev', 'build', 'verificacion', 'linteo', 'aprobacion', 'entrega'] },
  },
};

function mkTmpPipeline() {
  const dir = path.join(os.tmpdir(), `historico-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  // crear todas las carpetas estado de todas las fases
  for (const [pName, pCfg] of Object.entries(CONFIG.pipelines)) {
    for (const fase of pCfg.fases) {
      for (const estado of ['pendiente', 'trabajando', 'listo', 'procesado']) {
        fs.mkdirSync(path.join(dir, pName, fase, estado), { recursive: true });
      }
    }
  }
  return dir;
}

function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* noop */ }
}

function writeMarker(dir, pipeline, fase, estado, fname, content) {
  const p = path.join(dir, pipeline, fase, estado, fname);
  fs.writeFileSync(p, content || `issue: ${fname.split('.')[0]}\n`);
  return p;
}

// -----------------------------------------------------------------------------

test('moverAHistorico mueve el artefacto de procesado a historico preservando contenido', () => {
  const dir = mkTmpPipeline();
  try {
    const contenido = 'issue: 4136\nresultado: aprobado\n';
    writeMarker(dir, 'desarrollo', 'dev', 'procesado', '4136.pipeline-dev', contenido);

    const dest = historico.moverAHistorico({
      issue: '4136', pipeline: 'desarrollo', fase: 'dev', fname: '4136.pipeline-dev', pipelineDir: dir,
    });

    assert.ok(fs.existsSync(dest), 'el destino debe existir');
    assert.strictEqual(fs.readFileSync(dest, 'utf8'), contenido, 'contenido preservado');
    assert.ok(!fs.existsSync(path.join(dir, 'desarrollo', 'dev', 'procesado', '4136.pipeline-dev')), 'origen ya no existe');
    assert.strictEqual(dest, path.join(historico.historicoRoot(dir), 'desarrollo', 'dev', '4136.pipeline-dev'));
  } finally {
    cleanup(dir);
  }
});

test('la muda queda registrada en el log de transiciones (append-only)', () => {
  const dir = mkTmpPipeline();
  try {
    writeMarker(dir, 'desarrollo', 'dev', 'procesado', '4136.pipeline-dev');
    writeMarker(dir, 'desarrollo', 'build', 'procesado', '4136.build');
    historico.moverAHistorico({ issue: '4136', pipeline: 'desarrollo', fase: 'dev', fname: '4136.pipeline-dev', pipelineDir: dir });
    historico.moverAHistorico({ issue: '4136', pipeline: 'desarrollo', fase: 'build', fname: '4136.build', pipelineDir: dir });

    const logPath = path.join(dir, historico.TRANSITIONS_LOG);
    assert.ok(fs.existsSync(logPath), 'el log de transiciones debe existir');
    const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n');
    assert.strictEqual(lines.length, 2, 'una línea por muda');
    const rec = JSON.parse(lines[0]);
    assert.strictEqual(rec.issue, '4136');
    assert.strictEqual(rec.op, 'mover_a_historico');
    assert.ok(rec.ts, 'cada registro lleva timestamp');
  } finally {
    cleanup(dir);
  }
});

test('archivarIssueTerminado NO archiva un issue con archivos en trabajando', () => {
  const dir = mkTmpPipeline();
  try {
    // Terminal alcanzado, pero todavía activo en otra fase → NO archivable.
    writeMarker(dir, 'desarrollo', 'entrega', 'procesado', '4136.delivery');
    writeMarker(dir, 'desarrollo', 'dev', 'trabajando', '4136.pipeline-dev');

    const r = historico.archivarIssueTerminado({ issue: '4136', config: CONFIG, pipelineDir: dir });

    assert.strictEqual(r.archived, false, 'no archivable con trabajando activo');
    assert.ok(fs.existsSync(path.join(dir, 'desarrollo', 'entrega', 'procesado', '4136.delivery')), 'procesado intacto');
  } finally {
    cleanup(dir);
  }
});

test('archivarIssueTerminado NO archiva un issue sin fase terminal ni closed', () => {
  const dir = mkTmpPipeline();
  try {
    // En reposo pero solo llegó a dev/procesado (no terminal) y no está closed.
    writeMarker(dir, 'desarrollo', 'dev', 'procesado', '4136.pipeline-dev');
    const r = historico.archivarIssueTerminado({ issue: '4136', config: CONFIG, pipelineDir: dir });
    assert.strictEqual(r.archived, false);
    assert.ok(fs.existsSync(path.join(dir, 'desarrollo', 'dev', 'procesado', '4136.pipeline-dev')));
  } finally {
    cleanup(dir);
  }
});

test('archivarIssueTerminado archiva todas las fases de un issue cerrado', () => {
  const dir = mkTmpPipeline();
  try {
    // En reposo, no llegó a terminal, pero está closed → archivable por isClosed.
    writeMarker(dir, 'desarrollo', 'dev', 'procesado', '4136.pipeline-dev');
    writeMarker(dir, 'desarrollo', 'verificacion', 'procesado', '4136.tester');
    writeMarker(dir, 'definicion', 'criterios', 'procesado', '4136.po');

    const r = historico.archivarIssueTerminado({
      issue: '4136', config: CONFIG, pipelineDir: dir, isClosed: () => true,
    });

    assert.strictEqual(r.archived, true);
    assert.strictEqual(r.moved.length, 3, 'mueve las 3 fases');
    // Camino vivo vacío
    for (const [p, f] of [['desarrollo', 'dev'], ['desarrollo', 'verificacion'], ['definicion', 'criterios']]) {
      assert.ok(!fs.existsSync(path.join(dir, p, f, 'procesado', `4136.${f === 'dev' ? 'pipeline-dev' : f === 'verificacion' ? 'tester' : 'po'}`)));
    }
    // En histórico
    assert.ok(fs.existsSync(path.join(historico.historicoRoot(dir), 'desarrollo', 'dev', '4136.pipeline-dev')));
    assert.ok(fs.existsSync(path.join(historico.historicoRoot(dir), 'definicion', 'criterios', '4136.po')));
  } finally {
    cleanup(dir);
  }
});

test('archivarIssueTerminado archiva un issue que alcanzó la fase terminal (sin closed)', () => {
  const dir = mkTmpPipeline();
  try {
    writeMarker(dir, 'desarrollo', 'entrega', 'procesado', '4136.delivery');
    writeMarker(dir, 'desarrollo', 'dev', 'procesado', '4136.pipeline-dev');

    const r = historico.archivarIssueTerminado({ issue: '4136', config: CONFIG, pipelineDir: dir });

    assert.strictEqual(r.archived, true, 'terminal alcanzado → archivable sin isClosed');
    assert.strictEqual(r.moved.length, 2);
  } finally {
    cleanup(dir);
  }
});

test('archivarIssueTerminado solo toca el issue pedido (no arrastra otros)', () => {
  const dir = mkTmpPipeline();
  try {
    writeMarker(dir, 'desarrollo', 'entrega', 'procesado', '4136.delivery');
    writeMarker(dir, 'desarrollo', 'dev', 'procesado', '4137.pipeline-dev'); // otro issue activo
    writeMarker(dir, 'desarrollo', 'dev', 'trabajando', '4137.pipeline-dev');

    const r = historico.archivarIssueTerminado({ issue: '4136', config: CONFIG, pipelineDir: dir });

    assert.strictEqual(r.archived, true);
    assert.ok(fs.existsSync(path.join(dir, 'desarrollo', 'dev', 'procesado', '4137.pipeline-dev')), 'el otro issue intacto');
  } finally {
    cleanup(dir);
  }
});

test('prefijo exacto: el issue 4136 no arrastra artefactos de 41360', () => {
  const dir = mkTmpPipeline();
  try {
    writeMarker(dir, 'desarrollo', 'entrega', 'procesado', '4136.delivery');
    writeMarker(dir, 'desarrollo', 'entrega', 'procesado', '41360.delivery');

    const r = historico.archivarIssueTerminado({ issue: '4136', config: CONFIG, pipelineDir: dir });

    assert.strictEqual(r.moved.length, 1);
    assert.ok(fs.existsSync(path.join(dir, 'desarrollo', 'entrega', 'procesado', '41360.delivery')), '41360 no se toca');
  } finally {
    cleanup(dir);
  }
});

test('barrerHistorico recorre procesado/ y archiva solo lo archivable', () => {
  const dir = mkTmpPipeline();
  try {
    // 4136: terminal alcanzado + reposo → archivable
    writeMarker(dir, 'desarrollo', 'entrega', 'procesado', '4136.delivery');
    // 4137: en dev/procesado pero activo en trabajando → NO archivable
    writeMarker(dir, 'desarrollo', 'dev', 'procesado', '4137.pipeline-dev');
    writeMarker(dir, 'desarrollo', 'dev', 'trabajando', '4137.pipeline-dev');
    // 4138: en sizing/procesado terminal de definicion → archivable
    writeMarker(dir, 'definicion', 'sizing', 'procesado', '4138.planner');

    const r = historico.barrerHistorico({ config: CONFIG, pipelineDir: dir });

    assert.strictEqual(r.scanned, 3);
    assert.deepStrictEqual(r.archivedIssues.sort(), ['4136', '4138']);
    assert.ok(fs.existsSync(path.join(dir, 'desarrollo', 'dev', 'procesado', '4137.pipeline-dev')), '4137 sigue vivo');
  } finally {
    cleanup(dir);
  }
});

test('barrerHistorico es idempotente (segunda corrida no archiva nada nuevo)', () => {
  const dir = mkTmpPipeline();
  try {
    writeMarker(dir, 'desarrollo', 'entrega', 'procesado', '4136.delivery');
    const r1 = historico.barrerHistorico({ config: CONFIG, pipelineDir: dir });
    const r2 = historico.barrerHistorico({ config: CONFIG, pipelineDir: dir });
    assert.strictEqual(r1.archivedIssues.length, 1);
    assert.strictEqual(r2.archivedIssues.length, 0, 'segunda corrida no re-archiva');
  } finally {
    cleanup(dir);
  }
});

test('barrerHistorico respeta el cap max', () => {
  const dir = mkTmpPipeline();
  try {
    writeMarker(dir, 'desarrollo', 'entrega', 'procesado', '4136.delivery');
    writeMarker(dir, 'desarrollo', 'entrega', 'procesado', '4137.delivery');
    writeMarker(dir, 'desarrollo', 'entrega', 'procesado', '4138.delivery');
    const r = historico.barrerHistorico({ config: CONFIG, pipelineDir: dir, max: 1 });
    assert.strictEqual(r.archivedIssues.length, 1, 'solo archiva 1 con max=1');
  } finally {
    cleanup(dir);
  }
});

// --- leerHistorico (seguridad) -----------------------------------------------

test('leerHistorico devuelve los archivos del issue por id', () => {
  const dir = mkTmpPipeline();
  try {
    writeMarker(dir, 'desarrollo', 'entrega', 'procesado', '4136.delivery');
    historico.archivarIssueTerminado({ issue: '4136', config: CONFIG, pipelineDir: dir });
    const files = historico.leerHistorico({ issue: '4136', pipeline: 'desarrollo', fase: 'entrega', config: CONFIG, pipelineDir: dir });
    assert.deepStrictEqual(files, ['4136.delivery']);
  } finally {
    cleanup(dir);
  }
});

test('leerHistorico rechaza issue no numérico', () => {
  const dir = mkTmpPipeline();
  try {
    assert.throws(
      () => historico.leerHistorico({ issue: 'abc', pipeline: 'desarrollo', fase: 'dev', config: CONFIG, pipelineDir: dir }),
      /issue inválido/,
    );
    assert.throws(
      () => historico.leerHistorico({ issue: '12; rm -rf', pipeline: 'desarrollo', fase: 'dev', config: CONFIG, pipelineDir: dir }),
      /issue inválido/,
    );
  } finally {
    cleanup(dir);
  }
});

test('leerHistorico rechaza path traversal con ../', () => {
  const dir = mkTmpPipeline();
  try {
    assert.throws(
      () => historico.leerHistorico({ issue: '4136', pipeline: '../../etc', fase: 'dev', config: CONFIG, pipelineDir: dir }),
      /pipeline inválido/,
    );
    assert.throws(
      () => historico.leerHistorico({ issue: '4136', pipeline: 'desarrollo', fase: '../../../secrets', config: CONFIG, pipelineDir: dir }),
      /fase inválida/,
    );
  } finally {
    cleanup(dir);
  }
});

test('leerHistorico rechaza fase fuera de la allowlist de config', () => {
  const dir = mkTmpPipeline();
  try {
    assert.throws(
      () => historico.leerHistorico({ issue: '4136', pipeline: 'desarrollo', fase: 'inexistente', config: CONFIG, pipelineDir: dir }),
      /fase inválida/,
    );
    assert.throws(
      () => historico.leerHistorico({ issue: '4136', pipeline: 'pipeline-falso', fase: 'dev', config: CONFIG, pipelineDir: dir }),
      /pipeline inválido/,
    );
  } finally {
    cleanup(dir);
  }
});

test('historicoRoot está en el mismo volumen que el pipeline (CA-1)', () => {
  const dir = mkTmpPipeline();
  try {
    assert.ok(historico.assertSameVolume(dir));
    assert.strictEqual(historico.historicoRoot(dir), path.join(dir, 'historico'));
  } finally {
    cleanup(dir);
  }
});

test('estaEnReposo es false si hay archivos en pendiente/listo de cualquier fase', () => {
  const dir = mkTmpPipeline();
  try {
    writeMarker(dir, 'desarrollo', 'build', 'pendiente', '4136.build');
    assert.strictEqual(historico.estaEnReposo({ issue: '4136', config: CONFIG, pipelineDir: dir }), false);
  } finally {
    cleanup(dir);
  }
});
