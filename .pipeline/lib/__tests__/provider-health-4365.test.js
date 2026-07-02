// =============================================================================
// provider-health-4365.test.js — Re-probe activo + desambiguación del enum
// para des-atascar el estado de salud de providers (#4365).
//
// Cubre:
//   - CA-1/CA-3: un provider (Codex) en `no_usage_data`/`no_quota` con re-probe
//     OK permanece DISPONIBLE para el fallback (fail-open reforzado) y expone la
//     señal `reprobe.healthy`.
//   - CA-3 (audit): la transición de salud del re-probe queda registrada.
//   - CA-4: el re-probe reusa exclusivamente el probe offline `probeCodexHealth`
//     (spawn --version), sin generación real ni HTTP, y está rate-limited.
//   - CA-5 (security req#5): un provider realmente `critical` (adapter OK +
//     status critical) NO se re-probe ni se reincorpora — sigue gated.
//   - El re-probe SOLO aplica a openai-codex, nunca a otros providers.
//
// Cero spawn real (probeCodexImpl inyectado), cero disco (state impls inyectados).
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const providerHealth = require('../provider-health');

// Quota inyectable: fuerza un adapterStatus/status/pct dado para el canónico.
function quotaImpl(v) {
    return (canonical) => ({ provider: canonical, ...v });
}

// =============================================================================
// CA-1 / CA-3 — no_usage_data + probe OK → provider disponible (fail-open)
// =============================================================================

test('CA-1/CA-3: openai-codex en no_usage_data con probe OK permanece disponible (no gated)', () => {
    let probeCalls = 0;
    const audits = [];
    const r = providerHealth.assessProviderQuota('openai-codex', {
        quotaUsageImpl: quotaImpl({ adapterStatus: 'no_usage_data', status: 'unknown', pct: null }),
        probeCodexImpl: () => { probeCalls += 1; return { ok: true }; },
        reprobeStateReadImpl: () => null,
        reprobeStateWriteImpl: () => {},
        auditImpl: (e) => audits.push(e),
        now: 1_000_000,
    });

    assert.equal(r.gated, false, 'no_usage_data es fail-open — nunca gatea');
    assert.equal(r.reason_code, null, 'sin gateo → reason_code null (reprobe NO lo toca)');
    assert.ok(r.reprobe, 'debe exponer el resultado del re-probe');
    assert.equal(r.reprobe.healthy, true, 'probe OK → healthy');
    assert.equal(probeCalls, 1, 'el re-probe debe ejecutarse una vez');
    // Transición unknown → healthy debe quedar auditada (OWASP A09).
    assert.equal(audits.length, 1, 'la transición de salud debe auditarse');
    assert.equal(audits[0].provider, 'openai-codex');
    assert.equal(audits[0].to, 'healthy');
});

test('CA-3: no_quota (legacy) en openai-codex también dispara el re-probe (fail-open)', () => {
    let probeCalls = 0;
    const r = providerHealth.assessProviderQuota('openai-codex', {
        quotaUsageImpl: quotaImpl({ adapterStatus: 'no_quota', status: 'no_quota', pct: null }),
        probeCodexImpl: () => { probeCalls += 1; return { ok: true }; },
        reprobeStateReadImpl: () => null,
        reprobeStateWriteImpl: () => {},
        auditImpl: () => {},
        now: 2_000_000,
    });
    assert.equal(r.gated, false);
    assert.equal(probeCalls, 1);
    assert.equal(r.reprobe.healthy, true);
});

// =============================================================================
// CA-4 — rate-limit: dentro del intervalo mínimo NO se re-spawnea
// =============================================================================

test('CA-4: re-probe rate-limited — reusa el estado reciente sin volver a spawnear', () => {
    let probeCalls = 0;
    const lastTs = 5_000_000;
    const r = providerHealth.assessProviderQuota('openai-codex', {
        quotaUsageImpl: quotaImpl({ adapterStatus: 'no_usage_data', status: 'unknown', pct: null }),
        probeCodexImpl: () => { probeCalls += 1; return { ok: true }; },
        // Estado previo fresco (probe hace 1s, dentro del intervalo de 60s).
        reprobeStateReadImpl: () => ({ ts: lastTs, healthy: true }),
        reprobeStateWriteImpl: () => {},
        auditImpl: () => {},
        reprobeMinIntervalMs: 60_000,
        now: lastTs + 1_000,
    });
    assert.equal(probeCalls, 0, 'dentro del rate-limit NO debe spawnear de nuevo');
    assert.equal(r.reprobe.cached, true, 'debe reutilizar el estado persistido');
    assert.equal(r.reprobe.healthy, true);
});

