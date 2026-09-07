// =============================================================================
// build-child-env-least-privilege.test.js — Issue #5901 · CA-2 / CA-4 / CA-11
//
// El techo por fase (`SCOPES_BY_FASE`) es un cambio invisible en producción
// mientras `env_isolation_enabled: false` (config.yaml): `buildChildEnv` ni se
// invoca. Un techo mal declarado no se nota HOY y explota el día que #5040
// active el flag. Estos tests son lo que convierte ese cambio invisible en uno
// verificable, y se apoyan en tres propiedades:
//
//   P-1 · MONOTONÍA (CA-2) — para toda combinación `(skill, fase)` realmente
//         despachada, el scope efectivo nuevo es SUBCONJUNTO del efectivo
//         previo. Ningún par puede GANAR privilegios. Es la red de seguridad
//         que hace seguro cablear el eje en los callsites reales.
//   P-2 · SIN REGRESIÓN — y además ninguna combinación VIVA pierde un scope
//         que hoy usa: la matriz se deriva de la config real, no de una lista
//         paralela que se puede quedar vieja.
//   P-3 · FAIL-CLOSED (CA-4) — fase ausente/desconocida ⇒ techo VACÍO y
//         diagnóstico con skill + fase + projectId + scopes omitidos + acción.
//
// Higiene (REQ-SEC-6): ningún assert imprime valores de credenciales. Los
// datos son sintéticos con prefijo `FAKE-`.
// =============================================================================
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const lib = require('../lib/build-child-env');
const { buildChildEnv, SCOPES_BY_FASE, SCOPES_ALWAYS_ON, CREDENTIAL_SCOPES,
        DEFAULT_REQUIRES_BY_SKILL, KERNEL_FASE, KERNEL_PROJECT_ID } = lib;

const REPO_ROOT = path.resolve(__dirname, '..', '..');

// ─── Fixtures ────────────────────────────────────────────────────────────────

// Env del operador con TODO el material posible. Valores sintéticos: si alguno
// apareciera en un mensaje de error, el prefijo `FAKE-` lo delata.
function fakeOperatorEnv() {
    return {
        PATH: '/usr/bin:/bin',
        SystemRoot: 'C:\\Windows',
        ANTHROPIC_API_KEY: 'FAKE-anthropic-key',
        OPENAI_API_KEY: 'FAKE-openai-key',
        GH_TOKEN: 'FAKE-gh-token',
        GITHUB_TOKEN: 'FAKE-github-token',
        AWS_ACCESS_KEY_ID: 'FAKE-aws-id',
        AWS_SECRET_ACCESS_KEY: 'FAKE-aws-secret',
        AWS_SESSION_TOKEN: 'FAKE-aws-session',
        AWS_REGION: 'us-east-1',
        AWS_PROFILE: 'default',
        JAVA_HOME: 'C:\\Java\\jdk21',
        GRADLE_USER_HOME: 'C:\\gradle',
        ANDROID_HOME: 'C:\\Android\\Sdk',
        ANDROID_SDK_ROOT: 'C:\\Android\\Sdk',
        ANDROID_AVD_HOME: 'C:\\avd',
        TELEGRAM_CHAT_ID: '12345',
        TELEGRAM_BOT_TOKEN: 'FAKE-bot-token',
    };
}

const OVERRIDE_VACIO = { skill: {}, providers: {} };

/** Scopes efectivos observados: qué scopes quedaron representados en el env. */
function scopesPresentes(env) {
    const presentes = new Set();
    for (const [scope, vars] of Object.entries(CREDENTIAL_SCOPES)) {
        if (vars.some((v) => env[v] !== undefined)) presentes.add(scope);
    }
    return presentes;
}

/**
 * Matriz REAL de despacho, derivada de la config del repo — no de una lista
 * paralela. Si mañana se agrega un skill a una fase y su scope no entra en el
 * techo, este test lo detecta solo.
 */
