'use strict';

// =============================================================================
// kernel-store-migrate.js — Migración JSON→DynamoDB del estado de coordinación
// del kernel (Ola Puente P3 · #4745, split de #4688)
//
// Migra SIN PÉRDIDA el estado local de coordinación (`waves.json`,
// `blocked-issues.json`, `blocked-by-infra.json`, `infra-health.json`) al store
// durable del kernel, escribiendo A TRAVÉS del coordination store (#4744), nunca
// directo al driver DynamoDB (#4743). Con backup previo, verificación de
// integridad fail-closed y rollback documentado.
//
// Espeja el estilo de `project-descriptor-migrations.js`:
//   - ERRORES COMO DATO: todo camino anómalo devuelve `{ ok:false, code, error }`.
//     NUNCA throw silencioso, NUNCA "arranca degradado".
//   - FAIL-CLOSED: cualquier discrepancia de integridad DETIENE la migración.
//
// Modos (CLI):
//   (default)              dry-run — backup + reporte proyectado, NO escribe.
//   --apply / --commit     escribe al store, verifica integridad, reporta.
//   --rollback --from DIR   restaura los JSON desde un backup verificado.
//
// SEGURIDAD (mapa OWASP del análisis de definición)
//   A01  path-traversal: el `<timestamp>` del backup se genera internamente
//        (ISO), nunca de input externo; `--from` se valida DENTRO de backupRoot.
//   A02  el backup serializa SÓLO el contenido de los 4 JSON (sin secretos) y
//        rutas RELATIVAS; la salida se redacta contra patrones de secreto antes
//        de emitirse; los errores del SDK se sanitizan (sin RequestId/ARN).
//   A05  el rollback verifica el checksum del backup ANTES de restaurar (no
//        reintroduce estado corrupto).
//   A08  verificación fail-closed: checksum canónico + conteo por clave, antes y
//        después; discrepancia ⇒ `{ ok:false, code:'integrity_mismatch' }`.
// =============================================================================

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { canonicalize } = require('./project-descriptor');

// Raíz del pipeline (`.pipeline/`) y raíz de backups. `__dirname` = `.pipeline/lib`.
const PIPELINE_DIR = path.resolve(__dirname, '..');
const DEFAULT_BACKUP_ROOT = path.join(PIPELINE_DIR, 'backup');
const DEFAULT_PROJECT_ID = 'intrale-platform';
const MANIFEST_NAME = 'manifest.json';
const MANIFEST_SCHEMA_VERSION = '1.0';

// Plan de migración: una clave de coordinación por cada grupo de fuentes. El
// coordination store (#4744) reconoce `waves` / `blocked` / `health`. Las dos
// fuentes de bloqueo se colapsan bajo la clave `blocked` preservando ambas.
const MIGRATION_PLAN = Object.freeze([
  { key: 'waves', sources: ['waves.json'] },
  { key: 'blocked', sources: ['blocked-issues.json', 'blocked-by-infra.json'] },
  { key: 'health', sources: ['infra-health.json'] },
]);

// Allow-list de nombres de fuente conocidos (A01/A08). El rollback sólo restaura
// archivos cuyo `name`/`relPath` pertenece a este conjunto: defensa en profundidad
// sobre la validación de path-traversal (deny-list de `..`). Un manifest plantado
// con una entrada sin `..` pero ajena a las fuentes (ej. "evil.json") tampoco se
// procesa. Las fuentes son basenames planos dentro de `.pipeline/`, por lo que el
// mismo conjunto sirve para `name` (origen en el backup) y `relPath` (destino).
const KNOWN_SOURCE_NAMES = Object.freeze(
  Array.from(new Set(MIGRATION_PLAN.flatMap((e) => e.sources)))
);

// -----------------------------------------------------------------------------
// Utilidades de integridad y seguridad
// -----------------------------------------------------------------------------

/** sha256 sobre la serialización canónica (claves ordenadas) — hash reproducible. */
function canonicalChecksum(value) {
  return crypto.createHash('sha256').update(canonicalize(value)).digest('hex');
}

