// =============================================================================
// health-gate-3809.test.js — blindajes #3809 (cascada de providers de Sherlock).
//
// Cubre:
//   A. MP-09 health-gate FAIL-OPEN (unit sobre evaluateHealthGate):
//      - rojo fresco y DURABLE (credenciales/config) → gateado.
//      - rojo fresco pero TRANSITORIO (timeout/network/unknown) → NO gateado
//        (fail-open — incidente Gemini timeout 2026-06-05).
//      - rojo viejo (fuera de la ventana) → NO gateado (fail-open).
//      - rojo sin timestamp → NO gateado.
//      - verde → NO gateado.
//      - provider sin entrada en el snapshot → NO gateado.
//      - alias openai-codex → openai.
//      - reloj desfasado (last_checked_at en el futuro) → NO gateado.
//   B. MP-09 integración con resolveSpawnWithFallback:
//      - fallback rojo-fresco se saltea + audit fallback_health_gated.
//      - fallback rojo-viejo se usa igual (fail-open).
//      - el primario NUNCA se health-gatea.
//   C. REQ-SEC-1 redacción: los audit entries nuevos no filtran secrets.
//   D. REQ-SEC-4 fail-closed: validación de modelos at-request rechaza modelos
//      fuera de allowlist+config (no fail-open).
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const {
    resolveSpawnWithFallback,
    evaluateHealthGate,
    HEALTH_FRESHNESS_MS,
    HEALTH_PROVIDER_ALIAS,
} = require('../lib/agent-launcher/dispatch-with-fallback');

const completionClient = require('../lib/multi-provider/completion-client');

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------
const PIPELINE_DIR = '/repo/.pipeline';
const ISSUE = 3809;
const NOW = Date.parse('2026-06-03T18:00:00.000Z');

function healthEntry(provider, state, ageMs, extra = {}) {
    const checkedAt = Number.isFinite(ageMs)
        ? new Date(NOW - ageMs).toISOString()
        : null;
    return {
        provider,
        state,
        // Default DURABLE para reds: estos tests asumen un rojo que debe gatear.
        // El refinamiento del fail-open (incidente Gemini timeout) sólo gatea
        // reds con causa durable (credenciales/config); los transitorios hacen
        // fail-open. Para no reescribir cada caso, el default es durable y los
        // tests de transitorio pasan reason_code explícito (timeout/unknown).
        reason_code: extra.reason_code || (state === 'red' ? 'invalid_credentials' : 'authenticated'),
        last_checked_at: ('last_checked_at' in extra) ? extra.last_checked_at : checkedAt,
        ...extra,
    };
}

function healthSnapshot(entries) {
    return { ts: new Date(NOW).toISOString(), providers: entries };
}

function fakeAuditLog() {
    const entries = [];
    return {
        appendChained: ({ entry }) => {
            entries.push(entry);
            return { hash_self: 'h', hash_prev: 'p', line: '' };
        },
        entries,
    };
}

function fakeNotify() {
    const calls = [];
    const fn = (o) => { calls.push(o); return true; };
    fn.calls = calls;
    return fn;
}

function fakeProviderHandlerResolver(valid = ['anthropic', 'openai-codex', 'gemini-google', 'cerebras', 'nvidia-nim', 'deterministic']) {
    return (name) => {
        if (!valid.includes(name)) throw new Error(`[fake] provider "${name}" inválido`);
        return { name: `${name}-fake` };
    };
}

// quota que gatea SOLO el primario (para forzar entrada a la cascada de fallbacks).
function fakeQuotaGatePrimary(primary) {
    return {
        shouldGateSpawn: (_skill, { provider } = {}) => provider === primary,
        sanitizeRawExcerpt: (s) => String(s == null ? '' : s),
    };
}

