// =============================================================================
// Tests del slice + endpoint del Roadmap operativo consolidado (#4373, Ola 8.3).
//
// Modelado sobre dashboard-routes-waves.test.js. Cubre:
//   CA-S3 → `roadmapSlice` / `/api/dash/roadmap` devuelven whitelist de campos;
//           NUNCA vuelcan JSON crudo (tokens, paths absolutos, campos extra).
//   CA-7/CA-8 → bloqueos y ETA whitelisteados desde state.bloqueados / state.olaETA.
//   CA-S2 → el endpoint responde por el dispatch GET de API_ROUTES con headers
//           no-store (sendJson).
//   Paridad → `/roadmap` (HTML_ROUTES) y `?view=roadmap` (VIEW_SLUGS) resuelven
//             al MISMO render (renderRoadmapView) sin divergir.
//   Degradación → sin waves cargadas / con errores, payload vacío sin throw.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// Stub del módulo waves + reload de routes/slices para que el require perezoso de
// roadmapSlice y el `waves` capturado por dashboard-routes tomen el fake.
function withStubbedWaves(fakeWaves, fn) {
    const wavesPath = require.resolve('../waves');
    const routesPath = require.resolve('../dashboard-routes');
    const slicesPath = require.resolve('../dashboard-slices');
    const orig = {
        w: require.cache[wavesPath],
        r: require.cache[routesPath],
        s: require.cache[slicesPath],
    };
    require.cache[wavesPath] = { id: wavesPath, filename: wavesPath, loaded: true, exports: fakeWaves };
    delete require.cache[routesPath];
    delete require.cache[slicesPath];
    try {
        return fn();
    } finally {
        if (orig.w) require.cache[wavesPath] = orig.w; else delete require.cache[wavesPath];
        if (orig.r) require.cache[routesPath] = orig.r; else delete require.cache[routesPath];
        if (orig.s) require.cache[slicesPath] = orig.s; else delete require.cache[slicesPath];
    }
}

function fakeWavesOk() {
    return {
        getHorizon: () => ([
            {
                number: 8, name: 'Ola 8', goal: 'Roadmap', status: 'active', started_at: '2026-07-01T00:00:00Z',
                issues: [{ number: 4373, title: 'Vista roadmap', priority: 'medium', size: 'm', status: 'in-progress', secret: 'LEAK-ISSUE' }],
                secret: 'LEAK-WAVE',
            },
            { number: 9, name: 'Ola 9', goal: 'Siguiente', status: 'planned', issues: [] },
        ]),
        loadWaves: () => ({
            archived_waves: [{
                number: 7, name: 'Ola 7', goal: 'Cerrada', closed_at: '2026-06-30T02:15:00Z',
                issues_completed: 5, issues_failed: 1,
                token: 'SECRET-TOKEN', absPath: '/home/admin/waves.json',
                issues: [{ number: 4000, status: 'completed', secret: 'LEAK-ARCH' }],
            }],
        }),
    };
}

function fakeState() {
    return {
        bloqueados: [{ issue: 4360, blocker: 4350, reason: 'espera schema', token: 'LEAK-BLOCK' }],
        olaETA: { totalP50: 45, totalP75: 90, totalP90: 150, totalPct: 33, byIssue: { 4373: { samples: 3 } } },
        // #4399 — el avance del panel deriva de `state.activeWave` (ola canónica,
        // issues: number[]) + `state.issueTitles` (misma fuente que la lista del
        // pipeline vía computeClosedSet), NO de la foto enriquecida .status/.merged.
        activeWave: { label: 'Ola 8', issues: [4373], source: 'waves.json', resolved: true },
        issueTitles: { '4373': { state: 'OPEN', labels: [] } },
    };
}

test('CA-1/2/3: roadmapSlice consolida activa + planificadas + archivadas', () => {
    withStubbedWaves(fakeWavesOk(), () => {
        const slices = require('../dashboard-slices');
        const out = slices.roadmapSlice(fakeState(), {});
        assert.ok(out.activeWave && out.activeWave.number === 8, 'ola activa presente');
        assert.equal(out.plannedWaves.length, 1, 'una planificada');
        assert.equal(out.plannedWaves[0].number, 9);
        assert.equal(out.archivedWaves.length, 1, 'una archivada');
        assert.equal(out.archivedWaves[0].number, 7);
        assert.equal(out.archivedWaves[0].closedAt, '2026-06-30T02:15:00Z', 'closed_at whitelisteado');
        assert.equal(typeof out.updatedAt, 'string');
    });
});

