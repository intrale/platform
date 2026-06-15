'use strict';

// =============================================================================
// components.js — EP8-H0 (#3953, épica #3952)
// -----------------------------------------------------------------------------
// Componentes SSR compartidos del dashboard V3. Mismo patrón de módulo que
// nav-tabs.js: funciones puras que devuelven HTML string + module.exports con
// API estable. Son los fundamentos (H0) que consumen las historias por-pantalla
// H1–H12 (#3954–#3965), por eso las firmas exportadas deben mantenerse estables.
//
// Reglas de seguridad (heredadas de guru/security/ux en la definición de #3953):
//   - Todo dato dinámico se escapa internamente con escapeHtmlText /
//     escapeHtmlAttr (no se delega el escape al call-site). R1.
//   - Los íconos de severidad salen SIEMPRE de una allowlist server-side
//     (SEVERITY_ICON). El href/id del <use> NUNCA se construye con input
//     externo (R4 — anti SVG/XSS injection). Una severidad desconocida cae a
//     'info', nunca refleja el valor crudo en el DOM.
//   - Severidad nunca se comunica solo por color: cada badge lleva ícono +
//     TEXTO (CA-4 / WCAG AA). El sprite ya inyecta ic-ok/ic-warn/ic-bad/ic-info
//     (mergeados a main vía PR #4024).
//
// Estilos: las clases (.status-badge, .kpi-card, .agent-pill) viven en
// theme.css (fuente canónica para los satélites). home.js conserva su copia
// inline de .kpi-card porque no carga theme.css (ver nota en theme.css).
// =============================================================================

const { escapeHtmlText, escapeHtmlAttr } = require('../../lib/escape-html.js');

// Allowlist server-side severidad → id de símbolo del sprite. Es la ÚNICA
// fuente de ids de ícono permitidos: nunca se interpola input externo en el
// atributo href del <use>.
const SEVERITY_ICON = Object.freeze({
    ok: 'ic-ok',
    warn: 'ic-warn',
    bad: 'ic-bad',
    info: 'ic-info',
});

// Severidades válidas (orden estable para tests / iteración).
const SEVERITIES = Object.freeze(['ok', 'warn', 'bad', 'info']);

// Normaliza la severidad contra la allowlist. Cualquier valor desconocido
// (incluido un payload de inyección) cae a 'info' — nunca se refleja crudo.
function normalizeSeverity(severity) {
    return Object.prototype.hasOwnProperty.call(SEVERITY_ICON, severity)
        ? severity
        : 'info';
}

// renderSeverityIcon(severity)
//   <svg> con <use href="#ic-*"> resuelto SOLO desde la allowlist. aria-hidden
//   porque el texto acompañante comunica la semántica (el ícono es decorativo).
function renderSeverityIcon(severity) {
    const sev = normalizeSeverity(severity);
    return (
        `<svg class="status-ico" aria-hidden="true" focusable="false" viewBox="0 0 24 24">` +
        `<use href="#${SEVERITY_ICON[sev]}"></use>` +
        `</svg>`
    );
}

// renderStatusBadge({ severity, label, id, title })
//   Badge de severidad con ícono + texto (CA-4). `severity` ∈ ok|warn|bad|info
//   (cualquier otro → info). `label` se escapa como texto. `id` y `title`
//   opcionales se escapan como atributo.
//
//   <span class="status-badge status-<sev>" role="status"[ id][ title]>
//     <svg class="status-ico" aria-hidden="true">…</svg>
//     <span class="status-txt">LABEL</span>
//   </span>
function renderStatusBadge(opts) {
    const o = opts || {};
    const sev = normalizeSeverity(o.severity);
    const idAttr = o.id ? ` id="${escapeHtmlAttr(o.id)}"` : '';
    const titleAttr = o.title ? ` title="${escapeHtmlAttr(o.title)}"` : '';
    return (
        `<span class="status-badge status-${sev}" role="status"${idAttr}${titleAttr}>` +
        renderSeverityIcon(sev) +
        `<span class="status-txt">${escapeHtmlText(o.label)}</span>` +
        `</span>`
    );
}

