'use strict';

// =============================================================================
// dashboard-snapshot-historico.test.js — Issue #4136 (CA-3 / CA-7).
//   node --test .pipeline/test/dashboard-snapshot-historico.test.js
//
// Verifica que `_genPipelineState` (el snapshot del dashboard) recorre SOLO el
// camino vivo (`<pipeline>/<fase>/{pendiente,trabajando,listo,procesado}`) y
// NUNCA la raíz `historico/`.
//
// No booteamos el dashboard (arranca un server HTTP + workers al requerirlo):
//   1. Invariante estructural: la raíz del histórico es hermana del camino vivo,
//      nunca hija de un `<pipeline>/<fase>` que el snapshot walkea.
//   2. Chequeo estático del walk: el cuerpo de `_genPipelineState` itera los 4
//      estados vivos y no incluye `historico` en su lista de directorios.
// =============================================================================

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const historico = require('../lib/historico');

const CONFIG = {
  pipelines: {
    definicion: { fases: ['analisis', 'criterios', 'sizing'] },
    desarrollo: { fases: ['validacion', 'dev', 'build', 'verificacion', 'linteo', 'aprobacion', 'entrega'] },
  },
};

test('la raíz historico/ no es hija de ningún <pipeline>/<fase> que walkea el snapshot', () => {
  const pipelineDir = path.resolve('/tmp/fake-pipeline');
  const root = path.resolve(historico.historicoRoot(pipelineDir));
  for (const [pName, pCfg] of Object.entries(CONFIG.pipelines)) {
    for (const fase of pCfg.fases) {
      const faseDir = path.resolve(path.join(pipelineDir, pName, fase));
      assert.ok(
        root !== faseDir && !root.startsWith(faseDir + path.sep),
        `historico/ (${root}) NO debe estar dentro de ${faseDir}`,
      );
    }
  }
  // Y es hijo directo de pipelineDir (raíz aparte, mismo volumen).
  assert.strictEqual(root, path.join(pipelineDir, 'historico'));
});

test('_genPipelineState walkea solo los 4 estados vivos, sin historico', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'dashboard.js'), 'utf8');

  // Aislar el cuerpo del generador del snapshot.
  const startIdx = src.indexOf('function* _genPipelineState()');
  assert.ok(startIdx >= 0, 'debe existir _genPipelineState');
  // Tomamos una ventana amplia del cuerpo (suficiente para cubrir el walk).
  const body = src.slice(startIdx, startIdx + 4000);

  // El walk de estados debe contener los 4 vivos…
  for (const estado of ['pendiente', 'trabajando', 'listo', 'procesado']) {
    assert.ok(body.includes(`'${estado}'`), `el walk debe incluir el estado '${estado}'`);
  }
  // …y NO debe incluir 'historico' como directorio walkeado.
  assert.ok(!/['"]historico['"]/.test(body), 'el walk del snapshot NO debe referenciar historico');
});
