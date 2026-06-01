// =============================================================================
// multi-provider-coverage.js — Vista HTML/JS del widget Multi-Provider
// Coverage del dashboard V3 (#3681, hijo B del épico #3669).
//
// Mount points:
//   - GET /multi-provider-coverage          renderMultiProviderCoverage()
//   - lee   GET /api/dash/multi-provider-coverage         (matriz)
//   - escribe POST /api/dash/multi-provider-coverage/run  (botón harness)
//
// Reglas duras (REQ-SEC-B4, B5, B7, B9, CA-B5, B13..B19):
//   - Todos los campos dinámicos del JSON → `textContent` o template literals
//     escapados. NUNCA `innerHTML` / `insertAdjacentHTML` salvo para markup
//     estático del propio módulo. Defensa en profundidad ante un compromiso
//     downstream del JSON persistido.
//   - Cada celda combina color + glyph + texto (regla §3 design system).
//   - Tooltip popover custom, no `title=` nativo (rompe focus de teclado).
//     Estado del popover en JS state, NUNCA leído de `data-*` con innerHTML.
//   - DOM morphing anti-flicker (#2801): diff por id de celda, no reemplazar
//     container completo.
//   - Link al issue construido server-side como `https://github.com/intrale/
//     platform/issues/${Number(issue)}` con cast Number() explícito. NO
//     concatenar el campo del JSON crudo.
//   - Matriz envuelta en `<table>` real con `<thead>/<tbody>` para screen
//     readers. CSS grid se aplica a `<table>` directo.
//   - Cada `<svg>` con `role="img"` y `aria-label` no vacío. Celdas N/A con
//     `aria-label` explícito.
//   - Focus visible: outline 2px var(--in-accent).
//
// Estados del payload:
//   - {error: 'coverage_unavailable', reason: 'not_yet_run'} → vista vacía
//     con CTA "Ejecutar harness" (si el guard de coordinación lo permite).
//   - {error: 'coverage_unavailable', reason: '...'} → mismo CTA + reason
//     mostrada en banner de coordinación.
//   - payload OK → render normal de la matriz.
// =============================================================================
'use strict';

const fs = require('node:fs');
const path = require('node:path');

// #3726 — Nav bar V3 unificada (vista satelite "Providers").
// El widget de coverage es una sub-vista del satelite providers, asi que
// pertenece a la tab "providers" en la barra unificada.
const { renderNavTabsSsr } = require('./nav-tabs');

const THEME_CSS_PATH = path.join(__dirname, 'theme.css');
function loadTheme() {
    try { return fs.readFileSync(THEME_CSS_PATH, 'utf8'); } catch { return ''; }
}

// Path real del sprite (corregido en D2 de criterios — el body del issue
// erróneamente apunta a `views/dashboard/sprite.svg`).
const SPRITE_PATH = path.resolve(__dirname, '..', '..', 'assets', 'icons', 'sprite.svg');
function loadSprite() {
    try { return fs.readFileSync(SPRITE_PATH, 'utf8'); } catch { return ''; }
}

