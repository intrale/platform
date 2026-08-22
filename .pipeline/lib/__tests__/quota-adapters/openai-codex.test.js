// =============================================================================
// Tests quota-adapters/openai-codex.js — adapter real desde los rollouts JSONL
// de Codex >= v0.145.0 (#4885, evolución de #4868/#4865).
//
// Cubre:
//
//   * Extracción del objeto `payload.rate_limits` desde una línea JSONL.
//   * Mapeo por `window_minutes` (5h→sesión / 7d→semanal), NO por posición
//     primary/secondary — en v0.145.0 el semanal viene en `primary`.
//   * Rename `reset_at` → `resets_at`.
//   * Frescura (CA-3): evento viejo → degradado (`unknown`, pct null), NO stale.
//   * Sin rollout legible → `no_usage_data`, pct null (NO 0% — security CA-#3).
//   * Shape inesperado → `error`, pct null.
//   * Selección del rollout más nuevo entre archivos por fecha.
//   * Invariante offline (security CA-#6): cero HTTP y cero proceso externo.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

function freshAdapter() {
    delete require.cache[require.resolve('../../quota-adapters/openai-codex')];
    delete require.cache[require.resolve('../../quota-adapters/_shape')];
    return require('../../quota-adapters/openai-codex');
}

// Objeto `rate_limits` como lo persiste Codex v0.145.0. En v0.145.0 el semanal
// viene en `primary` (window 10080) con `secondary: null`, pero el adapter debe
// clasificar por ventana, así que los tests usan ambas variantes.
function makeRateLimits({
    sessionPct = 44, weeklyPct = 68,
    sessionReset = 1783552546, weeklyReset = 1784002587,
    includeSession = true, includeWeekly = true,
} = {}) {
    const primary = includeWeekly
        ? { used_percent: weeklyPct, window_minutes: 10080, resets_at: weeklyReset }
        : null;
    const secondary = includeSession
        ? { used_percent: sessionPct, window_minutes: 300, resets_at: sessionReset }
        : null;
    return {
        limit_id: 'codex',
        limit_name: null,
        primary,
        secondary,
        credits: { has_credits: false, unlimited: false, balance: '0' },
        plan_type: 'plus',
    };
}

// Línea JSONL real (event_msg / token_count) que envuelve el rate_limits.
function makeLine(rateLimits, timestamp) {
    return JSON.stringify({
        timestamp,
        type: 'event_msg',
        payload: { type: 'token_count', info: {}, rate_limits: rateLimits },
    });
}

// Inyector de `readLatestEvent`: devuelve el evento ya extraído.
function fakeReader(event) {
    return () => event;
}

const EVENT_TS_ISO = '2026-07-23T19:38:32.183Z';
const EVENT_TS_MS = Date.parse(EVENT_TS_ISO);
const NOW_FRESH = EVENT_TS_MS + 60 * 1000; // 1 min después.

test('codex mapea por window_minutes: 5h->sesion, 7d->semanal, con el % real', () => {
    const adapter = freshAdapter();
    const r = adapter({
        now: NOW_FRESH,
        readEventImpl: fakeReader({
            tsMs: EVENT_TS_MS,
            rateLimits: makeRateLimits({ sessionPct: 44, weeklyPct: 68 }),
        }),
    });
    assert.equal(r.adapterStatus, 'ok');
    // semanal (window 10080) → top-level.
    assert.equal(r.pct, 68);
    assert.equal(r.status, 'normal'); // 68% → 50..75
    // sesión (window 300) → session.
    assert.equal(r.session.pct, 44);
    assert.equal(r.session.status, 'ok'); // 44% < 50
    // Resets (resets_at) propagados como ISO.
    assert.equal(r.nextResetAt, new Date(1784002587 * 1000).toISOString());
    assert.equal(r.weeklyResetsAtReported, new Date(1784002587 * 1000).toISOString());
    assert.equal(r.sessionResetsAt, new Date(1783552546 * 1000).toISOString());
});

