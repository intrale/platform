'use strict';

// =============================================================================
// ops.js — Vista "Ops" del Dashboard V3 (issue #3732, padre #3715).
//
// Extracción de la ventana Ops desde el monolito `satellites.js` (renderOps)
// a su propio módulo, siguiendo la plantilla canónica de `multi-provider.js`:
//   - loadTheme() + nav bar V3 (renderNavTabsSsr) + sprite inline.
//   - escape SSR unificado via lib/escape-html.js (#3722).
//   - render SERVER-SIDE de los datos del slice (banner Telegram, grid de
//     procesos, mini-cards QA env) + client JS que refresca por polling.
//
// Rediseño V3 (decisiones congeladas del UX en #3732, #3715):
//   1. <pre> con JSON crudo de QA env eliminado (CA-C2) → mini-cards por
//      entorno con badge de salud + meta key:value + último error truncado.
//   2. Banner Telegram dual-encoding (color + icono + texto), oculto cuando ok.
//   3. Grid de 5 procesos; listener/svc-telegram heredan estado bot-down.
//   4. Tooltips informativos (CA-C5) en cada zona: title= + aria-label.
//   5. Stale orders: número grande + breakdown por motivo (client-fill).
//
// Seguridad (formaliza REQ-SEC-1..7 del análisis security de #3732):
//   - REQ-SEC-1/CA-D1: toda interpolación dinámica pasa por escapeHtmlText
//     (contexto body) o escapeHtmlAttr (contexto atributo title=/aria-label).
//   - REQ-SEC-6/CA-D3: el texto runtime (lastError.description, etc.) pasa por
//     sanitizeRuntime() → sanitizer.js (redacta secrets) ANTES del escape.
//   - REQ-SEC-7/CA-A3: si el require del módulo o el state fallan, render
//     inerte VISIBLE ("Ventana Ops no disponible"), nunca string vacío.
//
// CA-F2: este módulo usa `lib/escape-html.js` (split #1 del épico #3715 ya
// aterrizó en main — verificado). No queda escape inline duplicado.
// =============================================================================

const fs = require('node:fs');
const path = require('node:path');

const { escapeHtmlText, escapeHtmlAttr } = require('../../lib/escape-html.js');
const { renderNavTabsSsr, loadIconSprite } = require('./nav-tabs');

const THEME_CSS_PATH = path.join(__dirname, 'theme.css');
function loadTheme() {
    try { return fs.readFileSync(THEME_CSS_PATH, 'utf8'); } catch { return ''; }
}

// CA-D3 / REQ-SEC-6 — sanitiza payload runtime ANTES del SSR. Reutiliza el
// sanitizer central del pipeline (redacta JWT, AWS keys, tokens, etc.). El
// truncado se aplica DESPUÉS del sanitize para no cortar a la mitad de un
// placeholder `[REDACTED:...]`.
function sanitizeRuntime(text, maxLen) {
    if (typeof text !== 'string') return '';
    const cap = (typeof maxLen === 'number' && maxLen > 0) ? maxLen : 200;
    let cleaned = text;
    try { cleaned = require('../../sanitizer').sanitize(text); }
    catch { /* sanitizer indisponible -> seguimos solo con escape posterior */ }
    return cleaned.length > cap ? cleaned.slice(0, cap) + '…' : cleaned;
}

// Procesos del pipeline → colas asociadas (espejo de satellites.js:1071-1077).
const PROC_QUEUES = {
    'listener': ['commander', 'telegram'],
    'svc-telegram': ['telegram'],
    'svc-github': ['github'],
    'svc-drive': ['drive'],
    'svc-emulador': ['emulador'],
};
const TG_PROCS = new Set(['listener', 'svc-telegram']);

// Entornos QA mostrados como mini-cards (reemplazo del <pre> JSON crudo).
const QA_ENV_CARDS = [
    { key: 'qaEnv', label: 'Local · qa-env' },
    { key: 'qaRemote', label: 'AWS Lambda · qa-remote' },
    { key: 'infraHealth', label: 'Infraestructura' },
    { key: 'telegramHealth', label: 'Telegram listener' },
];

