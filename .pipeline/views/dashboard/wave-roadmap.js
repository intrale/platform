// =============================================================================
// wave-roadmap.js — Vista SSR del panel de gestión del roadmap de olas del
// dashboard V3 (`/dashboard?view=roadmap`).
//
// Issue: #4378 (split C de #4351 — Ola 8.3). Consola de lectura del roadmap
// completo (activa / planificadas / archivadas) + acción destructiva "Archivar"
// sobre la ola activa/planificada. La sincronización de allowlist al promover
// (CA-6) está diferida a #4350: esta vista NO ofrece promover.
//
// #4373 (Ola 8.3) — Vista operativa CONSOLIDADA. Sobre la base de #4378, cuando
// el caller pasa `opts.roadmap` (payload de `roadmapSlice` en dashboard-slices),
// la vista enriquece la ola activa con: prioridad por issue (CA-5, badge
// icono+texto), avance cerrados/total · % (CA-6), ETA p50/p75/p90 con aviso
// honesto de "poca muestra" (CA-8) y panel de bloqueos con motivo (CA-7). Sin
// `opts.roadmap` degrada al render read-only de #4378 (loadWaves). El endpoint
// `/api/dash/roadmap` sirve el mismo slice para polling offline (CA-9/CA-10).
// Íconos extra del sprite: ic-ttl-countdown (ETA), ic-pause-lock (bloqueo).
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

// #4373 (CA-5) — Prioridad whitelisteada para badge (icono + texto, nunca solo
// color — WCAG 1.4.1). El slice/normalizeWaveIssue ya la trae en minúsculas.
const WR_PRIORITY_WHITELIST = new Set(['critical', 'high', 'medium', 'low']);
function safePriority(raw) {
    const p = typeof raw === 'string' ? raw.toLowerCase() : '';
    return WR_PRIORITY_WHITELIST.has(p) ? p : '';
}

// Normaliza el array de issues de una ola a `{ number, status, title, priority }`,
// descartando entradas sin número válido. `title` puede venir presente en
// entradas enriquecidas (cache de títulos) — se conserva para escaparlo al
// render (superficie XSS de vida larga, CA-8). #4373: `priority` para el badge.
function normalizeIssues(rawIssues) {
    const out = [];
    (Array.isArray(rawIssues) ? rawIssues : []).forEach((it) => {
        let num, status, title, priority;
        if (it && typeof it === 'object') {
            num = safeIssueNumber(it.number != null ? it.number : it.id);
            status = it.status != null ? String(it.status) : '';
            title = it.title != null ? String(it.title) : '';
            priority = safePriority(it.priority);
        } else {
            num = safeIssueNumber(it);
            status = ''; title = ''; priority = '';
        }
        if (num !== null) out.push({ number: num, status, title, priority });
    });
    return out;
}

// #4373 (CA-5) — Badge de prioridad con etiqueta textual (no color-only). La
// prioridad ya viene whitelisteada; el texto se escapa por defensa en profundidad.
function renderPriorityBadge(priority) {
    const p = safePriority(priority);
    if (!p) return '';
    return `<span class="wr-chip-prio wr-prio-${p}" data-priority="${p}" title="${escapeHtmlAttr('Prioridad ' + p)}">${escapeHtmlText(p)}</span>`;
}

// Chip de un issue. `title` (si existe) se escapa en atributo y texto. El estado
// se muestra como texto + clase (nunca color-only) — WCAG 1.4.1. #4373 (CA-5/CA-7):
// badge de prioridad + marca de bloqueo (candado) si el issue está en `blockedSet`.
function renderIssueChip(issue, blockedSet) {
    const num = issue.number; // ya coaccionado
    const titleTxt = issue.title || '';
    const statusTxt = issue.status || '';
    const isBlocked = blockedSet && typeof blockedSet.has === 'function' && blockedSet.has(num);
    const titleAttr = titleTxt
        ? escapeHtmlAttr(`#${num} — ${titleTxt}`)
        : escapeHtmlAttr(`Issue #${num}`);
    const label = titleTxt
        ? `#${num} · ${escapeHtmlText(titleTxt)}`
        : `#${num}`;
    const prioHtml = renderPriorityBadge(issue.priority);
    const statusHtml = statusTxt
        ? `<span class="wr-chip-status" data-status="${escapeHtmlAttr(statusTxt)}">${escapeHtmlText(statusTxt)}</span>`
        : '';
    const blockedHtml = isBlocked
        ? `<span class="wr-chip-blocked" title="${escapeHtmlAttr('Issue #' + num + ' bloqueado')}" aria-label="bloqueado">🔒 bloqueado</span>`
        : '';
    const blockedCls = isBlocked ? ' wr-chip-is-blocked' : '';
    return `<a class="wr-chip${blockedCls}" href="https://github.com/intrale/platform/issues/${num}" target="_blank" rel="noopener noreferrer" title="${titleAttr}">`
        + `<span class="wr-chip-num">${label}</span>${prioHtml}${statusHtml}${blockedHtml}</a>`;
}