test('CA-S3: roadmapSlice NO vuelca JSON crudo (tokens, paths, campos extra)', () => {
    withStubbedWaves(fakeWavesOk(), () => {
        const slices = require('../dashboard-slices');
        const out = slices.roadmapSlice(fakeState(), {});
        const serialized = JSON.stringify(out);
        assert.equal(serialized.includes('LEAK-ISSUE'), false, 'no filtra campo extra de issue');
        assert.equal(serialized.includes('LEAK-WAVE'), false, 'no filtra campo extra de ola');
        assert.equal(serialized.includes('LEAK-ARCH'), false, 'no filtra campo extra de archivada');
        assert.equal(serialized.includes('LEAK-BLOCK'), false, 'no filtra token del bloqueo');
        assert.equal(serialized.includes('SECRET-TOKEN'), false, 'no filtra token de la archivada');
        assert.equal(serialized.includes('/home/admin/'), false, 'no filtra path absoluto');
    });
});

test('CA-5: la prioridad del issue viaja whitelisteada en el payload', () => {
    withStubbedWaves(fakeWavesOk(), () => {
        const slices = require('../dashboard-slices');
        const out = slices.roadmapSlice(fakeState(), {});
        const issue = out.activeWave.issues[0];
        assert.equal(issue.priority, 'medium');
        assert.equal('secret' in issue, false, 'no propaga `secret`');
    });
});

test('CA-6: roadmapSlice calcula avance de la ola activa (cerrados/total/%)', () => {
    withStubbedWaves(fakeWavesOk(), () => {
        const slices = require('../dashboard-slices');
        const out = slices.roadmapSlice(fakeState(), {});
        // #4399 — 4373 OPEN en issueTitles → 0 cerrados de 1 (deriva de computeClosedSet).
        assert.deepEqual(out.avance, { closed: 0, total: 1, pct: 0 });
    });
});

test('#4399 CA-2: roadmapSlice cuenta cerrados desde computeClosedSet (mismo que la lista)', () => {
    withStubbedWaves(fakeWavesOk(), () => {
        const slices = require('../dashboard-slices');
        const { computeClosedSet } = require('../commander-deterministic');
        const state = fakeState();
        // El issue 4373 pasa a CLOSED en la cache de títulos → 1 de 1 cerrado.
        state.issueTitles = { '4373': { state: 'CLOSED', labels: [] } };
        const out = slices.roadmapSlice(state, {});
        // La lista deriva del MISMO set.
        const listaClosed = computeClosedSet({ wave: state.activeWave, state }).size;
        assert.equal(out.avance.closed, 1);
        assert.equal(out.avance.closed, listaClosed, 'panel == lista');
        assert.equal(out.avance.total, 1);
        assert.equal(out.avance.pct, 100);
    });
});

test('CA-7: bloqueos whitelisteados {issue, blocker, reason}', () => {
    withStubbedWaves(fakeWavesOk(), () => {
        const slices = require('../dashboard-slices');
        const out = slices.roadmapSlice(fakeState(), {});
        assert.equal(out.blocked.length, 1);
        assert.deepEqual(out.blocked[0], { issue: 4360, blocker: 4350, reason: 'espera schema' });
    });
});

test('CA-8: ETA con muestra → lowSample=false + percentiles', () => {
    withStubbedWaves(fakeWavesOk(), () => {
        const slices = require('../dashboard-slices');
        const out = slices.roadmapSlice(fakeState(), {});
        assert.equal(out.eta.ready, true);
        assert.equal(out.eta.lowSample, false);
        assert.equal(out.eta.p50, 45);
        assert.equal(out.eta.p90, 150);
    });
});

