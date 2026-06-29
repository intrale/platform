// =============================================================================
// provider-health-4283.test.js — Salud de proveedor basada en cuota REAL
// disponible, no solo login válido (#4283).
//
// Cubre:
//   - CA-1: getProviderHealth combina login OK + cuota agotada (adapterStatus
//     'ok' + status 'critical') → status 'gated' con reason 'quota_exhausted_real',
//     pese a ping 2xx.
//   - CA-2: fail-open — adapterStatus 'unknown'/'error' NO degrada; el provider
//     mantiene su status login-based.
//   - Primario (not_applicable) muestra `quota` pero NO se degrada su status
//     (decisión #3 del PO).
//   - CA-4: sanitizeReasonCode preserva 'quota_exhausted_real' (no lo colapsa).
//   - CA-6: el shape combinado NO expone keys/tokens; `quota` solo trae
//     { adapterStatus, status, pct }.
//
// Cero HTTP real (pingImpl + quotaUsageImpl inyectados), cero secrets en disco.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const providerHealth = require('../provider-health');
const alerts = require('../multi-provider/health-alerts');

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'mp-4283-')); }

// Login válido para todos los pingables (simula 2xx).
const fakePingOk = async ({ provider }) => ({ ok: true, reason: 'authenticated', provider, statusCode: 200 });

// Helpers de quota inyectables.
function quotaImpl(byCanonical) {
    return (canonical /*, sessionData */) => {
        const v = byCanonical[canonical] || byCanonical['*'] || { adapterStatus: 'unknown', status: 'unknown', pct: null };
        return { provider: canonical, ...v };
    };
}

function findProvider(result, id) {
    return result.providers.find((p) => p.id === id);
}

// =============================================================================
// assessProviderQuota — unidad del helper compartido
// =============================================================================

test('assessProviderQuota: adapter OK + status critical → gated con reason quota_exhausted_real', () => {
    const r = providerHealth.assessProviderQuota('openai-codex', {
        quotaUsageImpl: () => ({ adapterStatus: 'ok', status: 'critical', pct: 96 }),
    });
    assert.equal(r.gated, true);
    assert.equal(r.reason_code, 'quota_exhausted_real');
    assert.equal(r.adapterStatus, 'ok');
    assert.equal(r.status, 'critical');
    assert.equal(r.pct, 96);
});

test('assessProviderQuota: fail-open ante adapterStatus unknown/error (NO gatea)', () => {
    for (const adapterStatus of ['unknown', 'error', 'no_quota', 'not_implemented']) {
        const r = providerHealth.assessProviderQuota('cerebras', {
            quotaUsageImpl: () => ({ adapterStatus, status: 'critical', pct: 99 }),
        });
        assert.equal(r.gated, false, `adapterStatus=${adapterStatus} no debe gatear`);
        assert.equal(r.reason_code, null);
    }
});

test('assessProviderQuota: adapter OK pero status no-critical (warning) NO gatea', () => {
    const r = providerHealth.assessProviderQuota('gemini-google', {
        quotaUsageImpl: () => ({ adapterStatus: 'ok', status: 'warning', pct: 80 }),
    });
    assert.equal(r.gated, false);
    assert.equal(r.reason_code, null);
});

test('assessProviderQuota: alias openai → openai-codex se normaliza al adapter canónico', () => {
    let seen = null;
    const r = providerHealth.assessProviderQuota('openai', {
        quotaUsageImpl: (canonical) => { seen = canonical; return { adapterStatus: 'ok', status: 'critical', pct: 91 }; },
    });
    assert.equal(seen, 'openai-codex', 'el cron usa "openai"; el adapter de cuota usa "openai-codex"');
    assert.equal(r.gated, true);
});

// =============================================================================
// CA-1 — getProviderHealth degrada a gated por cuota real pese a login 2xx
// =============================================================================

test('CA-1: login OK + cuota crítica → status gated con reason quota_exhausted_real', async () => {
    const dir = tmpDir();
    const result = await providerHealth.getProviderHealth({
        forcePing: true,
        pingImpl: fakePingOk,
        pipelineDir: dir,
        quotaUsageImpl: quotaImpl({ 'openai-codex': { adapterStatus: 'ok', status: 'critical', pct: 95 } }),
    });
    const codex = findProvider(result, 'openai-codex');
    assert.ok(codex, 'openai-codex debe estar en el resultado');
    assert.equal(codex.status, 'gated', 'cuota agotada debe degradar a gated pese a ping 2xx');
    assert.equal(codex.reason, 'quota_exhausted_real');
    assert.ok(codex.quota, 'debe adjuntar el discriminante de cuota');
    assert.equal(codex.quota.status, 'critical');
    assert.equal(codex.quota.pct, 95);
});

