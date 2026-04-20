#!/usr/bin/env node
// =============================================================================
// ux-metrics.js — Captura append-only de metricas UX infra (#2337, CA10).
//
// Persiste metricas por evento `connectivity_restored` en `.pipeline/metrics/`
// con un archivo JSONL por dia y rotacion automatica:
//   `.pipeline/metrics/ux-infra-YYYY-MM-DD.json`
//
// Responsabilidades:
//   - CA10.1: crear el directorio + archivo del dia en el primer write.
//   - CA10.2: capturar los timestamps de la choreografia + metadata del evento.
//   - CA10.3: escritura atomica via appendFileSync (JSONL, <4KB por linea).
//   - CA10.4: rotacion diaria (archivo nuevo por dia).
//   - CA10.5: cleanup perezoso al primer write del dia + en startup, con
//             filtro estricto de path traversal (REQ-SEC-2) y cota dura.
//   - CA10.6: no persistir datos sensibles — solo IDs/enum/metadata.
//
// Anti-patterns cubiertos:
//   - Path traversal: regex estricta `^ux-infra-\d{4}-\d{2}-\d{2}\.json$`
//     antes de `unlinkSync` (REQ-SEC-2).
//   - Denial-of-wallet por disco: cota dura a 100 archivos fuerza cleanup
//     aunque el cleanup perezoso no haya disparado (REQ-SEC-5).
//   - Entradas monstruosas: `MAX_ENTRY_BYTES` valida que ninguna linea
//     supera 4KB — appendFileSync sigue siendo byte-safe en NTFS/POSIX.
//   - Datos sensibles: la funcion filtra campos permitidos y convierte
//     paths absolutos a basename (REQ-SEC-3).
// =============================================================================

'use strict';

const fs = require('fs');
const path = require('path');

const PIPELINE_DIR = path.resolve(__dirname);
const DEFAULT_METRICS_DIR = path.join(PIPELINE_DIR, 'metrics');
const LAST_CLEANUP_FILE = '.last-cleanup';

// Retencion y caps (REQ-SEC-5)
const RETENTION_DAYS = 30;
const RETENTION_MS = RETENTION_DAYS * 24 * 60 * 60 * 1000;
const MAX_FILES_HARD_CAP = 100; // cota dura para forzar cleanup
const MAX_ENTRY_BYTES = 4 * 1024; // JSONL append seguro en NTFS/POSIX <4KB

// Regex estricta para nombres de archivo (REQ-SEC-2)
const UX_FILE_REGEX = /^ux-infra-(\d{4})-(\d{2})-(\d{2})\.json$/;

// Whitelist de keys permitidas en cada entrada (REQ-SEC-3).
// Si un caller inyecta keys nuevas, se filtran silenciosamente.
const ALLOWED_ENTRY_KEYS = new Set([
  'event',
  'timestamp_event',
  'timestamp_dashboard_update',
  'timestamp_telegram_delivered',
  'timestamp_first_issue_running',
  'latencia_telegram_ms',
  'latencia_recuperacion_ms',
  'variante_mensaje',
  'issues_reencolados',
  'rate_limit_alcanzado',
  'previous_state',
  'retrying_window_ms',
]);

// --- Helpers ---

/**
 * Devuelve el sufijo de fecha `YYYY-MM-DD` para el timestamp (UTC).
 * UTC para evitar inconsistencias entre operaciones del pipeline corriendo
 * alrededor de medianoche local (consistente con `events/connectivity.jsonl`).
 */
function dateSuffix(nowMs) {
  const d = new Date(Number(nowMs) || Date.now());
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function uxFilePath(metricsDir, nowMs) {
  return path.join(metricsDir, `ux-infra-${dateSuffix(nowMs)}.json`);
}

function lastCleanupPath(metricsDir) {
  return path.join(metricsDir, LAST_CLEANUP_FILE);
}

function ensureDir(dir, fsMod) {
  try { fsMod.mkdirSync(dir, { recursive: true }); } catch { /* exists */ }
}

/**
 * Sanitiza la entrada antes de persistir (REQ-SEC-3):
 *  - Filtra keys no whitelisted.
 *  - Convierte paths absolutos a basename (oculta `C:\Users\...`).
 *  - Clamp `variante_mensaje` a ID corto (max 32 chars).
 *  - Rechaza tokens-like (best-effort heuristico).
 */
function sanitizeEntry(entry) {
  if (!entry || typeof entry !== 'object') return {};
  const out = {};
  for (const [k, v] of Object.entries(entry)) {
    if (!ALLOWED_ENTRY_KEYS.has(k)) continue;
    out[k] = sanitizeValue(k, v);
  }
  return out;
}

function sanitizeValue(key, value) {
  if (value == null) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    // Heuristica de tokens: si parece un secreto, rechazar.
    if (/\b(sk-|ghp_|gho_|ghs_|AKIA|xoxb-|Bearer\s)[A-Za-z0-9._\-]{10,}/.test(value)) {
      return '[REDACTED]';
    }
    // Paths absolutos Windows/Unix -> basename (evita fuga de info local).
    if (/^[A-Za-z]:[\\/]/.test(value) || value.startsWith('/')) {
      return path.basename(value);
    }
    // Clamp corto para `variante_mensaje`
    if (key === 'variante_mensaje' && value.length > 32) return value.slice(0, 32);
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((v) => sanitizeValue(key, v));
  }
  // Objetos libres se descartan — no queremos fugar estructuras opacas.
  return null;
}

