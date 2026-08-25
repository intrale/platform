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

test('atomicCreateLock trata EBUSY transitorio como contención recuperable', (t) => {
    const target = mkTmpFile();
    const originalLink = fs.linkSync;
    let attempts = 0;
    t.mock.method(fs, 'linkSync', (...args) => {
        attempts++;
        if (attempts === 1) {
            const error = new Error('resource busy');
            error.code = 'EBUSY';
            throw error;
        }
        return originalLink(...args);
    });
    try {
        const result = lock.acquireLockSync(target, { timeoutMs: 1000 });
        assert.equal(result.acquired, true);
        assert.ok(attempts >= 2);
        lock.releaseLock(target);
    } finally {
        t.mock.restoreAll();
        rmrf(target);
    }
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

// =============================================================================
// #6145 — Lost-update silencioso por robo de lock a un holder VIVO.
//
// Rebote del tester: `waves-concurrency.test.js` CA-8 falló con
// `issues=5, exitosos=10` — 10 workers salieron con código 0 pero sólo 5
// escrituras sobrevivieron. Causa raíz: `isPidAlive()` tenía un catch-all
// `return false`, así que cualquier código de error distinto de ESRCH/EPERM se
// leía como "el holder está muerto". `isStale()` reclamaba entonces el lock sin
// mirar la antigüedad, un contendiente unlinkeaba el lock de un holder vivo y
// los dos procesos escribían sobre la misma base.
//
// Bajo fork-storm de la suite completa (~375 archivos, batches de `node --test`)
// `process.kill(pid, 0)` → `OpenProcess()` falla de forma transitoria con
// EACCES/ENOMEM/EMFILE/EINVAL según presión de handles. Todos caían en el
// catch-all. Por eso el test pasa aislado y falla dentro de la suite.
//
// Tres capas: (1) sonda fail-closed, (2) gracia + segunda sonda en el reclamo
// por PID muerto, (3) verificación de propiedad al salir de la sección crítica.
// =============================================================================

/** Reemplaza `process.kill` para que la sonda (señal 0) tire `code`. */
function withKillProbeFailing(code, fn) {
    const orig = process.kill.bind(process);
    process.kill = (pid, sig) => {
        if (sig === 0) {
            const e = new Error(`sonda simulada: ${code}`);
            e.code = code;
            throw e;
        }
        return orig(pid, sig);
    };
    try { return fn(); } finally { process.kill = orig; }
}

// Códigos que Windows produce de forma transitoria bajo presión de handles y
// que ANTES se leían como "proceso muerto".
const CODIGOS_SONDA_NO_CONCLUYENTES = ['EACCES', 'ENOMEM', 'EMFILE', 'EINVAL', 'UNKNOWN'];

for (const code of CODIGOS_SONDA_NO_CONCLUYENTES) {
    test(`isPidAlive: la sonda que falla con ${code} NO prueba que el proceso murió (fail-closed)`, () => {
        withKillProbeFailing(code, () => {
            assert.equal(
                lock._internal.isPidAlive(process.pid), true,
                `${code} no es ESRCH: la sonda no pudo responder, el proceso se asume VIVO`,
            );
        });
    });
}

test('isPidAlive: sólo ESRCH prueba que el proceso no existe', () => {
    withKillProbeFailing('ESRCH', () => {
        assert.equal(lock._internal.isPidAlive(process.pid), false);
    });
});

test('isPidAlive: EPERM sigue significando vivo (existe, no podemos firmarlo)', () => {
    withKillProbeFailing('EPERM', () => {
        assert.equal(lock._internal.isPidAlive(process.pid), true);
    });
});

for (const code of CODIGOS_SONDA_NO_CONCLUYENTES) {
    test(`isStale: una sonda que falla con ${code} NO le roba el lock a un holder vivo`, () => {
        const target = mkTmpFile();
        try {
            lock.acquireLockSync(target, { timeoutMs: 1000 });
            const lockPath = target + '.lock';
            const meta = lock._internal.readLockMeta(lockPath);
            withKillProbeFailing(code, () => {
                assert.equal(
                    lock._internal.isStale(meta, lockPath), false,
                    'robar este lock produce dual-hold → lost-update silencioso',
                );
            });
            lock.releaseLock(target);
        } finally { rmrf(target); }
    });
}

test('isStale: PID muerto + lock recién creado → NO stale (gracia contra sonda transitoria)', () => {
    const target = mkTmpFile();
    try {
        lock.acquireLockSync(target, { timeoutMs: 1000 });
        const lockPath = target + '.lock';
        const meta = lock._internal.readLockMeta(lockPath);
        // Lock de edad ~0ms: aunque la sonda diga ESRCH, no se reclama.
        withKillProbeFailing('ESRCH', () => {
            assert.equal(lock._internal.isStale(meta, lockPath), false);
        });
        lock.releaseLock(target);
    } finally { rmrf(target); }
});

test('isStale: PID muerto + lock más viejo que la gracia → stale (recuperación tras crash preservada)', () => {
    const target = mkTmpFile();
    try {
        lock.acquireLockSync(target, { timeoutMs: 1000 });
        const lockPath = target + '.lock';
        const meta = lock._internal.readLockMeta(lockPath);
        // Envejecer el lock por encima de la gracia: un crash real SÍ se recupera.
        const viejo = (Date.now() - lock._internal.DEAD_PID_GRACE_MS - 1000) / 1000;
        fs.utimesSync(lockPath, viejo, viejo);
        withKillProbeFailing('ESRCH', () => {
            assert.equal(lock._internal.isStale(meta, lockPath), true);
        });
        lock.releaseLock(target);
    } finally { rmrf(target); }
});

test('isStale: la segunda sonda contradice a la primera → el lock se respeta', () => {
    const target = mkTmpFile();
    try {
        lock.acquireLockSync(target, { timeoutMs: 1000 });
        const lockPath = target + '.lock';
        const meta = lock._internal.readLockMeta(lockPath);
        const viejo = (Date.now() - lock._internal.DEAD_PID_GRACE_MS - 1000) / 1000;
        fs.utimesSync(lockPath, viejo, viejo);

        // Primera sonda: ESRCH (lectura transitoria). Segunda: responde normal.
        const orig = process.kill.bind(process);
        let llamadas = 0;
        process.kill = (pid, sig) => {
            if (sig === 0) {
                llamadas++;
                if (llamadas === 1) {
                    const e = new Error('lectura transitoria');
                    e.code = 'ESRCH';
                    throw e;
                }
            }
            return orig(pid, sig);
        };
        try {
            assert.equal(lock._internal.isStale(meta, lockPath), false);
            assert.equal(llamadas >= 2, true, 'debe re-confirmar con una segunda sonda');
        } finally { process.kill = orig; }
        lock.releaseLock(target);
    } finally { rmrf(target); }
});

// ─── Capa 3: verificación de propiedad al salir de la sección crítica ────────

test('withLockSync: si le roban el lock durante la sección crítica tira ELOCK_STOLEN', () => {
    const target = mkTmpFile();
    try {
        assert.throws(() => {
            lock.withLockSync(target, () => {
                // Simular el robo: otro proceso lo declaró stale y entró.
                fs.unlinkSync(target + '.lock');
                fs.writeFileSync(target + '.lock', JSON.stringify({
                    pid: 424242,
                    startTime: '2026-01-01T00:00:00.000Z',
                    hostname: 'ladron',
                    version: '1.0',
                }));
                return 'escritura que pudo haberse pisado';
            }, { timeoutMs: 1000 });
        }, (err) => {
            assert.equal(err.code, 'ELOCK_STOLEN');
            assert.equal(err.holder.pid, 424242);
            assert.match(err.message, /exclusión mutua violada/);
            return true;
        });
        try { fs.unlinkSync(target + '.lock'); } catch {}
    } finally { rmrf(target); }
});

test('withLockSync: si el lock desaparece durante la sección crítica tira ELOCK_STOLEN', () => {
    const target = mkTmpFile();
    try {
        assert.throws(
            () => lock.withLockSync(target, () => { fs.unlinkSync(target + '.lock'); }, { timeoutMs: 1000 }),
            (err) => err.code === 'ELOCK_STOLEN',
        );
    } finally { rmrf(target); }
});

test('withLockSync: el robo dispara notify con payload estructurado', () => {
    const target = mkTmpFile();
    try {
        let notificado = null;
        try {
            lock.withLockSync(target, () => { fs.unlinkSync(target + '.lock'); }, {
                timeoutMs: 1000,
                component: 'waves-lock',
                notify: (p) => { notificado = p; },
            });
        } catch { /* esperado */ }
        assert.ok(notificado, 'notify debe haberse llamado');
        assert.equal(notificado.level, 'error');
        assert.equal(notificado.component, 'waves-lock');
        assert.match(notificado.message, /robado/);
    } finally { rmrf(target); }
});

test('withLockSync: verifyOwnership=false conserva la semántica vieja (no tira)', () => {
    const target = mkTmpFile();
    try {
        const r = lock.withLockSync(target, () => {
            fs.unlinkSync(target + '.lock');
            return 7;
        }, { timeoutMs: 1000, verifyOwnership: false });
        assert.equal(r, 7);
    } finally { rmrf(target); }
});

test('withLockSync: el camino feliz devuelve el valor de fn y libera el lock', () => {
    const target = mkTmpFile();
    try {
        const r = lock.withLockSync(target, () => 'ok', { timeoutMs: 1000 });
        assert.equal(r, 'ok');
        assert.equal(fs.existsSync(target + '.lock'), false);
    } finally { rmrf(target); }
});

test('withLockSync: en reentrancia no verifica propiedad (el dueño es el frame externo)', () => {
    const target = mkTmpFile();
    try {
        const r = lock.withLockSync(
            target,
            () => lock.withLockSync(target, () => 'anidado', { timeoutMs: 1000 }),
            { timeoutMs: 1000 },
        );
        assert.equal(r, 'anidado');
        assert.equal(fs.existsSync(target + '.lock'), false, 'el frame externo libera');
    } finally { rmrf(target); }
});

test('withLock (async): si le roban el lock durante la sección crítica tira ELOCK_STOLEN', async () => {
    const target = mkTmpFile();
    try {
        await assert.rejects(
            () => lock.withLock(target, async () => { fs.unlinkSync(target + '.lock'); }, { timeoutMs: 1000 }),
            (err) => err.code === 'ELOCK_STOLEN',
        );
    } finally { rmrf(target); }
});

test('withLock (async): el camino feliz devuelve el valor de fn y libera el lock', async () => {
    const target = mkTmpFile();
    try {
        const r = await lock.withLock(target, async () => 'async-ok', { timeoutMs: 1000 });
        assert.equal(r, 'async-ok');
        assert.equal(fs.existsSync(target + '.lock'), false);
    } finally { rmrf(target); }
});

test('checkStillOwned: reconoce nuestro propio lock y detecta cuando ya no lo tenemos', () => {
    const target = mkTmpFile();
    try {
        lock.acquireLockSync(target, { timeoutMs: 1000 });
        assert.equal(lock._internal.checkStillOwned(target).owned, true);
        lock.releaseLock(target);
        assert.equal(lock._internal.checkStillOwned(target).owned, false);
    } finally { rmrf(target); }
});
