// V3 Matriz — ventana central del operador: panel "Necesitan intervención
// humana" + Board Kanban del pipeline. Extraída del monolito `dashboard.js`
// (#3731, padre #3715 — rediseño UX integral del dashboard V3).
//
// Decisión D1 (Opción B — handoff por params): `dashboard.js` sigue siendo
// el dueño de los builders del Board Kanban (`lanesHTML`/`doneLaneHTML`/
// `activeIssues`/`completedIssues`/`sorted`, que dependen de helpers locales
// como fmtDuration/etaLib/AGENT_PERSONA/skillIcon/skillColor/manualOrderState)
// y se los pasa como argumentos a `renderMatrizSsr(...)`. Esta vista NO los
// reconstruye — sólo arma el HTML del shell. La consolidación interna queda
// como sub-historia futura del split.
//
// Decisión D4 (#3758 fuera de scope): los inline handlers state-changing
// `onclick="needsHumanReactivate(<int>)"` / `onclick="needsHumanDismiss(<int>)"`
// y los `confirm()`/`prompt()` que disparan POST /api/needs-human/<n>/* viven
// en el bundle JS servido por `/js/dashboard.js`. Se PRESERVAN tal cual; su
// migración a addEventListener + data-attrs es trabajo de #3758. Cuando aterrice
// CSP `script-src 'self'` (#3688) estos onclick morirán — ver inventario.
//
// Decisión D5 (#3722 ya en main): escape HTML server-side vía el helper
// unificado `lib/escape-html.js` (cierra #2901). CERO escape inline duplicado.

'use strict';

const fs = require('fs');
const path = require('path');

// #3722 — Escape HTML server-side unificado. `escapeHtmlText` para contexto
// de CONTENIDO de elemento (& < >); `escapeHtmlAttr` para VALORES DE ATRIBUTO
// (& < > " ' `), que es donde interpolamos los tooltips `title="..."`.
const { escapeHtmlText, escapeHtmlAttr } = require('../../lib/escape-html.js');

const THEME_CSS_PATH = path.join(__dirname, 'theme.css');
function loadTheme() {
    try { return fs.readFileSync(THEME_CSS_PATH, 'utf8'); } catch { return ''; }
}

// CA-4 / R4 — `b.issue` se interpola en el href de GitHub Y en los inline
// handlers `onclick="needsHumanReactivate(${id})"`. Coerce a entero positivo
// seguro; si no lo es (string con `javascript:`, NaN, negativo), devuelve null
// y la fila se OMITE (no se renderiza). Esto cierra el vector de inyección en
// URL/handler señalado por el análisis de seguridad.
function safeIssueId(raw) {
    const n = Number(raw);
    return Number.isInteger(n) && n > 0 ? n : null;
}

// Tiempo relativo compacto para los eventos: "12h", "3d", "ahora". Copia
// verbatim del helper inline que vivía en dashboard.js (sin cambios de
// comportamiento). Usa Date.now()/Date.parse — runtime del dashboard.
function relTime(whenIso) {
    if (!whenIso) return '';
    const t = Date.parse(whenIso);
    if (!t) return '';
    const diffMs = Date.now() - t;
    const min = Math.round(diffMs / 60000);
    if (min < 1) return 'ahora';
    if (min < 60) return `${min}min`;
    const hr = Math.round(min / 60);
    if (hr < 24) return `${hr}h`;
    const d = Math.round(hr / 24);
    return `${d}d`;
}

