// =============================================================================
// sherlock-retry-chain.test.js — Suite Node para la cascada de Sherlock
// (#3558). Cubre CA-F1..F7 + CA-SEC-3-RECHECK + CA-SEC-SKIP-QUOTA +
// CA-SEC-CASCADE-CAP + CA-SEC-AUDIT-REDACT + CA-SEC-CRED-FILTER +
// CA-INV-ADVERSARIAL + CA-INV-SCHEMA.
//
// Diseño: fakes inyectables (complete, parseAndValidate, hasCredential,
// enforceResidency, emitAuditEvent, log, now). NO toca red ni filesystem.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const retryChain = require('../sherlock-retry-chain');

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

// Allowlist usada en los tests — refleja PROVIDER_MODELS_ALLOWLIST de
// completion-client.js (subset suficiente para tests).
const MODELS_ALLOWLIST = {
    cerebras: ['llama-3.3-70b', 'llama-4-scout-17b-16e-instruct', 'llama3.1-70b'],
    'gemini-google': ['gemini-2.0-flash', 'gemini-1.5-pro', 'gemini-1.5-flash'],
    'nvidia-nim': ['deepseek-ai/deepseek-v4-pro', 'meta/llama-3.3-70b-instruct'],
};

const CHAIN_HTTP = [
    { provider: 'cerebras', model: 'llama-3.3-70b', transport: 'http' },
    { provider: 'gemini-google', model: 'gemini-2.0-flash', transport: 'http' },
    { provider: 'nvidia-nim', model: 'deepseek-ai/deepseek-v4-pro', transport: 'http' },
];

function okResponse(content) {
    return {
        ok: true,
        content: content || JSON.stringify({ verdict: 'ok', reason: 'consistente', inconsistencies: [] }),
        inputTokens: 10,
        outputTokens: 5,
        durationMs: 50,
    };
}

function timeoutError() {
    return {
        ok: false,
        error: { type: 'timeout', detail: 'request superó timeoutMs' },
        durationMs: 90_000,
    };
}

function rateLimitError() {
    return {
        ok: false,
        error: { type: 'http_error', reason: 'rate_limited', statusCode: 429 },
        durationMs: 100,
    };
}

function quotaError() {
    return {
        ok: false,
        error: { type: 'http_error', reason: 'quota_exhausted', statusCode: 429 },
        durationMs: 100,
    };
}

function authError() {
    return {
        ok: false,
        error: { type: 'auth_error', reason: 'invalid_credentials', statusCode: 401 },
        durationMs: 100,
    };
}

function fiveXxError() {
    return {
        ok: false,
        error: { type: 'http_error', reason: 'unknown', statusCode: 503, detail: 'transient' },
        durationMs: 100,
    };
}

function badSchemaResponse() {
    return okResponse('esto no es JSON válido');
}

// Fake parseAndValidate alineado con `parseAndValidateSherlockOutput` real.
function fakeParseAndValidate(content) {
    if (typeof content !== 'string') return { ok: false, reason: 'empty_output' };
    let txt = content.trim();
    if (txt.startsWith('```')) {
        txt = txt.replace(/^```(?:json)?\s*\n?/i, '').replace(/```\s*$/i, '').trim();
    }
    let parsed;
    try { parsed = JSON.parse(txt); }
    catch { return { ok: false, reason: 'invalid_json' }; }
    if (!parsed || typeof parsed !== 'object') return { ok: false, reason: 'not_object' };
    if (parsed.verdict !== 'ok' && parsed.verdict !== 'rechazado') {
        return { ok: false, reason: 'invalid_verdict' };
    }
    return {
        ok: true,
        data: {
            verdict: parsed.verdict,
            reason: parsed.reason || '',
            inconsistencies: Array.isArray(parsed.inconsistencies) ? parsed.inconsistencies : [],
            inconsistenciesTruncated: false,
        },
    };
}

function captureAudit() {
    const events = [];
    return {
        events,
        emit: ({ event, payload }) => events.push({ event, payload }),
    };
}

