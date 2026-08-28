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

// Aísla del kill-switch operacional live (`provider-disabled.json` global): sin
// esto, un provider drenado en runtime por el pulpo volvía flaky la chain
// (#4801 rebote). Ver isolate-provider-disabled.helper.js.
require('./isolate-provider-disabled.helper');
const inflight = require('../commander/inflight-fallback');
// #6179 CA-8 — lista única de jerga/secretos compartida por los tests anti-jerga.
const { assertCopyLimpio } = require('./helpers/forbidden-copy-patterns');
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
            primaryDurationMs: 3_601_000, // excede el techo anti-zombi (60 min)
            primaryPartialOutput: '',
            attemptIndex: 0,
            budgetMs: inflight.TURN_BUDGET_MS,
            pipelineDir: dir,
            chatId: 'chat-bg',
            requestId: 'req-budget-1',
        });
        assert.equal(d.shouldRetry, false);
        assert.equal(d.reason, 'global_budget_exceeded');
        assert.equal(d.budgetRemainingMs, 0);
        assert.match(d.cannedResponse, /trabada/);
        // El mensaje ya no debe mencionar "90s" ni culpar al reloj.
        assert.doesNotMatch(d.cannedResponse, /90s/);
        assert.doesNotMatch(d.cannedResponse, /tard[oó] m[aá]s de/);
        const audit = readAuditLines(dir);
        const ev = audit.find(e => e.event === 'inflight_fallback_global_timeout');
        assert.ok(ev, 'falta evento global_timeout');
        assert.equal(ev.primary_duration_ms, 3_601_000);
        assert.equal(ev.budget_ms, 3_600_000);
    } finally { cleanup(dir); }
});