// fs falso con agent-models.json embebido (no escribe a disco real).
function fakeFsWithModels(models) {
    const modelsPath = path.join(PIPELINE_DIR, 'agent-models.json');
    const files = new Map([[modelsPath, JSON.stringify(models)]]);
    return {
        existsSync: (p) => files.has(p),
        readFileSync: (p) => {
            if (files.has(p)) return files.get(p);
            const e = new Error(`ENOENT ${p}`); e.code = 'ENOENT'; throw e;
        },
        mkdirSync: () => {},
        writeFileSync: (p, c) => files.set(p, c),
    };
}

function fakeResolver(skill, opts) {
    const models = JSON.parse(opts.fsImpl.readFileSync(path.join(opts.pipelineDir, 'agent-models.json')));
    const sk = models.skills[skill];
    const provider = sk.provider;
    return {
        provider,
        model: sk.model_override || (models.providers[provider] && models.providers[provider].model) || null,
        handler: { name: `${provider}-fake` },
        source: 'agent-models',
    };
}

function modelsWithChain(primary, fallbacks) {
    return {
        defaults: { model: 'claude-opus-4-7' },
        default_provider: 'anthropic',
        providers: {
            anthropic: { model: 'claude-opus-4-7' },
            'openai-codex': { model: 'gpt-5-codex' },
            'gemini-google': { model: 'gemini-2.0-flash' },
            cerebras: { model: 'gpt-oss-120b' },
            'nvidia-nim': { model: 'deepseek-ai/deepseek-v4-pro' },
        },
        skills: {
            'test-skill': { provider: primary, fallbacks },
        },
    };
}

// =============================================================================
// A. evaluateHealthGate — unit
// =============================================================================
test('A1 · rojo FRESCO y confiable → gateado', () => {
    const snap = healthSnapshot([healthEntry('cerebras', 'red', 60 * 1000)]);
    const r = evaluateHealthGate('cerebras', snap, NOW);
    assert.equal(r.gated, true);
    assert.equal(r.state, 'red');
});

test('A2 · rojo VIEJO (fuera de la ventana de frescura) → NO gateado (fail-open)', () => {
    const snap = healthSnapshot([healthEntry('cerebras', 'red', HEALTH_FRESHNESS_MS + 60 * 1000)]);
    const r = evaluateHealthGate('cerebras', snap, NOW);
    assert.equal(r.gated, false);
    assert.equal(r.reason, 'red_stale');
});

test('A3 · rojo SIN timestamp → NO gateado (fail-open)', () => {
    const snap = healthSnapshot([healthEntry('cerebras', 'red', null, { last_checked_at: null })]);
    const r = evaluateHealthGate('cerebras', snap, NOW);
    assert.equal(r.gated, false);
    assert.equal(r.reason, 'red_no_timestamp');
});

test('A4 · verde → NO gateado', () => {
    const snap = healthSnapshot([healthEntry('cerebras', 'green', 60 * 1000)]);
    const r = evaluateHealthGate('cerebras', snap, NOW);
    assert.equal(r.gated, false);
    assert.equal(r.state, 'green');
});

test('A5 · provider SIN entrada en el snapshot → NO gateado (fail-open)', () => {
    const snap = healthSnapshot([healthEntry('cerebras', 'red', 60 * 1000)]);
    const r = evaluateHealthGate('nvidia-nim', snap, NOW);
    assert.equal(r.gated, false);
    assert.equal(r.state, null);
});

test('A6 · alias openai-codex → openai (health usa "openai")', () => {
    assert.equal(HEALTH_PROVIDER_ALIAS['openai-codex'], 'openai');
    const snap = healthSnapshot([healthEntry('openai', 'red', 60 * 1000)]);
    const r = evaluateHealthGate('openai-codex', snap, NOW);
    assert.equal(r.gated, true, 'mapea openai-codex → openai y encuentra el rojo fresco');
});

test('A7 · reloj desfasado (last_checked_at en el futuro) → NO gateado (fail-open)', () => {
    const snap = healthSnapshot([healthEntry('cerebras', 'red', -5 * 60 * 1000)]); // 5min en el futuro
    const r = evaluateHealthGate('cerebras', snap, NOW);
    assert.equal(r.gated, false, 'ageMs negativo → no confiable → fail-open');
    assert.equal(r.reason, 'red_stale');
});

