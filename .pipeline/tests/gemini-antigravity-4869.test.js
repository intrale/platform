'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const provider = require('../lib/agent-launcher/providers/gemini-google');
const { probeCliProvider } = require('../lib/multi-provider/cli-oauth-probe');
const secrets = require('../lib/multi-provider/secrets-rw');

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