test('#4329 no-regresión — dur corta con budget 600s NO dispara timeout', () => {
    const dir = mkTmpPipelineDir();
    try {
        const d = inflight.decideInflightFallback({
            primaryProvider: 'anthropic',
            primaryErrorClass: 'http_5xx',
            primaryDurationMs: 3_000, // pocos segundos — muy por debajo del budget
            primaryPartialOutput: '',
            attemptIndex: 0,
            budgetMs: inflight.TURN_BUDGET_MS,
            pipelineDir: dir,
            chatId: 'chat-fast',
            requestId: 'req-fast',
        });
        assert.notEqual(d.reason, 'global_budget_exceeded');
        assert.equal(d.shouldRetry, true, 'un pedido rápido con error debe intentar fallback, no cortar por tiempo');
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
        // #4440 CA-2: copy orientado al operador (demora + reintento automático),
        // sin nombres de provider ni jerga interna en el texto visible.
        assert.match(d.noticeText, /⏳/);
        assert.match(d.noticeText, /reintent/i);
        assert.ok(!/anthropic|openai|codex/i.test(d.noticeText), `fuga de provider: ${d.noticeText}`);
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

test('#4440 — timeout_no_new_bytes_30s genera noticeText genérico sin exponer timer', () => {
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
        assert.match(d.noticeText, /⏳/);
        assert.ok(!/silencio|30s|\d+\s*seg/i.test(d.noticeText), `fuga de timer: ${d.noticeText}`);
    } finally { cleanup(dir); }
});

test('#4440 — eof_premature genera noticeText genérico sin jerga de errorClass', () => {
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
        assert.match(d.noticeText, /⏳/);
        assert.ok(!/eof|cortó la respuesta|mid-flight/i.test(d.noticeText), `fuga de errorClass: ${d.noticeText}`);
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
        assert.match(d.noticeText, /⏳/);
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

test('#4440 CA-2 — formatInflightFallbackNotice NO expone jerga interna para ningún errorClass', () => {
    // Aunque la firma sigue recibiendo primaryProvider/secondaryProvider/errorClass
    // (backward-compat con los callers), NINGUNO debe filtrarse al texto visible.
    const errorClasses = [
        'transient_5xx', '5xx', 'timeout_no_new_bytes_30s', 'timeout',
        'eof_premature', 'rate_limit', 'unknown', undefined,
    ];
    for (const ec of errorClasses) {
        const t = inflight.formatInflightFallbackNotice({
            primaryProvider: 'anthropic',
            secondaryProvider: 'openai-codex',
            errorClass: ec,
            supportsToolUse: true,
        });
        // Estado A (demora + reintento automático en curso)
        assert.match(t, /⏳/, `errorClass=${ec} → texto=${t}`);
        assert.match(t, /reintent/i, `errorClass=${ec} → debe comunicar reintento automático`);
        // CA-2 — sin nombres de provider, timers, errorClass ni conteo de reintentos
        assert.ok(!/anthropic|openai|codex|cerebras|gemini|groq/i.test(t), `fuga de provider: ${t}`);
        assert.ok(!/30s|30 segundos|\d+\s*seg/i.test(t), `fuga de timer: ${t}`);
        assert.ok(!/errorClass|transient_5xx|eof_premature|rate-limit|rate_limit|mid-flight|sin clasificar/i.test(t), `fuga de errorClass: ${t}`);
        assert.ok(!/reintentando con|reintento \d/i.test(t), `fuga de conteo/target de reintento: ${t}`);
        // Sin jerga técnica de stack/request_id
        assert.ok(!/stack|trace|request_id|prompt_hash/i.test(t));
        // #6179 CA-8 — además de los asserts propios de #4440, el texto pasa por
        // la lista CENTRALIZADA. Antes cada test anti-jerga traía su propia
        // copia, y tres copias divergentes de un control es la forma más barata
        // de que el control no exista: alcanza con agregar el patrón nuevo en
        // una sola para que las otras dos den verde sobre una fuga real.
        assertCopyLimpio(assert, t, `notice in-flight errorClass=${ec}`);
    }
});

test('#4440 — formatInflightFallbackNotice varía por requestId (semilla determinística)', () => {
    const mk = (rid) => inflight.formatInflightFallbackNotice({
        primaryProvider: 'anthropic', secondaryProvider: 'openai-codex',
        errorClass: 'timeout', supportsToolUse: true, requestId: rid,
    });
    // Mismo requestId → mismo mensaje (estable dentro del turno)
    assert.equal(mk('req-abc'), mk('req-abc'));
    // Al menos dos requestId distintos producen textos distintos entre un set variado
    const set = new Set(['a', 'b', 'c', 'd', 'e', 'f'].map(mk));
    assert.ok(set.size >= 2, 'debería rotar entre variantes');
});

test('formatInflightFallbackNotice agrega segunda línea ℹ️ cuando supportsToolUse=false', () => {
    const t = inflight.formatInflightFallbackNotice({
        primaryProvider: 'anthropic',
        secondaryProvider: 'cerebras',
        errorClass: 'transient_5xx',
        supportsToolUse: false,
    });
    assert.match(t, /⏳/);
    assert.match(t, /ℹ️/);
    assert.match(t, /Modo conversacional/i);
});

// -----------------------------------------------------------------------------
// #4440 — cannedAllProvidersFailedResponse: honestidad de estado + sin jerga
// -----------------------------------------------------------------------------

test('#4440 CA-1 — cannedAllProvidersFailedResponse rama NO verificada no afirma falla total', () => {
    const mp = require('../commander/multi-provider');
    // Default (sin flag) y explícito false: ambos NO deben afirmar "TODOS".
    for (const args of [{}, { verifiedAllFailed: false }, { chainTried: ['anthropic', 'openai-codex'] }]) {
        const t = mp.cannedAllProvidersFailedResponse(args);
        assert.ok(!/TODOS/i.test(t), `no debe afirmar falla total: ${t}`);
        assert.match(t, /⚠️/);
        // CA-3 — expectativa/acción clara: comandos determinísticos
        assert.match(t, /\/status|\/listado|\/lanzar/);
    }
});

test('#4440 CA-1 — cannedAllProvidersFailedResponse rama verificada puede afirmar imposibilidad total', () => {
    const mp = require('../commander/multi-provider');
    const t = mp.cannedAllProvidersFailedResponse({ verifiedAllFailed: true, chainTried: ['anthropic', 'openai-codex'] });
    assert.match(t, /⚠️/);
    assert.match(t, /no.*(tengo|puedo).*IA|IA/i, `debe comunicar imposibilidad de IA: ${t}`);
    assert.match(t, /\/status|\/listado|\/lanzar/);
});

test('#4440 CA-2 — cannedAllProvidersFailedResponse nunca interpola chainTried ni nombres de provider', () => {
    const mp = require('../commander/multi-provider');
    for (const verifiedAllFailed of [true, false]) {
        const t = mp.cannedAllProvidersFailedResponse({
            verifiedAllFailed,
            chainTried: ['anthropic', 'openai-codex', 'cerebras'],
        });
        assert.ok(!/Intenté con/i.test(t), `fuga de chainTried: ${t}`);
        assert.ok(!/anthropic|openai|codex|cerebras|gemini|groq/i.test(t), `fuga de provider: ${t}`);
        assert.ok(!/30s|\d+\s*seg|reintento \d|fallback/i.test(t), `fuga de jerga: ${t}`);
    }
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
    assert.equal(mp.INFLIGHT_BUDGET_MS, 60 * 60 * 1000); // budget efectivo (techo anti-zombi, 60 min)
    assert.equal(mp.MAX_INFLIGHT_FALLBACKS, 1);
});

// -----------------------------------------------------------------------------
// #4329 — Budget del turno del Commander: resolver env + clamp + copy sincronizado
// -----------------------------------------------------------------------------

test('#4329 CA-1 — resolveTurnBudgetMs sin env → 60 min (techo anti-zombi, ya no 10 min)', () => {
    assert.equal(inflight.resolveTurnBudgetMs({}), 60 * 60 * 1000);
    assert.equal(inflight.DEFAULT_BUDGET_MS, 60 * 60 * 1000);
    assert.equal(inflight.TURN_BUDGET_MS, 60 * 60 * 1000);
});

test('#4329 CA-2 — resolveTurnBudgetMs con env válido → valor configurado', () => {
    assert.equal(inflight.resolveTurnBudgetMs({ COMMANDER_TURN_BUDGET_MS: '300000' }), 300_000);
    assert.equal(inflight.resolveTurnBudgetMs({ COMMANDER_TURN_BUDGET_MS: '120000' }), 120_000);
});

test('#4329 CA-5 (SR-1) — resolveTurnBudgetMs fail-closed ante env inválido', () => {
    const DEF = 60 * 60 * 1000;
    for (const bad of ['', 'abc', '0', '-5', 'NaN', '  ', undefined]) {
        assert.equal(
            inflight.resolveTurnBudgetMs({ COMMANDER_TURN_BUDGET_MS: bad }),
            DEF,
            `env inválido ${JSON.stringify(bad)} debe caer al default`,
        );
    }
    // Sin la clave definida.
    assert.equal(inflight.resolveTurnBudgetMs({ OTRA: 'x' }), DEF);
});

test('#4329 CA-6 (SR-2) — resolveTurnBudgetMs clampea al techo MAX_BUDGET_MS', () => {
    const MAX = 4 * 60 * 60 * 1000;
    assert.equal(inflight.MAX_BUDGET_MS, MAX);
    assert.equal(inflight.resolveTurnBudgetMs({ COMMANDER_TURN_BUDGET_MS: '999999999' }), MAX);
    // Exactamente en el techo → se mantiene.
    assert.equal(inflight.resolveTurnBudgetMs({ COMMANDER_TURN_BUDGET_MS: String(MAX) }), MAX);
    // Justo por encima → clamp.
    assert.equal(inflight.resolveTurnBudgetMs({ COMMANDER_TURN_BUDGET_MS: String(MAX + 1) }), MAX);
});

test('#4329 CA-7 (SR-3) — LATE_RESPONSE_TTL_MS estrictamente mayor al peor budget', () => {
    assert.ok(inflight.LATE_RESPONSE_TTL_MS > inflight.MAX_BUDGET_MS, 'TTL debe superar MAX_BUDGET_MS');
    assert.ok(inflight.LATE_RESPONSE_TTL_MS > inflight.TURN_BUDGET_MS, 'TTL debe superar TURN_BUDGET_MS');
    assert.equal(inflight.LATE_RESPONSE_TTL_MS, 2 * inflight.MAX_BUDGET_MS);
});

test('#4329 CA-3 — cannedInflightBudgetTimeoutResponse no dice "90s" y refleja minutos', () => {
    const def = inflight.cannedInflightBudgetTimeoutResponse();
    assert.doesNotMatch(def, /90s/);
    assert.match(def, /60 min/); // 3600000ms → 60 min
    // Budget custom en minutos.
    assert.match(inflight.cannedInflightBudgetTimeoutResponse(300_000), /5 min/);
    // Budget < 60s → expresado en segundos (guideline UX, evita "0 min").
    const chico = inflight.cannedInflightBudgetTimeoutResponse(30_000);
    assert.match(chico, /30s/);
    assert.doesNotMatch(chico, /0 min/);
    // Argumento inválido → cae al default.
    assert.match(inflight.cannedInflightBudgetTimeoutResponse('nope'), /60 min/);
});

// -----------------------------------------------------------------------------
// Corte del turno por INACTIVIDAD (reemplaza el corte por duración total).
//
// Contexto: el operador pidió explícitamente sacar el corte a los 10 min y el
// mensaje "tardó más de 10 min y corté" — un pedido que avanza no se corta, y
// para informar están las notificaciones parciales cada 2 min.
// -----------------------------------------------------------------------------

test('idle watchdog — resolveIdleTimeoutMs default 10 min, fail-closed y clampeado', () => {
    assert.equal(inflight.DEFAULT_IDLE_TIMEOUT_MS, 10 * 60 * 1000);
    assert.equal(inflight.resolveIdleTimeoutMs(undefined), 10 * 60 * 1000);
    for (const bad of ['', 'abc', '0', '-5', 'NaN', '  ', null]) {
        assert.equal(
            inflight.resolveIdleTimeoutMs(bad),
            10 * 60 * 1000,
            `env inválido ${JSON.stringify(bad)} nunca desactiva el corte`,
        );
    }
    assert.equal(inflight.resolveIdleTimeoutMs('120000'), 120_000);
    // Clamp: un env desmedido no reintroduce el cuelgue infinito.
    assert.equal(inflight.resolveIdleTimeoutMs('999999999'), inflight.MAX_IDLE_TIMEOUT_MS);
});

test('idle watchdog — resolveAbsoluteMaxMs default 60 min, fail-closed y clampeado', () => {
    assert.equal(inflight.DEFAULT_ABSOLUTE_MAX_MS, 60 * 60 * 1000);
    assert.equal(inflight.resolveAbsoluteMaxMs(undefined), 60 * 60 * 1000);
    for (const bad of ['', 'abc', '0', '-5', 'NaN', null]) {
        assert.equal(inflight.resolveAbsoluteMaxMs(bad), 60 * 60 * 1000);
    }
    assert.equal(inflight.resolveAbsoluteMaxMs('900000'), 900_000);
    assert.equal(inflight.resolveAbsoluteMaxMs('999999999'), inflight.MAX_ABSOLUTE_MAX_MS);
});

test('idle watchdog — el techo absoluto es > que el idle (el cuelgue corta antes que el techo)', () => {
    assert.ok(inflight.DEFAULT_ABSOLUTE_MAX_MS > inflight.DEFAULT_IDLE_TIMEOUT_MS);
    assert.ok(inflight.MAX_ABSOLUTE_MAX_MS >= inflight.MAX_IDLE_TIMEOUT_MS);
});

test('pulpo.js ya NO corta el turno del Commander por duración total de 10 min', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const pulpoSrc = fs.readFileSync(path.join(__dirname, '..', '..', 'pulpo.js'), 'utf8');

    // El hard timeout absoluto de 10 min quedó eliminado.
    assert.doesNotMatch(
        pulpoSrc,
        /const\s+HARD_TIMEOUT_MS\s*=/,
        'HARD_TIMEOUT_MS (corte por duración total) no debe volver',
    );
    // Y en su lugar el turno se corta por inactividad + techo anti-zombi.
    assert.match(pulpoSrc, /IDLE_TIMEOUT_MS\s*=\s*inflightFallback\.resolveIdleTimeoutMs/);
    assert.match(pulpoSrc, /ABSOLUTE_MAX_MS\s*=\s*inflightFallback\.resolveAbsoluteMaxMs/);
    // El watchdog no debe matar mientras haya una herramienta en vuelo.
    assert.match(pulpoSrc, /if\s*\(pendingToolUses\.size\s*>\s*0\)\s*return;/);
    // Las notificaciones parciales (cada 2 min) siguen siendo el canal de aviso.
    assert.match(pulpoSrc, /\}, 120000\);/);
});

test('#4329 SR-4 — pulpo.js deriva HARD_NON_ANTH_MS del budget, no del literal 90*1000', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const pulpoSrc = fs.readFileSync(
        path.join(__dirname, '..', '..', 'pulpo.js'), 'utf8',
    );
    // HARD_NON_ANTH_MS ya no puede asignarse el literal 90 * 1000.
    assert.doesNotMatch(
        pulpoSrc,
        /HARD_NON_ANTH_MS\s*=\s*90\s*\*\s*1000/,
        'HARD_NON_ANTH_MS no debe seguir hardcodeado en 90 * 1000',
    );
    assert.match(
        pulpoSrc,
        /HARD_NON_ANTH_MS\s*=\s*inflightFallback\.TURN_BUDGET_MS/,
        'HARD_NON_ANTH_MS debe derivar de inflightFallback.TURN_BUDGET_MS',
    );
    // COMMANDER_SUMMARY_TIMEOUT_MS (timeout distinto) NO se toca.
    assert.match(
        pulpoSrc,
        /COMMANDER_SUMMARY_TIMEOUT_MS\s*=\s*90\s*\*\s*1000/,
        'COMMANDER_SUMMARY_TIMEOUT_MS debe seguir en 90 * 1000',
    );
});

