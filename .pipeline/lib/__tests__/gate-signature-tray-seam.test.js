'use strict';

// =============================================================================
// gate-signature-tray-seam.test.js — #6208 rev3 · LA COSTURA, no la hoja.
//
// El rebote rev2 se arregló en `esperando-firma.js` (la hoja) y el SEGUNDO
// consumidor del mismo componente —la bandeja GATE 2 embebida en
// `/dashboard?view=estado-productos`— quedó con el agujero entero:
//
//   (a) `gate-signature-inbox.rowFromPending` emite `productId: null` y la vista
//       lo mapeaba al literal legacy `'intrale'`, que NO está en el catálogo
//       real (`.pipeline/descriptors/intrale-platform.json` ⇒ `intrale-platform`),
//       así que el filtro por producto activo descartaba TODAS las filas
//       firmables, siempre: bandeja vacía aunque hubiera firmas esperando.
//   (b) `dashboard-routes` pasaba `state.esperandoFirma` pero NUNCA
//       `state.esperandoFirmaInbox`, así que el componente caía a
//       `renderEmptyStateSsr(null)` ⇒ vacío VERDE "Leí la lista entera y estaba
//       vacía · LISTA LEÍDA COMPLETA" INCLUSO con el depósito del kernel
//       ilegible (`degraded: true`), y la banda de índice incompleto tampoco se
//       reponía.
//
// Los tests de rev2 no lo agarraban porque llamaban a `renderEsperandoFirmaSsr`
// pasando `esperandoFirmaInbox` A MANO: ninguno recorría el camino que lo omite.
// Estos tests entran por `renderEstadoProductosView(ctx, opts)` — el mismo punto
// que usa el router — con un `ctx.getState()` que espeja el state vivo.
//
// node --test .pipeline/lib/__tests__/gate-signature-tray-seam.test.js
// =============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');

const { _internal } = require('../dashboard-routes');
const { renderEstadoProductosView } = _internal;

const inbox = require('../gate-signature-inbox.js');

// El catálogo REAL del repo: un único producto, `intrale-platform`. Es el dato
// que rompía el filtro (el literal legacy era 'intrale').
const CATALOGO = [{ projectId: 'intrale-platform', name: 'Intrale Platform', status: 'active', role: 'primary' }];
const ACTIVO = 'intrale-platform';

// Pendiente del depósito con la forma que emite el kernel (approval-channel).
function pendiente(over = {}) {
    return Object.assign({
        issue: 7777,
        gate: 'aceptacion',
        title: 'Firmar la aceptación de la bandeja GATE 2',
        question: '¿Aceptás el trabajo de #6208?',
        anchor: { type: 'commit', sha: 'a'.repeat(40) },
        evidence: [],
        options: [{ verdict: 'signed', label: 'Firmar' }, { verdict: 'rejected', label: 'Rechazar' }],
        created_at: new Date(1700000000000 - 45 * 60000).toISOString(),
        presentation_safe: true,
    }, over);
}

// Fila FIRMABLE tal cual la produce el read model (con `productId: null`).
function filaFirmable(over) {
    return inbox.rowFromPending(pendiente(over), null, 1700000000000);
}

function ctxCon(state) {
    return { getState: () => state };
}

function render(state, opts) {
    return renderEstadoProductosView(ctxCon(state), Object.assign({ productId: ACTIVO }, opts || {}));
}

// ---------------------------------------------------------------------------
// (a) La bandeja embebida muestra un pendiente REAL de firma.
// ---------------------------------------------------------------------------

test('#6208 rev3 · (a) con un pendiente REAL del depósito, la bandeja embebida LO MUESTRA', () => {
    const fila = filaFirmable();
    assert.equal(fila.productId, null, 'el read model no tipa el producto (precondición del bug)');

    const html = render({
        products: CATALOGO,
        productState: { 'intrale-platform': {} },
        esperandoFirma: [fila],
        esperandoFirmaInbox: { degraded: false, alert: null, corruptCount: 0, visibleCount: 1, firmables: 1, vacio: null, banda: null },
    });

    assert.ok(html.includes('ep-gate-tray'), 'la sección de la bandeja se renderiza');
    assert.ok(html.includes('#7777'), 'la fila firmable del depósito aparece en la bandeja');
    assert.ok(!html.includes('LISTA LEÍDA COMPLETA'), 'con una fila real NO se pinta el vacío celebratorio');
});

test('#6208 rev3 · (a) el producto efectivo de una fila sin tipar es el PRIMARIO del catálogo', () => {
    const ep = require('../../views/dashboard/estado-productos.js');
    assert.equal(ep.untypedProductId(CATALOGO, ACTIVO), 'intrale-platform');
    // Catálogo de un solo producto sin `role` → ese producto.
    assert.equal(ep.untypedProductId([{ projectId: 'acme-store' }], 'acme-store'), 'acme-store');
    // Multi-producto sin primario → el ACTIVO: la firma sin producto queda
    // VISIBLE en la bandeja que el operador está mirando (nunca se esconde).
    assert.equal(ep.untypedProductId([{ projectId: 'acme-store' }, { projectId: 'globex' }], 'globex'), 'globex');
    // Sin catálogo ni activo válido → null (la vista cae al default legacy).
    assert.equal(ep.untypedProductId([], '../evil'), null);
});

