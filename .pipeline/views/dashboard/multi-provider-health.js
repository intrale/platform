// =============================================================================
// multi-provider-health.js — Vista HTML/JS de la pantalla EP8-H12
// "Salud Multi-Provider" del Dashboard V3 (#3965).
//
// Pantalla ADITIVA: NO modifica rutas ni vistas existentes. Patrón espejo de
// views/dashboard/multi-provider.js:
//   - export renderMultiProviderHealth()
//   - HTML inicial con IDs estables
//   - cliente JS con fetch JSON + DOM morphing (sin full re-render)
//   - polling 30s
//   - reuso de nav-tabs (renderNavTabsSsr / loadIconSprite) + theme.css
//   - render SVG NATIVO (sin librería de charting — REQ-SEC supply-chain A06/A08)
//
// Secciones (CA-1..CA-5 del PO):
//   1. Health cards por provider (estado, despachos 24h, p50/p95, errores/clase)
//   2. Matriz proveedor×skill (desde agent-models.json, no hardcode)
//   3. Panel Sherlock (% same-provider, meta <10%, badge de alerta)
//   4. Timeline gate/exhaustion/recovery (24h)
//   + acción "probar proveedor ahora" (live-ping vía POST existente, CSRF)
//
// Seguridad:
//   - Defensa XSS (A03 / CA-5): TODO texto del audit (reason_code, mensajes)
//     pasa por escapeHtml() antes de tocar el DOM. Nunca innerHTML con strings
//     crudos del audit.
//   - El endpoint de datos ya entrega solo metadatos (whitelist server-side,
//     health-screen.js / api.js). La vista nunca pide ni muestra credenciales.
// =============================================================================
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { renderNavTabsSsr, loadIconSprite } = require('./nav-tabs');

const THEME_CSS_PATH = path.join(__dirname, 'theme.css');
const DESIGN_TOKENS_PATH = path.join(__dirname, '..', '..', 'assets', 'design-tokens.css');

function loadCssFile(p) {
    try { return fs.readFileSync(p, 'utf8'); } catch { return ''; }
}

// Orden de presentación fijo (UX: Anthropic → Codex → Gemini → Cerebras → NVIDIA).
// Los providers fuera del set se ubican al final, ordenados alfabéticamente.
const PROVIDER_ORDER = ['anthropic', 'openai', 'openai-codex', 'gemini-google', 'cerebras', 'nvidia-nim', 'deterministic'];