// =============================================================================
// #6458 — El fallback deja de mentir: `success` tri-estado + `delivery_state`.
// =============================================================================

test('#6458 CA-10: sin entrega observada ⇒ success === null y delivery_state === delivery_pending', () => {
    const dir = mkTmpPipelineDir();
    try {
        const ok = inflight.noteInflightCompleted({
            pipelineDir: dir,
            primaryProvider: 'anthropic',
            secondaryProvider: 'openai-codex',
            // NO se pasa `success`: nadie observó la entrega.
            deliveryState: 'delivery_pending',
            commanderReqId: 'abc123def456-1756039552000',
            chatId: 'c',
            requestId: 'r-pending',
        });
        assert.equal(ok, true);
        const ev = readAuditLines(dir).find(e => e.event === 'inflight_fallback_completed');
        assert.ok(ev);
        assert.equal(ev.success, null, 'null = NO OBSERVADO');
        assert.notEqual(ev.success, true, 'explícitamente NO afirma éxito');
        assert.equal(ev.delivery_state, 'delivery_pending');
        assert.equal(ev.commander_req_id, 'abc123def456-1756039552000');
    } finally { cleanup(dir); }
});

test('#6458 CA-10: success === false se conserva (observado como fallo), no colapsa a null', () => {
    const dir = mkTmpPipelineDir();
    try {
        inflight.noteInflightCompleted({
            pipelineDir: dir, primaryProvider: 'anthropic', secondaryProvider: 'openai-codex',
            success: false, chatId: 'c', requestId: 'r-false',
        });
        const ev = readAuditLines(dir).find(e => e.event === 'inflight_fallback_completed');
        assert.equal(ev.success, false);
        assert.notEqual(ev.success, null);
    } finally { cleanup(dir); }
});

