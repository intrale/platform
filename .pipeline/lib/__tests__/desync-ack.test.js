// =============================================================================
// desync-ack.test.js — Tests del reconocimiento persistente del banner desync
// (#3617 CA-PO-3 / G-UX-2).
//
// Cubre:
//   - computeStateHash: determinístico, mismo input → mismo hash
//   - acknowledge: persiste el hash, valida shape
//   - isAcknowledged: false sin ack, true con ack matcheante, false con hash distinto
//   - clearAcknowledgement: borra el flag
//   - readAck: contenido del flag para dashboard
// =============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function setupTmp() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desync-ack-test-'));
    process.env.PIPELINE_DIR_OVERRIDE = dir;
    delete require.cache[require.resolve('../desync-ack')];
    const mod = require('../desync-ack');
    return { dir, mod };
}

function teardownTmp(dir) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    delete process.env.PIPELINE_DIR_OVERRIDE;
}

test('computeStateHash: determinístico para mismo input', () => {
    const { dir, mod } = setupTmp();
    try {
        const h1 = mod.computeStateHash({ waves_allowlist: [3559, 3605], partial_allowlist: [3605, 3559] });
        const h2 = mod.computeStateHash({ waves_allowlist: [3559, 3605], partial_allowlist: [3605, 3559] });
        assert.equal(h1, h2);
        // 64 chars hex (SHA-256).
        assert.equal(h1.length, 64);
    } finally { teardownTmp(dir); }
});

test('computeStateHash: distinto cuando los allowlists cambian', () => {
    const { dir, mod } = setupTmp();
    try {
        const h1 = mod.computeStateHash({ waves_allowlist: [3559], partial_allowlist: [3559, 3605] });
        const h2 = mod.computeStateHash({ waves_allowlist: [3559, 3605], partial_allowlist: [3559] });
        assert.notEqual(h1, h2);
    } finally { teardownTmp(dir); }
});

test('computeStateHash: invariante al orden', () => {
    const { dir, mod } = setupTmp();
    try {
        const h1 = mod.computeStateHash({ waves_allowlist: [3559, 3605, 3613], partial_allowlist: [3605, 3613, 3559] });
        const h2 = mod.computeStateHash({ waves_allowlist: [3613, 3605, 3559], partial_allowlist: [3559, 3605, 3613] });
        assert.equal(h1, h2, 'sorting interno asegura invariancia al orden');
    } finally { teardownTmp(dir); }
});

test('acknowledge: persiste hash válido', () => {
    const { dir, mod } = setupTmp();
    try {
        const hash = mod.computeStateHash({ waves_allowlist: [1], partial_allowlist: [2] });
        const res = mod.acknowledge(hash, { source: 'dashboard' });
        assert.equal(res.ok, true);
        assert.ok(fs.existsSync(path.join(dir, '.desync-acknowledged.flag')));
        const stored = JSON.parse(fs.readFileSync(path.join(dir, '.desync-acknowledged.flag'), 'utf8'));
        assert.equal(stored.hash, hash);
        assert.equal(stored.source, 'dashboard');
    } finally { teardownTmp(dir); }
});

test('acknowledge: rechaza hash inválido (no string, longitud incorrecta)', () => {
    const { dir, mod } = setupTmp();
    try {
        assert.equal(mod.acknowledge(null).ok, false);
        assert.equal(mod.acknowledge('').ok, false);
        assert.equal(mod.acknowledge('short').ok, false);
        assert.equal(mod.acknowledge('a'.repeat(63)).ok, false);
        assert.equal(mod.acknowledge('a'.repeat(65)).ok, false);
        assert.equal(mod.acknowledge(123).ok, false);
    } finally { teardownTmp(dir); }
});

test('isAcknowledged: false sin flag', () => {
    const { dir, mod } = setupTmp();
    try {
        const hash = mod.computeStateHash({ waves_allowlist: [1], partial_allowlist: [2] });
        assert.equal(mod.isAcknowledged(hash), false);
    } finally { teardownTmp(dir); }
});

test('isAcknowledged: true cuando hash matchea', () => {
    const { dir, mod } = setupTmp();
    try {
        const hash = mod.computeStateHash({ waves_allowlist: [1], partial_allowlist: [2] });
        mod.acknowledge(hash);
        assert.equal(mod.isAcknowledged(hash), true);
    } finally { teardownTmp(dir); }
});

test('isAcknowledged: false cuando hash cambia (banner reaparece)', () => {
    const { dir, mod } = setupTmp();
    try {
        const hash1 = mod.computeStateHash({ waves_allowlist: [1], partial_allowlist: [2] });
        mod.acknowledge(hash1);
        // Nueva divergencia → hash distinto.
        const hash2 = mod.computeStateHash({ waves_allowlist: [1, 2], partial_allowlist: [3] });
        assert.equal(mod.isAcknowledged(hash2), false, 'banner reaparece con hash nuevo');
    } finally { teardownTmp(dir); }
});

test('clearAcknowledgement: borra el flag', () => {
    const { dir, mod } = setupTmp();
    try {
        const hash = mod.computeStateHash({ waves_allowlist: [1], partial_allowlist: [2] });
        mod.acknowledge(hash);
        assert.equal(mod.isAcknowledged(hash), true);
        mod.clearAcknowledgement();
        assert.equal(mod.isAcknowledged(hash), false);
    } finally { teardownTmp(dir); }
});

test('readAck: null si no existe, contenido completo si existe', () => {
    const { dir, mod } = setupTmp();
    try {
        assert.equal(mod.readAck(), null);
        const hash = mod.computeStateHash({ waves_allowlist: [1], partial_allowlist: [2] });
        mod.acknowledge(hash);
        const ack = mod.readAck();
        assert.equal(ack.hash, hash);
        assert.ok(ack.acknowledged_at);
        assert.equal(typeof ack.pid, 'number');
    } finally { teardownTmp(dir); }
});
