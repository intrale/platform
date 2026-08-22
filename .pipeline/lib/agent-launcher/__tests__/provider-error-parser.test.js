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

test('codex ChatGPT: turn.failed con "usage limit" (canal de control) clasifica quota_exhausted', () => {
    // Shape real del CLI Codex con cuenta ChatGPT (OAuth): sin error.type
    // estructurado, sólo message en el frame de control turn.failed.
    const raw = [
        '{"type":"turn.started"}',
        '{"type":"error","message":"You\\u0027ve hit your usage limit. Upgrade to Pro or try again at Jul 6th, 2026 2:19 AM."}',
        '{"type":"turn.failed","error":{"message":"You\\u0027ve hit your usage limit. Upgrade to Pro or try again at Jul 6th, 2026 2:19 AM."}}',
    ].join('\n');
    const r = parseProviderError(raw, { provider: 'openai-codex', transport: 'cli' });
    assert.equal(r.errorClass, 'quota_exhausted');
    assert.equal(r.shouldFallback, true);
});

test('codex ChatGPT: "hit your usage limit" en stderr texto plano clasifica quota_exhausted via regex', () => {
    const raw = "API error: You've hit your usage limit. Upgrade to Pro.";
    const r = parseProviderError(raw, { provider: 'openai-codex', transport: 'cli' });
    assert.equal(r.errorClass, 'quota_exhausted');
    assert.equal(r.shouldFallback, true);
});

// -----------------------------------------------------------------------------
// #4541 — Misatribución de provider + falso positivo sobre contenido normal.
//
// Regresión del incidente 2026-07-07: el detector marcaba a Anthropic como
// quota-exhausted usando errores de límite de Codex/ChatGPT. Dos causas:
//   Bug 1 (misatribución): el error de Codex se atribuía al primary configurado
//     (anthropic) en vez del provider efectivo que corrió (openai-codex).
//   Bug 2 (falso positivo): los regex de texto libre matcheaban contenido
//     legítimo del agente (`tool_result` que menciona "usage limit").
//
// Los `raw_excerpt` de estos tests son los REALES del incidente
// (`.pipeline/logs/quota-detector-2026-07-07.log`), saneados.
// -----------------------------------------------------------------------------

// Frame REAL de error del CLI Codex (canal de control) del incidente.
const INCIDENT_CODEX_ERROR_FRAME =
    '{"type":"error","message":"You\'ve hit your usage limit. Upgrade to Pro ' +
    '(https://chatgpt.com/explore/pro), visit https://chatgpt.com/codex/settings/usage ' +
    'to purchase more credits or try again at Jul 7th, 2026 11:19 AM."}';

// Línea REAL de contenido (`type:user` → `tool_result`) del incidente: NO es un
// error, es contenido del agente. Aunque acá le agregamos el texto "usage limit"
// embebido para forzar el peor caso del falso positivo (Bug 2).
const INCIDENT_TOOL_RESULT_CONTENT =
    '{"type":"user","message":{"role":"user","content":[{"tool_use_id":"toolu_01TQ9E5H6kQaGL9GT7LKwPJE",' +
    '"type":"tool_result","content":"Analicé el log del detector y encontré este mensaje de Codex: ' +
    'You\'ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/codex/settings/usage)."}]}}';

test('#4541 CA-3: frame de error REAL de Codex con provider=openai-codex clasifica quota_exhausted', () => {
    const r = parseProviderError(INCIDENT_CODEX_ERROR_FRAME, {
        provider: 'openai-codex',
        transport: 'cli',
    });
    assert.equal(r.errorClass, 'quota_exhausted',
        'el error real de Codex debe clasificar quota (para flaguear codex)');
    assert.equal(r.shouldFallback, true);
});

