// =============================================================================
// quota-snapshot-persist.js — Persistencia + retención + rotación del JSONL.
// Issue #3012 (split de #3008, hija 1).
//
// RESPONSABILIDADES
//   - Append-only en `.pipeline/.quota-history.jsonl` (CA-3).
//   - Rotación del JSONL > N MB (default 5MB) a
//     `.quota-history.YYYY-MM-DD.jsonl.gz` (CA-17).
//   - Retención automática: PNG > 30 días eliminados (CA-17).
//   - Filesystem como única fuente de verdad. Errores no bloquean (CA-16).
//
// ENV VARS
//   QUOTA_PNG_RETENTION_DAYS    default 30. PNG > N días eliminado.
//   QUOTA_JSONL_ROTATE_MB       default 5. JSONL > N MB rotado.
//
// USO
//   const persist = require('.pipeline/lib/quota-snapshot-persist');
//   persist.appendSnapshot(snapshot);
//   persist.rotateIfNeeded();
//   persist.cleanupOldPngs();
// =============================================================================
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const PIPELINE_DIR = path.resolve(__dirname, '..');
const DEFAULT_HISTORY_PATH = path.join(PIPELINE_DIR, '.quota-history.jsonl');
const DEFAULT_PNG_DIR = path.join(PIPELINE_DIR, 'quota-snapshots');

const DEFAULT_PNG_RETENTION_DAYS = parseEnvInt('QUOTA_PNG_RETENTION_DAYS', 30, 1, 3650);
const DEFAULT_JSONL_ROTATE_MB = parseEnvInt('QUOTA_JSONL_ROTATE_MB', 5, 1, 1024);

function parseEnvInt(name, fallback, min, max) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < min || n > max) return fallback;
  return n;
}

/**
 * Append-only de un snapshot ya validado. Una línea JSON por entrada (CA-3).
 *
 * @param {object} snapshot   Validado por `quota-snapshot-parser.parseSnapshot`.
 * @param {object} [opts]
 * @param {string} [opts.historyPath]   Override del path del JSONL.
 */
function appendSnapshot(snapshot, opts = {}) {
  if (!snapshot || typeof snapshot !== 'object') {
    throw new Error('appendSnapshot: snapshot vacio');
  }
  const targetPath = opts.historyPath || DEFAULT_HISTORY_PATH;
  const dir = path.dirname(targetPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const line = JSON.stringify(snapshot) + '\n';
  fs.appendFileSync(targetPath, line, { encoding: 'utf8' });
}

/**
 * Rota el JSONL si supera el umbral de tamaño. El archivo rotado se escribe
 * como `.quota-history.YYYY-MM-DD.jsonl.gz` (gzip estándar) y el JSONL queda
 * vacío para seguir append.
 *
 * @returns {{ rotated: boolean, archivePath?: string }}
 */
function rotateIfNeeded(opts = {}) {
  const targetPath = opts.historyPath || DEFAULT_HISTORY_PATH;
  const limitMb = Number.isFinite(opts.limitMb) ? opts.limitMb : DEFAULT_JSONL_ROTATE_MB;
  if (!fs.existsSync(targetPath)) return { rotated: false };

  let size = 0;
  try { size = fs.statSync(targetPath).size; } catch { return { rotated: false }; }
  if (size < limitMb * 1024 * 1024) return { rotated: false };

  const stamp = (opts.now ? new Date(opts.now()) : new Date()).toISOString().slice(0, 10);
  const dir = path.dirname(targetPath);
  const base = path.basename(targetPath, '.jsonl');
  let archivePath = path.join(dir, `${base}.${stamp}.jsonl.gz`);
  // Si ya existe, sufijar con N.
  let counter = 1;
  while (fs.existsSync(archivePath)) {
    archivePath = path.join(dir, `${base}.${stamp}.${counter}.jsonl.gz`);
    counter += 1;
  }

  try {
    const raw = fs.readFileSync(targetPath);
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
 * Borra PNG con mtime > retentionDays. Retorna count de archivos eliminados.
 */
function cleanupOldPngs(opts = {}) {
  const dir = opts.pngDir || DEFAULT_PNG_DIR;
  const retentionDays = Number.isFinite(opts.retentionDays)
    ? opts.retentionDays
    : DEFAULT_PNG_RETENTION_DAYS;
  if (!fs.existsSync(dir)) return { deleted: 0 };

  const cutoffMs = (opts.now ? Number(opts.now()) : Date.now()) - retentionDays * 24 * 60 * 60 * 1000;
  let entries = [];
  try { entries = fs.readdirSync(dir); } catch { return { deleted: 0 }; }

  let deleted = 0;
  for (const name of entries) {
    if (!/^quota-.*\.png$/i.test(name)) continue;
    const full = path.join(dir, name);
    let mtime = 0;
    try { mtime = fs.statSync(full).mtimeMs; } catch { continue; }
    if (mtime < cutoffMs) {
      try { fs.unlinkSync(full); deleted += 1; } catch {}
    }
  }
  return { deleted };
}

module.exports = {
  appendSnapshot,
  rotateIfNeeded,
  cleanupOldPngs,
  DEFAULT_HISTORY_PATH,
  DEFAULT_PNG_DIR,
  DEFAULT_PNG_RETENTION_DAYS,
  DEFAULT_JSONL_ROTATE_MB,
};
