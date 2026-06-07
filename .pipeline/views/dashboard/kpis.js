// =============================================================================
// kpis.js — Vista SSR de la ventana KPIs del dashboard V3 (`/dashboard?view=kpis`).
//
// Issue: #3733 (split de #3715 — extracción de la ventana KPIs del monolito
// dashboard.js + reincorporación del link visual a /metrics).
//
// Estructura (decisiones cerradas del issue):
//   - renderKpis(opts)             → ventana `?view=kpis` (shell satélite + KPIs).
//   - renderKpiCardsHTML(...)      → fila de KPI cards (reusable home ↔ ventana).
//   - renderDoraAndCommanderHTML() → cards DORA + Commander Routing (reusable).
//   - renderMetricsPage({data})    → página legacy /metrics (body de
//                                    generateMetricsHTML portado + XSS hardening).
//   - renderInert(reason)          → panel visible cuando require()/state fallan
//                                    (CA-A3 del épico — el render nunca queda en blanco).
//
// Seguridad (security analysis del issue):
//   - TODA interpolación dinámica pasa por escapeHtmlText/escapeHtmlAttr de
//     lib/escape-html.js (#3722). Cubre nombres de skill, provider, fase,
//     session IDs, números forzados a string. Test XSS canónico cubre ≥4
//     payloads sobre cada KPI dinámico (kpis.test.js).
//   - Ventana 100% READ-ONLY (decisión D-UX-1): sin <form>, sin method=POST,
//     sin <button onclick> que dispare backend. Los KPIs "clickeables"
//     (Bloqueados / Necesitan humano) son links de navegación a otras vistas,
//     NO acciones state-changing (mitiga R12).
//   - Session IDs SIEMPRE pasan por `safeSessionId` antes de interpolar
//     (defense in depth sobre el truncado del slice, CA-17).
//
// Convención V3: HTML inicial con IDs estables; el cliente hidrata vía fetch
// JSON (`/api/dash/kpis`) + DOM morphing. El SSR provee el contenido inicial
// para que un deep-link directo no quede en blanco antes del JS.
// =============================================================================
'use strict';

const fs = require('node:fs');
const path = require('node:path');

// #3722 — Escape unificado server-side. escapeHtmlText para nodos texto,
// escapeHtmlAttr para contexto atributo (title="", aria-label="").
const { escapeHtmlText, escapeHtmlAttr } = require('../../lib/escape-html.js');

// #3726 — Nav bar V3 unificada (tab activa = "kpis").
const { renderNavTabsSsr, loadIconSprite } = require('./nav-tabs');

const THEME_CSS_PATH = path.join(__dirname, 'theme.css');
function loadTheme() {
    try { return fs.readFileSync(THEME_CSS_PATH, 'utf8'); } catch { return ''; }
}

// Compat: el patrón de las otras vistas exportaba `escapeHtmlSsr` inline.
// Ahora delega en el helper compartido (#3722). Se mantiene exportado para
// quien lo consuma desde tests u otras vistas durante la transición.
function escapeHtmlSsr(s) {
    return escapeHtmlText(s);
}

// CA-17 — coerción defensiva. Se toma el prefijo alfanumérico del session ID
// (corta en el primer caracter no alfanumérico) y se acota a 8 chars ANTES de
// renderear, incluso si el slice ya lo truncó. Defense in depth: cualquier
// intento de breakout (`";alert(1);//`) queda en string vacío o ASCII-safe.
// Ej: 'abcdefghijklmnop' → 'abcdefgh'; 'abc;rm -rf' → 'abc'.
function safeSessionId(s) {
    const m = String(s == null ? '' : s).match(/^[A-Za-z0-9]+/);
    return (m ? m[0] : '').slice(0, 8);
}

// Formateo de duración tolerante: number → "1h 2m" / "45m" / "30s"; cualquier
// otra cosa → "—" (no rompe el render con NaN ni inyección por coerción).
function fmtDuration(ms) {
    const n = Number(ms);
    if (!Number.isFinite(n) || n <= 0) return '—';
    const totalSec = Math.floor(n / 1000);
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    if (h >= 1) return h + 'h ' + m + 'm';
    const s = totalSec % 60;
    if (m >= 1) return m + 'm ' + s + 's';
    return s + 's';
}

// Número entero seguro para display ("—" si no es finito).
function fmtNum(v) {
    const n = Number(v);
    return Number.isFinite(n) ? String(n) : '—';
}

