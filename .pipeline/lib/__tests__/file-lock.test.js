// =============================================================================
// file-lock.test.js — Tests de lib/file-lock.js (issue #3518 CA-3).
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const lock = require('../file-lock');

function mkTmpFile() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flock-test-'));
    return path.join(dir, 'target.json');
}

function rmrf(p) {
    try { fs.rmSync(path.dirname(p), { recursive: true, force: true }); } catch {}
}

// ─── Adquisición básica ─────────────────────────────────────────────────────

test('withLockSync ejecuta fn y libera el lock al salir', () => {
    const target = mkTmpFile();
    try {
        let ran = false;
        const result = lock.withLockSync(target, () => {
            ran = true;
            // El lock debe existir DENTRO de fn.
            assert.equal(fs.existsSync(target + '.lock'), true);
            return 42;
        });
        assert.equal(ran, true);
        assert.equal(result, 42);
        // Tras el return, el lock debe estar liberado.
        assert.equal(fs.existsSync(target + '.lock'), false);
    } finally { rmrf(target); }
});

test('withLockSync libera el lock incluso si fn tira', () => {
    const target = mkTmpFile();
    try {
        assert.throws(() => lock.withLockSync(target, () => { throw new Error('boom'); }), /boom/);
        assert.equal(fs.existsSync(target + '.lock'), false);
    } finally { rmrf(target); }
});

test('withLockSync el lock file contiene metadata enriquecida (pid, startTime, hostname, version)', () => {
    const target = mkTmpFile();
    try {
        let metaSeen = null;
        lock.withLockSync(target, () => {
            metaSeen = lock._internal.readLockMeta(target + '.lock');
        });
        assert.ok(metaSeen, 'meta debe leerse');
        assert.equal(metaSeen.pid, process.pid);
        assert.equal(metaSeen.hostname, os.hostname());
        assert.equal(metaSeen.version, lock._internal.LOCK_SCHEMA_VERSION);
        assert.ok(metaSeen.startTime);
        assert.ok(Number.isFinite(Date.parse(metaSeen.startTime)));
    } finally { rmrf(target); }
});

test('withLockSync soporta reentrancia (mismo pid+startTime no deadlockea)', () => {
    const target = mkTmpFile();
    try {
        let inner = false;
        lock.withLockSync(target, () => {
            lock.withLockSync(target, () => {
                inner = true;
            });
            // El lock externo todavía existe.
            assert.equal(fs.existsSync(target + '.lock'), true);
        });
        assert.equal(inner, true);
        assert.equal(fs.existsSync(target + '.lock'), false);
    } finally { rmrf(target); }
});

// ─── Stale detection ────────────────────────────────────────────────────────

test('isStale: PID no existe → stale', () => {
    const fake = { pid: 9999999, startTime: '2026-01-01T00:00:00.000Z' };
    // PID muy alto — improbable que exista.
    const stale = lock._internal.isStale(fake, '/nope/inexistent.lock');
    assert.equal(stale, true);
});

test('isStale: lock corrupto → stale', () => {
    const stale = lock._internal.isStale({ _corrupt: true }, '/nope/inexistent.lock');
    assert.equal(stale, true);
});

test('isStale: PID vivo + lock reciente → NO stale (conservador)', () => {
    const target = mkTmpFile();
    try {
        // Simular un lock recién creado de OTRO proceso vivo (usamos parent pid).
        const meta = { pid: process.ppid, startTime: new Date().toISOString(), hostname: os.hostname(), version: '1.0' };
        fs.writeFileSync(target + '.lock', JSON.stringify(meta));
        const stale = lock._internal.isStale(meta, target + '.lock');
        // ppid existe → NO stale (lock es muy nuevo de todas formas).
        assert.equal(stale, false);
    } finally { rmrf(target); }
});

// #3735 (regresión CA-8 #3518): un lock vacío (corrupt) de creación en curso
// NO debe robarse aunque tenga más de 1s. Antes el umbral era 1s y, bajo
// fork-storm, un holder descheduleado >1s entre openSync y writeSync perdía su
// lock → dual-hold → lost-update (`issues=2, exitosos=7`).
test('isStale: lock corrupto fresco (< 60s, > umbral viejo de 1s) → NO stale (creación en curso)', () => {
    const target = mkTmpFile();
    try {
        // Lock vacío: openSync('wx') creó el archivo pero el holder aún no
        // escribió la meta (descheduleado). Simulamos mtime de ~3s atrás.
        fs.writeFileSync(target + '.lock', '');
        const threeSecAgo = (Date.now() - 3000) / 1000;
        fs.utimesSync(target + '.lock', threeSecAgo, threeSecAgo);
        const meta = lock._internal.readLockMeta(target + '.lock');
        assert.ok(meta && meta._corrupt, 'lock vacío debe leerse como corrupt');
        const stale = lock._internal.isStale(meta, target + '.lock');
        assert.equal(stale, false, 'lock corrupto < 60s no debe declararse stale');
    } finally { rmrf(target); }
});

