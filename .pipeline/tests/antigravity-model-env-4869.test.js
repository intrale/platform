'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const provider = require('../lib/agent-launcher/providers/antigravity');
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
            env: { ANTIGRAVITY_MODEL: 'gemini-3.8-flash-low', ANTIGRAVITY_PRINT_TIMEOUT: '30s' },
        });
        assert.equal(spawn.cmd, 'agy');
        // #6857 — agy 1.2.x: prompt por stdin como NDJSON (`--input-format
        // stream-json`); `--print` sin valor ya no existe.
        // #6859 — el cwd viaja TAMBIÉN como `--add-dir` (agy ignora el cwd del
        // proceso); `--model` sigue al final.
        assert.deepEqual(spawn.args, [
            '--input-format', 'stream-json', '--output-format', 'stream-json',
            '--disable-slash-commands', // #7322 — hardening
            '--dangerously-skip-permissions', '--print-timeout', '30s',
            '--add-dir', ROOT, // #6859 — workspace explícito
            '--model', 'gemini-3.8-flash-low',
        ]);
        assert.deepEqual(JSON.parse(spawn.stdinPayload), { event: 'user', message: { role: 'user', content: 'hola' } });
        assert.ok(spawn.stdinPayload.endsWith('\n'), 'una línea NDJSON terminada en newline');
        assert.equal(spawn.spawnOpts.shell, false);
        // #6858 — el esfuerzo viaja SÓLO en el sufijo del id, nunca como flag.
        assert.ok(!spawn.args.includes('--effort'), 'un solo canal de esfuerzo: el sufijo del id');
        assert.deepEqual(spawn.modelTrace, {
            applied: true, model: 'gemini-3.8-flash-low', source: 'ANTIGRAVITY_MODEL', reason: 'ok', ignoredEnv: [],
        });
    } finally {
        provider._resetLauncherCacheForTesting();
    }
    const source = fs.readFileSync(
        path.join(ROOT, '.pipeline/lib/agent-launcher/providers/antigravity.js'),
        'utf8',
    );
    assert.doesNotMatch(source, /@google\/gemini-cli|cmdShim|GEMINI_BIN/);
});

