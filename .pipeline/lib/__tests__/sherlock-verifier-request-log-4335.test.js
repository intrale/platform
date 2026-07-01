// =============================================================================
// Tests sherlock-verifier.js — sink `requestLog` opcional (#4335).
//
// Cubre:
//   - Con `requestLog` inyectado, verify() emite las etapas clave al sink
//     ('provider-resuelto' y 'veredicto') tanto en success como en aborted.
//   - Sin el param, comportamiento back-compat idéntico (no lanza; el shape del
//     resultado no cambia).
//   - SEC-3: el sink recibe SOLO strings/números en meta (nunca objetos de
//     config / process.env).
//
// Reusa el mismo harness de fakes que sherlock-verifier.test.js (sin red ni FS
// real más allá del tmp dir del audit log).
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const sherlock = require('../sherlock-verifier');

function mkTmpPipelineDir() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sherlock-reqlog-test-'));
    fs.mkdirSync(path.join(dir, 'logs'), { recursive: true });
    return dir;
}

function fakeCompletionClient(resp) {
    return { complete: async () => resp };
}

function fakeDispatcher(providerChain) {
    return {
        resolveSpawnWithFallback: ({ quotaModule, skill }) => {
            for (const p of providerChain) {
                const gated = quotaModule && quotaModule.shouldGateSpawn(skill, { provider: p.provider });
                if (!gated) {
                    return {
                        provider: p.provider, model: p.model, source: 'primary', gated: false,
                        fallbackUsed: null, primaryProvider: providerChain[0].provider,
                        chainTried: [p.provider], crossProvider: p.provider !== providerChain[0].provider,
                        depthExceeded: false,
                    };
                }
            }
            return { provider: null, model: null, gated: true, fallbackUsed: null,
                primaryProvider: providerChain[0].provider, chainTried: providerChain.map(p => p.provider),
                depthExceeded: false, source: 'all-gated' };
        },
    };
}

const fakeQuotaAllPass = () => ({ shouldGateSpawn: () => false, sanitizeRawExcerpt: (s) => String(s || '') });
const fakeResidencyOk = () => ({
    loadExclusionsOrThrow: () => ({ exclusions: [], default_policy: 'allow' }),
    filterPathsForProvider: () => ({ blocked: [], allowed: [], policy: 'allow' }),
});
const configLoader = () => () => ({ sherlock_enabled: true, sherlock_max_reelaboraciones: 1 });
const CHAIN = [{ provider: 'cerebras', model: 'llama-3.3-70b' }];

// Sink de captura: registra cada stage con su meta y expone la lista.
function makeSink() {
    const stages = [];
    return {
        stages,
        stage: (name, meta) => stages.push({ name, meta: meta || {} }),
        line: () => {},
    };
}

test('con requestLog: success-path emite provider-resuelto y veredicto', async () => {
    const dir = mkTmpPipelineDir();
    const sink = makeSink();
    const okResp = {
        ok: true,
        content: JSON.stringify({ verdict: 'ok', reason: 'consistente', inconsistencies: [] }),
        inputTokens: 10, outputTokens: 5, durationMs: 30,
    };
    const result = await sherlock.verify({
        analysis: 'ok', originalRequest: '?', systemState: 'estado',
        excludedProvider: 'anthropic', pipelineDir: dir,
        configLoader: configLoader(),
        completionClient: fakeCompletionClient(okResp),
        quotaModule: fakeQuotaAllPass(),
        dispatchModule: fakeDispatcher(CHAIN),
        residencyModule: fakeResidencyOk(),
        requestLog: sink,
    });
    assert.equal(result.verdict, 'ok');
    const names = sink.stages.map(s => s.name);
    assert.ok(names.includes('provider-resuelto'), 'debe emitir provider-resuelto');
    assert.ok(names.includes('veredicto'), 'debe emitir veredicto');

    const veredicto = sink.stages.find(s => s.name === 'veredicto');
    assert.equal(veredicto.meta.verdict, 'ok');
    assert.equal(veredicto.meta.provider, 'cerebras');
    // SEC-3: cada valor de meta es string/number/boolean, jamás un objeto.
    for (const s of sink.stages) {
        for (const v of Object.values(s.meta)) {
            assert.ok(['string', 'number', 'boolean'].includes(typeof v),
                `meta.${s.name} debe ser escalar (SEC-3), fue ${typeof v}`);
        }
    }
    fs.rmSync(dir, { recursive: true, force: true });
});

test('con requestLog: aborted-path (chain agotada) emite veredicto aborted', async () => {
    const dir = mkTmpPipelineDir();
    const sink = makeSink();
    const timeoutResp = {
        ok: false, error: { type: 'timeout', detail: 'sin respuesta' },
        provider: 'cerebras', model: 'llama-3.3-70b', durationMs: 1,
    };
    const result = await sherlock.verify({
        analysis: 'x', originalRequest: '?', systemState: '',
        excludedProvider: 'anthropic', pipelineDir: dir,
        configLoader: configLoader(),
        completionClient: fakeCompletionClient(timeoutResp),
        quotaModule: fakeQuotaAllPass(),
        dispatchModule: fakeDispatcher(CHAIN),
        residencyModule: fakeResidencyOk(),
        requestLog: sink,
    });
    assert.equal(result.verdict, 'aborted');
    const veredicto = sink.stages.filter(s => s.name === 'veredicto');
    assert.ok(veredicto.length >= 1, 'debe emitir al menos un veredicto');
    assert.equal(veredicto[veredicto.length - 1].meta.verdict, 'aborted');
    fs.rmSync(dir, { recursive: true, force: true });
});

test('sin requestLog: back-compat idéntico (no lanza, shape estable)', async () => {
    const dir = mkTmpPipelineDir();
    const okResp = {
        ok: true,
        content: JSON.stringify({ verdict: 'ok', reason: 'ok', inconsistencies: [] }),
        inputTokens: 1, outputTokens: 1, durationMs: 5,
    };
    const result = await sherlock.verify({
        analysis: 'ok', originalRequest: '?', systemState: 'estado',
        excludedProvider: 'anthropic', pipelineDir: dir,
        configLoader: configLoader(),
        completionClient: fakeCompletionClient(okResp),
        quotaModule: fakeQuotaAllPass(),
        dispatchModule: fakeDispatcher(CHAIN),
        residencyModule: fakeResidencyOk(),
        // sin requestLog
    });
    assert.equal(result.verdict, 'ok');
    assert.equal(result.sherlockProvider, 'cerebras');
    fs.rmSync(dir, { recursive: true, force: true });
});