/** sha256 de bytes crudos (para verificar la integridad del archivo de backup). */
function rawChecksum(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

// Redacta patrones de secreto de la salida del operador (A02). Los datos de las
// 4 fuentes no tienen secretos, pero la redacción es defensa en profundidad para
// que un cambio futuro de las fuentes no filtre credenciales a logs.
const SECRET_PATTERNS = [
  /(?:AKIA|ASIA)[0-9A-Z]{16}/g, // AWS access key id
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, // JWT
  /(aws_secret_access_key|secret[_-]?access[_-]?key|password|api[_-]?key)\s*[:=]\s*\S+/gi,
];

function redactSecrets(text) {
  let out = String(text);
  for (const re of SECRET_PATTERNS) out = out.replace(re, '[REDACTED]');
  return out;
}

// Sanitiza un error (posiblemente del SDK de AWS) a un mensaje corto y sin
// internals (RequestId/headers/ARN). Nunca serializa el objeto completo.
function safeErrorMessage(e) {
  if (!e) return 'error desconocido';
  const name = e.name && typeof e.name === 'string' ? e.name : 'Error';
  const msg = e.message && typeof e.message === 'string' ? e.message : String(e);
  // Cortar todo lo que huela a metadata del SDK.
  const clean = msg.split(/\bRequestId\b|\bx-amzn\b|\barn:aws\b/i)[0].trim();
  return redactSecrets(`${name}: ${clean}`.slice(0, 300));
}

/**
 * Resuelve `target` y garantiza que quede DENTRO de `root` (anti path-traversal,
 * A01). Devuelve la ruta absoluta o `null` si escapa del root.
 */
function resolveWithin(root, target) {
  const absRoot = path.resolve(root);
  const abs = path.resolve(absRoot, target);
  const rel = path.relative(absRoot, abs);
  if (rel === '' || rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) {
    return null;
  }
  return abs;
}

/** Timestamp interno seguro para nombre de dir: sólo `[0-9A-Za-z-]`. */
function safeTimestamp(now) {
  const iso = new Date(Math.floor(now())).toISOString(); // ej. 2026-07-17T20:55:02.240Z
  return iso.replace(/[:.]/g, '-').replace(/[^0-9A-Za-z-]/g, '');
}

// -----------------------------------------------------------------------------
// Carga de fuentes y composición de valores de coordinación
// -----------------------------------------------------------------------------

/** Resuelve el mapa de rutas de las fuentes (por nombre de archivo). */
function resolveSources(sourcesDir) {
  const dir = sourcesDir || PIPELINE_DIR;
  const map = {};
  for (const entry of MIGRATION_PLAN) {
    for (const name of entry.sources) map[name] = path.join(dir, name);
  }
  return map;
}

/**
 * Lee y parsea las 4 fuentes. Fail-closed: archivo ausente o JSON inválido ⇒
 * `{ ok:false }`. Devuelve por nombre `{ raw, parsed, checksum }`.
 */
function loadSources(sourcePaths) {
  const loaded = {};
  for (const [name, file] of Object.entries(sourcePaths)) {
    let raw;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch (e) {
      return { ok: false, code: 'source_read', error: `no se pudo leer la fuente ${name}: ${safeErrorMessage(e)}` };
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      return { ok: false, code: 'source_parse', error: `la fuente ${name} no es JSON válido: ${safeErrorMessage(e)}` };
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, code: 'source_shape', error: `la fuente ${name} debe ser un objeto JSON` };
    }
    loaded[name] = { raw, parsed, checksum: rawChecksum(raw) };
  }
  return { ok: true, loaded };
}

/**
 * Compone el valor de coordinación para una clave. Envelope uniforme y sin
 * pérdida: cada fuente queda addressable bajo `sources[<nombre>]`.
 */
function composeValue(planEntry, loaded) {
  const sources = {};
  for (const name of planEntry.sources) {
    sources[name] = loaded[name].parsed;
  }
  return { sources };
}

