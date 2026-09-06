// =============================================================================
// model-propagation.test.js — #6272 (split de #6270)
//
// "Propagar el modelo resuelto al proceso hijo en los cinco proveedores."
//
// Cubre los 7 criterios de aceptación del issue:
//   CA-1 — flag ON en Anthropic ⇒ `--model <id>` como ELEMENTO SEPARADO del array.
//   CA-2 — flag ON ⇒ CODEX_MODEL / GEMINI_MODEL / CEREBRAS_MODEL / NVIDIA_NIM_MODEL
//          llegan al env del hijo con el modelo del proveedor ACTIVO de la cadena.
//   CA-3 — id fuera de la whitelist ⇒ se OMITE, deja traza y NO aborta el spawn.
//   CA-4 — flag apagado (default) ⇒ el objeto que recibe `child_process.spawn`
//          es byte-idéntico al actual (regresión cero).
//   CA-5 — dry-run ⇒ queda logueado el modelo que se habría pasado, sin alterar
//          el comando.
//   CA-6 — id declarado inválido ⇒ error de CONFIGURACIÓN antes del spawn (no
//          muerte del agente).
//   CA-7 — guardrail anti-regresión: falla si un provider handler no propaga.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const { launchAgent, PROVIDERS } = require('../lib/agent-launcher');
const { PROVIDER_HANDLERS } = require('../lib/agent-launcher/resolve-provider');
const mp = require('../lib/model-propagation');
const { PROVIDER_MODEL_ENV } = require('../lib/build-child-env');
const { ALLOWED_MODELS_BY_LAUNCHER } = require('../lib/agent-models-validate');

// -----------------------------------------------------------------------------
// Harness — fakes inyectables (mismo estilo que tests/agent-launcher.test.js).
// -----------------------------------------------------------------------------
const ROOT = '/repo/platform';
const PIPELINE = path.join(ROOT, '.pipeline');
const MODELS_PATH = path.join(PIPELINE, 'agent-models.json');

function fakeFs(files = {}) {
    return {
        existsSync: (p) => Object.prototype.hasOwnProperty.call(files, p),
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
        const stdin = { write: () => true, end: () => {} };
        const handle = { cmd, args, opts, stdin, _isFakeChild: true };
        calls.push(handle);
        return handle;
    };
    fake.calls = calls;
    return fake;
}

function collectLogs() {
    const lines = [];
    const fn = (canal, msg) => lines.push(`${canal} ${msg}`);
    fn.lines = lines;
    fn.joined = () => lines.join('\n');
    return fn;
}

// agent-models.json mínimo pero con la MISMA forma que el real: `providers.<p>`
// con `launcher` (necesario para el cruce contra ALLOWED_MODELS_BY_LAUNCHER) y
// `skills.<s>` con provider + model.
function agentModels({ skill = 'guru', provider = 'anthropic', model = 'claude-sonnet-4-6' } = {}) {
    return JSON.stringify({
        defaults: { model: 'claude-opus-4-7' },
        providers: {
            anthropic: { launcher: 'claude', model: 'claude-opus-4-7', permissions_mode: 'bypassPermissions' },
            'openai-codex': { launcher: 'codex', model: 'gpt-5.5', permissions_mode: 'bypassPermissions' },
            'gemini-google': { launcher: 'gemini-google', model: 'gemini-3-flash-preview', permissions_mode: 'bypassPermissions' },
            cerebras: { launcher: 'cerebras', model: 'gpt-oss-120b', permissions_mode: 'bypassPermissions' },
            'nvidia-nim': { launcher: 'nvidia-nim', model: 'deepseek-ai/deepseek-v4-flash-0731', permissions_mode: 'bypassPermissions' },
            'kimi-moonshot': { launcher: 'claude', model: 'kimi-k2-6', permissions_mode: 'bypassPermissions' },
            deterministic: { launcher: 'node', model: 'deterministic' },
        },
        skills: { [skill]: { provider, model } },
    });
}

function cfg(modelPropagation) {
    return { pipeline: { model_propagation: modelPropagation } };
}

// Launcher de test para cada provider (evita tocar binarios reales del disco).
const TEST_LAUNCHERS = {
    anthropic: { kind: 'test', cmd: '/test/claude', prefixArgs: ['--pre'], shell: false },
    'kimi-moonshot': { kind: 'test', cmd: '/test/claude', prefixArgs: ['--pre'], shell: false },
    'openai-codex': { kind: 'test', cmd: '/test/codex', prefixArgs: [], shell: false },
    'gemini-google': { kind: 'test', cmd: '/test/agy', prefixArgs: [], shell: false },
    cerebras: { kind: 'test', cmd: '/test/node', prefixArgs: ['/test/cerebras-runner.js'], shell: false },
    'nvidia-nim': { kind: 'test', cmd: '/test/node', prefixArgs: ['/test/nvidia-runner.js'], shell: false },
};

