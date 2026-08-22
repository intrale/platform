'use strict';

// =============================================================================
// product-control-drain.js — Drainer kernel-side de la cola de onboarding de
// productos (#4800 · "Alta de producto: crear el repo automáticamente o usar uno
// existente"). Ola "Cierre de gestión de producto nuevo".
//
// QUÉ RESUELVE
// ------------
// `product-control-request.js` (lado dashboard) sólo ENCOLA pedidos en
// `product-control/pendiente/` — por el invariante "el adaptador pide, el kernel
// ejecuta" (#4571 §5.1). Hasta este módulo NO existía consumidor: nadie drenaba la
// cola ni ejecutaba el efecto de lado (crear el repo). Este es ese consumidor.
//
// Por cada pedido `product_onboard_request`:
//   - provenance:'create'  → crea el repositorio (`gh repo create`, idempotente),
//                            completa la URL LIMPIA `https://github.com/<org>/<repo>`
//                            en el descriptor y registra el producto en `mode:'full'`.
//   - provenance:'existing'→ registra directo (la URL ya vino y `runBootstrap`
//                            verifica alcance real con `probeAccess`, CA-2).
//
// SEGURIDAD (mapeo OWASP del análisis de seguridad del issue)
//   [A03 Injection · DOMINANTE] `gh` se invoca SIEMPRE por `execFile` + array de
//     args, NUNCA `execSync`/`shell:true`. `create.name` se re-valida contra regex
//     y `create.org` contra allowlist ANTES de invocar (fail-closed).
//   [A01 Broken Access Control] Sólo se crea en orgs de la allowlist; org fuera de
//     ella ⇒ rechazo, sin invocar `gh`.
//   [A02/A05 Data Exposure] Visibilidad default `private` SIEMPRE; `public` sólo con
//     elección explícita del descriptor.
//   [A05/A07 Secrets] El token va SÓLO por env (`GH_TOKEN`/`GITHUB_TOKEN`), nunca en
//     args ni en el descriptor. La URL persistida es la forma limpia. stdout/stderr
//     de `gh` se redactan antes de loguear.
//   [Integridad de estado] Idempotencia (chequea existencia antes de crear) + manejo
//     de `422 name already exists`: nunca deja el producto "a medias".
//
// El módulo es un FACTORY autocontenido con TODO inyectable (fs, execFile, runBootstrap,
// tiempo), para test determinístico sin tocar red ni disco reales.
// =============================================================================

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const trace = require('./traceability');
const redact = require('./redact');
const descriptorLib = require('./project-descriptor');
const bootstrap = require('./project-bootstrap');
const repoProbe = require('./repo-probe');

const PIPELINE_DIR = path.join(trace.REPO_ROOT, '.pipeline');
const DEFAULT_QUEUE_DIR = path.join(PIPELINE_DIR, 'product-control', 'pendiente');
const DEFAULT_DONE_DIR = path.join(PIPELINE_DIR, 'product-control', 'procesado');

// Espeja los patrones del contrato (`repositories[].create`) + autoridad del schema
// de firmantes para `org`. La superficie de command-injection nace acá, así que se
// re-valida imperativamente antes de pasar cualquier dato a `gh`.
const REPO_NAME_RE = /^[A-Za-z0-9._-]{1,100}$/;
const ORG_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;

// Allowlist de orgs destino (A01). Congelada por default; overridable por deps para
// otros despliegues. La visibilidad pública NUNCA es default (A02/A05).
const DEFAULT_ALLOWED_ORGS = Object.freeze(['intrale']);

