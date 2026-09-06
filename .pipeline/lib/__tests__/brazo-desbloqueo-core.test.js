// =============================================================================
// Tests brazo-desbloqueo-core.js — decisión pura de desbloqueo (EP5-H1, #3938)
//
// Cubre:
//   CA-4 · selectMarkersToRelease: libera markers cuando TODAS las deps están
//          CLOSED; mantiene bloqueados los que tienen alguna dep abierta o de
//          estado desconocido (fail-closed).
//   CA-4 · Caracterización: releaseDependencyBlockToPendiente reingresa los
//          work-files de bloqueado-dependencias/ a pendiente/ (integración FS
//          con tmp aislado, sin tocar la cola real).
//
// Fixtures con valores dummy, sin tokens reales (CA-8).
// =============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  selectMarkersToRelease,
  selectHumanBlocksToRelease,
  allDepsClosed,
  // #6901 - criterio unico de dependencia cumplida + redaccion para el operador
  isDependencySatisfied,
  SATISFIED_DEP_STATES,
  describeSatisfiedDeps,
  describePendingDeps,
} = require('../brazo-desbloqueo-core');

// -----------------------------------------------------------------------------
// allDepsClosed
// -----------------------------------------------------------------------------
test('allDepsClosed: todas CLOSED → true', () => {
  assert.equal(allDepsClosed([1234, 5678], { 1234: 'CLOSED', 5678: 'CLOSED' }), true);
});

test('allDepsClosed: alguna OPEN → false (fail-closed)', () => {
  assert.equal(allDepsClosed([1234, 5678], { 1234: 'CLOSED', 5678: 'OPEN' }), false);
});

test('allDepsClosed: dep de estado desconocido → false (fail-closed)', () => {
  assert.equal(allDepsClosed([1234, 9999], { 1234: 'CLOSED' }), false);
});

test('allDepsClosed: sin deps numéricas → false (no libera por este camino)', () => {
  assert.equal(allDepsClosed([], { 1234: 'CLOSED' }), false);
  assert.equal(allDepsClosed(null, {}), false);
});

test('allDepsClosed: normaliza claves string/number', () => {
  assert.equal(allDepsClosed(['1234'], { 1234: 'CLOSED' }), true);
  assert.equal(allDepsClosed([1234], { '1234': 'CLOSED' }), true);
});

// -----------------------------------------------------------------------------
// CA-4 · selectMarkersToRelease
// -----------------------------------------------------------------------------
test('CA-4: libera el marker con todas las deps CLOSED, mantiene el resto', () => {
  const markers = [
    { issue: 100, deps: [10, 11] },   // todas closed → release
    { issue: 200, deps: [20, 21] },   // 21 open → blocked
    { issue: 300, deps: [30] },       // unknown → blocked
  ];
  const issueStates = {
    10: 'CLOSED', 11: 'CLOSED',
    20: 'CLOSED', 21: 'OPEN',
    // 30 ausente (unknown)
  };
  const { toRelease, blocked } = selectMarkersToRelease({ markers, issueStates });

  assert.deepEqual(toRelease.map((m) => m.issue), [100]);
  assert.deepEqual(blocked.map((m) => m.issue).sort(), [200, 300]);
  // El blocked reporta las deps que siguen abiertas/desconocidas.
  const b200 = blocked.find((m) => m.issue === 200);
  assert.deepEqual(b200.openDeps, ['21']);
  const b300 = blocked.find((m) => m.issue === 300);
  assert.deepEqual(b300.openDeps, ['30']);
});

test('CA-4: ningún marker se libera si todos tienen deps abiertas', () => {
  const markers = [{ issue: 1, deps: [2] }, { issue: 3, deps: [4] }];
  const { toRelease } = selectMarkersToRelease({ markers, issueStates: { 2: 'OPEN', 4: 'OPEN' } });
  assert.equal(toRelease.length, 0);
});

test('CA-4: defensivo ante input vacío/no-array', () => {
  assert.deepEqual(selectMarkersToRelease({}), { toRelease: [], blocked: [] });
  assert.deepEqual(selectMarkersToRelease({ markers: null, issueStates: null }), { toRelease: [], blocked: [] });
});

test('selectMarkersToRelease ignora markers sin issue', () => {
  const { toRelease, blocked } = selectMarkersToRelease({
    markers: [{ deps: [1] }, null, { issue: 5, deps: [6] }],
    issueStates: { 6: 'CLOSED' },
  });
  assert.deepEqual(toRelease.map((m) => m.issue), [5]);
  assert.equal(blocked.length, 0);
});

// -----------------------------------------------------------------------------
// #4361 · Escenarios Gherkin literales (re-promoción automática al cerrar dep)
// -----------------------------------------------------------------------------
test('#4361 Gherkin-1: dependencia única cierra → dependiente se libera', () => {
  // Dado que el issue #4300 declara depends_on [4255]
  // Y el issue #4255 está abierto → luego cierra
  // Cuando el issue #4255 se cierra
  // Entonces el issue #4300 se re-promueve a la cola de trabajo automáticamente
  const markers = [{ issue: 4300, deps: [4255] }];
  const issueStates = { 4255: 'CLOSED' };
  const { toRelease, blocked } = selectMarkersToRelease({ markers, issueStates });

  assert.deepEqual(toRelease.map((m) => m.issue), [4300]);
  assert.equal(blocked.length, 0);
});

test('#4361 Gherkin-2: aún quedan dependencias abiertas → permanece bloqueado', () => {
  // Dado que un issue declara depends_on [4255, 4256]
  // Y el issue #4256 sigue abierto
  // Cuando el issue #4255 se cierra
  // Entonces el issue dependiente permanece bloqueado
  const markers = [{ issue: 4300, deps: [4255, 4256] }];
  const issueStates = { 4255: 'CLOSED', 4256: 'OPEN' };
  const { toRelease, blocked } = selectMarkersToRelease({ markers, issueStates });

  assert.equal(toRelease.length, 0);
  assert.deepEqual(blocked.map((m) => m.issue), [4300]);
  assert.deepEqual(blocked[0].openDeps, ['4256']);
});