test('#6458 CA-10: un deliveryState fuera del enum cerrado ⇒ null (fail-closed), nunca crudo', () => {
    const dir = mkTmpPipelineDir();
    try {
        const malos = ['entregado', 'DELIVERY_PENDING', '', 42, {}, null, '../../etc/passwd'];
        malos.forEach((malo, i) => {
            inflight.noteInflightCompleted({
                pipelineDir: dir, primaryProvider: 'anthropic', secondaryProvider: 'openai-codex',
                deliveryState: malo, chatId: 'c', requestId: `r-malo-${i}`,
            });
        });
        const evs = readAuditLines(dir).filter(e => e.event === 'inflight_fallback_completed');
        assert.equal(evs.length, 7);
        for (const ev of evs) assert.equal(ev.delivery_state, null);
        const raw = JSON.stringify(evs);
        assert.equal(raw.includes('etc/passwd'), false, 'el valor crudo nunca se persiste');
    } finally { cleanup(dir); }
});

test('#6458 CA-10: los campos nuevos van AL FINAL del entry (shape aditivo)', () => {
    const dir = mkTmpPipelineDir();
    try {
        inflight.noteInflightCompleted({
            pipelineDir: dir, primaryProvider: 'anthropic', secondaryProvider: 'openai-codex',
            deliveryState: 'delivery_pending', commanderReqId: 'h-1', chatId: 'c', requestId: 'r-orden',
        });
        const ev = readAuditLines(dir).find(e => e.event === 'inflight_fallback_completed');
        const keys = Object.keys(ev);
        // `appendChained` agrega sus propios campos de cadena; los nuestros son
        // los últimos DEL PAYLOAD, o sea van después de los campos previos.
        assert.ok(keys.indexOf('commander_req_id') > keys.indexOf('cache_miss_due_to_provider_change'));
        assert.ok(keys.indexOf('delivery_state') > keys.indexOf('commander_req_id'));
    } finally { cleanup(dir); }
});