// Sub-panel A — "Necesitan intervención humana". Itera `bloqueados`
// (state.bloqueados): cada fila es un issue trabado esperando decisión humana.
// Devuelve '' si no hay bloqueados (no renderiza #bloqueados-humano).
function renderBloqueadosHTML(bloqueados) {
    const list = Array.isArray(bloqueados) ? bloqueados : [];
    if (list.length === 0) return '';

    const rows = list.map(b => {
        // CA-4 — fila omitida si el issue id no es un entero positivo seguro.
        const issueId = safeIssueId(b && b.issue);
        if (issueId === null) return '';

        const ageHours = Number(b.age_hours) || 0;
        const ageStr = ageHours < 1
            ? Math.max(1, Math.round(ageHours * 60)) + 'min'
            : Math.round(ageHours) + 'h';
        const ageCls = ageHours >= 4 ? 'needs-human-age-old' : 'needs-human-age-fresh';
        const titleHtml = b.title
            ? ` — <span style="color:var(--dim)">${escapeHtmlText(b.title)}</span>`
            : '';
        const reasonTxt = (b.question || b.reason || '').toString();
        const summaryTxt = (b.summary || '').toString();
        const events = Array.isArray(b.recent_events) ? b.recent_events : [];

        const eventsHtml = events.length === 0 ? '' : `
            <div class="needs-human-events">
              <div class="needs-human-events-label">📜 Actividad reciente</div>
              <ul class="needs-human-events-list">
                ${events.map(ev => `<li><span class="nh-ev-when">${escapeHtmlText(relTime(ev.when))}</span> <span class="nh-ev-author">${escapeHtmlText(ev.author || '?')}</span>: <span class="nh-ev-text">${escapeHtmlText(ev.preview || '')}</span></li>`).join('')}
              </ul>
            </div>`;
        const summaryHtml = summaryTxt
            ? `<div class="needs-human-summary">📄 ${escapeHtmlText(summaryTxt)}</div>`
            : (b.summary_stale ? `<div class="needs-human-summary needs-human-summary-loading">📄 <em>Cargando resumen funcional…</em></div>` : '');

        return `<div class="needs-human-row">
            <div class="needs-human-row-head">
              <div class="needs-human-row-info">
                <a href="https://github.com/intrale/platform/issues/${issueId}" target="_blank" rel="noopener noreferrer"><b>#${issueId}</b></a>${titleHtml}
                <span style="color:var(--dim)"> · ${escapeHtmlText(b.skill)} en ${escapeHtmlText(b.phase)}</span>
                <span class="${ageCls}"> · hace ${ageStr}</span>
              </div>
              <div class="needs-human-row-actions">
                <button class="nh-btn nh-btn-reactivate" onclick="needsHumanReactivate(${issueId})" title="${escapeHtmlAttr('Quitar el label needs-human y devolver el issue a la cola del pipeline')}">▶ Reactivar</button>
                <button class="nh-btn nh-btn-dismiss" onclick="needsHumanDismiss(${issueId})" title="${escapeHtmlAttr('Cerrar el issue como desestimado y limpiarlo del panel')}">✕ Desestimar</button>
              </div>
            </div>
            ${summaryHtml}
            ${reasonTxt ? `<div class="needs-human-reason">❓ ${escapeHtmlText(reasonTxt.slice(0, 280))}${reasonTxt.length > 280 ? '…' : ''}</div>` : ''}
            ${eventsHtml}
          </div>`;
    }).join('');

    return `
    <div class="matrix-section needs-human-panel" id="bloqueados-humano" data-section="needs-human">
      <h2 class="needs-human-header" onclick="toggleNeedsHumanPanel()" title="${escapeHtmlAttr('Click para colapsar/expandir')}">
        <span class="needs-human-pulse">🚨</span>
        Necesitan intervención humana
        <span class="needs-human-badge">${list.length}</span>
        <span class="needs-human-chevron">▼</span>
        <a class="section-popout" href="/?section=needs-human" target="_blank" title="${escapeHtmlAttr('Abrir en ventana independiente')}" onclick="event.stopPropagation()">↗</a>
      </h2>
      <div class="needs-human-body">
      <div style="display:flex;flex-direction:column;gap:8px;margin-top:6px">
        ${rows}
      </div>
      <div style="margin-top:10px;font-size:0.82em;color:var(--dim)">
        Desbloquear desde Telegram: <code>/unblock &lt;issue&gt; &lt;orientación&gt;</code> · o quitá el label <code>needs-human</code> en GitHub
      </div>
      </div>
    </div>`;
}

