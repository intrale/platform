// =============================================================================
// propuestas-registry-concurrency-worker.js — Worker forkable para el test de
// concurrencia de `propuestas-registry.publicar()` (#7515, CA "dos workers en
// paralelo → ambas vivas"). Patrón de `partial-pause-concurrency-worker.js`.
//
// Recibe por env:
//   PIPELINE_DIR_OVERRIDE     — directorio temporal compartido
//   PIPELINE_OPSTATE_DURABLE  — '0' (modo filesystem)
//   WORKER_ID                 — identificador; también diferencia la propuesta
//
// Publica UNA propuesta propia (evidencia.referencia distinta por worker).
// Sale 0 si `ok`, 1 si rechazó o tiró.
// =============================================================================
'use strict';

const path = require('path');
const registry = require(path.join(__dirname, '..', '..', 'propuestas-registry.js'));

const id = process.env.WORKER_ID || `pid-${process.pid}`;

try {
    const res = registry.publicar({
        titulo: `Propuesta concurrente del worker ${id}`,
        tipo: 'mejora-de-proceso',
        accion: `accion del worker ${id}`,
        evidencia: { tipo: 'log', referencia: `logs/worker-${id}.log`, resumen: 'hecho observado' },
        beneficio: 'menos carreras',
        costo: { nivel: 'bajo' },
        riesgo: { nivel: 'bajo' },
        sensible: false,
    }, { productor: 'auditor-modelos' });
    if (!res.ok) {
        console.error(`worker(${id}): publicar not ok: ${res.motivo} ${res.detalle || ''}`);
        process.exit(1);
    }
    process.exit(0);
} catch (err) {
    console.error(`worker(${id}): ${err.message}`);
    process.exit(1);
}
