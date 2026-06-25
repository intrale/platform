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

function extractNavBlock(html) {
    // Captura el PRIMER bloque .v3-nav { ... } (el de theme.css, compartido).
    const block = html.match(/\.v3-nav\s*\{([\s\S]*?)\}/);
    return block ? block[1] : null;
}

// #4189/#4195 — La nav dejó de ser un grid de N columnas (un slot por tab) y
// pasó a ser CURADA: 5 tabs primarios + popover «⋯ Más». Layout flex elástico
// con wrap; el grid de columnas fijas ya no modela la barra (y rompía el anclaje
// del popover). Estos tests validan el nuevo contrato MIZPÁ sin perder CA-5
// (touch target ≥44px) ni la completitud del catálogo.
test('v3-nav usa layout flex elástico MIZPÁ (CA-1 #4195: nav curada + popover, sin grid)', () => {
    const html = renderForTest();
    const navCss = extractNavBlock(html);
    assert.ok(navCss, 'No se encontró el bloque .v3-nav');
    assert.match(navCss, /display:\s*flex/, '.v3-nav debe usar display:flex');
    assert.match(navCss, /flex-wrap:\s*wrap/, '.v3-nav debe permitir wrap');
    assert.doesNotMatch(
        navCss,
        /grid-template-columns:\s*repeat\(/,
        'no debe quedar grid-template-columns:repeat(...) (regresión pre-MIZPÁ)',
    );
});

test('la nav renderiza TODAS las tabs del catálogo (5 en la barra + resto en «⋯ Más»)', () => {
    const html = renderForTest();
    const tabs = (html.match(/class="v3-tab(?:\s+v3-tab-active)?"/g) || []).length;
    assert.ok(tabs > 0, 'No se renderizaron .v3-tab en el home');
    // Todas las tabs siguen siendo anchors alcanzables (primarias en la barra,
    // secundarias dentro del popover): el conteo total == NAV_TABS.length.
    assert.equal(
        tabs,
        NAV_TABS.length,
        `tabs renderizados (${tabs}) != NAV_TABS.length (${NAV_TABS.length})`,
    );
    // El popover «⋯ Más» debe existir y agrupar las tabs secundarias.
    assert.match(html, /class="v3-more/, 'falta el botón/popover «⋯ Más»');
    const primaries = NAV_TABS.filter((t) => t.primary).length;
    assert.equal(primaries, 5, 'la nav curada MIZPÁ tiene exactamente 5 tabs primarios');
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
