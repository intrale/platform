'use strict';

// =============================================================================
// pipeline.js — Ventana "Pipeline" del Dashboard V3 (issue #3728, padre #3715).
//
// Extracción del bloque de la ventana Pipeline embebido en el shell del
// monolito `dashboard.js` (antes inline ~5116-5347 contra HEAD de la receta):
//   1. Control Bar (status pill + Priority Windows + Pausar/Reanudar)
//   2. Banner partial-pause-deps (CTA includeMissingDeps)
//   3. <details> Allowlist & Candidatos (allowlist activa + candidatos + picker)
//   4. <details> Audit trail (#3625 CA-5: hash-chain + 5 KPIs + tabla)
//   5. Infra Health (delegado a renderInfraHealth inyectado)
//
// DECISIONES DE DISEÑO (cerradas por guru/architect/UX, ver issue #3728):
//   - SSR PURO: el módulo NO lee filesystem, NO invoca slices, NO hace `fetch`.
//     Todo el state llega por argumento (decisión #1 de guru).
//   - SIN acoplamiento circular: NO requiere el módulo dashboard. Los helpers
//     compartidos `renderInfraHealth` y `renderPartialPauseAuditRows` (más `ic`)
//     llegan inyectados por el caller (decisiones #2 y #3 de guru).
//   - HANDLERS STATE-CHANGING intactos: los 6 (`pauseAction`, `allowlistLike`,
//     `allowlistUnlike`, `allowlistRemove`, `allowlistPromote`,
//     `includeMissingDeps`) + `pwAction` siguen en el `<script>` global de
//     `dashboard.js`. El módulo SOLO produce HTML con `onclick="..."` que los
//     referencia. Preserva la cadena CSRF same-origin + token (#3688/#2532/#2745).
//
// JERARQUÍA V3 (narrativa-pipeline-v3.md, no negociable):
//   Control Bar (sticky) → banner deps → details Allowlist (open si partial-pause)
//   → details Audit (open si chain_broken o sin-autoría) → Infra Health.
//
// SEGURIDAD (CA-B3 / CA-D1 / CA-PL6 / CA-PL7 / CA-PL8):
//   - Todo dato dinámico (reason de candidato, allowedIssues, justification,
//     autor) pasa por escapeHtmlText / escapeHtmlAttr de `lib/escape-html.js`.
//   - Bug latente de `allowedIssues` (línea 5290 del monolito: `'#' + i` sin
//     escape) NO se replica — cada item va por escapeHtmlText(String(i)) (CA-PL7).
//   - Tooltips con interpolado pasan por escapeHtmlAttr (CA-PL8).
// =============================================================================

