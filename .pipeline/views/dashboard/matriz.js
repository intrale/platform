// =============================================================================
// matriz.js — Vista SSR de la ventana Matriz del dashboard V3
// (`/matriz` legacy + `/dashboard?view=matriz`).
//
// Issue: #3731 (split de #3715 — extracción de la ventana Matriz del monolito
// satellites.js). Mide la carga actual del pipeline cruzando skill × fase:
// cuántos issues activos tiene cada skill en cada fase de cada pipeline.
//
// Estructura (decisiones cerradas del issue + patrón de las hermanas
// descanso.js / ops.js / kpis.js):
//   - renderMatriz()        → documento SSR completo (shell satélite + tabla).
//   - renderMatrizInner()   → fragmento embebible (sin <!DOCTYPE>) para el
//                             DOM morphing del router cliente `?view=matriz`.
//   - slug                  → 'matriz' (clave de la allowlist VIEW_SLUGS).
//
// Convención V3 (igual que las hermanas): el SSR emite la estructura estable
// (sección + contenedor `#matriz-table` + leyenda) y un <script> embebido que
// hidrata vía `fetch('/api/dash/pipeline')` cada 30s con DOM morphing
// (sólo reescribe `innerHTML` si el HTML cambió → anti-flicker). El SSR provee
// el esqueleto para que un deep-link directo no quede en blanco antes del JS.
//
// Seguridad (CA-B3 / CA-D1):
//   - El SSR de esta ventana NO interpola datos del servidor: la grilla se
//     construye 100% client-side desde el JSON del endpoint. El único valor
//     que podría llegar por `opts` es ignorado (no hay prefill).
//   - Toda interpolación dinámica del cliente (nombres de skill, claves
//     pipeline/fase) pasa por `escapeHtml()` antes de tocar innerHTML.
//   - Para defensa en profundidad en el SSR se delega en `lib/escape-html.js`
//     (#3722) — si en el futuro se interpolara algún campo dinámico server-side
//     DEBE pasar por `escapeHtmlSsr()`.
//   - Ventana 100% READ-ONLY: sin <form>, sin POST, sin acciones mutantes.
// =============================================================================
'use strict';

const fs = require('fs');
const path = require('path');

// #3726 — Nav bar V3 unificada (renderNavTabsSsr + loadIconSprite del cache
// compartido del sprite.svg). Misma dependencia que home.js / satellites.js.
const { renderNavTabsSsr, loadIconSprite } = require('./nav-tabs');

// #3722 — Escape HTML server-side unificado (lib/escape-html.js, cierra #2901).
// CA-B3: las ventanas extraídas usan el helper compartido en vez de duplicar
// un escapeHtmlSsr inline. escapeHtmlText cubre el contexto nodo-texto y
// escapeHtmlAttr el contexto atributo (title="", aria-label="").
const { escapeHtmlText, escapeHtmlAttr } = require('../../lib/escape-html.js');

// #3953 (EP8-H0) — Wrapper único de fetch JSON (CA-2): no traga el error en
// silencio, dispara el banner "datos desactualizados — reintentando" y conserva
// el último dato. Reemplaza la copia local con .catch(()=>null).
const { FETCH_CLIENT_JS } = require('./fetch-client.js');

const THEME_CSS_PATH = path.join(__dirname, 'theme.css');
function loadTheme() {
    try { return fs.readFileSync(THEME_CSS_PATH, 'utf8'); } catch { return ''; }
}

const slug = 'matriz';

// Defensa en profundidad (CA-D1). Hoy el SSR de Matriz no interpola ningún
// dato dinámico (toda la grilla se hidrata client-side), pero dejamos el
// helper canónico delegando en lib/escape-html.js para que cualquier
// interpolación futura tenga un único punto de paso. escapeHtmlSsr cubre el
// contexto nodo-texto; para atributos usar escapeHtmlAttr directamente.
function escapeHtmlSsr(s) {
    if (s == null) return '';
    return escapeHtmlText(s);
}