/**
 * Crea el drainer. Todo efecto de lado es inyectable (fail-closed y testeable).
 *
 * @param {object} [deps]
 * @param {object}   [deps.fsImpl]         impl de fs (default: node:fs).
 * @param {function} [deps.execFileSync]   ejecutor de `gh` (default: child_process).
 * @param {function} [deps.runBootstrap]   registro fail-closed (default: `runBootstrapAsync`
 *                                          de project-bootstrap — con `kernel.durable:false`
 *                                          se comporta idéntico al camino FS · CA-6).
 * @param {function} [deps.resolveContextProjectId] (#5204) resuelve el `contextProjectId`
 *                                          del alta a partir del descriptor YA validado.
 *                                          Default: la identidad del producto que se está
 *                                          creando (ver nota de CA-9 más abajo).
 * @param {object}   [deps.storeDriver]     driver durable a inyectar al write path.
 * @param {function} [deps.createStore]     factory de store durable (override de tests).
 * @param {string}   [deps.queueDir]       cola de pedidos (default: product-control/pendiente).
 * @param {string}   [deps.doneDir]        destino de procesados (default: product-control/procesado).
 * @param {string}   [deps.registryPath]   path del registry (pasado a runBootstrap).
 * @param {string[]} [deps.allowedOrgs]    allowlist de orgs destino.
 * @param {string}   [deps.githubHost]     host GitHub para la URL limpia (default: github.com).
 * @param {function} [deps.log]            logger de línea (default: no-op).
 * @param {function} [deps.onAlert]        callback de alerta (default: no-op).
 * @param {function} [deps.now]            fuente de tiempo ms (default: Date.now).
 * @returns {object} API del drainer.
 */
