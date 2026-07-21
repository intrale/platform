'use strict';

// =============================================================================
// project-descriptor.js — Loader + validador del descriptor de proyecto
// (Ola Puente P2 · #4687)
//
// El descriptor es una SUPERFICIE DE CONFIANZA NUEVA: config no confiable que el
// kernel lee, valida e interpreta para orquestar N productos (secretos, repos y
// autoridad de firma distintos) en la misma máquina. Todo acá es fail-closed.
//
// Espeja el patrón de `dev-contract.js`: Ajv({allErrors:true}), compile(schema),
// errores redactados, detección de prompt-injection sobre campos no confiables.
//
// Orden de validación fail-closed (CA-B3, abortando al PRIMER fallo):
//   1. Compat de schemaVersion  → migración / rechazo (project-descriptor-migrations)
//   2. Integridad / checksum     → sha256 del descriptor vs registrado (supply-chain)
//   3. JSON Schema (Ajv)         → additionalProperties:false, requeridos, patrones
//   4. Sanitización de paths     → anti path-traversal ANTES de usar como workspace
//
// Resolución `capability → skill` (CA-B1, CRÍTICO): SIEMPRE contra la allowlist
// fija `KERNEL_SKILLS`. JAMÁS `require()`/import dinámico de un path del descriptor.
// =============================================================================

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Ajv = require('ajv');

const { detectInjection } = require('./handoff');
const migrations = require('./project-descriptor-migrations');

const SCHEMA_PATH = path.resolve(__dirname, '..', 'contracts', 'project.schema.json');
const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8'));
const ajv = new Ajv({ allErrors: true, verbose: false });
const validateSchema = ajv.compile(schema);

// -----------------------------------------------------------------------------
// Allowlist fija de skills del kernel (CA-B1 · requisito de seguridad #1).
// Sumar un skill acá = otorgarle confianza de ejecución. NUNCA se resuelve un
// skill cargando código desde un path del descriptor.
// -----------------------------------------------------------------------------
const KERNEL_SKILLS = Object.freeze(new Set([
  'backend-dev',
  'android-dev',
  'web-dev',
  'pipeline-dev',
  'dev',
]));

// Interfaces (capabilities) reconocidas por el kernel.
const KERNEL_INTERFACES = Object.freeze(new Set(['backend', 'frontend', 'pipeline', 'generic']));

// Gates que el kernel entiende. Valor efectivo se resuelve fail-closed (CA-D5).
const GATE_NAMES = Object.freeze(['gate0', 'gate2', 'visual']);
const KNOWN_GATE_MODES = Object.freeze(new Set(['enforce', 'dry-run']));

// Campos de texto NO confiables sobre los que corre el detector de prompt-injection.
function collectInjectionHits(descriptor) {
  const identity = descriptor && descriptor.identity;
  const candidates = [
    ['identity.name', identity && identity.name],
    ['identity.description', identity && identity.description],
  ];
  const board = descriptor && descriptor.board;
  if (board && Array.isArray(board.admissionLabels)) {
    board.admissionLabels.forEach((l, i) => candidates.push([`board.admissionLabels[${i}]`, l]));
  }
  const hits = [];
  for (const [label, value] of candidates) {
    if (typeof value !== 'string' || value === '') continue;
    const res = detectInjection(value);
    if (res.hits.length > 0) hits.push({ path: label, hits: res.hits });
  }
  return hits;
}

function redactAjvErrors(ajvErrors) {
  if (!Array.isArray(ajvErrors)) return [];
  return ajvErrors.map((error) => {
    const pathLabel = error.instancePath || '(root)';
    const params = error.params || {};
    let detail = error.message || error.keyword;
    if (error.keyword === 'required') detail = `falta clave requerida: ${params.missingProperty}`;
    if (error.keyword === 'additionalProperties') detail = `campo no declarado en el esquema: ${params.additionalProperty}`;
    if (error.keyword === 'enum') detail = 'valor fuera del enum permitido';
    if (error.keyword === 'pattern') detail = 'valor fuera del patrón esperado (referencia/id inválido)';
    if (error.keyword === 'minItems') detail = 'la lista no puede estar vacía';
    return { path: pathLabel, keyword: error.keyword, detail };
  });
}

// -----------------------------------------------------------------------------
// Sanitización anti path-traversal (paso 4). El schema ya restringe projectId y
// repositories[].id a `^[a-z0-9][a-z0-9-]{1,63}$`, pero re-verificamos como
// defensa-en-profundidad ANTES de que cualquier caller use estos ids como base
// de workspace/estado (requisito #2 · A01).
// -----------------------------------------------------------------------------
const SAFE_ID_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;

