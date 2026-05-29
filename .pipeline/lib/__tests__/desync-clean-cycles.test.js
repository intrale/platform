// =============================================================================
// desync-clean-cycles.test.js — Tests del counter de ciclos limpios para
// gating PR2 (#3617 REQ-SEC-6 / CA-PO-6).
//
// Cubre:
//   - recordCleanCycle incrementa con nuevo hash
//   - recordCleanCycle es no-op con hash duplicado (mismo tick)
//   - recordDirtyCycle resetea a 0
//   - readCounter retorna estado actual con shape completa
//   - threshold ≥3 marca ready_for_pr2 indirectamente vía count
// =============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function setupTmp() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clean-cycles-test-'));
    process.env.PIPELINE_DIR_OVERRIDE = dir;
    delete require.cache[require.resolve('../desync-clean-cycles')];
    const mod = require('../desync-clean-cycles');
    return { dir, mod };
}

function teardownTmp(dir) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    delete process.env.PIPELINE_DIR_OVERRIDE;
}

test('readCounter: estado inicial (sin archivo) → count=0', () => {
    const { dir, mod } = setupTmp();
    try {
        const c = mod.readCounter();
        assert.equal(c.count, 0);
        assert.equal(c.last_tick_at, null);
    } finally { teardownTmp(dir); }
});

test('recordCleanCycle: incrementa con hash nuevo', () => {
    const { dir, mod } = setupTmp();
    try {
        const r1 = mod.recordCleanCycle('hash-A');
        assert.equal(r1.count, 1);
        assert.equal(r1.action, 'inc');
        const r2 = mod.recordCleanCycle('hash-B');
        assert.equal(r2.count, 2);
        assert.equal(r2.action, 'inc');
        const r3 = mod.recordCleanCycle('hash-C');
        assert.equal(r3.count, 3);
    } finally { teardownTmp(dir); }
});

test('recordCleanCycle: no-op con hash duplicado (mismo tick)', () => {
    const { dir, mod } = setupTmp();
    try {
        mod.recordCleanCycle('hash-X');
        const r2 = mod.recordCleanCycle('hash-X');
        assert.equal(r2.count, 1, 'mismo hash → no incrementa');
        assert.equal(r2.action, 'duplicate');
    } finally { teardownTmp(dir); }
});

test('recordDirtyCycle: resetea a 0', () => {
    const { dir, mod } = setupTmp();
    try {
        mod.recordCleanCycle('h1');
        mod.recordCleanCycle('h2');
        mod.recordCleanCycle('h3');
        const c1 = mod.readCounter();
        assert.equal(c1.count, 3);
        const r = mod.recordDirtyCycle();
        assert.equal(r.count, 0);
        const c2 = mod.readCounter();
        assert.equal(c2.count, 0);
        assert.equal(c2.last_state_hash, null);
    } finally { teardownTmp(dir); }
});

test('recordDirtyCycle: no-op desde 0 (ya estaba en dirty)', () => {
    const { dir, mod } = setupTmp();
    try {
        const r = mod.recordDirtyCycle();
        assert.equal(r.count, 0);
        // Sin error, no incrementa nada.
    } finally { teardownTmp(dir); }
});

test('readCounter: persiste history con últimos eventos', () => {
    const { dir, mod } = setupTmp();
    try {
        mod.recordCleanCycle('a');
        mod.recordCleanCycle('b');
        mod.recordDirtyCycle();
        mod.recordCleanCycle('c');
        const c = mod.readCounter();
        assert.ok(Array.isArray(c.history));
        assert.ok(c.history.length >= 4);
        const actions = c.history.map(h => h.action);
        assert.ok(actions.includes('inc'));
        assert.ok(actions.includes('reset'));
    } finally { teardownTmp(dir); }
});

test('resetCounter: vuelve al default', () => {
    const { dir, mod } = setupTmp();
    try {
        mod.recordCleanCycle('h');
        mod.recordCleanCycle('h2');
        mod.resetCounter();
        const c = mod.readCounter();
        assert.equal(c.count, 0);
        assert.deepEqual(c.history, []);
    } finally { teardownTmp(dir); }
});

test('threshold ≥3: ciclos limpios suficientes para PR2', () => {
    const { dir, mod } = setupTmp();
    try {
        mod.recordCleanCycle('boot-1');
        mod.recordCleanCycle('boot-2');
        const c1 = mod.readCounter();
        assert.ok(c1.count < 3, 'aún no ready');
        mod.recordCleanCycle('boot-3');
        const c2 = mod.readCounter();
        assert.ok(c2.count >= 3, 'count >= 3 → ready_for_pr2 en dashboard');
    } finally { teardownTmp(dir); }
});
