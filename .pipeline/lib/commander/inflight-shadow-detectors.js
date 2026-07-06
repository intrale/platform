// =============================================================================
// commander/inflight-shadow-detectors.js — Detectores in-stream del Commander
// en modo SHADOW (#3577, parte 1/2 del split de #3472).
//
// PROPÓSITO
// ---------
// Esta historia entrega 4 detectores observacionales en `pulpo.js#ejecutarClaude`
// que emiten al audit log un evento `inflight_signal_observed` cada vez que
// se dispararía un fallback in-flight si el wire-up real (parte 2 — #3578)
// estuviera activo:
//
//   1. `timeout_first_byte`         (CA-A1) — 15s sin recibir el primer line.
//   2. `timeout_no_new_bytes_30s`   (CA-A2) — 30s sin nuevos lines (R-1 / SR-S5
//      guard: pausado si hay Skill /doc /planner in-flight).
//   3. `eof_premature`              (CA-A3) — proceso sale con code!=0 sin
//      result event ni texto. R-3 guard: no fire si finalResult ya seteado.
//   4. `transient_5xx`              (CA-A4) — error transitorio detectado por
//      shape (SR-S4). R-7 guard: excluye cli_1m_context_glitch.
//
// CONTRATO (modo shadow estricto — CA-S7)
// ---------------------------------------
//   - NO se llama `decideInflightFallback`.
//   - NO se mata el primario (`killProc` intocado).
//   - NO se spawnea secundario.
//   - NO se toca `pendingSkillCalls` (CA-A6) ni `_inflightLocks` (SR-S7).
//   - SI se emite `inflight_signal_observed` vía `audit-log.appendChained`
//     (SR-S1 — preserva hash-chain SHA-256).
//
// El módulo es PURO en términos del flow del usuario: observacional.
// =============================================================================
'use strict';

const path = require('node:path');
const crypto = require('node:crypto');

// -----------------------------------------------------------------------------
// hashFor — SHA-256 truncado a 12 hex. Mismo helper que `inflight-fallback.js`.
// -----------------------------------------------------------------------------
function hashFor(s) {
    return crypto.createHash('sha256').update(String(s || ''), 'utf8').digest('hex').slice(0, 12);
}

// -----------------------------------------------------------------------------
// SR-S2 / CA-S2 — Allowlist de campos permitidos en el payload del evento.
// PROHIBIDO incluir: prompt, partial_output, lastText, stderr_dump, text, content,
// headers, stack_trace.
// -----------------------------------------------------------------------------
const ALLOWED_FIELDS = Object.freeze([
    'event',
    'error_class',
    'chat_id_hash',
    'request_id',
    'primary_provider',
    'provider_effective',
    'signal_detected_at',
    'primary_duration_ms',
    'mode',
    'partial_output_hash', // opcional
]);

const ERROR_CLASSES = Object.freeze([
    'timeout_first_byte',
    // #4530 — el sufijo `_30s` es HISTÓRICO. El umbral por defecto ahora es
    // 180s (ver STREAM_GAP_THRESHOLD_MS). El label se mantiene estable para no
    // romper el análisis de logs/dashboards existentes que filtran por este
    // string; el valor real del gap viaja en `primary_duration_ms`. No renombrar
    // sin migración del histórico de `commander-dispatch-*.jsonl`.
    'timeout_no_new_bytes_30s',
    'eof_premature',
    'transient_5xx',
]);

// -----------------------------------------------------------------------------
// auditFile — mismo path que `inflight-fallback.js` y `multi-provider.js`.
// Una sola cadena hash-chain por día para todo el Commander.
// -----------------------------------------------------------------------------
function auditFile(pipelineDir, now) {
    const d = now ? new Date(now) : new Date();
    const yyyy = d.getUTCFullYear();
    const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(d.getUTCDate()).padStart(2, '0');
    return path.join(pipelineDir || '.', 'logs', `commander-dispatch-${yyyy}-${mm}-${dd}.jsonl`);
}

