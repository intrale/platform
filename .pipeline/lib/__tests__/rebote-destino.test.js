// .pipeline/lib/__tests__/rebote-destino.test.js
// =============================================================================
// Tests de lib/rebote-destino.js — issue #2374.
//
// Asegura el contrato del rebote:
//   - rebote código  → faseRechazo (dev)
//   - rebote infra   → MISMA fase (mono-skill: un solo skill; paralela: todos)
//
// Sin estos tests, una regresión silenciosa devolvería issues a dev cuando el
// código no falló (timeout/watchdog/crash), causando ciclos de cómputo
// duplicado — el incidente que motivó este issue (#2159: delivery #2159 muerto
// por timeout de CI, rebotado erróneamente a backend-dev).
// =============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { resolveReboteDestino, FASES_MONO_SKILL } = require('../rebote-destino');

// Configuración estándar de skills_por_fase (espejo del config.yaml).
const SKILLS_POR_FASE = {
  validacion: ['po', 'ux', 'guru'],
  dev: ['backend-dev', 'android-dev', 'web-dev', 'pipeline-dev'],
  build: ['build'],
  verificacion: ['tester', 'security', 'qa'],
  linteo: ['linter'],
  aprobacion: ['review', 'po', 'ux'],
  entrega: ['delivery'],
};

// Stub determinístico de determinarDevSkill — siempre devuelve el mismo skill
// para evitar dependencia de labels reales.
function fakeDetermineDevSkill(_issue, _config) {
  return 'pipeline-dev';
}

// Stub determinístico de skillFromFile — extrae el sufijo después del primer punto.
function fakeSkillFromFile(name) {
  if (!name || typeof name !== 'string') return '';
  const dot = name.indexOf('.');
  return dot === -1 ? '' : name.slice(dot + 1);
}

// =============================================================================
// REBOTE CÓDIGO — comportamiento histórico (preservar): destino = faseRechazo
// =============================================================================

test('rebote código en fase verificacion → faseRechazo (dev) con devSkill', () => {
  const r = resolveReboteDestino({
    esReboteDeInfra: false,
    fase: 'verificacion',
    faseRechazo: 'dev',
    skillsPorFase: SKILLS_POR_FASE,
    determinarDevSkill: fakeDetermineDevSkill,
    rechazados: [{ file: { name: '1234.qa' }, motivo: 'tests fallan' }],
    issue: 1234,
    config: {},
    skillFromFile: fakeSkillFromFile,
  });
  assert.equal(r.faseDestino, 'dev');
  assert.deepEqual(r.skillsDestino, ['pipeline-dev']);
});

test('rebote código en fase aprobacion → faseRechazo (dev) con devSkill', () => {
  const r = resolveReboteDestino({
    esReboteDeInfra: false,
    fase: 'aprobacion',
    faseRechazo: 'dev',
    skillsPorFase: SKILLS_POR_FASE,
    determinarDevSkill: fakeDetermineDevSkill,
    rechazados: [{ file: { name: '2000.review' }, motivo: 'review bloqueado' }],
    issue: 2000,
    config: {},
    skillFromFile: fakeSkillFromFile,
  });
  assert.equal(r.faseDestino, 'dev');
  assert.deepEqual(r.skillsDestino, ['pipeline-dev']);
});

test('rebote código en fase dev → faseRechazo (dev) — mismo destino (no regresión)', () => {
  const r = resolveReboteDestino({
    esReboteDeInfra: false,
    fase: 'dev',
    faseRechazo: 'dev',
    skillsPorFase: SKILLS_POR_FASE,
    determinarDevSkill: fakeDetermineDevSkill,
    rechazados: [{ file: { name: '5.pipeline-dev' }, motivo: 'tests rotos' }],
    issue: 5,
    config: {},
    skillFromFile: fakeSkillFromFile,
  });
  assert.equal(r.faseDestino, 'dev');
  assert.deepEqual(r.skillsDestino, ['pipeline-dev']);
});

