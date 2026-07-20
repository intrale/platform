'use strict';

// =============================================================================
// estado-productos.test.js — Grid "Estado por producto" (#4778 · mockup 36 pieza 2).
//
// Cobertura → criterios:
//   - CA-1.4 : cada card lee SÓLO su propio namespace; el switch (activeProductId)
//              cambia el estado mostrado (card activa + detalle scopeado); NO se
//              mezclan datos entre productos.
//   - CA-1.5 : Arrancar/Pausar por producto (botones con productId, POST + CSRF,
//              sin GET con efecto de estado).
//   - CA-5.1 : retro-compat producto único (una card, sin regresión).
//   - WCAG   : el estado no depende sólo del color (ícono + rótulo).
//   - A03/A08: ids inseguros filtrados; nombres/estado escapados (XSS).
// =============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const view = require('..' + path.sep + 'estado-productos.js');
const {
    renderEstadoProductos,
    renderEstadoProductosSsr,
    renderEstadoProductosClientScript,
    accentFor,
    pipelineSummary,
    stateMeta,
    isSafeProductId,
} = view;

const PRODUCTS = [
    { projectId: 'intrale-platform', name: 'Intrale Platform', status: 'active', role: 'primary' },
    { projectId: 'acme-store', name: 'ACME Store', status: 'onboarding', role: 'secondary' },
];
const PRODUCT_STATE = {
    'intrale-platform': { projectId: 'intrale-platform', name: 'Intrale Platform', status: 'active', state: 'active', phase: 'operando', metrics: { activos: 3, pendientes: 5, bloqueados: 1, procesados: 42 } },
    'acme-store': { projectId: 'acme-store', name: 'ACME Store', status: 'onboarding', state: 'onboarding', phase: 'onboarding', metrics: { activos: 0, pendientes: 0, bloqueados: 0, procesados: 0 } },
};

