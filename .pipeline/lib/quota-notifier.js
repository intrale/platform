// =============================================================================
// quota-notifier.js — Telegram lifecycle para modo cuota Anthropic agotada
// Issue #2975 (split de #2955) — depende del flag de #2974
//
// Responsabilidades:
//   - Notificación inicial al setear el flag (1 sola vez).
//   - Recordatorios periódicos rotando A→B→C→D→A (FIFO estricto).
//   - Mensaje de cierre al borrar el flag (con/sin cola de agentes).
//   - Respuesta canned a texto libre del commander (con debounce 2 min).
//   - Skip del cierre si el bloqueo duró <5 min (anti falso positivo).
//   - Redacción obligatoria de TODO mensaje vía lib/redact.js (CA-12).
//
// Copies: transcripción literal de
//   .pipeline/assets/mockups/narrativa-quota-exhausted.md
//   (rama agent/2955-ux-criterios, blob 16d68986). Sin Markdown ni emojis.
//   Solo se interpolan campos del sistema (HH:MM, countdown, N agentes).
//   Prohibido interpolar input de usuario (CA-S7).
// =============================================================================
'use strict';

const { redactSensitive } = require('./redact');

// -- Constantes de copy (literal del MD §2-§5) --------------------------------
const QUOTA_COPY = {
  // §2 — inicial
  initial:
    'Cuota Anthropic agotada.\n' +
    'Pipeline en modo deterministico. Reset estimado: {hhmm} (en {countdown}).',
  // §2 — variante para resets_at fallback (CA-8 hereditario)
  initialFallback:
    'Cuota Anthropic agotada.\n' +
    'Pipeline en modo deterministico. Reset estimado: proximo reset semanal (en {countdown}).',
  // §3 — recordatorios A/B/C/D
  reminders: [
    // A — operacional
    'Cuota sigue agotada.\n' +
    'Faltan {countdown} para el reset ({hhmm}).\n' +
    'Pipeline deterministico: {n} skills procesando.',
    // B — informativa
    'Recordatorio: pipeline en modo deterministico.\n' +
    'Reset al volver la cuota: {hhmm} (en {countdown}).\n' +
    '{n} archivos LLM esperando en cola.',
    // C — corta
    'Cuota Anthropic: {countdown} para el reset ({hhmm}).\n' +
    'Determinisicos siguen avanzando.',
    // D — con hint a comandos
    'Pipeline aun en modo deterministico (reset {hhmm}, en {countdown}).\n' +
    'Si necesitas estado: /status, /dashboard, /metrics.',
  ],
  // §4 — canned a texto libre (sin interpolación de input usuario, CA-S7)
  cannedFreeText:
    'Cuota Anthropic agotada hasta las {hhmm}.\n' +
    'Pipeline operando en modo deterministico.\n' +
    'Comandos disponibles: /status /metrics /dashboard /intake /pause /ghostbusters /restart /limpiar.',
  // §5 — restaurada con cola
  restored:
    'Cuota Anthropic restaurada.\n' +
    'Drenando cola de {n} agentes encolados.\n' +
    'Pipeline volviendo a operacion full.',
  // §5 — restaurada sin cola (N=0)
  restoredEmpty:
    'Cuota Anthropic restaurada.\n' +
    'No habia agentes encolados — pipeline directo a operacion full.\n' +
    'Pipeline volviendo a operacion full.',
  // §3013 — alerta de umbral 90% por snapshot real (CA-UX-7 / narrativa §4.1).
  // Microcopy literal, sin interpolar PII. Las variables {date}, {hhmm} y
  // {countdown} las resuelve quota-snapshot-integration con el reset semanal
  // calculado por weekly-quota.js (no del snapshot, para no leakear).
  weeklyGateSnapshot:
    'Cuota semanal al 90% segun snapshot real.\n' +
    'Pausando spawn de skills LLM para evitar 429.\n' +
    'Reset semanal estimado: {date} {hhmm} (en {countdown}).\n' +
    'Determinisicos siguen procesando.',
  // §3013 — alerta de cuenta no esperada (CA-UX-7 / narrativa §4.3).
  // CRÍTICO: NO se interpolan emails (ni esperado ni real). El operador
  // busca el detalle en .pipeline/logs/quota-parser-*.log.
  accountMismatchSnapshot:
    'Snapshot capturado de una cuenta distinta a la esperada.\n' +
    'Descartado · no se contamina la calibracion.\n' +
    'Verifica login en Claude Desktop.\n' +
    'EXPECTED_CLAUDE_ACCOUNT no coincide con account_handle.',
};

