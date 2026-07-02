'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { filterPendientesByWave } = require('../cola-wave-filter');

// Helper: arma entradas `[num, data]` como las produce la matriz del dashboard.
const entry = (num, extra = {}) => [num, { title: `Issue #${num}`, ...extra }];

test('filtra issue de ola futura fuera de la cola (Gherkin 1)', () => {
    // Ola activa 8.2 con #4300; #4350 reservado para ola 8.3.
    const pendientesList = [entry(4300), entry(4350)];
    const result = filterPendientesByWave(pendientesList, [4300]);
    const nums = result.map(([num]) => Number(num));
    assert.deepEqual(nums, [4300]);
    assert.ok(!nums.includes(4350), '#4350 (ola futura) no debe aparecer en la cola');
});

test('mantiene issue de la ola activa en la cola (Gherkin 2)', () => {
    const pendientesList = [entry(4300)];
    const result = filterPendientesByWave(pendientesList, [4300]);
    assert.equal(result.length, 1);
    assert.equal(Number(result[0][0]), 4300);
});

test('degrada a cola vacía cuando la ola activa no resuelve (CA-4, Opción A)', () => {
    const pendientesList = [entry(4300), entry(4350)];
    // waveIssues vacío == resolver falló/degradó. Fail-safe: NUNCA "mostrar todos".
    assert.deepEqual(filterPendientesByWave(pendientesList, []), []);
    assert.deepEqual(filterPendientesByWave(pendientesList, null), []);
    assert.deepEqual(filterPendientesByWave(pendientesList, undefined), []);
});

test('compara ids como número aunque las keys sean string (CA-2, robustez de tipos)', () => {
    // waves.json mezcla {number} e int plano; las keys de matrixEntries pueden
    // llegar como string. El filtro debe machear "4300" contra 4300.
    const pendientesList = [entry('4300'), entry('4350')];
    const result = filterPendientesByWave(pendientesList, [4300]);
    assert.equal(result.length, 1);
    assert.equal(String(result[0][0]), '4300');
});

test('tolera pendientesList vacío o nulo sin romper', () => {
    assert.deepEqual(filterPendientesByWave([], [4300]), []);
    assert.deepEqual(filterPendientesByWave(null, [4300]), []);
    assert.deepEqual(filterPendientesByWave(undefined, [4300]), []);
});

test('preserva el orden FIFO de la lista original ya filtrada', () => {
    const pendientesList = [entry(4300), entry(4350), entry(4255)];
    const result = filterPendientesByWave(pendientesList, [4255, 4300]);
    const nums = result.map(([num]) => Number(num));
    // Mantiene el orden de pendientesList (no el de waveIssues).
    assert.deepEqual(nums, [4300, 4255]);
});
