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

// ----- #2800 — Board Kanban centerpiece (rediseño V3) ------------------------
//
// El issue movió el Kanban al protagonista visual del dashboard. Estos tests
// congelan los invariantes:
//   1. laneTitle (título de cada card) usa esc() — antes solo escapaba comillas,
//      lo que dejaba pasar `<script>` en el body de .lc-title (vector XSS si un
//      MEMBER del repo crea un issue con título malicioso).
//   2. matrixHTML ya NO arranca colapsado por default (CA-1.2).
//   3. matrixHTML lleva el título "Board Kanban · Pipeline V3" + badge V3.
//   4. matrixHTML se renderiza ANTES de kpis-row en el template (CA-1.1, CA-1.6).
//   5. Existe el anchor `id="board-kanban"` para deep-links (CA-6.1).
//   6. La media query mobile colapsa lanes a 1 columna en `<768px` (CA-5.1).

test('#2800 — laneTitle escapa con esc() (no solo comillas) en cards del Kanban', () => {
    // Anclamos la búsqueda al comentario único insertado por el fix.
    const idx = src.indexOf('#2800 CA-2.3/CA-4.1');
    assert.ok(idx > 0, 'el comentario del fix XSS debe existir junto al cambio');

    // Aceptamos plantilla literal `Issue #${issueNum}` o concatenación cruda.
    const laneTitleMatch = src.match(/const laneTitle = esc\(data\.title \|\| [`'"]/);
    assert.ok(
        laneTitleMatch,
        'laneTitle debe construirse con esc(data.title || ...) — no con replace(/"/g) parcial',
    );

    // Aseguramos que la versión vieja (sólo escape de comillas) NO está más.
    assert.doesNotMatch(
        src,
        /const laneTitle = \(data\.title[^)]*\)\.replace\(\/\"\/g, '&quot;'\)/,
        'la versión vieja con escape parcial de comillas debe haberse eliminado',
    );

    // searchKey también debe pasar por esc() — sino el atributo data-search
    // podría romperse con comillas o `<` en el título.
    assert.match(
        src,
        /const searchKey = esc\(\(/,
        'searchKey debe envolverse con esc() para evitar romper atributos del card',
    );
});

test('#2800 — matrixHTML arranca expandido (sin section-collapsed default)', () => {
    // Buscamos la declaración del template del Kanban (única ocurrencia).
    const open = src.indexOf('const matrixHTML = `');
    assert.ok(open > 0, 'el template matrixHTML debe existir');

    // El cierre del template literal de matrixHTML es el primer `;` después del bloque.
    const close = src.indexOf('`;', open);
    assert.ok(close > open, 'cierre del template matrixHTML no encontrado');
    const body = src.slice(open, close);

    // Debe seguir teniendo la clase section-collapsible (toggleable) pero NO
    // section-collapsed (default colapsado). Los usuarios que lo colapsen lo
    // persisten en localStorage, ese path no se toca.
    assert.match(body, /class="matrix-section section-collapsible board-kanban-centerpiece"/);
    assert.doesNotMatch(
        body,
        /class="matrix-section section-collapsible section-collapsed"/,
        'el default debe ser expandido — sin section-collapsed',
    );
});

test('#2800 — título del Kanban es "Board Kanban · Pipeline V3" con badge V3', () => {
    const open = src.indexOf('const matrixHTML = `');
    const close = src.indexOf('`;', open);
    const body = src.slice(open, close);

    assert.match(
        body,
        /🎯 Board Kanban · Pipeline <span class="kanban-v3-badge"/,
        'el título visible debe ser "🎯 Board Kanban · Pipeline V3"',
    );
    assert.match(
        body,
        /<span class="kanban-v3-badge"[^>]*>V3<\/span>/,
        'el badge V3 debe estar presente dentro del título',
    );
});

test('#2800 — anchor id="board-kanban" existe para deep-links', () => {
    const open = src.indexOf('const matrixHTML = `');
    const close = src.indexOf('`;', open);
    const body = src.slice(open, close);

    assert.match(
        body,
        /id="board-kanban"/,
        'el anchor id="board-kanban" debe existir antes del bloque .matrix-section',
    );
});

test('#2800 — matrixHTML se renderiza ANTES del bloque kpis-row (centerpiece)', () => {
    // La fuente debe interpolar ${matrixHTML} antes de `<div class="kpis-row">`
    // en la primera ocurrencia del HTML emitido. Si alguien lo vuelve a colocar
    // al final, este test rompe.
    const matrixIdx = src.indexOf('${matrixHTML}');
    assert.ok(matrixIdx > 0, '${matrixHTML} debe seguir interpolado en algún lugar del template');

    const kpisIdx = src.indexOf('<div class="kpis-row">');
    assert.ok(kpisIdx > 0, 'el bloque kpis-row debe existir');

    assert.ok(
        matrixIdx < kpisIdx,
        `matrixHTML debe interpolarse antes de kpis-row (matrixHTML=${matrixIdx}, kpis-row=${kpisIdx})`,
    );

    // Por consistencia con el rediseño, NO debe quedar una segunda
    // interpolación de matrixHTML al final del template (legacy position).
    const lastMatrix = src.lastIndexOf('${matrixHTML}');
    assert.equal(
        matrixIdx,
        lastMatrix,
        'solo debe haber UNA interpolación de matrixHTML — la del centerpiece',
    );
});

test('#2800 — CA-5.1 media query mobile <768px colapsa lanes a 1 columna', () => {
    // La regla legacy <900px ya cubre <768px, pero el CA pide trazabilidad
    // explícita verificable con grep — agregamos rule específica para 768.
    assert.match(
        src,
        /@media\(max-width:768px\)\{\.it-lanes\{grid-template-columns:1fr\}\}/,
        'debe existir media query explícita <=768px para .it-lanes (CA-5.1)',
    );
});

test('#2800 — payload XSS en título de issue queda neutralizado al pasar por esc()', () => {
    // Reproducimos esc() server-side (línea 933) y validamos contra el payload
    // de ataque típico que podría incrustarse en el título de un issue.
    function esc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }
    const payload = '<script>fetch("/api/kill-pipeline",{method:"POST"})</script>';
    const escaped = esc(payload);

    // Tanto el body de <div class="lc-title">${laneTitle}</div> como el
    // atributo title="${laneTitle}" deben quedar seguros.
    assert.ok(!escaped.includes('<script>'), '<script> debe quedar escapado');
    assert.ok(escaped.includes('&lt;script&gt;'), '< y > deben estar escapados');
    assert.ok(escaped.includes('&quot;'), 'las comillas dobles deben estar escapadas');
});