test('#6208 rev3 · (a) REGRESIÓN: con el literal legacy la fila desaparecía', () => {
    // Prueba la causa raíz: si el producto de los no tipados fuera 'intrale'
    // (el literal viejo), el filtro por 'intrale-platform' la descarta.
    const ef = require('../../views/dashboard/esperando-firma.js');
    const fila = filaFirmable();
    const conLegacy = ef.renderEsperandoFirmaSsr({ esperandoFirma: [fila] }, { productId: ACTIVO, untypedProductId: 'intrale' });
    assert.ok(!conLegacy.includes('#7777'), 'con el literal legacy la fila se pierde (el bug)');
    const conPrimario = ef.renderEsperandoFirmaSsr({ esperandoFirma: [fila] }, { productId: ACTIVO, untypedProductId: ACTIVO });
    assert.ok(conPrimario.includes('#7777'), 'con el primario real la fila se ve (el fix)');
});

// ---------------------------------------------------------------------------
// (b) `degraded: true` NO puede pintarse como "está todo firmado".
// ---------------------------------------------------------------------------

test('#6208 rev3 · (b) depósito ILEGIBLE + bandeja vacía ⇒ vacío ÁMBAR, nunca el verde', () => {
    const html = render({
        products: CATALOGO,
        productState: { 'intrale-platform': {} },
        esperandoFirma: [],
        esperandoFirmaInbox: {
            degraded: true,
            alert: 'No pude leer la lista de firmas pendientes. Retengo y aviso.',
            corruptCount: 2,
            visibleCount: 0,
            firmables: 0,
            vacio: {
                tono: 'warn',
                icono: '⚠',
                titulo: 'No pude leer la lista de firmas pendientes',
                lineas: ['Esto no quiere decir que esté todo firmado.', 'Freno lo que dependa de una firma y te aviso.'],
                chip: 'RETENIDO · REVISAR EL DEPÓSITO',
            },
            banda: null,
        },
    });

    assert.ok(html.includes('ep-gate-tray'), 'la bandeja se renderiza');
    assert.ok(!html.includes('LISTA LEÍDA COMPLETA'), 'NO puede afirmar que leyó la lista entera');
    assert.ok(!html.includes('Nada esperando tu firma'), 'NO puede afirmar que no hay nada pendiente');
    assert.ok(html.includes('ef-empty-warn'), 'el vacío es ámbar (fail-closed hacia la visibilidad)');
    assert.ok(html.includes('No pude leer la lista de firmas pendientes'));
    assert.ok(html.includes('Esto no quiere decir que esté todo firmado.'));
});

test('#6208 rev3 · (b) depósito ILEGIBLE + una fila real ⇒ la BANDA de índice incompleto se repone', () => {
    const html = render({
        products: CATALOGO,
        productState: { 'intrale-platform': {} },
        esperandoFirma: [filaFirmable()],
        esperandoFirmaInbox: {
            degraded: true,
            alert: 'Hay pedidos que no pude leer.',
            corruptCount: 1,
            visibleCount: 1,
            firmables: 1,
            vacio: null,
            banda: null, // el fallback de dashboard.js manda banda: null a propósito
        },
    });

    assert.ok(html.includes('#7777'), 'la fila sigue visible');
    assert.ok(/ef-banda/.test(html), 'la banda de índice incompleto se repone sobre la lista');
});

test('#6208 rev3 · (b) el estado limpio SÍ puede pintar el vacío verde', () => {
    const html = render({
        products: CATALOGO,
        productState: { 'intrale-platform': {} },
        esperandoFirma: [],
        esperandoFirmaInbox: {
            degraded: false, alert: null, corruptCount: 0, visibleCount: 0, firmables: 0,
            vacio: {
                tono: 'ok', icono: '✓', titulo: 'Nada esperando tu firma',
                lineas: ['Ningún gate está reteniendo un trabajo.', 'Leí la lista entera y estaba vacía.'],
                chip: 'LISTA LEÍDA COMPLETA',
            },
            banda: null,
        },
    });
    assert.ok(html.includes('LISTA LEÍDA COMPLETA'), 'sólo se gana habiendo leído la lista entera');
    assert.ok(html.includes('ef-empty-ok'));
});

// ---------------------------------------------------------------------------
// La costura propiamente dicha: el route propaga los metadatos del state vivo.
// ---------------------------------------------------------------------------

test('#6208 rev3 · el route propaga `esperandoFirmaInbox` desde el state vivo', () => {
    // Sin propagación, este mismo state pintaba el verde (era el bug (b)).
    const state = {
        products: CATALOGO,
        productState: { 'intrale-platform': {} },
        esperandoFirma: [],
        esperandoFirmaInbox: {
            degraded: true, alert: 'ilegible', corruptCount: 1, visibleCount: 0, firmables: 0,
            vacio: { tono: 'warn', icono: '⚠', titulo: 'No pude leer la lista de firmas pendientes', lineas: [], chip: 'RETENIDO' },
            banda: null,
        },
    };
    const html = render(state);
    assert.ok(html.includes('RETENIDO'), 'el chip del vacío ámbar llegó por la costura, no a mano');
});

test('#6208 rev3 · sin metadatos en el state (legacy) el render no se rompe', () => {
    const html = render({ products: CATALOGO, productState: {}, esperandoFirma: [] });
    assert.ok(html.includes('ep-gate-tray'), 'degrada al comportamiento anterior sin tirar');
});

test('#6208 rev3 · state vacío/ausente: la vista no tira 500', () => {
    const html = renderEstadoProductosView({ getState: () => { throw new Error('state roto'); } }, { productId: ACTIVO });
    assert.ok(typeof html === 'string' && html.length > 0);
    assert.ok(!html.includes('LISTA LEÍDA COMPLETA'), 'un error de state jamás se ve como "todo firmado"');
});