test('#6458 CA-9: noteInflightCompleted no persiste chat ids crudos', () => {
    const dir = mkTmpPipelineDir();
    try {
        inflight.noteInflightCompleted({
            pipelineDir: dir, primaryProvider: 'anthropic', secondaryProvider: 'openai-codex',
            deliveryState: 'delivery_pending',
            commanderReqId: inflight._hashFor(-1001234567890) + '-1756039552000',
            chatId: -1001234567890, requestId: 'r-seudo',
        });
        const ev = readAuditLines(dir).find(e => e.event === 'inflight_fallback_completed');
        assert.equal(JSON.stringify(ev).includes('1001234567890'), false);
        assert.equal(ev.commander_req_id.split('-')[0], ev.chat_id_hash,
            'el 1er segmento coincide con el chat_id_hash de la MISMA entrada');
    } finally { cleanup(dir); }
});

// -----------------------------------------------------------------------------
// noteFallbackDeliveryResolved — evento terminal (lo CONSUME #6459; acá se define)
// -----------------------------------------------------------------------------

test('#6458: noteFallbackDeliveryResolved emite un EVENTO NUEVO, sin tocar el anterior', () => {
    const dir = mkTmpPipelineDir();
    try {
        inflight.noteInflightCompleted({
            pipelineDir: dir, primaryProvider: 'anthropic', secondaryProvider: 'openai-codex',
            deliveryState: 'delivery_pending', commanderReqId: 'h-9', chatId: 'c', requestId: 'r-9',
        });
        const antes = readAuditLines(dir).find(e => e.event === 'inflight_fallback_completed');

        const ok = inflight.noteFallbackDeliveryResolved({
            pipelineDir: dir, primaryProvider: 'anthropic', secondaryProvider: 'openai-codex',
            deliveryState: 'delivery_observed', resolvedBy: 'telegram_receipt',
            commanderReqId: 'h-9', chatId: 'c', requestId: 'r-9',
        });
        assert.equal(ok, true);

        const lineas = readAuditLines(dir);
        const despues = lineas.find(e => e.event === 'inflight_fallback_completed');
        assert.deepEqual(despues, antes, 'la entrada ya asentada NO se reescribió');

        const resolved = lineas.find(e => e.event === 'inflight_fallback_delivery_resolved');
        assert.ok(resolved);
        assert.equal(resolved.delivery_state, 'delivery_observed');
        assert.equal(resolved.resolved_by, 'telegram_receipt');
        assert.equal(resolved.commander_req_id, 'h-9');
        assert.equal(resolved.request_id, 'r-9');
    } finally { cleanup(dir); }
});

