'use strict';

// =============================================================================
// mission-banner-eta.js — #4296
// -----------------------------------------------------------------------------
// Hidratación COMPARTIDA del banner de misión de la ola (avance %, velocidad y
// ETA) desde `/api/dash/ola-eta` — la MISMA fuente determinística que ya usa la
// HOME (totalPct + velocityETA + etaSource, #4287). Resuelve la raíz transversal
// de #4296: las subventanas derivaban el avance de CONTEOS de issues client-side
// y velocidad/ETA ni se hidrataban, quedando congeladas/divergentes respecto de
// la HOME. Un único helper para TODAS las ventanas (CA-4: raíz común, no parche
// por pantalla).
//
// Exporta:
//   - hydrateMissionBanner(documentRef, d) : función REAL (no string) que aplica
//       la hidratación sobre un `document` (o fake en tests). Testeable en Node.
//   - MISSION_OLA_ETA_CLIENT_JS : snippet client-side embebible. Se construye
//       serializando `hydrateMissionBanner` vía Function.prototype.toString —
//       UNA sola implementación, sin drift entre Node y browser. Self-tick con
//       poll 30s (mismo intervalo que el tickOlaETA de la HOME) e idempotente vía
//       guard global `window.__mbOlaETAInit`.
//
// El snippet se inyecta una sola vez por página dentro de FETCH_CLIENT_JS, así
// cualquier ventana que monte el banner (HOME y subventanas) hidrata el mismo
// dato vivo. En páginas sin los ids `mission-*`, cada setText/getElementById es
// un no-op defensivo (nunca rompe el render).
//
// Coherencia de formato (CA-2 / guideline UX): `fmtMin` y el criterio "—" para
// modo fallback replican exactamente el tickOlaETA de home.js, para que HOME y
// subventanas se perciban como el MISMO componente.
// =============================================================================

// Aplica el payload de /api/dash/ola-eta al banner de misión. Defensivo: si no
// hay `document`, payload nulo o `ready:false`, no toca nada (deja el último
// estado en pantalla, igual que la HOME). Pensada para serializarse al cliente.
function hydrateMissionBanner(documentRef, d) {
  if (!documentRef || !d || !d.ready) return;

  var setText = function (id, v) {
    var el = documentRef.getElementById(id);
    if (el && el.textContent !== String(v)) el.textContent = String(v);
  };
  // Mismo formato que home.js fmtMin (#4287): null/no-finito/<=0 → "—".
  // Number.isFinite (no el global isFinite) para NO coercionar null→0.
  var fmtMin = function (n) {
    if (n == null || !Number.isFinite(n) || n <= 0) return '—';
    var total = Math.round(n);
    if (total < 60) return total + 'm';
    var h = Math.floor(total / 60);
    var m = total % 60;
    return m === 0 ? (h + 'h') : (h + 'h ' + m + 'm');
  };

  var vel = (d.velocityETA && typeof d.velocityETA === 'object') ? d.velocityETA : null;
  var hasVelocity = d.etaSource === 'velocity' && vel
    && Number.isFinite(vel.velocityPctPerMin) && vel.velocityPctPerMin > 0;

  // Avance %: totalPct determinístico (vivo en modo velocity Y fallback). null
  // hasta que hay snapshot → "—". NUNCA derivado de conteos de issues (#4296).
  // Number.isFinite: null/undefined NO se coercionan a 0 (mostraría "0%" falso).
  if (Number.isFinite(d.totalPct)) setText('mission-avance-pct', Math.round(d.totalPct) + '%');
  else setText('mission-avance-pct', '—');

  // Velocidad: ritmo de avance en %/h (velocityPctPerMin × 60). Sin ritmo medido
  // (etaSource 'fallback' / velocityETA null) → "—" explícito, nunca "null"/0.
  // textContent (NO innerHTML): el snippet se inyecta dentro de FETCH_CLIENT_JS,
  // que es deliberadamente innerHTML-free (XSS guard de las vistas, #3953). El
  // valor es número formateado + literal, sin dato crudo del servidor.
  var vv = documentRef.getElementById('mission-vel-value');
  if (vv) {
    if (hasVelocity) vv.textContent = (vel.velocityPctPerMin * 60).toFixed(1) + ' %/h';
    else vv.textContent = '— %/h';
  }

  // ETA: con ritmo medido, restante proyectado por velocidad (coherente con el
  // sub "proyección por velocidad"); si no, la mediana p50 teórica.
  if (hasVelocity && Number.isFinite(vel.remainingMs)) setText('mission-eta-value', fmtMin(vel.remainingMs / 60000));
  else setText('mission-eta-value', fmtMin(d.totalP50));
  var es = documentRef.getElementById('mission-eta-sub');
  if (es) es.textContent = hasVelocity ? 'proyección por velocidad' : 'estimación por percentiles';
}

// Construye el snippet client-side serializando la función real. Sin template
// literals adentro (se concatena con `+`) para poder embeberse sin escapes.
function buildClientJs() {
  return '(function(){\n'
    + 'if (typeof window !== "undefined" && window.__mbOlaETAInit) return;\n'
    + 'if (typeof window !== "undefined") window.__mbOlaETAInit = true;\n'
    + 'var __mbHydrate = ' + hydrateMissionBanner.toString() + ';\n'
    + 'async function __mbFetch(u){ try { var r = await fetch(u, { cache: "no-store", headers: { accept: "application/json" } }); if(!r.ok) return null; return await r.json(); } catch(e){ return null; } }\n'
    + 'async function __mbTickOlaETA(){ var d = await __mbFetch("/api/dash/ola-eta"); if(d) __mbHydrate(document, d); }\n'
    + 'if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", function(){ __mbTickOlaETA(); setInterval(__mbTickOlaETA, 30000); });\n'
    + 'else { __mbTickOlaETA(); setInterval(__mbTickOlaETA, 30000); }\n'
    + '})();';
}

const MISSION_OLA_ETA_CLIENT_JS = buildClientJs();

module.exports = {
  hydrateMissionBanner,
  buildClientJs,
  MISSION_OLA_ETA_CLIENT_JS,
};
