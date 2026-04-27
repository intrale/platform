// V3 Home — render del HTML inicial del dashboard kiosk vertical 1080×1920.
// El layout y los textos se imprimen una sola vez. El refresh es client-side
// vía fetch JSON + DOM morphing manual (sin reemplazar containers, evita flicker).

'use strict';

const fs = require('fs');
const path = require('path');

const THEME_CSS_PATH = path.join(__dirname, 'theme.css');

function loadTheme() {
    try { return fs.readFileSync(THEME_CSS_PATH, 'utf8'); }
    catch { return ''; }
}

function homeStyles() {
    return `
.kiosk-frame {
    width: 1080px;
    min-height: 1920px;
    margin: 0 auto;
    display: flex;
    flex-direction: column;
}
.kiosk-body {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 16px;
    padding: 16px 22px;
}

/* KPI grid */
.kpi-grid {
    display: grid;
    grid-template-columns: repeat(5, 1fr);
    gap: 12px;
}
.kpi-card {
    background: var(--in-bg-2);
    border: 1px solid var(--in-border);
    border-radius: var(--in-radius);
    padding: 18px 16px;
    display: flex;
    flex-direction: column;
    gap: 4px;
    box-shadow: var(--in-shadow);
}
.kpi-icon { font-size: 18px; opacity: 0.85; }
.kpi-label {
    font-size: 11px;
    text-transform: uppercase;
    color: var(--in-fg-dim);
    letter-spacing: 0.8px;
}
.kpi-value {
    font-size: 36px;
    font-weight: 700;
    color: var(--in-fg);
    transition: color 0.3s;
    font-variant-numeric: tabular-nums;
}
.kpi-sub {
    font-size: 11px;
    color: var(--in-fg-dim);
}
.kpi-card.kpi-warn .kpi-value { color: var(--in-warn); }
.kpi-card.kpi-bad .kpi-value { color: var(--in-bad); }
.kpi-card.kpi-ok .kpi-value { color: var(--in-ok); }
.kpi-bar { margin-top: 6px; }

/* Active section */
.active-section {
    background: linear-gradient(180deg, rgba(46,230,193,0.05), transparent 80%), var(--in-bg-2);
    border: 1px solid var(--in-border);
    border-radius: var(--in-radius);
    padding: 18px 22px;
    box-shadow: var(--in-shadow);
}
.active-list {
    display: flex;
    flex-direction: column;
    gap: 10px;
}
.active-card {
    display: grid;
    grid-template-columns: 38px 1fr auto;
    align-items: center;
    gap: 14px;
    padding: 14px 16px;
    background: var(--in-bg-3);
    border: 1px solid var(--in-border);
    border-radius: var(--in-radius-sm);
    transition: opacity 0.3s, transform 0.3s;
}
.active-card.entering { opacity: 0; transform: translateY(-6px); }
.active-card.leaving { opacity: 0; transform: translateY(6px); }
.active-card-skill {
    grid-row: 1 / span 2;
    width: 38px; height: 38px;
    border-radius: 10px;
    display: flex; align-items: center; justify-content: center;
    font-size: 18px;
    color: #fff;
}
.active-card-meta {
    display: flex;
    align-items: baseline;
    gap: 10px;
    flex-wrap: wrap;
}
.active-card-issue {
    font-weight: 600;
    color: var(--in-fg);
    font-size: 14px;
}
.active-card-fase {
    font-size: 11px;
    color: var(--in-fg-dim);
    text-transform: uppercase;
    letter-spacing: 0.6px;
}
.active-card-title {
    font-size: 12px;
    color: var(--in-fg-dim);
    grid-column: 2 / span 1;
    grid-row: 2;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 580px;
}
.active-card-time {
    grid-column: 3;
    grid-row: 1;
    text-align: right;
    font-family: var(--in-mono);
    font-size: 13px;
    color: var(--in-accent);
    font-variant-numeric: tabular-nums;
}
.active-card-kill {
    grid-column: 3;
    grid-row: 2;
    justify-self: end;
    background: transparent;
    border: 1px solid var(--in-bad);
    color: var(--in-bad);
    border-radius: 6px;
    padding: 2px 9px;
    font-size: 11px;
    cursor: pointer;
    transition: background 0.15s;
}
.active-card-kill:hover { background: var(--in-bad-soft); }
.active-card-progress {
    grid-column: 1 / -1;
    margin-top: 4px;
}

.active-empty {
    text-align: center;
    padding: 40px 16px;
    color: var(--in-fg-dim);
}
.active-empty-icon { font-size: 32px; margin-bottom: 10px; }
.active-empty-msg { font-size: 13px; }

/* Recent / queue rows */
.line-list {
    display: flex; flex-direction: column;
    gap: 4px;
}
.line-row {
    display: grid;
    grid-template-columns: 22px 70px 1fr auto auto auto;
    align-items: center;
    gap: 8px;
    padding: 7px 12px;
    border-radius: var(--in-radius-sm);
    background: var(--in-bg-3);
    transition: background 0.15s;
}
.line-row:hover { background: var(--in-bg); }
.line-icon { font-size: 14px; }
.line-skill {
    font-size: 11px;
    color: var(--in-fg-dim);
    text-transform: uppercase;
    letter-spacing: 0.5px;
}
.line-issue {
    font-weight: 500;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
.line-issue a { color: var(--in-info); }
.line-issue a:hover { text-decoration: underline; }
.line-fase {
    font-size: 11px;
    color: var(--in-fg-dim);
    text-transform: uppercase;
}
.line-time {
    font-family: var(--in-mono);
    font-size: 12px;
    color: var(--in-fg-dim);
    font-variant-numeric: tabular-nums;
}
.line-actions {
    display: flex;
    gap: 4px;
    justify-self: end;
}
.line-btn {
    background: transparent;
    border: 1px solid var(--in-border);
    color: var(--in-fg-dim);
    border-radius: 4px;
    width: 24px; height: 22px;
    font-size: 11px;
    cursor: pointer;
    padding: 0;
    line-height: 1;
    transition: background 0.12s, border-color 0.12s, color 0.12s;
    text-decoration: none;
    display: inline-flex;
    align-items: center;
    justify-content: center;
}
.line-btn:hover { background: var(--in-bg-3); border-color: var(--in-accent); color: var(--in-accent); }

/* Áreas — botonera horizontal compacta con badges de conteo */
.areas-bar {
    display: grid;
    grid-template-columns: repeat(9, 1fr);
    gap: 8px;
}
.area-pill {
    background: var(--in-bg-2);
    border: 1px solid var(--in-border);
    border-radius: var(--in-radius-sm);
    padding: 10px 8px;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 3px;
    transition: transform 0.15s, border-color 0.15s, background 0.15s;
    cursor: pointer;
    position: relative;
    text-decoration: none;
    color: var(--in-fg);
    min-height: 64px;
}
.area-pill:hover {
    transform: translateY(-2px);
    border-color: var(--in-accent);
    background: var(--in-bg-3);
}
.area-pill-icon { font-size: 18px; line-height: 1; }
.area-pill-name {
    font-size: 11px;
    font-weight: 600;
    color: var(--in-fg);
    letter-spacing: 0.2px;
}
.area-pill-badge {
    position: absolute;
    top: 6px; right: 6px;
    background: var(--in-brand);
    color: #fff;
    font-size: 10px;
    font-weight: 700;
    border-radius: 10px;
    padding: 1px 6px;
    min-width: 18px;
    text-align: center;
    line-height: 1.4;
}
.area-pill-badge-warn { background: var(--in-warn); }
.area-pill-badge-bad { background: var(--in-bad); }
.area-pill-badge-zero { background: var(--in-bg-3); color: var(--in-fg-soft); border: 1px solid var(--in-border); }

/* Mode pill in header */
.in-mode-running { color: var(--in-ok); border-color: var(--in-ok); background: var(--in-ok-soft); }
.in-mode-paused { color: var(--in-bad); border-color: var(--in-bad); background: var(--in-bad-soft); }
.in-mode-partial { color: var(--in-warn); border-color: var(--in-warn); background: var(--in-warn-soft); }

/* Mode pill — clickeable con dropdown */
.in-pill[data-mode-toggle] { cursor: pointer; user-select: none; position: relative; }
.in-pill[data-mode-toggle]:hover { filter: brightness(1.15); }
.in-pill[data-mode-toggle]::after { content: " ▾"; opacity: 0.6; font-size: 10px; }

.in-mode-menu {
    position: absolute;
    top: calc(100% + 6px);
    right: 0;
    z-index: 100;
    background: var(--in-bg-2);
    border: 1px solid var(--in-border);
    border-radius: var(--in-radius-sm);
    box-shadow: var(--in-shadow);
    min-width: 220px;
    padding: 6px;
    display: none;
}
.in-mode-menu.open { display: block; }
.in-mode-menu-item {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    border-radius: 6px;
    cursor: pointer;
    font-size: 13px;
    color: var(--in-fg);
    transition: background 0.12s;
    border: none;
    background: transparent;
    width: 100%;
    text-align: left;
}
.in-mode-menu-item:hover { background: var(--in-bg-3); }
.in-mode-menu-item.active { background: var(--in-brand-soft); color: var(--in-fg); font-weight: 600; }
.in-mode-menu-item-icon { width: 18px; text-align: center; }
.in-mode-menu-divider { height: 1px; background: var(--in-border); margin: 4px 0; }
.in-mode-menu-input {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 8px 12px;
}
.in-mode-menu-input label { font-size: 11px; color: var(--in-fg-dim); }
.in-mode-menu-input input {
    width: 100%;
    padding: 6px 8px;
    background: var(--in-bg);
    color: var(--in-fg);
    border: 1px solid var(--in-border);
    border-radius: 4px;
    font-family: var(--in-mono);
    font-size: 12px;
    box-sizing: border-box;
}
.in-mode-menu-input input:focus { outline: none; border-color: var(--in-accent); }
.in-mode-menu-input button {
    padding: 6px 10px;
    background: var(--in-warn-soft);
    color: var(--in-warn);
    border: 1px solid var(--in-warn);
    border-radius: 4px;
    font-size: 12px;
    cursor: pointer;
    font-weight: 500;
}
.in-mode-menu-input button:hover { background: var(--in-warn); color: var(--in-bg); }
`;
}

