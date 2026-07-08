// =============================================================================
// Tests lib/anthropic-usage.js — lectura del uso real de `claude -p /usage` (#4597)
//
// Cubre: parseo de la salida, cache read/write, throttle/freshness de getUsage,
// refresh async fire-and-forget (spawn inyectado) y fallback seguro.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

function fresh() {
    delete require.cache[require.resolve('../anthropic-usage')];
    return require('../anthropic-usage');
}

function tmpMetrics() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-4597-'));
    fs.mkdirSync(path.join(dir, 'metrics'), { recursive: true });
    return path.join(dir, 'metrics');
}

// ---------------------------------------------------------------------------
// parseUsageOutput
// ---------------------------------------------------------------------------
test('parseUsageOutput extrae sesión% y semana% (all models) + resets', () => {
    const u = fresh();
    const out = u.parseUsageOutput(
        'Current session: 20% used · resets Jul 8, 10pm (America/Buenos_Aires)\n' +
        'Current week (all models): 64% used · resets Jul 12, 9pm (America/Buenos_Aires)\n' +
        'Current week (Fable): 0% used\n');
    assert.equal(out.sessionPct, 20);
    assert.equal(out.weeklyPct, 64);
    assert.match(out.sessionResetsRaw, /Jul 8, 10pm/);
    assert.match(out.weeklyResetsRaw, /Jul 12, 9pm/);
});

test('parseUsageOutput ignora el bucket por-modelo (Fable) y tolera ANSI', () => {
    const u = fresh();
    const out = u.parseUsageOutput(
        '\x1B[1mCurrent week (all models):\x1B[0m 5% used\n' +
        'Current week (Fable): 99% used\n');
    assert.equal(out.weeklyPct, 5);
    assert.equal(out.sessionPct, null);
});

test('parseUsageOutput devuelve null cuando no hay ningún porcentaje', () => {
    const u = fresh();
    assert.equal(u.parseUsageOutput('bla bla sin datos'), null);
    assert.equal(u.parseUsageOutput(''), null);
    assert.equal(u.parseUsageOutput(null), null);
});

// ---------------------------------------------------------------------------
// cache read/write
// ---------------------------------------------------------------------------
test('writeCache + readCache round-trip', () => {
    const u = fresh();
    const dir = tmpMetrics();
    const now = 1_700_000_000_000;
    u.writeCache(dir, { sessionPct: 12, weeklyPct: 48, sessionResetsRaw: null, weeklyResetsRaw: null }, now);
    const c = u.readCache(dir);
    assert.equal(c.sessionPct, 12);
    assert.equal(c.weeklyPct, 48);
    assert.equal(c.capturedAtMs, now);
    assert.equal(c.source, 'claude -p /usage');
});

test('readCache devuelve null ante archivo ausente o corrupto', () => {
    const u = fresh();
    const dir = tmpMetrics();
    assert.equal(u.readCache(dir), null);
    fs.writeFileSync(path.join(dir, 'anthropic-usage.json'), '}{not json');
    assert.equal(u.readCache(dir), null);
});

// ---------------------------------------------------------------------------
// getUsage — freshness / throttle / no-spawn por default
// ---------------------------------------------------------------------------
test('getUsage marca fresh cuando el cache es reciente', () => {
    const u = fresh();
    const dir = tmpMetrics();
    const now = 2_000_000_000_000;
    u.writeCache(dir, { sessionPct: 10, weeklyPct: 50 }, now);
    const r = u.getUsage({ metricsDir: dir, now: now + 60_000, autoRefresh: false });
    assert.equal(r.data.weeklyPct, 50);
    assert.equal(r.fresh, true);
    assert.equal(r.stale, false);
});

test('getUsage marca stale cuando el cache supera STALE_MS', () => {
    const u = fresh();
    const dir = tmpMetrics();
    const now = 2_000_000_000_000;
    u.writeCache(dir, { sessionPct: 10, weeklyPct: 50 }, now - (u.STALE_MS + 60_000));
    const r = u.getUsage({ metricsDir: dir, now, autoRefresh: false });
    assert.equal(r.stale, true);
    assert.equal(r.fresh, false);
    assert.equal(r.data.weeklyPct, 50);
});

test('getUsage sin cache devuelve data:null y NO spawnea por default', () => {
    const u = fresh();
    const dir = tmpMetrics();
    let spawned = 0;
    const r = u.getUsage({ metricsDir: dir, spawnImpl: () => { spawned++; } });
    assert.equal(r.data, null);
    assert.equal(r.stale, true);
    assert.equal(spawned, 0, 'default read-only: no spawn');
});

test('getUsage sin metricsDir no lanza, devuelve reason', () => {
    const u = fresh();
    const r = u.getUsage({});
    assert.equal(r.data, null);
    assert.match(r.reason, /metricsDir/);
});

// ---------------------------------------------------------------------------
// triggerRefreshAsync — spawn inyectado, escribe cache al cerrar
// ---------------------------------------------------------------------------
function fakeChild(stdout) {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.kill = () => {};
    // Emitir stdout + close en el próximo tick.
    setImmediate(() => {
        if (stdout) child.stdout.emit('data', Buffer.from(stdout));
        child.emit('close', 0);
    });
    return child;
}

test('triggerRefreshAsync spawnea /usage, parsea y escribe el cache', async () => {
    const u = fresh();
    const dir = tmpMetrics();
    let capturedArgs = null;
    const spawnImpl = (cmd, args) => {
        capturedArgs = args;
        return fakeChild('Current session: 30% used\nCurrent week (all models): 70% used\n');
    };
    u.triggerRefreshAsync({ metricsDir: dir, spawnImpl, launcher: { cmd: 'claude', prefixArgs: [], shell: false } });
    // Esperar a que el 'close' async escriba el cache.
    await new Promise((res) => setTimeout(res, 30));
    assert.ok(capturedArgs.includes('/usage'), 'debe invocar /usage');
    assert.ok(capturedArgs.includes('-p'), 'debe usar print mode');
    const c = u.readCache(dir);
    assert.equal(c.weeklyPct, 70);
    assert.equal(c.sessionPct, 30);
});

test('triggerRefreshAsync no escribe cache si el spawn no produce dato parseable', async () => {
    const u = fresh();
    const dir = tmpMetrics();
    u.triggerRefreshAsync({
        metricsDir: dir,
        spawnImpl: () => fakeChild('sin porcentajes aquí'),
        launcher: { cmd: 'claude', prefixArgs: [], shell: false },
    });
    await new Promise((res) => setTimeout(res, 30));
    assert.equal(u.readCache(dir), null, 'fallback: no escribe basura');
});

test('triggerRefreshAsync es fail-secure si spawn lanza', () => {
    const u = fresh();
    const dir = tmpMetrics();
    assert.doesNotThrow(() => {
        u.triggerRefreshAsync({
            metricsDir: dir,
            spawnImpl: () => { throw new Error('spawn roto'); },
            launcher: { cmd: 'claude', prefixArgs: [], shell: false },
        });
    });
    u._resetRefreshingForTesting();
});

test('getUsage con autoRefresh:true dispara el spawn cuando el cache está viejo', () => {
    const u = fresh();
    const dir = tmpMetrics();
    let spawned = 0;
    u.getUsage({
        metricsDir: dir,
        autoRefresh: true,
        spawnImpl: () => { spawned++; return fakeChild(''); },
        launcher: { cmd: 'claude', prefixArgs: [], shell: false },
    });
    assert.equal(spawned, 1);
    u._resetRefreshingForTesting();
});
