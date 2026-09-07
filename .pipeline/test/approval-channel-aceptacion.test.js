// =============================================================================
// Tests approval-channel.js — rama de despacho del gate `aceptacion` (#6206)
// =============================================================================
//
// POR QUÉ ESTE ARCHIVO (rechazo rev-3 de `aprobacion`, bloqueante):
//
//   «El gate `aceptacion` del canal no es operable end-to-end desde el kernel y
//    su rama de despacho no tiene un solo test. `recordAcceptanceSignature`
//    exige (CA-5) un nonce emitido por `operator-signature.issueNonce`, y el
//    canal nunca lo emite: `requestSignature({gate:'aceptacion'})` devuelve
//    ok:true sin ese nonce, y `submitSignature` con exactamente lo que el kernel
//    entrega falla con "nonce inexistente". Sólo firma si el adaptador llama
//    DIRECTO a `issueNonce`, o sea escribiendo en el audit chain del gate FUERA
//    del kernel.»
//
// Lo que se bloquea acá, entonces:
//   · [E2E]      request → submit con EXACTAMENTE lo que el kernel entrega ⇒
//                firma persistida. Sin que el test llame nunca a `issueNonce`.
//   · [CA-A1]    el kernel es el ÚNICO writer: el `nonce_issued` de la cadena lo
//                escribió `requestSignature`, no el adaptador.
//   · [CA-A2.b]  `p.evidenceHash` del cliente se IGNORA; el acta persiste el
//                digest server-side. Ídem `p.gateMode`.
//   · [A01/A02]  el nonce es capability bearer: no va al depósito ni al audit
//                del canal.
//   · [CA-5]     nonce ausente / con forma rotada / de otro issue / de otro SHA /
//                ya consumido / expirado ⇒ rechazo fail-closed SIN acta.
//   · [CA-A5]    companion de audit (D-2) alimentado también por este gate.
//   · [CA-A7]    el artefacto cambió tras firmar ⇒ se pide firma nueva.
//
// Estrategia: tmpdir aislado por test. El writer de GATE 2 escribe en
// `<tmp>/audit/operator-signatures.jsonl` vía `writerPipelineDir`.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const channel = require('../lib/approval-channel');
const actionToken = require('../lib/action-token');
const auditLog = require('../lib/audit-log');
const gate2 = require('../lib/operator-signature');

const OPERATOR = '12345678';
const SECRET = 'secreto-de-test-6206-aceptacion';
const COMMIT_A = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const COMMIT_B = 'fedcba9876543210fedcba9876543210fedcba98';

// -----------------------------------------------------------------------------
// helpers
// -----------------------------------------------------------------------------

function mkEnv(over = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-aceptacion-'));
    fs.mkdirSync(path.join(dir, 'audit'), { recursive: true });
    const companionCalls = [];
    const deps = {
        depositDir: path.join(dir, 'approval-channel', 'pendiente'),
        auditFile: path.join(dir, 'audit', 'approval-channel.jsonl'),
        rejectFile: path.join(dir, 'audit', 'approval-channel-rejects.jsonl'),
        rateFile: path.join(dir, 'approval-channel', '.reject-rate.json'),
        signer: actionToken.createTokenSigner({
            secret: SECRET,
            nonceFile: path.join(dir, 'audit', 'canal-tokens.jsonl'),
        }),
        auditCompanion: (record) => {
            companionCalls.push(record);
            return auditLog.appendChained({
                file: path.join(dir, 'audit', 'operator-gate-signatures.jsonl'),
                entry: { ...record, ts: new Date().toISOString() },
            });
        },
        env: { TELEGRAM_LEO_OPERATOR_CHAT_ID: OPERATOR },
        config: {
            operator_signoff: { enabled: true, gate_mode: 'enforce' },
            operator_signature: { enabled: true, gate_mode: 'enforce' },
            cua: { operator_chat_ids: [] },
        },
        writerPipelineDir: dir,
        ...(over.deps || {}),
    };
    return {
        dir,
        deps,
        companionCalls,
        chainFile: path.join(dir, 'audit', gate2.SIGNATURE_AUDIT_FILE),
        cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} },
    };
}

