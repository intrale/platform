'use strict';

// =============================================================================
// estado-productos-router.test.js — Integración del slug `estado-productos` con
// el router del dashboard (#4778 · CA-1.4).
//
// Blinda el contrato entre el router y la vista:
//   - El slug está registrado en VIEW_SLUGS con render(opts, ctx).
//   - El router inyecta state.products + state.productState en vivo.
//   - El `productId` del query (opts.productId) se mapea a `activeProductId` de la
//     vista → el switch CAMBIA el estado mostrado (card activa + detalle scopeado)
//     sin mezclar datos entre productos.
// =============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');

const routes = require('../../../lib/dashboard-routes.js');

const PRODUCTS = [
    { projectId: 'intrale-platform', name: 'Intrale Platform', status: 'active', role: 'primary' },
    { projectId: 'acme-store', name: 'ACME Store', status: 'active', role: 'secondary' },
];
const PRODUCT_STATE = {
    'intrale-platform': { state: 'active', phase: 'operando', metrics: { activos: 2, pendientes: 4, bloqueados: 1, procesados: 10 } },
    'acme-store': { state: 'active', phase: 'operando', metrics: { activos: 7, pendientes: 0, bloqueados: 0, procesados: 3 } },
};
const ctx = { getState: () => ({ products: PRODUCTS, productState: PRODUCT_STATE }) };
const ACTIVE = '<article class="ep-card ep-card-active"';

test('el slug estado-productos está registrado con render(opts, ctx)', () => {
    assert.ok(Object.prototype.hasOwnProperty.call(routes.VIEW_SLUGS, 'estado-productos'));
    assert.equal(typeof routes.VIEW_SLUGS['estado-productos'].render, 'function');
});

test('CA-1.4: el router mapea productId→activeProductId y el switch cambia el estado mostrado', () => {
    const render = routes.VIEW_SLUGS['estado-productos'].render;
    const noPid = render({ currentView: 'estado-productos' }, ctx);
    const pidA = render({ currentView: 'estado-productos', productId: 'intrale-platform' }, ctx);
    const pidB = render({ currentView: 'estado-productos', productId: 'acme-store' }, ctx);

    // Sin producto activo: ninguna card resaltada ni detalle scopeado.
    assert.ok(!noPid.includes(ACTIVE));
    assert.ok(!noPid.includes('Operando sobre'));

    // Con producto activo: card resaltada + detalle scopeado del producto elegido.
    assert.ok(pidA.includes(ACTIVE));
    assert.ok(pidA.includes('Operando sobre'));
    assert.ok(pidA.includes('Intrale Platform'));

    // Cambiar el producto activo cambia el estado mostrado (distinto HTML).
    assert.notEqual(pidA, pidB);
    assert.ok(pidB.includes('ACME Store'));
});

test('el router inyecta ambos productos del state (grid multi-producto)', () => {
    const html = routes.VIEW_SLUGS['estado-productos'].render({ currentView: 'estado-productos' }, ctx);
    const cards = html.match(/<article class="ep-card/g) || [];
    assert.equal(cards.length, 2);
    assert.ok(html.includes('intrale-platform'));
    assert.ok(html.includes('acme-store'));
});

test('degrada sin romper si el state no trae productos (state vacío)', () => {
    const emptyCtx = { getState: () => ({}) };
    const html = routes.VIEW_SLUGS['estado-productos'].render({ currentView: 'estado-productos' }, emptyCtx);
    // Retro-compat: una card de producto único (Intrale), sin excepción.
    const cards = html.match(/<article class="ep-card/g) || [];
    assert.equal(cards.length, 1);
});
