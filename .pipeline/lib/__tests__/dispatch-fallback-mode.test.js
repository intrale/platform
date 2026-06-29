// =============================================================================
// dispatch-fallback-mode.test.js — #4274
//
// El `return` de un fallback exitoso en `resolveSpawnWithFallback` debe incluir
// el campo `mode` resuelto canónicamente por provider. Antes el fallback omitía
// `mode`; el launcher lo rellenaba con `|| 'bypassPermissions'` y, como
// `openai-codex` no tiene celda `bypassPermissions` en la matriz canónica, todo
// salto a codex caía `mode_unknown` (FAIL-CLOSED) — causa raíz del incidente
// del 26–28/06/2026.
//
// CA-2 / CA-5: codex → 'full-auto'; free providers (gemini/cerebras/nvidia) →
// 'bypassPermissions'.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const dispatch = require('../agent-launcher/dispatch-with-fallback');

// pipelineDir temporal con un agent-models.json parametrizable por su lista de
// fallbacks. Ningún provider declara `permissions_mode` → se ejercita el default
// canónico por provider de resolvePermissionMode.
function mkTmpPipelineDir(fallbacks) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fbmode-'));
    const models = {
        default_provider: 'anthropic',
        providers: {
            anthropic: { launcher: 'claude', model: 'claude-opus-4-7', credentials_env: ['ANTHROPIC_API_KEY'] },
            'openai-codex': { launcher: 'codex', model: 'gpt-5-codex', credentials_env: ['OPENAI_API_KEY'] },
            cerebras: { launcher: 'cerebras', model: 'llama-3.3-70b', credentials_env: ['CEREBRAS_API_KEY'] },
            'gemini-google': { launcher: 'gemini', model: 'gemini-2.5-pro', credentials_env: ['GEMINI_API_KEY'] },
            'nvidia-nim': { launcher: 'nvidia', model: 'deepseek-v4', credentials_env: ['NVIDIA_API_KEY'] },
        },
        skills: {
            'pipeline-dev': { provider: 'anthropic', fallbacks },
        },
    };
    fs.writeFileSync(path.join(dir, 'agent-models.json'), JSON.stringify(models, null, 2));
    fs.mkdirSync(path.join(dir, 'logs'), { recursive: true });
    return dir;
}

function cleanup(dir) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

// quotaModule fake: el primario (anthropic) siempre gateado, fallbacks libres.
function makeQuotaModule() {
    return {
        shouldGateSpawn(skill, { provider }) { return provider === 'anthropic'; },
        sanitizeRawExcerpt: (s) => String(s || ''),
    };
}

const primaryResolver = () => ({ provider: 'anthropic', model: 'claude-opus-4-7', source: 'primary' });
const providerHandlerResolver = (name) => ({ name, providerDef: { launcher: name } });
const silentNotify = () => {};

test('#4274 · fallback a openai-codex devuelve mode="full-auto" (no bypassPermissions)', () => {
    const dir = mkTmpPipelineDir([{ provider: 'openai-codex' }]);
    try {
        const r = dispatch.resolveSpawnWithFallback({
            skill: 'pipeline-dev',
            issue: 4274,
            pipelineDir: dir,
            quotaModule: makeQuotaModule(),
            primaryResolver,
            providerHandlerResolver,
            notify: silentNotify,
            processEnv: { OPENAI_API_KEY: 'real-oai-key' },
        });
        assert.equal(r.source, 'fallback');
        assert.equal(r.provider, 'openai-codex');
        // Causa raíz: el mode resuelto NO debe ser el default fail-open.
        assert.equal(r.mode, 'full-auto');
        assert.notEqual(r.mode, 'bypassPermissions');
    } finally { cleanup(dir); }
});

test('#4274 · fallback a cerebras devuelve mode="bypassPermissions" (free provider)', () => {
    const dir = mkTmpPipelineDir([{ provider: 'cerebras' }]);
    try {
        const r = dispatch.resolveSpawnWithFallback({
            skill: 'pipeline-dev',
            issue: 4274,
            pipelineDir: dir,
            quotaModule: makeQuotaModule(),
            primaryResolver,
            providerHandlerResolver,
            notify: silentNotify,
            processEnv: { CEREBRAS_API_KEY: 'real-cerebras-key' },
        });
        assert.equal(r.provider, 'cerebras');
        assert.equal(r.mode, 'bypassPermissions');
    } finally { cleanup(dir); }
});

test('#4274 · fallback a gemini-google devuelve mode="bypassPermissions"', () => {
    const dir = mkTmpPipelineDir([{ provider: 'gemini-google' }]);
    try {
        const r = dispatch.resolveSpawnWithFallback({
            skill: 'pipeline-dev',
            issue: 4274,
            pipelineDir: dir,
            quotaModule: makeQuotaModule(),
            primaryResolver,
            providerHandlerResolver,
            notify: silentNotify,
            processEnv: { GEMINI_API_KEY: 'real-gemini-key' },
        });
        assert.equal(r.provider, 'gemini-google');
        assert.equal(r.mode, 'bypassPermissions');
    } finally { cleanup(dir); }
});

test('#4274 · fallback a nvidia-nim devuelve mode="bypassPermissions"', () => {
    const dir = mkTmpPipelineDir([{ provider: 'nvidia-nim' }]);
    try {
        const r = dispatch.resolveSpawnWithFallback({
            skill: 'pipeline-dev',
            issue: 4274,
            pipelineDir: dir,
            quotaModule: makeQuotaModule(),
            primaryResolver,
            providerHandlerResolver,
            notify: silentNotify,
            processEnv: { NVIDIA_API_KEY: 'real-nvidia-key' },
        });
        assert.equal(r.provider, 'nvidia-nim');
        assert.equal(r.mode, 'bypassPermissions');
    } finally { cleanup(dir); }
});

test('#4274 · el mode resuelto del fallback codex pasa el guardrail (repro del incidente)', () => {
    // Reproducción end-to-end de la causa raíz: con el mode resuelto del
    // fallback (full-auto), validateSpawn de un skill de desarrollo en codex
    // retorna ok:true — antes, con bypassPermissions, era mode_unknown.
    const pv = require('../permission-validator');
    const dir = mkTmpPipelineDir([{ provider: 'openai-codex' }]);
    try {
        const r = dispatch.resolveSpawnWithFallback({
            skill: 'pipeline-dev',
            issue: 4274,
            pipelineDir: dir,
            quotaModule: makeQuotaModule(),
            primaryResolver,
            providerHandlerResolver,
            notify: silentNotify,
            processEnv: { OPENAI_API_KEY: 'real-oai-key' },
        });
        const required = ['file_read', 'file_write_repo', 'bash', 'child_spawn', 'tool_use_gated'];
        const validation = pv.validateSpawn({
            skill: 'pipeline-dev',
            provider: r.provider,
            mode: r.mode,
            requiredCapabilities: required,
        });
        assert.equal(validation.ok, true);
        assert.equal(validation.source, 'matrix');
    } finally { cleanup(dir); }
});
