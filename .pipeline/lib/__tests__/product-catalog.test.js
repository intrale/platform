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
