// =============================================================================
// Tests del endpoint /api/dash/waves (#3487 — Spike #3378 H3).
//
// Cubre:
//   CA-4 → Whitelist explícito de campos por issue {id, title, priority,
//          size, status}; valores fuera de whitelist → "unknown".
//   CA-4 → truncado de title a 200 chars.
//   CA-4 → next_wave nulo si no existe la planificada (active + 1).
//   CA-7 → Planificación no disponible: retorna 200 con structure vacía y
//          `message` cuando no hay olas o waves.js falla.
//   CA-8 → No propagar campos extra (sin spread) — campos como `notes`,
//          `assignee` o similares no aparecen en el payload.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

function fresh() {
    delete require.cache[require.resolve('../dashboard-routes')];
    return require('../dashboard-routes');
}

// Stub minimal del módulo waves para inyectar fixtures sin tocar el FS.
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

test('normalizeWaveIssue acepta shape mínimo y filtra campos extra', () => {
    const { _internal } = fresh();
    const out = _internal.normalizeWaveIssue({
        number: 3487,
        title: 'Widget olas',
        priority: 'medium',
        size: 'M',
        status: 'ready',
        notes: 'extra-secret',
        assignee: 'alice',
    });
    assert.deepEqual(out, {
        id: 3487,
        title: 'Widget olas',
        priority: 'medium',
        size: 'm',
        status: 'ready',
    });
    assert.equal('notes' in out, false, 'no debe propagar `notes`');
    assert.equal('assignee' in out, false, 'no debe propagar `assignee`');
});

test('normalizeWaveIssue trunca title a 200 chars', () => {
    const { _internal } = fresh();
    const longTitle = 'x'.repeat(500);
    const out = _internal.normalizeWaveIssue({
        number: 1,
        title: longTitle,
        priority: 'low',
        size: 's',
        status: 'ready',
    });
    assert.equal(out.title.length, 200);
});

test('normalizeWaveIssue reemplaza valores fuera de whitelist por "unknown"', () => {
    const { _internal } = fresh();
    const out = _internal.normalizeWaveIssue({
        number: 1,
        title: 'X',
        priority: 'devastating',
        size: 'XXXXL',
        status: 'mystery',
    });
    assert.equal(out.priority, 'unknown');
    assert.equal(out.size, 'unknown');
    assert.equal(out.status, 'unknown');
});

test('normalizeWaveIssue rechaza entradas inválidas (id no numérico o ausente)', () => {
    const { _internal } = fresh();
    assert.equal(_internal.normalizeWaveIssue(null), null);
    assert.equal(_internal.normalizeWaveIssue({}), null);
    assert.equal(_internal.normalizeWaveIssue({ number: 'abc' }), null);
    assert.equal(_internal.normalizeWaveIssue({ number: -1 }), null);
});

test('normalizeWaveIssue acepta `id` como alias de `number`', () => {
    const { _internal } = fresh();
    const out = _internal.normalizeWaveIssue({
        id: 42,
        title: 'X',
        priority: 'high',
        size: 'l',
        status: 'in-progress',
    });
    assert.equal(out.id, 42);
});

test('normalizeWaveIssue es case-insensitive en priority/size/status', () => {
    const { _internal } = fresh();
    const out = _internal.normalizeWaveIssue({
        number: 1,
        title: 'X',
        priority: 'CRITICAL',
        size: 'XL',
        status: 'IN-PROGRESS',
    });
    assert.equal(out.priority, 'critical');
    assert.equal(out.size, 'xl');
    assert.equal(out.status, 'in-progress');
});

test('buildWavesPayload retorna estructura vacía con message cuando no hay activa', () => {
    const routes = fresh();
    const payload = withFakeWaves(
        {
            getHorizon: () => [],
            getActiveWave: () => null,
            getPlannedWave: () => null,
        },
        () => {
            // Forzamos reload para que tome el fake.
            delete require.cache[require.resolve('../dashboard-routes')];
            const reloaded = require('../dashboard-routes');
            return reloaded._internal.buildWavesPayload();
        },
    );
    assert.equal(payload.active_wave, null);
    assert.equal(payload.next_wave, null);
    assert.deepEqual(payload.planned, []);
    assert.equal(payload.message, 'Planificación no disponible');
    assert.equal(typeof payload.updated_at, 'string');
});

