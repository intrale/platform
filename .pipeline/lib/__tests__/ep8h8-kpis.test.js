// =============================================================================
// ep8h8-kpis.test.js — #3961 EP8-H8 (KPIs → sparklines, umbrales y métricas de
// voz/entregables). Cubre la capa de datos:
//   - sherlockPrecisionSlice: breakdown by_provider + insufficient_sample.
//   - voiceLatencySlice: p95 sobre latency_ms + insufficient_sample (fixtures).
//   - dailyBuckets: bucketización 7/30d con timestamps controlados.
//   - dashboard-thresholds: default seguro / clamp / prototype-pollution (CA-9).
//   - computeThresholdAlerts: alertas derivadas por umbral excedido (CA-6).
//
// Diseño: FS real sobre mkdtemp (sin red, sin shell), igual que las suites
// hermanas de slices.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const slices = require('../dashboard-slices');
const thresholds = require('../dashboard-thresholds');

// Instante fijo para reproducibilidad de las ventanas temporales.
const NOW = Date.parse('2026-06-10T12:00:00.000Z');
const DAY = 24 * 3600 * 1000;

function mkPipelineDir() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ep8h8-'));
    fs.mkdirSync(path.join(dir, 'audit'), { recursive: true });
    return dir;
}

function sherlockRecord({ correcta, provider, tsMs }) {
    return {
        timestamp: new Date(tsMs != null ? tsMs : NOW).toISOString(),
        claim: 'x', canonical_command: 'y', stdout: null, stderr: null,
        resultado: correcta ? 'true' : 'false',
        commander_vs_sherlock: 'consistent',
        resolucion: correcta ? 'accepted' : 'rejected',
        provider: provider || undefined,
        hash_prev: 'a', hash_self: 'b', created_at: new Date(NOW).toISOString(),
    };
}

function writeSherlock(dir, session, records) {
    const file = path.join(dir, 'audit', `sherlock-${session}.jsonl`);
    fs.writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

// -----------------------------------------------------------------------------
// CA-5a — by_provider.
// -----------------------------------------------------------------------------
test('CA-5a: sherlockPrecisionSlice desglosa by_provider con tasa de rechazo', () => {
    const dir = mkPipelineDir();
    const recs = [
        // anthropic: 6 correctas + 4 incorrectas = 10 totales → rejection 0.4
        ...Array.from({ length: 6 }, () => sherlockRecord({ correcta: true, provider: 'anthropic' })),
        ...Array.from({ length: 4 }, () => sherlockRecord({ correcta: false, provider: 'anthropic' })),
        // openai: 2 totales → insufficient_sample (< 5)
        sherlockRecord({ correcta: true, provider: 'openai' }),
        sherlockRecord({ correcta: false, provider: 'openai' }),
    ];
    writeSherlock(dir, 'caso1', recs);
    const out = slices.sherlockPrecisionSlice({}, { PIPELINE: dir, now: NOW });

    assert.ok(out.by_provider, 'expone by_provider');
    const a = out.by_provider.anthropic;
    assert.equal(a.totales, 10);
    assert.equal(a.incorrectas, 4);
    assert.equal(a.rejection_rate, 0.4);
    assert.equal(a.insufficient_sample, false);
    const o = out.by_provider.openai;
    assert.equal(o.totales, 2);
    assert.equal(o.insufficient_sample, true, 'muestra baja por provider → insufficient');
});

test('CA-5a: records sin provider NO crean clave espuria y no contaminan by_provider', () => {
    const dir = mkPipelineDir();
    writeSherlock(dir, 'caso2', [
        sherlockRecord({ correcta: true }),   // sin provider
        sherlockRecord({ correcta: false }),  // sin provider
    ]);
    const out = slices.sherlockPrecisionSlice({}, { PIPELINE: dir, now: NOW });
    assert.deepEqual(Object.keys(out.by_provider), [], 'sin claves por provider');
    assert.equal(out.totales, 2, 'pero sí cuentan en el global');
});

test('SEC-3: provider con key peligrosa (__proto__) no contamina el prototipo', () => {
    const dir = mkPipelineDir();
    writeSherlock(dir, 'caso3', [sherlockRecord({ correcta: false, provider: '__proto__' })]);
    const out = slices.sherlockPrecisionSlice({}, { PIPELINE: dir, now: NOW });
    assert.equal(({}).polluted, undefined);
    assert.ok(!Object.prototype.hasOwnProperty.call(out.by_provider, '__proto__'));
});

// -----------------------------------------------------------------------------
// CA-2 — sparkline diaria de sherlock.
// -----------------------------------------------------------------------------
test('CA-2: spark7d de precisión refleja precisión por día', () => {
    const dir = mkPipelineDir();
    const H = 3600 * 1000;
    // Bucketización rolling 7×24h: bucket 6 = últimas 24h, bucket 5 = [-2d,-1d].
    // Bucket 5 (hace ~2 días, mid-bucket): 1 correcta + 1 incorrecta → 0.5.
    // Bucket 6 (hoy): 1 correcta → 1.0.
    writeSherlock(dir, 'caso4', [
        sherlockRecord({ correcta: true, tsMs: NOW - 2 * DAY + 6 * H }),
        sherlockRecord({ correcta: false, tsMs: NOW - 2 * DAY + 6 * H }),
        sherlockRecord({ correcta: true, tsMs: NOW - 1 * H }),
    ]);
    const out = slices.sherlockPrecisionSlice({}, { PIPELINE: dir, now: NOW });
    assert.equal(out.spark7d.length, 7);
    assert.equal(out.spark7d[5], 0.5, 'bucket 5 precisión 0.5');
    assert.equal(out.spark7d[6], 1, 'bucket 6 (hoy) precisión 1.0');
});

// -----------------------------------------------------------------------------
// CA-5c — voiceLatencySlice.
// -----------------------------------------------------------------------------
function mkRepoWithTts(events) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ep8h8-repo-'));
    fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
    fs.writeFileSync(
        path.join(dir, '.claude', 'activity-log.jsonl'),
        events.map((e) => JSON.stringify(e)).join('\n') + '\n');
    return dir;
}