test('A8 · snapshot null/ilegible → NO gateado (fail-open)', () => {
    assert.equal(evaluateHealthGate('cerebras', null, NOW).gated, false);
    assert.equal(evaluateHealthGate('cerebras', {}, NOW).gated, false);
    assert.equal(evaluateHealthGate('cerebras', { providers: 'x' }, NOW).gated, false);
});

test('A9 · rojo FRESCO pero TRANSITORIO (timeout) → NO gateado (fail-open, caso Gemini)', () => {
    // Gemini quedó rojo por un timeout puntual y se recuperó minutos después,
    // pero el rojo cacheado lo sacaba de la cascada hasta 20min. Un timeout es
    // incertidumbre, no una falla durable → fail-open.
    const snap = healthSnapshot([healthEntry('gemini-google', 'red', 60 * 1000, { reason_code: 'timeout' })]);
    const r = evaluateHealthGate('gemini-google', snap, NOW);
    assert.equal(r.gated, false, 'timeout es transitorio → no gatea');
    assert.equal(r.reason, 'red_transient');
    assert.equal(r.state, 'red');
});

test('A9b · rojo FRESCO transitorio (network_error/unknown) → NO gateado (fail-open)', () => {
    for (const reason of ['network_error', 'unknown', 'rate_limited']) {
        const snap = healthSnapshot([healthEntry('cerebras', 'red', 60 * 1000, { reason_code: reason })]);
        const r = evaluateHealthGate('cerebras', snap, NOW);
        assert.equal(r.gated, false, `${reason} es transitorio → no gatea`);
        assert.equal(r.reason, 'red_transient');
    }
});

test('A10 · rojo FRESCO y DURABLE (no_key_configured/forbidden) → gateado', () => {
    for (const reason of ['no_key_configured', 'forbidden', 'invalid_credentials', 'unknown_provider']) {
        const snap = healthSnapshot([healthEntry('cerebras', 'red', 60 * 1000, { reason_code: reason })]);
        const r = evaluateHealthGate('cerebras', snap, NOW);
        assert.equal(r.gated, true, `${reason} es durable → gatea`);
        assert.equal(r.reason, reason);
    }
});

// =============================================================================
// B. Integración con resolveSpawnWithFallback
// =============================================================================
test('B1 · fallback rojo-fresco se saltea y se usa el siguiente + audit fallback_health_gated', () => {
    const models = modelsWithChain('anthropic', [
        { provider: 'cerebras', model_override: 'gpt-oss-120b' },
        { provider: 'nvidia-nim', model_override: 'deepseek-ai/deepseek-v4-pro' },
    ]);
    const audit = fakeAuditLog();
    const snap = healthSnapshot([
        healthEntry('cerebras', 'red', 60 * 1000),   // rojo fresco → gatea
        healthEntry('nvidia-nim', 'green', 60 * 1000),
    ]);
    const r = resolveSpawnWithFallback({
        skill: 'test-skill',
        issue: ISSUE,
        pipelineDir: PIPELINE_DIR,
        fsImpl: fakeFsWithModels(models),
        quotaModule: fakeQuotaGatePrimary('anthropic'),
        primaryResolver: fakeResolver,
        providerHandlerResolver: fakeProviderHandlerResolver(),
        auditLog: audit,
        notify: fakeNotify(),
        healthReader: () => snap,
        now: NOW,
    });
    assert.equal(r.provider, 'nvidia-nim', 'saltó cerebras (rojo-fresco) y usó nvidia-nim');
    assert.equal(r.source, 'fallback');
    const gatedEvt = audit.entries.find(e => e.event === 'fallback_health_gated');
    assert.ok(gatedEvt, 'se emitió audit fallback_health_gated');
    assert.equal(gatedEvt.fallback_provider, 'cerebras');
    assert.equal(gatedEvt.health_state, 'red');
});

