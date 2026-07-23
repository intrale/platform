'use strict';

// =============================================================================
// dashboard-waves-endpoints.test.js — #4433
//
// Cubre los 3 endpoints de gestión de olas cableados a la ventana Roadmap del
// dashboard, levantando el dashboard REAL sobre un PIPELINE_DIR_OVERRIDE
// temporal (mismo patrón que dashboard-state-hotpath.test.js):
//   - POST /api/waves                      → crear ola planificada (CA-1/CA-2)
//   - POST /api/waves/:num/issues          → asociar issue (CA-3/CA-4)
//   - POST /api/waves/:num/issues/:i/remove→ desasociar (CA-5/CA-6)
//
// Contratos verificados:
//   1. CSRF ausente → 403 (fail-closed, CA-7).
//   2. payload inválido (validateCreateInput falla) → 400 con field/msg y SIN
//      escribir el state (CA-2).
//   3. happy path create → 200, ola planificada creada con defaults server-side
//      (concurrency/window) (CA-1).
//   4. asociar issue inválido → 4xx claro, ola sin modificar (CA-4).
//   5. desasociar sobre la ola ACTIVA → 4xx EWAVES_ACTIVE_LOCKED, sin forzar
//      (CA-6/REQ-SEC-4).
// =============================================================================

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const { getFreePort } = require('./helpers/free-port');

const PIPELINE_SRC = path.resolve(__dirname, '..');
const dashboardPath = path.join(PIPELINE_SRC, 'dashboard.js');

let tmpDir, child, port;
const LOCAL_HTTP_TIMEOUT_MS = 15000;

function mkdirp(p) { fs.mkdirSync(p, { recursive: true }); }

function readWaves() {
    return JSON.parse(fs.readFileSync(path.join(tmpDir, 'waves.json'), 'utf8'));
}

// GET simple (para /api/health y para pedir el token CSRF).
function httpGet(urlPath) {
    return new Promise((resolve, reject) => {
        http.get({ host: '127.0.0.1', port, path: urlPath, timeout: LOCAL_HTTP_TIMEOUT_MS }, (res) => {
            let data = '';
            res.on('data', (c) => { data += c; });
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
        }).on('error', reject).on('timeout', function () { this.destroy(); reject(new Error('timeout')); });
    });
}

// POST JSON con headers arbitrarios (para inyectar/omitir el CSRF).
function httpPost(urlPath, payload, headers) {
    return new Promise((resolve, reject) => {
        const body = payload === undefined ? '' : JSON.stringify(payload);
        const req = http.request({
            host: '127.0.0.1', port, path: urlPath, method: 'POST', timeout: LOCAL_HTTP_TIMEOUT_MS,
            headers: Object.assign({ 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }, headers || {}),
        }, (res) => {
            let data = '';
            res.on('data', (c) => { data += c; });
            res.on('end', () => {
                let json = null;
                try { json = data ? JSON.parse(data) : null; } catch { json = null; }
                resolve({ status: res.statusCode, body: data, json });
            });
        });
        req.on('error', reject);
        req.on('timeout', function () { this.destroy(); reject(new Error('timeout')); });
        req.end(body);
    });
}

// Pide un token CSRF fresco y devuelve los headers double-submit (X-CSRF-Token +
// Cookie ka_csrf) que requireCSRF valida server-side.
async function csrfHeaders() {
    const r = await httpGet('/api/kill-agent/csrf-token');
    assert.strictEqual(r.status, 200, 'el endpoint de token CSRF debe responder 200');
    const token = JSON.parse(r.body).csrf_token;
    assert.ok(token, 'debe venir un csrf_token');
    const setCookie = (r.headers['set-cookie'] || []).join(';');
    const m = setCookie.match(/ka_csrf=([^;]+)/);
    assert.ok(m, 'debe setear la cookie ka_csrf');
    return { 'X-CSRF-Token': token, 'Cookie': 'ka_csrf=' + m[1] };
}

