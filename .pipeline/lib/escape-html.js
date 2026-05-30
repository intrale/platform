'use strict';

// =============================================================================
// escape-html.js — Helper unificado de escape HTML server-side (#3722, padre #3715).
// Cierra #2901. Bloqueante para todas las sub-historias del rediseño dashboard V3
// que rendericen datos dinámicos.
// =============================================================================

const TEXT_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;' };
const ATTR_MAP = { ...TEXT_MAP, '"': '&quot;', "'": '&#39;', '`': '&#96;' };

/**
 * Escapa texto para uso DENTRO de elementos HTML.
 *
 *   SEGURO PARA:  <span>${escapeHtmlText(x)}</span>, <div>${...}</div>
 *   INSEGURO PARA: <span title="${...}">, <a href="${...}"> — usá escapeHtmlAttr() ahí.
 *                  <a href="javascript:..."> — URL context requiere validación adicional.
 *
 * Coerción defensiva: null/undefined → '', cualquier otro tipo → String(input)
 * antes del replace.
 *
 * @param {*} input - Cualquier valor; null/undefined → ''
 * @returns {string} - Texto con `& < >` reemplazados por sus entidades HTML.
 */
function escapeHtmlText(input) {
    if (input === null || input === undefined) return '';
    return String(input).replace(/[&<>]/g, c => TEXT_MAP[c]);
}

/**
 * Escapa texto para uso dentro de VALORES DE ATRIBUTO HTML (delimitados por " o ').
 *
 *   SEGURO PARA:  <span title="${escapeHtmlAttr(x)}">, <input value='${...}'>
 *   INSEGURO PARA: <a href="javascript:${...}">, <a href="${userUrl}"> — URL context
 *                  requiere validación de protocolo aparte (ver issue futuro de
 *                  escapeHtmlUrl).
 *
 * Coerción defensiva: null/undefined → '', cualquier otro tipo → String(input)
 * antes del replace.
 *
 * @param {*} input - Cualquier valor; null/undefined → ''
 * @returns {string} - Texto con `& < > " ' \`` reemplazados por sus entidades HTML.
 */
function escapeHtmlAttr(input) {
    if (input === null || input === undefined) return '';
    return String(input).replace(/[&<>"'`]/g, c => ATTR_MAP[c]);
}

module.exports = { escapeHtmlText, escapeHtmlAttr };