function withTestLaunchers(fn) {
    const touched = [];
    for (const [name, launcher] of Object.entries(TEST_LAUNCHERS)) {
        const h = PROVIDER_HANDLERS[name];
        if (h && typeof h._setLauncherForTesting === 'function') {
            h._setLauncherForTesting(launcher);
            touched.push(h);
        }
    }
    try {
        return fn();
    } finally {
        for (const h of touched) h._resetLauncherCacheForTesting();
    }
}

const BASE_ARGS = ['-p', 'prompt', '--system-prompt-file', '/tmp/sys.md', '--output-format', 'stream-json'];

function launch({ skill = 'guru', provider = 'anthropic', model = 'claude-sonnet-4-6',
                  config, env = { FOO: 'bar' }, resolveImpl } = {}) {
    const spi = fakeSpawn();
    const onLog = collectLogs();
    const result = withTestLaunchers(() => launchAgent({
        skill,
        issue: 6272,
        args: BASE_ARGS.slice(),
        cwd: ROOT,
        env,
        PIPELINE,
        ROOT,
        config,
        onLog,
        resolveImpl,
        fsImpl: fakeFs({ [MODELS_PATH]: agentModels({ skill, provider, model }) }),
        spawnImpl: spi,
    }));
    return { result, spawnCall: spi.calls[0], logs: onLog, spawnCalls: spi.calls };
}

// =============================================================================
// Unidad — política pura (`lib/model-propagation.js`)
// =============================================================================

test('resolveMode: sin sección de config el modo es off (kill-switch)', () => {
    assert.deepEqual(mp.resolveMode({ config: undefined, provider: 'anthropic', skill: 'guru' }),
        { mode: 'off', source: 'kill-switch' });
    assert.deepEqual(mp.resolveMode({ config: {}, provider: 'anthropic', skill: 'guru' }),
        { mode: 'off', source: 'kill-switch' });
});

test('resolveMode: enabled=false apaga todo aunque haya granularidades encendidas', () => {
    const c = cfg({ enabled: false, default_mode: 'on', by_provider: { anthropic: 'on' }, by_skill: { guru: 'on' } });
    assert.deepEqual(mp.resolveMode({ config: c, provider: 'anthropic', skill: 'guru' }),
        { mode: 'off', source: 'kill-switch' });
});

test('resolveMode: precedencia by_skill > by_provider > default_mode', () => {
    const c = cfg({ enabled: true, default_mode: 'off', by_provider: { anthropic: 'dry-run' }, by_skill: { guru: 'on' } });
    assert.deepEqual(mp.resolveMode({ config: c, provider: 'anthropic', skill: 'guru' }),
        { mode: 'on', source: 'skill' });
    // Otro actor del mismo proveedor: cae al nivel provider.
    assert.deepEqual(mp.resolveMode({ config: c, provider: 'anthropic', skill: 'po' }),
        { mode: 'dry-run', source: 'provider' });
    // Otro proveedor sin entrada propia: cae al default.
    assert.deepEqual(mp.resolveMode({ config: c, provider: 'cerebras', skill: 'po' }),
        { mode: 'off', source: 'default' });
});

test('resolveMode: un modo con typo se IGNORA y cae al siguiente nivel (nunca enciende)', () => {
    const c = cfg({ enabled: true, default_mode: 'off', by_skill: { guru: 'ON!' }, by_provider: { anthropic: 'dryrun' } });
    assert.deepEqual(mp.resolveMode({ config: c, provider: 'anthropic', skill: 'guru' }),
        { mode: 'off', source: 'default' });
});

test('sanitizeModelId: orden typeof → longitud → whitelist con razones tipadas', () => {
    assert.deepEqual(mp.sanitizeModelId(undefined), { model: null, reason: 'not_a_string' });
    assert.deepEqual(mp.sanitizeModelId(123), { model: null, reason: 'not_a_string' });
    assert.deepEqual(mp.sanitizeModelId(''), { model: null, reason: 'length_out_of_range' });
    assert.deepEqual(mp.sanitizeModelId('x'.repeat(mp.MODEL_MAX_LEN + 1)), { model: null, reason: 'length_out_of_range' });
    assert.deepEqual(mp.sanitizeModelId('claude-sonnet-4-6'), { model: 'claude-sonnet-4-6', reason: 'ok' });
});

