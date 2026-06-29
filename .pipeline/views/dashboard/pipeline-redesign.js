'use strict';

// =============================================================================
// pipeline-redesign.js — Rediseño integral de la pantalla PIPELINE (#4190,
// Ola 7.1, centro de mando «MIZPÁ»).
//
// Continúa el lenguaje visual MIZPÁ ya entregado en la HOME (#4189/#4204) y
// COSTOS (#4206): marca + tagline, selector multiproyecto, banner de misión de
// la ola y nav curada + «⋯ Más» (esta última la provee el shell satélite vía
// renderNavTabsSsr — acá NO se re-renderiza la nav).
//
// La pantalla se reorganiza en DOS bloques (mockup `pipeline-redesign-v1`):
//   1. FLUJO DE FASES: las 6 etapas macro (Definición → Desarrollo → Build →
//      QA E2E → Review/PO → Entregado) conectadas con flechas, cada una con su
//      contador. Las fases vacías quedan ATENUADAS, sin abrir columna.
//   2. ISSUES POR FASE: kanban real SOLO de las fases activas, con columnas
//      anchas. Las tarjetas muestran el TÍTULO COMPLETO (wrap, sin «…») y se
//      listan SIEMPRE todos los issues (sin «+X más», sin slice/truncado).
//
// DECISIONES DE DISEÑO:
//   - SSR del esqueleto + hidratación client-side (preserva la vista en vivo del
//     kiosko, polling 5s sobre /api/dash/pipeline y /api/dash/waves — los mismos
//     endpoints que ya consume el dashboard, sin nuevos contratos de API).
//   - La fuente de verdad del mapeo fase→macro es PHASE_FLOW (única). El cliente
//     recibe PHASE_LOOKUP serializado del MISMO array para no divergir.
//   - CSS scoped al `#pl-redesign` + clases mz-* propias. Se replica el set
//     mínimo de estilos MIZPÁ (brand bar + mission banner) que hoy viven inline
//     en home.js (no en theme.css) para no tocar el stylesheet compartido — la
//     regla "el pipeline no puede morir" pesa más que el de-dup de CSS. Un
//     refactor futuro puede hoistear estas clases a theme.css.
//   - Todo dato dinámico que se interpola en SSR pasa por escapeHtmlText/Attr; la
//     hidratación client-side usa el escapeHtml de commonHelpers().
// =============================================================================

let escapeHtmlText;
let escapeHtmlAttr;
try {
    ({ escapeHtmlText, escapeHtmlAttr } = require('../../lib/escape-html.js'));
} catch (_) {
    const escText = (s) => (s === null || s === undefined ? '' : String(s))
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const escAttr = (s) => (s === null || s === undefined ? '' : String(s))
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/`/g, '&#96;');
    escapeHtmlText = escText;
    escapeHtmlAttr = escAttr;
}

// --- Mapeo macro de fases (fuente única) -------------------------------------
// Cada etapa macro agrupa una o más `pipeline/fase` reales (config.yaml). El
// orden del array ES el orden del flujo izquierda→derecha del mockup.
const PHASE_FLOW = [
    { key: 'def',    label: 'Definición',  sub: 'análisis · criterios · sizing', icon: '📐',
      subFases: ['definicion/analisis', 'definicion/criterios', 'definicion/sizing'] },
    { key: 'dev',    label: 'Desarrollo',  sub: 'validación · dev',              icon: '⚙️',
      subFases: ['desarrollo/validacion', 'desarrollo/dev'] },
    { key: 'build',  label: 'Build',       sub: 'gradle check',                  icon: '🔨',
      subFases: ['desarrollo/build'] },
    { key: 'qa',     label: 'QA E2E',      sub: 'verificación · linteo',          icon: '🧪',
      subFases: ['desarrollo/verificacion', 'desarrollo/linteo'] },
    { key: 'review', label: 'Review / PO', sub: 'aprobación',                    icon: '🔍',
      subFases: ['desarrollo/aprobacion'] },
    { key: 'done',   label: 'Entregado',   sub: 'entrega · merge',               icon: '📦',
      subFases: ['desarrollo/entrega'] },
];

// Lookup 'pipeline/fase' -> key macro. Derivado de PHASE_FLOW (single source).
const PHASE_LOOKUP = (() => {
    const m = {};
    for (const p of PHASE_FLOW) {
        for (const f of p.subFases) m[f] = p.key;
    }
    return m;
})();

// Pura y testeable: dada una `pipeline/fase`, devuelve la etapa macro o null.
function macroPhaseOf(faseKey) {
    if (!faseKey) return null;
    return PHASE_LOOKUP[String(faseKey)] || null;
}

// Progreso determinístico por posición de la etapa macro en el flujo. Honesto
// (no inventa fracciones intra-fase): def=0% … done=100%. Pura y testeable.
function phaseProgressPct(macroKey) {
    const idx = PHASE_FLOW.findIndex((p) => p.key === macroKey);
    if (idx < 0) return 0;
    const last = PHASE_FLOW.length - 1;
    return last <= 0 ? 100 : Math.round((idx / last) * 100);
}

// --- Brand bar MIZPÁ (estático) ----------------------------------------------
// Reusa el markup/contrato de home.js renderBrandBar (#4189): logo + nombre +
// tagline + selector multiproyecto. El pill de build (#bld-status) se conserva
// para el ticker tickHeader del shell satélite.
function renderBrandBarPipeline() {
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
      <div class="mz-projsel" id="mz-projsel" role="button" tabindex="0"
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
      <span class="in-pill in-pill-info in-build-status" id="bld-status"
            title="Estado del último build (marker local .pipeline/build-status.json).">○ Build ?</span>
    </div>`;
}