test('CA-5c: voiceLatencySlice computa p95 sobre latency_ms con muestra suficiente', () => {
    const events = [];
    // 10 eventos tts:generated con latency_ms 100..1000 (hoy).
    for (let i = 1; i <= 10; i++) {
        events.push({ event: 'tts:generated', latency_ms: i * 100, ts: new Date(NOW).toISOString() });
    }
    const repo = mkRepoWithTts(events);
    const out = slices.voiceLatencySlice({}, { REPO_ROOT: repo, now: NOW });
    assert.equal(out.insufficient_sample, false);
    assert.equal(out.count, 10);
    assert.ok(out.p95_ms >= 900 && out.p95_ms <= 1000, `p95 en rango alto, got ${out.p95_ms}`);
    assert.equal(out.spark7d.length, 7);
});

test('CA-5c: muestra baja (<5) → insufficient_sample, sin p95 engañoso', () => {
    const repo = mkRepoWithTts([
        { event: 'tts:generated', latency_ms: 200, ts: new Date(NOW).toISOString() },
    ]);
    const out = slices.voiceLatencySlice({}, { REPO_ROOT: repo, now: NOW });
    assert.equal(out.insufficient_sample, true);
    assert.equal(out.p95_ms, null);
    assert.equal(out.count, 1);
});

test('CA-5c/SEC-2: records sin latency_ms se ignoran (no contaminan el p95)', () => {
    const events = [{ event: 'tts:generated', audio_seconds: 5, ts: new Date(NOW).toISOString() }];
    for (let i = 0; i < 6; i++) events.push({ event: 'tts:generated', latency_ms: 500, ts: new Date(NOW).toISOString() });
    const repo = mkRepoWithTts(events);
    const out = slices.voiceLatencySlice({}, { REPO_ROOT: repo, now: NOW });
    assert.equal(out.count, 6, 'sólo los que traen latency_ms');
    assert.equal(out.p95_ms, 500);
});

test('CA-5c: activity-log ausente → degrade limpio (insufficient, sin throw)', () => {
    const out = slices.voiceLatencySlice({}, { REPO_ROOT: path.join(os.tmpdir(), 'no-existe-ep8h8'), now: NOW });
    assert.equal(out.insufficient_sample, true);
    assert.equal(out.count, 0);
    assert.deepEqual(out.spark7d, [0, 0, 0, 0, 0, 0, 0]);
});

// -----------------------------------------------------------------------------
// CA-1 — bucketización 7/30d.
// -----------------------------------------------------------------------------
test('CA-1: dailyBuckets cuenta por día con timestamps controlados', () => {
    const H = 3600 * 1000;
    const items = [
        { ts: NOW - 2 * DAY + 6 * H }, { ts: NOW - 2 * DAY + 6 * H },  // 2 en bucket 5
        { ts: NOW - 1 * H },                                           // 1 en bucket 6 (hoy)
        { ts: NOW - 30 * DAY },                                        // fuera de ventana de 7d
    ];
    const week = slices.dailyBuckets(items, { days: 7, now: NOW, agg: 'count' });
    assert.equal(week.length, 7);
    assert.equal(week[5], 2, 'bucket 5 = hace ~2 días');
    assert.equal(week[6], 1, 'bucket 6 = hoy');
    assert.equal(week.reduce((a, b) => a + b, 0), 3, 'el de hace 30 días queda fuera');

    const month = slices.dailyBuckets(items, { days: 30, now: NOW, agg: 'count' });
    assert.equal(month.length, 30);
    assert.equal(month.reduce((a, b) => a + b, 0), 4, 'a 30d entra el viejo');
});

