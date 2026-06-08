// =============================================================================
// wizard-ola.js — Vista SSR del wizard "Crear nueva ola de trabajo".
//
// Issue #3738 (split de #3715). Render server-side de los 3 pasos del wizard
// (seleccionar issues → configurar concurrencia/ventana → preview + confirmar).
// NO diseña: ensambla los tokens y el contrato visual de V3 ya firmados
// (`assets/design-tokens.css` + `theme.css`).
//
// Seguridad:
//   - Todo dato dinámico se escapa con `escapeHtmlText` / `escapeHtmlAttr` del
//     helper compartido `lib/escape-html.js` (#3722). Prohibido innerHTML crudo
//     server-side (R7/XSS). Tooltips y labels son constantes locales estáticas,
//     nunca echo del input.
//   - El token CSRF se inyecta en `<meta name="csrf-token">` y la cookie
//     HttpOnly la setea el handler GET de dashboard.js (la base #3724 deriva el
//     token con HMAC sobre la cookie). El cliente lo manda en `X-CSRF-Token` en
//     cada POST a `/dashboard/wizard/ola/step`.
//
// El wizard se sirve en la ruta dedicada `/dashboard/wizard/ola` (GET) y NO se
// registra en el allowlist `?view=` del router cliente mientras #3723 no esté
// en HEAD. TODO #3723: migrar a `?view=wizard-ola`.
// =============================================================================
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { escapeHtmlText, escapeHtmlAttr } = require('../../lib/escape-html.js');

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

const STEP_API = '/dashboard/wizard/ola/step';

// Definición declarativa de los 3 pasos (títulos + tooltips en español). Texto
// 100% estático: nunca se interpola input del operador.
const STEP_DEFS = [
    {
        n: 1,
        title: 'Seleccionar issues',
        desc: 'Elegí los issues que van a integrar la nueva ola. Sólo se aceptan issues elegibles: los que no están ya en la ola activa ni en otra ola planificada.',
        tooltips: [
            ['Issues elegibles', 'Un issue sólo puede pertenecer a una ola a la vez. Si ya está en la activa o en una planificada, se rechaza al confirmar.'],
            ['Filtros', 'Podés filtrar los candidatos por label y prioridad. El filtro es del lado del cliente; la elegibilidad se valida server-side.'],
            ['Cantidad', 'Hasta 200 issues por ola. La lista se normaliza a enteros positivos únicos.'],
        ],
    },
    {
        n: 2,
        title: 'Concurrencia y ventana',
        desc: 'Definí el nombre de la ola, cuántos agentes corren en paralelo y la duración objetivo de la ventana.',
        tooltips: [
            ['Nombre de la ola', 'Identificador legible. NFC, máximo 80 caracteres. No edita olas existentes; debe ser único.'],
            ['Concurrencia', 'Agentes en paralelo. Acotado server-side a [1, MAX_CONFIGURED] leído de config.yaml — nunca del formulario.'],
            ['Ventana (minutos)', 'Duración objetivo de la ola. Rango válido [5, 1440] minutos.'],
        ],
    },
    {
        n: 3,
        title: 'Preview y confirmación',
        desc: 'Revisá el resumen de la ola que estás por crear y confirmá. La creación es atómica y queda registrada en el audit log.',
        tooltips: [
            ['Preview', 'Resumen calculado server-side: issues seleccionados + configuración. Es lo que se va a persistir.'],
            ['Re-validación', 'Si otro flujo modificó las olas entre el preview y la confirmación, se aborta con 409 y tenés que recalcular (anti-TOCTOU).'],
            ['Audit', 'Cada confirmación deja una entrada encadenada (SHA-256) con action "crear_ola" en wizard-audit-<fecha>.ndjson.'],
        ],
    },
];

function renderTooltip(label, body) {
    const id = 'tt-' + escapeHtmlAttr(String(label).toLowerCase().replace(/[^a-z0-9]+/g, '-'));
    return `<span class="wz-tip">
  <button type="button" class="wz-tip-btn" aria-describedby="${id}" aria-label="Ayuda: ${escapeHtmlAttr(label)}">?</button>
  <span class="wz-tip-body" role="tooltip" id="${id}">
    <strong>${escapeHtmlText(label)}</strong>
    <span>${escapeHtmlText(body)}</span>
  </span>
</span>`;
}