function createProductControlDrain(deps = {}) {
  const _fs = deps.fsImpl || fs;
  const exec = deps.execFileSync || execFileSync;
  // #5204 — el default pasa a ser el entry ASÍNCRONO. `runBootstrap` (sync) NUNCA
  // toma el write path durable: con `kernel.durable:true` el alta por este camino
  // se registraba sólo en filesystem y el producto no existía para el boot. Con
  // el flag OFF (default) `runBootstrapAsync` hace exactamente lo mismo que antes
  // (mismo registro FS, mismo shape de resultado · CA-6), así que la paridad se
  // mantiene. Un `runBootstrap` sync inyectado por tests sigue funcionando: el
  // resultado se `await`ea igual.
  const runBootstrap = typeof deps.runBootstrap === 'function' ? deps.runBootstrap : bootstrap.runBootstrapAsync;
  // #5204 · CA-9 — contexto de partición del alta. El alta la ejecuta el KERNEL
  // (control-plane) y su efecto es CREAR la partición del tenant nuevo: no existe
  // todavía una instancia con credencial propia de la cual derivarlo. Por eso el
  // default es la identidad del descriptor YA validado fail-closed (schema +
  // isSafeId + no reservado), y `durableRegisterProduct` vuelve a exigir que el
  // contexto coincida con esa identidad antes de escribir nada.
  //
  // La propiedad anti tenant-hopping se conserva donde importa: un caller que SÍ
  // tiene contexto propio (una instancia ya viva) lo inyecta por
  // `deps.resolveContextProjectId` y entonces un descriptor de otro tenant queda
  // rechazado por el propio write path.
  const resolveContextProjectId = typeof deps.resolveContextProjectId === 'function'
    ? deps.resolveContextProjectId
    : (d) => (d && d.identity && d.identity.projectId) || null;
  // Probe de alcance REAL (CA-2) para repos existentes-de-URL. Inyección explícita
  // least-privilege (alineado con la arquitectura de `repo-probe.js`); ya no se
  // delega a un auto-cableado por default de runBootstrap.
  const probeAccess = typeof deps.probeAccess === 'function' ? deps.probeAccess : repoProbe.probeAccess;
  const queueDir = deps.queueDir || DEFAULT_QUEUE_DIR;
  const doneDir = deps.doneDir || DEFAULT_DONE_DIR;
  const registryPath = deps.registryPath || undefined;
  const allowedOrgs = new Set((Array.isArray(deps.allowedOrgs) ? deps.allowedOrgs : DEFAULT_ALLOWED_ORGS)
    .map((o) => String(o).toLowerCase()));
  const githubHost = deps.githubHost || 'github.com';
  const log = typeof deps.log === 'function' ? deps.log : () => {};
  const onAlert = typeof deps.onAlert === 'function' ? deps.onAlert : () => {};
  const now = typeof deps.now === 'function' ? deps.now : () => Date.now();

  // ---- helpers gh (SIEMPRE por array de args · A03) --------------------------

  // Redacta cualquier salida de `gh` antes de loguear (el token podría aparecer en
  // una remote `x-access-token:<TOKEN>@...`). Nunca se loguea crudo (A05/A07).
  function safeGhMessage(err) {
    const raw = (err && (err.stderr || err.stdout || err.message)) || '';
    try { return String(redact.redactSecretValue(String(raw))).slice(0, 400); }
    catch { return 'gh error (redactado)'; }
  }

  // Idempotencia (A· integridad): existencia ANTES de crear. `gh repo view` con el
  // slug validado; el token va por env, nunca en args.
  function repoExists(org, name) {
    try {
      exec('gh', ['repo', 'view', `${org}/${name}`, '--json', 'name'], {
        env: process.env, stdio: ['ignore', 'ignore', 'ignore'], timeout: 15000,
      });
      return true;
    } catch { return false; }
  }

  // Creación real. `visibility` ya normalizada a 'private'|'public'. Devuelve
  // `{ created:boolean }`; distingue el `422 name already exists` como idempotente.
  function createRepo(org, name, visibility) {
    const visFlag = visibility === 'public' ? '--public' : '--private';
    try {
      exec('gh', ['repo', 'create', `${org}/${name}`, visFlag], {
        env: process.env, stdio: ['ignore', 'ignore', 'pipe'], timeout: 30000,
      });
      return { created: true };
    } catch (err) {
      const msg = safeGhMessage(err);
      if (/already exists|name already exists|HTTP 422/i.test(msg)) {
        return { created: false, alreadyExisted: true };
      }
      throw new Error(`gh repo create falló: ${msg}`);
    }
  }

  // ---- resolución de la modalidad create de un descriptor --------------------

  /**
   * Resuelve, sobre un descriptor YA validado, todas las entradas
   * `provenance:'create'` de `repositories`: crea el repo (idempotente, `gh`), completa
   * la URL LIMPIA y transforma la entrada a `provenance:'existing'` con `url`. MUTA
   * `descriptor.repositories` in place (el caller decide si clona antes).
   *
   * Es la unidad REUTILIZABLE que el drenador cableado al kernel
   * (`product-control-drainer.drainOnboardQueue`) invoca ANTES de `registerOnboarding`,
   * de modo que la creación del repo ocurra en el path REAL del kernel (#4800 · CA-1) y
   * no como código huérfano.
   *
   * Semántica de fallo (fail-closed, "nunca producto a medias"):
   *   - Spec inválida (name/org/allowlist) ⇒ devuelve `{ok:false, terminal:true, ...}`
   *     (reintentar no ayuda: el operador debe corregir el pedido).
   *   - Fallo real de `gh` (permiso/red) ⇒ LANZA (recuperable: el caller reintenta).
   *   - Sin entradas `create` ⇒ `{ok:true, repoOrigin:'existing', createdUrls:[]}` sin
   *     tocar `gh` (los descriptores `existing`/legacy pasan intactos).
   *
   * @param {object} descriptor  descriptor con `repositories`.
   * @returns {{ok:true, repoOrigin:string, createdUrls:string[]}|{ok:false, terminal:boolean, stage:string, reason:string}}
   */
  function resolveCreateRepos(descriptor) {
    const repos = Array.isArray(descriptor && descriptor.repositories) ? descriptor.repositories : [];
    let repoOrigin = 'existing';
    const createdUrls = [];

    for (const repo of repos) {
      if (!repo || repo.provenance !== 'create') continue;
      const spec = assertCreateSpec(repo);
      if (!spec.ok) {
        // Spec inválida ⇒ terminal (fail-closed, sin invocar gh).
        return { ok: false, terminal: true, stage: 'create-spec', reason: spec.reason };
      }
      // Idempotencia: si ya existe, no re-crear (evita `422` y doble efecto).
      let created = false;
      let alreadyExisted = false;
      if (repoExists(spec.org, spec.name)) {
        alreadyExisted = true;
      } else {
        const res = createRepo(spec.org, spec.name, spec.visibility); // LANZA ante fallo real.
        created = !!res.created;
        alreadyExisted = !!res.alreadyExisted;
      }
      // URL limpia — NUNCA la remote con `x-access-token:<TOKEN>@` (A05/A07).
      const cleanUrl = `https://${githubHost}/${spec.org}/${spec.name}`;
      // La forma `provenance:'create'` prohíbe url por contrato; tras la creación el
      // repo YA existe, así que la entrada queda como existente+url. El "cómo" (creado)
      // viaja aparte en `repoOrigin`.
      delete repo.create;
      repo.provenance = 'existing';
      repo.url = cleanUrl;
      createdUrls.push(cleanUrl);
      repoOrigin = alreadyExisted ? 'existing-preexisting' : 'created';
      log(`onboard: repo ${spec.org}/${spec.name} ${created ? 'creado' : 'ya existía'} (${spec.visibility})`);
    }

    return { ok: true, repoOrigin, createdUrls };
  }

  /**
   * Valida fail-closed los datos de creación de un repo `provenance:'create'`. No
   * invoca `gh` — sólo aserta que name/org/visibility son seguros antes de tocar red.
   * @returns {{ok:true, org, name, visibility}|{ok:false, reason}}
   */
  function assertCreateSpec(repo) {
    const c = repo && repo.create;
    if (!c || typeof c !== 'object') return { ok: false, reason: 'falta el subobjeto create' };
    const name = c.name;
    const org = typeof c.org === 'string' ? c.org : '';
    if (typeof name !== 'string' || !REPO_NAME_RE.test(name)) {
      return { ok: false, reason: `create.name inválido: ${JSON.stringify(name)}` };
    }
    if (!ORG_RE.test(org)) {
      return { ok: false, reason: `create.org inválido: ${JSON.stringify(org)}` };
    }
    if (!allowedOrgs.has(org.toLowerCase())) {
      return { ok: false, reason: `org fuera de la allowlist: ${org}` };
    }
    // Default `private` SIEMPRE; sólo 'public' explícito habilita público (A02/A05).
    const visibility = c.visibility === 'public' ? 'public' : 'private';
    return { ok: true, org, name, visibility };
  }

  /**
   * Procesa UN pedido de onboarding (objeto ya parseado). No lee ni mueve archivos:
   * es la unidad testeable pura. Devuelve el resultado del pedido.
   *
   * ASÍNCRONA desde #5204: el registro puede tomar el write path durable, que es
   * async. Con `kernel.durable:false` resuelve en el mismo tick lógico que antes.
   *
   * @param {object} request  `{ type:'product_onboard_request', descriptor, ... }`
   * @returns {Promise<{ok:boolean, projectId?:string, stage:string, created?:boolean, url?:string, reason?:string}>}
   */
  async function processOnboard(request) {
    if (!request || request.type !== 'product_onboard_request') {
      return { ok: false, stage: 'type', reason: 'pedido no es product_onboard_request' };
    }
    const descriptor = request.descriptor;
    if (!descriptor || typeof descriptor !== 'object' || Array.isArray(descriptor)) {
      return { ok: false, stage: 'descriptor', reason: 'descriptor ausente o inválido' };
    }

    // Revalidación fail-closed del descriptor (schema + provenance + SSRF etc).
    const validation = descriptorLib.validateDescriptor(descriptor);
    if (!validation.valid) {
      return { ok: false, stage: `validation:${validation.stage}`, reason: 'descriptor rechazado (fail-closed)', errors: validation.errors };
    }
    const valid = validation.descriptor;
    const projectId = valid.identity.projectId;

    // Clonar defensivamente el descriptor a registrar (no mutar el pedido en banda).
    const resolved = JSON.parse(JSON.stringify(valid));
    const repos = Array.isArray(resolved.repositories) ? resolved.repositories : [];

    // Creación de repos `provenance:'create'` (misma lógica que usa el drenador
    // cableado al kernel — ver `resolveCreateRepos`). Fail-closed: spec inválida ⇒
    // terminal; fallo real de `gh` ⇒ throw. En ambos casos NO se registra (Gherkin #2).
    let repoResult;
    try {
      repoResult = resolveCreateRepos(resolved);
    } catch (err) {
      onAlert({ projectId, stage: 'create-repo', errors: [{ detail: err.message }] });
      return { ok: false, stage: 'create-repo', projectId, reason: err.message };
    }
    if (!repoResult.ok) {
      onAlert({ projectId, stage: repoResult.stage, errors: [{ detail: repoResult.reason }] });
      return { ok: false, stage: repoResult.stage, projectId, reason: repoResult.reason };
    }
    const repoOrigin = repoResult.repoOrigin;
    const createdUrl = repoResult.createdUrls.length
      ? repoResult.createdUrls[repoResult.createdUrls.length - 1]
      : null;

    // Registro fail-closed en modo full. Para repos recién creados inyectamos un probe
    // que confirma alcance sin re-consultar red; para repos existentes-de-URL inyectamos
    // el probe REAL (`repo-probe.js`) que verifica alcance vía `gh repo view` (CA-2).
    let boot;
    try {
      const bootDeps = {};
      if (registryPath) bootDeps.registryPath = registryPath;
      if (createdUrl) {
        // El/los repos recién creados son alcanzables; no re-probar por red.
        bootDeps.probeAccess = (t) => (t && t.kind === 'repo' ? true : null);
      } else {
        // Camino "usar existente": alcance verificado por red (least-privilege).
        bootDeps.probeAccess = probeAccess;
      }
      // #5204 · defecto (a) — el write path durable exige `contextProjectId`
      // fail-closed. Sin propagarlo, un alta con `kernel.durable:true` moría en
      // `KernelStoreContextError` y ningún producto llegaba a registrarse.
      const contextProjectId = resolveContextProjectId(resolved);
      if (contextProjectId) bootDeps.contextProjectId = contextProjectId;
      // Cableado de persistencia. Se propaga SÓLO si el caller lo inyectó: con el
      // flag OFF no hace falta y con el flag ON su ausencia la corta el write path
      // (jamás escribe a un store efímero creyendo que persistió).
      if (deps.storeDriver) bootDeps.storeDriver = deps.storeDriver;
      if (typeof deps.createStore === 'function') bootDeps.createStore = deps.createStore;
      if (typeof deps.kernelDurable === 'boolean') bootDeps.kernelDurable = deps.kernelDurable;
      if (deps.kernelConfig && typeof deps.kernelConfig === 'object') bootDeps.kernelConfig = deps.kernelConfig;
      if (typeof deps.onAlert === 'function') bootDeps.onAlert = deps.onAlert;
      boot = await runBootstrap({
        descriptor: resolved,
        mode: 'full',
        registerMeta: { repoOrigin, repos: repos.map((r) => r && r.url).filter(Boolean) },
        deps: bootDeps,
      });
    } catch (err) {
      onAlert({ projectId, stage: 'register', errors: [{ detail: err.message }] });
      return { ok: false, stage: 'register', projectId, reason: `registro falló: ${err.message}`, url: createdUrl };
    }
    if (!boot || !boot.ok) {
      onAlert({ projectId, stage: 'register', errors: (boot && boot.errors) || [{ detail: 'bootstrap rechazó el registro' }] });
      return { ok: false, stage: boot ? boot.stage : 'register', projectId, reason: 'registro rechazado (fail-closed)', errors: boot && boot.errors, url: createdUrl };
    }

    return { ok: true, stage: 'registered', projectId, created: repoOrigin === 'created', repoOrigin, url: createdUrl || undefined };
  }

  // ---- drenado de la cola (lee/mueve archivos) -------------------------------

  /**
   * Drena la cola una vez: procesa cada `*.json` de `queueDir`, mueve el pedido a
   * `doneDir` con el resultado anexado. Aislado: un pedido corrupto no frena a los
   * demás. Devuelve el resumen `{ processed, results }`.
   *
   * ASÍNCRONA desde #5204 (arrastre de `processOnboard`, que puede tomar el write
   * path durable). El lifecycle de archivos no cambió: se procesa y se mueve uno
   * por uno, en orden, sin concurrencia.
   *
   * @returns {Promise<{processed:number, results:Array}>}
   */
  async function drainOnce() {
    let names = [];
    try {
      names = _fs.readdirSync(queueDir).filter((n) => n.endsWith('.json'));
    } catch (err) {
      if (err && err.code === 'ENOENT') return { processed: 0, results: [] };
      onAlert({ stage: 'drain', errors: [{ detail: `no se pudo leer la cola: ${err.message}` }] });
      return { processed: 0, results: [] };
    }

    const results = [];
    for (const name of names) {
      const src = path.join(queueDir, name);
      let request;
      try {
        request = JSON.parse(_fs.readFileSync(src, 'utf8'));
      } catch (err) {
        onAlert({ stage: 'drain-parse', errors: [{ detail: `pedido ilegible ${name}: ${err.message}` }] });
        results.push({ file: name, ok: false, stage: 'parse', reason: 'pedido ilegible' });
        moveToDone(src, name, { ok: false, stage: 'parse', reason: 'pedido ilegible' });
        continue;
      }
      // Sólo procesamos onboards acá; otros tipos (start/pause) los drena el kernel
      // de instancias — se dejan en la cola (no se mueven).
      if (!request || request.type !== 'product_onboard_request') {
        results.push({ file: name, ok: false, stage: 'skip', reason: 'no es onboard' });
        continue;
      }
      let res;
      try {
        res = await processOnboard(request);
      } catch (err) {
        res = { ok: false, stage: 'exception', reason: err.message };
        onAlert({ stage: 'drain-exception', errors: [{ detail: err.message }] });
      }
      results.push(Object.assign({ file: name }, res));
      moveToDone(src, name, res);
    }
    return { processed: results.length, results };
  }

  // Mueve el pedido a procesado (rename atómico; fallback copy+unlink). Anexa el
  // resultado REDACTADO como sidecar para trazabilidad, nunca el descriptor crudo.
  function moveToDone(src, name, result) {
    try { _fs.mkdirSync(doneDir, { recursive: true }); } catch { /* idempotente */ }
    const stamped = `${now()}-${name}`;
    const dest = path.join(doneDir, stamped);
    try {
      _fs.renameSync(src, dest);
    } catch (err) {
      // Fallback si rename cruza dispositivos: copiar y borrar.
      try {
        const data = _fs.readFileSync(src, 'utf8');
        _fs.writeFileSync(dest, data, 'utf8');
        _fs.unlinkSync(src);
      } catch (e2) {
        onAlert({ stage: 'drain-move', errors: [{ detail: `no se pudo mover ${name}: ${e2.message}` }] });
        return;
      }
    }
    try {
      const sidecar = redact.redactObject({ file: name, result, at: now() });
      _fs.writeFileSync(`${dest}.result.json`, JSON.stringify(sidecar), 'utf8');
    } catch { /* best-effort */ }
  }

  return {
    drainOnce,
    processOnboard,
    resolveCreateRepos,
    assertCreateSpec,
    // helpers expuestos para tests / verificación estática
    repoExists,
    createRepo,
  };
}

module.exports = {
  createProductControlDrain,
  DEFAULT_QUEUE_DIR,
  DEFAULT_DONE_DIR,
  DEFAULT_ALLOWED_ORGS,
  REPO_NAME_RE,
  ORG_RE,
};

// -----------------------------------------------------------------------------
// CLI: node .pipeline/lib/product-control-drain.js [--once]
//   Drena la cola una vez y sale (invocable por el loop del kernel o manualmente).
// -----------------------------------------------------------------------------
if (require.main === module) {
  const drain = createProductControlDrain({ log: (m) => process.stdout.write(m + '\n') });
  drain.drainOnce().then((summary) => {
    process.stdout.write(JSON.stringify({ processed: summary.processed, ok: summary.results.filter((r) => r.ok).length }, null, 2) + '\n');
    process.exit(0);
  }).catch((e) => {
    process.stderr.write(`error inesperado drenando la cola: ${e && e.message ? e.message : e}\n`);
    process.exit(1);
  });
}