before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dash4433-'));
    // El dashboard puede leer config.yaml (readWaveMaxConcurrency, loadConfig).
    fs.copyFileSync(path.join(PIPELINE_SRC, 'config.yaml'), path.join(tmpDir, 'config.yaml'));
    mkdirp(path.join(tmpDir, 'logs'));
    // Seed: una ola ACTIVA (7, con issue 100) + una PLANIFICADA (8, con issue 200).
    const seed = {
        version: '1.0',
        meta: { created_at: '2026-07-03T00:00:00.000Z', updated_at: '2026-07-03T00:00:00.000Z', updated_by: 'test', source: 'test', note: 'seed 4433' },
        active_wave: { number: 7, name: 'Ola activa', started_at: '2026-07-01T10:00:00.000Z', issues: [{ number: 100, status: 'in-progress' }] },
        planned_waves: [{ number: 8, name: 'Ola planificada', concurrency_max: 3, window_minutes: 60, issues: [{ number: 200, status: 'pending' }] }],
        archived_waves: [],
        dependencies: [],
    };
    fs.writeFileSync(path.join(tmpDir, 'waves.json'), JSON.stringify(seed, null, 2));

    port = await getFreePort();
    child = spawn(process.execPath, [dashboardPath], {
        env: {
            ...process.env,
            PIPELINE_STATE_DIR: tmpDir,
            PIPELINE_DIR_OVERRIDE: tmpDir,
            DASHBOARD_PORT: String(port),
            DASHBOARD_HOST: '127.0.0.1',
            GH_BIN: 'gh-noop-nonexistent',
        },
        stdio: 'ignore',
    });

    await new Promise((resolve, reject) => {
        let tries = 0;
        const tick = () => {
            httpGet('/api/health').then((r) => {
                if (r && r.status === 200) return resolve();
                if (++tries > 40) return reject(new Error('dashboard no levantó'));
                setTimeout(tick, 250);
            }).catch(() => {
                if (++tries > 40) return reject(new Error('dashboard no levantó (error)'));
                setTimeout(tick, 250);
            });
        };
        setTimeout(tick, 500);
    });
});

after(() => {
    if (child) { try { child.kill(); } catch { /* noop */ } }
    if (tmpDir) { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* noop */ } }
});

// ── CA-7 — CSRF fail-closed ───────────────────────────────────────────────────

test('CA-7 — POST /api/waves sin CSRF → 403 y NO crea la ola', async () => {
    const before = readWaves().planned_waves.length;
    const r = await httpPost('/api/waves', { name: 'Sin token', issues: '#900' });
    assert.strictEqual(r.status, 403, 'sin token CSRF debe ser 403');
    assert.strictEqual(readWaves().planned_waves.length, before, 'el state no se modifica');
});

test('CA-7 — POST /api/waves/:num/issues sin CSRF → 403', async () => {
    const r = await httpPost('/api/waves/8/issues', { issue: 901 });
    assert.strictEqual(r.status, 403);
});

test('CA-7 — POST desasociar sin CSRF → 403', async () => {
    const r = await httpPost('/api/waves/8/issues/200/remove');
    assert.strictEqual(r.status, 403);
});

// ── CA-2 — validación de campos obligatorios ─────────────────────────────────

test('CA-2 — crear ola sin issues → 400 con field y SIN escribir state', async () => {
    const before = readWaves().planned_waves.length;
    const r = await httpPost('/api/waves', { name: 'Solo nombre' }, await csrfHeaders());
    assert.strictEqual(r.status, 400, 'payload inválido → 400');
    assert.ok(r.json && r.json.ok === false, 'ok:false');
    assert.strictEqual(r.json.field, 'issues', 'el field faltante es issues');
    assert.strictEqual(readWaves().planned_waves.length, before, 'el state no se modifica');
});

test('CA-2 — crear ola sin nombre → 400 con field nombre', async () => {
    const r = await httpPost('/api/waves', { issues: '#902' }, await csrfHeaders());
    assert.strictEqual(r.status, 400);
    assert.strictEqual(r.json.field, 'nombre');
});

// ── CA-1 — happy path create con defaults server-side ────────────────────────

