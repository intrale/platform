// resolve-provider — flag interactive_supported (#3605).
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { resolveProviderForSkill } = require('../agent-launcher/resolve-provider');

function withTmpPipelineDir(fn) {
    return (t) => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resolve-prov-'));
        try {
            return fn(t, dir);
        } finally {
            try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
        }
    };
}

test('default OFF: skill sin interactive_supported declarado → false', withTmpPipelineDir((t, dir) => {
    const cfg = {
        defaults: { model: 'claude-opus-4-7' },
        providers: { anthropic: { permissions_mode: 'bypassPermissions' } },
        skills: {
            guru: { provider: 'anthropic', model: 'claude-opus-4-7' },
        },
    };
    fs.writeFileSync(path.join(dir, 'agent-models.json'), JSON.stringify(cfg), 'utf8');
    const r = resolveProviderForSkill('guru', { pipelineDir: dir });
    assert.equal(r.interactive_supported, false);
}));

test('opt-in: skill con interactive_supported:true → true', withTmpPipelineDir((t, dir) => {
    const cfg = {
        defaults: { model: 'claude-opus-4-7' },
        providers: { anthropic: { permissions_mode: 'bypassPermissions' } },
        skills: {
            guru: { provider: 'anthropic', model: 'claude-opus-4-7', interactive_supported: true },
        },
    };
    fs.writeFileSync(path.join(dir, 'agent-models.json'), JSON.stringify(cfg), 'utf8');
    const r = resolveProviderForSkill('guru', { pipelineDir: dir });
    assert.equal(r.interactive_supported, true);
}));

test('valor "true" string NO cuenta como true (strict equality)', withTmpPipelineDir((t, dir) => {
    const cfg = {
        skills: {
            guru: { provider: 'anthropic', interactive_supported: 'true' },
        },
    };
    fs.writeFileSync(path.join(dir, 'agent-models.json'), JSON.stringify(cfg), 'utf8');
    const r = resolveProviderForSkill('guru', { pipelineDir: dir });
    assert.equal(r.interactive_supported, false);
}));

test('skill no-listado → interactive_supported false', withTmpPipelineDir((t, dir) => {
    const cfg = { skills: {} };
    fs.writeFileSync(path.join(dir, 'agent-models.json'), JSON.stringify(cfg), 'utf8');
    const r = resolveProviderForSkill('inexistente', { pipelineDir: dir });
    assert.equal(r.interactive_supported, false);
}));

test('config ausente → fallback con interactive_supported false', () => {
    const r = resolveProviderForSkill('guru', { pipelineDir: '/path/inexistente' });
    assert.equal(r.interactive_supported, false);
});

test('skill determinístico con interactive_supported:true → propagado', withTmpPipelineDir((t, dir) => {
    const cfg = {
        skills: {
            // build es deterministic; podemos declarar el flag y resolveProvider lo respeta.
            build: { interactive_supported: true },
        },
    };
    fs.writeFileSync(path.join(dir, 'agent-models.json'), JSON.stringify(cfg), 'utf8');
    const r = resolveProviderForSkill('build', { pipelineDir: dir });
    assert.equal(r.provider, 'deterministic');
    assert.equal(r.interactive_supported, true);
}));

test('skill determinístico sin flag → false', withTmpPipelineDir((t, dir) => {
    fs.writeFileSync(path.join(dir, 'agent-models.json'), JSON.stringify({ skills: {} }), 'utf8');
    const r = resolveProviderForSkill('build', { pipelineDir: dir });
    assert.equal(r.provider, 'deterministic');
    assert.equal(r.interactive_supported, false);
}));
