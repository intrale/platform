// =============================================================================
// waves-api-4534.test.js — Tests del rediseño de la ventana Roadmap (#4534):
//   - DELETE /api/waves/{n}  → baja de ola planificada (libera issues).
//   - PUT    /api/waves/order → reorden de las olas planificadas entre sí.
//   - GET    /api/waves/issue-search → buscador (#, título, label) + auto-exclusión.
//   - POST   /api/waves sin concurrency/window → defaults server-side (decisión PO).
//
// Reusa el mismo harness que waves-api-handler.test.js (req/res falsos, aislamiento
// por PIPELINE_DIR_OVERRIDE). Sin sockets ni red.
//
// Ejecutar:  node --test .pipeline/lib/__tests__/waves-api-4534.test.js
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const { seedPipelineConfig } = require('./_test-helpers');

let waves, wavesApi, csrf;

function setupTmp() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'waves-api-4534-'));
    // #5172: la lectura de config.yaml dejó de degradar a default ante ENOENT,
    // así que el sandbox necesita config propia. Documento mínimo a propósito:
    // sin sección `waves:` los defaults de concurrencia son los de siempre.
    seedPipelineConfig(dir);
    process.env.PIPELINE_DIR_OVERRIDE = dir;
    delete require.cache[require.resolve('../waves')];
    delete require.cache[require.resolve('../waves-api')];
    waves = require('../waves');
    wavesApi = require('../waves-api');
    csrf = require('../kill-agent-csrf');
    waves.invalidateCache();
    wavesApi._internal._resetForTests();
    return dir;
}

function teardownTmp(dir) {
    delete process.env.PIPELINE_DIR_OVERRIDE;
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
}

