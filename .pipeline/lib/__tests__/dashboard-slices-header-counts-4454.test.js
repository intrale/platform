'use strict';

// =============================================================================
// #4454 — Counts del headerSlice wave-scoped + bloqueados union.
//
// Verifica los badges de la botonera del home (defecto 1):
//   - pipeline/issues/matriz derivan de `state.activeWave.issues` (ola activa),
//     NO de `state.issueMatrix` (pipeline global).
//   - fallback anti-0-engañoso: ola vacía → placeholder '·' (no 0).
//   - bloqueados = union deduplicada de bloqueados-humano (state.bloqueados) +
//     bloqueados-por-dependencias (markers filesystem), dedup por issue.
//
// node --test .pipeline/lib/__tests__/dashboard-slices-header-counts-4454.test.js
// =============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const slices = require('../dashboard-slices');
const rebote = require('../rebote-classifier');

const PIPELINE = path.resolve(__dirname, '..', '..');
const CTX = { PIPELINE };

// Estado mínimo que consume headerSlice sin reventar (procesos/resources/etc.
// son opcionales — el slice degrada con defaults).
function baseState(extra) {
    return {
        procesos: { pulpo: { alive: true, uptime: 0 } },
        issueMatrix: {},
        bloqueados: [],
        actividad: [],
        priorityWindows: {},
        resources: {},
        ...extra,
    };
}

// Set canónico de issues bloqueados-por-dependencias del filesystem real. El
// slice lo une con los bloqueados-humano; lo replicamos acá para calcular el
// esperado sin acoplarnos a un número mágico que cambia con el estado del repo.
function depBlockedIssues() {
    let markers = [];
    try { markers = rebote.listDependencyBlockedMarkers(); } catch { markers = []; }
    return markers
        .map(m => m && m.issue)
        .filter(n => Number.isFinite(Number(n)))
        .map(Number);
}

test('#4454: pipeline/issues/matriz derivan de la ola activa, no del pipeline global', () => {
    const state = baseState({
        // pipeline global grande (simula los 72 del defecto)…
        issueMatrix: { 1: {}, 2: {}, 3: {}, 4: {}, 5: {}, 6: {}, 7: {} },
        // …pero la ola activa tiene sólo 3 issues.
        activeWave: { label: 'Ola', issues: [4454, 4460, 4471], source: 'waves.json' },
    });
    const out = slices.headerSlice(state, CTX);
    assert.equal(out.counts.pipeline, 3, 'pipeline = largo de la ola activa (3), no 7');
    assert.equal(out.counts.issues, 3, 'issues = largo de la ola activa');
    assert.equal(out.counts.matriz, 3, 'matriz = largo de la ola activa');
});

test('#4454: ola vacía o resolver degradado → placeholder "·" (no 0 engañoso)', () => {
    const degraded = slices.headerSlice(baseState({ activeWave: { issues: [] } }), CTX);
    assert.equal(degraded.counts.pipeline, '·', 'ola vacía → placeholder');

    const noWave = slices.headerSlice(baseState({}), CTX);
    assert.equal(noWave.counts.pipeline, '·', 'sin activeWave → placeholder');
});

test('#4454: bloqueados = union deduplicada de humano + dependencias', () => {
    const dep = depBlockedIssues();
    // bloqueados-humano con un duplicado deliberado (100 repetido) para probar
    // el dedup por issue.
    const human = [{ issue: 100 }, { issue: 100 }, { issue: 200 }];
    const state = baseState({
        bloqueados: human,
        activeWave: { issues: [4454] },
    });
    const out = slices.headerSlice(state, CTX);
    const expected = new Set([100, 200, ...dep]).size;
    assert.equal(out.counts.bloqueados, expected,
        'union deduplicada de bloqueados-humano (100,200) + dependencias del filesystem');
    // Con al menos 2 bloqueados-humano distintos, el badge nunca debe ser 0
    // (defecto original: mostraba 0 con bloqueados presentes).
    assert.ok(out.counts.bloqueados >= 2, 'badge > 0 cuando hay bloqueados');
});

test('#4454: sin bloqueados-humano el badge refleja los dependency-blocked', () => {
    const dep = depBlockedIssues();
    const out = slices.headerSlice(baseState({ activeWave: { issues: [1] } }), CTX);
    assert.equal(out.counts.bloqueados, new Set(dep).size,
        'sólo dependency-blocked cuando state.bloqueados está vacío');
});
