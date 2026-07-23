// =============================================================================
// watchdog-supervisor.js — Lógica de decisión del supervisor del watchdog (#4077)
//
// Por qué este módulo existe
// --------------------------
// El watchdog (`.pipeline/watchdog.ps1`) es una tarea de Windows Task Scheduler
// que corre cada 2 min y escribe un heartbeat. Si esa tarea deja de dispararse
// (deshabilitada, borrada, instancia colgada), nadie relevanta los servicios.
//
// El supervisor (`watchdog-supervisor.ps1`, 2da tarea independiente) lee el
// heartbeat y, si está stale, relanza el watchdog principal. PowerShell no es
// testeable con `node --test`, así que TODA la lógica de decisión vive acá:
// PowerShell sólo recolecta hechos del SO y ejecuta `Start-ScheduledTask`.
//
// Defensas de seguridad incorporadas (de la fase de criterios, #4077):
//   SEC-1  fail-closed: heartbeat ausente/ilegible => tratar como stale.
//          cross-check con el SO: heartbeat fresco pero tarea NO viva => stale.
//   SEC-2  WATCHDOG_STALE_MINUTES inválido => default, NUNCA "nunca stale".
//   SEC-4  cap duro de relanzamientos por ventana + cooldown entre relanzamientos.
//
// Cero dependencias npm. Funciones puras (salvo load/save de estado en FS).
// =============================================================================

'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_STALE_MINUTES = 6;
const DEFAULT_MAX_RESTARTS = 3;
const DEFAULT_COOLDOWN_SECONDS = 90;
const DEFAULT_WINDOW_MINUTES = 60;

/**
 * Valida el umbral de staleness (SEC-2).
 * Debe ser entero positivo. Un valor no numérico / 0 / negativo NO debe
 * degradar el chequeo a "nunca stale": cae al default.
 *
 * @param {*} raw            valor crudo (string de env o number de config)
 * @param {number} fallback  default si raw es inválido
 * @returns {number} entero positivo
 */
function parseStaleMinutes(raw, fallback = DEFAULT_STALE_MINUTES) {
  const safeFallback =
    Number.isInteger(fallback) && fallback >= 1 ? fallback : DEFAULT_STALE_MINUTES;
  if (typeof raw === 'number') {
    return Number.isInteger(raw) && raw >= 1 ? raw : safeFallback;
  }
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (/^[0-9]+$/.test(trimmed)) {
      const n = parseInt(trimmed, 10);
      if (Number.isInteger(n) && n >= 1) return n;
    }
  }
  return safeFallback;
}

/**
 * Valida un entero positivo genérico (max_restarts, window, cooldown).
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

const DEFAULT_STATE = Object.freeze({ relaunches: [], lastRelaunchTs: 0, lastEscalationTs: 0 });

/**
 * Carga el estado del supervisor (backoff/contador). Fail-soft: archivo
 * ausente o corrupto => estado vacío (NO bloquea la recuperación).
 */
function loadState(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw);
    return normalizeState(parsed);
  } catch (_) {
    return { ...DEFAULT_STATE, relaunches: [] };
  }
}

function normalizeState(obj) {
  const out = { relaunches: [], lastRelaunchTs: 0, lastEscalationTs: 0 };
  if (!obj || typeof obj !== 'object') return out;
  if (Array.isArray(obj.relaunches)) {
    out.relaunches = obj.relaunches.filter((t) => Number.isFinite(t) && t > 0);
  }
  if (Number.isFinite(obj.lastRelaunchTs) && obj.lastRelaunchTs > 0) {
    out.lastRelaunchTs = obj.lastRelaunchTs;
  }
  if (Number.isFinite(obj.lastEscalationTs) && obj.lastEscalationTs > 0) {
    out.lastEscalationTs = obj.lastEscalationTs;
  }
  return out;
}

/**
 * Escritura atómica del estado (tmp + rename), igual patrón que el heartbeat.
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
 * Decide qué hacer dado el estado del heartbeat y del SO. Función PURA.
 *
 * @param {object} facts
 * @param {boolean} facts.heartbeatExists
 * @param {number|null} facts.heartbeatAgeMs   edad del heartbeat en ms
 * @param {boolean|null} facts.taskHealthy     cross-check SO: ¿la tarea principal
 *                                             está viva/healthy? null = desconocido
 * @param {number} facts.now                   timestamp actual (ms)
 * @param {object} facts.state                 estado del supervisor (relaunches, ...)
 * @param {number} [facts.staleMinutes]
 * @param {number} [facts.maxRestarts]
 * @param {number} [facts.cooldownSeconds]
 * @param {number} [facts.windowMinutes]
 * @returns {{action:'skip'|'relaunch'|'escalate', stale:boolean, reason:string,
 *            level:'info'|'warn'|'error', staleReason?:string, restartsInWindow?:number}}
 */
