// =============================================================================
// Tests del enriquecimiento del board "Issues de la ola" (#4250).
//
// buildWavesPayload(state) cruza cada issue de la ola con el estado vivo del
// dashboard (title-cache + issueMatrix) para resolver, por issue: título real,
// estado de pipeline (completed/in-progress/ready/queued/blocked), agente·fase
// y acceso al log. Cubre:
//   - título resuelto desde issueTitles cuando waves.json no lo trae.
//   - estado derivado por cierre / matrix / label blocked.
//   - agente + fase + log desde el issueMatrix.
//   - sanitización (skill/fase a slug, logFile sin separadores de path).
//   - back-compat: sin `state` el shape base no cambia (no-op defensivo).
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

function fresh() {
    delete require.cache[require.resolve('../dashboard-routes')];
    return require('../dashboard-routes');
}

function withFakeWaves(fakeApi, fn) {
    const path = require.resolve('../waves');
    const original = require.cache[path];
    require.cache[path] = { id: path, filename: path, loaded: true, exports: fakeApi };
    try {
        return fn();
    } finally {
        if (original) require.cache[path] = original;
        else delete require.cache[path];
    }
}

// State de dashboard mínimo: title-cache + issueMatrix.
function makeState() {
    return {
        issueTitles: {
            // Cerrado → completed/mergeado.
            '101': { title: 'Documento único del pipeline', state: 'CLOSED', labels: [] },
            // En curso (matrix trabajando) → in-progress.
            '102': { title: 'Costos → presupuesto y anomalía', state: 'OPEN', labels: [] },
            // Abierto sin work-file → queued.
            '103': { title: 'Multi-provider pantalla nueva', state: 'OPEN', labels: [] },
            // Bloqueado por label.
            '104': { title: 'Issue bloqueado', state: 'OPEN', labels: ['blocked:dependencies'] },
        },
        issueMatrix: {
            '102': {
                faseActual: 'desarrollo/dev',
                estadoActual: 'trabajando',
                fases: {
                    'desarrollo/dev': [
                        { skill: 'backend-dev', hasLog: true, logFile: '102-backend-dev.log' },
                    ],
                },
            },
            // Tiene work-file pero NO está trabajando → ready.
            '105': {
                faseActual: 'desarrollo/build',
                estadoActual: 'listo',
                fases: {
                    'desarrollo/build': [
                        { skill: 'builder', hasLog: false, logFile: null },
                    ],
                },
            },
        },
    };
}

function enrich(base, state) {
    const { _internal } = fresh();
    return _internal.enrichWaveIssue(base, state);
}

const BASE = (id) => ({ id, title: '', priority: 'unknown', size: 'unknown', status: 'unknown' });

test('issue cerrado → completed + merged + progreso 100', () => {
    const out = enrich(BASE(101), makeState());
    assert.equal(out.status, 'completed');
    assert.equal(out.merged, true);
    assert.equal(out.progress, 100);
    assert.equal(out.title, 'Documento único del pipeline');
});

test('issue trabajando en matrix → in-progress con agente y fase del work-file', () => {
    const out = enrich(BASE(102), makeState());
    assert.equal(out.status, 'in-progress');
    assert.equal(out.agent, 'backend-dev');
    assert.equal(out.phase, 'dev');
    assert.equal(out.hasLog, true);
    assert.equal(out.logFile, '102-backend-dev.log');
    assert.equal(out.merged, false);
    assert.equal(out.title, 'Costos → presupuesto y anomalía');
});

test('issue abierto sin work-file → queued', () => {
    const out = enrich(BASE(103), makeState());
    assert.equal(out.status, 'queued');
    assert.equal(out.agent, null);
    assert.equal(out.phase, null);
    assert.equal(out.progress, 0);
});

test('issue con label blocked → blocked', () => {
    const out = enrich(BASE(104), makeState());
    assert.equal(out.status, 'blocked');
});

test('issue con work-file pero no trabajando → ready', () => {
    const out = enrich(BASE(105), makeState());
    assert.equal(out.status, 'ready');
    assert.equal(out.agent, 'builder');
    assert.equal(out.phase, 'build');
    assert.equal(out.hasLog, false, 'sin log → hasLog false');
    assert.equal(out.logFile, null);
});

test('título base de waves.json tiene prioridad sobre el cache', () => {
    const base = { id: 102, title: 'Título propio de la ola', priority: 'high', size: 'm', status: 'ready' };
    const out = enrich(base, makeState());
    assert.equal(out.title, 'Título propio de la ola');
});

