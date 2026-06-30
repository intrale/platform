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
// #4306 — Providers OAuth/CLI login (auth_mode: 'oauth') no exigen ni inyectan key
// =============================================================================
test('#4306: skill con provider openai-codex (auth_mode oauth) SIN OPENAI_API_KEY → no throw + env sin la key', () => {
    const envSinKey = fullOperatorEnv();
    delete envSinKey.OPENAI_API_KEY;
    const env = buildChildEnv({
        skill: 'qa',
        processEnv: envSinKey,
        skillConfigOverride: {
            skill: { provider: 'openai-codex' },
            providers: { 'openai-codex': { launcher: 'codex', auth_mode: 'oauth', credentials_env: ['OPENAI_API_KEY'] } },
        },
    });
    // REQ-SEC-3 — no se inyecta la key OAuth al child.
    assert.equal(env.OPENAI_API_KEY, undefined);
    assert.equal(env.ANTHROPIC_API_KEY, undefined);
});

test('#4306: provider OAuth con la key PRESENTE tampoco la inyecta (env-isolation)', () => {
    const env = buildChildEnv({
        skill: 'qa',
        processEnv: fullOperatorEnv(), // incluye OPENAI_API_KEY
        skillConfigOverride: {
            skill: { provider: 'gemini-google' },
            providers: { 'gemini-google': { launcher: 'gemini-google', auth_mode: 'oauth', credentials_env: ['GEMINI_API_KEY'] } },
        },
    });
    assert.equal(env.OPENAI_API_KEY, undefined);
    assert.equal(env.GEMINI_API_KEY, undefined);
});

test('#4306: el fallback PROVIDER_DEFAULT_CREDENTIAL_ENV NO aplica a provider OAuth sin credentials_env', () => {
    const envSinKey = fullOperatorEnv();
    delete envSinKey.OPENAI_API_KEY;
    // openai-codex está en PROVIDER_DEFAULT_CREDENTIAL_ENV → OPENAI_API_KEY,
    // pero con auth_mode oauth ese fallback no debe disparar throw ni inyección.
    const env = buildChildEnv({
        skill: 'qa',
        processEnv: envSinKey,
        skillConfigOverride: {
            skill: { provider: 'openai-codex' },
            providers: { 'openai-codex': { launcher: 'codex', auth_mode: 'oauth' } },
        },
    });
    assert.equal(env.OPENAI_API_KEY, undefined);
});

