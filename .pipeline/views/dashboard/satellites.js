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
function fetchJson(url){ return fetch(url, {cache:'no-store'}).then(r => r.ok ? r.json() : null).catch(()=>null); }
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

async function killAgent(issue, skill, pipeline, fase){
    if(!confirm('¿Cancelar agente '+skill+' en #'+issue+'?')) return;
    try{
        const r = await fetch('/api/kill-agent', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({issue, skill, pipeline, fase})});
        const j = await r.json();
        showToast(j.msg || (j.ok?'Agente cancelado':'Falló la cancelación'), j.ok);
        if(typeof runAll === 'function') setTimeout(runAll, 600);
    } catch(e){ showToast('Error: '+e.message, false); }
}

async function killSkillGroup(skill, agents){
    if(!agents || !agents.length) return;
    if(!confirm('¿Cancelar todos los agentes '+skill+' ('+agents.length+' activos)?')) return;
    let ok=0, fail=0;
    for(const a of agents){
        try{
            const r = await fetch('/api/kill-agent', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({issue: a.issue, skill: a.skill, pipeline: a.pipeline, fase: a.fase})});
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
            headers: {'Content-Type':'application/json'},
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
        const r = await fetch('/api/needs-human/'+issue+'/dismiss', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({reason})});
        const j = await r.json();
        showToast(j.msg || (j.ok?'Desestimado':'Falló'), j.ok);
        if(typeof runAll === 'function') setTimeout(runAll, 600);
    } catch(e){ showToast('Error: '+e.message, false); }
}

async function moveIssue(issue, direction){
    try{
        const r = await fetch('/api/issue/'+issue+'/'+direction, {method:'POST'});
        const j = await r.json();
        showToast(j.msg || (j.ok?'Movido':'Falló'), j.ok);
        if(typeof runAll === 'function') setTimeout(runAll, 400);
    } catch(e){ showToast('Error: '+e.message, false); }
}

async function pauseIssue(issue, paused){
    const verb = paused ? 'Reanudar' : 'Pausar';
    if(!confirm('¿'+verb+' #'+issue+'? '+(paused ? '(quita label blocked:dependencies)' : '(agrega label blocked:dependencies)'))) return;
    try{
        const r = await fetch('/api/issue/'+issue+'/'+(paused?'resume':'pause'), {method:'POST'});
        const j = await r.json();
        showToast(j.msg || (j.ok?(paused?'Reanudado':'Pausado'):'Falló'), j.ok);
        if(typeof runAll === 'function') setTimeout(runAll, 600);
    } catch(e){ showToast('Error: '+e.message, false); }
}

document.addEventListener('visibilitychange', () => { if(document.visibilityState === 'visible' && typeof runAll === 'function') runAll(); });
`;
}

function pageShell(title, subtitle, bodyHtml, scripts, extraCss = '') {
    const theme = loadTheme();
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
<div class="satellite-frame">
  <header class="in-header">
    <div class="in-header-brand">
      <a class="in-back-link" href="/" target="_self">Operación</a>
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
  <main class="satellite-body">${bodyHtml}</main>
  <footer class="in-footer">
    <span>Refresh independiente · sin flicker</span>
    <span>Intrale V3</span>
  </footer>
</div>
<script>${commonHelpers()}\n${scripts}</script>
</body>
</html>`;
}

