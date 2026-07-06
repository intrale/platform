'use strict';

// =============================================================================
// mission-ola-eta.js — #4296
//
// Fuente ÚNICA del avance %, velocidad y ETA del banner de ola compartido (ids
// `mission-avance-pct` / `mission-vel-value` / `mission-eta-value`).
// #4450 — la celda de velocidad pasó de %/h de avance a throughput issues/día.
// #4532 — la celda de velocidad ahora expresa el "% de avance por issue por
// minuto" (`velocityPctPerIssuePerMin`), métrica canónica de la ola que persiste
// históricamente entre olas (una ola nueva hereda la estimación previa cross-ola)
// y no se infla al resetearse el comienzo. El ETA se deriva de esa velocidad.
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
 *   - `velocityPctPerHour`: ritmo medido (`velocityPctPerMin × 60`) sólo cuando
 *     `etaSource === 'velocity'` y hay un ritmo > 0; `null` en `fallback` (la
 *     vista muestra "— %/h", nunca 0/"null" — G-UX-1).
 *   - `etaRemainingMin`: restante = `max(proyección por velocidad, presupuesto
 *     teórico restante totalP50)` (#4449 — la velocidad optimista no puede pisar
 *     el piso teórico del trabajo restante); sólo velocidad si no hay `totalP50`,
 *     sólo `totalP50` si no hay ritmo medido; `null` si nada disponible.
 *
 * #4325 — CA-4: cuando no hay ritmo medido (`etaSource === 'fallback'` o serie de
 * velocidad ausente), en vez del guion mudo `—` se expone un estado explícito
 * `velocityState === 'sin datos suficientes'` que el cliente traduce a leyenda.
 * La cadena se inlinea DENTRO de la función a propósito: `deriveMissionOlaEta`
 * se serializa vía `.toString()` en `missionOlaEtaClientScript`, así que NO puede
 * referenciar constantes de módulo (romperían el eval del cliente por
 * ReferenceError). Ver `MISSION_INSUFFICIENT_DATA` para el mismo literal en tests.
 *
 * @param {object|null} d — payload de `/api/dash/ola-eta`.
 * @returns {{avancePct:number|null, velocityPctPerHour:number|null,
 *            etaRemainingMin:number|null, etaFromVelocity:boolean,
 *            hasVelocity:boolean, velocityState:string}}
 */
