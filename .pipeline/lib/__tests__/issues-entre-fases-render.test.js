'use strict';

// =============================================================================
// #4362 (CA-2) — Render real del chip "En curso / entre fases" en la tarjeta de
// issue. Se valida sobre el markup emitido (no sólo la sintaxis): el estado
// intermedio debe distinguirse de "sin arrancar" (pendiente) y del resto.
// node --test .pipeline/lib/__tests__/issues-entre-fases-render.test.js
// =============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');

const view = require('../../views/dashboard/issues.js');

test('deriveState mapea progressState=entre-fases a un estado propio', () => {
    assert.equal(view.deriveState({ progressState: 'entre-fases' }), 'entre-fases');
    // sin señal de avance → sigue cayendo a "pendiente" (sin arrancar).
    assert.equal(view.deriveState({}), 'pendiente');
    // rebote/bloqueado tienen prioridad sobre entre-fases (no lo pisa).
    assert.equal(view.deriveState({ progressState: 'entre-fases', rebote: true }), 'rebote');
    assert.equal(view.deriveState({ progressState: 'entre-fases', labels: ['blocked:dependencies'] }), 'bloqueado');
});

test('renderIssueCard pinta el chip st-progress con label "En curso" para entre-fases', () => {
    const card = view.renderIssueCard({
        number: 4255, title: 'Épico entre fases', progressState: 'entre-fases',
        faseActual: null, estadoActual: null, labels: [],
    });
    assert.match(card, /st-progress/, 'clase del chip intermedio presente');
    assert.match(card, /En curso/, 'label del chip intermedio presente');
});

test('renderIssueCard de un issue sin avance NO usa el chip intermedio', () => {
    const card = view.renderIssueCard({
        number: 999, title: 'Nunca arrancó', progressState: null,
        faseActual: null, estadoActual: null, labels: [],
    });
    assert.doesNotMatch(card, /st-progress/);
    assert.match(card, /st-pending/, 'sin arrancar sigue siendo pendiente');
});

test('los tres estados producen clases de chip distintas (CA-2)', () => {
    const mk = (p, extra) => view.renderIssueCard(Object.assign({
        number: 1, title: 't', faseActual: null, estadoActual: null, labels: [],
    }, extra || {}, { progressState: p }));
    const sinArrancar = mk(null);            // st-pending
    const entreFases = mk('entre-fases');    // st-progress
    const terminado = view.renderIssueCard({ number: 1, title: 't', labels: [], estadoActual: 'listo' }); // st-ready
    assert.match(sinArrancar, /st-pending/);
    assert.match(entreFases, /st-progress/);
    assert.match(terminado, /st-ready/);
});

test('el CSS del design system define el token .st-progress (teal punteado)', () => {
    assert.match(view.ISSUES_CSS, /\.st-progress\s*\{/);
    assert.match(view.ISSUES_CSS, /border-style:\s*dashed/);
});
