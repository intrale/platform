'use strict';

// =============================================================================
// nonanthropic-stall-detect.js — Detección in-stream temprana (first-byte 15s /
// stream-gap 30s) para la rama non-Anthropic de `runNonAnthropic` (pulpo.js).
//
// Contexto (#3571):
//   La rama Anthropic de `ejecutarClaude` ya cascadea temprano ante un provider
//   que se cuelga (first-byte 15s / stream-gap 30s, `pulpo.js` ~10781-10813).
//   La rama non-Anthropic sólo tenía el kill duro `HARD_NON_ANTH_MS`
//   (= `TURN_BUDGET_MS` = 600s): si el fallback emitía parcial y stalleaba, o
//   nunca emitía first-byte, el usuario esperaba hasta 10 min antes de cascadear.
//
//   Este helper encapsula SÓLO el ciclo de vida de los dos timers de detección
//   + el guard `settled` (idempotencia frente a `close`/`error`). Reusa las
//   primitivas ya validadas en producción de `inflight-shadow-detectors.js`
//   (`shouldFireFirstByte`, `shouldFireStreamGap`, thresholds), sin definir
//   constantes nuevas (CA-4).
//
// DECISIÓN DE ARQUITECTURA (arquitecto + security SEC-1):
//   Este módulo NO es el `lib/commander/inflight-wire.js` que el issue descartó
//   explícitamente. NO spawnea procesos, NO resuelve providers y NO toca el gate
//   de data-residency (`drCheck2`). El `spawn` + `enforceDataResidency` por
//   candidato quedan INLINE en `runNonAnthropic` (pulpo.js), aguas arriba de este
//   helper. Acá sólo vive lógica de temporizadores pura y testeable — el caller
//   provee los callbacks de cascada (`onFirstByte`/`onStreamGap`), que apuntan a
//   `advanceOrGiveUp`, cuya re-resolución de cadena vuelve a pasar por `drCheck2`.
//
// SEC-2: el provider del siguiente intento NUNCA sale del stdout — lo resuelve
//   `advanceOrGiveUp` (caller). Este módulo no lee stdout/stderr.
// SEC-3: este módulo no loguea contenido crudo; el caller referencia sólo
//   `res.provider` + thresholds en sus `log('commander', ...)`.
// SEC-4: `cleanup()` limpia AMBOS timers en todos los caminos (first-byte,
//   stream-gap, close, error) — sin fugas de handles en un proceso de días.
// =============================================================================

const inflightShadow = require('./inflight-shadow-detectors');

// -----------------------------------------------------------------------------
// createStallDetectors — arma los timers de detección temprana para UN intento
// de provider non-Anthropic.
//
// opts:
//   startTime         (number)   — timestamp del spawn (para first-byte).
//   getLastChunkAt    (fn→number)— devuelve el timestamp del último chunk de
//                                   stdout, o 0 si todavía no llegó ninguno
//                                   (semántica `lastLineAt` del shadow detector).
//   killProc          (fn)       — mata el proceso (SIGTERM). Envuelto en try/catch.
//   onFirstByte       (fn)       — cascada por ausencia de first-byte (15s).
//   onStreamGap       (fn)       — cascada por stream-gap (>30s tras un chunk).
//   now               (fn→number)— reloj inyectable (default Date.now).
//   firstByteThresholdMs / streamGapThresholdMs — override de thresholds (default
//                                   los de `inflightShadow`, NO se inventan valores).
//   streamGapPollMs   (number)   — período del interval de stream-gap (default 5000,
//                                   NO busy-wait; espeja la rama Anthropic).
//   timers            (obj)      — inyección de setTimeout/setInterval/clear* para tests.
//
// Devuelve: { cleanup, markSettled, isSettled }.
//   - markSettled(): idempotencia para `close`/`error`. Devuelve `true` si el
//     intento YA estaba settled (p. ej. porque un detector ya cascadeó) → el
//     caller debe cortar (`return`) para no doble-invocar `advanceOrGiveUp` (CA-3).
//   - cleanup(): limpia ambos timers (llamado internamente al disparar y expuesto
//     para el caller en `close`/`error`).
// -----------------------------------------------------------------------------
function createStallDetectors(opts = {}) {
    const {
        startTime,
        getLastChunkAt,
        killProc,
        onFirstByte,
        onStreamGap,
        now,
        firstByteThresholdMs,
        streamGapThresholdMs,
        streamGapPollMs,
        timers,
    } = opts;

    const _now = typeof now === 'function' ? now : () => Date.now();
    const _lastChunkAt = typeof getLastChunkAt === 'function' ? getLastChunkAt : () => 0;
    const _kill = typeof killProc === 'function' ? killProc : () => {};
    const _onFirstByte = typeof onFirstByte === 'function' ? onFirstByte : () => {};
    const _onStreamGap = typeof onStreamGap === 'function' ? onStreamGap : () => {};

    const _fbThreshold = Number.isFinite(firstByteThresholdMs)
        ? firstByteThresholdMs
        : inflightShadow.FIRST_BYTE_THRESHOLD_MS;
    const _sgThreshold = Number.isFinite(streamGapThresholdMs)
        ? streamGapThresholdMs
        : inflightShadow.STREAM_GAP_THRESHOLD_MS;
    const _pollMs = Number.isFinite(streamGapPollMs) ? streamGapPollMs : 5000;

    const _setTimeout = (timers && timers.setTimeout) || setTimeout;
    const _setInterval = (timers && timers.setInterval) || setInterval;
    const _clearTimeout = (timers && timers.clearTimeout) || clearTimeout;
    const _clearInterval = (timers && timers.clearInterval) || clearInterval;

    let settled = false;
    let firstByteFired = false;
    let streamGapFired = false;
    let firstByteTimer = null;
    let streamGapTimer = null;

    const cleanup = () => {
        if (firstByteTimer !== null) { _clearTimeout(firstByteTimer); firstByteTimer = null; }
        if (streamGapTimer !== null) { _clearInterval(streamGapTimer); streamGapTimer = null; }
    };

    // Marca el intento como resuelto (por close/error del caller). Idempotente:
    // devuelve el estado PREVIO para que el caller sepa si un detector ya cascadeó.
    const markSettled = () => {
        const was = settled;
        settled = true;
        cleanup();
        return was;
    };

    firstByteTimer = _setTimeout(() => {
        if (settled) return;
        if (inflightShadow.shouldFireFirstByte({
            startTime,
            now: _now(),
            lastLineAt: _lastChunkAt(),
            alreadyFired: firstByteFired,
            thresholdMs: _fbThreshold,
        })) {
            firstByteFired = true;
            settled = true;
            cleanup();
            try { _kill(); } catch { /* best-effort */ }
            _onFirstByte();
        }
    }, _fbThreshold);

    streamGapTimer = _setInterval(() => {
        if (settled) return;
        if (inflightShadow.shouldFireStreamGap({
            lastLineAt: _lastChunkAt(),
            now: _now(),
            // El subproceso fallback non-Anthropic no ejecuta Skills → nunca hay
            // Skill in-flight que deba pausar el detector (nota de diseño guru p.4).
            pendingSkillCallsSize: 0,
            alreadyFired: streamGapFired,
            thresholdMs: _sgThreshold,
        })) {
            streamGapFired = true;
            settled = true;
            cleanup();
            try { _kill(); } catch { /* best-effort */ }
            _onStreamGap();
        }
    }, _pollMs);

    return { cleanup, markSettled, isSettled: () => settled };
}

module.exports = { createStallDetectors };
