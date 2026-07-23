// .pipeline/lib/confidence-index.test.js
// Tests node --test de la descomposición de confianza (#4576, CA-1/CA-2).
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const {
    decomposeConfidence,
    esTotalmenteMaquinaVerificable,
    contarSoloHumanos,
    CONFIANZA,
    FUENTE,
} = require('./confidence-index');

// ----------------------------------------------------------------------------
// CA-1 · Descomposición sin blend: array, nunca un escalar `confianza_total`.
// ----------------------------------------------------------------------------

test('CA-1 · el payload es un array, no un escalar agregado', () => {
    const index = decomposeConfidence({
        criterios: [
            'CA real verificable con node --test',
            'build compila con ./gradlew build',
        ],
        gateResults: {
            'CA real verificable con node --test': 'pass',
            'build compila con ./gradlew build': 'pass',
        },
    });
    assert.ok(Array.isArray(index), 'debe ser array');
    assert.strictEqual(index.length, 2);
    // No existe ningún campo escalar `confianza_total` en la salida.
    assert.strictEqual(index.confianza_total, undefined);
    for (const item of index) {
        assert.strictEqual(item.confianza_total, undefined,
            'ningún ítem debe exponer confianza_total');
        assert.ok('criterio' in item);
        assert.ok('confianza' in item);
        assert.ok('fuente' in item);
        assert.ok('maquina_verificable' in item);
        assert.ok('contribucion_autonomia' in item);
    }
});

test('CA-1 · criterio máquina-verificable con gate pass ⇒ confianza alta', () => {
    const [item] = decomposeConfidence({
        criterios: [{ key: 'k1', text: 'verificable con ./gradlew test' }],
        gateResults: { k1: 'pass' },
    });
    assert.strictEqual(item.maquina_verificable, true);
    assert.strictEqual(item.confianza, CONFIANZA.ALTA);
    assert.strictEqual(item.fuente, FUENTE.EVIDENCIA_MAQUINA);
    assert.strictEqual(item.contribucion_autonomia, 1);
});

test('CA-1 · máquina-verificable con gate fail ⇒ confianza baja, contribución 0', () => {
    const [item] = decomposeConfidence({
        criterios: [{ key: 'k1', text: 'verificable con node --test' }],
        gateResults: { k1: 'fail' },
    });
    assert.strictEqual(item.maquina_verificable, true);
    assert.strictEqual(item.confianza, CONFIANZA.BAJA);
    assert.strictEqual(item.contribucion_autonomia, 0);
});

test('CA-1 · máquina-verificable sin resultado de gate ⇒ desconocida, contribución 0', () => {
    const [item] = decomposeConfidence({
        criterios: [{ key: 'k1', text: 'verificable con node --test' }],
        gateResults: {},
    });
    assert.strictEqual(item.maquina_verificable, true);
    assert.strictEqual(item.confianza, CONFIANZA.DESCONOCIDA);
    assert.strictEqual(item.contribucion_autonomia, 0);
});

// ----------------------------------------------------------------------------
// CA-2 · Honestidad máquina vs humano: solo-humano ⇒ contribución EXACTAMENTE 0.
// ----------------------------------------------------------------------------

test('CA-2 · criterio solo-humano ⇒ contribución 0 aunque el gate diga pass', () => {
    const [item] = decomposeConfidence({
        criterios: [{ key: 'visual', text: 'el header coincide con el mockup acordado' }],
        // Intento malicioso: forzar un pass sobre un criterio solo-humano.
        gateResults: { visual: 'pass' },
    });
    assert.strictEqual(item.maquina_verificable, false);
    assert.strictEqual(item.confianza, CONFIANZA.DESCONOCIDA);
    assert.strictEqual(item.fuente, FUENTE.SOLO_HUMANO);
    // Enforcement estructural: NUNCA contribuye, sin importar el gateResult.
    assert.strictEqual(item.contribucion_autonomia, 0);
});

test('CA-2 · criterio ambiguo/vacío ⇒ solo-humano (fail-closed) contribución 0', () => {
    const index = decomposeConfidence({
        criterios: ['', { text: 'algo lindo y prolijo sin señal máquina' }],
    });
    for (const item of index) {
        assert.strictEqual(item.maquina_verificable, false);
        assert.strictEqual(item.contribucion_autonomia, 0);
    }
});

// ----------------------------------------------------------------------------
// Señales estructurales derivadas
// ----------------------------------------------------------------------------

test('esTotalmenteMaquinaVerificable true solo si todos son máquina', () => {
    const todosMaquina = decomposeConfidence({
        criterios: [
            { key: 'a', text: 'node --test verde' },
            { key: 'b', text: 'el archivo src/x.kt:10 existe' },
        ],
        gateResults: { a: 'pass', b: 'pass' },
    });
    assert.strictEqual(esTotalmenteMaquinaVerificable(todosMaquina), true);

    const conHumano = decomposeConfidence({
        criterios: [
            { key: 'a', text: 'node --test verde' },
            { key: 'v', text: 'coincide con el mockup visual' },
        ],
        gateResults: { a: 'pass' },
    });
    assert.strictEqual(esTotalmenteMaquinaVerificable(conHumano), false);
});

test('esTotalmenteMaquinaVerificable false para índice vacío (fail-closed)', () => {
    assert.strictEqual(esTotalmenteMaquinaVerificable([]), false);
    assert.strictEqual(esTotalmenteMaquinaVerificable(null), false);
});

test('contarSoloHumanos cuenta correctamente', () => {
    const index = decomposeConfidence({
        criterios: [
            { key: 'a', text: 'node --test verde' },
            { key: 'v', text: 'coincide con el mockup' },
            { key: 'u', text: 'la UX se siente prolija' },
        ],
        gateResults: { a: 'pass' },
    });
    assert.strictEqual(contarSoloHumanos(index), 2);
});

test('decomposeConfidence con criterios vacíos devuelve []', () => {
    assert.deepStrictEqual(decomposeConfidence({}), []);
    assert.deepStrictEqual(decomposeConfidence({ criterios: null }), []);
});
