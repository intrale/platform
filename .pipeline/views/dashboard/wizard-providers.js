// =============================================================================
// wizard-providers.js — Vista SSR del wizard "Configurar / rotar provider".
//
// Issue #3740 (split de #3715). Render server-side de los 4 pasos del wizard
// (provider → acción → key → confirmación) descritos por el mockup de UX
// (`assets/mockups/25-wizard-providers-rotate.svg`). NO diseña: ensambla los
// tokens y el contrato visual ya firmados por `ux` en `criterios`.
//
// Política `feedback_api-keys-terminal-only`: el wizard NO crea keys nuevas.
// El step 2 ofrece EXACTAMENTE tres acciones — Ver metadata / Rotar key
// existente / Desactivar — y muestra un banner recordando que el set inicial de
// una key nueva se hace por terminal Windows (`setx <PROVIDER>_API_KEY ...`).
//
// Seguridad (heredada de #3722/#3724):
//   - Todo dato dinámico se escapa con `escapeHtmlText` / `escapeHtmlAttr`.
//   - El token CSRF va en `<meta name="csrf-token">`; la cookie HttpOnly la setea
//     el handler GET de dashboard.js. El cliente lo manda en `X-CSRF-Token`.
//   - La API key se ingresa en `<input type="password">` con toggle
//     press-to-view; NUNCA se persiste en localStorage / sessionStorage; el
//     `wizard_session_id` vive sólo en memoria del cliente.
//   - El backend devuelve SIEMPRE masking `sk-•••••<last4>`; el render nunca
//     reconstruye la key completa.
//
// El slug `providers` ya lo ocupa la ventana-panel multi-provider, así que el
// wizard se sirve en la ruta dedicada `/dashboard/wizard/providers` (GET).
// =============================================================================
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { escapeHtmlText, escapeHtmlAttr } = require('../../lib/escape-html.js');
const providersFlow = require('../../lib/wizards/providers');

let renderNavTabsSsr = () => '';
let loadIconSprite = () => '';
try {
    // eslint-disable-next-line global-require
    const nav = require('./nav-tabs');
    if (typeof nav.renderNavTabsSsr === 'function') renderNavTabsSsr = nav.renderNavTabsSsr;
    if (typeof nav.loadIconSprite === 'function') loadIconSprite = nav.loadIconSprite;
} catch { /* nav opcional en tests */ }

const THEME_CSS_PATH = path.join(__dirname, 'theme.css');
function loadTheme() {
    try { return fs.readFileSync(THEME_CSS_PATH, 'utf8'); } catch { return ''; }
}

const STEP_API = '/dashboard/wizard/providers/step';

// Nombres de provider — NO son secretos (la key sí). Se derivan de ENV_MAPPING
// vía el flow (fuente única, sin hardcoding — CA-1).
function providerNames() {
    try { return providersFlow.listProviders().map((p) => p.name); } catch { return []; }
}

