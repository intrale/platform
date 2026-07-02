// =============================================================================
// waves-api-domain.test.js — Tests del dominio nuevo de la API de gestión de
// olas (#4372, Ola 8.3): `editWave`, `removeIssueFromWave` y el soporte de
// concurrencia optimista (If-Match / expectedVersion) en create/add.
//
// Aislamiento: cada test arranca con su propio PIPELINE_DIR (PIPELINE_DIR_OVERRIDE)
// — mismo patrón que create-planned-wave.test.js.
//
// Ejecutar:  node --test .pipeline/lib/__tests__/waves-api-domain.test.js
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function setupTmp() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'waves-api-domain-'));
    process.env.PIPELINE_DIR_OVERRIDE = dir;
    delete require.cache[require.resolve('../waves')];
    const waves = require('../waves');
    waves.invalidateCache();
    return { dir, waves };
}

function teardownTmp(dir) {
    delete process.env.PIPELINE_DIR_OVERRIDE;
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
}

function readWaves(dir) {
    return JSON.parse(fs.readFileSync(path.join(dir, 'waves.json'), 'utf8'));
}

function expectThrowCode(fn, code) {
    try { fn(); } catch (e) { return e.code === code; }
    return false;
}

// --- editWave -----------------------------------------------------------------

test('editWave: happy path edita name/goal/window/concurrency de una planificada y devuelve version', () => {
    const { dir, waves } = setupTmp();
    try {
        const created = waves.createPlannedWave({ name: 'Ola A', issues: [1, 2], concurrency_max: 2, window_minutes: 30 }, {});
        const r = waves.editWave(created.waveNumber, { name: 'Ola A (rev)', goal: 'nuevo objetivo', window_minutes: 120, concurrency_max: 5 }, {});
        assert.equal(r.wave.name, 'Ola A (rev)');
        assert.equal(r.wave.goal, 'nuevo objetivo');
        assert.equal(r.wave.window_minutes, 120);
        assert.equal(r.wave.concurrency_max, 5);
        assert.ok(typeof r.version === 'string' && r.version.length > 0);
        const st = readWaves(dir);
        assert.equal(st.planned_waves[0].name, 'Ola A (rev)');
        // Los issues no se tocan.
        assert.deepEqual(st.planned_waves[0].issues.map((i) => i.number), [1, 2]);
    } finally { teardownTmp(dir); }
});

test('editWave: 404 (EWAVES_NOT_FOUND) si la ola planificada no existe', () => {
    const { dir, waves } = setupTmp();
    try {
        waves.createPlannedWave({ name: 'X', issues: [1], concurrency_max: 1, window_minutes: 10 }, {});
        assert.ok(expectThrowCode(() => waves.editWave(999, { name: 'Y' }, {}), 'EWAVES_NOT_FOUND'));
    } finally { teardownTmp(dir); }
});

test('editWave: bounds fuera de rango → EWAVES_BOUNDS; patch vacío → EWAVES_SHAPE', () => {
    const { dir, waves } = setupTmp();
    try {
        const c = waves.createPlannedWave({ name: 'B', issues: [1], concurrency_max: 1, window_minutes: 10 }, {});
        assert.ok(expectThrowCode(() => waves.editWave(c.waveNumber, { window_minutes: 99999 }, {}), 'EWAVES_BOUNDS'));
        assert.ok(expectThrowCode(() => waves.editWave(c.waveNumber, { concurrency_max: 999 }, {}), 'EWAVES_BOUNDS'));
        assert.ok(expectThrowCode(() => waves.editWave(c.waveNumber, {}, {}), 'EWAVES_SHAPE'));
        assert.ok(expectThrowCode(() => waves.editWave(c.waveNumber, { name: '   ' }, {}), 'EWAVES_SHAPE'));
    } finally { teardownTmp(dir); }
});

test('editWave: nombre duplicado con otra ola → EWAVES_DUPLICATE_NAME', () => {
    const { dir, waves } = setupTmp();
    try {
        waves.createPlannedWave({ name: 'Uno', issues: [1], concurrency_max: 1, window_minutes: 10 }, {});
        const dos = waves.createPlannedWave({ name: 'Dos', issues: [2], concurrency_max: 1, window_minutes: 10 }, {});
        assert.ok(expectThrowCode(() => waves.editWave(dos.waveNumber, { name: 'uno' }, {}), 'EWAVES_DUPLICATE_NAME'));
    } finally { teardownTmp(dir); }
});