// =============================================================================
// CSS — extraído del bloque global de dashboard.js (.kpis-row/.kpi/...) y
// adaptado a los tokens del theme V3. Exportado (decisión cerrada #7) para
// inyectarlo desde la ventana KPIs sin tocar theme.css compartido (minimiza
// conflictos de merge con las otras hijas #3727..#3737).
// =============================================================================
const KPIS_CSS = `
.satellite-frame { max-width: 1600px; margin: 0 auto; padding: 0; }
.satellite-body { padding: 22px 28px; display: flex; flex-direction: column; gap: 18px; }

.kpis-row { display: grid; grid-template-columns: repeat(6, 1fr); gap: 12px; }
@media (max-width: 1100px) { .kpis-row { grid-template-columns: repeat(3, 1fr); } }
@media (max-width: 640px)  { .kpis-row { grid-template-columns: repeat(2, 1fr); } }
.kpi {
    position: relative;
    background: var(--in-bg-2, #161b22);
    border: 1px solid var(--in-border, #30363d);
    border-radius: var(--in-radius, 10px);
    padding: 16px 14px;
    display: flex; flex-direction: column; gap: 4px;
    text-decoration: none; color: inherit;
}
.kpi-value { font-size: 30px; font-weight: 800; font-variant-numeric: tabular-nums; color: var(--in-fg, #e6edf3); line-height: 1.1; }
.kpi-label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.6px; color: var(--in-fg-dim, #8b949e); }
.kpi-sub { font-size: 11px; color: var(--in-fg-soft, #6e7681); }
.kpi-trend { font-size: 11px; font-weight: 600; }
.kpi-trend.up { color: var(--in-ok, #3fb950); }
.kpi-trend.down { color: var(--in-bad, #f85149); }
.kpi-needs-human { border-color: var(--in-warn, #d29922); }
.kpi-needs-human .kpi-value { color: var(--in-warn, #d29922); }
.kpi-blocked { border-color: var(--in-bad, #f85149); }
.kpi-blocked .kpi-value { color: var(--in-bad, #f85149); }
a.kpi:hover { border-color: var(--in-accent, #58a6ff); }

/* Tooltip operativo (CA-C1) — texto estático, nunca input del usuario. */
.kpi-tooltip {
    display: inline-flex; align-items: center; justify-content: center;
    width: 15px; height: 15px; margin-left: 6px;
    border-radius: 50%; border: 1px solid var(--in-border, #30363d);
    color: var(--in-fg-dim, #8b949e); font-size: 10px; font-weight: 700;
    cursor: help; position: relative;
}
.kpi-tooltip::after {
    content: attr(data-tip);
    position: absolute; bottom: calc(100% + 6px); left: 50%; transform: translateX(-50%);
    background: var(--in-bg, #0d1117); color: var(--in-fg, #e6edf3);
    border: 1px solid var(--in-border, #30363d); border-radius: 6px;
    padding: 6px 9px; font-size: 11px; font-weight: 400; white-space: normal;
    width: max-content; max-width: 240px; text-align: left;
    opacity: 0; pointer-events: none; transition: opacity 0.12s; z-index: 50;
}
.kpi-tooltip:hover::after, .kpi-tooltip:focus::after { opacity: 1; }

.kpis-section { background: var(--in-bg-2, #161b22); border: 1px solid var(--in-border, #30363d); border-radius: var(--in-radius, 10px); padding: 18px 20px; }
.kpis-section h2 { font-size: 14px; margin: 0 0 12px; display: flex; align-items: center; gap: 6px; color: var(--in-fg, #e6edf3); }

.dora-mini-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 14px; }
@media (max-width: 700px) { .dora-mini-grid { grid-template-columns: repeat(2, 1fr); } }
.dora-mini-card { background: var(--in-bg-3, #1c2128); border: 1px solid var(--in-border, #30363d); border-radius: 8px; padding: 14px; }
.dora-mini-value { font-size: 24px; font-weight: 800; font-variant-numeric: tabular-nums; line-height: 1.1; color: var(--in-fg, #e6edf3); }
.dora-mini-label { color: var(--in-fg-dim, #8b949e); font-size: 11px; font-weight: 600; margin-top: 4px; text-transform: uppercase; letter-spacing: 0.5px; }
.dora-mini-target { font-size: 10px; color: var(--in-fg-soft, #6e7681); margin-top: 4px; }

.kpis-prov-table { width: 100%; border-collapse: collapse; font-size: 12px; }
.kpis-prov-table th, .kpis-prov-table td { padding: 6px 10px; border-bottom: 1px solid var(--in-border, #30363d); text-align: left; }
.kpis-prov-table th { color: var(--in-fg-dim, #8b949e); font-weight: 600; font-size: 11px; text-transform: uppercase; }
.kpis-prov-empty, .kpis-sessions-empty { color: var(--in-fg-dim, #8b949e); font-size: 12px; }

.kpis-metrics-cta {
    display: inline-flex; align-items: center; gap: 8px;
    min-height: 44px; padding: 0 16px;
    background: var(--in-accent, #58a6ff); color: #fff; text-decoration: none;
    border-radius: 8px; font-size: 13px; font-weight: 600;
}
.kpis-metrics-cta:hover { filter: brightness(1.08); }
`;

// =============================================================================
// Bloques reusables (decisión cerrada #2 — una sola fuente de HTML compartida
// entre el home y la ventana `?view=kpis`).
// =============================================================================

/**
 * Fila de KPI cards (class="kpis-row"). Consumidor puro: NO computa los
 * números (el home es el único productor — R2). Defensivo ante opts ausente.
 *
 * @param {object} matrixDerived — { definidos, pendientes, trabajando, blockedCount, needsHuman }
 * @param {object} sysMini       — { cpu, mem, health }
 */
function renderKpiCardsHTML(matrixDerived, sysMini) {
    const m = matrixDerived || {};
    const sys = sysMini || {};
    const cards = [
        { label: 'Definidos', value: fmtNum(m.definidos), sub: 'criterios listos', tip: 'Issues con criterios de aceptación definidos, esperando desarrollo.' },
        { label: 'Pendientes', value: fmtNum(m.pendientes), sub: 'en cola', tip: 'Trabajo encolado esperando un slot de agente.' },
        { label: 'Trabajando', value: fmtNum(m.trabajando), sub: 'agentes activos', tip: 'Archivos de trabajo tomados por un agente en este momento.' },
    ];
    let html = '<div class="kpis-row">';
    for (const c of cards) {
        html += `<div class="kpi">`
            + `<span class="kpi-value">${escapeHtmlText(c.value)}</span>`
            + `<span class="kpi-label">${escapeHtmlText(c.label)}`
            + `<span class="kpi-tooltip" tabindex="0" role="img" aria-label="${escapeHtmlAttr(c.tip)}" data-tip="${escapeHtmlAttr(c.tip)}">i</span>`
            + `</span>`
            + `<span class="kpi-sub">${escapeHtmlText(c.sub)}</span>`
            + `</div>`;
    }
    // KPIs "clickeables": links de navegación (read-only), NO acciones backend (R12).
    const blockedTip = 'Issues bloqueados esperando una dependencia o intervención.';
    html += `<a class="kpi kpi-blocked" href="/bloqueados">`
        + `<span class="kpi-value">${escapeHtmlText(fmtNum(m.blockedCount))}</span>`
        + `<span class="kpi-label">Bloqueados`
        + `<span class="kpi-tooltip" tabindex="0" role="img" aria-label="${escapeHtmlAttr(blockedTip)}" data-tip="${escapeHtmlAttr(blockedTip)}">i</span>`
        + `</span><span class="kpi-sub">ver detalle</span></a>`;
    const nhTip = 'Issues que requieren decisión humana (circuit breaker / needs-human).';
    html += `<a class="kpi kpi-needs-human" href="/bloqueados">`
        + `<span class="kpi-value">${escapeHtmlText(fmtNum(m.needsHuman))}</span>`
        + `<span class="kpi-label">Necesitan humano`
        + `<span class="kpi-tooltip" tabindex="0" role="img" aria-label="${escapeHtmlAttr(nhTip)}" data-tip="${escapeHtmlAttr(nhTip)}">i</span>`
        + `</span><span class="kpi-sub">ver detalle</span></a>`;
    // Mini-card de salud del sistema (CPU/RAM).
    const sysTip = 'CPU y RAM del host del Pulpo. Salud agregada del sistema.';
    html += `<div class="kpi">`
        + `<span class="kpi-value">${escapeHtmlText(fmtNum(sys.cpu))}%</span>`
        + `<span class="kpi-label">Sistema`
        + `<span class="kpi-tooltip" tabindex="0" role="img" aria-label="${escapeHtmlAttr(sysTip)}" data-tip="${escapeHtmlAttr(sysTip)}">i</span>`
        + `</span>`
        + `<span class="kpi-sub">RAM ${escapeHtmlText(fmtNum(sys.mem))}% · ${escapeHtmlText(String(sys.health || '—'))}</span>`
        + `</div>`;
    html += '</div>';
    return html;
}