// =============================================================================
// CA-F1 — el módulo expone retryInCascade con el shape contractual.
// =============================================================================
test('CA-F1: exporta retryInCascade y constantes default', () => {
    assert.equal(typeof retryChain.retryInCascade, 'function');
    assert.equal(retryChain.DEFAULT_MAX_ATTEMPTS_PER_PROVIDER, 2);
    assert.equal(retryChain.DEFAULT_MAX_PROVIDERS, 3);
    assert.equal(retryChain.DEFAULT_MAX_TOTAL_CASCADE_MS, 180_000);
});

// =============================================================================
// Happy path: primer provider + primer modelo responde OK.
// =============================================================================
test('happy-path: initial provider+model responde OK en el primer intento', async () => {
    const audit = captureAudit();
    const result = await retryChain.retryInCascade({
        chain: CHAIN_HTTP,
        initialProvider: 'cerebras',
        initialModel: 'llama-3.3-70b',
        initialTransport: 'http',
        complete: async () => okResponse(),
        parseAndValidate: fakeParseAndValidate,
        modelsAllowlist: MODELS_ALLOWLIST,
        hasCredential: () => true,
        enforceResidency: () => ({ ok: true }),
        emitAuditEvent: audit.emit,
    });
    assert.equal(result.ok, true);
    assert.equal(result.providerUsed, 'cerebras');
    assert.equal(result.modelUsed, 'llama-3.3-70b');
    assert.equal(result.attemptsCount, 1);
    assert.equal(result.fallbackUsed, false);
    assert.deepEqual(result.chainTried, ['cerebras']);
    // No deberían emitirse retry_attempt en happy path.
    assert.equal(audit.events.filter(e => e.event === 'sherlock_retry_attempt').length, 0);
});

// =============================================================================
// CA-INV-ADVERSARIAL — primer modelo same-provider falla con schema, segundo
// modelo same-provider responde OK. fallbackUsed=false (preserva adversariality).
// =============================================================================
test('CA-INV-ADVERSARIAL: same-provider rota modelo, fallbackUsed=false', async () => {
    const audit = captureAudit();
    let callCount = 0;
    const result = await retryChain.retryInCascade({
        chain: CHAIN_HTTP,
        initialProvider: 'cerebras',
        initialModel: 'llama-3.3-70b',
        initialTransport: 'http',
        complete: async ({ model }) => {
            callCount++;
            if (callCount === 1) {
                assert.equal(model, 'llama-3.3-70b', 'primer intento: modelo inicial');
                return badSchemaResponse();
            }
            // Segundo intento: debe usar OTRO modelo de cerebras (CA-INV-ADVERSARIAL).
            assert.notEqual(model, 'llama-3.3-70b', 'segundo intento: modelo distinto');
            assert.ok(MODELS_ALLOWLIST.cerebras.includes(model), 'modelo en allowlist');
            return okResponse();
        },
        parseAndValidate: fakeParseAndValidate,
        modelsAllowlist: MODELS_ALLOWLIST,
        hasCredential: () => true,
        enforceResidency: () => ({ ok: true }),
        emitAuditEvent: audit.emit,
    });
    assert.equal(result.ok, true);
    assert.equal(result.providerUsed, 'cerebras');
    assert.equal(result.attemptsCount, 2);
    assert.equal(result.fallbackUsed, false, 'mismo provider preserva adversariality');
    // El primer intento debe haber emitido un sherlock_retry_attempt.
    const retries = audit.events.filter(e => e.event === 'sherlock_retry_attempt');
    assert.equal(retries.length, 1);
    assert.equal(retries[0].payload.provider, 'cerebras');
    assert.equal(retries[0].payload.error.reason, 'schema_violation');
});

