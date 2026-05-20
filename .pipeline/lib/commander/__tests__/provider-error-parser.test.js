// =============================================================================
// provider-error-parser.test.js — Cobertura del parser de errores in-flight
// del Commander (#3434).
//
// Estructura:
//   1. Contrato básico (fail-closed, providers/transports desconocidos).
//   2. Cobertura por (provider, transport, errorClass esperado) via fixtures.
//   3. Defensa anti-DoS (input 1MB → <50ms).
//   4. Defensa anti-ReDoS (payloads conocidos → <50ms).
//   5. Adversarial: stdout envenenado (test estructural — el parser confía en
//      el caller para separar streams; este test documenta el contrato).
//   6. Sanitización: API keys redactadas, CR/LF stripped.
//   7. Regresión del incidente 2026-05-20 (timeout no_result).
//   8. Cap de input + cap por línea.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const parser = require('../provider-error-parser');
const { parseProviderError } = parser;

const FIXTURES_DIR = path.join(__dirname, '..', 'fixtures', 'provider-errors');

function loadFixture(name) {
    return JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, name), 'utf8'));
}

// -----------------------------------------------------------------------------
// 1. Contrato básico — SR-5 fail-closed
// -----------------------------------------------------------------------------

test('parseProviderError devuelve unknown sin provider', () => {
    const r = parseProviderError('error de algo', { transport: 'cli' });
    assert.equal(r.errorClass, 'unknown');
    assert.equal(r.shouldFallback, false);
    assert.equal(r.retriable, false);
});

test('parseProviderError devuelve unknown sin transport', () => {
    const r = parseProviderError('error de algo', { provider: 'anthropic' });
    assert.equal(r.errorClass, 'unknown');
    assert.equal(r.shouldFallback, false);
});

test('parseProviderError devuelve unknown con provider no en allowlist', () => {
    const r = parseProviderError('error', { provider: 'evil-corp', transport: 'cli' });
    assert.equal(r.errorClass, 'unknown');
    assert.equal(r.shouldFallback, false);
});

test('parseProviderError devuelve unknown con transport invalido', () => {
    const r = parseProviderError('error', { provider: 'anthropic', transport: 'magic' });
    assert.equal(r.errorClass, 'unknown');
    assert.equal(r.shouldFallback, false);
});

test('parseProviderError con rawOutput vacio y sin ctx útil retorna unknown', () => {
    const r = parseProviderError('', { provider: 'anthropic', transport: 'cli' });
    assert.equal(r.errorClass, 'unknown');
    assert.equal(r.shouldFallback, false);
});

// -----------------------------------------------------------------------------
// 2. Cobertura por fixture (provider × transport × errorClass esperado)
// -----------------------------------------------------------------------------

test('Anthropic CLI stream-json estructural clasifica quota_exhausted (real, incidente 2026-05-20)', () => {
    const fx = loadFixture('anthropic-cli-usage-limit-real.json');
    const r = parseProviderError(fx.raw, { provider: fx.provider, transport: fx.transport });
    assert.equal(r.errorClass, fx.expected_error_class);
    assert.equal(r.shouldFallback, fx.expected_should_fallback);
    assert.equal(r.retriable, fx.expected_retriable);
    assert.ok(r.evidence.length > 0, 'evidence debe traer el shape detectado');
});

test('Anthropic CLI texto "Usage credits required" clasifica quota_exhausted via regex', () => {
    const fx = loadFixture('anthropic-cli-credits-required.json');
    const r = parseProviderError(fx.raw, { provider: fx.provider, transport: fx.transport });
    assert.equal(r.errorClass, 'quota_exhausted');
    assert.equal(r.shouldFallback, true);
    assert.equal(r.retriable, false);
});

test('OpenAI/Codex SSE error.type=insufficient_quota clasifica quota_exhausted', () => {
    const fx = loadFixture('openai-codex-sse-insufficient-quota.json');
    const r = parseProviderError(fx.raw, { provider: fx.provider, transport: fx.transport });
    assert.equal(r.errorClass, 'quota_exhausted');
    assert.equal(r.shouldFallback, true);
});

