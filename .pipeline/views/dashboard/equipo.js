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

// #3955 EP8-H2 — Formateo de duración server-side (espejo del fmtDur cliente).
// Acotado y sin dependencias para mantener equipo.js como render puro testeable.
function fmtDur(ms) {
    if (!ms || ms < 0) return '—';
    const s = Math.round(ms / 1000);
    if (s < 60) return s + 's';
    const m = Math.floor(s / 60), r = s % 60;
    if (m < 60) return m + 'm ' + r + 's';
    const h = Math.floor(m / 60), rm = m % 60;
    return h + 'h ' + rm + 'm';
}

// #3955 EP8-H2 (CA-1) — Progreso % de un agente. progreso = min(100,
// durationMs/etaMs*100); si falta etaMs → 0 (barra indeterminada, nunca NaN).
function agentProgress(durationMs, etaMs) {
    if (!etaMs || etaMs <= 0) return { pct: 0, indeterminate: true };
    return { pct: Math.min(100, Math.round((durationMs / etaMs) * 100)), indeterminate: false };
}

// #3955 EP8-H2 (CA-5) — Sparkline 24h SSR. `buckets` es number[24] (índice 0 =
// hace 23h, 23 = hora actual). Barras normalizadas al máximo del array; las
// horas recientes (últimas 6) se resaltan con la clase `eq-spark-bar-recent`.
// Dual-encoding: además del color, el title expone el conteo exacto por hora.
function skillSparkline(buckets) {
    const arr = Array.isArray(buckets) ? buckets : [];
    const max = arr.reduce((a, b) => Math.max(a, b || 0), 0);
    const total = arr.reduce((a, b) => a + (b || 0), 0);
    const bars = arr.map((v, i) => {
        const h = max > 0 ? Math.max(8, Math.round((v / max) * 100)) : 4;
        const recent = i >= arr.length - 6;
        const cls = 'eq-spark-bar' + (recent ? ' eq-spark-bar-recent' : '');
        const hoursAgo = arr.length - 1 - i;
        const label = (v || 0) + ' marker' + ((v || 0) === 1 ? '' : 's') + ' · hace ' + hoursAgo + 'h';
        return `<span class="${cls}" style="height:${h}%" title="${escapeHtmlAttr(label)}"></span>`;
    }).join('');
    return `<span class="eq-spark" title="${escapeHtmlAttr('Carga 24h: ' + total + ' markers')}" aria-label="${escapeHtmlAttr('Carga ultimas 24 horas: ' + total + ' markers')}">${bars}</span>`;
}

// #3955 EP8-H2 (CA-1) — Fila de un agente vivo dentro del acordeón. Renderiza
// issue, fase, título (escapado, SEC-5), progreso %, duración, log y la acción
// (cancelar / protegido / en espera por cooldown). El kill por agente se cablea
// vía onclick a la función global killAgent(...) que ya viaja con token CSRF.
function teamAgentRow(a) {
    a = a || {};
    const issue = String(a.issue == null ? '' : a.issue);
    const skill = String(a.skill || '');
    const fase = String(a.fase || '');
    const pipeline = String(a.pipeline || '');
    const title = String(a.title || '');
    const durationMs = a.durationMs || 0;
    const observational = a.observational === true || a.cancelable === false;
    const cooldown = a.cooldown || null;
    const prog = agentProgress(durationMs, a.etaMs);

    const issueHtml = observational
        ? `<span class="eq-ag-issue eq-ag-issue-obs">${escapeHtmlText(a.title || 'Commander')}</span>`
        : `<span class="eq-ag-issue">#${escapeHtmlText(issue)}</span>`;
    const faseHtml = `<span class="eq-ag-fase" title="${escapeHtmlAttr('Fase: ' + fase)}">${escapeHtmlText(fase)}</span>`;
    const titleHtml = observational ? '' : `<span class="eq-ag-title">${escapeHtmlText(title)}</span>`;
    const barHtml = prog.indeterminate
        ? `<span class="eq-ag-bar eq-ag-bar-indeterminate"><span></span></span><span class="eq-ag-pct">—</span>`
        : `<span class="eq-ag-bar"><span style="width:${prog.pct}%"></span></span><span class="eq-ag-pct">${prog.pct}%</span>`;
    const durHtml = `<span class="eq-ag-dur" title="Tiempo invertido">⏱ ${escapeHtmlText(fmtDur(durationMs))}</span>`;
    // #4335 — Los agentes observacionales (Commander / Sherlock) ahora exponen su
    // log de corrida cuando el slice resolvió un `<prefix>-<reqId>.log` reciente
    // dentro del TTL. Ese `.log` ya pasa por el writer sanitizado (SEC-1) y se
    // sirve por el endpoint genérico redactado, así que dejar de ocultarlo no
    // filtra secretos. Sin log fresco ⇒ `a.hasLog` es false ⇒ sin link (idéntico
    // a "sin ejecución activa no hay log fantasma").
    const logHref = a.hasLog ? safeLogHref(a.logFile, true) : null;
    const logHtml = logHref
        ? `<a class="eq-ag-log" href="${escapeHtmlAttr(logHref)}" target="_blank" rel="noopener noreferrer" title="Ver log en vivo" onclick="event.stopPropagation()">\u{1F4C4} log</a>`
        : '';

    // Acción por agente: commander/observacional → protegido; cooldown → en
    // espera (deshabilitado); resto → botón cancelar con confirmación + CSRF.
    let actionHtml;
    if (observational) {
        actionHtml = `<span class="eq-ag-protected" title="Skill no cancelable — presencia observacional">\u{1F512} protegido</span>`;
    } else if (cooldown) {
        const failures = cooldown.failures || 0;
        actionHtml = `<span class="eq-ag-cooldown" data-cooldown-until="${escapeHtmlAttr(String(cooldown.cooldownUntil || ''))}" title="${escapeHtmlAttr('Cooldown por fast-fail · ' + failures + ' fallos — re-lanzamiento bloqueado por el server')}">⏳ <span class="eq-ag-cooldown-left">cooldown</span> · ${escapeHtmlText(String(failures))} fallos</span><span class="eq-ag-wait" aria-disabled="true">en espera</span>`;
    } else {
        const onclick = `event.stopPropagation();killAgent('${escapeHtmlAttr(issue)}','${escapeHtmlAttr(skill)}','${escapeHtmlAttr(pipeline)}','${escapeHtmlAttr(fase)}',${durationMs})`;
        actionHtml = `<button class="eq-ag-kill" title="Cancelar este agente" onclick="${onclick}">✕ cancelar</button>`;
    }

    const rowCls = 'eq-ag-row' + (observational ? ' eq-ag-row-obs' : '') + (cooldown ? ' eq-ag-row-cooldown' : '');
    return `<div class="${rowCls}">
      <div class="eq-ag-head">${issueHtml}${faseHtml}${titleHtml}</div>
      <div class="eq-ag-meta">${barHtml}${durHtml}${logHtml}${actionHtml}</div>
    </div>`;
}

