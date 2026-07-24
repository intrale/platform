'use strict';

// =============================================================================
// product-control-drainer.test.js — Drenador de la cola de onboarding (CA-3 · #4801).
//
// Cobertura → criterios de aceptación:
//   - Registra `status:onboarding` atómico/idempotente; producto legible por
//     `product-catalog.listProducts`.
//   - Unicidad AUTORITATIVA: rechaza projectId ya registrado (resuelve TOCTOU) y
//     en carrera de dos pedidos del mismo id sólo uno registra.
//   - No deja estado a medias ante fallo a mitad del registro.
//   - Fail-closed en id inseguro / id del pedido ≠ id del descriptor.
//   - Fail-open ante cola inexistente.
// =============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const drainer = require('../product-control-drainer');
const productCatalog = require('../product-catalog');
const { createKernelSupervisor } = require('../kernel-supervisor');

// -----------------------------------------------------------------------------
// Fake fs en memoria (para casos de fallo controlado sin tocar disco).
// -----------------------------------------------------------------------------
function makeFs(initial = {}) {
    const files = new Map(Object.entries(initial));
    const dirs = new Set();
    const api = {
        files, dirs,
        readdirSync(d) {
            const dd = String(d);
            const names = new Set();
            let found = dirs.has(dd);
            for (const k of files.keys()) {
                if (path.dirname(k) === dd) { names.add(path.basename(k)); found = true; }
            }
            if (!found) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; }
            return [...names];
        },
        readFileSync(p) {
            const k = String(p);
            if (!files.has(k)) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; }
            return files.get(k);
        },
        writeFileSync(p, data) { files.set(String(p), String(data)); },
        existsSync(p) { const k = String(p); return files.has(k) || dirs.has(k); },
        mkdirSync(p) { dirs.add(String(p)); },
        renameSync(from, to) {
            const f = String(from);
            if (!files.has(f)) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; }
            files.set(String(to), files.get(f));
            files.delete(f);
        },
        unlinkSync(p) { files.delete(String(p)); },
    };
    return api;
}

function makeAudit() {
    const entries = [];
    return { entries, appendChained({ entry }) { entries.push(entry); return { hash_self: 'deadbeef' }; } };
}

function validDescriptor(projectId = 'acme-store') {
    return {
        schemaVersion: '1.0',
        status: 'active', // el drenador debe forzar onboarding
        identity: { projectId, name: 'ACME Store' },
        repositories: [{ id: 'main', url: 'https://github.com/acme/store', role: 'primary' }],
    };
}

function onboardRequest(projectId = 'acme-store', overrides = {}) {
    return Object.assign({
        type: 'product_onboard_request',
        projectId,
        descriptor: validDescriptor(projectId),
        actor: 'leo',
        created_at: 1700000000000,
    }, overrides);
}

const QUEUE = path.join(os.tmpdir(), 'pcq');
const PROC = path.join(os.tmpdir(), 'pcp');
const DESC = path.join(os.tmpdir(), 'pcd');
const AUD = path.join(os.tmpdir(), 'a.jsonl');

function opts() { return { queueDir: QUEUE, processedDir: PROC, descriptorsDir: DESC, auditFile: AUD }; }

// -----------------------------------------------------------------------------
// Registro atómico + idempotente
// -----------------------------------------------------------------------------
test('registra onboarding: escribe descriptor status:onboarding y mueve el pedido a procesado', () => {
    const reqPath = path.join(QUEUE, 'onboard-acme-store-1.json');
    const _fs = makeFs({ [reqPath]: JSON.stringify(onboardRequest()) });
    const audit = makeAudit();

    const res = drainer.drainOnboardQueue(opts(), { fsImpl: _fs, auditImpl: audit, now: () => 1 });

    assert.deepEqual(res.registered, ['acme-store']);
    const descPath = path.join(DESC, 'acme-store.json');
    assert.ok(_fs.files.has(descPath), 'descriptor debe existir');
    assert.equal(JSON.parse(_fs.files.get(descPath)).status, 'onboarding');
    // pedido movido a procesado (ya no está en pendiente).
    assert.ok(!_fs.files.has(reqPath), 'pedido no debe seguir en pendiente');
    assert.ok(_fs.files.has(path.join(PROC, 'onboard-acme-store-1.json')), 'pedido en procesado');
    // audit del resultado.
    assert.ok(audit.entries.some(e => e.outcome === 'registered' && e.projectId === 'acme-store'));
});

