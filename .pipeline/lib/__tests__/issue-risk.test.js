'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { computeRisk } = require('../issue-risk');

test('sin condiciones → bajo, sin razones', () => {
    const r = computeRisk({ bounces: 0, ageMin: 10, ageP90: 100, labels: [] });
    assert.strictEqual(r.level, 'bajo');
    assert.deepStrictEqual(r.reasons, []);
});

test('regla rebotes ≥2 dispara medio con razón textual', () => {
    const r = computeRisk({ bounces: 2, ageMin: 10, ageP90: 100, labels: [] });
    assert.strictEqual(r.level, 'medio');
    assert.deepStrictEqual(r.reasons, ['2 rebotes (>=2)']);
});

test('1 solo rebote NO dispara la regla', () => {
    const r = computeRisk({ bounces: 1, ageMin: 10, ageP90: 100, labels: [] });
    assert.strictEqual(r.level, 'bajo');
    assert.deepStrictEqual(r.reasons, []);
});

test('regla edad > p90 dispara medio con texto de edad y p90', () => {
    const r = computeRisk({ bounces: 0, ageMin: 312, ageP90: 210, labels: [] });
    assert.strictEqual(r.level, 'medio');
    assert.deepStrictEqual(r.reasons, ['edad 312m > p90 (210m)']);
});

test('regla dependencia abierta dispara medio', () => {
    const r = computeRisk({ bounces: 0, ageMin: 10, ageP90: 100, labels: ['blocked:dependencies'] });
    assert.strictEqual(r.level, 'medio');
    assert.deepStrictEqual(r.reasons, ['dependencia abierta']);
});

test('mezcla rebotes≥2 + edad>p90 dispara alto con 2 razones', () => {
    const r = computeRisk({ bounces: 3, ageMin: 500, ageP90: 200, labels: [] });
    assert.strictEqual(r.level, 'alto');
    assert.strictEqual(r.reasons.length, 2);
    assert.ok(r.reasons[0].includes('3 rebotes'));
    assert.ok(r.reasons[1].includes('> p90'));
});

test('las 3 reglas → alto con 3 razones', () => {
    const r = computeRisk({ bounces: 2, ageMin: 500, ageP90: 200, labels: ['blocked:dependencies'] });
    assert.strictEqual(r.level, 'alto');
    assert.strictEqual(r.reasons.length, 3);
});

test('score es ordenable: alto > medio > bajo', () => {
    const bajo = computeRisk({ bounces: 0, ageMin: 1, ageP90: 100 }).score;
    const medio = computeRisk({ bounces: 2, ageMin: 1, ageP90: 100 }).score;
    const alto = computeRisk({ bounces: 2, ageMin: 500, ageP90: 100 }).score;
    assert.ok(medio > bajo, 'medio debe ser mayor que bajo');
    assert.ok(alto > medio, 'alto debe ser mayor que medio');
});

test('ageP90 = Infinity (sin población) nunca dispara la regla de edad', () => {
    const r = computeRisk({ bounces: 0, ageMin: 99999, ageP90: Infinity });
    assert.strictEqual(r.level, 'bajo');
});

test('defensivo: input vacío / inválido no rompe', () => {
    assert.strictEqual(computeRisk().level, 'bajo');
    assert.strictEqual(computeRisk({ bounces: NaN, ageMin: NaN }).level, 'bajo');
    assert.strictEqual(computeRisk({ labels: null }).level, 'bajo');
});
