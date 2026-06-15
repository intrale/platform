// =============================================================================
// bloqueados.js — Vista SSR de la ventana "Bloqueados / Necesitan intervención
// humana" del dashboard V3 (`/bloqueados` legacy + `/dashboard?view=bloqueados`).
//
// Issue: #3729 (split de #3715 — extracción de la ventana Bloqueados del
// monolito `dashboard.js:2371-2439` + estilos `.needs-human-*` + handlers
// `needsHuman*`). Lista los issues donde un agente pidió intervención humana
// (`reportHumanBlock(...)`) o que tienen label `needs-human`.
//
// Estructura (patrón de las hermanas matriz.js / kpis.js / ops.js + contrato
// del issue + narrativa UX `narrativa-bloqueados-v3.md`):
//   - renderBloqueadosSsr(state)        → fragmento `<main id="view-content"
//                                          data-slug="bloqueados">` con las filas
//                                          renderizadas server-side (boundary del
//                                          router #3773). Lo embebe el monolito
//                                          legacy y el router cliente.
//   - renderBloqueadosClientScript()    → handlers `needsHumanReactivate`,
//                                          `needsHumanDismiss`,
//                                          `toggleNeedsHumanPanel` portados del
//                                          monolito (window.* para no romper los
//                                          onclick="" del SSR).
//   - renderBloqueados(state)           → documento SSR completo (shell satélite
//                                          + nav V3 + fragmento + script).
//   - slug                              → 'bloqueados' (clave de VIEW_SLUGS).
//
// Seguridad (CA-B3 / CA-D1 + comentario de security del issue):
//   - TODA interpolación dinámica pasa por escapeHtmlText (contexto texto) o
//     escapeHtmlAttr (contexto atributo: title="", aria-label="") de
//     lib/escape-html.js (#3722). NO se reusa el esc() global del monolito.
//   - `b.issue` se coacciona con safeIssueNumber() (Number.isInteger && > 0)
//     antes de interpolarse en href/onclick/aria-label. Si falla, la fila se
//     descarta silenciosamente (con warning server-side).
//
// Accesibilidad (CA-E1..E4): severidad dual-encoded (rail + pill con ícono +
// texto numérico de edad), aria-label en cada acción, prefers-reduced-motion.
// =============================================================================
'use strict';

const fs = require('fs');
const path = require('path');

// #3726 — Nav bar V3 unificada (renderNavTabsSsr + loadIconSprite del cache
// compartido del sprite.svg). Misma dependencia que home.js / matriz.js.
const { renderNavTabsSsr, loadIconSprite } = require('./nav-tabs');

// #3953 (EP8-H0) — Wrapper único de fetchJson (CA-2) + framework de modal de
// confirmación con preview (CA-3) que reemplaza confirm() nativo. nhCsrfHeaders
// se centraliza en FETCH_CLIENT_JS (R2).
const { FETCH_CLIENT_JS } = require('./fetch-client.js');
const { CONFIRM_MODAL_JS } = require('./confirm-modal.js');

