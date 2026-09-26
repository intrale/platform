// Copyright (c) 2026 Leonel Larreta
// SPDX-License-Identifier: LicenseRef-Proprietary

'use strict';

// Tests de lib/actions-usage-cron/runner.js (#7689, parte 3/4 de #7661).
// Spawn fake con EventEmitter, stderr como PassThrough y timers inyectados:
// no se lanza ningún `node` real ni se espera el timeout de verdad.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');

const runner = require('../runner');

const REPO = path.resolve(os.tmpdir(), 'au-runner-fake-repo');
const PRICING = { plans: { free: { included_minutes: 2000 } }, per_minute_usd: { linux: 0.006 } };

function seccion(over = {}) {
    return { since: '2026-09-01', cadence_days: 7, repos: ['platform', 'kernel'], timeout_min: 90, ...over };
}

function fakeChild(pid = 4242) {
    const child = new EventEmitter();
    child.pid = pid;
    child.stderr = new PassThrough();
    return child;
}

/** Timers falsos: registran el timeout y permiten dispararlo a mano. */
function fakeTimers() {
    const t = { pendiente: null, ms: null, cleared: false };
    t.set = (fn, ms) => { t.pendiente = fn; t.ms = ms; return { id: 1 }; };
    t.clear = () => { t.cleared = true; };
    t.fire = () => t.pendiente && t.pendiente();
    return t;
}

/**
 * Arma una corrida. `comportamiento(child, runDir)` simula el hijo.
 */
function correr(comportamiento, over = {}) {
    const timers = fakeTimers();
    const llamadas = [];
    const kills = [];
    let runDir = null;
    const logs = [];
    const spawnImpl = (bin, args, opts) => {
        const child = fakeChild(over.pid === undefined ? 4242 : over.pid);
        runDir = path.dirname(args[args.indexOf('--out') + 1]);
        llamadas.push({ bin, args, opts });
        setImmediate(() => comportamiento(child, runDir));
        return child;
    };
    const p = runner.spawnMeasure({
        section: seccion(over.section),
        repoRoot: REPO,
        pricingObj: over.pricingObj === undefined ? PRICING : over.pricingObj,
        spawnImpl: over.spawnImpl || spawnImpl,
        killTree: (pid, d) => { kills.push(pid); return { killed: true, d }; },
        setTimeoutImpl: timers.set,
        clearTimeoutImpl: timers.clear,
        logger: (m) => logs.push(m),
    });
    return { p, timers, llamadas, kills, logs, getRunDir: () => runDir };
}

function escribirSummary(runDir, contenido) {
    fs.writeFileSync(path.join(runDir, 'out', runner.SUMMARY_FILE), contenido);
}