// =============================================================================
// CA-F2 — max 2 modelos por provider. Si los 2 fallan, salta provider.
// =============================================================================
test('CA-F2: agota maxAttemptsPerProvider=2 same-provider, salta al siguiente', async () => {
    const audit = captureAudit();
    const usedModels = [];
    const result = await retryChain.retryInCascade({
        chain: CHAIN_HTTP,
        initialProvider: 'cerebras',
        initialModel: 'llama-3.3-70b',
        initialTransport: 'http',
        complete: async ({ provider, model }) => {
            usedModels.push(`${provider}/${model}`);
            if (provider === 'cerebras') return badSchemaResponse();
            if (provider === 'gemini-google') return okResponse();
            return timeoutError();
        },
        parseAndValidate: fakeParseAndValidate,
        modelsAllowlist: MODELS_ALLOWLIST,
        hasCredential: () => true,
        enforceResidency: () => ({ ok: true }),
        emitAuditEvent: audit.emit,
    });
    assert.equal(result.ok, true);
    assert.equal(result.providerUsed, 'gemini-google');
    assert.equal(result.fallbackUsed, true);
    // Cerebras debe haber sido intentado con EXACTAMENTE 2 modelos distintos.
    const cerebrasAttempts = usedModels.filter(m => m.startsWith('cerebras/'));
    assert.equal(cerebrasAttempts.length, 2);
    assert.notEqual(cerebrasAttempts[0], cerebrasAttempts[1]);
});

// =============================================================================
// CA-SEC-SKIP-QUOTA — rate_limited NO retry same-provider; salta provider.
// =============================================================================
test('CA-SEC-SKIP-QUOTA: rate_limited salta directo al siguiente provider', async () => {
    const audit = captureAudit();
    const providersUsed = [];
    const result = await retryChain.retryInCascade({
        chain: CHAIN_HTTP,
        initialProvider: 'cerebras',
        initialModel: 'llama-3.3-70b',
        initialTransport: 'http',
        complete: async ({ provider }) => {
            providersUsed.push(provider);
            if (provider === 'cerebras') return rateLimitError();
            return okResponse();
        },
        parseAndValidate: fakeParseAndValidate,
        modelsAllowlist: MODELS_ALLOWLIST,
        hasCredential: () => true,
        enforceResidency: () => ({ ok: true }),
        emitAuditEvent: audit.emit,
    });
    assert.equal(result.ok, true);
    // Cerebras debe haber sido intentado UNA SOLA VEZ (no rota modelo en rate_limit).
    const cerebrasAttempts = providersUsed.filter(p => p === 'cerebras');
    assert.equal(cerebrasAttempts.length, 1, 'rate_limit NO debe retry same-provider');
    assert.equal(result.providerUsed, 'gemini-google');
});

test('CA-SEC-SKIP-QUOTA: quota_exhausted salta directo al siguiente provider', async () => {
    const audit = captureAudit();
    const providersUsed = [];
    const result = await retryChain.retryInCascade({
        chain: CHAIN_HTTP,
        initialProvider: 'cerebras',
        initialModel: 'llama-3.3-70b',
        initialTransport: 'http',
        complete: async ({ provider }) => {
            providersUsed.push(provider);
            if (provider === 'cerebras') return quotaError();
            return okResponse();
        },
        parseAndValidate: fakeParseAndValidate,
        modelsAllowlist: MODELS_ALLOWLIST,
        hasCredential: () => true,
        enforceResidency: () => ({ ok: true }),
        emitAuditEvent: audit.emit,
    });
    assert.equal(result.ok, true);
    assert.equal(providersUsed.filter(p => p === 'cerebras').length, 1);
});

test('CA-SEC-SKIP-QUOTA: invalid_credentials salta directo al siguiente provider', async () => {
    const audit = captureAudit();
    const providersUsed = [];
    const result = await retryChain.retryInCascade({
        chain: CHAIN_HTTP,
        initialProvider: 'cerebras',
        initialModel: 'llama-3.3-70b',
        initialTransport: 'http',
        complete: async ({ provider }) => {
            providersUsed.push(provider);
            if (provider === 'cerebras') return authError();
            return okResponse();
        },
        parseAndValidate: fakeParseAndValidate,
        modelsAllowlist: MODELS_ALLOWLIST,
        hasCredential: () => true,
        enforceResidency: () => ({ ok: true }),
        emitAuditEvent: audit.emit,
    });
    assert.equal(result.ok, true);
    assert.equal(providersUsed.filter(p => p === 'cerebras').length, 1);
});