// Deriva el estado de salud ('ok' | 'warn' | 'bad') de un sub-objeto del slice.
function healthOf(data) {
    if (!data || typeof data !== 'object') return 'warn';
    if (data.ok === true) return 'ok';
    if (data.ok === false) return 'bad';
    const s = String(data.status || '').toLowerCase();
    if (s === 'ok' || s === 'healthy' || s === 'up') return 'ok';
    if (s === 'degraded' || s === 'warn' || s === 'warning' || s === 'stale') return 'warn';
    if (s === 'down' || s === 'error' || s === 'bad' || s === 'fail') return 'bad';
    return 'warn';
}

// Formato de duración para uptime (ms → "1h 2m" / "45m" / "12s").
function fmtDurSsr(ms) {
    const n = Number(ms) || 0;
    if (n <= 0) return '—';
    const totalSec = Math.floor(n / 1000);
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    if (h >= 1) return h + 'h ' + m + 'm';
    if (m >= 1) return m + 'm ' + s + 's';
    return s + 's';
}

const OPS_CSS = `
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
.ops-banner { display: block; padding: 12px 16px; margin-bottom: 14px; border-radius: var(--in-radius-sm); border: 1px solid var(--in-bad); border-left: 4px solid var(--in-bad); background: var(--in-bad-soft); color: var(--in-bad); font-weight: 600; }
.ops-banner-title { display: flex; align-items: center; gap: 8px; }
.ops-banner-sub { font-weight: 400; font-size: 12px; color: var(--in-fg-dim); margin-top: 4px; font-family: var(--in-mono); word-break: break-word; }

/* #2994 — panel del reconciler stale orders. */
.stale-orders-panel { display: flex; flex-direction: column; gap: 12px; padding: 12px 14px; background: var(--in-bg-3); border: 1px solid var(--in-border); border-radius: var(--in-radius-sm); min-width: 260px; max-width: 520px; }
.stale-orders-main { display: flex; flex-direction: column; gap: 2px; }
.stale-orders-count { font-family: var(--in-mono, monospace); font-size: 32px; font-weight: 600; color: var(--warning, var(--in-warn, #D29922)); font-variant-numeric: tabular-nums; line-height: 1.1; }
.stale-orders-count.is-zero { color: var(--in-fg-dim); }
.stale-orders-caption { font-size: 12px; color: var(--in-fg-dim); }
.stale-orders-breakdown { display: flex; flex-direction: column; gap: 4px; }
.stale-orders-breakdown-row { display: flex; justify-content: space-between; gap: 12px; font-family: var(--in-mono, monospace); font-size: 12px; font-variant-numeric: tabular-nums; padding: 2px 0; }
.stale-orders-breakdown-reason { color: var(--in-fg-default, var(--in-fg)); }
.stale-orders-breakdown-value { color: var(--warning, var(--in-warn, #D29922)); font-weight: 600; }
.stale-orders-empty { color: var(--in-fg-dim); font-size: 12px; }

/* NUEVO -- mini-cards QA env (reemplazo del <pre> JSON crudo, CA-C2). */
.ops-env-grid  { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 12px; }
.ops-env-card  { background: var(--in-bg-3); border: 1px solid var(--in-border); border-left: 3px solid var(--in-fg-dim); border-radius: var(--in-radius-sm); padding: 12px; display: flex; flex-direction: column; gap: 6px; }
.ops-env-card[data-health="ok"]   { border-left-color: var(--in-ok); }
.ops-env-card[data-health="warn"] { border-left-color: var(--in-warn); }
.ops-env-card[data-health="bad"]  { border-left-color: var(--in-bad); }
.ops-env-card-head { display: flex; align-items: center; gap: 8px; font-weight: 600; font-size: 13px; }
.ops-env-card-meta { font-family: var(--in-mono); font-size: 11px; color: var(--in-fg-dim); display: grid; grid-template-columns: auto 1fr; gap: 2px 8px; }
.ops-env-card-meta dt { color: var(--in-fg-soft, var(--in-fg-dim)); }
.ops-env-card-meta dd { margin: 0; color: var(--in-fg); word-break: break-word; }
.ops-env-card-error { font-size: 11px; color: var(--in-bad); margin-top: 2px; font-family: var(--in-mono); word-break: break-word; }
.ops-env-badge { display: inline-flex; align-items: center; gap: 4px; padding: 2px 8px; border-radius: 12px; font-size: 10px; text-transform: uppercase; letter-spacing: 0.4px; font-weight: 600; border: 1px solid transparent; }
.ops-env-badge[data-health="ok"]   { background: var(--in-ok-soft); color: var(--in-ok); border-color: var(--in-ok); }
.ops-env-badge[data-health="warn"] { background: var(--in-warn-soft); color: var(--in-warn); border-color: var(--in-warn); }
.ops-env-badge[data-health="bad"]  { background: var(--in-bad-soft); color: var(--in-bad); border-color: var(--in-bad); }
`;

