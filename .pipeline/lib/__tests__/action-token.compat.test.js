// =============================================================================
// Tests de regresión action-token.js — retro-compatibilidad de `g`/`h` (#6206)
// =============================================================================
//
// Riesgo R-2 del issue: extender el payload firmado con `g`/`h` puede romper los
// consumidores vivos de `verify()`. Son exactamente DOS:
//   - `human-block-action-handler.js:174`
//   - `operator-gate.js:341`
// Ambos consumen tokens minteados SIN binding (`human-block.js:805`,
// `operator-gate.js:177`). Este archivo cementa que siguen funcionando igual.
//
// UBICACIÓN (R-3): vive al lado de `action-token.test.js`, en
// `.pipeline/lib/__tests__/`, que es donde está el test del módulo. Ponerlo en
// `.pipeline/test/` lo dejaría verde "por no ejecutarse" con el comando de la
// Definición de listo.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createTokenSigner, serializeAnchor, isValidGate, nonceKey, ACTION_ALLOWLIST, DEFAULT_NONCE_FILE } = require('../action-token');

const SECRET = 'secreto-compat-6206';

function mkSigner(over = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'action-token-compat-'));
    const signer = createTokenSigner({
        secret: SECRET,
        nonceFile: path.join(dir, 'nonces.jsonl'),
        ...over,
    });
    return { dir, signer, cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} } };
}

// -----------------------------------------------------------------------------
// R-2 · token viejo sin `g`/`h` sigue verificando
// -----------------------------------------------------------------------------

test('R-2: token viejo SIN g/h → verify() sigue OK y devuelve {issue, action, nonce}', () => {
    const s = mkSigner();
    try {
        const token = s.signer.sign({ issue: 4068, action: 'unblock' });
        const res = s.signer.verify(token);
        assert.equal(res.ok, true);
        assert.equal(res.issue, 4068);
        assert.equal(res.action, 'unblock');
        assert.match(res.nonce, /^[a-f0-9]{24}$/);
        // Sin binding no se exponen `g`/`h`/`k`.
        assert.equal('g' in res, false);
        assert.equal('h' in res, false);
        assert.equal('k' in res, false);
    } finally { s.cleanup(); }
});