// -----------------------------------------------------------------------------
// CA-4 · Caracterización: reingreso real a pendiente/ (rebote-classifier FS)
// -----------------------------------------------------------------------------
test('CA-4: releaseDependencyBlockToPendiente reingresa work-files a pendiente/', () => {
  // Aislar PIPELINE en tmp (mismo patrón que rebote-classifier.test.js).
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'v3-desbloqueo-core-'));
  fs.mkdirSync(path.join(TMP, '.claude'), { recursive: true });
  process.env.CLAUDE_PROJECT_DIR = TMP;
  process.env.PIPELINE_REPO_ROOT = TMP;
  // Requerir DESPUÉS de fijar env (trace.REPO_ROOT se resuelve al cargar).
  delete require.cache[require.resolve('../traceability')];
  delete require.cache[require.resolve('../rebote-classifier')];
  const reboteClassifier = require('../rebote-classifier');

  const pipeline = 'desarrollo';
  const phase = 'dev';
  const issue = 4242;
  const blockedDir = path.join(TMP, '.pipeline', pipeline, phase, reboteClassifier.DEPS_BLOCK_SUBDIR);
  const pendienteDir = path.join(TMP, '.pipeline', pipeline, phase, 'pendiente');
  fs.mkdirSync(blockedDir, { recursive: true });

  // Work-file dummy bloqueado por dependencias (sin secrets, CA-8).
  const wf = path.join(blockedDir, `${issue}.pipeline-dev`);
  fs.writeFileSync(wf, 'issue: 4242\nfase: dev\npipeline: desarrollo\n', 'utf8');

  const res = reboteClassifier.releaseDependencyBlockToPendiente({ issue });

  assert.ok(res && res.moved >= 1, 'debe mover al menos un archivo');
  // El work-file ahora está en pendiente/, ya no en bloqueado-dependencias/.
  assert.ok(fs.existsSync(path.join(pendienteDir, `${issue}.pipeline-dev`)), 'reingresado a pendiente/');
  assert.ok(!fs.existsSync(wf), 'ya no está en bloqueado-dependencias/');

  // Limpieza de cache para no contaminar otros tests del mismo proceso.
  delete require.cache[require.resolve('../rebote-classifier')];
  delete require.cache[require.resolve('../traceability')];
});

// =============================================================================
// #4748 · selectHumanBlocksToRelease — re-evaluación de needs-human de
// precondición de dependencia. Cubre 100% de las ramas del selector fail-closed.
// =============================================================================

test('selectHumanBlocksToRelease (a): dependency con todas las deps CLOSED → toRelease', () => {
  const markers = [{ issue: 4745, precondition: { type: 'dependency', depends_on: [4744] } }];
  const { toRelease, blocked } = selectHumanBlocksToRelease({ markers, issueStates: { 4744: 'CLOSED' } });
  assert.equal(toRelease.length, 1);
  assert.equal(toRelease[0].issue, 4745);
  assert.equal(blocked.length, 0);
});

test('selectHumanBlocksToRelease (b): alguna dep OPEN → blocked, no libera (SEC-3)', () => {
  const markers = [{ issue: 10, precondition: { type: 'dependency', depends_on: [1, 2] } }];
  const { toRelease, blocked } = selectHumanBlocksToRelease({ markers, issueStates: { 1: 'CLOSED', 2: 'OPEN' } });
  assert.equal(toRelease.length, 0);
  assert.equal(blocked.length, 1);
  assert.deepEqual(blocked[0].openDeps, ['2']);
});

test('selectHumanBlocksToRelease (b2): dep con estado desconocido → blocked, no libera', () => {
  const markers = [{ issue: 11, precondition: { type: 'dependency', depends_on: [7] } }];
  const { toRelease, blocked } = selectHumanBlocksToRelease({ markers, issueStates: {} });
  assert.equal(toRelease.length, 0);
  assert.equal(blocked.length, 1);
  assert.deepEqual(blocked[0].openDeps, ['7']);
});

test('selectHumanBlocksToRelease (c): human_judgment ignorado aunque deps CLOSED (CA-3/SEC-4)', () => {
  const markers = [{ issue: 20, precondition: { type: 'human_judgment' }, depends_on: [1] }];
  const { toRelease, blocked } = selectHumanBlocksToRelease({ markers, issueStates: { 1: 'CLOSED' } });
  assert.equal(toRelease.length, 0);
  assert.equal(blocked.length, 0, 'juicio humano no entra ni a toRelease ni a blocked');
});

test('selectHumanBlocksToRelease (d): marker sin precondition → ignorado (SEC-4)', () => {
  const { toRelease, blocked } = selectHumanBlocksToRelease({ markers: [{ issue: 30 }], issueStates: { 1: 'CLOSED' } });
  assert.equal(toRelease.length, 0);
  assert.equal(blocked.length, 0);
});

test('selectHumanBlocksToRelease (e): depends_on vacío → ignorado', () => {
  const markers = [{ issue: 40, precondition: { type: 'dependency', depends_on: [] } }];
  const { toRelease, blocked } = selectHumanBlocksToRelease({ markers, issueStates: {} });
  assert.equal(toRelease.length, 0);
  assert.equal(blocked.length, 0);
});

test('selectHumanBlocksToRelease: type desconocido → ignorado', () => {
  const markers = [{ issue: 50, precondition: { type: 'otro', depends_on: [1] } }];
  const { toRelease, blocked } = selectHumanBlocksToRelease({ markers, issueStates: { 1: 'CLOSED' } });
  assert.equal(toRelease.length, 0);
  assert.equal(blocked.length, 0);
});