test('#4541 CA-1: el MISMO frame de Codex bajo provider=anthropic NO clasifica quota (no misatribución)', () => {
    // Bajo la allowlist de Anthropic, un frame de Codex (`type:error`, sin
    // `error_type` estructural de anthropic) NO debe clasificar quota: es una
    // línea JSON del stream, así que los regex de texto libre no la tocan y la
    // detección estructural de anthropic (type:result+is_error) no matchea.
    // Antes de #4541 el regex `hit your usage limit` la marcaba → flag espurio
    // de anthropic.
    const r = parseProviderError(INCIDENT_CODEX_ERROR_FRAME, {
        provider: 'anthropic',
        transport: 'cli',
    });
    assert.notEqual(r.errorClass, 'quota_exhausted',
        'un error de Codex NUNCA debe setear el flag de Anthropic');
});

test('#4541 CA-2: tool_result con "usage limit" en el contenido NO clasifica quota (falso positivo)', () => {
    // El primer flag del incidente (01:17) era exactamente esto: contenido
    // legítimo de un `tool_result` que menciona "usage limit". No es un error.
    const r = parseProviderError(INCIDENT_TOOL_RESULT_CONTENT, {
        provider: 'anthropic',
        transport: 'cli',
    });
    assert.notEqual(r.errorClass, 'quota_exhausted',
        'contenido del agente (tool_result) NO debe disparar quota_exhausted');
});

test('#4541 CA-2: tool_result con texto de Codex tampoco flaguea bajo provider=openai-codex', () => {
    // Defensa en profundidad: aun si el provider efectivo fuese codex, el texto
    // dentro de un `tool_result` (contenido, no canal de control) no debe
    // clasificar quota. Solo el frame de control estructural (type:error /
    // turn.failed) cuenta como error real del CLI.
    const r = parseProviderError(INCIDENT_TOOL_RESULT_CONTENT, {
        provider: 'openai-codex',
        transport: 'cli',
    });
    assert.notEqual(r.errorClass, 'quota_exhausted',
        'el contenido tool_result no es el payload de error del CLI');
});

test('#4541 Bug 2: stderr de texto plano legítimo (sin JSON) SIGUE clasificando quota', () => {
    // No sobre-corregimos: un error de CLI que llega como texto plano degradado
    // (crash antes del JSON) debe seguir detectándose por regex.
    const r = parseProviderError('API Error: Usage credits required — sin créditos.', {
        provider: 'anthropic',
        transport: 'cli',
    });
    assert.equal(r.errorClass, 'quota_exhausted',
        'el stderr de texto plano real no debe verse afectado por el fix de contenido');
});

// -----------------------------------------------------------------------------
// #5454 — Límite SEMANAL de Anthropic en el canal degradado (stderr/texto plano).
//
// Defensa en profundidad de #5424: el aviso real del CLI Anthropic
// ("You've hit your weekly limit · resets 9pm (America/Buenos_Aires)") no
// matcheaba ningún patrón de `CLI_QUOTA_PATTERNS` y caía a `unknown`, con lo
// cual el launcher no marcaba cuota agotada ni habilitaba fallback.
//
// Contrato completo que fijamos acá:
//   * weekly/session/usage sobre texto plano → quota_exhausted + fallback + no retriable.
//   * la MISMA frase dentro de un frame estructurado (`tool_result`) NO clasifica cuota.
//   * `Usage credits required for 1M context` conserva precedencia (cli_1m_context_glitch).
//   * el patrón es acotado: entrada adversarial sin match queda `unknown` bajo SR-4.
// -----------------------------------------------------------------------------

// Texto REAL del aviso semanal, con el sufijo de reset tal cual lo emite el CLI.
const WEEKLY_LIMIT_REAL_TEXT =
    "You've hit your weekly limit · resets 9pm (America/Buenos_Aires)";

// Matriz de límites por texto plano (canal degradado del CLI).
const PLAIN_TEXT_QUOTA_CASES = [
    {
        nombre: 'weekly con el sufijo real de reset',
        raw: WEEKLY_LIMIT_REAL_TEXT,
        provider: 'anthropic',
    },
    {
        nombre: 'weekly con prefijo de error del CLI',
        raw: `API Error: ${WEEKLY_LIMIT_REAL_TEXT}`,
        provider: 'anthropic',
    },
    {
        nombre: 'session limit (sin regresión)',
        raw: "API Error: You've hit your session limit. Try again later.",
        provider: 'anthropic',
    },
    {
        nombre: 'usage limit (sin regresión)',
        raw: "API error: You've hit your usage limit. Upgrade to Pro.",
        provider: 'openai-codex',
    },
];

