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
    const body = `
<section class="in-section">
  <h2 class="in-section-title"><span class="in-section-title-icon">🔄</span>Pipeline · issues por fase</h2>
  <div id="pipeline-board" class="pl-board"></div>
</section>`;
    const css = `
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
.pl-card-paused-badge { display: inline-block; font-size: 9px; color: var(--in-warn); border: 1px solid var(--in-warn); border-radius: 3px; padding: 0 4px; margin-left: 4px; text-transform: uppercase; letter-spacing: 0.5px; }
.pl-card-rebote { display: inline-block; font-size: 9px; font-weight: 600; color: var(--in-bad); border: 1px solid var(--in-bad); background: var(--in-bad-soft); border-radius: 3px; padding: 0 4px; margin-top: 4px; cursor: help; }`;
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
            });
        }
    }
    const cmp = compareByPriority(orderMap);
    let html = '';
    for(const [key, col] of Object.entries(cols)){
        col.items.sort(cmp);
        const cards = col.items.slice(0, 12).map(i => {
            const prio = orderMap.has(String(i.issue)) ? '#' + (orderMap.get(String(i.issue)) + 1) : '';
            const pausedBadge = i.paused ? '<span class="pl-card-paused-badge">⏸ pausado</span>' : '';
            const reboteBadge = i.rebote
              ? '<div class="pl-card-rebote" title="Rechazado en ' + escapeHtml(i.rechazado_en_fase||'?') + (i.rechazado_skill_previo?'/'+escapeHtml(i.rechazado_skill_previo):'') + ': ' + escapeHtml((i.motivo_rechazo||'').replace(/"/g,"\\u0027").slice(0,400)) + '">↩ rebote' + (i.rebote_tipo?' · '+escapeHtml(i.rebote_tipo):'') + '</div>'
              : '';
            const pauseBtn = '<button class="pl-card-btn pause' + (i.paused?' paused':'') + '" data-issue="'+escapeHtml(i.issue)+'" data-action="' + (i.paused?'resume':'pause') + '" title="' + (i.paused?'Reanudar issue':'Pausar issue') + '">' + (i.paused?'▶':'⏸') + '</button>';
            return '<div class="pl-card pl-card-state-'+escapeHtml(i.estado||'')+'" data-issue="'+escapeHtml(i.issue)+'">'
              + '<div class="pl-card-head"><span class="pl-card-issue"><a href="https://github.com/intrale/platform/issues/'+escapeHtml(i.issue)+'" target="_blank" rel="noopener">#'+escapeHtml(i.issue)+'</a></span>'+pausedBadge+'<span class="pl-card-prio">'+prio+'</span></div>'
              + '<div class="pl-card-title" title="'+escapeHtml(i.title||'')+'">'+escapeHtml((i.title||'').slice(0,60))+'</div>'
              + reboteBadge
              + '<div class="pl-card-actions">'
              +   '<button class="pl-card-btn" data-issue="'+escapeHtml(i.issue)+'" data-action="move-top" title="Máxima prioridad">⏫</button>'
              +   '<button class="pl-card-btn" data-issue="'+escapeHtml(i.issue)+'" data-action="move-up" title="Subir">▲</button>'
              +   '<button class="pl-card-btn" data-issue="'+escapeHtml(i.issue)+'" data-action="move-down" title="Bajar">▼</button>'
              +   '<button class="pl-card-btn" data-issue="'+escapeHtml(i.issue)+'" data-action="move-bottom" title="Mínima prioridad">⏬</button>'
              +   pauseBtn
              + '</div>'
              + '</div>';
        }).join('');
        html += '<div class="pl-col"><div class="pl-col-head"><span>'+escapeHtml(key)+'</span><span class="pl-col-count">'+col.items.length+'</span></div>'+(cards || '<div class="in-empty" style="padding:14px 4px;font-size:11px">vacío</div>')+'</div>';
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
    }
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
.blk-prio { font-size: 11px; color: var(--in-fg-soft); font-variant-numeric: tabular-nums; min-width: 28px; }
.blk-prio.set { color: var(--in-fg-dim); font-weight: 600; }
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
                  <span class="blk-prio"></span>
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
        }
        const prioEl = row.querySelector('.blk-prio');
        if(b.priorityIndex != null){ prioEl.textContent = '#' + b.priorityIndex; prioEl.classList.add('set'); }
        else { prioEl.textContent = '—'; prioEl.classList.remove('set'); }
        row.querySelector('.blk-skill').textContent = b.skill || '';
        row.querySelector('.blk-reason').textContent = b.reason || b.question || 'sin razón';
        row.querySelector('.blk-fase').textContent = 'fase: ' + (b.phase || '');
        row.querySelector('.blk-since').textContent = 'desde: ' + (b.blocked_at ? new Date(b.blocked_at).toLocaleString('es-AR') : '—');
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
