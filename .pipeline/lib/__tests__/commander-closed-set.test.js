// =============================================================================
// commander-closed-set.test.js — Suite del `closedSet` del cuadro `wave` (#4099).
//
// Cubre:
//   - CA-1: el closedSet se alimenta desde `state.issueTitles[id].state ===
//     'CLOSED'` aunque NO haya entrada en `issueMatrix` ni label closed/done
//     (caso épico cerrado por merge de hijos, ej. #4050).
//   - Fallback: labels `closed`/`done` siguen entrando al set (compat).
//   - Robustez: IDs no numéricos se descartan; sin state ni labels → no entra.
//
// Diseño: `computeClosedSet` es PURO (no red/FS/shell) → tests determinísticos.
//
// Ejecutar: node --test .pipeline/lib/__tests__/commander-closed-set.test.js
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { computeClosedSet } = require('../commander-deterministic');

test('#4099 CA-1: issueTitles[id].state === CLOSED entra al closedSet sin matriz ni label', () => {
    // Caso #4050: cerrado por merge de hijos. Sin entrada en issueMatrix, con
    // labels residuales de bloqueo (sin closed/done) en la cache de títulos.
    const state = {
        issueMatrix: {}, // no tiene matriz
        issueTitles: {
            '4050': {
                state: 'CLOSED',
                labels: ['enhancement', 'Ready', 'area:infra', 'blocked:dependencies'],
                fetchedAt: 1781887018616,
            },
        },
    };
    const set = computeClosedSet({ wave: { issues: [4050] }, state });
    assert.ok(set.has(4050), '#4050 CLOSED debe entrar al closedSet');
});

test('#4099: issue OPEN no entra al closedSet aunque tenga matriz', () => {
    const state = {
        issueMatrix: { '4060': { labels: ['Ready'] } },
        issueTitles: { '4060': { state: 'OPEN', labels: ['Ready'] } },
    };
    const set = computeClosedSet({ wave: { issues: [4060] }, state });
    assert.equal(set.has(4060), false);
});

test('#4099 fallback: label closed/done sigue entrando al closedSet (compat)', () => {
    const state = {
        issueMatrix: { '100': { labels: ['done'] }, '101': { labels: ['closed'] } },
        issueTitles: {}, // sin state cacheado
    };
    const set = computeClosedSet({ wave: { issues: [100, 101] }, state });
    assert.ok(set.has(100), 'label done → cerrado');
    assert.ok(set.has(101), 'label closed → cerrado');
});

test('#4099 fallback: label closed/done en la cache de títulos también cuenta', () => {
    const state = {
        issueMatrix: {},
        issueTitles: { '200': { state: 'OPEN', labels: ['done'] } },
    };
    // Edge raro: GitHub OPEN pero label done residual → se considera cerrado
    // por el camino de compatibilidad.
    const set = computeClosedSet({ wave: { issues: [200] }, state });
    assert.ok(set.has(200));
});

test('#4099: issue sin state ni label closed/done NO entra al closedSet', () => {
    const state = {
        issueMatrix: { '300': { labels: ['Ready', 'blocked:dependencies'] } },
        issueTitles: { '300': { state: 'OPEN', labels: ['Ready', 'blocked:dependencies'] } },
    };
    const set = computeClosedSet({ wave: { issues: [300] }, state });
    assert.equal(set.has(300), false);
    assert.equal(set.size, 0);
});

test('#4099: IDs no numéricos se descartan (robustez)', () => {
    const state = {
        issueMatrix: {},
        issueTitles: { '4050': { state: 'CLOSED', labels: [] } },
    };
    const set = computeClosedSet({ wave: { issues: ['4050; rm -rf .build', 'abc', 4050] }, state });
    // Sólo el entero válido entra.
    assert.deepEqual([...set], [4050]);
});

test('#4099: inputs vacíos/ausentes no rompen (no throw)', () => {
    assert.equal(computeClosedSet().size, 0);
    assert.equal(computeClosedSet({}).size, 0);
    assert.equal(computeClosedSet({ wave: {}, state: {} }).size, 0);
    assert.equal(computeClosedSet({ wave: { issues: [] }, state: { issueTitles: {} } }).size, 0);
});