// ─────────────────── Equipo ───────────────────
function renderEquipo() {
    const body = `
<section class="in-section">
  <h2 class="in-section-title"><span class="in-section-title-icon">👥</span>Equipo · carga por skill</h2>
  <div id="equipo-grid" class="eq-grid"></div>
</section>`;
    const css = `
.eq-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 14px; }
.eq-card { background: var(--in-bg-3); border: 1px solid var(--in-border); border-radius: var(--in-radius-sm); padding: 14px 16px; display: flex; flex-direction: column; gap: 8px; transition: border-color 0.2s; }
.eq-card.busy { border-color: var(--in-accent); }
.eq-card-head { display: flex; align-items: center; gap: 10px; }
.eq-avatar { width: 32px; height: 32px; border-radius: 9px; display: flex; align-items: center; justify-content: center; color: #fff; font-size: 16px; }
.eq-name { font-weight: 600; font-size: 13px; }
.eq-load { font-size: 12px; color: var(--in-fg-dim); margin-left: auto; font-variant-numeric: tabular-nums; }
.eq-bar { height: 6px; border-radius: 3px; background: var(--in-bg); overflow: hidden; }
.eq-bar > span { display: block; height: 100%; background: var(--in-fg-dim); transition: width 0.4s, background 0.2s; }
.eq-kill { background: transparent; border: 1px solid var(--in-bad); color: var(--in-bad); border-radius: 6px; padding: 3px 9px; font-size: 11px; cursor: pointer; transition: background 0.15s; margin-left: 6px; }
.eq-kill:hover { background: var(--in-bad-soft); }
.eq-card.busy .eq-kill { display: inline-block; }
.eq-kill { display: none; }`;
    const script = `
// Cachea agents activos para que el botón × del skill sepa a quién matar.
let _activeAgents = [];
async function refreshActiveAgents(){
    const d = await fetchJson('/api/dash/active');
    if(d) _activeAgents = d.agents || [];
}

async function killSkillFromCard(skill){
    if(!_activeAgents.length) await refreshActiveAgents();
    const agents = _activeAgents.filter(a => a.skill === skill);
    if(!agents.length){ showToast('Sin agentes '+skill+' corriendo', false); return; }
    await killSkillGroup(skill, agents);
}

async function tickEquipo(){
    await refreshActiveAgents();
    const d = await fetchJson('/api/dash/equipo');
    if(!d) return;
    const grid = document.getElementById('equipo-grid');
    if(!grid) return;
    const seen = new Set();
    for(const sk of (d.skills || [])){
        seen.add(sk.skill);
        let card = grid.querySelector('[data-skill="'+sk.skill+'"]');
        if(!card){
            card = document.createElement('div');
            card.className = 'eq-card';
            card.dataset.skill = sk.skill;
            card.innerHTML = '<div class="eq-card-head"><span class="eq-avatar"></span><span class="eq-name"></span><span class="eq-load"></span><button class="eq-kill" title="Cancelar agentes de este skill">✕</button></div><div class="eq-bar"><span></span></div>';
            card.querySelector('.eq-kill').addEventListener('click', () => killSkillFromCard(sk.skill));
            grid.appendChild(card);
        }
        card.classList.toggle('busy', sk.running > 0);
        const av = card.querySelector('.eq-avatar');
        av.style.background = SKILL_COLORS[sk.skill] || '#8b949e';
        av.textContent = SKILL_ICONS[sk.skill] || '⚙';
        card.querySelector('.eq-name').textContent = sk.skill;
        card.querySelector('.eq-load').textContent = sk.running + '/' + sk.max;
        const bar = card.querySelector('.eq-bar > span');
        bar.style.width = Math.min(100, sk.utilization * 100) + '%';
        bar.style.background = sk.utilization >= 1 ? 'var(--in-bad)' : sk.utilization > 0 ? 'var(--in-accent)' : 'var(--in-fg-soft)';
    }
    for(const card of [...grid.children]){ if(!seen.has(card.dataset.skill)) card.remove(); }
}
const POLLS = [{ fn: tickHeader, ms: 5000 }, { fn: tickEquipo, ms: 5000 }];
async function runAll(){ for(const p of POLLS){ try{ await p.fn(); } catch{} } }
runAll();
for(const p of POLLS){ setInterval(() => { p.fn().catch(()=>{}); }, p.ms); }`;
    return pageShell('Equipo', 'Carga y disponibilidad por skill', body, script, css);
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
.pl-card-stale-badge { display: inline-flex; align-items: center; gap: 3px; font-size: 9px; font-weight: 600; color: var(--in-warn); border: 1px solid var(--in-warn); background: var(--in-warn-soft); border-radius: 3px; padding: 1px 5px; margin-top: 4px; text-transform: uppercase; letter-spacing: 0.5px; width: fit-content; }`;
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

// #3045 — Estado del filtro de allowlist. NO se persiste en localStorage:
// el modo del pipeline cambia entre sesiones y un valor stale ahí confunde
// al operador. Booleano en memoria de módulo, REQ-SEC-3 enforced
// (no se interpola crudo a HTML; se escribe vía aria-checked + classList).
let onlyAllowlistFilter = false;

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
    function flip(){
        if(toggle.style.display === 'none') return; // oculto = no operable
        onlyAllowlistFilter = !onlyAllowlistFilter;
        toggle.setAttribute('aria-checked', onlyAllowlistFilter ? 'true' : 'false');
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
    return pageShell('Pipeline', 'Issues distribuidos por fase', body, script, css);
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
    return pageShell('Bloqueados', 'Issues esperando intervención humana', body, script, css);
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
    return pageShell('Issues', 'Backlog completo y filtros', body, script, css);
}

// ─────────────────── Matriz ───────────────────
function renderMatriz() {
    const body = `
<section class="in-section">
  <h2 class="in-section-title"><span class="in-section-title-icon">📈</span>Matriz · skill × fase (carga actual)</h2>
  <div id="matriz-table"></div>
</section>`;
    const css = `
.mtx-table { width: 100%; border-collapse: collapse; font-size: 12px; }
.mtx-table th, .mtx-table td { padding: 9px 11px; border: 1px solid var(--in-border); text-align: center; font-variant-numeric: tabular-nums; }
.mtx-table th { background: var(--in-bg-3); font-weight: 600; color: var(--in-fg-dim); text-transform: uppercase; font-size: 10px; letter-spacing: 0.6px; }
.mtx-table th.skill-h, .mtx-table td.skill { text-align: left; font-weight: 500; background: var(--in-bg-3); position: sticky; left: 0; }
.mtx-cell-0 { color: var(--in-fg-soft); }
.mtx-cell-active { background: var(--in-accent-soft); color: var(--in-accent); font-weight: 600; }
.mtx-cell-hot { background: var(--in-warn-soft); color: var(--in-warn); font-weight: 600; }
.mtx-totals td { background: var(--in-bg-3); font-weight: 600; color: var(--in-fg-dim); border-top: 2px solid var(--in-border); }`;
    const script = `
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
    html += '<th>Total</th></tr></thead><tbody>';
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
                html += '<td class="'+cls+'">'+(n || '·')+'</td>';
            }
            html += '<td><strong>'+totalsBySkill[skill]+'</strong></td></tr>';
        }
    }
    // Totals row
    html += '<tr class="mtx-totals"><td>Total fase</td>';
    for(const { pipeline: p, fase } of fases){ html += '<td>'+(totalsByFase[p+'/'+fase] || 0)+'</td>'; }
    html += '<td>'+grandTotal+'</td></tr>';
    html += '</tbody></table>';
    if(c.innerHTML !== html) c.innerHTML = html;
}
const POLLS = [{ fn: tickHeader, ms: 5000 }, { fn: tickMatriz, ms: 30000 }];
async function runAll(){ for(const p of POLLS){ try{ await p.fn(); } catch{} } }
runAll();
for(const p of POLLS){ setInterval(() => { p.fn().catch(()=>{}); }, p.ms); }`;
    return pageShell('Matriz', 'Skill × Fase', body, script, css);
}

// ─────────────────── Ops ───────────────────
function renderOps() {
    const body = `
<div id="ops-tg-banner" class="ops-banner-hidden"></div>
<section class="in-section">
  <h2 class="in-section-title"><span class="in-section-title-icon">🛠</span>Procesos del pipeline</h2>
  <div id="ops-procesos" class="ops-grid"></div>
</section>
<section class="in-section" aria-label="Métrica de salud del reconciler GitHub">
  <h2 class="in-section-title"><span class="in-section-title-icon">⏳</span>Reconciler · órdenes descartadas (stale)</h2>
  <div class="stale-orders-panel" id="stale-orders-panel">
    <div class="stale-orders-main">
      <div class="stale-orders-count" id="stale-orders-count">…</div>
      <div class="stale-orders-caption">últimas 24h</div>
    </div>
    <div class="stale-orders-breakdown" id="stale-orders-breakdown"></div>
  </div>
</section>
<section class="in-section">
  <h2 class="in-section-title"><span class="in-section-title-icon">📡</span>QA Environment</h2>
  <pre id="ops-qaenv" class="ops-pre"></pre>
</section>`;
    const css = `
.ops-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 12px; }
.ops-card { background: var(--in-bg-3); padding: 12px 14px; border-radius: var(--in-radius-sm); border: 1px solid var(--in-border); display: flex; flex-direction: column; gap: 4px; }
.ops-card.alive { border-color: var(--in-ok); }
.ops-card.dead { border-color: var(--in-bad); opacity: 0.7; }
.ops-card.bot-down { border-color: var(--in-bad); background: var(--in-bad-soft); }
.ops-card-name { font-weight: 600; }
.ops-card-meta { font-size: 11px; color: var(--in-fg-dim); font-family: var(--in-mono); }
.ops-card-error { font-size: 11px; color: var(--in-bad); font-weight: 600; margin-top: 2px; }
.ops-queues { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 6px; }
.ops-queue-group { display: flex; align-items: center; gap: 3px; padding: 2px 6px; border-radius: 999px; background: var(--in-bg-2); border: 1px solid var(--in-border); font-size: 10px; font-family: var(--in-mono); font-variant-numeric: tabular-nums; }
.ops-queue-group .ops-queue-name { color: var(--in-fg-dim); margin-right: 2px; font-weight: 600; text-transform: lowercase; }
.ops-chip { display: inline-flex; align-items: center; gap: 2px; padding: 0 4px; border-radius: 6px; color: var(--in-fg-dim); }
.ops-chip.hot { color: var(--in-warn); font-weight: 600; }
.ops-chip.work { color: var(--in-info); font-weight: 600; }
.ops-banner-hidden { display: none; }
.ops-banner { display: block; padding: 12px 16px; margin-bottom: 14px; border-radius: var(--in-radius-sm); border: 1px solid var(--in-bad); background: var(--in-bad-soft); color: var(--in-bad); font-weight: 600; }
.ops-banner-sub { font-weight: 400; font-size: 12px; color: var(--in-fg-dim); margin-top: 4px; font-family: var(--in-mono); }
.ops-pre { background: var(--in-bg-3); padding: 14px; border-radius: var(--in-radius-sm); font-family: var(--in-mono); font-size: 11px; overflow: auto; max-height: 280px; border: 1px solid var(--in-border); }
/* #2994 — panel del reconciler stale orders. Reusa --warning/--font-mono.
   Estado vacío: número 0 en --in-fg-dim para señalar salud sin alarma. */
