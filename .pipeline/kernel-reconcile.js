#!/usr/bin/env node
'use strict';

// =============================================================================
// kernel-reconcile.js — CLI de la reconciliación DynamoDB → filesystem (#5209).
//
// Convierte en un comando verificable lo que hasta acá era un procedimiento
// manual del runbook (§2): exportar las firmas y la auditoría escritas durante la
// ventana durable, reintegrarlas al filesystem y PROBAR con conteos y hashes que
// ningún registro quedó únicamente en DynamoDB.
//
// QUÉ HACE Y QUÉ NO
// -----------------
// Hace: precheck → freeze → export → validate → stage → atomic-promote →
//       reread-filesystem → compare, y emite un veredicto explícito de si queda
//       HABILITADO apagar `kernel.durable`.
//
// NO hace: apagar el flag, reiniciar el pipeline ni completar la fase. Esas tres
// las ejecuta el operador siguiendo el runbook. La razón es deliberada: un script
// de reconciliación que además reinicia servicios puede dejar el pipeline fuera
// de servicio si falla a mitad, y el valor de esta herramienta es justamente
// decidir CON EVIDENCIA si ese paso está permitido.
//
// USO
//   node .pipeline/kernel-reconcile.js --status
//       Muestra qué hay hoy reintegrado en filesystem. No toca nada, no usa AWS.
//
//   node .pipeline/kernel-reconcile.js --apply --frozen [--profile P] [--project-id ID]
//       Corre la reconciliación completa contra el store durable real.
//       `--frozen` es OBLIGATORIO y es una afirmación del operador: la ventana
//       está congelada y no entran firmas nuevas.
//
// Exit code 0 sólo si la paridad cerró exacta. Cualquier otro caso ⇒ 1 y
// `kernel.durable` NO se toca.
// =============================================================================

const path = require('node:path');

const {
  reconcileDurableToFilesystem,
  readFilesystemRecords,
  renderReconcileReport,
  RECONCILE_TYPES,
  FILE_BY_TYPE,
  MANIFEST_FILE,
} = require('./lib/kernel-append-only-reconcile');
const { redactSecrets } = require('./lib/kernel-store-migrate');

const PIPELINE_DIR = __dirname;

// Destino de los registros reintegrados. Cuelga de `.pipeline/audit/`, que ya
// está fuera de Git (`git check-ignore .pipeline/audit/...` → ignorado): firmas y
// auditoría NUNCA pueden entrar a un repo público por un `git add -A`.
const DEFAULT_RECONCILE_DIR = path.join(PIPELINE_DIR, 'audit', 'kernel-reconcile');

function parseArgs(argv) {
  const args = { apply: false, frozen: false, status: false, profile: null, projectId: null, dir: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--apply') args.apply = true;
    else if (a === '--frozen') args.frozen = true;
    else if (a === '--status') args.status = true;
    else if (a === '--profile') { args.profile = argv[i + 1]; i += 1; }
    else if (a === '--project-id') { args.projectId = argv[i + 1]; i += 1; }
    else if (a === '--dir') { args.dir = argv[i + 1]; i += 1; }
  }
  return args;
}

/** Reporte de sólo lectura: qué quedó reintegrado en filesystem. */
function renderStatus(dir) {
  const L = [];
  L.push('== ESTADO DE LA RECONCILIACIÓN (filesystem) ==');
  L.push(`   directorio: ${dir}`);
  const res = readFilesystemRecords(dir);
  if (!res.ok) {
    L.push(`[FALLA] ${res.code}: ${res.error}`);
    return { ok: false, report: L.join('\n') };
  }
  const porTipo = {};
  for (const t of RECONCILE_TYPES) porTipo[t] = res.records.filter((r) => r.type === t).length;
  L.push(`[OK] registros reintegrados: ${res.records.length}`);
  for (const t of RECONCILE_TYPES) L.push(`     ${t}: ${porTipo[t]} (${FILE_BY_TYPE[t]})`);
  if (res.records.length === 0) {
    L.push('     Todavía no se reintegró nada. Un conjunto vacío NO habilita apagar `kernel.durable`.');
  }
  L.push(`     manifiesto: ${path.join(dir, MANIFEST_FILE)}`);
  return { ok: true, report: L.join('\n') };
}