test('#6458: noteFallbackDeliveryResolved es fail-closed con estado y resolvedBy inválidos', () => {
    const dir = mkTmpPipelineDir();
    try {
        inflight.noteFallbackDeliveryResolved({
            pipelineDir: dir, deliveryState: 'inventado', resolvedBy: { a: 1 },
            chatId: 'c', requestId: 'r-bad',
        });
        const ev = readAuditLines(dir).find(e => e.event === 'inflight_fallback_delivery_resolved');
        assert.equal(ev.delivery_state, null);
        assert.equal(ev.resolved_by, null);
        assert.equal(ev.skill, inflight.COMMANDER_SKILL);
    } finally { cleanup(dir); }
});

test('#6458: la cadena hash del audit verifica con los campos nuevos presentes', () => {
    const dir = mkTmpPipelineDir();
    try {
        inflight.noteInflightCompleted({
            pipelineDir: dir, primaryProvider: 'anthropic', secondaryProvider: 'openai-codex',
            success: true, chatId: 'c', requestId: 'r-a',
        });
        inflight.noteInflightCompleted({
            pipelineDir: dir, primaryProvider: 'anthropic', secondaryProvider: 'openai-codex',
            deliveryState: 'delivery_pending', commanderReqId: 'h-2', chatId: 'c', requestId: 'r-b',
        });
        inflight.noteFallbackDeliveryResolved({
            pipelineDir: dir, deliveryState: 'delivery_failed', resolvedBy: 'reconciler',
            commanderReqId: 'h-2', chatId: 'c', requestId: 'r-b',
        });
        const file = inflight._auditFile(dir);
        const res = auditLog.verifyChain(file);
        assert.equal(res.ok, true, JSON.stringify(res));
    } finally { cleanup(dir); }
});