test('CA-1 — crear ola happy path → 200, ola planificada con defaults server-side', async () => {
    const r = await httpPost('/api/waves', { name: 'Ola Nueva 4433', goal: 'objetivo x', issues: '#300 #301' }, await csrfHeaders());
    assert.strictEqual(r.status, 200, 'happy path → 200');
    assert.ok(r.json.ok === true, 'ok:true');
    assert.ok(Number.isInteger(r.json.number), 'devuelve el número de ola');
    const state = readWaves();
    const created = state.planned_waves.find((w) => w.name === 'Ola Nueva 4433');
    assert.ok(created, 'la ola quedó en planned_waves');
    assert.deepStrictEqual(created.issues.map((i) => i.number).sort(), [300, 301], 'con los issues iniciales');
    // Defaults server-side (decisión PO camino b): NO vinieron del cliente.
    assert.strictEqual(created.concurrency_max, 10, 'concurrency = readWaveMaxConcurrency() (default 10)');
    assert.strictEqual(created.window_minutes, 1440, 'window = WAVE_WINDOW_MAX_MINUTES (1440)');
});

// ── CA-4 — asociar issue inválido ────────────────────────────────────────────

test('CA-4 — asociar issue inválido → 4xx y ola sin modificar', async () => {
    const before = readWaves().planned_waves.find((w) => w.number === 8).issues.length;
    const r = await httpPost('/api/waves/8/issues', { issue: 'abc' }, await csrfHeaders());
    assert.ok(r.status >= 400 && r.status < 500, 'issue inválido → 4xx (fue ' + r.status + ')');
    assert.ok(r.json && r.json.ok === false, 'ok:false');
    const after = readWaves().planned_waves.find((w) => w.number === 8).issues.length;
    assert.strictEqual(after, before, 'la ola no se modifica');
});

test('CA-3 — asociar issue válido a una planificada → 200 y queda asociado', async () => {
    const r = await httpPost('/api/waves/8/issues', { issue: 305 }, await csrfHeaders());
    assert.strictEqual(r.status, 200);
    assert.ok(r.json.ok === true);
    const wave8 = readWaves().planned_waves.find((w) => w.number === 8);
    assert.ok(wave8.issues.some((i) => i.number === 305), 'issue 305 asociado');
});

// ── CA-6 / REQ-SEC-4 — desasociar sobre la ola activa ────────────────────────

test('CA-6 — desasociar sobre la ola ACTIVA → 4xx EWAVES_ACTIVE_LOCKED, sin forzar', async () => {
    const r = await httpPost('/api/waves/7/issues/100/remove', undefined, await csrfHeaders());
    assert.ok(r.status >= 400 && r.status < 500, 'sobre la activa → 4xx (fue ' + r.status + ')');
    assert.strictEqual(r.json.code, 'EWAVES_ACTIVE_LOCKED', 'code EWAVES_ACTIVE_LOCKED');
    const active = readWaves().active_wave;
    assert.ok(active.issues.some((i) => i.number === 100), 'la activa conserva su issue');
});

test('CA-6 — asociar sobre la ola ACTIVA → 4xx (sólo planificadas)', async () => {
    const r = await httpPost('/api/waves/7/issues', { issue: 999 }, await csrfHeaders());
    assert.ok(r.status >= 400 && r.status < 500, 'asociar a la activa → 4xx');
    assert.strictEqual(r.json.code, 'EWAVES_ACTIVE_LOCKED');
});

// ── CA-5 — desasociar de una planificada (happy) ─────────────────────────────

test('CA-5 — desasociar issue de una planificada → 200 y deja de estar asociado', async () => {
    const r = await httpPost('/api/waves/8/issues/200/remove', undefined, await csrfHeaders());
    assert.strictEqual(r.status, 200);
    assert.ok(r.json.ok === true && r.json.removed === true);
    const wave8 = readWaves().planned_waves.find((w) => w.number === 8);
    assert.ok(!wave8.issues.some((i) => i.number === 200), 'issue 200 desasociado');
});
