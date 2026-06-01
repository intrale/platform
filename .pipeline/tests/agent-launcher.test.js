// =============================================================================
// agent-launcher.test.js — Tests del dispatcher por provider (#3074 / H2).
//
// Cubre:
//   - launchAgent default a Anthropic legacy cuando agent-models.json no existe.
//   - Skills determinísticos (allowlist) → provider 'deterministic'.
//   - Fallback a Anthropic si el script determinístico no existe en disco.
//   - Provider explicito por agent-models.json (anthropic con modelo custom).
//   - Provider 'openai-codex' devuelve el handler stub (throw en buildSpawn).
//   - Validación de provider desconocido.
//   - Inyección de fsImpl/spawnImpl/execSyncImpl funciona (no toca disco/binarios).
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const { launchAgent, PROVIDERS, resolveProviderForSkill } =
    require('../lib/agent-launcher');

// -----------------------------------------------------------------------------
// Helpers — fakes inyectables compartidos por todos los tests.
// -----------------------------------------------------------------------------
function fakeFs(existingPaths, files = {}) {
    const set = new Set(existingPaths);
    return {
        existsSync: (p) => set.has(p),
        readFileSync: (p) => {
            if (files[p] !== undefined) return files[p];
            const e = new Error(`ENOENT: ${p}`);
            e.code = 'ENOENT';
            throw e;
        },
    };
}

function fakeSpawn() {
    const calls = [];
    const fake = (cmd, args, opts) => {
        const handle = { cmd, args, opts, _isFakeChild: true };
        calls.push(handle);
        return handle;
    };
    fake.calls = calls;
    return fake;
}

function fakeExecSync(out) {
    return () => out;
}

const ROOT = '/repo/platform';
const PIPELINE = path.join(ROOT, '.pipeline');

// -----------------------------------------------------------------------------
// 1. Default: sin agent-models.json → Anthropic legacy.
// -----------------------------------------------------------------------------
test('launchAgent defaultea a Anthropic con modelo legacy cuando agent-models.json no existe', () => {
    const fsi = fakeFs([]);
    const spi = fakeSpawn();
    // Inyectamos el launcher de Anthropic para tests (evita detectar binario real).
    PROVIDERS.anthropic._setLauncherForTesting({
        kind: 'test', cmd: '/test/claude', prefixArgs: ['--prefix'], shell: false,
    });

    const result = launchAgent({
        skill: 'guru',
        issue: 1234,
        args: ['-p', '--output-format', 'stream-json'],
        cwd: ROOT,
        env: { FOO: 'bar' },
        PIPELINE,
        ROOT,
        fsImpl: fsi,
        spawnImpl: spi,
    });

    assert.equal(result.provider, 'anthropic');
    assert.equal(result.model, 'claude-opus-4-7');
    assert.equal(result.source, 'fallback-no-config');
    assert.equal(result.handler, PROVIDERS.anthropic);
    assert.equal(spi.calls.length, 1);
    assert.equal(spi.calls[0].cmd, '/test/claude');
    assert.deepEqual(spi.calls[0].args, ['--prefix', '-p', '--output-format', 'stream-json']);
    assert.equal(spi.calls[0].opts.cwd, ROOT);
    assert.equal(spi.calls[0].opts.shell, false);
    assert.equal(spi.calls[0].opts.windowsHide, true);
    PROVIDERS.anthropic._resetLauncherCacheForTesting();
});

// -----------------------------------------------------------------------------
// 2. Skill determinístico con script presente.
// -----------------------------------------------------------------------------
test('launchAgent rutea a deterministic cuando el skill está en allowlist y el script existe', () => {
    const determScript = path.join(PIPELINE, 'skills-deterministicos', 'tester.js');
    const fsi = fakeFs([determScript]);
    const spi = fakeSpawn();

    const result = launchAgent({
        skill: 'tester',
        issue: 5678,
        trabajandoPath: '/work/5678.tester',
        args: [],
        cwd: ROOT,
        env: { PIPELINE_ISSUE: '5678' },
        PIPELINE,
        ROOT,
        execSyncImpl: fakeExecSync('worktree /repo/platform\nHEAD abc\n\n'),
        fsImpl: fsi,
        spawnImpl: spi,
    });

    assert.equal(result.provider, 'deterministic');
    assert.equal(result.model, null);
    assert.equal(result.source, 'deterministic-allowlist');
    assert.equal(result.handler, PROVIDERS.deterministic);
    assert.ok(result.scriptPath.endsWith(path.join('skills-deterministicos', 'tester.js')));
    assert.equal(spi.calls.length, 1);
    assert.equal(spi.calls[0].cmd, process.execPath);
    assert.deepEqual(spi.calls[0].args, [determScript, '5678', '--trabajando=/work/5678.tester']);
    // Invariante I1: shell:false SIEMPRE para determinísticos.
    assert.equal(spi.calls[0].opts.shell, false);
});