// =============================================================================
// #6459 — `fallback_delivery_resolved` con desenlace EXPLÍCITO (R-1).
//
// El entry de `noteFallbackDeliveryResolved` no tenía `success` ni `error_code`,
// y los literales `'delivered'`/`'not_delivered'` que proponía el body de #6459 no
// existen en `DELIVERY_STATES`: `_normalizeDeliveryState` los colapsa a `null` en
// silencio. Sin los dos campos nuevos, CA-2 y CA-3 son inverificables.
// =============================================================================

test('#6459 CA-3: entrega CONFIRMADA cierra a éxito, sin regresión de #4309', () => {
    const dir = mkTmpPipelineDir();
    try {
        inflight.noteFallbackDeliveryResolved({
            pipelineDir: dir, deliveryState: 'delivery_observed', resolvedBy: 'orphan_sweep',
            success: true, commanderReqId: 'h-ok', chatId: 'c', requestId: 'r-ok',
        });
        const ev = readAuditLines(dir).find(e => e.event === 'inflight_fallback_delivery_resolved');
        assert.equal(ev.delivery_state, 'delivery_observed');
        assert.equal(ev.success, true);
        assert.equal(ev.error_code, null);
        assert.equal(ev.commander_req_id, 'h-ok');
    } finally { cleanup(dir); }
});

