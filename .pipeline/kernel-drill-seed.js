#!/usr/bin/env node
'use strict';

// =============================================================================
// kernel-drill-seed.js — Sonda POSITIVA del ensayo de rollback durable (#5209).
//
// POR QUÉ EXISTE
// --------------
// `kernel-reconcile.js` aborta con `conjunto_vacio` cuando no hay ni una firma ni
// una entrada de audit que reconciliar, y hace bien: un ensayo de rollback sobre
// un conjunto vacío SIEMPRE da paridad, así que no prueba nada. Pero eso deja al
// operador con un paso que el runbook prescribía a mano ("generá al menos una
// firma y un audit durante la ventana durable") y que a mano no es reproducible:
// escribir un ítem crudo con `aws dynamodb put-item` saltea el envelope, la
// validación de schema, la partición por `contextProjectId`, la sanitización y la
// `ConditionExpression` append-only. Una sonda escrita por un camino que
// producción no usa no demuestra que producción funcione.
//
// Este CLI escribe la sonda por el MISMO camino que el runtime durable:
// `createKernelStore(...).putSignature()` / `.appendAuditEntry()` sobre el driver
// que arma `kernel-cutover-probe.buildRuntimeDriver` — el mismo cableado que usa
// el boot del pulpo y el que después lee la reconciliación.
//
// LO QUE ESTE COMANDO NO PUEDE DESHACER
// -------------------------------------
// La tabla de no-repudio no concede `DeleteItem` (policy IAM #5124 · Deny
// incondicional sobre las 7 acciones de mutación). Lo que escribe acá queda
// escrito PARA SIEMPRE. Por eso `--apply` no alcanza: hace falta además
// `--i-understand-append-only`, que es la afirmación explícita de que quien lo
// corre sabe que no hay vuelta atrás. El default es dry-run.
//
// La sonda es deliberadamente inofensiva y auto-descriptiva: un `signer` fijo
// (`kernel-rollback-drill`), un `target` que nombra el issue del ensayo y un
// `action` de audit `kernel.rollback.drill.seed`. Si alguien la encuentra dentro
// de un año en la tabla, el ítem dice qué es y por qué está.
//
// USO
//   node .pipeline/kernel-drill-seed.js --profile kernel-runtime --project-id ID
//       Dry-run. Muestra exactamente qué escribiría. No toca la tabla.
//
//   node .pipeline/kernel-drill-seed.js --apply --i-understand-append-only \
//        --profile kernel-runtime --project-id ID
//       Escribe UNA firma y UNA entrada de audit y emite sus IDs, para cruzarlos
//       contra el export de `kernel-reconcile.js --apply --frozen`.
//
// Exit code 0 sólo si ambos ítems quedaron escritos (o si el dry-run cerró bien).
// =============================================================================

const crypto = require('node:crypto');

const { redactSecrets } = require('./lib/kernel-store-migrate');
// El cableado del store se IMPORTA de `kernel-reconcile.js`, no se reescribe: si
// la sonda se escribiera por un driver armado de otra forma que el que lee la
// reconciliación, un desacople entre ambos daría `conjunto_vacio` con la tabla
// llena y nadie sabría cuál de los dos caminos está mal.
const { buildStore } = require('./kernel-reconcile');

const SIGNER = 'kernel-rollback-drill';
const AUDIT_ACTION = 'kernel.rollback.drill.seed';
const AUDIT_ACTOR = 'kernel-drill-seed';

function parseArgs(argv) {
  const args = {
    apply: false, understood: false, profile: null, projectId: null, note: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--apply') args.apply = true;
    else if (a === '--i-understand-append-only') args.understood = true;
    else if (a === '--profile') { args.profile = argv[i + 1]; i += 1; }
    else if (a === '--project-id') { args.projectId = argv[i + 1]; i += 1; }
    else if (a === '--note') { args.note = argv[i + 1]; i += 1; }
  }
  return args;
}

/**
 * Cuerpo de la sonda. Determinístico dado `(projectId, at, note)`: el checksum es
 * el SHA-256 del payload canónico, así que el ítem es verificable a posteriori
 * sin tener que confiar en lo que este script dijo haber escrito.
 */
