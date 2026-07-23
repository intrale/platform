'use strict';

// =============================================================================
// fetch-client.js — EP8-H0 (#3953, épica #3952)
// -----------------------------------------------------------------------------
// Wrapper único de fetch JSON para el dashboard V3. Reemplaza las 7+ copias
// inline de `fetchJson` con `.catch(()=>null)` que tragaban el error en
// silencio (CA-2). Exporta:
//
//   - FETCH_CLIENT_JS : código CLIENTE embebido como string. Define
//       fetchJson(url, opts), el banner stale y nhCsrfHeaders(). Se inyecta
//       una sola vez por página dentro del <script> (antes de los helpers de
//       la vista) y queda disponible como global, igual que las copias previas.
//   - renderStaleBanner() : markup SSR del banner discreto (oculto por default).
//       El cliente lo muestra/oculta; si la página no lo incluye, fetchJson lo
//       crea en caliente (defensa).
//
// Contrato de comportamiento (compat con los call-sites existentes):
//   - Devuelve el JSON parseado en éxito, o `null` en cualquier fallo (igual
//     que antes), por lo que `if(!d) return;` sigue funcionando.
//   - En fallo: muestra el banner "datos desactualizados — reintentando…"
//     (mensaje GENÉRICO, R3) y loguea el detalle SOLO a consola — nunca vuelca
//     stack traces, paths ni cuerpos de error al DOM.
//   - En éxito: limpia el banner (vuelve a estado fresco).
//   - En métodos no-GET (POST/PUT/DELETE/PATCH) adjunta X-CSRF-Token leído de
//     <meta name="csrf-token"> (R2 — defensa en profundidad, cierra el gap de
//     cobertura disparejo). El header explícito del call-site tiene prioridad.
//
// Estilos del banner: `.in-stale-banner` vive en theme.css (satélites) y en la
// copia inline de home.js (que no carga theme.css).
// =============================================================================

// Mensaje genérico del banner (R3). Centralizado para que tests y vistas
// referencien el mismo literal.
const STALE_MESSAGE = 'Datos desactualizados — reintentando…';

// renderStaleBanner() — markup SSR del banner discreto, oculto por default.
// Usa ic-warn del sprite (ícono + texto → nunca solo color).
function renderStaleBanner() {
    return (
        '<div id="in-stale-banner" class="in-stale-banner" role="status" aria-live="polite" hidden>' +
        '<svg class="status-ico" aria-hidden="true" focusable="false" viewBox="0 0 24 24"><use href="#ic-warn"></use></svg>' +
        '<span class="in-stale-banner-txt">' + STALE_MESSAGE + '</span>' +
        '</div>'
    );
}

// Código cliente embebible. Definiciones como function declarations para que,
// si una vista todavía conserva una copia local durante la transición, la
// redeclaración no rompa (los <script> del dashboard no son 'use strict').
const FETCH_CLIENT_JS = `
// === fetch-client (#3953) — wrapper único de fetch JSON ======================
// Lee <meta name="csrf-token"> si existe; si no devuelve {} (compat actual).
function nhCsrfHeaders(){
  try {
    var m = document.querySelector('meta[name="csrf-token"]');
    return (m && m.content) ? { 'X-CSRF-Token': m.content } : {};
  } catch(e){ return {}; }
}
// #3955 EP8-H2 (SEC-2) — token CSRF para /api/kill-agent. A diferencia de
// nhCsrfHeaders (lee un <meta> embebido en wizards), acá no hay meta en la
// home: el token se pide al server y se cachea en memoria. force=true lo
// reobtiene (usar tras un 403). Mismo origen → el browser adjunta la cookie
// ka_csrf automáticamente; mandamos el mismo valor en el header (double-submit).
var _kaCsrfToken = null;
async function killCsrfHeaders(force){
  try {
    if(force) _kaCsrfToken = null;
    if(!_kaCsrfToken){
      var r = await fetch('/api/kill-agent/csrf-token', { cache: 'no-store' });
      if(r && r.ok){ var j = await r.json(); _kaCsrfToken = (j && j.csrf_token) || null; }
    }
    return _kaCsrfToken ? { 'X-CSRF-Token': _kaCsrfToken } : {};
  } catch(e){ return {}; }
}
// Ejecuta el POST de kill con CSRF; reintenta una vez si el server responde 403
// (token expirado/rotado por restart). Devuelve el Response final.
async function killAgentPost(payload){
  var doPost = async function(){
    var headers = Object.assign({ 'Content-Type': 'application/json' }, await killCsrfHeaders());
    return fetch('/api/kill-agent', { method: 'POST', headers: headers, body: JSON.stringify(payload) });
  };
  var r = await doPost();
  if(r && r.status === 403){ await killCsrfHeaders(true); r = await doPost(); }
  return r;
}
function _inStaleBannerEl(){
  var el = document.getElementById('in-stale-banner');
  if(!el){
    el = document.createElement('div');
    el.id = 'in-stale-banner';
    el.className = 'in-stale-banner';
    el.setAttribute('role','status');
    el.setAttribute('aria-live','polite');
    el.hidden = true;
    // Construcción 100% por DOM (sin innerHTML) — el ícono sale de la allowlist
    // estática y el texto es genérico (R3). No se interpola dato externo.
    var NS = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('class','status-ico'); svg.setAttribute('aria-hidden','true');
    svg.setAttribute('focusable','false'); svg.setAttribute('viewBox','0 0 24 24');
    var use = document.createElementNS(NS, 'use'); use.setAttribute('href','#ic-warn');
    svg.appendChild(use);
    var txt = document.createElement('span'); txt.className = 'in-stale-banner-txt';
    txt.textContent = '${STALE_MESSAGE}';
    el.appendChild(svg); el.appendChild(txt);
    if(document.body) document.body.appendChild(el);
  }
  return el;
}
function showStaleBanner(){ var el=_inStaleBannerEl(); if(el) el.hidden=false; }
function clearStaleBanner(){ var el=document.getElementById('in-stale-banner'); if(el) el.hidden=true; }
async function fetchJson(url, opts){
  var options = Object.assign({ cache: 'no-store' }, opts || {});
  var method = String(options.method || 'GET').toUpperCase();
  if(method !== 'GET' && method !== 'HEAD'){
    // El header del call-site tiene prioridad sobre el CSRF auto-inyectado.
    options.headers = Object.assign({}, nhCsrfHeaders(), options.headers || {});
  }
  try {
    var r = await fetch(url, options);
    if(!r.ok) throw new Error('HTTP ' + r.status);
    clearStaleBanner();
    return await r.json();
  } catch(e){
    showStaleBanner();
    // Detalle SOLO a consola — nunca al DOM (R3).
    try { console.warn('[fetch]', url, (e && e.message) ? e.message : e); } catch(_){}
    return null;
  }
}
// === /fetch-client ===========================================================
`;

module.exports = {
    STALE_MESSAGE,
    renderStaleBanner,
    FETCH_CLIENT_JS,
};
