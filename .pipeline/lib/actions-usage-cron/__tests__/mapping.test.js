// Copyright (c) 2026 Leonel Larreta
// SPDX-License-Identifier: LicenseRef-Proprietary

'use strict';

// Tests de mapping.js (#7688): mapeo viejo → nuevo de workflows.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const { buildMapping, resolve } = require('../mapping');
const { buildWeek } = require('../report');

const EVIDENCE = path.resolve(__dirname, '../../../../docs/pipeline/evidence/7594');
const readJson = (f) => JSON.parse(fs.readFileSync(path.join(EVIDENCE, f), 'utf8'));
const pricing = readJson('pricing.json');
const baseline = readJson('actions-usage-summary.json');

const LINTS = pricing.optimization_rules.find((r) => r.id === 'lints-consolidate').workflows;

function weekSummary(workflows, days = 7) {
  const total = Object.values(workflows).reduce((a, b) => a + b, 0);
  const wf = {};
  for (const [n, v] of Object.entries(workflows)) wf[n] = { billable_min: v };
  return { window: { days }, repos: { platform: { workflows: wf } }, totals: { billable_min: total } };
}

test('el fixture trae los 5 lints de la regla lints-consolidate', () => {
  assert.equal(LINTS.length, 5);
});

test('con workflow_map, los 5 lints se suman en una sola fila comparado "Lints"', () => {
  const map = Object.fromEntries(LINTS.map((l) => [l, 'Lints']));
  const mapping = buildMapping(pricing, map);
  assert.equal(mapping.size, 5);
  const week = buildWeek(weekSummary({ Lints: 100 }), baseline, mapping, pricing, null);
  const lints = week.filas.filter((r) => r.workflow === 'Lints');
  assert.equal(lints.length, 1);
  assert.equal(lints[0].estado, 'comparado');
  const baseSum = LINTS.reduce((a, l) => a + baseline.repos.platform.workflows[l].billable_min, 0);
  assert.equal(lints[0].base_min_mes, baseSum); // baseline de 30 días: ×1
  for (const l of LINTS) assert.ok(!week.filas.some((r) => r.workflow === l));
});

test('sin workflow_map salen 5 eliminado + "Lints" nuevo (no se inventa destino)', () => {
  const mapping = buildMapping(pricing, undefined);
  assert.equal(mapping.size, 0);
  const week = buildWeek(weekSummary({ Lints: 100 }), baseline, mapping, pricing, null);
  const eliminados = week.filas.filter((r) => LINTS.includes(r.workflow));
  assert.equal(eliminados.length, 5);
  assert.ok(eliminados.every((r) => r.estado === 'eliminado'));
  assert.equal(week.filas.find((r) => r.workflow === 'Lints').estado, 'nuevo');
});

test('workflow_map tiene precedencia sobre la regla y admite renombres fuera de ella', () => {
  const mapping = buildMapping(pricing, { 'Ghost Artifact Lint': 'Lints', 'PR Checks': 'PR Gate' });
  assert.equal(mapping.get('Ghost Artifact Lint'), 'Lints');
  assert.equal(mapping.get('PR Checks'), 'PR Gate');
  assert.equal(mapping.has('Test Env Lint'), false);
  assert.equal(resolve(mapping, 'PR Checks'), 'PR Gate');
  assert.equal(resolve(mapping, 'Otro'), 'Otro');
  assert.equal(resolve(null, 'Otro'), 'Otro');
});

test('valores no string y claves __proto__/constructor en workflow_map se ignoran sin contaminar', () => {
  const map = JSON.parse('{"__proto__": {"polluted": 1}, "constructor": "X", "prototype": "Y",'
    + ' "Test Env Lint": 5, "Write Target Lint": "", "": "Z", "Runtime state guard": null,'
    + ' "Ghost Artifact Lint": "Lints"}');
  const mapping = buildMapping(pricing, map);
  assert.deepEqual([...mapping.entries()], [['Ghost Artifact Lint', 'Lints']]);
  assert.equal({}.polluted, undefined);
  assert.equal(Object.prototype.polluted, undefined);
});

test('workflow_map heredado no aporta claves (sólo propias)', () => {
  const map = Object.create({ 'Ghost Artifact Lint': 'Lints' });
  assert.equal(buildMapping(pricing, map).size, 0);
  assert.equal(buildMapping(pricing, ['Lints']).size, 0);
  assert.equal(buildMapping(pricing, 'Lints').size, 0);
});

test('pricing sin optimization_rules, sin la regla o con regla rota ⇒ Map vacío sin lanzar', () => {
  const map = { 'Ghost Artifact Lint': 'Lints' };
  // Sin regla: el workflow_map igual aplica (tiene precedencia), la regla no suma nada.
  assert.deepEqual([...buildMapping({}, {}).entries()], []);
  assert.deepEqual([...buildMapping(null, undefined).entries()], []);
  assert.deepEqual([...buildMapping({ optimization_rules: 'x' }, {}).entries()], []);
  assert.deepEqual([...buildMapping({ optimization_rules: [null, { id: 'otra' }] }, {}).entries()], []);
  assert.deepEqual([...buildMapping({ optimization_rules: [{ id: 'lints-consolidate', workflows: 'x' }] }, {}).entries()], []);
  assert.deepEqual([...buildMapping({}, map).entries()], [['Ghost Artifact Lint', 'Lints']]);
});
