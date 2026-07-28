'use strict';

// =============================================================================
// kernel-store-migrate.js — Migración sin pérdida del estado de coordinación
// (Ola Puente P3 · #4745, split de #4688 · diseño §4.6/§4.9/§5.5)
//
// Migra el estado de coordinación local (JSON) al store durable del kernel
// (`kernel-coordination-store.js` de #4744, DynamoDB namespaceado por projectId):
//
//   waves.json            → coord#waves
//   blocked-issues.json   → coord#blocked
//   blocked-by-infra.json → coord#blocked-by-infra
//   infra-health.json     → coord#health
//
// GARANTÍAS (CA-1..CA-7):
//   1. Backup ANTES de cualquier escritura al store, con <timestamp> INTERNO
//      (nunca derivado de input externo → anti path-traversal, A01), permisos
//      restrictivos (0700 dir / 0600 files, no world-readable · A08).
//   2. Escritura IDEMPOTENTE a través del store (conditional writes de #4744):
//      re-run NO duplica ni corrompe (clave determinística coord#<key>).
//   3. Verificación de integridad FAIL-CLOSED: checksum (sha256 canónico) +
//      conteo por clave, antes/después. Cualquier discrepancia detiene la
//      migración con `{ ok:false, code:'integrity_mismatch' }` (nunca aprueba en
//      silencio). Espeja el rechazo de downgrade de `migrateDescriptor`.
//   4. ROLLBACK que restaura desde el backup verificando PRIMERO el checksum del
//      backup (no reintroducir estado corrupto · A05).
//   5. NO se pierde historia: waves/blocked/health se comparan por contenido;
//      las firmas GATE 2 (append-only en el store durable, #4744) NO viven en
//      estos 4 JSON y este módulo NUNCA las toca — usa SKs `coord#*`, disjuntos
//      de `signature#*`, garantizando que la migración es aditiva/no-destructiva.
//   6. Observabilidad para el operador: reporte en secciones
//      BACKUP → MIGRACIÓN → VERIFICACIÓN → RESULTADO, prefijos ASCII
//      [OK]/[FALLA]/[DRY-RUN]/[ROLLBACK], línea de rollback siempre visible,
//      sin secretos (el backup serializa SOLO el contenido de los 4 JSON).
//
// ESTILO: errores como DATO (`return { ok:false, code, error }`), NUNCA throw,
// NUNCA "arranca degradado" (fail-closed). Espeja `project-descriptor-migrations.js`.
// =============================================================================

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { canonicalize } = require('./project-descriptor');

// Identidad estable del descriptor (diseño §4.6). Es un dato de config confiable,
// NUNCA se deriva de input externo.
const DEFAULT_PROJECT_ID = 'intrale-platform';

// Mapeo fuente → clave de coordinación. `key` respeta el patrón SK del store
// (coord#<key>, con <key> en [A-Za-z0-9._:#-]+). El orden define el orden de
// migración y del reporte.
const SOURCES = Object.freeze([
  { file: 'waves.json', key: 'waves' },
  { file: 'blocked-issues.json', key: 'blocked' },
  { file: 'blocked-by-infra.json', key: 'blocked-by-infra' },
  { file: 'infra-health.json', key: 'health' },
]);

// Allowlist de claves que el store de coordinación debe aceptar para esta
// migración (extiende el default waves/blocked/health con blocked-by-infra).
const MIGRATION_KNOWN_KEYS = Object.freeze(SOURCES.map((s) => s.key));

const BACKUP_DIR_MODE = 0o700;
const BACKUP_FILE_MODE = 0o600;

// Directorio de descriptores de producto (#4821). Es el ORIGEN REAL del alcance
// del cutover: 1:N con `product#<id>` en el store durable. No está en SOURCES.
const DESCRIPTORS_DIR_NAME = 'descriptors';

// Gramática cerrada de nombre de descriptor. Es LITERAL y está hard-codeada a
// propósito (AD-3/R15): NUNCA se deriva del manifest, de un glob ni de un
// readdir del backup. El manifest es contenido no confiable y no puede
// ampliarla. Es el invariante que protege CA-13b.
const DESCRIPTOR_NAME_RE = /^[A-Za-z0-9._-]+\.json$/;

// -----------------------------------------------------------------------------
// Copy de errores (CA-23 · UX-7)
//
// Estos mensajes son UI: se leen en una terminal, en el medio de la operación y
// sin el código de error al lado. Cada uno dice QUÉ PASÓ, QUÉ HACER AHORA y
// —donde aplique— CUÁL ES LA CORRECCIÓN INTUITIVA QUE ESTÁ PROHIBIDA.
// -----------------------------------------------------------------------------

function errSourcesInvalidas(received) {
  return (
    "sources_invalidas: 'sources' debe ser un array de {file,key} u omitirse. " +
    `Recibido: ${Object.prototype.toString.call(received)}. ` +
    'Omitilo para usar el default en dry-run, o pasá [] para no migrar ninguna fuente. ' +
    'Ojo con la trampa: [] NO significa "usar el default" — significa "no migres nada", ' +
    'y se respeta tal cual.'
  );
}

// Nota (AD-1): este código es un error de API, no de CLI. El operador nunca lo
// ve, porque `--apply` corta antes con `alcance_no_implementado`. Por eso el
// mensaje NO menciona ningún flag `--sources` (no existe) ni manda a reintentar
// `--apply` de otra forma: no hay tal camino.
const ERR_SOURCES_NO_EXPLICITAS =
  "sources_no_explicitas: migrateState({ apply: true }) requiere declarar 'sources' " +
  'explícitamente. No pases SOURCES: son las 4 fuentes operativas (waves, blocked, ' +
  'blocked-by-infra, health) que #5112 prohíbe migrar. Para ver el reporte sin mutar ' +
  'nada, invocá con apply: false.';

