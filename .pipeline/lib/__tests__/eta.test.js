// Tests para .pipeline/lib/eta.js (issue #2895).
//
// Verificamos las cuatro responsabilidades del módulo:
// 1. Cálculo de elapsed (now - startedAt mínimo del issue).
// 2. Cálculo de remaining (suma de avgs de fases faltantes con ajuste working).
// 3. Detección de "stuck" (working duration > threshold * avg).
// 4. Agregado de lane (max no Σ).
//
// Sin I/O. Datos in-memory que reflejan el shape real de issueData/etaAverages
// expuesto por dashboard.getPipelineState().

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const eta = require('../eta');

// Fixtures: orden de fases simplificado para los tests.
const ALL_FASES = [
  { pipeline: 'definicion',  fase: 'analisis' },
  { pipeline: 'definicion',  fase: 'criterios' },
  { pipeline: 'desarrollo',  fase: 'validacion' },
  { pipeline: 'desarrollo',  fase: 'dev' },
  { pipeline: 'desarrollo',  fase: 'build' },
];

// 5 minutos = 300_000 ms. Lo usamos como anclaje para los timestamps.
const FIVE_MIN = 5 * 60 * 1000;

test('computeIssueEta: elapsed es now - startedAt mínimo del issue', () => {
  const now = 100_000_000;
  const issueData = {
    fases: {
      'definicion/analisis': [
        { skill: 'guru', estado: 'procesado', startedAt: now - 30 * FIVE_MIN, updatedAt: now - 28 * FIVE_MIN },
      ],
      'desarrollo/validacion': [
        { skill: 'po', estado: 'trabajando', startedAt: now - 2 * FIVE_MIN, updatedAt: now - FIVE_MIN, durationMs: 2 * FIVE_MIN },
      ],
    },
  };
  const result = eta.computeIssueEta({ issueData, etaAverages: {}, allFases: ALL_FASES, now });
  assert.equal(result.elapsedMs, 30 * FIVE_MIN, 'elapsed toma el started más antiguo');
  assert.equal(result.issueStartedAt, now - 30 * FIVE_MIN);
});

test('computeIssueEta: remaining suma avg de skills/fases faltantes', () => {
  const now = 1_000_000_000;
  const issueData = {
    fases: {
      'definicion/analisis': [
        { skill: 'guru', estado: 'procesado', startedAt: now - 60 * 60 * 1000, updatedAt: now - 50 * 60 * 1000 },
      ],
      // criterios pendiente (sin entries) → usa avg de fase
      // validacion/dev/build pendientes
    },
  };
  const etaAverages = {
    'analisis/guru':  { avgMs: 10 * 60 * 1000, count: 5 },
    analisis:         { avgMs: 10 * 60 * 1000, count: 5 },
    'criterios/po':   { avgMs: 5 * 60 * 1000, count: 3 },
    criterios:        { avgMs: 5 * 60 * 1000, count: 3 },
    validacion:       { avgMs: 8 * 60 * 1000, count: 10 },
    dev:              { avgMs: 30 * 60 * 1000, count: 7 },
    build:            { avgMs: 4 * 60 * 1000, count: 12 },
  };
  const result = eta.computeIssueEta({ issueData, etaAverages, allFases: ALL_FASES, now });
  // analisis ya está done → 0
  // criterios → 5m
  // validacion → 8m
  // dev → 30m
  // build → 4m
  // Total: 47 minutos
  assert.equal(result.remainingMs, 47 * 60 * 1000);
  assert.equal(result.absoluteMs, now + 47 * 60 * 1000);
  assert.equal(result.hasEta, true);
});

test('computeIssueEta: working entry resta su tiempo ya invertido al avg', () => {
  const now = 1_000_000_000;
  const issueData = {
    fases: {
      'desarrollo/dev': [
        { skill: 'pipeline-dev', estado: 'trabajando', startedAt: now - 10 * 60 * 1000, durationMs: 10 * 60 * 1000 },
      ],
    },
  };
  const etaAverages = {
    'dev/pipeline-dev': { avgMs: 30 * 60 * 1000, count: 5 },
    dev:                { avgMs: 30 * 60 * 1000, count: 5 },
  };
  const result = eta.computeIssueEta({ issueData, etaAverages, allFases: [{ pipeline: 'desarrollo', fase: 'dev' }], now });
  // working lleva 10m; avg = 30m → remaining = 20m
  assert.equal(result.remainingMs, 20 * 60 * 1000);
});