test('buildWavesPayload retorna active + next normalizados sin propagar extras', () => {
    const fakeActive = {
        number: 7,
        name: 'Ola 7',
        goal: 'Cerrar épico #3378',
        started_at: '2026-05-24T10:00:00Z',
        status: 'active',
        issues: [
            {
                number: 3487,
                title: 'Widget olas',
                priority: 'medium',
                size: 'M',
                status: 'in-progress',
                notes: 'no exponer',
            },
            {
                number: 3493,
                title: 'Telegram /wave',
                priority: 'low',
                size: 's',
                status: 'ready',
            },
        ],
        secrets: 'should-not-leak',
    };
    const fakeNext = {
        number: 8,
        name: 'Ola 8',
        goal: 'Multi-provider',
        status: 'planned',
        issues: [
            { number: 3500, title: 'API health', priority: 'high', size: 'l', status: 'needs-def' },
        ],
    };
    delete require.cache[require.resolve('../dashboard-routes')];
    const payload = withFakeWaves(
        {
            getHorizon: () => [fakeActive, fakeNext],
            getActiveWave: () => fakeActive,
            getPlannedWave: (n) => (n === 8 ? fakeNext : null),
        },
        () => {
            delete require.cache[require.resolve('../dashboard-routes')];
            return require('../dashboard-routes')._internal.buildWavesPayload();
        },
    );
    assert.equal(payload.active_wave.number, 7);
    assert.equal(payload.active_wave.name, 'Ola 7');
    assert.equal(payload.active_wave.goal, 'Cerrar épico #3378');
    assert.equal(payload.active_wave.issues.length, 2);
    assert.equal(payload.active_wave.issues[0].id, 3487);
    assert.equal('notes' in payload.active_wave.issues[0], false);
    assert.equal('secrets' in payload.active_wave, false);
    assert.equal(payload.next_wave.number, 8);
    assert.equal(payload.next_wave.issues[0].id, 3500);
    // #3616 — el payload ahora trae `planned[]` con TODAS las planificadas.
    assert.equal(payload.planned.length, 1);
    assert.equal(payload.planned[0].number, 8);
    assert.equal(payload.message, undefined);
});

test('buildWavesPayload degrada a payload vacío si getHorizon tira', () => {
    delete require.cache[require.resolve('../dashboard-routes')];
    const payload = withFakeWaves(
        {
            getHorizon: () => { throw new Error('disk on fire'); },
        },
        () => {
            delete require.cache[require.resolve('../dashboard-routes')];
            return require('../dashboard-routes')._internal.buildWavesPayload();
        },
    );
    assert.equal(payload.active_wave, null);
    assert.equal(payload.next_wave, null);
    assert.deepEqual(payload.planned, []);
    assert.equal(payload.message, 'Planificación no disponible');
});

test('buildWavesPayload nunca expone paths/ENOENT en el payload', () => {
    delete require.cache[require.resolve('../dashboard-routes')];
    const payload = withFakeWaves(
        {
            getHorizon: () => { const e = new Error('ENOENT: no such file /tmp/x'); e.code = 'ENOENT'; throw e; },
        },
        () => {
            delete require.cache[require.resolve('../dashboard-routes')];
            return require('../dashboard-routes')._internal.buildWavesPayload();
        },
    );
    const serialized = JSON.stringify(payload);
    assert.equal(serialized.includes('ENOENT'), false);
    assert.equal(serialized.includes('/tmp/'), false);
});

