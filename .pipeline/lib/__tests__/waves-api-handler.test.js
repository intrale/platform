// =============================================================================
// waves-api-handler.test.js — Tests del handler HTTP `/api/waves/*` (#4372).
//
// Cubre el cinturón de gates de las mutaciones (auth 401/403, rate-limit 429,
// If-Match 428/409, validación 400 con field), las lecturas display-ready con
// version/ETag, la idempotencia por Idempotency-Key y la auditoría encadenada.
//
// Usa un req Readable falso + un res que captura status/headers/body, sin abrir
// un socket real. Aislamiento por PIPELINE_DIR_OVERRIDE.
//
// Ejecutar:  node --test .pipeline/lib/__tests__/waves-api-handler.test.js
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');

let waves, wavesApi, csrf, auditLog;

function setupTmp() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'waves-api-handler-'));
    process.env.PIPELINE_DIR_OVERRIDE = dir;
    delete require.cache[require.resolve('../waves')];
    delete require.cache[require.resolve('../waves-api')];
    waves = require('../waves');
    wavesApi = require('../waves-api');
    csrf = require('../kill-agent-csrf');
    auditLog = require('../audit-log');
    waves.invalidateCache();
    wavesApi._internal._resetForTests();
    return dir;
}

function teardownTmp(dir) {
    delete process.env.PIPELINE_DIR_OVERRIDE;
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
}

// req falso: Readable con method/url/headers/socket.
function makeReq({ method = 'GET', url = '/', headers = {}, body = null, ip = '127.0.0.1' } = {}) {
    const req = Readable.from(body != null ? [Buffer.from(body)] : []);
    req.method = method;
    req.url = url;
    // headers en minúscula (como Node).
    req.headers = {};
    for (const [k, v] of Object.entries(headers)) req.headers[k.toLowerCase()] = v;
    req.socket = { remoteAddress: ip };
    return req;
}

function makeRes(onDone) {
    const res = { statusCode: null, headers: {}, body: '', ended: false };
    res.setHeader = (k, v) => { res.headers[k] = v; };
    res.writeHead = (s, h) => { res.statusCode = s; Object.assign(res.headers, h || {}); return res; };
    res.end = (b) => { res.body = b || ''; res.ended = true; if (onDone) onDone(res); };
    return res;
}

function invoke(reqOpts) {
    return new Promise((resolve) => {
        const req = makeReq(reqOpts);
        const res = makeRes((r) => resolve(r));
        const handled = wavesApi.handleWavesApi(req, res, {});
        if (!handled) resolve({ notHandled: true });
    });
}

function json(res) { return JSON.parse(res.body); }

// Credencial de operador válida: token CSRF en header + cookie.
function authHeaders() {
    const tok = csrf.generateToken();
    return { 'x-csrf-token': tok, 'cookie': `${csrf.COOKIE_NAME}=${tok}` };
}

async function seedWave(name = 'Semilla', issues = [1, 2]) {
    // Crea una ola planificada directo por dominio para tener estado.
    return waves.createPlannedWave({ name, issues, concurrency_max: 2, window_minutes: 30 }, {});
}

// --- Lecturas -----------------------------------------------------------------

test('GET /api/waves lista con version + ETag y state enum display-ready', async () => {
    const dir = setupTmp();
    try {
        await seedWave('Lista', [5, 6]);
        const res = await invoke({ method: 'GET', url: '/api/waves' });
        assert.equal(res.statusCode, 200);
        const b = json(res);
        assert.ok(typeof b.version === 'string');
        assert.equal(res.headers.ETag, `"${b.version}"`);
        assert.equal(b.waves[0].state, 'planned');
        assert.deepEqual(b.waves[0].issues.map((i) => i.number), [5, 6]);
    } finally { teardownTmp(dir); }
});

test('GET /api/waves/active sin ola activa → { active: null } y 200 (nunca 500)', async () => {
    const dir = setupTmp();
    try {
        await seedWave();
        const res = await invoke({ method: 'GET', url: '/api/waves/active' });
        assert.equal(res.statusCode, 200);
        assert.equal(json(res).active, null);
    } finally { teardownTmp(dir); }
});

test('GET /api/waves/{n} inexistente → 404 not_found', async () => {
    const dir = setupTmp();
    try {
        await seedWave();
        const res = await invoke({ method: 'GET', url: '/api/waves/999' });
        assert.equal(res.statusCode, 404);
        assert.equal(json(res).code, 'not_found');
    } finally { teardownTmp(dir); }
});

test('GET /api/roadmap/status devuelve horizon + allowlist + version', async () => {
    const dir = setupTmp();
    try {
        await seedWave();
        const res = await invoke({ method: 'GET', url: '/api/roadmap/status' });
        assert.equal(res.statusCode, 200);
        const b = json(res);
        assert.ok(Array.isArray(b.horizon));
        assert.ok(Array.isArray(b.allowlist));
        assert.ok(typeof b.version === 'string');
    } finally { teardownTmp(dir); }
});

