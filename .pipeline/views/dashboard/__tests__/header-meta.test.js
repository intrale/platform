// =============================================================================
// Tests del módulo compartido del encabezado (#4463).
//
// header-meta.js es el espejo de nav-tabs.js para las PILLS del header. Emite
// el <div class="in-header-meta"> con los IDs invariantes (hdr-resources,
// hdr-pulpo, hdr-clock) + hdr-mode opcional, y centraliza la hidratación
// (window.__hydrateHeaderPills) con la lógica de umbrales in-pill-ok/warn/bad.
//
// Contratos verificados:
//   1. renderHeaderMetaSsr() emite los tres IDs invariantes.
//   2. withMode:true agrega además #hdr-mode; withMode:false no lo emite.
//   3. IDs, title y aria-label literales preservados (snapshot R-G1).
//   4. SEC-1: el SSR no usa innerHTML ni interpola datos dinámicos; la
//      hidratación usa sólo textContent/classList/title (sin innerHTML).
//
// node:test, sin Jest.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const HM_PATH = path.resolve(__dirname, '..', 'header-meta.js');
const { renderHeaderMetaSsr, headerPillsClientScript, headerPillsPollClientScript } = require(HM_PATH);

test('renderHeaderMetaSsr() emite los tres IDs invariantes (recursos, pulpo, reloj)', () => {
    const html = renderHeaderMetaSsr();
    assert.match(html, /id="bld-status"/, 'falta la pill de build');
    assert.match(html, /id="hdr-resources"/, 'falta la pill de recursos CPU/RAM');
    assert.match(html, /id="hdr-pulpo"/, 'falta la pill de uptime del Pulpo');
    assert.match(html, /id="hdr-clock"/, 'falta el reloj');
    assert.match(html, /class="in-header-meta"/, 'falta el contenedor in-header-meta');
});

test('la bandeja de estado no muestra signo de pregunta en build desconocido', () => {
    const html = renderHeaderMetaSsr({ withMode: true });
    const script = headerPillsClientScript();
    assert.doesNotMatch(html + script, /Build \?/, 'el estado unknown debe mostrarse como Build sin datos');
    assert.match(html + script, /Build sin datos/, 'fallback explícito para build desconocido');
});

test('sin withMode NO emite #hdr-mode (comportamiento de home, #4227)', () => {
    const html = renderHeaderMetaSsr({ withMode: false });
    assert.doesNotMatch(html, /id="hdr-mode"/, 'home no debe mostrar la pill de estado del pipeline');
    // El default (sin opts) también es withMode:false.
    assert.doesNotMatch(renderHeaderMetaSsr(), /id="hdr-mode"/, 'default withMode:false');
});

test('withMode:true agrega #hdr-mode además de las tres pills (satélites/roadmap)', () => {
    const html = renderHeaderMetaSsr({ withMode: true });
    assert.match(html, /id="hdr-mode"/, 'falta la pill de estado del pipeline en satélites');
    assert.match(html, /id="hdr-resources"/);
    assert.match(html, /id="hdr-pulpo"/);
    assert.match(html, /id="hdr-clock"/);
});

test('preserva title y aria-label literales de las pills (contrato de accesibilidad)', () => {
    const html = renderHeaderMetaSsr({ withMode: true });
    assert.match(html, /title="CPU, RAM y disco del sistema"/, 'title de recursos preservado');
    assert.match(html, /aria-label="Recursos CPU, RAM y disco"/, 'aria-label de recursos preservado');
    assert.match(html, /aria-label="Estado del pulpo"/, 'aria-label del pulpo preservado');
    assert.match(html, /aria-label="Fecha y hora local"/, 'aria-label del reloj preservado');
});

test('orden estable de las pills: [mode] → recursos → pulpo → reloj (guideline UX-3)', () => {
    const html = renderHeaderMetaSsr({ withMode: true });
    const iBuild = html.indexOf('id="bld-status"');
    const iMode = html.indexOf('id="hdr-mode"');
    const iRes = html.indexOf('id="hdr-resources"');
    const iPulpo = html.indexOf('id="hdr-pulpo"');
    const iClock = html.indexOf('id="hdr-clock"');
    assert.ok(iBuild >= 0 && iBuild < iMode, 'build antes de mode');
    assert.ok(iMode >= 0 && iMode < iRes, 'mode antes de recursos');
    assert.ok(iRes < iPulpo, 'recursos antes de pulpo');
    assert.ok(iPulpo < iClock, 'pulpo antes del reloj');
});

test('SEC-1: el SSR no usa innerHTML ni interpola datos dinámicos', () => {
    const html = renderHeaderMetaSsr({ withMode: true });
    assert.doesNotMatch(html, /innerHTML/, 'el SSR no debe contener innerHTML');
    // Las pills nacen con el placeholder "…" — sin ningún valor dinámico de CPU/RAM/uptime.
    assert.match(html, />…</, 'las pills arrancan con placeholder … (hidratación client-side)');
});

test('SEC-1: la hidratación compartida usa textContent/classList/title, nunca innerHTML', () => {
    const script = headerPillsClientScript();
    assert.doesNotMatch(script, /innerHTML/, 'la hidratación no debe usar innerHTML (vector XSS FE-SEC-4)');
    assert.match(script, /\.textContent/, 'usa textContent para valores dinámicos');
    assert.match(script, /window\.__hydrateHeaderPills/, 'expone el helper global de hidratación');
    // Guard de idempotencia (no redefinir en re-render). #4531 — el guard incluye
    // `typeof window !== 'undefined'` para no lanzar si el script se evalúa en un
    // sandbox sin window (tests de gesto que evalúan el <script> real).
    assert.match(script, /typeof window !== 'undefined' && !window\.__hydrateHeaderPills/, 'guard de idempotencia + sandbox-safe');
});

test('la hidratación conserva la señal de presión de recursos (ok/warn/bad)', () => {
    const script = headerPillsClientScript();
    assert.match(script, /in-pill-ok/, 'clase ok');
    assert.match(script, /in-pill-warn/, 'clase warn');
    assert.match(script, /in-pill-bad/, 'clase bad');
    assert.match(script, /in-resource-alert/, 'resalta la métrica específica que supera el cap');
    // Umbrales históricos preservados (cálculo sin cambios).
    assert.match(script, /maxCpu/, 'umbral de CPU');
    assert.match(script, /maxMem/, 'umbral de RAM');
    assert.match(script, /> 50/, 'umbral warn en 50%');
});

test('el poller standalone fetchea /api/dash/header y llama al helper, con catch defensivo', () => {
    const poll = headerPillsPollClientScript();
    assert.match(poll, /\/api\/dash\/header/, 'consume el endpoint de header');
    assert.match(poll, /window\.__hydrateHeaderPills/, 'invoca el helper compartido');
    assert.match(poll, /\.catch\(/, 'catch defensivo (el pipeline/dashboard no puede morir)');
    assert.match(poll, /setInterval\(/, 'refresca periódicamente');
});
