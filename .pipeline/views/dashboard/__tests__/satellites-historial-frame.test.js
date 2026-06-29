// =============================================================================
// Tests del marco común MIZPÁ en la pantalla HISTORIAL (#4244, sobre #4234).
//
// #4244 traslada a HISTORIAL el marco repetido en todas las ventanas (definido
// en #4234, implementado primero en PIPELINE): ① cabecera MIZPÁ, ② cabecera de
// ola (banner común con bloque AVANCE) y ③ barra de accesos a subventanas. Los
// tres bloques deben ser IDÉNTICOS al resto de las pantallas y aparecer en orden,
// con el contenido propio de HISTORIAL debajo (CA-1..CA-5).
//
// Render directo de satellites.renderHistorial() (SSR). node:test, sin Jest.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const SAT_PATH = path.resolve(__dirname, '..', 'satellites.js');
const sat = require(SAT_PATH);

// Quita comentarios HTML para que las búsquedas de posición no matcheen el
// comentario `del <nav class="v3-nav">` que pageShell deja en el sprite.
function bodyNoComments(html) {
    return html.slice(html.indexOf('<body>')).replace(/<!--[\s\S]*?-->/g, '');
}

test('CA-1: HISTORIAL muestra la cabecera MIZPÁ común (marca + selector de proyecto)', () => {
    const html = sat.renderHistorial();
    assert.match(html, /class="in-header-brand"/, 'falta la cabecera de marca común');
    assert.match(html, /MIZPÁ/, 'falta la marca MIZPÁ');
    assert.match(html, /class="mz-projsel"/, 'falta el selector de proyecto común');
});

test('CA-2: HISTORIAL muestra la cabecera de ola común (tag OLA + métricas + bloque AVANCE)', () => {
    const html = sat.renderHistorial();
    assert.match(html, /class="mz-mission/, 'falta el banner de ola común');
    assert.match(html, /id="mission-wave-num"/, 'falta el tag de número de ola');
    assert.match(html, /id="mission-avance-pct"/, 'falta el bloque AVANCE');
    assert.match(html, /id="mission-bar-done"/, 'falta la barra de progreso apilada');
});

test('CA-3: HISTORIAL muestra la barra de accesos a subventanas común (nav v3)', () => {
    const html = sat.renderHistorial();
    assert.match(html, /<nav class="v3-nav/, 'falta la barra de accesos común');
});

test('CA-4: el contenido propio de HISTORIAL queda debajo del marco, en orden', () => {
    const b = bodyNoComments(sat.renderHistorial());
    const header = b.search(/<header class="in-header"/);
    const mission = b.search(/<section class="mz-mission/);
    const nav = b.search(/<nav class="v3-nav/);
    const content = b.search(/<section class="hm"/);
    assert.ok(header >= 0 && mission >= 0 && nav >= 0 && content >= 0, 'falta algún bloque del layout');
    assert.ok(header < mission, '① cabecera debe ir antes de ② ola');
    assert.ok(mission < nav, '② ola debe ir antes de ③ accesos');
    assert.ok(nav < content, '③ accesos debe ir antes de ④ contenido propio (hm)');
});

test('CA-5: el banner de ola es IDÉNTICO al de las pantallas hermanas (reuso, no duplicación)', () => {
    const grabMission = (s) => {
        const m = s.match(/<section class="mz-mission[\s\S]*?<\/section>/);
        return m ? m[0] : '';
    };
    const hist = grabMission(sat.renderHistorial());
    const equipo = grabMission(sat.renderEquipo());
    assert.ok(hist.length > 0, 'no se pudo extraer el banner de HISTORIAL');
    assert.equal(hist, equipo, 'el banner de ola difiere del de EQUIPO (debería ser el mismo helper compartido)');
});

test('hidratación: el tick del banner de ola queda cableado en el script de HISTORIAL', () => {
    const html = sat.renderHistorial();
    assert.match(html, /hmTickMission/, 'falta la hidratación del banner de ola (/api/dash/waves)');
});
