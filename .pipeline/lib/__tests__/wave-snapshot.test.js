// =============================================================================
// wave-snapshot.test.js — Tests del cálculo del snapshot ejecutivo (#3262).
//
// Cubre los CAs cuantitativos:
//   - CA-2: % avance por issue (denominador adaptativo según lifecycle).
//   - CA-3: % avance total = (cerrados*100 + Σ%activos) / totalIssues.
//   - CA-4: ETA absoluta = max(absoluteMs activos), fallback si no hay data.
//   - CA-5: bloqueos con motivo concreto.
//   - CA-6: intervención humana (needs-human, stale, bug-en-pipeline).
//   - PO-CA-6: umbral configurable staleThresholdMin.
//
// Ejecutar:  node --test .pipeline/lib/__tests__/wave-snapshot.test.js
// =============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    buildWaveSnapshot,
    LIFECYCLE_FULL,
    LIFECYCLE_DEV_ONLY,
    _internal,
} = require('../wave-snapshot');

const NOW = 1747440000000; // 2026-05-17 00:00 UTC aprox

// -----------------------------------------------------------------------------
// Helpers para construir state sintético similar a getPipelineState().
// -----------------------------------------------------------------------------

function makeState({ issues, etaAverages }) {
    return {
        issueMatrix: issues || {},
        etaAverages: etaAverages || {},
        allFases: LIFECYCLE_FULL,
    };
}

function entry({ skill, estado, startedAt, durationMs, fase, pipeline = 'desarrollo' }) {
    return { skill, estado, fase, pipeline, startedAt, durationMs };
}

// -----------------------------------------------------------------------------
// CA-2 — % por issue con denominador adaptativo
// -----------------------------------------------------------------------------

test('CA-2: denominador 10 cuando issue pasó por definicion', () => {
    const state = makeState({
        issues: {
            '100': {
                title: 'Issue full lifecycle',
                labels: ['Ready'],
                fases: {
                    'definicion/analisis': [],
                    'desarrollo/dev': [entry({ skill: 'backend-dev', estado: 'trabajando', fase: 'dev', startedAt: NOW - 600000, durationMs: 600000 })],
                },
                faseActual: 'desarrollo/dev',
                estadoActual: 'trabajando',
                bounces: 0,
                staleMin: 10,
            },
        },
    });
    const snap = buildWaveSnapshot({
        state,
        wave: { label: 'N+5', issues: [100], source: 'test' },
        now: NOW,
    });
    const i = snap.issues[0];
    // desarrollo/dev es el índice 4 en LIFECYCLE_FULL → pct = (4+1)/10 = 50
    assert.equal(i.denominador, 10);
    assert.equal(i.faseIdx, 4);
    assert.equal(i.pct, 50);
});

test('CA-2: denominador 7 cuando issue entró Ready (solo desarrollo)', () => {
    const state = makeState({
        issues: {
            '101': {
                title: 'Issue dev only',
                labels: ['Ready'],
                fases: {
                    'desarrollo/dev': [entry({ skill: 'pipeline-dev', estado: 'trabajando', fase: 'dev', startedAt: NOW - 100000, durationMs: 100000 })],
                },
                faseActual: 'desarrollo/dev',
                estadoActual: 'trabajando',
                bounces: 0,
                staleMin: 5,
            },
        },
    });
    const snap = buildWaveSnapshot({
        state,
        wave: { label: 'N+5', issues: [101], source: 'test' },
        now: NOW,
    });
    const i = snap.issues[0];
    // dev es índice 1 en LIFECYCLE_DEV_ONLY (validacion=0, dev=1) → pct = (1+1)/7 ≈ 29
    assert.equal(i.denominador, 7);
    assert.equal(i.faseIdx, 1);
    assert.equal(i.pct, 29);
});

