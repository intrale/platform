// #5708 / CA-11 — `regression` es DERIVADO por código, nunca declarativo.
// El campo venía escrito por el agente de QA (texto de un LLM) y mentía por
// construcción: nadie escribía ni leía el artefacto que lo sostiene.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const store = require('../lib/visual-coverage-store');

const ROOT = path.resolve(__dirname, '..', '..');
// Issue de prueba fuera del rango real, bajo `qa/evidence/` (el store confina
// ahí y rechaza cualquier baseDir de afuera).
const ISSUE = '999001';
const BASE_DIR = path.join(ROOT, 'qa', 'evidence', ISSUE);

function limpiar() {
  fs.rmSync(BASE_DIR, { recursive: true, force: true });
}

test.beforeEach(limpiar);
test.after(limpiar);

test('sin pasada previa registrada, ningún diff puede quedar como regresión', () => {
  const diffs = [{ section: 'A' }, { section: 'B' }];
  // CA-21 · UX-17 — y tampoco como «no es regresión»: sin línea base no hay
  // nada que tipificar. Colapsar los dos casos en `false` afirmaba una
  // verificación que nunca ocurrió.
  assert.deepEqual(store.deriveRegressions({ issue: ISSUE, rev: 3, diffs, baseDir: BASE_DIR }), ['no-baseline', 'no-baseline']);
  const informe = store.deriveRegressionReport({ issue: ISSUE, rev: 3, diffs, baseDir: BASE_DIR });
  assert.equal(informe.baselineRev, null);
});

test('sección verificada y sin hallazgos en la pasada previa ⇒ regresión', () => {
  store.writeCoverage({
    issue: ISSUE, rev: 2, baseDir: BASE_DIR,
    coverage: { secciones_declaradas: ['A', 'B'], verificadas: ['A', 'B'] },
    diffs: [{ section: 'B' }],
  });
  const diffs = [{ section: 'A' }, { section: 'B' }];
  // A quedó sin hallazgos en rev2 ⇒ el desvío nuevo en A es regresión.
  // B ya tenía un hallazgo en rev2 ⇒ no es regresión, es el mismo desvío.
  assert.deepEqual(store.deriveRegressions({ issue: ISSUE, rev: 3, diffs, baseDir: BASE_DIR }), ['regression', 'not-regression']);
  // El chip necesita saber CONTRA QUÉ pasada se comparó para poder decirlo.
  assert.equal(store.deriveRegressionReport({ issue: ISSUE, rev: 3, diffs, baseDir: BASE_DIR }).baselineRev, 2);
});

test('sección NO verificada en la pasada previa ⇒ barrido incompleto, no regresión', () => {
  store.writeCoverage({
    issue: ISSUE, rev: 2, baseDir: BASE_DIR,
    coverage: { secciones_declaradas: ['A', 'B'], verificadas: ['A'] },
    diffs: [],
  });
  const diffs = [{ section: 'B' }];
  // Hay línea base, y B no estaba verificada: hallazgo tardío por barrido
  // incompleto. Distinto de «sin línea base», que no tipifica nada.
  assert.deepEqual(store.deriveRegressions({ issue: ISSUE, rev: 3, diffs, baseDir: BASE_DIR }), ['not-regression']);
});

test('toma la pasada previa más cercana, ignorando la actual y las posteriores', () => {
  store.writeCoverage({
    issue: ISSUE, rev: 1, baseDir: BASE_DIR,
    coverage: { verificadas: ['A'] }, diffs: [],
  });
  store.writeCoverage({
    issue: ISSUE, rev: 2, baseDir: BASE_DIR,
    coverage: { verificadas: ['A'] }, diffs: [{ section: 'A' }],
  });
  store.writeCoverage({
    issue: ISSUE, rev: 5, baseDir: BASE_DIR,
    coverage: { verificadas: ['A'] }, diffs: [],
  });
  const prev = store.readPreviousCoverage({ issue: ISSUE, rev: 3, baseDir: BASE_DIR });
  assert.equal(prev.rev, 2);
  // En rev2 la sección A tuvo hallazgo ⇒ no es regresión en rev3.
  assert.deepEqual(store.deriveRegressions({ issue: ISSUE, rev: 3, diffs: [{ section: 'A' }], baseDir: BASE_DIR }), ['not-regression']);
});