test('sanitizeModelId: rechaza metacaracteres de shell en ambos canales', () => {
    const vectores = [
        'claude && calc.exe',
        'claude | whoami',
        'claude & echo x',
        'claude"; rm -rf /',
        'claude$(id)',
        'claude`id`',
        'claude\nsegunda-linea',
        'claude %PATH%',
        'claude > out.txt',
        'claude^x',
    ];
    for (const v of vectores) {
        assert.equal(mp.sanitizeModelId(v).model, null, `arg debería rechazar: ${JSON.stringify(v)}`);
        assert.equal(mp.sanitizeModelId(v, { channel: 'env' }).model, null, `env debería rechazar: ${JSON.stringify(v)}`);
    }
});

test('sanitizeModelId: el canal env acepta ids namespaced de NVIDIA; el canal arg (default) no', () => {
    const id = 'deepseek-ai/deepseek-v4-flash-0731';
    assert.deepEqual(mp.sanitizeModelId(id, { channel: 'env' }), { model: id, reason: 'ok' });
    // Default = canal más estricto (fail-safe si el caller olvida declararlo).
    assert.deepEqual(mp.sanitizeModelId(id), { model: null, reason: 'failed_whitelist' });
    assert.deepEqual(mp.sanitizeModelId(id, { channel: 'arg' }), { model: null, reason: 'failed_whitelist' });
});

test('resolveTarget: canal argv para el launcher claude, env para el resto, none para deterministic', () => {
    assert.deepEqual(mp.resolveTarget('anthropic'), { kind: 'arg', envVar: null });
    assert.deepEqual(mp.resolveTarget('kimi-moonshot'), { kind: 'arg', envVar: null });
    assert.deepEqual(mp.resolveTarget('openai-codex'), { kind: 'env', envVar: 'CODEX_MODEL' });
    assert.deepEqual(mp.resolveTarget('gemini-google'), { kind: 'env', envVar: 'GEMINI_MODEL' });
    assert.deepEqual(mp.resolveTarget('cerebras'), { kind: 'env', envVar: 'CEREBRAS_MODEL' });
    assert.deepEqual(mp.resolveTarget('nvidia-nim'), { kind: 'env', envVar: 'NVIDIA_NIM_MODEL' });
    assert.deepEqual(mp.resolveTarget('deterministic'), { kind: 'none', envVar: null });
    assert.deepEqual(mp.resolveTarget('provider-inventado'), { kind: 'none', envVar: null });
});

test('la traza de un id rechazado NO imprime el valor crudo (anti-leak)', () => {
    const secreto = 'sk-ant-api03-AAAABBBBCCCCDDDD';
    const d = mp.plan({
        provider: 'anthropic',
        skill: 'guru',
        model: `${secreto} && calc`,
        config: cfg({ enabled: true, default_mode: 'on' }),
    });
    assert.equal(d.apply, false);
    assert.equal(d.rejectedReason, 'failed_whitelist');
    assert.ok(!d.trace.includes(`${secreto} && calc`), 'la traza no debe contener el valor crudo');
    assert.ok(d.trace.includes('failed_whitelist'), 'la traza debe traer la razón tipada');
});

// =============================================================================
// CA-4 — Regresión cero con el flag apagado (default).
// =============================================================================

test('CA-4: con el flag apagado el objeto que recibe spawn es idéntico al legacy', () => {
    // Baseline explícito: es exactamente lo que producía el código antes de #6272.
    const esperado = {
        cmd: '/test/claude',
        args: ['--pre', ...BASE_ARGS],
        opts: {
            cwd: ROOT,
            stdio: ['ignore', 'pipe', 'pipe'],
            detached: false,
            shell: false,
            windowsHide: true,
            env: { FOO: 'bar' },
        },
    };

    for (const config of [undefined, {}, cfg({ enabled: false, default_mode: 'on', by_skill: { guru: 'on' } })]) {
        const { spawnCall, logs, result } = launch({ config });
        assert.equal(spawnCall.cmd, esperado.cmd);
        assert.deepEqual(spawnCall.args, esperado.args, 'los args no deben cambiar con el flag apagado');
        assert.deepEqual(spawnCall.opts, esperado.opts, 'los spawnOpts no deben cambiar con el flag apagado');
        assert.equal(result.modelPropagation.mode, 'off');
        assert.equal(result.modelPropagation.apply, false);
        assert.equal(result.modelPropagation.trace, null, 'con el flag apagado no se emite traza (cero ruido)');
        assert.ok(!logs.joined().includes('--model'), 'con el flag apagado no se loguea nada de propagación');
    }
});

