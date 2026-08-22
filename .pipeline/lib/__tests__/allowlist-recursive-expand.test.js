// =============================================================================
// allowlist-recursive-expand.test.js — Tests del walk recursivo PURO
// `expandRecursiveOpenIssues` (#4350).
//
// La función es pura (sin red / GitHub / TTL): recibe seed + predicados
// inyectados (isClosed, getDeps) y devuelve el set expandido de issues abiertos.
//
// Ejecutar: node --test .pipeline/lib/__tests__/allowlist-recursive-expand.test.js
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { expandRecursiveOpenIssues } = require('../allowlist-recursive-promote');

test('expand: sin deps ni cerrados → devuelve la semilla ordenada y deduplicada', () => {
    const out = expandRecursiveOpenIssues({ seedIssues: [4300, 4255, 4255] });
    assert.deepEqual(out, [4255, 4300]);
});

test('expand: incluye recursivamente deps/bloqueos', () => {
    // 4255 bloqueado por 4200; 4200 bloqueado por 4100.
    const graph = { 4255: [4200], 4200: [4100], 4100: [] };
    const getDeps = (n) => graph[n] || [];
    const out = expandRecursiveOpenIssues({ seedIssues: [4255], getDeps });
    assert.deepEqual(out, [4100, 4200, 4255]);
});

test('expand: excluye issues CONFIRMADOS cerrados', () => {
    const graph = { 4255: [4200], 4200: [] };
    const getDeps = (n) => graph[n] || [];
    const isClosed = (n) => n === 4200; // dep cerrada
    const out = expandRecursiveOpenIssues({ seedIssues: [4255], getDeps, isClosed });
    assert.deepEqual(out, [4255]);
});

test('expand: fail-safe SEC-4 — estado indeterminado (undefined) NO se excluye', () => {
    const isClosed = (n) => (n === 4300 ? undefined : false); // 4300 indeterminado
    const out = expandRecursiveOpenIssues({ seedIssues: [4255, 4300], isClosed });
    assert.deepEqual(out, [4255, 4300]);
});

test('expand: un cerrado NO expande su subgrafo (no revive cadenas cerradas)', () => {
    const graph = { 4255: [4200], 4200: [9999] };
    const getDeps = (n) => graph[n] || [];
    const isClosed = (n) => n === 4200; // 4200 cerrado → su dep 9999 no entra
    const out = expandRecursiveOpenIssues({ seedIssues: [4255], getDeps, isClosed });
    assert.deepEqual(out, [4255]);
});

test('expand: corta ciclos en el grafo de deps', () => {
    const graph = { 1: [2], 2: [3], 3: [1] }; // ciclo
    const getDeps = (n) => graph[n] || [];
    const out = expandRecursiveOpenIssues({ seedIssues: [1], getDeps });
    assert.deepEqual(out, [1, 2, 3]);
});

test('expand: SEC-3 — sanitiza a enteros positivos (ignora basura/inyección)', () => {
    const out = expandRecursiveOpenIssues({
        seedIssues: ['4255', '#4300', -1, 0, 'abc', '4300; rm -rf /', null, undefined],
    });
    // '4255' y '#4300' válidos; '4300; rm -rf /' → Number(...) = NaN → descartado.
    assert.deepEqual(out, [4255, 4300]);
});

test('expand: getDeps que lanza no rompe el walk (defensivo)', () => {
    const getDeps = (n) => { if (n === 4255) throw new Error('boom'); return []; };
    const out = expandRecursiveOpenIssues({ seedIssues: [4255], getDeps });
    assert.deepEqual(out, [4255]);
});

test('expand: seed vacía → []', () => {
    assert.deepEqual(expandRecursiveOpenIssues({ seedIssues: [] }), []);
    assert.deepEqual(expandRecursiveOpenIssues({}), []);
});
