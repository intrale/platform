// =============================================================================
// wizard-pausa.js — Vista SSR del wizard "Pausar / despausar issues parciales".
//
// Issue #3741 (split de #3715). Render server-side de los 3 pasos del wizard
// (acción+scope → preview+deps → confirmación) descritos por el mockup de UX
// (`assets/mockups/35-wizard-pausa-v3.svg`) y su narrativa
// (`assets/mockups/narrativa-wizard-pausa.md`). NO diseña: ensambla los tokens,
// el microcopy ES-AR y el contrato visual ya firmados por UX.
//
// Seguridad:
//   - Todo título de issue en el preview se escapa con `escapeHtmlText` (#3722).
//     El flow (`lib/wizards/pausa`) ya devuelve `title_safe` pre-escapado en el
//     resultado del paso 1 (CA-10); el cliente lo inserta tal cual (ya es
//     seguro) y el resto de datos dinámicos del cliente pasa por `esc()`.
//   - El token CSRF va en `<meta name="csrf-token">`; la cookie HttpOnly la setea
//     el handler GET de dashboard.js (la base #3724 deriva el token con HMAC).
//     El cliente lo manda en `X-CSRF-Token` en cada POST a
//     `/dashboard/wizard/pausa/step`.
//   - Mutaciones SOLO vía gate (#3625): el cliente nunca escribe estado, sólo
//     postea params; el handler/flow aplican con `authorizedBy` server-side.
//
// El wizard se sirve en la ruta dedicada `/dashboard/wizard/pausa` (GET).
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

const STEP_API = '/dashboard/wizard/pausa/step';

// Microcopy ES-AR — copiado literal de la narrativa UX (sección 5).
const STEP_DEFS = [
    {
        n: 1,
        title: '¿Qué necesitás hacer?',
        desc: 'Decidí la acción y el alcance. Después vas a ver el impacto antes de aplicar.',
    },
    {
        n: 2,
        title: '¿Qué va a pasar?',
        desc: 'Estos issues quedarán habilitados. Las dependencias se resolvieron recursivamente.',
    },
    {
        n: 3,
        title: 'Confirmá la operación',
        desc: 'Última oportunidad de frenar. Revisá el drift-check y confirmá.',
    },
];

/**
 * Render server-side de las filas del preview (paso 2). Defensa en profundidad:
 * re-escapa el título aun cuando el flow ya entrega `title_safe`. Reutilizable
 * desde tests (CA-10).
 * @param {Array<{number:number, title_safe?:string, title?:string, via_dep?:boolean}>} affected
 * @returns {string}
 */