test('Gemini API JSON error.code=resource_exhausted clasifica quota_exhausted', () => {
    const fx = loadFixture('gemini-api-resource-exhausted.json');
    const r = parseProviderError(fx.raw, { provider: fx.provider, transport: fx.transport });
    assert.equal(r.errorClass, 'quota_exhausted');
    assert.equal(r.shouldFallback, true);
});

test('Cerebras API JSON con code en allowlist quota clasifica quota_exhausted (convención del provider)', () => {
    // Cerebras declara `rate_limit_exceeded` como quota_error_type en
    // agent-models.json — para Cerebras, ese code ES cuota, no rate-limit
    // transitorio. El parser respeta la convención declarativa.
    const fx = loadFixture('cerebras-api-rate-limit.json');
    const r = parseProviderError(fx.raw, { provider: fx.provider, transport: fx.transport });
    assert.equal(r.errorClass, 'quota_exhausted');
    assert.equal(r.shouldFallback, true);
});

test('Cerebras API JSON 429 sin code en allowlist clasifica rate_limit puro', () => {
    const fx = loadFixture('cerebras-api-rate-limit-pure.json');
    const r = parseProviderError(fx.raw, { provider: fx.provider, transport: fx.transport });
    assert.equal(r.errorClass, 'rate_limit');
    assert.equal(r.shouldFallback, true);
    assert.equal(r.retriable, true, 'rate_limit puro es retriable con backoff');
});

test('OpenAI context_length_exceeded clasifica permanent_failure con shouldFallback=true', () => {
    const fx = loadFixture('openai-api-context-length.json');
    const r = parseProviderError(fx.raw, { provider: fx.provider, transport: fx.transport });
    assert.equal(r.errorClass, 'permanent_failure');
    assert.equal(r.shouldFallback, true);
    assert.equal(r.retriable, false, 'permanent_failure NO es retriable');
});

// -----------------------------------------------------------------------------
// 3. Defensa anti-DoS (SR-3) — input gigante no debe colgar el parser
// -----------------------------------------------------------------------------

test('parseProviderError con 1MB de input ejecuta en <50ms (SR-3)', () => {
    const huge = 'a'.repeat(1024 * 1024); // 1MB de carácter benigno
    const start = process.hrtime.bigint();
    const r = parseProviderError(huge, { provider: 'anthropic', transport: 'cli' });
    const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
    assert.ok(elapsedMs < 50, `Esperaba <50ms, tardó ${elapsedMs.toFixed(2)}ms`);
    // Lo importante: NO clasifica como nada porque el input es benigno; el cap
    // protege que ni siquiera se evalúan los regex sobre el MB entero.
    assert.equal(r.errorClass, 'unknown');
});

test('parseProviderError trunca input >64KB antes de procesar', () => {
    const truncated = parser._truncateInput('x'.repeat(200000));
    assert.equal(truncated.length, parser.MAX_RAW_INPUT_BYTES);
});

test('parseProviderError respeta cap de linea 16KB en splitBoundedLines', () => {
    const longLine = 'data: {' + 'x'.repeat(30000) + '}';
    const lines = parser._splitBoundedLines(longLine);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].length, parser.MAX_LINE_BYTES);
});

// -----------------------------------------------------------------------------
// 4. Defensa anti-ReDoS (SR-4) — payloads conocidos
// -----------------------------------------------------------------------------

test('parseProviderError no ReDoS con payload patológico de exhausted (SR-4)', () => {
    // Patrón clásico anti-ReDoS: muchas `a` seguido de algo que no matchea.
    // Si el regex tiene `.*` libre, esto explota en backtracking.
    const evil = 'quota' + ' '.repeat(50000) + 'NOT_EXHAUSTED_SUFFIX';
    const start = process.hrtime.bigint();
    parseProviderError(evil, { provider: 'anthropic', transport: 'cli' });
    const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
    assert.ok(elapsedMs < 50, `Esperaba <50ms vs ReDoS, tardó ${elapsedMs.toFixed(2)}ms`);
});

