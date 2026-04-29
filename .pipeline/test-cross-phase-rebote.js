#!/usr/bin/env node
// =============================================================================
// Tests cross-phase rebote (#2516 — PR del reparto UX↔dev)
//
// Cubren los helpers puros de pulpo.js:
//   - faseGlobalIndex / getFaseGlobalOrder
//   - findPreviousFaseForSkill
//   - validateRebotedDestino
//   - resolveRebotedCrossPhase
//
// NO cubren integración con filesystem (cleanup, escribir archivos) — eso queda
// validado por observación real en el próximo ciclo de #2505 post-merge.
// =============================================================================

process.env.PULPO_NO_AUTOSTART = '1';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const pulpo = require('./pulpo.js');

const CONFIG_FAKE = {
  pipelines: {
    definicion: {
      fases: ['analisis', 'criterios', 'sizing'],
      skills_por_fase: {
        analisis: ['guru', 'security'],
        criterios: ['po', 'ux'],
        sizing: ['planner'],
      },
    },
    desarrollo: {
      fases: ['validacion', 'dev', 'build', 'verificacion', 'linteo', 'aprobacion', 'entrega'],
      skills_por_fase: {
        validacion: ['po', 'ux', 'guru'],
        dev: ['backend-dev', 'android-dev', 'web-dev', 'pipeline-dev'],
        build: ['build'],
        verificacion: ['tester', 'security', 'qa'],
        linteo: ['linter'],
        aprobacion: ['review', 'po', 'ux'],
        entrega: ['delivery'],
      },
    },
  },
};

test('getFaseGlobalOrder genera orden plano de fases', () => {
  const order = pulpo.getFaseGlobalOrder(CONFIG_FAKE);
  assert.equal(order.length, 10);
  assert.deepEqual(order[0], { pipeline: 'definicion', fase: 'analisis' });
  assert.deepEqual(order[2], { pipeline: 'definicion', fase: 'sizing' });
  assert.deepEqual(order[3], { pipeline: 'desarrollo', fase: 'validacion' });
  assert.deepEqual(order[9], { pipeline: 'desarrollo', fase: 'entrega' });
});

test('faseGlobalIndex devuelve indice correcto', () => {
  assert.equal(pulpo.faseGlobalIndex('definicion', 'analisis', CONFIG_FAKE), 0);
  assert.equal(pulpo.faseGlobalIndex('desarrollo', 'dev', CONFIG_FAKE), 4);
  assert.equal(pulpo.faseGlobalIndex('desarrollo', 'entrega', CONFIG_FAKE), 9);
  assert.equal(pulpo.faseGlobalIndex('no-pipe', 'fake', CONFIG_FAKE), -1);
});

test('findPreviousFaseForSkill: ux desde desarrollo/validacion escala a definicion/criterios', () => {
  const prev = pulpo.findPreviousFaseForSkill('ux', 'desarrollo', 'validacion', CONFIG_FAKE);
  assert.deepEqual(prev, { pipeline: 'definicion', fase: 'criterios', skill: 'ux' });
});

test('findPreviousFaseForSkill: ux desde definicion/criterios no tiene anterior', () => {
  const prev = pulpo.findPreviousFaseForSkill('ux', 'definicion', 'criterios', CONFIG_FAKE);
  assert.equal(prev, null);
});

test('findPreviousFaseForSkill: po desde aprobacion escala a validacion (mismo pipeline)', () => {
  const prev = pulpo.findPreviousFaseForSkill('po', 'desarrollo', 'aprobacion', CONFIG_FAKE);
  assert.deepEqual(prev, { pipeline: 'desarrollo', fase: 'validacion', skill: 'po' });
});

test('validateRebotedDestino: destino upstream valido', () => {
  const res = pulpo.validateRebotedDestino(
    { pipeline: 'desarrollo', fase: 'validacion', skill: 'ux' },
    'desarrollo', 'dev', CONFIG_FAKE
  );
  assert.equal(res.ok, true);
});