test('CA-2: aprobacion en lifecycle dev-only da 86%', () => {
    const state = makeState({
        issues: {
            '102': {
                title: 'Issue casi listo',
                labels: ['Ready'],
                fases: {
                    'desarrollo/aprobacion': [entry({ skill: 'review', estado: 'trabajando', fase: 'aprobacion', startedAt: NOW - 100000, durationMs: 100000 })],
                },
                faseActual: 'desarrollo/aprobacion',
                estadoActual: 'trabajando',
                bounces: 0,
                staleMin: 5,
            },
        },
    });
    const snap = buildWaveSnapshot({
        state,
        wave: { label: 'N+5', issues: [102], source: 'test' },
        now: NOW,
    });
    // aprobacion es índice 5 en LIFECYCLE_DEV_ONLY → pct = 6/7 = 86
    assert.equal(snap.issues[0].pct, 86);
});

// -----------------------------------------------------------------------------
// CA-3 — % total de la ola
// -----------------------------------------------------------------------------

test('CA-3: total ponderado con cerrados + activos', () => {
    const state = makeState({
        issues: {
            '200': {
                title: 'Cerrado',
                labels: ['closed'],
                fases: {},
                faseActual: null,
                estadoActual: null,
                bounces: 0,
                staleMin: 0,
            },
            '201': {
                title: 'En dev',
                labels: ['Ready'],
                fases: {
                    'desarrollo/dev': [entry({ skill: 'backend-dev', estado: 'trabajando', fase: 'dev', startedAt: NOW - 100000, durationMs: 100000 })],
                },
                faseActual: 'desarrollo/dev',
                estadoActual: 'trabajando',
                bounces: 0,
                staleMin: 0,
            },
        },
    });
    const snap = buildWaveSnapshot({
        state,
        wave: { label: 'N+5', issues: [200, 201], source: 'test' },
        closedIssues: new Set([200]),
        now: NOW,
    });
    // 200 cerrado → 100. 201 activo en dev (idx=1, denom=7) → 29.
    // Total = (100 + 29) / 2 = 64.5 → round 65
    assert.equal(snap.closedCount, 1);
    assert.equal(snap.activeCount, 1);
    assert.equal(snap.totalPct, 65);
});

test('CA-3: ola vacía retorna totalPct=0', () => {
    const snap = buildWaveSnapshot({
        state: makeState({}),
        wave: { label: 'Ola actual', issues: [], source: 'test' },
        now: NOW,
    });
    assert.equal(snap.totalPct, 0);
    assert.equal(snap.totalIssues, 0);
});

// -----------------------------------------------------------------------------
// CA-4 — ETA absoluta de la ola
// -----------------------------------------------------------------------------

test('CA-4: ETA es el max de absoluteMs entre activos (paralelo, no suma)', () => {
    const state = makeState({
        issues: {
            '300': {
                title: 'En verificacion',
                labels: ['Ready'],
                fases: {
                    'desarrollo/verificacion': [entry({ skill: 'tester', estado: 'trabajando', fase: 'verificacion', startedAt: NOW - 60000, durationMs: 60000 })],
                },
                faseActual: 'desarrollo/verificacion',
                estadoActual: 'trabajando',
                bounces: 0,
                staleMin: 0,
            },
            '301': {
                title: 'En dev',
                labels: ['Ready'],
                fases: {
                    'desarrollo/dev': [entry({ skill: 'backend-dev', estado: 'trabajando', fase: 'dev', startedAt: NOW - 30000, durationMs: 30000 })],
                },
                faseActual: 'desarrollo/dev',
                estadoActual: 'trabajando',
                bounces: 0,
                staleMin: 0,
            },
        },
        etaAverages: {
            // Averages: dev=600000ms (10 min), verificacion=300000ms (5 min)
            'dev': { avgMs: 600000 },
            'verificacion': { avgMs: 300000 },
            'aprobacion': { avgMs: 200000 },
            'entrega': { avgMs: 100000 },
            'build': { avgMs: 300000 },
            'linteo': { avgMs: 60000 },
        },
    });
    const snap = buildWaveSnapshot({
        state,
        wave: { label: 'N+5', issues: [300, 301], source: 'test' },
        now: NOW,
    });
    assert.equal(snap.etaAvailable, true);
    // El issue 301 está en dev — le quedan dev + build + verif + linteo + aprob + entrega
    // = 600 + 300 + 300 + 60 + 200 + 100 = 1.560s. Pero ya está corriendo dev por 30s,
    // así que dev restante = 600 - 30 = 570s. Total restante = 570 + 300 + 300 + 60 + 200 + 100 = 1530s.
    // Issue 300 está en verificación; le quedan verif + linteo + aprob + entrega = 300 - 60 (corriendo) + 60 + 200 + 100 = 600s.
    // max = 1530s desde NOW.
    const expectedMaxRemaining = 1530000;
    assert.ok(snap.etaAbsoluteMs >= NOW + expectedMaxRemaining - 1000);
    assert.ok(snap.etaAbsoluteMs <= NOW + expectedMaxRemaining + 1000);
});

