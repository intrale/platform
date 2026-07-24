// =============================================================================
// wave-stall-watchdog.js — Dead-man's switch de la ola (#4708)
//
// Por qué este módulo existe
// --------------------------
// El 2026-07-14 la Ola Puente quedó con trabajo abierto/habilitado y 0 agentes
// despachando durante un largo rato sin que saltara ninguna alarma. No existía
// un dead-man's switch que dijera "esta ola lleva N minutos sin mover una ficha
// y sin causa declarada". Combinado con el corte silencioso del circuit breaker,
// el sistema se quedó ciego (incidente raíz #4700).
//
// Este módulo aporta la lógica de decisión PURA (`decide(facts)`) modelada 1:1
// sobre `watchdog-supervisor.js::decide` (fail-closed, cap/cooldown/dedup por
// ventana, parse de umbral con clamp). El brazo del Pulpo (pulpo.js) recolecta
// los hechos del filesystem y llama `decide`; ante `alert`/`escalate` dispara
// Telegram + estado de ola `stalled` + escalada `needs-human`.
//
// Defensas de seguridad incorporadas (de la fase de criterios, #4708):
//   SEC-1  Integridad de la 'causa declarada' (fail-closed): causa ausente,
//          ilegible, corrupta o EXPIRADA => tratar como *sin causa* => disparar.
//          Nunca asumir "hay causa, callar".
//   SEC-2  El mensaje sólo lleva waveKey + motivo. Prohibido paths absolutos,
//          tokens o dumps de estado (validado por buildAlertMessage + test).
//   SEC-3  stall_minutes desde config validada: 0, negativo, no-numérico o
//          gigante => default seguro. NUNCA "nunca stall" ni deshabilitar de
//          facto (clamp con MAX_STALL_MINUTES).
//   SEC-4  Anti-flooding: dedup por ventana (lastAlertTs por ola) — una alerta
//          + escalado por episodio, cooldown entre re-alertas. Un episodio nuevo
//          (la ola movió ficha y volvió a estancarse) SÍ re-alerta.
//
// Cero dependencias npm. `decide` es una función PURA: NO lee del filesystem
// (las señales entran como `facts`), y devuelve el `nextState` a persistir.
// =============================================================================

'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_STALL_MINUTES = 20;
// Cota superior de seguridad (SEC-3): un N gigante equivaldría a "nunca stall".
// 1440 min = 24h. Un umbral mayor a esto se trata como inválido → default.
const MAX_STALL_MINUTES = 1440;
const DEFAULT_COOLDOWN_MINUTES = 30;
const DEFAULT_WINDOW_MINUTES = 60;

/**
 * Valida el umbral de estancamiento en minutos (SEC-3).
 * Debe ser entero en [1, MAX_STALL_MINUTES]. Un valor no numérico / 0 /
 * negativo / absurdamente grande NO debe degradar el chequeo a "nunca stall":
 * cae al default seguro.
 *
 * @param {*} raw            valor crudo (string de env o number de config)
 * @param {number} fallback  default si raw es inválido
 * @returns {number} entero positivo acotado
 */
function parseStallMinutes(raw, fallback = DEFAULT_STALL_MINUTES) {
  const safeFallback =
    Number.isInteger(fallback) && fallback >= 1 && fallback <= MAX_STALL_MINUTES
      ? fallback
      : DEFAULT_STALL_MINUTES;
  const inRange = (n) => Number.isInteger(n) && n >= 1 && n <= MAX_STALL_MINUTES;
  if (typeof raw === 'number') {
    return inRange(raw) ? raw : safeFallback;
  }
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (/^[0-9]+$/.test(trimmed)) {
      const n = parseInt(trimmed, 10);
      if (inRange(n)) return n;
    }
  }
  return safeFallback;
}

/**
 * Valida un entero positivo genérico (cooldown, window).
 */
function parsePositiveInt(raw, fallback) {
  const safeFallback = Number.isInteger(fallback) && fallback >= 1 ? fallback : 1;
  if (typeof raw === 'number' && Number.isInteger(raw) && raw >= 1) return raw;
  if (typeof raw === 'string' && /^[0-9]+$/.test(raw.trim())) {
    const n = parseInt(raw.trim(), 10);
    if (n >= 1) return n;
  }
  return safeFallback;
}

const DEFAULT_STATE = Object.freeze({
  lastMovementTs: 0,
  lastSignature: null,
  lastAlertTs: 0,
  alertCount: 0,
});

/**
 * Normaliza el estado persistido del watchdog. Tolerante: campos ausentes o de
 * tipo inválido caen a su default. NO propaga basura al resto de la lógica.
 */