test('writeCoverage persiste sólo secciones — nunca imágenes ni base64', () => {
  const res = store.writeCoverage({
    issue: ISSUE, rev: 4, baseDir: BASE_DIR,
    coverage: { secciones_declaradas: ['A', 'B'], verificadas: ['A', 'B'] },
    diffs: [{ section: 'B', title: 'x' }],
  });
  assert.equal(res.written, true);
  const raw = fs.readFileSync(res.path, 'utf8');
  assert.equal(raw.includes('data:image'), false);
  assert.equal(raw.includes('base64'), false);
  const parsed = JSON.parse(raw);
  assert.deepEqual(Object.keys(parsed).sort(), ['issue', 'rev', 'sin_hallazgos', 'verificadas']);
  assert.deepEqual(parsed.verificadas, ['A', 'B']);
  assert.deepEqual(parsed.sin_hallazgos, ['A']);
  assert.equal(path.basename(res.path), 'visual-coverage-rev4.json');
});

test('el path queda confinado a qa/evidence: un baseDir de afuera se rechaza', () => {
  assert.equal(store.coveragePathFor('no-numérico', 1), null);
  assert.equal(store.coveragePathFor(ISSUE, 1, path.join(ROOT, '.pipeline')), null);
  assert.equal(store.coveragePathFor(ISSUE, 1, path.resolve(ROOT, '..')), null);
  const res = store.writeCoverage({ issue: ISSUE, rev: 1, baseDir: path.join(ROOT, '.pipeline'), coverage: {}, diffs: [] });
  assert.equal(res.written, false);
  assert.equal(res.reason, 'path-invalido');
});

test('writeCoverage rechaza un junction intermedio que escapa de qa/evidence', (t) => {
  const outside = fs.mkdtempSync(path.join(ROOT, '.tmp-store-outside-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.mkdirSync(path.dirname(BASE_DIR), { recursive: true });
  fs.symlinkSync(outside, BASE_DIR, process.platform === 'win32' ? 'junction' : 'dir');

  const result = store.writeCoverage({
    issue: ISSUE, rev: 1, baseDir: BASE_DIR,
    coverage: { verificadas: ['A'] }, diffs: [],
  });
  assert.equal(result.written, false);
  assert.equal(result.reason, 'path-invalido');
  assert.equal(fs.existsSync(path.join(outside, 'visual-coverage-rev1.json')), false);
});

test('el `regression` declarado en el contrato se descarta: manda el store', () => {
  const { loadVisualComparison } = require('../rejection-report');
  const contrato = {
    issue: ISSUE, rev: 3, verdict: 'rejected',
    mockup: { src: 'm.png' }, delivery: { src: 'd.png' },
    coverage: { secciones_declaradas: ['A'], verificadas: ['A'], no_verificadas: [] },
    // El agente declara regresión sin ninguna pasada previa registrada.
    diffs: [{ section: 'A', title: 'x', impact: 'alto', regression: true }],
  };
  fs.mkdirSync(BASE_DIR, { recursive: true });
  const target = path.join(BASE_DIR, 'visual-comparison.json');
  fs.writeFileSync(target, JSON.stringify(contrato), 'utf8');
  const { contract, skip } = loadVisualComparison(ISSUE, target, 3);
  assert.equal(skip, null);
  assert.equal(contract.diffs[0].regression, false);
  // CA-21 — y no se degrada a «no es regresión»: sin store previo el estado
  // real es «sin línea base», que es un falso negativo ESTRUCTURAL declarado.
  assert.equal(contract.diffs[0].regressionState, 'no-baseline');
  assert.equal(contract.regressionBaselineRev, null);
});
