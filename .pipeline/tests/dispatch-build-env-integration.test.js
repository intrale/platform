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

// Aísla del kill-switch operacional live (`provider-disabled.json` global): sin
// esto, un provider drenado en runtime por el pulpo volvía flaky la chain
// (#4801 rebote). Ver lib/__tests__/isolate-provider-disabled.helper.js.
require('../lib/__tests__/isolate-provider-disabled.helper');
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
// 5. Material de firma contenido en primary, fallback y extras hostiles
// =============================================================================
test('integración: cross-provider no recibe token por nombre ni valor', () => {
    const fsImpl = fakeFsWithAgentModels(PIPELINE_DIR, baseAgentModels());
    const { childEnv } = pulpoFlow({
        skill: 'guru',
        issue: ISSUE,
        fsImpl,
        processEnv: operatorProcessEnv(),
        quotaModule: fakeQuotaModule({ gatedProviders: ['anthropic'] }),
    });
    assert.equal(childEnv.TELEGRAM_BOT_TOKEN, undefined);
    assert.equal(Object.values(childEnv).includes('tg-bot'), false);
    assert.equal(childEnv.TELEGRAM_CHAT_ID, '12345');
});

test('integración: fallback filtra pipelineExtras hostil con alias del token', () => {
    const fsImpl = fakeFsWithAgentModels(PIPELINE_DIR, baseAgentModels());
    const processEnv = operatorProcessEnv();
    const dispatchResolution = resolveSpawnWithFallback({
        skill: 'guru', issue: ISSUE, pipelineDir: PIPELINE_DIR, fsImpl,
        quotaModule: fakeQuotaModule({ gatedProviders: ['anthropic'] }),
        primaryResolver: fakeResolver,
        providerHandlerResolver: fakeProviderHandlerResolver(),
        auditLog: fakeAuditLog(), notify: fakeNotify(),
    });
    const childEnv = buildChildEnv({
        skill: 'guru', pipelineDir: PIPELINE_DIR, fsImpl, processEnv,
        pipelineExtras: {
            TELEGRAM_BOT_TOKEN: processEnv.TELEGRAM_BOT_TOKEN,
            PIPELINE_TOKEN_ALIAS: processEnv.TELEGRAM_BOT_TOKEN,
        },
        skillConfigOverride: { provider: dispatchResolution.provider },
    });
    assert.equal(childEnv.TELEGRAM_BOT_TOKEN, undefined);
    assert.equal(childEnv.PIPELINE_TOKEN_ALIAS, undefined);
    assert.equal(Object.values(childEnv).includes(processEnv.TELEGRAM_BOT_TOKEN), false);
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

// =============================================================================
// #5799 — INTEGRACION: snapshot por intento en los lanzamientos
//
// Los tests de arriba prueban que el override cross-provider llega bien a
// `buildChildEnv`. Estos prueban la capa que #5799 agrega ENCIMA: de donde sale
// el material que entra por `processEnv`.
//
// `pulpoFlowConSnapshot` replica el flujo real de `pulpo.js` post-#5799:
//
//   resolver provider efectivo  →  createAttemptSnapshot(provider efectivo)
//                               →  composeAttemptProcessEnv(base, snapshot)
//                               →  buildChildEnv({ processEnv })
//                               →  spawn
//
// La diferencia con el flujo previo es el ORDEN y el ORIGEN: el snapshot se pide
// DESPUES de saber que provider corre (asi el fallback nunca materializa la
// credencial del primario) e INMEDIATAMENTE antes de construir el env (asi una
// rotacion entra sin reiniciar). Si el snapshot falla, no hay spawn.
// =============================================================================

const {
    createAttemptSnapshot,
    composeAttemptProcessEnv,
    AttemptSnapshotError,
    SNAPSHOT_DESTINATION,
} = require('../lib/attempt-credential-snapshot');

const CFG_SNAPSHOT_ON = { pipeline: { credential_snapshot_enabled: true } };
const CFG_SNAPSHOT_OFF = { pipeline: { credential_snapshot_enabled: false } };

// `providers` del agent-models de estos tests, en el shape que lee el modulo.
function providersDelModelo(models) {
    return (models && models.providers) || {};
}

// Vault fake con VERSIONES: `bump()` simula una rotacion con el Pulpo vivo.
function fakeVault({ fallarPara = [] } = {}) {
    const versiones = { anthropic: 1, 'openai-codex': 1, gemini: 1 };
    const llamadas = [];
    const keyDe = {
        anthropic: 'ANTHROPIC_API_KEY',
        'openai-codex': 'OPENAI_API_KEY',
        gemini: 'GEMINI_API_KEY',
    };
    return {
        llamadas,
        bump(provider) { versiones[provider] += 1; },
        fn: async ({ destination, scopes, provider }) => {
            llamadas.push({ destination, provider });
            if (fallarPara.includes(provider)) {
                const e = new Error('fake vault down');
                e.name = 'CredentialSnapshotError';
                e.code = 'SNAPSHOT_VAULT_FAILURE';
                e.destination = destination;
                throw e;
            }
            return {
                destination,
                namespace: null,
                scopes: [...scopes],
                keys: [`providers.${provider}.api_key`],
                env: { [keyDe[provider]]: `vault-${provider}-v${versiones[provider]}` },
            };
        },
    };
}

// Flujo real post-#5799, con spy de spawn para afirmar el fail-closed pre-spawn.
async function pulpoFlowConSnapshot({
    skill, issue, fsImpl, processEnv, quotaModule, models,
    config = CFG_SNAPSHOT_ON, createSnapshotFn, spawnSpy,
    destination = SNAPSHOT_DESTINATION.AGENT_CHILD,
}) {
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

    if (dispatchResolution.gated) return { dispatchResolution, childEnv: null };

    // Provider EFECTIVO ya resuelto: recien ahora se pide el snapshot.
    const providersCfg = providersDelModelo(models);
    const providerEfectivo = dispatchResolution.provider;
    const { snapshot } = await createAttemptSnapshot({
        destination,
        provider: providerEfectivo,
        providersCfg,
        config,
        createSnapshotFn,
    });
    const attemptProcessEnv = composeAttemptProcessEnv({
        baseEnv: processEnv, snapshot, providersCfg,
    });

    const skillConfigOverride = (
        dispatchResolution.source === 'fallback' && dispatchResolution.provider
    ) ? { provider: dispatchResolution.provider } : undefined;

    const childEnv = buildChildEnv({
        skill,
        pipelineDir: PIPELINE_DIR,
        fsImpl,
        processEnv: attemptProcessEnv,
        pipelineExtras: { PIPELINE_ISSUE: String(issue) },
        skillConfigOverride,
    });

    if (spawnSpy) spawnSpy({ provider: providerEfectivo, env: childEnv });
    return { dispatchResolution, childEnv, attemptProcessEnv, snapshot };
}

// -----------------------------------------------------------------------------
// Pulpo — primario
// -----------------------------------------------------------------------------
test('#5799 integracion: el child del primario recibe la key DEL SNAPSHOT, no la del env del padre', async () => {
    const models = baseAgentModels();
    const fsImpl = fakeFsWithAgentModels(PIPELINE_DIR, models);
    const vault = fakeVault();
    const base = operatorProcessEnv();
    base.ANTHROPIC_API_KEY = 'sk-ant-VIEJA-DEL-BOOT';

    const { childEnv } = await pulpoFlowConSnapshot({
        skill: 'guru', issue: ISSUE, fsImpl, models,
        processEnv: base,
        quotaModule: fakeQuotaModule({ gatedProviders: [] }),
        createSnapshotFn: vault.fn,
    });

    assert.equal(childEnv.ANTHROPIC_API_KEY, 'vault-anthropic-v1');
    assert.notEqual(childEnv.ANTHROPIC_API_KEY, 'sk-ant-VIEJA-DEL-BOOT');
    assert.equal(childEnv.OPENAI_API_KEY, undefined);
    assert.equal(childEnv.GEMINI_API_KEY, undefined);
    assert.deepEqual(vault.llamadas, [{ destination: 'agent-child', provider: 'anthropic' }]);
});

test('#5799 integracion (CA-1): rotacion entre dos lanzamientos, sin reiniciar el Pulpo', async () => {
    const models = baseAgentModels();
    const fsImpl = fakeFsWithAgentModels(PIPELINE_DIR, models);
    const vault = fakeVault();
    const comun = {
        skill: 'guru', issue: ISSUE, fsImpl, models,
        processEnv: operatorProcessEnv(),
        quotaModule: fakeQuotaModule({ gatedProviders: [] }),
        createSnapshotFn: vault.fn,
    };

    const a = await pulpoFlowConSnapshot(comun);
    vault.bump('anthropic'); // rotacion; el proceso padre no se toca
    const b = await pulpoFlowConSnapshot(comun);

    assert.equal(a.childEnv.ANTHROPIC_API_KEY, 'vault-anthropic-v1');
    assert.equal(b.childEnv.ANTHROPIC_API_KEY, 'vault-anthropic-v2');
    assert.equal(process.env.ANTHROPIC_API_KEY, undefined, 'el env del padre nunca se hidrato');
});

// -----------------------------------------------------------------------------
// Pulpo — fallbacks
// -----------------------------------------------------------------------------
test('#5799 integracion (S-2 en el origen): con el primario gateado, el vault NUNCA se consulta por el primario', async () => {
    const models = baseAgentModels();
    const fsImpl = fakeFsWithAgentModels(PIPELINE_DIR, models);
    const vault = fakeVault();

    const { dispatchResolution, childEnv } = await pulpoFlowConSnapshot({
        skill: 'guru', issue: ISSUE, fsImpl, models,
        processEnv: operatorProcessEnv(),
        quotaModule: fakeQuotaModule({ gatedProviders: ['anthropic'] }),
        createSnapshotFn: vault.fn,
    });

    assert.equal(dispatchResolution.source, 'fallback');
    assert.equal(dispatchResolution.provider, 'openai-codex');
    // El material del primario no se pidio: no se materializo en ningun objeto.
    assert.deepEqual(vault.llamadas, [{ destination: 'agent-child', provider: 'openai-codex' }]);
    assert.equal(childEnv.OPENAI_API_KEY, 'vault-openai-codex-v1');
    assert.equal(childEnv.ANTHROPIC_API_KEY, undefined);
});

test('#5799 integracion: chain depth 2 — solo se consulta el vault por el eslabon que corre', async () => {
    const models = baseAgentModels();
    const fsImpl = fakeFsWithAgentModels(PIPELINE_DIR, models);
    const vault = fakeVault();

    const { dispatchResolution, childEnv } = await pulpoFlowConSnapshot({
        skill: 'security', issue: ISSUE, fsImpl, models,
        processEnv: operatorProcessEnv(),
        quotaModule: fakeQuotaModule({ gatedProviders: ['anthropic', 'openai-codex'] }),
        createSnapshotFn: vault.fn,
    });

    assert.equal(dispatchResolution.provider, 'gemini');
    assert.deepEqual(vault.llamadas, [{ destination: 'agent-child', provider: 'gemini' }]);
    assert.equal(childEnv.GEMINI_API_KEY, 'vault-gemini-v1');
    assert.equal(childEnv.ANTHROPIC_API_KEY, undefined);
    assert.equal(childEnv.OPENAI_API_KEY, undefined);
});

test('#5799 integracion: los scopes del skill son ortogonales al snapshot (github/aws siguen llegando)', async () => {
    const models = baseAgentModels();
    const fsImpl = fakeFsWithAgentModels(PIPELINE_DIR, models);
    const vault = fakeVault();

    const { childEnv } = await pulpoFlowConSnapshot({
        skill: 'security', issue: ISSUE, fsImpl, models,
        processEnv: operatorProcessEnv(),
        quotaModule: fakeQuotaModule({ gatedProviders: ['anthropic'] }),
        createSnapshotFn: vault.fn,
    });

    assert.equal(childEnv.GH_TOKEN, 'ghp_XXXX');
    assert.equal(childEnv.AWS_ACCESS_KEY_ID, 'AKIAXXX');
    assert.equal(childEnv.OPENAI_API_KEY, 'vault-openai-codex-v1');
    assert.equal(childEnv.PIPELINE_ISSUE, String(ISSUE));
});

test('#5799 integracion: el skill sin scope aws NO recibe AWS_* (no puede consultar el vault)', async () => {
    const models = baseAgentModels();
    const fsImpl = fakeFsWithAgentModels(PIPELINE_DIR, models);
    const vault = fakeVault();

    // `guru` declara solo `github`.
    const { childEnv } = await pulpoFlowConSnapshot({
        skill: 'guru', issue: ISSUE, fsImpl, models,
        processEnv: operatorProcessEnv(),
        quotaModule: fakeQuotaModule({ gatedProviders: [] }),
        createSnapshotFn: vault.fn,
    });

    assert.equal(childEnv.AWS_ACCESS_KEY_ID, undefined);
    assert.equal(childEnv.AWS_SECRET_ACCESS_KEY, undefined);
    assert.equal(childEnv.AWS_SESSION_TOKEN, undefined);
    assert.equal(childEnv.AWS_PROFILE, undefined);
    // Ni metadata del vault: nada de driver, ARN, prefix ni path.
    for (const k of Object.keys(childEnv)) {
        assert.ok(!/VAULT|SECRETS_MANAGER|_ARN$|_PREFIX$/i.test(k), `variable sospechosa en el child: ${k}`);
    }
    // Y el token reservado tampoco, ni por nombre ni por valor.
    assert.equal(childEnv.TELEGRAM_BOT_TOKEN, undefined);
    assert.ok(!Object.values(childEnv).includes('tg-bot'));
});

// -----------------------------------------------------------------------------
// Fail-closed pre-spawn
// -----------------------------------------------------------------------------
test('#5799 integracion (CA-4): snapshot invalido aborta ANTES del spawn (cero llamadas a spawn)', async () => {
    const models = baseAgentModels();
    const fsImpl = fakeFsWithAgentModels(PIPELINE_DIR, models);
    const vault = fakeVault({ fallarPara: ['anthropic'] });
    let spawns = 0;

    await assert.rejects(
        () => pulpoFlowConSnapshot({
            skill: 'guru', issue: ISSUE, fsImpl, models,
            processEnv: operatorProcessEnv(),
            quotaModule: fakeQuotaModule({ gatedProviders: [] }),
            createSnapshotFn: vault.fn,
            spawnSpy: () => { spawns += 1; },
        }),
        AttemptSnapshotError,
    );
    assert.equal(spawns, 0, 'no se spawneo nada con el snapshot en falla');
});

test('#5799 integracion (CA-4): el fallback tambien aborta pre-spawn si SU snapshot falla', async () => {
    const models = baseAgentModels();
    const fsImpl = fakeFsWithAgentModels(PIPELINE_DIR, models);
    const vault = fakeVault({ fallarPara: ['openai-codex'] });
    let spawns = 0;

    await assert.rejects(
        () => pulpoFlowConSnapshot({
            skill: 'guru', issue: ISSUE, fsImpl, models,
            processEnv: operatorProcessEnv(),
            quotaModule: fakeQuotaModule({ gatedProviders: ['anthropic'] }),
            createSnapshotFn: vault.fn,
            spawnSpy: () => { spawns += 1; },
        }),
        (e) => {
            assert.equal(e.code, 'SNAPSHOT_VAULT_FAILURE');
            assert.equal(e.provider, 'openai-codex');
            return true;
        },
    );
    assert.equal(spawns, 0);
});

test('#5799 integracion: con el gate CERRADO el flujo es el legacy y no toca el vault', async () => {
    const models = baseAgentModels();
    const fsImpl = fakeFsWithAgentModels(PIPELINE_DIR, models);
    const vault = fakeVault({ fallarPara: ['anthropic', 'openai-codex', 'gemini'] });
    let spawns = 0;

    const { childEnv } = await pulpoFlowConSnapshot({
        skill: 'guru', issue: ISSUE, fsImpl, models,
        processEnv: operatorProcessEnv(),
        quotaModule: fakeQuotaModule({ gatedProviders: [] }),
        config: CFG_SNAPSHOT_OFF,
        createSnapshotFn: vault.fn,
        spawnSpy: () => { spawns += 1; },
    });

    assert.equal(vault.llamadas.length, 0, 'gate cerrado = cero llamadas al vault');
    assert.equal(spawns, 1, 'el lanzamiento sigue ocurriendo');
    assert.equal(childEnv.ANTHROPIC_API_KEY, 'sk-ant-PRIMARY-secret', 'material del env del padre (legacy)');
});

// -----------------------------------------------------------------------------
// Commander
// -----------------------------------------------------------------------------
test('#5799 integracion: el Commander usa su propio destino del catalogo', async () => {
    const models = baseAgentModels();
    const fsImpl = fakeFsWithAgentModels(PIPELINE_DIR, models);
    const vault = fakeVault();

    await pulpoFlowConSnapshot({
        skill: 'guru', issue: ISSUE, fsImpl, models,
        processEnv: operatorProcessEnv(),
        quotaModule: fakeQuotaModule({ gatedProviders: [] }),
        createSnapshotFn: vault.fn,
        destination: SNAPSHOT_DESTINATION.COMMANDER,
    });

    assert.deepEqual(vault.llamadas, [{ destination: 'commander', provider: 'anthropic' }]);
});

test('#5799 integracion: reintento del Commander sobre una rotacion recibe la version nueva', async () => {
    const models = baseAgentModels();
    const fsImpl = fakeFsWithAgentModels(PIPELINE_DIR, models);
    const vault = fakeVault();
    const comun = {
        skill: 'guru', issue: ISSUE, fsImpl, models,
        processEnv: operatorProcessEnv(),
        quotaModule: fakeQuotaModule({ gatedProviders: [] }),
        createSnapshotFn: vault.fn,
        destination: SNAPSHOT_DESTINATION.COMMANDER,
    };

    const intento1 = await pulpoFlowConSnapshot(comun);
    vault.bump('anthropic');
    const intento2 = await pulpoFlowConSnapshot(comun); // reintento del glitch 1M

    assert.equal(intento1.childEnv.ANTHROPIC_API_KEY, 'vault-anthropic-v1');
    assert.equal(intento2.childEnv.ANTHROPIC_API_KEY, 'vault-anthropic-v2');
    assert.notEqual(intento1.childEnv, intento2.childEnv);
});

// -----------------------------------------------------------------------------
// Concurrencia
// -----------------------------------------------------------------------------
test('#5799 integracion (CA-2): lanzamientos concurrentes con providers distintos no se contaminan', async () => {
    const models = baseAgentModels();
    const fsImpl = fakeFsWithAgentModels(PIPELINE_DIR, models);
    const vault = fakeVault();

    const [primario, fallback] = await Promise.all([
        pulpoFlowConSnapshot({
            skill: 'guru', issue: ISSUE, fsImpl, models,
            processEnv: operatorProcessEnv(),
            quotaModule: fakeQuotaModule({ gatedProviders: [] }),
            createSnapshotFn: vault.fn,
        }),
        pulpoFlowConSnapshot({
            skill: 'security', issue: ISSUE + 1, fsImpl, models,
            processEnv: operatorProcessEnv(),
            quotaModule: fakeQuotaModule({ gatedProviders: ['anthropic'] }),
            createSnapshotFn: vault.fn,
        }),
    ]);

    assert.equal(primario.childEnv.ANTHROPIC_API_KEY, 'vault-anthropic-v1');
    assert.equal(primario.childEnv.OPENAI_API_KEY, undefined);
    assert.equal(fallback.childEnv.OPENAI_API_KEY, 'vault-openai-codex-v1');
    assert.equal(fallback.childEnv.ANTHROPIC_API_KEY, undefined);

    assert.notEqual(primario.childEnv, fallback.childEnv);
    assert.notEqual(primario.attemptProcessEnv, fallback.attemptProcessEnv);
    assert.notEqual(primario.snapshot, fallback.snapshot);

    // Mutar el env de un lanzamiento no alcanza al otro.
    primario.childEnv.ANTHROPIC_API_KEY = 'CONTAMINADA';
    assert.equal(fallback.childEnv.OPENAI_API_KEY, 'vault-openai-codex-v1');
});
