// =============================================================================
// commander-inflight-fallback.test.js — Tests del fallback in-flight del
// Commander de Telegram (#3275).
//
// Cubre:
//   CA-1 — Detección de fallo in-flight (5xx, timeout, EOF prematuro).
//   CA-2 — Cap de 1 fallback in-flight (2 intentos totales) + canned exhausted.
//   CA-3 — Descarte total del partial output (hash en audit, no contenido).
//   CA-4 — Late-response lock por chat_id+request_id.
//   CA-5 — Notificación verbose UX-G1 (voseo argentino, sin stack).
//   CA-7 — Budget global 90s SR-5.
//   CA-8 — Audit log file-lock cross-process (mutex).
//   CA-9 — Pre-validación de credenciales + degradación del ranking.
//   CA-11 — Cobertura ≥80% del nuevo código (este archivo).
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const inflight = require('../commander/inflight-fallback');
const credPrecheck = require('../commander/credentials-precheck');
const auditLog = require('../audit-log');

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function mkTmpPipelineDir() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inflight-test-'));
    const models = {
        default_provider: 'anthropic',
        providers: {
            anthropic: {
                launcher: 'claude',
                model: 'claude-opus-4-7',
                supports_tool_use: true,
                credentials_env: ['ANTHROPIC_API_KEY'],
            },
            'openai-codex': {
                launcher: 'codex',
                model: 'gpt-5-codex',
                supports_tool_use: true,
                credentials_env: ['OPENAI_API_KEY'],
            },
            cerebras: {
                launcher: 'cerebras',
                model: 'llama-3.3-70b',
                supports_tool_use: false,
                credentials_env: ['CEREBRAS_API_KEY'],
            },
        },
        skills: {
            'telegram-commander': {
                provider: 'anthropic',
                model_override: 'claude-opus-4-7',
                fallbacks: [
                    { provider: 'openai-codex' },
                    { provider: 'cerebras' },
                ],
            },
        },
    };
    fs.writeFileSync(path.join(dir, 'agent-models.json'), JSON.stringify(models, null, 2));
    fs.mkdirSync(path.join(dir, 'logs'), { recursive: true });
    return dir;
}

function cleanup(dir) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

function readAuditLines(pipelineDir, now) {
    const d = now ? new Date(now) : new Date();
    const yyyy = d.getUTCFullYear();
    const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(d.getUTCDate()).padStart(2, '0');
    const file = path.join(pipelineDir, 'logs', `commander-dispatch-${yyyy}-${mm}-${dd}.jsonl`);
    if (!fs.existsSync(file)) return [];
    return fs.readFileSync(file, 'utf8')
        .split('\n')
        .filter(l => l.trim().length > 0)
        .map(l => JSON.parse(l));
}

// Resolución fake: devuelve openai-codex como secundario y cerebras como
// terciario. Honra el `excludedProvider` que pasa el decisor in-flight.
function makeFakeMultiProvider(gatedSet) {
    const gated = new Set(gatedSet || []);
    return {
        resolveCommanderProviderExcluding(excluded, opts) {
            const chain = ['anthropic', 'openai-codex', 'cerebras'];
            const candidates = chain.filter(p => p !== excluded && !gated.has(p));
            if (candidates.length === 0) {
                return { gated: true, provider: null, chainTried: chain };
            }
            const pick = candidates[0];
            return {
                gated: false,
                provider: pick,
                model: pick === 'cerebras' ? 'llama-3.3-70b' : pick === 'openai-codex' ? 'gpt-5-codex' : 'claude-opus-4-7',
                handler: { providerDef: { supports_tool_use: pick !== 'cerebras' } },
                chainTried: [excluded, pick],
            };
        },
    };
}