test('CA-4: con el flag apagado el env del hijo es el MISMO objeto (sin copia ni claves nuevas)', () => {
    const env = { FOO: 'bar' };
    const { spawnCall } = launch({ config: undefined, env });
    assert.equal(spawnCall.opts.env, env, 'no debe copiarse ni mutarse el env cuando la propagación está apagada');
    assert.deepEqual(Object.keys(spawnCall.opts.env), ['FOO']);
});

// =============================================================================
// CA-1 — Anthropic recibe `--model` como elemento separado del array.
// =============================================================================

test('CA-1: con el flag encendido para Anthropic, --model viaja como dos elementos separados', () => {
    const { spawnCall, result } = launch({
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        config: cfg({ enabled: true, by_provider: { anthropic: 'on' } }),
    });

    assert.deepEqual(spawnCall.args, ['--pre', '--model', 'claude-sonnet-4-6', ...BASE_ARGS]);

    // El punto del CA: DOS elementos, no uno interpolado. Con shell:true un
    // "--model claude-sonnet-4-6" en un solo string sería otra historia.
    const i = spawnCall.args.indexOf('--model');
    assert.ok(i >= 0, 'debe existir el flag --model');
    assert.equal(spawnCall.args[i + 1], 'claude-sonnet-4-6');
    assert.ok(!spawnCall.args.some((a) => /^--model\s/.test(a)), 'nunca interpolado en un solo argumento');

    assert.equal(result.modelPropagation.apply, true);
    assert.equal(result.modelPropagation.target, 'arg');
    assert.equal(result.modelPropagation.model, 'claude-sonnet-4-6');
});

test('CA-1: kimi-moonshot reusa el buildSpawn de Anthropic y también recibe --model', () => {
    const { spawnCall } = launch({
        provider: 'kimi-moonshot',
        model: 'kimi-k2-6',
        config: cfg({ enabled: true, default_mode: 'on' }),
    });
    assert.deepEqual(spawnCall.args, ['--pre', '--model', 'kimi-k2-6', ...BASE_ARGS]);
});

test('CA-1: el flag encendido no altera el env del hijo en el canal argv', () => {
    const { spawnCall } = launch({
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        config: cfg({ enabled: true, default_mode: 'on' }),
    });
    assert.deepEqual(spawnCall.opts.env, { FOO: 'bar' });
});

// =============================================================================
// CA-2 — Los cuatro providers no-Anthropic reciben el modelo por env.
// =============================================================================

const CASOS_ENV = [
    { provider: 'openai-codex', envVar: 'CODEX_MODEL', model: 'gpt-5.4' },
    { provider: 'gemini-google', envVar: 'GEMINI_MODEL', model: 'gemini-2.5-flash' },
    { provider: 'cerebras', envVar: 'CEREBRAS_MODEL', model: 'zai-glm-4.7' },
    { provider: 'nvidia-nim', envVar: 'NVIDIA_NIM_MODEL', model: 'moonshotai/kimi-k2-instruct' },
];

for (const caso of CASOS_ENV) {
    test(`CA-2: ${caso.provider} recibe ${caso.envVar} en el env del proceso hijo`, () => {
        const { spawnCall, result } = launch({
            provider: caso.provider,
            model: caso.model,
            config: cfg({ enabled: true, default_mode: 'on' }),
        });
        assert.equal(result.modelPropagation.apply, true);
        assert.equal(result.modelPropagation.target, 'env');
        assert.equal(result.modelPropagation.envVar, caso.envVar);
        assert.equal(spawnCall.opts.env[caso.envVar], caso.model,
            `el env del hijo debe traer ${caso.envVar}=${caso.model}`);
        // El env preexistente sigue intacto (copia superficial, no reemplazo).
        assert.equal(spawnCall.opts.env.FOO, 'bar');
        // El canal env NO agrega --model desde el launcher: lo agrega el propio
        // handler traduciendo desde la env (que es como ya funcionaba).
        assert.ok(!spawnCall.args.includes('--model')
            || spawnCall.args[spawnCall.args.indexOf('--model') + 1] === caso.model);
    });
}

