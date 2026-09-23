'use strict';

// #7634 · C4/C5/E2 — orden fijo del camino ON de `buildChildEnv` y separación
// entre el warn de fase ausente (buildChildEnv) y el throw (assert).

const { test } = require('node:test');
const assert = require('node:assert/strict');

const lib = require('../build-child-env');
const cs = require('../credential-sentinel');

const TOKEN_STORE = 'token-del-store-fixture-7634';

function operatorEnv(extra = {}) {
    return {
        PIPELINE_AMBIENTE: 'productivo',
        PATH: '/usr/bin',
        ANTHROPIC_API_KEY: 'fake-anthropic-7634',
        AWS_ACCESS_KEY_ID: 'fake-aws-id-7634',
        AWS_SECRET_ACCESS_KEY: 'fake-aws-secret-7634',
        AWS_PROFILE: 'default',
        GH_TOKEN: 'fake-gh-7634',
        ...extra,
    };
}

function build(opts = {}) {
    return lib.buildChildEnv({ skill: 'guru', fase: 'analisis', warn: () => {}, processEnv: operatorEnv(), ...opts });
}

// ─── C4 ─────────────────────────────────────────────────────────────────────

test('C4 · rol CON github y sin GH_TOKEN en el env: lo recibe de githubTokenSource y NO se le redirige GH_CONFIG_DIR', () => {
    const pe = operatorEnv();
    delete pe.GH_TOKEN;
    let llamadas = 0;
    const env = build({ processEnv: pe, githubTokenSource: () => { llamadas += 1; return TOKEN_STORE; } });
    assert.equal(llamadas, 1);
    assert.equal(env.GH_TOKEN, TOKEN_STORE);
    assert.equal(env.GH_CONFIG_DIR, undefined, 'con scope github no se neutraliza el disco de gh');
});

test('C4 · si el env del intento ya trae GH_TOKEN, gana ése y no se consulta la fuente', () => {
    let llamadas = 0;
    const env = build({ githubTokenSource: () => { llamadas += 1; return TOKEN_STORE; } });
    assert.equal(llamadas, 0);
    assert.equal(env.GH_TOKEN, 'fake-gh-7634');
});

test('C4 · rol SIN github: la fuente no se consulta, GH_TOKEN no llega y GH_CONFIG_DIR va al sentinel', () => {
    let llamadas = 0;
    const env = lib.buildChildEnv({
        skill: 'build', fase: 'build', warn: () => {}, processEnv: operatorEnv(),
        skillConfigOverride: { skill: { provider: 'deterministic', requires_credentials: ['gradle-android'] }, providers: {} },
        githubTokenSource: () => { llamadas += 1; return TOKEN_STORE; },
    });
    assert.equal(llamadas, 0);
    assert.equal(env.GH_TOKEN, undefined);
    assert.equal(env.GH_CONFIG_DIR, cs.SENTINEL_GH_CONFIG);
});

test('C4 · el token no se loguea: warn nunca recibe su valor', () => {
    const pe = operatorEnv();
    delete pe.GH_TOKEN;
    const logs = [];
    build({ processEnv: pe, fase: undefined, assertMinimal: false, warn: (m) => logs.push(m), githubTokenSource: () => TOKEN_STORE });
    build({ processEnv: pe, warn: (m) => logs.push(m), githubTokenSource: () => TOKEN_STORE });
    for (const l of logs) assert.equal(l.includes(TOKEN_STORE), false);
});

// ─── C5 ─────────────────────────────────────────────────────────────────────

test('C5 · una extra que intenta pisar AWS_SHARED_CREDENTIALS_FILE no gana (rol sin aws)', () => {
    const env = build({ pipelineExtras: { AWS_SHARED_CREDENTIALS_FILE: 'C:/Users/op/.aws/credentials' } });
    assert.equal(env.AWS_SHARED_CREDENTIALS_FILE, cs.SENTINEL_AWS);
    assert.equal(env.AWS_CONFIG_FILE, cs.SENTINEL_AWS);
    assert.equal(env.AWS_EC2_METADATA_DISABLED, 'true');
});

