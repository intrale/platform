// =============================================================================
// audit-log.test.js — Tests para el hash chain SHA-256 (#3082 CA-13).
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const auditLog = require('../audit-log');

function makeTmpFile(prefix = 'audit-log-test') {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    return path.join(dir, 'log.jsonl');
}

test('canonicalJsonStringify ordena keys lexicográficamente', () => {
    const a = auditLog.canonicalJsonStringify({ b: 1, a: 2 });
    const b = auditLog.canonicalJsonStringify({ a: 2, b: 1 });
    assert.equal(a, b);
    assert.equal(a, '{"a":2,"b":1}');
});

test('canonicalJsonStringify maneja arrays y null', () => {
    assert.equal(auditLog.canonicalJsonStringify(null), 'null');
    assert.equal(auditLog.canonicalJsonStringify([3, 1, 2]), '[3,1,2]');
    assert.equal(auditLog.canonicalJsonStringify({ list: [1, 2] }), '{"list":[1,2]}');
});

test('computeEntryHash es determinístico para misma entry+hashPrev', () => {
    const e = { skill: 'qa', provider: 'anthropic' };
    const h1 = auditLog.computeEntryHash(e, 'GENESIS');
    const h2 = auditLog.computeEntryHash(e, 'GENESIS');
    assert.equal(h1, h2);
    assert.equal(h1.length, 64); // SHA-256 hex
});

test('computeEntryHash cambia si hashPrev cambia', () => {
    const e = { x: 1 };
    const h1 = auditLog.computeEntryHash(e, 'GENESIS');
    const h2 = auditLog.computeEntryHash(e, 'somethingelse');
    assert.notEqual(h1, h2);
});

test('appendChained crea archivo + escribe entry con hash_prev = GENESIS la primera vez', () => {
    const file = makeTmpFile();
    const r = auditLog.appendChained({ file, entry: { type: 'test', x: 1 } });
    assert.equal(r.hash_prev, 'GENESIS');
    assert.equal(typeof r.hash_self, 'string');
    assert.equal(r.hash_self.length, 64);

    const content = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(content.trim());
    assert.equal(parsed.hash_prev, 'GENESIS');
    assert.equal(parsed.hash_self, r.hash_self);
    assert.equal(parsed.x, 1);
});

test('appendChained encadena hashes correctamente en escrituras sucesivas', () => {
    const file = makeTmpFile();
    const r1 = auditLog.appendChained({ file, entry: { type: 'test', x: 1 } });
    const r2 = auditLog.appendChained({ file, entry: { type: 'test', x: 2 } });
    const r3 = auditLog.appendChained({ file, entry: { type: 'test', x: 3 } });

    assert.equal(r2.hash_prev, r1.hash_self);
    assert.equal(r3.hash_prev, r2.hash_self);
    assert.notEqual(r1.hash_self, r2.hash_self);
    assert.notEqual(r2.hash_self, r3.hash_self);

    const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
    assert.equal(lines.length, 3);
});

test('appendChained crea directorio padre si no existe', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-deep-'));
    const file = path.join(dir, 'sub', 'sub2', 'audit.jsonl');
    auditLog.appendChained({ file, entry: { type: 'test' } });
    assert.ok(fs.existsSync(file));
});

test('verifyChain devuelve ok=true para archivo recién escrito', () => {
    const file = makeTmpFile();
    auditLog.appendChained({ file, entry: { type: 'test', x: 1 } });
    auditLog.appendChained({ file, entry: { type: 'test', x: 2 } });
    const v = auditLog.verifyChain(file);
    assert.equal(v.ok, true);
    assert.equal(v.entriesChecked, 2);
});

test('verifyChain detecta hash_self corrupto', () => {
    const file = makeTmpFile();
    auditLog.appendChained({ file, entry: { type: 'test', x: 1 } });
    // Corromper la única línea
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
    const parsed = JSON.parse(lines[0]);
    parsed.x = 99999; // tampering
    fs.writeFileSync(file, JSON.stringify(parsed) + '\n');
    const v = auditLog.verifyChain(file);
    assert.equal(v.ok, false);
    assert.equal(v.brokenAt, 0);
    assert.match(v.reason, /hash_self mismatch/);
});

test('verifyChain detecta hash_prev mismatch entre entries', () => {
    const file = makeTmpFile();
    auditLog.appendChained({ file, entry: { type: 'test', x: 1 } });
    auditLog.appendChained({ file, entry: { type: 'test', x: 2 } });
    // Tamper la 2da línea: cambiar hash_prev a un valor inválido
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
    const e2 = JSON.parse(lines[1]);
    e2.hash_prev = 'FAKE_PREV';
    lines[1] = JSON.stringify(e2);
    fs.writeFileSync(file, lines.join('\n') + '\n');
    const v = auditLog.verifyChain(file);
    assert.equal(v.ok, false);
});

test('verifyChain en archivo inexistente devuelve ok=true con 0 entries', () => {
    const file = makeTmpFile();
    const v = auditLog.verifyChain(file);
    assert.equal(v.ok, true);
    assert.equal(v.entriesChecked, 0);
});

test('readAll devuelve [] para archivo inexistente y array de entries si existe', () => {
    const file = makeTmpFile();
    assert.deepEqual(auditLog.readAll(file), []);
    auditLog.appendChained({ file, entry: { type: 'test', x: 1 } });
    auditLog.appendChained({ file, entry: { type: 'test', x: 2 } });
    const all = auditLog.readAll(file);
    assert.equal(all.length, 2);
    assert.equal(all[0].x, 1);
    assert.equal(all[1].x, 2);
});

test('readLastHash devuelve GENESIS si el archivo no existe o está vacío', () => {
    const file = makeTmpFile();
    assert.equal(auditLog.readLastHash(file), 'GENESIS');
});

test('appendChained rechaza entry no-objeto', () => {
    const file = makeTmpFile();
    assert.throws(() => auditLog.appendChained({ file, entry: null }));
    assert.throws(() => auditLog.appendChained({ file, entry: 'a string' }));
    assert.throws(() => auditLog.appendChained({ file, entry: [1, 2, 3] }));
});

test('readLastHash detecta y lanza ante chain rota (última línea inválida)', () => {
    const file = makeTmpFile();
    fs.writeFileSync(file, 'this is not json\n');
    assert.throws(() => auditLog.readLastHash(file), /chain roto/);
});
