'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const provider = require('../lib/agent-launcher/providers/gemini-google');
const { probeCliProvider } = require('../lib/multi-provider/cli-oauth-probe');
const secrets = require('../lib/multi-provider/secrets-rw');
const healthAlerts = require('../lib/multi-provider/health-alerts');
const {
    evaluateHealthGate,
    DURABLE_RED_REASONS,
} = require('../lib/agent-launcher/dispatch-with-fallback');

test('agy reemplaza por completo la invocación del Gemini CLI retirado', () => {
    provider._setLauncherForTesting({
        kind: 'native-exe', cmd: 'agy', prefixArgs: [], shell: false,
    });
    try {
        const spawn = provider.buildSpawn({
            args: ['-p', 'hola'],
            cwd: ROOT,
            env: { GEMINI_MODEL: 'gemini-3.8-flash-low', AGY_PRINT_TIMEOUT: '30s' },
        });
        assert.equal(spawn.cmd, 'agy');
        assert.deepEqual(spawn.args, [
            '--print', '--dangerously-skip-permissions', '--print-timeout', '30s',
            '--model', 'gemini-3.8-flash-low',
        ]);
        assert.equal(spawn.stdinPayload, 'hola');
        assert.equal(spawn.spawnOpts.shell, false);
        // #6858 — el esfuerzo viaja SÓLO en el sufijo del id, nunca como flag.
        assert.ok(!spawn.args.includes('--effort'), 'un solo canal de esfuerzo: el sufijo del id');
        assert.deepEqual(spawn.modelTrace, {
            applied: true, model: 'gemini-3.8-flash-low', source: 'GEMINI_MODEL', reason: 'ok', ignoredEnv: [],
        });
    } finally {
        provider._resetLauncherCacheForTesting();
    }
    const source = fs.readFileSync(
        path.join(ROOT, '.pipeline/lib/agent-launcher/providers/gemini-google.js'),
        'utf8',
    );
    assert.doesNotMatch(source, /@google\/gemini-cli|cmdShim|GEMINI_BIN/);
});

// =============================================================================
// #6334 (cerrado en #6858) — precedencia EXPLÍCITA del modelo: sólo GEMINI_MODEL.
// Antes el handler leía `AGY_MODEL || GEMINI_MODEL`: un AGY_MODEL exportado por
// el operador pisaba al modelo propagado y la traza afirmaba un modelo que no
// corrió.
// =============================================================================
test('#6334: GEMINI_MODEL (la variable que propaga PROVIDER_MODEL_ENV) es la única fuente del --model; AGY_MODEL se ignora', () => {
    const { PROVIDER_MODEL_ENV } = require('../lib/build-child-env');
    assert.equal(PROVIDER_MODEL_ENV['gemini-google'], provider.MODEL_ENV_VAR);
    assert.equal(provider.MODEL_ENV_VAR, 'GEMINI_MODEL');
    assert.deepEqual(provider.IGNORED_MODEL_ENV_VARS, ['AGY_MODEL']);

    provider._setLauncherForTesting({ kind: 'native-exe', cmd: 'agy', prefixArgs: [], shell: false });
    try {
        // Escenario de #6334: AGY_MODEL heredado del entorno del operador + el
        // modelo propagado. Gana el propagado y la traza lo dice.
        const conShadow = provider.buildSpawn({
            args: ['-p', 'hola'], cwd: ROOT,
            env: { AGY_MODEL: 'gemini-1.0-legacy', GEMINI_MODEL: 'gemini-3.8-flash-medium' },
        });
        assert.deepEqual(conShadow.args.slice(-2), ['--model', 'gemini-3.8-flash-medium']);
        assert.ok(!conShadow.args.includes('gemini-1.0-legacy'));
        assert.deepEqual(conShadow.modelTrace, {
            applied: true, model: 'gemini-3.8-flash-medium', source: 'GEMINI_MODEL', reason: 'ok', ignoredEnv: ['AGY_MODEL'],
        });

        // Sólo AGY_MODEL (sin propagación): NO se pasa --model y queda traza de
        // que se ignoró — el launcher loguea que arranca con el default del CLI.
        const soloAgy = provider.buildSpawn({ args: ['-p', 'hola'], cwd: ROOT, env: { AGY_MODEL: 'gemini-1.0-legacy' } });
        assert.ok(!soloAgy.args.includes('--model'));
        assert.deepEqual(soloAgy.modelTrace, {
            applied: false, model: null, source: 'cli-default', reason: 'agy_model_env_ignored', ignoredEnv: ['AGY_MODEL'],
        });

        // Sin ninguna variable: regresión cero — ni --model ni modelTrace.
        const vacio = provider.buildSpawn({ args: ['-p', 'hola'], cwd: ROOT, env: {} });
        assert.ok(!vacio.args.includes('--model'));
        assert.equal(Object.hasOwn(vacio, 'modelTrace'), false);
    } finally {
        provider._resetLauncherCacheForTesting();
    }

    // Guardrail de código: el handler no vuelve a leer AGY_MODEL como fuente.
    // Sólo líneas de código: los comentarios narran el bug viejo a propósito.
    const codigo = fs.readFileSync(path.join(ROOT, '.pipeline/lib/agent-launcher/providers/gemini-google.js'), 'utf8')
        .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    assert.doesNotMatch(codigo, /env\.AGY_MODEL\s*\|\|/, 'la precedencia AGY_MODEL || GEMINI_MODEL no puede volver');
    assert.doesNotMatch(codigo, /'--effort'/, 'nunca se pasa --effort: el esfuerzo va en el sufijo del id');
});

