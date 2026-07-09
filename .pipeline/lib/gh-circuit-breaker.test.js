'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { createGhCircuitBreaker, isConnError } = require('./gh-circuit-breaker');

test('isConnError distingue conexión de negocio', () => {
    assert.equal(isConnError('error connecting to api.github.com'), true);
    assert.equal(isConnError({ code: 'ENOTFOUND' }), true);
    assert.equal(isConnError({ code: 'GH_CALL_TIMEOUT' }), true);
    assert.equal(isConnError({ message: 'could not resolve host' }), true);
    // Negocio: NO cuenta
    assert.equal(isConnError({ message: 'HTTP 404: Not Found' }), false);
    assert.equal(isConnError({ message: 'Resource not accessible' }), false);
    assert.equal(isConnError(null), false);
});

test('abre tras N fallos de conexión consecutivos y cortocircuita en cooldown', () => {
    const b = createGhCircuitBreaker({ threshold: 3, cooldownMs: 1000 });
    let t = 0;
    // 2 fallos: aún cerrado
    b.record({ ok: false, error: { code: 'ENOTFOUND' } }, t);
    b.record({ ok: false, error: { code: 'ENOTFOUND' } }, t);
    assert.equal(b.shouldShortCircuit(t), false, 'con 2 fallos sigue cerrado');
    // 3er fallo: abre
    b.record({ ok: false, error: { message: 'error connecting to api.github.com' } }, t);
    assert.equal(b.shouldShortCircuit(t), true, 'con 3 fallos abre y cortocircuita');
    assert.equal(b.getState(t).open, true);
    // dentro del cooldown sigue cortando
    assert.equal(b.shouldShortCircuit(t + 500), true);
});

test('half-open: probe exitoso cierra el circuito', () => {
    const b = createGhCircuitBreaker({ threshold: 1, cooldownMs: 1000 });
    b.record({ ok: false, error: { code: 'ETIMEDOUT' } }, 0); // abre (threshold 1)
    assert.equal(b.shouldShortCircuit(0), true);
    // cooldown vencido → deja pasar un probe (no cortocircuita)
    assert.equal(b.shouldShortCircuit(1500), false, 'tras cooldown permite probe');
    // el probe sale bien → cierra
    b.record({ ok: true }, 1500);
    assert.equal(b.shouldShortCircuit(1600), false, 'cerrado tras probe OK');
    assert.equal(b.getState(1600).open, false);
});

test('half-open: probe fallido reabre', () => {
    const b = createGhCircuitBreaker({ threshold: 1, cooldownMs: 1000 });
    b.record({ ok: false, error: { code: 'ETIMEDOUT' } }, 0);
    assert.equal(b.shouldShortCircuit(1500), false); // probe permitido
    b.record({ ok: false, error: { code: 'ETIMEDOUT' } }, 1500); // probe falla
    assert.equal(b.shouldShortCircuit(1600), true, 'reabre tras probe fallido');
});

test('un fallo de NEGOCIO no abre el circuito', () => {
    const b = createGhCircuitBreaker({ threshold: 2, cooldownMs: 1000 });
    b.record({ ok: false, error: { message: 'HTTP 404' } }, 0);
    b.record({ ok: false, error: { message: 'HTTP 404' } }, 0);
    b.record({ ok: false, error: { message: 'HTTP 404' } }, 0);
    assert.equal(b.shouldShortCircuit(0), false, 'los 404 no abren el breaker');
});

test('éxito resetea el contador de fallos', () => {
    const b = createGhCircuitBreaker({ threshold: 3, cooldownMs: 1000 });
    b.record({ ok: false, error: { code: 'ENOTFOUND' } }, 0);
    b.record({ ok: false, error: { code: 'ENOTFOUND' } }, 0);
    b.record({ ok: true }, 0); // reset
    b.record({ ok: false, error: { code: 'ENOTFOUND' } }, 0);
    b.record({ ok: false, error: { code: 'ENOTFOUND' } }, 0);
    assert.equal(b.shouldShortCircuit(0), false, 'el éxito intermedio evita abrir');
});

test('onOpen/onClose se disparan una sola vez', () => {
    let opens = 0, closes = 0;
    const b = createGhCircuitBreaker({
        threshold: 1, cooldownMs: 1000,
        onOpen: () => opens++, onClose: () => closes++,
    });
    b.record({ ok: false, error: { code: 'ENOTFOUND' } }, 0); // abre
    b.record({ ok: false, error: { code: 'ENOTFOUND' } }, 0); // sigue abierto (fuera de probe)
    assert.equal(opens, 1, 'onOpen una vez');
    b.shouldShortCircuit(1500); // probe
    b.record({ ok: true }, 1500); // cierra
    assert.equal(closes, 1, 'onClose una vez');
});
