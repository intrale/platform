// Copyright (c) 2026 Leonel Larreta
// SPDX-License-Identifier: LicenseRef-Proprietary

'use strict';
// #7631 — Dirección humana desde approval-channel.jsonl (CA-4).
// Fixtures escritos con el writer REAL (`appendChained`) y el mismo shape que
// `approval-channel.js` (paso 14 de submitSignature).

const test = require('node:test');
const { after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { appendChained } = require('../audit-log');
const HD = require('../authorship/human-direction');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'authorship-hd-'));
after(() => { try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {} });

let seq = 0;
function newAudit() { return path.join(tmpRoot, `audit-${++seq}.jsonl`); }

const SHA = 'b'.repeat(40);
const SIGNER = '123456789';
const MAP = { [HD.identityKey(SIGNER)]: 'leitolarreta' };

function sign(file, over = {}) {
    const entry = {
        type: 'approval_channel_signature',
        gate: 'aceptacion',
        issue: 7631,
        verdict: 'signed',
        anchor_kind: 'commit-sha',
        anchor_value: SHA,
        signed_by: SIGNER,
        channel: 'telegram',
        at: '2026-09-23T17:00:00.000Z',
        ...over,
    };
    for (const k of Object.keys(entry)) if (entry[k] === undefined) delete entry[k];
    return appendChained({ file, entry, lockMaxMs: 0 });
}

function resolve(file, extra = {}) {
    return HD.resolveHumanDirection({ issue: 7631, headSha: SHA, auditFile: file, identityMap: MAP, ...extra });
}

test('firma GATE 2 válida → login mapeado, kind gate2 y hash_self de la entrada del canal', () => {
    const f = newAudit();
    const w = sign(f);
    const r = resolve(f);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.login, 'leitolarreta');
    assert.strictEqual(r.kind, 'gate2');
    assert.strictEqual(r.hash, w.hash_self);
    assert.strictEqual(r.ts, '2026-09-23T17:00:00.000Z');
});

test('firma GATE 1 (definicion) sola → gate1 sin exigir ancla de commit', () => {
    const f = newAudit();
    sign(f, { gate: 'definicion', anchor_kind: 'body-hash', anchor_value: 'sha256:x' });
    const r = resolve(f);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.kind, 'gate1');
});

test('sin archivo, sin entradas del issue o issue inválido → missing', () => {
    assert.deepStrictEqual(resolve(path.join(tmpRoot, 'no-existe.jsonl')), { ok: false, reason: 'missing' });
    const f = newAudit();
    sign(f, { issue: 1 });
    assert.strictEqual(resolve(f).reason, 'missing');
    assert.strictEqual(HD.resolveHumanDirection({ issue: 'x', auditFile: f }).reason, 'missing');
});

test('verdict de rechazo o rechazo posterior a una firma → missing', () => {
    const f1 = newAudit();
    sign(f1, { verdict: 'rejected' });
    assert.strictEqual(resolve(f1).reason, 'missing');
    const f2 = newAudit();
    sign(f2);
    sign(f2, { verdict: 'rejected' });
    assert.strictEqual(resolve(f2).reason, 'missing');
    const f3 = newAudit();
    sign(f3, { gate: 'definicion', anchor_kind: 'body-hash' });
    sign(f3, { gate: 'definicion', anchor_kind: 'body-hash', verdict: 're-definition' });
    assert.strictEqual(resolve(f3).reason, 'missing');
});

test('entrada *_request, canal whatsapp o "Telegram " (mayúscula y espacio) no cuentan', () => {
    const f = newAudit();
    sign(f, { type: 'approval_channel_signature_request' });
    sign(f, { channel: 'whatsapp' });
    sign(f, { channel: 'Telegram ' });
    sign(f, { channel: null });
    sign(f, { gate: 'otro-gate' });
    assert.strictEqual(resolve(f).reason, 'missing');
    const g = newAudit();
    sign(g, { channel: 'dashboard' });
    assert.strictEqual(resolve(g).ok, true);
});

test('gate2 sobre otro sha → anchor-mismatch, sin degradar a gate1', () => {
    const f = newAudit();
    sign(f, { gate: 'definicion', anchor_kind: 'body-hash' });
    sign(f, { anchor_value: 'c'.repeat(40) });
    assert.strictEqual(resolve(f).reason, 'anchor-mismatch');
    const g = newAudit();
    sign(g, { anchor_kind: 'commit' });
    assert.strictEqual(resolve(g).reason, 'anchor-mismatch');
    const h = newAudit();
    sign(h);
    assert.strictEqual(resolve(h, { headSha: '' }).reason, 'anchor-mismatch');
    assert.strictEqual(resolve(h, { headSha: SHA.toUpperCase() }).ok, true);
});

test('gate2 gana a gate1 cuando ambos están firmados', () => {
    const f = newAudit();
    sign(f);
    sign(f, { gate: 'definicion', anchor_kind: 'body-hash' });
    assert.strictEqual(resolve(f).kind, 'gate2');
});

test('cadena manipulada o línea ilegible → chain-broken', () => {
    const f = newAudit();
    sign(f);
    sign(f, { verdict: 'rejected' });
    const lines = fs.readFileSync(f, 'utf8').trim().split('\n');
    const second = JSON.parse(lines[1]);
    second.verdict = 'signed';
    fs.writeFileSync(f, `${lines[0]}\n${JSON.stringify(second)}\n`);
    assert.strictEqual(resolve(f).reason, 'chain-broken');
    const g = newAudit();
    fs.writeFileSync(g, 'no-es-json\n');
    assert.strictEqual(resolve(g).reason, 'chain-broken');
    const fakeFs = { existsSync: () => true, readFileSync: () => { throw new Error('EACCES'); } };
    assert.strictEqual(resolve(f, { fsImpl: fakeFs }).reason, 'chain-broken');
});

test('signed_by numérico sin mapeo → unmapped y el número no aparece en la salida', () => {
    const f = newAudit();
    sign(f, { signed_by: '987654321' });
    const r = resolve(f);
    assert.deepStrictEqual(r, { ok: false, reason: 'unmapped' });
    assert.ok(!JSON.stringify(r).includes('987654321'));
    const g = newAudit();
    sign(g);
    assert.strictEqual(resolve(g, { identityMap: { [HD.identityKey(SIGNER)]: 'leo larreta' } }).reason, 'unmapped');
    assert.strictEqual(resolve(g, { identityMap: null }).reason, 'unmapped');
});

test('identityKey hashea el signed_by (sha256) y nunca lo deja crudo', () => {
    const k = HD.identityKey(SIGNER);
    assert.match(k, /^sha256:[0-9a-f]{64}$/);
    assert.ok(!k.includes(SIGNER));
});

test('timestamp tomado de created_at cuando falta at', () => {
    const f = newAudit();
    sign(f, { at: undefined, created_at: Date.parse('2026-09-20T10:00:00Z') });
    assert.strictEqual(resolve(f).ts, '2026-09-20T10:00:00.000Z');
});
