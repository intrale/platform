'use strict';

// =============================================================================
// Tests #4245 (Ola 7.1) — DESCANSO adopta el marco común de ventanas MIZPÁ.
//
// Valida que el render SSR standalone de la pantalla Descanso conserve el marco
// común (① cabecera MIZPÁ + ② banner de ola común + ③ barra de accesos) en el
// orden canónico de la HOME/EQUIPO, reusando el helper compartido
// renderMissionBanner (CA-5: sin duplicar markup) y dejando el contenido propio
// de Descanso debajo del marco (CA-4). También verifica la hidratación
// (tickDescansoMission) y el CSS compartido del banner.
//
// Ejecutar: node --test .pipeline/tests/descanso-marco-mizpa.test.js
// =============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');

const descanso = require('../views/dashboard/descanso.js');
const home = require('../views/dashboard/home.js');

// ---------------------------------------------------------------------------
// CA-1 · cabecera MIZPÁ común
// ---------------------------------------------------------------------------

test('renderDescanso conserva la cabecera de marca MIZPÁ común (CA-1)', () => {
    const html = descanso.renderDescanso({});
    assert.ok(html.includes('class="in-header-brand"'), 'brand bar común');
    assert.ok(html.includes('>MIZPÁ<'), 'marca MIZPÁ');
    assert.ok(html.includes('mz-projsel'), 'selector multiproyecto');
    assert.ok(html.includes('1 / 3'), 'badge multiproyecto');
});

// ---------------------------------------------------------------------------
// CA-2 · banner de ola común (reuso de renderMissionBanner)
// ---------------------------------------------------------------------------

test('renderDescanso inyecta el banner de ola común con tag + título + AVANCE (CA-2)', () => {
    const html = descanso.renderDescanso({});
    assert.ok(html.includes('id="mz-mission"'), 'sección del banner de ola');
    assert.ok(html.includes('mz-wavetag'), 'tag OLA');
    assert.ok(html.includes('id="mission-wave-name"'), 'título de la ola');
    assert.ok(html.includes('id="mission-avance-pct"'), 'bloque AVANCE (%)');
    assert.ok(html.includes('id="mission-leg-done"'), 'leyenda de puntitos');
});

test('el banner de Descanso es el mismo markup que el helper compartido de la HOME (CA-5)', () => {
    const html = descanso.renderDescanso({});
    // El helper compartido produce la sección con id="mz-mission": debe estar
    // presente exactamente una vez (no se duplica markup) y coincidir con el de
    // home.renderMissionBanner().
    assert.equal((html.match(/id="mz-mission"/g) || []).length, 1, 'banner una sola vez');
    const shared = home.renderMissionBanner();
    assert.ok(html.includes(shared.trim()), 'reusa verbatim renderMissionBanner() de la HOME');
});

// ---------------------------------------------------------------------------
// CA-3 · barra de accesos común
// ---------------------------------------------------------------------------

test('renderDescanso conserva la barra de accesos a subventanas (CA-3)', () => {
    const html = descanso.renderDescanso({});
    const navIdx = html.indexOf('<nav class="v3-nav"', html.indexOf('</header>'));
    assert.ok(navIdx > 0, 'nav V3 de accesos presente tras el header');
    assert.ok(html.includes('aria-current="page"'), 'Descanso marcado en la nav');
});

// ---------------------------------------------------------------------------
// CA-4 · orden del marco + contenido propio debajo
// ---------------------------------------------------------------------------

test('orden del marco: marca → ola → nav → contenido propio de Descanso (CA-4)', () => {
    const html = descanso.renderDescanso({});
    const iBrand = html.indexOf('class="in-header-brand"');
    const iHeaderEnd = html.indexOf('</header>');
    const iMission = html.indexOf('id="mz-mission"');
    const iNav = html.indexOf('<nav class="v3-nav"', iHeaderEnd);
    const iContent = html.indexOf('id="rm-timezone"'); // contenido propio de Descanso
    assert.ok(iBrand > 0, 'brand presente');
    assert.ok(iMission > iHeaderEnd, 'banner de ola tras el header');
    assert.ok(iNav > iMission, 'nav tras el banner de ola');
    assert.ok(iContent > iNav, 'contenido de Descanso debajo del marco');
});

// ---------------------------------------------------------------------------
// CA-6 · hidratación + CSS compartido
// ---------------------------------------------------------------------------

test('renderDescanso cablea la hidratación del banner desde /api/dash/waves (CA-2/CA-6)', () => {
    const html = descanso.renderDescanso({});
    assert.ok(html.includes('tickDescansoMission'), 'tick de hidratación del banner');
    assert.ok(html.includes('/api/dash/waves'), 'fuente de datos de la ola');
});

test('renderDescanso alinea el banner con el padding del cuerpo (CSS del marco)', () => {
    const html = descanso.renderDescanso({});
    assert.ok(html.includes('.satellite-frame > .mz-mission'), 'regla de margen del banner en el frame');
});

// ---------------------------------------------------------------------------
// Regresión · el fragmento embebible sigue válido (sin shell)
// ---------------------------------------------------------------------------

test('renderDescansoInner sigue siendo un fragmento sin shell <!DOCTYPE>', () => {
    const inner = descanso.renderDescansoInner();
    assert.ok(typeof inner === 'string' && inner.length > 0);
    assert.ok(!inner.includes('<!DOCTYPE'), 'fragmento embebible, sin documento completo');
});
