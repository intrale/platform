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

const { PR_PROVENANCE_FIELDS, checkPrProvenance } = require('./pr-provenance');

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

/**
 * #4748 — SEGUNDA fuente de markers para el MISMO motor fail-closed: los
 * `needs-human` cuyo motivo de freeze se congeló como precondición de
 * dependencia (`precondition.type === 'dependency'`). Reutiliza `allDepsClosed`
 * — la misma decisión que gobierna los `blocked:dependencies` — para que exista
 * una sola máquina de destrabe, no dos divergentes.
 *
 * Sólo considera markers con `precondition.type === 'dependency'` y
 * `precondition.depends_on` no vacío. Cualquier otro (juicio humano, ausente,
 * tipo desconocido) se IGNORA por completo: no entra ni a `toRelease` ni a
 * `blocked`, dejando el fail-closed del juicio humano intacto (SEC-4, CA-3).
 *
 * @param {object} p
 * @param {Array<{issue:(string|number), precondition?:{type:string, depends_on?:Array<string|number>}}>} p.markers
 * @param {Record<string,string>} p.issueStates - estado observado por dep
 * @returns {{ toRelease: Array<object>, blocked: Array<object> }}
 */
function selectHumanBlocksToRelease({ markers, issueStates } = {}) {
  const list = Array.isArray(markers) ? markers : [];
  const states = issueStates && typeof issueStates === 'object' ? issueStates : {};
  const toRelease = [];
  const blocked = [];

  for (const m of list) {
    const pc = m && m.precondition;
    // SÓLO dependencia estructurada. Juicio humano / ausente / tipo raro →
    // intocable (SEC-4). No lo agregamos ni a toRelease ni a blocked.
    if (!pc || pc.type !== 'dependency') continue;
    const deps = Array.isArray(pc.depends_on) ? pc.depends_on : [];
    if (deps.length === 0) continue; // sin deps declaradas → intocable
    if (allDepsClosed(deps, states)) {
      toRelease.push(m);
    } else {
      const openDeps = deps.map(depKey).filter((d) => states[d] !== CLOSED);
      blocked.push({ ...m, openDeps });
    }
  }

  return { toRelease, blocked };
}

function selectMergeRaceBlocksToReclaim({ markers, prStates, ledger, maxAttempts = 3 } = {}) {
  const toReclaim = [], toDegrade = [], skipped = [];
  const states = prStates && typeof prStates === 'object' ? prStates : {};
  const attemptsByIssue = ledger && typeof ledger === 'object' ? ledger : {};
  const required = [...PR_PROVENANCE_FIELDS, 'state', 'mergeStateStatus', 'headRefOid', 'headRefName', 'labels'];
  const skip = (marker, reason) => skipped.push({ marker, reason });
  for (const marker of Array.isArray(markers) ? markers : []) {
    const pc = marker && marker.precondition;
    if (!pc || pc.type !== 'merge_checks_race') continue;
    if (!Number.isInteger(pc.pr) || pc.pr <= 0 || !/^[0-9a-f]{40}$/.test(pc.head_sha || '')) { skip(marker, 'precondicion_invalida'); continue; }
    const pr = states[pc.pr];
    if (!pr || required.some((field) => pr[field] === undefined)) { skip(marker, 'pr_incompleto'); continue; }
    const provenance = checkPrProvenance(pr, { repo: 'intrale/platform' });
    if (!provenance.ok) { skip(marker, `procedencia:${provenance.reason}`); continue; }
    const head = typeof pr.headRefOid === 'string' ? pr.headRefOid.toLowerCase() : '';
    if (!/^[0-9a-f]{40}$/.test(head) || head !== pc.head_sha) { skip(marker, 'head_movido'); continue; }
    if (pr.state !== 'OPEN') { skip(marker, 'pr_no_abierto'); continue; }
    if (!['CLEAN', 'UNSTABLE'].includes(pr.mergeStateStatus)) { skip(marker, 'pr_no_mergeable'); continue; }
    const branch = /^agent\/(\d+)-/.exec(pr.headRefName || '');
    if (!branch || Number(branch[1]) !== Number(marker.issue)) { skip(marker, 'rama_ajena'); continue; }
    const labels = pr.labels.map((label) => typeof label === 'string' ? label : label && label.name);
    if (!labels.includes('qa:passed')) { skip(marker, 'qa_no_aprobado'); continue; }
    const entry = attemptsByIssue[String(Number(marker.issue))];
    const samePair = entry && Number(entry.pr) === pc.pr && String(entry.head_sha || '').toLowerCase() === pc.head_sha;
    if (samePair && (entry.degraded === true || Number(entry.attempts || 0) >= maxAttempts)) { toDegrade.push(marker); continue; }
    toReclaim.push(marker);
  }
  return { toReclaim, toDegrade, skipped };
}

module.exports = {
  selectMarkersToRelease,
  selectHumanBlocksToRelease,
  selectMergeRaceBlocksToReclaim,
  allDepsClosed,
  depKey,
  CLOSED,
};
