// V3 Satellites — render de las 9 tabs satélite. Cada satélite hereda header
// + paleta del theme.css compartido pero define su propio layout interno.
//
// Patrón común:
//   - HTML inicial con IDs estables
//   - Cliente JS hace fetch JSON + DOM morphing manual (sin flicker)
//   - Polling con frecuencia específica del satélite

'use strict';

const fs = require('fs');
const path = require('path');

// #3726 — Nav bar V3 unificada. renderNavTabsSsr inyecta el <nav class="v3-nav">
// con los 12 tabs en TODOS los satelites y loadIconSprite() lee el cache
// compartido del sprite.svg para que <use href="#ic-tab-*"> resuelva inline.
const { renderNavTabsSsr, loadIconSprite } = require('./nav-tabs');

// #3953 (EP8-H0) — Wrapper único de fetchJson (CA-2) y framework de modal de
// confirmación con preview (CA-3). Reemplazan la copia local con .catch(()=>null)
// y los confirm() nativos. nhCsrfHeaders() (de FETCH_CLIENT_JS) cubre R2.
const { FETCH_CLIENT_JS } = require('./fetch-client.js');
// #4296 — Accessor compartido del banner de ola (avance %, velocidad %/h, ETA)
// desde la fuente determinística viva /api/dash/ola-eta (no conteos done/total).
// Se inyecta una sola vez en el shell satélite → cubre TODAS las subventanas.
const { missionOlaEtaClientScript } = require('../../lib/mission-ola-eta.js');
const { CONFIRM_MODAL_JS } = require('./confirm-modal.js');

// #4190 (Ola 7.1) — Rediseño integral de la pantalla PIPELINE (lenguaje MIZPÁ:
// brand bar + selector + banner de misión + flujo de fases + issues por fase).
// Degradación defensiva: si el módulo no carga, renderPipeline cae al board
// legacy (ver fallback en la propia función).
let pipelineRedesign = null;
try { pipelineRedesign = require('./pipeline-redesign'); } catch (_) { /* fallback legacy */ }

// #4240 (Ola 7.1) — EQUIPO adopta el marco común MIZPÁ. Se reutiliza el helper
// compartido `renderMissionBanner` de la HOME (#4189) — el banner de ola común
// (② del marco: tag OLA + título + métricas + bloque AVANCE) — en vez de
// duplicar su markup (CA-5). Degradación defensiva: si el módulo no carga, el
// slot `missionHtml` queda vacío y el resto del marco sigue intacto.
let homeView = null;
try { homeView = require('./home'); } catch (_) { /* sin banner de ola común */ }

// #4239 (Ola 7.1) — COSTOS adopta el marco común MIZPÁ. Reutiliza el helper
// compartido del marco (`mizpa-frame`): ① cabecera de marca (renderBrandBar) y
// ② banner de ola común SSR-poblado (renderMissionBanner(collectWave())), el
// mismo markup/CSS `mz-*` del resto de las pantallas, en vez de duplicarlo
// (CA-5). Es la misma vía que usa LOGS (#4236). Degradación defensiva: si el
// módulo no carga, el marco cae a la cabecera legacy del shell y el resto del
// satélite sigue intacto («el pipeline no puede morir»).
let mizpaFrame = null;
try { mizpaFrame = require('./mizpa-frame'); } catch (_) { /* sin marco común */ }

const THEME_CSS_PATH = path.join(__dirname, 'theme.css');
function loadTheme() {
    try { return fs.readFileSync(THEME_CSS_PATH, 'utf8'); } catch { return ''; }
}

function commonHelpers() {
    return `
function fmtDur(ms){ if(!ms||ms<0) return '—'; const s=Math.round(ms/1000); if(s<60) return s+'s'; const m=Math.floor(s/60), r=s%60; if(m<60) return m+'m '+r+'s'; const h=Math.floor(m/60), rm=m%60; return h+'h '+rm+'m'; }
function fmtNum(n){ if(n==null||isNaN(n)) return '—'; if(n>=1e6) return (n/1e6).toFixed(1)+'M'; if(n>=1e3) return (n/1e3).toFixed(1)+'k'; return String(n); }
function fmtPct(n){ return n==null?'—':n.toFixed(1)+'%'; }
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

// #3045 — cache compartido entre tickHeader y tickPipeline para evitar un
// segundo round-trip y mantener fuera de localStorage un estado que vive 5s.
// Se sanea acá para que cualquier consumidor reciba ya integers > 0
// (defensa en profundidad sobre lo que enforza headerSlice server-side).
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
    // #3045 — actualizar el cache compartido ANTES del render del modePill,
    // así el render del próximo tickPipeline (que puede dispararse en paralelo)
    // ya ve el estado fresco.
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
    // #3045 — Si el filtro de allowlist está montado en la Pipeline view,
    // refrescar su visibilidad cuando cambia el modo (running ⇄ partial_pause).
    if(typeof refreshAllowlistToggleVisibility === 'function'){
        try { refreshAllowlistToggleVisibility(); } catch{}
    }
}

// ─── Acciones (importadas del dashboard legacy) ───
// Los endpoints POST viven en dashboard.js; el cliente solo los invoca.
// Refresh tras la acción: forzar tick inmediato sin recargar la página
// para preservar el patrón anti-flicker.

function showToast(msg, ok){
    let t = document.getElementById('in-toast');
    if(!t){
        t = document.createElement('div');
        t.id = 'in-toast';
        t.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);padding:12px 22px;border-radius:8px;font-size:13px;font-weight:500;z-index:9999;box-shadow:0 6px 24px rgba(0,0,0,0.4);transition:opacity 0.3s,transform 0.3s;opacity:0;color:#fff';
        document.body.appendChild(t);
    }
    t.textContent = msg;
    t.style.background = ok===false ? 'var(--in-bad)' : (ok===true ? 'var(--in-ok)' : 'var(--in-brand)');
    t.style.opacity = '1';
    t.style.transform = 'translateX(-50%) translateY(0)';
    clearTimeout(t._timeout);
    t._timeout = setTimeout(() => { t.style.opacity = '0'; t.style.transform = 'translateX(-50%) translateY(8px)'; }, 3500);
}

async function killAgent(issue, skill, pipeline, fase, durationMs){
    // CA-2 — preview con Skill · Issue · Fase · Tiempo invertido. SEC-2 — el POST
    // viaja con token CSRF (killAgentPost) en vez del nhCsrfHeaders (meta) que
    // esta vista no embebe.
    const preview = [{label:'Skill', value:skill},{label:'Issue', value:'#'+issue}];
    if(fase) preview.push({label:'Fase', value:fase});
    if(durationMs != null) preview.push({label:'Tiempo invertido', value:fmtDur(durationMs)});
    if(!(await inConfirm({ title:'Cancelar agente', message:'Se cancelará el agente en curso. Esta acción no se puede deshacer.', confirmLabel:'Cancelar agente', preview:preview }))) return;
    try{
        const r = await killAgentPost({issue, skill, pipeline, fase});
        const j = await r.json();
        showToast(j.msg || (j.ok?'Agente cancelado':'Falló la cancelación'), j.ok);
        if(typeof runAll === 'function') setTimeout(runAll, 600);
    } catch(e){ showToast('Error: '+e.message, false); }
}

async function killSkillGroup(skill, agents){
    if(!agents || !agents.length) return;
    if(!(await inConfirm({ title:'Cancelar todos los agentes', message:'Se cancelarán todos los agentes activos de este skill.', confirmLabel:'Cancelar todos', preview:[{label:'Skill', value:skill},{label:'Activos', value:String(agents.length)}] }))) return;
    let ok=0, fail=0;
    for(const a of agents){
        try{
            const r = await killAgentPost({issue: a.issue, skill: a.skill, pipeline: a.pipeline, fase: a.fase});
            const j = await r.json();
            if(j.ok) ok++; else fail++;
        } catch{ fail++; }
    }
    showToast(skill+': '+ok+' cancelados'+(fail>0?', '+fail+' fallaron':''), fail===0);
    if(typeof runAll === 'function') setTimeout(runAll, 600);
}

async function nhReactivate(issue){
    // Pedir indicaciones para el agente. prompt() permite multi-línea pegando texto.
    // Si el operador acepta sin texto, sigue (compat con el flujo viejo).
    // Si cancela (null), abortar.
    const guidance = prompt(
        '¿Reactivar #'+issue+'?\\n\\n' +
        'Indicaciones para el agente (opcional — se pasan como contexto al prompt y se postean en el issue):\\n' +
        'Ej: "Usar la API REST en vez de gh CLI", "Ignorar el rebase conflict, ya está limpio", etc.',
        ''
    );
    if(guidance === null) return; // cancel
    try{
        const r = await fetch('/api/needs-human/'+issue+'/reactivate', {
            method: 'POST',
            headers: Object.assign({'Content-Type':'application/json'}, nhCsrfHeaders()),
            body: JSON.stringify({ guidance: guidance.trim() }),
        });
        const j = await r.json();
        showToast(j.msg || (j.ok?'Reactivado':'Falló'), j.ok);
        if(typeof runAll === 'function') setTimeout(runAll, 600);
    } catch(e){ showToast('Error: '+e.message, false); }
}

async function nhDismiss(issue){
    const reason = prompt('Razón para desestimar #'+issue+' (opcional):') || '';
    if(reason === null) return;
    try{
        const r = await fetch('/api/needs-human/'+issue+'/dismiss', {method:'POST', headers:Object.assign({'Content-Type':'application/json'}, nhCsrfHeaders()), body: JSON.stringify({reason})});
        const j = await r.json();
        showToast(j.msg || (j.ok?'Desestimado':'Falló'), j.ok);
        if(typeof runAll === 'function') setTimeout(runAll, 600);
    } catch(e){ showToast('Error: '+e.message, false); }
}

async function moveIssue(issue, direction){
    try{
        const r = await fetch('/api/issue/'+issue+'/'+direction, {method:'POST', headers: nhCsrfHeaders()});
        const j = await r.json();
        showToast(j.msg || (j.ok?'Movido':'Falló'), j.ok);
        if(typeof runAll === 'function') setTimeout(runAll, 400);
    } catch(e){ showToast('Error: '+e.message, false); }
}

async function pauseIssue(issue, paused){
    const verb = paused ? 'Reanudar' : 'Pausar';
    if(!(await inConfirm({ title:verb+' issue', message:(paused ? 'Quita el label blocked:dependencies y vuelve a la cola del pipeline.' : 'Agrega el label blocked:dependencies; el pulpo lo saltea hasta reanudar.'), confirmLabel:verb, danger: !paused, preview:[{label:'Issue', value:'#'+issue},{label:'Acción', value:verb}] }))) return;
    try{
        const r = await fetch('/api/issue/'+issue+'/'+(paused?'resume':'pause'), {method:'POST', headers: nhCsrfHeaders()});
        const j = await r.json();
        showToast(j.msg || (j.ok?(paused?'Reanudado':'Pausado'):'Falló'), j.ok);
        if(typeof runAll === 'function') setTimeout(runAll, 600);
    } catch(e){ showToast('Error: '+e.message, false); }
}

document.addEventListener('visibilitychange', () => { if(document.visibilityState === 'visible' && typeof runAll === 'function') runAll(); });
`;
}

