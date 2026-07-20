'use strict';

// =============================================================================
// kernel-durable-boot.js — Boot durable del supervisor multi-producto
// (Split 3/3 de #4804 · #4822)
//
// Cablea `kernel-supervisor.bootProducts()` al arranque del pulpo. Este módulo
// concentra la LÓGICA testeable del boot durable; `pulpo.js` sólo lo invoca
// (best-effort) con los builders reales de store/spawn. Separarlo del monolito
// permite testear el gate (flag OFF ⇒ no corre — CA-6/CA-SEC-1) y el wiring
// (flag ON ⇒ instancia el supervisor y carga los `active` — CA-1/CA-2) en
// aislamiento, sin levantar el pulpo entero.
//
// Reglas de seguridad heredadas del análisis del issue:
//   · CA-SEC-1 (A05): el flag `kernel.durable` se lee OUT-OF-BAND de la config
//     (default false); NUNCA se deriva de datos del store/producto.
//   · CA-SEC-4 (A04/DoS): el boot respeta un techo de instancias concurrentes,
//     leído out-of-band de config (default conservador — RAM crítica del host).
//   · Best-effort: nunca tumba el arranque. Errores de INFRA (store no
//     disponible) ⇒ boot omitido sin throw; un catálogo corrupto/inyectado SÍ
//     se propaga (fail-closed) para que el caller lo audite (no se enmascara).
// =============================================================================

const kernelSupervisor = require('./kernel-supervisor');

// Techo por default de instancias concurrentes que el boot durable puede
// spawnear. Conservador a propósito: en este host la RAM es crítica. El valor
// efectivo lo pasa el caller desde `config.yaml`; este default sólo aplica si la
// clave falta o es inválida. Nunca proviene de datos del producto (CA-SEC-1).
const DEFAULT_MAX_CONCURRENT_INSTANCES = 2;

// Lee la cota out-of-band del bloque `kernel` de config. Fail-safe al default
// conservador ante ausencia o valor inválido (CA-SEC-1/CA-SEC-4).
function resolveCap(kernelCfg) {
  const raw = kernelCfg && kernelCfg.max_concurrent_instances;
  if (Number.isInteger(raw) && raw > 0) return raw;
  return DEFAULT_MAX_CONCURRENT_INSTANCES;
}

/**
 * Corre el boot durable del supervisor multi-producto, gateado por
 * `config.kernel.durable === true` (fail-closed).
 *
 * @param {object}   deps
 * @param {object}   deps.config             config del pipeline (loadConfig()).
 * @param {object}   [deps.catalogStore]     store de catálogo ya construido (tests).
 * @param {function} [deps.buildCatalogStore] `(kernelCfg) => catalogStore` — builder
 *                                            durable real (lo pasa el caller de prod).
 * @param {function} [deps.createSupervisor] override de `createKernelSupervisor` (tests).
 * @param {function} [deps.storeFactory]     factory de store por instancia (aislado por projectId).
 * @param {function} [deps.spawn]            spawn aislado por instancia (A04).
 * @param {function} [deps.onAlert]          callback de auditoría de rechazos (A09).
 * @param {function} [deps.log]              logger `(msg) => void` (best-effort).
 * @returns {Promise<{ran:boolean, reason?:string, spawned?:string[], skipped?:object[], cap?:number, supervisor?:object}>}
 */
async function runDurableBoot(deps = {}) {
  const config = (deps.config && typeof deps.config === 'object') ? deps.config : {};
  const kernelCfg = (config.kernel && typeof config.kernel === 'object') ? config.kernel : {};
  const log = typeof deps.log === 'function' ? deps.log : () => {};

  // Gate fail-closed (CA-SEC-1/CA-6): con el flag ausente/false el boot durable
  // NO corre y el arranque FS del pulpo queda byte-idéntico al de hoy.
  if (kernelCfg.durable !== true) {
    return { ran: false, reason: 'kernel.durable OFF' };
  }

  // Resolución del store de catálogo: inyectado (tests) o construido por el
  // builder del caller a partir del driver durable de #4820.
  let catalogStore = (deps.catalogStore && typeof deps.catalogStore.listProducts === 'function')
    ? deps.catalogStore
    : null;
  if (!catalogStore && typeof deps.buildCatalogStore === 'function') {
    try {
      const built = deps.buildCatalogStore(kernelCfg);
      if (built && typeof built.listProducts === 'function') catalogStore = built;
    } catch (err) {
      // Fallo al construir el store durable = INFRA no disponible ⇒ boot omitido
      // sin tumbar el arranque (best-effort). No se cae a otro modo silencioso.
      const detail = err && err.message ? err.message : String(err);
      log(`WARN [kernel-durable] no se pudo construir el catalogStore durable; boot omitido: ${detail}`);
      return { ran: false, reason: 'catalogStore no construible' };
    }
  }
  if (!catalogStore) {
    log('WARN [kernel-durable] catalogStore durable no disponible; boot durable omitido');
    return { ran: false, reason: 'catalogStore no disponible' };
  }

  const cap = resolveCap(kernelCfg);
  const createSupervisor = typeof deps.createSupervisor === 'function'
    ? deps.createSupervisor
    : kernelSupervisor.createKernelSupervisor;
  const onAlert = typeof deps.onAlert === 'function'
    ? deps.onAlert
    : (a) => { log(`WARN [kernel-durable] rechazo boot (${a && a.stage ? a.stage : 'desconocido'}): ${describeAlert(a)}`); };

  const sup = createSupervisor({
    catalogStore,
    storeFactory: deps.storeFactory,     // default createKernelStore, aislado por projectId (CA-SEC-5)
    spawn: deps.spawn,                   // spawn AISLADO por instancia (A04)
    maxConcurrentInstances: cap,         // CA-SEC-4: techo de instancias
    onAlert,                             // CA-SEC-6: auditoría de rechazos (A09)
  });

  // Un catálogo corrupto/inyectado hace throw acá (KernelStoreValidationError):
  // se propaga al try/catch best-effort del caller, que lo audita. Un producto
  // individual inseguro NO llega a throw — se saltea dentro de bootProducts.
  const { spawned, skipped } = await sup.bootProducts();
  log(`[kernel-durable] boot: ${spawned.length} activos instanciados, ${skipped.length} salteados (cap ${cap})`);
  return { ran: true, spawned, skipped, cap, supervisor: sup };
}

// Texto corto de una alerta para el log del boot (sin volcar objetos crudos).
function describeAlert(a) {
  if (!a || typeof a !== 'object') return String(a);
  const errs = Array.isArray(a.errors) ? a.errors.map((e) => (e && e.detail) ? e.detail : String(e)).join('; ') : '';
  return errs || `projectId=${a.projectId == null ? 'null' : String(a.projectId)}`;
}

module.exports = {
  runDurableBoot,
  resolveCap,
  DEFAULT_MAX_CONCURRENT_INSTANCES,
};
