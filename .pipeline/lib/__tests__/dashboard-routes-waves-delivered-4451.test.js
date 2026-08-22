// =============================================================================
// Tests del contador ENTREGADOS autoritativo del encabezado de ola (#4451).
//
// buildWavesPayload(state).active_wave.delivered es un entero derivado
// server-side con `computeClosedSet` — la MISMA fuente que el panel de avance
// del roadmap (`_roadmapAvance`, fix #4399). Antes el cliente lo recomputaba
// contando status==='completed' sobre la foto enriquecida del title-cache, lo
// que divergía de los issues realmente cerrados de la ola ("2 de 14" vs
// "11 de 14"). Cubre:
//   - CA-6 guard: delivered === computeClosedSet(...).size === _roadmapAvance().closed
//   - CA-3 invariante: entero, 0 ≤ delivered ≤ issues.length
//   - casos borde: 0 cerrados, todos cerrados, issues vacío, state sin titles
//   - CA-5 back-compat: el resto del shape del payload no cambia
//
// #5629 — Este contador era la CUARTA derivación de "Entregado" y la última sin
// migrar al helper único (`lib/delivery-status.js`): salía de `computeClosedSet`,
// que ignora `delivery_merge_sha`. `home.js` pinta ENTREGADOS con este entero
// (`wave.delivered`) mientras el board pinta cada issue con `it.delivered`, así
// que el MISMO payload llevaba dos nociones distintas de entregado. Los tests
// #4451 de arriba no lo detectaban porque todos sus fixtures cierran por CLOSED
// en el title-cache, camino donde ambas reglas coinciden. Los tests de abajo
// atacan justo los dos casos donde divergen (marker aprobado sin merge / merge
// sin CLOSED todavía) y el invariante banner == board.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { computeClosedSet } = require('../commander-deterministic');
const { _roadmapAvance } = require('../dashboard-slices');

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

// Ola activa con `ids` como issues crudos (shape number[] que resuelve
// normalizeWaveIssue). El `state.activeWave` replica esos mismos ids como
// number[] para que `_roadmapAvance` (que consume la ola canónica) compare
// contra el mismo set.
function fakeWavesWith(ids) {
    return {
        getHorizon: () => ([
            {
                status: 'active',
                number: 9,
                name: 'Ola 9',
                goal: 'Encabezado',
                started_at: '2026-07-01T00:00:00.000Z',
                issues: ids.map((n) => ({ number: n, status: 'pending' })),
            },
        ]),
    };
}

// State con K de N cerrados vía issueTitles (estado real CLOSED de GitHub).
function stateWith(closedIds, openIds) {
    const issueTitles = {};
    for (const id of closedIds) {
        issueTitles[String(id)] = { title: 'Cerrado ' + id, state: 'CLOSED', labels: [] };
    }
    for (const id of openIds) {
        issueTitles[String(id)] = { title: 'Abierto ' + id, state: 'OPEN', labels: [] };
    }
    return {
        // La ola canónica (number[]) que consume _roadmapAvance / el snapshot.
        activeWave: { label: 'Ola 9', source: 'waves', issues: closedIds.concat(openIds) },
        bloqueados: [],
        issueTitles,
        issueMatrix: {},
    };
}

test('#4451 CA-6: delivered cuenta lo mismo que computeClosedSet y que _roadmapAvance', () => {
    const closed = [101, 102];
    const open = [103, 104];
    const ids = closed.concat(open);
    withFakeWaves(fakeWavesWith(ids), () => {
        const { _internal } = fresh();
        const state = stateWith(closed, open);
        const payload = _internal.buildWavesPayload(state);

        const expected = computeClosedSet({ wave: { issues: ids }, state }).size;
        assert.equal(expected, 2, 'sanity: 2 cerrados en el set canónico');
        assert.equal(payload.active_wave.delivered, expected, 'header = computeClosedSet');

        // El header cuenta lo mismo que el panel de avance del roadmap (fix #4399).
        const avance = _roadmapAvance(state.activeWave, state);
        assert.equal(payload.active_wave.delivered, avance.closed, 'header = avance del roadmap');
    });
});

test('#4451 CA-3: delivered es entero y respeta 0 ≤ delivered ≤ total', () => {
    const closed = [201];
    const open = [202, 203];
    const ids = closed.concat(open);
    withFakeWaves(fakeWavesWith(ids), () => {
        const { _internal } = fresh();
        const payload = _internal.buildWavesPayload(stateWith(closed, open));
        const d = payload.active_wave.delivered;
        assert.ok(Number.isInteger(d), 'delivered es entero');
        assert.ok(d >= 0, 'delivered ≥ 0');
        assert.ok(d <= payload.active_wave.issues.length, 'delivered ≤ total');
        assert.equal(d, 1);
    });
});

test('#4451 borde: 0 cerrados → delivered 0', () => {
    withFakeWaves(fakeWavesWith([301, 302]), () => {
        const { _internal } = fresh();
        const payload = _internal.buildWavesPayload(stateWith([], [301, 302]));
        assert.equal(payload.active_wave.delivered, 0);
    });
});

test('#4451 borde: todos cerrados → delivered === total', () => {
    const ids = [401, 402, 403];
    withFakeWaves(fakeWavesWith(ids), () => {
        const { _internal } = fresh();
        const payload = _internal.buildWavesPayload(stateWith(ids, []));
        assert.equal(payload.active_wave.delivered, payload.active_wave.issues.length);
        assert.equal(payload.active_wave.delivered, 3);
    });
});

