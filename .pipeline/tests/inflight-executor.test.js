// =============================================================================
// inflight-executor.test.js — Tests del ejecutor del fallback in-flight (#4309).
//
// Cubre el wire-up de EJECUCIÓN (distinto de la DECISIÓN, ya testeada en
// commander-inflight-fallback.test.js):
//   CA-1 — happy path: decide → lock → notice → runSecondary (spawn) → executed.
//   CA-3 — skill-agnóstico: cualquier agente (no solo el Commander) usa el core.
//   CA-4 — distinción decisión/ejecución: el caller emite completed solo si executed.
//   CA-6 — cap/all-gated: sin secundario → onCanned, NO runSecondary, executed:false.
//   CA-7 — late-response lock: el lock se adquiere antes de spawnear el secundario.
//   Robustez — decide lanza / runSecondary lanza → fail-closed sin romper.
//   Orden — acquireLock y onNotice ocurren ANTES de runSecondary.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const executor = require('../lib/inflight-executor');
const inflight = require('../lib/commander/inflight-fallback');

// Decisión fake "ok" reutilizable.
function okDecision(overrides = {}) {
    return {
        shouldRetry: true,
        secondaryProvider: 'openai-codex',
        secondaryHandler: { providerDef: { supports_tool_use: true } },
        secondaryModel: 'gpt-5-codex',
        reason: 'ok',
        noticeText: '⚠️ anthropic se cayó — reintentando con openai-codex.',
        ...overrides,
    };
}

// -----------------------------------------------------------------------------
// CA-1 — happy path: ejecución efectiva del secundario.
// -----------------------------------------------------------------------------
test('CA-1 — happy path: decide→lock→notice→runSecondary y executed:true', () => {
    const calls = [];
    const res = executor.runInflightFallback({
        skill: 'telegram-commander',
        primaryProvider: 'anthropic',
        primaryErrorClass: 'transient_5xx',
        primaryDurationMs: 12_000,
        primaryPartialOutput: 'parcial',
        attemptIndex: 0,
        pipelineDir: '/tmp/nope',
        lockNamespace: 'chat-1',
        requestId: 'req-happy-1',
        decide: (opts) => { calls.push(['decide', opts.skill]); return okDecision(); },
        acquireLock: (opts) => { calls.push(['lock', opts.requestId, opts.secondaryProvider]); return true; },
        onNotice: (txt) => { calls.push(['notice', txt]); },
        onCanned: () => { calls.push(['canned']); },
        runSecondary: (dec) => { calls.push(['runSecondary', dec.secondaryProvider]); },
        log: () => {},
    });

    assert.equal(res.executed, true);
    assert.equal(res.secondaryProvider, 'openai-codex');
    assert.equal(res.secondaryModel, 'gpt-5-codex');
    // onCanned NUNCA se llama en el happy path.
    assert.ok(!calls.some(c => c[0] === 'canned'));
    // runSecondary se llamó con el provider secundario.
    assert.ok(calls.some(c => c[0] === 'runSecondary' && c[1] === 'openai-codex'));
});

// -----------------------------------------------------------------------------
// Orden — acquireLock y onNotice ANTES de runSecondary (CA-7 / UX).
// -----------------------------------------------------------------------------
test('Orden — lock y notice ocurren antes de runSecondary', () => {
    const order = [];
    executor.runInflightFallback({
        primaryProvider: 'anthropic',
        primaryErrorClass: 'timeout_no_new_bytes_30s',
        lockNamespace: 'chat-ord',
        requestId: 'req-ord',
        decide: () => okDecision(),
        acquireLock: () => { order.push('lock'); return true; },
        onNotice: () => { order.push('notice'); },
        runSecondary: () => { order.push('runSecondary'); },
        log: () => {},
    });
    assert.deepEqual(order, ['lock', 'notice', 'runSecondary']);
});

// -----------------------------------------------------------------------------
// CA-3 — skill-agnóstico: un agente de pipeline (no Commander) usa el core.
// -----------------------------------------------------------------------------
test('CA-3 — skill propagado al core + lockNamespace por issue (cross-agente)', () => {
    let seenSkill = null;
    let seenChatId = null;
    const res = executor.runInflightFallback({
        skill: 'android-dev',
        primaryProvider: 'anthropic',
        primaryErrorClass: 'eof_premature',
        lockNamespace: 'issue-4309',
        requestId: 'req-android',
        decide: (opts) => { seenSkill = opts.skill; seenChatId = opts.chatId; return okDecision(); },
        acquireLock: () => true,
        runSecondary: () => {},
        log: () => {},
    });
    assert.equal(seenSkill, 'android-dev');
    // El namespace del lock viaja como chatId al core (issue+request_id para agentes).
    assert.equal(seenChatId, 'issue-4309');
    assert.equal(res.executed, true);
});