// =============================================================================
// #6334 (cerrado en #6858) — precedencia EXPLÍCITA del modelo: sólo ANTIGRAVITY_MODEL.
// Antes el handler leía `AGY_MODEL || ANTIGRAVITY_MODEL`: un AGY_MODEL exportado por
// el operador pisaba al modelo propagado y la traza afirmaba un modelo que no
// corrió.
// =============================================================================
test('#6334: ANTIGRAVITY_MODEL (la variable que propaga PROVIDER_MODEL_ENV) es la única fuente del --model; AGY_MODEL se ignora', () => {
    const { PROVIDER_MODEL_ENV } = require('../lib/build-child-env');
    assert.equal(PROVIDER_MODEL_ENV['antigravity'], provider.MODEL_ENV_VAR);
    assert.equal(provider.MODEL_ENV_VAR, 'ANTIGRAVITY_MODEL');
    assert.deepEqual(provider.IGNORED_MODEL_ENV_VARS, ['AGY_MODEL']);

    provider._setLauncherForTesting({ kind: 'native-exe', cmd: 'agy', prefixArgs: [], shell: false });
    try {
        // Escenario de #6334: AGY_MODEL heredado del entorno del operador + el
        // modelo propagado. Gana el propagado y la traza lo dice.
        const conShadow = provider.buildSpawn({
            args: ['-p', 'hola'], cwd: ROOT,
            env: { AGY_MODEL: 'gemini-1.0-legacy', ANTIGRAVITY_MODEL: 'gemini-3.8-flash-medium' },
        });
        assert.deepEqual(conShadow.args.slice(-2), ['--model', 'gemini-3.8-flash-medium']);
        assert.ok(!conShadow.args.includes('gemini-1.0-legacy'));
        assert.deepEqual(conShadow.modelTrace, {
            applied: true, model: 'gemini-3.8-flash-medium', source: 'ANTIGRAVITY_MODEL', reason: 'ok', ignoredEnv: ['AGY_MODEL'],
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
    const codigo = fs.readFileSync(path.join(ROOT, '.pipeline/lib/agent-launcher/providers/antigravity.js'), 'utf8')
        .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    assert.doesNotMatch(codigo, /env\.AGY_MODEL\s*\|\|/, 'la precedencia AGY_MODEL || ANTIGRAVITY_MODEL no puede volver');
    assert.doesNotMatch(codigo, /'--effort'/, 'nunca se pasa --effort: el esfuerzo va en el sufijo del id');
});

test('auth de Gemini es OAuth XOR API key y declara el binario agy', () => {
    const models = require('../agent-models.json');
    const model = models.providers['antigravity'];
    assert.equal(model.auth_mode, 'oauth');
    assert.equal(Object.hasOwn(model, 'credentials_env'), false);

    const spec = secrets.MANAGED_KEYS.find((entry) => entry.provider === 'antigravity');
    assert.equal(spec.auth_mode, 'oauth');
    assert.equal(spec.cli_binary, 'agy');
    // #6857 — el flag `AGY_LICENSE_READY` desapareció del spec: el estado sale
    // de un round-trip real (`catalog_probe: 'agy'`), no de una env var.
    assert.equal(Object.hasOwn(spec, 'readiness_env'), false);
    assert.equal(spec.catalog_probe, 'agy');
});

// #6857 — reescrito: antes pineaba "rojo hasta AGY_LICENSE_READY=1". Ahora el
// probe SIN round-trip ignora cualquier flag de entorno (ni lo lee), y el
// veredicto de licencia lo da `probeCliProviderLive` con el catálogo real
// (cubierto en tests/agy-catalog-probe-6857.test.js).
test('health de agy ya no depende de AGY_LICENSE_READY (ni en 0 ni en 1)', () => {
    const spec = { provider: 'antigravity', cli_binary: 'agy' };
    const sinFlag = probeCliProvider(spec, { env: {}, cliProbe: () => true });
    const conFlag = probeCliProvider(spec, { env: { AGY_LICENSE_READY: '1' }, cliProbe: () => true });
    assert.deepEqual(sinFlag, conFlag, 'el flag no cambia el veredicto');
    assert.equal(sinFlag.ok, true);
    // Y con un spec legacy que todavía declare `readiness_env`, tampoco.
    const legacy = { ...spec, readiness_env: 'AGY_LICENSE_READY' };
    assert.equal(probeCliProvider(legacy, { env: {}, cliProbe: () => true }).ok, true);
});

// #4869 rebote (verificacion→dev): "[security] Agente terminó con código 1".
// Causa raíz: el fail-closed por licencia marcaba antigravity rojo en el
// health snapshot, pero el reason_code `cli_license_unavailable` NO estaba en la
// allowlist de sanitize (colapsaba a 'unknown') NI en DURABLE_RED_REASONS del
// dispatch → el health-gate hacía fail-open, el dispatch seguía eligiendo
// antigravity, `agy` bloqueaba en OAuth hasta timeout y el proceso del agente
// (security incluido) moría con exit 1. Estos tests blindan ambos gaps.
test('sanitizeReasonCode preserva cli_license_unavailable (no lo colapsa a unknown)', () => {
    assert.equal(
        healthAlerts.sanitizeReasonCode('cli_license_unavailable'),
        'cli_license_unavailable',
    );
    assert.equal(healthAlerts.ALLOWED_REASON_CODES.has('cli_license_unavailable'), true);
});

test('cli_license_unavailable es rojo DURABLE — el dispatch gatea antigravity fail-closed', () => {
    assert.equal(DURABLE_RED_REASONS.has('cli_license_unavailable'), true);

    const now = Date.parse('2026-07-24T12:00:00.000Z');
    const snapshot = {
        ts: new Date(now).toISOString(),
        providers: [
            {
                provider: 'antigravity',
                state: 'red',
                reason_code: 'cli_license_unavailable',
                last_checked_at: new Date(now - 60_000).toISOString(),
            },
        ],
    };
    const gate = evaluateHealthGate('antigravity', snapshot, now);
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

// #6858 (rebote 1) — el transporte vigente es `--output-format stream-json`
// (#7298): el log es NDJSON y `usage` viaja dentro del evento `result`.
// Fixture capturado en vivo el 2026-09-16 con agy 1.2.4 y
// `--model gemini-3.8-flash-low` (init recortado; los demás eventos son textuales).
test('#6858: parseTokensFromLog lee `usage` del evento `result` NDJSON de --output-format stream-json (agy 1.2.4)', () => {
    const fixture = path.join(ROOT, '.pipeline/lib/__tests__/fixtures/agy-stream-json-1.2.4.ndjson');
    const raw = fs.readFileSync(fixture, 'utf8');
    const events = raw.trim().split(/\r?\n/).map((l) => JSON.parse(l).event);
    assert.deepEqual(events, ['init', 'step_update', 'step_update', 'step_update', 'result']);
    const result = provider._parseAntigravityJson(raw);
    assert.equal(result.status, 'SUCCESS');
    assert.equal(result.response, 'OK\n');
    assert.deepEqual(provider.parseTokensFromLog(fixture), {
        input: 13038, output: 13, cache_read: 0, cache_create: 0, tool_calls: 0,
    });
});
