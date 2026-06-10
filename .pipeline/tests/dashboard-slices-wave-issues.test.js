// #3905 — Tests del bloque `waveIssues` de pipelineSlice: cruce de la allowlist
// de la ola con el matrix, derivación de estados no-ingreso/finalizado a partir
// del state (OPEN/CLOSED) del title-cache, SEC-2 (descarte de no-enteros),
// robustez con allowlist vacía y anti-duplicado.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const slices = require('../lib/dashboard-slices');

// State base sin matrix: la franja "fuera de flujo" se nutre de la allowlist
// cruzada contra el matrix + el title-cache (state.issueTitles).
function makeState({ matrix = {}, titles = {} } = {}) {
    return {
        config: { pipelines: {} },
        bloqueados: [],
        allFases: [],
        issueMatrix: matrix,
        issueTitles: titles,
    };
}

test('pipelineSlice devuelve waveIssues con estados no-ingreso y finalizado segun el state del cache', () => {
    const state = makeState({
        titles: {
            '101': { title: 'Issue abierto', state: 'OPEN' },
            '102': { title: 'Issue cerrado', state: 'CLOSED' },
        },
    });
    const out = slices.pipelineSlice(state, { allowlist: [101, 102] });
    assert.ok(Array.isArray(out.waveIssues), 'waveIssues debe ser un array');
    assert.equal(out.waveIssues.length, 2);
    const byIssue = Object.fromEntries(out.waveIssues.map((w) => [w.issue, w]));
    assert.equal(byIssue['101'].estado, 'no-ingreso');
    assert.equal(byIssue['101'].title, 'Issue abierto');
    assert.equal(byIssue['102'].estado, 'finalizado');
    assert.equal(byIssue['102'].title, 'Issue cerrado');
});

test('pipelineSlice trata como no-ingreso un issue de la allowlist sin entry en el cache', () => {
    // Sin state conocido (cache no lo tiene aún) → no-ingreso (no asumir cerrado).
    const state = makeState({ titles: {} });
    const out = slices.pipelineSlice(state, { allowlist: [777] });
    assert.equal(out.waveIssues.length, 1);
    assert.equal(out.waveIssues[0].estado, 'no-ingreso');
    assert.equal(out.waveIssues[0].issue, '777');
    assert.equal(out.waveIssues[0].title, '');
});

test('pipelineSlice descarta entradas no enteras de la allowlist (SEC-2)', () => {
    const state = makeState({
        titles: { '3905': { title: 'ok', state: 'OPEN' } },
    });
    // .partial-pause.json es editable a mano: strings, NaN, decimales deben caer.
    const out = slices.pipelineSlice(state, { allowlist: ['3', 'abc', 3.5, null, 3905] });
    assert.equal(out.waveIssues.length, 1, 'solo el entero 3905 sobrevive');
    assert.equal(out.waveIssues[0].issue, '3905');
});

test('pipelineSlice retorna waveIssues vacio con allowlist vacia (CA "no rompe")', () => {
    const state = makeState();
    const out = slices.pipelineSlice(state, { allowlist: [] });
    assert.deepEqual(out.waveIssues, []);
});

test('pipelineSlice no incluye en waveIssues los issues que ya estan en el matrix (anti-duplicado)', () => {
    const state = makeState({
        matrix: {
            '200': {
                title: 'en fase',
                labels: [],
                faseActual: 'desarrollo/dev',
                estadoActual: 'trabajando',
                bounces: 0,
                staleMin: 0,
                fases: { 'desarrollo/dev': [] },
            },
        },
        titles: {
            '200': { title: 'en fase', state: 'OPEN' },
            '201': { title: 'sin ingresar', state: 'OPEN' },
        },
    });
    const out = slices.pipelineSlice(state, { allowlist: [200, 201] });
    const issues = out.waveIssues.map((w) => w.issue);
    assert.deepEqual(issues, ['201'], '200 ya está en el matrix → no se duplica en la franja');
});

test('pipelineSlice deriva finalizado con state en minúsculas o mixto (case-insensitive)', () => {
    const state = makeState({
        titles: { '300': { title: 'closed lower', state: 'closed' } },
    });
    const out = slices.pipelineSlice(state, { allowlist: [300] });
    assert.equal(out.waveIssues[0].estado, 'finalizado');
});
