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

async function tickHeader(){
    const d = await fetchJson('/api/dash/header');
    if(!d) return;
    setText('hdr-clock', new Date().toLocaleTimeString('es-AR'));
    const modePill = document.getElementById('hdr-mode');
    if(modePill){
        modePill.classList.remove('in-mode-running','in-mode-paused','in-mode-partial');
        if(d.mode==='paused'){ modePill.classList.add('in-mode-paused'); modePill.textContent='⏸ Pausado'; }
        else if(d.mode==='partial_pause'){ modePill.classList.add('in-mode-partial'); modePill.textContent='⏸ Parcial · '+d.allowedIssues.length+' issues'; }
        else { modePill.classList.add('in-mode-running'); modePill.textContent='🟢 Running'; }
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
    if(!confirm('¿Reactivar #'+issue+' (quitar label needs-human)?')) return;
    try{
        const r = await fetch('/api/needs-human/'+issue+'/reactivate', {method:'POST'});
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
    const body = `
<section class="in-section">
  <h2 class="in-section-title"><span class="in-section-title-icon">🔄</span>Pipeline · issues por fase</h2>
  <div id="pipeline-board" class="pl-board"></div>
</section>`;
    const css = `
.pl-board { display: flex; gap: 10px; overflow-x: auto; padding-bottom: 8px; }
.pl-col { min-width: 180px; flex: 1; background: var(--in-bg-3); border-radius: var(--in-radius-sm); padding: 10px; border: 1px solid var(--in-border); }
.pl-col-head { display: flex; align-items: center; justify-content: space-between; font-size: 11px; text-transform: uppercase; letter-spacing: 0.6px; color: var(--in-fg-dim); margin-bottom: 8px; padding-bottom: 6px; border-bottom: 1px solid var(--in-border); }
.pl-col-count { background: var(--in-bg); padding: 1px 8px; border-radius: 9px; font-size: 10px; color: var(--in-fg); }
.pl-card { display: block; background: var(--in-bg-2); border: 1px solid var(--in-border); border-radius: 6px; padding: 8px 10px; margin-bottom: 6px; font-size: 12px; transition: border-color 0.2s, background 0.2s; color: var(--in-fg); text-decoration: none; }
.pl-card:hover { border-color: var(--in-accent); background: var(--in-bg-3); }
.pl-card-issue { font-weight: 600; color: var(--in-info); }
.pl-card-title { font-size: 11px; color: var(--in-fg-dim); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.pl-card-state-trabajando { border-color: var(--in-accent); }
.pl-card-state-listo { border-color: var(--in-ok); }
.pl-card-state-pendiente { border-color: var(--in-fg-soft); }`;
    const script = `
async function tickPipeline(){
    const d = await fetchJson('/api/dash/pipeline');
    if(!d) return;
    const board = document.getElementById('pipeline-board');
    if(!board) return;
    const fases = d.fases || [];
    const matrix = d.matrix || {};
    const cols = {};
    for(const { pipeline: p, fase } of fases){
        const key = p+'/'+fase;
        cols[key] = { p, fase, items: [] };
    }
    for(const [issue, data] of Object.entries(matrix)){
        if(data.faseActual && cols[data.faseActual]){
            cols[data.faseActual].items.push({ issue, title: data.title, estado: data.estadoActual, bounces: data.bounces, staleMin: data.staleMin });
        }
    }
    let html = '';
    for(const [key, col] of Object.entries(cols)){
        col.items.sort((a,b) => (b.estado==='trabajando'?1:0) - (a.estado==='trabajando'?1:0));
        const cards = col.items.slice(0, 12).map(i => '<a href="https://github.com/intrale/platform/issues/'+escapeHtml(i.issue)+'" target="_blank" rel="noopener" class="pl-card pl-card-state-'+escapeHtml(i.estado||'')+'"><div class="pl-card-issue">#'+escapeHtml(i.issue)+'</div><div class="pl-card-title">'+escapeHtml((i.title||'').slice(0,40))+'</div></a>').join('');
        html += '<div class="pl-col"><div class="pl-col-head"><span>'+escapeHtml(key)+'</span><span class="pl-col-count">'+col.items.length+'</span></div>'+(cards || '<div class="in-empty" style="padding:14px 4px;font-size:11px">vacío</div>')+'</div>';
    }
    if(board.innerHTML !== html) board.innerHTML = html;
}
const POLLS = [{ fn: tickHeader, ms: 5000 }, { fn: tickPipeline, ms: 5000 }];
async function runAll(){ for(const p of POLLS){ try{ await p.fn(); } catch{} } }
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
.blk-issue { font-weight: 600; }
.blk-issue a { color: var(--in-info); }
.blk-issue a:hover { text-decoration: underline; }
.blk-reason { color: var(--in-fg-dim); font-size: 12px; }
.blk-meta { display: flex; gap: 14px; font-size: 11px; color: var(--in-fg-dim); margin-top: 4px; }
.blk-actions { display: flex; gap: 8px; margin-left: auto; }
.blk-btn { background: transparent; border: 1px solid; border-radius: 6px; padding: 5px 11px; font-size: 11px; cursor: pointer; transition: background 0.15s; font-weight: 500; }
.blk-btn-reactivate { border-color: var(--in-ok); color: var(--in-ok); }
.blk-btn-reactivate:hover { background: var(--in-ok-soft); }
.blk-btn-dismiss { border-color: var(--in-fg-soft); color: var(--in-fg-dim); }
.blk-btn-dismiss:hover { background: var(--in-bg); color: var(--in-fg); }`;
    const script = `
async function tickBloqueados(){
    const d = await fetchJson('/api/dash/bloqueados');
    if(!d) return;
    const c = document.getElementById('bloqueados-list');
    if(!c) return;
    const list = d.bloqueados || [];
    if(list.length === 0){ c.innerHTML = '<div class="in-empty"><div class="in-empty-strong">Sin issues bloqueados</div>Todo fluye</div>'; return; }
    const seen = new Set();
    for(const b of list){
        const key = String(b.issue);
        seen.add(key);
        let row = c.querySelector('[data-issue="'+key+'"]');
        if(!row){
            row = document.createElement('div');
            row.className = 'blk-row';
            row.dataset.issue = key;
            row.innerHTML = \`
                <div class="blk-head">
                  <div class="blk-issue"><a href="https://github.com/intrale/platform/issues/\${key}" target="_blank" rel="noopener">#\${key}</a> · <span class="blk-skill"></span></div>
                  <div class="blk-actions">
                    <button class="blk-btn blk-btn-reactivate" title="Quitar label needs-human y devolver a la cola">▶ Reactivar</button>
                    <button class="blk-btn blk-btn-dismiss" title="Cerrar el issue como desestimado">✕ Desestimar</button>
                  </div>
                </div>
                <div class="blk-reason"></div>
                <div class="blk-meta"><span class="blk-fase"></span><span class="blk-since"></span></div>
            \`;
            row.querySelector('.blk-btn-reactivate').addEventListener('click', () => nhReactivate(b.issue));
            row.querySelector('.blk-btn-dismiss').addEventListener('click', () => nhDismiss(b.issue));
            c.appendChild(row);
        }
        row.querySelector('.blk-skill').textContent = b.skill || '';
        row.querySelector('.blk-reason').textContent = b.reason || b.question || 'sin razón';
        row.querySelector('.blk-fase').textContent = 'fase: ' + (b.phase || '');
        row.querySelector('.blk-since').textContent = 'desde: ' + (b.blocked_at ? new Date(b.blocked_at).toLocaleString('es-AR') : '—');
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
.iss-row { display: grid; grid-template-columns: 80px 1fr 140px 90px 60px 80px; gap: 10px; padding: 10px 12px; border-bottom: 1px solid var(--in-border-soft); align-items: center; font-size: 13px; }
.iss-row:hover { background: var(--in-bg-3); }
.iss-issue { font-weight: 600; }
.iss-issue a { color: var(--in-info); }
.iss-issue a:hover { text-decoration: underline; }
.iss-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--in-fg-dim); }
.iss-fase { font-size: 11px; text-transform: uppercase; color: var(--in-fg-dim); }
.iss-state { font-size: 11px; }
.iss-state.trabajando { color: var(--in-accent); }
.iss-state.listo { color: var(--in-ok); }
.iss-bounces { text-align: right; color: var(--in-fg-dim); font-size: 11px; }
.iss-bounces.warn { color: var(--in-warn); }
.iss-actions { display: flex; gap: 4px; justify-content: flex-end; }
.iss-btn { background: transparent; border: 1px solid var(--in-border); color: var(--in-fg-dim); border-radius: 4px; width: 26px; height: 22px; font-size: 12px; cursor: pointer; padding: 0; line-height: 1; transition: background 0.12s, border-color 0.12s; }
.iss-btn:hover { background: var(--in-bg-3); border-color: var(--in-accent); color: var(--in-accent); }`;
    const script = `
let issuesData = null;
function renderIssuesTable(filter){
    const c = document.getElementById('issues-table');
    if(!c || !issuesData) return;
    const rows = Object.entries(issuesData.matrix||{});
    const f = (filter||'').toLowerCase();
    const filtered = f ? rows.filter(([id, data]) => id.includes(f) || (data.title||'').toLowerCase().includes(f)) : rows;
    setText('issues-count', filtered.length);
    if(filtered.length === 0){ c.innerHTML = '<div class="in-empty">Sin resultados</div>'; return; }
    let html = '';
    for(const [id, data] of filtered.slice(0, 200)){
        html += '<div class="iss-row"><div class="iss-issue"><a href="https://github.com/intrale/platform/issues/'+escapeHtml(id)+'" target="_blank" rel="noopener">#'+escapeHtml(id)+'</a></div><div class="iss-title">'+escapeHtml(data.title||'')+'</div><div class="iss-fase">'+escapeHtml(data.faseActual||'—')+'</div><div class="iss-state '+escapeHtml(data.estadoActual||'')+'">'+escapeHtml(data.estadoActual||'')+'</div><div class="iss-bounces '+(data.bounces>2?'warn':'')+'">'+(data.bounces||0)+'×</div><div class="iss-actions"><button class="iss-btn" data-issue="'+escapeHtml(id)+'" data-dir="move-up" title="Subir prioridad">▲</button><button class="iss-btn" data-issue="'+escapeHtml(id)+'" data-dir="move-down" title="Bajar prioridad">▼</button></div></div>';
    }
    c.innerHTML = html;
    c.querySelectorAll('.iss-btn').forEach(b => {
        b.addEventListener('click', () => moveIssue(b.dataset.issue, b.dataset.dir));
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
.mtx-table th, .mtx-table td { padding: 9px 11px; border: 1px solid var(--in-border); text-align: center; }
.mtx-table th { background: var(--in-bg-3); font-weight: 600; color: var(--in-fg-dim); text-transform: uppercase; font-size: 10px; letter-spacing: 0.6px; }
.mtx-table td.skill { text-align: left; font-weight: 500; background: var(--in-bg-3); }
.mtx-cell-0 { color: var(--in-fg-soft); }
.mtx-cell-active { background: var(--in-accent-soft); color: var(--in-accent); font-weight: 600; }`;
    const script = `
async function tickMatriz(){
    const d = await fetchJson('/api/dash/pipeline');
    if(!d) return;
    const c = document.getElementById('matriz-table');
    if(!c) return;
    const fases = d.fases || [];
    const matrix = d.matrix || {};
    const skills = new Set();
    const grid = {};
    for(const [issue, data] of Object.entries(matrix)){
        if(!data.faseActual) continue;
        const skill = data.estadoActual; // estadoActual is also stored
        // Use fase as key, build skill columns from concurrencia keys instead
    }
    const SKILL_LIST = Object.keys(SKILL_COLORS);
    for(const skill of SKILL_LIST) skills.add(skill);
    for(const skill of skills){
        grid[skill] = {};
        for(const { pipeline: p, fase } of fases){ grid[skill][p+'/'+fase] = 0; }
    }
    for(const [, data] of Object.entries(matrix)){
        // contar issues activos por fase, sin discriminar skill exacta del archivo (se necesitaría más data)
    }
    let html = '<table class="mtx-table"><thead><tr><th>Skill</th>';
    for(const { pipeline: p, fase } of fases){ html += '<th>'+escapeHtml(p[0]+':'+fase)+'</th>'; }
    html += '</tr></thead><tbody>';
    for(const skill of SKILL_LIST){
        html += '<tr><td class="skill">'+(SKILL_ICONS[skill]||'⚙')+' '+escapeHtml(skill)+'</td>';
        for(const { pipeline: p, fase } of fases){ html += '<td class="mtx-cell-0">·</td>'; }
        html += '</tr>';
    }
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
<section class="in-section">
  <h2 class="in-section-title"><span class="in-section-title-icon">🛠</span>Procesos del pipeline</h2>
  <div id="ops-procesos" class="ops-grid"></div>
</section>
<section class="in-section">
  <h2 class="in-section-title"><span class="in-section-title-icon">📡</span>QA Environment</h2>
  <pre id="ops-qaenv" class="ops-pre"></pre>
</section>`;
    const css = `
.ops-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 12px; }
.ops-card { background: var(--in-bg-3); padding: 12px 14px; border-radius: var(--in-radius-sm); border: 1px solid var(--in-border); display: flex; flex-direction: column; gap: 4px; }
.ops-card.alive { border-color: var(--in-ok); }
.ops-card.dead { border-color: var(--in-bad); opacity: 0.7; }
.ops-card-name { font-weight: 600; }
.ops-card-meta { font-size: 11px; color: var(--in-fg-dim); font-family: var(--in-mono); }
.ops-pre { background: var(--in-bg-3); padding: 14px; border-radius: var(--in-radius-sm); font-family: var(--in-mono); font-size: 11px; overflow: auto; max-height: 280px; border: 1px solid var(--in-border); }`;
    const script = `
async function tickOps(){
    const d = await fetchJson('/api/dash/ops');
    if(!d) return;
    const grid = document.getElementById('ops-procesos');
    if(grid){
        let html = '';
        for(const [name, p] of Object.entries(d.procesos || {})){
            const cls = p.alive ? 'alive' : 'dead';
            html += '<div class="ops-card '+cls+'"><div class="ops-card-name">'+(p.alive?'🟢':'🔴')+' '+escapeHtml(name)+'</div><div class="ops-card-meta">PID '+(p.pid||'—')+'</div><div class="ops-card-meta">uptime '+fmtDur(p.uptime||0)+'</div></div>';
        }
        if(grid.innerHTML !== html) grid.innerHTML = html;
    }
    const pre = document.getElementById('ops-qaenv');
    if(pre){
        const txt = JSON.stringify({ qaEnv: d.qaEnv, qaRemote: d.qaRemote, infraHealth: d.infraHealth }, null, 2);
        if(pre.textContent !== txt) pre.textContent = txt;
    }
}
const POLLS = [{ fn: tickHeader, ms: 5000 }, { fn: tickOps, ms: 5000 }];
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
        const tiles = [
            { label: 'PRs · 7d', value: d.prsLast7d==null?'—':d.prsLast7d, sub: 'mergeados' },
            { label: 'Tokens · 24h', value: fmtNum(d.tokens24h), sub: 'in + out' },
            { label: 'Cycle time', value: fmtDur(d.cycleTimeMs), sub: 'mediana' },
            { label: '% rebote', value: fmtPct(d.bouncePct), sub: 'rechazos / total' },
        ];
        let html = '';
        for(const t of tiles) html += '<div class="kp-tile"><div class="kp-tile-label">'+escapeHtml(t.label)+'</div><div class="kp-tile-value">'+escapeHtml(t.value)+'</div><div class="kp-tile-sub">'+escapeHtml(t.sub)+'</div></div>';
        if(grid.innerHTML !== html) grid.innerHTML = html;
    }
    const snap = await fetchJson('/api/metrics?window=24h').catch(()=>null);
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
.kp-pre { background: var(--in-bg-3); padding: 14px; border-radius: var(--in-radius-sm); font-family: var(--in-mono); font-size: 11px; overflow: auto; max-height: 500px; border: 1px solid var(--in-border); }`;
    const script = `
async function tickCostos(){
    const snap = await fetchJson('/api/metrics?window=24h');
    const grid = document.getElementById('costos-grid');
    const detail = document.getElementById('costos-detail');
    if(!snap || !snap.totals){
        if(grid) grid.innerHTML = '<div class="in-empty">Aggregator V3 sin datos</div>';
        if(detail) detail.textContent = '—';
        return;
    }
    const t = snap.totals;
    const tiles = [
        { label: 'Tokens input', value: fmtNum(t.tokensInput) },
        { label: 'Tokens output', value: fmtNum(t.tokensOutput) },
        { label: 'Costo USD', value: '$'+(t.costUsd||0).toFixed(2) },
        { label: 'Runs', value: fmtNum(t.runs) },
    ];
    let html = '';
    for(const ti of tiles) html += '<div class="kp-tile"><div class="kp-tile-label">'+escapeHtml(ti.label)+'</div><div class="kp-tile-value">'+escapeHtml(ti.value)+'</div></div>';
    if(grid && grid.innerHTML !== html) grid.innerHTML = html;
    if(detail){
        const txt = JSON.stringify(snap.bySkill || snap.byAgent || {}, null, 2);
        if(detail.textContent !== txt) detail.textContent = txt;
    }
}
const POLLS = [{ fn: tickHeader, ms: 5000 }, { fn: tickCostos, ms: 60000 }];
async function runAll(){ for(const p of POLLS){ try{ await p.fn(); } catch{} } }
runAll();
for(const p of POLLS){ setInterval(() => { p.fn().catch(()=>{}); }, p.ms); }`;
    return pageShell('Costos', 'Tokens y consumo', body, script, css);
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
};
