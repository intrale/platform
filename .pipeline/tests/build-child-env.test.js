// =============================================================================
// build-child-env.test.js — Tests del helper de aislamiento de credenciales
// (#3085 / S7 multi-provider).
//
// Cubre todos los CAs verificables del issue (CA-1 a CA-12) cuando aplica
// como código:
//   - CA-2: SYSTEM_ALLOWLIST mínima Windows-compatible.
//   - CA-3: provider Anthropic NO recibe OPENAI_API_KEY (y viceversa).
//   - CA-4: scopes (`github`, `aws`, `gradle-android`, `telegram-hooks`)
//           gobernados por `requires_credentials`.
//   - CA-5: fail-fast accionable cuando la API key del provider falta.
//   - CA-7: tests adicionales de regresión (PIPELINE_*, vars desconocidas
//           NO leakean, scope desconocido throwa, telegram siempre on).
//   - CA-10: auditDroppedEnvVars devuelve keys + hashes sin valores.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    buildChildEnv,
    auditDroppedEnvVars,
    formatAuditLogEntry,
    SYSTEM_ALLOWLIST,
    CREDENTIAL_SCOPES,
    SCOPES_ALWAYS_ON,
    DEFAULT_REQUIRES_BY_SKILL,
    PROVIDER_DEFAULT_CREDENTIAL_ENV,
} = require('../lib/build-child-env');

// -----------------------------------------------------------------------------
// Helpers — env "completo" del operador (worst case con TODAS las creds).
// -----------------------------------------------------------------------------
function fullOperatorEnv(extra = {}) {
    return {
        // System (Windows + Unix)
        PATH: '/usr/bin:/bin',
        PATHEXT: '.COM;.EXE;.BAT;.CMD',
        HOME: '/home/op',
        USERPROFILE: 'C:\\Users\\op',
        USERNAME: 'op',
        APPDATA: 'C:\\Users\\op\\AppData\\Roaming',
        LOCALAPPDATA: 'C:\\Users\\op\\AppData\\Local',
        PROGRAMFILES: 'C:\\Program Files',
        'PROGRAMFILES(X86)': 'C:\\Program Files (x86)',
        PROGRAMDATA: 'C:\\ProgramData',
        SystemRoot: 'C:\\Windows',
        ComSpec: 'C:\\Windows\\System32\\cmd.exe',
        WINDIR: 'C:\\Windows',
        TEMP: 'C:\\Users\\op\\AppData\\Local\\Temp',
        TMP: 'C:\\Users\\op\\AppData\\Local\\Temp',
        LANG: 'es_AR.UTF-8',
        NODE_PATH: '/usr/lib/node',
        NODE_OPTIONS: '--max-old-space-size=4096',

        // PIPELINE_* (siempre van)
        PIPELINE_ROOT: '/repo',
        PIPELINE_LOG_LEVEL: 'info',

        // API keys de los dos providers
        ANTHROPIC_API_KEY: 'sk-ant-api-XXXXX',
        OPENAI_API_KEY: 'sk-openai-XXXXX',

        // GitHub (scope github)
        GH_TOKEN: 'ghp_XXXXX',
        GITHUB_TOKEN: 'ghs_XXXXX',

        // AWS (scope aws)
        AWS_ACCESS_KEY_ID: 'AKIAXXXX',
        AWS_SECRET_ACCESS_KEY: 'secret-XXXX',
        AWS_SESSION_TOKEN: 'session-XXXX',
        AWS_REGION: 'us-east-1',
        AWS_PROFILE: 'default',

        // Gradle / Android (scope gradle-android)
        JAVA_HOME: 'C:\\Java\\jdk21',
        GRADLE_USER_HOME: 'C:\\Users\\op\\.gradle',
        ANDROID_HOME: 'C:\\Android\\Sdk',
        ANDROID_SDK_ROOT: 'C:\\Android\\Sdk',
        ANDROID_AVD_HOME: 'C:\\Users\\op\\.android\\avd',

        // Telegram (scope telegram-hooks — always-on)
        TELEGRAM_BOT_TOKEN: 'tg-bot-XXXX',
        TELEGRAM_CHAT_ID: '12345',

        // Variables que NUNCA deben llegar al child
        CONTEXT7_API_KEY: 'ctx-XXXX',
        SOME_RANDOM_VAR: 'foo',
        MY_PRIVATE_DATA: 'bar',
        SLACK_TOKEN: 'xoxb-XXXX',

        ...extra,
    };
}

