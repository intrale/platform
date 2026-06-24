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
// (satellites.js::renderMatriz) + leyenda V3 nueva (CA-C3) + sistema visual
// accesible #3959 (CA-5): cada estado se distingue por color + PATRÓN CSS +
// glifo, nunca sólo por color. Patrones/colores tomados verbatim de la
// narrativa UX (.pipeline/assets/mockups/narrativa-matriz-heatmap.md).
const MATRIZ_CSS = `
.mtx-table { width: 100%; border-collapse: collapse; font-size: 12px; }
.mtx-table th, .mtx-table td { padding: 9px 11px; border: 1px solid var(--in-border); text-align: center; font-variant-numeric: tabular-nums; }
.mtx-table th { background: var(--in-bg-3); font-weight: 600; color: var(--in-fg-dim); text-transform: uppercase; font-size: 10px; letter-spacing: 0.6px; }
.mtx-table th.skill-h, .mtx-table td.skill { text-align: left; font-weight: 500; background: var(--in-bg-3); position: sticky; left: 0; }
.mtx-cell-0 { color: var(--in-fg-soft); }
/* CA-5 — carga normal: puntos sutiles */
.mtx-cell-active {
  background-color: var(--in-accent-soft);
  background-image: radial-gradient(rgba(46,230,193,0.55) 0.9px, transparent 0.9px);
  background-size: 6px 6px;
  color: var(--in-accent); font-weight: 600;
}
/* CA-5 — carga alta: rayado diagonal */
.mtx-cell-hot {
  background-color: var(--in-warn-soft);
  background-image: repeating-linear-gradient(45deg, rgba(210,153,34,0.7) 0 1.6px, transparent 1.6px 7px);
  color: var(--in-warn); font-weight: 600;
}
/* CA-3/CA-5 — cuello de botella (gana 1 sola celda): cross-hatch denso + borde 2px */
.mtx-cell-neck {
  background-color: var(--in-bad-soft);
  background-image:
    repeating-linear-gradient(45deg,  rgba(248,81,73,0.85) 0 1.4px, transparent 1.4px 6px),
    repeating-linear-gradient(-45deg, rgba(248,81,73,0.45) 0 1px,   transparent 1px 6px);
  border: 2px solid var(--in-bad); color: var(--in-bad); font-weight: 700;
}
/* CA-1 — celdas operables: foco de teclado visible + cursor */
.mtx-cell-btn { cursor: pointer; }
.mtx-cell-btn:focus-visible { outline: 2px solid var(--in-info, #58a6ff); outline-offset: -2px; }
.mtx-glyph { font-size: 10px; opacity: 0.8; margin-right: 2px; }
/* CA-3 — badge de texto explícito del cuello de botella (no sólo color) */
.mtx-neck-badge { display: inline-block; font-size: 9px; font-weight: 700; line-height: 1; padding: 2px 4px; margin-top: 3px; border-radius: 3px; background: var(--in-bad); color: var(--in-bg-1, #0d1117); white-space: nowrap; }
/* CA-2 — flecha de tendencia: el glifo es la señal, el color sólo refuerza */
.mtx-trend { font-size: 10px; margin-left: 3px; font-weight: 700; }
.mtx-trend.is-up { color: var(--in-bad); }
.mtx-trend.is-down { color: var(--in-ok); }
.mtx-trend.is-flat { color: var(--in-fg-soft); }
.mtx-totals td { background: var(--in-bg-3); font-weight: 600; color: var(--in-fg-dim); border-top: 2px solid var(--in-border); }
/* CA-C3 — leyenda del heat-map: explicar qué significan los estados de celda. */
.mtx-legend { display: flex; flex-wrap: wrap; gap: 14px; align-items: center; font-size: 11px; color: var(--in-fg-dim); margin-bottom: 12px; }
.mtx-legend-item { display: inline-flex; align-items: center; gap: 6px; }
.mtx-legend-glyph { font-size: 12px; width: 12px; text-align: center; display: inline-block; }
.mtx-legend-swatch { width: 14px; height: 14px; border-radius: 3px; border: 1px solid var(--in-border); display: inline-block; }
.mtx-legend-swatch.is-0 { background: var(--in-bg-2); }
.mtx-legend-swatch.is-active { background-color: var(--in-accent-soft); border-color: var(--in-accent); background-image: radial-gradient(rgba(46,230,193,0.55) 0.9px, transparent 0.9px); background-size: 5px 5px; }
.mtx-legend-swatch.is-hot { background-color: var(--in-warn-soft); border-color: var(--in-warn); background-image: repeating-linear-gradient(45deg, rgba(210,153,34,0.7) 0 1.6px, transparent 1.6px 6px); }
.mtx-legend-swatch.is-neck { background-color: var(--in-bad-soft); border: 2px solid var(--in-bad); background-image: repeating-linear-gradient(45deg, rgba(248,81,73,0.85) 0 1.4px, transparent 1.4px 5px), repeating-linear-gradient(-45deg, rgba(248,81,73,0.45) 0 1px, transparent 1px 5px); }
/* CA-1 — panel lateral de drill-down (dialog nativo, focus trap del browser). */
.mtx-dialog { border: 1px solid var(--in-border); border-radius: 12px; background: var(--in-bg-2); color: var(--in-fg); padding: 0; max-width: 520px; width: 92vw; }
.mtx-dialog::backdrop { background: rgba(0,0,0,0.55); }
.mtx-dialog-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; padding: 16px 18px 10px; border: 0; margin: 0; }
.mtx-dialog-title { font-size: 14px; font-weight: 700; margin: 0; }
.mtx-dialog-sub { font-size: 11px; color: var(--in-fg-dim); margin-top: 3px; }
.mtx-dialog-close { background: none; border: 1px solid var(--in-border); border-radius: 6px; color: var(--in-fg-dim); cursor: pointer; font-size: 13px; line-height: 1; padding: 5px 8px; }
.mtx-dialog-list { list-style: none; margin: 0; padding: 4px 18px 18px; display: flex; flex-direction: column; gap: 6px; max-height: 60vh; overflow-y: auto; }
.mtx-dialog-item { display: flex; gap: 8px; align-items: baseline; font-size: 12px; padding: 6px 8px; border-radius: 6px; background: var(--in-bg-3); }
.mtx-dialog-item a, .mtx-dialog-item .mtx-dialog-num { font-family: var(--in-mono, monospace); color: var(--in-info, #58a6ff); font-weight: 600; flex: 0 0 auto; }
.mtx-dialog-item-title { color: var(--in-fg); overflow: hidden; text-overflow: ellipsis; }
.mtx-dialog-empty { padding: 8px; color: var(--in-fg-dim); font-size: 12px; }`;

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
      <span class="mtx-legend-swatch is-0" aria-hidden="true"></span><span class="mtx-legend-glyph" aria-hidden="true">·</span>Sin carga
    </span>
    <span class="mtx-legend-item" title="Entre 1 y 4 issues activos: carga normal">
      <span class="mtx-legend-swatch is-active" aria-hidden="true"></span><span class="mtx-legend-glyph" aria-hidden="true">●</span>1–4 issues (carga normal)
    </span>
    <span class="mtx-legend-item" title="5 o más issues activos: carga alta">
      <span class="mtx-legend-swatch is-hot" aria-hidden="true"></span><span class="mtx-legend-glyph" aria-hidden="true">◣</span>5+ issues (carga alta)
    </span>
    <span class="mtx-legend-item" title="Celda con mayor conteo × edad media: el cuello de botella del pipeline">
      <span class="mtx-legend-swatch is-neck" aria-hidden="true"></span><span class="mtx-legend-glyph" aria-hidden="true">▦</span>Cuello de botella
    </span>
    <span class="mtx-legend-item" title="Tendencia de la carga de la celda respecto de hace 24 horas">
      <span class="mtx-legend-glyph" aria-hidden="true">▲▼▬</span>Tendencia vs 24h
    </span>
  </div>
  <div id="matriz-table" role="region" aria-live="polite" aria-label="Tabla de carga skill por fase"></div>
  ${renderMatrizDialog()}
