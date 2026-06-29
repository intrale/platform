// =============================================================================
// issues.js — Vista SSR de la ventana Issues del dashboard V3 (ruta `/issues`
// y `?view=issues`).
//
// Issue original: #3730 (split de #3715 — rediseño UX integral del dashboard).
// Rediseño MIZPÁ: #4192 (Ola 7.1) — alinea la pantalla ISSUES al lenguaje
// visual del centro de mando MIZPÁ, consistente con HOME/PIPELINE/LOGS:
//   - Cabecera/marca MIZPÁ: barra + tagline + selector multiproyecto + banner
//     de misión (ola protagonista: entregados N/M, ETA, velocidad).
//   - Nav curada a 5 tabs (Inicio · Pipeline · Issues · Bloqueados · Costos) +
//     botón «⋯ Más» colapsable con popover de secciones secundarias.
//   - Toolbar de control: contadores grandes, buscador, selectores Orden /
//     Agrupar y chips de filtro con contador.
//   - Backlog AGRUPADO por estado (Trabajando → Listos → Bloqueados → Backlog),
//     nunca un grid plano y nunca truncado (se ven TODOS los issues).
//   - Acción primaria por estado en cada fila (Pausar / Lanzar / Destrabar /
//     Definir) + menú «⋯» con acciones secundarias contextuales y mini-desc +
//     accesos fijos 🔗 issue y 📄 logs (atenuado si el issue no corrió).
//
// Decisión arquitectónica heredada (Interpretación B — vista OPERACIONAL):
//   El módulo es la vista operacional del backlog. REEMPLAZA a
//   `satellites.renderIssues`.
//
// Seguridad (análisis `security` + `guru` + CA-D1):
//   - TODA interpolación dinámica pasa por escapeHtmlText/escapeHtmlAttr de
//     lib/escape-html.js (#3722); fallback a helpers locales con la misma
//     semántica si el require falla (defensa en profundidad).
//   - renderIssueCard valida `Number.isFinite(num) && num > 0` ANTES de
//     interpolar `issue.number`; retorna '' si falla (R-6).
//   - Cero `onclick="fn(' + valor + ')"`: delegación con data-issue/data-action.
//   - Tooltips con `title=""` HTML nativo escapado con escapeHtmlAttr.
//   - Drilldown con `<dialog>` nativo + showModal() (focus trap del browser).
//
// Convención V3: SSR del chrome + cards iniciales; el cliente hidrata vía
// fetch JSON (`/api/dash/pipeline`) + re-render del grid. IDs estables
// (#issues-grid, #issues-search, #issues-dialog).
// =============================================================================
'use strict';

const fs = require('node:fs');
const path = require('node:path');

// #3722 — Escape unificado server-side. escapeHtmlText para nodos texto,
// escapeHtmlAttr para contexto atributo (title="", aria-label="", data-*="").
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

// #3726 — Sprite compartido (iconos vía <use href="#…">).
// #4237 — Nav común V3 (renderNavTabsSsr) para reusar la barra de accesos del
// marco MIZPÁ en lugar de la nav bespoke (mz-nav) que tenía esta ventana.
const { loadIconSprite, renderNavTabsSsr } = require('./nav-tabs');

// #4237 — Marco común MIZPÁ (cabecera de marca + cabecera de ola) que entregó
// #4234 como helpers reutilizables. ISSUES los consume en lugar de clonar el
// markup (CA-5: no duplicar). Require defensivo: si el módulo no carga, el
// chrome degrada a un marco inline mínimo y el pipeline no muere (R-4).
let pipelineRedesign = null;
try { pipelineRedesign = require('./pipeline-redesign'); } catch { /* fallback inline */ }

// #3953 (EP8-H0) — Wrapper de fetchJson (banner stale) + framework de modal de
// confirmación con preview. Mismo patrón que home.js / satellites.js.
const { FETCH_CLIENT_JS, renderStaleBanner } = require('./fetch-client.js');
const { CONFIRM_MODAL_JS } = require('./confirm-modal.js');
// #4296 — Accessor compartido del banner de ola: avance %, velocidad %/h y ETA
// vienen del cómputo determinístico vivo (/api/dash/ola-eta), NO de conteos.
const { missionOlaEtaClientScript } = require('../../lib/mission-ola-eta.js');

const THEME_CSS_PATH = path.join(__dirname, 'theme.css');
const TOKENS_CSS_PATH = path.join(__dirname, '..', '..', 'assets', 'design-tokens.css');

function loadTheme() {
    try { return fs.readFileSync(THEME_CSS_PATH, 'utf8'); } catch { return ''; }
}
function loadDesignTokens() {
    try { return fs.readFileSync(TOKENS_CSS_PATH, 'utf8'); } catch { return ''; }
}

// =============================================================================
// Modelo de estado operacional. Cada estado = color semántico + label de texto
// + ícono → NUNCA color-only (WCAG 1.4.1).
// =============================================================================
const STATE_META = {
    trabajando:    { label: 'Trabajando',      cls: 'st-working' },
    listo:         { label: 'Listo',           cls: 'st-ready' },
    pendiente:     { label: 'Pendiente',       cls: 'st-pending' },
    bloqueado:     { label: 'Bloqueado',       cls: 'st-blocked' },
    rebote:        { label: 'Rebote',          cls: 'st-bounce' },
    'needs-human': { label: 'Necesita humano', cls: 'st-human' },
};

// deriveState — estado del chip (prioridad rebote > needs-human > bloqueado >
// estado activo). Pura, replicada en el cliente.
function deriveState(issue) {
    const labels = Array.isArray(issue && issue.labels) ? issue.labels : [];
    if (issue && issue.rebote) return 'rebote';
    if (labels.includes('needs-human')) return 'needs-human';
    if (labels.includes('blocked:dependencies')) return 'bloqueado';
    const estado = issue && issue.estadoActual;
    if (estado === 'trabajando' || estado === 'listo' || estado === 'pendiente') return estado;
    return 'pendiente';
}

// #4192 — deriveGroup — agrupa el issue en una de las 4 secciones del backlog
// MIZPÁ. Distinto de deriveState: acá un issue rebotado se ubica en la sección
// de su estado real (trabajando/listo/backlog), y el chip de rebote lo marca
// transversalmente. Prioridad: bloqueado > trabajando > listo > backlog.
function deriveGroup(issue) {
    const labels = Array.isArray(issue && issue.labels) ? issue.labels : [];
    if (labels.includes('needs-human') || labels.includes('blocked:dependencies')) return 'bloqueado';
    const e = issue && issue.estadoActual;
    if (e === 'trabajando') return 'trabajando';
    if (e === 'listo') return 'listo';
    return 'backlog';
}

// Orden + metadata de cada sección del backlog. `primary` = acción primaria
// destacada de cada fila según su estado (CA-4 del rediseño).
const GROUP_ORDER = ['trabajando', 'listo', 'bloqueado', 'backlog'];
const GROUP_META = {
    trabajando: {
        label: 'Trabajando', dot: 'st-working',
        primary: { kind: 'btn', action: 'pause', label: 'Pausar', glyph: '⏸',
            desc: 'Suspende el agente sin perder el progreso' },
    },
    listo: {
        label: 'Listos', dot: 'st-ready',
        primary: { kind: 'btn', action: 'move-top', label: 'Lanzar', glyph: '▶',
            desc: 'Fuerza el slot: salta al frente de la cola, sin esperar turno' },
    },
    bloqueado: {
        label: 'Bloqueados', dot: 'st-blocked',
        primary: { kind: 'btn', action: 'resume', label: 'Destrabar', glyph: '🔓',
            desc: 'Override manual de la dependencia: reanuda el issue' },
    },
    backlog: {
        label: 'Backlog', dot: 'st-pending',
        primary: { kind: 'link', action: 'define', label: 'Definir', glyph: '✎',
            desc: 'Abrí el issue para refinarlo con /doc' },
    },
};

// Fases canónicas (orden del timeline del drilldown y del agrupado por fase).
const FASE_ORDER = [
    'sizing', 'analisis', 'criterios', 'validacion', 'dev',
    'build', 'verificacion', 'linteo', 'aprobacion', 'entrega',
];
const FASE_WITH_ICON = new Set(FASE_ORDER);
function faseShort(faseActual) {
    const raw = String(faseActual || '');
    if (!raw) return '';
    const parts = raw.split('/');
    return parts[parts.length - 1] || raw;
}
function faseIconId(fase) {
    return FASE_WITH_ICON.has(fase) ? 'ic-fase-' + fase : 'ic-issues-count';
}

// Helper SSR: emite un <svg><use href="#id"></svg>. El `id` SIEMPRE viene de un
// catálogo interno (jamás del usuario) → se acota a [a-z0-9-] por defensa.
function iconSvg(id, cls) {
    const safe = String(id || '').replace(/[^a-z0-9-]/g, '');
    const klass = cls ? ' class="' + cls + '"' : '';
    return '<svg' + klass + ' aria-hidden="true" focusable="false" viewBox="0 0 24 24">'
        + '<use href="#' + safe + '"></use></svg>';
}

// =============================================================================
// Normalización de un issue del snapshot (pipelineSlice.matrix) al shape que
// consume renderIssueCard. Defensivo ante campos ausentes.
// =============================================================================
function normalizeIssue(id, data, priorityIndex) {
    const d = data || {};
    const agents = Array.isArray(d.agents) ? d.agents : [];
    const skill = (agents[0] && agents[0].skill) ? String(agents[0].skill) : null;
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
        logFile: d.logFile || null,
        skill,
        priority: (typeof priorityIndex === 'number' && priorityIndex >= 0)
            ? priorityIndex + 1 : null,
    };
}

