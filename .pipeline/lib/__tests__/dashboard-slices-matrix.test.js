'use strict';

// =============================================================================
// Tests del enriquecimiento de `pipelineSlice` para la Matriz heat-map
// (EP8-H6 #3959). Verifica la forma de los nuevos campos del payload:
//   - matrixIssues[faseKey][skill] = [issueId,...] consistente con matrixCounts.
//   - matrixAgeAvg[faseKey][skill] = edad media (suma ÷ count) derivada server-side.
//   - skillOrder = orden canónico de skill-catalog (CA-4).
//   - matrixTrend = baseline ≈24h leído de matrix-history (degrada a {} sin historial).
// node --test .pipeline/lib/__tests__/dashboard-slices-matrix.test.js
// =============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const slices = require('../dashboard-slices');
const catalog = require('../skill-catalog');
const matrixHistory = require('../matrix-history');

function baseState(fases) {
    return {
        issueMatrix: {},
        allFases: [
            { pipeline: 'desarrollo', fase: 'dev' },
            { pipeline: 'definicion', fase: 'criterios' },
        ],
        issueTitles: {},
        ...fases,
    };
}

// Issue helper: un issue con entradas por fase.
function issue(title, fasesEntries) {
    return { title, labels: [], faseActual: Object.keys(fasesEntries)[0], fases: fasesEntries };
}

test('matrixIssues y matrixCounts son consistentes (mismo conteo por celda)', () => {
    const state = baseState();
    state.issueMatrix = {
        '10': issue('Login', { 'desarrollo/dev': [{ skill: 'backend-dev', estado: 'trabajando', ageMin: 12 }] }),
        '11': issue('Signup', { 'desarrollo/dev': [{ skill: 'backend-dev', estado: 'pendiente', ageMin: 40 }] }),
        '12': issue('Theme', { 'desarrollo/dev': [{ skill: 'android-dev', estado: 'listo', ageMin: 5 }] }),
    };
    const out = slices.pipelineSlice(state, { PIPELINE: path.join(os.tmpdir(), 'noexiste-mtx') });

    const count = out.matrixCounts['desarrollo/dev']['backend-dev'];
    const ids = out.matrixIssues['desarrollo/dev']['backend-dev'];
    assert.equal(count, 2);
    assert.equal(ids.length, count, 'la lista de issues coincide con el conteo');
    assert.deepEqual(ids.sort(), ['10', '11']);
    assert.deepEqual(out.matrixIssues['desarrollo/dev']['android-dev'], ['12']);
});

test('matrixAgeAvg = suma de edades ÷ conteo (server-side)', () => {
    const state = baseState();
    state.issueMatrix = {
        '10': issue('A', { 'desarrollo/dev': [{ skill: 'backend-dev', estado: 'trabajando', ageMin: 10 }] }),
        '11': issue('B', { 'desarrollo/dev': [{ skill: 'backend-dev', estado: 'pendiente', ageMin: 50 }] }),
    };
    const out = slices.pipelineSlice(state, {});
    // (10 + 50) / 2 = 30
    assert.equal(out.matrixAgeAvg['desarrollo/dev']['backend-dev'], 30);
});

test('solo cuentan estados activos (pendiente/trabajando/listo); procesado se ignora', () => {
    const state = baseState();
    state.issueMatrix = {
        '10': issue('A', { 'desarrollo/dev': [
            { skill: 'backend-dev', estado: 'procesado', ageMin: 999 },
            { skill: 'backend-dev', estado: 'trabajando', ageMin: 10 },
        ] }),
    };
    const out = slices.pipelineSlice(state, {});
    assert.equal(out.matrixCounts['desarrollo/dev']['backend-dev'], 1);
    assert.equal(out.matrixIssues['desarrollo/dev']['backend-dev'].length, 1);
    assert.equal(out.matrixAgeAvg['desarrollo/dev']['backend-dev'], 10, 'la media ignora procesado');
});

test('skillOrder = orden canónico del catálogo (CA-4)', () => {
    const out = slices.pipelineSlice(baseState(), {});
    assert.deepEqual(out.skillOrder, catalog.skillOrder());
});

test('matrixTrend = {} cuando no hay historial de 24h', () => {
    const out = slices.pipelineSlice(baseState(), { PIPELINE: path.join(os.tmpdir(), 'sin-historial-mtx') });
    assert.deepEqual(out.matrixTrend, {});
});

test('matrixTrend = baseline ≈24h cuando hay historial', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slice-trend-'));
    const hour = 3600 * 1000;
    const now = Date.now();
    // snapshot de ≈24h atrás con un conteo conocido.
    matrixHistory.recordSnapshot(
        { 'desarrollo/dev': { 'backend-dev': 7 } },
        { pipelineDir: dir, now: now - 24 * hour, minIntervalMs: 0 },
    );
    const out = slices.pipelineSlice(baseState(), { PIPELINE: dir });
    assert.equal(out.matrixTrend['desarrollo/dev']['backend-dev'], 7, 'baseline de 24h disponible para la flecha');
});

test('payload incluye todos los campos nuevos de la receta', () => {
    const out = slices.pipelineSlice(baseState(), {});
    for (const k of ['matrixIssues', 'matrixAgeAvg', 'skillOrder', 'matrixTrend', 'matrixCounts']) {
        assert.ok(k in out, `falta ${k} en el payload`);
    }
});

