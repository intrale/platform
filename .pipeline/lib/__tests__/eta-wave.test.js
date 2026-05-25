// =============================================================================
// eta-wave.test.js — Tests para .pipeline/lib/eta-wave.js (#3492 / Spike #3378 H4).
//
// Cubrimos:
//   - mapSizeToCanonical: vocabulario S/M/L, fallback a M.
//   - percentile: interpolación lineal sobre array ordenado.
//   - insertSorted: orden ascendente y O(log N) busqueda.
//   - calculateIssueETA: fallback sin samples, valores razonables, inputs invalidos.
//   - calculateOlaETA: bin-packing por concurrency, items mixtos, caps defensivos.
//   - analyzeHistoricalMetrics: bySize/avgPhaseTime/rebounceRate con histórico real.
//
// Sin I/O simulado: usamos el FS real del repo (markers de .pipeline/) y el
// JSONL real (`metrics-history.jsonl`) que viven en el worktree. La cache
// interna se invalida entre tests para asegurar lecturas consistentes.
// =============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const etaWave = require('../eta-wave');
const { _internal } = etaWave;

// ─── mapSizeToCanonical ────────────────────────────────────────────────────

test('mapSizeToCanonical mapea vocabulario S/M/L con etiquetas en español', () => {
    assert.deepEqual(etaWave.mapSizeToCanonical('s'), { canonical: 'S', label: 'simple' });
    assert.deepEqual(etaWave.mapSizeToCanonical('simple'), { canonical: 'S', label: 'simple' });
    assert.deepEqual(etaWave.mapSizeToCanonical('small'), { canonical: 'S', label: 'simple' });
    assert.deepEqual(etaWave.mapSizeToCanonical('size:simple'), { canonical: 'S', label: 'simple' });

    assert.deepEqual(etaWave.mapSizeToCanonical('M'), { canonical: 'M', label: 'medio' });
    assert.deepEqual(etaWave.mapSizeToCanonical('medio'), { canonical: 'M', label: 'medio' });
    assert.deepEqual(etaWave.mapSizeToCanonical('medium'), { canonical: 'M', label: 'medio' });

    assert.deepEqual(etaWave.mapSizeToCanonical('l'), { canonical: 'L', label: 'grande' });
    assert.deepEqual(etaWave.mapSizeToCanonical('grande'), { canonical: 'L', label: 'grande' });
    assert.deepEqual(etaWave.mapSizeToCanonical('large'), { canonical: 'L', label: 'grande' });
});

test('mapSizeToCanonical normaliza espacios y mayúsculas', () => {
    assert.deepEqual(etaWave.mapSizeToCanonical('  Simple  '), { canonical: 'S', label: 'simple' });
    assert.deepEqual(etaWave.mapSizeToCanonical('GRANDE'), { canonical: 'L', label: 'grande' });
});

test('mapSizeToCanonical aplica fallback M con inputs invalidos', () => {
    assert.deepEqual(etaWave.mapSizeToCanonical(null), { canonical: 'M', label: 'medio' });
    assert.deepEqual(etaWave.mapSizeToCanonical(undefined), { canonical: 'M', label: 'medio' });
    assert.deepEqual(etaWave.mapSizeToCanonical(''), { canonical: 'M', label: 'medio' });
    assert.deepEqual(etaWave.mapSizeToCanonical('xxl'), { canonical: 'M', label: 'medio' });
    assert.deepEqual(etaWave.mapSizeToCanonical(42), { canonical: 'M', label: 'medio' });
    assert.deepEqual(etaWave.mapSizeToCanonical({ foo: 'bar' }), { canonical: 'M', label: 'medio' });
});

// ─── percentile / insertSorted ─────────────────────────────────────────────

test('percentile devuelve null en array vacío', () => {
    assert.equal(_internal.percentile([], 50), null);
});

test('percentile devuelve único valor cuando length === 1', () => {
    assert.equal(_internal.percentile([42], 50), 42);
    assert.equal(_internal.percentile([42], 90), 42);
});

test('percentile interpola linealmente entre vecinos', () => {
    const arr = [10, 20, 30, 40, 50]; // p50 = 30
    assert.equal(_internal.percentile(arr, 50), 30);
    assert.equal(_internal.percentile(arr, 0), 10);
    assert.equal(_internal.percentile(arr, 100), 50);
    // p25 = rank 1.0 → 20
    assert.equal(_internal.percentile(arr, 25), 20);
    // p75 = rank 3.0 → 40
    assert.equal(_internal.percentile(arr, 75), 40);
});

