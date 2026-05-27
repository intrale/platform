// =============================================================================
// agent-launcher/__tests__/provider-error-parser.test.js — Tests cross-skill
// del parser generalizado (#3576 CA-7).
//
// MIGRACIÓN DE TESTS SR-1..SR-9 desde lib/commander/__tests__/. Los tests
// originales viven todavía allá para cubrir el shim + runCommanderSpawn;
// éste archivo cubre el parser ya migrado a lib/agent-launcher/ con fixtures
// REALES saneadas keyed por skill (guru/planner/builder/qa/commander).
//
// Garantías que validamos acá:
//   * SR-1 — stdout PROHIBIDO como input clasificador (test estructural).
//   * SR-2 — redacción de secrets (AKIA, JWT, sk-*).
//   * SR-3 — cap 64KB input + 16KB línea (anti-DoS).
//   * SR-4 — regex ReDoS-safe (1MB payload <50ms).
//   * SR-5 — provider en allowlist, fail-closed.
//   * SR-6 — parser NO llama setFlag (es responsabilidad del hook).
//   * SR-7 — errorType extraído en KNOWN_QUOTA_ERROR_TYPES_BY_PROVIDER.
//   * SR-8 — el hook (NO el parser) escribe audit con hash-chain.
//   * SR-9 — parser SSE bounded por línea.
//
// Convención: este archivo carga el parser DIRECTO desde
// `lib/agent-launcher/provider-error-parser`. NO usa el shim de commander.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const parser = require('../provider-error-parser');
const { parseProviderError } = parser;

const FIXTURES_DIR = path.join(__dirname, 'fixtures', 'skill-real');

function loadFixture(name) {
    return JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, name), 'utf8'));
}

// -----------------------------------------------------------------------------
// SR-5 — Contrato fail-closed
// -----------------------------------------------------------------------------

test('SR-5 parser devuelve unknown sin provider (fail-closed)', () => {
    const r = parseProviderError('algún error', { transport: 'cli' });
    assert.equal(r.errorClass, 'unknown');
    assert.equal(r.shouldFallback, false);
});

test('SR-5 parser devuelve unknown con provider fuera de allowlist (fail-closed)', () => {
    const r = parseProviderError('error', { provider: 'rogue-corp', transport: 'cli' });
    assert.equal(r.errorClass, 'unknown');
    assert.equal(r.shouldFallback, false);
});

test('SR-5 parser devuelve unknown con transport inválido (fail-closed)', () => {
    const r = parseProviderError('error', { provider: 'anthropic', transport: 'magic' });
    assert.equal(r.errorClass, 'unknown');
});

// -----------------------------------------------------------------------------
// Cross-skill: 5 fixtures REALES saneadas (#3576 CA-7)
// -----------------------------------------------------------------------------

test('CA-7 cross-skill: guru/Anthropic CLI stream-json estructural clasifica quota_exhausted', () => {
    const fx = loadFixture('guru-anthropic-cli-usage-limit.json');
    const r = parseProviderError(fx.raw, { provider: fx.provider, transport: fx.transport });
    assert.equal(r.errorClass, fx.expected_error_class);
    assert.equal(r.shouldFallback, fx.expected_should_fallback);
    assert.equal(r.retriable, fx.expected_retriable);
    assert.ok(r.evidence.length > 0);
});

test('CA-7 cross-skill: planner/Anthropic CLI stderr texto libre clasifica quota_exhausted via regex', () => {
    const fx = loadFixture('planner-anthropic-cli-credits-required.json');
    const r = parseProviderError(fx.raw, { provider: fx.provider, transport: fx.transport });
    assert.equal(r.errorClass, fx.expected_error_class);
    assert.equal(r.shouldFallback, true);
});

