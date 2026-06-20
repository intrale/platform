// =============================================================================
// sherlock-optimistic.js — Modelo optimista de Sherlock (#4105 · EP2-H5b)
// =============================================================================
//
// Cambia el modelo temporal de Sherlock de **bloqueante → optimista**:
//
//   - Bloqueante (legacy): el Commander espera a que Sherlock verifique antes de
//     responder. Espera percibida alta (soft-timeout 420 s).
//   - Optimista (este módulo): al agotarse el presupuesto de verificación, se
//     libera la respuesta con un disclaimer "pendiente" (⏳) y la verificación
//     sigue en **background**. Si el veredicto difiere, se corrige el mensaje ya
//     enviado: **texto → editMessageText**, **voz → follow-up** (un voice note no
//     es editable).
//
// Este módulo es el **corazón unit-testeable** del feature (`pulpo.js` orquesta
// pero no es unit-testeable). Concentra TODA la lógica de seguridad fail-closed:
//
//   CA-3  Techo de espera percibida ≤ 90 s → acota el hard-timeout del registry.
//   CA-5  Corrección diferenciada: texto ⇒ edit, voz ⇒ follow-up.
//   CA-6  Captura async del message_id + idempotencia (dedupe atómico).
//   CA-7  Fail-closed: SOLO `approved` explícito remueve el disclaimer.
//   CA-8  Fallback obligatorio: si la edición no es posible/falla → follow-up.
//   CA-10 Cap de concurrencia de tareas background (sin TOCTOU) + hard-timeout.
//   CA-12 Audit sin contenido crudo (SHA-256 truncado).
//
// Reglas inquebrantables (espejo de telegram-receipt.js / sherlock-verifier.js):
//   R1. **Módulo puro:** sin side-effects al requerir, sin red, sin credenciales.
//       Todo testeable con `node --test`. El reloj (`now`) es inyectable.
//   R2. **Fail-closed:** ante input dudoso (verdict desconocido, canal inválido)
//       NUNCA se remueve el disclaimer ni se asume edición segura.
//   R3. **Atómico:** el chequeo de cap y el dedupe corren de forma síncrona (sin
//       `await` intermedio) → el event-loop de Node garantiza atomicidad. Ningún
//       camino abre una ventana TOCTOU que permita superar el cap bajo ráfaga.
//
// =============================================================================
'use strict';

const crypto = require('crypto');

// -----------------------------------------------------------------------------
// Constantes de canal / veredicto / corrección
// -----------------------------------------------------------------------------
const CHANNEL_TEXT = 'text';
const CHANNEL_VOICE = 'voice';
const VALID_CHANNELS = [CHANNEL_TEXT, CHANNEL_VOICE];

// CA-7 — único veredicto que habilita remover el disclaimer ⏳.
const VERDICT_APPROVED = 'approved';
// rejected / error / timeout (y cualquier otro) DEJAN el ⏳ (fail-closed).

// CA-5 — acciones de corrección.
const CORRECTION_EDIT = 'editMessageText';
const CORRECTION_FOLLOWUP = 'followup';

// CA-3 / CA-10 — techo duro de espera percibida. El hard-timeout del registry
// NUNCA puede superar este valor: acota la limpieza de tareas background.
const HARD_TIMEOUT_CEILING_MS = 90_000;
const DEFAULT_CAP = 16;

// CA-12 — nombres canónicos de los eventos de audit del camino optimista.
const AUDIT_OPTIMISTIC_SEND = 'sherlock_optimistic_send';
const AUDIT_BACKGROUND_VERDICT = 'sherlock_background_verdict';
const AUDIT_EDIT_RESULT = 'sherlock_edit_result';

