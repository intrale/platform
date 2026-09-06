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
// libera SOLO si todas sus deps están explícitamente cumplidas — `CLOSED` o
// `MERGED` (#6901: GitHub reporta `MERGED` para un PR mergeado, y tratarlo como
// abierto congelaba el issue para siempre). Si el estado de alguna dep es
// desconocido/ilegible (no figura en `issueStates` o no está en la allowlist de
// `isDependencySatisfied`), se asume abierta → NO se libera (conservador, evita
// destrabes prematuros). Un marker sin deps numéricas no se libera por este camino
// (espera asset/recurso, no issue concreto).
// =============================================================================

'use strict';

const { PR_PROVENANCE_FIELDS, checkPrProvenance } = require('./pr-provenance');

const CLOSED = 'CLOSED';
const MERGED = 'MERGED';

// =============================================================================
// #6901 — ESTADO DE DEPENDENCIA CUMPLIDA (fuente única de verdad)
// -----------------------------------------------------------------------------
// GitHub reporta `MERGED` (no `CLOSED`) para un pull request mergeado. Comparar
// contra el literal `CLOSED` contaba esa dependencia como abierta y, por la
// semántica fail-closed, el issue que la declaraba quedaba congelado PARA
// SIEMPRE: el PR ya está mergeado y su estado no va a cambiar nunca más.
//
// El criterio vive acá, una sola vez, y todos los caminos de decisión del brazo
// lo consumen (`allDepsClosed`, los reportes de deps pendientes,
// `decideSplitUmbrellaClose` y los call-sites de `pulpo.js`).
//
// ALLOWLIST EXPLÍCITA, NUNCA DENYLIST: un `!== 'OPEN'` convertiría cualquier
// estado ilegible o desconocido en "cumplido" y rompería el fail-closed. Este
// cambio AMPLÍA el conjunto de estados cumplidos; no lo relaja.
// =============================================================================

/** Estados que cuentan como dependencia cumplida. Allowlist cerrada. */
const SATISFIED_DEP_STATES = Object.freeze([CLOSED, MERGED]);
const SATISFIED_DEP_STATE_SET = new Set(SATISFIED_DEP_STATES);

/** Verbo con el que se le nombra al operador cada estado cumplido (UX #6901). */
const SATISFIED_DEP_VERB = Object.freeze({
  [CLOSED]: 'fue cerrada',
  [MERGED]: 'fue mergeada',
});

/**
 * Normaliza un estado de dependencia para comparar. No inventa valores: si no
 * es un string, devuelve cadena vacía (que jamás está en la allowlist).
 * @param {*} state
 * @returns {string}
 */
function normalizeDepState(state) {
  return typeof state === 'string' ? state.trim().toUpperCase() : '';
}

/**
 * #6901 — Único criterio de "dependencia cumplida" del brazo de desbloqueo.
 *
 * @param {*} state estado observado en GitHub (`gh issue view --json state`)
 * @returns {boolean} true SOLO para `CLOSED` y `MERGED`. Ausente, nulo, string
 *   vacío, no-string o estado desconocido → false (fail-closed intacto).
 */
function isDependencySatisfied(state) {
  return SATISFIED_DEP_STATE_SET.has(normalizeDepState(state));
}

/**
 * Une referencias en castellano natural: "#1", "#1 y #2", "#1, #2 y #3".
 * @param {string[]} parts
 * @returns {string}
 */
function joinNatural(parts) {
  const arr = (Array.isArray(parts) ? parts : []).filter(Boolean);
  if (arr.length === 0) return '';
  if (arr.length === 1) return arr[0];
  return `${arr.slice(0, -1).join(', ')} y ${arr[arr.length - 1]}`;
}

/**
 * #6901 CA-5 — Redacción fiel de las dependencias que SÍ se cumplieron: verbo
 * POR dependencia, no verbo global. Con una dep cerrada y una mergeada, decir
 * "las siguientes dependencias cerraron" le miente al operador sobre el PR.
 *
 * @param {Array<string|number>} deps
 * @param {Record<string,string>} [states] dep → estado observado
 * @returns {string} p.ej. "#5203 fue mergeada y #5204 fue cerrada"
 */