</section>`;
}

// CA-1 — panel lateral de drill-down: <dialog> nativo (focus trap + Esc del
// browser). El contenido (lista de issues por celda) se rellena client-side con
// textContent/createElement — sin innerHTML de datos externos (mantiene verde el
// guard XSS de matriz.test.js). Patrón clonado de issues.js::renderIssuesDialog.
function renderMatrizDialog() {
    // CA-6 — sin <form> (la ventana es READ-ONLY): el cierre se hace por JS
    // (mtx-dialog-close → dlg.close()) + Esc nativo del <dialog>. No hay submit
    // ni POST. El test matriz.test.js:134-139 verifica la ausencia de <form>.
    return `<dialog id="mtx-dialog" class="mtx-dialog" aria-labelledby="mtx-dialog-title">
  <div class="mtx-dialog-head">
    <div>
      <h2 id="mtx-dialog-title" class="mtx-dialog-title">Celda</h2>
      <div id="mtx-dialog-sub" class="mtx-dialog-sub"></div>
    </div>
    <button type="button" id="mtx-dialog-close" class="mtx-dialog-close" title="Cerrar" aria-label="Cerrar detalle de la celda">✕</button>
  </div>
  <ol id="mtx-dialog-list" class="mtx-dialog-list" aria-label="Issues de la celda"></ol>
