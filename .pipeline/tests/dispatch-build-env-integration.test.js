// =============================================================================
// dispatch-build-env-integration.test.js — Test de integración pulpo.js
// (entre `resolveSpawnWithFallback` y `buildChildEnv`).
//
// Issue: #3198 (rebote sobre PR original).
//
// **Por qué este test existe**:
// El rebote del PR original detectó que aunque `resolveSpawnWithFallback` y
// `buildChildEnv` estaban bien aislados y testeados, la integración entre
// ambos en `pulpo.js` tenía un mismatch de shape: el dispatcher producía
// `{ provider: '<fallback>' }` y buildChildEnv esperaba
// `{ skill, providers }`. El override se ignoraba silenciosamente y el child
// del fallback recibía la API key del PRIMARY → defensa S-2 rota.
//
// Estos tests reproducen el flujo end-to-end que hace `pulpo.js` en
// `lanzarAgenteClaude` (líneas ~5300-5330) y aseguran que la composición
// preserve el invariante de seguridad **S-2**:
//
//   Cuando el dispatcher devuelve `source: 'fallback'`, el child obtiene
//   SOLO la API key del FALLBACK, NUNCA la del PRIMARY.
//
// Si este test pasa y los unit tests de `build-child-env` y
// `dispatch-with-fallback` pasan también, S-2 está garantizado end-to-end.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const {
    resolveSpawnWithFallback,
} = require('../lib/agent-launcher/dispatch-with-fallback');
const { buildChildEnv } = require('../lib/build-child-env');

// -----------------------------------------------------------------------------
// Helpers — fakes equivalentes a los de dispatch-with-fallback.test.js,
// inlineados para mantener el archivo autocontenido.
// -----------------------------------------------------------------------------
function fakeAuditLog() {
    return {
        appendChained: () => ({ hash_self: 'fake', hash_prev: 'fake-prev', line: '' }),
        verifyChain: () => ({ ok: true }),
        readAll: () => [],
        entries: [],
    };
}

function fakeNotify() {
    return () => true;
}

function fakeFsWithAgentModels(pipelineDir, modelsObj) {
    const modelsPath = path.join(pipelineDir, 'agent-models.json');
    const files = new Map();
    files.set(modelsPath, JSON.stringify(modelsObj));
    return {
        existsSync: (p) => files.has(p),
        readFileSync: (p) => {
            if (files.has(p)) return files.get(p);
            const e = new Error(`ENOENT: ${p}`);
            e.code = 'ENOENT';
            throw e;
        },
        mkdirSync: () => {},
        writeFileSync: (p, content) => { files.set(p, content); },
    };
}

function fakeQuotaModule({ gatedProviders = [] } = {}) {
    return {
        shouldGateSpawn: (skill, { provider } = {}) => {
            if (!provider) return false;
            return gatedProviders.includes(provider);
        },
        sanitizeRawExcerpt: (s) => String(s || ''),
        appendAudit: () => {},
    };
}

// Resolver de handlers fake — acepta los providers conocidos del módulo real
// más cualquier custom que el test declare. Evita acoplarnos al naming exacto
// de `lib/agent-launcher/resolve-provider.js::getProviderHandler`.
function fakeProviderHandlerResolver(validProviders = ['anthropic', 'openai-codex', 'gemini', 'deterministic']) {
    return (name) => {
        if (!validProviders.includes(name)) {
            throw new Error(`[fake] provider "${name}" no está en validProviders`);
        }
        return { name: `${name}-fake` };
    };
}

function fakeResolver(skill, opts) {
    const fsImpl = opts.fsImpl;
    const pipelineDir = opts.pipelineDir;
    let models = null;
    try {
        const p = path.join(pipelineDir, 'agent-models.json');
        if (fsImpl && fsImpl.existsSync(p)) {
            models = JSON.parse(fsImpl.readFileSync(p, 'utf8'));
        }
    } catch {}
    const sk = (models && models.skills && models.skills[skill]) || {};
    const provider = sk.provider || 'anthropic';
    return {
        provider,
        model: 'fake-model',
        handler: { name: `${provider}-fake` },
        source: 'agent-models',
    };
}

// Modelo base con dos providers + skill que tiene fallback cross-provider.
function baseAgentModels() {
    return {
        defaults: { model: 'claude-opus-4-7' },
        default_provider: 'anthropic',
        providers: {
            anthropic: {
                model: 'claude-opus-4-7',
                credentials_env: 'ANTHROPIC_API_KEY',
            },
            'openai-codex': {
                model: 'gpt-codex',
                credentials_env: 'OPENAI_API_KEY',
            },
            gemini: {
                model: 'gemini-pro',
                credentials_env: 'GEMINI_API_KEY',
            },
        },
        skills: {
            guru: {
                provider: 'anthropic',
                requires_credentials: ['github'],
                fallbacks: ['openai-codex'],
            },
            security: {
                provider: 'anthropic',
                requires_credentials: ['github', 'aws'],
                fallbacks: ['openai-codex', 'gemini'],
            },
        },
    };
}