function isSafeId(id) {
  if (typeof id !== 'string') return false;
  if (!SAFE_ID_RE.test(id)) return false;
  if (id.includes('..') || id.includes('/') || id.includes('\\')) return false;
  return true;
}

// Root ficticio para el prefix-check de rutas de worktree (nunca se toca el FS).
const WORKTREE_PREFIX_ROOT = path.resolve(path.sep + '__kernel_worktree_root__');

/**
 * Valida una ruta RELATIVA de worktree del descriptor (CA-7 · requisito #2 · A01/A03).
 *
 * A diferencia de `isSafeId` (ids atómicos), el worktree puede ser un subpath
 * relativo namespaceado. Rechaza fail-closed cualquier intento de escape:
 *   - vacío / no-string
 *   - byte NUL
 *   - `~` (expansión de home)
 *   - `..` (traversal)
 *   - absoluto POSIX (`/…`, `\…`) o Windows (`C:\…`, UNC)
 *   - que al resolver escape del root permitido (defensa contra escape textual/symlink).
 *
 * @param {string} p
 * @returns {boolean} true si la ruta es segura para usarse como base de worktree.
 */
function isSafeWorktreePath(p) {
  if (typeof p !== 'string' || p.trim() === '') return false;
  if (p.includes('\0')) return false;
  if (p.includes('~')) return false;
  if (p.includes('..')) return false;
  // Absoluto POSIX (`/`, `\`) o Windows (drive/UNC) → rechazar.
  if (p.startsWith('/') || p.startsWith('\\')) return false;
  if (/^[A-Za-z]:[\\/]/.test(p)) return false;
  // Resolver contra un root ficticio y verificar prefijo (no comparación textual).
  const resolved = path.resolve(WORKTREE_PREFIX_ROOT, p);
  if (resolved !== WORKTREE_PREFIX_ROOT && !resolved.startsWith(WORKTREE_PREFIX_ROOT + path.sep)) return false;
  return true;
}

function collectPathTraversalHits(descriptor) {
  const hits = [];
  const pid = descriptor && descriptor.identity && descriptor.identity.projectId;
  if (!isSafeId(pid)) hits.push({ path: 'identity.projectId', detail: 'projectId inseguro para namespacing de estado/worktrees' });
  const repos = (descriptor && descriptor.repositories) || [];
  if (Array.isArray(repos)) {
    repos.forEach((r, i) => {
      if (!isSafeId(r && r.id)) hits.push({ path: `repositories[${i}].id`, detail: 'repository id inseguro para namespacing' });
    });
  }
  // Ruta de worktree del descriptor (campo nuevo de thresholds · Ola Puente P5a #4775).
  const wtRoot = descriptor && descriptor.thresholds && descriptor.thresholds.worktreeRoot;
  if (wtRoot !== undefined && !isSafeWorktreePath(wtRoot)) {
    hits.push({ path: 'thresholds.worktreeRoot', detail: 'ruta de worktree insegura (traversal / absoluta / ~ / NUL)' });
  }
  return hits;
}

/**
 * Validación cruzada de `thresholds` (CA-7). JSON Schema NO expresa "Σ ≤ 100%" ni
 * "cap ≤ techo global" ni "piso ≤ cap"; por eso van imperativas acá (el schema es
 * defensa-en-profundidad). Devuelve las violaciones como DATO — nunca lanza.
 *
 * @param {object} descriptor
 * @returns {Array<{path:string, detail:string}>}
 */
function collectThresholdViolations(descriptor) {
  const hits = [];
  const t = (descriptor && descriptor.thresholds) || {};
  // agentCap ≤ techo global (autoridad final de disponibilidad · anti-DoS).
  if (typeof t.agentCap === 'number' && typeof t.globalAgentCap === 'number' && t.agentCap > t.globalAgentCap) {
    hits.push({ path: 'thresholds.agentCap', detail: `agentCap (${t.agentCap}) excede el techo global (${t.globalAgentCap})` });
  }
  // Piso anti-starvation no puede exceder el cap del producto (config incoherente).
  if (typeof t.minAgentFloor === 'number' && typeof t.agentCap === 'number' && t.minAgentFloor > t.agentCap) {
    hits.push({ path: 'thresholds.minAgentFloor', detail: `minAgentFloor (${t.minAgentFloor}) excede agentCap (${t.agentCap})` });
  }
  // Σ providerBudget ≤ 100% de la cuota central (anti sobre-asignación de cuota).
  if (t.providerBudget && typeof t.providerBudget === 'object' && !Array.isArray(t.providerBudget)) {
    const sum = Object.values(t.providerBudget).reduce((a, v) => a + (typeof v === 'number' ? v : 0), 0);
    if (sum > 100) hits.push({ path: 'thresholds.providerBudget', detail: `Σ providerBudget (${sum}%) excede el 100% de la cuota central` });
  }
  return hits;
}

