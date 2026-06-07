// =============================================================================
// wizard-descanso.js — Vista SSR del wizard "Configurar período de descanso".
//
// Issue #3739 (split de #3715). Render server-side de los 3 pasos del wizard
// (ventana → anomalías → confirmación) descritos por el mockup de UX
// (`assets/mockups/29-wizard-descanso-flow.svg`). NO diseña: ensambla los
// tokens y el contrato visual ya firmados.
//
// Seguridad:
//   - Todo dato dinámico se escapa con `escapeHtmlText` / `escapeHtmlAttr`
//     del helper compartido `lib/escape-html.js` (#3722). Prohibido innerHTML
//     crudo (R-4 / CA-G3). `renderConfirmPreview` escapa el `motivo` del
//     operador (test T-6).
//   - El token CSRF se inyecta en `<meta name="csrf-token">` y la cookie
//     HttpOnly la setea el handler GET de dashboard.js (la base #3724 deriva
//     el token con HMAC sobre la cookie). El cliente lo manda en
//     `X-CSRF-Token` en cada POST a `/dashboard/wizard/descanso/step`.
//
// El slug `descanso` ya lo ocupa la ventana-panel de #3855/#3736, así que el
// wizard se sirve en la ruta dedicada `/dashboard/wizard/descanso` (GET) y NO
// se registra en el allowlist `?view=` del router cliente (#3723).
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

const STEP_API = '/dashboard/wizard/descanso/step';