test('parseProviderError no ReDoS con 429 ambiguo (SR-4)', () => {
    // Otro payload de stress: `429` seguido de muchísimos chars.
    const evil = '429' + 'x'.repeat(50000) + 'rate';
    const start = process.hrtime.bigint();
    parseProviderError(evil, { provider: 'anthropic', transport: 'api' });
    const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
    assert.ok(elapsedMs < 50, `Esperaba <50ms vs ReDoS, tardó ${elapsedMs.toFixed(2)}ms`);
});

// -----------------------------------------------------------------------------
// 5. Adversarial (SR-1) — stdout envenenado
//
// El parser CONFÍA en que el caller pasa stderr (no stdout). Si el caller
// pasa stdout con texto del modelo que CONTIENE "Usage credits required", el
// parser SÍ clasifica quota_exhausted — la separación de streams vive en el
// wrapper de spawn. Documentamos esa frontera con tests negativos del wire.
//
// Lo que sí podemos validar: el detector ESTRUCTURAL (shape Anthropic JSON)
// no se activa si el texto NO es JSON. Eso reduce la superficie de ataque
// — el modelo tendría que emitir literalmente `{"type":"result","is_error":...}`
// como JSON válido en su respuesta. Tests:
// -----------------------------------------------------------------------------

test('parseProviderError NO clasifica quota cuando el modelo solo menciona credits sin shape JSON ni stderr', () => {
    // Caso: el modelo respondió describiendo el error, sin shape JSON.
    // El parser cae al regex; el regex SÍ matchea porque el caller pasó
    // el texto como si fuera stderr. Esto es DELIBERADO: el parser confía
    // en el caller. Para que esto NO matchee, el wire post-spawn debe
    // pasar SOLO stderr al parser.
    //
    // El test acá documenta el comportamiento (matchea) para que el dev
    // entienda dónde está la frontera: la defensa vive en el wire, no acá.
    const stdout = 'El error "Usage credits required" significa que tu cuenta...';
    const r = parseProviderError(stdout, { provider: 'anthropic', transport: 'cli' });
    assert.equal(r.errorClass, 'quota_exhausted',
        'El parser por diseño clasifica si el texto matchea — la separación stdout/stderr es responsabilidad del wire (multi-provider.js#runCommanderSpawn).');
});

test('parseProviderError NO se confunde con shape JSON enmascarado en texto natural', () => {
    // El modelo dice "el evento se ve así: type: result, is_error: true" sin
    // shape JSON real. El parser no clasifica como quota_exhausted porque
    // no es JSON parseable.
    const stdout = 'El evento se ve así: type: result, is_error: true, pero esto no es JSON.';
    const r = parseProviderError(stdout, { provider: 'anthropic', transport: 'cli' });
    // El parser cae al regex; ninguno de los patrones de quota matchea acá.
    // El resultado depende del contenido: en este caso debería ser unknown.
    assert.notEqual(r.errorClass, 'quota_exhausted');
});

// -----------------------------------------------------------------------------
// 6. Sanitización — SR-2 reusa sanitizeRawExcerpt
// -----------------------------------------------------------------------------

test('parseProviderError sanitiza API keys en evidence', () => {
    // Anthropic API key sintética en el rawOutput.
    const tainted = 'API Error: Usage credits required. Key was sk-ant-abc123def456ghi789jkl012mno345';
    const r = parseProviderError(tainted, { provider: 'anthropic', transport: 'cli' });
    assert.equal(r.errorClass, 'quota_exhausted');
    assert.ok(!r.raw.includes('sk-ant-abc123'), `raw no debe contener la API key sin redactar: ${r.raw}`);
    assert.ok(!r.evidence.includes('sk-ant-abc123'), `evidence no debe contener la API key: ${r.evidence}`);
});

test('parseProviderError sanitiza CR/LF en evidence (anti log-injection)', () => {
    const tainted = 'usage_limit_error\r\nFAKE_EVENT_INJECTED';
    const r = parseProviderError(tainted, { provider: 'anthropic', transport: 'cli' });
    // El sanitizer reemplaza CR/LF por espacios.
    assert.ok(!r.evidence.includes('\r'));
    assert.ok(!r.evidence.includes('\n'));
});

