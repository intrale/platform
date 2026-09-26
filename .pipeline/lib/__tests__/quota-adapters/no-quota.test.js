// Copyright (c) 2026 Leonel Larreta
// SPDX-License-Identifier: LicenseRef-Proprietary

// =============================================================================
// Tests quota-adapters/{deterministic,antigravity}.js
// — stubs (#3092 + #3220 + #3353 + #6563)
//
// Estos adapters son stubs simples: deterministic devuelve `no_quota`
// (no consume cuota); antigravity devuelve `not_implemented` (cálculo de
// cuota real llega con runtime fallbacks[] — #3198). Groq fue descontinuado
// en #3353; ollama y cerebras se retiraron del plantel en #6563.
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

test('deterministic adapter devuelve no_quota (skill sin LLM)', () => {
    const adapter = fresh('deterministic');
    const r = adapter({});
    assert.equal(r.provider, 'deterministic');
    assert.equal(r.adapterStatus, 'no_quota');
    assert.equal(r.status, 'no_quota');
    assert.equal(r.pct, null);
    assert.equal(r.session.status, 'no_quota');
});

test('antigravity adapter devuelve not_implemented (post-M2)', () => {
    // #3220 — rename ex-`gemini` → `antigravity`.
    const adapter = fresh('antigravity');
    const r = adapter({});
    assert.equal(r.provider, 'antigravity');
    assert.equal(r.adapterStatus, 'not_implemented');
    assert.equal(r.pct, null);
});

// Test "groq adapter devuelve not_implemented" eliminado en #3353 (Groq
// descontinuado). El módulo .pipeline/lib/quota-adapters/groq.js fue removido.
// #6563 — casos de ollama y cerebras retirados con los providers (sus
// módulos quota-adapters/{ollama,cerebras}.js ya no existen).

test('todos los stubs devuelven schemaVersion=2 y breakdown[] (forward-compat)', () => {
    // #3220 — sumamos antigravity (rename).
    // #3353 — quitamos groq (provider descontinuado).
    // #6563 — quitamos ollama y cerebras (retirados del plantel).
    for (const name of ['deterministic', 'antigravity']) {
        const adapter = fresh(name);
        const r = adapter({});
        assert.equal(r.schemaVersion, 2, `${name}: schemaVersion`);
        assert.deepEqual(r.breakdown, [], `${name}: breakdown[]`);
    }
});
