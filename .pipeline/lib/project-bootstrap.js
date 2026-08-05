'use strict';

// =============================================================================
// project-bootstrap.js — Bootstrap de un proyecto nuevo (Ola Puente P2 · #4687)
//
// Orquesta el alta de un producto por CLI/API programático (el wizard visual se
// difiere a P6 · recorte R1):
//
//   1. Validar el descriptor (fail-closed, project-descriptor.js).
//   2. Verificar acceso a repos/tablero — allowlist de host anti-SSRF (CA-D3).
//   3. Dry-run: descubrir trabajo SIN ejecutar, side-effect-free (CA-D2).
//   4. Registrar el producto como `status:onboarding` (INACTIVO) hasta OK humano
//      (CA-D1) — sólo en modo 'full', jamás durante el dry-run.
//
// El dry-run (paso 3) NO escribe, NO crea worktrees, NO muta estado ni cuota
// (requisito de seguridad #10). Secretos SIEMPRE redactados en output y logs
// (CA-C3). Output dual humano + máquina para que P6 lo reutilice (guideline UX G4).
// =============================================================================

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const descriptorLib = require('./project-descriptor');
// #5204 — partición del control-plane (catálogo global que enumera el boot). Se
// toma de la MISMA autoridad que decide los ids reservados: nunca un literal local.
const { CONTROL_PLANE_PROJECT_ID } = descriptorLib;

// -----------------------------------------------------------------------------
// SSRF (CA-D3 · requisito de seguridad #4). `repositories[].url` y `board.ref`
// son URLs a las que el kernel se conecta. Se validan contra una allowlist de
// host; se rechazan IPs internas/loopback/link-local y hosts fuera de la lista —
// un descriptor hostil no puede usar la verificación de acceso para escanear la
// red interna.
// -----------------------------------------------------------------------------
const ALLOWED_HOSTS = Object.freeze(new Set([
  'github.com',
  'api.github.com',
  'www.github.com',
]));

// Rangos privados / loopback / link-local / metadata — rechazo explícito aunque
// alguien allowlistee un host que resuelva a estos (defensa de forma, no de DNS).
function isIpLiteral(host) {
  // IPv4
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return true;
  // IPv6 (con o sin brackets)
  if (host.includes(':')) return true;
  return false;
}

function isPrivateOrLoopbackHost(host) {
  const h = String(host || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (h === '::1' || h === '0:0:0:0:0:0:0:1') return true;
  // IPv6 unique-local (fc00::/7) y link-local (fe80::/10)
  if (h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe8') || h.startsWith('fe9') || h.startsWith('fea') || h.startsWith('feb')) {
    if (h.includes(':')) return true;
  }
  // IPv4 literals
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (a === 127) return true;            // loopback
    if (a === 10) return true;             // 10.0.0.0/8
    if (a === 0) return true;              // 0.0.0.0/8
    if (a === 169 && b === 254) return true; // link-local / metadata 169.254.0.0/16
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 192 && b === 168) return true; // 192.168.0.0/16
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64.0.0/10
  }
  return false;
}

/**
 * Valida que una URL sea alcanzable de forma segura (host allowlisted, no IP
 * interna). NO hace la conexión — es un guard de forma anti-SSRF.
 * @returns {{ allowed:boolean, reason:string, host:string|null }}
 */
function assertUrlAllowed(rawUrl) {
  let u;
  try {
    u = new URL(String(rawUrl));
  } catch (e) {
    return { allowed: false, reason: 'URL malformada', host: null };
  }
  if (u.protocol !== 'https:') return { allowed: false, reason: `esquema no permitido: ${u.protocol} (sólo https)`, host: u.hostname };
  // SEC-6 · Credenciales embebidas (user:pass@host) prohibidas: los secretos van
  // SOLO por referencia (SEC-4), nunca crudos en la URL del descriptor (donde
  // quedarían persistidos en la cola/logs). Rechazo fail-closed.
  if (u.username || u.password) {
    return { allowed: false, reason: 'credenciales embebidas en URL no permitidas (SEC-6): usar secreto por referencia', host: u.hostname.toLowerCase() };
  }
  const host = u.hostname.toLowerCase();
  if (isIpLiteral(host)) {
    // IP literal — sólo se permite si NO es privada/loopback Y está allowlisted (nunca lo está por default).
    if (isPrivateOrLoopbackHost(host) || !ALLOWED_HOSTS.has(host)) {
      return { allowed: false, reason: `IP literal no permitida (SSRF): ${host}`, host };
    }
  }
  if (isPrivateOrLoopbackHost(host)) return { allowed: false, reason: `host interno/loopback no permitido (SSRF): ${host}`, host };
  if (!ALLOWED_HOSTS.has(host)) return { allowed: false, reason: `host fuera de la allowlist: ${host}`, host };
  return { allowed: true, reason: '', host };
}

