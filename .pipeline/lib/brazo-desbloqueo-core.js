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

// =============================================================================
// #6611 — TERCERA fuente de markers para el MISMO motor: los `needs-human`
// congelados con un PREDICADO RE-EVALUABLE (`precondition.type === 'verifiable'`).
//
// El caso que cierra: un freeze de `delivery` por `http_405_blocked_requeridos_
// verdes` se congela como juicio humano y queda estructuralmente irreactivable —
// nadie lo vuelve a mirar nunca. #6145 estuvo 14 h congelado ocupando slot de ola
// con el PR ya `MERGEABLE`/`CLEAN`.
//
// DISCIPLINA (idéntica al hermano): PURA y SINCRÓNICA. Recibe las observaciones
// YA leídas por la frontera; acá no hay `fs`, ni `gh`, ni red.
//
// LIBERACIÓN SÓLO POR EVIDENCIA POSITIVA. Las 5 condiciones, todas del tick
// actual, todas con valor dentro de su enum. Nada se concluye por descarte:
// lectura fallida, `null`, o valor fuera del enum ⇒ NO liberar (`null` != `[]`,
// misma regla que `lib/required-checks.js`).
// =============================================================================

// Reusamos el clasificador de checks de `required-checks.js` en vez de re-listar
// los enums: un solo lugar donde vive "qué es un check verde". `unusable` (p.ej.
// `CheckRun` COMPLETED con `conclusion: null`) NO es verde por descarte.
const { _internal: { classifyContextState } } = require('./required-checks');

const VERIFIABLE = 'verifiable';
const PR_MERGE_BLOCKED = 'pr_merge_blocked';

// Techo de auto-destrabes por causa (CA-8). Override desde `config.yaml`.
const DEFAULT_MAX_AUTO_RELEASES = 3;

/**
 * ¿El marker tiene un predicado `pr_merge_blocked` bien formado?
 * Espejo de `human-block.normalizePrecondition`: acá se re-valida porque el
 * selector no puede confiar en que el marker en disco haya pasado por allá
 * (un `.reason.json` editado a mano, por ejemplo).
 */
function verifiablePredicateOf(marker) {
  const pc = marker && marker.precondition;
  if (!pc || pc.type !== VERIFIABLE) return null;
  const p = pc.predicate;
  if (!p || typeof p !== 'object' || Array.isArray(p)) return null;
  if (p.kind !== PR_MERGE_BLOCKED) return null;
  if (!Number.isInteger(p.pr) || p.pr <= 0) return null;
  if (typeof p.head_ref !== 'string' || !p.head_ref.trim()) return null;
  return p;
}

/**
 * Decisión de liberación para un `pr_merge_blocked`. Devuelve `null` si libera,
 * o un string con el motivo por el que NO libera (para `blocked`/observabilidad).
 *
 * `observed` del predicado NO se consulta acá a propósito: es narrativa del
 * productor del freeze. Si comparáramos "antes vs ahora", el veredicto se lo
 * estaría dando quien congeló — un `observed` mentiroso (ya `CLEAN` al congelar)
 * podría forzar la liberación. Sólo manda lo observado en ESTE tick.
 */