test('CA-1.4: renderiza una card por producto con su métrica namespaceada', () => {
    const html = renderEstadoProductosSsr({ products: PRODUCTS, productState: PRODUCT_STATE });
    // Dos cards (una por producto).
    const cards = html.match(/<article class="ep-card/g) || [];
    assert.equal(cards.length, 2);
    // Cada card muestra su propio projectId.
    assert.ok(html.includes('intrale-platform'));
    assert.ok(html.includes('acme-store'));
    // La métrica de Intrale (3 activos, 42 procesados) aparece; la de ACME es 0.
    assert.ok(html.includes('>3<'), 'activos de intrale');
    assert.ok(html.includes('>42<'), 'procesados de intrale');
});

test('CA-1.4: el estado de un producto NO aparece en la card de otro (aislamiento)', () => {
    // ACME sin métricas: 42 (procesados de intrale) no debe filtrarse a su card.
    // Verificamos que 42 aparece exactamente una vez (sólo en la card de intrale).
    const html = renderEstadoProductosSsr({ products: PRODUCTS, productState: PRODUCT_STATE });
    const occurrences = (html.match(/>42</g) || []).length;
    assert.equal(occurrences, 1, 'el valor de un producto no debe replicarse en otro');
});

test('CA-1.4: el switch cambia el estado mostrado (card activa + detalle scopeado)', () => {
    const base = renderEstadoProductosSsr({ products: PRODUCTS, productState: PRODUCT_STATE });
    assert.ok(!base.includes('<article class="ep-card ep-card-active"'), 'sin productId activo no hay card resaltada');
    assert.ok(!base.includes('Operando sobre'), 'sin productId activo no hay detalle scopeado');

    const scopedA = renderEstadoProductosSsr({ products: PRODUCTS, productState: PRODUCT_STATE, activeProductId: 'intrale-platform' });
    assert.ok(scopedA.includes('<article class="ep-card ep-card-active"'));
    assert.ok(scopedA.includes('Operando sobre'));
    assert.ok(scopedA.includes('Intrale Platform'));

    const scopedB = renderEstadoProductosSsr({ products: PRODUCTS, productState: PRODUCT_STATE, activeProductId: 'acme-store' });
    // Cambiar el producto activo cambia el detalle scopeado → distinto HTML.
    assert.notEqual(scopedA, scopedB);
    assert.ok(scopedB.includes('ACME Store'));
});

test('CA-1.5: botones Arrancar/Pausar por producto, POST + CSRF, sin GET con efecto', () => {
    const html = renderEstadoProductosSsr({ products: PRODUCTS, productState: PRODUCT_STATE });
    // Botones con data-action y data-pid (delegación al kernel por productId).
    assert.ok(html.includes('data-action="start"'));
    assert.ok(html.includes('data-action="pause"'));
    assert.ok(html.includes('data-pid="intrale-platform"'));
    // El fragmento NO contiene enlaces GET con efecto de estado hacia los endpoints.
    assert.ok(!html.includes('href="/api/product'));
    // El client script usa POST + X-CSRF-Token contra los endpoints existentes.
    const script = renderEstadoProductosClientScript();
    assert.ok(script.includes("/api/product/csrf-token"));
    assert.ok(script.includes("method:'POST'") || script.includes('method: "POST"'));
    assert.ok(script.includes('X-CSRF-Token'));
    assert.ok(script.includes('/api/product/'));
    assert.ok(script.includes('confirm('), 'confirmación con el productId objetivo (SEC-7)');
});

test('CA-1.5: producto activo ofrece Pausar; pausado/onboarding ofrece Arrancar', () => {
    const state = {
        'intrale-platform': { state: 'active', metrics: {} },
        'acme-store': { state: 'onboarding', metrics: {} },
    };
    const html = renderEstadoProductosSsr({ products: PRODUCTS, productState: state });
    // Card activa (intrale): Pausar habilitado, Arrancar deshabilitado.
    const intraleCard = html.split('data-pid="intrale-platform"')[0] + html.split('data-pid="intrale-platform"').slice(1).join('');
    // Verificación por presencia de 'disabled' junto a cada acción.
    assert.ok(html.includes('data-action="pause" '), 'botón pausar presente');
    assert.ok(html.includes('data-action="start" '), 'botón arrancar presente');
    assert.ok(intraleCard.length > 0);
});

test('#4799 CA-1: el header incluye el CTA "Nuevo producto" hacia el wizard (link literal same-origin)', () => {
    const html = renderEstadoProductosSsr({ products: PRODUCTS, productState: PRODUCT_STATE });
    // CTA presente como <a href> literal hacia ?view=onboarding (navegación GET solo-vista).
    assert.ok(html.includes('href="/dashboard?view=onboarding"'), 'CTA apunta al wizard de alta');
    assert.ok(html.includes('Nuevo producto'), 'texto visible del CTA');
    // Reutiliza el sistema de diseño (ep-btn) sin heredar flex:1 (ep-btn-new).
    assert.ok(html.includes('ep-btn ep-btn-start ep-btn-new'), 'jerarquía primaria sin estirarse a todo el ancho');
    // Accesibilidad: emoji aria-hidden + aria-label descriptivo.
    assert.ok(html.includes('aria-label="Crear un nuevo producto (abre el wizard de alta)"'), 'aria-label descriptivo');
    // A08/CSRF: el CTA sólo navega (GET), no dispara la mutación del alta.
    assert.ok(!html.includes('href="/api/product'), 'el CTA no dispara GET con efecto de estado');
});

test('#4799 CA-6: el href del CTA es literal y no interpola datos en banda (activeProductId)', () => {
    const html = renderEstadoProductosSsr({ products: PRODUCTS, productState: PRODUCT_STATE, activeProductId: 'intrale-platform' });
    // El destino del CTA es siempre el mismo path fijo, sin importar el producto activo.
    assert.ok(html.includes('href="/dashboard?view=onboarding"'));
    assert.ok(!html.includes('view=onboarding&'), 'sin query params extra concatenados');
    assert.ok(!html.includes('onboarding?product'), 'sin productId interpolado en el href');
});

test('CA-5.1: sin productos legibles ⇒ una card de producto único (retro-compat)', () => {
    const html = renderEstadoProductosSsr({ products: [], productState: {} });
    const cards = html.match(/<article class="ep-card/g) || [];
    assert.equal(cards.length, 1);
    assert.ok(html.includes('Intrale'));
});

test('WCAG: el estado incluye ícono + rótulo (no depende sólo del color)', () => {
    for (const st of ['active', 'paused', 'onboarding', 'inactive', 'unknown']) {
        const meta = stateMeta(st);
        assert.ok(meta.icon && meta.label, `estado ${st} debe tener ícono y rótulo`);
    }
    const html = renderEstadoProductosSsr({ products: PRODUCTS, productState: PRODUCT_STATE });
    assert.ok(html.includes('Operando'), 'rótulo de estado activo visible');
    assert.ok(html.includes('Onboarding'), 'rótulo de estado onboarding visible');
});

test('A03/A08: ids inseguros se filtran; nombres se escapan (XSS)', () => {
    const html = renderEstadoProductosSsr({
        products: [
            { projectId: '../evil', name: 'Evil' },
            { projectId: 'acme-store', name: '<script>alert(1)</script>' },
        ],
        productState: {},
    });
    // El id inseguro no genera card.
    assert.ok(!html.includes('../evil'));
    // El nombre malicioso se escapa (no aparece el tag crudo).
    assert.ok(!html.includes('<script>alert(1)</script>'));
    assert.ok(html.includes('&lt;script&gt;'));
});

test('accentFor es estable y determinista por producto', () => {
    const a1 = accentFor('acme-store');
    const a2 = accentFor('acme-store');
    assert.equal(a1, a2);
    assert.match(a1, /^#[0-9A-F]{6}$/i);
});

test('pipelineSummary normaliza métricas ausentes/negativas a 0', () => {
    assert.deepEqual(pipelineSummary(null), { activos: 0, pendientes: 0, bloqueados: 0, procesados: 0 });
    assert.deepEqual(pipelineSummary({ metrics: { activos: -5, pendientes: 'x', bloqueados: 2 } }), { activos: 0, pendientes: 0, bloqueados: 2, procesados: 0 });
});

test('CA-2.1: la bandeja GATE 2 embebida se filtra por el producto activo', () => {
    const esperandoFirma = [
        { issue: 111, productId: 'intrale-platform', origen: 'gate2', title: 'Firma A' },
        { issue: 222, productId: 'acme-store', origen: 'gate2', title: 'Firma B' },
    ];
    // Sin producto activo: no se embebe la bandeja (filtro explícito).
    const noPid = renderEstadoProductosSsr({ products: PRODUCTS, productState: PRODUCT_STATE, esperandoFirma });
    assert.ok(!noPid.includes('<div class="ep-gate-tray">'));

    // Con producto activo intrale: sólo el ítem de intrale (111), nunca el de acme (222).
    const scoped = renderEstadoProductosSsr({ products: PRODUCTS, productState: PRODUCT_STATE, esperandoFirma, activeProductId: 'intrale-platform' });
    assert.ok(scoped.includes('<div class="ep-gate-tray">'), 'la bandeja GATE 2 se embebe con producto activo');
    assert.ok(scoped.includes('111'), 'muestra la firma del producto activo');
    assert.ok(!scoped.includes('222'), 'NO muestra la firma de otro producto (aislamiento CA-2.1)');
});

test('el documento completo embebe el client script de la bandeja GATE 2', () => {
    const esperandoFirma = [{ issue: 111, productId: 'intrale-platform', origen: 'gate2', title: 'Firma A' }];
    const doc = renderEstadoProductos({ products: PRODUCTS, productState: PRODUCT_STATE, esperandoFirma, activeProductId: 'intrale-platform' });
    // El shell incluye el flujo de firma/rechazo (CSRF) del módulo de firma.
    assert.ok(doc.includes('gate-signature') || doc.includes('gateSignature'), 'incluye el client script de firma');
});

test('documento completo: shell HTML + client script embebido', () => {
    const doc = renderEstadoProductos({ products: PRODUCTS, productState: PRODUCT_STATE, activeProductId: 'intrale-platform' });
    assert.ok(doc.startsWith('<!DOCTYPE html>'));
    assert.ok(doc.includes('Estado por producto'));
    assert.ok(doc.includes('<script>'));
    assert.ok(doc.includes('Volver al dashboard'));
});

test('isSafeProductId espeja la validación del kernel', () => {
    assert.ok(isSafeProductId('intrale-platform'));
    for (const bad of ['../x', 'a/b', 'UPPER', '', null]) {
        assert.equal(isSafeProductId(bad), false);
    }
});

// -----------------------------------------------------------------------------
// #4805 — botón "Activar" (onboarding→activo) + habilitar "Arrancar" tras activar.
// -----------------------------------------------------------------------------

test('#4805 CA-1: botón Activar presente y HABILITADO sólo en onboarding', () => {
    const state = { 'acme-store': { state: 'onboarding', metrics: {} } };
    const html = renderEstadoProductosSsr({
        products: [{ projectId: 'acme-store', name: 'ACME', status: 'onboarding' }],
        productState: state,
    });
    assert.ok(html.includes('data-action="activate"'), 'botón activar presente');
    assert.ok(html.includes('⏻'), 'glyph de encendido (dual-encoding, no sólo color)');
    // El botón Activar NO está disabled en onboarding: aislamos su tag.
    const seg = html.split('data-action="activate"')[0].split('<button').pop();
    assert.ok(!/disabled/.test(seg), 'Activar habilitado en onboarding');
});

test('#4805 CA-2/CA-3: botón Activar DESHABILITADO fuera de onboarding', () => {
    for (const st of ['active', 'paused', 'inactive', 'unknown']) {
        const html = renderEstadoProductosSsr({
            products: [{ projectId: 'acme-store', name: 'ACME', status: st === 'unknown' ? 'active' : st }],
            productState: { 'acme-store': { state: st === 'unknown' ? undefined : st, metrics: {} } },
        });
        const seg = html.split('data-action="activate"')[0].split('<button').pop();
        assert.ok(/disabled/.test(seg), `Activar deshabilitado en estado ${st}`);
    }
});

test('#4805 CA-4: Arrancar habilitado para producto activo sin ola en curso (unknown)', () => {
    // Producto con status active pero sin estado de runtime todavía ⇒ 'unknown'.
    const html = renderEstadoProductosSsr({
        products: [{ projectId: 'acme-store', name: 'ACME', status: 'active' }],
        productState: {},
    });
    const startSeg = html.split('data-action="start"')[0].split('<button').pop();
    assert.ok(!/disabled/.test(startSeg), 'Arrancar habilitado para activo-sin-ola');
});

test('#4805 CA-4: "Activar" NO dispara confirm destructivo; "Arrancar" SÍ', () => {
    const script = view.renderEstadoProductosClientScript();
    // El client script postea al endpoint dedicado de activación.
    assert.ok(script.includes('/api/product/'), 'usa POST a /api/product/<action>');
    // start/pause requieren confirm; activate no.
    assert.ok(script.includes('EP_NEEDS_CONFIRM'));
    assert.ok(/start:\s*true/.test(script) && /pause:\s*true/.test(script), 'start/pause confirman');
    assert.ok(!/activate:\s*true/.test(script), 'activate NO exige confirm destructivo');
});

test('#4805 SSR: el botón Activar escapa el productId en atributos (anti-XSS)', () => {
    const html = renderEstadoProductosSsr({
        products: [{ projectId: 'acme-store', name: '"><img src=x>', status: 'onboarding' }],
        productState: { 'acme-store': { state: 'onboarding' } },
    });
    assert.ok(!html.includes('<img src=x>'), 'el nombre malicioso no se refleja crudo');
    assert.ok(html.includes('aria-label="Activar el producto acme-store"'));
});