for (const caso of PLAIN_TEXT_QUOTA_CASES) {
    test(`#5454 texto plano — ${caso.nombre} clasifica quota_exhausted`, () => {
        const r = parseProviderError(caso.raw, {
            provider: caso.provider,
            transport: 'cli',
        });
        assert.equal(r.errorClass, 'quota_exhausted',
            `"${caso.raw}" debía clasificar como cuota agotada`);
        assert.equal(r.shouldFallback, true, 'debe habilitar fallback de provider');
        assert.equal(r.retriable, false, 'una cuota agotada NO es reintentable');
    });
}

test('#5454 el patrón weekly está en CLI_QUOTA_PATTERNS y es acotado (sin .* ni grupos opcionales)', () => {
    const fuentes = parser._CLI_QUOTA_PATTERNS.map((re) => re.source);
    const weekly = fuentes.filter((s) => /weekly\\s\+limit/.test(s));
    assert.equal(weekly.length, 1,
        `esperaba exactamente un patrón weekly en CLI_QUOTA_PATTERNS, encontré ${weekly.length}`);
    const src = weekly[0];
    assert.ok(!src.includes('.*'), 'el patrón no debe usar `.*`');
    assert.ok(!src.includes('?'), 'el patrón no debe usar cuantificadores/grupos opcionales');
    assert.ok(!/\(\?:.*[+*].*\)[+*]/.test(src), 'el patrón no debe anidar cuantificadores');
});

test('#5454 aislamiento: weekly dentro de un tool_result estructurado NO clasifica quota', () => {
    // Mismo shape que INCIDENT_TOOL_RESULT_CONTENT (#4541): contenido del agente,
    // no canal de control. Contenido controlado por la tarea NUNCA debe poder
    // deshabilitar un provider por substring.
    const frame =
        '{"type":"user","message":{"role":"user","content":[{"tool_use_id":"toolu_01TQ9E5H6kQaGL9GT7LKwPJE",' +
        '"type":"tool_result","content":"Leí el reporte del incidente y decía: ' +
        "You've hit your weekly limit · resets 9pm (America/Buenos_Aires).\"}]}}";
    const r = parseProviderError(frame, { provider: 'anthropic', transport: 'cli' });
    assert.notEqual(r.errorClass, 'quota_exhausted',
        'la frase weekly dentro de un tool_result no es un error del provider');
});

test('#5454 aislamiento: weekly dentro de contenido del modelo (assistant) NO clasifica quota', () => {
    const frame =
        '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text",' +
        '"text":"El CLI reporta cuando ' + "You've hit your weekly limit" + '."}]}}';
    const r = parseProviderError(frame, { provider: 'anthropic', transport: 'cli' });
    assert.notEqual(r.errorClass, 'quota_exhausted',
        'el contenido del modelo no es el payload de error del CLI');
});

test('#5454 precedencia: "Usage credits required for 1M context" sigue siendo cli_1m_context_glitch', () => {
    // El genérico `Usage credits required` de CLI_QUOTA_PATTERNS solapa con el
    // glitch 1M (#3506). Con el workaround ACTIVO la rama del glitch se evalúa
    // primero y el agregado de #5454 no debe alterar ese orden.
    const previo = process.env.ANTHROPIC_1M_WORKAROUND_ENABLED;
    process.env.ANTHROPIC_1M_WORKAROUND_ENABLED = '1';
    try {
        const r = parseProviderError(
            'API Error: Usage credits required for 1M context',
            { provider: 'anthropic', transport: 'cli' },
        );
        assert.equal(r.errorClass, 'cli_1m_context_glitch',
            'el glitch 1M NO es cuota real: debe conservar precedencia');
        assert.notEqual(r.errorClass, 'quota_exhausted');
    } finally {
        if (previo === undefined) delete process.env.ANTHROPIC_1M_WORKAROUND_ENABLED;
        else process.env.ANTHROPIC_1M_WORKAROUND_ENABLED = previo;
    }
});

