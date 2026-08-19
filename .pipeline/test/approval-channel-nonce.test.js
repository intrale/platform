// =============================================================================
// Tests approval-channel — nonce namespaced y binding (gate, issue, anchor)
// (#6206 · CA-A3 / REQ-SEC-1 / REQ-SEC-2 / R-1)
// =============================================================================
//
// El riesgo que cubre este archivo (R-1, crítico, OWASP A01/A08): hoy hay dos
// productores minteando tokens con la MISMA clave derivada y la forma
// `{i,a,n,e}` — `human-block.js:805` y `operator-gate.js:177`. Si
// `submitSignature()` aceptara un token sin `g`, **el botón de un gate firmaría
// otro**. Sin el test negativo de abajo, CA-A3 se puede dar por cumplido con un
// canal vulnerable.
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
const signoffGate = require('../lib/operator-signoff-gate');

const OPERATOR = '12345678';
const SECRET = 'secreto-de-test-6206-nonce';
const BODY = '## Criterios\n\n- [ ] CA-1\n';

function mkEnv(signerOpts = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'approval-channel-nonce-'));
    fs.mkdirSync(path.join(dir, 'audit'), { recursive: true });
    const nonceFile = path.join(dir, 'audit', 'canal-tokens.jsonl');
    const signer = actionToken.createTokenSigner({ secret: SECRET, nonceFile, ...signerOpts });
    return {
        dir,
        nonceFile,
        signer,
        deps: {
            depositDir: path.join(dir, 'approval-channel', 'pendiente'),
            auditFile: path.join(dir, 'audit', 'approval-channel.jsonl'),
            rejectFile: path.join(dir, 'audit', 'approval-channel-rejects.jsonl'),
            rateFile: path.join(dir, 'approval-channel', '.reject-rate.json'),
            signer,
            auditCompanion: (record) => auditLog.appendChained({
                file: path.join(dir, 'audit', 'operator-gate-signatures.jsonl'),
                entry: { ...record, ts: new Date().toISOString() },
            }),
            // #6206 — allowlist resuelta SERVER-SIDE desde el entorno.
            env: { TELEGRAM_LEO_OPERATOR_CHAT_ID: OPERATOR },
            writerPipelineDir: dir,
        },
        cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} },
    };
}

function submit(env, token, over = {}) {
    return channel.submitSignature({
        gate: 'definicion',
        issue: 6206,
        token,
        verdict: 'signed',
        signedBy: OPERATOR,
        body: BODY,
        gateMode: 'enforce',
        ...over,
    }, env.deps);
}

// -----------------------------------------------------------------------------
// REQ-SEC-1 · token legacy (sin binding) rechazado
// -----------------------------------------------------------------------------

test('REQ-SEC-1/R-1: un token legítimo del camino de botones NO puede firmar por el canal', () => {
    const env = mkEnv();
    try {
        // Token EXACTAMENTE como lo mintean `operator-gate.register()` y
        // `human-block.js:805`: `{i,a,n,e}`, sin `g`, sin `h`.
        const legacy = env.signer.sign({ issue: 6206, action: 'approve' });

        // El HMAC valida y el firmante está autorizado, y aun así se rechaza.
        const res = submit(env, legacy);
        assert.equal(res.ok, false);
        assert.match(res.reason, /sin binding|g\/h/i);

        // Y no se firmó nada.
        assert.equal(signoffGate.readSignatureState(6206, env.dir).latest, null);
    } finally { env.cleanup(); }
});

test('REQ-SEC-1: el rechazo por falta de binding tiene la MISMA severidad que firma inválida', () => {
    const env = mkEnv();
    try {
        const sinBinding = submit(env, env.signer.sign({ issue: 6206, action: 'approve' }));
        const basura = submit(env, 'v1.no-soy-un-token.firma');
        assert.equal(sinBinding.ok, false);
        assert.equal(basura.ok, false);
        // Ambos quedan registrados como intento rechazado.
        assert.equal(auditLog.readAll(env.deps.rejectFile).length, 2);
    } finally { env.cleanup(); }
});

