'use strict';

// =============================================================================
// product-control-drain.js — Consumidor kernel-side de la cola de onboarding de
// productos (Ola "Cierre de gestión de producto nuevo" · #4800).
//
// QUÉ RESUELVE
// ------------
// `product-control-request.enqueueOnboard()` (lado dashboard/adaptador) sólo ENCOLA
// un pedido en `product-control/pendiente/`. Por el invariante "el adaptador pide,
// el kernel ejecuta" (#4571 §5.1) NADIE drenaba esa cola: este módulo es el brazo
// kernel-side que la consume.
//
// Para cada `product_onboard_request`:
//   - `provenance:'create'` → crea el repositorio (`gh repo create`, idempotente),
//     setea la base ref por defecto (best-effort) y completa la URL LIMPIA en el
//     descriptor sin intervención manual (CA-1), luego registra el producto en
//     `mode:'full'` (status onboarding, inactivo hasta OK humano).
//   - `provenance:'existing'` → valida acceso REAL al repo (probeAccess vía
//     `gh repo view`, CA-2) y registra igual en `mode:'full'`.
//
// SEGURIDAD
// ---------
// [A03 Injection] `gh` se invoca SIEMPRE con `execFile`/array de args — NUNCA
//   `execSync` con interpolación ni `shell:true`. `name`/`org` se validan contra
//   regex estricta + allowlist ANTES de invocar (fail-closed).
// [A01 authz] La creación sólo puede apuntar a orgs de `REPO_CREATE_ORG_ALLOWLIST`.
// [A02/A05 exposición] Visibilidad `private` por default SIEMPRE; `public` sólo con
//   elección explícita en el descriptor.
// [secrets] El token del pipeline viaja SÓLO por env (`GH_TOKEN`/`GITHUB_TOKEN`);
//   nunca se persiste en el descriptor/registry ni se loguea; stdout/stderr de `gh`
//   se redacta antes de cualquier log.
// [estado consistente] Idempotencia (chequeo de existencia antes de crear + manejo
//   de "name already exists"); ante fallo el pedido va a `error/` con motivo, NUNCA
//   se deja un producto "a medias" con URL vacía.
// =============================================================================

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const trace = require('./traceability');
const descriptorLib = require('./project-descriptor');
const bootstrap = require('./project-bootstrap');

const PIPELINE_DIR = path.join(trace.REPO_ROOT, '.pipeline');
const DEFAULT_QUEUE_DIR = path.join(PIPELINE_DIR, 'product-control', 'pendiente');
const DEFAULT_DONE_DIR = path.join(PIPELINE_DIR, 'product-control', 'procesado');
const DEFAULT_ERROR_DIR = path.join(PIPELINE_DIR, 'product-control', 'error');

// Redacción defensiva de la salida de `gh` antes de loguear: nunca dejar un token
// (patrones ghp_/gho_/github_pat_/x-access-token:...) escapar a un log.
function redactGhOutput(s) {
  return String(s == null ? '' : s)
    .replace(/gh[opsu]_[A-Za-z0-9]{20,}/g, '[REDACTED_TOKEN]')
    .replace(/github_pat_[A-Za-z0-9_]{20,}/g, '[REDACTED_TOKEN]')
    .replace(/x-access-token:[^@\s]+/gi, 'x-access-token:[REDACTED]');
}

// Ambiente hijo para `gh`: hereda el env (donde vive GH_TOKEN por least-privilege),
// sin inyectar el token en ningún string de comando.
function childEnv(deps) {
  return deps && deps.env ? deps.env : process.env;
}

function runGh(args, deps) {
  const runner = typeof deps.execFile === 'function' ? deps.execFile : execFileSync;
  // SIEMPRE array de args + sin shell (A03). El token NUNCA se interpola: va por env.
  return runner('gh', args, { env: childEnv(deps), stdio: 'pipe', timeout: 30000 });
}

/**
 * ¿Existe ya el repo `org/name`? Idempotencia anti doble-creación. `gh repo view`
 * por array de args; cualquier fallo (inexistente / sin acceso) ⇒ false.
 */
function repoExists(org, name, deps = {}) {
  try {
    runGh(['repo', 'view', `${org}/${name}`, '--json', 'name'], deps);
    return true;
  } catch {
    return false;
  }
}

/**
 * Crea (idempotente) el repositorio `org/name`. Fail-closed: valida name/org ANTES
 * de invocar `gh`. Default `private`. Maneja "name already exists" como éxito
 * idempotente. Devuelve la URL LIMPIA + metadatos.
 *
 * @returns {{ url:string, created:boolean, existed:boolean, visibility:string }}
 * @throws {Error} si name/org son inválidos o la creación falla por otra causa.
 */
