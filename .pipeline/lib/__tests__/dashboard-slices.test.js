// Tests para los slices del dashboard V3 — issue #2900: trazabilidad de
// rebotes en cards e historial. Validan:
//  - findReboteDestino: descubre el destino (intra-fase vs cross-phase)
//    a partir del estado del issueMatrix.
//  - recentlyFinished: enriquece entries rechazados con `reboteDestino`.
//  - pipelineSlice.matrix: expone `rebote_numero` y `rebote_numero_max`.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const slices = require('../dashboard-slices');

// Helper: arma un state mínimo compatible con lo que produce
// `getPipelineState()` en `dashboard.js` — sólo los campos que los slices
// bajo prueba leen efectivamente.
function makeState(issueMatrix) {
    return {
        issueMatrix,
        allFases: [],
        config: {},
        etaAverages: {},
    };
}

test('findReboteDestino retorna null si el issue no tiene rebote pendiente', () => {
    const issueData = {
        fases: {
            'desarrollo/verificacion': [
                { skill: 'tester', estado: 'procesado', resultado: 'rechazado',
                  pipeline: 'desarrollo', fase: 'verificacion' },
            ],
        },
    };
    assert.equal(slices.findReboteDestino(issueData, 'verificacion'), null);
});

test('findReboteDestino detecta rebote intra-fase (mismo pipeline/fase)', () => {
    const issueData = {
        fases: {
            'desarrollo/verificacion': [
                { skill: 'tester', estado: 'procesado', resultado: 'rechazado',
                  pipeline: 'desarrollo', fase: 'verificacion' },
                { skill: 'pipeline-dev', estado: 'pendiente', rebote: true,
                  rebote_tipo: 'codigo', rechazado_en_fase: 'verificacion',
                  pipeline: 'desarrollo', fase: 'verificacion' },
            ],
        },
    };
    const dest = slices.findReboteDestino(issueData, 'verificacion');
    assert.deepEqual(dest, {
        pipeline: 'desarrollo',
        fase: 'verificacion',
        skill: 'pipeline-dev',
        tipo: 'intra',
    });
});

test('findReboteDestino detecta rebote cross-phase (rebote_tipo=crossphase)', () => {
    const issueData = {
        fases: {
            'desarrollo/dev': [
                { skill: 'guru', estado: 'procesado', resultado: 'rechazado',
                  pipeline: 'desarrollo', fase: 'dev' },
            ],
            'definicion/criterios': [
                { skill: 'planner', estado: 'pendiente', rebote: true,
                  rebote_tipo: 'crossphase', rechazado_en_fase: 'dev',
                  pipeline: 'definicion', fase: 'criterios' },
            ],
        },
    };
    const dest = slices.findReboteDestino(issueData, 'dev');
    assert.equal(dest.tipo, 'crossphase');
    assert.equal(dest.skill, 'planner');
    assert.equal(dest.fase, 'criterios');
    assert.equal(dest.pipeline, 'definicion');
});

test('findReboteDestino tolera fase distinta sin rebote_tipo (fallback defensivo)', () => {
    // Algunos pendientes legacy podrían no tener `rebote_tipo` set. Si la
    // fase del pendiente difiere de la rechazada, el helper debe inferir
    // crossphase para no clasificarlo erróneamente como intra.
    const issueData = {
        fases: {
            'desarrollo/verificacion': [
                { skill: 'tester', estado: 'procesado', resultado: 'rechazado',
                  pipeline: 'desarrollo', fase: 'verificacion' },
            ],
            'desarrollo/dev': [
                { skill: 'pipeline-dev', estado: 'pendiente', rebote: true,
                  rechazado_en_fase: 'verificacion',
                  pipeline: 'desarrollo', fase: 'dev' },
            ],
        },
    };
    const dest = slices.findReboteDestino(issueData, 'verificacion');
    assert.equal(dest.tipo, 'crossphase');
    assert.equal(dest.skill, 'pipeline-dev');
});

test('findReboteDestino ignora pendientes sin rebote=true', () => {
    const issueData = {
        fases: {
            'desarrollo/verificacion': [
                { skill: 'tester', estado: 'procesado', resultado: 'rechazado',
                  pipeline: 'desarrollo', fase: 'verificacion' },
                { skill: 'pipeline-dev', estado: 'pendiente',
                  /* rebote NO seteado */
                  pipeline: 'desarrollo', fase: 'verificacion' },
            ],
        },
    };
    assert.equal(slices.findReboteDestino(issueData, 'verificacion'), null);
});

