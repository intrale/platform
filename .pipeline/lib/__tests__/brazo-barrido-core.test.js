// =============================================================================
// Tests brazo-barrido-core.js — decisión pura de cierre de fase (EP5-H1, #3938)
//
// Cubre:
//   CA-3 · Promoción: todos `aprobado` → action='promote', toFase = siguiente.
//          Última fase → toFase=null (issue completó pipeline).
//   CA-3 · Rebote: ≥1 `rechazado` → action='rebote', rejectedSkills listados.
//   CA-3 · Wait: skills faltantes sin rechazo → action='wait'.
//   CA-2/CA-9 · Caracterización: la clasificación de rebote
//          (human_block/infra/code/dependency_block) es invariante; el contador
//          cross-phase y el corte del circuit breaker se ejercen contra los
//          helpers exportados por pulpo.js (PULPO_NO_AUTOSTART=1).
//
// Fixtures con valores dummy, sin tokens reales (CA-8).
// =============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { decidePhaseOutcome, nextFase } = require('../brazo-barrido-core');

const FASES = ['validacion', 'dev', 'build', 'verificacion', 'aprobacion', 'entrega'];

// -----------------------------------------------------------------------------
// nextFase
// -----------------------------------------------------------------------------
test('nextFase devuelve la siguiente fase y null en la última', () => {
  assert.equal(nextFase(FASES, 0), 'dev');
  assert.equal(nextFase(FASES, 3), 'aprobacion');
  assert.equal(nextFase(FASES, FASES.length - 1), null);
  assert.equal(nextFase(FASES, -1), null);
  assert.equal(nextFase(null, 0), null);
});

// -----------------------------------------------------------------------------
// CA-3 · Promoción
// -----------------------------------------------------------------------------
test('CA-3: todos aprobados → promote a la siguiente fase', () => {
  const out = decidePhaseOutcome({
    skillsRequeridos: ['po', 'ux', 'guru'],
    estadosPorSkill: {
      po: { resultado: 'aprobado' },
      ux: { resultado: 'aprobado' },
      guru: { resultado: 'aprobado' },
    },
    fases: FASES,
    faseIdx: 0,
  });
  assert.deepEqual(out, { action: 'promote', toFase: 'dev', rejectedSkills: [] });
});

test('CA-3: promoción de fase de un solo skill (dev → build)', () => {
  const out = decidePhaseOutcome({
    skillsRequeridos: ['pipeline-dev'],
    estadosPorSkill: { 'pipeline-dev': { resultado: 'aprobado' } },
    fases: FASES,
    faseIdx: 1,
  });
  assert.deepEqual(out, { action: 'promote', toFase: 'build', rejectedSkills: [] });
});

test('CA-3: última fase aprobada → promote con toFase=null (pipeline completo)', () => {
  const out = decidePhaseOutcome({
    skillsRequeridos: ['delivery'],
    estadosPorSkill: { delivery: { resultado: 'aprobado' } },
    fases: FASES,
    faseIdx: FASES.length - 1,
  });
  assert.deepEqual(out, { action: 'promote', toFase: null, rejectedSkills: [] });
});

// -----------------------------------------------------------------------------
// CA-3 · Rebote (fast-fail)
// -----------------------------------------------------------------------------
test('CA-3: un skill rechazado → rebote (fast-fail, no espera al resto)', () => {
  const out = decidePhaseOutcome({
    skillsRequeridos: ['tester', 'security', 'qa'],
    estadosPorSkill: {
      tester: { resultado: 'aprobado' },
      qa: { resultado: 'rechazado', motivo: 'video sin audio' },
      // security todavía no entregó
    },
    fases: FASES,
    faseIdx: 3,
  });
  assert.equal(out.action, 'rebote');
  assert.equal(out.toFase, null);
  assert.deepEqual(out.rejectedSkills, ['qa']);
});

test('CA-3: múltiples rechazos listan todos los rejectedSkills', () => {
  const out = decidePhaseOutcome({
    skillsRequeridos: ['po', 'ux', 'guru'],
    estadosPorSkill: {
      po: { resultado: 'rechazado', motivo: 'criterios incompletos' },
      ux: { resultado: 'rechazado', motivo: 'falta mockup' },
      guru: { resultado: 'aprobado' },
    },
    fases: FASES,
    faseIdx: 0,
  });
  assert.equal(out.action, 'rebote');
  assert.deepEqual(out.rejectedSkills.sort(), ['po', 'ux']);
});

// -----------------------------------------------------------------------------
// CA-3 · Wait
// -----------------------------------------------------------------------------
test('CA-3: skills faltantes sin rechazo → wait', () => {
  const out = decidePhaseOutcome({
    skillsRequeridos: ['po', 'ux', 'guru'],
    estadosPorSkill: {
      po: { resultado: 'aprobado' },
      // ux y guru aún no entregaron
    },
    fases: FASES,
    faseIdx: 0,
  });
  assert.deepEqual(out, { action: 'wait', toFase: null, rejectedSkills: [] });
});

