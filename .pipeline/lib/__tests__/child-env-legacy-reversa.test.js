// Copyright (c) 2026 Leonel Larreta
// SPDX-License-Identifier: LicenseRef-Proprietary

'use strict';

// #7634 · E1/E3/E4 — producción intacta con el flag OFF: el camino legacy sólo
// cambia en que Telegram se quita sin distinguir mayúsculas.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const lib = require('../build-child-env');

const OPERADOR = Object.freeze({
    PATH: '/p',
    GH_TOKEN: 'fake-gh-legacy',
    AWS_ACCESS_KEY_ID: 'fake-aws-legacy',
    OPENAI_API_KEY: 'fake-openai-legacy',
    TELEGRAM_BOT_TOKEN: 'fake-telegram-legacy',
});

test('E1 · stripReservedChildSecrets (flag OFF) deja pasar GH_TOKEN y AWS_ACCESS_KEY_ID', () => {
    const out = lib.stripReservedChildSecrets({ ...OPERADOR }, OPERADOR);
    assert.equal(out.GH_TOKEN, 'fake-gh-legacy');
    assert.equal(out.AWS_ACCESS_KEY_ID, 'fake-aws-legacy');
    assert.equal(out.OPENAI_API_KEY, 'fake-openai-legacy');
});

test('E1 · stripReservedChildSecrets quita TELEGRAM_BOT_TOKEN y telegram_bot_token', () => {
    const out = lib.stripReservedChildSecrets({ ...OPERADOR, telegram_bot_token: 'otro-valor' }, OPERADOR);
    assert.equal(out.TELEGRAM_BOT_TOKEN, undefined);
    assert.equal(out.telegram_bot_token, undefined);
    assert.deepEqual(Object.keys(out).sort(), ['AWS_ACCESS_KEY_ID', 'GH_TOKEN', 'OPENAI_API_KEY', 'PATH']);
});

test('E1 · el camino legacy de lanzarAgenteClaude (conDeclaracionExplicita + strip) conserva las credenciales', () => {
    const legacy = lib.stripReservedChildSecrets(
        lib.conDeclaracionExplicita({ ...OPERADOR, PIPELINE_ISSUE: '1' }, OPERADOR),
        OPERADOR,
    );
    assert.equal(legacy.GH_TOKEN, 'fake-gh-legacy');
    assert.equal(legacy.AWS_ACCESS_KEY_ID, 'fake-aws-legacy');
    assert.equal(legacy.TELEGRAM_BOT_TOKEN, undefined);
    assert.equal(legacy.GH_CONFIG_DIR, undefined, 'sin neutralización en el camino OFF');
    assert.equal(legacy.AWS_SHARED_CREDENTIALS_FILE, undefined, 'sin neutralización en el camino OFF');
});

test('E1 · RESERVED_CHILD_SECRET_NAMES sigue siendo sólo Telegram; la lista ampliada es otra constante', () => {
    assert.deepEqual([...lib.RESERVED_CHILD_SECRET_NAMES], ['TELEGRAM_BOT_TOKEN']);
    assert.notEqual(lib.ISOLATION_RESERVED_NAMES, lib.RESERVED_CHILD_SECRET_NAMES);
    assert.ok(lib.ISOLATION_RESERVED_NAMES.length > lib.RESERVED_CHILD_SECRET_NAMES.length);
});

test('E3 · el camino legacy no invoca assertChildEnvMinimal: un env con credenciales no tira', () => {
    assert.doesNotThrow(() => lib.stripReservedChildSecrets({ ...OPERADOR, CUALQUIER_COSA: 'x' }, OPERADOR));
    assert.doesNotThrow(() => lib.buildMinimalCliEnv({ processEnv: OPERADOR, extras: { CODEX_MODEL: 'm' } }));
    // pulpo.js: el assert sólo vive dentro de buildChildEnv (camino ON); pulpo no lo llama directo.
    const pulpo = fs.readFileSync(path.join(__dirname, '..', '..', 'pulpo.js'), 'utf8');
    assert.doesNotMatch(pulpo, /assertChildEnvMinimal/);
});

// #7636 · CA-7 — el encendido es deliberado: el flag pasa a `true`. El camino
// legacy de arriba sigue siendo el de la REVERSA (flag en `false`).
test('E4 · env_isolation_enabled está encendido (true) en .pipeline/config.yaml (#7636)', () => {
    const cfg = fs.readFileSync(path.join(__dirname, '..', '..', 'config.yaml'), 'utf8');
    const m = cfg.match(/^\s*env_isolation_enabled:\s*(\S+)/m);
    assert.ok(m, 'la clave env_isolation_enabled existe');
    assert.equal(m[1], 'true');
    const todas = [...cfg.matchAll(/^\s*env_isolation_enabled:\s*(\S+)/gm)].map((x) => x[1]);
    assert.deepEqual([...new Set(todas)], ['true']);
});