function buildProbe({ projectId, at, note }) {
  const payload = JSON.stringify({
    drill: 'kernel-durable-rollback',
    issue: 5209,
    projectId,
    at,
    note: note || null,
  });
  const checksum = crypto.createHash('sha256').update(payload, 'utf8').digest('hex');
  const detalle = note
    ? `ensayo de rollback durable #5209 · ${note}`
    : 'ensayo de rollback durable #5209 · sonda positiva para que la reconciliacion no corra sobre conjunto vacio';
  return {
    payload,
    signature: {
      signer: SIGNER,
      target: 'issue-5209/durable-rollback-drill',
      checksum,
      algorithm: 'sha256',
      signedAt: at,
    },
    audit: {
      action: AUDIT_ACTION,
      actor: AUDIT_ACTOR,
      at,
      detail: detalle,
    },
  };
}

function renderDryRun(probe, projectId) {
  const L = [];
  L.push('== SONDA DEL ENSAYO DE ROLLBACK (dry-run) ==');
  L.push(`   partición (PK / contextProjectId): ${projectId}`);
  L.push('   firma que se escribiría:');
  L.push(`     signer:    ${probe.signature.signer}`);
  L.push(`     target:    ${probe.signature.target}`);
  L.push(`     checksum:  ${probe.signature.checksum}`);
  L.push(`     signedAt:  ${probe.signature.signedAt}`);
  L.push('   audit que se escribiría:');
  L.push(`     action:    ${probe.audit.action}`);
  L.push(`     actor:     ${probe.audit.actor}`);
  L.push(`     detail:    ${probe.audit.detail}`);
  L.push('');
  L.push('   Nada se escribió. Para escribir de verdad, agregá:');
  L.push('     --apply --i-understand-append-only');
  return redactSecrets(L.join('\n'));
}

const AVISO_IRREVERSIBLE =
  '[FALLA] falta `--i-understand-append-only`.\n' +
  '\n' +
  'Qué pasó: `--apply` solo no escribe. La tabla de no-repudio es append-only por policy IAM: NO concede\n' +
  '`DeleteItem`, así que la firma y el audit que escribe este comando quedan en DynamoDB para siempre. No hay\n' +
  'un "deshacer" ni un barrido de limpieza posterior — intentarlo es justamente lo que la policy impide.\n' +
  '\n' +
  'Qué hacer ahora: si entendés que la escritura es irreversible, repetí agregando\n' +
  '`--i-understand-append-only`. Si no estabas seguro, corré sin `--apply`: el dry-run muestra exactamente\n' +
  'qué ítems saldrían.\n' +
  '\n' +
  'La trampa: no uses `aws dynamodb put-item` "para probar más rápido". Ese camino saltea el envelope, la\n' +
  'validación de schema y la condición append-only, y deja en la tabla un ítem que la reconciliación va a\n' +
  'rechazar como corrupto — sin poder borrarlo.';

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const at = new Date().toISOString();

  // El guard de irreversibilidad se evalúa ANTES de construir el store: si falta
  // el flag, resolver credenciales y armar el driver sería trabajo (y superficie
  // AWS) para un comando que ya sabemos que no va a escribir.
  if (args.apply && !args.understood) {
    process.stdout.write(`${AVISO_IRREVERSIBLE}\n`);
    process.exitCode = 1;
    return;
  }

  const built = buildStore(args);
  if (!built.ok) {
    process.stdout.write(`[FALLA] ${built.error}\n`);
    process.exitCode = 1;
    return;
  }
  const projectId = built.contextProjectId;
  const probe = buildProbe({ projectId, at, note: args.note });

  if (!args.apply) {
    process.stdout.write(`${renderDryRun(probe, projectId)}\n`);
    process.exitCode = 0;
    return;
  }

  try {
    const sig = await built.store.putSignature(probe.signature);
    const aud = await built.store.appendAuditEntry(probe.audit);
    const L = [];
    L.push('== SONDA DEL ENSAYO DE ROLLBACK ESCRITA ==');
    L.push(`   partición: ${projectId}`);
    L.push(`   firma:     ${sig.sk}`);
    L.push(`   audit:     ${aud.sk}`);
    L.push(`   checksum de la firma: ${probe.signature.checksum}`);
    L.push('');
    L.push('   Ahora la reconciliación tiene conjunto NO vacío. Seguí con:');
    L.push('     node .pipeline/kernel-reconcile.js --apply --frozen ...');
    process.stdout.write(`${redactSecrets(L.join('\n'))}\n`);
    process.exitCode = 0;
  } catch (e) {
    process.stdout.write(`[FALLA] no se pudo escribir la sonda: ${redactSecrets(e && e.message)}\n`);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main().catch((e) => {
    process.stdout.write(`[FALLA] error inesperado: ${redactSecrets(e && e.message)}\n`);
    process.exitCode = 1;
  });
}

module.exports = { parseArgs, buildProbe, renderDryRun, SIGNER, AUDIT_ACTION, AUDIT_ACTOR };
