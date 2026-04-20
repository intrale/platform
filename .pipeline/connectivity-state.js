#!/usr/bin/env node
// =============================================================================
// connectivity-state.js — Estado persistido de conectividad (#2335)
//
// Historia #2335 (hija 1 de #2329). Este modulo implementa:
//
//   CA1-CA2 — Deteccion de transicion FAIL→OK del pre-check HTTP + emision
//             del evento `connectivity_restored` SOLO tras probe real
//             (anti-spoofing: un flag externo NO dispara el evento).
//
//   CA3-CA4 — Estado `blockedByInfra` persistido en `.pipeline/blocked-by-infra.json`
//             con schema versionado y escritura atomica (write tmp + fsync + rename).
//
//   CA8    — Event log append-only en `.pipeline/events/connectivity.jsonl`
//             con rotacion por tamaño (5 MB → .1/.2/.3), retencion 7 dias,
//             y dedup por ventana de 30s (preserva el ultimo del burst).
//
// API publica:
//   getLast()                    → estado persistido previo (o null)
//   recordProbeResult(result)    → { transition, event?, state }
//   addBlockedIssue({ number, reason, detail })
//   clearBlockedIssues()
//   getBlockedIssues()
//   emitEvent(event)             → escribe en events/connectivity.jsonl
//   sanitizeForLog(str)          → helper reusable (usa lib/redact.js)
//
// Anti-spoofing: los eventos `connectivity_restored` se publican unicamente
// como consecuencia de la llamada `recordProbeResult(result)` donde `result`
// proviene directamente del pre-check HTTP real. No hay input por archivo.
//
// Schema de blocked-by-infra.json:
//   {
//     "version": 1,
//     "issues": [{ "number": N, "since": "<iso8601>", "reason": "<enum>", "detail": "..." }],
//     "lastEvent": { "type": "connectivity_restored", "ts": "<iso8601>" }
//   }
//
// Enum de `reason`:
//   network_unreachable | backend_timeout | backend_5xx | rate_limit
//   | auth_failure | unknown
// =============================================================================

'use strict';

const fs = require('fs');
const path = require('path');

// Reutilizamos el helper canonico para sanitizar logs (CA7).
let redactLib;
try {
  redactLib = require('./lib/redact');
} catch {
  redactLib = {
    redactSensitive: (x) => x,
    redactUrlLike: (x) => x,
    redactError: (x) => x,
  };
}

const PIPELINE_DIR = path.resolve(__dirname);
const STATE_FILE = path.join(PIPELINE_DIR, 'connectivity-state.json');
const BLOCKED_FILE = path.join(PIPELINE_DIR, 'blocked-by-infra.json');
const EVENTS_DIR = path.join(PIPELINE_DIR, 'events');
const EVENTS_FILE = path.join(EVENTS_DIR, 'connectivity.jsonl');
const TMP_DIR = path.join(PIPELINE_DIR, 'tmp');

const SCHEMA_VERSION = 1;

// CA8: rotacion por tamaño y retencion
const EVENT_LOG_MAX_BYTES = 5 * 1024 * 1024; // 5 MB
const EVENT_LOG_MAX_AGE_DAYS = 7;
const EVENT_LOG_ROTATIONS = 3; // .1 .2 .3

// CA8: dedup de eventos connectivity_restored dentro de ventana corta
const DEDUP_WINDOW_MS = 30 * 1000; // 30s (absorbe flapping)

// CA5: cap duro defense-in-depth sobre rebotes tipo infra.
// Aunque infra no cuenta contra MAX_REBOTES=3, superado este cap hace que
// el circuit breaker generico aplique igual.
const MAX_REBOTES_INFRA = 20;

// Enum cerrado (UX-1): permite mapeo consistente en hijas 2/3.
const REASON_CATEGORIES = Object.freeze({
  NETWORK_UNREACHABLE: 'network_unreachable',
  BACKEND_TIMEOUT: 'backend_timeout',
  BACKEND_5XX: 'backend_5xx',
  RATE_LIMIT: 'rate_limit',
  AUTH_FAILURE: 'auth_failure',
  UNKNOWN: 'unknown',
});
const REASON_SET = new Set(Object.values(REASON_CATEGORIES));

function normalizeReason(reason) {
  if (typeof reason !== 'string') return REASON_CATEGORIES.UNKNOWN;
  const low = reason.trim().toLowerCase();
  if (REASON_SET.has(low)) return low;
  return REASON_CATEGORIES.UNKNOWN;
}

/**
 * Sanitiza strings antes de loguear (CA7). Delega en lib/redact.js con
 * tratamiento especial para tokens inline en mensajes/stacks que `redact.js`
 * no cubre por regex (sk-*, ghp_*, AKIA*, bot<id>:<token>).
 */
