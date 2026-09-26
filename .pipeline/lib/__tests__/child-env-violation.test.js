// Copyright (c) 2026 Leonel Larreta
// SPDX-License-Identifier: LicenseRef-Proprietary

'use strict';

// #7634 · D1/D2/D5/D6 — `assertChildEnvMinimal` + `ChildEnvViolation`: fallo
// ruidoso, con un mensaje en el formato de UX y sin fuga de valores.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const util = require('node:util');

const lib = require('../build-child-env');
const { assertChildEnvMinimal, ISOLATION_RESERVED_NAMES, RESERVED_CHILD_SECRET_NAMES } = lib;
const { ChildEnvViolation, CODE, KINDS, formatChildEnvViolation } = require('../child-env-error');

// Fixtures armados por concatenación en runtime: el repo es público y el
// secret-scan no acepta literales con forma de credencial (ni siquiera falsos).
const j = (...p) => p.join('');
// Valores de fixture: si alguno aparece en cualquier canal del error, hay fuga.
const V = Object.freeze({
    aws: j('AK', 'IA', 'QWERTYUIOPASDFGH'),
    awsSts: j('AS', 'IA', 'ZXCVBNMLKJHGFDSA'),
    gh: j('gh', 'p_', 'Zz9Yy8Xx7Ww6Vv5Uu4Tt3Ss2Rr1Qq0Pp9Oo8'),
    ghPat: j('github', '_pat_', '11FIXTURE0000_zyxwvutsrqponmlkji'),
    sk: j('sk', '-proj-', 'fixtureNoRealKey0123456789'),
    tg: j('987654321', ':', 'AAFixtureTelegramToken_zyxwvutsrq'),
    jwt: j('eyJmaXh0dXJlIjoxfQ0', '.', 'eyJzdWIiOiJmaXh0dXJlIn0', '.', 'c2lnbmF0dXJhRml4dHVyZQ'),
    plano: 'valor-plano-no-secreto-7634',
    alias: 'alias-de-credencial-7634',
});

const BASE = Object.freeze({ skill: 'guru', fase: 'analisis', intento: 'anthropic', effectiveScopes: ['github', 'telegram-hooks'] });

function atrapar(fn) {
    try { fn(); } catch (e) { return e; }
    assert.fail('se esperaba CHILD_ENV_VIOLATION');
}

function kinds(e) { return e.details.causas.map((c) => c.kind); }

// ─── D1 ─────────────────────────────────────────────────────────────────────

test('D1 · ChildEnvViolation es un Error tipado con code CHILD_ENV_VIOLATION', () => {
    const e = new ChildEnvViolation({ rol: 'guru', fase: 'analisis', causas: [{ kind: 'undeclared', nombres: ['X'] }] });
    assert.ok(e instanceof Error);
    assert.equal(e.name, 'ChildEnvViolation');
    assert.equal(e.code, CODE);
    assert.equal(CODE, 'CHILD_ENV_VIOLATION');
    assert.ok(Object.isFrozen(e.details));
});

test('D1 · un kind fuera del enum no se acepta', () => {
    assert.throws(() => new ChildEnvViolation({ causas: [{ kind: 'inventado', nombres: ['X'] }] }), TypeError);
});

test('D1 · la lista de excepciones se copia y congela: mutarla después no cambia el resultado', () => {
    const ex = ['MI_VAR'];
    const env = { PATH: '/p', MI_VAR: 'x' };
    assert.equal(assertChildEnvMinimal(env, { ...BASE, exceptions: ex }), true);
    ex.push('*');
    assert.equal(assertChildEnvMinimal(env, { ...BASE, exceptions: ['MI_VAR'] }), true);
});

test('D1 · un comodín en las excepciones no habilita nada y es una violación', () => {
    const e = atrapar(() => assertChildEnvMinimal({ PATH: '/p', OTRA: 'x' }, { ...BASE, exceptions: ['*'] }));
    assert.deepEqual(kinds(e).sort(), ['invalid-exception', 'undeclared']);
    const e2 = atrapar(() => assertChildEnvMinimal({ PATH: '/p', MI_X: 'x' }, { ...BASE, exceptions: ['MI_*'] }));
    assert.ok(kinds(e2).includes('invalid-exception'));
});

