// =============================================================================
// Tests quota-adapters/anthropic.js — adapter Anthropic Plan Max (reescrito #4597)
//
// El adapter ya NO usa la heurística de duración (`computeQuota`): su fuente es
// el uso REAL de `claude -p "/usage"`, cacheado por lib/anthropic-usage.js en
// `metrics/anthropic-usage.json`. Estos tests cubren el mapeo cache→shape:
//
//   * pct = semanal% real; session.pct = sesión% real; status derivado del %.
//   * dato stale → adapterStatus 'unknown' pero conserva el número.
//   * sin cache / error → fallback degradado 'unknown', pct null (NUNCA 0).
//   * error de input (sin metricsDir) → fail-secure 'error'.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

function makeTmpMetrics() {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-anthropic-'));
    const metricsDir = path.join(tmp, 'metrics');
    fs.mkdirSync(metricsDir, { recursive: true });
    return metricsDir;
}

function writeUsageCache(metricsDir, data) {
    fs.writeFileSync(path.join(metricsDir, 'anthropic-usage.json'), JSON.stringify(data));
}

function freshAdapter() {
    delete require.cache[require.resolve('../../quota-adapters/anthropic')];
    delete require.cache[require.resolve('../../quota-adapters/_shape')];
    delete require.cache[require.resolve('../../anthropic-usage')];
    return require('../../quota-adapters/anthropic');
}

test('adapter mapea el número real de /usage: pct=semanal, session.pct=sesión, status derivado', () => {
    const metricsDir = makeTmpMetrics();
    const now = Date.now();
    writeUsageCache(metricsDir, {
        schema: 1, source: 'claude -p /usage',
        capturedAt: new Date(now).toISOString(), capturedAtMs: now,
        sessionPct: 20, weeklyPct: 64,
        sessionResetsRaw: 'Jul 8, 10pm (America/Buenos_Aires)',
        weeklyResetsRaw: 'Jul 12, 9pm (America/Buenos_Aires)',
        sessionResetsAt: null, weeklyResetsAt: '2026-07-12T21:00:00.000Z',
    });

    const adapter = freshAdapter();
    const r = adapter({ metricsDir, now });

    assert.equal(r.provider, 'anthropic');
    assert.equal(r.adapterStatus, 'ok');
    assert.equal(r.errorReason, null);
    assert.equal(r.schemaVersion, 2);
    assert.equal(r.pct, 64);
    assert.equal(r.status, 'normal');      // 50 ≤ 64 < 75
    assert.equal(r.session.pct, 20);
    assert.equal(r.session.status, 'ok');  // < 50
    assert.equal(r.realPct, null);         // ya no hay calibración
    assert.equal(r.calibration, null);
    assert.equal(r.nextResetAt, '2026-07-12T21:00:00.000Z');
    assert.deepEqual(r.breakdown, []);
});

test('adapter clasifica critical cuando el semanal ≥ 90%', () => {
    const metricsDir = makeTmpMetrics();
    const now = Date.now();
    writeUsageCache(metricsDir, {
        schema: 1, capturedAtMs: now, sessionPct: 95, weeklyPct: 92,
    });
    const adapter = freshAdapter();
    const r = adapter({ metricsDir, now });
    assert.equal(r.adapterStatus, 'ok');
    assert.equal(r.status, 'critical');
    assert.equal(r.session.status, 'critical');
});

test('adapter con dato stale (> 30 min) degrada a unknown pero conserva el número', () => {
    const metricsDir = makeTmpMetrics();
    const now = Date.now();
    writeUsageCache(metricsDir, {
        schema: 1, capturedAtMs: now - 40 * 60 * 1000, // 40 min → stale
        sessionPct: 10, weeklyPct: 55,
    });
    const adapter = freshAdapter();
    const r = adapter({ metricsDir, now });
    assert.equal(r.adapterStatus, 'unknown');   // degradado
    assert.equal(r.pct, 55);                     // pero muestra el último número
    assert.match(r.errorReason, /stale/);
    assert.equal(r.usageSource.stale, true);
});

test('adapter sin cache de /usage → fallback degradado unknown, pct null (nunca 0)', () => {
    const metricsDir = makeTmpMetrics();
    const adapter = freshAdapter();
    const r = adapter({ metricsDir });
    assert.equal(r.adapterStatus, 'unknown');
    assert.equal(r.pct, null);
    assert.match(r.errorReason, /fallback degradado/);
});

test('adapter sin metricsDir devuelve error explícito (no lanza)', () => {
    const adapter = freshAdapter();
    const r = adapter({});
    assert.equal(r.adapterStatus, 'error');
    assert.match(r.errorReason, /metricsDir/);
    assert.equal(r.pct, null);
});

test('adapter es resiliente a cache corrupto (no lanza, degrada a unknown)', () => {
    const metricsDir = makeTmpMetrics();
    fs.writeFileSync(path.join(metricsDir, 'anthropic-usage.json'), 'not json {{{');
    const adapter = freshAdapter();
    const r = adapter({ metricsDir });
    assert.equal(r.adapterStatus, 'unknown');
    assert.equal(r.pct, null);
});

test('adapter NO spawnea al leer (getUsage read-only): sin cache y sin refresh explícito', () => {
    const metricsDir = makeTmpMetrics();
    let spawnCalls = 0;
    const adapter = freshAdapter();
    // spawnImpl no debería invocarse nunca porque el adapter no pide autoRefresh.
    const r = adapter({ metricsDir, spawnImpl: () => { spawnCalls++; throw new Error('no debe spawnear'); } });
    assert.equal(spawnCalls, 0);
    assert.equal(r.adapterStatus, 'unknown');
});