// -----------------------------------------------------------------------------
// buildInflightSignalEntry — construye el payload del evento `inflight_signal_observed`
// respetando la allowlist (SR-S2). El llamador NO puede injectar campos
// arbitrarios; solo los slots definidos en ALLOWED_FIELDS pasan.
// -----------------------------------------------------------------------------
function buildInflightSignalEntry(opts = {}) {
    const {
        errorClass,
        chatId,
        requestId,
        primaryProvider,
        providerEffective,
        startTime,
        now,
        partialOutput,
    } = opts;

    if (!ERROR_CLASSES.includes(errorClass)) {
        throw new Error(`invalid error_class: ${errorClass}`);
    }
    if (!requestId) {
        throw new Error('request_id requerido (CA-S6 cross-event correlation)');
    }

    const _now = Number.isFinite(now) ? now : Date.now();
    const _start = Number.isFinite(startTime) ? startTime : _now;

    const entry = {
        event: 'inflight_signal_observed',
        error_class: errorClass,
        chat_id_hash: hashFor(chatId || 'unknown'),
        request_id: String(requestId),
        primary_provider: primaryProvider || null,
        provider_effective: providerEffective || primaryProvider || null,
        signal_detected_at: _now,
        primary_duration_ms: Math.max(0, _now - _start),
        mode: 'shadow',
    };

    // Opcional: hash del output parcial (NUNCA contenido). Solo si hay parcial.
    if (partialOutput && String(partialOutput).length > 0) {
        entry.partial_output_hash = hashFor(partialOutput);
    }

    return entry;
}

// -----------------------------------------------------------------------------
// emitInflightSignal — escribe el evento al audit log vía `appendChained`
// (SR-S1 — hash-chain SHA-256 con file-lock cross-process). NO usa
// `fs.appendFileSync` directo.
//
// El caller arma el entry con `buildInflightSignalEntry` y nos lo pasa para
// que solo escribamos. Devuelve true si el write OK, false en error
// (fail-closed para no afectar el flow del usuario).
// -----------------------------------------------------------------------------
function emitInflightSignal(opts = {}) {
    const { pipelineDir, entry, auditLog, fsImpl, now } = opts;
    if (!pipelineDir || !entry) return false;
    try {
        const _audit = auditLog || require('../audit-log');
        const file = auditFile(pipelineDir, now);
        _audit.appendChained({ file, entry, fsImpl });
        return true;
    } catch { return false; }
}

// -----------------------------------------------------------------------------
// CA-A4 / SR-S4 / R-7 — detectTransient5xx
//
// Match estructurado por shape del JSON parseado del stream. NUNCA por
// substring sobre texto libre (anti prompt-injection).
//
// Cubre los shapes habituales:
//   - Claude Code SDK `result` event: `{type:'result', is_error:true, ...}` + error type derivado.
//   - Anthropic SDK error: `{is_error:true, error:{type:'overloaded_error', ...}}`.
//   - Mensaje wrappeado: `{is_error:true, message:{error:{type:'...'}}}`.
//
// Excluye explícitamente `cli_1m_context_glitch` (R-7) usando el detector
// inyectable `cliGlitchDetector(evt)`. Si el caller no lo pasa, no se
// excluye nada (modo test mínimo).
// -----------------------------------------------------------------------------
const TRANSIENT_5XX_ERROR_TYPES = Object.freeze(new Set([
    'overloaded_error',
    'api_error',
    'internal_server_error',
    'service_unavailable_error',
    'service_unavailable',
    'bad_gateway',
    'gateway_timeout',
    'timeout_error',
]));

function detectTransient5xx(evt, options = {}) {
    if (!evt || typeof evt !== 'object') return false;
    if (evt.is_error !== true) return false;

    // R-7 guard: excluir cli_1m_context_glitch ANTES de evaluar el shape.
    const { cliGlitchDetector } = options;
    if (typeof cliGlitchDetector === 'function') {
        try {
            if (cliGlitchDetector(evt) === true) return false;
        } catch { /* defensivo: si el detector lanza, no excluímos */ }
    }

    const errType = (evt.error && typeof evt.error === 'object' && evt.error.type)
        || (evt.message && evt.message.error && evt.message.error.type)
        || null;

    if (!errType) return false;
    return TRANSIENT_5XX_ERROR_TYPES.has(String(errType));
}