test('idempotente: re-drenar tras registro no duplica ni rompe', () => {
    const reqPath = path.join(QUEUE, 'onboard-acme-store-1.json');
    const _fs = makeFs({ [reqPath]: JSON.stringify(onboardRequest()) });
    drainer.drainOnboardQueue(opts(), { fsImpl: _fs, auditImpl: makeAudit(), now: () => 1 });
    // Segundo drenaje: la cola ya está vacía (pedido movido). No lanza, nada nuevo.
    const res2 = drainer.drainOnboardQueue(opts(), { fsImpl: _fs, auditImpl: makeAudit(), now: () => 2 });
    assert.deepEqual(res2.registered, []);
});

// -----------------------------------------------------------------------------
// Unicidad autoritativa (TOCTOU)
// -----------------------------------------------------------------------------
test('unicidad autoritativa: rechaza projectId ya registrado (descriptor existe)', () => {
    const reqPath = path.join(QUEUE, 'onboard-acme-store-2.json');
    const descPath = path.join(DESC, 'acme-store.json');
    const _fs = makeFs({
        [reqPath]: JSON.stringify(onboardRequest()),
        [descPath]: JSON.stringify({ identity: { projectId: 'acme-store' }, status: 'active' }),
    });
    const res = drainer.drainOnboardQueue(opts(), { fsImpl: _fs, auditImpl: makeAudit(), now: () => 1 });

    assert.deepEqual(res.registered, []);
    assert.ok(res.rejected.some(r => r.projectId === 'acme-store' && r.reason === 'duplicate'));
    // NO se sobreescribió el descriptor existente.
    assert.equal(JSON.parse(_fs.files.get(descPath)).status, 'active');
    // pedido apartado a procesado (terminal).
    assert.ok(_fs.files.has(path.join(PROC, 'onboard-acme-store-2.json')));
});

test('carrera: dos pedidos del mismo projectId ⇒ sólo uno registra', () => {
    const r1 = path.join(QUEUE, 'onboard-acme-store-1.json');
    const r2 = path.join(QUEUE, 'onboard-acme-store-2.json');
    const _fs = makeFs({
        [r1]: JSON.stringify(onboardRequest()),
        [r2]: JSON.stringify(onboardRequest()),
    });
    const res = drainer.drainOnboardQueue(opts(), { fsImpl: _fs, auditImpl: makeAudit(), now: () => 1 });
    assert.equal(res.registered.length, 1);
    assert.equal(res.rejected.filter(x => x.reason === 'duplicate').length, 1);
});

// -----------------------------------------------------------------------------
// No deja estado a medias
// -----------------------------------------------------------------------------
test('fallo a mitad del registro (rename falla) ⇒ sin descriptor y pedido queda en pendiente', () => {
    const reqPath = path.join(QUEUE, 'onboard-acme-store-3.json');
    const _fs = makeFs({ [reqPath]: JSON.stringify(onboardRequest()) });
    const descPath = path.join(DESC, 'acme-store.json');
    // renameSync falla SÓLO para el rename del descriptor (tmp → final).
    const origRename = _fs.renameSync;
    _fs.renameSync = (from, to) => {
        if (String(to) === descPath) throw new Error('EIO rename');
        return origRename(from, to);
    };
    const res = drainer.drainOnboardQueue(opts(), { fsImpl: _fs, auditImpl: makeAudit(), now: () => 1 });

    assert.deepEqual(res.registered, []);
    assert.ok(res.errors.some(e => /write-failed/.test(e.reason)));
    assert.ok(!_fs.files.has(descPath), 'no debe quedar descriptor a medias');
    assert.ok(_fs.files.has(reqPath), 'pedido debe permanecer en pendiente para reintento');
    assert.ok(!_fs.files.has(path.join(PROC, 'onboard-acme-store-3.json')));
});

// -----------------------------------------------------------------------------
// Fail-closed id inseguro / mismatch
// -----------------------------------------------------------------------------
test('rechaza id inseguro y mismatch pedido≠descriptor sin registrar', () => {
    const rBad = path.join(QUEUE, 'onboard-bad.json');
    const rMismatch = path.join(QUEUE, 'onboard-mismatch.json');
    const _fs = makeFs({
        [rBad]: JSON.stringify(onboardRequest('../evil')),
        [rMismatch]: JSON.stringify(onboardRequest('acme-store', { projectId: 'acme-store', descriptor: validDescriptor('other-id') })),
    });
    const res = drainer.drainOnboardQueue(opts(), { fsImpl: _fs, auditImpl: makeAudit(), now: () => 1 });
    assert.deepEqual(res.registered, []);
    assert.equal(res.rejected.filter(x => x.reason === 'unsafe-id').length, 2);
    assert.ok(!_fs.files.has(path.join(DESC, 'other-id.json')));
});

