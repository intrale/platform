// =============================================================================
// matriz.js — Vista SSR de la ventana Matriz del dashboard V3
// (`/matriz` legacy + `/dashboard?view=matriz`).
//
// Issue: #3731 (split de #3715 — extracción de la ventana Matriz del monolito
// satellites.js). Mide la carga actual del pipeline cruzando skill × fase:
// cuántos issues activos tiene cada skill en cada fase de cada pipeline.
//
// #4196 (Ola 7.1) — Rediseño integral MIZPÁ: la pantalla deja de tirar números
// crudos y pasa a DIAGNOSTICAR. Hereda el lenguaje visual MIZPÁ ya consensuado
// en las pantallas hermanas (#4189 Home, #4195 Equipo, #4194 Costos…):
//   - Barra de marca MIZPÁ (logo + tagline + selector multiproyecto) + nav curada
//     5 tabs + «⋯ Más» (Matriz vive dentro, con miga de pan «⋯ Más › 🔲 Matriz»).
//   - Banner de misión en clave diagnóstico: lee el cuadro por el operador
//     (fase saturada + %, carga total, fase y skill más cargados) y propone una
//     lectura accionable del cuello de botella.
//   - Heatmap legible de un vistazo: ícono + rol por skill, fase con etiqueta
//     legible, leyenda de carga, flecha de tendencia vs 24h y cuello resaltado.
//   - Nunca truncar: títulos, roles y conteos completos.
//
// Estructura (decisiones cerradas del issue + patrón de las hermanas
// descanso.js / ops.js / kpis.js / equipo):
//   - renderMatriz()        → documento SSR completo (shell MIZPÁ + banner + tabla).
//   - renderMatrizInner()   → fragmento embebible (sin <!DOCTYPE>) para el
//                             DOM morphing del router cliente `?view=matriz`.
//   - slug                  → 'matriz' (clave de la allowlist VIEW_SLUGS).
//
// Convención V3 (igual que las hermanas): el SSR emite la estructura estable
// (banner + sección + contenedor `#matriz-table` + leyenda) y un <script>
// embebido que hidrata vía `fetch('/api/dash/pipeline')` cada 30s con DOM
// morphing (sólo reescribe `innerHTML` si el HTML cambió → anti-flicker). El SSR
// provee el esqueleto para que un deep-link directo no quede en blanco.
//
// Seguridad (CA-B3 / CA-D1):
//   - El SSR de esta ventana NO interpola datos del servidor: la grilla y el
//     banner se construyen 100% client-side desde el JSON del endpoint.
//   - Toda interpolación dinámica del cliente (nombres de skill, claves
//     pipeline/fase) pasa por `escapeHtml()` antes de tocar innerHTML, o por
//     `textContent`/`createElement` (banner) — nunca innerHTML de datos externos.
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
// #4296 — Accessor compartido del banner de ola (avance %, velocidad %/h, ETA)
// desde la fuente determinística viva /api/dash/ola-eta (no conteos done/total).
const { missionOlaEtaClientScript } = require('../../lib/mission-ola-eta.js');

// #4241 — «Cabecera de ola» del marco común MIZPÁ (② del marco de #4234). Se
// reutiliza el helper canónico compartido `renderMissionBannerPipeline()`
// (pipeline-redesign.js, el mismo que consumen HOME #4235, COSTOS #4239, EQUIPO,
// BLOQUEADOS e ISSUES #4266), de modo que MATRIZ muestre EXACTAMENTE el mismo
// banner de ola que el resto de las pantallas: mismos contenedores `mz-*` y
// mismos IDs hidratables (`mission-wave-*`, `mission-eta/-vel/-delivered-*`,
// `mz-prog-bar` + leyenda de puntitos hechos·activos·bloq·cola). Al delegar en
// una única fuente de markup, las pantallas no pueden divergir (CA: «no se
// duplica markup»). require defensivo: si el módulo común no carga (checkout
// viejo / test aislado), el marco degrada SIN banner — nunca rompe el render ni
// devuelve 500. El contenido propio de MATRIZ (banner diagnóstico `mtx-mission`
// + heatmap) queda intacto debajo del marco.
let _renderMissionBannerPipeline = null;
try { _renderMissionBannerPipeline = require('./pipeline-redesign').renderMissionBannerPipeline; }
catch { /* opcional: sin banner de ola común */ }
function renderOlaBannerComun() {
    if (typeof _renderMissionBannerPipeline === 'function') {
        try { return _renderMissionBannerPipeline(); } catch { /* degrada sin banner */ }
    }
    return '';
}

const THEME_CSS_PATH = path.join(__dirname, 'theme.css');
function loadTheme() {
    try { return fs.readFileSync(THEME_CSS_PATH, 'utf8'); } catch { return ''; }
}

const slug = 'matriz';

// Defensa en profundidad (CA-D1). Hoy el SSR de Matriz no interpola ningún
// dato dinámico (toda la grilla y el banner se hidratan client-side), pero
// dejamos el helper canónico delegando en lib/escape-html.js para que cualquier
// interpolación futura tenga un único punto de paso. escapeHtmlSsr cubre el
// contexto nodo-texto; para atributos usar escapeHtmlAttr directamente.
function escapeHtmlSsr(s) {
    if (s == null) return '';
    return escapeHtmlText(s);
}

