'use strict';

// Tests de matrix-history.js (EP8-H6 #3959, CA-2). Clon de reconciler-history:
// snapshot horario debounceado de matrixCounts + baseline ≈24h para la flecha
// de tendencia por celda.
// node --test .pipeline/lib/__tests__/matrix-history.test.js

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const mh = require('../matrix-history');

function tmpPipeline() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'mh-test-'));
}

const CELL = { 'desarrollo/dev': { 'backend-dev': 3, 'android-dev': 1 }, 'definicion/criterios': { po: 2 } };

test('recordSnapshot persiste counts normalizados y total derivado', () => {
    const dir = tmpPipeline();
    const rec = mh.recordSnapshot(CELL, { pipelineDir: dir, now: 1000 });
    assert.ok(rec);
    assert.strictEqual(rec.total, 6); // 3+1+2
    assert.deepStrictEqual(rec.counts, CELL);
});

test('normalización: descarta valores no positivos/no finitos y celdas vacías', () => {
    const dir = tmpPipeline();
    const rec = mh.recordSnapshot({
        'desarrollo/dev': { 'backend-dev': 2, ux: 0, qa: -1, perf: 'x' },
        'desarrollo/build': { build: NaN },   // celda queda vacía → se descarta
    }, { pipelineDir: dir, now: 1000 });
    assert.deepStrictEqual(rec.counts, { 'desarrollo/dev': { 'backend-dev': 2 } });
    assert.strictEqual(rec.total, 2);
});

test('debounce: no persiste dos veces dentro del minInterval', () => {
    const dir = tmpPipeline();
    const a = mh.recordSnapshot(CELL, { pipelineDir: dir, now: 0, minIntervalMs: 3600000 });
    const b = mh.recordSnapshot(CELL, { pipelineDir: dir, now: 1000, minIntervalMs: 3600000 });
    assert.ok(a);
    assert.strictEqual(b, null, 'segundo snapshot debounceado (~1/hora)');
    const c = mh.recordSnapshot(CELL, { pipelineDir: dir, now: 3600001, minIntervalMs: 3600000 });
    assert.ok(c, 'pasado el intervalo sí persiste');
});

test('readSeries devuelve puntos ordenados por ts y filtra fuera de ventana', () => {
    const dir = tmpPipeline();
    const day = 24 * 3600 * 1000;
    mh.recordSnapshot({ a: { x: 1 } }, { pipelineDir: dir, now: 0, minIntervalMs: 0 });
    mh.recordSnapshot({ a: { x: 2 } }, { pipelineDir: dir, now: 2 * day, minIntervalMs: 0 });
    mh.recordSnapshot({ a: { x: 3 } }, { pipelineDir: dir, now: 6 * day, minIntervalMs: 0 });
    const series = mh.readSeries({ pipelineDir: dir, now: 8 * day });
    assert.deepStrictEqual(series.totals, [2, 3], 'el punto de 0d queda fuera de la ventana 7d');
    assert.strictEqual(series.windowDays, 7);
});

test('readSeries vacío si no hay archivo (FS-fail no tira)', () => {
    const dir = path.join(os.tmpdir(), 'mh-noexiste-' + process.pid);
    const series = mh.readSeries({ pipelineDir: dir });
    assert.deepStrictEqual(series.points, []);
    assert.deepStrictEqual(series.totals, []);
});

test('recordSnapshot no tira si el FS falla (best-effort)', () => {
    // pipelineDir apuntando a un archivo (no dir) → mkdir/append fallan.
    const dir = tmpPipeline();
    const fileAsDir = path.join(dir, 'soy-un-archivo');
    fs.writeFileSync(fileAsDir, 'x');
    const rec = mh.recordSnapshot(CELL, { pipelineDir: path.join(fileAsDir, 'sub'), now: 1 });
    assert.strictEqual(rec, null, 'devuelve null en vez de tirar');
});

test('baselineCounts devuelve el snapshot más cercano a 24h dentro de tolerancia', () => {
    const dir = tmpPipeline();
    const hour = 3600 * 1000;
    const now = 100 * hour;
    // snapshot a ~24h atrás (76h) y otro reciente (98h).
    mh.recordSnapshot({ 'desarrollo/dev': { 'backend-dev': 5 } }, { pipelineDir: dir, now: now - 24 * hour, minIntervalMs: 0 });
    mh.recordSnapshot({ 'desarrollo/dev': { 'backend-dev': 9 } }, { pipelineDir: dir, now: now - 1 * hour, minIntervalMs: 0 });
    const base = mh.baselineCounts({ pipelineDir: dir, now });
    assert.deepStrictEqual(base, { 'desarrollo/dev': { 'backend-dev': 5 } }, 'usa el de ≈24h, no el reciente');
});

test('baselineCounts null si no hay snapshot dentro de la tolerancia', () => {
    const dir = tmpPipeline();
    const hour = 3600 * 1000;
    const now = 100 * hour;
    // único snapshot muy reciente (2h atrás) → fuera de la ventana 24h±6h.
    mh.recordSnapshot({ a: { x: 1 } }, { pipelineDir: dir, now: now - 2 * hour, minIntervalMs: 0 });
    assert.strictEqual(mh.baselineCounts({ pipelineDir: dir, now }), null);
});

test('keys de fase/skill van como contenido JSON, nunca como nombre de archivo', () => {
    const dir = tmpPipeline();
    // key maliciosa con path traversal: NO debe crear archivos fuera del store.
    mh.recordSnapshot({ '../../etc/passwd': { '../evil': 2 } }, { pipelineDir: dir, now: 1, minIntervalMs: 0 });
    const files = fs.readdirSync(dir);
    assert.deepStrictEqual(files, ['matrix-history.jsonl'], 'único archivo persistido');
    // la key se sanitiza (sin saltos de línea, acotada) y queda como contenido.
    const raw = fs.readFileSync(path.join(dir, 'matrix-history.jsonl'), 'utf8');
    assert.ok(raw.includes('etc/passwd'), 'la key viaja como dato JSON');
});