test('#5454 SR-4: entrada larga adversarial con prefijos weekly parciales queda unknown en <50ms', () => {
    // Peor caso para el patrón nuevo: muchísimas repeticiones del prefijo
    // `hit your weekly ` sin la palabra final `limit`, más whitespace largo
    // entre tokens (el separador `\s+` es el único cuantificador del regex).
    const evil =
        ('hit your weekly ' + ' '.repeat(200)).repeat(2000) + 'NOT_A_LIMIT_SUFFIX';
    const start = process.hrtime.bigint();
    const r = parseProviderError(evil, { provider: 'anthropic', transport: 'cli' });
    const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
    assert.equal(r.errorClass, 'unknown',
        'sin la palabra `limit` no hay match: debe quedar unknown');
    assert.notEqual(r.errorClass, 'quota_exhausted');
    assert.ok(elapsedMs < 50, `Esperaba <50ms (SR-4), tardó ${elapsedMs.toFixed(2)}ms`);
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

// =============================================================================
// #5795 — Clasificación tipada `authentication_rejected` por provider.
//
// La matriz es PARAMETRIZADA sobre los siete adapters. Cada fila declara:
//   - `positives`: frames reales del provider que SÍ tienen que clasificar.
//   - `foreign`:   una señal válida para OTRO provider, que en este adapter
//                  tiene que devolver "sin clasificación" (aislamiento).
//   - `negatives`: frames que se le parecen y NO pueden clasificar.
// Los negativos comunes (timeout, 5xx, cuota, config, permisos, 401/403
// pelado, texto libre, JSON/SSE malformado) se corren contra TODOS los
// adapters, no sólo contra uno.
// =============================================================================

const authRejectionModule = require('../auth-rejection');
const AUTH_CLASS = 'authentication_rejected';

// Módulo de cuota mínimo: para estos tests no queremos que la rama de cuota
// participe. Devuelve allowlists vacías y detectores que nunca matchean.
function quotaModuleSilencioso() {
    return {
        sanitizeRawExcerpt: (s) => String(s == null ? '' : s).slice(0, 200).replace(/[\r\n]/g, ' '),
        KNOWN_QUOTA_ERROR_TYPES_BY_PROVIDER: {},
        _detectAnthropic: () => ({ matched: false }),
        _detectOpenAI: () => ({ matched: false }),
    };
}

function parseAuth(raw, provider, transport = 'cli') {
    return parseProviderError(raw, {
        provider,
        transport,
        _quotaModule: quotaModuleSilencioso(),
    });
}

const MATRIZ_AUTH = [
    {
        provider: 'anthropic',
        positives: [
            {
                nombre: 'authentication_error en frame result del stream-json',
                raw: JSON.stringify({ type: 'result', is_error: true, error: { type: 'authentication_error', message: 'invalid x-api-key' } }),
                esperado: { type: 'authentication_error', code: null },
            },
        ],
        // `invalid_api_key` es de OpenAI; Anthropic no lo documenta.
        foreign: JSON.stringify({ error: { code: 'invalid_api_key' } }),
        negatives: [
            ['permission_error 403 (clave valida, sin permiso)', JSON.stringify({ error: { type: 'permission_error', status: 403 } })],
            ['billing_error', JSON.stringify({ error: { type: 'billing_error' } })],
            ['overloaded_error', JSON.stringify({ error: { type: 'overloaded_error' } })],
        ],
    },
    {
        provider: 'anthropic-claude', // alias de cadena de fallback
        positives: [
            {
                nombre: 'alias anthropic-claude resuelve al adapter de anthropic',
                raw: JSON.stringify({ error: { type: 'authentication_error' } }),
                esperado: { type: 'authentication_error', code: null },
            },
        ],
        foreign: JSON.stringify({ error: { status: 'UNAUTHENTICATED' } }),
        negatives: [
            ['permission_error', JSON.stringify({ error: { type: 'permission_error' } })],
        ],
    },
    {
        provider: 'openai-codex',
        positives: [
            {
                nombre: 'code invalid_api_key con type invalid_request_error (shape real OpenAI)',
                raw: JSON.stringify({ error: { message: 'Incorrect API key provided', type: 'invalid_request_error', code: 'invalid_api_key' }, status: 401 }),
                esperado: { type: null, code: 'invalid_api_key', status: 401 },
            },
            {
                nombre: 'item.completed con item.type error (forma 3 de codex exec)',
                raw: JSON.stringify({ type: 'item.completed', item: { type: 'error', error: { code: 'invalid_api_key' } } }),
                esperado: { type: null, code: 'invalid_api_key' },
            },
        ],
        foreign: JSON.stringify({ error: { type: 'authentication_error' } }),
        negatives: [
            ['insufficient_quota', JSON.stringify({ error: { code: 'insufficient_quota' } })],
            ['account_deactivated', JSON.stringify({ error: { code: 'account_deactivated' } })],
            ['permission_denied', JSON.stringify({ error: { code: 'permission_denied' } })],
        ],
    },
    {
        provider: 'gemini-google',
        positives: [
            {
                nombre: 'status UNAUTHENTICATED con ErrorInfo API_KEY_INVALID',
                raw: JSON.stringify({ error: { code: 401, status: 'UNAUTHENTICATED', details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'API_KEY_INVALID' }] } }),
                esperado: { type: 'unauthenticated', code: null, status: 401 },
            },
        ],
        foreign: JSON.stringify({ error: { code: 'invalid_api_key' } }),
        negatives: [
            ['PERMISSION_DENIED', JSON.stringify({ error: { code: 403, status: 'PERMISSION_DENIED' } })],
            ['RESOURCE_EXHAUSTED (cuota)', JSON.stringify({ error: { code: 429, status: 'RESOURCE_EXHAUSTED' } })],
            ['API_KEY_SERVICE_BLOCKED', JSON.stringify({ error: { code: 403, status: 'PERMISSION_DENIED', details: [{ reason: 'API_KEY_SERVICE_BLOCKED' }] } })],
        ],
    },
    {
        provider: 'cerebras',
        positives: [
            {
                nombre: 'invalid_api_key en shape OpenAI-compatible',
                raw: JSON.stringify({ error: { type: 'invalid_request_error', code: 'invalid_api_key' } }),
                esperado: { type: null, code: 'invalid_api_key' },
            },
            {
                nombre: 'wrong_api_key del gateway de Cerebras',
                raw: JSON.stringify({ error: { code: 'wrong_api_key' } }),
                esperado: { type: null, code: 'wrong_api_key' },
            },
        ],
        foreign: JSON.stringify({ error: { status: 'UNAUTHENTICATED' } }),
        negatives: [
            ['rate_limit_exceeded', JSON.stringify({ error: { code: 'rate_limit_exceeded' } })],
            ['quota_exceeded', JSON.stringify({ error: { code: 'quota_exceeded' } })],
        ],
    },
    {
        provider: 'nvidia-nim',
        positives: [
            {
                nombre: 'authentication_error en shape OpenAI-compatible',
                raw: JSON.stringify({ error: { type: 'authentication_error' } }),
                esperado: { type: 'authentication_error', code: null },
            },
        ],
        foreign: JSON.stringify({ error: { status: 'UNAUTHENTICATED' } }),
        negatives: [
            // RFC-7807 del gateway: el unico indicio es `title`, que es PROSA.
            ['RFC-7807 title Unauthorized (prosa, no clasifica)', JSON.stringify({ status: 401, title: 'Unauthorized', detail: 'no api key' })],
            ['insufficient_quota', JSON.stringify({ error: { code: 'insufficient_quota' } })],
        ],
    },
    {
        provider: 'kimi-moonshot',
        positives: [
            {
                nombre: 'invalid_authentication_error documentado por Moonshot',
                raw: JSON.stringify({ error: { type: 'invalid_authentication_error', message: 'Invalid Authentication' } }),
                esperado: { type: 'invalid_authentication_error', code: null },
            },
        ],
        foreign: JSON.stringify({ error: { status: 'UNAUTHENTICATED' } }),
        negatives: [
            ['exceeded_current_quota_error', JSON.stringify({ error: { type: 'exceeded_current_quota_error' } })],
            ['permission_denied_error', JSON.stringify({ error: { type: 'permission_denied_error' } })],
        ],
    },
];

