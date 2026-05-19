// =============================================================================
// Tests quota-adapters/{ollama,deterministic,gemini-google,cerebras}.js
// — stubs (#3092 + #3220 + #3353)
//
// Estos adapters son stubs simples: ollama y deterministic devuelven
// `no_quota` (no consumen cuota); gemini-google y cerebras devuelven
// `not_implemented` (cálculo de cuota real llega con runtime fallbacks[]
// — #3198). Groq fue descontinuado en #3353.
//
// Validación clave: el shape devuelto distingue NETAMENTE entre "no hay
// cuota" (banner debe ocultarlos del agregado, no contarlos como 0%) y
// "no implementado" (banner debe mostrar estado degradado con copy).
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

function fresh(adapterName) {
    delete require.cache[require.resolve(`../../quota-adapters/${adapterName}`)];
    delete require.cache[require.resolve('../../quota-adapters/_shape')];
    return require(`../../quota-adapters/${adapterName}`);
}

test('ollama adapter devuelve no_quota (sin cuota remota)', () => {
    const adapter = fresh('ollama');
    const r = adapter({});
    assert.equal(r.provider, 'ollama');
    assert.equal(r.adapterStatus, 'no_quota');
    assert.equal(r.status, 'no_quota');
    assert.equal(r.pct, null);
    assert.equal(r.session.status, 'no_quota');
});

test('deterministic adapter devuelve no_quota (skill sin LLM)', () => {
    const adapter = fresh('deterministic');
    const r = adapter({});
    assert.equal(r.provider, 'deterministic');
    assert.equal(r.adapterStatus, 'no_quota');
    assert.equal(r.status, 'no_quota');
    assert.equal(r.pct, null);
});

test('gemini-google adapter devuelve not_implemented (post-M2)', () => {
    // #3220 — rename ex-`gemini` → `gemini-google`.
    const adapter = fresh('gemini-google');
    const r = adapter({});
    assert.equal(r.provider, 'gemini-google');
    assert.equal(r.adapterStatus, 'not_implemented');
    assert.equal(r.pct, null);
});

// Test "groq adapter devuelve not_implemented" eliminado en #3353 (Groq
// descontinuado). El módulo .pipeline/lib/quota-adapters/groq.js fue removido.

test('cerebras adapter devuelve not_implemented (#3220, runtime llega con #3198)', () => {
    const adapter = fresh('cerebras');
    const r = adapter({});
    assert.equal(r.provider, 'cerebras');
    assert.equal(r.adapterStatus, 'not_implemented');
    assert.equal(r.pct, null);
});

test('todos los stubs devuelven schemaVersion=2 y breakdown[] (forward-compat)', () => {
    // #3220 — sumamos gemini-google (rename) y cerebras.
    // #3353 — quitamos groq (provider descontinuado).
    for (const name of ['ollama', 'deterministic', 'gemini-google', 'cerebras']) {
        const adapter = fresh(name);
        const r = adapter({});
        assert.equal(r.schemaVersion, 2, `${name}: schemaVersion`);
        assert.deepEqual(r.breakdown, [], `${name}: breakdown[]`);
    }
});