// Nombre de repo válido para creación (#4800). Espeja el pattern del schema
// (`repositories[].create.name`) — la superficie de command-injection nace acá,
// así que el nombre se re-valida imperativamente antes de que el drainer kernel-side
// lo pase a `gh repo create` (fail-closed, defensa-en-profundidad).
const CREATE_REPO_NAME_RE = /^[A-Za-z0-9._-]{1,100}$/;

/**
 * Validación cruzada de la PROVENANCE de cada repo (#4800 · alta con repo nuevo vs
 * existente). JSON Schema ya modela la forma (if/then sobre `provenance`), pero se
 * re-verifica imperativa y fail-closed como defensa-en-profundidad y para exigir
 * `create.org` (que el schema deja opcional porque su allowlist vive en la capa lib):
 *   - `provenance:'create'`  ⇒ exige `create.name` (regex) y `create.org`; PROHÍBE `url`.
 *   - `provenance:'existing'` (o ausente, retro-compat) ⇒ exige `url`.
 * Devuelve violaciones como DATO — nunca lanza.
 *
 * @param {object} descriptor
 * @returns {Array<{path:string, detail:string}>}
 */
function collectRepositoryProvenanceHits(descriptor) {
  const hits = [];
  const repos = (descriptor && descriptor.repositories) || [];
  if (!Array.isArray(repos)) return hits;
  repos.forEach((r, i) => {
    if (!r || typeof r !== 'object') return;
    if (r.provenance === 'create') {
      const c = r.create;
      if (!c || typeof c !== 'object' || Array.isArray(c)) {
        hits.push({ path: `repositories[${i}].create`, detail: 'provenance:create exige el subobjeto create' });
        return;
      }
      if (typeof c.name !== 'string' || !CREATE_REPO_NAME_RE.test(c.name)) {
        hits.push({ path: `repositories[${i}].create.name`, detail: 'create.name ausente o inválido (^[A-Za-z0-9._-]{1,100}$)' });
      }
      if (typeof c.org !== 'string' || c.org.trim() === '') {
        hits.push({ path: `repositories[${i}].create.org`, detail: 'create.org es obligatorio en provenance:create' });
      }
      if (r.url !== undefined) {
        hits.push({ path: `repositories[${i}].url`, detail: 'provenance:create no admite url (el kernel la completa al crear el repo)' });
      }
    } else {
      // existing explícito o ausente (retro-compat) ⇒ exige url.
      if (typeof r.url !== 'string' || r.url.trim() === '') {
        hits.push({ path: `repositories[${i}].url`, detail: 'provenance:existing exige url' });
      }
    }
  });
  return hits;
}

// -----------------------------------------------------------------------------
// Checksum de integridad (paso 2). Cálculo determinístico sobre el descriptor
// SIN el bloque `integrity` (no se auto-incluye en su propio hash).
// -----------------------------------------------------------------------------
function computeChecksum(descriptor) {
  const clone = { ...descriptor };
  delete clone.integrity;
  const canonical = canonicalize(clone);
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

// Serialización canónica estable (claves ordenadas) para un hash reproducible.
function canonicalize(value) {
  if (Array.isArray(value)) return '[' + value.map(canonicalize).join(',') + ']';
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalize(value[k])).join(',') + '}';
  }
  return JSON.stringify(value);
}

/**
 * Valida un descriptor en orden fail-closed estricto (CA-B3), abortando al
 * primer fallo. Errores como DATO — nunca lanza.
 *
 * @param {object} obj  descriptor parseado.
 * @param {object} [opts]
 * @param {string} [opts.expectedChecksum]  si se provee, se exige integridad sha256.
 * @returns {{ valid:boolean, stage:string|null, errors:Array, descriptor:object|null }}
 */
