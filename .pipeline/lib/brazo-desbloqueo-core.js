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
 * @param {Array<string|number>} [p.deps] dependencias declaradas ya verificadas CLOSED
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
  children = null,
  childrenSource = null,
  childStates = null,
  hasLinkedPr = null,
} = {}) {
  const depRefs = (Array.isArray(deps) ? deps : []).map(depKey).filter(Boolean);
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
      log: `#${number}: es hija del split de #${parent} — se destraba, NUNCA se auto-cierra (CA-3 #6801). Dependencias cerradas: ${fmtRefs(depRefs)}`,
      telegram: `⚠️ #${number} no se auto-cerró: es hija de split (\`[Split de #${parent}]\`) y el trabajo sigue pendiente. Se le quitó \`blocked:dependencies\` y reingresa al pipeline.`,
    };
  }

  // 2. Sin label `split` → desbloqueo normal.
  if (!labels.includes(UMBRELLA_LABEL)) {
    return {
      ...base,
      action: 'unblock',
      reason: 'sin-label-split',
      log: `#${number}: destrabado (dependencias cerradas: ${fmtRefs(depRefs)})`,
    };
  }

  // 3. Candidato a paraguas: hace falta la lista REAL de sub-historias.
  const childIds = normalizeIssueIds(children).filter(n => depKey(n) !== number);
  if (!childIds.length) {
    return {
      ...base,
      action: 'skip',
      reason: 'hijas-indeterminables',
      log: `#${number}: lleva label \`split\` pero no se pudo determinar su lista de sub-historias — NO se cierra (fail-closed CA-2 #6801). Dependencias cerradas: ${fmtRefs(depRefs)}`,
      telegram: `⚠️ #${number} no se auto-cerró: lleva el label \`split\` pero no se pudo determinar qué sub-historias lo componen, así que el pipeline prefiere no cerrarlo. Sus dependencias declaradas (${fmtRefs(depRefs)}) sí están cerradas. Revisalo a mano: si es un paraguas real, agregale al body la línea **Sub-historias** con los números de las hijas.`,
    };
  }

  // 4. Todas las sub-historias tienen que estar CLOSED. Fail-closed: estado
  //    ausente o ilegible cuenta como abierta.
  const states = childStates && typeof childStates === 'object' ? childStates : {};
  const openChildren = childIds.filter(n => states[depKey(n)] !== CLOSED);
  if (openChildren.length) {
    return {
      ...base,
      action: 'skip',
      reason: 'hijas-abiertas',
      children: childIds,
      childrenSource,
      log: `#${number}: paraguas con sub-historias todavía abiertas (${fmtRefs(openChildren)}) — NO se cierra. Sus dependencias declaradas sí cerraron: ${fmtRefs(depRefs)}`,
      telegram: `⚠️ #${number} no se auto-cerró: sus dependencias cerraron, pero todavía tiene sub-historias abiertas (${fmtRefs(openChildren)}). Sigue esperando a que se completen.`,
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
    log: `#${number}: paraguas real con sub-historias cerradas (${fmtRefs(childIds)}, fuente=${childrenSource || 'desconocida'}) → auto-cerrando. Dependencias declaradas: ${fmtRefs(depRefs)}`,
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

// =============================================================================
// #6902 — Detección de CICLOS de dependencias
// =============================================================================
//
// Un ciclo en el grafo `blockedBy` es un deadlock permanente: ninguno de sus
// miembros puede liberarse porque cada uno espera a otro que a su vez lo espera.
// Y es INVISIBLE para el resto del sistema: cada issue del ciclo,
// individualmente, está en un estado perfectamente sano ("esperando una
// dependencia abierta"), así que ningún watchdog lo levanta. Los seis issues de
// la ola 9.4 que motivaron este módulo estuvieron congelados días sin que nadie
// lo notara.
//
// Este módulo NO rompe ciclos: cuál de las dependencias es la espuria es juicio
// humano (borrar la equivocada destruiría una dependencia real). Sólo detecta y
// arma el aviso. Romper automáticamente está explícitamente fuera de alcance.
//
// LÍMITE CONOCIDO: el grafo se construye con lo que el brazo ve en el ciclo, es
// decir los issues con `blocked:dependencies` vivo. Un ciclo cuyo eslabón no
// tenga el label no se cierra en este grafo y no se detecta. Es conservador por
// diseño: preferimos no reportar antes que inventar un ciclo con datos parciales.
// =============================================================================

/**
 * Detecta los ciclos elementales del grafo de bloqueos.
 *
 * @param {Record<string, Array<string|number>>} blockedBy — issue → deps.
 * @returns {Array<{cycle: string[], key: string}>}
 *          `cycle` es el camino cerrado (`['6173','6191','6173']`); `key` es su
 *          firma canónica — invariante ante rotaciones — para deduplicar avisos.
 */
function detectDependencyCycles(blockedBy) {
  if (!blockedBy || typeof blockedBy !== 'object') return [];

  // Normalizar a string y quedarse SÓLO con las aristas cuyo destino también es
  // nodo del grafo: una dep que no está bloqueada no puede cerrar un ciclo.
  const nodes = Object.keys(blockedBy).map(depKey);
  const nodeSet = new Set(nodes);
  const edges = new Map();
  for (const n of nodes) {
    const deps = Array.isArray(blockedBy[n]) ? blockedBy[n] : [];
    const out = [];
    for (const d of deps) {
      const k = depKey(d);
      if (k === n) continue;            // auto-referencia: ya la excluye el parser
      if (!nodeSet.has(k)) continue;    // hoja del grafo → no cierra ciclo
      if (!out.includes(k)) out.push(k);
    }
    edges.set(n, out);
  }

  const found = new Map();   // firma canónica → ciclo
  const state = new Map();   // nodo → 0 sin visitar | 1 en la pila | 2 cerrado
  const path = [];

  // DFS iterativo (sin recursión: el grafo lo arma GitHub y no queremos que su
  // tamaño pueda voltear el Pulpo por stack overflow).
  for (const root of nodes) {
    if (state.get(root)) continue;
    const stack = [{ node: root, i: 0 }];
    state.set(root, 1);
    path.push(root);

    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      const out = edges.get(frame.node) || [];
      if (frame.i >= out.length) {
        state.set(frame.node, 2);
        stack.pop();
        path.pop();
        continue;
      }
      const next = out[frame.i++];
      const st = state.get(next) || 0;
      if (st === 1) {
        // Back-edge: `next` sigue en la pila → hay ciclo desde ahí hasta acá.
        const start = path.indexOf(next);
        if (start !== -1) {
          const cycle = path.slice(start).concat([next]);
          const key = canonicalCycleKey(cycle);
          if (!found.has(key)) found.set(key, cycle);
        }
        continue;
      }
      if (st === 2) continue;
      state.set(next, 1);
      path.push(next);
      stack.push({ node: next, i: 0 });
    }
  }

  return Array.from(found.entries()).map(([key, cycle]) => ({ cycle, key }));
}

/**
 * Firma estable de un ciclo, invariante ante el nodo por el que se lo recorrió.
 * `6173→6191→6173` y `6191→6173→6191` comparten firma: son el mismo deadlock y
 * merecen UN aviso, no dos.
 *
 * @param {string[]} cycle — camino cerrado (primer y último nodo iguales).
 * @returns {string}
 */
function canonicalCycleKey(cycle) {
  const list = Array.isArray(cycle) ? cycle : [];
  const nodes = list.slice(0, -1).map(depKey);   // sin repetir el nodo de cierre
  if (nodes.length === 0) return '';
  let best = 0;
  for (let i = 1; i < nodes.length; i++) {
    if (compareIssueIds(nodes[i], nodes[best]) < 0) best = i;
  }
  return nodes.slice(best).concat(nodes.slice(0, best)).join('>');
}

/** Orden numérico cuando ambos son números; lexicográfico si no. */
function compareIssueIds(a, b) {
  const na = Number(a);
  const nb = Number(b);
  if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb;
  return String(a).localeCompare(String(b));
}

/** `#6173 → #6191 → #6173` — el ciclo completo, no "hay un ciclo". */
function formatCycle(cycle) {
  return (Array.isArray(cycle) ? cycle : []).map((n) => '#' + depKey(n)).join(' → ');
}

/**
 * Arma el aviso al operador de un ciclo detectado.
 *
 * Severidad de anomalía a propósito: si el aviso sonara igual que un "esperando
 * dependencia" normal, el problema de visibilidad que motivó #6902 seguiría
 * intacto. Y cierra diciendo CÓMO se corrige — saber que hay un deadlock sin
 * saber qué hacer no destraba nada.
 *
 * @param {{cycle: string[], key: string}} c
 * @returns {{key: string, log: string, telegram: string}}
 */
function buildCycleAlert(c) {
  const ruta = formatCycle(c && c.cycle);
  const involucrados = Array.isArray(c && c.cycle)
    ? Array.from(new Set(c.cycle.map(depKey)))
    : [];
  return {
    key: (c && c.key) ? c.key : ruta,
    log: `🔴 ciclo de dependencias detectado: ${ruta} — ninguno de estos issues puede liberarse solo`,
    telegram: [
      `🔴 Ciclo de dependencias — ${involucrados.length} issues congelados`,
      '',
      ruta,
      '',
      'Cada uno espera al siguiente, así que ninguno se destraba nunca. El pipeline NO lo rompe solo: cuál de las dependencias sobra es una decisión tuya.',
      '',
      'Para corregirlo, reposteá el marker del issue que tenga la dependencia espuria dejando sólo los bullets reales, con la prosa detrás de una línea `---`. Gana el comentario más reciente.',
    ].join('\n'),
  };
}

/**
 * #6902 — Guardrail madre-hija.
 *
 * Una hija de split (`[Split de #N] ...`) que declare a `#N` como dependencia
 * cierra un ciclo POR CONSTRUCCIÓN: la madre de un split depende legítimamente
 * de sus hijas. No hace falta ver el grafo entero para saberlo — alcanza con el
 * título y la lista de deps, y por eso se puede detectar en el momento mismo en
 * que se escribe el marker, en vez de días después.
 *
 * NO filtra la dependencia: avisa. Romper el ciclo sigue siendo humano.
 *
 * @param {{title?: string, issue?: string|number, deps?: Array<string|number>}} p
 * @returns {{isCycle: boolean, parent: number|null, reason: string, log: string|null, telegram: string|null}}
 */
function detectMotherChildCycle({ title, issue, deps } = {}) {
  const none = { isCycle: false, parent: null, reason: '', log: null, telegram: null };
  if (typeof title !== 'string' || title.length === 0) return { ...none, reason: 'sin-titulo' };

  const parent = parseSplitParent(title);
  if (parent === null) return { ...none, reason: 'no-es-hija-de-split' };

  const list = Array.isArray(deps) ? deps.map(depKey) : [];
  if (!list.includes(depKey(parent))) {
    return { ...none, parent, reason: 'no-declara-a-la-madre' };
  }

  const hija = issue == null ? '?' : depKey(issue);
  return {
    isCycle: true,
    parent,
    reason: 'hija-declara-a-su-madre',
    log: `🔴 ciclo madre-hija: #${hija} es hija del split de #${parent} y declara a #${parent} como dependencia — la madre depende de sus hijas, así que ninguna de las dos puede liberarse`,
    telegram: [
      `🔴 Dependencia imposible en el marker de #${hija}`,
      '',
      `#${parent} → #${hija} → #${parent}`,
      '',
      `#${hija} es una hija del split de #${parent} y declara a su madre como dependencia. La madre ya depende de sus hijas: el ciclo queda cerrado y ninguna de las dos se libera nunca.`,
      '',
      `El marker se escribió igual — el pipeline no borra dependencias por su cuenta. Si la mención a #${parent} era narrativa, reposteá el marker de #${hija} sin ese bullet.`,
    ].join('\n'),
  };
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
  // #6902 — ciclos de dependencias: detectar y reportar, nunca romper
  detectDependencyCycles,
  detectMotherChildCycle,
  buildCycleAlert,
  formatCycle,
  canonicalCycleKey,
  depKey,
  CLOSED,
  DEFAULT_MAX_AUTO_RELEASES,
  // internos para tests
  _internal: { verifiablePredicateOf, releaseBlocker },
};