test('auth de Gemini es OAuth XOR API key y declara el binario agy', () => {
    const models = require('../agent-models.json');
    const model = models.providers['gemini-google'];
    assert.equal(model.auth_mode, 'oauth');
    assert.equal(Object.hasOwn(model, 'credentials_env'), false);

    const spec = secrets.MANAGED_KEYS.find((entry) => entry.provider === 'gemini-google');
    assert.equal(spec.auth_mode, 'oauth');
    assert.equal(spec.cli_binary, 'agy');
    assert.equal(spec.readiness_env, 'AGY_LICENSE_READY');
});

test('health de agy degrada fail-closed hasta habilitar la licencia', () => {
    const spec = {
        provider: 'gemini-google',
        cli_binary: 'agy',
        readiness_env: 'AGY_LICENSE_READY',
    };
    assert.deepEqual(
        probeCliProvider(spec, { env: {}, cliProbe: () => true }),
        {
            ok: false,
            reason: 'cli_license_unavailable',
            provider: 'gemini-google',
            cli_oauth: true,
        },
    );
    assert.equal(
        probeCliProvider(spec, {
            env: { AGY_LICENSE_READY: '1' },
            cliProbe: () => true,
        }).ok,
        true,
    );
});

// #4869 rebote (verificacion→dev): "[security] Agente terminó con código 1".
// Causa raíz: el fail-closed por licencia marcaba gemini-google rojo en el
// health snapshot, pero el reason_code `cli_license_unavailable` NO estaba en la
// allowlist de sanitize (colapsaba a 'unknown') NI en DURABLE_RED_REASONS del
// dispatch → el health-gate hacía fail-open, el dispatch seguía eligiendo
// gemini-google, `agy` bloqueaba en OAuth hasta timeout y el proceso del agente
// (security incluido) moría con exit 1. Estos tests blindan ambos gaps.
test('sanitizeReasonCode preserva cli_license_unavailable (no lo colapsa a unknown)', () => {
    assert.equal(
        healthAlerts.sanitizeReasonCode('cli_license_unavailable'),
        'cli_license_unavailable',
    );
    assert.equal(healthAlerts.ALLOWED_REASON_CODES.has('cli_license_unavailable'), true);
});

test('cli_license_unavailable es rojo DURABLE — el dispatch gatea gemini-google fail-closed', () => {
    assert.equal(DURABLE_RED_REASONS.has('cli_license_unavailable'), true);

    const now = Date.parse('2026-07-24T12:00:00.000Z');
    const snapshot = {
        ts: new Date(now).toISOString(),
        providers: [
            {
                provider: 'gemini-google',
                state: 'red',
                reason_code: 'cli_license_unavailable',
                last_checked_at: new Date(now - 60_000).toISOString(),
            },
        ],
    };
    const gate = evaluateHealthGate('gemini-google', snapshot, now);
    assert.equal(gate.gated, true);
    assert.equal(gate.reason, 'cli_license_unavailable');
    assert.equal(gate.state, 'red');
});

// =============================================================================
// #6858 — parseTokensFromLog entiende el shape `usage` de agy 1.2.4 (medido en
// vivo el 2026-09-16, fixture agy-print-json-1.2.4.json) sin romper el legacy
// `stats.models` de 1.1.x.
// =============================================================================
test('#6858: parseTokensFromLog lee `usage` de agy 1.2.4 (output_tokens ya incluye thinking) y conserva el legacy stats.models', () => {
    const fixture = path.join(ROOT, '.pipeline/lib/__tests__/fixtures/agy-print-json-1.2.4.json');
    const real = JSON.parse(fs.readFileSync(fixture, 'utf8'));
    assert.equal(real.status, 'SUCCESS');
    assert.deepEqual(provider.parseTokensFromLog(fixture), {
        input: 13049, output: 22, cache_read: 0, cache_create: 0, tool_calls: 0,
    });

    const legacy = { readFileSync: () => JSON.stringify({
        response: 'OK',
        stats: { models: { 'gemini-3.8-flash-medium': { tokens: { input: 200, candidates: 8, cached: 5, thoughts: 12 } } } },
    }) };
    assert.deepEqual(provider.parseTokensFromLog('x', legacy), {
        input: 200, output: 20, cache_read: 5, cache_create: 0, tool_calls: 0,
    });
});