// -----------------------------------------------------------------------------
// Parseo de `owner/repo` desde una URL GitHub YA validada por `assertUrlAllowed`
// (#4800 · CA-2 / SEC-6 · A10). Se extrae el slug de la ruta (ambos segmentos
// contra regex estricta) para invocar `gh repo view <owner/repo>` — NUNCA se hace
// `fetch` crudo de la URL provista ni se siguen redirects.
// -----------------------------------------------------------------------------
function parseOwnerRepo(rawUrl) {
  let u;
  try { u = new URL(String(rawUrl)); } catch { return null; }
  const parts = u.pathname.replace(/^\/+/, '').replace(/\.git$/, '').split('/').filter(Boolean);
  if (parts.length < 2) return null;
  const [owner, repo] = parts;
  if (!/^[A-Za-z0-9._-]{1,39}$/.test(owner)) return null;
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(repo)) return null;
  return `${owner}/${repo}`;
}

/**
 * Probe de accesibilidad REAL de un repo (#4800 · CA-2). Corre `gh repo view
 * <owner/repo> --json name` con el slug parseado de la URL ya allowlisted. El token
 * viaja SÓLO por env (`GH_TOKEN`/`GITHUB_TOKEN` heredados de `process.env`), nunca en
 * los args (anti command-injection: la invocación es por array). Devuelve:
 *   - `true`  si el repo existe y es accesible.
 *   - `false` si `gh` falla (inexistente / sin permiso).
 *   - `null`  si el target no es un repo probeable (board o slug no parseable) ⇒
 *             se trata como "no probado" (accesible por forma).
 *
 * @param {{kind:string, url:string}} target
 * @param {object} [deps]  { execFileSync } inyectable para tests.
 * @returns {boolean|null}
 */
function defaultProbeAccess(target, deps = {}) {
  if (!target || target.kind !== 'repo') return null;
  const slug = parseOwnerRepo(target.url);
  if (!slug) return null;
  const exec = deps.execFileSync || execFileSync;
  try {
    exec('gh', ['repo', 'view', slug, '--json', 'name'], {
      env: process.env,               // token SÓLO por env; jamás en args (A03)
      stdio: ['ignore', 'ignore', 'ignore'],
      timeout: 15000,
    });
    return true;
  } catch {
    return false;                     // inexistente / sin permiso ⇒ no alcanzable (CA-2)
  }
}

// -----------------------------------------------------------------------------
// Verificación de acceso (paso 2). Valida la forma/host de las URLs (allowlist
// anti-SSRF) y, si se provee `deps.probeAccess`, prueba el alcance real. Los repos
// con `provenance:'create'` se SALTEAN: aún no existen, no hay URL que verificar
// (#4800). Un probe que devuelve `null`/`undefined` = "no probado" ⇒ accesible por
// forma; sólo `false` explícito marca inaccesible (CA-2).
// -----------------------------------------------------------------------------
function verifyAccess(descriptor, deps = {}) {
  const targets = [];
  for (const repo of descriptor.repositories || []) {
    // #4800 — un repo a crear no tiene URL todavía: no se prueba acceso.
    if (repo && repo.provenance === 'create') continue;
    targets.push({ kind: 'repo', id: repo.id, url: repo.url });
  }
  if (descriptor.board && descriptor.board.ref) targets.push({ kind: 'board', id: 'board', url: descriptor.board.ref });

  const results = [];
  let allOk = true;
  for (const t of targets) {
    const guard = assertUrlAllowed(t.url);
    let reachable = null;
    if (guard.allowed && typeof deps.probeAccess === 'function') {
      try {
        const p = deps.probeAccess(t);
        reachable = (p === null || p === undefined) ? null : !!p;
      } catch { reachable = false; }
    }
    const ok = guard.allowed && (reachable === null ? true : reachable);
    if (!ok) allOk = false;
    results.push({ kind: t.kind, id: t.id, host: guard.host, allowed: guard.allowed, reachable, reason: guard.reason });
  }
  return { ok: allOk, targets: results };
}

