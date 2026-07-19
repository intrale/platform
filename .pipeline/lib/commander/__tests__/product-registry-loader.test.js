// =============================================================================
// product-registry-loader.test.js — Loader config→registry (#4780).
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { loadProductRegistry } = require('../product-registry-loader');

test('loader: sin products declarados + defaultOperator → sintetiza Intrale retro-compat', () => {
    const reg = loadProductRegistry({
        config: { commander_products: { default_product: 'Intrale', products: {} } },
        defaultOperator: '555',
    });
    assert.equal(reg.isAuthorized('555', 'Intrale'), true);
    assert.equal(reg.isAuthorized('999', 'Intrale'), false);
    assert.equal(reg.resolveProduct(null), 'Intrale');
});

test('loader: products declarados en config se respetan', () => {
    const reg = loadProductRegistry({
        config: {
            commander_products: {
                default_product: 'Intrale',
                products: {
                    Intrale: { name: 'Intrale', operators: ['111'] },
                    'Comercios-AR': { name: 'Comercios-AR', operators: ['222'] },
                },
            },
        },
        defaultOperator: '555', // ignorado porque hay products declarados
    });
    assert.equal(reg.isAuthorized('111', 'Intrale'), true);
    assert.equal(reg.isAuthorized('222', 'Comercios-AR'), true);
    assert.equal(reg.isAuthorized('555', 'Intrale'), false); // no se hereda si hay products
});

test('loader: config ausente → registry vacío degradado (sin crash)', () => {
    const reg = loadProductRegistry({ config: {} });
    assert.equal(reg._size, 0);
    assert.equal(reg.isAuthorized('111', 'Intrale'), false); // fail-closed
});
