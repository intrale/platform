// =============================================================================
// dispatch-billing-flag.test.js — #4870
//
// Verifica que `resolveSpawnWithFallback` exponga el flag derivado
// `providerBilling: 'paid'|'free'` del provider resuelto en cada return
// (primary / fallback / all-gated) y que el helper `billingOf` sea FAIL-SAFE
// (default 'free' cuando el provider no declara `billing`).
//
// El flag es la fuente de verdad que consume `isReducedMode` para decidir
// "los pagos están gateados pero quedó un free sano" (billing:'paid' vs 'free').
// =============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dispatch = require('../dispatch-with-fallback');

function agentModels() {
    return {
        default_provider: 'anthropic',
        providers: {
            anthropic: {
                launcher: 'claude', model: 'claude-sonnet-4-6', auth_mode: 'oauth',
                credentials_env: ['ANTHROPIC_API_KEY'], billing: 'paid',
            },
            'openai-codex': {
                launcher: 'codex', model: 'gpt-5.5', auth_mode: 'oauth',
                credentials_env: ['OPENAI_API_KEY'], billing: 'paid',
            },
            cerebras: {
                launcher: 'cerebras', model: 'gpt-oss-120b',
                credentials_env: [], billing: 'free',
            },
            // Provider SIN `billing` declarado → debe tratarse como 'free' (fail-safe).
            'legacy-unmarked': {
                launcher: 'cerebras', model: 'gpt-oss-120b', credentials_env: [],
            },
        },
        skills: {
            'telegram-commander': {
                provider: 'anthropic',
                model_override: 'claude-sonnet-4-6',
                fallbacks: [
                    { provider: 'openai-codex', model_override: 'gpt-5.5' },
                    { provider: 'cerebras', model_override: 'gpt-oss-120b' },
                ],
            },
        },
    };
}

function withTempPipeline(setupFiles, fn) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'billing4870-'));
    const prev = process.env.PIPELINE_DIR_OVERRIDE;
    const prevReconcile = process.env.QUOTA_RECONCILE_DISABLED;
    try {
        for (const [name, content] of Object.entries(setupFiles)) {
            fs.writeFileSync(path.join(tmp, name), content, 'utf8');
        }
        process.env.PIPELINE_DIR_OVERRIDE = tmp;
        // Estos casos validan el recorrido de flags sintéticos. Una sesión Codex
        // real y fresca no debe vetarlos ni generar auditoría fuera del fixture.
        process.env.QUOTA_RECONCILE_DISABLED = '1';
        return fn(tmp);
    } finally {
        if (prev === undefined) delete process.env.PIPELINE_DIR_OVERRIDE;
        else process.env.PIPELINE_DIR_OVERRIDE = prev;
        if (prevReconcile === undefined) delete process.env.QUOTA_RECONCILE_DISABLED;
        else process.env.QUOTA_RECONCILE_DISABLED = prevReconcile;
        try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
}

function quotaFlagMulti(providers) {
    const resets = new Date(Date.now() + 3600_000).toISOString();
    const detected = new Date().toISOString();
    const map = {};
    for (const p of providers) {
        map[p] = { exhausted: true, resets_at: resets, detected_at: detected, pattern_matched: 'usage_limit_reached' };
    }
    return JSON.stringify({
        exhausted: true, provider: providers[0], resets_at: resets, detected_at: detected,
        pattern_matched: 'usage_limit_reached', providers: map,
    });
}

const quota = require('../../quota-exhausted');

// -----------------------------------------------------------------------------
// billingOf — helper puro, fuente de verdad del gate "¿pago?".
// -----------------------------------------------------------------------------
test('#4870 · billingOf devuelve "paid" para provider marcado paid', () => {
    const models = agentModels();
    assert.equal(dispatch.billingOf('anthropic', models), 'paid');
    assert.equal(dispatch.billingOf('openai-codex', models), 'paid');
});

test('#4870 · billingOf devuelve "free" para provider marcado free', () => {
    const models = agentModels();
    assert.equal(dispatch.billingOf('cerebras', models), 'free');
});

test('#4870 · billingOf FAIL-SAFE: provider sin billing declarado → "free"', () => {
    const models = agentModels();
    assert.equal(dispatch.billingOf('legacy-unmarked', models), 'free',
        'un provider sin marcar NUNCA se confunde con pago');
});

test('#4870 · billingOf FAIL-SAFE: provider inexistente / models null → "free"', () => {
    assert.equal(dispatch.billingOf('no-existe', agentModels()), 'free');
    assert.equal(dispatch.billingOf('anthropic', null), 'free');
    assert.equal(dispatch.billingOf('anthropic', {}), 'free');
});

// -----------------------------------------------------------------------------
// resolveSpawnWithFallback — providerBilling en primary / fallback / all-gated.
// -----------------------------------------------------------------------------
test('#4870 · primary sano → providerBilling="paid" (Anthropic)', () => {
    withTempPipeline({ 'agent-models.json': JSON.stringify(agentModels()) }, (tmp) => {
        const res = dispatch.resolveSpawnWithFallback({
            skill: 'telegram-commander', issue: 't', pipelineDir: tmp,
            quotaModule: quota, onLog: () => {}, notify: () => {},
            auditLog: { appendChained: () => {} },
        });
        assert.equal(res.gated, false);
        assert.equal(res.provider, 'anthropic');
        assert.equal(res.providerBilling, 'paid');
    });
});

test('#4870 · fallback a Codex (paid) → providerBilling="paid"', () => {
    withTempPipeline({
        'agent-models.json': JSON.stringify(agentModels()),
        'quota-exhausted.json': quotaFlagMulti(['anthropic']),
    }, (tmp) => {
        const res = dispatch.resolveSpawnWithFallback({
            skill: 'telegram-commander', issue: 't', pipelineDir: tmp,
            quotaModule: quota, onLog: () => {}, notify: () => {},
            auditLog: { appendChained: () => {} },
        });
        assert.equal(res.gated, false);
        assert.equal(res.provider, 'openai-codex');
        assert.equal(res.providerBilling, 'paid');
    });
});

test('#4870 · fallback a Cerebras (free) tras pagos gateados → providerBilling="free"', () => {
    withTempPipeline({
        'agent-models.json': JSON.stringify(agentModels()),
        'quota-exhausted.json': quotaFlagMulti(['anthropic', 'openai-codex']),
    }, (tmp) => {
        const res = dispatch.resolveSpawnWithFallback({
            skill: 'telegram-commander', issue: 't', pipelineDir: tmp,
            quotaModule: quota, onLog: () => {}, notify: () => {},
            auditLog: { appendChained: () => {} },
        });
        assert.equal(res.gated, false);
        assert.equal(res.provider, 'cerebras');
        assert.equal(res.providerBilling, 'free', 'candidato free ⇒ base del modo reducido');
    });
});

test('#4870 · chain enteramente gateada (all-gated) igual expone providerBilling', () => {
    withTempPipeline({
        'agent-models.json': JSON.stringify(agentModels()),
        'quota-exhausted.json': quotaFlagMulti(['anthropic', 'openai-codex', 'cerebras']),
    }, (tmp) => {
        const res = dispatch.resolveSpawnWithFallback({
            skill: 'telegram-commander', issue: 't', pipelineDir: tmp,
            quotaModule: quota, onLog: () => {}, notify: () => {},
            auditLog: { appendChained: () => {} },
        });
        assert.equal(res.gated, true, 'all-gated');
        // El flag existe en el shape aunque esté gateado (billing del primary).
        assert.equal(res.providerBilling, 'paid');
    });
});