test('CA-2: el env se COPIA, no se muta — el objeto del caller queda intacto', () => {
    const env = { FOO: 'bar' };
    const { spawnCall } = launch({
        provider: 'cerebras',
        model: 'gpt-oss-120b',
        env,
        config: cfg({ enabled: true, default_mode: 'on' }),
    });
    assert.equal(spawnCall.opts.env.CEREBRAS_MODEL, 'gpt-oss-120b');
    assert.equal(env.CEREBRAS_MODEL, undefined, 'el env del caller no debe mutarse');
});

test('CA-2 (2º Gherkin): en caída a un proveedor de respaldo viaja el modelo del RESPALDO, no el del primario', () => {
    // El pulpo inyecta un `resolveImpl` con la resolución del dispatcher cuando
    // eligió un fallback. Acá simulamos exactamente eso: el skill declara
    // anthropic/claude-sonnet-4-6 en agent-models.json, pero el despacho efectivo
    // es openai-codex/gpt-5.4.
    const { spawnCall, result } = launch({
        skill: 'guru',
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        config: cfg({ enabled: true, default_mode: 'on' }),
        resolveImpl: () => ({
            provider: 'openai-codex',
            model: 'gpt-5.4',
            handler: PROVIDER_HANDLERS['openai-codex'],
            mode: 'bypassPermissions',
            source: 'dispatch-fallback',
        }),
    });

    assert.equal(result.provider, 'openai-codex');
    assert.equal(spawnCall.opts.env.CODEX_MODEL, 'gpt-5.4', 'debe viajar el modelo del respaldo');
    assert.equal(spawnCall.opts.env.ANTHROPIC_MODEL, undefined);
    assert.ok(!spawnCall.args.includes('claude-sonnet-4-6'),
        'el modelo del proveedor primario no debe aparecer por ningún canal');
    assert.ok(!JSON.stringify(spawnCall.opts.env).includes('claude-sonnet-4-6'),
        'el modelo del proveedor primario no debe filtrarse al env del hijo');
});

// =============================================================================
// CA-3 — Id fuera de la whitelist: se omite, deja traza, NO aborta.
// =============================================================================

test('CA-3: un id con metacaracteres omite el flag, deja traza y el agente arranca igual', () => {
    const { spawnCall, logs, result, spawnCalls } = launch({
        provider: 'anthropic',
        model: 'claude-sonnet-4-6 && calc.exe',
        config: cfg({ enabled: true, default_mode: 'on' }),
    });

    // El spawn OCURRIÓ (no se aborta).
    assert.equal(spawnCalls.length, 1);
    // El flag se OMITIÓ: args idénticos al legacy.
    assert.deepEqual(spawnCall.args, ['--pre', ...BASE_ARGS]);
    assert.ok(!spawnCall.args.includes('--model'));
    assert.ok(!spawnCall.args.includes('calc.exe'));

    assert.equal(result.modelPropagation.apply, false);
    assert.equal(result.modelPropagation.rejectedReason, 'failed_whitelist');

    // La traza tiene que decir las cuatro cosas: id, actor/proveedor, razón
    // tipada y CONSECUENCIA (guideline de UX de operador del issue).
    const log = logs.joined();
    assert.ok(log.includes('failed_whitelist'), 'razón tipada en el log');
    assert.ok(log.includes('guru@anthropic'), 'actor + proveedor en el log');
    assert.ok(/hered/i.test(log), 'la traza debe decir que se hereda el default del CLI');
    assert.ok(/NO se aborta/i.test(log), 'la traza debe decir que el spawn no se aborta');
});

test('CA-3: un modelo ausente (null) tampoco rompe — se omite con razón tipada', () => {
    // Caso real: el fallback `deterministic → anthropic` por script faltante
    // arrastra `model: resolution.model || null`, así que el launcher puede
    // llegar acá con null. No debe romper ni propagar nada.
    const { spawnCall, result, spawnCalls } = launch({
        provider: 'anthropic',
        config: cfg({ enabled: true, default_mode: 'on' }),
        resolveImpl: () => ({
            provider: 'anthropic',
            model: null,
            handler: PROVIDER_HANDLERS.anthropic,
            mode: 'bypassPermissions',
            source: 'fallback-deterministic-script-missing',
        }),
    });
    assert.equal(spawnCalls.length, 1);
    assert.deepEqual(spawnCall.args, ['--pre', ...BASE_ARGS]);
    assert.equal(result.modelPropagation.apply, false);
    assert.equal(result.modelPropagation.rejectedReason, 'not_a_string');
});

