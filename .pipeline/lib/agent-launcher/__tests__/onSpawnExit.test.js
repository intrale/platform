// =============================================================================
// agent-launcher/__tests__/onSpawnExit.test.js — Tests del hook centralizado
// (#3576 CA-2 + CA-8 + refinación R1 PO: test adversarial parser-que-tira).
//
// Cobertura:
//   1. Contrato del retorno (errorClass, flagSet, auditLogged, decision).
//   2. setFlag SOLO para quota_exhausted/rate_limit con allowlist (SR-7).
//   3. NO setFlag para transient_5xx / permanent_failure / unknown.
//   4. Audit log unificado con hash-chain (CA-8).
//   5. Sanitización del evidence/raw (NEW-1).
//   6. Sin escritura a .pipeline/handoff/ (CA-8 DoD).
//   7. **Test adversarial R1**: parser que tira → hook devuelve veredicto
//      neutro, NO rompe child.on('exit') lifecycle.
//   8. Feature flag PIPELINE_GENERALIZED_PARSER_ENABLED (CA-9).
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('os');
const path = require('node:path');

const dispatcher = require('../dispatch-with-fallback');
const auditLog = require('../../audit-log');

function makeTmpPipeline() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'onSpawnExit-'));
}

function fakeQuotaModule(opts = {}) {
    const setCalls = [];
    return {
        sanitizeRawExcerpt: (s) => String(s == null ? '' : s).slice(0, 200).replace(/[\r\n]/g, ' '),
        KNOWN_QUOTA_ERROR_TYPES_BY_PROVIDER: opts.allowlist || {
            anthropic: ['usage_limit_error', 'weekly_quota_exhausted'],
            'openai-codex': ['insufficient_quota', 'billing_hard_limit_reached'],
        },
        _detectAnthropic: (evt, allowlist) => {
            if (evt && evt.type === 'result' && evt.is_error && allowlist.includes(evt.error_type)) {
                return { matched: true, errorType: evt.error_type };
            }
            return { matched: false };
        },
        _detectOpenAI: (evt, allowlist) => {
            if (evt && evt.event === 'error' && evt.data && evt.data.error &&
                allowlist.includes(evt.data.error.type)) {
                return { matched: true, errorType: evt.data.error.type };
            }
            return { matched: false };
        },
        setFlag: (input) => { setCalls.push(input); return { flagPath: '/tmp/x', payload: {}, source: 'input' }; },
        _setCalls: setCalls,
    };
}

// -----------------------------------------------------------------------------
// #4052 — Clasificación de spawn-failure del provider (CA-1/CA-3).
// -----------------------------------------------------------------------------

test('#4052 clasifica exit 127 de codex como provider-spawn-failure (no setFlag)', () => {
    const tmp = makeTmpPipeline();
    const quota = fakeQuotaModule();
    const result = dispatcher.onSpawnExit({
        skill: 'pipeline-dev',
        issue: 4052,
        provider: 'openai-codex',
        transport: 'cli',
        rawOutput: '',
        exitCode: 127,
        durationMs: 40,
        firstByteAt: null,
        pipelineDir: tmp,
        quotaModule: quota,
    });
    assert.equal(result.errorClass, 'provider_spawn_failure');
    assert.equal(result.decision, 'provider-spawn-failure');
    assert.equal(result.shouldFallback, true);
    assert.equal(result.retriable, false);
    assert.equal(result.flagSet, false, 'spawn-failure NO es cuota: no debe setFlag');
    assert.equal(quota._setCalls.length, 0);
    assert.match(result.signature, /exit_code:127/);
});

test('#4052 clasifica child.on error (ENOENT) de codex como provider-spawn-failure', () => {
    const tmp = makeTmpPipeline();
    const quota = fakeQuotaModule();
    const result = dispatcher.onSpawnExit({
        skill: 'pipeline-dev',
        issue: 4052,
        provider: 'openai-codex',
        transport: 'cli',
        rawOutput: '',
        exitCode: null,
        errorCode: 'ENOENT',
        durationMs: 5,
        firstByteAt: null,
        pipelineDir: tmp,
        quotaModule: quota,
    });
    assert.equal(result.decision, 'provider-spawn-failure');
    assert.equal(result.flagSet, false);
});

test('#4052 SEC-1: el stderr del spawn-failure se saniza y el JSONL se crea 0o600', () => {
    const tmp = makeTmpPipeline();
    const quota = fakeQuotaModule();
    // Usamos el sanitizer real para validar la redacción de un secret realista.
    delete quota.sanitizeRawExcerpt;
    const realQuota = require('../../quota-exhausted');
    const result = dispatcher.onSpawnExit({
        skill: 'pipeline-dev', issue: 4052, provider: 'openai-codex', transport: 'cli',
        rawOutput: 'codex boom AKIA' + 'B'.repeat(16) + ' sk-' + 'a'.repeat(48) + ' fin',
        exitCode: 127, durationMs: 30, firstByteAt: null, spawnInstrumented: true,
        pipelineDir: tmp, quotaModule: realQuota,
    });
    assert.equal(result.decision, 'provider-spawn-failure');
    const dir = path.join(tmp, 'logs');
    const f = fs.readdirSync(dir).find((x) => x.startsWith('spawn-exit-'));
    const full = path.join(dir, f);
    const content = fs.readFileSync(full, 'utf8');
    assert.ok(!/AKIAB{16}/.test(content), 'AKIA key debe estar redactada');
    assert.ok(!/sk-a{48}/.test(content), 'sk- key debe estar redactada');
    if (process.platform !== 'win32') {
        assert.equal(fs.statSync(full).mode & 0o777, 0o600);
    }
});