/**
 * Cards DORA + Commander Routing. Consumidor puro: recibe los valores ya
 * computados vía opts y degrada a "—" cuando faltan. Toda interpolación
 * (incluidos números forzados a string) pasa por escapeHtmlText — defensa
 * contra coerción maliciosa en routingMetrics (CA-14.d).
 *
 * @param {object} opts — { kpisSlice, routingMetrics }
 */
function renderDoraAndCommanderHTML(opts) {
    const o = opts || {};
    const k = o.kpisSlice || {};
    const routing = o.routingMetrics || {};
    const today = routing.today || {};
    const bounceOverall = (k.bouncePct && typeof k.bouncePct.overall !== 'undefined') ? k.bouncePct.overall : null;

    const dora = `<div class="kpis-section"><h2>📐 DORA adaptado <span class="kpi-tooltip" tabindex="0" role="img" aria-label="Métricas DORA adaptadas al pipeline de agentes (Forsgren · Accelerate)." data-tip="Métricas DORA adaptadas al pipeline de agentes (Forsgren · Accelerate).">i</span></h2>`
        + `<div class="dora-mini-grid">`
        + `<div class="dora-mini-card"><div class="dora-mini-value">${escapeHtmlText(fmtDuration(k.issueCycleTimeMs))}</div><div class="dora-mini-label">Cycle Time</div><div class="dora-mini-target">creación → cierre</div></div>`
        + `<div class="dora-mini-card"><div class="dora-mini-value">${escapeHtmlText(fmtDuration(k.agentDurationMedianMs))}</div><div class="dora-mini-label">Duración agente (mediana)</div><div class="dora-mini-target">por fase/skill</div></div>`
        + `<div class="dora-mini-card"><div class="dora-mini-value">${escapeHtmlText(bounceOverall == null ? '—' : fmtNum(bounceOverall) + '%')}</div><div class="dora-mini-label">Tasa de rebote</div><div class="dora-mini-target">target &lt; 15%</div></div>`
        + `<div class="dora-mini-card"><div class="dora-mini-value">${escapeHtmlText(fmtNum(k.prsLast7d))}</div><div class="dora-mini-label">PRs 7d</div><div class="dora-mini-target">throughput</div></div>`
        + `</div></div>`;

    const commander = `<div class="kpis-section"><h2>⚙️ Commander Routing <span class="kpi-tooltip" tabindex="0" role="img" aria-label="Comandos resueltos de forma determinística vs vía LLM (hoy)." data-tip="Comandos resueltos de forma determinística vs vía LLM (hoy).">i</span></h2>`
        + `<div class="dora-mini-grid">`
        + `<div class="dora-mini-card"><div class="dora-mini-value">${escapeHtmlText(fmtNum(today.percentDeterministic))}%</div><div class="dora-mini-label">% Determinístico hoy</div><div class="dora-mini-target">target &gt; 60%</div></div>`
        + `<div class="dora-mini-card"><div class="dora-mini-value">${escapeHtmlText(String(today.deterministic == null ? '—' : today.deterministic))}</div><div class="dora-mini-label">Sin LLM hoy</div><div class="dora-mini-target">comandos resueltos</div></div>`
        + `<div class="dora-mini-card"><div class="dora-mini-value">${escapeHtmlText(String(today.llm == null ? '—' : today.llm))}</div><div class="dora-mini-label">Con LLM hoy</div><div class="dora-mini-target">${escapeHtmlText(String(today.unknown == null ? '0' : today.unknown))} no clasificados</div></div>`
        + `<div class="dora-mini-card"><div class="dora-mini-value">${escapeHtmlText(fmtNum(today.total))}</div><div class="dora-mini-label">Total hoy</div><div class="dora-mini-target">comandos</div></div>`
        + `</div></div>`;

    return dora + commander;
}

/**
 * Tabla de KPIs por provider (CA-19: SOLO metadata operativa — tokens 24h.
 * NUNCA API keys). Los nombres de provider (keys del objeto) pueden ser texto
 * libre del operador vía config → escapados sí o sí (R8).
 */
