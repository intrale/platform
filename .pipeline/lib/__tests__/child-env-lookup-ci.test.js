// Copyright (c) 2026 Leonel Larreta
// SPDX-License-Identifier: LicenseRef-Proprietary

'use strict';

// #7634 · B1…B4 — nombres de variables sin distinguir mayúsculas, tanto del lado
// que ENTREGA (allowlist, scopes, provider key) como del lado que BLOQUEA
// (reservadas, assert del env final).

const { test } = require('node:test');
const assert = require('node:assert/strict');

const lib = require('../build-child-env');
const { lookupEnvCI, buildMinimalCliEnv, stripReservedChildSecrets } = lib;

function operatorEnv(extra = {}) {
    return {
        PIPELINE_AMBIENTE: 'productivo',
        Path: '/usr/bin:/bin',
        windir: 'C:\\Windows',
        systemroot: 'C:\\Windows',
        ANTHROPIC_API_KEY: 'fake-anthropic-key-7634',
        GH_TOKEN: 'fake-gh-token-7634',
        TELEGRAM_BOT_TOKEN: 'fake-telegram-7634',
        ...extra,
    };
}

function build(opts = {}) {
    return lib.buildChildEnv({
        skill: 'guru',
        fase: 'analisis',
        processEnv: operatorEnv(),
        warn: () => {},
        ...opts,
    });
}

test('B1 · lookupEnvCI devuelve la clave REAL encontrada y su valor', () => {
    const r = lookupEnvCI({ Path: 'a' }, 'PATH');
    assert.deepEqual(r, { key: 'Path', value: 'a', ambiguous: null });
    assert.equal(lookupEnvCI({ Path: 'a' }, 'HOME'), null);
    assert.equal(lookupEnvCI(null, 'PATH'), null);
    assert.equal(lookupEnvCI({ PATH: undefined }, 'PATH'), null);
});

test('B1 · lookupEnvCI con varias grafías: gana la exacta y reporta la ambigüedad ordenada', () => {
    const r = lookupEnvCI({ Path: 'a', PATH: 'b', path: 'c' }, 'PATH');
    assert.equal(r.key, 'PATH');
    assert.equal(r.value, 'b');
    assert.deepEqual(r.ambiguous, ['PATH', 'Path', 'path']);
    // Sin la exacta: resultado determinístico (primera en orden).
    const r2 = lookupEnvCI({ path: 'c', Path: 'a' }, 'PATH');
    assert.equal(r2.key, 'Path');
});

test('B1 · lookupEnvCI no depende de process.platform', () => {
    const original = Object.getOwnPropertyDescriptor(process, 'platform');
    try {
        for (const plat of ['linux', 'win32', 'darwin']) {
            Object.defineProperty(process, 'platform', { value: plat });
            assert.equal(lookupEnvCI({ windir: 'x' }, 'WINDIR').value, 'x', plat);
        }
    } finally {
        Object.defineProperty(process, 'platform', original);
    }
});

test('B2 · objeto plano con Path/windir produce un hijo con PATH/WINDIR (camino ON)', () => {
    const env = build();
    assert.equal(env.PATH, '/usr/bin:/bin');
    assert.equal(env.WINDIR, 'C:\\Windows');
    assert.equal(env.SystemRoot, 'C:\\Windows', 'canónico de la constante');
    assert.equal(env.Path, undefined);
    assert.equal(env.windir, undefined);
});

test('B2 · buildMinimalCliEnv también normaliza a PATH/WINDIR', () => {
    const env = buildMinimalCliEnv({ processEnv: { Path: '/p', windir: 'C:\\W', codex_home: '/c' } });
    assert.equal(env.PATH, '/p');
    assert.equal(env.WINDIR, 'C:\\W');
    assert.equal(env.CODEX_HOME, '/c');
});

