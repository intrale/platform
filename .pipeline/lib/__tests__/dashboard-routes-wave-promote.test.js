// =============================================================================
// dashboard-routes-wave-promote.test.js — #4435 CA-1..CA-9.
//
// Endpoint mutante para promover una ola planificada → activa
// (POST /dashboard/wave/promote) con sincronización recursiva de la allowlist.
// Espejo de dashboard-routes-wave-archive.test.js. Verifica:
//   - Cinturón de gates replicado de handleWaveArchiveMutation:
//       método≠POST → 405 · no-loopback → 403 (REQ-SEC-1) · cross-site → 403
//       (REQ-SEC-1) · Content-Type≠json → 415 · waveNumber inválido → 400
//       (sin reflejar input — REQ-SEC-2/CA-6).
//   - Preview sin `confirmed` NO escribe (CA-4).
//   - PROMOTE_CAP_EXCEEDED cuando toAdd > cap sin mutar (CA-4).
//   - active_wave_exists → 409 cuando ya hay activa (CA-3).
//   - Confirmado promueve + sincroniza allowlist recursiva; cerrados NO (CA-1/CA-2).
//   - Actor fijo `operador-local` en la auditoría (CA-8).
//   - Ola inexistente → 404.
//
// Ejecutar:  node --test .pipeline/lib/__tests__/dashboard-routes-wave-promote.test.js
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'v3-wave-promote-'));
process.env.PIPELINE_DIR_OVERRIDE = TMP_DIR;

try { delete require.cache[require.resolve('../waves')]; } catch {}
try { delete require.cache[require.resolve('../partial-pause')]; } catch {}
try { delete require.cache[require.resolve('../dashboard-routes')]; } catch {}

const routes = require('../dashboard-routes');
const waves = require('../waves');
const handleWavePromoteMutation = routes._internal.handleWavePromoteMutation;
const WAVE_PROMOTE_CAP_ISSUES = routes._internal.WAVE_PROMOTE_CAP_ISSUES;

function seedWaves(state) {
    fs.writeFileSync(path.join(TMP_DIR, 'waves.json'), JSON.stringify(state, null, 2));
    waves.invalidateCache();
}
function readWaves() {
    return JSON.parse(fs.readFileSync(path.join(TMP_DIR, 'waves.json'), 'utf8'));
}
function readPartial() {
    const p = path.join(TMP_DIR, '.partial-pause.json');
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
}
// Estado base: SIN ola activa (promote sólo procede si no hay activa — CA-3),
// una planificada #8 con un issue abierto.
function baseState() {
    return {
        version: '1.0',
        meta: { created_at: '2026-06-20T10:00:00.000Z', updated_at: '2026-06-20T10:00:00.000Z', updated_by: 'System', source: 'manual' },
        active_wave: null,
        planned_waves: [{ number: 8, name: 'Ola 8', issues: [{ number: 200 }] }],
        archived_waves: [],
        dependencies: [],
    };
}

function makeReq({ method = 'POST', url = '/dashboard/wave/promote', remoteAddress = '127.0.0.1', headers = {} } = {}) {
    const req = new EventEmitter();
    req.method = method;
    req.url = url;
    req.headers = Object.assign({ 'content-type': 'application/json' }, headers);
    req.socket = { remoteAddress };
    req.destroy = () => {};
    return req;
}
function makeRes() {
    let resolve;
    const done = new Promise((r) => { resolve = r; });
    const res = {
        statusCode: null, headers: null, body: '',
        writeHead(status, headers) { this.statusCode = status; this.headers = headers; },
        end(chunk) { if (chunk) this.body += chunk; resolve(); },
        done,
    };
    return res;
}
async function invoke(reqOpts, body) {
    const req = makeReq(reqOpts);
    const res = makeRes();
    const handled = handleWavePromoteMutation(req, res);
    if (body !== undefined) {
        process.nextTick(() => {
            req.emit('data', Buffer.from(body));
            req.emit('end');
        });
    }
    await res.done;
    return { handled, res };
}

test('ruta ajena no se maneja (devuelve false)', () => {
    const req = makeReq({ url: '/api/dash/header' });
    const res = makeRes();
    assert.equal(handleWavePromoteMutation(req, res), false);
});

test('método incorrecto → 405', async () => {
    seedWaves(baseState());
    const { handled, res } = await invoke({ method: 'GET' });
    assert.equal(handled, true);
    assert.equal(res.statusCode, 405);
});

test('no-loopback → 403 (REQ-SEC-1/7)', async () => {
    seedWaves(baseState());
    const { res } = await invoke({ remoteAddress: '10.0.0.5' });
    assert.equal(res.statusCode, 403);
});

test('cross-site (Sec-Fetch-Site) → 403 (anti-CSRF, REQ-SEC-1)', async () => {
    seedWaves(baseState());
    const { res } = await invoke({ headers: { 'sec-fetch-site': 'cross-site' } });
    assert.equal(res.statusCode, 403);
});

test('Content-Type no JSON → 415', async () => {
    seedWaves(baseState());
    const { res } = await invoke({ headers: { 'content-type': 'text/plain' } });
    assert.equal(res.statusCode, 415);
});