test('ignora archivos que no son product_onboard_request', () => {
    const other = path.join(QUEUE, 'start-acme-store-1.json');
    const _fs = makeFs({ [other]: JSON.stringify({ type: 'product_control_request', action: 'start', projectId: 'acme-store' }) });
    const res = drainer.drainOnboardQueue(opts(), { fsImpl: _fs, auditImpl: makeAudit(), now: () => 1 });
    assert.deepEqual(res.registered, []);
    assert.deepEqual(res.rejected, []);
    assert.ok(_fs.files.has(other), 'el pedido de control no se toca');
});

test('fail-open: cola inexistente ⇒ summary vacío sin lanzar', () => {
    const _fs = makeFs({});
    const res = drainer.drainOnboardQueue(opts(), { fsImpl: _fs, auditImpl: makeAudit() });
    assert.deepEqual(res, { registered: [], rejected: [], errors: [] });
});

// -----------------------------------------------------------------------------
// Integración con listProducts sobre disco real (fuente unificada del catálogo)
// -----------------------------------------------------------------------------
test('el descriptor onboarding registrado es legible por product-catalog.listProducts', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'drainer-int-'));
    const queueDir = path.join(tmp, 'q');
    const procDir = path.join(tmp, 'p');
    const descDir = path.join(tmp, 'd');
    fs.mkdirSync(queueDir, { recursive: true });
    fs.writeFileSync(path.join(queueDir, 'onboard-acme-store-1.json'), JSON.stringify(onboardRequest()));

    const res = drainer.drainOnboardQueue({
        queueDir, processedDir: procDir, descriptorsDir: descDir, auditFile: path.join(tmp, 'a.jsonl'),
    });
    assert.deepEqual(res.registered, ['acme-store']);

    const products = productCatalog.listProducts(descDir);
    const p = products.find(x => x.projectId === 'acme-store');
    assert.ok(p, 'el producto debe aparecer en el catálogo');
    assert.equal(p.status, 'onboarding');

    fs.rmSync(tmp, { recursive: true, force: true });
});

// =============================================================================
// #4800 — creación automática del repo cableada al path REAL del kernel.
//
// El review semántico rechazó que la lógica de `gh repo create` (product-control-drain)
// fuera código huérfano: el drenador cableado al kernel (`drainOnboardQueue`) NO
// creaba repos. Estos tests demuestran que ahora SÍ se materializa la creación en el
// path real (drainOnboardQueue y, end-to-end, `bootProducts` del kernel).
// =============================================================================

// Fake `gh` con firma execFileSync: registra invocaciones; `viewExists` decide si el
// repo "ya existe"; `createThrows` fuerza un fallo real de `gh repo create`.
function makeFakeGh({ viewExists = false, createThrows = null } = {}) {
    const calls = [];
    const exec = (bin, args) => {
        calls.push([bin, ...(Array.isArray(args) ? args : [])]);
        if (Array.isArray(args) && args[1] === 'view') {
            if (viewExists) return '';
            throw new Error('not found');
        }
        if (Array.isArray(args) && args[1] === 'create') {
            if (createThrows) throw new Error(createThrows);
            return '';
        }
        return '';
    };
    return { calls, exec };
}

// Pedido de onboarding en modalidad `provenance:'create'` (sin url — la crea el kernel).
function createOnboardRequest(projectId = 'newco') {
    return {
        type: 'product_onboard_request',
        projectId,
        actor: 'leo',
        created_at: 1700000000000,
        descriptor: {
            schemaVersion: '1.0',
            status: 'active', // el drenador debe forzar onboarding
            identity: { projectId, name: 'NewCo' },
            repositories: [{
                id: 'main', role: 'primary', defaultBaseRef: 'main',
                provenance: 'create', create: { name: `${projectId}-repo`, org: 'intrale', visibility: 'private' },
            }],
        },
    };
}