// -----------------------------------------------------------------------------
// Dry-run (paso 3): descubre trabajo del tablero SIN ejecutar. Side-effect-free
// (CA-D2 · requisito #10): NO escribe, NO worktrees, NO muta estado ni cuota.
// El descubrimiento real se inyecta por `deps.discoverWork`; el default deriva un
// resumen del propio descriptor (ruteo resuelto contra la allowlist de skills),
// sin tocar la red ni el filesystem.
// -----------------------------------------------------------------------------
function dryRun(descriptor, deps = {}) {
  const routing = descriptorLib.deriveRouting(descriptor);
  const partitions = descriptorLib.deriveCapabilityPartitions(descriptor);

  // Ruteo resuelto: label → capability → skills (validados contra allowlist).
  const resolvedRouting = [];
  for (const [label, capability] of routing.entries()) {
    const skills = partitions[capability] || [];
    const safeSkills = skills.filter((s) => descriptorLib.KERNEL_SKILLS.has(s));
    resolvedRouting.push({ label, capability, skills: safeSkills });
  }

  let discovered = [];
  if (typeof deps.discoverWork === 'function') {
    // El discover inyectado DEBE ser side-effect-free (contrato del caller).
    try {
      const out = deps.discoverWork({ descriptor, resolvedRouting });
      if (Array.isArray(out)) discovered = out;
    } catch (e) {
      return { ok: false, reason: `discoverWork falló: ${e.message}`, resolvedRouting, discovered: [] };
    }
  }

  return {
    ok: true,
    sideEffects: false,
    admissionLabels: descriptorLib.deriveAdmissionLabels(descriptor),
    providerOrder: descriptorLib.deriveProviderOrder(descriptor),
    pullRequestPolicy: descriptorLib.derivePullRequestPolicy(descriptor),
    resolvedRouting,
    signers: descriptorLib.resolveSignerAuthority(descriptor).signers,
    gates: {
      gate0: descriptorLib.resolveGate(descriptor, 'gate0', { kernelFloor: deps.kernelGateFloor }),
      gate2: descriptorLib.resolveGate(descriptor, 'gate2', { kernelFloor: deps.kernelGateFloor }),
      visual: descriptorLib.resolveGate(descriptor, 'visual', { kernelFloor: deps.kernelGateFloor }),
    },
    discovered,
  };
}

// -----------------------------------------------------------------------------
// Registro del producto (paso 4, sólo modo 'full'). Escribe `status:onboarding`
// (INACTIVO) hasta OK humano. Inyectable por `deps.registerProduct` para tests.
// -----------------------------------------------------------------------------
const DEFAULT_REGISTRY_PATH = path.resolve(__dirname, '..', 'descriptors', 'registry.json');

function defaultRegisterProduct(entry, deps = {}) {
  const registryPath = deps.registryPath || DEFAULT_REGISTRY_PATH;
  let registry = {};
  try {
    registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
  } catch { registry = {}; }
  if (!registry || typeof registry !== 'object') registry = {};
  if (!registry.products || typeof registry.products !== 'object') registry.products = {};
  registry.products[entry.projectId] = {
    status: 'onboarding',
    name: entry.name,
    registeredWith: 'project-bootstrap',
    // #4800 — campos opcionales aditivos: cómo quedó asociado el repo (creado por el
    // kernel vs existente). Ausentes en el flujo legacy ⇒ retro-compat.
    ...(entry.repoOrigin ? { repoOrigin: entry.repoOrigin } : {}),
    ...(entry.repos ? { repos: entry.repos } : {}),
  };
  fs.mkdirSync(path.dirname(registryPath), { recursive: true });
  fs.writeFileSync(registryPath, JSON.stringify(registry, null, 2) + '\n');
  return { registryPath, status: 'onboarding' };
}

// -----------------------------------------------------------------------------
// Flag de cutover `kernel.durable` (#4821 · CA-6). Se lee UNA SOLA VEZ por
// operación al inicio del registro (nunca mid-flow) para evitar split-brain
// FS↔DynamoDB. Inyectable por tests vía `deps.kernelConfig` / `deps.kernelDurable`.
//
// #5172 — La lectura y la validación pasan por el punto único
// (`lib/config-resolver`). El `catch { durable:false }` que había acá era
// EXACTAMENTE el fail-open que la historia viene a matar: convertía *"no pude
// leer la config"* en *"el cutover durable está apagado"*, indistinguible de una
// decisión deliberada del operador. Ahora el error tipado
// (`ConfigParseViolation` / `ConfigSchemaViolation`, ya redactado por el
// resolver) se PROPAGA: si la autoridad de la decisión no se puede leer, no hay
// decisión.
//
// Lo que NO cambia (D-4): un config VÁLIDO **sin sección `kernel:`** no es
// corrupción — es la sección opcional sin declarar ⇒ se conserva el default
// seguro `durable:false`. Distinguir "no pude leer" de "la sección no está" es
// el corazón del issue.
//
// `deps.configPath` sigue siendo el punto de inyección por firma y se mapea a
// `resolve({configPath})` (ruta de ARCHIVO explícita). Sin él se usa la
// `config.yaml` de este checkout, igual que antes: la resolución NO pasa a
// depender de env vars, para no cambiar de archivo en silencio.
// -----------------------------------------------------------------------------
const DEFAULT_CONFIG_PATH = path.resolve(__dirname, '..', 'config.yaml');

