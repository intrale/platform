'use strict';

// =============================================================================
// product-switcher.test.js — Selector de producto solo-vista (#4778).
//
// Cobertura → criterios:
//   - CA-1.3 / SEC-1 : el switch es solo vista (navegación GET), no concede permisos.
//   - CA-5.1 : ≤1 producto ⇒ badge estático (Intrale), sin regresión.
//   - A03/A08 : ids inseguros filtrados; nombres de producto escapados (XSS).
// =============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const view = require('..' + path.sep + 'product-switcher.js');
const { renderProductSwitcherSsr, normalizeProducts, isSafeProductId } = view;

test('isSafeProductId acepta ids válidos y rechaza path-traversal/mayúsculas', () => {
    assert.ok(isSafeProductId('acme-store'));
    assert.ok(isSafeProductId('intrale'));
    for (const bad of ['../evil', 'a/b', '..', 'UPPER', '', null, 'a b', 'x'.repeat(70)]) {
        assert.equal(isSafeProductId(bad), false, `${JSON.stringify(bad)} debería ser inseguro`);
    }
});

test('normalizeProducts filtra ids inseguros, deduplica y garantiza default', () => {
    const out = normalizeProducts([
        { projectId: 'acme-store', name: 'ACME' },
        { projectId: '../evil', name: 'Evil' },
        { projectId: 'acme-store', name: 'Dup' },
    ]);
    assert.equal(out.length, 1);
    assert.equal(out[0].projectId, 'acme-store');
    // Lista vacía ⇒ producto único Intrale.
    const def = normalizeProducts([]);
    assert.equal(def.length, 1);
    assert.equal(def[0].projectId, 'intrale');
});

test('CA-5.1: con 1 producto renderiza badge estático (sin selector)', () => {
    const html = renderProductSwitcherSsr({ products: [{ projectId: 'intrale', name: 'Intrale' }] });
    assert.ok(html.includes('mz-projsel-single'));
    assert.ok(html.includes('Intrale'));
    // Sin menú de opciones ni enlaces de cambio (los nombres de clase aparecen en el
    // <style>; se verifican tokens de markup que nunca están en el CSS).
    assert.ok(!html.includes('role="menu"'));
    assert.ok(!html.includes('<summary'));
    assert.ok(!html.includes('data-active='));
    assert.ok(!html.includes('?productId='));
});

test('CA-5.1: sin productos renderiza el default Intrale (retro-compat)', () => {
    const html = renderProductSwitcherSsr({});
    assert.ok(html.includes('mz-projsel-single'));
    assert.ok(html.includes('Intrale'));
});

test('CA-1.3/SEC-1: con varios productos el switch son enlaces GET (sin POST ni acciones mutantes)', () => {
    const html = renderProductSwitcherSsr({
        products: [{ projectId: 'intrale', name: 'Intrale' }, { projectId: 'acme-store', name: 'ACME' }],
        activeProductId: 'acme-store',
    });
    assert.ok(html.includes('mz-projsel-menu'));
    // Enlaces GET con ?productId= — navegación solo vista.
    assert.ok(html.includes('?productId=intrale'));
    assert.ok(html.includes('?productId=acme-store'));
    // El activo queda marcado (aria-checked).
    assert.ok(/aria-checked="true"[^>]*href="[^"]*productId=acme-store/.test(html) || html.includes('mz-projsel-opt-active'));
    // Nota "solo vista" y CERO superficie mutante.
    assert.ok(/solo vista/i.test(html));
    assert.ok(!/method\s*[:=]\s*['"]POST/i.test(html));
    assert.ok(!html.includes('fetch('));
    assert.ok(!html.includes('onclick='));
});

test('SEC-1: activeProductId inseguro/ inexistente cae al primer producto (fail-closed de vista)', () => {
    const html = renderProductSwitcherSsr({
        products: [{ projectId: 'intrale', name: 'Intrale' }, { projectId: 'acme-store', name: 'ACME' }],
        activeProductId: '../evil',
    });
    assert.ok(html.includes('data-active="intrale"'));
});

test('A03/A08: el nombre de producto se escapa (XSS)', () => {
    const html = renderProductSwitcherSsr({
        products: [{ projectId: 'intrale', name: 'Intrale' }, { projectId: 'acme-store', name: '<script>alert(1)</script>' }],
        activeProductId: 'intrale',
    });
    assert.ok(!html.includes('<script>alert(1)</script>'));
    assert.ok(html.includes('&lt;script&gt;'));
});
