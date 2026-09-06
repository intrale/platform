'use strict';

// =============================================================================
// kernel-append-only-reconcile.js — Reconciliación DynamoDB → filesystem de las
// entidades append-only del kernel (#5209, split de #5126).
//
// PARA QUÉ EXISTE
// ---------------
// Apagar `kernel.durable` sin reintegrar lo que se escribió durante la ventana
// durable pierde firmas y auditoría EN SILENCIO: los ítems `signature#`/`audit#`
// siguen en DynamoDB (nadie los borra — la tabla de no-repudio no concede
// `DeleteItem`), pero el pipeline deja de leerlos y nadie se entera. Este módulo
// es la máquina de estados que impide ese apagón:
//
//   precheck → freeze → export → validate → stage → atomic-promote
//            → reread-filesystem → compare → disable-durable → restart
//            → complete-phase → record-R8
//
// Está DELIBERADAMENTE separada de `migrateState`/`rollbackState`
// (kernel-store-migrate.js), que mueven las 4 fuentes de coordinación en el
// sentido contrario (filesystem → DynamoDB) y con otra unidad de trabajo. Acá la
// unidad es un REGISTRO APPEND-ONLY identificado por tipo + ID
// (`signature#<ULID>` / `audit#<ULID>`), y las reglas son distintas:
//
//   - duplicado con MISMO id y MISMO hash  ⇒ idempotente (reintento sano).
//   - MISMO id con hash DISTINTO           ⇒ conflicto FATAL (jamás se pisa).
//   - el conjunto nunca se reemplaza: se UNE con lo que ya había en filesystem.
//     Un registro que ya estaba local no puede desaparecer por reconciliar.
//
// LO QUE NUNCA HACE (invariantes)
// -------------------------------
//   1. NUNCA borra de DynamoDB. El export es sólo lectura; DynamoDB sigue siendo
//      la fuente efectiva hasta que la paridad sea exacta.
//   2. NUNCA habilita el apagado de `kernel.durable` sin paridad EXACTA de IDs,
//      conteos y SHA-256 releídos DEL FILESYSTEM (no de lo que creemos haber
//      escrito). Cualquier excepción aborta dejando `durable: true`.
//   3. NUNCA avanza con conjunto vacío. Un export de 0 registros no es "todo
//      bien": es la sonda que falló. Ese es el falso verde central de #5209.
//   4. NUNCA escribe fuera de la raíz allowlisted. Staging validado con
//      `assertWithin` + `lstat` (no se sigue un symlink), archivos 0600 y
//      directorios 0700, promoción por `rename` (atómica) tras fsync.
//   5. NUNCA emite texto sin pasar por `redactSecrets`.
//
// ESTILO: errores como DATO (`return { ok:false, code, ... }`), NUNCA throw hacia
// afuera, NUNCA "arranca degradado". Espeja `kernel-store-migrate.js`.
// =============================================================================

const fs = require('node:fs');
const path = require('node:path');

const {
  sha256Canonical,
  redactSecrets,
  assertWithin,
} = require('./kernel-store-migrate');

// -----------------------------------------------------------------------------
// Constantes
// -----------------------------------------------------------------------------

const MANIFEST_SCHEMA_VERSION = '1.0';

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

// Tipos append-only reconciliables. El orden fija el orden del reporte y del
// manifiesto (determinismo del hash del manifiesto).
const RECONCILE_TYPES = Object.freeze(['signature', 'audit']);

// Nombre de archivo destino por tipo. JSONL append-only: una línea = un registro.
const FILE_BY_TYPE = Object.freeze({
  signature: 'signatures.jsonl',
  audit: 'audit.jsonl',
});

const MANIFEST_FILE = 'manifest.json';

// Subdirectorio de staging dentro de la raíz allowlisted. El contenido se
// promueve entero o no se promueve nada.
const STAGING_DIR_NAME = '.staging';

// Transiciones de la máquina, en orden. `reconcileDurableToFilesystem` cubre
// hasta `compare`; `runDurableRollbackDrill` sigue con las operativas.
const RECONCILE_STATES = Object.freeze([
  'precheck',
  'freeze',
  'export',
  'validate',
  'stage',
  'atomic-promote',
  'reread-filesystem',
  'compare',
]);

const DRILL_STATES = Object.freeze([
  ...RECONCILE_STATES,
  'disable-durable',
  'restart',
  'complete-phase',
  'record-R8',
]);

// -----------------------------------------------------------------------------
// Copy de errores (se leen en una terminal, en el medio de la operación)
// -----------------------------------------------------------------------------

