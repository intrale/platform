'use strict';

// =============================================================================
// esperando-firma-product.test.js — GATE 2 product-aware (#4778 · CA-2.1 / CA-2.2).
//
// Cobertura:
//   - CA-2.1 : bandeja filtrada por productId (un firmante de A no ve ítems de B).
//   - CA-5.1 : sin productId ⇒ se muestran todos (retro-compat, sin regresión).
//   - CA-2.2 : la firma se ata al productId (3er arg del handler + data-product).
//   - A03/A08: productId inseguro NO se propaga (fail-closed).
// =============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const view = require('..' + path.sep + 'esperando-firma.js');
const { renderEsperandoFirmaSsr, productIdOf, safeProductId, DEFAULT_PRODUCT_ID } = view;

function fixture() {
    return {
        esperandoFirma: [
            { issue: 100, origen: 'waiting-operator-acc', age_hours: 2, productId: 'acme-store' },
            { issue: 200, origen: 'waiting-operator-acc', age_hours: 3, productId: 'globex' },
            { issue: 300, origen: 'waiting-operator-def', age_hours: 1 }, // sin productId ⇒ Intrale
        ],
    };
}

test('productIdOf: id seguro se respeta; ausente/inseguro cae a Intrale', () => {
    assert.equal(productIdOf({ productId: 'acme-store' }), 'acme-store');
    assert.equal(productIdOf({}), DEFAULT_PRODUCT_ID);
    assert.equal(productIdOf({ productId: '../evil' }), DEFAULT_PRODUCT_ID);
    assert.equal(safeProductId('../evil'), null);
});

test('CA-2.1: con productId, la bandeja SOLO muestra ítems de ese producto', () => {
    const html = renderEsperandoFirmaSsr(fixture(), { productId: 'acme-store' });
    assert.ok(html.includes('#100'), 'debe ver el ítem de acme-store');
    assert.ok(!html.includes('#200'), 'no debe ver el ítem de globex');
    assert.ok(!html.includes('#300'), 'no debe ver el ítem legacy (Intrale)');
});

test('CA-2.1: un firmante de otro producto (globex) no ve los ítems de acme', () => {
    const html = renderEsperandoFirmaSsr(fixture(), { productId: 'globex' });
    assert.ok(html.includes('#200'));
    assert.ok(!html.includes('#100'));
    assert.ok(!html.includes('#300'));
});

test('CA-5.1: producto único (intrale) ve los ítems legacy sin productId', () => {
    const html = renderEsperandoFirmaSsr(fixture(), { productId: 'intrale' });
    assert.ok(html.includes('#300'), 'los ítems sin productId cuentan como Intrale');
    assert.ok(!html.includes('#100'));
    assert.ok(!html.includes('#200'));
});

test('CA-5.1: sin productId (default) se muestran TODOS (retro-compat)', () => {
    const html = renderEsperandoFirmaSsr(fixture());
    assert.ok(html.includes('#100') && html.includes('#200') && html.includes('#300'));
});

test('CA-2.2: la firma se ata al productId (3er arg del handler + data-product)', () => {
    const html = renderEsperandoFirmaSsr(fixture(), { productId: 'acme-store' });
    assert.ok(html.includes("gateSignatureDecide(100, 'aprobar', 'acme-store')"));
    assert.ok(html.includes("gateSignatureDecide(100, 'rechazar', 'acme-store')"));
    assert.ok(html.includes('data-product="acme-store"'));
});

test('CA-2.2: ítem sin productId conserva el handler legacy (2 args) — retro-compat', () => {
    const html = renderEsperandoFirmaSsr({ esperandoFirma: [{ issue: 300, origen: 'waiting-operator-def', age_hours: 1 }] });
    assert.ok(html.includes("gateSignatureDecide(300, 'aprobar')"));
    assert.ok(!html.includes("gateSignatureDecide(300, 'aprobar', "));
});

test('A03/A08: un productId inseguro en el ítem no se propaga al handler ni al DOM', () => {
    const html = renderEsperandoFirmaSsr({ esperandoFirma: [{ issue: 400, origen: 'gate3', age_hours: 1, productId: "a'); alert(1);//" }] });
    // El ítem se muestra (cae a Intrale) pero SIN 3er arg inyectado.
    assert.ok(html.includes("gateSignatureDecide(400, 'aprobar')"));
    assert.ok(!html.includes('alert(1)'));
    assert.ok(!html.includes('data-product='));
});

test('el badge del panel cuenta sólo los ítems del producto filtrado', () => {
    const html = renderEsperandoFirmaSsr(fixture(), { productId: 'acme-store' });
    // Un solo ítem para acme-store.
    assert.ok(/ef-badge[^>]*>1</.test(html) || html.includes('>1</span>'));
});