function normalizeState(obj) {
  const out = { lastMovementTs: 0, lastSignature: null, lastAlertTs: 0, alertCount: 0 };
  if (!obj || typeof obj !== 'object') return out;
  if (Number.isFinite(obj.lastMovementTs) && obj.lastMovementTs > 0) {
    out.lastMovementTs = obj.lastMovementTs;
  }
  if (typeof obj.lastSignature === 'string') {
    out.lastSignature = obj.lastSignature;
  }
  if (Number.isFinite(obj.lastAlertTs) && obj.lastAlertTs > 0) {
    out.lastAlertTs = obj.lastAlertTs;
  }
  if (Number.isInteger(obj.alertCount) && obj.alertCount >= 0) {
    out.alertCount = obj.alertCount;
  }
  return out;
}

/**
 * Carga el estado del watchdog. Fail-soft: archivo ausente o corrupto =>
 * estado vacío (NO bloquea la vigilancia).
 */
function loadState(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw);
    return normalizeState(parsed);
  } catch (_) {
    return { ...DEFAULT_STATE };
  }
}

/**
 * Escritura atómica del estado (tmp + rename).
 */
function saveStateAtomic(file, state) {
  const tmp = `${file}.tmp`;
  const dir = path.dirname(file);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (_) {
    /* fail-soft */
  }
  fs.writeFileSync(tmp, JSON.stringify(normalizeState(state), null, 2));
  fs.renameSync(tmp, file);
}

/**
 * ¿La causa declarada es válida para suprimir la alarma? (SEC-1, fail-closed).
 *
 * Una causa sólo suprime la alarma si:
 *   - existe (no null / no undefined),
 *   - es legible (readable !== false: corrupta/ilegible => NO suprime),
 *   - está declarada (declared === true),
 *   - NO está expirada (si trae expiresAt finito, now <= expiresAt).
 *
 * Ante CUALQUIER ambigüedad (ausente, ilegible, expirada) => NO válida => la
 * alarma se dispara. Nunca "hay causa, callar".
 *
 * @param {object|null} cause  { declared, kind?, expiresAt?, readable? }
 * @param {number} now         timestamp actual (ms)
 * @returns {boolean}
 */
function isCauseValid(cause, now) {
  if (!cause || typeof cause !== 'object') return false;     // ausente
  if (cause.readable === false) return false;                // corrupta/ilegible
  if (cause.declared !== true) return false;                 // sin causa real
  // Expiración (anti "causa zombi"): si trae expiresAt finito y ya venció → inválida.
  if (cause.expiresAt != null) {
    const exp = Number(cause.expiresAt);
    if (!Number.isFinite(exp)) return false;                 // expiración ilegible → fail-closed
    if (Number.isFinite(now) && now > exp) return false;     // expirada
  }
  return true;
}

/**
 * Firma de movimiento de la ola: combina el conteo de despacho (`trabajando/`
 * de todas las fases) con el último `avancePct`. La ola "movió una ficha" si
 * cambia CUALQUIERA de los dos (definición del PO, CA). Evita el falso
 * estancamiento por trabajo intra-fase (agente trabajando sin promover ficha).
 */
function movementSignature(dispatching, progressSeries) {
  const d = Number.isFinite(dispatching) ? dispatching : 0;
  let avance = 'na';
  if (Array.isArray(progressSeries) && progressSeries.length > 0) {
    const last = progressSeries[progressSeries.length - 1];
    if (last && Number.isFinite(last.avancePct)) avance = String(last.avancePct);
  }
  return `${d}:${avance}`;
}

/**
 * Construye el mensaje de alerta (SEC-2 / CA-5 / guidelines UX).
 * SÓLO waveKey + motivo + contexto operativo mínimo. Prohibido paths absolutos,
 * tokens, secrets o dumps de estado. Determinístico y testeable.
 *
 * @param {{waveKey:*, stallMinutes:number, enabledCount:number}} p
 * @returns {string}
 */
function buildAlertMessage(p) {
  const waveKey = p && p.waveKey != null ? String(p.waveKey) : '?';
  const mins = Number.isFinite(p && p.stallMinutes) ? p.stallMinutes : DEFAULT_STALL_MINUTES;
  const enabled = Number.isInteger(p && p.enabledCount) && p.enabledCount >= 0 ? p.enabledCount : 0;
  return (
    `Ola ${waveKey} estancada — 0 despacho hace ${mins} min sin causa declarada. ` +
    `${enabled} issue(s) habilitado(s) esperando; ola marcada needs_attention.`
  );
}

