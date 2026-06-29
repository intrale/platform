// =============================================================================
// Tests del marco común MIZPÁ aplicado a la pantalla COSTOS (#4239, sobre #4234).
//
// Verifican que `sat.renderCostos` componga, encima del contenido propio de
// COSTOS, los tres bloques superiores idénticos al resto de las pantallas:
//   ① Cabecera MIZPÁ      → marca (mz-logo) + selector de proyecto (mz-projsel)
//   ② Banner de ola común → markup canónico mz-* (mz-mission / mz-wavetag /
//                           bloque AVANCE mz-prog-bar), reusado del marco común
//   ③ Barra de subventanas → nav v3 (renderNavTabsSsr) que ya pone pageShell
// y que el contenido propio de COSTOS quede DEBAJO del marco (CA-4), sin que el
// shell caiga a su cabecera legacy (in-header-logo) en el markup del header.
//
// Runner: node --test .pipeline/views/dashboard/__tests__/costos-marco-mizpa.test.js
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const sat = require('../satellites');

const SENTINEL = '<div id="costos-redesign">CONTENIDO-PROPIO-COSTOS</div>';

function render() {
    return sat.renderCostos({ redesignHtml: SENTINEL });
}

function headerOf(html) {
    return html.slice(html.indexOf('<header'), html.indexOf('</header>') + 9);
}

test('renderCostos compone ① la cabecera de marca MIZPÁ (no la legacy)', () => {
    const html = render();
    const header = headerOf(html);
    assert.ok(header.includes('mz-logo'), 'el header usa la marca MIZPÁ (mz-logo)');
    assert.ok(header.includes('mz-projsel'), 'el header trae el selector de proyecto');
    assert.ok(!header.includes('in-header-logo'), 'el header NO usa la marca legacy');
});

test('renderCostos compone ② el banner de ola común con markup mz-* y AVANCE', () => {
    const html = render();
    assert.ok(html.includes('mz-mission'), 'incluye el banner de ola común');
    assert.ok(html.includes('mz-wavetag'), 'incluye el tag OLA del banner');
    assert.ok(html.includes('mz-prog-bar'), 'incluye el bloque AVANCE con barra de progreso');
});

test('renderCostos compone ③ la barra de subventanas (nav v3)', () => {
    const html = render();
    assert.ok(html.includes('v3-nav'), 'incluye la nav de subventanas compartida');
});

test('renderCostos deja el contenido propio de COSTOS DEBAJO del marco (CA-4)', () => {
    const html = render();
    assert.ok(html.includes(SENTINEL), 'el contenido propio de COSTOS sigue presente');
    // El marco va arriba: el banner de ola aparece antes que el contenido propio.
    assert.ok(
        html.indexOf('mz-mission') < html.indexOf(SENTINEL),
        'el marco común se renderiza por encima del contenido de COSTOS',
    );
});

test('renderCostos no duplica markup: reusa el banner del marco común (mz-mission, sin lv-mission)', () => {
    const html = render();
    // El banner reusado del marco usa clases mz-* — no las legacy lv-mission.
    assert.ok(!html.includes('lv-mission'), 'no reintroduce el banner legacy lv-mission');
});