// =============================================================================
// REBOTE INFRA — CAMBIO NUEVO #2374: destino = MISMA fase
// =============================================================================

test('rebote INFRA en fase entrega → MISMA fase entrega con skill delivery', () => {
  // Caso canónico del issue #2374: delivery #2159 murió por timeout esperando
  // CI. PR estaba creado con checks pass. Antes: rebotaba a dev/backend-dev.
  // Ahora: re-encola en entrega/delivery.
  const r = resolveReboteDestino({
    esReboteDeInfra: true,
    fase: 'entrega',
    faseRechazo: 'dev',
    skillsPorFase: SKILLS_POR_FASE,
    determinarDevSkill: fakeDetermineDevSkill,
    rechazados: [{ file: { name: '2159.delivery' }, motivo: 'watchdog timeout 90min' }],
    issue: 2159,
    config: {},
    skillFromFile: fakeSkillFromFile,
  });
  assert.equal(r.faseDestino, 'entrega', 'destino debe ser entrega, NO dev');
  assert.deepEqual(r.skillsDestino, ['delivery'], 'skill debe ser delivery, NO backend-dev');
});

test('rebote INFRA en fase build → MISMA fase build con skill build', () => {
  const r = resolveReboteDestino({
    esReboteDeInfra: true,
    fase: 'build',
    faseRechazo: 'dev',
    skillsPorFase: SKILLS_POR_FASE,
    determinarDevSkill: fakeDetermineDevSkill,
    rechazados: [{ file: { name: '500.build' }, motivo: 'gradle crash OOM' }],
    issue: 500,
    config: {},
    skillFromFile: fakeSkillFromFile,
  });
  assert.equal(r.faseDestino, 'build');
  assert.deepEqual(r.skillsDestino, ['build']);
});

test('rebote INFRA en fase verificacion (paralela) → MISMA fase con TODOS los skills', () => {
  // Multi-skill: si solo re-encoláramos qa, las próximas evaluaciones
  // quedarían incompletas para siempre (tester+security en procesado).
  const r = resolveReboteDestino({
    esReboteDeInfra: true,
    fase: 'verificacion',
    faseRechazo: 'dev',
    skillsPorFase: SKILLS_POR_FASE,
    determinarDevSkill: fakeDetermineDevSkill,
    rechazados: [{ file: { name: '777.qa' }, motivo: 'emulador timeout' }],
    issue: 777,
    config: {},
    skillFromFile: fakeSkillFromFile,
  });
  assert.equal(r.faseDestino, 'verificacion');
  assert.deepEqual(r.skillsDestino.sort(), ['qa', 'security', 'tester']);
});

test('rebote INFRA en fase aprobacion (paralela) → MISMA fase con TODOS los skills', () => {
  const r = resolveReboteDestino({
    esReboteDeInfra: true,
    fase: 'aprobacion',
    faseRechazo: 'dev',
    skillsPorFase: SKILLS_POR_FASE,
    determinarDevSkill: fakeDetermineDevSkill,
    rechazados: [{ file: { name: '900.review' }, motivo: 'gh api timeout' }],
    issue: 900,
    config: {},
    skillFromFile: fakeSkillFromFile,
  });
  assert.equal(r.faseDestino, 'aprobacion');
  assert.deepEqual(r.skillsDestino.sort(), ['po', 'review', 'ux']);
});

test('rebote INFRA en fase dev → MISMA fase dev con devSkill resuelto por labels', () => {
  // dev es mono-skill funcional (varios skills declarados pero solo 1 corre
  // por issue, según labels). Re-encolar usando determinarDevSkill.
  const r = resolveReboteDestino({
    esReboteDeInfra: true,
    fase: 'dev',
    faseRechazo: 'dev',
    skillsPorFase: SKILLS_POR_FASE,
    determinarDevSkill: fakeDetermineDevSkill,
    rechazados: [{ file: { name: '42.pipeline-dev' }, motivo: 'crash de claude.exe' }],
    issue: 42,
    config: {},
    skillFromFile: fakeSkillFromFile,
  });
  assert.equal(r.faseDestino, 'dev');
  assert.deepEqual(r.skillsDestino, ['pipeline-dev']);
});

