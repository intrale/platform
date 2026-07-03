// =============================================================================
// dashboard-routes-wave-lifecycle.test.js — #4436.
//
// Endpoints mutantes de ciclo de vida de la ola activa desde la ventana Roadmap:
//   POST /dashboard/wave/pause    → setFullPause (halt total)   CA-1
//   POST /dashboard/wave/resume   → resumeAll                   CA-2
//   POST /dashboard/wave/dispatch → realign de la ola activa    CA-3
//
// Verifica, por endpoint (los 6 REQ-SEC de `security`):
//   - Cinturón de gates calcado de handleWaveArchiveMutation:
//       método≠POST → 405 · no-loopback → 403 · cross-site → 403 ·
//       Content-Type≠json → 415 · body sobre cap → 413 · malformado → 400.
//   - Happy path → 200 invocando el primitivo correcto con el `authorizedBy`
//     FIJO server-side esperado (pause/resume/dispatch:dashboard), auditado.
//   - La mutación pasa SIEMPRE por lib/partial-pause.js (single-writer): se
//     observan los markers reales (.paused / .partial-pause.json), nunca escritos
//     directo por la ruta.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'v3-wave-lifecycle-'));
process.env.PIPELINE_DIR_OVERRIDE = TMP_DIR;

try { delete require.cache[require.resolve('../waves')]; } catch {}
try { delete require.cache[require.resolve('../dashboard-routes')]; } catch {}

const routes = require('../dashboard-routes');
const waves = require('../waves');
const handlePause = routes._internal.handleWavePauseMutation;
const handleResume = routes._internal.handleWaveResumeMutation;
const handleDispatch = routes._internal.handleWaveDispatchMutation;

const PAUSE_FILE = path.join(TMP_DIR, '.paused');
const PARTIAL_FILE = path.join(TMP_DIR, '.partial-pause.json');
const AUDIT_FILE = path.join(TMP_DIR, 'audit', 'partial-pause-mutations.jsonl');

function seedWaves(state) {
    fs.writeFileSync(path.join(TMP_DIR, 'waves.json'), JSON.stringify(state, null, 2));
    waves.invalidateCache();
}
function baseState() {
    return {
        version: '1.0',
        meta: { created_at: '2026-07-01T10:00:00.000Z', updated_at: '2026-07-01T10:00:00.000Z', updated_by: 'System', source: 'manual' },
        active_wave: { number: 8, name: 'Ola 8', started_at: '2026-07-01T10:00:00.000Z', issues: [{ number: 100, status: 'in-progress' }, { number: 101, status: 'completed' }] },
        planned_waves: [],
        archived_waves: [],
        dependencies: [],
    };
}
function cleanMarkers() {
    try { fs.unlinkSync(PAUSE_FILE); } catch {}
    try { fs.unlinkSync(PARTIAL_FILE); } catch {}
}
function readAudit() {
    try { return fs.readFileSync(AUDIT_FILE, 'utf8'); } catch { return ''; }
}