// Snippet JS compartido por las vistas satélite (fetchJson, setText,
// escapeHtml cliente, SKILL_ICONS/COLORS, tickHeader del header pill).
// Copia del subconjunto de satellites.commonHelpers() que Matriz usa — se
// prepende al script del cliente igual que hacía pageShell, para no depender
// del monolito en demolición. tickMatriz consume escapeHtml + SKILL_* ;
// tickHeader consume setText + fetchJson + pipelineModeState.
const COMMON_HELPERS = `
function setText(id, value){ const el=document.getElementById(id); if(el && el.textContent!==String(value)) el.textContent=value; }
function escapeHtml(s){ return String(s||'').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":"&#39;"}[c])); }

const SKILL_ICONS = {
    'android-dev':'📱','backend-dev':'⚡','web-dev':'🌐','pipeline-dev':'🔧',
    ux:'🎨', po:'📋', planner:'📐',
    guru:'🧙', security:'🔒', tester:'🧪', qa:'✅', review:'👁',
    linter:'🧹', build:'🛠', delivery:'🚚', commander:'🎖'
};
const SKILL_COLORS = {
    'android-dev':'#58a6ff','backend-dev':'#3fb950','web-dev':'#79c0ff','pipeline-dev':'#a371f7',
    ux:'#f778ba', po:'#d29922', planner:'#a371f7',
    guru:'#58a6ff', security:'#f85149', tester:'#d2a8ff', qa:'#3fb950', review:'#ffa657',
    linter:'#8b949e', build:'#ffa657', delivery:'#2ee6c1', commander:'#f778ba'
};

// #3045 — cache compartido entre tickHeader y otros poll de la página.
let pipelineModeState = { mode: 'running', allowedIssues: [] };
function _saneAllowedIssues(arr){
    if(!Array.isArray(arr)) return [];
    const out = [];
    for(const v of arr){
        const n = Number(v);
        if(Number.isInteger(n) && n > 0) out.push(n);
    }
    return out;
}

async function tickHeader(){
    const d = await fetchJson('/api/dash/header');
    if(!d) return;
    setText('hdr-clock', new Date().toLocaleTimeString('es-AR'));
    pipelineModeState = {
        mode: d.mode || 'running',
        allowedIssues: _saneAllowedIssues(d.allowedIssues),
    };
    const modePill = document.getElementById('hdr-mode');
    if(modePill){
        modePill.classList.remove('in-mode-running','in-mode-paused','in-mode-partial');
        if(d.mode==='paused'){ modePill.classList.add('in-mode-paused'); modePill.textContent='⏸ Pausado'; }
        else if(d.mode==='partial_pause'){ modePill.classList.add('in-mode-partial'); modePill.textContent='⏸ Parcial · '+pipelineModeState.allowedIssues.length+' issues'; }
        else { modePill.classList.add('in-mode-running'); modePill.textContent='🟢 Running'; }
    }
}
document.addEventListener('visibilitychange', () => { if(document.visibilityState === 'visible' && typeof runAll === 'function') runAll(); });
`;

// CSS específico de la ventana Matriz. Heredado verbatim del legacy
// (satellites.js::renderMatriz) + leyenda V3 nueva (CA-C3).
const MATRIZ_CSS = `
.mtx-table { width: 100%; border-collapse: collapse; font-size: 12px; }
.mtx-table th, .mtx-table td { padding: 9px 11px; border: 1px solid var(--in-border); text-align: center; font-variant-numeric: tabular-nums; }
.mtx-table th { background: var(--in-bg-3); font-weight: 600; color: var(--in-fg-dim); text-transform: uppercase; font-size: 10px; letter-spacing: 0.6px; }
.mtx-table th.skill-h, .mtx-table td.skill { text-align: left; font-weight: 500; background: var(--in-bg-3); position: sticky; left: 0; }
.mtx-cell-0 { color: var(--in-fg-soft); }
.mtx-cell-active { background: var(--in-accent-soft); color: var(--in-accent); font-weight: 600; }
.mtx-cell-hot { background: var(--in-warn-soft); color: var(--in-warn); font-weight: 600; }
.mtx-totals td { background: var(--in-bg-3); font-weight: 600; color: var(--in-fg-dim); border-top: 2px solid var(--in-border); }
/* CA-C3 — leyenda del heat-map: explicar qué significan los tres estados de celda. */
.mtx-legend { display: flex; flex-wrap: wrap; gap: 14px; align-items: center; font-size: 11px; color: var(--in-fg-dim); margin-bottom: 12px; }
.mtx-legend-item { display: inline-flex; align-items: center; gap: 6px; }
.mtx-legend-swatch { width: 14px; height: 14px; border-radius: 3px; border: 1px solid var(--in-border); display: inline-block; }
.mtx-legend-swatch.is-0 { background: var(--in-bg-2); }
.mtx-legend-swatch.is-active { background: var(--in-accent-soft); border-color: var(--in-accent); }
.mtx-legend-swatch.is-hot { background: var(--in-warn-soft); border-color: var(--in-warn); }`;