function createRepo(spec, deps = {}) {
  const name = spec && spec.name;
  const org = spec && spec.org;
  // Fail-closed ANTES de tocar `gh` (A03/A01).
  if (typeof name !== 'string' || !descriptorLib.REPO_NAME_RE.test(name)) {
    throw new Error('nombre de repo inválido (fail-closed antes de gh repo create)');
  }
  if (typeof org !== 'string' || !descriptorLib.REPO_CREATE_ORG_ALLOWLIST.has(org)) {
    throw new Error('org destino fuera de la allowlist de creación (A01)');
  }
  // A02/A05 — private por default SIEMPRE; public sólo con elección explícita.
  const visibility = spec.visibility === 'public' ? 'public' : 'private';
  const url = `https://github.com/${org}/${name}`;

  // Idempotencia: si ya existe, no se crea de nuevo.
  if (repoExists(org, name, deps)) {
    return { url, created: false, existed: true, visibility };
  }

  try {
    runGh(['repo', 'create', `${org}/${name}`, `--${visibility}`, '--disable-issues=false'], deps);
    return { url, created: true, existed: false, visibility };
  } catch (e) {
    // 422 "Name already exists on this account" ⇒ carrera/idempotencia, no es fallo.
    const msg = redactGhOutput((e && (e.stderr || e.message)) || '');
    if (/already exists/i.test(msg)) {
      return { url, created: false, existed: true, visibility };
    }
    throw new Error(`gh repo create falló: ${msg || 'error desconocido'}`);
  }
}

// Best-effort: setear la default branch del repo recién creado. No es fatal (un repo
// vacío no tiene ramas hasta el primer push); se registra pero nunca aborta el alta.
function setDefaultBranch(org, name, baseRef, deps = {}) {
  if (typeof baseRef !== 'string' || baseRef.trim() === '') return { ok: false, skipped: true };
  try {
    runGh(['repo', 'edit', `${org}/${name}`, '--default-branch', baseRef], deps);
    return { ok: true, skipped: false };
  } catch {
    return { ok: false, skipped: false };
  }
}

/**
 * Transforma un repo `provenance:'create'` (ya creado) en su forma `existing` con la
 * URL limpia, para que el descriptor a registrar sea schema-válido. Conserva id/role/
 * defaultBaseRef; elimina el subobjeto `create`.
 */
function resolveCreatedRepo(repo, url) {
  const out = { id: repo.id, url, provenance: 'existing' };
  if (repo.role) out.role = repo.role;
  if (repo.defaultBaseRef) out.defaultBaseRef = repo.defaultBaseRef;
  return out;
}

/**
 * Procesa UN pedido de onboard ya parseado. Ejecuta creación de repos (si aplica),
 * arma el descriptor resuelto y lo registra en `mode:'full'`. Devuelve un resultado
 * como DATO (nunca lanza hacia el loop del kernel).
 *
 * @param {object} record  contenido del pedido encolado.
 * @param {object} [deps]  { execFile, env, runBootstrap, registerProduct, registryPath }
 */
function processOnboardRequest(record, deps = {}) {
  if (!record || record.type !== 'product_onboard_request') {
    return { ok: false, reason: 'pedido no es un product_onboard_request' };
  }
  const descriptor = record.descriptor;
  if (!descriptor || typeof descriptor !== 'object' || Array.isArray(descriptor)) {
    return { ok: false, reason: 'descriptor ausente o inválido en el pedido' };
  }

  // Defensa-en-profundidad: revalidar el descriptor recibido (fail-closed) antes de
  // crear nada. Un pedido con provenance inválida no debe llegar a `gh repo create`.
  const validation = descriptorLib.validateDescriptor(descriptor);
  if (!validation.valid) {
    return { ok: false, reason: `descriptor rechazado (${validation.stage})`, errors: validation.errors };
  }

  // Clonar para no mutar el pedido original.
  const resolved = JSON.parse(JSON.stringify(validation.descriptor));
  const repos = resolved.repositories || [];
  const created = [];
  try {
    for (let i = 0; i < repos.length; i++) {
      const repo = repos[i];
      if (descriptorLib.repoProvenance(repo) !== 'create') continue;
      const spec = repo.create || {};
      const res = createRepo({ name: spec.name, org: spec.org, visibility: spec.visibility }, deps);
      setDefaultBranch(spec.org, spec.name, repo.defaultBaseRef, deps);
      repos[i] = resolveCreatedRepo(repo, res.url);
      created.push({ id: repo.id, org: spec.org, name: spec.name, url: res.url, created: res.created, existed: res.existed, visibility: res.visibility });
    }
  } catch (e) {
    // Fallo de creación ⇒ NO se registra el producto (nunca "a medias").
    return { ok: false, reason: redactGhOutput(e.message), created };
  }

  // Registrar en mode:'full'. Probe real por default (CA-2): repos existentes deben
  // ser alcanzables; los recién creados ya existen y pasan.
  const runBootstrap = typeof deps.runBootstrap === 'function' ? deps.runBootstrap : bootstrap.runBootstrap;
  const bootDeps = {
    kernelGateFloor: 'enforce',
    probeAccess: typeof deps.probeAccess === 'function'
      ? deps.probeAccess
      : (t) => bootstrap.defaultProbeAccess(t, deps),
  };
  if (typeof deps.registerProduct === 'function') bootDeps.registerProduct = deps.registerProduct;
  if (deps.registryPath) bootDeps.registryPath = deps.registryPath;

  let boot;
  try {
    boot = runBootstrap({ descriptor: resolved, mode: 'full', deps: bootDeps });
  } catch (e) {
    return { ok: false, reason: `registro falló: ${redactGhOutput(e.message)}`, created };
  }
  if (!boot || !boot.ok) {
    return { ok: false, reason: `bootstrap full rechazó el alta (${boot ? boot.stage : 'desconocido'})`, stage: boot && boot.stage, errors: boot && boot.errors, created };
  }

  return {
    ok: true,
    projectId: boot.projectId,
    status: boot.status || 'onboarding',
    created,
    resolvedDescriptor: resolved,
  };
}

