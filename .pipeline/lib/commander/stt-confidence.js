// stt-confidence.js — Evaluación de confianza STT y gate de confirmación (#3918 / EP1-H3, CA-2)
//
// Cuando la transcripción local (whisper) viene con baja confianza, el Commander
// pide confirmación ANTES de ejecutar acciones con efectos (creación de issues,
// destructivas). Esto es un control de integridad de input: reduce el riesgo de
// ejecutar sobre una transcripción equivocada.
//
// Requisitos de seguridad incorporados (security — fase análisis):
//   RS-4: el gate es ADITIVO al cooldown destructivo (#3253) — nunca lo
//         sustituye. La confianza STT alta NO es señal de autorización. El
//         mensaje de confirmación cita textualmente la acción exacta y expira
//         con la ventana de 5 min.
//   RS-6: ante cualquier anomalía del parseo del JSON de whisper (campos no
//         numéricos, Infinity, objeto ausente) la confianza es DESCONOCIDA →
//         eco sí, confirmación no (coherente con el camino API de #3917).

// Umbral inicial (receta architect). Requiere calibración con corpus es-AR
// (sinergia con los tests WER de #3916). Pisable por env para experimentación.
const AVG_LOGPROB_THRESHOLD = Number.isFinite(Number(process.env.STT_AVG_LOGPROB_THRESHOLD))
    ? Number(process.env.STT_AVG_LOGPROB_THRESHOLD)
    : -0.7;
const NO_SPEECH_PROB_THRESHOLD = Number.isFinite(Number(process.env.STT_NO_SPEECH_PROB_THRESHOLD))
    ? Number(process.env.STT_NO_SPEECH_PROB_THRESHOLD)
    : 0.5;

// Ventana de validez de una confirmación pendiente (alineada con el prevContext
// de #3418).
const PENDING_CONFIRMATION_TTL_MS = 5 * 60 * 1000;

const CONFIDENCE = Object.freeze({
    LOW: 'low',
    OK: 'ok',
    UNKNOWN: 'unknown',
});

/**
 * Evalúa la confianza de una transcripción a partir de las métricas de whisper.
 *
 * @param {{avgLogprob?: number, noSpeechProb?: number}|null|undefined} confidence
 * @returns {'low'|'ok'|'unknown'}
 */
function assessSttConfidence(confidence) {
    if (!confidence || typeof confidence !== 'object') return CONFIDENCE.UNKNOWN;

    const avg = confidence.avgLogprob;
    const noSpeech = confidence.noSpeechProb;
    const avgOk = typeof avg === 'number' && Number.isFinite(avg);
    const noSpeechOk = typeof noSpeech === 'number' && Number.isFinite(noSpeech);

    // Sin ninguna métrica finita → no podemos afirmar nada (RS-6).
    if (!avgOk && !noSpeechOk) return CONFIDENCE.UNKNOWN;

    if (avgOk && avg < AVG_LOGPROB_THRESHOLD) return CONFIDENCE.LOW;
    if (noSpeechOk && noSpeech > NO_SPEECH_PROB_THRESHOLD) return CONFIDENCE.LOW;

    return CONFIDENCE.OK;
}

/**
 * Consolida la confianza de varios mensajes de audio en un veredicto único.
 * Conservador: si CUALQUIER audio es de baja confianza → 'low'. Si ninguno es
 * 'low' pero alguno es 'ok' → 'ok'. Si todos son desconocidos (o no hay audio
 * con métricas) → 'unknown'.
 *
 * @param {Array<{avgLogprob?: number, noSpeechProb?: number}|null>} confidences
 * @returns {'low'|'ok'|'unknown'}
 */
function assessConsolidatedConfidence(confidences) {
    if (!Array.isArray(confidences) || confidences.length === 0) return CONFIDENCE.UNKNOWN;
    let anyOk = false;
    for (const c of confidences) {
        const verdict = assessSttConfidence(c);
        if (verdict === CONFIDENCE.LOW) return CONFIDENCE.LOW;
        if (verdict === CONFIDENCE.OK) anyOk = true;
    }
    return anyOk ? CONFIDENCE.OK : CONFIDENCE.UNKNOWN;
}

// Respuestas afirmativas cortas que cuentan como confirmación de una acción
// pendiente. Anclado al inicio para no matchear un "sí" embebido en una frase
// más larga que en realidad es una nueva instrucción.
// Sin `\b` final: "sí" termina en `í` (no-word ASCII), donde `\b` no matchea.
// El ancla `[\s!.,]*$` ya garantiza que no haya texto adicional (una nueva
// instrucción) después del afirmativo.
const CONFIRMATION_RE = /^\s*(s[ií]|sip|dale|ok(ay)?|oka|confirmo|confirmar|confirmado|de una|hac[eé]lo|adelante|listo|va|sale|obvio|por supuesto)[\s!.,]*$/i;

/**
 * ¿El texto es una confirmación afirmativa corta?
 * @param {string} text
 * @returns {boolean}
 */
function isConfirmationText(text) {
    if (typeof text !== 'string') return false;
    return CONFIRMATION_RE.test(text.trim());
}

/**
 * ¿Sigue vigente una confirmación pendiente registrada en `ts`?
 * @param {number} ts - epoch ms del registro de la confirmación pendiente.
 * @param {number} [now] - epoch ms actual (inyectable para tests).
 * @returns {boolean}
 */
function isPendingConfirmationFresh(ts, now = Date.now()) {
    if (!Number.isFinite(ts) || ts <= 0) return false;
    return (now - ts) <= PENDING_CONFIRMATION_TTL_MS;
}

module.exports = {
    assessSttConfidence,
    assessConsolidatedConfidence,
    isConfirmationText,
    isPendingConfirmationFresh,
    CONFIDENCE,
    AVG_LOGPROB_THRESHOLD,
    NO_SPEECH_PROB_THRESHOLD,
    PENDING_CONFIRMATION_TTL_MS,
};