/** Entradas crudas del audit hash-chain de GATE 2 (o `[]` si no existe). */
function chainEntries(env) {
    if (!fs.existsSync(env.chainFile)) return [];
    return auditLog.readAll(env.chainFile);
}

function signatures(env) {
    return chainEntries(env).filter(r => r.kind === gate2.KIND_SIGNATURE);
}

function issuedNonces(env) {
    return chainEntries(env).filter(r => r.kind === gate2.KIND_NONCE);
}

/** Pide firma de GATE 2. Devuelve el resultado completo de `requestSignature`. */
function request(env, over = {}) {
    const res = channel.requestSignature({
        gate: 'aceptacion', issue: 6206, commit: COMMIT_A, ...over,
    }, env.deps);
    assert.equal(res.ok, true, `requestSignature fallo: ${res.reason}`);
    return res;
}

/**
 * Firma devolviendo EXACTAMENTE lo que el kernel entregó en `requestSignature`.
 * Esto es lo que hace un adaptador (#6207/#6208): transporta y devuelve, no
 * emite nada.
 */
function submit(env, req, over = {}) {
    return channel.submitSignature({
        gate: 'aceptacion',
        issue: 6206,
        token: req.request.token,
        nonce: req.request.nonce,
        verdict: 'signed',
        signedBy: OPERATOR,
        commit: COMMIT_A,
        ...over,
    }, env.deps);
}

// -----------------------------------------------------------------------------
// E2E · el gate `aceptacion` es operable desde el kernel
// -----------------------------------------------------------------------------

test('E2E: requestSignature entrega el nonce del gate y submitSignature firma con eso', () => {
    const env = mkEnv();
    try {
        const req = request(env);

        // El kernel emitió el nonce PROPIO del gate. Antes de este fix esta
        // propiedad no existía y el flujo entero era inoperable.
        assert.equal(typeof req.request.nonce, 'string', 'requestSignature debe entregar el nonce del gate');
        assert.match(req.request.nonce, channel.GATE_NONCE_RE);

        const res = submit(env, req);
        assert.equal(res.ok, true, `submitSignature fallo: ${res.reason}`);
        assert.equal(res.gate, 'aceptacion');
        assert.equal(res.verdict, 'signed');
        assert.equal(res.entry.kind, gate2.KIND_SIGNATURE);
        assert.equal(res.entry.signed_commit, COMMIT_A);
        assert.equal(res.entry.signed_by, OPERATOR);

        // La firma quedó en el audit hash-chain del gate y la cadena verifica.
        const sigs = signatures(env);
        assert.equal(sigs.length, 1);
        assert.equal(sigs[0].nonce, req.request.nonce);
        assert.equal(auditLog.verifyChain(env.chainFile).ok, true);
    } finally { env.cleanup(); }
});

test('E2E: la firma emitida por el canal es la que lee el evaluador de GATE 2', () => {
    const env = mkEnv();
    try {
        const req = request(env);
        assert.equal(submit(env, req).ok, true);

        // `readSignatureState` es lo que usa `evalSignature` (CA-3/CA-4): la
        // autoridad ve la firma que escribió el canal.
        const state = gate2.readSignatureState(6206, env.dir);
        assert.equal(state.chainOk, true);
        assert.equal(state.latest.verdict, 'signed');
        assert.equal(state.latest.signed_commit, COMMIT_A);
    } finally { env.cleanup(); }
});

test('CA-A1: el UNICO writer del `nonce_issued` es el kernel, no el adaptador', () => {
    const env = mkEnv();
    try {
        assert.deepEqual(chainEntries(env), [], 'la cadena arranca vacia');

        const req = request(env);

        // Un solo `nonce_issued`, escrito por `requestSignature`. Este test no
        // invoca `operator-signature.issueNonce` en ningún momento: si el kernel
        // no lo emitiera, no habría nada acá.
        const issued = issuedNonces(env);
        assert.equal(issued.length, 1);
        assert.equal(issued[0].nonce, req.request.nonce);
        assert.equal(issued[0].sha, COMMIT_A);
        assert.equal(Number(issued[0].issue_id), 6206);
    } finally { env.cleanup(); }
});

