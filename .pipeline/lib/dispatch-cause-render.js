'use strict';

// Render del estado de despacho acordado en mockup 47 (#5400). Los textos que
// llegan del filesystem no son confiables y se escapan antes de insertarlos.
const { escapeHtmlText, escapeHtmlAttr } = require('./escape-html');

// Los fallbacks preservan el render si los tokens todavia no cargaron; la
// fuente de verdad visual es assets/design-tokens.css.
const COLORS = Object.freeze({
    surface: 'var(--surface-1, #161B22)',
    borderSubtle: 'var(--border-subtle, #21262D)',
    textSecondary: 'var(--text-secondary, #B1BAC4)',
    textDim: 'var(--text-dim, #8B949E)',
    success: 'var(--success, #3FB950)',
    warning: 'var(--warning, #D29922)',
    warningBg: 'var(--warning-bg, rgba(210, 153, 34, 0.14))',
    danger: 'var(--danger, #F85149)',
    dangerBg: 'var(--danger-bg, rgba(248, 81, 73, 0.14))',
});

function icon(id, color, size = 24) {
    return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true" focusable="false" style="color:${color};flex:none"><use href="#${id}"></use></svg>`;
}

function renderDispatchCauseBanner(slice) {
    if (!slice || slice.active !== true) return '';

    const soloWatchdog = !slice.causa;
    const sano = soloWatchdog && slice.watchdogDegraded === false;
    const degradado = soloWatchdog && !sano;
    const grave = !soloWatchdog && (slice.anomalia === true || slice.escaladoPorDuracion === true);
    const border = sano ? COLORS.borderSubtle : (grave ? COLORS.danger : COLORS.warning);
    const background = sano ? COLORS.surface : (grave ? COLORS.dangerBg : COLORS.warningBg);
    const titleColor = sano ? COLORS.textSecondary : (grave ? COLORS.danger : COLORS.warning);

    const label = escapeHtmlText(slice.label || slice.causa || '');
    const detail = slice.detalle ? escapeHtmlText(slice.detalle) : '';
    const detailAttr = escapeHtmlAttr(slice.detalle || slice.label || slice.causa || '');
    const rel = slice.relTime ? escapeHtmlText(slice.relTime) : '';
    const dispatchRel = slice.lastDispatchRelTime ? escapeHtmlText(slice.lastDispatchRelTime) : 'sin registro';

    let watchdogText = 'watchdog: estado no consta';
    if (slice.watchdogDegraded === false) watchdogText = 'watchdog activo';
    if (slice.watchdogDegraded === true) {
        watchdogText = slice.watchdogReason === 'apagado'
            ? 'watchdog OFF — nadie vigila el despacho'
            : `watchdog degradado — ${escapeHtmlText(slice.watchdogReason || 'estado no confiable')}`;
    }
    const watchdogColor = slice.watchdogDegraded === false ? COLORS.success : COLORS.warning;
    const watchdogIcon = slice.watchdogDegraded === true ? 'ic-watchdog-off' : 'ic-health-ok';
    const chip = `<span class="dispatch-watchdog-chip" style="display:inline-flex;align-items:center;gap:6px;padding:4px 10px;border:1px solid ${watchdogColor};border-radius:999px;color:${watchdogColor};font-size:12px;font-weight:600;white-space:nowrap">${icon(watchdogIcon, watchdogColor, 18)}${watchdogText}</span>`;

    let title;
    let body;
    let mainIcon;
    if (sano) {
        title = 'Cola sin trabajo elegible';
        body = `Último despacho: ${dispatchRel} · nada que despachar no es una falla`;
        mainIcon = icon('ic-health-ok', COLORS.success);
    } else if (degradado) {
        title = watchdogText;
        body = `Último despacho: ${dispatchRel} · el control no puede confirmar la salud del despacho`;
        mainIcon = icon('ic-watchdog-off', COLORS.warning);
    } else {
        title = `${grave ? 'Sin despachar' : 'Cola sin despachar'}${rel ? ` ${rel}` : ''} — ${label}`;
        body = detail || `Último despacho: ${dispatchRel}`;
        mainIcon = icon('ic-dispatch-stalled', titleColor);
    }

    return `<div class="dispatch-cause-banner" id="dispatch-cause-banner" role="region" aria-label="Estado del watchdog de despacho" `
        + `style="display:flex;align-items:center;gap:12px;padding:12px 16px;margin:12px 0;border:1px solid ${border};border-left:4px solid ${border};border-radius:8px;background:${background}">`
        + mainIcon
        + `<div style="flex:1;min-width:0"><strong style="display:block;color:${titleColor}">${title}</strong>`
        + `<span style="font-size:12px;color:${COLORS.textSecondary}" title="${detailAttr}">${body}</span>`
        + (!sano && !degradado && detail ? `<span style="font-size:12px;color:${COLORS.textDim};display:block;margin-top:3px">Último despacho: ${dispatchRel}</span>` : '')
        + `</div>${chip}</div>`;
}

module.exports = { renderDispatchCauseBanner };