test('computeIssueEta: working entry que excedió el avg da remaining 0 (no negativo)', () => {
  const now = 1_000_000_000;
  const issueData = {
    fases: {
      'desarrollo/dev': [
        { skill: 'pipeline-dev', estado: 'trabajando', startedAt: now - 60 * 60 * 1000, durationMs: 60 * 60 * 1000 },
      ],
    },
  };
  const etaAverages = {
    'dev/pipeline-dev': { avgMs: 30 * 60 * 1000, count: 5 },
    dev:                { avgMs: 30 * 60 * 1000, count: 5 },
  };
  const result = eta.computeIssueEta({ issueData, etaAverages, allFases: [{ pipeline: 'desarrollo', fase: 'dev' }], now });
  assert.equal(result.remainingMs, 0);
});

test('computeIssueEta: hasEta=false si no hay histórico para skills faltantes', () => {
  const now = 1_000_000_000;
  const issueData = {
    fases: {
      'desarrollo/dev': [
        { skill: 'pipeline-dev', estado: 'pendiente', startedAt: now - FIVE_MIN },
      ],
    },
  };
  const result = eta.computeIssueEta({ issueData, etaAverages: {}, allFases: [{ pipeline: 'desarrollo', fase: 'dev' }], now });
  assert.equal(result.hasEta, false);
  assert.equal(result.remainingMs, null);
  assert.equal(result.absoluteMs, null);
});

test('computeIssueEta: detecta stuck cuando working > threshold * avg (default 150%)', () => {
  const now = 1_000_000_000;
  const avg = 10 * 60 * 1000;
  const issueData = {
    fases: {
      'desarrollo/dev': [
        { skill: 'pipeline-dev', estado: 'trabajando', startedAt: now - 16 * 60 * 1000, durationMs: 16 * 60 * 1000 },
      ],
    },
  };
  const etaAverages = {
    'dev/pipeline-dev': { avgMs: avg, count: 5 },
    dev:                { avgMs: avg, count: 5 },
  };
  const result = eta.computeIssueEta({ issueData, etaAverages, allFases: [{ pipeline: 'desarrollo', fase: 'dev' }], now });
  assert.equal(result.isStuck, true, '16m > 150% de 10m (=15m) → stuck');
  assert.equal(result.stuckSkill, 'pipeline-dev');
  assert.equal(result.stuckOverMs, 6 * 60 * 1000);
});

test('computeIssueEta: NO detecta stuck cuando working < threshold * avg', () => {
  const now = 1_000_000_000;
  const avg = 10 * 60 * 1000;
  const issueData = {
    fases: {
      'desarrollo/dev': [
        { skill: 'pipeline-dev', estado: 'trabajando', startedAt: now - 12 * 60 * 1000, durationMs: 12 * 60 * 1000 },
      ],
    },
  };
  const etaAverages = {
    'dev/pipeline-dev': { avgMs: avg, count: 5 },
    dev:                { avgMs: avg, count: 5 },
  };
  const result = eta.computeIssueEta({ issueData, etaAverages, allFases: [{ pipeline: 'desarrollo', fase: 'dev' }], now });
  assert.equal(result.isStuck, false, '12m < 150% de 10m → no stuck');
  assert.equal(result.stuckSkill, null);
});

test('computeIssueEta: stuckPct configurable (umbral 200% no dispara con 16m)', () => {
  const now = 1_000_000_000;
  const issueData = {
    fases: {
      'desarrollo/dev': [
        { skill: 'pipeline-dev', estado: 'trabajando', startedAt: now - 16 * 60 * 1000, durationMs: 16 * 60 * 1000 },
      ],
    },
  };
  const etaAverages = {
    'dev/pipeline-dev': { avgMs: 10 * 60 * 1000, count: 5 },
    dev:                { avgMs: 10 * 60 * 1000, count: 5 },
  };
  const result = eta.computeIssueEta({
    issueData, etaAverages,
    allFases: [{ pipeline: 'desarrollo', fase: 'dev' }],
    now, stuckPct: 200,
  });
  assert.equal(result.isStuck, false, '16m < 200% de 10m → no stuck con threshold custom');
});

test('lookupAvgMs: cae a fase si no existe avg fino', () => {
  const etaAverages = {
    validacion: { avgMs: 8 * 60 * 1000, count: 5 },
  };
  assert.equal(eta.lookupAvgMs(etaAverages, 'validacion', 'po'), 8 * 60 * 1000);
});