test('CA-10 · spawn con process.execPath, args exactos como array, sin shell y windowsHide', async () => {
    const r = correr((child, dir) => { escribirSummary(dir, '{"totals":{}}'); child.emit('exit', 0); });
    const res = await r.p;
    assert.strictEqual(res.kind, 'ok');
    assert.strictEqual(r.llamadas.length, 1);
    const { bin, args, opts } = r.llamadas[0];
    const dir = r.getRunDir();
    assert.strictEqual(bin, process.execPath);
    assert.ok(Array.isArray(args));
    assert.deepStrictEqual(args, [
        path.join(REPO, 'scripts', 'measure-actions-billing.js'),
        '--strict', '--summary-only',
        '--since', '2026-09-01',
        '--days', '7',
        '--skip-storage', '--skip-releases',
        '--pricing', path.join(dir, 'pricing.json'),
        '--raw', path.join(dir, 'raw'),
        '--out', path.join(dir, 'out'),
        '--repos', 'platform,kernel',
    ]);
    assert.deepStrictEqual(opts, { cwd: REPO, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    assert.strictEqual('shell' in opts, false);
    assert.ok(dir.startsWith(path.join(os.tmpdir(), runner.TMP_PREFIX)), 'el runDir sale del mkdtemp');
    assert.ok(!dir.startsWith(REPO), 'ninguna ruta del hijo sale del repo/YAML');
    assert.strictEqual(r.timers.ms, 90 * 60000);
    assert.strictEqual(r.timers.cleared, true);
});

test('el pricing.json del hijo es la re-serialización del objeto validado', async () => {
    let leido = null;
    const r = correr((child, dir) => {
        leido = JSON.parse(fs.readFileSync(path.join(dir, 'pricing.json'), 'utf8'));
        child.emit('exit', 3);
    });
    await r.p;
    assert.deepStrictEqual(leido, PRICING);
});

test('CA-11 · clasificación: 0 ok · 2 config · 3 rate_limit · 4 api · 7 api · null api · error api', async () => {
    const casos = [[0, 'ok'], [2, 'config'], [3, 'rate_limit'], [4, 'api'], [7, 'api'], [null, 'api'], [1, 'api']];
    for (const [code, kind] of casos) {
        const r = correr((child, dir) => { if (code === 0) escribirSummary(dir, '{}'); child.emit('exit', code); });
        assert.strictEqual((await r.p).kind, kind, `exit ${code}`);
    }
    const r = correr((child) => child.emit('error', new Error('ENOENT')));
    assert.strictEqual((await r.p).kind, 'api');
    assert.strictEqual(runner.classifyExit('__proto__'), 'api');
    assert.strictEqual(runner.classifyExit('constructor'), 'api');
});

test('exit + error ⇒ una sola resolución', async () => {
    let resoluciones = 0;
    const r = correr((child, dir) => {
        escribirSummary(dir, '{}');
        child.emit('exit', 0);
        child.emit('error', new Error('tarde'));
        child.emit('exit', 4);
    });
    const res = await r.p.then((x) => { resoluciones++; return x; });
    await new Promise((s) => setImmediate(s));
    assert.strictEqual(res.kind, 'ok');
    assert.strictEqual(resoluciones, 1);
});

test('CA-12 · el timer vence ⇒ killTree recibe el pid numérico ⇒ timeout; un exit posterior se ignora', async () => {
    const r = correr(() => {}, { pid: 5151 });
    await new Promise((s) => setImmediate(s));
    let exitTardio = null;
    r.timers.fire();
    const res = await r.p;
    assert.strictEqual(res.kind, 'timeout');
    assert.strictEqual(res.summary, null);
    assert.deepStrictEqual(r.kills, [5151]);
    exitTardio = r.getRunDir();
    assert.ok(!fs.existsSync(exitTardio), 'runDir borrado tras timeout');
});

test('CA-12 · defaultKillTree: pid inválido no ejecuta nada', () => {
    for (const pid of [undefined, null, 0, -1, 1.5, '123', NaN]) {
        const exec = [];
        const res = runner.defaultKillTree(pid, { platform: 'win32', execFile: (...a) => exec.push(a), pidAlive: () => false, sleep: () => {} });
        assert.strictEqual(res.killed, false, String(pid));
        assert.deepStrictEqual(exec, []);
    }
});

test('CA-12 · defaultKillTree en Windows: taskkill /T /F sin shell; si sigue vivo escala a wmic', () => {
    const exec = [];
    let vivos = 1;
    const res = runner.defaultKillTree(777, {
        platform: 'win32',
        execFile: (file, args, opts) => { exec.push({ file, args, opts }); },
        pidAlive: () => vivos-- > 0,
        sleep: () => {},
    });
    assert.strictEqual(res.killed, true);
    assert.deepStrictEqual(exec.map((e) => [e.file, e.args]), [
        ['taskkill', ['/PID', '777', '/F', '/T']],
        ['wmic', ['process', 'where', 'ProcessId=777', 'call', 'terminate']],
    ]);
    for (const e of exec) {
        assert.strictEqual('shell' in e.opts, false);
        assert.strictEqual(e.opts.windowsHide, true);
    }
    // taskkill con "Acceso denegado" (lanza) ⇒ se registra y se escala.
    const exec2 = [];
    const res2 = runner.defaultKillTree(778, {
        platform: 'win32',
        execFile: (file) => { exec2.push(file); if (file === 'taskkill') throw new Error('Acceso denegado'); },
        pidAlive: (() => { let n = 0; return () => n++ === 0; })(),
        sleep: () => {},
    });
    assert.strictEqual(res2.killed, true);
    assert.deepStrictEqual(exec2, ['taskkill', 'wmic']);
    assert.strictEqual(res2.intentos[0].error, 'Acceso denegado');
    // Ambos fallan ⇒ killed false (el runner igual resuelve timeout).
    const res3 = runner.defaultKillTree(779, { platform: 'win32', execFile: () => {}, pidAlive: () => true, sleep: () => {} });
    assert.strictEqual(res3.killed, false);
    assert.strictEqual(res3.intentos.length, 2);
});

test('CA-12 · defaultKillTree fuera de Windows usa child.kill(SIGKILL)', () => {
    const señales = [];
    const res = runner.defaultKillTree(880, { platform: 'linux', child: { kill: (s) => señales.push(s) }, execFile: () => assert.fail('sin exec') });
    assert.strictEqual(res.killed, true);
    assert.deepStrictEqual(señales, ['SIGKILL']);
});

test('CA-13 · el runDir no existe al terminar en los seis caminos', async () => {
    const caminos = {
        ok: (child, dir) => { escribirSummary(dir, '{}'); child.emit('exit', 0); },
        config: (child) => child.emit('exit', 2),
        rate_limit: (child) => child.emit('exit', 3),
        api: (child) => child.emit('exit', 4),
        error: (child) => child.emit('error', new Error('x')),
        timeout: null,
    };
    for (const [nombre, fn] of Object.entries(caminos)) {
        const r = correr(fn || (() => {}));
        await new Promise((s) => setImmediate(s));
        if (!fn) r.timers.fire();
        await r.p;
        const dir = r.getRunDir();
        assert.ok(dir, nombre);
        assert.ok(!fs.existsSync(dir), `${nombre}: el runDir quedó en disco`);
    }
    // spawn que lanza sincrónicamente: también se limpia.
    let dirSpawnRoto = null;
    const r = correr(null, {
        spawnImpl: (bin, args) => { dirSpawnRoto = path.dirname(args[args.indexOf('--out') + 1]); throw new Error('EPERM'); },
    });
    assert.strictEqual((await r.p).kind, 'api');
    assert.ok(!fs.existsSync(dirSpawnRoto));
    // pricing inválido ⇒ no se lanza nada y se limpia.
    const antes = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith(runner.TMP_PREFIX)).length;
    const r2 = correr(() => assert.fail('no debería lanzarse'), { pricingObj: null });
    assert.strictEqual((await r2.p).kind, 'api');
    assert.strictEqual(r2.llamadas.length, 0);
    const despues = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith(runner.TMP_PREFIX)).length;
    assert.ok(despues <= antes);
});