test('D1 · env mínimo válido no tira', () => {
    assert.equal(assertChildEnvMinimal({
        PATH: '/p', SystemRoot: 'C:\\W', PIPELINE_ISSUE: '7634', GH_TOKEN: V.gh,
        ANTHROPIC_API_KEY: V.sk, AWS_SHARED_CREDENTIALS_FILE: '/s', AWS_CONFIG_FILE: '/s',
        AWS_EC2_METADATA_DISABLED: 'true', TELEGRAM_CHAT_ID: '123', PROVIDER_RESOLUTION_LOG: 'anthropic ok',
    }, { ...BASE, providerKeyVar: 'ANTHROPIC_API_KEY' }), true);
});

// ─── D2 · los 6 casos ───────────────────────────────────────────────────────

test('D2.1 · variable no declarada → undeclared', () => {
    const e = atrapar(() => assertChildEnvMinimal({ PATH: '/p', MI_VAR: V.plano }, BASE));
    assert.deepEqual(kinds(e), ['undeclared']);
    assert.deepEqual(e.details.causas[0].nombres, ['MI_VAR']);
});

test('D2.2 · valor con forma de secreto bajo un nombre que no es de su scope → kind del patrón', () => {
    const e = atrapar(() => assertChildEnvMinimal({ PATH: '/p', PIPELINE_X: V.aws }, BASE));
    assert.deepEqual(kinds(e), ['aws-access-key']);
    for (const [valor, kind] of [[V.awsSts, 'aws-access-key'], [V.ghPat, 'github-token'], [V.tg, 'telegram-token'], [V.jwt, 'jwt'], [V.sk, 'provider-key']]) {
        const ei = atrapar(() => assertChildEnvMinimal({ PIPELINE_Y: valor }, BASE));
        assert.deepEqual(kinds(ei), [kind]);
    }
});

test('D2.2 · la credencial en su propio scope NO se marca por forma de valor', () => {
    assert.equal(assertChildEnvMinimal({ GH_TOKEN: V.gh }, BASE), true);
});

test('D2.3 · alias reservado en pipelineExtras/extra → reserved-alias (sin distinguir mayúsculas)', () => {
    for (const nombre of ['AWS_ACCESS_KEY_ID', 'aws_secret_access_key', 'OPENAI_API_KEY', 'Gh_Enterprise_Token', 'TELEGRAM_BOT_TOKEN']) {
        const e = atrapar(() => assertChildEnvMinimal({ PATH: '/p', [nombre]: V.alias }, BASE));
        assert.deepEqual(kinds(e), ['reserved-alias'], nombre);
    }
});

test('D2.3 · buildChildEnv: OPENAI_API_KEY por pipelineExtras en un rol anthropic tira', () => {
    const e = atrapar(() => lib.buildChildEnv({
        skill: 'guru', fase: 'analisis', warn: () => {},
        processEnv: { PIPELINE_AMBIENTE: 'productivo', PATH: '/p', ANTHROPIC_API_KEY: V.plano },
        pipelineExtras: { OPENAI_API_KEY: V.alias },
    }));
    assert.equal(e.code, CODE);
    assert.ok(kinds(e).includes('reserved-alias'));
});

test('D2.4 · fase desconocida → unknown-phase (también ausente o heredada por prototipo)', () => {
    for (const fase of ['inventada', undefined, null, 'toString', '__proto__', 42]) {
        const e = atrapar(() => assertChildEnvMinimal({ PATH: '/p' }, { ...BASE, fase }));
        assert.deepEqual(kinds(e), ['unknown-phase'], String(fase));
    }
});

