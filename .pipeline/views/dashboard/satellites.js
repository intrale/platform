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
const { CONFIRM_MODAL_JS } = require('./confirm-modal.js');

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
function pageShell(title, subtitle, bodyHtml, scripts, extraCss = '', activeSlug = '') {
    const theme = loadTheme();
    const spriteInline = loadIconSprite();
    const navHtml = renderNavTabsSsr(activeSlug);
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
    <div class="in-header-brand">
      <div class="in-header-logo">i</div>
      <div>
        <div class="in-header-title">${title}</div>
        <div class="in-header-subtitle">${subtitle}</div>
      </div>
    </div>
    <div class="in-header-meta">
      <span class="in-pill" id="hdr-mode">…</span>
      <span class="in-clock" id="hdr-clock">…</span>
    </div>
  </header>
  ${navHtml}
  <main class="satellite-body">${bodyHtml}</main>
  <footer class="in-footer">
    <span>Refresh independiente · sin flicker</span>
    <span>Intrale V3</span>
  </footer>
</div>
<script>${FETCH_CLIENT_JS}\n${CONFIRM_MODAL_JS}\n${commonHelpers()}\n${scripts}</script>
</body>
</html>`;
}

// ─────────────────── Equipo ───────────────────
function renderEquipo() {
    // #3955 EP8-H2 — Acordeón por skill con agentes individuales. El detalle por
    // agente (issue/fase/progreso/duración/log + kill) sale de /api/dash/active;
    // la carga y el sparkline 24h de /api/dash/equipo. Construcción 100% por DOM
    // (textContent/setAttribute) → XSS-safe por construcción (SEC-5). El kill por
    // agente reusa killAgent() (token CSRF, SEC-2). Commander = no cancelable
    // (CA-3); cooldown = cuenta regresiva server-authoritative (CA-4/SEC-6).
    const body = `
<section class="in-section">
  <h2 class="in-section-title"><span class="in-section-title-icon">👥</span>Equipo · acordeón por skill</h2>
  <div id="equipo-accordion" class="eq-accordion"><div class="eq-acc-empty">Cargando agentes…</div></div>
</section>`;
    const css = `
.eq-accordion { display: flex; flex-direction: column; gap: 10px; }
.eq-acc-empty { color: var(--in-fg-dim); font-size: 13px; padding: 18px; text-align: center; }
.eq-acc-card { background: var(--in-bg-3); border: 1px solid var(--in-border); border-radius: var(--in-radius-sm); overflow: hidden; }
.eq-acc-card.eq-acc-card-obs { border-color: #a371f7; border-left: 3px solid #a371f7; }
.eq-acc-card.eq-acc-card-cooldown { border-left: 3px solid #f5b454; }
.eq-acc-head { display: flex; align-items: center; gap: 10px; padding: 11px 14px; cursor: pointer; user-select: none; }
.eq-acc-head:hover { background: var(--in-bg); }
.eq-acc-chevron { font-size: 11px; color: var(--in-fg-dim); transition: transform 0.2s; width: 12px; }
.eq-acc-card.collapsed .eq-acc-chevron { transform: rotate(-90deg); }
.eq-acc-card.collapsed .eq-acc-body { display: none; }
.eq-acc-avatar { width: 28px; height: 28px; border-radius: 8px; display: flex; align-items: center; justify-content: center; color: #fff; font-size: 15px; flex: 0 0 auto; }
.eq-acc-name { font-weight: 600; font-size: 13px; }
.eq-acc-count { font-size: 11px; color: var(--in-fg-dim); font-variant-numeric: tabular-nums; }
.eq-acc-obs-badge { font-size: 11px; color: #c9b6ff; }
.eq-acc-spark { display: inline-flex; align-items: flex-end; gap: 1px; height: 20px; margin-left: auto; }
.eq-acc-spark .bar { width: 3px; background: #1f6feb; border-radius: 1px; min-height: 1px; }
.eq-acc-spark .bar.recent { background: #58a6ff; }
.eq-acc-body { display: flex; flex-direction: column; border-top: 1px solid var(--in-border); }
.eq-ag-row { display: flex; flex-direction: column; gap: 5px; padding: 9px 14px 9px 34px; border-bottom: 1px solid var(--in-border); }
.eq-ag-row:last-child { border-bottom: none; }
.eq-ag-row.cooldown { background: rgba(245,180,84,0.06); }
.eq-ag-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.eq-ag-issue { color: #58a6ff; font-weight: 700; font-size: 12px; }
.eq-ag-issue.obs { color: #c9b6ff; }
.eq-ag-fase { font-size: 10px; padding: 1px 7px; border-radius: 9px; background: var(--in-bg); color: var(--in-fg-dim); border: 1px solid var(--in-border); }
.eq-ag-title { font-size: 12px; color: var(--in-fg-dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 320px; }
.eq-ag-meta { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.eq-ag-bar { flex: 0 0 90px; height: 6px; border-radius: 3px; background: var(--in-bg); overflow: hidden; }
.eq-ag-bar > span { display: block; height: 100%; background: #58a6ff; transition: width 0.4s; }
.eq-ag-bar.indeterminate > span { width: 30%; animation: eqIndet 1.2s ease-in-out infinite; }
@keyframes eqIndet { 0%{margin-left:-30%} 100%{margin-left:100%} }
.eq-ag-pct { font-size: 11px; color: #79c0ff; font-variant-numeric: tabular-nums; min-width: 30px; }
.eq-ag-dur { font-size: 11px; color: var(--in-fg-dim); font-variant-numeric: tabular-nums; }
.eq-ag-log { font-size: 11px; color: #2dd4bf; text-decoration: none; }
.eq-ag-log:hover { text-decoration: underline; }
.eq-ag-kill { margin-left: auto; background: transparent; border: 1px solid var(--in-bad); color: var(--in-bad); border-radius: 6px; padding: 3px 10px; font-size: 11px; cursor: pointer; }
.eq-ag-kill:hover { background: var(--in-bad-soft); }
.eq-ag-protected { margin-left: auto; font-size: 11px; color: #c9b6ff; border: 1px solid #a371f7; border-radius: 6px; padding: 3px 10px; }
.eq-ag-cooldown { font-size: 11px; color: #f5b454; }
.eq-ag-wait { margin-left: auto; font-size: 11px; color: var(--in-fg-dim); border: 1px solid var(--in-border); border-radius: 6px; padding: 3px 10px; opacity: 0.7; }`;
    const script = `
// Estado client de la vista Equipo (acordeón). _activeAgents y _equipoSkills se
// refrescan por polling; buildAccordion() re-renderiza el DOM in-place.
let _activeAgents = [];
let _equipoSkills = {};

// Agrupar agentes vivos por skill, preservando orden de llegada (el server ya
// ordena por duración desc + commander al frente).
function groupAgentsBySkill(agents){
    const order = [];
    const map = {};
    for(const a of (agents||[])){
        const s = a.skill || '';
        if(!map[s]){ map[s] = []; order.push(s); }
        map[s].push(a);
    }
    return { order, map };
}

// Progreso %: min(100, dur/eta*100); sin eta → indeterminado (nunca NaN).
function agentProgress(durationMs, etaMs){
    if(!etaMs || etaMs <= 0) return { pct: 0, indeterminate: true };
    return { pct: Math.min(100, Math.round((durationMs/etaMs)*100)), indeterminate: false };
}

// Sparkline 24h: 24 barras normalizadas; últimas 6 horas resaltadas.
function buildSparkline(buckets){
    const wrap = document.createElement('span');
    wrap.className = 'eq-acc-spark';
    const arr = Array.isArray(buckets) ? buckets : [];
    const max = arr.reduce((a,b)=>Math.max(a,b||0),0);
    let total = 0;
    for(let i=0;i<arr.length;i++){
        const v = arr[i]||0; total += v;
        const bar = document.createElement('span');
        bar.className = 'bar' + (i >= arr.length-6 ? ' recent' : '');
        bar.style.height = (max>0 ? Math.max(8, Math.round((v/max)*100)) : 4) + '%';
        const hoursAgo = arr.length-1-i;
        bar.title = v + ' marker' + (v===1?'':'s') + ' · hace ' + hoursAgo + 'h';
        wrap.appendChild(bar);
    }
    wrap.setAttribute('aria-label', 'Carga ultimas 24 horas: ' + total + ' markers');
    return wrap;
}

// Fila de un agente (DOM seguro: textContent / setAttribute).
function buildAgentRow(a){
    const row = document.createElement('div');
    const observational = a.observational === true || a.cancelable === false;
    const cooldown = a.cooldown || null;
    row.className = 'eq-ag-row' + (cooldown ? ' cooldown' : '');

    const head = document.createElement('div'); head.className = 'eq-ag-head';
    const issue = document.createElement('span');
    issue.className = 'eq-ag-issue' + (observational ? ' obs' : '');
    issue.textContent = observational ? (a.title || 'Commander') : ('#' + a.issue);
    head.appendChild(issue);
    const fase = document.createElement('span'); fase.className = 'eq-ag-fase';
    fase.textContent = a.fase || ''; head.appendChild(fase);
    if(!observational && a.title){
        const title = document.createElement('span'); title.className = 'eq-ag-title';
        title.textContent = a.title; title.title = a.title; head.appendChild(title);
    }
    row.appendChild(head);

    const meta = document.createElement('div'); meta.className = 'eq-ag-meta';
    const prog = agentProgress(a.durationMs||0, a.etaMs);
    const bar = document.createElement('span'); bar.className = 'eq-ag-bar' + (prog.indeterminate ? ' indeterminate' : '');
    const barFill = document.createElement('span');
    if(!prog.indeterminate) barFill.style.width = prog.pct + '%';
    bar.appendChild(barFill); meta.appendChild(bar);
    const pct = document.createElement('span'); pct.className = 'eq-ag-pct';
    pct.textContent = prog.indeterminate ? '—' : (prog.pct + '%'); meta.appendChild(pct);
    const dur = document.createElement('span'); dur.className = 'eq-ag-dur';
    dur.textContent = '⏱ ' + fmtDur(a.durationMs||0); meta.appendChild(dur);
    if(!observational && a.hasLog && a.logFile){
        const log = document.createElement('a'); log.className = 'eq-ag-log';
        log.href = '/logs/view/' + encodeURIComponent(a.logFile) + '?live=1';
        log.target = '_blank'; log.rel = 'noopener noreferrer';
        log.textContent = '📄 log'; meta.appendChild(log);
    }

    if(observational){
        const prot = document.createElement('span'); prot.className = 'eq-ag-protected';
        prot.textContent = '🔒 protegido'; prot.title = 'Skill no cancelable — presencia observacional';
        meta.appendChild(prot);
    } else if(cooldown){
        const cd = document.createElement('span'); cd.className = 'eq-ag-cooldown';
        cd.setAttribute('data-cooldown-until', cooldown.cooldownUntil || '');
        cd.textContent = '⏳ cooldown · ' + (cooldown.failures||0) + ' fallos';
        meta.appendChild(cd);
        const wait = document.createElement('span'); wait.className = 'eq-ag-wait';
        wait.textContent = 'en espera'; wait.setAttribute('aria-disabled','true');
        meta.appendChild(wait);
    } else {
        const kill = document.createElement('button'); kill.className = 'eq-ag-kill';
        kill.textContent = '✕ cancelar'; kill.title = 'Cancelar este agente';
        kill.addEventListener('click', () => killAgent(a.issue, a.skill, a.pipeline, a.fase, a.durationMs));
        meta.appendChild(kill);
    }
    row.appendChild(meta);
    return row;
}

// Estado de colapso persistido en sessionStorage (patrón del dashboard).
function accCollapsed(skill){ try { return sessionStorage.getItem('eqacc:'+skill) === '1'; } catch(e){ return false; } }
function accToggle(skill, card){
    const now = card.classList.toggle('collapsed');
    try { sessionStorage.setItem('eqacc:'+skill, now ? '1' : '0'); } catch(e){}
}

function buildAccordion(){
    const cont = document.getElementById('equipo-accordion');
    if(!cont) return;
    const { order, map } = groupAgentsBySkill(_activeAgents);
    if(order.length === 0){
        cont.innerHTML = '<div class="eq-acc-empty">Sin agentes vivos</div>';
        return;
    }
    cont.innerHTML = '';
    for(const skill of order){
        const list = map[skill];
        const isObs = list.some(a => a.observational === true || a.cancelable === false);
        const hasCooldown = list.some(a => a.cooldown);
        const card = document.createElement('div');
        card.className = 'eq-acc-card' + (isObs ? ' eq-acc-card-obs' : '') + (hasCooldown ? ' eq-acc-card-cooldown' : '');
        card.dataset.skill = skill;
        if(accCollapsed(skill)) card.classList.add('collapsed');

        const head = document.createElement('div'); head.className = 'eq-acc-head';
        const chev = document.createElement('span'); chev.className = 'eq-acc-chevron'; chev.textContent = '▼'; head.appendChild(chev);
        const av = document.createElement('span'); av.className = 'eq-acc-avatar';
        av.style.background = SKILL_COLORS[skill] || '#8b949e'; av.textContent = SKILL_ICONS[skill] || '⚙'; head.appendChild(av);
        const name = document.createElement('span'); name.className = 'eq-acc-name'; name.textContent = skill; head.appendChild(name);
        const cnt = document.createElement('span'); cnt.className = 'eq-acc-count'; cnt.textContent = list.length + ' vivo' + (list.length===1?'':'s'); head.appendChild(cnt);
        if(isObs){ const b = document.createElement('span'); b.className = 'eq-acc-obs-badge'; b.textContent = '🔒 no cancelable'; head.appendChild(b); }
        const sk = _equipoSkills[skill];
        head.appendChild(buildSparkline(sk && sk.spark24h));
        head.addEventListener('click', () => accToggle(skill, card));
        card.appendChild(head);

        const bodyEl = document.createElement('div'); bodyEl.className = 'eq-acc-body';
        for(const a of list) bodyEl.appendChild(buildAgentRow(a));
        card.appendChild(bodyEl);
        cont.appendChild(card);
    }
}

// Cuenta regresiva de cooldown (CA-4): el front SOLO pinta; no habilita acciones
// (eso lo dicta el server vía /api/dash/active en el próximo poll, SEC-6).
function tickCooldownCountdowns(){
    const now = Date.now();
    document.querySelectorAll('.eq-ag-cooldown[data-cooldown-until]').forEach(el => {
        const until = Date.parse(el.getAttribute('data-cooldown-until'));
        if(!until || isNaN(until)) return;
        const leftMs = until - now;
        const base = el.textContent.split(' · ')[1] || '';
        if(leftMs <= 0){ el.textContent = '⏳ por expirar · ' + base; return; }
        const s = Math.floor(leftMs/1000), mm = Math.floor(s/60), ss = s%60;
        el.textContent = '⏳ cooldown ' + mm + ':' + (ss<10?'0':'') + ss + ' · ' + base;
    });
}

async function refreshActiveAgents(){
    const d = await fetchJson('/api/dash/active');
    if(d) _activeAgents = d.agents || [];
}

async function tickEquipo(){
    await refreshActiveAgents();
    const d = await fetchJson('/api/dash/equipo');
    if(d){ _equipoSkills = {}; for(const sk of (d.skills||[])) _equipoSkills[sk.skill] = sk; }
    buildAccordion();
}
const POLLS = [{ fn: tickHeader, ms: 5000 }, { fn: tickEquipo, ms: 5000 }];
async function runAll(){ for(const p of POLLS){ try{ await p.fn(); } catch{} } }
runAll();
for(const p of POLLS){ setInterval(() => { p.fn().catch(()=>{}); }, p.ms); }
setInterval(tickCooldownCountdowns, 1000);`;
    return pageShell('Equipo', 'Agentes vivos por skill · kill individual', body, script, css, 'equipo');
}

// ─────────────────── Pipeline ───────────────────
function renderPipeline() {
    // #3045 — Toggle de filtro "solo issues habilitados" (allowlist de la
    // pausa parcial). Markup accesible (role=switch, aria-checked, foco
    // visible). Hidden por default — refreshAllowlistToggleVisibility lo
    // muestra cuando pipelineModeState.mode === 'partial_pause'.
    const body = `
<section class="in-section">
  <div class="pl-section-head">
    <h2 class="in-section-title"><span class="in-section-title-icon">🔄</span>Pipeline · issues por fase</h2>
    <div class="pl-allowlist-toggle" id="pl-allowlist-toggle" role="switch"
         aria-checked="false" tabindex="0"
         title="Mostrar solo los issues incluidos en la pausa parcial activa"
         style="display:none">
      <span class="pl-toggle-track"><span class="pl-toggle-thumb"></span></span>
      <span class="pl-toggle-label">Solo issues habilitados</span>
    </div>
  </div>
  <div id="pipeline-board" class="pl-board"></div>
  <!-- #3905 — Franja terminal "Ola — fuera de flujo": cards de issues de la
       allowlist sin fase actual (no-ingreso) o cerrados (finalizado). Vive
       FUERA del board flex para quedar debajo de las columnas, no como una
       columna más (decisión de producto: franja, no pseudo-columnas). -->
  <div id="pipeline-wave-band"></div>
</section>`;
    const css = `
/* #3045 — Header de la sección con título a la izquierda y toggle a la derecha. */
.pl-section-head { display: flex; align-items: center; gap: 12px; margin-bottom: 12px; }
.pl-section-head .in-section-title { margin: 0; }
.pl-allowlist-toggle {
    margin-left: auto;
    display: inline-flex;
    align-items: center;
    gap: 8px;
    font-size: 11px;
    color: var(--in-fg-dim);
    cursor: pointer;
    user-select: none;
    border-radius: 999px;
    padding: 4px 8px;
    transition: color 0.15s, background 0.15s;
}
.pl-allowlist-toggle:hover { color: var(--in-fg); background: var(--in-bg-3); }
.pl-allowlist-toggle:focus-visible { outline: 2px solid var(--in-accent); outline-offset: 2px; }
.pl-allowlist-toggle[aria-checked="true"] { color: var(--in-ok); }
.pl-allowlist-toggle .pl-toggle-track {
    width: 28px; height: 14px;
    background: var(--in-bg-3);
    border: 1px solid var(--in-border);
    border-radius: 999px;
    position: relative;
    transition: background 0.15s, border-color 0.15s;
    flex: 0 0 28px;
}
.pl-allowlist-toggle[aria-checked="true"] .pl-toggle-track {
    background: var(--in-ok-soft);
    border-color: var(--in-ok);
}
.pl-allowlist-toggle .pl-toggle-thumb {
    position: absolute; top: 1px; left: 1px;
    width: 10px; height: 10px;
    background: var(--in-fg-soft);
    border-radius: 50%;
    transition: left 0.15s, background 0.15s;
}
.pl-allowlist-toggle[aria-checked="true"] .pl-toggle-thumb {
    left: 15px;
    background: var(--in-ok);
}
.pl-board { display: flex; gap: 10px; overflow-x: auto; padding-bottom: 8px; }
.pl-col { min-width: 220px; flex: 1; background: var(--in-bg-3); border-radius: var(--in-radius-sm); padding: 10px; border: 1px solid var(--in-border); }
.pl-col-head { display: flex; align-items: center; justify-content: space-between; font-size: 11px; text-transform: uppercase; letter-spacing: 0.6px; color: var(--in-fg-dim); margin-bottom: 8px; padding-bottom: 6px; border-bottom: 1px solid var(--in-border); }
.pl-col-count { background: var(--in-bg); padding: 1px 8px; border-radius: 9px; font-size: 10px; color: var(--in-fg); }
.pl-card { background: var(--in-bg-2); border: 1px solid var(--in-border); border-radius: 6px; padding: 8px 10px; margin-bottom: 6px; font-size: 12px; transition: border-color 0.2s, background 0.2s; color: var(--in-fg); }
.pl-card:hover { border-color: var(--in-accent); background: var(--in-bg-3); }
.pl-card-head { display: flex; align-items: center; gap: 6px; margin-bottom: 4px; }
.pl-card-issue { font-weight: 600; color: var(--in-info); }
.pl-card-issue a { color: inherit; text-decoration: none; }
.pl-card-issue a:hover { text-decoration: underline; }
.pl-card-prio { color: var(--in-fg-soft); font-size: 10px; margin-left: auto; font-variant-numeric: tabular-nums; }
.pl-card-title { font-size: 11px; color: var(--in-fg-dim); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.pl-card-actions { display: flex; gap: 3px; margin-top: 6px; opacity: 0.55; transition: opacity 0.15s; }
.pl-card:hover .pl-card-actions { opacity: 1; }
.pl-card-btn { background: transparent; border: 1px solid var(--in-border); color: var(--in-fg-dim); border-radius: 3px; width: 22px; height: 20px; font-size: 10px; cursor: pointer; padding: 0; line-height: 1; transition: background 0.12s, border-color 0.12s, color 0.12s; }
.pl-card-btn:hover { background: var(--in-bg); border-color: var(--in-accent); color: var(--in-accent); }
.pl-card-btn.pause:hover { border-color: var(--in-warn); color: var(--in-warn); }
.pl-card-btn.paused { border-color: var(--in-warn); color: var(--in-warn); }
.pl-card-state-trabajando { border-color: var(--in-accent); }
.pl-card-state-listo { border-color: var(--in-ok); }
.pl-card-state-pendiente { border-color: var(--in-fg-soft); }
/* #3045 — Card "habilitada" por la pausa parcial activa. Borde verde +
   halo sutil para que se distinga a la distancia (operación en kiosko).
   Si la card está simultáneamente "trabajando" Y "allowlisted", la spec UX
   prioriza el borde de estado de flujo (trabajando, accent) — la clase
   .pl-card-state-allowlisted se aplica SOLO cuando el estado del flujo
   no es trabajando, para evitar el ruido visual de dos bordes en pugna. */
.pl-card-state-allowlisted { border-color: var(--in-ok); box-shadow: 0 0 0 1px var(--in-ok-soft); }
.pl-card-allowlist-badge {
    display: inline-block;
    font-size: 9px;
    font-weight: 600;
    color: var(--in-ok);
    background: var(--in-ok-soft);
    border: 1px solid var(--in-ok);
    border-radius: 3px;
    padding: 0 5px;
    margin-left: 4px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    line-height: 1.4;
}
.pl-card-paused-badge { display: inline-block; font-size: 9px; color: var(--in-warn); border: 1px solid var(--in-warn); border-radius: 3px; padding: 0 4px; margin-left: 4px; text-transform: uppercase; letter-spacing: 0.5px; }
.pl-card-rebote { display: inline-block; font-size: 9px; font-weight: 600; color: var(--in-bad); border: 1px solid var(--in-bad); background: var(--in-bad-soft); border-radius: 3px; padding: 0 4px; margin-top: 4px; cursor: help; }
/* #2894 — Pills de agentes esperados en la fase activa (ux spec) */
.pl-card-agents { display: flex; flex-wrap: wrap; gap: 4px; margin: 6px 0 0 0; padding-top: 6px; border-top: 1px dashed var(--in-border-soft); }
.pl-card-agent { display: inline-flex; align-items: center; gap: 3px; font-size: 10px; padding: 1px 6px; border-radius: 999px; background: var(--in-bg-3); border: 1px solid var(--in-border); cursor: pointer; transition: background 0.15s, border-color 0.15s, transform 0.15s; font-variant-numeric: tabular-nums; text-decoration: none; color: var(--in-fg); }
.pl-card-agent.no-log { cursor: default; }
.pl-card-agent:hover { border-color: var(--in-accent); background: var(--in-bg); transform: translateY(-1px); }
.pl-card-agent-icon { font-size: 11px; line-height: 1; }
.pl-card-agent-state { font-size: 10px; line-height: 1; font-weight: 600; }
.pl-card-agent.state-listo { border-color: var(--in-ok); }
.pl-card-agent.state-listo .pl-card-agent-state { color: var(--in-ok); }
.pl-card-agent.state-trabajando { border-color: var(--in-accent); animation: pl-agent-pulse 1.6s ease-in-out infinite; }
.pl-card-agent.state-trabajando .pl-card-agent-state { color: var(--in-accent); }
.pl-card-agent.state-pendiente .pl-card-agent-state { color: var(--in-fg-soft); }
.pl-card-agent.state-bloqueado { border-color: var(--in-warn); }
.pl-card-agent.state-bloqueado .pl-card-agent-state { color: var(--in-warn); }
.pl-card-agent.state-fallido { border-color: var(--in-bad); background: var(--in-bad-soft); }
.pl-card-agent.state-fallido .pl-card-agent-state { color: var(--in-bad); }
.pl-card-agent.is-blocker { box-shadow: 0 0 0 1px var(--in-warn); }
@keyframes pl-agent-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.6; } }
.pl-card-stale-badge { display: inline-flex; align-items: center; gap: 3px; font-size: 9px; font-weight: 600; color: var(--in-warn); border: 1px solid var(--in-warn); background: var(--in-warn-soft); border-radius: 3px; padding: 1px 5px; margin-top: 4px; text-transform: uppercase; letter-spacing: 0.5px; width: fit-content; }
/* #3905 — Franja terminal "Ola — fuera de flujo" (estados no-ingreso /
   finalizado). Separada del board por border-top + margin para que NO se lea
   como una columna del kanban. */
.pl-wave-band { margin-top: 16px; border-top: 1px solid var(--in-border); padding-top: 10px; }
.pl-wave-band-title { font-size: 11px; text-transform: uppercase; letter-spacing: 0.6px; color: var(--in-fg-dim); margin-bottom: 8px; }
.pl-wave-band-cards { display: flex; flex-wrap: wrap; gap: 6px; }
.pl-wave-band-cards .pl-card { min-width: 200px; flex: 0 0 auto; margin-bottom: 0; }
.pl-card-wave-state { display: inline-flex; align-items: center; gap: 4px; font-size: 10px; color: var(--in-fg-dim); margin-top: 6px; text-transform: uppercase; letter-spacing: 0.5px; }
.pl-wave-ic { width: 12px; height: 12px; fill: currentColor; flex: 0 0 12px; }
/* Diferenciación por borde + icono + microcopy (anti-info-solo-por-color).
   El texto se mantiene a opacidad/contraste plenos (WCAG AA): NO se aplica
   opacity al contenedor de la card para no degradar el ratio del título. */
.pl-card-state-no-ingreso { border-color: var(--in-fg-soft); border-style: dashed; }
.pl-card-state-no-ingreso .pl-card-wave-state { color: var(--in-fg-dim); }
.pl-card-state-finalizado { border-color: var(--in-ok-soft); background: var(--in-ok-soft); }
.pl-card-state-finalizado .pl-card-wave-state { color: var(--in-ok); }`;
    const script = `
function compareByPriority(orderMap){
    return (a, b) => {
        const trab = (b.estado==='trabajando'?1:0) - (a.estado==='trabajando'?1:0);
        if(trab !== 0) return trab;
        const oa = orderMap.get(String(a.issue));
        const ob = orderMap.get(String(b.issue));
        if(oa != null && ob != null) return oa - ob;
        if(oa != null) return -1;
        if(ob != null) return 1;
        return Number(a.issue) - Number(b.issue);
    };
}

// #3045/#3905 — Estado del filtro de allowlist. Persistido en sessionStorage
// (no localStorage: el modo del pipeline cambia entre sesiones y un valor
// stale ahí confunde al operador; sessionStorage acota la preferencia a la
// pestaña/sesión activa). REQ-SEC-3 enforced (no se interpola crudo a HTML;
// se escribe vía aria-checked + classList).
// #3905 — default ON: nace ACTIVO en sesión nueva (sessionStorage limpio) para
// dar al operador la vista 1:1 con la allowlist de la ola; respeta la
// preferencia del usuario si ya lo toggleó en esta sesión.
let onlyAllowlistFilter = (function(){
    try {
        var v = sessionStorage.getItem('pl-only-allowlist');
        return v === null ? true : v === '1';
    } catch(e) { return true; }
})();

// #3045 — Issue está en la allowlist activa? Coerción estricta a integer > 0
// (REQ-SEC-2). Sin partial_pause, NO matchea: el badge sigue oculto en running.
function _allowlistOk(issue){
    if(pipelineModeState.mode !== 'partial_pause') return false;
    const n = Number(issue);
    if(!Number.isInteger(n) || n <= 0) return false;
    return pipelineModeState.allowedIssues.includes(n);
}

// #3045 — Mostrar/ocultar el toggle según el modo. Llamada desde tickHeader
// cuando muta pipelineModeState; idempotente.
function refreshAllowlistToggleVisibility(){
    const toggle = document.getElementById('pl-allowlist-toggle');
    if(!toggle) return;
    const visible = pipelineModeState.mode === 'partial_pause'
        && pipelineModeState.allowedIssues.length > 0;
    toggle.style.display = visible ? 'inline-flex' : 'none';
    if(!visible && onlyAllowlistFilter){
        // Si dejó de haber pausa parcial, desactivar el filtro para no
        // ocultar issues "fantasma" en running.
        onlyAllowlistFilter = false;
        toggle.setAttribute('aria-checked', 'false');
        // Re-renderizar con el filtro apagado.
        if(typeof tickPipeline === 'function') tickPipeline().catch(()=>{});
    }
}

// #3045 — Wiring del toggle. Single source of truth: el atributo aria-checked
// del propio elemento. Soporta click + Space + Enter (CA-UX-2).
function wireAllowlistToggle(){
    const toggle = document.getElementById('pl-allowlist-toggle');
    if(!toggle || toggle.dataset.wired === '1') return;
    toggle.dataset.wired = '1';
    // #3905 — reflejar el valor inicial (default ON / sessionStorage) en el
    // atributo aria-checked: el markup nace con aria-checked="false" pero el
    // estado real lo decide onlyAllowlistFilter.
    toggle.setAttribute('aria-checked', onlyAllowlistFilter ? 'true' : 'false');
    function flip(){
        if(toggle.style.display === 'none') return; // oculto = no operable
        onlyAllowlistFilter = !onlyAllowlistFilter;
        toggle.setAttribute('aria-checked', onlyAllowlistFilter ? 'true' : 'false');
        // #3905 — persistir la preferencia del operador en la sesión.
        try { sessionStorage.setItem('pl-only-allowlist', onlyAllowlistFilter ? '1' : '0'); } catch(e) {}
        if(typeof tickPipeline === 'function') tickPipeline().catch(()=>{});
    }
    toggle.addEventListener('click', (ev) => { ev.preventDefault(); flip(); });
    toggle.addEventListener('keydown', (ev) => {
        if(ev.key === ' ' || ev.key === 'Enter'){ ev.preventDefault(); flip(); }
    });
}

async function tickPipeline(){
    const d = await fetchJson('/api/dash/pipeline');
    if(!d) return;
    const board = document.getElementById('pipeline-board');
    if(!board) return;
    const fases = d.fases || [];
    const matrix = d.matrix || {};
    const orderMap = new Map((d.priorityOrder || []).map((id, idx) => [String(id), idx]));
    const cols = {};
    for(const { pipeline: p, fase } of fases){
        const key = p+'/'+fase;
        cols[key] = { p, fase, items: [] };
    }
    for(const [issue, data] of Object.entries(matrix)){
        if(data.faseActual && cols[data.faseActual]){
            const labels = data.labels || [];
            const paused = labels.includes('blocked:dependencies');
            cols[data.faseActual].items.push({
                issue, title: data.title, estado: data.estadoActual,
                bounces: data.bounces, staleMin: data.staleMin, paused,
                rebote: data.rebote, rebote_tipo: data.rebote_tipo,
                motivo_rechazo: data.motivo_rechazo,
                rechazado_en_fase: data.rechazado_en_fase,
                rechazado_skill_previo: data.rechazado_skill_previo,
                // #2894 — agentes esperados en la fase actual + flags de stale
                agents: data.agents || [],
                stale: !!data.stale,
                blockerSkill: data.blockerSkill || null,
                blockerAgeMin: data.blockerAgeMin || 0,
            });
        }
    }
    const cmp = compareByPriority(orderMap);
    // #2894 — glifos de estado (pills) — coinciden con la spec del UX en el issue
    const AGENT_STATE_GLYPH = { listo:'☑', trabajando:'►', pendiente:'☐', bloqueado:'⚠', fallido:'✗' };
    const AGENT_STATE_LABEL = { listo:'listo', trabajando:'trabajando', pendiente:'pendiente', bloqueado:'bloqueado', fallido:'fallido' };
    function renderAgentPills(item){
        if(!item.agents || item.agents.length === 0) return '';
        const pills = item.agents.map(a => {
            const icon = SKILL_ICONS[a.skill] || '·';
            const glyph = AGENT_STATE_GLYPH[a.estado] || '?';
            const label = AGENT_STATE_LABEL[a.estado] || a.estado;
            const ageStr = (a.ageMin != null && a.ageMin > 0) ? (' · ' + a.ageMin + 'm') : '';
            const motivoStr = (a.estado === 'fallido' && a.motivo) ? ' · ' + String(a.motivo).slice(0, 60) : '';
            const tip = a.skill + ' · ' + label + ageStr + motivoStr;
            const isBlocker = item.stale && item.blockerSkill === a.skill;
            const cls = ['pl-card-agent', 'state-' + a.estado];
            if(isBlocker) cls.push('is-blocker');
            if(!a.hasLog) cls.push('no-log');
            const dataLog = a.hasLog && a.logFile ? ' data-log="'+escapeHtml(a.logFile)+'"' : '';
            return '<span class="'+cls.join(' ')+'" data-skill="'+escapeHtml(a.skill)+'"'+dataLog+' title="'+escapeHtml(tip)+'">'
                + '<span class="pl-card-agent-icon">'+icon+'</span>'
                + '<span class="pl-card-agent-state">'+glyph+'</span>'
                + '</span>';
        }).join('');
        return '<div class="pl-card-agents">' + pills + '</div>';
    }
    function renderStaleBadge(item){
        if(!item.stale) return '';
        const tip = 'Sin avance en la fase hace '+item.blockerAgeMin+'m'+(item.blockerSkill?' (bloqueador: '+item.blockerSkill+')':'');
        return '<div class="pl-card-stale-badge" title="'+escapeHtml(tip)+'">⏱ estancado · '+item.blockerAgeMin+'m</div>';
    }
    let html = '';
    for(const [key, col] of Object.entries(cols)){
        col.items.sort(cmp);
        // #3045 — Filtro "solo issues habilitados". Se aplica POR COLUMNA antes
        // del slice(0, 12) — si filtramos después del slice, perderíamos cards
        // habilitadas que cayeron fuera del top 12 de la columna.
        const visible = onlyAllowlistFilter
            ? col.items.filter(i => _allowlistOk(i.issue))
            : col.items;
        const cards = visible.slice(0, 12).map(i => {
            const prio = orderMap.has(String(i.issue)) ? '#' + (orderMap.get(String(i.issue)) + 1) : '';
            const pausedBadge = i.paused ? '<span class="pl-card-paused-badge">⏸ pausado</span>' : '';
            // #3045 — Badge "✅ habilitado" + clase de borde verde cuando el
            // issue está en la allowlist activa. Si simultáneamente está
            // "trabajando", priorizamos el borde de estado del flujo (accent)
            // y el badge sigue siendo señal suficiente — UX-5.
            const isAllowed = _allowlistOk(i.issue);
            const allowlistBadge = isAllowed
              ? '<span class="pl-card-allowlist-badge" title="Habilitado por la pausa parcial activa">✅ habilitado</span>'
              : '';
            const allowlistCls = (isAllowed && i.estado !== 'trabajando') ? ' pl-card-state-allowlisted' : '';
            const reboteBadge = i.rebote
              ? '<div class="pl-card-rebote" title="Rechazado en ' + escapeHtml(i.rechazado_en_fase||'?') + (i.rechazado_skill_previo?'/'+escapeHtml(i.rechazado_skill_previo):'') + ': ' + escapeHtml((i.motivo_rechazo||'').replace(/"/g,"\\u0027").slice(0,400)) + '">↩ rebote' + (i.rebote_tipo?' · '+escapeHtml(i.rebote_tipo):'') + '</div>'
              : '';
            const pauseBtn = '<button class="pl-card-btn pause' + (i.paused?' paused':'') + '" data-issue="'+escapeHtml(i.issue)+'" data-action="' + (i.paused?'resume':'pause') + '" title="' + (i.paused?'Reanudar issue':'Pausar issue') + '">' + (i.paused?'▶':'⏸') + '</button>';
            return '<div class="pl-card pl-card-state-'+escapeHtml(i.estado||'')+allowlistCls+'" data-issue="'+escapeHtml(i.issue)+'">'
              + '<div class="pl-card-head"><span class="pl-card-issue"><a href="https://github.com/intrale/platform/issues/'+escapeHtml(i.issue)+'" target="_blank" rel="noopener">#'+escapeHtml(i.issue)+'</a></span>'+pausedBadge+allowlistBadge+'<span class="pl-card-prio">'+prio+'</span></div>'
              + '<div class="pl-card-title" title="'+escapeHtml(i.title||'')+'">'+escapeHtml((i.title||'').slice(0,60))+'</div>'
              + reboteBadge
              + renderAgentPills(i)
              + renderStaleBadge(i)
              + '<div class="pl-card-actions">'
              +   '<button class="pl-card-btn" data-issue="'+escapeHtml(i.issue)+'" data-action="move-top" title="Máxima prioridad">⏫</button>'
              +   '<button class="pl-card-btn" data-issue="'+escapeHtml(i.issue)+'" data-action="move-up" title="Subir">▲</button>'
              +   '<button class="pl-card-btn" data-issue="'+escapeHtml(i.issue)+'" data-action="move-down" title="Bajar">▼</button>'
              +   '<button class="pl-card-btn" data-issue="'+escapeHtml(i.issue)+'" data-action="move-bottom" title="Mínima prioridad">⏬</button>'
              +   pauseBtn
              + '</div>'
              + '</div>';
        }).join('');
        // #3045 — Cuenta visible vs total cuando hay filtro activo, para
        // que el operador entienda por qué la columna se ve "vacía".
        const countLabel = (onlyAllowlistFilter && visible.length !== col.items.length)
            ? (visible.length + '/' + col.items.length)
            : String(col.items.length);
        html += '<div class="pl-col"><div class="pl-col-head"><span>'+escapeHtml(key)+'</span><span class="pl-col-count">'+countLabel+'</span></div>'+(cards || '<div class="in-empty" style="padding:14px 4px;font-size:11px">vacío</div>')+'</div>';
    }
    // #3905 — Franja terminal "Ola — fuera de flujo". Solo con el filtro
    // "solo habilitados" ACTIVO (CA-4: sin filtro = comportamiento previo, sin
    // franja). Los estados no-ingreso/finalizado los deriva el server en
    // d.waveIssues (cruce allowlist − matrix). Orden UX: no-ingreso primero
    // (lo que falta arriba), finalizado después (lo cerrado abajo). SEC-1:
    // todo (issue/título/estado) pasa por escapeHtml; el ícono va por <use>
    // sobre el sprite controlado (no interpolado).
    let waveBand = '';
    if(onlyAllowlistFilter && Array.isArray(d.waveIssues) && d.waveIssues.length){
        const orderW = { 'no-ingreso': 0, 'finalizado': 1 };
        const sortedW = d.waveIssues.slice().sort((a, b) =>
            ((orderW[a.estado] != null ? orderW[a.estado] : 9) - (orderW[b.estado] != null ? orderW[b.estado] : 9))
            || (Number(a.issue) - Number(b.issue)));
        const waveCards = sortedW.map(w => {
            const isDone = w.estado === 'finalizado';
            const icon = isDone ? 'ic-allowlist-check' : 'ic-llm-queued';
            const label = isDone ? 'Finalizado' : 'Sin ingresar';
            return '<div class="pl-card pl-card-state-'+escapeHtml(w.estado||'')+'" data-issue="'+escapeHtml(w.issue)+'">'
              + '<div class="pl-card-head"><span class="pl-card-issue"><a href="https://github.com/intrale/platform/issues/'+escapeHtml(w.issue)+'" target="_blank" rel="noopener">#'+escapeHtml(w.issue)+'</a></span></div>'
              + '<div class="pl-card-title" title="'+escapeHtml(w.title||'')+'">'+escapeHtml((w.title||'').slice(0,60))+'</div>'
              + '<div class="pl-card-wave-state"><svg class="pl-wave-ic" viewBox="0 0 24 24" aria-hidden="true"><use href="/assets/icons/sprite.svg#'+icon+'"></use></svg>'+label+'</div>'
              + '</div>';
        }).join('');
        waveBand = '<div class="pl-wave-band">'
          + '<div class="pl-wave-band-title">Ola — fuera de flujo</div>'
          + '<div class="pl-wave-band-cards">'+waveCards+'</div>'
          + '</div>';
    }
    const waveBandEl = document.getElementById('pipeline-wave-band');
    if(waveBandEl && waveBandEl.innerHTML !== waveBand) waveBandEl.innerHTML = waveBand;
    if(board.innerHTML !== html){
        board.innerHTML = html;
        board.querySelectorAll('.pl-card-btn').forEach(b => {
            const action = b.dataset.action;
            b.addEventListener('click', (ev) => {
                ev.preventDefault();
                ev.stopPropagation();
                const issue = b.dataset.issue;
                if(action === 'pause' || action === 'resume') return pauseIssue(issue, action === 'resume');
                return moveIssue(issue, action);
            });
        });
        // #2894 — Click en pill = abrir log del agente en nueva pestaña.
        // Event delegation: un solo listener en el board basta para todas las cards.
        board.querySelectorAll('.pl-card-agent[data-log]').forEach(p => {
            p.addEventListener('click', (ev) => {
                ev.preventDefault();
                ev.stopPropagation();
                const log = p.dataset.log;
                if(log) window.open('/logs/'+encodeURIComponent(log), '_blank', 'noopener');
            });
        });
    }
}
const POLLS = [{ fn: tickHeader, ms: 5000 }, { fn: tickPipeline, ms: 5000 }];
async function runAll(){ for(const p of POLLS){ try{ await p.fn(); } catch{} } }
// #3045 — Wirear el toggle ANTES del primer poll para que cuando tickHeader
// llame a refreshAllowlistToggleVisibility() ya exista el handler.
wireAllowlistToggle();
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
function renderHistorial() {
    const body = `
<section class="in-section">
  <h2 class="in-section-title"><span class="in-section-title-icon">📜</span>Actividad reciente</h2>
  <div id="hist-list" class="hist-list"></div>
</section>`;
    const css = `
.hist-list { display: flex; flex-direction: column; gap: 4px; }
.hist-row { display: grid; grid-template-columns: 130px 60px 1fr; gap: 10px; padding: 8px 12px; border-radius: var(--in-radius-sm); background: var(--in-bg-3); font-size: 12px; align-items: center; }
.hist-time { color: var(--in-fg-dim); font-family: var(--in-mono); font-size: 11px; }
.hist-dir-out { color: var(--in-info); }
.hist-dir-in { color: var(--in-accent); }
.hist-text { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }`;
    const script = `
async function tickHist(){
    const d = await fetchJson('/api/dash/historial');
    if(!d) return;
    const c = document.getElementById('hist-list');
    if(!c) return;
    const arr = (d.actividad || []).slice().reverse();
    if(arr.length === 0){ c.innerHTML = '<div class="in-empty">Sin actividad reciente</div>'; return; }
    let html = '';
    for(const a of arr){
        const ts = a.ts ? new Date(a.ts).toLocaleString('es-AR') : '—';
        const dirCls = a.dir==='in' ? 'hist-dir-in' : 'hist-dir-out';
        html += '<div class="hist-row"><span class="hist-time">'+escapeHtml(ts)+'</span><span class="'+dirCls+'">'+escapeHtml(a.dir||'·')+'</span><span class="hist-text">'+escapeHtml(a.text||'')+'</span></div>';
    }
    if(c.innerHTML !== html) c.innerHTML = html;
}
const POLLS = [{ fn: tickHeader, ms: 5000 }, { fn: tickHist, ms: 10000 }];
async function runAll(){ for(const p of POLLS){ try{ await p.fn(); } catch{} } }
runAll();
for(const p of POLLS){ setInterval(() => { p.fn().catch(()=>{}); }, p.ms); }`;
    return pageShell('Historial', 'Eventos del pipeline', body, script, css, 'historial');
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
    return pageShell('Costos', 'Consumo diario por proveedor · presupuesto y cuota de los 5 proveedores', body, script, css, 'costos');
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
