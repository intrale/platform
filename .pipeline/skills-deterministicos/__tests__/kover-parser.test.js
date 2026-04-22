// Tests unitarios de .pipeline/skills-deterministicos/lib/kover-parser.js (issue #2482)
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const {
    parseKoverXml,
    parseTestResultsXml,
    aggregateKover,
    aggregateTestResults,
    renderCoverageSection,
    renderTestsSection,
    percent,
} = require('../lib/kover-parser');

const FIX = path.join(__dirname, 'fixtures');
const readFix = (name) => fs.readFileSync(path.join(FIX, name), 'utf8');

// ── percent() ──────────────────────────────────────────────────────

test('percent — covered/total correcto con 2 decimales', () => {
    assert.equal(percent(77, 23), 77); // 77/100
    assert.equal(percent(10, 3), 76.92); // 10/13
    assert.equal(percent(0, 0), 0); // div by zero
});

// ── parseKoverXml ──────────────────────────────────────────────────

test('parseKoverXml — string vacio o invalido devuelve valid=false', () => {
    assert.equal(parseKoverXml('').valid, false);
    assert.equal(parseKoverXml('not xml').valid, false);
    assert.equal(parseKoverXml(null).valid, false);
});

test('parseKoverXml — fixture backend: totales correctos', () => {
    const xml = readFix('kover-backend.xml');
    const r = parseKoverXml(xml);
    assert.equal(r.valid, true);
    // LINE: missed=3, covered=10 → 10/13 = 76.92%
    assert.equal(r.total.line.covered, 10);
    assert.equal(r.total.line.missed, 3);
    assert.equal(r.total.line.percent, 76.92);
    // BRANCH: missed=1, covered=3 → 3/4 = 75%
    assert.equal(r.total.branch.covered, 3);
    assert.equal(r.total.branch.percent, 75);
    // INSTRUCTION: missed=12, covered=38 → 38/50 = 76%
    assert.equal(r.total.instruction.percent, 76);
    // CLASS: 0 missed, 3 covered
    assert.equal(r.total.class.covered, 3);
    assert.equal(r.total.class.percent, 100);
});

test('parseKoverXml — fixture backend: lista de paquetes con porcentaje por paquete', () => {
    const xml = readFix('kover-backend.xml');
    const r = parseKoverXml(xml);
    assert.equal(r.packages.length, 2);
    const core = r.packages.find((p) => p.name === 'ar/com/intrale/core');
    assert.ok(core);
    assert.equal(core.line_percent, 100); // 8/8
    const api = r.packages.find((p) => p.name === 'ar/com/intrale/api');
    assert.ok(api);
    assert.equal(api.line_percent, 40); // 2/5
});

test('parseKoverXml — reporte sin paquetes es valido pero con totales en 0', () => {
    const empty = '<?xml version="1.0"?><report name="empty"></report>';
    const r = parseKoverXml(empty);
    assert.equal(r.valid, true);
    assert.equal(r.packages.length, 0);
    assert.equal(r.total.line.percent, 0);
});

// ── aggregateKover ─────────────────────────────────────────────────

test('aggregateKover — suma counters de varios reportes', () => {
    const r1 = parseKoverXml(readFix('kover-backend.xml'));
    const r2 = parseKoverXml(readFix('kover-backend.xml')); // duplicar para simular 2 modulos
    const agg = aggregateKover([r1, r2]);
    assert.equal(agg.valid, true);
    assert.equal(agg.total.line.covered, r1.total.line.covered * 2);
    assert.equal(agg.total.line.missed, r1.total.line.missed * 2);
    assert.equal(agg.total.line.percent, r1.total.line.percent); // ratio igual
});

test('aggregateKover — ignora reportes invalidos', () => {
    const r1 = parseKoverXml(readFix('kover-backend.xml'));
    const agg = aggregateKover([r1, null, { valid: false }]);
    assert.equal(agg.valid, true);
    assert.equal(agg.total.line.covered, r1.total.line.covered);
});

test('aggregateKover — array vacio → valid=false', () => {
    const agg = aggregateKover([]);
    assert.equal(agg.valid, false);
});

// ── parseTestResultsXml ────────────────────────────────────────────