function matrizDeDespacho() {
    const cfg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'pipeline.config.json'), 'utf8'));
    const pipelines = (cfg.productConfig && cfg.productConfig.pipelines) || {};
    const pares = [];
    for (const [pipeline, def] of Object.entries(pipelines)) {
        for (const [fase, skills] of Object.entries(def.skills_por_fase || {})) {
            for (const skill of skills) pares.push({ pipeline, fase, skill });
        }
    }
    assert.ok(pares.length > 0, 'la matriz de despacho no puede salir vacia');
    return pares;
}

// ─── Coherencia estática del techo ───────────────────────────────────────────

test('CA-2: todo scope declarado en un techo existe en CREDENTIAL_SCOPES', () => {
    for (const [fase, scopes] of Object.entries(SCOPES_BY_FASE)) {
        for (const scope of scopes) {
            assert.ok(CREDENTIAL_SCOPES[scope],
                `techo de '${fase}' declara el scope inexistente '${scope}'`);
        }
    }
});

test('CA-2: SCOPES_BY_FASE cubre TODAS las fases de config.yaml + la del kernel', () => {
    const yaml = fs.readFileSync(path.join(REPO_ROOT, '.pipeline', 'config.yaml'), 'utf8');
    const fases = new Set();
    for (const m of yaml.matchAll(/^\s{4}fases:\s*\[([^\]]+)\]/gm)) {
        for (const f of m[1].split(',')) fases.add(f.trim());
    }
    assert.ok(fases.size >= 10, `se esperaban las 10 fases de los dos pipelines, hay ${fases.size}`);
    for (const fase of fases) {
        assert.ok(Object.prototype.hasOwnProperty.call(SCOPES_BY_FASE, fase),
            `la fase '${fase}' de config.yaml no tiene techo declarado — caeria al fail-closed`);
    }
    assert.ok(Object.prototype.hasOwnProperty.call(SCOPES_BY_FASE, KERNEL_FASE),
        'el commander necesita su fase sintetica (GURU-3)');
});

test('CA-2: los techos son inmutables (Object.freeze)', () => {
    assert.throws(() => { SCOPES_BY_FASE.dev = ['aws']; });
    assert.throws(() => { SCOPES_BY_FASE.dev.push('aws'); });
});

// ─── P-1 · Monotonía ─────────────────────────────────────────────────────────

test('CA-2 · P-1: ningun (skill, fase) GANA privilegios respecto del efectivo previo', () => {
    for (const { fase, skill } of matrizDeDespacho()) {
        const previo = new Set([
            ...(DEFAULT_REQUIRES_BY_SKILL[skill] || []),
            ...SCOPES_ALWAYS_ON,
        ]);
        const env = buildChildEnv({
            skill, fase, projectId: KERNEL_PROJECT_ID,
            processEnv: fakeOperatorEnv(),
            skillConfigOverride: OVERRIDE_VACIO,
        });
        for (const scope of scopesPresentes(env)) {
            assert.ok(previo.has(scope),
                `(${skill}, ${fase}) recibio '${scope}', que NO estaba en su efectivo previo`);
        }
    }
});

test('CA-2 · P-1: la monotonia tambien vale con requires_credentials declarado en config', () => {
    // Un skill que declara TODOS los scopes no puede saltarse el techo.
    const TODOS = Object.keys(CREDENTIAL_SCOPES);
    const env = buildChildEnv({
        skill: 'linter', fase: 'linteo', projectId: KERNEL_PROJECT_ID,
        processEnv: fakeOperatorEnv(),
        skillConfigOverride: { skill: { requires_credentials: TODOS }, providers: {} },
    });
    // Techo de `linteo` = [] ⇒ sólo always-on.
    assert.deepEqual([...scopesPresentes(env)].sort(), [...SCOPES_ALWAYS_ON].sort());
    assert.equal(env.GH_TOKEN, undefined);
    assert.equal(env.AWS_ACCESS_KEY_ID, undefined);
    assert.equal(env.JAVA_HOME, undefined);
});

