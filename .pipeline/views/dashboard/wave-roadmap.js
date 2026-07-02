// =============================================================================
// wave-roadmap.js — Vista SSR del panel de gestión del roadmap de olas del
// dashboard V3 (`/dashboard?view=roadmap`).
//
// Issue: #4378 (split C de #4351 — Ola 8.3). Consola de lectura del roadmap
// completo (activa / planificadas / archivadas) + acción destructiva "Archivar"
// sobre la ola activa/planificada. La sincronización de allowlist al promover
// (CA-6) está diferida a #4350: esta vista NO ofrece promover.
//
// Assets UX consumidos (mockup 39-wave-roadmap-management.svg + narrativa):
//   - Sistema de tokens `design-tokens.css` (cero hex hardcoded): superficies
//     `--surface-*`, acento de olas `--purple`/`--purple-dim`, archivadas sobre
//     `--text-dim` colapsadas por defecto.
//   - Iconografía vía sprite (`<use href="#ic-...">`): ic-wave, ic-archive-box,
//     ic-expand, ic-shield-lock. NUNCA SVG inline interpolado con datos (XSS).
//
// Seguridad (CA-7 / CA-8, BLOQUEANTE):
//   - CA-8: TODO dato dinámico de waves.json (name, goal, note, y títulos de
//     issues) pasa por escapeHtmlText / escapeHtmlAttr de lib/escape-html.js,
//     aplicado INTERNAMENTE en el render (nunca delegado al call-site). El
//     número de ola/issue se coacciona a entero positivo (safeWaveNumber /
//     safeIssueNumber) antes de interpolarse en href/onclick/aria-label.
//   - CA-7: la acción "Archivar" hace POST a `/dashboard/wave/archive` que
//     hereda el cinturón de gates de dashboard-routes.js (loopback +
//     same-origin + Content-Type + cap). Cero escritura directa a waves.json.
// =============================================================================
'use strict';

const fs = require('fs');
const path = require('path');

const { renderNavTabsSsr, loadIconSprite } = require('./nav-tabs');
const { FETCH_CLIENT_JS } = require('./fetch-client.js');
const { CONFIRM_MODAL_JS } = require('./confirm-modal.js');