test('timeout SÍ rota modelo same-provider (no es skip-quota)', async () => {
    const audit = captureAudit();
    const usedModels = [];
    const result = await retryChain.retryInCascade({
        chain: CHAIN_HTTP,
        initialProvider: 'cerebras',
        initialModel: 'llama-3.3-70b',
        initialTransport: 'http',
        complete: async ({ provider, model }) => {
            usedModels.push(`${provider}/${model}`);
            if (provider === 'cerebras') return timeoutError();
            return okResponse();
        },
        parseAndValidate: fakeParseAndValidate,
        modelsAllowlist: MODELS_ALLOWLIST,
        hasCredential: () => true,
        enforceResidency: () => ({ ok: true }),
        emitAuditEvent: audit.emit,
    });
    assert.equal(result.ok, true);
    const cerebrasAttempts = usedModels.filter(m => m.startsWith('cerebras/'));
    assert.equal(cerebrasAttempts.length, 2, 'timeout permite rotar modelo same-provider');
});

test('5xx unknown SÍ rota modelo same-provider', async () => {
    const audit = captureAudit();
    const usedModels = [];
    const result = await retryChain.retryInCascade({
        chain: CHAIN_HTTP,
        initialProvider: 'cerebras',
        initialModel: 'llama-3.3-70b',
        initialTransport: 'http',
        complete: async ({ provider, model }) => {
            usedModels.push(`${provider}/${model}`);
            if (provider === 'cerebras') return fiveXxError();
            return okResponse();
        },
        parseAndValidate: fakeParseAndValidate,
        modelsAllowlist: MODELS_ALLOWLIST,
        hasCredential: () => true,
        enforceResidency: () => ({ ok: true }),
        emitAuditEvent: audit.emit,
    });
    assert.equal(result.ok, true);
    assert.equal(usedModels.filter(m => m.startsWith('cerebras/')).length, 2);
});

// =============================================================================
// CA-F5 — exhaustion: todos los providers fallan → ok:false con
// errorCode='exhausted_cascade'.
// =============================================================================
test('CA-F5: todos los providers fallan → exhausted_cascade', async () => {
    const audit = captureAudit();
    const result = await retryChain.retryInCascade({
        chain: CHAIN_HTTP,
        initialProvider: 'cerebras',
        initialModel: 'llama-3.3-70b',
        initialTransport: 'http',
        complete: async () => timeoutError(),
        parseAndValidate: fakeParseAndValidate,
        modelsAllowlist: MODELS_ALLOWLIST,
        hasCredential: () => true,
        enforceResidency: () => ({ ok: true }),
        emitAuditEvent: audit.emit,
    });
    assert.equal(result.ok, false);
    assert.equal(result.errorCode, 'exhausted_cascade');
    assert.equal(result.cascadeAbortedByCap, false);
    assert.deepEqual(result.chainTried, ['cerebras', 'gemini-google', 'nvidia-nim']);
    // Por cada provider: 2 modelos × 3 providers = 6 retry_attempts.
    const retries = audit.events.filter(e => e.event === 'sherlock_retry_attempt');
    assert.equal(retries.length, 6);
});

// =============================================================================
// CA-SEC-CASCADE-CAP — cap total de latencia (default 180s).
// =============================================================================
test('CA-SEC-CASCADE-CAP: aborta con cascade_timeout si supera maxTotalCascadeMs', async () => {
    const audit = captureAudit();
    let fakeClock = 1_000;
    const _now = () => fakeClock;
    const result = await retryChain.retryInCascade({
        chain: CHAIN_HTTP,
        initialProvider: 'cerebras',
        initialModel: 'llama-3.3-70b',
        initialTransport: 'http',
        complete: async () => {
            // Cada intento "consume" 100 segundos del reloj fake.
            fakeClock += 100_000;
            return timeoutError();
        },
        parseAndValidate: fakeParseAndValidate,
        modelsAllowlist: MODELS_ALLOWLIST,
        hasCredential: () => true,
        enforceResidency: () => ({ ok: true }),
        emitAuditEvent: audit.emit,
        maxTotalCascadeMs: 180_000,
        now: _now,
    });
    assert.equal(result.ok, false);
    assert.equal(result.errorCode, 'cascade_timeout');
    assert.equal(result.cascadeAbortedByCap, true);
    // Debería haberse cortado antes de probar los 3 providers x 2 modelos.
    assert.ok(result.attemptsCount < 6, `attempts=${result.attemptsCount} debe ser menos que el max sin cap`);
});