// =============================================================================
// renderIssueCard(issue) — una card operacional. PURA y testeable.
// Retorna '' si el número de issue no es válido (R-6).
// =============================================================================
function renderIssueCard(issue) {
    const num = Number(issue && issue.number);
    if (!Number.isFinite(num) || num <= 0) return '';

    const i = issue || {};
    const stateKey = deriveState(i);
    const meta = STATE_META[stateKey] || STATE_META.pendiente;
    const group = deriveGroup(i);
    const labels = Array.isArray(i.labels) ? i.labels : [];
    const paused = labels.includes('blocked:dependencies');

    const title = i.title || '';
    const titleEsc = escapeHtmlSsr(title);
    const titleAttr = escapeHtmlAttr(title);

    const fase = faseShort(i.faseActual) || '—';
    const faseEsc = escapeHtmlSsr(fase);
    const bounces = Number(i.bounces) || 0;
    const prio = (typeof i.priority === 'number' && i.priority > 0) ? '#' + i.priority : '—';

    const ghUrl = 'https://github.com/intrale/platform/issues/' + num;

    // Coordenadas para acciones contextuales (cancelar agente).
    const pipelineSeg = String(i.faseActual || '').split('/')[0] || '';
    const skill = i.skill || '';

    // ¿Corrió alguna vez? Atenúa el acceso a logs si no hay log todavía.
    const hasRun = !!i.logFile;
    const logHref = i.logFile
        ? '/logs/view/' + encodeURIComponent(i.logFile) + (i.estadoActual === 'trabajando' ? '?live=1' : '')
        : '';

    const stateChip = '<span class="iss-state ' + meta.cls + '">'
        + escapeHtmlSsr(meta.label) + '</span>';

    // Chip rebote con motivo truncado y escapado en el tooltip.
    let reboteChip = '';
    if (i.rebote) {
        const motivo = String(i.motivo_rechazo || '').slice(0, 300);
        const faseRej = i.rechazado_en_fase || '?';
        const skillRej = i.rechazado_skill_previo ? ('/' + i.rechazado_skill_previo) : '';
        const tip = 'Rechazado en ' + faseRej + skillRej + ': ' + motivo;
        reboteChip = '<span class="iss-rebote" title="' + escapeHtmlAttr(tip) + '">↩ rechazo</span>';
    }

    const bouncesBadge = bounces > 0
        ? '<span class="iss-bounces' + (bounces > 2 ? ' warn' : '') + '" '
          + 'title="' + escapeHtmlAttr(bounces + ' rebote(s) acumulados') + '">'
          + escapeHtmlSsr(String(bounces)) + '×</span>'
        : '';

    // ── Acción primaria por estado (CA-4) ──────────────────────────────────
    const gm = GROUP_META[group] || GROUP_META.backlog;
    const p = gm.primary;
    let primaryHtml;
    const primaryTip = p.label + ' — ' + p.desc;
    if (p.kind === 'link') {
        // Definir: link directo al issue (lugar donde se refina con /doc).
        primaryHtml = '<a class="iss-primary iss-primary-' + group + '" '
            + 'href="' + escapeHtmlAttr(ghUrl) + '" target="_blank" rel="noopener" '
            + 'title="' + escapeHtmlAttr(primaryTip) + '" '
            + 'aria-label="' + escapeHtmlAttr(p.label + ' issue ' + num + ': ' + p.desc) + '">'
            + '<span class="iss-primary-glyph" aria-hidden="true">' + escapeHtmlSsr(p.glyph) + '</span>'
            + '<span>' + escapeHtmlSsr(p.label) + '</span></a>';
    } else {
        primaryHtml = '<button type="button" class="iss-primary iss-primary-' + group + '" '
            + 'data-issue="' + num + '" data-action="' + escapeHtmlAttr(p.action) + '" '
            + 'title="' + escapeHtmlAttr(primaryTip) + '" '
            + 'aria-label="' + escapeHtmlAttr(p.label + ' issue ' + num + ': ' + p.desc) + '">'
            + '<span class="iss-primary-glyph" aria-hidden="true">' + escapeHtmlSsr(p.glyph) + '</span>'
            + '<span>' + escapeHtmlSsr(p.label) + '</span></button>';
    }

    // ── Accesos fijos por fila: 🔗 issue + 📄 logs (atenuado si no corrió) ──
    let accessHtml = '<a class="iss-access iss-gh" href="' + escapeHtmlAttr(ghUrl) + '" '
        + 'target="_blank" rel="noopener" '
        + 'title="Ver issue en GitHub ↗" '
        + 'aria-label="' + escapeHtmlAttr('Ver issue ' + num + ' en GitHub') + '">'
        + iconSvg('ic-link-out', 'iss-ico') + '</a>';
    if (hasRun) {
        accessHtml += '<a class="iss-access iss-logs" href="' + escapeHtmlAttr(logHref) + '" '
            + 'target="_blank" rel="noopener" '
            + 'title="Ver log del agente" '
            + 'aria-label="' + escapeHtmlAttr('Ver log del agente del issue ' + num) + '">'
            + iconSvg('ic-tab-historial', 'iss-ico') + '</a>';
    } else {
        accessHtml += '<span class="iss-access iss-logs is-disabled" aria-disabled="true" '
            + 'title="Sin logs: el issue todavía no corrió" '
            + 'aria-label="' + escapeHtmlAttr('Sin logs: el issue ' + num + ' todavía no corrió') + '">'
            + iconSvg('ic-tab-historial', 'iss-ico') + '</span>';
    }

    // ── Menú «⋯» con acciones secundarias contextuales (CA-5) ──────────────
    const menuItems = [];
    menuItems.push(_menuItem({ link: ghUrl, label: 'Ver issue', glyph: '🔗',
        desc: 'Abrir el issue en GitHub' }));
    menuItems.push(_menuItem({ link: hasRun ? logHref : null, label: 'Logs del agente', glyph: '📄',
        desc: hasRun ? 'Ver el log del agente' : 'Todavía no corrió', disabled: !hasRun }));
    menuItems.push(_menuItem({ issue: num, action: 'move-top', label: 'Mover a tope', glyph: '⤒',
        desc: 'Saltar al frente de la cola de prioridad' }));
    menuItems.push(_menuItem({ issue: num, action: 'move-bottom', label: 'Mover a fondo', glyph: '⤓',
        desc: 'Enviar al final de la cola de prioridad' }));
    if (group === 'trabajando') {
        if (skill && pipelineSeg && fase !== '—') {
            menuItems.push(_menuItem({ issue: num, action: 'cancel', label: 'Cancelar agente', glyph: '✕',
                desc: 'Detiene el agente en ejecución', danger: true,
                skill, pipeline: pipelineSeg, fase }));
        }
    } else if (group === 'listo') {
        menuItems.push(_menuItem({ issue: num, action: 'pause', label: 'Pausar', glyph: '⏸',
            desc: 'Suspender el issue antes de lanzarlo' }));
    } else if (group === 'backlog') {
        menuItems.push(_menuItem({ issue: num, action: 'move-up', label: 'Subir prioridad', glyph: '▲',
            desc: 'Subir un puesto en la cola' }));
    } else if (group === 'bloqueado') {
        menuItems.push(_menuItem({ issue: num, action: 'pause', label: 'Pausar', glyph: '⏸',
            desc: 'Mantener bloqueado explícitamente' }));
    }
    const menuHtml = '<div class="iss-menu-wrap">'
        + '<button type="button" class="iss-menu-btn" data-menu-issue="' + num + '" '
        +   'aria-haspopup="true" aria-expanded="false" '
        +   'title="Más acciones" aria-label="' + escapeHtmlAttr('Más acciones del issue ' + num) + '">⋯</button>'
        + '<div class="iss-menu" role="menu" hidden aria-label="' + escapeHtmlAttr('Acciones del issue ' + num) + '">'
        +   menuItems.join('')
        + '</div></div>';

    const ariaLabel = 'Issue ' + num + ': ' + title + ', fase ' + fase + ', estado ' + meta.label;
    const titleCls = 'iss-title' + (paused ? ' is-paused' : '');

    return '<article class="iss-card" tabindex="0" role="article" '
        + 'data-issue="' + num + '" data-state="' + stateKey + '" data-group="' + group + '" '
        + 'data-fase="' + escapeHtmlAttr(fase) + '" '
        + 'aria-label="' + escapeHtmlAttr(ariaLabel) + '">'
        + '<div class="iss-top">'
        +   '<span class="iss-prio' + (i.priority ? ' set' : '') + '" '
        +     'title="' + escapeHtmlAttr(i.priority ? ('Prioridad ' + prio) : 'Sin orden manual') + '">'
        +     escapeHtmlSsr(prio) + '</span>'
        +   '<a class="iss-num" href="' + escapeHtmlAttr(ghUrl) + '" target="_blank" '
        +     'rel="noopener" title="' + escapeHtmlAttr('Ver issue ' + num + ' en GitHub') + '">#'
        +     num + '</a>'
        +   stateChip
        + '</div>'
        + '<div class="' + titleCls + '" title="' + titleAttr + '">' + titleEsc + '</div>'
        + '<div class="iss-meta">'
        +   '<span class="iss-fase">' + iconSvg(faseIconId(fase), 'iss-ico')
        +     '<span>' + faseEsc + '</span></span>'
        +   bouncesBadge
        +   reboteChip
        + '</div>'
        + '<div class="iss-actions">'
        +   primaryHtml
        +   '<div class="iss-access-row" role="group" aria-label="' + escapeHtmlAttr('Accesos del issue ' + num) + '">'
        +     accessHtml
        +     menuHtml
        +   '</div>'
        + '</div>'
        + '</article>';
}