test('isStale: lock corrupto viejo (> 60s) → stale (recuperación de huérfano preservada)', () => {
    const target = mkTmpFile();
    try {
        fs.writeFileSync(target + '.lock', '');
        const old = (Date.now() - 90 * 1000) / 1000; // 90s atrás
        fs.utimesSync(target + '.lock', old, old);
        const meta = lock._internal.readLockMeta(target + '.lock');
        assert.ok(meta && meta._corrupt, 'lock vacío debe leerse como corrupt');
        const stale = lock._internal.isStale(meta, target + '.lock');
        assert.equal(stale, true, 'lock corrupto > 60s debe declararse stale y recuperarse');
    } finally { rmrf(target); }
});

test('acquireLockSync: stale lock se reemplaza automáticamente', () => {
    const target = mkTmpFile();
    try {
        // Plantar un lock huérfano de un PID inexistente.
        fs.writeFileSync(target + '.lock', JSON.stringify({
            pid: 9999999,
            startTime: '2026-01-01T00:00:00.000Z',
            hostname: 'old-host',
            version: '1.0',
        }));
        // Forzar mtime viejo para que pase el umbral STALE_AGE_MS — aunque
        // con PID inexistente ya alcanza, esto es defensa.
        const old = (Date.now() - 5 * 60 * 1000) / 1000;
        fs.utimesSync(target + '.lock', old, old);

        const res = lock.acquireLockSync(target, { timeoutMs: 1000, maxRetries: 2 });
        assert.equal(res.acquired, true);
        // Liberar para no dejar basura.
        lock.releaseLock(target);
    } finally { rmrf(target); }
});

// ─── Timeout + notify ───────────────────────────────────────────────────────

test('acquireLockSync timeout → tira ELOCK_TIMEOUT con holder info', () => {
    const target = mkTmpFile();
    try {
        // Plantar un lock con NUESTRO pid pero startTime distinto — eso debería
        // contar como reentrancia (mismo pid + start). Para forzar timeout,
        // simulamos un lock de pid distinto vivo (parent pid) con start reciente.
        const meta = { pid: process.ppid, startTime: new Date().toISOString(), hostname: 'h', version: '1.0' };
        fs.writeFileSync(target + '.lock', JSON.stringify(meta));
        // Timeout MUY corto para no esperar mucho.
        try {
            lock.acquireLockSync(target, { timeoutMs: 300, maxRetries: 2 });
            assert.fail('debería haber tirado timeout');
        } catch (err) {
            assert.equal(err.code, 'ELOCK_TIMEOUT');
            assert.ok(err.lockPath);
            assert.ok(err.holder);
            assert.equal(err.holder.pid, process.ppid);
        }
        // Limpiar.
        try { fs.unlinkSync(target + '.lock'); } catch {}
    } finally { rmrf(target); }
});

test('withLockSync: en timeout invoca opts.notify con payload estructurado', () => {
    const target = mkTmpFile();
    try {
        const meta = { pid: process.ppid, startTime: new Date().toISOString(), hostname: 'h', version: '1.0' };
        fs.writeFileSync(target + '.lock', JSON.stringify(meta));
        let notified = null;
        try {
            lock.withLockSync(target, () => {}, {
                timeoutMs: 300,
                maxRetries: 2,
                component: 'test-lock',
                notify: (payload) => { notified = payload; },
            });
            assert.fail('debería haber tirado');
        } catch (err) {
            assert.equal(err.code, 'ELOCK_TIMEOUT');
        }
        assert.ok(notified, 'notify debe haberse llamado');
        assert.equal(notified.level, 'error');
        assert.equal(notified.component, 'test-lock');
        assert.ok(notified.message.includes('timeout'));
        try { fs.unlinkSync(target + '.lock'); } catch {}
    } finally { rmrf(target); }
});

test('withLockSync: notify que tira NO interrumpe la propagación del error real', () => {
    const target = mkTmpFile();
    try {
        const meta = { pid: process.ppid, startTime: new Date().toISOString(), hostname: 'h', version: '1.0' };
        fs.writeFileSync(target + '.lock', JSON.stringify(meta));
        try {
            lock.withLockSync(target, () => {}, {
                timeoutMs: 200,
                maxRetries: 1,
                notify: () => { throw new Error('notify roto'); },
            });
            assert.fail('debería haber tirado timeout');
        } catch (err) {
            // Tira ELOCK_TIMEOUT, NO "notify roto".
            assert.equal(err.code, 'ELOCK_TIMEOUT');
        }
        try { fs.unlinkSync(target + '.lock'); } catch {}
    } finally { rmrf(target); }
});

// ─── releaseLock ────────────────────────────────────────────────────────────

test('releaseLock: no remueve locks ajenos', () => {
    const target = mkTmpFile();
    try {
        // Plantar lock de otro pid vivo (parent pid).
        fs.writeFileSync(target + '.lock', JSON.stringify({
            pid: process.ppid,
            startTime: new Date().toISOString(),
            hostname: 'h',
            version: '1.0',
        }));
        const ok = lock.releaseLock(target);
        assert.equal(ok, false, 'no debe liberar un lock ajeno');
        assert.equal(fs.existsSync(target + '.lock'), true);
        fs.unlinkSync(target + '.lock');
    } finally { rmrf(target); }
});

test('releaseLock: limpia locks corruptos', () => {
    const target = mkTmpFile();
    try {
        fs.writeFileSync(target + '.lock', 'no es json');
        const ok = lock.releaseLock(target);
        assert.equal(ok, true);
        assert.equal(fs.existsSync(target + '.lock'), false);
    } finally { rmrf(target); }
});