// ───────────────────────── SSR helpers (server-side) ─────────────────────────

// Banner Telegram (SSR). Visible solo cuando tgHealth.ok === false (CA-B1 #1).
function renderBannerSsr(tgHealth) {
    const tgDown = tgHealth && tgHealth.ok === false;
    if (!tgDown) {
        return '<div id="ops-tg-banner" class="ops-banner-hidden" role="status" aria-live="polite"' +
            ' title="Estado del bot de Telegram (Pulpo listener)"' +
            ' aria-label="Banner de salud del bot de Telegram"></div>';
    }
    const err = tgHealth.lastError || {};
    const desc = sanitizeRuntime(String(err.description || 'sin detalle'), 200);
    const code = sanitizeRuntime(String(err.code || '—'), 60);
    const src = sanitizeRuntime(String(err.source || '—'), 60);
    const upd = tgHealth.updatedAt ? sanitizeRuntime(String(tgHealth.updatedAt), 40) : '—';
    return '<div id="ops-tg-banner" class="ops-banner" role="status" aria-live="polite"' +
        ' title="El bot de Telegram (Pulpo listener) no responde"' +
        ' aria-label="Alerta: bot de Telegram caído">' +
        '<div class="ops-banner-title"><span aria-hidden="true">⚠</span>Bot de Telegram caído</div>' +
        '<div class="ops-banner-sub">' + escapeHtmlText(desc) +
        ' · code=' + escapeHtmlText(code) + ' · origen=' + escapeHtmlText(src) +
        ' · actualizado ' + escapeHtmlText(upd) + '</div>' +
        '<div class="ops-banner-sub">Acción sugerida: rotar token con BotFather y guardarlo en ' +
        '~/.claude/secrets/telegram-config.json (fuera del repo). Reiniciar listener.</div>' +
        '</div>';
}

function chipSsr(icon, n, kind) {
    const v = Number(n) || 0;
    const cls = (kind === 'pend' && v > 0) ? 'ops-chip hot'
        : (kind === 'work' && v > 0) ? 'ops-chip work'
        : 'ops-chip';
    return '<span class="' + cls + '" title="' + escapeHtmlAttr('cola ' + kind) + '">' +
        icon + ' ' + v + '</span>';
}

function queuesHtmlSsr(name, servicios) {
    const queues = PROC_QUEUES[name] || [];
    if (!queues.length) return '';
    let html = '<div class="ops-queues">';
    for (const q of queues) {
        const s = (servicios && servicios[q]) || { pendiente: 0, trabajando: 0, listo: 0 };
        html += '<span class="ops-queue-group"' +
            ' title="' + escapeHtmlAttr('Cola ' + q + ': pendiente / trabajando / listo') + '"' +
            ' aria-label="' + escapeHtmlAttr('Cola ' + q) + '">' +
            '<span class="ops-queue-name">' + escapeHtmlText(q) + '</span>' +
            chipSsr('⏳', s.pendiente, 'pend') +
            chipSsr('⚙', s.trabajando, 'work') +
            chipSsr('✓', s.listo, 'done') +
            '</span>';
    }
    html += '</div>';
    return html;
}