// _menuItem — un item del menú «⋯». Link (href), acción (data-action) o
// deshabilitado. Cada item lleva su mini-descripción autodescriptiva.
function _menuItem(o) {
    const glyph = '<span class="iss-mi-glyph" aria-hidden="true">' + escapeHtmlSsr(o.glyph || '·') + '</span>';
    const body = '<span class="iss-mi-body"><span class="iss-mi-label">' + escapeHtmlSsr(o.label)
        + '</span><span class="iss-mi-desc">' + escapeHtmlSsr(o.desc || '') + '</span></span>';
    const cls = 'iss-mi' + (o.danger ? ' iss-mi-danger' : '') + (o.disabled ? ' is-disabled' : '');
    const tip = escapeHtmlAttr((o.label || '') + (o.desc ? ' — ' + o.desc : ''));
    if (o.disabled) {
        return '<span class="' + cls + '" role="menuitem" aria-disabled="true" title="' + tip + '">'
            + glyph + body + '</span>';
    }
    if (o.link) {
        return '<a class="' + cls + '" role="menuitem" href="' + escapeHtmlAttr(o.link) + '" '
            + 'target="_blank" rel="noopener" title="' + tip + '">' + glyph + body + '</a>';
    }
    let dataAttrs = 'data-issue="' + escapeHtmlAttr(String(o.issue)) + '" data-action="' + escapeHtmlAttr(o.action) + '"';
    if (o.skill) dataAttrs += ' data-skill="' + escapeHtmlAttr(o.skill) + '"';
    if (o.pipeline) dataAttrs += ' data-pipeline="' + escapeHtmlAttr(o.pipeline) + '"';
    if (o.fase) dataAttrs += ' data-fase="' + escapeHtmlAttr(o.fase) + '"';
    return '<button type="button" class="' + cls + '" role="menuitem" ' + dataAttrs
        + ' title="' + tip + '">' + glyph + body + '</button>';
}

// =============================================================================
// renderIssuesFilterBar() — toolbar de control (CA-2). Contadores grandes,
// buscador, selectores Orden / Agrupar y chips de filtro con contador.
// role="toolbar". Texto literal (sin datos del usuario).
// =============================================================================
const FILTER_CHIPS = [
    { filter: 'all',        label: 'Todos',      tip: 'Mostrar todos los issues' },
    { filter: 'trabajando', label: 'Trabajando', tip: 'Sólo issues con un agente trabajando' },
    { filter: 'listo',      label: 'Listos',     tip: 'Sólo issues listos para la siguiente fase' },
    { filter: 'bloqueado',  label: 'Bloqueados', tip: 'Sólo issues bloqueados o esperando humano' },
    { filter: 'rebote',     label: 'Rebotes',    tip: 'Sólo issues que rebotaron de una fase posterior' },
    { filter: 'backlog',    label: 'Backlog',    tip: 'Sólo issues pendientes sin agente' },
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
            + escapeHtmlSsr(c.label)
            + '<span class="iss-chip-count" data-chip-count="' + c.filter + '">0</span>'
            + '</button>';
    }
    return '<div class="iss-filter-bar" role="toolbar" aria-label="Filtros y orden de issues">'
        + '<div class="iss-toolbar-row">'
        +   '<div class="iss-search-box">'
        +     iconSvg('ic-issues-count', 'iss-ico')
        +     '<input type="search" id="issues-search" class="iss-search" '
        +       'placeholder="Filtrar por #número, fase o título…" '
        +       'title="Filtrar issues por número, fase o título" '
        +       'aria-label="Filtrar issues por número, fase o título">'
        +   '</div>'
        +   '<label class="iss-select-wrap" title="Criterio de orden del listado">'
        +     '<span class="iss-select-label">Orden</span>'
        +     '<select id="iss-order" class="iss-select" aria-label="Orden del listado">'
        +       '<option value="manual">Manual</option>'
        +       '<option value="numero">Nº issue</option>'
        +     '</select>'
        +   '</label>'
        +   '<label class="iss-select-wrap" title="Cómo se agrupan los issues">'
        +     '<span class="iss-select-label">Agrupar</span>'
        +     '<select id="iss-group" class="iss-select" aria-label="Agrupar issues">'
        +       '<option value="estado">Estado</option>'
        +       '<option value="fase">Fase</option>'
        +       '<option value="none">Sin agrupar</option>'
        +     '</select>'
        +   '</label>'
        + '</div>'
        + '<div class="iss-chips" role="group" aria-label="Filtros rápidos por estado">' + chips + '</div>'
        + '</div>';
}

// Contadores grandes de la toolbar (CA-2). IDs estables para hidratación.
function renderCounters(counts) {
    const c = counts || { total: 0, trabajando: 0, listo: 0, blocked: 0 };
    const cell = (id, label, value, cls, tip) =>
        '<div class="iss-counter ' + cls + '" title="' + escapeHtmlAttr(tip) + '">'
        + '<span class="iss-counter-value" id="' + id + '">' + escapeHtmlSsr(String(value)) + '</span>'
        + '<span class="iss-counter-label">' + escapeHtmlSsr(label) + '</span></div>';
    return '<div class="iss-counters" role="group" aria-label="Resumen del backlog">'
        + cell('iss-count-total', 'Issues', c.total, 'cnt-total', 'Total de issues en el backlog')
        + cell('iss-count-working', 'Trabajando', c.trabajando, 'cnt-working', 'Issues con un agente trabajando')
        + cell('iss-count-ready', 'Listos', c.listo, 'cnt-ready', 'Issues listos para la siguiente fase')
        + cell('iss-count-blocked', 'Bloqueados', c.blocked, 'cnt-blocked', 'Issues bloqueados o esperando humano')
        + '</div>';
}

// =============================================================================
// renderIssuesDialog() — drilldown <dialog> nativo. El contenido se rellena
// client-side con textContent (sin innerHTML de datos del usuario).
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
// Marco común MIZPÁ (#4237). Los tres bloques superiores —① cabecera de marca,
// ② cabecera de ola, ③ barra de accesos— son IDÉNTICOS al resto de las pantallas
// (referencia canónica: PIPELINE, #4234). Se reutilizan los helpers compartidos
// en vez de clonar el markup (CA-5):
//   ① renderBrandBarPipeline() → in-header-brand + mz-projsel + pill de build.
//   ② renderMissionBannerPipeline() → mz-wavetag + métricas + bloque AVANCE.
//   ③ renderNavTabsSsr('issues') → nav v3 con la pestaña Issues activa.
// El banner ② se hidrata client-side desde /api/dash/waves (mismos IDs
// `mission-*`), igual que en HOME/PIPELINE; el `mission` SSR ya no se usa salvo
// en el fallback inline (defensa en profundidad si el módulo común no carga).
// =============================================================================

// Fallback inline mínimo — SOLO se usa si el require de pipeline-redesign falló
// (R-4). No es un 3er clon del marco: es una red de seguridad para que la página
// no quede sin cabecera. Reusa los mismos contenedores/IDs hidratables que el
// helper común para que tickWaves siga funcionando aunque caiga en el fallback.
function _missionBannerFallback() {
    return ''
        + '<section class="mz-mission" id="mz-mission" aria-label="Misión de la ola activa">'
        +   '<div class="mz-wavetag"><span class="mz-wavetag-k">OLA</span>'
        +     '<span class="mz-wavetag-n" id="mission-wave-num">—</span></div>'
        +   '<div class="mz-mission-text"><div class="mz-mission-ttl">'
        +     '<span id="mission-wave-name">Sin ola activa</span></div>'
        +     '<div class="mz-mission-desc" id="mission-wave-desc">Backlog de la ola activa.</div></div>'
        +   '<div class="mz-mission-prog">'
        +     '<div class="mz-prog-head"><span>AVANCE</span><span class="mz-prog-pct" id="mission-avance-pct">0%</span></div>'
        +     '<div class="mz-prog-bar">'
        +       '<i id="mission-bar-done" style="width:0%;background:var(--in-ok,#3fb950)"></i>'
        +       '<i id="mission-bar-active" style="width:0%;background:var(--in-info,#58a6ff)"></i>'
        +       '<i id="mission-bar-blocked" style="width:0%;background:var(--in-bad,#f85149)"></i>'
        +       '<i id="mission-bar-queue" style="width:0%;background:rgba(255,255,255,.10)"></i></div>'
        +     '<div class="mz-prog-legend">'
        +       '<span><b id="mission-leg-done">0</b> hechos</span>'
        +       '<span><b id="mission-leg-active">0</b> activos</span>'
        +       '<span><b id="mission-leg-blocked">0</b> bloq.</span>'
        +       '<span><b id="mission-leg-queue">0</b> cola</span></div></div>'
        + '</section>';
}
function _brandBarFallback() {
    return ''
        + '<div class="in-header-brand">'
        +   '<div class="mz-logo" aria-hidden="true" title="MIZPÁ">M</div>'
        +   '<div class="mz-id"><div class="mz-name">MIZPÁ</div>'
        +     '<div class="mz-sub">«Que el Señor vigile» · atalaya de agentes</div></div>'
        +   '<div class="mz-projsel" role="button" tabindex="0" '
        +     'aria-label="Proyecto activo: Intrale, 1 de 3">'
        +     '<span class="mz-proj-avatar" aria-hidden="true">i</span>'
        +     '<span class="mz-proj-id"><span class="mz-proj-name">Intrale</span>'
        +       '<span class="mz-proj-state">PROYECTO ACTIVO</span></span>'
        +     '<span class="mz-proj-badge">1 / 3</span>'
        +     '<span class="mz-proj-caret" aria-hidden="true">▾</span></div>'
        + '</div>';
}

// renderMizpaChrome(_mission) — los 3 bloques superiores del marco común. El
// parámetro se conserva por compatibilidad de firma (tests / callers), pero el
// banner de ola se hidrata client-side; no se inyecta `mission` en el markup.
function renderMizpaChrome(_mission) {
    const hasShared = pipelineRedesign
        && typeof pipelineRedesign.renderBrandBarPipeline === 'function'
        && typeof pipelineRedesign.renderMissionBannerPipeline === 'function';

    // ① Cabecera de marca (marca + selector de proyecto + pill de build) + el
    // meta de la derecha (estado del pipeline + reloj), idéntico al shell común.
    const brand = hasShared ? pipelineRedesign.renderBrandBarPipeline() : _brandBarFallback();
    const header = '<header class="in-header">'
        + brand
        + '<div class="in-header-meta">'
        +   '<span class="in-pill" id="hdr-mode">…</span>'
        +   '<span class="in-clock" id="hdr-clock">…</span>'
        + '</div>'
        + '</header>';

    // ② Cabecera de ola (tag OLA + título + métricas + bloque AVANCE).
    const mission = hasShared ? pipelineRedesign.renderMissionBannerPipeline() : _missionBannerFallback();

    // ③ Barra de accesos a subventanas (nav v3 común, pestaña Issues activa).
    const nav = renderNavTabsSsr('issues');

    return header + mission + nav;
}

