// =============================================================================
// audio-policy.js — Política de audio TTS por tipo de evento (issue #4586)
//
// Principio: **audio para lo que necesita atención/acción del operador; texto
// para el firehose informativo.**
//
// Antes del #4586 el audio TTS estaba gobernado por un flag "global" dentro de
// `deliverable_notifications.audio_enabled`: si estaba en `true`, TODA
// notificación de entregable de agente (guru, po, ux, tester, dev, build…)
// generaba audio y lo mezclaba con la conversación del operador con el
// Commander. Este módulo reemplaza ese flag binario por una **política por tipo
// de evento** declarada en config (`audio_policy`).
//
// Tipos de evento (EVENT):
//   - commander_reply   → respuestas del Commander al operador (conversación).
//   - rejection_report  → reportes de rechazo (audio ya obligatorio).
//   - status            → `/status` y snapshots ejecutivos (audio obligatorio).
//   - gate_signature    → pedidos de firma de gates (épico #4570, futuro).
//   - agent_deliverable → notificación de entregable de agente (FIREHOSE).
//   - cua_stage         → stages intermedios de comandos CUA.
//
// Default (`DEFAULT_BY_EVENT`): audio ON para lo que requiere atención del
// operador, OFF para el firehose de agentes.
//
// El módulo es **puro**: sin side effects, sin filesystem, sin red. Fácil de
// testear con `node --test`.
// =============================================================================
'use strict';

/**
 * Tipos de evento reconocidos por la política. Se exponen como constantes para
 * que los callers no hardcodeen strings (typos → silencioso `default`).
 */
const EVENT = Object.freeze({
    COMMANDER_REPLY:   'commander_reply',
    REJECTION_REPORT:  'rejection_report',
    STATUS:            'status',
    GATE_SIGNATURE:    'gate_signature',
    AGENT_DELIVERABLE: 'agent_deliverable',
    CUA_STAGE:         'cua_stage',
});

/**
 * Default por tipo de evento. Es la fuente de verdad si el config no declara
 * `by_event[<evento>]`. Refleja el principio del issue #4586:
 *   - Atención/acción del operador → 🔊 audio.
 *   - Firehose informativo de agentes → 🔇 solo texto.
 */
const DEFAULT_BY_EVENT = Object.freeze({
    commander_reply:   true,
    rejection_report:  true,
    status:            true,
    gate_signature:    true,
    agent_deliverable: false,
    cua_stage:         false,
});

/**
 * Devuelve el default para un tipo de evento. Eventos desconocidos caen a
 * `false` (conservador: ante la duda, no generamos audio y no saturamos el
 * canal del operador).
 *
 * @param {string} eventType
 * @returns {boolean}
 */
function defaultForEvent(eventType) {
    const evt = String(eventType || '');
    return Object.prototype.hasOwnProperty.call(DEFAULT_BY_EVENT, evt)
        ? DEFAULT_BY_EVENT[evt]
        : false;
}

/**
 * Decide si un evento de un tipo dado debe emitir audio TTS.
 *
 * Semántica (en orden de precedencia):
 *   1. `policy.kill_switch === true`  → corta TODO el audio (sin reiniciar).
 *   2. `policy.enabled === false`     → política apagada → sin audio.
 *   3. `policy.by_event[eventType]`   → si está declarado, gana (=== true).
 *   4. Default por evento (`DEFAULT_BY_EVENT`).
 *
 * Si `policy` no es un objeto (undefined/null), cae directo al default por
 * evento. Esto permite back-compat: un caller que no pasa política obtiene el
 * comportamiento por defecto del tipo de evento.
 *
 * NUNCA tira excepción.
 *
 * @param {object|null|undefined} policy - bloque `audio_policy` de config.
 * @param {string} eventType - uno de EVENT.* (o string arbitrario → default).
 * @returns {boolean}
 */
function shouldEmitAudio(policy, eventType) {
    const def = defaultForEvent(eventType);
    if (!policy || typeof policy !== 'object') return def;

    // Kill switch global de audio: corta todo sin importar el evento.
    if (policy.kill_switch === true) return false;
    // Política explícitamente apagada.
    if (policy.enabled === false) return false;

    const byEvent = (policy.by_event && typeof policy.by_event === 'object')
        ? policy.by_event
        : null;
    if (byEvent && Object.prototype.hasOwnProperty.call(byEvent, String(eventType))) {
        return byEvent[String(eventType)] === true;
    }
    return def;
}

module.exports = {
    EVENT,
    DEFAULT_BY_EVENT,
    defaultForEvent,
    shouldEmitAudio,
};