/**
 * Drena la cola `product-control/pendiente/`: procesa cada pedido de onboard, mueve
 * los OK a `procesado/` y los fallidos a `error/` (con motivo redactado adjunto).
 * Los pedidos de control (start/pause) NO son responsabilidad de este drainer.
 *
 * @param {object} [deps]  { queueDir, doneDir, errorDir, fsImpl, ...processDeps }
 * @returns {{ processed:number, ok:number, failed:number, results:Array }}
 */
function drainOnboardQueue(deps = {}) {
  const _fs = deps.fsImpl || fs;
  const queueDir = deps.queueDir || DEFAULT_QUEUE_DIR;
  const doneDir = deps.doneDir || DEFAULT_DONE_DIR;
  const errorDir = deps.errorDir || DEFAULT_ERROR_DIR;

  let entries = [];
  try {
    entries = _fs.readdirSync(queueDir).filter((f) => f.endsWith('.json'));
  } catch {
    return { processed: 0, ok: 0, failed: 0, results: [] };
  }

  const results = [];
  let ok = 0;
  let failed = 0;
  for (const file of entries) {
    const src = path.join(queueDir, file);
    let record;
    try {
      record = JSON.parse(_fs.readFileSync(src, 'utf8'));
    } catch (e) {
      moveFile(_fs, src, path.join(errorDir, file), { reason: 'pedido ilegible/JSON inválido' });
      failed++;
      results.push({ file, ok: false, reason: 'JSON inválido' });
      continue;
    }
    // Sólo procesamos altas acá; otros tipos se dejan para su propio consumidor.
    if (!record || record.type !== 'product_onboard_request') {
      results.push({ file, ok: false, skipped: true, reason: 'no es product_onboard_request' });
      continue;
    }

    const res = processOnboardRequest(record, deps);
    if (res.ok) {
      moveFile(_fs, src, path.join(doneDir, file), null);
      ok++;
    } else {
      moveFile(_fs, src, path.join(errorDir, file), { reason: res.reason, errors: res.errors });
      failed++;
    }
    results.push(Object.assign({ file }, res));
  }

  return { processed: results.length, ok, failed, results };
}

// Mueve un archivo dejando (opcionalmente) un `.reason.json` al lado en destino.
function moveFile(_fs, src, dst, meta) {
  try {
    _fs.mkdirSync(path.dirname(dst), { recursive: true });
  } catch { /* idempotente */ }
  try {
    _fs.renameSync(src, dst);
  } catch {
    // Fallback cross-device: copiar + borrar.
    try {
      const data = _fs.readFileSync(src);
      _fs.writeFileSync(dst, data);
      _fs.unlinkSync(src);
    } catch { /* best-effort */ }
  }
  if (meta) {
    try {
      _fs.writeFileSync(dst.replace(/\.json$/, '.reason.json'), JSON.stringify(meta, null, 2));
    } catch { /* best-effort */ }
  }
}

module.exports = {
  drainOnboardQueue,
  processOnboardRequest,
  createRepo,
  repoExists,
  setDefaultBranch,
  resolveCreatedRepo,
  redactGhOutput,
  DEFAULT_QUEUE_DIR,
  DEFAULT_DONE_DIR,
  DEFAULT_ERROR_DIR,
};