// -----------------------------------------------------------------------------
// hashFor — SHA-256 truncado a 16 hex (CA-12 / CA-SEC-8). Mismo formato que
// sherlock-verifier.hashFor: el audit NUNCA persiste contenido crudo ni PII.
// -----------------------------------------------------------------------------
function hashFor(s) {
  return crypto.createHash('sha256')
    .update(String(s == null ? '' : s), 'utf8')
    .digest('hex').slice(0, 16);
}

// -----------------------------------------------------------------------------
// shouldRemoveDisclaimer — CA-7 fail-closed. SOLO un `approved` explícito (string
// exacto) habilita remover el ⏳. `rejected`, `error`, `timeout`, `null`,
// `undefined` o cualquier otra cosa lo DEJAN.
// -----------------------------------------------------------------------------
function shouldRemoveDisclaimer(verdict) {
  return verdict === VERDICT_APPROVED;
}

// -----------------------------------------------------------------------------
// decideCorrection — CA-5 + CA-8. Decide cómo corregir un mensaje ya enviado:
//   - canal de texto con edición disponible → `editMessageText`.
//   - canal de voz → SIEMPRE follow-up (el voice note es inmutable; la señal de
//     "pendiente" viaja por el texto acompañante, pero la corrección es texto
//     nuevo).
//   - canal de texto SIN edición disponible (message_id no resuelto, edición
//     previa falló) → fallback obligatorio a follow-up (CA-8).
//   - canal desconocido → fail-safe a follow-up (nunca se pierde la corrección).
// -----------------------------------------------------------------------------
function decideCorrection({ channel, editAvailable } = {}) {
  if (channel === CHANNEL_VOICE) return CORRECTION_FOLLOWUP;
  if (channel === CHANNEL_TEXT) {
    return editAvailable ? CORRECTION_EDIT : CORRECTION_FOLLOWUP;
  }
  return CORRECTION_FOLLOWUP;
}

// -----------------------------------------------------------------------------
// normalizeChannel — mapea `esAudio` (boolean del pulpo) o un string al canal
// canónico. Defensivo: cualquier valor no-voz cae a texto.
// -----------------------------------------------------------------------------
function normalizeChannel(input) {
  if (input === true || input === CHANNEL_VOICE || input === 'voz') return CHANNEL_VOICE;
  return CHANNEL_TEXT;
}