// Fragmento embebible (sin shell). Lo reusa renderMatriz() (full doc) y
// renderMatrizInner() (DOM morphing del router cliente). Estructura estable:
// sección + leyenda (CA-C3) + contenedor `#matriz-table` que el JS hidrata.
function renderMatrizBody() {
    return `
<section class="in-section">
  <h2 class="in-section-title"><span class="in-section-title-icon">📈</span>Matriz · skill × fase (carga actual)</h2>
  <p class="in-section-sub">Cuántos issues activos tiene cada skill en cada fase del pipeline. Lectura: una celda alta indica un cuello de botella de ese skill en esa fase.</p>
  <div class="mtx-legend" aria-label="Leyenda del mapa de calor de la matriz">
    <span class="mtx-legend-item" title="La celda no tiene issues activos para ese skill en esa fase">
      <span class="mtx-legend-swatch is-0" aria-hidden="true"></span>Sin carga (·)
    </span>
    <span class="mtx-legend-item" title="Entre 1 y 4 issues activos: carga normal">
      <span class="mtx-legend-swatch is-active" aria-hidden="true"></span>1–4 issues (carga normal)
    </span>
    <span class="mtx-legend-item" title="5 o más issues activos: posible cuello de botella, revisar capacidad del skill">
      <span class="mtx-legend-swatch is-hot" aria-hidden="true"></span>5+ issues (cuello de botella)
    </span>
  </div>
  <div id="matriz-table" role="region" aria-live="polite" aria-label="Tabla de carga skill por fase"></div>
</section>`;
}

// Script de hidratación. tickMatriz hereda verbatim del legacy + tooltips
// (CA-C1) en encabezados de columna y celdas, construidos con title="" sobre
// valores escapados (escapeHtml).
const MATRIZ_SCRIPT = `
async function tickMatriz(){
    const d = await fetchJson('/api/dash/pipeline');
    if(!d) return;
    const c = document.getElementById('matriz-table');
    if(!c) return;
    const fases = d.fases || [];
    const counts = d.matrixCounts || {};
    // Skills: usar SKILL_COLORS (orden estable, conocido) + cualquiera que aparezca en counts.
    const SKILL_LIST = Object.keys(SKILL_COLORS);
    const extraSkills = new Set();
    for(const fase of Object.values(counts)) for(const sk of Object.keys(fase)) if(!SKILL_LIST.includes(sk)) extraSkills.add(sk);
    const allSkills = [...SKILL_LIST, ...extraSkills];

    // Calcular totales por fase y por skill para totals row/col
    const totalsByFase = {};
    const totalsBySkill = {};
    let grandTotal = 0;
    for(const { pipeline: p, fase } of fases){
        const key = p+'/'+fase;
        let sum = 0;
        for(const sk of allSkills){ sum += (counts[key]||{})[sk] || 0; }
        totalsByFase[key] = sum;
        grandTotal += sum;
    }
    for(const sk of allSkills){
        let sum = 0;
        for(const { pipeline: p, fase } of fases){ sum += (counts[p+'/'+fase]||{})[sk] || 0; }
        totalsBySkill[sk] = sum;
    }

    let html = '<table class="mtx-table"><thead><tr><th class="skill-h">Skill</th>';
    for(const { pipeline: p, fase } of fases){ html += '<th title="'+escapeHtml(p+'/'+fase)+'">'+escapeHtml(p[0].toUpperCase()+':'+fase)+'</th>'; }
    html += '<th title="Total de issues activos del skill en todas las fases">Total</th></tr></thead><tbody>';
    // Solo mostrar skills con al menos 1 issue activo (los demás son ruido).
    const visibleSkills = allSkills.filter(sk => totalsBySkill[sk] > 0);
    if(visibleSkills.length === 0){
        html += '<tr><td colspan="'+(fases.length+2)+'"><div class="in-empty">Sin issues activos en este momento</div></td></tr>';
    } else {
        for(const skill of visibleSkills){
            html += '<tr><td class="skill"><span style="color:'+(SKILL_COLORS[skill]||'inherit')+'">'+(SKILL_ICONS[skill]||'⚙')+'</span> '+escapeHtml(skill)+'</td>';
            for(const { pipeline: p, fase } of fases){
                const n = (counts[p+'/'+fase]||{})[skill] || 0;
                let cls = 'mtx-cell-0';
                if(n >= 5) cls = 'mtx-cell-hot';
                else if(n > 0) cls = 'mtx-cell-active';
                const tip = n > 0 ? (n+' issue'+(n===1?'':'s')+' de '+escapeHtml(skill)+' en '+escapeHtml(p+'/'+fase)) : 'Sin carga';
                html += '<td class="'+cls+'" title="'+tip+'">'+(n || '·')+'</td>';
            }
            html += '<td><strong>'+totalsBySkill[skill]+'</strong></td></tr>';
        }
    }
    // Totals row
    html += '<tr class="mtx-totals"><td>Total fase</td>';
    for(const { pipeline: p, fase } of fases){ html += '<td title="Total de issues activos en '+escapeHtml(p+'/'+fase)+'">'+(totalsByFase[p+'/'+fase] || 0)+'</td>'; }
    html += '<td>'+grandTotal+'</td></tr>';
    html += '</tbody></table>';
    if(c.innerHTML !== html) c.innerHTML = html;
}
const POLLS = [{ fn: tickHeader, ms: 5000 }, { fn: tickMatriz, ms: 30000 }];
async function runAll(){ for(const p of POLLS){ try{ await p.fn(); } catch{} } }
runAll();
for(const p of POLLS){ setInterval(() => { p.fn().catch(()=>{}); }, p.ms); }`;

