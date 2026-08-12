'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const gate = require('../visual-report-shape-gate');
const { evaluate } = gate;
const limits = require('../../lib/visual-contract-limits');
const rejectionReport = require('../../rejection-report');

test('flag apagado devuelve disabled sin bloquear', () => {
  assert.deepEqual(evaluate(null, { flag: '0' }), { gate: 'disabled' });
});

// #5708 / CA-13 — el default REAL de producción no es '0', es la ausencia de la
// variable. Sin este caso, el rollout gradual quedaba sin cobertura.
test('flag ausente (default real de producción) devuelve disabled', () => {
  assert.deepEqual(evaluate(null, { flag: undefined }), { gate: 'disabled' });
  const previo = process.env[gate.FLAG_ENV_NAME];
  delete process.env[gate.FLAG_ENV_NAME];
  try {
    assert.deepEqual(evaluate({ coverage: { secciones_declaradas: ['A'] } }, {}), { gate: 'disabled' });
  } finally {
    if (previo !== undefined) process.env[gate.FLAG_ENV_NAME] = previo;
  }
});

test('input malformado bloquea sin lanzar excepción', () => {
  for (const value of [null, undefined, 'json inválido']) {
    assert.deepEqual(evaluate(value, { flag: '1' }), { gate: 'block', reason: 'report-malformed' });
  }
});

test('reporte sin cobertura bloquea por forma', () => {
  assert.deepEqual(evaluate({ diffs: [{}] }, { flag: '1' }), { gate: 'block', reason: 'coverage-missing' });
});

test('cobertura incompleta informa secciones faltantes', () => {
  assert.deepEqual(evaluate({ coverage: { secciones_declaradas: ['A', 'B'], verificadas: ['A'] } }, { flag: '1' }), { gate: 'block', reason: 'coverage-incomplete', missing: ['B'] });
});

test('un solo diff con cobertura completa es válido', () => {
  const report = { coverage: { secciones_declaradas: ['A', 'B'], verificadas: ['A'], no_verificadas: [{ section: 'B', motivo: 'requiere datos de negocio' }] }, diffs: [{ section: 'A' }] };
  assert.deepEqual(evaluate(report, { flag: '1' }), { gate: 'ok' });
});

// #5708 / CA-13 — el tope de desvíos se USA, no sólo se exporta. Antes
// `MAX_DIFFS` estaba declarado en este módulo con cero referencias en evaluate().
test('supera el tope de desvíos y bloquea con diffs-over-limit', () => {
  const diffs = Array.from({ length: limits.MAX_DIFFS_RENDER + 1 }, (_, i) => ({ section: 'A', title: `d${i}` }));
  const report = { coverage: { secciones_declaradas: ['A'], verificadas: ['A'], no_verificadas: [] }, diffs };
  const out = evaluate(report, { flag: '1' });
  assert.equal(out.gate, 'block');
  assert.equal(out.reason, 'diffs-over-limit');
  assert.match(out.missing[0], new RegExp(`${limits.MAX_DIFFS_RENDER + 1} > ${limits.MAX_DIFFS_RENDER}`));
});

test('justo en el tope de desvíos NO bloquea', () => {
  const diffs = Array.from({ length: limits.MAX_DIFFS_RENDER }, (_, i) => ({ section: 'A', title: `d${i}` }));
  const report = { coverage: { secciones_declaradas: ['A'], verificadas: ['A'], no_verificadas: [] }, diffs };
  assert.deepEqual(evaluate(report, { flag: '1' }), { gate: 'ok' });
});

// #5708 / CA-13 — una sola fuente de verdad: si alguien vuelve a declarar el
// tope aparte, este test se pone rojo.
test('los topes del gate y del rejection-report salen del mismo módulo', () => {
  assert.equal(gate.MAX_VISUAL_JSON_BYTES, limits.MAX_VISUAL_JSON_BYTES);
  assert.equal(gate.MAX_DIFFS_RENDER, limits.MAX_DIFFS_RENDER);
  assert.equal(rejectionReport.MAX_VISUAL_JSON_BYTES, limits.MAX_VISUAL_JSON_BYTES);
  assert.equal(rejectionReport.MAX_DIFFS_RENDER, limits.MAX_DIFFS_RENDER);
});
