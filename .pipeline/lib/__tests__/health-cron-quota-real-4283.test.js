// =============================================================================
// health-cron-quota-real-4283.test.js — El snapshot del cron incorpora la
// señal de cuota REAL (#4283).
//
// Cubre:
//   - Un candidato de fallback con login OK (CLI/ping) pero cuota crítica
//     (#4202) se marca state 'red' + reason_code 'quota_exhausted_real' para
//     que el router lo descarte (CA-1 vía snapshot → CA-3).
//   - El PRIMARIO (default_provider) NO se flipea a rojo por cuota (decisión #3
//     del PO): el router no lo gatea y sería un falso CAÍDO.
//   - Fail-open: adapter degradado (unknown) NO cambia el estado login-based.
//   - El entry del snapshot expone `quota` solo con { adapterStatus, status, pct }
//     (CA-5 + seguridad req#1).
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const healthCron = require('../multi-provider/health-cron');

const NOW = 1_700_000_000_000;

// CLI siempre OK → login válido para los providers OAuth (anthropic/codex).
const cliProbeOk = () => true;

// Provider specs mínimos para pingAllProviders.
const SPECS = [
    { provider: 'anthropic', label: 'Anthropic', auth_mode: 'oauth', cli_binary: 'claude' },
    { provider: 'openai', label: 'OpenAI / Codex', auth_mode: 'oauth', cli_binary: 'codex' },
];

function quotaAssess(byProvider) {
    return (provider /*, opts */) => {
        const v = byProvider[provider] || { adapterStatus: 'unknown', status: 'unknown', pct: null, gated: false, reason_code: null };
        return v;
    };
}

test('CA-3 (snapshot): candidato no-primario con cuota crítica → red + quota_exhausted_real', async () => {
    const results = await healthCron.pingAllProviders({
        providers: SPECS,
        cliProbe: cliProbeOk,
        defaultProvider: 'anthropic',
        now: NOW,
        quotaAssessImpl: quotaAssess({
            openai: { adapterStatus: 'ok', status: 'critical', pct: 95, gated: true, reason_code: 'quota_exhausted_real' },
        }),
    });
    const codex = results.find(r => r.provider === 'openai');
    assert.ok(codex);
    assert.equal(codex.state, 'red', 'cuota agotada degrada al candidato de fallback pese a login OK');
    assert.equal(codex.reason_code, 'quota_exhausted_real');
    assert.deepEqual(Object.keys(codex.quota).sort(), ['adapterStatus', 'pct', 'status']);
});

test('Decisión #3: el primario NO se flipea a rojo por cuota crítica', async () => {
    const results = await healthCron.pingAllProviders({
        providers: SPECS,
        cliProbe: cliProbeOk,
        defaultProvider: 'anthropic',
        now: NOW,
        quotaAssessImpl: quotaAssess({
            anthropic: { adapterStatus: 'ok', status: 'critical', pct: 99, gated: true, reason_code: 'quota_exhausted_real' },
        }),
    });
    const anthropic = results.find(r => r.provider === 'anthropic');
    assert.ok(anthropic);
    assert.notEqual(anthropic.state, 'red', 'el primario no debe caer a CAÍDO por cuota');
    assert.notEqual(anthropic.reason_code, 'quota_exhausted_real');
    assert.ok(anthropic.quota, 'pero igual expone su cuota (CA-5)');
    assert.equal(anthropic.quota.status, 'critical');
});

test('CA-2 (snapshot): adapter degradado (unknown) NO cambia el estado login-based', async () => {
    const results = await healthCron.pingAllProviders({
        providers: SPECS,
        cliProbe: cliProbeOk,
        defaultProvider: 'anthropic',
        now: NOW,
        quotaAssessImpl: quotaAssess({
            openai: { adapterStatus: 'unknown', status: 'unknown', pct: null, gated: false, reason_code: null },
        }),
    });
    const codex = results.find(r => r.provider === 'openai');
    assert.ok(codex);
    assert.equal(codex.state, 'green', 'fail-open: login OK por CLI se mantiene');
    assert.equal(codex.reason_code, 'cli_oauth_ok');
});