const WIZARD_CSS = `
.wz-frame { max-width: 920px; margin: 0 auto; padding: 22px 28px; display:flex; flex-direction:column; gap:18px; }
.wz-stepper { display:flex; gap:10px; align-items:center; justify-content:center; margin: 4px 0 8px; }
.wz-dot { width:12px; height:12px; border-radius:50%; background:var(--in-line,#30363d); }
.wz-dot.is-active { background:var(--retry,#f59e0b); box-shadow:0 0 0 4px color-mix(in srgb, var(--retry,#f59e0b) 25%, transparent); }
.wz-dot.is-done { background:var(--in-ok,#3fb950); }
.wz-step-title { font-size:1.1rem; margin:0 0 4px; }
.wz-step-desc { color:var(--text-dim,#9da7b3); margin:0 0 12px; }
.wz-banner { padding:10px 14px; border-radius:8px; background:var(--in-surface-2,#161b22); border:1px solid var(--retry,#f59e0b); color:var(--text,#c9d1d9); font-size:0.85rem; margin:10px 0; }
.wz-banner code { background:var(--in-surface,#0d1117); padding:1px 6px; border-radius:4px; }
.wz-actions { display:flex; justify-content:space-between; gap:12px; margin-top:18px; }
.wz-btn { min-height:44px; min-width:96px; padding:0 18px; border-radius:8px; border:1px solid var(--in-line,#30363d); background:var(--in-surface-2,#161b22); color:var(--text,#c9d1d9); cursor:pointer; font-size:0.92rem; }
.wz-btn-primary { background:var(--retry,#f59e0b); border-color:var(--retry,#f59e0b); color:#1c2128; font-weight:600; }
.wz-btn:disabled { opacity:0.45; cursor:not-allowed; }
.wz-errors { margin:10px 0; padding:10px 14px; border-radius:8px; background:var(--in-bad-soft,rgba(248,81,73,0.12)); border:1px solid var(--in-bad,#f85149); color:var(--in-bad,#f85149); font-size:0.86rem; }
.wz-errors ul { margin:6px 0 0; padding-left:18px; }
.wz-card { display:block; width:100%; text-align:left; padding:12px 14px; margin:8px 0; border-radius:8px; border:1px solid var(--in-line,#30363d); background:var(--in-surface-2,#161b22); color:var(--text,#c9d1d9); cursor:pointer; }
.wz-card.is-rotate { border-color:var(--retry,#f59e0b); }
.wz-card.is-selected { outline:2px solid var(--retry,#f59e0b); }
.wz-key-row { display:flex; gap:8px; align-items:center; }
.wz-key-input { flex:1; padding:10px; border-radius:6px; border:1px solid var(--in-line,#30363d); background:var(--in-surface,#0d1117); color:var(--text,#c9d1d9); font-family:'SF Mono',Consolas,monospace; }
.wz-toggle { min-height:44px; padding:0 14px; border-radius:6px; border:1px solid var(--in-line,#30363d); background:var(--in-surface-2,#161b22); color:var(--text,#c9d1d9); cursor:pointer; }
.wz-diff { padding:12px 14px; border-radius:8px; background:var(--in-surface-2,#161b22); border:1px solid var(--in-line,#30363d); }
.wz-diff code { background:var(--in-surface,#0d1117); padding:1px 6px; border-radius:4px; }
`;

// Banner terminal-only (texto literal exigido por memoria feedback_api-keys-terminal-only).
function terminalBanner() {
    return `<div class="wz-banner">Para configurar un proveedor por primera vez, ejecutá <code>setx &lt;PROVIDER&gt;_API_KEY ...</code> en la terminal de Windows. Este wizard sólo permite <strong>ver metadata</strong>, <strong>rotar</strong> o <strong>desactivar</strong> keys ya existentes — nunca crear una nueva.</div>`;
}

function renderProviderOptions() {
    return providerNames()
        .map((n) => `<option value="${escapeHtmlAttr(n)}">${escapeHtmlText(n)}</option>`)
        .join('');
}

