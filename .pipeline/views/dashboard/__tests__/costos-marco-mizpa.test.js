// =============================================================================
// Tests del marco común MIZPÁ en la pantalla COSTOS (#4239, marco de #4234).
//
// Verifica que renderCostos() (satellites.js) antepone al contenido propio el
// marco común reutilizable, idéntico al resto de las pantallas migradas
// (EQUIPO #4240, BLOQUEADOS #4238):
//   ① Cabecera MIZPÁ (renderEquipoBrandBar — marca + selector de proyecto).
//   ② Cabecera de ola común (renderMissionBanner de la HOME, slot mz-mission +
//      IDs mission-* hidratados por tickMission desde /api/dash/waves).
//   ③ Barra de accesos a subventanas (renderNavTabsSsr('costos')).
//   ④ Contenido propio de COSTOS (rediseño #4194) DEBAJO del marco (CA-4).
//
// CA-5 (no duplicar markup): el banner de ola sale del helper compartido de la
// HOME y el tick es el helper compartido tickMission de commonHelpers().
//
// node:test (sin Jest). No arranca el dashboard; render directo de la función.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const SAT_PATH = path.resolve(__dirname, '..', 'satellites.js');
const sat = require(SAT_PATH);

const REDESIGN = '<div id="costos-redesign" class="cz-root">CONTENIDO_PROPIO_COSTOS</div>';

function renderCostosHtml() {
    return sat.renderCostos({ redesignHtml: REDESIGN });
}

test('COSTOS ① muestra la cabecera MIZPÁ común (marca + selector de proyecto)', () => {
    const html = renderCostosHtml();
    assert.match(html, /MIZPÁ/, 'falta la marca MIZPÁ');
    assert.match(html, /mz-projsel/, 'falta el selector de proyecto del marco común');
    assert.match(html, /PROYECTO ACTIVO/, 'falta el estado del proyecto activo');
});

test('COSTOS ② muestra la cabecera de ola común (slot + IDs mission-*)', () => {
    const html = renderCostosHtml();
    assert.match(html, /mz-mission/, 'falta el slot del banner de ola común');
    assert.match(html, /mission-wave-num/, 'falta el tag de ola');
    assert.match(html, /mission-wave-name/, 'falta el título de ola');
    assert.match(html, /mission-avance-pct/, 'falta el bloque AVANCE');
    assert.match(html, /mission-leg-done/, 'falta la leyenda de puntitos (hechos)');
});

test('COSTOS ② hidrata el banner con el helper compartido tickMission', () => {
    const html = renderCostosHtml();
    assert.match(html, /tickMission/, 'el banner de ola no se hidrata con tickMission');
    assert.match(html, /\/api\/dash\/waves/, 'tickMission debe leer /api/dash/waves');
});

test('COSTOS ③ muestra la barra de accesos a subventanas (nav común)', () => {
    const html = renderCostosHtml();
    assert.match(html, /v3-nav/, 'falta la barra de accesos común (renderNavTabsSsr)');
    assert.match(html, /Pipeline/, 'falta el acceso a Pipeline');
    assert.match(html, /Issues/, 'falta el acceso a Issues');
});

test('COSTOS ④ deja el contenido propio DEBAJO del marco común (CA-4)', () => {
    const html = renderCostosHtml();
    const idxBrand = html.indexOf('mz-projsel');
    const idxMission = html.indexOf('mz-mission');
    // El nav estructural real (renderNavTabsSsr) viene DESPUÉS del banner de ola.
    // (`v3-nav` también aparece antes dentro de un comentario del sprite SVG del
    // pageShell, por eso se busca a partir del índice del mission banner.)
    const idxNav = html.indexOf('<nav class="v3-nav"', idxMission);
    const idxBody = html.indexOf('CONTENIDO_PROPIO_COSTOS');
    assert.ok(idxBrand >= 0 && idxMission >= 0 && idxNav >= 0 && idxBody >= 0, 'falta alguno de los bloques');
    assert.ok(idxBrand < idxMission, '① cabecera debe ir antes de ② banner de ola');
    assert.ok(idxMission < idxNav, '② banner de ola debe ir antes de ③ nav');
    assert.ok(idxNav < idxBody, '③ nav debe ir antes del ④ contenido propio');
});

test('COSTOS conserva su contenido propio (no se rompe el layout existente)', () => {
    const html = renderCostosHtml();
    assert.match(html, /costos-redesign/, 'falta el contenedor del rediseño propio de COSTOS');
    assert.match(html, /CONTENIDO_PROPIO_COSTOS/, 'falta el contenido propio inyectado');
});