test('editWave: renombrarse con su propio nombre no dispara duplicado', () => {
    const { dir, waves } = setupTmp();
    try {
        const c = waves.createPlannedWave({ name: 'Mismo', issues: [1], concurrency_max: 1, window_minutes: 10 }, {});
        assert.doesNotThrow(() => waves.editWave(c.waveNumber, { name: 'Mismo', goal: 'g' }, {}));
    } finally { teardownTmp(dir); }
});

test('editWave: If-Match mismatch → EWAVES_VERSION_CONFLICT y NO escribe', () => {
    const { dir, waves } = setupTmp();
    try {
        const c = waves.createPlannedWave({ name: 'Ver', issues: [1], concurrency_max: 1, window_minutes: 10 }, {});
        const before = fs.readFileSync(path.join(dir, 'waves.json'), 'utf8');
        let err = null;
        try {
            waves.editWave(c.waveNumber, { name: 'Nuevo' }, { expectedVersion: 'versión-vieja-que-no-coincide' });
        } catch (e) { err = e; }
        assert.ok(err && err.code === 'EWAVES_VERSION_CONFLICT');
        assert.ok(err.currentVersion, 'el error debe traer la versión vigente para el 409');
        // No se escribió nada.
        assert.equal(fs.readFileSync(path.join(dir, 'waves.json'), 'utf8'), before);
    } finally { teardownTmp(dir); }
});

test('editWave: If-Match correcto (versión vigente) aplica el cambio', () => {
    const { dir, waves } = setupTmp();
    try {
        const c = waves.createPlannedWave({ name: 'OK', issues: [1], concurrency_max: 1, window_minutes: 10 }, {});
        const version = waves.getVersion();
        const r = waves.editWave(c.waveNumber, { window_minutes: 45 }, { expectedVersion: version });
        assert.equal(r.wave.window_minutes, 45);
    } finally { teardownTmp(dir); }
});

// --- removeIssueFromWave ------------------------------------------------------

test('removeIssueFromWave: happy path quita el issue y persiste (removed:true)', () => {
    const { dir, waves } = setupTmp();
    try {
        const c = waves.createPlannedWave({ name: 'R', issues: [10, 20, 30], concurrency_max: 1, window_minutes: 10 }, {});
        const r = waves.removeIssueFromWave(c.waveNumber, 20, {});
        assert.equal(r.removed, true);
        assert.equal(r.issue, 20);
        const st = readWaves(dir);
        assert.deepEqual(st.planned_waves[0].issues.map((i) => i.number), [10, 30]);
    } finally { teardownTmp(dir); }
});

test('removeIssueFromWave: idempotente — quitar un issue ausente es no-op (removed:false, no lanza)', () => {
    const { dir, waves } = setupTmp();
    try {
        const c = waves.createPlannedWave({ name: 'Idem', issues: [10], concurrency_max: 1, window_minutes: 10 }, {});
        const before = readWaves(dir);
        const r = waves.removeIssueFromWave(c.waveNumber, 999, {});
        assert.equal(r.removed, false);
        // Estado sin cambios en los issues.
        const after = readWaves(dir);
        assert.deepEqual(after.planned_waves[0].issues, before.planned_waves[0].issues);
    } finally { teardownTmp(dir); }
});

test('removeIssueFromWave: 404 (EWAVES_NOT_FOUND) si la ola no existe', () => {
    const { dir, waves } = setupTmp();
    try {
        waves.createPlannedWave({ name: 'N', issues: [1], concurrency_max: 1, window_minutes: 10 }, {});
        assert.ok(expectThrowCode(() => waves.removeIssueFromWave(999, 1, {}), 'EWAVES_NOT_FOUND'));
    } finally { teardownTmp(dir); }
});

