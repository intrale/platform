'use strict';

// =============================================================================
// bloqueados.js — Ventana "Bloqueados" (necesitan intervención humana) del
// Dashboard V3 (issue #3729, padre #3715).
//
// Extracción del panel inline `bloqueadosHTML` que vivía embebido en el render
// monolítico `generateHTML` de `dashboard.js` (~líneas 2371-2439). Sigue la
// plantilla de `home.js` / `costos.js`: loadTheme + escape por contexto +
// exports SSR + client script con los handlers globales.
//
// Contrato de exports (consumido por dashboard.js):
//   - slug: 'bloqueados'
//   - renderBloqueadosSsr(state)         → fragmento SSR <section data-slug="bloqueados">.
//                                          Empty-state celebratorio cuando no hay bloqueados
//                                          (UX #3729 cambió la decisión: ya NO retorna '').
//   - renderBloqueadosClientScript()     → <script> con window.toggleNeedsHumanPanel,
//                                          window.needsHumanReactivate, window.needsHumanDismiss
//                                          (portados del monolito, R3 del architect).
//   - loadTheme()                        → CSS compartido (opcional, igual que home.js).
//
// IDs invariantes preservados (el cliente y los tests los necesitan exactos):
//   - `bloqueados-humano`  raíz del panel (target de toggleNeedsHumanPanel + standalone).
//   - `bloqueados-row-${issueNum}` por fila.
//   - `bloqueados-empty`   empty-state.
//   - `data-section="needs-human"` se mantiene para el mecanismo standalone
//     client-side existente (`?section=needs-human`); `data-slug="bloqueados"`
//     se suma para el smoke CA-G2 + el router #3773 cuando aterrice.
//
// Seguridad (CA-B3 / CA-D1):
//   - Todo dato dinámico pasa por escapeHtmlText (contexto texto) o
//     escapeHtmlAttr (contexto atributo title=/aria-label=) de
//     `lib/escape-html.js` (#3722). NO se reusa el `esc()` global del monolito.
//   - `b.issue` se coacciona con `safeIssueNumber()` antes de interpolar en
//     href/onclick; si no es entero positivo, la fila se descarta.
// =============================================================================

const fs = require('fs');
const path = require('path');

// CA-B3 — helper compartido (#3722). Fallback inline defensivo (CA-A3) por si
// el require falla: el módulo sigue escapando en vez de emitir HTML crudo.
let escapeHtmlText;
let escapeHtmlAttr;
try {
    ({ escapeHtmlText, escapeHtmlAttr } = require('../../lib/escape-html.js'));
} catch (_) {
    const esc = (s) => String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    escapeHtmlText = esc;
    escapeHtmlAttr = esc;
}

const slug = 'bloqueados';

const THEME_CSS_PATH = path.join(__dirname, 'theme.css');
function loadTheme() {
    try { return fs.readFileSync(THEME_CSS_PATH, 'utf8'); }
    catch { return ''; }
}

// --- Severidad (3 umbrales, dual-encoded · CA-E1) --------------------------
// fresh  < 4h   → info    (azul  --in-info)
// warning 4-24h → warning (ámbar --in-warn)
// danger  ≥ 24h → danger  (rojo  --in-bad)
const SEVERITY_WARN_HOURS = 4;
const SEVERITY_DANGER_HOURS = 24;
const REASON_MAX = 280;

// Iconografía: emoji ASCII-friendly (precedente ops.js #3732 cuando el sprite
// no tiene el símbolo). Cada pill combina ícono + texto numérico de edad para
// que la severidad NUNCA dependa solo del color (WCAG AA · CA-E1).
const SEV_META = {
    info:    { icon: 'ℹ', label: 'reciente', aria: 'severidad baja' },
    warning: { icon: '⏳', label: 'demorado', aria: 'severidad media' },
    danger:  { icon: '🚨', label: 'crítico', aria: 'severidad alta' },
};

// Tooltips por acción operativa (CA-C1). Todos van por escapeHtmlAttr.
const TOOLTIPS = {
    toggle: 'Colapsar o expandir el listado de incidentes',
    popout: 'Abrir esta ventana en pantalla independiente',
    reactivate: 'Quitar el label needs-human y devolver el issue a la cola del pipeline',
    dismiss: 'Cerrar el issue como desestimado y limpiarlo del panel',
    severity: 'Antigüedad del bloqueo · marca la urgencia de la intervención',
};