/**
 * Fragmento embebible de la ventana Matriz (sin <!DOCTYPE>/shell). Lo consume
 * el router cliente `?view=matriz` por DOM morphing, y lo reusa renderMatriz()
 * para no duplicar la estructura. Incluye el <script> de hidratación, que
 * trae sus propios helpers (COMMON_HELPERS) para ser autosuficiente.
 */
function renderMatrizInner() {
    return `${renderMatrizBody()}
<script>${FETCH_CLIENT_JS}\n${COMMON_HELPERS}\n${MATRIZ_SCRIPT}</script>`;
}

/**
 * Documento SSR completo de la ventana Matriz. Replica el shell satélite
 * (header + nav V3 + footer) inline, siguiendo el patrón de descanso.js /
 * kpis.js para no depender del monolito en demolición.
 */
function renderMatriz() {
    const theme = loadTheme();
    const spriteInline = loadIconSprite();
    const navHtml = renderNavTabsSsr(slug);
    return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Intrale · Matriz</title>
<style>${theme}</style>
<style>
.satellite-frame { max-width: 1600px; margin: 0 auto; padding: 0; }
.satellite-body { padding: 22px 28px; display: flex; flex-direction: column; gap: 18px; }
.in-mode-running { color: var(--in-ok); border-color: var(--in-ok); background: var(--in-ok-soft); }
.in-mode-paused { color: var(--in-bad); border-color: var(--in-bad); background: var(--in-bad-soft); }
.in-mode-partial { color: var(--in-warn); border-color: var(--in-warn); background: var(--in-warn-soft); }
${MATRIZ_CSS}
</style>
</head>
<body>
<!-- #3726 — Sprite SVG inline para resolver <use href="#ic-tab-*"> dentro
     del <nav class="v3-nav">. Oculto; los símbolos siguen referenciables. -->
<div aria-hidden="true" style="position:absolute;width:0;height:0;overflow:hidden">${spriteInline}</div>
<div class="satellite-frame">
  <header class="in-header">
    <div class="in-header-brand">
      <div class="in-header-logo">i</div>
      <div>
        <div class="in-header-title">Matriz</div>
        <div class="in-header-subtitle">Skill × Fase</div>
      </div>
    </div>
    <div class="in-header-meta">
      <span class="in-pill" id="hdr-mode">…</span>
      <span class="in-clock" id="hdr-clock">…</span>
    </div>
  </header>
  ${navHtml}
  <main class="satellite-body">${renderMatrizInner()}</main>
  <footer class="in-footer">
    <span>Refresh independiente · sin flicker</span>
    <span>Intrale V3</span>
  </footer>
</div>
</body>
</html>`;
}

module.exports = {
    renderMatriz,
    renderMatrizInner,
    slug,
    escapeHtmlSsr,
    MATRIZ_CSS,
};