// =============================================================================
// CA-2 — SYSTEM_ALLOWLIST Windows-compatible
// =============================================================================
test('CA-2: las variables Windows críticas (SystemRoot, ComSpec, PATHEXT) siempre llegan al child', () => {
    const env = buildChildEnv({
        skill: 'guru',
        processEnv: fullOperatorEnv(),
    });
    assert.equal(env.SystemRoot, 'C:\\Windows');
    assert.equal(env.ComSpec, 'C:\\Windows\\System32\\cmd.exe');
    assert.equal(env.PATHEXT, '.COM;.EXE;.BAT;.CMD');
    assert.equal(env.PATH, '/usr/bin:/bin');
    assert.equal(env.WINDIR, 'C:\\Windows');
    assert.equal(env.TEMP, 'C:\\Users\\op\\AppData\\Local\\Temp');
    assert.equal(env.TMP, 'C:\\Users\\op\\AppData\\Local\\Temp');
    assert.equal(env.APPDATA, 'C:\\Users\\op\\AppData\\Roaming');
    assert.equal(env.LOCALAPPDATA, 'C:\\Users\\op\\AppData\\Local');
});

test('CA-2: NODE_PATH y NODE_OPTIONS llegan al child', () => {
    const env = buildChildEnv({
        skill: 'guru',
        processEnv: fullOperatorEnv(),
    });
    assert.equal(env.NODE_PATH, '/usr/lib/node');
    assert.equal(env.NODE_OPTIONS, '--max-old-space-size=4096');
});

test('CA-2: SYSTEM_ALLOWLIST es immutable y exportada', () => {
    assert.equal(Object.isFrozen(SYSTEM_ALLOWLIST), true);
    assert.ok(SYSTEM_ALLOWLIST.includes('SystemRoot'));
    assert.ok(SYSTEM_ALLOWLIST.includes('ComSpec'));
    assert.ok(SYSTEM_ALLOWLIST.includes('PATHEXT'));
});

// =============================================================================
// CA-3 — Inyección selectiva de la API key del provider declarado
// =============================================================================
test('CA-3: skill Anthropic recibe ANTHROPIC_API_KEY pero NO OPENAI_API_KEY', () => {
    const env = buildChildEnv({
        skill: 'guru',
        processEnv: fullOperatorEnv(),
        skillConfigOverride: {
            skill: { provider: 'anthropic' },
            providers: { anthropic: { credentials_env: 'ANTHROPIC_API_KEY' } },
        },
    });
    assert.equal(env.ANTHROPIC_API_KEY, 'sk-ant-api-XXXXX');
    assert.equal(env.OPENAI_API_KEY, undefined);
});

test('CA-3: skill OpenAI recibe OPENAI_API_KEY pero NO ANTHROPIC_API_KEY', () => {
    const env = buildChildEnv({
        skill: 'qa',
        processEnv: fullOperatorEnv(),
        skillConfigOverride: {
            skill: { provider: 'openai-codex', requires_credentials: ['gradle-android', 'aws', 'github'] },
            providers: { 'openai-codex': { credentials_env: 'OPENAI_API_KEY' } },
        },
    });
    assert.equal(env.OPENAI_API_KEY, 'sk-openai-XXXXX');
    assert.equal(env.ANTHROPIC_API_KEY, undefined);
});

test('CA-3: skill determinístico no recibe ninguna API key del LLM', () => {
    const env = buildChildEnv({
        skill: 'builder',
        processEnv: fullOperatorEnv(),
        skillConfigOverride: {
            skill: { provider: 'deterministic', requires_credentials: ['gradle-android'] },
            providers: {},
        },
    });
    assert.equal(env.ANTHROPIC_API_KEY, undefined);
    assert.equal(env.OPENAI_API_KEY, undefined);
    // Pero SÍ recibe sus scopes propios (gradle-android)
    assert.equal(env.JAVA_HOME, 'C:\\Java\\jdk21');
    assert.equal(env.GRADLE_USER_HOME, 'C:\\Users\\op\\.gradle');
});

// =============================================================================
// CA-4 — Schema requires_credentials por skill
// =============================================================================
test('CA-4: scope github inyecta GH_TOKEN + GITHUB_TOKEN en skills que lo declaran', () => {
    const env = buildChildEnv({
        skill: 'security',
        processEnv: fullOperatorEnv(),
        skillConfigOverride: {
            skill: { provider: 'anthropic', requires_credentials: ['github'] },
            providers: { anthropic: { credentials_env: 'ANTHROPIC_API_KEY' } },
        },
    });
    assert.equal(env.GH_TOKEN, 'ghp_XXXXX');
    assert.equal(env.GITHUB_TOKEN, 'ghs_XXXXX');
});