// processEnv del operador con TODAS las API keys (worst case).
function operatorProcessEnv() {
    return {
        PATH: '/usr/bin:/bin',
        SystemRoot: 'C:\\Windows',
        ANTHROPIC_API_KEY: 'sk-ant-PRIMARY-secret',
        OPENAI_API_KEY: 'sk-openai-FALLBACK-secret',
        GEMINI_API_KEY: 'sk-gemini-FALLBACK2-secret',
        GH_TOKEN: 'ghp_XXXX',
        GITHUB_TOKEN: 'ghs_XXXX',
        AWS_ACCESS_KEY_ID: 'AKIAXXX',
        AWS_SECRET_ACCESS_KEY: 'aws-secret',
        TELEGRAM_BOT_TOKEN: 'tg-bot',
        TELEGRAM_CHAT_ID: '12345',
    };
}

const PIPELINE_DIR = '/repo/.pipeline';
const ISSUE = 3198;

// -----------------------------------------------------------------------------
// Función helper que replica EXACTAMENTE el flujo de pulpo.js
// (lanzarAgenteClaude líneas 5306-5342): dispatcher → override → buildChildEnv.
// Si pulpo.js cambia la lógica de construcción del override, este helper se
// actualiza para mantener la integración en sincronía con la realidad.
// -----------------------------------------------------------------------------
function pulpoFlow({ skill, issue, fsImpl, processEnv, quotaModule }) {
    const dispatchResolution = resolveSpawnWithFallback({
        skill,
        issue,
        pipelineDir: PIPELINE_DIR,
        fsImpl,
        quotaModule,
        primaryResolver: fakeResolver,
        providerHandlerResolver: fakeProviderHandlerResolver(),
        auditLog: fakeAuditLog(),
        notify: fakeNotify(),
    });

    if (dispatchResolution.gated) {
        return { dispatchResolution, childEnv: null };
    }

    // Replica pulpo.js:5319-5325 — shape `{ provider }` (post-fix #3198).
    const skillConfigOverride = (
        dispatchResolution &&
        dispatchResolution.source === 'fallback' &&
        dispatchResolution.provider
    )
        ? { provider: dispatchResolution.provider }
        : undefined;

    const childEnv = buildChildEnv({
        skill,
        pipelineDir: PIPELINE_DIR,
        fsImpl,
        processEnv,
        pipelineExtras: { PIPELINE_ISSUE: String(issue) },
        skillConfigOverride,
    });

    return { dispatchResolution, childEnv };
}

// =============================================================================
// 1. Happy path — primary no gateado → child recibe la key del PRIMARY
// =============================================================================
test('integración: primary no gated → child recibe ANTHROPIC_API_KEY y NO la del fallback', () => {
    const fsImpl = fakeFsWithAgentModels(PIPELINE_DIR, baseAgentModels());
    const { dispatchResolution, childEnv } = pulpoFlow({
        skill: 'guru',
        issue: ISSUE,
        fsImpl,
        processEnv: operatorProcessEnv(),
        quotaModule: fakeQuotaModule({ gatedProviders: [] }),
    });

    assert.equal(dispatchResolution.source, 'agent-models');
    assert.equal(dispatchResolution.provider, 'anthropic');
    assert.equal(dispatchResolution.crossProvider, false);

    // Primary key sí, fallback key NO:
    assert.equal(childEnv.ANTHROPIC_API_KEY, 'sk-ant-PRIMARY-secret',
        'primary key debe estar presente cuando no hubo fallback');
    assert.equal(childEnv.OPENAI_API_KEY, undefined,
        'fallback key NO debe leakear cuando no hubo fallback');
});

// =============================================================================
// 2. CORE S-2: primary gateado, fallback openai-codex elegido →
//    child recibe SOLO OPENAI_API_KEY, NUNCA ANTHROPIC_API_KEY
// =============================================================================
test('integración S-2: primary gated → child del fallback recibe SOLO la key del FALLBACK, no la del primary', () => {
    const fsImpl = fakeFsWithAgentModels(PIPELINE_DIR, baseAgentModels());
    const { dispatchResolution, childEnv } = pulpoFlow({
        skill: 'guru',
        issue: ISSUE,
        fsImpl,
        processEnv: operatorProcessEnv(),
        quotaModule: fakeQuotaModule({ gatedProviders: ['anthropic'] }),
    });

    // El dispatcher eligió el fallback openai-codex:
    assert.equal(dispatchResolution.source, 'fallback');
    assert.equal(dispatchResolution.provider, 'openai-codex');
    assert.equal(dispatchResolution.crossProvider, true);

    // **Invariante S-2 (la propiedad que el rebote detectó rota)**:
    assert.equal(childEnv.OPENAI_API_KEY, 'sk-openai-FALLBACK-secret',
        'S-2: la API key del FALLBACK DEBE estar presente en el child');
    assert.equal(childEnv.ANTHROPIC_API_KEY, undefined,
        'S-2: la API key del PRIMARY NUNCA debe leakear al child del fallback');
});

