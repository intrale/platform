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

// state = { agentHistory: Array<{ issue, titulo, skill, pipeline, fase, estado,
//                                  resultado, duration, startedAt, finishedAt,
//                                  hasLog, logFile, hasRejectionPdf, rejectionPdf }> }
// opts  = { agentPersona, manualOrderIndex, fmtDuration, ghBaseUrl }
function renderHistorialSsr(state, opts) {
    const list = Array.isArray(state && state.agentHistory) ? state.agentHistory : [];
    if (list.length === 0) return '';

    const o = opts || {};
    const persona = o.agentPersona || {};
    const orderIdx = o.manualOrderIndex || new Map();
    const fmtDuration = (typeof o.fmtDuration === 'function') ? o.fmtDuration : (() => '—');
    const ghBaseUrl = o.ghBaseUrl || 'https://github.com/intrale/platform/issues';

    const card = (h) => renderHistCard(h, persona, orderIdx, fmtDuration, ghBaseUrl);

    const visible = list.slice(0, HIST_VISIBLE).map(card).join('');
    const hidden = list.length > HIST_VISIBLE
        ? list.slice(HIST_VISIBLE, HIST_CAP).map(card).join('')
        : '';
    const moreCount = Math.min(list.length - HIST_VISIBLE, HIST_CAP - HIST_VISIBLE);
    const moreToggle = hidden
        ? `<details class="ah-more"><summary class="ah-more-btn">Ver ${moreCount} más…</summary><div class="ah-more-list">${hidden}</div></details>`
        : '';

    // CA-8: leyenda corta de estados + diferencia visible/toggle.
    const legend = `<span class="ah-legend" title="Leyenda de estados de las ejecuciones">
          <span class="ah-leg-item"><span class="ah-leg-glyph ah-running">●</span> en ejecución</span>
          <span class="ah-leg-item"><span class="ah-leg-glyph ah-ok">✓</span> aprobado</span>
          <span class="ah-leg-item"><span class="ah-leg-glyph ah-fail">✗</span> rechazado</span>
          <span class="ah-leg-item"><span class="ah-leg-glyph ah-neutral">—</span> finalizado</span>
        </span>`;

    return `
    <div class="matrix-section section-collapsible section-collapsed" id="agent-history" data-section="historial">
      <div class="matrix-header">
        <h2 class="section-title-clickable" onclick="toggleSection('historial')" title="Click para colapsar/expandir la sección">
          <span class="section-chevron">▼</span> \u{1F4DC} Historial de Ejecuciones
        </h2>
        ${legend}
        <a class="section-popout" href="/?section=historial" target="_blank" rel="noopener noreferrer" title="Abrir en ventana independiente" onclick="event.stopPropagation()">↗</a>
        <span class="ah-count">${escapeHtmlText(list.length)} ejecuciones</span>
      </div>
      <div class="section-body">
      <div class="ah-list">
        ${visible}
        ${moreToggle}
      </div>
      </div>
    </div>`;
}

module.exports = { renderHistorialSsr, renderHistCard, loadTheme, isSafeFilename, HIST_VISIBLE, HIST_CAP };
