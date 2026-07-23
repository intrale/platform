// =============================================================================
// __tests__/spawn-failure-state.test.js — #4052 puente CA-1 → CA-3.
//
// Cobertura del marker persistido de spawn-failures: record/peek/consume,
// TTL, one-shot, 0o600 y fail-open.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const sfState = require('../spawn-failure-state');

function tmpPipeline() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'sf-state-'));
}

test('record + peek devuelve el marker activo', () => {
    const dir = tmpPipeline();
    const ok = sfState.recordSpawnFailure({
        pipelineDir: dir, provider: 'openai-codex', skill: 'pipeline-dev', issue: 4052,
        signature: 'exit_code:127', launcherKind: 'cmd-shim',
    });
    assert.equal(ok, true);
    const m = sfState.peekSpawnFailure({ pipelineDir: dir, provider: 'openai-codex', skill: 'pipeline-dev', issue: 4052 });
    assert.ok(m);
    assert.equal(m.signature, 'exit_code:127');
    assert.equal(m.launcher_kind, 'cmd-shim');
    assert.equal(m.issue, 4052);
});

test('consume es one-shot: la segunda consulta devuelve null', () => {
    const dir = tmpPipeline();
    sfState.recordSpawnFailure({ pipelineDir: dir, provider: 'openai-codex', skill: 'guru', issue: 10 });
    const first = sfState.consumeSpawnFailure({ pipelineDir: dir, provider: 'openai-codex', skill: 'guru', issue: 10 });
    assert.ok(first);
    const second = sfState.consumeSpawnFailure({ pipelineDir: dir, provider: 'openai-codex', skill: 'guru', issue: 10 });
    assert.equal(second, null);
});

test('marker con TTL vencido se ignora (drenado en lectura)', () => {
    const dir = tmpPipeline();
    const t0 = 1_000_000;
    sfState.recordSpawnFailure({ pipelineDir: dir, provider: 'openai-codex', skill: 'tester', issue: 20, now: t0, ttlMs: 1000 });
    // 2s después → vencido.
    const m = sfState.peekSpawnFailure({ pipelineDir: dir, provider: 'openai-codex', skill: 'tester', issue: 20, now: t0 + 2000 });
    assert.equal(m, null);
});

test('aislamiento por (provider, skill, issue): no cruza issues', () => {
    const dir = tmpPipeline();
    sfState.recordSpawnFailure({ pipelineDir: dir, provider: 'openai-codex', skill: 'guru', issue: 1 });
    const other = sfState.consumeSpawnFailure({ pipelineDir: dir, provider: 'openai-codex', skill: 'guru', issue: 2 });
    assert.equal(other, null);
    // el del issue 1 sigue ahí
    const m1 = sfState.peekSpawnFailure({ pipelineDir: dir, provider: 'openai-codex', skill: 'guru', issue: 1 });
    assert.ok(m1);
});

test('el archivo state se crea con permisos 0o600 (no en Windows)', () => {
    const dir = tmpPipeline();
    sfState.recordSpawnFailure({ pipelineDir: dir, provider: 'openai-codex', skill: 'guru', issue: 99 });
    const file = sfState.stateFile(dir);
    assert.ok(fs.existsSync(file));
    if (process.platform !== 'win32') {
        const mode = fs.statSync(file).mode & 0o777;
        assert.equal(mode, 0o600);
    }
});

test('fail-open: pipelineDir inexistente / inputs faltantes no tiran', () => {
    assert.equal(sfState.recordSpawnFailure({}), false);
    assert.equal(sfState.peekSpawnFailure({}), null);
    assert.equal(sfState.consumeSpawnFailure({}), null);
});

test('el marker NO persiste contenido del issue ni stderr crudo', () => {
    const dir = tmpPipeline();
    sfState.recordSpawnFailure({
        pipelineDir: dir, provider: 'openai-codex', skill: 'guru', issue: 7,
        signature: 'x'.repeat(500), launcherKind: 'y'.repeat(500),
    });
    const raw = fs.readFileSync(sfState.stateFile(dir), 'utf8');
    // signature/kind truncados, sin campos de prompt/stderr.
    assert.ok(!/stderr/i.test(raw));
    assert.ok(!/prompt/i.test(raw));
    const parsed = JSON.parse(raw);
    assert.ok(parsed.failures[0].signature.length <= 80);
    assert.ok(parsed.failures[0].launcher_kind.length <= 40);
});