test('recentlyFinished agrega reboteDestino cuando entry está rechazado', () => {
    const state = makeState({
        '2891': {
            title: 'Issue rebotando',
            fases: {
                'desarrollo/verificacion': [
                    { skill: 'tester', estado: 'procesado', resultado: 'rechazado',
                      pipeline: 'desarrollo', fase: 'verificacion',
                      updatedAt: 1000, durationMs: 720000 },
                    { skill: 'pipeline-dev', estado: 'pendiente', rebote: true,
                      rebote_tipo: 'codigo', rechazado_en_fase: 'verificacion',
                      pipeline: 'desarrollo', fase: 'verificacion' },
                ],
            },
        },
    });
    const recent = slices.recentlyFinished(state, 5);
    const tester = recent.find(r => r.skill === 'tester');
    assert.ok(tester, 'debe incluir el entry del tester rechazado');
    assert.ok(tester.reboteDestino, 'debe tener reboteDestino');
    assert.equal(tester.reboteDestino.skill, 'pipeline-dev');
    assert.equal(tester.reboteDestino.tipo, 'intra');
});

test('recentlyFinished NO agrega reboteDestino para entries aprobados', () => {
    const state = makeState({
        '2885': {
            title: 'Issue aprobado',
            fases: {
                'desarrollo/verificacion': [
                    { skill: 'po', estado: 'procesado', resultado: 'aprobado',
                      pipeline: 'desarrollo', fase: 'verificacion',
                      updatedAt: 2000, durationMs: 240000 },
                ],
            },
        },
    });
    const recent = slices.recentlyFinished(state, 5);
    const po = recent.find(r => r.skill === 'po');
    assert.ok(po);
    assert.equal(po.reboteDestino, null);
});

test('recentlyFinished marca cross-phase cuando aplica', () => {
    const state = makeState({
        '2880': {
            title: 'Issue con rebote cross-phase',
            fases: {
                'desarrollo/dev': [
                    { skill: 'guru', estado: 'procesado', resultado: 'rechazado',
                      pipeline: 'desarrollo', fase: 'dev',
                      updatedAt: 3000, durationMs: 120000 },
                ],
                'definicion/criterios': [
                    { skill: 'planner', estado: 'pendiente', rebote: true,
                      rebote_tipo: 'crossphase', rechazado_en_fase: 'dev',
                      pipeline: 'definicion', fase: 'criterios' },
                ],
            },
        },
    });
    const recent = slices.recentlyFinished(state, 5);
    const guru = recent.find(r => r.skill === 'guru');
    assert.ok(guru.reboteDestino);
    assert.equal(guru.reboteDestino.tipo, 'crossphase');
    assert.equal(guru.reboteDestino.skill, 'planner');
});

test('pipelineSlice.matrix expone rebote_numero y rebote_numero_max', () => {
    const state = makeState({
        '2891': {
            title: 'X',
            labels: [],
            faseActual: 'desarrollo/verificacion',
            estadoActual: 'pendiente',
            bounces: 2,
            staleMin: 0,
            rebote: true,
            rebote_tipo: 'codigo',
            motivo_rechazo: 'fail',
            rechazado_en_fase: 'verificacion',
            rechazado_skill_previo: 'tester',
            rebote_numero: 2,
            rebote_numero_max: 3,
            fases: {
                'desarrollo/verificacion': [
                    { skill: 'pipeline-dev', estado: 'pendiente',
                      pipeline: 'desarrollo', fase: 'verificacion' },
                ],
            },
        },
    });
    const slice = slices.pipelineSlice(state, { PIPELINE: __dirname });
    const m = slice.matrix['2891'];
    assert.equal(m.rebote_numero, 2);
    assert.equal(m.rebote_numero_max, 3);
    assert.equal(m.rechazado_skill_previo, 'tester');
});

test('pipelineSlice.matrix usa cap default 3 cuando no se provee max', () => {
    // Defensa contra estados parciales (race con dashboard.js no-actualizado):
    // si data.rebote_numero_max no está set, el slice debe asumir 3 (mismo
    // cap que pulpo.js:2613).
    const state = makeState({
        '2900': {
            title: 'Y', labels: [], faseActual: 'desarrollo/dev',
            estadoActual: 'trabajando', bounces: 0, staleMin: 0,
            rebote: false, fases: {},
        },
    });
    const slice = slices.pipelineSlice(state, { PIPELINE: __dirname });
    assert.equal(slice.matrix['2900'].rebote_numero_max, 3);
});