function buildStore(args) {
  let kernelCfg = {};
  try {
    // Punto ÚNICO de lectura de config (#5174). Un `yaml.load` propio leería una
    // configuración que el pipeline no usa.
    const cfg = require('./lib/config-resolver').resolve({ pipelineDir: PIPELINE_DIR });
    kernelCfg = (cfg && cfg.kernel) || {};
  } catch (e) {
    return { ok: false, error: `no se pudo leer .pipeline/config.yaml: ${redactSecrets(e.message)}` };
  }

  // Mismo cableado que el boot durable y que la sonda de cutover: si acá se
  // armara el driver de otra forma, estaríamos reconciliando contra un camino
  // que producción no usa.
  const probe = require('./lib/kernel-cutover-probe');
  const drv = probe.buildRuntimeDriver(kernelCfg, args.profile);
  if (!drv.ok) return { ok: false, error: drv.error };

  const contextProjectId = args.projectId || kernelCfg.projectId;
  if (!contextProjectId) {
    return {
      ok: false,
      error: 'falta el projectId de la partición a reconciliar: pasá `--project-id <id>` o declaralo en `kernel.projectId`.',
    };
  }

  const { createKernelStore } = require('./lib/kernel-store');
  try {
    return {
      ok: true,
      contextProjectId,
      store: createKernelStore({ driver: drv.driver, contextProjectId, config: { kernel: kernelCfg } }),
    };
  } catch (e) {
    return { ok: false, error: redactSecrets(e.message) };
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const dir = args.dir ? path.resolve(args.dir) : DEFAULT_RECONCILE_DIR;

  if (!args.apply || args.status) {
    const st = renderStatus(dir);
    process.stdout.write(`${st.report}\n`);
    if (!args.apply) {
      process.stdout.write(
        '\nPara reconciliar de verdad: node .pipeline/kernel-reconcile.js --apply --frozen\n' +
        '`--frozen` afirma que la ventana durable está congelada (§5 del runbook).\n',
      );
    }
    process.exitCode = st.ok ? 0 : 1;
    if (!args.apply) return;
  }

  if (!args.frozen) {
    process.stdout.write(
      '[FALLA] falta `--frozen`.\n' +
      '\n' +
      'Qué pasó: `--apply` sin `--frozen` no corre. Si entra una firma nueva mientras se exporta, el conjunto\n' +
      'exportado nace viejo y la paridad se calcula contra un universo que ya cambió — daría verde sin serlo.\n' +
      '\n' +
      'Qué hacer ahora: congelá la ventana (§5 del runbook) y repetí con `--apply --frozen`.\n',
    );
    process.exitCode = 1;
    return;
  }

  const built = buildStore(args);
  if (!built.ok) {
    process.stdout.write(`[FALLA] ${built.error}\n`);
    process.exitCode = 1;
    return;
  }

  const res = await reconcileDurableToFilesystem({
    store: built.store,
    reconcileDir: dir,
    allowedRoot: PIPELINE_DIR,
    frozen: true,
  });

  process.stdout.write(`${renderReconcileReport(res)}\n`);
  process.stdout.write('\n');
  if (res.ok) {
    process.stdout.write(
      'VEREDICTO: HABILITADO para apagar `kernel.durable`.\n' +
      'Paridad exacta verificada releyendo del filesystem. Seguí el orden del runbook §2.4:\n' +
      '  1. `kernel.durable: false` en .pipeline/config.yaml\n' +
      '  2. reinicio limpio\n' +
      '  3. completar una fase leyendo desde filesystem\n' +
      '  4. registrar R8 (tiempo real de recuperación) en el issue del cutover\n',
    );
  } else {
    process.stdout.write(
      'VEREDICTO: BLOQUEADO. NO apagues `kernel.durable`.\n' +
      'DynamoDB sigue siendo la fuente efectiva y ningún dato se perdió: el append-only no se borra nunca.\n' +
      'Corregí lo que indica el error de arriba y volvé a correr — la reconciliación es idempotente.\n',
    );
  }
  process.exitCode = res.ok ? 0 : 1;
}

if (require.main === module) {
  main().catch((e) => {
    process.stdout.write(`[FALLA] error inesperado: ${redactSecrets(e && e.message)}\n`);
    process.exitCode = 1;
  });
}

// `buildStore` se exporta para que `kernel-drill-seed.js` escriba la sonda del
// ensayo por el MISMO cableado de driver que después lee la reconciliación. Si
// cada uno armara el suyo, un desacople entre ambos se leería como
// `conjunto_vacio` con la tabla llena — el diagnóstico apuntaría al lugar
// equivocado (#5209).
module.exports = { parseArgs, renderStatus, buildStore, DEFAULT_RECONCILE_DIR };
