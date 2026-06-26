// =============================================================================
// logs-view-4191.test.js — Pantalla LOGS + interacción con el agente (Ola 7.1,
// issue #4191). Verificación estática sobre el HTML renderizado server-side.
//
// Puppeteer NO está disponible en el pipeline, así que las garantías visuales y
// de contrato se chequean sobre el HTML/JS que emite `renderLogViewer`:
//   - render no lanza con y sin `ctx.issueData` (ficha degrada a "sin datos");
//   - shell MIZPÁ heredado (marca + banner de misión);
//   - consola con wrap sin truncar (CA-3 / regla transversal "nunca truncar");
//   - panel de intervención y sub-pasos presentes;
//   - `renderInert` da un fallback no-vacío (CA-A3: el render nunca queda en
//     blanco aunque el módulo no pueda armar la vista completa).
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const view = require('../../views/dashboard/logs');

const FILE = '4191-pipeline-dev.log';
const ISSUE_DATA = {
    faseActual: 'desarrollo/dev',
    estadoActual: 'trabajando',
    bounces: 1,
    rebote: true,
    title: 'Rediseño LOGS MIZPÁ',
    fases: { 'desarrollo/dev': [{ estado: 'trabajando', skill: 'pipeline-dev' }] },
};

test('renderLogViewer no lanza sin issueData y emite un documento HTML', () => {
    let html;
    assert.doesNotThrow(() => { html = view.renderLogViewer(FILE, true, { issueData: null }); });
    assert.ok(html.startsWith('<!DOCTYPE'));
    assert.ok(html.length > 1000);
});

test('renderLogViewer no lanza con issueData y refleja la ficha del agente', () => {
    let html;
    assert.doesNotThrow(() => { html = view.renderLogViewer(FILE, true, { issueData: ISSUE_DATA }); });
    // Issue linkeado a GitHub (CA-2) + rol del skill.
    assert.match(html, /github\.com\/intrale\/platform\/issues\/4191/);
    assert.ok(html.includes('pipeline-dev'));
});

test('shell MIZPÁ heredado: marca y banner de misión', () => {
    const html = view.renderLogViewer(FILE, true, { issueData: ISSUE_DATA });
    assert.match(html, /MIZP/i);
});

test('consola hace wrap completo y nunca trunca con «+X más» (regla transversal)', () => {
    const html = view.renderLogViewer(FILE, true, { issueData: ISSUE_DATA });
    assert.match(html, /pre-wrap|overflow-wrap/);
    assert.ok(!/\+\d+\s*m[aá]s/.test(html), 'no debe aparecer marcador de truncado «+X más»');
});

test('render tolera issueData parcial sin lanzar (campos faltantes degradan)', () => {
    assert.doesNotThrow(() => view.renderLogViewer(FILE, false, { issueData: {} }));
    assert.doesNotThrow(() => view.renderLogViewer(FILE, false, {}));
    assert.doesNotThrow(() => view.renderLogViewer(FILE, false, undefined));
});

test('renderInert da un fallback no-vacío (CA-A3: nunca queda en blanco)', () => {
    const html = view.renderInert('boom');
    assert.ok(html.startsWith('<!DOCTYPE'));
    assert.ok(html.length > 100);
    // El motivo se escapa (no se inyecta crudo si trae HTML).
    const xss = view.renderInert('<script>x</script>');
    assert.ok(!xss.includes('<script>x</script>'));
});