// renderKpiCard({ id, valueId, icon, label, value, sub, severity, title, extraClass })
//   Tarjeta KPI compartida (extraída de home.js, misma estructura/clases para
//   no romper el DOM morphing del cliente, que hace setText sobre `valueId` y
//   toggle de las clases kpi-ok/warn/bad sobre el contenedor `id`).
//
//   - `id`         : id invariante del contenedor (kpi-prs, kpi-tokens, …).
//   - `valueId`    : id del <span class="kpi-value"> que el cliente hidrata.
//   - `icon`       : glifo/emoji decorativo (texto, escapado).
//   - `label`      : etiqueta corta (texto, escapado).
//   - `value`      : valor inicial SSR (default '…', luego lo pisa el cliente).
//   - `sub`        : subtítulo opcional (texto, escapado).
//   - `severity`   : ok|warn|bad → agrega clase kpi-<sev> (info se ignora: el
//                    estado neutro del KPI es sin clase, igual que hoy).
//   - `title`      : tooltip nativo opcional (atributo, escapado).
//   - `extraClass` : clases extra controladas por el call-site (atributo,
//                    escapado) — p.ej. 'kpi-quota-dual'.
function renderKpiCard(opts) {
    const o = opts || {};
    const sevCls =
        o.severity === 'ok' || o.severity === 'warn' || o.severity === 'bad'
            ? ` kpi-${o.severity}`
            : '';
    const extra = o.extraClass ? ` ${escapeHtmlAttr(o.extraClass)}` : '';
    const idAttr = o.id ? ` id="${escapeHtmlAttr(o.id)}"` : '';
    const titleAttr = o.title ? ` title="${escapeHtmlAttr(o.title)}"` : '';
    const valueId = o.valueId ? ` id="${escapeHtmlAttr(o.valueId)}"` : '';
    const value = o.value === undefined || o.value === null ? '…' : o.value;

    let html = `<div class="kpi-card${sevCls}${extra}"${idAttr}${titleAttr}>`;
    if (o.icon !== undefined && o.icon !== null && o.icon !== '') {
        html += `<span class="kpi-icon" aria-hidden="true">${escapeHtmlText(o.icon)}</span>`;
    }
    html += `<span class="kpi-label">${escapeHtmlText(o.label)}</span>`;
    html += `<span class="kpi-value"${valueId}>${escapeHtmlText(value)}</span>`;
    if (o.sub !== undefined && o.sub !== null && o.sub !== '') {
        html += `<span class="kpi-sub">${escapeHtmlText(o.sub)}</span>`;
    }
    html += `</div>`;
    return html;
}

// renderAgentPill({ skill, issue, fase, severity, label, title })
//   Pill compacto de agente/skill: texto del skill + (opcional) #issue + badge
//   de severidad con ícono. Pensado para H1–H12 (Equipo, Matriz, Ops).
//
//   - `skill`    : nombre del skill (texto, escapado). Además se normaliza a una
//                  clase segura `agent-pill-skill-<norm>` para tematizar color
//                  vía CSS (NUNCA se interpola color crudo en style — anti CSS
//                  injection).
//   - `issue`    : número de issue; se coerciona a entero y solo se muestra si
//                  es > 0 (defensa: no refleja basura en el DOM).
//   - `fase`     : fase opcional (texto, escapado), se muestra como meta.
//   - `severity` : ok|warn|bad|info → badge con ícono + texto (si se da label
//                  de severidad) o punto con aria-label.
//   - `label`    : texto de estado opcional para el badge de severidad.
//   - `title`    : tooltip del pill (atributo, escapado).
//
//   La severidad NUNCA es el único canal: el pill siempre muestra el skill como
//   texto, y si lleva badge de severidad este incluye ícono (+ texto si label).
function _normalizeSkillClass(skill) {
    const norm = String(skill || '')
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '');
    return norm ? ` agent-pill-skill-${norm}` : '';
}

function renderAgentPill(opts) {
    const o = opts || {};
    const titleAttr = o.title ? ` title="${escapeHtmlAttr(o.title)}"` : '';
    let inner = `<span class="agent-pill-skill${_normalizeSkillClass(o.skill)}">${escapeHtmlText(o.skill)}</span>`;

    const issueNum = Number(o.issue);
    if (Number.isInteger(issueNum) && issueNum > 0) {
        inner += `<span class="agent-pill-issue">#${issueNum}</span>`;
    }
    if (o.fase !== undefined && o.fase !== null && o.fase !== '') {
        inner += `<span class="agent-pill-fase">${escapeHtmlText(o.fase)}</span>`;
    }
    if (o.severity !== undefined && o.severity !== null) {
        const sev = normalizeSeverity(o.severity);
        if (o.label !== undefined && o.label !== null && o.label !== '') {
            // Badge completo: ícono + texto.
            inner += renderStatusBadge({ severity: sev, label: o.label });
        } else {
            // Punto de severidad con ícono accesible (aria-label literal por sev).
            inner +=
                `<span class="agent-pill-sev status-${sev}" aria-label="severidad ${sev}">` +
                renderSeverityIcon(sev) +
                `</span>`;
        }
    }
    return `<span class="agent-pill"${titleAttr}>${inner}</span>`;
}

module.exports = {
    SEVERITY_ICON,
    SEVERITIES,
    normalizeSeverity,
    renderSeverityIcon,
    renderStatusBadge,
    renderKpiCard,
    renderAgentPill,
};