// Cliente: navega los 4 pasos, postea al step API y renderiza preview masked.
// `wizard_session_id` SOLO en memoria — NUNCA localStorage / sessionStorage.
// La key se ingresa en un input password con toggle press-to-view y NO se
// guarda en ninguna variable persistente.
const WIZARD_CLIENT_JS = `
(function(){
  var STEP_API = ${JSON.stringify(STEP_API)};
  var TOTAL = 4;
  var current = 1;
  var sessionId = null;
  var state = { provider: null, action: null };

  function csrfToken(){
    var m = document.querySelector('meta[name="csrf-token"]');
    return m ? m.getAttribute('content') : '';
  }
  function esc(s){ return String(s==null?'':s).replace(/[&<>"']/g, function(c){ return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]); }); }

  function postStep(step, params){
    return fetch(STEP_API, {
      method:'POST',
      headers:{ 'Content-Type':'application/json', 'X-CSRF-Token': csrfToken() },
      credentials:'same-origin',
      body: JSON.stringify({ step: step, wizard_session_id: sessionId, params: params || {} })
    }).then(function(r){ return r.json().then(function(j){ return { status:r.status, json:j }; }).catch(function(){ return { status:r.status, json:null }; }); });
  }

  function showErrors(stepN, errs){
    var body = document.querySelector('[data-step-body="'+stepN+'"]');
    if(!body) return;
    var ex = body.querySelector('.wz-errors'); if(ex) ex.remove();
    if(!errs || !errs.length) return;
    var div = document.createElement('div'); div.className='wz-errors';
    div.innerHTML = '<strong>No se pudo continuar:</strong><ul>' + errs.map(function(e){ return '<li>'+esc(e)+'</li>'; }).join('') + '</ul>';
    body.insertBefore(div, body.firstChild);
  }

  function commonErr(stepN, r){
    if(r.status===403){ showErrors(stepN, ['Sesión no autorizada (CSRF/origen). Recargá la página.']); return true; }
    if(r.status===410){ showErrors(stepN, ['La sesión expiró (15 min). Recargá para reiniciar el wizard.']); return true; }
    if(r.status===409){ showErrors(stepN, ['Datos inválidos para este paso.']); return true; }
    if(r.status!==200 || !r.json){ showErrors(stepN, ['Error inesperado del servidor ('+r.status+').']); return true; }
    return false;
  }

  function setStep(n){
    current = n;
    document.querySelectorAll('.wz-step').forEach(function(s){
      s.hidden = (parseInt(s.getAttribute('data-step'),10) !== n);
    });
    document.querySelectorAll('.wz-dot').forEach(function(d,i){
      d.classList.toggle('is-active', (i+1)===n);
      d.classList.toggle('is-done', (i+1)<n);
    });
    var back = document.getElementById('wz-back'); if(back) back.disabled = (n===1);
    var next = document.getElementById('wz-next');
    if(next) next.textContent = (n===TOTAL) ? (state.action==='rotate' ? 'Confirmar rotación' : (state.action==='deactivate' ? 'Confirmar desactivación' : 'Cerrar')) : 'Siguiente';
  }

  // --- Toggle press-to-view del input password (CA-3) -----------------------
  function wireToggle(){
    var btn = document.querySelector('[data-action="toggle-password"]');
    var inp = document.querySelector('input[name="api_key"]');
    if(!btn || !inp) return;
    var show = function(){ inp.type = 'text'; };
    var hide = function(){ inp.type = 'password'; };
    btn.addEventListener('mousedown', show);
    btn.addEventListener('mouseup', hide);
    btn.addEventListener('mouseleave', hide);
    btn.addEventListener('blur', hide);
  }

  function postProvider(){
    var sel = document.getElementById('wz-provider');
    state.provider = sel ? sel.value : null;
    return postStep(0, { provider: state.provider }).then(function(r){
      if(commonErr(1, r)) return false;
      if(r.json.wizard_session_id) sessionId = r.json.wizard_session_id;
      showErrors(1, []);
      return true;
    });
  }

  function postAction(){
    return postStep(1, { provider: state.provider, action: state.action }).then(function(r){
      if(commonErr(2, r)) return false;
      showErrors(2, []);
      return true;
    });
  }

  function postKeyOrMeta(){
    var params = { provider: state.provider, action: state.action };
    if(state.action==='rotate'){
      var inp = document.querySelector('input[name="api_key"]');
      params.api_key = inp ? inp.value : '';
    }
    return postStep(2, params).then(function(r){
      if(r.status===409 && state.action==='rotate'){ showErrors(3, ['El formato de la key no es válido para '+esc(state.provider)+'.']); return false; }
      if(commonErr(3, r)) return false;
      showErrors(3, []);
      renderConfirm(r.json.result || {});
      return true;
    });
  }

  function renderConfirm(res){
    var body = document.querySelector('[data-step-body="4"]'); if(!body) return;
    var html = '<div class="wz-diff">';
    if(state.action==='rotate'){
      html += '<p>Antes: <code>'+esc(res.masked_old || 'sin key')+'</code> → Después: <code>'+esc(res.masked_new || '')+'</code></p>';
    } else if(state.action==='deactivate'){
      html += '<p>Vas a <strong>desactivar</strong> '+esc(state.provider)+' (actual: <code>'+esc(res.masked_old || 'sin key')+'</code>). El orquestador multi-provider lo saltea.</p>';
    } else {
      html += '<p>Metadata de '+esc(state.provider)+': <code>'+esc(res.masked_old || 'sin key — usar terminal Windows')+'</code></p>';
    }
    html += '</div>';
    body.innerHTML = html;
  }

  function postConfirm(){
    if(state.action==='metadata'){
      // metadata no muta: el step 4 es informativo. Cerramos sin POST destructivo.
      return postStep(3, { provider: state.provider, action: 'metadata', confirm: true }).then(function(r){
        if(commonErr(4, r)) return false;
        showErrors(4, []);
        var nb=document.getElementById('wz-next'); if(nb) nb.disabled=true;
        return true;
      });
    }
    return postStep(3, { provider: state.provider, action: state.action, confirm: true }).then(function(r){
      if(commonErr(4, r)) return false;
      var res = r.json.result || {};
      showErrors(4, []);
      var body = document.querySelector('[data-step-body="4"]');
      if(body){ body.innerHTML += '<p style="margin-top:12px;color:var(--in-ok,#3fb950)">✓ '+(state.action==='rotate'?'Key rotada.':'Provider desactivado.')+'</p>'; }
      var nb=document.getElementById('wz-next'); if(nb) nb.disabled=true;
      var bb=document.getElementById('wz-back'); if(bb) bb.disabled=true;
      return true;
    });
  }

  function renderActionStep(){
    var body = document.querySelector('[data-step-body="2"]'); if(!body) return;
    body.innerHTML =
        '<button type="button" class="wz-card" data-act="metadata">Ver metadata <span class="wz-step-desc">— ver last4 y estado, sin cambios.</span></button>'
      + '<button type="button" class="wz-card is-rotate" data-act="rotate">Rotar key existente <span class="wz-step-desc">— reemplazar la key vigente por una nueva.</span></button>'
      + '<button type="button" class="wz-card" data-act="deactivate">Desactivar <span class="wz-step-desc">— anular la key del provider.</span></button>';
    body.querySelectorAll('.wz-card').forEach(function(c){
      c.addEventListener('click', function(){
        state.action = c.getAttribute('data-act');
        body.querySelectorAll('.wz-card').forEach(function(x){ x.classList.remove('is-selected'); });
        c.classList.add('is-selected');
      });
    });
  }

  function renderKeyStep(){
    var body = document.querySelector('[data-step-body="3"]'); if(!body) return;
    if(state.action==='rotate'){
      body.innerHTML =
          '<label style="display:block;margin-bottom:6px">Nueva API key para '+esc(state.provider)+'</label>'
        + '<div class="wz-key-row">'
        + '<input class="wz-key-input" type="password" name="api_key" autocomplete="off" spellcheck="false" placeholder="pegá la key">'
        + '<button type="button" class="wz-toggle" data-action="toggle-password" aria-label="Mantené presionado para ver la key">👁 ver</button>'
        + '</div>'
        + '<p class="wz-step-desc" style="margin-top:8px">La key no se loguea y no se guarda en el navegador. Mantené presionado “ver” para mostrarla.</p>';
      wireToggle();
    } else {
      body.innerHTML = '<p class="wz-step-desc">La acción “'+esc(state.action)+'” no requiere ingresar una key. Continuá a la confirmación.</p>';
    }
  }

  function onNext(){
    if(current===1){
      postProvider().then(function(ok){ if(ok){ setStep(2); renderActionStep(); } });
    } else if(current===2){
      if(!state.action){ showErrors(2, ['Elegí una acción.']); return; }
      postAction().then(function(ok){ if(ok){ setStep(3); renderKeyStep(); } });
    } else if(current===3){
      postKeyOrMeta().then(function(ok){ if(ok){ setStep(4); } });
    } else {
      postConfirm();
    }
  }

  function init(){
    var next = document.getElementById('wz-next');
    var back = document.getElementById('wz-back');
    if(next) next.addEventListener('click', onNext);
    if(back) back.addEventListener('click', function(){ if(current>1){ var nb=document.getElementById('wz-next'); if(nb){ nb.disabled=false; } setStep(current-1); } });
    setStep(1);
  }
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
`;