// =============================================================================
// CA-SEC-3-RECHECK — residency block en un fallback provider salta al siguiente.
// =============================================================================
test('CA-SEC-3-RECHECK: residency_blocked en fallback salta al siguiente provider', async () => {
    const audit = captureAudit();
    const providersDispatched = [];
    const result = await retryChain.retryInCascade({
        chain: CHAIN_HTTP,
        initialProvider: 'cerebras',
        initialModel: 'llama-3.3-70b',
        initialTransport: 'http',
        complete: async ({ provider, model }) => {
            providersDispatched.push(provider);
            if (provider === 'cerebras') return timeoutError();
            return okResponse();
        },
        parseAndValidate: fakeParseAndValidate,
        modelsAllowlist: MODELS_ALLOWLIST,
        hasCredential: () => true,
        enforceResidency: (provider) => {
            if (provider === 'gemini-google') return { ok: false, reason: 'data_residency_blocked' };
            return { ok: true };
        },
        emitAuditEvent: audit.emit,
    });
    assert.equal(result.ok, true);
    // gemini-google NUNCA debió haberse despachado (residency lo bloqueó antes).
    assert.equal(providersDispatched.filter(p => p === 'gemini-google').length, 0);
    assert.equal(result.providerUsed, 'nvidia-nim');
    // Y el audit debe registrar el retry_attempt con reason=residency_blocked.
    const residencyAttempts = audit.events.filter(
        e => e.event === 'sherlock_retry_attempt' && e.payload.error && e.payload.error.reason === 'residency_blocked'
    );
    assert.ok(residencyAttempts.length >= 1, 'residency block emite retry_attempt');
});

test('CA-SEC-3-RECHECK: todos los providers bloqueados por residency → no_eligible o exhausted', async () => {
    const audit = captureAudit();
    const result = await retryChain.retryInCascade({
        chain: CHAIN_HTTP,
        initialProvider: 'cerebras',
        initialModel: 'llama-3.3-70b',
        initialTransport: 'http',
        complete: async () => okResponse(),
        parseAndValidate: fakeParseAndValidate,
        modelsAllowlist: MODELS_ALLOWLIST,
        hasCredential: () => true,
        enforceResidency: () => ({ ok: false, reason: 'data_residency_blocked' }),
        emitAuditEvent: audit.emit,
    });
    assert.equal(result.ok, false);
    assert.equal(result.errorCode, 'exhausted_cascade');
    assert.ok(result.attemptsCount >= 3, 'cada provider contó como intento residency-blocked');
});

// =============================================================================
// CA-SEC-CRED-FILTER — providers sin credencial se excluyen ANTES de iterar.
// =============================================================================
test('CA-SEC-CRED-FILTER: provider sin credencial emite sherlock_provider_skipped y no se intenta', async () => {
    const audit = captureAudit();
    const providersUsed = [];
    const result = await retryChain.retryInCascade({
        chain: CHAIN_HTTP,
        initialProvider: 'cerebras',
        initialModel: 'llama-3.3-70b',
        initialTransport: 'http',
        complete: async ({ provider }) => {
            providersUsed.push(provider);
            if (provider === 'cerebras') return timeoutError();
            return okResponse();
        },
        parseAndValidate: fakeParseAndValidate,
        modelsAllowlist: MODELS_ALLOWLIST,
        hasCredential: (p) => p !== 'gemini-google', // gemini sin credencial
        enforceResidency: () => ({ ok: true }),
        emitAuditEvent: audit.emit,
    });
    assert.equal(result.ok, true);
    // gemini-google NUNCA debió aparecer en providersUsed.
    assert.equal(providersUsed.filter(p => p === 'gemini-google').length, 0);
    assert.equal(result.providerUsed, 'nvidia-nim');
    // Y el audit debe tener sherlock_provider_skipped con reason missing_credential.
    const skipped = audit.events.filter(e => e.event === 'sherlock_provider_skipped');
    assert.equal(skipped.length, 1);
    assert.equal(skipped[0].payload.provider, 'gemini-google');
    assert.equal(skipped[0].payload.reason, 'missing_credential');
});