test('selectHumanBlocksToRelease: mezcla — libera sólo los que corresponden', () => {
  const markers = [
    { issue: 1, precondition: { type: 'dependency', depends_on: [100] } },      // CLOSED → release
    { issue: 2, precondition: { type: 'dependency', depends_on: [200, 201] } }, // 201 OPEN → blocked
    { issue: 3, precondition: { type: 'human_judgment' } },                     // ignorado
    { issue: 4 },                                                               // ignorado
  ];
  const { toRelease, blocked } = selectHumanBlocksToRelease({
    markers, issueStates: { 100: 'CLOSED', 200: 'CLOSED', 201: 'OPEN' },
  });
  assert.deepEqual(toRelease.map(m => m.issue), [1]);
  assert.deepEqual(blocked.map(m => m.issue), [2]);
});

test('selectHumanBlocksToRelease: args vacíos → estructura vacía (defensivo)', () => {
  assert.deepEqual(selectHumanBlocksToRelease(), { toRelease: [], blocked: [] });
  assert.deepEqual(selectHumanBlocksToRelease({}), { toRelease: [], blocked: [] });
  assert.deepEqual(selectHumanBlocksToRelease({ markers: null, issueStates: null }), { toRelease: [], blocked: [] });
});

test('#4745: dep OPEN → permanece; dep pasa a CLOSED → se libera (CA-4)', () => {
  const marker = { issue: 4745, precondition: { type: 'dependency', depends_on: [4744] } };
  let out = selectHumanBlocksToRelease({ markers: [marker], issueStates: { 4744: 'OPEN' } });
  assert.equal(out.toRelease.length, 0);
  assert.equal(out.blocked.length, 1);
  out = selectHumanBlocksToRelease({ markers: [marker], issueStates: { 4744: 'CLOSED' } });
  assert.equal(out.toRelease.length, 1);
  assert.equal(out.toRelease[0].issue, 4745);
});

// =============================================================================
// #6611 — selectVerifiableHumanBlocksToRelease
//
// Los 3 escenarios Gherkin del issue + las ramas de rechazo del fail-closed.
// TODA la suite es sin red: las observaciones se inyectan.
// =============================================================================

const { selectVerifiableHumanBlocksToRelease } = require('../brazo-desbloqueo-core');

const PR_6611 = 6593;
const ISSUE_6611 = 6145;
const HEAD_6611 = 'agent/6145-turno-huerfano';

function markerVerificable(over = {}) {
  return {
    issue: ISSUE_6611,
    precondition: {
      type: 'verifiable',
      predicate: {
        kind: 'pr_merge_blocked',
        pr: PR_6611,
        head_ref: HEAD_6611,
        observed: { httpStatus: 405, mergeStateStatus: 'BLOCKED', gate: 'branch-protection-other' },
        ...(over.predicate || {}),
      },
    },
  };
}

// Observación "todo verde": las 5 condiciones con valor dentro de su enum.
function obsVerde(over = {}) {
  return {
    [String(PR_6611)]: {
      state: 'OPEN',
      mergeable: 'MERGEABLE',
      mergeStateStatus: 'CLEAN',
      statusCheckRollup: [{ conclusion: 'SUCCESS' }, { conclusion: 'SKIPPED' }],
      headRefName: HEAD_6611,
      ...over,
    },
  };
}

test('#6611 Gherkin 1 - la causa desaparecio: el marker entra a toRelease', () => {
  const out = selectVerifiableHumanBlocksToRelease({
    markers: [markerVerificable()], observations: obsVerde(),
  });
  assert.equal(out.toRelease.length, 1);
  assert.equal(out.blocked.length, 0);
  assert.equal(out.toRelease[0].issue, ISSUE_6611);
  assert.equal(out.toRelease[0].predicate.pr, PR_6611);
});

test('#6611 Gherkin 2 - lectura fallida del PR: sigue bloqueado, no libera', () => {
  // Observación ausente por completo (gh falló, el PR no entró al mapa).
  let out = selectVerifiableHumanBlocksToRelease({
    markers: [markerVerificable()], observations: {},
  });
  assert.equal(out.toRelease.length, 0);
  assert.equal(out.blocked[0].reason, 'observacion-ilegible');

  // Observación presente pero no-objeto.
  out = selectVerifiableHumanBlocksToRelease({
    markers: [markerVerificable()], observations: { [String(PR_6611)]: 'boom' },
  });
  assert.equal(out.toRelease.length, 0);
  assert.equal(out.blocked[0].reason, 'observacion-ilegible');
});

test('#6611 Gherkin 3 - juicio humano genuino: ni toRelease ni blocked (intocable)', () => {
  const humano = { issue: 999, precondition: { type: 'human_judgment' } };
  const sinPrecondicion = { issue: 998 };
  const dependencia = { issue: 997, precondition: { type: 'dependency', depends_on: [1] } };
  const out = selectVerifiableHumanBlocksToRelease({
    markers: [humano, sinPrecondicion, dependencia], observations: obsVerde(),
  });
  assert.equal(out.toRelease.length, 0, 'no se libera');
  assert.equal(out.blocked.length, 0, 'ni siquiera se lista como candidato retenido');
});

test('#6611 - rollup vacio con mergeable y mergeStateStatus en enum libera; rollup null no libera', () => {
  // `[]` = PR sin checks. Las 4 condiciones previas ya llegaron con valor del
  // enum y CLEAN es el veredicto de GitHub sobre la protección de rama.
  let out = selectVerifiableHumanBlocksToRelease({
    markers: [markerVerificable()], observations: obsVerde({ statusCheckRollup: [] }),
  });
  assert.equal(out.toRelease.length, 1, 'rollup [] libera');

  // `null` = no se pudo leer. null != [].
  out = selectVerifiableHumanBlocksToRelease({
    markers: [markerVerificable()], observations: obsVerde({ statusCheckRollup: null }),
  });
  assert.equal(out.toRelease.length, 0, 'rollup null NO libera');
  assert.equal(out.blocked[0].reason, 'rollup-ilegible');

  // Ausente y no-array tampoco.
  for (const bad of [undefined, 'x', 42, {}]) {
    out = selectVerifiableHumanBlocksToRelease({
      markers: [markerVerificable()], observations: obsVerde({ statusCheckRollup: bad }),
    });
    assert.equal(out.toRelease.length, 0, 'rollup ' + JSON.stringify(bad) + ' NO libera');
  }
});

