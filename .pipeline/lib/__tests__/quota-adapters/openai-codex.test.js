// =============================================================================
// Tests quota-adapters/openai-codex.js — adapter real desde el log de Codex (#4598)
//
// Cubre:
//
//   * Parse tolerante del `feedback_log_body` (prefijo "Received message {...}").
//   * Mapeo primary(5h)→sesión / secondary(7d)→semanal con used_percent + reset.
//   * Frescura (CA-3): evento viejo → degradado (`unknown`, pct null), NO stale.
//   * Sin evento legible → `no_usage_data`, pct null (NO 0% — security CA-#3).
//   * Body corrupto / shape inesperado → `error`, pct null.
//   * Invariante offline (security CA-#6): cero HTTP en el fuente del adapter.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

function freshAdapter() {
    delete require.cache[require.resolve('../../quota-adapters/openai-codex')];
    delete require.cache[require.resolve('../../quota-adapters/_shape')];
    return require('../../quota-adapters/openai-codex');
}

// Body real observado en `~/.codex/logs_2.sqlite` (#4598), con prefijo.
function makeBody({ primaryPct = 44, secondaryPct = 68, primaryReset = 1783552546, secondaryReset = 1784002587 } = {}) {
    return 'Received message ' + JSON.stringify({
        type: 'codex.rate_limits',
        plan_type: 'plus',
        rate_limits: {
            allowed: true,
            limit_reached: false,
            primary: { used_percent: primaryPct, window_minutes: 300, reset_after_seconds: 7546, reset_at: primaryReset },
            secondary: { used_percent: secondaryPct, window_minutes: 10080, reset_after_seconds: 457587, reset_at: secondaryReset },
        },
        code_review_rate_limits: null,
    });
}

// Inyector de `readLatestEvent` para no tocar el SQLite real.
function fakeReader(event) {
    return () => event;
}

// ts real observado (1783545001). Usamos un `now` justo después → fresco.
const EVENT_TS = 1783545001;
const NOW_FRESH = (EVENT_TS + 60) * 1000; // 1 min después.

test('codex mapea primary(5h)->sesion y secondary(7d)->semanal con el % real', () => {
    const adapter = freshAdapter();
    const r = adapter({
        now: NOW_FRESH,
        readEventImpl: fakeReader({ ts: EVENT_TS, body: makeBody({ primaryPct: 44, secondaryPct: 68 }) }),
    });
    assert.equal(r.adapterStatus, 'ok');
    // secondary (semanal) → top-level.
    assert.equal(r.pct, 68);
    assert.equal(r.status, 'normal'); // 68% → 50..75
    // primary (5h) → sesión.
    assert.equal(r.session.pct, 44);
    assert.equal(r.session.status, 'ok'); // 44% < 50
    // Resets propagados como ISO.
    assert.equal(r.nextResetAt, new Date(1784002587 * 1000).toISOString());
    assert.equal(r.weeklyResetsAtReported, new Date(1784002587 * 1000).toISOString());
    assert.equal(r.sessionResetsAt, new Date(1783552546 * 1000).toISOString());
});

test('codex: status refleja los cortes del pipeline (critical >=90 en la ventana correcta)', () => {
    const adapter = freshAdapter();
    const r = adapter({
        now: NOW_FRESH,
        readEventImpl: fakeReader({ ts: EVENT_TS, body: makeBody({ primaryPct: 95, secondaryPct: 30 }) }),
    });
    assert.equal(r.adapterStatus, 'ok');
    assert.equal(r.status, 'ok', 'semanal (secondary) 30% → ok');
    assert.equal(r.session.status, 'critical', 'sesión (primary) 95% → critical');
});

test('codex: evento stale -> degradado (unknown, pct null), NO muestra el % viejo (CA-3)', () => {
    const adapter = freshAdapter();
    const now = (EVENT_TS + 3 * 60 * 60) * 1000; // 3h después, umbral default 1h.
    const r = adapter({
        now,
        readEventImpl: fakeReader({ ts: EVENT_TS, body: makeBody() }),
    });
    assert.equal(r.adapterStatus, 'unknown', 'dato viejo → unknown, no ok');
    assert.equal(r.pct, null, 'NUNCA mostrar el % stale como actual');
    assert.equal(r.session.pct, null);
    assert.match(r.errorReason, /stale|inactivo/i);
});

test('codex: umbral de frescura configurable por sessionData.stalenessMs', () => {
    const adapter = freshAdapter();
    const now = (EVENT_TS + 120) * 1000; // 2 min después.
    // Con umbral de 1 min, 2 min es stale.
    const r = adapter({
        now,
        stalenessMs: 60 * 1000,
        readEventImpl: fakeReader({ ts: EVENT_TS, body: makeBody() }),
    });
    assert.equal(r.adapterStatus, 'unknown');
    assert.equal(r.pct, null);
});

test('codex: sin evento legible -> no_usage_data (pct null, NO 0%)', () => {
    const adapter = freshAdapter();
    const r = adapter({ now: NOW_FRESH, readEventImpl: fakeReader(null) });
    assert.equal(r.adapterStatus, 'no_usage_data');
    assert.notEqual(r.adapterStatus, 'no_quota', 'Codex tiene concepto de cuota');
    assert.equal(r.pct, null, 'sin dato → null, nunca 0% falso (security CA-#3)');
    assert.equal(r.status, 'unknown');
    assert.equal(r.session.pct, null);
});