// Stub para que decideInflightFallback() use nuestro fake en lugar del
// require('./multi-provider') real. Lo inyectamos vía `dispatchModule` (no
// es directo — el módulo busca multi-provider internamente). Para evitar
// monkey-patching del require cache, exportamos un wrapper de tests.
function decideWithFakeMP(opts, fakeMP) {
    // Monkey-patch temporal del cache de require — feo pero efectivo en tests.
    const mpPath = require.resolve('../commander/multi-provider');
    const original = require.cache[mpPath];
    const fakeExports = { ...((original && original.exports) || {}), ...fakeMP };
    require.cache[mpPath] = { exports: fakeExports };
    try {
        return inflight.decideInflightFallback(opts);
    } finally {
        if (original) require.cache[mpPath] = original;
        else delete require.cache[mpPath];
    }
}

// -----------------------------------------------------------------------------
// CA-2 — Cap de 1 fallback in-flight
// -----------------------------------------------------------------------------

test('CA-2 — attemptIndex >= 1 fuerza exhausted (cap=1)', () => {
    const dir = mkTmpPipelineDir();
    try {
        const d = inflight.decideInflightFallback({
            primaryProvider: 'openai-codex',
            primaryErrorClass: '5xx',
            primaryDurationMs: 10_000,
            primaryPartialOutput: 'algunos tokens',
            attemptIndex: 1, // ya hubo 1 fallback in-flight previo
            pipelineDir: dir,
            chatId: 'chat-123',
            requestId: 'req-cap-1',
        });
        assert.equal(d.shouldRetry, false);
        assert.equal(d.reason, 'cap_exhausted');
        assert.ok(d.cannedResponse.includes('❌'));
        const audit = readAuditLines(dir);
        assert.ok(audit.some(e => e.event === 'inflight_fallback_exhausted'));
        const ev = audit.find(e => e.event === 'inflight_fallback_exhausted');
        assert.equal(ev.cap, 1);
        // CA-3: hash del partial, no contenido literal
        assert.ok(ev.partial_output_hash);
        assert.ok(!JSON.stringify(ev).includes('algunos tokens'));
    } finally { cleanup(dir); }
});

test('CA-2 — canned response varía por requestId pero respeta voseo argentino', () => {
    const a = inflight.cannedInflightExhaustedResponse({ requestId: 'req-a' });
    const b = inflight.cannedInflightExhaustedResponse({ requestId: 'req-b' });
    const c = inflight.cannedInflightExhaustedResponse({ requestId: 'req-c' });
    // Todas son del set de 3 variantes, con emoji ❌
    for (const r of [a, b, c]) {
        assert.ok(r.includes('❌'), `respuesta sin ❌: ${r}`);
        assert.match(r, /probá|esperá|reintentá|de nuevo|Intentá/i);
    }
});

// -----------------------------------------------------------------------------
// CA-7 — Budget global 90s
// -----------------------------------------------------------------------------

test('CA-7 — primaryDurationMs >= budget dispara global_budget_exceeded', () => {
    const dir = mkTmpPipelineDir();
    try {
        const d = inflight.decideInflightFallback({
            primaryProvider: 'anthropic',
            primaryErrorClass: 'timeout_no_new_bytes_30s',
            primaryDurationMs: 91_000, // excede budget default 90s
            primaryPartialOutput: '',
            attemptIndex: 0,
            pipelineDir: dir,
            chatId: 'chat-bg',
            requestId: 'req-budget-1',
        });
        assert.equal(d.shouldRetry, false);
        assert.equal(d.reason, 'global_budget_exceeded');
        assert.equal(d.budgetRemainingMs, 0);
        assert.match(d.cannedResponse, /90s|⏱️/);
        const audit = readAuditLines(dir);
        const ev = audit.find(e => e.event === 'inflight_fallback_global_timeout');
        assert.ok(ev, 'falta evento global_timeout');
        assert.equal(ev.primary_duration_ms, 91_000);
        assert.equal(ev.budget_ms, 90_000);
    } finally { cleanup(dir); }
});

test('CA-7 — budget custom para tests respeta budgetMs override', () => {
    const dir = mkTmpPipelineDir();
    try {
        const d = inflight.decideInflightFallback({
            primaryProvider: 'anthropic',
            primaryErrorClass: 'timeout',
            primaryDurationMs: 5_000,
            primaryPartialOutput: '',
            attemptIndex: 0,
            budgetMs: 1_000, // 1s — ya excedido
            pipelineDir: dir,
            chatId: 'chat-x',
            requestId: 'req-x',
        });
        assert.equal(d.reason, 'global_budget_exceeded');
    } finally { cleanup(dir); }
});

