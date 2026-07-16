// =============================================================================
// Tests brazo-lanzamiento-core.js — selección/orden puro de candidatos
// (EP5-H1, #3938)
//
// Cubre:
//   - isPhaseBlockedByWindow: ventanas autoexcluyentes QA > Build > Dev.
//   - compareCandidates / rankLaunchCandidates: orden priority asc > fase
//     inversa, filtrado por ventana, sin mutar el input.
//   - Caracterización: el orden producido coincide con el comparador inline
//     histórico de brazoLanzamiento (priority asc, desempate fase inversa).
//
// Fixtures con valores dummy, sin tokens reales (CA-8).
// =============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  rankLaunchCandidates,
  isPhaseBlockedByWindow,
  compareCandidates,
  resolveWindowPendingSignals,
} = require('../brazo-lanzamiento-core');
const dispatchCause = require('../dispatch-cause');

// -----------------------------------------------------------------------------
// isPhaseBlockedByWindow — ventanas autoexcluyentes
// -----------------------------------------------------------------------------
test('sin ventanas activas no bloquea ninguna fase', () => {
  for (const fase of ['dev', 'validacion', 'build', 'verificacion', 'aprobacion']) {
    assert.equal(isPhaseBlockedByWindow(fase, {}), false);
  }
});

test('QA priority bloquea dev + validacion + build (no verificacion)', () => {
  const w = { qaPriority: true };
  assert.equal(isPhaseBlockedByWindow('dev', w), true);
  assert.equal(isPhaseBlockedByWindow('validacion', w), true);
  assert.equal(isPhaseBlockedByWindow('build', w), true);
  assert.equal(isPhaseBlockedByWindow('verificacion', w), false);
  assert.equal(isPhaseBlockedByWindow('aprobacion', w), false);
});

test('Build priority (sin QA) bloquea solo dev + validacion, NO build', () => {
  const w = { buildPriority: true };
  assert.equal(isPhaseBlockedByWindow('dev', w), true);
  assert.equal(isPhaseBlockedByWindow('validacion', w), true);
  assert.equal(isPhaseBlockedByWindow('build', w), false);
});

test('QA priority gana sobre Build priority (autoexcluyente)', () => {
  // Con ambas activas, QA manda: build queda bloqueado por QA.
  const w = { qaPriority: true, buildPriority: true };
  assert.equal(isPhaseBlockedByWindow('build', w), true);
});

// -----------------------------------------------------------------------------
// compareCandidates / rankLaunchCandidates — orden
// -----------------------------------------------------------------------------
test('compareCandidates ordena por prioridad ascendente', () => {
  const a = { priority: 10, faseIdx: 0 };
  const b = { priority: 20, faseIdx: 5 };
  assert.ok(compareCandidates(a, b) < 0); // a (prio menor) primero
});

test('compareCandidates desempata por fase inversa (más avanzada primero)', () => {
  const a = { priority: 10, faseIdx: 1 };
  const b = { priority: 10, faseIdx: 4 };
  assert.ok(compareCandidates(a, b) > 0); // b (fase más avanzada) primero
});

test('rankLaunchCandidates ordena priority asc > fase inversa', () => {
  const candidates = [
    { id: 'A', fase: 'dev', priority: 30, faseIdx: 1 },
    { id: 'B', fase: 'verificacion', priority: 10, faseIdx: 3 },
    { id: 'C', fase: 'aprobacion', priority: 10, faseIdx: 4 },
    { id: 'D', fase: 'build', priority: 20, faseIdx: 2 },
  ];
  const ranked = rankLaunchCandidates({ candidates });
  // priority 10 (C faseIdx4, B faseIdx3) → 20 (D) → 30 (A)
  assert.deepEqual(ranked.map((c) => c.id), ['C', 'B', 'D', 'A']);
});

test('rankLaunchCandidates filtra fases bloqueadas por ventana QA', () => {
  const candidates = [
    { id: 'dev1', fase: 'dev', priority: 5, faseIdx: 1 },
    { id: 'ver1', fase: 'verificacion', priority: 8, faseIdx: 3 },
    { id: 'bld1', fase: 'build', priority: 1, faseIdx: 2 },
  ];
  const ranked = rankLaunchCandidates({ candidates, windows: { qaPriority: true } });
  // dev y build bloqueados → solo verificacion sobrevive.
  assert.deepEqual(ranked.map((c) => c.id), ['ver1']);
});

test('rankLaunchCandidates NO muta el array de entrada', () => {
  const candidates = [
    { id: 'A', fase: 'dev', priority: 30, faseIdx: 1 },
    { id: 'B', fase: 'dev', priority: 10, faseIdx: 1 },
  ];
  const snapshot = candidates.map((c) => c.id);
  rankLaunchCandidates({ candidates });
  assert.deepEqual(candidates.map((c) => c.id), snapshot);
});

test('rankLaunchCandidates es defensivo ante input no-array', () => {
  assert.deepEqual(rankLaunchCandidates({ candidates: null }), []);
  assert.deepEqual(rankLaunchCandidates({}), []);
});