test('insertSorted mantiene orden ascendente', () => {
    const arr = [];
    _internal.insertSorted(arr, 5);
    _internal.insertSorted(arr, 1);
    _internal.insertSorted(arr, 3);
    _internal.insertSorted(arr, 2);
    _internal.insertSorted(arr, 4);
    assert.deepEqual(arr, [1, 2, 3, 4, 5]);
});

// ─── Validadores de input ──────────────────────────────────────────────────

test('isValidIssueNumber rechaza no-enteros, negativos y cero', () => {
    assert.equal(_internal.isValidIssueNumber(3492), true);
    assert.equal(_internal.isValidIssueNumber(1), true);
    assert.equal(_internal.isValidIssueNumber(0), false);
    assert.equal(_internal.isValidIssueNumber(-1), false);
    assert.equal(_internal.isValidIssueNumber(3.14), false);
    assert.equal(_internal.isValidIssueNumber('3492'), false);
    assert.equal(_internal.isValidIssueNumber(null), false);
    assert.equal(_internal.isValidIssueNumber(undefined), false);
    assert.equal(_internal.isValidIssueNumber(NaN), false);
    assert.equal(_internal.isValidIssueNumber(Infinity), false);
});

test('isValidConcurrency exige entero en [1, 50]', () => {
    assert.equal(_internal.isValidConcurrency(1), true);
    assert.equal(_internal.isValidConcurrency(3), true);
    assert.equal(_internal.isValidConcurrency(50), true);
    assert.equal(_internal.isValidConcurrency(0), false);
    assert.equal(_internal.isValidConcurrency(51), false);
    assert.equal(_internal.isValidConcurrency(-1), false);
    assert.equal(_internal.isValidConcurrency(2.5), false);
    assert.equal(_internal.isValidConcurrency('3'), false);
});

// ─── calculateIssueETA ─────────────────────────────────────────────────────

test('calculateIssueETA devuelve fallback documentado cuando no hay samples', async () => {
    _internal._invalidateAnalysisCache();
    const r = await etaWave.calculateIssueETA(99999999, 'medio');
    assert.equal(r.sizeCanonical, 'M');
    assert.equal(r.sizeLabel, 'medio');
    assert.ok(r.p50 > 0);
    assert.ok(r.p75 >= r.p50);
    assert.ok(r.p90 >= r.p75);
    assert.equal(typeof r.samples, 'number');
});

test('calculateIssueETA tolera issueNumber invalido y devuelve estimación por size', async () => {
    _internal._invalidateAnalysisCache();
    const r = await etaWave.calculateIssueETA('not-a-number', 'simple');
    assert.equal(r.sizeCanonical, 'S');
    assert.equal(r.sizeLabel, 'simple');
    assert.ok(r.p50 > 0);
});

test('calculateIssueETA con size invalido cae a M', async () => {
    _internal._invalidateAnalysisCache();
    const r = await etaWave.calculateIssueETA(3492, 'XXL');
    assert.equal(r.sizeCanonical, 'M');
    assert.equal(r.sizeLabel, 'medio');
});

// ─── calculateOlaETA ───────────────────────────────────────────────────────

test('calculateOlaETA devuelve totales 0 con lista vacía', async () => {
    _internal._invalidateAnalysisCache();
    const r = await etaWave.calculateOlaETA([], 3);
    assert.deepEqual(r, { totalP50: 0, totalP75: 0, totalP90: 0, byIssue: {}, concurrencyUsed: 3 });
});

test('calculateOlaETA aplica bin-packing por concurrency', async () => {
    _internal._invalidateAnalysisCache();
    const issueList = [
        { number: 1001, size: 'M' },
        { number: 1002, size: 'M' },
        { number: 1003, size: 'M' },
    ];
    const r1 = await etaWave.calculateOlaETA(issueList, 1);
    const r3 = await etaWave.calculateOlaETA(issueList, 3);
    assert.ok(r1.totalP50 >= r3.totalP50, `concurrency 1 (${r1.totalP50}) debería ser >= que 3 (${r3.totalP50})`);
    // Con concurrency 3 y 3 issues iguales el total debería aproximarse al ETA individual.
    assert.equal(r3.concurrencyUsed, 3);
});

test('calculateOlaETA acepta items como number o como objeto', async () => {
    _internal._invalidateAnalysisCache();
    const r = await etaWave.calculateOlaETA([1001, { number: 1002, size: 'L' }], 2);
    assert.ok(r.byIssue[1001], 'item number debe producir entrada');
    assert.ok(r.byIssue[1002], 'item objeto debe producir entrada');
    assert.equal(r.byIssue[1002].sizeCanonical, 'L');
});