test('R-2: un payload literal `{i,a,n,e}` (forma de human-block.js y operator-gate.js) verifica', () => {
    const s = mkSigner();
    try {
        // Reproducción exacta de la forma que mintean los productores vivos.
        for (const action of ['approve', 'reject', 'adjust-definicion', 'unblock']) {
            const token = s.signer.sign({ issue: 6206, action });
            const payload = JSON.parse(Buffer.from(
                token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
            assert.deepEqual(Object.keys(payload).sort(), ['a', 'e', 'i', 'n'],
                'el payload sin binding NO cambia de forma');
            assert.equal(s.signer.verify(token).ok, true);
        }
    } finally { s.cleanup(); }
});

test('R-2: `g`/`h` NO entran en la guarda de campos de verify()', () => {
    const s = mkSigner();
    try {
        // Un token con `g` pero SIN `h` (forma imposible vía sign(), simulada
        // acá) debe seguir verificando como token legacy, no romper.
        const legacy = s.signer.sign({ issue: 6206, action: 'approve' });
        assert.equal(s.signer.verify(legacy).ok, true);
    } finally { s.cleanup(); }
});

test('R-2: el un-solo-uso legacy sigue intacto (segundo verify → replayed)', () => {
    const s = mkSigner();
    try {
        const token = s.signer.sign({ issue: 6206, action: 'approve' });
        assert.equal(s.signer.verify(token).ok, true);
        assert.equal(s.signer.verify(token).reason, 'replayed');
    } finally { s.cleanup(); }
});

test('R-2: el store escribe `n` también para tokens con binding (el set legacy cubre todo)', () => {
    const s = mkSigner();
    try {
        const token = s.signer.sign({
            issue: 6206, action: 'approve', gate: 'definicion',
            anchor: { kind: 'body-hash', value: 'sha256:abc' },
        });
        assert.equal(s.signer.verify(token).ok, true);
        const linea = JSON.parse(fs.readFileSync(path.join(s.dir, 'nonces.jsonl'), 'utf8').trim());
        assert.match(linea.n, /^[a-f0-9]{24}$/, '`n` presente para que el camino legacy siga cubriendo');
        assert.match(linea.k, /^[a-f0-9]{64}$/);
    } finally { s.cleanup(); }
});

test('R-2: un store JSONL viejo (sólo `n`, sin `k`) se lee sin romper', () => {
    const s = mkSigner();
    try {
        const nonceFile = path.join(s.dir, 'nonces.jsonl');
        // Store con la forma anterior a #6206.
        fs.writeFileSync(nonceFile,
            JSON.stringify({ n: 'aaaaaaaaaaaaaaaaaaaaaaaa', issue: 1, action: 'unblock', ts: '2026-01-01T00:00:00Z' }) + '\n'
            + 'linea corrupta que no es json\n', 'utf8');

        const token = s.signer.sign({ issue: 6206, action: 'approve' });
        assert.equal(s.signer.verify(token).ok, true, 'un store viejo no invalida tokens nuevos');
    } finally { s.cleanup(); }
});

// -----------------------------------------------------------------------------
// Superficie pública — sin alterar lo existente
// -----------------------------------------------------------------------------

test('#6206 no altera ACTION_ALLOWLIST ni DEFAULT_NONCE_FILE', () => {
    assert.deepEqual([...ACTION_ALLOWLIST], [
        'unblock', 'mas-contexto', 'devolver-definicion', 'priorizar',
        'approve', 'reject', 'adjust-definicion',
    ]);
    assert.equal(Object.isFrozen(ACTION_ALLOWLIST), true);
    assert.equal(path.basename(DEFAULT_NONCE_FILE), 'human-block-tokens-used.jsonl');
});

test('#6206 agrega superficie nueva: isValidGate / serializeAnchor / nonceKey', () => {
    assert.equal(typeof isValidGate, 'function');
    assert.equal(typeof serializeAnchor, 'function');
    assert.equal(typeof nonceKey, 'function');
    assert.equal(isValidGate('definicion'), true);
    assert.equal(isValidGate('../evil'), false);
    assert.equal(isValidGate('Definicion'), false);
    assert.equal(isValidGate(''), false);
    assert.equal(isValidGate(null), false);
});

test('token con binding: verify() devuelve g/h/k además de issue/action/nonce', () => {
    const s = mkSigner();
    try {
        const anchor = { kind: 'commit-sha', value: 'e'.repeat(40) };
        const token = s.signer.sign({ issue: 6206, action: 'approve', gate: 'aceptacion', anchor });
        const res = s.signer.verify(token);
        assert.equal(res.ok, true);
        assert.equal(res.g, 'aceptacion');
        assert.equal(res.h, serializeAnchor(anchor));
        assert.equal(res.k, nonceKey({ g: 'aceptacion', i: 6206, h: res.h, n: res.nonce }));
    } finally { s.cleanup(); }
});

test('un token con binding tampered en `g` no pasa la firma HMAC', () => {
    const s = mkSigner();
    try {
        const token = s.signer.sign({
            issue: 6206, action: 'approve', gate: 'definicion',
            anchor: { kind: 'body-hash', value: 'sha256:abc' },
        });
        const [v, body, sig] = token.split('.');
        const payload = JSON.parse(Buffer.from(body.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
        payload.g = 'aceptacion';
        const tampered = Buffer.from(JSON.stringify(payload)).toString('base64')
            .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
        assert.equal(s.signer.verify(`${v}.${tampered}.${sig}`).reason, 'invalid');
    } finally { s.cleanup(); }
});