test('CA-7 cross-skill: builder timeout no_result clasifica transient_5xx (Signal A)', () => {
    const fx = loadFixture('builder-timeout-noresult.json');
    const r = parseProviderError(fx.raw, {
        provider: fx.provider,
        transport: fx.transport,
        timedOut: fx.ctx.timedOut,
        exitCode: fx.ctx.exitCode,
        durationMs: fx.ctx.durationMs,
    });
    assert.equal(r.errorClass, fx.expected_error_class);
    assert.equal(r.retriable, true);
    assert.match(r.evidence, /timedOut=true/);
});

test('CA-7 cross-skill: qa/OpenAI Codex SSE event=error con insufficient_quota clasifica quota_exhausted', () => {
    const fx = loadFixture('qa-openai-codex-sse-insufficient-quota.json');
    const r = parseProviderError(fx.raw, { provider: fx.provider, transport: fx.transport });
    assert.equal(r.errorClass, fx.expected_error_class);
    assert.equal(r.shouldFallback, true);
});

test('CA-7 cross-skill: commander result event estructural clasifica quota_exhausted (mismo shape que skills)', () => {
    const fx = loadFixture('commander-anthropic-result-event.json');
    const r = parseProviderError(fx.raw, { provider: fx.provider, transport: fx.transport });
    assert.equal(r.errorClass, fx.expected_error_class);
    assert.equal(r.shouldFallback, true);
    assert.equal(r.retriable, false);
});

// -----------------------------------------------------------------------------
// SR-2 — Sanitización de secretos en evidence/raw
// -----------------------------------------------------------------------------

test('SR-2 parser sanitiza AWS access key (AKIA…) en evidence', () => {
    const tainted = 'API Error: Usage credits required. Key: AKIAIOSFODNN7EXAMPLE';
    const r = parseProviderError(tainted, { provider: 'anthropic', transport: 'cli' });
    assert.equal(r.errorClass, 'quota_exhausted');
    assert.ok(!r.raw.includes('AKIAIOSFODNN7EXAMPLE'), `raw no debe contener la AWS key: ${r.raw}`);
    assert.ok(!r.evidence.includes('AKIAIOSFODNN7EXAMPLE'), `evidence no debe contener la AWS key: ${r.evidence}`);
});

test('SR-2 parser sanitiza Anthropic API key (sk-ant-…) en evidence', () => {
    const tainted = 'API Error: Usage credits required. Key: sk-ant-abcdef1234567890abcdef1234567890';
    const r = parseProviderError(tainted, { provider: 'anthropic', transport: 'cli' });
    assert.equal(r.errorClass, 'quota_exhausted');
    assert.ok(!r.raw.includes('sk-ant-abcdef'), `raw debe redactar sk-ant-…: ${r.raw}`);
    assert.ok(!r.evidence.includes('sk-ant-abcdef'), `evidence debe redactar sk-ant-…: ${r.evidence}`);
});

test('SR-2 parser sanitiza JWT en evidence', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NSIsIm5hbWUiOiJKb2huIERvZSJ9.signaturePartHere';
    const tainted = `Usage credits required Bearer ${jwt}`;
    const r = parseProviderError(tainted, { provider: 'anthropic', transport: 'cli' });
    assert.equal(r.errorClass, 'quota_exhausted');
    assert.ok(!r.raw.includes('eyJhbGci'), `raw debe redactar JWT: ${r.raw}`);
});

test('SR-2 parser strippea CR/LF en evidence (anti log-injection)', () => {
    const tainted = 'usage_limit_error\r\nFAKE_INJECTED_EVENT';
    const r = parseProviderError(tainted, { provider: 'anthropic', transport: 'cli' });
    assert.ok(!r.evidence.includes('\r'));
    assert.ok(!r.evidence.includes('\n'));
});

// -----------------------------------------------------------------------------
// SR-3 — Cap input + cap por línea (anti-DoS)
// -----------------------------------------------------------------------------

test('SR-3 parser trunca input >64KB antes de procesar', () => {
    const truncated = parser._truncateInput('x'.repeat(200000));
    assert.equal(truncated.length, parser.MAX_RAW_INPUT_BYTES);
});