test('#4800 · CA-1 — provenance:create: drainOnboardQueue crea el repo (gh por array de args) y persiste la url limpia', () => {
    const gh = makeFakeGh({ viewExists: false });
    const reqPath = path.join(QUEUE, 'onboard-newco-1.json');
    const _fs = makeFs({ [reqPath]: JSON.stringify(createOnboardRequest('newco')) });

    const res = drainer.drainOnboardQueue(
        { ...opts(), allowedOrgs: ['intrale'] },
        { fsImpl: _fs, auditImpl: makeAudit(), now: () => 1, execFileSync: gh.exec },
    );

    assert.deepEqual(res.registered, ['newco']);
    // `gh repo create` invocado SIEMPRE por array de args (anti command-injection · A03).
    assert.deepEqual(gh.calls.find(c => c[2] === 'create'), ['gh', 'repo', 'create', 'intrale/newco-repo', '--private']);
    // Descriptor persistido CON la url limpia + provenance existing + status onboarding.
    const desc = JSON.parse(_fs.files.get(path.join(DESC, 'newco.json')));
    assert.equal(desc.status, 'onboarding');
    assert.equal(desc.repositories[0].url, 'https://github.com/intrale/newco-repo');
    assert.equal(desc.repositories[0].provenance, 'existing');
    assert.ok(!desc.repositories[0].create, 'la spec create no se persiste en el descriptor');
});

test('#4800 · CA-4 — provenance:create idempotente: si el repo ya existe NO se re-crea pero igual persiste la url', () => {
    const gh = makeFakeGh({ viewExists: true });
    const reqPath = path.join(QUEUE, 'onboard-newco-2.json');
    const _fs = makeFs({ [reqPath]: JSON.stringify(createOnboardRequest('newco')) });

    const res = drainer.drainOnboardQueue(opts(), { fsImpl: _fs, auditImpl: makeAudit(), now: () => 1, execFileSync: gh.exec });

    assert.deepEqual(res.registered, ['newco']);
    assert.ok(!gh.calls.some(c => c[2] === 'create'), 'no debe crear si el repo ya existe');
    const desc = JSON.parse(_fs.files.get(path.join(DESC, 'newco.json')));
    assert.equal(desc.repositories[0].url, 'https://github.com/intrale/newco-repo');
});

test('#4800 · fail-closed — org fuera de la allowlist: NO registra, NO invoca gh create, aparta el pedido a procesado', () => {
    const gh = makeFakeGh({ viewExists: false });
    const req = createOnboardRequest('newco');
    req.descriptor.repositories[0].create.org = 'evilcorp';
    const reqPath = path.join(QUEUE, 'onboard-newco-3.json');
    const _fs = makeFs({ [reqPath]: JSON.stringify(req) });

    const res = drainer.drainOnboardQueue(opts(), { fsImpl: _fs, auditImpl: makeAudit(), now: () => 1, execFileSync: gh.exec });

    assert.deepEqual(res.registered, []);
    assert.ok(res.rejected.some(r => r.projectId === 'newco'), 'debe rechazar el pedido');
    assert.equal(gh.calls.filter(c => c[2] === 'create').length, 0, 'no debe invocar gh create con org fuera de allowlist');
    assert.ok(!_fs.files.has(path.join(DESC, 'newco.json')), 'no debe registrar descriptor (nunca producto a medias)');
    assert.ok(_fs.files.has(path.join(PROC, 'onboard-newco-3.json')), 'pedido terminal apartado a procesado');
});

test('#4800 · fail-closed — fallo real de gh create es recuperable: pedido queda en pendiente y NO se registra', () => {
    const gh = makeFakeGh({ viewExists: false, createThrows: 'HTTP 403: Resource not accessible' });
    const reqPath = path.join(QUEUE, 'onboard-newco-4.json');
    const _fs = makeFs({ [reqPath]: JSON.stringify(createOnboardRequest('newco')) });

    const res = drainer.drainOnboardQueue(opts(), { fsImpl: _fs, auditImpl: makeAudit(), now: () => 1, execFileSync: gh.exec });

    assert.deepEqual(res.registered, []);
    assert.ok(res.errors.some(e => /repo-create-failed/.test(e.reason)), 'el fallo de creación se reporta como error recuperable');
    assert.ok(!_fs.files.has(path.join(DESC, 'newco.json')), 'no registra descriptor a medias');
    assert.ok(_fs.files.has(reqPath), 'el pedido permanece en pendiente para reintentar el próximo ciclo');
});