// -----------------------------------------------------------------------------
// 3. Fallback a Anthropic si el script determinístico no existe (rollout reversible).
// -----------------------------------------------------------------------------
test('launchAgent cae a Anthropic si el script determinístico fue removido (rollout reversible)', () => {
    const fsi = fakeFs([]); // ningún path existe → script no encontrado
    const spi = fakeSpawn();
    const warnings = [];
    PROVIDERS.anthropic._setLauncherForTesting({
        kind: 'test', cmd: '/test/claude', prefixArgs: [], shell: false,
    });

    const result = launchAgent({
        skill: 'build',
        issue: 9999,
        args: ['-p'],
        cwd: ROOT,
        env: {},
        PIPELINE,
        ROOT,
        execSyncImpl: fakeExecSync(''),
        fsImpl: fsi,
        spawnImpl: spi,
        onLog: (channel, msg) => warnings.push({ channel, msg }),
    });

    assert.equal(result.provider, 'anthropic');
    assert.equal(result.source, 'fallback-deterministic-script-missing');
    assert.equal(spi.calls[0].cmd, '/test/claude');
    assert.ok(
        warnings.some((w) => w.msg.includes('script determinístico no existe')),
        'esperado warning de fallback'
    );
    PROVIDERS.anthropic._resetLauncherCacheForTesting();
});

// -----------------------------------------------------------------------------
// 4. agent-models.json define provider y modelo explícitos.
// -----------------------------------------------------------------------------
test('launchAgent respeta agent-models.json cuando resuelve provider+modelo del skill', () => {
    const modelsPath = path.join(PIPELINE, 'agent-models.json');
    const fsi = fakeFs([modelsPath], {
        [modelsPath]: JSON.stringify({
            defaults: { model: 'claude-sonnet-4-5' },
            skills: {
                guru: { provider: 'anthropic', model: 'claude-opus-4-7-1m' },
            },
        }),
    });
    const spi = fakeSpawn();
    PROVIDERS.anthropic._setLauncherForTesting({
        kind: 'test', cmd: '/test/claude', prefixArgs: [], shell: false,
    });

    const result = launchAgent({
        skill: 'guru',
        issue: 1,
        args: ['-p'],
        cwd: ROOT,
        env: {},
        PIPELINE,
        ROOT,
        fsImpl: fsi,
        spawnImpl: spi,
    });

    assert.equal(result.provider, 'anthropic');
    assert.equal(result.model, 'claude-opus-4-7-1m');
    assert.equal(result.source, 'agent-models');
    PROVIDERS.anthropic._resetLauncherCacheForTesting();
});

// -----------------------------------------------------------------------------
// 5. Skill no listado en agent-models.json usa default de defaults.model.
// -----------------------------------------------------------------------------
test('launchAgent usa defaults.model cuando el skill no está listado en agent-models.json', () => {
    const modelsPath = path.join(PIPELINE, 'agent-models.json');
    const fsi = fakeFs([modelsPath], {
        [modelsPath]: JSON.stringify({
            defaults: { model: 'claude-sonnet-4-5' },
            skills: {},
        }),
    });
    const spi = fakeSpawn();
    PROVIDERS.anthropic._setLauncherForTesting({
        kind: 'test', cmd: '/test/claude', prefixArgs: [], shell: false,
    });

    const result = launchAgent({
        skill: 'po',
        issue: 1,
        args: [],
        cwd: ROOT,
        env: {},
        PIPELINE,
        ROOT,
        fsImpl: fsi,
        spawnImpl: spi,
    });

    assert.equal(result.provider, 'anthropic');
    assert.equal(result.model, 'claude-sonnet-4-5');
    assert.equal(result.source, 'fallback-skill-not-found');
    PROVIDERS.anthropic._resetLauncherCacheForTesting();
});

// -----------------------------------------------------------------------------
// 6. Provider 'openai-codex' real (post #3791): launchAgent dispara el spawn
//    del codex CLI traduciendo los args estilo Claude al shape Codex.
// -----------------------------------------------------------------------------
test('launchAgent con provider openai-codex spawnea el codex CLI con args traducidos', () => {
    const modelsPath = path.join(PIPELINE, 'agent-models.json');
    const fsi = fakeFs([modelsPath], {
        [modelsPath]: JSON.stringify({
            defaults: { model: 'claude-opus-4-7' },
            skills: {
                planner: { provider: 'openai-codex', model: 'gpt-5-codex' },
            },
        }),
    });
    const spi = fakeSpawn();

    // Forzamos un launcher determinístico para el test (evita depender de fs
    // real para detectar codex.exe / wrapper / shim).
    PROVIDERS['openai-codex']._setLauncherForTesting({
        kind: 'native-exe',
        cmd: '/fake/codex.exe',
        prefixArgs: [],
        shell: false,
    });
    try {
        launchAgent({
            skill: 'planner',
            issue: 1,
            args: ['-p', 'probe', '--system-prompt-file', '/tmp/sys.md'],
            cwd: ROOT,
            env: { CODEX_MODEL: 'gpt-5-codex' },
            PIPELINE,
            ROOT,
            fsImpl: fsi,
            spawnImpl: spi,
        });
    } finally {
        PROVIDERS['openai-codex']._resetLauncherCacheForTesting();
    }
    assert.equal(spi.calls.length, 1);
    const call = spi.calls[0];
    assert.equal(call.cmd, '/fake/codex.exe');
    assert.deepEqual(call.args.slice(0, 3), ['exec', '--json', '--skip-git-repo-check']);
    assert.ok(call.args.includes('-m'));
    assert.ok(call.args.includes('gpt-5-codex'));
    assert.ok(call.args.includes('probe'));
});

