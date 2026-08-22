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
            env: { AGY_MODEL: 'gemini-3-flash', AGY_PRINT_TIMEOUT: '30s' },
        });
        assert.equal(spawn.cmd, 'agy');
        assert.deepEqual(spawn.args, [
            '--print', '--dangerously-skip-permissions', '--print-timeout', '30s',
            '--model', 'gemini-3-flash',
        ]);
        assert.equal(spawn.stdinPayload, 'hola');
        assert.equal(spawn.spawnOpts.shell, false);
    } finally {
        provider._resetLauncherCacheForTesting();
    }
    const source = fs.readFileSync(
        path.join(ROOT, '.pipeline/lib/agent-launcher/providers/gemini-google.js'),
        'utf8',
    );
    assert.doesNotMatch(source, /@google\/gemini-cli|cmdShim|GEMINI_BIN/);
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
