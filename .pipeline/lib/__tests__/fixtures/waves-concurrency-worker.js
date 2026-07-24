// =============================================================================
// waves-concurrency-worker.js — Worker forkable para tests de concurrencia
// de waves.js (issue #3518 CA-8).
//
// Recibe por env:
//   PIPELINE_DIR_OVERRIDE  — directorio temporal compartido
//   WORKER_ISSUE           — número de issue a agregar
//   WORKER_WAVE            — número de ola destino
//
// Hace addIssueToWave y sale con código 0 si tuvo éxito, 1 si tiró.
// Cualquier error se imprime a stderr (capturado por el test padre).
// =============================================================================
'use strict';

const path = require('path');
const wavesPath = path.join(__dirname, '..', '..', 'waves.js');
const waves = require(wavesPath);

const issue = Number(process.env.WORKER_ISSUE);
const wave = Number(process.env.WORKER_WAVE);

if (!Number.isInteger(issue) || !Number.isInteger(wave)) {
    console.error(`worker: WORKER_ISSUE/WORKER_WAVE inválidos (${process.env.WORKER_ISSUE}/${process.env.WORKER_WAVE})`);
    process.exit(2);
}

try {
    waves.addIssueToWave(wave, {
        number: issue,
        status: 'pending',
    }, {
        updated_by: `worker-${process.pid}`,
        source: 'concurrency-test',
        note: `add #${issue}`,
    });
    process.exit(0);
} catch (err) {
    console.error(`worker(pid=${process.pid}, issue=${issue}): ${err.message}`);
    process.exit(1);
}