test('#4800 · integración kernel — bootProducts drena onboarding y materializa el repo (path real, no drainOnce directo)', async () => {
    const gh = makeFakeGh({ viewExists: false });
    const reqPath = path.join(QUEUE, 'onboard-newco-5.json');
    const _fs = makeFs({ [reqPath]: JSON.stringify(createOnboardRequest('newco')) });
    let drainSummary = null;

    const supervisor = createKernelSupervisor({
        catalogStore: { listProducts: async () => [] },
        hydrate: false,
        // El loop del kernel (`bootProducts`) invoca ESTE drainOnboardQueue, que corre el
        // drenador REAL con `gh` mockeado — NO una llamada directa a drainOnce.
        drainOnboardQueue: () => {
            drainSummary = drainer.drainOnboardQueue(opts(), { fsImpl: _fs, auditImpl: makeAudit(), now: () => 1, execFileSync: gh.exec });
        },
    });

    await supervisor.bootProducts();

    assert.ok(drainSummary && drainSummary.registered.includes('newco'), 'el loop del kernel registró el producto onboarding');
    assert.deepEqual(gh.calls.find(c => c[2] === 'create'), ['gh', 'repo', 'create', 'intrale/newco-repo', '--private']);
    const desc = JSON.parse(_fs.files.get(path.join(DESC, 'newco.json')));
    assert.equal(desc.status, 'onboarding');
    assert.equal(desc.repositories[0].url, 'https://github.com/intrale/newco-repo', 'la url limpia quedó persistida por el path del kernel (CA-1)');
});

// =============================================================================
// #4809 — drainCreateWaveQueue (drenaje de create-wave · "el kernel ejecuta")
// =============================================================================

function waveRequest(projectId, wave, ts = 1700000000000) {
    return JSON.stringify({
        type: 'product_control_request',
        action: 'create-wave',
        projectId,
        wave: wave || {},
        actor: 'leo',
        source: 'dashboard',
        created_at: ts,
    });
}

const Q = path.join(os.tmpdir(), 'pcw', 'pendiente');
const P = path.join(os.tmpdir(), 'pcw', 'procesado');
const A = path.join(os.tmpdir(), 'pcw', 'audit.jsonl');
const qf = (name) => path.join(Q, name);
const pf = (name) => path.join(P, name);

function baseDeps(over = {}) {
    return Object.assign({
        fsImpl: null, // se setea en cada test
        auditImpl: makeAudit(),
        now: () => 1700000000000,
        isAuthorized: () => true,
        loadDescriptor: () => ({ valid: true, errors: [] }),
        associateWave: async () => ({ ok: true, created: true, version: 1 }),
    }, over);
}

test('#4809 · CA-1 — create-wave autorizado + descriptor completo ⇒ crea la ola y procesa', async () => {
    const fsImpl = makeFs({ [qf('create-wave-acme-store-1.json')]: waveRequest('acme-store', { label: 'ola-1' }) });
    let associated = null;
    const deps = baseDeps({ fsImpl, associateWave: async (pid, wave) => { associated = { pid, wave }; return { ok: true, created: true, version: 1 }; } });
    const sum = await drainer.drainCreateWaveQueue({ queueDir: Q, processedDir: P, auditFile: A }, deps);
    assert.deepEqual(sum.created, ['acme-store']);
    assert.equal(sum.rejected.length, 0);
    assert.deepEqual(associated, { pid: 'acme-store', wave: { label: 'ola-1' } });
    // Pedido movido a procesado.
    assert.ok(fsImpl.files.has(pf('create-wave-acme-store-1.json')));
    assert.ok(!fsImpl.files.has(qf('create-wave-acme-store-1.json')));
    // Audit del resultado.
    assert.ok(deps.auditImpl.entries.some(e => e.type === 'create_wave_drain_result' && e.outcome === 'created'));
});

test('#4809 · CA-2 — descriptor incompleto ⇒ NO se crea ola (fail-closed server-side)', async () => {
    const fsImpl = makeFs({ [qf('create-wave-acme-store-1.json')]: waveRequest('acme-store') });
    let called = false;
    const deps = baseDeps({
        fsImpl,
        loadDescriptor: () => ({ valid: false, errors: [{ path: 'authority', detail: 'falta' }] }),
        associateWave: async () => { called = true; return { ok: true, created: true }; },
    });
    const sum = await drainer.drainCreateWaveQueue({ queueDir: Q, processedDir: P, auditFile: A }, deps);
    assert.equal(called, false, 'no debe asociar ola con descriptor incompleto');
    assert.equal(sum.created.length, 0);
    assert.deepEqual(sum.rejected, [{ projectId: 'acme-store', reason: 'descriptor-incomplete' }]);
    assert.ok(deps.auditImpl.entries.some(e => e.outcome === 'rejected' && e.reason === 'descriptor-incomplete'));
});

