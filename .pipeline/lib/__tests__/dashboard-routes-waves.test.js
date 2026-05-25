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
    assert.equal(payload.message, 'Planificación no disponible');
    assert.equal(typeof payload.updated_at, 'string');
});

test('buildWavesPayload retorna active + next normalizados sin propagar extras', () => {
    const fakeActive = {
        number: 7,
        name: 'Ola 7',
        goal: 'Cerrar épico #3378',
        started_at: '2026-05-24T10:00:00Z',
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
        issues: [
            { number: 3500, title: 'API health', priority: 'high', size: 'l', status: 'needs-def' },
        ],
    };
    delete require.cache[require.resolve('../dashboard-routes')];
    const payload = withFakeWaves(
        {
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
    assert.equal(payload.message, undefined);
});

test('buildWavesPayload degrada a payload vacío si getActiveWave tira', () => {
    delete require.cache[require.resolve('../dashboard-routes')];
    const payload = withFakeWaves(
        {
            getActiveWave: () => { throw new Error('disk on fire'); },
            getPlannedWave: () => null,
        },
        () => {
            delete require.cache[require.resolve('../dashboard-routes')];
            return require('../dashboard-routes')._internal.buildWavesPayload();
        },
    );
    assert.equal(payload.active_wave, null);
    assert.equal(payload.next_wave, null);
    assert.equal(payload.message, 'Planificación no disponible');
});

test('buildWavesPayload nunca expone paths/ENOENT en el payload', () => {
    delete require.cache[require.resolve('../dashboard-routes')];
    const payload = withFakeWaves(
        {
            getActiveWave: () => { const e = new Error('ENOENT: no such file /tmp/x'); e.code = 'ENOENT'; throw e; },
            getPlannedWave: () => null,
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
