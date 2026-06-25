'use strict';

// =============================================================================
// historial.js — Vista "Historial de Ejecuciones" del Dashboard V3 (issue #3734,
// padre #3715).
//
// Extracción de la ventana Historial desde el monolito `.pipeline/dashboard.js`
// (antes bloque ~2894-3001) a su propio módulo, siguiendo la plantilla canónica
// de `home.js` / `ops.js`:
//   - loadTheme() para el render standalone (router #3723).
//   - escape SSR unificado via lib/escape-html.js (#3722 ya aterrizó en main).
//   - render SERVER-SIDE puro: el módulo recibe `state.agentHistory[]` YA armado
//     y ordenado por el padre (decisión de contrato cerrada con architect/guru:
//     el módulo NO toca `matrixEntries`).
//
// Seguridad (CA-4..CA-6, CA-12..CA-16 de #3734; análisis security de #3715):
//   - CA-4: toda interpolación dinámica proveniente de GitHub (titulo) o del
//     filesystem (skill, fase, resultado, logFile, rejectionPdf) pasa por
//     escapeHtmlText (contexto body) o escapeHtmlAttr (contexto atributo).
//   - CA-5: `logFile` y `rejectionPdf` se validan contra isSafeFilename()
//     ANTES de inyectarse en `href`. Si no matchean → link omitido / fallback
//     a GitHub (path traversal mitigado).
//   - CA-6: todo <a target="_blank"> lleva rel="noopener noreferrer" (anti
//     tabnabbing, heredado #2523).
//   - Coerción numérica de `h.issue` (Number()) antes de inyectarla en los
//     onclick de `prioActions`: `Number('1; alert(1)')` → NaN → prioActions se
//     omite (defensa adicional al escape).
//
// NOTA sobre los dos toggles independientes (CA-24):
//   - `<details class="ah-more">` (nativo) controla el "ver más" (15 + hasta 35).
//   - `toggleSection('historial')` (custom, handler global del padre) colapsa la
//     sección entera. Son independientes y no se pisan.
//
// NOTA sobre handlers state-changing (CA-24): los onclick `issueMoveTo*` se
// referencian por nombre; los handlers viven en `renderClientScript` del padre
// (NO se mueven). Mantener `onclick` inline hasta que aterrice CSP estricta
// (migración a data-attributes tracked en #3758).
//
// NOTA sobre el CSS (.ah-*): las clases viven en `theme.css` (sección Historial)
// para el render standalone. La página principal del dashboard NO carga
// theme.css, por eso conserva su copia inline de las mismas reglas para el
// render embebido. El módulo en sí NO emite CSS inline.
// =============================================================================

const fs = require('node:fs');
const path = require('node:path');

const { escapeHtmlText, escapeHtmlAttr } = require('../../lib/escape-html.js');
// #3963 — el cómputo (filtros/agrupación/paginación/agregados) vive en el lib;
// la vista solo lo invoca y renderiza. Si el módulo no carga (caso edge), el
// render degrada a string vacío.
let timelineSlice = null;
try { timelineSlice = require('../../lib/dashboard-slices.js').historialTimelineSlice; } catch { timelineSlice = null; }

const THEME_CSS_PATH = path.join(__dirname, 'theme.css');
function loadTheme() {
    try { return fs.readFileSync(THEME_CSS_PATH, 'utf8'); } catch { return ''; }
}

// Whitelist de filenames para `h.logFile` / `h.rejectionPdf` (CA-5 path
// traversal). Solo permite [A-Za-z0-9._-]. NO permite `/`, `..`, espacios, ni
// shell metacharacters.
function isSafeFilename(s) {
    return typeof s === 'string' && s.length > 0 && /^[A-Za-z0-9._-]+$/.test(s);
}

const HIST_VISIBLE = 15;
const HIST_CAP = 50;