// --- Banner de misión (Ola) --------------------------------------------------
// Mismos IDs que home.js renderMissionBanner para reusar la hidratación desde
// /api/dash/waves (mirrorMission en el client script).
function renderMissionBannerPipeline() {
    return `
    <section class="mz-mission" id="mz-mission" aria-label="Misión de la ola activa"
             title="Ola activa del plan: avance, ritmo de entrega y cierre estimado.">
      <div class="mz-wavetag" title="Número de la ola activa.">
        <span class="mz-wavetag-k">OLA</span>
        <span class="mz-wavetag-n" id="mission-wave-num">—</span>
      </div>
      <div class="mz-mission-text">
        <div class="mz-mission-ttl">
          <span id="mission-wave-name">Sin ola activa</span>
          <span class="mz-mission-badge" id="mission-wave-tag" style="display:none"
                title="Marca contextual de la ola (p. ej. última del plan).">ÚLTIMA DEL PLAN</span>
        </div>
        <div class="mz-mission-desc" id="mission-wave-desc">Cada issue de la ola recorre el flujo de fases de izquierda a derecha. Acá ves dónde está parado cada uno.</div>
        <div class="mz-mission-metrics">
          <div class="mz-wm" title="Tiempo estimado para cerrar la ola (proyección por velocidad de entrega).">
            <div class="mz-wm-l">⏳ ETA DE LA OLA</div>
            <div class="mz-wm-v" id="mission-eta-value">—</div>
            <div class="mz-wm-s" id="mission-eta-sub">cierre estimado</div>
          </div>
          <div class="mz-wm" title="Velocidad de entrega: issues cerrados por hora (media reciente).">
            <div class="mz-wm-l">🚀 VELOCIDAD</div>
            <div class="mz-wm-v" id="mission-vel-value">— <span class="mz-wm-u">iss/h</span></div>
            <div class="mz-wm-s">media reciente</div>
          </div>
          <div class="mz-wm" title="Issues entregados sobre el total de la ola.">
            <div class="mz-wm-l">📦 ENTREGADOS</div>
            <div class="mz-wm-v" id="mission-delivered-value">—<span class="mz-wm-u"> / —</span></div>
            <div class="mz-wm-s" id="mission-delivered-sub">restantes</div>
          </div>
        </div>
      </div>
      <div class="mz-mission-prog" title="Avance total de la ola, desglosado por estado de sus issues.">
        <div class="mz-prog-head"><span>AVANCE</span><span class="mz-prog-pct" id="mission-avance-pct">0%</span></div>
        <div class="mz-prog-bar">
          <i id="mission-bar-done" style="width:0%;background:var(--in-ok,#3fb950)"></i>
          <i id="mission-bar-active" style="width:0%;background:var(--in-info,#58a6ff)"></i>
          <i id="mission-bar-blocked" style="width:0%;background:var(--in-bad,#f85149)"></i>
          <i id="mission-bar-queue" style="width:0%;background:rgba(255,255,255,.10)"></i>
        </div>
        <div class="mz-prog-legend">
          <span><i class="mz-dot" style="background:var(--in-ok,#3fb950)"></i> <b id="mission-leg-done">0</b> hechos</span>
          <span><i class="mz-dot" style="background:var(--in-info,#58a6ff)"></i> <b id="mission-leg-active">0</b> activos</span>
          <span><i class="mz-dot" style="background:var(--in-bad,#f85149)"></i> <b id="mission-leg-blocked">0</b> bloq.</span>
          <span><i class="mz-dot" style="background:rgba(255,255,255,.25)"></i> <b id="mission-leg-queue">0</b> cola</span>
        </div>
      </div>
    </section>`;
}

// --- Bloque 1: Flujo de fases (SSR del esqueleto) ----------------------------
// Las 6 etapas con flechas y un contador por etapa (id `pflow-c-<key>`). El
// estado ATENUADO (sin issues) lo aplica el client al hidratar los contadores.
function renderPhaseFlowSsr() {
    const nodes = PHASE_FLOW.map((p, i) => {
        const arrow = i > 0
            ? '<div class="pflow-arrow" aria-hidden="true">→</div>'
            : '';
        const tip = 'Etapa ' + p.label + ' (' + p.subFases.join(', ') + '). El número es la cantidad de issues de la ola en esta etapa.';
        return arrow
            + '<div class="pflow-node pflow-empty" id="pflow-n-' + p.key + '" data-key="' + p.key + '"'
            + ' title="' + escapeHtmlAttr(tip) + '">'
            +   '<div class="pflow-top"><span class="pflow-ic" aria-hidden="true">' + p.icon + '</span>'
            +     '<span class="pflow-count" id="pflow-c-' + p.key + '">0</span></div>'
            +   '<div class="pflow-label">' + escapeHtmlText(p.label) + '</div>'
            +   '<div class="pflow-sub">' + escapeHtmlText(p.sub) + '</div>'
            + '</div>';
    }).join('');

    return `
  <section class="pl-block" id="pl-block-flow" aria-label="Flujo de fases de la ola">
    <div class="pl-block-head">
      <h2 class="pl-block-title"><span class="pl-block-ic" aria-hidden="true">🌊</span>Flujo de fases · <span id="pl-flow-ola">Ola actual</span></h2>
      <div class="pl-allowlist-toggle" id="pl-allowlist-toggle" role="switch"
           aria-checked="false" tabindex="0"
           title="Mostrar sólo los issues incluidos en la ola activa (allowlist de la pausa parcial)."
           style="display:none">
        <span class="pl-toggle-track"><span class="pl-toggle-thumb"></span></span>
        <span class="pl-toggle-label">Solo issues de la ola</span>
      </div>
    </div>
    <div class="pflow" id="pl-phase-flow">${nodes}</div>
  </section>`;
}

// --- Bloque 2: Vista total de la ola (contenedor, hidratado client-side) -----
// #4234 — La sección pasa de "issues por fase activa" (solo lo que tiene agente)
// a la VISTA TOTAL DE LA OLA: todos los hijos de la ola, incluidos entregados y
// los de definición sin arrancar, agrupados por fase. La leyenda explica los 7
// íconos de agentes y sus 3 estados (ejecutado / en curso / pendiente).
function renderIssuesByPhaseSsr() {
    return `
  <section class="pl-block" id="pl-block-issues" aria-label="Vista total de la ola — hijos por fase">
    <div class="pl-block-head">
      <h2 class="pl-block-title"><span class="pl-block-ic" aria-hidden="true">🗂️</span>Vista total de la ola · hijos por fase</h2>
      <span class="pl-block-sub" id="pl-issues-sub" title="Todos los hijos de la ola (incluidos entregados y los de definición sin arrancar). Solo se dibujan las columnas de fases con issues; el conteo total vive en el Flujo de fases.">—</span>
    </div>
    <div id="pipeline-cols" class="pl-cols">
      <div class="pl-cols-loading">Cargando hijos de la ola…</div>
    </div>
    ${renderAgentsLegendSsr()}
  </section>`;
}

// --- Leyenda de agentes + estados (CA-6) -------------------------------------
// Estática (no depende de datos). Los 7 agentes del flujo y los 3 estados
// visuales. Se mantiene en sincronía con PL_AGENTS7 del client script.
function renderAgentsLegendSsr() {
    const ags = [
        ['🧠', 'Guru'], ['📋', 'Doc/PO'], ['⚙', 'Dev'], ['🔨', 'Builder'],
        ['▶', 'QA'], ['🔍', 'Review'], ['🚀', 'Delivery'],
    ];
    const agItems = ags.map(([ic, lbl]) =>
        '<span class="pl-leg-i"><span class="plc-ag legdemo">' + escapeHtmlText(ic) + '</span>'
        + escapeHtmlText(lbl) + '</span>').join('');
    return `
    <div class="pl-legend-box" aria-label="Leyenda de agentes y estados">
      <span class="pl-leg-t">AGENTES</span>${agItems}
      <span class="pl-leg-sep" aria-hidden="true"></span>
      <span class="pl-leg-t">ESTADO</span>
      <span class="pl-leg-i"><span class="plc-ag done" aria-hidden="true"></span>Ejecutado</span>
      <span class="pl-leg-i"><span class="plc-ag now" aria-hidden="true"></span>En curso</span>
      <span class="pl-leg-i"><span class="plc-ag pend" aria-hidden="true"></span>Pendiente</span>
    </div>`;
}

