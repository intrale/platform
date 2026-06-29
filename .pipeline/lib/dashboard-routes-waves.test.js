'use strict';

// #4248 — Tests del payload de /api/dash/waves (encabezado de ola MIZPÁ).
// Cubren los 3 defectos detectados por guru/arquitecto:
//   D1 — issues `planned` deben mapear a un status que el header cuenta
//        (no quedar en `unknown`→queue cuando están cerrados/en curso).
//   D2 — el status por-issue se enriquece en vivo contra el estado real del
//        pipeline (buildWaveSnapshot), no contra el status estático de waves.json.
//   D3 — el payload expone `openedAt` (mapeado desde `started_at`) manteniendo
//        `started_at` por backward-compat (la vista issues lo consume).
//
// Aislados: no tocan el FS real ni levantan el dashboard. Se ejercita la lógica
// pura exportada en `_internal`.

const test = require('node:test');
const assert = require('node:assert');

const { _internal } = require('./dashboard-routes');
const {
    normalizeWave,
    deriveLiveStatus,
    enrichActiveWaveStatus,
    buildWavesPayload,
    WAVES_STATUS_WHITELIST,
} = _internal;

// ── D3 — normalizeWave expone openedAt sin perder started_at ────────────────

test('normalizeWave mapea started_at a openedAt manteniendo started_at', () => {
    const norm = normalizeWave({
        number: 7,
        name: 'Ola 7.2',
        goal: 'rediseño dashboard',
        started_at: '2026-06-20T10:00:00.000Z',
        issues: [{ number: 101, status: 'planned' }],
    });
    assert.ok(norm, 'normalizeWave devuelve la ola');
    assert.strictEqual(norm.openedAt, '2026-06-20T10:00:00.000Z', 'openedAt === started_at');
    assert.strictEqual(norm.started_at, '2026-06-20T10:00:00.000Z', 'started_at se mantiene (backward-compat)');
});

test('normalizeWave deja openedAt en null cuando no hay started_at', () => {
    const norm = normalizeWave({ number: 1, name: 'x', goal: 'y', issues: [] });
    assert.strictEqual(norm.started_at, null);
    assert.strictEqual(norm.openedAt, null);
});

// ── D1 — `planned` y `pending` están en el whitelist (fallback degradado) ────

test('WAVES_STATUS_WHITELIST incluye planned y pending', () => {
    assert.ok(WAVES_STATUS_WHITELIST.has('planned'), 'planned whitelisted');
    assert.ok(WAVES_STATUS_WHITELIST.has('pending'), 'pending whitelisted');
});

// ── D1+D2 — deriveLiveStatus traduce el status del snapshot ─────────────────

test('deriveLiveStatus traduce los status del snapshot a la vocabulario del header', () => {
    assert.strictEqual(deriveLiveStatus({ isClosed: true, status: 'closed' }), 'completed');
    assert.strictEqual(deriveLiveStatus({ status: 'closed' }), 'completed');
    assert.strictEqual(deriveLiveStatus({ isBlocked: true, status: 'blocked' }), 'blocked');
    assert.strictEqual(deriveLiveStatus({ status: 'paused' }), 'blocked');
    assert.strictEqual(deriveLiveStatus({ status: 'dev' }), 'in-progress');
    assert.strictEqual(deriveLiveStatus({ status: 'approval' }), 'in-progress');
    assert.strictEqual(deriveLiveStatus({ status: 'definition' }), 'in-progress');
    assert.strictEqual(deriveLiveStatus({ status: 'pending' }), 'ready');
    // Sin clasificar / input inválido → null (deja el status previo intacto).
    assert.strictEqual(deriveLiveStatus(null), null);
    assert.strictEqual(deriveLiveStatus({ status: 'rarito' }), null);
});

test('deriveLiveStatus sólo emite valores ya whitelisteados (no rompe vista issues)', () => {
    const emitted = ['completed', 'blocked', 'in-progress', 'ready'];
    for (const v of emitted) {
        assert.ok(WAVES_STATUS_WHITELIST.has(v), `${v} está en el whitelist`);
    }
});

// ── D1+D2 — enrichActiveWaveStatus cruza con el estado real del pipeline ─────

function fakeState() {
    return {
        issueMatrix: {
            // En curso (fase dev, agente trabajando) → in-progress.
            '101': {
                fases: { 'desarrollo/dev': [{ estado: 'trabajando', skill: 'pipeline-dev' }] },
                faseActual: 'desarrollo/dev',
                estadoActual: 'trabajando',
                labels: [],
                staleMin: 0,
                bounces: 0,
                title: 'issue en dev',
            },
            // Bloqueado por needs-human → blocked.
            '102': {
                fases: { 'desarrollo/dev': [{ estado: 'pendiente' }] },
                faseActual: 'desarrollo/dev',
                estadoActual: 'pendiente',
                labels: ['needs-human'],
                staleMin: 0,
                bounces: 0,
                title: 'issue bloqueado',
            },
            // Sin fase actual (en matriz pero pendiente de arranque) → pending→ready.
            '104': {
                fases: {},
                faseActual: null,
                estadoActual: null,
                labels: [],
                staleMin: 0,
                bounces: 0,
                title: 'issue pending',
            },
        },
        // 103 cerrado en GitHub (no está en la matriz) → completed.
        issueTitles: { '103': { state: 'CLOSED', title: 'issue cerrado', labels: [] } },
        bloqueados: [],
    };
}