function renderStepSection(def) {
    const tooltips = (def.tooltips || []).map(([l, b]) => renderTooltip(l, b)).join('\n');
    return `<section class="wz-step" data-step="${def.n}" ${def.n === 1 ? '' : 'hidden'}>
  <h2 class="wz-step-title">Paso ${def.n} · ${escapeHtmlText(def.title)}</h2>
  <p class="wz-step-desc">${escapeHtmlText(def.desc)}</p>
  <div class="wz-tips">${tooltips}</div>
  <div class="wz-step-body" data-step-body="${def.n}"></div>
</section>`;
}

/**
 * Render server-side del bloque de preview del Paso 3. Escapa TODO dato dinámico
 * (nombre de la ola, issues) con `escapeHtmlText` — nunca emite el valor crudo
 * (R7/XSS). Reutilizable también desde el cliente vía el mismo contrato.
 *
 * @param {{name?:string, issues?:number[], concurrencia?:number, ventana_minutos?:number}} data
 * @returns {string} fragmento HTML escapado.
 */
function renderPreview(data) {
    const d = data || {};
    const name = typeof d.name === 'string' ? d.name : '';
    const issues = Array.isArray(d.issues) ? d.issues : [];
    const issuesHtml = issues.length
        ? issues.map((n) => `<code>#${escapeHtmlText(String(n))}</code>`).join(' ')
        : '<span class="wz-preview-empty">Sin issues seleccionados.</span>';
    return `<div class="wz-preview">
  <p class="wz-preview-line"><strong>Nombre:</strong> ${escapeHtmlText(name)}</p>
  <p class="wz-preview-line"><strong>Issues (${escapeHtmlText(String(issues.length))}):</strong> ${issuesHtml}</p>
  <p class="wz-preview-line"><strong>Concurrencia:</strong> <code>${escapeHtmlText(String(d.concurrencia == null ? '' : d.concurrencia))}</code></p>
  <p class="wz-preview-line"><strong>Ventana:</strong> <code>${escapeHtmlText(String(d.ventana_minutos == null ? '' : d.ventana_minutos))}</code> min</p>
</div>`;
}

const WIZARD_CSS = `
.wz-frame { max-width: 920px; margin: 0 auto; padding: 22px 28px; display:flex; flex-direction:column; gap:18px; }
.wz-stepper { display:flex; gap:10px; align-items:center; justify-content:center; margin: 4px 0 8px; }
.wz-dot { width:12px; height:12px; border-radius:50%; background:var(--in-line,#30363d); }
.wz-dot.is-active { background:var(--brand,#6e9bff); box-shadow:0 0 0 4px color-mix(in srgb, var(--brand,#6e9bff) 25%, transparent); }
.wz-dot.is-done { background:var(--in-ok,#3fb950); }
.wz-step-title { font-size:1.1rem; margin:0 0 4px; }
.wz-step-desc { color:var(--text-dim,#9da7b3); margin:0 0 12px; }
.wz-tips { display:flex; flex-wrap:wrap; gap:8px; margin-bottom:14px; }
.wz-tip { position:relative; display:inline-block; }
.wz-tip-btn { width:22px; height:22px; min-width:22px; border-radius:50%; border:1px solid var(--in-line,#30363d); background:transparent; color:var(--text,#c9d1d9); cursor:help; font-weight:700; }
.wz-tip-btn:focus-visible { outline:2px solid var(--brand,#6e9bff); outline-offset:2px; }
.wz-tip-body { position:absolute; left:0; top:130%; z-index:20; width:260px; padding:10px 12px; border-radius:8px; background:var(--in-surface-2,#161b22); border:1px solid var(--in-line,#30363d); color:var(--text,#c9d1d9); font-size:0.82rem; line-height:1.4; display:none; flex-direction:column; gap:4px; box-shadow:0 6px 20px rgba(0,0,0,0.4); }
.wz-tip:hover .wz-tip-body, .wz-tip:focus-within .wz-tip-body { display:flex; }
.wz-actions { display:flex; justify-content:space-between; gap:12px; margin-top:18px; }
.wz-btn { min-height:44px; min-width:96px; padding:0 18px; border-radius:8px; border:1px solid var(--in-line,#30363d); background:var(--in-surface-2,#161b22); color:var(--text,#c9d1d9); cursor:pointer; font-size:0.92rem; }
.wz-btn-primary { background:var(--brand,#6e9bff); border-color:var(--brand,#6e9bff); color:#04101f; font-weight:600; }
.wz-btn:disabled { opacity:0.45; cursor:not-allowed; }
.wz-errors { margin:10px 0; padding:10px 14px; border-radius:8px; background:var(--in-bad-soft,rgba(248,81,73,0.12)); border:1px solid var(--in-bad,#f85149); color:var(--in-bad,#f85149); font-size:0.86rem; }
.wz-errors ul { margin:6px 0 0; padding-left:18px; }
.wz-preview { padding:12px 14px; border-radius:8px; background:var(--in-surface-2,#161b22); border:1px solid var(--in-line,#30363d); }
.wz-preview code { background:var(--in-surface,#0d1117); padding:1px 5px; border-radius:4px; }
.wz-field { display:block; margin:8px 0; }
.wz-field input { display:block; width:100%; margin-top:4px; padding:8px; border-radius:6px; border:1px solid var(--in-line,#30363d); background:var(--in-surface,#0d1117); color:var(--text,#c9d1d9); }
`;