// #3616 — Tests específicos del horizonte 5 y planned[].
test('#3616: buildWavesPayload expone planned[] con TODAS las olas del horizonte', () => {
    const fakeActive = {
        number: 10, name: 'Ola activa', goal: '', status: 'active',
        issues: [{ number: 1001, title: 'A', priority: 'medium', size: 'm', status: 'in-progress' }],
    };
    const planned1 = { number: 11, name: 'Próxima 1', goal: '', status: 'planned', issues: [] };
    const planned2 = { number: 12, name: 'Próxima 2', goal: '', status: 'planned', issues: [] };
    const planned3 = { number: 13, name: 'Próxima 3', goal: '', status: 'planned', issues: [] };
    const planned4 = { number: 14, name: 'Próxima 4', goal: '', status: 'planned', issues: [] };
    const planned5 = { number: 15, name: 'Próxima 5', goal: '', status: 'planned', issues: [] };
    delete require.cache[require.resolve('../dashboard-routes')];
    const payload = withFakeWaves(
        {
            getHorizon: (n) => {
                assert.equal(n, 5, 'dashboard debe pedir 5 olas del horizonte');
                return [fakeActive, planned1, planned2, planned3, planned4, planned5];
            },
        },
        () => {
            delete require.cache[require.resolve('../dashboard-routes')];
            return require('../dashboard-routes')._internal.buildWavesPayload();
        },
    );
    assert.equal(payload.active_wave.number, 10);
    assert.equal(payload.planned.length, 5);
    assert.equal(payload.planned[0].number, 11);
    assert.equal(payload.planned[4].number, 15);
    assert.equal(payload.next_wave.number, 11, 'next_wave debe ser la primera planificada por backward compat');
});

test('#3616: buildWavesPayload con ola activa + sin planned devuelve planned=[]', () => {
    const fakeActive = {
        number: 7, name: 'Sola', goal: '', status: 'active',
        issues: [{ number: 700, title: 'X', priority: 'low', size: 's', status: 'ready' }],
    };
    delete require.cache[require.resolve('../dashboard-routes')];
    const payload = withFakeWaves(
        { getHorizon: () => [fakeActive] },
        () => {
            delete require.cache[require.resolve('../dashboard-routes')];
            return require('../dashboard-routes')._internal.buildWavesPayload();
        },
    );
    assert.equal(payload.active_wave.number, 7);
    assert.deepEqual(payload.planned, []);
    assert.equal(payload.next_wave, null);
    assert.equal(payload.message, undefined, 'con activa NO debe mostrar mensaje vacío');
});

test('normalizeWave filtra issues inválidos y se queda con los válidos', () => {
    const { _internal } = fresh();
    const out = _internal.normalizeWave({
        number: 1,
        name: 'X',
        goal: 'Y',
        issues: [
            { number: 100, title: 'OK', priority: 'low', size: 's', status: 'ready' },
            { number: 'bad' }, // descartar
            null,              // descartar
            { number: 101, title: 'OK2', priority: 'high', size: 'l', status: 'in-progress' },
        ],
    });
    assert.equal(out.issues.length, 2);
    assert.equal(out.issues[0].id, 100);
    assert.equal(out.issues[1].id, 101);
});

// =============================================================================
// #4248 — Header de ola: status VIVO + openedAt.
//
// D1: el whitelist de status excluía 'planned' → issues de la ola activa se
//     servían como "unknown" → el header los contaba como cola (ENTREGADOS 0).
// D2: el status venía estático de waves.json (stale) en vez del estado real del
//     pipeline.
// D3: el payload no exponía `openedAt` → la velocidad (iss/h) mostraba siempre "—".
// =============================================================================

test('#4248 (D3): normalizeWave expone openedAt === started_at y conserva started_at', () => {
    const { _internal } = fresh();
    const out = _internal.normalizeWave({
        number: 7,
        name: 'Ola 7',
        goal: 'X',
        started_at: '2026-05-24T10:00:00Z',
        issues: [],
    });
    assert.equal(out.started_at, '2026-05-24T10:00:00Z', 'started_at se mantiene (backward-compat)');
    assert.equal(out.openedAt, '2026-05-24T10:00:00Z', 'openedAt alias de started_at');
});

test('#4248 (D3): openedAt es null cuando no hay started_at', () => {
    const { _internal } = fresh();
    const out = _internal.normalizeWave({ number: 7, name: 'X', goal: '', issues: [] });
    assert.equal(out.started_at, null);
    assert.equal(out.openedAt, null);
});

