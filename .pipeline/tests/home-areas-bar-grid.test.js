'use strict';

// Test de regresión histórica para CA-1/CA-2 del #3358 (barra de áreas en
// 1 sola fila a 1080px). Desde #3726 la antigua `.areas-bar` con
// `.area-pill` fue REEMPLAZADA por la nav bar V3 unificada
// (`<nav class="v3-nav"><a class="v3-tab">…</a></nav>`) que vive en
// `.pipeline/views/dashboard/nav-tabs.js` y se inyecta tanto en home
// como en cada satélite.
//
// Bloquea regresiones de:
//   * CA-1 — todas las tabs deben caber en una sola fila a 1080px.
//   * CA-2 — la cantidad de columnas DERIVA del array de tabs (NAV_TABS.length).
//   * CA-5 — touch target ≥44×44px (#3726).
//
// Historia del patrón:
//   * #3045 (9 → 10), #3239 (10 → 11): `.areas-bar` con `repeat(N, 1fr)`
//     hardcoded; cada vez que sumamos una "area pill" había que actualizar
//     el literal a mano.
//   * #3358: pasó a `repeat(${AREAS.length}, minmax(0, 1fr))` para que las
//     columnas se derivaran del array AREAS — el patrón histórico 9→10→11
//     dejó de romper la fila por un literal estático.
//   * #3726: AREAS y `.areas-bar` quedaron retirados. La nav nueva
//     `.v3-nav` (12 tabs fijos por decisión del architect) usa
//     `repeat(12, minmax(44px, 1fr))` — el 12 sigue siendo derivado
//     conceptualmente de `NAV_TABS.length`, y validamos ambos en conjunto
//     para que sumar/sacar tabs requiera tocar las dos piezas.

const test = require('node:test');
const assert = require('node:assert/strict');

const { renderHomeHTML } = require('../views/dashboard/home');
const { NAV_TABS } = require('../views/dashboard/nav-tabs');

function renderForTest() {
    return renderHomeHTML({ quotaState: { state: 'green', percent: 50 } });
}

function extractNavGridColumns(html) {
    // Captura el bloque .v3-nav { ... } y extrae grid-template-columns.
    // Tolerante a whitespace/newlines dentro del bloque (la CSS de
    // theme.css trae cada propiedad en su propia línea).
    const block = html.match(/\.v3-nav\s*\{([\s\S]*?)\}/);
    if (!block) return null;
    const gtc = block[1].match(/grid-template-columns:\s*([^;]+);/);
    return gtc ? gtc[1].trim() : null;
}

test('v3-nav usa grid de N columnas iguales (no auto-fit con minmax fijo que rebote a 2 filas)', () => {
    const html = renderForTest();
    const gtc = extractNavGridColumns(html);
    assert.ok(gtc, 'No se encontró grid-template-columns en .v3-nav');
    // Tiene que ser repeat(<N>, minmax(<min>px, 1fr)) — el `1fr` garantiza
    // distribución equitativa del ancho restante. Un literal sin `1fr`
    // (ej: repeat(12, 80px)) o auto-fit vuelven a romper el wrap a 2 filas
    // cuando cambia el ancho del kiosk (regresión histórica de #3358).
    assert.match(
        gtc,
        /^repeat\(\d+,\s*minmax\(\d+px,\s*1fr\)\)$/,
        `grid-template-columns inesperado: "${gtc}"`,
    );
});

test('cantidad de columnas del grid coincide con NAV_TABS.length (derivado del catálogo)', () => {
    const html = renderForTest();
    const gtc = extractNavGridColumns(html);
    const cols = Number(gtc && gtc.match(/^repeat\((\d+),/)[1]);
    const tabs = (html.match(/class="v3-tab(?:\s+v3-tab-active)?"/g) || []).length;
    assert.ok(tabs > 0, 'No se renderizaron .v3-tab en el home');
    assert.equal(
        tabs,
        NAV_TABS.length,
        `tabs renderizados (${tabs}) != NAV_TABS.length (${NAV_TABS.length})`,
    );
    assert.equal(
        cols,
        NAV_TABS.length,
        `columnas (${cols}) != NAV_TABS.length (${NAV_TABS.length}); el grid debe derivar del catálogo`,
    );
});

test('cada .v3-tab conserva su badge (cuando aplica), icon y label (CA-4 sin regresión visual)', () => {
    const html = renderForTest();
    // El badge histórico (.area-pill-badge con id=badge-<area>) sigue vivo
    // como hijo del .v3-tab para que los tickers existentes
    // (tickMultiProvider, hidratación de counts) no se rompan. Ver
    // SLUG_TO_BADGE_AREA + badgeForSlug en home.js (#3726 CA-10).
    assert.match(html, /class="area-pill-badge area-pill-badge-zero" id="badge-/);
    // Iconografía: <svg class="v3-tab-icon"><use href="#ic-…"/></svg>.
    assert.match(html, /class="v3-tab-icon"/);
    // Labels: <span class="v3-tab-label">…</span>.
    assert.match(html, /class="v3-tab-label"/);
});