test('#4451 borde: state sin issueTitles → delivered 0 (degradación grácil)', () => {
    withFakeWaves(fakeWavesWith([501, 502]), () => {
        const { _internal } = fresh();
        // state mínimo: sin issueTitles ni issueMatrix, computeClosedSet no cierra nada.
        const payload = _internal.buildWavesPayload({ activeWave: { issues: [501, 502] } });
        assert.equal(payload.active_wave.delivered, 0);
        assert.ok(Number.isInteger(payload.active_wave.delivered));
    });
});

test('#4451 borde: issues vacío → delivered 0, no negativo', () => {
    withFakeWaves(fakeWavesWith([]), () => {
        const { _internal } = fresh();
        const payload = _internal.buildWavesPayload(stateWith([], []));
        assert.equal(payload.active_wave.delivered, 0);
    });
});

// ---------------------------------------------------------------------------
// #5629 — Guardrails del contador contra las dos divergencias reales.
// ---------------------------------------------------------------------------

// Entrada de `issueMatrix` con un marker de la fase de entrega ya procesado.
// `resultado`/`motivo` van a propósito: el helper NO debe mirarlos (R3), sólo
// el `delivery_merge_sha` estructurado.
function matrixConEntrega({ sha = null } = {}) {
    const entry = {
        estado: 'procesado',
        skill: 'delivery',
        resultado: 'aprobado',
        motivo: 'PR creado pero sin label qa:passed/qa:skipped — merge bloqueado.',
    };
    if (sha) entry.delivery_merge_sha = sha;
    return {
        faseActual: 'desarrollo/entrega',
        estadoActual: 'procesado',
        labels: [],
        fases: { 'desarrollo/entrega': [entry] },
    };
}

test('#5629 CA-1 (REGRESIÓN #5220/#5244): marker aprobado sin merge + issue abierto NO suma a ENTREGADOS', () => {
    const ids = [5220, 5244];
    withFakeWaves(fakeWavesWith(ids), () => {
        const { _internal } = fresh();
        const state = stateWith([], ids);
        // Los dos tienen entrega procesada con `resultado: aprobado`, pero el
        // merge quedó frenado: sin `delivery_merge_sha`. Es el caso exacto que
        // pintaba la columna Entregado al 100% con los PRs sin mergear.
        state.issueMatrix[String(5220)] = matrixConEntrega();
        state.issueMatrix[String(5244)] = matrixConEntrega();

        const payload = _internal.buildWavesPayload(state);
        assert.equal(payload.active_wave.delivered, 0,
            'un issue abierto y sin merge no puede sumar a ENTREGADOS');
        for (const it of payload.active_wave.issues) {
            assert.notEqual(it.delivered, true, `#${it.id} no está entregado`);
            assert.notEqual(it.status, 'completed', `#${it.id} no está completed`);
        }
    });
});

test('#5629 CA-5: merge SHA estructurado suma a ENTREGADOS sin esperar el TTL del title-cache', () => {
    const ids = [701, 702];
    withFakeWaves(fakeWavesWith(ids), () => {
        const { _internal } = fresh();
        // Title-cache todavía OPEN para los dos (TTL de 1h sin vencer), pero
        // #701 ya tiene merge confirmado por SHA.
        const state = stateWith([], ids);
        state.issueMatrix[String(701)] = matrixConEntrega({ sha: 'a1b2c3d' });
        state.issueMatrix[String(702)] = matrixConEntrega();

        const payload = _internal.buildWavesPayload(state);
        assert.equal(payload.active_wave.delivered, 1,
            'el merge SHA cierra la ventana del TTL; el frenado sigue sin contar');
        const byId = new Map(payload.active_wave.issues.map((it) => [it.id, it]));
        assert.equal(byId.get(701).delivered, true);
        assert.notEqual(byId.get(702).delivered, true);
    });
});

test('#5629 CA-7: el contador del banner es idéntico al conteo del board en el mismo payload', () => {
    // Mezcla los tres orígenes: CLOSED en GitHub, merge SHA sin CLOSED, y
    // abierto sin merge. El banner (`wave.delivered`, que lee home.js) y el
    // board (`issues[].delivered`, que lee pipeline-redesign.js) tienen que
    // coincidir por construcción, no por casualidad.
    const closed = [801];
    const open = [802, 803];
    withFakeWaves(fakeWavesWith(closed.concat(open)), () => {
        const { _internal } = fresh();
        const state = stateWith(closed, open);
        state.issueMatrix[String(802)] = matrixConEntrega({ sha: 'feedfacecafe' });
        state.issueMatrix[String(803)] = matrixConEntrega();

        const payload = _internal.buildWavesPayload(state);
        const board = payload.active_wave.issues.filter((it) => it.delivered === true).length;
        assert.equal(payload.active_wave.delivered, board, 'banner == board');
        assert.equal(payload.active_wave.delivered, 2, '#801 por CLOSED, #802 por SHA');
        assert.ok(payload.active_wave.delivered <= payload.active_wave.issues.length);
    });
});

test('#4451 CA-5: agregar delivered no rompe el resto del shape del payload', () => {
    const closed = [601];
    const open = [602];
    withFakeWaves(fakeWavesWith(closed.concat(open)), () => {
        const { _internal } = fresh();
        const payload = _internal.buildWavesPayload(stateWith(closed, open));
        // El campo aditivo convive con el shape existente.
        assert.equal(typeof payload.active_wave.delivered, 'number');
        assert.equal(payload.active_wave.number, 9);
        assert.ok(Array.isArray(payload.active_wave.issues));
        assert.equal(payload.active_wave.issues.length, 2);
        assert.ok('updated_at' in payload);
    });
});
