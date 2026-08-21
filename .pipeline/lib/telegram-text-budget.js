// =============================================================================
// telegram-text-budget.js — Cotas de largo del saliente de Telegram (#5176).
//
// POR QUÉ EXISTE
// --------------
// `sendTelegramWithMarkup` (pulpo.js) recorta el saliente con
// `text.slice(0, 4000) + '...'`. Ese recorte es INVISIBLE para el handler que
// produjo el texto y para el operador que lo lee:
//
//   - corta a mitad de token MarkdownV2 (`\(sin metadata\` → backslash colgado),
//     que es el modo de falla `400 Can't parse entities`;
//   - puede partir un par surrogate (los emojis del render son astrales) y dejar
//     media unidad de código;
//   - el marcador `'...'` son TRES PUNTOS SIN ESCAPAR: en MarkdownV2 el `.` es
//     metacarácter, así que el propio marcador de truncado podía romper el parseo;
//   - el pie del mensaje se pierde sin ningún indicador de que faltó contenido.
//
// Este módulo centraliza la cota y da un recorte que respeta los límites de
// token. Es la RED DE SEGURIDAD del transporte, no la solución: un handler que
// puede producir texto largo tiene que acotarlo él mismo (ver
// `allowlist-render-budget.js`), porque sólo el handler sabe QUÉ se puede omitir
// y cómo avisarlo.
// =============================================================================
'use strict';

// Cota dura del transporte. El API de Telegram admite 4096 chars por mensaje;
// 4000 es el margen histórico del pipeline y se conserva para no cambiar el
// comportamiento de ningún otro saliente.
const TELEGRAM_TEXT_LIMIT = 4000;

// Margen reservado para lo que el transporte PREPENDE fuera del control del
// handler. Hoy: el eco de transcripción de un comando originado en audio
// (`commander/transcript-echo.js`, 200 chars crudos que el escape MarkdownV2
// puede casi duplicar, más el encabezado del eco). Sin este margen un render
// que entra justo en 4000 se pasa cuando el mismo comando llega por audio.
const PREPEND_HEADROOM = 500;

// Presupuesto que un handler puede gastar y seguir entrando en el saliente
// incluso cuando el comando viene por audio.
const HANDLER_TEXT_BUDGET = TELEGRAM_TEXT_LIMIT - PREPEND_HEADROOM;

// Marcador de truncado. `…` (U+2026) NO es metacarácter de MarkdownV2, a
// diferencia de los tres puntos `...` que usaba el recorte anterior.
const TRUNCATION_MARKER = '…';

/**
 * ¿El corte en `idx` deja un backslash de escape colgado?
 * En MarkdownV2 un `\` escapa al carácter siguiente. Si el texto recortado
 * termina en una cantidad IMPAR de backslashes, el último quedó sin su carácter
 * escapado y Telegram responde 400.
 * @param {string} sliced
 * @returns {boolean}
 */
function hasDanglingEscape(sliced) {
    let backslashes = 0;
    for (let i = sliced.length - 1; i >= 0 && sliced[i] === '\\'; i--) backslashes += 1;
    return backslashes % 2 === 1;
}

/**
 * Recorta `text` para que no supere `limit` caracteres, sin partir un escape
 * MarkdownV2 ni un par surrogate, y dejando un marcador visible de truncado.
 *
 * Contrato:
 *  - nunca lanza (entrada no-string se coacciona);
 *  - el resultado SIEMPRE mide <= `limit`;
 *  - si el texto ya entra, se devuelve intacto (sin marcador).
 *
 * @param {string} text
 * @param {number} [limit=TELEGRAM_TEXT_LIMIT]
 * @param {string} [marker=TRUNCATION_MARKER]
 * @returns {string}
 */
function safeTruncate(text, limit = TELEGRAM_TEXT_LIMIT, marker = TRUNCATION_MARKER) {
    const str = typeof text === 'string' ? text : String(text === null || text === undefined ? '' : text);
    const max = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : TELEGRAM_TEXT_LIMIT;
    if (str.length <= max) return str;

    const mark = typeof marker === 'string' ? marker : '';
    // Si ni el marcador entra en la cota, devolvemos un recorte pelado.
    if (mark.length >= max) return str.slice(0, max);

    let cut = max - mark.length;
    // 1. No partir un par surrogate (los emojis del render son astrales).
    const lastCode = str.charCodeAt(cut - 1);
    if (lastCode >= 0xD800 && lastCode <= 0xDBFF) cut -= 1;
    // 2. No dejar un backslash de escape sin su carácter escapado.
    let sliced = str.slice(0, cut);
    if (hasDanglingEscape(sliced)) sliced = sliced.slice(0, -1);
    return sliced + mark;
}

module.exports = {
    TELEGRAM_TEXT_LIMIT,
    PREPEND_HEADROOM,
    HANDLER_TEXT_BUDGET,
    TRUNCATION_MARKER,
    safeTruncate,
    hasDanglingEscape,
};