test('CA-4: sin etaAverages → etaAvailable=false y etasMissing>0', () => {
    const state = makeState({
        issues: {
            '400': {
                title: 'Sin estimación',
                labels: ['Ready'],
                fases: {
                    'desarrollo/dev': [entry({ skill: 'backend-dev', estado: 'trabajando', fase: 'dev', startedAt: NOW - 1000, durationMs: 1000 })],
                },
                faseActual: 'desarrollo/dev',
                estadoActual: 'trabajando',
                bounces: 0,
                staleMin: 0,
            },
        },
        etaAverages: {}, // vacío
    });
    const snap = buildWaveSnapshot({
        state,
        wave: { label: 'N+5', issues: [400], source: 'test' },
        now: NOW,
    });
    assert.equal(snap.etaAvailable, false);
    assert.equal(snap.etaAbsoluteMs, null);
    assert.equal(snap.etasMissing, 1);
});

// -----------------------------------------------------------------------------
// CA-5 — Bloqueos
// -----------------------------------------------------------------------------

test('CA-5: bloqueo por archivo bloqueado-humano produce motivo concreto', () => {
    const state = makeState({
        issues: {
            '500': {
                title: 'Bloqueado',
                labels: ['Ready'],
                fases: {
                    'desarrollo/dev': [entry({ skill: 'backend-dev', estado: 'pendiente', fase: 'dev', startedAt: NOW - 1000, durationMs: 0 })],
                },
                faseActual: 'desarrollo/dev',
                estadoActual: 'pendiente',
                bounces: 0,
                staleMin: 0,
            },
        },
    });
    const snap = buildWaveSnapshot({
        state,
        wave: { label: 'N+5', issues: [500], source: 'test' },
        blocked: [{
            issue: 500,
            skill: 'backend-dev',
            reason: 'CODEOWNERS bloquea merge: review pendiente de @leitolarreta',
            question: '',
            age_hours: 2,
        }],
        now: NOW,
    });
    assert.equal(snap.blocks.length, 1);
    assert.equal(snap.blocks[0].id, 500);
    assert.match(snap.blocks[0].motivo, /CODEOWNERS bloquea merge/);
    assert.equal(snap.issues[0].isBlocked, true);
});

test('CA-5: bloqueo por label blocked:dependencies con motivo del rebote', () => {
    const state = makeState({
        issues: {
            '501': {
                title: 'Espera padre',
                labels: ['Ready', 'blocked:dependencies'],
                fases: {},
                faseActual: 'desarrollo/dev',
                estadoActual: 'pendiente',
                bounces: 0,
                staleMin: 0,
                motivo_rechazo: 'espera cierre de #3242 antes de mergear',
            },
        },
    });
    const snap = buildWaveSnapshot({
        state,
        wave: { label: 'N+5', issues: [501], source: 'test' },
        now: NOW,
    });
    assert.equal(snap.blocks.length, 1);
    assert.equal(snap.blocks[0].motivo, 'espera cierre de #3242');
});

// -----------------------------------------------------------------------------
// CA-6 — Intervención humana
// -----------------------------------------------------------------------------