const ERR_ALCANCE_NO_IMPLEMENTADO =
  'alcance_no_implementado: --apply no puede migrar nada todavía, así que no toca nada.\n' +
  '\n' +
  'Qué pasó: el alcance real del cutover (descriptor#self, product#<id>, catalog#index, ' +
  'signature#, audit#, claim#) todavía NO tiene ruta de migración en este módulo. Las 4 ' +
  'fuentes que este migrador sí sabe mover (waves, blocked, blocked-by-infra, health) son ' +
  'justo las que #5112 prohíbe migrar.\n' +
  '\n' +
  'Qué hacer ahora: los descriptores y el catálogo se pueblan por durableRegisterProduct ' +
  '(.pipeline/lib/project-bootstrap.js, #4821) — no por este migrador. Para ver el reporte ' +
  'del estado de coordinación sin mutar nada, corré este mismo comando SIN flags (dry-run).\n' +
  '\n' +
  'La trampa: no "destrabes" esto pasando SOURCES al migrador. Eso migraría exactamente las ' +
  '4 fuentes operativas prohibidas, que es el falso verde que #5136 existe para evitar.';

// -----------------------------------------------------------------------------
// Utilidades puras
// -----------------------------------------------------------------------------

// sha256 del JSON canónico (claves ordenadas) — determinístico e independiente
// del orden de serialización. Reusa `canonicalize` de project-descriptor.js.
function sha256Canonical(value) {
  return crypto.createHash('sha256').update(canonicalize(value)).digest('hex');
}

// Cuenta "registros" de un valor de estado para el conteo por clave: nº de
// entradas top-level del objeto (grafos/listas/objetos heterogéneos). Un objeto
// vacío cuenta 0; esto detecta pérdida de contenido, no sólo de la clave entera.
function countRecords(value) {
  if (Array.isArray(value)) return value.length;
  if (value && typeof value === 'object') return Object.keys(value).length;
  return value == null ? 0 : 1;
}

// Nombre de directorio de backup a partir de un timestamp INTERNO. Formato
// ISO compacto y seguro para filesystem (sin `:` ni `.`). NUNCA acepta input
// externo → no hay vector de path-traversal.
function backupDirName(epochMs) {
  const iso = new Date(epochMs).toISOString();      // 2026-07-17T18:00:00.000Z
  return iso.replace(/[:.]/g, '-').replace(/-Z$/, 'Z'); // 2026-07-17T18-00-00-000Z
}

// Redacta patrones de secreto conocidos de cualquier texto de salida. Defensa en
// profundidad: los 4 JSON no contienen secretos, pero jamás emitimos algo sin
// pasar por acá (A02).
// Nota: el patrón "AWS secret-like" exige al menos un carácter NO-hex-minúscula
// (mayúscula o `+`/`/`/`=`) en los 40 chars base64. Así evita falsos positivos
// sobre checksums sha256 en hex (dato público de integridad, no secreto) sin
// dejar de capturar claves AWS reales, que son base64 mixto.
const SECRET_PATTERNS = [
  /AKIA[0-9A-Z]{16}/g,                                                 // AWS Access Key ID
  /\b(?=[A-Za-z0-9/+=]{40}\b)[A-Za-z0-9/+=]*[A-Z+/=][A-Za-z0-9/+=]*\b/g, // AWS secret-like (base64 mixto, no hex puro)
  /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,               // JWT
  /(?:password|passwd|secret|token|api[_-]?key)\s*[:=]\s*\S+/gi,
];
function redactSecrets(text) {
  let out = String(text);
  for (const re of SECRET_PATTERNS) out = out.replace(re, '[REDACTED]');
  return out;
}

// -----------------------------------------------------------------------------
// Resolución de paths (fail-closed, anti path-traversal)
// -----------------------------------------------------------------------------

// Raíz del `.pipeline/` cuando este módulo se carga desde `.pipeline/lib/`.
function defaultPipelineDir() {
  return path.resolve(__dirname, '..');
}

// Valida que `fromDir` (input del operador en --rollback) resuelva DENTRO de
// `backupRoot`. Rechaza traversal (`..`, symlinks fuera, paths absolutos ajenos).
function assertWithin(rootDir, candidate) {
  const root = path.resolve(rootDir);
  const resolved = path.resolve(candidate);
  const rel = path.relative(root, resolved);
  if (rel === '' || rel === '.') return resolved;
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    return null;
  }
  return resolved;
}

// -----------------------------------------------------------------------------
// Lectura de las fuentes JSON
// -----------------------------------------------------------------------------

// Lee y parsea las 4 fuentes desde `sourceDir`. Errores como dato. Una fuente
// ausente NO es fatal por sí sola (estado que aún no existe): se reporta como
// `present:false` y se excluye de la migración, pero se registra para el
// reporte del operador.
function readSources(sourceDir, sources) {
  const items = [];
  for (const src of sources) {
    const full = path.join(sourceDir, src.file);
    let present = false;
    let value = null;
    let error = null;
    try {
      if (fs.existsSync(full)) {
        const raw = fs.readFileSync(full, 'utf8');
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          error = `fuente ${src.file} no es un objeto JSON top-level`;
        } else {
          present = true;
          value = parsed;
        }
      }
    } catch (e) {
      error = `no se pudo leer/parsear ${src.file}: ${e.message}`;
    }
    items.push({ ...src, full, present, value, error });
  }
  return items;
}

// -----------------------------------------------------------------------------
// Backup (paso 1)
// -----------------------------------------------------------------------------

function createBackup(items, backupRoot, epochMs) {
  let dir;
  try {
    fs.mkdirSync(backupRoot, { recursive: true, mode: BACKUP_DIR_MODE });
    dir = path.join(backupRoot, backupDirName(epochMs));
    fs.mkdirSync(dir, { recursive: true, mode: BACKUP_DIR_MODE });
    // Reforzar permisos (mkdir respeta umask; chmod es explícito). En Windows es
    // no-op efectivo pero no rompe.
    try { fs.chmodSync(dir, BACKUP_DIR_MODE); } catch (_) { /* best-effort */ }
  } catch (e) {
    return { ok: false, code: 'backup_mkdir_failed', error: `no se pudo crear el backup: ${e.message}` };
  }

  const manifest = { schemaVersion: '1.0', createdAt: epochMs, files: {} };
  for (const it of items) {
    if (!it.present) {
      manifest.files[it.file] = { present: false, key: it.key };
      continue;
    }
    const dest = path.join(dir, it.file);
    const serialized = JSON.stringify(it.value, null, 2);
    try {
      fs.writeFileSync(dest, serialized, { mode: BACKUP_FILE_MODE });
      try { fs.chmodSync(dest, BACKUP_FILE_MODE); } catch (_) { /* best-effort */ }
    } catch (e) {
      return { ok: false, code: 'backup_write_failed', error: `no se pudo escribir backup de ${it.file}: ${e.message}` };
    }
    manifest.files[it.file] = {
      present: true,
      key: it.key,
      checksum: sha256Canonical(it.value),
      records: countRecords(it.value),
    };
  }

  try {
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), { mode: BACKUP_FILE_MODE });
  } catch (e) {
    return { ok: false, code: 'backup_manifest_failed', error: `no se pudo escribir manifest: ${e.message}` };
  }

  return { ok: true, dir, manifest };
}