test('el gate `definicion` NO emite nonce propio (su anti-replay es el del token)', () => {
    const env = mkEnv();
    try {
        const res = channel.requestSignature({
            gate: 'definicion', issue: 6206, body: '## Criterios\n\n- [ ] CA-1\n',
        }, env.deps);
        assert.equal(res.ok, true);
        assert.equal('nonce' in res.request, false, 'GATE 1 no tiene nonce propio');
        assert.deepEqual(chainEntries(env), [], 'GATE 1 no toca la cadena de GATE 2');
    } finally { env.cleanup(); }
});

// -----------------------------------------------------------------------------
// A01/A02 · el nonce es capability bearer — no se persiste donde se lee
// -----------------------------------------------------------------------------

test('A01/A02: el nonce del gate NO va al deposito ni al audit del canal', () => {
    const env = mkEnv();
    try {
        const req = request(env);
        const nonce = req.request.nonce;

        const raw = fs.readFileSync(req.path, 'utf8');
        const deposited = JSON.parse(raw);
        assert.equal('nonce' in deposited, false, 'el deposito lo leen Telegram y el dashboard');
        assert.equal('token' in deposited, false);
        assert.equal(raw.includes(nonce), false);

        const canalAudit = fs.readFileSync(env.deps.auditFile, 'utf8');
        assert.equal(canalAudit.includes(nonce), false, 'el nonce no se audita en el canal');
        assert.equal(canalAudit.includes(req.request.token), false);
    } finally { env.cleanup(); }
});

// -----------------------------------------------------------------------------
// CA-A2.b · nada que quede en el acta sale del payload
// -----------------------------------------------------------------------------

test('CA-A2.b: `p.evidenceHash` inyectado por el cliente se IGNORA', () => {
    const env = mkEnv();
    try {
        const req = request(env, { evidence: [{ kind: 'pr', ref: 'https://github.com/x/y/pull/1' }] });
        const inyectado = `sha256:${'f'.repeat(64)}`;

        const res = submit(env, req, { evidenceHash: inyectado });
        assert.equal(res.ok, true, res.reason);

        // El acta hash-chained persiste el digest SERVER-SIDE, no el del cliente.
        assert.notEqual(res.entry.evidence_hash, inyectado);
        assert.equal(res.entry.evidence_hash, channel.computeChannelEvidenceHash(req.request));

        // Y es exactamente el que el kernel dejó en el `nonce_issued`.
        assert.equal(res.entry.evidence_hash, issuedNonces(env)[0].evidence_hash);
        assert.equal(fs.readFileSync(env.chainFile, 'utf8').includes(inyectado), false);
    } finally { env.cleanup(); }
});

test('CA-A2.b: el `evidence_hash` cambia si cambia la evidencia PRESENTADA', () => {
    const envA = mkEnv();
    const envB = mkEnv();
    try {
        const a = request(envA, { evidence: [{ kind: 'pr', ref: 'pr-1' }] });
        const b = request(envB, { evidence: [{ kind: 'pr', ref: 'pr-2' }] });
        assert.notEqual(
            channel.computeChannelEvidenceHash(a.request),
            channel.computeChannelEvidenceHash(b.request),
        );
    } finally { envA.cleanup(); envB.cleanup(); }
});

test('CA-A2.b: `p.gateMode` inyectado se ignora — el acta lleva el modo REAL de config', () => {
    const env = mkEnv();
    try {
        const req = request(env);
        const res = submit(env, req, { gateMode: 'dry-run' });
        assert.equal(res.ok, true, res.reason);
        assert.equal(res.entry.gate_mode, 'enforce');
    } finally { env.cleanup(); }
});

test('CA-A2.b: `p.evidenceHash` ya no se lee en ningun punto del modulo', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'approval-channel.js'), 'utf8');
    assert.equal(/\bp\.evidenceHash\b/.test(src), false, 'el acta no puede tomar evidencia del payload crudo');
});

// -----------------------------------------------------------------------------
// CA-5 · el nonce del gate, fail-closed en todas sus formas de fallo
// -----------------------------------------------------------------------------

test('CA-5: sin nonce hay rechazo SIN acta y SIN companion pre-transicion', () => {
    const env = mkEnv();
    try {
        const req = request(env);
        const res = submit(env, req, { nonce: undefined });
        assert.equal(res.ok, false);
        assert.match(res.reason, /nonce del gate ausente o con forma/);
        assert.deepEqual(signatures(env), [], 'no se escribio acta');
        assert.deepEqual(env.companionCalls, [], 'no se dejo constancia de una firma que no ocurrio');
    } finally { env.cleanup(); }
});