// --- Cuerpo completo de la pantalla ------------------------------------------
function renderPipelineRedesignBody() {
    return `
<div id="pl-redesign" class="pl-redesign">
  ${renderMissionBannerPipeline()}
  ${renderPhaseFlowSsr()}
  ${renderIssuesByPhaseSsr()}
  <div class="pl-legend" title="Convenciones de la pantalla.">
    El Flujo de fases conserva siempre las 6 fases con su conteo (incluso las que están en 0). La vista total de abajo dibuja todos los hijos de la ola —entregados y los de definición sin arrancar incluidos— y solo abre columna para las fases con issues, repartiendo el ancho entre las que quedan. Nunca se trunca el título ni se resume la lista.
  </div>
</div>`;
}

// --- CSS scoped --------------------------------------------------------------
const PIPELINE_REDESIGN_CSS = `
/* #4190 — Rediseño PIPELINE MIZPÁ. Scoped a #pl-redesign + clases mz-* propias. */
.pl-redesign { display: flex; flex-direction: column; gap: 16px; }

/* Marca MIZPÁ (replicado de home.js — no está en theme.css). */
.in-header-brand { display: flex; align-items: center; gap: 13px; flex-wrap: wrap; }
.mz-logo { width: 44px; height: 44px; border-radius: 13px; flex: none;
    background: linear-gradient(135deg, var(--brand-cyan,#34D9E0), #7C5CFF 90%);
    display: flex; align-items: center; justify-content: center; box-shadow: 0 8px 24px rgba(124,92,255,.28); }
.mz-logo svg { width: 25px; height: 25px; }
.mz-id { display: flex; flex-direction: column; }
.mz-name { font-size: 20px; font-weight: 800; line-height: 1; letter-spacing: 1px;
    background: linear-gradient(90deg,#bff3f6,#c9bcff); -webkit-background-clip: text; background-clip: text; color: transparent; }
.mz-sub { font-size: 10px; color: var(--in-fg-dim,#8A93A6); font-weight: 600; letter-spacing: 1.1px; margin-top: 5px; }
.mz-projsel { display: flex; align-items: center; gap: 11px; background: var(--in-bg-2,#11151E);
    border: 1px solid var(--in-border,rgba(255,255,255,.12)); border-radius: 13px; padding: 7px 9px 7px 12px; margin-left: 4px; cursor: pointer; }
.mz-projsel:focus-visible { outline: 2px solid var(--in-focus,#38bdf8); outline-offset: 2px; }
.mz-proj-avatar { width: 28px; height: 28px; border-radius: 9px; flex: none; color: #06121a; font-weight: 800; font-size: 14px;
    background: linear-gradient(135deg,#34D9E0,#5A8DEE); display: flex; align-items: center; justify-content: center; }
.mz-proj-id { display: flex; flex-direction: column; }
.mz-proj-name { font-size: 13.5px; font-weight: 800; line-height: 1.05; }
.mz-proj-state { font-size: 9px; color: var(--in-fg-dim,#5B6376); font-weight: 700; letter-spacing: .4px; margin-top: 2px; }
.mz-proj-badge { font-size: 10px; font-weight: 800; color: #9fe9ee; background: rgba(52,217,224,.12);
    border: 1px solid rgba(52,217,224,.3); border-radius: 8px; padding: 3px 8px; }
.mz-proj-caret { color: var(--in-fg-dim,#8A93A6); font-size: 12px; }

/* Banner de misión (replicado de home.js). */
.mz-mission { display: flex; align-items: center; gap: 22px; position: relative; overflow: hidden;
    background: linear-gradient(110deg, rgba(52,217,224,.14), rgba(124,92,255,.08) 45%, transparent 75%),
                linear-gradient(180deg, var(--in-bg-2,#11151E), var(--in-bg-3,#141925));
    border: 1px solid rgba(52,217,224,.22); border-radius: 16px; padding: 18px 24px; }
.mz-mission::after { content: "🌊"; position: absolute; right: 18px; top: -14px; font-size: 90px; opacity: .06; }
.mz-wavetag { display: flex; flex-direction: column; align-items: center; justify-content: center; min-width: 92px;
    padding: 10px 14px; border-radius: 14px; flex: none;
    background: linear-gradient(135deg, rgba(52,217,224,.22), rgba(124,92,255,.16)); border: 1px solid rgba(52,217,224,.3); }
.mz-wavetag-k { font-size: 10px; font-weight: 800; letter-spacing: 1.5px; color: #9fe9ee; }
.mz-wavetag-n { font-size: 34px; font-weight: 800; color: #bff3f6; line-height: 1; font-variant-numeric: tabular-nums; }
.mz-mission-text { flex: 1; min-width: 0; }
.mz-mission-ttl { font-size: 19px; font-weight: 800; display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.mz-mission-badge { font-size: 11px; color: var(--brand-cyan,#34D9E0); background: rgba(52,217,224,.12);
    border: 1px solid rgba(52,217,224,.3); padding: 3px 9px; border-radius: 20px; font-weight: 700; letter-spacing: .3px; }
.mz-mission-desc { font-size: 13px; color: var(--in-fg-dim,#8A93A6); margin-top: 5px; max-width: 620px; line-height: 1.45; }
.mz-mission-metrics { display: flex; gap: 10px; margin-top: 12px; flex-wrap: wrap; }
.mz-wm { flex: 1; min-width: 150px; background: rgba(255,255,255,.035); border: 1px solid var(--in-border,rgba(255,255,255,.07));
    border-radius: 11px; padding: 9px 12px; }
.mz-wm-l { font-size: 9.5px; font-weight: 800; letter-spacing: .7px; color: var(--in-fg-dim,#5B6376); }
.mz-wm-v { font-size: 17px; font-weight: 800; margin-top: 3px; line-height: 1; font-variant-numeric: tabular-nums; }
.mz-wm-u { font-size: 11px; color: var(--in-fg-dim,#5B6376); font-weight: 600; }
.mz-wm-s { font-size: 10px; color: var(--in-fg-dim,#5B6376); margin-top: 3px; }
.mz-mission-prog { min-width: 260px; }
.mz-prog-head { display: flex; align-items: baseline; justify-content: space-between; font-size: 11.5px; color: var(--in-fg-dim,#8A93A6); font-weight: 600; }
.mz-prog-pct { font-size: 26px; font-weight: 800; color: var(--brand-cyan,#34D9E0); font-variant-numeric: tabular-nums; }
.mz-prog-bar { height: 8px; border-radius: 6px; background: rgba(255,255,255,.07); overflow: hidden; display: flex; margin: 9px 0 8px; }
.mz-prog-bar i { height: 100%; transition: width .4s ease; }
.mz-prog-legend { display: flex; gap: 14px; font-size: 11px; color: var(--in-fg-dim,#8A93A6); flex-wrap: wrap; }
.mz-prog-legend span { display: flex; align-items: center; gap: 5px; }
.mz-prog-legend b { font-variant-numeric: tabular-nums; }
.mz-dot { width: 7px; height: 7px; border-radius: 50%; display: inline-block; flex: none; }

/* Bloques. */
.pl-block { background: linear-gradient(180deg, var(--in-bg-2,#11151E), var(--in-bg-3,#141925));
    border: 1px solid var(--in-border,rgba(255,255,255,.07)); border-radius: 16px; padding: 16px 18px; }
.pl-block-head { display: flex; align-items: center; gap: 12px; margin-bottom: 14px; flex-wrap: wrap; }
.pl-block-title { font-size: 13px; font-weight: 800; letter-spacing: .6px; text-transform: uppercase;
    color: var(--in-fg,#e6edf3); margin: 0; display: flex; align-items: center; gap: 8px; }
.pl-block-ic { font-size: 15px; }
.pl-block-sub { margin-left: auto; font-size: 11px; color: var(--in-fg-dim,#8A93A6); font-variant-numeric: tabular-nums; }

/* Toggle "Solo issues de la ola". */
.pl-allowlist-toggle { margin-left: auto; display: inline-flex; align-items: center; gap: 8px; font-size: 11px;
    color: var(--in-fg-dim,#8A93A6); cursor: pointer; user-select: none; border-radius: 999px; padding: 4px 8px; transition: color .15s, background .15s; }
.pl-allowlist-toggle:hover { color: var(--in-fg); background: var(--in-bg-3); }
.pl-allowlist-toggle:focus-visible { outline: 2px solid var(--in-accent); outline-offset: 2px; }
.pl-allowlist-toggle[aria-checked="true"] { color: var(--in-ok); }
.pl-toggle-track { width: 28px; height: 14px; background: var(--in-bg-3); border: 1px solid var(--in-border); border-radius: 999px; position: relative; transition: background .15s, border-color .15s; flex: 0 0 28px; }
.pl-allowlist-toggle[aria-checked="true"] .pl-toggle-track { background: var(--in-ok-soft); border-color: var(--in-ok); }
.pl-toggle-thumb { position: absolute; top: 1px; left: 1px; width: 10px; height: 10px; background: var(--in-fg-soft); border-radius: 50%; transition: left .15s, background .15s; }
.pl-allowlist-toggle[aria-checked="true"] .pl-toggle-thumb { left: 15px; background: var(--in-ok); }

/* Bloque 1: flujo de fases (flex con flechas, sin scroll forzado). */
.pflow { display: flex; align-items: stretch; gap: 8px; flex-wrap: wrap; }
.pflow-arrow { display: flex; align-items: center; color: var(--in-fg-soft,#5B6376); font-size: 18px; flex: none; }
.pflow-node { flex: 1 1 120px; min-width: 120px; background: var(--in-bg-3,#141925);
    border: 1px solid var(--in-border,rgba(255,255,255,.10)); border-left: 3px solid var(--in-accent,#34D9E0);
    border-radius: 12px; padding: 11px 13px; transition: opacity .2s, border-color .2s; }
.pflow-node.pflow-empty { opacity: .4; border-left-color: var(--in-border,rgba(255,255,255,.10)); }
.pflow-node.pflow-active { box-shadow: 0 0 0 1px rgba(52,217,224,.25) inset; }
.pflow-top { display: flex; align-items: center; justify-content: space-between; }
.pflow-ic { font-size: 16px; }
.pflow-count { font-size: 24px; font-weight: 800; font-variant-numeric: tabular-nums; color: var(--in-fg,#e6edf3); }
.pflow-label { font-size: 13px; font-weight: 700; margin-top: 6px; color: var(--in-fg,#e6edf3); }
.pflow-sub { font-size: 10px; color: var(--in-fg-dim,#8A93A6); margin-top: 2px; }

/* Bloque 2: columnas anchas SOLO de fases activas. Sin overflow-x forzado:
   wrap a la siguiente línea en pantallas chicas (nunca columnas vacías). */
.pl-cols { display: flex; gap: 14px; flex-wrap: wrap; align-items: flex-start; }
.pl-cols-loading, .pl-cols-empty { color: var(--in-fg-dim,#8A93A6); font-size: 12px; padding: 18px 6px; }
.pl-col { flex: 1 1 300px; min-width: 280px; max-width: 520px; background: var(--in-bg-3,#141925);
    border: 1px solid var(--in-border,rgba(255,255,255,.08)); border-radius: 12px; padding: 12px; }
.pl-col-head { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; padding-bottom: 8px; border-bottom: 1px solid var(--in-border,rgba(255,255,255,.08)); }
.pl-col-ic { font-size: 14px; }
.pl-col-name { font-size: 12px; font-weight: 800; text-transform: uppercase; letter-spacing: .6px; color: var(--in-fg,#e6edf3); }
.pl-col-count { margin-left: auto; background: var(--in-bg,#0d1117); border: 1px solid var(--in-border); padding: 1px 9px; border-radius: 9px; font-size: 11px; font-weight: 700; color: var(--in-fg); font-variant-numeric: tabular-nums; }
.pl-col-cards { display: flex; flex-direction: column; gap: 9px; }

/* Tarjeta: título COMPLETO con wrap, sin ellipsis ni truncado. */
.plc { background: var(--in-bg-2,#11151E); border: 1px solid var(--in-border,rgba(255,255,255,.10)); border-radius: 10px; padding: 11px 12px; transition: border-color .2s, transform .12s; }
.plc:hover { border-color: var(--in-accent,#34D9E0); transform: translateY(-1px); }
.plc-running { border-left: 3px solid var(--in-accent,#34D9E0); }
.plc-rejected { border-left: 3px solid var(--in-bad,#f85149); }
.plc-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.plc-num { font-weight: 800; font-size: 12px; color: var(--in-info,#58a6ff); text-decoration: none; font-variant-numeric: tabular-nums; }
.plc-num:hover { text-decoration: underline; }
.plc-badge { font-size: 9px; font-weight: 800; letter-spacing: .5px; text-transform: uppercase; border-radius: 5px; padding: 1px 6px; border: 1px solid var(--in-border); color: var(--in-fg-dim); }
.plc-badge.b-dev { color: var(--in-accent,#34D9E0); border-color: rgba(52,217,224,.4); }
.plc-badge.b-build { color: var(--in-warn,#d29922); border-color: rgba(210,153,34,.4); }
.plc-badge.b-qa { color: #c9b6ff; border-color: rgba(167,139,250,.4); }
.plc-badge.b-review { color: var(--in-info,#58a6ff); border-color: rgba(88,166,255,.4); }
.plc-badge.b-done { color: var(--in-ok,#3fb950); border-color: rgba(63,185,80,.4); }
.plc-badge.b-def { color: var(--in-fg-dim); }
.plc-spacer { flex: 1; }
.plc-elapsed { font-size: 10px; color: var(--in-fg-dim,#8A93A6); font-variant-numeric: tabular-nums; }
.plc-title { font-size: 12.5px; line-height: 1.4; color: var(--in-fg,#e6edf3); margin: 7px 0 0; white-space: normal; overflow-wrap: anywhere; word-break: break-word; }
.plc-flags { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 6px; }
.plc-flag { font-size: 9px; font-weight: 700; border-radius: 4px; padding: 1px 6px; text-transform: uppercase; letter-spacing: .4px; }
.plc-flag.f-rebote { color: var(--in-bad,#f85149); border: 1px solid var(--in-bad); background: var(--in-bad-soft); cursor: help; }
.plc-flag.f-paused { color: var(--in-warn,#d29922); border: 1px solid var(--in-warn); }
.plc-flag.f-allow { color: var(--in-ok,#3fb950); border: 1px solid var(--in-ok); background: var(--in-ok-soft); }
.plc-flag.f-human { color: #c9b6ff; border: 1px solid rgba(167,139,250,.5); }
.plc-agents { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 8px; }
.plc-agent { display: inline-flex; align-items: center; gap: 3px; font-size: 10px; padding: 1px 6px; border-radius: 999px; background: var(--in-bg-3); border: 1px solid var(--in-border); font-variant-numeric: tabular-nums; }
.plc-agent.state-trabajando { border-color: var(--in-accent,#34D9E0); }
.plc-agent.state-listo { border-color: var(--in-ok,#3fb950); }
.plc-agent.state-fallido { border-color: var(--in-bad,#f85149); }
.plc-prog { height: 6px; border-radius: 4px; background: rgba(255,255,255,.07); overflow: hidden; margin-top: 9px; }
.plc-prog > i { display: block; height: 100%; background: var(--in-accent,#34D9E0); transition: width .4s ease; }
.plc-prog.is-done > i { background: var(--in-ok,#3fb950); }
.plc-foot { display: flex; align-items: center; gap: 7px; margin-top: 9px; }
.plc-btn { display: inline-flex; align-items: center; gap: 4px; font-size: 10.5px; font-weight: 600; text-decoration: none;
    color: var(--in-fg-dim,#8A93A6); background: var(--in-bg-3,#141925); border: 1px solid var(--in-border); border-radius: 6px; padding: 4px 9px; cursor: pointer; transition: color .12s, border-color .12s, background .12s; }
.plc-btn:hover { color: var(--in-fg); border-color: var(--in-accent); background: var(--in-bg); }
.plc-btn.is-disabled { opacity: .4; pointer-events: none; }
.plc-foot-eta { margin-left: auto; font-size: 10px; color: var(--in-fg-dim,#8A93A6); font-variant-numeric: tabular-nums; }

.pl-legend { font-size: 11px; color: var(--in-fg-dim,#8A93A6); line-height: 1.5; padding: 2px 4px; }

/* #4234 — Color por fase de las columnas (molde único, tinte por fase). */
.pl-col.ph-def    { border-color: rgba(251,191,36,.24);  background: rgba(251,191,36,.035); }
.pl-col.ph-dev    { border-color: rgba(96,165,250,.26);  background: rgba(96,165,250,.04); }
.pl-col.ph-build  { border-color: rgba(251,146,60,.26);  background: rgba(251,146,60,.04); }
.pl-col.ph-qa     { border-color: rgba(167,139,250,.26); background: rgba(167,139,250,.04); }
.pl-col.ph-review { border-color: rgba(96,165,250,.22);  background: rgba(96,165,250,.03); }
.pl-col.ph-done   { border-color: rgba(52,211,153,.26);  background: rgba(52,211,153,.035); }
.pl-col.ph-def    .pl-col-name { color: #fcd34d; }
.pl-col.ph-dev    .pl-col-name { color: #9cc6fb; }
.pl-col.ph-build  .pl-col-name { color: #fdba74; }
.pl-col.ph-qa     .pl-col-name { color: #c4b5fd; }
.pl-col.ph-review .pl-col-name { color: #9cc6fb; }
.pl-col.ph-done   .pl-col-name { color: #6ee7b7; }

/* Ficha: barra de % por issue (CA-7) — barra + número, coloreada por fase. */
.plc-prog-row { display: flex; align-items: center; gap: 8px; margin-top: 9px; }
.plc-prog-row .plc-prog { flex: 1; margin-top: 0; }
.plc-pct { font-size: 10.5px; font-weight: 800; font-variant-numeric: tabular-nums;
    min-width: 34px; text-align: right; line-height: 1; color: var(--in-fg-dim,#8A93A6); }
.plc.ph-def    > .plc-prog-row .plc-prog > i,
.plc.ph-def    .plc-prog > i { background: linear-gradient(90deg,#f59e0b,#fbbf24); }
.plc.ph-dev    .plc-prog > i { background: linear-gradient(90deg,#3b82f6,#60a5fa); }
.plc.ph-build  .plc-prog > i { background: linear-gradient(90deg,#ea580c,#fb923c); }
.plc.ph-qa     .plc-prog > i { background: linear-gradient(90deg,#8b5cf6,#a78bfa); }
.plc.ph-review .plc-prog > i { background: linear-gradient(90deg,#3b82f6,#60a5fa); }
.plc.ph-done   .plc-prog > i { background: linear-gradient(90deg,#10b981,#34d399); }
.plc.ph-def    .plc-pct { color: #fcd34d; }
.plc.ph-dev    .plc-pct { color: #9cc6fb; }
.plc.ph-build  .plc-pct { color: #fdba74; }
.plc.ph-qa     .plc-pct { color: #c4b5fd; }
.plc.ph-review .plc-pct { color: #9cc6fb; }
.plc.ph-done   .plc-pct { color: #6ee7b7; }

/* Ficha: fila fija de 7 agentes con 3 estados (CA-6). */
.plc-agents7 { display: flex; align-items: center; gap: 4px; margin-top: 9px;
    padding-top: 8px; border-top: 1px dashed var(--in-border,rgba(255,255,255,.10)); flex-wrap: wrap; }
.plc-ag-lbl { font-size: 7.5px; font-weight: 800; letter-spacing: .4px; color: var(--in-fg-dim,#5B6376);
    text-transform: uppercase; margin-right: 2px; }
.plc-agsep { color: var(--in-fg-dim,#5B6376); font-size: 9px; margin: 0 1px; }
.plc-ag { width: 19px; height: 19px; border-radius: 50%; display: inline-flex; align-items: center;
    justify-content: center; font-size: 9.5px; flex: none; position: relative; border: 1.5px solid transparent; }
.plc-ag.done { background: rgba(52,211,153,.16); border-color: rgba(52,211,153,.45); }
.plc-ag.done::after { content: "✓"; position: absolute; right: -3px; bottom: -3px; font-size: 7px; font-weight: 900;
    width: 9px; height: 9px; border-radius: 50%; background: var(--in-ok,#34d399); color: #06140d;
    display: flex; align-items: center; justify-content: center; }
.plc-ag.now { background: rgba(52,217,224,.20); border-color: var(--in-accent,#34D9E0);
    box-shadow: 0 0 0 2px rgba(52,217,224,.16); }
.plc-ag.now::after { content: ""; position: absolute; right: -2px; bottom: -2px; width: 7px; height: 7px;
    border-radius: 50%; background: var(--in-accent,#34D9E0); box-shadow: 0 0 6px var(--in-accent,#34D9E0); }
.plc-ag.pend { background: rgba(255,255,255,.03); border-style: dashed;
    border-color: var(--in-border,rgba(255,255,255,.16)); opacity: .55; filter: grayscale(.4); }

/* Caja de leyenda de agentes + estados (CA-6). */
.pl-legend-box { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; margin-top: 14px;
    padding: 11px 14px; border: 1px solid var(--in-border,rgba(255,255,255,.08)); border-radius: 11px;
    background: rgba(255,255,255,.02); }
.pl-leg-t { font-size: 9px; font-weight: 800; letter-spacing: .5px; color: var(--in-fg-dim,#5B6376); text-transform: uppercase; }
.pl-leg-i { display: flex; align-items: center; gap: 7px; font-size: 10px; color: var(--in-fg-dim,#8A93A6); font-weight: 600; }
.pl-leg-i .plc-ag.legdemo { width: 17px; height: 17px; font-size: 9px; background: rgba(255,255,255,.05); border-color: transparent; }
.pl-leg-i .plc-ag.legdemo::after { display: none; }
.pl-leg-sep { width: 1px; height: 18px; background: var(--in-border,rgba(255,255,255,.16)); }

@media (max-width: 720px) {
  .mz-mission { flex-direction: column; align-items: stretch; }
  .mz-mission-prog { min-width: 0; }
  .pl-col { max-width: none; }
}
`;