test('C5 · tampoco gana con otra grafía de mayúsculas ni pisando GH_CONFIG_DIR en un rol sin github', () => {
    const env = lib.buildChildEnv({
        skill: 'linter', fase: 'linteo', warn: () => {}, processEnv: operatorEnv(),
        skillConfigOverride: { skill: { provider: 'deterministic', requires_credentials: [] }, providers: {} },
        pipelineExtras: { aws_shared_credentials_file: '/op/.aws/credentials', gh_config_dir: '/op/.config/gh', GH_TOKEN: 'x' },
    });
    assert.equal(env.AWS_SHARED_CREDENTIALS_FILE, cs.SENTINEL_AWS);
    assert.equal(env.aws_shared_credentials_file, undefined);
    assert.equal(env.GH_CONFIG_DIR, cs.SENTINEL_GH_CONFIG);
    assert.equal(env.gh_config_dir, undefined);
    assert.equal(env.GH_TOKEN, undefined);
});

test('C5 · rol sin aws: no le llegan AWS_PROFILE/AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY', () => {
    const env = build();
    for (const k of ['AWS_PROFILE', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY']) assert.equal(env[k], undefined, k);
});

test('C5 · rol CON aws (backend-dev en dev) conserva su credencial y no recibe sentinel de AWS', () => {
    const env = lib.buildChildEnv({ skill: 'backend-dev', fase: 'dev', warn: () => {}, processEnv: operatorEnv() });
    assert.equal(env.AWS_ACCESS_KEY_ID, 'fake-aws-id-7634');
    assert.equal(env.AWS_SHARED_CREDENTIALS_FILE, undefined);
    assert.equal(env.GH_TOKEN, 'fake-gh-7634');
});

test('C5 · el assert corre sobre el env FINAL: una extra no declarada (post-merge) tira', () => {
    assert.throws(() => build({ pipelineExtras: { EXTRA_NO_DECLARADA: 'x' } }), (e) => e.code === 'CHILD_ENV_VIOLATION');
});

test('C5 · las extras de transporte que hoy manda el Pulpo no tiran', () => {
    const env = build({
        pipelineExtras: {
            PIPELINE_ISSUE: '7634', PIPELINE_REPO_ROOT: '/repo', PROVIDER_RESOLUTION_LOG: 'anthropic elegido',
            QA_MODE: 'api', QA_ISSUE: '7634', CLAUDE_PROJECT_DIR: '/repo', CODEX_MODEL: 'x',
        },
    });
    assert.equal(env.PIPELINE_ISSUE, '7634');
    assert.equal(env.PIPELINE_AMBIENTE, 'productivo');
});

// ─── E2 ─────────────────────────────────────────────────────────────────────

test('E2 · fase ausente con assertMinimal:false → warn + techo vacío (comportamiento previo)', () => {
    const logs = [];
    const env = build({ fase: undefined, assertMinimal: false, warn: (m) => logs.push(m) });
    assert.equal(logs.length, 1);
    assert.match(logs[0], /fase '\(ausente\)' sin techo declarado/);
    assert.equal(env.GH_TOKEN, undefined, 'techo vacío: sin github');
});

test('E2 · fase ausente con assertMinimal:true (default) → warn Y throw CHILD_ENV_VIOLATION (unknown-phase)', () => {
    const logs = [];
    assert.throws(
        () => build({ fase: undefined, warn: (m) => logs.push(m) }),
        (e) => e.code === 'CHILD_ENV_VIOLATION' && e.details.causas.some((c) => c.kind === 'unknown-phase'),
    );
    assert.equal(logs.length, 1, 'el warn de buildChildEnv sigue ocurriendo antes del assert');
});

test('E2 · el bloque de fase desconocida de buildChildEnv NO tira por sí mismo', () => {
    assert.doesNotThrow(() => build({ fase: 'inexistente', assertMinimal: false }));
});