// -----------------------------------------------------------------------------
// REQ-SEC-1 · comparación explícita `g === gate`
// -----------------------------------------------------------------------------

test('REQ-SEC-1: `g` ≠ gate que se resuelve → rechazo por comparación explícita', () => {
    const env = mkEnv();
    try {
        // Token atado a `aceptacion`, presentado al canal como `definicion`.
        const token = env.signer.sign({
            issue: 6206,
            action: 'approve',
            gate: 'aceptacion',
            anchor: { kind: 'commit-sha', value: 'c'.repeat(40) },
        });
        const res = submit(env, token, { gate: 'definicion' });
        assert.equal(res.ok, false);
        assert.match(res.reason, /otro gate/i);
    } finally { env.cleanup(); }
});

test('REQ-SEC-1: `h` de otro ancla → rechazo aunque el gate coincida', () => {
    const env = mkEnv();
    try {
        const token = env.signer.sign({
            issue: 6206,
            action: 'approve',
            gate: 'definicion',
            anchor: { kind: 'body-hash', value: 'sha256:' + '0'.repeat(64) },
        });
        const res = submit(env, token);
        assert.equal(res.ok, false);
        assert.match(res.reason, /cambió|firma nueva/i);
    } finally { env.cleanup(); }
});

// -----------------------------------------------------------------------------
// CA-A3 / REQ-SEC-2 · replay y cross-namespace
// -----------------------------------------------------------------------------

test('CA-A3: el mismo token no firma dos veces (un solo uso)', () => {
    const env = mkEnv();
    try {
        const req = channel.requestSignature({
            gate: 'definicion', issue: 6206, body: BODY,
        }, env.deps);
        assert.equal(submit(env, req.request.token).ok, true);

        const replay = submit(env, req.request.token);
        assert.equal(replay.ok, false);
        assert.match(replay.reason, /replayed/i);
    } finally { env.cleanup(); }
});

test('REQ-SEC-2: un token consumido en un namespace NO revalida en el otro', () => {
    // Nonce fijo inyectado: dos tokens con el MISMO `n` y binding distinto. Es
    // la única forma de probar el cruce de namespaces (en producción el nonce es
    // aleatorio y la colisión no ocurre).
    const env = mkEnv({ nonceGen: () => 'deadbeefdeadbeefdeadbeef' });
    try {
        const anchorA = { kind: 'body-hash', value: signoffGate.computeCriteriaHash(BODY) };
        const anchorB = { kind: 'commit-sha', value: 'd'.repeat(40) };

        const tokenA = env.signer.sign({ issue: 6206, action: 'approve', gate: 'definicion', anchor: anchorA });
        const tokenB = env.signer.sign({ issue: 6206, action: 'approve', gate: 'aceptacion', anchor: anchorB });

        // Las claves compuestas son DISTINTAS (el namespacing existe)...
        const kA = actionToken.nonceKey({ g: 'definicion', i: 6206, h: actionToken.serializeAnchor(anchorA), n: 'deadbeefdeadbeefdeadbeef' });
        const kB = actionToken.nonceKey({ g: 'aceptacion', i: 6206, h: actionToken.serializeAnchor(anchorB), n: 'deadbeefdeadbeefdeadbeef' });
        assert.notEqual(kA, kB);

        // ...pero consumir A quema el nonce para B también: el un-solo-uso NO se
        // degrada a "un uso por store" (D-3).
        assert.equal(submit(env, tokenA).ok, true);
        const enB = env.signer.verify(tokenB);
        assert.equal(enB.ok, false);
        assert.equal(enB.reason, 'replayed');
    } finally { env.cleanup(); }
});

