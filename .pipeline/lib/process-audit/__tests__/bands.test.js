// Copyright (c) 2026 Leonel Larreta
// SPDX-License-Identifier: LicenseRef-Proprietary

'use strict';

// #6809 CA-4 / SEC-6809-10 — bandas congeladas para la dedup de propuestas.

const test = require('node:test');
const assert = require('node:assert/strict');

const { BANDAS, bandOf, referenciaDe } = require('../bands');

test('las bandas están congeladas: ni la tabla ni sus cortes se pueden mutar', () => {
    assert.ok(Object.isFrozen(BANDAS));
    for (const cortes of Object.values(BANDAS)) assert.ok(Object.isFrozen(cortes));
    assert.throws(() => { 'use strict'; BANDAS.pct_costo_fase = [0, 1]; });
});

test('estabilidad: ±2 pp alrededor de un valor medio caen en la misma banda', () => {
    for (const v of [15, 45, 73, 85]) {
        const b = bandOf('pct_tiempo_cero_agentes', v);
        assert.equal(bandOf('pct_tiempo_cero_agentes', v - 2), b, `${v}-2`);
        assert.equal(bandOf('pct_tiempo_cero_agentes', v + 2), b, `${v}+2`);
    }
});

test('misma banda ⇒ misma referencia; banda distinta ⇒ referencia distinta', () => {
    assert.equal(referenciaDe('capacidad', 'pct_tiempo_cero_agentes', 81), 'capacidad:pct_tiempo_cero_agentes:banda-80-90');
    assert.equal(referenciaDe('capacidad', 'pct_tiempo_cero_agentes', 83.4), referenciaDe('capacidad', 'pct_tiempo_cero_agentes', 81));
    assert.notEqual(referenciaDe('capacidad', 'pct_tiempo_cero_agentes', 91), referenciaDe('capacidad', 'pct_tiempo_cero_agentes', 81));
});

test('por encima del último corte la banda es abierta', () => {
    assert.equal(bandOf('horas_cadena_agotada', 1000), 'banda-720-mas');
    assert.equal(bandOf('dias_control_apagado', 14), 'banda-14-30');
});

test('métrica desconocida, valor negativo o no finito ⇒ null (fail-closed)', () => {
    assert.equal(bandOf('metrica_inventada', 10), null);
    assert.equal(bandOf('pct_costo_fase', -1), null);
    assert.equal(bandOf('pct_costo_fase', NaN), null);
    assert.equal(bandOf('pct_costo_fase', '50'), null);
    assert.equal(bandOf('__proto__', 1), null);
    assert.equal(referenciaDe('proceso', 'metrica_inventada', 1), null);
});