// #4196 — Barra de marca MIZPÁ. Markup idéntico al de las hermanas (equipo,
// costos): logo atalaya + nombre + tagline + selector multiproyecto. Las clases
// `mz-*` viven en theme.css (compartidas) — replicamos sólo el markup para no
// depender del monolito satellites.js en demolición. Todos los valores son
// literales hardcoded (sin datos externos): no requieren escape.
function renderMatrizBrandBar() {
    const logoSvg = '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true">'
        + '<path d="M12 2.5 5 6v5c0 4.6 3 8 7 9.5 4-1.5 7-4.9 7-9.5V6l-7-3.5Z" stroke="#06121a" stroke-width="1.6" fill="rgba(255,255,255,.16)"/>'
        + '<path d="M9.5 12.5 11.3 14.3 14.8 10.4" stroke="#06121a" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    return `
    <div class="in-header-brand">
      <div class="mz-logo" aria-hidden="true" title="MIZPÁ · atalaya de agentes (Génesis 31:49)">${logoSvg}</div>
      <div class="mz-id">
        <div class="mz-name">MIZPÁ</div>
        <div class="mz-sub">«Que el Señor vigile» · atalaya de agentes</div>
      </div>
      <div class="mz-projsel" role="button" tabindex="0"
           title="Proyecto activo. MIZPÁ es el motor; el proyecto es intercambiable (multiproyecto — selección en evaluación)."
           aria-label="Proyecto activo: Intrale, 1 de 3">
        <span class="mz-proj-avatar" aria-hidden="true">i</span>
        <span class="mz-proj-id">
          <span class="mz-proj-name">Intrale</span>
          <span class="mz-proj-state">PROYECTO ACTIVO</span>
        </span>
        <span class="mz-proj-badge">1 / 3</span>
        <span class="mz-proj-caret" aria-hidden="true">▾</span>
      </div>
    </div>`;
}

// Snippet JS compartido por las vistas satélite (fetchJson, setText,
// escapeHtml cliente, SKILL_ICONS/COLORS/ROLES, FASE_LABELS, tickHeader del
// header pill). Copia del subconjunto que Matriz usa — se prepende al script
// del cliente igual que hacía pageShell, para no depender del monolito en
// demolición.
const COMMON_HELPERS = `
function setText(id, value){ const el=document.getElementById(id); if(el && el.textContent!==String(value)) el.textContent=value; }
function escapeHtml(s){ return String(s||'').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":"&#39;"}[c])); }
function fmtNum(n){ return (typeof n === 'number' ? n : Number(n)||0).toLocaleString('es-AR'); }

const SKILL_ICONS = {
    'android-dev':'📱','backend-dev':'⚡','web-dev':'🌐','pipeline-dev':'🔧',
    ux:'🎨', po:'📋', planner:'🗺️', architect:'🏛️',
    guru:'📚', security:'🔒', tester:'🧪', qa:'✅', review:'🔍',
    linter:'🧹', build:'📦', delivery:'🚚', commander:'🎖️'
};
const SKILL_COLORS = {
    'android-dev':'#58a6ff','backend-dev':'#3fb950','web-dev':'#79c0ff','pipeline-dev':'#a371f7',
    ux:'#f778ba', po:'#d29922', planner:'#a371f7', architect:'#a371f7',
    guru:'#58a6ff', security:'#f85149', tester:'#d2a8ff', qa:'#3fb950', review:'#ffa657',
    linter:'#8b949e', build:'#ffa657', delivery:'#2ee6c1', commander:'#f778ba'
};
// #4196 — Rol corto por skill (segunda línea de la celda de skill). Da contexto
// sin truncar. Fallback: cadena vacía (no se muestra una segunda línea vacía).
const SKILL_ROLES = {
    'android-dev':'Compose · flavors', 'backend-dev':'Ktor · DynamoDB',
    'web-dev':'Kotlin/Wasm · PWA', 'pipeline-dev':'Node · pipeline V3',
    ux:'experiencia · diseño', po:'acceptance · criterios', planner:'estrategia · sizing',
    architect:'arquitectura · diseño técnico', guru:'investigación técnica',
    security:'OWASP · auditoría', tester:'tests · cobertura', qa:'E2E · video',
    review:'code review · PR', linter:'estilo · forbidden strings',
    build:'compilación · APK', delivery:'commit · PR · merge', commander:'orquestación'
};
// #4196 — Etiqueta legible por fase (encabezado de columna del heatmap). Las
// fases crudas vienen del slice (analisis, criterios, validacion, …). Fallback:
// capitalizar la fase cruda — nunca se trunca ni se inventa.
const FASE_LABELS = {
    analisis:'Análisis', criterios:'Criterios', sizing:'Sizing',
    validacion:'Validación', dev:'Dev', build:'Build', verificacion:'Verific.',
    linteo:'Linteo', aprobacion:'Aprob.', entrega:'Entrega'
};
function faseLabel(fase){
    if(FASE_LABELS[fase]) return FASE_LABELS[fase];
    const f = String(fase||'');
    return f ? f.charAt(0).toUpperCase()+f.slice(1) : '?';
}

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

// CSS específico de la ventana Matriz. Hereda el heatmap legacy (CA-5: cada
// estado se distingue por color + PATRÓN CSS + glifo, nunca sólo por color) y
// suma el banner de misión diagnóstico MIZPÁ (#4196) + la columna de skill con
// ícono y rol. Patrones/colores tomados de la narrativa UX y del mockup
// matriz-redesign-v1.
const MATRIZ_CSS = `
/* #4196 — Banner de misión diagnóstico (variante Matriz: acento rojo/ámbar). */
.mtx-mission { display: flex; align-items: stretch; gap: 22px; position: relative; overflow: hidden; flex-wrap: wrap;
  background: linear-gradient(110deg, rgba(248,113,113,.14), rgba(251,191,36,.08) 45%, transparent 75%), linear-gradient(180deg, var(--in-bg-2,#11151E), var(--in-bg-3,#141925));
  border: 1px solid rgba(248,113,113,.22); border-radius: 16px; padding: 18px 24px; }
/* Modo calmo: sin fase saturada → acento cian neutro, sin alarma. */
.mtx-mission.is-calm { background: linear-gradient(110deg, rgba(52,217,224,.12), rgba(124,92,255,.07) 45%, transparent 75%), linear-gradient(180deg, var(--in-bg-2,#11151E), var(--in-bg-3,#141925));
  border-color: rgba(52,217,224,.22); }
.mtx-mission::after { content: "🔲"; position: absolute; right: 18px; top: -12px; font-size: 92px; opacity: .05; pointer-events: none; }
.mtx-btag { display: flex; flex-direction: column; align-items: center; justify-content: center; min-width: 120px; padding: 12px 14px; border-radius: 14px; flex: none;
  background: linear-gradient(135deg, rgba(248,113,113,.22), rgba(251,191,36,.14)); border: 1px solid rgba(248,113,113,.34); }
.mtx-mission.is-calm .mtx-btag { background: linear-gradient(135deg, rgba(52,217,224,.22), rgba(124,92,255,.16)); border-color: rgba(52,217,224,.3); }
.mtx-btag-k { font-size: 9.5px; font-weight: 800; letter-spacing: 1.2px; color: #fca5a5; }
.mtx-mission.is-calm .mtx-btag-k { color: #9fe9ee; }
.mtx-btag-n { font-size: 36px; font-weight: 800; color: #ffe0e0; line-height: 1; font-variant-numeric: tabular-nums; }
.mtx-mission.is-calm .mtx-btag-n { color: #bff3f6; }
.mtx-btag-s { font-size: 9px; font-weight: 700; color: #fca5a5; letter-spacing: .5px; margin-top: 3px; text-align: center; }
.mtx-mission.is-calm .mtx-btag-s { color: #9fe9ee; }
.mtx-mtext { flex: 1; min-width: 300px; }
.mtx-m-ttl { font-size: 19px; font-weight: 800; display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.mtx-m-chip { font-size: 11px; color: #fca5a5; background: rgba(248,113,113,.12); border: 1px solid rgba(248,113,113,.3); padding: 3px 9px; border-radius: 20px; font-weight: 700; letter-spacing: .3px; }
.mtx-mission.is-calm .mtx-m-chip { color: #9fe9ee; background: rgba(52,217,224,.12); border-color: rgba(52,217,224,.3); }
.mtx-m-desc { font-size: 13px; color: var(--in-fg-dim,#8A93A6); margin-top: 5px; max-width: 620px; line-height: 1.45; }
.mtx-m-desc b { color: #fca5a5; font-weight: 700; }
.mtx-mission.is-calm .mtx-m-desc b { color: #9fe9ee; }
.mtx-wmetrics { display: flex; gap: 10px; margin-top: 12px; flex-wrap: wrap; }
.mtx-wm { flex: 1; min-width: 160px; background: rgba(255,255,255,.035); border: 1px solid var(--in-border,rgba(255,255,255,.07)); border-radius: 11px; padding: 9px 12px; }
.mtx-wm-l { font-size: 9.5px; font-weight: 800; letter-spacing: .7px; color: var(--in-fg-dim,#5B6376); }
.mtx-wm-v { font-size: 17px; font-weight: 800; margin-top: 3px; line-height: 1.15; font-variant-numeric: tabular-nums; }
.mtx-wm-v .u { font-size: 11px; color: var(--in-fg-dim,#5B6376); font-weight: 700; }
.mtx-wm-s { font-size: 10px; color: var(--in-fg-dim,#5B6376); margin-top: 4px; }
.mtx-mright { min-width: 250px; flex: 1; display: flex; flex-direction: column; gap: 9px; }
.mtx-reco { background: rgba(251,191,36,.07); border: 1px solid rgba(251,191,36,.26); border-radius: 12px; padding: 11px 13px; }
.mtx-mission.is-calm .mtx-reco { background: rgba(52,217,224,.06); border-color: rgba(52,217,224,.24); }
.mtx-reco-l { font-size: 9.5px; font-weight: 800; letter-spacing: .6px; color: #fcd34d; display: flex; align-items: center; gap: 6px; }
.mtx-mission.is-calm .mtx-reco-l { color: #9fe9ee; }
.mtx-reco-t { font-size: 12px; color: var(--in-fg); margin-top: 8px; line-height: 1.45; }
.mtx-reco-t b { color: #fcd34d; font-weight: 700; }
.mtx-mission.is-calm .mtx-reco-t b { color: #9fe9ee; }

/* Heatmap (heredado del legacy, #3959). */
.mtx-table { width: 100%; border-collapse: collapse; font-size: 12px; }
.mtx-table th, .mtx-table td { padding: 9px 11px; border: 1px solid var(--in-border); text-align: center; font-variant-numeric: tabular-nums; }
.mtx-table th { background: var(--in-bg-3); font-weight: 600; color: var(--in-fg-dim); text-transform: uppercase; font-size: 10px; letter-spacing: 0.6px; }
.mtx-table th.skill-h, .mtx-table td.skill { text-align: left; font-weight: 500; background: var(--in-bg-3); position: sticky; left: 0; }
/* #4196 — encabezado de la fase del cuello: resaltado como embudo. */
.mtx-table th.is-neck-col { color: var(--in-bad); }
.mtx-table th .mtx-col-flag { display: block; font-size: 8px; font-weight: 700; color: var(--in-bad); margin-top: 2px; }
/* #4196 — celda de skill con ícono + rol (nunca trunca). */
.mtx-skcell { display: flex; align-items: center; gap: 9px; }
.mtx-skic { width: 26px; height: 26px; border-radius: 8px; display: flex; align-items: center; justify-content: center; font-size: 13px; flex: none; background: rgba(255,255,255,.04); border: 1px solid var(--in-border); }
.mtx-skid { display: flex; flex-direction: column; min-width: 0; }
.mtx-skn { font-size: 12.5px; font-weight: 700; line-height: 1.1; }
.mtx-skr { font-size: 9px; color: var(--in-fg-soft); margin-top: 2px; }
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
.mtx-totals td.is-neck-col { color: var(--in-bad); }
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
.mtx-dialog-item-title { color: var(--in-fg); }
.mtx-dialog-empty { padding: 8px; color: var(--in-fg-dim); font-size: 12px; }`;

// Banner de misión diagnóstico (skeleton SSR — el cliente lo hidrata por
// textContent/createElement, XSS-safe). Arranca en modo calmo hasta el primer
// tick; los valores «—» se reemplazan con datos reales.
function renderMatrizMissionBanner() {
    return `
<div class="mtx-mission is-calm" id="mtx-mission" role="region" aria-label="Diagnóstico de carga del pipeline">
  <div class="mtx-btag">
    <div class="mtx-btag-k" id="mtx-btag-k">CARGA</div>
    <div class="mtx-btag-n" id="mtx-btag-n">—</div>
    <div class="mtx-btag-s" id="mtx-btag-s">FASES CON CARGA</div>
  </div>
  <div class="mtx-mtext">
    <div class="mtx-m-ttl">Dónde se está amontonando el trabajo
      <span class="mtx-m-chip" id="mtx-m-chip">leyendo el cuadro…</span>
    </div>
    <div class="mtx-m-desc" id="mtx-m-desc">Cada celda cuenta cuántos issues activos tiene un skill parado en una fase. Esta lectura detecta la fase saturada, el skill más cargado y dónde está el cuello.</div>
    <div class="mtx-wmetrics">
      <div class="mtx-wm">
        <div class="mtx-wm-l">📦 CARGA TOTAL</div>
        <div class="mtx-wm-v" id="mtx-wm-total">—</div>
        <div class="mtx-wm-s" id="mtx-wm-total-s">issues activos en el pipeline</div>
      </div>
      <div class="mtx-wm">
        <div class="mtx-wm-l">🚥 FASE MÁS CARGADA</div>
        <div class="mtx-wm-v" id="mtx-wm-fase">—</div>
        <div class="mtx-wm-s" id="mtx-wm-fase-s">la columna que concentra más trabajo</div>
      </div>
      <div class="mtx-wm">
        <div class="mtx-wm-l">👤 SKILL MÁS CARGADO</div>
        <div class="mtx-wm-v" id="mtx-wm-skill">—</div>
        <div class="mtx-wm-s" id="mtx-wm-skill-s">el rol con más issues a cuestas</div>
      </div>
    </div>
  </div>
  <div class="mtx-mright">
    <div class="mtx-reco">
      <div class="mtx-reco-l">💡 LECTURA AUTOMÁTICA</div>
      <div class="mtx-reco-t" id="mtx-reco-t">Esperando datos del pipeline para diagnosticar el cuello.</div>
    </div>
  </div>
</div>`;
}

// Fragmento embebible (sin shell). Lo reusa renderMatriz() (full doc) y
// renderMatrizInner() (DOM morphing del router cliente). Estructura estable:
// banner de misión + sección + leyenda (CA-C3) + contenedor `#matriz-table`.
function renderMatrizBody() {
    return `
${renderMatrizMissionBanner()}
<section class="in-section">
  <h2 class="in-section-title"><span class="in-section-title-icon">🔲</span>Matriz · skill × fase (carga actual)</h2>
  <p class="in-section-sub">Una celda alta = ese skill tiene muchos issues amontonados en esa fase. Pasá el mouse para ver los #issues; clic para abrir el detalle. La flecha indica la tendencia frente a hace 24h.</p>
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
    // ni POST. El test matriz.test.js verifica la ausencia de <form>.
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

// Script de hidratación. tickMatriz construye el heatmap (heredado del legacy
// #3959, con ícono+rol por skill #4196) y calcula el banner de misión
// diagnóstico (carga total, fase y skill más cargados, cuello + lectura).
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
    const faseName = faseLabel((faseKey.split('/')[1] || faseKey));
    document.getElementById('mtx-dialog-title').textContent = skill + ' · ' + faseName;
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

// #4196 — rellena un elemento con partes mixtas texto/negrita SIN innerHTML
// (XSS-safe). parts = [{t:'texto'}, {t:'dato', b:true}, …].
function mtxFillParts(el, parts){
    if(!el) return;
    el.textContent = '';
    for(const p of parts){
        if(p.b){
            const b = document.createElement('b');
            b.textContent = p.t;
            el.appendChild(b);
        } else {
            el.appendChild(document.createTextNode(p.t));
        }
    }
}

// #4196 — Banner de misión diagnóstico. Lee el cuadro por el operador a partir
// de los agregados ya calculados en tickMatriz. Todo dato externo (skill/fase)
// va por textContent → XSS-safe.
function renderMtxMission(d){
    const mission = document.getElementById('mtx-mission');
    if(!mission) return;
    const grandTotal = d.grandTotal || 0;
    const topFase = d.topFase;       // { key, fase, label, count, pct, trend } | null
    const topSkill = d.topSkill;     // { skill, count } | null
    const runners = d.skillRunners || []; // [{skill,count}, …]
    const neck = d.neck;             // { skill, faseKey, faseLabel, count } | null
    const hotCount = d.hotCount || 0;
    const nFasesConCarga = d.nFasesConCarga || 0;
    const nSkills = d.nSkills || 0;
    const nFases = d.nFases || 0;

    // Umbral de saturación: una fase concentra ≥40% de la carga activa total.
    const saturated = grandTotal > 0 && topFase && topFase.pct >= 40;
    mission.classList.toggle('is-calm', !saturated);

    // Tarjeta-tag (izquierda).
    if(saturated){
        setText('mtx-btag-k', 'CUELLO');
        setText('mtx-btag-n', '1');
        setText('mtx-btag-s', 'FASE SATURADA');
    } else {
        setText('mtx-btag-k', 'CARGA');
        setText('mtx-btag-n', String(nFasesConCarga));
        setText('mtx-btag-s', nFasesConCarga === 1 ? 'FASE CON CARGA' : 'FASES CON CARGA');
    }

    // Chip del título.
    if(grandTotal === 0){
        setText('mtx-m-chip', 'pipeline en calma');
    } else if(saturated){
        setText('mtx-m-chip', faseLabel(topFase.fase).toUpperCase() + ' AL ' + topFase.pct + '%');
    } else {
        setText('mtx-m-chip', 'CARGA DISTRIBUIDA');
    }

    // Descripción accionable.
    const desc = document.getElementById('mtx-m-desc');
    if(grandTotal === 0){
        if(desc) desc.textContent = 'No hay issues activos en este momento: ningún skill está parado en ninguna fase. El cuadro está vacío, sin cuello que diagnosticar.';
    } else if(saturated && neck){
        mtxFillParts(desc, [
            {t:'Cada celda cuenta cuántos issues activos tiene un skill parado en una fase. La columna '},
            {t: faseLabel(topFase.fase) + ' concentra ' + topFase.count + ' de los ' + grandTotal + ' issues', b:true},
            {t:' — es el embudo real del pipeline. El pico está en '},
            {t: neck.skill + ' × ' + neck.faseLabel + ' (' + neck.count + ')', b:true},
            {t:', marcado como cuello de botella.'},
        ]);
    } else if(saturated){
        mtxFillParts(desc, [
            {t:'La columna '},
            {t: faseLabel(topFase.fase) + ' concentra ' + topFase.count + ' de los ' + grandTotal + ' issues', b:true},
            {t:' activos (' + topFase.pct + '% del total) — es donde se está amontonando el trabajo.'},
        ]);
    } else {
        mtxFillParts(desc, [
            {t:'La carga está repartida: la fase más cargada ('},
            {t: topFase ? faseLabel(topFase.fase) : '—', b:true},
            {t:') no llega al 40% del total. No hay un cuello marcado; el flujo avanza sin embudo crítico.'},
        ]);
    }

    // Métrica 1 — carga total.
    const totalV = document.getElementById('mtx-wm-total');
    if(totalV){ totalV.textContent = ''; totalV.appendChild(document.createTextNode(fmtNum(grandTotal) + ' ')); const u=document.createElement('span'); u.className='u'; u.textContent='issues activos'; totalV.appendChild(u); }
    setText('mtx-wm-total-s', 'repartidos en ' + nFases + ' fase' + (nFases===1?'':'s') + ' · ' + nSkills + ' skill' + (nSkills===1?'':'s') + ' con carga');

    // Métrica 2 — fase más cargada.
    if(topFase){
        const faseV = document.getElementById('mtx-wm-fase');
        if(faseV) faseV.textContent = faseLabel(topFase.fase) + ' · ' + topFase.count;
        let trendTxt = '';
        if(topFase.trend === 'up') trendTxt = ' · ▲ vs 24h';
        else if(topFase.trend === 'down') trendTxt = ' · ▼ vs 24h';
        else if(topFase.trend === 'flat') trendTxt = ' · ▬ vs 24h';
        setText('mtx-wm-fase-s', topFase.pct + '% de todo lo activo' + trendTxt);
    } else {
        setText('mtx-wm-fase', '—');
        setText('mtx-wm-fase-s', 'sin carga activa');
    }

    // Métrica 3 — skill más cargado + runners.
    if(topSkill){
        const skV = document.getElementById('mtx-wm-skill');
        if(skV) skV.textContent = (SKILL_ICONS[topSkill.skill]||'⚙') + ' ' + topSkill.skill + ' · ' + topSkill.count;
        const others = runners.filter(r => r.skill !== topSkill.skill).slice(0,2);
        if(others.length){
            setText('mtx-wm-skill-s', 'seguido de ' + others.map(r => r.skill + ' (' + r.count + ')').join(' y '));
        } else {
            setText('mtx-wm-skill-s', SKILL_ROLES[topSkill.skill] || 'el rol con más issues a cuestas');
        }
    } else {
        setText('mtx-wm-skill', '—');
        setText('mtx-wm-skill-s', 'sin carga activa');
    }

    // Lectura automática (recomendación).
    const reco = document.getElementById('mtx-reco-t');
    if(grandTotal === 0){
        if(reco) reco.textContent = 'Nada que destrabar: aprovechá para mergear lo pendiente o sumar trabajo nuevo al pipeline.';
    } else if(saturated && neck){
        const isDev = neck.fase === 'dev';
        if(isDev){
            mtxFillParts(reco, [
                {t:'El embudo está en '},
                {t:'desarrollo', b:true},
                {t:'. Sumar capacidad de '},
                {t: neck.skill, b:true},
                {t:' ahí destraba el ' + topFase.pct + '% del backlog.'},
            ]);
        } else {
            mtxFillParts(reco, [
                {t:'El embudo no es de '},
                {t:'dev', b:true},
                {t:': es de '},
                {t: faseLabel(neck.fase).toLowerCase(), b:true},
                {t:'. Reforzar '},
                {t: neck.skill, b:true},
                {t:' ahí destraba el ' + topFase.pct + '% del backlog.'},
            ]);
        }
    } else if(saturated && topFase){
        mtxFillParts(reco, [
            {t:'La fase '},
            {t: faseLabel(topFase.fase), b:true},
            {t:' concentra el ' + topFase.pct + '% del trabajo. Reforzá los skills de esa columna para destrabar el flujo.'},
        ]);
    } else {
        if(reco) reco.textContent = 'Sin cuello marcado: el trabajo fluye repartido entre fases. Seguí monitoreando la tendencia vs 24h.';
    }
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
    let neckKey = null, neckScore = -1, neckAge = -1, neckN = 0;
    for(const { pipeline: p, fase } of fases){
        const fk = p+'/'+fase;
        for(const sk of allSkills){
            const n = (counts[fk]||{})[sk] || 0;
            if(n <= 0) continue;
            const a = (ageAvg[fk]||{})[sk] || 0;
            const score = n * a;
            if(score > neckScore || (score === neckScore && a > neckAge)){
                neckScore = score; neckAge = a; neckKey = fk+'\\u0000'+sk; neckN = n;
            }
        }
    }

    // #4196 — Agregados para el banner de misión diagnóstico.
    // Fase más cargada (key con mayor total) + su tendencia (suma de baselines).
    let topFaseKey = null, topFaseCount = -1;
    for(const { pipeline: p, fase } of fases){
        const fk = p+'/'+fase;
        if(totalsByFase[fk] > topFaseCount){ topFaseCount = totalsByFase[fk]; topFaseKey = fk; }
    }
    let topFase = null;
    if(topFaseKey && topFaseCount > 0){
        const faseName = topFaseKey.split('/')[1] || topFaseKey;
        let curSum = 0, baseSum = 0, hasBase = false;
        for(const sk of allSkills){
            curSum += (counts[topFaseKey]||{})[sk] || 0;
            const b = (trend[topFaseKey]||{})[sk];
            if(typeof b === 'number'){ baseSum += b; hasBase = true; }
        }
        let ftrend = null;
        if(hasBase){ ftrend = curSum > baseSum ? 'up' : (curSum < baseSum ? 'down' : 'flat'); }
        topFase = { key: topFaseKey, fase: faseName, count: topFaseCount,
            pct: grandTotal > 0 ? Math.round((topFaseCount/grandTotal)*100) : 0, trend: ftrend };
    }
    // Skill más cargado + runners (top 3 por total).
    const skillRunners = allSkills
        .filter(sk => totalsBySkill[sk] > 0)
        .map(sk => ({ skill: sk, count: totalsBySkill[sk] }))
        .sort((a,b) => b.count - a.count)
        .slice(0, 3);
    const topSkill = skillRunners.length ? skillRunners[0] : null;
    // Cuello desarmado en sus partes.
    let neck = null;
    if(neckKey){
        const [fk, sk] = neckKey.split('\\u0000');
        const faseName = fk.split('/')[1] || fk;
        neck = { skill: sk, faseKey: fk, fase: faseName, faseLabel: faseLabel(faseName), count: neckN };
    }
    // Conteo de celdas en carga alta (n>=5).
    let hotCount = 0, nFasesConCarga = 0;
    for(const { pipeline: p, fase } of fases){
        const fk = p+'/'+fase;
        if(totalsByFase[fk] > 0) nFasesConCarga++;
        for(const sk of allSkills){ if(((counts[fk]||{})[sk]||0) >= 5) hotCount++; }
    }
    const nSkills = skillRunners.length;
    renderMtxMission({
        grandTotal, topFase, topSkill, skillRunners, neck, hotCount,
        nFasesConCarga, nSkills, nFases: fases.length,
    });

    // ----- Heatmap -----
    let html = '<table class="mtx-table"><thead><tr><th class="skill-h">Skill</th>';
    for(const { pipeline: p, fase } of fases){
        const fk = p+'/'+fase;
        const isNeckCol = neck && neck.faseKey === fk;
        const flag = isNeckCol ? '<span class="mtx-col-flag">⚠ embudo</span>' : '';
        html += '<th class="'+(isNeckCol?'is-neck-col':'')+'" title="'+escapeHtml(p+'/'+fase)+'">'+escapeHtml(faseLabel(fase))+flag+'</th>';
    }
    html += '<th title="Total de issues activos del skill en todas las fases">Total</th></tr></thead><tbody>';
    // Solo mostrar skills con al menos 1 issue activo (los demás son ruido).
    const visibleSkills = allSkills.filter(sk => totalsBySkill[sk] > 0);
    if(visibleSkills.length === 0){
        html += '<tr><td colspan="'+(fases.length+2)+'"><div class="in-empty">Sin issues activos en este momento</div></td></tr>';
    } else {
        for(const skill of visibleSkills){
            // #4196 — celda de skill con ícono + rol (nunca trunca).
            const color = SKILL_COLORS[skill] || 'var(--in-fg-dim)';
            const icon = SKILL_ICONS[skill] || '⚙';
            const role = SKILL_ROLES[skill] || '';
            const roleHtml = role ? '<span class="mtx-skr">'+escapeHtml(role)+'</span>' : '';
            html += '<tr><td class="skill"><div class="mtx-skcell">'
                + '<span class="mtx-skic" style="color:'+color+'">'+icon+'</span>'
                + '<span class="mtx-skid"><span class="mtx-skn">'+escapeHtml(skill)+'</span>'+roleHtml+'</span>'
                + '</div></td>';
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
                    const faseNm = faseLabel(fase);
                    const tip = n+' issue'+(n===1?'':'s')+' de '+escapeHtml(skill)+' en '+escapeHtml(faseNm)+(isNeck?' — cuello de botella':'');
                    const alabel = escapeHtml(skill)+' en '+escapeHtml(faseNm)+', '+n+' issue'+(n===1?'':'s')+', abrir detalle';
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
    html += '<tr class="mtx-totals"><td>Total por fase</td>';
    for(const { pipeline: p, fase } of fases){
        const fk = p+'/'+fase;
        const isNeckCol = neck && neck.faseKey === fk;
        html += '<td class="'+(isNeckCol?'is-neck-col':'')+'" title="Total de issues activos en '+escapeHtml(p+'/'+fase)+'">'+(totalsByFase[fk] || 0)+'</td>';
    }
    html += '<td>'+grandTotal+'</td></tr>';
    html += '</tbody></table>';
    if(c.innerHTML !== html) c.innerHTML = html;
}
// #4241 — Hidratación del banner de ola común (② del marco MIZPÁ). Espeja
// /api/dash/waves a los IDs mission-* del banner compartido. Mismo cálculo que
// el tickMission compartido de las hermanas (satellites.js). Defensivo: si el
// banner no está montado (el deep-link a /matriz sí lo monta; el morphing del
// router lo deja en el shell del host), los getElementById son no-op y no rompen
// la pantalla. No interpola HTML de datos externos (textContent/innerHTML de
// literales controlados) — XSS-safe.
async function tickMission(){
    const d = await fetchJson('/api/dash/waves');
    if(!d) return;
    try {
        const wave = d.active_wave;
        if(!wave){
            setText('mission-wave-num', '—');
            setText('mission-wave-name', 'Sin ola activa');
            setText('mission-wave-desc', 'Esperando la planificación de la ola activa.');
            return;
        }
        if(Number.isFinite(wave.number)) setText('mission-wave-num', String(wave.number));
        setText('mission-wave-name', wave.name ? ('Ola ' + wave.number + ' · ' + wave.name) : ('Ola ' + wave.number));
        setText('mission-wave-desc', wave.goal || wave.description || ('Issues de la ola ' + wave.number + ' en curso.'));
        const tag = document.getElementById('mission-wave-tag');
        if(tag) tag.style.display = wave.isLast ? '' : 'none';
        const issues = Array.isArray(wave.issues) ? wave.issues : [];
        let done=0, active=0, blocked=0, queue=0;
        for(const it of issues){
            const s = it && it.status;
            if(s === 'completed') done++;
            else if(s === 'in-progress') active++;
            else if(s === 'blocked') blocked++;
            else queue++;
        }
        const total = issues.length || 0;
        // #4296 — avance % lo hidrata el accessor compartido (/api/dash/ola-eta);
        // acá sólo leyenda/barras/entregados desde los conteos de la ola.
        setText('mission-leg-done', String(done));
        setText('mission-leg-active', String(active));
        setText('mission-leg-blocked', String(blocked));
        setText('mission-leg-queue', String(queue));
        const w = (n) => total>0 ? ((n/total)*100).toFixed(1)+'%' : '0%';
        const setW = (id,n) => { const el=document.getElementById(id); if(el) el.style.width = w(n); };
        setW('mission-bar-done', done);
        setW('mission-bar-active', active);
        setW('mission-bar-blocked', blocked);
        setW('mission-bar-queue', queue);
        const dv = document.getElementById('mission-delivered-value');
        if(dv) dv.innerHTML = done + '<span class="mz-wm-u"> / ' + total + '</span>';
        const dsub = document.getElementById('mission-delivered-sub');
        if(dsub) dsub.textContent = Math.max(0, total-done) + ' restantes';
        // #4296 — velocidad (%/h) y ETA los hidrata el accessor compartido desde
        // /api/dash/ola-eta (ritmo determinístico de la ola), no desde openedAt.
    } catch(_) {}
}
const POLLS = [{ fn: tickHeader, ms: 5000 }, { fn: tickMission, ms: 30000 }, { fn: tickMatriz, ms: 30000 }];
async function runAll(){ for(const p of POLLS){ try{ await p.fn(); } catch{} } }
runAll();
for(const p of POLLS){ setInterval(() => { p.fn().catch(()=>{}); }, p.ms); }
${missionOlaEtaClientScript()}`;

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
 * Documento SSR completo de la ventana Matriz. #4196 — hereda el shell MIZPÁ:
 * barra de marca MIZPÁ + nav curada 5+«⋯ Más» (Matriz dentro del popover) +
 * miga de pan «⋯ Más › 🔲 Matriz». Replica la estructura inline siguiendo el
 * patrón de las hermanas para no depender del monolito en demolición.
 */
function renderMatriz() {
    const theme = loadTheme();
    const spriteInline = loadIconSprite();
    const navHtml = renderNavTabsSsr(slug);
    const brandHtml = renderMatrizBrandBar();
    // #4241 — ② Cabecera de ola común del marco MIZPÁ, entre el header (①) y la
    // nav (③), respetando el orden del marco (idéntico al pageShell de las
    // hermanas). El banner se sirve neutro en SSR; lo hidrata tickMission desde
    // /api/dash/waves. Si el módulo común no cargó, `olaBanner` es '' (degrada
    // sin banner, no rompe el layout).
    const olaBanner = renderOlaBannerComun();
    // Miga de pan: Matriz vive dentro de «⋯ Más» (tab secundario). La nav ya
    // deja el popover abierto + Matriz marcada vía renderNavTabsSsr('matriz');
    // la miga refuerza la ubicación (CA-1).
    const breadcrumb = `
  <div class="mz-crumb" aria-label="Ubicación: Más › Matriz">
    <span class="mz-crumb-sep">⋯ Más</span>
    <span class="mz-crumb-sep">›</span>
    <b>🔲 Matriz</b>
    <span class="mz-crumb-desc">· carga de cada skill por fase del pipeline</span>
  </div>`;
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
/* #4241 — El banner de ola común (② del marco) vive fuera del .satellite-body
   (entre header y nav), igual que en el pageShell de las hermanas; se alinea con
   el padding horizontal del cuerpo. */
.satellite-frame > .mz-mission { margin: 18px 28px 0; }
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
    ${brandHtml}
    <div class="in-header-meta">
      <span class="in-pill" id="hdr-mode">…</span>
      <span class="in-clock" id="hdr-clock">…</span>
    </div>
  </header>
  ${olaBanner}
  ${navHtml}
  ${breadcrumb}
  <main class="satellite-body">${renderMatrizInner()}</main>
  <footer class="in-footer">
    <span>Refresh independiente · sin flicker</span>
    <span>Intrale V3 · MIZPÁ</span>
  </footer>
</div>
</body>
</html>`;
}

module.exports = {
    renderMatriz,
    renderMatrizInner,
    renderMatrizBrandBar,
    renderMatrizMissionBanner,
    slug,
    escapeHtmlSsr,
    MATRIZ_CSS,
};
