// =============================================================================
// Tests del marco común MIZPÁ en la pantalla MATRIZ (#4241, marco de #4234).
//
// Verifica que renderMatriz() (matriz.js) antepone al contenido propio el marco
// común reutilizable, idéntico al resto de las pantallas migradas (HOME #4235,
// COSTOS #4239, EQUIPO, BLOQUEADOS, ISSUES #4266):
//   ① Cabecera MIZPÁ (renderMatrizBrandBar — marca + selector de proyecto).
//   ② Cabecera de ola común (renderMissionBannerPipeline canónico de #4234, slot
//      mz-mission + IDs mission-* hidratados por tickMission desde
//      /api/dash/waves).
//   ③ Barra de accesos a subventanas (renderNavTabsSsr('matriz')).
//   ④ Contenido propio de MATRIZ (banner diagnóstico mtx-mission + heatmap del
//      rediseño #4196) DEBAJO del marco, intacto (CA-4).
//
// CA-5 (no duplicar markup): el banner de ola sale del helper canónico
// compartido `renderMissionBannerPipeline()` (pipeline-redesign.js) — no se
// duplica el markup del marco.
//
// node:test (sin Jest). No arranca el dashboard; render directo de la función.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const MATRIZ_PATH = path.resolve(__dirname, '..', 'matriz.js');
const matriz = require(MATRIZ_PATH);

function renderMatrizHtml() {
    return matriz.renderMatriz();
}

test('MATRIZ ① muestra la cabecera MIZPÁ común (marca + selector de proyecto)', () => {
    const html = renderMatrizHtml();
    assert.match(html, /MIZPÁ/, 'falta la marca MIZPÁ');
    assert.match(html, /mz-projsel/, 'falta el selector de proyecto del marco común');
    assert.match(html, /PROYECTO ACTIVO/, 'falta el estado del proyecto activo');
});

test('MATRIZ ② muestra la cabecera de ola común (slot + IDs mission-*)', () => {
    const html = renderMatrizHtml();
    assert.match(html, /id="mz-mission"/, 'falta el slot del banner de ola común');
    assert.match(html, /mission-wave-num/, 'falta el tag de ola');
    assert.match(html, /mission-wave-name/, 'falta el título de ola');
    assert.match(html, /mission-avance-pct/, 'falta el bloque AVANCE');
    assert.match(html, /mission-leg-done/, 'falta la leyenda de puntitos (hechos)');
});

test('MATRIZ ② hidrata el banner de ola con tickMission desde /api/dash/waves', () => {
    const html = renderMatrizHtml();
    assert.match(html, /tickMission/, 'el banner de ola no se hidrata con tickMission');
    assert.match(html, /\/api\/dash\/waves/, 'tickMission debe leer /api/dash/waves');
});

test('MATRIZ ③ muestra la barra de accesos a subventanas (nav común)', () => {
    const html = renderMatrizHtml();
    assert.match(html, /v3-nav/, 'falta la barra de accesos común (renderNavTabsSsr)');
    assert.match(html, /Pipeline/, 'falta el acceso a Pipeline');
    assert.match(html, /Issues/, 'falta el acceso a Issues');
});

test('MATRIZ ④ deja el contenido propio DEBAJO del marco común (orden ①<②<③<④, CA-4)', () => {
    const full = renderMatrizHtml();
    const body = full.slice(full.indexOf('<body>'));
    const idxBrand = body.indexOf('mz-projsel');                  // ① cabecera MIZPÁ
    const idxMission = body.indexOf('<section class="mz-mission"'); // ② banner de ola común
    // El nav estructural real (renderNavTabsSsr) viene DESPUÉS del banner de ola.
    // (`<nav class="v3-nav">` también aparece antes dentro del comentario del
    // sprite SVG, por eso se busca a partir del índice del mission banner.)
    const idxNav = body.indexOf('<nav class="v3-nav"', idxMission);
    const idxBody = body.indexOf('id="mtx-mission"');             // ④ banner diagnóstico propio
    const idxTable = body.indexOf('id="matriz-table"');          // ④ heatmap propio
    assert.ok(idxBrand >= 0 && idxMission >= 0 && idxNav >= 0 && idxBody >= 0 && idxTable >= 0, 'falta alguno de los bloques');
    assert.ok(idxBrand < idxMission, '① cabecera debe ir antes de ② banner de ola');
    assert.ok(idxMission < idxNav, '② banner de ola debe ir antes de ③ nav');
    assert.ok(idxNav < idxBody, '③ nav debe ir antes del ④ contenido propio (banner diagnóstico)');
    assert.ok(idxBody < idxTable, '④ banner diagnóstico debe ir antes del heatmap');
});

test('MATRIZ conserva su contenido propio (no se rompe el layout existente)', () => {
    const html = renderMatrizHtml();
    // Banner diagnóstico propio (#4196) intacto.
    assert.match(html, /id="mtx-mission"/, 'falta el banner diagnóstico propio de MATRIZ');
    assert.match(html, /CARGA TOTAL/, 'falta la métrica propia «carga total»');
    // Heatmap skill × fase intacto.
    assert.match(html, /id="matriz-table"/, 'falta el contenedor del heatmap de MATRIZ');
    assert.match(html, /skill × fase/, 'falta el título propio del heatmap');
});

test('MATRIZ ② el banner de ola común sale del helper canónico (no duplica markup, CA-5)', () => {
    // El markup del banner debe coincidir con el del helper canónico compartido
    // que entregó #4234 (renderMissionBannerPipeline en pipeline-redesign.js):
    // misma fuente → no puede divergir.
    const canonical = require('../pipeline-redesign.js').renderMissionBannerPipeline();
    const html = renderMatrizHtml();
    assert.ok(html.includes(canonical), 'el banner de ola de MATRIZ no es el markup canónico compartido (se estaría duplicando)');
});