// -----------------------------------------------------------------------------
// Conteo + checksum (paso 4, antes/después)
// -----------------------------------------------------------------------------

function snapshotSources(items) {
  const snap = {};
  for (const it of items) {
    if (!it.present) continue;
    snap[it.key] = { checksum: sha256Canonical(it.value), records: countRecords(it.value) };
  }
  return snap;
}

async function snapshotStore(store, items) {
  const snap = {};
  for (const it of items) {
    if (!it.present) continue;
    const state = await store.getState(it.key);
    if (!state) continue;
    snap[it.key] = { checksum: sha256Canonical(state.value), records: countRecords(state.value) };
  }
  return snap;
}

// Compara dos snapshots (antes=fuente, después=store). Fail-closed: cualquier
// clave faltante o discrepancia de checksum/conteo ⇒ mismatch.
function compareIntegrity(before, after) {
  const mismatches = [];
  for (const key of Object.keys(before)) {
    const b = before[key];
    const a = after[key];
    if (!a) {
      mismatches.push({ key, reason: 'ausente en el store tras la migración' });
      continue;
    }
    if (b.checksum !== a.checksum) {
      mismatches.push({ key, reason: 'checksum distinto', before: b.checksum, after: a.checksum });
    }
    if (b.records !== a.records) {
      mismatches.push({ key, reason: 'conteo distinto', before: b.records, after: a.records });
    }
  }
  return { ok: mismatches.length === 0, mismatches };
}

// -----------------------------------------------------------------------------
// Escritura idempotente a través del store (paso 3)
// -----------------------------------------------------------------------------

// Escribe una clave de forma idempotente: si no existe, `initState` (create-once);
// si ya existe con el MISMO contenido, no reescribe (idempotencia real, sin
// bump de versión inútil); si existe con contenido distinto, `compareAndSet`
// contra la versión actual. Errores como dato.
async function writeThroughStore(store, item) {
  try {
    const current = await store.getState(item.key);
    if (!current) {
      const res = await store.initState(item.key, item.value);
      if (res.ok) return { ok: true, key: item.key, action: 'created', version: res.version };
      if (res.exists) {
        // Carrera: otra instancia lo creó entre el get y el init. Releer y comparar.
        const again = await store.getState(item.key);
        if (again && sha256Canonical(again.value) === sha256Canonical(item.value)) {
          return { ok: true, key: item.key, action: 'noop', version: again.version };
        }
        return { ok: false, code: 'write_conflict', key: item.key, error: `conflicto de creación concurrente en ${item.key}` };
      }
      return { ok: false, code: 'write_failed', key: item.key, error: `initState falló para ${item.key}` };
    }
    // Ya existe: idempotencia — si el contenido coincide, no reescribir.
    if (sha256Canonical(current.value) === sha256Canonical(item.value)) {
      return { ok: true, key: item.key, action: 'noop', version: current.version };
    }
    const cas = await store.compareAndSet(item.key, item.value, current.version);
    if (cas.ok) return { ok: true, key: item.key, action: 'updated', version: cas.version };
    return { ok: false, code: 'write_conflict', key: item.key, error: `compareAndSet en conflicto para ${item.key} (v=${cas.version})` };
  } catch (e) {
    return { ok: false, code: 'write_exception', key: item.key, error: `excepción escribiendo ${item.key}: ${redactSecrets(e.message)}` };
  }
}

// -----------------------------------------------------------------------------
// Observabilidad (paso 6)
// -----------------------------------------------------------------------------

function rollbackCommand(backupDir) {
  return `node .pipeline/lib/kernel-store-migrate.js --rollback --from ${backupDir}`;
}

function buildReport({ mode, items, before, after, actions, backupDir, integrity }) {
  const lines = [];
  const tag = mode === 'dry-run' ? '[DRY-RUN]' : mode === 'rollback' ? '[ROLLBACK]' : '[APPLY]';
  lines.push(`===== MIGRACIÓN ESTADO DE COORDINACIÓN ${tag} =====`);

  lines.push('');
  lines.push('--- BACKUP ---');
  lines.push(backupDir ? `[OK] backup en: ${backupDir}` : '[--] sin backup (rollback)');

  lines.push('');
  lines.push('--- MIGRACIÓN ---');
  lines.push('clave              | fuente                 | presente | registros | acción');
  for (const it of items) {
    const act = (actions && actions[it.key]) || (it.present ? 'pendiente' : 'ausente');
    const recs = it.present ? countRecords(it.value) : 0;
    lines.push(
      `${it.key.padEnd(18)} | ${it.file.padEnd(22)} | ${(it.present ? 'sí' : 'no').padEnd(8)} | ${String(recs).padEnd(9)} | ${act}`,
    );
  }

  lines.push('');
  lines.push('--- VERIFICACIÓN (checksum sha256 canónico) ---');
  lines.push('clave              | antes (sha256)                                                    | después (sha256)');
  for (const key of Object.keys(before)) {
    const b = before[key] ? before[key].checksum : '(n/a)';
    const a = after && after[key] ? after[key].checksum : '(pendiente)';
    lines.push(`${key.padEnd(18)} | ${b.padEnd(64)} | ${a}`);
  }

  lines.push('');
  lines.push('--- RESULTADO ---');
  if (mode === 'dry-run') {
    lines.push('[DRY-RUN] no se escribió nada. Re-ejecutar con --apply para persistir.');
  } else if (integrity && !integrity.ok) {
    lines.push('[FALLA] verificación de integridad detectó discrepancias:');
    for (const m of integrity.mismatches) lines.push(`  - ${m.key}: ${m.reason}`);
  } else if (mode === 'rollback') {
    lines.push('[OK] estado restaurado desde el backup.');
  } else {
    lines.push('[OK] migración aplicada y verificada.');
  }

  if (backupDir) {
    lines.push('');
    lines.push(`ROLLBACK: ${rollbackCommand(backupDir)}`);
  }

  return redactSecrets(lines.join('\n'));
}

