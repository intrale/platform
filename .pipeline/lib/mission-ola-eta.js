'use strict';

// =============================================================================
// mission-ola-eta.js — #4296
//
// Fuente ÚNICA del avance %, velocidad (%/h) y ETA del banner de ola compartido
// (ids `mission-avance-pct` / `mission-vel-value` / `mission-eta-value`).
//
// Contexto del bug: la HOME (post #4287) ya hidrata esos tres valores desde el
// cómputo determinístico de la ola — `/api/dash/ola-eta` → `totalPct` +
// `velocityETA` — recomputado por tick. El resto de las ventanas que montan el
// MISMO banner (Issues, Pipeline, Bloqueados, Descanso, KPIs, Matriz, Ops,
// Providers, Equipo, Historial) tenían cada una su propia copia de
// `mirrorMission` que derivaba avance/velocidad de conteos de `/api/dash/waves`
// (`done/total` + `iss/h` por `openedAt`). Resultado: cada subventana mostraba
// un número distinto al de la HOME y quedaba "fosilizada" respecto del dato vivo.
//
// Este módulo centraliza la derivación (raíz común, CA-4): una función pura
// testeable + un emisor del JS cliente que TODAS las ventanas inyectan, de modo
// que consumen el mismo dato vivo y se rehidratan por tick (CA-1/CA-2/CA-3).
//
// node --test .pipeline/lib/__tests__/mission-ola-eta.test.js
// =============================================================================

/**
 * Deriva los valores del banner de ola a partir del payload de
 * `/api/dash/ola-eta`. Pura y determinística (inyectar el payload). Misma lógica
 * que el tick de la HOME (home.js → tickOlaETA, #4287) para que NO diverjan.
 *
 * Reglas:
 *   - `avancePct`: `totalPct` determinístico redondeado; `null` si todavía no
 *     hubo snapshot (la vista muestra "—"). Presente incluso en modo `fallback`.
 *     NUNCA cae al estado "sin datos" — es siempre valor real una vez que hay
 *     snapshot (G-UX-2).
 *   - `velocityPctPerHour`: ritmo medido (`velocityPctPerMin × 60`) sólo cuando
 *     `etaSource === 'velocity'` y hay un ritmo > 0; `null` en `fallback`.
 *   - `etaRemainingMin`: restante proyectado por velocidad cuando hay ritmo
 *     medido; si no, la mediana teórica `totalP50`; `null` si nada disponible.
 *   - `noVelocityData` / `velocityState`: #4325 (CA-4 / G-UX-1). Cuando no hay
 *     serie de velocidad (`etaSource === 'fallback'` o ritmo no medido), se
 *     expone un estado explícito ("sin datos suficientes") para que el cliente
 *     lo pinte como "sin datos" + tooltip, en vez del guion mudo o un 0 que
 *     mentiría un ritmo medido = 0.
 *
 * @param {object|null} d — payload de `/api/dash/ola-eta`.
 * @returns {{avancePct:number|null, velocityPctPerHour:number|null,
 *            etaRemainingMin:number|null, etaFromVelocity:boolean,
 *            hasVelocity:boolean, noVelocityData:boolean, velocityState:string}}
 */
function deriveMissionOlaEta(d) {
    const data = (d && typeof d === 'object') ? d : {};
    const vel = (data.velocityETA && typeof data.velocityETA === 'object') ? data.velocityETA : null;
    const hasVelocity = data.etaSource === 'velocity' && !!vel
        && Number.isFinite(vel.velocityPctPerMin) && vel.velocityPctPerMin > 0;
    const avancePct = Number.isFinite(data.totalPct) ? Math.round(data.totalPct) : null;
    const velocityPctPerHour = hasVelocity ? vel.velocityPctPerMin * 60 : null;
    const etaFromVelocity = hasVelocity && Number.isFinite(vel.remainingMs);
    const etaRemainingMin = etaFromVelocity
        ? vel.remainingMs / 60000
        : (Number.isFinite(data.totalP50) ? data.totalP50 : null);
    // #4325 (CA-4 / G-UX-1) — estado explícito "sin datos suficientes" cuando no
    // hay serie de velocidad. Literal inline (esta función se serializa al
    // cliente vía toString(): NO puede referenciar constantes de módulo).
    const noVelocityData = !hasVelocity;
    const velocityState = hasVelocity ? 'ok' : 'sin datos suficientes';
    return {
        avancePct, velocityPctPerHour, etaRemainingMin, etaFromVelocity, hasVelocity,
        noVelocityData, velocityState,
    };
}