// -----------------------------------------------------------------------------
// CA-A2 / SR-S5 / R-1 — shouldFireStreamGap
//
// Dispara solo si:
//   - Ya se recibió el primer line (`lastLineAt > 0`).
//   - Pasaron >= thresholdMs desde el último line (default 180s — #4530).
//   - NO hay Skill in-flight (R-1 / SR-S5 — pausar si `pendingSkillCallsSize > 0`).
//   - NO hay NINGÚN tool_use in-flight (#4530 CA-2 — pausar si `pendingToolUseSize > 0`).
//   - No se disparó antes en este turn (`alreadyFired === false`).
//
// #4530 — El umbral pasó de 30s a 180s. El 30s original confundía turnos
// legítimos con tool-use largo (ej. Bash/gradlew de 120-300s) con un cuelgue:
// entre el `tool_use` y su `tool_result` no llega ningún line nuevo, así que el
// gap de 30s disparaba fallback innecesario y sacaba a Anthropic teniendo cuota.
// Dos defensas complementarias:
//   1. Umbral base 180s (cubre la mayoría de la evidencia: 118s-186s).
//   2. Guard `pendingToolUseSize` (cubre también los 237s/300s): si hay CUALQUIER
//      herramienta ejecutándose, el silencio de texto es esperado → no disparar.
// -----------------------------------------------------------------------------
const STREAM_GAP_THRESHOLD_MS = 180 * 1000; // #4530 — antes 30s
const STREAM_GAP_MIN_MS = 180 * 1000;       // #4530 — piso fail-closed (no aflojar por debajo)
const STREAM_GAP_MAX_MS = 600 * 1000;       // #4530 — techo sano (= HARD_TIMEOUT 10min)

// #4530 — Umbral del early-cascade NON-Anthropic (#3571). Se mantiene en 30s a
// propósito: es otra feature (cascada temprana de providers de fallback frente
// al kill duro de 600s) con su propia semántica y test. El bump a 180s aplica
// SOLO al shadow detector del turno Anthropic del commander; el path
// non-Anthropic conserva su agresividad histórica. `nonanthropic-stall-detect.js`
// usa esta constante como default en vez de STREAM_GAP_THRESHOLD_MS.
const NONANTH_STREAM_GAP_THRESHOLD_MS = 30 * 1000;

// -----------------------------------------------------------------------------
// #4530 CA-3 — resolveStreamGapThresholdMs
//
// Resuelve el umbral efectivo desde el env `COMMANDER_STREAM_GAP_MS`, con
// semántica fail-closed y clamp:
//   - Valor ausente/no numérico → default 180s (fail-closed: nunca más agresivo).
//   - Valor < 180s → clampeado a 180s (no se permite reintroducir el gap agresivo).
//   - Valor > 600s → clampeado a 600s (techo = HARD_TIMEOUT, evita gap inútil).
// El env se lee inyectado (`rawEnv`) para que sea testeable sin tocar process.env.
// -----------------------------------------------------------------------------
function resolveStreamGapThresholdMs(rawEnv) {
    const n = Number(rawEnv);
    if (!Number.isFinite(n)) return STREAM_GAP_THRESHOLD_MS;
    return Math.min(STREAM_GAP_MAX_MS, Math.max(STREAM_GAP_MIN_MS, n));
}