function describeSatisfiedDeps(deps, states) {
  const map = states && typeof states === 'object' ? states : {};
  const parts = (Array.isArray(deps) ? deps : []).map(depKey).filter(Boolean).map((d) => {
    const ref = d.replace(/^#/, '');
    const st = normalizeDepState(map[ref] ?? map[d]);
    // Estado no informado: no se inventa verbo, se dice lo único que se sabe.
    const verbo = SATISFIED_DEP_VERB[st] || 'quedó resuelta';
    return `#${ref} ${verbo}`;
  });
  return parts.length ? joinNatural(parts) : '(ninguna)';
}

/**
 * #6901 CA-4 / UX punto 4 — Redacción del freno. El operador tiene que poder
 * distinguir "sigue abierta" de "no pude leerla y por las dudas la cuento como
 * abierta": la diferencia es entre entender el freno y abrir un incidente al
 * pedo.
 *
 * @param {Array<string|number>} deps dependencias NO cumplidas
 * @param {Record<string,string>} [states] dep → estado observado (ausente = ilegible)
 * @returns {string}
 */
function describePendingDeps(deps, states) {
  const map = states && typeof states === 'object' ? states : {};
  const parts = (Array.isArray(deps) ? deps : []).map(depKey).filter(Boolean).map((d) => {
    const ref = d.replace(/^#/, '');
    const st = normalizeDepState(map[ref] ?? map[d]);
    if (st === 'OPEN') return `#${ref} sigue abierta`;
    if (!st) return `no se pudo leer el estado de #${ref} — se asume abierta por precaución`;
    return `#${ref} está en estado no reconocido (${st}) — se asume abierta por precaución`;
  });
  return parts.length ? joinNatural(parts) : '(ninguna)';
}

/**
 * Normaliza un número de issue/dep a string (clave estable para lookup).
 * @param {string|number} n
 * @returns {string}
 */
function depKey(n) {
  return String(n).trim();
}

/**
 * ¿Están todas las dependencias de un marker CUMPLIDAS según `issueStates`?
 * El criterio es `isDependencySatisfied` (#6901): `CLOSED` o `MERGED`.
 * Fail-closed: dep ausente, ilegible o con estado fuera de esa allowlist → false.
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
    if (!isDependencySatisfied(st)) return false; // desconocido o abierto → fail-closed (#6901: CLOSED y MERGED cuentan)
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
        .filter((d) => !isDependencySatisfied(states[d]));
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
      const openDeps = deps.map(depKey).filter((d) => !isDependencySatisfied(states[d]));
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

// =============================================================================
// #6801 — Decisión pura: con TODAS las dependencias cerradas, ¿este issue se
// auto-cierra como paraguas de split, se destraba, o no se toca?
//
// EL BUG QUE ESTO REEMPLAZA
// -------------------------
// El brazo decidía "esto es un paraguas" con `labels.includes('split')`. Ese
// label lo llevan TANTO el issue paraguas COMO cada `[Split de #N]` hija. Y la
// lista que mostraba como "sus historias hijas" salía de `blockedBy[issue]` —
// que son DEPENDENCIAS, no hijas. Resultado verificado: cuatro hijas de split
// sin una sola línea implementada cerradas como `completed` (#5791, #5797,
// #5798, #5799), con un comentario de auditoría falso por construcción.
//
// ORDEN DE DECISIÓN (cubre CA-1/CA-2/CA-3)
// ----------------------------------------
//   1. El título matchea `[Split de #P]` → es HIJA → jamás se cierra por este
//      camino. Se destraba y reingresa al pipeline.
//   2. No lleva el label `split` → camino normal de desbloqueo.
//   3. Lleva `split` y NO es hija → candidato a paraguas. Se cierra SOLO si la
//      lista de sub-historias vino de una relación explícita padre→hijas
//      (registro del split en el body, o títulos `[Split de #N]`) y TODAS están
//      CLOSED. Lista indeterminable → NO cierra (fail-closed) y lo dice.
//
// La señal `source: 'labels'` de `split-guard.isSplitChild()` NO se usa a
// propósito: `split` + `blocked:dependencies` es exactamente el estado de un
// paraguas legítimo bloqueado por sus hijas, así que confiar en ella clasifica
// a todo padre real como hija y produce la regresión inversa.
//
// Las dependencias NUNCA se usan como hijas. Se arrastran sólo para nombrarlas
// por lo que son en los mensajes al operador (CA-4).
// =============================================================================

const { parseSplitParent } = require('./split-guard');

const UMBRELLA_LABEL = 'split';

// De dónde salió la lista de hijas, en castellano para el operador (CA-4: el
// mensaje nombra la lista que realmente se evaluó y de dónde la sacó).
const CHILDREN_SOURCE_LABEL = {
  registro: 'del registro del split en el body de este issue',
  titulos: 'de los títulos `[Split de #N]` de las hijas',
};

function labelNamesOf(issue) {
  const raw = issue && Array.isArray(issue.labels) ? issue.labels : [];
  return raw
    .map(l => String((l && typeof l === 'object' ? l.name : l) ?? '').trim().toLowerCase())
    .filter(Boolean);
}

function normalizeIssueIds(ids) {
  const out = [];
  for (const raw of Array.isArray(ids) ? ids : []) {
    const n = Number.parseInt(String(raw ?? '').replace(/^#/, '').trim(), 10);
    if (Number.isInteger(n) && n > 0 && !out.includes(n)) out.push(n);
  }
  return out;
}

function fmtRefs(list) {
  const arr = (Array.isArray(list) ? list : []).map(n => '#' + depKey(n).replace(/^#/, ''));
  return arr.length ? arr.join(', ') : '(ninguna)';
}

/**
 * @param {object} p
 * @param {{number: number|string, title: string, labels?: Array}} p.issue
 * @param {Array<string|number>} [p.deps] dependencias declaradas ya verificadas como cumplidas
 * @param {Record<string,string>} [p.depStates] dep → estado observado ('CLOSED'|'MERGED'|...),
 *        para nombrar en los mensajes con el verbo real de cada una (#6901 CA-5)
 * @param {Array<number|string>|null} [p.children] hijas descubiertas (null = indeterminable)
 * @param {'registro'|'titulos'|null} [p.childrenSource] de dónde salió `children`
 * @param {Record<string,string>} [p.childStates] hija → 'OPEN'|'CLOSED'|...
 * @param {boolean|null} [p.hasLinkedPr] ¿el issue tiene PR asociado? null = desconocido
 * @returns {{action:'close'|'unblock'|'skip', reason:string, parent:number|null,
 *            deps:string[], children:number[], childrenSource:string|null,
 *            warnNoPr:boolean, log:string, comment:string|null, telegram:string|null}}
 */
function decideSplitUmbrellaClose({
  issue,
  deps = [],
  depStates = null,
  children = null,
  childrenSource = null,
  childStates = null,
  hasLinkedPr = null,
} = {}) {
  const depRefs = (Array.isArray(deps) ? deps : []).map(depKey).filter(Boolean);
  // #6901 CA-5 — verbo POR dependencia: "#5203 fue mergeada y #5204 fue cerrada".
  // Un verbo global ("cerraron") le miente al operador cuando la dep es un PR.
  const depDetalle = describeSatisfiedDeps(depRefs, depStates);
  const base = {
    parent: null,
    deps: depRefs,
    children: [],
    childrenSource: null,
    warnNoPr: false,
    comment: null,
    telegram: null,
  };

  // Fail-closed de entrada: sin título legible no se puede distinguir un
  // paraguas de una hija, y confundirlos fue exactamente el defecto de #6801.
  if (!issue || typeof issue !== 'object' || typeof issue.title !== 'string') {
    return {
      ...base,
      action: 'skip',
      reason: 'entrada-invalida',
      log: 'issue sin título legible: no se puede distinguir paraguas de hija — no se toca (fail-closed)',
    };
  }

  const number = depKey(issue.number);
  const labels = labelNamesOf(issue);
  const parent = parseSplitParent(issue.title);

  // 1. CA-3 — Hija de split. Nunca se auto-cierra, aunque lleve el label
  //    `split` y todas sus dependencias estén cerradas. Se destraba.
  if (parent !== null && depKey(parent) !== number) {
    return {
      ...base,
      action: 'unblock',
      reason: 'hija-de-split',
      parent,
      log: `#${number}: es hija del split de #${parent} — se destraba, NUNCA se auto-cierra (CA-3 #6801). Dependencias resueltas: ${depDetalle}`,
      telegram: `⚠️ #${number} no se auto-cerró: es hija de split (\`[Split de #${parent}]\`) y el trabajo sigue pendiente. Se le quitó \`blocked:dependencies\` y reingresa al pipeline.`,
    };
  }

  // 2. Sin label `split` → desbloqueo normal.
  if (!labels.includes(UMBRELLA_LABEL)) {
    return {
      ...base,
      action: 'unblock',
      reason: 'sin-label-split',
      log: `#${number}: destrabado — ${depDetalle}`,
    };
  }

  // 3. Candidato a paraguas: hace falta la lista REAL de sub-historias.
  const childIds = normalizeIssueIds(children).filter(n => depKey(n) !== number);
  if (!childIds.length) {
    return {
      ...base,
      action: 'skip',
      reason: 'hijas-indeterminables',
      log: `#${number}: lleva label \`split\` pero no se pudo determinar su lista de sub-historias — NO se cierra (fail-closed CA-2 #6801). Dependencias resueltas: ${depDetalle}`,
      telegram: `⚠️ #${number} no se auto-cerró: lleva el label \`split\` pero no se pudo determinar qué sub-historias lo componen, así que el pipeline prefiere no cerrarlo. Sus dependencias declaradas sí se resolvieron (${depDetalle}). Revisalo a mano: si es un paraguas real, agregale al body la línea **Sub-historias** con los números de las hijas.`,
    };
  }

  // 4. Todas las sub-historias tienen que estar CLOSED. Fail-closed: estado
  //    ausente o ilegible cuenta como abierta.
  const states = childStates && typeof childStates === 'object' ? childStates : {};
  const openChildren = childIds.filter(n => !isDependencySatisfied(states[depKey(n)]));
  if (openChildren.length) {
    return {
      ...base,
      action: 'skip',
      reason: 'hijas-abiertas',
      children: childIds,
      childrenSource,
      log: `#${number}: paraguas con sub-historias todavía abiertas (${fmtRefs(openChildren)}) — NO se cierra. Sus dependencias declaradas sí se resolvieron: ${depDetalle}`,
      telegram: `⚠️ #${number} no se auto-cerró: sus dependencias se resolvieron (${depDetalle}), pero todavía tiene sub-historias abiertas (${fmtRefs(openChildren)}). Sigue esperando a que se completen.`,
    };
  }

  // 5. Paraguas verificado contra su relación explícita padre→hijas → cerrar.
  const fuente = CHILDREN_SOURCE_LABEL[childrenSource] || 'de la relación padre→hijas verificada';
  const warnNoPr = hasLinkedPr === false;
  const comment = [
    '## ✅ Paraguas resuelto',
    '',
    `Este issue es el **padre** de un split y todas sus sub-historias están cerradas: ${fmtRefs(childIds)}.`,
    '',
    `- **Sub-historias evaluadas** (relación padre→hijas, leída ${fuente}): ${fmtRefs(childIds)}`,
    `- **Dependencias declaradas de este issue** (no son sus hijas, se listan aparte): ${fmtRefs(depRefs)}`,
    '',
    'El scope queda cubierto por las sub-historias, no requiere desarrollo adicional.',
    '',
    '_Cerrado automáticamente por el brazo de desbloqueo del pipeline._',
  ].join('\n');

  const telegram = [
    `🟢 Paraguas #${number} cerrado automáticamente — sus sub-historias (${fmtRefs(childIds)}), tomadas ${fuente}, están todas cerradas.`,
    warnNoPr
      ? `⚠️ Ojo: el paraguas no tiene ningún PR propio asociado. Se cerró por cobertura de sus sub-historias — si esperabas un entregable propio, revisalo.`
      : null,
  ].filter(Boolean).join('\n');

  return {
    ...base,
    action: 'close',
    reason: 'paraguas-verificado',
    children: childIds,
    childrenSource,
    warnNoPr,
    log: `#${number}: paraguas real con sub-historias cerradas (${fmtRefs(childIds)}, fuente=${childrenSource || 'desconocida'}) → auto-cerrando. Dependencias declaradas: ${depDetalle}`,
    comment,
    telegram,
  };
}

// =============================================================================
// #6801 CA-7 — Auditoría del radio de impacto: ¿este issue CERRADO fue víctima
// del bug del auto-cierre?
//
// No alcanza con matchear el texto "Paraguas resuelto": varias de esas issues
// volvieron a cerrar después, esta vez con PR real (#5797 ← PR #6806), y
// reabrirlas sería destruir trabajo legítimo. Se reabre sólo si se cumplen LAS
// TRES condiciones: (a) el título es `[Split de #N]` (es una hija, no un
// paraguas), (b) la cerró el brazo con el comentario espurio, (c) no tiene
// ningún PR asociado que la cierre.
// =============================================================================

// Frase que sólo escribe el brazo de desbloqueo al auto-cerrar.
const UMBRELLA_CLOSE_MARKER = /paraguas resuelto/i;
const UMBRELLA_CLOSE_SIGNATURE = /brazo de desbloqueo/i;

/**
 * @param {object} issue — `gh issue view --json number,title,state,comments,closedByPullRequestsReferences`
 * @returns {{reopen: boolean, reason: string, parent: number|null, marker: boolean, prs: number}}
 */
function classifySpuriousUmbrellaClose(issue) {
  const none = { reopen: false, reason: 'entrada-invalida', parent: null, marker: false, prs: 0 };
  if (!issue || typeof issue !== 'object' || typeof issue.title !== 'string') return none;

  const prs = Array.isArray(issue.closedByPullRequestsReferences)
    ? issue.closedByPullRequestsReferences.length
    : 0;
  const comments = Array.isArray(issue.comments) ? issue.comments : [];
  const marker = comments.some(c => {
    const body = c && typeof c.body === 'string' ? c.body : '';
    return UMBRELLA_CLOSE_MARKER.test(body) && UMBRELLA_CLOSE_SIGNATURE.test(body);
  });
  const parent = parseSplitParent(issue.title);
  const out = { reopen: false, reason: '', parent, marker, prs };

  if (String(issue.state || '').toUpperCase() !== 'CLOSED') {
    return { ...out, reason: 'no-esta-cerrado' };
  }
  if (parent === null || depKey(parent) === depKey(issue.number)) {
    return { ...out, reason: 'no-es-hija-de-split' };
  }
  if (!marker) {
    return { ...out, reason: 'no-la-cerro-el-brazo' };
  }
  if (prs > 0) {
    // Cierre legítimo posterior: el comentario espurio sigue en el historial,
    // pero el entregable existe.
    return { ...out, reason: 'tiene-pr-asociado' };
  }
  return { ...out, reopen: true, reason: 'hija-cerrada-por-el-brazo-sin-pr' };
}

module.exports = {
  selectMarkersToRelease,
  selectHumanBlocksToRelease,
  selectMergeRaceBlocksToReclaim,
  selectVerifiableHumanBlocksToRelease,
  allDepsClosed,
  // #6801 — paraguas de split: cerrar sólo con relación padre→hijas verificada
  decideSplitUmbrellaClose,
  // #6801 CA-7 — auditoría del radio de impacto del auto-cierre espurio
  classifySpuriousUmbrellaClose,
  depKey,
  CLOSED,
  // #6901 — criterio único de dependencia cumplida (CLOSED + MERGED)
  MERGED,
  SATISFIED_DEP_STATES,
  isDependencySatisfied,
  normalizeDepState,
  // #6901 CA-5 — redacción fiel para el operador (verbo por dependencia)
  describeSatisfiedDeps,
  describePendingDeps,
  DEFAULT_MAX_AUTO_RELEASES,
  // internos para tests
  _internal: { verifiablePredicateOf, releaseBlocker },
};