const SKILL_ICONS = {
    'android-dev': '📱', 'backend-dev': '⚡', 'web-dev': '🌐', 'pipeline-dev': '🔧',
    ux: '🎨', po: '📋', planner: '📐',
    guru: '🧙', security: '🔒', tester: '🧪', qa: '✅', review: '👁',
    linter: '🧹', build: '🛠', delivery: '🚚', commander: '🎖',
};
const SKILL_COLORS = {
    'android-dev': '#58a6ff', 'backend-dev': '#3fb950', 'web-dev': '#79c0ff', 'pipeline-dev': '#a371f7',
    ux: '#f778ba', po: '#d29922', planner: '#a371f7',
    guru: '#58a6ff', security: '#f85149', tester: '#d2a8ff', qa: '#3fb950', review: '#ffa657',
    linter: '#8b949e', build: '#ffa657', delivery: '#2ee6c1', commander: '#f778ba',
};

const AREAS = [
    { key: 'equipo', label: 'Equipo', icon: '👥', sub: 'Agentes y carga', href: '/equipo' },
    { key: 'pipeline', label: 'Pipeline', icon: '🔄', sub: 'Issues por fase', href: '/pipeline' },
    { key: 'bloqueados', label: 'Bloqueados', icon: '🚧', sub: 'Esperando humano', href: '/bloqueados' },
    { key: 'issues', label: 'Issues', icon: '📋', sub: 'Backlog completo', href: '/issues' },
    { key: 'matriz', label: 'Matriz', icon: '📈', sub: 'Skill × Fase', href: '/matriz' },
    { key: 'ops', label: 'Ops', icon: '🛠', sub: 'Procesos e infra', href: '/ops' },
    { key: 'kpis', label: 'KPIs', icon: '📊', sub: 'Métricas detalladas', href: '/kpis' },
    { key: 'historial', label: 'Historial', icon: '📜', sub: 'Actividad reciente', href: '/historial' },
    { key: 'costos', label: 'Costos', icon: '💰', sub: 'Tokens y consumo', href: '/costos' },
];