test('CA-4: scope aws inyecta TODAS las AWS_* en skills que lo declaran', () => {
    const env = buildChildEnv({
        skill: 'qa',
        processEnv: fullOperatorEnv(),
        skillConfigOverride: {
            skill: { provider: 'anthropic', requires_credentials: ['aws'] },
            providers: { anthropic: { credentials_env: 'ANTHROPIC_API_KEY' } },
        },
    });
    assert.equal(env.AWS_ACCESS_KEY_ID, 'AKIAXXXX');
    assert.equal(env.AWS_SECRET_ACCESS_KEY, 'secret-XXXX');
    assert.equal(env.AWS_SESSION_TOKEN, 'session-XXXX');
    assert.equal(env.AWS_REGION, 'us-east-1');
    assert.equal(env.AWS_PROFILE, 'default');
});

test('CA-4: scope gradle-android inyecta JAVA_HOME, GRADLE_USER_HOME, ANDROID_*', () => {
    const env = buildChildEnv({
        skill: 'builder',
        processEnv: fullOperatorEnv(),
        skillConfigOverride: {
            skill: { provider: 'deterministic', requires_credentials: ['gradle-android'] },
            providers: {},
        },
    });
    assert.equal(env.JAVA_HOME, 'C:\\Java\\jdk21');
    assert.equal(env.GRADLE_USER_HOME, 'C:\\Users\\op\\.gradle');
    assert.equal(env.ANDROID_HOME, 'C:\\Android\\Sdk');
    assert.equal(env.ANDROID_SDK_ROOT, 'C:\\Android\\Sdk');
    assert.equal(env.ANDROID_AVD_HOME, 'C:\\Users\\op\\.android\\avd');
});

test('CA-4: skill SIN scope github NO recibe GH_TOKEN', () => {
    const env = buildChildEnv({
        skill: 'someskill',
        processEnv: fullOperatorEnv(),
        skillConfigOverride: {
            skill: { provider: 'anthropic', requires_credentials: [] },
            providers: { anthropic: { credentials_env: 'ANTHROPIC_API_KEY' } },
        },
    });
    assert.equal(env.GH_TOKEN, undefined);
    assert.equal(env.GITHUB_TOKEN, undefined);
});

test('CA-4: skill SIN scope aws NO recibe AWS_*', () => {
    const env = buildChildEnv({
        skill: 'guru',
        processEnv: fullOperatorEnv(),
        skillConfigOverride: {
            skill: { provider: 'anthropic', requires_credentials: ['github'] },
            providers: { anthropic: { credentials_env: 'ANTHROPIC_API_KEY' } },
        },
    });
    assert.equal(env.AWS_ACCESS_KEY_ID, undefined);
    assert.equal(env.AWS_SECRET_ACCESS_KEY, undefined);
    assert.equal(env.AWS_SESSION_TOKEN, undefined);
});

test('CA-4: skill con scope desconocido throwa con mensaje accionable', () => {
    assert.throws(
        () => buildChildEnv({
            skill: 'guru',
            processEnv: fullOperatorEnv(),
            skillConfigOverride: {
                skill: { provider: 'anthropic', requires_credentials: ['inexistente'] },
                providers: { anthropic: { credentials_env: 'ANTHROPIC_API_KEY' } },
            },
        }),
        /Scope desconocido 'inexistente'/,
    );
});

test('CA-4 (telegram-hooks always-on): TELEGRAM_BOT_TOKEN llega a TODOS los childs', () => {
    // Aún cuando el skill no declara telegram-hooks, los hooks de Claude Code
    // (agent-concurrency-check.js, worktree-guard.js) lo necesitan.
    const env = buildChildEnv({
        skill: 'guru',
        processEnv: fullOperatorEnv(),
        skillConfigOverride: {
            skill: { provider: 'anthropic', requires_credentials: [] },
            providers: { anthropic: { credentials_env: 'ANTHROPIC_API_KEY' } },
        },
    });
    assert.equal(env.TELEGRAM_BOT_TOKEN, 'tg-bot-XXXX');
    assert.equal(env.TELEGRAM_CHAT_ID, '12345');
});

