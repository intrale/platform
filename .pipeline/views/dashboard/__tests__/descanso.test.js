// =============================================================================
// Tests de la ventana Descanso extraída a su propio módulo (#3736, padre #3715).
//
// Cubre:
//   - Exports canónicos del módulo ({ renderDescanso, renderDescansoInner, slug }).
//   - renderDescanso() emite un documento SSR completo con los selectores
//     estructurales estables (rm-status, rm-grid, rm-bypass, rm-updated, rm-form).
//   - El <script> embebido NO asigna innerHTML con datos del servidor: toda la
//     hidratación cliente usa createElement + textContent (FE-SEC-1 / XSS guard).
//   - escapeHtmlSsr canónico: un payload XSS pasado por opts.tz NO escapa crudo
//     al output (CA-D1, defensa en profundidad sobre la única interpolación SSR).
//   - Tooltips operativos (CA-C1): cada acción mutante tiene title + aria-label.
//   - renderDescansoInner() emite el fragmento embebible sin <!DOCTYPE>.
//
// Se ejecuta con: node --test .pipeline/views/dashboard/__tests__/descanso.test.js
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { renderDescanso, renderDescansoInner, slug } = require('..' + path.sep + 'descanso.js');

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

test('exports canónicos del módulo Descanso', () => {
    assert.equal(slug, 'descanso');
    assert.equal(typeof renderDescanso, 'function');
    assert.equal(typeof renderDescansoInner, 'function');
});

// ---------------------------------------------------------------------------
// Estructura SSR
// ---------------------------------------------------------------------------

test('renderDescanso emite un documento SSR completo', () => {
    const html = renderDescanso();
    assert.ok(html.startsWith('<!DOCTYPE html>'), 'falta el DOCTYPE del shell');
    assert.match(html, /<title>Intrale · Modo descanso<\/title>/);
    assert.match(html, /class="v3-nav"/, 'falta la nav V3 del shell');
});

test('renderDescanso emite los selectores estructurales estables', () => {
    const html = renderDescanso();
    for (const sel of ['rm-status', 'rm-grid', 'rm-bypass', 'rm-updated', 'rm-form']) {
        assert.match(html, new RegExp(sel), `falta el selector ${sel}`);
    }
});

test('renderDescansoInner emite el fragmento embebible sin shell', () => {
    const inner = renderDescansoInner();
    assert.equal(inner.includes('<!DOCTYPE html>'), false, 'el inner NO debe traer shell');
    assert.match(inner, /id="rm-grid"/);
    assert.match(inner, /<script>/);
});

// ---------------------------------------------------------------------------
// XSS guards
// ---------------------------------------------------------------------------

test('el JS embebido no asigna innerHTML con datos del servidor (XSS guard)', () => {
    const html = renderDescanso();
    // Único <script> del documento. Non-greedy hasta el primer cierre.
    const scriptMatch = html.match(/<script[^>]*>([\s\S]*?)<\/script>/);
    assert.ok(scriptMatch, 'falta el <script> embebido');
    assert.equal(
        /\.innerHTML\s*=/.test(scriptMatch[1]),
        false,
        'el JS embebido NO debe usar innerHTML con datos del servidor (riesgo XSS)',
    );
});

test('escapeHtmlSsr canónico — payload XSS por opts.tz no escapa al output', () => {
    const payload = '<img src=x onerror=alert(1)>';
    const html = renderDescanso({ tz: payload });
    assert.equal(html.includes(payload), false, 'el payload crudo NO debe aparecer en el HTML');
    // El valor sí se interpola, pero escapado en contexto atributo.
    assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
});

test('render sin opts no inyecta value en el input de timezone', () => {
    const html = renderDescanso();
    assert.match(html, /id="rm-timezone"/);
    // Sin opts.tz no hay atributo value prefilled.
    assert.equal(/id="rm-timezone"[^>]*value=/.test(html), false);
});

// ---------------------------------------------------------------------------
// Tooltips operativos (CA-C1)
// ---------------------------------------------------------------------------

test('cada acción operativa tiene tooltip (title) + aria-label (CA-C1)', () => {
    const html = renderDescanso();
    // Checkbox "Activar modo descanso"
    assert.match(html, /Si destildás, el pipeline opera sin restricciones \(CA-1\.9\)/);
    assert.match(html, /aria-label="Activar modo descanso/);
    // Botón "Guardar configuración"
    assert.match(html, /Hot-reload sin reinicio del pipeline/);
    assert.match(html, /aria-label="Guardar configuración/);
    // "+ Periodo" y "✕" se construyen client-side: el texto del tooltip y el
    // aria-label viajan en el JS embebido.
    assert.match(html, /Agregar periodo \(máximo 24 por día\)/);
    assert.match(html, /Máximo 24 periodos por día/);
    assert.match(html, /'title': 'Eliminar periodo'/);
});