// CA-D1 — coerción numérica estricta antes de interpolar en href/onclick.
// Devuelve el entero positivo o null (→ fila descartada).
function safeIssueNumber(raw) {
    const n = Number(raw);
    return (Number.isInteger(n) && n > 0) ? n : null;
}

function severityOf(ageHours) {
    const h = Number(ageHours);
    if (!Number.isFinite(h)) return 'info';
    if (h >= SEVERITY_DANGER_HOURS) return 'danger';
    if (h >= SEVERITY_WARN_HOURS) return 'warning';
    return 'info';
}

function fmtAge(ageHours) {
    const h = Number(ageHours);
    if (!Number.isFinite(h)) return '—';
    if (h < 1) return Math.max(1, Math.round(h * 60)) + 'min';
    return Math.round(h) + 'h';
}

// Tiempo relativo compacto para los eventos: "ahora" / "12min" / "3h" / "2d".
function relTime(whenIso, nowMs) {
    if (!whenIso) return '';
    const t = Date.parse(whenIso);
    if (!t) return '';
    const min = Math.round(((Number.isFinite(nowMs) ? nowMs : Date.now()) - t) / 60000);
    if (min < 1) return 'ahora';
    if (min < 60) return min + 'min';
    const hr = Math.round(min / 60);
    if (hr < 24) return hr + 'h';
    return Math.round(hr / 24) + 'd';
}

// --- Mini-stats del empty-state -------------------------------------------
// Lectura defensiva de `state.bloqueadosStats` (poblado por una fase futura).
// Si no existe el dato, muestra "—" en vez de inventar métricas.
function readMiniStats(state) {
    const s = (state && state.bloqueadosStats) || {};
    const slaH = Number(s.avg_sla_hours);
    const resolved = Number(s.resolved_today);
    return {
        slaText: (Number.isFinite(slaH) && slaH >= 0)
            ? (slaH < 1 ? Math.round(slaH * 60) + 'min' : Math.round(slaH) + 'h')
            : '—',
        resolvedText: (Number.isFinite(resolved) && resolved >= 0)
            ? String(Math.round(resolved))
            : '—',
    };
}