test('CA-SEC-CRED-FILTER: anthropic (spawn) NO requiere credencial managed', async () => {
    const audit = captureAudit();
    const result = await retryChain.retryInCascade({
        chain: [
            { provider: 'anthropic', model: 'claude-haiku-4-5', transport: 'spawn' },
            { provider: 'cerebras', model: 'llama-3.3-70b', transport: 'http' },
        ],
        initialProvider: 'anthropic',
        initialModel: 'claude-haiku-4-5',
        initialTransport: 'spawn',
        complete: async ({ provider }) => {
            if (provider === 'anthropic') return okResponse();
            return timeoutError();
        },
        parseAndValidate: fakeParseAndValidate,
        modelsAllowlist: MODELS_ALLOWLIST,
        hasCredential: () => false, // hasCredential dice "false" para todos
        enforceResidency: () => ({ ok: true }),
        emitAuditEvent: audit.emit,
    });
    // anthropic vía spawn pasa el filter sin tocar hasCredential.
    assert.equal(result.ok, true);
    assert.equal(result.providerUsed, 'anthropic');
});

// =============================================================================
// CA-SEC-AUDIT-REDACT — los eventos no contienen prompt, body ni stderr.
// =============================================================================
test('CA-SEC-AUDIT-REDACT: sherlock_retry_attempt no expone detail con PII', async () => {
    const audit = captureAudit();
    await retryChain.retryInCascade({
        chain: CHAIN_HTTP,
        initialProvider: 'cerebras',
        initialModel: 'llama-3.3-70b',
        initialTransport: 'http',
        complete: async () => ({
            ok: false,
            error: {
                type: 'http_error',
                reason: 'unknown',
                statusCode: 503,
                // detail con datos sensibles que NUNCA deben aparecer en el evento.
                detail: 'usuario DNI 12345678 reportó secret=ABCDEF1234567890',
            },
            durationMs: 100,
        }),
        parseAndValidate: fakeParseAndValidate,
        modelsAllowlist: MODELS_ALLOWLIST,
        hasCredential: () => true,
        enforceResidency: () => ({ ok: true }),
        emitAuditEvent: audit.emit,
    });
    const retries = audit.events.filter(e => e.event === 'sherlock_retry_attempt');
    assert.ok(retries.length > 0);
    for (const r of retries) {
        const err = r.payload.error || {};
        // Solo campos PERMITIDOS: type, reason, statusCode, parseErrorCode.
        const keys = Object.keys(err);
        for (const k of keys) {
            assert.ok(
                ['type', 'reason', 'statusCode', 'parseErrorCode'].includes(k),
                `sherlock_retry_attempt.error.${k} no está en la whitelist (CA-SEC-AUDIT-REDACT)`
            );
        }
        // El detail NUNCA aparece.
        assert.ok(!('detail' in err), 'detail prohibido en el audit');
        // Y la PII concreta tampoco.
        const serialized = JSON.stringify(r.payload);
        assert.ok(!serialized.includes('12345678'), 'DNI no debe aparecer');
        assert.ok(!serialized.includes('ABCDEF1234567890'), 'secret no debe aparecer');
    }
});

test('CA-SEC-AUDIT-REDACT: schema_violation solo expone parseError.code', async () => {
    const audit = captureAudit();
    await retryChain.retryInCascade({
        chain: [{ provider: 'cerebras', model: 'llama-3.3-70b', transport: 'http' }],
        initialProvider: 'cerebras',
        initialModel: 'llama-3.3-70b',
        initialTransport: 'http',
        complete: async () => okResponse('no JSON contenido sensible DNI 99999999'),
        parseAndValidate: fakeParseAndValidate,
        modelsAllowlist: MODELS_ALLOWLIST,
        hasCredential: () => true,
        enforceResidency: () => ({ ok: true }),
        emitAuditEvent: audit.emit,
        maxAttemptsPerProvider: 1,
    });
    const retries = audit.events.filter(e => e.event === 'sherlock_retry_attempt');
    assert.ok(retries.length > 0);
    // Solo se debe ver parseErrorCode, no el raw response content.
    for (const r of retries) {
        const serialized = JSON.stringify(r.payload);
        assert.ok(!serialized.includes('99999999'), 'raw content del provider no debe aparecer');
    }
});