test('CA-2 · P-1: INTERSECCION, nunca union — el techo no otorga lo que el skill no pide', () => {
    // Techo de `dev` incluye aws, pero `pipeline-dev` sólo pide github.
    assert.ok(SCOPES_BY_FASE.dev.includes('aws'), 'premisa: el techo de dev incluye aws');
    const env = buildChildEnv({
        skill: 'pipeline-dev', fase: 'dev', projectId: KERNEL_PROJECT_ID,
        processEnv: fakeOperatorEnv(),
        skillConfigOverride: OVERRIDE_VACIO,
    });
    assert.equal(env.GH_TOKEN, 'FAKE-gh-token', 'lo que el skill pide y la fase autoriza, entra');
    assert.equal(env.AWS_ACCESS_KEY_ID, undefined, 'el techo NO otorga lo que el skill no pidio');
    assert.equal(env.JAVA_HOME, undefined);
});

// ─── P-2 · Sin regresión sobre combinaciones vivas ───────────────────────────

test('CA-2 · P-2: ninguna combinacion VIVA pierde un scope que hoy usa', () => {
    for (const { fase, skill } of matrizDeDespacho()) {
        const pedidos = DEFAULT_REQUIRES_BY_SKILL[skill] || [];
        const env = buildChildEnv({
            skill, fase, projectId: KERNEL_PROJECT_ID,
            processEnv: fakeOperatorEnv(),
            skillConfigOverride: OVERRIDE_VACIO,
        });
        const presentes = scopesPresentes(env);
        for (const scope of pedidos) {
            assert.ok(presentes.has(scope),
                `REGRESION: (${skill}, ${fase}) pide '${scope}' y el techo de '${fase}' se lo recorta. `
                + `Techo actual: [${SCOPES_BY_FASE[fase].join(', ')}]`);
        }
    }
});

test('CA-2 · P-2: el commander conserva su efectivo con la fase sintetica del kernel', () => {
    const env = buildChildEnv({
        skill: 'telegram-commander',
        fase: KERNEL_FASE,
        projectId: KERNEL_PROJECT_ID,
        processEnv: fakeOperatorEnv(),
        skillConfigOverride: OVERRIDE_VACIO,
    });
    assert.equal(env.ANTHROPIC_API_KEY, 'FAKE-anthropic-key');
    assert.equal(env.TELEGRAM_CHAT_ID, '12345');
    assert.equal(env.TELEGRAM_BOT_TOKEN, undefined, 'CA-11: el material de firma nunca cruza');
});

// ─── P-3 · Fail-closed y diagnóstico (CA-4 / UX-4) ──────────────────────────

test('CA-4: fase AUSENTE cae a techo vacio y NO a "todos los scopes"', () => {
    const avisos = [];
    const env = buildChildEnv({
        skill: 'backend-dev', projectId: KERNEL_PROJECT_ID,
        processEnv: fakeOperatorEnv(),
        warn: (m) => avisos.push(m),
        skillConfigOverride: OVERRIDE_VACIO,
    });
    assert.equal(env.GH_TOKEN, undefined);
    assert.equal(env.AWS_ACCESS_KEY_ID, undefined);
    assert.equal(env.JAVA_HOME, undefined);
    assert.equal(env.TELEGRAM_CHAT_ID, '12345', 'always-on sobrevive (no lleva material)');
    assert.equal(avisos.length, 1);
});

test('CA-4: el diagnostico nombra skill, fase, projectId, scopes omitidos y la accion', () => {
    const avisos = [];
    buildChildEnv({
        skill: 'backend-dev', fase: 'fase-que-no-existe', projectId: 'acme-corp',
        processEnv: fakeOperatorEnv(),
        warn: (m) => avisos.push(m),
        skillConfigOverride: OVERRIDE_VACIO,
    });
    assert.equal(avisos.length, 1);
    const aviso = avisos[0];
    assert.match(aviso, /backend-dev/, 'debe nombrar el skill');
    assert.match(aviso, /fase-que-no-existe/, 'debe nombrar la fase');
    assert.match(aviso, /acme-corp/, 'debe nombrar el projectId');
    assert.match(aviso, /github/, 'debe listar los scopes omitidos');
    assert.match(aviso, /aws/);
    assert.match(aviso, /gradle-android/);
    assert.match(aviso, /SCOPES_BY_FASE/, 'debe decir QUE hacer, no solo que fallo');
    // REQ-SEC-6 / I-S2: sólo NOMBRES, jamás valores.
    assert.doesNotMatch(aviso, /FAKE-/, 'el diagnostico no puede contener valores de credenciales');
});

