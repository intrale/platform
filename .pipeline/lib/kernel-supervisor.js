'use strict';

// =============================================================================
// kernel-supervisor.js — Capa supervisor de instancias (Ola Puente P4 · #4762)
//
// Split 1/3 de #4689. Este módulo es el CIMIENTO del modelo multi-producto: lee
// el registro de productos y instancia + supervisa EXACTAMENTE UN pipeline por
// producto `active`, con AISLAMIENTO FUERTE por `projectId` en dos superficies:
//
//   1. Durable (store DynamoDB): ya garantizado por `kernel-store.js`. El
//      supervisor sólo liga UN `createKernelStore` inmutable por `projectId` y
//      NUNCA re-liga ni comparte un handle entre instancias.
//   2. Efímero (in-process): AQUÍ está el trabajo real de esta pieza. TODO el
//      estado efímero (cooldowns, offsets de intake, circuit-breaker, contadores
//      de rebote) vive en el `instanceContext` propio de cada instancia
//      (closure/objeto ligado al `projectId`). CERO estado en `let` de módulo,
//      CERO `globalThis`, CERO caché de módulo compartida, CERO archivo de estado
//      sin namespace por tenant. `pulpo.js` hoy lo hace mal (globals `cooldowns`,
//      `COOLDOWN_FILE` global, `activeProcesses` Map de módulo) — este módulo NO
//      copia ese patrón (ver #4761 para la modularización de pulpo, no bloqueante).
//
// SEGURIDAD (mapa OWASP 2021 del análisis de seguridad de definición · #4762)
//   A01  Broken Access Control: `contextProjectId` SIEMPRE derivado del registro
//        (out-of-band), NUNCA de input en banda. Cruce de partición con
//        `projectId` manipulado ⇒ `KernelStoreIsolationError` fail-closed (lo
//        provee la store; el supervisor liga 1 store por partición).
//   A03/A08  Injection / path-traversal: `isSafeId(id)` fail-closed sobre TODO id
//        (projectId/productId) ANTES de derivar ruta de FS o argumento de spawn.
//   A04  Insecure Design (fault isolation): healthcheck + `restartInstance`
//        AISLADO recrea SÓLO el ctx afectado. El fallo de A nunca reinicia ni
//        bloquea a B (sin DoS cruzado). Un descriptor corrupto de A no aborta el
//        boot de B.
//   A09  Security Logging: los rechazos fail-closed de la store se propagan por
//        `onAlert` con `projectId` de origen (sin filtrar payload del tenant).
//
// El módulo es un FACTORY autocontenido: `createKernelSupervisor(deps)` con todo
// el estado en el closure. No importa globals de pulpo ni escribe archivos de
// estado sin namespace.
// =============================================================================

const { createKernelStore, KernelStoreIsolationError } = require('./kernel-store');
const {
  isSafeId,
  deriveRouting,
  deriveConcurrency,
  deriveCapabilityPartitions,
} = require('./project-descriptor');

const ACTIVE_STATUS = 'active';

/**
 * Resuelve el `projectId` del tenant a partir de un registro de producto. Deriva
 * SIEMPRE del registro (out-of-band), nunca de input en banda (A01). Acepta
 * `projectId` explícito y cae a `productId` (convención cuando el registro no
 * distingue ambos). El caller DEBE validar con `isSafeId` antes de usarlo.
 */
function resolveProjectId(product) {
  if (!product || typeof product !== 'object') return null;
  if (typeof product.projectId === 'string' && product.projectId) return product.projectId;
  if (typeof product.productId === 'string' && product.productId) return product.productId;
  return null;
}