function shouldFireStreamGap(opts = {}) {
    const {
        lastLineAt, now, pendingSkillCallsSize, pendingToolUseSize,
        alreadyFired, thresholdMs,
    } = opts;
    if (alreadyFired) return false;
    if (!Number.isFinite(lastLineAt) || lastLineAt <= 0) return false;
    const _now = Number.isFinite(now) ? now : Date.now();
    const _threshold = Number.isFinite(thresholdMs) ? thresholdMs : STREAM_GAP_THRESHOLD_MS;
    if ((_now - lastLineAt) < _threshold) return false;
    // R-1 / SR-S5: pausar si hay Skill in-flight (el SKILL_WATCHDOG_MS=60s
    // cubre el caso con semántica propia).
    if (Number.isFinite(pendingSkillCallsSize) && pendingSkillCallsSize > 0) return false;
    // #4530 CA-2: pausar si hay CUALQUIER tool_use in-flight. Entre el `tool_use`
    // y su `tool_result` no llegan lines; una herramienta larga (Bash/gradlew)
    // es actividad legítima, no un cuelgue. Generaliza el guard de Skills a
    // cualquier herramienta pendiente.
    if (Number.isFinite(pendingToolUseSize) && pendingToolUseSize > 0) return false;
    return true;
}

// -----------------------------------------------------------------------------
// CA-A1 — shouldFireFirstByte
//
// Dispara solo si:
//   - Aún NO se recibió ningún line (`lastLineAt === 0`).
//   - Pasaron >= 15000ms desde el `startTime`.
//   - No se disparó antes (`alreadyFired === false`).
// -----------------------------------------------------------------------------
const FIRST_BYTE_THRESHOLD_MS = 15 * 1000;

function shouldFireFirstByte(opts = {}) {
    const { startTime, now, lastLineAt, alreadyFired, thresholdMs } = opts;
    if (alreadyFired) return false;
    if (Number.isFinite(lastLineAt) && lastLineAt > 0) return false;
    if (!Number.isFinite(startTime)) return false;
    const _now = Number.isFinite(now) ? now : Date.now();
    const _threshold = Number.isFinite(thresholdMs) ? thresholdMs : FIRST_BYTE_THRESHOLD_MS;
    return (_now - startTime) >= _threshold;
}

// -----------------------------------------------------------------------------
// CA-A3 / R-3 — shouldFireEofPremature
//
// Dispara solo si:
//   - El proceso salió con `code !== 0 && code !== null` o code estrictamente
//     distinto de cero.
//   - NO se recibió un `result` event válido (`!finalResult`).
//   - NO hay texto del asistente (`!lastText`).
//   - R-3 guard: si `finalResult` está seteado, el `code != 0` puede ser por
//     el workaround claude-code#25629 (setTimeout 3s → killProc → finish('result+kill')).
//     En ese caso el result ya llegó OK, no es eof prematuro.
// -----------------------------------------------------------------------------
function shouldFireEofPremature(opts = {}) {
    const { code, finalResult, lastText, alreadyFired } = opts;
    if (alreadyFired) return false;
    // R-3 — si hay finalResult, el result ya llegó; no es eof prematuro
    // aunque el code resulte != 0.
    if (finalResult) return false;
    if (lastText && String(lastText).length > 0) return false;
    // code === 0 → exit limpio sin output (no es eof prematuro per se,
    // pero tampoco aporta señal in-flight). Sólo nos interesan exits con error.
    if (code === 0) return false;
    // null code = killed por signal; cuenta como salida anormal sin result.
    // numeric code > 0 = error de proceso. Ambos son eof prematuro si no
    // hubo result/text.
    return true;
}

module.exports = {
    // Constantes
    ALLOWED_FIELDS,
    ERROR_CLASSES,
    TRANSIENT_5XX_ERROR_TYPES,
    FIRST_BYTE_THRESHOLD_MS,
    STREAM_GAP_THRESHOLD_MS,
    STREAM_GAP_MIN_MS,
    STREAM_GAP_MAX_MS,
    NONANTH_STREAM_GAP_THRESHOLD_MS, // #4530 — early-cascade non-Anthropic (#3571)

    // Core
    buildInflightSignalEntry,
    emitInflightSignal,

    // Detectores
    detectTransient5xx,
    shouldFireFirstByte,
    shouldFireStreamGap,
    shouldFireEofPremature,
    resolveStreamGapThresholdMs, // #4530 CA-3

    // Helpers
    auditFile,
    _hashFor: hashFor,
};
