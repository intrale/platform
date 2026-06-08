// =============================================================================
// wizard-ola.test.js — Tests de la vista SSR del wizard "Crear nueva ola" (#3738).
//
// Verifica el contrato visual mínimo: 3 pasos, tooltips presentes, botón "Atrás",
// CSRF embebido y escapado, y que el preview escapa todo dato dinámico (R7/XSS).
//
// Ejecutar:  node --test .pipeline/views/dashboard/__tests__/wizard-ola.test.js
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const view = require('../wizard-ola');

test('renderWizardOla emite los 3 pasos con tooltips y botón Atrás', () => {
    const html = view.renderWizardOla({ csrfToken: 'abc123' });
    // 3 secciones de paso.
    assert.match(html, /data-step="1"/);
    assert.match(html, /data-step="2"/);
    assert.match(html, /data-step="3"/);
    // Tooltips presentes (al menos uno por paso → varios botones de ayuda).
    const tipCount = (html.match(/class="wz-tip-btn"/g) || []).length;
    assert.ok(tipCount >= 6, `esperaba >=6 tooltips, hubo ${tipCount}`);
    // Botón Atrás y Siguiente.
    assert.match(html, /id="wz-back"/);
    assert.match(html, /id="wz-next"/);
    // Stepper con 3 dots.
    assert.equal((html.match(/class="wz-dot/g) || []).length, 3);
});

test('renderWizardOla embebe el CSRF token escapado en el meta', () => {
    const html = view.renderWizardOla({ csrfToken: 'tok"<inject>' });
    // El token va en <meta name="csrf-token"> y debe estar escapado.
    assert.match(html, /<meta name="csrf-token"/);
    assert.ok(!html.includes('tok"<inject>'), 'el token crudo no debe aparecer sin escapar');
    assert.ok(html.includes('tok&quot;&lt;inject&gt;'), 'el token debe estar escapado');
});

test('renderWizardOla apunta al step API correcto del flow ola', () => {
    const html = view.renderWizardOla({ csrfToken: 'x' });
    assert.match(html, /\/dashboard\/wizard\/ola\/step/);
});

test('renderPreview escapa el nombre y los issues (R7/XSS, bytes literales)', () => {
    const evil = '<script>alert(1)</script>';
    const html = view.renderPreview({ name: evil, issues: [3801, 3802], concurrencia: 3, ventana_minutos: 60 });
    // Nunca debe aparecer el <script> crudo.
    assert.ok(!html.includes('<script>alert(1)</script>'), 'el payload XSS no debe emitirse crudo');
    // Debe aparecer escapado.
    assert.ok(html.includes('&lt;script&gt;'), 'el nombre debe estar escapado');
    // Los issues se muestran.
    assert.match(html, /#3801/);
    assert.match(html, /#3802/);
});

test('renderPreview tolera datos vacíos sin romper', () => {
    const html = view.renderPreview({});
    assert.match(html, /Sin issues seleccionados/);
});

test('STEP_DEFS define exactamente 3 pasos con título y tooltips', () => {
    assert.equal(view.STEP_DEFS.length, 3);
    for (const d of view.STEP_DEFS) {
        assert.ok(typeof d.title === 'string' && d.title.length > 0);
        assert.ok(Array.isArray(d.tooltips) && d.tooltips.length >= 1);
    }
});

test('renderTooltip escapa label y body', () => {
    const html = view.renderTooltip('Etiqueta <x>', 'Cuerpo & "peligroso"');
    assert.ok(!html.includes('<x>'));
    assert.ok(html.includes('&lt;x&gt;'));
    assert.ok(html.includes('&amp;'));
});
