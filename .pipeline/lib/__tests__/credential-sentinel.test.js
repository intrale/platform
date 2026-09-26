// Copyright (c) 2026 Leonel Larreta
// SPDX-License-Identifier: LicenseRef-Proprietary

'use strict';

// #7634 · C1/C2/C3/D3/D4 — módulo hoja del sentinel, neutralización de disco
// por scope ausente y detección de secretos por forma de valor.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const cs = require('../credential-sentinel');

// ─── C1 · módulo hoja, sin duplicado ─────────────────────────────────────────

test('C1 · credential-sentinel es módulo hoja: en un proceso limpio no carga credentials/config-resolver/redact', () => {
    const script = `
        require(${JSON.stringify(path.join(__dirname, '..', 'credential-sentinel.js'))});
        const cargados = Object.keys(require.cache).map((p) => require('path').basename(p));
        process.stdout.write(JSON.stringify(cargados));
    `;
    // Sin NODE_OPTIONS: los --require globales del host (p. ej. force-windows-hide) no son parte del módulo.
    const r = spawnSync(process.execPath, ['-e', script], {
        encoding: 'utf8', timeout: 20000, env: { ...process.env, NODE_OPTIONS: '' },
    });
    assert.equal(r.status, 0, r.stderr);
    const cargados = JSON.parse(r.stdout);
    assert.deepEqual(cargados, ['credential-sentinel.js']);
});

test('C1 · el require del módulo sólo usa node:path y node:os', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'credential-sentinel.js'), 'utf8');
    const reqs = [...src.matchAll(/require\(\s*'([^']+)'\s*\)/g)].map((m) => m[1]).sort();
    assert.deepEqual(reqs, ['node:os', 'node:path']);
});

test('C1 · credenciales-ambiente re-exporta la MISMA referencia (no hay duplicado)', () => {
    const ca = require('../credenciales-ambiente');
    assert.equal(ca._internal.SENTINEL_SIN_DIR, cs.SENTINEL_SIN_DIR);
    const src = fs.readFileSync(path.join(__dirname, '..', 'credenciales-ambiente.js'), 'utf8');
    assert.doesNotMatch(src, /function pareceToken\(/, 'pareceToken no se redefine');
    assert.doesNotMatch(src, /function sentinel\(/, 'sentinel no se redefine');
    assert.doesNotMatch(src, /\.intrale-pipeline/, 'la raíz del sentinel vive en un solo lugar');
});

test('C1 · build-child-env usa el neutralizador del módulo hoja', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'build-child-env.js'), 'utf8');
    assert.match(src, /require\('\.\/credential-sentinel'\)/);
    assert.match(src, /credentialSentinel\.neutralizarDisco\(/);
});

// ─── C2 · AWS ────────────────────────────────────────────────────────────────

test('C2 · rol sin aws: se quitan todas las variables de la cadena de credenciales (cualquier grafía)', () => {
    const env = {
        PATH: '/p',
        AWS_PROFILE: 'x', aws_default_profile: 'x', AWS_ACCESS_KEY_ID: 'x', AWS_SECRET_ACCESS_KEY: 'x',
        AWS_SESSION_TOKEN: 'x', AWS_WEB_IDENTITY_TOKEN_FILE: 'x', Aws_Role_Arn: 'x',
        AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: 'x', aws_container_credentials_full_uri: 'x',
        aws_shared_credentials_file: '/home/op/.aws/credentials', AWS_REGION: 'us-east-2',
    };
    cs.neutralizarDisco(env, { aws: true, github: false });
    assert.deepEqual(Object.keys(env).sort(), [
        'AWS_CONFIG_FILE', 'AWS_EC2_METADATA_DISABLED', 'AWS_REGION', 'AWS_SHARED_CREDENTIALS_FILE', 'PATH',
    ]);
    assert.equal(env.AWS_SHARED_CREDENTIALS_FILE, cs.SENTINEL_AWS);
    assert.equal(env.AWS_CONFIG_FILE, cs.SENTINEL_AWS);
    assert.equal(env.AWS_EC2_METADATA_DISABLED, 'true');
    assert.ok(env.AWS_SHARED_CREDENTIALS_FILE.startsWith(cs.SENTINEL_SIN_DIR));
});

test('C2 · rol CON aws: el neutralizador no toca AWS', () => {
    const env = { AWS_ACCESS_KEY_ID: 'x', AWS_PROFILE: 'p' };
    cs.neutralizarDisco(env, { aws: false, github: true });
    assert.equal(env.AWS_ACCESS_KEY_ID, 'x');
    assert.equal(env.AWS_PROFILE, 'p');
    assert.equal(env.AWS_SHARED_CREDENTIALS_FILE, undefined);
});

// ─── C3 · GitHub ─────────────────────────────────────────────────────────────

test('C3 · rol sin github: se quitan GH_TOKEN/GITHUB_TOKEN/GH_ENTERPRISE_TOKEN/GITHUB_ENTERPRISE_TOKEN y GH_CONFIG_DIR va a ruta inexistente', () => {
    const env = {
        GH_TOKEN: 'x', github_token: 'x', GH_ENTERPRISE_TOKEN: 'x', GITHUB_ENTERPRISE_TOKEN: 'x',
        gh_config_dir: '/home/op/.config/gh', PATH: '/p',
    };
    cs.neutralizarDisco(env, { aws: false, github: true });
    assert.deepEqual(Object.keys(env).sort(), ['GH_CONFIG_DIR', 'PATH']);
    assert.equal(env.GH_CONFIG_DIR, cs.SENTINEL_GH_CONFIG);
    assert.equal(fs.existsSync(env.GH_CONFIG_DIR), false, 'la ruta sentinel no existe');
});