// #3722 — Escape HTML server-side unificado (CA-8). Fallback inline
// (defense-in-depth) por si el require fallara en un checkout transitorio.
let escapeHtmlText, escapeHtmlAttr;
try {
    ({ escapeHtmlText, escapeHtmlAttr } = require('../../lib/escape-html.js'));
} catch {
    escapeHtmlText = (s) => (s == null ? '' : String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])));
    escapeHtmlAttr = (s) => (s == null ? '' : String(s).replace(/[&<>"'`]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' }[c])));
}

const slug = 'roadmap';

const THEME_CSS_PATH = path.join(__dirname, 'theme.css');
const TOKENS_CSS_PATH = path.join(__dirname, '..', '..', 'assets', 'design-tokens.css');
function loadTheme() {
    try { return fs.readFileSync(THEME_CSS_PATH, 'utf8'); } catch { return ''; }
}
function loadDesignTokens() {
    try { return fs.readFileSync(TOKENS_CSS_PATH, 'utf8'); } catch { return ''; }
}

// CA-7/CA-8 — coerción numérica estricta antes de interpolar en
// href/onclick/aria-label. Origen filesystem-controlled (bajo riesgo) pero la
// defensa en profundidad lo exige. Devuelve el entero positivo o null.
function safeWaveNumber(raw) {
    const n = Number(raw);
    return (Number.isInteger(n) && n > 0) ? n : null;
}
function safeIssueNumber(raw) {
    const n = Number(raw);
    return (Number.isInteger(n) && n > 0) ? n : null;
}

// Lee el estado de olas de forma defensiva. Inyectable para tests (opts.wavesState).
// NUNCA propaga excepciones al render: degrada a estado vacío.
function readWavesState(opts) {
    if (opts && opts.wavesState && typeof opts.wavesState === 'object') return opts.wavesState;
    try {
        const waves = require('../../lib/waves');
        return waves.loadWaves();
    } catch {
        return { active_wave: null, planned_waves: [], archived_waves: [] };
    }
}

// Normaliza el array de issues de una ola a `{ number, status, title }`,
// descartando entradas sin número válido. `title` puede venir presente en
// entradas enriquecidas (cache de títulos) — se conserva para escaparlo al
// render (superficie XSS de vida larga, CA-8).
function normalizeIssues(rawIssues) {
    const out = [];
    (Array.isArray(rawIssues) ? rawIssues : []).forEach((it) => {
        let num, status, title;
        if (it && typeof it === 'object') {
            num = safeIssueNumber(it.number != null ? it.number : it.id);
            status = it.status != null ? String(it.status) : '';
            title = it.title != null ? String(it.title) : '';
        } else {
            num = safeIssueNumber(it);
            status = ''; title = '';
        }
        if (num !== null) out.push({ number: num, status, title });
    });
    return out;
}

// Chip de un issue. `title` (si existe) se escapa en atributo y texto. El estado
// se muestra como texto + clase (nunca color-only) — WCAG 1.4.1.
function renderIssueChip(issue) {
    const num = issue.number; // ya coaccionado
    const titleTxt = issue.title || '';
    const statusTxt = issue.status || '';
    const titleAttr = titleTxt
        ? escapeHtmlAttr(`#${num} — ${titleTxt}`)
        : escapeHtmlAttr(`Issue #${num}`);
    const label = titleTxt
        ? `#${num} · ${escapeHtmlText(titleTxt)}`
        : `#${num}`;
    const statusHtml = statusTxt
        ? `<span class="wr-chip-status" data-status="${escapeHtmlAttr(statusTxt)}">${escapeHtmlText(statusTxt)}</span>`
        : '';
    return `<a class="wr-chip" href="https://github.com/intrale/platform/issues/${num}" target="_blank" rel="noopener noreferrer" title="${titleAttr}">`
        + `<span class="wr-chip-num">${label}</span>${statusHtml}</a>`;
}

function renderIssueList(issues) {
    if (!issues.length) {
        return '<div class="wr-empty-issues">Sin issues asociados.</div>';
    }
    return '<div class="wr-chips">' + issues.map(renderIssueChip).join('') + '</div>';
}

// Card de la ola ACTIVA (acento --purple, barra lateral de identidad). Incluye
// la acción "Archivar" (destructiva, POST bajo gate). Todo dato escapado.
function renderActiveCard(active) {
    if (!active) {
        return '<div class="wr-empty-state" role="status">'
            + '<svg class="wr-empty-ic" aria-hidden="true"><use href="#ic-wave"></use></svg>'
            + '<div class="wr-empty-title">Sin ola activa</div>'
            + '<div class="wr-empty-sub">No hay ninguna ola en curso. Promové una planificada para arrancar.</div>'
            + '</div>';
    }
    const num = safeWaveNumber(active.number);
    const nameTxt = active.name != null && active.name !== '' ? String(active.name) : (num !== null ? `Ola ${num}` : 'Ola');
    const goalTxt = active.goal != null ? String(active.goal) : '';
    const issues = normalizeIssues(active.issues);
    const archiveBtn = num !== null
        ? `<button type="button" class="wr-btn wr-btn-archive" onclick="roadmapArchive(${num}, 'activa')" title="${escapeHtmlAttr('Archivar la ola ' + num + ' (activa) a archived_waves')}" aria-label="${escapeHtmlAttr('Archivar la ola activa ' + num)}">`
            + '<svg class="wr-btn-ic" aria-hidden="true"><use href="#ic-archive-box"></use></svg> Archivar</button>'
        : '';
    return `<article class="wr-card wr-card-active" data-wave="${num !== null ? num : ''}">
      <span class="wr-rail" aria-hidden="true"></span>
      <header class="wr-card-head">
        <div class="wr-card-id">
          <svg class="wr-card-ic" aria-hidden="true"><use href="#ic-wave"></use></svg>
          <span class="wr-card-title">${escapeHtmlText(nameTxt)}</span>
          ${num !== null ? `<span class="wr-card-num">Ola ${num}</span>` : ''}
        </div>
        <div class="wr-card-actions">${archiveBtn}</div>
      </header>
      ${goalTxt ? `<div class="wr-card-goal">${escapeHtmlText(goalTxt)}</div>` : ''}
      ${renderIssueList(issues)}
    </article>`;
}

// Card de una ola PLANIFICADA (acento --purple-dim). El número de posición es
// orden de procesamiento (NO la identidad de la ola). Incluye "Archivar".
function renderPlannedCard(wave, position) {
    const num = safeWaveNumber(wave.number);
    const nameTxt = wave.name != null && wave.name !== '' ? String(wave.name) : (num !== null ? `Ola ${num}` : 'Ola');
    const goalTxt = wave.goal != null ? String(wave.goal) : '';
    const issues = normalizeIssues(wave.issues);
    const archiveBtn = num !== null
        ? `<button type="button" class="wr-btn wr-btn-archive" onclick="roadmapArchive(${num}, 'planificada')" title="${escapeHtmlAttr('Archivar la ola planificada ' + num)}" aria-label="${escapeHtmlAttr('Archivar la ola planificada ' + num)}">`
            + '<svg class="wr-btn-ic" aria-hidden="true"><use href="#ic-archive-box"></use></svg> Archivar</button>'
        : '';
    return `<article class="wr-card wr-card-planned" data-wave="${num !== null ? num : ''}">
      <header class="wr-card-head">
        <div class="wr-card-id">
          <span class="wr-pos" aria-label="${escapeHtmlAttr('Posición ' + position + ' en orden de procesamiento')}">${escapeHtmlText(String(position))}</span>
          <span class="wr-card-title">${escapeHtmlText(nameTxt)}</span>
          ${num !== null ? `<span class="wr-card-num">Ola ${num}</span>` : ''}
        </div>
        <div class="wr-card-actions">${archiveBtn}</div>
      </header>
      ${goalTxt ? `<div class="wr-card-goal">${escapeHtmlText(goalTxt)}</div>` : ''}
      ${renderIssueList(issues)}
    </article>`;
}

// Card de una ola ARCHIVADA (acento --text-dim, sobria). Muestra los issues
// conservados (CA-5) + métricas de cierre si están presentes.
function renderArchivedCard(wave) {
    const num = safeWaveNumber(wave.number);
    const nameTxt = wave.name != null && wave.name !== '' ? String(wave.name) : (num !== null ? `Ola ${num}` : 'Ola');
    const issues = normalizeIssues(wave.issues);
    const completed = Number.isFinite(Number(wave.issues_completed)) ? Number(wave.issues_completed) : null;
    const failed = Number.isFinite(Number(wave.issues_failed)) ? Number(wave.issues_failed) : null;
    const metrics = [];
    if (completed !== null) metrics.push(`${completed} completados`);
    if (failed !== null) metrics.push(`${failed} fallidos`);
    const metricsHtml = metrics.length
        ? `<span class="wr-arch-metrics">${escapeHtmlText(metrics.join(' · '))}</span>`
        : '';
    return `<article class="wr-card wr-card-archived" data-wave="${num !== null ? num : ''}">
      <header class="wr-card-head">
        <div class="wr-card-id">
          <span class="wr-card-title">${escapeHtmlText(nameTxt)}</span>
          ${num !== null ? `<span class="wr-card-num">Ola ${num}</span>` : ''}
          ${metricsHtml}
        </div>
      </header>
      ${renderIssueList(issues)}
    </article>`;
}

// CSS del panel. Inline en el fragmento (funciona embebido y standalone). Cero
// hex hardcoded fuera de fallbacks de tokens (mismo contrato que las hermanas).
function roadmapStyle() {
    return `<style>
.wr-view{display:flex;flex-direction:column;gap:20px}
.wr-section{display:flex;flex-direction:column;gap:12px}
.wr-section-head{display:flex;align-items:center;gap:9px;padding-bottom:7px;border-bottom:1px solid var(--border-subtle,rgba(255,255,255,.08))}
.wr-section-ic{width:16px;height:16px;color:var(--purple,#BC8CFF)}
.wr-section-title{font-size:12.5px;font-weight:800;letter-spacing:.5px;text-transform:uppercase;color:var(--text-primary,#e6edf3)}
.wr-section-count{font-size:11px;font-weight:800;color:var(--purple,#BC8CFF);background:var(--purple-bg,rgba(188,140,255,.12));border:1px solid var(--purple-dim,#8957E5);border-radius:999px;padding:1px 9px;font-variant-numeric:tabular-nums}
.wr-card{position:relative;background:var(--surface-1,#11151E);border:1px solid var(--border,rgba(255,255,255,.1));border-radius:12px;padding:14px 16px;display:flex;flex-direction:column;gap:10px}
.wr-card-active{background:var(--surface-2,#161b26);border-color:var(--purple-dim,#8957E5);padding-left:20px}
.wr-rail{position:absolute;left:0;top:0;bottom:0;width:4px;border-radius:12px 0 0 12px;background:var(--purple,#BC8CFF)}
.wr-card-planned{border-color:var(--border,rgba(255,255,255,.1))}
.wr-card-archived{background:var(--surface-0,#0d1117);border-color:var(--border-subtle,rgba(255,255,255,.06))}
.wr-card-archived .wr-card-title,.wr-card-archived .wr-card-num{color:var(--text-dim,#8B949E)}
.wr-card-head{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}
.wr-card-id{display:flex;align-items:center;gap:9px;flex-wrap:wrap;min-width:0}
.wr-card-ic{width:16px;height:16px;color:var(--purple,#BC8CFF)}
.wr-card-title{font-size:14px;font-weight:800;color:var(--text-primary,#e6edf3)}
.wr-card-num{font-size:11px;font-weight:700;color:var(--text-secondary,#8A93A6);background:var(--surface-3,#1c2230);border-radius:6px;padding:1px 7px}
.wr-pos{display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;border-radius:999px;font-size:11px;font-weight:800;color:var(--purple-dim,#8957E5);border:1px solid var(--purple-dim,#8957E5);font-variant-numeric:tabular-nums}
.wr-card-goal{font-size:12.5px;color:var(--text-secondary,#8A93A6);line-height:1.45}
.wr-arch-metrics{font-size:11px;color:var(--text-dim,#8B949E);font-variant-numeric:tabular-nums}
.wr-chips{display:flex;flex-wrap:wrap;gap:6px}
.wr-chip{display:inline-flex;align-items:center;gap:6px;font-size:11.5px;font-weight:700;text-decoration:none;padding:3px 9px;border-radius:7px;border:1px solid var(--border,rgba(255,255,255,.12));color:var(--text-secondary,#8A93A6);background:var(--surface-0,#0d1117);max-width:100%}
.wr-chip:hover{color:var(--text-primary,#e6edf3);border-color:var(--purple-dim,#8957E5)}
.wr-chip-num{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:280px}
.wr-chip-status{font-size:9.5px;font-weight:800;letter-spacing:.3px;text-transform:uppercase;color:var(--text-dim,#8B949E);border-left:1px solid var(--border,rgba(255,255,255,.12));padding-left:5px}
.wr-empty-issues{font-size:11.5px;color:var(--text-dim,#8B949E);font-style:italic}
.wr-btn{display:inline-flex;align-items:center;gap:6px;font-size:12px;font-weight:700;cursor:pointer;padding:6px 11px;border-radius:8px;border:1px solid var(--border,rgba(255,255,255,.12));background:transparent;color:var(--text-secondary,#8A93A6);white-space:nowrap}
.wr-btn-ic{width:14px;height:14px}
.wr-btn-archive:hover{color:var(--text-primary,#e6edf3);border-color:var(--purple,#BC8CFF)}
.wr-btn:disabled{opacity:.5;cursor:not-allowed}
.wr-empty-state{display:flex;flex-direction:column;align-items:center;gap:6px;padding:28px;text-align:center;border:1px dashed var(--border,rgba(255,255,255,.12));border-radius:12px;background:var(--surface-0,#0d1117)}
.wr-empty-ic{width:26px;height:26px;color:var(--text-dim,#8B949E)}
.wr-empty-title{font-size:14px;font-weight:800;color:var(--text-primary,#e6edf3)}
.wr-empty-sub{font-size:12px;color:var(--text-dim,#8B949E)}
.wr-archived-toggle{display:flex;align-items:center;gap:8px;cursor:pointer;background:none;border:none;padding:0;color:inherit;font:inherit}
.wr-archived-toggle .wr-expand-ic{width:14px;height:14px;color:var(--text-dim,#8B949E);transition:transform .15s}
.wr-archived-collapsed .wr-expand-ic{transform:rotate(-90deg)}
.wr-archived-body{display:flex;flex-direction:column;gap:12px}
.wr-archived-collapsed .wr-archived-body{display:none}
.wr-integrity{display:flex;align-items:center;gap:9px;font-size:11.5px;color:var(--text-dim,#8B949E);padding:10px 14px;border-radius:10px;border:1px solid var(--border-subtle,rgba(255,255,255,.08));background:var(--surface-0,#0d1117)}
.wr-integrity-ic{width:15px;height:15px;color:var(--teal,#34D9E0);flex-shrink:0}
@media (prefers-reduced-motion:reduce){.wr-archived-toggle .wr-expand-ic{transition:none}}
</style>`;
}

/**
 * Fragmento SSR de la ventana Roadmap. Devuelve `<main id="view-content"
 * data-slug="roadmap">` con las tres secciones renderizadas server-side.
 *
 * @param {object} [opts] — { wavesState } inyectable para tests; si falta se
 *                          lee de lib/waves.js (loadWaves).
 */
function renderRoadmapSsr(opts) {
    const state = readWavesState(opts);
    const active = state && state.active_wave ? state.active_wave : null;
    const planned = Array.isArray(state && state.planned_waves) ? state.planned_waves : [];
    const archived = Array.isArray(state && state.archived_waves) ? state.archived_waves : [];

    const activeHtml = renderActiveCard(active);

    const plannedHtml = planned.length
        ? planned.map((w, i) => renderPlannedCard(w, i + 1)).join('')
        : '<div class="wr-empty-issues">No hay olas planificadas.</div>';

    const archivedHtml = archived.length
        ? archived.map(renderArchivedCard).join('')
        : '<div class="wr-empty-issues">No hay olas archivadas.</div>';

    return '<main id="view-content" data-slug="roadmap" class="wr-view">'
        + roadmapStyle()
        // Sección ACTIVA.
        + '<section class="wr-section" aria-label="Ola activa">'
        + '<div class="wr-section-head"><svg class="wr-section-ic" aria-hidden="true"><use href="#ic-wave"></use></svg>'
        + '<span class="wr-section-title">Ola activa</span></div>'
        + activeHtml
        + '</section>'
        // Sección PLANIFICADAS.
        + '<section class="wr-section" aria-label="Olas planificadas">'
        + '<div class="wr-section-head"><svg class="wr-section-ic" aria-hidden="true"><use href="#ic-wave"></use></svg>'
        + '<span class="wr-section-title">Planificadas</span>'
        + `<span class="wr-section-count">${escapeHtmlText(String(planned.length))}</span></div>`
        + plannedHtml
        + '</section>'
        // Sección ARCHIVADAS — colapsada por defecto (guideline UX).
        + '<section class="wr-section wr-archived-collapsed" id="wr-archived" aria-label="Olas archivadas">'
        + '<div class="wr-section-head">'
        + '<button type="button" class="wr-archived-toggle" onclick="roadmapToggleArchived()" aria-expanded="false" aria-controls="wr-archived">'
        + '<svg class="wr-expand-ic" aria-hidden="true"><use href="#ic-expand"></use></svg>'
        + '<span class="wr-section-title">Archivadas</span>'
        + `<span class="wr-section-count">${escapeHtmlText(String(archived.length))}</span></button></div>`
        + `<div class="wr-archived-body">${archivedHtml}</div>`
        + '</section>'
        // Banda de integridad (CA-7) — recordatorio del patrón obligatorio.
        + '<div class="wr-integrity" role="note">'
        + '<svg class="wr-integrity-ic" aria-hidden="true"><use href="#ic-shield-lock"></use></svg>'
        + '<span>Toda operación mutante es transaccional y auditada: file-lock + escritura atómica + snapshot/recovery + audit. Cero escrituras directas a <code>waves.json</code>.</span>'
        + '</div>'
        + '</main>';
}

// Handlers del cliente. `roadmapArchive` hace POST a la ruta mutante (bajo gate
// loopback+same-origin) con confirmación previa. Sin reflejar input crudo.
function renderRoadmapClientScript() {
    return `
function roadmapToggleArchived(){
  var sec = document.getElementById('wr-archived');
  if(!sec) return;
  var collapsed = sec.classList.toggle('wr-archived-collapsed');
  var btn = sec.querySelector('.wr-archived-toggle');
  if(btn) btn.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
}
async function roadmapArchive(waveNum, kind){
  waveNum = parseInt(waveNum, 10);
  if(!Number.isInteger(waveNum) || waveNum < 1) return;
  var ok = await inConfirm({
    title: 'Archivar ola',
    message: 'La ola ' + waveNum + ' (' + kind + ') pasará a archivadas conservando sus issues. Sale del flujo operativo.',
    confirmLabel: 'Archivar',
    danger: true,
    preview: [{ label: 'Ola', value: '#' + waveNum }, { label: 'Origen', value: kind }]
  });
  if(!ok) return;
  var btns = document.querySelectorAll('.wr-card[data-wave="' + waveNum + '"] .wr-btn');
  btns.forEach(function(b){ b.disabled = true; });
  try {
    var r = await fetch('/dashboard/wave/archive', {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, nhCsrfHeaders()),
      body: JSON.stringify({ waveNumber: waveNum })
    });
    var j = await r.json().catch(function(){ return {}; });
    if(r.ok && j.ok){ location.reload(); return; }
    if(j && j.error === 'active_in_flight'){
      alert('La ola ' + waveNum + ' está activa con issues no cerrados. Archivá desde el CLI con --force si querés forzar.');
    } else if(j && j.error === 'archive_blocked'){
      alert('Archivar está bloqueado por una recovery fallida anterior. Revisá .pipeline/archived/.');
    } else {
      alert('No pude archivar la ola ' + waveNum + ' (' + (j && j.error ? j.error : ('HTTP ' + r.status)) + ').');
    }
    btns.forEach(function(b){ b.disabled = false; });
  } catch(e){
    alert('Error archivando la ola ' + waveNum + ': ' + e.message);
    btns.forEach(function(b){ b.disabled = false; });
  }
}
window.roadmapToggleArchived = roadmapToggleArchived;
window.roadmapArchive = roadmapArchive;
`;
}

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
 * Documento SSR completo de la ventana Roadmap (shell satélite + nav V3 +
 * fragmento + script). Replica el patrón de bloqueados.js / issues.js.
 *
 * @param {object} [opts] — { wavesState } inyectable para tests.
 */
function renderRoadmap(opts) {
    const theme = loadTheme();
    const tokens = loadDesignTokens();
    const spriteInline = loadIconSprite();
    const navHtml = renderNavTabsSsr(slug);
    const fragment = renderRoadmapSsr(opts);
    return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Intrale · Roadmap de olas</title>
<style>${theme}</style>
<style>${tokens}</style>
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
    <div class="in-header-title"><h1>Roadmap de olas</h1></div>
    <div class="in-header-meta">
      <span class="in-pill" id="hdr-mode">…</span>
      <span class="in-clock" id="hdr-clock">…</span>
    </div>
  </header>
  ${navHtml}
  <main class="satellite-body">${fragment}</main>
  <footer class="in-footer">
    <span>Refresh manual · acción Archivar bajo gate loopback+same-origin</span>
    <span>Intrale V3 · #4378</span>
  </footer>
</div>
<script>${FETCH_CLIENT_JS}\n${CONFIRM_MODAL_JS}\n${COMMON_HELPERS}\n${renderRoadmapClientScript()}</script>
</body>
</html>`;
}

module.exports = {
    slug,
    renderRoadmap,
    renderRoadmapSsr,
    renderRoadmapClientScript,
    renderActiveCard,
    renderPlannedCard,
    renderArchivedCard,
    renderIssueChip,
    normalizeIssues,
    safeWaveNumber,
    safeIssueNumber,
    loadTheme,
};