test('CA-5: nonce con forma rotada se rechaza ANTES de leer la cadena', () => {
    const env = mkEnv({ deps: { rejectRate: { windowMs: 60000, maxPerWindow: 100, maxGlobalPerWindow: 500 } } });
    try {
        const malos = ['', 'abc', 'x'.repeat(32), 'A1B2C3D4E5F60718293A4B5C6D7E8F90', 'a'.repeat(33), 42, null, {}];
        for (const malo of malos) {
            const req = request(env);
            const res = submit(env, req, { nonce: malo });
            assert.equal(res.ok, false, `nonce ${JSON.stringify(malo)} no deberia pasar`);
            assert.match(res.reason, /forma inv/);
        }
        assert.deepEqual(signatures(env), []);
    } finally { env.cleanup(); }
});

test('CA-5: nonce emitido para OTRO issue se rechaza', () => {
    const env = mkEnv();
    try {
        const ajeno = channel.requestSignature({ gate: 'aceptacion', issue: 7777, commit: COMMIT_A }, env.deps);
        assert.equal(ajeno.ok, true);
        const propio = request(env);

        const res = submit(env, propio, { nonce: ajeno.request.nonce });
        assert.equal(res.ok, false);
        assert.match(res.reason, /no fue emitido por el canal para este artefacto/);
        assert.deepEqual(signatures(env), []);
    } finally { env.cleanup(); }
});

test('CA-5: nonce emitido para OTRO commit se rechaza (anti-TOCTOU)', () => {
    const env = mkEnv();
    try {
        request(env, { commit: COMMIT_A });
        const reqA = request(env, { commit: COMMIT_A });
        const reqB = request(env, { commit: COMMIT_B });

        const res = submit(env, reqB, { commit: COMMIT_B, nonce: reqA.request.nonce });
        assert.equal(res.ok, false);
        assert.match(res.reason, /no fue emitido por el canal para este artefacto/);
        assert.deepEqual(signatures(env), []);
    } finally { env.cleanup(); }
});

test('CA-5: replay, el mismo nonce no firma dos veces', () => {
    const env = mkEnv();
    try {
        const req1 = request(env);
        assert.equal(submit(env, req1).ok, true);

        // Token nuevo (el anterior se quemó) + el nonce YA consumido.
        const req2 = request(env);
        const res = submit(env, req2, { nonce: req1.request.nonce });
        assert.equal(res.ok, false);
        assert.match(res.reason, /consumido|replay/);
        assert.equal(signatures(env).length, 1, 'sigue habiendo una sola firma');
    } finally { env.cleanup(); }
});

test('CA-5: nonce expirado se rechaza (TTL del gate, resuelto server-side)', () => {
    const env = mkEnv({ deps: {
        config: {
            operator_signoff: { enabled: true, gate_mode: 'enforce' },
            operator_signature: { enabled: true, gate_mode: 'enforce', nonce_ttl_seconds: 1 },
            cua: { operator_chat_ids: [] },
        },
    } });
    try {
        const req = request(env);
        assert.equal(issuedNonces(env)[0].ttl_ms, 1000, 'el TTL sale de config, server-side');

        // Reloj del kernel adelantado más allá del TTL.
        const res = channel.submitSignature({
            gate: 'aceptacion', issue: 6206, token: req.request.token, nonce: req.request.nonce,
            verdict: 'signed', signedBy: OPERATOR, commit: COMMIT_A,
        }, { ...env.deps, now: () => Date.now() + 10000 });
        assert.equal(res.ok, false);
        assert.match(res.reason, /expirado/);
        assert.deepEqual(signatures(env), []);
    } finally { env.cleanup(); }
});

// -----------------------------------------------------------------------------
// Resto de la rama de despacho
// -----------------------------------------------------------------------------

test('verdict `rejected` es despachable en aceptacion y queda en el acta', () => {
    const env = mkEnv();
    try {
        const res = submit(env, request(env), { verdict: 'rejected' });
        assert.equal(res.ok, true, res.reason);
        assert.equal(res.entry.verdict, 'rejected');
        assert.equal(signatures(env)[0].verdict, 'rejected');
    } finally { env.cleanup(); }
});