/** Snapshot `{ key: { checksum, sources, recordCount } }` (conteo por clave). */
function snapshotBefore(loaded) {
  const keys = {};
  for (const entry of MIGRATION_PLAN) {
    const value = composeValue(entry, loaded);
    keys[entry.key] = {
      checksum: canonicalChecksum(value),
      sources: entry.sources.slice(),
      recordCount: entry.sources.length,
      value,
    };
  }
  return { keys };
}

// -----------------------------------------------------------------------------
// Backup (paso 1) — ANTES de cualquier escritura
// -----------------------------------------------------------------------------

/**
 * Crea `.pipeline/backup/<ts>/` con permisos restrictivos, copia el contenido
 * CRUDO de cada fuente y escribe un `manifest.json` con checksums y rutas
 * RELATIVAS (sin secretos, sin paths absolutos que filtren el usuario).
 *
 * @returns {{ ok:true, dir, manifest }|{ ok:false, code, error }}
 */
function createBackup(loaded, opts = {}) {
  const backupRoot = opts.backupRoot || DEFAULT_BACKUP_ROOT;
  const pipelineDir = opts.pipelineDir || PIPELINE_DIR;
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now();
  const projectId = opts.projectId || DEFAULT_PROJECT_ID;

  const ts = safeTimestamp(now);
  const dir = resolveWithin(backupRoot, ts);
  if (!dir) {
    return { ok: false, code: 'backup_path', error: 'el timestamp del backup resolvió fuera del root (A01)' };
  }

  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    // chmod explícito: `recursive:true` puede ignorar `mode` en dirs intermedios.
    try { fs.chmodSync(dir, 0o700); } catch (_) { /* Windows: best-effort */ }

    const files = [];
    for (const [name, entry] of Object.entries(loaded)) {
      const dest = path.join(dir, name);
      fs.writeFileSync(dest, entry.raw, { mode: 0o600 });
      try { fs.chmodSync(dest, 0o600); } catch (_) { /* best-effort */ }
      files.push({
        name,
        relPath: path.relative(pipelineDir, opts.sourcePaths ? opts.sourcePaths[name] : path.join(pipelineDir, name)).split(path.sep).join('/'),
        checksum: entry.checksum,
        bytes: Buffer.byteLength(entry.raw, 'utf8'),
      });
    }

    const manifest = {
      schemaVersion: MANIFEST_SCHEMA_VERSION,
      projectId,
      createdAt: new Date(Math.floor(now())).toISOString(),
      files,
    };
    const manifestPath = path.join(dir, MANIFEST_NAME);
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), { mode: 0o600 });
    try { fs.chmodSync(manifestPath, 0o600); } catch (_) { /* best-effort */ }

    return { ok: true, dir, manifest };
  } catch (e) {
    return { ok: false, code: 'backup_failed', error: `fallo al crear el backup: ${safeErrorMessage(e)}` };
  }
}

// -----------------------------------------------------------------------------
// Escritura idempotente a través del store (paso 3)
// -----------------------------------------------------------------------------

/**
 * Escribe una clave de coordinación de forma idempotente. Si el contenido ya
 * está y coincide (checksum canónico), NO reescribe (re-run no duplica ni sube
 * versión). Errores como dato.
 */
async function writeKeyThroughStore(store, key, value) {
  let cur;
  try {
    cur = await store.getState(key);
  } catch (e) {
    return { ok: false, code: 'store_read', error: `lectura del store falló para "${key}": ${safeErrorMessage(e)}` };
  }

  if (!cur) {
    try {
      const r = await store.initState(key, value);
      if (r && r.ok) return { ok: true, action: 'created', version: r.version };
      return { ok: false, code: 'write_conflict', error: `init idempotente perdió la carrera para "${key}"` };
    } catch (e) {
      return { ok: false, code: 'store_write', error: `escritura del store falló para "${key}": ${safeErrorMessage(e)}` };
    }
  }

  if (canonicalChecksum(cur.value) === canonicalChecksum(value)) {
    return { ok: true, action: 'unchanged', version: cur.version };
  }

  try {
    const r = await store.compareAndSet(key, value, cur.version);
    if (r && r.ok) return { ok: true, action: 'updated', version: r.version };
    return { ok: false, code: 'write_conflict', error: `compare-and-set en conflicto para "${key}" (version ${cur.version})` };
  } catch (e) {
    return { ok: false, code: 'store_write', error: `escritura del store falló para "${key}": ${safeErrorMessage(e)}` };
  }
}