</dialog>`;
}

// Script de hidratación. tickMatriz hereda verbatim del legacy + tooltips
// (CA-C1) en encabezados de columna y celdas, construidos con title="" sobre
// valores escapados (escapeHtml).
const MATRIZ_SCRIPT = `
// #3959 — último payload del endpoint, para que el drill-down lea títulos sin
// re-pedir. La grilla se reconstruye en cada tick; el dialog lee de acá.
let MTX_DATA = null;
const MTX_GH = 'https://github.com/intrale/platform/issues/';

// CA-1 — abre el panel lateral con los issues de la celda (skill, fase). El
// contenido externo (títulos) se inyecta con textContent/createElement; el
// número de issue se valida /^\\d+$/ antes de construir el href de GitHub.
function openMtxDrilldown(faseKey, skill){
    const dlg = document.getElementById('mtx-dialog');
    if(!dlg || !MTX_DATA) return;
    const ids = ((MTX_DATA.matrixIssues||{})[faseKey]||{})[skill] || [];
    const matrix = MTX_DATA.matrix || {};
    const ageAvg = ((MTX_DATA.matrixAgeAvg||{})[faseKey]||{})[skill];
    document.getElementById('mtx-dialog-title').textContent = skill + ' · ' + faseKey;
    const sub = document.getElementById('mtx-dialog-sub');
    let subTxt = ids.length + ' issue' + (ids.length===1?'':'s') + ' activo' + (ids.length===1?'':'s');
    if(typeof ageAvg === 'number' && ageAvg > 0) subTxt += ' · edad media ' + ageAvg + ' min';
    sub.textContent = subTxt;
    const list = document.getElementById('mtx-dialog-list');
    list.innerHTML = '';
    if(!ids.length){
        const li = document.createElement('li');
        li.className = 'mtx-dialog-empty';
        li.textContent = 'Sin issues en esta celda.';
        list.appendChild(li);
    }
    for(const id of ids){
        const li = document.createElement('li');
        li.className = 'mtx-dialog-item';
        const idStr = String(id);
        if(/^\\d+$/.test(idStr)){
            const a = document.createElement('a');
            a.href = MTX_GH + idStr;
            a.target = '_blank'; a.rel = 'noopener noreferrer';
            a.textContent = '#' + idStr;
            li.appendChild(a);
        } else {
            const span = document.createElement('span');
            span.className = 'mtx-dialog-num';
            span.textContent = '#' + idStr;
            li.appendChild(span);
        }
        const t = document.createElement('span');
        t.className = 'mtx-dialog-item-title';
        const meta = matrix[idStr] || {};
        t.textContent = meta.title || '(sin título)';
        li.appendChild(t);
        list.appendChild(li);
    }
    if(typeof dlg.showModal === 'function') dlg.showModal();
    else dlg.setAttribute('open','');
}

function closeMtxDialog(){
    const dlg = document.getElementById('mtx-dialog');
    if(!dlg) return;
    if(typeof dlg.close === 'function') dlg.close();
    else dlg.removeAttribute('open');
}

// Delegación de eventos en el contenedor (persiste entre re-renders del innerHTML).
let _mtxWired = false;
function wireMtxDelegation(c){
    if(_mtxWired) return;
    _mtxWired = true;
    const closeBtn = document.getElementById('mtx-dialog-close');
    if(closeBtn) closeBtn.addEventListener('click', closeMtxDialog);
    function fire(target){
        const cell = target.closest ? target.closest('.mtx-cell-btn') : null;
        if(!cell) return;
        const fk = cell.getAttribute('data-fk');
        const sk = cell.getAttribute('data-sk');
        if(fk && sk) openMtxDrilldown(fk, sk);
    }
    c.addEventListener('click', (ev) => fire(ev.target));
    c.addEventListener('keydown', (ev) => {
        if(ev.key === 'Enter' || ev.key === ' ' || ev.key === 'Spacebar'){
            const cell = ev.target.closest ? ev.target.closest('.mtx-cell-btn') : null;
            if(cell){ ev.preventDefault(); fire(ev.target); }
        }
    });
}