/**
 * Computa latencias derivadas (CA10.2) si los timestamps estan disponibles.
 * No sobrescribe valores explicitos del caller.
 */
function deriveLatencias(entry) {
  const out = { ...entry };
  if (out.timestamp_event != null) {
    if (out.latencia_telegram_ms == null && out.timestamp_telegram_delivered != null) {
      const v = Number(out.timestamp_telegram_delivered) - Number(out.timestamp_event);
      if (Number.isFinite(v) && v >= 0) out.latencia_telegram_ms = v;
    }
    if (out.latencia_recuperacion_ms == null && out.timestamp_first_issue_running != null) {
      const v = Number(out.timestamp_first_issue_running) - Number(out.timestamp_event);
      if (Number.isFinite(v) && v >= 0) out.latencia_recuperacion_ms = v;
    }
  }
  return out;
}

// --- Cleanup (REQ-SEC-2 + REQ-SEC-5) ---

/**
 * Lista los archivos UX validos en el directorio. El filtro estricto con
 * `UX_FILE_REGEX` evita tocar `.last-cleanup`, dotfiles o archivos ajenos.
 */
function listUxFiles(metricsDir, fsMod) {
  try {
    const files = fsMod.readdirSync(metricsDir);
    return files.filter((name) => UX_FILE_REGEX.test(name));
  } catch {
    return [];
  }
}

/**
 * Ejecuta el cleanup si aplica:
 *  - Se fuerza si `force=true` (startup o cota dura).
 *  - Sino, solo corre una vez por dia (lazy), marcado en `.last-cleanup`.
 *
 * Borra archivos con mtime > RETENTION_DAYS de antiguedad, respetando el regex
 * estricto y nunca saliendo del directorio `metricsDir` (REQ-SEC-2).
 */
function cleanup(opts = {}) {
  const fsMod = opts.fs || fs;
  const nowMs = Number(opts.now) || Date.now();
  const metricsDir = path.resolve(opts.metricsDir || DEFAULT_METRICS_DIR);
  const force = !!opts.force;

  ensureDir(metricsDir, fsMod);

  // Gate: si hoy ya corrio el cleanup y no es forzado, skip.
  const markerPath = lastCleanupPath(metricsDir);
  if (!force) {
    try {
      if (fsMod.existsSync(markerPath)) {
        const raw = fsMod.readFileSync(markerPath, 'utf8');
        const prevMs = Number(JSON.parse(raw).ts) || 0;
        if (Number.isFinite(prevMs) && dateSuffix(prevMs) === dateSuffix(nowMs)) {
          return { ran: false, reason: 'already-today' };
        }
      }
    } catch { /* ignore, proceder con cleanup */ }
  }

  const files = listUxFiles(metricsDir, fsMod);
  const cutoff = nowMs - RETENTION_MS;
  const deleted = [];
  const kept = [];

  for (const name of files) {
    const full = path.join(metricsDir, name);
    // Defensa extra path traversal: verificar que el resolve no escapa del dir.
    if (!isInsideDir(metricsDir, full)) continue;
    try {
      const st = fsMod.statSync(full);
      if (st.mtimeMs < cutoff) {
        fsMod.unlinkSync(full);
        deleted.push(name);
      } else {
        kept.push(name);
      }
    } catch { /* ignore missing/racing */ }
  }

  // Cota dura: si aun quedan >MAX_FILES_HARD_CAP, borrar los mas viejos.
  let capEnforced = false;
  if (kept.length > MAX_FILES_HARD_CAP) {
    const byAge = kept
      .map((name) => {
        const full = path.join(metricsDir, name);
        try { return { name, mtimeMs: fsMod.statSync(full).mtimeMs }; }
        catch { return null; }
      })
      .filter(Boolean)
      .sort((a, b) => a.mtimeMs - b.mtimeMs); // mas viejo primero

    const excess = byAge.length - MAX_FILES_HARD_CAP;
    for (let i = 0; i < excess; i++) {
      const full = path.join(metricsDir, byAge[i].name);
      if (!isInsideDir(metricsDir, full)) continue;
      try {
        fsMod.unlinkSync(full);
        deleted.push(byAge[i].name);
        capEnforced = true;
      } catch { /* ignore */ }
    }
  }

  // Marca cleanup (escritura at\u00f3mica tmp+rename)
  try {
    const payload = JSON.stringify({ ts: nowMs, deleted: deleted.length });
    writeFileAtomic(markerPath, payload, fsMod);
  } catch { /* best-effort */ }

  return { ran: true, deleted, kept: kept.length, capEnforced };
}