// -----------------------------------------------------------------------------
// API principal
// -----------------------------------------------------------------------------

/**
 * Migra el estado de coordinación JSON → store durable. Fail-closed, errores
 * como dato (NUNCA throw). Modo default: dry-run (no escribe).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * QUÉ MIGRA ESTA FUNCIÓN, Y QUÉ NO (CA-14′ · D-6 · #5136)
 * ─────────────────────────────────────────────────────────────────────────────
 * ESTA FUNCIÓN **NO** PUEBLA LOS DESCRIPTORES NI EL CATÁLOGO DE PRODUCTOS.
 *
 * Los descriptores y el catálogo los puebla `durableRegisterProduct`
 * (`.pipeline/lib/project-bootstrap.js`, #4821). El migrador nunca escribe esas
 * claves: no hay un solo `putProduct`/`putDescriptor` en este módulo.
 *
 * Las claves reales del alcance del cutover, con su nombre literal:
 *
 *   - `descriptor#self`  — SINGULAR por partición: cada partición de proyecto
 *     tiene exactamente UN descriptor propio bajo esa SK fija.
 *   - `product#<id>`     — uno por producto registrado.
 *   - `catalog#index`    — índice del catálogo, SK fija y única.
 *
 * Relación 1:N: el directorio `.pipeline/descriptors/` tiene N archivos y cada
 * uno se proyecta a UN `product#<id>` distinto en el store durable, mientras que
 * `descriptor#self` sigue siendo uno solo por partición. Por eso el backup del
 * alcance real es `backupDescriptors()` (CA-13′) y no `createBackup()`.
 *
 * `SOURCES` (arriba, la constante) son las 4 fuentes OPERATIVAS de coordinación
 * —waves, blocked, blocked-by-infra, health— que #5112 **prohíbe migrar** en el
 * cutover. Son justamente lo que esta función sabe mover, y por eso el CLI
 * `--apply` está bloqueado con `alcance_no_implementado` (D-4).
 *
 * @param {object} opts
 * @param {object}  opts.store        instancia de `createCoordinationStore` (#4744). REQUERIDA para --apply.
 * @param {boolean} [opts.apply=false] false = dry-run (no escribe); true = persiste.
 * @param {string}  [opts.projectId]   identidad del descriptor (default 'intrale-platform').
 * @param {string}  [opts.sourceDir]   dir de las 4 fuentes JSON (default `.pipeline/`).
 * @param {string}  [opts.backupRoot]  raíz de backups (default `.pipeline/backup/`).
 * @param {number}  [opts.now]         epoch ms para el <timestamp> del backup (default Date.now()).
 * @param {Array}   [opts.sources]     DECLARACIÓN DE ALCANCE (ya no es un "override para tests").
 *   Con CA-12′ pasa a ser el contrato: quien muta estado declara qué muta. Tres casos:
 *     - `undefined` → default `SOURCES`, y SÓLO en dry-run (con `apply:true` ⇒ `sources_no_explicitas`).
 *     - array, INCLUIDO el vacío → se respeta tal cual; `[]` no migra ninguna fuente.
 *     - cualquier otra cosa (null, {}, string, number) → `{ ok:false, code:'sources_invalidas' }`.
 * @returns {Promise<{ ok:boolean, code?:string, error?:string, report?:string, backupDir?:string, before?:object, after?:object }>}
 */
async function migrateState(opts = {}) {
  const apply = opts.apply === true;
  const sourceDir = opts.sourceDir || defaultPipelineDir();
  const backupRoot = opts.backupRoot || path.join(defaultPipelineDir(), 'backup');

  // CA-11′ (D-7 / GURU-10) — `sources` tiene TRES casos, no dos. El guard
  // `Array.isArray` no se borra: se convierte en un error como DATO en vez de un
  // fallback silencioso. Nunca throw (contrato del módulo).
  if (opts.sources !== undefined && !Array.isArray(opts.sources)) {
    return { ok: false, code: 'sources_invalidas', error: errSourcesInvalidas(opts.sources) };
  }
  // CA-12′ (SEC-10) — con `apply`, el alcance se DECLARA. Va acá arriba, ANTES
  // del backup: es una operación que muta estado, manda el fail-closed.
  if (apply && opts.sources === undefined) {
    return { ok: false, code: 'sources_no_explicitas', error: ERR_SOURCES_NO_EXPLICITAS };
  }
  // ⚠️ NO reintroducir `&& opts.sources.length`: ésa es exactamente la trampa de
  // CA-11′ — un array vacío es falsy por `.length` y caía al default, migrando
  // las 4 fuentes que #5112 prohíbe migrar. Un `[]` llega tal cual a
  // `readSources`, que devuelve `items = []` ⇒ `no_sources`, que es la semántica
  // correcta de "no migres nada".
  const sources = opts.sources !== undefined ? opts.sources : SOURCES;
  const epochMs = Number.isFinite(opts.now) ? opts.now : Date.now();

  // 0) Leer fuentes.
  const items = readSources(sourceDir, sources);
  const readErr = items.find((it) => it.error);
  if (readErr) {
    return { ok: false, code: 'source_read_failed', error: readErr.error };
  }
  if (!items.some((it) => it.present)) {
    return { ok: false, code: 'no_sources', error: `ninguna fuente presente en ${sourceDir}` };
  }

  // 1) Backup ANTES de cualquier escritura.
  const backup = createBackup(items, backupRoot, epochMs);
  if (!backup.ok) return backup;

  // 4a) Snapshot ANTES (desde las fuentes).
  const before = snapshotSources(items);

  // 3/DRY-RUN) Si no es apply, reportar y salir sin escribir.
  if (!apply) {
    const report = buildReport({ mode: 'dry-run', items, before, after: null, actions: null, backupDir: backup.dir });
    return { ok: true, dryRun: true, report, backupDir: backup.dir, before };
  }

  // Apply requiere store.
  if (!opts.store || typeof opts.store.getState !== 'function') {
    return { ok: false, code: 'store_required', error: 'store de coordinación requerido para --apply', backupDir: backup.dir };
  }

  // 3) Escritura idempotente a través del store.
  const actions = {};
  for (const it of items) {
    if (!it.present) continue;
    const res = await writeThroughStore(opts.store, it);
    if (!res.ok) {
      return {
        ok: false, code: res.code || 'write_failed', error: res.error,
        backupDir: backup.dir, rollbackCmd: rollbackCommand(backup.dir),
      };
    }
    actions[it.key] = res.action;
  }

  // 4b) Snapshot DESPUÉS (readback del store) + verificación fail-closed.
  const after = await snapshotStore(opts.store, items);
  const integrity = compareIntegrity(before, after);
  const report = buildReport({ mode: 'apply', items, before, after, actions, backupDir: backup.dir, integrity });

  if (!integrity.ok) {
    return {
      ok: false, code: 'integrity_mismatch',
      error: 'verificación de integridad detectó pérdida/discrepancia tras la migración',
      mismatches: integrity.mismatches, report, backupDir: backup.dir, rollbackCmd: rollbackCommand(backup.dir),
      before, after,
    };
  }

  return { ok: true, report, backupDir: backup.dir, before, after, actions };
}