function deriveMissionOlaEta(d) {
    const data = (d && typeof d === 'object') ? d : {};
    const vel = (data.velocityETA && typeof data.velocityETA === 'object') ? data.velocityETA : null;
    // #4532 — habilita el ritmo tanto MEDIDO ('velocity') como el estimado
    // HISTÓRICO cross-ola ('historical'). Ambos traen `velocityPctPerMin` válido.
    const hasVelocity = (data.etaSource === 'velocity' || data.etaSource === 'historical') && !!vel
        && Number.isFinite(vel.velocityPctPerMin) && vel.velocityPctPerMin > 0;
    const avancePct = Number.isFinite(data.totalPct) ? Math.round(data.totalPct) : null;
    const velocityPctPerHour = hasVelocity ? vel.velocityPctPerMin * 60 : null;
    const etaFromVelocity = hasVelocity && Number.isFinite(vel.remainingMs);
    // #4449 — La velocidad optimista proyecta uniformemente sobre el % restante e
    // ignora que ese % está concentrado en issues por definir (lifecycle completo).
    // Fix: piso teórico. `totalP50` ya representa el trabajo RESTANTE porque
    // dashboard.js::_scheduleOlaETARefresh excluye los issues cerrados del cálculo
    // (CA-3). El ETA nunca puede caer por debajo de ese presupuesto (CA-1/CA-2).
    // Todo literal inline: la función se serializa vía `.toString()` al cliente, no
    // puede referenciar constantes de módulo (ReferenceError en el eval — ver L42-45).
    const velMin = etaFromVelocity ? vel.remainingMs / 60000 : null;
    const budgetMin = Number.isFinite(data.totalP50) ? data.totalP50 : null;
    let etaRemainingMin;
    if (velMin != null && budgetMin != null) etaRemainingMin = Math.max(velMin, budgetMin);
    else if (velMin != null)                 etaRemainingMin = velMin;
    else                                     etaRemainingMin = budgetMin; // puede ser null
    // Blindaje (CA-5): nunca NaN/Infinity/negativo hacia el render.
    if (!Number.isFinite(etaRemainingMin) || etaRemainingMin < 0) etaRemainingMin = null;
    const velocityState = hasVelocity ? 'measured' : 'sin datos suficientes';
    // #4450/#4532 — throughput de entrega (issues por dia) del payload. Se
    // conserva en el objeto derivado por compatibilidad (otros consumidores del
    // route lo leen), pero YA NO es la "velocidad" que pinta la celda (#4532 la
    // reemplaza por %/issue/min). Estado explícito: 'measured' (incluye 0.0
    // legítimo) o 'insufficient'.
    const throughputPerDay = Number.isFinite(data.throughputPerDay) ? data.throughputPerDay : null;
    const throughputState = (data.throughputState === 'measured' && throughputPerDay !== null)
        ? 'measured' : 'insufficient';
    // #4532 — VELOCIDAD canónica de la ola: % de avance por issue por minuto
    // (pendiente de `avancePct`, ya normalizado por issue). Reemplaza al
    // throughput de entrega como la métrica que pinta la celda 🚀 VELOCIDAD.
    //   - 'measured':   ritmo propio de la ola (etaSource 'velocity').
    //   - 'historical': estimación previa cross-ola (ola nueva sin ritmo propio).
    //   - 'insufficient': ni ritmo ni histórico → leyenda "sin datos suficientes".
    // Literales inline: esta función se serializa vía `.toString()` al cliente y
    // no puede referenciar constantes de módulo (ReferenceError en el eval).
    const velocityPctPerIssuePerMin = hasVelocity ? vel.velocityPctPerMin : null;
    const velocitySource = !hasVelocity
        ? 'insufficient'
        : (data.etaSource === 'historical' ? 'historical' : 'measured');
    return { avancePct, velocityPctPerHour, etaRemainingMin, etaFromVelocity, hasVelocity, velocityState, throughputPerDay, throughputState, velocityPctPerIssuePerMin, velocitySource };
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
    while(el.firstChild) el.removeChild(el.firstChild);
    el.appendChild(document.createTextNode(valueText + ' '));
    var u = document.createElement('span');
    u.className = 'mz-wm-u';
    u.textContent = unitText;
    el.appendChild(u);
  }
  // #4500 — Sparkline de RITMO de entrega del Timeline. Grafica el DELTA entre
  // snapshots (derivada del avance), no el avance crudo monótono, para reflejar
  // aceleración/desaceleración (matiz UX/guru). Render 100% por DOM/SVG con
  // series NUMÉRICAS (createElementNS) — nunca innerHTML (XSS-safe, series ya
  // whitelisted en el route). Degrada con gracia: <2 deltas -> línea punteada
  // placeholder + nota "datos insuficientes" (Gherkin escenario 2), sin romper
  // el layout. Devuelve el texto de tendencia para el aria-label del contenedor.
  var SVG_NS = 'http://www.w3.org/2000/svg';
  function renderMissionSpark(series){
    var plot = document.getElementById('mission-spark-plot');
    var note = document.getElementById('mission-spark-note');
    var spark = document.getElementById('mission-spark');
    if(!plot) return;
    while(plot.firstChild) plot.removeChild(plot.firstChild);
    var pts = Array.isArray(series)
      ? series.filter(function(s){ return s && Number.isFinite(s.ts) && Number.isFinite(s.avancePct); })
      : [];
    var deltas = [];
    for(var i=1;i<pts.length;i++){ deltas.push(Math.max(0, pts[i].avancePct - pts[i-1].avancePct)); }
    var W = 100, H = 24, pad = 2;
    if(deltas.length < 2){
      // Placeholder: rail punteado + nota explícita. Nunca rompe el layout.
      var svgP = document.createElementNS(SVG_NS, 'svg');
      svgP.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
      svgP.setAttribute('class', 'mz-spark-svg');
      svgP.setAttribute('preserveAspectRatio', 'none');
      var ln = document.createElementNS(SVG_NS, 'line');
      ln.setAttribute('x1', '0'); ln.setAttribute('y1', String(H/2));
      ln.setAttribute('x2', String(W)); ln.setAttribute('y2', String(H/2));
      ln.setAttribute('stroke', 'var(--in-fg-dim,#8b949e)');
      ln.setAttribute('stroke-width', '1'); ln.setAttribute('stroke-dasharray', '3 3');
      svgP.appendChild(ln); plot.appendChild(svgP);
      if(note){ note.textContent = 'datos insuficientes'; }
      if(spark) spark.setAttribute('aria-label', 'Ritmo de entrega: datos insuficientes');
      return;
    }
    var max = 0;
    for(var j=0;j<deltas.length;j++){ if(deltas[j] > max) max = deltas[j]; }
    var n = deltas.length, stepX = (n > 1) ? (W/(n-1)) : 0, coords = [];
    for(var k=0;k<n;k++){
      var x = (n > 1) ? (k*stepX) : (W/2);
      var norm = (max > 0) ? (deltas[k]/max) : 0;
      var y = (H - pad) - norm*(H - 2*pad);
      coords.push(x.toFixed(1) + ',' + y.toFixed(1));
    }
    var svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
    svg.setAttribute('class', 'mz-spark-svg');
    svg.setAttribute('preserveAspectRatio', 'none');
    var poly = document.createElementNS(SVG_NS, 'polyline');
    poly.setAttribute('points', coords.join(' '));
    poly.setAttribute('fill', 'none');
    poly.setAttribute('stroke', 'var(--brand-cyan,#34D9E0)');
    poly.setAttribute('stroke-width', '1.5');
    poly.setAttribute('stroke-linejoin', 'round');
    poly.setAttribute('stroke-linecap', 'round');
    svg.appendChild(poly); plot.appendChild(svg);
    // Tendencia: promedio de la 2da mitad vs la 1ra (±15% de banda muerta).
    var mid = Math.floor(n/2), a = 0, b = 0, ca = 0, cb = 0;
    for(var p=0;p<n;p++){ if(p < mid){ a += deltas[p]; ca++; } else { b += deltas[p]; cb++; } }
    var avgA = ca ? a/ca : 0, avgB = cb ? b/cb : 0, trend = 'estable';
    if(avgB > avgA*1.15) trend = 'acelerando';
    else if(avgB < avgA*0.85) trend = 'desacelerando';
    if(note){ note.textContent = trend; }
    if(spark) spark.setAttribute('aria-label', 'Ritmo de entrega: ' + trend);
  }
  window.__applyMissionOlaEta = function(d){
    try{
      var m = deriveMissionOlaEta(d);
      var pctEl = document.getElementById('mission-avance-pct');
      if(pctEl){ var t = (m.avancePct !== null ? m.avancePct + '%' : '—'); if(pctEl.textContent !== t) pctEl.textContent = t; }
      // #4452 — la barra representa EXCLUSIVAMENTE el % de avance de la ola
      // (fuente única avancePct), desacoplada de la distribución por estado.
      // Clamp [0,100] (SEC req #3); null -> 0%. Solo style.width numerico,
      // NUNCA innerHTML (SEC req #1,#2).
      var bar = document.getElementById('mission-bar-progress');
      var posPct = (m.avancePct === null) ? 0 : Math.max(0, Math.min(100, m.avancePct));
      if(bar){
        var wStr = posPct + '%';
        if(bar.style.width !== wStr) bar.style.width = wStr;
      }
      // #4500 — el marcador "ahora" del Timeline vive SOBRE la misma línea que el
      // fill (#mission-bar-progress). Se posiciona por avancePct (clamp [0,100]);
      // null -> cerca del inicio (0%). aria-label/title con el % TEXTUAL para no
      // depender sólo de la posición visual (accesibilidad UX). Sólo style.left
      // numérico + setAttribute con texto derivado — nunca innerHTML (XSS-safe).
      var nowMark = document.getElementById('mission-tl-now');
      if(nowMark){
        var lStr = posPct + '%';
        if(nowMark.style.left !== lStr) nowMark.style.left = lStr;
        var lbl = 'Avance de la ola: ' + (m.avancePct === null ? 'sin dato aún' : m.avancePct + '%');
        if(nowMark.getAttribute('aria-label') !== lbl){
          nowMark.setAttribute('aria-label', lbl);
          nowMark.setAttribute('title', lbl);
        }
      }
      // La anotación de velocidad ancla al marcador "ahora" (UX: velocidad↔marcador).
      var velAnnot = document.getElementById('mission-vel-annot');
      if(velAnnot){ var vlStr = posPct + '%'; if(velAnnot.style.left !== vlStr) velAnnot.style.left = vlStr; }
      var vv = document.getElementById('mission-vel-value');
      if(vv){
        // #4532 (G-UX-1) — la celda 🚀 VELOCIDAD expresa el % de avance por issue
        // por minuto (metrica canonica del issue), reemplazando al throughput de
        // entrega (que se inflaba al resetearse el comienzo de la ola). Medido o
        // estimado historico -> "N.NN %/issue·min"; sin datos suficientes ->
        // leyenda explicita, nunca un "—" mudo ni un 0 enganoso. Render XSS-safe
        // (createTextNode, R-1).
        if(m.velocityPctPerIssuePerMin !== null && Number.isFinite(m.velocityPctPerIssuePerMin)){
          setMzValueUnit(vv, m.velocityPctPerIssuePerMin.toFixed(2), '%/issue·min');
        } else {
          while(vv.firstChild) vv.removeChild(vv.firstChild);
          vv.appendChild(document.createTextNode('sin datos suficientes'));
        }
      }
      var ev = document.getElementById('mission-eta-value');
      if(ev){
        var x = Number(m.etaRemainingMin), txt;
        if(!Number.isFinite(x) || x <= 0) txt = '—';
        else if(x < 60) txt = Math.round(x) + 'm';
        else { var h = Math.floor(x/60), r = Math.round(x%60); txt = r>0 ? h+'h '+r+'m' : h+'h'; }
        if(ev.textContent !== txt) ev.textContent = txt;
      }
      // #4500 — sparkline de ritmo. La serie viaja en el payload crudo d.series
      // (whitelist numerico del route), no en el objeto derivado m.
      try{ renderMissionSpark(d && d.series); }catch(_){}
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

// #4325 — leyenda del estado explícito "sin datos suficientes" (CA-4). El mismo
// literal se inlinea dentro de `deriveMissionOlaEta` (no puede referenciar esta
// constante por la serialización `.toString()` al cliente); se exporta para que
// los tests y otros consumidores usen la misma cadena sin hardcodearla.
const MISSION_INSUFFICIENT_DATA = 'sin datos suficientes';

module.exports = { deriveMissionOlaEta, missionOlaEtaClientScript, MISSION_INSUFFICIENT_DATA };
