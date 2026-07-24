// =============================================================================
// __tests__/provider-death-classifier.test.js — Issue #4648.
//
// Cobertura de la clasificación provider-death vs agent-death (CA-1, CA-5 y
// escenarios Gherkin del issue). Función PURA: sin IO, sin fixtures.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { classifyPrematureDeath } = require('../provider-death-classifier');

test('muerte <15s code=1 con provider fallback → provider-death (no penaliza al issue)', () => {
    // Gherkin: Anthropic gateado, fallback gemini-google muere al spawn en 5s.
    const v = classifyPrematureDeath({
        code: 1, elapsedSec: 5, hasVerdict: false,
        source: 'fallback', provider: 'gemini-google',
    });
    assert.equal(v.kind, 'provider-death');
    assert.match(v.reason, /gemini-google/);
});

test('muerte <15s code=1 con primary disponible → agent-death (SÍ penaliza — CA-5)', () => {
    // Gherkin: Anthropic disponible, qa:#4632 muere en 3s por su propio código.
    const v = classifyPrematureDeath({
        code: 1, elapsedSec: 3, hasVerdict: false,
        source: 'primary', provider: 'anthropic',
    });
    assert.equal(v.kind, 'agent-death');
});

test('source ausente (resolver falló) → agent-death (fail-closed conservador)', () => {
    const v = classifyPrematureDeath({
        code: 1, elapsedSec: 4, hasVerdict: false,
        source: null, provider: null,
    });
    assert.equal(v.kind, 'agent-death');
});

test('exit 0 → normal (no es muerte prematura) aunque sea fallback', () => {
    const v = classifyPrematureDeath({
        code: 0, elapsedSec: 5, hasVerdict: false,
        source: 'fallback', provider: 'gemini-google',
    });
    assert.equal(v.kind, 'normal');
    assert.equal(v.reason, 'not_premature');
});

test('vivió ≥ umbral → normal aunque code≠0 y fallback', () => {
    const v = classifyPrematureDeath({
        code: 1, elapsedSec: 40, hasVerdict: false,
        source: 'fallback', provider: 'gemini-google',
    });
    assert.equal(v.kind, 'normal');
});

test('con veredicto válido → normal (no muerte prematura, #2524)', () => {
    const v = classifyPrematureDeath({
        code: 1, elapsedSec: 2, hasVerdict: true,
        source: 'fallback', provider: 'gemini-google',
    });
    assert.equal(v.kind, 'normal');
    assert.equal(v.reason, 'verdict');
});

test('source dispatch-fallback también cuenta como provider-death', () => {
    const v = classifyPrematureDeath({
        code: 1, elapsedSec: 6, hasVerdict: false,
        source: 'dispatch-fallback', provider: 'cerebras',
    });
    assert.equal(v.kind, 'provider-death');
});

test('provider deterministic nunca es provider-death (skill Node puro)', () => {
    const v = classifyPrematureDeath({
        code: 1, elapsedSec: 2, hasVerdict: false,
        source: 'fallback', provider: 'deterministic',
    });
    assert.equal(v.kind, 'agent-death');
});

test('umbral configurable (prematureSec)', () => {
    const v = classifyPrematureDeath({
        code: 1, elapsedSec: 20, hasVerdict: false,
        source: 'fallback', provider: 'gemini-google',
        prematureSec: 30,
    });
    assert.equal(v.kind, 'provider-death');
});