function readKernelConfig(deps = {}) {
  if (deps.kernelConfig && typeof deps.kernelConfig === 'object') {
    return { durable: deps.kernelConfig.durable === true, tableName: deps.kernelConfig.tableName ?? null, region: deps.kernelConfig.region ?? null };
  }
  if (typeof deps.kernelDurable === 'boolean') {
    return { durable: deps.kernelDurable, tableName: null, region: null };
  }
  // Lazy-require deliberado (G-3): el resolver arrastra `js-yaml` + `ajv`, y
  // este módulo se carga también desde contextos sin `node_modules`.
  const configResolver = require('./config-resolver');
  const cfg = configResolver.resolve({ configPath: deps.configPath || DEFAULT_CONFIG_PATH });
  const k = (cfg.kernel && typeof cfg.kernel === 'object') ? cfg.kernel : {};
  return { durable: k.durable === true, tableName: k.tableName ?? null, region: k.region ?? null };
}

// -----------------------------------------------------------------------------
// Sanitización de errores al operador (#4821 · CA-5 / CA-14 / CA-15). El mensaje
// visible NUNCA expone ARN / tableName / SK / partición: sólo un texto accionable
// en español. `ConditionalCheckFailedException` (o condición de escritura fallida)
// se distingue como "el estado NO quedó a medias" (CA-5), separado de un fallo de
// infra genérico. El detalle técnico crudo queda para logs internos, jamás en la
// respuesta al operador.
// -----------------------------------------------------------------------------
function classifyStoreError(err) {
  const name = err && err.name ? String(err.name) : '';
  const msg = err && err.message ? String(err.message) : '';
  if (name === 'ConditionalCheckFailedError' || /ConditionalCheckFailed/i.test(name + ' ' + msg)) {
    return 'conditional';
  }
  if (name === 'KernelStoreValidationError' || name === 'KernelStoreIsolationError' || name === 'KernelStoreSizeError') {
    return 'validation';
  }
  return 'infra';
}

function sanitizeOperatorError(err) {
  const cls = classifyStoreError(err);
  if (cls === 'conditional' || cls === 'validation') {
    // CA-5: condición de escritura / validación fail-closed ⇒ el alta no quedó a
    // medias. Nada persistió de forma visible; el operador puede reintentar.
    return { class: cls, operatorMessage: 'No se pudo completar el alta: el estado NO quedó a medias. Revisá los datos e intentá de nuevo.' };
  }
  // CA-14/15: fallo de infra ⇒ mensaje genérico, sin exponer detalle técnico.
  return { class: 'infra', operatorMessage: 'No se pudo completar el alta por un problema temporal del almacenamiento. Volvé a intentar en unos minutos.' };
}