test('#4052 muerte ambigua (output presente) NO es provider-spawn-failure', () => {
    const tmp = makeTmpPipeline();
    const quota = fakeQuotaModule();
    const result = dispatcher.onSpawnExit({
        skill: 'pipeline-dev',
        issue: 4052,
        provider: 'openai-codex',
        transport: 'cli',
        rawOutput: 'algun stderr legitimo del agente',
        exitCode: 1,
        durationMs: 120,
        firstByteAt: Date.now(),
        pipelineDir: tmp,
        quotaModule: quota,
    });
    assert.notEqual(result.decision, 'provider-spawn-failure');
});

// -----------------------------------------------------------------------------
// 1. Contrato básico
// -----------------------------------------------------------------------------

test('CA-2 onSpawnExit con quota_exhausted invoca setFlag y devuelve flag_set', () => {
    const tmp = makeTmpPipeline();
    const quota = fakeQuotaModule();
    const result = dispatcher.onSpawnExit({
        skill: 'guru',
        issue: 3576,
        provider: 'anthropic',
        transport: 'cli',
        rawOutput: '{"type":"result","is_error":true,"error_type":"usage_limit_error"}',
        exitCode: 1,
        timedOut: false,
        durationMs: 8000,
        pipelineDir: tmp,
        quotaModule: quota,
    });
    assert.equal(result.errorClass, 'quota_exhausted');
    assert.equal(result.flagSet, true);
    assert.equal(result.decision, 'flag_set');
    assert.equal(result.codepath, 'generalized');
    assert.equal(quota._setCalls.length, 1);
    assert.equal(quota._setCalls[0].provider, 'anthropic');
    assert.equal(quota._setCalls[0].errorType, 'usage_limit_error');
    assert.equal(quota._setCalls[0].agent, 'guru');
});

test('CA-2 onSpawnExit con transient_5xx NO invoca setFlag pero devuelve decision=fallback', () => {
    const tmp = makeTmpPipeline();
    const quota = fakeQuotaModule();
    const result = dispatcher.onSpawnExit({
        skill: 'builder',
        provider: 'anthropic',
        transport: 'cli',
        rawOutput: '',
        timedOut: true,
        exitCode: null,
        durationMs: 600156,
        pipelineDir: tmp,
        quotaModule: quota,
    });
    assert.equal(result.errorClass, 'transient_5xx');
    assert.equal(result.flagSet, false);
    assert.equal(result.decision, 'fallback');
    assert.equal(quota._setCalls.length, 0, 'transient_5xx NO debe llamar setFlag');
});

test('CA-2 onSpawnExit con unknown devuelve decision=ignore sin setFlag', () => {
    const tmp = makeTmpPipeline();
    const quota = fakeQuotaModule();
    const result = dispatcher.onSpawnExit({
        skill: 'planner',
        provider: 'anthropic',
        transport: 'cli',
        rawOutput: '',
        exitCode: 0,
        timedOut: false,
        durationMs: 1000,
        pipelineDir: tmp,
        quotaModule: quota,
    });
    assert.equal(result.errorClass, 'unknown');
    assert.equal(result.decision, 'ignore');
    assert.equal(quota._setCalls.length, 0);
});

// -----------------------------------------------------------------------------
// 2. SR-7 — errorType respetando KNOWN_QUOTA_ERROR_TYPES_BY_PROVIDER
// -----------------------------------------------------------------------------

test('CA-2 onSpawnExit extrae errorType del evidence cuando es JSON', () => {
    const tmp = makeTmpPipeline();
    const quota = fakeQuotaModule({
        allowlist: { 'openai-codex': ['insufficient_quota', 'billing_hard_limit_reached'] },
    });
    const raw = 'data: {"event":"error","data":{"error":{"type":"billing_hard_limit_reached"}}}';
    const result = dispatcher.onSpawnExit({
        skill: 'qa',
        provider: 'openai-codex',
        transport: 'cli',
        rawOutput: raw,
        exitCode: 1,
        timedOut: false,
        durationMs: 4000,
        pipelineDir: tmp,
        quotaModule: quota,
    });
    assert.equal(result.errorClass, 'quota_exhausted');
    assert.equal(result.flagSet, true);
    assert.equal(quota._setCalls[0].errorType, 'billing_hard_limit_reached',
        'debe usar el errorType extraído, no el primer default');
});