// -----------------------------------------------------------------------------
// CA-1 — Detección y resolución exitosa del secundario
// -----------------------------------------------------------------------------

test('CA-1 — 5xx in-flight resuelve a openai-codex con noticeText UX-G1', () => {
    const dir = mkTmpPipelineDir();
    try {
        const d = decideWithFakeMP({
            primaryProvider: 'anthropic',
            primaryErrorClass: 'transient_5xx',
            primaryDurationMs: 15_000,
            primaryPartialOutput: 'parcial tokens del primario',
            attemptIndex: 0,
            pipelineDir: dir,
            chatId: 'chat-5xx',
            requestId: 'req-5xx-1',
        }, makeFakeMultiProvider([]));

        assert.equal(d.shouldRetry, true);
        assert.equal(d.secondaryProvider, 'openai-codex');
        assert.equal(d.reason, 'ok');
        // UX-G1 / G2: copy en voseo argentino, no "Retrying with..."
        assert.match(d.noticeText, /⚠️/);
        assert.match(d.noticeText, /reintentando con openai-codex/i);
        // CA-3: hash del partial output expuesto, no contenido
        assert.ok(d.partialOutputHash);
        assert.equal(d.partialOutputHash.length, 12);

        const audit = readAuditLines(dir);
        const init = audit.find(e => e.event === 'inflight_fallback_initiated');
        assert.ok(init, 'falta evento initiated');
        assert.equal(init.primary_provider, 'anthropic');
        assert.equal(init.primary_error_class, 'transient_5xx');
        // CA-3: contenido del partial NO está en el audit
        assert.ok(!JSON.stringify(init).includes('parcial tokens'));
    } finally { cleanup(dir); }
});

test('CA-1 — timeout_no_new_bytes_30s genera noticeText con motivo "silencio"', () => {
    const dir = mkTmpPipelineDir();
    try {
        const d = decideWithFakeMP({
            primaryProvider: 'anthropic',
            primaryErrorClass: 'timeout_no_new_bytes_30s',
            primaryDurationMs: 35_000,
            primaryPartialOutput: '',
            attemptIndex: 0,
            pipelineDir: dir,
            chatId: 'chat-to',
            requestId: 'req-to-1',
        }, makeFakeMultiProvider([]));
        assert.equal(d.shouldRetry, true);
        assert.match(d.noticeText, /silencio/i);
    } finally { cleanup(dir); }
});

test('CA-1 — eof_premature genera noticeText con motivo "cortó antes de tiempo"', () => {
    const dir = mkTmpPipelineDir();
    try {
        const d = decideWithFakeMP({
            primaryProvider: 'anthropic',
            primaryErrorClass: 'eof_premature',
            primaryDurationMs: 12_000,
            primaryPartialOutput: 'p',
            attemptIndex: 0,
            pipelineDir: dir,
            chatId: 'chat-eof',
            requestId: 'req-eof-1',
        }, makeFakeMultiProvider([]));
        assert.equal(d.shouldRetry, true);
        assert.match(d.noticeText, /cortó la respuesta/i);
    } finally { cleanup(dir); }
});

// -----------------------------------------------------------------------------
// CA-6 — Capability degradation (UX-G3): cerebras no soporta tool_use →
// segunda línea ℹ️ con aviso
// -----------------------------------------------------------------------------

test('CA-5 / G3 — fallback a cerebras genera segunda línea ℹ️ tool_use degradation', () => {
    const dir = mkTmpPipelineDir();
    try {
        // Forzamos a que el resolver salte a cerebras directo (anthropic + codex gateados).
        const d = decideWithFakeMP({
            primaryProvider: 'openai-codex',
            primaryErrorClass: '5xx',
            primaryDurationMs: 8_000,
            primaryPartialOutput: '',
            attemptIndex: 0,
            pipelineDir: dir,
            chatId: 'chat-cb',
            requestId: 'req-cb-1',
        }, makeFakeMultiProvider(['anthropic'])); // anthropic gated → codex excluded → cerebras

        assert.equal(d.secondaryProvider, 'cerebras');
        assert.match(d.noticeText, /⚠️/);
        assert.match(d.noticeText, /ℹ️.*Modo conversacional/i);
        assert.equal(d.supportsToolUse, false);
    } finally { cleanup(dir); }
});