test('CA-4: pasado el intervalo mínimo, el re-probe vuelve a ejecutarse', () => {
    let probeCalls = 0;
    const lastTs = 5_000_000;
    const r = providerHealth.assessProviderQuota('openai-codex', {
        quotaUsageImpl: quotaImpl({ adapterStatus: 'no_usage_data', status: 'unknown', pct: null }),
        probeCodexImpl: () => { probeCalls += 1; return { ok: false }; },
        reprobeStateReadImpl: () => ({ ts: lastTs, healthy: true }),
        reprobeStateWriteImpl: () => {},
        auditImpl: () => {},
        reprobeMinIntervalMs: 60_000,
        now: lastTs + 120_000, // 2 min → fuera del rate-limit
    });
    assert.equal(probeCalls, 1, 'fuera del rate-limit debe re-ejecutar el probe');
    assert.equal(r.reprobe.healthy, false, 'probe --version falló → unhealthy');
});

// =============================================================================
// CA-5 (security req#5) — un critical real NO se re-probe ni se reincorpora
// =============================================================================

test('CA-5: adapter OK + critical real → gated, SIN re-probe (no se reincorpora)', () => {
    let probeCalls = 0;
    const r = providerHealth.assessProviderQuota('openai-codex', {
        quotaUsageImpl: quotaImpl({ adapterStatus: 'ok', status: 'critical', pct: 97 }),
        probeCodexImpl: () => { probeCalls += 1; return { ok: true }; },
        reprobeStateReadImpl: () => null,
        reprobeStateWriteImpl: () => {},
        auditImpl: () => {},
        now: 6_000_000,
    });
    assert.equal(r.gated, true, 'cuota crítica real DEBE gatear');
    assert.equal(r.reason_code, 'quota_exhausted_real');
    assert.equal(probeCalls, 0, 'un critical real NUNCA se re-probe (security req#5)');
    assert.equal(r.reprobe, undefined, 'sin re-probe → sin campo reprobe');
});

// =============================================================================
// El re-probe SOLO aplica a openai-codex
// =============================================================================

test('el re-probe NO se dispara para providers != openai-codex', () => {
    let probeCalls = 0;
    for (const provider of ['gemini-google', 'cerebras', 'anthropic']) {
        const r = providerHealth.assessProviderQuota(provider, {
            quotaUsageImpl: quotaImpl({ adapterStatus: 'no_usage_data', status: 'unknown', pct: null }),
            probeCodexImpl: () => { probeCalls += 1; return { ok: true }; },
            reprobeStateReadImpl: () => null,
            reprobeStateWriteImpl: () => {},
            auditImpl: () => {},
            now: 7_000_000,
        });
        assert.equal(r.reprobe, undefined, `${provider}: no debe re-probe (solo Codex)`);
    }
    assert.equal(probeCalls, 0);
});

test('opts.reprobe=false desactiva el re-probe (kill-switch por caller)', () => {
    let probeCalls = 0;
    const r = providerHealth.assessProviderQuota('openai-codex', {
        quotaUsageImpl: quotaImpl({ adapterStatus: 'no_usage_data', status: 'unknown', pct: null }),
        probeCodexImpl: () => { probeCalls += 1; return { ok: true }; },
        reprobe: false,
        now: 8_000_000,
    });
    assert.equal(probeCalls, 0);
    assert.equal(r.reprobe, undefined);
});

// =============================================================================
// Invariante offline (security CA-#6) — cero HTTP en los adapters de cuota
// =============================================================================

test('security CA-#6: ningún adapter de cuota importa un cliente HTTP', () => {
    const dir = path.join(__dirname, '..', 'quota-adapters');
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.js') && f !== '_shape.js');
    const httpRe = /\brequire\(['"](?:node:)?https?['"]\)|\baxios\b|node-fetch|\bfetch\s*\(|https?:\/\//;
    for (const f of files) {
        const src = fs.readFileSync(path.join(dir, f), 'utf8');
        assert.ok(!httpRe.test(src),
            `${f}: los adapters deben ser 100% offline (sin HTTP) — invariante #4202 CA-#6`);
    }
});

// =============================================================================
// Desambiguación del enum — no_usage_data existe y no colapsa a verde
// =============================================================================

test('_shape: NO_USAGE_DATA existe y emptyResult lo mapea a status unknown + pct null', () => {
    const shape = require('../quota-adapters/_shape');
    assert.equal(shape.ADAPTER_STATUS.NO_USAGE_DATA, 'no_usage_data');
    const r = shape.emptyResult('openai-codex', shape.ADAPTER_STATUS.NO_USAGE_DATA, 'sin consumo');
    assert.equal(r.pct, null, 'no_usage_data NUNCA colapsa a pct 0 (security req#4)');
    assert.equal(r.status, 'unknown', 'no_usage_data → unknown, NUNCA verde/no_quota');
    assert.notEqual(r.status, 'no_quota', 'no_usage_data ≠ no_quota');
});