function renderClientScript() {
    return `
const SKILL_ICONS = ${JSON.stringify(SKILL_ICONS)};
const SKILL_COLORS = ${JSON.stringify(SKILL_COLORS)};

function fmtDur(ms){ if(!ms||ms<0) return '—'; const s=Math.round(ms/1000); if(s<60) return s+'s'; const m=Math.floor(s/60), r=s%60; if(m<60) return m+'m '+r+'s'; const h=Math.floor(m/60), rm=m%60; return h+'h '+rm+'m'; }
function fmtNum(n){ if(n==null||isNaN(n)) return '—'; if(n>=1e6) return (n/1e6).toFixed(1)+'M'; if(n>=1e3) return (n/1e3).toFixed(1)+'k'; return String(n); }
function fmtPct(n){ return n==null?'—':n.toFixed(1)+'%'; }
function setText(id, value){ const el=document.getElementById(id); if(el && el.textContent!==String(value)) el.textContent=value; }
function setClass(id, cls, on){ const el=document.getElementById(id); if(el) el.classList.toggle(cls, !!on); }
function fetchJson(url){ return fetch(url, {cache:'no-store'}).then(r => r.ok ? r.json() : null).catch(()=>null); }

function showToast(msg, ok){
    let t = document.getElementById('in-toast');
    if(!t){
        t = document.createElement('div');
        t.id = 'in-toast';
        t.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);padding:12px 22px;border-radius:8px;font-size:13px;font-weight:500;z-index:9999;box-shadow:0 6px 24px rgba(0,0,0,0.4);transition:opacity 0.3s;opacity:0;color:#fff';
        document.body.appendChild(t);
    }
    t.textContent = msg;
    t.style.background = ok===false ? 'var(--in-bad)' : (ok===true ? 'var(--in-ok)' : 'var(--in-brand)');
    t.style.opacity = '1';
    clearTimeout(t._timeout);
    t._timeout = setTimeout(() => { t.style.opacity = '0'; }, 3500);
}

async function killAgent(issue, skill, pipeline, fase){
    if(!confirm('¿Cancelar agente '+skill+' en #'+issue+'?')) return;
    try{
        const r = await fetch('/api/kill-agent', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({issue, skill, pipeline, fase})});
        const j = await r.json();
        showToast(j.msg || (j.ok?'Agente cancelado':'Falló'), j.ok);
        setTimeout(() => tickActive().catch(()=>{}), 600);
    } catch(e){ showToast('Error: '+e.message, false); }
}

async function tickHeader(){
    const d = await fetchJson('/api/dash/header');
    if(!d) return;
    const now = new Date();
    setText('hdr-clock', now.toLocaleTimeString('es-AR'));
    const modePill = document.getElementById('hdr-mode');
    if(modePill){
        modePill.classList.remove('in-mode-running','in-mode-paused','in-mode-partial');
        // El menú vive como child de la pill — preservarlo entre updates de texto.
        const menu = document.getElementById('hdr-mode-menu');
        let label = '🟢 Running';
        if(d.mode==='paused'){ modePill.classList.add('in-mode-paused'); label = '⏸ Pausado'; }
        else if(d.mode==='partial_pause'){ modePill.classList.add('in-mode-partial'); label = '⏸ Parcial · '+d.allowedIssues.length+' issues'; }
        else { modePill.classList.add('in-mode-running'); }
        // Buscar/crear el span de label que NO afecte el menú children.
        let labelSpan = modePill.querySelector('.in-mode-label');
        if(!labelSpan){
            labelSpan = document.createElement('span');
            labelSpan.className = 'in-mode-label';
            modePill.insertBefore(labelSpan, modePill.firstChild);
        }
        if(labelSpan.textContent !== label) labelSpan.textContent = label;
        // Marcar item activo en el menú
        if(menu){
            menu.querySelectorAll('.in-mode-menu-item').forEach(it => {
                const a = it.dataset.modeAction;
                const isActive = (a === 'resume' && d.mode === 'running') || (a === 'pause' && d.mode === 'paused');
                it.classList.toggle('active', isActive);
            });
        }
    }
    bindModeToggle();
    const pulpoPill = document.getElementById('hdr-pulpo');
    if(pulpoPill){
        pulpoPill.classList.remove('in-pill-ok','in-pill-bad');
        pulpoPill.classList.add(d.pulpoAlive ? 'in-pill-ok' : 'in-pill-bad');
        pulpoPill.textContent = (d.pulpoAlive ? '🟢' : '🔴') + ' Pulpo · '+fmtDur(d.pulpoUptimeMs);
    }
    // Badges de la botonera de áreas (counts vienen en el header slice).
    const counts = d.counts || {};
    for(const [area, count] of Object.entries(counts)){
        const badge = document.getElementById('badge-'+area);
        if(!badge) continue;
        badge.textContent = count;
        badge.classList.remove('area-pill-badge-warn','area-pill-badge-bad','area-pill-badge-zero');
        if(count === 0) badge.classList.add('area-pill-badge-zero');
        else if(area === 'bloqueados' && count > 0) badge.classList.add('area-pill-badge-bad');
    }
}

async function tickKpis(){
    const d = await fetchJson('/api/dash/kpis');
    if(!d) return;
    setText('kpi-prs-value', d.prsLast7d==null?'—':d.prsLast7d);
    setText('kpi-tokens-value', fmtNum(d.tokens24h));
    setText('kpi-cycle-value', fmtDur(d.cycleTimeMs));
    const bp = d.bouncePct;
    setText('kpi-bounce-value', fmtPct(bp));
    const bcard = document.getElementById('kpi-bounce');
    if(bcard){
        bcard.classList.remove('kpi-ok','kpi-warn','kpi-bad');
        if(bp!=null){ if(bp>30) bcard.classList.add('kpi-bad'); else if(bp>15) bcard.classList.add('kpi-warn'); else bcard.classList.add('kpi-ok'); }
    }
}

async function tickQuota(){
    const d = await fetchJson('/api/dash/quota');
    if(!d) return;
    const card = document.getElementById('kpi-quota');
    if(!card) return;
    setText('kpi-quota-value', d.pct != null ? d.pct.toFixed(1)+'%' : '—');
    const used = d.hoursUsed7d != null ? d.hoursUsed7d.toFixed(1)+'h' : '—';
    const limit = d.effectiveLimitHours != null ? d.effectiveLimitHours+'h' : '—';
    setText('kpi-quota-sub', used+' / '+limit+' (Max)');
    card.classList.remove('kpi-ok','kpi-warn','kpi-bad');
    if(d.status === 'critical') card.classList.add('kpi-bad');
    else if(d.status === 'warning') card.classList.add('kpi-warn');
    else if(d.status === 'normal') card.classList.add('kpi-ok');
    // Tooltip detallado con info de auto-ajuste
    const adj = d.adjustmentsCount > 0 ? ' · '+d.adjustmentsCount+' auto-ajustes' : '';
    const days = d.daysToLimit != null ? '~'+d.daysToLimit+'d al límite' : 'sin proyección';
    card.title = used+' usadas en 7d · '+d.pct.toFixed(1)+'% de '+limit+' estimado'+adj+'. Burn rate '+d.burnRatePerDay+'h/d, '+days+'.';
}

async function tickActive(){
    const d = await fetchJson('/api/dash/active');
    if(!d) return;
    const list = document.getElementById('active-list');
    const empty = document.getElementById('active-empty');
    if(!list) return;
    // Mostrar TODOS los agentes activos (no limitar a 3) — antes había
    // inconsistencia entre /equipo (que mostraba todos) y home (capeado a 3),
    // confundía al operador. Si hay overflow visual en kiosk, lo manejamos
    // con el container que es flex-column (crece naturalmente).
    const arr = (d.agents || []);
    const totalRunning = d.totalRunning || 0;
    setText('active-count', totalRunning > 0 ? (totalRunning + ' activo' + (totalRunning===1?'':'s')) : '0');
    if(arr.length === 0){
        list.style.display = 'none';
        if(empty) empty.style.display = 'block';
        return;
    }
    list.style.display = 'flex';
    if(empty) empty.style.display = 'none';

    const seen = new Set();
    for(const a of arr){
        const key = a.issue + '-' + a.skill + '-' + a.fase;
        seen.add(key);
        let card = list.querySelector('[data-key="'+key+'"]');
        if(!card){
            card = document.createElement('div');
            card.className = 'active-card entering';
            card.dataset.key = key;
            card.innerHTML = \`
                <div class="active-card-skill"></div>
                <div class="active-card-meta">
                    <span class="active-card-issue"></span>
                    <span class="active-card-fase"></span>
                </div>
                <div class="active-card-time"></div>
                <button class="active-card-kill" title="Cancelar este agente">✕</button>
                <div class="active-card-title"></div>
                <div class="active-card-progress"><div class="in-bar"><span></span></div></div>
            \`;
            card.querySelector('.active-card-kill').addEventListener('click', () => killAgent(a.issue, a.skill, a.pipeline, a.fase));
            list.appendChild(card);
            requestAnimationFrame(() => card.classList.remove('entering'));
        }
        const skillBadge = card.querySelector('.active-card-skill');
        skillBadge.style.background = SKILL_COLORS[a.skill] || '#8b949e';
        skillBadge.textContent = SKILL_ICONS[a.skill] || '⚙';
        const issueEl = card.querySelector('.active-card-issue');
        const issueText = '#'+a.issue+' · '+a.skill;
        if(issueEl.textContent !== issueText){
            if(a.hasLog){
                issueEl.innerHTML = '<a class="in-link" href="/logs/view/'+a.logFile+'?live=1" target="_blank" rel="noopener">'+issueText+' ↗</a>';
            } else {
                issueEl.textContent = issueText;
            }
        }
        setText(card.querySelector('.active-card-fase')._id || '', a.fase);
        card.querySelector('.active-card-fase').textContent = a.fase;
        card.querySelector('.active-card-title').textContent = a.title || '';
        card.querySelector('.active-card-time').textContent = fmtDur(a.durationMs);
        const bar = card.querySelector('.in-bar > span');
        const pct = a.etaMs && a.etaMs > 0 ? Math.min(100, Math.round((a.durationMs / a.etaMs) * 100)) : 4;
        bar.style.width = pct + '%';
    }
    for(const card of [...list.children]){
        if(!seen.has(card.dataset.key)){
            card.classList.add('leaving');
            setTimeout(() => card.remove(), 300);
        }
    }
}

function renderLineRow(a, isQueue){
    const icon = isQueue ? (a.slotFree ? '→' : '⏸') : (a.resultado === 'aprobado' ? '✓' : a.resultado === 'rechazado' ? '✗' : '·');
    const time = isQueue
        ? (a.slotFree ? 'libre · '+a.slotInfo : '⏸ '+a.slotInfo)
        : fmtDur(a.durationMs);
    const titleAttr = a.title ? ' title="'+a.title.replace(/"/g,'&quot;')+'"' : '';
    const titleText = a.title ? ' · '+a.title.slice(0, 50) : '';
    const ghLink = '<a class="line-btn" href="https://github.com/intrale/platform/issues/'+a.issue+'" target="_blank" rel="noopener" title="Abrir issue en GitHub">↗</a>';
    let actions = '';
    if(isQueue){
        actions = ''
          + '<button class="line-btn" data-issue="'+a.issue+'" data-action="move-top" title="Máxima prioridad">⏫</button>'
          + '<button class="line-btn" data-issue="'+a.issue+'" data-action="move-up" title="Subir prioridad">▲</button>'
          + '<button class="line-btn" data-issue="'+a.issue+'" data-action="move-down" title="Bajar prioridad">▼</button>'
          + '<button class="line-btn" data-issue="'+a.issue+'" data-action="move-bottom" title="Mínima prioridad">⏬</button>'
          + '<button class="line-btn" data-issue="'+a.issue+'" data-action="pause" title="Pausar issue (label blocked:dependencies)">⏸</button>'
          + ghLink;
    } else {
        const logBtn = a.hasLog ? '<a class="line-btn" href="/logs/view/'+(a.logFile||'')+'" target="_blank" rel="noopener" title="Ver log">📄</a>' : '';
        actions = logBtn+ghLink;
    }
    return \`
        <div class="line-row" data-key="\${a.issue}-\${a.skill}-\${a.fase}"\${titleAttr}>
          <span class="line-icon">\${icon}</span>
          <span class="line-skill">\${a.skill}</span>
          <span class="line-issue"><a href="https://github.com/intrale/platform/issues/\${a.issue}" target="_blank" rel="noopener">#\${a.issue}</a>\${titleText}</span>
          <span class="line-fase">\${a.fase}</span>
          <span class="line-time">\${time}</span>
          <span class="line-actions">\${actions}</span>
        </div>\`;
}

function bindLineActions(container){
    container.querySelectorAll('.line-btn[data-action]').forEach(b => {
        if(b.dataset._bound) return;
        b.dataset._bound = '1';
        b.addEventListener('click', () => {
            const action = b.dataset.action;
            if(action === 'pause') return pauseIssueHome(b.dataset.issue);
            return moveIssue(b.dataset.issue, action);
        });
    });
}

async function tickRecent(){
    const d = await fetchJson('/api/dash/recent');
    if(!d) return;
    const container = document.getElementById('recent-list');
    if(!container) return;
    const arr = (d.recent || []).slice(0, 5);
    if(arr.length === 0){ container.innerHTML = '<div class="in-empty">Sin actividad reciente</div>'; return; }
    const seen = new Set();
    for(const a of arr){
        const key = a.issue+'-'+a.skill+'-'+a.fase;
        seen.add(key);
        const existing = container.querySelector('[data-key="'+key+'"]');
        if(!existing){
            const tmp = document.createElement('div');
            tmp.innerHTML = renderLineRow(a, false);
            container.prepend(tmp.firstElementChild);
        }
    }
    for(const row of [...container.querySelectorAll('.line-row')]){
        if(!seen.has(row.dataset.key)) row.remove();
    }
    bindLineActions(container);
}

async function tickQueue(){
    const d = await fetchJson('/api/dash/queue');
    if(!d) return;
    const container = document.getElementById('queue-list');
    if(!container) return;
    const arr = (d.queue || []).slice(0, 5);
    if(arr.length === 0){ container.innerHTML = '<div class="in-empty">Cola vacía</div>'; return; }
    const seen = new Set();
    for(const a of arr){
        const key = a.issue+'-'+a.skill+'-'+a.fase;
        seen.add(key);
        let row = container.querySelector('[data-key="'+key+'"]');
        if(!row){
            const tmp = document.createElement('div');
            tmp.innerHTML = renderLineRow(a, true);
            row = tmp.firstElementChild;
            container.appendChild(row);
        } else {
            const timeEl = row.querySelector('.line-time');
            const newTime = a.slotFree ? 'libre · '+a.slotInfo : '⏸ '+a.slotInfo;
            if(timeEl.textContent !== newTime) timeEl.textContent = newTime;
        }
    }
    for(const row of [...container.querySelectorAll('.line-row')]){
        if(!seen.has(row.dataset.key)) row.remove();
    }
    bindLineActions(container);
}

async function moveIssue(issue, direction){
    try{
        const r = await fetch('/api/issue/'+issue+'/'+direction, {method:'POST'});
        const j = await r.json();
        showToast(j.msg || (j.ok?'Movido':'Falló'), j.ok);
        setTimeout(() => tickQueue().catch(()=>{}), 400);
    } catch(e){ showToast('Error: '+e.message, false); }
}

// ─── Mode toggle (running / paused / partial_pause) ───
function bindModeToggle(){
    const pill = document.getElementById('hdr-mode');
    const menu = document.getElementById('hdr-mode-menu');
    if(!pill || !menu || pill.dataset._bound) return;
    pill.dataset._bound = '1';
    pill.addEventListener('click', (ev) => {
        const target = ev.target;
        // Click en input/button del menú: dejar burbujear al handler propio
        if(target.closest('.in-mode-menu-input') || target.closest('[data-mode-action]')) return;
        ev.stopPropagation();
        menu.classList.toggle('open');
        menu.setAttribute('aria-hidden', menu.classList.contains('open') ? 'false' : 'true');
    });
    document.addEventListener('click', (ev) => {
        if(!pill.contains(ev.target)) menu.classList.remove('open');
    });
    menu.querySelectorAll('[data-mode-action]').forEach(b => {
        b.addEventListener('click', async (ev) => {
            ev.stopPropagation();
            const action = b.dataset.modeAction;
            try {
                if(action === 'resume'){
                    const r = await fetch('/api/pause', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({action:'resume'})});
                    const j = await r.json();
                    showToast(j.msg || 'Pipeline reanudado', j.ok);
                } else if(action === 'pause'){
                    if(!confirm('¿Pausar TODO el pipeline? Se detendrán todos los lanzamientos hasta que reanudes.')) return;
                    const r = await fetch('/api/pause', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({action:'pause'})});
                    const j = await r.json();
                    showToast(j.msg || 'Pipeline pausado', j.ok);
                } else if(action === 'partial'){
                    const input = document.getElementById('hdr-mode-partial-input');
                    const raw = (input.value || '').trim();
                    if(!raw){ showToast('Ingresá al menos 1 issue (ej: 2505, 2519)', false); return; }
                    const issues = raw.split(/[,\s]+/).map(s => Number(s.replace(/^#/, '').trim())).filter(n => Number.isInteger(n) && n > 0);
                    if(issues.length === 0){ showToast('Ningún número de issue válido en el input', false); return; }
                    const lista = issues.map(n => '#'+n).join(', ');
                    // \\n para que el template literal de Node escriba "\\n" literal al HTML;
                    // el cliente al ejecutar el string los interpreta como saltos de línea.
                    const msg = '¿Activar pausa parcial?\\n\\n' +
                        'Solo se van a procesar estos ' + issues.length + ' issue' + (issues.length===1?'':'s') + ':\\n' +
                        lista + '\\n\\n' +
                        'El resto del pipeline queda pausado hasta que reanudes o cambies la lista.';
                    if(!confirm(msg)) return;
                    const r = await fetch('/api/pause-partial', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({issues})});
                    const j = await r.json();
                    showToast(j.msg || 'Pausa parcial aplicada', j.ok);
                }
                menu.classList.remove('open');
                setTimeout(() => tickHeader().catch(()=>{}), 300);
            } catch(e){ showToast('Error: '+e.message, false); }
        });
    });
}

async function pauseIssueHome(issue){
    if(!confirm('¿Pausar #'+issue+'? Agrega label blocked:dependencies; el pulpo lo saltea hasta que lo reanudes en /pipeline.')) return;
    try{
        const r = await fetch('/api/issue/'+issue+'/pause', {method:'POST'});
        const j = await r.json();
        showToast(j.msg || (j.ok?'Pausado':'Falló'), j.ok);
        setTimeout(() => tickQueue().catch(()=>{}), 600);
    } catch(e){ showToast('Error: '+e.message, false); }
}

const POLLS = [
    { fn: tickHeader, ms: 5000 },
    { fn: tickKpis, ms: 60000 },
    { fn: tickQuota, ms: 60000 },
    { fn: tickActive, ms: 2000 },
    { fn: tickRecent, ms: 10000 },
    { fn: tickQueue, ms: 5000 },
];
async function runAll(){ for(const p of POLLS){ try{ await p.fn(); } catch{} } }
runAll();
for(const p of POLLS){ setInterval(() => { p.fn().catch(()=>{}); }, p.ms); }

// Pause polling when tab hidden (avoid wasted backend load)
document.addEventListener('visibilitychange', () => { if(document.visibilityState === 'visible') runAll(); });
`;
}

