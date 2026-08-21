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


// `resolveAuthorizedSigners` (delivery.js:109) lee `TELEGRAM_LEO_OPERATOR_CHAT_ID`
// de `process.env` en tiempo de llamada. Sin aislar esa variable el test depende
// del entorno: en la máquina del operador (que la exporta de verdad) el id real
// se colaba en el resultado y la suite quedaba en rojo por ambiente, no por
// código. Mismo patrón `withEnv` que `cua-operator-resolve.test.js:29`.
function withOperatorEnv(value, fn) {
    const KEY = 'TELEGRAM_LEO_OPERATOR_CHAT_ID';
    const saved = process.env[KEY];
    try {
        if (value === undefined) delete process.env[KEY];
        else process.env[KEY] = value;
        return fn();
    } finally {
        if (saved === undefined) delete process.env[KEY];
        else process.env[KEY] = saved;
    }
}

test('resolveAuthorizedSigners reúne cua.operator_chat_ids sin duplicar', () => {
    withOperatorEnv(undefined, () => {
        const signers = delivery.resolveAuthorizedSigners({ cua: { operator_chat_ids: ['1', '2', '2'] } });
        assert.deepStrictEqual([...new Set(signers)].sort(), ['1', '2']);
    });
});

// La rama `envOperator` de `resolveAuthorizedSigners` (delivery.js:109-110) antes
// solo se ejercitaba por accidente, segun tuviera o no la variable la maquina que
// corria la suite. Aca queda cubierta de forma explicita y deterministica.
test('resolveAuthorizedSigners suma el operador de TELEGRAM_LEO_OPERATOR_CHAT_ID sin duplicar', () => {
    // Ya viene en la config: el operador de env no debe duplicarlo.
    withOperatorEnv('2', () => {
        assert.deepStrictEqual(
            delivery.resolveAuthorizedSigners({ cua: { operator_chat_ids: ['1', '2'] } }).sort(),
            ['1', '2'],
        );
    });
    // No esta en la config: si se agrega.
    withOperatorEnv('77', () => {
        assert.deepStrictEqual(
            delivery.resolveAuthorizedSigners({ cua: { operator_chat_ids: ['1'] } }).sort(),
            ['1', '77'],
        );
    });
});

test('resolveAuthorizedSigners ignora la credential dedicada vacia o en blanco', () => {
    withOperatorEnv('   ', () => {
        const signers = delivery.resolveAuthorizedSigners({ cua: { operator_chat_ids: ['1'] } });
        assert.deepStrictEqual([...signers], ['1']);
    });
});
