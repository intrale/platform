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

// #4766 — Operaciones git seguras (argv, resuelve PATH/git-dir en Windows).
// Se usa SÓLO por los helpers `inspectGateReject`/`isGateRejectStale` (variante
// genérica de staleness para rechazos de gate). Los helpers de build-log
// (inspectBuildLog/isBuildLogStale) NO tocan git y quedan intactos.
const { runGit: defaultRunGit, ensureGitInPath } = require('./skills-deterministicos/lib/git-ops');

// Paths relativos al .pipeline/ — cuando pulpo.js requiere este módulo,
// __dirname apunta a .pipeline/
const PIPELINE = __dirname;
const LOG_DIR = path.join(PIPELINE, 'logs');
const AUDIT_DIR = path.join(LOG_DIR, 'audit');
const AUDIT_FILE = path.join(AUDIT_DIR, 'circuit-breaker.jsonl');

// #4766 — Root del repo (padre de `.pipeline/`). cwd por defecto de las
// operaciones git de la variante genérica.
const REPO_ROOT = path.dirname(PIPELINE);

// #4766 — SHA/ref de git válido: 7-40 hex. Rechaza refs con `..`, `;`, `$()`,
// flags (`--upload-pack`), backticks, etc. (SEC-2, argv-injection safe).
const GATE_SHA_RE = /^[0-9a-f]{7,40}$/;

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

// =============================================================================
// #4766 — Variante GENÉRICA de staleness para rechazos de gate.
//
// Split (b) de #4759. Generaliza la idea de `isBuildLogStale` a un rechazo de
// gate arbitrario (`build`/`verificacion`/`aprobacion`/…): un rechazo es "stale"
// (mecánico, re-corre el gate) SÓLO si el fix vigente sobre HEAD resuelve
// empíricamente el defecto citado. Se agrega AL LADO de los helpers de
// build-log — NO modifica `inspectBuildLog`/`isBuildLogStale`/
// `getStalenessThresholdMs` ni la config `build_log_max_age_hours` (CA-8).
//
// Requisitos de seguridad (receta del Arquitecto + security en #4766):
//   SR-4/SEC-1 — `source === 'security'` NUNCA es stale. Fail-closed, evaluado
//     ANTES de cualquier operación git (en el wrapper `isGateRejectStale`).
//   SR-5      — doble condición OBLIGATORIA para marcar stale:
//     (1) el fix es estrictamente posterior al rechazo — por ANCESTRÍA
//         (`merge-base --is-ancestor`), NUNCA por timestamp de commit (SEC-3,
//         `GIT_COMMITTER_DATE` es falsificable), y
//     (2) el fix TOCA el/los archivo(s) — y líneas, si `citedLines` — citados.
//     Falta cualquiera / ambigüedad / error → `stale:false` (conservador).
//   SEC-2     — todo ref/path que entra a git se valida (`GATE_SHA_RE`,
//     confinamiento de paths) y se pasa por argv (`runGit`), nunca por shell.
//   SEC-4     — granularidad de línea: un cambio cosmético fuera de las líneas
//     citadas NO marca stale.
//
// NOTA DE SCOPE: el mapeo final `stale + source → mecanico/decision` (incluido
// el corolario SEC-1 "source ausente/desconocido → decision") lo hace el
// `block-classifier` (entregable 2, `dependency_block` de #4765). Estos helpers
// sólo responden "¿el rechazo está stale?" de forma pura y auditable.
// =============================================================================

/**
 * Valida y normaliza un SHA/ref de git a hex minúscula. Devuelve `null` si no
 * es un hash 7-40 hex (SEC-2: previene injection vía refs con metacaracteres,
 * `..`, flags `--upload-pack`, etc.).
 *
 * @param {unknown} ref
 * @returns {string|null}
 */
function normalizeGateSha(ref) {
  if (ref === null || ref === undefined) return null;
  const s = String(ref).trim().toLowerCase();
  return GATE_SHA_RE.test(s) ? s : null;
}

/**
 * Normaliza un path citado y lo confina al repo. Devuelve el path POSIX
 * relativo, o `null` si es absoluto (POSIX `/`, Windows `C:/`, UNC `//`),
 * escapa del repo (`..`) o queda vacío (SEC-2, path-confinement).
 *
 * @param {unknown} p
 * @returns {string|null}
 */