test('removeIssueFromWave: issue inválido → EWAVES_SHAPE', () => {
    const { dir, waves } = setupTmp();
    try {
        const c = waves.createPlannedWave({ name: 'S', issues: [1], concurrency_max: 1, window_minutes: 10 }, {});
        assert.ok(expectThrowCode(() => waves.removeIssueFromWave(c.waveNumber, 'abc', {}), 'EWAVES_SHAPE'));
        assert.ok(expectThrowCode(() => waves.removeIssueFromWave(c.waveNumber, -5, {}), 'EWAVES_SHAPE'));
    } finally { teardownTmp(dir); }
});

test('removeIssueFromWave: If-Match mismatch → EWAVES_VERSION_CONFLICT y NO escribe', () => {
    const { dir, waves } = setupTmp();
    try {
        const c = waves.createPlannedWave({ name: 'V', issues: [10, 20], concurrency_max: 1, window_minutes: 10 }, {});
        const before = fs.readFileSync(path.join(dir, 'waves.json'), 'utf8');
        assert.ok(expectThrowCode(
            () => waves.removeIssueFromWave(c.waveNumber, 10, { expectedVersion: 'no-coincide' }),
            'EWAVES_VERSION_CONFLICT',
        ));
        assert.equal(fs.readFileSync(path.join(dir, 'waves.json'), 'utf8'), before);
    } finally { teardownTmp(dir); }
});

// --- If-Match en add/create (opt-in, no rompe callers históricos) -------------

test('addIssueToWave: If-Match mismatch → EWAVES_VERSION_CONFLICT', () => {
    const { dir, waves } = setupTmp();
    try {
        const c = waves.createPlannedWave({ name: 'Add', issues: [1], concurrency_max: 1, window_minutes: 10 }, {});
        assert.ok(expectThrowCode(
            () => waves.addIssueToWave(c.waveNumber, { number: 2 }, { expectedVersion: 'stale' }),
            'EWAVES_VERSION_CONFLICT',
        ));
    } finally { teardownTmp(dir); }
});

test('addIssueToWave: sin expectedVersion se comporta igual que siempre (no rompe callers)', () => {
    const { dir, waves } = setupTmp();
    try {
        const c = waves.createPlannedWave({ name: 'Compat', issues: [1], concurrency_max: 1, window_minutes: 10 }, {});
        const r = waves.addIssueToWave(c.waveNumber, { number: 2 });
        assert.equal(r.added, true);
        assert.equal(readWaves(dir).planned_waves[0].issues.length, 2);
    } finally { teardownTmp(dir); }
});

// --- Concurrencia (escrituras simultáneas no corrompen — lock + atomic) --------

test('concurrencia: N removes simultáneos sobre la misma ola no corrompen el estado', async () => {
    const { dir, waves } = setupTmp();
    try {
        const issues = Array.from({ length: 8 }, (_, i) => 100 + i);
        const c = waves.createPlannedWave({ name: 'Conc', issues, concurrency_max: 1, window_minutes: 10 }, {});
        const worker = path.join(__dirname, 'fixtures', 'waves-mutation-worker.js');
        const cp = require('node:child_process');
        // Fork en paralelo (todos arrancan antes de esperar a ninguno) → colisión
        // real sobre el mismo waves.json, serializada por withLockSync + atomic.
        const children = issues.map((issue) => cp.spawn(process.execPath, [worker], {
            env: { ...process.env, PIPELINE_DIR_OVERRIDE: dir, WORKER_OP: 'remove', WORKER_WAVE: String(c.waveNumber), WORKER_ISSUE: String(issue) },
            stdio: 'ignore',
        }));
        const codes = await Promise.all(children.map((ch) => new Promise((resolve) => ch.on('exit', (code) => resolve(code)))));
        assert.ok(codes.every((code) => code === 0), `todos los workers salen 0 (obtenido: ${codes})`);
        // El estado final es JSON válido y pasa validación estricta.
        const st = readWaves(dir);
        assert.doesNotThrow(() => waves.validateStateStrict(st));
        // Sin duplicados en los issues restantes.
        const finalIssues = st.planned_waves[0].issues.map((i) => i.number);
        assert.equal(new Set(finalIssues).size, finalIssues.length, 'sin duplicados tras removes concurrentes');
    } finally {
        teardownTmp(dir);
    }
});