// =============================================================================
// CSS del módulo. SOLO tokens (cero HEX literal en color:/background:).
// =============================================================================
const ISSUES_CSS = `
.iss-frame { max-width: 1480px; margin: 0 auto; padding: 0; }
.iss-body { padding: 20px 28px 32px; display: flex; flex-direction: column; gap: 18px; }

/* ── Marco común MIZPÁ (#4237) ───────────────────────────────────────────────
   Los 3 bloques superiores ya NO tienen CSS propio acá: se renderizan con los
   helpers compartidos (renderBrandBarPipeline / renderMissionBannerPipeline /
   renderNavTabsSsr) y su estilo vive en theme.css (.in-header / .in-header-brand
   / .mz-projsel / .v3-nav) + PIPELINE_REDESIGN_CSS (.mz-mission / .mz-wavetag /
   .mz-prog-*). Esta ventana inyecta ambas hojas en el <head>; no se duplica
   markup ni CSS del marco (CA-5). Las únicas reglas locales del marco son los
   estados del pill de modo (que el shell común inyecta como extraCss y theme.css
   no trae); se replican acá para que la cabecera rinda igual sin pageShell. */
.in-mode-running { color: var(--in-ok); border-color: var(--in-ok); background: var(--in-ok-soft); }
.in-mode-paused { color: var(--in-bad); border-color: var(--in-bad); background: var(--in-bad-soft); }
.in-mode-partial { color: var(--in-warn); border-color: var(--in-warn); background: var(--in-warn-soft); }

/* ── Toolbar de control ─────────────────────────────────────────────────── */
.iss-counters { display: flex; gap: 12px; flex-wrap: wrap; }
.iss-counter {
    display: flex; flex-direction: column; gap: 2px; min-width: 110px; flex: 1;
    padding: 12px 16px; border-radius: var(--radius-lg, 12px);
    background: var(--surface-1, var(--in-bg-2)); border: 1px solid var(--border, var(--in-border));
    border-left: 3px solid var(--border-strong, var(--in-border));
}
.iss-counter.cnt-working { border-left-color: var(--info, var(--in-info)); }
.iss-counter.cnt-ready { border-left-color: var(--success, var(--in-ok)); }
.iss-counter.cnt-blocked { border-left-color: var(--warning, var(--in-warn)); }
.iss-counter-value {
    font-size: 26px; font-weight: 800; line-height: 1.1;
    color: var(--text-primary, var(--in-fg)); font-variant-numeric: tabular-nums;
}
.iss-counter-label {
    font-size: 11px; text-transform: uppercase; letter-spacing: 0.8px;
    color: var(--text-secondary, var(--in-fg-dim));
}

.iss-filter-bar {
    display: flex; flex-direction: column; gap: 12px;
    background: var(--surface-1, var(--in-bg-2)); border: 1px solid var(--border, var(--in-border));
    border-radius: var(--radius-lg, 12px); padding: 14px 16px;
}
.iss-toolbar-row { display: flex; gap: 12px; flex-wrap: wrap; align-items: center; }
.iss-search-box {
    display: flex; align-items: center; gap: 8px; flex: 1; min-width: 220px;
    padding: 8px 12px; border-radius: var(--radius-sm, 8px);
    background: var(--surface-2, var(--in-bg-3)); border: 1px solid var(--border, var(--in-border));
}
.iss-search-box .iss-ico { width: 15px; height: 15px; fill: var(--text-dim, var(--in-fg-dim)); }
.iss-search {
    flex: 1; border: 0; background: transparent; font: inherit; font-size: 13px;
    color: var(--text-primary, var(--in-fg)); outline: none;
}
.iss-select-wrap { display: flex; align-items: center; gap: 6px; }
.iss-select-label {
    font-size: 11px; text-transform: uppercase; letter-spacing: 0.6px;
    color: var(--text-secondary, var(--in-fg-dim));
}
.iss-select {
    padding: 7px 10px; border-radius: var(--radius-sm, 8px); font: inherit; font-size: 12px;
    background: var(--surface-2, var(--in-bg-3)); border: 1px solid var(--border, var(--in-border));
    color: var(--text-primary, var(--in-fg)); cursor: pointer;
}
.iss-chips { display: flex; flex-wrap: wrap; gap: 8px; }
.iss-chip {
    display: inline-flex; align-items: center; gap: 6px; min-height: 32px; padding: 0 12px;
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
.iss-chip-count {
    font-size: 10px; font-weight: 700; padding: 1px 6px; border-radius: 999px;
    background: var(--surface-3, var(--in-bg-2)); color: var(--text-secondary, var(--in-fg-dim));
    font-variant-numeric: tabular-nums;
}

/* ── Backlog agrupado ──────────────────────────────────────────────────── */
.iss-groups { display: flex; flex-direction: column; gap: 22px; }
.iss-group-head {
    display: flex; align-items: center; gap: 10px; margin-bottom: 10px;
    padding-bottom: 8px; border-bottom: 1px solid var(--border, var(--in-border));
}
.iss-group-dot { width: 9px; height: 9px; border-radius: 50%; background: var(--text-dim, var(--in-fg-dim)); }
.iss-group-dot.st-working { background: var(--info, var(--in-info)); }
.iss-group-dot.st-ready { background: var(--success, var(--in-ok)); }
.iss-group-dot.st-blocked { background: var(--warning, var(--in-warn)); }
.iss-group-dot.st-pending { background: var(--text-dim, var(--in-fg-dim)); }
.iss-group-title {
    font-size: 13px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.8px;
    color: var(--text-primary, var(--in-fg));
}
.iss-group-count {
    font-size: 11px; font-weight: 700; padding: 2px 9px; border-radius: 999px;
    background: var(--surface-2, var(--in-bg-3)); color: var(--text-secondary, var(--in-fg-dim));
    font-variant-numeric: tabular-nums;
}
.iss-group-grid {
    display: grid; grid-template-columns: repeat(auto-fill, minmax(330px, 1fr)); gap: 14px;
}
.iss-empty {
    text-align: center; padding: 40px 16px;
    color: var(--text-dim, var(--in-fg-dim)); font-size: 13px;
}
.iss-group-empty {
    grid-column: 1 / -1; padding: 14px 16px; font-size: 12px;
    color: var(--text-dim, var(--in-fg-dim)); font-style: italic;
}

/* ── Card ──────────────────────────────────────────────────────────────── */
.iss-card {
    position: relative; display: flex; flex-direction: column; gap: 10px;
    background: var(--surface-1, var(--in-bg-2)); border: 1px solid var(--border, var(--in-border));
    border-radius: var(--radius-lg, 12px); padding: 14px 16px;
    box-shadow: var(--shadow-xs, var(--in-shadow)); cursor: pointer;
    transition: border-color 0.12s;
}
.iss-card:hover { border-color: var(--border-strong, var(--in-accent)); }
.iss-card:focus-visible { outline: 2px solid var(--border-strong, var(--in-accent)); outline-offset: 2px; }
.iss-top { display: flex; align-items: center; gap: 10px; }
.iss-prio {
    font-size: 11px; color: var(--text-dim, var(--in-fg-soft)); font-variant-numeric: tabular-nums; min-width: 26px;
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
    border: 1px solid transparent; letter-spacing: 0.2px;
}
.iss-state::before { content: "●"; font-size: 9px; }
.st-working { color: var(--info, var(--in-info)); background: var(--info-bg, var(--in-info-soft)); border-color: var(--info, var(--in-info)); }
.st-ready   { color: var(--success, var(--in-ok)); background: var(--success-bg, var(--in-ok-soft)); border-color: var(--success, var(--in-ok)); }
.st-pending { color: var(--text-dim, var(--in-fg-dim)); background: var(--surface-2, var(--in-bg-3)); border-color: var(--border, var(--in-border)); }
.st-blocked { color: var(--warning, var(--in-warn)); background: var(--warning-bg, var(--in-warn-soft)); border-color: var(--warning, var(--in-warn)); }
.st-bounce  { color: var(--danger, var(--in-bad)); background: var(--danger-bg, var(--in-bad-soft)); border-color: var(--danger, var(--in-bad)); }
.st-human   { color: var(--purple, var(--in-accent)); background: var(--purple-bg, var(--in-accent-soft)); border-color: var(--purple, var(--in-accent)); }

/* CA-7 — título completo con wrap, nunca truncado. */
.iss-title {
    font-size: 13px; line-height: 1.45; color: var(--text-primary, var(--in-fg));
    overflow-wrap: anywhere; word-break: break-word;
}
.iss-title.is-paused::before { content: "⏸ "; color: var(--warning, var(--in-warn)); font-weight: 700; }

.iss-meta { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.iss-fase {
    display: inline-flex; align-items: center; gap: 5px;
    font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px;
    color: var(--text-secondary, var(--in-fg-dim));
}
.iss-ico { width: 14px; height: 14px; fill: currentColor; }
.iss-bounces { font-size: 11px; color: var(--text-dim, var(--in-fg-dim)); font-variant-numeric: tabular-nums; }
.iss-bounces.warn { color: var(--warning, var(--in-warn)); font-weight: 600; }
.iss-rebote {
    display: inline-flex; align-items: center; font-size: 10px; font-weight: 600;
    color: var(--danger, var(--in-bad)); border: 1px solid var(--danger, var(--in-bad));
    background: var(--danger-bg, var(--in-bad-soft)); border-radius: 4px; padding: 1px 6px; cursor: help;
}

/* Acciones de la card: primaria + accesos + menú */
.iss-actions { display: flex; align-items: center; gap: 8px; margin-top: auto; flex-wrap: wrap; }
.iss-primary {
    display: inline-flex; align-items: center; gap: 7px; min-height: 34px; padding: 0 16px;
    border-radius: var(--radius-sm, 8px); font-size: 13px; font-weight: 700; cursor: pointer;
    text-decoration: none; border: 1px solid transparent; flex: 1; justify-content: center;
}
.iss-primary-glyph { font-size: 13px; line-height: 1; }
.iss-primary-trabajando { color: var(--info, var(--in-info)); background: var(--info-bg, var(--in-info-soft)); border-color: var(--info, var(--in-info)); }
.iss-primary-listo { color: var(--surface-0, var(--in-bg)); background: var(--success, var(--in-ok)); border-color: var(--success, var(--in-ok)); }
.iss-primary-bloqueado { color: var(--warning, var(--in-warn)); background: var(--warning-bg, var(--in-warn-soft)); border-color: var(--warning, var(--in-warn)); }
.iss-primary-backlog { color: var(--text-primary, var(--in-fg)); background: var(--surface-2, var(--in-bg-3)); border-color: var(--border, var(--in-border)); }
.iss-primary:hover { filter: brightness(1.06); }
.iss-primary:focus-visible { outline: 2px solid var(--border-strong, var(--in-accent)); outline-offset: 2px; }

.iss-access-row { display: flex; align-items: center; gap: 4px; }
.iss-access {
    display: inline-flex; align-items: center; justify-content: center;
    width: 32px; height: 32px; border-radius: 7px; cursor: pointer; text-decoration: none;
    background: transparent; border: 1px solid var(--border, var(--in-border));
    color: var(--text-secondary, var(--in-fg-dim)); transition: border-color 0.12s, color 0.12s;
}
.iss-access:hover { border-color: var(--info, var(--in-accent)); color: var(--info, var(--in-accent)); }
.iss-access:focus-visible { outline: 2px solid var(--border-strong, var(--in-accent)); outline-offset: 1px; }
.iss-access.is-disabled { opacity: 0.4; cursor: not-allowed; }
.iss-access.is-disabled:hover { border-color: var(--border, var(--in-border)); color: var(--text-secondary, var(--in-fg-dim)); }

.iss-menu-wrap { position: relative; }
.iss-menu-btn {
    display: inline-flex; align-items: center; justify-content: center;
    width: 32px; height: 32px; border-radius: 7px; cursor: pointer; font-size: 18px; line-height: 1;
    background: transparent; border: 1px solid var(--border, var(--in-border));
    color: var(--text-secondary, var(--in-fg-dim));
}
.iss-menu-btn:hover { border-color: var(--info, var(--in-accent)); color: var(--info, var(--in-accent)); }
.iss-menu-btn[aria-expanded="true"] { border-color: var(--info, var(--in-info)); color: var(--info, var(--in-info)); }
/* Reset: el atributo [hidden] debe ganarle al display:flex de los menús flotantes,
   sino todos los submenús se despliegan a la vez (bug visto en la ventana ISSUES). */
.iss-menu[hidden] { display: none !important; }
.iss-menu {
    position: absolute; right: 0; bottom: calc(100% + 6px); z-index: 60; min-width: 250px;
    display: flex; flex-direction: column; gap: 2px; padding: 6px;
    background: var(--surface-1, var(--in-bg-2)); border: 1px solid var(--border, var(--in-border));
    border-radius: var(--radius-md, 10px); box-shadow: var(--shadow-lg, var(--in-shadow));
}
.iss-mi {
    display: flex; align-items: flex-start; gap: 9px; padding: 8px 10px; border-radius: 8px;
    text-decoration: none; text-align: left; cursor: pointer; border: 0; width: 100%;
    background: transparent; color: var(--text-primary, var(--in-fg)); font: inherit;
}
.iss-mi:hover { background: var(--surface-2, var(--in-bg-3)); }
.iss-mi.is-disabled { opacity: 0.45; cursor: not-allowed; }
.iss-mi.is-disabled:hover { background: transparent; }
.iss-mi-glyph { font-size: 13px; line-height: 1.3; width: 16px; text-align: center; flex: none; }
.iss-mi-body { display: flex; flex-direction: column; gap: 1px; }
.iss-mi-label { font-size: 13px; font-weight: 600; }
.iss-mi-desc { font-size: 11px; color: var(--text-secondary, var(--in-fg-dim)); }
.iss-mi-danger .iss-mi-label { color: var(--danger, var(--in-bad)); }
.iss-mi-danger:hover { background: var(--danger-bg, var(--in-bad-soft)); }

/* Drilldown dialog */
.iss-dialog {
    width: min(560px, 92vw); border: 1px solid var(--border, var(--in-border));
    border-radius: var(--radius-lg, 12px); background: var(--surface-1, var(--in-bg-2));
    color: var(--text-primary, var(--in-fg)); padding: 0;
}
.iss-dialog::backdrop { background: var(--overlay, rgba(1, 4, 9, 0.66)); }
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

/* Toast de feedback. Tokens, sin HEX. */
.iss-toast {
    position: fixed; left: 50%; bottom: 28px; transform: translateX(-50%);
    z-index: 9999; padding: 10px 18px; border-radius: var(--radius-sm, 8px);
    font-size: 13px; font-weight: 600; line-height: 1.4; max-width: 80vw;
    text-align: center; pointer-events: none; opacity: 0;
    transition: opacity 0.2s ease; box-shadow: var(--shadow-md, var(--in-shadow));
    color: var(--text-primary, var(--in-fg));
    background: var(--success-bg, var(--in-ok-soft)); border: 1px solid var(--success, var(--in-ok));
}
.iss-toast.is-show { opacity: 1; }
.iss-toast.is-err { background: var(--danger-bg, var(--in-bad-soft)); border-color: var(--danger, var(--in-bad)); }
`;

