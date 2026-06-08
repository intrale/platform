// =============================================================================
// bloqueados.js — Vista SSR de la ventana Bloqueados del dashboard V3
// (`/bloqueados` legacy + `/dashboard?view=bloqueados` + panel embebido en la
// home legacy `generateHTML`). Issue: #3729 (split de #3715 — extracción de la
// ventana "Necesitan intervención humana" del monolito dashboard.js).
//
// Qué muestra: los issues con marker `needs-human` que esperan que un humano
// decida (reactivar / desestimar). El backend los expone en `state.bloqueados`
// (poblado por `humanBlock.listBlockedIssues()` + `issueSummary.getSummaries()`,
// enriquecido con `priorityIndex` por `dashboard-slices.bloqueadosSlice`).
//
// Estructura (patrón de las hermanas migradas — matriz.js / ops.js / kpis.js):
//   - renderBloqueadosSsr(state[, opts])   → fragmento del panel (data-slug).
//                                            Lo embebe la home legacy y el full doc.
//   - renderBloqueados(state)              → documento SSR completo (shell satélite).
//   - renderBloqueadosInner(state)         → fragmento + <script> para DOM morphing.
//   - renderBloqueadosClientScript()       → handlers window.needsHuman* (R3 del issue).
//   - slug                                 → 'bloqueados' (clave de VIEW_SLUGS).
//
// Rediseño V3 (decisiones cerradas por UX — comentario /ux de #3729):
//   - Severidad dual-encoded: rail vertical + pill con ícono + texto numérico de
//     edad. Nunca sólo color (WCAG AA · CA-3729.E).
//   - 3 umbrales de edad: fresh < 4h (--in-info), warning 4-24h (--in-warn),
//     danger ≥ 24h (--in-bad). El monolito usaba 2 umbrales; el intermedio baja ruido.
//   - Empty-state celebratorio (#bloqueados-empty) + mini-stats (NO string vacío).
//   - Tooltips (CA-3729.C) en cada acción, con escape attr-context.
//
// Seguridad (CA-3729.B/D — comentario /security de #3729):
//   - Escape unificado vía lib/escape-html.js (#3722): escapeHtmlText (body) /
//     escapeHtmlAttr (title="..."). NO se reusa el esc() global del monolito.
//   - Coerción numérica estricta de `b.issue` antes de interpolar en href/onclick
//     (safeIssueNumber). Fila descartada si no es entero positivo.
//   - reasonTxt truncado a 280 chars (reusa la lógica del monolito, NO inventa).
// =============================================================================
'use strict';

const fs = require('fs');
const path = require('path');

// #3726 — Nav bar V3 unificada (renderNavTabsSsr + loadIconSprite del cache
// compartido del sprite.svg). Misma dependencia que home.js / matriz.js.
const { renderNavTabsSsr, loadIconSprite } = require('./nav-tabs');

// #3722 — Escape HTML server-side unificado (lib/escape-html.js, cierra #2901).
// CA-B3: la ventana extraída usa el helper compartido en vez de duplicar un
// escapeHtmlSsr inline. escapeHtmlText cubre el contexto nodo-texto y
// escapeHtmlAttr el contexto atributo (title="", aria-label="").
const escapeHtmlLib = require('../../lib/escape-html.js');

const THEME_CSS_PATH = path.join(__dirname, 'theme.css');
function loadTheme() {
    try { return fs.readFileSync(THEME_CSS_PATH, 'utf8'); } catch { return ''; }
}

const slug = 'bloqueados';

