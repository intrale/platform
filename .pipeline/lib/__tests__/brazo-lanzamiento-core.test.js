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
} = require('../brazo-lanzamiento-core');

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