test('D-3: el store persiste `n` (legacy) Y `k` (compuesta) para tokens con binding', () => {
    const env = mkEnv({ nonceGen: () => 'aabbccddeeff001122334455' });
    try {
        const req = channel.requestSignature({ gate: 'definicion', issue: 6206, body: BODY }, env.deps);
        assert.equal(submit(env, req.request.token).ok, true);

        const lineas = fs.readFileSync(env.nonceFile, 'utf8').trim().split('\n').map(JSON.parse);
        assert.equal(lineas.length, 1);
        assert.equal(lineas[0].n, 'aabbccddeeff001122334455', '`n` se escribe SIEMPRE');
        assert.match(lineas[0].k, /^[a-f0-9]{64}$/, '`k` se agrega cuando hay binding');
        assert.equal(lineas[0].gate, 'definicion');
    } finally { env.cleanup(); }
});

test('D-3: la clave compuesta se DERIVA del binding firmado, no lo reemplaza', () => {
    const h = actionToken.serializeAnchor({ kind: 'body-hash', value: 'sha256:abc' });
    const base = { g: 'definicion', i: 6206, h, n: 'n1' };
    // Cambiar cualquier componente del binding cambia la clave.
    assert.notEqual(actionToken.nonceKey(base), actionToken.nonceKey({ ...base, g: 'aceptacion' }));
    assert.notEqual(actionToken.nonceKey(base), actionToken.nonceKey({ ...base, i: 6207 }));
    assert.notEqual(actionToken.nonceKey(base), actionToken.nonceKey({ ...base, h: h + 'x' }));
    assert.notEqual(actionToken.nonceKey(base), actionToken.nonceKey({ ...base, n: 'n2' }));
    // Determinística.
    assert.equal(actionToken.nonceKey(base), actionToken.nonceKey({ ...base }));
});

// -----------------------------------------------------------------------------
// A-1 · el nonce NO se reimplementa en approval-channel
// -----------------------------------------------------------------------------

test('A-1: approval-channel.js NO reimplementa el nonce — extiende action-token', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'approval-channel.js'), 'utf8');
    assert.ok(src.includes("require('./action-token')"), 'debe delegar en action-token');
    assert.equal(/randomBytes\s*\(\s*\d+\s*\)\s*\.toString\('hex'\)/.test(src), false,
        'no debe generar nonces propios');
    assert.equal(src.includes('nonces-usados') || src.includes('markNonceUsed'), false,
        'no debe llevar su propio store de nonces');
});

// -----------------------------------------------------------------------------
// Binding mal formado en `sign()` — fail-closed
// -----------------------------------------------------------------------------

test('sign() falla cerrado si se pide binding con gate o anchor inválidos', () => {
    const env = mkEnv();
    try {
        const anchor = { kind: 'body-hash', value: 'sha256:abc' };
        assert.throws(() => env.signer.sign({ issue: 6206, action: 'approve', gate: '../x', anchor }), /gate inválido/);
        assert.throws(() => env.signer.sign({ issue: 6206, action: 'approve', gate: 'definicion' }), /anchor inválida/);
        assert.throws(() => env.signer.sign({
            issue: 6206, action: 'approve', gate: 'definicion',
            anchor: { kind: 'body|hash', value: 'x' },
        }), /anchor inválida/);
    } finally { env.cleanup(); }
});

test('serializeAnchor es inyectiva y rechaza formas inválidas', () => {
    assert.equal(actionToken.serializeAnchor({ kind: 'body-hash', value: 'v' }), 'body-hash|v');
    assert.equal(actionToken.serializeAnchor('body-hash|v'), 'body-hash|v'); // idempotente
    assert.equal(actionToken.serializeAnchor(null), null);
    assert.equal(actionToken.serializeAnchor({ kind: '', value: 'v' }), null);
    assert.equal(actionToken.serializeAnchor({ kind: 'body-hash', value: '' }), null);
    assert.equal(actionToken.serializeAnchor('sin-separador'), null);
    assert.equal(actionToken.serializeAnchor('|sin-kind'), null);
});
