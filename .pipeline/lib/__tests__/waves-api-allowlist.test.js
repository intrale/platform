// =============================================================================
// waves-api-allowlist.test.js — Tests del editor de allowlist de la ventana
// Roadmap (#4437), enrutado por `handleWavesApi` bajo `/api/roadmap/allowlist*`.
//
// Cubre (CA-1..CA-8):
//   - matchRoute mapea las 4 rutas nuevas y rechaza métodos inválidos.
//   - Validación A03: IDs no numéricos → 400 `bad-id` SIN invocar resolveOpenDeps.
//   - preview NO escribe .partial-pause.json (contenido idéntico antes/después)
//     y devuelve aArrastrar/inconsistencias/truncado.
//   - add expande recursivamente y persiste SÓLO vía setPartialPause.
//   - remove con inconsistencia → blocked hasta confirm; confirm:true persiste.
//   - remove que desincroniza la ola activa → warning bloqueante.
//   - preview truncado expone truncado:true + reason.
//   - los 3 gates (loopback/same-origin/auth) rechazan preview y mutaciones.
//
// Aislamiento por PIPELINE_DIR_OVERRIDE + ghRunner mockeado (sin red).
//
// Ejecutar:  node --test .pipeline/lib/__tests__/waves-api-allowlist.test.js
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const { seedPipelineConfig } = require('./_test-helpers');

let waves, wavesApi, csrf, partialPause;

// Grafo de issues falso para el ghRunner mockeado.
//   100 (épico, open)   → Closes #101, Closes #102   (forward deps)
//   101 (hijo, open)    → Split de #100               (procedencia = parent)
//   102 (hijo, open)    → Split de #100, Depends on #103
//   103 (dep, open)     → (sin deps)
//   200 (suelto, open)  → (sin deps)
const FAKE_ISSUES = {
    100: { number: 100, title: 'Épico A', state: 'open', body: 'Closes #101\nCloses #102', comments: [] },
    101: { number: 101, title: 'Hijo 1', state: 'open', body: 'Split de #100', comments: [] },
    102: { number: 102, title: 'Hijo 2', state: 'open', body: 'Split de #100\nDepends on #103', comments: [] },
    103: { number: 103, title: 'Dep de 102', state: 'open', body: '', comments: [] },
    200: { number: 200, title: 'Suelto', state: 'open', body: '', comments: [] },
};

let ghCalls = 0;
function makeGhRunner() {
    ghCalls = 0;
    return function ghRunner(args) {
        ghCalls += 1;
        // args = ['issue','view','<n>','--repo',repo,'--json',...]
        const n = Number(args[2]);
        const issue = FAKE_ISSUES[n];
        if (!issue) return { ok: false, stdout: '', stderr: 'not found', status: 1 };
        return { ok: true, stdout: JSON.stringify(issue), stderr: '', status: 0 };
    };
}

function setupTmp() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'waves-api-allowlist-'));
    // #5172: leer config.yaml pasó a ser fail-loud, así que un tmp sin config
    // rompe el harness. Se siembra el documento mínimo a propósito: sin sección
    // `waves:` los defaults efectivos son los mismos que antes del cambio.
    seedPipelineConfig(dir);
    process.env.PIPELINE_DIR_OVERRIDE = dir;
    for (const m of ['../waves', '../waves-api', '../partial-pause']) {
        try { delete require.cache[require.resolve(m)]; } catch { /* noop */ }
    }
    waves = require('../waves');
    wavesApi = require('../waves-api');
    csrf = require('../kill-agent-csrf');
    partialPause = require('../partial-pause');
    waves.invalidateCache();
    wavesApi._internal._resetForTests();
    // Inyectar el ghRunner mockeado + cache aislado en el tmp dir.
    wavesApi._internal._setDepsOptsForTests({
        ghRunner: makeGhRunner(),
        cacheFile: path.join(dir, 'deps-cache.json'),
    });
    return dir;
}

function teardownTmp(dir) {
    delete process.env.PIPELINE_DIR_OVERRIDE;
    wavesApi._internal._resetForTests();
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
    return { 'x-csrf-token': tok, 'cookie': `${csrf.COOKIE_NAME}=${tok}`, 'content-type': 'application/json' };
}

function seedAllowlist(issues) {
    const r = partialPause.setPartialPause(issues, {
        source: 'dashboard:roadmap:allowlist',
        authorizedBy: 'dashboard:roadmap:allowlist',
        justification: 'seed de test',
    });
    assert.ok(!r.rejected, 'seed no debe ser rechazado por el gate');
}

function partialFilePath(dir) { return path.join(dir, '.partial-pause.json'); }

// --- matchRoute ---------------------------------------------------------------

