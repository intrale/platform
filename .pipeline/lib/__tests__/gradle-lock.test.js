'use strict';

// Tests del lock global de Gradle (#4155). Verifican que `withGradleLock`:
//  1. adquiere y libera el lock (el archivo no queda tras una corrida ok),
//  2. libera el lock aunque `fn` lance (auto-release, requisito security CA-5),
//  3. respeta el override `GRADLE_LOCK_PATH`,
//  4. serializa dos invocaciones concurrentes de procesos distintos (la
//     segunda espera a que la primera libere) — el escenario inter-agente real.
//
// La serialización se prueba con dos procesos hijo (pids distintos): el lock
// reentrante de file-lock.js NO bloquea dentro de un mismo pid, así que un test
// single-process no demostraría la serialización.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'v3-gradle-lock-'));
const LOCK_PATH = path.join(TMP, 'gradle-global.lock');
process.env.GRADLE_LOCK_PATH = LOCK_PATH;

const MOD_PATH = require.resolve('../gradle-lock');
delete require.cache[MOD_PATH];
const gradleLock = require('../gradle-lock');
const { withGradleLock, resolveLockPath } = gradleLock;

// El lock real de file-lock.js vive en `<lockPath>.lock` (lockPathOf añade el
// sufijo). Verificamos su existencia, no la del path lógico.
function lockFileExists(logicalPath) {
    return fs.existsSync(`${logicalPath}.lock`);
}

test('resolveLockPath respeta el override GRADLE_LOCK_PATH', () => {
    assert.equal(resolveLockPath(), LOCK_PATH);
});

// #7112 — el default ya no se ancla a `__dirname`: se resuelve POR LLAMADA vía
// `lib/write-target` sobre el dir del ambiente (acá, el override del fixture).
test('DEFAULT_LOCK_PATH resuelve locks/gradle-global.lock bajo el dir del ambiente, por llamada', () => {
    const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'gradle-lock-a-'));
    const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'gradle-lock-b-'));
    const previo = process.env.PIPELINE_DIR_OVERRIDE;
    try {
        process.env.PIPELINE_DIR_OVERRIDE = dirA;
        assert.equal(gradleLock.DEFAULT_LOCK_PATH, path.join(dirA, 'locks', 'gradle-global.lock'));
        process.env.PIPELINE_DIR_OVERRIDE = dirB;
        assert.equal(gradleLock.DEFAULT_LOCK_PATH, path.join(dirB, 'locks', 'gradle-global.lock'));
    } finally {
        if (previo === undefined) delete process.env.PIPELINE_DIR_OVERRIDE;
        else process.env.PIPELINE_DIR_OVERRIDE = previo;
        fs.rmSync(dirA, { recursive: true, force: true });
        fs.rmSync(dirB, { recursive: true, force: true });
    }
});

test('withGradleLock ejecuta fn, devuelve su resultado y libera el lock', async () => {
    let heldDuringFn = false;
    const result = await withGradleLock(() => {
        heldDuringFn = lockFileExists(LOCK_PATH);
        return 42;
    });
    assert.equal(result, 42);
    assert.equal(heldDuringFn, true, 'el lock debe estar tomado mientras corre fn');
    assert.equal(lockFileExists(LOCK_PATH), false, 'el lock debe liberarse tras fn');
});

test('withGradleLock libera el lock aunque fn lance (auto-release CA-5)', async () => {
    await assert.rejects(
        withGradleLock(async () => {
            assert.equal(lockFileExists(LOCK_PATH), true);
            throw new Error('boom en el build');
        }),
        /boom en el build/,
    );
    assert.equal(lockFileExists(LOCK_PATH), false, 'el lock debe liberarse incluso ante excepción');
});

test('withGradleLock soporta fn async y mantiene el lock durante el await', async () => {
    let heldMidAwait = false;
    await withGradleLock(async () => {
        await new Promise((r) => setTimeout(r, 30));
        heldMidAwait = lockFileExists(LOCK_PATH);
    });
    assert.equal(heldMidAwait, true, 'el lock debe sostenerse a lo largo del await');
    assert.equal(lockFileExists(LOCK_PATH), false);
});

test('serializa dos invocaciones concurrentes de procesos distintos', async () => {
    const serialLock = path.join(TMP, 'serial.lock');
    const eventLog = path.join(TMP, 'serial-events.log');
    try { fs.unlinkSync(eventLog); } catch {}

    const modForChild = MOD_PATH.replace(/\\/g, '/');
    const childScript = `
        process.env.GRADLE_LOCK_PATH = process.argv[2];
        const { withGradleLock } = require(process.argv[1]);
        const fs = require('fs');
        const logPath = process.argv[3];
        const id = process.argv[4];
        withGradleLock(async () => {
            fs.appendFileSync(logPath, 'start:' + id + '\\n');
            await new Promise((r) => setTimeout(r, 400));
            fs.appendFileSync(logPath, 'end:' + id + '\\n');
        }, { timeoutMs: 15000 })
            .then(() => process.exit(0))
            .catch((e) => { console.error(e); process.exit(1); });
    `;

    function runChild(id) {
        return new Promise((resolve, reject) => {
            const child = spawn(
                process.execPath,
                ['-e', childScript, modForChild, serialLock, eventLog, String(id)],
                { stdio: ['ignore', 'ignore', 'inherit'] },
            );
            child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`child ${id} exit ${code}`))));
            child.on('error', reject);
        });
    }

    await Promise.all([runChild('A'), runChild('B')]);

    const events = fs.readFileSync(eventLog, 'utf8').trim().split('\n');
    assert.equal(events.length, 4, `se esperaban 4 eventos, hubo: ${events.join(',')}`);
    // Serializado => start/end del primero ANTES del start del segundo.
    // No serializado => start,start,end,end (interleaved).
    assert.equal(events[0].startsWith('start:'), true);
    assert.equal(events[1].startsWith('end:'), true, `interleaving detectado: ${events.join(',')}`);
    assert.equal(events[0].split(':')[1], events[1].split(':')[1], 'el primer start y end deben ser del mismo proceso');
    assert.equal(events[2].startsWith('start:'), true);
    assert.equal(events[3].startsWith('end:'), true);
});