test('CA-3: buildSpawn de Anthropic revalida por su cuenta (defensa en profundidad)', () => {
    // El launcher ya valida antes, pero el handler es la última frontera antes
    // de argv y no confía en su caller.
    PROVIDERS.anthropic._setLauncherForTesting(TEST_LAUNCHERS.anthropic);
    try {
        const malo = PROVIDERS.anthropic.buildSpawn({
            args: ['-p'], cwd: ROOT, env: {}, model: 'modelo; rm -rf /',
        });
        assert.deepEqual(malo.args, ['--pre', '-p'], 'el id inválido no llega a argv');
        assert.deepEqual(malo.modelTrace, { applied: false, model: null, reason: 'failed_whitelist' });

        const bueno = PROVIDERS.anthropic.buildSpawn({
            args: ['-p'], cwd: ROOT, env: {}, model: 'claude-haiku-4-5',
        });
        assert.deepEqual(bueno.args, ['--pre', '--model', 'claude-haiku-4-5', '-p']);
        assert.deepEqual(bueno.modelTrace, { applied: true, model: 'claude-haiku-4-5', reason: 'ok' });

        // Sin `model` no aparece siquiera la clave `modelTrace` (CA-4).
        const legacy = PROVIDERS.anthropic.buildSpawn({ args: ['-p'], cwd: ROOT, env: {} });
        assert.ok(!('modelTrace' in legacy), 'el camino legacy no agrega claves al spawnDef');
    } finally {
        PROVIDERS.anthropic._resetLauncherCacheForTesting();
    }
});

// =============================================================================
// CA-5 — Dry-run: loguea lo que se habría pasado, sin alterar el comando.
// =============================================================================

test('CA-5: en dry-run el comando es idéntico al de flag apagado y queda la traza', () => {
    const apagado = launch({ provider: 'anthropic', model: 'claude-sonnet-4-6', config: undefined });
    const dryRun = launch({
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        config: cfg({ enabled: true, default_mode: 'dry-run' }),
    });

    assert.deepEqual(dryRun.spawnCall.args, apagado.spawnCall.args, 'dry-run no altera los args');
    assert.deepEqual(dryRun.spawnCall.opts, apagado.spawnCall.opts, 'dry-run no altera los spawnOpts');
    assert.equal(dryRun.result.modelPropagation.apply, false);
    assert.equal(dryRun.result.modelPropagation.mode, 'dry-run');

    const log = dryRun.logs.joined();
    assert.ok(log.includes('[dry-run]'), 'el log de dry-run debe ser distinguible de un vistazo');
    assert.ok(log.includes('claude-sonnet-4-6'), 'debe constar el modelo que SE HABRÍA pasado');
    assert.ok(log.includes('--model'), 'debe constar el canal por el que habría viajado');
    assert.ok(/sin alterar/i.test(log), 'debe decir explícitamente que el comando no se alteró');
});

test('CA-5: en dry-run sobre un provider de env se nombra la variable que se habría seteado', () => {
    const { spawnCall, logs } = launch({
        provider: 'cerebras',
        model: 'gpt-oss-120b',
        config: cfg({ enabled: true, default_mode: 'dry-run' }),
    });
    assert.equal(spawnCall.opts.env.CEREBRAS_MODEL, undefined, 'dry-run no setea la env');
    const log = logs.joined();
    assert.ok(log.includes('[dry-run]'));
    assert.ok(log.includes('CEREBRAS_MODEL'), 'debe nombrar la variable del canal');
    assert.ok(log.includes('gpt-oss-120b'));
});

// =============================================================================
// CA-6 — Id declarado inválido = error de configuración, no muerte del agente.
// =============================================================================