// =============================================================================
// FALLBACKS DEFENSIVOS — config rota / fase no declarada
// =============================================================================

test('fallback: rebote infra con fase no declarada en skills_por_fase → usa skills de rechazados', () => {
  const r = resolveReboteDestino({
    esReboteDeInfra: true,
    fase: 'fase-fantasma',
    faseRechazo: 'dev',
    skillsPorFase: SKILLS_POR_FASE, // no contiene 'fase-fantasma'
    determinarDevSkill: fakeDetermineDevSkill,
    rechazados: [
      { file: { name: '1.skillA' }, motivo: 'x' },
      { file: { name: '1.skillB' }, motivo: 'y' },
    ],
    issue: 1,
    config: {},
    skillFromFile: fakeSkillFromFile,
  });
  assert.equal(r.faseDestino, 'fase-fantasma');
  assert.deepEqual(r.skillsDestino.sort(), ['skillA', 'skillB']);
});

test('fallback: rebote infra con skills_por_fase vacío en la fase → usa skills de rechazados', () => {
  const r = resolveReboteDestino({
    esReboteDeInfra: true,
    fase: 'verificacion',
    faseRechazo: 'dev',
    skillsPorFase: { verificacion: [] },
    determinarDevSkill: fakeDetermineDevSkill,
    rechazados: [{ file: { name: '3.qa' }, motivo: 'timeout' }],
    issue: 3,
    config: {},
    skillFromFile: fakeSkillFromFile,
  });
  assert.equal(r.faseDestino, 'verificacion');
  assert.deepEqual(r.skillsDestino, ['qa']);
});

test('fallback: rebote infra sin determinarDevSkill (dev) → fallback a rechazados', () => {
  const r = resolveReboteDestino({
    esReboteDeInfra: true,
    fase: 'dev',
    faseRechazo: 'dev',
    skillsPorFase: SKILLS_POR_FASE,
    determinarDevSkill: null,
    rechazados: [{ file: { name: '7.backend-dev' }, motivo: 'x' }],
    issue: 7,
    config: {},
    skillFromFile: fakeSkillFromFile,
  });
  assert.equal(r.faseDestino, 'dev');
  assert.deepEqual(r.skillsDestino, ['backend-dev']);
});

test('fallback: rebote código sin determinarDevSkill → skillsDestino vacío (caller debe loggear)', () => {
  const r = resolveReboteDestino({
    esReboteDeInfra: false,
    fase: 'verificacion',
    faseRechazo: 'dev',
    skillsPorFase: SKILLS_POR_FASE,
    determinarDevSkill: null,
    rechazados: [{ file: { name: '8.qa' }, motivo: 'x' }],
    issue: 8,
    config: {},
    skillFromFile: fakeSkillFromFile,
  });
  // Comportamiento conservador: no inventamos un skill — el caller debe
  // detectar destino vacío y escalar (no perder rebote silenciosamente).
  assert.equal(r.faseDestino, 'dev');
  assert.deepEqual(r.skillsDestino, []);
});

// =============================================================================
// EXPORTS
// =============================================================================

test('FASES_MONO_SKILL exporta el set canónico', () => {
  assert.ok(FASES_MONO_SKILL.has('dev'));
  assert.ok(FASES_MONO_SKILL.has('build'));
  assert.ok(FASES_MONO_SKILL.has('entrega'));
  assert.ok(!FASES_MONO_SKILL.has('verificacion'));
  assert.ok(!FASES_MONO_SKILL.has('validacion'));
  assert.ok(!FASES_MONO_SKILL.has('aprobacion'));
});
