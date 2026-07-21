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
 * @param {function} [deps.runBootstrap]   registro fail-closed (default: project-bootstrap).
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
  const runBootstrap = typeof deps.runBootstrap === 'function' ? deps.runBootstrap : bootstrap.runBootstrap;
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
   * @param {object} request  `{ type:'product_onboard_request', descriptor, ... }`
   * @returns {{ok:boolean, projectId?:string, stage:string, created?:boolean, url?:string, reason?:string}}
   */
  function processOnboard(request) {
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

    let repoOrigin = 'existing';
    let createdUrl = null;

    for (const repo of repos) {
      if (!repo || repo.provenance !== 'create') continue;
      const spec = assertCreateSpec(repo);
      if (!spec.ok) {
        onAlert({ projectId, stage: 'create-spec', errors: [{ detail: spec.reason }] });
        return { ok: false, stage: 'create-spec', projectId, reason: spec.reason };
      }
      // Idempotencia: si ya existe, no re-crear (evita `422` y doble efecto).
      let created = false;
      let alreadyExisted = false;
      try {
        if (repoExists(spec.org, spec.name)) {
          alreadyExisted = true;
        } else {
          const res = createRepo(spec.org, spec.name, spec.visibility);
          created = !!res.created;
          alreadyExisted = !!res.alreadyExisted;
        }
      } catch (err) {
        // Fallo de creación: NO dejar el producto a medias. Se reporta y se aborta
        // sin registrar descriptor con URL vacía (CA-4 / Gherkin #2).
        onAlert({ projectId, stage: 'create-repo', errors: [{ detail: err.message }] });
        return { ok: false, stage: 'create-repo', projectId, reason: err.message };
      }

      // URL limpia — NUNCA la remote con `x-access-token:<TOKEN>@` (A05/A07).
      createdUrl = `https://${githubHost}/${spec.org}/${spec.name}`;
      // Transformar la entrada a existente+url: tras la creación, el repo YA existe.
      // La forma `provenance:'create'` prohíbe url por contrato; el registro final es
      // un descriptor existente válido, y el "cómo" (creado) va al registry (repoOrigin).
      delete repo.create;
      repo.provenance = 'existing';
      repo.url = createdUrl;
      repoOrigin = alreadyExisted ? 'existing-preexisting' : 'created';
      log(`onboard ${projectId}: repo ${spec.org}/${spec.name} ${created ? 'creado' : 'ya existía'} (${spec.visibility})`);
    }

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
      boot = runBootstrap({
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
   */
  function drainOnce() {
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
        res = processOnboard(request);
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
  const summary = drain.drainOnce();
  process.stdout.write(JSON.stringify({ processed: summary.processed, ok: summary.results.filter((r) => r.ok).length }, null, 2) + '\n');
  process.exit(0);
}
