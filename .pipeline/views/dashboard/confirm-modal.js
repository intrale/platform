'use strict';

// =============================================================================
// confirm-modal.js — EP8-H0 (#3953, épica #3952)
// -----------------------------------------------------------------------------
// Framework de modal de confirmación con preview que reemplaza el confirm()
// nativo (CA-3). Exporta CONFIRM_MODAL_JS: código CLIENTE embebido que define
// dos globals:
//
//   - inConfirm(opts) -> Promise<boolean>
//       Muestra un modal accesible (role=dialog, aria-modal, focus trap, ESC =
//       cancelar, Enter = confirmar, click en overlay = cancelar). Resuelve a
//       true/false según la elección del usuario.
//
//   - inConfirmPost(opts) -> Promise<json|null>
//       Confirma y, si el usuario acepta, ejecuta el POST destructivo con
//       X-CSRF-Token automático vía fetchJson (de fetch-client.js). Centraliza
//       el disparo de acciones destructivas y cierra el gap de cobertura CSRF
//       disparejo (R2). Requiere que FETCH_CLIENT_JS esté inyectado antes.
//
// Seguridad — XSS-safe POR DEFAULT (R1):
//   Todo dato dinámico (title, message, label/value del preview) se inserta con
//   `textContent`, NUNCA con innerHTML. El call-site NO necesita escapar: el
//   framework lo hace. El único innerHTML usado es para el ícono de severidad,
//   construido desde una allowlist estática (ic-warn/ic-bad), sin input externo.
//
// opts (inConfirm):
//   { title, message, preview:[{label,value}], confirmLabel, cancelLabel,
//     danger (default true) }
// opts (inConfirmPost): los de inConfirm + { url, method='POST', body }
//
// Estilos `.in-modal-*` viven en theme.css (satélites) y en la copia inline de
// home.js (que no carga theme.css).
// =============================================================================

const CONFIRM_MODAL_JS = `
// === confirm-modal (#3953) — confirmación con preview, XSS-safe por default ===
// Construye el ícono de severidad por DOM (sin innerHTML) desde la allowlist
// estática ic-bad/ic-warn. No se interpola dato externo.
function _inModalAppendIcon(iconWrap, danger){
  var NS = 'http://www.w3.org/2000/svg';
  var svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('class','status-ico'); svg.setAttribute('aria-hidden','true');
  svg.setAttribute('focusable','false'); svg.setAttribute('viewBox','0 0 24 24');
  var use = document.createElementNS(NS, 'use'); use.setAttribute('href', danger ? '#ic-bad' : '#ic-warn');
  svg.appendChild(use); iconWrap.appendChild(svg);
}
function inConfirm(opts){
  var o = opts || {};
  return new Promise(function(resolve){
    var existing = document.getElementById('in-modal-overlay');
    if(existing && existing.parentNode) existing.parentNode.removeChild(existing);

    var danger = o.danger !== false; // default: acción destructiva

    var overlay = document.createElement('div');
    overlay.id = 'in-modal-overlay';
    overlay.className = 'in-modal-overlay';

    var modal = document.createElement('div');
    modal.className = 'in-modal' + (danger ? ' in-modal-danger' : '');
    modal.setAttribute('role','dialog');
    modal.setAttribute('aria-modal','true');
    modal.setAttribute('aria-labelledby','in-modal-title');

    var iconWrap = document.createElement('div');
    iconWrap.className = 'in-modal-icon status-' + (danger ? 'bad' : 'warn');
    iconWrap.setAttribute('aria-hidden','true');
    _inModalAppendIcon(iconWrap, danger); // allowlist estática, sin innerHTML
    modal.appendChild(iconWrap);

    var h = document.createElement('h2');
    h.className = 'in-modal-title';
    h.id = 'in-modal-title';
    h.textContent = o.title || 'Confirmar acción'; // textContent → XSS-safe
    modal.appendChild(h);

    if(o.message){
      var p = document.createElement('p');
      p.className = 'in-modal-message';
      p.textContent = o.message;                   // textContent → XSS-safe
      modal.appendChild(p);
    }

    if(Array.isArray(o.preview) && o.preview.length){
      var dl = document.createElement('dl');
      dl.className = 'in-modal-preview';
      o.preview.forEach(function(row){
        if(!row) return;
        var wrap = document.createElement('div');
        wrap.className = 'in-modal-preview-row';
        var dt = document.createElement('dt');
        dt.textContent = row.label != null ? String(row.label) : '';
        var dd = document.createElement('dd');
        dd.textContent = row.value != null ? String(row.value) : ''; // textContent → XSS-safe
        wrap.appendChild(dt); wrap.appendChild(dd);
        dl.appendChild(wrap);
      });
      modal.appendChild(dl);
    }

    var actions = document.createElement('div');
    actions.className = 'in-modal-actions';
    var cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'in-btn in-modal-cancel';
    cancelBtn.textContent = o.cancelLabel || 'Cancelar';
    var confirmBtn = document.createElement('button');
    confirmBtn.type = 'button';
    confirmBtn.className = 'in-btn in-modal-confirm' + (danger ? ' in-modal-confirm-danger' : '');
    confirmBtn.textContent = o.confirmLabel || 'Confirmar';
    actions.appendChild(cancelBtn);
    actions.appendChild(confirmBtn);
    modal.appendChild(actions);

    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    var prevFocus = document.activeElement;
    function cleanup(result){
      document.removeEventListener('keydown', onKey, true);
      if(overlay.parentNode) overlay.parentNode.removeChild(overlay);
      try { if(prevFocus && prevFocus.focus) prevFocus.focus(); } catch(e){}
      resolve(result);
    }
    function onKey(ev){
      if(ev.key === 'Escape'){ ev.preventDefault(); cleanup(false); }
      else if(ev.key === 'Enter'){ ev.preventDefault(); cleanup(true); }
      else if(ev.key === 'Tab'){
        var f = [cancelBtn, confirmBtn];
        var i = f.indexOf(document.activeElement);
        ev.preventDefault();
        var next = ev.shiftKey ? (i<=0 ? f.length-1 : i-1) : (i>=f.length-1 ? 0 : i+1);
        f[next].focus();
      }
    }
    document.addEventListener('keydown', onKey, true);
    overlay.addEventListener('click', function(ev){ if(ev.target === overlay) cleanup(false); });
    cancelBtn.addEventListener('click', function(){ cleanup(false); });
    confirmBtn.addEventListener('click', function(){ cleanup(true); });
    // Foco inicial en Cancelar para acciones destructivas (default seguro).
    (danger ? cancelBtn : confirmBtn).focus();
  });
}
async function inConfirmPost(opts){
  var o = opts || {};
  var ok = await inConfirm(o);
  if(!ok) return null;
  var fetchOpts = { method: o.method || 'POST' };
  if(o.body !== undefined && o.body !== null){
    fetchOpts.headers = { 'Content-Type': 'application/json' };
    fetchOpts.body = (typeof o.body === 'string') ? o.body : JSON.stringify(o.body);
  }
  // fetchJson (fetch-client) adjunta X-CSRF-Token en métodos no-GET (R2).
  return await fetchJson(o.url, fetchOpts);
}
// === /confirm-modal ==========================================================
`;

module.exports = { CONFIRM_MODAL_JS };
