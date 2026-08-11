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
