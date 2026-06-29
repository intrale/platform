// =============================================================================
// agent-launcher-mode-resolution.test.js — #4274 (CA-3 / SR-1)
//
// El launcher NO debe asumir el modo más privilegiado (`bypassPermissions`)
// cuando la resolución llega sin `mode` (caso del path de fallback antes del
// fix). Debe resolver el modo EXPLÍCITAMENTE por provider; si no se puede
// resolver (provider desconocido), hace fail-fast con mensaje accionable.
//
// Antes: `mode: resolution.mode || 'bypassPermissions'` → para openai-codex
// caía `mode_unknown` (FAIL-CLOSED). Para free providers matcheaba por
// casualidad y concedía el set autónomo sin resolver el modo (lado silencioso,
// el verdadero defecto de seguridad).
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const launcher = require('../agent-launcher');

// El launcher lee required_permissions del SKILL.md real bajo
// PIPELINE_REPO_ROOT/.claude/skills/<skill>/SKILL.md. Apuntamos al repo y
// desactivamos el cache de permisos para aislar el test.
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const PIPELINE_DIR = path.join(REPO_ROOT, '.pipeline');

function withEnv(fn) {
    const prevRoot = process.env.PIPELINE_REPO_ROOT;
    const prevNoCache = process.env.PIPELINE_PERMISSION_VALIDATOR_NO_CACHE;
    process.env.PIPELINE_REPO_ROOT = REPO_ROOT;
    process.env.PIPELINE_PERMISSION_VALIDATOR_NO_CACHE = '1';
    try { return fn(); }
    finally {
        if (prevRoot === undefined) delete process.env.PIPELINE_REPO_ROOT; else process.env.PIPELINE_REPO_ROOT = prevRoot;
        if (prevNoCache === undefined) delete process.env.PIPELINE_PERMISSION_VALIDATOR_NO_CACHE; else process.env.PIPELINE_PERMISSION_VALIDATOR_NO_CACHE = prevNoCache;
        launcher._resetPermissionsCacheForTesting();
    }
}

// Handler LLM fake: buildSpawn devuelve un spawn-def trivial.
const fakeHandler = {
    buildSpawn: () => ({ cmd: 'echo', args: ['ok'], spawnOpts: {} }),
};
const fakeSpawn = () => ({ pid: 4274, on() {}, unref() {}, stdout: { on() {} }, stderr: { on() {} } });

test('#4274 CA-3 · resolución de fallback sin `mode` para openai-codex se resuelve a full-auto (no bypassPermissions) y NO falla', () => {
    withEnv(() => {
        // Simula la resolución del dispatcher de fallback SIN mode (caso pre-fix).
        const resolveImpl = () => ({
            provider: 'openai-codex',
            model: 'gpt-5-codex',
            handler: fakeHandler,
            source: 'dispatch-fallback',
            // mode AUSENTE a propósito.
        });
        // Si el launcher defaulteara a 'bypassPermissions', validateSpawn caería
        // en mode_unknown y esto tiraría. El fix resuelve explícito → full-auto → ok.
        const result = launcher.launchAgent({
            skill: 'pipeline-dev',
            issue: 4274,
            args: [],
            cwd: REPO_ROOT,
            env: {},
            PIPELINE: PIPELINE_DIR,
            ROOT: REPO_ROOT,
            resolveImpl,
            spawnImpl: fakeSpawn,
        });
        assert.equal(result.provider, 'openai-codex');
        assert.ok(result.child, 'el spawn debe haberse ejecutado (autorizado)');
    });
});

test('#4274 CA-3 / SR-1 · provider desconocido sin `mode` hace fail-fast accionable (no asume el modo más privilegiado)', () => {
    withEnv(() => {
        const resolveImpl = () => ({
            provider: 'provider-fantasma',
            model: 'x',
            handler: fakeHandler,
            source: 'dispatch-fallback',
            // mode AUSENTE + provider sin default → debe fail-fast, NO bypassPermissions.
        });
        assert.throws(
            () => launcher.launchAgent({
                skill: 'pipeline-dev',
                issue: 4274,
                args: [],
                cwd: REPO_ROOT,
                env: {},
                PIPELINE: PIPELINE_DIR,
                ROOT: REPO_ROOT,
                resolveImpl,
                spawnImpl: fakeSpawn,
            }),
            /mode no resoluble para provider 'provider-fantasma'/
        );
    });
});