// -----------------------------------------------------------------------------
// Verificación de integridad fail-closed (paso 4)
// -----------------------------------------------------------------------------

/**
 * Compara los snapshots ANTES (fuentes) y DESPUÉS (readback del store). Cualquier
 * discrepancia de checksum, clave faltante o conteo de firmas ⇒ fail-closed.
 *
 * @param {object} before  snapshotBefore().keys
 * @param {object} after   { key: { checksum } }  (readback del store)
 * @param {object} [sig]   { before:number, after:number }  conteo de firmas (opcional)
 * @returns {{ ok:true }|{ ok:false, code:'integrity_mismatch', mismatches }}
 */
function verifyIntegrity(before, after, sig) {
  const mismatches = [];
  for (const [key, snap] of Object.entries(before)) {
    const got = after[key];
    if (!got) {
      mismatches.push({ key, reason: 'missing', expected: snap.checksum, got: null });
      continue;
    }
    if (got.checksum !== snap.checksum) {
      mismatches.push({ key, reason: 'checksum', expected: snap.checksum, got: got.checksum });
    }
  }
  if (sig && Number.isFinite(sig.before) && Number.isFinite(sig.after) && sig.before !== sig.after) {
    mismatches.push({ key: 'signatures', reason: 'count', expected: sig.before, got: sig.after });
  }
  if (mismatches.length) {
    return { ok: false, code: 'integrity_mismatch', mismatches };
  }
  return { ok: true };
}

// -----------------------------------------------------------------------------
// Rollback (paso 5) — restaura desde un backup VERIFICADO
// -----------------------------------------------------------------------------

/**
 * Restaura las fuentes desde un directorio de backup. Verifica PRIMERO el
 * checksum de cada archivo contra el manifest (A05: no reintroducir estado
 * corrupto) y valida que `from` esté dentro de backupRoot (A01).
 *
 * @returns {{ ok:true, restored, dir }|{ ok:false, code, error }}
 */