function makeReq({ method = 'POST', url = '/dashboard/wave/pause', remoteAddress = '127.0.0.1', headers = {} } = {}) {
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
async function invoke(handler, reqOpts, body) {
    const req = makeReq(reqOpts);
    const res = makeRes();
    const handled = handler(req, res);
    if (body !== undefined) {
        process.nextTick(() => {
            req.emit('data', Buffer.from(body));
            req.emit('end');
        });
    }
    await res.done;
    return { handled, res };
}

// Tabla de los 3 endpoints para reutilizar los tests de gates.
const ENDPOINTS = [
    { name: 'pause', handler: handlePause, url: '/dashboard/wave/pause' },
    { name: 'resume', handler: handleResume, url: '/dashboard/wave/resume' },
    { name: 'dispatch', handler: handleDispatch, url: '/dashboard/wave/dispatch' },
];

for (const ep of ENDPOINTS) {
    test(`[${ep.name}] ruta ajena no se maneja (devuelve false)`, () => {
        const req = makeReq({ url: '/api/dash/header' });
        const res = makeRes();
        assert.equal(ep.handler(req, res), false);
    });

    test(`[${ep.name}] método≠POST → 405 (REQ-SEC-1)`, async () => {
        const { handled, res } = await invoke(ep.handler, { method: 'GET', url: ep.url });
        assert.equal(handled, true);
        assert.equal(res.statusCode, 405);
    });

    test(`[${ep.name}] no-loopback → 403 (REQ-SEC-2/7)`, async () => {
        const { res } = await invoke(ep.handler, { url: ep.url, remoteAddress: '10.0.0.5' });
        assert.equal(res.statusCode, 403);
    });

    test(`[${ep.name}] cross-site → 403 (anti-CSRF, REQ-SEC-1)`, async () => {
        const { res } = await invoke(ep.handler, { url: ep.url, headers: { 'sec-fetch-site': 'cross-site' } });
        assert.equal(res.statusCode, 403);
    });

    test(`[${ep.name}] Content-Type≠JSON → 415 (REQ-SEC-1)`, async () => {
        const { res } = await invoke(ep.handler, { url: ep.url, headers: { 'content-type': 'text/plain' } });
        assert.equal(res.statusCode, 415);
    });

    test(`[${ep.name}] body sobre cap → 413 (REQ-SEC-4)`, async () => {
        seedWaves(baseState());
        cleanMarkers();
        const huge = JSON.stringify({ pad: 'x'.repeat(5000) });
        const { res } = await invoke(ep.handler, { url: ep.url }, huge);
        assert.equal(res.statusCode, 413);
    });

    test(`[${ep.name}] body malformado → 400 (REQ-SEC-4)`, async () => {
        seedWaves(baseState());
        cleanMarkers();
        const { res } = await invoke(ep.handler, { url: ep.url }, '{not-json');
        assert.equal(res.statusCode, 400);
    });
}

// --- Happy paths + efecto real sobre los markers (single-writer) ---

test('[pause] happy path → 200 + .paused creado + audit authorizedBy pause:dashboard (CA-1/REQ-SEC-6)', async () => {
    seedWaves(baseState());
    cleanMarkers();
    const { res } = await invoke(handlePause, { url: '/dashboard/wave/pause' }, '{}');
    assert.equal(res.statusCode, 200);
    const payload = JSON.parse(res.body);
    assert.equal(payload.ok, true);
    assert.equal(payload.applied, true);
    assert.equal(payload.authorizedBy, 'pause:dashboard');
    assert.ok(fs.existsSync(PAUSE_FILE), 'marker .paused escrito por partial-pause.js');
    assert.ok(readAudit().includes('"authorized_by":"pause:dashboard"'), 'audit registra el authorizedBy fijo');
});

test('[resume] happy path (tras pause) → 200 + .paused removido (CA-2/REQ-SEC-6)', async () => {
    seedWaves(baseState());
    cleanMarkers();
    await invoke(handlePause, { url: '/dashboard/wave/pause' }, '{}');
    assert.ok(fs.existsSync(PAUSE_FILE));
    const { res } = await invoke(handleResume, { url: '/dashboard/wave/resume' }, '{}');
    assert.equal(res.statusCode, 200);
    const payload = JSON.parse(res.body);
    assert.equal(payload.ok, true);
    assert.equal(payload.authorizedBy, 'resume:dashboard');
    assert.equal(payload.removedFull, true);
    assert.equal(fs.existsSync(PAUSE_FILE), false, 'marker .paused removido');
});

test('[dispatch] happy path → 200 + .partial-pause.json con la allowlist + audit dispatch:dashboard (CA-3/REQ-SEC-6)', async () => {
    seedWaves(baseState());
    cleanMarkers();
    const { res } = await invoke(handleDispatch, { url: '/dashboard/wave/dispatch' }, '{}');
    assert.equal(res.statusCode, 200);
    const payload = JSON.parse(res.body);
    assert.equal(payload.ok, true);
    assert.equal(payload.applied, true);
    assert.equal(payload.activeWave, 8);
    assert.equal(payload.authorizedBy, 'dispatch:dashboard');
    assert.ok(fs.existsSync(PARTIAL_FILE), 'marker .partial-pause.json escrito por partial-pause.js');
    // Sólo el issue ABIERTO (100) entra; el completado (101) queda fuera.
    const partial = JSON.parse(fs.readFileSync(PARTIAL_FILE, 'utf8'));
    assert.deepEqual(partial.allowed_issues, [100], 'allowlist re-materializada a los abiertos de la ola');
    assert.ok(readAudit().includes('"authorized_by":"dispatch:dashboard"'), 'audit registra el authorizedBy fijo');
});

test('[dispatch] sin ola activa → 409 no_active_wave', async () => {
    const s = baseState();
    delete s.active_wave;
    seedWaves(s);
    cleanMarkers();
    const { res } = await invoke(handleDispatch, { url: '/dashboard/wave/dispatch' }, '{}');
    assert.equal(res.statusCode, 409);
    assert.equal(JSON.parse(res.body).error, 'no_active_wave');
});

test('handle() enruta los 3 endpoints ANTES del gate GET-only', () => {
    for (const ep of ENDPOINTS) {
        const req = makeReq({ method: 'PUT', url: ep.url }); // PUT: pasa el match de ruta, cae en gate 405
        const res = makeRes();
        const handled = routes.handle(req, res, { getState: () => ({}) });
        assert.equal(handled, true, `${ep.name} manejado por handle()`);
        assert.equal(res.statusCode, 405, `${ep.name} rechaza método no-POST`);
    }
});

test('cleanup', () => {
    delete process.env.PIPELINE_DIR_OVERRIDE;
    try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch {}
});
