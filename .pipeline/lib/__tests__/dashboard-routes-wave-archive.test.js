// =============================================================================
// dashboard-routes-wave-archive.test.js — #4378 CA-7/CA-8.
//
// Endpoint mutante para archivar una ola (POST /dashboard/wave/archive) +
// vista roadmap. Verifica:
//   - Cinturón de gates replicado de handleBudgetMutation:
//       método≠POST → 405 · no-loopback → 403 · cross-site → 403 ·
//       Content-Type≠json → 415 · waveNumber inválido → 400 (sin reflejar input).
//   - Archivado exitoso → 200 + waves.archiveWave llamado (actor fijo).
//   - A04 (activa in-flight) → 409 active_in_flight.
//   - Vista roadmap: SSR de las tres secciones + escape anti-XSS (CA-8).
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'v3-wave-archive-'));
process.env.PIPELINE_DIR_OVERRIDE = TMP_DIR;

try { delete require.cache[require.resolve('../waves')]; } catch {}
try { delete require.cache[require.resolve('../dashboard-routes')]; } catch {}

const routes = require('../dashboard-routes');
const waves = require('../waves');
const handleWaveArchiveMutation = routes._internal.handleWaveArchiveMutation;

function seedWaves(state) {
    fs.writeFileSync(path.join(TMP_DIR, 'waves.json'), JSON.stringify(state, null, 2));
    waves.invalidateCache();
}
function readWaves() {
    return JSON.parse(fs.readFileSync(path.join(TMP_DIR, 'waves.json'), 'utf8'));
}
function baseState() {
    return {
        version: '1.0',
        meta: { created_at: '2026-06-20T10:00:00.000Z', updated_at: '2026-06-20T10:00:00.000Z', updated_by: 'System', source: 'manual' },
        active_wave: { number: 7, name: 'Ola 7', started_at: '2026-06-20T10:00:00.000Z', issues: [{ number: 100, status: 'completed' }] },
        planned_waves: [{ number: 8, name: 'Ola 8', issues: [{ number: 200 }] }],
        archived_waves: [],
        dependencies: [],
    };
}

function makeReq({ method = 'POST', url = '/dashboard/wave/archive', remoteAddress = '127.0.0.1', headers = {} } = {}) {
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
    const handled = handleWaveArchiveMutation(req, res);
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
    assert.equal(handleWaveArchiveMutation(req, res), false);
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

test('cross-site (Sec-Fetch-Site) → 403 (anti-CSRF)', async () => {
    seedWaves(baseState());
    const { res } = await invoke({ headers: { 'sec-fetch-site': 'cross-site' } });
    assert.equal(res.statusCode, 403);
});

test('Content-Type no JSON → 415', async () => {
    seedWaves(baseState());
    const { res } = await invoke({ headers: { 'content-type': 'text/plain' } });
    assert.equal(res.statusCode, 415);
});

test('waveNumber inválido (float/string/≤0) → 400 sin mutar', async () => {
    for (const bad of [1.5, '8', 0, -3, null]) {
        seedWaves(baseState());
        const { res } = await invoke({}, JSON.stringify({ waveNumber: bad }));
        assert.equal(res.statusCode, 400, `esperaba 400 para ${JSON.stringify(bad)}`);
        assert.equal(readWaves().archived_waves.length, 0);
    }
});

test('archivado exitoso de una planificada → 200 + waves.json mutado por waves.js', async () => {
    seedWaves(baseState());
    const { res } = await invoke({}, JSON.stringify({ waveNumber: 8 }));
    assert.equal(res.statusCode, 200);
    const payload = JSON.parse(res.body);
    assert.equal(payload.ok, true);
    assert.equal(payload.actor, 'operador-local');
    const state = readWaves();
    assert.equal(state.planned_waves.find((w) => w.number === 8), undefined);
    assert.ok(state.archived_waves.find((w) => w.number === 8));
    // Auditoría con actor fijo server-side (nunca del body).
    assert.equal(state.meta.updated_by, 'operador-local');
});

test('A04 — archivar la activa con issues no cerrados → 409 active_in_flight', async () => {
    const s = baseState();
    s.active_wave.issues = [{ number: 100, status: 'in-progress' }];
    seedWaves(s);
    const { res } = await invoke({}, JSON.stringify({ waveNumber: 7 }));
    assert.equal(res.statusCode, 409);
    assert.equal(JSON.parse(res.body).error, 'active_in_flight');
    // No mutó.
    assert.ok(readWaves().active_wave && readWaves().active_wave.number === 7);
});

test('ola inexistente → 404 not_found', async () => {
    seedWaves(baseState());
    const { res } = await invoke({}, JSON.stringify({ waveNumber: 99 }));
    assert.equal(res.statusCode, 404);
    assert.equal(JSON.parse(res.body).error, 'not_found');
});

test('CA-8 — la vista roadmap escapa name/goal/título de issue (anti-XSS)', () => {
    const html = routes.VIEW_SLUGS.roadmap.render({
        wavesState: {
            active_wave: { number: 7, name: '<script>alert(1)</script>', goal: 'g&<b>', issues: [{ number: 100, status: 'completed', title: '"><img src=x onerror=alert(1)>' }] },
            planned_waves: [{ number: 8, name: 'Ola 8', issues: [{ number: 200 }] }],
            archived_waves: [{ number: 6, name: 'Ola 6', issues: [{ number: 50 }], issues_completed: 3 }],
        },
    }, {});
    assert.equal(html.includes('<script>alert(1)</script>'), false, 'no debe haber <script> crudo');
    assert.ok(html.includes('&lt;script&gt;'), 'script escapado');
    assert.equal(/onerror=alert\(1\)>/.test(html) && !html.includes('&lt;img'), false);
    assert.ok(html.includes('&lt;img src=x'), 'img escapado');
    assert.ok(html.includes('data-slug="roadmap"'));
});

test('cleanup', () => {
    delete process.env.PIPELINE_DIR_OVERRIDE;
    try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch {}
});
