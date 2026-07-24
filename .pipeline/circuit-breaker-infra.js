// =============================================================================
// circuit-breaker-infra.js — Estado persistido del circuit breaker de infra
//
// Diseño (issue #2305):
//   - Archivo: .pipeline/circuit-breaker-infra.json (gitignored)
//   - Escritura atómica (write a .tmp + rename) para evitar archivos truncados
//     que crasheen al dashboard mientras pulpo.js escribe.
//   - Lectura defensiva: si el JSON está corrupto devolvemos un estado default
//     cerrado en vez de crashear (el dashboard también consume este archivo).
//   - Códigos de red considerados infra (alineado con #2304):
//       ENOTFOUND, ECONNREFUSED, ETIMEDOUT, ECONNRESET, EAI_AGAIN
// =============================================================================

const fs = require('fs');
const path = require('path');

// #3940 — el path es overridable por env para que los tests puedan apuntar a
// un archivo temporal sin tocar el estado real del pipeline en producción.
const STATE_FILE = process.env.CB_INFRA_STATE_FILE || path.join(__dirname, 'circuit-breaker-infra.json');
const STATE_TMP = STATE_FILE + '.tmp';

/** Umbral de fallos consecutivos que abre el CB. */
const CONSECUTIVE_THRESHOLD = 3;

/**
 * #3940 / SEC-R3 — ventana anti-flapping. Si el CB reabre dentro de esta
 * ventana después de un auto-resume, se suspende el auto-cierre y se escala a
 * humano (red inestable que no se cura sola). 10 min por defecto.
 */
const AUTO_RESUME_FLAP_WINDOW_MS = 10 * 60 * 1000;

/** Códigos de error de Node que consideramos fallos de infra/red. */
const INFRA_ERROR_CODES = new Set([
  'ENOTFOUND',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'ECONNRESET',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
]);

function defaultState() {
  return {
    state: 'closed',
    consecutive_failures: 0,
    last_error_code: null,
    last_issue_trigger: null,
    opened_at: null,
    alert_sent: false,
    // #3940 — auto-resume del CB de infra tras N prechecks OK consecutivos.
    // Observabilidad del progreso; el decisor REAL del auto-resume es el streak
    // in-memory de pulpo (alimentado solo por probes reales, anti-spoofing #2335).
    consecutive_ok_prechecks: 0,
    // SEC-R4 — auditoría del cierre: origen y timestamp del último resume.
    resumed_by: null,           // 'auto' | 'manual'
    resumed_at: null,           // ISO timestamp
    // SEC-R3 — anti-flapping: contador de auto-resumes + último timestamp y
    // flag de suspensión cuando se detecta reapertura dentro de la ventana.
    auto_resume_count: 0,
    last_auto_resume_at: null,  // ISO timestamp del último auto-resume
    auto_resume_suspended: false,
  };
}

/**
 * SEC-R2 — sanitiza un contador persistido que podría venir manipulado o
 * corrupto en el JSON. Sólo enteros ≥ 0; cualquier otra cosa → 0.
 */
function sanitizeCounter(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) return 0;
  return n;
}

/**
 * #3940 / SEC-R1 — sanitiza el threshold de auto-resume leído de config.
 * Debe ser entero ≥ 1; cualquier valor inválido (0, negativo, no numérico,
 * ausente) cae al `fallback`. Función pura (sin logging) para ser testeable.
 *
 * @param {*} raw — valor crudo de `circuit_breaker.auto_resume_ok_threshold`.
 * @param {number} [fallback=3] — default seguro.
 * @returns {{ value: number, fellBack: boolean }}
 */
function sanitizeAutoResumeThreshold(raw, fallback = 3) {
  // Estricto (SEC-R1): sólo un number entero ≥ 1. Un string (aunque sea '3'),
  // boolean u objeto se considera misconfiguración → fallback al default.
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1) {
    return { value: fallback, fellBack: true };
  }
  return { value: raw, fellBack: false };
}

/**
 * #3940 — decisión pura de auto-resume. Devuelve true sólo si corresponde
 * cerrar el CB automáticamente. Separada de los side-effects (resume/log/
 * telegram) para ser testeable sin pulpo.
 *
 * @param {object} p
 * @param {boolean} p.precheckOk — último precheck dio OK.
 * @param {boolean} p.cbOpen — el CB está abierto.
 * @param {number} p.streak — prechecks OK consecutivos reales (in-memory).
 * @param {number} p.threshold — umbral ya sanitizado (≥ 1).
 * @param {boolean} p.suspended — auto-resume suspendido por flapping (SEC-R3).
 * @returns {boolean}
 */
function shouldAutoResume({ precheckOk, cbOpen, streak, threshold, suspended }) {
  if (!precheckOk) return false;
  if (!cbOpen) return false;       // idempotencia
  if (suspended) return false;     // SEC-R3 — flapping detectado
  return Number(streak) >= Number(threshold);
}

/**
 * Lectura defensiva del estado. Si el archivo no existe o está corrupto,
 * devuelve el estado default cerrado. NUNCA lanza excepción — el dashboard
 * lo consume y no puede crashear por un JSON truncado.
 */