// =============================================================================
// #4362 — Derivación de `progressState` (avance entre fases).
// La fase terminal del flujo es la última de allFases (desarrollo/entrega).
// =============================================================================

// allFases con el flujo real: la última fase (desarrollo/entrega) es la terminal.
function baseStateFlow() {
    return {
        issueMatrix: {},
        allFases: [
            { pipeline: 'definicion', fase: 'analisis' },
            { pipeline: 'definicion', fase: 'criterios' },
            { pipeline: 'desarrollo', fase: 'dev' },
            { pipeline: 'desarrollo', fase: 'build' },
            { pipeline: 'desarrollo', fase: 'entrega' },   // ← terminal del flujo
        ],
        issueTitles: {},
    };
}

// Escribe un activity-log temporal con un evento session:* para `issue` en `tsMs`.
function tempRepoWithActivity(issueId, tsMs) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prog-act-'));
    fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
    const line = JSON.stringify({ event: 'session:start', skill: 'build', issue: Number(issueId), ts: new Date(tsMs).toISOString() });
    fs.writeFileSync(path.join(dir, '.claude', 'activity-log.jsonl'), line + '\n');
    return dir;
}

test('CA-1: entre-fases con actividad reciente NO es sin-arrancar', () => {
    const now = Date.now();
    const state = baseStateFlow();
    // procesado en fase intermedia (dev), SIN estadoActual → sin marcador activo.
    state.issueMatrix = {
        '4255': { title: 'Épico', labels: [], fases: {
            'desarrollo/dev': [{ skill: 'pipeline-dev', estado: 'procesado', resultado: 'aprobado' }],
        } },
    };
    const repo = tempRepoWithActivity(4255, now - 5 * 60000);   // 5 min atrás → dentro de ventana (30m)
    const out = slices.pipelineSlice(state, { REPO_ROOT: repo, now });
    assert.equal(out.matrix['4255'].progressState, 'entre-fases');
    assert.notEqual(out.matrix['4255'].progressState, 'sin-arrancar');
});

test('CA-3: procesado viejo SIN actividad reciente NO es entre-fases', () => {
    const now = Date.now();
    const state = baseStateFlow();
    state.issueMatrix = {
        '4255': { title: 'Épico', labels: [], fases: {
            'desarrollo/dev': [{ skill: 'pipeline-dev', estado: 'procesado', resultado: 'aprobado' }],
        } },
    };
    const repo = tempRepoWithActivity(4255, now - 90 * 60000);   // 90 min atrás → fuera de ventana
    const out = slices.pipelineSlice(state, { REPO_ROOT: repo, now });
    assert.notEqual(out.matrix['4255'].progressState, 'entre-fases');
    assert.equal(out.matrix['4255'].progressState, 'sin-arrancar');
});

test('CA-3 borde: actividad justo dentro (29m) vs justo fuera (31m) de la ventana de 30m', () => {
    const now = Date.now();
    const mk = () => ({ issueMatrix: {
        '10': { title: 'A', labels: [], fases: { 'desarrollo/dev': [{ skill: 'pipeline-dev', estado: 'procesado' }] } },
    }, allFases: baseStateFlow().allFases });

    const inside = slices.pipelineSlice(mk(), { REPO_ROOT: tempRepoWithActivity(10, now - 29 * 60000), now });
    assert.equal(inside.matrix['10'].progressState, 'entre-fases', 'dentro de ventana');

    const outside = slices.pipelineSlice(mk(), { REPO_ROOT: tempRepoWithActivity(10, now - 31 * 60000), now });
    assert.equal(outside.matrix['10'].progressState, 'sin-arrancar', 'fuera de ventana');
});

test('CA-2: los tres estados canónicos son distinguibles', () => {
    const now = Date.now();
    const state = baseStateFlow();
    state.issueMatrix = {
        // sin-arrancar: sin fases procesadas, sin actividad.
        '1': { title: 'Nuevo', labels: [], fases: {} },
        // entre-fases: procesado intermedio + actividad reciente (inyectada por Set).
        '2': { title: 'Avanza', labels: [], fases: { 'desarrollo/dev': [{ skill: 'x', estado: 'procesado' }] } },
        // terminado: procesado en la fase terminal (desarrollo/entrega).
        '3': { title: 'Hecho', labels: [], fases: { 'desarrollo/entrega': [{ skill: 'delivery', estado: 'procesado' }] } },
    };
    const out = slices.pipelineSlice(state, { recentActivityIssues: new Set(['2']), now });
    assert.equal(out.matrix['1'].progressState, 'sin-arrancar');
    assert.equal(out.matrix['2'].progressState, 'entre-fases');
    assert.equal(out.matrix['3'].progressState, 'terminado');
    const distintos = new Set([
        out.matrix['1'].progressState, out.matrix['2'].progressState, out.matrix['3'].progressState,
    ]);
    assert.equal(distintos.size, 3, 'los tres estados deben ser distinguibles');
});

test('issue con estadoActual queda como activo (no aplica el derivado)', () => {
    const state = baseStateFlow();
    state.issueMatrix = {
        '5': { title: 'Activo', labels: [], faseActual: 'desarrollo/dev', estadoActual: 'trabajando',
            fases: { 'desarrollo/dev': [{ skill: 'pipeline-dev', estado: 'trabajando', ageMin: 3 }] } },
    };
    const out = slices.pipelineSlice(state, { recentActivityIssues: new Set(), now: Date.now() });
    assert.equal(out.matrix['5'].progressState, 'activo');
});