// -----------------------------------------------------------------------------
// CSS — tokens existentes de theme.css. CERO tokens nuevos (CA-B4).
// -----------------------------------------------------------------------------
const PANEL_CSS = `
.mpc-frame { max-width: 1600px; margin: 0 auto; padding: 0; }
.mpc-body { padding: 22px 28px; display: flex; flex-direction: column; gap: 18px; }

/* Banners */
.mpc-banner { background: var(--in-bg-3); border: 1px solid var(--in-border); border-radius: var(--in-radius-sm); padding: 12px 16px; display: flex; gap: 12px; align-items: center; }
.mpc-banner .mpc-icon { width: 18px; height: 18px; flex: 0 0 auto; }
.mpc-banner-title { font-weight: 600; font-size: 13px; margin-bottom: 2px; }
.mpc-banner-sub { color: var(--in-fg-dim); font-size: 12px; }
.mpc-banner.coord-ok { border-left: 3px solid var(--in-ok); }
.mpc-banner.coord-blocked { border-left: 3px solid var(--in-warn); background: var(--in-warn-soft); }
.mpc-banner.coord-blocked .mpc-icon { color: var(--in-warn); }
.mpc-banner.coverage-unavailable { border-left: 3px solid var(--in-fg-dim); }

/* Layout matriz + panel lateral */
.mpc-layout { display: grid; grid-template-columns: minmax(0, 1fr) 360px; gap: 18px; }
@media (max-width: 1100px) { .mpc-layout { grid-template-columns: 1fr; } }

/* Card */
.mpc-card { background: var(--in-bg-2); border: 1px solid var(--in-border); border-radius: var(--in-radius-sm); padding: 16px 18px; }
.mpc-card-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; gap: 12px; }
.mpc-card-title { font-size: 14px; font-weight: 600; display: inline-flex; align-items: center; gap: 8px; }
.mpc-card-sub { color: var(--in-fg-dim); font-size: 12px; }

/* Botón Ejecutar harness */
.mpc-run-btn { background: var(--in-accent); color: #0d1117; border: none; padding: 9px 14px; font-size: 12px; font-weight: 600; border-radius: 6px; cursor: pointer; display: inline-flex; align-items: center; gap: 8px; }
.mpc-run-btn:hover:not(:disabled) { filter: brightness(1.08); }
.mpc-run-btn:disabled { background: var(--in-bg-3); color: var(--in-fg-soft); cursor: not-allowed; opacity: 0.85; }
.mpc-run-btn .mpc-icon { width: 14px; height: 14px; }
.mpc-run-progress { display: inline-flex; align-items: center; gap: 8px; font-size: 12px; color: var(--in-fg-dim); }

/* Matriz: <table> con CSS grid (DOM accesible) */
.mpc-matrix { width: 100%; border-collapse: separate; border-spacing: 0; font-size: 11.5px; }
.mpc-matrix thead th { padding: 8px 6px; text-align: center; font-weight: 500; color: var(--in-fg-dim); font-size: 11px; border-bottom: 1px solid var(--in-border); text-transform: uppercase; letter-spacing: 0.04em; }
.mpc-matrix tbody th { padding: 8px 12px; text-align: left; font-weight: 500; color: var(--in-fg); border-right: 1px solid var(--in-border); font-size: 12px; }
.mpc-matrix tbody td { padding: 4px; vertical-align: middle; }
.mpc-matrix .mpc-cell { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 4px; padding: 8px 6px; border-radius: 6px; min-height: 56px; border: 1px solid transparent; outline: none; cursor: help; }
.mpc-matrix .mpc-cell:focus-visible { outline: 2px solid var(--in-accent); outline-offset: 2px; }
.mpc-matrix .mpc-cell .mpc-icon { width: 18px; height: 18px; }
.mpc-cell-label { font-size: 10.5px; font-weight: 600; letter-spacing: 0.04em; }
.mpc-cell-meta { font-size: 9.5px; color: var(--in-fg-dim); text-align: center; }

.mpc-cell.pass { color: var(--in-ok); background: var(--in-ok-soft); border-color: rgba(63,185,80,0.25); }
.mpc-cell.warn { color: var(--in-warn); background: var(--in-warn-soft); border-color: rgba(210,153,34,0.25); }
.mpc-cell.fail { color: var(--in-bad); background: var(--in-bad-soft); border-color: rgba(248,81,73,0.30); }
.mpc-cell.skipped { color: var(--in-fg-dim); background: rgba(139,148,158,0.08); border: 1px dashed rgba(139,148,158,0.30); }
.mpc-cell.na { color: var(--in-fg-soft); background: repeating-linear-gradient(45deg, rgba(110,118,129,0.05) 0 6px, rgba(110,118,129,0.12) 6px 12px); border-color: rgba(110,118,129,0.15); cursor: default; }
.mpc-cell .mpc-cell-issue-link { color: inherit; text-decoration: none; font-size: 10px; opacity: 0.75; display: inline-flex; align-items: center; gap: 2px; }
.mpc-cell .mpc-cell-issue-link:focus-visible { outline: 2px solid var(--in-accent); }

/* Leyenda (siempre visible) */
.mpc-legend { display: grid; grid-template-columns: repeat(auto-fill, minmax(130px, 1fr)); gap: 8px 12px; margin-top: 14px; padding-top: 14px; border-top: 1px solid var(--in-border); }
.mpc-legend-item { display: inline-flex; align-items: center; gap: 6px; font-size: 11.5px; color: var(--in-fg-dim); }
.mpc-legend-item .mpc-icon { width: 14px; height: 14px; flex: 0 0 auto; }
.mpc-legend-item.pass { color: var(--in-ok); }
.mpc-legend-item.warn { color: var(--in-warn); }
.mpc-legend-item.fail { color: var(--in-bad); }
.mpc-legend-item.skipped { color: var(--in-fg-dim); }
.mpc-legend-item.na { color: var(--in-fg-soft); }
.mpc-legend-bucket { display: inline-flex; align-items: center; gap: 4px; font-family: var(--in-mono); font-size: 11px; padding: 1px 7px; border-radius: 3px; background: var(--in-bg); border: 1px solid var(--in-border); color: var(--in-fg-dim); }
.mpc-legend-section-title { grid-column: 1 / -1; color: var(--in-fg-soft); font-size: 10px; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 2px; }

/* Panel lateral de issues auto-creados */
.mpc-issues-list { display: flex; flex-direction: column; gap: 8px; max-height: 720px; overflow-y: auto; }
.mpc-issue-row { display: grid; grid-template-columns: auto 1fr auto; gap: 8px; padding: 9px 10px; background: var(--in-bg-3); border-left: 3px solid var(--in-bad); border-radius: 4px; font-size: 11.5px; align-items: center; }
.mpc-issue-row .mpc-icon { width: 14px; height: 14px; color: var(--in-bad); }
.mpc-issue-row-head { font-weight: 600; font-size: 12px; }
.mpc-issue-row-meta { color: var(--in-fg-dim); font-size: 10.5px; margin-top: 2px; display: flex; gap: 8px; flex-wrap: wrap; }
.mpc-issue-row-meta .mpc-tag { background: var(--in-bg); border: 1px solid var(--in-border); padding: 0 6px; border-radius: 3px; font-family: var(--in-mono); }
.mpc-issue-link { color: var(--in-fg-dim); text-decoration: none; display: inline-flex; align-items: center; gap: 4px; font-size: 11px; }
.mpc-issue-link:hover { color: var(--in-accent); }
.mpc-issue-link:focus-visible { outline: 2px solid var(--in-accent); outline-offset: 2px; }
.mpc-issues-empty { color: var(--in-fg-dim); font-size: 12px; text-align: center; padding: 18px 0; }

/* Tooltip popover custom (NO title nativo) */
.mpc-popover { position: fixed; z-index: 999; background: var(--in-bg-2); border: 1px solid var(--in-border); border-radius: 6px; padding: 10px 12px; box-shadow: var(--in-shadow); font-size: 11.5px; max-width: 320px; pointer-events: none; opacity: 0; transition: opacity 0.12s; }
.mpc-popover.visible { opacity: 1; }
.mpc-popover-row { display: flex; gap: 8px; margin-bottom: 4px; }
.mpc-popover-row:last-child { margin-bottom: 0; }
.mpc-popover-key { color: var(--in-fg-dim); flex: 0 0 90px; }
.mpc-popover-val { color: var(--in-fg); font-family: var(--in-mono); word-break: break-all; }
.mpc-popover-val.danger { color: var(--in-bad); }
.mpc-popover-val.warn { color: var(--in-warn); }
.mpc-popover-val.ok { color: var(--in-ok); }

/* Coverage unavailable */
.mpc-empty { text-align: center; padding: 40px 24px; color: var(--in-fg-dim); }
.mpc-empty-title { font-size: 14px; font-weight: 600; color: var(--in-fg); margin-bottom: 4px; }
.mpc-empty-sub { font-size: 12px; margin-bottom: 16px; }

/* Toast simple */
.mpc-toast { position: fixed; bottom: 20px; right: 20px; z-index: 1000; padding: 10px 14px; border-radius: 6px; background: var(--in-bg-3); border: 1px solid var(--in-border); font-size: 12px; color: var(--in-fg); box-shadow: var(--in-shadow); display: none; }
.mpc-toast.ok { border-color: var(--in-ok); }
.mpc-toast.err { border-color: var(--in-bad); }
.mpc-toast.visible { display: block; }
`;