// =============================================================================
// CA-2 — fail-open: adapter degradado NO toca el status login-based
// =============================================================================

test('CA-2: login OK + adapterStatus unknown → status se mantiene ok (fail-open)', async () => {
    const dir = tmpDir();
    const result = await providerHealth.getProviderHealth({
        forcePing: true,
        pingImpl: fakePingOk,
        pipelineDir: dir,
        quotaUsageImpl: quotaImpl({ '*': { adapterStatus: 'unknown', status: 'unknown', pct: null } }),
    });
    const codex = findProvider(result, 'openai-codex');
    assert.ok(codex);
    assert.equal(codex.status, 'ok', 'adapter degradado no debe degradar el login-based');
    assert.notEqual(codex.reason, 'quota_exhausted_real');
    assert.ok(codex.quota, 'aún así adjunta el discriminante (CUOTA S/D en el dashboard)');
    assert.equal(codex.quota.adapterStatus, 'unknown');
});

// =============================================================================
// Primario not_applicable: muestra quota pero NO se degrada (decisión #3 PO)
// =============================================================================

test('Primario not_applicable muestra quota crítica pero conserva status not_applicable', async () => {
    const dir = tmpDir();
    const result = await providerHealth.getProviderHealth({
        forcePing: true,
        pingImpl: fakePingOk,
        pipelineDir: dir,
        quotaUsageImpl: quotaImpl({ anthropic: { adapterStatus: 'ok', status: 'critical', pct: 99 } }),
    });
    const anthropic = findProvider(result, 'anthropic');
    assert.ok(anthropic);
    assert.equal(anthropic.status, 'not_applicable', 'el primario NO se degrada por cuota');
    assert.ok(anthropic.quota, 'pero SÍ muestra el discriminante de cuota (CA-5)');
    assert.equal(anthropic.quota.status, 'critical');
});

// =============================================================================
// CA-4 — sanitizeReasonCode preserva el reason_code nuevo
// =============================================================================

test('CA-4: sanitizeReasonCode preserva quota_exhausted_real (no lo colapsa a unknown)', () => {
    assert.equal(alerts.sanitizeReasonCode('quota_exhausted_real'), 'quota_exhausted_real');
    assert.ok(alerts.ALLOWED_REASON_CODES.has('quota_exhausted_real'),
        'quota_exhausted_real debe estar en la allowlist o el gate del router nunca lo ve');
});

// =============================================================================
// CA-6 — no-regresión de seguridad: shape sin keys/tokens
// =============================================================================

test('CA-6: el shape combinado no expone keys/tokens y quota solo trae adapterStatus/status/pct', async () => {
    const dir = tmpDir();
    const result = await providerHealth.getProviderHealth({
        forcePing: true,
        pingImpl: fakePingOk,
        pipelineDir: dir,
        quotaUsageImpl: quotaImpl({
            '*': {
                adapterStatus: 'ok', status: 'critical', pct: 92,
                // Campos "ruidosos" que NO deben filtrarse al shape combinado:
                api_key: 'sk-LEAK-DO-NOT-EXPOSE-123456', errorReason: 'x', session: {}, calibration: {},
            },
        }),
    });
    const serialized = JSON.stringify(result);
    assert.ok(!serialized.includes('LEAK'), 'el shape no debe filtrar la key cruda del payload de cuota');
    // Patrón de leak: un campo *api_key* con valor largo (≥20 chars). NO debe
    // confundirse con el enum `auth_mode:"api_key"`, que es legítimo.
    assert.ok(!/"[^"]*api[_-]?key"\s*:\s*"[^"]{20,}"/i.test(serialized),
        'el shape no debe contener un par "api_key": "<valor largo>"');
    for (const p of result.providers) {
        if (!p.quota) continue;
        assert.deepEqual(Object.keys(p.quota).sort(), ['adapterStatus', 'pct', 'status'],
            'quota solo expone adapterStatus/status/pct — nunca el payload crudo del adapter');
    }
});