// -----------------------------------------------------------------------------
// #4541 — Misatribución de provider (Codex → Anthropic) + falso positivo sobre
// contenido. Estos tests usan el módulo REAL de quota (con el `_detectOpenAI`
// completo y el regex de canal de control de Codex) y espían `setFlag` para
// verificar el provider EFECTIVO al que se atribuye el flag.
// -----------------------------------------------------------------------------

// Módulo real con setFlag espiado (preserva _detectAnthropic/_detectOpenAI/
// KNOWN_QUOTA_ERROR_TYPES_BY_PROVIDER/sanitizeRawExcerpt reales vía prototype).
function realQuotaWithSpy() {
    const realQuota = require('../../quota-exhausted');
    const setCalls = [];
    const spy = Object.create(realQuota);
    spy.setFlag = (input) => { setCalls.push(input); return { flagPath: '/tmp/x', payload: {}, source: 'input' }; };
    spy._setCalls = setCalls;
    return spy;
}

// Frame REAL de error del CLI Codex (canal de control) del incidente 2026-07-07.
const INCIDENT_CODEX_ERROR_FRAME =
    '{"type":"error","message":"You\'ve hit your usage limit. Upgrade to Pro ' +
    '(https://chatgpt.com/explore/pro), visit https://chatgpt.com/codex/settings/usage ' +
    'to purchase more credits or try again at Jul 7th, 2026 11:19 AM."}';

const INCIDENT_TOOL_RESULT_CONTENT =
    '{"type":"user","message":{"role":"user","content":[{"tool_use_id":"toolu_01TQ9E5H6kQaGL9GT7LKwPJE",' +
    '"type":"tool_result","content":"Analicé el log del detector y encontré este mensaje de Codex: ' +
    'You\'ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/codex/settings/usage)."}]}}';

test('#4541 CA-1/CA-3: error real de Codex con provider efectivo=openai-codex flaguea a openai-codex', () => {
    const tmp = makeTmpPipeline();
    const quota = realQuotaWithSpy();
    const result = dispatcher.onSpawnExit({
        skill: 'qa',
        issue: 4541,
        // El pulpo pasa el provider EFECTIVO que corrió (el fallback codex), no
        // el primary configurado del skill. Este es el fix de atribución (Bug 1).
        provider: 'openai-codex',
        transport: 'cli',
        rawOutput: INCIDENT_CODEX_ERROR_FRAME,
        exitCode: 1,
        timedOut: false,
        durationMs: 4000,
        pipelineDir: tmp,
        quotaModule: quota,
    });
    assert.equal(result.errorClass, 'quota_exhausted');
    assert.equal(result.flagSet, true);
    assert.equal(quota._setCalls.length, 1, 'debe setear exactamente un flag');
    assert.equal(quota._setCalls[0].provider, 'openai-codex',
        'el flag DEBE atribuirse a Codex, nunca a Anthropic');
    // El errorType persistido debe pertenecer a la allowlist de Codex.
    const codexTypes = quota.KNOWN_QUOTA_ERROR_TYPES_BY_PROVIDER['openai-codex'];
    assert.ok(codexTypes.includes(quota._setCalls[0].errorType),
        `errorType "${quota._setCalls[0].errorType}" debe ser de Codex`);
});

test('#4541 CA-1: mismo error de Codex con provider=anthropic NO setea flag de Anthropic', () => {
    const tmp = makeTmpPipeline();
    const quota = realQuotaWithSpy();
    const result = dispatcher.onSpawnExit({
        skill: 'qa',
        issue: 4541,
        provider: 'anthropic',
        transport: 'cli',
        rawOutput: INCIDENT_CODEX_ERROR_FRAME,
        exitCode: 1,
        timedOut: false,
        durationMs: 4000,
        pipelineDir: tmp,
        quotaModule: quota,
    });
    assert.notEqual(result.errorClass, 'quota_exhausted',
        'un error de Codex NO debe clasificar quota bajo la allowlist de Anthropic');
    assert.equal(quota._setCalls.length, 0,
        'NUNCA setear un flag de Anthropic desde un error de Codex');
});

test('#4541 CA-2: tool_result con "usage limit" NO setea flag (falso positivo del incidente)', () => {
    const tmp = makeTmpPipeline();
    const quota = realQuotaWithSpy();
    const result = dispatcher.onSpawnExit({
        skill: 'qa',
        issue: 4541,
        provider: 'anthropic',
        transport: 'cli',
        rawOutput: INCIDENT_TOOL_RESULT_CONTENT,
        exitCode: 0,
        timedOut: false,
        durationMs: 4000,
        pipelineDir: tmp,
        quotaModule: quota,
    });
    assert.notEqual(result.errorClass, 'quota_exhausted');
    assert.equal(quota._setCalls.length, 0,
        'contenido de tool_result no debe disparar setFlag');
});

test('CA-2 _selectErrorTypeForFlag cae al primer elemento de la allowlist si no puede extraer', () => {
    const verdict = { errorClass: 'quota_exhausted', evidence: 'texto libre sin shape' };
    const errorType = dispatcher._selectErrorTypeForFlag('gemini-google', verdict, {
        KNOWN_QUOTA_ERROR_TYPES_BY_PROVIDER: { 'gemini-google': ['quota_exceeded', 'resource_exhausted'] },
    });
    assert.equal(errorType, 'quota_exceeded');
});