function normalizeCitedPath(p) {
  if (typeof p !== 'string') return null;
  const raw = p.trim();
  if (!raw) return null;
  const unified = raw.replace(/\\/g, '/');
  // Absolutos: POSIX `/x`, Windows `C:/x`, UNC `//host`
  if (unified.startsWith('/') || /^[a-z]:\//i.test(unified)) return null;
  const norm = path.posix.normalize(unified);
  if (norm === '..' || norm.startsWith('../') || norm.includes('/../')) return null;
  return norm.startsWith('./') ? norm.slice(2) : norm;
}

/**
 * Parsea los headers de hunk de un `git diff --unified=0` y devuelve los rangos
 * de líneas modificadas del lado NUEVO (post-fix). Header:
 *   `@@ -a,b +c,d @@`  (b/d opcionales → valen 1; d===0 = pura eliminación,
 *   que "toca" la línea de anclaje `c`).
 *
 * @param {string} diffText
 * @returns {Array<{ from: number, to: number }>}
 */
function parseDiffNewRanges(diffText) {
  const ranges = [];
  for (const line of String(diffText || '').split(/\r?\n/)) {
    const m = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
    if (!m) continue;
    const start = parseInt(m[1], 10);
    const count = m[2] === undefined ? 1 : parseInt(m[2], 10);
    if (count === 0) {
      ranges.push({ from: start, to: start });
    } else {
      ranges.push({ from: start, to: start + count - 1 });
    }
  }
  return ranges;
}

function gateRangesOverlap(a, b) {
  return a.from <= b.to && b.from <= a.to;
}

/**
 * Implementación de `inspectGateReject` (separada para envolverla en try/catch).
 * NO tira: ante cualquier ambigüedad/error → `{ stale:false }`.
 */
function _inspectGateRejectImpl(reject, head, opts, reasons) {
  const runGit = (opts && opts.runGit) || defaultRunGit;
  const cwd = (opts && opts.cwd) || REPO_ROOT;
  // SEC-2: argv-injection safe. `shell:false` fuerza CreateProcess directo (sin
  // cmd.exe que interprete `^{commit}`, metacaracteres o concatene argumentos —
  // ver DEP0190). `ensureGitInPath` resuelve git.exe cuando el pulpo corre como
  // servicio sin git en PATH (mismo patrón que git-ops en Windows).
  const gopts = { cwd, shell: false, env: ensureGitInPath(process.env) };
  const out = (stale, extra) => Object.assign(
    { stale, reasons, fixCommit: null, rejectRef: null, touchesCited: false },
    extra || {},
  );

  // CA-5: entrada nula/no-objeto → conservador.
  if (!reject || typeof reject !== 'object') {
    reasons.push('reject nulo o no-objeto → conservador');
    return out(false);
  }

  // SR-4/SEC-1: seguridad nunca stale. Defensa en profundidad (el wrapper ya
  // corta ANTES de tocar git; lo repetimos por si se llama a inspect directo).
  const source = String(reject.source || '').trim().toLowerCase();
  if (source === 'security') {
    reasons.push('source=security → nunca stale (SR-4/SEC-1)');
    return out(false);
  }

  // SEC-2: HEAD debe ser un SHA válido antes de tocar git.
  const headSha = normalizeGateSha(head);
  if (!headSha) {
    reasons.push('head no es un SHA válido → conservador (SEC-2)');
    return out(false);
  }

  // SEC-3: la ancestría requiere `rejectSha`. Sin él NO ordenamos por timestamp
  // (falsificable) → conservador.
  const rejectSha = normalizeGateSha(reject.rejectSha);
  if (!rejectSha) {
    reasons.push('sin rejectSha verificable (no ordenamos por timestamp, SEC-3) → conservador');
    return out(false);
  }

  // CA-5/SEC-2: citedFiles obligatorio, no vacío y confinado al repo.
  const citedRaw = Array.isArray(reject.citedFiles) ? reject.citedFiles : [];
  const citedFiles = citedRaw.map(normalizeCitedPath).filter(Boolean);
  if (!citedFiles.length) {
    reasons.push('sin citedFiles verificables/confinados → conservador (SR-5/SEC-2)');
    return out(false, { rejectRef: rejectSha });
  }

  // Resolver ambos refs a commits reales. CA-5: ref inexistente → false sin throw.
  const rejResolved = runGit(['rev-parse', '--verify', `${rejectSha}^{commit}`], gopts);
  if (!rejResolved || rejResolved.exit_code !== 0) {
    reasons.push('rejectSha no resuelve a commit (ref inexistente) → conservador');
    return out(false, { rejectRef: rejectSha });
  }
  const headResolved = runGit(['rev-parse', '--verify', `${headSha}^{commit}`], gopts);
  if (!headResolved || headResolved.exit_code !== 0) {
    reasons.push('head no resuelve a commit → conservador');
    return out(false, { rejectRef: rejectSha });
  }
  const rejFull = String(rejResolved.stdout || '').trim().toLowerCase();
  const headFull = String(headResolved.stdout || '').trim().toLowerCase();

  // SR-5 condición 1: estrictamente posterior (ancestría, no timestamp SEC-3).
  if (rejFull && headFull && rejFull === headFull) {
    reasons.push('rejectSha === head (mismo commit) → no posterior (SR-5/CA-3)');
    return out(false, { rejectRef: rejectSha, fixCommit: headFull });
  }
  const isAnc = runGit(['merge-base', '--is-ancestor', rejectSha, headSha], gopts);
  if (!isAnc || isAnc.exit_code !== 0) {
    reasons.push('fix no es descendiente del rechazo (merge-base --is-ancestor ≠ 0) → no posterior (SR-5/CA-3)');
    return out(false, { rejectRef: rejectSha, fixCommit: headFull });
  }
  reasons.push('fix estrictamente posterior al rechazo (ancestría OK)');

  // SR-5 condición 2: el fix toca los archivos citados.
  const diff = runGit(['diff', '--name-only', rejectSha, headSha], gopts);
  if (!diff || diff.exit_code !== 0) {
    reasons.push('git diff --name-only falló → conservador');
    return out(false, { rejectRef: rejectSha, fixCommit: headFull });
  }
  const changedFiles = new Set(
    String(diff.stdout || '')
      .split(/\r?\n/)
      .map((l) => l.trim().replace(/\\/g, '/'))
      .filter(Boolean),
  );
  const touchedCited = citedFiles.filter((f) => changedFiles.has(f));
  if (!touchedCited.length) {
    reasons.push('el fix NO toca ninguno de los archivos citados → falso stale (SR-5/CA-2)');
    return out(false, { rejectRef: rejectSha, fixCommit: headFull });
  }
  reasons.push(`fix toca archivo(s) citado(s): ${touchedCited.join(', ')}`);

  // SEC-4/CA-7: si el rechazo cita líneas, refinar a granularidad de rango.
  const citedLines = Array.isArray(reject.citedLines) ? reject.citedLines : null;
  if (citedLines && citedLines.length) {
    let anyLineTouched = false;
    for (const cl of citedLines) {
      if (!cl || typeof cl !== 'object') continue;
      const file = normalizeCitedPath(cl.file);
      if (!file || !touchedCited.includes(file)) continue;
      const from = Number(cl.from);
      const to = Number(cl.to === undefined ? cl.from : cl.to);
      if (!Number.isFinite(from) || !Number.isFinite(to)) continue;
      const citedRange = { from: Math.min(from, to), to: Math.max(from, to) };
      const fdiff = runGit(['diff', '--unified=0', rejectSha, headSha, '--', file], gopts);
      if (!fdiff || fdiff.exit_code !== 0) continue;
      const ranges = parseDiffNewRanges(fdiff.stdout);
      if (ranges.some((r) => gateRangesOverlap(r, citedRange))) {
        anyLineTouched = true;
        break;
      }
    }
    if (!anyLineTouched) {
      reasons.push('el fix no toca las líneas citadas (cambio fuera de rango) → falso stale (SEC-4/CA-7)');
      return out(false, { rejectRef: rejectSha, fixCommit: headFull, touchesCited: false });
    }
    reasons.push('el fix toca las líneas citadas (SEC-4 OK)');
  }

  reasons.push('doble condición SR-5 cumplida → stale (mecánico)');
  return out(true, { rejectRef: rejectSha, fixCommit: headFull, touchesCited: true });
}

/**
 * Variante genérica de `inspectBuildLog` para un rechazo de gate normalizado.
 * Evalúa la doble condición SR-5 (fix posterior por ancestría + toca archivo/
 * líneas citadas) y devuelve trazabilidad. NO muta el input ni el FS; sólo lee
 * git. NUNCA tira: ante error/ambigüedad → `{ stale:false }`.
 *
 * @param {{
 *   source?: string,
 *   rejectSha?: string,
 *   rejectedAt?: string,
 *   citedFiles?: string[],
 *   citedLines?: Array<{ file: string, from: number, to?: number }>,
 * }} reject  — rechazo de gate normalizado.
 * @param {string} head  — SHA vigente de HEAD sobre el que se evalúa el fix.
 * @param {{ cwd?: string, runGit?: Function }} [opts]
 * @returns {{
 *   stale: boolean, reasons: string[], fixCommit: string|null,
 *   rejectRef: string|null, touchesCited: boolean
 * }}
 */
function inspectGateReject(reject, head, opts = {}) {
  const reasons = [];
  try {
    return _inspectGateRejectImpl(reject, head, opts, reasons);
  } catch (e) {
    reasons.push(`error inesperado (${e && e.message}) → conservador`);
    return { stale: false, reasons, fixCommit: null, rejectRef: null, touchesCited: false };
  }
}

/**
 * Wrapper booleano de conveniencia (espeja `isBuildLogStale`). SR-4/SEC-1
 * PRIMERO DE TODO: si `source === 'security'` → `false` incondicional, ANTES de
 * cualquier chequeo git. Para cualquier otro caso, delega en `inspectGateReject`.
 *
 * @param {object} reject
 * @param {string} head
 * @param {{ cwd?: string, runGit?: Function }} [opts]
 * @returns {boolean}
 */
function isGateRejectStale(reject, head, opts) {
  // SR-4/SEC-1 incondicional, antes de tocar git.
  if (!reject || typeof reject !== 'object') return false;
  if (String(reject.source || '').trim().toLowerCase() === 'security') return false;
  const info = inspectGateReject(reject, head, opts);
  return info.stale === true;
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
  // #4766 — variante genérica de staleness para rechazos de gate
  inspectGateReject,
  isGateRejectStale,
  normalizeGateSha,
  normalizeCitedPath,
  parseDiffNewRanges,
  getStaleResetCount,
  appendAuditReset,
  buildTelegramStaleMessage,
  buildTelegramEscalationMessage,
  cleanYamlForRebuild,
  motivoReferencesBuildLog,
};
