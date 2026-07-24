'use strict';

// Tests de process-transitions.js (EP8-H7 #3960, CA-1).
// node --test .pipeline/lib/process-transitions.test.js

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const pt = require('./process-transitions');

function tmpPipeline() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-test-'));
    fs.mkdirSync(path.join(dir, 'logs'), { recursive: true });
    return dir;
}

test('la primera observación siembra sin registrar transición', () => {
    pt.__forTestsOnly__._resetState();
    const dir = tmpPipeline();
    const rec = pt.recordSnapshot({ 'svc-drive': { alive: true } }, { pipelineDir: dir });
    assert.strictEqual(rec.length, 0, 'no debe registrar en la siembra');
    assert.ok(!fs.existsSync(pt.storePath({ pipelineDir: dir })), 'no debe crear el store todavía');
});

test('registra flanco alive->dead con motivo y lastError sanitizado', () => {
    pt.__forTestsOnly__._resetState();
    const dir = tmpPipeline();
    // siembra vivo
    pt.recordSnapshot({ 'svc-drive': { alive: true } }, { pipelineDir: dir, now: 1000 });
    // cae con un lastError que incluye un secret AWS → debe quedar redactado
    const secret = 'AKIAIOSFODNN7EXAMPLE';
    const rec = pt.recordSnapshot(
        { 'svc-drive': { alive: false } },
        {
            pipelineDir: dir,
            now: 2000,
            lastErrorFor: () => `[drive] ECONNRESET token=${secret} subiendo maestro.mp4`,
        }
    );
    assert.strictEqual(rec.length, 1);
    assert.strictEqual(rec[0].from, 'alive');
    assert.strictEqual(rec[0].to, 'dead');
    assert.strictEqual(rec[0].reason, 'ECONNRESET');
    assert.ok(!rec[0].lastError.includes(secret), 'el secret debe quedar redactado en lastError');
    assert.ok(rec[0].lastError.includes('ECONNRESET'), 'conserva el motivo legible');
});

test('no registra cuando no hay flanco (idempotente)', () => {
    pt.__forTestsOnly__._resetState();
    const dir = tmpPipeline();
    pt.recordSnapshot({ 'pulpo': { alive: true } }, { pipelineDir: dir });
    const rec = pt.recordSnapshot({ 'pulpo': { alive: true } }, { pipelineDir: dir });
    assert.strictEqual(rec.length, 0);
});

test('readTransitions agrega por motivo en ventana 7d', () => {
    pt.__forTestsOnly__._resetState();
    const dir = tmpPipeline();
    pt.recordSnapshot({ 'svc-drive': { alive: true } }, { pipelineDir: dir, now: 0 });
    // dos caídas ECONNRESET
    pt.recordSnapshot({ 'svc-drive': { alive: false } }, { pipelineDir: dir, now: 1000, lastErrorFor: () => 'ECONNRESET uno' });
    pt.recordSnapshot({ 'svc-drive': { alive: true } }, { pipelineDir: dir, now: 2000 });
    pt.recordSnapshot({ 'svc-drive': { alive: false } }, { pipelineDir: dir, now: 3000, lastErrorFor: () => 'ECONNRESET dos' });

    const res = pt.readTransitions('svc-drive', { pipelineDir: dir, now: 4000 });
    assert.strictEqual(res.downCount, 2);
    assert.deepStrictEqual(res.byReason, { ECONNRESET: 2 });
    assert.match(res.summary, /caídas 7 d: 2 \(ECONNRESET ×2\)/);
    assert.strictEqual(res.lastError, 'ECONNRESET dos');
});

test('readTransitions descarta eventos fuera de la ventana', () => {
    pt.__forTestsOnly__._resetState();
    const dir = tmpPipeline();
    const old = 0;
    const now = 8 * 24 * 3600 * 1000; // 8 días después
    pt.recordSnapshot({ 'pulpo': { alive: true } }, { pipelineDir: dir, now: old });
    pt.recordSnapshot({ 'pulpo': { alive: false } }, { pipelineDir: dir, now: old + 1000, lastErrorFor: () => 'fatal old' });
    const res = pt.readTransitions('pulpo', { pipelineDir: dir, now });
    assert.strictEqual(res.downCount, 0, 'el evento viejo (>7d) no cuenta');
    assert.match(res.summary, /caídas 7 d: 0/);
});

test('classifyReason extrae código o named error', () => {
    assert.strictEqual(pt.classifyReason('[drive] ECONNRESET algo'), 'ECONNRESET');
    assert.strictEqual(pt.classifyReason('Uncaught TypeError: x is undefined'), 'TypeError');
    assert.strictEqual(pt.classifyReason('algo raro sin codigo'), 'unknown');
    assert.strictEqual(pt.classifyReason(''), 'unknown');
});

test('readLastError lee y redacta la última línea de error del log', () => {
    pt.__forTestsOnly__._resetState();
    const dir = tmpPipeline();
    const logFile = path.join(dir, 'logs', 'svc-github.log');
    fs.writeFileSync(logFile, [
        'info: arrancando',
        'info: procesando issue 42',
        'ERROR: ETIMEDOUT password=hunter2 al consultar gh api',
        'info: reintentando',
    ].join('\n'));
    const le = pt.readLastError('svc-github', { pipelineDir: dir });
    assert.ok(le.includes('ETIMEDOUT'), 'toma la línea de error');
    assert.ok(!le.includes('hunter2'), 'redacta el password');
});