test('B2 · fallback rojo-VIEJO se usa igual (fail-open, preserva cobertura)', () => {
    const models = modelsWithChain('anthropic', [
        { provider: 'cerebras', model_override: 'gpt-oss-120b' },
    ]);
    const snap = healthSnapshot([
        healthEntry('cerebras', 'red', HEALTH_FRESHNESS_MS + 5 * 60 * 1000), // rojo viejo
    ]);
    const r = resolveSpawnWithFallback({
        skill: 'test-skill',
        issue: ISSUE,
        pipelineDir: PIPELINE_DIR,
        fsImpl: fakeFsWithModels(models),
        quotaModule: fakeQuotaGatePrimary('anthropic'),
        primaryResolver: fakeResolver,
        providerHandlerResolver: fakeProviderHandlerResolver(),
        auditLog: fakeAuditLog(),
        notify: fakeNotify(),
        healthReader: () => snap,
        now: NOW,
    });
    assert.equal(r.provider, 'cerebras', 'rojo viejo NO gatea: el fallback se usa igual');
    assert.equal(r.source, 'fallback');
});

test('B3 · el primario NUNCA se health-gatea (aunque esté rojo-fresco)', () => {
    const models = modelsWithChain('anthropic', [
        { provider: 'cerebras', model_override: 'gpt-oss-120b' },
    ]);
    const snap = healthSnapshot([
        healthEntry('anthropic', 'red', 60 * 1000), // primario rojo fresco
    ]);
    const r = resolveSpawnWithFallback({
        skill: 'test-skill',
        issue: ISSUE,
        pipelineDir: PIPELINE_DIR,
        fsImpl: fakeFsWithModels(models),
        quotaModule: { // primario NO gateado por cuota → happy path
            shouldGateSpawn: () => false,
            sanitizeRawExcerpt: (s) => String(s == null ? '' : s),
        },
        primaryResolver: fakeResolver,
        providerHandlerResolver: fakeProviderHandlerResolver(),
        auditLog: fakeAuditLog(),
        notify: fakeNotify(),
        healthReader: () => snap,
        now: NOW,
    });
    assert.equal(r.provider, 'anthropic', 'el primario se devuelve aunque esté rojo-fresco en health');
    assert.notEqual(r.source, 'fallback', 'no degradó a un fallback por health del primario');
    assert.equal(r.gated, false);
    assert.equal(r.crossProvider, false);
});

test('B5 · fallback rojo-fresco TRANSITORIO (timeout) se USA igual (caso Gemini en la cascada)', () => {
    const models = modelsWithChain('anthropic', [
        { provider: 'gemini-google', model_override: 'gemini-2.0-flash' },
        { provider: 'cerebras', model_override: 'gpt-oss-120b' },
    ]);
    const audit = fakeAuditLog();
    const snap = healthSnapshot([
        healthEntry('gemini-google', 'red', 60 * 1000, { reason_code: 'timeout' }), // rojo fresco PERO transitorio
        healthEntry('cerebras', 'green', 60 * 1000),
    ]);
    const r = resolveSpawnWithFallback({
        skill: 'test-skill',
        issue: ISSUE,
        pipelineDir: PIPELINE_DIR,
        fsImpl: fakeFsWithModels(models),
        quotaModule: fakeQuotaGatePrimary('anthropic'),
        primaryResolver: fakeResolver,
        providerHandlerResolver: fakeProviderHandlerResolver(),
        auditLog: audit,
        notify: fakeNotify(),
        healthReader: () => snap,
        now: NOW,
    });
    assert.equal(r.provider, 'gemini-google', 'rojo por timeout NO saca a Gemini de la cascada (fail-open)');
    assert.equal(r.source, 'fallback');
    assert.ok(!audit.entries.find(e => e.event === 'fallback_health_gated'),
        'no se emitió health-gate para un rojo transitorio');
});