test('calculateOlaETA fallback a concurrency 3 con valor invalido', async () => {
    _internal._invalidateAnalysisCache();
    const r = await etaWave.calculateOlaETA([1001], 'invalid');
    assert.equal(r.concurrencyUsed, 3);
});

test('calculateOlaETA descarta items con issueNumber invalido', async () => {
    _internal._invalidateAnalysisCache();
    const r = await etaWave.calculateOlaETA([1001, { number: 'bogus' }, null, { number: 1002 }], 3);
    assert.ok(r.byIssue[1001]);
    assert.ok(r.byIssue[1002]);
    assert.equal(Object.keys(r.byIssue).length, 2);
});

test('calculateOlaETA trunca issueList que excede el cap (anti-DoS)', async () => {
    _internal._invalidateAnalysisCache();
    const huge = [];
    for (let i = 1; i <= etaWave.ISSUE_LIST_MAX + 100; i++) huge.push({ number: i, size: 'S' });
    const r = await etaWave.calculateOlaETA(huge, 3);
    assert.ok(Object.keys(r.byIssue).length <= etaWave.ISSUE_LIST_MAX);
});

test('calculateOlaETA acepta lista no-array y devuelve estructura vacía', async () => {
    _internal._invalidateAnalysisCache();
    const r = await etaWave.calculateOlaETA(null, 3);
    assert.deepEqual(r.byIssue, {});
    assert.equal(r.totalP50, 0);
});

// ─── analyzeHistoricalMetrics ──────────────────────────────────────────────

test('analyzeHistoricalMetrics devuelve estructura completa con bySize/rebounceRate/avgPhaseTime', async () => {
    _internal._invalidateAnalysisCache();
    const stats = await etaWave.analyzeHistoricalMetrics();
    assert.ok(stats.bySize.S);
    assert.ok(stats.bySize.M);
    assert.ok(stats.bySize.L);
    for (const sz of ['S', 'M', 'L']) {
        assert.equal(typeof stats.bySize[sz].avgTime, 'number');
        assert.equal(typeof stats.bySize[sz].stddev, 'number');
        assert.equal(typeof stats.bySize[sz].samples, 'number');
    }
    assert.ok(stats.rebounceRate >= 0 && stats.rebounceRate <= 1);
    assert.equal(typeof stats.avgPhaseTime, 'object');
    assert.ok(stats._meta);
});

test('analyzeHistoricalMetrics cachea resultado dentro de la TTL', async () => {
    _internal._invalidateAnalysisCache();
    const a = await etaWave.analyzeHistoricalMetrics();
    const b = await etaWave.analyzeHistoricalMetrics();
    assert.equal(a, b, 'segunda llamada debe devolver instancia cacheada');
});

// ─── _streamMetricsHistory ─────────────────────────────────────────────────

test('_streamMetricsHistory devuelve {ok:false} si el archivo no existe', async () => {
    const prev = process.env.PIPELINE_ROOT_OVERRIDE;
    process.env.PIPELINE_ROOT_OVERRIDE = require('os').tmpdir() + '/eta-wave-test-nope-' + Date.now();
    try {
        const r = await _internal._streamMetricsHistory(() => {});
        assert.equal(r.ok, false);
        assert.equal(r.processed, 0);
    } finally {
        if (prev === undefined) delete process.env.PIPELINE_ROOT_OVERRIDE;
        else process.env.PIPELINE_ROOT_OVERRIDE = prev;
    }
});

// ─── Constantes públicas ───────────────────────────────────────────────────

test('Exporta SIZE_LABELS canónicos en español', () => {
    assert.deepEqual(etaWave.SIZE_LABELS, { S: 'simple', M: 'medio', L: 'grande' });
});

test('Exporta DEFAULT_BY_SIZE con S/M/L y valores razonables', () => {
    for (const sz of ['S', 'M', 'L']) {
        const d = etaWave.DEFAULT_BY_SIZE[sz];
        assert.ok(d.avgTime > 0);
        assert.ok(d.stddev > 0);
    }
    // Orden lógico: S < M < L
    assert.ok(etaWave.DEFAULT_BY_SIZE.S.avgTime < etaWave.DEFAULT_BY_SIZE.M.avgTime);
    assert.ok(etaWave.DEFAULT_BY_SIZE.M.avgTime < etaWave.DEFAULT_BY_SIZE.L.avgTime);
});
