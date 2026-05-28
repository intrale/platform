// =============================================================================
// desync-detector.test.js — Tests de lib/desync-detector.js (issue #3518 CA-6).
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function setupTmp() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desync-test-'));
    process.env.PIPELINE_DIR_OVERRIDE = dir;
    delete require.cache[require.resolve('../desync-detector')];
    delete require.cache[require.resolve('../notify-telegram')];
    const mod = require('../desync-detector');
    return { dir, mod };
}

function teardownTmp(dir) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    delete process.env.PIPELINE_DIR_OVERRIDE;
}

function writeWaves(dir, activeIssues) {
    fs.writeFileSync(path.join(dir, 'waves.json'), JSON.stringify({
        version: '1.0',
        meta: { updated_at: new Date().toISOString(), updated_by: 't', source: 't' },
        active_wave: {
            number: 1,
            name: 'test',
            issues: activeIssues,
        },
        planned_waves: [],
        archived_waves: [],
        dependencies: [],
    }));
}

function writePartial(dir, allowedIssues) {
    fs.writeFileSync(path.join(dir, '.partial-pause.json'), JSON.stringify({
        allowed_issues: allowedIssues,
        created_at: new Date().toISOString(),
        source: 't',
    }));
}

test('detectDesync: estado inicial vacío → no desync', () => {
    const { dir, mod } = setupTmp();
    try {
        const res = mod.detectDesync({ skipAlert: true });
        assert.equal(res.desync, false);
    } finally { teardownTmp(dir); }
});

test('detectDesync: solo partial-pause (sin waves.json) → no desync', () => {
    const { dir, mod } = setupTmp();
    try {
        writePartial(dir, [100, 200]);
        const res = mod.detectDesync({ skipAlert: true });
        assert.equal(res.desync, false);
        assert.equal(res.reason, 'no_waves_yet');
    } finally { teardownTmp(dir); }
});

test('detectDesync: solo waves.json (sin partial-pause) → no desync', () => {
    const { dir, mod } = setupTmp();
    try {
        writeWaves(dir, [{ number: 100 }, { number: 200 }]);
        const res = mod.detectDesync({ skipAlert: true });
        assert.equal(res.desync, false);
        assert.equal(res.reason, 'no_partial_pause');
    } finally { teardownTmp(dir); }
});

test('detectDesync: allowlists iguales → no desync', () => {
    const { dir, mod } = setupTmp();
    try {
        writeWaves(dir, [{ number: 100 }, { number: 200 }]);
        writePartial(dir, [100, 200]);
        const res = mod.detectDesync({ skipAlert: true });
        assert.equal(res.desync, false);
        assert.deepEqual(res.added, []);
        assert.deepEqual(res.removed, []);
    } finally { teardownTmp(dir); }
});

test('detectDesync: allowlists distintas → desync + flag + alerta', () => {
    const { dir, mod } = setupTmp();
    try {
        writeWaves(dir, [{ number: 100 }, { number: 200 }, { number: 300 }]);
        writePartial(dir, [100, 999]);
        const res = mod.detectDesync({ skipAlert: false });
        assert.equal(res.desync, true);
        assert.equal(res.reason, 'allowlist_mismatch');
        assert.deepEqual(res.waves_allowlist.sort((a, b) => a - b), [100, 200, 300]);
        assert.deepEqual(res.partial_allowlist.sort((a, b) => a - b), [100, 999]);
        // Flag creado.
        assert.ok(res.flag_path);
        assert.equal(fs.existsSync(res.flag_path), true);
        assert.equal(mod.isDesyncFlagSet(), true);
        // Alerta disparada (drop en cola Telegram).
        const alertDir = path.join(dir, 'servicios', 'telegram', 'pendiente');
        assert.equal(fs.existsSync(alertDir), true);
        const files = fs.readdirSync(alertDir);
        assert.ok(files.some((f) => f.startsWith('alert-waves-desync-')), `esperaba alert en ${files.join(',')}`);
    } finally { teardownTmp(dir); }
});