/**
 * Emite el fragmento de JS cliente que toda ventana del dashboard inyecta en su
 * `<script>`. Reusa `deriveMissionOlaEta` serializada (DRY: una sola lógica) y
 * aplica el resultado al DOM por id. Asume que el script anfitrión ya define
 * `fetchJson()` (contrato presente en todas las vistas). Self-wiring e
 * idempotente: define un poll de 30s una sola vez aunque se inyecte más de una
 * vez (guard `window.__missionOlaEtaWired`).
 *
 * @returns {string} JS listo para interpolar dentro de un template de script.
 */
function missionOlaEtaClientScript() {
    return `
(function(){
  // Guard de entorno: en sandboxes de test (eval sin DOM) no hay window/document
  // → no-op. \`typeof\` evita el ReferenceError aunque el identificador no exista.
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  if (window.__missionOlaEtaWired) return;
  window.__missionOlaEtaWired = true;
  ${deriveMissionOlaEta.toString()}
  // Actualiza el valor del banner SIN innerHTML (XSS-safe): nodo de texto + el
  // <span class="mz-wm-u"> de unidad construido por DOM, no por string HTML.
  function setMzValueUnit(el, valueText, unitText){
    el.classList.remove('mz-wm-nodata');
    el.style.opacity = '';
    el.removeAttribute('title');
    while(el.firstChild) el.removeChild(el.firstChild);
    el.appendChild(document.createTextNode(valueText + ' '));
    var u = document.createElement('span');
    u.className = 'mz-wm-u';
    u.textContent = unitText;
    el.appendChild(u);
  }
  // #4325 (CA-4 / G-UX-1..3) — estado degradado honesto: "sin datos" en muted,
  // SIN unidad (no "sin datos %/h"), con tooltip explícito. No es error (sin
  // rojo): es un estado transitorio esperado hasta acumular >=2 snapshots.
  function setMzNoData(el, tooltip){
    el.classList.add('mz-wm-nodata');
    el.style.opacity = '0.6';
    if(tooltip) el.setAttribute('title', tooltip); else el.removeAttribute('title');
    while(el.firstChild) el.removeChild(el.firstChild);
    el.appendChild(document.createTextNode('sin datos'));
  }
  window.__applyMissionOlaEta = function(d){
    try{
      var m = deriveMissionOlaEta(d);
      // % de avance: SIEMPRE valor real una vez que hay snapshot; "—" sólo antes
      // del primer snapshot. Nunca "sin datos" (G-UX-2).
      var pctEl = document.getElementById('mission-avance-pct');
      if(pctEl){ var t = (m.avancePct !== null ? m.avancePct + '%' : '—'); if(pctEl.textContent !== t) pctEl.textContent = t; }
      var vv = document.getElementById('mission-vel-value');
      if(vv){
        if(m.velocityPctPerHour !== null) setMzValueUnit(vv, m.velocityPctPerHour.toFixed(1), '%/h');
        else setMzNoData(vv, 'Sin datos suficientes para calcular velocidad — se necesitan >=2 snapshots de la ola');
      }
      var ev = document.getElementById('mission-eta-value');
      if(ev){
        var x = Number(m.etaRemainingMin), txt;
        if(!Number.isFinite(x) || x <= 0){
          setMzNoData(ev, 'Sin datos suficientes para estimar ETA — se necesitan >=2 snapshots de la ola');
        } else {
          if(x < 60) txt = Math.round(x) + 'm';
          else { var h = Math.floor(x/60), r = Math.round(x%60); txt = r>0 ? h+'h '+r+'m' : h+'h'; }
          ev.classList.remove('mz-wm-nodata'); ev.style.opacity = ''; ev.removeAttribute('title');
          if(ev.textContent !== txt) ev.textContent = txt;
        }
      }
    }catch(e){}
  };
  window.__tickMissionOlaEta = function(){
    return Promise.resolve()
      .then(function(){ return (typeof fetchJson === 'function') ? fetchJson('/api/dash/ola-eta') : null; })
      .then(function(d){ if(d) window.__applyMissionOlaEta(d); })
      .catch(function(){});
  };
  window.__tickMissionOlaEta();
  if (typeof setInterval === 'function') setInterval(function(){ window.__tickMissionOlaEta(); }, 30000);
})();
`;
}

module.exports = { deriveMissionOlaEta, missionOlaEtaClientScript };