function restoreFromBackup(opts = {}) {
  const backupRoot = opts.backupRoot || DEFAULT_BACKUP_ROOT;
  const pipelineDir = opts.pipelineDir || PIPELINE_DIR;
  const from = opts.from;

  if (typeof from !== 'string' || from === '') {
    return { ok: false, code: 'rollback_arg', error: 'se requiere --from <backupDir>' };
  }
  const dir = resolveWithin(backupRoot, path.isAbsolute(from) ? path.relative(backupRoot, from) : from);
  if (!dir) {
    return { ok: false, code: 'rollback_path', error: `el backup --from resolvió fuera de ${backupRoot} (A01)` };
  }

  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(dir, MANIFEST_NAME), 'utf8'));
  } catch (e) {
    return { ok: false, code: 'rollback_manifest', error: `manifest de backup ilegible: ${safeErrorMessage(e)}` };
  }
  if (!manifest || !Array.isArray(manifest.files) || manifest.files.length === 0) {
    return { ok: false, code: 'rollback_manifest', error: 'manifest de backup vacío o malformado' };
  }

  // 1. Verificar la integridad de TODOS los archivos del backup ANTES de restaurar.
  const plans = [];
  for (const f of manifest.files) {
    // (a) `relPath` = destino de ESCRITURA. Anti path-traversal (A01): rechazar
    //     cualquier `..` y confirmar que resuelve dentro del pipelineDir.
    if (typeof f.relPath !== 'string' || f.relPath.includes('..')) {
      return { ok: false, code: 'rollback_path', error: `relPath inseguro en manifest: ${JSON.stringify(f.relPath)}` };
    }
    // Allow-list (A01/A08): además de rechazar `..`, exigir que `relPath` sea una
    // de las fuentes conocidas — un basename plantado sin `..` (ej. "evil.json")
    // no debe poder crear/sobrescribir archivos arbitrarios dentro del pipeline.
    if (!KNOWN_SOURCE_NAMES.includes(f.relPath)) {
      return { ok: false, code: 'rollback_path', error: `relPath fuera del conjunto de fuentes conocidas: ${JSON.stringify(f.relPath)}` };
    }
    const dest = resolveWithin(pipelineDir, f.relPath);
    if (!dest) {
      return { ok: false, code: 'rollback_path', error: `destino de restore fuera del pipeline: ${f.relPath}` };
    }
    // (b) `name` = origen de LECTURA dentro del dir de backup. Sin esta validación,
    //     un manifest plantado con name="../.." (Zip-Slip aplicado al manifest,
    //     A01/A08) leería archivos ARBITRARIOS fuera del backup y copiaría su
    //     contenido al store. `createBackup` genera `name` como basename simple:
    //     exigir eso exactamente (sin separadores, sin `..`, no absoluto) y
    //     confirmar que resuelve DENTRO del dir de backup.
    if (typeof f.name !== 'string' || f.name === ''
        || f.name.includes('/') || f.name.includes('\\')
        || f.name.includes('..') || path.isAbsolute(f.name)) {
      return { ok: false, code: 'unsafe_backup_entry', error: `name inseguro en manifest: ${JSON.stringify(f.name)}` };
    }
    // Allow-list (A01/A08): el origen de lectura debe ser una fuente conocida.
    // Bloquea la lectura de cualquier otro archivo del dir de backup planteado
    // por un manifest hostil, incluso si es un basename simple sin `..`.
    if (!KNOWN_SOURCE_NAMES.includes(f.name)) {
      return { ok: false, code: 'unsafe_backup_entry', error: `name fuera del conjunto de fuentes conocidas: ${JSON.stringify(f.name)}` };
    }
    const src = resolveWithin(dir, f.name);
    if (!src) {
      return { ok: false, code: 'unsafe_backup_entry', error: `origen de backup fuera del dir de backup: ${JSON.stringify(f.name)}` };
    }
    let content;
    try {
      content = fs.readFileSync(src, 'utf8');
    } catch (e) {
      return { ok: false, code: 'rollback_read', error: `archivo de backup ausente ${f.name}: ${safeErrorMessage(e)}` };
    }
    if (rawChecksum(content) !== f.checksum) {
      return { ok: false, code: 'backup_corrupt', error: `checksum del backup no coincide para ${f.name} — restore abortado (A05)` };
    }
    plans.push({ dest, content, name: f.name, relPath: f.relPath });
  }

  // 2. Restaurar (los checksums ya se verificaron todos).
  const restored = [];
  for (const p of plans) {
    try {
      fs.writeFileSync(p.dest, p.content);
      restored.push(p.relPath);
    } catch (e) {
      return { ok: false, code: 'rollback_write', error: `fallo al restaurar ${p.relPath}: ${safeErrorMessage(e)}` };
    }
  }
  return { ok: true, restored, dir };
}

// -----------------------------------------------------------------------------
// Observabilidad (paso 6) — reporte legible por secciones
// -----------------------------------------------------------------------------

function pad(str, width) {
  const s = String(str);
  return s.length >= width ? s : s + ' '.repeat(width - s.length);
}

function shortHash(h) {
  return typeof h === 'string' && h.length > 12 ? `${h.slice(0, 8)}…${h.slice(-4)}` : String(h);
}

function rollbackCommand(dir) {
  const rel = path.relative(process.cwd(), dir).split(path.sep).join('/');
  const shown = rel && !rel.startsWith('..') ? rel : dir;
  return `node .pipeline/lib/kernel-store-migrate.js --rollback --from ${shown}`;
}

/**
 * Construye el reporte del operador. Secciones BACKUP → MIGRACIÓN → VERIFICACIÓN
 * → RESULTADO, prefijos ASCII, tabla alineada y línea de rollback siempre visible.
 * La salida se redacta contra patrones de secreto.
 */