// =============================================================================
// CA-F3 — sherlock_retry_attempt registra provider, model, attemptNumber,
// error tipado, durationMs y timestamp.
// =============================================================================
test('CA-F3: sherlock_retry_attempt incluye campos canónicos', async () => {
    const audit = captureAudit();
    await retryChain.retryInCascade({
        chain: CHAIN_HTTP,
        initialProvider: 'cerebras',
        initialModel: 'llama-3.3-70b',
        initialTransport: 'http',
        complete: async ({ provider }) => provider === 'cerebras' ? timeoutError() : okResponse(),
        parseAndValidate: fakeParseAndValidate,
        modelsAllowlist: MODELS_ALLOWLIST,
        hasCredential: () => true,
        enforceResidency: () => ({ ok: true }),
        emitAuditEvent: audit.emit,
    });
    const retries = audit.events.filter(e => e.event === 'sherlock_retry_attempt');
    assert.ok(retries.length >= 1);
    const r = retries[0];
    assert.equal(typeof r.payload.provider, 'string');
    assert.ok(r.payload.model);
    assert.equal(typeof r.payload.attemptNumber, 'number');
    assert.ok(r.payload.error);
    assert.equal(typeof r.payload.error.type, 'string');
    assert.equal(typeof r.payload.durationMs, 'number');
    assert.equal(typeof r.payload.timestamp, 'number');
});

// =============================================================================
// Edge cases
// =============================================================================
test('no_eligible_providers: chain vacía sin initial → errorCode=no_eligible_providers', async () => {
    const result = await retryChain.retryInCascade({
        chain: [],
        initialProvider: null,
        initialModel: null,
        complete: async () => okResponse(),
        parseAndValidate: fakeParseAndValidate,
        modelsAllowlist: MODELS_ALLOWLIST,
        hasCredential: () => true,
        enforceResidency: () => ({ ok: true }),
        emitAuditEvent: () => {},
    });
    assert.equal(result.ok, false);
    assert.equal(result.errorCode, 'no_eligible_providers');
});

test('no_eligible_providers: todos los providers filtrados por cred-filter', async () => {
    const audit = captureAudit();
    const result = await retryChain.retryInCascade({
        chain: CHAIN_HTTP,
        initialProvider: 'cerebras',
        initialModel: 'llama-3.3-70b',
        initialTransport: 'http',
        complete: async () => okResponse(),
        parseAndValidate: fakeParseAndValidate,
        modelsAllowlist: MODELS_ALLOWLIST,
        hasCredential: () => false,
        enforceResidency: () => ({ ok: true }),
        emitAuditEvent: audit.emit,
    });
    assert.equal(result.ok, false);
    assert.equal(result.errorCode, 'no_eligible_providers');
    // Cada provider HTTP filtrado debe emitir provider_skipped.
    const skipped = audit.events.filter(e => e.event === 'sherlock_provider_skipped');
    assert.ok(skipped.length >= 3);
});

test('complete() que tira excepción se captura como retry_same_provider', async () => {
    const audit = captureAudit();
    let calls = 0;
    const result = await retryChain.retryInCascade({
        chain: CHAIN_HTTP,
        initialProvider: 'cerebras',
        initialModel: 'llama-3.3-70b',
        initialTransport: 'http',
        complete: async ({ provider }) => {
            calls++;
            if (provider === 'cerebras' && calls <= 2) {
                throw new Error('ECONNRESET sintético');
            }
            return okResponse();
        },
        parseAndValidate: fakeParseAndValidate,
        modelsAllowlist: MODELS_ALLOWLIST,
        hasCredential: () => true,
        enforceResidency: () => ({ ok: true }),
        emitAuditEvent: audit.emit,
    });
    assert.equal(result.ok, true);
    // La excepción se contabiliza como intento fallido, se rota modelo, eventualmente
    // cae a gemini que devuelve OK.
    const retries = audit.events.filter(e => e.event === 'sherlock_retry_attempt');
    assert.ok(retries.length >= 2);
});