const STEP_DEFS = [
    { n: 1, title: 'Seleccionar proveedor', desc: 'Elegí el provider IA cuya key querés ver, rotar o desactivar.' },
    { n: 2, title: 'Elegir acción', desc: 'Ver metadata, rotar la key existente o desactivar el provider. No se crean keys nuevas desde acá.' },
    { n: 3, title: 'Ingresar key', desc: 'Sólo para rotar: pegá la nueva key. Se valida el formato en el servidor sin loguearla.' },
    { n: 4, title: 'Confirmación', desc: 'Revisá el masking antes/después y confirmá con un segundo click.' },
];

function renderStepSection(def) {
    const banner = (def.n === 1 || def.n === 2) ? terminalBanner() : '';
    let bodyInit = '';
    if (def.n === 1) {
        bodyInit = `<label style="display:block;margin-bottom:6px">Proveedor</label>
<select id="wz-provider" name="provider" class="wz-key-input">${renderProviderOptions()}</select>`;
    }
    return `<section class="wz-step" data-step="${def.n}" ${def.n === 1 ? '' : 'hidden'}>
  <h2 class="wz-step-title">Paso ${def.n} de 4 · ${escapeHtmlText(def.title)}</h2>
  <p class="wz-step-desc">${escapeHtmlText(def.desc)}</p>
  ${banner}
  <div class="wz-step-body" data-step-body="${def.n}">${bodyInit}</div>
</section>`;
}