test('`re-definition` no es un verdict de aceptacion: rechazo sin acta', () => {
    const env = mkEnv();
    try {
        const res = submit(env, request(env), { verdict: 're-definition' });
        assert.equal(res.ok, false);
        assert.match(res.reason, /verdict inv/);
        assert.deepEqual(signatures(env), []);
    } finally { env.cleanup(); }
});

test('CA-A5.b: firmante no autorizado en aceptacion, el gate rechaza sin acta', () => {
    const env = mkEnv();
    try {
        const res = submit(env, request(env), { signedBy: '99999999' });
        assert.equal(res.ok, false);
        assert.match(res.reason, /el gate rechaz/);
        assert.match(res.reason, /no autorizado/);
        assert.deepEqual(signatures(env), []);
    } finally { env.cleanup(); }
});

test('CA-A5.b: el respaldo de `cua.operator_chat_ids` SI firma la aceptacion (D-4)', () => {
    const env = mkEnv({ deps: {
        env: {},
        config: {
            operator_signoff: { enabled: true, gate_mode: 'enforce' },
            operator_signature: { enabled: true, gate_mode: 'enforce' },
            cua: { operator_chat_ids: ['55550000'] },
        },
    } });
    try {
        const res = submit(env, request(env), { signedBy: '55550000' });
        assert.equal(res.ok, true, res.reason);
        assert.equal(signatures(env)[0].signed_by, '55550000');
    } finally { env.cleanup(); }
});

test('CA-A5/D-2: la firma de aceptacion alimenta el companion de audit (pre y post)', () => {
    const env = mkEnv();
    try {
        assert.equal(submit(env, request(env)).ok, true);
        assert.equal(env.companionCalls.length, 2, 'pre-transicion + post-transicion');
        assert.equal(env.companionCalls[0].gate, null);
        assert.equal(env.companionCalls[0].result, 'accepted-before-transition');
        assert.equal(env.companionCalls[1].gate, 'aceptacion');
        assert.equal(env.companionCalls[1].result, 'signed');
        assert.equal(env.companionCalls[1].action, 'approve');

        // Legible por `operator-wait.js:167` (JSONL hash-chained verificable).
        const f = path.join(env.dir, 'audit', 'operator-gate-signatures.jsonl');
        assert.equal(auditLog.verifyChain(f).ok, true);
    } finally { env.cleanup(); }
});

test('CA-A7: el artefacto cambio tras firmar, se pide firma nueva', () => {
    const env = mkEnv();
    try {
        const req = request(env, { commit: COMMIT_A });
        const res = submit(env, req, { commit: COMMIT_B });
        assert.equal(res.ok, false);
        assert.match(res.reason, /lo firmado cambi/);
        assert.deepEqual(signatures(env), []);
    } finally { env.cleanup(); }
});

test('CA-A4: firmar limpia el pendiente del deposito (indice, no autoridad)', () => {
    const env = mkEnv();
    try {
        const req = request(env);
        assert.equal(fs.existsSync(req.path), true);
        assert.equal(submit(env, req).ok, true);
        assert.equal(fs.existsSync(req.path), false);
    } finally { env.cleanup(); }
});

test('un commit invalido no emite nonce ni deja rastro en la cadena del gate', () => {
    const env = mkEnv();
    try {
        const res = channel.requestSignature({ gate: 'aceptacion', issue: 6206, commit: 'no-es-un-sha' }, env.deps);
        assert.equal(res.ok, false);
        assert.match(res.reason, /commit inv/);
        assert.deepEqual(chainEntries(env), [], 'un pedido que no se emite no quema nonce');
    } finally { env.cleanup(); }
});

test('el registry declara `prepare` y `writerExtras` en AMBOS gates', () => {
    for (const gate of Object.keys(channel.GATES)) {
        assert.equal(typeof channel.GATES[gate].prepare, 'function', `${gate}.prepare`);
        assert.equal(typeof channel.GATES[gate].writerExtras, 'function', `${gate}.writerExtras`);
    }
    assert.deepEqual(channel.GATES.definicion.writerExtras(), { ok: true, extras: {} });
});