test('CA-2 _selectErrorTypeForFlag retorna null si allowlist vacía', () => {
    const verdict = { errorClass: 'quota_exhausted', evidence: '' };
    const errorType = dispatcher._selectErrorTypeForFlag('anthropic', verdict, {
        KNOWN_QUOTA_ERROR_TYPES_BY_PROVIDER: {},
    });
    assert.equal(errorType, null);
});

// -----------------------------------------------------------------------------
// 3. CA-8 — Audit log unificado con hash-chain
// -----------------------------------------------------------------------------

test('CA-8 onSpawnExit emite audit con shape unificado + hash_self/hash_prev', () => {
    const tmp = makeTmpPipeline();
    const quota = fakeQuotaModule();
    dispatcher.onSpawnExit({
        skill: 'guru',
        issue: 3576,
        provider: 'anthropic',
        transport: 'cli',
        rawOutput: '{"type":"result","is_error":true,"error_type":"usage_limit_error"}',
        exitCode: 1,
        timedOut: false,
        durationMs: 8000,
        pipelineDir: tmp,
        quotaModule: quota,
    });
    const auditFile = dispatcher.spawnExitAuditFile(tmp);
    assert.ok(fs.existsSync(auditFile), 'audit file debe existir');
    const lines = fs.readFileSync(auditFile, 'utf8').trim().split('\n');
    assert.equal(lines.length, 1);
    const entry = JSON.parse(lines[0]);
    // Shape unificado del CA-8 — campos requeridos
    assert.equal(entry.skill, 'guru');
    assert.equal(entry.provider, 'anthropic');
    assert.equal(entry.transport, 'cli');
    assert.equal(entry.error_class, 'quota_exhausted');
    assert.ok(entry.evidence.length > 0);
    assert.equal(entry.should_fallback, true);
    assert.equal(entry.flag_set, true);
    assert.equal(entry.codepath, 'generalized');
    // Hash-chain SHA-256
    assert.equal(entry.hash_prev, 'GENESIS');
    assert.ok(entry.hash_self && entry.hash_self.length === 64);
});

test('CA-8 dos onSpawnExit consecutivos producen hash-chain válida', () => {
    const tmp = makeTmpPipeline();
    const quota = fakeQuotaModule();
    dispatcher.onSpawnExit({
        skill: 'guru', provider: 'anthropic', transport: 'cli',
        rawOutput: '{"type":"result","is_error":true,"error_type":"usage_limit_error"}',
        exitCode: 1, timedOut: false, durationMs: 5000,
        pipelineDir: tmp, quotaModule: quota,
    });
    dispatcher.onSpawnExit({
        skill: 'planner', provider: 'anthropic', transport: 'cli',
        rawOutput: 'API Error: Usage credits required',
        exitCode: 1, timedOut: false, durationMs: 4000,
        pipelineDir: tmp, quotaModule: quota,
    });
    const auditFile = dispatcher.spawnExitAuditFile(tmp);
    const verify = auditLog.verifyChain(auditFile);
    assert.equal(verify.ok, true, `chain debe ser válida: ${verify.reason || ''}`);
    assert.equal(verify.entriesChecked, 2);
});

// -----------------------------------------------------------------------------
// 4. Sanitización (NEW-1)
// -----------------------------------------------------------------------------

test('NEW-1 onSpawnExit sanitiza secrets (AKIA/sk-*) antes de loguear/auditarles', () => {
    const tmp = makeTmpPipeline();
    const quota = fakeQuotaModule();
    const tainted = 'API Error: Usage credits required AKIAIOSFODNN7EXAMPLE sk-ant-abc123def456ghi789jkl';
    const result = dispatcher.onSpawnExit({
        skill: 'guru', provider: 'anthropic', transport: 'cli',
        rawOutput: tainted, exitCode: 1, timedOut: false, durationMs: 5000,
        pipelineDir: tmp, quotaModule: quota,
    });
    assert.equal(result.errorClass, 'quota_exhausted');
    const auditFile = dispatcher.spawnExitAuditFile(tmp);
    const entry = JSON.parse(fs.readFileSync(auditFile, 'utf8').trim());
    // El fakeQuota tiene un sanitizer pasivo; en producción quota-exhausted.sanitizeRawExcerpt
    // redacta AKIA/sk-/JWT. Acá validamos al menos que el evidence pasa por
    // sanitize() — la guarantía completa la dan los tests del módulo real.
    assert.equal(typeof entry.evidence, 'string');
    assert.ok(!entry.evidence.includes('\n'));
    assert.ok(!entry.evidence.includes('\r'));
});

// -----------------------------------------------------------------------------
// 5. CA-8 DoD — sin escritura a .pipeline/handoff/
// -----------------------------------------------------------------------------