/**
 * Documento HTML completo del wizard. `opts.csrfToken` es el token derivado que
 * el handler GET de dashboard.js calcula con la cookie HttpOnly emitida.
 * @param {{csrfToken?:string}} opts
 * @returns {string}
 */
function renderWizardProviders(opts) {
    const o = opts || {};
    const theme = loadTheme();
    const spriteInline = loadIconSprite();
    let navHtml = '';
    try { navHtml = renderNavTabsSsr('providers'); } catch { navHtml = ''; }
    const csrf = escapeHtmlAttr(o.csrfToken || '');
    const stepper = STEP_DEFS.map((d, i) =>
        `<span class="wz-dot${i === 0 ? ' is-active' : ''}" aria-hidden="true"></span>`).join('');
    const sections = STEP_DEFS.map(renderStepSection).join('\n');

    return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="csrf-token" content="${csrf}">
<title>Intrale · Configurar / rotar provider</title>
<style>${theme}</style>
<style>${WIZARD_CSS}</style>
</head>
<body>
<div aria-hidden="true" style="position:absolute;width:0;height:0;overflow:hidden">${spriteInline}</div>
<div class="wz-frame">
  <header>
    <h1 style="margin:0 0 2px;font-size:1.3rem">Configurar / rotar provider</h1>
    <p style="margin:0;color:var(--text-dim,#9da7b3)">Wizard guiado · provider, acción, key y confirmación</p>
  </header>
  ${navHtml}
  <div class="wz-stepper" role="progressbar" aria-valuemin="1" aria-valuemax="4" aria-valuenow="1">${stepper}</div>
  <main>
    ${sections}
    <div class="wz-actions">
      <button type="button" class="wz-btn" id="wz-back" disabled>Atrás</button>
      <button type="button" class="wz-btn wz-btn-primary" id="wz-next">Siguiente</button>
    </div>
  </main>
</div>
<script>${WIZARD_CLIENT_JS}</script>
</body>
</html>`;
}

module.exports = {
    renderWizardProviders,
    renderStepSection,
    terminalBanner,
    STEP_DEFS,
    slug: 'wizard-providers',
};
