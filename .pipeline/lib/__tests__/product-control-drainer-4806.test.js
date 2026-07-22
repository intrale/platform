'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');

const drainer = require('../product-control-drainer');

function makeFs(initial = {}) {
    const files = new Map(Object.entries(initial));
    const dirs = new Set();
    return {
        files,
        dirs,
        readdirSync(d) {
            const names = new Set();
            let found = dirs.has(String(d));
            for (const k of files.keys()) {
                if (path.dirname(k) === String(d)) { names.add(path.basename(k)); found = true; }
            }
            if (!found) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; }
            return [...names];
        },
        readFileSync(p) { return files.get(String(p)); },
        mkdirSync(p) { dirs.add(String(p)); },
        renameSync(from, to) {
            files.set(String(to), files.get(String(from)));
            files.delete(String(from));
        },
    };
}

function audit() {
    const entries = [];
    return { entries, appendChained({ entry }) { entries.push(entry); return { hash_self: 'h' }; } };
}

const Q = path.join(os.tmpdir(), 'pc4806', 'pendiente');
const P = path.join(os.tmpdir(), 'pc4806', 'procesado');
const A = path.join(os.tmpdir(), 'pc4806', 'audit.jsonl');
const qf = (name) => path.join(Q, name);
const pf = (name) => path.join(P, name);

function descriptor(projectId = 'acme-store') {
    return {
        schemaVersion: '1.0',
        identity: { projectId, name: 'ACME Store' },
        repositories: [{ id: 'main', url: 'https://github.com/acme/store', role: 'primary' }],
        board: { ref: 'https://github.com/orgs/acme/projects/1', admissionLabels: ['Ready'], routing: [{ label: 'area:backend', capability: 'backend' }] },
        credentials: [{ ref: '~/.claude/secrets/credentials.json#acme', scopes: ['github'] }],
        capabilities: [{ interface: 'backend', skills: ['backend-dev'] }],
        authority: { signers: ['leitolarreta'], gates: { gate2: 'enforce' } },
    };
}

test('#4806 edit: drainEditQueue invoca putDescriptor y procesa el pedido', async () => {
    const fsImpl = makeFs({
        [qf('edit-acme-store.json')]: JSON.stringify({ type: 'product_control_request', action: 'edit', projectId: 'acme-store', descriptor: descriptor() }),
    });
    const au = audit();
    let written = null;
    const sum = await drainer.drainEditQueue({ queueDir: Q, processedDir: P, auditFile: A }, {
        fsImpl,
        auditImpl: au,
        isAuthorized: () => true,
        loadDescriptor: () => ({ valid: true, status: 'active' }),
        putDescriptor: async (pid, desc) => { written = { pid, desc }; return { ok: true }; },
        now: () => 1,
    });
    assert.deepEqual(sum.edited, ['acme-store']);
    assert.equal(written.pid, 'acme-store');
    assert.equal(written.desc.status, 'active');
    assert.ok(fsImpl.files.has(pf('edit-acme-store.json')));
    assert.ok(au.entries.some(e => e.type === 'edit_drain_result' && e.outcome === 'edited'));
});

test('#4806 edit: archived se rechaza fail-closed', async () => {
    const fsImpl = makeFs({
        [qf('edit-acme-store.json')]: JSON.stringify({ type: 'product_control_request', action: 'edit', projectId: 'acme-store', descriptor: descriptor() }),
    });
    let called = false;
    const sum = await drainer.drainEditQueue({ queueDir: Q, processedDir: P, auditFile: A }, {
        fsImpl,
        auditImpl: audit(),
        isAuthorized: () => true,
        loadDescriptor: () => ({ valid: true, status: 'archived' }),
        putDescriptor: async () => { called = true; },
    });
    assert.equal(called, false);
    assert.deepEqual(sum.rejected, [{ projectId: 'acme-store', reason: 'archived' }]);
});

test('#4806 deactivate: drainDeactivateQueue transiciona a archived via transitionStatus', async () => {
    const fsImpl = makeFs({
        [qf('deactivate-acme-store.json')]: JSON.stringify({ type: 'product_control_request', action: 'deactivate', projectId: 'acme-store', nonce: 'n-1' }),
    });
    let transitioned = null;
    const sum = await drainer.drainDeactivateQueue({ queueDir: Q, processedDir: P, auditFile: A }, {
        fsImpl,
        auditImpl: audit(),
        isAuthorized: () => true,
        loadDescriptor: () => ({ valid: true, status: 'active', descriptorPath: '/tmp/descriptors/acme-store.json' }),
        transitionStatus: (args) => { transitioned = args; return { ok: true, checksum: 'c' }; },
        now: () => 1,
    });
    assert.deepEqual(sum.archived, ['acme-store']);
    assert.deepEqual(transitioned, { descriptorPath: '/tmp/descriptors/acme-store.json', from: 'active', to: 'archived' });
    assert.ok(fsImpl.files.has(pf('deactivate-acme-store.json')));
});

test('#4806 create-wave: producto archived no recibe nuevas olas', async () => {
    const fsImpl = makeFs({
        [qf('create-wave-acme-store.json')]: JSON.stringify({ type: 'product_control_request', action: 'create-wave', projectId: 'acme-store', wave: {} }),
    });
    let called = false;
    const sum = await drainer.drainCreateWaveQueue({ queueDir: Q, processedDir: P, auditFile: A }, {
        fsImpl,
        auditImpl: audit(),
        isAuthorized: () => true,
        loadDescriptor: () => ({ valid: true, status: 'archived' }),
        associateWave: async () => { called = true; },
    });
    assert.equal(called, false);
    assert.deepEqual(sum.rejected, [{ projectId: 'acme-store', reason: 'archived' }]);
});