const PANEL_CSS = `
.mph-frame { max-width: 1600px; margin: 0 auto; padding: 0; }
.mph-body { padding: 22px 28px; display: flex; flex-direction: column; gap: 20px; }
.mph-section { background: var(--in-bg-3); border: 1px solid var(--in-border); border-radius: var(--in-radius-sm, 8px); padding: 16px 18px; }
.mph-section-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 14px; gap: 12px; flex-wrap: wrap; }
.mph-section-title { font-size: 14px; font-weight: 600; display: inline-flex; align-items: center; gap: 8px; }
.mph-section-sub { color: var(--in-fg-dim); font-size: 12px; }
.mph-icon { width: 16px; height: 16px; display: inline-block; vertical-align: -3px; flex: 0 0 auto; }

/* Health cards ------------------------------------------------------------ */
.mph-cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 14px; }
.mph-card { background: var(--in-bg, #14161b); border: 1px solid var(--in-border); border-left: 4px solid var(--row-accent, var(--in-border)); border-radius: var(--in-radius-sm, 8px); padding: 14px 16px; }
.mph-card-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 10px; }
.mph-card-name { font-weight: 600; font-size: 14px; display: inline-flex; align-items: center; gap: 7px; }
.mph-card-name .mph-icon { color: var(--row-accent, var(--in-fg-dim)); width: 18px; height: 18px; }
.mph-state { font-size: 11px; padding: 3px 9px; border-radius: 999px; text-transform: uppercase; letter-spacing: .03em; display: inline-flex; align-items: center; gap: 5px; font-weight: 600; }
.mph-state .mph-icon { width: 12px; height: 12px; }
.mph-state.green { background: var(--in-ok-soft, rgba(52,211,153,.14)); color: var(--in-ok, #34d399); }
.mph-state.yellow { background: var(--in-warn-soft, rgba(245,191,103,.14)); color: var(--in-warn, #f5bf67); }
.mph-state.red { background: var(--in-bad-soft, rgba(248,113,113,.14)); color: var(--in-bad, #f87171); }
.mph-state.nodata { background: var(--in-bg-3); color: var(--in-fg-dim); }
.mph-metrics { display: grid; grid-template-columns: repeat(2, 1fr); gap: 8px 14px; margin: 10px 0; }
.mph-metric { display: flex; flex-direction: column; gap: 2px; }
.mph-metric-label { font-size: 10px; text-transform: uppercase; letter-spacing: .04em; color: var(--in-fg-dim); }
.mph-metric-val { font-size: 16px; font-weight: 600; font-variant-numeric: tabular-nums; }
.mph-metric-val .mph-unit { font-size: 11px; font-weight: 400; color: var(--in-fg-dim); margin-left: 2px; }
.mph-errclasses { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 6px; }
.mph-errchip { font-size: 10px; padding: 2px 7px; border-radius: 4px; background: var(--in-bg-3); border: 1px solid var(--in-border); color: var(--in-fg-dim); font-family: var(--in-mono, monospace); }
.mph-errchip.glitch { color: var(--in-warn, #f5bf67); border-color: var(--in-warn, #f5bf67); }
.mph-card-actions { margin-top: 10px; display: flex; align-items: center; gap: 10px; }
.mph-nodata-note { font-size: 11px; color: var(--in-fg-dim); font-style: italic; }

/* Sparkline-ish latency bar (SVG nativo) */
.mph-latbar { width: 100%; height: 26px; display: block; margin-top: 4px; }

/* Botones ----------------------------------------------------------------- */
.mph-btn { background: var(--in-accent, #6366f1); color: #fff; border: none; padding: 7px 13px; font-size: 12px; font-weight: 500; border-radius: 6px; cursor: pointer; display: inline-flex; align-items: center; gap: 6px; min-height: 34px; }
.mph-btn:hover { filter: brightness(1.08); }
.mph-btn:disabled { opacity: .5; cursor: not-allowed; }
.mph-btn.ghost { background: transparent; color: var(--in-fg); border: 1px solid var(--in-border); }
.mph-btn .mph-icon { width: 13px; height: 13px; }

/* Matriz ------------------------------------------------------------------ */
.mph-matrix-wrap { overflow-x: auto; }
.mph-matrix { width: 100%; border-collapse: collapse; font-size: 12px; }
.mph-matrix th, .mph-matrix td { padding: 7px 10px; border-bottom: 1px solid var(--in-border); text-align: left; white-space: nowrap; }
.mph-matrix th { color: var(--in-fg-dim); font-weight: 500; font-size: 11px; text-transform: uppercase; letter-spacing: .03em; }
.mph-matrix td.skill { font-weight: 600; }
.mph-chain { display: inline-flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.mph-prov-chip { display: inline-flex; align-items: center; gap: 5px; padding: 2px 8px; font-size: 11px; border-radius: 5px; border: 1px solid var(--in-border); border-left: 3px solid var(--row-accent, var(--in-border)); background: var(--in-bg); }
.mph-prov-chip.primary { font-weight: 600; }
.mph-prov-chip.fallback { opacity: .82; }
.mph-prov-rank { font-size: 9px; color: var(--in-fg-dim); font-weight: 600; }
.mph-prov-chip .mph-icon { width: 13px; height: 13px; color: var(--row-accent, var(--in-fg-dim)); }
.mph-arrow { color: var(--in-fg-dim); font-size: 12px; }
.mph-nollm { font-size: 10px; color: var(--in-fg-dim); font-style: italic; }

/* Panel Sherlock ---------------------------------------------------------- */
.mph-sherlock { display: flex; align-items: center; gap: 22px; flex-wrap: wrap; }
.mph-sherlock-num { font-size: 38px; font-weight: 700; font-variant-numeric: tabular-nums; line-height: 1; }
.mph-sherlock-num.alert { color: var(--in-bad, #f87171); }
.mph-sherlock-num.ok { color: var(--in-ok, #34d399); }
.mph-sherlock-meta { font-size: 12px; color: var(--in-fg-dim); }
.mph-sherlock-badge { font-size: 11px; padding: 3px 10px; border-radius: 999px; font-weight: 600; text-transform: uppercase; letter-spacing: .03em; }
.mph-sherlock-badge.alert { background: var(--in-bad-soft, rgba(248,113,113,.14)); color: var(--in-bad, #f87171); }
.mph-sherlock-badge.ok { background: var(--in-ok-soft, rgba(52,211,153,.14)); color: var(--in-ok, #34d399); }
.mph-sherlock-bar-wrap { flex: 1; min-width: 220px; }

/* Timeline ---------------------------------------------------------------- */
.mph-timeline { display: flex; flex-direction: column; gap: 0; max-height: 420px; overflow-y: auto; }
.mph-tl-item { display: flex; align-items: flex-start; gap: 12px; padding: 9px 0; border-bottom: 1px dashed var(--in-border); }
.mph-tl-item:last-child { border-bottom: none; }
.mph-tl-dot { width: 11px; height: 11px; border-radius: 50%; margin-top: 3px; flex: 0 0 auto; background: var(--in-fg-dim); }
.mph-tl-dot.recovery { background: var(--in-ok, #34d399); }
.mph-tl-dot.gate { background: var(--in-warn, #f5bf67); }
.mph-tl-dot.exhaustion { background: var(--in-bad, #f87171); }
.mph-tl-body { flex: 1; min-width: 0; }
.mph-tl-line { font-size: 12.5px; display: flex; align-items: center; gap: 7px; flex-wrap: wrap; }
.mph-tl-prov { font-weight: 600; }
.mph-tl-states { font-family: var(--in-mono, monospace); font-size: 11px; color: var(--in-fg-dim); }
.mph-tl-reason { font-family: var(--in-mono, monospace); font-size: 11px; padding: 1px 6px; border-radius: 3px; background: var(--in-bg-3); }
.mph-tl-ts { font-size: 11px; color: var(--in-fg-dim); font-variant-numeric: tabular-nums; }
.mph-empty { color: var(--in-fg-dim); font-size: 12px; padding: 14px 0; font-style: italic; }
`;

