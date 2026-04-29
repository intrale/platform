'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { isCandidate, TITLE_RE, AGENT_LABEL_RE } = require('../migrate-recomendaciones-legacy');

test('isCandidate detecta por titulo [guru], [security], etc.', () => {
    assert.strictEqual(isCandidate({ number: 1, title: '[guru] revisar X', labels: [] }), true);
    assert.strictEqual(isCandidate({ number: 2, title: '[Security] CSRF en endpoint Y', labels: [] }), true);
    assert.strictEqual(isCandidate({ number: 3, title: '[review] separar componente Z', labels: [] }), true);
});

test('isCandidate detecta por label agent:<rol>', () => {
    assert.strictEqual(isCandidate({ number: 4, title: 'mejora UX flow login', labels: [{ name: 'agent:ux' }] }), true);
    assert.strictEqual(isCandidate({ number: 5, title: 'PO sugiere flujo onboarding', labels: ['agent:po'] }), true);
});

test('isCandidate descarta si ya tiene tipo:recomendacion', () => {
    assert.strictEqual(isCandidate({ number: 6, title: '[guru] X', labels: ['tipo:recomendacion'] }), false);
});

test('isCandidate descarta si ya está aprobado o rechazado', () => {
    assert.strictEqual(isCandidate({ number: 7, title: '[ux] flow', labels: ['recommendation:approved'] }), false);
    assert.strictEqual(isCandidate({ number: 8, title: '[ux] flow', labels: ['recommendation:rejected'] }), false);
});

test('isCandidate descarta issues normales sin marca de agente', () => {
    assert.strictEqual(isCandidate({ number: 9, title: 'fix typo en login', labels: ['bug'] }), false);
    assert.strictEqual(isCandidate({ number: 10, title: 'feature X', labels: [] }), false);
});

test('TITLE_RE acepta corchetes minúscula y mayúscula', () => {
    assert.match('[guru] x', TITLE_RE);
    assert.match('[GURU] x', TITLE_RE);
    assert.doesNotMatch('guru x', TITLE_RE);
    assert.doesNotMatch('[other] x', TITLE_RE);
});

test('AGENT_LABEL_RE matchea solo agent:<rol_valido>', () => {
    assert.match('agent:guru', AGENT_LABEL_RE);
    assert.match('agent:po', AGENT_LABEL_RE);
    assert.doesNotMatch('agent:builder', AGENT_LABEL_RE);
    assert.doesNotMatch('builder', AGENT_LABEL_RE);
});