test('codex clasifica por ventana aunque el semanal venga en primary (v0.145.0)', () => {
    const adapter = freshAdapter();
    // Caso real v0.145.0: primary=semanal (10080), secondary=null.
    const rateLimits = makeRateLimits({ weeklyPct: 73, includeSession: false });
    const r = adapter({ now: NOW_FRESH, readEventImpl: fakeReader({ tsMs: EVENT_TS_MS, rateLimits }) });
    assert.equal(r.adapterStatus, 'ok');
    assert.equal(r.pct, 73, 'primary con window 10080 se mapea a semanal, no a sesión');
    assert.equal(r.status, 'normal');
    assert.equal(r.session.pct, null, 'sin ventana de sesión → session sin dato');
});

test('codex: status refleja los cortes del pipeline (critical >=90 en la ventana correcta)', () => {
    const adapter = freshAdapter();
    const r = adapter({
        now: NOW_FRESH,
        readEventImpl: fakeReader({
            tsMs: EVENT_TS_MS,
            rateLimits: makeRateLimits({ sessionPct: 95, weeklyPct: 30 }),
        }),
    });
    assert.equal(r.adapterStatus, 'ok');
    assert.equal(r.status, 'ok', 'semanal 30% → ok');
    assert.equal(r.session.status, 'critical', 'sesión 95% → critical');
});

test('codex: evento stale -> degradado (unknown, pct null), NO muestra el % viejo (CA-3)', () => {
    const adapter = freshAdapter();
    const now = EVENT_TS_MS + 3 * 60 * 60 * 1000; // 3h después, umbral default 1h.
    const r = adapter({
        now,
        readEventImpl: fakeReader({ tsMs: EVENT_TS_MS, rateLimits: makeRateLimits() }),
    });
    assert.equal(r.adapterStatus, 'unknown', 'dato viejo → unknown, no ok');
    assert.equal(r.pct, null, 'NUNCA mostrar el % stale como actual');
    assert.equal(r.session.pct, null);
    assert.match(r.errorReason, /stale|inactivo/i);
});

test('codex: umbral de frescura configurable por sessionData.stalenessMs', () => {
    const adapter = freshAdapter();
    const now = EVENT_TS_MS + 120 * 1000; // 2 min después.
    const r = adapter({
        now,
        stalenessMs: 60 * 1000, // con umbral de 1 min, 2 min es stale.
        readEventImpl: fakeReader({ tsMs: EVENT_TS_MS, rateLimits: makeRateLimits() }),
    });
    assert.equal(r.adapterStatus, 'unknown');
    assert.equal(r.pct, null);
});

test('codex: evento sin timestamp -> degradado (unknown), no se garantiza frescura', () => {
    const adapter = freshAdapter();
    const r = adapter({
        now: NOW_FRESH,
        readEventImpl: fakeReader({ tsMs: null, rateLimits: makeRateLimits() }),
    });
    assert.equal(r.adapterStatus, 'unknown');
    assert.equal(r.pct, null);
});

test('codex: evento fechado en el futuro -> degradado (clock skew, no se da por fresco)', () => {
    const adapter = freshAdapter();
    // Evento 3 meses adelante del `now`: edad negativa. Sin guard pasaría el
    // chequeo de staleness y se mostraría como fresco un dato no confiable.
    const now = EVENT_TS_MS - 90 * 24 * 60 * 60 * 1000;
    const r = adapter({
        now,
        readEventImpl: fakeReader({ tsMs: EVENT_TS_MS, rateLimits: makeRateLimits() }),
    });
    assert.equal(r.adapterStatus, 'unknown');
    assert.equal(r.pct, null);
    assert.match(r.errorReason, /futuro|skew/i);
});

test('codex: cualquier timestamp futuro degrada, incluso un skew chico', () => {
    const adapter = freshAdapter();
    const now = EVENT_TS_MS - 60 * 1000; // evento 1 min en el futuro.
    const r = adapter({
        now,
        readEventImpl: fakeReader({ tsMs: EVENT_TS_MS, rateLimits: makeRateLimits({ weeklyPct: 50 }) }),
    });
    assert.equal(r.adapterStatus, 'unknown');
    assert.equal(r.pct, null);
    assert.match(r.errorReason, /futuro|skew/i);
});

