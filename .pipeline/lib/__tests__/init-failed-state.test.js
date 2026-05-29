// =============================================================================
// init-failed-state.test.js — Tests del flag persistente init-failed (#3617).
//
// Cubre:
//   - setInitFailed → archivo con shape esperada (ts, pid, hostname, reason)
//   - clearInitFailed → archivo eliminado
//   - isInitFailedSet → bool correcto en cada estado
//   - readInitFailed → null si no existe, contenido si existe, fallback si corrupto
// =============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function setupTmp() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'init-failed-test-'));
    process.env.PIPELINE_DIR_OVERRIDE = dir;
    delete require.cache[require.resolve('../init-failed-state')];
    const mod = require('../init-failed-state');
    return { dir, mod };
}

function teardownTmp(dir) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    delete process.env.PIPELINE_DIR_OVERRIDE;
}

test('setInitFailed: escribe el flag con shape esperada', () => {
    const { dir, mod } = setupTmp();
    try {
        const res = mod.setInitFailed({
            reason: 'shape inválida',
            errors: ['allowed_issues ausente'],
            source_sha256: 'abc123',
        });
        assert.equal(res.ok, true);
        assert.ok(fs.existsSync(path.join(dir, '.init-failed.flag')));
        const data = JSON.parse(fs.readFileSync(path.join(dir, '.init-failed.flag'), 'utf8'));
        assert.equal(data.reason, 'shape inválida');
        assert.deepEqual(data.errors, ['allowed_issues ausente']);
        assert.equal(data.source_sha256, 'abc123');
        assert.equal(typeof data.pid, 'number');
        assert.equal(typeof data.hostname, 'string');
        assert.ok(data.ts && /^\d{4}-\d{2}-\d{2}T/.test(data.ts));
    } finally { teardownTmp(dir); }
});

test('isInitFailedSet: false sin flag, true con flag', () => {
    const { dir, mod } = setupTmp();
    try {
        assert.equal(mod.isInitFailedSet(), false);
        mod.setInitFailed({ reason: 'test' });
        assert.equal(mod.isInitFailedSet(), true);
    } finally { teardownTmp(dir); }
});

test('clearInitFailed: borra el flag', () => {
    const { dir, mod } = setupTmp();
    try {
        mod.setInitFailed({ reason: 'test' });
        assert.equal(mod.isInitFailedSet(), true);
        mod.clearInitFailed();
        assert.equal(mod.isInitFailedSet(), false);
    } finally { teardownTmp(dir); }
});

test('clearInitFailed: no-op si no existe', () => {
    const { dir, mod } = setupTmp();
    try {
        // No tira aunque no exista.
        mod.clearInitFailed();
        assert.equal(mod.isInitFailedSet(), false);
    } finally { teardownTmp(dir); }
});

test('readInitFailed: null si no existe', () => {
    const { dir, mod } = setupTmp();
    try {
        assert.equal(mod.readInitFailed(), null);
    } finally { teardownTmp(dir); }
});

test('readInitFailed: devuelve contenido si existe', () => {
    const { dir, mod } = setupTmp();
    try {
        mod.setInitFailed({ reason: 'parsed correctly', errors: ['e1', 'e2'] });
        const data = mod.readInitFailed();
        assert.equal(data.reason, 'parsed correctly');
        assert.deepEqual(data.errors, ['e1', 'e2']);
    } finally { teardownTmp(dir); }
});

test('readInitFailed: fail-closed fallback si corrupto', () => {
    const { dir, mod } = setupTmp();
    try {
        fs.writeFileSync(path.join(dir, '.init-failed.flag'), '{ not json');
        const data = mod.readInitFailed();
        // Fail-closed: el flag existe pero corrupto → devolvemos un objeto
        // mínimo en lugar de null, para que el dashboard muestre banner igual.
        assert.ok(data);
        assert.equal(data.reason, 'flag presente pero corrupto');
    } finally { teardownTmp(dir); }
});