// Cliente: navegación entre pasos, POST al step API y render del preview.
// Mantiene `wizard_session_id` en memoria (no localStorage: CSRF HttpOnly +
// sesión server-side). El "atrás" no re-postea (idempotente).
const WIZARD_CLIENT_JS = `
(function(){
  var STEP_API = ${JSON.stringify(STEP_API)};
  var TOTAL = 3;
  var current = 1;
  var sessionId = null;
  var lastSnapshot = null;

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
    }).then(function(r){ return r.json().then(function(j){ return { status:r.status, json:j }; }, function(){ return { status:r.status, json:null }; }); });
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

  function setStep(n){
    current = n;
    document.querySelectorAll('.wz-step').forEach(function(s){
      s.hidden = (parseInt(s.getAttribute('data-step'),10) !== n);
    });
    document.querySelectorAll('.wz-dot').forEach(function(d,i){
      d.classList.toggle('is-active', (i+1)===n);
      d.classList.toggle('is-done', (i+1)<n);
    });
    var back = document.getElementById('wz-back');
    if(back) back.disabled = (n===1);
    var next = document.getElementById('wz-next');
    if(next) next.textContent = (n===TOTAL) ? 'Confirmar' : 'Siguiente';
  }

  function readIssues(){
    var el = document.getElementById('wz-issues');
    if(!el || !el.value) return [];
    return el.value.split(/[^0-9]+/).filter(Boolean).map(function(x){ return parseInt(x,10); });
  }

  function commonErr(stepN, r){
    if(r.status===403){ showErrors(stepN, ['Sesión no autorizada (CSRF/origen). Recargá la página.']); return true; }
    if(r.status===410){ showErrors(stepN, ['La sesión expiró (15 min). Recargá para reiniciar el wizard.']); return true; }
    if(r.status===429){ showErrors(stepN, ['Demasiados intentos. Esperá un momento y reintentá.']); return true; }
    if(r.status!==200 || !r.json){
      if(r.status===409){ showErrors(stepN, ['No se pudo validar este paso. Revisá los datos.']); return true; }
      showErrors(stepN, ['Error inesperado del servidor ('+r.status+').']); return true;
    }
    return false;
  }

  function postSelect(){
    // El step 0 crea SIEMPRE una sesión fresca (anti-fixation).
    return postStep(0, { issues: readIssues() }).then(function(r){
      if(r.status===409){ showErrors(1, ['Hay issues no elegibles (ya están en otra ola) o la lista es inválida.']); return false; }
      if(commonErr(1, r)) return false;
      if(r.json.wizard_session_id) sessionId = r.json.wizard_session_id;
      showErrors(1, []);
      return true;
    });
  }

  function postConfig(){
    var name = (document.getElementById('wz-name')||{}).value || '';
    var conc = parseInt((document.getElementById('wz-conc')||{}).value, 10);
    var win = parseInt((document.getElementById('wz-win')||{}).value, 10);
    return postStep(1, { name: name, concurrency_max: conc, window_minutes: win }).then(function(r){
      if(r.status===409){ showErrors(2, ['Configuración inválida: revisá el nombre (único, ≤80), la concurrencia y la ventana.']); return false; }
      if(commonErr(2, r)) return false;
      var res = r.json.result || {};
      lastSnapshot = res.previous_snapshot || null;
      renderPreviewSlot(res.preview || {});
      showErrors(2, []);
      return true;
    });
  }

  function renderPreviewSlot(preview){
    var body = document.querySelector('[data-step-body="3"]'); if(!body) return;
    var issues = Array.isArray(preview.issues) ? preview.issues : [];
    var issuesHtml = issues.length ? issues.map(function(n){ return '<code>#'+esc(n)+'</code>'; }).join(' ') : '<span>—</span>';
    body.innerHTML = '<div class="wz-preview">'
      + '<p class="wz-preview-line"><strong>Nombre:</strong> '+esc(preview.name)+'</p>'
      + '<p class="wz-preview-line"><strong>Issues ('+esc(issues.length)+'):</strong> '+issuesHtml+'</p>'
      + '<p class="wz-preview-line"><strong>Concurrencia:</strong> <code>'+esc(preview.concurrencia)+'</code></p>'
      + '<p class="wz-preview-line"><strong>Ventana:</strong> <code>'+esc(preview.ventana_minutos)+'</code> min</p>'
      + '</div>';
  }

  function postConfirm(){
    return postStep(2, { confirm: true, previous_snapshot: lastSnapshot }).then(function(r){
      if(r.status===409){ showErrors(3, ['El estado de las olas cambió desde el preview. Volvé al paso 1 y recalculá.']); return false; }
      if(commonErr(3, r)) return false;
      var res = r.json.result || {};
      if(res.ok!==true){ showErrors(3, ['No se pudo crear la ola.']); return false; }
      showErrors(3, []);
      var body = document.querySelector('[data-step-body="3"]');
      if(body) body.innerHTML += '<p style="margin-top:12px;color:var(--in-ok,#3fb950)">✓ Ola #'+esc(res.wave_id)+' creada.</p>';
      var nb=document.getElementById('wz-next'); if(nb) nb.disabled=true;
      var bb=document.getElementById('wz-back'); if(bb) bb.disabled=true;
      return true;
    });
  }

  function onNext(){
    if(current===1){ postSelect().then(function(ok){ if(ok) setStep(2); }); }
    else if(current===2){ postConfig().then(function(ok){ if(ok) setStep(3); }); }
    else { postConfirm(); }
  }

  function init(){
    var s1 = document.querySelector('[data-step-body="1"]');
    if(s1){
      s1.innerHTML = '<label class="wz-field">Issues (números separados por coma o espacio)'
        + '<input id="wz-issues" type="text" inputmode="numeric" placeholder="3801, 3802, 3803"></label>';
    }
    var s2 = document.querySelector('[data-step-body="2"]');
    if(s2){
      s2.innerHTML = '<label class="wz-field">Nombre de la ola<input id="wz-name" type="text" maxlength="80" placeholder="Ola N+9"></label>'
        + '<label class="wz-field">Concurrencia<input id="wz-conc" type="number" min="1" step="1" value="3"></label>'
        + '<label class="wz-field">Ventana (minutos)<input id="wz-win" type="number" min="5" max="1440" step="5" value="60"></label>';
    }
    var next = document.getElementById('wz-next');
    var back = document.getElementById('wz-back');
    if(next) next.addEventListener('click', onNext);
    if(back) back.addEventListener('click', function(){
      if(current>1){
        var nb=document.getElementById('wz-next');
        if(nb){ nb.disabled=false; nb.textContent = (current-1===TOTAL)?'Confirmar':'Siguiente'; }
        setStep(current-1);
      }
    });
    setStep(1);
  }
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
`;