// --- Render de una fila ----------------------------------------------------
function renderRowSsr(b, nowMs) {
    const issueNum = safeIssueNumber(b && b.issue);
    if (issueNum === null) return ''; // CA-D1 — fila descartada.

    const sev = severityOf(b.age_hours);
    const sevMeta = SEV_META[sev];
    const ageStr = fmtAge(b.age_hours);

    const titleText = b.title ? String(b.title) : '';
    const titleAttr = titleText
        ? escapeHtmlAttr(titleText)
        : escapeHtmlAttr('Issue #' + issueNum);
    const titleHtml = titleText
        ? ' — <span class="v3-bloqueados-issue-title">' + escapeHtmlText(titleText) + '</span>'
        : '';

    const skill = escapeHtmlText(b.skill || '?');
    const phase = escapeHtmlText(b.phase || '?');

    const reasonTxt = (b.question || b.reason || '').toString();
    const reasonHtml = reasonTxt
        ? '<div class="v3-bloqueados-reason">❓ ' + escapeHtmlText(reasonTxt.slice(0, REASON_MAX))
            + (reasonTxt.length > REASON_MAX ? '…' : '') + '</div>'
        : '';

    const summaryTxt = (b.summary || '').toString();
    const summaryHtml = summaryTxt
        ? '<div class="v3-bloqueados-summary">📄 ' + escapeHtmlText(summaryTxt) + '</div>'
        : (b.summary_stale
            ? '<div class="v3-bloqueados-summary v3-bloqueados-summary-loading">📄 <em>Cargando resumen funcional…</em></div>'
            : '');

    const events = Array.isArray(b.recent_events) ? b.recent_events : [];
    const eventsHtml = events.length === 0 ? '' : (
        '<div class="v3-bloqueados-events">'
        + '<div class="v3-bloqueados-events-label">📜 Actividad reciente</div>'
        + '<ul class="v3-bloqueados-events-list">'
        + events.map((ev) =>
            '<li><span class="v3-bloqueados-ev-when">' + escapeHtmlText(relTime(ev && ev.when, nowMs)) + '</span> '
            + '<span class="v3-bloqueados-ev-author">' + escapeHtmlText((ev && ev.author) || '?') + '</span>: '
            + '<span class="v3-bloqueados-ev-text">' + escapeHtmlText((ev && ev.preview) || '') + '</span></li>'
        ).join('')
        + '</ul></div>'
    );

    const sevTitle = escapeHtmlAttr(sevMeta.label + ' · hace ' + ageStr);
    const sevAria = escapeHtmlAttr(sevMeta.aria + ', bloqueado hace ' + ageStr);

    return '<article class="v3-bloqueados-row v3-bloqueados-severity-' + sev + ' needs-human-row" '
        + 'id="bloqueados-row-' + issueNum + '" role="listitem">'
        + '<span class="v3-bloqueados-rail" aria-hidden="true"></span>'
        + '<div class="v3-bloqueados-row-main">'
        + '<div class="v3-bloqueados-row-head needs-human-row-head">'
        + '<span class="v3-bloqueados-severity-pill v3-bloqueados-severity-pill-' + sev + '" '
        +   'title="' + sevTitle + '" aria-label="' + sevAria + '">'
        +   '<span class="v3-bloqueados-sev-icon" aria-hidden="true">' + sevMeta.icon + '</span>'
        +   '<span class="v3-bloqueados-sev-age">' + escapeHtmlText(ageStr) + '</span></span>'
        + '<div class="v3-bloqueados-row-info needs-human-row-info">'
        +   '<a class="v3-bloqueados-issue-link" href="https://github.com/intrale/platform/issues/' + issueNum + '" '
        +     'target="_blank" rel="noopener noreferrer" title="' + titleAttr + '" '
        +     'aria-label="' + escapeHtmlAttr('Abrir issue #' + issueNum + ' en GitHub') + '">'
        +     '<b>#' + issueNum + '</b></a>' + titleHtml
        +   '<span class="v3-bloqueados-ctx"> · ' + skill + ' en ' + phase + '</span>'
        + '</div>'
        + '<div class="v3-bloqueados-row-actions needs-human-row-actions">'
        +   '<button type="button" class="v3-bloqueados-btn v3-bloqueados-btn-reactivate nh-btn nh-btn-reactivate" '
        +     'onclick="needsHumanReactivate(' + issueNum + ')" '
        +     'title="' + escapeHtmlAttr(TOOLTIPS.reactivate) + '" '
        +     'aria-label="' + escapeHtmlAttr('Reactivar issue #' + issueNum) + '">▶ Reactivar</button>'
        +   '<button type="button" class="v3-bloqueados-btn v3-bloqueados-btn-dismiss nh-btn nh-btn-dismiss" '
        +     'onclick="needsHumanDismiss(' + issueNum + ')" '
        +     'title="' + escapeHtmlAttr(TOOLTIPS.dismiss) + '" '
        +     'aria-label="' + escapeHtmlAttr('Desestimar issue #' + issueNum) + '">✕ Desestimar</button>'
        + '</div>'
        + '</div>'
        + summaryHtml
        + reasonHtml
        + eventsHtml
        + '</div>'
        + '</article>';
}

// --- Empty-state celebratorio (CA · UX #3729) ------------------------------
function renderEmptyStateSsr(state) {
    const stats = readMiniStats(state);
    return '<div class="v3-bloqueados-empty" id="bloqueados-empty" role="status">'
        + '<div class="v3-bloqueados-empty-check" aria-hidden="true">✓</div>'
        + '<div class="v3-bloqueados-empty-headline">Nada esperando que alguien decida</div>'
        + '<div class="v3-bloqueados-empty-sub">El pipeline fluye sin intervención humana pendiente.</div>'
        + '<div class="v3-bloqueados-empty-stats">'
        +   '<div class="v3-bloqueados-stat">'
        +     '<span class="v3-bloqueados-stat-value">' + escapeHtmlText(stats.slaText) + '</span>'
        +     '<span class="v3-bloqueados-stat-label">SLA promedio</span></div>'
        +   '<div class="v3-bloqueados-stat">'
        +     '<span class="v3-bloqueados-stat-value">' + escapeHtmlText(stats.resolvedText) + '</span>'
        +     '<span class="v3-bloqueados-stat-label">Resueltos hoy</span></div>'
        + '</div>'
        + '</div>';
}

// Leyenda de severidad embebida (CA-C3).
function renderLegendSsr() {
    return '<div class="v3-bloqueados-legend" aria-label="Leyenda de severidad por antigüedad">'
        + '<span class="v3-bloqueados-legend-item"><span class="v3-bloqueados-legend-dot v3-bloqueados-severity-info" aria-hidden="true"></span>reciente · &lt; 4h</span>'
        + '<span class="v3-bloqueados-legend-item"><span class="v3-bloqueados-legend-dot v3-bloqueados-severity-warning" aria-hidden="true"></span>demorado · 4–24h</span>'
        + '<span class="v3-bloqueados-legend-item"><span class="v3-bloqueados-legend-dot v3-bloqueados-severity-danger" aria-hidden="true"></span>crítico · ≥ 24h</span>'
        + '</div>';
}