test('CA-8 DoD onSpawnExit NO escribe a .pipeline/handoff/<issue>.md', () => {
    const tmp = makeTmpPipeline();
    const handoffDir = path.join(tmp, 'handoff');
    fs.mkdirSync(handoffDir, { recursive: true });
    const quota = fakeQuotaModule();
    dispatcher.onSpawnExit({
        skill: 'guru', issue: 3576, provider: 'anthropic', transport: 'cli',
        rawOutput: '{"type":"result","is_error":true,"error_type":"usage_limit_error"}',
        exitCode: 1, timedOut: false, durationMs: 5000,
        pipelineDir: tmp, quotaModule: quota,
    });
    const handoffEntries = fs.readdirSync(handoffDir);
    assert.equal(handoffEntries.length, 0,
        'el hook NUNCA debe tocar .pipeline/handoff/ (canal cross-agente)');
});

// -----------------------------------------------------------------------------
// 6. Refinación R1 PO — Test adversarial: parser-que-tira
// -----------------------------------------------------------------------------

test('R1 adversarial: parser tira → hook devuelve veredicto neutro (NUNCA rompe lifecycle)', () => {
    const tmp = makeTmpPipeline();
    const quota = fakeQuotaModule();
    const explosiveParser = {
        parseProviderError: () => { throw new Error('boom — simulando bug interno del parser'); },
    };
    // Si esto tira, el child.on('exit') del caller se rompe. NO debe tirar.
    let didThrow = false;
    let result = null;
    try {
        result = dispatcher.onSpawnExit({
            skill: 'guru', provider: 'anthropic', transport: 'cli',
            rawOutput: '{"type":"result","is_error":true,"error_type":"usage_limit_error"}',
            exitCode: 1, timedOut: false, durationMs: 5000,
            pipelineDir: tmp,
            parserModule: explosiveParser,
            quotaModule: quota,
        });
    } catch (e) {
        didThrow = true;
    }
    assert.equal(didThrow, false, 'el hook NUNCA debe propagar throws — child.on(exit) rompería');
    assert.ok(result, 'el hook debe devolver SIEMPRE un veredicto (aunque sea neutro)');
    assert.equal(result.errorClass, 'unknown');
    assert.equal(result.flagSet, false);
    assert.equal(result.decision, 'ignore');
    assert.equal(result.codepath, 'generalized');
    assert.equal(quota._setCalls.length, 0, 'parser roto NO debe poder disparar setFlag');
});

test('R1 adversarial: setFlag tira → hook devuelve flagSet=false sin re-throw', () => {
    const tmp = makeTmpPipeline();
    const quota = fakeQuotaModule();
    // Reemplazamos setFlag por uno que tira.
    quota.setFlag = () => { throw new Error('boom — simulando IO error en setFlag'); };
    let result = null;
    let didThrow = false;
    try {
        result = dispatcher.onSpawnExit({
            skill: 'guru', provider: 'anthropic', transport: 'cli',
            rawOutput: '{"type":"result","is_error":true,"error_type":"usage_limit_error"}',
            exitCode: 1, timedOut: false, durationMs: 5000,
            pipelineDir: tmp, quotaModule: quota,
        });
    } catch (e) {
        didThrow = true;
    }
    assert.equal(didThrow, false, 'setFlag roto NO debe propagar throw');
    assert.equal(result.errorClass, 'quota_exhausted');
    assert.equal(result.flagSet, false, 'setFlag tiró → flagSet=false');
});

test('R1 adversarial: audit tira → hook devuelve auditLogged=false sin re-throw', () => {
    const tmp = makeTmpPipeline();
    const quota = fakeQuotaModule();
    const explosiveAudit = {
        appendChained: () => { throw new Error('boom — simulando lock no adquirido'); },
    };
    let result = null;
    let didThrow = false;
    try {
        result = dispatcher.onSpawnExit({
            skill: 'guru', provider: 'anthropic', transport: 'cli',
            rawOutput: '{"type":"result","is_error":true,"error_type":"usage_limit_error"}',
            exitCode: 1, timedOut: false, durationMs: 5000,
            pipelineDir: tmp, quotaModule: quota, auditLog: explosiveAudit,
        });
    } catch (e) {
        didThrow = true;
    }
    assert.equal(didThrow, false, 'audit roto NO debe propagar throw');
    assert.equal(result.auditLogged, false);
});

// -----------------------------------------------------------------------------
// 7. CA-9 — Feature flag
// -----------------------------------------------------------------------------

test('CA-9 isGeneralizedParserEnabled default OFF', () => {
    const enabled = dispatcher.isGeneralizedParserEnabled({});
    assert.equal(enabled, false);
});

test('CA-9 isGeneralizedParserEnabled ON cuando env=1', () => {
    const enabled = dispatcher.isGeneralizedParserEnabled({ PIPELINE_GENERALIZED_PARSER_ENABLED: '1' });
    assert.equal(enabled, true);
});

