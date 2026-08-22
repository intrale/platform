'use strict';

// Tests de reconciler-history.js (EP8-H7 #3960, CA-4).
// node --test .pipeline/lib/reconciler-history.test.js

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const rh = require('./reconciler-history');

function tmpPipeline() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'rh-test-'));
}

test('recordSnapshot persiste total y byReason normalizados', () => {
    const dir = tmpPipeline();
    const rec = rh.recordSnapshot({ total: 147, by_reason: { duplicado: 91, timeout: 41, 'validación': 15 } }, { pipelineDir: dir, now: 1000 });
    assert.ok(rec);
    assert.strictEqual(rec.total, 147);
    assert.deepStrictEqual(rec.byReason, { duplicado: 91, timeout: 41, 'validación': 15 });
});

test('debounce: no persiste dos veces dentro del minInterval', () => {
    const dir = tmpPipeline();
    const a = rh.recordSnapshot({ total: 10, by_reason: { x: 10 } }, { pipelineDir: dir, now: 0, minIntervalMs: 3600000 });
    const b = rh.recordSnapshot({ total: 20, by_reason: { x: 20 } }, { pipelineDir: dir, now: 1000, minIntervalMs: 3600000 });
    assert.ok(a);
    assert.strictEqual(b, null, 'segundo snapshot debounceado');
    // pasado el intervalo sí persiste
    const c = rh.recordSnapshot({ total: 30, by_reason: { x: 30 } }, { pipelineDir: dir, now: 3600001, minIntervalMs: 3600000 });
    assert.ok(c);
    assert.strictEqual(c.total, 30);
});

test('total se deriva del breakdown si no viene', () => {
    const dir = tmpPipeline();
    const rec = rh.recordSnapshot({ by_reason: { a: 5, b: 7 } }, { pipelineDir: dir });
    assert.strictEqual(rec.total, 12);
});

test('readSeries devuelve puntos ordenados y filtra fuera de ventana', () => {
    const dir = tmpPipeline();
    const day = 24 * 3600 * 1000;
    rh.recordSnapshot({ total: 1, by_reason: {} }, { pipelineDir: dir, now: 0, minIntervalMs: 0 });
    rh.recordSnapshot({ total: 2, by_reason: {} }, { pipelineDir: dir, now: 2 * day, minIntervalMs: 0 });
    rh.recordSnapshot({ total: 3, by_reason: {} }, { pipelineDir: dir, now: 6 * day, minIntervalMs: 0 });
    // viejo (>7d desde now=8d): 0d queda fuera
    const series = rh.readSeries({ pipelineDir: dir, now: 8 * day });
    assert.deepStrictEqual(series.totals, [2, 3], 'el punto de 0d queda fuera de la ventana 7d');
    assert.strictEqual(series.windowDays, 7);
});

test('readSeries vacío si no hay archivo', () => {
    const dir = tmpPipeline();
    const series = rh.readSeries({ pipelineDir: dir });
    assert.deepStrictEqual(series.points, []);
    assert.deepStrictEqual(series.totals, []);
});

test('valores inválidos en breakdown se descartan', () => {
    const dir = tmpPipeline();
    const rec = rh.recordSnapshot({ total: 5, by_reason: { ok: 3, malo: -1, raro: NaN, str: 'x' } }, { pipelineDir: dir });
    assert.deepStrictEqual(rec.byReason, { ok: 3 });
});