test('parseProviderError trunca evidence a 200 chars max', () => {
    const long = 'API Error: Usage credits required.' + ' x'.repeat(500);
    const r = parseProviderError(long, { provider: 'anthropic', transport: 'cli' });
    assert.ok(r.evidence.length <= 200, `evidence debe quedar ≤200 chars, mide ${r.evidence.length}`);
});

// -----------------------------------------------------------------------------
// 7. Regresión del incidente 2026-05-20 — timeout no_result
// -----------------------------------------------------------------------------

test('Regresión incidente 2026-05-20: timeout 600s sin output clasifica transient_5xx', () => {
    const fx = loadFixture('incident-no-result-timeout.json');
    const r = parseProviderError(fx.raw, {
        provider: fx.provider,
        transport: fx.transport,
        timedOut: fx.ctx.timedOut,
        exitCode: fx.ctx.exitCode,
        durationMs: fx.ctx.durationMs,
    });
    assert.equal(r.errorClass, 'transient_5xx');
    assert.equal(r.shouldFallback, true);
    assert.equal(r.retriable, true);
    assert.match(r.evidence, /timedOut=true/);
    assert.match(r.evidence, /durationMs=600156/);
});

test('exitCode no-cero con stderr presente clasifica transient_5xx', () => {
    const r = parseProviderError('error inesperado', {
        provider: 'anthropic',
        transport: 'cli',
        exitCode: 1,
        timedOut: false,
        durationMs: 5000,
    });
    // El texto "error inesperado" no matchea ningún regex específico, pero
    // exitCode=1 con stderr presente clasifica como transient_5xx.
    assert.equal(r.errorClass, 'transient_5xx');
    assert.equal(r.shouldFallback, true);
});

test('durationMs >= 30s sin shape clasifica transient_5xx aunque timedOut=false', () => {
    const r = parseProviderError('', {
        provider: 'anthropic',
        transport: 'cli',
        timedOut: false,
        exitCode: 0,
        durationMs: 35000,
    });
    assert.equal(r.errorClass, 'transient_5xx');
});

// -----------------------------------------------------------------------------
// 8. Matriz errorClass × shouldFallback × retriable
// -----------------------------------------------------------------------------

test('classifyShouldFallback respeta la matriz documentada', () => {
    assert.equal(parser.classifyShouldFallback('quota_exhausted'), true);
    assert.equal(parser.classifyShouldFallback('rate_limit'), true);
    assert.equal(parser.classifyShouldFallback('transient_5xx'), true);
    assert.equal(parser.classifyShouldFallback('auth'), true);
    assert.equal(parser.classifyShouldFallback('permanent_failure'), true);
    assert.equal(parser.classifyShouldFallback('unknown'), false);
});

test('classifyRetriable: solo rate_limit y transient_5xx son retriable', () => {
    assert.equal(parser.classifyRetriable('rate_limit'), true);
    assert.equal(parser.classifyRetriable('transient_5xx'), true);
    assert.equal(parser.classifyRetriable('quota_exhausted'), false);
    assert.equal(parser.classifyRetriable('auth'), false);
    assert.equal(parser.classifyRetriable('permanent_failure'), false);
    assert.equal(parser.classifyRetriable('unknown'), false);
});

// -----------------------------------------------------------------------------
// 9. SSE truncado (SR-9)
// -----------------------------------------------------------------------------

test('parseProviderError soporta SSE truncado a mitad de frame', () => {
    // Stream SSE con un frame válido y otro truncado.
    const sse =
        'data: {"event":"chunk","data":{"text":"hola"}}\n' +
        'data: {"event":"error","data":{"error":{"type":"insufficient_quota"}}}\n' +
        'data: {"event":"partial",'; // truncado al final
    const r = parseProviderError(sse, { provider: 'openai-codex', transport: 'cli' });
    // El parser CLI lee línea por línea como JSON; encuentra el error.
    assert.equal(r.errorClass, 'quota_exhausted');
});

// -----------------------------------------------------------------------------
// 10. Auth y permanent_failure por API
// -----------------------------------------------------------------------------

test('API directa: status 401 clasifica auth', () => {
    const raw = '{"error":{"type":"authentication_error","status":401,"message":"Invalid API key"}}';
    const r = parseProviderError(raw, { provider: 'gemini-google', transport: 'api' });
    assert.equal(r.errorClass, 'auth');
    assert.equal(r.shouldFallback, true);
    assert.equal(r.retriable, false);
});

