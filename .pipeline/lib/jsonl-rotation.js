// =============================================================================
// jsonl-rotation.js — Mecanismo único de rotación + gzip + retención de JSONL.
// Issue #4174 (split de #3946, EP6-H4, parte 2).
//
// RESPONSABILIDADES
//   - Rotar un JSONL que supera un umbral de tamaño a
//     `<basename>.YYYY-MM-DD.jsonl.gz` (gzip estándar, round-trip gunzip OK),
//     dejando el archivo activo vacío para seguir append (CA-2).
//   - Redacción de secrets (AWS keys, JWT, etc.) ANTES del gzip, reusando
//     `lib/redact.js` (OWASP A09). `redact` queda ON por defecto (CA-2 security).
//   - Retención: borrar `.gz` con mtime > retentionDays, glob acotado a
//     `<basename>.*.jsonl.gz`, no recursivo, sin seguir symlinks (CA-2).
//   - `now` inyectable para tests deterministas (CA-1). Errores no bloquean.
//
// Extraído de `quota-snapshot-persist.js:70-127`. Mecanismo único: los demás
// appenders (anomaly-detector, stop-notify, log-rotation, quota-snapshot)
// delegan acá en vez de mantener lógica divergente.
//
// USO
//   const rot = require('.pipeline/lib/jsonl-rotation');
//   rot.rotateIfNeeded({ path: '/abs/metrics-history.jsonl', redact: true });
//   rot.cleanupOldArchives({ dir, basename: 'metrics-history', retentionDays: 30 });
// =============================================================================
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const redactLib = require('./redact');

// Default: 5 MB, alineado con DEFAULT_JSONL_ROTATE_MB de quota-snapshot-persist.
const DEFAULT_ROTATE_MB = 5;
const DEFAULT_RETENTION_DAYS = 30;

/**
 * Redacta un buffer JSONL línea por línea ANTES del gzip (OWASP A09).
 * Cada línea se parsea como JSON y se aplica `redactObject`; si no parsea,
 * cae a `redactSecretValue` sobre el string crudo. Robusto ante líneas mixtas.
 *
 * @param {Buffer|string} raw
 * @returns {string}
 */
function redactJsonlBuffer(raw) {
  return raw.toString('utf8').split('\n').map((line) => {
    if (!line.trim()) return line;
    try {
      return JSON.stringify(redactLib.redactObject(JSON.parse(line)));
    } catch {
      return redactLib.redactSecretValue(line);
    }
  }).join('\n');
}

/**
 * Rota el JSONL si supera el umbral de tamaño. El archivo rotado se escribe
 * como `<basename>.YYYY-MM-DD.jsonl.gz` (gzip estándar). Colisiones de nombre
 * se resuelven con sufijo `.N`. El archivo activo queda vacío para seguir append.
 *
 * @param {object} opts
 * @param {string} opts.path          Path absoluto del JSONL a rotar.
 * @param {number} [opts.limitMb]     Umbral en MB (default 5).
 * @param {boolean} [opts.redact]     Redactar secrets antes del gzip (default true).
 * @param {function} [opts.now]       Inyectable: devuelve epoch ms. Default Date.now.
 * @returns {{ rotated: boolean, archivePath?: string, error?: string }}
 */
function rotateIfNeeded(opts = {}) {
  const targetPath = opts.path;
  if (!targetPath) return { rotated: false };
  const limitMb = Number.isFinite(opts.limitMb) ? opts.limitMb : DEFAULT_ROTATE_MB;
  const redact = opts.redact !== false; // ON por defecto.
  if (!fs.existsSync(targetPath)) return { rotated: false };

  let size = 0;
  try { size = fs.statSync(targetPath).size; } catch { return { rotated: false }; }
  if (size < limitMb * 1024 * 1024) return { rotated: false };

  const stamp = (opts.now ? new Date(opts.now()) : new Date()).toISOString().slice(0, 10);
  const dir = path.dirname(targetPath);
  const base = path.basename(targetPath, '.jsonl');
  let archivePath = path.join(dir, `${base}.${stamp}.jsonl.gz`);
  // Si ya existe, sufijar con N anti-colisión.
  let counter = 1;
  while (fs.existsSync(archivePath)) {
    archivePath = path.join(dir, `${base}.${stamp}.${counter}.jsonl.gz`);
    counter += 1;
  }

  try {
    let raw = fs.readFileSync(targetPath);
    if (redact) raw = Buffer.from(redactJsonlBuffer(raw), 'utf8'); // ANTES del gzip.
    const gz = zlib.gzipSync(raw);
    fs.writeFileSync(archivePath, gz);
    fs.writeFileSync(targetPath, '', { encoding: 'utf8' });
    return { rotated: true, archivePath };
  } catch (e) {
    // No bloqueamos la pipeline; el caller decide si loguear.
    return { rotated: false, error: e && e.message };
  }
}

/**
 * Borra archivos `.gz` archivados con mtime > retentionDays. Glob acotado a
 * `<basename>.*.jsonl.gz` dentro de `dir` (no recursivo). No sigue symlinks:
 * usa `lstatSync` y saltea los que sean symlink para no borrar fuera de alcance.
 *
 * @param {object} opts
 * @param {string} opts.dir            Directorio donde viven los `.gz`.
 * @param {string} opts.basename       Basename del JSONL (sin extensión).
 * @param {number} [opts.retentionDays] Default 30.
 * @param {function} [opts.now]        Inyectable: devuelve epoch ms. Default Date.now.
 * @returns {{ deleted: number }}
 */
function cleanupOldArchives(opts = {}) {
  const dir = opts.dir;
  const basename = opts.basename;
  if (!dir || !basename) return { deleted: 0 };
  const retentionDays = Number.isFinite(opts.retentionDays)
    ? opts.retentionDays
    : DEFAULT_RETENTION_DAYS;
  if (!fs.existsSync(dir)) return { deleted: 0 };

  // Glob estricto: <basename>.<lo-que-sea>.jsonl.gz — escapamos el basename.
  const escaped = basename.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^${escaped}\\..*\\.jsonl\\.gz$`);

  const cutoffMs = (opts.now ? Number(opts.now()) : Date.now())
    - retentionDays * 24 * 60 * 60 * 1000;
  let entries = [];
  try { entries = fs.readdirSync(dir); } catch { return { deleted: 0 }; }

  let deleted = 0;
  for (const name of entries) {
    if (!re.test(name)) continue;
    const full = path.join(dir, name);
    let stat;
    try { stat = fs.lstatSync(full); } catch { continue; }
    if (stat.isSymbolicLink() || !stat.isFile()) continue; // no seguir symlinks.
    if (stat.mtimeMs < cutoffMs) {
      try { fs.unlinkSync(full); deleted += 1; } catch {}
    }
  }
  return { deleted };
}

module.exports = {
  rotateIfNeeded,
  cleanupOldArchives,
  redactJsonlBuffer,
  DEFAULT_ROTATE_MB,
  DEFAULT_RETENTION_DAYS,
};