test('CA-4: SCOPES_ALWAYS_ON contiene telegram-hooks', () => {
    assert.ok(SCOPES_ALWAYS_ON.includes('telegram-hooks'));
});

// =============================================================================
// CA-5 — Fail-fast accionable
// =============================================================================
test('CA-5: skill con provider y key faltante en processEnv throwa con mensaje accionable', () => {
    const envSinKey = fullOperatorEnv();
    delete envSinKey.OPENAI_API_KEY;
    assert.throws(
        () => buildChildEnv({
            skill: 'qa',
            processEnv: envSinKey,
            skillConfigOverride: {
                skill: { provider: 'openai-codex' },
                providers: { 'openai-codex': { credentials_env: 'OPENAI_API_KEY' } },
            },
        }),
        (err) => {
            assert.match(err.message, /Skill 'qa' configurado para provider 'openai-codex'/);
            assert.match(err.message, /OPENAI_API_KEY no está en el env del pulpo/);
            assert.match(err.message, /Definila como variable de entorno/);
            assert.match(err.message, /pipeline-multi-provider\.md/);
            return true;
        },
    );
});

test('CA-5: skill Anthropic sin ANTHROPIC_API_KEY (default) throwa', () => {
    const envSinKey = fullOperatorEnv();
    delete envSinKey.ANTHROPIC_API_KEY;
    // Sin override: el default es provider=anthropic con default credential ANTHROPIC_API_KEY.
    assert.throws(
        () => buildChildEnv({
            skill: 'guru',
            processEnv: envSinKey,
        }),
        /ANTHROPIC_API_KEY no está en el env del pulpo/,
    );
});

test('CA-5: skill determinístico SIN API key NO throwa (no necesita LLM)', () => {
    const envSinKeys = fullOperatorEnv();
    delete envSinKeys.ANTHROPIC_API_KEY;
    delete envSinKeys.OPENAI_API_KEY;
    const env = buildChildEnv({
        skill: 'builder',
        processEnv: envSinKeys,
        skillConfigOverride: {
            skill: { provider: 'deterministic', requires_credentials: ['gradle-android'] },
            providers: {},
        },
    });
    assert.equal(env.ANTHROPIC_API_KEY, undefined);
    assert.equal(env.OPENAI_API_KEY, undefined);
    assert.equal(env.JAVA_HOME, 'C:\\Java\\jdk21');
});

// =============================================================================
// CA-7 — Tests adicionales de regresión
// =============================================================================
test('CA-7: TODAS las PIPELINE_* del processEnv llegan al child', () => {
    const env = buildChildEnv({
        skill: 'guru',
        processEnv: {
            ...fullOperatorEnv(),
            PIPELINE_FOO: 'foo-val',
            PIPELINE_BAR: 'bar-val',
            PIPELINE_VERY_NESTED_NAME: 'nested',
        },
    });
    assert.equal(env.PIPELINE_ROOT, '/repo');
    assert.equal(env.PIPELINE_LOG_LEVEL, 'info');
    assert.equal(env.PIPELINE_FOO, 'foo-val');
    assert.equal(env.PIPELINE_BAR, 'bar-val');
    assert.equal(env.PIPELINE_VERY_NESTED_NAME, 'nested');
});

test('CA-7: variables NO listadas en allowlist/scopes NO leakean', () => {
    const env = buildChildEnv({
        skill: 'guru',
        processEnv: fullOperatorEnv(),
    });
    assert.equal(env.SOME_RANDOM_VAR, undefined);
    assert.equal(env.MY_PRIVATE_DATA, undefined);
    assert.equal(env.CONTEXT7_API_KEY, undefined);
    assert.equal(env.SLACK_TOKEN, undefined);
});

test('CA-7: pipelineExtras se mezclan al final (caller controla últimos overrides)', () => {
    const env = buildChildEnv({
        skill: 'guru',
        processEnv: fullOperatorEnv(),
        pipelineExtras: {
            PIPELINE_ISSUE: '1234',
            PIPELINE_SKILL: 'guru',
            PIPELINE_HANDOFF_PATH: '/repo/.pipeline/handoff/1234.md',
        },
    });
    assert.equal(env.PIPELINE_ISSUE, '1234');
    assert.equal(env.PIPELINE_SKILL, 'guru');
    assert.equal(env.PIPELINE_HANDOFF_PATH, '/repo/.pipeline/handoff/1234.md');
});