// #3726 — pageShell ahora recibe `activeSlug` para marcar la tab activa
// dentro del <nav class="v3-nav"> que reemplaza al back-link "Operacion".
// Si el caller no pasa activeSlug, ninguna tab queda activa pero la nav
// igual se rendera completa (degradacion limpia).
// #4195 — `opts` opcional (backward-compatible): un satélite migrado a MIZPÁ
// puede inyectar su propia barra de marca (`opts.brandHtml`) en lugar del
// `in-header-brand` legacy, y una miga de pan (`opts.breadcrumbHtml`) debajo de
// la nav. Sin `opts` el shell se comporta igual que antes (sisters no migradas).
// #4190 — Pipeline usa `opts.brandHtml` para inyectar la marca MIZPÁ completa
// (logo + tagline + selector multiproyecto), por la misma vía que Equipo (#4195).
function pageShell(title, subtitle, bodyHtml, scripts, extraCss = '', activeSlug = '', opts = {}) {
    const theme = loadTheme();
    const spriteInline = loadIconSprite();
    const navHtml = renderNavTabsSsr(activeSlug);
    const brandHtml = (opts && opts.brandHtml) || `
    <div class="in-header-brand">
      <div class="in-header-logo">i</div>
      <div>
        <div class="in-header-title">${title}</div>
        <div class="in-header-subtitle">${subtitle}</div>
      </div>
    </div>`;
    const breadcrumbHtml = (opts && opts.breadcrumbHtml) || '';
    // #4240 — Slot opcional para el banner de ola común (② del marco MIZPÁ). Se
    // inyecta entre el header (①) y la nav (③) para respetar el orden del marco
    // (idéntico al de la HOME). Backward-compatible: sin `missionHtml` el shell
    // se comporta igual que antes (satélites no migrados).
    const missionHtml = (opts && opts.missionHtml) || '';
    return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Intrale · ${title}</title>
<style>${theme}</style>
<style>
.satellite-frame { max-width: 1600px; margin: 0 auto; padding: 0; }
.satellite-body { padding: 22px 28px; display: flex; flex-direction: column; gap: 18px; }
/* #4240 — El banner de ola común (② del marco) vive fuera del .satellite-body
   (entre header y nav), así que se alinea con el padding horizontal del cuerpo. */
.satellite-frame > .mz-mission { margin: 18px 28px 0; }
.in-mode-running { color: var(--in-ok); border-color: var(--in-ok); background: var(--in-ok-soft); }
.in-mode-paused { color: var(--in-bad); border-color: var(--in-bad); background: var(--in-bad-soft); }
.in-mode-partial { color: var(--in-warn); border-color: var(--in-warn); background: var(--in-warn-soft); }
${extraCss}
</style>
</head>
<body>
<!-- #3726 — Sprite SVG inline para resolver <use href="#ic-tab-*"> dentro
     del <nav class="v3-nav">. Oculto con display:none; los simbolos
     siguen siendo referenciables por id. -->
<div aria-hidden="true" style="position:absolute;width:0;height:0;overflow:hidden">${spriteInline}</div>
<div class="satellite-frame">
  <header class="in-header">
    ${brandHtml}
    <div class="in-header-meta">
      <span class="in-pill" id="hdr-mode">…</span>
      <span class="in-clock" id="hdr-clock">…</span>
    </div>
  </header>
  ${missionHtml}
  ${navHtml}
  ${breadcrumbHtml}
  <main class="satellite-body">${bodyHtml}</main>
  <footer class="in-footer">
    <span>Refresh independiente · sin flicker</span>
    <span>Intrale V3</span>
  </footer>
</div>
<script>${FETCH_CLIENT_JS}\n${CONFIRM_MODAL_JS}\n${commonHelpers()}\n${scripts}\n${missionOlaEtaClientScript()}</script>
</body>
</html>`;
}

// ─────────────────── Equipo ───────────────────
// #4195 (Ola 7.1) — Rediseño integral MIZPÁ: la pantalla deja de ser un acordeón
// vacío y pasa a ser la VISTA DE DOTACIÓN del equipo de agentes. Hereda la barra
// de marca MIZPÁ + nav curada (popover «⋯ Más» con Equipo dentro + miga de pan),
// un banner de misión en clave operativa (agentes en vivo, roles despiertos/total,
// tok/min, el más veterano, en enfriamiento + visor de slots de concurrencia),
// una ficha por agente vivo (rol, issue linkeado, fase, proveedor, tiempo, rebotes
// y rama, con acciones matar/reiniciar) y el listado completo de roles
// diferenciando despiertos de dormidos/congelados.
//
// Datos: /api/dash/equipo expone { skills, roster, banner, providersBySkill } y
// /api/dash/active expone los agentes vivos enriquecidos (provider/branch/bounces).
// Render 100% por DOM (textContent/setAttribute) → XSS-safe (SEC-5). Kill reusa
// killAgent() (CSRF, SEC-2); reiniciar reusa restartAgent() (mismo endpoint con
// flag restart). Commander = no cancelable (CA-3); cooldown server-authoritative.
function renderEquipoBrandBar() {
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

function renderEquipo() {
    // Miga de pan: Equipo vive dentro de «⋯ Más» (tab secundario). La nav ya deja
    // el popover abierto + Equipo marcado vía renderNavTabsSsr('equipo'); la miga
    // refuerza la ubicación (CA-1).
    const breadcrumb = `
  <div class="mz-crumb" aria-label="Ubicación: Más › Equipo">
    <span class="mz-crumb-sep">⋯ Más</span>
    <span class="mz-crumb-sep">›</span>
    <b>👥 Equipo</b>
    <span class="mz-crumb-desc">· dotación de agentes por rol</span>
  </div>`;

    const body = `
<section class="eq2" aria-label="Dotación del equipo de agentes">
  <!-- Banner de misión -->
  <div class="eqm" id="eq-banner">
    <div class="eqm-live">
      <span class="eqm-live-k">EN VIVO</span>
      <span class="eqm-live-n" id="eq-live-n">—</span>
      <span class="eqm-live-u">agentes activos</span>
    </div>
    <div class="eqm-text">
      <div class="eqm-ttl">La dotación trabajando ahora
        <span class="eqm-badge" id="eq-roles-badge">— / — roles despiertos</span>
      </div>
      <div class="eqm-desc">Cada agente es on-demand: nace para una fase, consume tokens mientras corre y se apaga al terminar. Acá ves quién está vivo, en qué issue, con qué proveedor — y podés matar o reiniciar cualquiera individualmente.</div>
      <div class="eqm-metrics">
        <div class="eqm-wm"><div class="eqm-wm-l">🔥 QUEMANDO AHORA</div><div class="eqm-wm-v" id="eq-tokmin">—</div><div class="eqm-wm-s">tok/min · ≈ promedio 24h</div></div>
        <div class="eqm-wm"><div class="eqm-wm-l">⏱ EL MÁS VETERANO</div><div class="eqm-wm-v" id="eq-veteran-v">—</div><div class="eqm-wm-s" id="eq-veteran-s">sin agentes vivos</div></div>
        <div class="eqm-wm"><div class="eqm-wm-l">❄ EN ENFRIAMIENTO</div><div class="eqm-wm-v" id="eq-cooling">—</div><div class="eqm-wm-s">terminaron, enfriando</div></div>
      </div>
    </div>
    <div class="eqm-slots">
      <div class="eqm-slots-head">⚡ SLOTS DE CONCURRENCIA <span id="eq-slots-count">—</span></div>
      <div class="eqm-slots-bars" id="eq-slots-bars"></div>
      <div class="eqm-slots-note" id="eq-slots-note">Cupos de agentes simultáneos.</div>
    </div>
  </div>

  <!-- Resumen + búsqueda -->
  <div class="eq2-bar">
    <div class="eq2-chips">
      <div class="eq2-chip"><b id="eq-chip-vivos">—</b> vivos</div>
      <div class="eq2-chip"><b id="eq-chip-cool">—</b> enfriando</div>
      <div class="eq2-chip"><b id="eq-chip-idle">—</b> ociosos</div>
      <div class="eq2-chip eq2-chip-total"><b id="eq-chip-total">—</b> roles totales</div>
    </div>
    <input type="search" id="eq-search" class="eq2-search" placeholder="Buscar por rol, #issue o proveedor…" aria-label="Buscar rol, issue o proveedor">
  </div>

  <!-- Roster por categoría -->
  <div id="eq-roster" class="eq2-roster"><div class="eq2-empty">Cargando dotación…</div></div>
</section>`;

    const css = `
.eq2 { display: flex; flex-direction: column; gap: 16px; }
.eq2-empty { color: var(--in-fg-dim); font-size: 13px; padding: 18px; text-align: center; }

/* Banner de misión */
.eqm { display: flex; align-items: stretch; gap: 20px; position: relative; overflow: hidden; flex-wrap: wrap;
  background: linear-gradient(110deg, rgba(52,217,224,.14), rgba(124,92,255,.08) 45%, transparent 75%), linear-gradient(180deg, var(--in-bg-2,#11151E), var(--in-bg-3,#141925));
  border: 1px solid rgba(52,217,224,.22); border-radius: 16px; padding: 18px 22px; }
.eqm-live { display: flex; flex-direction: column; align-items: center; justify-content: center; min-width: 104px; padding: 12px 16px; border-radius: 14px; flex: none;
  background: linear-gradient(135deg, rgba(52,217,224,.22), rgba(124,92,255,.16)); border: 1px solid rgba(52,217,224,.3); }
.eqm-live-k { font-size: 10px; font-weight: 800; letter-spacing: 1.5px; color: #9fe9ee; }
.eqm-live-n { font-size: 38px; font-weight: 800; color: #bff3f6; line-height: 1; font-variant-numeric: tabular-nums; }
.eqm-live-u { font-size: 10px; color: var(--in-fg-dim,#8A93A6); font-weight: 600; margin-top: 4px; letter-spacing: .3px; }
.eqm-text { flex: 1; min-width: 280px; }
.eqm-ttl { font-size: 19px; font-weight: 800; display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.eqm-badge { font-size: 11px; color: var(--brand-cyan,#34D9E0); background: rgba(52,217,224,.12); border: 1px solid rgba(52,217,224,.3); padding: 3px 9px; border-radius: 20px; font-weight: 700; letter-spacing: .3px; }
.eqm-desc { font-size: 13px; color: var(--in-fg-dim,#8A93A6); margin-top: 5px; max-width: 620px; line-height: 1.45; }
.eqm-metrics { display: flex; gap: 10px; margin-top: 12px; flex-wrap: wrap; }
.eqm-wm { flex: 1; min-width: 150px; background: rgba(255,255,255,.035); border: 1px solid var(--in-border,rgba(255,255,255,.07)); border-radius: 11px; padding: 9px 12px; }
.eqm-wm-l { font-size: 9.5px; font-weight: 800; letter-spacing: .7px; color: var(--in-fg-dim,#5B6376); }
.eqm-wm-v { font-size: 18px; font-weight: 800; margin-top: 3px; line-height: 1; font-variant-numeric: tabular-nums; }
.eqm-wm-s { font-size: 10px; color: var(--in-fg-dim,#5B6376); margin-top: 4px; }
.eqm-slots { min-width: 230px; flex: 1; display: flex; flex-direction: column; gap: 8px; background: rgba(255,255,255,.03); border: 1px solid var(--in-border,rgba(255,255,255,.07)); border-radius: 12px; padding: 12px 14px; }
.eqm-slots-head { font-size: 10px; font-weight: 800; letter-spacing: .7px; color: var(--in-fg-dim,#8A93A6); display: flex; justify-content: space-between; gap: 8px; }
.eqm-slots-head span { color: #bff3f6; }
.eqm-slots-bars { display: flex; gap: 7px; }
.eqm-slot { flex: 1; height: 26px; border-radius: 7px; border: 1px solid var(--in-border); background: var(--in-bg); }
.eqm-slot.busy { background: linear-gradient(135deg,#34D9E0,#7C5CFF); border-color: rgba(52,217,224,.5); }
.eqm-slots-note { font-size: 10px; color: var(--in-fg-dim,#5B6376); line-height: 1.4; }

/* Resumen + búsqueda */
.eq2-bar { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; }
.eq2-chips { display: flex; gap: 10px; flex-wrap: wrap; }
.eq2-chip { font-size: 12px; color: var(--in-fg-dim); background: var(--in-bg-2); border: 1px solid var(--in-border); border-radius: 999px; padding: 6px 13px; }
.eq2-chip b { color: var(--in-fg); font-variant-numeric: tabular-nums; font-weight: 800; }
.eq2-chip-total b { color: var(--brand-cyan,#34D9E0); }
.eq2-search { margin-left: auto; flex: 1; min-width: 240px; max-width: 420px; background: var(--in-bg-2); border: 1px solid var(--in-border); border-radius: 10px; padding: 9px 13px; color: var(--in-fg); font-size: 13px; }
.eq2-search:focus-visible { outline: 2px solid var(--in-accent); outline-offset: 1px; }

/* Roster por categoría */
.eq2-roster { display: flex; flex-direction: column; gap: 14px; }
.eq2-cat-head { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
.eq2-cat-dot { width: 9px; height: 9px; border-radius: 50%; flex: none; }
.eq2-cat-name { font-size: 12px; font-weight: 800; letter-spacing: 1px; text-transform: uppercase; }
.eq2-cat-meta { font-size: 11px; color: var(--in-fg-dim); background: var(--in-bg-2); border: 1px solid var(--in-border); border-radius: 999px; padding: 2px 10px; }
.eq2-cat-roles { font-size: 11px; color: var(--in-fg-dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.eq2-cat-list { display: flex; flex-direction: column; gap: 8px; }

/* Ficha de agente vivo */
.eq2-card { display: flex; gap: 14px; background: var(--in-bg-3); border: 1px solid var(--in-border); border-left: 3px solid var(--in-ok); border-radius: var(--in-radius-sm); padding: 13px 15px; }
.eq2-card-id { display: flex; flex-direction: column; gap: 6px; min-width: 168px; flex: none; }
.eq2-card-persona { display: flex; align-items: center; gap: 9px; }
.eq2-avatar { width: 34px; height: 34px; border-radius: 9px; display: flex; align-items: center; justify-content: center; color: #fff; font-size: 17px; flex: none; }
.eq2-card-name { font-size: 14px; font-weight: 700; }
.eq2-card-tag { font-size: 10.5px; color: var(--in-fg-dim); }
.eq2-card-pid { font-size: 10px; color: var(--in-fg-soft); font-variant-numeric: tabular-nums; word-break: break-all; }
.eq2-state-live { display: inline-flex; align-items: center; gap: 5px; font-size: 10px; font-weight: 700; color: var(--in-ok); border: 1px solid var(--in-ok); background: var(--in-ok-soft); border-radius: 999px; padding: 2px 9px; width: fit-content; text-transform: uppercase; letter-spacing: .5px; }
.eq2-state-live::before { content: "●"; animation: eqPulse 1.6s ease-in-out infinite; }
@keyframes eqPulse { 0%,100%{opacity:1} 50%{opacity:.4} }
.eq2-card-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 7px; }
.eq2-card-head { display: flex; align-items: center; gap: 9px; flex-wrap: wrap; }
.eq2-issue { color: #58a6ff; font-weight: 800; font-size: 13px; text-decoration: none; }
.eq2-issue:hover { text-decoration: underline; }
.eq2-fase { font-size: 10px; text-transform: uppercase; letter-spacing: .5px; padding: 2px 8px; border-radius: 9px; background: var(--in-bg); color: var(--in-fg-dim); border: 1px solid var(--in-border); }
.eq2-card-title { font-size: 13px; color: var(--in-fg); }
.eq2-card-facts { display: flex; gap: 14px; flex-wrap: wrap; font-size: 11px; color: var(--in-fg-dim); align-items: center; }
.eq2-fact { display: inline-flex; align-items: center; gap: 5px; font-variant-numeric: tabular-nums; }
.eq2-fact b { color: var(--in-fg); font-weight: 600; }
.eq2-prov-dot { width: 8px; height: 8px; border-radius: 2px; display: inline-block; }
.eq2-rebotes { color: var(--in-warn); }
.eq2-card-prog { display: flex; align-items: center; gap: 9px; }
.eq2-bar { flex: 1; max-width: 240px; height: 6px; border-radius: 3px; background: var(--in-bg); overflow: hidden; }
.eq2-bar > span { display: block; height: 100%; background: linear-gradient(90deg,#34D9E0,#7C5CFF); transition: width .4s; }
.eq2-bar.indet > span { width: 30%; animation: eqIndet 1.2s ease-in-out infinite; }
@keyframes eqIndet { 0%{margin-left:-30%} 100%{margin-left:100%} }
.eq2-pct { font-size: 11px; color: #79c0ff; font-variant-numeric: tabular-nums; min-width: 34px; }
.eq2-card-actions { display: flex; flex-direction: column; gap: 7px; flex: none; align-items: stretch; min-width: 124px; }
.eq2-btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; font-size: 12px; border-radius: 8px; padding: 7px 12px; cursor: pointer; text-decoration: none; border: 1px solid var(--in-border); background: var(--in-bg-2); color: var(--in-fg); }
.eq2-btn:hover { border-color: var(--in-accent); }
.eq2-btn-kill { color: #fff; font-weight: 700; border: none; background: linear-gradient(135deg,#f85149,#d1242f); }
.eq2-btn-kill:hover { filter: brightness(1.08); }
.eq2-btn-row { display: flex; gap: 7px; }
.eq2-btn-row .eq2-btn { flex: 1; }
.eq2-protected { display: inline-flex; align-items: center; justify-content: center; font-size: 11px; color: #c9b6ff; border: 1px solid #a371f7; border-radius: 8px; padding: 7px 10px; }

/* Fila de rol dormido / congelado */
.eq2-idle { display: flex; align-items: center; gap: 12px; background: var(--in-bg-2); border: 1px solid var(--in-border); border-radius: var(--in-radius-sm); padding: 10px 15px; }
.eq2-idle .eq2-avatar { width: 30px; height: 30px; font-size: 15px; opacity: .85; }
.eq2-idle-id { display: flex; flex-direction: column; }
.eq2-idle-name { font-size: 13px; font-weight: 700; }
.eq2-idle-tag { font-size: 11px; color: var(--in-fg-dim); }
.eq2-idle-badge { margin-left: auto; font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .5px; border-radius: 999px; padding: 3px 11px; }
.eq2-badge-idle { color: var(--in-fg-dim); border: 1px solid var(--in-border); background: var(--in-bg); }
.eq2-badge-frozen { color: #d2a86a; border: 1px solid #6b5526; background: rgba(210,168,106,.1); }
.eq2-hidden { display: none !important; }`;

    const script = `
// === Equipo MIZPÁ (#4195) — vista de dotación =================================
const GH_ISSUE_BASE = 'https://github.com/intrale/platform/issues/';
let _eq = { roster: null, banner: null, providersBySkill: {}, skills: {} };
let _agentsBySkill = {};
let _allAgents = [];

function fmtModel(model){
    if(!model) return '';
    return String(model).replace(/^claude-/,'').replace(/^gpt-/,'gpt ').replace(/-/g,' ');
}
function agentProgress(durationMs, etaMs){
    if(!etaMs || etaMs <= 0) return { pct: 0, indeterminate: true };
    return { pct: Math.min(100, Math.round((durationMs/etaMs)*100)), indeterminate: false };
}
function roleMetaFor(skill){
    const r = (_eq.roster && _eq.roster._bySkill) ? _eq.roster._bySkill[skill] : null;
    if(r) return r;
    return { skill: skill, name: skill, tagline: '', icon: '⚙', color: '#8b949e', state: 'idle', liveCount: 0, max: 0 };
}

// --- Banner ---------------------------------------------------------------
function renderBanner(){
    const b = _eq.banner;
    if(!b) return;
    setText('eq-live-n', b.agentsLive);
    setText('eq-roles-badge', b.rolesAwake + ' / ' + b.rolesTotal + ' roles despiertos');
    setText('eq-tokmin', b.tokPerMin != null ? fmtNum(b.tokPerMin) : '—');
    if(b.veteran){
        setText('eq-veteran-v', fmtDur(b.veteran.durationMs));
        setText('eq-veteran-s', '#' + (b.veteran.issue||'?') + ' · ' + (b.veteran.name||b.veteran.skill||''));
    } else {
        setText('eq-veteran-v', '—'); setText('eq-veteran-s', 'sin agentes vivos');
    }
    setText('eq-cooling', b.coolingCount);
    // Visor de slots.
    const slots = b.slots || { used: 0, max: 0 };
    setText('eq-slots-count', slots.used + ' / ' + slots.max);
    const bars = document.getElementById('eq-slots-bars');
    if(bars){
        bars.innerHTML = '';
        for(let i=0;i<slots.max;i++){
            const s = document.createElement('span');
            s.className = 'eqm-slot' + (i < slots.used ? ' busy' : '');
            s.title = i < slots.used ? 'Cupo ocupado' : 'Cupo libre';
            bars.appendChild(s);
        }
    }
    const note = document.getElementById('eq-slots-note');
    if(note){
        note.textContent = slots.used >= slots.max && slots.max > 0
            ? 'Límite alcanzado — los listos esperan turno. El cupo se libera al apagarse un agente.'
            : (slots.max - slots.used) + ' cupo' + ((slots.max - slots.used)===1?'':'s') + ' libre' + ((slots.max - slots.used)===1?'':'s') + ' para nuevos agentes.';
    }
    // Chips.
    let idle = 0;
    if(_eq.roster){ for(const c of _eq.roster.categories) for(const r of c.roles) if(r.state==='idle') idle++; }
    setText('eq-chip-vivos', b.agentsLive);
    setText('eq-chip-cool', b.coolingCount);
    setText('eq-chip-idle', idle);
    setText('eq-chip-total', b.rolesTotal);
}

// --- Ficha de agente vivo -------------------------------------------------
function buildFicha(a){
    const meta = roleMetaFor(a.skill);
    const card = document.createElement('div'); card.className = 'eq2-card';
    card.dataset.search = ((meta.name||a.skill) + ' ' + a.skill + ' #' + a.issue + ' ' + (a.provider && a.provider.label || '') + ' ' + (a.title||'')).toLowerCase();

    // Columna identidad.
    const id = document.createElement('div'); id.className = 'eq2-card-id';
    const persona = document.createElement('div'); persona.className = 'eq2-card-persona';
    const av = document.createElement('span'); av.className = 'eq2-avatar';
    av.style.background = meta.color || '#8b949e'; av.textContent = meta.icon || '⚙'; persona.appendChild(av);
    const pid = document.createElement('div');
    const nm = document.createElement('div'); nm.className = 'eq2-card-name'; nm.textContent = meta.name || a.skill; pid.appendChild(nm);
    const tg = document.createElement('div'); tg.className = 'eq2-card-tag'; tg.textContent = meta.tagline || ''; pid.appendChild(tg);
    persona.appendChild(pid); id.appendChild(persona);
    const live = document.createElement('span'); live.className = 'eq2-state-live'; live.textContent = 'trabajando'; id.appendChild(live);
    const branchEl = document.createElement('div'); branchEl.className = 'eq2-card-pid';
    branchEl.textContent = 'rama ' + (a.branch || '—'); branchEl.title = a.branch || ''; id.appendChild(branchEl);
    card.appendChild(id);

    // Columna principal.
    const main = document.createElement('div'); main.className = 'eq2-card-main';
    const head = document.createElement('div'); head.className = 'eq2-card-head';
    const issue = document.createElement('a'); issue.className = 'eq2-issue';
    issue.textContent = '#' + a.issue + ' ↗';
    if(/^[0-9]+$/.test(String(a.issue))){ issue.href = GH_ISSUE_BASE + a.issue; issue.target = '_blank'; issue.rel = 'noopener noreferrer'; }
    head.appendChild(issue);
    const fase = document.createElement('span'); fase.className = 'eq2-fase'; fase.textContent = 'fase · ' + (a.fase||''); head.appendChild(fase);
    main.appendChild(head);
    if(a.title){ const t = document.createElement('div'); t.className = 'eq2-card-title'; t.textContent = a.title; main.appendChild(t); }

    const facts = document.createElement('div'); facts.className = 'eq2-card-facts';
    // Proveedor.
    const prov = document.createElement('span'); prov.className = 'eq2-fact';
    const pdot = document.createElement('span'); pdot.className = 'eq2-prov-dot';
    pdot.style.background = (meta.color || '#8b949e'); prov.appendChild(pdot);
    const pl = a.provider ? (a.provider.label + (a.provider.model ? ' ' + fmtModel(a.provider.model) : '')) : 'proveedor —';
    const provTxt = document.createElement('b'); provTxt.textContent = pl; prov.appendChild(provTxt);
    prov.title = 'Proveedor asignado al rol (agent-models.json)'; facts.appendChild(prov);
    // Tiempo en fase.
    const dur = document.createElement('span'); dur.className = 'eq2-fact'; dur.textContent = '⏱ ' + fmtDur(a.durationMs||0); dur.title = 'Tiempo en fase'; facts.appendChild(dur);
    // Rebotes.
    const reb = document.createElement('span'); reb.className = 'eq2-fact' + ((a.bounces||0) > 0 ? ' eq2-rebotes' : '');
    reb.textContent = '↩ ' + (a.bounces||0) + ' rebote' + ((a.bounces||0)===1?'':'s'); reb.title = 'Rebotes acumulados del issue'; facts.appendChild(reb);
    main.appendChild(facts);

    // Progreso.
    const prog = agentProgress(a.durationMs||0, a.etaMs);
    const progRow = document.createElement('div'); progRow.className = 'eq2-card-prog';
    const bar = document.createElement('span'); bar.className = 'eq2-bar' + (prog.indeterminate ? ' indet' : '');
    const fill = document.createElement('span'); if(!prog.indeterminate) fill.style.width = prog.pct + '%'; bar.appendChild(fill);
    progRow.appendChild(bar);
    const pct = document.createElement('span'); pct.className = 'eq2-pct'; pct.textContent = prog.indeterminate ? '—' : (prog.pct + '%'); progRow.appendChild(pct);
    main.appendChild(progRow);
    card.appendChild(main);

    // Columna acciones.
    const actions = document.createElement('div'); actions.className = 'eq2-card-actions';
    const cooldown = a.cooldown || null;
    if(cooldown){
        const cd = document.createElement('span'); cd.className = 'eq2-protected eq2-ag-cooldown';
        cd.setAttribute('data-cooldown-until', cooldown.cooldownUntil || '');
        cd.textContent = '⏳ cooldown · ' + (cooldown.failures||0) + ' fallos';
        actions.appendChild(cd);
    } else {
        const kill = document.createElement('button'); kill.className = 'eq2-btn eq2-btn-kill';
        kill.textContent = '⏹ Matar agente'; kill.title = 'Cancelar este agente';
        kill.addEventListener('click', () => killAgent(a.issue, a.skill, a.pipeline, a.fase, a.durationMs));
        actions.appendChild(kill);
        const restart = document.createElement('button'); restart.className = 'eq2-btn';
        restart.textContent = '↻ Reiniciar'; restart.title = 'Reiniciar este agente (lo devuelve a la cola para relanzarse)';
        restart.addEventListener('click', () => restartAgent(a.issue, a.skill, a.pipeline, a.fase, a.durationMs));
        actions.appendChild(restart);
    }
    const row = document.createElement('div'); row.className = 'eq2-btn-row';
    const issueBtn = document.createElement('a'); issueBtn.className = 'eq2-btn'; issueBtn.textContent = '↗ Issue';
    if(/^[0-9]+$/.test(String(a.issue))){ issueBtn.href = GH_ISSUE_BASE + a.issue; issueBtn.target = '_blank'; issueBtn.rel = 'noopener noreferrer'; }
    row.appendChild(issueBtn);
    if(a.hasLog && a.logFile){
        const log = document.createElement('a'); log.className = 'eq2-btn';
        log.href = '/logs/view/' + encodeURIComponent(a.logFile) + '?live=1'; log.target = '_blank'; log.rel = 'noopener noreferrer';
        log.textContent = '📄 Logs'; row.appendChild(log);
    }
    actions.appendChild(row);
    card.appendChild(actions);
    return card;
}

// --- Fila de rol dormido / congelado --------------------------------------
function buildIdleRow(role){
    const row = document.createElement('div'); row.className = 'eq2-idle';
    row.dataset.search = (role.name + ' ' + role.skill).toLowerCase();
    const av = document.createElement('span'); av.className = 'eq2-avatar';
    av.style.background = role.color || '#8b949e'; av.textContent = role.icon || '⚙'; row.appendChild(av);
    const idEl = document.createElement('div'); idEl.className = 'eq2-idle-id';
    const nm = document.createElement('div'); nm.className = 'eq2-idle-name'; nm.textContent = role.name || role.skill; idEl.appendChild(nm);
    const tg = document.createElement('div'); tg.className = 'eq2-idle-tag'; tg.textContent = role.tagline || ''; idEl.appendChild(tg);
    row.appendChild(idEl);
    const badge = document.createElement('span');
    if(role.state === 'frozen'){ badge.className = 'eq2-idle-badge eq2-badge-frozen'; badge.textContent = 'congelado'; badge.title = 'Skill congelado · reactivable por issue'; }
    else { badge.className = 'eq2-idle-badge eq2-badge-idle'; badge.textContent = 'ocioso'; badge.title = 'Sin tarea asignada'; }
    row.appendChild(badge);
    return row;
}

// --- Roster por categoría -------------------------------------------------
function renderRoster(){
    const cont = document.getElementById('eq-roster');
    if(!cont) return;
    if(!_eq.roster || !_eq.roster.categories || _eq.roster.categories.length === 0){
        cont.innerHTML = '<div class="eq2-empty">Sin roles configurados</div>';
        return;
    }
    cont.innerHTML = '';
    for(const cat of _eq.roster.categories){
        const block = document.createElement('div'); block.className = 'eq2-cat';
        const head = document.createElement('div'); head.className = 'eq2-cat-head';
        const dot = document.createElement('span'); dot.className = 'eq2-cat-dot'; dot.style.background = cat.color || '#8b949e'; head.appendChild(dot);
        const name = document.createElement('span'); name.className = 'eq2-cat-name'; name.textContent = cat.label; head.appendChild(name);
        const m = document.createElement('span'); m.className = 'eq2-cat-meta'; m.textContent = cat.liveCount + ' vivo' + (cat.liveCount===1?'':'s') + ' · ' + cat.total + ' roles'; head.appendChild(m);
        const roles = document.createElement('span'); roles.className = 'eq2-cat-roles';
        roles.textContent = cat.roles.map(r => r.skill).join(', '); roles.title = roles.textContent; head.appendChild(roles);
        block.appendChild(head);

        const list = document.createElement('div'); list.className = 'eq2-cat-list';
        for(const role of cat.roles){
            if(role.state === 'live'){
                const agents = _agentsBySkill[role.skill] || [];
                if(agents.length){ for(const a of agents) list.appendChild(buildFicha(a)); }
                else { list.appendChild(buildIdleRow(role)); } // defensivo: vivo sin agente listado
            } else {
                list.appendChild(buildIdleRow(role));
            }
        }
        block.appendChild(list);
        cont.appendChild(block);
    }
    applySearch();
}

// --- Búsqueda -------------------------------------------------------------
function applySearch(){
    const input = document.getElementById('eq-search');
    const q = (input && input.value || '').trim().toLowerCase();
    document.querySelectorAll('#eq-roster [data-search]').forEach(el => {
        const match = !q || el.dataset.search.indexOf(q) !== -1;
        el.classList.toggle('eq2-hidden', !match);
    });
    // Ocultar categorías sin coincidencias visibles.
    document.querySelectorAll('#eq-roster .eq2-cat').forEach(cat => {
        const visible = cat.querySelectorAll('[data-search]:not(.eq2-hidden)').length;
        cat.classList.toggle('eq2-hidden', q && visible === 0);
    });
}

// --- Cooldown countdown ---------------------------------------------------
function tickCooldownCountdowns(){
    const now = Date.now();
    document.querySelectorAll('.eq2-ag-cooldown[data-cooldown-until]').forEach(el => {
        const until = Date.parse(el.getAttribute('data-cooldown-until'));
        if(!until || isNaN(until)) return;
        const leftMs = until - now;
        const failsPart = el.textContent.split(' · ')[1] || '';
        if(leftMs <= 0){ el.textContent = '⏳ por expirar · ' + failsPart; return; }
        const s = Math.floor(leftMs/1000), mm = Math.floor(s/60), ss = s%60;
        el.textContent = '⏳ ' + mm + ':' + (ss<10?'0':'') + ss + ' · ' + failsPart;
    });
}

// --- Reiniciar agente -----------------------------------------------------
async function restartAgent(issue, skill, pipeline, fase, durationMs){
    const preview = [{label:'Skill', value:skill},{label:'Issue', value:'#'+issue}];
    if(fase) preview.push({label:'Fase', value:fase});
    if(durationMs != null) preview.push({label:'Tiempo en fase', value:fmtDur(durationMs)});
    if(!(await inConfirm({ title:'Reiniciar agente', message:'Se cancela el agente en curso y se devuelve a la cola para que el Pulpo lo relance.', confirmLabel:'Reiniciar agente', preview:preview }))) return;
    try{
        const r = await killAgentPost({issue, skill, pipeline, fase, restart:true});
        const j = await r.json();
        showToast(j.msg || (j.ok?'Agente reiniciado':'Falló el reinicio'), j.ok);
        if(typeof runAll === 'function') setTimeout(runAll, 600);
    } catch(e){ showToast('Error: '+e.message, false); }
}

// --- Polling --------------------------------------------------------------
function indexRoster(roster){
    if(!roster) return;
    roster._bySkill = {};
    for(const c of roster.categories) for(const r of c.roles) roster._bySkill[r.skill] = r;
}
async function tickEquipo(){
    const e = await fetchJson('/api/dash/equipo');
    if(e){ _eq = { roster: e.roster, banner: e.banner, providersBySkill: e.providersBySkill||{}, skills: e.skills||[] }; indexRoster(_eq.roster); }
    const a = await fetchJson('/api/dash/active');
    if(a){
        _allAgents = (a.agents||[]).filter(x => !(x.observational === true || x.cancelable === false));
        _agentsBySkill = {};
        for(const ag of _allAgents){ (_agentsBySkill[ag.skill] = _agentsBySkill[ag.skill] || []).push(ag); }
    }
    renderBanner();
    renderRoster();
}

// #4240 — Hidratación del banner de ola común (② del marco). El SSR llega neutro
// (igual que en la HOME); este tick espeja /api/dash/waves a los IDs mission-*
// del helper compartido renderMissionBanner. Defensivo: cualquier dato ausente
// degrada a neutro sin romper el resto de la pantalla.
async function tickEquipoMission(){
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

document.addEventListener('input', (ev) => { if(ev.target && ev.target.id === 'eq-search') applySearch(); });

const POLLS = [{ fn: tickHeader, ms: 5000 }, { fn: tickEquipo, ms: 5000 }, { fn: tickEquipoMission, ms: 30000 }];
async function runAll(){ for(const p of POLLS){ try{ await p.fn(); } catch{} } }
runAll();
for(const p of POLLS){ setInterval(() => { p.fn().catch(()=>{}); }, p.ms); }
setInterval(tickCooldownCountdowns, 1000);`;

    // #4240 — Marco común MIZPÁ: ① cabecera de marca (renderEquipoBrandBar, mismo
    // markup/clases `.mz-*` del theme.css que el resto de las pantallas), ② banner
    // de ola común (renderMissionBanner compartido de la HOME, vía `missionHtml`),
    // ③ barra de accesos (renderNavTabsSsr('equipo'), ya inyectada por pageShell).
    // El contenido propio de EQUIPO (`.eq2`) queda debajo del marco (CA-4). El
    // banner de ola se sirve neutro en SSR (igual que la HOME) y lo hidrata
    // tickEquipoMission() desde /api/dash/waves (CA-2/CA-6).
    const missionHtml = (homeView && typeof homeView.renderMissionBanner === 'function')
        ? homeView.renderMissionBanner()
        : '';
    return pageShell('Equipo', 'Dotación de agentes · MIZPÁ', body, script, css, 'equipo', {
        brandHtml: renderEquipoBrandBar(),
        missionHtml,
        breadcrumbHtml: breadcrumb,
    });
}

// ─────────────────── Pipeline ───────────────────
function renderPipeline() {
    // #4190 (Ola 7.1) — Rediseño integral MIZPÁ. La pantalla se reorganiza en
    // DOS bloques (Flujo de fases + Issues por fase), con marca + selector +
    // banner de misión consistentes con la HOME (#4189). El render concreto lo
    // produce el módulo views/dashboard/pipeline-redesign.js. Si el módulo no
    // cargó, se degrada al board legacy (defensa en profundidad — CA-A3).
    if (!pipelineRedesign) return renderPipelineLegacy();

    const brandHtml = pipelineRedesign.renderBrandBarPipeline();
    const body = pipelineRedesign.renderPipelineRedesignBody();
    const css = pipelineRedesign.PIPELINE_REDESIGN_CSS;
    const script = pipelineRedesign.pipelineRedesignClientScript();
    return pageShell('Pipeline', 'Issues por fase · centro de mando MIZPÁ', body, script, css, 'pipeline', { brandHtml });
}

// Board legacy (pre-#4190) — fallback si el módulo de rediseño no carga. Misma
// hidratación client-side sobre /api/dash/pipeline; columna por fase con scroll
// horizontal. Se conserva sólo como red de seguridad.
function renderPipelineLegacy() {
    const body = `
<section class="in-section">
  <div class="pl-section-head">
    <h2 class="in-section-title"><span class="in-section-title-icon">🔄</span>Pipeline · issues por fase</h2>
  </div>
  <div id="pipeline-board" class="pl-board"></div>
  <div id="pipeline-wave-band"></div>
</section>`;
    const css = `
.pl-board { display: flex; gap: 10px; overflow-x: auto; padding-bottom: 8px; }
.pl-col { min-width: 220px; flex: 1; background: var(--in-bg-3); border-radius: var(--in-radius-sm); padding: 10px; border: 1px solid var(--in-border); }
.pl-col-head { display: flex; align-items: center; justify-content: space-between; font-size: 11px; text-transform: uppercase; letter-spacing: 0.6px; color: var(--in-fg-dim); margin-bottom: 8px; padding-bottom: 6px; border-bottom: 1px solid var(--in-border); }
.pl-col-count { background: var(--in-bg); padding: 1px 8px; border-radius: 9px; font-size: 10px; color: var(--in-fg); }
.pl-card { background: var(--in-bg-2); border: 1px solid var(--in-border); border-radius: 6px; padding: 8px 10px; margin-bottom: 6px; font-size: 12px; color: var(--in-fg); }
.pl-card-title { font-size: 11px; color: var(--in-fg-dim); line-height: 1.4; }
.pl-card-issue a { color: var(--in-info); text-decoration: none; }`;
    const script = `
async function tickPipelineLegacy(){
    const d = await fetchJson('/api/dash/pipeline');
    if(!d) return;
    const board = document.getElementById('pipeline-board');
    if(!board) return;
    const fases = d.fases || [];
    const matrix = d.matrix || {};
    const cols = {};
    for(const { pipeline: p, fase } of fases){ cols[p+'/'+fase] = []; }
    for(const [issue, data] of Object.entries(matrix)){
        if(data.faseActual && cols[data.faseActual]){
            cols[data.faseActual].push({ issue, title: data.title });
        }
    }
    let html = '';
    for(const [key, items] of Object.entries(cols)){
        const cards = items.map(i => '<div class="pl-card"><div class="pl-card-issue"><a href="https://github.com/intrale/platform/issues/'+escapeHtml(i.issue)+'" target="_blank" rel="noopener">#'+escapeHtml(i.issue)+'</a></div><div class="pl-card-title">'+escapeHtml(i.title||'')+'</div></div>').join('');
        html += '<div class="pl-col"><div class="pl-col-head"><span>'+escapeHtml(key)+'</span><span class="pl-col-count">'+items.length+'</span></div>'+(cards||'<div class="in-empty">vacío</div>')+'</div>';
    }
    if(board.innerHTML !== html) board.innerHTML = html;
}
const POLLS = [{ fn: tickHeader, ms: 5000 }, { fn: tickPipelineLegacy, ms: 5000 }];
async function runAll(){ for(const p of POLLS){ try{ await p.fn(); } catch{} } }
runAll();
for(const p of POLLS){ setInterval(() => { p.fn().catch(()=>{}); }, p.ms); }`;
    return pageShell('Pipeline', 'Issues distribuidos por fase', body, script, css, 'pipeline');
}

// ─────────────────── Bloqueados ───────────────────
function renderBloqueados() {
    const body = `
<section class="in-section">
  <h2 class="in-section-title"><span class="in-section-title-icon">🚧</span>Esperando humano</h2>
  <div id="bloqueados-list"></div>
</section>`;
    const css = `
.blk-row { background: var(--in-bg-3); border: 1px solid var(--in-warn); border-radius: var(--in-radius-sm); padding: 14px 16px; margin-bottom: 10px; display: flex; flex-direction: column; gap: 6px; }
.blk-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.blk-prio { font-size: 11px; color: var(--in-fg-soft); font-variant-numeric: tabular-nums; min-width: 28px; }
.blk-prio.set { color: var(--in-fg-dim); font-weight: 600; }
.blk-issue { font-weight: 600; }
.blk-issue a { color: var(--in-info); }
.blk-issue a:hover { text-decoration: underline; }
.blk-title { color: var(--in-fg-dim); font-weight: 400; font-size: 12px; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.blk-summary { color: var(--in-fg); font-size: 12px; line-height: 1.4; opacity: 0.92; margin-top: 2px; }
.blk-summary.loading { opacity: 0.55; font-style: italic; }
.blk-skills-block { background: rgba(255,255,255,0.04); border-left: 2px solid var(--in-warn); border-radius: 0 4px 4px 0; padding: 6px 10px; display: flex; flex-direction: column; gap: 4px; margin-top: 2px; }
.blk-skills-label { font-size: 10px; color: var(--in-fg-dim); text-transform: uppercase; letter-spacing: 0.6px; font-weight: 600; }
.blk-skills-list { display: flex; flex-direction: column; gap: 4px; }
.blk-skill-row { display: flex; gap: 8px; align-items: baseline; font-size: 12px; line-height: 1.35; }
.blk-skill-chip { display: inline-block; font-weight: 600; color: var(--in-warn); background: var(--in-warn-soft); border: 1px solid var(--in-warn); border-radius: 3px; padding: 1px 7px; font-size: 11px; flex: 0 0 auto; }
.blk-skill-fase { color: var(--in-fg-soft); font-size: 11px; flex: 0 0 auto; }
.blk-skill-reason { color: var(--in-fg-dim); flex: 1; min-width: 0; }
.blk-events { padding: 6px 10px; background: rgba(255,255,255,0.04); border-left: 2px solid rgba(255,255,255,0.18); border-radius: 0 4px 4px 0; margin-top: 2px; }
.blk-events-label { font-size: 10px; color: var(--in-fg-dim); text-transform: uppercase; letter-spacing: 0.6px; margin-bottom: 4px; font-weight: 600; }
.blk-events-list { margin: 0; padding: 0; list-style: none; font-size: 12px; line-height: 1.45; }
.blk-events-list li { padding: 2px 0; color: var(--in-fg); border-top: 1px dashed rgba(255,255,255,0.06); }
.blk-events-list li:first-child { border-top: none; }
.blk-ev-when { display: inline-block; min-width: 42px; color: var(--in-fg-dim); font-size: 11px; font-variant-numeric: tabular-nums; }
.blk-ev-author { color: var(--in-info); font-weight: 600; margin-right: 4px; }
.blk-ev-text { color: var(--in-fg-dim); }
.blk-meta { display: flex; gap: 14px; font-size: 11px; color: var(--in-fg-dim); margin-top: 4px; }
.blk-actions { display: flex; gap: 8px; margin-left: auto; }
.blk-btn { background: transparent; border: 1px solid; border-radius: 6px; padding: 5px 11px; font-size: 11px; cursor: pointer; transition: background 0.15s; font-weight: 500; }
.blk-btn-reactivate { border-color: var(--in-ok); color: var(--in-ok); }
.blk-btn-reactivate:hover { background: var(--in-ok-soft); }
.blk-btn-dismiss { border-color: var(--in-fg-soft); color: var(--in-fg-dim); }
.blk-btn-dismiss:hover { background: var(--in-bg); color: var(--in-fg); }`;
    const script = `
function blkRelTime(iso){
    if(!iso) return '';
    const t = Date.parse(iso);
    if(!t) return '';
    const min = Math.round((Date.now() - t) / 60000);
    if(min < 1) return 'ahora';
    if(min < 60) return min + 'min';
    const hr = Math.round(min / 60);
    if(hr < 24) return hr + 'h';
    return Math.round(hr / 24) + 'd';
}
function blkEsc(s){ return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
async function tickBloqueados(){
    const d = await fetchJson('/api/dash/bloqueados');
    if(!d) return;
    const c = document.getElementById('bloqueados-list');
    if(!c) return;
    const list = d.bloqueados || [];
    if(list.length === 0){ c.innerHTML = '<div class="in-empty"><div class="in-empty-strong">Sin issues bloqueados</div>Todo fluye</div>'; return; }
    // Un issue puede tener varios skills pausados (p.ej. po, ux, guru en
    // validacion). El backend devuelve una entrada por skill; aquí los
    // agrupamos en una sola card por issue para que el usuario vea de un
    // solo vistazo cuáles agentes se reactivarían si despausara el issue.
    const groups = new Map();
    for(const b of list){
        const key = String(b.issue);
        let g = groups.get(key);
        if(!g){
            g = {
                issue: b.issue,
                title: b.title || '',
                summary: b.summary || '',
                summary_stale: !!b.summary_stale,
                priorityIndex: b.priorityIndex,
                recent_events: Array.isArray(b.recent_events) ? b.recent_events : [],
                skills: [],
                earliest_blocked_at: b.blocked_at || null,
            };
            groups.set(key, g);
        }
        g.skills.push({
            skill: b.skill || '?',
            phase: b.phase || '',
            pipeline: b.pipeline || '',
            reason: b.reason || '',
            question: b.question || '',
            blocked_at: b.blocked_at || null,
            age_hours: b.age_hours,
        });
        // Tomar el blocked_at más viejo como representativo del issue.
        if(b.blocked_at && (!g.earliest_blocked_at || b.blocked_at < g.earliest_blocked_at)){
            g.earliest_blocked_at = b.blocked_at;
        }
    }
    const seen = new Set();
    for(const [key, g] of groups){
        seen.add(key);
        let row = c.querySelector('[data-issue="'+key+'"]');
        if(!row){
            row = document.createElement('div');
            row.className = 'blk-row';
            row.dataset.issue = key;
            row.innerHTML = \`
                <div class="blk-head">
                  <span class="blk-prio"></span>
                  <div class="blk-issue"><a href="https://github.com/intrale/platform/issues/\${key}" target="_blank" rel="noopener">#\${key}</a></div>
                  <div class="blk-title"></div>
                  <div class="blk-actions">
                    <button class="blk-btn blk-btn-reactivate" title="Despausar todos los skills pendientes del issue">▶ Reactivar</button>
                    <button class="blk-btn blk-btn-dismiss" title="Cerrar el issue como desestimado">✕ Desestimar</button>
                  </div>
                </div>
                <div class="blk-summary"></div>
                <div class="blk-skills-block">
                  <div class="blk-skills-label">⏸ Skills pausados (se reactivan todos al despausar)</div>
                  <div class="blk-skills-list"></div>
                </div>
                <div class="blk-events" hidden>
                  <div class="blk-events-label">📜 Actividad reciente</div>
                  <ul class="blk-events-list"></ul>
                </div>
                <div class="blk-meta"><span class="blk-since"></span></div>
            \`;
            row.querySelector('.blk-btn-reactivate').addEventListener('click', () => nhReactivate(g.issue));
            row.querySelector('.blk-btn-dismiss').addEventListener('click', () => nhDismiss(g.issue));
        }
        const prioEl = row.querySelector('.blk-prio');
        if(g.priorityIndex != null){ prioEl.textContent = '#' + g.priorityIndex; prioEl.classList.add('set'); }
        else { prioEl.textContent = '—'; prioEl.classList.remove('set'); }
        row.querySelector('.blk-title').textContent = g.title || '';
        const sumEl = row.querySelector('.blk-summary');
        if(g.summary){
            sumEl.textContent = '📄 ' + g.summary;
            sumEl.classList.remove('loading');
            sumEl.hidden = false;
        } else if(g.summary_stale){
            sumEl.textContent = '📄 Cargando resumen funcional…';
            sumEl.classList.add('loading');
            sumEl.hidden = false;
        } else {
            sumEl.hidden = true;
        }
        // Skills pausados: chip con nombre, fase y motivo individual de cada uno.
        const skillsLabel = row.querySelector('.blk-skills-label');
        skillsLabel.textContent = g.skills.length === 1
            ? '⏸ Skill pausado'
            : '⏸ ' + g.skills.length + ' skills pausados (se reactivan todos al despausar)';
        const skillsList = row.querySelector('.blk-skills-list');
        skillsList.innerHTML = g.skills.map(s => {
            const reasonText = s.question || s.reason || 'sin motivo registrado';
            const faseText = s.pipeline && s.phase ? s.pipeline + '/' + s.phase : (s.phase || '');
            return '<div class="blk-skill-row">'
                + '<span class="blk-skill-chip">' + blkEsc(s.skill) + '</span>'
                + (faseText ? '<span class="blk-skill-fase">' + blkEsc(faseText) + '</span>' : '')
                + '<span class="blk-skill-reason">' + blkEsc(reasonText) + '</span>'
                + '</div>';
        }).join('');
        const evWrap = row.querySelector('.blk-events');
        const evList = row.querySelector('.blk-events-list');
        const events = g.recent_events;
        if(events.length === 0){
            evWrap.hidden = true;
            evList.innerHTML = '';
        } else {
            evWrap.hidden = false;
            evList.innerHTML = events.map(ev => '<li><span class="blk-ev-when">' + blkEsc(blkRelTime(ev.when)) + '</span> <span class="blk-ev-author">' + blkEsc(ev.author || '?') + '</span>: <span class="blk-ev-text">' + blkEsc(ev.preview || '') + '</span></li>').join('');
        }
        row.querySelector('.blk-since').textContent = 'pausado desde: ' + (g.earliest_blocked_at ? new Date(g.earliest_blocked_at).toLocaleString('es-AR') : '—');
        // appendChild de un nodo ya hijo lo MUEVE al final → reordena sin flicker.
        c.appendChild(row);
    }
    for(const row of [...c.children]){ if(!seen.has(row.dataset.issue || '')) row.remove(); }
}
const POLLS = [{ fn: tickHeader, ms: 5000 }, { fn: tickBloqueados, ms: 30000 }];
async function runAll(){ for(const p of POLLS){ try{ await p.fn(); } catch{} } }
runAll();
for(const p of POLLS){ setInterval(() => { p.fn().catch(()=>{}); }, p.ms); }`;
    return pageShell('Bloqueados', 'Issues esperando intervención humana', body, script, css, 'bloqueados');
}

// ─────────────────── Issues ───────────────────
function renderIssues() {
    const body = `
<section class="in-section">
  <h2 class="in-section-title"><span class="in-section-title-icon">📋</span>Backlog · issues activos en pipeline <span class="in-section-title-count" id="issues-count">…</span></h2>
  <input id="issues-search" placeholder="filtrar por #issue, skill o título…" class="in-btn" style="width:100%;margin-bottom:14px;padding:10px 14px;font-size:13px;background:var(--in-bg-3)">
  <div id="issues-table"></div>
</section>`;
    const css = `
.iss-row { display: grid; grid-template-columns: 50px 80px 1fr 130px 80px 60px 200px; gap: 10px; padding: 10px 12px; border-bottom: 1px solid var(--in-border-soft); align-items: center; font-size: 13px; }
.iss-row:hover { background: var(--in-bg-3); }
.iss-prio { font-size: 11px; color: var(--in-fg-soft); font-variant-numeric: tabular-nums; text-align: right; }
.iss-prio.set { color: var(--in-fg-dim); font-weight: 600; }
.iss-issue { font-weight: 600; }
.iss-issue a { color: var(--in-info); }
.iss-issue a:hover { text-decoration: underline; }
.iss-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--in-fg-dim); }
.iss-title.paused::before { content: "⏸ "; color: var(--in-warn); font-weight: 600; }
.iss-rebote { display: inline-block; font-size: 10px; font-weight: 600; color: var(--in-bad); border: 1px solid var(--in-bad); background: var(--in-bad-soft); border-radius: 3px; padding: 0 5px; margin-right: 6px; cursor: help; }
.iss-fase { font-size: 11px; text-transform: uppercase; color: var(--in-fg-dim); }
.iss-state { font-size: 11px; }
.iss-state.trabajando { color: var(--in-accent); }
.iss-state.listo { color: var(--in-ok); }
.iss-bounces { text-align: right; color: var(--in-fg-dim); font-size: 11px; }
.iss-bounces.warn { color: var(--in-warn); }
.iss-actions { display: flex; gap: 3px; justify-content: flex-end; }
.iss-btn { background: transparent; border: 1px solid var(--in-border); color: var(--in-fg-dim); border-radius: 4px; width: 26px; height: 22px; font-size: 11px; cursor: pointer; padding: 0; line-height: 1; transition: background 0.12s, border-color 0.12s; }
.iss-btn:hover { background: var(--in-bg-3); border-color: var(--in-accent); color: var(--in-accent); }
.iss-btn.pause:hover { border-color: var(--in-warn); color: var(--in-warn); }
.iss-btn.paused { border-color: var(--in-warn); color: var(--in-warn); }
.iss-btn.gh { text-decoration: none; display: inline-flex; align-items: center; justify-content: center; }`;
    const script = `
let issuesData = null;
function renderIssuesTable(filter){
    const c = document.getElementById('issues-table');
    if(!c || !issuesData) return;
    const rows = Object.entries(issuesData.matrix||{});
    const orderMap = new Map((issuesData.priorityOrder || []).map((id, idx) => [String(id), idx]));
    rows.sort((a, b) => {
        const oa = orderMap.get(String(a[0]));
        const ob = orderMap.get(String(b[0]));
        if(oa != null && ob != null) return oa - ob;
        if(oa != null) return -1;
        if(ob != null) return 1;
        return Number(a[0]) - Number(b[0]);
    });
    const f = (filter||'').toLowerCase();
    const filtered = f ? rows.filter(([id, data]) => id.includes(f) || (data.title||'').toLowerCase().includes(f)) : rows;
    setText('issues-count', filtered.length);
    if(filtered.length === 0){ c.innerHTML = '<div class="in-empty">Sin resultados</div>'; return; }
    let html = '';
    for(const [id, data] of filtered.slice(0, 200)){
        const labels = data.labels || [];
        const paused = labels.includes('blocked:dependencies');
        const prio = orderMap.has(String(id)) ? '#' + (orderMap.get(String(id)) + 1) : '—';
        const prioClass = orderMap.has(String(id)) ? 'iss-prio set' : 'iss-prio';
        const pauseAction = paused ? 'resume' : 'pause';
        const pauseIcon = paused ? '▶' : '⏸';
        const pauseTitle = paused ? 'Reanudar issue' : 'Pausar issue';
        const titleClass = paused ? 'iss-title paused' : 'iss-title';
        const reboteChip = data.rebote
          ? '<span class="iss-rebote" title="Rechazado en '+escapeHtml(data.rechazado_en_fase||'?')+(data.rechazado_skill_previo?'/'+escapeHtml(data.rechazado_skill_previo):'')+': '+escapeHtml((data.motivo_rechazo||'').replace(/"/g,"'").slice(0,300))+'">↩ rechazo</span>'
          : '';
        html += ''
          + '<div class="iss-row" data-issue="'+escapeHtml(id)+'">'
          +   '<div class="'+prioClass+'">'+escapeHtml(prio)+'</div>'
          +   '<div class="iss-issue"><a href="https://github.com/intrale/platform/issues/'+escapeHtml(id)+'" target="_blank" rel="noopener">#'+escapeHtml(id)+'</a></div>'
          +   '<div class="'+titleClass+'" title="'+escapeHtml(data.title||'')+'">'+reboteChip+escapeHtml(data.title||'')+'</div>'
          +   '<div class="iss-fase">'+escapeHtml(data.faseActual||'—')+'</div>'
          +   '<div class="iss-state '+escapeHtml(data.estadoActual||'')+'">'+escapeHtml(data.estadoActual||'')+'</div>'
          +   '<div class="iss-bounces '+(data.bounces>2?'warn':'')+'">'+(data.bounces||0)+'×</div>'
          +   '<div class="iss-actions">'
          +     '<button class="iss-btn" data-issue="'+escapeHtml(id)+'" data-action="move-top" title="Máxima prioridad">⏫</button>'
          +     '<button class="iss-btn" data-issue="'+escapeHtml(id)+'" data-action="move-up" title="Subir">▲</button>'
          +     '<button class="iss-btn" data-issue="'+escapeHtml(id)+'" data-action="move-down" title="Bajar">▼</button>'
          +     '<button class="iss-btn" data-issue="'+escapeHtml(id)+'" data-action="move-bottom" title="Mínima prioridad">⏬</button>'
          +     '<button class="iss-btn pause'+(paused?' paused':'')+'" data-issue="'+escapeHtml(id)+'" data-action="'+pauseAction+'" title="'+pauseTitle+'">'+pauseIcon+'</button>'
          +     '<a class="iss-btn gh" href="https://github.com/intrale/platform/issues/'+escapeHtml(id)+'" target="_blank" rel="noopener" title="Abrir en GitHub">↗</a>'
          +   '</div>'
          + '</div>';
    }
    c.innerHTML = html;
    c.querySelectorAll('.iss-btn[data-action]').forEach(b => {
        b.addEventListener('click', () => {
            const action = b.dataset.action;
            if(action === 'pause' || action === 'resume') return pauseIssue(b.dataset.issue, action === 'resume');
            return moveIssue(b.dataset.issue, action);
        });
    });
}
async function tickIssues(){
    issuesData = await fetchJson('/api/dash/pipeline');
    renderIssuesTable(document.getElementById('issues-search').value);
}
document.getElementById('issues-search').addEventListener('input', e => renderIssuesTable(e.target.value));
const POLLS = [{ fn: tickHeader, ms: 5000 }, { fn: tickIssues, ms: 60000 }];
async function runAll(){ for(const p of POLLS){ try{ await p.fn(); } catch{} } }
runAll();
for(const p of POLLS){ setInterval(() => { p.fn().catch(()=>{}); }, p.ms); }`;
    return pageShell('Issues', 'Backlog completo y filtros', body, script, css, 'issues');
}

// #3731 — renderMatriz extraído a views/dashboard/matriz.js (split del épico
// #3715). El render legacy + tickMatriz + CSS de la grilla viven ahora en el
// módulo propio. `/matriz` y `?view=matriz` resuelven a él vía dashboard-routes.js.

// ─────────────────── KPIs (detalle) ───────────────────
function renderKpisDetail() {
    const body = `
<section class="in-section">
  <h2 class="in-section-title"><span class="in-section-title-icon">📊</span>KPIs · detalle</h2>
  <div id="kpis-grid" class="kp-grid"></div>
</section>
<section class="in-section">
  <h2 class="in-section-title"><span class="in-section-title-icon">📅</span>Snapshot V3 (últimas 24h)</h2>
  <pre id="kpis-snapshot" class="kp-pre"></pre>
</section>`;
    const css = `
.kp-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 14px; }
.kp-tile { background: var(--in-bg-3); padding: 18px; border-radius: var(--in-radius); border: 1px solid var(--in-border); display: flex; flex-direction: column; gap: 6px; }
.kp-tile-label { font-size: 11px; text-transform: uppercase; color: var(--in-fg-dim); letter-spacing: 0.6px; }
.kp-tile-value { font-size: 32px; font-weight: 700; font-variant-numeric: tabular-nums; }
.kp-tile-sub { font-size: 11px; color: var(--in-fg-dim); }
.kp-pre { background: var(--in-bg-3); padding: 14px; border-radius: var(--in-radius-sm); font-family: var(--in-mono); font-size: 11px; overflow: auto; max-height: 400px; border: 1px solid var(--in-border); }`;
    const script = `
async function tickKpis(){
    const d = await fetchJson('/api/dash/kpis');
    if(!d) return;
    const grid = document.getElementById('kpis-grid');
    if(grid){
        // (#3357 CA-2/3/4) shapes nuevos para tokens24h, agentDurationMedianMs,
        // bouncePct. Mantenemos compat con shapes viejos (number) por si el
        // server queda atrás del cliente durante un deploy escalonado.
        const tk = d.tokens24h;
        const tkTotal = (tk && typeof tk === 'object') ? tk.total : tk;
        const cyc = d.agentDurationMedianMs != null ? d.agentDurationMedianMs : d.cycleTimeMs;
        const bp = d.bouncePct;
        const bpOverall = (bp && typeof bp === 'object') ? bp.overall : bp;
        const tiles = [
            { label: 'PRs · 7d', value: d.prsLast7d==null?'—':d.prsLast7d, sub: 'mergeados' },
            { label: 'Tokens · 24h', value: fmtNum(tkTotal), sub: 'todos los providers' },
            { label: 'Duración por agente', value: fmtDur(cyc), sub: 'mediana por marker' },
            { label: 'Cycle time issue', value: fmtDur(d.issueCycleTimeMs), sub: 'creación → cierre' },
            { label: '% rebote · 7d', value: fmtPct(bpOverall), sub: 'issues con ≥1 rebote' },
        ];
        let html = '';
        for(const t of tiles) html += '<div class="kp-tile"><div class="kp-tile-label">'+escapeHtml(t.label)+'</div><div class="kp-tile-value">'+escapeHtml(t.value)+'</div><div class="kp-tile-sub">'+escapeHtml(t.sub)+'</div></div>';
        if(grid.innerHTML !== html) grid.innerHTML = html;
    }
    const snap = await fetchJson('/metrics/snapshot?window=24h');
    const pre = document.getElementById('kpis-snapshot');
    if(pre){
        const txt = snap ? JSON.stringify(snap, null, 2).slice(0, 8000) : '— sin snapshot V3 —';
        if(pre.textContent !== txt) pre.textContent = txt;
    }
}
const POLLS = [{ fn: tickHeader, ms: 5000 }, { fn: tickKpis, ms: 60000 }];
async function runAll(){ for(const p of POLLS){ try{ await p.fn(); } catch{} } }
runAll();
for(const p of POLLS){ setInterval(() => { p.fn().catch(()=>{}); }, p.ms); }`;
    return pageShell('KPIs', 'Métricas detalladas', body, script, css, 'kpis');
}

// ─────────────────── Historial ───────────────────
// #4199 (Ola 7.1) — Rediseño integral MIZPÁ: la pantalla deja de ser el estado
// vacío «Sin actividad reciente» y pasa a ser la BITÁCORA / línea de tiempo del
// pipeline. Hereda el lenguaje visual MIZPÁ ya consensuado en las hermanas
// (#4189→#4198): barra de marca MIZPÁ (logo + tagline + selector multiproyecto)
// + nav curada 5 + «⋯ Más» (Historial vive dentro del popover + miga de pan),
// un banner de misión que resume el pulso reciente (eventos hoy, último merge,
// último rebote, agente más reciente, agregado ejecuciones/%✓), filtros (tipo de
// evento, skill, proveedor, issue + búsqueda de texto + chips de período) y un
// feed cronológico agrupado por día con enlaces directos por evento (issue en
// GitHub, log, PR, reporte PDF).
//
// Datos: /api/dash/historial expone el timeline real { groups[], aggregates,
// nextCursor, total, facets, filters } vía historialTimelineSlice. Cada item
// trae eventType (derivado) y provider (join del activity-log, #4199). El render
// del feed es 100% por DOM (createElement/textContent) → XSS-safe; los selects
// se pueblan desde `facets` (no del set crudo) para no vaciarse al filtrar.
function renderHistorialBrandBar() {
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

function renderHistorial() {
    // Miga de pan: Historial vive dentro de «⋯ Más» (tab secundario). La nav ya
    // deja el popover abierto + Historial marcado vía renderNavTabsSsr('historial');
    // la miga refuerza la ubicación (CA-1).
    const breadcrumb = `
  <div class="mz-crumb" aria-label="Ubicación: Más › Historial">
    <span class="mz-crumb-sep">⋯ Más</span>
    <span class="mz-crumb-sep">›</span>
    <b>🕓 Historial</b>
    <span class="mz-crumb-desc">· bitácora cronológica del pipeline</span>
  </div>`;

    const body = `
<section class="hm" aria-label="Bitácora del pipeline">
  <!-- Banner de misión: pulso reciente -->
  <div class="hm-banner" id="hm-banner">
    <div class="hm-live">
      <span class="hm-live-k">EVENTOS HOY</span>
      <span class="hm-live-n" id="hm-today">—</span>
      <span class="hm-live-u">en la bitácora</span>
    </div>
    <div class="hm-bm-text">
      <div class="hm-bm-ttl">El pulso reciente del pipeline
        <span class="hm-bm-badge"><b id="hm-aggr-count">—</b> ejec. · <b id="hm-aggr-pct">—</b> ✓</span>
      </div>
      <div class="hm-bm-desc">Cada lanzamiento de agente, cambio de fase, build, merge, rebote y bloqueo queda registrado acá en orden cronológico. Filtrá por tipo de evento, issue, skill o proveedor, y saltá directo al issue o a los logs de cada evento.</div>
      <div class="hm-bm-metrics">
        <div class="hm-bm-wm"><div class="hm-bm-wm-l">🔀 ÚLTIMO MERGE</div><div class="hm-bm-wm-v" id="hm-merge">—</div></div>
        <div class="hm-bm-wm"><div class="hm-bm-wm-l">↩ ÚLTIMO REBOTE</div><div class="hm-bm-wm-v" id="hm-rebote">—</div></div>
        <div class="hm-bm-wm"><div class="hm-bm-wm-l">⚡ AGENTE MÁS RECIENTE</div><div class="hm-bm-wm-v" id="hm-recent">—</div></div>
      </div>
    </div>
  </div>

  <!-- Filtros + búsqueda -->
  <div class="hm-filters" data-hm-filters>
    <span class="hm-chips" role="group" aria-label="Período">
      <button type="button" class="hm-chip hm-chip-on" data-hm-period="all">Todo</button>
      <button type="button" class="hm-chip" data-hm-period="today">Hoy</button>
      <button type="button" class="hm-chip" data-hm-period="7d">7 d</button>
      <button type="button" class="hm-chip" data-hm-period="30d">30 d</button>
    </span>
    <select class="hm-sel" data-hm-filter="eventType" aria-label="Filtrar por tipo de evento"><option value="">Todo evento</option></select>
    <select class="hm-sel" data-hm-filter="skill" aria-label="Filtrar por agente o skill"><option value="">Todo skill</option></select>
    <select class="hm-sel" data-hm-filter="provider" aria-label="Filtrar por proveedor"><option value="">Todo proveedor</option></select>
    <input class="hm-issue-filter" type="search" inputmode="numeric" data-hm-filter="issue" placeholder="# issue" autocomplete="off" maxlength="12" aria-label="Filtrar por número de issue">
    <input class="hm-search" type="search" data-hm-filter="q" placeholder="🔍 buscar texto…" autocomplete="off" maxlength="200" aria-label="Buscar texto libre">
  </div>

  <!-- Feed cronológico -->
  <div class="hm-timeline" id="hm-timeline" data-hm-timeline><div class="hm-empty"><div class="hm-empty-strong">Cargando bitácora…</div></div></div>
  <button type="button" class="hm-load-more" id="hm-load-more" style="display:none">Ver más eventos…</button>
</section>`;

    const css = `
.hm { display: flex; flex-direction: column; gap: 16px; }

/* Banner de misión */
.hm-banner { display: flex; align-items: stretch; gap: 20px; position: relative; overflow: hidden; flex-wrap: wrap;
  background: linear-gradient(110deg, rgba(52,217,224,.14), rgba(124,92,255,.08) 45%, transparent 75%), linear-gradient(180deg, var(--in-bg-2,#11151E), var(--in-bg-3,#141925));
  border: 1px solid rgba(52,217,224,.22); border-radius: 16px; padding: 18px 22px; }
.hm-live { display: flex; flex-direction: column; align-items: center; justify-content: center; min-width: 112px; padding: 12px 16px; border-radius: 14px; flex: none;
  background: linear-gradient(135deg, rgba(52,217,224,.22), rgba(124,92,255,.16)); border: 1px solid rgba(52,217,224,.3); }
.hm-live-k { font-size: 9.5px; font-weight: 800; letter-spacing: 1.2px; color: #9fe9ee; text-align: center; }
.hm-live-n { font-size: 38px; font-weight: 800; color: #bff3f6; line-height: 1; font-variant-numeric: tabular-nums; }
.hm-live-u { font-size: 10px; color: var(--in-fg-dim,#8A93A6); font-weight: 600; margin-top: 4px; letter-spacing: .3px; }
.hm-bm-text { flex: 1; min-width: 280px; }
.hm-bm-ttl { font-size: 19px; font-weight: 800; display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.hm-bm-badge { font-size: 11px; color: var(--brand-cyan,#34D9E0); background: rgba(52,217,224,.12); border: 1px solid rgba(52,217,224,.3); padding: 3px 9px; border-radius: 20px; font-weight: 600; letter-spacing: .3px; }
.hm-bm-badge b { color: #bff3f6; font-variant-numeric: tabular-nums; }
.hm-bm-desc { font-size: 13px; color: var(--in-fg-dim,#8A93A6); margin-top: 5px; max-width: 640px; line-height: 1.45; }
.hm-bm-metrics { display: flex; gap: 10px; margin-top: 12px; flex-wrap: wrap; }
.hm-bm-wm { flex: 1; min-width: 184px; background: rgba(255,255,255,.035); border: 1px solid var(--in-border,rgba(255,255,255,.07)); border-radius: 11px; padding: 9px 12px; }
.hm-bm-wm-l { font-size: 9.5px; font-weight: 800; letter-spacing: .7px; color: var(--in-fg-dim,#5B6376); }
.hm-bm-wm-v { font-size: 13px; font-weight: 600; margin-top: 4px; line-height: 1.3; color: var(--in-fg); }
.hm-bm-wm-v.hm-bm-empty { color: var(--in-fg-dim,#5B6376); font-weight: 400; font-style: italic; }
.hm-bm-issue { color: #58a6ff; font-weight: 800; text-decoration: none; }
.hm-bm-issue:hover { text-decoration: underline; }

/* Filtros */
.hm-filters { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.hm-chips { display: inline-flex; gap: 6px; }
.hm-chip { font-size: 12px; color: var(--in-fg-dim); background: var(--in-bg-2); border: 1px solid var(--in-border); border-radius: 999px; padding: 6px 13px; cursor: pointer; transition: border-color .12s, color .12s; }
.hm-chip:hover { color: var(--in-fg); border-color: var(--in-accent); }
.hm-chip-on { color: #06121a; background: linear-gradient(135deg,#34D9E0,#7C5CFF); border-color: transparent; font-weight: 700; }
.hm-sel, .hm-issue-filter, .hm-search { background: var(--in-bg-2); border: 1px solid var(--in-border); border-radius: 10px; padding: 8px 11px; color: var(--in-fg); font-size: 12px; }
.hm-sel:focus-visible, .hm-issue-filter:focus-visible, .hm-search:focus-visible { outline: 2px solid var(--in-accent); outline-offset: 1px; }
.hm-issue-filter { width: 92px; }
.hm-search { flex: 1; min-width: 200px; max-width: 360px; margin-left: auto; }

/* Timeline */
.hm-timeline { display: flex; flex-direction: column; gap: 16px; }
.hm-day-group { display: flex; flex-direction: column; gap: 8px; }
.hm-day { display: flex; align-items: baseline; gap: 12px; padding: 4px 2px; border-bottom: 1px solid var(--in-border-soft,rgba(255,255,255,.06)); position: sticky; top: 0; }
.hm-day-label { font-size: 13px; font-weight: 800; letter-spacing: .4px; text-transform: capitalize; }
.hm-day-aggr { font-size: 11px; color: var(--in-fg-dim); font-variant-numeric: tabular-nums; }
.hm-day-items { display: flex; flex-direction: column; gap: 6px; }

/* Card de evento */
.hm-item { background: var(--in-bg-3); border: 1px solid var(--in-border); border-left: 3px solid var(--in-border); border-radius: var(--in-radius-sm); overflow: hidden; }
.hm-item[open] { border-color: var(--in-accent); }
.hm-item.hm-ev-merge { border-left-color: #2ee6c1; }
.hm-item.hm-ev-rebote { border-left-color: var(--in-warn,#d29922); }
.hm-item.hm-ev-rechazo { border-left-color: var(--in-bad,#f85149); }
.hm-item.hm-ev-aprob { border-left-color: var(--in-ok,#3fb950); }
.hm-item.hm-ev-run { border-left-color: var(--in-accent,#58a6ff); }
.hm-item.hm-ev-fase { border-left-color: var(--in-fg-soft,#6b7280); }
.hm-card { display: flex; align-items: center; gap: 10px; padding: 9px 13px; cursor: pointer; list-style: none; flex-wrap: wrap; }
.hm-card::-webkit-details-marker { display: none; }
.hm-card:hover { background: rgba(255,255,255,.03); }
.hm-status-ic { font-size: 13px; width: 16px; text-align: center; flex: none; }
.hm-status-ic.hm-ev-merge { color: #2ee6c1; }
.hm-status-ic.hm-ev-rebote { color: var(--in-warn,#d29922); }
.hm-status-ic.hm-ev-rechazo { color: var(--in-bad,#f85149); }
.hm-status-ic.hm-ev-aprob { color: var(--in-ok,#3fb950); }
.hm-status-ic.hm-ev-run { color: var(--in-accent,#58a6ff); }
.hm-avatar { width: 26px; height: 26px; border-radius: 7px; display: flex; align-items: center; justify-content: center; font-size: 14px; flex: none; }
.hm-issue { font-size: 13px; min-width: 0; max-width: 360px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hm-issue b { color: #58a6ff; font-weight: 700; }
.hm-title { color: var(--in-fg-dim); }
.hm-skill { font-size: 11px; color: var(--in-fg-dim); }
.hm-type { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .4px; padding: 2px 8px; border-radius: 9px; border: 1px solid var(--in-border); background: var(--in-bg); color: var(--in-fg-dim); }
.hm-type.hm-ev-merge { color: #2ee6c1; border-color: rgba(46,230,193,.4); }
.hm-type.hm-ev-rebote { color: var(--in-warn,#d29922); border-color: rgba(210,153,34,.4); }
.hm-type.hm-ev-rechazo { color: var(--in-bad,#f85149); border-color: rgba(248,81,73,.4); }
.hm-type.hm-ev-aprob { color: var(--in-ok,#3fb950); border-color: rgba(63,185,80,.4); }
.hm-type.hm-ev-run { color: var(--in-accent,#58a6ff); border-color: rgba(88,166,255,.4); }
.hm-prov { font-size: 10px; color: #c9b6ff; border: 1px solid rgba(163,113,247,.4); background: rgba(163,113,247,.08); border-radius: 9px; padding: 2px 8px; }
.hm-meta { font-size: 11px; color: var(--in-fg-dim); font-variant-numeric: tabular-nums; }
.hm-time { font-size: 11px; color: var(--in-fg-soft); margin-left: auto; white-space: nowrap; }
.hm-actions { display: inline-flex; gap: 6px; flex: none; }
.hm-act { font-size: 11px; color: var(--in-fg-dim); border: 1px solid var(--in-border); border-radius: 7px; padding: 3px 8px; text-decoration: none; }
.hm-act:hover { border-color: var(--in-accent); color: var(--in-accent); }

/* Detalle expandible */
.hm-detail { padding: 4px 14px 12px 42px; }
.hm-d-row { display: flex; gap: 8px; flex-wrap: wrap; }
.hm-d-item { font-size: 11px; color: var(--in-fg-dim); background: var(--in-bg-2); border: 1px solid var(--in-border); border-radius: 6px; padding: 3px 9px; }
.hm-d-item.hm-d-warn { color: var(--in-warn,#d29922); border-color: rgba(210,153,34,.35); }
.hm-d-item.hm-d-cause { color: var(--in-fg); max-width: 100%; }
.hm-d-attach { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 7px; }
.hm-attach { font-size: 10px; color: var(--in-fg-dim); background: var(--in-bg); border: 1px dashed var(--in-border); border-radius: 6px; padding: 2px 8px; }

/* Estado vacío + load more */
.hm-empty { text-align: center; padding: 40px 18px; color: var(--in-fg-dim); display: flex; flex-direction: column; gap: 8px; align-items: center; }
.hm-empty-ic { font-size: 38px; opacity: .7; }
.hm-empty-strong { font-size: 15px; font-weight: 700; color: var(--in-fg); }
.hm-empty-sub { font-size: 12px; max-width: 420px; line-height: 1.5; }
.hm-load-more { align-self: center; font-size: 12px; color: var(--in-fg-dim); background: var(--in-bg-2); border: 1px solid var(--in-border); border-radius: 999px; padding: 8px 18px; cursor: pointer; }
.hm-load-more:hover { border-color: var(--in-accent); color: var(--in-accent); }`;

    const script = `
// === Historial MIZPÁ (#4199) — bitácora del pipeline ==========================
const GH_ISS = 'https://github.com/intrale/platform/issues/';
const EVENT_META = {
  merge:      { ic: '🔀', label: 'merge',      cls: 'hm-ev-merge' },
  rebote:     { ic: '↩',  label: 'rebote',     cls: 'hm-ev-rebote' },
  rechazo:    { ic: '✗',  label: 'rechazo',    cls: 'hm-ev-rechazo' },
  aprobacion: { ic: '✓',  label: 'aprobación', cls: 'hm-ev-aprob' },
  ejecucion:  { ic: '●',  label: 'en curso',   cls: 'hm-ev-run' },
  fase:       { ic: '•',  label: 'fase',       cls: 'hm-ev-fase' }
};
const EVENT_LABELS = { merge:'Merges', rebote:'Rebotes', rechazo:'Rechazos', aprobacion:'Aprobaciones', ejecucion:'En curso', fase:'Fases' };
let hmState = { period:'all', eventType:'', skill:'', provider:'', issue:'', q:'' };
let hmFacetsSig = '';

function hmEl(tag, cls, txt){ var e=document.createElement(tag); if(cls) e.className=cls; if(txt!=null) e.textContent=txt; return e; }
function hmRel(ts){ var t = typeof ts==='string'?Date.parse(ts):ts; if(!isFinite(t)||t<=0) return ''; var d=Date.now()-t; if(d<0) d=0; var m=Math.floor(d/60000); if(m<1) return 'ahora'; if(m<60) return 'hace '+m+' min'; var h=Math.floor(m/60); if(h<24) return 'hace '+h+' h'; return 'hace '+Math.floor(h/24)+' d'; }
function hmTs(h){ return h.estado==='trabajando' ? h.startedAt : h.finishedAt; }
function hmPct(p){ var v=Number(p); return isFinite(v)? Math.round(v*100)+' %':'—'; }
function hmSafeFile(s){ return /^[A-Za-z0-9._-]+$/.test(String(s||'')); }
function hmLink(href, label, title){ var a=hmEl('a','hm-act',label); a.href=href; a.target='_blank'; a.rel='noopener noreferrer'; if(title) a.title=title; a.addEventListener('click', function(ev){ ev.stopPropagation(); }); return a; }

function hmBuildQuery(cursor){
  var p = new URLSearchParams();
  if(hmState.period && hmState.period!=='all') p.set('period', hmState.period);
  if(hmState.eventType) p.set('eventType', hmState.eventType);
  if(hmState.skill) p.set('skill', hmState.skill);
  if(hmState.provider) p.set('provider', hmState.provider);
  if(hmState.issue) p.set('issue', hmState.issue);
  if(hmState.q) p.set('q', hmState.q);
  if(cursor) p.set('cursor', cursor);
  return p.toString();
}

function hmCard(h){
  var meta = EVENT_META[h.eventType] || EVENT_META.fase;
  var det = document.createElement('details');
  det.className = 'hm-item ' + meta.cls;
  var sum = hmEl('summary','hm-card');
  sum.appendChild(hmEl('span','hm-status-ic '+meta.cls, meta.ic));
  var av = hmEl('span','hm-avatar', SKILL_ICONS[h.skill] || '⚙');
  av.style.background = SKILL_COLORS[h.skill] || '#30363d';
  sum.appendChild(av);
  var iss = hmEl('span','hm-issue');
  iss.appendChild(hmEl('b', null, '#'+h.issue));
  if(h.titulo) iss.appendChild(hmEl('span','hm-title', ' '+String(h.titulo).slice(0,52)));
  sum.appendChild(iss);
  sum.appendChild(hmEl('span','hm-skill', h.skill||''));
  sum.appendChild(hmEl('span','hm-type '+meta.cls, meta.label));
  if(h.provider) sum.appendChild(hmEl('span','hm-prov', h.provider));
  sum.appendChild(hmEl('span','hm-meta', (h.fase||'') + ' · ' + fmtDur(h.duration)));
  sum.appendChild(hmEl('span','hm-time', hmRel(hmTs(h))));
  var acts = hmEl('span','hm-actions');
  var n = Number(h.issue);
  acts.appendChild(hmLink(GH_ISS + (isFinite(n)?n:''), 'issue ↗', 'Ver issue en GitHub'));
  if(h.hasLog && hmSafeFile(h.logFile)) acts.appendChild(hmLink('/logs/view/'+h.logFile+(h.estado==='trabajando'?'?live=1':''), 'log', 'Ver log del evento'));
  if(h.prUrl && /^https:\\/\\/(github\\.com|.*\\.github\\.com)\\//.test(h.prUrl)) acts.appendChild(hmLink(h.prUrl, 'PR ↗', 'Ver Pull Request'));
  if(h.hasRejectionPdf && hmSafeFile(h.rejectionPdf)) acts.appendChild(hmLink('/logs/'+h.rejectionPdf, '📄', 'Reporte de rechazo (PDF)'));
  sum.appendChild(acts);
  det.appendChild(sum);

  var d = hmEl('div','hm-detail');
  var row = hmEl('div','hm-d-row');
  row.appendChild(hmEl('span','hm-d-item', 'fase ' + (h.fase||'—') + ' · ' + fmtDur(h.duration)));
  if(Number(h.reboteNumero)>0) row.appendChild(hmEl('span','hm-d-item hm-d-warn', 'rebote ×'+Number(h.reboteNumero)));
  if(Number(h.crossphaseCount)>0) row.appendChild(hmEl('span','hm-d-item hm-d-warn', 'cross-phase ×'+Number(h.crossphaseCount)));
  if(h.provider) row.appendChild(hmEl('span','hm-d-item', 'proveedor: '+h.provider));
  var costo = (h.costo!=null && isFinite(Number(h.costo))) ? Number(h.costo).toFixed(2)+' USD' : 's/d';
  row.appendChild(hmEl('span','hm-d-item', 'costo: '+costo));
  if(h.motivo) row.appendChild(hmEl('span','hm-d-item hm-d-cause', 'causa: '+String(h.motivo).slice(0,180)));
  d.appendChild(row);
  if(Array.isArray(h.attachments) && h.attachments.length){
    var at = hmEl('div','hm-d-attach');
    h.attachments.slice(0,8).forEach(function(a){ var lbl=(a && (a.descriptor || a.path)) || 'entregable'; at.appendChild(hmEl('span','hm-attach', '📎 '+String(lbl).slice(0,40))); });
    d.appendChild(at);
  }
  det.appendChild(d);
  return det;
}

function hmEmpty(){
  var box = hmEl('div','hm-empty');
  box.appendChild(hmEl('div','hm-empty-ic', '🕓'));
  box.appendChild(hmEl('div','hm-empty-strong', 'Sin eventos para estos filtros'));
  box.appendChild(hmEl('div','hm-empty-sub', 'La bitácora del pipeline aparece acá apenas hay actividad: lanzamientos de agentes, fases, builds, merges, rebotes y bloqueos.'));
  return box;
}

function hmRenderTimeline(data, append){
  var tl = document.getElementById('hm-timeline'); if(!tl) return;
  if(!append) tl.textContent = '';
  if(!data || !data.groups || !data.groups.length){
    if(!append) tl.appendChild(hmEmpty());
    return;
  }
  data.groups.forEach(function(g){
    var grp = hmEl('div','hm-day-group');
    var day = hmEl('div','hm-day');
    day.appendChild(hmEl('span','hm-day-label', g.dayLabel));
    day.appendChild(hmEl('span','hm-day-aggr', g.count + ' ejec. · ' + hmPct(g.pctApproved) + ' ✓'));
    grp.appendChild(day);
    var items = hmEl('div','hm-day-items');
    g.items.forEach(function(h){ items.appendChild(hmCard(h)); });
    grp.appendChild(items);
    tl.appendChild(grp);
  });
}

function hmFillSelect(sel, values, selected, allLabel, labelMap){
  if(!sel) return;
  var cur = selected || '';
  sel.textContent = '';
  var o0 = hmEl('option', null, allLabel); o0.value=''; sel.appendChild(o0);
  values.forEach(function(v){ var o=hmEl('option', null, (labelMap && labelMap[v]) ? labelMap[v] : v); o.value=v; sel.appendChild(o); });
  sel.value = cur;
}

function hmUpdateFacets(facets){
  if(!facets) return;
  var sig = JSON.stringify(facets) + '|' + hmState.eventType + '|' + hmState.skill + '|' + hmState.provider;
  if(sig === hmFacetsSig) return;
  hmFacetsSig = sig;
  hmFillSelect(document.querySelector('[data-hm-filter="eventType"]'), facets.eventTypes||[], hmState.eventType, 'Todo evento', EVENT_LABELS);
  hmFillSelect(document.querySelector('[data-hm-filter="skill"]'), facets.skills||[], hmState.skill, 'Todo skill', null);
  hmFillSelect(document.querySelector('[data-hm-filter="provider"]'), facets.providers||[], hmState.provider, 'Todo proveedor', null);
}

function hmSetBanner(id, h, emptyTxt){
  var box = document.getElementById(id); if(!box) return;
  box.textContent = '';
  if(!h){ box.appendChild(document.createTextNode(emptyTxt)); box.classList.add('hm-bm-empty'); return; }
  box.classList.remove('hm-bm-empty');
  var a = document.createElement('a'); a.href = GH_ISS + h.issue; a.target='_blank'; a.rel='noopener noreferrer'; a.className='hm-bm-issue'; a.textContent = '#'+h.issue;
  box.appendChild(a);
  box.appendChild(document.createTextNode(' ' + (h.skill||'') + ' · ' + hmRel(hmTs(h))));
}

function hmUpdateBanner(data){
  if(!data) return;
  var today = 0;
  (data.groups||[]).forEach(function(g){ if(g.dayLabel==='Hoy') today = g.count; });
  setText('hm-today', today);
  var flat = [];
  (data.groups||[]).forEach(function(g){ (g.items||[]).forEach(function(h){ flat.push(h); }); });
  var merge=null, rebote=null;
  for(var i=0;i<flat.length;i++){ var h=flat[i]; if(!merge && h.eventType==='merge') merge=h; if(!rebote && h.eventType==='rebote') rebote=h; if(merge && rebote) break; }
  hmSetBanner('hm-merge', merge, 'sin merges recientes');
  hmSetBanner('hm-rebote', rebote, 'sin rebotes recientes');
  hmSetBanner('hm-recent', flat[0], 'sin actividad');
  var agg = data.aggregates || {};
  setText('hm-aggr-count', agg.count!=null ? agg.count : '—');
  setText('hm-aggr-pct', hmPct(agg.pctApproved));
}

var hmLoadMore = document.getElementById('hm-load-more');
function hmApply(cursor, append){
  return fetchJson('/api/dash/historial?' + hmBuildQuery(cursor)).then(function(data){
    if(!data) return;
    hmRenderTimeline(data, append);
    hmUpdateFacets(data.facets);
    if(hmLoadMore){
      if(data.nextCursor!=null){ hmLoadMore.style.display=''; hmLoadMore.setAttribute('data-next', data.nextCursor); }
      else hmLoadMore.style.display='none';
    }
  });
}
function hmRefreshBanner(){
  // Pulso global (sin filtros), independiente de lo que el operador esté viendo.
  return fetchJson('/api/dash/historial?period=all&limit=40').then(function(data){ if(data) hmUpdateBanner(data); });
}

var hmFilters = document.querySelector('[data-hm-filters]');
var hmDebounce;
if(hmFilters){
  hmFilters.addEventListener('click', function(ev){
    var chip = ev.target.closest('[data-hm-period]'); if(!chip) return;
    hmState.period = chip.getAttribute('data-hm-period');
    hmFilters.querySelectorAll('[data-hm-period]').forEach(function(c){ c.classList.toggle('hm-chip-on', c===chip); });
    hmApply(0, false);
  });
  hmFilters.addEventListener('change', function(ev){
    var f = ev.target.getAttribute && ev.target.getAttribute('data-hm-filter'); if(!f || f==='q' || f==='issue') return;
    hmState[f] = ev.target.value || '';
    hmApply(0, false);
  });
  hmFilters.addEventListener('input', function(ev){
    var f = ev.target.getAttribute && ev.target.getAttribute('data-hm-filter'); if(f!=='q' && f!=='issue') return;
    clearTimeout(hmDebounce);
    // El filtro de issue es numérico: descarta cualquier no-dígito.
    if(f==='issue') hmState.issue = (ev.target.value||'').replace(/[^0-9]/g,'');
    else hmState.q = ev.target.value || '';
    hmDebounce = setTimeout(function(){ hmApply(0, false); }, 300);
  });
}
if(hmLoadMore){
  hmLoadMore.addEventListener('click', function(){ var c = hmLoadMore.getAttribute('data-next'); if(c!=null) hmApply(c, true); });
}

// #4244 — Hidratación del banner de ola común (② del marco MIZPÁ). El SSR llega
// neutro (igual que en la HOME / EQUIPO); este tick espeja /api/dash/waves a los
// IDs mission-* del helper compartido renderMissionBanner. Defensivo: cualquier
// dato ausente degrada a neutro sin romper el resto de la pantalla.
async function hmTickMission(){
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

const POLLS = [
  { fn: tickHeader, ms: 5000 },
  { fn: hmTickMission, ms: 30000 },
  { fn: hmRefreshBanner, ms: 15000 },
  { fn: function(){ return hmApply(0, false); }, ms: 45000 }
];
async function runAll(){ for(const p of POLLS){ try{ await p.fn(); } catch{} } }
runAll();
for(const p of POLLS){ setInterval(() => { p.fn().catch(()=>{}); }, p.ms); }`;

    // #4244 — Marco común MIZPÁ en HISTORIAL (de #4234): ① cabecera de marca
    // (renderHistorialBrandBar, mismo markup/clases `.mz-*` del theme.css que el
    // resto), ② banner de ola común (renderMissionBanner compartido de la HOME,
    // vía `missionHtml`, SSR neutro + hidratado por hmTickMission desde
    // /api/dash/waves), ③ barra de accesos (renderNavTabsSsr('historial'), ya
    // inyectada por pageShell). El contenido propio de HISTORIAL (`.hm`, su banner
    // de pulso reciente y el feed) queda debajo del marco (CA-4). Reusa los
    // helpers/CSS compartidos del marco (CA-5: el CSS `mz-*` ya vive en theme.css,
    // no se duplica markup). Si la HOME no cargó, `missionHtml` queda vacío y el
    // resto del marco sigue intacto (defensa en profundidad — el pipeline no puede morir).
    const missionHtml = (homeView && typeof homeView.renderMissionBanner === 'function')
        ? homeView.renderMissionBanner()
        : '';
    return pageShell('Historial', 'Bitácora del pipeline · MIZPÁ', body, script, css, 'historial', {
        brandHtml: renderHistorialBrandBar(),
        missionHtml,
        breadcrumbHtml: breadcrumb,
    });
}

// ─────────────────── Costos ───────────────────
function renderCostos(opts) {
    // #4194 EP7.1 — la pantalla COSTOS es ahora el rediseño integral MIZPÁ
    // (banner de misión + gráfico de barras apiladas 14d por proveedor +
    // proyecciones + detalle por skill con columna de proveedor + «Cuota por
    // proveedor» con las 5 tarjetas). El `redesignHtml` lo arma SSR el módulo
    // views/dashboard/costos.js (renderCostosRedesign) desde costosSlice.
    //
    // El rediseño ABSORBE el contenido legacy: la antigua sección «Cuota Plan
    // Max» (sólo Anthropic) la reemplazan las 5 tarjetas de cuota por proveedor
    // (CA-2); la herramienta de calibración de Claude se preserva DENTRO del
    // rediseño con los mismos IDs (calib-*), por lo que el script de abajo
    // (tickQuota) la sigue cableando por getElementById sin cambios. Los IDs
    // legacy que ya no existen (quota-grid/costos-grid/costos-detail) están
    // guardados con `if(el)` en el script → no rompen.
    const redesignHtml = (opts && typeof opts.redesignHtml === 'string') ? opts.redesignHtml : '';
    const body = redesignHtml || `<section class="in-section"><div class="in-empty">Pantalla de Costos no disponible (módulo de render no cargó). Reintentá el refresh.</div></section>`;
    const css = `
.kp-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 14px; }
.kp-tile { background: var(--in-bg-3); padding: 18px; border-radius: var(--in-radius); border: 1px solid var(--in-border); display: flex; flex-direction: column; gap: 6px; }
.kp-tile-label { font-size: 11px; text-transform: uppercase; color: var(--in-fg-dim); letter-spacing: 0.6px; }
.kp-tile-value { font-size: 30px; font-weight: 700; font-variant-numeric: tabular-nums; }
.kp-tile-sub { font-size: 11px; color: var(--in-fg-dim); }
.kp-pre { background: var(--in-bg-3); padding: 14px; border-radius: var(--in-radius-sm); font-family: var(--in-mono); font-size: 11px; overflow: auto; max-height: 500px; border: 1px solid var(--in-border); }
.quota-bar { height: 14px; border-radius: 7px; background: var(--in-bg-3); overflow: hidden; border: 1px solid var(--in-border); position: relative; }
.quota-bar > span { display: block; height: 100%; transition: width 0.5s ease; background: var(--in-ok); }
.quota-bar.warn > span { background: var(--in-warn); }
.quota-bar.bad > span { background: var(--in-bad); }
.quota-bar-label { font-size: 11px; color: var(--in-fg-dim); margin-top: 6px; display: flex; justify-content: space-between; }
.kp-tile.kp-warn .kp-tile-value { color: var(--in-warn); }
.kp-tile.kp-bad .kp-tile-value { color: var(--in-bad); }
.kp-tile.kp-ok .kp-tile-value { color: var(--in-ok); }`;
    const script = `
async function tickQuota(){
    const d = await fetchJson('/api/dash/quota');
    const grid = document.getElementById('quota-grid');
    const barWrap = document.getElementById('quota-bar-wrap');
    const meta = document.getElementById('quota-meta');
    if(!d || d.error){
        if(grid) grid.innerHTML = '<div class="in-empty">Sin datos de cuota: '+(d && d.error || 'activity-log vacío')+'</div>';
        return;
    }
    const sess = d.session || { hoursUsed: 0, pct: 0, realPct: null, hoursRemaining: 5, status: 'ok', realStatus: 'ok' };
    const sessShownPct = sess.realPct != null ? sess.realPct : sess.pct;
    const sessShownStatus = sess.realPct != null ? sess.realStatus : sess.status;
    const sessCls = sessShownStatus==='critical'?'kp-bad':sessShownStatus==='warning'?'kp-warn':sessShownStatus==='normal'?'':'kp-ok';
    const weekShownPct = d.realPct != null ? d.realPct : d.pct;
    const weekShownStatus = d.realPct != null ? d.realStatus : d.status;
    const weekCls = weekShownStatus==='critical'?'kp-bad':weekShownStatus==='warning'?'kp-warn':weekShownStatus==='normal'?'':'kp-ok';
    const resetTxt = d.daysToReset != null ? 'Reset en '+d.daysToReset.toFixed(1)+' días' : '';
    const sessLabel = sess.realPct != null ? 'Sesión 5h · estimado real' : 'Sesión actual · 5h';
    const sessCap = sess.realPctCapped ? ' ⚠ recalibrar' : '';
    const sessRawTxt = sess.realPctRaw != null && sess.realPctCapped
        ? ' (raw '+sess.realPctRaw.toFixed(1)+'%)'
        : '';
    const sessSub = sess.realPct != null
        ? 'pipeline '+sess.pct.toFixed(1)+'% × '+(d.calibration && d.calibration.session_factor ? d.calibration.session_factor : 1)+sessRawTxt+sessCap
        : sess.hoursUsed.toFixed(2)+'h / 5h';
    const weekLabel = d.realPct != null ? 'Semanal · estimado real' : 'Semanal · cuota';
    const weekCap = d.realPctCapped ? ' ⚠ recalibrar' : '';
    const weekRawTxt = d.realPctRaw != null && d.realPctCapped
        ? ' (raw '+d.realPctRaw.toFixed(1)+'%)'
        : '';
    const weekSub = d.realPct != null
        ? 'pipeline '+d.pct.toFixed(1)+'% × '+(d.calibration && d.calibration.weekly_factor ? d.calibration.weekly_factor : 1)+weekRawTxt+weekCap
        : 'de '+d.effectiveLimitHours+'h estimadas';
    const tiles = [
        { label: sessLabel, value: sessShownPct.toFixed(1)+'%', sub: sessSub, cls: sessCls },
        { label: 'Sesión · restante (pipeline)', value: sess.hoursRemaining.toFixed(2)+'h', sub: 'reset rolling 5h', cls: '' },
        { label: 'Semanal · pipeline usado', value: d.hoursUsed7d.toFixed(1)+'h', sub: d.sessionsCount7d+' sesiones desde dom 21h', cls: '' },
        { label: weekLabel, value: weekShownPct.toFixed(1)+'%', sub: weekSub, cls: weekCls },
        { label: 'Horas restantes (pipeline)', value: d.hoursRemaining+'h', sub: resetTxt, cls: '' },
        { label: 'Burn rate (pipeline)', value: d.burnRatePerDay+'h/d', sub: 'últimas 24h o promedio semana', cls: '' },
        { label: 'Días al límite', value: d.daysToLimit != null ? d.daysToLimit.toFixed(1)+'d' : '∞', sub: 'al ritmo actual', cls: d.daysToLimit != null && d.daysToLimit < 1 ? 'kp-bad' : d.daysToLimit != null && d.daysToLimit < 2 ? 'kp-warn' : '' },
        { label: 'Auto-ajustes', value: d.adjustmentsCount, sub: 'observed: '+d.observedMaxHours+'h', cls: '' },
    ];
    let html = '';
    for(const t of tiles) html += '<div class="kp-tile '+t.cls+'"><div class="kp-tile-label">'+escapeHtml(t.label)+'</div><div class="kp-tile-value">'+escapeHtml(String(t.value))+'</div><div class="kp-tile-sub">'+escapeHtml(t.sub)+'</div></div>';
    if(grid && grid.innerHTML !== html) grid.innerHTML = html;
    if(barWrap){
        const barCls = d.status==='critical'?'bad':d.status==='warning'?'warn':'';
        const barHtml = '<div class="quota-bar '+barCls+'"><span style="width:'+Math.min(100,d.pct).toFixed(1)+'%"></span></div><div class="quota-bar-label"><span>'+d.hoursUsed7d.toFixed(1)+'h consumidas</span><span>'+d.effectiveLimitHours+'h estimadas</span></div>';
        if(barWrap.innerHTML !== barHtml) barWrap.innerHTML = barHtml;
    }
    // fmtART al scope de la función (no dentro de if(meta)) porque también
    // lo usa el bloque de calibración debajo. Antes estaba scoped al if(meta)
    // y rompía con ReferenceError → el binding del botón nunca se ejecutaba.
    const fmtART = (iso) => new Date(iso).toLocaleString('es-AR', { hour12: false, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    if(meta){
        const lines = [];
        if(d.lastResetAt && d.nextResetAt){
            lines.push('🗓 Semana actual: ' + fmtART(d.lastResetAt) + ' → ' + fmtART(d.nextResetAt));
        }
        if(d.adjustmentsCount > 0) lines.push('🔧 Límite auto-ajustado '+d.adjustmentsCount+' vez/veces (config: '+d.configLimitHours+'h → actual: '+d.effectiveLimitHours+'h)');
        if(d.daysToLimit != null && d.daysToLimit < 2) lines.push('⚠ Llegás al límite en ~'+d.daysToLimit.toFixed(1)+' días al ritmo actual');
        else if(d.daysToLimit == null || d.daysToLimit > (d.daysToReset || 7)) lines.push('✓ Cuota dura hasta el próximo reset al ritmo actual');
        if(d.observedMaxAt) lines.push('Pico observado en la semana: '+d.observedMaxHours+'h (' + fmtART(d.observedMaxAt) + ')');
        const txt = lines.join(' · ');
        if(meta.textContent !== txt) meta.textContent = txt;
    }
    // Renderizar status de calibración + bind del botón (idempotente).
    const calibStatus = document.getElementById('calib-status');
    if(calibStatus){
        let ctxt;
        if(d.calibration){
            const at = fmtART(d.calibration.at);
            const stale = d.calibrationStale ? ' ⚠ ' : ' ✓ ';
            const ageInfo = d.calibrationAgeDays != null ? ' (hace '+d.calibrationAgeDays+'d)' : '';
            ctxt = stale+'Calibrado #'+d.calibration.sample_count+' · '+at+ageInfo+' · factor smooth(w=×'+d.calibration.weekly_factor+', s=×'+d.calibration.session_factor+') raw esta vez(w=×'+d.calibration.weekly_factor_obs+', s=×'+d.calibration.session_factor_obs+') · α EMA '+d.calibration.ema_alpha;
            if(d.calibrationStale) ctxt += ' — recomendado recalibrar';
            if(d.weeklyResetDriftMin) ctxt += ' · drift TZ del reset semanal: '+d.weeklyResetDriftMin+' min';
        } else {
            ctxt = 'Sin calibrar. Pegá los % que ves en claude.ai/settings/usage para extrapolar el real.';
        }
        if(calibStatus.textContent !== ctxt) calibStatus.textContent = ctxt;
    }

    // Historial de calibraciones (tabla compacta)
    const calibHist = document.getElementById('calib-history');
    if(calibHist){
        const arr = (d.calibrations || []).slice().reverse();
        if(arr.length === 0){
            calibHist.innerHTML = '';
        } else {
            const rows = arr.slice(0, 10).map(c => '<tr>'+
                '<td style="padding:4px 8px">'+fmtART(c.at)+'</td>'+
                '<td style="padding:4px 8px;text-align:right">'+c.real_weekly_pct+'%</td>'+
                '<td style="padding:4px 8px;text-align:right">'+c.real_session_pct+'%</td>'+
                '<td style="padding:4px 8px;text-align:right;color:var(--in-fg-dim)">'+c.pipeline_weekly_pct_at.toFixed(1)+'%</td>'+
                '<td style="padding:4px 8px;text-align:right;color:var(--in-fg-dim)">'+c.pipeline_session_pct_at.toFixed(1)+'%</td>'+
                '<td style="padding:4px 8px;text-align:right">×'+c.weekly_factor_obs+'</td>'+
                '<td style="padding:4px 8px;text-align:right">×'+c.session_factor_obs+'</td>'+
                '</tr>').join('');
            const html = '<details style="margin-top:6px"><summary style="cursor:pointer;font-size:11px;color:var(--in-fg-dim);user-select:none">📜 Historial de '+arr.length+' calibración'+(arr.length===1?'':'es')+'</summary>'+
                '<table style="width:100%;font-size:11px;font-family:var(--in-mono);margin-top:8px;border-collapse:collapse"><thead><tr style="color:var(--in-fg-dim);border-bottom:1px solid var(--in-border)">'+
                '<th style="padding:4px 8px;text-align:left">Fecha</th>'+
                '<th style="padding:4px 8px;text-align:right">Sem real</th>'+
                '<th style="padding:4px 8px;text-align:right">Ses real</th>'+
                '<th style="padding:4px 8px;text-align:right">Sem pipe</th>'+
                '<th style="padding:4px 8px;text-align:right">Ses pipe</th>'+
                '<th style="padding:4px 8px;text-align:right">×Sem</th>'+
                '<th style="padding:4px 8px;text-align:right">×Ses</th>'+
                '</tr></thead><tbody>'+rows+'</tbody></table></details>';
            if(calibHist.innerHTML !== html) calibHist.innerHTML = html;
        }
    }

    // Bind del botón Aplicar
    const calibBtn = document.getElementById('calib-save');
    if(calibBtn && !calibBtn.dataset._bound){
        calibBtn.dataset._bound = '1';
        calibBtn.addEventListener('click', async () => {
            const w = parseFloat(document.getElementById('calib-weekly').value);
            const s = parseFloat(document.getElementById('calib-session').value);
            const sAtRaw = document.getElementById('calib-session-at').value;
            const wAtRaw = document.getElementById('calib-weekly-at').value;
            // datetime-local NO incluye TZ — el browser lo interpreta como local.
            // new Date('2026-04-27T22:00') usa TZ del browser, que para el
            // operador es ART (lo que queremos). Convertimos a ISO UTC.
            const sAt = sAtRaw ? new Date(sAtRaw).toISOString() : null;
            const wAt = wAtRaw ? new Date(wAtRaw).toISOString() : null;
            if(!Number.isFinite(w) || !Number.isFinite(s)){
                showToast('Ingresá ambos % (semanal y sesión)', false);
                return;
            }
            try{
                const body = { real_weekly_pct: w, real_session_pct: s };
                if(sAt) body.session_resets_at = sAt;
                if(wAt) body.weekly_resets_at = wAt;
                const r = await fetch('/api/dash/quota/calibrate', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body)});
                const j = await r.json();
                showToast(j.msg || (j.ok?'Calibrado':'Falló'), j.ok);
                if(j.ok){
                    document.getElementById('calib-weekly').value = '';
                    document.getElementById('calib-session').value = '';
                    document.getElementById('calib-session-at').value = '';
                    document.getElementById('calib-weekly-at').value = '';
                }
                setTimeout(() => tickQuota().catch(()=>{}), 400);
            } catch(e){ showToast('Error: '+e.message, false); }
        });
    }

    // Bind del botón Borrar
    const calibClear = document.getElementById('calib-clear');
    if(calibClear && !calibClear.dataset._bound){
        calibClear.dataset._bound = '1';
        calibClear.addEventListener('click', async () => {
            if(!(await inConfirm({ title:'Borrar calibración', message:'El KPI vuelve a mostrar el pipeline raw. El historial de calibraciones previas se conserva.', confirmLabel:'Borrar' }))) return;
            try{
                const r = await fetch('/api/dash/quota/calibrate', {method:'DELETE', headers: nhCsrfHeaders()});
                const j = await r.json();
                showToast(j.msg || (j.ok?'Borrada':'Falló'), j.ok);
                setTimeout(() => tickQuota().catch(()=>{}), 400);
            } catch(e){ showToast('Error: '+e.message, false); }
        });
    }
}

async function tickCostos(){
    // Endpoint correcto (#2801): /metrics/snapshot?window=24h, no /api/metrics.
    // El snapshot del aggregator V3 usa snake_case (tokens_in, tokens_out,
    // cache_read, cache_write, cost_usd, sessions) — NO camelCase.
    const snap = await fetchJson('/metrics/snapshot?window=24h');
    const grid = document.getElementById('costos-grid');
    const detail = document.getElementById('costos-detail');
    if(!snap || !snap.totals){
        if(grid) grid.innerHTML = '<div class="in-empty">Aggregator V3 sin datos. Esperá a que termine algún agente Claude (los determinísticos no contabilizan tokens).</div>';
        if(detail) detail.textContent = '—';
        return;
    }
    const t = snap.totals;
    const totalTokens = (t.tokens_in || 0) + (t.tokens_out || 0) + (t.cache_read || 0) + (t.cache_write || 0);
    const tiles = [
        { label: 'Costo USD', value: '$'+(t.cost_usd||0).toFixed(2), sub: snap.window || 'all' },
        { label: 'Sesiones', value: fmtNum(t.sessions || 0), sub: 'agentes terminados' },
        { label: 'Tokens · total', value: fmtNum(totalTokens), sub: 'in + out + cache' },
        { label: 'Tokens · output', value: fmtNum(t.tokens_out || 0), sub: 'generados por LLM' },
        { label: 'Cache · read', value: fmtNum(t.cache_read || 0), sub: 'reutilizado' },
        { label: 'Cache · write', value: fmtNum(t.cache_write || 0), sub: 'creado' },
    ];
    let html = '';
    for(const ti of tiles) html += '<div class="kp-tile"><div class="kp-tile-label">'+escapeHtml(ti.label)+'</div><div class="kp-tile-value">'+escapeHtml(ti.value)+'</div><div class="kp-tile-sub">'+escapeHtml(ti.sub||'')+'</div></div>';
    if(grid && grid.innerHTML !== html) grid.innerHTML = html;
    if(detail){
        // Tabla compacta por skill — más legible que JSON crudo.
        const agents = snap.agents || [];
        if(agents.length === 0){
            if(detail.textContent !== '— sin agentes en la ventana —') detail.textContent = '— sin agentes en la ventana —';
        } else {
            const lines = ['skill          sessions    tokens_total       cost_usd  duration  tool_calls', '─'.repeat(82)];
            for(const a of agents){
                const tot = (a.tokens_in||0) + (a.tokens_out||0) + (a.cache_read||0) + (a.cache_write||0);
                lines.push(
                    (a.skill||'?').padEnd(15) +
                    String(a.sessions||0).padStart(8) +
                    fmtNum(tot).padStart(16) +
                    ('$'+(a.cost_usd||0).toFixed(2)).padStart(14) +
                    fmtDur(a.duration_ms||0).padStart(10) +
                    String(a.tool_calls||0).padStart(12)
                );
            }
            const txt = lines.join('\\n');
            if(detail.textContent !== txt) detail.textContent = txt;
        }
    }
}
const POLLS = [{ fn: tickHeader, ms: 5000 }, { fn: tickQuota, ms: 60000 }, { fn: tickCostos, ms: 60000 }];
async function runAll(){ for(const p of POLLS){ try{ await p.fn(); } catch{} } }
runAll();
for(const p of POLLS){ setInterval(() => { p.fn().catch(()=>{}); }, p.ms); }`;
    // #4239 — Marco común MIZPÁ en COSTOS (de #4234): ① cabecera de marca
    // (renderBrandBar), ② banner de ola común (renderMissionBanner(collectWave()),
    // SSR-poblado igual que LOGS), ③ barra de accesos (renderNavTabsSsr('costos'),
    // ya inyectada por pageShell vía el slot de nav). El contenido propio de COSTOS
    // (`#costos-redesign`, incluido su banner de alarma de presupuesto) queda
    // debajo del marco, sin tocarlo (CA-4). Reusa los helpers/CSS compartidos del
    // marco (CA-5: no se duplica markup; el CSS `mz-*` ya vive en theme.css). Si el
    // módulo del marco no cargó, `brandHtml`/`missionHtml` quedan vacíos y pageShell
    // cae a su cabecera legacy (defensa en profundidad — el pipeline no puede morir).
    const brandHtml = (mizpaFrame && typeof mizpaFrame.renderBrandBar === 'function')
        ? mizpaFrame.renderBrandBar()
        : undefined;
    const missionHtml = (mizpaFrame && typeof mizpaFrame.renderMissionBanner === 'function')
        ? mizpaFrame.renderMissionBanner(mizpaFrame.collectWave())
        : '';
    return pageShell('Costos', 'Consumo diario por proveedor · presupuesto y cuota de los 5 proveedores', body, script, css, 'costos', {
        brandHtml,
        missionHtml,
    });
}

// ─────────────────── Modo descanso (#3230 / hija frontend #3242) ───────────────────
// Rediseño completo: grid semanal de 7 columnas con N periodos por día, basado en
// los mockups `agent/3230-ux-rest-mode-redesign` (05-rest-mode-settings.svg y
// 05b-rest-mode-validacion.svg). Reemplaza al form single-window del PR-A (#2890).
//
// El render del grid usa `document.createElement` + `.textContent` para todos los
// campos provenientes del servidor (FE-SEC-1 / PO-FE-SEC-1 / CA-XSS).
//
// La validación cliente de overlap espeja la lógica del helper compartido
// `lib/rest-mode-schedule.js` (que vive en este mismo PR) — el backend de la hija
// #3241 va a usar ese mismo helper como source of truth. El cliente NUNCA confía
// en su propia validación: siempre hace el round-trip a `POST /api/rest-mode`.
// nota: solo UX, backend revalida en POST /api/rest-mode (FE-SEC-2 / SEC-9).
// #3736 — Cuerpo extraído a views/dashboard/descanso.js (padre #3715). Se
// mantiene este delegante de una línea para compat con HTML_ROUTES legacy
// y cualquier caller que aún importe sat.renderModoDescanso.
function renderModoDescanso() {
    return require('./descanso').renderDescanso();
}

module.exports = {
    renderEquipo,
    renderPipeline,
    renderBloqueados,
    renderIssues,
    // #3731 — renderMatriz extraído a views/dashboard/matriz.js (split del épico #3715).
    // #3732 — renderOps extraído a views/dashboard/ops.js (split del épico #3715).
    renderKpisDetail,
    renderHistorial,
    renderCostos,
    renderModoDescanso,
};
