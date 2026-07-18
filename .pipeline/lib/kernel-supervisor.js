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
const repoTarget = require('./repo-target');
const { resolveScopedRefs, redactScoped } = require('./credentials');
const { segmentProductState } = require('./product-state-segment');

const ACTIVE_STATUS = 'active';

// -----------------------------------------------------------------------------
// Multiplexor de ruteo product-aware (Ola Puente P4 · #4763 · split 2/3 de #4689)
//
// Resuelve `projectId`/repo de un evento (issue) a la instancia/pipeline del
// producto correcto, fail-closed contra la allowlist derivada del descriptor.
// NO reimplementa validación: se apoya en `isSafeId` (project-descriptor) e
// `isRepoAllowed`/`getRepoForIssue`/`getPrimaryRepo` (repo-target). Ver los
// requisitos de seguridad REQ-SEC-MUX-1..6 del análisis de seguridad del issue.
// -----------------------------------------------------------------------------

// Forma canónica GitHub `owner/repo` (espeja repo-target.REPO_RE). Se usa para
// derivar la allowlist repo-target desde `repositories[].url` del descriptor.
const REPO_SLUG_RE = /^[A-Za-z0-9._-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;

/**
 * Extrae el slug `owner/repo` de un `repositories[].url` del descriptor. Acepta el
 * slug directo (`owner/repo`) o una URL GitHub (`https://github.com/owner/repo`,
 * `git@github.com:owner/repo.git`). Devuelve `null` si no matchea forma canónica.
 * Adaptador PURO: sólo arma el input de repo-target, no valida confianza.
 */
function extractRepoSlug(url) {
  if (typeof url !== 'string') return null;
  const s = url.trim();
  if (!s) return null;
  if (REPO_SLUG_RE.test(s)) return s.toLowerCase();
  const m = s.match(/github\.com[/:]+([A-Za-z0-9._-]{1,39}\/[A-Za-z0-9._-]{1,100}?)(?:\.git)?\/?$/i);
  if (m && REPO_SLUG_RE.test(m[1])) return m[1].toLowerCase();
  return null;
}

/**
 * Deriva un config repo-target (`{ repos: { primary, allowlist, default_base_ref } }`)
 * desde las `repositories[]` de un descriptor de instancia. Es un ADAPTADOR (no
 * validación): no reimplementa `isRepoAllowed`/`getRepoForIssue`, sólo construye su
 * `configOverride` para que la frontera de confianza siga siendo la de repo-target.
 */
function deriveRepoConfig(descriptor) {
  const repos = (descriptor && Array.isArray(descriptor.repositories)) ? descriptor.repositories : [];
  const allowlist = [];
  let primary = null;
  let defaultBaseRef = null;
  for (const r of repos) {
    const slug = extractRepoSlug(r && r.url);
    if (!slug) continue;
    allowlist.push(slug);
    if (r && r.role === 'primary' && !primary) {
      primary = slug;
      if (typeof r.defaultBaseRef === 'string' && r.defaultBaseRef) defaultBaseRef = r.defaultBaseRef;
    }
  }
  if (!primary && allowlist.length > 0) primary = allowlist[0];
  const cfg = { repos: { allowlist } };
  if (primary) cfg.repos.primary = primary;
  if (defaultBaseRef) cfg.repos.default_base_ref = defaultBaseRef;
  return cfg;
}

/**
 * Normaliza el sink de auditoría a una fn `discard(event, reason, meta)`. Acepta:
 *   - `{ discard(event, reason, meta) }`  (interfaz de la receta del issue).
 *   - `function(info)`                     (recibe `{ event, reason, ...meta }`).
 *   - ausente → no-op.
 * REQ-SEC-MUX-3 (A09): todo descarte del multiplexor pasa por acá; sin descartes
 * silenciosos cuando hay sink.
 */
function normalizeAudit(audit) {
  if (audit && typeof audit.discard === 'function') {
    return (event, reason, meta) => audit.discard(event, reason, meta || {});
  }
  if (typeof audit === 'function') {
    return (event, reason, meta) => audit(Object.assign({ event, reason }, meta || {}));
  }
  return () => {};
}

/**
 * Etiqueta segura de un id/repo NO confiable para el log de auditoría. Neutraliza
 * control chars y trunca — NUNCA se usa como path/clave, sólo para trazabilidad
 * (A09). Que el ofensivo sea inseguro no debe envenenar el propio registro.
 */
function safeAuditLabel(value) {
  if (typeof value !== 'string') {
    return value === null || value === undefined ? String(value) : `<${typeof value}>`;
  }
  const cleaned = Array.from(value, (ch) => (ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f) ? "?" : ch).join("");
  return cleaned.length > 80 ? `${cleaned.slice(0, 77)}...` : cleaned;
}

/** Candidato de repo de origen propagado en el evento (mismo contrato que repo-target). */
function extractEventRepo(event) {
  if (!event || typeof event !== 'object') return null;
  const c = event.origin_repo || event.repo || event.repository || null;
  return (typeof c === 'string' && c.trim()) ? c.trim() : null;
}

/**
 * CA-3 · Multiplexor de ruteo product-aware FAIL-CLOSED. Resuelve el evento a la
 * instancia/pipeline correcta o lo descarta+audita. Orden fail-closed:
 *
 *   1. `isSafeId(projectId)` ANTES de tocar path/clave (A03 · REQ-SEC-MUX-2). El
 *      regex `^[a-z0-9][a-z0-9-]{1,63}$` + rechazo de `..`/`/`/`\` cubre traversal,
 *      confusión de namespace y control chars.
 *   2. `descriptors.get(projectId)` — fuera de catálogo ⇒ descartar (sin instancia
 *      implícita).
 *   3. Allowlist derivada del descriptor de la instancia (default-deny). Un repo
 *      explícito fuera de allowlist se DESCARTA — nunca se reencamina a `primary`
 *      (REQ-SEC-MUX-1: prohibido el fallback-a-primary cross-tenant del path
 *      single-product de `getRepoForIssue`).
 *
 * @param {object} event  evento entrante. `projectId` in-band se valida fail-closed.
 *                        `origin_repo`/`repo`/`repository` (opcional) es el repo de
 *                        origen propagado.
 * @param {object} opts
 * @param {Map}    opts.descriptors  catálogo `projectId → instancia`. La instancia
 *                                   aporta el config repo-target vía `.config` o un
 *                                   descriptor crudo vía `.descriptor`.
 * @param {function|object} [opts.audit]  sink de auditoría (fn o `{ discard }`).
 * @returns {{instance:object, repo:string, projectId:string}|null}  `null` ⇒ descartado.
 */
function resolveInstanceForEvent(event, opts = {}) {
  const audit = normalizeAudit(opts.audit);
  const descriptors = opts.descriptors;

  if (!event || typeof event !== 'object') {
    audit(event, 'evento inválido');
    return null;
  }

  const projectId = event.projectId;

  // 1) Defensa-en-profundidad ANTES de derivar cualquier path/estado/clave.
  if (!isSafeId(projectId)) {
    audit(event, 'projectId inseguro', { projectId: safeAuditLabel(projectId) });
    return null;
  }

  // 2) Catálogo → instancia. Fuera de catálogo ⇒ descartar sin crear instancia.
  const inst = (descriptors && typeof descriptors.get === 'function') ? descriptors.get(projectId) : null;
  if (!inst) {
    audit(event, 'projectId fuera de catálogo', { projectId });
    return null;
  }

  // Config repo-target de la instancia (adaptador desde su descriptor). Cacheado
  // en la instancia para no rederivar en cada evento.
  let cfg = inst.config;
  if (!cfg && inst.descriptor) {
    cfg = inst._repoConfig || (inst._repoConfig = deriveRepoConfig(inst.descriptor));
  }
  const allowlist = (cfg && cfg.repos && Array.isArray(cfg.repos.allowlist)) ? cfg.repos.allowlist : [];
  if (allowlist.length === 0) {
    // Fail-closed: una instancia sin repos allowlisted no rutea nada. Sin este
    // guard, repo-target caería a su FALLBACK_PRIMARY global (fail-open).
    audit(event, 'instancia sin repos allowlisted', { projectId });
    return null;
  }

  // 3) Allowlist derivada del descriptor (default-deny). REQ-SEC-MUX-1.
  const candidate = extractEventRepo(event);
  let repo;
  if (candidate != null) {
    if (!repoTarget.isRepoAllowed(candidate, cfg)) {
      audit(event, 'repo fuera de allowlist', { projectId, repo: safeAuditLabel(candidate) });
      return null;
    }
    // El candidato ya está allowlisted: getRepoForIssue devuelve el mismo repo
    // normalizado (no cae a primary porque pasa el chequeo de allowlist).
    repo = repoTarget.getRepoForIssue(event, cfg);
  } else {
    // Sin repo en el evento: primary DE LA INSTANCIA ya resuelta (mismo tenant, no
    // cross-tenant). No hay reencaminamiento entre productos.
    repo = repoTarget.getPrimaryRepo(cfg);
  }

  return { instance: inst, repo, projectId };
}

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
      descriptor: null,                 // #4763 — retenido en hydrate para el multiplexor
      routing: null,
      concurrency: null,
      partitions: null,
      // --- #4764 · estado observable NAMESPACEADO por instancia (CA-4 · A01) --
      // Métricas/tokens/tiempos/estado/audit# viven en el ctx propio de la
      // instancia; NUNCA en un agregado global. La vista segmentada sólo lee
      // de acá y siempre para UN solo projectId.
      metrics: null,                    // { ... } agregados numéricos del producto
      tokens: null,                     // { in, out, ... } consumo del producto
      times: null,                      // { ... } tiempos del producto
      phase: null,                      // estado de fase actual del producto
      audit: [],                        // audit# namespaceado (ring in-process)
      // --- #4764 · secretos resueltos SCOPED de la instancia (CA-6 · A02) -----
      // Se resuelven SÓLO los scopes declarados del projectId vía resolveScopedRefs
      // y se guardan acá (target de inyección por proceso hijo). NUNCA en el
      // process.env global del supervisor; NUNCA vía loadIntoEnv().
      secrets: null,                    // { <scope>: <valor> } — no loguear crudo
      secretsMeta: null,                // redactScoped(resolved) — sólo nombres de scope
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
        // #4763 — retener el descriptor de la instancia para que el multiplexor de
        // ruteo (resolveEvent) derive su allowlist repo-target por instancia.
        ctx.descriptor = body;
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

  /**
   * #4763 · Multiplexor de ruteo product-aware ligado a las instancias vivas de
   * ESTE supervisor. Resuelve `event.projectId`/repo a la instancia correcta
   * fail-closed, auditando cada descarte por `onAlert` (A09). Sin descriptor
   * multi-instancia el caller (pulpo) cae al ruteo global de repo-target.
   */
  function resolveEvent(event) {
    return resolveInstanceForEvent(event, {
      descriptors: instances,
      audit: (info) => onAlert({
        projectId: info && info.projectId != null ? info.projectId : null,
        stage: 'route-discard',
        errors: [{ detail: info && info.reason ? info.reason : 'evento descartado por el multiplexor' }],
      }),
    });
  }

  // ---- #4764 · CA-6 / A02 · resolución de secretos SCOPED por instancia -------

  /**
   * Resuelve los secretos de UNA instancia entregando SÓLO los scopes declarados
   * de su `projectId`. Fail-closed y sin fuga cross-tenant:
   *   - `isSafeId(projectId)` (A03) ANTES de construir la ref namespaceada.
   *   - Ref namespaceada por `projectId` (`<path>#<projectId>`); NUNCA el archivo
   *     completo. Se usa `resolveScopedRefs` (credentials.js), JAMÁS `loadIntoEnv()`.
   *   - Los secretos resueltos se guardan en el ctx de la instancia (target de
   *     inyección por proceso hijo), NUNCA en `process.env` del supervisor.
   *   - Logging/alertas SIEMPRE redactadas (`redactScoped`): sólo nombres de scope.
   *
   * @param {string} projectId  id de la instancia (validado fail-closed).
   * @param {object} [opts]
   * @param {string[]} [opts.scopes]      scopes declarados; default: los del descriptor
   *                                       (`descriptor.secrets.scopes`).
   * @param {string}   [opts.ref]         ref namespeada explícita; default: derivada
   *                                       del descriptor o `<credentialsPath>#<projectId>`.
   * @param {object}   [opts.data]        credentials ya parseadas (override para tests).
   * @param {string}   [opts.credentialsPath] path del archivo (override para tests).
   * @returns {{ok:boolean, meta:object, error?:string}}  `meta` = redactScoped (sin valores).
   */
  function resolveInstanceSecrets(projectId, opts = {}) {
    if (!isSafeId(projectId)) {                   // A03: nunca construir ref con id sin validar
      throw new KernelStoreIsolationError(
        `resolveInstanceSecrets: projectId inseguro "${String(projectId)}" — fail-closed antes de derivar ref`,
        { requested: projectId == null ? null : String(projectId) },
      );
    }
    const ctx = instances.get(projectId);
    if (!ctx) return { ok: false, meta: { namespace: projectId, scopes: [] }, error: 'instancia inexistente' };

    const desc = ctx.descriptor && typeof ctx.descriptor === 'object' ? ctx.descriptor : null;
    const declared = desc && desc.secrets && typeof desc.secrets === 'object' ? desc.secrets : null;
    const scopes = Array.isArray(opts.scopes) ? opts.scopes
      : (declared && Array.isArray(declared.scopes) ? declared.scopes : []);
    // Ref SIEMPRE namespaceada por el projectId de ESTA instancia (no in-band).
    const basePath = opts.ref
      ? String(opts.ref).split('#')[0]
      : (declared && typeof declared.path === 'string' && declared.path
          ? declared.path
          : '~/.claude/secrets/credentials.json');
    const ref = `${basePath}#${projectId}`;

    const resolveOpts = {};
    if (opts.data) resolveOpts.data = opts.data;
    if (opts.credentialsPath) resolveOpts.canonicalPath = opts.credentialsPath;

    const resolved = resolveScopedRefs(ref, scopes, resolveOpts);
    const meta = redactScoped(resolved);          // A02: sólo nombres de scope, nunca valores

    if (!resolved.ok) {
      // Fail-closed: no dejar secretos parciales/ajenos en el ctx.
      ctx.secrets = null;
      ctx.secretsMeta = meta;
      onAlert({ projectId, stage: 'secrets', errors: [{ detail: `resolución scoped fallida (missing: ${meta.missing.join(',') || '—'})` }] });
      return { ok: false, meta, error: resolved.error || 'scopes faltantes' };
    }

    // Secretos SÓLO en el ctx de la instancia (nunca process.env global · CA-6.2).
    ctx.secrets = resolved.scopes;
    ctx.secretsMeta = meta;
    return { ok: true, meta };
  }

  // ---- #4764 · CA-4 / A01 · estado observable NAMESPACEADO por instancia ------

  /**
   * Registra estado observable (métricas/tokens/tiempos/fase) de UNA instancia en
   * su propio ctx (namespaceado por `projectId`). Fail-closed sobre id inseguro.
   * NUNCA escribe en un agregado global.
   */
  function recordInstanceState(projectId, patch) {
    const ctx = getInstance(projectId);           // getInstance ya valida isSafeId
    if (!ctx) return false;
    const p = patch && typeof patch === 'object' ? patch : {};
    if (p.metrics !== undefined) ctx.metrics = p.metrics;
    if (p.tokens !== undefined) ctx.tokens = p.tokens;
    if (p.times !== undefined) ctx.times = p.times;
    if (p.phase !== undefined) ctx.phase = p.phase;
    return true;
  }

  /**
   * Agrega una entrada de auditoría (`audit#`) al trail namespaceado de UNA
   * instancia. Aislado por `projectId`: la auditoría de A nunca se mezcla con B.
   */
  function appendInstanceAudit(projectId, entry) {
    const ctx = getInstance(projectId);
    if (!ctx) return false;
    if (!Array.isArray(ctx.audit)) ctx.audit = [];
    ctx.audit.push(entry);
    return true;
  }

  /**
   * CA-4 · Vista de estado SEGMENTADA de UN producto, fail-closed. Delega la
   * decisión de acceso a `segmentProductState` (mismo núcleo que el endpoint del
   * dashboard). Nunca devuelve el agregado global ni datos de otro `projectId`.
   *
   * @param {string} projectId  producto pedido (input no confiable, validado).
   * @param {object} [opts]
   * @param {string} [opts.authorizedProjectId]  id autorizado por el contexto
   *                  (out-of-band). Si se pasa, sólo ese id resuelve (anti-IDOR);
   *                  un `projectId` distinto ⇒ fail-closed. Si se omite, se autoriza
   *                  contra las instancias vivas (una a la vez, nunca el agregado).
   * @returns {{status:number, payload:object}}
   */
  function getSegmentedState(projectId, opts = {}) {
    const stateByProjectId = {};
    for (const [pid, ctx] of instances) {
      stateByProjectId[pid] = {
        metrics: ctx.metrics,
        tokens: ctx.tokens,
        times: ctx.times,
        phase: ctx.phase,
        state: ctx.health ? { alive: ctx.health.alive, restarts: ctx.health.restarts } : undefined,
        audit: ctx.audit,
      };
    }
    const authorizedProjectIds = (opts && typeof opts.authorizedProjectId === 'string')
      ? [opts.authorizedProjectId]
      : undefined;
    return segmentProductState({ requestedProjectId: projectId, authorizedProjectIds, stateByProjectId });
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
    resolveEvent,
    // #4764 · secretos scoped por instancia (CA-6 · A02) + estado segmentado (CA-4 · A01)
    resolveInstanceSecrets,
    recordInstanceState,
    appendInstanceAudit,
    getSegmentedState,
  };
}

module.exports = {
  createKernelSupervisor,
  resolveProjectId,
  // #4763 · Multiplexor de ruteo product-aware (standalone + adaptadores).
  resolveInstanceForEvent,
  deriveRepoConfig,
  extractRepoSlug,
};
