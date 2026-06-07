// .pipeline/views/dashboard/equipo.js — V3, extracción de la ventana "Equipo" (#3727, padre #3715).
//
// Render SSR puro de la ventana Equipo del dashboard del operador. Espejo
// estructural de views/dashboard/home.js (módulo aislado, sin estado global).
//
// El entry point único es renderEquipoSsr(state). Toda la lógica de derivados
// pesados (activeStripHTML, svcCardsHTML, skillsByCategory, skillStats) se calcula
// en dashboard.js y se pasa como input — equipo.js queda como render puro testeable.
//
// XSS (#3715 CA-B3 / CA-D1): TODO dato dinámico interpolado pasa por
// lib/escape-html. escapeHtmlText() para texto en cuerpo, escapeHtmlAttr() para
// valores de atributo (title=, href=). Los colores que van a style="" se validan
// con safeColor() (defensa CSS-injection). Los href de logs se construyen con
// whitelist de prefijo + encodeURIComponent (safeLogHref).
'use strict';

// #3722 — helper unificado de escape HTML server-side. Bloqueante para esta
// historia (CA-B3): NO replicar el escapador local. Si el require falla, que
// falle el módulo entero — dashboard.js cae al fallback visible.
const { escapeHtmlText, escapeHtmlAttr } = require('../../lib/escape-html');

// Orden de categorías para el grid de áreas (Producto → Dev → Calidad → Ops).
const CAT_ORDER = ['product', 'dev', 'quality', 'ops'];

// Persona/categoría por defecto cuando el skill no tiene entrada en el catálogo.
const FALLBACK_PERSONA = { icon: '⚙', name: '', tagline: '', color: 'var(--dim)' };

// Valida un color CSS antes de interpolarlo en style="" (defensa CSS-injection,
// riesgo MEDIO del análisis técnico de #3727). Acepta hex (#abc … #aabbccdd) o
// var(--token). Cualquier otra cosa cae a un color seguro.
const COLOR_RE = /^#[0-9a-fA-F]{3,8}$|^var\(--[a-z0-9-]+\)$/;
function safeColor(c) {
    return (typeof c === 'string' && COLOR_RE.test(c.trim())) ? c.trim() : 'var(--dim)';
}

// Construye un href seguro hacia el visor de logs. El nombre de archivo viene del
// filesystem; un atacante con write access al worktree podría renombrar logs a
// algo tipo `javascript:alert(1)`. Whitelist de prefijo + encodeURIComponent
// neutraliza el sink (el resultado nunca empieza con un esquema peligroso).
function safeLogHref(logFile, live) {
    if (!logFile) return null;
    return '/logs/view/' + encodeURIComponent(String(logFile)) + (live ? '?live=1' : '');
}

// Mini strip histórico (últimos 5 issues con color). Refactor de
// dashboard.js (skillHistoryStrip), ahora con escape de atributos y href
// whitelisted en lugar de concatenación cruda.
function skillHistoryStrip(state, skill) {
    const recentBySkill = (state && state.recentBySkill) || {};
    const recents = (recentBySkill[skill] || []).slice(0, 5);
    if (recents.length === 0) {
        return '<div class="persona-strip persona-strip-empty" title="Sin historial">—</div>';
    }
    const dots = recents.map(r => {
        const cls = r.resultado === 'aprobado' ? 'ok' : r.resultado === 'rechazado' ? 'bad' : 'live';
        const icon = r.resultado === 'aprobado' ? '✓' : r.resultado === 'rechazado' ? '✗' : '●';
        const label = (r.resultado || 'en curso') + ' #' + (r.issue != null ? r.issue : '');
        const live = !(r.resultado && r.resultado !== 'en curso');
        const href = r.hasLog ? safeLogHref(r.logFile, live) : null;
        const content = `<span class="persona-dot persona-dot-${cls}" title="${escapeHtmlAttr(label)}">${icon}</span>`;
        return href
            ? `<a href="${escapeHtmlAttr(href)}" target="_blank" rel="noopener noreferrer" onclick="event.stopPropagation()">${content}</a>`
            : content;
    }).join('');
    return `<div class="persona-strip">${dots}</div>`;
}

