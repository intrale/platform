'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluate } = require('../visual-report-shape-gate');

test('flag apagado devuelve disabled sin bloquear', () => {
  assert.deepEqual(evaluate(null, { flag: '0' }), { gate: 'disabled' });
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