test('validateRebotedDestino: destino downstream rechazado', () => {
  const res = pulpo.validateRebotedDestino(
    { pipeline: 'desarrollo', fase: 'aprobacion', skill: 'review' },
    'desarrollo', 'dev', CONFIG_FAKE
  );
  assert.equal(res.ok, false);
  assert.match(res.reason, /destino-no-upstream/);
});

test('validateRebotedDestino: skill inexistente en la fase', () => {
  const res = pulpo.validateRebotedDestino(
    { pipeline: 'desarrollo', fase: 'validacion', skill: 'backend-dev' },
    'desarrollo', 'dev', CONFIG_FAKE
  );
  assert.equal(res.ok, false);
  assert.match(res.reason, /skill-no-en-fase/);
});

test('validateRebotedDestino: campos incompletos', () => {
  assert.equal(pulpo.validateRebotedDestino(null, 'desarrollo', 'dev', CONFIG_FAKE).ok, false);
  assert.equal(pulpo.validateRebotedDestino({}, 'desarrollo', 'dev', CONFIG_FAKE).ok, false);
  assert.equal(pulpo.validateRebotedDestino({ pipeline: 'x' }, 'desarrollo', 'dev', CONFIG_FAKE).ok, false);
});

test('validateRebotedDestino: pipeline inexistente', () => {
  const res = pulpo.validateRebotedDestino(
    { pipeline: 'ghost', fase: 'validacion', skill: 'ux' },
    'desarrollo', 'dev', CONFIG_FAKE
  );
  assert.equal(res.ok, false);
  assert.match(res.reason, /pipeline-no-existe/);
});

test('resolveRebotedCrossPhase: ignora archivos sin rebote_destino', () => {
  const resultados = [
    { resultado: 'rechazado', motivo: 'x', file: { name: '100.android-dev' } },
  ];
  assert.equal(pulpo.resolveRebotedCrossPhase(resultados, 'desarrollo', 'dev', CONFIG_FAKE), null);
});

test('resolveRebotedCrossPhase: elige destino mas upstream entre varios', () => {
  const resultados = [
    {
      resultado: 'rechazado', motivo: 'a',
      rebote_destino: { pipeline: 'desarrollo', fase: 'validacion', skill: 'ux' },
      file: { name: '100.android-dev' },
    },
    {
      resultado: 'rechazado', motivo: 'b',
      rebote_destino: { pipeline: 'definicion', fase: 'criterios', skill: 'ux' },
      file: { name: '100.backend-dev' },
    },
  ];
  const res = pulpo.resolveRebotedCrossPhase(resultados, 'desarrollo', 'dev', CONFIG_FAKE);
  assert.ok(res);
  assert.deepEqual(res.destino, { pipeline: 'definicion', fase: 'criterios', skill: 'ux' });
});

test('resolveRebotedCrossPhase: ignora destinos invalidos (downstream) y se queda con validos', () => {
  const resultados = [
    {
      resultado: 'rechazado', motivo: 'invalido downstream',
      rebote_destino: { pipeline: 'desarrollo', fase: 'entrega', skill: 'delivery' },
      file: { name: '100.android-dev' },
    },
    {
      resultado: 'rechazado', motivo: 'valido',
      rebote_destino: { pipeline: 'desarrollo', fase: 'validacion', skill: 'ux' },
      file: { name: '100.backend-dev' },
    },
  ];
  const res = pulpo.resolveRebotedCrossPhase(resultados, 'desarrollo', 'dev', CONFIG_FAKE);
  assert.ok(res);
  assert.deepEqual(res.destino, { pipeline: 'desarrollo', fase: 'validacion', skill: 'ux' });
});

test('MAX_CROSSPHASE_REBOTES es 2 (gradiente: 1 destino declarado, 2 escala, 3 humano)', () => {
  assert.equal(pulpo.MAX_CROSSPHASE_REBOTES, 2);
});