function readState() {
  try {
    if (!fs.existsSync(STATE_FILE)) return defaultState();
    const raw = fs.readFileSync(STATE_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    // Validación mínima de shape.
    if (!parsed || typeof parsed !== 'object') return defaultState();
    const merged = { ...defaultState(), ...parsed };
    // SEC-R2 — el merge es permisivo: sanitizar los contadores numéricos para
    // que un JSON manipulado/corrupto (streak alto) no dispare un resume
    // inmediato ni rompa la lógica anti-flapping.
    merged.consecutive_ok_prechecks = sanitizeCounter(merged.consecutive_ok_prechecks);
    merged.auto_resume_count = sanitizeCounter(merged.auto_resume_count);
    return merged;
  } catch {
    return defaultState();
  }
}

/**
 * Escritura atómica: escribe en `.tmp` y renombra. Así el dashboard nunca
 * lee un archivo a medias.
 */
function writeState(state) {
  const next = { ...defaultState(), ...state };
  fs.writeFileSync(STATE_TMP, JSON.stringify(next, null, 2));
  fs.renameSync(STATE_TMP, STATE_FILE);
  return next;
}

/** ¿El código de error proviene de una falla de red/infra? */
function isInfraErrorCode(code) {
  if (!code) return false;
  return INFRA_ERROR_CODES.has(String(code).toUpperCase());
}

/**
 * Registrar un fallo de infra.
 *
 * @param {number|string} issue — issue que disparó el fallo
 * @param {string} errorCode — p.ej. ENOTFOUND
 * @returns {{ opened: boolean, flapping: boolean, state: object }}
 *   opened=true si este fallo abrió el CB; flapping=true si reabrió dentro de
 *   la ventana post-auto-resume (SEC-R3) → escalar a humano, no volver a auto-cerrar.
 */
function registerInfraFailure(issue, errorCode) {
  const current = readState();
  const next = {
    ...current,
    consecutive_failures: current.consecutive_failures + 1,
    last_error_code: errorCode || current.last_error_code || null,
    last_issue_trigger: issue != null ? parseInt(issue, 10) : current.last_issue_trigger,
  };

  let opened = false;
  let flapping = false;
  if (next.state !== 'open' && next.consecutive_failures >= CONSECUTIVE_THRESHOLD) {
    next.state = 'open';
    next.opened_at = new Date().toISOString();
    next.alert_sent = false; // se marcará true cuando pulpo.js encole el Telegram
    // El streak de prechecks OK se invalida al abrir el CB.
    next.consecutive_ok_prechecks = 0;
    opened = true;

    // SEC-R3 — si reabre poco después de un auto-resume, la red está flapeando:
    // suspender el auto-cierre y marcar para escalada (lo reactiva un resume manual).
    if (next.last_auto_resume_at) {
      const since = Date.now() - Date.parse(next.last_auto_resume_at);
      if (Number.isFinite(since) && since >= 0 && since <= AUTO_RESUME_FLAP_WINDOW_MS) {
        next.auto_resume_suspended = true;
        flapping = true;
      }
    }
  }

  const persisted = writeState(next);
  return { opened, flapping, state: persisted };
}

/**
 * Resetear el contador cuando cualquier issue termina OK (red funcionó).
 * No cambia el estado si el CB ya está `open` — eso sólo lo hace `resume()`.
 *
 * @returns {object|null} nuevo estado si hubo cambios, o null si no había nada que resetear.
 */
function resetOnSuccess() {
  const current = readState();
  if (current.state === 'open') return null; // sólo resume() reabre
  if (current.consecutive_failures === 0 && !current.last_error_code) return null;
  return writeState({
    ...current,
    consecutive_failures: 0,
    last_error_code: null,
  });
}

/**
 * Marcar que ya se envió la alerta Telegram por esta apertura.
 */
function markAlertSent() {
  const current = readState();
  if (!current.alert_sent) {
    return writeState({ ...current, alert_sent: true });
  }
  return current;
}

/**
 * Reanudar el pipeline: cerrar el CB, resetear contadores, limpiar alert_sent.
 * Idempotente: si ya está cerrado, devuelve { changed: false }.
 *
 * #3940 — `origin` distingue el cierre automático del manual para auditoría
 * (SEC-R4) y anti-flapping (SEC-R3). Default `'manual'` → `resume.js` no cambia.
 *
 * @param {'auto'|'manual'} [origin='manual'] — quién dispara el cierre.
 * @returns {{ changed: boolean, previous: object, state: object }}
 */
function resume(origin = 'manual') {
  const previous = readState();
  if (previous.state !== 'open') {
    return { changed: false, previous, state: previous };
  }
  const safeOrigin = origin === 'auto' ? 'auto' : 'manual';
  const now = new Date().toISOString();
  const next = writeState({
    ...previous,
    state: 'closed',
    consecutive_failures: 0,
    consecutive_ok_prechecks: 0,
    last_error_code: previous.last_error_code, // mantener como histórico legible
    last_issue_trigger: previous.last_issue_trigger,
    opened_at: null,
    alert_sent: false,
    // SEC-R4 — auditoría: quién y cuándo cerró el CB.
    resumed_by: safeOrigin,
    resumed_at: now,
    // SEC-R3 — el cierre limpia la suspensión; un resume manual rehabilita el
    // auto-resume tras un episodio de flapping.
    auto_resume_suspended: false,
    auto_resume_count: safeOrigin === 'auto'
      ? (previous.auto_resume_count || 0) + 1
      : (previous.auto_resume_count || 0),
    last_auto_resume_at: safeOrigin === 'auto' ? now : previous.last_auto_resume_at,
  });
  return { changed: true, previous, state: next };
}

/** ¿Está abierto el CB ahora mismo? */
function isOpen() {
  return readState().state === 'open';
}

module.exports = {
  STATE_FILE,
  CONSECUTIVE_THRESHOLD,
  AUTO_RESUME_FLAP_WINDOW_MS,
  INFRA_ERROR_CODES,
  readState,
  writeState,
  isInfraErrorCode,
  registerInfraFailure,
  resetOnSuccess,
  markAlertSent,
  resume,
  isOpen,
  defaultState,
  sanitizeCounter,
  sanitizeAutoResumeThreshold,
  shouldAutoResume,
};