// -----------------------------------------------------------------------------
// All-gated path
// -----------------------------------------------------------------------------

test('CA-6 — todos los providers gateados → all_gated', () => {
    const dir = mkTmpPipelineDir();
    try {
        const d = decideWithFakeMP({
            primaryProvider: 'anthropic',
            primaryErrorClass: '5xx',
            primaryDurationMs: 5_000,
            primaryPartialOutput: '',
            attemptIndex: 0,
            pipelineDir: dir,
            chatId: 'chat-all',
            requestId: 'req-all-1',
        }, makeFakeMultiProvider(['anthropic', 'openai-codex', 'cerebras']));
        assert.equal(d.shouldRetry, false);
        assert.equal(d.reason, 'all_gated');
        const audit = readAuditLines(dir);
        assert.ok(audit.some(e => e.event === 'inflight_fallback_all_gated'));
    } finally { cleanup(dir); }
});

// -----------------------------------------------------------------------------
// CA-9 — Pre-validación de credenciales
// -----------------------------------------------------------------------------

test('CA-9 — precheck con todas las credenciales presentes → ranking completo activo', () => {
    const dir = mkTmpPipelineDir();
    try {
        const r = credPrecheck.precheckCommanderProviderRanking({
            pipelineDir: dir,
            processEnv: {
                ANTHROPIC_API_KEY: 'real-anth-key',
                OPENAI_API_KEY: 'real-oai-key',
                CEREBRAS_API_KEY: 'real-cb-key',
            },
        });
        assert.equal(r.allFailed, false);
        // anthropic = launcher claude → exime de validación de env
        assert.ok(r.activeRanking.includes('anthropic'));
        assert.ok(r.activeRanking.includes('openai-codex'));
        assert.ok(r.activeRanking.includes('cerebras'));
        assert.equal(r.degraded.length, 0);
    } finally { cleanup(dir); }
});

test('CA-9 — credencial faltante de cerebras → ranking activo sin cerebras', () => {
    const dir = mkTmpPipelineDir();
    try {
        const r = credPrecheck.precheckCommanderProviderRanking({
            pipelineDir: dir,
            processEnv: {
                ANTHROPIC_API_KEY: 'real',
                OPENAI_API_KEY: 'real',
                // CEREBRAS_API_KEY ausente
            },
        });
        assert.equal(r.allFailed, false);
        assert.ok(!r.activeRanking.includes('cerebras'));
        assert.ok(r.degraded.includes('cerebras'));
        assert.match(r.degradedReasons.cerebras, /CEREBRAS_API_KEY/);
    } finally { cleanup(dir); }
});

test('CA-9 — placeholder cuenta como degraded', () => {
    const dir = mkTmpPipelineDir();
    try {
        const r = credPrecheck.precheckCommanderProviderRanking({
            pipelineDir: dir,
            processEnv: {
                ANTHROPIC_API_KEY: 'real',
                OPENAI_API_KEY: 'REVOKED',
                CEREBRAS_API_KEY: 'real',
            },
        });
        assert.ok(r.degraded.includes('openai-codex'));
    } finally { cleanup(dir); }
});

test('CA-9 — agent-models.json inválido → allFailed:true (fail-closed)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inflight-bad-'));
    try {
        fs.writeFileSync(path.join(dir, 'agent-models.json'), '{ not json');
        const r = credPrecheck.precheckCommanderProviderRanking({
            pipelineDir: dir,
            processEnv: { ANTHROPIC_API_KEY: 'real' },
        });
        assert.equal(r.allFailed, true);
        assert.equal(r.reason, 'agent_models_invalid');
    } finally { cleanup(dir); }
});