// Negativos que se corren contra TODOS los adapters (CA-2 del issue).
const NEGATIVOS_UNIVERSALES = [
    ['401 pelado sin token documentado', JSON.stringify({ error: { status: 401, message: 'Unauthorized' } })],
    ['403 generico sin token documentado', JSON.stringify({ error: { status: 403, message: 'Forbidden' } })],
    ['5xx', JSON.stringify({ error: { status: 503, type: 'service_unavailable' } })],
    ['429 rate limit', JSON.stringify({ error: { status: 429, type: 'rate_limit_error' } })],
    ['credencial ausente (config)', JSON.stringify({ error: { code: 'no_api_key_configured' } })],
    ['texto libre que menciona Unauthorized', 'Error: Unauthorized 401 auth failed invalid api key'],
    ['JSON malformado', '{"error":{"type":"authentication_error"'],
    ['SSE malformado', 'data: {"error":{"type":"authentication_error"'],
    ['frame vacio', '{}'],
    ['array top-level', '[{"error":{"type":"authentication_error"}}]'],
    ['null literal', 'null'],
];

for (const fila of MATRIZ_AUTH) {
    for (const pos of fila.positives) {
        test(`#5795 [${fila.provider}] POSITIVO — ${pos.nombre}`, () => {
            const r = parseAuth(pos.raw, fila.provider);
            assert.equal(r.errorClass, AUTH_CLASS);
            assert.equal(r.retriable, false, 'un rechazo de credencial no es retriable');
            assert.equal(r.shouldFallback, false, 'esta capa no decide fallback');
            assert.ok(r.authRejection, 'tiene que venir la senal tipada');
            assert.equal(r.authRejection.kind, AUTH_CLASS);
            const s = r.authRejection.signal;
            if (pos.esperado.type !== undefined) assert.equal(s.type, pos.esperado.type);
            if (pos.esperado.code !== undefined) assert.equal(s.code, pos.esperado.code);
            if (pos.esperado.status !== undefined) assert.equal(s.status, pos.esperado.status);
            assert.ok(Object.isFrozen(r.authRejection), 'el rechazo viaja congelado');
            assert.ok(Object.isFrozen(s), 'la senal viaja congelada');
        });
    }

    test(`#5795 [${fila.provider}] AISLAMIENTO — una senal valida para otro provider no clasifica`, () => {
        const r = parseAuth(fila.foreign, fila.provider);
        assert.notEqual(r.errorClass, AUTH_CLASS);
        assert.equal(r.authRejection, undefined);
    });

    for (const [nombre, raw] of fila.negatives) {
        test(`#5795 [${fila.provider}] NEGATIVO — ${nombre}`, () => {
            const r = parseAuth(raw, fila.provider);
            assert.notEqual(r.errorClass, AUTH_CLASS);
        });
    }

    for (const [nombre, raw] of NEGATIVOS_UNIVERSALES) {
        test(`#5795 [${fila.provider}] NEGATIVO UNIVERSAL — ${nombre}`, () => {
            const r = parseAuth(raw, fila.provider);
            assert.notEqual(r.errorClass, AUTH_CLASS);
        });
    }
}