test('B4 · healthReader que tira → fail-open (no rompe la resolución)', () => {
    const models = modelsWithChain('anthropic', [
        { provider: 'cerebras', model_override: 'gpt-oss-120b' },
    ]);
    const r = resolveSpawnWithFallback({
        skill: 'test-skill',
        issue: ISSUE,
        pipelineDir: PIPELINE_DIR,
        fsImpl: fakeFsWithModels(models),
        quotaModule: fakeQuotaGatePrimary('anthropic'),
        primaryResolver: fakeResolver,
        providerHandlerResolver: fakeProviderHandlerResolver(),
        auditLog: fakeAuditLog(),
        notify: fakeNotify(),
        healthReader: () => { throw new Error('health ilegible'); },
        now: NOW,
    });
    assert.equal(r.provider, 'cerebras', 'health ilegible → fail-open, el fallback se usa');
});

// =============================================================================
// C. REQ-SEC-1 — redacción: el audit nuevo no filtra secrets
// =============================================================================
test('C1 · audit fallback_health_gated NO contiene API keys ni tokens', () => {
    const models = modelsWithChain('anthropic', [
        { provider: 'cerebras', model_override: 'gpt-oss-120b' },
        { provider: 'nvidia-nim', model_override: 'deepseek-ai/deepseek-v4-pro' },
    ]);
    const audit = fakeAuditLog();
    const snap = healthSnapshot([
        healthEntry('cerebras', 'red', 60 * 1000, {
            // contaminamos el snapshot con un secret simulado para verificar que
            // NO se propaga a los audit entries del dispatcher.
            reason_code: 'live_ping_failed',
        }),
        healthEntry('nvidia-nim', 'green', 60 * 1000),
    ]);
    resolveSpawnWithFallback({
        skill: 'test-skill',
        issue: ISSUE,
        pipelineDir: PIPELINE_DIR,
        fsImpl: fakeFsWithModels(models),
        quotaModule: fakeQuotaGatePrimary('anthropic'),
        primaryResolver: fakeResolver,
        providerHandlerResolver: fakeProviderHandlerResolver(),
        auditLog: audit,
        notify: fakeNotify(),
        healthReader: () => snap,
        now: NOW,
        // env con secrets — el dispatcher NO debe loguearlos.
        processEnv: {
            CEREBRAS_API_KEY: 'sk-secret-cerebras-123',
            ANTHROPIC_API_KEY: 'sk-ant-secret-456',
        },
    });
    const blob = JSON.stringify(audit.entries);
    assert.ok(!/sk-secret-cerebras-123/.test(blob), 'no filtra CEREBRAS_API_KEY');
    assert.ok(!/sk-ant-secret-456/.test(blob), 'no filtra ANTHROPIC_API_KEY');
    assert.ok(!/Authorization/i.test(blob), 'no incluye headers Authorization');
    assert.ok(!/_token/i.test(blob), 'no incluye *_token');
});

// =============================================================================
// D. REQ-SEC-4 — validación de modelos at-request es FAIL-CLOSED
// =============================================================================
test('D1 · modelo fuera de allowlist+config → invalid_model (fail-closed, no fail-open)', async () => {
    // cerebras solo permite variantes llama* en la allowlist hardcoded; un modelo
    // arbitrario no declarado en config debe ser RECHAZADO antes del HTTP.
    const r = await completionClient.complete({
        provider: 'cerebras',
        model: 'modelo-que-no-existe-999',
        prompt: 'hola',
        pipelineDir: '/nonexistent-pipeline-dir', // sin config → no agrega nada a la allowlist
    });
    assert.equal(r.ok, false);
    assert.equal(r.error.type, 'invalid_model', 'rechaza fail-closed, no intenta el request');
});

test('D2 · provider fuera de la allowlist de endpoints → unknown_provider (fail-closed)', async () => {
    const r = await completionClient.complete({
        provider: 'provider-trucho',
        model: 'x',
        prompt: 'hola',
    });
    assert.equal(r.ok, false);
    assert.equal(r.error.type, 'unknown_provider');
});
