// =============================================================================
// partial-pause-concurrency-worker.js — Worker forkable para tests de
// concurrencia de partial-pause.js (issue #3518 CA-8).
//
// Recibe por env:
//   PIPELINE_DIR_OVERRIDE   — directorio temporal compartido
//   WORKER_ISSUES_CSV       — CSV "100,200,300" de issues a setear
//   WORKER_ID               — identificador para logs
//
// Hace setPartialPause con esa lista. Sale 0 si OK, 1 si tira.
// =============================================================================
'use strict';

const path = require('path');
const ppPath = path.join(__dirname, '..', '..', 'partial-pause.js');
const pp = require(ppPath);

const csv = String(process.env.WORKER_ISSUES_CSV || '').trim();
const id = process.env.WORKER_ID || `pid-${process.pid}`;
const issues = csv ? csv.split(',').map((s) => Number(s.trim())).filter(Number.isFinite) : [];

try {
    const res = pp.setPartialPause(issues, { source: `concurrency-test-${id}` });
    if (!res.ok) {
        console.error(`worker(${id}): setPartialPause not ok`);
        process.exit(1);
    }
    process.exit(0);
} catch (err) {
    console.error(`worker(${id}): ${err.message}`);
    process.exit(1);
}