test('CA-9 isGeneralizedParserEnabled trata cualquier valor != "1" como OFF', () => {
    assert.equal(dispatcher.isGeneralizedParserEnabled({ PIPELINE_GENERALIZED_PARSER_ENABLED: 'true' }), false);
    assert.equal(dispatcher.isGeneralizedParserEnabled({ PIPELINE_GENERALIZED_PARSER_ENABLED: '0' }), false);
    assert.equal(dispatcher.isGeneralizedParserEnabled({ PIPELINE_GENERALIZED_PARSER_ENABLED: '' }), false);
});

// -----------------------------------------------------------------------------
// 8. CA-3 — Emojis discriminadores SOLO en log textual (NO en JSON audit)
// -----------------------------------------------------------------------------

test('CA-3 audit entry NUNCA contiene emojis discriminadores 🛡️/🆕', () => {
    const tmp = makeTmpPipeline();
    const quota = fakeQuotaModule();
    dispatcher.onSpawnExit({
        skill: 'guru', provider: 'anthropic', transport: 'cli',
        rawOutput: '{"type":"result","is_error":true,"error_type":"usage_limit_error"}',
        exitCode: 1, timedOut: false, durationMs: 5000,
        pipelineDir: tmp, quotaModule: quota,
    });
    const auditFile = dispatcher.spawnExitAuditFile(tmp);
    const raw = fs.readFileSync(auditFile, 'utf8');
    assert.ok(!raw.includes('🛡️'), 'audit JSON NUNCA debe contener 🛡️');
    assert.ok(!raw.includes('🆕'), 'audit JSON NUNCA debe contener 🆕');
});

test('CA-3 CODEPATH_EMOJI exporta legacy=🛡️ y generalized=🆕 para log textual', () => {
    assert.equal(dispatcher.CODEPATH_EMOJI.legacy, '🛡️');
    assert.equal(dispatcher.CODEPATH_EMOJI.generalized, '🆕');
});

// =============================================================================
// #5795 — Propagación de `authentication_rejected` por el hook post-spawn.
//
// Lo que se afirma acá es el CONTRATO DE TRANSPORTE, no la política:
//   * la señal tipada llega intacta con el contexto de la operación raíz,
//   * el objeto es nuevo e inmutable,
//   * `flagSet === false` y `setFlag` NUNCA se invoca,
//   * los flags de cuota quedan sin tocar,
//   * esta capa no decide retry ni fallback,
//   * dos rechazos de la misma operación raíz quedan ordenados y visibles,
//   * ningún secreto canario sobrevive al retorno, al audit ni a los logs.
// =============================================================================

const AUTH_CLASS_HOOK = 'authentication_rejected';

// Frame real de Anthropic: credencial rechazada.
const FRAME_AUTH_ANTHROPIC = JSON.stringify({
    type: 'result',
    is_error: true,
    error: { type: 'authentication_error', message: 'invalid x-api-key' },
});

// Frame real de OpenAI/Codex: credencial rechazada (otro provider, otra forma).
const FRAME_AUTH_CODEX = JSON.stringify({
    error: { message: 'Incorrect API key provided', type: 'invalid_request_error', code: 'invalid_api_key' },
});

test('#5795 hook — propaga la senal tipada con el contexto de la operacion raiz', () => {
    const tmp = makeTmpPipeline();
    const quota = fakeQuotaModule();
    const r = dispatcher.onSpawnExit({
        skill: 'guru', provider: 'anthropic', transport: 'cli',
        rawOutput: FRAME_AUTH_ANTHROPIC,
        exitCode: 1, timedOut: false, durationMs: 4000,
        operationId: 'op-5795-raiz', path: 'primary', attempt: 0,
        issue: 5795, pipelineDir: tmp, quotaModule: quota,
    });

    assert.equal(r.errorClass, AUTH_CLASS_HOOK);
    assert.equal(r.decision, 'authentication-rejected');
    const proj = r.authenticationRejection;
    assert.ok(proj, 'la proyeccion tiene que existir');
    assert.equal(proj.kind, AUTH_CLASS_HOOK);
    assert.equal(proj.provider, 'anthropic');
    assert.equal(proj.operationId, 'op-5795-raiz');
    assert.equal(proj.path, 'primary');
    assert.equal(proj.attempt, 0);
    assert.equal(proj.signal.source, 'cli-stream-json');
    assert.equal(proj.signal.type, 'authentication_error');
    assert.equal(proj.signal.code, null);
});

test('#5795 hook — la proyeccion es un objeto nuevo e inmutable (tambien la signal)', () => {
    const tmp = makeTmpPipeline();
    const quota = fakeQuotaModule();
    const r = dispatcher.onSpawnExit({
        skill: 'guru', provider: 'anthropic', transport: 'cli',
        rawOutput: FRAME_AUTH_ANTHROPIC, exitCode: 1,
        operationId: 'op-inmutable', path: 'primary', attempt: 0,
        pipelineDir: tmp, quotaModule: quota,
    });
    const proj = r.authenticationRejection;
    assert.ok(Object.isFrozen(proj), 'la proyeccion viaja congelada');
    assert.ok(Object.isFrozen(proj.signal), 'la signal viaja congelada');

    // Mutar no tiene efecto (sloppy mode: falla en silencio, no tira).
    try { proj.provider = 'hackeado'; } catch { /* strict mode tiraria */ }
    try { proj.signal.type = 'hackeado'; } catch { /* idem */ }
    try { proj.campoNuevo = 'x'; } catch { /* idem */ }
    assert.equal(proj.provider, 'anthropic');
    assert.equal(proj.signal.type, 'authentication_error');
    assert.equal(proj.campoNuevo, undefined);
});