function releaseBlocker(marker, predicate, obs, counter, maxAutoReleases) {
  // Lectura fallida / ausente / no-objeto ⇒ fail-closed.
  if (!obs || typeof obs !== 'object' || Array.isArray(obs)) return 'observacion-ilegible';

  // Techo de reintentos (CA-8). `count()` devuelve Infinity si no pudo leer el
  // contador: no poder verificar el techo NO habilita otro destrabe.
  const max = Number.isFinite(maxAutoReleases) && maxAutoReleases > 0
    ? maxAutoReleases : DEFAULT_MAX_AUTO_RELEASES;
  const c = Number.isFinite(counter) ? counter : (counter === undefined ? 0 : Infinity);
  if (c >= max) return 'techo-de-auto-destrabes-alcanzado';

  // Enums cerrados. Cualquier otro valor no es "probablemente ok": es no.
  if (obs.state !== 'OPEN') return 'pr-no-abierto';
  if (obs.mergeable !== 'MERGEABLE') return 'pr-no-mergeable';
  if (obs.mergeStateStatus !== 'CLEAN') return 'merge-state-no-clean';

  // BINDING predicado <-> issue. Es lo que vuelve inexplotable el residual de
  // que un agente con FS pueda escribir el sidecar: no alcanza con apuntar a
  // cualquier PR verde del repo, porque su `headRefName` no matchea el del
  // issue. Manda el head_ref OBSERVADO en GitHub, no el declarado en el marker.
  if (typeof obs.headRefName !== 'string' || obs.headRefName !== predicate.head_ref) {
    return 'head-ref-no-coincide-con-el-declarado';
  }
  if (!obs.headRefName.startsWith('agent/' + marker.issue + '-')) {
    return 'head-ref-no-pertenece-al-issue';
  }

  // `null` != `[]`. Un rollup ausente es una lectura que no se pudo hacer;
  // un rollup vacío es una respuesta legítima de GitHub (PR sin checks) y las
  // 4 condiciones anteriores ya llegaron con valor del enum — `CLEAN` es el
  // veredicto de GitHub sobre la protección de rama. Vacío libera, null no.
  const rollup = obs.statusCheckRollup;
  if (rollup == null || !Array.isArray(rollup)) return 'rollup-ilegible';
  if (!rollup.every((n) => classifyContextState(n) === 'green')) return 'checks-no-verdes';

  return null; // libera
}

/**
 * #6611 — Selector puro de bloqueos verificables liberables.
 *
 * Todo marker que NO sea `type:'verifiable'` con predicado válido hace
 * `continue`: no entra ni a `toRelease` ni a `blocked`. Es exactamente el
 * tratamiento que hoy recibe el juicio humano (SEC-4, CA-3) — sin predicado
 * no hay re-evaluación, y "no evaluable" no es lo mismo que "evaluado y
 * retenido".
 *
 * @param {object} p
 * @param {Array<{issue:(string|number), precondition?:object}>} p.markers
 * @param {Record<string,object>} p.observations  pr → estado observado en el
 *        tick actual: `{ state, mergeable, mergeStateStatus, statusCheckRollup,
 *        headRefName }`. Leído en la frontera (`gh pr view`).
 * @param {Record<string,number>} [p.counters]  clave `<issue>::<kind>::<pr>` →
 *        auto-destrabes ya consumidos. Ausente ⇒ 0 (nunca se auto-destrabó);
 *        la frontera la puebla con `auto-recheck-counter.count()`, que ya es
 *        fail-closed (`Infinity`) si no pudo leer.
 * @param {number} [p.maxAutoReleases]  techo por causa (default 3).
 * @returns {{ toRelease: Array<object>, blocked: Array<object> }}
 */
function selectVerifiableHumanBlocksToRelease({ markers, observations, counters, maxAutoReleases } = {}) {
  const list = Array.isArray(markers) ? markers : [];
  const obsMap = observations && typeof observations === 'object' ? observations : {};
  const countMap = counters && typeof counters === 'object' ? counters : {};
  const toRelease = [];
  const blocked = [];

  for (const m of list) {
    if (!m || m.issue == null) continue;
    const predicate = verifiablePredicateOf(m);
    // Juicio humano / dependencia / tipo raro / predicado deforme → INTOCABLE.
    if (!predicate) continue;

    const obs = obsMap[depKey(predicate.pr)];
    const counterKey = String(m.issue) + '::' + predicate.kind + '::' + predicate.pr;
    const counter = Object.prototype.hasOwnProperty.call(countMap, counterKey)
      ? countMap[counterKey] : 0;

    const why = releaseBlocker(m, predicate, obs, counter, maxAutoReleases);
    if (why === null) {
      toRelease.push({ ...m, predicate, observed_now: obs });
    } else {
      blocked.push({ ...m, predicate, reason: why });
    }
  }

  return { toRelease, blocked };
}

module.exports = {
  selectMarkersToRelease,
  selectHumanBlocksToRelease,
  selectMergeRaceBlocksToReclaim,
  selectVerifiableHumanBlocksToRelease,
  allDepsClosed,
  depKey,
  CLOSED,
  DEFAULT_MAX_AUTO_RELEASES,
  // internos para tests
  _internal: { verifiablePredicateOf, releaseBlocker },
};