// =============================================================================
// renderIssuesClientScript() — JS cliente. Polling a /api/dash/pipeline +
// re-render AGRUPADO del backlog + filtro + orden + drilldown + acciones.
// Estado con nombres propios (issuesSnapshot, selectedIssueId).
// =============================================================================
function renderIssuesClientScript() {
    return `
'use strict';
(function () {
  var ISS_GH = 'https://github.com/intrale/platform/issues/';
  var STATE_LABEL = { trabajando:'Trabajando', listo:'Listo', pendiente:'Pendiente', bloqueado:'Bloqueado', rebote:'Rebote', 'needs-human':'Necesita humano' };
  var STATE_CLS = { trabajando:'st-working', listo:'st-ready', pendiente:'st-pending', bloqueado:'st-blocked', rebote:'st-bounce', 'needs-human':'st-human' };
  var FASE_ORDER = ['sizing','analisis','criterios','validacion','dev','build','verificacion','linteo','aprobacion','entrega'];
  var FASE_ICON = {}; FASE_ORDER.forEach(function (f) { FASE_ICON[f] = 'ic-fase-' + f; });
  var GROUP_ORDER = ['trabajando','listo','bloqueado','backlog'];
  var GROUP_META = {
    trabajando: { label:'Trabajando', dot:'st-working', primary:{ kind:'btn', action:'pause', label:'Pausar', glyph:'⏸', desc:'Suspende el agente sin perder el progreso' } },
    listo:      { label:'Listos', dot:'st-ready', primary:{ kind:'btn', action:'move-top', label:'Lanzar', glyph:'▶', desc:'Fuerza el slot: salta al frente de la cola, sin esperar turno' } },
    bloqueado:  { label:'Bloqueados', dot:'st-blocked', primary:{ kind:'btn', action:'resume', label:'Destrabar', glyph:'🔓', desc:'Override manual de la dependencia: reanuda el issue' } },
    backlog:    { label:'Backlog', dot:'st-pending', primary:{ kind:'link', action:'define', label:'Definir', glyph:'✎', desc:'Abrí el issue para refinarlo con /doc' } }
  };

  var issuesSnapshot = null;
  var selectedIssueId = null;
  var activeFilter = 'all';
  var searchTerm = '';
  var orderMode = 'manual';
  var groupMode = 'estado';
  var _kaCsrf = null;

  function escapeHtml(s) {
    if (s === null || s === undefined) return '';
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/\\//g, '&#x2F;');
  }
  function iconSvg(id, cls) {
    var safe = String(id || '').replace(/[^a-z0-9-]/g, '');
    return '<svg class="' + cls + '" aria-hidden="true" focusable="false" viewBox="0 0 24 24"><use href="#' + safe + '"></use></svg>';
  }
  function faseShort(f) { var raw = String(f || ''); if (!raw) return ''; var p = raw.split('/'); return p[p.length - 1] || raw; }
  function faseIconId(f) { return FASE_ICON[f] || 'ic-issues-count'; }
  function deriveState(d) {
    var labels = (d && d.labels) || [];
    if (d && d.rebote) return 'rebote';
    if (labels.indexOf('needs-human') >= 0) return 'needs-human';
    if (labels.indexOf('blocked:dependencies') >= 0) return 'bloqueado';
    var e = d && d.estadoActual;
    if (e === 'trabajando' || e === 'listo' || e === 'pendiente') return e;
    return 'pendiente';
  }
  function deriveGroup(d) {
    var labels = (d && d.labels) || [];
    if (labels.indexOf('needs-human') >= 0 || labels.indexOf('blocked:dependencies') >= 0) return 'bloqueado';
    var e = d && d.estadoActual;
    if (e === 'trabajando') return 'trabajando';
    if (e === 'listo') return 'listo';
    return 'backlog';
  }

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
    if (orderMode === 'numero') {
      rows.sort(function (a, b) { return Number(a.id) - Number(b.id); });
    } else {
      rows.sort(function (a, b) {
        if (a.prio >= 0 && b.prio >= 0) return a.prio - b.prio;
        if (a.prio >= 0) return -1;
        if (b.prio >= 0) return 1;
        return Number(a.id) - Number(b.id);
      });
    }
    return rows;
  }

  function matchesFilter(row) {
    if (activeFilter !== 'all') {
      if (activeFilter === 'rebote') { if (!row.data.rebote) return false; }
      else if (activeFilter === 'backlog') { if (deriveGroup(row.data) !== 'backlog') return false; }
      else if (deriveGroup(row.data) !== activeFilter) return false;
    }
    if (searchTerm) {
      var hay = (row.id + ' ' + (row.data.title || '') + ' ' + (row.data.faseActual || '')).toLowerCase();
      if (hay.indexOf(searchTerm) < 0) return false;
    }
    return true;
  }

  function menuItemHtml(o) {
    var glyph = '<span class="iss-mi-glyph" aria-hidden="true">' + escapeHtml(o.glyph || '·') + '</span>';
    var body = '<span class="iss-mi-body"><span class="iss-mi-label">' + escapeHtml(o.label) + '</span><span class="iss-mi-desc">' + escapeHtml(o.desc || '') + '</span></span>';
    var cls = 'iss-mi' + (o.danger ? ' iss-mi-danger' : '') + (o.disabled ? ' is-disabled' : '');
    var tip = escapeHtml((o.label || '') + (o.desc ? ' — ' + o.desc : ''));
    if (o.disabled) return '<span class="' + cls + '" role="menuitem" aria-disabled="true" title="' + tip + '">' + glyph + body + '</span>';
    if (o.link) return '<a class="' + cls + '" role="menuitem" href="' + escapeHtml(o.link) + '" target="_blank" rel="noopener" title="' + tip + '">' + glyph + body + '</a>';
    var attrs = 'data-issue="' + escapeHtml(String(o.issue)) + '" data-action="' + escapeHtml(o.action) + '"';
    if (o.skill) attrs += ' data-skill="' + escapeHtml(o.skill) + '"';
    if (o.pipeline) attrs += ' data-pipeline="' + escapeHtml(o.pipeline) + '"';
    if (o.fase) attrs += ' data-fase="' + escapeHtml(o.fase) + '"';
    return '<button type="button" class="' + cls + '" role="menuitem" ' + attrs + ' title="' + tip + '">' + glyph + body + '</button>';
  }

  function cardHtml(row) {
    var num = Number(row.id);
    if (!isFinite(num) || num <= 0) return '';
    var d = row.data || {};
    var st = deriveState(d);
    var group = deriveGroup(d);
    var cls = STATE_CLS[st] || 'st-pending';
    var label = STATE_LABEL[st] || 'Pendiente';
    var labels = d.labels || [];
    var paused = labels.indexOf('blocked:dependencies') >= 0;
    var prio = (row.prio >= 0) ? '#' + (row.prio + 1) : '—';
    var fase = faseShort(d.faseActual) || '—';
    var bounces = Number(d.bounces) || 0;
    var gh = ISS_GH + num;
    var pipelineSeg = String(d.faseActual || '').split('/')[0] || '';
    var agents = (d.agents && d.agents.length) ? d.agents : [];
    var skill = (agents[0] && agents[0].skill) ? String(agents[0].skill) : '';
    var hasRun = !!d.logFile;
    var logHref = d.logFile ? ('/logs/view/' + encodeURIComponent(d.logFile) + (d.estadoActual === 'trabajando' ? '?live=1' : '')) : '';

    var rebote = '';
    if (d.rebote) {
      var motivo = String(d.motivo_rechazo || '').slice(0, 300);
      var tip = 'Rechazado en ' + (d.rechazado_en_fase || '?') + (d.rechazado_skill_previo ? '/' + d.rechazado_skill_previo : '') + ': ' + motivo;
      rebote = '<span class="iss-rebote" title="' + escapeHtml(tip) + '">↩ rechazo</span>';
    }
    var bbadge = bounces > 0
      ? '<span class="iss-bounces' + (bounces > 2 ? ' warn' : '') + '" title="' + escapeHtml(bounces + ' rebote(s) acumulados') + '">' + escapeHtml(String(bounces)) + '×</span>'
      : '';

    var gm = GROUP_META[group] || GROUP_META.backlog;
    var p = gm.primary;
    var ptip = escapeHtml(p.label + ' — ' + p.desc);
    var paria = escapeHtml(p.label + ' issue ' + num + ': ' + p.desc);
    var primary;
    if (p.kind === 'link') {
      primary = '<a class="iss-primary iss-primary-' + group + '" href="' + escapeHtml(gh) + '" target="_blank" rel="noopener" title="' + ptip + '" aria-label="' + paria + '"><span class="iss-primary-glyph" aria-hidden="true">' + escapeHtml(p.glyph) + '</span><span>' + escapeHtml(p.label) + '</span></a>';
    } else {
      primary = '<button type="button" class="iss-primary iss-primary-' + group + '" data-issue="' + num + '" data-action="' + escapeHtml(p.action) + '" title="' + ptip + '" aria-label="' + paria + '"><span class="iss-primary-glyph" aria-hidden="true">' + escapeHtml(p.glyph) + '</span><span>' + escapeHtml(p.label) + '</span></button>';
    }

    var access = '<a class="iss-access iss-gh" href="' + escapeHtml(gh) + '" target="_blank" rel="noopener" title="Ver issue en GitHub ↗" aria-label="' + escapeHtml('Ver issue ' + num + ' en GitHub') + '">' + iconSvg('ic-link-out', 'iss-ico') + '</a>';
    if (hasRun) access += '<a class="iss-access iss-logs" href="' + escapeHtml(logHref) + '" target="_blank" rel="noopener" title="Ver log del agente" aria-label="' + escapeHtml('Ver log del agente del issue ' + num) + '">' + iconSvg('ic-tab-historial', 'iss-ico') + '</a>';
    else access += '<span class="iss-access iss-logs is-disabled" aria-disabled="true" title="Sin logs: el issue todavía no corrió" aria-label="' + escapeHtml('Sin logs: el issue ' + num + ' todavía no corrió') + '">' + iconSvg('ic-tab-historial', 'iss-ico') + '</span>';

    var items = [];
    items.push(menuItemHtml({ link: gh, label: 'Ver issue', glyph: '🔗', desc: 'Abrir el issue en GitHub' }));
    items.push(menuItemHtml({ link: hasRun ? logHref : null, label: 'Logs del agente', glyph: '📄', desc: hasRun ? 'Ver el log del agente' : 'Todavía no corrió', disabled: !hasRun }));
    items.push(menuItemHtml({ issue: num, action: 'move-top', label: 'Mover a tope', glyph: '⤒', desc: 'Saltar al frente de la cola de prioridad' }));
    items.push(menuItemHtml({ issue: num, action: 'move-bottom', label: 'Mover a fondo', glyph: '⤓', desc: 'Enviar al final de la cola de prioridad' }));
    if (group === 'trabajando') {
      if (skill && pipelineSeg && fase !== '—') items.push(menuItemHtml({ issue: num, action: 'cancel', label: 'Cancelar agente', glyph: '✕', desc: 'Detiene el agente en ejecución', danger: true, skill: skill, pipeline: pipelineSeg, fase: fase }));
    } else if (group === 'listo') {
      items.push(menuItemHtml({ issue: num, action: 'pause', label: 'Pausar', glyph: '⏸', desc: 'Suspender el issue antes de lanzarlo' }));
    } else if (group === 'backlog') {
      items.push(menuItemHtml({ issue: num, action: 'move-up', label: 'Subir prioridad', glyph: '▲', desc: 'Subir un puesto en la cola' }));
    } else if (group === 'bloqueado') {
      items.push(menuItemHtml({ issue: num, action: 'pause', label: 'Pausar', glyph: '⏸', desc: 'Mantener bloqueado explícitamente' }));
    }
    var menu = '<div class="iss-menu-wrap"><button type="button" class="iss-menu-btn" data-menu-issue="' + num + '" aria-haspopup="true" aria-expanded="false" title="Más acciones" aria-label="' + escapeHtml('Más acciones del issue ' + num) + '">⋯</button><div class="iss-menu" role="menu" hidden aria-label="' + escapeHtml('Acciones del issue ' + num) + '">' + items.join('') + '</div></div>';

    var aria = 'Issue ' + num + ': ' + (d.title || '') + ', fase ' + fase + ', estado ' + label;
    return '<article class="iss-card" tabindex="0" role="article" data-issue="' + num + '" data-state="' + st + '" data-group="' + group + '" data-fase="' + escapeHtml(fase) + '" aria-label="' + escapeHtml(aria) + '">'
      + '<div class="iss-top"><span class="iss-prio' + (row.prio >= 0 ? ' set' : '') + '">' + escapeHtml(prio) + '</span>'
      + '<a class="iss-num" href="' + escapeHtml(gh) + '" target="_blank" rel="noopener">#' + num + '</a>'
      + '<span class="iss-state ' + cls + '">' + escapeHtml(label) + '</span></div>'
      + '<div class="iss-title' + (paused ? ' is-paused' : '') + '" title="' + escapeHtml(d.title || '') + '">' + escapeHtml(d.title || '') + '</div>'
      + '<div class="iss-meta"><span class="iss-fase">' + iconSvg(faseIconId(fase), 'iss-ico') + '<span>' + escapeHtml(fase) + '</span></span>' + bbadge + rebote + '</div>'
      + '<div class="iss-actions">' + primary + '<div class="iss-access-row" role="group" aria-label="' + escapeHtml('Accesos del issue ' + num) + '">' + access + menu + '</div></div>'
      + '</article>';
  }

  function groupKeyFor(row) {
    if (groupMode === 'fase') return faseShort(row.data.faseActual) || 'sin-fase';
    if (groupMode === 'none') return 'all';
    return deriveGroup(row.data);
  }
  function sectionOrder() {
    if (groupMode === 'fase') return FASE_ORDER.slice();
    if (groupMode === 'none') return ['all'];
    return GROUP_ORDER.slice();
  }
  function sectionLabel(key) {
    if (groupMode === 'estado') return (GROUP_META[key] && GROUP_META[key].label) || key;
    if (groupMode === 'none') return 'Todos los issues';
    return key;
  }
  function sectionDot(key) {
    if (groupMode === 'estado') return (GROUP_META[key] && GROUP_META[key].dot) || 'st-pending';
    return 'st-pending';
  }

  function renderGrid() {
    var grid = document.getElementById('issues-grid');
    if (!grid || !issuesSnapshot) return;
    var rows = orderedIssues().filter(matchesFilter);
    updateCounters();
    updateChipCounts();
    if (rows.length === 0) {
      grid.innerHTML = '<div class="iss-empty">Sin issues que coincidan con el filtro</div>';
      return;
    }
    // CA-7 — nunca truncar: se agrupan y muestran TODOS los issues.
    var buckets = {};
    rows.forEach(function (r) { var k = groupKeyFor(r); (buckets[k] = buckets[k] || []).push(r); });
    var order = sectionOrder();
    // Claves no previstas (p. ej. fases fuera del orden canónico) van al final.
    Object.keys(buckets).forEach(function (k) { if (order.indexOf(k) < 0) order.push(k); });
    var html = '<div class="iss-groups">';
    order.forEach(function (key) {
      var list = buckets[key];
      if (!list || !list.length) return;
      html += '<section class="iss-group" data-group-key="' + escapeHtml(key) + '">'
        + '<div class="iss-group-head"><span class="iss-group-dot ' + sectionDot(key) + '" aria-hidden="true"></span>'
        + '<span class="iss-group-title">' + escapeHtml(sectionLabel(key)) + '</span>'
        + '<span class="iss-group-count">' + list.length + '</span></div>'
        + '<div class="iss-group-grid">' + list.map(cardHtml).join('') + '</div></section>';
    });
    html += '</div>';
    grid.innerHTML = html;
  }

  function counts() {
    var rows = orderedIssues();
    var c = { total: rows.length, trabajando: 0, listo: 0, bloqueado: 0, backlog: 0, rebote: 0 };
    rows.forEach(function (r) {
      var g = deriveGroup(r.data);
      if (c.hasOwnProperty(g)) c[g]++;
      if (r.data.rebote) c.rebote++;
    });
    return c;
  }
  function setText(id, v) { var el = document.getElementById(id); if (el) el.textContent = String(v); }
  function updateCounters() {
    var c = counts();
    setText('iss-count-total', c.total);
    setText('iss-count-working', c.trabajando);
    setText('iss-count-ready', c.listo);
    setText('iss-count-blocked', c.bloqueado);
  }
  function updateChipCounts() {
    var c = counts();
    var map = { all: c.total, trabajando: c.trabajando, listo: c.listo, bloqueado: c.bloqueado, rebote: c.rebote, backlog: c.backlog };
    document.querySelectorAll('[data-chip-count]').forEach(function (el) {
      var k = el.getAttribute('data-chip-count');
      if (map.hasOwnProperty(k)) el.textContent = String(map[k]);
    });
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
    document.getElementById('issues-dialog-meta').textContent = 'Estado: ' + (STATE_LABEL[st] || st) + ' · Fase: ' + (faseShort(d.faseActual) || '—') + ' · Rebotes: ' + (Number(d.bounces) || 0);
    var rej = document.getElementById('issues-dialog-reject');
    if (d.rebote && d.motivo_rechazo) {
      rej.textContent = 'Rechazado en ' + (d.rechazado_en_fase || '?') + (d.rechazado_skill_previo ? '/' + d.rechazado_skill_previo : '') + ': ' + String(d.motivo_rechazo).slice(0, 300);
      rej.hidden = false;
    } else { rej.hidden = true; rej.textContent = ''; }
    var tl = document.getElementById('issues-dialog-timeline');
    tl.innerHTML = '';
    var curFase = faseShort(d.faseActual);
    FASE_ORDER.forEach(function (f) {
      var li = document.createElement('li');
      li.className = 'iss-dialog-phase';
      if (f === curFase) li.setAttribute('data-current', '1');
      li.innerHTML = iconSvg(faseIconId(f), 'iss-ico');
      var span = document.createElement('span'); span.textContent = f; li.appendChild(span);
      tl.appendChild(li);
    });
    var acts = document.getElementById('issues-dialog-actions');
    acts.innerHTML = '';
    var gh = document.createElement('a');
    gh.href = ISS_GH + num; gh.target = '_blank'; gh.rel = 'noopener'; gh.textContent = 'Abrir en GitHub';
    acts.appendChild(gh);
    if (typeof dlg.showModal === 'function') dlg.showModal(); else dlg.setAttribute('open', '');
  }

  function issToast(msg, ok) {
    if (typeof window.showToast === 'function') { try { window.showToast(msg, ok); return; } catch (e) {} }
    var t = document.getElementById('iss-toast');
    if (!t) { t = document.createElement('div'); t.id = 'iss-toast'; t.className = 'iss-toast'; t.setAttribute('role', 'status'); t.setAttribute('aria-live', 'polite'); document.body.appendChild(t); }
    t.textContent = msg; t.classList.toggle('is-err', !ok); t.classList.add('is-show');
    clearTimeout(t._hide); t._hide = setTimeout(function () { t.classList.remove('is-show'); }, 3200);
  }

  async function moveIssue(issue, action) {
    try {
      var res = await fetch('/api/issue/' + encodeURIComponent(issue) + '/' + encodeURIComponent(action), { method: 'POST' });
      var j = {}; try { j = await res.json(); } catch (e) {}
      issToast(j.msg || (res.ok ? 'Movido' : 'No se pudo mover'), res.ok && j.ok !== false);
      setTimeout(function () { tickIssues(); }, 400);
    } catch (e) { issToast('Error: ' + e.message, false); }
  }

  async function pauseIssue(issue, isResume) {
    var action = isResume ? 'resume' : 'pause';
    if (!isResume && !(await inConfirm({
        title: 'Pausar #' + issue,
        message: 'Agrega label blocked:dependencies; el pulpo lo saltea hasta que lo reanudes.',
        confirmLabel: 'Pausar',
        preview: [{ label: 'Issue', value: '#' + issue }]
      }))) { return; }
    try {
      var res = await fetch('/api/issue/' + encodeURIComponent(issue) + '/' + action, { method: 'POST' });
      var j = {}; try { j = await res.json(); } catch (e) {}
      issToast(j.msg || (res.ok ? (isResume ? 'Reanudado' : 'Pausado') : 'No se pudo'), res.ok && j.ok !== false);
      setTimeout(function () { tickIssues(); }, 600);
    } catch (e) { issToast('Error: ' + e.message, false); }
  }

  // Cancelar agente en ejecución (kill-agent con CSRF, mismo patrón que home).
  async function killCsrfHeaders(force) {
    try {
      if (force) _kaCsrf = null;
      if (!_kaCsrf) { var r = await fetch('/api/kill-agent/csrf-token', { cache: 'no-store' }); if (r && r.ok) { var j = await r.json(); _kaCsrf = (j && j.csrf_token) || null; } }
      return _kaCsrf ? { 'X-CSRF-Token': _kaCsrf } : {};
    } catch (e) { return {}; }
  }
  async function cancelAgent(issue, skill, pipeline, fase) {
    if (!(await inConfirm({
        title: 'Cancelar agente #' + issue,
        message: 'Detiene el agente ' + skill + ' en ejecución para este issue.',
        confirmLabel: 'Cancelar agente', danger: true,
        preview: [{ label: 'Issue', value: '#' + issue }, { label: 'Skill', value: skill }, { label: 'Fase', value: pipeline + '/' + fase }]
      }))) { return; }
    var payload = { issue: Number(issue), skill: skill, pipeline: pipeline, fase: fase };
    async function doPost() { return fetch('/api/kill-agent', { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, await killCsrfHeaders()), body: JSON.stringify(payload) }); }
    try {
      var res = await doPost();
      if (res && res.status === 403) { await killCsrfHeaders(true); res = await doPost(); }
      var j = {}; try { j = await res.json(); } catch (e) {}
      issToast(j.msg || (res.ok ? 'Agente cancelado' : 'No se pudo cancelar'), res.ok && j.ok !== false);
      setTimeout(function () { tickIssues(); }, 800);
    } catch (e) { issToast('Error: ' + e.message, false); }
  }

  function closeAllMenus(except) {
    document.querySelectorAll('.iss-menu').forEach(function (m) {
      if (except && m === except) return;
      m.hidden = true;
      var btn = m.parentNode && m.parentNode.querySelector('.iss-menu-btn');
      if (btn) btn.setAttribute('aria-expanded', 'false');
    });
  }

  function bindGridDelegation() {
    var grid = document.getElementById('issues-grid');
    if (!grid) return;
    grid.addEventListener('click', function (ev) {
      var menuBtn = ev.target.closest('.iss-menu-btn');
      if (menuBtn) {
        ev.stopPropagation();
        var menu = menuBtn.parentNode.querySelector('.iss-menu');
        var willOpen = menu.hidden;
        closeAllMenus(willOpen ? menu : null);
        menu.hidden = !willOpen;
        menuBtn.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
        return;
      }
      var btn = ev.target.closest('button[data-action]');
      if (btn) {
        ev.stopPropagation();
        var action = btn.getAttribute('data-action');
        var issue = btn.getAttribute('data-issue');
        if (action === 'pause') pauseIssue(issue, false);
        else if (action === 'resume') pauseIssue(issue, true);
        else if (action === 'cancel') cancelAgent(issue, btn.getAttribute('data-skill'), btn.getAttribute('data-pipeline'), btn.getAttribute('data-fase'));
        else if (action === 'move-top' || action === 'move-up' || action === 'move-down' || action === 'move-bottom') moveIssue(issue, action);
        closeAllMenus(null);
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
    document.addEventListener('click', function () { closeAllMenus(null); });
  }

  function bindFilters() {
    var chips = document.querySelectorAll('.iss-chip[data-filter]');
    chips.forEach(function (chip) {
      chip.addEventListener('click', function () {
        activeFilter = chip.getAttribute('data-filter');
        chips.forEach(function (c) { var on = c === chip; c.classList.toggle('is-active', on); c.setAttribute('aria-pressed', on ? 'true' : 'false'); });
        renderGrid();
      });
    });
    var search = document.getElementById('issues-search');
    if (search) search.addEventListener('input', function (e) { searchTerm = (e.target.value || '').toLowerCase(); renderGrid(); });
    var ord = document.getElementById('iss-order');
    if (ord) ord.addEventListener('change', function (e) { orderMode = e.target.value || 'manual'; renderGrid(); });
    var grp = document.getElementById('iss-group');
    if (grp) grp.addEventListener('change', function (e) { groupMode = e.target.value || 'estado'; renderGrid(); });
  }

  // ── Hidratación del marco común MIZPÁ (#4237) ──────────────────────────────
  // El banner de ola (② AVANCE) y la cabecera (reloj + estado + pill de build)
  // se hidratan client-side con los MISMOS IDs mission-* / hdr-* / bld-status
  // que el resto de las pantallas, consumiendo /api/dash/waves y /api/dash/header.
  // No se duplica markup: sólo se reusa el contrato de IDs del marco compartido.
  function setText(id, value) {
    var el = document.getElementById(id);
    if (el && el.textContent !== String(value)) el.textContent = String(value);
  }
  function setWidth(id, pct) { var el = document.getElementById(id); if (el) el.style.width = pct; }

  function mirrorMission(d) {
    try {
      var wave = d && d.active_wave;
      if (!wave) { setText('mission-wave-num', '—'); setText('mission-wave-name', 'Sin ola activa'); return; }
      if (isFinite(wave.number)) setText('mission-wave-num', String(wave.number));
      setText('mission-wave-name', wave.name ? ('Ola ' + wave.number + ' · ' + wave.name) : ('Ola ' + wave.number));
      var desc = wave.goal || wave.description;
      if (desc) setText('mission-wave-desc', desc);
      var tag = document.getElementById('mission-wave-tag');
      if (tag) tag.style.display = wave.isLast ? '' : 'none';
      var issues = Array.isArray(wave.issues) ? wave.issues : [];
      var done = 0, active = 0, blocked = 0, queue = 0;
      for (var i = 0; i < issues.length; i++) {
        var s = issues[i] && issues[i].status;
        if (s === 'completed') done++;
        else if (s === 'in-progress') active++;
        else if (s === 'blocked') blocked++;
        else queue++;
      }
      var total = issues.length || 0;
      // #4296 — el avance % lo hidrata el accessor compartido desde /api/dash/ola-eta
      // (totalPct determinístico), no desde done/total. Acá sólo leyenda/barras.
      setText('mission-leg-done', String(done));
      setText('mission-leg-active', String(active));
      setText('mission-leg-blocked', String(blocked));
      setText('mission-leg-queue', String(queue));
      var w = function (n) { return total > 0 ? ((n / total) * 100).toFixed(1) + '%' : '0%'; };
      setWidth('mission-bar-done', w(done));
      setWidth('mission-bar-active', w(active));
      setWidth('mission-bar-blocked', w(blocked));
      setWidth('mission-bar-queue', w(queue));
      var dv = document.getElementById('mission-delivered-value');
      if (dv) dv.innerHTML = done + '<span class="mz-wm-u"> / ' + total + '</span>';
      var dsub = document.getElementById('mission-delivered-sub');
      if (dsub) dsub.textContent = Math.max(0, total - done) + ' restantes';
    } catch (e) { /* defensivo: nunca romper el render por el banner */ }
  }

  async function tickWaves() {
    var d = await fetchJson('/api/dash/waves');
    if (d) mirrorMission(d);
  }

  async function tickHeader() {
    setText('hdr-clock', new Date().toLocaleTimeString('es-AR'));
    var d = await fetchJson('/api/dash/header');
    if (!d) return;
    var modePill = document.getElementById('hdr-mode');
    if (modePill) {
      modePill.classList.remove('in-mode-running', 'in-mode-paused', 'in-mode-partial');
      if (d.mode === 'paused') { modePill.classList.add('in-mode-paused'); modePill.textContent = '⏸ Pausado'; }
      else if (d.mode === 'partial_pause') {
        var n = Array.isArray(d.allowedIssues) ? d.allowedIssues.length : 0;
        modePill.classList.add('in-mode-partial'); modePill.textContent = '⏸ Parcial · ' + n + ' issues';
      } else { modePill.classList.add('in-mode-running'); modePill.textContent = '🟢 Running'; }
    }
    var bld = document.getElementById('bld-status');
    if (bld && d.build) {
      var META = {
        passing: { cls: 'in-pill-ok', t: '🟢 Build OK' }, failing: { cls: 'in-pill-bad', t: '🔴 Build roto' },
        running: { cls: 'in-pill-warn', t: '🟡 Build corriendo' }, unknown: { cls: 'in-pill-info', t: '○ Build ?' }
      };
      var m = META[d.build.status] || META.unknown;
      bld.classList.remove('in-pill-ok', 'in-pill-bad', 'in-pill-warn', 'in-pill-info');
      bld.classList.add(m.cls);
      var detail = [d.build.branch, d.build.commit].filter(Boolean).join(' · ');
      bld.textContent = m.t + (detail ? ' · ' + detail : '');
    }
  }

  async function tickIssues() {
    var snap = await fetchJson('/api/dash/pipeline');
    if (!snap) return;
    issuesSnapshot = snap;
    renderGrid();
  }

  function init() {
    bindGridDelegation();
    bindFilters();
    tickIssues();
    tickHeader();
    tickWaves();
    setInterval(function () { tickIssues(); }, 60000);
    setInterval(function () { tickHeader(); }, 5000);
    setInterval(function () { tickWaves(); }, 30000);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
`;
}

