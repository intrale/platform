'use strict';

// =============================================================================
// dispatch-cause-render.js — Render server-side del banner de causa declarada
// del no-despacho (#4709). Extraído de `dashboard.js` para ser TESTEABLE con
// `node --test` (patrón espejo de `lib/wave-audit-renderer.js`).
//
// SEGURIDAD (AC-4/AC-6, stored XSS): el slice `dispatchCauseSlice` entrega
// `label`/`detalle` CRUDOS (pueden arrastrar títulos/labels de issues
// controlables por terceros). Este render los ESCAPA SIEMPRE con
// `escapeHtmlText`/`escapeHtmlAttr` (lib/escape-html.js) antes de inyectarlos en
// el HTML — nunca innerHTML crudo.
// =============================================================================

const { escapeHtmlText, escapeHtmlAttr } = require('./escape-html');

/**
 * Renderiza el banner HTML de la causa declarada del no-despacho.
 *
 * @param {object|null} slice — salida de `dashboardSlices.dispatchCauseSlice`.
 *   `{ active, causa, label, detalle, anomalia, relTime }`.
 * @returns {string} HTML escapado, o '' si no hay causa activa (cola
 *   despachando / vacía) → el banner no se muestra.
 */
function renderDispatchCauseBanner(slice) {
    if (!slice || slice.active !== true) return '';
    // #5400 — el banner ahora también aparece SIN causa cuando el watchdog está
    // apagado o sin latir (SEC-5): la ausencia de alerta no puede seguir siendo
    // indistinguible de "todo OK".
    const soloWatchdog = !slice.causa;
    if (soloWatchdog && slice.watchdogDegraded !== true) return '';

    const esAnomalia = slice.anomalia === true;
    // #5400 — una causa que ya escaló por duración se destaca como la anomalía:
    // dejó de ser un estado esperado.
    const esGrave = esAnomalia || slice.escaladoPorDuracion === true || soloWatchdog;
    // UX-2: lo grave se destaca en color de alerta; una causa "normal" usa el
    // color ámbar de estado del sistema.
    const borde = esGrave ? '#f85149' : '#d29922';
    const fondo = esGrave ? 'rgba(248,81,73,0.10)' : 'rgba(210,153,34,0.10)';
    const titColor = esGrave ? '#ff7b72' : '#e3b341';
    const icono = esGrave ? '⚠️' : '⏸️';

    const label = escapeHtmlText(slice.label || slice.causa || '');
    const detalle = slice.detalle ? escapeHtmlText(slice.detalle) : '';
    const rel = slice.relTime ? escapeHtmlText(slice.relTime) : '';
    const titAttr = escapeHtmlAttr(slice.detalle || slice.label || slice.causa || '');

    const detHTML = detalle
        ? `<span style="font-size:12px;color:#cbd5e1" title="${titAttr}">${detalle}</span>`
        : '';
    const relHTML = rel
        ? `<span style="font-size:11px;color:#8b949e;margin-left:6px">· ${rel}</span>`
        : '';

    // #5400 / CA-6 — tiempo desde el último despacho efectivo. Es el dato que
    // faltaba el 2026-08-02: "hace cuánto que no sale trabajo".
    const dispRel = slice.lastDispatchRelTime ? escapeHtmlText(slice.lastDispatchRelTime) : null;
    const dispHTML = `<span style="font-size:12px;color:#8b949e;display:block;margin-top:4px">`
        + `Último despacho: ${dispRel || 'sin registro'}</span>`;

    // #5400 / SEC-5 — estado explícito del control. `null` = no consta: se dice
    // así, no se inventa un "OK".
    let wdTxt;
    if (slice.watchdogDegraded === true) {
        wdTxt = `⚠️ watchdog de despacho ${escapeHtmlText(slice.watchdogReason || 'degradado')}`;
    } else if (slice.watchdogDegraded === false) {
        wdTxt = 'watchdog de despacho activo';
    } else {
        wdTxt = 'watchdog de despacho: estado no consta';
    }
    const wdColor = slice.watchdogDegraded === true ? '#ff7b72' : '#8b949e';
    const wdHTML = `<span style="font-size:11px;color:${wdColor};display:block;margin-top:2px">${wdTxt}</span>`;

    const titulo = soloWatchdog
        ? 'Control de despacho degradado'
        : `Cola sin despachar — ${label}${relHTML}`;

    return `<div class="dispatch-cause-banner" id="dispatch-cause-banner" role="region" aria-label="Causa declarada del no-despacho de la cola" `
        + `style="display:flex;align-items:flex-start;gap:12px;padding:12px 16px;margin:12px 0;border:1px solid ${borde};border-radius:8px;background:${fondo}">`
        + `<span aria-hidden="true" style="font-size:20px;line-height:1.2">${icono}</span>`
        + `<div style="flex:1;min-width:0">`
        + `<strong style="display:block;color:${titColor}">${titulo}</strong>`
        + detHTML
        + dispHTML
        + wdHTML
        + `</div></div>`;
}

module.exports = { renderDispatchCauseBanner };