test('B2 · la API key del provider se encuentra aunque venga con otra grafía', () => {
    const pe = operatorEnv();
    delete pe.ANTHROPIC_API_KEY;
    pe.anthropic_api_key = 'fake-anthropic-lower';
    const env = build({ processEnv: pe });
    assert.equal(env.ANTHROPIC_API_KEY, 'fake-anthropic-lower');
    assert.equal(env.anthropic_api_key, undefined);
});

test('B3 · camino ON: pipelineExtras telegram_bot_token no llega al hijo', () => {
    const env = build({ pipelineExtras: { telegram_bot_token: 'x' } });
    for (const k of Object.keys(env)) assert.notEqual(k.toUpperCase(), 'TELEGRAM_BOT_TOKEN');
});

test('B3 · camino ON: pipelineExtras aws_access_key_id no llega (rol sin aws) o dispara la violación', () => {
    let env;
    try {
        env = build({ pipelineExtras: { aws_access_key_id: 'x' } });
    } catch (e) {
        assert.equal(e.code, 'CHILD_ENV_VIOLATION');
        return;
    }
    for (const k of Object.keys(env)) assert.notEqual(k.toUpperCase(), 'AWS_ACCESS_KEY_ID');
});

test('B3 · camino ON: un rol CON aws y un alias en minúsculas de su credencial dispara case-duplicate', () => {
    const pe = operatorEnv({ AWS_ACCESS_KEY_ID: 'fake-aws-id' });
    assert.throws(
        () => build({ skill: 'backend-dev', fase: 'dev', processEnv: pe, pipelineExtras: { aws_access_key_id: 'x' } }),
        (e) => e.code === 'CHILD_ENV_VIOLATION' && e.details.causas.some((c) => c.kind === 'case-duplicate'),
    );
});

test('B3 · camino OFF: stripReservedChildSecrets quita telegram_bot_token (cualquier grafía)', () => {
    const out = stripReservedChildSecrets(
        { telegram_bot_token: 'x', Telegram_Bot_Token: 'y', PATH: '/p' },
        operatorEnv(),
    );
    assert.deepEqual(Object.keys(out), ['PATH']);
});

test('B3 · camino OFF: el valor reservado se toma del operador aunque la clave venga en minúsculas', () => {
    const out = stripReservedChildSecrets(
        { ALIAS: 'fake-telegram-lower', PATH: '/p' },
        { telegram_bot_token: 'fake-telegram-lower' },
    );
    assert.equal(out.ALIAS, undefined);
});

test('B3 · assertChildEnvMinimal compara excepciones sin distinguir mayúsculas', () => {
    assert.equal(lib.assertChildEnvMinimal(
        { PATH: '/p', mi_var_permitida: 'ok' },
        { skill: 'guru', fase: 'analisis', effectiveScopes: [], exceptions: ['MI_VAR_PERMITIDA'] },
    ), true);
});

test('B4 · env final con dos claves que sólo difieren en mayúsculas → CHILD_ENV_VIOLATION', () => {
    assert.throws(
        () => lib.assertChildEnvMinimal({ PATH: '/a', Path: '/b' }, { skill: 'guru', fase: 'analisis' }),
        (e) => e.code === 'CHILD_ENV_VIOLATION'
            && e.details.causas.some((c) => c.kind === 'case-duplicate'
                && c.nombres.join(',') === 'PATH,Path'),
    );
});

test('B4 · en buildChildEnv un duplicado de LECTURA (Path + PATH en processEnv) se tolera', () => {
    const env = build({ processEnv: operatorEnv({ PATH: '/exacta' }) });
    assert.equal(env.PATH, '/exacta', 'gana la grafía exacta');
});

test('B4 · en buildChildEnv un duplicado introducido por pipelineExtras tira', () => {
    assert.throws(
        () => build({ pipelineExtras: { path: '/otra' } }),
        (e) => e.code === 'CHILD_ENV_VIOLATION' && e.details.causas.some((c) => c.kind === 'case-duplicate'),
    );
});