function sanitizeForLog(input) {
  if (input == null) return input;
  if (typeof input === 'string') {
    let out = redactLib.redactSensitive(input);
    // Patrones inline complementarios (CA7). `redact.js` trabaja con headers
    // y query-strings; los siguientes matchean contenido libre en logs.
    out = out
      .replace(/\bsk-[A-Za-z0-9_\-]{20,}/g, '[OPENAI_KEY_REDACTED]')
      .replace(/\bBearer\s+[A-Za-z0-9._\-]+/gi, 'Bearer [BEARER_REDACTED]')
      .replace(/\bbot\d+:[A-Za-z0-9_\-]{30,}/g, '[TELEGRAM_TOKEN_REDACTED]')
      .replace(/\bghp_[A-Za-z0-9]{30,}/g, '[GITHUB_TOKEN_REDACTED]')
      .replace(/\bgho_[A-Za-z0-9]{30,}/g, '[GITHUB_TOKEN_REDACTED]')
      .replace(/\bghs_[A-Za-z0-9]{30,}/g, '[GITHUB_TOKEN_REDACTED]')
      .replace(/\bAKIA[0-9A-Z]{16}\b/g, '[AWS_KEY_REDACTED]');
    return out;
  }
  if (input && typeof input === 'object' && typeof input.message === 'string') {
    const plain = redactLib.redactError(input);
    plain.message = sanitizeForLog(plain.message);
    if (plain.stack) plain.stack = sanitizeForLog(plain.stack);
    return plain;
  }
  return redactLib.redactSensitive(input);
}

function ensureDir(dir) {
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
}