test('#5795 hook — NO llama setFlag y flagSet queda en false', () => {
    const tmp = makeTmpPipeline();
    const quota = fakeQuotaModule();
    const r = dispatcher.onSpawnExit({
        skill: 'guru', provider: 'anthropic', transport: 'cli',
        rawOutput: FRAME_AUTH_ANTHROPIC, exitCode: 1,
        operationId: 'op-sin-flag', path: 'primary', attempt: 0,
        pipelineDir: tmp, quotaModule: quota,
    });
    assert.equal(r.flagSet, false, 'flagSet tiene que ser false');
    assert.equal(quota._setCalls.length, 0, 'setFlag NO puede invocarse para esta clase');
});

test('#5795 hook — no decide retry ni fallback en esta capa', () => {
    const tmp = makeTmpPipeline();
    const quota = fakeQuotaModule();
    const r = dispatcher.onSpawnExit({
        skill: 'guru', provider: 'anthropic', transport: 'cli',
        rawOutput: FRAME_AUTH_ANTHROPIC, exitCode: 1,
        operationId: 'op-sin-politica', path: 'primary', attempt: 0,
        pipelineDir: tmp, quotaModule: quota,
    });
    assert.equal(r.retriable, false, 'reintentar con la misma credencial no corresponde');
    assert.equal(r.shouldFallback, false, 'rotar de provider lo decide el coordinador de #5794');
    assert.notEqual(r.decision, 'fallback');
    assert.notEqual(r.decision, 'flag_set');
});

test('#5795 hook — un rechazo de credencial no toca los flags de cuota', () => {
    const tmp = makeTmpPipeline();
    const quota = fakeQuotaModule();
    // Primero un caso de cuota real: deja el flag seteado.
    dispatcher.onSpawnExit({
        skill: 'guru', provider: 'anthropic', transport: 'cli',
        rawOutput: '{"type":"result","is_error":true,"error_type":"usage_limit_error"}',
        exitCode: 1, pipelineDir: tmp, quotaModule: quota,
    });
    const cuotaAntes = quota._setCalls.length;
    assert.equal(cuotaAntes, 1, 'el caso de cuota si tiene que setear flag');

    // Ahora el rechazo de credencial: no puede agregar ni alterar nada.
    dispatcher.onSpawnExit({
        skill: 'guru', provider: 'anthropic', transport: 'cli',
        rawOutput: FRAME_AUTH_ANTHROPIC, exitCode: 1,
        operationId: 'op-cuota-intacta', path: 'primary', attempt: 0,
        pipelineDir: tmp, quotaModule: quota,
    });
    assert.equal(quota._setCalls.length, cuotaAntes, 'los flags de cuota quedan intactos');
});

