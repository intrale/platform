// Copyright (c) 2026 Leonel Larreta
// SPDX-License-Identifier: LicenseRef-Proprietary

// Tests del parser SPDX y la tabla de alias (#7592 · CA-4 · CA-7 caso 3).
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');

const { buildAliasIndex, normalizeLicense, parseExpression, toString } = require('../spdx');

const REAL_POLICY = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', '..', 'config', 'licenses', 'policy.json'), 'utf8'));
const realAliases = buildAliasIndex(REAL_POLICY.aliases);

test('sin licencia declarada (vacía, espacios, null, array) se trata como desconocida', () => {
  for (const declared of ['', '   ', undefined, null, ['MIT', 'ISC'], 42]) {
    const r = normalizeLicense(declared, realAliases);
    assert.equal(r.ast.kind, 'unknown', `debería ser desconocida: ${JSON.stringify(declared)}`);
    assert.equal(r.expression, null);
  }
});

test('UNLICENSED, NOASSERTION, NONE y SEE LICENSE IN son desconocidas, con motivo', () => {
  for (const declared of ['UNLICENSED', 'unlicensed', 'NOASSERTION', 'NONE', 'SEE LICENSE IN LICENSE.txt', 'See license in ./EULA']) {
    const r = normalizeLicense(declared, realAliases);
    assert.equal(r.ast.kind, 'unknown', declared);
    assert.ok(r.ast.reason && r.ast.reason.length > 5, `falta motivo para ${declared}`);
  }
});

test('Unlicense (dominio público) no se confunde con UNLICENSED', () => {
  const r = normalizeLicense('Unlicense', realAliases);
  assert.equal(r.ast.kind, 'license');
  assert.equal(r.expression, 'Unlicense');
});

test('expresiones que no parsean son desconocidas', () => {
  for (const expr of ['MIT AND', '(MIT', 'MIT OR OR ISC', 'MIT)', 'AND MIT', 'MIT WITH', '(MIT OR ISC) WITH X', 'MIT, ISC', 'MIT/ISC']) {
    const ast = parseExpression(expr);
    assert.equal(ast.kind, 'unknown', `debería fallar: ${expr}`);
  }
});

test('precedencia SPDX: WITH > AND > OR, con paréntesis', () => {
  const ast = parseExpression('MIT OR Apache-2.0 AND BSD-3-Clause');
  assert.equal(ast.kind, 'or');
  assert.equal(ast.args[1].kind, 'and');
  const grouped = parseExpression('(MIT OR Apache-2.0) AND BSD-3-Clause');
  assert.equal(grouped.kind, 'and');
  assert.equal(toString(grouped), '(MIT OR Apache-2.0) AND BSD-3-Clause');
  const w = parseExpression('GPL-2.0-only WITH Classpath-exception-2.0 OR MIT');
  assert.equal(w.kind, 'or');
  assert.deepEqual(w.args[0], { kind: 'with', license: 'GPL-2.0-only', exception: 'Classpath-exception-2.0' });
});

test('los operadores en minúscula se aceptan y se canonizan', () => {
  const r = normalizeLicense('(MIT or Apache-2.0)', realAliases);
  assert.equal(r.expression, 'MIT OR Apache-2.0');
});

test('tabla de alias: nombres y URLs conocidas mapean a SPDX', () => {
  const cases = {
    'Apache 2.0': 'Apache-2.0',
    'ASL 2.0': 'Apache-2.0',
    'The Apache Software License, Version 2.0': 'Apache-2.0',
    'apache license, version 2.0': 'Apache-2.0',
    'https://aws.amazon.com/apache2.0': 'Apache-2.0',
    'http://aws.amazon.com/apache2.0/': 'Apache-2.0',
    'The MIT License (MIT)': 'MIT',
    'https://opensource.org/license/mit': 'MIT',
  };
  for (const [declared, expected] of Object.entries(cases)) {
    assert.equal(normalizeLicense(declared, realAliases).expression, expected, declared);
  }
});

test('un nombre sin alias ni forma SPDX no mapea y queda desconocido', () => {
  const r = normalizeLicense('Licencia de la casa, versión 3', realAliases);
  assert.equal(r.ast.kind, 'unknown');
});

test('todos los destinos de la tabla de alias parsean como SPDX', () => {
  for (const [from, to] of Object.entries(REAL_POLICY.aliases)) {
    assert.notEqual(parseExpression(to).kind, 'unknown', `alias ${from} → ${to} no parsea`);
  }
});

test('formato legacy de package.json {type, url} usa el type', () => {
  const r = normalizeLicense({ type: 'MIT', url: 'https://x' }, realAliases);
  assert.equal(r.expression, 'MIT');
});