// =============================================================================
// 3. Segundo nivel de fallback (chain depth 2):
//    primary anthropic gated + fallback openai-codex gated → fallback gemini
//    El child recibe SOLO GEMINI_API_KEY.
// =============================================================================
test('integración S-2: chain depth 2 (anthropic+openai gated → gemini) — child recibe SOLO GEMINI_API_KEY', () => {
    const fsImpl = fakeFsWithAgentModels(PIPELINE_DIR, baseAgentModels());
    const { dispatchResolution, childEnv } = pulpoFlow({
        skill: 'security',
        issue: ISSUE,
        fsImpl,
        processEnv: operatorProcessEnv(),
        quotaModule: fakeQuotaModule({ gatedProviders: ['anthropic', 'openai-codex'] }),
    });

    assert.equal(dispatchResolution.source, 'fallback');
    assert.equal(dispatchResolution.provider, 'gemini');
    assert.deepEqual(dispatchResolution.chainTried, ['anthropic', 'openai-codex', 'gemini']);

    // S-2 con 2 niveles de fallback: SOLO la última API key (gemini).
    assert.equal(childEnv.GEMINI_API_KEY, 'sk-gemini-FALLBACK2-secret');
    assert.equal(childEnv.OPENAI_API_KEY, undefined,
        'S-2: API key del fallback intermedio NO debe leakear al child del fallback final');
    assert.equal(childEnv.ANTHROPIC_API_KEY, undefined,
        'S-2: API key del primary NO debe leakear cuando se cae en chain depth 2');
});

// =============================================================================
// 4. Sanity: requires_credentials del skill se preservan tras el cross-provider
//    Si el skill declara `github` + `aws`, el child del fallback los conserva.
//    (cross-provider sólo cambia LA API key del LLM, no los scopes del skill)
// =============================================================================
test('integración: cross-provider preserva requires_credentials del skill (scopes ortogonales al provider)', () => {
    const fsImpl = fakeFsWithAgentModels(PIPELINE_DIR, baseAgentModels());
    const { dispatchResolution, childEnv } = pulpoFlow({
        skill: 'security',
        issue: ISSUE,
        fsImpl,
        processEnv: operatorProcessEnv(),
        quotaModule: fakeQuotaModule({ gatedProviders: ['anthropic'] }),
    });

    // Cross-provider activo:
    assert.equal(dispatchResolution.crossProvider, true);
    assert.equal(dispatchResolution.provider, 'openai-codex');

    // API key del fallback:
    assert.equal(childEnv.OPENAI_API_KEY, 'sk-openai-FALLBACK-secret');
    assert.equal(childEnv.ANTHROPIC_API_KEY, undefined);

    // Scopes del skill (github, aws) conservados:
    assert.equal(childEnv.GH_TOKEN, 'ghp_XXXX');
    assert.equal(childEnv.GITHUB_TOKEN, 'ghs_XXXX');
    assert.equal(childEnv.AWS_ACCESS_KEY_ID, 'AKIAXXX');
    assert.equal(childEnv.AWS_SECRET_ACCESS_KEY, 'aws-secret');
});

// =============================================================================
// 5. Sanity: telegram-hooks always-on conservado tras cross-provider
// =============================================================================
test('integración: cross-provider preserva telegram-hooks SCOPES_ALWAYS_ON', () => {
    const fsImpl = fakeFsWithAgentModels(PIPELINE_DIR, baseAgentModels());
    const { childEnv } = pulpoFlow({
        skill: 'guru',
        issue: ISSUE,
        fsImpl,
        processEnv: operatorProcessEnv(),
        quotaModule: fakeQuotaModule({ gatedProviders: ['anthropic'] }),
    });
    assert.equal(childEnv.TELEGRAM_BOT_TOKEN, 'tg-bot');
    assert.equal(childEnv.TELEGRAM_CHAT_ID, '12345');
});

// =============================================================================
// 6. Sanity: PIPELINE_ISSUE de pipelineExtras llega al child tras cross-provider
// =============================================================================
test('integración: pipelineExtras (PIPELINE_ISSUE) preservados tras cross-provider', () => {
    const fsImpl = fakeFsWithAgentModels(PIPELINE_DIR, baseAgentModels());
    const { childEnv } = pulpoFlow({
        skill: 'guru',
        issue: ISSUE,
        fsImpl,
        processEnv: operatorProcessEnv(),
        quotaModule: fakeQuotaModule({ gatedProviders: ['anthropic'] }),
    });
    assert.equal(childEnv.PIPELINE_ISSUE, '3198');
});
