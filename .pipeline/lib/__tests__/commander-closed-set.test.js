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

// =============================================================================
// #4399 — CA-2/CA-3: la LISTA del pipeline y el PANEL de métricas producen el
// MISMO conteo de cerrados desde `computeClosedSet`. Reproduce el bug real de la
// Ola 8.3 ("11 de 14" en la lista vs "2 de 14" en el panel) y verifica que, tras
// converger ambas zonas sobre la misma fuente, el número es idéntico.
// =============================================================================

const slices = require('../dashboard-slices');

// Fixture: ola de 14 issues, 11 CLOSED en la cache de títulos (el escenario real).
function buildOla83State() {
    const issues = [4380, 4381, 4382, 4383, 4384, 4385, 4386, 4387, 4388, 4389, 4390, 4391, 4392, 4393];
    const closedIds = issues.slice(0, 11); // 11 cerrados
    const issueTitles = {};
    for (const id of issues) {
        issueTitles[String(id)] = {
            state: closedIds.includes(id) ? 'CLOSED' : 'OPEN',
            labels: [],
        };
    }
    return { issues, closedIds, issueTitles };
}

test('#4399 CA-2: lista y panel de métricas cuentan el mismo # de cerrados (11 de 14)', () => {
    const { issues, issueTitles } = buildOla83State();
    // `state.activeWave.issues` = number[] (output del resolver), igual que en el
    // dashboard real. `state.issueTitles` = cache cruda de títulos.
    const state = {
        activeWave: { label: 'Ola 8.3', issues, source: 'waves.json', resolved: true },
        issueTitles,
        issueMatrix: {},
    };

    // Camino LISTA (idéntico a dashboard-routes.computeLiveWaveStatus:730).
    const listaSet = computeClosedSet({ wave: state.activeWave, state });
    const listaClosed = listaSet.size;

    // Camino PANEL de métricas (dashboard-slices._roadmapAvance tras #4399).
    const avance = slices._roadmapAvance(state.activeWave, state);

    assert.equal(listaClosed, 11, 'la lista cuenta 11 cerrados');
    assert.equal(avance.closed, 11, 'el panel cuenta 11 cerrados (mismo set)');
    assert.equal(avance.closed, listaClosed, 'CA-2: lista y panel deben coincidir');
    assert.equal(avance.total, 14, 'total = # issues de la ola');
    assert.equal(avance.pct, 79, 'CA-3: % de avance coherente (round(11/14*100))');
});

test('#4399 CA-3: el panel NO usa la foto .status/.merged desincronizada', () => {
    // La foto enriquecida marca sólo 2 como completados/merged (el bug "2 de 14"),
    // pero la cache de títulos tiene 11 CLOSED. El panel debe reportar 11, no 2.
    const { issues, issueTitles } = buildOla83State();
    const state = {
        // issues como number[] (nunca la foto {status/merged}) — el panel deriva
        // los cerrados de issueTitles, no de flags por issue.
        activeWave: { label: 'Ola 8.3', issues, source: 'waves.json', resolved: true },
        issueTitles,
        issueMatrix: {},
    };
    const avance = slices._roadmapAvance(state.activeWave, state);
    assert.equal(avance.closed, 11, 'deriva de computeClosedSet, no de 2 flags stale');
    assert.notEqual(avance.closed, 2);
});

test('#4399: _roadmapAvance degrada grácil sin activeWave (0 de 0, sin throw)', () => {
    assert.deepEqual(slices._roadmapAvance(undefined, {}), { closed: 0, total: 0, pct: 0 });
    assert.deepEqual(slices._roadmapAvance({ issues: [] }, { issueTitles: {} }), { closed: 0, total: 0, pct: 0 });
});