test('#4248: mapSnapshotStatusToWave traduce al vocabulario del header', () => {
    const { _internal } = fresh();
    const m = _internal.mapSnapshotStatusToWave;
    assert.equal(m('closed'), 'completed');
    assert.equal(m('dev'), 'in-progress');
    assert.equal(m('approval'), 'in-progress');
    assert.equal(m('definition'), 'in-progress');
    assert.equal(m('blocked'), 'blocked');
    assert.equal(m('paused'), 'blocked');
    assert.equal(m('pending'), 'queued'); // #4331 — sin fase iniciada = En cola, no Lista
    assert.equal(m('cualquier-cosa'), 'ready'); // default fail-safe se mantiene
});

// State realista para el snapshot: la ola activa nº2 tiene 3 issues que en
// waves.json figuran como "planned" pero en el pipeline están cerrado / en dev /
// pendiente. El enriquecimiento live debe reflejar el estado real.
function fakeStateConStatusVivo() {
    return {
        activeWave: { label: 'Ola 2', source: 'waves', issues: [4248, 100, 200] },
        bloqueados: [],
        issueMatrix: {
            // Cerrado: tiene desarrollo/entrega procesada+aprobada.
            4248: {
                title: 'Header de ola',
                labels: [],
                faseActual: 'desarrollo/entrega',
                estadoActual: 'procesado',
                fases: {
                    'desarrollo/entrega': [{ estado: 'procesado', resultado: 'aprobado' }],
                },
            },
            // En curso: agente trabajando en dev.
            100: {
                title: 'En dev',
                labels: [],
                faseActual: 'desarrollo/dev',
                estadoActual: 'trabajando',
                fases: {
                    'desarrollo/dev': [{ estado: 'trabajando', skill: 'pipeline-dev' }],
                },
            },
            // 200 no está en la matriz → pendiente (cola).
        },
    };
}

test('#4248 (D1+D2): enriquece status de la ola activa con el estado vivo del pipeline', () => {
    const fakeActive = {
        number: 2,
        name: 'Ola 2',
        goal: 'Rediseño dashboard',
        started_at: '2026-05-24T10:00:00Z',
        status: 'active',
        issues: [
            { number: 4248, title: 'Header', priority: 'medium', size: 's', status: 'planned' },
            { number: 100, title: 'En dev', priority: 'high', size: 'm', status: 'planned' },
            { number: 200, title: 'Pendiente', priority: 'low', size: 's', status: 'planned' },
        ],
    };
    delete require.cache[require.resolve('../dashboard-routes')];
    const payload = withFakeWaves(
        { getHorizon: () => [fakeActive] },
        () => {
            delete require.cache[require.resolve('../dashboard-routes')];
            return require('../dashboard-routes')._internal.buildWavesPayload(fakeStateConStatusVivo());
        },
    );
    const byId = new Map(payload.active_wave.issues.map((i) => [i.id, i.status]));
    assert.equal(byId.get(4248), 'completed', 'issue cerrado → completed (no queda en planned/unknown)');
    assert.equal(byId.get(100), 'in-progress', 'issue en dev → in-progress');
    assert.equal(byId.get(200), 'queued', '#4331 — issue sin actividad → queued (En cola), no ready/Lista');
    // openedAt presente para que el header calcule velocidad.
    assert.equal(payload.active_wave.openedAt, '2026-05-24T10:00:00Z');
    // El conteo del header (done) deja de ser 0 cuando hay avance real.
    const done = payload.active_wave.issues.filter((i) => i.status === 'completed').length;
    assert.equal(done, 1, 'ENTREGADOS refleja el cierre real, no 0/3');
});

