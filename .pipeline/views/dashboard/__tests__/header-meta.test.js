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

// ─── #5113 CA-UX1 · Chip de procedencia del estado operativo ─────────────────
//
// El chip vive en ESTA bandeja y no sólo en el home a propósito: durante una
// ventana de cutover el operador mira la pantalla que tiene abierta. Como el
// módulo lo comparten home y los 10 satélites, ponerlo acá lo pone en todas.

test('#5113 CA-UX1: el SSR emite la pill de procedencia con su símbolo y su etiqueta', () => {
    const html = renderHeaderMetaSsr();
    assert.match(html, /id="hdr-opstate"/, 'falta la pill de procedencia del estado operativo');
    assert.match(html, /id="hdr-opstate-symbol"/, 'falta el símbolo (regla 1: no sólo color)');
    assert.match(html, /id="hdr-opstate-label"/, 'falta la etiqueta textual');
    // También con withMode:true (satélites): la bandeja es la misma.
    assert.match(renderHeaderMetaSsr({ withMode: true }), /id="hdr-opstate"/);
});

test('#5113 CA-UX1: la pill de procedencia declara title y aria-label (accesibilidad)', () => {
    const html = renderHeaderMetaSsr();
    assert.match(html, /aria-label="Procedencia del estado operativo"/);
    assert.match(html, /title="Procedencia del estado operativo[^"]*"/);
});

test('#5113 CA-UX1: el SSR de la pill es literal estático (SEC-1: nada del slice interpolado)', () => {
    // Mismo invariante que el resto de la bandeja: el markup del servidor no
    // puede llevar datos dinámicos. Dos renders con opts distintos difieren
    // SÓLO en #hdr-mode; el fragmento de procedencia es idéntico byte a byte.
    const a = renderHeaderMetaSsr({ withMode: false });
    const b = renderHeaderMetaSsr({ withMode: true });
    const frag = (h) => h.slice(h.indexOf('id="hdr-opstate"'), h.indexOf('id="hdr-clock"'));
    assert.equal(frag(a), frag(b), 'el fragmento de procedencia debe ser un literal estable');
});

test('#5113 CA-UX1: la hidratación usa property sinks y NUNCA innerHTML', () => {
    const script = headerPillsClientScript();
    assert.match(script, /getElementById\('hdr-opstate'\)/, 'el hidratador no toca la pill nueva');
    assert.match(script, /hdr-opstate-symbol/);
    assert.match(script, /hdr-opstate-label/);
    // El bloque del chip no puede usar innerHTML (SEC-1 / FE-SEC-4).
    const bloque = script.slice(script.indexOf("getElementById('hdr-opstate')"));
    const hasta = bloque.indexOf('hdr-resources');
    assert.doesNotMatch(bloque.slice(0, hasta > 0 ? hasta : bloque.length), /innerHTML/);
});

test('#5113 CA-UX1: la hidratación pinta los tres tonos y limpia el anterior', () => {
    const script = headerPillsClientScript();
    const bloque = script.slice(script.indexOf("getElementById('hdr-opstate')"));
    const hasta = bloque.indexOf('hdr-resources');
    const chip = bloque.slice(0, hasta > 0 ? hasta : bloque.length);
    // Sin el remove(), un chip que pasó por "sin respuesta" se queda rojo
    // para siempre aunque el store se recupere.
    assert.match(chip, /classList\.remove\([^)]*in-pill-bad/);
    assert.match(chip, /in-pill-ok/);
    assert.match(chip, /in-pill-warn/);
    assert.match(chip, /in-pill-bad/);
});

test('#5113 CA-UX1: el chip NO re-deriva la condición en el cliente (una sola fuente del mapeo)', () => {
    // El mapeo cerrado vive en el slice (`resolveOpstateProvenance`). Si el
    // cliente volviera a mirar `mode === 'remote'` o `degraded`, el chip y el
    // banner podrían decir cosas distintas del mismo hecho.
    const script = headerPillsClientScript();
    const bloque = script.slice(script.indexOf("getElementById('hdr-opstate')"));
    const hasta = bloque.indexOf('hdr-resources');
    const chip = bloque.slice(0, hasta > 0 ? hasta : bloque.length);
    assert.doesNotMatch(chip, /d\.mode/, 'el cliente no debe releer el modo: lo resuelve el slice');
    assert.doesNotMatch(chip, /degraded/, 'el cliente no debe releer la degradación: la resuelve el slice');
});