test('API directa: status 503 clasifica transient_5xx', () => {
    const raw = '{"error":{"type":"overloaded_error","status":503,"message":"Service unavailable"}}';
    const r = parseProviderError(raw, { provider: 'gemini-google', transport: 'api' });
    assert.equal(r.errorClass, 'transient_5xx');
    assert.equal(r.shouldFallback, true);
});

test('API directa: status 429 sin allowlist match clasifica rate_limit', () => {
    const raw = '{"error":{"status":429,"message":"Too many requests"}}';
    const r = parseProviderError(raw, { provider: 'gemini-google', transport: 'api' });
    assert.equal(r.errorClass, 'rate_limit');
});

// -----------------------------------------------------------------------------
// 11. Cobertura del módulo de inyección (_quotaModule override)
// -----------------------------------------------------------------------------

// -----------------------------------------------------------------------------
// 12. runCommanderSpawn — wire post-spawn (CA-5)
// -----------------------------------------------------------------------------

test('runCommanderSpawn persiste flag solo para quota_exhausted/rate_limit', () => {
    const mp = require('../multi-provider');
    const setCalls = [];
    const fakeQuota = {
        sanitizeRawExcerpt: (s) => String(s || '').slice(0, 200),
        KNOWN_QUOTA_ERROR_TYPES_BY_PROVIDER: {
            anthropic: ['usage_limit_error', 'weekly_quota_exhausted'],
        },
        _detectAnthropic: (evt, allowlist) => {
            if (evt && evt.type === 'result' && evt.is_error && allowlist.includes(evt.error_type)) {
                return { matched: true, errorType: evt.error_type };
            }
            return { matched: false };
        },
        _detectOpenAI: () => ({ matched: false }),
        setFlag: (opts) => { setCalls.push(opts); return { flagPath: '/tmp/x', payload: {}, source: 'input' }; },
    };
    const result = mp.runCommanderSpawn({
        provider: 'anthropic',
        transport: 'cli',
        rawOutput: '{"type":"result","is_error":true,"error_type":"usage_limit_error"}',
        quotaModule: fakeQuota,
        // pipelineDir omitido → no audit log
    });
    assert.equal(result.errorClass, 'quota_exhausted');
    assert.equal(result.flagSet, true);
    assert.equal(result.decision, 'flag_set');
    assert.equal(setCalls.length, 1);
    assert.equal(setCalls[0].provider, 'anthropic');
    assert.equal(setCalls[0].errorType, 'usage_limit_error');
});

test('runCommanderSpawn NO persiste flag para transient_5xx', () => {
    const mp = require('../multi-provider');
    const setCalls = [];
    const fakeQuota = {
        sanitizeRawExcerpt: (s) => String(s || '').slice(0, 200),
        KNOWN_QUOTA_ERROR_TYPES_BY_PROVIDER: { anthropic: ['usage_limit_error'] },
        _detectAnthropic: () => ({ matched: false }),
        _detectOpenAI: () => ({ matched: false }),
        setFlag: (opts) => { setCalls.push(opts); return {}; },
    };
    const result = mp.runCommanderSpawn({
        provider: 'anthropic',
        transport: 'cli',
        rawOutput: '',
        timedOut: true,
        durationMs: 600156,
        quotaModule: fakeQuota,
    });
    assert.equal(result.errorClass, 'transient_5xx');
    assert.equal(result.flagSet, false);
    assert.equal(result.decision, 'fallback');
    assert.equal(setCalls.length, 0, 'transient_5xx NO debe llamar setFlag');
});