/**
 * Crea el supervisor de instancias del kernel.
 *
 * @param {object} deps
 * @param {object}   deps.catalogStore        store de solo-lectura para `listProducts()`
 *                                             (registro de productos del control-plane).
 * @param {function} [deps.storeFactory]       factory de store por instancia
 *                                             (default: `createKernelStore`). Recibe
 *                                             `{ contextProjectId, allowedNamespaces, onAlert }`.
 * @param {function} [deps.spawn]              lanza el pipeline aislado de la instancia;
 *                                             recibe el `instanceContext`, devuelve un handle.
 *                                             Default: no-op (parts 2/3 inyectan el real).
 * @param {function} [deps.stop]               detiene el handle de una instancia (default: no-op).
 * @param {function} [deps.healthProbe]        `(ctx) => boolean` probe de salud (default: alive).
 * @param {boolean}  [deps.hydrate]            si carga el descriptor y deriva routing/concurrencia/
 *                                             particiones al boot (default: true).
 * @param {function} [deps.onAlert]            callback de alerta fail-closed (A09).
 * @param {function} [deps.now]                fuente de tiempo (ms).
 * @returns {object} API del supervisor.
 */
function createKernelSupervisor(deps = {}) {
  const catalogStore = deps.catalogStore;
  const storeFactory = typeof deps.storeFactory === 'function' ? deps.storeFactory : createKernelStore;
  const spawnFn = typeof deps.spawn === 'function' ? deps.spawn : () => null;
  const stopFn = typeof deps.stop === 'function' ? deps.stop : () => {};
  const healthProbe = typeof deps.healthProbe === 'function' ? deps.healthProbe : () => true;
  const hydrate = deps.hydrate !== false;
  const onAlert = typeof deps.onAlert === 'function' ? deps.onAlert : () => {};
  const now = typeof deps.now === 'function' ? deps.now : () => 0;

  // Mapa PRIVADO del closure: projectId → instanceContext. Jamás expuesto por
  // referencia; jamás a nivel módulo. Dos supervisores distintos tienen mapas
  // distintos (A05: no hay estado compartido de módulo).
  const instances = new Map();

  // ---- construcción de una instancia aislada --------------------------------

  /**
   * Construye el `instanceContext` de un producto: liga UN store inmutable a su
   * `projectId` y crea su estado efímero PROPIO. Nunca comparte ni re-liga
   * handles ni Maps con otra instancia.
   */
  function buildInstance(product, projectId) {
    const store = storeFactory({
      contextProjectId: projectId,      // SIEMPRE del registro, nunca en banda (A01)
      allowedNamespaces: [projectId],
      onAlert,                          // A09: rechazos fail-closed de la store se loguean
    });

    // Defensa en profundidad: el store DEBE quedar ligado a ESTE projectId. Si el
    // factory devolviera un handle de otra partición, fallamos cerrado antes de usarlo.
    if (store && store.contextProjectId && store.contextProjectId !== projectId) {
      throw new KernelStoreIsolationError(
        `aislamiento A01: el store devuelto por el factory no coincide con "${projectId}"`,
        { requested: projectId, context: store.contextProjectId },
      );
    }

    return {
      projectId,
      product,
      store,                            // handle inmutable — jamás re-ligado a otro projectId
      // --- estado EFÍMERO propio de la instancia (A05: nunca global/módulo) ---
      cooldowns: new Map(),             // no archivo global ni let de módulo
      intakeOffsets: new Map(),
      circuitBreaker: { rebotes: new Map() },
      // --- config derivada del descriptor (reuso de derivers, opcional) -------
      routing: null,
      concurrency: null,
      partitions: null,
      // --- lifecycle ----------------------------------------------------------
      handle: null,
      health: { alive: true, restarts: 0, lastError: null },
    };
  }

  /**
   * Hidrata la config derivada del descriptor de la instancia (routing,
   * concurrencia, particiones de capability). Best-effort y AISLADO: un descriptor
   * ausente o corrupto de una instancia NO rompe a las demás (A04 · fault
   * isolation). Reusa los derivers de `project-descriptor.js` sin cambiar firma.
   */
  async function hydrateInstance(ctx) {
    if (!hydrate) return;
    try {
      const desc = await ctx.store.getDescriptor(ctx.projectId);
      const body = desc && desc.body;
      if (body) {
        ctx.routing = deriveRouting(body);
        ctx.concurrency = deriveConcurrency(body);
        ctx.partitions = deriveCapabilityPartitions(body);
      }
    } catch (err) {
      // El fallo de hidratación de A no degrada a B: se registra y se sigue.
      ctx.health.lastError = err && err.message ? err.message : String(err);
      onAlert({ projectId: ctx.projectId, stage: 'hydrate', errors: [{ detail: ctx.health.lastError }] });
    }
  }

  // ---- API pública -----------------------------------------------------------

  /**
   * CA-1 · Instancia EXACTAMENTE UN pipeline por producto `active`. Los productos
   * `onboarding`/`archived` NO obtienen instancia ni store (reduce superficie). Un
   * `projectId` inseguro se descarta fail-closed (A03/A08) sin abortar el resto.
   */
  async function bootProducts() {
    if (!catalogStore || typeof catalogStore.listProducts !== 'function') {
      throw new Error('bootProducts requiere un catalogStore con listProducts()');
    }
    const products = await catalogStore.listProducts();
    const spawned = [];
    const skipped = [];
    for (const p of Array.isArray(products) ? products : []) {
      if (!p || p.status !== ACTIVE_STATUS) {
        skipped.push({ projectId: resolveProjectId(p), reason: 'inactivo' });
        continue;
      }
      const projectId = resolveProjectId(p);
      if (!isSafeId(projectId)) {                 // fail-closed antes de usar en path/spawn
        skipped.push({ projectId: projectId == null ? null : String(projectId), reason: 'projectId inseguro' });
        onAlert({ projectId: null, stage: 'isSafeId', errors: [{ detail: `projectId inseguro descartado: ${String(projectId)}` }] });
        continue;
      }
      const ctx = spawnInstance(p);
      if (ctx) {
        await hydrateInstance(ctx);
        spawned.push(projectId);
      }
    }
    return { spawned, skipped };
  }

  /**
   * Instancia UN producto de forma idempotente: exactamente una instancia por
   * `projectId`. Liga el store inmutable, crea el estado efímero propio y lanza el
   * pipeline aislado vía `spawn`. Devuelve el `instanceContext` (o el existente).
   */
  function spawnInstance(product) {
    const projectId = resolveProjectId(product);
    if (!isSafeId(projectId)) {                   // A03/A08: nunca interpolar id sin validar
      throw new KernelStoreIsolationError(
        `spawnInstance: projectId inseguro "${String(projectId)}" — fail-closed antes de derivar path/spawn`,
        { requested: projectId == null ? null : String(projectId) },
      );
    }
    const existing = instances.get(projectId);
    if (existing) return existing;                // exactamente 1 por producto

    const ctx = buildInstance(product, projectId);
    instances.set(projectId, ctx);
    // spawn AISLADO: sólo se le pasa el ctx propio; el handle vive en su instancia.
    ctx.handle = safeSpawn(ctx);
    return ctx;
  }

  function safeSpawn(ctx) {
    try {
      return spawnFn(ctx);
    } catch (err) {
      // El fallo de spawn de una instancia no puede tumbar a las demás (A04).
      ctx.health.alive = false;
      ctx.health.lastError = err && err.message ? err.message : String(err);
      onAlert({ projectId: ctx.projectId, stage: 'spawn', errors: [{ detail: ctx.health.lastError }] });
      return null;
    }
  }

  /** Devuelve el `instanceContext` de un `projectId`, o `null` si no existe. */
  function getInstance(projectId) {
    if (!isSafeId(projectId)) return null;        // fail-closed sobre id en banda
    return instances.get(projectId) || null;
  }

  /** Lista los `projectId` con instancia activa. */
  function listInstances() {
    return [...instances.keys()];
  }

  /**
   * Ejecuta el probe de salud de UNA instancia y actualiza su estado. AISLADO: no
   * toca ninguna otra instancia. Devuelve el snapshot de salud (o `null`).
   */
  function superviseInstance(projectId) {
    const ctx = getInstance(projectId);
    if (!ctx) return null;
    let alive;
    try {
      alive = healthProbe(ctx) !== false;
    } catch (err) {
      alive = false;
      ctx.health.lastError = err && err.message ? err.message : String(err);
    }
    ctx.health.alive = alive;
    return { projectId, ...ctx.health };
  }

  /**
   * CA-3 · Marca una instancia como caída (callback de crash del pipeline). NO
   * afecta a las demás. Fail-closed sobre id.
   */
  function markInstanceUnhealthy(projectId, error) {
    const ctx = getInstance(projectId);
    if (!ctx) return false;
    ctx.health.alive = false;
    if (error != null) ctx.health.lastError = error && error.message ? error.message : String(error);
    onAlert({ projectId, stage: 'crash', errors: [{ detail: ctx.health.lastError || 'instancia caída' }] });
    return true;
  }

  /**
   * CA-3 · Healthcheck de TODAS las instancias. Con `autoRestart`, reinicia SÓLO
   * las caídas — de forma aislada, sin tocar las sanas. Devuelve el reporte por
   * `projectId`.
   */
  function healthcheck({ autoRestart = false } = {}) {
    const report = {};
    for (const projectId of listInstances()) {
      const snap = superviseInstance(projectId);
      report[projectId] = { alive: snap.alive, restarts: snap.restarts };
      if (!snap.alive && autoRestart) {
        const ctx = restartInstance(projectId);
        report[projectId] = { alive: ctx.health.alive, restarts: ctx.health.restarts, restarted: true };
      }
    }
    return report;
  }

  /**
   * CA-3 (CRÍTICO) · Reinicio AISLADO: recrea SÓLO el ctx de `projectId` (nuevo
   * store inmutable + estado efímero fresco), preservando el contador de restarts.
   * El estado de las demás instancias NO se reinicia, altera ni bloquea (sin DoS
   * cruzado · A04). Devuelve el nuevo ctx (o `null` si no existía).
   */
  function restartInstance(projectId) {
    if (!isSafeId(projectId)) {                   // fail-closed
      throw new KernelStoreIsolationError(
        `restartInstance: projectId inseguro "${String(projectId)}"`,
        { requested: projectId == null ? null : String(projectId) },
      );
    }
    const prev = instances.get(projectId);
    if (!prev) return null;
    const restarts = (prev.health.restarts || 0) + 1;
    const product = prev.product;

    // Detener el handle previo de forma aislada (el fallo de stop de A no afecta a B).
    try { stopFn(prev); } catch (_) { /* aislado: no propaga */ }

    // Recrear SÓLO esta instancia. La referencia al ctx viejo queda huérfana; su
    // estado efímero (Maps) se descarta con ella. Ninguna otra instancia se toca.
    instances.delete(projectId);
    const ctx = buildInstance(product, projectId);
    ctx.health.restarts = restarts;
    instances.set(projectId, ctx);
    ctx.handle = safeSpawn(ctx);
    return ctx;
  }

  /** Detiene y remueve una instancia de forma aislada. `true` si existía. */
  function stopInstance(projectId) {
    const ctx = getInstance(projectId);
    if (!ctx) return false;
    try { stopFn(ctx); } catch (_) { /* aislado */ }
    instances.delete(projectId);
    return true;
  }

  return {
    bootProducts,
    spawnInstance,
    getInstance,
    listInstances,
    superviseInstance,
    markInstanceUnhealthy,
    healthcheck,
    restartInstance,
    stopInstance,
  };
}

module.exports = { createKernelSupervisor, resolveProjectId };