test('CA-9 — makePrecheckHandle expone isProviderDegraded inmutable', () => {
    const handle = credPrecheck.makePrecheckHandle({
        activeRanking: ['anthropic', 'openai-codex'],
        degraded: ['cerebras'],
        degradedReasons: { cerebras: 'env_missing_or_placeholder:CEREBRAS_API_KEY' },
        allFailed: false,
        primaryProvider: 'anthropic',
        fallbackProviders: ['openai-codex', 'cerebras'],
    });
    assert.equal(handle.isProviderDegraded('cerebras'), true);
    assert.equal(handle.isProviderDegraded('anthropic'), false);
    assert.equal(handle.allFailed, false);
    // Inmutabilidad
    assert.throws(() => { handle.activeRanking.push('foo'); });
});

test('CA-9 — decideInflightFallback rechaza secundario degraded via precheck', () => {
    const dir = mkTmpPipelineDir();
    try {
        const precheck = credPrecheck.makePrecheckHandle({
            activeRanking: ['anthropic'],
            degraded: ['openai-codex', 'cerebras'],
            degradedReasons: {},
            allFailed: false,
            primaryProvider: 'anthropic',
            fallbackProviders: ['openai-codex', 'cerebras'],
        });
        const d = decideWithFakeMP({
            primaryProvider: 'anthropic',
            primaryErrorClass: '5xx',
            primaryDurationMs: 5_000,
            primaryPartialOutput: '',
            attemptIndex: 0,
            pipelineDir: dir,
            chatId: 'chat-deg',
            requestId: 'req-deg-1',
            credentialsPrecheck: precheck,
        }, makeFakeMultiProvider([]));
        assert.equal(d.shouldRetry, false);
        assert.equal(d.reason, 'all_invalid_credentials');
        const audit = readAuditLines(dir);
        assert.ok(audit.some(e => e.event === 'inflight_fallback_invalid_credentials'));
    } finally { cleanup(dir); }
});

// -----------------------------------------------------------------------------
// CA-4 — Late-response lock
// -----------------------------------------------------------------------------

test('CA-4 — acquireInflightLock + isLateResponseDuplicate distingue primer/segundo arribo', () => {
    inflight._resetInflightLocks();
    const chatId = 'chat-late';
    const requestId = 'req-late-1';
    assert.equal(inflight.isLateResponseDuplicate({ chatId, requestId }), false);
    const acquired = inflight.acquireInflightLock({ chatId, requestId, secondaryProvider: 'openai-codex' });
    assert.equal(acquired, true);
    assert.equal(inflight.isLateResponseDuplicate({ chatId, requestId }), true);
    // Acquire repetido es idempotente (no abre nuevo lock)
    const reAcquired = inflight.acquireInflightLock({ chatId, requestId });
    assert.equal(reAcquired, false);
});

test('CA-4 — noteLateResponseDiscarded emite evento sin contenido del partial', () => {
    const dir = mkTmpPipelineDir();
    try {
        inflight._resetInflightLocks();
        inflight.acquireInflightLock({ chatId: 'c', requestId: 'rL' });
        const ok = inflight.noteLateResponseDiscarded({
            pipelineDir: dir,
            primaryProvider: 'anthropic',
            partialOutput: 'CONTENIDO_SECRETO_QUE_NO_DEBE_LOGUEARSE',
            chatId: 'c',
            requestId: 'rL',
        });
        assert.equal(ok, true);
        const audit = readAuditLines(dir);
        const ev = audit.find(e => e.event === 'late_response_discarded');
        assert.ok(ev);
        assert.ok(ev.partial_output_hash);
        // CA-3: contenido NO está en el audit
        assert.ok(!JSON.stringify(audit).includes('CONTENIDO_SECRETO'));
    } finally { cleanup(dir); }
});

test('CA-4 — releaseInflightLock libera y permite re-acquire', () => {
    inflight._resetInflightLocks();
    inflight.acquireInflightLock({ chatId: 'c', requestId: 'rR' });
    assert.equal(inflight.isLateResponseDuplicate({ chatId: 'c', requestId: 'rR' }), true);
    const released = inflight.releaseInflightLock({ chatId: 'c', requestId: 'rR' });
    assert.equal(released, true);
    assert.equal(inflight.isLateResponseDuplicate({ chatId: 'c', requestId: 'rR' }), false);
});