test('matchRoute mapea las 4 rutas nuevas de allowlist', () => {
    const mr = require('../waves-api')._internal.matchRoute;
    assert.deepEqual(mr('GET', '/api/roadmap/allowlist'), { surface: true, kind: 'read', action: 'allowlist-read' });
    assert.deepEqual(mr('POST', '/api/roadmap/allowlist/preview'), { surface: true, kind: 'mutation', action: 'allowlist-preview', method: 'POST' });
    assert.deepEqual(mr('POST', '/api/roadmap/allowlist/add'), { surface: true, kind: 'mutation', action: 'allowlist-add', method: 'POST' });
    assert.deepEqual(mr('POST', '/api/roadmap/allowlist/remove'), { surface: true, kind: 'mutation', action: 'allowlist-remove', method: 'POST' });
    // Método inválido → unknown (405), no null.
    assert.equal(mr('DELETE', '/api/roadmap/allowlist/add').kind, 'unknown');
    assert.equal(mr('PUT', '/api/roadmap/allowlist').kind, 'unknown');
    // Operación desconocida → null (no es de la superficie).
    assert.equal(mr('POST', '/api/roadmap/allowlist/nope'), null);
});

// --- Lectura enriquecida (CA-1) ----------------------------------------------

test('GET allowlist devuelve metadata whitelisteada (número/título/estado/parent)', async () => {
    const dir = setupTmp();
    try {
        seedAllowlist([101]);
        // Calentar el cache de deps para 101 (fetchIssueInfo popula title/state/parent).
        wavesApi._internal.computeDrag([101]);
        const res = await invoke({ method: 'GET', url: '/api/roadmap/allowlist' });
        assert.equal(res.statusCode, 200);
        const b = json(res);
        assert.equal(b.count, 1);
        const row = b.allowlist[0];
        assert.equal(row.number, 101);
        assert.equal(row.title, 'Hijo 1');
        assert.equal(row.status, 'open');
        assert.equal(row.parent, 100); // Split de #100 → parent
        // A05: ninguna clave de path/timestamp filtrada.
        assert.deepEqual(Object.keys(row).sort(), ['number', 'parent', 'status', 'title']);
    } finally { teardownTmp(dir); }
});

// --- Validación A03 -----------------------------------------------------------

test('add con ID no numérico → 400 bad-id SIN invocar resolveOpenDeps', async () => {
    const dir = setupTmp();
    try {
        for (const bad of [['abc'], [-1], [1.5], ['12x'], [0]]) {
            const res = await invoke({
                method: 'POST', url: '/api/roadmap/allowlist/add',
                headers: authHeaders(), body: JSON.stringify({ issues: bad }),
            });
            assert.equal(res.statusCode, 400, `esperaba 400 para ${JSON.stringify(bad)}`);
            assert.equal(json(res).code, 'bad-id');
        }
        // El ghRunner nunca fue invocado: la validación cortó en el borde HTTP.
        assert.equal(ghCalls, 0, 'resolveOpenDeps no debe correr con IDs inválidos');
    } finally { teardownTmp(dir); }
});

// --- Preview dry-run (CA-2) ---------------------------------------------------

test('preview NO escribe .partial-pause.json y devuelve aArrastrar/inconsistencias', async () => {
    const dir = setupTmp();
    try {
        seedAllowlist([100]);
        const before = fs.readFileSync(partialFilePath(dir), 'utf8');
        // preview de agregar #100 (ya está): arrastra 101,102,103 recursivamente.
        const res = await invoke({
            method: 'POST', url: '/api/roadmap/allowlist/preview',
            headers: authHeaders(), body: JSON.stringify({ issues: [100] }),
        });
        assert.equal(res.statusCode, 200);
        const b = json(res);
        assert.equal(b.persisted, false);
        assert.deepEqual(b.aArrastrar, [101, 102, 103]);
        // El archivo NO cambió (dry-run).
        const after = fs.readFileSync(partialFilePath(dir), 'utf8');
        assert.equal(before, after, 'preview no debe modificar .partial-pause.json');
    } finally { teardownTmp(dir); }
});

test('preview truncado expone truncado:true + reason', async () => {
    const dir = setupTmp();
    try {
        seedAllowlist([100]);
        // maxNodes=1 fuerza truncado por nodos.
        wavesApi._internal._setDepsOptsForTests({
            ghRunner: makeGhRunner(),
            cacheFile: path.join(dir, 'deps-cache.json'),
            maxNodes: 1,
        });
        const res = await invoke({
            method: 'POST', url: '/api/roadmap/allowlist/preview',
            headers: authHeaders(), body: JSON.stringify({ issues: [100] }),
        });
        const b = json(res);
        assert.equal(b.truncado, true);
        assert.equal(b.reason, 'max_nodes');
    } finally { teardownTmp(dir); }
});

// --- Add recursivo (CA-3) -----------------------------------------------------