test('CA-6: stale > threshold gatilla intervención humana', () => {
    const state = makeState({
        issues: {
            '600': {
                title: 'Stuck',
                labels: ['Ready'],
                fases: {
                    'desarrollo/dev': [entry({ skill: 'backend-dev', estado: 'trabajando', fase: 'dev', startedAt: NOW - 91 * 60000, durationMs: 91 * 60000 })],
                },
                faseActual: 'desarrollo/dev',
                estadoActual: 'trabajando',
                bounces: 0,
                staleMin: 91,
            },
        },
    });
    const snap = buildWaveSnapshot({
        state,
        wave: { label: 'N+5', issues: [600], source: 'test' },
        now: NOW,
    });
    assert.equal(snap.humanInterventions.length, 1);
    assert.equal(snap.humanInterventions[0].id, 600);
    assert.equal(snap.issues[0].isStale, true);
});

test('PO-CA-6: staleThresholdMin configurable (default 90)', () => {
    const state = makeState({
        issues: {
            '601': {
                title: 'Stale config',
                labels: ['Ready'],
                fases: {},
                faseActual: 'desarrollo/dev',
                estadoActual: 'trabajando',
                bounces: 0,
                staleMin: 30,
            },
        },
    });
    // Threshold 20 → 30 min se considera stale.
    const snap = buildWaveSnapshot({
        state,
        wave: { label: 'N+5', issues: [601], source: 'test' },
        staleThresholdMin: 20,
        now: NOW,
    });
    assert.equal(snap.issues[0].isStale, true);
    assert.equal(snap.staleThresholdMin, 20);
});

test('CA-6: bug-en-pipeline gatilla intervención sin necesidad de stale', () => {
    const state = makeState({
        issues: {
            '602': {
                title: 'Bug',
                labels: ['Ready', 'bug-en-pipeline'],
                fases: {},
                faseActual: 'desarrollo/dev',
                estadoActual: 'trabajando',
                bounces: 0,
                staleMin: 5,
            },
        },
    });
    const snap = buildWaveSnapshot({
        state,
        wave: { label: 'N+5', issues: [602], source: 'test' },
        now: NOW,
    });
    assert.equal(snap.humanInterventions.length, 1);
    assert.match(snap.humanInterventions[0].motivo, /bug/i);
});

// -----------------------------------------------------------------------------
// Edge: issues fuera de la matriz
// -----------------------------------------------------------------------------

test('Edge: issue de la ola sin presencia en pipeline cuenta como pendiente 0%', () => {
    const snap = buildWaveSnapshot({
        state: makeState({}),
        wave: { label: 'N+5', issues: [9999], source: 'test' },
        now: NOW,
    });
    assert.equal(snap.issues.length, 1);
    assert.equal(snap.issues[0].pct, 0);
    assert.equal(snap.issues[0].status, 'pending');
});

test('Edge: issue cerrado en GitHub (sin matrix) cuenta como 100%', () => {
    const snap = buildWaveSnapshot({
        state: makeState({}),
        wave: { label: 'N+5', issues: [9998], source: 'test' },
        closedIssues: new Set([9998]),
        now: NOW,
    });
    assert.equal(snap.issues[0].pct, 100);
    assert.equal(snap.issues[0].isClosed, true);
    assert.equal(snap.closedCount, 1);
});

// -----------------------------------------------------------------------------
// #4098 — state: CLOSED como fuente autoritativa de cerrado
// -----------------------------------------------------------------------------

test('#4098 CA-2: épico cerrado por hijos (state CLOSED) sin matriz ni archivo → closed', () => {
    // Réplica del caso #4050: cerrado en GitHub, NO está en issueMatrix ni tiene
    // archivo en entrega/procesado. El dato autoritativo viene de issueTitles.
    const state = {
        issueMatrix: {},
        etaAverages: {},
        allFases: LIFECYCLE_FULL,
        issueTitles: {
            '4050': { title: 'Épico cerrado por hijos', state: 'CLOSED', labels: ['epic', 'split'] },
        },
    };
    const snap = buildWaveSnapshot({
        state,
        wave: { label: 'N+1', issues: [4050], source: 'test' },
        now: NOW,
    });
    const i = snap.issues[0];
    assert.equal(i.isClosed, true);
    assert.equal(i.status, 'closed');
    assert.equal(i.pct, 100);
    assert.equal(snap.closedCount, 1);
    assert.equal(snap.activeCount, 0);
});