function validateDescriptor(obj, opts = {}) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return { valid: false, stage: 'parse', errors: [{ path: '(root)', detail: 'descriptor no es un objeto' }], descriptor: null };
  }

  // 1) Compat de schemaVersion (+ migración).
  const mig = migrations.migrateDescriptor(obj);
  if (!mig.ok) {
    return { valid: false, stage: 'version', errors: [{ path: 'schemaVersion', keyword: mig.code, detail: mig.error }], descriptor: null };
  }
  const descriptor = mig.descriptor;

  // 2) Integridad / checksum (supply-chain). Sólo si el caller exige un checksum.
  if (opts.expectedChecksum) {
    const actual = computeChecksum(descriptor);
    if (actual !== String(opts.expectedChecksum).toLowerCase()) {
      return {
        valid: false,
        stage: 'integrity',
        errors: [{ path: 'integrity.checksum', keyword: 'checksum', detail: 'checksum del descriptor no coincide con el registrado' }],
        descriptor: null,
      };
    }
  }

  // 3) JSON Schema (Ajv).
  const schemaValid = validateSchema(descriptor);
  if (!schemaValid) {
    return { valid: false, stage: 'schema', errors: redactAjvErrors(validateSchema.errors), descriptor: null };
  }

  // 3b) Prompt-injection sobre campos no confiables (A03/A08).
  const injectionHits = collectInjectionHits(descriptor);
  if (injectionHits.length > 0) {
    return {
      valid: false,
      stage: 'schema',
      errors: injectionHits.map((h) => ({ path: h.path, keyword: 'promptInjection', detail: 'dato no confiable contiene patrón de prompt-injection' })),
      descriptor: null,
    };
  }

  // 4) Sanitización anti path-traversal ANTES de usar ids como base de workspace.
  const pathHits = collectPathTraversalHits(descriptor);
  if (pathHits.length > 0) {
    return {
      valid: false,
      stage: 'path',
      errors: pathHits.map((h) => ({ path: h.path, keyword: 'pathTraversal', detail: h.detail })),
      descriptor: null,
    };
  }

  // 5) Validación cruzada de thresholds (Σ providerBudget ≤ 100%, agentCap ≤ techo
  //    global, piso ≤ cap). No expresable en JSON Schema puro → imperativa fail-closed.
  const thresholdHits = collectThresholdViolations(descriptor);
  if (thresholdHits.length > 0) {
    return {
      valid: false,
      stage: 'thresholds',
      errors: thresholdHits.map((h) => ({ path: h.path, keyword: 'thresholdViolation', detail: h.detail })),
      descriptor: null,
    };
  }

  // 6) Validación cruzada de provenance de repos (#4800): create exige name/org y
  //    prohíbe url; existing exige url. Defensa-en-profundidad sobre el if/then del schema.
  const provenanceHits = collectRepositoryProvenanceHits(descriptor);
  if (provenanceHits.length > 0) {
    return {
      valid: false,
      stage: 'repositories',
      errors: provenanceHits.map((h) => ({ path: h.path, keyword: 'repositoryProvenance', detail: h.detail })),
      descriptor: null,
    };
  }

  return { valid: true, stage: null, errors: [], descriptor };
}

/**
 * Carga un descriptor desde disco y lo valida (fail-closed). Sanitiza el path de
 * entrada (no lo toma de datos en banda). Errores como dato.
 *
 * @param {string} descriptorPath
 * @param {object} [opts] pasado a validateDescriptor.
 * @returns {{ valid:boolean, stage:string|null, errors:Array, descriptor:object|null }}
 */
function loadDescriptor(descriptorPath, opts = {}) {
  if (typeof descriptorPath !== 'string' || descriptorPath.trim() === '') {
    return { valid: false, stage: 'load', errors: [{ path: '(path)', detail: 'path de descriptor inválido' }], descriptor: null };
  }
  let raw;
  try {
    raw = fs.readFileSync(descriptorPath, 'utf8');
  } catch (e) {
    return { valid: false, stage: 'load', errors: [{ path: '(path)', detail: `no se pudo leer el descriptor: ${e.code || e.message}` }], descriptor: null };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { valid: false, stage: 'parse', errors: [{ path: '(root)', detail: 'descriptor no es JSON válido' }], descriptor: null };
  }
  // Si el descriptor declara su propio integrity.checksum, exigirlo salvo override.
  const effectiveOpts = { ...opts };
  if (!effectiveOpts.expectedChecksum && parsed && parsed.integrity && parsed.integrity.checksum) {
    effectiveOpts.expectedChecksum = parsed.integrity.checksum;
  }
  return validateDescriptor(parsed, effectiveOpts);
}

/**
 * Resuelve un skill del descriptor contra la allowlist FIJA del kernel (CA-B1).
 * Un skill fuera de la allowlist (ej. `"../../evil"`) se RECHAZA — jamás se
 * carga código desde un path del descriptor.
 *
 * @param {string} skill
 * @returns {string} el mismo skill si es válido.
 * @throws {Error} si el skill no está en la allowlist.
 */
function resolveCapabilitySkill(skill) {
  if (typeof skill !== 'string' || !KERNEL_SKILLS.has(skill)) {
    throw new Error(`skill no reconocido en la allowlist del kernel: ${JSON.stringify(skill)}`);
  }
  return skill; // jamás cargar código desde un path del descriptor.
}

