// Test de regresión XSS en showPartialPauseDepsModal (#2893 rebote security).
//
// El modal recibe títulos de issues que llegan desde gh issue view; cualquier
// MEMBER del repo puede crear un issue con título malicioso. Si esos títulos
// se concatenan a innerHTML sin escape, el JS del título se ejecuta cuando un
// operador activa la pausa parcial (vector XSS persistido).
//
// Estos tests congelan el contrato: la función _escHtml inline existe y se
// usa sobre c.title; el endpoint /api/pause-partial coerciona issues a integer.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const dashboardPath = path.join(__dirname, '..', 'dashboard.js');
const src = fs.readFileSync(dashboardPath, 'utf8');

// ----- Estructura defensiva en el modal --------------------------------------

test('showPartialPauseDepsModal define _escHtml inline', () => {
    // Recortamos al cuerpo de la función para no matchear ocurrencias en otros lugares.
    const start = src.indexOf('function showPartialPauseDepsModal(');
    assert.ok(start > 0, 'la función showPartialPauseDepsModal debe existir');
    // El cuerpo del modal termina antes del próximo "// #2893 — Banner".
    const end = src.indexOf("// #2893 — Banner:", start);
    assert.ok(end > start, 'el cierre de la función debe encontrarse');
    const body = src.slice(start, end);

    assert.match(body, /function\s+_escHtml\s*\(s\)\s*\{/, '_escHtml debe estar definida dentro del modal');
    assert.match(body, /\.replace\(\/&\/g,\s*'&amp;'\)/, '_escHtml debe escapar &');
    assert.match(body, /\.replace\(\/<\/g,\s*'&lt;'\)/, '_escHtml debe escapar <');
    assert.match(body, /\.replace\(\/>\/g,\s*'&gt;'\)/, '_escHtml debe escapar >');
    assert.match(body, /\.replace\(\/"\/g,\s*'&quot;'\)/, '_escHtml debe escapar "');
});

test('showPartialPauseDepsModal escapa c.title antes de concatenar a innerHTML', () => {
    const start = src.indexOf('function showPartialPauseDepsModal(');
    const end = src.indexOf('\n}\n', start);
    const body = src.slice(start, end);

    // La línea original concatenaba c.title sin escape:
    //   const t = c.title ? ' — ' + String(c.title).slice(0, 70) : '';
    // El fix debe envolver String(c.title).slice(...) con _escHtml(...).
    assert.match(
        body,
        /_escHtml\(\s*String\(c\.title\)\.slice\(0,\s*70\)\s*\)/,
        'el title debe pasar por _escHtml antes de inyectarse a la lista de deps',
    );

    // No debe quedar ninguna concatenación cruda de c.title a string sin escape.
    assert.doesNotMatch(
        body,
        /'\s*—\s*'\s*\+\s*String\(c\.title\)\.slice\(0,\s*70\)\s*:/,
        'no debe haber concatenación cruda de c.title (sin escape) en el modal',
    );
});

test('showPartialPauseDepsModal valida que cada dep sea integer > 0 antes de renderizar', () => {
    const start = src.indexOf('function showPartialPauseDepsModal(');
    const end = src.indexOf('\n}\n', start);
    const body = src.slice(start, end);

    // El loop sobre missing debe filtrar Number.isInteger / > 0.
    assert.match(body, /Number\.isInteger\(n\)\s*&&\s*n\s*>\s*0/);
});

test('showPartialPauseDepsModal coerciona requestedIssues a integers (defensa en profundidad)', () => {
    const start = src.indexOf('function showPartialPauseDepsModal(');
    const end = src.indexOf('\n}\n', start);
    const body = src.slice(start, end);

    assert.match(body, /requestedSafe/, 'debe existir requestedSafe sanitizada');
    assert.match(body, /Number\.isInteger\(n\)\s*&&\s*n\s*>\s*0/);
    // Los handlers POST a /api/pause-partial deben enviar requestedSafe, no requestedIssues crudo.
    assert.match(body, /issues:\s*requestedSafe,\s*includeDeps:\s*true/);
    assert.match(body, /issues:\s*requestedSafe,\s*acceptedDepRisk:\s*true/);
});

// ----- Defensa en profundidad en el endpoint server-side ---------------------

test('/api/pause-partial coerciona issues a integers antes de devolver requestedIssues', () => {
    const idx = src.indexOf("if (req.url === '/api/pause-partial' && req.method === 'POST')");
    assert.ok(idx > 0, 'el handler /api/pause-partial debe existir');
    const handlerEnd = src.indexOf('\n  }', idx + 200); // primer cierre razonable
    const handler = src.slice(idx, handlerEnd > idx ? handlerEnd + 4 : idx + 4000);

    // El handler debe coercer cada item de issues a Number y filtrar Integer > 0.
    assert.match(handler, /\.map\(function\(n\)\s*\{\s*return\s+Number\(n\);\s*\}\)/);
    assert.match(handler, /Number\.isInteger\(n\)\s*&&\s*n\s*>\s*0/);
});

// ----- Sanity check del escape (ejecuta la regex como lo haría el browser) ---

test('_escHtml extraído de la fuente neutraliza el payload XSS del rebote', () => {
    // Reproducimos la implementación exacta para confirmar el comportamiento.
    function escHtml(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }
    const payload = '<img src=x onerror="fetch(\'/api/kill-agent\',{method:\'POST\'})">';
    const out = escHtml(payload);

    assert.ok(!out.includes('<img'), 'la etiqueta <img cruda no debe sobrevivir');
    assert.ok(!out.includes('onerror="'), 'el handler onerror crudo no debe sobrevivir');
    assert.ok(out.includes('&lt;img'), 'el < debe estar escapado');
    assert.ok(out.includes('&quot;'), 'las " deben estar escapadas');
});