function renderIssueList(issues, blockedSet) {
    if (!issues.length) {
        return '<div class="wr-empty-issues">Sin issues asociados.</div>';
    }
    return '<div class="wr-chips">' + issues.map((i) => renderIssueChip(i, blockedSet)).join('') + '</div>';
}

// #4373 (CA-6) — Barra de avance segmentada + lectura numérica "cerrados/total · %".
// `avance` = { closed, total, pct } del slice. Todo numérico (sin dato externo).
function renderAvanceBar(avance) {
    const a = avance || {};
    const total = Number.isFinite(Number(a.total)) ? Number(a.total) : 0;
    const closed = Number.isFinite(Number(a.closed)) ? Number(a.closed) : 0;
    const pct = Number.isFinite(Number(a.pct)) ? Number(a.pct) : 0;
    if (total <= 0) return '';
    const pctClamp = Math.max(0, Math.min(100, pct));
    return `<div class="wr-avance" role="group" aria-label="${escapeHtmlAttr('Avance: ' + closed + ' de ' + total + ' cerrados, ' + pctClamp + ' por ciento')}">`
        + `<div class="wr-avance-track"><div class="wr-avance-fill" style="width:${pctClamp}%"></div></div>`
        + `<span class="wr-avance-label">${closed} / ${total} cerrados · ${pctClamp}%</span>`
        + '</div>';
}

// Formatea minutos a "Nm" / "Nh Mm" (CA-8: el formato vive en la vista).
function fmtEtaMinutes(min) {
    const m = Number(min);
    if (!Number.isFinite(m) || m <= 0) return '—';
    const rounded = Math.round(m);
    if (rounded < 60) return rounded + 'm';
    const h = Math.floor(rounded / 60);
    const rem = rounded % 60;
    return rem > 0 ? `${h}h ${rem}m` : `${h}h`;
}

// #4373 (CA-8) — Panel de ETA de ejecución honesto. Muestra p50/p75/p90 SOLO si
// hay muestra real; cuando `lowSample` (samples=0) o no está lista, muestra el
// aviso "estimación con poca muestra" en vez de un número engañoso.
function renderEtaPanel(eta) {
    const e = eta || {};
    if (!e.ready || e.lowSample) {
        return '<div class="wr-eta wr-eta-lowsample" role="note">'
            + '<svg class="wr-eta-ic" aria-hidden="true"><use href="#ic-ttl-countdown"></use></svg>'
            + '<span class="wr-eta-title">ETA de ejecución</span>'
            + '<span class="wr-eta-lowsample-msg">estimación con poca muestra</span>'
            + '</div>';
    }
    const cell = (label, val, cls) =>
        `<div class="wr-eta-cell ${cls}"><span class="wr-eta-k">${escapeHtmlText(label)}</span>`
        + `<span class="wr-eta-v">${escapeHtmlText(fmtEtaMinutes(val))}</span></div>`;
    return '<div class="wr-eta" role="group" aria-label="ETA de ejecución de la ola activa">'
        + '<svg class="wr-eta-ic" aria-hidden="true"><use href="#ic-ttl-countdown"></use></svg>'
        + '<span class="wr-eta-title">ETA de ejecución</span>'
        + '<div class="wr-eta-cells">'
        + cell('p50', e.p50, 'wr-eta-p50')
        + cell('p75', e.p75, 'wr-eta-p75')
        + cell('p90', e.p90, 'wr-eta-p90')
        + '</div></div>';
}