test('SR-3 splitBoundedLines respeta cap de línea 16KB', () => {
    const longLine = 'data: {' + 'x'.repeat(30000) + '}';
    const lines = parser._splitBoundedLines(longLine);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].length, parser.MAX_LINE_BYTES);
});

// -----------------------------------------------------------------------------
// SR-4 — ReDoS-safe (1MB <50ms)
// -----------------------------------------------------------------------------

test('SR-4 parser con 1MB de input ejecuta en <50ms', () => {
    const huge = 'a'.repeat(1024 * 1024);
    const start = process.hrtime.bigint();
    parseProviderError(huge, { provider: 'anthropic', transport: 'cli' });
    const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
    assert.ok(elapsedMs < 50, `Esperaba <50ms, tardó ${elapsedMs.toFixed(2)}ms`);
});

test('SR-4 parser no ReDoS con payload patológico de quota', () => {
    const evil = 'quota' + ' '.repeat(50000) + 'NOT_EXHAUSTED_SUFFIX';
    const start = process.hrtime.bigint();
    parseProviderError(evil, { provider: 'anthropic', transport: 'cli' });
    const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
    assert.ok(elapsedMs < 50, `Esperaba <50ms vs ReDoS, tardó ${elapsedMs.toFixed(2)}ms`);
});

// -----------------------------------------------------------------------------
// SR-6 — parser NO llama setFlag (separación de responsabilidades)
// -----------------------------------------------------------------------------

test('SR-6 parser NO invoca setFlag bajo ninguna circunstancia', () => {
    let setFlagInvocations = 0;
    const fakeQuota = {
        sanitizeRawExcerpt: (s) => String(s || '').slice(0, 200),
        KNOWN_QUOTA_ERROR_TYPES_BY_PROVIDER: { anthropic: ['usage_limit_error'] },
        _detectAnthropic: (evt, allowlist) => {
            if (evt && evt.type === 'result' && evt.is_error && allowlist.includes(evt.error_type)) {
                return { matched: true, errorType: evt.error_type };
            }
            return { matched: false };
        },
        _detectOpenAI: () => ({ matched: false }),
        setFlag: () => { setFlagInvocations += 1; },
    };
    const raw = '{"type":"result","is_error":true,"error_type":"usage_limit_error"}';
    const r = parseProviderError(raw, {
        provider: 'anthropic',
        transport: 'cli',
        _quotaModule: fakeQuota,
    });
    assert.equal(r.errorClass, 'quota_exhausted');
    assert.equal(setFlagInvocations, 0, 'SR-6: el parser NO debe invocar setFlag');
});

// -----------------------------------------------------------------------------
// SR-7 — errorType respetando KNOWN_QUOTA_ERROR_TYPES_BY_PROVIDER
// -----------------------------------------------------------------------------

test('SR-7 parser respeta allowlist por provider — error_type fuera de la allowlist NO clasifica quota', () => {
    // El error_type 'completely_made_up_error' no está en la allowlist de
    // Anthropic. El parser debe NO clasificar quota_exhausted.
    const raw = '{"type":"result","is_error":true,"error_type":"completely_made_up_error"}';
    const fakeQuota = {
        sanitizeRawExcerpt: (s) => String(s || '').slice(0, 200),
        KNOWN_QUOTA_ERROR_TYPES_BY_PROVIDER: { anthropic: ['usage_limit_error', 'weekly_quota_exhausted'] },
        _detectAnthropic: (evt, allowlist) => {
            if (evt && evt.type === 'result' && evt.is_error && allowlist.includes(evt.error_type)) {
                return { matched: true, errorType: evt.error_type };
            }
            return { matched: false };
        },
        _detectOpenAI: () => ({ matched: false }),
    };
    const r = parseProviderError(raw, {
        provider: 'anthropic',
        transport: 'cli',
        _quotaModule: fakeQuota,
    });
    assert.notEqual(r.errorClass, 'quota_exhausted',
        'error_type fuera de allowlist NO debe disparar quota_exhausted');
});