// Etiquetas para logging (mapean rotationIndex → letra)
const REMINDER_LABELS = ['A', 'B', 'C', 'D'];

// -- Reglas operativas (configurables) ----------------------------------------
const DEFAULT_REMINDER_INTERVAL_MIN = 120;            // 2h, override en config.yaml
const DEBOUNCE_CANNED_MS = 2 * 60 * 1000;             // CA-11
const MIN_BLOCK_DURATION_FOR_RESTORED_MS = 5 * 60 * 1000; // CA-8 (regla UX §5)

// -- Helpers puros ------------------------------------------------------------
function pad2(n) {
  return String(n).padStart(2, '0');
}

/**
 * Formatea un timestamp epoch-ms como `HH:MM` en hora local.
 * Devuelve `--:--` si el input es inválido.
 */
function formatHHMM(resetsAtMs) {
  if (!Number.isFinite(resetsAtMs)) return '--:--';
  const d = new Date(resetsAtMs);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/**
 * Formatea el delta `resetsAt - now` como "X h Y min" (o solo "X h" si
 * `hoursOnly`). Negativos colapsan a 0.
 */
function formatCountdown(resetsAtMs, nowMs, opts) {
  const hoursOnly = !!(opts && opts.hoursOnly);
  if (!Number.isFinite(resetsAtMs) || !Number.isFinite(nowMs)) return '0 min';
  const deltaMs = Math.max(0, resetsAtMs - nowMs);
  const totalMin = Math.round(deltaMs / 60000);
  const hours = Math.floor(totalMin / 60);
  const mins = totalMin % 60;
  if (hoursOnly) return `${hours} h`;
  if (hours <= 0) return `${mins} min`;
  if (mins <= 0) return `${hours} h`;
  return `${hours} h ${mins} min`;
}

/**
 * Reemplaza `{key}` en `template` por `vars[key]`. Llaves desconocidas se
 * dejan intactas (defensa: si por bug se introduce un placeholder no soportado,
 * NO crashea — queda visible en el mensaje y se loguea redactado).
 */
function interpolate(template, vars) {
  return String(template).replace(/\{(\w+)\}/g, (m, key) => {
    return Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : m;
  });
}

/**
 * Construye el set de variables para los templates a partir del flag.
 *   - hhmm: `HH:MM` formateado de `resets_at`.
 *   - countdown: delta hasta el reset.
 *   - n: cantidad de agentes encolados.
 *   - isFallback: true si el flag tiene `resets_at_fallback`.
 */
function buildVars(flagData, nowMs, queuedCount) {
  const resetsAt = Number(flagData && flagData.resets_at);
  const isFallback = !!(flagData && flagData.resets_at_fallback);
  return {
    hhmm: formatHHMM(resetsAt),
    countdown: formatCountdown(resetsAt, nowMs, { hoursOnly: isFallback }),
    n: Number.isFinite(queuedCount) ? queuedCount : 0,
    isFallback,
  };
}

// -- Factory del notifier (lifecycle stateful) --------------------------------
/**
 * Crea un notifier con dependencias inyectables. Diseñado para ser instanciado
 * UNA VEZ en pulpo.js y reusado a lo largo de todo el lifetime del proceso.
 *
 * @param {object} deps
 * @param {(text: string, opts?: {plain?: boolean}) => void} deps.sendMessage
 *        Callback para emitir el mensaje a Telegram. `opts.plain=true` indica
 *        que el caller debe enviar SIN parse_mode Markdown (CA-13).
 * @param {(text: string) => string} [deps.redact]
 *        Función de redacción aplicada a TODOS los mensajes (CA-12). Default
 *        `redactSensitive` de lib/redact.js.
 * @param {() => number} [deps.now]
 *        Inyectable para tests (clock mock). Default `Date.now`.
 * @param {(fn: Function, ms: number) => any} [deps.setIntervalFn]
 *        Inyectable para tests. Default `setInterval` global.
 * @param {(handle: any) => void} [deps.clearIntervalFn]
 *        Inyectable para tests. Default `clearInterval` global.
 * @param {(msg: string) => void} [deps.log]
 *        Logger. Default no-op.
 * @param {() => number} [deps.getReminderIntervalMin]
 *        Resuelve el intervalo de recordatorios (default 120 min, configurable
 *        vía `config.yaml` → `quota_detector.reminder_interval_minutes`).
 * @param {() => number} [deps.getQueuedAgentsCount]
 *        Cantidad de agentes/archivos LLM encolados. Default 0.
 * @param {number} [deps.minBlockDurationForRestoredMs]
 *        Override del umbral anti-falso-positivo (default 5 min).
 * @param {number} [deps.debounceCannedMs]
 *        Override del debounce de canned response (default 2 min).
 */
function createQuotaNotifier(deps) {
  if (!deps || typeof deps.sendMessage !== 'function') {
    throw new Error('createQuotaNotifier: sendMessage es obligatorio');
  }
  const sendMessage = deps.sendMessage;
  const redact = typeof deps.redact === 'function' ? deps.redact : redactSensitive;
  const now = typeof deps.now === 'function' ? deps.now : () => Date.now();
  const setIntervalFn = typeof deps.setIntervalFn === 'function' ? deps.setIntervalFn : setInterval;
  const clearIntervalFn = typeof deps.clearIntervalFn === 'function' ? deps.clearIntervalFn : clearInterval;
  const log = typeof deps.log === 'function' ? deps.log : () => {};
  const getReminderIntervalMin = typeof deps.getReminderIntervalMin === 'function'
    ? deps.getReminderIntervalMin
    : () => DEFAULT_REMINDER_INTERVAL_MIN;
  const getQueuedAgentsCount = typeof deps.getQueuedAgentsCount === 'function'
    ? deps.getQueuedAgentsCount
    : () => 0;
  const minBlockDurationForRestoredMs = Number.isFinite(deps.minBlockDurationForRestoredMs)
    ? deps.minBlockDurationForRestoredMs
    : MIN_BLOCK_DURATION_FOR_RESTORED_MS;
  const debounceCannedMs = Number.isFinite(deps.debounceCannedMs)
    ? deps.debounceCannedMs
    : DEBOUNCE_CANNED_MS;

  const state = {
    flagData: null,
    flagSetAt: 0,
    rotationIndex: 0,        // 0..3 → A..D
    intervalHandle: null,
    // -Infinity como sentinel "nunca se envió canned": el debounce check
    // `t - state.lastCannedAt < debounceCannedMs` da false con cualquier t
    // finito. Inicializar a 0 sería bug si now() arranca en 0 (clock mockeado
    // de tests) — falsy && truthy quedaría como "nunca envío" cuando ya envió.
    lastCannedAt: Number.NEGATIVE_INFINITY,
  };

  function safeRedact(text) {
    try { return redact(text); } catch { return text; }
  }

  function emit(text, opts) {
    sendMessage(safeRedact(text), opts || {});
  }

  function buildText(template, extraVars) {
    const vars = buildVars(state.flagData, now(), getQueuedAgentsCount());
    return interpolate(template, Object.assign(vars, extraVars || {}));
  }

  function sendInitial() {
    if (!state.flagData) return;
    const vars = buildVars(state.flagData, now(), getQueuedAgentsCount());
    const tpl = vars.isFallback ? QUOTA_COPY.initialFallback : QUOTA_COPY.initial;
    emit(interpolate(tpl, vars));
    log('quota-notifier: notificacion inicial enviada');
  }

  function sendReminder() {
    if (!state.flagData) return;
    const idx = state.rotationIndex % QUOTA_COPY.reminders.length;
    const tpl = QUOTA_COPY.reminders[idx];
    emit(buildText(tpl));
    log(`quota-notifier: recordatorio variante ${REMINDER_LABELS[idx]} enviado`);
    state.rotationIndex = (state.rotationIndex + 1) % QUOTA_COPY.reminders.length;
  }

  function startReminders() {
    stopReminders();
    const intervalMin = Math.max(1, getReminderIntervalMin());
    const intervalMs = intervalMin * 60 * 1000;
    state.intervalHandle = setIntervalFn(() => {
      // Defensa: el flag puede haberse borrado entre ticks. Si pasó, el
      // siguiente onFlagCleared limpia. Aquí solo evitamos enviar si el
      // notifier ya no tiene flag activo.
      if (!state.flagData) return;
      try { sendReminder(); }
      catch (e) { log(`quota-notifier reminder error: ${e.message}`); }
    }, intervalMs);
    log(`quota-notifier: setInterval armado cada ${intervalMin} min`);
  }

  function stopReminders() {
    if (state.intervalHandle != null) {
      try { clearIntervalFn(state.intervalHandle); } catch {}
      state.intervalHandle = null;
    }
  }

  /**
   * Llamado por el watcher del flag cuando detecta transición ausente→presente.
   * Idempotente: si el flag ya estaba activo, NO re-envía notificación inicial.
   */
  function onFlagSet(flagData) {
    if (state.flagData) {
      // Ya activo: actualizar metadata pero NO re-disparar inicial.
      state.flagData = flagData || state.flagData;
      return;
    }
    state.flagData = flagData || {};
    state.flagSetAt = now();
    state.rotationIndex = 0;
    state.lastCannedAt = Number.NEGATIVE_INFINITY;
    sendInitial();
    startReminders();
  }

  /**
   * Llamado por el watcher del flag cuando detecta transición presente→ausente.
   * Cancela `setInterval` y emite mensaje de restaurada (excepto si <5 min).
   */
  function onFlagCleared() {
    if (!state.flagData) return; // idempotente: no había flag activo
    const blockDuration = now() - state.flagSetAt;
    stopReminders();
    if (blockDuration >= minBlockDurationForRestoredMs) {
      const queued = getQueuedAgentsCount();
      const tpl = queued >= 1 ? QUOTA_COPY.restored : QUOTA_COPY.restoredEmpty;
      emit(interpolate(tpl, { n: queued }));
      log(`quota-notifier: restaurada enviada (queued=${queued}, duracion=${(blockDuration / 1000).toFixed(1)}s)`);
    } else {
      log(`quota-notifier: bloqueo duro ${(blockDuration / 1000).toFixed(1)}s (<${minBlockDurationForRestoredMs / 1000}s) — omito mensaje de restaurada`);
    }
    state.flagData = null;
    state.flagSetAt = 0;
    state.rotationIndex = 0;
  }

  /**
   * Gate de texto libre del commander (CA-9/CA-10/CA-11). Llamar ANTES de
   * `ejecutarClaude` para mensajes que NO matchearon comando nativo.
   *
   * @returns {{ gated: boolean, debounced: boolean, text: string|null }}
   *   - gated=false: no hay flag activo, el flujo normal de Claude debe continuar.
   *   - gated=true, debounced=false: se envió canned response. Caller debe abortar.
   *   - gated=true, debounced=true: flag activo pero ya respondió hace <2 min.
   *     Caller debe abortar SIN enviar otra canned (anti spam-self).
   */
  function handleCommanderFreeText() {
    if (!state.flagData) {
      return { gated: false, debounced: false, text: null };
    }
    const t = now();
    if (t - state.lastCannedAt < debounceCannedMs) {
      log('quota-notifier: debounce de canned response (anti spam-self)');
      return { gated: true, debounced: true, text: null };
    }
    const text = buildText(QUOTA_COPY.cannedFreeText);
    const safe = safeRedact(text);
    sendMessage(safe, { plain: true }); // CA-13: texto plano, sin Markdown
    state.lastCannedAt = t;
    return { gated: true, debounced: false, text: safe };
  }

  /**
   * Snapshot read-only del estado interno. Útil para `/status`, debugging y
   * tests que verifican el lifecycle.
   */
  function getState() {
    return {
      active: !!state.flagData,
      flagSetAt: state.flagSetAt,
      rotationIndex: state.rotationIndex,
      hasInterval: state.intervalHandle != null,
      lastCannedAt: state.lastCannedAt,
    };
  }

  /** Cleanup hard — llamar en SIGINT/SIGTERM del proceso. */
  function dispose() {
    stopReminders();
    state.flagData = null;
    state.flagSetAt = 0;
    state.rotationIndex = 0;
    state.lastCannedAt = Number.NEGATIVE_INFINITY;
  }

  return {
    onFlagSet,
    onFlagCleared,
    handleCommanderFreeText,
    getState,
    dispose,
  };
}

module.exports = {
  createQuotaNotifier,
  QUOTA_COPY,
  REMINDER_LABELS,
  DEFAULT_REMINDER_INTERVAL_MIN,
  DEBOUNCE_CANNED_MS,
  MIN_BLOCK_DURATION_FOR_RESTORED_MS,
  formatHHMM,
  formatCountdown,
  interpolate,
  buildVars,
};