test('sanitiza skill/fase a slug y logFile sin separadores de path', () => {
    const state = {
        issueTitles: { '200': { title: 'x', state: 'OPEN', labels: [] } },
        issueMatrix: {
            '200': {
                faseActual: 'desarrollo/dev',
                estadoActual: 'trabajando',
                fases: {
                    'desarrollo/dev': [
                        { skill: 'Back End/Dev <x>', hasLog: true, logFile: '../../etc/passwd' },
                    ],
                },
            },
        },
    };
    const out = enrich(BASE(200), state);
    assert.match(out.agent, /^[a-z0-9-]+$/, 'agent debe ser slug seguro');
    assert.equal(out.agent.includes('/'), false);
    assert.equal(out.agent.includes('<'), false);
    assert.equal(out.logFile.includes('/'), false, 'logFile sin separadores de path');
    assert.match(out.logFile, /^[a-z0-9._-]+$/i);
});

test('sin state: enrichWaveIssue degrada a queued sin romper', () => {
    const out = enrich(BASE(999), undefined);
    assert.equal(out.status, 'queued');
    assert.equal(out.agent, null);
    assert.equal(out.progress, 0);
});

test('buildWavesPayload(state) enriquece los issues de la ola activa', () => {
    const fakeWaves = {
        getHorizon: () => ([
            {
                status: 'active',
                number: 7,
                name: 'Ola 7',
                goal: 'Rediseño',
                started_at: '2026-06-29T00:00:00.000Z',
                issues: [
                    { number: 101, status: 'pending' },
                    { number: 102, status: 'pending' },
                    { number: 103, status: 'pending' },
                ],
            },
        ]),
    };
    withFakeWaves(fakeWaves, () => {
        const { _internal } = fresh();
        const payload = _internal.buildWavesPayload(makeState());
        const issues = payload.active_wave.issues;
        const byId = Object.fromEntries(issues.map((i) => [i.id, i]));
        assert.equal(byId[101].status, 'completed');
        assert.equal(byId[101].title, 'Documento único del pipeline');
        assert.equal(byId[102].status, 'in-progress');
        assert.equal(byId[102].agent, 'backend-dev');
        assert.equal(byId[103].status, 'queued');
    });
});

test('buildWavesPayload() sin state mantiene el shape base (back-compat)', () => {
    const fakeWaves = {
        getHorizon: () => ([
            {
                status: 'active',
                number: 7,
                name: 'Ola 7',
                goal: 'g',
                started_at: null,
                issues: [{ number: 101, title: 'T', priority: 'medium', size: 'm', status: 'ready' }],
            },
        ]),
    };
    withFakeWaves(fakeWaves, () => {
        const { _internal } = fresh();
        const payload = _internal.buildWavesPayload();
        const iss = payload.active_wave.issues[0];
        // Sin state, no se agregan campos enriquecidos.
        assert.deepEqual(Object.keys(iss).sort(), ['id', 'priority', 'size', 'status', 'title']);
    });
});

// #4331 — Regresión: un issue abierto SIN work-file recién ingresado a la ola
// activa NO debe salir como 'ready' (que la UI pinta "Lista"/"listo"). El
// overlay del snapshot vivo (`computeLiveWaveStatus` → `mapSnapshotStatusToWave`)
// corre DESPUÉS de `enrichWaveIssue` y antes del fix pisaba el `queued` que ya
// derivaba enrichWaveIssue: `classifyStatus` devuelve 'pending' sin fase, y ese
// 'pending' caía en el `default → 'ready'`. Con el fix, 'pending' → 'queued', y
// el overlay respeta el estado en cola. Este test fuerza que el overlay corra
// (state.activeWave presente) para cubrir esa capa, no sólo enrichWaveIssue.
test('#4331: overlay del snapshot no pisa queued con ready para issue sin work-file', () => {
    const fakeWaves = {
        getHorizon: () => ([
            {
                status: 'active',
                number: 8,
                name: 'Ola 8',
                goal: 'En ejecución',
                started_at: '2026-06-30T00:00:00.000Z',
                // 501: recién ingresado, abierto, sin work-file (no está en issueMatrix).
                issues: [{ number: 501, status: 'pending' }],
            },
        ]),
    };
    const state = {
        // activeWave presente → computeLiveWaveStatus corre el overlay del snapshot.
        activeWave: { label: 'Ola 8', source: 'waves', issues: [501] },
        bloqueados: [],
        issueTitles: {
            '501': { title: 'Issue recién ingresado a la ola', state: 'OPEN', labels: [] },
        },
        // issueMatrix presente pero SIN 501 → snapshot lo clasifica 'pending'.
        issueMatrix: {},
    };
    withFakeWaves(fakeWaves, () => {
        const { _internal } = fresh();
        const payload = _internal.buildWavesPayload(state);
        const iss = payload.active_wave.issues.find((i) => i.id === 501);
        assert.ok(iss, 'el issue 501 debe estar en el payload');
        assert.equal(iss.status, 'queued', 'sin fase iniciada = En cola, nunca ready/Lista');
        assert.equal(iss.progress, 0);
        assert.equal(iss.merged, false);
    });
});