test('detectDesync: filtra issues con status=completed en waves.json', () => {
    const { dir, mod } = setupTmp();
    try {
        writeWaves(dir, [
            { number: 100, status: 'in_progress' },
            { number: 200, status: 'completed' }, // excluido
            { number: 300 },
        ]);
        writePartial(dir, [100, 300]);
        const res = mod.detectDesync({ skipAlert: true });
        assert.equal(res.desync, false, '200 está completed, no debe contar');
    } finally { teardownTmp(dir); }
});

test('detectDesync: skipFlag y skipAlert no tocan FS', () => {
    const { dir, mod } = setupTmp();
    try {
        writeWaves(dir, [{ number: 100 }]);
        writePartial(dir, [999]);
        const res = mod.detectDesync({ skipFlag: true, skipAlert: true });
        assert.equal(res.desync, true);
        assert.equal(res.flag_path, undefined);
        assert.equal(mod.isDesyncFlagSet(), false);
        const alertDir = path.join(dir, 'servicios', 'telegram', 'pendiente');
        assert.equal(fs.existsSync(alertDir), false);
    } finally { teardownTmp(dir); }
});

test('clearDesyncFlag elimina el flag de bloqueo', () => {
    const { dir, mod } = setupTmp();
    try {
        writeWaves(dir, [{ number: 100 }]);
        writePartial(dir, [999]);
        mod.detectDesync({ skipAlert: true });
        assert.equal(mod.isDesyncFlagSet(), true);
        mod.clearDesyncFlag();
        assert.equal(mod.isDesyncFlagSet(), false);
    } finally { teardownTmp(dir); }
});

test('detectDesync NO auto-repara (política security #7)', () => {
    const { dir, mod } = setupTmp();
    try {
        writeWaves(dir, [{ number: 100 }, { number: 200 }]);
        writePartial(dir, [999]);
        // Snapshot ANTES.
        const wavesBefore = fs.readFileSync(path.join(dir, 'waves.json'), 'utf8');
        const partialBefore = fs.readFileSync(path.join(dir, '.partial-pause.json'), 'utf8');
        mod.detectDesync({ skipAlert: true });
        // Los archivos no cambian.
        assert.equal(fs.readFileSync(path.join(dir, 'waves.json'), 'utf8'), wavesBefore);
        assert.equal(fs.readFileSync(path.join(dir, '.partial-pause.json'), 'utf8'), partialBefore);
    } finally { teardownTmp(dir); }
});

test('diffAllowlists: added/removed correctos', () => {
    const { dir, mod } = setupTmp();
    try {
        const { added, removed } = mod._internal.diffAllowlists([1, 2, 3], [2, 3, 4]);
        assert.deepEqual(added, [4]);
        assert.deepEqual(removed, [1]);
    } finally { teardownTmp(dir); }
});

test('detectDesync: waves.json con active_wave:null → no_waves_yet (#3518 fix)', () => {
    const { dir, mod } = setupTmp();
    try {
        // Estado inicial/legacy: waves.json existe pero sin ola promovida.
        // partial-pause tiene allowlist seteado manualmente. NO es desync.
        fs.writeFileSync(path.join(dir, 'waves.json'), JSON.stringify({
            version: '1.0',
            meta: { updated_at: new Date().toISOString() },
            active_wave: null,
            planned_waves: [],
            archived_waves: [],
        }));
        writePartial(dir, [3518, 3541, 3577]);
        const res = mod.detectDesync({ skipAlert: true });
        assert.equal(res.desync, false, 'active_wave:null debe tratarse como no_waves_yet');
        assert.equal(res.reason, 'no_waves_yet');
        assert.equal(mod.isDesyncFlagSet(), false);
    } finally { teardownTmp(dir); }
});

test('detectDesync: waves.json corrupto → no es desync (reason no_waves_yet)', () => {
    const { dir, mod } = setupTmp();
    try {
        fs.writeFileSync(path.join(dir, 'waves.json'), '{ corrupto');
        writePartial(dir, [100]);
        const res = mod.detectDesync({ skipAlert: true });
        // El detector no puede leer waves → trata como "no canonical yet"
        // (no es su rol diagnosticar corrupción; eso lo hace loadStateStrict).
        assert.equal(res.desync, false);
        assert.equal(res.reason, 'no_waves_yet');
    } finally { teardownTmp(dir); }
});
