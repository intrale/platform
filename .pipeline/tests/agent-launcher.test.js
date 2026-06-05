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
    // Paridad de permisos con Claude (`bypassPermissions`): codex debe correr
    // sin sandbox ni aprobaciones para no chocar con "no tengo permisos".
    assert.ok(call.args.includes('--dangerously-bypass-approvals-and-sandbox'));
    // `--system` NO existe en codex exec: el system prompt se foldea al prompt,
    // nunca se pasa como flag.
    assert.ok(!call.args.includes('--system'));
});

// -----------------------------------------------------------------------------
// 6a-bis. translateClaudeArgsToCodex: el contenido del system file se foldea
//         al INICIO del prompt (codex no tiene `--system`), y el bypass de
//         sandbox/aprobaciones está siempre presente (paridad con Claude).
// -----------------------------------------------------------------------------
test('codex foldea el system prompt al inicio del prompt y bypassa el sandbox', () => {
    const realFs = require('node:fs');
    const os = require('node:os');
    const sysFile = path.join(os.tmpdir(), `codex-sys-${process.pid}.md`);
    realFs.writeFileSync(sysFile, 'Sos el Commander. Hablá natural.', 'utf8');
    try {
        const out = PROVIDERS['openai-codex']._translateClaudeArgsToCodex(
            ['-p', 'Hola, cómo estamos?', '--system-prompt-file', sysFile],
            { CODEX_MODEL: 'gpt-5-codex' },
            '/repo/platform',
        );
        // Permisos: bypass siempre presente.
        assert.ok(out.includes('--dangerously-bypass-approvals-and-sandbox'));
        // `--system` jamás se pasa como flag.
        assert.ok(!out.includes('--system'));
        // El prompt posicional final foldea persona + mensaje.
        const prompt = out[out.length - 1];
        assert.ok(prompt.startsWith('Sos el Commander. Hablá natural.'));
        assert.ok(prompt.includes('Hola, cómo estamos?'));
    } finally {
        try { realFs.unlinkSync(sysFile); } catch {}
    }
});

// -----------------------------------------------------------------------------
// 6b. Provider 'gemini-google' real (post adapter): launchAgent dispara el
//     spawn del gemini CLI traduciendo los args estilo Claude al shape Gemini
//     (`--skip-trust -o json -m <model> -p <prompt>`).
// -----------------------------------------------------------------------------
test('launchAgent con provider gemini-google spawnea el gemini CLI con args traducidos', () => {
    const modelsPath = path.join(PIPELINE, 'agent-models.json');
    const fsi = fakeFs([modelsPath], {
        [modelsPath]: JSON.stringify({
            defaults: { model: 'claude-opus-4-7' },
            skills: {
                guru: { provider: 'gemini-google', model: 'gemini-3-flash-preview' },
            },
        }),
    });
    const spi = fakeSpawn();

    // Forzamos un launcher determinístico (evita depender de fs real para
    // detectar el bundle / shim de gemini).
    PROVIDERS['gemini-google']._setLauncherForTesting({
        kind: 'node-bundle-js',
        cmd: '/fake/node',
        prefixArgs: ['/fake/gemini.js'],
        shell: false,
    });
    try {
        launchAgent({
            skill: 'guru',
            issue: 1,
            args: ['-p', 'probe', '--system-prompt-file', '/tmp/sys.md'],
            cwd: ROOT,
            env: { GEMINI_MODEL: 'gemini-3-flash-preview' },
            PIPELINE,
            ROOT,
            fsImpl: fsi,
            spawnImpl: spi,
        });
    } finally {
        PROVIDERS['gemini-google']._resetLauncherCacheForTesting();
    }
    assert.equal(spi.calls.length, 1);
    const call = spi.calls[0];
    assert.equal(call.cmd, '/fake/node');
    // prefijo del launcher (bundle js) + args traducidos.
    assert.equal(call.args[0], '/fake/gemini.js');
    assert.ok(call.args.includes('--skip-trust'));
    assert.deepEqual(call.args.slice(1, 4), ['--skip-trust', '-o', 'json']);
    assert.ok(call.args.includes('-m'));
    assert.ok(call.args.includes('gemini-3-flash-preview'));
    assert.ok(call.args.includes('-p'));
    assert.ok(call.args.includes('probe'));
});