test('D2.5 · skill desconocido → unknown-skill; declarado por la config resuelta → ok', () => {
    const e = atrapar(() => assertChildEnvMinimal({ PATH: '/p' }, { ...BASE, skill: 'rol-inventado' }));
    assert.deepEqual(kinds(e), ['unknown-skill']);
    assert.equal(assertChildEnvMinimal({ PATH: '/p' }, { ...BASE, skill: 'rol-inventado', skillDeclared: true }), true);
    const e2 = atrapar(() => assertChildEnvMinimal({ PATH: '/p' }, { ...BASE, skill: undefined }));
    assert.deepEqual(kinds(e2), ['unknown-skill']);
});

test('D2.5 · buildChildEnv con un skill que no está en agent-models ni en los defaults tira', () => {
    const e = atrapar(() => lib.buildChildEnv({
        skill: 'rol-inventado', fase: 'analisis', warn: () => {},
        processEnv: { PIPELINE_AMBIENTE: 'productivo', PATH: '/p', ANTHROPIC_API_KEY: V.plano },
    }));
    assert.deepEqual(kinds(e), ['unknown-skill']);
});

test('D2.6 · una excepción que intenta habilitar una reservada: la reservada gana', () => {
    for (const reservada of ['AWS_ACCESS_KEY_ID', 'gh_token', 'TELEGRAM_BOT_TOKEN', 'ANTHROPIC_API_KEY']) {
        const e = atrapar(() => assertChildEnvMinimal(
            { PATH: '/p', [reservada.toUpperCase()]: V.alias },
            { ...BASE, effectiveScopes: [], exceptions: [reservada] },
        ));
        assert.ok(kinds(e).includes('invalid-exception'), reservada);
        assert.ok(kinds(e).includes('reserved-alias'), reservada);
    }
});

test('D2 · ISOLATION_RESERVED_NAMES cubre AWS, GitHub, providers y Telegram; RESERVED_CHILD_SECRET_NAMES sigue sólo Telegram', () => {
    for (const n of ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'AWS_PROFILE', 'AWS_ROLE_ARN',
        'AWS_WEB_IDENTITY_TOKEN_FILE', 'GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN',
        'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'TELEGRAM_BOT_TOKEN']) {
        assert.ok(ISOLATION_RESERVED_NAMES.includes(n), n);
    }
    assert.deepEqual([...RESERVED_CHILD_SECRET_NAMES], ['TELEGRAM_BOT_TOKEN']);
});

test('D2 · acumula todas las causas y tira UNA sola vez', () => {
    const e = atrapar(() => assertChildEnvMinimal(
        { PATH: '/p', Path: '/q', MI_VAR: V.aws, OPENAI_API_KEY: V.alias },
        { ...BASE, fase: 'nope', skill: 'nadie' },
    ));
    assert.deepEqual(kinds(e), ['undeclared', 'reserved-alias', 'case-duplicate', 'unknown-phase', 'unknown-skill', 'aws-access-key']);
});

// ─── D5 · sin fuga en ningún canal ──────────────────────────────────────────

test('D5 · ningún valor de los fixtures aparece en message, stack, JSON.stringify ni util.inspect', () => {
    const env = {
        PATH: '/p', Path: V.plano,
        MI_AWS: V.aws, MI_STS: V.awsSts, MI_GH: V.gh, MI_PAT: V.ghPat, MI_SK: V.sk, MI_TG: V.tg, MI_JWT: V.jwt,
        OPENAI_API_KEY: V.alias, NO_DECLARADA: V.plano,
    };
    const e = atrapar(() => assertChildEnvMinimal(env, { ...BASE, fase: 'nope', exceptions: ['*', 'AWS_ACCESS_KEY_ID'] }));
    const canales = {
        message: e.message,
        stack: e.stack,
        json: JSON.stringify(e),
        inspect: util.inspect(e, { depth: null }),
    };
    for (const [canal, texto] of Object.entries(canales)) {
        for (const [fixture, valor] of Object.entries(V)) {
            assert.equal(texto.includes(valor), false, `${fixture} filtrado en ${canal}`);
        }
        // Ni prefijos de valor ni máscaras.
        for (const frag of ['AKIA', 'ASIA', 'ghp_', 'github_pat_', 'sk-', 'eyJ', '***', 'hash:']) {
            assert.equal(texto.includes(frag), false, `"${frag}" en ${canal}`);
        }
    }
    assert.deepEqual(Object.keys(JSON.parse(canales.json)).sort(), ['code', 'details', 'message', 'name']);
});

