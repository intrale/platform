// =============================================================================
// product-registry.test.js — Binding server-side productId→operadores (#4780).
// Cubre SR-1 (authz por from.id), SR-5 (fail-closed indistinguible) y SR-6
// (default sin wildcard).
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    createProductRegistry,
    extractRegistryConfig,
    normalizeProductId,
    DEFAULT_PRODUCT_ID,
} = require('../product-registry');

const OP_A = '111';
const OP_B = '222';

function reg() {
    return createProductRegistry({
        config: {
            default_product: 'Intrale',
            products: {
                Intrale: { name: 'Intrale', operators: [OP_A] },
                'Comercios-AR': { name: 'Comercios-AR', operators: [OP_A, OP_B] },
                'Vacio-Prod': { name: 'Vacio-Prod', operators: [] },
            },
        },
    });
}

test('isAuthorized: from.id en el set del producto → true', () => {
    assert.equal(reg().isAuthorized(OP_A, 'Intrale'), true);
    assert.equal(reg().isAuthorized(OP_B, 'Comercios-AR'), true);
});

test('isAuthorized: from.id fuera del set → false (SR-1)', () => {
    assert.equal(reg().isAuthorized(OP_B, 'Intrale'), false);
});

test('isAuthorized fail-closed indistinguible (SR-5): producto inexistente y no-autorizado ambos false', () => {
    const r = reg();
    assert.equal(r.isAuthorized(OP_A, 'No-Existe'), false);      // no existe
    assert.equal(r.isAuthorized(OP_B, 'Intrale'), false);        // existe, no autorizado
    assert.equal(r.isAuthorized(OP_A, 'Vacio-Prod'), false);     // existe, set vacío
});

test('isAuthorized fail-closed: fromId nulo/vacío o productId inválido → false', () => {
    const r = reg();
    assert.equal(r.isAuthorized(null, 'Intrale'), false);
    assert.equal(r.isAuthorized('', 'Intrale'), false);
    assert.equal(r.isAuthorized(OP_A, '../etc/passwd'), false);  // slug inválido
    assert.equal(r.isAuthorized(OP_A, null), false);
});

test('resolveProduct: sin requested → default (SR-6), no wildcard', () => {
    const r = reg();
    assert.equal(r.resolveProduct(null), 'Intrale');
    assert.equal(r.resolveProduct(''), 'Intrale');
    assert.equal(r.resolveProduct(undefined), 'Intrale');
});

test('resolveProduct: id inválido → null (fail-closed)', () => {
    assert.equal(reg().resolveProduct('has spaces'), null);
    assert.equal(reg().resolveProduct('a/b'), null);
});

test('productName: sólo tras authz; producto inexistente → null (no fuga)', () => {
    const r = reg();
    assert.equal(r.productName('Comercios-AR'), 'Comercios-AR');
    assert.equal(r.productName('No-Existe'), null);
});

test('listProductsFor: sólo productos donde el operador está autorizado', () => {
    const r = reg();
    const a = r.listProductsFor(OP_A).map((p) => p.productId).sort();
    assert.deepEqual(a, ['Comercios-AR', 'Intrale']);
    const b = r.listProductsFor(OP_B).map((p) => p.productId);
    assert.deepEqual(b, ['Comercios-AR']);
});

test('compat: sin products declarados, sintetiza default con defaultOperators', () => {
    const r = createProductRegistry({
        config: { default_product: 'Intrale', products: {} },
        defaultOperators: [OP_A],
    });
    assert.equal(r.isAuthorized(OP_A, 'Intrale'), true);
    assert.equal(r.isAuthorized(OP_B, 'Intrale'), false);
    assert.equal(r._size, 1);
});

test('normalizeProductId: slug conservador', () => {
    assert.equal(normalizeProductId('Comercios-AR'), 'Comercios-AR');
    assert.equal(normalizeProductId('  x.y_z  '), 'x.y_z');
    assert.equal(normalizeProductId('a/b'), null);
    assert.equal(normalizeProductId(''), null);
    assert.equal(normalizeProductId(123), null);
});

test('extractRegistryConfig: extrae commander_products o {}', () => {
    assert.deepEqual(extractRegistryConfig({ commander_products: { default_product: 'X' } }), { default_product: 'X' });
    assert.deepEqual(extractRegistryConfig({}), {});
    assert.deepEqual(extractRegistryConfig(null), {});
});

test('DEFAULT_PRODUCT_ID es Intrale', () => {
    assert.equal(DEFAULT_PRODUCT_ID, 'Intrale');
});