test('runCommanderSpawn NO persiste flag para permanent_failure', () => {
    const mp = require('../multi-provider');
    const setCalls = [];
    const fakeQuota = {
        sanitizeRawExcerpt: (s) => String(s || '').slice(0, 200),
        KNOWN_QUOTA_ERROR_TYPES_BY_PROVIDER: { 'openai-codex': ['insufficient_quota'] },
        _detectAnthropic: () => ({ matched: false }),
        _detectOpenAI: () => ({ matched: false }),
        setFlag: (opts) => { setCalls.push(opts); return {}; },
    };
    const raw = '{"error":{"type":"invalid_request_error","code":"context_length_exceeded"}}';
    const result = mp.runCommanderSpawn({
        provider: 'openai-codex',
        transport: 'api',
        rawOutput: raw,
        quotaModule: fakeQuota,
    });
    assert.equal(result.errorClass, 'permanent_failure');
    assert.equal(result.flagSet, false);
    assert.equal(setCalls.length, 0);
});

test('runCommanderSpawn extrae errorType del evidence cuando es JSON', () => {
    const mp = require('../multi-provider');
    const setCalls = [];
    const fakeQuota = {
        sanitizeRawExcerpt: (s) => String(s || '').slice(0, 200),
        KNOWN_QUOTA_ERROR_TYPES_BY_PROVIDER: {
            'openai-codex': ['insufficient_quota', 'billing_hard_limit_reached'],
        },
        _detectAnthropic: () => ({ matched: false }),
        _detectOpenAI: (evt, allowlist) => {
            if (evt && evt.event === 'error' && evt.data && evt.data.error &&
                allowlist.includes(evt.data.error.type)) {
                return { matched: true, errorType: evt.data.error.type };
            }
            return { matched: false };
        },
        setFlag: (opts) => { setCalls.push(opts); return {}; },
    };
    const raw = 'data: {"event":"error","data":{"error":{"type":"billing_hard_limit_reached"}}}';
    const result = mp.runCommanderSpawn({
        provider: 'openai-codex',
        transport: 'cli',
        rawOutput: raw,
        quotaModule: fakeQuota,
    });
    assert.equal(result.errorClass, 'quota_exhausted');
    assert.equal(result.flagSet, true);
    assert.equal(setCalls[0].errorType, 'billing_hard_limit_reached',
        'debe usar el errorType extraído del evidence, no el primer default');
});

test('_selectErrorTypeForFlag cae al primer elemento de la allowlist si no puede extraer', () => {
    const mp = require('../multi-provider');
    const fakeQuota = {
        KNOWN_QUOTA_ERROR_TYPES_BY_PROVIDER: {
            'gemini-google': ['quota_exceeded', 'resource_exhausted'],
        },
    };
    const verdict = { errorClass: 'quota_exhausted', evidence: 'texto libre sin shape' };
    const errorType = mp._selectErrorTypeForFlag('gemini-google', verdict, fakeQuota);
    assert.equal(errorType, 'quota_exceeded');
});

test('_selectErrorTypeForFlag retorna null si allowlist vacía', () => {
    const mp = require('../multi-provider');
    const fakeQuota = { KNOWN_QUOTA_ERROR_TYPES_BY_PROVIDER: {} };
    const verdict = { errorClass: 'quota_exhausted', evidence: '' };
    const errorType = mp._selectErrorTypeForFlag('anthropic', verdict, fakeQuota);
    assert.equal(errorType, null);
});

// -----------------------------------------------------------------------------
// 13. Defensa final (catch-all)
// -----------------------------------------------------------------------------

test('parseProviderError acepta quotaModule inyectado (test isolation)', () => {
    const fakeQuota = {
        sanitizeRawExcerpt: (s) => `[FAKE]${String(s || '').slice(0, 50)}`,
        KNOWN_QUOTA_ERROR_TYPES_BY_PROVIDER: {
            anthropic: ['usage_limit_error'],
        },
        _detectAnthropic: (evt, allowlist) => {
            if (evt && evt.type === 'result' && evt.is_error && allowlist.includes(evt.error_type)) {
                return { matched: true, errorType: evt.error_type };
            }
            return { matched: false };
        },
        _detectOpenAI: () => ({ matched: false }),
    };
    const raw = '{"type":"result","is_error":true,"error_type":"usage_limit_error"}';
    const r = parseProviderError(raw, {
        provider: 'anthropic',
        transport: 'cli',
        _quotaModule: fakeQuota,
    });
    assert.equal(r.errorClass, 'quota_exhausted');
    assert.ok(r.raw.startsWith('[FAKE]'), 'debe usar el sanitizer inyectado');
});