test('D5 · el error no guarda el env ni una parte de él', () => {
    const env = { PATH: '/p', MI_VAR: V.plano };
    const e = atrapar(() => assertChildEnvMinimal(env, BASE));
    const props = Object.getOwnPropertyNames(e).sort();
    assert.deepEqual(props, ['code', 'details', 'message', 'name', 'stack']);
    assert.deepEqual(Object.keys(e.details).sort(), ['ancla', 'causas', 'fase', 'intento', 'rol']);
    for (const c of e.details.causas) assert.deepEqual(Object.keys(c).sort(), ['kind', 'nombres']);
});

test('D5 · un NOMBRE con forma de secreto tampoco se imprime', () => {
    const e = atrapar(() => assertChildEnvMinimal({ [V.aws]: 'x' }, BASE));
    assert.equal(e.message.includes(V.aws), false);
    assert.match(e.message, /\(nombre con forma de secreto\)/);
});

// ─── D6 · formato UX ────────────────────────────────────────────────────────

test('D6 · formato: encabezado, una línea Motivo por causa con nombres ordenados, Cómo seguir y Ver', () => {
    const e = atrapar(() => assertChildEnvMinimal(
        { PATH: '/p', ZETA: 'a', ALFA: 'b', MI_VAR: V.aws },
        { ...BASE, intento: 'openai-codex', ancla: 'lanzaragenteclaude' },
    ));
    const lineas = e.message.split('\n');
    assert.equal(lineas[0], '[entorno-hijo] Lanzamiento bloqueado · rol=guru · fase=analisis · intento=openai-codex');
    assert.equal(lineas[1], 'Motivo: variable no declarada para este rol → ALFA, MI_VAR, ZETA (undeclared)');
    assert.equal(lineas[2], 'Motivo: valor con forma de secreto (clave de AWS) en → MI_VAR (aws-access-key)');
    assert.match(lineas[3], /^Cómo seguir: .*requires_credentials.*docs\/pipeline\/entorno-agentes-hijos\.md/);
    assert.equal(lineas[4], 'Ver: docs/pipeline/entorno-agentes-hijos.md#lanzaragenteclaude');
    assert.equal(lineas.length, 5);
});

test('D6 · el mensaje no menciona env-exceptions ni prefijos/largos/máscaras', () => {
    const e = atrapar(() => assertChildEnvMinimal({ MI_VAR: V.aws, OTRA: V.gh }, BASE));
    assert.doesNotMatch(e.message, /env-exceptions/);
    assert.doesNotMatch(e.message, /AKIA|ghp_|\*\*\*|empieza con|largo|length/i);
});

test('D6 · cada kind tiene frase en español y el formateador es estable (determinístico)', () => {
    for (const kind of KINDS) {
        const msg = formatChildEnvViolation({ rol: 'x', fase: 'dev', intento: 'anthropic', causas: [{ kind, nombres: ['B', 'A'] }] });
        assert.match(msg, new RegExp(`\\(${kind}\\)`));
    }
    const a = atrapar(() => assertChildEnvMinimal({ B: '1', A: '2' }, BASE)).message;
    const b = atrapar(() => assertChildEnvMinimal({ A: '2', B: '1' }, BASE)).message;
    assert.equal(a, b);
});

test('D6 · el Commander apunta a su propia ancla del doc', () => {
    const e = atrapar(() => lib.buildChildEnv({
        skill: 'telegram-commander', fase: lib.KERNEL_FASE, warn: () => {},
        processEnv: { PIPELINE_AMBIENTE: 'productivo', PATH: '/p', ANTHROPIC_API_KEY: V.plano },
        skillConfigOverride: { skill: { provider: 'anthropic', requires_credentials: ['github'] }, providers: {} },
        pipelineExtras: { CLAUDE_PROJECT_DIR: '/repo', EXTRA_NO_DECLARADA: 'x' },
    }));
    assert.match(e.message, /#commander$/);
});