// #4373 (CA-7) — Panel de bloqueos activos con motivo/blocker textual. Formato
// "#issue → espera a #blocker (motivo)". Todo dato externo escapado por contexto.
function renderBlockedPanel(blocked) {
    const list = Array.isArray(blocked) ? blocked.filter((b) => safeIssueNumber(b && b.issue) !== null) : [];
    if (!list.length) return '';
    const rows = list.map((b) => {
        const issue = safeIssueNumber(b.issue);
        const blocker = safeIssueNumber(b.blocker);
        const reasonTxt = (b.reason != null) ? String(b.reason) : '';
        const blockerHtml = blocker !== null
            ? ` → espera a <a href="https://github.com/intrale/platform/issues/${blocker}" target="_blank" rel="noopener noreferrer">#${blocker}</a>`
            : '';
        const reasonHtml = reasonTxt ? ` <span class="wr-blocked-reason">(${escapeHtmlText(reasonTxt)})</span>` : '';
        return `<li class="wr-blocked-row"><svg class="wr-blocked-ic" aria-hidden="true"><use href="#ic-pause-lock"></use></svg>`
            + `<a class="wr-blocked-issue" href="https://github.com/intrale/platform/issues/${issue}" target="_blank" rel="noopener noreferrer">#${issue}</a>`
            + `${blockerHtml}${reasonHtml}</li>`;
    }).join('');
    return '<div class="wr-blocked" role="group" aria-label="Bloqueos activos">'
        + `<div class="wr-blocked-head"><svg class="wr-blocked-headic" aria-hidden="true"><use href="#ic-pause-lock"></use></svg>`
        + `<span class="wr-blocked-title">Bloqueos activos</span>`
        + `<span class="wr-blocked-count">${escapeHtmlText(String(list.length))}</span></div>`
        + `<ul class="wr-blocked-list">${rows}</ul>`
        + '</div>';
}