function buildReport(ctx) {
  const { mode, backup, before, after, writes, verify, sig, result } = ctx;
  const lines = [];
  const banner = mode === 'dry-run' ? '[DRY-RUN] no se escribió nada'
    : mode === 'rollback' ? '[ROLLBACK] restauración desde backup'
      : '[APPLY] migración al store durable';
  lines.push('== Migración de estado de coordinación JSON -> DynamoDB ==');
  lines.push(banner);
  lines.push('');

  // BACKUP
  lines.push('--- BACKUP ---');
  if (backup) {
    lines.push(`[OK] backup en: ${backup.dir}`);
    lines.push(`     archivos: ${backup.manifest.files.map((f) => f.name).join(', ')}`);
  } else if (mode === 'rollback') {
    lines.push('[ROLLBACK] no se genera backup nuevo (se restaura uno existente)');
  } else {
    lines.push('[FALLA] no se pudo crear el backup');
  }
  lines.push('');

  // MIGRACIÓN / VERIFICACIÓN sólo cuando hay snapshot
  if (before) {
    lines.push('--- MIGRACIÓN ---');
    const header = `${pad('clave', 10)} ${pad('conteo', 7)} ${pad('accion', 10)} ${pad('checksum-antes', 16)} ${pad('checksum-despues', 16)}`;
    lines.push(header);
    for (const [key, snap] of Object.entries(before)) {
      const w = (writes && writes[key]) || {};
      const a = (after && after[key]) || {};
      const action = mode === 'dry-run' ? '(proyectado)' : (w.action || '-');
      lines.push(`${pad(key, 10)} ${pad(snap.recordCount, 7)} ${pad(action, 10)} ${pad(shortHash(snap.checksum), 16)} ${pad(a.checksum ? shortHash(a.checksum) : '(proyectado)', 16)}`);
    }
    if (sig) lines.push(`firmas: ${sig.before}${sig.after != null ? ` -> ${sig.after}` : ''} (preservadas, no migradas)`);
    lines.push('');

    lines.push('--- VERIFICACIÓN ---');
    if (mode === 'dry-run') {
      lines.push('[DRY-RUN] verificación de integridad se ejecuta en modo --apply');
    } else if (verify && verify.ok) {
      lines.push('[OK] integridad verificada: checksum y conteo por clave coinciden antes/después');
    } else if (verify) {
      lines.push('[FALLA] integrity_mismatch — la migración se detuvo (fail-closed):');
      for (const m of verify.mismatches) {
        lines.push(`  - clave "${m.key}": ${m.reason} · esperado ${shortHash(m.expected)} · obtenido ${shortHash(m.got)}`);
      }
      lines.push('  Estado del store: NO confiable. Correr rollback para restaurar los JSON.');
    }
    lines.push('');
  }

  // RESULTADO
  lines.push('--- RESULTADO ---');
  lines.push(result.ok ? `[OK] ${result.message}` : `[FALLA] ${result.code}: ${result.error}`);
  if (backup && mode !== 'rollback') {
    lines.push(`Para revertir: ${rollbackCommand(backup.dir)}`);
  }

  return redactSecrets(lines.join('\n'));
}

// -----------------------------------------------------------------------------
// Orquestador (paso 0..6)
// -----------------------------------------------------------------------------

/**
 * Migra el estado de coordinación JSON al store durable. Errores como dato,
 * nunca throw. Dry-run por default.
 *
 * @param {object} opts
 * @param {boolean} [opts.apply=false]        escribir al store (default: dry-run).
 * @param {boolean} [opts.rollback=false]     modo rollback (requiere `from`).
 * @param {string}  [opts.from]               dir de backup para rollback.
 * @param {string}  [opts.projectId]          identidad estable (default intrale-platform).
 * @param {string}  [opts.sourcesDir]         dir de las 4 fuentes (default .pipeline/).
 * @param {string}  [opts.backupRoot]         raíz de backups (default .pipeline/backup/).
 * @param {object}  [opts.coordinationStore]  store #4744 (requerido para apply/verify).
 * @param {function}[opts.countSignatures]    async () => number (opcional, CA-5).
 * @param {function}[opts.now]                fuente de tiempo (ms).
 * @returns {Promise<object>} { ok, code?, error?, mode, report, ... }
 */