test('CA-7: pipelineExtras puede sobreescribir un PIPELINE_* del processEnv', () => {
    const env = buildChildEnv({
        skill: 'guru',
        processEnv: { ...fullOperatorEnv(), PIPELINE_ISSUE: 'old' },
        pipelineExtras: { PIPELINE_ISSUE: 'new' },
    });
    assert.equal(env.PIPELINE_ISSUE, 'new');
});

test('CA-7: skill no string lanza error', () => {
    assert.throws(
        () => buildChildEnv({ skill: null, processEnv: fullOperatorEnv() }),
        /parámetro "skill" requerido/,
    );
    assert.throws(
        () => buildChildEnv({ processEnv: fullOperatorEnv() }),
        /parámetro "skill" requerido/,
    );
});

test('CA-7: defaults hardcoded (DEFAULT_REQUIRES_BY_SKILL) aplican cuando no hay agent-models.json', () => {
    // Sin override y sin pipelineDir → usa defaults por skill.
    const envSec = buildChildEnv({
        skill: 'security',
        processEnv: fullOperatorEnv(),
    });
    // security tiene default ['github']
    assert.equal(envSec.GH_TOKEN, 'ghp_XXXXX');
    assert.equal(envSec.GITHUB_TOKEN, 'ghs_XXXXX');
    assert.equal(envSec.AWS_ACCESS_KEY_ID, undefined);

    const envBuilder = buildChildEnv({
        skill: 'builder',
        processEnv: fullOperatorEnv(),
    });
    // builder tiene default ['gradle-android']
    assert.equal(envBuilder.JAVA_HOME, 'C:\\Java\\jdk21');
    assert.equal(envBuilder.GH_TOKEN, undefined);
});

test('CA-7: skill desconocido sin defaults solo recibe SYSTEM + PIPELINE_* + telegram-hooks + provider key', () => {
    const env = buildChildEnv({
        skill: 'totally-unknown-skill',
        processEnv: fullOperatorEnv(),
    });
    // SYSTEM
    assert.equal(env.PATH, '/usr/bin:/bin');
    assert.equal(env.SystemRoot, 'C:\\Windows');
    // Provider key (default anthropic)
    assert.equal(env.ANTHROPIC_API_KEY, 'sk-ant-api-XXXXX');
    assert.equal(env.OPENAI_API_KEY, undefined);
    // Always-on telegram
    assert.equal(env.TELEGRAM_BOT_TOKEN, 'tg-bot-XXXX');
    // NO scope vars (no defaults para este skill, no scopes declarados)
    assert.equal(env.GH_TOKEN, undefined);
    assert.equal(env.AWS_ACCESS_KEY_ID, undefined);
    assert.equal(env.JAVA_HOME, undefined);
});

test('CA-7: lectura de agent-models.json fallida (JSON inválido) cae a defaults sin tirar', () => {
    const fakeFs = {
        existsSync: () => true,
        readFileSync: () => 'not valid json {',
    };
    const env = buildChildEnv({
        skill: 'security',
        pipelineDir: '/fake/.pipeline',
        fsImpl: fakeFs,
        processEnv: fullOperatorEnv(),
    });
    // Cae a defaults: security default = ['github']
    assert.equal(env.GH_TOKEN, 'ghp_XXXXX');
});

test('CA-7: agent-models.json válido OVERRIDE los defaults hardcoded', () => {
    const fakeFs = {
        existsSync: () => true,
        readFileSync: () => JSON.stringify({
            providers: {
                anthropic: { credentials_env: 'ANTHROPIC_API_KEY' },
            },
            skills: {
                security: { provider: 'anthropic', requires_credentials: ['aws'] }, // override: aws en lugar de github
            },
        }),
    };
    const env = buildChildEnv({
        skill: 'security',
        pipelineDir: '/fake/.pipeline',
        fsImpl: fakeFs,
        processEnv: fullOperatorEnv(),
    });
    assert.equal(env.GH_TOKEN, undefined); // ya NO está
    assert.equal(env.AWS_ACCESS_KEY_ID, 'AKIAXXXX'); // sí está (override)
});

test('CA-7: el resultado es un objeto plano (no Object.create(null) leakeado al caller)', () => {
    // El return final hace `{ ...out, ...pipelineExtras }` que produce {} normal.
    const env = buildChildEnv({
        skill: 'guru',
        processEnv: fullOperatorEnv(),
    });
    assert.equal(typeof env, 'object');
    // Tiene Object.prototype (necesario porque child_process.spawn usa Object.keys)
    assert.equal(typeof env.hasOwnProperty, 'function');
});