test('#5795 [deterministic] el adapter determinista NUNCA clasifica autenticacion', () => {
    const det = require('../providers/deterministic');
    assert.equal(typeof det.detectAuthenticationRejected, 'function');
    // Ni siquiera con el frame mas inequivoco de todos.
    assert.equal(
        det.detectAuthenticationRejected(
            { error: { type: 'authentication_error', code: 'invalid_api_key' } },
            { provider: 'deterministic', transport: 'cli' },
        ),
        null,
    );
});

test('#5795 los siete adapters implementan el contrato detectAuthenticationRejected', () => {
    const { PROVIDER_HANDLERS } = require('../resolve-provider');
    const esperados = ['anthropic', 'openai-codex', 'gemini-google', 'cerebras', 'nvidia-nim', 'kimi-moonshot', 'deterministic'];
    for (const nombre of esperados) {
        assert.ok(PROVIDER_HANDLERS[nombre], `falta el adapter ${nombre}`);
        assert.equal(
            typeof PROVIDER_HANDLERS[nombre].detectAuthenticationRejected,
            'function',
            `${nombre} no expone detectAuthenticationRejected`,
        );
    }
});

test('#5795 timeout y exitCode sin frame estructurado no producen authentication_rejected', () => {
    const porTimeout = parseProviderError('', {
        provider: 'anthropic', transport: 'cli', timedOut: true, durationMs: 600000,
        _quotaModule: quotaModuleSilencioso(),
    });
    assert.equal(porTimeout.errorClass, 'transient_5xx');

    const porExit = parseProviderError('crash sin shape', {
        provider: 'anthropic', transport: 'cli', exitCode: 1, durationMs: 1000,
        _quotaModule: quotaModuleSilencioso(),
    });
    assert.notEqual(porExit.errorClass, AUTH_CLASS);
});