function bodyHtml() {
    return `
  <div id="mph-msg" class="mph-section-sub" style="padding:0 28px">Cargando…</div>

  <section class="mph-section" id="mph-cards-section">
    <div class="mph-section-head">
      <div class="mph-section-title">${iconSvg('multi-provider', 'lg')} Salud por proveedor</div>
      <div class="mph-section-sub">Ventana 24h · latencia p50/p95 · despachos · errores por clase</div>
    </div>
    <div class="mph-cards" id="mph-cards"><div class="mph-empty">Cargando salud de proveedores…</div></div>
  </section>

  <section class="mph-section" id="mph-sherlock-section">
    <div class="mph-section-head">
      <div class="mph-section-title">${iconSvg('shield-lock', 'lg')} Sherlock · % same-provider (vigilancia EP2-H1)</div>
      <div class="mph-section-sub">Meta &lt; 10% en ventana 24h</div>
    </div>
    <div class="mph-sherlock" id="mph-sherlock"><div class="mph-empty">Cargando…</div></div>
  </section>

  <section class="mph-section" id="mph-matrix-section">
    <div class="mph-section-head">
      <div class="mph-section-title">${iconSvg('multi-provider', 'lg')} Matriz proveedor × skill</div>
      <div class="mph-section-sub">Desde agent-models.json · primario + cadena de fallback</div>
    </div>
    <div class="mph-matrix-wrap"><table class="mph-matrix" id="mph-matrix"><tbody><tr><td class="mph-empty">Cargando matriz…</td></tr></tbody></table></div>
  </section>

  <section class="mph-section" id="mph-timeline-section">
    <div class="mph-section-head">
      <div class="mph-section-title">${iconSvg('history', 'lg')} Timeline gate / exhaustion / recovery</div>
      <div class="mph-section-sub">Transiciones de estado · últimas 24h</div>
    </div>
    <div class="mph-timeline" id="mph-timeline"><div class="mph-empty">Cargando timeline…</div></div>
  </section>
`;
}