// -----------------------------------------------------------------------------
// Registro DURABLE del producto (#4821 · write path). Persiste vía la API pública
// del kernel-store — SIEMPRE por `putProduct` (nunca `driver.putItem` directo).
//
// Orden de escritura (CA-3, fail-safe): `putProduct` primero (interna: producto →
// catálogo; si el 2º paso `addToCatalog` falla, el producto queda huérfano
// INVISIBLE a `listProducts`), y `putDescriptor` al final. Así un fallo parcial
// NUNCA deja un `descriptor#self` huérfano indexado. `putDescriptor`/`putProduct`
// reejecutan la validación fail-closed (CA-10: `validateDescriptor` antes de
// persistir; A04 `maxItemBytes`).
//
// CA-9 (anti tenant-hopping): `contextProjectId` DEBE derivar de la credencial de
// la instancia (inyectado por el caller), NUNCA del descriptor/request del wizard.
// El store valida `item.projectId === contextProjectId` como defensa en profundidad.
//
// #5204 — DOS PARTICIONES, NO UNA. El alta escribe TRES entidades y NO todas viven
// en el mismo namespace:
//
//   `product#<id>` + `catalog#index` → partición del CONTROL-PLANE. Es el índice
//       GLOBAL que enumera `kernel-supervisor.bootProducts()` vía su `catalogStore`
//       (construido con `CONTROL_PLANE_PROJECT_ID`). Escribirlos en la partición
//       del tenant los volvía INVISIBLES para el boot: `listProducts()` devolvía
//       `[]` y no se instanciaba ningún pipeline (defecto (b) del issue).
//   `descriptor#self` → partición del TENANT. Es el estado propio del producto y
//       el boot lo lee por instancia (`ctx.store.getDescriptor`), ligado al
//       `contextProjectId` de ESE tenant. Ahí se queda.
//
// El aislamiento por tenant NO se relaja: el descriptor se sigue escribiendo con un
// store ligado al `contextProjectId` de la credencial, y `putDescriptor` reejecuta
// `assertSameProject`. Además este write path exige explícitamente que el contexto
// coincida con la identidad del descriptor ANTES de tocar el control-plane, de modo
// que un contexto ajeno no puede inyectar entradas en el catálogo global.
// -----------------------------------------------------------------------------
async function durableRegisterProduct(entry, descriptor, deps = {}) {
  // CA-9: el contexto de tenant proviene de la credencial de la instancia, no del
  // payload. Fail-closed si el caller no lo inyectó (no se deriva del descriptor).
  const contextProjectId = deps.contextProjectId;
  if (!contextProjectId) {
    throw new KernelStoreContextError('contextProjectId ausente: debe derivar de la credencial de la instancia (CA-9), nunca del descriptor');
  }
  // #5204 · A01 — el control-plane NO es un tenant: nadie da de alta un producto
  // "dentro" de la partición del kernel. Se corta antes de construir ningún store.
  if (descriptorLib.isReservedProjectId(contextProjectId)) {
    throw new KernelStoreContextError('contextProjectId reservado: la partición del control-plane no puede darse de alta como producto');
  }
  // #5204 · CA-9 explícito en el write path. El store ya rechaza escribir la
  // partición de otro (`assertSameProject`), pero esa defensa recién actúa en
  // `putDescriptor` — y el catálogo GLOBAL se escribe antes. Sin este corte, un
  // contexto que no es el del producto podía dejar una entrada en el catálogo del
  // control-plane y recién después fallar. Se valida ANTES de cualquier escritura.
  const descriptorProjectId = descriptor && descriptor.identity && descriptor.identity.projectId;
  if (descriptorProjectId !== contextProjectId) {
    throw new KernelStoreContextError('contextProjectId no coincide con la identidad del descriptor (anti tenant-hopping · CA-9)');
  }
  if (entry && entry.projectId !== contextProjectId) {
    throw new KernelStoreContextError('el producto a registrar no pertenece al contexto de la instancia (anti tenant-hopping · CA-9)');
  }
  // #5204 — sin cableado de persistencia real un alta "durable" escribiría a un
  // store en memoria que muere con el proceso: alta OK para el operador, producto
  // inexistente para el boot. Fail-closed antes que fail-silent.
  if (typeof deps.createStore !== 'function' && !deps.storeDriver) {
    throw new KernelStoreContextError('alta durable sin store inyectado: el caller debe proveer createStore o storeDriver');
  }
  const kernelCfg = deps.kernelConfig || readKernelConfig(deps);
  const factory = typeof deps.createStore === 'function'
    ? deps.createStore
    : require('./kernel-store').createKernelStore;
  const storeConfig = { kernel: { tableName: kernelCfg.tableName, region: kernelCfg.region } };
  const buildStore = (ctx, allowedNamespaces) => factory({
    contextProjectId: ctx,
    allowedNamespaces,
    config: storeConfig,
    driver: deps.storeDriver,
    onAlert: deps.onAlert,
  });

  // Partición del tenant: SÓLO el descriptor#self del producto.
  const tenantStore = buildStore(contextProjectId);
  // Partición del control-plane: producto + catálogo global (lo que lee el boot).
  const controlStore = buildStore(CONTROL_PLANE_PROJECT_ID, [CONTROL_PLANE_PROJECT_ID]);

  // CA-10: validación explícita antes de persistir (además de la que reejecuta el
  // store). Fail-closed: si el descriptor no valida, no se escribe nada.
  const dres = descriptorLib.validateDescriptor(descriptor);
  if (!dres.valid) {
    throw new KernelStoreContextError(`descriptor inválido antes de persistir (CA-10): ${dres.stage}`);
  }

  // Unicidad autoritativa (paridad con el camino FS, que rechaza `duplicate`): un
  // alta NUNCA pisa el descriptor de un producto ya registrado.
  const already = await tenantStore.getDescriptor(contextProjectId);
  if (already) {
    throw new KernelStoreContextError('el producto ya está registrado: el alta no sobreescribe su descriptor');
  }

  // CA-3: producto + catálogo primero (atómico interno, orden fail-safe); el
  // descriptor#self se escribe al final para no dejar huérfanos indexados.
  const put = await controlStore.putProduct({ productId: entry.projectId, name: entry.name, status: 'onboarding' });
  await tenantStore.putDescriptor(descriptor);
  return {
    status: 'onboarding',
    durable: true,
    sk: put.sk,
    contextProjectId,
    // Partición donde quedó indexado el producto: la MISMA que enumera el boot.
    catalogProjectId: CONTROL_PLANE_PROJECT_ID,
  };
}

