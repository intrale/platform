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
