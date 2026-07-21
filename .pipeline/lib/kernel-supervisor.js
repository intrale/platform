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

const path = require('node:path');

const { createKernelStore, KernelStoreIsolationError } = require('./kernel-store');
const {
  isSafeId,
  deriveRouting,
  deriveConcurrency,
  deriveCapabilityPartitions,
  loadDescriptor,
} = require('./project-descriptor');
const { createCoordinationStore } = require('./kernel-coordination-store');
const repoTarget = require('./repo-target');
const { resolveScopedRefs, redactScoped } = require('./credentials');
const { segmentProductState } = require('./product-state-segment');

const ACTIVE_STATUS = 'active';

// -----------------------------------------------------------------------------
// Circuit-breaker por producto (Ola Puente P5b · #4776 · split de #4690)
//
// Defaults INMUTABLES de la máquina de estados del breaker. Son `const` de módulo
// de SOLO LECTURA (nunca `let`/`var`, nunca `globalThis`): NO son estado mutable
// compartido entre productos. El estado mutable del breaker (contador de fallos,
// ventana, apertura, estado open/half-open/closed) vive EXCLUSIVAMENTE en el
// `instanceContext.circuitBreaker` de cada instancia (A04/A05: cero globals). Un
// supervisor puede sobreescribir estos umbrales vía `deps` (derivable del
// descriptor), pero siempre a otra `const` inmutable del closure.
// -----------------------------------------------------------------------------
const BREAKER_THRESHOLD = 3;         // fallos dentro de la ventana para abrir (closed → open)
const BREAKER_WINDOW_MS = 60 * 1000; // ventana deslizante del contador de fallos
const BREAKER_COOLDOWN_MS = 30 * 1000; // espera en `open` antes de probar (open → half-open)
const BREAKER_RECOVERY_MS = 30 * 1000; // permanencia en `half-open` sin fallos → closed