test('CA-6: un id fuera de ALLOWED_MODELS_BY_LAUNCHER se reporta como error de configuración y NO mata al agente', () => {
    // `claude-sonnet-4-7` pasa la whitelist (forma válida) pero NO existe en el
    // catálogo del launcher `claude` — es justo el typo histórico que rompió ~12
    // skills. Tiene que reportarse ANTES del spawn, sin abortarlo.
    const { spawnCall, logs, result, spawnCalls } = launch({
        provider: 'anthropic',
        model: 'claude-sonnet-4-7',
        config: cfg({ enabled: true, default_mode: 'on' }),
    });

    assert.equal(spawnCalls.length, 1, 'el agente arranca igual: no es una muerte, es un error de config');
    assert.deepEqual(spawnCall.args, ['--pre', ...BASE_ARGS], 'no se propaga un id fuera del catálogo');
    assert.equal(result.modelPropagation.apply, false);
    assert.ok(result.modelPropagation.configError, 'debe reportarse un configError');

    const log = logs.joined();
    assert.ok(/ERROR DE CONFIGURACI/i.test(log), 'debe reportarse como error de configuración');
    assert.ok(log.includes('claude-sonnet-4-7'));
    assert.ok(log.includes('ALLOWED_MODELS_BY_LAUNCHER'), 'debe nombrar la tabla a corregir');
    // Guideline de UX: enumerar las alternativas convierte el error en un fix de
    // un renglón (mismo formato que agent-models-validate.js).
    for (const valido of ALLOWED_MODELS_BY_LAUNCHER.claude) {
        assert.ok(log.includes(valido), `el mensaje debe enumerar los válidos (falta ${valido})`);
    }
});

test('CA-6: el cruce es por LAUNCHER, no por provider — kimi-moonshot valida contra la lista de `claude`', () => {
    // `kimi-k2-6` NO es un modelo de Anthropic, pero SÍ está en la allowlist del
    // launcher `claude` (kimi-moonshot reusa ese launcher). Usar el catálogo
    // indexado por provider lo rechazaría por error.
    const ok = mp.validateDeclaredModel({
        model: 'kimi-k2-6',
        provider: 'kimi-moonshot',
        agentModels: JSON.parse(agentModels()),
    });
    assert.equal(ok.ok, true, 'kimi-k2-6 es válido para el launcher claude');

    const malo = mp.validateDeclaredModel({
        model: 'kimi-k2-9000',
        provider: 'kimi-moonshot',
        agentModels: JSON.parse(agentModels()),
    });
    assert.equal(malo.ok, false);
    assert.ok(malo.error.includes('claude'), 'el mensaje debe nombrar el launcher, no el provider');
});

test('CA-6: sin launcher determinable (o launcher sin allowlist) no se inventa un rechazo', () => {
    assert.equal(mp.validateDeclaredModel({ model: 'lo-que-sea', provider: 'desconocido', agentModels: {} }).ok, true);
    assert.equal(mp.validateDeclaredModel({
        model: 'mi-script', provider: 'deterministic', agentModels: JSON.parse(agentModels()),
    }).ok, true, 'launcher `node` no tiene allowlist: cualquier alias es válido');
});

// =============================================================================
// Resiliencia — la política corre en el camino crítico de TODO spawn.
// =============================================================================

test('el catálogo se lee de forma perezosa: con el flag apagado el thunk NO se invoca', () => {
    let veces = 0;
    const d = mp.plan({
        provider: 'anthropic',
        skill: 'guru',
        model: 'claude-sonnet-4-6',
        config: undefined,
        agentModels: () => { veces++; return {}; },
    });
    assert.equal(d.mode, 'off');
    assert.equal(veces, 0, 'no se debe pagar la lectura de agent-models.json en cada spawn');
});

test('un thunk de catálogo que TIRA no rompe la decisión (fail-safe: no valida, no aborta)', () => {
    const d = mp.plan({
        provider: 'anthropic',
        skill: 'guru',
        model: 'claude-sonnet-4-6',
        config: cfg({ enabled: true, default_mode: 'on' }),
        agentModels: () => { throw new Error('disco explotó'); },
    });
    assert.equal(d.apply, true, 'sin catálogo legible se propaga igual: el valor ya pasó la whitelist');
    assert.equal(d.configError, null);
});

test('validateDeclaredModel acepta thunk además de objeto', () => {
    const r = mp.validateDeclaredModel({
        model: 'claude-sonnet-4-7',
        provider: 'anthropic',
        agentModels: () => JSON.parse(agentModels()),
    });
    assert.equal(r.ok, false, 'el thunk debe resolverse igual que el objeto');
});

// =============================================================================
// CA-7 — Guardrail anti-regresión.
//
// Falla si un provider handler nuevo (o modificado) no propaga el modelo. Se
// enumera la tabla REAL de handlers del pipeline, así que agregar un provider
// sin darle canal de modelo rompe este test, no producción.
// =============================================================================

const PROVIDERS_LLM = Object.keys(PROVIDER_HANDLERS)
    .filter((p) => !mp.NO_MODEL_PROVIDERS.includes(p));

