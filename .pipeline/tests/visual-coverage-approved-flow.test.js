'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const ISSUE = '99957081';
const DIR = path.join(ROOT, 'qa', 'evidence', ISSUE);
const recorder = require('../lib/visual-coverage-recorder');
const { loadVisualComparison } = require('../rejection-report');

test('aprobado→rechazado persiste baseline y tipifica el desvío posterior como regresión', (t) => {
  fs.rmSync(DIR, { recursive: true, force: true });
  fs.mkdirSync(DIR, { recursive: true });
  t.after(() => fs.rmSync(DIR, { recursive: true, force: true }));

  fs.writeFileSync(path.join(DIR, 'visual-comparison.json'), JSON.stringify({
    verdict: 'approved',
    rev: 1,
    coverage: {
      secciones_declaradas: ['A', 'B'],
      verificadas: ['A', 'B'],
      no_verificadas: [],
    },
  }));

  const approved = recorder.recordApprovedCoverage({
    root: ROOT,
    issue: ISSUE,
    skill: 'qa',
    fase: 'verificacion',
    data: { resultado: 'aprobado', rebote_numero: 1 },
    baseDir: DIR,
  });
  assert.equal(approved.written, true);

  fs.writeFileSync(path.join(DIR, 'visual-comparison.json'), JSON.stringify({
    verdict: 'rejected',
    rev: 2,
    coverage: {
      secciones_declaradas: ['A', 'B'],
      verificadas: ['A', 'B'],
      no_verificadas: [],
    },
    diffs: [{ section: 'A', title: 'desvío nuevo', description: 'cambió A', impact: 'alto' }],
  }));

  const loaded = loadVisualComparison(ISSUE, path.join(DIR, 'visual-comparison.json'), 2);
  assert.ok(loaded.contract);
  assert.equal(loaded.contract.regressionBaselineRev, 1);
  assert.equal(loaded.contract.diffs[0].regressionState, 'regression');
  assert.equal(loaded.contract.diffs[0].regression, true);
});

test('no persiste aprobaciones ajenas al QA visual ni contratos de otra revisión', () => {
  assert.equal(recorder.recordApprovedCoverage({
    root: ROOT, issue: ISSUE, skill: 'tester', fase: 'verificacion', data: { resultado: 'aprobado' }, baseDir: DIR,
  }).reason, 'no-aplica');
});

test('rechaza ruidosamente un contrato aprobado que supera el tope y no escribe baseline', (t) => {
  const issue = '99957082';
  const dir = path.join(ROOT, 'qa', 'evidence', issue);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const contractPath = path.join(dir, 'visual-comparison.json');
  fs.writeFileSync(contractPath, JSON.stringify({
    verdict: 'approved', rev: 1, coverage: { verificadas: ['A'] },
    padding: 'x'.repeat(recorder.MAX_VISUAL_JSON_BYTES),
  }));
  assert.ok(fs.statSync(contractPath).size > recorder.MAX_VISUAL_JSON_BYTES);

  const errors = [];
  const originalError = console.error;
  console.error = message => errors.push(String(message));
  t.after(() => { console.error = originalError; });
  const result = recorder.recordApprovedCoverage({
    root: ROOT, issue, skill: 'qa', fase: 'verificacion',
    data: { resultado: 'aprobado', rebote_numero: 1 }, baseDir: dir,
  });

  assert.equal(result.written, false);
  assert.equal(result.reason, 'contrato-oversize');
  assert.match(result.detail, /MAX_VISUAL_JSON_BYTES/);
  assert.match(errors.join('\n'), /contrato rechazado \(contrato-oversize\)/);
  assert.equal(fs.existsSync(path.join(dir, 'visual-coverage-rev1.json')), false);
});

test('limita cantidad y tamaño de coverage.verificadas antes de escribir el baseline', (t) => {
  const issue = '99957083';
  const dir = path.join(ROOT, 'qa', 'evidence', issue);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const originalError = console.error;
  console.error = () => {};
  t.after(() => { console.error = originalError; });

  const execute = verificadas => {
    fs.writeFileSync(path.join(dir, 'visual-comparison.json'), JSON.stringify({
      verdict: 'approved', rev: 1, coverage: { verificadas },
    }));
    return recorder.recordApprovedCoverage({
      root: ROOT, issue, skill: 'qa', fase: 'verificacion',
      data: { resultado: 'aprobado', rebote_numero: 1 }, baseDir: dir,
    });
  };

  assert.equal(execute(Array.from({ length: recorder.MAX_VISUAL_COVERAGE_SECTIONS + 1 }, (_, i) => `S${i}`)).reason, 'cobertura-oversize');
  assert.equal(execute(['x'.repeat(recorder.MAX_VISUAL_SECTION_BYTES + 1)]).reason, 'seccion-oversize');
  assert.equal(fs.existsSync(path.join(dir, 'visual-coverage-rev1.json')), false);
});