// Error interno del write path durable (no expone detalle al operador).
class KernelStoreContextError extends Error {
  constructor(message) { super(message); this.name = 'KernelStoreContextError'; }
}

// -----------------------------------------------------------------------------
// Pipeline pre-registro compartido (validación → firma → acceso → dry-run).
// Devuelve `{ error }` con el resultado fail-closed, o el contexto para registrar.
// -----------------------------------------------------------------------------
function prepareBootstrap(args = {}) {
  const mode = args.mode === 'full' ? 'full' : 'dry-run';
  const deps = args.deps || {};

  // Paso 1 — validación fail-closed.
  const validation = args.descriptor
    ? descriptorLib.validateDescriptor(args.descriptor, { expectedChecksum: args.expectedChecksum })
    : descriptorLib.loadDescriptor(args.descriptorPath, { expectedChecksum: args.expectedChecksum });
  if (!validation.valid) {
    return { error: { ok: false, stage: `validation:${validation.stage}`, mode, errors: validation.errors, human: renderHuman({ ok: false, stage: `validation:${validation.stage}`, errors: validation.errors }) } };
  }
  const descriptor = validation.descriptor;

  // Gate de autoridad de firma (CA-D4): si signers vacío/inválido, bloquea.
  const sigGate = descriptorLib.resolveSignerAuthority(descriptor);
  if (sigGate.blocked) {
    return { error: { ok: false, stage: 'signature-gate', mode, errors: [{ path: 'authority.signers', detail: sigGate.reason }], human: renderHuman({ ok: false, stage: 'signature-gate', errors: [{ detail: sigGate.reason }] }) } };
  }

  // Paso 2 — verificación de acceso (SSRF allowlist). El probe de alcance REAL
  // (CA-2 · #4800) NO se auto-cablea acá: los callers kernel-side (product-control-*)
  // inyectan `deps.probeAccess` explícitamente (least-privilege, vía `repo-probe.js`).
  // Sin probe inyectado, `reachable` queda null y se trata como no-probado (accesible).
  const access = verifyAccess(descriptor, deps);
  if (!access.ok) {
    const rejected = access.targets.filter((t) => !t.allowed || t.reachable === false);
    return { error: { ok: false, stage: 'access', mode, access, errors: rejected.map((t) => ({ path: `${t.kind}:${t.id}`, detail: t.reason || 'no alcanzable' })), human: renderHuman({ ok: false, stage: 'access', access }) } };
  }

  // Paso 3 — dry-run side-effect-free.
  const dry = dryRun(descriptor, deps);
  if (!dry.ok) {
    return { error: { ok: false, stage: 'dry-run', mode, errors: [{ path: 'dry-run', detail: dry.reason }], human: renderHuman({ ok: false, stage: 'dry-run', errors: [{ detail: dry.reason }] }) } };
  }

  return { descriptor, access, dry, mode, deps };
}

function dryRunResult(descriptor, access, dry, mode) {
  return {
    ok: true,
    stage: 'dry-run',
    mode,
    sideEffects: false,
    projectId: descriptor.identity.projectId,
    access,
    dryRun: dry,
    human: renderHuman({ ok: true, stage: 'dry-run', projectId: descriptor.identity.projectId, access, dryRun: dry }),
  };
}

function registeredResult(descriptor, access, dry, mode, register, durable) {
  return {
    ok: true,
    stage: 'registered',
    mode,
    status: 'onboarding',
    durable: !!durable,
    projectId: descriptor.identity.projectId,
    access,
    dryRun: dry,
    register,
    human: renderHuman({ ok: true, stage: 'registered', projectId: descriptor.identity.projectId, status: 'onboarding', access, dryRun: dry }),
  };
}