/**
 * Documento HTML completo del wizard. `opts.csrfToken` es el token derivado que
 * el handler GET de dashboard.js calcula con la cookie HttpOnly emitida.
 *
 * @param {{csrfToken?:string}} opts
 * @returns {string}
 */
function renderWizardOla(opts) {
    const o = opts || {};
    const theme = loadTheme();
    const spriteInline = loadIconSprite();
    let navHtml = '';
    try { navHtml = renderNavTabsSsr('ola'); } catch { navHtml = ''; }
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
<title>Intrale · Crear nueva ola de trabajo</title>
<style>${theme}</style>
<style>${WIZARD_CSS}</style>
</head>
<body>
<div aria-hidden="true" style="position:absolute;width:0;height:0;overflow:hidden">${spriteInline}</div>
<div class="wz-frame">
  <header>
    <h1 style="margin:0 0 2px;font-size:1.3rem">Crear nueva ola de trabajo</h1>
    <p style="margin:0;color:var(--text-dim,#9da7b3)">Wizard guiado · issues, concurrencia y confirmación</p>
  </header>
  ${navHtml}
  <div class="wz-stepper" role="progressbar" aria-valuemin="1" aria-valuemax="3" aria-valuenow="1">${stepper}</div>
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
    renderWizardOla,
    renderPreview,
    renderStepSection,
    renderTooltip,
    STEP_DEFS,
    slug: 'wizard-ola',
};