const ERR_CONJUNTO_VACIO =
  'conjunto_vacio: el export no trajo ni una firma ni una entrada de audit, así que no hay nada que reconciliar ' +
  'y NO se apaga `kernel.durable`.\n' +
  '\n' +
  'Qué pasó: un ensayo de rollback sobre un conjunto vacío siempre da paridad. Eso no prueba que el rollback ' +
  'funcione — prueba que no se probó nada. Por eso acá es un error y no un éxito.\n' +
  '\n' +
  'Qué hacer ahora: generá al menos UNA firma y UNA entrada de audit durante la ventana durable (§8.4 del ' +
  'runbook, sonda positiva) y volvé a correr la reconciliación.\n' +
  '\n' +
  'La trampa: no "destrabes" esto bajando el mínimo a cero. El mínimo es el ensayo.';

const ERR_STAGING_FUERA_DE_RAIZ =
  'staging_fuera_de_raiz: el directorio de trabajo de la reconciliación resolvió FUERA de la raíz permitida y ' +
  'se abortó antes de escribir un solo byte.\n' +
  '\n' +
  'Qué hacer ahora: pasá un `reconcileDir` que cuelgue de la raíz allowlisted (por defecto, dentro de ' +
  '`.pipeline/`). No uses paths absolutos de otro volumen ni `..`.';

// -----------------------------------------------------------------------------
// Utilidades puras
// -----------------------------------------------------------------------------

/** Resultado de error uniforme, con el texto siempre redactado. */
function fail(state, code, message, extra = {}) {
  return Object.assign({
    ok: false,
    state,
    code,
    error: redactSecrets(String(message)),
  }, extra);
}

/**
 * Extrae el ID de un SK append-only (`signature#<id>` → `<id>`).
 * Devuelve `null` si el SK no respeta la gramática — no se adivina.
 */
function idFromSk(type, sk) {
  const prefix = `${type}#`;
  const s = String(sk == null ? '' : sk);
  if (!s.startsWith(prefix)) return null;
  const id = s.slice(prefix.length);
  return id === '' ? null : id;
}

/**
 * Registro canónico de reconciliación. El hash se calcula SOBRE EL CONTENIDO
 * (tipo + id + body), no sobre el envelope completo: el envelope trae metadatos
 * del transporte (schemaVersion, PK) que no deben hacer diverger el hash entre
 * DynamoDB y filesystem.
 */
function toRecord(type, item) {
  const id = idFromSk(type, item && item.SK);
  const payload = {
    type,
    id,
    projectId: item && item.projectId,
    body: (item && item.body) || null,
  };
  return {
    type,
    id,
    sk: item && item.SK,
    projectId: item && item.projectId,
    body: payload.body,
    hash: sha256Canonical(payload),
  };
}

/** Recalcula el hash de un registro leído del filesystem (no se confía en el guardado). */
function recomputeHash(rec) {
  return sha256Canonical({
    type: rec.type,
    id: rec.id,
    projectId: rec.projectId,
    body: rec.body == null ? null : rec.body,
  });
}

/** Clave de identidad de un registro dentro del universo reconciliado. */
function keyOf(rec) {
  return `${rec.type}#${rec.id}`;
}