async function migrateState(opts = {}) {
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now();
  const projectId = opts.projectId || DEFAULT_PROJECT_ID;
  const backupRoot = opts.backupRoot || DEFAULT_BACKUP_ROOT;
  const pipelineDir = opts.sourcesDir || PIPELINE_DIR;
  const rollback = opts.rollback === true;
  const apply = opts.apply === true;

  // ---- Modo ROLLBACK --------------------------------------------------------
  if (rollback) {
    const res = restoreFromBackup({ from: opts.from, backupRoot, pipelineDir });
    const result = res.ok
      ? { ok: true, message: `restaurados ${res.restored.length} archivo(s) desde ${res.dir}` }
      : { ok: false, code: res.code, error: res.error };
    const report = buildReport({ mode: 'rollback', backup: null, result });
    return { ...res, mode: 'rollback', report };
  }

  // ---- Cargar fuentes -------------------------------------------------------
  const sourcePaths = resolveSources(pipelineDir);
  const load = loadSources(sourcePaths);
  if (!load.ok) {
    const result = { ok: false, code: load.code, error: load.error };
    return { ok: false, code: load.code, error: load.error, mode: apply ? 'apply' : 'dry-run', report: buildReport({ mode: apply ? 'apply' : 'dry-run', backup: null, result }) };
  }
  const before = snapshotBefore(load.loaded).keys;

  // ---- Backup (paso 1) — SIEMPRE antes de cualquier escritura ---------------
  const backup = createBackup(load.loaded, { backupRoot, pipelineDir, projectId, sourcePaths, now });
  if (!backup.ok) {
    const result = { ok: false, code: backup.code, error: backup.error };
    return { ok: false, code: backup.code, error: backup.error, mode: apply ? 'apply' : 'dry-run', report: buildReport({ mode: apply ? 'apply' : 'dry-run', backup: null, result }) };
  }

  // ---- Conteo de firmas ANTES (CA-5, opcional) ------------------------------
  let sigBefore = null;
  if (typeof opts.countSignatures === 'function') {
    try { sigBefore = await opts.countSignatures(); } catch (e) {
      return failWithBackup({ apply, backup, code: 'signature_count', error: `conteo de firmas (antes) falló: ${safeErrorMessage(e)}` });
    }
  }

  // ---- DRY-RUN: no escribe ---------------------------------------------------
  if (!apply) {
    const result = { ok: true, message: 'dry-run completo — ninguna escritura al store' };
    const report = buildReport({
      mode: 'dry-run', backup, before, after: null, writes: null, verify: null,
      sig: sigBefore != null ? { before: sigBefore } : null, result,
    });
    return { ok: true, mode: 'dry-run', backup: backup.dir, before, report };
  }

  // ---- APPLY: requiere coordination store -----------------------------------
  const store = opts.coordinationStore;
  if (!store || typeof store.getState !== 'function' || typeof store.initState !== 'function') {
    return failWithBackup({ apply, backup, code: 'no_store', error: 'modo --apply requiere un coordination store (#4744) inyectado' });
  }

  // Escritura idempotente por clave (paso 3).
  const writes = {};
  for (const entry of MIGRATION_PLAN) {
    const value = before[entry.key].value;
    const w = await writeKeyThroughStore(store, entry.key, value);
    writes[entry.key] = w;
    if (!w.ok) {
      return failWithBackup({ apply, backup, before, writes, code: w.code, error: w.error });
    }
  }

  // Readback + checksum DESPUÉS (paso 4).
  const after = {};
  for (const entry of MIGRATION_PLAN) {
    let st;
    try {
      st = await store.getState(entry.key);
    } catch (e) {
      return failWithBackup({ apply, backup, before, writes, code: 'readback', error: `readback del store falló para "${entry.key}": ${safeErrorMessage(e)}` });
    }
    after[entry.key] = st ? { checksum: canonicalChecksum(st.value), version: st.version } : null;
  }

  // Conteo de firmas DESPUÉS (CA-5).
  let sigAfter = null;
  if (typeof opts.countSignatures === 'function') {
    try { sigAfter = await opts.countSignatures(); } catch (e) {
      return failWithBackup({ apply, backup, before, writes, after, code: 'signature_count', error: `conteo de firmas (después) falló: ${safeErrorMessage(e)}` });
    }
  }

  // Verificación fail-closed (paso 4).
  const sig = sigBefore != null ? { before: sigBefore, after: sigAfter } : null;
  const verify = verifyIntegrity(before, after, sig);
  if (!verify.ok) {
    const result = { ok: false, code: verify.code, error: 'la verificación de integridad detectó pérdida/alteración' };
    const report = buildReport({ mode: 'apply', backup, before, after, writes, verify, sig, result });
    return { ok: false, code: verify.code, error: result.error, mode: 'apply', backup: backup.dir, before, after, writes, verify, mismatches: verify.mismatches, report, rollbackCmd: rollbackCommand(backup.dir) };
  }

  const result = { ok: true, message: `migradas ${MIGRATION_PLAN.length} clave(s) con integridad verificada` };
  const report = buildReport({ mode: 'apply', backup, before, after, writes, verify, sig, result });
  return { ok: true, mode: 'apply', backup: backup.dir, before, after, writes, verify, report };
}