test('codex: sin rollout legible -> no_usage_data (pct null, NO 0%)', () => {
    const adapter = freshAdapter();
    const r = adapter({ now: NOW_FRESH, readEventImpl: fakeReader(null) });
    assert.equal(r.adapterStatus, 'no_usage_data');
    assert.notEqual(r.adapterStatus, 'no_quota', 'Codex tiene concepto de cuota');
    assert.equal(r.pct, null, 'sin dato → null, nunca 0% falso (security CA-#3)');
    assert.equal(r.status, 'unknown');
    assert.equal(r.session.pct, null);
});

test('codex: rate_limits sin used_percent valido -> error', () => {
    const adapter = freshAdapter();
    const rateLimits = { primary: {}, secondary: {} };
    const r = adapter({ now: NOW_FRESH, readEventImpl: fakeReader({ tsMs: EVENT_TS_MS, rateLimits }) });
    assert.equal(r.adapterStatus, 'error');
    assert.equal(r.pct, null);
});

test('codex: solo semanal legible -> semanal poblado, sesion sin dato', () => {
    const adapter = freshAdapter();
    const rateLimits = { primary: { used_percent: 55, window_minutes: 10080, resets_at: 1784002587 } };
    const r = adapter({ now: NOW_FRESH, readEventImpl: fakeReader({ tsMs: EVENT_TS_MS, rateLimits }) });
    assert.equal(r.adapterStatus, 'ok');
    assert.equal(r.pct, 55);
    assert.equal(r.session.pct, null);
});

test('codex: solo sesion legible -> sesion poblada, semanal sin dato (status unknown)', () => {
    const adapter = freshAdapter();
    const rateLimits = { primary: { used_percent: 33, window_minutes: 300, resets_at: 1783552546 } };
    const r = adapter({ now: NOW_FRESH, readEventImpl: fakeReader({ tsMs: EVENT_TS_MS, rateLimits }) });
    assert.equal(r.adapterStatus, 'ok');
    assert.equal(r.pct, null, 'sin semanal → null, no fabricamos %');
    assert.equal(r.status, 'unknown');
    assert.equal(r.session.pct, 33);
});

test('codex: bucket sin window_minutes degrada sin clasificar por posición', () => {
    const adapter = freshAdapter();
    const rateLimits = { primary: { used_percent: 40, resets_at: 1783552546 } };
    const r = adapter({ now: NOW_FRESH, readEventImpl: fakeReader({ tsMs: EVENT_TS_MS, rateLimits }) });
    assert.equal(r.adapterStatus, 'error');
    assert.equal(r.pct, null, 'ventana desconocida no alimenta el semanal/gating');
    assert.equal(r.session.pct, null);
});

test('codex: used_percent > 100 se capea a 100', () => {
    const adapter = freshAdapter();
    const r = adapter({
        now: NOW_FRESH,
        readEventImpl: fakeReader({
            tsMs: EVENT_TS_MS,
            rateLimits: makeRateLimits({ sessionPct: 150, weeklyPct: 120 }),
        }),
    });
    assert.equal(r.pct, 100);
    assert.equal(r.session.pct, 100);
    assert.equal(r.status, 'critical');
});

test('codex: used_percent conserva 0 numérico y rechaza tipos coercibles', () => {
    const adapter = freshAdapter();
    for (const invalid of [null, '', '0', false, true, NaN, Infinity, -Infinity]) {
        const buckets = adapter.classifyBuckets({
            primary: { used_percent: invalid, window_minutes: 10080, resets_at: 1 },
        });
        assert.equal(buckets.weekly, null, `no debe aceptar ${String(invalid)}`);
    }
    const zero = adapter.classifyBuckets({
        primary: { used_percent: 0, window_minutes: 10080, resets_at: 1 },
    });
    assert.equal(zero.weekly.usedPercent, 0);
});

test('codex: normaliza porcentajes fuera de rango a [0,100]', () => {
    const adapter = freshAdapter();
    const low = adapter.classifyBuckets({
        primary: { used_percent: -4, window_minutes: 300, resets_at: 1 },
    });
    const high = adapter.classifyBuckets({
        primary: { used_percent: 104, window_minutes: 10080, resets_at: 1 },
    });
    assert.equal(low.session.usedPercent, 0);
    assert.equal(high.weekly.usedPercent, 100);
});

