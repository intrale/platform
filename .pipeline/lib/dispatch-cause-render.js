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

// #5400 (rev-11) — Nombres legibles de la causa clasificada por el watchdog.
// Se REUSA el catálogo de `wave-stall-watchdog` (el mismo que arma el mensaje de
// Telegram) para que banner y aviso no puedan divergir — regla de copy 7. Import
// defensivo: si el módulo no carga, el banner se queda sin nombre pero no
// inventa uno ni se cae.
let WD_CAUSE_LABELS;
try {
    WD_CAUSE_LABELS = require('./wave-stall-watchdog').CAUSE_LABELS || {};
} catch {
    WD_CAUSE_LABELS = {};
}

// Nombre humano de un `causeKind` del watchdog, o `null` si no consta. Nunca
// devuelve un placeholder optimista: sin dato, el copy dice "sin causa
// declarada", que es la verdad.
function nombreCausaWatchdog(causeKind) {
    if (typeof causeKind !== 'string' || causeKind.length === 0) return null;
    const label = WD_CAUSE_LABELS[causeKind];
    return typeof label === 'string' && label.length > 0 ? label : causeKind;
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

// #5400 (rev-12) — Umbral de gravedad por defecto cuando el watchdog no reporta
// el suyo. Mismo valor que `DEFAULT_SILENT_ESCALATE_MS` del módulo de causa (45
// min): no se inventa una constante nueva para el mismo concepto.
const UMBRAL_GRAVEDAD_FALLBACK_MS = 45 * 60 * 1000;

/**
 * #5400 (rev-12, BLOQUEANTE PO) — ¿La detención ya es SOSPECHOSA (A3) o todavía
 * está EXPLICADA (A2)?
 *
 * La sección A del mockup 47 separa A2 de A3 por una sola pregunta: ¿la
 * detención dejó de estar "por debajo del umbral" TENIENDO trabajo esperando?
 *   · A2 SILENCIO EXPLICADO  — causa declarada, todavía bajo umbral → ÁMBAR
 *   · A3 SILENCIO SOSPECHOSO — causa vieja + elegibles esperando    → ROJO
 *
 * Hasta rev-11 el rojo dependía de `escaladoPorDuracion`, que `dispatch-cause`
 * calcula SÓLO para causas silenciosas (`esSilenciosa = !anomalia &&
 * !CAUSAS_ALERTABLES.has(causa)`). `halt_humano` ESTÁ en `CAUSAS_ALERTABLES`, así
 * que el flag era falso POR CONSTRUCCIÓN: una pausa total con 7 elegibles
 * esperando pintaba el MISMO ámbar a los 12 min que a las 8 h. Es el defecto del
 * propio issue una capa más arriba — 1 h 33 min pasando desapercibidos.
 * El otro camino (sólo-watchdog) ataba el rojo a `action === 'escalate'`, que con
 * el backoff 30→60→120→240 cae en ticks AISLADOS: 3 de 481 minutos en rojo.
 *
 * La severidad ahora deriva de lo que el operador necesita para triar SIN LEER:
 * hace cuánto que no despacha CON trabajo esperando. Dos señales, las dos ya
 * expuestas por el slice y ninguna atada al tick instantáneo.
 */
function detencionSostenida(slice) {
    // 1. El watchdog YA avisó por este episodio. Por contrato sólo alerta con
    //    trabajo elegible esperando, así que es A3 por definición del mockup
    //    ("avisado a Telegram 14:45 · aviso 1 del episodio 4f2a").
    if (Number.isInteger(slice.avisosEmitidos) && slice.avisosEmitidos > 0) return true;

    // 2. Sin aviso registrado manda el reloj — pero sólo si CONSTA que hay
    //    trabajo esperando: con la cola vacía nunca se pinta rojo (mockup A1).
    //    Ausencia de dato no habilita la escalada.
    const elegibles = slice.elegiblesEsperando;
    if (!Number.isInteger(elegibles) || elegibles <= 0) return false;

    const stalledMs = Number.isFinite(slice.lastDispatchAgeMs) ? slice.lastDispatchAgeMs : null;
    if (stalledMs == null) return false;

    // El umbral es el DEL PROPIO WATCHDOG (el mismo que anuncia la línea de
    // backoff), para que banner y aviso no puedan discrepar (regla de copy 7).
    const umbralMs = Number.isInteger(slice.avisoUmbralMin) && slice.avisoUmbralMin > 0
        ? slice.avisoUmbralMin * 60000
        : UMBRAL_GRAVEDAD_FALLBACK_MS;
    return stalledMs >= umbralMs;
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
    // #5400 (rev-10) — El SILENCIO SANO se decide con `healthySilence`, NO con
    // `watchdogDegraded === false`.
    //
    // `watchdogDegraded === false` sólo dice que el WATCHDOG está sano; no dice
    // nada del pipeline. Un watchdog perfectamente vivo que está ALERTANDO por
    // detención sin causa declarada caía igual en esta rama, y el banner pintaba
    // en verde "nada que despachar no es una falla" en el mismo instante en que
    // Telegram avisaba "0 despacho hace 3 h, 9 issue(s) esperando". Es la misma
    // regresión que rev-6 (S1/B3) arregló en la slice, sobreviviendo una capa más
    // arriba porque el render nunca leía el campo corregido.
    //
    // `healthySilence` (dashboard-slices.js) exige las DOS cosas: watchdog no
    // degradado Y última decisión observada `skip`. Sin dato NO se afirma salud.
    const sano = soloWatchdog && slice.healthySilence === true;
    // Degradación del CONTROL (OFF, sin latido, reloj degradado o estado no
    // consta): manda sobre todo lo demás, porque nada de lo que informe es
    // confiable.
    const degradado = soloWatchdog && !sano && slice.watchdogDegraded !== false;
    // Watchdog sano y ALERTANDO: el parado es el pipeline, y encima nadie declaró
    // la causa. El banner tiene que contar el mismo episodio que Telegram.
    const detenidoSinCausa = soloWatchdog && !sano && !degradado
        && (slice.watchdogAction === 'alert' || slice.watchdogAction === 'escalate');
    // #5400 (rev-11, BLOQUEANTE 1) — Watchdog sano, en `skip`, pero el silencio
    // NO es sano: hay trabajo esperando y el pipeline no despacha. Es el estado
    // que antes se pintaba en verde. Se separa de `sinDecision` porque acá SÍ
    // hay decisión registrada y su razón alcanza para contar qué pasa:
    //   · `cooldown`           → ya se alertó, sigue parado, backoff corriendo
    //   · `declared-cause:*`   → hay una pausa declarada, con nombre
    //   · `within-threshold`   → parado, todavía por debajo del umbral
    const detenidoEnSkip = soloWatchdog && !sano && !degradado && !detenidoSinCausa
        && slice.watchdogAction === 'skip'
        && typeof slice.watchdogDecisionReason === 'string'
        && slice.watchdogDecisionReason.length > 0;
    // Watchdog sano pero sin decisión observada: no se afirma ni salud ni falla.
    const sinDecision = soloWatchdog && !sano && !degradado && !detenidoSinCausa
        && !detenidoEnSkip;
    // #5400 (rev-12) — `sano` (A1) y `degradado` (A4) tienen color propio en el
    // mockup y no escalan a rojo. Para todo lo demás —que es "el pipeline está
    // parado"— la gravedad la decide `detencionSostenida`, no el tick actual.
    const grave = !sano && !degradado
        && ((!soloWatchdog && (slice.anomalia === true || slice.escaladoPorDuracion === true))
            || (detenidoSinCausa && slice.watchdogAction === 'escalate')
            || detencionSostenida(slice));
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
    } else if (detenidoSinCausa) {
        // Estado "detención" del mockup 47 (icono `ic-dispatch-stalled` + duración
        // desde el último despacho), con el label que corresponde cuando el
        // artifact de causa no existe: nadie declaró por qué está parado.
        // La duración sale de la MISMA estampa que mide el watchdog, así que el
        // banner y Telegram no pueden divergir (regla de copy 7).
        // #5400 (rev-11) — Si el watchdog CLASIFICÓ la causa, el banner la
        // nombra. Antes decía siempre "sin causa declarada" aunque el Pulpo ya
        // hubiera escrito `causeKind`, así que Telegram nombraba la pausa y el
        // dashboard la negaba sobre el mismo episodio (rompía CA-6 y la regla de
        // copy 7). Sin dato se mantiene el texto honesto.
        const causaWd = nombreCausaWatchdog(slice.watchdogCauseKind);
        title = `${grave ? 'Sin despachar' : 'Cola sin despachar'}`
            + `${slice.lastDispatchRelTime ? ` ${dispatchRel}` : ''} — `
            + `${causaWd ? escapeHtmlText(causaWd) : 'sin causa declarada'}`;
        body = contexto || detail || `Último despacho: ${dispatchRel}`;
        extra = backoff || '';
        mainIcon = icon('ic-dispatch-stalled', titleColor);
    } else if (detenidoEnSkip) {
        // #5400 (rev-11, BLOQUEANTE 1) — El pipeline está parado con trabajo
        // esperando y el watchdog decidió no actuar. NUNCA en verde: el motivo
        // del `skip` es información de diagnóstico, no un certificado de salud.
        const reason = slice.watchdogDecisionReason;
        const causaWd = nombreCausaWatchdog(slice.watchdogCauseKind);
        let motivo;
        if (reason === 'cooldown') {
            // El caso más peligroso: con backoff 30→60→120 min y tick de 1 min,
            // el watchdog pasa la mayoría de los ticks de un episodio largo acá.
            // El operador tiene que ver que la detención SIGUE, no un verde.
            motivo = causaWd
                ? `${escapeHtmlText(causaWd)} — aviso ya emitido`
                : 'aviso ya emitido, la detención continúa';
        } else if (typeof reason === 'string' && reason.startsWith('declared-cause:')) {
            motivo = causaWd
                ? escapeHtmlText(causaWd)
                : `causa declarada: ${escapeHtmlText(reason.slice('declared-cause:'.length))}`;
        } else if (reason === 'within-threshold') {
            // #5400 (rev-12, divergencia secundaria PO) — A2 del mockup NOMBRA la
            // causa ("Pausa total del pipeline"), no sólo el estado del umbral.
            // `watchdogCauseKind` ya viajaba en el slice y se tiraba a la basura,
            // así que el banner decía menos que el dato que tenía a mano.
            motivo = causaWd
                ? `${escapeHtmlText(causaWd)} — todavía dentro del umbral de vigilancia`
                : 'todavía dentro del umbral de vigilancia';
        } else {
            motivo = causaWd ? escapeHtmlText(causaWd) : 'sin causa declarada';
        }
        // #5400 (rev-12) — El prefijo sigue a la severidad igual que en las otras
        // ramas: A3 abre con "Sin despachar" (mockup), A2 con "Cola sin despachar".
        title = `${grave ? 'Sin despachar' : 'Cola sin despachar'}`
            + `${slice.lastDispatchRelTime ? ` ${dispatchRel}` : ''} — ${motivo}`;
        body = contexto || detail || `Último despacho: ${dispatchRel}`;
        extra = backoff || '';
        mainIcon = icon('ic-dispatch-stalled', titleColor);
    } else if (sinDecision) {
        // El watchdog está vivo pero su último tick no dejó decisión registrada:
        // no consta si despachó, si está esperando o si está por alertar.
        // Prohibido rellenar el hueco con un OK inventado (mismo meta-bug de #5400).
        title = 'Estado del despacho sin confirmar';
        body = `Último despacho: ${dispatchRel} · el watchdog no registró su última decisión`;
        extra = backoff || '';
        mainIcon = icon('ic-dispatch-stalled', titleColor);
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
