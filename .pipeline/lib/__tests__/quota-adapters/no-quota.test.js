// =============================================================================
// Tests quota-adapters/{ollama,deterministic,gemini}.js — stubs (#3092)
//
// Estos adapters son stubs simples: ollama y deterministic devuelven
// `no_quota` (no consumen cuota), gemini devuelve `not_implemented`.
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

test('gemini adapter devuelve not_implemented (post-M2)', () => {
    const adapter = fresh('gemini');
    const r = adapter({});
    assert.equal(r.provider, 'gemini');
    assert.equal(r.adapterStatus, 'not_implemented');
    assert.equal(r.pct, null);
});

test('todos los stubs devuelven schemaVersion=2 y breakdown[] (forward-compat)', () => {
    for (const name of ['ollama', 'deterministic', 'gemini']) {
        const adapter = fresh(name);
        const r = adapter({});
        assert.equal(r.schemaVersion, 2, `${name}: schemaVersion`);
        assert.deepEqual(r.breakdown, [], `${name}: breakdown[]`);
    }
});