test('#4098 CA-3: issue cerrado con label de bloqueo residual SIN matriz → closed, nunca blocked', () => {
    const state = {
        issueMatrix: {},
        etaAverages: {},
        allFases: LIFECYCLE_FULL,
        issueTitles: {
            '4050': { title: 'Cerrado con bloqueo residual', state: 'CLOSED', labels: ['blocked:dependencies'] },
        },
    };
    const snap = buildWaveSnapshot({
        state,
        wave: { label: 'N+1', issues: [4050], source: 'test' },
        now: NOW,
    });
    const i = snap.issues[0];
    assert.equal(i.status, 'closed');
    assert.equal(i.isClosed, true);
    assert.equal(i.isBlocked, false);
    assert.equal(snap.closedCount, 1);
    // No debe figurar como bloqueo ni intervención humana.
    assert.equal(snap.blocks.length, 0);
    assert.equal(snap.humanInterventions.length, 0);
});

test('#4098 CA-3: issue cerrado con label de bloqueo residual CON matriz → closed, nunca blocked', () => {
    const state = {
        issueMatrix: {
            '4050': {
                title: 'Cerrado con bloqueo residual (en matriz)',
                state: 'CLOSED',
                labels: ['blocked:dependencies'],
                fases: { 'desarrollo/dev': [entry({ skill: 'pipeline-dev', estado: 'pendiente', fase: 'dev', startedAt: NOW - 1000, durationMs: 0 })] },
                faseActual: 'desarrollo/dev',
                estadoActual: 'pendiente',
                bounces: 0,
                staleMin: 0,
                motivo_rechazo: 'espera cierre de #4067',
            },
        },
        etaAverages: {},
        allFases: LIFECYCLE_FULL,
    };
    const snap = buildWaveSnapshot({
        state,
        wave: { label: 'N+1', issues: [4050], source: 'test' },
        now: NOW,
    });
    const i = snap.issues[0];
    assert.equal(i.status, 'closed');
    assert.equal(i.isClosed, true);
    assert.equal(i.pct, 100);
    assert.equal(snap.closedCount, 1);
    assert.equal(snap.blocks.length, 0);
});

test('#4098 CA-6: issue ACTIVO bloqueado sin state CLOSED sigue blocked (no-regresión)', () => {
    const state = {
        issueMatrix: {
            '4096': {
                title: 'Activo bloqueado',
                state: 'OPEN',
                labels: ['blocked:dependencies'],
                fases: { 'desarrollo/dev': [entry({ skill: 'pipeline-dev', estado: 'pendiente', fase: 'dev', startedAt: NOW - 1000, durationMs: 0 })] },
                faseActual: 'desarrollo/dev',
                estadoActual: 'pendiente',
                bounces: 0,
                staleMin: 0,
                motivo_rechazo: 'espera cierre de #4067',
            },
        },
        etaAverages: {},
        allFases: LIFECYCLE_FULL,
    };
    const snap = buildWaveSnapshot({
        state,
        wave: { label: 'N+1', issues: [4096], source: 'test' },
        now: NOW,
    });
    const i = snap.issues[0];
    assert.equal(i.status, 'blocked');
    assert.equal(i.isClosed, false);
    assert.equal(i.isBlocked, true);
    assert.equal(snap.closedCount, 0);
});