// Variante que no lanza (para verificación masiva de un descriptor).
function assertCapabilitiesAllowlisted(descriptor) {
  const caps = (descriptor && descriptor.capabilities) || [];
  const rejected = [];
  for (const cap of caps) {
    if (!KERNEL_INTERFACES.has(cap && cap.interface)) rejected.push({ interface: cap && cap.interface, reason: 'interface desconocida' });
    for (const skill of (cap && cap.skills) || []) {
      if (!KERNEL_SKILLS.has(skill)) rejected.push({ interface: cap.interface, skill, reason: 'skill fuera de allowlist' });
    }
  }
  return { ok: rejected.length === 0, rejected };
}

// -----------------------------------------------------------------------------
// Derivadores para el round-trip Intrale (CA-E2) y consumo del kernel.
// -----------------------------------------------------------------------------

// label → capability (tabla de ruteo del board).
function deriveRouting(descriptor) {
  const map = new Map();
  const routing = (descriptor && descriptor.board && descriptor.board.routing) || [];
  for (const r of routing) {
    if (r && typeof r.label === 'string' && typeof r.capability === 'string') map.set(r.label, r.capability);
  }
  return map;
}

// admission labels (labels que disparan la entrada del intake).
function deriveAdmissionLabels(descriptor) {
  const b = descriptor && descriptor.board;
  return (b && Array.isArray(b.admissionLabels)) ? [...b.admissionLabels] : [];
}

// concurrencia declarada por skill (thresholds.concurrency).
function deriveConcurrency(descriptor) {
  const c = descriptor && descriptor.thresholds && descriptor.thresholds.concurrency;
  return (c && typeof c === 'object') ? { ...c } : {};
}

function derivePriorityWindows(descriptor) {
  const pw = descriptor && descriptor.thresholds && descriptor.thresholds.priorityWindows;
  return (pw && typeof pw === 'object') ? { ...pw } : {};
}

/**
 * Deriva el cap de agentes del producto ACOTADO al techo global (CA-1/CA-7).
 * Clamp defensivo en runtime aunque el schema/validación cruzada hayan pasado
 * (anti-DoS por `agentCap` desmedido). Copia defensiva, sin efectos.
 *
 * @param {object} descriptor
 * @returns {{ agentCap:number|null, globalAgentCap:number|null, minAgentFloor:number }}
 */
function deriveAgentCap(descriptor) {
  const t = (descriptor && descriptor.thresholds) || {};
  const globalAgentCap = typeof t.globalAgentCap === 'number' ? t.globalAgentCap : null;
  let agentCap = typeof t.agentCap === 'number' ? t.agentCap : null;
  if (agentCap != null && globalAgentCap != null) agentCap = Math.min(agentCap, globalAgentCap);
  const minAgentFloor = typeof t.minAgentFloor === 'number' ? Math.max(0, t.minAgentFloor) : 0;
  return { agentCap, globalAgentCap, minAgentFloor };
}

/**
 * Deriva el `providerBudget` por producto (CA-3/CA-7) con validación imperativa
 * Σ ≤ 100% (JSON Schema no la expresa). Copia defensiva.
 *
 * @param {object} descriptor
 * @returns {Object<string,number>}
 * @throws {Error} si Σ providerBudget > 100%.
 */
function deriveProviderBudget(descriptor) {
  const t = (descriptor && descriptor.thresholds) || {};
  const budget = (t.providerBudget && typeof t.providerBudget === 'object' && !Array.isArray(t.providerBudget))
    ? { ...t.providerBudget } : {};
  const sum = Object.values(budget).reduce((a, v) => a + (typeof v === 'number' ? v : 0), 0);
  if (sum > 100) throw new Error(`providerBudget inválido: Σ ${sum}% excede el 100% de la cuota central`);
  return budget;
}

// interface → skills (partición del puerto dev).
function deriveCapabilityPartitions(descriptor) {
  const out = {};
  for (const cap of (descriptor && descriptor.capabilities) || []) {
    if (cap && KERNEL_INTERFACES.has(cap.interface)) out[cap.interface] = [...(cap.skills || [])];
  }
  return out;
}

/**
 * Resuelve el modo efectivo de un gate fail-closed (CA-D5 · requisito #6). Valor
 * ausente o DESCONOCIDO ⇒ 'enforce', nunca 'off'. La política global del kernel
 * puede poner PISO (kernelFloor='enforce' fuerza enforce aunque el producto relaje).
 *
 * @param {object} descriptor
 * @param {string} gateName  gate0 | gate2 | visual
 * @param {object} [opts]
 * @param {string} [opts.kernelFloor]  si es 'enforce', el resultado nunca se relaja.
 * @returns {string} 'enforce' | 'dry-run'
 */