test('#4306 (regresión): cerebras (HTTP, sin auth_mode) SIN su key SIGUE lanzando', () => {
    const envSinKey = fullOperatorEnv();
    delete envSinKey.CEREBRAS_API_KEY;
    assert.throws(
        () => buildChildEnv({
            skill: 'qa',
            processEnv: envSinKey,
            skillConfigOverride: {
                skill: { provider: 'cerebras' },
                providers: { cerebras: { launcher: 'cerebras', credentials_env: 'CEREBRAS_API_KEY' } },
            },
        }),
        /CEREBRAS_API_KEY no está en el env del pulpo/,
    );
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

// =============================================================================
// #4309 — Aislamiento de credenciales en el camino IN-FLIGHT (BLOQUEANTE,
// requisito de seguridad #1). El ejecutor del fallback in-flight re-spawnea con
// el partial-override `{ provider: 'openai-codex' }` (la MISMA maquinaria que el
// pre-spawn). El env del child secundario DEBE contener OPENAI_API_KEY y NUNCA
// ANTHROPIC_API_KEY — un panic dump del CLI de Codex no debe poder exponer la
// key de Anthropic del primario muerto (invariante S-2).
// =============================================================================
test('#4309: re-spawn in-flight (partial override openai-codex) → OPENAI sí, ANTHROPIC NO', () => {
    const fakeFs = {
        existsSync: () => true,
        readFileSync: () => JSON.stringify({
            providers: {
                anthropic: { launcher: 'claude', credentials_env: 'ANTHROPIC_API_KEY' },
                'openai-codex': { launcher: 'codex', credentials_env: 'OPENAI_API_KEY' },
            },
            skills: {
                'telegram-commander': { provider: 'anthropic' },
            },
        }),
    };
    const env = buildChildEnv({
        // El skill primario es telegram-commander (provider=anthropic en disk),
        // pero el fallback in-flight fuerza el provider del secundario.
        skill: 'telegram-commander',
        pipelineDir: '/fake/.pipeline',
        fsImpl: fakeFs,
        processEnv: fullOperatorEnv(), // incluye AMBAS keys
        skillConfigOverride: { provider: 'openai-codex' }, // partial override (#3198)
    });
    // S-2: el secundario recibe SOLO la key del fallback.
    assert.equal(env.OPENAI_API_KEY, 'sk-openai-XXXXX');
    assert.equal(env.ANTHROPIC_API_KEY, undefined, 'ANTHROPIC_API_KEY NO debe viajar al child de Codex');
});

test('#4309: re-spawn in-flight para agente de pipeline genérico también aísla credenciales', () => {
    const fakeFs = {
        existsSync: () => true,
        readFileSync: () => JSON.stringify({
            providers: {
                anthropic: { launcher: 'claude', credentials_env: 'ANTHROPIC_API_KEY' },
                'openai-codex': { launcher: 'codex', credentials_env: 'OPENAI_API_KEY' },
            },
            skills: {
                'android-dev': { provider: 'anthropic' },
            },
        }),
    };
    const env = buildChildEnv({
        skill: 'android-dev', // CA-3: cualquier agente, no solo el Commander
        pipelineDir: '/fake/.pipeline',
        fsImpl: fakeFs,
        processEnv: fullOperatorEnv(),
        skillConfigOverride: { provider: 'openai-codex' },
    });
    assert.equal(env.OPENAI_API_KEY, 'sk-openai-XXXXX');
    assert.equal(env.ANTHROPIC_API_KEY, undefined);
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

// =============================================================================
// #3198 — Partial override shape `{ provider }` (cross-provider fallback runtime)
//
// Cuando el dispatcher de fallback (resolveSpawnWithFallback) decide que un
// child debe correr con OTRO provider distinto al primary, le pasamos a
// buildChildEnv sólo `{ provider: '<fallback>' }`. El helper DEBE mergear
// con el skill leído de disk para resolver `credentials_env` correctamente.
//
// Invariante crítico de seguridad (S-2): el child del fallback recibe
// SOLO la API key del FALLBACK, NUNCA la del primary.
// =============================================================================
test('#3198: partial override { provider } mergea con skill cfg de disk y selecciona la API key del FALLBACK', () => {
    const fakeFs = {
        existsSync: () => true,
        readFileSync: () => JSON.stringify({
            providers: {
                anthropic: { credentials_env: 'ANTHROPIC_API_KEY' },
                'openai-codex': { credentials_env: 'OPENAI_API_KEY' },
            },
            skills: {
                guru: { provider: 'anthropic', requires_credentials: ['github'] },
            },
        }),
    };
    const env = buildChildEnv({
        skill: 'guru',
        pipelineDir: '/fake/.pipeline',
        fsImpl: fakeFs,
        processEnv: fullOperatorEnv(),
        // Dispatcher resuelve fallback openai-codex sólo nombrando el provider:
        skillConfigOverride: { provider: 'openai-codex' },
    });
    // S-2: el child del fallback recibe SOLO la OPENAI_API_KEY, NO la ANTHROPIC_API_KEY.
    assert.equal(env.OPENAI_API_KEY, 'sk-openai-XXXXX', 'OPENAI_API_KEY del fallback debe estar presente');
    assert.equal(env.ANTHROPIC_API_KEY, undefined, 'ANTHROPIC_API_KEY del primary NO debe leakear al child del fallback');
    // El skill conserva su scope github (mergeo correcto con disk):
    assert.equal(env.GH_TOKEN, 'ghp_XXXXX');
});

test('#3198: partial override { provider } repro exacto del rejection (anthropic primary → openai-codex fallback)', () => {
    // Repro empírico del motivo_rechazo de #3198 con processEnv reducido:
    const fakeFs = {
        existsSync: () => true,
        readFileSync: () => JSON.stringify({
            providers: {
                anthropic: { credentials_env: 'ANTHROPIC_API_KEY' },
                'openai-codex': { credentials_env: 'OPENAI_API_KEY' },
            },
            skills: {
                guru: { provider: 'anthropic' },
            },
        }),
    };
    const env = buildChildEnv({
        skill: 'guru',
        pipelineDir: '/c/Workspaces/Intrale/platform/.pipeline',
        fsImpl: fakeFs,
        processEnv: {
            PATH: '/tmp/path',
            SystemRoot: 'C:/Windows',
            ANTHROPIC_API_KEY: 'sk-ant-test',
            OPENAI_API_KEY: 'sk-openai-test',
            GH_TOKEN: 'ghtok',
            TELEGRAM_BOT_TOKEN: 'tg',
            TELEGRAM_CHAT_ID: '123',
        },
        pipelineExtras: { PIPELINE_ISSUE: '3198' },
        skillConfigOverride: { provider: 'openai-codex' },
    });
    // Estos eran los aserts que fallaban antes del fix (resultado de la verificación):
    assert.equal('ANTHROPIC_API_KEY' in env, false, 'PRIMARY key NO debe filtrarse al child del fallback (era true antes del fix)');
    assert.equal('OPENAI_API_KEY' in env, true, 'FALLBACK key DEBE estar presente (era false antes del fix)');
});

test('#3198: partial override { provider } NO confunde con full override { skill, providers }', () => {
    // Si el caller pasa ambos campos (skill = override completo), gana el path
    // de full override y se ignora providers leídos de disk.
    const fakeFs = {
        existsSync: () => true,
        readFileSync: () => JSON.stringify({
            providers: { anthropic: { credentials_env: 'ANTHROPIC_API_KEY' } },
            skills: { guru: { provider: 'anthropic' } },
        }),
    };
    const env = buildChildEnv({
        skill: 'guru',
        pipelineDir: '/fake/.pipeline',
        fsImpl: fakeFs,
        processEnv: fullOperatorEnv(),
        skillConfigOverride: {
            skill: { provider: 'openai-codex', requires_credentials: [] },
            providers: { 'openai-codex': { credentials_env: 'OPENAI_API_KEY' } },
        },
    });
    // Path de full override: usa los providers del override, no los de disk.
    assert.equal(env.OPENAI_API_KEY, 'sk-openai-XXXXX');
    assert.equal(env.ANTHROPIC_API_KEY, undefined);
});

test('#3198: partial override { provider } sin agent-models.json cae a PROVIDER_DEFAULT_CREDENTIAL_ENV', () => {
    // Caso degradado: si agent-models.json no existe en disk, el helper aún
    // debe resolver la API key del FALLBACK usando PROVIDER_DEFAULT_CREDENTIAL_ENV.
    const fakeFs = {
        existsSync: () => false,  // sin agent-models.json
        readFileSync: () => { throw new Error('no debería leerse'); },
    };
    const env = buildChildEnv({
        skill: 'guru',
        pipelineDir: '/fake/.pipeline',
        fsImpl: fakeFs,
        processEnv: fullOperatorEnv(),
        skillConfigOverride: { provider: 'openai-codex' },
    });
    // PROVIDER_DEFAULT_CREDENTIAL_ENV['openai-codex'] === 'OPENAI_API_KEY'
    assert.equal(env.OPENAI_API_KEY, 'sk-openai-XXXXX');
    assert.equal(env.ANTHROPIC_API_KEY, undefined);
});

test('#3198: partial override { provider } con provider desconocido y key faltante throwa fail-fast', () => {
    // Si el fallback es un provider que no está en disk NI en
    // PROVIDER_DEFAULT_CREDENTIAL_ENV, providerKeyVar === undefined y NO se
    // inyecta ninguna API key (no throw). Eso es comportamiento correcto:
    // el handler determinístico/desconocido no necesita LLM credentials.
    // El test asegura que NO leakeen las keys del primary.
    const fakeFs = {
        existsSync: () => true,
        readFileSync: () => JSON.stringify({
            providers: { anthropic: { credentials_env: 'ANTHROPIC_API_KEY' } },
            skills: { guru: { provider: 'anthropic' } },
        }),
    };
    const env = buildChildEnv({
        skill: 'guru',
        pipelineDir: '/fake/.pipeline',
        fsImpl: fakeFs,
        processEnv: fullOperatorEnv(),
        skillConfigOverride: { provider: 'provider-inexistente' },
    });
    // Ninguna key del primary se filtra:
    assert.equal(env.ANTHROPIC_API_KEY, undefined);
    assert.equal(env.OPENAI_API_KEY, undefined);
});

test('#3198: partial override { provider } preserva requires_credentials del skill de disk', () => {
    // Verifica que el merge skillCfg + { provider } no pisa el campo
    // requires_credentials del skill. Es importante porque scopes
    // (github/aws/gradle-android) son ortogonales al cambio de provider:
    // el skill sigue necesitando gh CLI para postear comentarios.
    const fakeFs = {
        existsSync: () => true,
        readFileSync: () => JSON.stringify({
            providers: {
                anthropic: { credentials_env: 'ANTHROPIC_API_KEY' },
                'openai-codex': { credentials_env: 'OPENAI_API_KEY' },
            },
            skills: {
                security: { provider: 'anthropic', requires_credentials: ['github', 'aws'] },
            },
        }),
    };
    const env = buildChildEnv({
        skill: 'security',
        pipelineDir: '/fake/.pipeline',
        fsImpl: fakeFs,
        processEnv: fullOperatorEnv(),
        skillConfigOverride: { provider: 'openai-codex' },
    });
    // Provider del fallback aplicado:
    assert.equal(env.OPENAI_API_KEY, 'sk-openai-XXXXX');
    assert.equal(env.ANTHROPIC_API_KEY, undefined);
    // Scopes del skill conservados (github + aws):
    assert.equal(env.GH_TOKEN, 'ghp_XXXXX');
    assert.equal(env.GITHUB_TOKEN, 'ghs_XXXXX');
    assert.equal(env.AWS_ACCESS_KEY_ID, 'AKIAXXXX');
    assert.equal(env.AWS_SECRET_ACCESS_KEY, 'secret-XXXX');
});

test('#3198: partial override { provider } con API key del FALLBACK faltante en env throwa fail-fast accionable', () => {
    // Si el operador no setea OPENAI_API_KEY y el dispatcher resuelve fallback
    // openai-codex, el child NO arranca. Mensaje accionable explica qué setear.
    const fakeFs = {
        existsSync: () => true,
        readFileSync: () => JSON.stringify({
            providers: {
                anthropic: { credentials_env: 'ANTHROPIC_API_KEY' },
                'openai-codex': { credentials_env: 'OPENAI_API_KEY' },
            },
            skills: { guru: { provider: 'anthropic' } },
        }),
    };
    const envSinFallback = fullOperatorEnv();
    delete envSinFallback.OPENAI_API_KEY;
    assert.throws(
        () => buildChildEnv({
            skill: 'guru',
            pipelineDir: '/fake/.pipeline',
            fsImpl: fakeFs,
            processEnv: envSinFallback,
            skillConfigOverride: { provider: 'openai-codex' },
        }),
        /OPENAI_API_KEY no está en el env del pulpo/,
    );
});
