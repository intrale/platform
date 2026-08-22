// =============================================================================
// __tests__/codex-health-probe.test.js — #4052 CA-2 / SEC-2.
//
// Cobertura del pre-flight health-check de Codex: forma argv shell:false,
// disable con TTL al fallar, y ausencia total de contenido del issue.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const codex = require('../providers/openai-codex');

function fakeDisabledModule() {
    const calls = [];
    return {
        calls,
        setProviderDisabled: (provider, opts) => { calls.push({ provider, opts }); return { ok: true }; },
    };
}

test('el probe usa forma argv (array) y shell:false en tier native-exe', () => {
    let captured = null;
    const spawnSyncImpl = (cmd, args, opts) => {
        captured = { cmd, args, opts };
        return { status: 0, signal: null, error: null };
    };
    const r = codex.probeCodexHealth({
        launcher: { kind: 'native-exe', cmd: 'C:/fake/codex.exe', prefixArgs: [], shell: false },
        spawnSyncImpl,
        disabledModule: fakeDisabledModule(),
    });
    assert.equal(r.ok, true);
    assert.ok(Array.isArray(captured.args), 'args debe ser un array (argv form)');
    assert.deepEqual(captured.args, ['--version']);
    assert.equal(captured.opts.shell, false);
});

test('probe fallido (status≠0) marca openai-codex disabled con TTL', () => {
    const disabled = fakeDisabledModule();
    const spawnSyncImpl = () => ({ status: 1, signal: null, error: null });
    const r = codex.probeCodexHealth({
        launcher: { kind: 'node-wrapper-js', cmd: 'node', prefixArgs: ['/bin/codex.js'], shell: false },
        spawnSyncImpl,
        disabledModule: disabled,
        ttlMs: 600000,
    });
    assert.equal(r.ok, false);
    assert.equal(r.disabled, true);
    assert.equal(disabled.calls.length, 1);
    assert.equal(disabled.calls[0].provider, 'openai-codex');
    assert.equal(disabled.calls[0].opts.ttlMs, 600000);
    assert.equal(disabled.calls[0].opts.source, 'health-probe');
});

test('probe con error de spawn (ENOENT) marca disabled', () => {
    const disabled = fakeDisabledModule();
    const spawnSyncImpl = () => ({ status: null, signal: null, error: { code: 'ENOENT' } });
    const r = codex.probeCodexHealth({
        launcher: { kind: 'native-exe', cmd: 'codex.exe', prefixArgs: [], shell: false },
        spawnSyncImpl,
        disabledModule: disabled,
    });
    assert.equal(r.ok, false);
    assert.equal(r.error, 'ENOENT');
    assert.equal(r.disabled, true);
});

test('probe exitoso NO marca disabled', () => {
    const disabled = fakeDisabledModule();
    const r = codex.probeCodexHealth({
        launcher: { kind: 'native-exe', cmd: 'codex.exe', prefixArgs: [], shell: false },
        spawnSyncImpl: () => ({ status: 0, error: null }),
        disabledModule: disabled,
    });
    assert.equal(r.ok, true);
    assert.equal(r.disabled, false);
    assert.equal(disabled.calls.length, 0);
});

test('SEC-2: el probe NO recibe contenido del issue (args 100% estáticos)', () => {
    let captured = null;
    const spawnSyncImpl = (cmd, args) => { captured = args; return { status: 0, error: null }; };
    codex.probeCodexHealth({
        launcher: { kind: 'native-exe', cmd: 'codex.exe', prefixArgs: ['p'], shell: false },
        spawnSyncImpl,
        disabledModule: fakeDisabledModule(),
    });
    // Solo prefixArgs del launcher + '--version'. Nada de prompt/issue.
    assert.deepEqual(captured, ['p', '--version']);
});