test('wait con estados vacíos y skills requeridos', () => {
  const out = decidePhaseOutcome({
    skillsRequeridos: ['po'],
    estadosPorSkill: {},
    fases: FASES,
    faseIdx: 0,
  });
  assert.equal(out.action, 'wait');
});

test('promote inmediato cuando no hay skills requeridos (degenerado)', () => {
  const out = decidePhaseOutcome({
    skillsRequeridos: [],
    estadosPorSkill: {},
    fases: FASES,
    faseIdx: 0,
  });
  assert.equal(out.action, 'promote');
  assert.equal(out.toFase, 'dev');
});

test('es defensivo ante inputs no-objeto', () => {
  const out = decidePhaseOutcome({
    skillsRequeridos: null,
    estadosPorSkill: null,
    fases: null,
    faseIdx: 0,
  });
  assert.equal(out.action, 'promote'); // sin requeridos ni rechazos
  assert.equal(out.toFase, null);
});

// -----------------------------------------------------------------------------
// CA-2/CA-9 · Caracterización: clasificación de rebote invariante
// -----------------------------------------------------------------------------
const reboteClassifier = require('../rebote-classifier');

test('CA-9: clasificación human_block invariante (merge manual / CODEOWNERS)', () => {
  const r = reboteClassifier.classifyRebote({
    motivo: 'Requiere merge manual por CODEOWNERS, necesita intervención humana',
  });
  assert.equal(r.category, 'human_block');
  assert.equal(r.counts_against_circuit_breaker, false);
});

test('CA-9: clasificación infra invariante (no cuenta contra circuit breaker)', () => {
  const r = reboteClassifier.classifyRebote({
    motivo: 'ETIMEDOUT al contactar la API',
    classifyErrorResult: 'infra',
  });
  assert.equal(r.category, 'infra');
  assert.equal(r.counts_against_circuit_breaker, false);
});

test('CA-9: clasificación code invariante (cuenta contra circuit breaker)', () => {
  const r = reboteClassifier.classifyRebote({
    motivo: 'El test `loadProfile` falla: expected 2 received 0',
    classifyErrorResult: 'codigo',
  });
  assert.equal(r.category, 'code');
  assert.equal(r.counts_against_circuit_breaker, true);
});

test('CA-9: clasificación dependency_block invariante (hint YAML)', () => {
  const r = reboteClassifier.classifyRebote({
    motivo: 'depende de #1234 todavía OPEN',
    rebote_categoria: 'dependency_block',
    dependsOn: [1234],
  });
  assert.equal(r.category, 'dependency_block');
  assert.equal(r.counts_against_circuit_breaker, false);
  assert.deepEqual(r.dependsOn, [1234]);
});

// -----------------------------------------------------------------------------
// CA-2 · Caracterización: circuit breaker cross-phase + escalada (pulpo.js)
// -----------------------------------------------------------------------------
process.env.PULPO_NO_AUTOSTART = '1';
const pulpo = require('../../pulpo.js');

test('CA-2: MAX_CROSSPHASE_REBOTES define el cap del circuit breaker cross-phase', () => {
  assert.equal(typeof pulpo.MAX_CROSSPHASE_REBOTES, 'number');
  assert.ok(pulpo.MAX_CROSSPHASE_REBOTES >= 1);
});

test('CA-2: findPreviousFaseForSkill resuelve la fase previa del mismo skill (escalada)', () => {
  const cfg = {
    pipelines: {
      definicion: {
        fases: ['analisis', 'criterios', 'sizing'],
        skills_por_fase: { analisis: ['guru'], criterios: ['po', 'ux'], sizing: ['planner'] },
      },
      desarrollo: {
        fases: ['validacion', 'dev', 'aprobacion'],
        skills_por_fase: { validacion: ['po', 'ux', 'guru'], dev: ['pipeline-dev'], aprobacion: ['review', 'po'] },
      },
    },
  };
  // 2do intento de cross-phase a desarrollo/validacion/ux escala a la fase
  // previa del mismo skill (definicion/criterios/ux).
  const previa = pulpo.findPreviousFaseForSkill('ux', 'desarrollo', 'validacion', cfg);
  assert.ok(previa, 'debe encontrar una fase previa para ux');
  assert.equal(previa.skill, 'ux');
  // La fase previa debe ser estrictamente upstream (índice global menor).
  const idxPrevia = pulpo.faseGlobalIndex(previa.pipeline, previa.fase, cfg);
  const idxActual = pulpo.faseGlobalIndex('desarrollo', 'validacion', cfg);
  assert.ok(idxPrevia < idxActual, 'la fase previa debe ser upstream');
});

test('CA-2: findPreviousFaseForSkill devuelve null cuando no hay fase previa (escala a humano)', () => {
  const cfg = {
    pipelines: {
      definicion: {
        fases: ['analisis'],
        skills_por_fase: { analisis: ['guru'] },
      },
    },
  };
  // guru sólo existe en la primera fase global → no hay previa.
  const previa = pulpo.findPreviousFaseForSkill('guru', 'definicion', 'analisis', cfg);
  assert.equal(previa, null);
});
