'use strict';

// #4533 — Tests del agregador de cuota DISPONIBLE por proveedor × ventana.
// Cubre: fórmula available = 100 - consumido (clamp), reset propio por bucket,
// rótulos de ventana, modo event (Codex), estado "sin dato", y el seam de
// caché de muestras reales (recordSample/readCache).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const pq = require('../lib/provider-quota');

// Normalizado mínimo tal como lo produce normalizeProviderQuota (dashboard-slices).
function norm(provider, sessionPct, weeklyPct, conf) {
    return {
        provider,
        adapterStatus: 'ok',
        session: { pct: sessionPct, confidence: conf || 'fresh' },
        weekly: { pct: weeklyPct, confidence: conf || 'fresh' },
    };
}

test('available = 100 - consumido, con clamp 0..100', () => {
    assert.equal(pq._availableFromConsumed(0), 100);
    assert.equal(pq._availableFromConsumed(40), 60);
    assert.equal(pq._availableFromConsumed(100), 0);
    assert.equal(pq._availableFromConsumed(140), 0, 'consumo saturado > 100 → 0 disponible');
    assert.equal(pq._availableFromConsumed(-10), 100, 'consumo negativo → clamp 100');
    assert.equal(pq._availableFromConsumed(null), null, 'sin dato → null (no 0)');
});

test('Anthropic: available por bucket + ventana 5h/Sem + reset propio por bucket', () => {
    const adapterResult = {
        adapterStatus: 'ok',
        sessionResetsAt: '2026-07-06T23:00:00Z',
        weeklyResetsAtReported: '2026-07-12T21:00:00Z',
    };
    const n = norm('anthropic', 60.1, 100, 'fresh');
    pq.enrich('anthropic', n, adapterResult, { cache: {}, now: Date.parse('2026-07-06T20:00:00Z') });

    assert.equal(n.session.win, '5h');
    assert.equal(n.session.kind, 'short');
    assert.equal(n.session.mode, 'gauge');
    assert.ok(Math.abs(n.session.available - 39.9) < 1e-6, 'disponible = 100 - 60.1');
    assert.equal(n.session.resetAt, '2026-07-06T23:00:00Z', 'reset de sesión propio (5h)');

    assert.equal(n.weekly.win, 'Sem');
    assert.equal(n.weekly.available, 0, 'semanal 100% consumido → 0 disponible (AGOTADA)');
    assert.equal(n.weekly.resetAt, '2026-07-12T21:00:00Z', 'reset semanal propio, distinto del de sesión');
    assert.notEqual(n.session.resetAt, n.weekly.resetAt, 'reset NO compartido entre buckets');
});

test('Codex: mode event ("sin límite") en ambas ventanas, sin barra', () => {
    const n = norm('openai-codex', null, null, 'missing');
    pq.enrich('openai-codex', n, { adapterStatus: 'ok', status: 'ok' }, { cache: {}, now: Date.now() });
    assert.equal(n.session.mode, 'event');
    assert.equal(n.weekly.mode, 'event');
    assert.equal(n.session.eventOk, true, 'sin tope activo → eventOk true');
    assert.equal(n.session.win, 'Roll');
    assert.equal(n.weekly.win, 'Sem');
    assert.equal(n.session.available, null, 'event no tiene barra de %');
});

test('Codex: tope activo (status critical) → eventOk false', () => {
    const n = norm('openai-codex', null, null, 'missing');
    pq.enrich('openai-codex', n, { adapterStatus: 'ok', status: 'critical' }, { cache: {}, now: Date.now() });
    assert.equal(n.session.eventOk, false, 'status critical → tope activo');
});

test('Proveedor sin dato (Cerebras not_implemented): mode nodata + ventana Min/Día', () => {
    const n = norm('cerebras', null, null, 'missing');
    pq.enrich('cerebras', n, { adapterStatus: 'not_implemented' }, { cache: {}, now: Date.now() });
    assert.equal(n.session.mode, 'nodata');
    assert.equal(n.session.available, null, 'sin dato → null, jamás 0');
    assert.equal(n.session.win, 'Min');
    assert.equal(n.weekly.win, 'Día');
    assert.equal(n.session.resetAt, null);
});

test('Caché fresca (headers/eventos) tiene prioridad sobre el adapter', () => {
    const now = Date.parse('2026-07-06T20:00:00Z');
    const cache = {
        cerebras: {
            short: { available: 68, resetAt: '2026-07-06T20:01:00Z', capturedAt: now - 1000 },
        },
    };
    const n = norm('cerebras', null, null, 'missing');
    pq.enrich('cerebras', n, { adapterStatus: 'not_implemented' }, { cache, now });
    assert.equal(n.session.mode, 'gauge', 'con muestra cacheada fresca → gauge, no nodata');
    assert.equal(n.session.available, 68);
    assert.equal(n.session.confidence, 'fresh');
    assert.equal(n.session.resetAt, '2026-07-06T20:01:00Z');
    // el bucket largo sin muestra sigue en nodata
    assert.equal(n.weekly.mode, 'nodata');
});

test('Caché stale (más vieja que TTL) se ignora → cae a nodata', () => {
    const now = Date.now();
    const cache = {
        cerebras: { short: { available: 68, resetAt: null, capturedAt: now - (pq.CACHE_TTL_MS + 60000) } },
    };
    const n = norm('cerebras', null, null, 'missing');
    pq.enrich('cerebras', n, { adapterStatus: 'not_implemented' }, { cache, now });
    assert.equal(n.session.mode, 'nodata', 'muestra vencida no se usa');
});

test('recordSample persiste available derivado de remaining/limit y readCache lo lee', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pq-4533-'));
    const now = Date.now();
    const ok = pq.recordSample({
        provider: 'nvidia-nim', bucketKind: 'short',
        remaining: 900, limit: 1000, resetAt: '2026-07-06T20:01:00Z',
        now, pipelineDir: dir,
    });
    assert.equal(ok, true);
    const cache = pq.readCache(dir);
    assert.ok(cache['nvidia-nim'] && cache['nvidia-nim'].short, 'la muestra quedó cacheada');
    assert.equal(cache['nvidia-nim'].short.available, 90, 'available = 100 * remaining/limit');
    assert.equal(cache['nvidia-nim'].short.resetAt, '2026-07-06T20:01:00Z');

    // readCache defensivo ante archivo inexistente.
    assert.deepEqual(pq.readCache(path.join(dir, 'nope')), {});
    fs.rmSync(dir, { recursive: true, force: true });
});

test('recordSample rechaza input inválido sin lanzar', () => {
    assert.equal(pq.recordSample({ provider: '', remaining: 1, limit: 2 }), false);
    assert.equal(pq.recordSample({ provider: 'x', remaining: 1, limit: 0 }), false, 'limit 0 inválido');
    assert.equal(pq.recordSample(null), false);
});