test('C3 · neutralizarDisco nunca crea directorios (sin mkdirSync)', () => {
    const original = fs.mkdirSync;
    let llamadas = 0;
    fs.mkdirSync = (...a) => { llamadas += 1; return original.apply(fs, a); };
    try {
        cs.neutralizarDisco({}, { aws: true, github: true });
    } finally {
        fs.mkdirSync = original;
    }
    assert.equal(llamadas, 0);
    assert.equal(fs.existsSync(cs.SENTINEL_GH_CONFIG), false);
    assert.equal(fs.existsSync(cs.SENTINEL_AWS), false);
    const src = fs.readFileSync(path.join(__dirname, '..', 'credential-sentinel.js'), 'utf8');
    assert.doesNotMatch(src, /\bmkdir\w*\s*\(/, 'ninguna llamada a mkdir*');
});

test('C3 · buildChildEnv: después de construir el env la ruta de GH_CONFIG_DIR sigue sin existir', () => {
    const env = require('../build-child-env').buildChildEnv({
        skill: 'linter', fase: 'linteo', warn: () => {},
        processEnv: { PIPELINE_AMBIENTE: 'productivo', PATH: '/p', GH_TOKEN: 'x' },
        skillConfigOverride: { skill: { provider: 'deterministic', requires_credentials: [] }, providers: {} },
    });
    assert.equal(env.GH_TOKEN, undefined);
    assert.equal(fs.existsSync(env.GH_CONFIG_DIR), false);
});

// ─── D3 · formas de secreto ──────────────────────────────────────────────────

// Fixtures armados por concatenación en runtime: el repo es público y el
// secret-scan no acepta literales con forma de credencial (ni siquiera falsos).
const j = (...p) => p.join('');
const A30 = 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5';
const POSITIVOS = [
    ['AKIA', j('AK', 'IA', 'ABCDEFGHIJKLMNOP'), 'aws-access-key'],
    ['ASIA', j('AS', 'IA', 'ABCDEFGHIJKLMNOP'), 'aws-access-key'],
    ['ghp_', j('gh', 'p_', A30, 'xy'), 'github-token'],
    ['gho_', j('gh', 'o_', A30, 'xy'), 'github-token'],
    ['ghu_', j('gh', 'u_', A30, 'xy'), 'github-token'],
    ['ghs_', j('gh', 's_', A30, 'xy'), 'github-token'],
    ['ghr_', j('gh', 'r_', A30, 'xy'), 'github-token'],
    ['github_pat_', j('github', '_pat_', '11ABCDEFG0123456789_abcdefghijklmnop'), 'github-token'],
    ['sk-', j('sk', '-', 'abcdefghijklmnopqrstuvwx'), 'provider-key'],
    ['sk-ant-', j('sk', '-ant-', 'api03-abcdefghijklmnopqrstuvwx'), 'provider-key'],
    ['sk-proj-', j('sk', '-proj-', 'abcdefghijklmnopqrstuvwx'), 'provider-key'],
    ['AIza', j('AI', 'za', 'SyA1234567890abcdefghijklmnopqrstuv'), 'provider-key'],
    ['JWT', j('eyJhbGciOiJIUzI1NiJ9', '.', 'eyJzdWIiOiIxMjM0NTY3ODkwIn0', '.', 'dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk'), 'jwt'],
    ['Telegram', j('123456789', ':', 'AAHfakeTelegramTokenForTests_abcdef'), 'telegram-token'],
];

for (const [nombre, valor, kind] of POSITIVOS) {
    test(`D3 · looksLikeSecret detecta ${nombre} → ${kind}`, () => {
        assert.equal(cs.looksLikeSecret(valor), kind);
    });
}

test('D3 · negativos: sk sin guion, UUID, path con puntos, texto, número, no-string', () => {
    for (const v of [
        'skabcdefghijklmnopqrstuvwx',
        '123e4567-e89b-12d3-a456-426614174000',
        'C:\\Users\\op\\archivo.config.backup',
        'config.settings.json',
        'us-east-2',
        'productivo',
        '/usr/bin:/bin',
        'AKIA1234',
        '',
        undefined,
        null,
        12345,
    ]) {
        assert.equal(cs.looksLikeSecret(v), null, String(v));
    }
});

test('D3 · SECRET_KINDS es un enum cerrado que coincide con los kinds del error', () => {
    const { KINDS } = require('../child-env-error');
    for (const k of cs.SECRET_KINDS) assert.ok(KINDS.includes(k), k);
});

// ─── D4 · anti-ReDoS ─────────────────────────────────────────────────────────

test('D4 · un valor de 1 MB armado a propósito se evalúa en menos de 100 ms', () => {
    const payloads = [
        'a'.repeat(1024 * 1024),
        'A'.repeat(1024 * 1024) + '!',
        ('abcdefgh.'.repeat(120000)),
        'sk-' + '-'.repeat(1024 * 1024),
        '1'.repeat(1024 * 1024) + ':x',
    ];
    for (const p of payloads) {
        const t0 = process.hrtime.bigint();
        cs.looksLikeSecret(p);
        const ms = Number(process.hrtime.bigint() - t0) / 1e6;
        assert.ok(ms < 100, `tardó ${ms.toFixed(1)} ms`);
    }
});

test('D4 · regex anclados y sin cuantificadores anidados', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'credential-sentinel.js'), 'utf8');
    assert.doesNotMatch(src, /\.\*/, 'sin .*');
    assert.doesNotMatch(src, /\)[+*]\)?[+*]/, 'sin cuantificadores anidados');
    assert.equal(cs.MAX_SCAN, 512);
});