// Card de la ola ACTIVA (acento --purple, barra lateral de identidad). Incluye
// la acción "Archivar" (destructiva, POST bajo gate). Todo dato escapado.
// #4373 — `extra` opcional = { avance, eta, blockedSet }: renderiza barra de
// avance (CA-6), panel de ETA (CA-8) y marca de bloqueo por issue (CA-7). Sin
// `extra` degrada al comportamiento previo (#4378) sin romper.
function renderActiveCard(active, extra) {
    if (!active) {
        return '<div class="wr-empty-state" role="status">'
            + '<svg class="wr-empty-ic" aria-hidden="true"><use href="#ic-wave"></use></svg>'
            + '<div class="wr-empty-title">Sin ola activa</div>'
            + '<div class="wr-empty-sub">No hay ninguna ola en curso. Promové una planificada para arrancar.</div>'
            + '</div>';
    }
    const e = extra || {};
    const num = safeWaveNumber(active.number);
    const nameTxt = active.name != null && active.name !== '' ? String(active.name) : (num !== null ? `Ola ${num}` : 'Ola');
    const goalTxt = active.goal != null ? String(active.goal) : '';
    const issues = normalizeIssues(active.issues);
    const archiveBtn = num !== null
        ? `<button type="button" class="wr-btn wr-btn-archive" onclick="roadmapArchive(${num}, 'activa')" title="${escapeHtmlAttr('Archivar la ola ' + num + ' (activa) a archived_waves')}" aria-label="${escapeHtmlAttr('Archivar la ola activa ' + num)}">`
            + '<svg class="wr-btn-ic" aria-hidden="true"><use href="#ic-archive-box"></use></svg> Archivar</button>'
        : '';
    const avanceHtml = renderAvanceBar(e.avance);
    const etaHtml = renderEtaPanel(e.eta);
    const blockedHtml = renderBlockedPanel(e.blocked);
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
      ${avanceHtml}
      ${etaHtml}
      ${renderIssueList(issues, e.blockedSet)}
      ${blockedHtml}
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
// conservados (CA-5) + fecha de cierre (CA-3) + métricas de cierre si están
// presentes. Acepta tanto el shape crudo de waves.json (`issues_completed`,
// `closed_at`) como el whitelisteado del slice #4373 (`issuesCompleted`,
// `closedAt`).
function renderArchivedCard(wave) {
    const num = safeWaveNumber(wave.number);
    const nameTxt = wave.name != null && wave.name !== '' ? String(wave.name) : (num !== null ? `Ola ${num}` : 'Ola');
    const issues = normalizeIssues(wave.issues);
    const completedRaw = wave.issuesCompleted != null ? wave.issuesCompleted : wave.issues_completed;
    const failedRaw = wave.issuesFailed != null ? wave.issuesFailed : wave.issues_failed;
    const completed = Number.isFinite(Number(completedRaw)) ? Number(completedRaw) : null;
    const failed = Number.isFinite(Number(failedRaw)) ? Number(failedRaw) : null;
    const closedAtRaw = wave.closedAt != null ? wave.closedAt : wave.closed_at;
    const closedAt = (typeof closedAtRaw === 'string' && closedAtRaw) ? closedAtRaw : '';
    const metrics = [];
    if (completed !== null) metrics.push(`${completed} completados`);
    if (failed !== null) metrics.push(`${failed} fallidos`);
    const metricsHtml = metrics.length
        ? `<span class="wr-arch-metrics">${escapeHtmlText(metrics.join(' · '))}</span>`
        : '';
    // CA-3 — fecha de cierre. `closed_at` es ISO server-generated; se escapa igual.
    const closedHtml = closedAt
        ? `<span class="wr-arch-closed" title="${escapeHtmlAttr('Cerrada: ' + closedAt)}">cerrada ${escapeHtmlText(closedAt)}</span>`
        : '';
    return `<article class="wr-card wr-card-archived" data-wave="${num !== null ? num : ''}">
      <header class="wr-card-head">
        <div class="wr-card-id">
          <span class="wr-card-title">${escapeHtmlText(nameTxt)}</span>
          ${num !== null ? `<span class="wr-card-num">Ola ${num}</span>` : ''}
          ${closedHtml}
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
/* #4373 — Badge de prioridad (CA-5): icono+texto, nunca color-only (WCAG 1.4.1). */
.wr-chip-prio{font-size:9px;font-weight:800;letter-spacing:.3px;text-transform:uppercase;border-radius:5px;padding:1px 5px;border:1px solid transparent}
.wr-prio-critical,.wr-prio-high{color:#FFD2DC;background:var(--danger-dim,#8B1A14);border-color:var(--danger,#F85149)}
.wr-prio-medium{color:#FFE5A8;background:var(--warning-dim,#9E6A03);border-color:var(--warning,#D29922)}
.wr-prio-low{color:#7EE787;background:var(--success-dim,#196C2E);border-color:var(--success,#3FB950)}
/* #4373 — Marca de bloqueo por chip (CA-7). */
.wr-chip-blocked{font-size:9px;font-weight:800;letter-spacing:.3px;color:#F5B0AC;border-left:1px solid var(--border,rgba(255,255,255,.12));padding-left:5px}
.wr-chip-is-blocked{border-color:var(--danger,#F85149);background:var(--danger-bg,#160B0B)}
/* #4373 — Barra de avance (CA-6). */
.wr-avance{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.wr-avance-track{flex:1;min-width:120px;height:8px;border-radius:999px;background:var(--surface-3,#1c2230);overflow:hidden}
.wr-avance-fill{height:100%;border-radius:999px;background:var(--success,#3FB950)}
.wr-avance-label{font-size:11.5px;font-weight:700;color:var(--text-secondary,#8A93A6);font-variant-numeric:tabular-nums;white-space:nowrap}
/* #4373 — Panel de ETA (CA-8). */
.wr-eta{display:flex;align-items:center;gap:9px;flex-wrap:wrap;padding:8px 11px;border-radius:10px;border:1px solid var(--border-subtle,rgba(255,255,255,.08));background:var(--surface-0,#0d1117)}
.wr-eta-ic{width:14px;height:14px;color:var(--teal,#34D9E0);flex-shrink:0}
.wr-eta-title{font-size:10px;font-weight:800;letter-spacing:.4px;text-transform:uppercase;color:var(--text-secondary,#8A93A6)}
.wr-eta-cells{display:flex;gap:8px;flex-wrap:wrap}
.wr-eta-cell{display:flex;flex-direction:column;align-items:flex-start;gap:1px}
.wr-eta-k{font-size:9px;font-weight:800;letter-spacing:.3px;text-transform:uppercase;color:var(--text-dim,#8B949E)}
.wr-eta-v{font-size:12.5px;font-weight:800;font-variant-numeric:tabular-nums;color:var(--text-primary,#e6edf3)}
.wr-eta-p50 .wr-eta-v{color:var(--success,#3FB950)}
.wr-eta-p75 .wr-eta-v{color:var(--warning,#D29922)}
.wr-eta-p90 .wr-eta-v{color:var(--quota-degraded,#F0883E)}
.wr-eta-lowsample{border-color:var(--warning-dim,#9E6A03)}
.wr-eta-lowsample-msg{font-size:11.5px;font-style:italic;color:var(--warning,#D29922)}
/* #4373 — Panel de bloqueos activos (CA-7). */
.wr-blocked{border:1px solid var(--danger-dim,#8B1A14);border-radius:10px;padding:9px 12px;background:var(--danger-bg,#160B0B)}
.wr-blocked-head{display:flex;align-items:center;gap:7px;margin-bottom:6px}
.wr-blocked-headic,.wr-blocked-ic{width:13px;height:13px;color:var(--danger,#F85149);flex-shrink:0}
.wr-blocked-title{font-size:10.5px;font-weight:800;letter-spacing:.4px;text-transform:uppercase;color:#F5B0AC}
.wr-blocked-count{font-size:10.5px;font-weight:800;color:#F5B0AC;background:var(--danger-dim,#8B1A14);border-radius:999px;padding:0 7px;font-variant-numeric:tabular-nums}
.wr-blocked-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:4px}
.wr-blocked-row{display:flex;align-items:center;gap:6px;font-size:11.5px;color:var(--text-secondary,#8A93A6)}
.wr-blocked-row a{color:var(--info,#58a6ff);text-decoration:none}
.wr-blocked-row a:hover{text-decoration:underline}
.wr-blocked-reason{color:var(--text-dim,#8B949E);font-style:italic}
.wr-arch-closed{font-size:10.5px;color:var(--text-dim,#8B949E);font-variant-numeric:tabular-nums}
@media (prefers-reduced-motion:reduce){.wr-archived-toggle .wr-expand-ic{transition:none}}
</style>`;
}

/**
 * Fragmento SSR de la ventana Roadmap. Devuelve `<main id="view-content"
 * data-slug="roadmap">` con las tres secciones renderizadas server-side.
 *
 * #4373 (Ola 8.3) — Vista operativa consolidada. Si `opts.roadmap` (payload del
 * `roadmapSlice`) está presente, la vista enriquece la ola activa con avance
 * (CA-6), ETA (CA-8) y bloqueos (CA-7), y muestra prioridad por issue (CA-5).
 * Backward-compat (#4378): sin `opts.roadmap` degrada a leer `waves.json`
 * directo (loadWaves) sin avance/ETA/bloqueos.
 *
 * @param {object} [opts] — { roadmap? } payload enriquecido del slice; o
 *                          { wavesState? } inyectable para tests; si faltan se
 *                          lee de lib/waves.js (loadWaves).
 */
function renderRoadmapSsr(opts) {
    const rm = opts && opts.roadmap && typeof opts.roadmap === 'object' ? opts.roadmap : null;

    let active, planned, archived, blocked, eta, avance;
    if (rm) {
        active = rm.activeWave || null;
        planned = Array.isArray(rm.plannedWaves) ? rm.plannedWaves : [];
        archived = Array.isArray(rm.archivedWaves) ? rm.archivedWaves : [];
        blocked = Array.isArray(rm.blocked) ? rm.blocked : [];
        eta = rm.eta || null;
        avance = rm.avance || null;
    } else {
        const state = readWavesState(opts);
        active = state && state.active_wave ? state.active_wave : null;
        planned = Array.isArray(state && state.planned_waves) ? state.planned_waves : [];
        archived = Array.isArray(state && state.archived_waves) ? state.archived_waves : [];
        blocked = [];
        eta = null;
        avance = null;
    }

    // CA-7 — issues bloqueados marcados en los chips de la ola activa.
    const blockedSet = new Set((blocked || [])
        .map((b) => safeIssueNumber(b && b.issue))
        .filter((n) => n !== null));

    const activeHtml = renderActiveCard(active, { avance, eta, blocked, blockedSet });

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
    <span>Datos offline (waves.json) · sin gh en runtime · acción Archivar bajo gate loopback+same-origin</span>
    <span>Intrale V3 · #4378 · #4373</span>
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
    // #4373 (Ola 8.3) — helpers de la vista operativa consolidada.
    renderPriorityBadge,
    renderAvanceBar,
    renderEtaPanel,
    renderBlockedPanel,
    fmtEtaMinutes,
    safePriority,
};
