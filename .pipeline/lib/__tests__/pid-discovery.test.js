// pid-discovery — helper de detección de PIDs vivos (#3605 / #3609 deuda técnica).
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { pidAlive } = require('../pid-discovery');

test('pidAlive devuelve true para el proceso actual', () => {
    assert.equal(pidAlive(process.pid), true);
});

test('pidAlive devuelve false para PID inválido (NaN)', () => {
    assert.equal(pidAlive(NaN), false);
});

test('pidAlive devuelve false para PID negativo', () => {
    assert.equal(pidAlive(-1), false);
});

test('pidAlive devuelve false para PID cero', () => {
    assert.equal(pidAlive(0), false);
});

test('pidAlive devuelve false para PID no entero', () => {
    assert.equal(pidAlive(1.5), false);
    assert.equal(pidAlive('abc'), false);
    assert.equal(pidAlive(null), false);
    assert.equal(pidAlive(undefined), false);
});

test('pidAlive devuelve false para PID muy alto (asumido no existente)', () => {
    // PID 2^31 - 1 — al límite del rango de PIDs típico, virtualmente
    // garantizado no asignado.
    assert.equal(pidAlive(2147483647), false);
});