test('codex: window_minutes y resets_at no se coercionan', () => {
    const adapter = freshAdapter();
    for (const invalidWindow of [null, '10080', true, 0, -1, NaN, Infinity]) {
        const buckets = adapter.classifyBuckets({
            primary: { used_percent: 42, window_minutes: invalidWindow, resets_at: 1 },
        });
        assert.equal(buckets.weekly, null);
        assert.equal(buckets.session, null);
    }
    const buckets = adapter.classifyBuckets({
        primary: { used_percent: 42, window_minutes: 10080, resets_at: '1784002587' },
        secondary: { used_percent: 10, window_minutes: 300, resets_at: false },
    });
    assert.equal(buckets.weekly.resetAt, null);
    assert.equal(buckets.session.resetAt, null);
});

test('codex: resets_at inválido no fabrica una fecha', () => {
    const adapter = freshAdapter();
    const r = adapter({
        now: NOW_FRESH,
        readEventImpl: fakeReader({
            tsMs: EVENT_TS_MS,
            rateLimits: {
                primary: { used_percent: 42, window_minutes: 10080, resets_at: '1784002587' },
            },
        }),
    });
    assert.equal(r.pct, 42);
    assert.equal(r.nextResetAt, null);
    assert.equal(r.weeklyResetsAtReported, null);

    const outOfRange = adapter({
        now: NOW_FRESH,
        readEventImpl: fakeReader({
            tsMs: EVENT_TS_MS,
            rateLimits: {
                primary: { used_percent: 42, window_minutes: 10080, resets_at: Number.MAX_VALUE },
            },
        }),
    });
    assert.equal(outOfRange.nextResetAt, null);
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

// --- Helpers puros -----------------------------------------------------------

test('codex: extractLatestRateLimits toma el ULTIMO rate_limits del JSONL', () => {
    const adapter = freshAdapter();
    const rlOld = makeRateLimits({ weeklyPct: 10, includeSession: false });
    const rlNew = makeRateLimits({ weeklyPct: 88, includeSession: false });
    const content = [
        makeLine(rlOld, '2026-07-23T18:00:00.000Z'),
        JSON.stringify({ timestamp: '2026-07-23T18:30:00.000Z', type: 'response_item', payload: { type: 'message' } }),
        makeLine(rlNew, EVENT_TS_ISO),
    ].join('\n') + '\n';
    const ev = adapter.extractLatestRateLimits(content);
    assert.ok(ev);
    assert.equal(ev.tsMs, EVENT_TS_MS);
    assert.equal(ev.rateLimits.primary.used_percent, 88, 'toma el evento más nuevo, no el primero');
});

test('codex: extractLatestRateLimits tolera lineas parciales/corruptas', () => {
    const adapter = freshAdapter();
    const rl = makeRateLimits({ weeklyPct: 42, includeSession: false });
    // Primera línea partida (como quedaría un corte de cola) + una válida.
    const content = 'ts":"parcial","payload":{"rate_limits":{ roto\n' + makeLine(rl, EVENT_TS_ISO) + '\n';
    const ev = adapter.extractLatestRateLimits(content);
    assert.ok(ev);
    assert.equal(ev.rateLimits.primary.used_percent, 42);
});

test('codex: extractLatestRateLimits devuelve null sin eventos de cuota', () => {
    const adapter = freshAdapter();
    const content = JSON.stringify({ timestamp: EVENT_TS_ISO, type: 'response_item', payload: { type: 'message' } }) + '\n';
    assert.equal(adapter.extractLatestRateLimits(content), null);
    assert.equal(adapter.extractLatestRateLimits(''), null);
    assert.equal(adapter.extractLatestRateLimits(null), null);
});

test('codex: classifyBuckets mapea por window_minutes con umbral 1440', () => {
    const adapter = freshAdapter();
    const { session, weekly } = adapter.classifyBuckets({
        primary: { used_percent: 5, window_minutes: 10080, resets_at: 100 },
        secondary: { used_percent: 9, window_minutes: 300, resets_at: 200 },
    });
    assert.equal(weekly.usedPercent, 5);
    assert.equal(session.usedPercent, 9);
    assert.equal(adapter.WEEKLY_WINDOW_MIN_THRESHOLD, 1440);
});

// --- Lectura real de FS (integración liviana con archivos temporales) --------

test('codex: helpers cubren entradas inválidas, duplicados y cortes de status', () => {
    const adapter = freshAdapter();
    assert.deepEqual(adapter.classifyBuckets(null), { session: null, weekly: null });
    assert.deepEqual(adapter.classifyBuckets({ primary: 'inválido' }), { session: null, weekly: null });
    const duplicate = adapter.classifyBuckets({
        primary: { used_percent: 11, window_minutes: 10080, resets_at: 1 },
        secondary: { used_percent: 99, window_minutes: 10080, resets_at: 2 },
    });
    assert.equal(duplicate.weekly.usedPercent, 11);
    assert.equal(adapter.statusFromPct(49), 'ok');
    assert.equal(adapter.statusFromPct(50), 'normal');
    assert.equal(adapter.statusFromPct(75), 'warning');
    assert.equal(adapter.statusFromPct(90), 'critical');
    assert.deepEqual(adapter.listRecentRolloutFiles(null, 40), []);
    assert.equal(adapter.extractLatestRateLimits('{"payload":null,"rate_limits":true}\n'), null);
});

test('codex: readLatestEvent elige el evento global más reciente entre sesiones concurrentes', () => {
    const adapter = freshAdapter();
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-rollout-'));
    const dayDir = path.join(base, '2026', '07', '23');
    fs.mkdirSync(dayDir, { recursive: true });
    // La sesión que empezó antes recibe el evento global más reciente (12:00).
    // Ordenar sólo por filename elegiría incorrectamente 11:05/pct=20.
    fs.writeFileSync(
        path.join(dayDir, 'rollout-2026-07-23T10-00-00-aaaa.jsonl'),
        makeLine(makeRateLimits({ weeklyPct: 80, includeSession: false }), '2026-07-23T12:00:00.000Z') + '\n');
    fs.writeFileSync(
        path.join(dayDir, 'rollout-2026-07-23T11-00-00-bbbb.jsonl'),
        makeLine(makeRateLimits({ weeklyPct: 20, includeSession: false }), '2026-07-23T11:05:00.000Z') + '\n');

    const ev = adapter.readLatestEvent(base);
    assert.ok(ev);
    assert.equal(ev.tsMs, Date.parse('2026-07-23T12:00:00.000Z'));
    assert.equal(ev.rateLimits.primary.used_percent, 80,
        'toma el evento más reciente, aunque esté en la sesión iniciada antes');

    // End-to-end vía el adapter público, apuntando al dir temporal.
    const r = adapter({
        now: Date.parse('2026-07-23T12:01:00.000Z'),
        codexSessionsDir: base,
    });
    assert.equal(r.adapterStatus, 'ok');
    assert.equal(r.pct, 80);

    fs.rmSync(base, { recursive: true, force: true });
});

test('codex: readLatestEvent devuelve null si el dir no existe', () => {
    const adapter = freshAdapter();
    assert.equal(adapter.readLatestEvent(path.join(os.tmpdir(), 'no-existe-codex-xyz-4885')), null);
});

test('codex: enumera como máximo 40 rollouts regulares de la jerarquía esperada', () => {
    const adapter = freshAdapter();
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-limit-'));
    try {
        const dayDir = path.join(base, '2026', '07', '23');
        fs.mkdirSync(dayDir, { recursive: true });
        for (let i = 0; i < 45; i++) {
            fs.writeFileSync(path.join(dayDir, `rollout-${String(i).padStart(2, '0')}.jsonl`), '{}\n');
        }
        fs.writeFileSync(path.join(dayDir, 'otro.jsonl'), '{}\n');
        fs.mkdirSync(path.join(dayDir, 'rollout-directorio.jsonl'));
        fs.mkdirSync(path.join(base, '26', '07', '23'), { recursive: true });
        fs.writeFileSync(path.join(base, '26', '07', '23', 'rollout-fuera.jsonl'), '{}\n');

        const files = adapter.listRecentRolloutFiles(base, adapter.MAX_ROLLOUTS_TO_SCAN);
        assert.equal(files.length, 40);
        assert.ok(files.every((file) => path.basename(file).startsWith('rollout-')));
        assert.ok(files.every((file) => fs.statSync(file).isFile()));
        assert.ok(files.every((file) => file.includes(`${path.sep}2026${path.sep}07${path.sep}23${path.sep}`)));
    } finally {
        fs.rmSync(base, { recursive: true, force: true });
    }
});

test('codex: omite symlinks aunque apunten a un rollout válido', (t) => {
    const adapter = freshAdapter();
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-symlink-'));
    try {
        const dayDir = path.join(base, '2026', '07', '23');
        fs.mkdirSync(dayDir, { recursive: true });
        const outside = path.join(base, 'outside.jsonl');
        fs.writeFileSync(outside, makeLine(makeRateLimits(), EVENT_TS_ISO) + '\n');
        const link = path.join(dayDir, 'rollout-link.jsonl');
        try {
            fs.symlinkSync(outside, link, 'file');
        } catch (error) {
            t.skip(`symlink no disponible en este entorno: ${error.code}`);
            return;
        }
        assert.deepEqual(adapter.listRecentRolloutFiles(base, 40), []);
        assert.equal(adapter.readLatestEvent(base), null);
    } finally {
        fs.rmSync(base, { recursive: true, force: true });
    }
});

test('codex: sólo lee los últimos 512 KiB de un rollout grande', () => {
    const adapter = freshAdapter();
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-tail-'));
    try {
        const file = path.join(base, 'rollout-large.jsonl');
        const old = makeLine(makeRateLimits({ weeklyPct: 99 }), '2026-07-23T10:00:00.000Z') + '\n';
        const filler = 'x'.repeat(adapter.ROLLOUT_TAIL_BYTES + 128) + '\n';
        const latest = makeLine(makeRateLimits({ weeklyPct: 7 }), EVENT_TS_ISO) + '\n';
        fs.writeFileSync(file, old + filler + latest);
        const tail = adapter.readFileTail(file, adapter.ROLLOUT_TAIL_BYTES);
        assert.ok(Buffer.byteLength(tail, 'utf8') <= adapter.ROLLOUT_TAIL_BYTES);
        assert.ok(!tail.includes('"used_percent":99'));
        assert.equal(adapter.extractLatestRateLimits(tail).rateLimits.primary.used_percent, 7);
    } finally {
        fs.rmSync(base, { recursive: true, force: true });
    }
});

// --- Aislamiento del origen (hook de tests hermeticos) -----------------------
//
// Los rollouts viven en `~/.codex/sessions`: estado GLOBAL de la máquina que NO
// depende de `PIPELINE_DIR_OVERRIDE`. Las suites que ejercitan la reconciliación
// de cuota (#4865: dispatch-billing-flag, reduced-mode) necesitan neutralizar esa
// fuente para no depender de si el operador usó Codex hace un rato. El hook es
// `CODEX_SESSIONS_DIR`; estos tests lo blindan como contrato.

test('codex: readFileTail degrada archivos ausentes y maneja archivo vacío', () => {
    const adapter = freshAdapter();
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-tail-errors-'));
    try {
        const empty = path.join(base, 'empty.jsonl');
        fs.writeFileSync(empty, '');
        assert.equal(adapter.readFileTail(empty, 1024), '');
        assert.equal(adapter.readFileTail(path.join(base, 'missing.jsonl'), 1024), null);
    } finally {
        fs.rmSync(base, { recursive: true, force: true });
    }
});

test('codex: CODEX_SESSIONS_DIR redirige el origen de los rollouts', () => {
    const adapter = freshAdapter();
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-envdir-'));
    const dayDir = path.join(base, '2026', '07', '23');
    fs.mkdirSync(dayDir, { recursive: true });
    fs.writeFileSync(
        path.join(dayDir, 'rollout-2026-07-23T16-38-03-cccc.jsonl'),
        makeLine(makeRateLimits({ weeklyPct: 42, includeSession: false }), EVENT_TS_ISO) + '\n');

    const prev = process.env.CODEX_SESSIONS_DIR;
    try {
        process.env.CODEX_SESSIONS_DIR = base;
        const r = adapter({ now: EVENT_TS_MS + 60 * 1000 });
        assert.equal(r.adapterStatus, 'ok');
        assert.equal(r.pct, 42, 'lee del dir apuntado por el env, no de ~/.codex/sessions');
    } finally {
        if (prev === undefined) delete process.env.CODEX_SESSIONS_DIR;
        else process.env.CODEX_SESSIONS_DIR = prev;
        fs.rmSync(base, { recursive: true, force: true });
    }
});

test('codex: CODEX_SESSIONS_DIR a un dir vacío → no_usage_data (aísla tests)', () => {
    const adapter = freshAdapter();
    const prev = process.env.CODEX_SESSIONS_DIR;
    try {
        process.env.CODEX_SESSIONS_DIR = path.join(os.tmpdir(), 'codex-sessions-vacio-4885');
        const r = adapter({ now: EVENT_TS_MS });
        assert.equal(r.adapterStatus, 'no_usage_data',
            'sin dato canónico ⇒ la reconciliación de #4865 queda fail-closed');
        assert.equal(r.pct, null);
    } finally {
        if (prev === undefined) delete process.env.CODEX_SESSIONS_DIR;
        else process.env.CODEX_SESSIONS_DIR = prev;
    }
});

test('codex: el arg explícito codexSessionsDir gana sobre CODEX_SESSIONS_DIR', () => {
    const adapter = freshAdapter();
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-prec-'));
    const dayDir = path.join(base, '2026', '07', '23');
    fs.mkdirSync(dayDir, { recursive: true });
    fs.writeFileSync(
        path.join(dayDir, 'rollout-2026-07-23T16-38-03-dddd.jsonl'),
        makeLine(makeRateLimits({ weeklyPct: 33, includeSession: false }), EVENT_TS_ISO) + '\n');

    const prev = process.env.CODEX_SESSIONS_DIR;
    try {
        process.env.CODEX_SESSIONS_DIR = path.join(os.tmpdir(), 'codex-env-ignorado-4885');
        const r = adapter({ now: EVENT_TS_MS + 60 * 1000, codexSessionsDir: base });
        assert.equal(r.pct, 33, 'precedencia: arg explícito → env → default ~/.codex/sessions');
    } finally {
        if (prev === undefined) delete process.env.CODEX_SESSIONS_DIR;
        else process.env.CODEX_SESSIONS_DIR = prev;
        fs.rmSync(base, { recursive: true, force: true });
    }
});

test('codex: errores degradados no filtran paths ni transcript', () => {
    const adapter = freshAdapter();
    const secretPath = path.join(os.tmpdir(), 'sesion-secreta-4898');
    const transcript = 'CONTENIDO_PRIVADO_4898';
    const results = [
        adapter({ codexSessionsDir: secretPath, now: NOW_FRESH }),
        adapter({
            now: NOW_FRESH,
            readEventImpl: () => { throw new Error(`${secretPath}: ${transcript}`); },
        }),
        adapter({
            now: NOW_FRESH,
            readEventImpl: fakeReader({ tsMs: null, rateLimits: makeRateLimits() }),
        }),
    ];
    for (const result of results) {
        const serialized = JSON.stringify(result);
        assert.ok(!serialized.includes(secretPath));
        assert.ok(!serialized.includes(transcript));
        assert.equal(result.pct, null);
    }
});

test('codex: no usa lectura completa para los rollouts', () => {
    const src = fs.readFileSync(
        path.join(__dirname, '..', '..', 'quota-adapters', 'openai-codex.js'), 'utf8');
    assert.ok(!/readFileSync/.test(src));
});

// --- Invariantes de seguridad ------------------------------------------------

test('codex: invariante offline — cero HTTP en el fuente (security CA-#6)', () => {
    const src = fs.readFileSync(
        path.join(__dirname, '..', '..', 'quota-adapters', 'openai-codex.js'), 'utf8');
    assert.ok(!/\bfetch\b|\baxios\b|https?\.request|node-fetch/.test(src),
        'el adapter NO debe hacer HTTP — todo offline desde los rollouts locales');
});

test('codex: sin proceso externo ni dependencia nativa — solo lectura fs', () => {
    const src = fs.readFileSync(
        path.join(__dirname, '..', '..', 'quota-adapters', 'openai-codex.js'), 'utf8');
    assert.ok(!/require\(['"](better-sqlite3|sqlite3)['"]\)/.test(src),
        'sin dependencia SQLite nativa');
    assert.ok(!/child_process|execFileSync|execSync|spawn/.test(src),
        'sin proceso externo: los rollouts se leen con fs, no con sqlite3 CLI');
    assert.ok(/require\('fs'\)/.test(src), 'lee los rollouts con el módulo fs');
});
