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

const { selectMarkersToRelease, selectHumanBlocksToRelease, allDepsClosed } = require('../brazo-desbloqueo-core');

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