/**
 * Restaura las fuentes JSON desde un backup, verificando PRIMERO el checksum de
 * cada archivo del backup contra su manifest (no reintroducir estado corrupto).
 * Fail-closed, errores como dato.
 *
 * @param {object} opts
 * @param {string} opts.fromDir      dir del backup (`.pipeline/backup/<ts>/`).
 * @param {string} [opts.targetDir]  destino de restauración (default `.pipeline/`).
 * @param {string} [opts.backupRoot] raíz permitida para --from (default `.pipeline/backup/`).
 * @returns {{ ok:boolean, code?:string, error?:string, report?:string, restored?:string[] }}
 */
function rollbackState(opts = {}) {
  const backupRoot = opts.backupRoot || path.join(defaultPipelineDir(), 'backup');
  const targetDir = opts.targetDir || defaultPipelineDir();

  if (!opts.fromDir || typeof opts.fromDir !== 'string') {
    return { ok: false, code: 'from_required', error: '--from <backupDir> requerido' };
  }
  // Anti path-traversal: --from DEBE resolver dentro de backupRoot.
  const fromDir = assertWithin(backupRoot, opts.fromDir);
  if (!fromDir) {
    return { ok: false, code: 'from_out_of_root', error: `--from fuera de ${backupRoot} (posible path-traversal, rechazado)` };
  }
  if (!fs.existsSync(fromDir)) {
    return { ok: false, code: 'from_not_found', error: `backup no encontrado: ${fromDir}` };
  }

  // Cargar manifest.
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(fromDir, 'manifest.json'), 'utf8'));
  } catch (e) {
    return { ok: false, code: 'manifest_unreadable', error: `manifest ilegible en el backup: ${e.message}` };
  }

  // Allow-list de nombres de archivo válidos: sólo las fuentes conocidas.
  // Las claves de manifest.files son contenido del backup y NO son de confianza
  // (quien controla el backup controla la clave y su checksum). El checksum NO
  // frena un Zip-Slip porque se recalcula sobre el value provisto.
  const allowedFiles = new Set(SOURCES.map((s) => s.file));

  // Verificar checksum de CADA archivo del backup ANTES de restaurar.
  const restored = [];
  for (const file of Object.keys(manifest.files || {})) {
    const meta = manifest.files[file];
    if (!meta.present) continue;

    // Anti path-traversal (Zip-Slip): la clave del manifest sólo puede ser un
    // basename de la allow-list de fuentes. Cualquier separador de ruta, '..' o
    // path absoluto queda fuera del set → se rechaza fail-closed.
    if (!allowedFiles.has(file)) {
      return {
        ok: false, code: 'unsafe_backup_entry',
        error: `entrada de manifest no permitida "${file}" — sólo se aceptan las fuentes conocidas (posible path-traversal, rechazado)`,
      };
    }
    // Defensa en profundidad: además de la allow-list, se valida que el path
    // resuelto de lectura y de escritura quede DENTRO de fromDir/targetDir.
    const src = assertWithin(fromDir, path.join(fromDir, file));
    const dst = assertWithin(targetDir, path.join(targetDir, file));
    if (!src || !dst) {
      return {
        ok: false, code: 'unsafe_backup_entry',
        error: `entrada de manifest "${file}" escapa del directorio permitido (posible path-traversal, rechazado)`,
      };
    }

    let value;
    try {
      value = JSON.parse(fs.readFileSync(src, 'utf8'));
    } catch (e) {
      return { ok: false, code: 'backup_file_unreadable', error: `archivo de backup ilegible ${file}: ${e.message}` };
    }
    const actual = sha256Canonical(value);
    if (actual !== meta.checksum) {
      return {
        ok: false, code: 'backup_corrupt',
        error: `checksum del backup no coincide para ${file} (esperado ${meta.checksum}, actual ${actual}) — NO se restaura estado corrupto`,
      };
    }
    // Checksum OK → restaurar (dst validado dentro de targetDir).
    try {
      fs.writeFileSync(dst, JSON.stringify(value, null, 2));
      restored.push(file);
    } catch (e) {
      return { ok: false, code: 'restore_write_failed', error: `no se pudo restaurar ${file}: ${e.message}` };
    }
  }

  const report = buildReport({
    mode: 'rollback',
    items: SOURCES.map((s) => ({ ...s, present: restored.includes(s.file), value: {} })),
    before: {}, after: {}, actions: null, backupDir: fromDir,
  });
  return { ok: true, report, restored, fromDir };
}

// -----------------------------------------------------------------------------
// Backup / restore de DESCRIPTORES (CA-13′ / CA-13b · #5136)
//
// `createBackup` respalda las 4 fuentes OPERATIVAS de coordinación, que son
// justo las que #5112 prohíbe migrar. El origen del ALCANCE REAL del cutover es
// `.pipeline/descriptors/` (1:N con `product#<id>`), que NO está en `SOURCES` —
// o sea que hoy el alcance real no tiene ni backup ni ruta de restauración.
// Estos dos helpers cierran ese hueco, con los mismos controles vigentes
// (0700/0600, sha256 canónico, `assertWithin`) y en DESTINO PROPIO con MANIFEST
// PROPIO, de modo que nunca puedan pisar el `manifest.json` de `createBackup`
// para el mismo epoch (GURU-11: `backupDirName` es puro ⇒ mismo epoch, mismo dir).
//
// `rollbackState` y su `allowedFiles` NO se tocan (AD-3): su blindaje
// anti-Zip-Slip funciona PORQUE el set es cerrado y literal.
// -----------------------------------------------------------------------------