test('CA-8: ETA sin samples → lowSample=true', () => {
    withStubbedWaves(fakeWavesOk(), () => {
        const slices = require('../dashboard-slices');
        const state = fakeState();
        state.olaETA = { totalP50: 45, totalP75: 90, totalP90: 150, byIssue: { 4373: { samples: 0 } } };
        const out = slices.roadmapSlice(state, {});
        assert.equal(out.eta.lowSample, true, 'samples=0 → lowSample');
    });
});

test('CA-8: sin olaETA → eta.ready=false, lowSample=true', () => {
    withStubbedWaves(fakeWavesOk(), () => {
        const slices = require('../dashboard-slices');
        const out = slices.roadmapSlice({ bloqueados: [] }, {});
        assert.equal(out.eta.ready, false);
        assert.equal(out.eta.lowSample, true);
    });
});

test('CA-S2: /api/dash/roadmap registrado y despachado con headers no-store', () => {
    withStubbedWaves(fakeWavesOk(), () => {
        const routes = require('../dashboard-routes');
        assert.ok(routes._internal.API_ROUTES['/api/dash/roadmap'], 'endpoint registrado en API_ROUTES');

        const ctx = { getState: () => fakeState() };
        const captured = { status: null, headers: null, body: '' };
        const res = {
            writeHead: (s, h) => { captured.status = s; captured.headers = h; },
            end: (b) => { captured.body = b || ''; },
        };
        const req = { method: 'GET', url: '/api/dash/roadmap', socket: { remoteAddress: '127.0.0.1' }, headers: {} };
        const handled = routes.handle(req, res, ctx);
        assert.equal(handled, true, 'la request fue manejada');
        assert.equal(captured.status, 200);
        assert.ok(/no-store/.test(captured.headers['Cache-Control'] || ''), 'header Cache-Control no-store');
        const payload = JSON.parse(captured.body);
        assert.ok('activeWave' in payload && 'plannedWaves' in payload && 'archivedWaves' in payload
            && 'blocked' in payload && 'eta' in payload && 'avance' in payload, 'shape del slice');
        assert.equal(captured.body.includes('SECRET-TOKEN'), false, 'no filtra secretos por el endpoint');
    });
});

test('paridad: /roadmap (HTML) y ?view=roadmap (VIEW_SLUGS) resuelven al mismo render', () => {
    withStubbedWaves(fakeWavesOk(), () => {
        const routes = require('../dashboard-routes');
        const ctx = { getState: () => fakeState() };
        // renderRoadmapView es el thunk compartido por ambos caminos.
        const direct = routes._internal.renderRoadmapView(ctx);
        const viaSlug = routes.VIEW_SLUGS.roadmap.render({ currentView: 'roadmap' }, ctx);
        assert.ok(direct.includes('data-slug="roadmap"'), 'render directo no es fallback inerte');
        assert.ok(viaSlug.includes('data-slug="roadmap"'), 'render por slug no es fallback inerte');
        // Ambos consumen el slice enriquecido (misma ola activa).
        assert.ok(direct.includes('Ola 8'), 'render directo enriquecido');
        assert.ok(viaSlug.includes('Ola 8'), 'render por slug enriquecido');
    });
});

test('degradación: roadmapSlice no lanza si waves falla (getHorizon/loadWaves tiran)', () => {
    const fakeThrow = {
        getHorizon: () => { throw new Error('disk on fire'); },
        loadWaves: () => { throw new Error('ENOENT /tmp/waves.json'); },
    };
    withStubbedWaves(fakeThrow, () => {
        const slices = require('../dashboard-slices');
        const out = slices.roadmapSlice(fakeState(), {});
        assert.equal(out.activeWave, null, 'sin activa');
        assert.deepEqual(out.plannedWaves, []);
        assert.deepEqual(out.archivedWaves, []);
        // ETA y bloqueos siguen viniendo del state (no dependen de waves).
        assert.equal(out.eta.ready, true);
        assert.equal(out.blocked.length, 1);
        const serialized = JSON.stringify(out);
        assert.equal(serialized.includes('ENOENT'), false, 'no filtra ENOENT/paths');
        assert.equal(serialized.includes('/tmp/'), false);
    });
});
