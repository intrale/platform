// =============================================================================
// Tests de la ventana Matriz extraída a su propio módulo (#3731, padre #3715).
//
// Cubre:
//   - Exports canónicos del módulo ({ renderMatriz, renderMatrizInner, slug }).
//   - renderMatriz() emite un documento SSR completo con shell V3 (DOCTYPE,
//     <title>, nav v3) y los selectores estructurales estables.
//   - renderMatrizInner() emite el fragmento embebible sin <!DOCTYPE> (DOM
//     morphing del router cliente `?view=matriz`).
//   - escapeHtmlSsr canónico: payloads XSS NO escapan crudos al output (CA-D1,
//     defensa en profundidad sobre lib/escape-html.js).
//   - El <script> embebido construye la grilla escapando los datos del servidor
//     con escapeHtml() ANTES de tocar innerHTML (XSS guard sobre nombres de
//     skill / claves pipeline·fase que vienen de /api/dash/pipeline).
//   - Leyenda del heat-map (CA-C3) + tooltips operativos (CA-C1).
//
// Se ejecuta con: node --test .pipeline/views/dashboard/__tests__/matriz.test.js
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const matriz = require('..' + path.sep + 'matriz.js');
const { renderMatriz, renderMatrizInner, slug, escapeHtmlSsr } = matriz;

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

test('exports canónicos del módulo Matriz', () => {
    assert.equal(slug, 'matriz');
    assert.equal(typeof renderMatriz, 'function');
    assert.equal(typeof renderMatrizInner, 'function');
    assert.equal(typeof escapeHtmlSsr, 'function');
});

// ---------------------------------------------------------------------------
// Estructura SSR
// ---------------------------------------------------------------------------

test('renderMatriz emite un documento SSR completo', () => {
    const html = renderMatriz();
    assert.ok(html.startsWith('<!DOCTYPE html>'), 'falta el DOCTYPE del shell');
    assert.match(html, /<title>Intrale · Matriz<\/title>/);
    assert.match(html, /class="v3-nav"/, 'falta la nav V3 del shell');
    // Header del shell satélite.
    assert.match(html, /id="hdr-mode"/);
    assert.match(html, /id="hdr-clock"/);
});

test('renderMatriz emite los selectores estructurales estables', () => {
    const html = renderMatriz();
    assert.match(html, /id="matriz-table"/, 'falta el contenedor de la tabla');
    assert.match(html, /Matriz · skill × fase/, 'falta el título de la sección');
    assert.match(html, /class="mtx-legend"/, 'falta la leyenda del heat-map (CA-C3)');
});

test('renderMatrizInner emite el fragmento embebible sin shell', () => {
    const inner = renderMatrizInner();
    assert.equal(inner.includes('<!DOCTYPE html>'), false, 'el inner NO debe traer shell');
    assert.match(inner, /id="matriz-table"/);
    assert.match(inner, /<script>/);
    // El fragmento es autosuficiente: trae sus helpers + el tick.
    assert.match(inner, /async function tickMatriz\(\)/);
    assert.match(inner, /function fetchJson\(/);
});

// ---------------------------------------------------------------------------
// Leyenda (CA-C3) + tooltips (CA-C1)
// ---------------------------------------------------------------------------

test('la leyenda explica los tres estados de celda (CA-C3)', () => {
    const html = renderMatriz();
    assert.match(html, /Sin carga/);
    assert.match(html, /carga normal/);
    assert.match(html, /cuello de botella/);
    // Cada item de leyenda tiene tooltip.
    assert.match(html, /class="mtx-legend-item" title=/);
    // El contenedor de la tabla es accesible (aria-live para hidratación).
    assert.match(html, /aria-live="polite"/);
});

test('los encabezados y celdas de la grilla llevan tooltip (CA-C1)', () => {
    const inner = renderMatrizInner();
    // El JS embebido construye <th title=...> y <td ... title=...>.
    assert.match(inner, /<th title="'\+escapeHtml\(p\+'\/'\+fase\)\+'"/);
    assert.match(inner, /title="'\+tip\+'"/, 'las celdas deben llevar tooltip');
});

// ---------------------------------------------------------------------------
// XSS guards
// ---------------------------------------------------------------------------

test('el JS embebido escapa los datos del servidor antes de innerHTML (XSS guard)', () => {
    const html = renderMatriz();
    const scriptMatch = html.match(/<script[^>]*>([\s\S]*?)<\/script>/);
    assert.ok(scriptMatch, 'falta el <script> embebido');
    const js = scriptMatch[1];
    // Hay UNA sola asignación a innerHTML, y todos los valores del servidor
    // (skill, pipeline, fase) pasan por escapeHtml() antes de construir el HTML.
    assert.match(js, /escapeHtml\(skill\)/, 'el nombre de skill debe escaparse');
    assert.match(js, /escapeHtml\(p\+'\/'\+fase\)/, 'la clave pipeline\/fase debe escaparse');
    // No se concatena ningún valor del servidor crudo a innerHTML sin escapar.
    assert.equal(/innerHTML\s*=\s*['"`]?\s*\+/.test(js), false);
});

test('escapeHtmlSsr canónico — payloads XSS no escapan al output', () => {
    const payloads = [
        '<img src=x onerror=alert(1)>',
        '"><script>alert(2)</script>',
        "';alert(3);//",
        '<svg/onload=alert(4)>',
    ];
    for (const p of payloads) {
        const out = escapeHtmlSsr(p);
        assert.equal(out.includes('<'), false, `'<' sin escapar en: ${p}`);
        assert.equal(out.includes('>'), false, `'>' sin escapar en: ${p}`);
        // El SSR del documento no debe reflejar ningún payload crudo.
        assert.equal(renderMatriz().includes(p), false, `payload crudo en el HTML: ${p}`);
    }
});

test('escapeHtmlSsr trata null/undefined como string vacío', () => {
    assert.equal(escapeHtmlSsr(null), '');
    assert.equal(escapeHtmlSsr(undefined), '');
});

// ---------------------------------------------------------------------------
// Hidratación / endpoint
// ---------------------------------------------------------------------------

test('la ventana se hidrata desde /api/dash/pipeline (sin acciones mutantes)', () => {
    const html = renderMatriz();
    assert.match(html, /fetchJson\('\/api\/dash\/pipeline'\)/);
    // READ-ONLY: sin <form>, sin POST embebido.
    assert.equal(/<form/.test(html), false, 'la ventana Matriz no debe tener <form>');
    assert.equal(/method=['"]?post/i.test(html), false, 'la ventana Matriz no debe emitir POST');
});