// Defensa en profundidad (CA-D1). Si el require de lib/escape-html.js fallara en
// un checkout transitorio, el módulo sigue escapando con un fallback SSR-only.
function escapeHtmlSsrFallback(s) {
    if (s == null) return '';
    return String(s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/`/g, '&#96;');
}
function escapeHtmlText(s) {
    if (escapeHtmlLib && typeof escapeHtmlLib.escapeHtmlText === 'function') {
        return escapeHtmlLib.escapeHtmlText(s);
    }
    return escapeHtmlSsrFallback(s);
}
function escapeHtmlAttr(s) {
    if (escapeHtmlLib && typeof escapeHtmlLib.escapeHtmlAttr === 'function') {
        return escapeHtmlLib.escapeHtmlAttr(s);
    }
    return escapeHtmlSsrFallback(s);
}
// Alias canónico de texto (paridad con matriz.js::escapeHtmlSsr).
function escapeHtmlSsr(s) { return escapeHtmlText(s); }

// CA-D1 / CA-D2 — coerción numérica estricta. `b.issue` se interpola en href y
// onclick; debe ser un entero positivo o la fila se descarta entera. Cubre
// inputs corruptos del marker filesystem ('1) alert(1) //', '<script>', '3.14',
// 0, -5, null, '').
function safeIssueNumber(raw) {
    const n = Number(raw);
    return (Number.isInteger(n) && n > 0) ? n : null;
}

// Severidad por edad (3 umbrales V3). Devuelve la clave semántica; el CSS mapea
// cada clave a un token existente del épico (--in-info / --in-warn / --in-bad).
// Defensa: edad no numérica → 'info' (no rompe el render).
function severity(ageHours) {
    const h = Number(ageHours);
    if (!Number.isFinite(h) || h < 4) return 'info';     // fresh  < 4h
    if (h < 24) return 'warning';                         // warning 4-24h
    return 'danger';                                      // danger  ≥ 24h
}

const SEVERITY_META = {
    info:    { icon: '🟦', label: 'Reciente',  range: '< 4h' },
    warning: { icon: '🟧', label: 'Demorado',  range: '4–24h' },
    danger:  { icon: '🟥', label: 'Crítico',   range: '≥ 24h' },
};

// Formato de edad compacto: "12min" / "5h" / "2d". Reusa la semántica del
// monolito (age_hours precomputado por el backend).
function fmtAge(ageHours) {
    const h = Number(ageHours);
    if (!Number.isFinite(h) || h < 0) return '—';
    if (h < 1) return Math.max(1, Math.round(h * 60)) + 'min';
    if (h < 48) return Math.round(h) + 'h';
    return Math.round(h / 24) + 'd';
}

// Tiempo relativo compacto para eventos ("ahora" / "12min" / "3h" / "2d").
// nowMs inyectable para tests deterministas (default Date.now()).
function relTimeSsr(whenIso, nowMs) {
    if (!whenIso) return '';
    const t = Date.parse(whenIso);
    if (!t) return '';
    const now = Number.isFinite(nowMs) ? nowMs : Date.now();
    const min = Math.round((now - t) / 60000);
    if (min < 1) return 'ahora';
    if (min < 60) return min + 'min';
    const hr = Math.round(min / 60);
    if (hr < 24) return hr + 'h';
    return Math.round(hr / 24) + 'd';
}

// CSS de la ventana — vive en theme.css con prefijo .v3-bloqueados-* (clases
// migradas en #3729). Exportado vacío para tests que verifiquen que el módulo
// NO inlinea su propio <style> (lo carga loadTheme()).
const BLOQUEADOS_CSS = '';

// ── Empty-state celebratorio (#bloqueados-empty + mini-stats) ────────────────
// UX cambió la decisión del monolito (que retornaba string vacío): ahora hay un
// estado celebratorio con mini-stats (SLA promedio + Resueltos hoy). Los valores
// se leen de state.bloqueadosStats si existen; si no, '—' (no rompe el render).
function renderEmptyStateSsr(state) {
    const stats = (state && state.bloqueadosStats) || {};
    const sla = (stats.sla_promedio != null && stats.sla_promedio !== '')
        ? escapeHtmlText(stats.sla_promedio) : '—';
    const resueltos = Number.isFinite(Number(stats.resueltos_hoy))
        ? String(Math.trunc(Number(stats.resueltos_hoy))) : '—';
    return ''
        + '<div class="v3-bloqueados-empty" id="bloqueados-empty" role="status">'
        +   '<div class="v3-bloqueados-empty-icon" aria-hidden="true">✅</div>'
        +   '<div class="v3-bloqueados-empty-title">Nada esperando que alguien decida</div>'
        +   '<div class="v3-bloqueados-empty-sub">El pipeline fluye sin intervención humana pendiente.</div>'
        +   '<div class="v3-bloqueados-empty-stats" id="bloqueados-empty-stats">'
        +     '<div class="v3-bloqueados-stat">'
        +       '<span class="v3-bloqueados-stat-value" id="bloqueados-stat-sla">' + sla + '</span>'
        +       '<span class="v3-bloqueados-stat-label">SLA promedio</span>'
        +     '</div>'
        +     '<div class="v3-bloqueados-stat">'
        +       '<span class="v3-bloqueados-stat-value" id="bloqueados-stat-resueltos">' + resueltos + '</span>'
        +       '<span class="v3-bloqueados-stat-label">Resueltos hoy</span>'
        +     '</div>'
        +   '</div>'
        + '</div>';
}

// ── Leyenda de severidad (CA-3729.C3) ────────────────────────────────────────
function renderSeverityLegendSsr() {
    const item = (key) => {
        const m = SEVERITY_META[key];
        return '<span class="v3-bloqueados-legend-item" title="' + escapeHtmlAttr(m.label + ': bloqueado ' + m.range) + '">'
            + '<span class="v3-bloqueados-legend-rail v3-bloqueados-severity-' + key + '" aria-hidden="true"></span>'
            + escapeHtmlText(m.label + ' (' + m.range + ')')
            + '</span>';
    };
    return '<div class="v3-bloqueados-legend" aria-label="Leyenda de severidad por antigüedad">'
        + item('info') + item('warning') + item('danger')
        + '</div>';
}

// ── Fila individual ──────────────────────────────────────────────────────────
function renderRowSsr(b, nowMs) {
    if (!b || typeof b !== 'object') return '';
    const issueNum = safeIssueNumber(b.issue);
    if (issueNum === null) return ''; // CA-D2: descartar fila con issue inválido.

    const sev = severity(b.age_hours);
    const sevMeta = SEVERITY_META[sev];
    const ageStr = fmtAge(b.age_hours);

    const title = (b.title || '').toString();
    const titleHtml = title
        ? ' — <span class="v3-bloqueados-row-title">' + escapeHtmlText(title) + '</span>'
        : '';
    const reasonTxt = (b.question || b.reason || '').toString();
    const summaryTxt = (b.summary || '').toString();
    const events = Array.isArray(b.recent_events) ? b.recent_events : [];

    // Resumen funcional (LLM output → escapado). Estado loading si stale sin summary.
    const summaryHtml = summaryTxt
        ? '<div class="v3-bloqueados-summary">📄 ' + escapeHtmlText(summaryTxt) + '</div>'
        : (b.summary_stale
            ? '<div class="v3-bloqueados-summary v3-bloqueados-summary-loading">📄 <em>Cargando resumen funcional…</em></div>'
            : '');

    // Motivo del agente (truncado a 280 chars — reusa la lógica del monolito).
    const reasonHtml = reasonTxt
        ? '<div class="v3-bloqueados-reason">❓ ' + escapeHtmlText(reasonTxt.slice(0, 280))
            + (reasonTxt.length > 280 ? '…' : '') + '</div>'
        : '';

    // Actividad reciente (gh issue comments → escapado). Ausente/vacía → sin bloque.
    const eventsHtml = events.length === 0 ? '' : ''
        + '<div class="v3-bloqueados-events">'
        +   '<div class="v3-bloqueados-events-label">📜 Actividad reciente</div>'
        +   '<ul class="v3-bloqueados-events-list">'
        +     events.map((ev) => '<li>'
        +       '<span class="v3-bloqueados-ev-when">' + escapeHtmlText(relTimeSsr(ev && ev.when, nowMs)) + '</span> '
        +       '<span class="v3-bloqueados-ev-author">' + escapeHtmlText((ev && ev.author) || '?') + '</span>: '
        +       '<span class="v3-bloqueados-ev-text">' + escapeHtmlText((ev && ev.preview) || '') + '</span>'
        +       '</li>').join('')
        +   '</ul>'
        + '</div>';

    const skillTxt = (b.skill || '').toString();
    const phaseTxt = (b.phase || '').toString();
    const ghHref = 'https://github.com/intrale/platform/issues/' + issueNum;
    const ageTip = sevMeta.label + ' · bloqueado hace ' + ageStr + ' (' + sevMeta.range + ')';

    // Dual-class (.needs-human-row legacy) para que la home legacy `generateHTML`
    // —que NO carga theme.css— mantenga un fallback estilado (CA-B2 alias).
    return ''
        + '<div class="v3-bloqueados-row v3-bloqueados-severity-' + sev + ' needs-human-row" id="bloqueados-row-' + issueNum + '" data-issue="' + issueNum + '">'
        +   '<span class="v3-bloqueados-row-rail" aria-hidden="true"></span>'
        +   '<div class="v3-bloqueados-row-head">'
        +     '<div class="v3-bloqueados-row-info">'
        +       '<a class="v3-bloqueados-row-link" href="' + escapeHtmlAttr(ghHref) + '" target="_blank" rel="noopener noreferrer"'
        +         ' title="' + escapeHtmlAttr('Abrir el issue #' + issueNum + ' en GitHub') + '"'
        +         ' aria-label="' + escapeHtmlAttr('Abrir issue #' + issueNum + ' en GitHub') + '"><b>#' + issueNum + '</b></a>'
        +       titleHtml
        +       '<span class="v3-bloqueados-row-meta"> · ' + escapeHtmlText(skillTxt) + ' en ' + escapeHtmlText(phaseTxt) + '</span>'
        +       '<span class="v3-bloqueados-pill v3-bloqueados-severity-' + sev + '" title="' + escapeHtmlAttr(ageTip) + '">'
        +         '<span class="v3-bloqueados-pill-icon" aria-hidden="true">' + sevMeta.icon + '</span>'
        +         '<span class="v3-bloqueados-pill-age">' + escapeHtmlText('hace ' + ageStr) + '</span>'
        +       '</span>'
        +     '</div>'
        +     '<div class="v3-bloqueados-row-actions">'
        +       '<button type="button" class="v3-bloqueados-btn v3-bloqueados-btn-reactivate nh-btn nh-btn-reactivate"'
        +         ' onclick="needsHumanReactivate(' + issueNum + ')"'
        +         ' title="' + escapeHtmlAttr('Reactivar #' + issueNum + ': quita el label needs-human y devuelve el issue a la cola del pipeline') + '"'
        +         ' aria-label="' + escapeHtmlAttr('Reactivar issue #' + issueNum) + '">▶ Reactivar</button>'
        +       '<button type="button" class="v3-bloqueados-btn v3-bloqueados-btn-dismiss nh-btn nh-btn-dismiss"'
        +         ' onclick="needsHumanDismiss(' + issueNum + ')"'
        +         ' title="' + escapeHtmlAttr('Desestimar #' + issueNum + ': cierra el issue como desestimado y lo quita del panel') + '"'
        +         ' aria-label="' + escapeHtmlAttr('Desestimar issue #' + issueNum) + '">✕ Desestimar</button>'
        +     '</div>'
        +   '</div>'
        +   summaryHtml
        +   reasonHtml
        +   eventsHtml
        + '</div>';
}

// ── Panel completo (fragmento) ───────────────────────────────────────────────
// Lo embebe la home legacy `generateHTML` (vía bloqueadosHTML) y el full doc /
// inner. Emite `data-slug="bloqueados"` (boundary del router #3773 + smoke CA-G2).
function renderBloqueadosSsr(state, opts) {
    const nowMs = (opts && Number.isFinite(opts.nowMs)) ? opts.nowMs : Date.now();
    const list = Array.isArray(state && state.bloqueados) ? state.bloqueados : [];

    if (list.length === 0) {
        return '<section class="v3-bloqueados-view" data-slug="bloqueados" data-section="needs-human">'
            + renderEmptyStateSsr(state)
            + '</section>';
    }

    const rows = list.map((b) => renderRowSsr(b, nowMs)).filter(Boolean).join('');
    // Si todas las filas se descartaron por issue inválido, mostrar empty-state.
    if (!rows) {
        return '<section class="v3-bloqueados-view" data-slug="bloqueados" data-section="needs-human">'
            + renderEmptyStateSsr(state)
            + '</section>';
    }

    const count = list.filter((b) => safeIssueNumber(b && b.issue) !== null).length;

    return ''
        + '<section class="v3-bloqueados-view matrix-section needs-human-panel" id="bloqueados-humano" data-slug="bloqueados" data-section="needs-human">'
        +   '<h2 class="v3-bloqueados-header needs-human-header" onclick="toggleNeedsHumanPanel()" title="' + escapeHtmlAttr('Colapsar/expandir el panel de bloqueados') + '">'
        +     '<span class="v3-bloqueados-pulse needs-human-pulse" aria-hidden="true">🚨</span>'
        +     'Necesitan intervención humana'
        +     '<span class="v3-bloqueados-badge needs-human-badge">' + count + '</span>'
        +     '<span class="v3-bloqueados-chevron needs-human-chevron" aria-hidden="true">▼</span>'
        +     '<a class="v3-bloqueados-popout section-popout" href="/dashboard?view=bloqueados" target="_blank" rel="noopener"'
        +       ' title="' + escapeHtmlAttr('Abrir Bloqueados en una ventana independiente') + '"'
        +       ' aria-label="Abrir Bloqueados en ventana independiente" onclick="event.stopPropagation()">↗</a>'
        +   '</h2>'
        +   '<div class="v3-bloqueados-body needs-human-body">'
        +     renderSeverityLegendSsr()
        +     '<div class="v3-bloqueados-list" id="bloqueados-list">' + rows + '</div>'
        +     '<div class="v3-bloqueados-help">'
        +       'Desbloquear desde Telegram: <code>/unblock &lt;issue&gt; &lt;orientación&gt;</code>'
        +       ' · o quitá el label <code>needs-human</code> en GitHub'
        +     '</div>'
        +   '</div>'
        + '</section>';
}

// ── Client script — handlers window.needsHuman* (R3 del issue) ────────────────
// Portados verbatim del monolito (dashboard.js). Siguen siendo window.* para no
// romper los onclick="needsHuman*(...)" del SSR. NO se rediseñan en esta sub.
// El fetch deja preparada la inyección de X-CSRF-Token (R8): lee
// <meta name="csrf-token"> si existe, lo omite si no (no hardcodea ausencia).
function renderBloqueadosClientScript() {
    return `
<script>
(function(){
  function nhCsrfHeaders(base){
    var h = Object.assign({}, base || {});
    try {
      var m = document.querySelector('meta[name="csrf-token"]');
      if (m && m.content) h['X-CSRF-Token'] = m.content;
    } catch (e) {}
    return h;
  }
  function nhDisableButtons(issueNum){
    try {
      document.querySelectorAll('.v3-bloqueados-row button[onclick*="(' + issueNum + ')"], .needs-human-row button[onclick*="(' + issueNum + ')"]').forEach(function(b){ b.disabled = true; });
    } catch (e) {}
  }
  function toggleNeedsHumanPanel(scrollOnExpand){
    var panel = document.getElementById('bloqueados-humano');
    if (!panel) return;
    var willCollapse = !panel.classList.contains('nh-collapsed');
    panel.classList.toggle('nh-collapsed');
    try { localStorage.setItem('nh-panel-collapsed', willCollapse ? '1' : '0'); } catch (e) {}
    if (!willCollapse && scrollOnExpand) {
      try { panel.scrollIntoView({behavior:'smooth', block:'start'}); } catch (e) {}
    }
  }
  async function needsHumanReactivate(issueNum){
    if (!confirm('Reactivar #' + issueNum + '? Volverá a la cola del pipeline sin orientación adicional.')) return;
    nhDisableButtons(issueNum);
    try {
      var r = await fetch('/api/needs-human/' + issueNum + '/reactivate', { method: 'POST', headers: nhCsrfHeaders() });
      var j = await r.json();
      if (j.ok) location.reload();
      else { alert('Error reactivando: ' + (j.msg || 'desconocido')); location.reload(); }
    } catch (e) { alert('Error reactivando: ' + e.message); location.reload(); }
  }
  async function needsHumanDismiss(issueNum){
    var reason = prompt('Motivo para desestimar #' + issueNum + ' (opcional):', '');
    if (reason === null) return;
    if (!confirm('Cerrar #' + issueNum + ' como desestimado? Se quitará del panel y quedará cerrado en GitHub.')) return;
    nhDisableButtons(issueNum);
    try {
      var r = await fetch('/api/needs-human/' + issueNum + '/dismiss', {
        method: 'POST',
        headers: nhCsrfHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ reason: reason || '' })
      });
      var j = await r.json();
      if (j.ok) {
        if (j.worktree && j.worktree_warning) {
          var cleanWt = confirm('Issue #' + issueNum + ' desestimado.\\n\\nEl worktree tiene trabajo en disco:\\n  ' + j.worktree + '\\n\\n¿Limpiar el worktree ahora? (Cancelar = conservar)');
          if (cleanWt) {
            try {
              var rw = await fetch('/api/needs-human/' + issueNum + '/dismiss-worktree', { method: 'POST', headers: nhCsrfHeaders() });
              var jw = await rw.json();
              if (!jw.ok) alert('No pude limpiar el worktree: ' + (jw.msg || 'desconocido'));
            } catch (e) { alert('Error limpiando worktree: ' + e.message); }
          }
        }
        location.reload();
      } else { alert('Error desestimando: ' + (j.msg || 'desconocido')); location.reload(); }
    } catch (e) { alert('Error desestimando: ' + e.message); location.reload(); }
  }
  // Restaurar estado colapsado/expandido del panel (persistido por operador).
  (function restoreNeedsHumanPanelState(){
    try {
      if (localStorage.getItem('nh-panel-collapsed') === '1') {
        var panel = document.getElementById('bloqueados-humano');
        if (panel) panel.classList.add('nh-collapsed');
      }
    } catch (e) {}
  })();
  // Exponer como globales para los onclick="..." del SSR (R3).
  window.toggleNeedsHumanPanel = toggleNeedsHumanPanel;
  window.needsHumanReactivate = needsHumanReactivate;
  window.needsHumanDismiss = needsHumanDismiss;
})();
</script>`;
}

// Snippet JS compartido del header satélite (tickHeader del pill + reloj). Copia
// del subconjunto que usan las hermanas (matriz.js) para no depender del monolito.
const COMMON_HELPERS = `
function setText(id, value){ const el=document.getElementById(id); if(el && el.textContent!==String(value)) el.textContent=value; }
function fetchJson(url){ return fetch(url, {cache:'no-store'}).then(r => r.ok ? r.json() : null).catch(()=>null); }
async function tickHeader(){
    const d = await fetchJson('/api/dash/header');
    if(!d) return;
    setText('hdr-clock', new Date().toLocaleTimeString('es-AR'));
    const modePill = document.getElementById('hdr-mode');
    if(modePill){
        modePill.classList.remove('in-mode-running','in-mode-paused','in-mode-partial');
        if(d.mode==='paused'){ modePill.classList.add('in-mode-paused'); modePill.textContent='⏸ Pausado'; }
        else if(d.mode==='partial_pause'){ modePill.classList.add('in-mode-partial'); modePill.textContent='⏸ Parcial'; }
        else { modePill.classList.add('in-mode-running'); modePill.textContent='🟢 Running'; }
    }
}
async function tickBloqueados(){
    const d = await fetchJson('/api/dash/bloqueados');
    if(!d) return;
    const list = (d.bloqueados || []).filter(function(b){ const n = Number(b && b.issue); return Number.isInteger(n) && n > 0; });
    const badge = document.querySelector('.v3-bloqueados-badge');
    if(badge){
        const seen = {};
        for(const b of list){ seen[String(Number(b.issue))] = true; }
        badge.textContent = String(Object.keys(seen).length);
    }
}
document.addEventListener('visibilitychange', () => { if(document.visibilityState === 'visible' && typeof runAll === 'function') runAll(); });
`;

// Fragmento embebible (sin shell): panel + scripts. Lo consume el router cliente
// `?view=bloqueados` (DOM morphing) y lo reusa renderBloqueados() (full doc).
function renderBloqueadosInner(state, opts) {
    return renderBloqueadosSsr(state, opts)
        + '<script>' + COMMON_HELPERS + `