// -----------------------------------------------------------------------------
// 6c. parseTokensFromLog de gemini-google agrega tokens multi-modelo y el
//     detector de cuota matchea por shape estructural.
// -----------------------------------------------------------------------------
test('gemini-google parseTokensFromLog agrega tokens de todos los modelos', () => {
    const gemini = PROVIDERS['gemini-google'];
    const logPath = '/tmp/gemini.json';
    const payload = JSON.stringify({
        session_id: 'abc',
        response: 'OK',
        stats: {
            models: {
                'gemini-3.1-flash-lite': { tokens: { input: 100, candidates: 5, cached: 10, thoughts: 2 } },
                'gemini-3-flash-preview': { tokens: { input: 200, candidates: 8, cached: 0, thoughts: 0 } },
            },
        },
    });
    const fsi = { readFileSync: (p) => (p === logPath ? payload : (() => { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; })()) };
    const tokens = gemini.parseTokensFromLog(logPath, fsi);
    assert.equal(tokens.input, 300);            // 100 + 200
    assert.equal(tokens.output, 15);            // (5+2) + (8+0)
    assert.equal(tokens.cache_read, 10);        // 10 + 0
});

test('gemini-google detectQuotaExhausted matchea RESOURCE_EXHAUSTED por shape', () => {
    const gemini = PROVIDERS['gemini-google'];
    const QE = require('../lib/quota-exhausted');
    const logPath = '/tmp/gemini-err.json';
    const payload = JSON.stringify({
        error: { status: 'RESOURCE_EXHAUSTED', code: 429, message: 'quota' },
    });
    const fsi = { readFileSync: (p) => (p === logPath ? payload : (() => { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; })()) };
    const res = gemini.detectQuotaExhausted(logPath, null, QE, fsi);
    assert.equal(res.matched, true);
    assert.equal(res.errorType, 'resource_exhausted');

    // Respuesta normal (sin error) → no matchea.
    const okPayload = JSON.stringify({ response: 'OK', stats: { models: {} } });
    const fsiOk = { readFileSync: () => okPayload };
    assert.equal(gemini.detectQuotaExhausted(logPath, null, QE, fsiOk).matched, false);
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

// -----------------------------------------------------------------------------
// 12a. Provider 'nvidia-nim' real (#3791): launchAgent spawnea el runner Node
//      (node <runner.js>) traduciendo los args estilo Claude al contrato del
//      runner (`--model <id> --system-file <path> --prompt <text>`).
// -----------------------------------------------------------------------------
test('launchAgent con provider nvidia-nim spawnea el runner Node con args traducidos', () => {
    const modelsPath = path.join(PIPELINE, 'agent-models.json');
    const fsi = fakeFs([modelsPath], {
        [modelsPath]: JSON.stringify({
            skills: {
                guru: { provider: 'nvidia-nim', model: 'deepseek-ai/deepseek-v4-pro' },
            },
        }),
    });
    const spi = fakeSpawn();

    PROVIDERS['nvidia-nim']._setLauncherForTesting({
        kind: 'node-runner',
        cmd: '/fake/node',
        prefixArgs: ['/fake/nvidia-nim-runner.js'],
        shell: false,
    });
    try {
        launchAgent({
            skill: 'guru',
            issue: 1,
            args: ['-p', 'probe', '--system-prompt-file', '/tmp/sys.md', '--output-format', 'stream-json'],
            cwd: ROOT,
            env: { NVIDIA_NIM_MODEL: 'deepseek-ai/deepseek-v4-pro' },
            PIPELINE,
            ROOT,
            fsImpl: fsi,
            spawnImpl: spi,
        });
    } finally {
        PROVIDERS['nvidia-nim']._resetLauncherCacheForTesting();
    }
    assert.equal(spi.calls.length, 1);
    const call = spi.calls[0];
    assert.equal(call.cmd, '/fake/node');
    assert.equal(call.args[0], '/fake/nvidia-nim-runner.js');
    assert.ok(call.args.includes('--model'));
    assert.ok(call.args.includes('deepseek-ai/deepseek-v4-pro'));
    assert.ok(call.args.includes('--system-file'));
    assert.ok(call.args.includes('/tmp/sys.md'));
    assert.ok(call.args.includes('--prompt'));
    assert.ok(call.args.includes('probe'));
    // El flag --output-format (estilo Claude) se descarta en la traducción.
    assert.ok(!call.args.includes('--output-format'));
});

// -----------------------------------------------------------------------------
// 12b. parseTokensFromLog de nvidia-nim mapea el `usage` OpenAI al shape canónico.
// -----------------------------------------------------------------------------
test('nvidia-nim parseTokensFromLog mapea usage OpenAI (prompt/completion/cached/reasoning)', () => {
    const nvidia = PROVIDERS['nvidia-nim'];
    const logPath = '/tmp/nvidia.json';
    const payload = JSON.stringify({
        id: 'cmpl-1',
        model: 'deepseek-ai/deepseek-v4-pro',
        choices: [{ message: { role: 'assistant', content: 'OK' } }],
        usage: {
            prompt_tokens: 100,
            completion_tokens: 8,
            reasoning_tokens: 2,
            total_tokens: 110,
            prompt_tokens_details: { cached_tokens: 30 },
        },
    });
    const fsi = { readFileSync: (p) => (p === logPath ? payload : (() => { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; })()) };
    const tokens = nvidia.parseTokensFromLog(logPath, fsi);
    assert.equal(tokens.input, 100);
    assert.equal(tokens.output, 10);          // completion 8 + reasoning 2
    assert.equal(tokens.cache_read, 30);

    // prompt_tokens_details null (sin cache) no rompe.
    const noCache = JSON.stringify({ usage: { prompt_tokens: 17, completion_tokens: 2, prompt_tokens_details: null } });
    const fsi2 = { readFileSync: () => noCache };
    const t2 = nvidia.parseTokensFromLog(logPath, fsi2);
    assert.equal(t2.input, 17);
    assert.equal(t2.output, 2);
    assert.equal(t2.cache_read, 0);
});

// -----------------------------------------------------------------------------
// 12c. detectQuotaExhausted de nvidia-nim matchea por shape estructural.
// -----------------------------------------------------------------------------
test('nvidia-nim detectQuotaExhausted matchea rate_limit/insufficient_quota por shape', () => {
    const nvidia = PROVIDERS['nvidia-nim'];
    const QE = require('../lib/quota-exhausted');
    const logPath = '/tmp/nvidia-err.json';

    // 429 normalizado por el runner a code 'rate_limit_exceeded'.
    const payload = JSON.stringify({ error: { status: 429, code: 'rate_limit_exceeded', message: 'too many requests' } });
    const fsi = { readFileSync: (p) => (p === logPath ? payload : (() => { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; })()) };
    const res = nvidia.detectQuotaExhausted(logPath, null, QE, fsi);
    assert.equal(res.matched, true);
    assert.equal(res.errorType, 'rate_limit_exceeded');

    // insufficient_quota (type) también matchea.
    const payload2 = JSON.stringify({ error: { type: 'insufficient_quota', message: 'no credits' } });
    const fsi2 = { readFileSync: () => payload2 };
    assert.equal(nvidia.detectQuotaExhausted(logPath, null, QE, fsi2).errorType, 'insufficient_quota');

    // Respuesta normal (sin error) → no matchea.
    const okPayload = JSON.stringify({ choices: [{ message: { content: 'OK' } }], usage: { prompt_tokens: 1 } });
    const fsiOk = { readFileSync: () => okPayload };
    assert.equal(nvidia.detectQuotaExhausted(logPath, null, QE, fsiOk).matched, false);
});

// -----------------------------------------------------------------------------
// 13a. Provider 'cerebras' real (#3791): launchAgent spawnea el runner Node
//      (node <runner.js>) traduciendo los args estilo Claude al contrato del
//      runner (`--model <id> --system-file <path> --prompt <text>`).
// -----------------------------------------------------------------------------
test('launchAgent con provider cerebras spawnea el runner Node con args traducidos', () => {
    const modelsPath = path.join(PIPELINE, 'agent-models.json');
    const fsi = fakeFs([modelsPath], {
        [modelsPath]: JSON.stringify({
            skills: {
                guru: { provider: 'cerebras', model: 'llama-3.3-70b' },
            },
        }),
    });
    const spi = fakeSpawn();

    PROVIDERS['cerebras']._setLauncherForTesting({
        kind: 'node-runner',
        cmd: '/fake/node',
        prefixArgs: ['/fake/cerebras-runner.js'],
        shell: false,
    });
    try {
        launchAgent({
            skill: 'guru',
            issue: 1,
            args: ['-p', 'probe', '--system-prompt-file', '/tmp/sys.md', '--output-format', 'stream-json'],
            cwd: ROOT,
            env: { CEREBRAS_MODEL: 'llama-3.3-70b' },
            PIPELINE,
            ROOT,
            fsImpl: fsi,
            spawnImpl: spi,
        });
    } finally {
        PROVIDERS['cerebras']._resetLauncherCacheForTesting();
    }
    assert.equal(spi.calls.length, 1);
    const call = spi.calls[0];
    assert.equal(call.cmd, '/fake/node');
    assert.equal(call.args[0], '/fake/cerebras-runner.js');
    assert.ok(call.args.includes('--model'));
    assert.ok(call.args.includes('llama-3.3-70b'));
    assert.ok(call.args.includes('--system-file'));
    assert.ok(call.args.includes('/tmp/sys.md'));
    assert.ok(call.args.includes('--prompt'));
    assert.ok(call.args.includes('probe'));
    // El flag --output-format (estilo Claude) se descarta en la traducción.
    assert.ok(!call.args.includes('--output-format'));
});

// -----------------------------------------------------------------------------
// 13b. parseTokensFromLog de cerebras mapea el `usage` OpenAI al shape canónico.
// -----------------------------------------------------------------------------
test('cerebras parseTokensFromLog mapea usage OpenAI (prompt/completion/cached/reasoning)', () => {
    const cerebras = PROVIDERS['cerebras'];
    const logPath = '/tmp/cerebras.json';
    const payload = JSON.stringify({
        id: 'cmpl-1',
        model: 'llama-3.3-70b',
        choices: [{ message: { role: 'assistant', content: 'OK' } }],
        usage: {
            prompt_tokens: 100,
            completion_tokens: 8,
            reasoning_tokens: 2,
            total_tokens: 110,
            prompt_tokens_details: { cached_tokens: 30 },
        },
    });
    const fsi = { readFileSync: (p) => (p === logPath ? payload : (() => { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; })()) };
    const tokens = cerebras.parseTokensFromLog(logPath, fsi);
    assert.equal(tokens.input, 100);
    assert.equal(tokens.output, 10);          // completion 8 + reasoning 2
    assert.equal(tokens.cache_read, 30);

    // prompt_tokens_details null (sin cache) no rompe.
    const noCache = JSON.stringify({ usage: { prompt_tokens: 17, completion_tokens: 2, prompt_tokens_details: null } });
    const fsi2 = { readFileSync: () => noCache };
    const t2 = cerebras.parseTokensFromLog(logPath, fsi2);
    assert.equal(t2.input, 17);
    assert.equal(t2.output, 2);
    assert.equal(t2.cache_read, 0);
});

// -----------------------------------------------------------------------------
// 13c. detectQuotaExhausted de cerebras matchea por shape estructural.
// -----------------------------------------------------------------------------
test('cerebras detectQuotaExhausted matchea rate_limit/quota_exceeded por shape', () => {
    const cerebras = PROVIDERS['cerebras'];
    const QE = require('../lib/quota-exhausted');
    const logPath = '/tmp/cerebras-err.json';

    // 429 normalizado por el runner a code 'rate_limit_exceeded'.
    const payload = JSON.stringify({ error: { status: 429, code: 'rate_limit_exceeded', message: 'too many requests' } });
    const fsi = { readFileSync: (p) => (p === logPath ? payload : (() => { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; })()) };
    const res = cerebras.detectQuotaExhausted(logPath, null, QE, fsi);
    assert.equal(res.matched, true);
    assert.equal(res.errorType, 'rate_limit_exceeded');

    // quota_exceeded (type) también matchea.
    const payload2 = JSON.stringify({ error: { type: 'quota_exceeded', message: 'no credits' } });
    const fsi2 = { readFileSync: () => payload2 };
    assert.equal(cerebras.detectQuotaExhausted(logPath, null, QE, fsi2).errorType, 'quota_exceeded');

    // Respuesta normal (sin error) → no matchea.
    const okPayload = JSON.stringify({ choices: [{ message: { content: 'OK' } }], usage: { prompt_tokens: 1 } });
    const fsiOk = { readFileSync: () => okPayload };
    assert.equal(cerebras.detectQuotaExhausted(logPath, null, QE, fsiOk).matched, false);
});
