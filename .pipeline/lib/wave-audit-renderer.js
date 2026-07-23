// #4371 CA-8/CA-10 — Renderer server-side de las filas del widget "Audit trail ·
// Olas & Issues" del dashboard. Convierte entries del slice `waveIssueAuditSlice`
// en HTML siguiendo la narrativa-wave-issue-audit-trail.md (estados visuales
// A/B/C/D con icono + texto — anti info-solo-por-color, WCAG 1.4.1).
//
// El módulo es PURO: no abre conexiones, no toca filesystem ni process. Todo
// dato dinámico (actor, nota, estados, prioridades, título de issue) pasa por
// `escapeHtml` antes de ir al HTML — NO repetir el patrón de XSS de #2893/#3960.
//
// Spec: .pipeline/assets/mockups/narrativa-wave-issue-audit-trail.md
// Mockup: .pipeline/assets/mockups/39-wave-issue-audit-trail.svg
// Slice: .pipeline/lib/dashboard-slices.js · waveIssueAuditSlice

'use strict';

/**
 * Escape HTML — los 5 caracteres XSS-relevantes (& < > " '). Idéntico al esc()
 * del dashboard y a audit-trail-renderer.js.
 */
function escapeHtml(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/**
 * Icono del sprite vía <use href="#ic-NAME"/>. `name` se escapa (defensa aunque
 * provenga del mapa constante de abajo).
 */
function renderIcon(name, ariaLabel) {
    const safeName = escapeHtml(name);
    const aria = ariaLabel
        ? ` role="img" aria-label="${escapeHtml(ariaLabel)}"`
        : ' aria-hidden="true"';
    return `<svg class="pl-ic"${aria}><use href="#ic-${safeName}"/></svg>`;
}

// Mapa evento → { icon, label } (narrativa CA-1..CA-4). Los dos iconos nuevos
// (`ic-issue-added`, `ic-priority-change`) los agrega el commit de assets UX al
// sprite; el resto ya existen.
const EVENT_META = Object.freeze({
    issue_added: { icon: 'issue-added', label: 'Issue agregado' },
    issue_removed: { icon: 'remove-circle', label: 'Issue quitado' },
    priority_changed: { icon: 'priority-change', label: 'Prioridad' },
    wave_promoted: { icon: 'promote', label: 'Ola promovida' },
    wave_archived: { icon: 'archive-box', label: 'Ola archivada' },
});

/**
 * Formatea un valor de estado (previo/posterior) para mostrar. Acepta strings
 * ('active'/'archived'/'planned') u objetos `{ issues: [...] }`.
 * @returns {string} texto YA escapado (seguro para HTML).
 */
function formatEstado(v) {
    if (v == null) return '—';
    if (typeof v === 'string' || typeof v === 'number') return escapeHtml(String(v));
    if (typeof v === 'object' && Array.isArray(v.issues)) {
        const list = v.issues.filter((n) => Number.isInteger(n));
        if (list.length === 0) return escapeHtml('sin issues');
        if (list.length <= 6) return escapeHtml(list.map((n) => '#' + n).join(', '));
        return escapeHtml(`${list.length} issues`);
    }
    // Cualquier otra forma: serializar de manera acotada y escapada.
    try {
        return escapeHtml(JSON.stringify(v).slice(0, 80));
    } catch (_) {
        return '—';
    }
}

/**
 * Descripción del objeto mutado (columna "Objeto"): `#issue → ola N`, `#issue`
 * o `ola N`. Todo escapado.
 */
function renderObjeto(e) {
    const hasIssue = Number.isInteger(e && e.issue);
    const hasWave = Number.isInteger(e && e.wave);
    if (hasIssue && hasWave) {
        return `<span class="wia-obj">#${Number(e.issue)} → ola ${Number(e.wave)}</span>`;
    }
    if (hasIssue) return `<span class="wia-obj">#${Number(e.issue)}</span>`;
    if (hasWave) return `<span class="wia-obj">ola ${Number(e.wave)}</span>`;
    return '<span class="wia-dim">—</span>';
}

/**
 * Mapea entry del slice → fila HTML.
 * @param {object} e - entry (visual, event, actor, timestamp, estados, note, ...).
 * @returns {string} <tr>...</tr>
 */
function renderRow(e) {
    const visual = e && e.visual ? String(e.visual) : 'human';
    const event = e && e.event ? String(e.event) : '';
    const meta = EVENT_META[event] || { icon: 'transition-history', label: event || '—' };

    // Estado A/B/C/D → clase de fila.
    const stateCls = visual === 'unauthorized' ? 'wia-row-C'
        : visual === 'priority' ? 'wia-row-D'
        : visual === 'subsystem' ? 'wia-row-B'
        : 'wia-row-A';

    // Cuándo — HH:MM:SS local es-AR + title ISO.
    let whenLocal = '—';
    let whenIso = '';
    try {
        const d = e && e.timestamp ? new Date(e.timestamp) : null;
        if (d && !isNaN(d.getTime())) {
            whenIso = d.toISOString();
            whenLocal = d.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        }
    } catch (_) { /* fallback "—" */ }

    // Actor chip por estado.
    const actor = e && e.actor ? String(e.actor) : 'desconocido';
    let actorPillCls; let actorIcon; let actorAria;
    if (visual === 'unauthorized') {
        actorPillCls = 'wia-pill-unknown'; actorIcon = 'health-warn'; actorAria = 'sin autoría';
    } else if (visual === 'subsystem') {
        actorPillCls = 'wia-pill-machine'; actorIcon = 'estado-partial-pause'; actorAria = 'subsistema';
    } else {
        actorPillCls = 'wia-pill-human'; actorIcon = 'architect-approved'; actorAria = 'humano';
    }
    const actorText = visual === 'unauthorized' ? 'null · sin autoría' : actor;
    const actorChip = '<span class="wia-actor-pill ' + actorPillCls + '">'
        + renderIcon(actorIcon, actorAria)
        + '<span>' + escapeHtml(actorText) + '</span></span>';

    // Evento (icono + texto).
    const eventHtml = '<span class="wia-event">' + renderIcon(meta.icon, meta.label)
        + '<span>' + escapeHtml(meta.label) + '</span></span>';

    // Previo → Posterior. Para priority_changed usa las prioridades; si no, estados.
    let prevHtml; let postHtml;
    if (event === 'priority_changed') {
        prevHtml = e && e.prioridad_previa ? escapeHtml(String(e.prioridad_previa)) : '—';
        postHtml = e && e.prioridad_nueva ? escapeHtml(String(e.prioridad_nueva)) : '—';
    } else {
        prevHtml = formatEstado(e && e.estado_previo);
        postHtml = formatEstado(e && e.estado_posterior);
    }
    const transHtml = '<span class="wia-trans"><span class="wia-prev">' + prevHtml
        + '</span> → <span class="wia-post">' + postHtml + '</span></span>';

    // Nota (redactada aguas arriba por wave-audit) — truncada a ~50 chars con tooltip.
    const note = String(e && e.note || '');
    let noteHtml;
    if (note) {
        const short = note.length > 50 ? note.slice(0, 50) + '…' : note;
        noteHtml = '<span class="wia-note" title="' + escapeHtml(note) + '">' + escapeHtml(short) + '</span>';
    } else {
        noteHtml = '<span class="wia-dim">—</span>';
    }

    // Microcopy de alerta para estado C.
    let microcopy = '';
    if (visual === 'unauthorized') {
        microcopy = '<div class="wia-microcopy wia-microcopy-alert">Bypass detectado — revisar urgente</div>';
    }

    return ''
        + '<tr class="' + stateCls + '" data-visual="' + escapeHtml(visual) + '" data-event="' + escapeHtml(event) + '">'
        + '<td><span class="wia-when" title="' + escapeHtml(whenIso) + '">' + escapeHtml(whenLocal) + '</span></td>'
        + '<td>' + actorChip + '</td>'
        + '<td>' + eventHtml + '</td>'
        + '<td>' + renderObjeto(e) + '</td>'
        + '<td>' + transHtml + '</td>'
        + '<td>' + noteHtml + microcopy + '</td>'
        + '</tr>';
}

/**
 * Renderer del <tbody>. Sin entries → fila empty explicativa.
 * @param {Array<object>} entries
 * @returns {string}
 */
function renderRows(entries) {
    if (!Array.isArray(entries) || entries.length === 0) {
        return '<tr><td colspan="6" class="wia-empty">'
            + 'Sin movimientos registrados todavía — el audit trail se hidrata cuando '
            + 'se agrega/quita un issue de una ola, cambia una prioridad o se '
            + 'promueve/archiva una ola.'
            + '</td></tr>';
    }
    return entries.map(renderRow).join('');
}

module.exports = {
    renderRows,
    EVENT_META,
    // Internals expuestos para tests.
    _renderRow: renderRow,
    _escapeHtml: escapeHtml,
    _renderIcon: renderIcon,
    _formatEstado: formatEstado,
    _renderObjeto: renderObjeto,
};