test('GET /api/waves/{n} con id no numérico → 400 invalid_id (A03, anti path-traversal)', async () => {
    const dir = setupTmp();
    try {
        const res = await invoke({ method: 'GET', url: '/api/waves/..%2f..%2fetc' });
        assert.equal(res.statusCode, 400);
        assert.equal(json(res).code, 'invalid_id');
    } finally { teardownTmp(dir); }
});

// --- Auth (CA-5) --------------------------------------------------------------

test('mutación anónima (sin credencial) → 401', async () => {
    const dir = setupTmp();
    try {
        const c = await seedWave();
        const res = await invoke({
            method: 'PATCH', url: `/api/waves/${c.waveNumber}`,
            headers: { 'content-type': 'application/json', 'if-match': waves.getVersion() },
            body: JSON.stringify({ name: 'X' }),
        });
        assert.equal(res.statusCode, 401);
        assert.equal(json(res).code, 'unauthorized');
    } finally { teardownTmp(dir); }
});

test('mutación con credencial inválida → 403', async () => {
    const dir = setupTmp();
    try {
        const c = await seedWave();
        const res = await invoke({
            method: 'PATCH', url: `/api/waves/${c.waveNumber}`,
            headers: { 'content-type': 'application/json', 'if-match': waves.getVersion(), 'x-csrf-token': 'aaa', 'cookie': `${csrf.COOKIE_NAME}=bbb` },
            body: JSON.stringify({ name: 'X' }),
        });
        assert.equal(res.statusCode, 403);
        assert.equal(json(res).code, 'forbidden');
    } finally { teardownTmp(dir); }
});

// --- If-Match / concurrencia (CA-4) -------------------------------------------

test('mutación sin If-Match → 428 precondition_required', async () => {
    const dir = setupTmp();
    try {
        const c = await seedWave();
        const res = await invoke({
            method: 'PATCH', url: `/api/waves/${c.waveNumber}`,
            headers: { 'content-type': 'application/json', ...authHeaders() },
            body: JSON.stringify({ name: 'X' }),
        });
        assert.equal(res.statusCode, 428);
        assert.equal(json(res).code, 'precondition_required');
    } finally { teardownTmp(dir); }
});

test('mutación con If-Match desactualizado → 409 con version vigente en el body', async () => {
    const dir = setupTmp();
    try {
        const c = await seedWave();
        const res = await invoke({
            method: 'PATCH', url: `/api/waves/${c.waveNumber}`,
            headers: { 'content-type': 'application/json', 'if-match': 'version-vieja', ...authHeaders() },
            body: JSON.stringify({ name: 'Nuevo' }),
        });
        assert.equal(res.statusCode, 409);
        const b = json(res);
        assert.equal(b.code, 'version_conflict');
        assert.equal(b.version, waves.getVersion());
    } finally { teardownTmp(dir); }
});

test('PATCH con If-Match vigente aplica y devuelve la ola editada + nueva version', async () => {
    const dir = setupTmp();
    try {
        const c = await seedWave('Editar');
        const res = await invoke({
            method: 'PATCH', url: `/api/waves/${c.waveNumber}`,
            headers: { 'content-type': 'application/json', 'if-match': waves.getVersion(), ...authHeaders() },
            body: JSON.stringify({ window_minutes: 90 }),
        });
        assert.equal(res.statusCode, 200);
        const b = json(res);
        assert.equal(b.wave.window_minutes, 90);
        assert.ok(typeof b.version === 'string');
    } finally { teardownTmp(dir); }
});

// --- Validación (CA-2/A03) ----------------------------------------------------

test('POST /api/waves con nombre inválido → 400 con field', async () => {
    const dir = setupTmp();
    try {
        const res = await invoke({
            method: 'POST', url: '/api/waves',
            headers: { 'content-type': 'application/json', ...authHeaders() },
            body: JSON.stringify({ name: '   ', issues: [1], concurrency_max: 1, window_minutes: 10 }),
        });
        assert.equal(res.statusCode, 400);
        assert.equal(json(res).code, 'invalid_input');
        assert.equal(json(res).field, 'name');
    } finally { teardownTmp(dir); }
});

test('POST /api/waves crea (201) con Content-Type json y credencial', async () => {
    const dir = setupTmp();
    try {
        const res = await invoke({
            method: 'POST', url: '/api/waves',
            headers: { 'content-type': 'application/json', ...authHeaders() },
            body: JSON.stringify({ name: 'Creada', issues: [7, 8], concurrency_max: 2, window_minutes: 30 }),
        });
        assert.equal(res.statusCode, 201);
        const b = json(res);
        assert.equal(b.wave.name, 'Creada');
        assert.equal(b.wave.state, 'planned');
    } finally { teardownTmp(dir); }
});

test('mutación con Content-Type no-json → 415', async () => {
    const dir = setupTmp();
    try {
        const res = await invoke({
            method: 'POST', url: '/api/waves',
            headers: { 'content-type': 'text/plain', ...authHeaders() },
            body: 'x=1',
        });
        assert.equal(res.statusCode, 415);
    } finally { teardownTmp(dir); }
});