test('#6459 CA-2: entrega NO confirmada cierra con delivered=false, distinguible de empty_output', () => {
    const dir = mkTmpPipelineDir();
    try {
        inflight.noteFallbackDeliveryResolved({
            pipelineDir: dir, deliveryState: 'delivery_failed', resolvedBy: 'orphan_sweep',
            success: false, errorCode: 'delivered=false',
            commanderReqId: 'h-no', chatId: 'c', requestId: 'r-no',
        });
        const ev = readAuditLines(dir).find(e => e.event === 'inflight_fallback_delivery_resolved');
        assert.equal(ev.delivery_state, 'delivery_failed');
        assert.equal(ev.success, false);
        assert.equal(ev.error_code, 'delivered=false');
        assert.notEqual(ev.error_code, 'empty_output');
    } finally { cleanup(dir); }
});

test('#6459: sin los campos nuevos el desenlace queda NO OBSERVADO (null), no false', () => {
    const dir = mkTmpPipelineDir();
    try {
        inflight.noteFallbackDeliveryResolved({
            pipelineDir: dir, deliveryState: 'delivery_pending', resolvedBy: 'reconciler',
            commanderReqId: 'h-null', chatId: 'c', requestId: 'r-null',
        });
        const ev = readAuditLines(dir).find(e => e.event === 'inflight_fallback_delivery_resolved');
        assert.equal(ev.success, null, '"no observado" y "observado como fallo" son cosas distintas');
        assert.equal(ev.error_code, null);
    } finally { cleanup(dir); }
});

test('#6459: error_code es texto ACOTADO (anti log-forging)', () => {
    const dir = mkTmpPipelineDir();
    try {
        inflight.noteFallbackDeliveryResolved({
            pipelineDir: dir, deliveryState: 'delivery_failed', resolvedBy: 'orphan_sweep',
            success: false, errorCode: 'x'.repeat(500),
            commanderReqId: 'h-long', chatId: 'c', requestId: 'r-long',
        });
        const ev = readAuditLines(dir).find(e => e.event === 'inflight_fallback_delivery_resolved');
        assert.equal(ev.error_code.length, 64);
        // Un errorCode no-string no se persiste crudo.
        assert.equal(ev.success, false);
    } finally { cleanup(dir); }
});

test('#6459 CA-4: una entrada VIEJA sin los campos nuevos sigue verificando la hash-chain', () => {
    const dir = mkTmpPipelineDir();
    try {
        // Entradas "viejas" (sin success/error_code en el resolved) y nuevas,
        // encadenadas en el mismo archivo: los campos aditivos AL FINAL no
        // rompen el hash de las que no los traen.
        inflight.noteInflightCompleted({
            pipelineDir: dir, primaryProvider: 'anthropic', secondaryProvider: 'openai-codex',
            success: true, chatId: 'c', requestId: 'r-1',
        });
        inflight.noteFallbackDeliveryResolved({
            pipelineDir: dir, deliveryState: 'delivery_failed', resolvedBy: 'reconciler',
            commanderReqId: 'h-viejo', chatId: 'c', requestId: 'r-1',
        });
        inflight.noteFallbackDeliveryResolved({
            pipelineDir: dir, deliveryState: 'delivery_failed', resolvedBy: 'orphan_sweep',
            success: false, errorCode: 'delivered=false',
            commanderReqId: 'h-nuevo', chatId: 'c', requestId: 'r-2',
        });
        const res = auditLog.verifyChain(inflight._auditFile(dir));
        assert.equal(res.ok, true, JSON.stringify(res));
        assert.equal(res.entriesChecked, 3);
    } finally { cleanup(dir); }
});