test('lookupAvgMs: prefiere avg fino sobre coarse', () => {
  const etaAverages = {
    'validacion/po': { avgMs: 4 * 60 * 1000, count: 3 },
    validacion:      { avgMs: 8 * 60 * 1000, count: 5 },
  };
  assert.equal(eta.lookupAvgMs(etaAverages, 'validacion', 'po'), 4 * 60 * 1000);
});

test('lookupAvgMs: null cuando no hay datos', () => {
  assert.equal(eta.lookupAvgMs({}, 'unknown', 'foo'), null);
  assert.equal(eta.lookupAvgMs(null, 'unknown', 'foo'), null);
});

test('computeLaneEmptyEta: max no Σ (issues corren en paralelo)', () => {
  const now = Date.now();
  const issuesEta = [
    { absoluteMs: now + 30 * 60 * 1000 },
    { absoluteMs: now + 90 * 60 * 1000 },
    { absoluteMs: now + 60 * 60 * 1000 },
  ];
  assert.equal(eta.computeLaneEmptyEta(issuesEta), now + 90 * 60 * 1000);
});

test('computeLaneEmptyEta: ignora issues sin ETA', () => {
  const now = Date.now();
  const issuesEta = [
    { absoluteMs: now + 30 * 60 * 1000 },
    { absoluteMs: null },
    { absoluteMs: undefined },
    { absoluteMs: now + 10 * 60 * 1000 },
  ];
  assert.equal(eta.computeLaneEmptyEta(issuesEta), now + 30 * 60 * 1000);
});

test('computeLaneEmptyEta: null si no hay issues con ETA', () => {
  assert.equal(eta.computeLaneEmptyEta([]), null);
  assert.equal(eta.computeLaneEmptyEta([{ absoluteMs: null }]), null);
});

test('fmtAbsoluteHHMM: formatea HH:MM en hora local', () => {
  // Construimos una fecha local fija para evitar dependencia de timezone.
  const d = new Date(2026, 3, 30, 13, 42, 0);
  assert.equal(eta.fmtAbsoluteHHMM(d.getTime()), '13:42');
});

test('fmtAbsoluteHHMM: padding a dos dígitos', () => {
  const d = new Date(2026, 3, 30, 9, 5, 0);
  assert.equal(eta.fmtAbsoluteHHMM(d.getTime()), '09:05');
});

test('fmtAbsoluteHHMM: dash sentinel para falsy', () => {
  assert.equal(eta.fmtAbsoluteHHMM(null), '—');
  assert.equal(eta.fmtAbsoluteHHMM(0), '—');
});

test('computeIssueEta: issue completo (todas done) tiene hasEta=false y elapsed válido', () => {
  const now = 1_000_000_000;
  const issueData = {
    fases: {
      'definicion/analisis':   [{ skill: 'guru', estado: 'procesado', startedAt: now - 60 * FIVE_MIN, updatedAt: now - 55 * FIVE_MIN }],
      'definicion/criterios':  [{ skill: 'po', estado: 'procesado', startedAt: now - 50 * FIVE_MIN, updatedAt: now - 45 * FIVE_MIN }],
      'desarrollo/validacion': [{ skill: 'po', estado: 'procesado', startedAt: now - 40 * FIVE_MIN, updatedAt: now - 35 * FIVE_MIN }],
      'desarrollo/dev':        [{ skill: 'backend-dev', estado: 'procesado', startedAt: now - 30 * FIVE_MIN, updatedAt: now - 20 * FIVE_MIN }],
      'desarrollo/build':      [{ skill: 'build', estado: 'procesado', startedAt: now - 15 * FIVE_MIN, updatedAt: now - 10 * FIVE_MIN }],
    },
  };
  const result = eta.computeIssueEta({ issueData, etaAverages: {}, allFases: ALL_FASES, now });
  assert.equal(result.hasEta, false, 'sin fases pendientes → no hay ETA');
  assert.equal(result.remainingMs, null);
  assert.equal(result.elapsedMs, 60 * FIVE_MIN);
});

test('computeIssueEta: defensivo ante inputs null/undefined', () => {
  const result = eta.computeIssueEta({ issueData: null, etaAverages: null, allFases: null, now: 1000 });
  assert.equal(result.elapsedMs, null);
  assert.equal(result.remainingMs, null);
  assert.equal(result.isStuck, false);
});
