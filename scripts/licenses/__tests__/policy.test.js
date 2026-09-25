// Copyright (c) 2026 Leonel Larreta
// SPDX-License-Identifier: LicenseRef-Proprietary

// Tests del evaluador de política (#7592 · CA-3 · CA-4 · CA-5 · CA-7 casos 1, 2, 4 y 5).
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');

const { evaluate, validateException, staticCategory, activeExceptions } = require('../policy');
const { formatFinding } = require('../cli');
const { basePolicy } = require('./_fixture-repo');

const NOW = new Date('2026-09-23T12:00:00Z');

function entry(coordinate, version, expression, extra = {}) {
  return {
    ecosystem: 'npm',
    coordinate,
    version,
    declared: expression || '',
    expression,
    unknownReason: expression ? null : 'sin licencia declarada',
    unmapped: [],
    scope: 'distribuido',
    origins: ['package-lock.json'],
    url: null,
    ...extra,
  };
}

function exception(overrides = {}) {
  return {
    paquete: 'gpl-lib@2.0.0',
    licencia: 'GPL-3.0-only',
    justificacion: 'Sólo se usa en un script interno que no se distribuye',
    aprobado_por: 'leitolarreta',
    revisar_antes: '2026-12-31',
    ...overrides,
  };
}

test('caso 1: una dependencia con licencia permitida pasa sin hallazgos', () => {
  const r = evaluate([entry('left-pad', '1.3.0', 'MIT')], basePolicy(), { now: NOW });
  assert.deepEqual(r.findings, []);
  assert.equal(r.results[0].status, 'allowed');
  assert.deepEqual(r.results[0].verdict.obligaciones, ['atribución en NOTICE']);
});

