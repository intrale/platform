// =============================================================================
// build-log-staleness.js — Detección de logs stale + reset seguro del
// circuit breaker (#2404).
//
// Contexto del problema:
//   El Pulpo inyecta `motivo_rechazo` (que referencia `.pipeline/logs/build-<N>.log`)
//   en el prompt del developer al rebotar un issue. Si el log es viejo (ej. 28h,
//   proveniente de un build que falló por JAVA_HOME stale y ya fue corregido),
//   el developer recibe contexto obsoleto y diagnostica un problema que no
//   existe más — envenenamiento de contexto.
//
// Solución (criterios de #2404):
//   - Detectar si el log del build es stale (mtime > umbral).
//   - Si lo es: limpiar el `motivo_rechazo` y `rebote`, resetear el contador
//     del circuit breaker, re-encolar a fase `build` para que se re-ejecute
//     con el entorno actualizado.
//   - Auditar cada reset en JSONL para visibilidad operativa.
//   - Notificar a Telegram con copy natural (UX §2).
//   - Tope duro de resets por issue (default 5) para evitar bypass del
//     circuit breaker si un log "se mantiene stale" por bug o config mala.
//   - Clamp mínimo de 5min en el umbral (Security §2).
//
// El módulo es independiente de pulpo.js (evita engordar el monolito) y
// exporta helpers que pulpo.js consume desde sus 2 call sites (barrido +
// launch defensivo).
// =============================================================================

'use strict';

const fs = require('fs');
const path = require('path');

// Paths relativos al .pipeline/ — cuando pulpo.js requiere este módulo,
// __dirname apunta a .pipeline/
const PIPELINE = __dirname;
const LOG_DIR = path.join(PIPELINE, 'logs');
const AUDIT_DIR = path.join(LOG_DIR, 'audit');
const AUDIT_FILE = path.join(AUDIT_DIR, 'circuit-breaker.jsonl');

// Clamp mínimo hardcoded: 5 minutos. Evita que una config maliciosa o
// errónea (ej. `build_log_max_age_hours: 0`) marque TODO como stale y
// desactive el circuit breaker de facto. Security §2 + PO B4.
const MIN_STALENESS_MS = 5 * 60 * 1000;

// Default: 24h, override por env (útil para tests de integración).
const DEFAULT_STALENESS_HOURS = 24;
const DEFAULT_MAX_RESETS_PER_ISSUE = 5;

/**
 * Valida un issue como entero positivo — previene path traversal cuando
 * `issue` se usa para construir un path (Security §1 A03).
 *
 * @param {unknown} issue
 * @returns {boolean}
 */
function isValidIssueNumber(issue) {
  if (issue === null || issue === undefined) return false;
  const s = String(issue);
  return /^\d+$/.test(s) && Number(s) > 0;
}

/**
 * Path del log de build de un issue. Nunca usar `issue` sin validar —
 * llamar SIEMPRE después de `isValidIssueNumber(issue) === true`.
 */
function buildLogPathFor(issue) {
  return path.join(LOG_DIR, `build-${issue}.log`);
}

/**
 * Parsea el umbral de staleness desde (en orden): env, config.staleness,
 * default. Aplica clamp mínimo hardcoded.
 *
 * @param {object} [config] — config del pipeline (opcional; si no se pasa, se
 *   lee solo el env). Soporta `config.staleness.build_log_max_age_hours`.
 * @returns {{ ms: number, hours: number, clamped: boolean, raw: number|null }}
 */
function getStalenessThresholdMs(config) {
  const envRaw = process.env.PIPELINE_STALENESS_HOURS;
  const configRaw = config && config.staleness && config.staleness.build_log_max_age_hours;

  let raw = null;
  let hours = DEFAULT_STALENESS_HOURS;

  if (envRaw !== undefined && envRaw !== null && envRaw !== '') {
    raw = Number(envRaw);
    if (Number.isFinite(raw)) hours = raw;
  } else if (configRaw !== undefined && configRaw !== null) {
    raw = Number(configRaw);
    if (Number.isFinite(raw)) hours = raw;
  }

  // Si el valor es inválido (NaN, negativo, string raro) → default.
  if (!Number.isFinite(hours) || hours < 0) hours = DEFAULT_STALENESS_HOURS;

  const rawMs = hours * 3600 * 1000;
  let ms = rawMs;
  let clamped = false;
  if (ms < MIN_STALENESS_MS) {
    ms = MIN_STALENESS_MS;
    clamped = true;
  }
  return { ms, hours: ms / 3600 / 1000, clamped, raw };
}

/**
 * Lee el tope de resets por issue, con default 5. Valida que sea entero
 * positivo; si no lo es, devuelve default.
 */
function getMaxResetsPerIssue(config) {
  const raw = config && config.staleness && config.staleness.max_resets_per_issue;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_MAX_RESETS_PER_ISSUE;
  return Math.floor(n);
}

/**
 * Devuelve info de staleness para el build-log del issue. NO tira errores;
 * si el log no existe o no se puede leer, devuelve `{ exists: false }` lo
 * cual se interpreta como "no-stale" (flujo normal preservado — PO D3).
 *
 * @param {number|string} issue
 * @param {number} thresholdMs
 * @returns {{
 *   exists: boolean, stale?: boolean, mtimeMs?: number,
 *   ageMs?: number, ageHours?: number, thresholdMs?: number, path?: string
 * }}
 */
function inspectBuildLog(issue, thresholdMs) {
  if (!isValidIssueNumber(issue)) {
    return { exists: false };
  }
  const p = buildLogPathFor(issue);
  let stat;
  try {
    stat = fs.statSync(p);
  } catch {
    return { exists: false, path: p };
  }
  const mtimeMs = stat.mtimeMs;
  const ageMs = Math.max(0, Date.now() - mtimeMs);
  const ageHours = ageMs / 3600 / 1000;
  const stale = ageMs > thresholdMs;
  return {
    exists: true,
    stale,
    mtimeMs,
    ageMs,
    ageHours,
    thresholdMs,
    path: p,
  };
}

