// =============================================================================
// kimi-provider-4880.test.js — Integración de Kimi (Moonshot) como provider
// CLI-first drop-in de Claude Code (#4880).
//
// Cubre los CA verificables como código del issue:
//   - CA-1 : entry providers.kimi-moonshot bien formada (launcher/parser/auth).
//   - CA-2 : el config con Kimi valida fail-closed (validate + validate-chains).
//   - CA-3 : capabilities:[] excluye a Kimi de roles agénticos (fail-closed).
//   - CA-4 : Kimi sólo en fallbacks de roles no-agénticos (po/review).
//   - CA-5 : SEC-1 — el child de Kimi NUNCA recibe la ANTHROPIC_API_KEY real.
//   - CA-7 : SEC-2 — ANTHROPIC_BASE_URL sólo en el child de Kimi, constante de
//            código, jamás propagada desde processEnv ni a otros providers.
//   - CA-10: credencial en la fuente única mapeada a ANTHROPIC_AUTH_TOKEN.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { buildChildEnv, PROVIDER_STATIC_ENV } = require('../lib/build-child-env');
const amv = require('../lib/agent-models-validate');
const vc = require('../lib/multi-provider/validate-chains');
const cred = require('../lib/credentials');
const modelCatalog = require('../lib/multi-provider/model-catalog');
const providerQuota = require('../lib/provider-quota');

const CONFIG = require('../agent-models.json');
const KIMI = 'kimi-moonshot';
const KIMI_MODEL = 'kimi-k2-6';
const KIMI_BASE_URL = 'https://api.moonshot.ai/anthropic';

// Env "worst case": el operador tiene la key REAL de Anthropic, el token de
// Kimi, y hasta una ANTHROPIC_BASE_URL global maliciosa. Ninguna debe filtrarse
// donde no corresponde.
function operatorEnv(extra = {}) {
    return {
        PATH: '/usr/bin:/bin',
        ANTHROPIC_API_KEY: 'sk-ant-REAL-anthropic-oauth-token-NO-LEAK',
        ANTHROPIC_AUTH_TOKEN: 'kimi-moonshot-token-value',
        ANTHROPIC_BASE_URL: 'https://evil.attacker.example/poison',
        OPENAI_API_KEY: 'openai-NO-LEAK',
        CEREBRAS_API_KEY: 'cerebras-key',
        TELEGRAM_BOT_TOKEN: 'tg-bot',
        TELEGRAM_CHAT_ID: 'tg-chat',
        ...extra,
    };
}

function kimiChildEnv(env) {
    // Full override: forzamos el provider del skill a kimi-moonshot preservando
    // el bloque real de providers (para resolver credentials_env/auth_mode).
    return buildChildEnv({
        skill: 'review',
        processEnv: env,
        skillConfigOverride: {
            skill: { provider: KIMI },
            providers: CONFIG.providers,
        },
    });
}

// -----------------------------------------------------------------------------
// CA-1 — Entry bien formada.
// -----------------------------------------------------------------------------
test('CA-1 · providers.kimi-moonshot declara launcher/parser/auth esperados', () => {
    const p = CONFIG.providers[KIMI];
    assert.ok(p, 'debe existir la entry kimi-moonshot');
    assert.equal(p.launcher, 'claude', 'reusa el launcher claude (drop-in)');
    assert.equal(p.output_parser, 'anthropic-stream-json', 'reusa el parser Anthropic');
    assert.equal(p.auth_mode, 'api_key', 'auth por api-key, NO oauth');
    assert.equal(p.supports_tool_use, false, 'no agéntico');
    assert.deepEqual(p.capabilities, [], 'capabilities vacío → excluido de agénticos');
    assert.deepEqual(p.credentials_env, ['ANTHROPIC_AUTH_TOKEN'], 'token propio, no la key Anthropic');
    assert.equal(p.model, KIMI_MODEL);
});