// --- Client script de hidratación -------------------------------------------
// Reusa los helpers de commonHelpers() del shell satélite: setText, escapeHtml,
// SKILL_ICONS, pipelineModeState, moveIssue, pauseIssue, fetchJson.
function pipelineRedesignClientScript() {
    const PHASE_FLOW_JSON = JSON.stringify(PHASE_FLOW.map((p) => ({ key: p.key, label: p.label, icon: p.icon })));
    const PHASE_LOOKUP_JSON = JSON.stringify(PHASE_LOOKUP);
    return `
const PL_PHASE_FLOW = ${PHASE_FLOW_JSON};
const PL_PHASE_LOOKUP = ${PHASE_LOOKUP_JSON};
function plMacroOf(faseKey){ return PL_PHASE_LOOKUP[String(faseKey||'')] || null; }
function plProgressPct(key){
    const i = PL_PHASE_FLOW.findIndex(p => p.key === key);
    if(i < 0) return 0;
    const last = PL_PHASE_FLOW.length - 1;
    return last <= 0 ? 100 : Math.round((i/last)*100);
}

// --- Filtro "Solo issues de la ola" (allowlist de la pausa parcial) ---------
// #3905 — default ON: nace ACTIVO en sesión nueva para dar la vista 1:1 con la
// allowlist de la ola; respeta la preferencia si ya se toggleó. REQ-SEC-3: se
// persiste sólo el flag saneado '1'/'0' (nunca string crudo) y en sessionStorage
// (no localStorage). plRefreshToggleVisibility lo apaga fuera de partial_pause
// para no mostrar una cola "fantasma" en running.
let plOnlyWave = (function(){
    try { var v = sessionStorage.getItem('pl-only-allowlist'); return v === null ? true : v === '1'; }
    catch(e){ return true; }
})();
function plAllowlistOk(issue){
    if(pipelineModeState.mode !== 'partial_pause') return false;
    const n = Number(issue);
    if(!Number.isInteger(n) || n <= 0) return false;
    return pipelineModeState.allowedIssues.includes(n);
}
function plRefreshToggleVisibility(){
    const t = document.getElementById('pl-allowlist-toggle');
    if(!t) return;
    const visible = pipelineModeState.mode === 'partial_pause' && pipelineModeState.allowedIssues.length > 0;
    t.style.display = visible ? 'inline-flex' : 'none';
    if(!visible && plOnlyWave){
        plOnlyWave = false;
        t.setAttribute('aria-checked', 'false');
        if(typeof tickPipelineRedesign === 'function') tickPipelineRedesign().catch(()=>{});
    }
}
function plWireToggle(){
    const t = document.getElementById('pl-allowlist-toggle');
    if(!t || t.dataset.wired === '1') return;
    t.dataset.wired = '1';
    t.setAttribute('aria-checked', plOnlyWave ? 'true' : 'false');
    function flip(){
        if(t.style.display === 'none') return;
        plOnlyWave = !plOnlyWave;
        t.setAttribute('aria-checked', plOnlyWave ? 'true' : 'false');
        try { sessionStorage.setItem('pl-only-allowlist', plOnlyWave ? '1' : '0'); } catch(e){}
        if(typeof tickPipelineRedesign === 'function') tickPipelineRedesign().catch(()=>{});
    }
    t.addEventListener('click', (ev) => { ev.preventDefault(); flip(); });
    t.addEventListener('keydown', (ev) => { if(ev.key === ' ' || ev.key === 'Enter'){ ev.preventDefault(); flip(); } });
}

// #4234 — Fila fija de 7 agentes del flujo, con 3 estados visuales (CA-6).
// Cada agente mapea a una "stage" del flujo (def=0 … done=5). El estado se deriva
// del avance del issue por fase y se REFINA con el estado real del agente en el
// matrix cuando existe (trabajando→en curso, listo→ejecutado).
const PL_AGENTS7 = [
    { icon:'🧠', label:'Guru',     stage:0, skills:['guru'] },
    { icon:'📋', label:'Doc/PO',   stage:0, skills:['doc','po','planner','historia','priorizar','refinar'] },
    { icon:'⚙', label:'Dev',       stage:1, skills:['pipeline-dev','backend-dev','android-dev','web-dev','ios-dev','desktop-dev'] },
    { icon:'🔨', label:'Builder',  stage:2, skills:['build','builder'] },
    { icon:'▶', label:'QA',        stage:3, skills:['qa','tester'] },
    { icon:'🔍', label:'Review',   stage:4, skills:['review','security'] },
    { icon:'🚀', label:'Delivery', stage:5, skills:['delivery'] },
];
const PL_MACRO_IDX = { def:0, dev:1, build:2, qa:3, review:4, done:5 };
function plAgentState7(agent, item){
    const mi = PL_MACRO_IDX[item.macro];
    if(mi == null) return 'pend';
    if(item.macro === 'done') return 'done';            // entregado: todo hecho
    const ags = Array.isArray(item.agents) ? item.agents : [];
    if(ags.length){
        // Hay datos reales de agentes en el matrix: confiamos en ellos. Solo el
        // agente que realmente corre se enciende (evita prender toda la fase).
        const match = ags.find(a => agent.skills.indexOf(a.skill) >= 0);
        if(match){
            if(match.estado === 'trabajando') return 'now';
            if(match.estado === 'listo') return 'done';
        }
        return agent.stage < mi ? 'done' : 'pend';
    }
    // Sin datos de agentes (hijos terminales / sin work-file): determinista por fase.
    if(agent.stage < mi) return 'done';                 // fases superadas
    if(agent.stage === mi) return item.estado === 'trabajando' ? 'now' : 'pend';
    return 'pend';                                      // fases por venir
}
function plRenderAgents7(item){
    let cells = '';
    for(let idx=0; idx<PL_AGENTS7.length; idx++){
        const a = PL_AGENTS7[idx];
        const st = plAgentState7(a, item);
        const word = st === 'done' ? 'ejecutado' : (st === 'now' ? 'en curso' : 'pendiente');
        const sep = idx === 2 ? '<span class="plc-agsep" aria-hidden="true">·</span>' : '';
        cells += sep + '<span class="plc-ag ' + st + '" title="' + escapeHtml(a.label + ' · ' + word) + '">' + a.icon + '</span>';
    }
    return '<div class="plc-agents7"><span class="plc-ag-lbl">AGTS</span>' + cells + '</div>';
}
// Elige el log más relevante: el agente trabajando con log; si no, el último con log.
function plPickLog(item){
    const ag = Array.isArray(item.agents) ? item.agents : [];
    let chosen = null;
    for(const a of ag){ if(a.hasLog && a.logFile){ if(a.estado === 'trabajando'){ chosen = a; break; } chosen = a; } }
    return chosen;
}
function plBadgeFor(macroKey){
    const map = { def:'Definición', dev:'Dev', build:'Build', qa:'QA E2E', review:'Review/PO', done:'Merged' };
    return map[macroKey] || macroKey;
}
function plRenderCard(i, macroKey){
    const ghHref = 'https://github.com/intrale/platform/issues/' + encodeURIComponent(i.issue);
    const badge = '<span class="plc-badge b-' + macroKey + '" title="Etapa macro del issue">' + escapeHtml(plBadgeFor(macroKey)) + '</span>';
    const elapsed = (i.staleMin != null && i.staleMin > 0) ? '<span class="plc-elapsed" title="Minutos sin avance en la fase">' + i.staleMin + 'm</span>' : '';
    // Flags (todas las señales, sin resumir).
    let flags = '';
    if(i.rebote){
        const motivo = String(i.motivo_rechazo||'').replace(/"/g,"'").slice(0,400);
        const where = escapeHtml(i.rechazado_en_fase||'?') + (i.rechazado_skill_previo ? '/' + escapeHtml(i.rechazado_skill_previo) : '');
        flags += '<span class="plc-flag f-rebote" title="Rechazado en ' + where + ': ' + escapeHtml(motivo) + '">↩ rebote' + (i.rebote_tipo ? ' · ' + escapeHtml(i.rebote_tipo) : '') + '</span>';
    }
    if(i.paused) flags += '<span class="plc-flag f-paused" title="Issue pausado (blocked:dependencies)">⏸ pausado</span>';
    if(plAllowlistOk(i.issue)) flags += '<span class="plc-flag f-allow" title="Habilitado por la pausa parcial activa">✅ ola</span>';
    if((i.labels||[]).includes('needs-human')) flags += '<span class="plc-flag f-human" title="Necesita intervención humana">👤 humano</span>';
    const flagsHtml = flags ? '<div class="plc-flags">' + flags + '</div>' : '';
    // Logs del agente que ejecutó (atenuado si todavía no corrió).
    const log = plPickLog(i);
    const logsBtn = log
        ? '<a class="plc-btn" href="/logs/view/' + encodeURIComponent(log.logFile) + (log.estado === 'trabajando' ? '?live=1' : '') + '" target="_blank" rel="noopener" title="Ver logs del agente ' + escapeHtml(log.skill||'') + ' que ejecutó este issue">📄 Logs</a>'
        : '<span class="plc-btn is-disabled" title="Todavía no corrió ningún agente con log en este issue">📄 Logs</span>';
    const pct = plProgressPct(macroKey);
    const progCls = macroKey === 'done' ? 'plc-prog is-done' : 'plc-prog';
    const runningCls = i.estado === 'trabajando' ? ' plc-running' : (i.rebote ? ' plc-rejected' : '');
    const eta = (macroKey === 'done') ? 'entregado' : (pct + '%');
    // #4234 — la ficha conoce su fase macro para colorearse y pintar los 7 agentes.
    i.macro = macroKey;
    return '<div class="plc ph-' + macroKey + runningCls + '" data-issue="' + escapeHtml(i.issue) + '">'
        + '<div class="plc-head">'
        +   '<a class="plc-num" href="' + ghHref + '" target="_blank" rel="noopener" title="Abrir issue #' + escapeHtml(i.issue) + ' en GitHub">#' + escapeHtml(i.issue) + ' ↗</a>'
        +   badge + '<span class="plc-spacer"></span>' + elapsed
        + '</div>'
        + '<div class="plc-title">' + escapeHtml(i.title || ('Issue #' + i.issue)) + '</div>'
        + flagsHtml
        + '<div class="plc-prog-row" title="Avance por etapa del flujo">'
        +   '<div class="' + progCls + '"><i style="width:' + pct + '%"></i></div>'
        +   '<span class="plc-pct">' + pct + '%</span>'
        + '</div>'
        + plRenderAgents7(i)
        + '<div class="plc-foot">'
        +   '<a class="plc-btn" href="' + ghHref + '" target="_blank" rel="noopener" title="Abrir el issue en GitHub">🔗 Issue</a>'
        +   logsBtn
        +   '<span class="plc-foot-eta" title="Avance del issue">' + eta + '</span>'
        + '</div>'
        + '</div>';
}

// #4234 — Bucket helpers (construyen el item visual de cada fuente de datos).
function plItemFromMatrix(issue, data, macro){
    const labels = data.labels || [];
    return {
        issue: String(issue), title: data.title, estado: data.estadoActual,
        staleMin: data.staleMin, labels: labels,
        paused: labels.indexOf('blocked:dependencies') >= 0,
        rebote: data.rebote, rebote_tipo: data.rebote_tipo, motivo_rechazo: data.motivo_rechazo,
        rechazado_en_fase: data.rechazado_en_fase, rechazado_skill_previo: data.rechazado_skill_previo,
        agents: data.agents || [], macro: macro,
    };
}
function plItemTerminal(issue, title, macro, estado){
    return {
        issue: String(issue), title: title || ('Issue #' + issue), estado: estado || '',
        staleMin: 0, labels: [], paused: false, rebote: false,
        agents: [], macro: macro,
    };
}

async function tickPipelineRedesign(){
    // #4234 — VISTA TOTAL DE LA OLA: cruzamos la membresía de la ola activa
    // (/api/dash/waves → solo IDs) con el matrix del pipeline (hijos en vuelo,
    // con faseActual/agentes) y la franja terminal waveIssues (hijos sin
    // work-file: 'finalizado'=entregado, 'no-ingreso'=definición sin arrancar).
    const [d, w] = await Promise.all([
        fetchJson('/api/dash/pipeline'),
        fetchJson('/api/dash/waves').catch(function(){ return null; }),
    ]);
    if(!d) return;
    const matrix = d.matrix || {};
    const waveExtra = Array.isArray(d.waveIssues) ? d.waveIssues : [];
    const extraById = {};
    for(const e of waveExtra){ if(e && e.issue != null) extraById[String(e.issue)] = e; }

    // Membresía de la ola (CA-1). Si hay ola activa, ES la fuente de verdad.
    let waveMembers = null;
    if(w && w.active_wave && Array.isArray(w.active_wave.issues)){
        waveMembers = [];
        for(const x of w.active_wave.issues){
            if(x && x.id != null) waveMembers.push(String(x.id));
        }
    }

    const buckets = {};
    for(const p of PL_PHASE_FLOW) buckets[p.key] = [];

    if(waveMembers && waveMembers.length){
        // WAVE MODE: todos los hijos de la ola, enriquecidos. Sin filtro allowlist:
        // la membresía de la ola ya delimita la vista (CA-1).
        for(const id of waveMembers){
            const m = matrix[id];
            if(m){
                const macro = plMacroOf(m.faseActual);
                if(macro){ buckets[macro].push(plItemFromMatrix(id, m, macro)); }
                else { buckets.def.push(plItemTerminal(id, m.title, 'def', m.estadoActual)); }
                continue;
            }
            const ex = extraById[id];
            if(ex && ex.estado === 'finalizado'){
                buckets.done.push(plItemTerminal(id, ex.title, 'done', 'finalizado'));
            } else {
                // no-ingreso (open, sin work-file) o desconocido → definición sin arrancar.
                buckets.def.push(plItemTerminal(id, ex ? ex.title : '', 'def', 'no-ingreso'));
            }
        }
    } else {
        // FALLBACK (sin ola activa): vista legacy basada en el matrix, con el
        // filtro de allowlist de la pausa parcial. Mantiene el pipeline vivo
        // cuando waves.json no expone una ola activa.
        for(const [issue, data] of Object.entries(matrix)){
            const macro = plMacroOf(data.faseActual);
            if(!macro) continue;
            if(plOnlyWave && !plAllowlistOk(issue)) continue;
            buckets[macro].push(plItemFromMatrix(issue, data, macro));
        }
        for(const ex of waveExtra){
            if(plOnlyWave && !plAllowlistOk(ex.issue)) continue;
            if(ex.estado === 'finalizado') buckets.done.push(plItemTerminal(ex.issue, ex.title, 'done', 'finalizado'));
            else buckets.def.push(plItemTerminal(ex.issue, ex.title, 'def', 'no-ingreso'));
        }
    }

    // Bloque 1: Flujo de fases — SIEMPRE las 6 fases con su conteo (CA-3),
    // atenuando las que están en 0 (su conteo se conserva acá).
    let totalVisible = 0, activeCols = 0;
    for(const p of PL_PHASE_FLOW){
        const n = buckets[p.key].length;
        totalVisible += n;
        if(n > 0) activeCols++;
        setText('pflow-c-' + p.key, String(n));
        const node = document.getElementById('pflow-n-' + p.key);
        if(node){
            node.classList.toggle('pflow-empty', n === 0);
            node.classList.toggle('pflow-active', n > 0);
        }
    }
    setText('pl-issues-sub', totalVisible + ' hijo' + (totalVisible === 1 ? '' : 's') + ' de la ola · ' + activeCols + ' fase' + (activeCols === 1 ? '' : 's') + ' con issues · sin scroll');
    // Bloque 2: columnas SOLO de fases con issues (CA-4), TODOS los hijos (sin slice).
    const cmp = (a, b) => {
        const trab = (b.estado==='trabajando'?1:0) - (a.estado==='trabajando'?1:0);
        if(trab !== 0) return trab;
        return Number(a.issue) - Number(b.issue);
    };
    let cols = '';
    for(const p of PL_PHASE_FLOW){
        const items = buckets[p.key];
        if(!items.length) continue;
        items.sort(cmp);
        const cards = items.map(i => plRenderCard(i, p.key)).join('');
        cols += '<div class="pl-col ph-' + p.key + '" data-key="' + p.key + '">'
            + '<div class="pl-col-head"><span class="pl-col-ic" aria-hidden="true">' + p.icon + '</span>'
            + '<span class="pl-col-name">' + escapeHtml(p.label) + '</span>'
            + '<span class="pl-col-count" title="Cantidad de hijos de la ola en esta fase">' + items.length + '</span></div>'
            + '<div class="pl-col-cards">' + cards + '</div></div>';
    }
    if(!cols){
        cols = '<div class="pl-cols-empty">' + (waveMembers ? 'La ola activa no tiene hijos en ninguna fase.' : (plOnlyWave ? 'No hay issues de la ola en fases activas.' : 'No hay issues en fases activas ahora mismo.')) + '</div>';
    }
    const host = document.getElementById('pipeline-cols');
    if(host && host.innerHTML !== cols) host.innerHTML = cols;
}

// --- Mission banner desde /api/dash/waves (mirror de home.js) ----------------
function plFmtMin(mins){
    const m = Number(mins);
    if(!Number.isFinite(m) || m <= 0) return '—';
    if(m < 60) return Math.round(m) + 'm';
    const h = Math.floor(m/60), r = Math.round(m%60);
    return r > 0 ? h + 'h ' + r + 'm' : h + 'h';
}
function plMirrorMission(d){
    try {
        const wave = d && d.active_wave;
        if(!wave){
            setText('mission-wave-num', '—');
            setText('mission-wave-name', 'Sin ola activa');
            return;
        }
        if(Number.isFinite(wave.number)){
            setText('mission-wave-num', String(wave.number));
            const olaEl = document.getElementById('pl-flow-ola');
            if(olaEl) olaEl.textContent = 'Ola ' + wave.number;
        }
        setText('mission-wave-name', wave.name ? ('Ola ' + wave.number + ' · ' + wave.name) : ('Ola ' + wave.number));
        const desc = wave.goal || wave.description;
        if(desc) setText('mission-wave-desc', desc);
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
        // #4296 — el avance % ya NO se deriva de conteos acá: lo hidrata el helper
        // compartido (FETCH_CLIENT_JS) desde /api/dash/ola-eta, igual que la HOME.
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
        // Velocidad + ETA best-effort desde openedAt.
        const openedAt = wave.openedAt ? Date.parse(wave.openedAt) : NaN;
        const vv = document.getElementById('mission-vel-value');
        const rem = Math.max(0, total - done);
        if(Number.isFinite(openedAt) && done > 0){
            const hours = (Date.now() - openedAt) / 3600000;
            if(hours > 0.1){
                const rate = done / hours;
                if(vv) vv.innerHTML = rate.toFixed(1) + ' <span class="mz-wm-u">iss/h</span>';
                setText('mission-eta-value', rem > 0 && rate > 0 ? plFmtMin((rem/rate)*60) : '—');
            }
        }
    } catch(e){}
}
async function tickWaves(){
    const d = await fetchJson('/api/dash/waves');
    if(d) plMirrorMission(d);
}

const PL_POLLS = [{ fn: tickHeader, ms: 5000 }, { fn: tickPipelineRedesign, ms: 5000 }, { fn: tickWaves, ms: 30000 }];
async function plRunAll(){ for(const p of PL_POLLS){ try{ await p.fn(); } catch{} } }
plWireToggle();
// refreshAllowlistToggleVisibility lo llama tickHeader; lo apuntamos al nuestro.
window.refreshAllowlistToggleVisibility = plRefreshToggleVisibility;
plRunAll();
for(const p of PL_POLLS){ setInterval(() => { p.fn().catch(()=>{}); }, p.ms); }
`;
}

module.exports = {
    slug: 'pipeline',
    PHASE_FLOW,
    PHASE_LOOKUP,
    macroPhaseOf,
    phaseProgressPct,
    renderBrandBarPipeline,
    renderMissionBannerPipeline,
    renderPhaseFlowSsr,
    renderIssuesByPhaseSsr,
    renderAgentsLegendSsr,
    renderPipelineRedesignBody,
    PIPELINE_REDESIGN_CSS,
    pipelineRedesignClientScript,
};