function renderProvidersHTML(kpisSlice) {
    const k = kpisSlice || {};
    const byProvider = (k.tokens24h && k.tokens24h.by_provider && typeof k.tokens24h.by_provider === 'object')
        ? k.tokens24h.by_provider : null;
    let body = '';
    if (byProvider) {
        for (const [prov, tokens] of Object.entries(byProvider)) {
            body += `<tr><td>${escapeHtmlText(prov)}</td><td>${escapeHtmlText(fmtNum(tokens))}</td></tr>`;
        }
    }
    const tip = 'Tokens consumidos por proveedor en las últimas 24h. No expone API keys (ver ventana Providers).';
    return `<div class="kpis-section"><h2>🤖 Tokens por proveedor (24h) `
        + `<span class="kpi-tooltip" tabindex="0" role="img" aria-label="${escapeHtmlAttr(tip)}" data-tip="${escapeHtmlAttr(tip)}">i</span></h2>`
        + (body
            ? `<table class="kpis-prov-table"><thead><tr><th>Proveedor</th><th>Tokens 24h</th></tr></thead><tbody>${body}</tbody></table>`
            : `<p class="kpis-prov-empty">Sin datos de tokens por proveedor en las últimas 24h.</p>`)
        + `<!-- TODO(#3737): mover KPIs de proveedor a la ventana providers cuando aterrice. -->`
        + `</div>`;
}

/**
 * Resumen compacto de rendimiento por agente (skill). Los nombres de skill
 * vienen de loadConfig() / del filesystem → escapados (R8, CA-14.b). Lista las
 * top sesiones por consumo con session ID coercionado (CA-14.c / CA-17).
 */
function renderAgentPerfHTML(metricsSlice) {
    const data = metricsSlice || {};
    const perf = data.agentPerf || {};
    const entries = Object.entries(perf).sort((a, b) => (b[1].issues || 0) - (a[1].issues || 0)).slice(0, 12);
    let perfRows = '';
    for (const [skill, a] of entries) {
        const fail = (a.issues > 0) ? Math.round((a.rejected || 0) / a.issues * 100) : 0;
        perfRows += `<tr><td>${escapeHtmlText(skill)}</td><td>${escapeHtmlText(fmtNum(a.issues))}</td><td>${escapeHtmlText(String(fail))}%</td></tr>`;
    }

    const sessions = (data.tokenEstimates && Array.isArray(data.tokenEstimates.bySession))
        ? data.tokenEstimates.bySession.slice().sort((x, y) => (y.tokens || 0) - (x.tokens || 0)).slice(0, 10)
        : [];
    let sessRows = '';
    for (const s of sessions) {
        sessRows += `<tr><td>${escapeHtmlText(safeSessionId(s.id))}</td><td>${escapeHtmlText(fmtNum(s.tools))}</td><td>${escapeHtmlText(fmtNum(Math.round((s.tokens || 0) / 1000)))}K</td></tr>`;
    }

    const tipPerf = 'Issues procesados por skill y % de rechazo (rebotes).';
    return `<div class="kpis-section"><h2>🧩 Rendimiento por agente `
        + `<span class="kpi-tooltip" tabindex="0" role="img" aria-label="${escapeHtmlAttr(tipPerf)}" data-tip="${escapeHtmlAttr(tipPerf)}">i</span></h2>`
        + (perfRows
            ? `<table class="kpis-prov-table"><thead><tr><th>Skill</th><th>Issues</th><th>Rechazo</th></tr></thead><tbody>${perfRows}</tbody></table>`
            : `<p class="kpis-prov-empty">Sin datos de rendimiento por agente.</p>`)
        + (sessRows
            ? `<h2 style="margin-top:16px">🪙 Top sesiones por consumo estimado</h2>`
              + `<table class="kpis-prov-table"><thead><tr><th>Sesión</th><th>Tools</th><th>Tokens est.</th></tr></thead><tbody>${sessRows}</tbody></table>`
            : `<p class="kpis-sessions-empty" style="margin-top:12px">Sin sesiones registradas.</p>`)
        + `</div>`;
}

/**
 * CTA hacia el endpoint legacy /metrics (R10 / CA-9 — recupera el link visual
 * perdido, memoria project_metrics-endpoint-lost). Touch target ≥ 44px (CA-23).
 */
function renderMetricsCta() {
    const tip = 'Abre la página de métricas históricas (CPU/RAM, DORA, sesiones).';
    return `<div class="kpis-section"><h2>📊 Métricas históricas</h2>`
        + `<p class="kpi-sub" style="margin-bottom:10px">El endpoint <code>/metrics</code> mantiene la vista detallada de series temporales y rendimiento.</p>`
        + `<a class="kpis-metrics-cta" href="/metrics" aria-label="${escapeHtmlAttr(tip)}">Ver métricas históricas →</a>`
        + `</div>`;
}

// =============================================================================
// Render principal de la ventana `?view=kpis`.
// =============================================================================
/**
 * @param {object} [opts] — { kpisSlice, metricsSlice, matrixDerived, sysMini,
 *                            routingMetrics, currentView }. Todo opcional: el
 *                            router lo invoca solo con { currentView } y el SSR
 *                            degrada a placeholders que el cliente hidrata.
 */