/**
 * Orquesta el bootstrap completo (SÍNCRONO · camino FS). Fail-closed: aborta en el
 * primer paso que falle. Este entry point NO ejecuta el write path durable (que es
 * async): con `kernel.durable:false` (default) el comportamiento FS no cambia
 * (CA-6). Para el alta durable usar `runBootstrapAsync`.
 *
 * @param {object} args
 * @param {string} [args.descriptorPath]  path del descriptor (o pasar args.descriptor).
 * @param {object} [args.descriptor]      descriptor ya parseado (override).
 * @param {'dry-run'|'full'} [args.mode='dry-run']  'dry-run' NUNCA registra.
 * @param {object} [args.deps]  dependencias inyectables (probeAccess, discoverWork, registerProduct, registryPath, kernelGateFloor).
 * @returns {{ ok:boolean, stage:string, mode:string, ... }}
 */
function runBootstrap(args = {}) {
  const prep = prepareBootstrap(args);
  if (prep.error) return prep.error;
  const { descriptor, access, dry, mode, deps } = prep;

  if (mode === 'dry-run') return dryRunResult(descriptor, access, dry, mode);

  // Paso 4 — registrar onboarding (INACTIVO) hasta OK humano. Camino FS.
  // `args.registerMeta` (#4800) permite al drainer reflejar cómo quedó asociado el
  // repo (creado vs existente) sin filtrar secretos.
  const entry = Object.assign(
    { projectId: descriptor.identity.projectId, name: descriptor.identity.name },
    (args.registerMeta && typeof args.registerMeta === 'object') ? args.registerMeta : {},
  );
  const register = typeof deps.registerProduct === 'function'
    ? deps.registerProduct(entry, deps)
    : defaultRegisterProduct(entry, deps);

  return registeredResult(descriptor, access, dry, mode, register, false);
}

/**
 * Variante ASÍNCRONA del bootstrap (#4821). Idéntica a `runBootstrap` salvo que
 * el paso 4 puede tomar el WRITE PATH DURABLE cuando `kernel.durable` está ON.
 *
 * El flag se lee UNA SOLA VEZ al inicio del registro (CA-6): no se re-consulta
 * mid-flow, evitando split-brain FS↔DynamoDB. Con el flag OFF (default) delega en
 * el mismo registro FS que `runBootstrap`. Con el flag ON persiste vía el
 * kernel-store (`putProduct` + `putDescriptor`) con errores sanitizados al
 * operador (CA-5/14/15) y `contextProjectId` derivado de la credencial (CA-9).
 *
 * @returns {Promise<{ ok:boolean, stage:string, mode:string, ... }>}
 */
async function runBootstrapAsync(args = {}) {
  const prep = prepareBootstrap(args);
  if (prep.error) return prep.error;
  const { descriptor, access, dry, mode, deps } = prep;

  if (mode === 'dry-run') return dryRunResult(descriptor, access, dry, mode);

  // CA-6: el flag de cutover se evalúa UNA sola vez, al inicio de la operación.
  const kernelCfg = readKernelConfig(deps);
  // `args.registerMeta` (#4800): refleja cómo quedó asociado el repo (creado vs
  // existente) sin filtrar secretos; aplica tanto al camino durable como al FS.
  const entry = Object.assign(
    { projectId: descriptor.identity.projectId, name: descriptor.identity.name },
    (args.registerMeta && typeof args.registerMeta === 'object') ? args.registerMeta : {},
  );

  if (kernelCfg.durable) {
    try {
      const register = await durableRegisterProduct(entry, descriptor, { ...deps, kernelConfig: kernelCfg });
      return registeredResult(descriptor, access, dry, mode, register, true);
    } catch (err) {
      // CA-4: fail-closed — el alta no queda a medias y se reporta al operador.
      // CA-14/15: mensaje accionable sin ARN/tabla/SK; el detalle técnico va a logs.
      const op = sanitizeOperatorError(err);
      const errors = [{ path: 'store', detail: op.operatorMessage }];
      return {
        ok: false,
        stage: 'register-durable',
        mode,
        durable: true,
        errorClass: op.class,
        errors,
        // detalle técnico crudo SOLO para logs internos, nunca en `human`.
        _internalError: err && err.message ? String(err.message) : String(err),
        human: renderHuman({ ok: false, stage: 'register-durable', errors }),
      };
    }
  }

  // Flag OFF (default) — mismo registro FS que el camino síncrono (CA-6: FS sin cambios).
  const register = typeof deps.registerProduct === 'function'
    ? deps.registerProduct(entry, deps)
    : defaultRegisterProduct(entry, deps);
  return registeredResult(descriptor, access, dry, mode, register, false);
}

