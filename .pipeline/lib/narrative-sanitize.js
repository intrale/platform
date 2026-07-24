// =============================================================================
// narrative-sanitize.js — Sanitización narrativa para TTS
// Issue #3539 · CA-UX-2
//
// Responsabilidad: convertir el texto que va a Telegram (con emojis, separadores
// visuales, markdown y envelope HTML) en texto plano legible por un motor TTS
// sin que la voz lea literalmente "asterisco asterisco texto" o el comentario
// del envelope.
//
// NO redacta secrets (eso lo hace `redactSensitive` previamente). Tampoco es
// idempotente con redact — el caller debe aplicar primero redact, después
// narrative-sanitize.
//
// Pipeline esperado:
//   redactSensitive(text) → narrativeSanitize(text) → textToSpeechWithMeta(text)
// =============================================================================
'use strict';

// Emojis que aparecen en el header canónico (deliverable-notify.js SKILL_EMOJIS
// + decoradores comunes). Se eliminan en vez de narrarlos (la voz NO debe leer
// "lupa hashtag tres mil quinientos treinta y nueve").
const HEADER_EMOJI_RE = /[\u{1F300}-\u{1F9FF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{1F000}-\u{1F02F}\u{1F0A0}-\u{1F0FF}\u{1F100}-\u{1F1FF}\u{1F200}-\u{1F2FF}]️?/gu;

// HTML comment con el envelope canónico (`<!-- pipeline-meta {...} -->`).
// Si llega al TTS, la voz leería literalmente "menor signo menos exclamación".
const HTML_COMMENT_RE = /<!--[\s\S]*?-->/g;

// Separador visual de Intrale (` · `). Se convierte en pausa natural.
// Único — no confundir con el medio-punto del texto natural castellano.
const VISUAL_SEPARATOR_RE = / · /g;

// Markdown inline básico:
//   `**bold**`, `__bold__`, `_italic_`, `*italic*`, `` `code` ``
//
// El regex de italic es restrictivo a propósito para NO consumir underscores
// internos a identificadores tipo `snake_case` (ej. `audio_error`). Solo
// matchea si el marcador (`*` o `_`) está pegado a whitespace, puntuación o
// borde de string en ambos lados → así `_italic_` matchea pero `audio_error`
// no se toca.
const MD_BOLD_RE = /(\*\*|__)(.+?)\1/g;
const MD_ITALIC_RE = /(^|[\s.,;:!?¿¡()[\]{}'"`])([*_])(\S(?:[^*_\n]*?\S)?)\2(?=[\s.,;:!?¿¡()[\]{}'"`]|$)/g;
const MD_CODE_INLINE_RE = /`([^`\n]+)`/g;
const MD_CODE_FENCE_RE = /```[\s\S]*?```/g;

// Encabezados markdown (`## Hallazgos`) → quedan como frase natural.
const MD_HEADING_RE = /^#{1,6}\s+/gm;

// Bullets de markdown (`- item`, `* item`) → quedan como frase.
const MD_BULLET_RE = /^(\s*)[-*+]\s+/gm;

// Líneas blanco-only (≥2 newlines) → colapsar a punto y aparte natural.
const MULTI_NEWLINE_RE = /\n{3,}/g;

// URL "raw" emitida por el módulo (`🔗 https://github.com/...`). Reemplazo por
// frase natural. La voz NO debe deletrear el path completo.
const FOOTER_LINK_RE = /🔗\s*https?:\/\/\S+/g;

// URLs cualesquiera que sobrevivan al footer → narrarlas como "el enlace en el
// mensaje" en vez de deletrear cada char.
const ANY_URL_RE = /https?:\/\/[^\s)]+/g;

/**
 * Convierte un texto con markdown/emojis/envelope en texto plano legible por
 * TTS. Defensivo ante input no-string.
 *
 * @param {string} text
 * @returns {string}
 */
function narrativeSanitize(text) {
    if (typeof text !== 'string') return '';
    if (text.length === 0) return '';

    let out = text;

    // 1) Strippear HTML comments (envelope). Si dejamos el envelope, el TTS
    //    leería "pipeline meta llave abierta issue dos puntos..." que es
    //    grotesco y además podría exponer metadata sensible si algún field
    //    fuera filtrado por error.
    out = out.replace(HTML_COMMENT_RE, '');

    // 2) Strippear code fences (multilinea) antes de inline.
    out = out.replace(MD_CODE_FENCE_RE, '');

    // 3) Strippear inline code (`foo`).
    out = out.replace(MD_CODE_INLINE_RE, '$1');

    // 4) Strippear bold y italic (mantener contenido).
    //    - Bold: grupo 2 es el contenido entre `**...**` o `__...__`.
    //    - Italic: grupo 1 es el separador previo (preservar), grupo 3 es el contenido.
    out = out.replace(MD_BOLD_RE, '$2');
    out = out.replace(MD_ITALIC_RE, '$1$3');

    // 5) Headings markdown → quitar `#`s pero conservar el texto del heading
    //    (terminado en `.` para que el TTS haga pausa natural).
    out = out.replace(MD_HEADING_RE, '');

    // 6) Bullets → quitar el marcador, conservar el contenido y separar con
    //    coma para que se lea como enumeración natural.
    out = out.replace(MD_BULLET_RE, '$1');

    // 7) Footer link con emoji 🔗 → reemplazo por frase narrativa.
    out = out.replace(FOOTER_LINK_RE, 'El enlace al issue está en el mensaje.');

    // 8) URLs sueltas → reemplazo por descriptor (la voz no debe deletrear).
    out = out.replace(ANY_URL_RE, 'el enlace en el mensaje');

    // 9) Separador visual ` · ` → punto+espacio (pausa natural).
    out = out.replace(VISUAL_SEPARATOR_RE, '. ');

    // 10) Emojis (después del footer-link para no perder el contexto del 🔗).
    out = out.replace(HEADER_EMOJI_RE, '');

    // 11) Colapsar saltos de línea múltiples a uno solo (TTS los lee como
    //     pausa larga; >2 suena raro).
    out = out.replace(MULTI_NEWLINE_RE, '\n\n');

    // 12) Limpiar espacios en blanco redundantes y trim final.
    out = out.replace(/[ \t]{2,}/g, ' ');
    out = out.replace(/[ \t]+\n/g, '\n');
    out = out.split('\n').map((line) => line.trim()).join('\n').trim();

    return out;
}

/**
 * Variante "agresiva" para previews truncados: el sufijo `_(continúa en el
 * issue)_` del módulo deliverable-notify es ruidoso en audio. Lo simplifica.
 */
function narrativeSanitizePreview(text) {
    if (typeof text !== 'string') return '';
    let out = narrativeSanitize(text);
    // Reemplazo del sufijo de truncado por frase natural si quedó.
    out = out.replace(/[…\.]+\s*\(?continúa en el issue\)?[\.]*/gi, '... el contenido completo está en el issue.');
    return out;
}

module.exports = {
    narrativeSanitize,
    narrativeSanitizePreview,
    // Exportar regex para tests internos.
    __forTests__: {
        HEADER_EMOJI_RE,
        HTML_COMMENT_RE,
        VISUAL_SEPARATOR_RE,
        MD_BOLD_RE,
        MD_ITALIC_RE,
        MD_CODE_INLINE_RE,
        MD_CODE_FENCE_RE,
        FOOTER_LINK_RE,
    },
};