// -----------------------------------------------------------------------------
// CA-8 — Audit log file-lock
// -----------------------------------------------------------------------------

test('CA-8 — appendChained adquiere y libera lockfile en éxito', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-lock-'));
    try {
        const file = path.join(dir, 'test.jsonl');
        auditLog.appendChained({ file, entry: { event: 'a' } });
        // Lockfile no debe quedar después de append exitoso
        assert.equal(fs.existsSync(file + '.lock'), false);
        const lines = fs.readFileSync(file, 'utf8').split('\n').filter(l => l.trim());
        assert.equal(lines.length, 1);
    } finally { cleanup(dir); }
});

test('CA-8 — appendChained con lock externo activo falla con lock_timeout', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-lock-'));
    try {
        const file = path.join(dir, 'test.jsonl');
        // Crear lock externo manualmente
        fs.writeFileSync(file + '.lock', `${process.pid}|${Date.now()}\n`);
        assert.throws(() => {
            auditLog.appendChained({ file, entry: { event: 'a' }, lockMaxMs: 100 });
        }, /lock_timeout|No se pudo adquirir lock/);
        // Limpieza
        fs.unlinkSync(file + '.lock');
    } finally { cleanup(dir); }
});

test('CA-8 — lockfile stale (mtime > 30s) se considera huérfano y se sobreescribe', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-lock-stale-'));
    try {
        const file = path.join(dir, 'test.jsonl');
        const lp = file + '.lock';
        // Crear lock viejo (40s atrás → huérfano)
        fs.writeFileSync(lp, '99999|0\n');
        const past = Date.now() - 40_000;
        fs.utimesSync(lp, past / 1000, past / 1000);
        // Debe sobreescribir el stale y appendear correctamente
        const r = auditLog.appendChained({ file, entry: { event: 'after-stale' } });
        assert.ok(r.hash_self);
        const lines = fs.readFileSync(file, 'utf8').split('\n').filter(l => l.trim());
        assert.equal(lines.length, 1);
    } finally { cleanup(dir); }
});

test('CA-8 — chain integra después de mutex (appends secuenciales mantienen hash-chain)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-lock-chain-'));
    try {
        const file = path.join(dir, 'chain.jsonl');
        for (let i = 0; i < 5; i++) {
            auditLog.appendChained({ file, entry: { event: 'e', idx: i } });
        }
        const verify = auditLog.verifyChain(file);
        assert.equal(verify.ok, true);
        assert.equal(verify.entriesChecked, 5);
    } finally { cleanup(dir); }
});

// -----------------------------------------------------------------------------
// generateRequestId & helpers
// -----------------------------------------------------------------------------

test('generateRequestId produce IDs únicos por turn', () => {
    const a = inflight.generateRequestId({ chatId: 'x' });
    const b = inflight.generateRequestId({ chatId: 'x' });
    assert.ok(a.startsWith('tg-'));
    assert.notEqual(a, b);
});

// -----------------------------------------------------------------------------
// noteInflightCompleted
// -----------------------------------------------------------------------------

test('noteInflightCompleted emite evento con outcome y tokens', () => {
    const dir = mkTmpPipelineDir();
    try {
        const ok = inflight.noteInflightCompleted({
            pipelineDir: dir,
            primaryProvider: 'anthropic',
            secondaryProvider: 'openai-codex',
            success: true,
            secondaryDurationMs: 20_500,
            secondaryTokens: { input: 1200, output: 800 },
            chatId: 'c',
            requestId: 'r-done',
            cacheMissDueToProviderChange: true,
        });
        assert.equal(ok, true);
        const audit = readAuditLines(dir);
        const ev = audit.find(e => e.event === 'inflight_fallback_completed');
        assert.ok(ev);
        assert.equal(ev.success, true);
        assert.equal(ev.secondary_provider, 'openai-codex');
        assert.equal(ev.secondary_duration_ms, 20500);
        assert.equal(ev.cache_miss_due_to_provider_change, true);
    } finally { cleanup(dir); }
});