function renderKpis(opts) {
    const o = opts || {};
    const theme = loadTheme();
    const spriteInline = loadIconSprite();
    const navHtml = renderNavTabsSsr('kpis');

    const body = `<main class="satellite-body" id="kpis-body">`
        + renderKpiCardsHTML(o.matrixDerived, o.sysMini)
        + renderDoraAndCommanderHTML({ kpisSlice: o.kpisSlice, routingMetrics: o.routingMetrics })
        + renderProvidersHTML(o.kpisSlice)
        + renderAgentPerfHTML(o.metricsSlice)
        + renderMetricsCta()
        + `</main>`;

    return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Intrale · KPIs</title>
<style>${theme}</style>
<style>${KPIS_CSS}</style>
</head>
<body>
<div aria-hidden="true" style="position:absolute;width:0;height:0;overflow:hidden">${spriteInline}</div>
<div class="satellite-frame">
  <header class="in-header">
    <div class="in-header-brand">
      <div class="in-header-logo">i</div>
      <div>
        <div class="in-header-title">KPIs</div>
        <div class="in-header-subtitle">Indicadores del pipeline · DORA · routing · consumo</div>
      </div>
    </div>
    <div class="in-header-meta">
      <span class="in-clock" id="hdr-clock">${escapeHtmlText(new Date().toLocaleTimeString('es-AR'))}</span>
    </div>
  </header>
  ${navHtml}
  ${body}
  <footer class="in-footer">
    <span>Vista read-only · datos en vivo cada 30s</span>
    <span>Intrale V3 · #3733</span>
  </footer>
</div>
</body>
</html>`;
}

/**
 * Página legacy /metrics. Body portado de `dashboard.js::generateMetricsHTML()`
 * con XSS hardening: los nombres de skill y session IDs ahora pasan por
 * escapeHtmlText/safeSessionId (antes se interpolaban crudos). El resto del
 * markup es idéntico para no romper bookmarks ni scripts externos (decisión
 * cerrada #3 — /metrics se MANTIENE).
 *
 * @param {object} opts — { data } donde data es el retorno de getMetricsSlice.
 */
function renderMetricsPage(opts) {
    const o = opts || {};
    const data = o.data || {};
    const snapshots = Array.isArray(data.snapshots) ? data.snapshots : [];
    const etaAverages = data.etaAverages || {};
    const entregas = Array.isArray(data.entregas) ? data.entregas : [];
    const tokenEstimates = data.tokenEstimates || { totalSessions: 0, totalTools: 0, totalEstimatedTokens: 0, bySession: [] };
    const totalProcessed = data.totalProcessed || 0;
    const totalRejected = data.totalRejected || 0;
    const agentPerf = data.agentPerf || {};

    const now = Date.now();
    const snap1h = snapshots.filter(s => now - s.ts < 3600000);
    const snap6h = snapshots.filter(s => now - s.ts < 21600000);
    const snap24h = snapshots;

    const avgCpu = (arr) => arr.length ? Math.round(arr.reduce((a, s) => a + s.cpu, 0) / arr.length) : 0;
    const avgMem = (arr) => arr.length ? Math.round(arr.reduce((a, s) => a + s.mem, 0) / arr.length) : 0;
    const maxCpu = (arr) => arr.length ? Math.max(...arr.map(s => s.cpu)) : 0;
    const maxMem = (arr) => arr.length ? Math.max(...arr.map(s => s.mem)) : 0;
    const avgAgents = (arr) => arr.length ? (arr.reduce((a, s) => a + s.agents, 0) / arr.length).toFixed(1) : 0;

    const delivered24h = entregas.filter(e => now - e.ts < 86400000).length;
    const delivered7d = entregas.length;

    const levelCounts = { green: 0, yellow: 0, orange: 0, red: 0 };
    for (const s of snap24h) levelCounts[s.level] = (levelCounts[s.level] || 0) + 1;
    const totalSnaps = snap24h.length || 1;
    const levelPct = {};
    for (const [l, c] of Object.entries(levelCounts)) levelPct[l] = Math.round(c / totalSnaps * 100);

    const reboteRate = totalProcessed > 0 ? Math.round(totalRejected / totalProcessed * 100) : 0;
    const tokM = (tokenEstimates.totalEstimatedTokens / 1000000).toFixed(1);
    const costEst = (tokenEstimates.totalEstimatedTokens / 1000000 * 3).toFixed(2);

    const sparkData = snap1h.length > 2 ? snap1h.slice(-60) : snapshots.slice(-120);
    const cpuSpark = sparkData.map(s => s.cpu);
    const memSpark = sparkData.map(s => s.mem);
    const agentSpark = sparkData.map(s => s.agents);

    function sparkline(values, max, color) {
        if (values.length < 2) return '<span class="dim">sin datos</span>';
        const w = 300, h = 40;
        const step = w / (values.length - 1);
        const points = values.map((v, i) => `${(i * step).toFixed(1)},${(h - (v / max * h)).toFixed(1)}`).join(' ');
        return `<svg width="${w}" height="${h}" class="sparkline"><polyline points="${points}" fill="none" stroke="${color}" stroke-width="1.5"/></svg>`;
    }

    function chart(values, max, color, label, unit, thresholds) {
        if (values.length < 2) return '<div class="dim" style="padding:20px">Sin datos suficientes. El Pulpo genera snapshots cada 30s cuando corre.</div>';
        const w = 800, h = 160, pad = 40;
        const pw = w - pad * 2, ph = h - pad;
        const step = pw / (values.length - 1);
        const points = values.map((v, i) => `${(pad + i * step).toFixed(1)},${(h - pad - (v / max * ph)).toFixed(1)}`).join(' ');
        const areaPoints = `${pad},${h - pad} ${points} ${(pad + (values.length - 1) * step).toFixed(1)},${h - pad}`;
        const yLabels = [0, 25, 50, 75, 100].map(v => {
            const y = h - pad - (v / max * ph);
            return `<text x="${pad - 5}" y="${y + 4}" text-anchor="end" fill="#8b949e" font-size="10">${v}${unit}</text><line x1="${pad}" y1="${y}" x2="${w - pad}" y2="${y}" stroke="#21262d" stroke-width="0.5"/>`;
        }).join('');
        const tsFirst = sparkData[0]?.ts;
        const tsLast = sparkData[sparkData.length - 1]?.ts;
        const fmtTs = (ts) => ts ? new Date(ts).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' }) : '';
        const xLabels = tsFirst ? `<text x="${pad}" y="${h - 5}" fill="#8b949e" font-size="10">${fmtTs(tsFirst)}</text><text x="${w - pad}" y="${h - 5}" text-anchor="end" fill="#8b949e" font-size="10">${fmtTs(tsLast)}</text>` : '';
        let thresholdLines = '';
        if (thresholds) {
            for (const [val, col] of thresholds) {
                const y = h - pad - (val / max * ph);
                thresholdLines += `<line x1="${pad}" y1="${y}" x2="${w - pad}" y2="${y}" stroke="${col}" stroke-width="1" stroke-dasharray="4,4" opacity="0.5"/>`;
            }
        }
        const avg = values.reduce((a, b) => a + b, 0) / values.length;
        const avgY = h - pad - (avg / max * ph);
        return `<svg viewBox="0 0 ${w} ${h}" class="chart">
      ${yLabels}${xLabels}${thresholdLines}
      <polygon points="${areaPoints}" fill="${color}" opacity="0.1"/>
      <polyline points="${points}" fill="none" stroke="${color}" stroke-width="2"/>
      <line x1="${pad}" y1="${avgY}" x2="${w - pad}" y2="${avgY}" stroke="${color}" stroke-width="1" stroke-dasharray="2,4" opacity="0.6"/>
      <text x="${w - pad + 5}" y="${avgY + 4}" fill="${color}" font-size="10">avg ${avg.toFixed(0)}${unit}</text>
      <text x="${pad}" y="14" fill="#e6edf3" font-size="12" font-weight="600">${escapeHtmlText(label)}</text>
    </svg>`;
    }

    const isInferred = snapshots.length > 0 && snapshots[0].inferred;
    const dataSourceLabel = isInferred
        ? '⚠️ Datos inferidos desde timestamps de archivos (el Pulpo no estaba corriendo). Precisión limitada.'
        : `📊 ${snapshots.length} snapshots reales del Pulpo (${snapshots.length > 0 ? fmtDuration(now - snapshots[0].ts) : '0'} de historia)`;

    let etaRows = '';
    const faseOrder = ['analisis', 'criterios', 'sizing', 'validacion', 'dev', 'build', 'verificacion', 'linteo', 'aprobacion', 'entrega'];
    for (const fase of faseOrder) {
        const avg = etaAverages[fase];
        if (!avg?.avgMs) continue;
        const skills = Object.entries(etaAverages)
            .filter(([k]) => k.startsWith(fase + '/'))
            .map(([k, v]) => `${escapeHtmlText(k.split('/')[1])}: ${fmtDuration(v.avgMs)}`)
            .join(', ');
        etaRows += `<tr><td>${escapeHtmlText(fase)}</td><td>${fmtDuration(avg.avgMs)}</td><td>${escapeHtmlText(String(avg.count))}</td><td class="dim">${skills}</td></tr>`;
    }

    const topSessions = tokenEstimates.bySession.slice().sort((a, b) => b.tokens - a.tokens).slice(0, 10);
    const sessionRows = topSessions.map(s =>
        `<tr><td>${escapeHtmlText(safeSessionId(s.id))}</td><td>${escapeHtmlText(String(s.tools))}</td><td>${escapeHtmlText(String(s.durMin))}min</td><td>${(s.tokens / 1000).toFixed(0)}K</td></tr>`
    ).join('');

    return `<!DOCTYPE html>
<html lang="es"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Métricas — Pipeline V2</title>
<style>
:root{--bg:#0d1117;--sf:#161b22;--sf2:#1c2128;--bd:#30363d;--tx:#e6edf3;--dim:#8b949e;--ac:#58a6ff;--gn:#3fb950;--yl:#d29922;--or:#db6d28;--rd:#f85149;--radius:10px}
*{margin:0;padding:0;box-sizing:border-box}
body{background:var(--bg);color:var(--tx);font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;padding:20px 24px;font-size:15px;line-height:1.5}
a{color:var(--ac);text-decoration:none}
h1{font-size:1.5em;margin-bottom:20px;display:flex;align-items:center;gap:10px}
h2{font-size:1.1em;color:var(--tx);margin-bottom:12px;border-bottom:1px solid var(--bd);padding-bottom:6px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:16px;margin-bottom:24px}
.card{background:var(--sf);border:1px solid var(--bd);border-radius:var(--radius);padding:16px}
.card-value{font-size:2em;font-weight:700}
.card-label{color:var(--dim);font-size:0.85em}
.card-sub{color:var(--dim);font-size:0.78em;margin-top:4px}
.green{color:var(--gn)}.yellow{color:var(--yl)}.orange{color:var(--or)}.red{color:var(--rd)}.blue{color:var(--ac)}
table{width:100%;border-collapse:collapse;font-size:0.88em}
th{text-align:left;color:var(--dim);padding:6px 10px;border-bottom:1px solid var(--bd);font-weight:600}
td{padding:6px 10px;border-bottom:1px solid var(--bd)}
.dim{color:var(--dim)}
.sparkline{display:block;margin-top:8px}
.level-bar{display:flex;height:20px;border-radius:6px;overflow:hidden;margin:8px 0}
.level-bar>div{height:100%;display:flex;align-items:center;justify-content:center;font-size:0.7em;font-weight:700;color:#000}
.back-link{margin-bottom:16px;display:inline-block}
.chart{width:100%;height:auto;max-height:200px}
.chart-grid{display:grid;grid-template-columns:1fr;gap:12px}
.section{margin-bottom:28px}
.section-ref{font-size:0.65em;color:var(--dim);font-weight:400;font-style:italic;letter-spacing:0;text-transform:none;margin-left:8px}
.bar-h{position:relative;height:12px;background:var(--bd);border-radius:4px;overflow:hidden;min-width:80px}
.bar-h-fill{height:100%;border-radius:4px;transition:width 0.4s}
.dora-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:16px;margin-bottom:16px}
.dora-card{background:var(--sf);border:1px solid var(--bd);border-radius:var(--radius);padding:18px;text-align:center}
.dora-value{font-size:2.2em;font-weight:800;font-variant-numeric:tabular-nums;line-height:1.1}
.dora-target{font-size:0.78em;color:var(--dim);margin-top:8px;display:flex;align-items:center;justify-content:center;gap:6px}
.dora-dot{width:8px;height:8px;border-radius:50%;display:inline-block}
.reco-card p{margin-bottom:8px;line-height:1.5;font-size:0.9em}
.trend-up{color:var(--gn)}.trend-down{color:var(--rd)}.trend-flat{color:var(--dim)}
</style></head><body>
<a href="/" class="back-link">← Dashboard</a>
<h1>📊 Métricas del Pipeline</h1>

<div class="grid">
  <div class="card">
    <div class="card-value blue">${snap24h.length}</div>
    <div class="card-label">Snapshots (24h)</div>
    <div class="card-sub">${snap1h.length} última hora · ${snap6h.length} últimas 6h</div>
  </div>
  <div class="card">
    <div class="card-value">${avgCpu(snap1h)}%<span class="dim" style="font-size:0.5em"> / ${maxCpu(snap1h)}% max</span></div>
    <div class="card-label">CPU promedio (1h)</div>
    ${sparkline(cpuSpark, 100, '#f85149')}
  </div>
  <div class="card">
    <div class="card-value">${avgMem(snap1h)}%<span class="dim" style="font-size:0.5em"> / ${maxMem(snap1h)}% max</span></div>
    <div class="card-label">RAM promedio (1h)</div>
    ${sparkline(memSpark, 100, '#d29922')}
  </div>
  <div class="card">
    <div class="card-value">${avgAgents(snap1h)}</div>
    <div class="card-label">Agentes promedio (1h)</div>
    ${sparkline(agentSpark, 5, '#58a6ff')}
  </div>
</div>

<div class="grid">
  <div class="card">
    <div class="card-value green">${delivered24h}</div>
    <div class="card-label">Issues entregados (24h)</div>
    <div class="card-sub">${delivered7d} total histórico</div>
  </div>
  <div class="card">
    <div class="card-value ${reboteRate > 30 ? 'red' : reboteRate > 15 ? 'yellow' : 'green'}">${reboteRate}%</div>
    <div class="card-label">Tasa de rechazo</div>
    <div class="card-sub">${totalRejected} rechazados / ${totalProcessed} procesados</div>
  </div>
  <div class="card">
    <div class="card-value blue">${tokM}M</div>
    <div class="card-label">Tokens estimados (total)</div>
    <div class="card-sub">~$${costEst} USD · ${tokenEstimates.totalSessions} sesiones · ${tokenEstimates.totalTools} herramientas</div>
  </div>
  <div class="card">
    <div class="card-label">Presión de recursos (24h)</div>
    <div class="level-bar">
      ${levelPct.green > 0 ? `<div style="width:${levelPct.green}%;background:var(--gn)">${levelPct.green}%</div>` : ''}
      ${levelPct.yellow > 0 ? `<div style="width:${levelPct.yellow}%;background:var(--yl)">${levelPct.yellow}%</div>` : ''}
      ${levelPct.orange > 0 ? `<div style="width:${levelPct.orange}%;background:var(--or)">${levelPct.orange}%</div>` : ''}
      ${levelPct.red > 0 ? `<div style="width:${levelPct.red}%;background:var(--rd)">${levelPct.red}%</div>` : ''}
    </div>
    <div class="card-sub">🟢 ${levelPct.green || 0}% · 🟡 ${levelPct.yellow || 0}% · 🟠 ${levelPct.orange || 0}% · 🔴 ${levelPct.red || 0}%</div>
  </div>
</div>

<div class="section">
<h2>📈 Gráficos históricos</h2>
<div class="card-sub" style="margin-bottom:12px">${escapeHtmlText(dataSourceLabel)}</div>
<div class="chart-grid">
  <div class="card">${chart(snapshots.map(s => s.cpu), 100, '#f85149', 'CPU %', '%', [[65, '#d29922'], [80, '#db6d28'], [90, '#f85149']])}</div>
  <div class="card">${chart(snapshots.map(s => s.mem), 100, '#d29922', 'RAM %', '%', [[65, '#d29922'], [80, '#db6d28'], [90, '#f85149']])}</div>
  <div class="card">${chart(snapshots.map(s => s.agents), 6, '#58a6ff', 'Agentes activos', '', [])}</div>
</div>
</div>

<div class="section">
<h2>⏱ Velocidad por fase (promedios históricos)</h2>
<table>
<thead><tr><th>Fase</th><th>Promedio</th><th>Muestras</th><th>Detalle por skill</th></tr></thead>
<tbody>${etaRows || '<tr><td colspan="4" class="dim">Sin datos históricos</td></tr>'}</tbody>
</table>
</div>

<div class="section">
<h2>🤖 Cuota Anthropic — Top sesiones por consumo estimado</h2>
<table>
<thead><tr><th>Sesión</th><th>Herramientas</th><th>Duración</th><th>Tokens est.</th></tr></thead>
<tbody>${sessionRows || '<tr><td colspan="4" class="dim">Sin datos</td></tr>'}</tbody>
</table>
<div class="card-sub" style="margin-top:8px">⚠️ Tokens estimados por proxy: (duración_seg × 15) + (tools × 500). Calibrar con dashboard de Anthropic.</div>
</div>

${(() => {
  const PERSONA = {
    guru: { icon: '🧠', color: '#bc8cff', ref: 'Hickey · Henney' },
    security: { icon: '🔒', color: '#f85149', ref: 'Hunt · Schneier' },
    po: { icon: '📋', color: '#d29922', ref: 'Cagan · Torres' },
    ux: { icon: '🎨', color: '#f778ba', ref: 'Norman · Nielsen' },
    planner: { icon: '📐', color: '#a371f7', ref: 'Singer · Ward' },
    'backend-dev': { icon: '⚡', color: '#3fb950', ref: 'Fowler · Martin' },
    'android-dev': { icon: '📱', color: '#58a6ff', ref: 'Wharton · Guy' },
    'web-dev': { icon: '🌐', color: '#79c0ff', ref: 'Osmani · Russell' },
    tester: { icon: '🧪', color: '#d2a8ff', ref: 'Beck · Meszaros' },
    qa: { icon: '✅', color: '#3fb950', ref: 'Bach · Crispin' },
    review: { icon: '👁️', color: '#ffa657', ref: 'Greiler · Google' },
    delivery: { icon: '🚀', color: '#f0883e', ref: 'Humble · Farley' },
    build: { icon: '🏗️', color: '#8b949e', ref: 'Pipeline' },
  };
  const perfEntries = Object.entries(agentPerf || {}).sort((a, b) => b[1].issues - a[1].issues);
  if (perfEntries.length === 0) return '';
  const maxIssues = Math.max(1, ...perfEntries.map(([, a]) => a.issues));
  const rows = perfEntries.map(([skill, a]) => {
    const p = PERSONA[skill] || { icon: '⚙', color: 'var(--dim)', ref: '' };
    const avgDur = a.durCount > 0 ? fmtDuration(Math.round(a.totalDurMs / a.durCount)) : '—';
    const failRate = a.issues > 0 ? Math.round(a.rejected / a.issues * 100) : 0;
    const failColor = failRate > 30 ? 'var(--rd)' : failRate > 15 ? 'var(--yl)' : 'var(--gn)';
    const bw = Math.max(2, Math.round(a.issues / maxIssues * 100));
    // XSS hardening (#3733): el nombre de skill viene del filesystem/config →
    // escapado. El resto son números computados internamente.
    const safeSkill = escapeHtmlText(skill);
    return '<tr><td><span style="color:' + p.color + '">' + p.icon + ' <strong>' + safeSkill + '</strong></span><div style="font-size:0.7em;color:var(--dim);font-style:italic">' + escapeHtmlText(p.ref) + '</div></td><td>' + a.issues + '</td><td><div class="bar-h"><div class="bar-h-fill" style="width:' + bw + '%;background:' + p.color + '"></div></div></td><td>' + avgDur + '</td><td style="color:' + failColor + '">' + failRate + '%</td><td>' + a.toolCalls + '</td></tr>';
  }).join('');
  return '<div id="agentes" class="section"><h2>🤖 Rendimiento por agente</h2><table><thead><tr><th>Agente</th><th>Issues</th><th style="min-width:120px">Volumen</th><th>Duración avg</th><th>Rechazo %</th><th>Tool calls</th></tr></thead><tbody>' + rows + '</tbody></table></div>';
})()}

${(() => {
  const now7d = Date.now() - 7 * 86400000;
  const d7 = entregas.filter(e => e.ts >= now7d).length;
  const doraTP = (d7 / 7).toFixed(1);
  const doraFR = totalProcessed > 0 ? Math.round(totalRejected / totalProcessed * 100) : 0;
  let doraLT = 0;
  for (const [key, d] of Object.entries(etaAverages)) {
    if (!key.includes('/') && d.avgMs) doraLT += d.avgMs;
  }
  const chk = (val, target, inv) => {
    if (!val) return { color: 'var(--dim)', label: 'SIN DATOS', cls: 'dim' };
    return (inv ? val <= target : val >= target)
      ? { color: 'var(--gn)', label: 'ELITE', cls: 'green' }
      : (inv ? val <= target * 2 : val >= target / 2)
        ? { color: 'var(--yl)', label: 'MEDIO', cls: 'yellow' }
        : { color: 'var(--rd)', label: 'BAJO', cls: 'red' };
  };
  const lt = chk(doraLT, 6 * 3600000, true);
  const tp = chk(parseFloat(doraTP), 2, false);
  const cfr = chk(100 - doraFR, 85, false);
  return '<div id="dora" class="section"><h2>📐 DORA Adaptado <span class="section-ref">Nicole Forsgren · Accelerate</span></h2><div class="card-sub" style="margin-bottom:12px">Métricas DORA adaptadas para pipeline de agentes AI · Ventana rolling 7d</div><div class="dora-grid"><div class="dora-card"><div class="dora-value" style="color:' + lt.color + '">' + (doraLT > 0 ? fmtDuration(doraLT) : '—') + '</div><div class="card-label">Lead Time</div><div class="dora-target"><span class="dora-dot" style="background:' + lt.color + '"></span>' + lt.label + ' · target < 6h</div></div><div class="dora-card"><div class="dora-value" style="color:' + tp.color + '">' + doraTP + '/día</div><div class="card-label">Throughput</div><div class="dora-target"><span class="dora-dot" style="background:' + tp.color + '"></span>' + tp.label + ' · target > 2/día</div></div><div class="dora-card"><div class="dora-value" style="color:' + cfr.color + '">' + doraFR + '%</div><div class="card-label">Change Failure Rate</div><div class="dora-target"><span class="dora-dot" style="background:' + cfr.color + '"></span>' + cfr.label + ' · target < 15%</div></div></div></div>';
})()}

<div style="color:var(--dim);font-size:0.8em;margin-top:20px">
🔴 Live · <a href="/api/metrics">API JSON</a> · <a href="/">← Dashboard</a> · <a href="/dashboard?view=kpis">Ventana KPIs V3</a>
</div>
</body></html>`;
}

/**
 * Panel inerte visible (CA-A3 del épico) cuando require()/state fallan. El
 * render NUNCA queda en blanco — el operador ve el motivo y sabe revisar logs.
 */
function renderInert(reason) {
    const safe = escapeHtmlText(reason || 'módulo no disponible');
    return `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8">
<title>Intrale · KPIs</title></head><body style="font-family:system-ui;background:#0d1117;color:#e6edf3">
<main style="padding:32px;max-width:680px;margin:0 auto">
<h1>Ventana KPIs no disponible</h1>
<p>${safe}</p>
<p>Ver logs del dashboard para detalle. El render no queda en blanco.</p>
<p><a href="/metrics" style="color:#58a6ff">Ver métricas históricas (/metrics)</a></p>
</main></body></html>`;
}

module.exports = {
    renderKpis,
    renderKpiCardsHTML,
    renderDoraAndCommanderHTML,
    renderProvidersHTML,
    renderAgentPerfHTML,
    renderMetricsCta,
    renderMetricsPage,
    renderInert,
    KPIS_CSS,
    escapeHtmlSsr,
    safeSessionId,
    fmtDuration,
};