function renderProcCardsSsr(procesos, servicios, tgDown, tgHealth) {
    const entries = Object.entries(procesos || {});
    if (!entries.length) {
        return '<div class="ops-card-meta">Sin procesos reportados todavía.</div>';
    }
    let html = '';
    for (const [name, p] of entries) {
        const proc = p || {};
        const isTg = TG_PROCS.has(name);
        let cls = proc.alive ? 'alive' : 'dead';
        if (isTg && tgDown) cls = (proc.alive ? 'alive ' : 'dead ') + 'bot-down';
        const dot = proc.alive ? '🟢' : '🔴';
        const errLine = (isTg && tgDown)
            ? '<div class="ops-card-error">⚠ ' +
                escapeHtmlText(sanitizeRuntime(String((tgHealth.lastError || {}).description || 'API rechazada'), 80)) +
                '</div>'
            : '';
        html += '<div class="ops-card ' + cls + '"' +
            ' title="' + escapeHtmlAttr('Proceso ' + name + ' — ' + (proc.alive ? 'vivo' : 'caído')) + '"' +
            ' aria-label="' + escapeHtmlAttr('Proceso ' + name + ' ' + (proc.alive ? 'vivo' : 'caído')) + '">' +
            '<div class="ops-card-name"><span aria-hidden="true">' + dot + '</span> ' + escapeHtmlText(name) + '</div>' +
            '<div class="ops-card-meta">PID ' + escapeHtmlText(proc.pid != null ? String(proc.pid) : '—') + '</div>' +
            '<div class="ops-card-meta">uptime ' + escapeHtmlText(fmtDurSsr(proc.uptime)) + '</div>' +
            errLine +
            queuesHtmlSsr(name, servicios) +
            '</div>';
    }
    return html;
}

function envMetaSsr(data) {
    if (!data || typeof data !== 'object') return '';
    let html = '';
    for (const [k, v] of Object.entries(data)) {
        if (k === 'lastError') continue;
        if (v === null || typeof v === 'object') continue;
        html += '<dt>' + escapeHtmlText(k) + '</dt>' +
            '<dd>' + escapeHtmlText(sanitizeRuntime(String(v), 60)) + '</dd>';
    }
    return html;
}

function renderEnvCardsSsr(state) {
    let html = '';
    for (const c of QA_ENV_CARDS) {
        const data = state[c.key];
        const h = healthOf(data);
        const lastErr = (data && data.lastError && data.lastError.description) || '';
        const errLine = lastErr
            ? '<div class="ops-env-card-error">' +
                escapeHtmlText(sanitizeRuntime(String(lastErr), 80)) + '</div>'
            : '';
        html += '<div class="ops-env-card" data-health="' + h + '"' +
            ' title="' + escapeHtmlAttr('Salud del entorno ' + c.label) + '"' +
            ' aria-label="' + escapeHtmlAttr(c.label + ' — estado ' + h) + '">' +
            '<div class="ops-env-card-head">' +
            '<span class="ops-env-badge" data-health="' + h + '">' + h.toUpperCase() + '</span> ' +
            escapeHtmlText(c.label) + '</div>' +
            '<dl class="ops-env-card-meta">' + envMetaSsr(data) + '</dl>' +
            errLine +
            '</div>';
    }
    return html;
}