// Helper para fallar preservando el backup y el reporte (errores como dato).
function failWithBackup({ apply, backup, before, writes, after, code, error }) {
  const result = { ok: false, code, error };
  const report = buildReport({
    mode: apply ? 'apply' : 'dry-run', backup, before: before || null, after: after || null,
    writes: writes || null, verify: null, sig: null, result,
  });
  return { ok: false, code, error, mode: apply ? 'apply' : 'dry-run', backup: backup && backup.dir, report, rollbackCmd: backup ? rollbackCommand(backup.dir) : undefined };
}

// -----------------------------------------------------------------------------
// CLI
// -----------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { apply: false, rollback: false, from: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply' || a === '--commit') args.apply = true;
    else if (a === '--rollback') args.rollback = true;
    else if (a === '--from') args.from = argv[++i];
    else if (a.startsWith('--from=')) args.from = a.slice('--from='.length);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  // El CLI real necesita construir el coordination store (#4744) con la
  // credencial de la instancia. Se hace lazy para no acoplar el require en tests.
  let coordinationStore = null;
  if (args.apply) {
    try {
      const { createCoordinationStore } = require('./kernel-coordination-store');
      coordinationStore = createCoordinationStore({ contextProjectId: DEFAULT_PROJECT_ID });
    } catch (e) {
      process.stdout.write(redactSecrets(`[FALLA] no se pudo inicializar el coordination store: ${safeErrorMessage(e)}\n`));
      process.exit(1);
      return;
    }
  }

  const res = await migrateState({
    apply: args.apply,
    rollback: args.rollback,
    from: args.from,
    coordinationStore,
  });
  process.stdout.write(`${res.report}\n`);
  process.exit(res.ok ? 0 : 1);
}

if (require.main === module) {
  main().catch((e) => {
    process.stdout.write(redactSecrets(`[FALLA] error inesperado: ${safeErrorMessage(e)}\n`));
    process.exit(1);
  });
}

module.exports = {
  migrateState,
  createBackup,
  restoreFromBackup,
  verifyIntegrity,
  writeKeyThroughStore,
  loadSources,
  snapshotBefore,
  composeValue,
  canonicalChecksum,
  rawChecksum,
  redactSecrets,
  safeErrorMessage,
  resolveWithin,
  resolveSources,
  buildReport,
  rollbackCommand,
  parseArgs,
  MIGRATION_PLAN,
  DEFAULT_PROJECT_ID,
  DEFAULT_BACKUP_ROOT,
  PIPELINE_DIR,
};