test('#4098 CA-5: fallback cache frío sin state pero con closedSet (label done) sigue cerrado', () => {
    // Sin campo `state` en el cache → isClosedState=false; el caller marca cerrado
    // por label (closedSet). Debe seguir contando como cerrado (degradación con gracia).
    const state = {
        issueMatrix: {},
        etaAverages: {},
        allFases: LIFECYCLE_FULL,
        issueTitles: {
            '4050': { title: 'Cerrado por label done (sin state)', labels: ['done'] },
        },
    };
    const snap = buildWaveSnapshot({
        state,
        wave: { label: 'N+1', issues: [4050], source: 'test' },
        closedIssues: new Set([4050]),
        now: NOW,
    });
    assert.equal(snap.issues[0].isClosed, true);
    assert.equal(snap.issues[0].status, 'closed');
    assert.equal(snap.closedCount, 1);
});

// -----------------------------------------------------------------------------
// Internal helpers
// -----------------------------------------------------------------------------

test('formatStale: minutos → string compacto', () => {
    assert.equal(_internal.formatStale(0), '0m');
    assert.equal(_internal.formatStale(15), '15m');
    assert.equal(_internal.formatStale(60), '1h');
    assert.equal(_internal.formatStale(125), '2h5m');
});

test('classifyStatus: precedencia closed > blocked > paused > approval > dev > definition (#4098)', () => {
    // #4098 — cerrado gana a bloqueado y pausado: un issue CLOSED con label de
    // bloqueo residual nunca debe pintarse 🛑.
    assert.equal(_internal.classifyStatus({ isBlocked: true, isClosed: true, isPaused: true, faseActual: 'desarrollo/dev' }), 'closed');
    assert.equal(_internal.classifyStatus({ isPaused: true, isClosed: true, faseActual: 'desarrollo/dev' }), 'closed');
    assert.equal(_internal.classifyStatus({ isClosed: true, faseActual: null }), 'closed');
    // No-regresión: bloqueado activo (sin closed) sigue 'blocked'.
    assert.equal(_internal.classifyStatus({ isBlocked: true, isPaused: true, faseActual: 'desarrollo/dev' }), 'blocked');
    assert.equal(_internal.classifyStatus({ isPaused: true, faseActual: 'desarrollo/dev' }), 'paused');
    assert.equal(_internal.classifyStatus({ faseActual: 'desarrollo/aprobacion' }), 'approval');
    assert.equal(_internal.classifyStatus({ faseActual: 'desarrollo/dev' }), 'dev');
    assert.equal(_internal.classifyStatus({ faseActual: 'definicion/analisis' }), 'definition');
    assert.equal(_internal.classifyStatus({ faseActual: null }), 'pending');
});

test('isClosedState: normaliza el enum state case-insensitive y degrada con gracia (#4098)', () => {
    assert.equal(_internal.isClosedState({ state: 'CLOSED' }), true);
    assert.equal(_internal.isClosedState({ state: 'closed' }), true);
    assert.equal(_internal.isClosedState({ state: 'Closed' }), true);
    assert.equal(_internal.isClosedState({ state: 'OPEN' }), false);
    // Cache frío / sin campo state → false (conserva fallback por label).
    assert.equal(_internal.isClosedState({}), false);
    assert.equal(_internal.isClosedState(null), false);
    assert.equal(_internal.isClosedState(undefined), false);
});

test('abbreviateFase: nombres acortados con (idx/total)', () => {
    assert.equal(_internal.abbreviateFase('desarrollo/verificacion', 6, 10), 'verif (7/10)');
    assert.equal(_internal.abbreviateFase('desarrollo/aprobacion', 5, 7), 'aprob (6/7)');
    assert.equal(_internal.abbreviateFase(null, -1, 0), '—');
});

// -----------------------------------------------------------------------------
// #4075 — dependencias inline en bloqueos
// -----------------------------------------------------------------------------

