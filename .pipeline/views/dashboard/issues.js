// =============================================================================
// issues.js — Vista SSR de la ventana Issues del dashboard V3 (ruta `/issues`
// y `?view=issues`).
//
// Issue: #3730 (split de #3715 — rediseño UX integral del dashboard del operador).
//
// Decisión arquitectónica cerrada — Interpretación B (vista OPERACIONAL):
//   El módulo es la vista operacional del backlog (grilla de cards con estado,
//   fase, rebotes, acciones + drilldown). REEMPLAZA a `satellites.renderIssues`
//   (NO a la tabla telemétrica cliente de `/consumo`, que sigue viva hasta que
//   #3735 — Costos — la absorba). Firmada por UX:
//   https://github.com/intrale/platform/issues/3730#issuecomment-4584963619
//   Aceptada por architect + po.
//
// Estructura (mockup `28-issues-panel-v3.svg` + narrativa
// `narrativa-issues-panel-v3.md` en `.pipeline/assets/mockups/`):
//   - renderIssuesHTML(opts)        → página completa de la ventana `/issues`.
//   - renderIssueCard(issue)        → una card operacional (pura, testeable).
//   - renderIssuesClientScript()    → script cliente (polling + filtro + drilldown).
//   - escapeHtmlSsr / escapeHtmlAttr → helpers de escape expuestos para tests.
//
// Seguridad (análisis `security` + `guru` + CA-D1):
//   - TODA interpolación dinámica pasa por escapeHtmlText/escapeHtmlAttr de
//     lib/escape-html.js (#3722); fallback a helpers locales con la misma
//     semántica si el require falla (defensa en profundidad).
//   - renderIssueCard valida `Number.isFinite(num) && num > 0` ANTES de
//     interpolar `issue.number`; retorna '' si falla (R-6).
//   - Cero `onclick="fn(' + valor + ')"`: delegación con data-issue/data-action.
//   - Tooltips con `title=""` HTML nativo escapado con escapeHtmlAttr.
//   - Drilldown con `<dialog>` nativo + showModal() (focus trap del browser) +
//     cierre con Esc (R-5 / CA-UX-7).
//
// Convención V3: SSR del chrome + cards iniciales; el cliente hidrata vía
// fetch JSON (`/api/dash/pipeline`) + re-render del grid. IDs estables
// (#issues-grid, #issues-filter-state, #issues-search, #issues-dialog).
// =============================================================================
'use strict';

const fs = require('node:fs');
const path = require('node:path');

// #3722 — Escape unificado server-side. escapeHtmlText para nodos texto,
// escapeHtmlAttr para contexto atributo (title="", aria-label="", data-*="").
// Require defensivo: si el módulo no aterrizó, helpers locales con la misma
// semántica (escapa & < > " ' /) — el merge no rompe (R-3).
let sharedEscape = null;
try { sharedEscape = require('../../lib/escape-html.js'); } catch { /* opcional */ }

function escapeHtmlSsr(input) {
    if (sharedEscape && typeof sharedEscape.escapeHtmlText === 'function') {
        return sharedEscape.escapeHtmlText(input);
    }
    if (input === null || input === undefined) return '';
    return String(input)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/\//g, '&#x2F;');
}

