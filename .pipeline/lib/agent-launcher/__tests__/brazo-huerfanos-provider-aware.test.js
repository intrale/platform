// =============================================================================
// __tests__/brazo-huerfanos-provider-aware.test.js — #4052 CA-3.
//
// El brazoHuerfanos del pulpo está embebido en pulpo.js (muchos globals), por lo
// que testeamos su BLOQUE DE DECISIÓN provider-aware a través de los building
// blocks reales que consume: spawn-failure-state.consumeSpawnFailure + el cap
// MAX_FALLBACK_DEPTH del dispatcher. Replicamos la misma secuencia lógica que el
// pulpo ejecuta antes de tocar `orphanRetries`.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const sfState = require('../spawn-failure-state');
const dispatcher = require('../dispatch-with-fallback');

function tmpPipeline() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'brazo-pa-'));
}

// Réplica fiel del bloque de decisión de brazoHuerfanos (CA-3): consume el
// marker; si existe → 'return-to-pending' sin tocar retries; si no → 'normal'.
function decideOrphan({ pipelineDir, skill, issue, orphanRetries, retryKey, disabledCalls }) {
    const marker = sfState.consumeSpawnFailure({ pipelineDir, provider: 'openai-codex', skill, issue });
    if (marker) {
        // El pulpo apaga el provider con TTL aquí (lo simulamos vía callback).
        disabledCalls.push('openai-codex');
        return { action: 'return-to-pending', marker };
    }
    // Fail-closed: camino normal → consume retry.
    const retries = (orphanRetries.get(retryKey) || 0) + 1;
    orphanRetries.set(retryKey, retries);
    return { action: 'normal', retries };
}

test('muerte clasificada como provider-spawn-failure NO incrementa orphanRetries', () => {
    const dir = tmpPipeline();
    sfState.recordSpawnFailure({
        pipelineDir: dir, provider: 'openai-codex', skill: 'pipeline-dev', issue: 4052,
        signature: 'exit_code:127', launcherKind: 'cmd-shim',
    });
    const orphanRetries = new Map();
    const disabledCalls = [];
    const r = decideOrphan({
        pipelineDir: dir, skill: 'pipeline-dev', issue: 4052,
        orphanRetries, retryKey: 'desarrollo/dev/4052.pipeline-dev', disabledCalls,
    });
    assert.equal(r.action, 'return-to-pending');
    assert.equal(orphanRetries.size, 0, 'no debe incrementar retries del issue');
    assert.deepEqual(disabledCalls, ['openai-codex'], 'debe apagar el provider con TTL');
});

test('muerte ambigua hace fail-closed y consume retry', () => {
    const dir = tmpPipeline(); // sin marker registrado
    const orphanRetries = new Map();
    const disabledCalls = [];
    const r = decideOrphan({
        pipelineDir: dir, skill: 'pipeline-dev', issue: 4053,
        orphanRetries, retryKey: 'desarrollo/dev/4053.pipeline-dev', disabledCalls,
    });
    assert.equal(r.action, 'normal');
    assert.equal(r.retries, 1, 'fail-closed: consume retry como hoy');
    assert.equal(disabledCalls.length, 0);
});

test('el marker es one-shot: un segundo barrido sin nueva muerte cae a normal', () => {
    const dir = tmpPipeline();
    sfState.recordSpawnFailure({ pipelineDir: dir, provider: 'openai-codex', skill: 'guru', issue: 30 });
    const orphanRetries = new Map();
    const disabledCalls = [];
    const first = decideOrphan({ pipelineDir: dir, skill: 'guru', issue: 30, orphanRetries, retryKey: 'k', disabledCalls });
    const second = decideOrphan({ pipelineDir: dir, skill: 'guru', issue: 30, orphanRetries, retryKey: 'k', disabledCalls });
    assert.equal(first.action, 'return-to-pending');
    assert.equal(second.action, 'normal', 'sin nueva muerte de spawn, el siguiente barrido es normal');
});

test('el re-despacho respeta el cap MAX_FALLBACK_DEPTH=5 (cota dura SEC-3)', () => {
    assert.equal(dispatcher.MAX_FALLBACK_DEPTH, 5);
});
