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

// #5400 (rev-8) — Causas que ADMITEN autoría humana. Para el resto (ventana
// horaria, concurrencia, cooldown) la regla de copy 4 del mockup 47 manda omitir
// la línea: no hay nadie a quien atribuirle nada y escribir "autoría no
// registrada" ahí es ruido. Import defensivo: si el enum no carga, se cae a los
// literales del contrato (mismo valor, sin drift silencioso).
let CAUSAS_CON_AUTORIA;
try {
    const dc = require('./dispatch-cause');
    CAUSAS_CON_AUTORIA = new Set([dc.CAUSAS.HALT_HUMANO, dc.CAUSAS.MODO_OLA]);
} catch {
    CAUSAS_CON_AUTORIA = new Set(['halt_humano', 'modo_ola']);
}

/**
 * #5400 (rev-8) — Línea de AUTORÍA (SEC-2 + regla de copy 4 del mockup 47).
 *
 * El qualifier NO es decorativo: `getPipelineMode()` devuelve la autoría sin
 * verificar (el gate de autorización corre en GRACE MODE), así que mostrarla
 * pelada la presenta como un hecho auditado. "(sin verificar, desde 13:12)" es
 * la mitigación de SEC-2 hecha visible, y el "desde" es lo que le dice al
 * operador si la pausa es de hace 3 minutos o de anoche.
 *
 * Sin dato NUNCA se atribuye a una persona.
 */
function lineaAutoria(slice) {
    const autor = typeof slice.autoriaDeclarada === 'string' && slice.autoriaDeclarada.trim().length > 0
        ? slice.autoriaDeclarada.trim()
        : null;
    if (!autor) {
        return CAUSAS_CON_AUTORIA.has(slice.causa) ? 'autoría no registrada' : null;
    }
    const desde = slice.autoriaDesdeClock
        ? `sin verificar, desde ${escapeHtmlText(String(slice.autoriaDesdeClock))}`
        : 'sin verificar';
    return `autoría declarada: ${escapeHtmlText(autor)} (${desde})`;
}

/** Identidad del último despacho: "13:09 (hace 1 h 33 min) · #5388 pipeline-dev". */
function lineaUltimoDespacho(slice) {
    const rel = slice.lastDispatchRelTime
        ? escapeHtmlText(String(slice.lastDispatchRelTime))
        : null;
    if (!rel && !slice.lastDispatchClock) return 'Último despacho: sin registro';

    const partes = [];
    if (slice.lastDispatchClock) {
        partes.push(rel
            ? `${escapeHtmlText(String(slice.lastDispatchClock))} (${rel})`
            : escapeHtmlText(String(slice.lastDispatchClock)));
    } else {
        partes.push(rel);
    }
    // La estampa ya persiste issue/skill: sin ellos el operador no sabe si lo
    // último que salió era lo que esperaba o algo de otra ola.
    const quien = [];
    if (slice.lastDispatchIssue) quien.push(`#${escapeHtmlText(String(slice.lastDispatchIssue))}`);
    if (slice.lastDispatchSkill) quien.push(escapeHtmlText(String(slice.lastDispatchSkill)));
    if (quien.length > 0) partes.push(quien.join(' '));
    return `Último despacho: ${partes.join(' · ')}`;
}

/**
 * #5400 (rev-8) — Línea de BACKOFF (CA-4 visible en el dashboard).
 *
 * CA-4 exige backoff verificable. Hasta rev-7 sólo era verificable leyendo el
 * código o el canal de Telegram: el banner no decía ni que ya se había avisado
 * ni cuándo podía volver a avisar, así que el operador no podía distinguir "el
 * watchdog ya gritó" de "el watchdog está mudo".
 */
function lineaBackoff(slice) {
    const avisos = Number.isInteger(slice.avisosEmitidos) ? slice.avisosEmitidos : null;
    if (avisos != null && avisos > 0) {
        const partes = [];
        partes.push(slice.avisoUltimoClock
            ? `avisado a Telegram ${escapeHtmlText(String(slice.avisoUltimoClock))}`
            : 'avisado a Telegram');
        partes.push(slice.episodioId
            ? `aviso ${avisos} del episodio ${escapeHtmlText(String(slice.episodioId))}`
            : `aviso ${avisos} del episodio`);
        if (slice.avisoProximoClock) {
            partes.push(`próximo aviso no antes de ${escapeHtmlText(String(slice.avisoProximoClock))}`);
        }
        return partes.join(' · ');
    }
    // Todavía no se avisó: se anuncia CUÁNDO avisaría y con qué umbral, y se
    // aclara que el watchdog no destraba (SEC-3: nunca prometer lo que no hace).
    const umbral = Number.isInteger(slice.avisoUmbralMin) && slice.avisoUmbralMin > 0
        ? ` (umbral ${slice.avisoUmbralMin} min)`
        : '';
    if (Number.isInteger(slice.avisoEtaMin) && slice.avisoEtaMin > 0) {
        return `aviso a Telegram si sigue así en ${slice.avisoEtaMin} min${umbral} · el watchdog mira, no destraba`;
    }
    if (umbral) {
        return `umbral de aviso ${slice.avisoUmbralMin} min · el watchdog mira, no destraba`;
    }
    return null;
}

/** Conteo de elegibles esperando, en el copy del mockup ("7 issues elegibles esperando"). */
function lineaElegibles(slice) {
    const n = slice.elegiblesEsperando;
    if (!Number.isInteger(n) || n <= 0) return null;
    return n === 1 ? '1 issue elegible esperando' : `${n} issues elegibles esperando`;
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

    // #5400 (rev-8) — Línea de contexto del mockup 47 (A2/A3):
    //   autoría · elegibles esperando · último despacho + identidad
    // `detalle` sigue viajando en el tooltip del banner (`title=`): es texto
    // libre del gate y compite con el copy acordado por el mismo renglón.
    const contexto = [lineaAutoria(slice), lineaElegibles(slice), lineaUltimoDespacho(slice)]
        .filter(Boolean).join(' · ');
    const backoff = lineaBackoff(slice);

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
    let extra = '';
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
        // El título lleva la DURACIÓN en dos unidades ("hace 1 h 33 min"): es el
        // número por el que existe este issue y el mismo que sale por Telegram.
        title = `${grave ? 'Sin despachar' : 'Cola sin despachar'}${rel ? ` ${rel}` : ''} — ${label}`;
        body = contexto || detail || `Último despacho: ${dispatchRel}`;
        extra = backoff || '';
        mainIcon = icon('ic-dispatch-stalled', titleColor);
    }

    return `<div class="dispatch-cause-banner" id="dispatch-cause-banner" role="region" aria-label="Estado del watchdog de despacho" `
        + `style="display:flex;align-items:center;gap:12px;padding:12px 16px;margin:12px 0;border:1px solid ${border};border-left:4px solid ${border};border-radius:8px;background:${background}">`
        + mainIcon
        + `<div style="flex:1;min-width:0"><strong style="display:block;color:${titleColor}">${title}</strong>`
        + `<span style="font-size:12px;color:${COLORS.textSecondary}" title="${detailAttr}">${body}</span>`
        + (extra ? `<span class="dispatch-backoff-line" style="font-size:12px;color:${COLORS.textDim};display:block;margin-top:3px">${extra}</span>` : '')
        + `</div>${chip}</div>`;
}

module.exports = { renderDispatchCauseBanner };