/**
 * Decide qué hacer dada la foto de la ola. Función PURA: no lee FS, no muta el
 * input; devuelve la decisión y el `nextState` a persistir por el caller.
 *
 * @param {object} facts
 * @param {number} facts.now                  timestamp actual (ms)
 * @param {*}      facts.waveKey              identificador de la ola activa
 * @param {number} facts.enabledCount         # issues habilitados (no completados, sin bloqueo)
 * @param {number} facts.dispatching          # archivos en trabajando/ de todas las fases
 * @param {Array}  [facts.progressSeries]     serie {ts, waveKey, avancePct} de wave-progress
 * @param {object|null} [facts.cause]         causa declarada normalizada (ver isCauseValid)
 * @param {object} [facts.state]              estado persistido del watchdog
 * @param {*}      [facts.stallMinutes]
 * @param {*}      [facts.cooldownMinutes]
 * @param {*}      [facts.windowMinutes]
 * @returns {{action:'skip'|'alert'|'escalate', reason:string, level:'info'|'warn'|'error',
 *            stalledMs:number, message:string|null, waveKey:*, enabledCount:number,
 *            stallMinutes:number, nextState:object}}
 */
function decide(facts) {
  const stallMinutes = parseStallMinutes(facts.stallMinutes, DEFAULT_STALL_MINUTES);
  const cooldownMinutes = parsePositiveInt(facts.cooldownMinutes, DEFAULT_COOLDOWN_MINUTES);
  parsePositiveInt(facts.windowMinutes, DEFAULT_WINDOW_MINUTES); // validado (reservado para poda futura)

  const now = Number.isFinite(facts.now) ? facts.now : 0;
  const stallMs = stallMinutes * 60 * 1000;
  const cooldownMs = cooldownMinutes * 60 * 1000;

  const state = normalizeState(facts.state);
  const enabledCount = Number.isInteger(facts.enabledCount) && facts.enabledCount > 0 ? facts.enabledCount : 0;
  const dispatching = Number.isInteger(facts.dispatching) && facts.dispatching > 0 ? facts.dispatching : 0;

  // --- 1. Detección de "ficha movida" -----------------------------------
  // La firma combina despacho + avancePct. Si cambia (o es la primera foto),
  // la ola se movió: reiniciamos el reloj de estancamiento y el episodio de
  // alerta (SEC-4: un episodio nuevo posterior SÍ re-alerta).
  const signature = movementSignature(dispatching, facts.progressSeries);
  const movedFicha = state.lastSignature == null || state.lastSignature !== signature;
  const nextState = { ...state, lastSignature: signature };
  if (movedFicha) {
    nextState.lastMovementTs = now;
    nextState.lastAlertTs = 0;
    nextState.alertCount = 0;
  }
  const lastMovementTs = nextState.lastMovementTs > 0 ? nextState.lastMovementTs : now;

  const base = (action, reason, level) => ({
    action,
    reason,
    level,
    stalledMs: Math.max(0, now - lastMovementTs),
    message: null,
    waveKey: facts.waveKey != null ? facts.waveKey : null,
    enabledCount,
    stallMinutes,
    nextState,
  });

  // --- 2. Sin trabajo habilitado => nada que vigilar --------------------
  if (enabledCount <= 0) return base('skip', 'no-enabled-work', 'info');

  // --- 3. Hay despacho actual => la ola no está muda --------------------
  if (dispatching > 0) return base('skip', 'dispatching', 'info');

  // --- 4. Causa declarada vigente => no falsa-alarma (CA-2 / SEC-1) -----
  // Fail-closed: causa ausente/ilegible/expirada NO es válida => seguimos.
  if (isCauseValid(facts.cause, now)) {
    const kind = (facts.cause && facts.cause.kind) ? String(facts.cause.kind) : 'declared';
    return base('skip', `declared-cause:${kind}`, 'info');
  }

  // --- 5. ¿Cuánto lleva mudo? -------------------------------------------
  const stalledMs = Math.max(0, now - lastMovementTs);
  if (stalledMs < stallMs) return base('skip', 'within-threshold', 'info');

  // --- 6. Anti-flooding: dedup por cooldown dentro del episodio (SEC-4) -
  if (state.lastAlertTs > 0 && now - state.lastAlertTs < cooldownMs) {
    return base('skip', 'cooldown', 'info');
  }

  // --- 7. Estancamiento inexplicado confirmado: disparar ----------------
  const prevAlerts = state.alertCount || 0;
  const action = prevAlerts === 0 ? 'alert' : 'escalate';
  nextState.lastAlertTs = now;
  nextState.alertCount = prevAlerts + 1;

  const decision = base(action, 'unexplained-stall', action === 'alert' ? 'warn' : 'error');
  decision.stalledMs = stalledMs;
  decision.message = buildAlertMessage({ waveKey: facts.waveKey, stallMinutes, enabledCount });
  return decision;
}

module.exports = {
  decide,
  isCauseValid,
  buildAlertMessage,
  movementSignature,
  parseStallMinutes,
  parsePositiveInt,
  normalizeState,
  loadState,
  saveStateAtomic,
  DEFAULT_STALL_MINUTES,
  MAX_STALL_MINUTES,
  DEFAULT_COOLDOWN_MINUTES,
  DEFAULT_WINDOW_MINUTES,
};
