// =============================================================================
// Tests quota-adapters/index.js — dispatch + allowlist + fail-secure (#3092)
//
// Cubre los CAs de seguridad del análisis previo:
//
//   * security CA-#1 — provider validado contra allowlist hardcoded ANTES de
//                       cualquier dispatch / lookup / path. Path-traversal y
//                       provider-poisoning bloqueados.
//   * security CA-#3 — fail-secure: cuando el adapter falla, se devuelve
//                       `adapterStatus: 'error'` con `pct: null` (NO 0).
//
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

function freshDispatch() {
    delete require.cache[require.resolve('../../quota-adapters')];
    delete require.cache[require.resolve('../../quota-adapters/_shape')];
    return require('../../quota-adapters');
}

test('ALLOWED_PROVIDERS exporta lista freezada de providers conocidos', () => {
    const { ALLOWED_PROVIDERS } = freshDispatch();
    assert.ok(Array.isArray(ALLOWED_PROVIDERS));
    assert.ok(ALLOWED_PROVIDERS.includes('anthropic'));
    assert.ok(ALLOWED_PROVIDERS.includes('openai-codex'));
    // #3220 — rename `gemini` → `gemini-google` + sumamos `cerebras`.
    // #3353 — `groq` removido tras descontinuación del provider.
    assert.ok(ALLOWED_PROVIDERS.includes('gemini-google'));
    assert.ok(!ALLOWED_PROVIDERS.includes('groq'), 'groq debería estar removido tras #3353');
    assert.ok(ALLOWED_PROVIDERS.includes('cerebras'));
    assert.ok(ALLOWED_PROVIDERS.includes('ollama'));
    assert.ok(ALLOWED_PROVIDERS.includes('deterministic'));
    assert.equal(Object.isFrozen(ALLOWED_PROVIDERS), true,
        'ALLOWED_PROVIDERS debe estar freezada (defensa contra mutación en runtime)');
});

test('quotaUsage rechaza provider null/undefined/string vacío con adapterStatus error', () => {
    const { quotaUsage } = freshDispatch();
    for (const bad of [null, undefined, '', 0, {}, []]) {
        const r = quotaUsage(bad, {});
        assert.equal(r.adapterStatus, 'error', `provider ${JSON.stringify(bad)} debe ser rechazado`);
        assert.equal(r.pct, null, 'pct debe ser null, NO 0 — distinguir degradado de "0% real"');
    }
});

test('quotaUsage rechaza providers fuera de allowlist (security CA-#1)', () => {
    const { quotaUsage } = freshDispatch();
    // Vectores de inyección clásicos que un PR malicioso podría intentar.
    const evilProviders = [
        'evil',
        '../etc/passwd',
        'anthropic/../malicious',
        'anthropic\x00',                 // NUL byte
        'anthropic ',                     // whitespace
        'ANTHROPIC',                      // case-mismatch (la allowlist es case-sensitive)
        'Anthropic',
        '<script>',
        'anthropic;rm -rf /',
    ];
    for (const evil of evilProviders) {
        const r = quotaUsage(evil, {});
        assert.equal(r.adapterStatus, 'error', `provider "${evil}" debe ser rechazado`);
        assert.match(r.errorReason, /allowlist/, `errorReason debe mencionar allowlist`);
        assert.equal(r.pct, null);
        assert.equal(r.hoursUsed7d, null);
    }
});

test('quotaUsage rechaza sessionData no-objeto con error claro', () => {
    const { quotaUsage } = freshDispatch();
    for (const bad of [null, undefined, 'string', 42, true]) {
        const r = quotaUsage('anthropic', bad);
        assert.equal(r.adapterStatus, 'error');
        assert.match(r.errorReason, /sessionData/);
    }
});

test('fail-secure: si el adapter lanza excepción, dispatch devuelve error sin propagar (security CA-#3)', () => {
    // Mock adapter que tira excepción
    const adaptersDir = require.resolve('../../quota-adapters');
    delete require.cache[adaptersDir];
    delete require.cache[require.resolve('../../quota-adapters/anthropic')];

    // Inyectar un módulo que tira excepción para el adapter "ollama" (uno
    // que no se usa frecuentemente). Stub directo del cache de require.
    const fakeOllamaPath = require.resolve('../../quota-adapters/ollama');
    delete require.cache[fakeOllamaPath];
    require.cache[fakeOllamaPath] = {
        id: fakeOllamaPath,
        filename: fakeOllamaPath,
        loaded: true,
        exports: function explodingAdapter() {
            throw new Error('boom — adapter rotó');
        },
    };

    const { quotaUsage } = require('../../quota-adapters');
    const r = quotaUsage('ollama', {});
    assert.equal(r.adapterStatus, 'error');
    assert.match(r.errorReason, /excepción|excepcion|boom/);
    assert.equal(r.pct, null, 'pct debe ser null tras excepción del adapter');

    // Limpieza para no contaminar otros tests.
    delete require.cache[fakeOllamaPath];
    delete require.cache[adaptersDir];
});

test('fail-secure: si el adapter devuelve no-objeto, dispatch devuelve error', () => {
    const adaptersDir = require.resolve('../../quota-adapters');
    delete require.cache[adaptersDir];
    // #3220 — adapter renombrado a gemini-google.
    const fakeGeminiPath = require.resolve('../../quota-adapters/gemini-google');
    delete require.cache[fakeGeminiPath];
    require.cache[fakeGeminiPath] = {
        id: fakeGeminiPath,
        filename: fakeGeminiPath,
        loaded: true,
        exports: function brokenAdapter() {
            return 'not-an-object';
        },
    };

    const { quotaUsage } = require('../../quota-adapters');
    const r = quotaUsage('gemini-google', {});
    assert.equal(r.adapterStatus, 'error');
    assert.match(r.errorReason, /shape inválido|shape invalido/);

    delete require.cache[fakeGeminiPath];
    delete require.cache[adaptersDir];
});

test('quotaUsage devuelve schemaVersion=2 incluso en estados de error (forward-compat)', () => {
    const { quotaUsage } = freshDispatch();
    const r = quotaUsage('evil', {});
    assert.equal(r.schemaVersion, 2);
    // breakdown[] incluido aunque vacío (forward-compat para Fase 2).
    assert.deepEqual(r.breakdown, []);
});
