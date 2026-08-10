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

// Fail-closed: sin `auditDir` explicito, `createVaultShadowMetrics` cae al
// DEFAULT_AUDIT_DIR — o sea, al `.pipeline/audit/` REAL del repo. Invocar este
// worker a mano ("a ver que hace") alcanzaba para appendear filas sinteticas
// (`hostConcurrente`, `worker.undefined_0`) al JSONL de produccion y reiniciar
// el t0 por evidencia negativa, dejando la ventana sombra de #5427 imposible de
// cerrar. Ademas rompia de forma permanente los tests de integridad de
// `credentials-vault-shadow-5448.test.js`, que verifican justamente que esos
// artefactos NO existan. El worker solo tiene sentido contra un directorio
// temporal, asi que exigirlo es gratis y elimina el footgun de raiz.
if (!auditDir || !marca) {
  process.stderr.write(
    'uso: node _vault-shadow-concurrent-worker.js <auditDir> <marca> [filas]\n'
    + 'auditDir y marca son OBLIGATORIOS: sin auditDir el worker escribiria en el '
    + '.pipeline/audit/ real del repo y contaminaria la evidencia de la ventana sombra.\n',
  );
  process.exit(2);
}

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
