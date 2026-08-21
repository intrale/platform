// #6117 CA-UX-5 / regla P6 — la línea "Última auto-reparación" de la vista
// Pipeline debe mover TRES canales cuando supera el umbral: color, texto y
// GLYPH. Nunca sólo color.
//
// Por qué existe este archivo: la primera implementación de #6117 cambiaba
// color y texto pero dejaba el mismo <use href="#ic-transition-history"> en los
// dos estados, y ningún test cubría la línea, así que la regresión llegó hasta
// verificación. UX fijó la regla dos veces (P6 y UX-6) y el mockup normativo
// 02-dashboard-ultima-auto-reparacion.png dibuja un triángulo de warning.
//
// Se evalúa contra el código fuente como string, mismo enfoque que
// dashboard-pipeline-blocked-badge.js y dashboard-pipeline-allowlist.test.js:
// falla en CI si el contrato desaparece o se degrada a "sólo color".

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const REDESIGN_PATH = path.join(__dirname, '..', 'views', 'dashboard', 'pipeline-redesign.js');
const redesign = require(REDESIGN_PATH);

const PR_CLIENT = redesign.pipelineRedesignClientScript();
const PR_BODY = redesign.renderPipelineRedesignBody();
const PR_CSS = redesign.PIPELINE_REDESIGN_CSS;

const SPRITE = fs.readFileSync(
    path.join(__dirname, '..', 'assets', 'icons', 'sprite.svg'),
    'utf8',
);

// ───────────── Los dos símbolos existen en el sprite ─────────────

test('el sprite expone los dos glyphs de la línea (sin crear íconos nuevos)', () => {
    assert.match(SPRITE, /<symbol id="ic-transition-history"/, 'glyph del estado base (histórico)');
    assert.match(SPRITE, /<symbol id="ic-warn"/, 'glyph del estado de umbral superado (triángulo)');
});

test('#ic-warn es un triángulo, como pide el mockup normativo', () => {
    const start = SPRITE.indexOf('<symbol id="ic-warn"');
    const symbol = SPRITE.slice(start, SPRITE.indexOf('</symbol>', start));
    // Triángulo: path cerrado (Z) de 3 vértices, no un círculo ni un rombo.
    assert.match(symbol, /\bZ"/, '#ic-warn debe ser un path cerrado (triángulo)');
    assert.doesNotMatch(symbol, /<circle[^>]*r="(?:[89]|1\d)/, '#ic-warn no debe ser un ícono circular');
});

// ───────────── El SSR arranca en el estado base y deja el hook ─────────────

test('el <use> de la línea tiene id para que la hidratación pueda cambiarlo', () => {
    assert.match(
        PR_BODY,
        /<use id="pl-autorepair-ic-use" href="#ic-transition-history">/,
        'sin id, plAutoRepairGlyph no tiene a qué agarrarse y el glyph queda congelado',
    );
});

test('el SSR arranca en el glyph base: el empty-state nunca es warn', () => {
    assert.doesNotMatch(PR_BODY, /pl-autorepair-row[^>]*>[\s\S]{0,200}#ic-warn/,
        'el estado inicial servido no debe pintar el triángulo de warning');
});

// ───────────── P6: el warn mueve color + texto + glyph ─────────────

test('plRenderAutoRepair cambia el GLYPH cuando severidad === warn (P6)', () => {
    assert.match(PR_CLIENT, /const PL_AUTOREPAIR_IC_WARN\s*=\s*'#ic-warn'/,
        'debe existir el glyph de warning como destino explícito');
    assert.match(PR_CLIENT, /const PL_AUTOREPAIR_IC_BASE\s*=\s*'#ic-transition-history'/,
        'debe existir el glyph base como destino explícito');
    assert.match(
        PR_CLIENT,
        /warn\s*\?\s*PL_AUTOREPAIR_IC_WARN\s*:\s*PL_AUTOREPAIR_IC_BASE/,
        'el glyph debe seleccionarse a partir del flag de warn',
    );
    assert.match(
        PR_CLIENT,
        /use\.setAttribute\('href',\s*href\)/,
        'el intercambio se aplica sobre el atributo href del <use>',
    );
});

test('plAutoRepairGlyph se invoca en los tres caminos de plRenderAutoRepair', () => {
    const start = PR_CLIENT.indexOf('function plRenderAutoRepair');
    assert.ok(start > -1, 'plRenderAutoRepair debe existir');
    const body = PR_CLIENT.slice(start, start + 900);
    // Empty-state → glyph base; con dato → glyph según severidad.
    assert.match(body, /plAutoRepairGlyph\(false\)/, 'el empty-state debe volver al glyph base');
    assert.match(body, /plAutoRepairGlyph\(warn\)/, 'el caso con dato debe propagar la severidad al glyph');
});

test('el warn NO se transmite sólo por color: color, texto y glyph se mueven juntos', () => {
    const start = PR_CLIENT.indexOf('function plRenderAutoRepair');
    const body = PR_CLIENT.slice(start, start + 900);
    assert.match(body, /const warn\s*=\s*p\.severidad\s*===\s*'warn'/, 'un único origen de verdad para el estado warn');
    // canal color
    assert.match(body, /classList\.toggle\('pl-autorepair-warn',\s*warn\)/, 'canal color');
    // canal texto (viene resuelto del slice, no se redacta en el browser)
    assert.match(body, /setText\('pl-autorepair',\s*p\.texto\)/, 'canal texto');
    // canal glyph
    assert.match(body, /plAutoRepairGlyph\(warn\)/, 'canal glyph');
});

test('plAutoRepairGlyph es defensivo y no reescribe el href en cada tick', () => {
    const start = PR_CLIENT.indexOf('function plAutoRepairGlyph');
    assert.ok(start > -1, 'plAutoRepairGlyph debe existir');
    const body = PR_CLIENT.slice(start, PR_CLIENT.indexOf('function plRenderAutoRepair'));
    assert.match(body, /if\(!use\)\s*return;/, 'sin el nodo no debe explotar (la vista se hidrata en varios ticks)');
    assert.match(body, /getAttribute\('href'\)\s*!==\s*href/, 'sólo escribe si cambió: el tick es cada 5s');
});

// ───────────── El CSS del warn sigue en pie ─────────────

test('la clase de warn sigue existiendo y usa --warning', () => {
    assert.match(PR_CSS, /\.pl-autorepair-warn\s*\{[^}]*var\(--warning/, 'canal color vía --warning');
});

test('los dos glyphs heredan el color con currentColor', () => {
    assert.match(PR_CSS, /\.pl-autorepair-ic\s*\{[^}]*currentColor/,
        'el ícono debe seguir a currentColor para que el --warning lo alcance sin regla extra');
});