function resolveGate(descriptor, gateName, opts = {}) {
  const gates = descriptor && descriptor.authority && descriptor.authority.gates;
  const raw = gates && typeof gates === 'object' ? gates[gateName] : undefined;
  let mode = 'enforce';
  if (typeof raw === 'string' && KNOWN_GATE_MODES.has(raw)) mode = raw;
  // Piso del kernel: no se puede relajar por debajo del piso global.
  if (opts.kernelFloor === 'enforce') mode = 'enforce';
  return mode;
}

/**
 * Resuelve la AUTORIDAD DE FIRMA declarada por el producto en su descriptor
 * (CA-D4 · requisito #5 · GATE 2 · Ola Puente P7 #4692). `signers` vacío/inválido
 * ⇒ BLOQUEA (fail-closed), nunca auto-aprueba ni cae a un global implícito.
 *
 * Renombrada desde `evaluateSignatureGate` (colisión de nombres con el gate
 * OPERATIVO de auto-aprobación en `operator-signature-gate.js`, que tiene otra
 * responsabilidad). Esta es la ÚNICA fuente de verdad de "quién puede firmar"
 * un producto; el gate operativo la consume, no la reimplementa.
 *
 * @returns {{ blocked:boolean, reason:string, signers:string[], backup:string|null, projectId:string|null }}
 */
function resolveSignerAuthority(descriptor) {
  const authority = descriptor && descriptor.authority;
  const projectId = (descriptor && descriptor.identity && descriptor.identity.projectId) || null;
  const signers = authority && authority.signers;
  const valid = Array.isArray(signers) && signers.length > 0 && signers.every((s) => typeof s === 'string' && s.length > 0);
  // `backup` es una identidad humana IGUALMENTE autorizada (no una vía de
  // auto-aprobación). Debe ser un string no vacío para contarse; cualquier otra
  // cosa ⇒ sin backup (null), nunca error silencioso.
  const rawBackup = authority && authority.backup;
  const backup = (typeof rawBackup === 'string' && rawBackup.length > 0) ? rawBackup : null;
  if (!valid) {
    return { blocked: true, reason: 'authority.signers vacío o inválido — gate bloquea (fail-closed)', signers: [], backup, projectId };
  }
  return { blocked: false, reason: '', signers: [...signers], backup, projectId };
}

/**
 * Autoriza (o niega, fail-closed) que una `identity` firme GATE 2 del producto
 * descrito por `descriptor` (Ola Puente P7 #4692 · requisito de seguridad #2 ·
 * A01 cross-tenant authz). Un firmante autorizado en el producto A NO puede
 * firmar en el producto B: la validación es SIEMPRE contra la autoridad del
 * `descriptor` recibido (el producto en curso), nunca contra un global.
 *
 * Fail-closed: autoridad bloqueada, identidad no-string/vacía, o identidad
 * fuera de `signers`+`backup` ⇒ `{ authorized:false }`.
 *
 * @param {object} descriptor  descriptor del producto en curso.
 * @param {string} identity    identidad que intenta firmar.
 * @returns {{ authorized:boolean, role:('signer'|'backup'|null), reason:string, projectId:string|null }}
 */
function authorizeSigner(descriptor, identity) {
  const authority = resolveSignerAuthority(descriptor);
  const projectId = authority.projectId;
  if (authority.blocked) {
    return { authorized: false, role: null, reason: authority.reason, projectId };
  }
  if (typeof identity !== 'string' || identity.length === 0) {
    return { authorized: false, role: null, reason: 'identidad de firma inválida o ausente (fail-closed)', projectId };
  }
  if (authority.signers.includes(identity)) {
    return { authorized: true, role: 'signer', reason: '', projectId };
  }
  if (authority.backup && authority.backup === identity) {
    return { authorized: true, role: 'backup', reason: '', projectId };
  }
  return {
    authorized: false,
    role: null,
    reason: `identidad "${identity}" no autorizada para firmar el producto ${projectId || '(desconocido)'} (cross-tenant authz negada)`,
    projectId,
  };
}

// Pin exacto de versión (X.Y.Z). Espeja `EXACT_SEMVER` de kernel-resolver.js:
// se rechazan rangos/comodines/prereleases (CA-5 · A08 supply-chain).
const EXACT_SEMVER_RE = /^\d+\.\d+\.\d+$/;