test('enrichActiveWaveStatus mapea status real (planned ya no queda en 0)', () => {
    const raw = {
        number: 7,
        name: 'Ola 7.2',
        goal: 'rediseño',
        started_at: '2026-06-20T10:00:00.000Z',
        issues: [
            { number: 101, status: 'planned' },
            { number: 102, status: 'planned' },
            { number: 103, status: 'planned' },
            { number: 104, status: 'planned' },
            { number: 105, status: 'planned' }, // ni en matriz ni cerrado → pending→ready
        ],
    };
    const norm = normalizeWave(raw);
    // Pre-condición: sin enriquecer, todos quedan 'planned' (no contados como done).
    assert.deepStrictEqual(norm.issues.map((i) => i.status), ['planned', 'planned', 'planned', 'planned', 'planned']);

    const enriched = enrichActiveWaveStatus(norm, fakeState());
    const byId = new Map(enriched.issues.map((i) => [i.id, i.status]));
    assert.strictEqual(byId.get(101), 'in-progress');
    assert.strictEqual(byId.get(102), 'blocked');
    assert.strictEqual(byId.get(103), 'completed');
    assert.strictEqual(byId.get(104), 'ready');
    assert.strictEqual(byId.get(105), 'ready');

    // El conteo que hace home.js (_mzMirrorMission) sobre estos status:
    let done = 0, active = 0, blocked = 0, queue = 0;
    for (const it of enriched.issues) {
        if (it.status === 'completed') done++;
        else if (it.status === 'in-progress') active++;
        else if (it.status === 'blocked') blocked++;
        else queue++;
    }
    assert.strictEqual(done, 1, 'ENTREGADOS refleja el cerrado real (≠ 0)');
    assert.strictEqual(active, 1);
    assert.strictEqual(blocked, 1);
    assert.strictEqual(queue, 2);
    const total = enriched.issues.length;
    assert.strictEqual(Math.round((done / total) * 100), 20, 'AVANCE = round(done/total*100)');
});

test('enrichActiveWaveStatus preserva campos normalizados y openedAt', () => {
    const norm = normalizeWave({
        number: 7, name: 'Ola 7.2', goal: 'g', started_at: '2026-06-20T10:00:00.000Z',
        issues: [{ number: 101, title: 'T', priority: 'high', size: 'm', status: 'planned' }],
    });
    const enriched = enrichActiveWaveStatus(norm, fakeState());
    assert.strictEqual(enriched.openedAt, '2026-06-20T10:00:00.000Z');
    assert.strictEqual(enriched.started_at, '2026-06-20T10:00:00.000Z');
    const it = enriched.issues[0];
    assert.strictEqual(it.id, 101);
    assert.strictEqual(it.title, 'T');
    assert.strictEqual(it.priority, 'high');
    assert.strictEqual(it.size, 'm');
    assert.strictEqual(it.status, 'in-progress');
});

test('enrichActiveWaveStatus degrada sin tocar la ola cuando no hay state/snapshot', () => {
    const norm = normalizeWave({
        number: 7, name: 'x', goal: 'y', started_at: '2026-06-20T10:00:00.000Z',
        issues: [{ number: 101, status: 'planned' }],
    });
    // Sin state → devuelve la ola tal cual (status estático whitelisteado).
    const same = enrichActiveWaveStatus(norm, null);
    assert.strictEqual(same.issues[0].status, 'planned');
    // State sin issueMatrix → también degrada.
    const same2 = enrichActiveWaveStatus(norm, { issueTitles: {} });
    assert.strictEqual(same2.issues[0].status, 'planned');
    // Ola null/sin issues → no rompe.
    assert.strictEqual(enrichActiveWaveStatus(null, fakeState()), null);
});

// ── Integración liviana — buildWavesPayload no rompe con/ sin state ──────────

test('buildWavesPayload retorna shape estable y expone openedAt en la ola activa', () => {
    for (const arg of [undefined, { state: null }, { state: { issueMatrix: {} } }]) {
        const payload = buildWavesPayload(arg);
        assert.ok(payload && typeof payload === 'object', 'payload es objeto');
        assert.ok('active_wave' in payload, 'tiene active_wave');
        assert.ok('planned' in payload, 'tiene planned');
        assert.ok('updated_at' in payload, 'tiene updated_at');
        if (payload.active_wave) {
            assert.ok('openedAt' in payload.active_wave, 'active_wave expone openedAt (D3)');
            assert.ok('started_at' in payload.active_wave, 'active_wave mantiene started_at (backward-compat)');
        }
    }
});