function defaultDescriptorsDir() {
  return path.join(defaultPipelineDir(), DESCRIPTORS_DIR_NAME);
}

/**
 * Respalda `.pipeline/descriptors/` bajo `<backupRoot>/<ts>/descriptors/`, con
 * manifest propio. Fail-closed, errores como dato (NUNCA throw).
 *
 * @param {object} opts
 * @param {string} [opts.descriptorsDir] origen (default `.pipeline/descriptors/`).
 * @param {string} [opts.backupRoot]     raíz de backups (default `.pipeline/backup/`).
 * @param {number} [opts.epochMs]        epoch ms del <timestamp> (default Date.now()).
 * @returns {{ ok:boolean, code?:string, error?:string, dir?:string, manifest?:object, count?:number }}
 */
function backupDescriptors(opts = {}) {
  const descriptorsDir = opts.descriptorsDir || defaultDescriptorsDir();
  const backupRoot = opts.backupRoot || path.join(defaultPipelineDir(), 'backup');
  const epochMs = Number.isFinite(opts.epochMs) ? opts.epochMs : Date.now();

  // 0) Enumerar descriptores con la MISMA gramática cerrada que usa la
  //    restauración. Orden estable para que el manifest sea determinístico.
  let names;
  try {
    names = fs.existsSync(descriptorsDir)
      ? fs.readdirSync(descriptorsDir).filter((n) => DESCRIPTOR_NAME_RE.test(n)).sort()
      : [];
  } catch (e) {
    return {
      ok: false,
      code: 'descriptors_backup_read_failed',
      error: `descriptors_backup_read_failed: no se pudo listar ${descriptorsDir}: ${e.message}. `
        + 'Qué hacer ahora: verificá que el directorio exista y sea legible por el usuario que corre el cutover, y reintentá ANTES de tocar el store.',
    };
  }
  // Fail-closed: un backup vacío que devuelve ok es exactamente el falso verde
  // que esta historia existe para evitar. Sin descriptores no hay qué respaldar,
  // y el operador tiene que enterarse ANTES del cutover, no después.
  if (names.length === 0) {
    return {
      ok: false,
      code: 'descriptors_absent',
      error: `descriptors_absent: no hay ningún descriptor .json en ${descriptorsDir}, así que no hay nada que respaldar. `
        + 'Qué hacer ahora: NO sigas con el cutover. Un backup de descriptores vacío no protege nada. '
        + 'Los descriptores los puebla durableRegisterProduct (.pipeline/lib/project-bootstrap.js, #4821): verificá que el bootstrap del proyecto haya corrido.',
    };
  }

  // 1) Destino PROPIO: `<backupRoot>/<ts>/descriptors/`. Un nivel por debajo del
  //    dir de `createBackup`, así los dos manifests conviven para el mismo epoch.
  const parentDir = path.join(backupRoot, backupDirName(epochMs));
  const dir = path.join(parentDir, DESCRIPTORS_DIR_NAME);
  if (!assertWithin(backupRoot, dir)) {
    return {
      ok: false,
      code: 'descriptors_backup_out_of_root',
      error: `descriptors_backup_out_of_root: el destino de backup ${dir} cae fuera de ${backupRoot} (rechazado). `
        + 'Qué hacer ahora: revisá `backupRoot`; no se escribe nada fuera de la raíz de backups.',
    };
  }
  try {
    fs.mkdirSync(backupRoot, { recursive: true, mode: BACKUP_DIR_MODE });
    fs.mkdirSync(parentDir, { recursive: true, mode: BACKUP_DIR_MODE });
    fs.mkdirSync(dir, { recursive: true, mode: BACKUP_DIR_MODE });
    // mkdir respeta umask; el chmod explícito es el que garantiza el modo.
    try { fs.chmodSync(parentDir, BACKUP_DIR_MODE); } catch (_) { /* best-effort */ }
    try { fs.chmodSync(dir, BACKUP_DIR_MODE); } catch (_) { /* best-effort */ }
  } catch (e) {
    return {
      ok: false,
      code: 'descriptors_backup_mkdir_failed',
      error: `descriptors_backup_mkdir_failed: no se pudo crear ${dir}: ${e.message}. `
        + 'Qué hacer ahora: liberá espacio o corregí permisos sobre .pipeline/backup/ y reintentá ANTES del cutover.',
    };
  }

  // 2) Copiar cada descriptor + checksum canónico.
  const manifest = { schemaVersion: '1.0', kind: 'descriptors', createdAt: epochMs, files: {} };
  for (const name of names) {
    const src = assertWithin(descriptorsDir, path.join(descriptorsDir, name));
    const dest = assertWithin(dir, path.join(dir, name));
    if (!src || !dest) {
      return {
        ok: false,
        code: 'descriptors_backup_out_of_root',
        error: `descriptors_backup_out_of_root: "${name}" escapa del directorio permitido (rechazado). `
          + 'Qué hacer ahora: revisá el contenido de .pipeline/descriptors/; no se respalda nada fuera de ese directorio.',
      };
    }
    // Se respalda el archivo BYTE A BYTE (Buffer, sin re-serializar). Los
    // descriptores están versionados en git y con CRLF: re-serializarlos haría
    // que la restauración devuelva un archivo semánticamente igual pero
    // byte-distinto, ensuciando el `git diff` justo cuando el operador está
    // tratando de volver atrás. El checksum, en cambio, es CANÓNICO (indiferente
    // al formato), igual que en `createBackup`.
    let raw;
    let value;
    try {
      raw = fs.readFileSync(src);
      value = JSON.parse(raw.toString('utf8'));
    } catch (e) {
      return {
        ok: false,
        code: 'descriptors_backup_read_failed',
        error: `descriptors_backup_read_failed: no se pudo leer/parsear ${name}: ${e.message}. `
          + 'Qué hacer ahora: NO sigas con el cutover. Un descriptor ilegible no se puede respaldar con checksum, '
          + 'y sin checksum la restauración no puede garantizar que lo que vuelve es lo que había. Arreglá el archivo y reintentá.',
      };
    }
    try {
      fs.writeFileSync(dest, raw, { mode: BACKUP_FILE_MODE });
      try { fs.chmodSync(dest, BACKUP_FILE_MODE); } catch (_) { /* best-effort */ }
    } catch (e) {
      return {
        ok: false,
        code: 'descriptors_backup_write_failed',
        error: `descriptors_backup_write_failed: no se pudo escribir el backup de ${name}: ${e.message}. `
          + 'Qué hacer ahora: liberá espacio o corregí permisos sobre .pipeline/backup/ y reintentá ANTES del cutover.',
      };
    }
    manifest.files[name] = {
      present: true,
      checksum: sha256Canonical(value),
      records: countRecords(value),
    };
  }

  // 3) Manifest PROPIO, dentro del subdirectorio. Nunca pisa el de createBackup.
  try {
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), { mode: BACKUP_FILE_MODE });
    try { fs.chmodSync(path.join(dir, 'manifest.json'), BACKUP_FILE_MODE); } catch (_) { /* best-effort */ }
  } catch (e) {
    return {
      ok: false,
      code: 'descriptors_manifest_failed',
      error: `descriptors_manifest_failed: no se pudo escribir el manifest de descriptores: ${e.message}. `
        + 'Qué hacer ahora: NO sigas con el cutover. Sin manifest no hay checksums, y sin checksums el backup no es restaurable.',
    };
  }

  return { ok: true, dir, manifest, count: names.length };
}