/**
 * Deriva el PIN de versión de kernel del producto (Ola Puente P7 #4692 · CA-5).
 *
 * Decisión de diseño (docs/pipeline/kernel-updates.md): el pin puede declararse
 * POR PRODUCTO en `descriptor.kernel.version`; si el producto no lo declara, se
 * cae al pin del manifest GLOBAL (`opts.manifestVersion`, hoy
 * `pipeline.config.json → kernel.version`) como fallback autoritativo. En ambos
 * casos el pin DEBE ser exacto: un rango/comodín ⇒ fail-closed (throw), coherente
 * con `assertReleaseSignature`/`EXACT_SEMVER` de kernel-resolver.js.
 *
 * @param {object} descriptor
 * @param {object} [opts]
 * @param {string} [opts.manifestVersion]  pin global de fallback (manifest del kernel).
 * @returns {{ version:string, channel:string, source:('descriptor'|'manifest') }}
 * @throws {Error} si el pin resuelto no es una versión exacta.
 */
function deriveKernelPin(descriptor, opts = {}) {
  const k = descriptor && descriptor.kernel;
  const channel = (k && typeof k.channel === 'string') ? k.channel : 'stable';
  const declared = k && typeof k.version === 'string' ? k.version : null;
  if (declared) {
    if (!EXACT_SEMVER_RE.test(declared)) {
      throw new Error(`kernel.version del descriptor no es un pin exacto ("X.Y.Z"): ${JSON.stringify(declared)} — se rechazan rangos (A08)`);
    }
    return { version: declared, channel, source: 'descriptor' };
  }
  const fallback = typeof opts.manifestVersion === 'string' ? opts.manifestVersion : null;
  if (!fallback) {
    throw new Error('sin pin de kernel: el descriptor no declara kernel.version y no se proveyó manifestVersion (fail-closed)');
  }
  if (!EXACT_SEMVER_RE.test(fallback)) {
    throw new Error(`manifestVersion no es un pin exacto ("X.Y.Z"): ${JSON.stringify(fallback)} — se rechazan rangos (A08)`);
  }
  return { version: fallback, channel, source: 'manifest' };
}

// -----------------------------------------------------------------------------
// Máquina de estados del producto (Ola "Cierre de gestión de producto nuevo"
// · #4805 · CA-2/SR-A04). Aristas VÁLIDAS del ciclo de vida — cualquier
// transición no listada se rechaza fail-closed. Hoy la única arista soportada es
// la activación (`onboarding→active`); el resto (archivado, re-onboarding) se
// suma acá cuando exista su historia, nunca desde el request en banda.
// -----------------------------------------------------------------------------
const STATUS_TRANSITIONS = Object.freeze({
  onboarding: Object.freeze(new Set(['active', 'archived'])),
  active: Object.freeze(new Set(['archived'])),
});

function isValidStatusEdge(from, to) {
  return Object.prototype.hasOwnProperty.call(STATUS_TRANSITIONS, from)
    && STATUS_TRANSITIONS[from].has(to);
}

/**
 * Writer atómico DUEÑO del estado del descriptor (#4805 · SR-A08/CA-7). Es la
 * ÚNICA vía para mutar `status` de forma durable: nunca se escribe `status` con
 * `fs.writeFileSync` in-place al store desde otro módulo.
 *
 * Operación guardada única (anti-TOCTOU · CA-7): carga + valida fail-closed +
 * verifica la arista de la máquina de estados + verifica que el `status` actual
 * en disco sea exactamente `from` + escribe atómicamente (write a `*.tmp` +
 * `fs.renameSync`), recomputando `integrity.checksum`. El "descriptor completo"
 * (CA-3) es la propia validación fail-closed de `loadDescriptor`: si faltan
 * campos requeridos, se devuelve el detalle (redactado) y NO se muta nada.
 *
 * Seguridad:
 *   - CA-2/SR-A04: sólo `onboarding→active` es arista válida; `active→active` y
 *     cualquier transición arbitraria del request se rechazan sin mutar.
 *   - CA-3/SR-A03: validación server-side fail-closed (no depende del cliente).
 *   - CA-7/SR-A08: escritura atómica tmp+rename; jamás in-place al store.
 *
 * @param {object} args
 * @param {string} args.descriptorPath  ruta del descriptor a mutar (out-of-band).
 * @param {string} [args.from='onboarding']  estado esperado de origen.
 * @param {string} [args.to='active']         estado destino.
 * @param {object} [deps]  { fsImpl, loadDescriptorImpl, now }
 * @returns {{ ok:boolean, status:number, from?:string, to?:string, projectId?:string, checksum?:string, stage?:string, errors?:Array, msg?:string }}
 */