// Cabecera del panel (toggle + badge + popout). Mantiene el patrón del monolito
// (clases legacy needs-human-* como alias) + tooltips/aria CA-C1/CA-E.
function renderHeaderSsr(count) {
    return '<h2 class="v3-bloqueados-header needs-human-header" onclick="toggleNeedsHumanPanel()" '
        + 'title="' + escapeHtmlAttr(TOOLTIPS.toggle) + '" '
        + 'aria-label="' + escapeHtmlAttr('Necesitan intervención humana, ' + count + ' incidentes. Click para colapsar o expandir') + '">'
        + '<span class="v3-bloqueados-pulse needs-human-pulse" aria-hidden="true">🚨</span>'
        + 'Necesitan intervención humana'
        + '<span class="v3-bloqueados-badge needs-human-badge">' + count + '</span>'
        + '<span class="v3-bloqueados-chevron needs-human-chevron" aria-hidden="true">▼</span>'
        + '<a class="v3-bloqueados-popout section-popout" href="/?section=needs-human" target="_blank" '
        +   'rel="noopener noreferrer" title="' + escapeHtmlAttr(TOOLTIPS.popout) + '" '
        +   'aria-label="' + escapeHtmlAttr(TOOLTIPS.popout) + '" onclick="event.stopPropagation()">↗</a>'
        + '</h2>';
}

// Fallback inerte visible (CA-A3) — preserva el id del panel para que el
// toggle / standalone no apunten a un nodo inexistente.
function renderInertSsr(msg) {
    const detail = msg
        ? escapeHtmlText(String(msg))
        : 'No se pudo renderizar el listado de bloqueados.';
    return '<div class="v3-bloqueados-inert">'
        + '<div class="v3-bloqueados-empty-headline">Ventana Bloqueados no disponible</div>'
        + '<div class="v3-bloqueados-empty-sub">' + detail + '</div>'
        + '</div>';
}

// --- Render principal SSR --------------------------------------------------
// Siempre devuelve el wrapper <section data-slug="bloqueados"> (smoke CA-G2 +
// router #3773). Con bloqueados → header + lista + footer. Sin bloqueados →
// empty-state celebratorio (la decisión UX #3729 ya NO retorna '').
function renderBloqueadosSsr(state) {
    let inner;
    let emptyMod = '';
    try {
        const list = Array.isArray(state && state.bloqueados) ? state.bloqueados : [];
        const nowMs = Date.now();
        const rows = list.map((b) => renderRowSsr(b, nowMs)).filter(Boolean);

        if (rows.length === 0) {
            emptyMod = ' v3-bloqueados-view-empty';
            inner = renderEmptyStateSsr(state);
        } else {
            inner = renderHeaderSsr(rows.length)
                + '<div class="v3-bloqueados-body needs-human-body">'
                + renderLegendSsr()
                + '<div class="v3-bloqueados-list" id="bloqueados-list" role="list">'
                + rows.join('')
                + '</div>'
                + '<div class="v3-bloqueados-foot">'
                +   'Desbloquear desde Telegram: <code>/unblock &lt;issue&gt; &lt;orientación&gt;</code>'
                +   ' · o quitá el label <code>needs-human</code> en GitHub'
                + '</div>'
                + '</div>';
        }
    } catch (e) {
        emptyMod = ' v3-bloqueados-view-empty';
        inner = renderInertSsr(e && e.message);
    }

    return '<section class="matrix-section needs-human-panel v3-bloqueados-view' + emptyMod + '" '
        + 'id="bloqueados-humano" data-section="needs-human" data-slug="bloqueados" '
        + 'role="region" aria-label="Issues esperando intervención humana">'
        + inner
        + '</section>';
}