test('#5795 sin ctx.provider el parser falla cerrado y no clasifica autenticacion', () => {
    const r = parseProviderError(JSON.stringify({ error: { type: 'authentication_error' } }), {
        transport: 'cli',
        _quotaModule: quotaModuleSilencioso(),
    });
    assert.equal(r.errorClass, 'unknown');
});

test('#5795 la clase auth por texto libre sigue funcionando y NO se convierte en la nueva clase', () => {
    const r = parseAuth('fatal: Unauthorized (401) — auth failed', 'anthropic');
    assert.equal(r.errorClass, 'auth', 'la clase legacy queda intacta');
    assert.equal(r.shouldFallback, true, 'auth legacy conserva su politica de fallback');
});

// -----------------------------------------------------------------------------
// #5795 — Canario: ningun secreto viaja en el retorno del parser.
// -----------------------------------------------------------------------------

test('#5795 CANARIO — secretos en message/token/headers/payload no aparecen en el retorno', () => {
    const CANARIO = 'sk-ant-api03-CANARIOSECRETO999';
    const frame = JSON.stringify({
        type: 'result',
        is_error: true,
        error: {
            type: 'authentication_error',
            message: `invalid x-api-key: ${CANARIO}`,
            headers: { authorization: `Bearer ${CANARIO}` },
            payload: { api_key: CANARIO },
        },
        stderr: `export ANTHROPIC_API_KEY=${CANARIO}`,
    });
    const r = parseAuth(frame, 'anthropic');
    assert.equal(r.errorClass, AUTH_CLASS);
    const serializado = JSON.stringify(r);
    assert.ok(!serializado.includes(CANARIO), 'el canario NO puede aparecer en el retorno');
    assert.ok(!serializado.includes('CANARIOSECRETO'), 'ni siquiera un fragmento del canario');
    assert.equal(r.raw, '', 'esta clase no transporta extracto del payload');
});

test('#5795 makeSignal rechaza valores fuera de las cotas (fail-closed)', () => {
    const { makeSignal } = authRejectionModule;
    assert.equal(makeSignal({ source: 'inventado', type: 'authentication_error' }), null, 'source fuera de la tabla');
    assert.equal(makeSignal({ source: 'api-json' }), null, 'sin ninguna evidencia estructural');
    assert.equal(makeSignal({ source: 'api-json', type: 'x'.repeat(65) }), null, 'token que excede la cota');
    assert.equal(makeSignal({ source: 'api-json', type: 'con espacios' }), null, 'token fuera del charset');
    assert.equal(makeSignal({ source: 'api-json', status: 99 }), null, 'status HTTP fuera de rango');
    const ok = makeSignal({ source: 'api-json', type: 'authentication_error', status: 401 });
    assert.ok(Object.isFrozen(ok));
});