/**
 * Ícono del sprite UX. Si el nombre no existe en el sprite, el <use> queda vacío
 * (sin romper layout). Solo se usa con nombres literales hardcoded → sin XSS.
 */
function iconSvg(name, size) {
    const cls = size ? 'mph-icon ' + size : 'mph-icon';
    return '<svg class="' + cls + '" viewBox="0 0 24 24" aria-hidden="true"><use href="/assets/icons/sprite.svg#ic-' + name + '"></use></svg>';
}

// El cliente JS corre en el browser. Todo dato del audit se escapa con
// escapeHtml() antes de tocar el DOM (defensa XSS A03 / CA-5).
const CLIENT_JS = `
const PROVIDER_ORDER = ${JSON.stringify(PROVIDER_ORDER)};
let mphState = { csrfToken: null, screen: null, sherlock: null, timeline: null, config: null, pinging: {} };

function escapeHtml(s){ return String(s==null?'':s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function setMsg(t){ const el=document.getElementById('mph-msg'); if(el) el.textContent=t; }

function showToast(msg, ok){
  let t=document.getElementById('in-toast');
  if(!t){ t=document.createElement('div'); t.id='in-toast'; t.style.cssText='position:fixed;bottom:24px;left:50%;transform:translateX(-50%);padding:12px 22px;border-radius:8px;font-size:13px;z-index:9999;box-shadow:0 6px 24px rgba(0,0,0,.4);transition:opacity .3s;opacity:0;color:#fff'; document.body.appendChild(t); }
  t.textContent=msg;
  t.style.background = ok===false ? 'var(--in-bad)' : (ok===true ? 'var(--in-ok)' : 'var(--in-brand,#6366f1)');
  t.style.opacity='1'; clearTimeout(t._to); t._to=setTimeout(()=>{ t.style.opacity='0'; }, 3500);
}

async function fetchJson(url, opts){
  try{ const r=await fetch(url,{cache:'no-store',...opts}); const d=await r.json().catch(()=>({})); if(!r.ok) return {ok:false,status:r.status,...d}; return d; }
  catch(e){ return {ok:false,error:e.message}; }
}
async function fetchCsrf(){ const r=await fetchJson('/api/multi-provider/csrf-token'); if(r&&r.csrf_token) mphState.csrfToken=r.csrf_token; }
async function authedPost(url){
  if(!mphState.csrfToken) await fetchCsrf();
  return fetchJson(url,{ method:'POST', headers:{ 'Content-Type':'application/json', 'X-CSRF-Token':mphState.csrfToken||'', 'X-Requested-With':'XMLHttpRequest' }, body:'{}' });
}

// --- helpers de provider (espejo del set cerrado del dashboard) -----------
function providerToken(p){
  p=String(p||'').toLowerCase();
  if(p==='anthropic') return '--provider-anthropic';
  if(p==='openai') return '--provider-openai';
  if(p==='openai-codex'||p==='codex') return '--provider-openai-codex';
  if(p==='deterministic') return '--provider-deterministic';
  if(p==='nvidia-nim') return '--provider-nvidia-nim';
  return '--provider-unknown';
}
function providerIconId(p){
  p=String(p||'').toLowerCase();
  if(p==='anthropic') return 'ic-provider-anthropic';
  if(p==='openai') return 'ic-provider-openai';
  if(p==='openai-codex'||p==='codex') return 'ic-provider-openai-codex';
  if(p==='deterministic') return 'ic-provider-deterministic';
  if(p==='gemini-google') return 'ic-provider-gemini';
  if(p==='cerebras') return 'ic-provider-cerebras';
  if(p==='nvidia-nim') return 'ic-provider-nvidia-nim';
  return 'ic-provider-unknown';
}
function providerIconSvg(p){
  // providerIconId() devuelve SOLO ids hardcoded → seguro interpolar.
  return '<svg class="mph-icon" viewBox="0 0 24 24" aria-hidden="true"><use href="/assets/icons/sprite.svg#'+providerIconId(p)+'"></use></svg>';
}
// live-ping usa ids canónicos distintos para algunos providers.
function pingableId(p){
  p=String(p||'').toLowerCase();
  if(p==='openai-codex'||p==='codex') return 'openai';
  return p;
}
function orderProviders(list){
  return list.slice().sort((a,b)=>{
    const ia=PROVIDER_ORDER.indexOf(a), ib=PROVIDER_ORDER.indexOf(b);
    const ra=ia<0?999:ia, rb=ib<0?999:ib;
    if(ra!==rb) return ra-rb;
    return String(a).localeCompare(String(b));
  });
}
function fmtMs(v){ return (v==null) ? '—' : (v>=1000 ? (v/1000).toFixed(1)+'s' : Math.round(v)+''); }

// --- Health cards (CA-1) --------------------------------------------------
function cardState(card){
  if(!card.has_data) return {cls:'nodata', label:'sin datos 24h', icon:'estado-unknown'};
  const errs = Object.keys(card.error_classes||{}).length;
  if(errs>0) return {cls:'yellow', label:'con errores', icon:'health-warn'};
  return {cls:'green', label:'activo', icon:'health-ok'};
}
function renderCards(){
  const el=document.getElementById('mph-cards'); if(!el) return;
  const cards=(mphState.screen&&mphState.screen.cards)||[];
  if(!cards.length){ el.innerHTML='<div class="mph-empty">Sin datos de proveedores en la ventana 24h.</div>'; return; }
  const byProv={}; cards.forEach(c=>{ byProv[c.provider]=c; });
  const provs=orderProviders(cards.map(c=>c.provider));
  el.innerHTML = provs.map(pid=>{
    const c=byProv[pid]; const st=cardState(c); const token=providerToken(pid);
    const errChips = Object.entries(c.error_classes||{}).map(([k,v])=>{
      const isGlitch = k==='cli_1m_context_glitch';
      return '<span class="mph-errchip'+(isGlitch?' glitch':'')+'" title="'+escapeHtml(k)+'">'+escapeHtml(k)+' · '+escapeHtml(String(v))+'</span>';
    }).join('');
    const noData = !c.has_data ? '<div class="mph-nodata-note">Sin actividad registrada en las últimas 24h.</div>' : '';
    return ''+
      '<div class="mph-card" style="--row-accent:var('+token+')">'+
        '<div class="mph-card-head">'+
          '<div class="mph-card-name">'+providerIconSvg(pid)+'<span>'+escapeHtml(pid)+'</span></div>'+
          '<span class="mph-state '+st.cls+'"><svg class="mph-icon" viewBox="0 0 24 24" aria-hidden="true"><use href="/assets/icons/sprite.svg#ic-'+st.icon+'"></use></svg>'+escapeHtml(st.label)+'</span>'+
        '</div>'+
        '<div class="mph-metrics">'+
          '<div class="mph-metric"><span class="mph-metric-label">Despachos 24h</span><span class="mph-metric-val">'+escapeHtml(String(c.dispatches_24h||0))+'</span></div>'+
          '<div class="mph-metric"><span class="mph-metric-label">Muestras lat.</span><span class="mph-metric-val">'+escapeHtml(String(c.latency_samples||0))+'</span></div>'+
          '<div class="mph-metric"><span class="mph-metric-label">Latencia p50</span><span class="mph-metric-val">'+escapeHtml(fmtMs(c.p50_ms))+(c.p50_ms!=null?'<span class="mph-unit">ms</span>':'')+'</span></div>'+
          '<div class="mph-metric"><span class="mph-metric-label">Latencia p95</span><span class="mph-metric-val">'+escapeHtml(fmtMs(c.p95_ms))+(c.p95_ms!=null?'<span class="mph-unit">ms</span>':'')+'</span></div>'+
        '</div>'+
        (errChips ? '<div class="mph-errclasses">'+errChips+'</div>' : '')+
        noData+
        '<div class="mph-card-actions">'+
          '<button class="mph-btn ghost" data-ping="'+escapeHtml(pid)+'">'+
            '<svg class="mph-icon" viewBox="0 0 24 24" aria-hidden="true"><use href="/assets/icons/sprite.svg#ic-conn-ok"></use></svg>Probar ahora</button>'+
          '<span class="mph-ping-result" id="mph-ping-'+escapeHtml(pid)+'"></span>'+
        '</div>'+
      '</div>';
  }).join('');
  el.querySelectorAll('button[data-ping]').forEach(b=>{
    b.addEventListener('click', ()=>pingProvider(b.getAttribute('data-ping')));
  });
}

// --- Acción "probar proveedor ahora" (CA-4) -------------------------------
async function pingProvider(provider){
  if(mphState.pinging[provider]) return; // debounce client-side (server tiene su propio control)
  mphState.pinging[provider]=true;
  const out=document.getElementById('mph-ping-'+provider);
  const btn=document.querySelector('button[data-ping="'+CSS.escape(provider)+'"]');
  if(btn) btn.disabled=true;
  if(out) out.textContent=' pingeando…';
  const target=pingableId(provider);
  const r=await authedPost('/api/multi-provider/ping/'+encodeURIComponent(target));
  mphState.pinging[provider]=false;
  if(btn) btn.disabled=false;
  if(r&&r.ok){
    const lat = r.latency_ms!=null ? fmtMs(r.latency_ms)+'ms' : 'ok';
    if(out){ out.textContent=' ✓ '+lat; out.style.color='var(--in-ok)'; }
    showToast('Ping a '+provider+': '+lat, true);
  } else {
    const reason = (r&&(r.reason||r.message||r.code))||'error';
    if(out){ out.textContent=' ✗ '+reason; out.style.color='var(--in-bad)'; }
    showToast('Ping a '+provider+' falló: '+reason, false);
  }
  // Refrescar métricas tras el ping puntual.
  await loadScreen();
  renderCards();
}

// --- Panel Sherlock (CA-3) ------------------------------------------------
function renderSherlock(){
  const el=document.getElementById('mph-sherlock'); if(!el) return;
  const s=mphState.sherlock;
  if(!s || s.pct==null){
    el.innerHTML='<div class="mph-empty">Sin evaluaciones de Sherlock en la ventana 24h.</div>';
    return;
  }
  const alert=!!s.alert;
  const pctTxt=escapeHtml(String(s.pct))+'%';
  const meta=escapeHtml(String(s.meta));
  const pos=Math.min(100, Math.max(0, s.pct));
  const metaPos=Math.min(100, Math.max(0, s.meta));
  const barColor = alert ? 'var(--in-bad)' : 'var(--in-ok)';
  // Barra SVG nativa con marca de meta punteada.
  const bar=''+
    '<svg viewBox="0 0 100 12" preserveAspectRatio="none" style="width:100%;height:18px" role="img" aria-label="same-provider '+pctTxt+', meta '+meta+'%">'+
      '<rect x="0" y="3" width="100" height="6" rx="3" fill="var(--in-bg-3)"></rect>'+
      '<rect x="0" y="3" width="'+pos+'" height="6" rx="3" fill="'+barColor+'"></rect>'+
      '<line x1="'+metaPos+'" y1="1" x2="'+metaPos+'" y2="11" stroke="var(--in-fg-dim)" stroke-width="0.6" stroke-dasharray="1.5 1.5"></line>'+
    '</svg>';
  el.innerHTML=''+
    '<div class="mph-sherlock-num '+(alert?'alert':'ok')+'">'+pctTxt+'</div>'+
    '<div>'+
      '<div class="mph-sherlock-badge '+(alert?'alert':'ok')+'">'+(alert?'supera meta':'dentro de meta')+'</div>'+
      '<div class="mph-sherlock-meta">meta &lt; '+meta+'% · '+escapeHtml(String(s.same))+'/'+escapeHtml(String(s.total))+' same-provider</div>'+
    '</div>'+
    '<div class="mph-sherlock-bar-wrap">'+bar+'</div>';
}

// --- Matriz proveedor×skill (CA-2) ----------------------------------------
function renderMatrix(){
  const el=document.getElementById('mph-matrix'); if(!el) return;
  const cfg=mphState.config;
  if(!cfg || !cfg.skills){ el.innerHTML='<tbody><tr><td class="mph-empty">Sin configuración de skills.</td></tr></tbody>'; return; }
  const provChip=(p, rank)=>{
    const token=providerToken(p);
    const isPrimary = rank===0;
    const rankLabel = isPrimary ? '1º' : (rank+1)+'º';
    return '<span class="mph-prov-chip '+(isPrimary?'primary':'fallback')+'" style="--row-accent:var('+token+')">'+
      providerIconSvg(p)+'<span>'+escapeHtml(p)+'</span><span class="mph-prov-rank">'+escapeHtml(rankLabel)+'</span></span>';
  };
  const skills=Object.keys(cfg.skills).sort();
  const rows=skills.map(name=>{
    const sk=cfg.skills[name]||{};
    const primary=sk.provider;
    const fallbacks=Array.isArray(sk.fallbacks)?sk.fallbacks:[];
    if(!primary && !fallbacks.length){
      return '<tr><td class="skill">'+escapeHtml(name)+'</td><td><span class="mph-nollm">sin LLM (determinista)</span></td></tr>';
    }
    const chain=[];
    if(primary) chain.push(provChip(primary, 0));
    fallbacks.forEach((f,i)=>{
      const fp = (f && typeof f==='object') ? f.provider : f;
      if(fp) chain.push('<span class="mph-arrow">→</span>'+provChip(fp, i+1));
    });
    return '<tr><td class="skill">'+escapeHtml(name)+'</td><td><span class="mph-chain">'+chain.join('')+'</span></td></tr>';
  }).join('');
  el.innerHTML='<thead><tr><th>Skill</th><th>Proveedor primario → cadena de fallback</th></tr></thead><tbody>'+rows+'</tbody>';
}

// --- Timeline (CA-5) ------------------------------------------------------
function eventKind(ev){
  const to=String(ev.to_state||'').toLowerCase();
  const from=String(ev.from_state||'').toLowerCase();
  if(to==='green') return 'recovery';
  if(to==='red') return 'exhaustion';
  if(to==='yellow'||from==='green') return 'gate';
  return 'gate';
}
function fmtClock(ms){
  if(!ms) return '—';
  try{ return new Date(ms).toLocaleTimeString('es-AR',{hour:'2-digit',minute:'2-digit'}); }catch(e){ return '—'; }
}
function renderTimeline(){
  const el=document.getElementById('mph-timeline'); if(!el) return;
  const evs=(mphState.timeline&&mphState.timeline.events)||[];
  if(!evs.length){ el.innerHTML='<div class="mph-empty">Sin transiciones de estado en la ventana 24h.</div>'; return; }
  // Más recientes arriba.
  const ordered=evs.slice().sort((a,b)=>(b.created_at||0)-(a.created_at||0));
  el.innerHTML=ordered.map(ev=>{
    const kind=eventKind(ev);
    const states=escapeHtml((ev.from_state||'?')+' → '+(ev.to_state||'?'));
    const reason=ev.reason_code?'<span class="mph-tl-reason">'+escapeHtml(ev.reason_code)+'</span>':'';
    const lat=ev.latency_ms!=null?'<span class="mph-tl-ts">'+escapeHtml(fmtMs(ev.latency_ms))+'ms</span>':'';
    return ''+
      '<div class="mph-tl-item">'+
        '<div class="mph-tl-dot '+kind+'"></div>'+
        '<div class="mph-tl-body">'+
          '<div class="mph-tl-line">'+
            providerIconSvg(ev.provider)+
            '<span class="mph-tl-prov">'+escapeHtml(ev.provider||'unknown')+'</span>'+
            '<span class="mph-tl-states">'+states+'</span>'+
            reason+lat+
          '</div>'+
        '</div>'+
        '<div class="mph-tl-ts">'+escapeHtml(fmtClock(ev.created_at))+'</div>'+
      '</div>';
  }).join('');
}

// --- Carga ----------------------------------------------------------------
async function loadScreen(){
  const r=await fetchJson('/api/multi-provider/health-screen');
  if(r&&r.ok) mphState.screen=r;
  return r;
}
async function loadAll(){
  setMsg('Cargando…');
  await fetchCsrf();
  const [screen, sherlock, timeline, cfg] = await Promise.all([
    fetchJson('/api/multi-provider/health-screen'),
    fetchJson('/api/multi-provider/sherlock-pct'),
    fetchJson('/api/multi-provider/health-timeline'),
    fetchJson('/api/multi-provider/config'),
  ]);
  if(screen&&screen.ok) mphState.screen=screen;
  if(sherlock&&sherlock.ok) mphState.sherlock=sherlock;
  if(timeline&&timeline.ok) mphState.timeline=timeline;
  if(cfg&&cfg.config) mphState.config=cfg.config;
  renderCards(); renderSherlock(); renderMatrix(); renderTimeline();
  const ts=(mphState.screen&&mphState.screen.ts)?new Date(mphState.screen.ts).toLocaleTimeString('es-AR'):'—';
  setMsg('Actualizado '+ts);
  const clk=document.getElementById('hdr-clock'); if(clk){ try{ clk.textContent=new Date().toLocaleTimeString('es-AR'); }catch(e){} }
}

document.addEventListener('DOMContentLoaded', ()=>{
  loadAll();
  setInterval(loadAll, 30000); // polling 30s (refresco natural)
});
`;