async function tickMatriz(){
    const d = await fetchJson('/api/dash/pipeline');
    if(!d) return;
    MTX_DATA = d;
    const c = document.getElementById('matriz-table');
    if(!c) return;
    wireMtxDelegation(c);
    const fases = d.fases || [];
    const counts = d.matrixCounts || {};
    const ageAvg = d.matrixAgeAvg || {};
    const trend = d.matrixTrend || {};
    // CA-4 — orden de skills desde la fuente única (skillOrder del slice). Si no
    // viene, degradar a SKILL_COLORS (orden estable conocido). Agregar al final
    // cualquier skill que aparezca en counts y no esté en el orden canónico.
    const SKILL_LIST = (Array.isArray(d.skillOrder) && d.skillOrder.length) ? d.skillOrder : Object.keys(SKILL_COLORS);
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

    // CA-3 — cuello de botella = celda con mayor (conteo × edad media). Una sola
    // gana; empate → mayor edad media. Reemplaza el destaque por umbral n>=5.
    let neckKey = null, neckScore = -1, neckAge = -1;
    for(const { pipeline: p, fase } of fases){
        const fk = p+'/'+fase;
        for(const sk of allSkills){
            const n = (counts[fk]||{})[sk] || 0;
            if(n <= 0) continue;
            const a = (ageAvg[fk]||{})[sk] || 0;
            const score = n * a;
            if(score > neckScore || (score === neckScore && a > neckAge)){
                neckScore = score; neckAge = a; neckKey = fk+'\\u0000'+sk;
            }
        }
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
                const fk = p+'/'+fase;
                const n = (counts[fk]||{})[skill] || 0;
                const isNeck = neckKey === (fk+'\\u0000'+skill);
                // CA-5 — estado por color + patrón (clase CSS) + glifo.
                let cls = 'mtx-cell-0', glyph = '·';
                if(isNeck){ cls = 'mtx-cell-neck'; glyph = '▦'; }
                else if(n >= 5){ cls = 'mtx-cell-hot'; glyph = '◣'; }
                else if(n > 0){ cls = 'mtx-cell-active'; glyph = '●'; }
                // CA-2 — flecha de tendencia vs ≈24h. Sin baseline → sin flecha.
                let trendHtml = '';
                const base = (trend[fk]||{})[skill];
                if(typeof base === 'number' && n > 0){
                    let tcls, tglyph, tlabel;
                    if(n > base){ tcls='is-up'; tglyph='▲'; tlabel='subió respecto de hace 24 horas'; }
                    else if(n < base){ tcls='is-down'; tglyph='▼'; tlabel='bajó respecto de hace 24 horas'; }
                    else { tcls='is-flat'; tglyph='▬'; tlabel='estable respecto de hace 24 horas'; }
                    trendHtml = ' <span class="mtx-trend '+tcls+'" aria-label="'+tlabel+'">'+tglyph+'</span>';
                }
                const glyphHtml = '<span class="mtx-glyph" aria-hidden="true">'+glyph+'</span>';
                if(n > 0){
                    const tip = n+' issue'+(n===1?'':'s')+' de '+escapeHtml(skill)+' en '+escapeHtml(fk)+(isNeck?' — cuello de botella':'');
                    const alabel = escapeHtml(skill)+' en '+escapeHtml(fk)+', '+n+' issue'+(n===1?'':'s')+', abrir detalle';
                    const badge = isNeck ? '<div class="mtx-neck-badge">⚠ cuello de botella</div>' : '';
                    html += '<td class="'+cls+' mtx-cell-btn" role="button" tabindex="0" data-fk="'+escapeHtml(fk)+'" data-sk="'+escapeHtml(skill)+'" aria-label="'+alabel+'" title="'+tip+'">'+glyphHtml+n+trendHtml+badge+'</td>';
                } else {
                    html += '<td class="'+cls+'" title="Sin carga">'+glyphHtml+'</td>';
                }
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