const POLLS = [{ fn: tickHeader, ms: 5000 }, { fn: tickBloqueados, ms: 30000 }];
async function runAll(){ for(const p of POLLS){ try{ await p.fn(); } catch{} } }
runAll();
for(const p of POLLS){ setInterval(() => { p.fn().catch(()=>{}); }, p.ms); }
</script>`
        + renderBloqueadosClientScript();
}

// Documento SSR completo (deep-link directo `/bloqueados` y `?view=bloqueados`).
// Replica el shell satélite (header + nav V3 + footer) inline, siguiendo el
// patrón de matriz.js / descanso.js para no depender del monolito en demolición.
function renderBloqueados(state, opts) {
    const theme = loadTheme();
    const spriteInline = loadIconSprite();
    const navHtml = renderNavTabsSsr(slug);
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
<!-- #3726 — Sprite SVG inline para resolver <use href="#ic-tab-*"> dentro del
     <nav class="v3-nav">. Oculto; los símbolos siguen referenciables. -->
<div aria-hidden="true" style="position:absolute;width:0;height:0;overflow:hidden">${spriteInline}</div>
<div class="satellite-frame">
  <header class="in-header">
    <div class="in-header-brand">
      <div class="in-header-logo">i</div>
      <div>
        <div class="in-header-title">Bloqueados</div>
        <div class="in-header-subtitle">Esperando intervención humana</div>
      </div>
    </div>
    <div class="in-header-meta">
      <span class="in-pill" id="hdr-mode">…</span>
      <span class="in-clock" id="hdr-clock">…</span>
    </div>
  </header>
  ${navHtml}
  <main class="satellite-body" id="view-content" data-current-view="bloqueados">${renderBloqueadosInner(state, opts)}</main>
  <footer class="in-footer">
    <span>Refresh independiente · sin flicker</span>
    <span>Intrale V3</span>
  </footer>
</div>
</body>
</html>`;
}

module.exports = {
    slug,
    renderBloqueadosSsr,
    renderBloqueadosInner,
    renderBloqueados,
    renderBloqueadosClientScript,
    renderEmptyStateSsr,
    renderSeverityLegendSsr,
    loadTheme,
    escapeHtmlSsr,
    safeIssueNumber,
    severity,
    fmtAge,
    relTimeSsr,
    BLOQUEADOS_CSS,
};