test('#4809 · CA-5 — projectId no perteneciente al contexto ⇒ 403-lógico sin efecto', async () => {
    const fsImpl = makeFs({ [qf('create-wave-otro-1.json')]: waveRequest('otro-tenant') });
    let called = false;
    const deps = baseDeps({
        fsImpl,
        isAuthorized: (pid) => pid === 'acme-store', // el contexto NO incluye 'otro-tenant'
        loadDescriptor: () => { throw new Error('no debería leer el descriptor de otro tenant'); },
        associateWave: async () => { called = true; return { ok: true, created: true }; },
    });
    const sum = await drainer.drainCreateWaveQueue({ queueDir: Q, processedDir: P, auditFile: A }, deps);
    assert.equal(called, false, 'sin efecto: no asocia ola de otro tenant');
    assert.deepEqual(sum.rejected, [{ projectId: 'otro-tenant', reason: 'forbidden' }]);
    assert.ok(deps.auditImpl.entries.some(e => e.outcome === 'rejected' && e.reason === 'forbidden'));
});

test('#4809 · CA-3 — segunda primera ola (exists) ⇒ idempotente, no duplica', async () => {
    const fsImpl = makeFs({ [qf('create-wave-acme-store-2.json')]: waveRequest('acme-store') });
    const deps = baseDeps({ fsImpl, associateWave: async () => ({ ok: false, exists: true }) });
    const sum = await drainer.drainCreateWaveQueue({ queueDir: Q, processedDir: P, auditFile: A }, deps);
    assert.deepEqual(sum.idempotent, ['acme-store']);
    assert.equal(sum.created.length, 0);
    assert.ok(deps.auditImpl.entries.some(e => e.outcome === 'already-exists'));
});

test('#4809 · SEC-1b — projectId inseguro en el pedido ⇒ rechazo sin tocar path', async () => {
    const fsImpl = makeFs({ [qf('create-wave-bad.json')]: waveRequest('../../etc') });
    const deps = baseDeps({ fsImpl, isAuthorized: () => { throw new Error('no debe autorizar id inseguro'); } });
    const sum = await drainer.drainCreateWaveQueue({ queueDir: Q, processedDir: P, auditFile: A }, deps);
    assert.deepEqual(sum.rejected, [{ projectId: null, reason: 'unsafe-id' }]);
});

test('#4809 · fallo de infra del store ⇒ error recuperable, NO se procesa (reintenta)', async () => {
    const fsImpl = makeFs({ [qf('create-wave-acme-store-3.json')]: waveRequest('acme-store') });
    const deps = baseDeps({ fsImpl, associateWave: async () => { throw new Error('dynamo down'); } });
    const sum = await drainer.drainCreateWaveQueue({ queueDir: Q, processedDir: P, auditFile: A }, deps);
    assert.equal(sum.created.length, 0);
    assert.equal(sum.errors.length, 1);
    // Queda en pendiente para reintentar (no movido).
    assert.ok(fsImpl.files.has(qf('create-wave-acme-store-3.json')));
});

test('#4809 · cola inexistente ⇒ fail-open (summary vacío)', async () => {
    const fsImpl = makeFs({});
    const deps = baseDeps({ fsImpl });
    const sum = await drainer.drainCreateWaveQueue({ queueDir: '/tmp/nope', processedDir: P, auditFile: A }, deps);
    assert.deepEqual(sum, { created: [], idempotent: [], rejected: [], errors: [] });
});

test('#4809 · deps de decisión ausentes ⇒ throw fail-closed (nunca crea ola sin autz/gate)', async () => {
    const fsImpl = makeFs({});
    await assert.rejects(
        () => drainer.drainCreateWaveQueue({ queueDir: Q }, { fsImpl, isAuthorized: () => true }),
        /isAuthorized, loadDescriptor y associateWave/,
    );
});

test('#4809 · pedidos de otro type/action se ignoran (no se tocan)', async () => {
    const other = JSON.stringify({ type: 'product_control_request', action: 'start', projectId: 'acme-store' });
    const fsImpl = makeFs({ [qf('start-acme.json')]: other });
    const deps = baseDeps({ fsImpl });
    const sum = await drainer.drainCreateWaveQueue({ queueDir: Q, processedDir: P, auditFile: A }, deps);
    assert.deepEqual(sum, { created: [], idempotent: [], rejected: [], errors: [] });
    // El pedido start sigue en pendiente (no lo drena este consumidor).
    assert.ok(fsImpl.files.has(qf('start-acme.json')));
});