test('CA-3 — sin skill explícito, default COMMANDER_SKILL', () => {
    let seenSkill = null;
    executor.runInflightFallback({
        primaryProvider: 'anthropic',
        primaryErrorClass: 'transient_5xx',
        lockNamespace: 'chat-def',
        requestId: 'req-def',
        decide: (opts) => { seenSkill = opts.skill; return okDecision(); },
        acquireLock: () => true,
        runSecondary: () => {},
        log: () => {},
    });
    assert.equal(seenSkill, executor.COMMANDER_SKILL);
    assert.equal(executor.COMMANDER_SKILL, 'telegram-commander');
});

// -----------------------------------------------------------------------------
// CA-6 — sin candidato (cap/budget/all_gated): onCanned, NO runSecondary.
// -----------------------------------------------------------------------------
test('CA-6 — shouldRetry:false → onCanned y executed:false (sin spawn)', () => {
    const calls = [];
    const res = executor.runInflightFallback({
        primaryProvider: 'anthropic',
        primaryErrorClass: 'transient_5xx',
        lockNamespace: 'chat-cap',
        requestId: 'req-cap',
        decide: () => ({
            shouldRetry: false,
            reason: 'cap_exhausted',
            cannedResponse: '❌ Dos intentos fallidos seguidos.',
        }),
        acquireLock: () => { calls.push('lock'); return true; },
        onCanned: (txt, reason) => { calls.push(['canned', txt, reason]); },
        runSecondary: () => { calls.push('runSecondary'); },
        log: () => {},
    });
    assert.equal(res.executed, false);
    assert.equal(res.reason, 'cap_exhausted');
    // NO spawn, NO lock cuando no hay retry.
    assert.ok(!calls.includes('runSecondary'));
    assert.ok(!calls.includes('lock'));
    // onCanned recibió el canned + reason.
    const canned = calls.find(c => Array.isArray(c) && c[0] === 'canned');
    assert.ok(canned);
    assert.equal(canned[2], 'cap_exhausted');
});

// -----------------------------------------------------------------------------
// Robustez — fail-closed.
// -----------------------------------------------------------------------------
test('Robustez — decide lanza → executed:false reason decide_error, sin spawn', () => {
    let spawned = false;
    const res = executor.runInflightFallback({
        primaryProvider: 'anthropic',
        primaryErrorClass: 'transient_5xx',
        lockNamespace: 'chat-err',
        requestId: 'req-err',
        decide: () => { throw new Error('boom'); },
        runSecondary: () => { spawned = true; },
        log: () => {},
    });
    assert.equal(res.executed, false);
    assert.equal(res.reason, 'decide_error');
    assert.equal(spawned, false);
});

test('Robustez — runSecondary lanza → executed:false reason run_secondary_error', () => {
    const res = executor.runInflightFallback({
        primaryProvider: 'anthropic',
        primaryErrorClass: 'transient_5xx',
        lockNamespace: 'chat-rs',
        requestId: 'req-rs',
        decide: () => okDecision(),
        acquireLock: () => true,
        runSecondary: () => { throw new Error('spawn falló'); },
        log: () => {},
    });
    assert.equal(res.executed, false);
    assert.equal(res.reason, 'run_secondary_error');
    assert.equal(res.secondaryProvider, 'openai-codex');
});