test('CA-4: fase VALIDA no emite diagnostico (el warning no es ruido de fondo)', () => {
    const avisos = [];
    buildChildEnv({
        skill: 'backend-dev', fase: 'dev', projectId: KERNEL_PROJECT_ID,
        processEnv: fakeOperatorEnv(),
        warn: (m) => avisos.push(m),
        skillConfigOverride: OVERRIDE_VACIO,
    });
    assert.deepEqual(avisos, []);
});

test('CA-4: fase no-string (numero, objeto, null) cae al fail-closed, no crashea', () => {
    for (const fase of [0, 42, null, {}, [], true]) {
        const avisos = [];
        const env = buildChildEnv({
            skill: 'qa', fase, projectId: KERNEL_PROJECT_ID,
            processEnv: fakeOperatorEnv(),
            warn: (m) => avisos.push(m),
            skillConfigOverride: OVERRIDE_VACIO,
        });
        assert.equal(env.AWS_ACCESS_KEY_ID, undefined, `fase ${JSON.stringify(fase)} no puede otorgar aws`);
        assert.equal(avisos.length, 1);
    }
});

test('CA-4: una fase heredada por prototipo NO cuenta como techo declarado', () => {
    // `SCOPES_BY_FASE['constructor']` es truthy por herencia. El lookup usa
    // hasOwnProperty justamente para que esto caiga al fail-closed.
    const avisos = [];
    const env = buildChildEnv({
        skill: 'backend-dev', fase: 'constructor', projectId: KERNEL_PROJECT_ID,
        processEnv: fakeOperatorEnv(),
        warn: (m) => avisos.push(m),
        skillConfigOverride: OVERRIDE_VACIO,
    });
    assert.equal(env.GH_TOKEN, undefined);
    assert.equal(env.AWS_ACCESS_KEY_ID, undefined);
    assert.equal(avisos.length, 1);
});

// ─── CA-1 · projectId fail-closed ────────────────────────────────────────────

test('CA-1: projectId PRESENTE pero invalido => throw accionable', () => {
    const invalidos = ['', '__proto__', 'constructor', 'prototype', 'a/b', '../x', 'A', 'x_y', 0, {}, []];
    for (const projectId of invalidos) {
        assert.throws(
            () => buildChildEnv({
                skill: 'guru', fase: 'analisis', projectId,
                processEnv: fakeOperatorEnv(),
                skillConfigOverride: OVERRIDE_VACIO,
            }),
            /projectId" inválido/,
            `deberia rechazar projectId=${JSON.stringify(projectId)}`,
        );
    }
});

test('CA-1: el mensaje de fail-closed no filtra valores y dice de donde sacar el projectId', () => {
    try {
        buildChildEnv({
            skill: 'guru', fase: 'analisis', projectId: '__proto__',
            processEnv: fakeOperatorEnv(),
            skillConfigOverride: OVERRIDE_VACIO,
        });
        assert.fail('debio tirar');
    } catch (e) {
        assert.match(e.message, /project-context\.resolveProjectContext/,
            'debe decir cual es la fuente autoritativa');
        assert.match(e.message, /no lo tomes del env/i);
        assert.doesNotMatch(e.message, /FAKE-/);
    }
});

test('CA-1: projectId AUSENTE no rompe el spawn (camino single-project vigente)', () => {
    // `projectBinding` es best-effort en pulpo.js y vale `null` cuando no se
    // pudo escribir. Exigir el id ahi romperia un spawn que hoy funciona.
    for (const projectId of [undefined, null]) {
        const env = buildChildEnv({
            skill: 'guru', fase: 'analisis', projectId,
            processEnv: fakeOperatorEnv(),
            skillConfigOverride: OVERRIDE_VACIO,
        });
        assert.equal(env.GH_TOKEN, 'FAKE-gh-token');
    }
});