test('add expande recursivamente y persiste SOLO vía setPartialPause', async () => {
    const dir = setupTmp();
    try {
        seedAllowlist([200]);
        const res = await invoke({
            method: 'POST', url: '/api/roadmap/allowlist/add',
            headers: authHeaders(), body: JSON.stringify({ issues: [100] }),
        });
        assert.equal(res.statusCode, 200);
        const b = json(res);
        assert.equal(b.persisted, true);
        assert.deepEqual(b.aArrastrar, [101, 102, 103]);
        // La persistencia refleja el union recursivo (200 previo + 100 y su subgrafo).
        assert.deepEqual(b.allowlist, [100, 101, 102, 103, 200]);
        // Prueba empírica de que fue por el gate: readPreviousAllowlist coincide.
        assert.deepEqual(partialPause.readPreviousAllowlist().sort((x, y) => x - y), [100, 101, 102, 103, 200]);
    } finally { teardownTmp(dir); }
});

// --- Remove bloqueante (CA-4/CA-5) -------------------------------------------

test('remove que deja dependencia faltante → blocked hasta confirm', async () => {
    const dir = setupTmp();
    try {
        seedAllowlist([100, 101, 102, 103]);
        // Quitar 103 deja a 102 con su dependencia #103 faltante.
        const res = await invoke({
            method: 'POST', url: '/api/roadmap/allowlist/remove',
            headers: authHeaders(), body: JSON.stringify({ issues: [103] }),
        });
        assert.equal(res.statusCode, 200);
        const b = json(res);
        assert.equal(b.ok, false);
        assert.equal(b.blocked, true);
        assert.equal(b.persisted, false);
        assert.deepEqual(b.inconsistencias['102'], [103]);
        // No persistió: 103 sigue en la allowlist.
        assert.ok(partialPause.readPreviousAllowlist().includes(103));

        // Con confirm:true persiste igual.
        const res2 = await invoke({
            method: 'POST', url: '/api/roadmap/allowlist/remove',
            headers: authHeaders(), body: JSON.stringify({ issues: [103], confirm: true }),
        });
        const b2 = json(res2);
        assert.equal(b2.ok, true);
        assert.equal(b2.persisted, true);
        assert.ok(!partialPause.readPreviousAllowlist().includes(103));
    } finally { teardownTmp(dir); }
});

test('remove que desincroniza la ola activa → warning bloqueante (desync proyectado)', async () => {
    const dir = setupTmp();
    try {
        // Ola activa con issues 100 y 200 (sin deps forward entre sí).
        waves.createPlannedWave({ name: 'Ola X', issues: [100, 200], concurrency_max: 2, window_minutes: 30 }, {});
        waves.promoteWaveToActive(1, {});
        seedAllowlist([100, 200]);
        // Quitar 100: sigue en la ola activa → desync proyectado.
        const res = await invoke({
            method: 'POST', url: '/api/roadmap/allowlist/remove',
            headers: authHeaders(), body: JSON.stringify({ issues: [100] }),
        });
        const b = json(res);
        assert.equal(b.blocked, true);
        assert.ok(b.desync, 'debe reportar desync proyectado');
        assert.ok(b.desync.missingFromAllowlist.includes(100));
    } finally { teardownTmp(dir); }
});

// --- Gates de seguridad (CA-7) ------------------------------------------------

test('preview y mutaciones sin credencial → 401', async () => {
    const dir = setupTmp();
    try {
        for (const op of ['preview', 'add', 'remove']) {
            const res = await invoke({
                method: 'POST', url: `/api/roadmap/allowlist/${op}`,
                headers: { 'content-type': 'application/json' }, // sin CSRF
                body: JSON.stringify({ issues: [100] }),
            });
            assert.equal(res.statusCode, 401, `${op} sin credencial debe dar 401`);
            assert.equal(json(res).code, 'unauthorized');
        }
    } finally { teardownTmp(dir); }
});

test('mutación con origen cruzado → 403 (anti-CSRF)', async () => {
    const dir = setupTmp();
    try {
        const res = await invoke({
            method: 'POST', url: '/api/roadmap/allowlist/preview',
            headers: Object.assign(authHeaders(), { 'sec-fetch-site': 'cross-site' }),
            body: JSON.stringify({ issues: [100] }),
        });
        assert.equal(res.statusCode, 403);
        assert.equal(json(res).code, 'forbidden');
    } finally { teardownTmp(dir); }
});

test('lectura de allowlist sólo desde loopback', async () => {
    const dir = setupTmp();
    try {
        seedAllowlist([100]);
        const res = await invoke({ method: 'GET', url: '/api/roadmap/allowlist', ip: '10.0.0.5' });
        assert.equal(res.statusCode, 403);
    } finally { teardownTmp(dir); }
});