// #4822 · CA-SEC-4 (REQ-SEC-BOOT-5, A04/DoS) — techo de instancias concurrentes
// que el boot durable puede spawnear. Default conservador: la RAM del host es
// crítica y un catálogo envenenado con N productos `active` no debe poder
// spawnear procesos sin cota. El valor efectivo lo pasa el caller (out-of-band,
// desde config.yaml); esta constante es el piso seguro del boot durable.
const MAX_CONCURRENT_INSTANCES_DEFAULT = 2;

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
  // #4801 · CA-3 — drenador de la cola de onboarding. Se ejecuta ANTES de listar
  // productos para que un alta recién encolada se registre (`status:onboarding`)
  // y aparezca en el catálogo. Inyectable/deshabilitable por tests: `false`
  // desactiva; una función la reemplaza; por default se usa el drenador real.
  // #4800 — ese mismo drenador real (`product-control-drainer.drainOnboardQueue`)
  // crea el repo `provenance:'create'` (idempotente) y completa la url ANTES de
  // registrar, así el path del kernel materializa la creación automática (CA-1).
  const drainOnboardQueue = deps.drainOnboardQueue === false
    ? null
    : (typeof deps.drainOnboardQueue === 'function'
        ? deps.drainOnboardQueue
        : () => require('./product-control-drainer').drainOnboardQueue());

  // #4776 · Umbrales del circuit-breaker, resueltos UNA vez a `const` inmutables
  // del closure (nunca `let`/`var` mutable de módulo). Overridables por `deps`
  // (config derivable del descriptor); si el override es inválido, cae al default.
  const breakerThreshold = Number.isInteger(deps.breakerThreshold) && deps.breakerThreshold > 0
    ? deps.breakerThreshold : BREAKER_THRESHOLD;
  const breakerWindowMs = Number.isFinite(deps.breakerWindowMs) && deps.breakerWindowMs > 0
    ? deps.breakerWindowMs : BREAKER_WINDOW_MS;
  const breakerCooldownMs = Number.isFinite(deps.breakerCooldownMs) && deps.breakerCooldownMs > 0
    ? deps.breakerCooldownMs : BREAKER_COOLDOWN_MS;
  const breakerRecoveryMs = Number.isFinite(deps.breakerRecoveryMs) && deps.breakerRecoveryMs > 0
    ? deps.breakerRecoveryMs : BREAKER_RECOVERY_MS;

  // #4822 · CA-SEC-4 — cota de instancias del boot durable, leída OUT-OF-BAND de
  // `deps` (el caller la resuelve de config.yaml, nunca de datos del producto —
  // CA-SEC-1). `null` = sin cota (compat: los tests/callers legacy que no la
  // pasan mantienen el comportamiento previo). El boot durable (`bootKernelDurable`)
  // SIEMPRE la provee con un default seguro, de modo que en producción hay techo.
  const maxConcurrentInstances = Number.isInteger(deps.maxConcurrentInstances) && deps.maxConcurrentInstances > 0
    ? deps.maxConcurrentInstances
    : null;

  // #4809 · create-wave — factory del coordination store por producto (namespaceado
  // por `contextProjectId`). Default: in-memory de `createCoordinationStore` (mismo
  // criterio que `storeFactory`); el boot durable inyecta el factory real con
  // `config.coordinationTableName`. NUNCA se comparte handle entre productos.
  const coordinationStoreFactory = typeof deps.coordinationStoreFactory === 'function'
    ? deps.coordinationStoreFactory
    : (projectId) => createCoordinationStore({ contextProjectId: projectId, config: deps.config, onAlert });
  // Gate del descriptor (CA-2). Default: carga+valida `descriptors/<projectId>.json`
  // fail-closed (== "descriptor completo"). Inyectable por tests / boot durable.
  const waveDescriptorsDir = typeof deps.descriptorsDir === 'string' && deps.descriptorsDir
    ? deps.descriptorsDir
    : require('./product-control-drainer').DEFAULT_DESCRIPTORS_DIR;
  const loadWaveDescriptorGate = typeof deps.loadWaveDescriptorGate === 'function'
    ? deps.loadWaveDescriptorGate
    : (projectId) => {
        const res = loadDescriptor(path.join(waveDescriptorsDir, `${projectId}.json`));
        return { valid: res.valid === true, errors: res.errors || [] };
      };

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
      // #4776 · circuit-breaker PROPIO de la instancia (A04/A05: cero globals de
      // módulo, cero `globalThis`). La máquina de estados vive acá y NO es
      // observable ni mutable desde otra instancia. `rebotes` se conserva tal cual
      // (clave P4 que el test existente verifica) — se AGREGAN campos hermanos.
      circuitBreaker: {
        state: 'closed',              // 'closed' | 'open' | 'half-open'
        rebotes: new Map(),           // clave existente (issueId → count) — NO romper
        failureCount: 0,              // fallos acumulados dentro de la ventana vigente
        windowStart: now(),           // inicio de la ventana deslizante (deps.now, nunca Date.now)
        openedAt: null,               // ms de la última apertura → base del cooldown
      },
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
    // #4801 · CA-3 — drenar la cola de onboarding ANTES de listar. Best-effort:
    // un fallo del drenaje NO puede tumbar el boot de los productos existentes.
    if (drainOnboardQueue) {
      try { await drainOnboardQueue(); }
      catch (e) { onAlert({ projectId: null, stage: 'drain-onboard', errors: [{ detail: e && e.message ? e.message : String(e) }] }); }
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
      // #4822 · CA-SEC-4 (REQ-SEC-BOOT-5) — cota de instancias concurrentes: un
      // catálogo con N>cap productos `active` NO spawnea procesos sin techo (RAM
      // crítica del host). No aborta el boot: saltea el excedente y lo audita, de
      // modo que el catálogo entero se clasifica igual (paridad con los otros skips).
      if (maxConcurrentInstances != null && spawned.length >= maxConcurrentInstances) {
        skipped.push({ projectId, reason: 'cap de instancias alcanzado' });
        onAlert({ projectId, stage: 'cap', errors: [{ detail: `boot durable alcanzó el cap de ${maxConcurrentInstances} instancias` }] });
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

  // ---- circuit-breaker por producto (#4776 · aislamiento de fallos) ----------

  /**
   * Helper PRIVADO del closure: aplica las transiciones dependientes del tiempo del
   * breaker de UNA instancia (`ctx`), usando `now()` (nunca `Date.now()` — rompe el
   * determinismo de los tests). Muta SÓLO el `ctx.circuitBreaker` recibido; jamás
   * toca otra instancia (A04: sin efecto cruzado). Transiciones:
   *   - ventana deslizante vencida → resetea el contador de fallos.
   *   - `open` + cooldown vencido → `half-open` (habilita un intento de recuperación).
   *   - `half-open` sostenido sin nuevos fallos por `recoveryMs` → `closed`.
   * Devuelve el estado vigente tras evaluar.
   */
  function evaluateBreaker(ctx) {
    const cb = ctx.circuitBreaker;
    const t = now();
    // Ventana deslizante: si expiró, el contador de fallos arranca de cero.
    if (t - cb.windowStart >= breakerWindowMs) {
      cb.windowStart = t;
      cb.failureCount = 0;
    }
    // Cooldown vencido: open → half-open (un solo intento de prueba).
    if (cb.state === 'open' && cb.openedAt != null && t - cb.openedAt >= breakerCooldownMs) {
      cb.state = 'half-open';
    }
    // Recuperación: permaneció en half-open sin nuevos fallos (un fallo re-abre y
    // reescribe `openedAt`) durante recoveryMs → vuelve a closed.
    if (cb.state === 'half-open' && cb.openedAt != null
        && t - cb.openedAt >= breakerCooldownMs + breakerRecoveryMs) {
      cb.state = 'closed';
      cb.openedAt = null;
      cb.failureCount = 0;
      cb.windowStart = t;
    }
    return cb.state;
  }

  /**
   * CA-1/CA-3 · Registra un fallo (rebote/saturación) del breaker de `projectId` y
   * evalúa la apertura del circuito. AISLADO: sólo toca el ctx propio del producto;
   * el breaker de A abriéndose NO altera a B (sin DoS cruzado · A04).
   *
   * Fail-closed (A01/A03/A08): resuelve el ctx SIEMPRE vía `getInstance` (valida
   * `isSafeId` out-of-band); un `projectId` inseguro o inexistente ⇒ `null`, sin
   * derivar ruta ni tocar estado ajeno. El `projectId` es la clave de acceso, nunca
   * input en banda que derive un path.
   *
   * @param {string} projectId  id del producto (del registro, validado por getInstance).
   * @returns {object|null} copia solo-lectura del estado del breaker, o `null` fail-closed.
   */
  function recordBreakerFailure(projectId) {
    const ctx = getInstance(projectId);
    if (!ctx) return null;                          // fail-closed: id inseguro/inexistente
    const cb = ctx.circuitBreaker;
    // Aplicar primero las transiciones temporales (ventana/cooldown) con el reloj actual.
    evaluateBreaker(ctx);
    cb.failureCount += 1;
    if (cb.state === 'half-open') {
      // Un fallo durante la prueba re-abre inmediatamente y reinicia el cooldown.
      cb.state = 'open';
      cb.openedAt = now();
      onAlert({ projectId, stage: 'breaker-open', errors: [{ detail: `breaker re-abierto en half-open (${projectId})` }] });
    } else if (cb.state === 'closed' && cb.failureCount >= breakerThreshold) {
      // Se superó el umbral dentro de la ventana: abrir el circuito.
      cb.state = 'open';
      cb.openedAt = now();
      onAlert({ projectId, stage: 'breaker-open', errors: [{ detail: `breaker abierto: ${cb.failureCount} fallos en ventana (${projectId})` }] });
    }
    return snapshotBreaker(cb);
  }

  /** Copia superficial de SOLO LECTURA del estado del breaker (nunca la ref viva). */
  function snapshotBreaker(cb) {
    return { state: cb.state, failureCount: cb.failureCount, openedAt: cb.openedAt };
  }

  /**
   * CA-6 · Vista SOLO-LECTURA del estado del breaker de `projectId` (consumida por
   * el scheduler global #4775 para no despachar a un producto con breaker abierto).
   * Evalúa primero las transiciones temporales, luego devuelve una COPIA — nunca la
   * referencia mutable interna: mutar el retorno no altera el estado del breaker.
   *
   * Fail-closed vía `getInstance`: `projectId` inseguro/inexistente ⇒ `null`.
   *
   * @param {string} projectId
   * @returns {{state:string, failureCount:number, openedAt:(number|null)}|null}
   */
  function getBreakerState(projectId) {
    const ctx = getInstance(projectId);
    if (!ctx) return null;                          // fail-closed
    evaluateBreaker(ctx);                           // refleja cooldown/ventana al leer
    return snapshotBreaker(ctx.circuitBreaker);
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

  // ---- #4809 · CA-1/CA-2/CA-5 · drenaje de create-wave ("el kernel ejecuta") ----

  /**
   * Resuelve el conjunto AUTORIZADO de `projectId` OUT-OF-BAND (CA-5 · A01): el
   * catálogo propio de ESTE contexto (credencial), NUNCA el id en banda. Incluye
   * productos `onboarding` (la primera ola puede crearse antes de activar · #4805).
   */
  async function authorizedProjectIdSet() {
    const set = new Set();
    if (catalogStore && typeof catalogStore.listProducts === 'function') {
      const products = await catalogStore.listProducts();
      for (const p of Array.isArray(products) ? products : []) {
        const pid = resolveProjectId(p);
        if (isSafeId(pid)) set.add(pid);
      }
    }
    return set;
  }

  /**
   * CA-1/CA-2/CA-5 · Drena la cola `product-control/pendiente` de pedidos
   * `create-wave` y ejecuta la asociación de la primera ola con:
   *   - autorización out-of-band contra el catálogo del contexto (CA-5);
   *   - gate fail-closed del descriptor (CA-2);
   *   - `associateFirstWave` create-once del coordination store (CA-3), aislado
   *     por `projectId` (CA-4).
   * Best-effort: NUNCA lanza por un pedido individual (los rechazos son dato).
   *
   * @param {object} [opts]  { queueDir, processedDir, auditFile } (default: reales).
   * @returns {Promise<{created:string[],idempotent:string[],rejected:Array,errors:Array}>}
   */
  async function drainCreateWaveQueue(opts = {}) {
    const authorized = await authorizedProjectIdSet();
    const impl = typeof deps.drainCreateWaveQueueImpl === 'function'
      ? deps.drainCreateWaveQueueImpl
      : require('./product-control-drainer').drainCreateWaveQueue;
    return impl(opts, {
      // CA-5: autoridad SÓLO del catálogo out-of-band; el id en banda no decide.
      isAuthorized: (projectId) => authorized.has(projectId),
      // CA-2: gate fail-closed del descriptor.
      loadDescriptor: loadWaveDescriptorGate,
      // CA-1/CA-3/CA-4: create-once en el store namespaceado por producto.
      associateWave: async (projectId, wave) => {
        const store = coordinationStoreFactory(projectId);
        return store.associateFirstWave(wave);
      },
      now,
    });
  }

  return {
    bootProducts,
    drainCreateWaveQueue,
    spawnInstance,
    getInstance,
    listInstances,
    superviseInstance,
    markInstanceUnhealthy,
    // #4776 · circuit-breaker por producto (aislamiento de fallos · CA-1..CA-6)
    recordBreakerFailure,
    getBreakerState,
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

/**
 * #4822 · Boot durable del supervisor multi-producto — Parte 3/3 de #4804.
 *
 * Gatea OUT-OF-BAND por `config.kernel.durable === true` (fail-closed: flag
 * ausente/false/no-booleano ⇒ NO corre — CA-6/CA-SEC-1). El flag se lee
 * EXCLUSIVAMENTE de `config` (que el caller obtiene de `config.yaml` vía
 * `loadConfig()`), NUNCA de datos del propio store/producto.
 *
 * BEST-EFFORT: la función NUNCA lanza. Cualquier fallo (construcción del store,
 * driver AWS ausente, catálogo corrupto) se captura, se audita por `onAlert` y
 * se devuelve como `{ ran:false, reason:'error' }`. El boot del pulpo — el único
 * caller de producción — no puede morir por esto (mismo criterio que el boot-hook
 * de wave-recovery).
 *
 * La cota de instancias (CA-SEC-4) SIEMPRE se aplica: si `config.kernel.max_concurrent_instances`
 * no es un entero > 0, cae a `MAX_CONCURRENT_INSTANCES_DEFAULT`. Así el boot
 * durable jamás spawnea sin techo, ni siquiera con config incompleta.
 *
 * @param {object}   opts
 * @param {object}    opts.config              config del pipeline (loadConfig()); el flag y la cota se leen de acá.
 * @param {function}  opts.buildCatalogStore   () => catalogStore durable con `listProducts()`. LAZY: sólo se invoca con el flag ON (con flag OFF no se instancia nada AWS — CA-6).
 * @param {function} [opts.buildStoreFactory]  () => storeFactory por instancia (liga el driver durable a cada tenant). Opcional (default: in-memory de createKernelStore).
 * @param {function} [opts.spawn]              spawn(ctx) AISLADO por instancia (A04). Opcional.
 * @param {function} [opts.onAlert]            callback de alerta fail-closed (A09).
 * @param {function} [opts.createSupervisor]   factory del supervisor (test override; default: createKernelSupervisor).
 * @returns {Promise<{ran:boolean, reason?:string, cap?:number, spawned?:string[], skipped?:Array, error?:string}>}
 */
async function bootKernelDurable(opts = {}) {
  const config = opts.config && typeof opts.config === 'object' ? opts.config : {};
  const kernel = config.kernel && typeof config.kernel === 'object' ? config.kernel : {};
  const onAlert = typeof opts.onAlert === 'function' ? opts.onAlert : () => {};

  // Fail-closed (CA-SEC-1/CA-6): SÓLO corre con el flag EXACTAMENTE en `true`.
  // Ausente, `false`, o cualquier truthy no-booleano ⇒ el boot durable NO corre
  // y el arranque FS actual del pulpo no cambia.
  if (kernel.durable !== true) {
    return { ran: false, reason: 'flag-off' };
  }

  const createSupervisor = typeof opts.createSupervisor === 'function'
    ? opts.createSupervisor
    : createKernelSupervisor;

  try {
    if (typeof opts.buildCatalogStore !== 'function') {
      throw new Error('bootKernelDurable requiere buildCatalogStore() para listar el catálogo durable');
    }
    const catalogStore = opts.buildCatalogStore();

    // Cota out-of-band de config (CA-SEC-4). Sin valor válido ⇒ default seguro.
    const cap = Number.isInteger(kernel.max_concurrent_instances) && kernel.max_concurrent_instances > 0
      ? kernel.max_concurrent_instances
      : MAX_CONCURRENT_INSTANCES_DEFAULT;

    const supervisor = createSupervisor({
      catalogStore,
      storeFactory: typeof opts.buildStoreFactory === 'function' ? opts.buildStoreFactory() : undefined,
      spawn: typeof opts.spawn === 'function' ? opts.spawn : undefined,
      maxConcurrentInstances: cap,
      onAlert,
    });

    const { spawned, skipped } = await supervisor.bootProducts();
    return { ran: true, cap, spawned, skipped };
  } catch (e) {
    const detail = e && e.message ? e.message : String(e);
    try { onAlert({ projectId: null, stage: 'boot-durable', errors: [{ detail }] }); } catch { /* alerta best-effort */ }
    return { ran: false, reason: 'error', error: detail };
  }
}

module.exports = {
  createKernelSupervisor,
  resolveProjectId,
  // #4822 · Boot durable del supervisor multi-producto (gateado + best-effort).
  bootKernelDurable,
  MAX_CONCURRENT_INSTANCES_DEFAULT,
  // #4763 · Multiplexor de ruteo product-aware (standalone + adaptadores).
  resolveInstanceForEvent,
  deriveRepoConfig,
  extractRepoSlug,
};
