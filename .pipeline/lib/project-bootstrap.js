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

const descriptorLib = require('./project-descriptor');
// El store durable y su error de conflicto se cargan de forma perezosa (require
// dentro del path durable) para NO pagar el costo de Ajv/schema del kernel en el
// path FS por defecto (`kernel.durable:false`), que es el hot-path vigente.

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
// Verificación de acceso (paso 2). Side-effect-free por defecto: sólo valida la
// forma/host de las URLs. Un `deps.probeAccess` inyectable permite una prueba de
// alcance real (least-privilege) en producción, sin romper los tests.
// -----------------------------------------------------------------------------
function verifyAccess(descriptor, deps = {}) {
  const targets = [];
  for (const repo of descriptor.repositories || []) targets.push({ kind: 'repo', id: repo.id, url: repo.url });
  if (descriptor.board && descriptor.board.ref) targets.push({ kind: 'board', id: 'board', url: descriptor.board.ref });

  const results = [];
  let allOk = true;
  for (const t of targets) {
    const guard = assertUrlAllowed(t.url);
    let reachable = null;
    if (guard.allowed && typeof deps.probeAccess === 'function') {
      try { reachable = !!deps.probeAccess(t); } catch { reachable = false; }
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
  };
  fs.mkdirSync(path.dirname(registryPath), { recursive: true });
  fs.writeFileSync(registryPath, JSON.stringify(registry, null, 2) + '\n');
  return { backend: 'fs', registryPath, status: 'onboarding' };
}

// -----------------------------------------------------------------------------
// Write path DURABLE (#4821 · split 2/3 de #4804) — cutover bajo flag.
//
// Con `kernel.durable:true` el alta se persiste en el store del kernel (DynamoDB)
// vía `store.putProduct`, NUNCA con `fs.writeFileSync(registry.json)` (evita el
// split-brain FS↔DynamoDB para la misma fuente de verdad · CA-6/security#1). El
// flag se lee UNA sola vez al inicio de la operación (`runBootstrapDurable`), no
// mid-flow.
//
// Reglas de seguridad enforced acá:
//   - CA-9  · `contextProjectId` deriva de la credencial de la instancia
//            (`deps.contextProjectId` / store inyectado), JAMÁS del descriptor o
//            request del wizard (anti tenant-hopping).
//   - CA-10 · la validación (`validateDescriptor` + `maxItemBytes` + schema) la
//            impone `store.putProduct` ANTES de escribir; nunca `driver.putItem`
//            directo (security#6).
//   - CA-3  · el orden producto→catálogo lo garantiza el propio store; un fallo
//            del 2º paso deja un producto huérfano INVISIBLE a `listProducts`.
//   - CA-5 / CA-14 / CA-15 · el error al operador es accionable en español y NO
//            expone ARN / tableName / SK / partición (ver `mapDurableError`).
// -----------------------------------------------------------------------------

/**
 * Lee el flag de cutover `kernel.durable` UNA sola vez. Default `false`
 * (coexistencia: el FS actual no cambia · CA-6).
 * @param {object} [config]  objeto de config ya parseado ({ kernel:{ durable } } o plano).
 * @returns {boolean}
 */
function readDurableFlag(config) {
  const c = config && typeof config === 'object' ? config : {};
  const kernel = c.kernel && typeof c.kernel === 'object' ? c.kernel : c;
  return kernel.durable === true;
}

/**
 * Mapea un error del store a un mensaje accionable para el operador SIN fugas
 * técnicas (CA-5 / CA-14 / CA-15). El detalle crudo (que puede incluir SK /
 * tableName / partición) queda SÓLO en `internal`, para logs internos — nunca se
 * renderiza al operador.
 * @returns {{ code:string, operator:string, internal:string }}
 */
function mapDurableError(e) {
  const name = e && e.name ? String(e.name) : '';
  const internal = e && e.message ? String(e.message) : 'error desconocido';
  // Conflicto condicional (ConditionalCheckFailedException): fail-closed, el
  // estado NO quedó a medias (CA-5) — distinto de un fallo de infra genérico.
  if (name === 'ConditionalCheckFailedError' || name === 'ConditionalCheckFailedException') {
    return {
      code: 'conflict',
      operator: 'No se pudo completar el alta. El estado no quedó a medias; podés reintentar.',
      internal,
    };
  }
  // Rechazo de validación / aislamiento / tamaño del store: fail-closed, no se
  // escribió nada. Accionable pero sin exponer internals.
  if (name === 'KernelStoreValidationError' || name === 'KernelStoreIsolationError' || name === 'KernelStoreSizeError') {
    return {
      code: 'validation',
      operator: 'El alta no pasó las validaciones del store del kernel; revisá el descriptor y reintentá.',
      internal,
    };
  }
  // Fallo de infraestructura genérico (store no disponible, red, driver).
  return {
    code: 'infra',
    operator: 'El store del kernel no está disponible en este momento; el alta no se completó. Reintentá más tarde.',
    internal,
  };
}

/**
 * Registro DURABLE del producto (equivalente durable de `defaultRegisterProduct`).
 * Persiste SIEMPRE vía `store.putProduct` — nunca `driver.putItem` directo.
 *
 * @param {{projectId:string,name:string}} entry  identidad del producto (del descriptor validado).
 * @param {object} deps
 * @param {object} [deps.store]             store ya instanciado (tests / caller). Si falta se crea con `contextProjectId`.
 * @param {string} [deps.contextProjectId]  projectId de la instancia — DEBE derivar de la credencial (CA-9), nunca del descriptor.
 * @param {object} [deps.config]            config del kernel para `createKernelStore`.
 * @param {function} [deps.onAlert]         callback de alerta fail-closed del store.
 * @returns {Promise<{backend:'durable',status:'onboarding'}>}
 */
async function registerProductDurable(entry, deps = {}) {
  // CA-9 — el contexto de aislamiento NUNCA se deriva del payload entrante.
  // Sólo del store inyectado o de `deps.contextProjectId` (scope de credencial).
  let store = deps.store;
  if (!store) {
    const contextProjectId = deps.contextProjectId;
    if (!contextProjectId) {
      // Fail-closed: sin contexto de credencial no se puede escribir de forma
      // aislada. NO se cae a FS acá (eso lo decide el flag, arriba).
      const err = new Error('contextProjectId ausente: debe derivar de la credencial de la instancia (CA-9), nunca del descriptor del wizard');
      err.name = 'KernelStoreValidationError';
      throw err;
    }
    // require perezoso — sólo se paga en el path durable.
    const { createKernelStore } = require('./kernel-store');
    store = createKernelStore({
      contextProjectId,
      config: deps.config,
      onAlert: typeof deps.onAlert === 'function' ? deps.onAlert : undefined,
    });
  }
  // El body del producto espeja el registro FS (`{ status, name }`) pero como
  // entrada durable del catálogo. `store.putProduct` valida (schema + injection +
  // maxItemBytes) ANTES de escribir y ordena producto→catálogo (CA-3/CA-10).
  await store.putProduct({
    productId: entry.projectId,
    name: entry.name,
    status: 'onboarding',
  });
  // No se expone SK / tabla / partición al caller (CA-14/15).
  return { backend: 'durable', status: 'onboarding' };
}

/**
 * Orquesta el bootstrap completo. Fail-closed: aborta en el primer paso que falle.
 *
 * @param {object} args
 * @param {string} [args.descriptorPath]  path del descriptor (o pasar args.descriptor).
 * @param {object} [args.descriptor]      descriptor ya parseado (override).
 * @param {'dry-run'|'full'} [args.mode='dry-run']  'dry-run' NUNCA registra.
 * @param {object} [args.deps]  dependencias inyectables (probeAccess, discoverWork, registerProduct, registryPath, kernelGateFloor).
 * @returns {{ ok:boolean, stage:string, mode:string, ... }}
 */
function runBootstrap(args = {}) {
  const mode = args.mode === 'full' ? 'full' : 'dry-run';
  const deps = args.deps || {};

  // Paso 1 — validación fail-closed.
  const validation = args.descriptor
    ? descriptorLib.validateDescriptor(args.descriptor, { expectedChecksum: args.expectedChecksum })
    : descriptorLib.loadDescriptor(args.descriptorPath, { expectedChecksum: args.expectedChecksum });
  if (!validation.valid) {
    return { ok: false, stage: `validation:${validation.stage}`, mode, errors: validation.errors, human: renderHuman({ ok: false, stage: `validation:${validation.stage}`, errors: validation.errors }) };
  }
  const descriptor = validation.descriptor;

  // Gate de autoridad de firma (CA-D4): si signers vacío/inválido, bloquea.
  const sigGate = descriptorLib.resolveSignerAuthority(descriptor);
  if (sigGate.blocked) {
    return { ok: false, stage: 'signature-gate', mode, errors: [{ path: 'authority.signers', detail: sigGate.reason }], human: renderHuman({ ok: false, stage: 'signature-gate', errors: [{ detail: sigGate.reason }] }) };
  }

  // Paso 2 — verificación de acceso (SSRF allowlist).
  const access = verifyAccess(descriptor, deps);
  if (!access.ok) {
    const rejected = access.targets.filter((t) => !t.allowed || t.reachable === false);
    return { ok: false, stage: 'access', mode, access, errors: rejected.map((t) => ({ path: `${t.kind}:${t.id}`, detail: t.reason || 'no alcanzable' })), human: renderHuman({ ok: false, stage: 'access', access }) };
  }

  // Paso 3 — dry-run side-effect-free.
  const dry = dryRun(descriptor, deps);
  if (!dry.ok) {
    return { ok: false, stage: 'dry-run', mode, errors: [{ path: 'dry-run', detail: dry.reason }], human: renderHuman({ ok: false, stage: 'dry-run', errors: [{ detail: dry.reason }] }) };
  }

  if (mode === 'dry-run') {
    // NUNCA registra. Estado del producto no muta.
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

  // Paso 4 — registrar onboarding (INACTIVO) hasta OK humano.
  const register = typeof deps.registerProduct === 'function'
    ? deps.registerProduct({ projectId: descriptor.identity.projectId, name: descriptor.identity.name }, deps)
    : defaultRegisterProduct({ projectId: descriptor.identity.projectId, name: descriptor.identity.name }, deps);

  return {
    ok: true,
    stage: 'registered',
    mode,
    status: 'onboarding',
    projectId: descriptor.identity.projectId,
    access,
    dryRun: dry,
    register,
    human: renderHuman({ ok: true, stage: 'registered', projectId: descriptor.identity.projectId, status: 'onboarding', access, dryRun: dry }),
  };
}

/**
 * Orquesta el bootstrap con soporte de cutover DURABLE (#4821). Async porque el
 * write path durable (`store.putProduct`) es async.
 *
 * El flag `kernel.durable` se lee UNA sola vez al inicio (CA-6/security#1):
 *   - `false` (default) ⇒ delega en el `runBootstrap` SÍNCRONO (FS intacto — cero
 *     regresión de coexistencia). Nunca toca el store.
 *   - `true`            ⇒ reusa TODAS las validaciones side-effect-free de
 *     `runBootstrap` en dry-run (schema + SSRF + gate de firma + dry-run) y, si el
 *     modo es 'full', persiste el alta vía `registerProductDurable`
 *     (`store.putProduct`). NUNCA combina `fs.readFileSync(registry.json)` +
 *     `store.putProduct` en el mismo path (anti split-brain).
 *
 * Devuelve el MISMO shape error-as-data que `runBootstrap`.
 *
 * @param {object} args  igual que `runBootstrap`, más:
 * @param {object} [args.config]            config del kernel (para leer el flag y crear el store).
 * @param {string} [args.contextProjectId]  contexto de credencial de la instancia (CA-9).
 * @param {object} [args.store]             store inyectado (tests).
 * @param {function} [args.onAlert]         callback de alerta del store.
 * @returns {Promise<object>}
 */
async function runBootstrapDurable(args = {}) {
  const durable = readDurableFlag(args.config); // leído UNA vez (CA-6/security#1)
  const mode = args.mode === 'full' ? 'full' : 'dry-run';

  if (!durable) {
    // Coexistencia (CA-6): comportamiento FS actual, sin tocar el store.
    return runBootstrap(args);
  }

  // Modo durable: reusar TODAS las validaciones side-effect-free (dry-run) de
  // runBootstrap — no se duplica el gate de schema/SSRF/firma.
  const pre = runBootstrap({ ...args, mode: 'dry-run' });
  if (!pre.ok) return pre;               // validación/acceso/dry-run falló → surface tal cual
  if (mode !== 'full') return pre;       // dry-run: nada que registrar (sin efectos)

  // El descriptor ya validó en `pre`; recuperarlo (side-effect-free) para el alta.
  const validation = args.descriptor
    ? descriptorLib.validateDescriptor(args.descriptor, { expectedChecksum: args.expectedChecksum })
    : descriptorLib.loadDescriptor(args.descriptorPath, { expectedChecksum: args.expectedChecksum });
  const descriptor = validation.descriptor;
  const entry = { projectId: descriptor.identity.projectId, name: descriptor.identity.name };

  try {
    // Permite inyectar un registrador durable async (paridad con deps.registerProduct).
    const register = typeof args.deps === 'object' && typeof args.deps.registerProductDurable === 'function'
      ? await args.deps.registerProductDurable(entry, args)
      : await registerProductDurable(entry, {
          store: args.store,
          contextProjectId: args.contextProjectId,
          config: args.config,
          onAlert: args.onAlert,
        });
    return {
      ok: true,
      stage: 'registered',
      mode,
      status: 'onboarding',
      backend: 'durable',
      projectId: entry.projectId,
      access: pre.access,
      dryRun: pre.dryRun,
      register,
      human: renderHuman({ ok: true, stage: 'registered', projectId: entry.projectId, status: 'onboarding', backend: 'durable', access: pre.access, dryRun: pre.dryRun }),
    };
  } catch (e) {
    // CA-4/CA-5/CA-14/15 — fail-closed, error accionable sin fugas técnicas.
    const mapped = mapDurableError(e);
    return {
      ok: false,
      stage: 'register:durable',
      mode,
      backend: 'durable',
      projectId: entry.projectId,
      errorCode: mapped.code,
      internal: mapped.internal, // sólo para logs internos — renderHuman NO lo imprime
      errors: [{ path: 'register', detail: mapped.operator }],
      human: renderHuman({ ok: false, stage: 'register:durable', errors: [{ detail: mapped.operator }] }),
    };
  }
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
    lines.push(`   ruteo resuelto: ${(res.dryRun.resolvedRouting || []).map((r) => `${r.label}→${r.capability}[${r.skills.join('/')}]`).join(', ') || '(ninguno)'}`);
    lines.push(`   signers: ${(res.dryRun.signers || []).join(', ')}`);
    lines.push(`   gates: gate0=${res.dryRun.gates.gate0} gate2=${res.dryRun.gates.gate2} visual=${res.dryRun.gates.visual}`);
  }
  if (res.status === 'onboarding') {
    // UX G2 (#4821): diferenciar el backend que respondió — durable confirma
    // persistencia en el store del kernel; FS mantiene el copy vigente.
    if (res.backend === 'durable') {
      lines.push(`   producto ${res.projectId} persistido de forma durable en el store del kernel — estado ONBOARDING (inactivo), pendiente de aprobación humana para activarse`);
    } else {
      lines.push(`   producto ${res.projectId} registrado en estado ONBOARDING (inactivo) — pendiente de aprobación humana para activarse`);
    }
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
  verifyAccess,
  dryRun,
  runBootstrap,
  runBootstrapDurable,
  registerProductDurable,
  defaultRegisterProduct,
  readDurableFlag,
  mapDurableError,
  renderHuman,
  DEFAULT_REGISTRY_PATH,
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
  const res = runBootstrap({ descriptorPath, mode });
  if (flags.has('--json')) {
    // El resultado JSON no contiene secretos (redacción por diseño).
    process.stdout.write(JSON.stringify({ ...res, human: undefined }, null, 2) + '\n');
  } else {
    process.stdout.write(res.human + '\n');
  }
  process.exit(res.ok ? 0 : 1);
}