// Definición declarativa de los 3 pasos (títulos + tooltips en español).
const STEP_DEFS = [
    {
        n: 1,
        title: 'Ventana horaria',
        desc: 'Elegí los días y franjas en los que el pipeline entra en descanso. Durante la ventana solo corren los skills determinísticos (build, tester, linter, delivery).',
        tooltips: [
            ['Franja horaria', 'Inicio y fin en formato 24h (HH:MM). Una franja que cruza la medianoche (ej. 22:00→02:00) cuenta al día de inicio.'],
            ['Cap 24h', 'Ningún día puede acumular más de 24 horas continuas de descanso. El límite se valida en el servidor (CA-D2); la pantalla solo te avisa antes.'],
            ['Días de la semana', 'Podés repetir la misma franja en varios días. Cada día se valida por separado.'],
        ],
    },
    {
        n: 2,
        title: 'Detector de anomalías',
        desc: 'Estos son los umbrales vigentes que disparan un wake-up por consumo anómalo. En este paso son de solo lectura.',
        tooltips: [
            ['Cap de snooze', 'Máximo de horas que se puede posponer una alerta de anomalía. Está fijo en 24h por código y no se edita desde acá.'],
            ['Chequeos de baseline', 'Cantidad de chequeos consecutivos en valores normales necesarios para limpiar una alerta automáticamente.'],
            ['Canales', 'Dónde se notifica la anomalía: banner del dashboard y/o Telegram.'],
            ['Solo lectura', 'Para modificar estos valores hay que editar config.yaml (decisión de alcance de esta historia).'],
        ],
    },
    {
        n: 3,
        title: 'Confirmación',
        desc: 'Revisá el resumen y confirmá. Vas a ver una vista previa de la próxima transición del modo descanso antes de guardar.',
        tooltips: [
            ['Motivo (opcional)', 'Nota libre que queda registrada en el audit. Máximo 280 caracteres; se escapa al guardarse y al mostrarse.'],
            ['Vista previa', 'La próxima transición (entrar/salir del descanso) calculada en el servidor con la ventana que estás por guardar.'],
            ['Audit', 'Cada confirmación deja una entrada encadenada (SHA-256) en config-descanso-audit.jsonl.'],
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
 * Render server-side del bloque de preview del Paso 3 (test T-6). Escapa el
 * `motivo` libre del operador con `escapeHtmlText` — nunca emite el valor
 * crudo. Reutilizable también desde el cliente vía el mismo contrato.
 *
 * @param {{motivo?:string, transition?:object, nextPeriod?:object}} data
 * @returns {string} fragmento HTML escapado.
 */
function renderConfirmPreview(data) {
    const d = data || {};
    const t = d.transition || null;
    const np = d.nextPeriod || null;
    const motivo = d.motivo;

    let transitionHtml = '<p class="wz-preview-empty">El modo descanso quedará inactivo (sin ventana activa).</p>';
    if (t && typeof t === 'object') {
        const kindLabel = t.kind === 'exit' ? 'Salir del descanso' : 'Entrar en descanso';
        transitionHtml = `<p class="wz-preview-line">
  <strong>Próxima transición:</strong> ${escapeHtmlText(kindLabel)}
  a las <code>${escapeHtmlText(t.atHHMM)}</code>
  (${escapeHtmlText(String(t.when))}, en ${escapeHtmlText(String(t.minutesFromNow))} min).
</p>`;
    } else if (np && typeof np === 'object') {
        transitionHtml = `<p class="wz-preview-line">
  <strong>Próximo período:</strong> <code>${escapeHtmlText(np.start)}</code>–<code>${escapeHtmlText(np.end)}</code>
  (${escapeHtmlText(String(np.when))}).
</p>`;
    }

    const motivoHtml = (typeof motivo === 'string' && motivo.length > 0)
        ? `<p class="wz-preview-motivo"><strong>Motivo:</strong> ${escapeHtmlText(motivo)}</p>`
        : '';

    return `<div class="wz-preview">
  ${transitionHtml}
  ${motivoHtml}
</div>`;
}

const WIZARD_CSS = `
.wz-frame { max-width: 920px; margin: 0 auto; padding: 22px 28px; display:flex; flex-direction:column; gap:18px; }
.wz-stepper { display:flex; gap:10px; align-items:center; justify-content:center; margin: 4px 0 8px; }
.wz-dot { width:12px; height:12px; border-radius:50%; background:var(--in-line,#30363d); }
.wz-dot.is-active { background:var(--rest-mode,var(--brand,#6e9bff)); box-shadow:0 0 0 4px color-mix(in srgb, var(--rest-mode,#6e9bff) 25%, transparent); }
.wz-dot.is-done { background:var(--in-ok,#3fb950); }
.wz-step-title { font-size:1.1rem; margin:0 0 4px; }
.wz-step-desc { color:var(--text-dim,#9da7b3); margin:0 0 12px; }
.wz-tips { display:flex; flex-wrap:wrap; gap:8px; margin-bottom:14px; }
.wz-tip { position:relative; display:inline-block; }
.wz-tip-btn { width:22px; height:22px; min-width:22px; border-radius:50%; border:1px solid var(--in-line,#30363d); background:transparent; color:var(--text,#c9d1d9); cursor:help; font-weight:700; }
.wz-tip-btn:focus-visible { outline:2px solid var(--rest-mode,#6e9bff); outline-offset:2px; }
.wz-tip-body { position:absolute; left:0; top:130%; z-index:20; width:260px; padding:10px 12px; border-radius:8px; background:var(--in-surface-2,#161b22); border:1px solid var(--in-line,#30363d); color:var(--text,#c9d1d9); font-size:0.82rem; line-height:1.4; display:none; flex-direction:column; gap:4px; box-shadow:0 6px 20px rgba(0,0,0,0.4); }
.wz-tip:hover .wz-tip-body, .wz-tip:focus-within .wz-tip-body { display:flex; }
.wz-actions { display:flex; justify-content:space-between; gap:12px; margin-top:18px; }
.wz-btn { min-height:44px; min-width:96px; padding:0 18px; border-radius:8px; border:1px solid var(--in-line,#30363d); background:var(--in-surface-2,#161b22); color:var(--text,#c9d1d9); cursor:pointer; font-size:0.92rem; }
.wz-btn-primary { background:var(--rest-mode,#6e9bff); border-color:var(--rest-mode,#6e9bff); color:#04101f; font-weight:600; }
.wz-btn:disabled { opacity:0.45; cursor:not-allowed; }
.wz-errors { margin:10px 0; padding:10px 14px; border-radius:8px; background:var(--in-bad-soft,rgba(248,81,73,0.12)); border:1px solid var(--in-bad,#f85149); color:var(--in-bad,#f85149); font-size:0.86rem; }
.wz-errors ul { margin:6px 0 0; padding-left:18px; }
.wz-preview { padding:12px 14px; border-radius:8px; background:var(--in-surface-2,#161b22); border:1px solid var(--in-line,#30363d); }
.wz-preview code { background:var(--in-surface,#0d1117); padding:1px 5px; border-radius:4px; }
.wz-cap-pill { display:inline-block; padding:2px 10px; border-radius:999px; background:var(--alert-anomaly,rgba(210,153,34,0.16)); color:var(--in-warn,#d29922); font-size:0.78rem; }
`;

// Cliente: maneja la navegación entre pasos, los POST al step API y el render
// del preview. Mantiene `wizard_session_id` en memoria (no localStorage:
// CSRF HttpOnly + sesión server-side). El "atrás" no re-postea (idempotente).
const WIZARD_CLIENT_JS = `
(function(){
  var STEP_API = ${JSON.stringify(STEP_API)};
  var TOTAL = 3;
  var current = 1;
  var sessionId = null;
  var draftWindow = { active: true, timezone: 'America/Argentina/Buenos_Aires', schedule: {} };

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
    }).then(function(r){ return r.json().then(function(j){ return { status:r.status, json:j }; }); });
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

  function renderAnomalias(th){
    var body = document.querySelector('[data-step-body="2"]'); if(!body) return;
    body.innerHTML = '<ul>'
      + '<li>Cap de snooze: <code>'+esc(th.max_snooze_hours)+'h</code></li>'
      + '<li>Chequeos de baseline para limpiar: <code>'+esc(th.consecutive_baseline_checks_to_clear)+'</code></li>'
      + '<li>Canales: Telegram '+(th.channels && th.channels.telegram?'on':'off')+' · Banner '+(th.channels && th.channels.dashboard_banner?'on':'off')+'</li>'
      + '</ul><p class="wz-step-desc">Para modificar estos valores, ver config.yaml.</p>';
  }

  function renderPreview(res){
    var body = document.querySelector('[data-step-body="3"]'); if(!body) return;
    var t = res.transition, html;
    if(t){
      var label = t.kind==='exit' ? 'Salir del descanso' : 'Entrar en descanso';
      html = '<div class="wz-preview"><p class="wz-preview-line"><strong>Próxima transición:</strong> '+esc(label)+' a las <code>'+esc(t.atHHMM)+'</code> ('+esc(t.when)+', en '+esc(t.minutesFromNow)+' min).</p></div>';
    } else {
      html = '<div class="wz-preview"><p>El modo descanso quedará inactivo.</p></div>';
    }
    html += '<p style="margin-top:12px;color:var(--in-ok,#3fb950)">✓ Configuración guardada.</p>';
    body.innerHTML = html;
  }

  function commonErr(stepN, r){
    if(r.status===403){ showErrors(stepN, ['Sesión no autorizada (CSRF/origen). Recargá la página.']); return true; }
    if(r.status===410){ showErrors(stepN, ['La sesión expiró (15 min). Recargá para reiniciar el wizard.']); return true; }
    if(r.status!==200 || !r.json){ showErrors(stepN, ['Error inesperado del servidor ('+r.status+').']); return true; }
    return false;
  }

  function postVentana(){
    // Internamente el step 0 crea SIEMPRE una sesión fresca (anti-fixation),
    // así que re-postear la ventana editada es seguro e idempotente.
    return postStep(0, draftWindow).then(function(r){
      if(commonErr(1, r)) return false;
      if(r.json.wizard_session_id) sessionId = r.json.wizard_session_id;
      var res = r.json.result || {};
      if(res.ok===false){ showErrors(1, res.errors || ['Ventana inválida.']); return false; }
      showErrors(1, []);
      return true;
    });
  }

  function postAnomalias(){
    return postStep(1, { acknowledged: true }).then(function(r){
      if(commonErr(2, r)) return false;
      if(r.status===409){ showErrors(2, ['Estos umbrales son de solo lectura en este wizard.']); return false; }
      var res = r.json.result || {};
      if(res.ok===false){ showErrors(2, res.errors || ['No se pudo continuar.']); return false; }
      showErrors(2, []);
      if(res.thresholds) renderAnomalias(res.thresholds);
      return true;
    });
  }

  function postConfirm(){
    var mi = document.getElementById('wz-motivo');
    var params = (mi && mi.value) ? { motivo: mi.value } : {};
    return postStep(2, params).then(function(r){
      if(commonErr(3, r)) return false;
      var res = r.json.result || {};
      if(res.ok===false){ showErrors(3, res.errors || ['No se pudo guardar.']); return false; }
      showErrors(3, []);
      renderPreview(res);
      var nb=document.getElementById('wz-next'); if(nb) nb.disabled=true;
      var bb=document.getElementById('wz-back'); if(bb) bb.disabled=true;
      return true;
    });
  }

  function onNext(){
    if(current===1){ postVentana().then(function(ok){ if(ok){ setStep(2); postAnomalias(); } }); }
    else if(current===2){ setStep(3); }
    else { postConfirm(); }
  }

  function init(){
    var startBody = document.querySelector('[data-step-body="1"]');
    if(startBody){
      startBody.innerHTML = '<p class="wz-step-desc">Configurá la ventana semanal. <span class="wz-cap-pill">cap 24h/día</span></p>'
        + '<p class="wz-step-desc">El detalle de edición de franjas vive en la ventana <a href="/dashboard?view=descanso">Descanso</a>; este wizard valida y persiste la configuración.</p>';
    }
    var motivoSlot = document.querySelector('[data-step-body="3"]');
    if(motivoSlot){
      motivoSlot.innerHTML = '<label style="display:block;margin-bottom:8px">Motivo (opcional)'
        + '<input id="wz-motivo" type="text" maxlength="280" style="display:block;width:100%;margin-top:4px;padding:8px;border-radius:6px;border:1px solid var(--in-line,#30363d);background:var(--in-surface,#0d1117);color:var(--text,#c9d1d9)"></label>'
        + '<p class="wz-step-desc">Al confirmar vas a ver la próxima transición calculada en el servidor.</p>';
    }
    var next = document.getElementById('wz-next');
    var back = document.getElementById('wz-back');
    if(next) next.addEventListener('click', onNext);
    if(back) back.addEventListener('click', function(){ if(current>1){ var nb=document.getElementById('wz-next'); if(nb){ nb.disabled=false; nb.textContent = (current-1===TOTAL)?'Confirmar':'Siguiente'; } setStep(current-1); } });
    setStep(1);
  }
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
`;

/**
 * Documento HTML completo del wizard. `opts.csrfToken` es el token derivado
 * que el handler GET de dashboard.js calcula con la cookie HttpOnly emitida.
 *
 * @param {{csrfToken?:string}} opts
 * @returns {string}
 */
function renderWizardDescanso(opts) {
    const o = opts || {};
    const theme = loadTheme();
    const spriteInline = loadIconSprite();
    let navHtml = '';
    try { navHtml = renderNavTabsSsr('descanso'); } catch { navHtml = ''; }
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
<title>Intrale · Configurar período de descanso</title>
<style>${theme}</style>
<style>${WIZARD_CSS}</style>
</head>
<body>
<div aria-hidden="true" style="position:absolute;width:0;height:0;overflow:hidden">${spriteInline}</div>
<div class="wz-frame">
  <header>
    <h1 style="margin:0 0 2px;font-size:1.3rem">Configurar período de descanso</h1>
    <p style="margin:0;color:var(--text-dim,#9da7b3)">Wizard guiado · ventana, anomalías y confirmación</p>
  </header>
  ${navHtml}
  <div class="wz-stepper" role="progressbar" aria-valuemin="1" aria-valuemax="3" aria-valuenow="1">${stepper}</div>
  <main>
    ${sections}
    <div class="wz-actions">
      <button type="button" class="wz-btn" id="wz-back" disabled>Atrás</button>
      <button type="button" class="wz-btn wz-btn-primary" id="wz-next">Siguiente</button>
    </div>
    <section class="wz-step" data-step="3-motivo" hidden></section>
  </main>
</div>
<script>${WIZARD_CLIENT_JS}</script>
</body>
</html>`;
}

module.exports = {
    renderWizardDescanso,
    renderConfirmPreview,
    renderStepSection,
    renderTooltip,
    STEP_DEFS,
    slug: 'wizard-descanso',
};
