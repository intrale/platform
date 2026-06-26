// =============================================================================
// Tests de las extensiones del Historial timeline (#4199).
//   - _eventType: clasificación derivada del tipo de evento (merge/rebote/
//     rechazo/aprobacion/ejecucion/fase).
//   - historialTimelineSlice: enriquecimiento con provider (resolver inyectado)
//     y eventType, facetas (skills/providers/eventTypes), filtros nuevos
//     (eventType / provider), y no-mutación del array fuente.
//
// node:test puro, sin filesystem (state inline).
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const slices = require(path.resolve(__dirname, '..', 'dashboard-slices.js'));
const { historialTimelineSlice, _eventType, HIST_EVENT_TYPES } = slices;

const NOW = 1_718_000_000_000;
const MIN = 60_000;

function entry(extra) {
    return Object.assign({
        issue: 100, titulo: 'Algo', skill: 'backend-dev', pipeline: 'desarrollo',
        fase: 'build', estado: 'procesado', resultado: 'aprobado', motivo: null,
        duration: 10 * MIN, startedAt: NOW - 20 * MIN, finishedAt: NOW - 5 * MIN,
        hasLog: true, logFile: '100-build.log', hasRejectionPdf: false, rejectionPdf: null,
        prUrl: null, reboteNumero: 0, crossphaseCount: 0, costo: null,
    }, extra || {});
}

function flat(slice) {
    return slice.groups.flatMap((g) => g.items);
}

// --- _eventType ---
test('_eventType deriva el evento más significativo por prioridad', () => {
    assert.equal(_eventType({ prUrl: 'https://github.com/x/y/pull/1' }), 'merge');
    assert.equal(_eventType({ reboteNumero: 2 }), 'rebote');
    assert.equal(_eventType({ crossphaseCount: 1 }), 'rebote');
    assert.equal(_eventType({ resultado: 'rechazado' }), 'rechazo');
    assert.equal(_eventType({ resultado: 'aprobado' }), 'aprobacion');
    assert.equal(_eventType({ estado: 'trabajando' }), 'ejecucion');
    assert.equal(_eventType({}), 'fase');
    // merge gana a rebote si hay PR + rebote
    assert.equal(_eventType({ prUrl: 'https://github.com/x/y/pull/1', reboteNumero: 3 }), 'merge');
    assert.equal(_eventType(null), 'fase');
});

test('HIST_EVENT_TYPES expone el orden canónico', () => {
    assert.deepEqual(HIST_EVENT_TYPES, ['merge', 'rebote', 'rechazo', 'aprobacion', 'ejecucion', 'fase']);
});

// --- enriquecimiento provider + eventType ---
test('cada item del timeline trae eventType y provider (resolver inyectado)', () => {
    const state = { agentHistory: [
        entry({ issue: '10', skill: 'pipeline-dev', prUrl: 'https://github.com/intrale/platform/pull/5' }),
        entry({ issue: '20', skill: 'backend-dev', resultado: 'rechazado', reboteNumero: 2, finishedAt: NOW - 10 * MIN }),
    ] };
    const resolveProvider = (skill) => ({ 'pipeline-dev': 'anthropic', 'backend-dev': 'groq' }[skill] || null);
    const r = historialTimelineSlice(state, { now: NOW }, { resolveProvider });
    const items = flat(r);
    const byIssue = Object.fromEntries(items.map((h) => [h.issue, h]));
    assert.equal(byIssue['10'].eventType, 'merge');
    assert.equal(byIssue['10'].provider, 'anthropic');
    assert.equal(byIssue['20'].eventType, 'rebote');
    assert.equal(byIssue['20'].provider, 'groq');
});

test('sin resolveProvider el provider degrada a null (CA-3)', () => {
    const state = { agentHistory: [entry({ issue: '10' })] };
    const r = historialTimelineSlice(state, { now: NOW }, {});
    assert.equal(flat(r)[0].provider, null);
    assert.equal(flat(r)[0].eventType, 'aprobacion');
});