function escapeHtmlAttr(input) {
    if (sharedEscape && typeof sharedEscape.escapeHtmlAttr === 'function') {
        return sharedEscape.escapeHtmlAttr(input);
    }
    if (input === null || input === undefined) return '';
    return String(input)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/`/g, '&#96;');
}

// #3726 — Nav bar V3 unificada (tab activa = "issues") + sprite compartido.
const { renderNavTabsSsr, loadIconSprite } = require('./nav-tabs');

// #3953 (EP8-H0) — Wrapper único de fetchJson (CA-2: banner stale, nunca traga
// el error en silencio) y framework de modal de confirmación con preview (CA-3)
// que reemplazan el `fetch().catch` silencioso del polling y el confirm() nativo
// de pauseIssue. Mismo patrón que home.js / satellites.js / descanso.js.
const { FETCH_CLIENT_JS, renderStaleBanner } = require('./fetch-client.js');
const { CONFIRM_MODAL_JS } = require('./confirm-modal.js');

const THEME_CSS_PATH = path.join(__dirname, 'theme.css');
const TOKENS_CSS_PATH = path.join(__dirname, '..', '..', 'assets', 'design-tokens.css');

function loadTheme() {
    try { return fs.readFileSync(THEME_CSS_PATH, 'utf8'); } catch { return ''; }
}

// La narrativa UX vincula los estados a tokens semánticos de design-tokens.css
// (--info, --success, --warning, --danger, --purple, --surface-*, --text-*).
// theme.css NO los define (sólo --in-*), así que el módulo inyecta la paleta
// semántica directamente. Si el archivo no existe, el render degrada con los
// fallbacks de cada `var(--token, <in-token>)` del CSS del módulo.
function loadDesignTokens() {
    try { return fs.readFileSync(TOKENS_CSS_PATH, 'utf8'); } catch { return ''; }
}

// =============================================================================
// Modelo de estado operacional (narrativa §2). Cada estado = color semántico +
// label de texto + ícono → NUNCA color-only (WCAG 1.4.1).
// =============================================================================
const STATE_META = {
    trabajando:    { label: 'Trabajando',      cls: 'st-working' },
    listo:         { label: 'Listo',           cls: 'st-ready' },
    pendiente:     { label: 'Pendiente',       cls: 'st-pending' },
    bloqueado:     { label: 'Bloqueado',       cls: 'st-blocked' },
    rebote:        { label: 'Rebote',          cls: 'st-bounce' },
    'needs-human': { label: 'Necesita humano', cls: 'st-human' },
};

// Deriva el estado operacional de un issue a partir de labels + estado del
// pipeline. Prioridad: rebote > needs-human > bloqueado > estado activo.
// Pura, sin efectos — reusable por SSR y replicada en el cliente.
function deriveState(issue) {
    const labels = Array.isArray(issue && issue.labels) ? issue.labels : [];
    if (issue && issue.rebote) return 'rebote';
    if (labels.includes('needs-human')) return 'needs-human';
    if (labels.includes('blocked:dependencies')) return 'bloqueado';
    const estado = issue && issue.estadoActual;
    if (estado === 'trabajando' || estado === 'listo' || estado === 'pendiente') return estado;
    return 'pendiente';
}

// Fases canónicas del pipeline (orden de lectura del timeline del drilldown).
const FASE_ORDER = [
    'sizing', 'analisis', 'criterios', 'validacion', 'dev',
    'build', 'verificacion', 'linteo', 'aprobacion', 'entrega',
];

// Ícono de fase del sprite. Si la fase no tiene ícono propio, cae a un genérico
// (ic-issues-count) — documentado en el inventario, sin SVG inline.
const FASE_WITH_ICON = new Set([
    'sizing', 'analisis', 'criterios', 'validacion', 'dev',
    'build', 'verificacion', 'linteo', 'aprobacion', 'entrega',
]);
function faseIconId(fase) {
    return FASE_WITH_ICON.has(fase) ? 'ic-fase-' + fase : 'ic-issues-count';
}

// Helper SSR: emite un <svg><use href="#id"></svg>. El `id` SIEMPRE viene de un
// catálogo interno (jamás del usuario) → no requiere escape, pero se acota a
// [a-z0-9-] por defensa.
function iconSvg(id, cls) {
    const safe = String(id || '').replace(/[^a-z0-9-]/g, '');
    const klass = cls ? ' class="' + cls + '"' : '';
    return '<svg' + klass + ' aria-hidden="true" focusable="false" viewBox="0 0 24 24">'
        + '<use href="#' + safe + '"></use></svg>';
}

// =============================================================================
// Normalización de un issue del snapshot (matrix de pipelineSlice) al shape que
// consume renderIssueCard. Defensivo ante campos ausentes.
// =============================================================================
function normalizeIssue(id, data, priorityIndex) {
    const d = data || {};
    return {
        number: Number(id),
        title: d.title || '',
        labels: Array.isArray(d.labels) ? d.labels : [],
        faseActual: d.faseActual || null,
        estadoActual: d.estadoActual || null,
        bounces: Number(d.bounces) || 0,
        rebote: !!d.rebote,
        motivo_rechazo: d.motivo_rechazo || null,
        rechazado_en_fase: d.rechazado_en_fase || null,
        rechazado_skill_previo: d.rechazado_skill_previo || null,
        priority: (typeof priorityIndex === 'number' && priorityIndex >= 0)
            ? priorityIndex + 1 : null,
    };
}

// Acciones operativas de cada card (narrativa §3.5). Glyph en `glyph` (texto
// unicode, NO svg) o `icon` (sprite). Todas con tooltip `title` estático.
const CARD_ACTIONS = [
    { action: 'move-top',    icon: 'ic-promote', title: 'Mover a máxima prioridad' },
    { action: 'move-up',     glyph: '▲',         title: 'Subir un puesto' },
    { action: 'move-down',   glyph: '▼',         title: 'Bajar un puesto' },
    { action: 'move-bottom', glyph: '▼▼',        title: 'Mover a mínima prioridad' },
];

// =============================================================================
// renderIssueCard(issue) — una card operacional. PURA y testeable.
// Retorna '' si el número de issue no es válido (R-6, CA-D1 test 4).
// =============================================================================
function renderIssueCard(issue) {
    const num = Number(issue && issue.number);
    if (!Number.isFinite(num) || num <= 0) return '';

    const i = issue || {};
    const stateKey = deriveState(i);
    const meta = STATE_META[stateKey] || STATE_META.pendiente;
    const labels = Array.isArray(i.labels) ? i.labels : [];
    const paused = labels.includes('blocked:dependencies');

    const title = i.title || '';
    const titleEsc = escapeHtmlSsr(title);
    const titleAttr = escapeHtmlAttr(title);

    const fase = i.faseActual || '—';
    const faseEsc = escapeHtmlSsr(fase);
    const bounces = Number(i.bounces) || 0;
    const prio = (typeof i.priority === 'number' && i.priority > 0) ? '#' + i.priority : '—';

    const ghUrl = 'https://github.com/intrale/platform/issues/' + num;

    // Chip de estado: color + ícono(glyph CSS) + texto (nunca solo color).
    const stateChip = '<span class="iss-state ' + meta.cls + '">'
        + escapeHtmlSsr(meta.label) + '</span>';

    // Chip rebote con motivo truncado y escapado en el tooltip.
    let reboteChip = '';
    if (i.rebote) {
        const motivo = String(i.motivo_rechazo || '').slice(0, 300);
        const faseRej = i.rechazado_en_fase || '?';
        const skillRej = i.rechazado_skill_previo ? ('/' + i.rechazado_skill_previo) : '';
        const tip = 'Rechazado en ' + faseRej + skillRej + ': ' + motivo;
        reboteChip = '<span class="iss-rebote" title="' + escapeHtmlAttr(tip) + '">'
            + '↩ rechazo</span>';
    }

    // Badge de bounces (amber si > 2).
    const bouncesBadge = bounces > 0
        ? '<span class="iss-bounces' + (bounces > 2 ? ' warn' : '') + '" '
          + 'title="' + escapeHtmlAttr(bounces + ' rebote(s) acumulados') + '">'
          + escapeHtmlSsr(String(bounces)) + '×</span>'
        : '';

    // Acciones de prioridad (delegación por data-action, sin onclick inline).
    let actionsHtml = '';
    for (const a of CARD_ACTIONS) {
        const inner = a.icon ? iconSvg(a.icon, 'iss-ico') : escapeHtmlSsr(a.glyph);
        actionsHtml += '<button type="button" class="iss-btn" '
            + 'data-issue="' + num + '" data-action="' + a.action + '" '
            + 'title="' + escapeHtmlAttr(a.title) + '" '
            + 'aria-label="' + escapeHtmlAttr(a.title + ' (issue ' + num + ')') + '">'
            + inner + '</button>';
    }
    // Pausar / reanudar.
    const pauseAction = paused ? 'resume' : 'pause';
    const pauseTitle = paused ? 'Reanudar issue' : 'Pausar issue';
    const pauseIcon = paused ? 'ic-play' : 'ic-pause-lock';
    actionsHtml += '<button type="button" class="iss-btn iss-pause' + (paused ? ' is-paused' : '') + '" '
        + 'data-issue="' + num + '" data-action="' + pauseAction + '" '
        + 'title="' + escapeHtmlAttr(pauseTitle) + '" '
        + 'aria-label="' + escapeHtmlAttr(pauseTitle + ' (issue ' + num + ')') + '">'
        + iconSvg(pauseIcon, 'iss-ico') + '</button>';
    // Abrir en GitHub (link, no acción de estado).
    actionsHtml += '<a class="iss-btn iss-gh" href="' + escapeHtmlAttr(ghUrl) + '" '
        + 'target="_blank" rel="noopener" '
        + 'title="Abrir en GitHub" '
        + 'aria-label="' + escapeHtmlAttr('Abrir issue ' + num + ' en GitHub') + '">'
        + iconSvg('ic-link-out', 'iss-ico') + '</a>';

    const ariaLabel = 'Issue ' + num + ': ' + title
        + ', fase ' + fase + ', estado ' + meta.label;
    const titleCls = 'iss-title' + (paused ? ' is-paused' : '');

    return '<article class="iss-card" tabindex="0" role="article" '
        + 'data-issue="' + num + '" data-state="' + stateKey + '" '
        + 'data-fase="' + escapeHtmlAttr(fase) + '" '
        + 'aria-label="' + escapeHtmlAttr(ariaLabel) + '">'
        + '<div class="iss-top">'
        +   '<span class="iss-prio' + (i.priority ? ' set' : '') + '" '
        +     'title="' + escapeHtmlAttr(i.priority ? ('Prioridad ' + prio) : 'Sin orden manual') + '">'
        +     escapeHtmlSsr(prio) + '</span>'
        +   '<a class="iss-num" href="' + escapeHtmlAttr(ghUrl) + '" target="_blank" '
        +     'rel="noopener" title="' + escapeHtmlAttr('Abrir issue ' + num + ' en GitHub') + '">#'
        +     num + '</a>'
        +   stateChip
        + '</div>'
        + '<div class="' + titleCls + '" title="' + titleAttr + '">' + titleEsc + '</div>'
        + '<div class="iss-meta">'
        +   '<span class="iss-fase">' + iconSvg(faseIconId(i.faseActual), 'iss-ico')
        +     '<span>' + faseEsc + '</span></span>'
        +   bouncesBadge
        +   reboteChip
        + '</div>'
        + '<div class="iss-actions" role="group" aria-label="' + escapeHtmlAttr('Acciones del issue ' + num) + '">'
        +   actionsHtml
        + '</div>'
        + '</article>';
}

// =============================================================================
// renderIssuesFilterBar() — barra de filtros (narrativa §3.2). role="toolbar".
// Chips de estado con aria-pressed + search + filtro de fase. Estática (sin
// datos del usuario) → texto literal.
// =============================================================================
const FILTER_CHIPS = [
    { filter: 'all',        label: 'Todos',      tip: 'Mostrar todos los issues activos' },
    { filter: 'trabajando', label: 'Trabajando', tip: 'Sólo issues con un agente trabajando' },
    { filter: 'listo',      label: 'Listos',     tip: 'Sólo issues listos para la siguiente fase' },
    { filter: 'bloqueado',  label: 'Bloqueados', tip: 'Sólo issues bloqueados por dependencias' },
    { filter: 'rebote',     label: 'Rebotes',    tip: 'Sólo issues que rebotaron de una fase posterior' },
];

function renderIssuesFilterBar() {
    let chips = '';
    for (const c of FILTER_CHIPS) {
        const active = c.filter === 'all';
        chips += '<button type="button" class="iss-chip' + (active ? ' is-active' : '') + '" '
            + 'data-filter="' + c.filter + '" '
            + 'aria-pressed="' + (active ? 'true' : 'false') + '" '
            + 'title="' + escapeHtmlAttr(c.tip) + '" '
            + 'aria-label="' + escapeHtmlAttr(c.tip) + '">'
            + escapeHtmlSsr(c.label) + '</button>';
    }
    return '<div class="iss-filter-bar" role="toolbar" aria-label="Filtros de issues">'
        + '<div class="iss-chips">' + chips + '</div>'
        + '<input type="search" id="issues-search" class="iss-search" '
        +   'placeholder="Filtrar por #número, fase o título…" '
        +   'title="Filtrar issues por número, fase o título" '
        +   'aria-label="Filtrar issues por número, fase o título">'
        + '</div>';
}

// =============================================================================
// renderIssuesDialog() — drilldown <dialog> nativo (narrativa §3.4). El
// contenido se rellena client-side con textContent (sin innerHTML de datos
// del usuario). focus trap nativo de showModal() + cierre con Esc (CA-UX-7).
// =============================================================================
function renderIssuesDialog() {
    return '<dialog id="issues-dialog" class="iss-dialog" aria-labelledby="issues-dialog-title">'
        + '<form method="dialog" class="iss-dialog-head">'
        +   '<h2 id="issues-dialog-title" class="iss-dialog-title">Issue</h2>'
        +   '<button type="submit" class="iss-dialog-close" title="Cerrar" aria-label="Cerrar detalle">✕</button>'
        + '</form>'
        + '<div class="iss-dialog-body">'
        +   '<div id="issues-dialog-meta" class="iss-dialog-meta"></div>'
        +   '<div id="issues-dialog-reject" class="iss-dialog-reject" hidden></div>'
        +   '<ol id="issues-dialog-timeline" class="iss-dialog-timeline" aria-label="Timeline de fases"></ol>'
        +   '<div id="issues-dialog-actions" class="iss-dialog-actions"></div>'
        + '</div>'
        + '</dialog>';
}

// =============================================================================
// CSS del módulo. SOLO tokens (cero HEX literal en color:/background:, CA-UX-2).
// Los `var(--token, var(--in-token))` usan tokens de fallback — nunca HEX.
// =============================================================================
const ISSUES_CSS = `
.iss-frame { max-width: 1440px; margin: 0 auto; padding: 0; }
.iss-body { padding: 22px 28px; display: flex; flex-direction: column; gap: 18px; }

.iss-rail {
    height: 3px; border-radius: 2px; margin-bottom: 4px;
    background: linear-gradient(90deg, var(--brand-cyan, var(--in-accent)), var(--brand-blue, var(--in-brand)));
}

.iss-summary {
    font-size: 12px; color: var(--text-secondary, var(--in-fg-dim));
    font-variant-numeric: tabular-nums; display: flex; gap: 6px; align-items: baseline;
}
.iss-summary strong { color: var(--text-primary, var(--in-fg)); font-weight: 700; }

.iss-filter-bar {
    display: flex; flex-direction: column; gap: 12px;
    background: var(--surface-1, var(--in-bg-2)); border: 1px solid var(--border, var(--in-border));
    border-radius: var(--in-radius, 12px); padding: 14px 16px;
}
.iss-chips { display: flex; flex-wrap: wrap; gap: 8px; }
.iss-chip {
    display: inline-flex; align-items: center; min-height: 32px; padding: 0 14px;
    border-radius: 999px; border: 1px solid var(--border, var(--in-border));
    background: var(--surface-2, var(--in-bg-3)); color: var(--text-secondary, var(--in-fg-dim));
    font-size: 12px; font-weight: 500; cursor: pointer; user-select: none;
    transition: border-color 0.12s, color 0.12s, background 0.12s;
}
.iss-chip:hover { border-color: var(--border-strong, var(--in-fg-dim)); color: var(--text-primary, var(--in-fg)); }
.iss-chip.is-active {
    background: var(--info-bg, var(--in-info-soft)); border-color: var(--info, var(--in-info));
    color: var(--info, var(--in-info)); font-weight: 700;
}
.iss-chip:focus-visible { outline: 2px solid var(--border-strong, var(--in-accent)); outline-offset: 2px; }
.iss-search {
    width: 100%; box-sizing: border-box; padding: 10px 14px; font-size: 13px;
    background: var(--surface-2, var(--in-bg-3)); color: var(--text-primary, var(--in-fg));
    border: 1px solid var(--border, var(--in-border)); border-radius: var(--in-radius-sm, 8px);
}
.iss-search:focus { outline: none; border-color: var(--info, var(--in-accent)); }

.iss-grid {
    display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 14px;
}
.iss-empty {
    grid-column: 1 / -1; text-align: center; padding: 40px 16px;
    color: var(--text-dim, var(--in-fg-dim)); font-size: 13px;
}

.iss-card {
    position: relative; display: flex; flex-direction: column; gap: 10px;
    background: var(--surface-1, var(--in-bg-2)); border: 1px solid var(--border, var(--in-border));
    border-radius: var(--in-radius, 12px); padding: 14px 16px;
    box-shadow: var(--in-shadow, none); cursor: pointer; min-height: 148px;
    transition: border-color 0.12s, transform 0.12s;
}
.iss-card:hover { border-color: var(--border-strong, var(--in-accent)); }
.iss-card:focus-visible { outline: 2px solid var(--border-strong, var(--in-accent)); outline-offset: 2px; }
.iss-top { display: flex; align-items: center; gap: 10px; }
.iss-prio {
    font-size: 11px; color: var(--text-dim, var(--in-fg-soft)); font-variant-numeric: tabular-nums;
    min-width: 26px;
}
.iss-prio.set { color: var(--text-secondary, var(--in-fg-dim)); font-weight: 700; }
.iss-num {
    font-weight: 700; font-size: 14px; color: var(--info, var(--in-info));
    text-decoration: none; font-variant-numeric: tabular-nums;
}
.iss-num:hover { text-decoration: underline; }
.iss-state {
    margin-left: auto; display: inline-flex; align-items: center; gap: 5px;
    font-size: 11px; font-weight: 600; padding: 3px 9px; border-radius: 999px;
    border: 1px solid transparent; text-transform: none; letter-spacing: 0.2px;
}
.iss-state::before { content: "●"; font-size: 9px; }
.st-working { color: var(--info, var(--in-info)); background: var(--info-bg, var(--in-info-soft)); border-color: var(--info, var(--in-info)); }
.st-ready   { color: var(--success, var(--in-ok)); background: var(--success-bg, var(--in-ok-soft)); border-color: var(--success, var(--in-ok)); }
.st-pending { color: var(--text-dim, var(--in-fg-dim)); background: var(--surface-2, var(--in-bg-3)); border-color: var(--border, var(--in-border)); }
.st-blocked { color: var(--warning, var(--in-warn)); background: var(--warning-bg, var(--in-warn-soft)); border-color: var(--warning, var(--in-warn)); }
.st-bounce  { color: var(--danger, var(--in-bad)); background: var(--danger-bg, var(--in-bad-soft)); border-color: var(--danger, var(--in-bad)); }
.st-human   { color: var(--purple, var(--in-accent)); background: var(--purple-bg, var(--in-accent-soft)); border-color: var(--purple, var(--in-accent)); }

.iss-title {
    font-size: 13px; line-height: 1.4; color: var(--text-primary, var(--in-fg));
    display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
    overflow: hidden; min-height: 36px;
}
.iss-title.is-paused::before { content: "⏸ "; color: var(--warning, var(--in-warn)); font-weight: 700; }

.iss-meta { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.iss-fase {
    display: inline-flex; align-items: center; gap: 5px;
    font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px;
    color: var(--text-secondary, var(--in-fg-dim));
}
.iss-ico { width: 14px; height: 14px; fill: currentColor; }
.iss-bounces {
    font-size: 11px; color: var(--text-dim, var(--in-fg-dim)); font-variant-numeric: tabular-nums;
}
.iss-bounces.warn { color: var(--warning, var(--in-warn)); font-weight: 600; }
.iss-rebote {
    display: inline-flex; align-items: center; font-size: 10px; font-weight: 600;
    color: var(--danger, var(--in-bad)); border: 1px solid var(--danger, var(--in-bad));
    background: var(--danger-bg, var(--in-bad-soft)); border-radius: 4px; padding: 1px 6px; cursor: help;
}

.iss-actions { display: flex; gap: 4px; margin-top: auto; }
.iss-btn {
    display: inline-flex; align-items: center; justify-content: center;
    width: 30px; height: 30px; padding: 0; border-radius: 6px; cursor: pointer;
    background: transparent; border: 1px solid var(--border, var(--in-border));
    color: var(--text-secondary, var(--in-fg-dim)); font-size: 12px; line-height: 1;
    text-decoration: none; transition: border-color 0.12s, color 0.12s, background 0.12s;
}
.iss-btn:hover { border-color: var(--info, var(--in-accent)); color: var(--info, var(--in-accent)); }
.iss-btn:focus-visible { outline: 2px solid var(--border-strong, var(--in-accent)); outline-offset: 1px; }
.iss-btn.iss-pause:hover { border-color: var(--warning, var(--in-warn)); color: var(--warning, var(--in-warn)); }
.iss-btn.iss-pause.is-paused { border-color: var(--warning, var(--in-warn)); color: var(--warning, var(--in-warn)); }

/* Drilldown dialog */
.iss-dialog {
    width: min(560px, 92vw); border: 1px solid var(--border, var(--in-border));
    border-radius: var(--in-radius, 12px); background: var(--surface-1, var(--in-bg-2));
    color: var(--text-primary, var(--in-fg)); padding: 0;
}
.iss-dialog::backdrop { background: rgba(1, 4, 9, 0.66); }
.iss-dialog-head {
    display: flex; align-items: center; gap: 10px; margin: 0;
    padding: 16px 18px; border-bottom: 1px solid var(--border, var(--in-border));
}
.iss-dialog-title { font-size: 15px; margin: 0; flex: 1; color: var(--text-primary, var(--in-fg)); }
.iss-dialog-close {
    background: transparent; border: 1px solid var(--border, var(--in-border));
    color: var(--text-secondary, var(--in-fg-dim)); border-radius: 6px;
    width: 30px; height: 30px; cursor: pointer; font-size: 13px;
}
.iss-dialog-close:hover { border-color: var(--danger, var(--in-bad)); color: var(--danger, var(--in-bad)); }
.iss-dialog-body { padding: 16px 18px; display: flex; flex-direction: column; gap: 14px; }
.iss-dialog-meta { font-size: 12px; color: var(--text-secondary, var(--in-fg-dim)); }
.iss-dialog-reject {
    font-size: 12px; line-height: 1.4; padding: 10px 12px; border-radius: 8px;
    background: var(--danger-bg, var(--in-bad-soft)); border: 1px solid var(--danger, var(--in-bad));
    color: var(--text-primary, var(--in-fg)); white-space: pre-wrap; word-break: break-word;
}
.iss-dialog-timeline { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.iss-dialog-phase {
    display: flex; align-items: center; gap: 8px; font-size: 12px;
    color: var(--text-secondary, var(--in-fg-dim));
}
.iss-dialog-phase[data-current="1"] { color: var(--info, var(--in-info)); font-weight: 700; }
.iss-dialog-actions { display: flex; gap: 8px; flex-wrap: wrap; }
.iss-dialog-actions a, .iss-dialog-actions button {
    display: inline-flex; align-items: center; gap: 6px; min-height: 36px; padding: 0 14px;
    border-radius: 8px; font-size: 12px; cursor: pointer; text-decoration: none;
    background: var(--surface-2, var(--in-bg-3)); border: 1px solid var(--border, var(--in-border));
    color: var(--text-primary, var(--in-fg));
}
.iss-dialog-actions a:hover, .iss-dialog-actions button:hover { border-color: var(--info, var(--in-accent)); }

/* Toast de feedback para acciones de card (#3730). Tokens, sin HEX. */
.iss-toast {
    position: fixed; left: 50%; bottom: 28px; transform: translateX(-50%);
    z-index: 9999; padding: 10px 18px; border-radius: var(--in-radius-sm, 8px);
    font-size: 13px; font-weight: 600; line-height: 1.4; max-width: 80vw;
    text-align: center; pointer-events: none; opacity: 0;
    transition: opacity 0.2s ease; box-shadow: var(--in-shadow, none);
    color: var(--text-primary, var(--in-fg));
    background: var(--success-bg, var(--in-ok-soft));
    border: 1px solid var(--success, var(--in-ok));
}
.iss-toast.is-show { opacity: 1; }
.iss-toast.is-err {
    background: var(--danger-bg, var(--in-bad-soft));
    border-color: var(--danger, var(--in-bad));
}
`;

// =============================================================================
// renderIssuesClientScript() — JS cliente. Polling a /api/dash/pipeline +
// re-render del grid + filtro + drilldown. Estado con nombres propios
// (issuesSnapshot, selectedIssueId) para no colisionar con /consumo (R-2).
//
// El cliente escapa TODO valor dinámico con escapeHtml() (escapa & < > " ' /)
// antes de componer markup — mismo patrón que satellites.renderIssues. El
// contenido del drilldown se llena con textContent (sin innerHTML de datos).
// =============================================================================
function renderIssuesClientScript() {
    return `
'use strict';
(function () {
  var ISS_GH = 'https://github.com/intrale/platform/issues/';
  var STATE_LABEL = { trabajando:'Trabajando', listo:'Listo', pendiente:'Pendiente', bloqueado:'Bloqueado', rebote:'Rebote', 'needs-human':'Necesita humano' };
  var STATE_CLS = { trabajando:'st-working', listo:'st-ready', pendiente:'st-pending', bloqueado:'st-blocked', rebote:'st-bounce', 'needs-human':'st-human' };
  var FASE_ORDER = ['sizing','analisis','criterios','validacion','dev','build','verificacion','linteo','aprobacion','entrega'];
  var FASE_ICON = {};
  FASE_ORDER.forEach(function (f) { FASE_ICON[f] = 'ic-fase-' + f; });
  var ACTIONS = [
    { action:'move-top', icon:'ic-promote', title:'Mover a máxima prioridad' },
    { action:'move-up', glyph:'▲', title:'Subir un puesto' },
    { action:'move-down', glyph:'▼', title:'Bajar un puesto' },
    { action:'move-bottom', glyph:'▼▼', title:'Mover a mínima prioridad' }
  ];

  var issuesSnapshot = null;
  var selectedIssueId = null;
  var activeFilter = 'all';
  var searchTerm = '';

  function escapeHtml(s) {
    if (s === null || s === undefined) return '';
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/\\//g, '&#x2F;');
  }
  function iconSvg(id, cls) {
    var safe = String(id || '').replace(/[^a-z0-9-]/g, '');
    return '<svg class="' + cls + '" aria-hidden="true" focusable="false" viewBox="0 0 24 24"><use href="#' + safe + '"></use></svg>';
  }
  function deriveState(d) {
    var labels = (d && d.labels) || [];
    if (d && d.rebote) return 'rebote';
    if (labels.indexOf('needs-human') >= 0) return 'needs-human';
    if (labels.indexOf('blocked:dependencies') >= 0) return 'bloqueado';
    var e = d && d.estadoActual;
    if (e === 'trabajando' || e === 'listo' || e === 'pendiente') return e;
    return 'pendiente';
  }
  function faseIconId(f) { return FASE_ICON[f] || 'ic-issues-count'; }

  function orderedIssues() {
    if (!issuesSnapshot) return [];
    var matrix = issuesSnapshot.matrix || {};
    var order = issuesSnapshot.priorityOrder || [];
    var orderMap = {};
    order.forEach(function (id, idx) { orderMap[String(id)] = idx; });
    var rows = Object.keys(matrix).map(function (id) {
      var idx = orderMap.hasOwnProperty(String(id)) ? orderMap[String(id)] : -1;
      return { id: id, data: matrix[id], prio: idx };
    });
    rows.sort(function (a, b) {
      if (a.prio >= 0 && b.prio >= 0) return a.prio - b.prio;
      if (a.prio >= 0) return -1;
      if (b.prio >= 0) return 1;
      return Number(a.id) - Number(b.id);
    });
    return rows;
  }

  function matchesFilter(row) {
    var st = deriveState(row.data);
    if (activeFilter !== 'all' && st !== activeFilter) return false;
    if (searchTerm) {
      var hay = (row.id + ' ' + (row.data.title || '') + ' ' + (row.data.faseActual || '')).toLowerCase();
      if (hay.indexOf(searchTerm) < 0) return false;
    }
    return true;
  }

  function cardHtml(row) {
    var num = Number(row.id);
    if (!isFinite(num) || num <= 0) return '';
    var d = row.data || {};
    var st = deriveState(d);
    var cls = STATE_CLS[st] || 'st-pending';
    var label = STATE_LABEL[st] || 'Pendiente';
    var labels = d.labels || [];
    var paused = labels.indexOf('blocked:dependencies') >= 0;
    var prio = (row.prio >= 0) ? '#' + (row.prio + 1) : '—';
    var fase = d.faseActual || '—';
    var bounces = Number(d.bounces) || 0;
    var gh = ISS_GH + num;

    var rebote = '';
    if (d.rebote) {
      var motivo = String(d.motivo_rechazo || '').slice(0, 300);
      var tip = 'Rechazado en ' + (d.rechazado_en_fase || '?') + (d.rechazado_skill_previo ? '/' + d.rechazado_skill_previo : '') + ': ' + motivo;
      rebote = '<span class="iss-rebote" title="' + escapeHtml(tip) + '">↩ rechazo</span>';
    }
    var bbadge = bounces > 0
      ? '<span class="iss-bounces' + (bounces > 2 ? ' warn' : '') + '" title="' + escapeHtml(bounces + ' rebote(s) acumulados') + '">' + escapeHtml(String(bounces)) + '×</span>'
      : '';

    var actions = '';
    ACTIONS.forEach(function (a) {
      var inner = a.icon ? iconSvg(a.icon, 'iss-ico') : escapeHtml(a.glyph);
      actions += '<button type="button" class="iss-btn" data-issue="' + num + '" data-action="' + a.action + '" title="' + escapeHtml(a.title) + '" aria-label="' + escapeHtml(a.title + ' (issue ' + num + ')') + '">' + inner + '</button>';
    });
    var pAction = paused ? 'resume' : 'pause';
    var pTitle = paused ? 'Reanudar issue' : 'Pausar issue';
    var pIcon = paused ? 'ic-play' : 'ic-pause-lock';
    actions += '<button type="button" class="iss-btn iss-pause' + (paused ? ' is-paused' : '') + '" data-issue="' + num + '" data-action="' + pAction + '" title="' + escapeHtml(pTitle) + '" aria-label="' + escapeHtml(pTitle + ' (issue ' + num + ')') + '">' + iconSvg(pIcon, 'iss-ico') + '</button>';
    actions += '<a class="iss-btn iss-gh" href="' + escapeHtml(gh) + '" target="_blank" rel="noopener" title="Abrir en GitHub" aria-label="' + escapeHtml('Abrir issue ' + num + ' en GitHub') + '">' + iconSvg('ic-link-out', 'iss-ico') + '</a>';

    var aria = 'Issue ' + num + ': ' + (d.title || '') + ', fase ' + fase + ', estado ' + label;
    return '<article class="iss-card" tabindex="0" role="article" data-issue="' + num + '" data-state="' + st + '" data-fase="' + escapeHtml(fase) + '" aria-label="' + escapeHtml(aria) + '">'
      + '<div class="iss-top"><span class="iss-prio' + (row.prio >= 0 ? ' set' : '') + '">' + escapeHtml(prio) + '</span>'
      + '<a class="iss-num" href="' + escapeHtml(gh) + '" target="_blank" rel="noopener">#' + num + '</a>'
      + '<span class="iss-state ' + cls + '">' + escapeHtml(label) + '</span></div>'
      + '<div class="iss-title' + (paused ? ' is-paused' : '') + '" title="' + escapeHtml(d.title || '') + '">' + escapeHtml(d.title || '') + '</div>'
      + '<div class="iss-meta"><span class="iss-fase">' + iconSvg(faseIconId(d.faseActual), 'iss-ico') + '<span>' + escapeHtml(fase) + '</span></span>' + bbadge + rebote + '</div>'
      + '<div class="iss-actions" role="group" aria-label="' + escapeHtml('Acciones del issue ' + num) + '">' + actions + '</div>'
      + '</article>';
  }

  function renderGrid() {
    var grid = document.getElementById('issues-grid');
    if (!grid || !issuesSnapshot) return;
    var rows = orderedIssues().filter(matchesFilter);
    updateSummary();
    if (rows.length === 0) {
      grid.innerHTML = '<div class="iss-empty">Sin issues que coincidan con el filtro</div>';
      return;
    }
    grid.innerHTML = rows.slice(0, 200).map(cardHtml).join('');
  }

  function updateSummary() {
    var el = document.getElementById('issues-summary');
    if (!el || !issuesSnapshot) return;
    var rows = orderedIssues();
    var counts = { trabajando: 0, listo: 0, bloqueado: 0 };
    rows.forEach(function (r) { var s = deriveState(r.data); if (counts.hasOwnProperty(s)) counts[s]++; });
    el.innerHTML = '<strong>' + rows.length + '</strong> issues · '
      + '<strong>' + counts.trabajando + '</strong> trabajando · '
      + '<strong>' + counts.listo + '</strong> listos · '
      + '<strong>' + counts.bloqueado + '</strong> bloqueados';
  }

  function openDrilldown(issueId) {
    var dlg = document.getElementById('issues-dialog');
    if (!dlg || !issuesSnapshot) return;
    var d = (issuesSnapshot.matrix || {})[issueId];
    if (!d) return;
    selectedIssueId = issueId;
    var num = Number(issueId);
    var st = deriveState(d);
    document.getElementById('issues-dialog-title').textContent = '#' + issueId + ' · ' + (d.title || '');
    var meta = document.getElementById('issues-dialog-meta');
    meta.textContent = 'Estado: ' + (STATE_LABEL[st] || st) + ' · Fase: ' + (d.faseActual || '—') + ' · Rebotes: ' + (Number(d.bounces) || 0);

    var rej = document.getElementById('issues-dialog-reject');
    if (d.rebote && d.motivo_rechazo) {
      rej.textContent = 'Rechazado en ' + (d.rechazado_en_fase || '?') + (d.rechazado_skill_previo ? '/' + d.rechazado_skill_previo : '') + ': ' + String(d.motivo_rechazo).slice(0, 300);
      rej.hidden = false;
    } else { rej.hidden = true; rej.textContent = ''; }

    var tl = document.getElementById('issues-dialog-timeline');
    tl.innerHTML = '';
    FASE_ORDER.forEach(function (f) {
      var li = document.createElement('li');
      li.className = 'iss-dialog-phase';
      if (f === d.faseActual) li.setAttribute('data-current', '1');
      li.innerHTML = iconSvg(faseIconId(f), 'iss-ico');
      var span = document.createElement('span');
      span.textContent = f;
      li.appendChild(span);
      tl.appendChild(li);
    });

    var acts = document.getElementById('issues-dialog-actions');
    acts.innerHTML = '';
    var gh = document.createElement('a');
    gh.href = ISS_GH + num; gh.target = '_blank'; gh.rel = 'noopener';
    gh.textContent = 'Abrir en GitHub';
    acts.appendChild(gh);

    if (typeof dlg.showModal === 'function') dlg.showModal();
    else dlg.setAttribute('open', '');
  }

  // Feedback transitorio autocontenido. Reusa window.showToast si la página
  // anfitriona lo provee (parity con home.js); si no, fabrica un toast inline
  // con estilos propios para no depender de scripts externos no cargados en
  // /issues ni ?view=issues (#3730 — fix controles muertos).
  function issToast(msg, ok) {
    if (typeof window.showToast === 'function') {
      try { window.showToast(msg, ok); return; } catch (e) { /* fallback abajo */ }
    }
    var t = document.getElementById('iss-toast');
    if (!t) {
      t = document.createElement('div');
      t.id = 'iss-toast';
      t.className = 'iss-toast';
      t.setAttribute('role', 'status');
      t.setAttribute('aria-live', 'polite');
      document.body.appendChild(t);
    }
    t.textContent = msg;
    t.classList.toggle('is-err', !ok);
    t.classList.add('is-show');
    clearTimeout(t._hide);
    t._hide = setTimeout(function () { t.classList.remove('is-show'); }, 3200);
  }

  // moveIssue(issue, action) — POST /api/issue/<id>/<action> para reordenar el
  // backlog (action ∈ move-top|move-up|move-down|move-bottom). Espeja home.js:2346.
  async function moveIssue(issue, action) {
    try {
      var res = await fetch('/api/issue/' + encodeURIComponent(issue) + '/' + encodeURIComponent(action), { method: 'POST' });
      var j = {};
      try { j = await res.json(); } catch (e) { /* respuesta sin JSON */ }
      issToast(j.msg || (res.ok ? 'Movido' : 'No se pudo mover'), res.ok && j.ok !== false);
      setTimeout(function () { tickIssues(); }, 400);
    } catch (e) { issToast('Error: ' + e.message, false); }
  }

  // pauseIssue(issue, isResume) — POST /api/issue/<id>/<pause|resume>. Toggle del
  // label blocked:dependencies (el pulpo saltea el issue mientras esté puesto).
  // Espeja home.js:2411 (pauseIssueHome) + el resume del header.
  async function pauseIssue(issue, isResume) {
    var action = isResume ? 'resume' : 'pause';
    if (!isResume && !(await inConfirm({
        title: 'Pausar #' + issue,
        message: 'Agrega label blocked:dependencies; el pulpo lo saltea hasta que lo reanudes.',
        confirmLabel: 'Pausar',
        preview: [{ label: 'Issue', value: '#' + issue }]
      }))) {
      return;
    }
    try {
      var res = await fetch('/api/issue/' + encodeURIComponent(issue) + '/' + action, { method: 'POST' });
      var j = {};
      try { j = await res.json(); } catch (e) { /* respuesta sin JSON */ }
      issToast(j.msg || (res.ok ? (isResume ? 'Reanudado' : 'Pausado') : 'No se pudo'), res.ok && j.ok !== false);
      setTimeout(function () { tickIssues(); }, 600);
    } catch (e) { issToast('Error: ' + e.message, false); }
  }

  function bindGridDelegation() {
    var grid = document.getElementById('issues-grid');
    if (!grid) return;
    grid.addEventListener('click', function (ev) {
      var btn = ev.target.closest('button[data-action]');
      if (btn) {
        ev.stopPropagation();
        var action = btn.getAttribute('data-action');
        var issue = btn.getAttribute('data-issue');
        if (action === 'pause' || action === 'resume') {
          pauseIssue(issue, action === 'resume');
        } else if (action === 'move-top' || action === 'move-up'
                   || action === 'move-down' || action === 'move-bottom') {
          moveIssue(issue, action);
        }
        return;
      }
      if (ev.target.closest('a')) return;
      var card = ev.target.closest('.iss-card');
      if (card) openDrilldown(card.getAttribute('data-issue'));
    });
    grid.addEventListener('keydown', function (ev) {
      if (ev.key !== 'Enter') return;
      var card = ev.target.closest('.iss-card');
      if (card && ev.target === card) { ev.preventDefault(); openDrilldown(card.getAttribute('data-issue')); }
    });
  }

  function bindFilters() {
    var chips = document.querySelectorAll('.iss-chip[data-filter]');
    chips.forEach(function (chip) {
      chip.addEventListener('click', function () {
        activeFilter = chip.getAttribute('data-filter');
        chips.forEach(function (c) {
          var on = c === chip;
          c.classList.toggle('is-active', on);
          c.setAttribute('aria-pressed', on ? 'true' : 'false');
        });
        renderGrid();
      });
    });
    var search = document.getElementById('issues-search');
    if (search) search.addEventListener('input', function (e) { searchTerm = (e.target.value || '').toLowerCase(); renderGrid(); });
  }

  async function tickIssues() {
    // #3953 (CA-2) — fetchJson (FETCH_CLIENT_JS) dispara el banner stale ante
    // fallo en vez de tragar el error en silencio; mantiene el último snapshot.
    var snap = await fetchJson('/api/dash/pipeline');
    if (!snap) return;
    issuesSnapshot = snap;
    renderGrid();
  }

  function init() {
    bindGridDelegation();
    bindFilters();
    tickIssues();
    setInterval(function () { tickIssues(); }, 60000);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
`;
}

// =============================================================================
// renderIssuesHTML(opts) — página completa de la ventana `/issues`.
//   opts.initialIssues — array de issues normalizados para SSR de cards (opt).
//   opts.matrix / opts.priorityOrder — alternativamente, snapshot crudo del
//     pipelineSlice; el render normaliza y ordena. El cliente re-hidrata
//     igual vía /api/dash/pipeline.
// =============================================================================
function buildInitialIssues(opts) {
    const o = opts || {};
    if (Array.isArray(o.initialIssues)) return o.initialIssues;
    const matrix = (o.matrix && typeof o.matrix === 'object') ? o.matrix : null;
    if (!matrix) return [];
    const order = Array.isArray(o.priorityOrder) ? o.priorityOrder.map(String) : [];
    const orderMap = new Map(order.map((id, idx) => [id, idx]));
    const rows = Object.keys(matrix).map((id) => {
        const idx = orderMap.has(String(id)) ? orderMap.get(String(id)) : -1;
        return { id, data: matrix[id], prio: idx };
    });
    rows.sort((a, b) => {
        if (a.prio >= 0 && b.prio >= 0) return a.prio - b.prio;
        if (a.prio >= 0) return -1;
        if (b.prio >= 0) return 1;
        return Number(a.id) - Number(b.id);
    });
    return rows.slice(0, 200).map((r) => normalizeIssue(r.id, r.data, r.prio));
}

function renderIssuesHTML(opts) {
    const theme = loadTheme();
    const tokens = loadDesignTokens();
    const spriteInline = loadIconSprite();
    const navHtml = renderNavTabsSsr('issues');

    const initial = buildInitialIssues(opts);
    const cards = initial.map(renderIssueCard).join('');
    const gridInner = cards || '<div class="iss-empty">El pipeline está al día — sin issues activos</div>';

    const body = '<main class="iss-body" id="issues-body">'
        + '<div class="iss-rail" aria-hidden="true"></div>'
        + '<div class="iss-summary" id="issues-summary" aria-live="polite">'
        +   '<strong>' + initial.length + '</strong> issues activos</div>'
        + renderIssuesFilterBar()
        + '<div id="issues-grid" class="iss-grid" aria-live="polite" aria-label="Issues activos del pipeline">'
        +   gridInner
        + '</div>'
        + renderIssuesDialog()
        + '</main>';

    const clock = escapeHtmlSsr(new Date().toLocaleTimeString('es-AR'));

    return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Intrale · Issues</title>
<style>${theme}</style>
<style>${tokens}</style>
<style>${ISSUES_CSS}</style>
</head>
<body>
<div aria-hidden="true" style="position:absolute;width:0;height:0;overflow:hidden">${spriteInline}</div>
${/* #3953 (CA-2) — banner discreto de dato desactualizado; el wrapper fetchJson
      lo muestra ante fallo de polling y lo limpia al recuperar. */ ''}
${renderStaleBanner()}
<a href="#issues-grid" class="in-skip-link" style="position:absolute;left:-9999px">Saltar al listado de issues</a>
<div class="iss-frame">
  <header class="in-header">
    <div class="in-header-brand">
      <div class="in-header-logo">i</div>
      <div>
        <div class="in-header-title">Issues</div>
        <div class="in-header-subtitle">Vista operacional del backlog · estado en vivo</div>
      </div>
    </div>
    <div class="in-header-meta">
      <span class="in-clock" id="hdr-clock">${clock}</span>
    </div>
  </header>
  ${navHtml}
  ${body}
  <footer class="in-footer">
    <span>Vista operacional · datos en vivo cada 60s</span>
    <span>Intrale V3 · #3730</span>
  </footer>
</div>
<script>${FETCH_CLIENT_JS}
${CONFIRM_MODAL_JS}
${renderIssuesClientScript()}</script>
</body>
</html>`;
}

// Panel inerte visible (CA-A3 del épico) si el require/render fallara aguas
// arriba. El render nunca queda en blanco.
function renderInert(reason) {
    const safe = escapeHtmlSsr(reason || 'módulo no disponible');
    return `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8">
<title>Intrale · Issues</title></head><body style="font-family:system-ui;background:#0d1117;color:#e6edf3">
<main style="padding:32px;max-width:680px;margin:0 auto">
<h1>Ventana Issues no disponible</h1>
<p>${safe}</p>
<p>El render no queda en blanco. Ver logs del dashboard para detalle.</p>
</main></body></html>`;
}

module.exports = {
    renderIssuesHTML,
    renderIssueCard,
    renderIssuesClientScript,
    renderIssuesFilterBar,
    renderIssuesDialog,
    buildInitialIssues,
    normalizeIssue,
    deriveState,
    renderInert,
    ISSUES_CSS,
    escapeHtmlSsr,
    escapeHtmlAttr,
};