test('codex: body corrupto -> error (pct null)', () => {
    const adapter = freshAdapter();
    const r = adapter({
        now: NOW_FRESH,
        readEventImpl: fakeReader({ ts: EVENT_TS, body: 'Received message {no-json' }),
    });
    assert.equal(r.adapterStatus, 'error');
    assert.equal(r.pct, null);
});

test('codex: evento sin used_percent valido -> error', () => {
    const adapter = freshAdapter();
    const body = 'Received message ' + JSON.stringify({
        type: 'codex.rate_limits',
        rate_limits: { primary: {}, secondary: {} },
    });
    const r = adapter({ now: NOW_FRESH, readEventImpl: fakeReader({ ts: EVENT_TS, body }) });
    assert.equal(r.adapterStatus, 'error');
    assert.equal(r.pct, null);
});

test('codex: parseRateLimits es tolerante al prefijo y valida el type', () => {
    const adapter = freshAdapter();
    const rl = adapter.parseRateLimits(makeBody({ primaryPct: 10, secondaryPct: 20 }));
    assert.ok(rl);
    assert.equal(rl.primary.used_percent, 10);
    assert.equal(rl.secondary.used_percent, 20);
    // No es un evento rate_limits → null.
    assert.equal(adapter.parseRateLimits('Received message {"type":"otra.cosa"}'), null);
    // Sin JSON → null.
    assert.equal(adapter.parseRateLimits('no hay json aca'), null);
    assert.equal(adapter.parseRateLimits(''), null);
    assert.equal(adapter.parseRateLimits(null), null);
});

test('codex: solo secondary legible -> semanal poblado, sesion sin dato', () => {
    const adapter = freshAdapter();
    const body = 'Received message ' + JSON.stringify({
        type: 'codex.rate_limits',
        rate_limits: { secondary: { used_percent: 55, reset_at: 1784002587 } },
    });
    const r = adapter({ now: NOW_FRESH, readEventImpl: fakeReader({ ts: EVENT_TS, body }) });
    assert.equal(r.adapterStatus, 'ok');
    assert.equal(r.pct, 55);
    assert.equal(r.session.pct, null);
});

test('codex: solo primary legible -> sesion poblada, semanal sin dato (status unknown)', () => {
    const adapter = freshAdapter();
    const body = 'Received message ' + JSON.stringify({
        type: 'codex.rate_limits',
        rate_limits: { primary: { used_percent: 33, reset_at: 1783552546 } },
    });
    const r = adapter({ now: NOW_FRESH, readEventImpl: fakeReader({ ts: EVENT_TS, body }) });
    assert.equal(r.adapterStatus, 'ok');
    assert.equal(r.pct, null, 'sin semanal → null, no fabricamos %');
    assert.equal(r.status, 'unknown');
    assert.equal(r.session.pct, 33);
});

test('codex: used_percent > 100 se capea a 100', () => {
    const adapter = freshAdapter();
    const r = adapter({
        now: NOW_FRESH,
        readEventImpl: fakeReader({ ts: EVENT_TS, body: makeBody({ primaryPct: 150, secondaryPct: 120 }) }),
    });
    assert.equal(r.pct, 100);
    assert.equal(r.session.pct, 100);
    assert.equal(r.status, 'critical');
});

test('codex: mantiene shape canonico (todos los campos presentes)', () => {
    const adapter = freshAdapter();
    const r = adapter({ now: NOW_FRESH, readEventImpl: fakeReader(null) });
    assert.equal(r.schemaVersion, 2);
    assert.deepEqual(r.breakdown, []);
    assert.equal(r.provider, 'openai-codex');
    assert.ok('session' in r);
});

test('codex: excepcion del reader -> degradado, no propaga (fail-secure)', () => {
    const adapter = freshAdapter();
    const r = adapter({
        now: NOW_FRESH,
        readEventImpl: () => { throw new Error('boom'); },
    });
    assert.equal(r.adapterStatus, 'no_usage_data');
    assert.equal(r.pct, null);
});

test('codex: invariante offline — cero HTTP en el fuente (security CA-#6)', () => {
    const src = fs.readFileSync(
        path.join(__dirname, '..', '..', 'quota-adapters', 'openai-codex.js'), 'utf8');
    assert.ok(!/\bfetch\b|\baxios\b|https?\.request|node-fetch/.test(src),
        'el adapter NO debe hacer HTTP — todo offline desde el SQLite local');
});

test('codex: no agrega dependencia SQLite nativa — usa el CLI sqlite3', () => {
    const src = fs.readFileSync(
        path.join(__dirname, '..', '..', 'quota-adapters', 'openai-codex.js'), 'utf8');
    assert.ok(!/require\(['"](better-sqlite3|sqlite3)['"]\)/.test(src),
        'sin dependencia nativa: se lee vía execFileSync del binario sqlite3');
    assert.ok(/execFileSync/.test(src), 'lee el SQLite con execFileSync(sqlite3)');
});
