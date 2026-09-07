'use strict';

// =============================================================================
// gate-signature-request-product.test.js — firma GATE 2 atada al productId
// (#4778 · CA-2.2 · no repudio). Extiende gate-signature-request.js de forma
// aditiva y retro-compatible.
// =============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');

const gsr = require('../gate-signature-request');

function fakeFs() {
    const files = {};
    return {
        files,
        mkdirSync() {},
        writeFileSync(p, data) { files[String(p)] = String(data); },
        readFileSync(p) { const k = String(p); if (!(k in files)) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; } return files[k]; },
        existsSync(p) { return String(p) in files; },
    };
}
function fakeAudit() { const entries = []; return { entries, appendChained({ entry }) { entries.push(entry); return { hash_self: 'x' }; } }; }
function deps() { return { fsImpl: fakeFs(), auditImpl: fakeAudit(), now: () => 1700000000000, queueDir: '/tmp/q', auditFile: '/tmp/a.jsonl' }; }

test('safeProductId acepta ids válidos y descarta inseguros', () => {
    assert.equal(gsr.safeProductId('acme-store'), 'acme-store');
    for (const bad of ['../evil', 'a/b', 'UPPER', '', null, "x'); alert(1)"]) {
        assert.equal(gsr.safeProductId(bad), null);
    }
});

test('CA-2.2: la decisión encolada lleva el productId atado (no repudio)', () => {
    const d = deps();
    const res = gsr.enqueueDecision({ issue: 1732, gate: 'definicion', decision: 'aprobar', productId: 'acme-store', actor: 'leo' }, d);
    assert.equal(res.ok, true);
    assert.equal(res.productId, 'acme-store');
    assert.equal(d.auditImpl.entries[0].productId, 'acme-store');
    const written = Object.values(d.fsImpl.files)[0];
    assert.ok(JSON.parse(written).productId === 'acme-store');
});

test('retro-compat: sin productId la decisión queda con productId null', () => {
    const d = deps();
    const res = gsr.enqueueDecision({ issue: 1732, gate: 'definicion', decision: 'rechazar' }, d);
    assert.equal(res.ok, true);
    assert.equal(res.productId, null);
    assert.equal(d.auditImpl.entries[0].productId, null);
});

test('A03: un productId inseguro se descarta (no se propaga al audit)', () => {
    const d = deps();
    const res = gsr.enqueueDecision({ issue: 1732, gate: 'definicion', decision: 'aprobar', productId: '../evil' }, d);
    assert.equal(res.ok, true);
    assert.equal(res.productId, null);
    assert.equal(d.auditImpl.entries[0].productId, null);
});