function opsBodyHtml(state) {
    const tgHealth = state.telegramHealth;
    const tgDown = tgHealth && tgHealth.ok === false;
    return `
${renderBannerSsr(tgHealth)}

<section class="in-section" aria-labelledby="ops-procesos-h">
  <h2 id="ops-procesos-h" class="in-section-title"><span class="in-section-title-icon" aria-hidden="true">🛠</span>Procesos del pipeline</h2>
  <div id="ops-procesos" class="ops-grid" aria-label="Procesos vivos del pipeline">${renderProcCardsSsr(state.procesos, state.servicios, tgDown, tgHealth || {})}</div>
</section>

<section class="in-section" aria-labelledby="ops-stale-h">
  <h2 id="ops-stale-h" class="in-section-title"><span class="in-section-title-icon" aria-hidden="true">⏳</span>Reconciler · órdenes descartadas (stale)</h2>
  <div class="stale-orders-panel" id="stale-orders-panel">
    <div class="stale-orders-main">
      <div class="stale-orders-count" id="stale-orders-count"
           title="Órdenes que el reconciler descartó en las últimas 24 horas"
           aria-label="total de órdenes descartadas en 24 horas">…</div>
      <div class="stale-orders-caption">últimas 24h</div>
    </div>
    <div class="stale-orders-breakdown" id="stale-orders-breakdown"></div>
  </div>
</section>

<section class="in-section" aria-labelledby="ops-qaenv-h">
  <h2 id="ops-qaenv-h" class="in-section-title"><span class="in-section-title-icon" aria-hidden="true">📡</span>QA Environment</h2>
  <div id="ops-qaenv" class="ops-env-grid" aria-label="Salud de entornos QA y Telegram">${renderEnvCardsSsr(state)}</div>
</section>`;
}

// ───────────────────────── Client JS (polling) ─────────────────────────