// --- Client script (R3 del architect) --------------------------------------
// Porta los handlers globales desde el monolito al módulo, manteniéndolos como
// `window.*` para no romper los `onclick="..."` del SSR ni el KPI rojo
// (dashboard.js:744/5385, scope de #3733, que llama window.toggleNeedsHumanPanel).
// Idempotente vía guard `__bloqueadosWired`. La lógica de fetch a
// /api/needs-human/:issue/:action se preserva idéntica (NO se rediseña acá).
function renderBloqueadosClientScript() {
    return '<script>(function(){\n'
        + '  if (window.__bloqueadosWired) return; window.__bloqueadosWired = true;\n'
        + '  window.toggleNeedsHumanPanel = function(scrollOnExpand){\n'
        + '    var panel = document.getElementById("bloqueados-humano");\n'
        + '    if (!panel) return;\n'
        + '    var willCollapse = !panel.classList.contains("nh-collapsed");\n'
        + '    panel.classList.toggle("nh-collapsed");\n'
        + '    try { localStorage.setItem("nh-panel-collapsed", willCollapse ? "1" : "0"); } catch (e) {}\n'
        + '    if (!willCollapse && scrollOnExpand) { panel.scrollIntoView({behavior:"smooth", block:"start"}); }\n'
        + '  };\n'
        + '  (function restoreNeedsHumanPanelState(){\n'
        + '    try {\n'
        + '      if (localStorage.getItem("nh-panel-collapsed") === "1") {\n'
        + '        var panel = document.getElementById("bloqueados-humano");\n'
        + '        if (panel) panel.classList.add("nh-collapsed");\n'
        + '      }\n'
        + '    } catch (e) {}\n'
        + '  })();\n'
        + '  function nhDisableButtons(issueNum){\n'
        + '    document.querySelectorAll("#bloqueados-humano button[onclick*=\\"(" + issueNum + ")\\"]").forEach(function(b){ b.disabled = true; });\n'
        + '  }\n'
        + '  window.needsHumanReactivate = async function(issueNum){\n'
        + '    if (!confirm("Reactivar #" + issueNum + "? Volverá a la cola del pipeline sin orientación adicional.")) return;\n'
        + '    nhDisableButtons(issueNum);\n'
        + '    try {\n'
        + '      var r = await fetch("/api/needs-human/" + issueNum + "/reactivate", { method: "POST" });\n'
        + '      var j = await r.json();\n'
        + '      if (j.ok) location.reload();\n'
        + '      else { alert("Error reactivando: " + (j.msg || "desconocido")); location.reload(); }\n'
        + '    } catch (e) { alert("Error reactivando: " + e.message); location.reload(); }\n'
        + '  };\n'
        + '  window.needsHumanDismiss = async function(issueNum){\n'
        + '    var reason = prompt("Motivo para desestimar #" + issueNum + " (opcional):", "");\n'
        + '    if (reason === null) return;\n'
        + '    if (!confirm("Cerrar #" + issueNum + " como desestimado? Se quitará del panel y quedará cerrado en GitHub.")) return;\n'
        + '    nhDisableButtons(issueNum);\n'
        + '    try {\n'
        + '      var r = await fetch("/api/needs-human/" + issueNum + "/dismiss", {\n'
        + '        method: "POST",\n'
        + '        headers: { "Content-Type": "application/json" },\n'
        + '        body: JSON.stringify({ reason: reason || "" })\n'
        + '      });\n'
        + '      var j = await r.json();\n'
        + '      if (j.ok) {\n'
        + '        if (j.worktree && j.worktree_warning) {\n'
        + '          var cleanWt = confirm("Issue #" + issueNum + " desestimado.\\n\\nEl worktree tiene trabajo en disco:\\n  " + j.worktree + "\\n\\n¿Limpiar el worktree ahora? (Cancelar = conservar)");\n'
        + '          if (cleanWt) {\n'
        + '            try {\n'
        + '              var rw = await fetch("/api/needs-human/" + issueNum + "/dismiss-worktree", { method: "POST" });\n'
        + '              var jw = await rw.json();\n'
        + '              if (!jw.ok) alert("No pude limpiar el worktree: " + (jw.msg || "desconocido"));\n'
        + '            } catch (e) { alert("Error limpiando worktree: " + e.message); }\n'
        + '          }\n'
        + '        }\n'
        + '        location.reload();\n'
        + '      } else { alert("Error desestimando: " + (j.msg || "desconocido")); location.reload(); }\n'
        + '    } catch (e) { alert("Error desestimando: " + e.message); location.reload(); }\n'
        + '  };\n'
        + '})();</script>';
}

module.exports = {
    slug,
    renderBloqueadosSsr,
    renderBloqueadosClientScript,
    loadTheme,
    // Exports auxiliares para los tests (CA-D / CA-D2).
    safeIssueNumber,
    severityOf,
};
