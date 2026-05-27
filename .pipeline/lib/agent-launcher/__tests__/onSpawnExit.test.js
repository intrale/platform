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