test('#6611 - estados fuera del enum no liberan (nada es verde por descarte)', () => {
  const casos = [
    [{ state: 'CLOSED' }, 'pr-no-abierto'],
    [{ state: 'MERGED' }, 'pr-no-abierto'],
    [{ state: null }, 'pr-no-abierto'],
    [{ mergeable: 'UNKNOWN' }, 'pr-no-mergeable'],
    [{ mergeable: 'CONFLICTING' }, 'pr-no-mergeable'],
    [{ mergeable: null }, 'pr-no-mergeable'],
    [{ mergeStateStatus: 'BLOCKED' }, 'merge-state-no-clean'],
    [{ mergeStateStatus: 'UNSTABLE' }, 'merge-state-no-clean'],
    [{ mergeStateStatus: null }, 'merge-state-no-clean'],
  ];
  for (const [over, esperado] of casos) {
    const out = selectVerifiableHumanBlocksToRelease({
      markers: [markerVerificable()], observations: obsVerde(over),
    });
    assert.equal(out.toRelease.length, 0, JSON.stringify(over) + ' no debe liberar');
    assert.equal(out.blocked[0].reason, esperado);
  }
});

test('#6611 - un check no-verde (failing/pending/unusable) no libera', () => {
  const nodos = [
    { conclusion: 'FAILURE' },
    { status: 'IN_PROGRESS' },
    // COMPLETED sin decir cómo: no es verde por descarte.
    { status: 'COMPLETED', conclusion: null },
    { conclusion: 'INVENTADO' },
    null,
  ];
  for (const nodo of nodos) {
    const out = selectVerifiableHumanBlocksToRelease({
      markers: [markerVerificable()],
      observations: obsVerde({ statusCheckRollup: [{ conclusion: 'SUCCESS' }, nodo] }),
    });
    assert.equal(out.toRelease.length, 0, JSON.stringify(nodo) + ' no debe liberar');
    assert.equal(out.blocked[0].reason, 'checks-no-verdes');
  }
});

test('#6611 - binding head_ref: manda el observado, no el declarado', () => {
  // El PR existe y está verde, pero su rama NO es la del predicado.
  let out = selectVerifiableHumanBlocksToRelease({
    markers: [markerVerificable()],
    observations: obsVerde({ headRefName: 'agent/9999-otro-issue' }),
  });
  assert.equal(out.toRelease.length, 0);
  assert.equal(out.blocked[0].reason, 'head-ref-no-coincide-con-el-declarado');

  // Un predicado que declara una rama que SI coincide con la observada, pero
  // que no pertenece al issue: apuntar a cualquier PR verde del repo no alcanza.
  out = selectVerifiableHumanBlocksToRelease({
    markers: [markerVerificable({ predicate: { head_ref: 'main' } })],
    observations: obsVerde({ headRefName: 'main' }),
  });
  assert.equal(out.toRelease.length, 0);
  assert.equal(out.blocked[0].reason, 'head-ref-no-pertenece-al-issue');
});

test('#6611 CA-8 - techo de auto-destrabes alcanzado: deja de liberar', () => {
  const key = ISSUE_6611 + '::pr_merge_blocked::' + PR_6611;
  // Por debajo del techo: libera.
  for (const n of [0, 1, 2]) {
    const out = selectVerifiableHumanBlocksToRelease({
      markers: [markerVerificable()], observations: obsVerde(), counters: { [key]: n },
    });
    assert.equal(out.toRelease.length, 1, 'con ' + n + ' destrabes previos todavia libera');
  }
  // En el techo (3) y por encima: no libera.
  for (const n of [3, 4, Infinity]) {
    const out = selectVerifiableHumanBlocksToRelease({
      markers: [markerVerificable()], observations: obsVerde(), counters: { [key]: n },
    });
    assert.equal(out.toRelease.length, 0, 'con ' + n + ' destrabes previos NO libera');
    assert.equal(out.blocked[0].reason, 'techo-de-auto-destrabes-alcanzado');
  }
});

test('#6611 - contador ilegible (Infinity, fail-closed de count()) no libera', () => {
  const key = ISSUE_6611 + '::pr_merge_blocked::' + PR_6611;
  const out = selectVerifiableHumanBlocksToRelease({
    markers: [markerVerificable()], observations: obsVerde(), counters: { [key]: Infinity },
  });
  assert.equal(out.toRelease.length, 0);
});

test('#6611 - predicado deforme degrada a intocable (no entra a ninguna lista)', () => {
  const deformes = [
    { kind: 'otro_kind', pr: PR_6611, head_ref: HEAD_6611 },
    { kind: 'pr_merge_blocked', pr: '6593', head_ref: HEAD_6611 },   // string, no entero
    { kind: 'pr_merge_blocked', pr: 12.5, head_ref: HEAD_6611 },
    { kind: 'pr_merge_blocked', pr: -1, head_ref: HEAD_6611 },
    { kind: 'pr_merge_blocked', pr: 0, head_ref: HEAD_6611 },
    { kind: 'pr_merge_blocked', pr: PR_6611, head_ref: '' },
    { kind: 'pr_merge_blocked', pr: PR_6611 },                        // sin head_ref
  ];
  for (const predicate of deformes) {
    const out = selectVerifiableHumanBlocksToRelease({
      markers: [{ issue: ISSUE_6611, precondition: { type: 'verifiable', predicate } }],
      observations: obsVerde(),
    });
    assert.equal(out.toRelease.length, 0, JSON.stringify(predicate) + ' no libera');
    assert.equal(out.blocked.length, 0, JSON.stringify(predicate) + ' tampoco se lista');
  }
  // `predicate` ausente / no-objeto.
  for (const predicate of [null, undefined, 'x', 42, []]) {
    const out = selectVerifiableHumanBlocksToRelease({
      markers: [{ issue: ISSUE_6611, precondition: { type: 'verifiable', predicate } }],
      observations: obsVerde(),
    });
    assert.equal(out.toRelease.length + out.blocked.length, 0);
  }
});

