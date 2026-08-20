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

// `resolveAuthorizedSigners` une la allowlist de config con la credential del
// operador en env (`TELEGRAM_LEO_OPERATOR_CHAT_ID`, delivery.js:109). Los tests
// de abajo controlan esa env var explicitamente: si se deja la del entorno real,
// el id del operador se cuela en el resultado y la asercion falla por ambiente
// y no por codigo. Mismo patron hermetico que `listener-callback.test.js:72`.
function withOperatorEnv(valor, fn) {
    const previo = process.env.TELEGRAM_LEO_OPERATOR_CHAT_ID;
    if (valor === undefined) delete process.env.TELEGRAM_LEO_OPERATOR_CHAT_ID;
    else process.env.TELEGRAM_LEO_OPERATOR_CHAT_ID = valor;
    try {
        return fn();
    } finally {
        if (previo === undefined) delete process.env.TELEGRAM_LEO_OPERATOR_CHAT_ID;
        else process.env.TELEGRAM_LEO_OPERATOR_CHAT_ID = previo;
    }
}

test('resolveAuthorizedSigners reúne cua.operator_chat_ids sin duplicar', () => {
    const signers = withOperatorEnv(undefined, () => delivery.resolveAuthorizedSigners({
        cua: { operator_chat_ids: ['1', '2', '2'] },
    }));
    assert.deepStrictEqual([...new Set(signers)].sort(), ['1', '2']);
});

test('CA-4 · resolveAuthorizedSigners suma la credential del operador desde env', () => {
    const signers = withOperatorEnv('777', () => delivery.resolveAuthorizedSigners({
        cua: { operator_chat_ids: ['1', '2'] },
    }));
    assert.deepStrictEqual([...signers].sort(), ['1', '2', '777']);
});

test('CA-4 · el operador de env no se duplica si ya está en la allowlist', () => {
    const signers = withOperatorEnv('1', () => delivery.resolveAuthorizedSigners({
        cua: { operator_chat_ids: ['1', '2'] },
    }));
    assert.deepStrictEqual([...signers].sort(), ['1', '2']);
});
