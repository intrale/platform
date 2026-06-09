// =============================================================================
// wizard-providers-regex.test.js — CA-4 + security R#1/R#3.
//
// Valida `validateProviderKey` con ≥2 inválidos + 1 válido por provider de
// ENV_MAPPING, el masking unificado y que el rechazo NUNCA devuelve el input
// crudo.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { validateProviderKey, maskKey, last4Of, PROVIDER_REGEX } = require('../../lib/providers-key-validator');

// Keys válidas (formato, no reales) por provider.
const VALID = {
    anthropic: 'sk-ant-' + 'A'.repeat(48),
    openai:    'sk-' + 'B'.repeat(48),
    google:    'C'.repeat(39),
    cerebras:  'csk-' + 'D'.repeat(40),
    nvidia:    'nvapi-' + 'E'.repeat(40),
};

// ≥2 inválidos por provider (prefijo errado / muy corta).
const INVALID = {
    anthropic: ['sk-' + 'A'.repeat(48), 'sk-ant-short', ''],
    openai:    ['nope-' + 'B'.repeat(48), 'sk-', 123],
    google:    ['short', 'has space here aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', null],
    cerebras:  ['sk-' + 'D'.repeat(40), 'csk-short', undefined],
    nvidia:    ['nv-' + 'E'.repeat(40), 'nvapi-short', {}],
};

test('cada provider de PROVIDER_REGEX tiene válido + inválidos definidos', () => {
    for (const name of Object.keys(PROVIDER_REGEX)) {
        assert.ok(VALID[name], `falta caso válido para ${name}`);
        assert.ok(Array.isArray(INVALID[name]) && INVALID[name].length >= 2, `faltan inválidos para ${name}`);
    }
});

test('keys válidas pasan y devuelven last4 correcto', () => {
    for (const [name, key] of Object.entries(VALID)) {
        const r = validateProviderKey(name, key);
        assert.equal(r.ok, true, `${name} debería ser válido`);
        assert.equal(r.last4, key.slice(-4));
        // El retorno NUNCA incluye la key cruda.
        assert.ok(!JSON.stringify(r).includes(key), `${name}: el retorno filtró la key`);
    }
});

test('keys inválidas se rechazan sin ecoar el input', () => {
    for (const [name, list] of Object.entries(INVALID)) {
        for (const bad of list) {
            const r = validateProviderKey(name, bad);
            assert.equal(r.ok, false, `${name}: "${String(bad)}" debería rechazarse`);
            assert.equal(r.reason, 'format_invalid');
            // Defensa: el motivo no contiene el input crudo.
            if (typeof bad === 'string' && bad.length > 0) {
                assert.ok(!JSON.stringify(r).includes(bad), `${name}: el rechazo filtró el input`);
            }
        }
    }
});

test('provider desconocido → unknown_provider (no toca regex)', () => {
    const r = validateProviderKey('openai_api_key', VALID.openai);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'unknown_provider');
});

test('maskKey produce sk-•••••<last4> y nunca la key completa', () => {
    assert.equal(maskKey('ABCD'), 'sk-•••••ABCD');
    // Sólo los últimos 4 chars sobreviven al masking.
    assert.equal(maskKey('XYZWVU'), 'sk-•••••ZWVU');
    assert.equal(maskKey(null), null);
    assert.equal(maskKey(''), null);
});

test('last4Of devuelve null si no hay key o es corta', () => {
    assert.equal(last4Of(null), null);
    assert.equal(last4Of(''), null);
    assert.equal(last4Of('ab'), null);
    assert.equal(last4Of('abcdef'), 'cdef');
});