test('CA-7: la tabla de handlers enumerada no está vacía (el guardrail mira algo real)', () => {
    assert.ok(PROVIDERS_LLM.length >= 5, `se esperaban al menos 5 providers LLM, hay ${PROVIDERS_LLM.length}`);
    // Los cinco del issue tienen que estar sí o sí.
    for (const p of ['anthropic', 'openai-codex', 'gemini-google', 'cerebras', 'nvidia-nim']) {
        assert.ok(PROVIDERS_LLM.includes(p), `falta el provider ${p} en la tabla de handlers`);
    }
});

for (const provider of PROVIDERS_LLM) {
    test(`CA-7: el handler '${provider}' declara un canal de modelo`, () => {
        const target = mp.resolveTarget(provider);
        assert.notEqual(target.kind, 'none',
            `El provider '${provider}' no declara cómo recibir el modelo. Agregalo a `
            + `ARG_MODEL_PROVIDERS (lib/model-propagation.js) si su launcher acepta `
            + `--model, o a PROVIDER_MODEL_ENV (lib/build-child-env.js) con el nombre `
            + `de la env que su buildSpawn lee.`);
        if (target.kind === 'env') {
            assert.equal(PROVIDER_MODEL_ENV[provider], target.envVar);
        }
    });

    test(`CA-7: el handler '${provider}' PROPAGA de verdad el modelo al spawn`, () => {
        // Declarar el canal no alcanza: verificamos end-to-end que el modelo
        // aparece en el objeto que recibe `child_process.spawn`.
        const modelo = {
            anthropic: 'claude-haiku-4-5',
            'kimi-moonshot': 'kimi-k2-6',
            'openai-codex': 'gpt-5.4-mini',
            'gemini-google': 'gemini-2.0-flash',
            cerebras: 'zai-glm-4.7',
            'nvidia-nim': 'moonshotai/kimi-k2-instruct',
        }[provider];
        assert.ok(modelo, `falta el modelo de prueba para el provider '${provider}' — agregalo acá`);

        const { spawnCall } = launch({
            provider,
            model: modelo,
            config: cfg({ enabled: true, default_mode: 'on' }),
        });

        const enArgs = spawnCall.args.includes(modelo);
        const enEnv = Object.values(spawnCall.opts.env || {}).includes(modelo);
        assert.ok(enArgs || enEnv,
            `El provider '${provider}' no propagó el modelo al proceso hijo: no aparece `
            + `ni en args (${JSON.stringify(spawnCall.args)}) ni en el env del spawn. `
            + `Revisá su buildSpawn.`);
    });
}

test('CA-7: PROVIDER_MODEL_ENV no declara variables que su handler no lea', () => {
    // Correspondencia inversa: cada entrada del mapa tiene que corresponder a un
    // handler REAL que lea esa variable. Evita un mapa que se desactualiza en
    // silencio cuando se renombra o se borra un provider.
    const fs = require('fs');
    for (const [provider, envVar] of Object.entries(PROVIDER_MODEL_ENV)) {
        assert.ok(PROVIDER_HANDLERS[provider], `PROVIDER_MODEL_ENV declara '${provider}', que no es un handler real`);
        const file = path.join(__dirname, '..', 'lib', 'agent-launcher', 'providers', `${provider}.js`);
        const src = fs.readFileSync(file, 'utf8');
        assert.ok(src.includes(`env.${envVar}`),
            `providers/${provider}.js no lee 'env.${envVar}': el mapa PROVIDER_MODEL_ENV quedó desactualizado`);
    }
});

test('CA-7: los providers de canal argv no están declarados también en el canal env', () => {
    for (const p of mp.ARG_MODEL_PROVIDERS) {
        assert.equal(PROVIDER_MODEL_ENV[p], undefined,
            `'${p}' no puede tener dos canales de modelo: elegí argv o env, no ambos`);
    }
});

// =============================================================================
// Coherencia con el config real del repo — el default entregado está apagado.
// =============================================================================

test('el config.yaml del repo entrega la propagación APAGADA (rollout seguro)', () => {
    const fs = require('fs');
    const yaml = require('js-yaml');
    const real = yaml.load(fs.readFileSync(path.join(__dirname, '..', 'config.yaml'), 'utf8'));
    const seccion = real && real.pipeline && real.pipeline.model_propagation;
    assert.ok(seccion, 'falta la sección pipeline.model_propagation en config.yaml');
    assert.equal(seccion.enabled, false, 'la propagación debe entregarse apagada (#6274 la enciende)');
    assert.equal(mp.resolveMode({ config: real, provider: 'anthropic', skill: 'guru' }).mode, 'off');
});