test('#5795 hook — dos rechazos de la misma operacion raiz quedan ordenados y distinguibles', () => {
    const tmp = makeTmpPipeline();
    const quota = fakeQuotaModule();

    const primero = dispatcher.onSpawnExit({
        skill: 'guru', provider: 'anthropic', transport: 'cli',
        rawOutput: FRAME_AUTH_ANTHROPIC, exitCode: 1,
        operationId: 'op-raiz-compartida', path: 'primary', attempt: 0,
        issue: 5795, pipelineDir: tmp, quotaModule: quota,
    });
    const segundo = dispatcher.onSpawnExit({
        skill: 'guru', provider: 'openai-codex', transport: 'cli',
        rawOutput: FRAME_AUTH_CODEX, exitCode: 1,
        operationId: 'op-raiz-compartida', path: 'fallback/1', attempt: 1,
        issue: 5795, pipelineDir: tmp, quotaModule: quota,
    });

    // Misma operacion raiz preservada en los dos.
    assert.equal(primero.authenticationRejection.operationId, 'op-raiz-compartida');
    assert.equal(segundo.authenticationRejection.operationId, 'op-raiz-compartida');
    // Pero cada uno conserva su provider emisor, su camino y su intento: el
    // segundo rechazo NO queda oculto ni pisado por el primero.
    assert.equal(primero.authenticationRejection.provider, 'anthropic');
    assert.equal(segundo.authenticationRejection.provider, 'openai-codex');
    assert.equal(primero.authenticationRejection.path, 'primary');
    assert.equal(segundo.authenticationRejection.path, 'fallback/1');
    assert.equal(primero.authenticationRejection.attempt, 0);
    assert.equal(segundo.authenticationRejection.attempt, 1);
    assert.notEqual(primero.authenticationRejection, segundo.authenticationRejection);

    // El audit tiene las DOS lineas, en orden.
    const auditFile = dispatcher.spawnExitAuditFile(tmp);
    const lineas = fs.readFileSync(auditFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const rechazos = lineas.filter((l) => l.error_class === AUTH_CLASS_HOOK);
    assert.equal(rechazos.length, 2, 'los dos rechazos tienen que estar auditados');
    assert.equal(rechazos[0].auth_rejection.provider, 'anthropic');
    assert.equal(rechazos[1].auth_rejection.provider, 'openai-codex');
    assert.equal(rechazos[0].auth_rejection.operation_id, 'op-raiz-compartida');
    assert.equal(rechazos[1].auth_rejection.operation_id, 'op-raiz-compartida');
    assert.equal(rechazos[0].auth_rejection.attempt, 0);
    assert.equal(rechazos[1].auth_rejection.attempt, 1);
    assert.equal(rechazos[0].flag_set, false);
    assert.equal(rechazos[1].flag_set, false);
});

test('#5795 hook — el contexto de operacion mal formado se descarta, no viaja crudo', () => {
    const tmp = makeTmpPipeline();
    const quota = fakeQuotaModule();
    const r = dispatcher.onSpawnExit({
        skill: 'guru', provider: 'anthropic', transport: 'cli',
        rawOutput: FRAME_AUTH_ANTHROPIC, exitCode: 1,
        // Basura deliberada: objeto, string gigante y attempt fuera de rango.
        operationId: { inyectado: true },
        path: 'x'.repeat(500),
        attempt: -7,
        pipelineDir: tmp, quotaModule: quota,
    });
    const proj = r.authenticationRejection;
    assert.equal(proj.operationId, null, 'un objeto no puede viajar como operationId');
    assert.equal(proj.path, null, 'un path fuera de cota se descarta entero');
    assert.equal(proj.attempt, null, 'un attempt invalido se descarta');
    // Pero la senal en si sobrevive: el contexto malo no invalida el rechazo.
    assert.equal(proj.signal.type, 'authentication_error');
});

test('#5795 hook — CANARIO: ningun secreto sobrevive al retorno, al audit ni a los logs', () => {
    const tmp = makeTmpPipeline();
    const quota = fakeQuotaModule();
    const CANARIO = 'sk-live-CANARIOHOOK5795XYZ';
    const logs = [];

    const frameConSecretos = JSON.stringify({
        type: 'result',
        is_error: true,
        error: {
            type: 'authentication_error',
            message: `invalid api key ${CANARIO}`,
            token: CANARIO,
            headers: { authorization: `Bearer ${CANARIO}` },
            payload: { secret: CANARIO },
        },
        stderr: `ANTHROPIC_API_KEY=${CANARIO}`,
    });

    const r = dispatcher.onSpawnExit({
        skill: 'guru', provider: 'anthropic', transport: 'cli',
        rawOutput: frameConSecretos, exitCode: 1,
        operationId: 'op-canario', path: 'primary', attempt: 0,
        issue: 5795, pipelineDir: tmp, quotaModule: quota,
        onLog: (canal, msg) => logs.push(`${canal} ${msg}`),
    });

    assert.equal(r.errorClass, AUTH_CLASS_HOOK);

    const retorno = JSON.stringify(r);
    assert.ok(!retorno.includes(CANARIO), 'el canario NO puede estar en el retorno');
    assert.ok(!retorno.includes('CANARIOHOOK'), 'ni un fragmento del canario');
    assert.equal(r.raw, '', 'esta clase no transporta extracto del payload');

    const auditRaw = fs.readFileSync(dispatcher.spawnExitAuditFile(tmp), 'utf8');
    assert.ok(!auditRaw.includes(CANARIO), 'el canario NO puede estar en el audit JSONL');
    assert.ok(!auditRaw.includes('CANARIOHOOK'), 'ni un fragmento en el audit');

    assert.ok(!logs.join('\n').includes('CANARIOHOOK'), 'el canario NO puede estar en los logs');
});

test('#5795 hook — clases distintas de auth no traen proyeccion (campo null)', () => {
    const tmp = makeTmpPipeline();
    const quota = fakeQuotaModule();
    const cuota = dispatcher.onSpawnExit({
        skill: 'guru', provider: 'anthropic', transport: 'cli',
        rawOutput: '{"type":"result","is_error":true,"error_type":"usage_limit_error"}',
        exitCode: 1, pipelineDir: tmp, quotaModule: quota,
    });
    assert.equal(cuota.errorClass, 'quota_exhausted');
    assert.equal(cuota.authenticationRejection, null);

    const libre = dispatcher.onSpawnExit({
        skill: 'guru', provider: 'anthropic', transport: 'cli',
        rawOutput: 'Unauthorized 401 auth failed', exitCode: 1,
        pipelineDir: tmp, quotaModule: quota,
    });
    assert.equal(libre.errorClass, 'auth', 'la clase legacy por texto libre sigue viva');
    assert.equal(libre.authenticationRejection, null, 'auth legacy no produce proyeccion tipada');
});
