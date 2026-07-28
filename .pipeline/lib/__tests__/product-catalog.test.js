'use strict';

// =============================================================================
// product-catalog.test.js — Enumeración read-only del catálogo de productos (#4778).
//
// Cobertura:
//   - Lee descriptores válidos y proyecta {projectId,name,status,role}.
//   - Fail-open: archivos ilegibles/inválidos y dir inexistente no rompen.
//   - Fail-closed: descriptor con projectId inseguro NO entra al catálogo (A03).
//   - Whitelist: nunca hace passthrough de authority/credentials (no filtra).
//   - Orden estable: primario primero, luego alfabético.
// =============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const catalog = require('..' + path.sep + 'product-catalog.js');

function tmpDir() {
    const dir = path.join(os.tmpdir(), 'pc-test-' + process.pid + '-' + Math.floor(process.hrtime()[1]));
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}
function writeDescriptor(dir, file, obj) {
    fs.writeFileSync(path.join(dir, file), typeof obj === 'string' ? obj : JSON.stringify(obj), 'utf8');
}

test('listProducts lee descriptores válidos y proyecta la whitelist', () => {
    const dir = tmpDir();
    try {
        writeDescriptor(dir, 'intrale.json', {
            status: 'active',
            identity: { projectId: 'intrale-platform', name: 'Intrale Platform' },
            repositories: [{ id: 'platform', url: 'https://github.com/intrale/platform', role: 'primary' }],
            authority: { signers: ['leitolarreta'] },
            credentials: [{ ref: '~/.claude/secrets/credentials.json#intrale' }],
        });
        const out = catalog.listProducts(dir);
        assert.equal(out.length, 1);
        assert.equal(out[0].projectId, 'intrale-platform');
        assert.equal(out[0].name, 'Intrale Platform');
        assert.equal(out[0].status, 'active');
        assert.equal(out[0].role, 'primary');
        // Whitelist: no expone authority ni credentials.
        assert.equal(out[0].authority, undefined);
        assert.equal(out[0].credentials, undefined);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('fail-closed: descriptor con projectId inseguro no entra al catálogo', () => {
    const dir = tmpDir();
    try {
        writeDescriptor(dir, 'evil.json', { identity: { projectId: '../evil', name: 'Evil' } });
        writeDescriptor(dir, 'upper.json', { identity: { projectId: 'BadCase', name: 'Bad' } });
        writeDescriptor(dir, 'ok.json', { status: 'active', identity: { projectId: 'acme-store', name: 'ACME' } });
        const out = catalog.listProducts(dir);
        assert.equal(out.length, 1);
        assert.equal(out[0].projectId, 'acme-store');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('fail-open: archivos inválidos/no-json se omiten sin romper el barrido', () => {
    const dir = tmpDir();
    try {
        writeDescriptor(dir, 'broken.json', '{ not valid json');
        writeDescriptor(dir, 'notes.txt', 'ignorar');
        writeDescriptor(dir, 'good.json', { status: 'active', identity: { projectId: 'good-prod', name: 'Good' } });
        const out = catalog.listProducts(dir);
        assert.equal(out.length, 1);
        assert.equal(out[0].projectId, 'good-prod');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('dir inexistente ⇒ [] (fail-open, sin excepción)', () => {
    assert.deepEqual(catalog.listProducts(path.join(os.tmpdir(), 'no-existe-' + process.pid)), []);
    assert.deepEqual(catalog.listProducts(null), []);
    assert.deepEqual(catalog.listProducts(''), []);
});

test('orden estable: primario primero, luego alfabético por projectId', () => {
    const dir = tmpDir();
    try {
        writeDescriptor(dir, 'z.json', { status: 'active', identity: { projectId: 'zeta-prod', name: 'Zeta' } });
        writeDescriptor(dir, 'a.json', { status: 'active', identity: { projectId: 'alpha-prod', name: 'Alpha' } });
        writeDescriptor(dir, 'p.json', {
            status: 'active',
            identity: { projectId: 'primary-prod', name: 'Primary' },
            repositories: [{ id: 'm', url: 'https://github.com/x/y', role: 'primary' }],
        });
        const out = catalog.listProducts(dir);
        assert.equal(out[0].projectId, 'primary-prod'); // primario primero
        assert.equal(out[1].projectId, 'alpha-prod');   // luego alfabético
        assert.equal(out[2].projectId, 'zeta-prod');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('deduplica por projectId (primer descriptor gana)', () => {
    const dir = tmpDir();
    try {
        writeDescriptor(dir, 'a.json', { status: 'active', identity: { projectId: 'dup-prod', name: 'First' } });
        writeDescriptor(dir, 'b.json', { status: 'inactive', identity: { projectId: 'dup-prod', name: 'Second' } });
        const out = catalog.listProducts(dir);
        assert.equal(out.length, 1);
        assert.equal(out[0].projectId, 'dup-prod');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

// =============================================================================
// #5135 CA-2 — NO-REGRESIÓN de `failLoud`.
//
// El flag es opt-in: con `failLoud` ausente o false el comportamiento de los TRES
// puntos de degradación tiene que ser EXACTAMENTE el de hoy (barrido FS + traza).
// Es lo que hace que la ventana de cutover cerrada (el default de `config.yaml`)
// no cambie nada del arranque normal — CA-1.
// =============================================================================

const DEGRADACIONES = [
    ['store no instanciable', { createStore: () => { throw new Error('no driver'); } }],
    ['store ausente', { createStore: () => null }],
    ['fallo de infra en listProducts', { store: { listProducts: async () => { throw new Error('infra down'); } } }],
];

test('#5135 CA-2: SIN failLoud, los 3 caminos degradados siguen devolviendo el barrido FS', async () => {
    for (const [nombre, extra] of DEGRADACIONES) {
        const dir = tmpDir();
        try {
            writeDescriptor(dir, 'p.json', { status: 'active', identity: { projectId: 'acme-store', name: 'ACME' } });
            const razones = [];
            const out = await catalog.listProductsResolved({
                durable: true, descriptorsDir: dir, onDegraded: (r) => razones.push(r), ...extra,
            });
            assert.equal(out.length, 1, `${nombre}: debe caer a FS como hoy`);
            assert.equal(out[0].projectId, 'acme-store');
            assert.equal(razones.length, 1, `${nombre}: y dejar la traza del modo degradado`);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    }
});

test('#5135 CA-2: `failLoud: false` explícito es idéntico a no pasarlo', async () => {
    for (const [nombre, extra] of DEGRADACIONES) {
        const dir = tmpDir();
        try {
            writeDescriptor(dir, 'p.json', { status: 'active', identity: { projectId: 'acme-store', name: 'ACME' } });
            const out = await catalog.listProductsResolved({
                durable: true, descriptorsDir: dir, failLoud: false, onDegraded: () => {}, ...extra,
            });
            assert.equal(out.length, 1, `${nombre}: failLoud:false no debe cortar el fallback`);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    }
});

test('#5135 CA-2: valores truthy que NO son `true` tampoco activan failLoud (fail-closed)', async () => {
    const dir = tmpDir();
    try {
        writeDescriptor(dir, 'p.json', { status: 'active', identity: { projectId: 'acme-store', name: 'ACME' } });
        for (const valor of ['true', 1, {}]) {
            const out = await catalog.listProductsResolved({
                durable: true, descriptorsDir: dir, failLoud: valor, onDegraded: () => {},
                store: { listProducts: async () => { throw new Error('infra down'); } },
            });
            assert.equal(out.length, 1, `failLoud=${JSON.stringify(valor)} no debe cortar el fallback`);
        }
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('#5135 CA-2: con failLoud propaga KernelDegradedError y conserva la razón', async () => {
    const dir = tmpDir();
    try {
        writeDescriptor(dir, 'p.json', { status: 'active', identity: { projectId: 'acme-store', name: 'ACME' } });
        await assert.rejects(
            () => catalog.listProductsResolved({
                durable: true, descriptorsDir: dir, failLoud: true, onDegraded: () => {},
                store: { listProducts: async () => { throw new Error('infra down'); } },
            }),
            (e) => e instanceof catalog.KernelDegradedError
                && e.name === 'KernelDegradedError'
                && e.reason === 'infra down',
        );
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('#5135 CA-1: con durable:false el flag failLoud es inerte (el modo FS no cambia)', async () => {
    const dir = tmpDir();
    try {
        writeDescriptor(dir, 'p.json', { status: 'active', identity: { projectId: 'acme-store', name: 'ACME' } });
        const out = await catalog.listProductsResolved({ durable: false, descriptorsDir: dir, failLoud: true });
        assert.equal(out.length, 1, 'el camino FS ni siquiera pasa por la degradación');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