// -----------------------------------------------------------------------------
// resolveWindowPendingSignals — señales de dispatch-cause por ventana (#4709)
// Cierra el gap CA-1/CA-2 del rebote: cola 100% en fases window-blocked debe
// reportar hayPendientes=true + marcar VENTANA_HORARIA (no quedar "ocioso sin
// explicación").
// -----------------------------------------------------------------------------
test('sin pendientes en ninguna fase → hayPendientes=false, sin ventana', () => {
  const r = resolveWindowPendingSignals(
    [{ fase: 'dev', pendingCount: 0 }, { fase: 'build', pendingCount: 0 }],
    { buildPriority: true },
  );
  assert.equal(r.hayPendientes, false);
  assert.equal(r.windowBlockedHasPending, false);
  assert.deepEqual(r.blockedPhases, []);
  assert.equal(r.launchablePending, 0);
});

test('cola 100% en fases window-blocked → hayPendientes=true + VENTANA marcable', () => {
  // Ventana Build-priority activa bloquea dev+validacion. Todos los pendientes
  // viven ahí; nada en fases no bloqueadas → candidates.length sería 0.
  const r = resolveWindowPendingSignals(
    [
      { fase: 'dev', pendingCount: 3 },
      { fase: 'validacion', pendingCount: 1 },
      { fase: 'build', pendingCount: 0 },
      { fase: 'verificacion', pendingCount: 0 },
    ],
    { buildPriority: true },
  );
  assert.equal(r.hayPendientes, true, 'los pendientes window-blocked SÍ cuentan');
  assert.equal(r.windowBlockedHasPending, true);
  assert.deepEqual(r.blockedPhases, ['dev', 'validacion']);
  assert.equal(r.launchablePending, 0, 'no hay pendientes lanzables fuera de la ventana');
});

test('END-TO-END: cola 100% window-blocked publica causa VENTANA_HORARIA', () => {
  // Reproduce el escenario exacto del rebote a nivel de las funciones puras que
  // cablea brazoLanzamiento: derivar señales → armar snapshot → resolveCause.
  const winSignals = resolveWindowPendingSignals(
    [{ fase: 'dev', pendingCount: 2 }, { fase: 'validacion', pendingCount: 1 }],
    { buildPriority: true },
  );
  const gatesActivos = new Set();
  if (winSignals.windowBlockedHasPending) gatesActivos.add(dispatchCause.CAUSAS.VENTANA_HORARIA);
  const resolved = dispatchCause.resolveCause({
    anyLaunched: false,
    hayPendientes: winSignals.hayPendientes,
    gatesActivos,
    detalles: {},
    progressInFlight: false,
  }, 1_720_000_000_000);
  assert.ok(resolved, 'debe publicar una causa (no queda ocioso sin explicación)');
  assert.equal(resolved.causa, dispatchCause.CAUSAS.VENTANA_HORARIA);
  assert.equal(resolved.anomalia, false);
});

test('fase window-blocked VACÍA no marca VENTANA (evita falso positivo por precedencia)', () => {
  // dev bloqueada por ventana pero SIN pendientes; los pendientes reales están en
  // una fase NO bloqueada (verificacion). No debe reportar windowBlockedHasPending.
  const r = resolveWindowPendingSignals(
    [{ fase: 'dev', pendingCount: 0 }, { fase: 'verificacion', pendingCount: 4 }],
    { buildPriority: true },
  );
  assert.equal(r.hayPendientes, true);
  assert.equal(r.windowBlockedHasPending, false, 'fase bloqueada vacía no explica ociosidad');
  assert.deepEqual(r.blockedPhases, []);
  assert.equal(r.launchablePending, 4);
});

test('pendientes mixtos (bloqueados + lanzables) reportan ambas señales', () => {
  const r = resolveWindowPendingSignals(
    [{ fase: 'dev', pendingCount: 2 }, { fase: 'verificacion', pendingCount: 5 }],
    { buildPriority: true },
  );
  assert.equal(r.hayPendientes, true);
  assert.equal(r.windowBlockedHasPending, true);
  assert.deepEqual(r.blockedPhases, ['dev']);
  assert.equal(r.launchablePending, 5);
});

test('resolveWindowPendingSignals es defensivo ante input inválido', () => {
  assert.deepEqual(
    resolveWindowPendingSignals(null, { buildPriority: true }),
    { hayPendientes: false, windowBlockedHasPending: false, blockedPhases: [], launchablePending: 0 },
  );
  // pendingCount no numérico se trata como 0.
  const r = resolveWindowPendingSignals([{ fase: 'dev', pendingCount: 'x' }], { buildPriority: true });
  assert.equal(r.hayPendientes, false);
});

// -----------------------------------------------------------------------------
// Caracterización: equivalencia con el comparador inline histórico
// -----------------------------------------------------------------------------
test('caracterización: rankLaunchCandidates reproduce el sort inline histórico', () => {
  // Comparador inline tal como vivía en brazoLanzamiento (pulpo.js:5010-5022).
  const legacySort = (arr) => arr.slice().sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    return b.faseIdx - a.faseIdx;
  });
  const candidates = [
    { id: 'A', fase: 'dev', priority: 0, faseIdx: 1 },
    { id: 'B', fase: 'dev', priority: 0, faseIdx: 5 },
    { id: 'C', fase: 'dev', priority: 999, faseIdx: 0 },
    { id: 'D', fase: 'dev', priority: 10, faseIdx: 3 },
    { id: 'E', fase: 'dev', priority: 10, faseIdx: 2 },
  ];
  const legacy = legacySort(candidates).map((c) => c.id);
  const nuevo = rankLaunchCandidates({ candidates }).map((c) => c.id);
  assert.deepEqual(nuevo, legacy);
});