// Tarjeta-persona por skill. Refactor de dashboard.js (personaCard). Hoy el grid
// principal usa chips compactos (eqAreaGrid), por lo que esta función no se
// invoca desde renderEquipoSsr; se preserva como helper exportado del módulo
// (CA-A1: no perder funcionalidad) y queda testeable + correctamente escapada.
function personaCard(state, skill, load) {
    state = state || {};
    const agentPersona = state.agentPersona || {};
    const skillStats = state.skillStats || {};
    const skillUsageCount = state.skillUsageCount || {};
    load = load || { running: 0, max: 0 };
    const p = agentPersona[skill] || Object.assign({}, FALLBACK_PERSONA, { name: skill });
    const pct = load.max > 0 ? load.running / load.max : 0;
    const st = pct >= 1 ? 'full' : pct > 0 ? 'partial' : 'idle';
    const statusLabel = pct >= 1
        ? `${load.running}/${load.max} ocupado`
        : pct > 0 ? `${load.running}/${load.max} en trabajo`
            : `${load.max} libre${load.max === 1 ? '' : 's'}`;
    const stats = skillStats[skill] || { ok: 0, bad: 0, total: 0 };
    const successRate = stats.total > 0 ? Math.round((stats.ok / stats.total) * 100) : null;
    const usage = skillUsageCount[skill] || 0;
    const name = p.name || skill;
    const tagline = (p.tagline || '').split(' · ').slice(0, 2).join(' · ') || ' ';
    return `<div class="persona-card persona-${st}" style="--agent-color:${safeColor(p.color)}" title="${escapeHtmlAttr(skill + ' — ' + (p.tagline || ''))}">
      <div class="persona-head">
        <span class="persona-avatar">${escapeHtmlText(p.icon)}</span>
        <div class="persona-id">
          <div class="persona-name">${escapeHtmlText(name)}</div>
          <div class="persona-tagline">${escapeHtmlText(tagline)}</div>
        </div>
        <span class="persona-pill persona-pill-${st}">${escapeHtmlText(statusLabel)}</span>
      </div>
      <div class="persona-body">
        ${skillHistoryStrip(state, skill)}
        <div class="persona-meta">
          ${successRate !== null ? `<span class="persona-meta-item" title="Tasa de aprobacion historica">✓ ${successRate}%</span>` : ''}
          <span class="persona-meta-item persona-meta-usage" title="Issues trabajados">\u{1F4C8} ${usage}</span>
        </div>
      </div>
    </div>`;
}

// Grid de áreas 2x2 con chips compactos. Refactor de dashboard.js (eqAreaGridHTML).
// Devuelve { html, totalBusy, totalSkills } para que el header calcule utilización
// sin recorrer la lista dos veces.
function eqAreaGrid(state) {
    state = state || {};
    const skillsByCategory = state.skillsByCategory || {};
    const categoryMeta = state.categoryMeta || {};
    const agentPersona = state.agentPersona || {};
    const skillUsageCount = state.skillUsageCount || {};
    let html = '';
    let totalSkillsAll = 0, totalBusyAll = 0;
    for (const cat of CAT_ORDER) {
        const list = skillsByCategory[cat];
        if (!list || list.length === 0) continue;
        const m = categoryMeta[cat] || { label: cat, icon: '⚙', color: 'var(--dim)' };
        list.sort((a, b) => b[1].running - a[1].running || (skillUsageCount[b[0]] || 0) - (skillUsageCount[a[0]] || 0));
        // busy = skills con al menos 1 running (cuenta skills, no slots)
        const busySkills = list.filter(([, l]) => (l.running || 0) > 0).length;
        const totalSkills = list.length;
        totalBusyAll += busySkills; totalSkillsAll += totalSkills;
        const freeSkills = totalSkills - busySkills;
        const chips = list.map(([s, l]) => {
            const p = agentPersona[s] || Object.assign({}, FALLBACK_PERSONA, { name: s });
            const running = l.running || 0;
            const stateCls = running > 0 ? 'eq-chip-busy' : '';
            const countBadge = running > 1 ? `<span class="eq-chip-badge">×${running}</span>` : '';
            const usage = skillUsageCount[s] || 0;
            const tip = running > 0
                ? `${p.name} — ${running} issue${running > 1 ? 's' : ''} en ejecucion (${usage} runs)`
                : `${p.name} — libre (${usage} runs)`;
            return `<span class="eq-chip ${stateCls}" title="${escapeHtmlAttr(tip)}">
        <span class="eq-chip-avatar" style="background:${safeColor(p.color)}">${escapeHtmlText(p.icon)}</span>
        <span class="eq-chip-name">${escapeHtmlText(p.name)}</span>
        ${countBadge}
        <span class="eq-chip-dot"></span>
      </span>`;
        }).join('');
        const subTxt = busySkills > 0
            ? `<b>${freeSkills}</b>/${totalSkills} libres · <span class="eq-area-card-active">${busySkills} activo${busySkills > 1 ? 's' : ''}</span>`
            : `<b>${freeSkills}</b> libres`;
        html += `<div class="eq-area-card">
      <div class="eq-area-card-head">
        <span class="eq-area-card-name"><span class="eq-area-card-dot" style="background:${safeColor(m.color)}"></span>${escapeHtmlText(m.label)}</span>
        <span class="eq-area-card-sub">${subTxt}</span>
      </div>
      <div class="eq-area-card-chips">${chips}</div>
    </div>`;
    }
    if (html) html = '<div class="eq-areas-grid">' + html + '</div>';
    return { html, totalBusy: totalBusyAll, totalSkills: totalSkillsAll };
}