test('#6611 - un observed mentiroso no cambia la decision (solo narra)', () => {
  // El productor del freeze declara que YA estaba CLEAN al congelar. Si el
  // selector comparara "antes vs ahora", esto forzaria la liberacion.
  const mentiroso = markerVerificable({
    predicate: { observed: { httpStatus: 200, mergeStateStatus: 'CLEAN', gate: 'ninguno' } },
  });
  // Estado real ahora: sigue bloqueado.
  const out = selectVerifiableHumanBlocksToRelease({
    markers: [mentiroso], observations: obsVerde({ mergeStateStatus: 'BLOCKED' }),
  });
  assert.equal(out.toRelease.length, 0, 'el observed declarado no puede forzar el destrabe');
  assert.equal(out.blocked[0].reason, 'merge-state-no-clean');
});

test('#6611 - entradas basura no rompen el selector', () => {
  const out = selectVerifiableHumanBlocksToRelease({
    markers: [null, undefined, {}, { issue: null }, 'x', 42],
    observations: obsVerde(),
  });
  assert.equal(out.toRelease.length, 0);
  assert.equal(out.blocked.length, 0);
  // Sin argumentos tampoco lanza.
  const vacio = selectVerifiableHumanBlocksToRelease();
  assert.deepEqual(vacio, { toRelease: [], blocked: [] });
});

// =============================================================================
// #6801 — decideSplitUmbrellaClose: el auto-cierre de paraguas nunca puede
// tocar una hija de split, ni usar las dependencias como si fueran hijas.
// =============================================================================

const { decideSplitUmbrellaClose } = require('../brazo-desbloqueo-core');

const lbl = (...names) => names.map((name) => ({ name }));

test('#6801 CA-3 - hija de split con deps cerradas: destraba pero NO cierra', () => {
  // El caso exacto del bug: #5797 es `[Split de #5791]`, lleva el label `split`
  // (como toda hija) y su unica dependencia #5339 esta CLOSED.
  const d = decideSplitUmbrellaClose({
    issue: { number: 5797, title: '[Split de #5791] Cache versionada y single-flight', labels: lbl('split', 'blocked:dependencies') },
    deps: ['5339'],
  });
  assert.equal(d.action, 'unblock', 'una hija JAMAS se auto-cierra por este camino');
  assert.equal(d.reason, 'hija-de-split');
  assert.equal(d.parent, 5791);
  assert.equal(d.comment, null, 'no se emite comentario de cierre');
  assert.match(d.telegram, /no se auto-cerró/);
  assert.match(d.telegram, /reingresa al pipeline/);
});

test('#6801 CA-3 - el label `split` solo NUNCA alcanza para cerrar una hija', () => {
  // Variante sin `blocked:dependencies`: sigue siendo hija por el titulo.
  const d = decideSplitUmbrellaClose({
    issue: { number: 5799, title: '[Split de #5791] Integrar snapshots en buildChildEnv', labels: lbl('split') },
    deps: ['5339', '5798'],
  });
  assert.equal(d.action, 'unblock');
  assert.equal(d.reason, 'hija-de-split');
});

test('#6801 CA-1 - paraguas real con sub-historias cerradas: cierra', () => {
  const d = decideSplitUmbrellaClose({
    issue: { number: 5440, title: 'Cadena de credenciales del pipeline', labels: lbl('split') },
    deps: ['5339'],
    children: [5791, 5798],
    childrenSource: 'registro',
    childStates: { 5791: 'CLOSED', 5798: 'CLOSED' },
    hasLinkedPr: true,
  });
  assert.equal(d.action, 'close');
  assert.equal(d.reason, 'paraguas-verificado');
  assert.deepEqual(d.children, [5791, 5798]);
});

test('#6801 CA-2 - lista de hijas indeterminable: NO cierra (fail-closed) y lo dice', () => {
  const d = decideSplitUmbrellaClose({
    issue: { number: 4000, title: 'Paraguas viejo sin registro', labels: lbl('split') },
    deps: ['3999'],
    children: null,
  });
  assert.equal(d.action, 'skip', 'no sé qué hijas tiene ⇒ no cierro');
  assert.equal(d.reason, 'hijas-indeterminables');
  assert.equal(d.comment, null);
  assert.ok(d.telegram && d.telegram.length > 0, 'el fail-closed no puede ser silencioso');
  assert.ok(d.log.includes('fail-closed'));
});

test('#6801 CA-2 - hijas presentes pero alguna abierta o de estado ilegible: NO cierra', () => {
  const abierta = decideSplitUmbrellaClose({
    issue: { number: 4000, title: 'Paraguas', labels: lbl('split') },
    deps: ['3999'], children: [4001, 4002], childrenSource: 'titulos',
    childStates: { 4001: 'CLOSED', 4002: 'OPEN' },
  });
  assert.equal(abierta.action, 'skip');
  assert.equal(abierta.reason, 'hijas-abiertas');

  const ilegible = decideSplitUmbrellaClose({
    issue: { number: 4000, title: 'Paraguas', labels: lbl('split') },
    deps: ['3999'], children: [4001, 4002], childrenSource: 'titulos',
    childStates: { 4001: 'CLOSED' }, // 4002 sin estado
  });
  assert.equal(ilegible.action, 'skip', 'estado desconocido cuenta como abierta');
});

