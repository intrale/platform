'use strict';

// Test de regresión para #3358 — barra de áreas en 1 sola fila.
//
// Bloquea regresiones del CA-1 (todas las pills en 1 fila a 1080px) y CA-2
// (cantidad de columnas DERIVADA de AREAS.length, no literal). Si alguien
// vuelve a hardcodear `repeat(9, 1fr)` o `repeat(11, 1fr)` o reintroduce el
// minmax(96px, 1fr) que ya no escala, este test rompe.
//
// Historia del patrón:
//   #3045 (9 → 10), #3239 (10 → 11), #3358 (paso a repeat(${AREAS.length},
//   minmax(0, 1fr))). Ver comentario adyacente al grid en home.js.

const test = require('node:test');
const assert = require('node:assert/strict');

const { renderHomeHTML } = require('../views/dashboard/home');

function renderForTest() {
    return renderHomeHTML({ quotaState: { state: 'green', percent: 50 } });
}

function extractAreasBarGridColumns(html) {
    // Captura el bloque .areas-bar { ... } y extrae grid-template-columns.
    const block = html.match(/\.areas-bar[^{]*\{([^}]*)\}/);
    if (!block) return null;
    const gtc = block[1].match(/grid-template-columns:\s*([^;]+);/);
    return gtc ? gtc[1].trim() : null;
}

test('areas-bar usa grid de N columnas iguales (no auto-fit con minmax fijo)', () => {
    const html = renderForTest();
    const gtc = extractAreasBarGridColumns(html);
    assert.ok(gtc, 'No se encontró grid-template-columns en .areas-bar');
    // Tiene que ser repeat(<N>, minmax(0, 1fr)) — un literal fijo o auto-fit
    // con minmax > 0 vuelve a romper el wrap a 2 filas (regresión #3358).
    assert.match(
        gtc,
        /^repeat\(\d+,\s*minmax\(0,\s*1fr\)\)$/,
        `grid-template-columns inesperado: "${gtc}"`,
    );
});

test('cantidad de columnas del grid coincide con la cantidad de .area-pill renderizadas (derivado de AREAS.length)', () => {
    const html = renderForTest();
    const gtc = extractAreasBarGridColumns(html);
    const cols = Number(gtc && gtc.match(/^repeat\((\d+),/)[1]);
    const pills = (html.match(/class="area-pill"/g) || []).length;
    assert.ok(pills > 0, 'No se renderizaron .area-pill en el home');
    assert.equal(
        cols,
        pills,
        `columnas (${cols}) != pills (${pills}); el grid debe derivar de AREAS.length`,
    );
});

test('cada .area-pill conserva su badge, icon y label (CA-4 sin regresión visual)', () => {
    const html = renderForTest();
    assert.match(html, /class="area-pill-badge area-pill-badge-zero" id="badge-/);
    assert.match(html, /class="area-pill-icon"/);
    assert.match(html, /class="area-pill-name"/);
});
