// =============================================================================
// issue-csv.js — Generación de CSV del listado de issues (#3958, EP8-H5, CA-6).
//
// Isomórfico (UMD): el MISMO código corre en Node (require → tests `node --test`)
// y en el browser (inyectado en el dashboard, expone `window.IssueCsv`). Así la
// lógica anti-injection se testea una sola vez y no diverge cliente/servidor.
//
// SEC-3 · CSV / Formula Injection (OWASP A03):
//   - Toda celda que empiece con `= + - @ \t \r` se neutraliza prefijando `'`,
//     para que Excel/Sheets no la interprete como fórmula al abrir el archivo.
//   - RFC 4180: comillas dobles escapadas (`"` → `""`) y campos con `,`/`"`/CR/LF
//     envueltos en comillas.
// =============================================================================

(function (root, factory) {
    'use strict';
    const api = factory();
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    } else {
        root.IssueCsv = api;
    }
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    // Caracteres iniciales que disparan fórmula en Excel/Sheets/LibreOffice.
    const FORMULA_LEAD = /^[=+\-@\t\r]/;
    // Caracteres que obligan a envolver el campo en comillas (RFC 4180).
    const NEEDS_QUOTE = /[",\n\r]/;

    /**
     * Sanea una celda para CSV seguro.
     * @param {*} v
     * @returns {string}
     */
    function sanitizeCell(v) {
        let s = v === null || v === undefined ? '' : String(v);
        // 1) Neutralizar formula injection ANTES de cualquier quoting.
        if (FORMULA_LEAD.test(s)) s = "'" + s;
        // 2) RFC 4180: escapar comillas y envolver si hace falta.
        if (NEEDS_QUOTE.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
        return s;
    }

    /**
     * Genera el contenido CSV.
     * @param {Array<Object>} rows  - filas como objetos { columnKey: value }.
     * @param {Array<{key:string,label?:string}>|string[]} columns - columnas a emitir,
     *        en orden. Puede ser array de strings (key=label) o de {key,label}.
     * @returns {string} CSV con header + filas, separadas por CRLF (RFC 4180).
     */
    function toCsv(rows, columns) {
        const cols = (columns || []).map(c => (typeof c === 'string' ? { key: c, label: c } : { key: c.key, label: c.label || c.key }));
        const header = cols.map(c => sanitizeCell(c.label)).join(',');
        const body = (rows || []).map(row =>
            cols.map(c => sanitizeCell(row ? row[c.key] : '')).join(',')
        );
        return [header].concat(body).join('\r\n');
    }

    return { sanitizeCell, toCsv };
});