// Render de una card del historial. Reglas obligatorias del cuerpo en el body
// del issue #3734 ("renderHistCard(h) — reglas obligatorias").
function renderHistCard(h, persona, orderIdx, fmtDuration, ghBaseUrl) {
    const p = persona[h.skill] || { icon: '⚙', name: h.skill, color: 'var(--dim)' };
    const isRunning = h.estado === 'trabajando';
    const isOk = h.resultado === 'aprobado';
    const isFail = h.resultado === 'rechazado';
    const statusCls = isRunning ? 'ah-running' : isOk ? 'ah-ok' : isFail ? 'ah-fail' : 'ah-neutral';
    const statusIcon = isRunning ? '●' : isOk ? '✓' : isFail ? '✗' : '—';
    // statusLabel: si corre, texto estático; si no, resultado escapado.
    const statusLabel = isRunning ? 'En ejecución' : escapeHtmlText(h.resultado || 'finalizado');

    const ts = isRunning ? h.startedAt : h.finishedAt;
    const timeStr = ts
        ? new Date(ts).toLocaleString('es-AR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
        : '';
    const durStr = fmtDuration(h.duration);

    // href defensivo (CA-5): solo se usa el log si el filename matchea la
    // whitelist; si no, fallback al issue de GitHub (coerción numérica de issue).
    const useLog = h.hasLog && isSafeFilename(h.logFile);
    const rawHref = useLog
        ? `/logs/view/${h.logFile}${isRunning ? '?live=1' : ''}`
        : `${ghBaseUrl}/${Number(h.issue)}`;
    const href = escapeHtmlAttr(rawHref);

    // tip (title=) mezcla campos dinámicos → escape de atributo obligatorio.
    const tipText = useLog
        ? `Ver log · ${h.skill} · #${h.issue}`
        : `Ver #${h.issue} en GitHub`;
    const tip = escapeHtmlAttr(tipText);

    // título truncado para la card (campo controlable por el creador del issue).
    const titleSuffix = h.titulo ? ` · ${escapeHtmlText(String(h.titulo).slice(0, 40))}` : '';

    // pdfLink defensivo (CA-5): solo se emite si el filename matchea la whitelist.
    const pdfLink = (h.hasRejectionPdf && isSafeFilename(h.rejectionPdf))
        ? ` <a class="ah-pdf" href="${escapeHtmlAttr('/logs/' + h.rejectionPdf)}" target="_blank" rel="noopener noreferrer" title="Ver reporte de rechazo (PDF)" onclick="event.stopPropagation()">\u{1F4C4}</a>`
        : '';

    // prioActions: SOLO si está corriendo. Coerción numérica de issue (CA-12):
    // si Number(issue) es NaN, se omiten las acciones.
    const issueNum = Number(h.issue);
    const prioActions = (isRunning && Number.isFinite(issueNum))
        ? `<span class="ah-prio-actions">
            <button class="lc-prio-btn lc-prio-top" onclick="event.preventDefault();event.stopPropagation();issueMoveToTop(${issueNum})" title="Mover al tope de la columna">⏫</button>
            <button class="lc-prio-btn lc-prio-up" onclick="event.preventDefault();event.stopPropagation();issueMoveUp(${issueNum})" title="Subir una posición">▲</button>
            <button class="lc-prio-btn lc-prio-down" onclick="event.preventDefault();event.stopPropagation();issueMoveDown(${issueNum})" title="Bajar una posición">▼</button>
            <button class="lc-prio-btn lc-prio-bottom" onclick="event.preventDefault();event.stopPropagation();issueMoveToBottom(${issueNum})" title="Mover al fondo de la columna">⏬</button>
          </span>`
        : '';

    const ahPos = orderIdx.has(String(h.issue)) ? orderIdx.get(String(h.issue)) : null;
    const ahPosLabel = ahPos !== null
        ? `<span class="lc-pos" title="Posición en el orden manual (1 = más prioritario)">#${escapeHtmlText(ahPos + 1)}</span>`
        : '';

    // #2523 CA-6: rel="noopener noreferrer" anti-tabnabbing en links externos.
    return `<a href="${href}" target="_blank" rel="noopener noreferrer" class="ah-card ${statusCls}" title="${tip}">
        <span class="ah-avatar" style="background:${escapeHtmlAttr(p.color)}">${escapeHtmlText(p.icon)}</span>
        <span class="ah-skill">${escapeHtmlText(p.name)}</span>
        ${ahPosLabel}
        <span class="ah-issue">#${escapeHtmlText(h.issue)}${titleSuffix}</span>
        <span class="ah-fase">${escapeHtmlText(h.fase)}</span>
        <span class="ah-status">${statusIcon} ${statusLabel}</span>
        <span class="ah-dur">${escapeHtmlText(durStr)}</span>
        <span class="ah-time">${escapeHtmlText(timeStr)}</span>
        ${prioActions}
        ${pdfLink}
      </a>`;
}

// -----------------------------------------------------------------------------
// #3963 — Helpers del timeline.
// -----------------------------------------------------------------------------

// Timestamp humano relativo (CA-5): "ahora", "hace 5 min", "hace 2 h",
// "hace 3 d". Se mantiene el timestamp absoluto en `title=` para precisión.
function relativeTime(ts, now) {
    let t = ts;
    if (typeof t === 'string') t = Date.parse(t);
    if (!Number.isFinite(t) || t <= 0) return '';
    const ref = Number.isFinite(now) ? now : Date.now();
    let diff = ref - t;
    if (diff < 0) diff = 0;
    const min = Math.floor(diff / 60000);
    if (min < 1) return 'ahora';
    if (min < 60) return `hace ${min} min`;
    const h = Math.floor(min / 60);
    if (h < 24) return `hace ${h} h`;
    const d = Math.floor(h / 24);
    return `hace ${d} d`;
}

// Timestamp absoluto formateado (es-AR) para el atributo `title=`.
function absTime(ts) {
    let t = ts;
    if (typeof t === 'string') t = Date.parse(t);
    if (!Number.isFinite(t) || t <= 0) return '';
    return new Date(t).toLocaleString('es-AR', {
        day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
    });
}

// URL segura para `href` de links externos (PR): solo https hacia github.com.
// Evita `javascript:` y esquemas raros. Se escapa igualmente en el atributo.
function isSafeHttpUrl(s) {
    return typeof s === 'string' && /^https:\/\/(github\.com|.*\.github\.com)\//.test(s);
}

// Resumen de una métrica del header de agregados.
function fmtPct(p) {
    const v = Number(p);
    if (!Number.isFinite(v)) return '—';
    return `${Math.round(v * 100)} %`;
}

// Render del detalle expandible de una ejecución (CA: fases, rebotes, costo,
// links a entregables). Todo dato dinámico escapado. `h.attachments` es
// best-effort (CA-2/CA-3): si no viene, se omite.
function renderDetail(h, fmtDuration) {
    const bits = [];

    // Fase + duración de esta ejecución.
    bits.push(`<span class="ah-d-item">fase <b>${escapeHtmlText(h.fase || '—')}</b> · ${escapeHtmlText(fmtDuration(h.duration))}</span>`);

    // Rebotes / cross-phase.
    const reb = Number(h.reboteNumero) || 0;
    const cross = Number(h.crossphaseCount) || 0;
    if (reb > 0) bits.push(`<span class="ah-d-item ah-d-warn">rebote ×${escapeHtmlText(reb)}</span>`);
    if (cross > 0) bits.push(`<span class="ah-d-item ah-d-warn">cross-phase ×${escapeHtmlText(cross)}</span>`);

    // Causa parseada (motivo de rechazo) — truncada y escapada.
    if (h.motivo) {
        const causa = String(h.motivo).slice(0, 160);
        bits.push(`<span class="ah-d-item ah-d-cause" title="${escapeHtmlAttr(String(h.motivo).slice(0, 500))}">causa: ${escapeHtmlText(causa)}</span>`);
    }

    // Costo (best-effort → "s/d" si null, CA-3).
    const costoStr = (h.costo !== null && h.costo !== undefined && Number.isFinite(Number(h.costo)))
        ? `${Number(h.costo).toFixed(2)} USD`
        : 's/d';
    bits.push(`<span class="ah-d-item">costo: ${escapeHtmlText(costoStr)}</span>`);

    // Entregables parciales (CA-2): chips no-clickables (el serving de archivos
    // de repo llega con EP-3 #3926). El reporte PDF de rechazo sí es link real
    // (vía /logs/) y se muestra en las acciones de la card.
    let attachHtml = '';
    if (Array.isArray(h.attachments) && h.attachments.length > 0) {
        const chips = h.attachments.slice(0, 8).map((a) => {
            const label = a && (a.descriptor || a._basename || (a.path ? path.basename(String(a.path)) : '')) || 'entregable';
            const tip = a && a.path ? String(a.path) : '';
            return `<span class="ah-attach" title="${escapeHtmlAttr(tip)}">\u{1F4CE} ${escapeHtmlText(String(label).slice(0, 40))}</span>`;
        }).join('');
        attachHtml = `<div class="ah-d-attachments">${chips}</div>`;
    }

    return `<div class="ah-detail">
        <div class="ah-d-row">${bits.join('<span class="ah-d-sep">·</span>')}</div>
        ${attachHtml}
      </div>`;
}

// Render de una card del timeline (expandible). Reusa los escapes y la
// whitelist `isSafeFilename` ya cableados (#3734). Estructura:
//   <details class="ah-item"> <summary class="ah-card">…acciones…</summary>
//     <div class="ah-detail">…</div> </details>
function renderTimelineCard(h, persona, fmtDuration, ghBaseUrl, now) {
    const p = persona[h.skill] || { icon: '⚙', name: h.skill, color: 'var(--dim)' };
    const isRunning = h.estado === 'trabajando';
    const isOk = h.resultado === 'aprobado';
    const isFail = h.resultado === 'rechazado';
    const statusCls = isRunning ? 'ah-running' : isOk ? 'ah-ok' : isFail ? 'ah-fail' : 'ah-neutral';
    const statusIcon = isRunning ? '●' : isOk ? '✓' : isFail ? '✗' : '—';

    const ts = isRunning ? h.startedAt : h.finishedAt;
    const rel = relativeTime(ts, now);
    const abs = absTime(ts);
    const durStr = fmtDuration(h.duration);

    const titleSuffix = h.titulo ? ` ${escapeHtmlText(String(h.titulo).slice(0, 48))}` : '';

    // --- acciones (links discretos, no toda la card es un link) ---
    const actions = [];
    // log (o fallback al issue de GitHub).
    const useLog = h.hasLog && isSafeFilename(h.logFile);
    const logHref = useLog
        ? `/logs/view/${h.logFile}${isRunning ? '?live=1' : ''}`
        : `${ghBaseUrl}/${Number(h.issue)}`;
    actions.push(`<a class="ah-act" href="${escapeHtmlAttr(logHref)}" target="_blank" rel="noopener noreferrer" title="${escapeHtmlAttr(useLog ? 'Ver log' : 'Ver en GitHub')}" onclick="event.stopPropagation()">${useLog ? 'log' : 'GitHub'}</a>`);
    // PR (si hay url válida).
    if (isSafeHttpUrl(h.prUrl)) {
        actions.push(`<a class="ah-act ah-act-pr" href="${escapeHtmlAttr(h.prUrl)}" target="_blank" rel="noopener noreferrer" title="Ver Pull Request" onclick="event.stopPropagation()">PR ↗</a>`);
    }
    // Reporte de rechazo (PDF, vía /logs/).
    if (h.hasRejectionPdf && isSafeFilename(h.rejectionPdf)) {
        actions.push(`<a class="ah-act ah-act-pdf" href="${escapeHtmlAttr('/logs/' + h.rejectionPdf)}" target="_blank" rel="noopener noreferrer" title="Ver reporte de rechazo (PDF)" onclick="event.stopPropagation()">\u{1F4C4} reporte</a>`);
    }

    return `<details class="ah-item ${statusCls}">
        <summary class="ah-card">
          <span class="ah-status-ic" title="${escapeHtmlAttr(isRunning ? 'En ejecución' : (h.resultado || 'finalizado'))}">${statusIcon}</span>
          <span class="ah-avatar" style="background:${escapeHtmlAttr(p.color)}">${escapeHtmlText(p.icon)}</span>
          <span class="ah-issue">#${escapeHtmlText(h.issue)}<span class="ah-title">${titleSuffix}</span></span>
          <span class="ah-skill" title="${escapeHtmlAttr(String(p.name))}">${escapeHtmlText(p.name)}</span>
          <span class="ah-meta">${escapeHtmlText(h.fase || '')} · ${escapeHtmlText(durStr)}</span>
          <span class="ah-time" title="${escapeHtmlAttr(abs)}">${escapeHtmlText(rel)}</span>
          <span class="ah-actions">${actions.join('')}</span>
        </summary>
        ${renderDetail(h, fmtDuration)}
      </details>`;
}

// Construye las opciones de un <select> de filtro a partir de un set de valores.
function buildSelect(name, label, values, selected) {
    const opts = [`<option value="">${escapeHtmlText(label)}</option>`]
        .concat(Array.from(values).sort().map((v) => {
            const sel = (v === selected) ? ' selected' : '';
            return `<option value="${escapeHtmlAttr(v)}"${sel}>${escapeHtmlText(v)}</option>`;
        }));
    return `<select class="ah-sel" data-ah-filter="${escapeHtmlAttr(name)}">${opts.join('')}</select>`;
}

// state = { agentHistory: [...] } | { issueMatrix, prInfo }
// opts  = { agentPersona, manualOrderIndex, fmtDuration, ghBaseUrl, now, period, skill, resultado, issue, q, cursor }
function renderHistorialSsr(state, opts) {
    const o = opts || {};
    const persona = o.agentPersona || {};
    const fmtDuration = (typeof o.fmtDuration === 'function') ? o.fmtDuration : (() => '—');
    const ghBaseUrl = o.ghBaseUrl || 'https://github.com/intrale/platform/issues';
    const now = Number.isFinite(o.now) ? o.now : Date.now();

    // El render embebido del monolito SIEMPRE muestra el set completo (sin
    // recorte temporal) en la primera página; los filtros se aplican client-side
    // contra /api/dash/historial. Si no hay datos → string vacío (CA-11).
    const rawList = Array.isArray(state && state.agentHistory) ? state.agentHistory : null;
    if (rawList && rawList.length === 0) return '';

    if (!timelineSlice) return '';
    const slice = timelineSlice(state, { now }, {
        period: o.period || 'all',
        skill: o.skill || null,
        resultado: o.resultado || null,
        issue: o.issue || null,
        q: o.q || null,
        cursor: o.cursor,
        limit: HIST_CAP,
    });

    if (!slice || slice.total === 0) {
        // Sin datos en absoluto → no renderizar la sección (back-compat CA-11).
        // Con datos pero filtros que no matchean → estado vacío explícito.
        const hasAnyData = rawList ? rawList.length > 0
            : (state && state.issueMatrix && Object.keys(state.issueMatrix).length > 0);
        if (!hasAnyData) return '';
    }

    const { groups, aggregates, nextCursor, total } = slice;

    // --- header de agregados (CA-3): ejecuciones · %aprobado · mediana ---
    const medianStr = (aggregates.medianMs !== null && aggregates.medianMs !== undefined)
        ? fmtDuration(aggregates.medianMs) : '—';
    const aggrHtml = `<span class="ah-aggr" title="Agregados del período visible">
          <b>${escapeHtmlText(aggregates.count)}</b> ejecuciones
          <span class="ah-aggr-sep">·</span> ${escapeHtmlText(fmtPct(aggregates.pctApproved))} <span class="ah-ok">✓</span>
          <span class="ah-aggr-sep">·</span> mediana ${escapeHtmlText(medianStr)}
        </span>`;

    // --- barra de filtros + búsqueda (CA-1) ---
    // Valores para los selects: derivados del set completo disponible.
    const allItems = (rawList || []);
    const skillSet = new Set(allItems.map((h) => h && h.skill).filter(Boolean));
    const skillSelect = buildSelect('skill', 'skill', skillSet, o.skill || '');
    const resultadoSelect = buildSelect('resultado', 'resultado',
        new Set(['aprobado', 'rechazado', 'trabajando']), o.resultado || '');
    const periodChips = ['today', '7d', '30d', 'all'].map((pk) => {
        const labels = { today: 'Hoy', '7d': '7 d', '30d': '30 d', all: 'Todo' };
        const active = (o.period || 'all') === pk ? ' ah-chip-on' : '';
        return `<button type="button" class="ah-chip${active}" data-ah-period="${pk}">${labels[pk]}</button>`;
    }).join('');
    const filtersHtml = `<div class="ah-filters" data-ah-filters>
          <span class="ah-chips">${periodChips}</span>
          ${skillSelect}
          ${resultadoSelect}
          <input class="ah-search" type="search" data-ah-filter="q" placeholder="\u{1F50D} issue o texto" autocomplete="off" maxlength="200" value="${escapeHtmlAttr(o.q || '')}">
        </div>`;

    // --- timeline agrupado por día ---
    const timelineHtml = groups.length === 0
        ? `<div class="ah-empty">Sin ejecuciones para estos filtros</div>`
        : groups.map((g) => {
            const cards = g.items.map((h) => renderTimelineCard(h, persona, fmtDuration, ghBaseUrl, now)).join('');
            const dayAggr = `<span class="ah-day-aggr">${escapeHtmlText(g.count)} ejec. · ${escapeHtmlText(fmtPct(g.pctApproved))} ✓</span>`;
            return `<div class="ah-day-group">
              <div class="ah-day"><span class="ah-day-label">${escapeHtmlText(g.dayLabel)}</span> ${dayAggr}</div>
              <div class="ah-day-items">${cards}</div>
            </div>`;
        }).join('');

    const loadMore = (nextCursor !== null && nextCursor !== undefined)
        ? `<button type="button" class="ah-load-more" data-ah-next="${escapeHtmlText(nextCursor)}">Ver más ejecuciones…</button>`
        : '';

    return `
    <div class="matrix-section section-collapsible section-collapsed" id="agent-history" data-section="historial">
      <div class="matrix-header">
        <h2 class="section-title-clickable" onclick="toggleSection('historial')" title="Click para colapsar/expandir la sección">
          <span class="section-chevron">▼</span> \u{1F4DC} Historial de Ejecuciones
        </h2>
        ${aggrHtml}
        <a class="section-popout" href="/?section=historial" target="_blank" rel="noopener noreferrer" title="Abrir en ventana independiente" onclick="event.stopPropagation()">↗</a>
        <span class="ah-count">${escapeHtmlText(total)} ejecuciones</span>
      </div>
      <div class="section-body">
        ${filtersHtml}
        <div class="ah-timeline" data-ah-timeline>
          ${timelineHtml}
        </div>
        ${loadMore}
      </div>
    </div>
    ${renderTimelineScript()}`;
}

// Script de progressive-enhancement (CA-1): cablea filtros/búsqueda/paginación
// contra /api/dash/historial y re-renderiza el timeline client-side. Sin JS, el
// render SSR inicial sigue mostrando el timeline. Se emite una sola vez (guard
// por flag global). Todo dato dinámico insertado vía textContent (XSS-safe por
// construcción) — NUNCA innerHTML con datos del server.
function renderTimelineScript() {
    return `<script>(function(){
  if (window.__ahTimelineInit) return; window.__ahTimelineInit = true;
  function esc(s){ return (s==null?'':String(s)); }
  function relTime(ts, now){
    var t = typeof ts==='string'?Date.parse(ts):ts; if(!isFinite(t)||t<=0) return '';
    var d = now - t; if(d<0) d=0; var m=Math.floor(d/60000);
    if(m<1) return 'ahora'; if(m<60) return 'hace '+m+' min';
    var h=Math.floor(m/60); if(h<24) return 'hace '+h+' h'; return 'hace '+Math.floor(h/24)+' d';
  }
  function el(tag, cls, txt){ var e=document.createElement(tag); if(cls) e.className=cls; if(txt!=null) e.textContent=txt; return e; }
  var root = document.getElementById('agent-history'); if(!root) return;
  var timeline = root.querySelector('[data-ah-timeline]'); if(!timeline) return;
  var filters = root.querySelector('[data-ah-filters]');
  var state = { period:'all', skill:'', resultado:'', q:'' };
  var debounce;
  function buildQuery(cursor){
    var p = new URLSearchParams();
    if(state.period && state.period!=='all') p.set('period', state.period);
    if(state.skill) p.set('skill', state.skill);
    if(state.resultado) p.set('resultado', state.resultado);
    if(state.q) p.set('q', state.q);
    if(cursor) p.set('cursor', cursor);
    return p.toString();
  }
  function actionLink(href, label, title){
    var a=el('a','ah-act',label); a.href=href; a.target='_blank'; a.rel='noopener noreferrer';
    if(title) a.title=title; a.addEventListener('click', function(ev){ ev.stopPropagation(); }); return a;
  }
  function renderCard(h){
    var det = document.createElement('details');
    det.className = 'ah-item ' + (h.estado==='trabajando'?'ah-running':(h.resultado==='aprobado'?'ah-ok':(h.resultado==='rechazado'?'ah-fail':'ah-neutral')));
    var sum = el('summary','ah-card');
    var ic = h.estado==='trabajando'?'\\u25CF':(h.resultado==='aprobado'?'\\u2713':(h.resultado==='rechazado'?'\\u2717':'\\u2014'));
    sum.appendChild(el('span','ah-status-ic', ic));
    var iss = el('span','ah-issue','#'+esc(h.issue)+(h.titulo? ' '+String(h.titulo).slice(0,48):''));
    sum.appendChild(iss);
    sum.appendChild(el('span','ah-skill', esc(h.skill)));
    sum.appendChild(el('span','ah-meta', esc(h.fase)+' '));
    var ts = h.estado==='trabajando'? h.startedAt : h.finishedAt;
    sum.appendChild(el('span','ah-time', relTime(ts, Date.now())));
    var acts = el('span','ah-actions');
    var n = Number(h.issue);
    var logHref = (h.hasLog && /^[A-Za-z0-9._-]+$/.test(String(h.logFile||''))) ? '/logs/view/'+h.logFile : ('https://github.com/intrale/platform/issues/'+(isFinite(n)?n:''));
    acts.appendChild(actionLink(logHref, (h.hasLog?'log':'GitHub')));
    if(h.prUrl && /^https:\\/\\/(github\\.com|.*\\.github\\.com)\\//.test(h.prUrl)) acts.appendChild(actionLink(h.prUrl,'PR \\u2197'));
    if(h.hasRejectionPdf && /^[A-Za-z0-9._-]+$/.test(String(h.rejectionPdf||''))) acts.appendChild(actionLink('/logs/'+h.rejectionPdf,'\\u{1F4C4} reporte'));
    sum.appendChild(acts);
    det.appendChild(sum);
    var detail = el('div','ah-detail');
    var row = el('div','ah-d-row');
    row.appendChild(el('span','ah-d-item','fase '+esc(h.fase)));
    if(Number(h.reboteNumero)>0) row.appendChild(el('span','ah-d-item ah-d-warn','rebote \\u00D7'+Number(h.reboteNumero)));
    if(Number(h.crossphaseCount)>0) row.appendChild(el('span','ah-d-item ah-d-warn','cross-phase \\u00D7'+Number(h.crossphaseCount)));
    if(h.motivo) row.appendChild(el('span','ah-d-item ah-d-cause','causa: '+String(h.motivo).slice(0,160)));
    var costo = (h.costo!=null && isFinite(Number(h.costo)))? Number(h.costo).toFixed(2)+' USD':'s/d';
    row.appendChild(el('span','ah-d-item','costo: '+costo));
    detail.appendChild(row);
    if(Array.isArray(h.attachments) && h.attachments.length){
      var at = el('div','ah-d-attachments');
      h.attachments.slice(0,8).forEach(function(a){
        var lbl = (a && (a.descriptor || a.path)) || 'entregable';
        at.appendChild(el('span','ah-attach','\\u{1F4CE} '+String(lbl).slice(0,40)));
      });
      detail.appendChild(at);
    }
    det.appendChild(detail);
    return det;
  }
  function pct(p){ var v=Number(p); return isFinite(v)? Math.round(v*100)+' %':'\\u2014'; }
  function render(data, append){
    if(!append) timeline.textContent='';
    if(!data || !data.groups || !data.groups.length){
      if(!append){ timeline.appendChild(el('div','ah-empty','Sin ejecuciones para estos filtros')); }
      return;
    }
    data.groups.forEach(function(g){
      var grp = el('div','ah-day-group');
      var day = el('div','ah-day');
      day.appendChild(el('span','ah-day-label', g.dayLabel));
      day.appendChild(el('span','ah-day-aggr', g.count+' ejec. · '+pct(g.pctApproved)+' \\u2713'));
      grp.appendChild(day);
      var items = el('div','ah-day-items');
      g.items.forEach(function(h){ items.appendChild(renderCard(h)); });
      grp.appendChild(items);
      timeline.appendChild(grp);
    });
  }
  var loadMoreBtn = root.querySelector('.ah-load-more');
  function fetchAndRender(cursor, append){
    fetch('/api/dash/historial?'+buildQuery(cursor), { headers:{ 'Accept':'application/json' } })
      .then(function(r){ return r.ok? r.json(): null; })
      .then(function(data){
        if(!data){ return; }
        render(data, append);
        // refrescar el header de agregados
        var aggr = root.querySelector('.ah-aggr');
        if(aggr && data.aggregates){ aggr.innerHTML=''; aggr.appendChild(el('b',null,String(data.aggregates.count))); aggr.appendChild(document.createTextNode(' ejecuciones · '+pct(data.aggregates.pctApproved)+' \\u2713')); }
        // load-more
        if(loadMoreBtn){
          if(data.nextCursor!=null){ loadMoreBtn.style.display=''; loadMoreBtn.setAttribute('data-ah-next', data.nextCursor); }
          else { loadMoreBtn.style.display='none'; }
        }
      }).catch(function(){});
  }
  if(filters){
    filters.addEventListener('click', function(ev){
      var chip = ev.target.closest('[data-ah-period]'); if(!chip) return;
      state.period = chip.getAttribute('data-ah-period');
      filters.querySelectorAll('[data-ah-period]').forEach(function(c){ c.classList.toggle('ah-chip-on', c===chip); });
      fetchAndRender(0,false);
    });
    filters.addEventListener('change', function(ev){
      var f = ev.target.getAttribute && ev.target.getAttribute('data-ah-filter'); if(!f) return;
      state[f] = ev.target.value || ''; fetchAndRender(0,false);
    });
    filters.addEventListener('input', function(ev){
      var f = ev.target.getAttribute && ev.target.getAttribute('data-ah-filter'); if(f!=='q') return;
      clearTimeout(debounce); state.q = ev.target.value || '';
      debounce = setTimeout(function(){ fetchAndRender(0,false); }, 300);
    });
  }
  if(loadMoreBtn){
    loadMoreBtn.addEventListener('click', function(){
      var c = loadMoreBtn.getAttribute('data-ah-next'); if(c!=null) fetchAndRender(c, true);
    });
  }
})();</script>`;
}

module.exports = {
    renderHistorialSsr,
    renderHistCard,
    renderTimelineCard,
    renderDetail,
    relativeTime,
    isSafeHttpUrl,
    loadTheme,
    isSafeFilename,
    HIST_VISIBLE,
    HIST_CAP,
};
