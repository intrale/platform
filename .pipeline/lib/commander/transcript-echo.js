// transcript-echo.js — Eco de transcripción STT para el Commander (#3918 / EP1-H3)
//
// El eco "🎤 Entendí: «…»" es la única defensa real contra errores de STT:
// ni el Commander ni Sherlock pueden detectar una transcripción equivocada por
// sí solos. Este módulo consolida N transcripciones en un único string seguro
// para enviar por Telegram y persistir en el history.
//
// Requisitos de seguridad incorporados (security — fase análisis):
//   RS-1: escaping de metacaracteres Markdown (parse_mode 'Markdown' de
//         sendTelegram) — una transcripción con `*_`[ rompe el parseo y Telegram
//         rechaza el mensaje (DoS silencioso del eco).
//   RS-2: redacción de secretos (AWS keys, JWT, tokens de alta entropía, emails,
//         URLs con credenciales) ANTES de enviar y de persistir.
//   RS-5: truncado con cap TOTAL (~200 chars sobre el conjunto consolidado, no
//         por audio) con elipsis.

const { redactSensitive, redactSecretValue } = require('../redact');
const { escapeMarkdownV2 } = require('./fill-template');

const DEFAULT_MAX_LEN = 200;

// Metacaracteres del Markdown LEGACY de Telegram (parse_mode: 'Markdown', el
// default de sendTelegram). Sólo estos cuatro inician entidades; escapándolos
// con backslash garantizamos que ninguna transcripción pueda abrir una entidad
// sin cerrar (que es lo que dispara el rechazo 400 de Telegram).
// Ref: https://core.telegram.org/bots/api#markdown-style
const MD_LEGACY_SPECIALS = /([_*`\[])/g;

/**
 * Escapa los metacaracteres del Markdown legacy de Telegram (RS-1).
 * @param {string} text
 * @returns {string}
 */
function escapeMarkdown(text) {
    if (text === null || text === undefined) return '';
    return String(text).replace(MD_LEGACY_SPECIALS, '\\$1');
}

// #4130 — Cuando el eco se prepende a un reply MarkdownV2 (ej. `/wave` por
// audio), debe escaparse con las reglas de MarkdownV2 (muchos más metacaracteres:
// `. ! - ( ) #` …). Un `.` o `(` sin escapar en la transcripción rompería el
// parseo del MENSAJE COMPLETO (Telegram 400 → el saliente nunca se entrega). El
// dialecto del escape debe coincidir con el `parse_mode` del saliente.
function escapeForMode(text, markdownV2) {
    return markdownV2 ? escapeMarkdownV2(text) : escapeMarkdown(text);
}

/**
 * Redacta secretos de un string libre (RS-2). Combina:
 *   - redactSensitive: emails y URLs con credenciales embebidas.
 *   - redactSecretValue: patrones de valor de secretos conocidos (AWS access
 *     keys, JWT, sk-/sk-ant-/gsk_) + heurística de entropía Shannon para tokens
 *     opacos largos.
 * @param {string} text
 * @returns {string}
 */
function redactEcho(text) {
    if (typeof text !== 'string' || text.length === 0) return '';
    // redactSensitive sobre string → emails + URLs. redactSecretValue → valores
    // de secretos conocidos + alta entropía. Orden indistinto: targetean
    // patrones disjuntos.
    return redactSecretValue(redactSensitive(text));
}

/**
 * Consolida N transcripciones en un eco seguro para Telegram.
 *
 * Orden de operaciones (deliberado):
 *   1. Filtrar entradas vacías / no-string.
 *   2. Consolidar con separador ' / '.
 *   3. Redactar secretos (RS-2) — sobre el texto crudo, antes de escapar.
 *   4. Truncar al cap TOTAL (RS-5) — sobre el texto redactado pero SIN escapar,
 *      para no cortar una secuencia de escape `\*` por la mitad.
 *   5. Escapar Markdown (RS-1) — último paso, sobre el texto ya acotado.
 *
 * @param {string[]} transcripts - transcripciones a consolidar.
 * @param {{maxLen?: number, markdownV2?: boolean}} [opts] - #4130: `markdownV2`
 *   escapa con las reglas del dialecto V2 cuando el eco se prepende a un reply
 *   MarkdownV2 (ej. `/wave` por audio). El dialecto del escape DEBE coincidir
 *   con el `parse_mode` del saliente o el mensaje completo rompe (Telegram 400).
 * @returns {string} eco listo para enviar, o '' si no hay nada que ecoar.
 */
function formatTranscriptEcho(transcripts, opts = {}) {
    const maxLen = Number.isFinite(opts.maxLen) && opts.maxLen > 0 ? opts.maxLen : DEFAULT_MAX_LEN;
    if (!Array.isArray(transcripts) || transcripts.length === 0) return '';

    const cleaned = transcripts
        .map((t) => (typeof t === 'string' ? t.trim() : ''))
        .filter((t) => t.length > 0);
    if (cleaned.length === 0) return '';

    const joined = cleaned.join(' / ');
    const redacted = redactEcho(joined);
    const truncated = redacted.length > maxLen
        ? redacted.slice(0, maxLen).trimEnd() + '…'
        : redacted;
    const escaped = escapeForMode(truncated, !!opts.markdownV2);
    return `🎤 Entendí: «${escaped}»`;
}

/**
 * Construye la etiqueta de acción segura para interpolar en un mensaje en vivo
 * a Telegram (#3918 rebote rev-1 — RS-1/RS-2).
 *
 * El gate de confirmación por baja confianza cita la acción dictada dentro del
 * `confirmMsg` que se envía con parse_mode 'Markdown'. Esa cita es una SEGUNDA
 * interpolación del mismo input no confiable (la transcripción cruda) y debe
 * pasar por las MISMAS defensas que `formatTranscriptEcho`, en el mismo orden:
 *   1. Redactar secretos (RS-2) sobre el texto crudo.
 *   2. Truncar sobre el texto redactado SIN escapar (RS-5) — así no cortamos una
 *      secuencia de escape `\*` por la mitad.
 *   3. Escapar Markdown (RS-1) como último paso.
 *
 * Sin esto, un `*_`[ backtick sin cerrar rompe el parseo (Telegram 400 → DoS
 * silencioso del gate) y un secreto dictado se ecoa en plano en el chat.
 *
 * @param {string[]} transcripts - transcripciones a citar.
 * @param {{maxLen?: number}} [opts]
 * @returns {string} etiqueta segura (puede ser '' si no hay nada que citar).
 */
function formatActionLabel(transcripts, opts = {}) {
    const maxLen = Number.isFinite(opts.maxLen) && opts.maxLen > 0 ? opts.maxLen : DEFAULT_MAX_LEN;
    if (!Array.isArray(transcripts) || transcripts.length === 0) return '';
    const cleaned = transcripts
        .map((t) => (typeof t === 'string' ? t.trim() : ''))
        .filter((t) => t.length > 0);
    if (cleaned.length === 0) return '';
    const redacted = redactEcho(cleaned.join(' / '));
    const truncated = redacted.length > maxLen
        ? redacted.slice(0, maxLen).trimEnd() + '…'
        : redacted;
    return escapeMarkdown(truncated);
}

/**
 * Construye los campos aditivos del entry `in` de audio del commander-history
 * (CA-3 / RS-3). Backward-compatible: consumidores que no los entienden los
 * descartan en lectura.
 *
 * El texto derivado (no hay free-text acá: `stt_source` es un enum controlado y
 * `transcript_echo`/`stt_confidence` son bool/número) igual pasa por la
 * sanitización de `appendCommanderHistory` aguas abajo.
 *
 * @param {{ok?: boolean, source?: string, confidence?: {avgLogprob?: number}}|null} audio
 * @returns {{transcript_echo?: boolean, stt_confidence?: number|null, stt_source?: string}}
 */
function buildEchoHistoryFields(audio) {
    if (!audio || audio.ok === false) return {};
    const fields = { transcript_echo: true };
    // En código el source es 'openai'|'local'; el contrato del history pide
    // 'api'|'local'.
    fields.stt_source = audio.source === 'local' ? 'local' : 'api';
    let conf = null;
    if (
        audio.confidence &&
        typeof audio.confidence.avgLogprob === 'number' &&
        Number.isFinite(audio.confidence.avgLogprob)
    ) {
        conf = audio.confidence.avgLogprob;
    }
    fields.stt_confidence = conf;
    return fields;
}

module.exports = {
    formatTranscriptEcho,
    formatActionLabel,
    buildEchoHistoryFields,
    escapeMarkdown,
    redactEcho,
    DEFAULT_MAX_LEN,
};