test('caso 2: una licencia prohibida falla con dependencia@versión, licencia, regla y motivo', () => {
  const r = evaluate([entry('gpl-lib', '2.0.0', 'GPL-3.0-only')], basePolicy(), { now: NOW });
  assert.equal(r.findings.length, 1);
  const f = r.findings[0];
  assert.equal(f.type, 'LICENCIA PROHIBIDA');
  const line = formatFinding(f);
  assert.match(line, /^LICENCIA PROHIBIDA: gpl-lib@2\.0\.0 — GPL-3\.0-only — regla denied\[gpl\] — copyleft fuerte: obliga a abrir código propio/);
  assert.match(line, /→ Reemplazá la dependencia o pedí una excepción \(docs\/legal\/licencias-terceros\.md#excepciones\)/);
});

test('caso 3: sin licencia declarada o con un id fuera de la política ⇒ desconocida y falla', () => {
  const r = evaluate([
    entry('sin-lic', '1.0.0', null),
    entry('rara', '1.0.0', 'LicenseRef-Propietaria'),
  ], basePolicy(), { now: NOW });
  assert.deepEqual(r.findings.map((f) => f.type), ['LICENCIA DESCONOCIDA', 'LICENCIA DESCONOCIDA']);
  assert.match(formatFinding(r.findings[1]), /no figura en allowed, allowed_with_obligation ni denied/);
});

test('caso 5: MIT OR GPL-3.0-only pasa y MIT AND GPL-3.0-only falla', () => {
  const pasa = evaluate([entry('dual', '1.0.0', 'MIT OR GPL-3.0-only')], basePolicy(), { now: NOW });
  assert.deepEqual(pasa.findings, []);
  assert.equal(pasa.results[0].status, 'allowed');

  const falla = evaluate([entry('ambas', '1.0.0', 'MIT AND GPL-3.0-only')], basePolicy(), { now: NOW });
  assert.equal(falla.findings.length, 1);
  assert.equal(falla.findings[0].type, 'LICENCIA PROHIBIDA');
});

test('OR con una alternativa desconocida y otra prohibida no pasa', () => {
  const r = evaluate([entry('x', '1.0.0', 'LicenseRef-Rara OR GPL-2.0-only')], basePolicy(), { now: NOW });
  assert.equal(r.findings.length, 1);
});

test('WITH se evalúa explícitamente: listado en with_exceptions usa esa categoría', () => {
  const policy = basePolicy({
    with_exceptions: [{
      expresion: 'GPL-2.0-only WITH Classpath-exception-2.0',
      categoria: 'allowed_with_obligation',
      obligacion: 'conservar la excepción Classpath',
      motivo: 'la excepción Classpath permite enlazar sin contagiar',
    }],
  });
  const ok = evaluate([entry('jdk-lib', '1.0.0', 'GPL-2.0-only WITH Classpath-exception-2.0')], policy, { now: NOW });
  assert.deepEqual(ok.findings, []);
  assert.equal(ok.results[0].status, 'obligation');
});

test('WITH no listado vale lo que vale la licencia base (nunca relaja una prohibida)', () => {
  const denied = evaluate([entry('a', '1.0.0', 'GPL-2.0-only WITH Classpath-exception-2.0')], basePolicy(), { now: NOW });
  assert.equal(denied.findings[0].type, 'LICENCIA PROHIBIDA');
  const allowed = evaluate([entry('b', '1.0.0', 'Apache-2.0 WITH LLVM-exception')], basePolicy(), { now: NOW });
  assert.deepEqual(allowed.findings, []);
});

test('denied gana aunque el id también figure en allowed', () => {
  const policy = basePolicy();
  policy.allowed.push({ id: 'GPL-3.0-only' });
  const r = evaluate([entry('gpl', '1.0.0', 'GPL-3.0-only')], policy, { now: NOW });
  assert.equal(r.findings[0].type, 'LICENCIA PROHIBIDA');
});

test('LGPL queda como permitida con obligación y no hace fallar', () => {
  const r = evaluate([entry('logback', '1.5.18', 'EPL-1.0 OR LGPL-2.1-only')], basePolicy(), { now: NOW });
  // EPL-1.0 no está en la política de fixture: la mejor alternativa es LGPL (con obligación).
  assert.deepEqual(r.findings, []);
  assert.equal(r.results[0].status, 'obligation');
  assert.deepEqual(r.results[0].verdict.obligaciones, ['publicar cambios a la librería']);
});

test('caso 4: una excepción vigente cubre la dependencia y el gate pasa', () => {
  const policy = basePolicy({ exceptions: [exception()] });
  const r = evaluate([entry('gpl-lib', '2.0.0', 'GPL-3.0-only')], policy, { now: NOW });
  assert.deepEqual(r.findings, []);
  assert.equal(r.results[0].status, 'exception');
});

test('caso 4: una excepción vencida falla el gate (no alcanza con advertir)', () => {
  const policy = basePolicy({ exceptions: [exception({ revisar_antes: '2026-09-01' })] });
  const r = evaluate([entry('gpl-lib', '2.0.0', 'GPL-3.0-only')], policy, { now: NOW });
  assert.equal(r.findings.length, 1);
  assert.equal(r.findings[0].type, 'EXCEPCIÓN VENCIDA');
  assert.match(formatFinding(r.findings[0]), /revisar_antes 2026-09-01 \(hace 22 día\(s\)\)/);
  assert.equal(r.results[0].status, 'denied');
});

test('la excepción vale hasta el final del día de revisar_antes (UTC)', () => {
  const policy = basePolicy({ exceptions: [exception({ revisar_antes: '2026-09-23' })] });
  const ultimoDia = evaluate([entry('gpl-lib', '2.0.0', 'GPL-3.0-only')], policy, { now: new Date('2026-09-23T23:59:59Z') });
  assert.deepEqual(ultimoDia.findings, []);
  const alOtroDia = evaluate([entry('gpl-lib', '2.0.0', 'GPL-3.0-only')], policy, { now: new Date('2026-09-24T00:00:00Z') });
  assert.equal(alOtroDia.findings[0].type, 'EXCEPCIÓN VENCIDA');
});

test('caso 4: excepción sin justificación o con fecha inválida es inválida y falla', () => {
  for (const bad of [
    exception({ justificacion: '   ' }),
    exception({ justificacion: undefined }),
    exception({ revisar_antes: '31/12/2026' }),
    exception({ revisar_antes: '2026-02-30' }),
    exception({ aprobado_por: '' }),
  ]) {
    const check = validateException(bad, NOW);
    assert.equal(check.valid, false, JSON.stringify(bad));
    const r = evaluate([entry('gpl-lib', '2.0.0', 'GPL-3.0-only')], basePolicy({ exceptions: [bad] }), { now: NOW });
    assert.ok(r.findings.some((f) => f.type === 'EXCEPCIÓN INVÁLIDA'), `debería ser inválida: ${JSON.stringify(bad)}`);
    assert.notEqual(r.results[0].status, 'exception');
  }
});

test('una fecha que no parsea se trata además como vencida', () => {
  const check = validateException(exception({ revisar_antes: 'pronto' }), NOW);
  assert.equal(check.valid, false);
  assert.equal(check.expired, true);
});

test('comodines o rangos en paquete@versión invalidan la excepción', () => {
  for (const paquete of ['gpl-lib@*', 'gpl-*@2.0.0', 'gpl-lib@^2.0.0', 'gpl-lib@2.x', 'gpl-lib@>=2', 'gpl-lib', 'gpl-lib@']) {
    const check = validateException(exception({ paquete }), NOW);
    assert.equal(check.valid, false, paquete);
  }
  // Paquetes npm con scope y coordenadas Gradle sí son válidos.
  assert.equal(validateException(exception({ paquete: '@scope/pkg@1.2.3' }), NOW).valid, true);
  assert.equal(validateException(exception({ paquete: 'org.example:lib@1.2.3-RC1' }), NOW).valid, true);
});

test('si sube la versión o cambia la licencia, la excepción deja de aplicar', () => {
  const policy = basePolicy({ exceptions: [exception()] });
  const otraVersion = evaluate([entry('gpl-lib', '2.0.1', 'GPL-3.0-only')], policy, { now: NOW });
  assert.ok(otraVersion.findings.some((f) => f.type === 'LICENCIA PROHIBIDA'));
  assert.ok(otraVersion.warnings.some((w) => w.type === 'EXCEPCIÓN SIN USO'));
  const otraLicencia = evaluate([entry('gpl-lib', '2.0.0', 'AGPL-3.0-only')], policy, { now: NOW });
  assert.ok(otraLicencia.findings.some((f) => f.type === 'LICENCIA PROHIBIDA' && f.rule === 'denied[agpl]'));
});

test('la categoría estática del reporte no depende de la fecha', () => {
  const policy = basePolicy({ exceptions: [exception({ revisar_antes: '2020-01-01' })] });
  const cat = staticCategory(entry('gpl-lib', '2.0.0', 'GPL-3.0-only'), policy);
  assert.equal(cat.category, 'exception');
});

test('excepciones vigentes ordenadas por revisar_antes y marcadas si vencen en ≤30 días', () => {
  const policy = basePolicy({
    exceptions: [
      exception({ paquete: 'b@1.0.0', revisar_antes: '2027-06-01' }),
      exception({ paquete: 'a@1.0.0', revisar_antes: '2026-10-10' }),
      exception({ paquete: 'vieja@1.0.0', revisar_antes: '2026-01-01' }),
    ],
  });
  const active = activeExceptions(policy, NOW);
  assert.deepEqual(active.map((x) => x.paquete), ['a@1.0.0', 'b@1.0.0']);
  assert.equal(active[0].vence_pronto, true);
  assert.equal(active[1].vence_pronto, false);
});

test('la política real declara las decisiones D2 (prohibidas, permitidas y con obligación)', () => {
  const real = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', '..', 'config', 'licenses', 'policy.json'), 'utf8'));
  const probe = (expr) => evaluate([entry('p', '1.0.0', expr)], real, { now: NOW }).results[0].status;
  for (const id of ['GPL-2.0-only', 'GPL-3.0-or-later', 'AGPL-3.0-only', 'SSPL-1.0']) assert.equal(probe(id), 'denied', id);
  for (const id of ['MIT', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'ISC', '0BSD', 'Python-2.0']) assert.equal(probe(id), 'allowed', id);
  for (const id of ['LGPL-2.1-only', 'LGPL-3.0-only', 'MPL-2.0', 'EPL-1.0', 'EPL-2.0']) assert.equal(probe(id), 'obligation', id);
  assert.equal(probe('LGPL-2.1-or-later'), 'obligation', 'LGPL no puede caer en el prefijo GPL-');
  for (const d of real.denied) assert.ok(d.motivo && d.motivo.length > 10, `denied[${d.regla}] sin motivo`);
});