test('parseTestResultsXml — fixture success: 5 tests, 0 fallos', () => {
    const r = parseTestResultsXml(readFix('junit-success.xml'));
    assert.equal(r.valid, true);
    assert.equal(r.tests, 5);
    assert.equal(r.failures, 0);
    assert.equal(r.errors, 0);
    assert.equal(r.skipped, 0);
    assert.equal(r.suite, 'ar.com.intrale.SessionTest');
    assert.equal(r.time_seconds, 1.234);
    assert.equal(r.failed_tests.length, 0);
});

test('parseTestResultsXml — fixture failed: 4 tests, 2 failures con mensaje', () => {
    const r = parseTestResultsXml(readFix('junit-failed.xml'));
    assert.equal(r.valid, true);
    assert.equal(r.tests, 4);
    assert.equal(r.failures, 2);
    assert.equal(r.failed_tests.length, 2);
    const first = r.failed_tests[0];
    assert.equal(first.type, 'failure');
    assert.equal(first.classname, 'ar.com.intrale.UserControllerTest');
    assert.match(first.name, /list rechaza/);
    assert.match(first.message, /expected: NotFound/);
});

test('parseTestResultsXml — XML malformado devuelve valid=false', () => {
    assert.equal(parseTestResultsXml('<nope/>').valid, false);
    assert.equal(parseTestResultsXml('').valid, false);
});

// ── aggregateTestResults ───────────────────────────────────────────

test('aggregateTestResults — suma contadores de varias suites', () => {
    const s = parseTestResultsXml(readFix('junit-success.xml'));
    const f = parseTestResultsXml(readFix('junit-failed.xml'));
    const agg = aggregateTestResults([s, f]);
    assert.equal(agg.valid, true);
    assert.equal(agg.tests, 9);        // 5 + 4
    assert.equal(agg.failures, 2);
    assert.equal(agg.suites, 2);
    assert.equal(agg.failed_tests.length, 2);
    assert.ok(agg.time_seconds > 3.5);
});

// ── renderCoverageSection ──────────────────────────────────────────

test('renderCoverageSection — marca OK cuando linePct >= threshold', () => {
    const kv = aggregateKover([parseKoverXml(readFix('kover-backend.xml'))]);
    const md = renderCoverageSection(kv, 70); // umbral bajo, 76.92 >= 70
    assert.match(md, /Líneas: 76\.92% ✅/);
    assert.match(md, /Ramas: 75%/);
});

test('renderCoverageSection — marca FAIL cuando linePct < threshold', () => {
    const kv = aggregateKover([parseKoverXml(readFix('kover-backend.xml'))]);
    const md = renderCoverageSection(kv, 80); // umbral estricto, 76.92 < 80
    assert.match(md, /Líneas: 76\.92% ❌/);
    assert.match(md, /Paquetes bajo umbral/);
    assert.match(md, /intrale\/api/); // el paquete con 40% aparece
});

test('renderCoverageSection — sin kover valido → mensaje de "sin reporte"', () => {
    const md = renderCoverageSection({ valid: false, total: {}, packages: [] });
    assert.match(md, /Sin reporte Kover/);
});

// ── renderTestsSection ─────────────────────────────────────────────

test('renderTestsSection — todos pasaron → verdict ✅', () => {
    const s = parseTestResultsXml(readFix('junit-success.xml'));
    const agg = aggregateTestResults([s]);
    const md = renderTestsSection(agg);
    assert.match(md, /Total: 5/);
    assert.match(md, /Fallaron: 0/);
    assert.match(md, /✅/);
});

test('renderTestsSection — con fallos → lista los tests fallidos con mensaje', () => {
    const f = parseTestResultsXml(readFix('junit-failed.xml'));
    const agg = aggregateTestResults([f]);
    const md = renderTestsSection(agg);
    assert.match(md, /Fallaron: 2/);
    assert.match(md, /UserControllerTest/);
    assert.match(md, /expected: NotFound/);
    assert.match(md, /❌/);
});

test('renderTestsSection — sin reporte valido → skip message', () => {
    const md = renderTestsSection({ valid: false, failed_tests: [] });
    assert.match(md, /No se encontraron reportes JUnit/);
});