// -----------------------------------------------------------------------------
// Body HTML estático. IDs estables; los nodos dinámicos se mutan por id.
// -----------------------------------------------------------------------------
function bodyHtml() {
    return `
<div class="mpc-frame">
  <header class="in-header">
    <div class="in-header-brand">
      <div class="in-header-logo">i</div>
      <div>
        <div class="in-header-title">Multi-Provider Coverage</div>
        <div class="in-header-subtitle">Matriz skill × provider del smoke test</div>
      </div>
    </div>
    <div class="in-header-meta">
      <span class="in-clock" id="mpc-hdr-clock"></span>
    </div>
  </header>
  ${renderNavTabsSsr('providers')}

  <main class="mpc-body">
    <!-- Banner último run -->
    <section class="mpc-banner" id="mpc-banner-run" aria-live="polite">
      <svg class="mpc-icon" role="img" aria-label="Información"><use href="#ic-info"/></svg>
      <div>
        <div class="mpc-banner-title" id="mpc-banner-run-title">Cargando último run…</div>
        <div class="mpc-banner-sub" id="mpc-banner-run-sub"></div>
      </div>
    </section>

    <!-- Banner coordinación -->
    <section class="mpc-banner coord-blocked" id="mpc-banner-coord" aria-live="polite">
      <svg class="mpc-icon" role="img" aria-label="Coordinación"><use href="#ic-pause-lock"/></svg>
      <div style="flex:1">
        <div class="mpc-banner-title" id="mpc-banner-coord-title">Verificando coordinación…</div>
        <div class="mpc-banner-sub" id="mpc-banner-coord-sub"></div>
      </div>
      <button class="mpc-run-btn" id="mpc-run-btn" disabled aria-describedby="mpc-banner-coord-sub">
        <svg class="mpc-icon" role="img" aria-label="Ejecutar"><use href="#ic-play"/></svg>
        <span id="mpc-run-btn-label">Ejecutar harness</span>
      </button>
    </section>

    <!-- Layout matriz + panel issues -->
    <div class="mpc-layout">
      <section class="mpc-card">
        <div class="mpc-card-head">
          <div class="mpc-card-title">Matriz skill × provider</div>
          <div class="mpc-card-sub" id="mpc-matrix-sub"></div>
        </div>
        <div id="mpc-matrix-wrap">
          <div class="mpc-empty" id="mpc-empty">
            <div class="mpc-empty-title">Aún no hay datos del harness</div>
            <div class="mpc-empty-sub">Esperando el primer run. Coordinación necesaria para disparar.</div>
          </div>
          <table class="mpc-matrix" role="grid" aria-label="Cobertura skill por provider" id="mpc-matrix" hidden>
            <thead><tr id="mpc-matrix-head"></tr></thead>
            <tbody id="mpc-matrix-body"></tbody>
          </table>
          <div class="mpc-legend" id="mpc-legend"></div>
        </div>
      </section>

      <aside class="mpc-card">
        <div class="mpc-card-head">
          <div class="mpc-card-title">Issues auto-creados</div>
          <div class="mpc-card-sub" id="mpc-issues-count"></div>
        </div>
        <div class="mpc-issues-list" id="mpc-issues-list">
          <div class="mpc-issues-empty" id="mpc-issues-empty">Sin FAILs en el último run.</div>
        </div>
      </aside>
    </div>
  </main>

  <footer class="in-footer">
    <span>Solo lectura — el harness se dispara con el botón superior</span>
    <span>Intrale V3 · #3681 · split de #3669</span>
  </footer>
</div>

<div class="mpc-popover" id="mpc-popover" role="tooltip" aria-hidden="true"></div>
<div class="mpc-toast" id="mpc-toast" role="status" aria-live="polite"></div>
`;
}