// -----------------------------------------------------------------------------
// CA-2 — El config con Kimi valida fail-closed (no rompe nada).
// -----------------------------------------------------------------------------
test('CA-2 · agent-models.json valida OK con Kimi (validate + validate-chains)', () => {
    const r = amv.validate(path.join(__dirname, '..', 'agent-models.json'));
    assert.equal(r.ok, true, `validate debe pasar; errores: ${JSON.stringify(r.errors)}`);

    const chains = vc.validateChains(CONFIG);
    assert.equal(chains.ok, true, `validate-chains debe pasar; errores: ${JSON.stringify(chains.errors)}`);
});

test('CA-2b · ANTHROPIC_AUTH_TOKEN y kimi-k2-6 están en las allowlists', () => {
    assert.ok(
        amv.ALLOWED_CREDENTIAL_ENV_VARS.includes('ANTHROPIC_AUTH_TOKEN'),
        'ANTHROPIC_AUTH_TOKEN debe estar en ALLOWED_CREDENTIAL_ENV_VARS',
    );
    assert.ok(
        amv.ALLOWED_MODELS_BY_LAUNCHER.claude.includes(KIMI_MODEL),
        'kimi-k2-6 debe estar en ALLOWED_MODELS_BY_LAUNCHER.claude',
    );
});

// -----------------------------------------------------------------------------
// CA-3 — capabilities:[] excluye a Kimi de roles agénticos (fail-closed).
// -----------------------------------------------------------------------------
test('CA-3 · Kimi como fallback de un rol agéntico es rechazado fail-closed', () => {
    const bad = JSON.parse(JSON.stringify(CONFIG));
    bad.skills['pipeline-dev'].fallbacks.push({ provider: KIMI, model_override: KIMI_MODEL });
    const errs = amv.validateExecutionCapabilities(bad);
    assert.ok(errs.length >= 1, 'debe emitir error de capability');
    assert.ok(
        errs.some(e => e.message.includes(KIMI) && e.message.includes('agentic-tool-use')),
        `el error debe mencionar a kimi y la capability faltante: ${JSON.stringify(errs)}`,
    );
});

test('CA-3b · el config real NO ubica a Kimi en ningún rol con required_capabilities', () => {
    const errs = amv.validateExecutionCapabilities(CONFIG);
    assert.equal(errs.length, 0, `no debe haber violaciones de capability: ${JSON.stringify(errs)}`);
});

// -----------------------------------------------------------------------------
// CA-4 — Kimi sólo en fallbacks de roles no-agénticos (po/review).
// -----------------------------------------------------------------------------
test('CA-4 · Kimi aparece sólo en fallbacks de roles sin required_capabilities', () => {
    for (const [skillName, skillDef] of Object.entries(CONFIG.skills)) {
        const fbs = Array.isArray(skillDef.fallbacks) ? skillDef.fallbacks : [];
        const hasKimi = fbs.some(f => (typeof f === 'string' ? f : f && f.provider) === KIMI);
        if (hasKimi) {
            assert.ok(
                !Array.isArray(skillDef.required_capabilities) || skillDef.required_capabilities.length === 0,
                `Kimi no debe estar en el rol agéntico "${skillName}"`,
            );
        }
    }
    // Y debe estar presente al menos en po y review (roles no-agénticos objetivo).
    for (const role of ['po', 'review']) {
        const fbs = CONFIG.skills[role].fallbacks || [];
        assert.ok(
            fbs.some(f => (typeof f === 'string' ? f : f.provider) === KIMI),
            `Kimi debe estar en el fallback de "${role}"`,
        );
    }
});