// Entry point SSR único de la ventana Equipo. `state` agrupa los derivados que
// calcula dashboard.js:
//   {
//     skillsByCategory, recentBySkill, skillUsageCount, skillStats,
//     agentPersona, categoryMeta,           // catálogos
//     pendientes,                           // tamaño de la cola
//     activeStripHTML, svcCardsHTML,        // HTML pre-renderizado (confiable)
//   }
// activeStripHTML y svcCardsHTML se inyectan tal cual (se generan en dashboard.js
// a partir de estado interno/procesos del sistema, no de input de usuario).
function renderEquipoSsr(state) {
    state = state || {};
    const pendientes = state.pendientes || 0;
    const activeStripHTML = state.activeStripHTML || '';
    const svcCardsHTML = state.svcCardsHTML || '';
    const grid = eqAreaGrid(state);
    const eqTotalBusy = grid.totalBusy;
    const eqTotalSkills = grid.totalSkills;
    const util = eqTotalSkills > 0 ? Math.round(eqTotalBusy / eqTotalSkills * 100) : 0;
    return `<div class="bar-section panel-equipo panel-equipo-full section-collapsible" id="equipo" data-section="equipo">
      <div class="eq-head">
        <h2 class="eq-title section-title-clickable" onclick="toggleSection('equipo')" title="Click para colapsar/expandir la ventana Equipo">
          <span class="section-chevron">▼</span> \u{1F9E0} Equipo
        </h2>
        <a class="section-popout" href="/?section=equipo" target="_blank" title="Abrir Equipo en ventana independiente" onclick="event.stopPropagation()">↗</a>
        <div class="eq-summary">
          <span title="Skills con al menos un agente en ejecucion sobre el total de skills">Activos <b>${eqTotalBusy}</b>/${eqTotalSkills}</span>
          <span>·</span>
          <span title="Porcentaje de skills ocupadas respecto del total">Utilizacion <b>${util}%</b></span>
          <span>·</span>
          <span title="Issues en estado pendiente esperando un agente">Cola <b>${pendientes}</b></span>
        </div>
      </div>
      <div class="section-body">
      ${activeStripHTML}
      ${grid.html || '<span class="empty-label">Sin skills configurados</span>'}
      ${svcCardsHTML ? '<div class="eq-svc-section"><div class="eq-svc-head">⚙ Servicios</div><div class="svc-grid eq-svc-grid">' + svcCardsHTML + '</div></div>' : ''}
      </div>
    </div>`;
}

module.exports = { renderEquipoSsr, eqAreaGrid, personaCard, skillHistoryStrip, safeColor, safeLogHref };