// =============================================================================
// SSR del backlog agrupado a partir de los issues iniciales. Nunca trunca.
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
    // CA-7 — sin slice: se renderizan TODOS los issues.
    return rows.map((r) => normalizeIssue(r.id, r.data, r.prio));
}

function renderGroupedSSR(initial) {
    const buckets = { trabajando: [], listo: [], bloqueado: [], backlog: [] };
    for (const it of initial) {
        const g = deriveGroup(it);
        (buckets[g] || buckets.backlog).push(it);
    }
    let html = '<div class="iss-groups">';
    let any = false;
    for (const key of GROUP_ORDER) {
        const list = buckets[key];
        if (!list || !list.length) continue;
        any = true;
        const gm = GROUP_META[key];
        html += '<section class="iss-group" data-group-key="' + key + '">'
            + '<div class="iss-group-head"><span class="iss-group-dot ' + gm.dot + '" aria-hidden="true"></span>'
            + '<span class="iss-group-title">' + escapeHtmlSsr(gm.label) + '</span>'
            + '<span class="iss-group-count">' + list.length + '</span></div>'
            + '<div class="iss-group-grid">' + list.map(renderIssueCard).join('') + '</div></section>';
    }
    html += '</div>';
    if (!any) return '<div class="iss-empty">El pipeline está al día — sin issues activos</div>';
    return html;
}