/** Orden determinístico: por tipo (según RECONCILE_TYPES) y luego por id. */
function sortRecords(records) {
  const rank = (t) => {
    const i = RECONCILE_TYPES.indexOf(t);
    return i < 0 ? RECONCILE_TYPES.length : i;
  };
  return records.slice().sort((a, b) => {
    const ra = rank(a.type);
    const rb = rank(b.type);
    if (ra !== rb) return ra - rb;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/** Conteos por tipo + total. */
function countByType(records) {
  const counts = { total: records.length };
  for (const t of RECONCILE_TYPES) counts[t] = 0;
  for (const r of records) {
    if (Object.prototype.hasOwnProperty.call(counts, r.type)) counts[r.type] += 1;
  }
  return counts;
}

/** Serializa un registro a una línea JSONL (canónica y estable). */
function toLine(rec) {
  return JSON.stringify({
    type: rec.type,
    id: rec.id,
    sk: rec.sk,
    projectId: rec.projectId,
    body: rec.body,
    hash: rec.hash,
  });
}

// -----------------------------------------------------------------------------
// Manifiesto
// -----------------------------------------------------------------------------

/**
 * Construye el manifiesto de la reconciliación: conteos + (tipo,id,hash) de cada
 * registro + hash canónico del conjunto. `manifestHash` cubre TODO lo anterior,
 * así que alterar una sola línea del manifiesto lo invalida.
 */
function buildReconcileManifest(records, opts = {}) {
  const ordered = sortRecords(records);
  const entries = ordered.map((r) => ({ type: r.type, id: r.id, hash: r.hash }));
  const core = {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    createdAt: Number.isFinite(opts.createdAt) ? opts.createdAt : 0,
    projectId: opts.projectId == null ? null : String(opts.projectId),
    counts: countByType(ordered),
    entries,
  };
  return Object.assign({}, core, { manifestHash: sha256Canonical(core) });
}

/**
 * Valida un manifiesto contra un conjunto de registros. Fail-closed en las tres
 * formas de mentira posibles: hash del manifiesto alterado, conteos que no
 * cierran, y entradas que no coinciden una a una con los registros.
 */
function validateReconcileManifest(manifest, records) {
  if (!manifest || typeof manifest !== 'object') {
    return { ok: false, code: 'manifest_ausente', detail: 'no hay manifiesto que validar' };
  }
  const { manifestHash } = manifest;
  const core = Object.assign({}, manifest);
  delete core.manifestHash;
  if (sha256Canonical(core) !== manifestHash) {
    return { ok: false, code: 'manifest_alterado', detail: 'el hash del manifiesto no corresponde a su contenido' };
  }

  const ordered = sortRecords(records);
  const counts = countByType(ordered);
  for (const k of Object.keys(counts)) {
    if (manifest.counts[k] !== counts[k]) {
      return {
        ok: false,
        code: 'conteo_divergente',
        detail: `conteo de "${k}": manifiesto ${manifest.counts[k]}, registros ${counts[k]}`,
      };
    }
  }
  if (!Array.isArray(manifest.entries) || manifest.entries.length !== ordered.length) {
    return {
      ok: false,
      code: 'manifest_incompleto',
      detail: `el manifiesto declara ${Array.isArray(manifest.entries) ? manifest.entries.length : 0} entradas y hay ${ordered.length} registros`,
    };
  }
  for (let i = 0; i < ordered.length; i += 1) {
    const e = manifest.entries[i];
    const r = ordered[i];
    if (e.type !== r.type || e.id !== r.id || e.hash !== r.hash) {
      return {
        ok: false,
        code: 'entrada_divergente',
        detail: `entrada ${i} del manifiesto no coincide con el registro (${e.type}#${e.id} vs ${r.type}#${r.id})`,
      };
    }
  }
  return { ok: true };
}

// -----------------------------------------------------------------------------
// Export desde el store durable
// -----------------------------------------------------------------------------

/**
 * Lee TODAS las firmas y entradas de audit del store durable y las normaliza a
 * registros de reconciliación.
 *
 * Fail-closed: si el store no expone las listas paginadas, o si un ítem no tiene
 * un SK con gramática válida, se aborta. Un export parcial presentado como total
 * es la falla que este módulo existe para impedir.
 */
async function exportAppendOnly(store, opts = {}) {
  if (!store || typeof store.listSignatures !== 'function' || typeof store.listAuditEntries !== 'function') {
    return fail('export', 'store_sin_listado',
      'el store durable no expone `listSignatures`/`listAuditEntries`: no se puede garantizar una lectura completa ' +
      'del append-only, así que no se exporta nada (fail-closed).');
  }
  const pageOpts = Number.isFinite(opts.pageSize) ? { pageSize: opts.pageSize } : {};
  let signatures;
  let audits;
  try {
    signatures = await store.listSignatures(pageOpts);
    audits = await store.listAuditEntries(pageOpts);
  } catch (e) {
    return fail('export', 'export_fallido', `no se pudo leer el append-only del store durable: ${e.message}`);
  }

  const records = [];
  for (const [type, items] of [['signature', signatures], ['audit', audits]]) {
    for (const it of items) {
      const rec = toRecord(type, it);
      if (!rec.id) {
        return fail('export', 'sk_invalido',
          `un ítem ${type} tiene un SK sin id reconocible ("${it && it.SK}"): se aborta el export en vez de inventar una identidad.`);
      }
      records.push(rec);
    }
  }
  return { ok: true, state: 'export', records: sortRecords(records), counts: countByType(records) };
}

// -----------------------------------------------------------------------------
// Lectura del filesystem
// -----------------------------------------------------------------------------

/**
 * Lee los registros ya reintegrados en filesystem. Ausencia de archivo es
 * legítima (primera reconciliación) y devuelve conjunto vacío; un archivo con
 * una línea corrupta NO lo es.
 */
function readFilesystemRecords(reconcileDir) {
  const out = [];
  for (const type of RECONCILE_TYPES) {
    const file = path.join(reconcileDir, FILE_BY_TYPE[type]);
    let raw;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch (e) {
      if (e && e.code === 'ENOENT') continue;
      return fail('reread-filesystem', 'lectura_fallida', `no se pudo leer ${FILE_BY_TYPE[type]}: ${e.message}`);
    }
    const lines = raw.split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i].trim();
      if (line === '') continue;
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch (e) {
        return fail('reread-filesystem', 'linea_corrupta',
          `${FILE_BY_TYPE[type]}:${i + 1} no es JSON válido — se aborta en vez de saltear la línea (saltearla perdería un registro en silencio).`);
      }
      if (parsed.type !== type || !parsed.id) {
        return fail('reread-filesystem', 'linea_invalida',
          `${FILE_BY_TYPE[type]}:${i + 1} declara type "${parsed.type}" o id vacío — inconsistente con el archivo que la contiene.`);
      }
      const rec = {
        type: parsed.type,
        id: parsed.id,
        sk: parsed.sk,
        projectId: parsed.projectId,
        body: parsed.body === undefined ? null : parsed.body,
        hash: parsed.hash,
      };
      // El hash guardado es un dato del archivo, no una autoridad: se recalcula.
      const recomputed = recomputeHash(rec);
      if (recomputed !== rec.hash) {
        return fail('reread-filesystem', 'hash_divergente',
          `${FILE_BY_TYPE[type]}:${i + 1} (${type}#${parsed.id}) tiene un hash que no corresponde a su contenido — archivo alterado.`);
      }
      out.push(rec);
    }
  }
  return { ok: true, records: sortRecords(out) };
}

// -----------------------------------------------------------------------------
// Merge idempotente (la regla de oro del append-only)
// -----------------------------------------------------------------------------

/**
 * Une lo que ya estaba en filesystem con lo exportado de DynamoDB.
 *
 *   mismo id + mismo hash  → idempotente (se cuenta como ya presente)
 *   mismo id + hash != hash → CONFLICTO FATAL (nunca se pisa un append-only)
 *   id nuevo                → se agrega
 *
 * Lo que sólo existe en filesystem se CONSERVA: reconciliar no puede perder un
 * registro local (ese es el modo de falla que convierte "rollback" en "borrado").
 */
function mergeRecords(existing, exported) {
  const byKey = new Map();
  for (const r of existing) byKey.set(keyOf(r), r);

  const added = [];
  const idempotent = [];
  for (const r of exported) {
    const k = keyOf(r);
    const prev = byKey.get(k);
    if (!prev) {
      byKey.set(k, r);
      added.push(r);
      continue;
    }
    if (prev.hash !== r.hash) {
      return {
        ok: false,
        code: 'conflicto_id',
        detail: `${k} existe en filesystem con contenido distinto al de DynamoDB (hash local ${prev.hash.slice(0, 12)}… vs durable ${r.hash.slice(0, 12)}…). ` +
          'Un registro append-only NUNCA se sobreescribe: se aborta la reconciliación conservando DynamoDB como fuente efectiva.',
      };
    }
    idempotent.push(r);
  }
  const onlyLocal = existing.filter((r) => !exported.some((e) => keyOf(e) === keyOf(r)));
  return {
    ok: true,
    records: sortRecords(Array.from(byKey.values())),
    added,
    idempotent,
    onlyLocal,
  };
}

// -----------------------------------------------------------------------------
// Staging + promoción atómica
// -----------------------------------------------------------------------------

/** mkdir con permisos restrictivos, idempotente. */
function mkdirRestrictive(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  try { fs.chmodSync(dir, DIR_MODE); } catch (_) { /* best-effort (Windows) */ }
}

/** Escribe un archivo con permisos restrictivos y fsync (durabilidad antes de promover). */
function writeDurable(file, content) {
  const fd = fs.openSync(file, 'w', FILE_MODE);
  try {
    fs.writeFileSync(fd, content, 'utf8');
    try { fs.fsyncSync(fd); } catch (_) { /* best-effort */ }
  } finally {
    fs.closeSync(fd);
  }
  try { fs.chmodSync(file, FILE_MODE); } catch (_) { /* best-effort */ }
}

/**
 * Rechaza un path que sea un symlink. `assertWithin` resuelve texto; esto mira el
 * inodo. Sin este chequeo, un symlink dentro de la raíz permitida promovería
 * archivos afuera (A01).
 */
function assertNotSymlink(p) {
  let st;
  try {
    st = fs.lstatSync(p);
  } catch (e) {
    if (e && e.code === 'ENOENT') return { ok: true };
    return { ok: false, detail: `no se pudo inspeccionar ${path.basename(p)}: ${e.message}` };
  }
  if (st.isSymbolicLink()) {
    return { ok: false, detail: `${path.basename(p)} es un symlink — se rechaza para no escribir fuera de la raíz permitida` };
  }
  return { ok: true };
}

/**
 * Escribe el conjunto completo en staging (JSONL por tipo + manifiesto).
 * El staging es descartable: si algo falla acá, el destino queda intacto.
 */
function stageReconcileArtifacts(records, manifest, stagingDir) {
  try {
    // Staging siempre limpio: restos de un intento interrumpido no se mezclan.
    fs.rmSync(stagingDir, { recursive: true, force: true });
    mkdirRestrictive(stagingDir);
  } catch (e) {
    return fail('stage', 'staging_mkdir_fallido', `no se pudo preparar el staging: ${e.message}`);
  }
  try {
    for (const type of RECONCILE_TYPES) {
      const lines = records.filter((r) => r.type === type).map(toLine);
      const content = lines.length ? `${lines.join('\n')}\n` : '';
      writeDurable(path.join(stagingDir, FILE_BY_TYPE[type]), content);
    }
    writeDurable(path.join(stagingDir, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`);
  } catch (e) {
    try { fs.rmSync(stagingDir, { recursive: true, force: true }); } catch (_) { /* best-effort */ }
    return fail('stage', 'staging_write_fallido', `no se pudo escribir el staging: ${e.message}`);
  }
  return { ok: true, state: 'stage', stagingDir };
}

/**
 * Promueve el staging al destino con `rename` por archivo (atómico a nivel de
 * archivo en POSIX y en Windows). Si un rename falla a mitad, se restauran los
 * archivos ya movidos desde su copia previa: el destino nunca queda mezclado
 * entre dos generaciones.
 */
function promoteReconcileArtifacts(stagingDir, reconcileDir) {
  const files = [...RECONCILE_TYPES.map((t) => FILE_BY_TYPE[t]), MANIFEST_FILE];
  const backups = [];
  try {
    for (const name of files) {
      const dest = path.join(reconcileDir, name);
      const sym = assertNotSymlink(dest);
      if (!sym.ok) return fail('atomic-promote', 'destino_symlink', sym.detail);
      if (fs.existsSync(dest)) {
        const bak = `${dest}.prev`;
        fs.rmSync(bak, { force: true });
        fs.renameSync(dest, bak);
        backups.push({ dest, bak });
      }
      fs.renameSync(path.join(stagingDir, name), dest);
      try { fs.chmodSync(dest, FILE_MODE); } catch (_) { /* best-effort */ }
    }
  } catch (e) {
    // Rollback de la promoción: devolver cada destino a su generación anterior.
    for (const { dest, bak } of backups.reverse()) {
      try {
        fs.rmSync(dest, { force: true });
        fs.renameSync(bak, dest);
      } catch (_) { /* best-effort: se reporta abajo */ }
    }
    return fail('atomic-promote', 'promocion_fallida',
      `no se pudo promover el staging al destino (se restauró la generación anterior): ${e.message}`);
  }
  for (const { bak } of backups) {
    try { fs.rmSync(bak, { force: true }); } catch (_) { /* best-effort */ }
  }
  try { fs.rmSync(stagingDir, { recursive: true, force: true }); } catch (_) { /* best-effort */ }
  return { ok: true, state: 'atomic-promote', promoted: files };
}

// -----------------------------------------------------------------------------
// Comparación de paridad
// -----------------------------------------------------------------------------

/**
 * Paridad EXACTA entre lo esperado y lo releído del filesystem: mismos IDs,
 * mismos conteos, mismos SHA-256. No hay tolerancia — cualquier diferencia
 * mantiene DynamoDB como fuente efectiva.
 */
function compareParity(expected, actual) {
  const expMap = new Map(expected.map((r) => [keyOf(r), r]));
  const actMap = new Map(actual.map((r) => [keyOf(r), r]));

  const faltantes = [];
  const sobrantes = [];
  const hashDistinto = [];

  for (const [k, r] of expMap) {
    const a = actMap.get(k);
    if (!a) { faltantes.push(k); continue; }
    if (a.hash !== r.hash) hashDistinto.push(k);
  }
  for (const k of actMap.keys()) {
    if (!expMap.has(k)) sobrantes.push(k);
  }

  const expCounts = countByType(expected);
  const actCounts = countByType(actual);
  const conteoDistinto = Object.keys(expCounts).filter((k) => expCounts[k] !== actCounts[k]);

  const ok = faltantes.length === 0 && sobrantes.length === 0
    && hashDistinto.length === 0 && conteoDistinto.length === 0;

  return {
    ok,
    faltantes: faltantes.sort(),
    sobrantes: sobrantes.sort(),
    hashDistinto: hashDistinto.sort(),
    conteoDistinto,
    expectedCounts: expCounts,
    actualCounts: actCounts,
  };
}

// -----------------------------------------------------------------------------
// Audit de aborto
// -----------------------------------------------------------------------------

/**
 * Emite un audit de aborto redactado. Nunca deja caer el aborto original: si el
 * propio audit falla, se anota y se sigue reportando el error real.
 */
async function emitAbortAudit(store, state, code, detail) {
  if (!store || typeof store.appendAuditEntry !== 'function') return { emitted: false, reason: 'store_sin_audit' };
  try {
    await store.appendAuditEntry({
      action: 'kernel.reconcile.abort',
      actor: 'kernel-append-only-reconcile',
      detail: redactSecrets(`state=${state} code=${code} ${detail || ''}`).slice(0, 500),
    });
    return { emitted: true };
  } catch (e) {
    return { emitted: false, reason: redactSecrets(String(e.message)) };
  }
}

// -----------------------------------------------------------------------------
// Máquina de estados: precheck → … → compare
// -----------------------------------------------------------------------------

/**
 * Reconcilia el append-only durable hacia filesystem.
 *
 * @param {object}   p
 * @param {object}   p.store          store durable (kernel-store.js) — sólo lectura + audit de aborto.
 * @param {string}   p.reconcileDir   destino de los JSONL reintegrados.
 * @param {string}  [p.allowedRoot]   raíz allowlisted (default: el padre de `reconcileDir`).
 * @param {boolean} [p.frozen]        la ventana durable debe estar CONGELADA (default false ⇒ aborta).
 * @param {number}  [p.minRecords]    mínimo de registros exportados (default 1 — sonda positiva).
 * @param {number}  [p.now]           timestamp para el manifiesto.
 * @param {number}  [p.pageSize]      tamaño de página del listado.
 * @returns {Promise<object>} `{ ok, state, ... }`
 */
async function reconcileDurableToFilesystem(p = {}) {
  const store = p.store;
  const reconcileDir = p.reconcileDir;
  const now = Number.isFinite(p.now) ? p.now : Date.now();
  const minRecords = Number.isFinite(p.minRecords) ? p.minRecords : 1;

  const abort = async (state, code, message, extra) => {
    const audit = await emitAbortAudit(store, state, code, message);
    return Object.assign(fail(state, code, message, extra), { abortAudit: audit, durableSigueSiendoFuente: true });
  };

  // ---- precheck -------------------------------------------------------------
  if (!store) return fail('precheck', 'store_ausente', 'falta el store durable: no hay de dónde exportar.');
  if (typeof reconcileDir !== 'string' || reconcileDir.trim() === '') {
    return fail('precheck', 'reconcile_dir_ausente', 'falta `reconcileDir`: no hay destino donde reintegrar.');
  }
  const allowedRoot = typeof p.allowedRoot === 'string' && p.allowedRoot.trim() !== ''
    ? p.allowedRoot
    : path.dirname(path.resolve(reconcileDir));
  const resolvedDir = assertWithin(allowedRoot, reconcileDir);
  if (!resolvedDir) return fail('precheck', 'staging_fuera_de_raiz', ERR_STAGING_FUERA_DE_RAIZ);

  const symDir = assertNotSymlink(resolvedDir);
  if (!symDir.ok) return fail('precheck', 'destino_symlink', symDir.detail);

  // ---- freeze ---------------------------------------------------------------
  // La ventana tiene que estar congelada ANTES de exportar. Si entran firmas
  // durante el export, el conjunto exportado ya nació incompleto y la paridad
  // posterior sería sobre un universo que cambió.
  if (p.frozen !== true) {
    return await abort('freeze', 'ventana_no_congelada',
      'ventana_no_congelada: la ventana durable no está congelada, así que no se exporta.\n' +
      '\n' +
      'Qué pasó: si entra una firma nueva mientras se exporta, el export queda viejo y la paridad se calcula ' +
      'contra un universo que ya cambió — daría verde sin serlo.\n' +
      '\n' +
      'Qué hacer ahora: congelá la ventana (§5 del runbook) y volvé a invocar con `frozen: true`.');
  }

  // ---- export ---------------------------------------------------------------
  const exported = await exportAppendOnly(store, { pageSize: p.pageSize });
  if (!exported.ok) return await abort(exported.state, exported.code, exported.error);

  // ---- validate -------------------------------------------------------------
  if (exported.records.length < minRecords) {
    return await abort('validate', 'conjunto_vacio', ERR_CONJUNTO_VACIO, {
      counts: exported.counts,
      minRecords,
    });
  }
  // La sonda positiva de #5209 exige AMBOS tipos: una firma Y un audit. Un
  // conjunto de solo-audit no ejercita la ruta de firmas.
  if (minRecords > 0) {
    const faltanTipos = RECONCILE_TYPES.filter((t) => exported.counts[t] === 0);
    if (faltanTipos.length) {
      return await abort('validate', 'sonda_incompleta',
        `sonda_incompleta: el export no trajo ningún registro de tipo ${faltanTipos.join(', ')}. ` +
        'El ensayo exige al menos UNA firma y UNA entrada de audit generadas durante la ventana durable ' +
        '(§8.4 del runbook): sin las dos, la reconciliación no ejercita ambas rutas.',
        { counts: exported.counts });
    }
  }

  const existing = readFilesystemRecords(resolvedDir);
  if (!existing.ok) return await abort(existing.state, existing.code, existing.error);

  const merged = mergeRecords(existing.records, exported.records);
  if (!merged.ok) return await abort('validate', merged.code, merged.detail, { counts: exported.counts });

  const manifest = buildReconcileManifest(merged.records, {
    createdAt: now,
    projectId: store.contextProjectId,
  });
  const manifestCheck = validateReconcileManifest(manifest, merged.records);
  if (!manifestCheck.ok) return await abort('validate', manifestCheck.code, manifestCheck.detail);

  // ---- stage ----------------------------------------------------------------
  const stagingDir = path.join(resolvedDir, STAGING_DIR_NAME);
  if (!assertWithin(resolvedDir, stagingDir)) {
    return await abort('stage', 'staging_fuera_de_raiz', ERR_STAGING_FUERA_DE_RAIZ);
  }
  try {
    mkdirRestrictive(resolvedDir);
  } catch (e) {
    return await abort('stage', 'reconcile_dir_mkdir_fallido', `no se pudo crear ${path.basename(resolvedDir)}: ${e.message}`);
  }
  const staged = stageReconcileArtifacts(merged.records, manifest, stagingDir);
  if (!staged.ok) return await abort(staged.state, staged.code, staged.error);

  // ---- atomic-promote -------------------------------------------------------
  const promoted = promoteReconcileArtifacts(stagingDir, resolvedDir);
  if (!promoted.ok) return await abort(promoted.state, promoted.code, promoted.error);

  // ---- reread-filesystem ----------------------------------------------------
  // Se relee del DISCO, no se reusa `merged.records`. Comparar contra lo que
  // creemos haber escrito no prueba nada sobre lo que realmente quedó escrito.
  const reread = readFilesystemRecords(resolvedDir);
  if (!reread.ok) return await abort(reread.state, reread.code, reread.error);

  let onDiskManifest = null;
  try {
    onDiskManifest = JSON.parse(fs.readFileSync(path.join(resolvedDir, MANIFEST_FILE), 'utf8'));
  } catch (e) {
    return await abort('reread-filesystem', 'manifest_ilegible', `no se pudo releer el manifiesto promovido: ${e.message}`);
  }
  const onDiskManifestCheck = validateReconcileManifest(onDiskManifest, reread.records);
  if (!onDiskManifestCheck.ok) {
    return await abort('reread-filesystem', onDiskManifestCheck.code, onDiskManifestCheck.detail);
  }

  // ---- compare --------------------------------------------------------------
  const parity = compareParity(merged.records, reread.records);
  if (!parity.ok) {
    return await abort('compare', 'paridad_fallida',
      'paridad_fallida: lo releído del filesystem no coincide exactamente con lo reconciliado. ' +
      `Faltantes: ${parity.faltantes.length}, sobrantes: ${parity.sobrantes.length}, ` +
      `hash distinto: ${parity.hashDistinto.length}. NO se apaga \`kernel.durable\`.`,
      { parity });
  }
  // Cobertura: TODO lo que estaba en DynamoDB tiene que estar en filesystem.
  const coverage = compareParity(exported.records, reread.records);
  const noCubiertos = coverage.faltantes.concat(coverage.hashDistinto);
  if (noCubiertos.length) {
    return await abort('compare', 'cobertura_incompleta',
      `cobertura_incompleta: ${noCubiertos.length} registro(s) de DynamoDB no quedaron íntegros en filesystem. ` +
      'Ningún dato puede quedar únicamente en DynamoDB antes de apagar el flag.',
      { noCubiertos });
  }

  return {
    ok: true,
    state: 'compare',
    reconcileDir: resolvedDir,
    manifest: onDiskManifest,
    counts: countByType(reread.records),
    exportedCounts: exported.counts,
    added: merged.added.map(keyOf),
    idempotent: merged.idempotent.map(keyOf),
    onlyLocal: merged.onlyLocal.map(keyOf),
    parity,
  };
}

// -----------------------------------------------------------------------------
// Ensayo completo de rollback (CA-B6 · #5209)
// -----------------------------------------------------------------------------

/**
 * Corre el ensayo de rollback de punta a punta. Las cuatro etapas operativas
 * (apagar el flag, reiniciar, completar una fase, registrar R8) se inyectan como
 * callbacks: este módulo decide CUÁNDO se permiten, no CÓMO se hacen.
 *
 * La transición a `durable: false` sólo se habilita después de `compare` en
 * verde. Cualquier fallo previo deja el flag como estaba.
 *
 * @param {object}   p                 (además de los de `reconcileDurableToFilesystem`)
 * @param {function} p.disableDurable  apaga `kernel.durable` ⇒ `{ ok }`.
 * @param {function} p.restart         reinicia el pipeline ⇒ `{ ok }`.
 * @param {function} p.completePhase   completa una fase leyendo de filesystem ⇒ `{ ok }`.
 * @param {function} [p.recordR8]      registra el tiempo real de recuperación.
 * @param {function} [p.clock]         fuente de tiempo para medir R8 (default Date.now).
 */
async function runDurableRollbackDrill(p = {}) {
  const clock = typeof p.clock === 'function' ? p.clock : () => Date.now();
  const startedAt = clock();

  const recon = await reconcileDurableToFilesystem(p);
  if (!recon.ok) return Object.assign({}, recon, { drill: false, r8Ms: null });

  const steps = [
    ['disable-durable', p.disableDurable, 'no se pudo apagar `kernel.durable`'],
    ['restart', p.restart, 'no se pudo reiniciar el pipeline'],
    ['complete-phase', p.completePhase, 'no se pudo completar una fase leyendo desde filesystem'],
  ];

  const done = [];
  for (const [state, fn, msg] of steps) {
    if (typeof fn !== 'function') {
      return Object.assign(
        await emitAbortAudit(p.store, state, 'paso_no_provisto', msg).then(() => fail(state, 'paso_no_provisto',
          `paso_no_provisto: falta el callback de "${state}". El ensayo no se puede dar por válido sin ejecutarlo.`)),
        { reconciliacion: recon, completados: done.slice() },
      );
    }
    let res;
    try {
      res = await fn({ reconciliacion: recon });
    } catch (e) {
      res = { ok: false, error: e.message };
    }
    if (!res || res.ok !== true) {
      const detail = `${msg}: ${(res && res.error) || 'el paso no reportó ok:true'}`;
      const audit = await emitAbortAudit(p.store, state, 'paso_fallido', detail);
      return Object.assign(fail(state, 'paso_fallido', detail), {
        reconciliacion: recon,
        completados: done.slice(),
        abortAudit: audit,
      });
    }
    done.push(state);
  }

  // ---- record-R8 ------------------------------------------------------------
  const r8Ms = Math.max(0, clock() - startedAt);
  if (typeof p.recordR8 === 'function') {
    try {
      await p.recordR8({ r8Ms, reconciliacion: recon });
    } catch (e) {
      return Object.assign(fail('record-R8', 'r8_no_registrado',
        `la recuperación terminó pero R8 no se pudo registrar: ${e.message}. Una métrica que no quedó escrita no ocurrió.`),
      { reconciliacion: recon, r8Ms, completados: done.slice() });
    }
  }

  return {
    ok: true,
    state: 'record-R8',
    drill: true,
    r8Ms,
    reconciliacion: recon,
    completados: done.concat(['record-R8']),
  };
}

// -----------------------------------------------------------------------------
// Reporte para el operador (ASCII, sin secretos)
// -----------------------------------------------------------------------------

function renderReconcileReport(result) {
  const L = [];
  L.push('== RECONCILIACIÓN APPEND-ONLY (DynamoDB → filesystem) ==');
  if (!result || typeof result !== 'object') {
    L.push('[FALLA] no hay resultado que reportar');
    return L.join('\n');
  }
  if (result.ok) {
    const c = result.counts || {};
    L.push(`[OK] estado final: ${result.state}`);
    L.push(`     firmas: ${c.signature || 0} · audit: ${c.audit || 0} · total: ${c.total || 0}`);
    L.push(`     nuevos: ${(result.added || []).length} · idempotentes: ${(result.idempotent || []).length} · sólo locales: ${(result.onlyLocal || []).length}`);
    if (result.r8Ms != null) L.push(`     R8 (tiempo real de recuperación): ${result.r8Ms} ms`);
    L.push('     paridad exacta verificada releyendo del filesystem.');
  } else {
    L.push(`[FALLA] abortó en "${result.state}" (${result.code})`);
    for (const line of String(result.error || '').split('\n')) L.push(`     ${line}`);
    L.push('     `kernel.durable` NO se apagó: DynamoDB sigue siendo la fuente efectiva.');
  }
  return redactSecrets(L.join('\n'));
}

module.exports = {
  // máquina de estados
  reconcileDurableToFilesystem,
  runDurableRollbackDrill,
  RECONCILE_STATES,
  DRILL_STATES,
  // etapas (exportadas para tests y para operación por partes)
  exportAppendOnly,
  readFilesystemRecords,
  mergeRecords,
  buildReconcileManifest,
  validateReconcileManifest,
  stageReconcileArtifacts,
  promoteReconcileArtifacts,
  compareParity,
  renderReconcileReport,
  // utilidades / constantes
  RECONCILE_TYPES,
  FILE_BY_TYPE,
  MANIFEST_FILE,
  STAGING_DIR_NAME,
  MANIFEST_SCHEMA_VERSION,
  toRecord,
  idFromSk,
};
