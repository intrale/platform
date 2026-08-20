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

test('resolveAuthorizedSigners reúne cua.operator_chat_ids sin duplicar', () => {
    // `resolveAuthorizedSigners` suma TELEGRAM_LEO_OPERATOR_CHAT_ID a los ids de
    // config (delivery.js:109). En la máquina del operador esa variable está
    // seteada, así que sin aislarla el test compara contra un firmante real del
    // entorno y falla — verde en CI, rojo en la máquina que corre el pipeline.
    // Se neutraliza sólo durante el caso y se restaura el valor previo.
    const previo = process.env.TELEGRAM_LEO_OPERATOR_CHAT_ID;
    delete process.env.TELEGRAM_LEO_OPERATOR_CHAT_ID;
    try {
        const signers = delivery.resolveAuthorizedSigners({ cua: { operator_chat_ids: ['1', '2', '2'] } });
        assert.deepStrictEqual([...new Set(signers)].sort(), ['1', '2']);
    } finally {
        if (previo === undefined) delete process.env.TELEGRAM_LEO_OPERATOR_CHAT_ID;
        else process.env.TELEGRAM_LEO_OPERATOR_CHAT_ID = previo;
    }
});

test('resolveAuthorizedSigners suma el operador de entorno sin duplicarlo', () => {
    // Contracara del caso anterior: el aporte de la variable de entorno es
    // comportamiento deseado (delivery.js:109-110), así que queda cubierto de
    // forma explícita y determinística en vez de depender del entorno real.
    const previo = process.env.TELEGRAM_LEO_OPERATOR_CHAT_ID;
    process.env.TELEGRAM_LEO_OPERATOR_CHAT_ID = '2';
    try {
        const signers = delivery.resolveAuthorizedSigners({ cua: { operator_chat_ids: ['1', '2'] } });
        assert.deepStrictEqual([...signers].sort(), ['1', '2']);
    } finally {
        if (previo === undefined) delete process.env.TELEGRAM_LEO_OPERATOR_CHAT_ID;
        else process.env.TELEGRAM_LEO_OPERATOR_CHAT_ID = previo;
    }
});