.stale-orders-panel { display: flex; flex-direction: column; gap: 12px; padding: 12px 14px; background: var(--in-bg-3); border: 1px solid var(--in-border); border-radius: var(--in-radius-sm); min-width: 260px; }
.stale-orders-main { display: flex; flex-direction: column; gap: 2px; }
.stale-orders-count { font-family: var(--in-mono, var(--font-mono, monospace)); font-size: 32px; font-weight: 600; color: var(--warning, var(--in-warn, #D29922)); font-variant-numeric: tabular-nums; line-height: 1.1; }
.stale-orders-count.is-zero { color: var(--in-fg-dim); }
.stale-orders-caption { font-size: 12px; color: var(--in-fg-dim); }
.stale-orders-breakdown { display: flex; flex-direction: column; gap: 4px; }
.stale-orders-breakdown-row { display: flex; justify-content: space-between; gap: 12px; font-family: var(--in-mono, monospace); font-size: 12px; font-variant-numeric: tabular-nums; padding: 2px 0; }
.stale-orders-breakdown-reason { color: var(--in-fg-default, var(--in-fg)); }
.stale-orders-breakdown-value { color: var(--warning, var(--in-warn, #D29922)); font-weight: 600; }
.stale-orders-empty { color: var(--in-fg-dim); font-size: 12px; }`;
    const script = `
const PROC_QUEUES = {
    'listener': ['commander', 'telegram'],
    'svc-telegram': ['telegram'],
    'svc-github': ['github'],
    'svc-drive': ['drive'],
    'svc-emulador': ['emulador'],
};
function chip(icon, n, cls){
    const v = Number(n) || 0;
    const c = (cls === 'pend' && v > 0) ? 'ops-chip hot'
            : (cls === 'work' && v > 0) ? 'ops-chip work'
            : 'ops-chip';
    return '<span class="'+c+'" title="'+escapeHtml(cls)+'">'+icon+' '+v+'</span>';
}
function queuesHTML(name, servicios){
    const queues = PROC_QUEUES[name] || [];
    if(!queues.length) return '';
    let html = '<div class="ops-queues">';
    for(const q of queues){
        const s = (servicios && servicios[q]) || { pendiente: 0, trabajando: 0, listo: 0 };
        html += '<span class="ops-queue-group" title="cola '+escapeHtml(q)+'">'
            + '<span class="ops-queue-name">'+escapeHtml(q)+'</span>'
            + chip('⏳', s.pendiente, 'pend')
            + chip('⚙', s.trabajando, 'work')
            + chip('✓', s.listo, 'done')
            + '</span>';
    }
    html += '</div>';
    return html;
}
const TG_PROCS = new Set(['listener', 'svc-telegram']);
async function tickOps(){
    const d = await fetchJson('/api/dash/ops');
    if(!d) return;
    const tgHealth = d.telegramHealth;
    const tgDown = tgHealth && tgHealth.ok === false;

    const banner = document.getElementById('ops-tg-banner');
    if(banner){
        if(tgDown){
            const err = tgHealth.lastError || {};
            const desc = (err.description || 'sin detalle').slice(0, 200);
            const code = err.code || '—';
            const src = err.source || '—';
            const upd = tgHealth.updatedAt ? new Date(tgHealth.updatedAt).toLocaleString('es-AR') : '—';
            const html = '<div class="ops-banner">⚠ Bot de Telegram caído'
                + '<div class="ops-banner-sub">'+escapeHtml(desc)+' · code='+escapeHtml(String(code))+' · origen='+escapeHtml(String(src))+' · actualizado '+escapeHtml(upd)+'</div>'
                + '<div class="ops-banner-sub">Acción: rotar token con BotFather y guardarlo en ~/.claude/secrets/telegram-config.json (fuera del repo). Reiniciar listener.</div>'
                + '</div>';
            if(banner.innerHTML !== html){ banner.className = ''; banner.innerHTML = html; }
        } else if(banner.className !== 'ops-banner-hidden'){
            banner.className = 'ops-banner-hidden';
            banner.innerHTML = '';
        }
    }

    const grid = document.getElementById('ops-procesos');
    if(grid){
        let html = '';
        for(const [name, p] of Object.entries(d.procesos || {})){
            const isTg = TG_PROCS.has(name);
            let cls = p.alive ? 'alive' : 'dead';
            if(isTg && tgDown) cls = (p.alive ? 'alive ' : 'dead ') + 'bot-down';
            const errLine = (isTg && tgDown)
                ? '<div class="ops-card-error">⚠ '+escapeHtml((tgHealth.lastError||{}).description || 'API rechazada').slice(0, 80)+'</div>'
                : '';
            html += '<div class="ops-card '+cls+'">'
                + '<div class="ops-card-name">'+(p.alive?'\u{1F7E2}':'\u{1F534}')+' '+escapeHtml(name)+'</div>'
                + '<div class="ops-card-meta">PID '+(p.pid||'—')+'</div>'
                + '<div class="ops-card-meta">uptime '+fmtDur(p.uptime||0)+'</div>'
                + errLine
                + queuesHTML(name, d.servicios)
                + '</div>';
        }
        if(grid.innerHTML !== html) grid.innerHTML = html;
    }
    const pre = document.getElementById('ops-qaenv');
    if(pre){
        const txt = JSON.stringify({ qaEnv: d.qaEnv, qaRemote: d.qaRemote, infraHealth: d.infraHealth, telegramHealth: d.telegramHealth }, null, 2);
        if(pre.textContent !== txt) pre.textContent = txt;
    }
}
async function tickStaleOrders(){
    const d = await fetchJson('/api/dash/reconciler-stale-orders');
    if(!d) return;
    const countEl = document.getElementById('stale-orders-count');
    const breakdownEl = document.getElementById('stale-orders-breakdown');
    if(!countEl || !breakdownEl) return;
    const total = Number(d.total_24h) || 0;
    const txt = String(total);
    if(countEl.textContent !== txt) countEl.textContent = txt;
    countEl.className = total === 0 ? 'stale-orders-count is-zero' : 'stale-orders-count';
    const reasons = d.by_reason || {};
    let html = '';
    if(total === 0){
        html = '<div class="stale-orders-empty">Sin descartes en 24h — saludable</div>';
    } else {
        const entries = Object.entries(reasons).sort((a,b) => b[1] - a[1]);
        for(const [reason, n] of entries){
            html += '<div class="stale-orders-breakdown-row">'
                + '<span class="stale-orders-breakdown-reason">— '+escapeHtml(reason)+'</span>'
                + '<span class="stale-orders-breakdown-value">'+(Number(n)||0)+'</span>'
                + '</div>';
        }
    }
    if(breakdownEl.innerHTML !== html) breakdownEl.innerHTML = html;
}
const POLLS = [{ fn: tickHeader, ms: 5000 }, { fn: tickOps, ms: 5000 }, { fn: tickStaleOrders, ms: 30000 }];
async function runAll(){ for(const p of POLLS){ try{ await p.fn(); } catch{} } }
runAll();
for(const p of POLLS){ setInterval(() => { p.fn().catch(()=>{}); }, p.ms); }`;
    return pageShell('Ops', 'Procesos, servicios e infraestructura', body, script, css);
}

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
    const snap = await fetchJson('/metrics/snapshot?window=24h').catch(()=>null);
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
    return pageShell('KPIs', 'Métricas detalladas', body, script, css);
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
    return pageShell('Historial', 'Eventos del pipeline', body, script, css);
}

// ─────────────────── Costos ───────────────────
function renderCostos() {
    const body = `
<section class="in-section">
  <h2 class="in-section-title"><span class="in-section-title-icon">📊</span>Cuota Plan Max · sesión 5h + semanal (reset domingo 21:00 ART)</h2>
  <p style="color:var(--in-fg-dim);font-size:12px;margin:0 0 14px 0">Anthropic no expone API. Estimación basada en duration_ms del activity-log (solo agentes Claude del pipeline; tu uso interactivo en claude.ai cuenta aparte). Auto-ajuste pasivo del límite semanal cuando el observado lo supera sin bloqueos.</p>
  <div id="quota-grid" class="kp-grid"></div>
  <div id="quota-bar-wrap" style="margin-top:14px"></div>
  <div id="quota-meta" style="margin-top:10px;font-size:12px;color:var(--in-fg-dim)"></div>
  <details id="quota-calib" style="margin-top:14px;border-top:1px solid var(--in-border);padding-top:12px">
    <summary style="cursor:pointer;font-size:12px;color:var(--in-fg-dim);user-select:none">🎯 Calibrar con valores reales de claude.ai/settings/usage (con aprendizaje)</summary>
    <p style="font-size:11px;color:var(--in-fg-dim);margin:10px 0 6px 0">Pegá los % que ves y, si querés mejorar la precisión del reset semanal, también el tiempo restante hasta cada reset. Cada calibración entra al historial — los factores se promedian con EMA (más muestras = más estables, menos sensibles a outliers).</p>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:10px">
      <div>
        <label style="font-size:11px;color:var(--in-fg-dim);display:block;margin-bottom:4px">% semanal real</label>
        <input id="calib-weekly" type="number" step="0.1" min="0" max="100" placeholder="ej: 22" class="in-btn" style="width:100%;background:var(--in-bg-3);font-family:var(--in-mono)">
      </div>
      <div>
        <label style="font-size:11px;color:var(--in-fg-dim);display:block;margin-bottom:4px">% sesión 5h real</label>
        <input id="calib-session" type="number" step="0.1" min="0" max="100" placeholder="ej: 60" class="in-btn" style="width:100%;background:var(--in-bg-3);font-family:var(--in-mono)">
      </div>
      <div>
        <label style="font-size:11px;color:var(--in-fg-dim);display:block;margin-bottom:4px">Sesión: día y hora del reset (opcional)</label>
        <input id="calib-session-at" type="datetime-local" class="in-btn" style="width:100%;background:var(--in-bg-3);font-family:var(--in-mono)">
      </div>
      <div>
        <label style="font-size:11px;color:var(--in-fg-dim);display:block;margin-bottom:4px">Semanal: día y hora del reset (opcional)</label>
        <input id="calib-weekly-at" type="datetime-local" class="in-btn" style="width:100%;background:var(--in-bg-3);font-family:var(--in-mono)">
      </div>
    </div>
    <div style="display:flex;gap:8px">
      <button id="calib-save" class="in-btn" style="border-color:var(--in-accent);color:var(--in-accent)">▶ Aplicar y aprender</button>
      <button id="calib-clear" class="in-btn" style="border-color:var(--in-fg-soft);color:var(--in-fg-dim)">✕ Borrar calibración</button>
    </div>
    <div id="calib-status" style="margin-top:10px;font-size:11px;color:var(--in-fg-dim)"></div>
    <div id="calib-history" style="margin-top:14px"></div>
  </details>
</section>
<section class="in-section">
  <h2 class="in-section-title"><span class="in-section-title-icon">💰</span>Consumo · tokens y costo</h2>
  <p style="color:var(--in-fg-dim);font-size:12px;margin:0 0 14px 0">Datos del aggregator V3 (.pipeline/metrics/snapshot.json). Reload cada 60s.</p>
  <div id="costos-grid" class="kp-grid"></div>
</section>
<section class="in-section">
  <h2 class="in-section-title"><span class="in-section-title-icon">📋</span>Por skill</h2>
  <pre id="costos-detail" class="kp-pre"></pre>
</section>`;
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
            if(!confirm('¿Borrar la calibración actual? El KPI vuelve a mostrar el pipeline raw. El historial de calibraciones previas se conserva.')) return;
            try{
                const r = await fetch('/api/dash/quota/calibrate', {method:'DELETE'});
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
    return pageShell('Costos', 'Cuota Plan Max + tokens y consumo', body, script, css);
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
function renderModoDescanso() {
    const body = `
<section class="in-section">
  <h2 class="in-section-title"><span class="in-section-title-icon">🌙</span>Modo descanso · calendario semanal</h2>
  <p class="rm-hint-text">
    Durante los periodos configurados, sólo corren los <strong>skills determinísticos</strong>
    (delivery, builder, linter, tester). El resto se queda en cola y arranca al cerrar el periodo.
    Los issues con label <code>priority:critical</code> hacen bypass del gate.
  </p>
  <div id="rm-status" class="rm-status">…</div>
  <form id="rm-form" class="rm-form" novalidate>
    <div class="rm-row">
      <label class="rm-label">
        <input type="checkbox" id="rm-active"> <strong>Activar modo descanso</strong>
      </label>
      <span class="rm-hint">Si destildás, el pipeline opera sin restricciones (CA-1.9).</span>
    </div>
    <div class="rm-row rm-row-tz">
      <label>
        <span class="rm-label-text">Zona horaria</span>
        <input type="text" id="rm-timezone" placeholder="America/Argentina/Buenos_Aires" list="rm-tz-list">
        <datalist id="rm-tz-list"></datalist>
      </label>
    </div>
    <section class="rm-grid" id="rm-grid" data-rm-editing="0" aria-label="Calendario semanal de periodos de descanso">
      <!-- 7 columnas inyectadas por buildGrid() -->
    </section>
    <div class="rm-errors-box" id="rm-errors" hidden></div>
    <div class="rm-row rm-actions">
      <button type="submit" class="in-btn rm-save" id="rm-save">💾 Guardar configuración</button>
      <span id="rm-error-count" class="rm-error-count"></span>
      <span id="rm-msg" class="rm-msg"></span>
    </div>
  </form>
  <div class="rm-meta">
    <p><strong>Bypass labels</strong> (read-only, viven en <code>config.yaml</code>):
      <span id="rm-bypass">…</span></p>
    <p><strong>Última actualización:</strong> <span id="rm-updated">—</span></p>
  </div>
</section>`;
    const css = `
/* CA-8.8: todos los colores vienen de design tokens. Cero hardcoded. */
.rm-hint-text { color: var(--in-fg-dim); font-size: 12px; margin: 0 0 14px 0; }
.rm-status { padding: 12px 16px; border-radius: var(--in-radius-sm); border: 1px solid var(--in-border); background: var(--in-bg-3); margin-bottom: 16px; font-size: 13px; display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.rm-status.rm-active { border-color: rgba(124,92,255,0.55); color: var(--rest-mode-fg, #C5B7FF); background: var(--rest-mode-bg, rgba(124,92,255,0.16)); }
.rm-status.rm-inactive { color: var(--in-fg-dim); }
.rm-status-icon { font-size: 16px; }
.rm-status-text { display: flex; flex-direction: column; gap: 2px; }
.rm-status-title { font-weight: 600; }
.rm-status-sub { font-size: 11px; color: var(--in-fg-soft); }
.rm-form { display: flex; flex-direction: column; gap: 14px; }
.rm-row { display: flex; flex-direction: column; gap: 6px; }
.rm-row-tz { max-width: 360px; }
.rm-row label { font-size: 12px; color: var(--in-fg); display: flex; flex-direction: column; gap: 4px; }
.rm-label { flex-direction: row !important; align-items: center; gap: 8px !important; }
.rm-label-text { font-size: 11px; text-transform: uppercase; color: var(--in-fg-dim); letter-spacing: 0.5px; }
.rm-hint { font-size: 11px; color: var(--in-fg-soft); }
.rm-form input[type="time"], .rm-form input[type="text"] { padding: 7px 9px; background: var(--in-bg); color: var(--in-fg); border: 1px solid var(--in-border); border-radius: 4px; font-family: var(--in-mono); font-size: 12px; }
.rm-form input:focus { outline: none; border-color: var(--in-accent); }

/* Grid semanal (CA-8.1). */
.rm-grid { display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); gap: 10px; margin: 6px 0; }
.rm-col { display: flex; flex-direction: column; gap: 8px; padding: 10px; border: 1px solid var(--in-border); border-radius: var(--in-radius-sm); background: var(--in-bg-3); min-height: 180px; }
.rm-col-head { display: flex; align-items: baseline; justify-content: space-between; gap: 6px; padding-bottom: 6px; border-bottom: 1px dashed var(--in-border); }
.rm-col-day { font-size: 12px; font-weight: 600; color: var(--in-fg); text-transform: uppercase; letter-spacing: 0.5px; }
.rm-col-count { font-size: 11px; color: var(--in-fg-soft); font-family: var(--in-mono); }
.rm-col-count.rm-col-count-full { color: var(--warning, #D29922); }
.rm-col-empty { font-size: 11px; color: var(--in-fg-soft); padding: 16px 6px; text-align: center; font-style: italic; }
.rm-period { display: flex; flex-direction: column; gap: 4px; padding: 6px 8px; border: 1px solid var(--in-border); border-radius: 4px; background: var(--in-bg); }
.rm-period.rm-period-active { border-color: rgba(124,92,255,0.55); background: var(--rest-mode-bg, rgba(124,92,255,0.16)); }
.rm-period.rm-period-error { border-color: var(--danger, #F85149); background: rgba(248,81,73,0.08); }
.rm-period-inputs { display: flex; align-items: center; gap: 4px; }
.rm-period-inputs input[type="time"] { padding: 4px 6px; font-size: 11px; flex: 1; min-width: 0; }
.rm-period-dash { color: var(--in-fg-soft); font-size: 11px; }
.rm-period-remove { background: transparent; border: 1px solid var(--in-border); color: var(--in-fg-dim); padding: 2px 6px; border-radius: 3px; cursor: pointer; font-size: 11px; line-height: 1; }
.rm-period-remove:hover { color: var(--danger, #F85149); border-color: var(--danger, #F85149); }
.rm-period-caption { font-size: 10px; color: var(--in-fg-soft); display: flex; align-items: center; gap: 4px; }
.rm-period-caption.rm-period-caption-cross { color: var(--rest-mode-fg, #C5B7FF); }
.rm-period-error-msg { font-size: 10px; color: var(--danger, #F85149); margin-top: 2px; }
.rm-col-add { background: transparent; border: 1px dashed var(--in-border); color: var(--in-fg-dim); padding: 6px 8px; border-radius: 4px; cursor: pointer; font-size: 11px; font-family: inherit; margin-top: auto; }
.rm-col-add:hover:not(:disabled) { border-color: rgba(124,92,255,0.55); color: var(--rest-mode-fg, #C5B7FF); }
.rm-col-add:disabled { opacity: 0.4; cursor: not-allowed; }

.rm-errors-box { padding: 10px 12px; border-radius: 4px; border: 1px solid var(--danger, #F85149); background: rgba(248,81,73,0.08); color: var(--danger, #F85149); font-size: 12px; }
.rm-errors-box ul { margin: 4px 0 0 0; padding-left: 18px; }
.rm-errors-box li { margin: 2px 0; }
.rm-error-count { font-size: 12px; color: var(--danger, #F85149); }
.rm-error-count:empty { display: none; }

.rm-actions { flex-direction: row !important; align-items: center; gap: 14px; padding-top: 8px; flex-wrap: wrap; }
.rm-save { background: var(--rest-mode-bg, rgba(124,92,255,0.16)); border-color: rgba(124,92,255,0.55); color: var(--rest-mode-fg, #C5B7FF); padding: 8px 16px; }
.rm-save:hover:not(:disabled) { filter: brightness(1.18); }
.rm-save:disabled { opacity: 0.4; cursor: not-allowed; }
.rm-msg { font-size: 12px; color: var(--in-fg-dim); }
.rm-msg.rm-ok { color: var(--in-ok); }
.rm-msg.rm-err { color: var(--in-bad); }
.rm-meta { margin-top: 18px; padding-top: 14px; border-top: 1px solid var(--in-border); font-size: 12px; color: var(--in-fg-dim); }
.rm-meta p { margin: 4px 0; }
.rm-meta code { font-family: var(--in-mono); background: var(--in-bg-3); padding: 1px 6px; border-radius: 3px; }

/* Mobile: el grid de 7 columnas se transforma en lista vertical. */
@media (max-width: 900px) {
    .rm-grid { grid-template-columns: 1fr; }
    .rm-col { min-height: 0; }
}`;
    const script = `
// nota: validacion cliente solo UX, backend revalida en POST /api/rest-mode (FE-SEC-2).
// Este script espeja la logica de .pipeline/lib/rest-mode-schedule.js — si una
// vuelve a cambiar, actualizar la otra. Tests del helper cubren los casos.
const TZ_DEFAULTS = ['America/Argentina/Buenos_Aires','UTC','America/New_York','America/Mexico_City','America/Sao_Paulo','Europe/Madrid','Europe/London'];
const DAY_KEYS = ['monday','tuesday','wednesday','thursday','friday','saturday','sunday'];
const DAY_LABELS = { monday: 'Lun', tuesday: 'Mar', wednesday: 'Mié', thursday: 'Jue', friday: 'Vie', saturday: 'Sáb', sunday: 'Dom' };
const DAY_KEY_TO_DOW = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };
const DOW_TO_DAY_KEY = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
const MAX_PERIODS_PER_DAY = 24;  // SEC-2 espejo (backend revalida).
const HHMM_RE = /^([01]\\d|2[0-3]):[0-5]\\d$/;
const FULL_DAY_START = '00:00';
const FULL_DAY_END = '23:59';
const MIN_PER_DAY = 1440;
const MIN_PER_WEEK = 10080;

// Estado in-memory del editor. NO se sincroniza con el servidor mientras el
// usuario está editando (CA-8.7). Cada vez que el usuario suelta el último
// input, se setea un debounce de 3s para liberar el "lock" de edición.
let scheduleState = makeEmptySchedule();
let editingTimer = null;
let bypassLabelsState = [];
let updatedAtState = null;

function makeEmptySchedule(){
    return { monday: [], tuesday: [], wednesday: [], thursday: [], friday: [], saturday: [], sunday: [] };
}

function hhmmToMin(hhmm){
    if(typeof hhmm !== 'string' || !HHMM_RE.test(hhmm)) return null;
    const [h, m] = hhmm.split(':').map(n => parseInt(n, 10));
    return h * 60 + m;
}

function isFullDay(p){ return p && p.start === FULL_DAY_START && p.end === FULL_DAY_END; }

function crossesMidnight(p){
    if(isFullDay(p)) return false;
    const s = hhmmToMin(p.start);
    const e = hhmmToMin(p.end);
    return s !== null && e !== null && s > e;
}

function expandPeriod(dayKey, p){
    const dow = DAY_KEY_TO_DOW[dayKey];
    if(dow == null) return [];
    const base = ((dow + 6) % 7) * MIN_PER_DAY;
    const sMin = hhmmToMin(p.start);
    const eMin = hhmmToMin(p.end);
    if(sMin === null || eMin === null) return [];
    if(isFullDay(p)) return [{ startAbs: base, endAbs: base + MIN_PER_DAY }];
    if(sMin < eMin) return [{ startAbs: base + sMin, endAbs: base + eMin }];
    return [
        { startAbs: base + sMin, endAbs: base + MIN_PER_DAY },
        { startAbs: (base + MIN_PER_DAY) % MIN_PER_WEEK, endAbs: ((base + MIN_PER_DAY) % MIN_PER_WEEK) + eMin },
    ];
}

function intervalsOverlap(a, b){
    const split = (iv) => iv.endAbs <= MIN_PER_WEEK
        ? [iv]
        : [{ startAbs: iv.startAbs, endAbs: MIN_PER_WEEK }, { startAbs: 0, endAbs: iv.endAbs - MIN_PER_WEEK }];
    const as = split(a);
    const bs = split(b);
    for(const ai of as){
        for(const bi of bs){
            if(ai.startAbs < bi.endAbs && bi.startAbs < ai.endAbs) return true;
        }
    }
    return false;
}

// Devuelve un objeto { errors: string[], perPeriod: Map<dayKey+idx, errMsg[]> }.
// La validación NO bloquea el submit por sí sola — eso lo decide el caller
// (CA-8.4); pero sí pinta los periodos en rojo y deshabilita "Guardar" mientras
// haya errores. nota: solo UX, backend revalida.
function validateScheduleClient(schedule){
    const errors = [];
    const perPeriod = {};
    function tag(day, idx, msg){
        const k = day + ':' + idx;
        if(!perPeriod[k]) perPeriod[k] = [];
        perPeriod[k].push(msg);
    }

    // Validación por-periodo (HH:MM, SEC-4) y cap (SEC-2).
    for(const day of DAY_KEYS){
        const list = schedule[day] || [];
        if(list.length > MAX_PERIODS_PER_DAY){
            errors.push(DAY_LABELS[day] + ': máximo 24 periodos/día (recibidos ' + list.length + ')');
        }
        for(let i = 0; i < list.length; i++){
            const p = list[i];
            if(!p || typeof p !== 'object'){ tag(day, i, 'Periodo inválido'); continue; }
            if(!HHMM_RE.test(p.start || '')) tag(day, i, 'Hora de inicio inválida');
            if(!HHMM_RE.test(p.end || ''))   tag(day, i, 'Hora de fin inválida');
            if(perPeriod[day + ':' + i]) continue;
            if(p.start === p.end && !isFullDay(p)){
                tag(day, i, 'Hora de inicio y fin no pueden ser iguales (salvo 00:00–23:59 = día completo)');
            }
        }
    }

    // Overlap absoluto en la semana (SEC-3).
    const expanded = [];
    for(const day of DAY_KEYS){
        const list = schedule[day] || [];
        for(let i = 0; i < list.length; i++){
            if(perPeriod[day + ':' + i]) continue; // periodos ya rotos no entran al overlap
            const ivs = expandPeriod(day, list[i]);
            for(const iv of ivs) expanded.push({ day, idx: i, period: list[i], iv });
        }
    }
    const seen = {};
    for(let i = 0; i < expanded.length; i++){
        for(let j = i + 1; j < expanded.length; j++){
            const a = expanded[i], b = expanded[j];
            if(a.day === b.day && a.idx === b.idx) continue;
            if(!intervalsOverlap(a.iv, b.iv)) continue;
            const k1 = a.day + ':' + a.idx + '<->' + b.day + ':' + b.idx;
            const k2 = b.day + ':' + b.idx + '<->' + a.day + ':' + a.idx;
            if(seen[k1] || seen[k2]) continue;
            seen[k1] = 1;
            tag(a.day, a.idx, 'Solapa con ' + DAY_LABELS[b.day] + ' ' + b.period.start + '–' + b.period.end);
            tag(b.day, b.idx, 'Solapa con ' + DAY_LABELS[a.day] + ' ' + a.period.start + '–' + a.period.end);
            if(a.day === b.day){
                errors.push(DAY_LABELS[a.day] + ': solapamiento entre ' + a.period.start + '–' + a.period.end + ' y ' + b.period.start + '–' + b.period.end);
            } else {
                errors.push(DAY_LABELS[a.day] + ' ' + a.period.start + '–' + a.period.end + ' solapa con ' + DAY_LABELS[b.day] + ' ' + b.period.start + '–' + b.period.end + ' (cruza medianoche)');
            }
        }
    }

    return { errors, perPeriod };
}

// ----- Render del grid usando createElement + textContent (CA-XSS, FE-SEC-1) -----

function clearChildren(el){ while(el.firstChild) el.removeChild(el.firstChild); }

function makeEl(tag, opts){
    const el = document.createElement(tag);
    if(opts){
        if(opts.cls){ el.className = opts.cls; }
        if(opts.text != null){ el.textContent = String(opts.text); }
        if(opts.attrs){ for(const k in opts.attrs){ el.setAttribute(k, String(opts.attrs[k])); } }
    }
    return el;
}

function buildGrid(){
    const grid = document.getElementById('rm-grid');
    if(!grid) return;
    clearChildren(grid);
    const validation = validateScheduleClient(scheduleState);
    for(const day of DAY_KEYS){
        const list = scheduleState[day] || [];
        const col = makeEl('div', { cls: 'rm-col', attrs: { 'data-day': day } });

        const head = makeEl('div', { cls: 'rm-col-head' });
        head.appendChild(makeEl('span', { cls: 'rm-col-day', text: DAY_LABELS[day] }));
        const countCls = list.length >= MAX_PERIODS_PER_DAY ? 'rm-col-count rm-col-count-full' : 'rm-col-count';
        head.appendChild(makeEl('span', { cls: countCls, text: list.length + '/' + MAX_PERIODS_PER_DAY }));
        col.appendChild(head);

        if(list.length === 0){
            col.appendChild(makeEl('div', { cls: 'rm-col-empty', text: '○ Sin descanso' }));
        } else {
            for(let i = 0; i < list.length; i++){
                col.appendChild(buildPeriodRow(day, i, list[i], validation.perPeriod[day + ':' + i] || []));
            }
        }

        const addBtn = makeEl('button', { cls: 'rm-col-add', text: '+ Periodo' });
        addBtn.type = 'button';
        addBtn.disabled = list.length >= MAX_PERIODS_PER_DAY;
        if(addBtn.disabled){ addBtn.title = 'Máximo 24 periodos por día'; }
        addBtn.addEventListener('click', () => {
            scheduleState[day] = (scheduleState[day] || []).concat([{ start: '22:00', end: '07:00' }]);
            markEditing();
            buildGrid();
        });
        col.appendChild(addBtn);

        grid.appendChild(col);
    }
    refreshErrorsBox(validation.errors);
}

function buildPeriodRow(day, idx, period, periodErrors){
    const row = makeEl('div', { cls: 'rm-period' + (periodErrors.length ? ' rm-period-error' : '') });

    const inputs = makeEl('div', { cls: 'rm-period-inputs' });
    const startIn = document.createElement('input');
    startIn.type = 'time';
    startIn.value = period.start || '';
    startIn.setAttribute('data-rm-input', 'start');
    startIn.addEventListener('input', () => {
        scheduleState[day][idx].start = startIn.value;
        markEditing();
        buildGrid();
    });
    const dash = makeEl('span', { cls: 'rm-period-dash', text: '–' });
    const endIn = document.createElement('input');
    endIn.type = 'time';
    endIn.value = period.end || '';
    endIn.setAttribute('data-rm-input', 'end');
    endIn.addEventListener('input', () => {
        scheduleState[day][idx].end = endIn.value;
        markEditing();
        buildGrid();
    });
    inputs.appendChild(startIn);
    inputs.appendChild(dash);
    inputs.appendChild(endIn);

    const removeBtn = makeEl('button', { cls: 'rm-period-remove', text: '✕', attrs: { 'aria-label': 'Eliminar periodo' } });
    removeBtn.type = 'button';
    removeBtn.addEventListener('click', () => {
        scheduleState[day].splice(idx, 1);
        markEditing();
        buildGrid();
    });
    inputs.appendChild(removeBtn);

    row.appendChild(inputs);

    // Caption visual: día completo / cruza medianoche / intra-día normal.
    if(isFullDay(period)){
        row.appendChild(makeEl('div', { cls: 'rm-period-caption', text: '☀ Día completo' }));
    } else if(crossesMidnight(period)){
        row.appendChild(makeEl('div', { cls: 'rm-period-caption rm-period-caption-cross', text: '🌙 Cruza medianoche · +1 día' }));
    }

    // Errores por-periodo (FE-SEC-1: textContent, no innerHTML).
    for(const msg of periodErrors){
        row.appendChild(makeEl('div', { cls: 'rm-period-error-msg', text: '⚠ ' + msg }));
    }

    return row;
}

function refreshErrorsBox(errors){
    const box = document.getElementById('rm-errors');
    const count = document.getElementById('rm-error-count');
    const saveBtn = document.getElementById('rm-save');
    if(!box || !count || !saveBtn) return;
    clearChildren(box);
    if(errors.length === 0){
        box.hidden = true;
        count.textContent = '';
        saveBtn.disabled = false;
        return;
    }
    box.hidden = false;
    box.appendChild(makeEl('div', { text: 'Errores de validación de cliente (nota: el backend revalida igual):' }));
    const ul = makeEl('ul');
    for(const e of errors){ ul.appendChild(makeEl('li', { text: e })); }
    box.appendChild(ul);
    count.textContent = errors.length + ' error' + (errors.length === 1 ? '' : 'es');
    saveBtn.disabled = true;
}

// ----- Marcador data-rm-editing (CA-8.7 + FE-SEC-3) -----
function markEditing(){
    const grid = document.getElementById('rm-grid');
    if(grid) grid.setAttribute('data-rm-editing', '1');
    if(editingTimer) clearTimeout(editingTimer);
    editingTimer = setTimeout(() => {
        const g = document.getElementById('rm-grid');
        if(g) g.setAttribute('data-rm-editing', '0');
        editingTimer = null;
    }, 3000);
}

// ----- Status header (#rm-status) y bypass labels -----
function renderStatus(payload){
    const status = document.getElementById('rm-status');
    if(!status) return;
    clearChildren(status);
    status.classList.remove('rm-active','rm-inactive');
    const rm = (payload && payload.window) || {};
    if(!rm.active){
        status.classList.add('rm-inactive');
        status.appendChild(makeEl('span', { cls: 'rm-status-icon', text: '○' }));
        status.appendChild(makeEl('span', { cls: 'rm-status-text', text: 'Inactivo · pipeline opera sin restricciones.' }));
    } else {
        status.classList.add('rm-active');
        status.appendChild(makeEl('span', { cls: 'rm-status-icon', text: '🌙' }));
        const txt = makeEl('span', { cls: 'rm-status-text' });
        const cur = payload && payload.currentPeriod;
        const next = payload && payload.nextPeriod;
        const periodsToday = (payload && typeof payload.periodsToday === 'number') ? payload.periodsToday : null;
        if(cur && cur.start && cur.end){
            txt.appendChild(makeEl('span', { cls: 'rm-status-title', text: 'Activa · ahora ' + cur.start + '–' + cur.end }));
            if(periodsToday != null && next && next.start){
                txt.appendChild(makeEl('span', { cls: 'rm-status-sub', text: periodsToday + ' periodo' + (periodsToday === 1 ? '' : 's') + ' hoy · próximo ' + next.start }));
            } else if(periodsToday != null){
                txt.appendChild(makeEl('span', { cls: 'rm-status-sub', text: periodsToday + ' periodo' + (periodsToday === 1 ? '' : 's') + ' hoy' }));
            }
        } else if(next && next.start){
            txt.appendChild(makeEl('span', { cls: 'rm-status-title', text: 'Programada · próximo ' + next.start + (next.end ? '–' + next.end : '') }));
            if(periodsToday != null){
                txt.appendChild(makeEl('span', { cls: 'rm-status-sub', text: periodsToday + ' periodo' + (periodsToday === 1 ? '' : 's') + ' hoy' }));
            }
        } else {
            txt.appendChild(makeEl('span', { cls: 'rm-status-title', text: 'Activa · sin periodos configurados todavía' }));
        }
        status.appendChild(txt);
    }
    // Bypass labels y updatedAt — textContent siempre (CA-XSS).
    const bp = document.getElementById('rm-bypass');
    if(bp) bp.textContent = (payload && Array.isArray(payload.bypassLabels) && payload.bypassLabels.length)
        ? payload.bypassLabels.join(', ')
        : '(ninguno)';
    const upd = document.getElementById('rm-updated');
    if(upd) upd.textContent = rm.updatedAt ? new Date(rm.updatedAt).toLocaleString('es-AR') : '—';
}

function syncStateFromServer(payload){
    if(!payload) return;
    const w = payload.window || {};
    const activeEl = document.getElementById('rm-active');
    if(activeEl) activeEl.checked = !!w.active;
    const tzEl = document.getElementById('rm-timezone');
    if(tzEl) tzEl.value = w.timezone || '';
    // Schema nuevo (CA-8.1): preferimos schedule:{} sobre window.start/end legacy.
    if(payload.schedule && typeof payload.schedule === 'object'){
        const next = makeEmptySchedule();
        for(const k of DAY_KEYS){
            if(Array.isArray(payload.schedule[k])){
                next[k] = payload.schedule[k].map(p => ({ start: String(p.start || ''), end: String(p.end || '') }));
            }
        }
        scheduleState = next;
    } else if(w.start && w.end && Array.isArray(w.days)){
        // Compat: legacy single-window mapeado al schema nuevo (un periodo por día activo).
        const next = makeEmptySchedule();
        for(const d of w.days){
            const dayKey = DOW_TO_DAY_KEY[d];
            if(dayKey) next[dayKey] = [{ start: w.start, end: w.end }];
        }
        scheduleState = next;
    } else {
        scheduleState = makeEmptySchedule();
    }
    bypassLabelsState = Array.isArray(payload.bypassLabels) ? payload.bypassLabels.slice() : bypassLabelsState;
    updatedAtState = w.updatedAt || updatedAtState;
    buildGrid();
}

function buildTimezoneList(){
    const list = document.getElementById('rm-tz-list');
    if(!list) return;
    let zones = TZ_DEFAULTS;
    try {
        if(typeof Intl.supportedValuesOf === 'function'){
            const all = Intl.supportedValuesOf('timeZone');
            if(Array.isArray(all) && all.length) zones = all;
        }
    } catch(e){}
    // FE-SEC-6: construir opciones con createElement + .value (no innerHTML).
    clearChildren(list);
    for(const z of zones){
        const opt = document.createElement('option');
        opt.value = String(z);
        list.appendChild(opt);
    }
}

function setMsg(text, kind){
    const el = document.getElementById('rm-msg');
    if(!el) return;
    el.textContent = text || '';
    el.classList.remove('rm-ok','rm-err');
    if(kind === 'ok') el.classList.add('rm-ok');
    if(kind === 'err') el.classList.add('rm-err');
}

async function fetchRestMode(){
    const r = await fetch('/api/rest-mode', {cache:'no-store'});
    if(!r.ok) return null;
    return r.json();
}

// CA-8.7 + FE-SEC-3: chequear data-rm-editing al inicio Y al final del morph.
// Si está activo en cualquiera de los dos, abortar el morph y descartar el fetch.
async function tickRestMode(){
    const grid = document.getElementById('rm-grid');
    if(grid && grid.getAttribute('data-rm-editing') === '1') return;
    const d = await fetchRestMode();
    if(!d || !d.ok) return;
    if(grid && grid.getAttribute('data-rm-editing') === '1') return;  // post-fetch re-check
    renderStatus(d);
    syncStateFromServer(d);
}

document.addEventListener('DOMContentLoaded', () => {
    buildTimezoneList();
    buildGrid();
    const form = document.getElementById('rm-form');
    if(form){
        form.addEventListener('submit', async (ev) => {
            ev.preventDefault();
            // FE-SEC-5: re-validamos antes del submit por si DevTools manipuló inputs.
            const v = validateScheduleClient(scheduleState);
            if(v.errors.length){
                setMsg('✗ Corrigí los ' + v.errors.length + ' error' + (v.errors.length === 1 ? '' : 'es') + ' antes de guardar.', 'err');
                return;
            }
            const payload = {
                active: document.getElementById('rm-active').checked,
                timezone: document.getElementById('rm-timezone').value || 'America/Argentina/Buenos_Aires',
                schedule: scheduleState,
                manual: true,
            };
            setMsg('Guardando…');
            try {
                const r = await fetch('/api/rest-mode', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload)});
                const j = await r.json();
                if(j.ok){
                    setMsg('✓ Guardado · hot-reload sin reinicio del pipeline.', 'ok');
                    tickRestMode();
                } else {
                    const errs = Array.isArray(j.errors) ? j.errors.join(' · ') : (j.msg || 'Error');
                    // textContent al setear el msg (FE-SEC-1).
                    setMsg('✗ ' + errs, 'err');
                }
            } catch(e){
                setMsg('✗ Error de red: ' + e.message, 'err');
            }
        });
    }
});

const POLLS = [{ fn: tickHeader, ms: 5000 }, { fn: tickRestMode, ms: 8000 }];
async function runAll(){ for(const p of POLLS){ try{ await p.fn(); } catch{} } }
runAll();
for(const p of POLLS){ setInterval(() => { p.fn().catch(()=>{}); }, p.ms); }`;
    return pageShell('Modo descanso', 'Calendario semanal · gating de skills LLM', body, script, css);
}

module.exports = {
    renderEquipo,
    renderPipeline,
    renderBloqueados,
    renderIssues,
    renderMatriz,
    renderOps,
    renderKpisDetail,
    renderHistorial,
    renderCostos,
    renderModoDescanso,
};