// =============================================================================
// CA-10 — Audit trail (sin valores, solo hashes truncados)
// =============================================================================
test('CA-10: auditDroppedEnvVars devuelve keys NO en allowlist con hash SHA-256-12', () => {
    const dropped = auditDroppedEnvVars({
        PATH: '/usr/bin', // allowed (system)
        ANTHROPIC_API_KEY: 'sk-ant-XXXX', // allowed (provider key)
        SOME_RANDOM_VAR: 'foo', // dropped
        ANOTHER_SECRET: 'bar', // dropped
        PIPELINE_ROOT: '/repo', // siempre allowed (PIPELINE_*)
    });
    const keys = dropped.map((d) => d.key);
    assert.ok(keys.includes('SOME_RANDOM_VAR'));
    assert.ok(keys.includes('ANOTHER_SECRET'));
    assert.ok(!keys.includes('PATH'));
    assert.ok(!keys.includes('ANTHROPIC_API_KEY'));
    assert.ok(!keys.includes('PIPELINE_ROOT'));
});

test('CA-10: auditDroppedEnvVars NO incluye los VALORES en el output (I-S2)', () => {
    const dropped = auditDroppedEnvVars({
        SOME_RANDOM_VAR: 'super-secret-value-do-not-leak',
    });
    const stringified = JSON.stringify(dropped);
    assert.ok(!stringified.includes('super-secret-value-do-not-leak'));
    assert.ok(!stringified.includes('do-not-leak'));
    // El hash SHA-256-12 sí está
    assert.equal(dropped[0].hash.length, 12);
    assert.match(dropped[0].hash, /^[0-9a-f]{12}$/);
});

test('CA-10: auditDroppedEnvVars devuelve lista alfabéticamente ordenada (DX, fácil diff)', () => {
    const dropped = auditDroppedEnvVars({
        ZEBRA: 'z',
        APPLE: 'a',
        MELON: 'm',
    });
    const keys = dropped.map((d) => d.key);
    assert.deepEqual(keys, ['APPLE', 'MELON', 'ZEBRA']);
});

test('CA-10: formatAuditLogEntry produce salida humano-legible con header de runtime', () => {
    const entry = formatAuditLogEntry({
        timestamp: '2026-05-07T14:30:00Z',
        pid: 1234,
        nodeVersion: 'v22.0.0',
        osInfo: 'win32-10.0.22631',
        dropped: [
            { key: 'APPLE', hash: 'aaaaaaaaaaaa' },
            { key: 'BANANA', hash: 'bbbbbbbbbbbb' },
        ],
    });
    assert.match(entry, /2026-05-07T14:30:00Z \[boot pid=1234 node=v22\.0\.0 os=win32-10\.0\.22631\]/);
    assert.match(entry, /APPLE.*aaaaaaaaaaaa/);
    assert.match(entry, /BANANA.*bbbbbbbbbbbb/);
});

test('CA-10: formatAuditLogEntry con dropped vacío indica "ninguna"', () => {
    const entry = formatAuditLogEntry({
        timestamp: '2026-05-07T14:30:00Z',
        pid: 1234,
        nodeVersion: 'v22.0.0',
        osInfo: 'win32',
        dropped: [],
    });
    assert.match(entry, /\(ninguna — env del operador limpio\)/);
});

// =============================================================================
// Tests defensivos adicionales (consistencia interna)
// =============================================================================
test('CREDENTIAL_SCOPES y PROVIDER_DEFAULT_CREDENTIAL_ENV están congelados', () => {
    assert.equal(Object.isFrozen(CREDENTIAL_SCOPES), true);
    assert.equal(Object.isFrozen(PROVIDER_DEFAULT_CREDENTIAL_ENV), true);
    // Y los arrays internos también
    assert.equal(Object.isFrozen(CREDENTIAL_SCOPES.github), true);
    assert.equal(Object.isFrozen(CREDENTIAL_SCOPES.aws), true);
});

test('DEFAULT_REQUIRES_BY_SKILL solo declara scopes que existen en CREDENTIAL_SCOPES', () => {
    const validScopes = new Set(Object.keys(CREDENTIAL_SCOPES));
    for (const [skill, scopes] of Object.entries(DEFAULT_REQUIRES_BY_SKILL)) {
        for (const sc of scopes) {
            assert.ok(
                validScopes.has(sc),
                `DEFAULT_REQUIRES_BY_SKILL[${skill}] declara scope inválido '${sc}'`,
            );
        }
    }
});
