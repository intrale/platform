// =============================================================================
// delivery-gate2.test.js — GATE 2 defense-in-depth en delivery.js (#4575, CA-3)
//
// Verifica que `checkOperatorSignatureGate` (revalidación firma↔HEAD justo antes
// del merge) bloquea cuando no hay firma verde para el HEAD actual, y aprueba
// cuando la firma coincide. Kill switch OFF ⇒ no-op.
// =============================================================================
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const delivery = require('../delivery');
const gate = require('../lib/operator-signature');

function mkTmp() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'delgate-'));
    fs.mkdirSync(path.join(dir, 'audit'), { recursive: true });
    return dir;
}

const SHA = 'c'.repeat(40);
const SIGNER = '999';

test('kill switch OFF ⇒ gate no aplica (ok)', () => {
    const r = delivery.checkOperatorSignatureGate({
        issueNumber: 4575, headSha: SHA,
        config: { operator_signature: { enabled: false } },
        authorizedSigners: [SIGNER], pipelineDir: mkTmp(),
    });
    assert.strictEqual(r.ok, true);
});

test('CA-3 · enforce sin firma para el HEAD ⇒ bloquea la entrega', () => {
    const r = delivery.checkOperatorSignatureGate({
        issueNumber: 4575, headSha: SHA,
        config: { operator_signature: { enabled: true, gate_mode: 'enforce' } },
        authorizedSigners: [SIGNER], pipelineDir: mkTmp(),
    });
    assert.strictEqual(r.ok, false);
    assert.match(r.reason, /GATE 2/);
});

test('CA-3 · enforce con firma verde ligada al HEAD ⇒ aprueba', () => {
    const pipelineDir = mkTmp();
    const nres = gate.issueNonce({ issueId: 4575, sha: SHA, options: { pipelineDir, now: 1000 } });
    gate.recordAcceptanceSignature({
        issueId: 4575, signedBy: SIGNER, signedCommit: SHA, nonce: nres.nonce, verdict: 'signed',
        options: { pipelineDir, authorizedSigners: [SIGNER], now: 1001 },
    });
    const r = delivery.checkOperatorSignatureGate({
        issueNumber: 4575, headSha: SHA,
        config: { operator_signature: { enabled: true, gate_mode: 'enforce' } },
        authorizedSigners: [SIGNER], pipelineDir,
    });
    assert.strictEqual(r.ok, true);
});

test('CA-3 · enforce con firma para OTRO SHA (HEAD avanzó) ⇒ bloquea', () => {
    const pipelineDir = mkTmp();
    const otherSha = 'd'.repeat(40);
    const nres = gate.issueNonce({ issueId: 4575, sha: otherSha, options: { pipelineDir, now: 1000 } });
    gate.recordAcceptanceSignature({
        issueId: 4575, signedBy: SIGNER, signedCommit: otherSha, nonce: nres.nonce, verdict: 'signed',
        options: { pipelineDir, authorizedSigners: [SIGNER], now: 1001 },
    });
    const r = delivery.checkOperatorSignatureGate({
        issueNumber: 4575, headSha: SHA, // HEAD distinto al firmado
        config: { operator_signature: { enabled: true, gate_mode: 'enforce' } },
        authorizedSigners: [SIGNER], pipelineDir,
    });
    assert.strictEqual(r.ok, false);
    assert.match(r.reason, /HEAD avanzó/);
});

// #6271 — este test era NO HERMETICO: `resolveAuthorizedSigners` suma por
// diseño `process.env.TELEGRAM_LEO_OPERATOR_CHAT_ID` a los signers (delivery.js
// ~L109), asi que en cualquier entorno con esa variable exportada (la maquina
// del pulpo la tiene) el assert recibia un id extra y fallaba. El defecto era
// del test, no del codigo: el merge del operador por env es comportamiento
// intencional. Aislamos la variable para que el resultado no dependa del
// entorno, y cubrimos el merge en un test propio en vez de perderlo.
test('resolveAuthorizedSigners reúne cua.operator_chat_ids sin duplicar', () => {
    const prev = process.env.TELEGRAM_LEO_OPERATOR_CHAT_ID;
    delete process.env.TELEGRAM_LEO_OPERATOR_CHAT_ID;
    try {
        const signers = delivery.resolveAuthorizedSigners({ cua: { operator_chat_ids: ['1', '2', '2'] } });
        assert.deepStrictEqual([...new Set(signers)].sort(), ['1', '2']);
    } finally {
        if (prev === undefined) delete process.env.TELEGRAM_LEO_OPERATOR_CHAT_ID;
        else process.env.TELEGRAM_LEO_OPERATOR_CHAT_ID = prev;
    }
});

// #6271 — contraparte explicita: el operador declarado por env SI debe sumarse
// a los signers (y sin duplicar si ya venia en la config).
test('resolveAuthorizedSigners suma el operador de TELEGRAM_LEO_OPERATOR_CHAT_ID sin duplicar', () => {
    const prev = process.env.TELEGRAM_LEO_OPERATOR_CHAT_ID;
    process.env.TELEGRAM_LEO_OPERATOR_CHAT_ID = '99';
    try {
        const signers = delivery.resolveAuthorizedSigners({ cua: { operator_chat_ids: ['1', '99'] } });
        assert.deepStrictEqual([...signers].sort(), ['1', '99']);
    } finally {
        if (prev === undefined) delete process.env.TELEGRAM_LEO_OPERATOR_CHAT_ID;
        else process.env.TELEGRAM_LEO_OPERATOR_CHAT_ID = prev;
    }
});
