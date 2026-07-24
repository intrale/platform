// =============================================================================
// preview-diff.js — Pieza pura del wizard de triaje de allowlist (#3742).
//
// Computa el diff `{added, removed}` entre el allowlist previo y el propuesto,
// sin I/O. Aislada y testeable: el paso 4 del wizard la usa para el preview y
// para la comparación anti-TOCTOU contra el snapshot del cliente.
//
// El render HTML del preview (`renderPreviewHtml`) pasa SIEMPRE por
// `escape-html.js` (#3722) — nunca interpola `motivo` / `issue_id` crudos en
// HTML (defensa XSS, CA-10 de #3715).
//
// Sin deps npm: sólo `node:` builtins indirectos vía `../../escape-html`.
// =============================================================================
'use strict';

const { escapeHtmlText } = require('../../escape-html');

/**
 * Normaliza una lista de issues a enteros positivos únicos ordenados.
 * @param {Array<number|string>} list
 * @returns {number[]}
 */
function normalizeList(list) {
    const out = new Set();
    if (Array.isArray(list)) {
        for (const v of list) {
            const n = Number(v);
            if (Number.isInteger(n) && n > 0) out.add(n);
        }
    }
    return [...out].sort((a, b) => a - b);
}

/**
 * Diff entre dos allowlists. Función principal del módulo.
 * @param {Array<number|string>} previous
 * @param {Array<number|string>} nextProposed
 * @returns {{added: number[], removed: number[]}}
 */
function previewDiff(previous, nextProposed) {
    const prev = new Set(normalizeList(previous));
    const next = new Set(normalizeList(nextProposed));
    const added = [...next].filter((n) => !prev.has(n)).sort((a, b) => a - b);
    const removed = [...prev].filter((n) => !next.has(n)).sort((a, b) => a - b);
    return { added, removed };
}

/**
 * Compara dos diffs por valor (orden-independiente). Usado para detectar
 * divergencia entre el preview del cliente y el recálculo server-side.
 * @param {{added?: number[], removed?: number[]}} a
 * @param {{added?: number[], removed?: number[]}} b
 * @returns {boolean}
 */
function equals(a, b) {
    if (!a || !b) return false;
    const na = { added: normalizeList(a.added), removed: normalizeList(a.removed) };
    const nb = { added: normalizeList(b.added), removed: normalizeList(b.removed) };
    return (
        na.added.length === nb.added.length &&
        na.removed.length === nb.removed.length &&
        na.added.every((v, i) => v === nb.added[i]) &&
        na.removed.every((v, i) => v === nb.removed[i])
    );
}

/**
 * Compara dos snapshots de allowlist (arrays) por valor. Usado en el guard
 * anti-TOCTOU del paso 4: el cliente envía el `previous` que vio en el paso 3
 * y el server lo compara contra el estado real en disco al confirmar.
 * @param {Array<number|string>} a
 * @param {Array<number|string>} b
 * @returns {boolean}
 */
function equalsList(a, b) {
    const na = normalizeList(a);
    const nb = normalizeList(b);
    return na.length === nb.length && na.every((v, i) => v === nb[i]);
}

/**
 * Render HTML del preview. SIEMPRE escapa el contenido dinámico (#3722).
 * `motivo` y los issue_id se escapan aunque sean numéricos: defensa en
 * profundidad ante un `motivo` con payload XSS (CA-10).
 * @param {{added: number[], removed: number[]}} diff
 * @param {{motivo?: string}} [opts]
 * @returns {string} fragmento HTML seguro
 */
function renderPreviewHtml(diff, opts = {}) {
    const d = diff || { added: [], removed: [] };
    const lines = [];
    for (const n of normalizeList(d.added)) {
        lines.push(`<li class="diff-added">+ #${escapeHtmlText(String(n))}</li>`);
    }
    for (const n of normalizeList(d.removed)) {
        lines.push(`<li class="diff-removed">- #${escapeHtmlText(String(n))}</li>`);
    }
    let html = `<ul class="allowlist-diff">${lines.join('')}</ul>`;
    if (opts.motivo != null) {
        html += `<p class="allowlist-motivo">${escapeHtmlText(String(opts.motivo))}</p>`;
    }
    return html;
}

module.exports = previewDiff;
module.exports.previewDiff = previewDiff;
module.exports.equals = equals;
module.exports.equalsList = equalsList;
module.exports.renderPreviewHtml = renderPreviewHtml;
module.exports.normalizeList = normalizeList;
