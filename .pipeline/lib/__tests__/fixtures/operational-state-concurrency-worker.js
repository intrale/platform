// =============================================================================
// operational-state-concurrency-worker.js — Worker forkable para los tests de
// concurrencia de la fachada de estado operativo (#5108).
//
// Corre en un PROCESO REAL, no in-process. Es la única forma de que el test sea
// honesto: `waves.js` cachea lecturas 2s por proceso, así que dos llamadas
// dentro del mismo proceso pasarían en verde aunque hubiera lost update.
//
// Recibe por env:
//   PIPELINE_DIR_OVERRIDE — directorio temporal compartido entre los workers
//   WORKER_MODE           — 'wave' (registro de olas) | 'allowlist'
//   WORKER_ISSUE          — número de issue a agregar
//   WORKER_WAVE           — ola destino (sólo en modo 'wave')
//   WORKER_ID             — identificador para logs
//
// Sale 0 si la mutación fue OK, 1 si tiró o el gate la rechazó.
// =============================================================================

'use strict';

const path = require('path');

const opStatePath = path.join(__dirname, '..', '..', 'operational-state.js');
const opState = require(opStatePath);

const mode = String(process.env.WORKER_MODE || 'wave');
const id = process.env.WORKER_ID || `pid-${process.pid}`;
const issue = Number(process.env.WORKER_ISSUE);
const wave = Number(process.env.WORKER_WAVE || 1);

if (!Number.isInteger(issue)) {
    console.error(`worker(${id}): WORKER_ISSUE inválido (${process.env.WORKER_ISSUE})`);
    process.exit(2);
}

try {
    if (mode === 'allowlist') {
        const res = opState.addToAllowlist([issue], {
            authorizedBy: 'commander:leo',
            justification: `concurrency-test ${id}`,
            source: 'test',
        });
        if (!res || res.ok === false) {
            console.error(`worker(${id}): addToAllowlist rechazado`);
            process.exit(1);
        }
    } else {
        opState.addIssueToWave(wave, { number: issue, status: 'pending' }, {
            updated_by: `worker-${process.pid}`,
            source: 'concurrency-test',
            note: `add #${issue}`,
        });
    }
    process.exit(0);
} catch (err) {
    console.error(`worker(${id}, pid=${process.pid}, issue=${issue}): ${err.message}`);
    process.exit(1);
}