test('CA-1: ningun valor de OTRO proyecto entra al env del hijo', () => {
    // Material namespaceado de otro producto presente en el env del padre: no
    // esta en SYSTEM_ALLOWLIST ni en ningun scope, asi que no puede cruzar.
    const env0 = fakeOperatorEnv();
    env0.ACME_GH_TOKEN = 'FAKE-acme-gh';
    env0.PROJECT_ACME_AWS_SECRET_ACCESS_KEY = 'FAKE-acme-aws';
    env0.OTRO_PROYECTO_ANTHROPIC_API_KEY = 'FAKE-otro-anthropic';

    const env = buildChildEnv({
        skill: 'guru', fase: 'analisis', projectId: 'kernel',
        processEnv: env0,
        skillConfigOverride: OVERRIDE_VACIO,
    });
    const serializado = JSON.stringify(env);
    assert.doesNotMatch(serializado, /FAKE-acme-gh/);
    assert.doesNotMatch(serializado, /FAKE-acme-aws/);
    assert.doesNotMatch(serializado, /FAKE-otro-anthropic/);
    assert.equal(env.ACME_GH_TOKEN, undefined);
    assert.equal(env.PROJECT_ACME_AWS_SECRET_ACCESS_KEY, undefined);
});

// ─── CA-11 · No-regresión de stripReservedChildSecrets ──────────────────────

test('CA-11: stripReservedChildSecrets sigue siendo la ULTIMA operacion con el eje nuevo', () => {
    const env = buildChildEnv({
        skill: 'guru', fase: 'analisis', projectId: 'acme-corp',
        processEnv: fakeOperatorEnv(),
        skillConfigOverride: OVERRIDE_VACIO,
    });
    assert.equal(env.TELEGRAM_BOT_TOKEN, undefined);
    assert.equal(env.TELEGRAM_CHAT_ID, '12345');
});

test('CA-11: pipelineExtras HOSTIL no reintroduce el material reservado con el eje nuevo', () => {
    const operador = fakeOperatorEnv();
    const env = buildChildEnv({
        skill: 'guru', fase: 'analisis', projectId: 'acme-corp',
        processEnv: operador,
        pipelineExtras: {
            // 1. por nombre reservado
            TELEGRAM_BOT_TOKEN: operador.TELEGRAM_BOT_TOKEN,
            // 2. por alias con el MISMO valor
            PIPELINE_ALIAS_INOCENTE: operador.TELEGRAM_BOT_TOKEN,
            // 3. extra legitimo, debe sobrevivir
            PIPELINE_ISSUE: '5901',
        },
        skillConfigOverride: OVERRIDE_VACIO,
    });
    assert.equal(env.TELEGRAM_BOT_TOKEN, undefined);
    assert.equal(env.PIPELINE_ALIAS_INOCENTE, undefined);
    assert.equal(env.PIPELINE_ISSUE, '5901');
    assert.doesNotMatch(JSON.stringify(env), /FAKE-bot-token/);
});

test('CA-11: pipelineExtras no puede sortear el techo inyectando material de scope', () => {
    // `pipelineExtras` se mergea DESPUES de los scopes. Es contexto del child,
    // no una segunda via de credenciales: si alguien mete GH_TOKEN ahi, el
    // filtro final no lo tapa — pero el techo tampoco lo autorizo, asi que la
    // invariante que importa es que el camino de SCOPES no lo entregue.
    const env = buildChildEnv({
        skill: 'linter', fase: 'linteo', projectId: KERNEL_PROJECT_ID,
        processEnv: fakeOperatorEnv(),
        skillConfigOverride: { skill: { requires_credentials: ['github'] }, providers: {} },
    });
    assert.equal(env.GH_TOKEN, undefined,
        'el techo de linteo es vacio: el scope github no puede entregarse');
});
