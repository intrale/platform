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

// --- resolveAuthorizedSigners ------------------------------------------------
//
// #6206 (rebote 1) / #6226 — Estos casos eran dependientes del entorno:
// `resolveAuthorizedSigners` mezcla, por diseno (CA-4, `delivery.js:98-111`), la
// allowlist `cua.operator_chat_ids` con la credencial dedicada del operador que
// viaja en `TELEGRAM_LEO_OPERATOR_CHAT_ID`. El agente del pipeline corre con esa
// variable exportada, asi que el assert de "solo config" recogia ademas el chat id
// real y fallaba solo en ese entorno (verde en una shell limpia, rojo bajo el
// pulpo). La variable se aisla aca en vez de relajar el assert: el merge del env es
// comportamiento buscado y tiene sus propios casos mas abajo.
const OPERATOR_ENV = 'TELEGRAM_LEO_OPERATOR_CHAT_ID';

function withOperatorEnv(value, fn) {
    const had = Object.prototype.hasOwnProperty.call(process.env, OPERATOR_ENV);
    const previo = process.env[OPERATOR_ENV];
    if (value === undefined) delete process.env[OPERATOR_ENV];
    else process.env[OPERATOR_ENV] = value;
    try {
        return fn();
    } finally {
        // Restaurar exactamente el estado previo: `delete` si no existía, para no
        // dejar la cadena vacía (que `resolveAuthorizedSigners` trata distinto).
        if (had) process.env[OPERATOR_ENV] = previo;
        else delete process.env[OPERATOR_ENV];
    }
}

test('resolveAuthorizedSigners reúne cua.operator_chat_ids sin duplicar', () => {
    const signers = withOperatorEnv(undefined, () => delivery.resolveAuthorizedSigners({
        cua: { operator_chat_ids: ['1', '2', '2'] },
    }));
    assert.deepStrictEqual([...new Set(signers)].sort(), ['1', '2']);
});

test('resolveAuthorizedSigners suma la credencial del operador del entorno sin duplicarla', () => {
    // Cubre la rama env de `delivery.js:109-110`, que antes solo se ejercitaba por
    // accidente segun como estuviera el entorno del runner.
    const signers = withOperatorEnv('777', () => delivery.resolveAuthorizedSigners({
        cua: { operator_chat_ids: ['1', '777'] },
    }));
    assert.deepStrictEqual([...signers].sort(), ['1', '777']);
});

test('resolveAuthorizedSigners agrega al operador del entorno que no esta en la config', () => {
    // Caso que traia `origin/main` (#6226) y que el merge de #6206 no debe perder: la
    // credencial del entorno no solo se deduplica, tambien amplia la allowlist.
    const signers = withOperatorEnv('77', () => delivery.resolveAuthorizedSigners({
        cua: { operator_chat_ids: ['1'] },
    }));
    assert.deepStrictEqual([...signers].sort(), ['1', '77']);
});

test('resolveAuthorizedSigners ignora un entorno vacio y no inventa firmantes', () => {
    const signers = withOperatorEnv('   ', () => delivery.resolveAuthorizedSigners({
        cua: { operator_chat_ids: ['1'] },
    }));
    assert.deepStrictEqual(signers, ['1']);
});

test('#6226 - el aislamiento no filtra al caso base y restaura el valor previo', () => {
    // Simula el entorno del pipeline (variable presente) y verifica las dos
    // propiedades del helper: adentro no filtra, y al salir restaura.
    withOperatorEnv('6529617704', () => {
        const signers = withOperatorEnv(undefined, () =>
            delivery.resolveAuthorizedSigners({ cua: { operator_chat_ids: ['1', '2'] } }));
        assert.deepStrictEqual([...signers].sort(), ['1', '2']);
        assert.strictEqual(process.env[OPERATOR_ENV], '6529617704');
    });
});

// Aporte de #6179 preservado en el merge: la variable seteada pero en blanco no
// debe sumar un firmante vacio (resolveAuthorizedSigners la trimea y descarta).
test('resolveAuthorizedSigners ignora el operador de env vacio o en blanco', () => {
    const signers = withOperatorEnv('   ', () =>
        delivery.resolveAuthorizedSigners({ cua: { operator_chat_ids: ['1'] } }));
    assert.deepStrictEqual([...signers], ['1']);
});
