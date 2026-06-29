// =============================================================================
// Tests quota-adapters/openai-codex.js — adapter real offline (#4202 M2b)
//
// Cubre:
//
//   * Con `snapshot.json` poblado (dailyByProvider del mes) → pct semanal real
//     = costMensual / cap * 100; bucket sesión "sin dato" (Codex no tiene 5h).
//   * Sin snapshot / sin entradas de Codex → pct null (NO 0% — security CA-#3).
//   * Cap hardcoded del budget (security CA-#2): budget inválido / > cap → error.
//   * Invariante offline (security CA-#6): cero HTTP en el fuente del adapter.
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

// Crea un metricsDir temporal con un snapshot.json con el dailyByProvider dado.
function tmpMetricsDir(dailyByProvider) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-quota-'));
    if (dailyByProvider != null) {
        fs.writeFileSync(path.join(dir, 'snapshot.json'),
            JSON.stringify({ dailyByProvider }), 'utf8');
    }
    return dir;
}

// 2026-06-15 UTC — mes corriente de referencia para los tests deterministas.
const NOW = Date.UTC(2026, 5, 15);

test('openai-codex con snapshot poblado devuelve pct semanal real (budget mensual)', () => {
    const adapter = freshAdapter();
    const cap = adapter.MAX_MONTHLY_BUDGET_USD; // 1000
    const dir = tmpMetricsDir([
        { day: '2026-06-01', provider: 'openai-codex', cost_usd: 100, sessions: 5 },
        { day: '2026-06-10', provider: 'openai-codex', cost_usd: 150, sessions: 7 },
        // Otro proveedor — NO debe contar.
        { day: '2026-06-10', provider: 'anthropic', cost_usd: 999, sessions: 3 },
        // Otro mes — NO debe contar.
        { day: '2026-05-31', provider: 'openai-codex', cost_usd: 500, sessions: 2 },
    ]);
    const r = adapter({ metricsDir: dir, now: NOW });

    assert.equal(r.adapterStatus, 'ok');
    // 250 / 1000 * 100 = 25
    assert.equal(r.pct, (250 / cap) * 100);
    assert.equal(r.status, 'ok'); // 25% < 50
    // Bucket sesión "sin dato": Codex no tiene ventana de 5h.
    assert.equal(r.session.pct, null, 'sesión debe ser "sin dato" (null)');
});

test('openai-codex satura el pct al 100% pero marca realPctCapped', () => {
    const adapter = freshAdapter();
    const dir = tmpMetricsDir([
        { day: '2026-06-05', provider: 'openai-codex', cost_usd: 1500, sessions: 99 },
    ]);
    const r = adapter({ metricsDir: dir, now: NOW });
    assert.equal(r.adapterStatus, 'ok');
    assert.equal(r.pct, 100, 'pct capeado a 100');
    assert.equal(r.realPctCapped, true);
    assert.equal(r.status, 'critical');
});

test('openai-codex sin snapshot devuelve pct null (NO 0%)', () => {
    const adapter = freshAdapter();
    const dir = tmpMetricsDir(null); // sin snapshot.json
    const r = adapter({ metricsDir: dir, now: NOW });
    assert.equal(r.pct, null, 'pct DEBE ser null, no 0 — "sin dato" explícito');
    assert.notEqual(r.adapterStatus, 'ok');
    assert.equal(r.session.pct, null);
});

test('openai-codex sin entradas de Codex en el mes devuelve pct null (no_quota)', () => {
    const adapter = freshAdapter();
    const dir = tmpMetricsDir([
        { day: '2026-06-10', provider: 'anthropic', cost_usd: 100, sessions: 3 },
        { day: '2026-05-10', provider: 'openai-codex', cost_usd: 100, sessions: 3 },
    ]);
    const r = adapter({ metricsDir: dir, now: NOW });
    assert.equal(r.adapterStatus, 'no_quota');
    assert.equal(r.pct, null, 'sin consumo del mes → null, nunca 0% falso');
});

test('openai-codex sin metricsDir devuelve sin dato (not_implemented, pct null)', () => {
    const adapter = freshAdapter();
    const r = adapter({});
    assert.equal(r.adapterStatus, 'not_implemented');
    assert.equal(r.pct, null);
    assert.equal(r.hoursUsed7d, null);
});

test('openai-codex rechaza budget negativo / no-numérico (security CA-#2)', () => {
    const adapter = freshAdapter();
    for (const bad of [-1, 'fifty', NaN, Infinity, [], {}]) {
        const r = adapter({ budgetUsd: bad });
        assert.equal(r.adapterStatus, 'error',
            `budget ${JSON.stringify(bad)} debe ser rechazado`);
        assert.match(r.errorReason, /budgetUsd/);
    }
});

test('openai-codex rechaza budget que excede el cap hardcoded (security CA-#2)', () => {
    const adapter = freshAdapter();
    const cap = adapter.MAX_MONTHLY_BUDGET_USD;
    assert.equal(typeof cap, 'number');
    assert.ok(cap > 0 && cap <= 10000, 'cap razonable hardcoded');

    const r = adapter({ budgetUsd: cap + 1 });
    assert.equal(r.adapterStatus, 'error');
    assert.match(r.errorReason, /cap|excede/);
});

test('openai-codex acepta budget exactamente igual al cap (boundary)', () => {
    const adapter = freshAdapter();
    const cap = adapter.MAX_MONTHLY_BUDGET_USD;
    // budget == cap es válido; sin metricsDir cae a "sin dato".
    const r = adapter({ budgetUsd: cap });
    assert.notEqual(r.adapterStatus, 'error',
        `budget = cap (${cap}) NO debe ser error`);
});

test('openai-codex mantiene shape canónico (todos los campos presentes)', () => {
    const adapter = freshAdapter();
    const r = adapter({});
    assert.equal(r.schemaVersion, 2);
    assert.deepEqual(r.breakdown, []);
    assert.equal(r.effectiveLimitHours, null);
    assert.equal(r.observedMaxHours, null);
    assert.equal(r.session.pct, null);
    assert.equal(r.session.status, 'unknown');
});

test('openai-codex: cap MAX_MONTHLY_BUDGET_USD permanece hardcoded en 1000 (security req#3)', () => {
    const adapter = freshAdapter();
    assert.equal(adapter.MAX_MONTHLY_BUDGET_USD, 1000,
        'subir el cap requiere revisión humana — no cambiar en silencio');
});

test('openai-codex: invariante offline — cero HTTP en el fuente (security CA-#6)', () => {
    const src = fs.readFileSync(
        path.join(__dirname, '..', '..', 'quota-adapters', 'openai-codex.js'), 'utf8');
    assert.ok(!/\bfetch\b|\baxios\b|https?\.request|node-fetch/.test(src),
        'el adapter NO debe hacer HTTP — todo offline desde snapshot.json');
});