test('waveNumber inválido (float/string/≤0/null) → 400 sin mutar (REQ-SEC-2/CA-6)', async () => {
    for (const bad of [1.5, '8', 0, -3, null]) {
        seedWaves(baseState());
        const { res } = await invoke({}, JSON.stringify({ waveNumber: bad }));
        assert.equal(res.statusCode, 400, `esperaba 400 para ${JSON.stringify(bad)}`);
        // No mutó: la planificada sigue, no hay activa.
        const st = readWaves();
        assert.equal(st.active_wave, null);
        assert.ok(st.planned_waves.find((w) => w.number === 8));
    }
});

test('preview sin confirmed NO escribe + devuelve total (CA-4)', async () => {
    seedWaves(baseState());
    const { res } = await invoke({}, JSON.stringify({ waveNumber: 8 }));
    assert.equal(res.statusCode, 200);
    const payload = JSON.parse(res.body);
    assert.equal(payload.preview, true);
    assert.equal(payload.total, 1);
    assert.deepEqual(payload.toAdd, [200]);
    // NO mutó: sigue sin activa, planificada intacta, sin partial-pause escrito.
    const st = readWaves();
    assert.equal(st.active_wave, null);
    assert.ok(st.planned_waves.find((w) => w.number === 8));
    assert.equal(readPartial(), null);
});

test('PROMOTE_CAP_EXCEEDED cuando toAdd > cap, sin mutar (CA-4)', async () => {
    const s = baseState();
    // Planificada con cap+1 issues abiertos → supera el tope.
    const many = [];
    for (let i = 0; i < WAVE_PROMOTE_CAP_ISSUES + 1; i++) many.push({ number: 1000 + i });
    s.planned_waves = [{ number: 8, name: 'Ola 8', issues: many }];
    seedWaves(s);
    const { res } = await invoke({}, JSON.stringify({ waveNumber: 8, confirmed: true }));
    assert.equal(res.statusCode, 409);
    const payload = JSON.parse(res.body);
    assert.equal(payload.error, 'PROMOTE_CAP_EXCEEDED');
    assert.equal(payload.applied, false);
    assert.equal(payload.total, WAVE_PROMOTE_CAP_ISSUES + 1);
    // NO mutó.
    const st = readWaves();
    assert.equal(st.active_wave, null);
    assert.ok(st.planned_waves.find((w) => w.number === 8));
});

test('active_wave_exists → 409 cuando ya hay activa (CA-3)', async () => {
    const s = baseState();
    s.active_wave = { number: 7, name: 'Ola 7', started_at: '2026-06-20T10:00:00.000Z', issues: [{ number: 100, status: 'in-progress' }] };
    seedWaves(s);
    const { res } = await invoke({}, JSON.stringify({ waveNumber: 8, confirmed: true }));
    assert.equal(res.statusCode, 409);
    assert.equal(JSON.parse(res.body).error, 'active_wave_exists');
    // No promovió: la activa sigue siendo #7, #8 sigue planificada.
    const st = readWaves();
    assert.equal(st.active_wave.number, 7);
    assert.ok(st.planned_waves.find((w) => w.number === 8));
});

test('ola planificada inexistente → 404 not_found', async () => {
    seedWaves(baseState());
    const { res } = await invoke({}, JSON.stringify({ waveNumber: 99, confirmed: true }));
    assert.equal(res.statusCode, 404);
    assert.equal(JSON.parse(res.body).error, 'not_found');
});

test('confirmado promueve + sincroniza allowlist recursiva; cerrados NO (CA-1/CA-2/CA-8)', async () => {
    const s = baseState();
    // Grafo: 200 → (bloqueado por) 201 → (bloqueado por) 202.
    // 202 está CERRADO (status completed en una ola archivada) → NO entra (CA-2).
    s.planned_waves = [{ number: 8, name: 'Ola 8', issues: [{ number: 200 }] }];
    s.archived_waves = [{ number: 6, name: 'Ola 6', issues: [{ number: 202, status: 'completed' }] }];
    s.dependencies = [
        { blocker: 201, blocked: 200 },
        { blocker: 202, blocked: 201 },
    ];
    seedWaves(s);

    const { res } = await invoke({}, JSON.stringify({ waveNumber: 8, confirmed: true }));
    assert.equal(res.statusCode, 200);
    const payload = JSON.parse(res.body);
    assert.equal(payload.ok, true);
    assert.equal(payload.applied, true);
    assert.equal(payload.actor, 'operador-local');

    // Estado: #8 pasó a activa.
    const st = readWaves();
    assert.ok(st.active_wave && st.active_wave.number === 8);
    assert.equal(st.planned_waves.find((w) => w.number === 8), undefined);
    // Auditoría con actor fijo server-side (nunca del body) — CA-8.
    assert.equal(st.meta.updated_by, 'operador-local');

    // Allowlist recursiva: 200 (seed) + 201 (dep abierta). 202 cerrado NO entra.
    const pp = readPartial();
    assert.ok(pp, '.partial-pause.json debe existir tras el promote');
    assert.deepEqual(pp.allowed_issues, [200, 201]);
});

test('cleanup', () => {
    delete process.env.PIPELINE_DIR_OVERRIDE;
    try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch {}
});