// -----------------------------------------------------------------------------
// 7. Provider desconocido en agent-models.json → error explícito.
// -----------------------------------------------------------------------------
test('launchAgent valida provider desconocido con mensaje accionable', () => {
    const modelsPath = path.join(PIPELINE, 'agent-models.json');
    const fsi = fakeFs([modelsPath], {
        [modelsPath]: JSON.stringify({
            skills: { guru: { provider: 'magic-llm' } },
        }),
    });
    assert.throws(
        () =>
            launchAgent({
                skill: 'guru',
                issue: 1,
                args: [],
                cwd: ROOT,
                env: {},
                PIPELINE,
                ROOT,
                fsImpl: fsi,
                spawnImpl: fakeSpawn(),
            }),
        /Provider desconocido "magic-llm"/
    );
});

// -----------------------------------------------------------------------------
// 8. Skill ausente o inválido tira error.
// -----------------------------------------------------------------------------
test('launchAgent rechaza skill vacío o no string', () => {
    assert.throws(
        () =>
            launchAgent({
                skill: '',
                issue: 1,
                args: [],
                cwd: ROOT,
                env: {},
                PIPELINE,
                ROOT,
                fsImpl: fakeFs([]),
                spawnImpl: fakeSpawn(),
            }),
        /skill.*requerido/i
    );
});

// -----------------------------------------------------------------------------
// 9. JSON inválido en agent-models.json → fallback con warning.
// -----------------------------------------------------------------------------
test('launchAgent maneja JSON inválido en agent-models.json sin crashear (fallback + warning)', () => {
    const modelsPath = path.join(PIPELINE, 'agent-models.json');
    const fsi = fakeFs([modelsPath], { [modelsPath]: '{ broken json' });
    const spi = fakeSpawn();
    const warnings = [];
    PROVIDERS.anthropic._setLauncherForTesting({
        kind: 'test', cmd: '/test/claude', prefixArgs: [], shell: false,
    });

    const result = launchAgent({
        skill: 'guru',
        issue: 1,
        args: [],
        cwd: ROOT,
        env: {},
        PIPELINE,
        ROOT,
        fsImpl: fsi,
        spawnImpl: spi,
        onLog: (channel, msg) => warnings.push(msg),
    });

    assert.equal(result.provider, 'anthropic');
    assert.equal(result.model, 'claude-opus-4-7');
    assert.equal(result.source, 'fallback-read-error');
    assert.ok(warnings.some((m) => m.includes('agent-models.json no se pudo parsear')));
    PROVIDERS.anthropic._resetLauncherCacheForTesting();
});

// -----------------------------------------------------------------------------
// 10. Test sanity del resolveProviderForSkill (puro, sin spawn).
// -----------------------------------------------------------------------------
test('resolveProviderForSkill: build/tester/delivery/linter siempre son deterministic', () => {
    const fsi = fakeFs([]);
    for (const skill of ['build', 'tester', 'delivery', 'linter']) {
        const r = resolveProviderForSkill(skill, { pipelineDir: PIPELINE, fsImpl: fsi });
        assert.equal(r.provider, 'deterministic', `skill ${skill} debería ser deterministic`);
        assert.equal(r.handler, PROVIDERS.deterministic);
    }
});

// -----------------------------------------------------------------------------
// 11. Cuando agent-models.json existe pero el skill es determinístico,
//     se ignora la config (allowlist hardcoded gana — invariante I4 seguridad).
// -----------------------------------------------------------------------------
test('resolveProviderForSkill: skills determinísticos ignoran agent-models.json (allowlist hardcoded)', () => {
    const modelsPath = path.join(PIPELINE, 'agent-models.json');
    const fsi = fakeFs([modelsPath], {
        [modelsPath]: JSON.stringify({
            skills: { build: { provider: 'anthropic', model: 'claude-opus-4-7' } },
        }),
    });
    const r = resolveProviderForSkill('build', { pipelineDir: PIPELINE, fsImpl: fsi });
    // build está en la allowlist → siempre deterministic, agent-models.json ignorado.
    assert.equal(r.provider, 'deterministic');
    assert.equal(r.source, 'deterministic-allowlist');
});
