// =============================================================================
// issue-filters.js — Filtros de la vista tabla del Issue Tracker (#3958, CA-3).
//
// Isomórfico (UMD): corre en Node (require → tests `node --test`) y en el browser
// (inyectado en el dashboard, expone `window.IssueFilters`).
//
// SEC-1 · XSS reflejado vía filtros en URL (OWASP A03):
//   Al hidratar desde `location.search`, cada filtro de enum (estado/fase/skill)
//   se valida contra un ALLOWLIST de valores conocidos; los valores no
//   reconocidos se DESCARTAN (no se reflejan). El texto libre `q` se devuelve
//   crudo pero NUNCA debe concatenarse a innerHTML sin escapeHtml — eso es
//   responsabilidad del consumidor (el dashboard usa escapeHtmlText/Attr).
//
// SEC-4: la re-hidratación post-DOM-morphing vuelve a pasar por parseFilters,
//   así un filtro inválido inyectado entre refreshes nunca se cuela.
// =============================================================================

(function (root, factory) {
    'use strict';
    const api = factory();
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    } else {
        root.IssueFilters = api;
    }
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    // Claves de enum (validadas contra allowlist) y su param en la URL.
    const ENUM_KEYS = ['estado', 'fase', 'skill'];
    // Límite defensivo para el texto libre (evita URLs gigantes y DoS de DOM).
    const Q_MAX_LEN = 120;

    /**
     * Lee un valor de un objeto tipo URLSearchParams o de un objeto plano.
     */
    function readParam(params, key) {
        if (!params) return null;
        if (typeof params.get === 'function') return params.get(key);
        if (Object.prototype.hasOwnProperty.call(params, key)) return params[key];
        return null;
    }

    /**
     * Parsea y VALIDA filtros desde search params.
     * @param {URLSearchParams|Object|string} searchParams
     * @param {{estados?:string[],fases?:string[],skills?:string[]}} allow - allowlists.
     * @returns {{estado:string,fase:string,skill:string,q:string}} filtros saneados.
     */
    function parseFilters(searchParams, allow) {
        let params = searchParams;
        if (typeof searchParams === 'string') {
            try { params = new URLSearchParams(searchParams); }
            catch (_) { params = {}; }
        }
        const allowed = {
            estado: new Set((allow && allow.estados) || []),
            fase: new Set((allow && allow.fases) || []),
            skill: new Set((allow && allow.skills) || []),
        };
        const out = { estado: '', fase: '', skill: '', q: '' };
        for (const key of ENUM_KEYS) {
            const raw = readParam(params, key);
            if (raw == null || raw === '') continue;
            const val = String(raw);
            // SEC-1: descartar lo que no esté en el allowlist.
            if (allowed[key].has(val)) out[key] = val;
        }
        const rawQ = readParam(params, 'q');
        if (rawQ != null) {
            // Texto libre: recortar longitud y normalizar; el escape para DOM lo
            // hace el consumidor (no acá, para no romper el valor de búsqueda).
            out.q = String(rawQ).slice(0, Q_MAX_LEN).trim();
        }
        return out;
    }

    /**
     * Serializa filtros a query string estable (orden fijo; sólo claves con valor).
     * @param {{estado?:string,fase?:string,skill?:string,q?:string}} filtros
     * @returns {string} ej. "estado=trabajando&skill=qa&q=foo" (sin '?').
     */
    function serializeFilters(filtros) {
        const f = filtros || {};
        const parts = [];
        for (const key of ENUM_KEYS) {
            if (f[key]) parts.push(key + '=' + encodeURIComponent(f[key]));
        }
        if (f.q) parts.push('q=' + encodeURIComponent(String(f.q).slice(0, Q_MAX_LEN)));
        return parts.join('&');
    }

    /**
     * ¿Hay algún filtro activo?
     */
    function hasActiveFilters(filtros) {
        const f = filtros || {};
        return !!(f.estado || f.fase || f.skill || f.q);
    }

    return { parseFilters, serializeFilters, hasActiveFilters, ENUM_KEYS, Q_MAX_LEN };
});
