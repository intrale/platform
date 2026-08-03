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
    // Esperar el fin real del refresh (determinístico) en vez de un timeout fijo.
    await new Promise((res) => {
        u.triggerRefreshAsync({ metricsDir: dir, spawnImpl, launcher: { cmd: 'claude', prefixArgs: [], shell: false }, onDone: res });
    });
    assert.ok(capturedArgs.includes('/usage'), 'debe invocar /usage');
    assert.ok(capturedArgs.includes('-p'), 'debe usar print mode');
    const c = u.readCache(dir);
    assert.equal(c.weeklyPct, 70);
    assert.equal(c.sessionPct, 30);
});

test('triggerRefreshAsync no escribe cache si el spawn no produce dato parseable', async () => {
    const u = fresh();
    const dir = tmpMetrics();
    await new Promise((res) => {
        u.triggerRefreshAsync({
            metricsDir: dir,
            spawnImpl: () => fakeChild('sin porcentajes aquí'),
            launcher: { cmd: 'claude', prefixArgs: [], shell: false },
            onDone: res,
        });
    });
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

// ---------------------------------------------------------------------------
// #5455 — parseResetToIso: formatos reales del aviso semanal + fail-closed.
//
// Antes de #5455 el helper devolvía null para los DOS formatos reales
// observados (hora sola "9pm" y mes/día "Aug 9, 9pm"), así que "reusar
// parseResetToIso" no alcanzaba. Reloj fijo en todos los casos: el helper
// resuelve en hora LOCAL (parse imperfecto por diseño, sin libs de timezone),
// por eso las aserciones comparan contra Date locales construidos igual.
// ---------------------------------------------------------------------------

// 3-ago-2026, 12:00 hora local.
const REF_MEDIODIA = new Date(2026, 7, 3, 12, 0, 0).getTime();

function isoLocal(y, m, d, h, min) {
    return new Date(y, m, d, h, min, 0, 0).toISOString();
}

test('#5455 · hora sola futura del mismo día → esa hora de hoy', () => {
    const u = fresh();
    // 21:00 aún no pasó respecto de las 12:00.
    assert.equal(u.parseResetToIso('9pm', REF_MEDIODIA), isoLocal(2026, 7, 3, 21, 0));
});

test('#5455 · hora sola ya pasada → rollover al día siguiente', () => {
    const u = fresh();
    // 22:00 como referencia: las 21:00 ya pasaron → próxima ocurrencia mañana.
    const ref = new Date(2026, 7, 3, 22, 0, 0).getTime();
    assert.equal(u.parseResetToIso('9pm', ref), isoLocal(2026, 7, 4, 21, 0));
});

test('#5455 · hora sola en formato 24h ("21:00") también resuelve', () => {
    const u = fresh();
    assert.equal(u.parseResetToIso('21:00', REF_MEDIODIA), isoLocal(2026, 7, 3, 21, 0));
});

test('#5455 · mes/día futuro de /usage ("Aug 9, 9pm") → ese día del año en curso', () => {
    const u = fresh();
    assert.equal(u.parseResetToIso('Aug 9, 9pm', REF_MEDIODIA), isoLocal(2026, 7, 9, 21, 0));
});

test('#5455 · mes/día ya pasado → próxima ocurrencia (año siguiente)', () => {
    const u = fresh();
    // Jul 12 de 2026 ya pasó respecto del 3-ago-2026 → 2027.
    assert.equal(u.parseResetToIso('Jul 12, 8:59pm', REF_MEDIODIA), isoLocal(2027, 6, 12, 20, 59));
});

test('#5455 · la TZ entre paréntesis y el prefijo "resets" se descartan', () => {
    const u = fresh();
    const esperado = isoLocal(2026, 7, 3, 21, 0);
    assert.equal(u.parseResetToIso('9pm (America/Buenos_Aires)', REF_MEDIODIA), esperado);
    assert.equal(u.parseResetToIso('resets 9pm (America/Buenos_Aires)', REF_MEDIODIA), esperado);
});

test('#5455 · reset inválido devuelve null, sin inventar fecha', () => {
    const u = fresh();
    for (const raw of ['banana', '', '   ', 'Feb 31, 9pm', '13pm', '25:00', '9pm x']) {
        assert.equal(u.parseResetToIso(raw, REF_MEDIODIA), null, `debe ser null: ${JSON.stringify(raw)}`);
    }
});

test('#5455 · REGRESIÓN: tokens numéricos sueltos NO se resuelven a fechas inventadas', () => {
    // Date.parse es tan permisivo que resolvía estos tokens a fechas PASADAS
    // ("9" → 2001-09-01, "2020" → 2020-01-01). Como el helper ahora recibe el
    // reset capturado del canal de CONTENIDO (controlable por el modelo), un
    // aviso truncado como "...· resets 9" habría producido un resetsAt en el
    // pasado y, tras el clamp, un gate de 5 minutos en vez del gate corto
    // esperado. El fallback legacy exige ahora un token de mes conocido.
    const u = fresh();
    for (const raw of ['9', '12', '99', '2020', '0', '00', '1 2', '9 9', 'x 9']) {
        assert.equal(u.parseResetToIso(raw, REF_MEDIODIA), null, `debe ser null: ${JSON.stringify(raw)}`);
    }
});

test('#5455 · refMs inválido no rompe: cae al reloj real y devuelve ISO o null', () => {
    const u = fresh();
    const out = u.parseResetToIso('Aug 9, 9pm', NaN);
    assert.ok(out === null || !Number.isNaN(Date.parse(out)));
});