// -----------------------------------------------------------------------------
// Client-side JS. CERO innerHTML salvo en el shell estático. Defensa
// REQ-SEC-B4: todos los campos del JSON renderizados con textContent.
// -----------------------------------------------------------------------------
const CLIENT_JS = `
'use strict';
(function() {
  // ===== Estado en JS, no en DOM markup (REQ-SEC-B9) =====
  var mpcState = {
    coverage: null,      // payload del último GET o envelope error
    coord: null,         // estado de coordinación (heurístico del payload)
    cellsByKey: {},      // {'skill|provider': td DOM node}
    popoverState: null,  // {visible, cell, html} — NUNCA leído del DOM
    running: false,
  };

  // ===== Helpers =====
  function $(id) { return document.getElementById(id); }
  function clearChildren(node) { while (node.firstChild) node.removeChild(node.firstChild); }

  function svgIcon(symbolId, ariaLabel) {
    var ns = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('class', 'mpc-icon');
    svg.setAttribute('role', 'img');
    if (ariaLabel) svg.setAttribute('aria-label', ariaLabel);
    else svg.setAttribute('aria-hidden', 'true');
    var use = document.createElementNS(ns, 'use');
    // textContent del setAttribute es seguro (no parsea HTML).
    use.setAttribute('href', '#' + symbolId);
    svg.appendChild(use);
    return svg;
  }

  function toast(msg, kind) {
    var el = $('mpc-toast');
    if (!el) return;
    el.textContent = msg;
    el.className = 'mpc-toast visible ' + (kind || '');
    setTimeout(function() { el.className = 'mpc-toast ' + (kind || ''); }, 3000);
  }

  function formatRelative(iso) {
    if (!iso) return '—';
    try {
      var t = new Date(iso).getTime();
      if (!isFinite(t)) return '—';
      var deltaMs = Date.now() - t;
      var s = Math.floor(deltaMs / 1000);
      if (s < 60) return s + 's atrás';
      var m = Math.floor(s / 60);
      if (m < 60) return m + 'min atrás';
      var h = Math.floor(m / 60);
      if (h < 24) return h + 'h atrás';
      return Math.floor(h / 24) + 'd atrás';
    } catch (e) { return '—'; }
  }

  function formatDuration(ms) {
    if (ms === null || ms === undefined || !isFinite(ms)) return '—';
    if (ms < 1000) return ms + 'ms';
    if (ms < 60000) return (ms / 1000).toFixed(1) + 's';
    return Math.floor(ms / 60000) + 'm ' + Math.floor((ms % 60000) / 1000) + 's';
  }

  // ===== Inferencia del estado de coordinación a partir del payload =====
  // El payload "happy" no trae estado de coordinación per se; necesitamos
  // un endpoint adicional o derivarlo. Como aproximación, leemos
  // /api/dash/header (existente) que ya expone el modo del pipeline.
  function fetchCoordination() {
    return fetch('/api/dash/header', { headers: { 'Accept': 'application/json' } })
      .then(function(r) { return r.json(); })
      .then(function(j) {
        // header devuelve {mode, allowedIssues, allowedSkills, ...}
        var mode = j && j.mode;
        var allowedSkills = (j && j.allowedSkills) || [];
        // Habilitado si paused o si partial_pause con harness skill.
        var enabled = mode === 'paused' ||
          (mode === 'partial_pause' && allowedSkills.indexOf('multi-provider-smoke-test') >= 0);
        return { mode: mode || 'unknown', enabled: enabled, allowedSkills: allowedSkills };
      })
      .catch(function() { return { mode: 'unknown', enabled: false, allowedSkills: [] }; });
  }

  // ===== Coverage =====
  function fetchCoverage() {
    return fetch('/api/dash/multi-provider-coverage', { headers: { 'Accept': 'application/json' } })
      .then(function(r) {
        // status 503 → envelope error; parseamos igual.
        return r.json().then(function(body) { return { status: r.status, body: body }; })
          .catch(function() { return { status: r.status, body: { error: 'coverage_unavailable', reason: 'parse_error' } }; });
      })
      .catch(function() { return { status: 0, body: { error: 'coverage_unavailable', reason: 'network_error' } }; });
  }

  // ===== Render del banner de coordinación =====
  function renderCoordBanner(coord) {
    var banner = $('mpc-banner-coord');
    var title = $('mpc-banner-coord-title');
    var sub = $('mpc-banner-coord-sub');
    var btn = $('mpc-run-btn');
    if (!banner || !title || !sub || !btn) return;
    if (coord.enabled) {
      banner.className = 'mpc-banner coord-ok';
      title.textContent = 'Coordinación habilitada';
      sub.textContent = 'Modo "' + coord.mode + '" — el harness puede correr.';
      btn.disabled = false;
      btn.setAttribute('aria-label', 'Ejecutar harness multi-provider smoke test');
    } else {
      banner.className = 'mpc-banner coord-blocked';
      title.textContent = 'Coordinación bloqueada';
      sub.textContent = 'Modo "' + coord.mode + '" sin ventana habilitada para multi-provider-smoke-test. ' +
        'Activá .pausa o agregá allowed_skills: ["multi-provider-smoke-test"] a .partial-pause.json.';
      btn.disabled = true;
      btn.setAttribute('aria-label',
        'Ejecutar harness deshabilitado: coordinación bloqueada por modo ' + coord.mode);
    }
  }

  // ===== Render del banner del último run =====
  function renderRunBanner(payload) {
    var title = $('mpc-banner-run-title');
    var sub = $('mpc-banner-run-sub');
    if (!title || !sub) return;
    if (!payload || payload.error) {
      title.textContent = 'Aún no hay run registrado';
      var reason = payload && payload.reason ? payload.reason : 'desconocida';
      sub.textContent = 'Coverage no disponible · ' + reason;
      return;
    }
    title.textContent = 'Último run · ' + (payload.run_id || 'sin id');
    var parts = [];
    if (payload.generated_at) parts.push(new Date(payload.generated_at).toLocaleString('es-AR') + ' (' + formatRelative(payload.generated_at) + ')');
    if (payload.duration_ms !== null && payload.duration_ms !== undefined) parts.push('Duración: ' + formatDuration(payload.duration_ms));
    parts.push('Spawns: ' + (payload.spawns_used || 0) + '/' + (payload.spawns_cap || 60));
    parts.push('Modo: serializado');
    sub.textContent = parts.join(' · ');
  }

  // ===== Render de la matriz =====
  function renderMatrix(payload) {
    var table = $('mpc-matrix');
    var head = $('mpc-matrix-head');
    var body = $('mpc-matrix-body');
    var legend = $('mpc-legend');
    var empty = $('mpc-empty');
    var sub = $('mpc-matrix-sub');
    if (!table || !head || !body || !legend || !empty) return;

    if (!payload || payload.error || !Array.isArray(payload.matrix) || payload.matrix.length === 0) {
      table.hidden = true;
      legend.hidden = true;
      empty.style.display = 'block';
      sub.textContent = '';
      mpcState.cellsByKey = {};
      return;
    }
    empty.style.display = 'none';
    table.hidden = false;
    legend.hidden = false;

    // Derivar ejes
    var skillsSet = {};
    var providersSet = {};
    payload.matrix.forEach(function(c) {
      skillsSet[c.skill] = true;
      providersSet[c.provider] = true;
    });
    var skills = Object.keys(skillsSet).sort();
    var providers = Object.keys(providersSet).sort();

    sub.textContent = skills.length + ' skills × ' + providers.length + ' providers · ' +
      (payload.summary ? payload.summary.total_combinations : payload.matrix.length) + ' celdas';

    // Header
    clearChildren(head);
    var corner = document.createElement('th');
    corner.textContent = 'Skill \\\\ Provider';
    corner.setAttribute('scope', 'col');
    head.appendChild(corner);
    providers.forEach(function(p) {
      var th = document.createElement('th');
      th.textContent = p;
      th.setAttribute('scope', 'col');
      head.appendChild(th);
    });

    // Body — DOM morphing: reusamos td existente por key si el render es repetido.
    var newCells = {};
    var existingRows = {};
    Array.from(body.children).forEach(function(tr) {
      var key = tr.getAttribute('data-skill');
      if (key) existingRows[key] = tr;
    });

    // Build new structure
    var fragment = document.createDocumentFragment();
    skills.forEach(function(skill) {
      var tr = existingRows[skill] || document.createElement('tr');
      tr.setAttribute('data-skill', skill);
      clearChildren(tr);

      var rowHead = document.createElement('th');
      rowHead.setAttribute('scope', 'row');
      rowHead.textContent = skill;
      tr.appendChild(rowHead);

      providers.forEach(function(provider) {
        var key = skill + '|' + provider;
        var cellData = payload.matrix.find(function(c) { return c.skill === skill && c.provider === provider; });
        var td = document.createElement('td');
        td.setAttribute('data-skill', skill);
        td.setAttribute('data-provider', provider);
        td.appendChild(buildCellNode(cellData, skill, provider));
        newCells[key] = td;
        tr.appendChild(td);
      });

      fragment.appendChild(tr);
    });

    clearChildren(body);
    body.appendChild(fragment);
    mpcState.cellsByKey = newCells;

    renderLegend();
  }

  function statusToClass(status) {
    if (status === 'PASS') return 'pass';
    if (status === 'WARN') return 'warn';
    if (status === 'FAIL') return 'fail';
    if (status === 'SKIPPED') return 'skipped';
    return 'na';
  }
  function statusToIcon(status) {
    if (status === 'PASS') return 'ic-cell-pass';
    if (status === 'WARN') return 'ic-cell-warn';
    if (status === 'FAIL') return 'ic-cell-fail';
    if (status === 'SKIPPED') return 'ic-cell-skipped';
    return 'ic-cell-na';
  }
  function statusToWord(status) {
    if (status === 'PASS') return 'PASS';
    if (status === 'WARN') return 'WARN';
    if (status === 'FAIL') return 'FAIL';
    if (status === 'SKIPPED') return 'SKIPPED';
    return 'N/A';
  }
  function ariaForCell(cell, skill, provider) {
    if (!cell) return 'celda ' + skill + ' × ' + provider + ': sin datos';
    var parts = ['celda ' + skill + ' × ' + provider + ': ' + statusToWord(cell.status)];
    if (cell.error_class) parts.push(cell.error_class);
    if (cell.latency_bucket) parts.push('latencia ' + cell.latency_bucket);
    if (cell.reason) parts.push(cell.reason);
    if (cell.issue) parts.push('ver issue ' + cell.issue);
    return parts.join(', ');
  }

  // Construye el nodo de celda. CERO innerHTML — todo textContent / createElement.
  function buildCellNode(cell, skill, provider) {
    var wrap = document.createElement('div');
    var status = cell ? cell.status : 'N/A';
    wrap.className = 'mpc-cell ' + statusToClass(status);
    wrap.setAttribute('tabindex', '0');
    wrap.setAttribute('role', 'gridcell');
    wrap.setAttribute('aria-label', ariaForCell(cell, skill, provider));

    var glyph = svgIcon(statusToIcon(status), null);
    wrap.appendChild(glyph);

    var label = document.createElement('span');
    label.className = 'mpc-cell-label';
    label.textContent = statusToWord(status);
    wrap.appendChild(label);

    var meta = document.createElement('span');
    meta.className = 'mpc-cell-meta';
    if (cell && cell.latency_bucket) {
      meta.textContent = cell.latency_bucket;
    } else if (cell && cell.error_class) {
      meta.textContent = cell.error_class;
    } else if (cell && cell.reason) {
      meta.textContent = cell.reason.slice(0, 30);
    } else {
      meta.textContent = '—';
    }
    wrap.appendChild(meta);

    // Atadura del popover (NO title nativo, NO innerHTML — todo state JS)
    wrap.addEventListener('mouseenter', function(e) { showPopover(cell, skill, provider, e.currentTarget); });
    wrap.addEventListener('mouseleave', function() { hidePopover(); });
    wrap.addEventListener('focus', function(e) { showPopover(cell, skill, provider, e.currentTarget); });
    wrap.addEventListener('blur', function() { hidePopover(); });
    return wrap;
  }

  // ===== Popover: render desde JS state, NO leer del DOM (REQ-SEC-B9) =====
  function showPopover(cell, skill, provider, anchor) {
    var pop = $('mpc-popover');
    if (!pop) return;
    clearChildren(pop);

    var addRow = function(key, val, klass) {
      var row = document.createElement('div');
      row.className = 'mpc-popover-row';
      var k = document.createElement('span');
      k.className = 'mpc-popover-key';
      k.textContent = key;
      var v = document.createElement('span');
      v.className = 'mpc-popover-val' + (klass ? ' ' + klass : '');
      v.textContent = val == null || val === '' ? '—' : String(val);
      row.appendChild(k);
      row.appendChild(v);
      pop.appendChild(row);
    };

    addRow('skill × provider', skill + ' × ' + provider);
    var statusKlass = cell ? statusToClass(cell.status) : 'na';
    var statusLabel = cell ? statusToWord(cell.status) : 'N/A';
    addRow('estado', statusLabel, statusKlass === 'pass' ? 'ok' : statusKlass === 'fail' ? 'danger' : statusKlass === 'warn' ? 'warn' : '');
    if (cell && cell.latency_bucket) addRow('latencia', cell.latency_bucket);
    if (cell && cell.status === 'WARN' && cell.divergence) addRow('divergencia', cell.divergence);
    if (cell && cell.error_class) addRow('error_class', cell.error_class);
    if (cell && cell.model) addRow('model', cell.model);
    if (cell && cell.timestamp) addRow('timestamp', cell.timestamp);
    if (cell && cell.evidence_hash) addRow('evidence', cell.evidence_hash);
    if (cell && cell.issue) addRow('issue', '#' + Number(cell.issue));
    if (cell && cell.reason) addRow('motivo', cell.reason);

    // Posicionamiento
    var rect = anchor.getBoundingClientRect();
    var maxLeft = window.innerWidth - 340;
    pop.style.left = Math.min(maxLeft, rect.left + rect.width / 2 - 160) + 'px';
    pop.style.top = (rect.top - 8) + 'px';
    pop.style.transform = 'translateY(-100%)';
    pop.classList.add('visible');
    pop.setAttribute('aria-hidden', 'false');
    mpcState.popoverState = { visible: true, anchor: anchor };
  }

  function hidePopover() {
    var pop = $('mpc-popover');
    if (!pop) return;
    pop.classList.remove('visible');
    pop.setAttribute('aria-hidden', 'true');
    mpcState.popoverState = null;
  }

  // ===== Leyenda permanente (CA-B7) =====
  function renderLegend() {
    var legend = $('mpc-legend');
    if (!legend) return;
    clearChildren(legend);

    var states = [
      { id: 'pass', icon: 'ic-cell-pass', label: 'PASS', help: 'invocado y OK' },
      { id: 'warn', icon: 'ic-cell-warn', label: 'WARN', help: 'invocado, divergencia' },
      { id: 'fail', icon: 'ic-cell-fail', label: 'FAIL', help: 'invocado y falló' },
      { id: 'skipped', icon: 'ic-cell-skipped', label: 'SKIPPED', help: 'sin credencial' },
      { id: 'na', icon: 'ic-cell-na', label: 'N/A', help: 'no aplica por diseño' },
    ];
    var stateHead = document.createElement('div');
    stateHead.className = 'mpc-legend-section-title';
    stateHead.textContent = 'Estados';
    legend.appendChild(stateHead);
    states.forEach(function(s) {
      var item = document.createElement('span');
      item.className = 'mpc-legend-item ' + s.id;
      item.appendChild(svgIcon(s.icon, null));
      var t = document.createElement('span');
      t.textContent = s.label + ' · ' + s.help;
      item.appendChild(t);
      legend.appendChild(item);
    });

    var bucketHead = document.createElement('div');
    bucketHead.className = 'mpc-legend-section-title';
    bucketHead.textContent = 'Buckets de latencia';
    legend.appendChild(bucketHead);
    ['<=100ms', '<=500ms', '<=2s', '<=10s', '>10s'].forEach(function(b) {
      var item = document.createElement('span');
      item.className = 'mpc-legend-bucket';
      item.textContent = b;
      legend.appendChild(item);
    });
  }

  // ===== Panel lateral de issues auto-creados =====
  function renderIssues(payload) {
    var list = $('mpc-issues-list');
    var empty = $('mpc-issues-empty');
    var count = $('mpc-issues-count');
    if (!list || !empty || !count) return;
    var failed = (payload && Array.isArray(payload.matrix))
      ? payload.matrix.filter(function(c) { return c.status === 'FAIL' && c.issue; })
      : [];
    clearChildren(list);
    if (failed.length === 0) {
      list.appendChild(empty);
      empty.textContent = 'Sin FAILs en el último run.';
      count.textContent = '0';
      return;
    }
    count.textContent = String(failed.length);
    failed.forEach(function(c) {
      list.appendChild(buildIssueRow(c));
    });
  }

  // CA-B10.bis + REQ-SEC-B7: link construido con cast Number() explícito.
  function buildIssueRow(c) {
    var row = document.createElement('div');
    row.className = 'mpc-issue-row';
    var icon = svgIcon('ic-cell-fail', 'FAIL');
    row.appendChild(icon);
    var mid = document.createElement('div');
    var head = document.createElement('div');
    head.className = 'mpc-issue-row-head';
    head.textContent = c.skill + ' × ' + c.provider;
    mid.appendChild(head);
    var meta = document.createElement('div');
    meta.className = 'mpc-issue-row-meta';
    [c.error_class, c.latency_bucket, c.evidence_hash].forEach(function(t) {
      if (!t) return;
      var tag = document.createElement('span');
      tag.className = 'mpc-tag';
      tag.textContent = t;
      meta.appendChild(tag);
    });
    mid.appendChild(meta);
    row.appendChild(mid);
    var issueNum = Number(c.issue);
    if (Number.isInteger(issueNum) && issueNum > 0) {
      var a = document.createElement('a');
      a.className = 'mpc-issue-link';
      a.href = 'https://github.com/intrale/platform/issues/' + issueNum;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.setAttribute('aria-label', 'ver issue ' + issueNum + ' en GitHub');
      a.appendChild(svgIcon('ic-link-out', null));
      var span = document.createElement('span');
      span.textContent = '#' + issueNum;
      a.appendChild(span);
      row.appendChild(a);
    }
    return row;
  }

  // ===== Ejecutar harness =====
  function runHarness() {
    if (mpcState.running) return;
    if (!mpcState.coord || !mpcState.coord.enabled) {
      toast('Coordinación bloqueada — el harness no puede correr ahora.', 'err');
      return;
    }
    var btn = $('mpc-run-btn');
    var label = $('mpc-run-btn-label');
    mpcState.running = true;
    if (btn) btn.disabled = true;
    if (label) label.textContent = 'Lanzando…';
    fetch('/api/dash/multi-provider-coverage/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({})
    })
      .then(function(r) { return r.json().then(function(b) { return { status: r.status, body: b }; }); })
      .then(function(r) {
        if (r.status === 202 && r.body && r.body.ok) {
          if (label) label.textContent = 'Corriendo · ' + (r.body.runId || '');
          toast('Harness disparado: ' + (r.body.runId || ''), 'ok');
          // Poll cada 8s hasta ver cambios en run_id.
          var initialRun = mpcState.coverage && mpcState.coverage.run_id;
          var pollTimer = setInterval(function() {
            refresh().then(function() {
              if (mpcState.coverage && mpcState.coverage.run_id && mpcState.coverage.run_id !== initialRun) {
                clearInterval(pollTimer);
                mpcState.running = false;
                if (label) label.textContent = 'Ejecutar harness';
                toast('Run completado', 'ok');
              }
            });
          }, 8000);
          // safety: timeout 10min
          setTimeout(function() {
            clearInterval(pollTimer);
            if (mpcState.running) {
              mpcState.running = false;
              if (label) label.textContent = 'Ejecutar harness';
            }
          }, 600000);
        } else {
          mpcState.running = false;
          if (label) label.textContent = 'Ejecutar harness';
          var reason = r.body && (r.body.error || r.body.reason) || 'desconocido';
          toast('Rechazado: ' + reason, 'err');
        }
      })
      .catch(function(e) {
        mpcState.running = false;
        if (label) label.textContent = 'Ejecutar harness';
        toast('Error de red: ' + (e && e.message ? e.message : 'unknown'), 'err');
      });
  }

  // ===== Refresh (DOM morphing — el shell estático no se redibuja) =====
  function refresh() {
    return Promise.all([fetchCoordination(), fetchCoverage()])
      .then(function(arr) {
        mpcState.coord = arr[0];
        mpcState.coverage = arr[1].body;
        renderCoordBanner(arr[0]);
        if (arr[1].body && arr[1].body.error) {
          renderRunBanner(arr[1].body);
          renderMatrix(arr[1].body);
          renderIssues(arr[1].body);
        } else {
          renderRunBanner(arr[1].body);
          renderMatrix(arr[1].body);
          renderIssues(arr[1].body);
        }
      });
  }

  function tickClock() {
    var el = $('mpc-hdr-clock');
    if (el) el.textContent = new Date().toLocaleTimeString('es-AR');
  }

  // ===== Boot =====
  document.addEventListener('DOMContentLoaded', function() {
    var btn = $('mpc-run-btn');
    if (btn) btn.addEventListener('click', runHarness);
    tickClock();
    setInterval(tickClock, 1000);
    refresh().catch(function() {});
    setInterval(function() { refresh().catch(function() {}); }, 30000);
  });
})();
`;

// -----------------------------------------------------------------------------
// Render del HTML completo. Inyecta sprite inline (los `<use href="#x"/>`
// resuelven contra los `<symbol>` del DOM actual; el sprite vive en el mismo
// documento para evitar CORS/cache de archivo externo).
// -----------------------------------------------------------------------------
function renderMultiProviderCoverage() {
    const theme = loadTheme();
    const sprite = loadSprite();
    return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Intrale · Multi-Provider Coverage</title>
<style>${theme}</style>
<style>${PANEL_CSS}</style>
</head>
<body>
<!-- Sprite SVG (oculto, solo provee símbolos para <use href="#ic-*"/>) -->
<div aria-hidden="true" style="position:absolute;width:0;height:0;overflow:hidden">${sprite}</div>
${bodyHtml()}
<script>${CLIENT_JS}</script>
</body>
</html>`;
}

module.exports = {
    renderMultiProviderCoverage,
    bodyHtml,
    PANEL_CSS,
    CLIENT_JS,
    // Exports para tests
    _internal: {
        SPRITE_PATH,
        THEME_CSS_PATH,
    },
};