// -----------------------------------------------------------------------------
// Render humano (guideline UX G1/G2/G3). Secretos redactados por diseño: el
// resultado NUNCA contiene valores de credenciales resueltas.
// -----------------------------------------------------------------------------
function renderHuman(res) {
  const lines = [];
  if (!res.ok) {
    lines.push(`❌ bootstrap RECHAZADO en la etapa: ${res.stage}`);
    for (const e of res.errors || []) lines.push(`   · ${e.path ? e.path + ': ' : ''}${e.detail}`);
    if (res.access) {
      for (const t of res.access.targets || []) {
        lines.push(`   · ${t.kind} ${t.id}: ${t.allowed ? 'host OK' : '✗ ' + t.reason}`);
      }
    }
    return lines.join('\n');
  }
  lines.push(`✅ bootstrap OK (${res.stage}) — producto ${res.projectId}`);
  if (res.access) {
    for (const t of res.access.targets || []) {
      const mark = t.allowed && t.reachable !== false ? '✓' : '✗';
      lines.push(`   ${mark} ${t.kind} ${t.id} (${t.host})`);
    }
  }
  if (res.dryRun) {
    lines.push(`   labels de admisión: ${(res.dryRun.admissionLabels || []).join(', ') || '(ninguno)'}`);
    lines.push(`   providers: ${(res.dryRun.providerOrder || []).join(', ') || '(ninguno)'}`);
    lines.push(`   política de PR: ${res.dryRun.pullRequestPolicy || '(no declarada)'}`);
    lines.push(`   ruteo resuelto: ${(res.dryRun.resolvedRouting || []).map((r) => `${r.label}→${r.capability}[${r.skills.join('/')}]`).join(', ') || '(ninguno)'}`);
    lines.push(`   signers: ${(res.dryRun.signers || []).join(', ')}`);
    lines.push(`   gates: gate0=${res.dryRun.gates.gate0} gate2=${res.dryRun.gates.gate2} visual=${res.dryRun.gates.visual}`);
  }
  if (res.status === 'onboarding') {
    lines.push(`   producto ${res.projectId} registrado en estado ONBOARDING (inactivo) — pendiente de aprobación humana para activarse`);
  } else {
    lines.push(`   (dry-run: no se registró el producto — sin efectos de lado)`);
  }
  return lines.join('\n');
}

module.exports = {
  ALLOWED_HOSTS,
  assertUrlAllowed,
  isPrivateOrLoopbackHost,
  isIpLiteral,
  parseOwnerRepo,
  defaultProbeAccess,
  verifyAccess,
  dryRun,
  runBootstrap,
  runBootstrapAsync,
  durableRegisterProduct,
  readKernelConfig,
  sanitizeOperatorError,
  classifyStoreError,
  renderHuman,
  DEFAULT_REGISTRY_PATH,
  DEFAULT_CONFIG_PATH,
};

// -----------------------------------------------------------------------------
// CLI: node .pipeline/lib/project-bootstrap.js <descriptor.json> [--full] [--json]
//   default = dry-run (side-effect-free). --full registra onboarding.
// -----------------------------------------------------------------------------
if (require.main === module) {
  const argv = process.argv.slice(2);
  const flags = new Set(argv.filter((a) => a.startsWith('--')));
  const positional = argv.filter((a) => !a.startsWith('--'));
  const descriptorPath = positional[0];
  if (!descriptorPath) {
    process.stderr.write('uso: node .pipeline/lib/project-bootstrap.js <descriptor.json> [--full] [--json]\n');
    process.exit(2);
  }
  const mode = flags.has('--full') ? 'full' : 'dry-run';
  // Usa el entry async para respetar el flag `kernel.durable` (CA-6). Con el flag
  // OFF (default) el resultado es idéntico al camino FS síncrono.
  runBootstrapAsync({ descriptorPath, mode }).then((res) => {
    if (flags.has('--json')) {
      // El resultado JSON no contiene secretos (redacción por diseño); el detalle
      // técnico interno del write path durable no se emite al operador.
      process.stdout.write(JSON.stringify({ ...res, human: undefined, _internalError: undefined }, null, 2) + '\n');
    } else {
      process.stdout.write(res.human + '\n');
    }
    process.exit(res.ok ? 0 : 1);
  }).catch((e) => {
    process.stderr.write(`error inesperado: ${e && e.message ? e.message : e}\n`);
    process.exit(1);
  });
}