function makeReq({ method = 'GET', url = '/', headers = {}, body = null, ip = '127.0.0.1' } = {}) {
    const req = Readable.from(body != null ? [Buffer.from(body)] : []);
    req.method = method;
    req.url = url;
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

function authHeaders() {
    const tok = csrf.generateToken();
    return { 'x-csrf-token': tok, 'cookie': `${csrf.COOKIE_NAME}=${tok}` };
}

function seed(name, issues) {
    return waves.createPlannedWave({ name, issues, concurrency_max: 2, window_minutes: 30 }, {});
}

function writeTitleCache(dir, obj) {
    fs.writeFileSync(path.join(dir, '.issue-title-cache.json'), JSON.stringify(obj), 'utf8');
}

// --- DELETE /api/waves/{n} -----------------------------------------------------

test('DELETE ola planificada con If-Match vigente → 200 y libera issues', async () => {
    const dir = setupTmp();
    try {
        const c = seed('Borrar', [10, 11]);
        const res = await invoke({
            method: 'DELETE', url: `/api/waves/${c.waveNumber}`,
            headers: { 'if-match': waves.getVersion(), ...authHeaders() },
        });
        assert.equal(res.statusCode, 200);
        const b = json(res);
        assert.equal(b.deleted, true);
        assert.deepEqual(b.freed_issues.sort((a, z) => a - z), [10, 11]);
        // La ola ya no existe.
        assert.equal(waves.getPlannedWave(c.waveNumber), null);
    } finally { teardownTmp(dir); }
});

test('DELETE ola inexistente → 404 not_found', async () => {
    const dir = setupTmp();
    try {
        seed('Existe', [1]);
        const res = await invoke({
            method: 'DELETE', url: '/api/waves/9999',
            headers: { 'if-match': waves.getVersion(), ...authHeaders() },
        });
        assert.equal(res.statusCode, 404);
        assert.equal(json(res).code, 'not_found');
    } finally { teardownTmp(dir); }
});

test('DELETE sin If-Match → 428 precondition_required', async () => {
    const dir = setupTmp();
    try {
        const c = seed('Borrar', [2]);
        const res = await invoke({
            method: 'DELETE', url: `/api/waves/${c.waveNumber}`,
            headers: { ...authHeaders() },
        });
        assert.equal(res.statusCode, 428);
    } finally { teardownTmp(dir); }
});

test('DELETE sin credencial → 401', async () => {
    const dir = setupTmp();
    try {
        const c = seed('Borrar', [3]);
        const res = await invoke({
            method: 'DELETE', url: `/api/waves/${c.waveNumber}`,
            headers: { 'if-match': waves.getVersion() },
        });
        assert.equal(res.statusCode, 401);
    } finally { teardownTmp(dir); }
});

// --- PUT /api/waves/order ------------------------------------------------------

test('PUT /api/waves/order reordena las planificadas (permutación exacta)', async () => {
    const dir = setupTmp();
    try {
        const a = seed('A', [1]);
        const b = seed('B', [2]);
        const cc = seed('C', [3]);
        const newOrder = [cc.waveNumber, a.waveNumber, b.waveNumber];
        const res = await invoke({
            method: 'PUT', url: '/api/waves/order',
            headers: { 'content-type': 'application/json', 'if-match': waves.getVersion(), ...authHeaders() },
            body: JSON.stringify({ order: newOrder }),
        });
        assert.equal(res.statusCode, 200);
        assert.deepEqual(json(res).order, newOrder);
        const listed = waves.loadWaves().planned_waves.map((w) => w.number);
        assert.deepEqual(listed, newOrder);
    } finally { teardownTmp(dir); }
});

test('PUT /api/waves/order con permutación inválida → 400 invalid_input', async () => {
    const dir = setupTmp();
    try {
        const a = seed('A', [1]);
        seed('B', [2]);
        const res = await invoke({
            method: 'PUT', url: '/api/waves/order',
            headers: { 'content-type': 'application/json', 'if-match': waves.getVersion(), ...authHeaders() },
            body: JSON.stringify({ order: [a.waveNumber] }), // falta B
        });
        assert.equal(res.statusCode, 400);
        assert.equal(json(res).code, 'invalid_input');
    } finally { teardownTmp(dir); }
});

test('PUT /api/waves/order con If-Match viejo → 409 version_conflict', async () => {
    const dir = setupTmp();
    try {
        const a = seed('A', [1]);
        const b = seed('B', [2]);
        const res = await invoke({
            method: 'PUT', url: '/api/waves/order',
            headers: { 'content-type': 'application/json', 'if-match': 'vieja', ...authHeaders() },
            body: JSON.stringify({ order: [b.waveNumber, a.waveNumber] }),
        });
        assert.equal(res.statusCode, 409);
        assert.equal(json(res).code, 'version_conflict');
    } finally { teardownTmp(dir); }
});

// --- GET /api/waves/issue-search ----------------------------------------------

test('issue-search por texto: matchea título y label; excluye los ya-en-ola y cerrados', async () => {
    const dir = setupTmp();
    try {
        writeTitleCache(dir, {
            '100': { title: 'fix: validación de alta', state: 'OPEN', labels: ['Ready', 'area:pipeline'] },
            '101': { title: 'feature nueva', state: 'OPEN', labels: ['enhancement'] },
            '102': { title: 'fix cerrado viejo', state: 'CLOSED', labels: ['bug'] },
            '103': { title: 'algo con fix adentro', state: 'OPEN', labels: [] },
        });
        // #103 ya pertenece a una ola → auto-exclusión por membresía.
        seed('Ocupada', [103]);
        const res = await invoke({ method: 'GET', url: '/api/waves/issue-search?q=fix' });
        assert.equal(res.statusCode, 200);
        const b = json(res);
        const byNum = Object.fromEntries(b.results.map((r) => [r.number, r]));
        assert.ok(byNum[100] && byNum[100].eligible === true);
        assert.equal(byNum[101], undefined); // no matchea "fix"
        assert.ok(byNum[102] && byNum[102].eligible === false && /cerrado/.test(byNum[102].reason));
        assert.ok(byNum[103] && byNum[103].eligible === false && /ya en Ola/.test(byNum[103].reason));
    } finally { teardownTmp(dir); }
});

test('issue-search por número parcial matchea por #', async () => {
    const dir = setupTmp();
    try {
        writeTitleCache(dir, {
            '4534': { title: 'rediseño roadmap', state: 'OPEN', labels: [] },
            '4600': { title: 'otro', state: 'OPEN', labels: [] },
        });
        const res = await invoke({ method: 'GET', url: '/api/waves/issue-search?q=453' });
        const nums = json(res).results.map((r) => r.number);
        assert.ok(nums.includes(4534));
        assert.ok(!nums.includes(4600));
    } finally { teardownTmp(dir); }
});

test('issue-search modo ids resuelve un set explícito (enriquecer board)', async () => {
    const dir = setupTmp();
    try {
        writeTitleCache(dir, {
            '200': { title: 'issue doscientos', state: 'OPEN', labels: ['x'] },
        });
        const res = await invoke({ method: 'GET', url: '/api/waves/issue-search?ids=200,201' });
        assert.equal(res.statusCode, 200);
        const b = json(res);
        const byNum = Object.fromEntries(b.results.map((r) => [r.number, r]));
        assert.equal(byNum[200].title, 'issue doscientos');
        assert.equal(byNum[201].title, null); // sin cache → título nulo, sin romper
    } finally { teardownTmp(dir); }
});

test('issue-search sin title-cache → 200 con results vacío (nunca 500)', async () => {
    const dir = setupTmp();
    try {
        const res = await invoke({ method: 'GET', url: '/api/waves/issue-search?q=hola' });
        assert.equal(res.statusCode, 200);
        assert.deepEqual(json(res).results, []);
    } finally { teardownTmp(dir); }
});

// --- POST /api/waves con defaults server-side (decisión PO #4534) --------------

test('POST /api/waves sin concurrency/window aplica defaults y crea (201)', async () => {
    const dir = setupTmp();
    try {
        const res = await invoke({
            method: 'POST', url: '/api/waves',
            headers: { 'content-type': 'application/json', ...authHeaders() },
            body: JSON.stringify({ name: 'Ola sin bounds', issues: [1, 2] }),
        });
        assert.equal(res.statusCode, 201);
        const b = json(res);
        assert.equal(b.wave.window_minutes, 60);
        assert.ok(b.wave.concurrency_max >= 1);
    } finally { teardownTmp(dir); }
});