test('CA-13 · safeRmTmp no borra rutas fuera de <tmp>/measure-actions-', () => {
    const rms = [];
    const fsFake = { rmSync: (p) => rms.push(p) };
    const logs = [];
    for (const p of ['C:\\x', '/', '', null, os.tmpdir(), path.join(os.tmpdir(), runner.TMP_PREFIX), path.join(os.tmpdir(), 'otra-cosa'),
        path.join(os.tmpdir(), `${runner.TMP_PREFIX}abc`, '..', '..', 'x'), path.join(os.tmpdir(), `${runner.TMP_PREFIX}abc`, 'sub')]) {
        assert.strictEqual(runner.safeRmTmp(p, fsFake, (m) => logs.push(m)), false, String(p));
    }
    assert.deepStrictEqual(rms, []);
    assert.ok(logs.length > 0);
    const ok = path.join(os.tmpdir(), `${runner.TMP_PREFIX}abc123`);
    assert.strictEqual(runner.safeRmTmp(ok, fsFake), true);
    assert.deepStrictEqual(rms, [ok]);
    // rmSync que falla (EBUSY) no lanza.
    const fsBusy = { rmSync: () => { const e = new Error('busy'); e.code = 'EBUSY'; throw e; } };
    const logs2 = [];
    assert.strictEqual(runner.safeRmTmp(ok, fsBusy, (m) => logs2.push(m)), false);
    assert.ok(logs2[0].includes('EBUSY'));
});