test('maxProviders=1 limita la cascada al provider inicial', async () => {
    const audit = captureAudit();
    const providersUsed = [];
    const result = await retryChain.retryInCascade({
        chain: CHAIN_HTTP,
        initialProvider: 'cerebras',
        initialModel: 'llama-3.3-70b',
        initialTransport: 'http',
        complete: async ({ provider }) => {
            providersUsed.push(provider);
            return timeoutError();
        },
        parseAndValidate: fakeParseAndValidate,
        modelsAllowlist: MODELS_ALLOWLIST,
        hasCredential: () => true,
        enforceResidency: () => ({ ok: true }),
        emitAuditEvent: audit.emit,
        maxProviders: 1,
    });
    assert.equal(result.ok, false);
    // Solo cerebras (1 provider × 2 modelos).
    const unique = Array.from(new Set(providersUsed));
    assert.deepEqual(unique, ['cerebras']);
});

// =============================================================================
// Helpers internos (smoke).
// =============================================================================
test('_classifyAttemptError: SKIP_PROVIDER_REASONS', () => {
    assert.equal(retryChain._classifyAttemptError({ reason: 'rate_limited' }), 'skip_provider');
    assert.equal(retryChain._classifyAttemptError({ reason: 'quota_exhausted' }), 'skip_provider');
    assert.equal(retryChain._classifyAttemptError({ reason: 'invalid_credentials' }), 'skip_provider');
    assert.equal(retryChain._classifyAttemptError({ reason: 'forbidden' }), 'skip_provider');
    assert.equal(retryChain._classifyAttemptError({ reason: 'residency_blocked' }), 'skip_provider');
});

test('_classifyAttemptError: RETRY_SAME_PROVIDER por default', () => {
    assert.equal(retryChain._classifyAttemptError({ type: 'timeout' }), 'retry_same_provider');
    assert.equal(retryChain._classifyAttemptError({ reason: 'unknown' }), 'retry_same_provider');
    assert.equal(retryChain._classifyAttemptError({ type: 'http_error', reason: 'schema_drift' }), 'retry_same_provider');
    assert.equal(retryChain._classifyAttemptError({ type: 'unknown' }), 'retry_same_provider');
});

test('_pickNextModelSameProvider: devuelve modelo no usado de la allowlist', () => {
    const next = retryChain._pickNextModelSameProvider({
        provider: 'cerebras',
        usedModels: ['llama-3.3-70b'],
        modelsAllowlist: MODELS_ALLOWLIST,
        currentModel: 'llama-3.3-70b',
    });
    assert.ok(next);
    assert.notEqual(next, 'llama-3.3-70b');
    assert.ok(MODELS_ALLOWLIST.cerebras.includes(next));
});

test('_pickNextModelSameProvider: devuelve null si agotó allowlist', () => {
    const next = retryChain._pickNextModelSameProvider({
        provider: 'cerebras',
        usedModels: MODELS_ALLOWLIST.cerebras.slice(),
        modelsAllowlist: MODELS_ALLOWLIST,
        currentModel: null,
    });
    assert.equal(next, null);
});

test('_pickNextModelSameProvider: devuelve null si el provider no está en allowlist', () => {
    const next = retryChain._pickNextModelSameProvider({
        provider: 'anthropic',
        usedModels: [],
        modelsAllowlist: MODELS_ALLOWLIST,
    });
    assert.equal(next, null);
});

test('_redactErrorForAudit: solo whitelist de campos', () => {
    const redacted = retryChain._redactErrorForAudit({
        type: 'http_error',
        reason: 'rate_limited',
        statusCode: 429,
        detail: 'PII confidential', // debe ser eliminado
        bodySnippet: 'raw response', // debe ser eliminado
    });
    assert.equal(redacted.type, 'http_error');
    assert.equal(redacted.reason, 'rate_limited');
    assert.equal(redacted.statusCode, 429);
    assert.ok(!('detail' in redacted));
    assert.ok(!('bodySnippet' in redacted));
});

test('_redactErrorForAudit: input vacío devuelve shape canónico', () => {
    const r = retryChain._redactErrorForAudit(null);
    assert.equal(r.type, 'unknown');
    assert.equal(r.reason, null);
    assert.equal(r.statusCode, null);
});