/**
 * Wrapper de conveniencia: true si el log existe y es stale.
 *
 * @param {number|string} issue
 * @param {number} thresholdMs
 */
function isBuildLogStale(issue, thresholdMs) {
  const info = inspectBuildLog(issue, thresholdMs);
  return info.exists && info.stale === true;
}

/**
 * Cuenta cuántas veces un issue ya fue reseteado por stale-log, leyendo el
 * audit JSONL. Retorna 0 si no existe el archivo.
 *
 * @param {number|string} issue
 * @param {string} [auditFile]
 * @returns {number}
 */
function getStaleResetCount(issue, auditFile = AUDIT_FILE) {
  if (!isValidIssueNumber(issue)) return 0;
  let content;
  try {
    content = fs.readFileSync(auditFile, 'utf8');
  } catch {
    return 0;
  }
  const issueNum = parseInt(issue, 10);
  let count = 0;
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      if (obj.event === 'circuit_breaker_reset'
        && obj.reason === 'stale_log'
        && obj.issue === issueNum) {
        count++;
      }
    } catch {
      // Línea corrupta → ignorar (best-effort)
    }
  }
  return count;
}

/**
 * Agrega una entrada al audit JSONL con formato consumible por dashboard.
 * Campos mínimos (UX §3):
 *   { ts, event, issue, reason, log_mtime, log_age_hours, threshold_hours, resets_count }
 *
 * @param {object} entry
 * @param {string} [auditFile]
 */
function appendAuditReset(entry, auditFile = AUDIT_FILE) {
  try {
    fs.mkdirSync(path.dirname(auditFile), { recursive: true });
    const line = JSON.stringify(entry) + '\n';
    fs.appendFileSync(auditFile, line);
  } catch {
    // Best-effort: si falla el write (permisos/disco), seguimos.
  }
}

/**
 * Genera el copy Telegram para un reset stale. Corto (≤ 3 líneas), natural,
 * en español argento (UX §2).
 */
function buildTelegramStaleMessage(issue, ageHours, logPath, resetsCount, maxResets) {
  const hrs = ageHours.toFixed(1);
  const tail = resetsCount > 1
    ? ` (reset ${resetsCount}/${maxResets} por este issue).`
    : '.';
  return (
    `Detecté un rebote con log viejo (${hrs}h) en #${issue}.\n` +
    `Lo reseteé y lo mandé de vuelta al builder${tail}\n` +
    `Log: ${logPath}`
  );
}

/**
 * Genera el copy Telegram para escalamiento cuando se supera el tope de resets.
 */
function buildTelegramEscalationMessage(issue, resetsCount, maxResets, logPath) {
  return (
    `⛔ Issue #${issue} superó el tope de resets por log stale (${resetsCount}/${maxResets}).\n` +
    `No reseteo más — requiere intervención manual.\n` +
    `Log: ${logPath}`
  );
}

/**
 * Dado un YAML de pendiente (objeto ya parseado), devuelve una copia sin las
 * keys `motivo_rechazo`, `rebote`, `rebote_tipo`, `rebote_numero*`,
 * `rechazado_en_fase`. Este es el YAML que se persiste al re-encolar a
 * `build` tras un stale-reset (UX §1 — evita contexto rezagado).
 *
 * IMPORTANTE: devuelve una copia, NO muta el input.
 */
function cleanYamlForRebuild(data) {
  const out = {};
  for (const [k, v] of Object.entries(data || {})) {
    if (k === 'motivo_rechazo') continue;
    if (k === 'rebote') continue;
    if (k === 'rebote_tipo') continue;
    if (k === 'rebote_numero') continue;
    if (k === 'rebote_numero_infra') continue;
    if (k === 'rebote_routing_numero') continue;
    if (k === 'rechazado_en_fase') continue;
    if (k === 'rechazado_desde_pipeline') continue;
    if (k === 'rechazado_desde_fase') continue;
    if (k === 'rechazado_por') continue;
    out[k] = v;
  }
  return out;
}

/**
 * Detecta si el motivo de rechazo referencia el build-log del issue.
 * Lo hacemos por substring (el log path puede aparecer con path absoluto o
 * relativo, con barras normales o invertidas según el OS).
 */
function motivoReferencesBuildLog(motivo, issue) {
  if (!motivo || !isValidIssueNumber(issue)) return false;
  const s = String(motivo);
  // Cualquiera de estas substrings lo delata:
  //   "build-<N>.log"                      (con issue directo)
  //   ".pipeline/logs/build-<N>.log"       (path relativo UNIX)
  //   ".pipeline\\logs\\build-<N>.log"     (path Windows)
  const needle = `build-${issue}.log`;
  return s.includes(needle);
}

module.exports = {
  // Constantes exportadas para tests
  MIN_STALENESS_MS,
  DEFAULT_STALENESS_HOURS,
  DEFAULT_MAX_RESETS_PER_ISSUE,

  // Paths expuestos para tests y overrides
  AUDIT_FILE,
  AUDIT_DIR,
  buildLogPathFor,

  // Helpers
  isValidIssueNumber,
  getStalenessThresholdMs,
  getMaxResetsPerIssue,
  inspectBuildLog,
  isBuildLogStale,
  getStaleResetCount,
  appendAuditReset,
  buildTelegramStaleMessage,
  buildTelegramEscalationMessage,
  cleanYamlForRebuild,
  motivoReferencesBuildLog,
};