test('CA-14 · stderr con ghp_/gho_ ⇒ el log no los contiene; tampoco rutas del tmp', async () => {
    const ghp = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8';
    const gho = 'gho_' + 'Z9y8X7w6V5u4T3s2R1q0P9o8N7m6L5k4J3i2';
    const r = correr((child, dir) => {
        child.stderr.write(`Authorization: token ${ghp}\n`);
        child.stderr.write(`fallo leyendo ${dir}${path.sep}raw con ${gho}\n`);
        setImmediate(() => child.emit('exit', 4));
    });
    const res = await r.p;
    assert.strictEqual(res.kind, 'api');
    const log = r.logs.join('\n');
    assert.ok(log.includes('stderr del medidor'), log);
    assert.ok(!log.includes(ghp), 'ghp_ sin redactar');
    assert.ok(!log.includes(gho), 'gho_ sin redactar');
    assert.ok(!log.includes(r.getRunDir()), 'el log contiene la ruta del mkdtemp');
    assert.ok(!('stderr' in res), 'el stderr no forma parte del resultado');
    assert.deepStrictEqual(Object.keys(res).sort(), ['kind', 'summary']);
});

test('CA-14 · un stderr de 10 KB queda truncado a 4 KB o menos en el log', async () => {
    const r = correr((child) => {
        child.stderr.write('x '.repeat(5 * 1024));
        child.stderr.write('y '.repeat(5 * 1024));
        setImmediate(() => child.emit('exit', 4));
    });
    await r.p;
    const linea = r.logs.find((l) => l.startsWith('stderr del medidor'));
    assert.ok(linea);
    const cuerpo = linea.slice('stderr del medidor: '.length);
    assert.ok(Buffer.byteLength(cuerpo, 'utf8') <= runner.STDERR_MAX_BYTES, `largo ${Buffer.byteLength(cuerpo)}`);
});

test('summary ausente, JSON inválido, no-objeto o mayor a 5 MB ⇒ summary_invalido', async () => {
    const casos = {
        ausente: () => {},
        invalido: (dir) => escribirSummary(dir, '{no json'),
        array: (dir) => escribirSummary(dir, '[1,2]'),
        grande: (dir) => escribirSummary(dir, JSON.stringify({ x: 'a'.repeat(runner.SUMMARY_MAX_BYTES) })),
    };
    for (const [nombre, prep] of Object.entries(casos)) {
        const r = correr((child, dir) => { prep(dir); child.emit('exit', 0); });
        const res = await r.p;
        assert.strictEqual(res.kind, 'summary_invalido', nombre);
        assert.strictEqual(res.summary, null);
        assert.ok(!fs.existsSync(r.getRunDir()));
    }
});

test('flujo feliz devuelve el objeto del summary (no la ruta)', async () => {
    const r = correr((child, dir) => { escribirSummary(dir, JSON.stringify({ totals: { billable_min: 42 } })); child.emit('exit', 0); });
    const res = await r.p;
    assert.deepStrictEqual(res, { kind: 'ok', summary: { totals: { billable_min: 42 } } });
});

test('mkdtemp que falla ⇒ tmp_no_disponible sin lanzar el hijo', async () => {
    let lanzado = false;
    const res = await runner.spawnMeasure({
        section: seccion(), repoRoot: REPO, pricingObj: PRICING,
        fsImpl: { mkdtempSync: () => { const e = new Error('x'); e.code = 'ENOSPC'; throw e; } },
        spawnImpl: () => { lanzado = true; },
    });
    assert.deepStrictEqual(res, { kind: 'tmp_no_disponible', summary: null });
    assert.strictEqual(lanzado, false);
});