// -----------------------------------------------------------------------------
// CA-7 — late-response lock real: tras ejecutar, el primario tardío es duplicado.
// Usa las funciones REALES del core (no inyectadas) para validar integración.
// -----------------------------------------------------------------------------
test('CA-7 — lock real adquirido: late-response del primario se reconoce duplicado', () => {
    inflight._resetInflightLocks();
    const ns = 'issue-7777';
    const requestId = 'req-late-real';
    // Antes de ejecutar: no hay lock.
    assert.equal(inflight.isLateResponseDuplicate({ chatId: ns, requestId }), false);

    const res = executor.runInflightFallback({
        skill: 'backend-dev',
        primaryProvider: 'anthropic',
        primaryErrorClass: 'timeout_no_new_bytes_30s',
        lockNamespace: ns,
        requestId,
        decide: () => okDecision(),
        // acquireLock NO inyectado → usa inflight.acquireInflightLock real.
        runSecondary: () => {},
        log: () => {},
    });
    assert.equal(res.executed, true);
    // Tras ejecutar: una respuesta tardía del primario muerto es duplicada.
    assert.equal(inflight.isLateResponseDuplicate({ chatId: ns, requestId }), true);
    inflight._resetInflightLocks();
});

// -----------------------------------------------------------------------------
// Integración real con el core: decide real (con MP fake) emite
// inflight_fallback_initiated y dispara runSecondary.
// -----------------------------------------------------------------------------
test('Integración — decide real emite initiated y ejecuta el secundario', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const os = require('node:os');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inflight-exec-'));
    fs.mkdirSync(path.join(dir, 'logs'), { recursive: true });
    try {
        // Monkey-patch del cache de multi-provider para forzar el secundario.
        const mpPath = require.resolve('../lib/commander/multi-provider');
        const original = require.cache[mpPath];
        const fakeMP = {
            resolveCommanderProviderExcluding(excluded) {
                return {
                    gated: false,
                    provider: 'openai-codex',
                    model: 'gpt-5-codex',
                    handler: { providerDef: { supports_tool_use: true } },
                    chainTried: [excluded, 'openai-codex'],
                };
            },
        };
        require.cache[mpPath] = { exports: { ...((original && original.exports) || {}), ...fakeMP } };

        let spawnedProvider = null;
        try {
            const res = executor.runInflightFallback({
                skill: 'telegram-commander',
                primaryProvider: 'anthropic',
                primaryErrorClass: 'transient_5xx',
                primaryDurationMs: 8_000,
                primaryPartialOutput: 'algo',
                attemptIndex: 0,
                pipelineDir: dir,
                lockNamespace: 'chat-int',
                requestId: 'req-int',
                runSecondary: (dec) => { spawnedProvider = dec.secondaryProvider; },
                log: () => {},
            });
            assert.equal(res.executed, true);
            assert.equal(spawnedProvider, 'openai-codex');
        } finally {
            if (original) require.cache[mpPath] = original;
            else delete require.cache[mpPath];
        }

        // El core emitió la señal de DECISIÓN inflight_fallback_initiated.
        const d = new Date();
        const f = path.join(dir, 'logs',
            `commander-dispatch-${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}.jsonl`);
        const lines = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map(JSON.parse);
        assert.ok(lines.some(e => e.event === 'inflight_fallback_initiated'), 'falta inflight_fallback_initiated');
        // CA-3: el partial NO se vuelca literal (solo hash).
        assert.ok(!fs.readFileSync(f, 'utf8').includes('algo viejo'));
    } finally {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
        inflight._resetInflightLocks();
    }
});

// -----------------------------------------------------------------------------
// CA-4 — el caller distingue decisión de ejecución: noteInflightCompleted con
// skill arbitrario emite inflight_fallback_completed con ese skill.
// -----------------------------------------------------------------------------
test('CA-4 — noteInflightCompleted acepta skill arbitrario (cross-agente)', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const os = require('node:os');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inflight-completed-'));
    fs.mkdirSync(path.join(dir, 'logs'), { recursive: true });
    try {
        const ok = inflight.noteInflightCompleted({
            pipelineDir: dir,
            skill: 'web-dev',
            primaryProvider: 'anthropic',
            secondaryProvider: 'openai-codex',
            success: true,
            chatId: 'issue-99',
            requestId: 'req-completed',
        });
        assert.equal(ok, true);
        const d = new Date();
        const f = path.join(dir, 'logs',
            `commander-dispatch-${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}.jsonl`);
        const lines = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map(JSON.parse);
        const ev = lines.find(e => e.event === 'inflight_fallback_completed');
        assert.ok(ev, 'falta inflight_fallback_completed');
        assert.equal(ev.skill, 'web-dev'); // skill del agente, NO el default commander
        assert.equal(ev.secondary_provider, 'openai-codex');
        assert.equal(ev.success, true);
    } finally {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    }
});
