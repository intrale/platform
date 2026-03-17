// telegram-sanitizer.js — Sanitización UTF-8 para envío a la API de Telegram (#1637)
// Limpia caracteres problemáticos que causan errores de encoding en la API
// Pure Node.js — sin dependencias externas
"use strict";

const fs = require("fs");
const path = require("path");

const LOG_FILE = path.join(__dirname, "hook-debug.log");

function log(msg) {
    try { fs.appendFileSync(LOG_FILE, "[" + new Date().toISOString() + "] TgSanitizer: " + msg + "\n"); } catch (e) {}
}

// ─── Caracteres problemáticos ────────────────────────────────────────────────

// Surrogate halves sueltos — inválidos en UTF-8
// High surrogate sin low surrogate, o low surrogate sin high surrogate
const LONE_HIGH_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g;
const LONE_LOW_SURROGATE_RE = /(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

// Caracteres de control C0 (excepto \n \r \t que son válidos en Telegram)
const CONTROL_CHARS_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

// Caracteres de control C1 (U+0080..U+009F) — raramente intencionales
const C1_CONTROL_RE = /[\u0080-\u009F]/g;

// BOM (Byte Order Mark) y otros invisibles problemáticos
const BOM_AND_SPECIALS_RE = /[\uFEFF\uFFFE\uFFFF]/g;

// Zero-width characters que pueden corromper markdown de Telegram
// (zero-width space, zero-width non-joiner, zero-width joiner, word joiner,
//  left-to-right/right-to-left marks)
const ZERO_WIDTH_RE = /[\u200B\u200C\u200D\u2060\u200E\u200F]/g;

// Variation selectors (U+FE00..U+FE0F) — pueden causar rendering issues
// pero son legítimos con emojis, así que solo los removemos si están sueltos
// (no precedidos por un emoji base)
const VARIATION_SELECTOR_RE = /(?<![^\u0000-\u00FF\u2000-\u3300\uD800-\uDBFF])[\uFE00-\uFE0F]/g;

// ─── Función principal ──────────────────────────────────────────────────────

/**
 * Sanitiza un texto para envío seguro a la API de Telegram.
 * Remueve caracteres que causan errores de encoding UTF-8 y otros problemas.
 *
 * @param {string} text - Texto a sanitizar
 * @param {object} [opts] - Opciones: { logWarnings: boolean }
 * @returns {string} Texto sanitizado
 */
function sanitize(text, opts) {
    if (!text || typeof text !== "string") return text || "";

    opts = opts || {};
    const logWarnings = opts.logWarnings !== false; // default: true

    let result = text;
    let warnings = [];

    // 1. Remover surrogates sueltos (causa principal de errores UTF-8)
    const highMatches = result.match(LONE_HIGH_SURROGATE_RE);
    const lowMatches = result.match(LONE_LOW_SURROGATE_RE);
    if (highMatches || lowMatches) {
        const count = (highMatches ? highMatches.length : 0) + (lowMatches ? lowMatches.length : 0);
        warnings.push("surrogates sueltos: " + count);
        result = result.replace(LONE_HIGH_SURROGATE_RE, "\uFFFD");
        result = result.replace(LONE_LOW_SURROGATE_RE, "\uFFFD");
    }

    // 2. Remover caracteres de control C0 (excepto \n, \r, \t)
    const controlMatches = result.match(CONTROL_CHARS_RE);
    if (controlMatches) {
        warnings.push("chars control C0: " + controlMatches.length);
        result = result.replace(CONTROL_CHARS_RE, "");
    }

    // 3. Remover caracteres de control C1
    const c1Matches = result.match(C1_CONTROL_RE);
    if (c1Matches) {
        warnings.push("chars control C1: " + c1Matches.length);
        result = result.replace(C1_CONTROL_RE, "");
    }

    // 4. Remover BOM y caracteres especiales inválidos
    const bomMatches = result.match(BOM_AND_SPECIALS_RE);
    if (bomMatches) {
        warnings.push("BOM/specials: " + bomMatches.length);
        result = result.replace(BOM_AND_SPECIALS_RE, "");
    }

    // 5. Remover zero-width characters problemáticos
    const zwMatches = result.match(ZERO_WIDTH_RE);
    if (zwMatches) {
        warnings.push("zero-width chars: " + zwMatches.length);
        result = result.replace(ZERO_WIDTH_RE, "");
    }

    // 6. Normalizar line endings (CRLF → LF)
    if (result.includes("\r\n")) {
        result = result.replace(/\r\n/g, "\n");
    }
    // Remover \r sueltos (sin \n)
    if (result.includes("\r")) {
        result = result.replace(/\r/g, "\n");
    }

    // 7. Colapsar líneas vacías excesivas (más de 2 seguidas)
    result = result.replace(/\n{4,}/g, "\n\n\n");

    // Log warnings si se detectaron problemas
    if (logWarnings && warnings.length > 0) {
        log("WARNING sanitización requerida — " + warnings.join(", ") +
            " — primeros 100 chars del input: " + text.substring(0, 100).replace(/[\n\r]/g, "\\n"));
    }

    return result;
}

/**
 * Sanitiza texto HTML para Telegram.
 * Además de la sanitización base, asegura que los tags HTML estén balanceados.
 *
 * @param {string} html - Texto HTML a sanitizar
 * @param {object} [opts] - Opciones: { logWarnings: boolean }
 * @returns {string} HTML sanitizado
 */
function sanitizeHtml(html, opts) {
    if (!html || typeof html !== "string") return html || "";

    // Primero sanitizar caracteres problemáticos
    let result = sanitize(html, opts);

    // Reparar tags HTML rotos por la sanitización
    // Telegram soporta: b, strong, i, em, u, ins, s, strike, del, a, code, pre
    const supportedTags = ["b", "strong", "i", "em", "u", "ins", "s", "strike", "del", "a", "code", "pre"];

    // Verificar tags abiertos sin cerrar
    for (const tag of supportedTags) {
        const openRe = new RegExp("<" + tag + "(\\s[^>]*)?>", "gi");
        const closeRe = new RegExp("</" + tag + ">", "gi");
        const opens = (result.match(openRe) || []).length;
        const closes = (result.match(closeRe) || []).length;

        if (opens > closes) {
            // Agregar tags de cierre faltantes al final
            for (let i = 0; i < opens - closes; i++) {
                result += "</" + tag + ">";
            }
        }
    }

    return result;
}

/**
 * Verifica si un texto necesita sanitización (sin modificarlo).
 *
 * @param {string} text - Texto a verificar
 * @returns {boolean} true si el texto contiene caracteres problemáticos
 */
function needsSanitization(text) {
    if (!text || typeof text !== "string") return false;
    return LONE_HIGH_SURROGATE_RE.test(text) ||
           LONE_LOW_SURROGATE_RE.test(text) ||
           CONTROL_CHARS_RE.test(text) ||
           C1_CONTROL_RE.test(text) ||
           BOM_AND_SPECIALS_RE.test(text) ||
           ZERO_WIDTH_RE.test(text);
}

module.exports = {
    sanitize,
    sanitizeHtml,
    needsSanitization
};