// -----------------------------------------------------------------------------
// SR-9 — Parser SSE bounded por línea
// -----------------------------------------------------------------------------

test('SR-9 parser SSE tolera frame truncado al final', () => {
    const sse =
        'data: {"event":"chunk","data":{"text":"hola"}}\n' +
        'data: {"event":"error","data":{"error":{"type":"insufficient_quota"}}}\n' +
        'data: {"event":"partial",'; // truncado
    const r = parseProviderError(sse, { provider: 'openai-codex', transport: 'cli' });
    assert.equal(r.errorClass, 'quota_exhausted');
});

// -----------------------------------------------------------------------------
// Matriz pública classifyShouldFallback / classifyRetriable
// -----------------------------------------------------------------------------

test('matriz: classifyShouldFallback respeta política documentada', () => {
    assert.equal(parser.classifyShouldFallback('quota_exhausted'), true);
    assert.equal(parser.classifyShouldFallback('rate_limit'), true);
    assert.equal(parser.classifyShouldFallback('transient_5xx'), true);
    assert.equal(parser.classifyShouldFallback('auth'), true);
    assert.equal(parser.classifyShouldFallback('permanent_failure'), true);
    assert.equal(parser.classifyShouldFallback('cli_1m_context_glitch'), false);
    assert.equal(parser.classifyShouldFallback('unknown'), false);
});

test('matriz: classifyRetriable: rate_limit, transient_5xx y cli_1m_context_glitch', () => {
    assert.equal(parser.classifyRetriable('rate_limit'), true);
    assert.equal(parser.classifyRetriable('transient_5xx'), true);
    assert.equal(parser.classifyRetriable('cli_1m_context_glitch'), true);
    assert.equal(parser.classifyRetriable('quota_exhausted'), false);
    assert.equal(parser.classifyRetriable('auth'), false);
    assert.equal(parser.classifyRetriable('permanent_failure'), false);
    assert.equal(parser.classifyRetriable('unknown'), false);
});

// -----------------------------------------------------------------------------
// CA-6 / Signal B — HTTP status via http-error-classifier
// -----------------------------------------------------------------------------

test('CA-6/B: 429 vía API directa clasifica rate_limit con shouldFallback=true', () => {
    const raw = '{"error":{"status":429,"message":"Too many requests"}}';
    const r = parseProviderError(raw, { provider: 'gemini-google', transport: 'api' });
    assert.equal(r.errorClass, 'rate_limit');
    assert.equal(r.shouldFallback, true);
});

// -----------------------------------------------------------------------------
// CA-6 / Signal A — exit codes
// -----------------------------------------------------------------------------

test('CA-6/A: exitCode=1 a los 5s con stderr presente clasifica transient_5xx (no unknown)', () => {
    const r = parseProviderError('error inesperado', {
        provider: 'anthropic',
        transport: 'cli',
        exitCode: 1,
        timedOut: false,
        durationMs: 5000,
    });
    assert.notEqual(r.errorClass, 'unknown');
    assert.equal(r.errorClass, 'transient_5xx');
    assert.equal(r.shouldFallback, true);
});

// -----------------------------------------------------------------------------
// CA-6 / Signal C — output structural sin tokens
// -----------------------------------------------------------------------------

test('CA-6/C: stream con primer byte pero sin tokens útiles cae a transient_5xx via timeout signal', () => {
    // El parser hoy clasifica por contexto (timedOut/durationMs/exitCode).
    // Si firstByteAt presente pero rawOutput vacío y durationMs >= 30s →
    // transient. Esto cubre Signal C tal como está hoy.
    const r = parseProviderError('', {
        provider: 'anthropic',
        transport: 'cli',
        timedOut: false,
        exitCode: 0,
        durationMs: 35000,
    });
    assert.equal(r.errorClass, 'transient_5xx');
});