// -----------------------------------------------------------------------------
// formatPrecheckReport
// -----------------------------------------------------------------------------

test('formatPrecheckReport reporta ranking activo en formato legible', () => {
    const ok = credPrecheck.formatPrecheckReport({
        activeRanking: ['anthropic', 'openai-codex'],
        degraded: ['cerebras'],
        degradedReasons: { cerebras: 'env_missing_or_placeholder:CEREBRAS_API_KEY' },
        allFailed: false,
        primaryProvider: 'anthropic',
        fallbackProviders: ['openai-codex', 'cerebras'],
    });
    assert.match(ok, /anthropic → openai-codex/);
    assert.match(ok, /degradados: cerebras/);
    assert.match(ok, /✅/);

    const fail = credPrecheck.formatPrecheckReport({
        activeRanking: [],
        degraded: ['anthropic', 'openai-codex'],
        degradedReasons: {
            anthropic: 'env_missing_or_placeholder:ANTHROPIC_API_KEY',
            'openai-codex': 'env_missing_or_placeholder:OPENAI_API_KEY',
        },
        allFailed: true,
        primaryProvider: 'anthropic',
        fallbackProviders: ['openai-codex'],
    });
    assert.match(fail, /❌/);
    assert.match(fail, /ranking vacío/);
});

// -----------------------------------------------------------------------------
// formatInflightFallbackNotice — verificación exhaustiva de motivos
// -----------------------------------------------------------------------------

test('formatInflightFallbackNotice mapea cada errorClass al copy correcto', () => {
    const cases = [
        { ec: 'transient_5xx',           rx: /error del servidor/i },
        { ec: '5xx',                     rx: /error del servidor/i },
        { ec: 'timeout_no_new_bytes_30s',rx: /silencio/i },
        { ec: 'timeout',                 rx: /silencio/i },
        { ec: 'eof_premature',           rx: /cortó la respuesta/i },
        { ec: 'rate_limit',              rx: /rate-limit/i },
    ];
    for (const c of cases) {
        const t = inflight.formatInflightFallbackNotice({
            primaryProvider: 'anthropic',
            secondaryProvider: 'openai-codex',
            errorClass: c.ec,
            supportsToolUse: true,
        });
        assert.match(t, c.rx, `errorClass=${c.ec} → texto=${t}`);
        assert.match(t, /⚠️/);
        assert.match(t, /reintentando con openai-codex/i);
        // No debe haber jerga técnica de stack/request_id
        assert.ok(!/stack|trace|request_id|prompt_hash/i.test(t));
    }
});

test('formatInflightFallbackNotice agrega segunda línea ℹ️ cuando supportsToolUse=false', () => {
    const t = inflight.formatInflightFallbackNotice({
        primaryProvider: 'anthropic',
        secondaryProvider: 'cerebras',
        errorClass: 'transient_5xx',
        supportsToolUse: false,
    });
    assert.match(t, /⚠️/);
    assert.match(t, /ℹ️/);
    assert.match(t, /Modo conversacional/i);
});

// -----------------------------------------------------------------------------
// Smoke: re-exports desde multi-provider.js
// -----------------------------------------------------------------------------

test('re-exports desde commander/multi-provider apuntan al módulo dedicado', () => {
    const mp = require('../commander/multi-provider');
    assert.equal(typeof mp.decideInflightFallback, 'function');
    assert.equal(typeof mp.noteInflightCompleted, 'function');
    assert.equal(typeof mp.acquireInflightLock, 'function');
    assert.equal(typeof mp.isLateResponseDuplicate, 'function');
    assert.equal(typeof mp.precheckCommanderProviderRanking, 'function');
    assert.equal(typeof mp.makePrecheckHandle, 'function');
    assert.equal(typeof mp.formatInflightFallbackNotice, 'function');
    assert.equal(mp.INFLIGHT_BUDGET_MS, 90 * 1000);
    assert.equal(mp.MAX_INFLIGHT_FALLBACKS, 1);
});