const OPS_CLIENT_JS = `
function escapeHtml(s){ return String(s==null?'':s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":"&#39;"}[c])); }
async function fetchJson(url){
    try { const r = await fetch(url, { cache: 'no-store' }); if(!r.ok) return null; return await r.json(); }
    catch { return null; }
}
function fmtDur(ms){
    const n = Number(ms)||0; if(n<=0) return '—';
    const t = Math.floor(n/1000), h = Math.floor(t/3600), m = Math.floor((t%3600)/60), s = t%60;
    if(h>=1) return h+'h '+m+'m'; if(m>=1) return m+'m '+s+'s'; return s+'s';
}
const PROC_QUEUES = ${JSON.stringify(PROC_QUEUES)};
const TG_PROCS = new Set(${JSON.stringify(Array.from(TG_PROCS))});
const QA_ENV_CARDS = ${JSON.stringify(QA_ENV_CARDS)};
function healthOf(data){
    if(!data || typeof data !== 'object') return 'warn';
    if(data.ok === true) return 'ok';
    if(data.ok === false) return 'bad';
    const s = String(data.status||'').toLowerCase();
    if(s==='ok'||s==='healthy'||s==='up') return 'ok';
    if(s==='degraded'||s==='warn'||s==='warning'||s==='stale') return 'warn';
    if(s==='down'||s==='error'||s==='bad'||s==='fail') return 'bad';
    return 'warn';
}
function chip(icon, n, kind){
    const v = Number(n)||0;
    const c = (kind==='pend'&&v>0)?'ops-chip hot':(kind==='work'&&v>0)?'ops-chip work':'ops-chip';
    return '<span class="'+c+'" title="'+escapeHtml('cola '+kind)+'">'+icon+' '+v+'</span>';
}
function queuesHTML(name, servicios){
    const queues = PROC_QUEUES[name] || [];
    if(!queues.length) return '';
    let html = '<div class="ops-queues">';
    for(const q of queues){
        const s = (servicios && servicios[q]) || { pendiente:0, trabajando:0, listo:0 };
        html += '<span class="ops-queue-group" title="'+escapeHtml('Cola '+q+': pendiente / trabajando / listo')+'" aria-label="'+escapeHtml('Cola '+q)+'">'
            + '<span class="ops-queue-name">'+escapeHtml(q)+'</span>'
            + chip('⏳', s.pendiente, 'pend') + chip('⚙', s.trabajando, 'work') + chip('✓', s.listo, 'done')
            + '</span>';
    }
    return html + '</div>';
}
async function tickOps(){
    const d = await fetchJson('/api/dash/ops');
    if(!d) return;
    const tgHealth = d.telegramHealth;
    const tgDown = tgHealth && tgHealth.ok === false;
    const banner = document.getElementById('ops-tg-banner');
    if(banner){
        if(tgDown){
            const err = tgHealth.lastError || {};
            const desc = String(err.description || 'sin detalle').slice(0,200);
            const code = err.code || '—', src = err.source || '—';
            const upd = tgHealth.updatedAt ? new Date(tgHealth.updatedAt).toLocaleString('es-AR') : '—';
            const html = '<div class="ops-banner-title"><span aria-hidden="true">⚠</span>Bot de Telegram caído</div>'
                + '<div class="ops-banner-sub">'+escapeHtml(desc)+' · code='+escapeHtml(String(code))+' · origen='+escapeHtml(String(src))+' · actualizado '+escapeHtml(upd)+'</div>'
                + '<div class="ops-banner-sub">Acción sugerida: rotar token con BotFather y guardarlo en ~/.claude/secrets/telegram-config.json (fuera del repo). Reiniciar listener.</div>';
            if(banner.innerHTML !== html){ banner.className = 'ops-banner'; banner.innerHTML = html; }
        } else if(banner.className !== 'ops-banner-hidden'){
            banner.className = 'ops-banner-hidden'; banner.innerHTML = '';
        }
    }
    const grid = document.getElementById('ops-procesos');
    if(grid){
        let html = '';
        for(const [name, p] of Object.entries(d.procesos || {})){
            const proc = p || {};
            const isTg = TG_PROCS.has(name);
            let cls = proc.alive ? 'alive' : 'dead';
            if(isTg && tgDown) cls = (proc.alive?'alive ':'dead ') + 'bot-down';
            const errLine = (isTg && tgDown)
                ? '<div class="ops-card-error">⚠ '+escapeHtml(String((tgHealth.lastError||{}).description || 'API rechazada').slice(0,80))+'</div>' : '';
            html += '<div class="ops-card '+cls+'" title="'+escapeHtml('Proceso '+name+' — '+(proc.alive?'vivo':'caído'))+'" aria-label="'+escapeHtml('Proceso '+name+' '+(proc.alive?'vivo':'caído'))+'">'
                + '<div class="ops-card-name"><span aria-hidden="true">'+(proc.alive?'🟢':'🔴')+'</span> '+escapeHtml(name)+'</div>'
                + '<div class="ops-card-meta">PID '+escapeHtml(proc.pid!=null?String(proc.pid):'—')+'</div>'
                + '<div class="ops-card-meta">uptime '+escapeHtml(fmtDur(proc.uptime))+'</div>'
                + errLine + queuesHTML(name, d.servicios) + '</div>';
        }
        if(grid.innerHTML !== html) grid.innerHTML = html;
    }
    const env = document.getElementById('ops-qaenv');
    if(env){
        let html = '';
        for(const c of QA_ENV_CARDS){
            const data = d[c.key];
            const h = healthOf(data);
            let meta = '';
            if(data && typeof data === 'object'){
                for(const [k,v] of Object.entries(data)){
                    if(k==='lastError' || v===null || typeof v === 'object') continue;
                    meta += '<dt>'+escapeHtml(k)+'</dt><dd>'+escapeHtml(String(v).slice(0,60))+'</dd>';
                }
            }
            const lastErr = (data && data.lastError && data.lastError.description) || '';
            const errLine = lastErr ? '<div class="ops-env-card-error">'+escapeHtml(String(lastErr).slice(0,80))+'</div>' : '';
            html += '<div class="ops-env-card" data-health="'+h+'" title="'+escapeHtml('Salud del entorno '+c.label)+'" aria-label="'+escapeHtml(c.label+' — estado '+h)+'">'
                + '<div class="ops-env-card-head"><span class="ops-env-badge" data-health="'+h+'">'+h.toUpperCase()+'</span> '+escapeHtml(c.label)+'</div>'
                + '<dl class="ops-env-card-meta">'+meta+'</dl>'+errLine+'</div>';
        }
        if(env.innerHTML !== html) env.innerHTML = html;
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
        for(const [reason, n] of Object.entries(reasons).sort((a,b)=>b[1]-a[1])){
            html += '<div class="stale-orders-breakdown-row"><span class="stale-orders-breakdown-reason">— '+escapeHtml(reason)+'</span><span class="stale-orders-breakdown-value">'+(Number(n)||0)+'</span></div>';
        }
    }
    if(breakdownEl.innerHTML !== html) breakdownEl.innerHTML = html;
}
function tickClock(){ const c = document.getElementById('hdr-clock'); if(c) c.textContent = new Date().toLocaleTimeString('es-AR'); }
const POLLS = [{ fn: tickOps, ms: 5000 }, { fn: tickStaleOrders, ms: 30000 }, { fn: tickClock, ms: 1000 }];
async function runAll(){ for(const p of POLLS){ try{ await p.fn(); } catch{} } }
runAll();
for(const p of POLLS){ setInterval(() => { Promise.resolve(p.fn()).catch(()=>{}); }, p.ms); }
`;