test('NO muta el array fuente (state.agentHistory)', () => {
    const src = entry({ issue: '10', skill: 'pipeline-dev' });
    const state = { agentHistory: [src] };
    const resolveProvider = () => 'anthropic';
    historialTimelineSlice(state, { now: NOW }, { resolveProvider });
    assert.equal(src.eventType, undefined);
    assert.equal(src.provider, undefined);
});

// --- facetas ---
test('facets expone skills/providers/eventTypes presentes en el período', () => {
    const state = { agentHistory: [
        entry({ issue: '10', skill: 'pipeline-dev', prUrl: 'https://github.com/intrale/platform/pull/5' }),
        entry({ issue: '20', skill: 'backend-dev', resultado: 'rechazado', reboteNumero: 1, finishedAt: NOW - 9 * MIN }),
        entry({ issue: '30', skill: 'qa', estado: 'trabajando', resultado: null, finishedAt: 0, startedAt: NOW - 1 * MIN }),
    ] };
    const resolveProvider = (skill) => ({ 'pipeline-dev': 'anthropic', 'backend-dev': 'groq', 'qa': 'gemini-google' }[skill] || null);
    const r = historialTimelineSlice(state, { now: NOW }, { resolveProvider });
    assert.deepEqual(r.facets.skills, ['backend-dev', 'pipeline-dev', 'qa']);
    assert.deepEqual(r.facets.providers, ['anthropic', 'gemini-google', 'groq']);
    // eventTypes en orden canónico, solo los presentes
    assert.deepEqual(r.facets.eventTypes, ['merge', 'rebote', 'ejecucion']);
});

// --- filtros nuevos ---
test('filtro por eventType acota al tipo pedido', () => {
    const state = { agentHistory: [
        entry({ issue: '10', prUrl: 'https://github.com/intrale/platform/pull/5' }),
        entry({ issue: '20', resultado: 'rechazado', reboteNumero: 2, finishedAt: NOW - 9 * MIN }),
    ] };
    const r = historialTimelineSlice(state, { now: NOW }, { eventType: 'rebote' });
    assert.equal(r.total, 1);
    assert.equal(flat(r)[0].issue, '20');
    assert.equal(r.filters.eventType, 'rebote');
});

test('filtro por provider acota al proveedor pedido', () => {
    const state = { agentHistory: [
        entry({ issue: '10', skill: 'pipeline-dev' }),
        entry({ issue: '20', skill: 'backend-dev', finishedAt: NOW - 9 * MIN }),
    ] };
    const resolveProvider = (skill) => ({ 'pipeline-dev': 'anthropic', 'backend-dev': 'groq' }[skill] || null);
    const r = historialTimelineSlice(state, { now: NOW }, { resolveProvider, provider: 'groq' });
    assert.equal(r.total, 1);
    assert.equal(flat(r)[0].issue, '20');
    assert.equal(r.filters.provider, 'groq');
});

test('eventType + provider combinados', () => {
    const state = { agentHistory: [
        entry({ issue: '10', skill: 'pipeline-dev', prUrl: 'https://github.com/intrale/platform/pull/5' }),
        entry({ issue: '20', skill: 'backend-dev', resultado: 'rechazado', reboteNumero: 1, finishedAt: NOW - 9 * MIN }),
        entry({ issue: '30', skill: 'qa', resultado: 'rechazado', reboteNumero: 1, finishedAt: NOW - 8 * MIN }),
    ] };
    const resolveProvider = (skill) => ({ 'pipeline-dev': 'anthropic', 'backend-dev': 'groq', 'qa': 'anthropic' }[skill] || null);
    const r = historialTimelineSlice(state, { now: NOW }, { resolveProvider, eventType: 'rebote', provider: 'anthropic' });
    assert.equal(r.total, 1);
    assert.equal(flat(r)[0].issue, '30');
});