function renderPreviewRows(affected) {
    const rows = (Array.isArray(affected) ? affected : []).map((a) => {
        // `title_safe` ya viene escapado por el flow; si llega `title` crudo, lo escapamos.
        const safe = (a.title_safe != null) ? String(a.title_safe) : escapeHtmlText(a.title || '');
        const dep = a.via_dep
            ? '<span class="wz-pill wz-pill-dep">↳ dep</span>'
            : '';
        return `<tr>
  <td class="wz-num">#${escapeHtmlText(String(a.number))}</td>
  <td class="wz-title">${safe} ${dep}</td>
</tr>`;
    }).join('\n');
    return `<table class="wz-table"><thead><tr><th>Issue</th><th>Título</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function renderStepSection(def) {
    return `<section class="wz-step" data-step="${def.n}" ${def.n === 1 ? '' : 'hidden'}>
  <h2 class="wz-step-title">Paso ${def.n} · ${escapeHtmlText(def.title)}</h2>
  <p class="wz-step-desc">${escapeHtmlText(def.desc)}</p>
  <div class="wz-step-body" data-step-body="${def.n}"></div>
</section>`;
}

// CSS — reusa la base del wizard de descanso + acentos danger/teal de la
// narrativa UX (sección 3 "Sistema visual y tokens"). Sólo `var(--token)`.
const WIZARD_CSS = `
.wz-frame { max-width: 960px; margin: 0 auto; padding: 22px 28px; display:flex; flex-direction:column; gap:18px; }
.wz-headpills { display:flex; gap:8px; flex-wrap:wrap; justify-content:flex-end; }
.wz-stepper { display:flex; gap:10px; align-items:center; justify-content:center; margin: 4px 0 8px; }
.wz-dot { width:12px; height:12px; border-radius:50%; background:var(--in-line,#30363d); }
.wz-dot.is-active { background:var(--brand,#6e9bff); box-shadow:0 0 0 4px color-mix(in srgb, var(--brand,#6e9bff) 25%, transparent); }
.wz-dot.is-done { background:var(--in-ok,#3fb950); }
.wz-step-title { font-size:1.1rem; margin:0 0 4px; }
.wz-step-desc { color:var(--text-dim,#9da7b3); margin:0 0 12px; }
.wz-fieldset { border:1px solid var(--in-line,#30363d); border-radius:10px; padding:14px 16px; margin:0 0 14px; }
.wz-fieldset legend { padding:0 6px; color:var(--text-dim,#9da7b3); font-size:0.86rem; }
.wz-opt { display:flex; align-items:flex-start; gap:8px; padding:8px 6px; }
.wz-opt input { margin-top:3px; min-width:18px; min-height:18px; }
.wz-pill { display:inline-block; padding:2px 9px; border-radius:999px; font-size:0.72rem; vertical-align:middle; }
.wz-pill-destructiva { background:var(--in-bad-soft,rgba(248,81,73,0.14)); color:var(--in-bad,#f85149); border:1px solid var(--in-bad,#f85149); }
.wz-pill-dep { background:rgba(163,113,247,0.16); color:#a371f7; }
.wz-pill-teal { background:rgba(57,197,187,0.14); color:#39c5bb; border:1px solid rgba(57,197,187,0.4); }
.wz-pill-muted { background:var(--in-surface-2,#161b22); color:var(--text-dim,#9da7b3); border:1px solid var(--in-line,#30363d); font-family:ui-monospace,monospace; }
.wz-table { width:100%; border-collapse:collapse; margin:8px 0; font-size:0.88rem; }
.wz-table th, .wz-table td { text-align:left; padding:7px 10px; border-bottom:1px solid var(--in-line,#30363d); }
.wz-table .wz-num { font-family:ui-monospace,monospace; color:var(--text-dim,#9da7b3); white-space:nowrap; }
.wz-banner { padding:10px 14px; border-radius:8px; margin:10px 0; font-size:0.86rem; }
.wz-banner-ok { background:var(--in-ok-soft,rgba(63,185,80,0.12)); border:1px solid var(--in-ok,#3fb950); color:var(--in-ok,#3fb950); }
.wz-banner-drift { background:var(--in-bad-soft,rgba(248,81,73,0.12)); border:1px dashed var(--in-bad,#f85149); color:var(--in-bad,#f85149); }
.wz-confirm { display:flex; align-items:flex-start; gap:8px; padding:8px 0; }
.wz-actions { display:flex; justify-content:space-between; gap:12px; margin-top:18px; }
.wz-btn { min-height:44px; min-width:96px; padding:0 18px; border-radius:8px; border:1px solid var(--in-line,#30363d); background:var(--in-surface-2,#161b22); color:var(--text,#c9d1d9); cursor:pointer; font-size:0.92rem; }
.wz-btn-primary { background:var(--brand,#6e9bff); border-color:var(--brand,#6e9bff); color:#04101f; font-weight:600; }
.wz-btn-danger { background:var(--in-bad,#f85149); border-color:var(--in-bad,#f85149); color:#1a0606; font-weight:700; }
.wz-btn:disabled { opacity:0.45; cursor:not-allowed; }
.wz-errors { margin:10px 0; padding:10px 14px; border-radius:8px; background:var(--in-bad-soft,rgba(248,81,73,0.12)); border:1px solid var(--in-bad,#f85149); color:var(--in-bad,#f85149); font-size:0.86rem; }
.wz-errors ul { margin:6px 0 0; padding-left:18px; }
.wz-input, .wz-textarea { display:block; width:100%; margin-top:4px; padding:8px; border-radius:6px; border:1px solid var(--in-line,#30363d); background:var(--in-surface,#0d1117); color:var(--text,#c9d1d9); }
`;

// Cliente: navega los 3 pasos, postea al step API y mantiene el snapshot del
// estado (firma) para el drift-check. `wizard_session_id` vive en memoria
// (CSRF HttpOnly + sesión server-side). Doble confirmación enforced en UI para
// despausar (2 checkboxes + justificación). El handler/flow re-validan TODO.
const WIZARD_CLIENT_JS = `
(function(){
  var STEP_API = ${JSON.stringify(STEP_API)};
  var TOTAL = 3;
  var current = 1;
  var sessionId = null;
  var snapshotSig = '';
  var draft = { action: 'pausar', scope: 'issue' };

  function csrfToken(){ var m=document.querySelector('meta[name="csrf-token"]'); return m?m.getAttribute('content'):''; }
  function esc(s){ return String(s==null?'':s).replace(/[&<>"']/g,function(c){return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]);}); }

  function postStep(step, params){
    return fetch(STEP_API, {
      method:'POST',
      headers:{ 'Content-Type':'application/json', 'X-CSRF-Token': csrfToken() },
      credentials:'same-origin',
      body: JSON.stringify({ step: step, wizard_session_id: sessionId, params: params || {} })
    }).then(function(r){ return r.json().then(function(j){ return { status:r.status, json:j }; }); });
  }

  function showErrors(stepN, errs){
    var body=document.querySelector('[data-step-body="'+stepN+'"]'); if(!body) return;
    var ex=body.querySelector('.wz-errors'); if(ex) ex.remove();
    if(!errs||!errs.length) return;
    var div=document.createElement('div'); div.className='wz-errors';
    div.innerHTML='<strong>No se pudo continuar:</strong><ul>'+errs.map(function(e){return '<li>'+esc(e)+'</li>';}).join('')+'</ul>';
    body.insertBefore(div, body.firstChild);
  }

  function setStep(n){
    current=n;
    document.querySelectorAll('.wz-step').forEach(function(s){ s.hidden=(parseInt(s.getAttribute('data-step'),10)!==n); });
    document.querySelectorAll('.wz-dot').forEach(function(d,i){ d.classList.toggle('is-active',(i+1)===n); d.classList.toggle('is-done',(i+1)<n); });
    var back=document.getElementById('wz-back'); if(back) back.disabled=(n===1);
    var next=document.getElementById('wz-next');
    if(next){
      if(n===TOTAL){ next.textContent = (draft.action==='despausar') ? 'Confirmar despausa' : 'Aplicar pausa'; next.className='wz-btn '+(draft.action==='despausar'?'wz-btn-danger':'wz-btn-danger'); }
      else { next.textContent='Siguiente'; next.className='wz-btn wz-btn-primary'; }
    }
  }

  function readStep1(){
    var action=(document.querySelector('input[name="wz-action"]:checked')||{}).value||'pausar';
    var scope=(document.querySelector('input[name="wz-scope"]:checked')||{}).value||'issue';
    draft.action=action; draft.scope=scope;
    var params={ action:action, scope:scope };
    if(scope==='issue'){ var iv=document.getElementById('wz-issue-id'); params.issue_id=iv?iv.value.trim():''; }
    if(scope==='allowlist'){ var tv=document.getElementById('wz-issues'); params.issues=(tv?tv.value:'').split(/[^0-9]+/).filter(Boolean).map(Number); }
    return params;
  }

  function commonErr(stepN, r){
    if(r.status===403){ showErrors(stepN,['Sesión no autorizada (CSRF/origen). Recargá la página.']); return true; }
    if(r.status===410){ showErrors(stepN,['Sesión expirada, reiniciá el wizard.']); return true; }
    if(r.status===409 && stepN===3){ return false; } // drift se maneja aparte
    if(r.status!==200 || !r.json){ showErrors(stepN,['Error del servidor ('+r.status+'). Revisá la combinación elegida.']); return true; }
    return false;
  }

  function postAccion(){
    return postStep(0, readStep1()).then(function(r){
      if(commonErr(1,r)) return false;
      if(r.status===409){ showErrors(1,['Combinación inválida (¿despausar sin pausa activa? ¿allowlist vacía?).']); return false; }
      if(r.json.wizard_session_id) sessionId=r.json.wizard_session_id;
      showErrors(1,[]); return true;
    });
  }

  function renderPreview(res){
    var body=document.querySelector('[data-step-body="2"]'); if(!body) return;
    snapshotSig=res.snapshotSignature||'';
    var pill='<span class="wz-pill wz-pill-teal">'+esc(res.resultingMode)+(res.allowedSkills&&res.allowedSkills.length?(' · skills:['+esc(res.allowedSkills.join(','))+']'):'')+'</span>';
    var rows=(res.affected||[]).map(function(a){
      // title_safe ya viene escapado por el flow → se inserta tal cual (seguro).
      return '<tr><td class="wz-num">#'+esc(a.number)+'</td><td>'+(a.title_safe||'')+(a.via_dep?' <span class="wz-pill wz-pill-dep">↳ dep</span>':'')+'</td></tr>';
    }).join('');
    var trunc=res.truncated?'<p class="wz-step-desc">⚠ Resolución de deps truncada ('+esc(res.reason||'')+'). Algunos descendientes pueden faltar.</p>':'';
    body.innerHTML='<p>Estado resultante: '+pill+'</p>'
      +(res.affected&&res.affected.length?('<table class="wz-table"><thead><tr><th>Issue</th><th>Título</th></tr></thead><tbody>'+rows+'</tbody></table>'):'<p class="wz-step-desc">Sin issues afectados directos (acción de scope total).</p>')
      +trunc;
  }

  function postPreview(){
    return postStep(1, {}).then(function(r){
      if(commonErr(2,r)) return false;
      var res=r.json.result||{};
      renderPreview(res);
      renderConfirm();
      return true;
    });
  }

  function renderConfirm(){
    var body=document.querySelector('[data-step-body="3"]'); if(!body) return;
    var despausar=(draft.action==='despausar');
    var html='<div class="wz-banner wz-banner-ok" id="wz-drift">Drift-check OK</div>';
    html+='<label class="wz-confirm"><input type="checkbox" id="wz-c1"><span>Entiendo que esto '+(despausar?'reanuda':'frena')+' el pipeline para los issues listados.</span></label>';
    if(despausar){
      html+='<label class="wz-confirm"><input type="checkbox" id="wz-c2"><span>Confirmo la despausa (acción destructiva).</span></label>';
      html+='<label style="display:block;margin-top:8px">Justificación (queda en audit log):<textarea id="wz-motivo" class="wz-textarea" maxlength="500" rows="2"></textarea></label>';
    } else {
      html+='<label style="display:block;margin-top:8px">Justificación (opcional, queda en audit log):<textarea id="wz-motivo" class="wz-textarea" maxlength="500" rows="2"></textarea></label>';
    }
    body.innerHTML=html;
    var next=document.getElementById('wz-next'); if(next) next.disabled=true;
    function refresh(){
      var c1=document.getElementById('wz-c1'); var c2=document.getElementById('wz-c2');
      var ok=c1&&c1.checked;
      if(despausar){ var mv=document.getElementById('wz-motivo'); ok=ok&&c2&&c2.checked&&mv&&mv.value.trim().length>=10; }
      if(next) next.disabled=!ok;
    }
    ['wz-c1','wz-c2','wz-motivo'].forEach(function(id){ var el=document.getElementById(id); if(el){ el.addEventListener('change',refresh); el.addEventListener('input',refresh); } });
  }

  function postConfirm(){
    var mv=document.getElementById('wz-motivo');
    var params={ action:draft.action, confirm1:true, previous_snapshot:snapshotSig };
    if(draft.action==='despausar') params.confirm2=true;
    if(mv&&mv.value.trim()) params.motivo=mv.value.trim();
    return postStep(2, params).then(function(r){
      if(r.status===409){
        var d=document.getElementById('wz-drift');
        if(d){ d.className='wz-banner wz-banner-drift'; d.textContent='Estado cambió, reiniciá el wizard'; }
        var nb=document.getElementById('wz-next'); if(nb) nb.disabled=true;
        return false;
      }
      if(commonErr(3,r)) return false;
      var res=r.json.result||{};
      var body=document.querySelector('[data-step-body="3"]');
      if(body) body.innerHTML='<div class="wz-banner wz-banner-ok">✓ Operación aplicada. Estado: '+esc(res.resultingMode||'')+'.</div>';
      var nb=document.getElementById('wz-next'); if(nb) nb.disabled=true;
      var bb=document.getElementById('wz-back'); if(bb) bb.disabled=true;
      return true;
    });
  }

  function onNext(){
    if(current===1){ postAccion().then(function(ok){ if(ok){ setStep(2); postPreview(); } }); }
    else if(current===2){ setStep(3); }
    else { postConfirm(); }
  }

  function renderStep1(){
    var body=document.querySelector('[data-step-body="1"]'); if(!body) return;
    body.innerHTML=''
      +'<fieldset class="wz-fieldset"><legend>Acción</legend>'
      +'<label class="wz-opt"><input type="radio" name="wz-action" value="pausar" checked><span><strong>Pausar</strong> — frenar el avance.</span></label>'
      +'<label class="wz-opt"><input type="radio" name="wz-action" value="despausar"><span><strong>Despausar</strong> <span class="wz-pill wz-pill-destructiva">DESTRUCTIVA</span> — reanudar el pipeline.</span></label>'
      +'</fieldset>'
      +'<fieldset class="wz-fieldset"><legend>Alcance</legend>'
      +'<label class="wz-opt"><input type="radio" name="wz-scope" value="issue" checked><span>Issue específico</span></label>'
      +'<div id="wz-issue-wrap" style="padding:0 6px 8px"><input id="wz-issue-id" class="wz-input" inputmode="numeric" placeholder="Nº de issue (ej. 1732)"></div>'
      +'<label class="wz-opt"><input type="radio" name="wz-scope" value="allowlist"><span>Allowlist completa (reemplaza el set)</span></label>'
      +'<div id="wz-issues-wrap" style="padding:0 6px 8px" hidden><textarea id="wz-issues" class="wz-textarea" rows="2" placeholder="Issues separados por coma (ej. 100, 201, 305)"></textarea><p class="wz-step-desc">allowed_skills se preserva.</p></div>'
      +'<label class="wz-opt"><input type="radio" name="wz-scope" value="full"><span>Pausa total (crea el marker .paused, frena todo)</span></label>'
      +'</fieldset>';
    function syncScope(){
      var sc=(document.querySelector('input[name="wz-scope"]:checked')||{}).value;
      document.getElementById('wz-issue-wrap').hidden=(sc!=='issue');
      document.getElementById('wz-issues-wrap').hidden=(sc!=='allowlist');
    }
    document.querySelectorAll('input[name="wz-scope"]').forEach(function(el){ el.addEventListener('change',syncScope); });
    syncScope();
  }

  function init(){
    renderStep1();
    var next=document.getElementById('wz-next');
    var back=document.getElementById('wz-back');
    var cancel=document.getElementById('wz-cancel');
    if(next) next.addEventListener('click', onNext);
    if(back) back.addEventListener('click', function(){ if(current>1){ var nb=document.getElementById('wz-next'); if(nb) nb.disabled=false; setStep(current-1); } });
    if(cancel) cancel.addEventListener('click', function(){ sessionId=null; snapshotSig=''; location.reload(); });
    setStep(1);
  }
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
`;

/**
 * Documento HTML completo del wizard. `opts.csrfToken` es el token derivado que
 * el handler GET de dashboard.js calcula con la cookie HttpOnly emitida.
 * @param {{csrfToken?:string}} opts
 * @returns {string}
 */
function renderWizardPausa(opts) {
    const o = opts || {};
    const theme = loadTheme();
    const spriteInline = loadIconSprite();
    let navHtml = '';
    try { navHtml = renderNavTabsSsr('pausa'); } catch { navHtml = ''; }
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
<title>Intrale · Pausar / despausar issues parciales</title>
<style>${theme}</style>
<style>${WIZARD_CSS}</style>
</head>
<body>
<div aria-hidden="true" style="position:absolute;width:0;height:0;overflow:hidden">${spriteInline}</div>
<div class="wz-frame">
  <header>
    <div class="wz-headpills">
      <span class="wz-pill wz-pill-muted">CSRF · sesión protegida</span>
      <span class="wz-pill wz-pill-muted">Sesión expira en 15:00</span>
    </div>
    <h1 style="margin:0 0 2px;font-size:1.3rem">Pausar / despausar issues parciales</h1>
    <p style="margin:0;color:var(--text-dim,#9da7b3)">Operación sensible · 3 pasos · doble confirmación para despausar</p>
  </header>
  ${navHtml}
  <div class="wz-stepper" role="progressbar" aria-valuemin="1" aria-valuemax="3" aria-valuenow="1">${stepper}</div>
  <main>
    ${sections}
    <div class="wz-actions">
      <button type="button" class="wz-btn" id="wz-cancel">Cancelar</button>
      <span style="flex:1"></span>
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
    renderWizardPausa,
    renderPreviewRows,
    renderStepSection,
    STEP_DEFS,
    slug: 'wizard-pausa',
};