let escapeHtmlText;
let escapeHtmlAttr;
try {
    ({ escapeHtmlText, escapeHtmlAttr } = require('../../lib/escape-html.js'));
} catch (_) {
    // Fallback inline (CA-A3): si el helper compartido no cargó, el módulo
    // sigue escapando en vez de emitir HTML crudo o romper el render.
    const escText = (s) => (s === null || s === undefined ? '' : String(s))
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const escAttr = (s) => (s === null || s === undefined ? '' : String(s))
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/`/g, '&#96;');
    escapeHtmlText = escText;
    escapeHtmlAttr = escAttr;
}

// Tooltips acordados con PO + UX (CA-PL8 / narrativa-pipeline-v3.md). Los
// estáticos van literales; los que interpolan #issue se escapan en el render.
const TOOLTIPS = {
    pauseGlobal: 'Detiene tomas de nuevos ciclos. In-flight termina normalmente.',
    resumeGlobal: 'Reanuda tomas y limpia el estado partial-pause.',
    resumePartial: 'Desactiva la pausa parcial y reanuda todo el pipeline.',
    includeDeps: 'Agrega todas las deps abiertas al allowlist en bloque (includeMissingDeps).',
    dismissDeps: 'Oculta el aviso — volverá a aparecer en el próximo ciclo si persiste.',
    sumarLike: 'Persiste un like con razón en allowlist-candidates.json.',
    auditLink: 'Endpoint JSONL de las mutaciones con hash-chain auditable.',
};

// Fallback defensivo del icon helper inyectado: si el caller no lo pasa, no
// rompemos el render — devolvemos vacío (el sprite es decorativo, no crítico).
function icFallback() { return ''; }

/**
 * Render SSR de la ventana Pipeline.
 *
 * @param {object} params
 * @param {{mode?:string, allowedIssues?:Array}} [params.partialPauseState]
 * @param {Array} [params.allowlistCandidatesList]
 * @param {object} [params.partialPauseAuditData] // contrato slice partialPauseAuditSlice
 * @param {object} [params.state]                 // state global (para renderInfraHealth + priorityWindows)
 * @param {number} [params.stale]
 * @param {boolean} [params.blocked]
 * @param {boolean} [params.isPaused]
 * @param {boolean} [params.isPartialPause]
 * @param {number} [params.trabajando]
 * @param {number} [params.pwThreshold]           // umbral Priority Windows (calculado por el caller)
 * @param {number} [params.now]                   // timestamp para "elapsed" (default Date.now())
 * @param {Function} [params.ic]                  // sprite icon helper (inyectado)
 * @param {Function} [params.renderInfraHealth]   // helper compartido (inyectado, NO se mueve)
 * @param {Function} [params.renderPartialPauseAuditRows] // shim audit-trail (inyectado)
 * @returns {string} HTML de la ventana Pipeline
 */
function renderPipelineHTML(params) {
    const p = params || {};
    const partialPauseState = p.partialPauseState || { mode: 'running', allowedIssues: [] };
    const allowedIssues = Array.isArray(partialPauseState.allowedIssues) ? partialPauseState.allowedIssues : [];
    const allowlistCandidatesList = Array.isArray(p.allowlistCandidatesList) ? p.allowlistCandidatesList : [];
    const audit = normalizeAudit(p.partialPauseAuditData);
    const state = p.state || {};
    const stale = Number(p.stale || 0);
    const blocked = Boolean(p.blocked);
    const isPaused = Boolean(p.isPaused);
    const trabajando = Number(p.trabajando || 0);
    const pwThreshold = Number(p.pwThreshold || 3);
    const now = typeof p.now === 'number' ? p.now : Date.now();
    const ic = typeof p.ic === 'function' ? p.ic : icFallback;
    const renderInfraHealth = typeof p.renderInfraHealth === 'function' ? p.renderInfraHealth : () => '';
    const renderRows = typeof p.renderPartialPauseAuditRows === 'function'
        ? p.renderPartialPauseAuditRows
        : () => '<tr><td colspan="6" class="ppa-empty">Renderer no disponible — recargá el dashboard tras restart del pulpo.</td></tr>';

    // partial-pause activo: respeta el boolean inyectado y, como fallback,
    // deriva del mode (acepta variantes hyphen/underscore por robustez).
    const partialActive = Boolean(p.isPartialPause)
        || partialPauseState.mode === 'partial_pause'
        || partialPauseState.mode === 'partial-pause';

    // Audit abre por defecto si hay algo que NO puede quedar oculto (decisión
    // UX #2): hash-chain rota o mutaciones sin autoría.
    const auditNeedsAttention = Boolean(audit.chain_broken) || Boolean(audit.has_unauthorized_non_backfill);

    return `
  <!-- ============================================================
       Ventana Pipeline V3 (#3728, split de #3715)
       Orden V3: Control Bar (sticky) → banner deps → Allowlist →
       Audit Trail → Infra Health. SSR puro, handlers en el global.
       ============================================================ -->
  ${renderControlBar({ ic, state, stale, blocked, isPaused, partialActive, trabajando, pwThreshold, now, allowedIssues })}

  ${renderDepsBanner({ ic })}

  ${renderAllowlistSection({ ic, allowedIssues, allowlistCandidatesList, partialActive })}

  ${renderAuditTrail({ ic, audit, renderRows, auditNeedsAttention })}

  ${renderInfraHealth(state)}
`;
}

// --- Normalización defensiva del contrato de la slice (riesgo #3 receta) ------
// Si cualquier campo falta, degradamos a un default seguro en vez de renderizar
// `undefined`. El contrato esperado: chain_broken, chain_broken_at,
// chain_entries_checked, entries[], stats.{total,authorized,rejected,unknown},
// has_unauthorized_non_backfill.
function normalizeAudit(raw) {
    const a = raw || {};
    const stats = a.stats || {};
    return {
        chain_broken: Boolean(a.chain_broken),
        chain_broken_at: a.chain_broken_at,
        chain_entries_checked: Number(a.chain_entries_checked || 0),
        entries: Array.isArray(a.entries) ? a.entries : [],
        has_unauthorized_non_backfill: Boolean(a.has_unauthorized_non_backfill),
        stats: {
            total: Number(stats.total || 0),
            authorized: Number(stats.authorized || 0),
            rejected: Number(stats.rejected || 0),
            unknown: Number(stats.unknown || 0),
        },
    };
}

// --- 1. Control Bar (sticky) --------------------------------------------------
function renderControlBar({ ic, state, stale, blocked, isPaused, partialActive, trabajando, pwThreshold, now, allowedIssues }) {
    const pw = state.priorityWindows || {};
    const qaActive = pw.qa && pw.qa.active;
    const buildActive = pw.build && pw.build.active;

    let barCls = 'ctrl-ok';
    if (blocked) barCls = 'ctrl-blocked';
    else if (isPaused) barCls = 'ctrl-paused';
    else if (qaActive) barCls = 'ctrl-priority-qa';
    else if (buildActive) barCls = 'ctrl-priority-build';
    else if (stale > 0) barCls = 'ctrl-stale';

    let statusHtml;
    if (blocked) {
        statusHtml = '<span class="ctrl-bar-status"><span class="ctrl-bar-status-icon">⛔</span>Recursos al límite — nuevos lanzamientos en espera</span>';
    } else if (isPaused) {
        statusHtml = '<span class="ctrl-bar-status"><span class="ctrl-bar-status-icon">⏸️</span>Pipeline en pausa</span>'
            + '<button class="ctrl-bar-btn" onclick="pauseAction(\'resume\')" title="' + escapeHtmlAttr(TOOLTIPS.resumeGlobal) + '">▶ Reanudar</button>';
    } else if (partialActive) {
        // CA-PL7 — cada item de allowedIssues escapado ANTES de concatenar.
        // El monolito (línea ~5290) hacía `'#' + i` sin escape (riesgo #2).
        const allowedList = allowedIssues.map((i) => '#' + escapeHtmlText(String(i))).join(', ');
        statusHtml = '<span class="ctrl-bar-status"><span class="ctrl-bar-status-icon">\u{1F3AF}</span>Pausa parcial · allowed: ' + allowedList + '</span>'
            + '<button class="ctrl-bar-btn" onclick="pauseAction(\'resume\')" title="' + escapeHtmlAttr(TOOLTIPS.resumePartial) + '">▶ Reanudar</button>';
    } else if (qaActive) {
        const elapsed = pw.qa.activatedAt ? Math.round((now - pw.qa.activatedAt) / 60000) : 0;
        statusHtml = '<span class="ctrl-bar-status"><span class="ctrl-bar-status-icon">\u{1F50D}</span>Ventana QA activa · ' + elapsed + ' min</span>'
            + '<button class="ctrl-bar-btn" onclick="pwAction(\'qa\',\'off\')" title="Desactivar ventana QA">✕ Cerrar</button>';
    } else if (buildActive) {
        const elapsed = pw.build.activatedAt ? Math.round((now - pw.build.activatedAt) / 60000) : 0;
        statusHtml = '<span class="ctrl-bar-status"><span class="ctrl-bar-status-icon">\u{1F528}</span>Ventana Build activa · ' + elapsed + ' min</span>'
            + '<button class="ctrl-bar-btn" onclick="pwAction(\'build\',\'off\')" title="Desactivar ventana Build">✕ Cerrar</button>';
    } else if (stale > 0) {
        statusHtml = '<span class="ctrl-bar-status"><span class="ctrl-bar-status-icon">⚠️</span>' + stale + ' issue' + (stale > 1 ? 's' : '') + ' sin avance (+30 min)</span>';
    } else {
        const msg = trabajando > 0 ? trabajando + ' agente' + (trabajando > 1 ? 's' : '') + ' trabajando' : 'Sin actividad';
        statusHtml = '<span class="ctrl-bar-status"><span class="ctrl-bar-status-icon">✓</span>' + msg + '</span>';
    }

    // Toggles de Priority Windows (QA / Build) — tooltips de narrativa.
    const items = [
        { key: 'qa', emoji: '\u{1F50D}', label: 'QA', cls: '', tipOn: 'Activa Priority Window QA: prioriza skills de QA cuando carga ≥ 75%.' },
        { key: 'build', emoji: '\u{1F528}', label: 'Build', cls: ' pw-build', tipOn: 'Activa Priority Window Build: prioriza builders cuando carga ≥ 50%.' },
    ];
    const otherActive = (k) => items.some((j) => j.key !== k && pw[j.key] && pw[j.key].active);
    const togglesHtml = items.map((i) => {
        const s = pw[i.key];
        const active = s && s.active;
        const elapsed = active && s.activatedAt ? Math.round((now - s.activatedAt) / 60000) : 0;
        const text = active ? i.emoji + ' ' + i.label + ' · ' + elapsed + 'm' : i.emoji + ' ' + i.label;
        let tip = active
            ? i.label + ' Priority activa (' + elapsed + 'm) — click para desactivar'
            : i.tipOn + ' (umbral auto: ' + pwThreshold + ' issues)';
        if (!active && otherActive(i.key)) tip += ' — ⚠ la otra ventana está activa (autoexcluyentes)';
        const action = active ? 'off' : 'on';
        const cls = active ? 'pw-toggle-active' : 'pw-toggle-inactive';
        return '<span class="pw-toggle ' + cls + i.cls + '" title="' + escapeHtmlAttr(tip) + '" onclick="pwAction(\'' + i.key + '\',\'' + action + '\')">' + escapeHtmlText(text) + '</span>';
    }).join('');

    // Toggle de pausa (solo si no está pausado ni bloqueado — si está pausado,
    // ya hay botón Reanudar en el status).
    const pauseBtnHtml = (!isPaused && !blocked)
        ? '<button class="ctrl-bar-btn" onclick="pauseAction(\'pause\')" title="' + escapeHtmlAttr(TOOLTIPS.pauseGlobal) + '">⏸ Pausar</button>'
        : '';

    return '<div class="pipeline-ctrl-bar ' + barCls + '">'
        + statusHtml
        + '<span class="ctrl-bar-spacer"></span>'
        + '<span class="ctrl-bar-label">Priority</span>'
        + '<span class="pw-toggles">' + togglesHtml + '</span>'
        + (pauseBtnHtml ? '<span class="ctrl-bar-sep"></span>' + pauseBtnHtml : '')
        + '</div>';
}

// --- 2. Banner partial-pause-deps (#2893) ------------------------------------
function renderDepsBanner({ ic }) {
    return `<div id="partial-pause-deps-banner" role="alert" style="display:none;margin:8px 0 4px;padding:10px 14px;border-radius:8px;background:rgba(240,165,0,0.12);border:1px solid rgba(240,165,0,0.45);color:#f0a500;font-size:var(--fs-sm,0.85rem);">
    <span style="font-weight:600;display:inline-flex;align-items:center;gap:6px;">${ic('estado-partial-pause')} Pausa parcial trabada</span>
    <span id="partial-pause-deps-msg" style="margin-left:10px;color:var(--text,#c9d1d9);"></span>
    <button onclick="includeMissingDeps()" style="margin-left:12px;padding:4px 10px;background:#f0a500;color:#1c2128;border:0;border-radius:4px;cursor:pointer;font-weight:600;" title="${escapeHtmlAttr(TOOLTIPS.includeDeps)}">Agregar dependencias al allowlist</button>
    <button onclick="dismissDepsBanner()" style="margin-left:6px;padding:4px 10px;background:transparent;color:#c9d1d9;border:1px solid rgba(255,255,255,0.2);border-radius:4px;cursor:pointer;" title="${escapeHtmlAttr(TOOLTIPS.dismissDeps)}">Ocultar</button>
  </div>`;
}

// --- 3. Allowlist & Candidatos (#3142) ---------------------------------------
function renderAllowlistSection({ ic, allowedIssues, allowlistCandidatesList, partialActive }) {
    const activeList = allowedIssues.length === 0
        ? '<div class="dim" style="font-size:0.85em;font-style:italic">Pipeline corriendo sin allowlist activa (modo Kanban abierto).</div>'
        : '<ul style="list-style:none;padding:0;margin:0;display:flex;flex-direction:column;gap:4px">'
            + allowedIssues.map((i) => {
                // onclick usa coerción numérica (handler espera number) → sin
                // riesgo de inyección JS aunque `i` venga corrupto.
                const issueNum = Number(i);
                const onclickArg = Number.isFinite(issueNum) ? issueNum : 'NaN';
                const issueText = escapeHtmlText(String(i));
                const issueHref = escapeHtmlAttr(String(i));
                return '<li style="display:flex;align-items:center;gap:8px;padding:6px 10px;background:rgba(57,197,207,0.06);border:1px solid rgba(57,197,207,0.2);border-radius:6px;font-size:0.85em">'
                    + '<a href="https://github.com/intrale/platform/issues/' + issueHref + '" target="_blank" rel="noopener noreferrer" style="font-family:\'SF Mono\',Consolas,monospace;color:#58a6ff;text-decoration:none">#' + issueText + '</a>'
                    + '<span class="dim" style="flex:1"></span>'
                    + '<button onclick="allowlistRemove(' + onclickArg + ')" title="' + escapeHtmlAttr('Saca #' + String(i) + ' de la allowlist activa. Confirmación requerida.') + '" style="padding:3px 9px;background:transparent;color:#f85149;border:1px solid rgba(248,81,73,0.4);border-radius:4px;cursor:pointer;font-size:0.85em">➖ quitar</button>'
                    + '</li>';
            }).join('')
            + '</ul>';

    const candidatesList = allowlistCandidatesList.length === 0
        ? '<div class="dim" style="font-size:0.85em;font-style:italic">No hay candidatos likeados. Bus' + 'cá un issue más abajo para empezar.</div>'
        : '<ul style="list-style:none;padding:0;margin:0;display:flex;flex-direction:column;gap:4px" id="allowlist-candidates-list">'
            + allowlistCandidatesList.map((c) => {
                const issueNum = Number(c.issue);
                const onclickArg = Number.isFinite(issueNum) ? issueNum : 'NaN';
                const issueText = escapeHtmlText(String(c.issue));
                const issueHref = escapeHtmlAttr(String(c.issue));
                const dateLabel = (c.likedAt || '').slice(0, 10) || '—';
                const safeReason = escapeHtmlText(c.reason || '');
                const reasonHtml = safeReason ? '<div class="dim" style="font-size:0.78em;margin-top:2px">' + safeReason + '</div>' : '';
                return '<li style="display:flex;flex-direction:column;gap:2px;padding:8px 10px;background:rgba(188,140,255,0.05);border:1px solid rgba(188,140,255,0.18);border-radius:6px;font-size:0.85em">'
                    + '<div style="display:flex;align-items:center;gap:8px">'
                    + '<a href="https://github.com/intrale/platform/issues/' + issueHref + '" target="_blank" rel="noopener noreferrer" style="font-family:\'SF Mono\',Consolas,monospace;color:#58a6ff;text-decoration:none">#' + issueText + '</a>'
                    + '<span class="dim" style="font-size:0.78em">Liked ' + escapeHtmlText(dateLabel) + '</span>'
                    + '<span style="flex:1"></span>'
                    + '<button onclick="allowlistPromote(' + onclickArg + ')" title="' + escapeHtmlAttr('Promueve #' + String(c.issue) + ' a allowlist activa + comenta en GitHub.') + '" style="padding:3px 9px;background:#3fb950;color:#1c2128;border:0;border-radius:4px;cursor:pointer;font-size:0.85em;font-weight:600">➕ sumar</button>'
                    + '<button onclick="allowlistUnlike(' + onclickArg + ')" title="' + escapeHtmlAttr('Quita el like sobre #' + String(c.issue) + '. No afecta la allowlist activa.') + '" style="padding:3px 9px;background:transparent;color:#c9d1d9;border:1px solid rgba(255,255,255,0.2);border-radius:4px;cursor:pointer;font-size:0.85em">❤️ unlike</button>'
                    + '</div>'
                    + reasonHtml
                    + '</li>';
            }).join('')
            + '</ul>';

    return `<details ${partialActive ? 'open ' : ''}id="allowlist-candidates-section" class="section" style="margin:8px 0;border:1px solid rgba(255,255,255,0.08);border-radius:8px;background:rgba(255,255,255,0.02);">
    <summary style="cursor:pointer;padding:10px 14px;font-weight:600;display:flex;align-items:center;gap:8px;">
      <span style="color:var(--purple,#bc8cff)">❤️</span>
      Allowlist &amp; Candidatos
      <span class="dim" style="font-weight:normal;font-size:0.85em">
        — activa: ${allowedIssues.length}, candidatos: ${allowlistCandidatesList.length}
      </span>
    </summary>
    <div style="padding:8px 14px 14px">
      <div style="margin-bottom:14px">
        <div style="font-weight:600;margin-bottom:6px;color:var(--teal,#39c5cf)">
          \u{1F4CC} Allowlist activa <span class="dim" style="font-weight:normal">(${allowedIssues.length})</span>
        </div>
        ${activeList}
      </div>

      <div style="margin-bottom:10px">
        <div style="font-weight:600;margin-bottom:6px;color:var(--purple,#bc8cff)">
          ❤️ Candidatos likeados <span class="dim" style="font-weight:normal">(${allowlistCandidatesList.length})</span>
        </div>
        ${candidatesList}
      </div>

      <div style="display:flex;align-items:center;gap:8px;margin-top:8px;padding:8px;background:rgba(255,255,255,0.03);border:1px dashed rgba(255,255,255,0.12);border-radius:6px">
        <input id="allowlist-like-input" type="text" placeholder="Número de issue (ej: 3140)" inputmode="numeric" pattern="\\d+" style="flex:0 0 200px;padding:6px 8px;background:#0d1117;color:#c9d1d9;border:1px solid rgba(255,255,255,0.15);border-radius:4px;font-size:0.85em;font-family:'SF Mono',Consolas,monospace">
        <input id="allowlist-like-reason" type="text" placeholder="Razón (opcional, max 500)" maxlength="500" style="flex:1;padding:6px 8px;background:#0d1117;color:#c9d1d9;border:1px solid rgba(255,255,255,0.15);border-radius:4px;font-size:0.85em">
        <button onclick="allowlistLike()" title="${escapeHtmlAttr(TOOLTIPS.sumarLike)}" style="padding:6px 12px;background:var(--purple,#bc8cff);color:#1c2128;border:0;border-radius:4px;cursor:pointer;font-size:0.85em;font-weight:600">❤️ likear</button>
      </div>
    </div>
  </details>`;
}

// --- 4. Audit trail (#3625 CA-5) ---------------------------------------------
function renderAuditTrail({ ic, audit, renderRows, auditNeedsAttention }) {
    const chainBrokenAt = escapeHtmlText(String(audit.chain_broken_at == null ? '?' : audit.chain_broken_at));
    const unauthCount = (audit.entries || []).filter((e) => e && e.visual === 'unauthorized' && !e.backfill).length;

    return `<details ${auditNeedsAttention ? 'open ' : ''}id="panel-allowlist-audit" class="section ppa-section" data-test-id="panel-allowlist-audit">
    <summary>
      ${ic('fallback-chain', 'audit log')}
      <span>Audit trail &middot; Allowlist mutations</span>
      <span class="dim" style="font-weight:normal;font-size:0.85em">— últimas 24h · hash-chain auditable</span>
    </summary>
    <div class="ppa-section-body">
      <div id="ppa-banner-chain" class="ppa-banner ppa-banner-critical" role="alert" aria-live="assertive" style="display:${audit.chain_broken ? 'flex' : 'none'};">
        <span aria-hidden="true">⛓</span>
        <span>
          <strong>Hash-chain del audit log roto en entry #<span id="ppa-broken-at">${chainBrokenAt}</span>.</strong>
          Escrituras nuevas bloqueadas hasta intervención humana. Ver <code>docs/pipeline/audit-recovery.md</code> para procedimiento de recovery.
        </span>
      </div>
      <div id="ppa-banner-unauth" class="ppa-banner ppa-banner-warning" role="alert" aria-live="polite" style="display:${audit.has_unauthorized_non_backfill ? 'flex' : 'none'};">
        <span aria-hidden="true">⚠</span>
        <span>
          <strong><span id="ppa-unauth-count">${unauthCount}</span> mutación(es) sin autoría detectada(s)</strong> — alerta enviada al Commander. Revisalo antes del próximo restart del pipeline.
        </span>
      </div>

      <div class="ppa-kpis" data-test-id="ppa-kpis">
        <div class="ppa-kpi">
          <div class="ppa-kpi-label">Mutaciones 24h</div>
          <div class="ppa-kpi-value" id="ppa-kpi-total" aria-label="Mutaciones últimas 24h">${audit.stats.total}</div>
          <div class="ppa-kpi-sub">total append-only</div>
        </div>
        <div class="ppa-kpi ppa-kpi-auth">
          <div class="ppa-kpi-label">${ic('architect-approved', 'autorizadas')}<span>Autorizadas</span></div>
          <div class="ppa-kpi-value ppa-value-success" id="ppa-kpi-auth" aria-label="Mutaciones autorizadas">${audit.stats.authorized}</div>
          <div class="ppa-kpi-sub">por enum cerrado</div>
        </div>
        <div class="ppa-kpi ppa-kpi-rejected">
          <div class="ppa-kpi-label">${ic('architect-rejected', 'rechazadas')}<span>Rejected</span></div>
          <div class="ppa-kpi-value ${audit.stats.rejected > 0 ? 'ppa-value-danger' : 'ppa-value-dim'}" id="ppa-kpi-rejected" aria-label="Mutaciones rechazadas por el gate">${audit.stats.rejected}</div>
          <div class="ppa-kpi-sub">por gate (CA-2)</div>
        </div>
        <div class="ppa-kpi ppa-kpi-unknown">
          <div class="ppa-kpi-label">${ic('health-warn', 'sin autoria')}<span>Sin autoría</span></div>
          <div class="ppa-kpi-value ${audit.stats.unknown > 0 ? 'ppa-value-warning' : 'ppa-value-dim'}" id="ppa-kpi-unknown" aria-label="Mutaciones sin autoría registrada">${audit.stats.unknown}</div>
          <div class="ppa-kpi-sub">authorized_by=null</div>
        </div>
        <div class="ppa-kpi ppa-kpi-chain">
          <div class="ppa-kpi-label">${ic('estado-partial-pause', 'hash chain')}<span>Hash-chain</span></div>
          <div class="ppa-kpi-value ${audit.chain_broken ? 'ppa-value-danger' : 'ppa-value-success'}" id="ppa-kpi-chain" aria-label="Estado del hash-chain del audit log">${audit.chain_broken ? '✗ ROTO' : '✓ ' + audit.chain_entries_checked}</div>
          <div class="ppa-kpi-sub" id="ppa-kpi-chain-sub">${audit.chain_broken ? 'entry #' + chainBrokenAt : 'entries verificadas'}</div>
        </div>
      </div>

      <div class="ppa-table-wrap">
        <table class="ppa-table" data-test-id="ppa-table">
          <thead><tr>
            <th scope="col">Cuándo</th>
            <th scope="col">Source</th>
            <th scope="col">Acción</th>
            <th scope="col">Diff</th>
            <th scope="col">Autorizado por</th>
            <th scope="col">Justificación</th>
          </tr></thead>
          <tbody id="ppa-tbody" aria-live="polite">
            ${renderRows(audit.entries)}
          </tbody>
        </table>
      </div>

      <div class="ppa-footer">
        <span id="ppa-updated-at">Server-side render · refresh polling 30s</span> ·
        Endpoint: <a href="/api/dash/partial-pause-audit" title="${escapeHtmlAttr(TOOLTIPS.auditLink)}">/api/dash/partial-pause-audit</a> ·
        Spec: <code>narrativa-allowlist-audit-trail.md</code> · CA-5 de
        <a href="https://github.com/intrale/platform/issues/3625" target="_blank" rel="noopener noreferrer">#3625</a>
      </div>
    </div>
  </details>`;
}

module.exports = { renderPipelineHTML, normalizeAudit, TOOLTIPS };