test('#4075: describeDependencyState distingue en ola / fuera de ola / cerrado', () => {
    const byId = new Map([
        [4067, { id: 4067, isClosed: false, faseAbbrev: 'dev (5/10)' }],
        [4068, { id: 4068, isClosed: false, faseAbbrev: 'verif (7/10)' }],
        [4070, { id: 4070, isClosed: true, faseAbbrev: 'done' }],
        [4071, { id: 4071, isClosed: false, faseAbbrev: '—' }],
    ]);
    const ctx = {
        issueById: byId,
        waveSet: new Set([4067, 4068, 4070, 4071]),
        closedSet: new Set([4070]),
    };
    assert.equal(_internal.describeDependencyState(4067, ctx).statusText, 'en ola, dev 5/10');
    assert.equal(_internal.describeDependencyState(4068, ctx).statusText, 'en ola, verif 7/10');
    assert.equal(_internal.describeDependencyState(4070, ctx).statusText, 'en ola, cerrado');
    assert.equal(_internal.describeDependencyState(4071, ctx).statusText, 'en ola, pendiente');
    // Fuera de ola → abierto/cerrado best-effort.
    const fuera = _internal.describeDependencyState(9999, ctx);
    assert.equal(fuera.inWave, false);
    assert.equal(fuera.statusText, 'fuera de ola, abierto');
});

test('#4075: buildWaveSnapshot enriquece blocks con dependencies inline', () => {
    const state = makeState({
        issues: {
            '4050': {
                title: 'Padre bloqueado',
                labels: ['blocked:dependencies'],
                fases: { 'desarrollo/dev': [entry({ skill: 'backend-dev', estado: 'pendiente', fase: 'dev', startedAt: NOW - 1000, durationMs: 1000 })] },
                faseActual: 'desarrollo/dev',
                estadoActual: 'pendiente',
                bounces: 0,
                staleMin: 0,
            },
            '4067': {
                title: 'Hijo en dev',
                labels: ['Ready'],
                fases: { 'desarrollo/dev': [entry({ skill: 'backend-dev', estado: 'trabajando', fase: 'dev', startedAt: NOW - 60000, durationMs: 60000 })] },
                faseActual: 'desarrollo/dev',
                estadoActual: 'trabajando',
                bounces: 0,
                staleMin: 0,
            },
            '4068': {
                title: 'Hijo en verif',
                labels: ['Ready'],
                fases: { 'desarrollo/verificacion': [entry({ skill: 'tester', estado: 'trabajando', fase: 'verificacion', startedAt: NOW - 60000, durationMs: 60000 })] },
                faseActual: 'desarrollo/verificacion',
                estadoActual: 'trabajando',
                bounces: 0,
                staleMin: 0,
            },
        },
    });
    const snap = buildWaveSnapshot({
        state,
        wave: { label: 'N+1', issues: [4050, 4067, 4068], source: 'test' },
        blockDependencies: { 4050: [4067, 4068] },
        now: NOW,
    });
    const blk = snap.blocks.find((b) => b.id === 4050);
    assert.ok(blk, 'debe existir el bloqueo de #4050');
    assert.ok(Array.isArray(blk.dependencies) && blk.dependencies.length === 2);
    const ids = blk.dependencies.map((d) => d.id);
    assert.deepEqual(ids, [4067, 4068]);
    assert.ok(blk.dependencies.every((d) => d.inWave === true));
    assert.match(blk.dependencies[0].statusText, /en ola, dev/);
    assert.match(blk.dependencies[1].statusText, /en ola, verif/);
});

test('#4075: bloqueo sin blockDependencies queda sin dependencies (fallback)', () => {
    const state = makeState({
        issues: {
            '5000': {
                title: 'Bloqueado solo',
                labels: ['blocked:dependencies'],
                fases: { 'desarrollo/dev': [entry({ skill: 'backend-dev', estado: 'pendiente', fase: 'dev', startedAt: NOW - 1000, durationMs: 1000 })] },
                faseActual: 'desarrollo/dev',
                estadoActual: 'pendiente',
                bounces: 0,
                staleMin: 0,
            },
        },
    });
    const snap = buildWaveSnapshot({
        state,
        wave: { label: 'N+1', issues: [5000], source: 'test' },
        now: NOW,
    });
    const blk = snap.blocks.find((b) => b.id === 5000);
    assert.ok(blk);
    assert.equal(blk.dependencies, undefined);
});