// #3955 EP8-H2 (CA-1/CA-3/CA-5) — Acordeón por skill. Agrupa los agentes vivos
// por skill y, por cada uno, una card colapsable (toggleSection + sessionStorage,
// patrón ya usado en el dashboard) con cabecera (avatar + nombre + N vivos +
// sparkline 24h) y una fila por agente. El Commander (observacional) se muestra
// como card especial no cancelable. `state`:
//   { teamAgents: [...activeAgents], teamSpark: {skill:[24]}, agentPersona }
function renderTeamAccordion(state) {
    state = state || {};
    const agents = Array.isArray(state.teamAgents) ? state.teamAgents : [];
    const spark = state.teamSpark || {};
    const agentPersona = state.agentPersona || {};

    // Agrupar por skill preservando el orden de llegada (activeAgents ya ordena
    // por duración desc + commander al frente).
    const order = [];
    const groups = new Map();
    for (const a of agents) {
        const skill = String(a.skill || '');
        if (!groups.has(skill)) { groups.set(skill, []); order.push(skill); }
        groups.get(skill).push(a);
    }
    if (order.length === 0) {
        return '<div class="eq-accordion eq-accordion-empty"><span class="empty-label">Sin agentes vivos</span></div>';
    }

    const cards = order.map(skill => {
        const list = groups.get(skill);
        const p = agentPersona[skill] || Object.assign({}, FALLBACK_PERSONA, { name: skill });
        const isObs = list.some(a => a.observational === true || a.cancelable === false);
        const count = list.length;
        const secId = 'eqacc-' + skill.replace(/[^a-z0-9-]/gi, '');
        const headerCls = 'eq-acc-card' + (isObs ? ' eq-acc-card-obs' : '');
        const obsBadge = isObs ? `<span class="eq-acc-obs-badge" title="Skill no cancelable">\u{1F512} skill no cancelable</span>` : '';
        const rows = list.map(teamAgentRow).join('');
        return `<div class="${headerCls}" data-skill="${escapeHtmlAttr(skill)}">
      <div class="eq-acc-head section-title-clickable" onclick="toggleSection('${escapeHtmlAttr(secId)}')" data-section="${escapeHtmlAttr(secId)}">
        <span class="section-chevron">▼</span>
        <span class="eq-acc-avatar" style="background:${safeColor(p.color)}">${escapeHtmlText(p.icon)}</span>
        <span class="eq-acc-name">${escapeHtmlText(p.name || skill)}</span>
        <span class="eq-acc-count">${count} vivo${count === 1 ? '' : 's'}</span>
        ${obsBadge}
        <span class="eq-acc-spark-wrap">${skillSparkline(spark[skill])}</span>
      </div>
      <div class="eq-acc-body" id="${escapeHtmlAttr(secId)}">${rows}</div>
    </div>`;
    }).join('');

    return `<div class="eq-accordion" id="equipo-accordion">${cards}</div>`;
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
      ${(state.teamAgents && state.teamAgents.length) ? renderTeamAccordion(state) : activeStripHTML}
      ${grid.html || '<span class="empty-label">Sin skills configurados</span>'}
      ${svcCardsHTML ? '<div class="eq-svc-section"><div class="eq-svc-head">⚙ Servicios</div><div class="svc-grid eq-svc-grid">' + svcCardsHTML + '</div></div>' : ''}
      </div>
    </div>`;
}

module.exports = {
    renderEquipoSsr, eqAreaGrid, personaCard, skillHistoryStrip, safeColor, safeLogHref,
    // #3955 EP8-H2 — acordeón por skill + helpers (exportados para test SSR).
    renderTeamAccordion, teamAgentRow, skillSparkline, agentProgress, fmtDur,
};
