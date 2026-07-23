// =============================================================================
// waves-mutation-worker.js — Worker forkable para tests de concurrencia de las
// mutaciones nuevas del dominio (#4372: editWave / removeIssueFromWave).
//
// Recibe por env:
//   PIPELINE_DIR_OVERRIDE  — directorio temporal compartido
//   WORKER_OP              — 'remove' | 'edit'
//   WORKER_WAVE            — número de ola destino
//   WORKER_ISSUE           — issue a quitar (op remove)
//   WORKER_NAME            — nuevo nombre (op edit)
//
// Sale 0 si la operación no corrompió el estado (aplicada o no-op), 1 si tiró
// un error inesperado. Un EWAVES_VERSION_CONFLICT NO se considera fallo: es el
// resultado esperado cuando dos writers optimistas chocan.
// =============================================================================
'use strict';

const path = require('path');
const waves = require(path.join(__dirname, '..', '..', 'waves.js'));

const op = process.env.WORKER_OP;
const wave = Number(process.env.WORKER_WAVE);
const meta = { updated_by: `worker-${process.pid}`, source: 'concurrency-test' };

try {
    if (op === 'remove') {
        waves.removeIssueFromWave(wave, Number(process.env.WORKER_ISSUE), meta);
    } else if (op === 'edit') {
        waves.editWave(wave, { name: process.env.WORKER_NAME }, meta);
    } else {
        console.error(`worker: WORKER_OP inválido (${op})`);
        process.exit(2);
    }
    process.exit(0);
} catch (err) {
    if (err && (err.code === 'EWAVES_VERSION_CONFLICT' || err.code === 'EWAVES_DUPLICATE_NAME')) {
        // Choque optimista esperado — no es corrupción.
        process.exit(0);
    }
    console.error(`worker(pid=${process.pid}, op=${op}): ${err.message}`);
    process.exit(1);
}
