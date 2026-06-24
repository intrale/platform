// =============================================================================
// brazo-desbloqueo-core.js — Decisión pura de liberación de bloqueos (EP5-H1, #3938)
//
// CONTEXTO
// --------
// `brazoDesbloqueoImpl` (pulpo.js:~13065) escanea los issues con label
// `blocked:dependencies`, lee sus dependencias declaradas y, cuando TODAS están
// CLOSED en GitHub, libera el issue: quita el label y reingresa sus work-files
// de `bloqueado-dependencias/` a `pendiente/` (vía
// `reboteClassifier.releaseDependencyBlockToPendiente`).
//
// La mayor parte de la mecánica de FS ya vive extraída en
// `rebote-classifier.js` (`releaseDependencyBlockToPendiente`,
// `listDependencyBlockedMarkers`). Este módulo extrae la DECISIÓN PURA: dado un
// conjunto de markers (issue → [deps]) y un mapa de estados de issues
// (issueNumber → 'OPEN'|'CLOSED'|...), determinar qué markers liberar.
//
// Sin acceso a `fs`/`gh`: la frontera (el brazo en pulpo.js) lee los markers y
// consulta GitHub; esta función decide; el brazo aplica el efecto.
//
// SEMÁNTICA FAIL-CLOSED
// ---------------------
// Espejo de la lógica del brazo (pulpo.js:~13290 `allClosed`): un marker se
// libera SOLO si todas sus deps están explícitamente CLOSED. Si el estado de
// alguna dep es desconocido/ilegible (no figura en `issueStates` o no es
// 'CLOSED'), se asume abierta → NO se libera (conservador, evita destrabes
// prematuros). Un marker sin deps numéricas no se libera por este camino
// (espera asset/recurso, no issue concreto).
// =============================================================================

'use strict';

const CLOSED = 'CLOSED';

/**
 * Normaliza un número de issue/dep a string (clave estable para lookup).
 * @param {string|number} n
 * @returns {string}
 */
function depKey(n) {
  return String(n).trim();
}

/**
 * ¿Están todas las dependencias de un marker CLOSED según `issueStates`?
 * Fail-closed: dep ausente o con estado != 'CLOSED' → false.
 *
 * @param {Array<string|number>} deps
 * @param {Record<string,string>} issueStates - issueNumber → estado
 * @returns {boolean}
 */
function allDepsClosed(deps, issueStates) {
  if (!Array.isArray(deps) || deps.length === 0) return false; // sin deps numéricas → no libera por este camino
  const states = issueStates && typeof issueStates === 'object' ? issueStates : {};
  for (const dep of deps) {
    const st = states[depKey(dep)];
    if (st !== CLOSED) return false; // desconocido o abierto → fail-closed
  }
  return true;
}

/**
 * Decidir qué markers liberar a partir de los estados de sus dependencias.
 *
 * @param {object} p
 * @param {Array<{issue:(string|number), deps:Array<string|number>}>} p.markers
 *        markers de bloqueo por dependencias (ya leídos en la frontera).
 * @param {Record<string,string>} p.issueStates - estado por issue/dep
 *        (issueNumber → 'OPEN'|'CLOSED'|...), consultado en la frontera.
 * @returns {{
 *   toRelease: Array<{issue:(string|number), deps:Array<string|number>}>,
 *   blocked: Array<{issue:(string|number), deps:Array<string|number>, openDeps:string[]}>
 * }}
 */
function selectMarkersToRelease({ markers, issueStates } = {}) {
  const list = Array.isArray(markers) ? markers : [];
  const states = issueStates && typeof issueStates === 'object' ? issueStates : {};
  const toRelease = [];
  const blocked = [];

  for (const m of list) {
    if (!m || m.issue == null) continue;
    const deps = Array.isArray(m.deps) ? m.deps : [];
    if (allDepsClosed(deps, states)) {
      toRelease.push(m);
    } else {
      const openDeps = deps
        .map(depKey)
        .filter((d) => states[d] !== CLOSED);
      blocked.push({ ...m, openDeps });
    }
  }

  return { toRelease, blocked };
}

module.exports = {
  selectMarkersToRelease,
  allDepsClosed,
  CLOSED,
};