function isInsideDir(dir, filePath) {
  const rDir = path.resolve(dir);
  const rFile = path.resolve(filePath);
  const rel = path.relative(rDir, rFile);
  return !rel.startsWith('..') && !path.isAbsolute(rel);
}

function writeFileAtomic(filePath, contents, fsMod) {
  const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  fsMod.writeFileSync(tmp, contents, { mode: 0o600 });
  try {
    fsMod.renameSync(tmp, filePath);
  } catch (e) {
    try { fsMod.unlinkSync(tmp); } catch { /* ignore */ }
    throw e;
  }
}

// --- Append principal ---

/**
 * Appendea una entrada al archivo JSONL del dia actual.
 *
 *   @param {object} entry datos a persistir (se sanitizan con whitelist)
 *   @param {object} [opts]
 *     @param {string}   [opts.metricsDir]
 *     @param {number}   [opts.now]
 *     @param {object}   [opts.fs]
 *     @param {boolean}  [opts.skipCleanup] desactiva el cleanup lazy
 *   @returns {{ written: boolean, filePath: string, entry: object, cleanup?: object, reason?: string }}
 */
function appendMetric(entry, opts = {}) {
  const fsMod = opts.fs || fs;
  const nowMs = Number(opts.now) || Date.now();
  const metricsDir = path.resolve(opts.metricsDir || DEFAULT_METRICS_DIR);

  ensureDir(metricsDir, fsMod);

  // Cleanup perezoso al primer write del dia (a menos que se desactive).
  let cleanupResult;
  if (!opts.skipCleanup) {
    try {
      cleanupResult = cleanup({ fs: fsMod, now: nowMs, metricsDir });
    } catch { /* best-effort, no bloquea el write */ }
  }

  // Sanitizar + derivar latencias
  let normalized = deriveLatencias(sanitizeEntry(entry || {}));

  // Anchor temporal obligatorio (si falta, tomamos now).
  if (normalized.timestamp_event == null) {
    normalized.timestamp_event = nowMs;
  }
  // Default explicito del event si no vino
  if (!normalized.event) normalized.event = 'connectivity_restored';

  // Validar tamano antes de escribir (REQ-SEC-4, CA10.3)
  const line = JSON.stringify(normalized) + '\n';
  const bytes = Buffer.byteLength(line, 'utf8');
  if (bytes > MAX_ENTRY_BYTES) {
    return {
      written: false,
      filePath: uxFilePath(metricsDir, nowMs),
      entry: normalized,
      reason: `entry-too-large: ${bytes}B > ${MAX_ENTRY_BYTES}B`,
      cleanup: cleanupResult,
    };
  }

  const filePath = uxFilePath(metricsDir, nowMs);
  try {
    fsMod.appendFileSync(filePath, line, { mode: 0o600 });
    return { written: true, filePath, entry: normalized, cleanup: cleanupResult };
  } catch (e) {
    return {
      written: false,
      filePath,
      entry: normalized,
      reason: `append-error: ${e.code || e.message}`,
      cleanup: cleanupResult,
    };
  }
}

// --- Exports ---

module.exports = {
  appendMetric,
  cleanup,
  sanitizeEntry,
  deriveLatencias,
  listUxFiles,
  uxFilePath,
  dateSuffix,
  isInsideDir,
  // Constantes publicas
  DEFAULT_METRICS_DIR,
  UX_FILE_REGEX,
  RETENTION_DAYS,
  MAX_FILES_HARD_CAP,
  MAX_ENTRY_BYTES,
  ALLOWED_ENTRY_KEYS,
};

// --- CLI (smoke/debug) ---
if (require.main === module) {
  const cmd = process.argv[2];
  if (cmd === 'cleanup') {
    const r = cleanup({ force: true });
    console.log(JSON.stringify(r, null, 2));
    process.exit(0);
  }
  if (cmd === 'list') {
    const files = listUxFiles(DEFAULT_METRICS_DIR, fs);
    console.log(JSON.stringify(files, null, 2));
    process.exit(0);
  }
  console.error('uso: node ux-metrics.js [cleanup|list]');
  process.exit(2);
}