// -----------------------------------------------------------------------------
// CA-5 — SEC-1: el child de Kimi NUNCA recibe la ANTHROPIC_API_KEY real.
// -----------------------------------------------------------------------------
test('CA-5 · child Kimi recibe su token y NUNCA la ANTHROPIC_API_KEY real (SEC-1)', () => {
    const env = kimiChildEnv(operatorEnv());
    assert.equal(env.ANTHROPIC_AUTH_TOKEN, 'kimi-moonshot-token-value', 'recibe su propio token');
    assert.equal(env.ANTHROPIC_API_KEY, undefined, 'NUNCA la key real de Anthropic');
    assert.equal(env.OPENAI_API_KEY, undefined, 'ni la de otro provider');
    assert.equal(env.CEREBRAS_API_KEY, undefined, 'ni la de otro provider');
});

// -----------------------------------------------------------------------------
// CA-7 — SEC-2: ANTHROPIC_BASE_URL scopeada, constante, no propagada.
// -----------------------------------------------------------------------------
test('CA-7 · ANTHROPIC_BASE_URL es constante de código sólo en el child Kimi (SEC-2)', () => {
    const env = kimiChildEnv(operatorEnv());
    assert.equal(env.ANTHROPIC_BASE_URL, KIMI_BASE_URL, 'usa la constante de código, no la global maliciosa');
    assert.notEqual(env.ANTHROPIC_BASE_URL, 'https://evil.attacker.example/poison');
});

test('CA-7b · childs de otros providers NO reciben ANTHROPIC_BASE_URL', () => {
    for (const provider of ['anthropic', 'openai-codex', 'cerebras']) {
        const env = buildChildEnv({
            skill: 'review',
            processEnv: operatorEnv(),
            skillConfigOverride: { skill: { provider }, providers: CONFIG.providers },
        });
        assert.equal(
            env.ANTHROPIC_BASE_URL, undefined,
            `el child de ${provider} NO debe recibir ANTHROPIC_BASE_URL (aunque esté global en el env)`,
        );
    }
});

test('CA-7c · PROVIDER_STATIC_ENV expone kimi-moonshot con URL HTTPS literal', () => {
    const staticEnv = PROVIDER_STATIC_ENV[KIMI];
    assert.ok(staticEnv, 'debe existir el mapa estático de kimi-moonshot');
    assert.equal(staticEnv.ANTHROPIC_BASE_URL, KIMI_BASE_URL);
    assert.ok(staticEnv.ANTHROPIC_BASE_URL.startsWith('https://'), 'debe ser HTTPS (anti-SSRF)');
    // No hay flags de bypass TLS ni proxy en el mapa estático.
    assert.equal(staticEnv.NODE_TLS_REJECT_UNAUTHORIZED, undefined);
});

// -----------------------------------------------------------------------------
// CA-10 — Credencial en la fuente única, mapeada a ANTHROPIC_AUTH_TOKEN.
// -----------------------------------------------------------------------------
test('CA-10 · credentials.js mapea providers.moonshot.api_key → ANTHROPIC_AUTH_TOKEN', () => {
    assert.equal(cred.ENV_MAPPING['providers.moonshot.api_key'], 'ANTHROPIC_AUTH_TOKEN');
});

// -----------------------------------------------------------------------------
// Catálogo y clasificación de cuota (CA-9 — sin snapshot MAX).
// -----------------------------------------------------------------------------
test('CA-9 · Kimi se clasifica con medición local (no PAID/snapshot MAX)', () => {
    assert.equal(providerQuota.isPaidProvider(KIMI), false, 'NO usa el contador central PAID/snapshot MAX');
    assert.equal(providerQuota.isFreeProvider(KIMI), true, 'medición local estilo FREE');
});

test('CA-9b · model-catalog expone kimi-k2-6 con ventana de contexto y costo', () => {
    const m = modelCatalog.getModel(KIMI_MODEL);
    assert.ok(m, 'kimi-k2-6 debe estar en el catálogo');
    assert.ok(m.context_window > 0, 'ventana de contexto declarada');
    assert.ok(m.cost_per_1m && typeof m.cost_per_1m.input === 'number', 'costo declarado (no-bloqueante)');
});