// #3722 — Escape HTML server-side unificado (CA-B3). escapeHtmlText para
// contexto nodo-texto, escapeHtmlAttr para contexto atributo. Fallback inline
// (defense-in-depth) por si el require fallara en un checkout transitorio.
let escapeHtmlText, escapeHtmlAttr;
try {
    ({ escapeHtmlText, escapeHtmlAttr } = require('../../lib/escape-html.js'));
} catch {
    escapeHtmlText = (s) => (s == null ? '' : String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])));
    escapeHtmlAttr = (s) => (s == null ? '' : String(s).replace(/[&<>"'`]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' }[c])));
}

const THEME_CSS_PATH = path.join(__dirname, 'theme.css');
function loadTheme() {
    try { return fs.readFileSync(THEME_CSS_PATH, 'utf8'); } catch { return ''; }
}

const slug = 'bloqueados';

// Compat: las hermanas exportan `escapeHtmlSsr`. Delega en el helper compartido.
function escapeHtmlSsr(s) {
    return escapeHtmlText(s);
}

// CA-D1 — coerción numérica estricta de `b.issue` antes de interpolar en
// href/onclick/aria-label. Origen filesystem-controlled (bajo riesgo) pero la
// defensa en profundidad lo exige. Devuelve el entero positivo o null.
function safeIssueNumber(raw) {
    const n = Number(raw);
    return (Number.isInteger(n) && n > 0) ? n : null;
}

// Tres umbrales de severidad por edad (D2 de la narrativa UX):
//   fresh  < 4h   → info
//   warning 4-24h → warning
//   danger ≥ 24h  → danger
function severityOf(ageHours) {
    const h = Number(ageHours);
    if (!Number.isFinite(h)) return 'info';
    if (h >= 24) return 'danger';
    if (h >= 4) return 'warning';
    return 'info';
}

// Edad legible compacta: "47min" / "29h". Reusa la lógica del monolito.
function fmtAge(ageHours) {
    const h = Number(ageHours);
    if (!Number.isFinite(h) || h < 0) return '—';
    if (h < 1) return Math.max(1, Math.round(h * 60)) + 'min';
    return Math.round(h) + 'h';
}

// Tiempo relativo compacto para eventos (formateado server-side desde ISO).
// Sin Date.now() en el módulo: recibe el "ahora" como argumento (testeable).
function relTime(whenIso, nowMs) {
    if (!whenIso) return '';
    const t = Date.parse(whenIso);
    if (!t) return '';
    const min = Math.round((nowMs - t) / 60000);
    if (min < 1) return 'ahora';
    if (min < 60) return min + 'min';
    const hr = Math.round(min / 60);
    if (hr < 24) return hr + 'h';
    return Math.round(hr / 24) + 'd';
}

const REASON_MAX = 280;

// Una fila de issue bloqueado. Devuelve '' (fila descartada) si `b.issue` no
// coacciona a entero positivo (CA-D1). Todo dato externo escapado por contexto.
function renderRowSsr(b, nowMs) {
    const issueNum = safeIssueNumber(b && b.issue);
    if (issueNum === null) {
        try { console.warn(JSON.stringify({ event: 'bloqueados_row_discarded', reason: 'invalid_issue', ts: new Date(nowMs).toISOString() })); } catch { /* logger no debe romper el render */ }
        return '';
    }
    const sev = severityOf(b.age_hours);
    const ageTxt = fmtAge(b.age_hours);
    const titleTxt = (b.title == null) ? '' : String(b.title);
    const reasonRaw = (b.question || b.reason || '').toString();
    const reasonTxt = reasonRaw.slice(0, REASON_MAX);
    const reasonTrunc = reasonRaw.length > REASON_MAX;
    const summaryTxt = (b.summary || '').toString();
    const events = Array.isArray(b.recent_events) ? b.recent_events : [];

    const titleHtml = titleTxt
        ? ` — <span class="v3-bloqueados-title" title="${escapeHtmlAttr(titleTxt)}">${escapeHtmlText(titleTxt)}</span>`
        : '';

    const eventsHtml = events.length === 0 ? '' : (
        '<div class="v3-bloqueados-events needs-human-events">'
        + '<div class="v3-bloqueados-events-label needs-human-events-label">💬 Actividad reciente</div>'
        + '<ul class="v3-bloqueados-events-list needs-human-events-list">'
        + events.map(ev => '<li>'
            + `<span class="v3-bloqueados-ev-when nh-ev-when">${escapeHtmlText(relTime(ev && ev.when, nowMs))}</span> `
            + `<span class="v3-bloqueados-ev-author nh-ev-author">${escapeHtmlText((ev && ev.author) || '?')}</span>: `
            + `<span class="v3-bloqueados-ev-text nh-ev-text">${escapeHtmlText((ev && ev.preview) || '')}</span>`
            + '</li>').join('')
        + '</ul></div>'
    );

    const summaryHtml = summaryTxt
        ? `<div class="v3-bloqueados-summary needs-human-summary">📄 ${escapeHtmlText(summaryTxt)}</div>`
        : (b && b.summary_stale
            ? '<div class="v3-bloqueados-summary needs-human-summary needs-human-summary-loading">📄 <em>Cargando resumen funcional…</em></div>'
            : '');

    const skillPhase = (b.skill || b.phase)
        ? `<span class="v3-bloqueados-meta"> · ${escapeHtmlText(b.skill || '?')} en ${escapeHtmlText(b.phase || '?')}</span>`
        : '';

    return `<div class="v3-bloqueados-row needs-human-row v3-bloqueados-sev-${sev}" id="bloqueados-row-${issueNum}" data-issue="${issueNum}" data-severity="${sev}">
      <span class="v3-bloqueados-rail" aria-hidden="true"></span>
      <div class="v3-bloqueados-row-head needs-human-row-head">
        <div class="v3-bloqueados-row-info needs-human-row-info">
          <a href="https://github.com/intrale/platform/issues/${issueNum}" target="_blank" rel="noopener noreferrer"><b>#${issueNum}</b></a>${titleHtml}${skillPhase}
          <span class="v3-bloqueados-age v3-bloqueados-age-${sev}" title="${escapeHtmlAttr('Bloqueado hace ' + ageTxt + ' · severidad ' + sev)}" aria-label="${escapeHtmlAttr('Bloqueado hace ' + ageTxt)}">⏱ hace ${escapeHtmlText(ageTxt)}</span>
        </div>
        <div class="v3-bloqueados-row-actions needs-human-row-actions">
          <button class="v3-bloqueados-btn nh-btn nh-btn-reactivate" onclick="needsHumanReactivate(${issueNum})" title="${escapeHtmlAttr('Reactivar #' + issueNum + ': quita el label needs-human y devuelve el issue a la cola del pipeline')}" aria-label="${escapeHtmlAttr('Reactivar issue #' + issueNum)}">▶ Reactivar</button>
          <button class="v3-bloqueados-btn nh-btn nh-btn-dismiss" onclick="needsHumanDismiss(${issueNum})" title="${escapeHtmlAttr('Desestimar #' + issueNum + ': cierra el issue como no planificado y lo quita del panel')}" aria-label="${escapeHtmlAttr('Desestimar issue #' + issueNum)}">✕ Desestimar</button>
        </div>
      </div>
      ${summaryHtml}
      ${reasonTxt ? `<div class="v3-bloqueados-reason needs-human-reason">❓ ${escapeHtmlText(reasonTxt)}${reasonTrunc ? '…' : ''}</div>` : ''}
      ${eventsHtml}
    </div>`;
}

// Mini-stat del empty-state. Los valores numéricos llegan ya computados desde el
// state (opcionales); si faltan, "—". Todo escapado por defensa en profundidad.
function renderEmptyStatsSsr(stats) {
    const s = stats || {};
    const sla = (s.avgSla != null) ? String(s.avgSla) : '—';
    const resolved = (s.resolvedToday != null) ? String(s.resolvedToday) : '—';
    return '<div class="v3-bloqueados-empty-stats">'
        + `<div class="v3-bloqueados-empty-stat"><span class="v3-bloqueados-empty-stat-value">${escapeHtmlText(sla)}</span><span class="v3-bloqueados-empty-stat-label">SLA promedio</span></div>`
        + `<div class="v3-bloqueados-empty-stat"><span class="v3-bloqueados-empty-stat-value">${escapeHtmlText(resolved)}</span><span class="v3-bloqueados-empty-stat-label">Resueltos hoy</span></div>`
        + '</div>';
}

// Empty-state celebratorio (D5 de la narrativa UX). Reemplaza el string vacío
// del monolito: la ausencia de bloqueos es buen estado, no error.
function renderEmptyStateSsr(state) {
    const stats = state && state.bloqueadosStats;
    return '<section class="v3-bloqueados-empty" id="bloqueados-empty" role="status">'
        + '<div class="v3-bloqueados-empty-icon" aria-hidden="true">✓</div>'
        + '<div class="v3-bloqueados-empty-title">Nada esperando que alguien decida</div>'
        + '<div class="v3-bloqueados-empty-sub">El pipeline fluye sin intervención humana.</div>'
        + renderEmptyStatsSsr(stats)
        + '</section>';
}

/**
 * Fragmento SSR de la ventana Bloqueados. Devuelve `<main id="view-content"
 * data-slug="bloqueados">` con las filas renderizadas server-side. Lo embebe el
 * monolito legacy (en `matrixHTML`) y el router cliente (`?view=bloqueados`).
 *
 * @param {object} state — snapshot del pipeline. Lee `state.bloqueados` (array)
 *                         y `state.bloqueadosStats` (opcional, mini-stats).
 * @param {object} [opts] — { nowMs } para tests deterministas (default Date.now()).
 */
function renderBloqueadosSsr(state, opts) {
    const o = opts || {};
    const nowMs = Number.isFinite(o.nowMs) ? o.nowMs : Date.now();
    const list = Array.isArray(state && state.bloqueados) ? state.bloqueados : [];

    if (list.length === 0) {
        return '<main id="view-content" data-slug="bloqueados" class="v3-bloqueados-view">'
            + renderEmptyStateSsr(state)
            + '</main>';
    }

    const rows = list.map(b => renderRowSsr(b, nowMs)).filter(Boolean).join('');
    // Si TODAS las filas se descartaron por coerción (input corrupto), caer al
    // empty-state en vez de un panel vacío sin sentido.
    if (!rows) {
        return '<main id="view-content" data-slug="bloqueados" class="v3-bloqueados-view">'
            + renderEmptyStateSsr(state)
            + '</main>';
    }

    const count = list.filter(b => safeIssueNumber(b && b.issue) !== null).length;
    const badge = count > 99 ? '99+' : String(count);

    return '<main id="view-content" data-slug="bloqueados" class="v3-bloqueados-view">'
        + '<section class="matrix-section needs-human-panel v3-bloqueados-panel" id="bloqueados-humano" data-section="needs-human">'
        + '<h2 class="needs-human-header v3-bloqueados-header" id="bloqueados-header" onclick="toggleNeedsHumanPanel()" title="Click para colapsar o expandir el panel">'
        + '<span class="needs-human-pulse v3-bloqueados-pulse" aria-hidden="true">🚨</span>'
        + 'Necesitan intervención humana'
        + `<span class="needs-human-badge v3-bloqueados-badge">${escapeHtmlText(badge)}</span>`
        + '<span class="needs-human-chevron v3-bloqueados-chevron" aria-hidden="true">▼</span>'
        + '<a class="section-popout v3-bloqueados-popout" href="/dashboard?view=bloqueados" target="_blank" rel="noopener noreferrer" title="Abrir Bloqueados en ventana independiente" aria-label="Abrir Bloqueados en ventana independiente" onclick="event.stopPropagation()">↗</a>'
        + '</h2>'
        + '<div class="needs-human-body v3-bloqueados-body">'
        + '<div class="v3-bloqueados-list" id="bloqueados-list">' + rows + '</div>'
        + '<div class="v3-bloqueados-hint" id="bloqueados-hint">'
        + 'Desbloquear desde Telegram: <code>/unblock &lt;issue&gt; &lt;orientación&gt;</code> · o quitá el label <code>needs-human</code> en GitHub'
        + '</div>'
        + '</div>'
        + '</section>'
        + '</main>';
}

// Handlers del cliente portados del monolito (dashboard.js:7016-7101) — se
// exponen como window.* para que los onclick="" del SSR sigan funcionando en la
// página standalone (R3 del issue). NO se rediseñan en esta sub.
function renderBloqueadosClientScript() {
    return `
function nhDisableButtons(issueNum){
  document.querySelectorAll('.v3-bloqueados-row button[onclick*="(' + issueNum + ')"]').forEach(function(b){ b.disabled = true; });
}
function toggleNeedsHumanPanel(scrollOnExpand){
  var panel = document.getElementById('bloqueados-humano');
  if(!panel) return;
  var willCollapse = !panel.classList.contains('nh-collapsed');
  panel.classList.toggle('nh-collapsed');
  try { localStorage.setItem('nh-panel-collapsed', willCollapse ? '1' : '0'); } catch(e){}
  if(!willCollapse && scrollOnExpand){ panel.scrollIntoView({behavior:'smooth', block:'start'}); }
}
(function restoreNeedsHumanPanelState(){
  try {
    if(localStorage.getItem('nh-panel-collapsed') === '1'){
      var panel = document.getElementById('bloqueados-humano');
      if(panel) panel.classList.add('nh-collapsed');
    }
  } catch(e){}
})();
async function needsHumanReactivate(issueNum){
  if(!(await inConfirm({ title:'Reactivar issue', message:'Volverá a la cola del pipeline sin orientación adicional.', confirmLabel:'Reactivar', danger:false, preview:[{label:'Issue', value:'#'+issueNum}] }))) return;
  nhDisableButtons(issueNum);
  try {
    var r = await fetch('/api/needs-human/' + issueNum + '/reactivate', { method: 'POST', headers: nhCsrfHeaders() });
    var j = await r.json();
    if(j.ok) location.reload();
    else { alert('Error reactivando: ' + (j.msg || 'desconocido')); location.reload(); }
  } catch(e){ alert('Error reactivando: ' + e.message); location.reload(); }
}
async function needsHumanDismiss(issueNum){
  var reason = prompt('Motivo para desestimar #' + issueNum + ' (opcional):', '');
  if(reason === null) return;
  if(!(await inConfirm({ title:'Desestimar issue', message:'Se quitará del panel y quedará cerrado en GitHub.', confirmLabel:'Desestimar', preview:[{label:'Issue', value:'#'+issueNum},{label:'Motivo', value:(reason||'—')}] }))) return;
  nhDisableButtons(issueNum);
  try {
    var r = await fetch('/api/needs-human/' + issueNum + '/dismiss', {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, nhCsrfHeaders()),
      body: JSON.stringify({ reason: reason || '' })
    });
    var j = await r.json();
    if(j.ok){
      if(j.worktree && j.worktree_warning){
        var cleanWt = await inConfirm({ title:'Limpiar worktree', message:'Issue #' + issueNum + ' desestimado. El worktree tiene trabajo en disco. ¿Limpiarlo ahora?', confirmLabel:'Limpiar worktree', cancelLabel:'Conservar', preview:[{label:'Worktree', value:j.worktree}] });
        if(cleanWt){
          try {
            var rw = await fetch('/api/needs-human/' + issueNum + '/dismiss-worktree', { method: 'POST', headers: nhCsrfHeaders() });
            var jw = await rw.json();
            if(!jw.ok) alert('No pude limpiar el worktree: ' + (jw.msg || 'desconocido'));
          } catch(e){ alert('Error limpiando worktree: ' + e.message); }
        }
      }
      location.reload();
    } else { alert('Error desestimando: ' + (j.msg || 'desconocido')); location.reload(); }
  } catch(e){ alert('Error desestimando: ' + e.message); location.reload(); }
}
// nhCsrfHeaders() lo provee FETCH_CLIENT_JS (#3953) — centralizado para que
// todo POST destructivo adjunte X-CSRF-Token de forma uniforme (R2).
window.toggleNeedsHumanPanel = toggleNeedsHumanPanel;
window.needsHumanReactivate = needsHumanReactivate;
window.needsHumanDismiss = needsHumanDismiss;
`;
}

// Helpers mínimos del header satélite (reloj + pill modo), espejados de
// matriz.js::COMMON_HELPERS para que la página standalone sea autosuficiente.
const COMMON_HELPERS = `
function setText(id, value){ var el=document.getElementById(id); if(el && el.textContent!==String(value)) el.textContent=value; }
async function tickHeader(){
  var d = await fetchJson('/api/dash/header');
  if(!d) return;
  setText('hdr-clock', new Date().toLocaleTimeString('es-AR'));
  var modePill = document.getElementById('hdr-mode');
  if(modePill){
    modePill.classList.remove('in-mode-running','in-mode-paused','in-mode-partial');
    if(d.mode==='paused'){ modePill.classList.add('in-mode-paused'); modePill.textContent='⏸ Pausado'; }
    else if(d.mode==='partial_pause'){ modePill.classList.add('in-mode-partial'); modePill.textContent='⏸ Parcial'; }
    else { modePill.classList.add('in-mode-running'); modePill.textContent='🟢 Running'; }
  }
}
tickHeader();
setInterval(function(){ tickHeader().catch(function(){}); }, 5000);
`;

/**
 * Documento SSR completo de la ventana Bloqueados (shell satélite + nav V3 +
 * fragmento + script). Replica el patrón de matriz.js / kpis.js. Lo consume el
 * router cliente (`?view=bloqueados` y `/bloqueados`).
 *
 * @param {object} state — snapshot del pipeline (state.bloqueados).
 * @param {object} [opts] — { nowMs } para tests.
 */
function renderBloqueados(state, opts) {
    const theme = loadTheme();
    const spriteInline = loadIconSprite();
    const navHtml = renderNavTabsSsr(slug);
    const fragment = renderBloqueadosSsr(state, opts);
    return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Intrale · Bloqueados</title>
<style>${theme}</style>
<style>
.satellite-frame { max-width: 1600px; margin: 0 auto; padding: 0; }
.satellite-body { padding: 22px 28px; display: flex; flex-direction: column; gap: 18px; }
.in-mode-running { color: var(--in-ok); border-color: var(--in-ok); background: var(--in-ok-soft); }
.in-mode-paused { color: var(--in-bad); border-color: var(--in-bad); background: var(--in-bad-soft); }
.in-mode-partial { color: var(--in-warn); border-color: var(--in-warn); background: var(--in-warn-soft); }
</style>
</head>
<body>
<div aria-hidden="true" style="position:absolute;width:0;height:0;overflow:hidden">${spriteInline}</div>
<div class="satellite-frame">
  <header class="in-header">
    <div class="in-header-brand">
      <div class="in-header-logo">i</div>
      <div>
        <div class="in-header-title">Bloqueados</div>
        <div class="in-header-subtitle">Issues esperando intervención humana</div>
      </div>
    </div>
    <div class="in-header-meta">
      <span class="in-pill" id="hdr-mode">…</span>
      <span class="in-clock" id="hdr-clock">…</span>
    </div>
  </header>
  ${navHtml}
  <main class="satellite-body">${fragment}</main>
  <footer class="in-footer">
    <span>Refresh manual · acciones state-changing</span>
    <span>Intrale V3 · #3729</span>
  </footer>
</div>
<script>${FETCH_CLIENT_JS}\n${CONFIRM_MODAL_JS}\n${COMMON_HELPERS}\n${renderBloqueadosClientScript()}</script>
</body>
</html>`;
}

module.exports = {
    slug,
    renderBloqueadosSsr,
    renderBloqueadosClientScript,
    renderBloqueados,
    renderRowSsr,
    renderEmptyStateSsr,
    safeIssueNumber,
    severityOf,
    fmtAge,
    escapeHtmlSsr,
    loadTheme,
};