/**
 * Restaura descriptores desde un backup producido por `backupDescriptors`,
 * verificando PRIMERO el checksum de cada entrada (no reintroducir estado
 * corrupto · A05). Fail-closed, errores como dato (NUNCA throw).
 *
 * Contención anti-Zip-Slip (AD-3 / R15): como los basenames son dinámicos (1:N
 * con `product#<id>`), el conjunto cerrado NO puede ser una lista literal de
 * nombres — es una GRAMÁTICA cerrada, hard-codeada, que el manifest no puede
 * ampliar. Triple contención independiente: identidad de basename, regex
 * literal, y `assertWithin` sobre ORIGEN y DESTINO.
 *
 * Valida TODAS las entradas antes de escribir ninguna: si una sola se rechaza,
 * no se escribe nada (fail-closed real, no "a medias").
 *
 * @param {object} opts
 * @param {string} opts.fromDir      dir del backup (`.pipeline/backup/<ts>/descriptors/`).
 * @param {string} [opts.targetDir]  destino (default `.pipeline/descriptors/`).
 * @param {string} [opts.backupRoot] raíz permitida (default `.pipeline/backup/`).
 * @returns {{ ok:boolean, code?:string, error?:string, restored?:string[], fromDir?:string, targetDir?:string }}
 */
function restoreDescriptors(opts = {}) {
  const backupRoot = opts.backupRoot || path.join(defaultPipelineDir(), 'backup');
  const targetDir = opts.targetDir || defaultDescriptorsDir();

  if (!opts.fromDir || typeof opts.fromDir !== 'string') {
    return {
      ok: false,
      code: 'descriptors_from_required',
      error: 'descriptors_from_required: falta indicar el directorio del backup de descriptores. '
        + 'Qué hacer ahora: pasá `fromDir` apuntando a .pipeline/backup/<timestamp>/descriptors/ (el subdirectorio, no el <timestamp> pelado).',
    };
  }
  // Anti path-traversal: `fromDir` DEBE resolver dentro de backupRoot.
  const fromDir = assertWithin(backupRoot, opts.fromDir);
  if (!fromDir) {
    return {
      ok: false,
      code: 'descriptors_from_out_of_root',
      error: `descriptors_from_out_of_root: el origen cae fuera de ${backupRoot} (posible path-traversal, rechazado). `
        + 'Qué hacer ahora: sólo se restaura desde .pipeline/backup/; copiá el backup adentro de esa raíz si viene de otro lado.',
    };
  }
  if (!fs.existsSync(fromDir)) {
    return {
      ok: false,
      code: 'descriptors_from_not_found',
      error: `descriptors_from_not_found: no existe el backup ${fromDir}. `
        + 'Qué hacer ahora: listá .pipeline/backup/ y elegí un <timestamp> que tenga subdirectorio descriptors/. '
        + 'Ojo con la trampa: el backup de coordinación y el de descriptores son artefactos DISTINTOS; restaurar uno no restaura el otro.',
    };
  }

  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(fromDir, 'manifest.json'), 'utf8'));
  } catch (e) {
    return {
      ok: false,
      code: 'descriptors_manifest_unreadable',
      error: `descriptors_manifest_unreadable: manifest ilegible en ${fromDir}: ${e.message}. `
        + 'Qué hacer ahora: NO restaures sin manifest — sin checksums no se puede verificar qué vuelve. Elegí otro backup.',
    };
  }

  // Paso 1: VALIDAR TODO (gramática + checksum). Sin escribir una sola línea.
  const planned = [];
  for (const file of Object.keys((manifest && manifest.files) || {})) {
    const meta = manifest.files[file];
    if (!meta || !meta.present) continue;

    // El contenido del manifest NO es de confianza: quien controla el backup
    // controla la clave Y su checksum. Por eso el checksum no frena un Zip-Slip
    // y la gramática cerrada es la que contiene.
    const unsafe = file !== path.basename(file)
      || file === '.' || file === '..'
      || !DESCRIPTOR_NAME_RE.test(file);
    if (unsafe) {
      return {
        ok: false,
        code: 'unsafe_descriptor_entry',
        error: `unsafe_descriptor_entry: entrada de manifest no permitida "${file}" — sólo se aceptan basenames <nombre>.json sin separadores de ruta (posible path-traversal, rechazado). `
          + 'Qué hacer ahora: descartá ese backup, es sospechoso. No se restauró nada.',
      };
    }
    // Defensa en profundidad: origen Y destino deben quedar adentro.
    const src = assertWithin(fromDir, path.join(fromDir, file));
    const dst = assertWithin(targetDir, path.join(targetDir, file));
    if (!src || !dst) {
      return {
        ok: false,
        code: 'unsafe_descriptor_entry',
        error: `unsafe_descriptor_entry: la entrada "${file}" escapa del directorio permitido (posible path-traversal, rechazado). `
          + 'Qué hacer ahora: descartá ese backup. No se restauró nada.',
      };
    }

    // Se leen los bytes crudos: se verifica el checksum CANÓNICO sobre el valor
    // parseado (fail-closed, indiferente al formato) pero se restaura el archivo
    // BYTE A BYTE, para no ensuciar el `git diff` de un archivo versionado.
    let raw;
    let value;
    try {
      raw = fs.readFileSync(src);
      value = JSON.parse(raw.toString('utf8'));
    } catch (e) {
      return {
        ok: false,
        code: 'descriptors_backup_file_unreadable',
        error: `descriptors_backup_file_unreadable: archivo de backup ilegible ${file}: ${e.message}. `
          + 'Qué hacer ahora: elegí otro backup. No se restauró nada.',
      };
    }
    const actual = sha256Canonical(value);
    if (actual !== meta.checksum) {
      return {
        ok: false,
        code: 'descriptors_backup_corrupt',
        error: `descriptors_backup_corrupt: el checksum de ${file} no coincide (esperado ${meta.checksum}, actual ${actual}) — NO se restaura estado corrupto. `
          + 'Qué hacer ahora: elegí otro <timestamp> de backup. No se restauró nada.',
      };
    }
    planned.push({ file, dst, raw });
  }

  // Paso 2: recién ahora, escribir.
  try {
    fs.mkdirSync(targetDir, { recursive: true });
  } catch (e) {
    return {
      ok: false,
      code: 'descriptors_restore_mkdir_failed',
      error: `descriptors_restore_mkdir_failed: no se pudo crear ${targetDir}: ${e.message}. `
        + 'Qué hacer ahora: corregí permisos sobre .pipeline/ y reintentá. No se restauró nada.',
    };
  }
  const restored = [];
  for (const p of planned) {
    try {
      fs.writeFileSync(p.dst, p.raw);
      restored.push(p.file);
    } catch (e) {
      return {
        ok: false,
        code: 'descriptors_restore_write_failed',
        error: `descriptors_restore_write_failed: no se pudo restaurar ${p.file}: ${e.message}. `
          + `Qué hacer ahora: corregí permisos y reintentá. Restauración PARCIAL: ya volvieron [${restored.join(', ') || 'ninguno'}].`,
      };
    }
  }

  return { ok: true, restored, fromDir, targetDir };
}

