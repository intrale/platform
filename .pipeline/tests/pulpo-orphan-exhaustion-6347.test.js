'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.PULPO_NO_AUTOSTART = '1';

const { synthesizeOrphanExhaustion } = require('../pulpo');
const { classifySkill } = require('../lib/stuck-phase-detector');
const { classifyRebote } = require('../lib/rebote-classifier');

test('huérfano agotado conserva datos y declara procedencia de infraestructura', () => {
  const result = synthesizeOrphanExhaustion({
    issue: 6347,
    fase: 'aprobacion',
    pipeline: 'desarrollo',
  }, 3);

  assert.equal(result.issue, 6347);
  assert.equal(result.resultado, 'rechazado');
  assert.match(result.motivo, /Huérfano tras 3 reintentos/);
  assert.equal(result.veredicto_sintetizado_por, 'pulpo');
  assert.equal(result.agente_exit_code, -1);
  assert.equal(result.rebote_categoria, 'infra_agent_crash');
});

test('huérfano agotado se clasifica como infra y no consume rebote de código', () => {
  const yaml = synthesizeOrphanExhaustion({ issue: 6347 }, 3);
  const skill = classifySkill('po', [
    { skill: 'po', state: 'listo', yaml, mtimeMs: Date.now() },
  ], new Set());
  const rebote = classifyRebote({
    motivo: yaml.motivo,
    rebote_categoria: yaml.rebote_categoria,
    veredictoSintetizadoPorPulpo: yaml.veredicto_sintetizado_por === 'pulpo',
  });

  assert.equal(skill.status, 'infra-failed');
  assert.equal(skill.exitCode, -1);
  assert.equal(rebote.category, 'infra');
  assert.equal(rebote.counts_against_circuit_breaker, false);
});