// ───────────────────────── Render principal ─────────────────────────

/**
 * Render SSR de la ventana Ops.
 * @param {object} state — slice de `lib/dashboard-slices.js` opsSlice(state):
 *   { procesos, servicios, infraHealth, qaEnv, qaRemote, resources, telegramHealth }.
 * @param {object} [opts] — opciones de routing (currentView, etc.). Reservado.
 * @returns {string} HTML completo de la ventana.
 */
function renderOps(state, opts) {
    // CA-A3 / REQ-SEC-7 — sin state, fallback inerte visible (no string vacío).
    if (!state || typeof state !== 'object') {
        return renderInert('opsSlice(state) no fue invocado por el caller');
    }
    const theme = loadTheme();
    const spriteInline = loadIconSprite();
    const navHtml = renderNavTabsSsr('ops');
    return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Intrale · Ops</title>
<style>${theme}</style>
<style>
.satellite-frame { max-width: 1600px; margin: 0 auto; padding: 0; }
.satellite-body { padding: 22px 28px; display: flex; flex-direction: column; gap: 18px; }
${OPS_CSS}
</style>
</head>
<body>
<div aria-hidden="true" style="position:absolute;width:0;height:0;overflow:hidden">${spriteInline}</div>
<div class="satellite-frame">
  <header class="in-header">
    <div class="in-header-brand">
      <div class="in-header-logo">i</div>
      <div>
        <div class="in-header-title">Ops</div>
        <div class="in-header-subtitle">Procesos, servicios e infraestructura</div>
      </div>
    </div>
    <div class="in-header-meta">
      <span class="in-clock" id="hdr-clock">${escapeHtmlText(new Date().toLocaleTimeString('es-AR'))}</span>
    </div>
  </header>
  ${navHtml}
  <main class="satellite-body">${opsBodyHtml(state)}</main>
  <footer class="in-footer">
    <span>Solo lectura · estado en vivo del pipeline</span>
    <span>Intrale V3 · #3732</span>
  </footer>
</div>
<script>${OPS_CLIENT_JS}</script>
</body>
</html>`;
}

/**
 * Render inerte (CA-A3 / REQ-SEC-7): visible cuando require()/state fallan.
 * Evita pantalla en blanco (DoS por carga parcial donde el operador no ve el
 * estado real del pipeline).
 * @param {string} reason — motivo (se escapa antes de interpolar).
 * @returns {string} HTML mínimo visible.
 */
function renderInert(reason) {
    const safe = escapeHtmlText(reason || 'módulo no disponible');
    const theme = loadTheme();
    return `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Intrale · Ops</title><style>${theme}</style></head>
<body><main style="padding:32px;max-width:800px;margin:0 auto">
<h1>Ventana Ops no disponible</h1>
<p>${safe}</p>
<p>Revisá los logs del dashboard para el detalle. El render no queda en blanco (CA-A3 / REQ-SEC-7).</p>
</main></body></html>`;
}

module.exports = {
    renderOps,
    renderInert,
    sanitizeRuntime,
    healthOf,
    OPS_CSS,
    // Alias de compat para callers que esperen el nombre canónico de escape SSR.
    escapeHtmlSsr: escapeHtmlText,
};
