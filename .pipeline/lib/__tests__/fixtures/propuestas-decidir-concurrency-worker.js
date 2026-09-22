// =============================================================================
// propuestas-decidir-concurrency-worker.js — Worker forkable para el test de
// concurrencia de `propuestas-registry.decidir()` (#7516, CA "decidir(rechazar)
// en paralelo con una republicación de la misma propuesta").
//
// Mismo contrato de env que `propuestas-registry-concurrency-worker.js`:
//   PIPELINE_DIR_OVERRIDE     — directorio temporal compartido
//   PIPELINE_OPSTATE_DURABLE  — '0' (modo filesystem)
//   WORKER_ID                 — identificador para el diagnóstico
//   PROPUESTA_ID              — id de la propuesta viva que hay que rechazar
//
// Rechaza UNA propuesta. Sale 0 si `ok`, 1 si rechazó o tiró.
// =============================================================================
'use strict';

const path = require('path');
const registry = require(path.join(__dirname, '..', '..', 'propuestas-registry.js'));

const id = process.env.WORKER_ID || `pid-${process.pid}`;
const propuestaId = process.env.PROPUESTA_ID || '';

try {
    const res = registry.decidir({
        id: propuestaId,
        decision: 'rechazar',
        authorizedBy: 'operador:telegram',
        canal: 'telegram',
    });
    if (!res.ok) {
        console.error(`worker(${id}): decidir not ok: ${res.motivo} ${res.detalle || ''}`);
        process.exit(1);
    }
    process.exit(0);
} catch (err) {
    console.error(`worker(${id}): ${err.message}`);
    process.exit(1);
}