function renderHomeHTML() {
    const theme = loadTheme();
    const styles = homeStyles();
    const script = renderClientScript();
    const areasHtml = AREAS.map(a => `
      <a class="area-pill" href="${a.href}" target="_blank" rel="noopener" title="${a.sub}">
        <span class="area-pill-badge area-pill-badge-zero" id="badge-${a.key}">·</span>
        <span class="area-pill-icon">${a.icon}</span>
        <span class="area-pill-name">${a.label}</span>
      </a>`).join('');

    return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=1080">
<title>Intrale · Operación</title>
<style>${theme}</style>
<style>${styles}</style>
</head>
<body>
<div class="kiosk-frame">
  <header class="in-header">
    <div class="in-header-brand">
      <div class="in-header-logo">i</div>
      <div>
        <div class="in-header-title">Intrale · Operación</div>
        <div class="in-header-subtitle">Pipeline V3 · estado en vivo</div>
      </div>
    </div>
    <div class="in-header-meta">
      <span class="in-pill" id="hdr-mode" data-mode-toggle title="Click para cambiar el estado del pipeline">…
        <div class="in-mode-menu" id="hdr-mode-menu" role="menu" aria-hidden="true">
          <button class="in-mode-menu-item" data-mode-action="resume" type="button">
            <span class="in-mode-menu-item-icon">🟢</span>Running (sin pausa)
          </button>
          <button class="in-mode-menu-item" data-mode-action="pause" type="button">
            <span class="in-mode-menu-item-icon">⏸</span>Pausa total (todo en hold)
          </button>
          <div class="in-mode-menu-divider"></div>
          <div class="in-mode-menu-input" data-mode-action-block="partial">
            <label>Pausa parcial · solo procesar issues:</label>
            <input type="text" id="hdr-mode-partial-input" placeholder="ej: 2505, 2519, 2520" inputmode="numeric">
            <button data-mode-action="partial" type="button">⏸ Aplicar pausa parcial</button>
          </div>
        </div>
      </span>
      <span class="in-pill" id="hdr-pulpo">…</span>
      <span class="in-clock" id="hdr-clock">…</span>
    </div>
  </header>

  <main class="kiosk-body">

    <section class="kpi-grid" aria-label="KPIs">
      <div class="kpi-card" id="kpi-prs">
        <span class="kpi-icon">✅</span>
        <span class="kpi-label">PRs · 7d</span>
        <span class="kpi-value" id="kpi-prs-value">…</span>
        <span class="kpi-sub">mergeados</span>
      </div>
      <div class="kpi-card" id="kpi-tokens">
        <span class="kpi-icon">⚡</span>
        <span class="kpi-label">Tokens · 24h</span>
        <span class="kpi-value" id="kpi-tokens-value">…</span>
        <span class="kpi-sub">in + out</span>
      </div>
      <div class="kpi-card" id="kpi-cycle">
        <span class="kpi-icon">⏱</span>
        <span class="kpi-label">Cycle time</span>
        <span class="kpi-value" id="kpi-cycle-value">…</span>
        <span class="kpi-sub">mediana por fase</span>
      </div>
      <div class="kpi-card" id="kpi-bounce">
        <span class="kpi-icon">↩</span>
        <span class="kpi-label">% Rebote</span>
        <span class="kpi-value" id="kpi-bounce-value">…</span>
        <span class="kpi-sub">rechazos / total</span>
      </div>
      <div class="kpi-card" id="kpi-quota" title="% del límite estimado del Plan Max consumido en los últimos 7 días. Anthropic no expone API; el límite se auto-ajusta observando el uso real.">
        <span class="kpi-icon">📊</span>
        <span class="kpi-label">Cuota · 7d</span>
        <span class="kpi-value" id="kpi-quota-value">…</span>
        <span class="kpi-sub" id="kpi-quota-sub">plan Max</span>
      </div>
    </section>

    <nav class="areas-bar" aria-label="Áreas">
      ${areasHtml}
    </nav>

    <section class="active-section">
      <h2 class="in-section-title">
        <span class="in-section-title-icon">🟢</span>
        Ejecutando
        <span class="in-section-title-count" id="active-count">…</span>
      </h2>
      <div class="active-list" id="active-list"></div>
      <div class="active-empty" id="active-empty" style="display:none">
        <div class="active-empty-icon">⏸</div>
        <div class="active-empty-msg">No hay agentes corriendo. Verificar pausa, cola y blocked:dependencies.</div>
      </div>
    </section>

    <section class="in-section">
      <h2 class="in-section-title">
        <span class="in-section-title-icon">⏪</span>
        Últimos 5 ejecutados
      </h2>
      <div class="line-list" id="recent-list"></div>
    </section>

    <section class="in-section">
      <h2 class="in-section-title">
        <span class="in-section-title-icon">⏩</span>
        Próximos 5 en cola
      </h2>
      <div class="line-list" id="queue-list"></div>
    </section>

  </main>

  <footer class="in-footer">
    <span>Refresh independiente · sin flicker</span>
    <span id="footer-meta">Intrale V3</span>
  </footer>
</div>

<script>${script}</script>
</body>
</html>`;
}

module.exports = { renderHomeHTML };