test('#4248: el enriquecimiento NO propaga campos extra (sigue el whitelist por campo)', () => {
    const fakeActive = {
        number: 2, name: 'Ola 2', goal: '', started_at: '2026-05-24T10:00:00Z', status: 'active',
        issues: [{ number: 4248, title: 'H', priority: 'medium', size: 's', status: 'planned', notes: 'secreto' }],
    };
    delete require.cache[require.resolve('../dashboard-routes')];
    const payload = withFakeWaves(
        { getHorizon: () => [fakeActive] },
        () => {
            delete require.cache[require.resolve('../dashboard-routes')];
            return require('../dashboard-routes')._internal.buildWavesPayload(fakeStateConStatusVivo());
        },
    );
    const issue = payload.active_wave.issues[0];
    // #4250 — la ola activa ahora se enriquece al shape rico del board HOME
    // (agent/phase/hasLog/logFile/progress/merged) además de la base. El whitelist
    // por campo se mantiene: enrichWaveIssue reconstruye el objeto campo por campo,
    // así que campos crudos como `notes` siguen sin propagarse.
    assert.deepEqual(
        Object.keys(issue).sort(),
        ['agent', 'hasLog', 'id', 'logFile', 'merged', 'phase', 'priority', 'progress', 'size', 'status', 'title'],
    );
    assert.equal('notes' in issue, false, 'no debe propagar `notes` tras enriquecer');
});

test('#4248: sin state (o sin snapshot) degrada al status crudo normalizado', () => {
    const fakeActive = {
        number: 2, name: 'Ola 2', goal: '', started_at: '2026-05-24T10:00:00Z', status: 'active',
        issues: [{ number: 4248, title: 'H', priority: 'medium', size: 's', status: 'in-progress' }],
    };
    delete require.cache[require.resolve('../dashboard-routes')];
    const payload = withFakeWaves(
        { getHorizon: () => [fakeActive] },
        () => {
            delete require.cache[require.resolve('../dashboard-routes')];
            // Sin state → computeLiveWaveStatus devuelve null → status crudo.
            return require('../dashboard-routes')._internal.buildWavesPayload();
        },
    );
    assert.equal(payload.active_wave.issues[0].status, 'in-progress', 'mantiene status normalizado previo');
    assert.equal(payload.active_wave.openedAt, '2026-05-24T10:00:00Z', 'openedAt presente igual');
});

test('#4248: computeLiveWaveStatus devuelve null si no hay issueMatrix o ola activa', () => {
    const { _internal } = fresh();
    assert.equal(_internal.computeLiveWaveStatus(undefined), null);
    assert.equal(_internal.computeLiveWaveStatus({}), null);
    assert.equal(_internal.computeLiveWaveStatus({ issueMatrix: {} }), null, 'sin activeWave → null');
    assert.equal(
        _internal.computeLiveWaveStatus({ issueMatrix: { 1: {} }, activeWave: { issues: [] } }),
        null,
        'ola activa vacía → null',
    );
});

test('buildWavesPayload sin lib/waves cargada devuelve payload vacío sin throw', () => {
    // Simula que require('./waves') falló al cargar el módulo dashboard-routes
    // monkey-patcheando Module._load para tirar al resolver '../waves'. Esto
    // ejerce la rama "if (!waves)" del payload (CA-7), distinta del caso en el
    // que `waves` cargó OK pero getActiveWave() tira (cubierto por otro test).
    const Module = require('module');
    const wavesPath = require.resolve('../waves');
    const dashRoutesPath = require.resolve('../dashboard-routes');
    const originalWaves = require.cache[wavesPath];
    const originalDashRoutes = require.cache[dashRoutesPath];
    delete require.cache[wavesPath];
    delete require.cache[dashRoutesPath];
    const originalLoad = Module._load;
    Module._load = function patchedLoad(request, parent, isMain) {
        if (parent && parent.filename === dashRoutesPath && request === './waves') {
            throw new Error('simulado: waves no carga');
        }
        return originalLoad.call(this, request, parent, isMain);
    };
    try {
        const { _internal } = require('../dashboard-routes');
        const out = _internal.buildWavesPayload();
        assert.equal(out.active_wave, null);
        assert.equal(out.next_wave, null);
        assert.equal(out.message, 'Planificación no disponible');
        assert.ok(out.updated_at, 'updated_at debe estar presente');
    } finally {
        Module._load = originalLoad;
        delete require.cache[dashRoutesPath];
        if (originalWaves) require.cache[wavesPath] = originalWaves;
        if (originalDashRoutes) require.cache[dashRoutesPath] = originalDashRoutes;
    }
});