function renderMultiProviderHealth() {
    const theme = loadCssFile(THEME_CSS_PATH);
    const tokens = loadCssFile(DESIGN_TOKENS_PATH);
    const spriteInline = loadIconSprite();
    const navHtml = renderNavTabsSsr('mp-health');
    return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Intrale · Salud Multi-Provider</title>
<style>${tokens}</style>
<style>${theme}</style>
<style>
${PANEL_CSS}
</style>
</head>
<body>
<div aria-hidden="true" style="position:absolute;width:0;height:0;overflow:hidden">${spriteInline}</div>
<div class="mph-frame">
  <header class="in-header">
    <div class="in-header-brand">
      <div class="in-header-logo">i</div>
      <div>
        <div class="in-header-title">Salud Multi-Provider</div>
        <div class="in-header-subtitle">Salud, latencia, despachos, errores, matriz y vigilancia Sherlock</div>
      </div>
    </div>
    <div class="in-header-meta">
      <span class="in-clock" id="hdr-clock">${new Date().toLocaleTimeString('es-AR')}</span>
    </div>
  </header>
  ${navHtml}
  <main class="mph-body">${bodyHtml()}</main>
  <footer class="in-footer">
    <span>Solo lectura · datos agregados de la ventana 24h</span>
    <span>Intrale V3 · EP8-H12 · #3965</span>
  </footer>
</div>
<script>${CLIENT_JS}</script>
</body>
</html>`;
}

module.exports = {
    renderMultiProviderHealth,
    bodyHtml,
    PANEL_CSS,
    CLIENT_JS,
    PROVIDER_ORDER,
};
