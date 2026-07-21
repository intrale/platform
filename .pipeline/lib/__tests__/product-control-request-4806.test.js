'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const pcr = require('../product-control-request');

function makeFakeFs() {
    const files = {};
    return {
        files,
        mkdirSync() {},
        writeFileSync(p, data) { files[String(p)] = String(data); },
    };
}

function makeFakeAudit() {
    const entries = [];
    return { entries, appendChained({ entry }) { entries.push(entry); return { hash_self: 'h' }; } };
}

function deps() {
    return {
        fsImpl: makeFakeFs(),
        auditImpl: makeFakeAudit(),
        now: () => 1700000000000,
        queueDir: '/tmp/q',
        auditFile: '/tmp/a.jsonl',
        runBootstrap: () => ({ ok: true }),
    };
}

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

test('#4806 edit: enqueueEdit encola action=edit con descriptor validado', () => {
    const d = deps();
    const res = pcr.enqueueEdit({ projectId: 'acme-store', descriptor: descriptor(), actor: 'leo' }, d);
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(res.status, 202);
    assert.equal(res.action, 'edit');
    const record = JSON.parse(d.fsImpl.files[Object.keys(d.fsImpl.files)[0]]);
    assert.equal(record.action, 'edit');
    assert.equal(record.descriptor.identity.projectId, 'acme-store');
    assert.equal(d.auditImpl.entries[0].action, 'edit');
});

test('#4806 edit: rechaza id inseguro y descriptor que no coincide', () => {
    const d = deps();
    assert.equal(pcr.enqueueEdit({ projectId: '../bad', descriptor: descriptor() }, d).status, 400);
    assert.equal(pcr.enqueueEdit({ projectId: 'otro', descriptor: descriptor() }, d).status, 400);
    assert.equal(Object.keys(d.fsImpl.files).length, 0);
});

test('#4806 deactivate: exige nonce y encola action=deactivate', () => {
    const d = deps();
    assert.equal(pcr.enqueueDeactivate({ projectId: 'acme-store' }, d).status, 400);
    const res = pcr.enqueueDeactivate({ projectId: 'acme-store', nonce: 'n-1' }, d);
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(res.action, 'deactivate');
    const record = JSON.parse(d.fsImpl.files[Object.keys(d.fsImpl.files)[0]]);
    assert.equal(record.action, 'deactivate');
    assert.equal(record.nonce, 'n-1');
});

test('#4806 deactivate: rechaza id inseguro sin encolar', () => {
    const d = deps();
    const res = pcr.enqueueDeactivate({ projectId: '../../etc', nonce: 'n-1' }, d);
    assert.equal(res.ok, false);
    assert.equal(res.status, 400);
    assert.equal(Object.keys(d.fsImpl.files).length, 0);
});