function decide(facts) {
  const staleMinutes = parseStaleMinutes(facts.staleMinutes, DEFAULT_STALE_MINUTES);
  const maxRestarts = parsePositiveInt(facts.maxRestarts, DEFAULT_MAX_RESTARTS);
  const cooldownSeconds = parsePositiveInt(facts.cooldownSeconds, DEFAULT_COOLDOWN_SECONDS);
  const windowMinutes = parsePositiveInt(facts.windowMinutes, DEFAULT_WINDOW_MINUTES);

  const now = Number.isFinite(facts.now) ? facts.now : 0;
  const staleMs = staleMinutes * 60 * 1000;
  const cooldownMs = cooldownSeconds * 1000;
  const windowMs = windowMinutes * 60 * 1000;
  const state = normalizeState(facts.state);

  // --- 1. ¿Está stale? (SEC-1 fail-closed) -------------------------------
  let stale = false;
  let staleReason = null;
  const age = facts.heartbeatAgeMs;
  if (!facts.heartbeatExists || age == null || !Number.isFinite(age) || age < 0) {
    stale = true;
    staleReason = 'heartbeat-missing'; // ausente o ilegible => fail-closed
  } else if (age > staleMs) {
    stale = true;
    staleReason = 'heartbeat-stale';
  }

  // SEC-1 cross-check contra el SO: heartbeat fresco pero la tarea principal
  // NO está viva/healthy => igual hay que actuar (no confiar sólo en mtime).
  if (!stale && facts.taskHealthy === false) {
    stale = true;
    staleReason = 'os-mismatch';
  }

  if (!stale) {
    return { action: 'skip', stale: false, reason: 'fresh', level: 'info' };
  }

  // --- 2. Stale: aplicar cap duro y cooldown (SEC-4) ---------------------
  const recent = state.relaunches.filter((t) => now - t < windowMs);

  // Cap duro PRIMERO: si ya relanzamos maxRestarts veces en la ventana y sigue
  // stale, NO relanzar más — escalar a humano.
  if (recent.length >= maxRestarts) {
    return {
      action: 'escalate',
      stale: true,
      reason: 'cap-reached',
      level: 'error',
      staleReason,
      restartsInWindow: recent.length,
    };
  }

  // Cooldown: evita carrera de respawn (EADDRINUSE 3200) y spam de alertas.
  if (state.lastRelaunchTs > 0 && now - state.lastRelaunchTs < cooldownMs) {
    return {
      action: 'skip',
      stale: true,
      reason: 'cooldown',
      level: 'info',
      staleReason,
      restartsInWindow: recent.length,
    };
  }

  return {
    action: 'relaunch',
    stale: true,
    reason: staleReason,
    level: 'warn',
    staleReason,
    restartsInWindow: recent.length,
  };
}

/**
 * Registra un relanzamiento en el estado (poda los viejos fuera de ventana).
 * Devuelve un NUEVO objeto de estado (no muta el input).
 */
function recordRelaunch(state, now, windowMinutes = DEFAULT_WINDOW_MINUTES) {
  const win = parsePositiveInt(windowMinutes, DEFAULT_WINDOW_MINUTES) * 60 * 1000;
  const base = normalizeState(state);
  const relaunches = base.relaunches.filter((t) => now - t < win);
  relaunches.push(now);
  return { ...base, relaunches, lastRelaunchTs: now };
}

/**
 * Marca una escalada (para dedup de la alerta de cap). Devuelve nuevo estado.
 */
function recordEscalation(state, now) {
  const base = normalizeState(state);
  return { ...base, lastEscalationTs: now };
}

module.exports = {
  decide,
  parseStaleMinutes,
  parsePositiveInt,
  loadState,
  saveStateAtomic,
  normalizeState,
  recordRelaunch,
  recordEscalation,
  DEFAULT_STALE_MINUTES,
  DEFAULT_MAX_RESTARTS,
  DEFAULT_COOLDOWN_SECONDS,
  DEFAULT_WINDOW_MINUTES,
};