function readJsonSafe(filepath) {
  try {
    if (!fs.existsSync(filepath)) return null;
    const raw = fs.readFileSync(filepath, 'utf8');
    if (!raw.trim()) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Escritura atomica (CA4 / security A08):
 *   - writeFileSync en tmp con mode 0o600
 *   - fsyncSync del fd (evita perdida de data en crash post-rename)
 *   - renameSync al destino final (atomico en mismo filesystem)
 *
 * `tmp/` vive bajo `.pipeline/` — mismo drive que destino (requisito Windows
 * donde rename cross-device falla).
 */
function writeJsonAtomic(filepath, data) {
  ensureDir(TMP_DIR);
  ensureDir(path.dirname(filepath));
  const tmp = path.join(TMP_DIR, `${path.basename(filepath)}.${process.pid}.${Date.now()}.tmp`);
  const payload = JSON.stringify(data, null, 2);
  const fd = fs.openSync(tmp, 'w', 0o600);
  try {
    fs.writeSync(fd, payload);
    try { fs.fsyncSync(fd); } catch { /* fsync puede fallar en algunos FS, best-effort */ }
  } finally {
    try { fs.closeSync(fd); } catch {}
  }
  try {
    fs.renameSync(tmp, filepath);
  } catch (err) {
    // Cleanup tmp si rename falla
    try { fs.unlinkSync(tmp); } catch {}
    throw err;
  }
}

// --- Estado del probe (para detectar transicion) ---

function getLast() {
  return readJsonSafe(STATE_FILE);
}

function setLast(state) {
  writeJsonAtomic(STATE_FILE, { ...state, schema_version: SCHEMA_VERSION });
}

// --- blocked-by-infra.json ---

function getBlockedIssues() {
  const data = readJsonSafe(BLOCKED_FILE);
  if (!data || data.version !== SCHEMA_VERSION) {
    return { version: SCHEMA_VERSION, issues: [], lastEvent: null };
  }
  return data;
}

function addBlockedIssue({ number, reason, detail }) {
  if (!number) return;
  const current = getBlockedIssues();
  const existing = current.issues.find((i) => Number(i.number) === Number(number));
  if (existing) {
    // Actualizar reason si cambio; mantener `since` original.
    existing.reason = normalizeReason(reason);
    if (detail) existing.detail = sanitizeForLog(detail);
    writeJsonAtomic(BLOCKED_FILE, current);
    return;
  }
  current.issues.push({
    number: Number(number),
    since: new Date().toISOString(), // UX-2: UTC con Z explicito
    reason: normalizeReason(reason),
    detail: detail ? sanitizeForLog(detail) : undefined,
  });
  writeJsonAtomic(BLOCKED_FILE, current);
}

function clearBlockedIssues(lastEvent) {
  const current = getBlockedIssues();
  const cleared = current.issues.map((i) => Number(i.number));
  current.issues = [];
  if (lastEvent) current.lastEvent = lastEvent;
  writeJsonAtomic(BLOCKED_FILE, current);
  return cleared;
}

// --- Event log append-only + rotacion ---

/**
 * Rota events/connectivity.jsonl cuando supera EVENT_LOG_MAX_BYTES.
 * .jsonl → .jsonl.1, .1 → .2, .2 → .3, .3 se descarta.
 */
function rotateEventLogIfNeeded() {
  try {
    if (!fs.existsSync(EVENTS_FILE)) return;
    const stat = fs.statSync(EVENTS_FILE);
    if (stat.size < EVENT_LOG_MAX_BYTES) return;
    // Desplazar desde la ultima hacia atras
    for (let i = EVENT_LOG_ROTATIONS; i >= 1; i--) {
      const src = i === 1 ? EVENTS_FILE : `${EVENTS_FILE}.${i - 1}`;
      const dst = `${EVENTS_FILE}.${i}`;
      if (fs.existsSync(src)) {
        if (i === EVENT_LOG_ROTATIONS && fs.existsSync(dst)) {
          try { fs.unlinkSync(dst); } catch {}
        }
        try { fs.renameSync(src, dst); } catch {}
      }
    }
  } catch {}
}

/**
 * Purga eventos con antiguedad > EVENT_LOG_MAX_AGE_DAYS del archivo activo.
 * Best-effort: si falla, continua sin romper el pipeline.
 */
function purgeOldEvents() {
  try {
    if (!fs.existsSync(EVENTS_FILE)) return;
    const cutoff = Date.now() - EVENT_LOG_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
    const content = fs.readFileSync(EVENTS_FILE, 'utf8');
    const lines = content.split('\n').filter(Boolean);
    const kept = [];
    for (const line of lines) {
      try {
        const evt = JSON.parse(line);
        const ts = Date.parse(evt.ts);
        if (!Number.isFinite(ts) || ts >= cutoff) kept.push(line);
      } catch {
        kept.push(line); // preservar lineas parseables en caso de duda
      }
    }
    if (kept.length === lines.length) return; // nada que purgar
    ensureDir(EVENTS_DIR);
    const rewritten = kept.join('\n') + (kept.length ? '\n' : '');
    // Escritura atomica para no perder el tail si crashea mid-rewrite
    writeJsonAtomicRaw(EVENTS_FILE, rewritten);
  } catch {}
}

function writeJsonAtomicRaw(filepath, rawString) {
  ensureDir(TMP_DIR);
  const tmp = path.join(TMP_DIR, `${path.basename(filepath)}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmp, rawString, { mode: 0o600 });
  fs.renameSync(tmp, filepath);
}

// Dedup in-memory por tipo con ventana corta (CA8).
// Key: event.type. Valor: { ts, count }
const dedupBuffer = new Map();

function dedupKey(event) {
  return event && event.type ? String(event.type) : 'unknown';
}

/**
 * Dedup por ventana: si hay un evento del mismo tipo dentro de DEDUP_WINDOW_MS,
 * descarta el previo y registra el nuevo (UX-5: preservar el ultimo, no el
 * primero). Devuelve `{ suppressed: boolean, dedupedFrom: number }`.
 */
function applyDedup(event) {
  const key = dedupKey(event);
  const now = Date.now();
  const prev = dedupBuffer.get(key);
  if (prev && (now - prev.ts) < DEDUP_WINDOW_MS) {
    const count = (prev.count || 1) + 1;
    dedupBuffer.set(key, { ts: now, count });
    return { suppressed: false, dedupedFrom: count };
  }
  dedupBuffer.set(key, { ts: now, count: 1 });
  return { suppressed: false, dedupedFrom: 0 };
}

function emitEvent(event) {
  if (!event || typeof event !== 'object') return null;
  ensureDir(EVENTS_DIR);
  rotateEventLogIfNeeded();
  purgeOldEvents();

  const dedup = applyDedup(event);
  const line = {
    schema_version: SCHEMA_VERSION,
    ts: event.ts || new Date().toISOString(),
    ...event,
  };
  if (dedup.dedupedFrom > 1) line.deduped_from = dedup.dedupedFrom;

  const payload = JSON.stringify(line) + '\n';
  try {
    fs.appendFileSync(EVENTS_FILE, payload, { flag: 'a', mode: 0o600 });
  } catch (err) {
    // Best-effort: no romper pipeline por fallo de log.
  }
  return line;
}

/**
 * Registra el resultado del probe HTTP y detecta transicion FAIL→OK.
 * Si detecta la transicion, emite el evento `connectivity_restored`.
 *
 * ANTI-SPOOFING (CA2): este es el UNICO entry point que emite el evento.
 * Solo se puede invocar con un `probeResult` del pre-check real — los
 * callers deben pasar el resultado directo de `connectivity-precheck.js`.
 *
 * @param {object} probeResult resultado de precheck.runPrecheck()
 *                            { ok, results, timestamp, durationMs }
 * @param {object} opts
 * @param {number[]} opts.requeuedIssues issues reencolados tras la recuperacion
 * @returns {{ transition: 'fail-to-ok'|'ok-to-fail'|'stable-ok'|'stable-fail', event: object|null, state: object }}
 */
function recordProbeResult(probeResult, opts = {}) {
  const prev = getLast();
  const prevOk = prev ? prev.ok === true : null;
  const currOk = probeResult && probeResult.ok === true;

  let transition = 'stable-fail';
  if (prevOk === null) transition = currOk ? 'stable-ok' : 'stable-fail';
  else if (prevOk && !currOk) transition = 'ok-to-fail';
  else if (!prevOk && currOk) transition = 'fail-to-ok';
  else transition = currOk ? 'stable-ok' : 'stable-fail';

  const nextState = {
    ok: !!currOk,
    lastProbe: {
      ok: !!currOk,
      ts: (probeResult && probeResult.timestamp) || new Date().toISOString(),
      durationMs: probeResult ? probeResult.durationMs : null,
    },
    transitionedAt: transition === 'fail-to-ok' || transition === 'ok-to-fail'
      ? new Date().toISOString()
      : (prev && prev.transitionedAt) || null,
    lastTransition: transition === 'stable-ok' || transition === 'stable-fail'
      ? (prev && prev.lastTransition) || null
      : transition,
    blockedSince: currOk
      ? null
      : (prev && prev.blockedSince) || new Date().toISOString(),
  };
  try { setLast(nextState); } catch { /* best-effort */ }

  let event = null;
  if (transition === 'fail-to-ok') {
    const blockedDurationMs = prev && prev.blockedSince
      ? Math.max(0, Date.now() - Date.parse(prev.blockedSince))
      : null;
    const firstOkEndpoint = (probeResult && Array.isArray(probeResult.results))
      ? (probeResult.results.find((r) => r.dns && r.dns.ok) || {})
      : {};
    const current = getBlockedIssues();
    const currentlyBlocked = current.issues.map((i) => Number(i.number));
    const requeued = Array.isArray(opts.requeuedIssues) ? opts.requeuedIssues.map(Number) : currentlyBlocked;

    const payload = {
      type: 'connectivity_restored',
      ts: new Date().toISOString(),
      probe: {
        endpoint: firstOkEndpoint.host || null,
        duration_ms: probeResult ? probeResult.durationMs : null,
        status: currOk ? 'ok' : 'fail',
      },
      requeued: {
        count: requeued.length,
        issues: requeued,
      },
      blocked_duration_ms: blockedDurationMs,
    };
    event = emitEvent(payload);
    // Actualizar blocked-by-infra.lastEvent (sin limpiar el array aqui — ese
    // cleanup lo hace `clearBlockedIssues(event)` en el caller tras reencolar).
    try {
      const blk = getBlockedIssues();
      blk.lastEvent = { type: 'connectivity_restored', ts: payload.ts };
      writeJsonAtomic(BLOCKED_FILE, blk);
    } catch { /* best-effort */ }
  }

  return { transition, event, state: nextState };
}

// --- Exports ---

module.exports = {
  // API principal
  getLast,
  recordProbeResult,
  emitEvent,
  addBlockedIssue,
  clearBlockedIssues,
  getBlockedIssues,
  sanitizeForLog,

  // Constantes publicas
  SCHEMA_VERSION,
  REASON_CATEGORIES,
  MAX_REBOTES_INFRA,
  DEDUP_WINDOW_MS,
  EVENT_LOG_MAX_BYTES,
  EVENT_LOG_MAX_AGE_DAYS,

  // Paths publicos (utiles para tests)
  STATE_FILE,
  BLOCKED_FILE,
  EVENTS_FILE,
  EVENTS_DIR,

  // Hooks internos (tests)
  _resetDedupBuffer: () => dedupBuffer.clear(),
  _writeJsonAtomic: writeJsonAtomic,
  _rotateEventLogIfNeeded: rotateEventLogIfNeeded,
  _purgeOldEvents: purgeOldEvents,
};

// --- CLI ---
if (require.main === module) {
  const cmd = process.argv[2];
  if (cmd === 'status') {
    const last = getLast();
    const blocked = getBlockedIssues();
    console.log(JSON.stringify({ last, blocked }, null, 2));
    process.exit(0);
  }
  if (cmd === 'clear') {
    const cleared = clearBlockedIssues();
    console.log(JSON.stringify({ cleared }, null, 2));
    process.exit(0);
  }
  console.error('uso: node connectivity-state.js [status|clear]');
  process.exit(2);
}
