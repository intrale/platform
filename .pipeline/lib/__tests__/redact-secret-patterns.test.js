// =============================================================================
// redact-secret-patterns.test.js — Tests DELTA de los patterns de valor
// agregados en #3724 (escaneo por VALOR + heurística de entropía).
//
// Cero-regresión sobre #2307: este archivo NO testea las funciones viejas
// (eso lo cubre `redact.test.js`, que debe seguir verde). Acá solo validamos
// lo nuevo: `redactObject`, `redactSecretValue`, `SECRET_VALUE_PATTERNS`.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const redact = require('../redact');

test('a · cada uno de los 5 patterns de proveedor es redactado', () => {
    const cases = {
        anthropic: 'sk-ant-api03-AbCdEf123456789_xyz',
        openai: 'sk-ABCDEFGHIJKLMNOPQRSTUVWX123456',
        groq: 'gsk_AbCd1234EfGh5678',
        aws: 'AKIAIOSFODNN7EXAMPLE',
        jwt: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.abcDEFsig123',
    };
    for (const [name, secret] of Object.entries(cases)) {
        const out = redact.redactObject({ note: secret });
        assert.equal(out.note.includes(secret), false, `${name}: el secreto no debe quedar en claro`);
        assert.ok(out.note.includes(redact.REDACTION_MARKER), `${name}: debe tener marcador`);
    }
});

test('a.2 · sk-ant- se prioriza sobre sk- genérico (no se rompe el match)', () => {
    const out = redact.redactObject({ k: 'sk-ant-api03-secretovalor1234567890' });
    assert.equal(out.k, redact.REDACTION_MARKER);
});

test('b · heurística entropía: token random >40 chars (entropy ≥ 4.5) → [REDACTED:high-entropy]', () => {
    // Token base64url de 48 bytes → ~64 chars, alta entropía, sin formato conocido.
    const highEntropy = 'Zk9pQ2xWb3JmN3RhU2RmZ0hqS2xQb1d4Q3pWYk5tQXNkRmdIakts';
    const out = redact.redactObject({ blob: highEntropy });
    assert.equal(out.blob, redact.HIGH_ENTROPY_MARKER);
});

test('c · string legítimo >40 chars con entropía baja → NO redactado', () => {
    const legit = 'Buenos Aires es la capital de la Republica Argentina';
    assert.ok(legit.length > 40);
    const out = redact.redactObject({ texto: legit });
    assert.equal(out.texto, legit, 'texto natural no debe redactarse');
});

test('d · redactObject combina redacción por clave + por valor + anidados', () => {
    const out = redact.redactObject({
        api_key: 'no-importa-el-valor',        // clave sensible → marcador
        nested: { token: 'x', free: 'sk-ant-abc123def456ghi789' },
        list: ['gsk_secret123456', 'texto normal corto'],
    });
    assert.equal(out.api_key, redact.REDACTION_MARKER);          // por clave
    assert.equal(out.nested.token, redact.REDACTION_MARKER);     // por clave anidada
    assert.equal(out.nested.free, redact.REDACTION_MARKER);      // por valor (pattern)
    assert.equal(out.list[0], redact.REDACTION_MARKER);          // por valor en array
    assert.equal(out.list[1], 'texto normal corto');            // intacto
});

test('e · SECRET_VALUE_PATTERNS está congelado y exportado', () => {
    assert.ok(Array.isArray(redact.SECRET_VALUE_PATTERNS));
    assert.equal(Object.isFrozen(redact.SECRET_VALUE_PATTERNS), true);
    assert.ok(redact.SECRET_VALUE_PATTERNS.length >= 5);
});

test('f · shannonEntropy: natural < umbral, random ≥ umbral', () => {
    const low = redact.shannonEntropy('aaaaaaaaaaaaaaaaaaaa');
    const high = redact.shannonEntropy('Zk9pQ2xWb3JmN3RhU2RmZ0hqS2xQb1d4Q3pWYk5tQXNkRmdIakts');
    assert.ok(low < redact.HIGH_ENTROPY_THRESHOLD);
    assert.ok(high >= redact.HIGH_ENTROPY_THRESHOLD);
});