// -----------------------------------------------------------------------------
// CLI
// -----------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { apply: false, rollback: false, from: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--apply' || a === '--commit') args.apply = true;
    else if (a === '--rollback') args.rollback = true;
    else if (a === '--from') { args.from = argv[i + 1]; i += 1; }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.rollback) {
    const res = rollbackState({ fromDir: args.from });
    process.stdout.write((res.report || res.error || '') + '\n');
    process.exit(res.ok ? 0 : 1);
    return;
  }

  if (!args.apply) {
    // Dry-run no necesita store (no escribe).
    const res = await migrateState({ apply: false });
    process.stdout.write((res.report || res.error || '') + '\n');
    process.exit(res.ok ? 0 : 1);
    return;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // D-4 / CA-12b / AD-2 (#5136) · Guard de alcance del CLI.
  //
  // El alcance real del cutover (descriptor#self / product#<id> / catalog#index /
  // signature# / audit# / claim#) todavía NO tiene ruta de migración en este
  // módulo, y `SOURCES` son justo las 4 fuentes operativas que #5112 prohíbe
  // migrar. Hasta que esa ruta exista, `--apply` dice la verdad y no toca nada.
  //
  // Va ACÁ, y no más abajo, por dos motivos duros (AD-2):
  //   (a) un comando que no puede hacer nada NO debe exigir credenciales AWS;
  //   (b) `defaultPipelineDir()` resuelve al `.pipeline/` REAL del repo, así que
  //       un guard puesto después de `migrateState({ apply:true })` escribiría un
  //       backup real en `.pipeline/backup/` antes de fallar. Acá el efecto de
  //       filesystem es CERO, que es lo que hace ejecutable y seguro al test CLI.
  //
  // ⚠️ PUNTO DE REACTIVACIÓN — NO BORRAR el bloque de abajo (R14). Queda
  // inalcanzable desde el CLI a propósito, no es dead code accidental: es el
  // punto exacto donde se reengancha el `--apply` cuando aterrice la ruta de
  // migración del alcance real.
  // ───────────────────────────────────────────────────────────────────────────
  process.stdout.write(ERR_ALCANCE_NO_IMPLEMENTADO + '\n');
  // `exitCode` en vez de `process.exit()`: en Windows stdout hacia un pipe es
  // asíncrono y `process.exit()` puede truncar el mensaje. Salir naturalmente
  // garantiza el flush, y el código de salida sigue siendo ≠ 0 (CA-12b).
  process.exitCode = 1;
  return;

  // --apply: instanciar el store real. Se hace lazy para no requerir credenciales
  // en dry-run/rollback ni en el import del módulo (los tests inyectan su store).
  // eslint-disable-next-line no-unreachable
  let store;
  try {
    const { createCoordinationStore } = require('./kernel-coordination-store');
    const { loadDescriptor } = require('./project-descriptor');
    const desc = loadDescriptor ? loadDescriptor() : null;
    const projectId = (desc && desc.identity && desc.identity.projectId) || DEFAULT_PROJECT_ID;
    store = createCoordinationStore({ contextProjectId: projectId, knownKeys: MIGRATION_KNOWN_KEYS });
  } catch (e) {
    process.stdout.write(`[FALLA] no se pudo instanciar el store de coordinación: ${redactSecrets(e.message)}\n`);
    process.exit(1);
    return;
  }
  const res = await migrateState({ apply: true, store });
  process.stdout.write((res.report || res.error || '') + '\n');
  process.exit(res.ok ? 0 : 1);
}

if (require.main === module) {
  main().catch((e) => {
    process.stdout.write(`[FALLA] error inesperado: ${redactSecrets(e && e.message)}\n`);
    process.exit(1);
  });
}

module.exports = {
  migrateState,
  rollbackState,
  // exportados para reuso/tests
  SOURCES,
  MIGRATION_KNOWN_KEYS,
  DEFAULT_PROJECT_ID,
  sha256Canonical,
  countRecords,
  compareIntegrity,
  redactSecrets,
  createBackup,
  readSources,
  parseArgs,
  // Backup/restore del ALCANCE REAL del cutover (#5136 · CA-13′/CA-13b).
  backupDescriptors,
  restoreDescriptors,
};