// -----------------------------------------------------------------------------
// createBackgroundRegistry — registro de tareas de verificación background con
// cap de concurrencia atómico (CA-10) + hard-timeout ≤90 s (CA-3).
//
// @param {object} opts
// @param {number} opts.cap            Máximo de tareas `pending` simultáneas.
// @param {number} opts.hardTimeoutMs  Timeout duro de limpieza (clamp ≤90 s).
// @param {() => number} [opts.now]    Reloj inyectable (default Date.now).
//
// El registro NO usa timers reales: expone `reap(nowMs)` para que el caller
// (pulpo.js, vía su loop) limpie zombis de forma determinística. Así es 100%
// testeable y no deja `setTimeout` colgados que mantengan vivo el proceso.
// -----------------------------------------------------------------------------
function createBackgroundRegistry({ cap, hardTimeoutMs, now } = {}) {
  const _cap = Number.isInteger(cap) && cap > 0 ? cap : DEFAULT_CAP;
  // CA-3 — clamp del hard-timeout al techo de 90 s. Un caller no puede pedir un
  // timeout más largo que la espera percibida máxima.
  const _hardTimeoutMs = Math.min(
    HARD_TIMEOUT_CEILING_MS,
    Number.isFinite(hardTimeoutMs) && hardTimeoutMs > 0 ? hardTimeoutMs : HARD_TIMEOUT_CEILING_MS,
  );
  const _now = typeof now === 'function' ? now : () => Date.now();

  // Map `verificationId` → task. Una sola estructura: el dedupe por
  // `verificationId` es la clave (CA-6).
  const tasks = new Map();
  // Set de claves de corrección ya encoladas: `verificationId|correlationId`
  // (CA-6, idempotencia: nunca doble edición).
  const enqueuedCorrections = new Set();

  function pendingCount() {
    let n = 0;
    for (const t of tasks.values()) if (t.status === 'pending') n++;
    return n;
  }

  // ---------------------------------------------------------------------------
  // register — registra una tarea de verificación background. Chequeo de cap +
  // dedupe SÍNCRONO (R3, sin TOCTOU). Devuelve un descriptor del resultado:
  //   { accepted:true }                         → se aceptó, ⏳ enviado, bg corre
  //   { accepted:false, reason:'duplicate' }    → ya existía (idempotente)
  //   { accepted:false, reason:'cap_exceeded' } → cap lleno → degradar (CA-10)
  //   { accepted:false, reason:'invalid' }      → verificationId inválido
  // ---------------------------------------------------------------------------
  function register({ verificationId, correlationId, channel } = {}) {
    if (typeof verificationId !== 'string' || verificationId.length === 0) {
      return { accepted: false, reason: 'invalid' };
    }
    if (tasks.has(verificationId)) {
      return { accepted: false, reason: 'duplicate' };
    }
    if (pendingCount() >= _cap) {
      // CA-10 — degradar, NUNCA spawnear ilimitado. El caller deja el ⏳ puesto.
      return { accepted: false, reason: 'cap_exceeded' };
    }
    tasks.set(verificationId, {
      verificationId,
      correlationId: correlationId || null,
      channel: normalizeChannel(channel),
      status: 'pending',
      verdict: null,
      messageId: null,
      startedAt: _now(),
    });
    return { accepted: true };
  }

  // ---------------------------------------------------------------------------
  // attachMessageId — CA-6. El `message_id` llega async por recibo; lo ligamos a
  // la tarea cuando se resuelve. Idempotente: una segunda llegada (recibo
  // duplicado / fuera de orden) NO pisa un message_id ya fijado.
  // ---------------------------------------------------------------------------
  function attachMessageId({ verificationId, messageId } = {}) {
    const t = tasks.get(verificationId);
    if (!t) return { ok: false, reason: 'unknown' };
    if (!Number.isFinite(messageId)) return { ok: false, reason: 'invalid' };
    if (t.messageId != null) return { ok: false, reason: 'already_set' }; // idempotente
    t.messageId = messageId;
    return { ok: true };
  }

  // ---------------------------------------------------------------------------
  // resolveVerdict — CA-7 fail-closed. Resuelve la tarea con el veredicto del
  // background. Devuelve si corresponde remover el disclaimer.
  //   removeDisclaimer === true  → SOLO si verdict === 'approved'.
  //   needsCorrection  === true  → si el veredicto NO aprueba (hay que corregir).
  // Idempotente: una tarea ya resuelta no se re-resuelve.
  // ---------------------------------------------------------------------------
  function resolveVerdict({ verificationId, verdict } = {}) {
    const t = tasks.get(verificationId);
    if (!t) return { ok: false, reason: 'unknown', removeDisclaimer: false, needsCorrection: false };
    if (t.status !== 'pending') {
      return { ok: false, reason: 'already_resolved', removeDisclaimer: false, needsCorrection: false };
    }
    t.status = 'resolved';
    t.verdict = verdict == null ? null : String(verdict);
    const removeDisclaimer = shouldRemoveDisclaimer(verdict);
    return {
      ok: true,
      removeDisclaimer,
      // Si aprueba → no hay corrección de contenido (solo retirar ⏳).
      // Si NO aprueba (rejected/error/timeout) → el ⏳ queda y se corrige.
      needsCorrection: !removeDisclaimer,
      channel: t.channel,
    };
  }

  // ---------------------------------------------------------------------------
  // enqueueCorrection — CA-6 + CA-5 + CA-8. Encola UNA corrección (edición o
  // follow-up) de forma idempotente: dedupe atómico por
  // `verificationId|correlationId`. Una segunda llegada (recibo duplicado / fuera
  // de orden) NO produce una segunda edición.
  //
  // @returns {
  //   accepted: boolean,            // false si ya estaba encolada (dedup)
  //   reason?: 'duplicate'|'invalid',
  //   action?: 'editMessageText'|'followup',  // decisión de corrección (CA-5/8)
  // }
  // ---------------------------------------------------------------------------
  function enqueueCorrection({ verificationId, correlationId, channel, editAvailable } = {}) {
    if (typeof verificationId !== 'string' || verificationId.length === 0) {
      return { accepted: false, reason: 'invalid' };
    }
    const key = `${verificationId}|${correlationId == null ? '' : correlationId}`;
    if (enqueuedCorrections.has(key)) {
      return { accepted: false, reason: 'duplicate' };
    }
    enqueuedCorrections.add(key);
    const t = tasks.get(verificationId);
    const ch = channel != null ? normalizeChannel(channel) : (t ? t.channel : CHANNEL_TEXT);
    const action = decideCorrection({ channel: ch, editAvailable });
    return { accepted: true, action, channel: ch };
  }

  // ---------------------------------------------------------------------------
  // reap — CA-3 / CA-10. Limpia tareas `pending` cuyo hard-timeout venció. Una
  // tarea reapada se marca `timeout` (NO `resolved`): fail-closed → el ⏳ queda
  // (CA-7). Devuelve la lista de tareas expiradas para que el caller audite.
  // ---------------------------------------------------------------------------
  function reap(nowMs) {
    const ref = Number.isFinite(nowMs) ? nowMs : _now();
    const expired = [];
    for (const t of tasks.values()) {
      if (t.status === 'pending' && (ref - t.startedAt) >= _hardTimeoutMs) {
        t.status = 'timeout';
        expired.push({ verificationId: t.verificationId, channel: t.channel });
      }
    }
    return expired;
  }

  function get(verificationId) {
    const t = tasks.get(verificationId);
    return t ? { ...t } : null;
  }

  return {
    register,
    attachMessageId,
    resolveVerdict,
    enqueueCorrection,
    reap,
    get,
    pendingCount,
    get size() { return tasks.size; },
    cap: _cap,
    hardTimeoutMs: _hardTimeoutMs,
  };
}

