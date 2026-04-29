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

const STATE_FILE = path.join(__dirname, 'circuit-breaker-infra.json');
const STATE_TMP = STATE_FILE + '.tmp';

/** Umbral de fallos consecutivos que abre el CB. */
const CONSECUTIVE_THRESHOLD = 3;

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
  };
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
    return { ...defaultState(), ...parsed };
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
 * @returns {{ opened: boolean, state: object }} — opened=true si este fallo abrió el CB
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
  if (next.state !== 'open' && next.consecutive_failures >= CONSECUTIVE_THRESHOLD) {
    next.state = 'open';
    next.opened_at = new Date().toISOString();
    next.alert_sent = false; // se marcará true cuando pulpo.js encole el Telegram
    opened = true;
  }

  const persisted = writeState(next);
  return { opened, state: persisted };
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
 * @returns {{ changed: boolean, previous: object, state: object }}
 */
function resume() {
  const previous = readState();
  if (previous.state !== 'open') {
    return { changed: false, previous, state: previous };
  }
  const next = writeState({
    state: 'closed',
    consecutive_failures: 0,
    last_error_code: previous.last_error_code, // mantener como histórico legible
    last_issue_trigger: previous.last_issue_trigger,
    opened_at: null,
    alert_sent: false,
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
};