// Sub-panel B — Board Kanban del Issue Tracker. `lanesHTML`/`doneLaneHTML` ya
// vienen pre-construidos desde dashboard.js (HTML confiable, decisión D1).
// `activeIssues`/`completedIssues`/`sorted` son arrays controlados por el
// monolito; sólo se interpola su `.length` (entero, seguro). Preserva los IDs
// DOM invariantes (CA-3): #issue-tracker, #it-search-input, #dot-popup.
function renderMatrixHTML(opts) {
    const o = opts || {};
    const bloqueadosHTML = o.bloqueadosHTML || '';
    const lanesHTML = o.lanesHTML || '<div class="it-lane-empty">Cargando lanes…</div>';
    const doneLaneHTML = o.doneLaneHTML || '';
    const activeLen = Array.isArray(o.activeIssues) ? o.activeIssues.length : 0;
    const completedLen = Array.isArray(o.completedIssues) ? o.completedIssues.length : 0;
    const sortedLen = Array.isArray(o.sorted) ? o.sorted.length : 0;

    return `
    ${bloqueadosHTML}
    <a id="board-kanban" class="board-kanban-anchor" aria-hidden="true"></a>
    <div class="matrix-section section-collapsible board-kanban-centerpiece" id="issue-tracker" data-section="issue-tracker">
      <div class="matrix-header">
        <h2 class="section-title-clickable" onclick="toggleSection('issue-tracker')" title="${escapeHtmlAttr('Click para colapsar/expandir')}">
          <span class="section-chevron">▼</span> 🎯 Board Kanban · Pipeline <span class="kanban-v3-badge" aria-label="Versión 3">V3</span>
        </h2>
        <a class="section-popout" href="/?section=issue-tracker" target="_blank" title="${escapeHtmlAttr('Abrir en ventana independiente')}" onclick="event.stopPropagation()">↗</a>
        <div class="it-search-box">
          <input type="text" class="it-search" id="it-search-input" placeholder="🔍 Buscar por # o título…" aria-label="Buscar issues por número o título" oninput="filterIssuesBySearch(this.value)" />
          <span class="it-search-clear" onclick="clearIssueSearch()" title="${escapeHtmlAttr('Limpiar búsqueda')}">×</span>
        </div>
        <div class="ic-tabs" role="tablist" aria-label="Issue filter">
          <button class="ic-tab ic-tab-active" role="tab" aria-selected="true" aria-label="Mostrar issues en progreso" data-filter="active" onclick="filterIssueTab(this,'active')">En progreso <span class="ic-tab-count">${activeLen}</span></button>
          <button class="ic-tab" role="tab" aria-selected="false" aria-label="Mostrar issues completados" data-filter="completed" onclick="filterIssueTab(this,'completed')">Completados <span class="ic-tab-count">${completedLen}</span></button>
          <button class="ic-tab" role="tab" aria-selected="false" aria-label="Mostrar todos los issues" data-filter="all" onclick="filterIssueTab(this,'all')">Todos <span class="ic-tab-count">${sortedLen}</span></button>
        </div>
      </div>
      <div class="section-body">
      <div class="board-kanban-legend" aria-hidden="false">Cada card es un issue; el color del lane indica la fase (📐 Definición · 🔧 Desarrollo · ✅ QA) y los dots marcan los agentes activos.</div>
      <div class="it-lanes">${lanesHTML}</div>
      ${doneLaneHTML}
      <div id="dot-popup" class="dot-popup" style="display:none">
        <div class="dp-head"><span class="dp-title"></span><span class="dp-close" onclick="closeDotPopup()" title="${escapeHtmlAttr('Cerrar')}">×</span></div>
        <div class="dp-body"></div>
      </div>
      </div>
    </div>`;
}

// Render SSR completo de la ventana Matriz. Punto de entrada único.
//
// Params (decisión D1 — handoff por args):
//   { state, bloqueados, lanesHTML, doneLaneHTML, activeIssues, completedIssues, sorted }
// `bloqueados` se toma de opts.bloqueados o, en su defecto, de state.bloqueados
// (el endpoint partial del router sólo tiene ctx.getState(), no los builders
// del Board Kanban → degrada a esqueleto con lanes vacías, ver dashboard-routes).
function renderMatrizSsr(opts) {
    const o = opts || {};
    const state = o.state || {};
    const bloqueados = Array.isArray(o.bloqueados)
        ? o.bloqueados
        : (Array.isArray(state.bloqueados) ? state.bloqueados : []);
    const bloqueadosHTML = renderBloqueadosHTML(bloqueados);
    return renderMatrixHTML({
        bloqueadosHTML,
        lanesHTML: o.lanesHTML,
        doneLaneHTML: o.doneLaneHTML,
        activeIssues: o.activeIssues,
        completedIssues: o.completedIssues,
        sorted: o.sorted,
    });
}

// CA-5 / D4 — El bundle JS cliente (filterIssuesBySearch, clearIssueSearch,
// filterIssueTab, closeDotPopup, toggleNeedsHumanPanel, toggleSection,
// needsHumanReactivate, needsHumanDismiss) ya vive en dashboard.js y se sirve
// vía /js/dashboard.js. NO se duplica acá (la migración onclick→addEventListener
// es #3758). Placeholder para simetría con el resto de las vistas extraídas.
function renderMatrizClientScript() {
    return '';
}

module.exports = {
    renderMatrizSsr,
    renderMatrizClientScript,
    renderBloqueadosHTML,
    renderMatrixHTML,
    safeIssueId,
    loadTheme,
    slug: 'matriz',
};