// -----------------------------------------------------------------------------
// buildAuditPayload — CA-12. Arma el payload de un evento de audit del camino
// optimista, hasheando cualquier campo derivable de contenido. NUNCA incluye el
// texto del mensaje, el message_id crudo asociable a contenido, ni PII.
// El caller (pulpo.js) lo pasa a commanderMP.auditCommanderRequest (best-effort).
// -----------------------------------------------------------------------------
function buildAuditPayload({ event, channel, verificationId, verdict, editOutcome } = {}) {
  const payload = { event };
  if (channel != null) payload.channel = normalizeChannel(channel);
  // El verificationId se hashea: aunque es un id interno, evitamos correlación
  // cruzada con contenido (CA-12 / CA-SEC-8).
  if (verificationId != null) payload.verificationHash = hashFor(verificationId);
  if (verdict != null) payload.verdict = String(verdict);
  if (editOutcome != null) payload.editOutcome = String(editOutcome); // success|fail|fallback
  return payload;
}

module.exports = {
  // API principal
  createBackgroundRegistry,
  decideCorrection,
  shouldRemoveDisclaimer,
  normalizeChannel,
  buildAuditPayload,
  // helpers
  hashFor,
  // constantes
  CHANNEL_TEXT,
  CHANNEL_VOICE,
  VALID_CHANNELS,
  VERDICT_APPROVED,
  CORRECTION_EDIT,
  CORRECTION_FOLLOWUP,
  HARD_TIMEOUT_CEILING_MS,
  DEFAULT_CAP,
  AUDIT_OPTIMISTIC_SEND,
  AUDIT_BACKGROUND_VERDICT,
  AUDIT_EDIT_RESULT,
};