test('CA-1: dailyBuckets agrega p95 por bucket', () => {
    const items = [
        { ts: NOW, v: 10 }, { ts: NOW, v: 20 }, { ts: NOW, v: 100 },
    ];
    const out = slices.dailyBuckets(items, { days: 1, now: NOW, agg: 'p95' });
    assert.equal(out.length, 1);
    assert.ok(out[0] > 20 && out[0] <= 100);
});

// -----------------------------------------------------------------------------
// CA-9 / SEC-3 — umbrales de config.
// -----------------------------------------------------------------------------
test('CA-9: thresholds ausentes → defaults seguros', () => {
    const t = thresholds.loadThresholds(null);
    assert.equal(t.sherlock_precision_target, 0.90);
    assert.equal(t.deliverables_min_pct, 80);
    assert.equal(t.voice_p95_max_ms, 8000);
});

test('CA-9: valor inválido (string no numérica) → default; numérica string → number', () => {
    const t = thresholds.loadThresholds({ dashboard: { thresholds: {
        deliverables_min_pct: 'abc', voice_p95_max_ms: '12000',
    } } });
    assert.equal(t.deliverables_min_pct, 80, 'inválido → default');
    assert.equal(t.voice_p95_max_ms, 12000, 'string numérica coercionada');
});

test('CA-9: valor fuera de rango → clamp al borde', () => {
    const t = thresholds.loadThresholds({ dashboard: { thresholds: {
        sherlock_precision_target: 5,      // > 1 → 1
        dora_fail_rate_max_pct: -10,       // < 0 → 0
    } } });
    assert.equal(t.sherlock_precision_target, 1);
    assert.equal(t.dora_fail_rate_max_pct, 0);
});

test('SEC-3: bloque thresholds con __proto__ no contamina Object.prototype', () => {
    const malicious = JSON.parse('{"dashboard":{"thresholds":{"__proto__":{"polluted":true}}}}');
    const t = thresholds.loadThresholds(malicious);
    assert.equal(({}).polluted, undefined, 'sin prototype pollution');
    assert.equal(t.sherlock_precision_target, 0.90, 'defaults intactos');
});

// -----------------------------------------------------------------------------
// CA-6 — alertas de umbral.
// -----------------------------------------------------------------------------
test('CA-6: computeThresholdAlerts genera alertas para KPIs que exceden umbral', () => {
    const t = thresholds.loadThresholds(null);
    const kpis = {
        sherlock: {
            ratio: 0.5, insufficient_sample: false,
            same_provider_ratio: 0.3,
            by_provider: { anthropic: { rejection_rate: 0.5, insufficient_sample: false } },
        },
        voice: { p95_ms: 12000, insufficient_sample: false },
        deliverables: { skills: [{ skill: 'qa', pct: 50, total: 4 }] },
        dora: { leadTimeMs: 8 * 3600000, throughputPerDay: 1, failRatePct: 40 },
    };
    const alerts = slices.computeThresholdAlerts(kpis, t);
    const ids = alerts.map((a) => a.id);
    assert.ok(ids.includes('sherlock_precision'));
    assert.ok(ids.includes('sherlock_same_provider'));
    assert.ok(ids.includes('sherlock_provider:anthropic'));
    assert.ok(ids.includes('voice_p95'));
    assert.ok(ids.includes('deliverables:qa'));
    assert.ok(ids.includes('dora_lead_time'));
    assert.ok(ids.includes('dora_throughput'));
    assert.ok(ids.includes('dora_fail_rate'));
});

test('CA-6: KPIs dentro de rango → sin alertas; insufficient_sample no alerta', () => {
    const t = thresholds.loadThresholds(null);
    const alerts = slices.computeThresholdAlerts({
        sherlock: { ratio: 0.95, insufficient_sample: false, same_provider_ratio: 0.05, by_provider: {} },
        voice: { p95_ms: null, insufficient_sample: true },
        deliverables: { skills: [{ skill: 'qa', pct: 95, total: 10 }] },
        dora: { leadTimeMs: 3600000, throughputPerDay: 5, failRatePct: 5 },
    }, t);
    assert.deepEqual(alerts, []);
});

test('CA-6: alertTraySlice expone threshold_alerts cuando ctx trae kpis+thresholds', () => {
    const t = thresholds.loadThresholds(null);
    const ctx = {
        kpis: { sherlock: { ratio: 0.5, insufficient_sample: false, same_provider_ratio: 0.05, by_provider: {} } },
        thresholds: t,
    };
    const out = slices.alertTraySlice({}, ctx);
    assert.ok(Array.isArray(out.threshold_alerts));
    assert.ok(out.threshold_alerts.some((a) => a.id === 'sherlock_precision'));
});