test('#6801 CA-2/CA-4 - las dependencias nunca se usan como hijas', () => {
  // Las deps estan todas cerradas, pero NO son la lista de hijas: sin hijas
  // determinables no se cierra, y ningun mensaje llama "hijas" a las deps.
  const d = decideSplitUmbrellaClose({
    issue: { number: 5798, title: 'Paraguas sin registro', labels: lbl('split') },
    deps: ['5339', '5797'],
  });
  assert.equal(d.action, 'skip');
  assert.deepEqual(d.children, [], 'las deps no se filtran a la lista de hijas');
  assert.ok(!/hijas fueron cerradas/.test(d.telegram || ''));
  assert.match(d.telegram, /dependencias declaradas/i);
});

test('#6801 CA-4 - el comentario nombra la lista evaluada y separa deps de hijas', () => {
  const d = decideSplitUmbrellaClose({
    issue: { number: 5440, title: 'Paraguas', labels: lbl('split') },
    deps: ['5339'],
    children: [5791, 5798],
    childrenSource: 'registro',
    childStates: { 5791: 'CLOSED', 5798: 'CLOSED' },
    hasLinkedPr: true,
  });
  assert.match(d.comment, /Sub-historias evaluadas.*#5791, #5798/);
  assert.match(d.comment, /Dependencias declaradas de este issue.*#5339/);
  assert.match(d.comment, /registro del split/, 'dice de dónde salió la lista');
  // Regresion directa del texto que mentia: "todas sus historias hijas fueron
  // cerradas (#5339)" donde #5339 era una DEPENDENCIA.
  assert.ok(!/historias hijas fueron cerradas/.test(d.comment));
  const lineaDeps = d.comment.split('\n').find((l) => l.includes('#5339'));
  assert.match(lineaDeps, /no son sus hijas/, 'la línea de deps aclara que no son hijas');
});

test('#6801 CA-5 - paraguas sin PR asociado: cierra pero avisa para revisión', () => {
  const d = decideSplitUmbrellaClose({
    issue: { number: 5440, title: 'Paraguas', labels: lbl('split') },
    deps: ['5339'], children: [5791], childrenSource: 'registro',
    childStates: { 5791: 'CLOSED' }, hasLinkedPr: false,
  });
  assert.equal(d.action, 'close');
  assert.equal(d.warnNoPr, true);
  assert.match(d.telegram, /no tiene ningún PR propio asociado/);
});

test('#6801 - issue sin label `split`: destrabe normal', () => {
  const d = decideSplitUmbrellaClose({
    issue: { number: 1234, title: 'Feature cualquiera', labels: lbl('Ready', 'blocked:dependencies') },
    deps: ['1200'],
  });
  assert.equal(d.action, 'unblock');
  assert.equal(d.reason, 'sin-label-split');
  assert.equal(d.telegram, null, 'el destrabe normal no genera aviso extra');
});

test('#6801 - entrada malformada: fail-closed, no toca nada', () => {
  for (const issue of [null, undefined, 42, {}, { number: 1 }]) {
    const d = decideSplitUmbrellaClose({ issue, deps: ['1'] });
    assert.equal(d.action, 'skip', `entrada ${JSON.stringify(issue)} debe ser skip`);
    assert.equal(d.reason, 'entrada-invalida');
  }
  assert.equal(decideSplitUmbrellaClose().action, 'skip');
});

test('#6801 - un titulo `[Split de #N]` que apunta a si mismo no lo hace hija', () => {
  const d = decideSplitUmbrellaClose({
    issue: { number: 777, title: '[Split de #777] basura', labels: lbl('split') },
    deps: ['1'], children: [778], childrenSource: 'titulos', childStates: { 778: 'CLOSED' },
    hasLinkedPr: true,
  });
  assert.equal(d.action, 'close', 'auto-referencia no puede bloquear el cierre de un paraguas real');
});

// =============================================================================
// #6801 CA-7 — classifySpuriousUmbrellaClose: auditoría del radio de impacto.
// =============================================================================

const { classifySpuriousUmbrellaClose } = require('../brazo-desbloqueo-core');

const comentarioDelBrazo = {
  body: '## ✅ Paraguas resuelto\n\nEste issue era un paraguas...\n\n_Cerrado automáticamente por el brazo de desbloqueo del pipeline._',
};

test('#6801 CA-7 - hija de split cerrada por el brazo y sin PR: se reabre', () => {
  const v = classifySpuriousUmbrellaClose({
    number: 5798, title: '[Split de #5791] API de snapshot aislado', state: 'CLOSED',
    closedByPullRequestsReferences: [], comments: [comentarioDelBrazo],
  });
  assert.equal(v.reopen, true);
  assert.equal(v.reason, 'hija-cerrada-por-el-brazo-sin-pr');
  assert.equal(v.parent, 5791);
});

test('#6801 CA-7 - hija con PR asociado: NO se reabre aunque tenga el comentario espurio', () => {
  // Caso real #5797: volvió a cerrar con PR #6806. Reabrirla destruiría trabajo.
  const v = classifySpuriousUmbrellaClose({
    number: 5797, title: '[Split de #5791] Caché versionada', state: 'CLOSED',
    closedByPullRequestsReferences: [{ number: 6806 }], comments: [comentarioDelBrazo],
  });
  assert.equal(v.reopen, false);
  assert.equal(v.reason, 'tiene-pr-asociado');
});

test('#6801 CA-7 - paraguas real: NO se reabre (no es hija)', () => {
  const v = classifySpuriousUmbrellaClose({
    number: 5440, title: 'Cadena de credenciales del pipeline', state: 'CLOSED',
    closedByPullRequestsReferences: [], comments: [comentarioDelBrazo],
  });
  assert.equal(v.reopen, false);
  assert.equal(v.reason, 'no-es-hija-de-split');
});

test('#6801 CA-7 - cerrada por otra vía (sin comentario del brazo): NO se reabre', () => {
  const v = classifySpuriousUmbrellaClose({
    number: 5798, title: '[Split de #5791] API de snapshot', state: 'CLOSED',
    closedByPullRequestsReferences: [], comments: [{ body: 'Cerrado a mano, ya no aplica.' }],
  });
  assert.equal(v.reopen, false);
  assert.equal(v.reason, 'no-la-cerro-el-brazo');
});

test('#6801 CA-7 - idempotencia: una ya reabierta no se vuelve a tocar', () => {
  const v = classifySpuriousUmbrellaClose({
    number: 5798, title: '[Split de #5791] API de snapshot', state: 'OPEN',
    closedByPullRequestsReferences: [], comments: [comentarioDelBrazo],
  });
  assert.equal(v.reopen, false);
  assert.equal(v.reason, 'no-esta-cerrado');
});

test('#6801 CA-7 - entradas malformadas no rompen la auditoría', () => {
  for (const issue of [null, undefined, 42, {}, { title: 5 }]) {
    const v = classifySpuriousUmbrellaClose(issue);
    assert.equal(v.reopen, false);
  }
});

// =============================================================================
// #6801 (rebote rev-1) — el archivo de dedupe de avisos es estado runtime y
// NUNCA se versiona.
//
// `UMBRELLA_SKIP_NOTICE_FILE` se crea en el `.pipeline/` del checkout donde
// corre el brazo. Si no está gitignoreado queda como `??` permanente en el repo
// principal y en cada worktree, y el `reset --hard` del respawn no lo limpia
// (no toca untracked). Este test fija la convención para que no se pierda en un
// futuro refactor del bloque de estado runtime del `.gitignore`.
// =============================================================================

const { execFileSync } = require('child_process');
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

function estaIgnorado(relPath) {
  try {
    execFileSync('git', ['check-ignore', '-q', '--', relPath], { cwd: REPO_ROOT, stdio: 'ignore' });
    return true;
  } catch {
    return false; // exit 1 = no ignorado
  }
}

test('#6801 el estado de dedupe de avisos de paraguas esta gitignoreado', () => {
  assert.equal(
    estaIgnorado('.pipeline/desbloqueo-umbrella-avisos.json'),
    true,
    '.pipeline/desbloqueo-umbrella-avisos.json debe estar en el bloque de estado runtime del .gitignore'
  );
});

test('#6801 el temporal de la escritura atomica tambien esta gitignoreado', () => {
  assert.equal(
    estaIgnorado('.pipeline/desbloqueo-umbrella-avisos.json.12345.tmp'),
    true,
    'el patron .pipeline/desbloqueo-umbrella-avisos.json.*.tmp debe estar ignorado'
  );
});

test('#6801 el archivo de dedupe nunca esta trackeado en el indice de git', () => {
  const tracked = execFileSync(
    'git', ['ls-files', '--', '.pipeline/desbloqueo-umbrella-avisos.json'],
    { cwd: REPO_ROOT, encoding: 'utf8' }
  ).trim();
  assert.equal(tracked, '', `.gitignore no desindexa lo ya trackeado; encontrado: ${tracked}`);
});

// =============================================================================
// #6901 — MERGED cuenta como dependencia cumplida
// -----------------------------------------------------------------------------
// GitHub reporta `MERGED` para un PR mergeado. Comparar contra el literal
// `CLOSED` lo contaba como dep abierta y, con la semántica fail-closed, el
// issue que lo declaraba quedaba congelado PARA SIEMPRE (el estado del PR ya no
// va a cambiar nunca más). La matriz de abajo es el CA-6 completo: cerrada,
// mergeada, mezcla de ambas, abierta, ausente y no reconocida.
// =============================================================================

test('#6901 isDependencySatisfied: CLOSED cuenta como cumplida', () => {
  assert.equal(isDependencySatisfied('CLOSED'), true);
});

test('#6901 isDependencySatisfied: MERGED cuenta como cumplida (PR mergeado)', () => {
  assert.equal(isDependencySatisfied('MERGED'), true);
});

test('#6901 isDependencySatisfied: OPEN NO cuenta como cumplida', () => {
  assert.equal(isDependencySatisfied('OPEN'), false);
});

test('#6901 isDependencySatisfied: fail-closed ante estado ausente, vacio o no-string', () => {
  for (const v of [undefined, null, '', '   ', 0, 1, {}, [], true, NaN]) {
    assert.equal(isDependencySatisfied(v), false, `${JSON.stringify(v)} NO debe contar como cumplida`);
  }
});

test('#6901 isDependencySatisfied: fail-closed ante estado desconocido (allowlist, no denylist)', () => {
  // Si el criterio fuera `!== "OPEN"` (denylist), cualquiera de estos pasaria
  // y el fail-closed quedaria roto. La allowlist los rechaza a todos.
  for (const v of ['UNKNOWN', 'DRAFT', 'LOCKED', 'CLOSED_MAYBE', 'MERGED_PENDING', 'cerrado']) {
    assert.equal(isDependencySatisfied(v), false, `${v} NO debe contar como cumplida`);
  }
});

test('#6901 isDependencySatisfied: tolera espacios y minusculas del proveedor', () => {
  assert.equal(isDependencySatisfied('  MERGED  '), true);
  assert.equal(isDependencySatisfied('merged'), true);
  assert.equal(isDependencySatisfied('closed'), true);
});

test('#6901 SATISFIED_DEP_STATES es la allowlist cerrada y exacta', () => {
  assert.deepEqual([...SATISFIED_DEP_STATES].sort(), ['CLOSED', 'MERGED']);
});

test('#6901 allDepsClosed: unica dep es un PR mergeado → true (el bug original)', () => {
  assert.equal(allDepsClosed([5203], { 5203: 'MERGED' }), true);
});

test('#6901 allDepsClosed: mezcla de cerrada y mergeada → true', () => {
  assert.equal(allDepsClosed([5203, 5204], { 5203: 'MERGED', 5204: 'CLOSED' }), true);
});

test('#6901 allDepsClosed: cerrada + mergeada + abierta → false', () => {
  assert.equal(allDepsClosed([5203, 5204, 5205], { 5203: 'MERGED', 5204: 'CLOSED', 5205: 'OPEN' }), false);
});

test('#6901 allDepsClosed: mergeada + estado ausente → false (fail-closed intacto)', () => {
  assert.equal(allDepsClosed([5203, 9999], { 5203: 'MERGED' }), false);
});

test('#6901 allDepsClosed: mergeada + estado no reconocido → false (fail-closed intacto)', () => {
  assert.equal(allDepsClosed([5203, 9999], { 5203: 'MERGED', 9999: 'UNKNOWN' }), false);
});

test('#6901 selectMarkersToRelease: libera el marker cuya unica dep es un PR mergeado', () => {
  const { toRelease, blocked } = selectMarkersToRelease({
    markers: [{ issue: 5214, deps: [5203] }],
    issueStates: { 5203: 'MERGED' },
  });
  assert.equal(toRelease.length, 1, 'el issue congelado por un PR mergeado debe liberarse');
  assert.equal(toRelease[0].issue, 5214);
  assert.equal(blocked.length, 0);
});

test('#6901 selectMarkersToRelease: con mezcla, openDeps lista SOLO la que sigue abierta', () => {
  const { toRelease, blocked } = selectMarkersToRelease({
    markers: [{ issue: 5214, deps: [5203, 5204, 5205] }],
    issueStates: { 5203: 'MERGED', 5204: 'CLOSED', 5205: 'OPEN' },
  });
  assert.equal(toRelease.length, 0, 'con una dep abierta NO se libera');
  assert.deepEqual(blocked[0].openDeps, ['5205'], 'ni la mergeada ni la cerrada figuran como pendientes');
});

test('#6901 selectMarkersToRelease: dep de estado ilegible NO se libera aunque el resto este mergeada', () => {
  const { toRelease, blocked } = selectMarkersToRelease({
    markers: [{ issue: 5214, deps: [5203, 9999] }],
    issueStates: { 5203: 'MERGED' },
  });
  assert.equal(toRelease.length, 0, 'fail-closed: estado ausente cuenta como abierta');
  assert.deepEqual(blocked[0].openDeps, ['9999']);
});

test('#6901 selectHumanBlocksToRelease: precondicion cumplida por un PR mergeado', () => {
  const { toRelease } = selectHumanBlocksToRelease({
    markers: [{ issue: 5209, precondition: { type: 'dependency', depends_on: [5203] } }],
    issueStates: { 5203: 'MERGED' },
  });
  assert.equal(toRelease.length, 1, 'el bloqueo humano por precondicion tambien reconoce MERGED');
});

test('#6901 selectHumanBlocksToRelease: mergeada + otra abierta → sigue bloqueado', () => {
  const { toRelease, blocked } = selectHumanBlocksToRelease({
    markers: [{ issue: 5209, precondition: { type: 'dependency', depends_on: [5203, 5208] } }],
    issueStates: { 5203: 'MERGED', 5208: 'OPEN' },
  });
  assert.equal(toRelease.length, 0);
  assert.deepEqual(blocked[0].openDeps, ['5208']);
});

// -----------------------------------------------------------------------------
// #6901 CA-5 — la mensajeria usa el verbo REAL de cada dependencia
// -----------------------------------------------------------------------------

test('#6901 describeSatisfiedDeps: verbo por dependencia, no verbo global', () => {
  assert.equal(
    describeSatisfiedDeps([5203, 5204], { 5203: 'MERGED', 5204: 'CLOSED' }),
    '#5203 fue mergeada y #5204 fue cerrada'
  );
});

test('#6901 describeSatisfiedDeps: singular natural con una sola dependencia', () => {
  assert.equal(describeSatisfiedDeps([5203], { 5203: 'MERGED' }), '#5203 fue mergeada');
  assert.equal(describeSatisfiedDeps([5204], { 5204: 'CLOSED' }), '#5204 fue cerrada');
});

test('#6901 describeSatisfiedDeps: tres o mas se enumeran con comas y una "y" final', () => {
  assert.equal(
    describeSatisfiedDeps([1, 2, 3], { 1: 'MERGED', 2: 'CLOSED', 3: 'MERGED' }),
    '#1 fue mergeada, #2 fue cerrada y #3 fue mergeada'
  );
});

test('#6901 describeSatisfiedDeps: sin estado informado no inventa verbo', () => {
  assert.equal(describeSatisfiedDeps([5203], {}), '#5203 quedó resuelta');
  assert.equal(describeSatisfiedDeps([], {}), '(ninguna)');
});

test('#6901 describePendingDeps: distingue "sigue abierta" de "no se pudo leer"', () => {
  assert.equal(describePendingDeps([5205], { 5205: 'OPEN' }), '#5205 sigue abierta');
  assert.match(describePendingDeps([9999], {}), /no se pudo leer el estado de #9999/);
  assert.match(describePendingDeps([9999], {}), /se asume abierta por precaución/);
});

test('#6901 describePendingDeps: estado no reconocido se nombra y se asume abierto', () => {
  const txt = describePendingDeps([9999], { 9999: 'DRAFT' });
  assert.match(txt, /#9999 está en estado no reconocido \(DRAFT\)/);
  assert.match(txt, /se asume abierta por precaución/);
});

test('#6901 describeSatisfiedDeps/describePendingDeps: entradas basura no rompen', () => {
  assert.equal(describeSatisfiedDeps(null, null), '(ninguna)');
  assert.equal(describePendingDeps(undefined, undefined), '(ninguna)');
});

test('#6901 decideSplitUmbrellaClose: el destrabe normal nombra el PR como mergeado', () => {
  const res = decideSplitUmbrellaClose({
    issue: { number: 5214, title: 'Historia normal', labels: [] },
    deps: [5203, 5204],
    depStates: { 5203: 'MERGED', 5204: 'CLOSED' },
  });
  assert.equal(res.action, 'unblock');
  assert.match(res.log, /#5203 fue mergeada y #5204 fue cerrada/);
  assert.doesNotMatch(res.log, /dependencias cerradas/, 'el verbo global mentiroso ya no aparece');
});
