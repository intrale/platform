// =============================================================================
// Worker de concurrencia para vault-shadow-metrics.test.js (#5448)
// =============================================================================
//
// Se ejecuta como PROCESO SEPARADO a propósito: el riesgo real que cubre —
// varios boots del pipeline appendeando el mismo JSONL — no se reproduce con
// funciones dentro del mismo proceso, porque ahí `appendFileSync` se serializa
// solo. Cada worker escribe filas de evidencia negativa (la vía que appendea
// inmediato) y sale.
//
//   node _vault-shadow-concurrent-worker.js <auditDir> <marca> <filas>
// =============================================================================
'use strict';

const { createVaultShadowMetrics } = require('../vault-shadow-metrics');

const [auditDir, marca, filasRaw] = process.argv.slice(2);
const filas = Number(filasRaw) || 1;

const metrics = createVaultShadowMetrics({
  auditDir,
  logger: () => {},
  autoFlushOnExit: false,
});

// Un descriptor por fila: `record` recorre `sources` una sola vez por llamada,
// así que N llamadas = N appends, que es lo que interesa estresar.
for (let i = 0; i < filas; i += 1) {
  const dotPath = `worker.${marca}_${i}`;
  metrics.record(
    { [`ENV_${marca}_${i}`]: 'missing' },
    { hostId: 'hostConcurrente', descriptors: { [dotPath]: { env: `ENV_${marca}_${i}` } } },
  );
}

process.exit(0);