// --- Asociar / quitar issue (CA-3) --------------------------------------------

test('DELETE issue ausente → 200 removed:false (idempotente, sin body)', async () => {
    const dir = setupTmp();
    try {
        const c = await seedWave('Assoc', [1, 2]);
        const res = await invoke({
            method: 'DELETE', url: `/api/waves/${c.waveNumber}/issues/999`,
            headers: { 'if-match': waves.getVersion(), ...authHeaders() },
        });
        assert.equal(res.statusCode, 200);
        assert.equal(json(res).removed, false);
    } finally { teardownTmp(dir); }
});

test('POST associate agrega un issue nuevo (added:true)', async () => {
    const dir = setupTmp();
    try {
        const c = await seedWave('AssocAdd', [1]);
        const res = await invoke({
            method: 'POST', url: `/api/waves/${c.waveNumber}/issues`,
            headers: { 'content-type': 'application/json', 'if-match': waves.getVersion(), ...authHeaders() },
            body: JSON.stringify({ issue: 42 }),
        });
        assert.equal(res.statusCode, 200);
        assert.equal(json(res).added, true);
    } finally { teardownTmp(dir); }
});

// --- Reorden (CA-3/UX-4) ------------------------------------------------------

test('PUT order reordena y devuelve el orden resultante; rechaza id ajeno a la ola', async () => {
    const dir = setupTmp();
    try {
        const c = await seedWave('Orden', [10, 20, 30]);
        const ok = await invoke({
            method: 'PUT', url: `/api/waves/${c.waveNumber}/order`,
            headers: { 'content-type': 'application/json', 'if-match': waves.getVersion(), ...authHeaders() },
            body: JSON.stringify({ order: [30, 10, 20] }),
        });
        assert.equal(ok.statusCode, 200);
        assert.deepEqual(json(ok).order, [30, 10, 20]);
        // Id que no pertenece a la ola → 400.
        const bad = await invoke({
            method: 'PUT', url: `/api/waves/${c.waveNumber}/order`,
            headers: { 'content-type': 'application/json', 'if-match': waves.getVersion(), ...authHeaders() },
            body: JSON.stringify({ order: [999] }),
        });
        assert.equal(bad.statusCode, 400);
        assert.equal(json(bad).field, 'order');
    } finally { teardownTmp(dir); }
});

// --- Idempotency-Key ----------------------------------------------------------

test('Idempotency-Key: reintento con misma key devuelve el mismo resultado sin duplicar', async () => {
    const dir = setupTmp();
    try {
        const headers = { 'content-type': 'application/json', 'idempotency-key': 'k-123', ...authHeaders() };
        const body = JSON.stringify({ name: 'Idem', issues: [1, 2], concurrency_max: 1, window_minutes: 10 });
        const first = await invoke({ method: 'POST', url: '/api/waves', headers, body });
        assert.equal(first.statusCode, 201);
        // Reintento con la MISMA key y mismo body → replay del resultado.
        const second = await invoke({ method: 'POST', url: '/api/waves', headers, body });
        assert.equal(second.statusCode, 201);
        assert.deepEqual(json(second), json(first));
        // Sólo se creó una ola con ese nombre.
        assert.equal(waves.listWaves().filter((w) => w.name === 'Idem').length, 1);
    } finally { teardownTmp(dir); }
});

// --- Rate limit (CA-7) --------------------------------------------------------

test('rate limit: superar el límite de mutaciones → 429', async () => {
    const dir = setupTmp();
    try {
        await seedWave();
        const max = wavesApi._internal.WAVES_RATE_MAX;
        // Cada request pasa auth+rate y luego cae en 428 (sin If-Match) — igual
        // consume token de rate. La (max+1)-ésima debe ser 429.
        let last;
        for (let i = 0; i < max + 1; i++) {
            last = await invoke({
                method: 'PATCH', url: '/api/waves/1',
                headers: { 'content-type': 'application/json', ...authHeaders() },
                body: JSON.stringify({ name: 'x' }),
            });
        }
        assert.equal(last.statusCode, 429);
        assert.equal(json(last).code, 'rate_limited');
    } finally { teardownTmp(dir); }
});

// --- Auditoría (CA-6/A09) -----------------------------------------------------

test('cada mutación deja una entrada de auditoría verificable con verifyChain', async () => {
    const dir = setupTmp();
    try {
        await invoke({
            method: 'POST', url: '/api/waves',
            headers: { 'content-type': 'application/json', ...authHeaders() },
            body: JSON.stringify({ name: 'Audit', issues: [1], concurrency_max: 1, window_minutes: 10 }),
        });
        const file = wavesApi._internal.auditFile();
        assert.ok(fs.existsSync(file), 'el archivo de auditoría debe existir');
        const chain = auditLog.verifyChain(file);
        assert.equal(chain.ok, true);
        assert.ok(chain.entriesChecked >= 1);
    } finally { teardownTmp(dir); }
});
