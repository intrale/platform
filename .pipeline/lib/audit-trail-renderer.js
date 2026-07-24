// #3625 CA-5 — Renderer server-side de filas del widget "Audit trail · Allowlist
// mutations" del dashboard. Convierte entries del slice `partialPauseAuditSlice`
// en HTML siguiendo la narrativa-allowlist-audit-trail.md (4 estados visuales
// A/B/C/D con icono, color, borde y microcopy específica).
//
// El módulo es puro: no abre conexiones, no toca filesystem, no toca process.
// Pensado para ser require-able desde dashboard.js y desde tests sin side-effects.
//
// Spec: .pipeline/assets/mockups/narrativa-allowlist-audit-trail.md
// Mockup: .pipeline/assets/mockups/22-allowlist-audit-trail.svg
// Slice: .pipeline/lib/dashboard-slices.js · partialPauseAuditSlice

'use strict';

/**
 * Escape HTML — los 5 caracteres XSS-relevantes (& < > " ').
 * Idéntico a esc() del dashboard. Replicado acá para no depender del scope
 * del archivo gigante de dashboard.js.
 */
function escapeHtml(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/**
 * Helper para renderizar iconos del sprite con <use href="#ic-NAME"/>.
 * Replica el helper `ic()` del dashboard sin acoplarse a CSS-class concretas
 * más allá de `pl-ic` (consumido por design-tokens).
 */
function renderIcon(name, ariaLabel) {
    const safeName = escapeHtml(name);
    const aria = ariaLabel
        ? ` role="img" aria-label="${escapeHtml(ariaLabel)}"`
        : ' aria-hidden="true"';
    return `<svg class="pl-ic"${aria}><use href="#ic-${safeName}"/></svg>`;
}

/**
 * Mapea entry del slice → fila HTML completa.
 *
 * @param {object} e - entry del slice (visual, source, action, authorized_by, diff, ...).
 * @returns {string} <tr>...</tr>
 */
function renderRow(e) {
    const visual = e && e.visual ? String(e.visual) : 'human';

    // Estado A/B/C/D según `visual`. Cada uno tiene clase + borde + microcopy.
    const stateCls = visual === 'rejected' ? 'ppa-row-C'
        : visual === 'unauthorized' ? 'ppa-row-D'
        : visual === 'subsystem' ? 'ppa-row-B'
        : 'ppa-row-A';

    // Cuándo — HH:MM:SS local con title=ISO para tooltip.
    let whenLocal = '—';
    let whenIso = '';
    try {
        const d = e && e.timestamp ? new Date(e.timestamp) : null;
        if (d && !isNaN(d.getTime())) {
            whenIso = d.toISOString();
            whenLocal = d.toLocaleTimeString('es-AR', {
                hour: '2-digit', minute: '2-digit', second: '2-digit',
            });
        }
    } catch (_) { /* fallback "—" */ }

    // Source pill — color por origen.
    const source = escapeHtml(e && e.source || 'unknown');
    let sourcePillCls = 'ppa-pill-machine';
    if (visual === 'human') sourcePillCls = 'ppa-pill-human';
    else if (visual === 'rejected' || visual === 'unauthorized') sourcePillCls = 'ppa-pill-unknown';

    // Acción.
    const action = String(e && e.action || 'write');
    let actionPillCls = 'ppa-pill-info';
    if (action === 'reject') actionPillCls = 'ppa-pill-danger';
    else if (action === 'backfill') actionPillCls = 'ppa-pill-warning';
    else if (action === 'write') {
        actionPillCls = visual === 'unauthorized' ? 'ppa-pill-warning' : 'ppa-pill-success';
    }

    // Diff — adds verde / removes gris o rojo (si rejected).
    const diff = e && e.diff || { added: [], removed: [] };
    const added = Array.isArray(diff.added) ? diff.added : [];
    const removed = Array.isArray(diff.removed) ? diff.removed : [];
    const remCls = visual === 'rejected' ? 'ppa-diff-rem-rejected' : 'ppa-diff-rem';
    let diffHtml = '';
    if (added.length) {
        diffHtml += '<div class="ppa-diff-add">+ ['
            + added.map((n) => '#' + Number(n)).join(', ') + ']</div>';
    }
    if (removed.length) {
        const rejectedSuffix = visual === 'rejected'
            ? ' <span class="ppa-diff-rem" style="font-weight:normal;">propuesto, no aplicado</span>'
            : '';
        diffHtml += '<div class="' + remCls + '">- ['
            + removed.map((n) => '#' + Number(n)).join(', ') + ']' + rejectedSuffix + '</div>';
    }
    if (!diffHtml) diffHtml = '<span class="ppa-diff-rem">—</span>';

    // Chip de autorización por estado.
    const authBy = e && e.authorized_by;
    let authChip;
    if (visual === 'rejected') {
        authChip = '<span class="ppa-auth-pill ppa-pill-danger">'
            + renderIcon('architect-rejected', 'gate REJECTED')
            + '<span>null · gate REJECTED</span></span>';
    } else if (visual === 'unauthorized') {
        const tag = e && e.backfill ? 'null · BACKFILL' : 'null';
        authChip = '<span class="ppa-auth-pill ppa-pill-warning">'
            + renderIcon('health-warn', 'sin autoria')
            + '<span>' + escapeHtml(tag) + '</span></span>';
    } else if (visual === 'human') {
        authChip = '<span class="ppa-auth-pill ppa-pill-success">'
            + renderIcon('architect-approved', 'autorizado humano')
            + '<span>' + escapeHtml(authBy || 'commander:leo') + '</span></span>';
    } else {
        // subsystem
        authChip = '<span class="ppa-auth-pill ppa-pill-info">'
            + renderIcon('estado-partial-pause', 'autorizado subsistema')
            + '<span>' + escapeHtml(authBy || 'subsystem') + '</span></span>';
    }

    // Justificación + flag de redacción (CA-6).
    const just = String(e && e.justification || '');
    const justTruncMarker = e && e.justification_truncated ? ' …' : '';
    const justRedacted = !!(e && e.justification_redacted);
    const justCls = justRedacted ? 'ppa-just ppa-just-redacted' : 'ppa-just';
    const justHtml = just
        ? '<div class="' + justCls + '" title="'
            + escapeHtml(just + justTruncMarker) + '">'
            + escapeHtml(just) + escapeHtml(justTruncMarker) + '</div>'
        : '<span class="ppa-diff-rem">—</span>';

    // Microcopy específica por estado.
    let microcopy = '';
    if (visual === 'rejected') {
        microcopy = '<div class="ppa-microcopy ppa-microcopy-rejected">REJECTED por gate · CA-2 enum cerrado</div>';
    } else if (visual === 'unauthorized' && e && e.backfill) {
        microcopy = '<div class="ppa-microcopy ppa-microcopy-backfill">Backfill · entry preexistente al gate</div>';
    } else if (visual === 'unauthorized') {
        microcopy = '<div class="ppa-microcopy ppa-microcopy-rejected">Bypass detectado · revisar urgente</div>';
    }

    return ''
        + '<tr class="' + stateCls + '" data-visual="' + escapeHtml(visual) + '">'
        + '<td><span class="ppa-when" title="' + escapeHtml(whenIso) + '">'
        + escapeHtml(whenLocal) + '</span></td>'
        + '<td><span class="ppa-source-pill ' + sourcePillCls
        + '" title="Origen: ' + source + '"><span>' + source + '</span></span></td>'
        + '<td><span class="ppa-action-pill ' + actionPillCls
        + '"><span>' + escapeHtml(action) + '</span></span></td>'
        + '<td><div class="ppa-diff">' + diffHtml + '</div></td>'
        + '<td>' + authChip + '</td>'
        + '<td>' + justHtml + microcopy + '</td>'
        + '</tr>';
}

/**
 * Renderer principal para el `<tbody>` del widget.
 * - Sin entries → fila empty con copy explicativo.
 * - Con entries → cada una mapeada por renderRow().
 *
 * @param {Array<object>} entries
 * @returns {string} HTML del <tbody>.
 */
function renderRows(entries) {
    if (!Array.isArray(entries) || entries.length === 0) {
        return '<tr><td colspan="6" class="ppa-empty">'
            + 'Sin mutaciones registradas todavía — el audit log se hidrata cuando '
            + 'se aplica la primera mutación a <code>.partial-pause.json</code>.'
            + '</td></tr>';
    }
    return entries.map(renderRow).join('');
}

module.exports = {
    renderRows,
    // Internals expuestos para tests y para reusar desde dashboard.js si hace falta.
    _renderRow: renderRow,
    _escapeHtml: escapeHtml,
    _renderIcon: renderIcon,
};