function transitionStatus(args = {}, deps = {}) {
  const _fs = deps.fsImpl || fs;
  const loadImpl = typeof deps.loadDescriptorImpl === 'function' ? deps.loadDescriptorImpl : loadDescriptor;
  const now = typeof deps.now === 'function' ? deps.now : () => Date.now();

  const descriptorPath = args.descriptorPath;
  const from = args.from == null ? 'onboarding' : args.from;
  const to = args.to == null ? 'active' : args.to;

  if (typeof descriptorPath !== 'string' || descriptorPath.trim() === '') {
    return { ok: false, status: 400, stage: 'load', errors: [{ path: '(path)', detail: 'path de descriptor inválido' }], msg: 'path de descriptor inválido' };
  }

  // 1) Arista de máquina de estados (CA-2/SR-A04). Rechazo ANTES de tocar el FS.
  if (!isValidStatusEdge(from, to)) {
    return { ok: false, status: 409, stage: 'transition', from, to, errors: [{ path: 'status', detail: `transición ${from}→${to} no permitida (única arista válida: onboarding→active)` }], msg: `transición ${from}→${to} no permitida` };
  }

  // 2) Carga + validación fail-closed (== "descriptor completo", CA-3). Un
  //    descriptor incompleto/ inválido devuelve el detalle de campos faltantes.
  const loaded = loadImpl(descriptorPath);
  if (!loaded || !loaded.valid || !loaded.descriptor) {
    return { ok: false, status: 400, stage: (loaded && loaded.stage) || 'validate', errors: (loaded && loaded.errors) || [{ path: '(root)', detail: 'descriptor inválido' }], msg: 'descriptor incompleto o inválido — activación bloqueada' };
  }
  const descriptor = loaded.descriptor;
  const projectId = descriptor.identity && descriptor.identity.projectId;

  // 3) Guardia anti-TOCTOU / anti doble-activación: el `status` ACTUAL en disco
  //    debe ser exactamente `from`. Un producto ya `active` (o cualquier otro
  //    estado) hace que `active→active`/arbitrario se rechace server-side.
  const current = typeof descriptor.status === 'string' ? descriptor.status : 'onboarding';
  if (current !== from) {
    return { ok: false, status: 409, stage: 'transition', from, to, projectId, errors: [{ path: 'status', detail: `estado actual "${current}" ≠ origen esperado "${from}" — transición rechazada` }], msg: `el producto no está en estado ${from} (actual: ${current})` };
  }

  // 4) Flip sobre el snapshot ya validado (misma operación guardada) + recompute
  //    del checksum de integridad sobre el descriptor con el nuevo status.
  const next = { ...descriptor, status: to };
  const checksum = computeChecksum(next);
  next.integrity = { algorithm: 'sha256', checksum };

  // 5) Escritura ATÓMICA: write a tmp en el MISMO dir + rename (nunca in-place).
  const dir = path.dirname(descriptorPath);
  const tmpPath = path.join(dir, `.${path.basename(descriptorPath)}.${process.pid}.${now()}.tmp`);
  const serialized = JSON.stringify(next, null, 2) + '\n';
  try {
    _fs.writeFileSync(tmpPath, serialized, 'utf8');
  } catch (e) {
    return { ok: false, status: 500, stage: 'write', projectId, errors: [{ path: '(path)', detail: `no se pudo escribir el tmp del descriptor: ${e.code || e.message}` }], msg: 'fallo de escritura atómica (tmp)' };
  }
  try {
    _fs.renameSync(tmpPath, descriptorPath);
  } catch (e) {
    try { _fs.unlinkSync(tmpPath); } catch { /* best-effort cleanup */ }
    return { ok: false, status: 500, stage: 'write', projectId, errors: [{ path: '(path)', detail: `no se pudo renombrar el tmp sobre el descriptor: ${e.code || e.message}` }], msg: 'fallo de escritura atómica (rename)' };
  }

  return { ok: true, status: 200, from, to, projectId, checksum, msg: `status del producto ${projectId} transicionado ${from}→${to} de forma durable` };
}

module.exports = {
  SCHEMA_PATH,
  schema,
  KERNEL_SKILLS,
  KERNEL_INTERFACES,
  GATE_NAMES,
  validateDescriptor,
  loadDescriptor,
  resolveCapabilitySkill,
  assertCapabilitiesAllowlisted,
  computeChecksum,
  canonicalize,
  isSafeId,
  isSafeWorktreePath,
  collectPathTraversalHits,
  collectThresholdViolations,
  collectRepositoryProvenanceHits,
  CREATE_REPO_NAME_RE,
  redactAjvErrors,
  deriveRouting,
  deriveAdmissionLabels,
  deriveConcurrency,
  derivePriorityWindows,
  deriveAgentCap,
  deriveProviderBudget,
  deriveCapabilityPartitions,
  resolveGate,
  resolveSignerAuthority,
  authorizeSigner,
  deriveKernelPin,
  STATUS_TRANSITIONS,
  isValidStatusEdge,
  transitionStatus,
};