function countGroups(initial) {
    const c = { total: initial.length, trabajando: 0, listo: 0, blocked: 0 };
    for (const it of initial) {
        const g = deriveGroup(it);
        if (g === 'trabajando') c.trabajando++;
        else if (g === 'listo') c.listo++;
        else if (g === 'bloqueado') c.blocked++;
    }
    return c;
}

// =============================================================================
// renderIssuesHTML(opts) — página completa de la ventana `/issues`.
//   opts.matrix / opts.priorityOrder — snapshot del pipelineSlice.
//   opts.mission — datos de la ola para el banner (derivados en la ruta).
//   opts.initialIssues — alternativa: array de issues ya normalizados.
// =============================================================================
function renderIssuesHTML(opts) {
    const theme = loadTheme();
    const tokens = loadDesignTokens();
    const spriteInline = loadIconSprite();
    const mission = (opts && opts.mission) || null;
    // #4237 — CSS del marco común MIZPÁ (cabecera de ola + brand): vive en
    // PIPELINE_REDESIGN_CSS (helpers de #4234). Se inyecta para que el banner
    // ② (mz-mission/mz-wavetag/mz-prog-*) y la marca rindan idéntico al resto.
    const chromeCss = (pipelineRedesign && pipelineRedesign.PIPELINE_REDESIGN_CSS) || '';

    const initial = buildInitialIssues(opts);
    const counts = countGroups(initial);
    const gridInner = renderGroupedSSR(initial);

    const body = '<main class="iss-body" id="issues-body">'
        + renderCounters(counts)
        + renderIssuesFilterBar()
        + '<div id="issues-grid" aria-live="polite" aria-label="Backlog agrupado por estado">'
        +   gridInner
        + '</div>'
        + renderIssuesDialog()
        + '</main>';

    return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Intrale · Issues</title>
<style>${theme}</style>
<style>${tokens}</style>
<style>${chromeCss}</style>
<style>${ISSUES_CSS}</style>
</head>
<body>
<div aria-hidden="true" style="position:absolute;width:0;height:0;overflow:hidden">${spriteInline}</div>
${renderStaleBanner()}
<a href="#issues-grid" class="in-skip-link" style="position:absolute;left:-9999px">Saltar al listado de issues</a>
<div class="iss-frame">
  ${renderMizpaChrome(mission)}
  ${body}
  <footer class="in-footer">
    <span>Centro de mando MIZPÁ · backlog en vivo cada 60s</span>
    <span>Intrale V3 · #4192</span>
  </footer>
</div>
<script>${FETCH_CLIENT_JS}
${CONFIRM_MODAL_JS}
${renderIssuesClientScript()}
${missionOlaEtaClientScript()}</script>
</body>
</html>`;
}

// Panel inerte visible (CA-A3) si el require/render fallara aguas arriba.
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
    renderCounters,
    countGroups,
    GROUP_ORDER,
    renderIssuesDialog,
    renderMizpaChrome,
    buildInitialIssues,
    renderGroupedSSR,
    normalizeIssue,
    deriveState,
    deriveGroup,
    renderInert,
    ISSUES_CSS,
    escapeHtmlSsr,
    escapeHtmlAttr,
};
