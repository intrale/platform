// Tests de .pipeline/lib/action-token.js (issue #4068)
// Cubren las 4 ramas de verify(): firma OK, tampered, expirado, replay (nonce
// un-solo-uso). Secreto y store de nonces inyectados → tests herméticos.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createTokenSigner, ACTION_ALLOWLIST, isValidIssue } = require('../action-token');

function tmpNonceFile() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'actoken-'));
    return path.join(dir, 'used.jsonl');
}

const SECRET = 'test-secret-no-real';

test('verify acepta un token recién firmado y devuelve issue+action', () => {
    const t = createTokenSigner({ secret: SECRET, nonceFile: tmpNonceFile() });
    const token = t.sign({ issue: 4068, action: 'unblock' });
    const r = t.verify(token);
    assert.equal(r.ok, true);
    assert.equal(r.issue, 4068);
    assert.equal(r.action, 'unblock');
});

test('verify rechaza un token tampered (firma inválida)', () => {
    const t = createTokenSigner({ secret: SECRET, nonceFile: tmpNonceFile() });
    const token = t.sign({ issue: 10, action: 'priorizar' });
    // Mutar el último char de la firma.
    const tampered = token.slice(0, -1) + (token.slice(-1) === 'A' ? 'B' : 'A');
    const r = t.verify(tampered);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'invalid');
});

test('verify rechaza un token firmado con OTRO secreto (cross-secret)', () => {
    const file = tmpNonceFile();
    const signer = createTokenSigner({ secret: 'secreto-A', nonceFile: file });
    const verifier = createTokenSigner({ secret: 'secreto-B', nonceFile: file });
    const token = signer.sign({ issue: 5, action: 'mas-contexto' });
    assert.equal(verifier.verify(token).reason, 'invalid');
});

test('verify rechaza un token expirado', () => {
    let clock = 1_000_000;
    const t = createTokenSigner({ secret: SECRET, nonceFile: tmpNonceFile(), ttlMs: 1000, now: () => clock });
    const token = t.sign({ issue: 7, action: 'devolver-definicion' });
    clock += 5000; // avanzar más allá del ttl
    const r = t.verify(token);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'expired');
});

test('verify es un-solo-uso: el segundo verify del mismo token → replayed', () => {
    const t = createTokenSigner({ secret: SECRET, nonceFile: tmpNonceFile() });
    const token = t.sign({ issue: 99, action: 'unblock' });
    assert.equal(t.verify(token).ok, true);
    const r2 = t.verify(token);
    assert.equal(r2.ok, false);
    assert.equal(r2.reason, 'replayed');
});

test('el nonce consumido persiste entre instancias (mismo store)', () => {
    const file = tmpNonceFile();
    const a = createTokenSigner({ secret: SECRET, nonceFile: file });
    const token = a.sign({ issue: 1, action: 'unblock' });
    assert.equal(a.verify(token).ok, true);
    // Otra instancia con el mismo store ve el nonce gastado.
    const b = createTokenSigner({ secret: SECRET, nonceFile: file });
    assert.equal(b.verify(token).reason, 'replayed');
});

test('verify rechaza basura no-token', () => {
    const t = createTokenSigner({ secret: SECRET, nonceFile: tmpNonceFile() });
    for (const bad of ['', 'x', 'v1.solo-dos', 'v2.body.sig', null, undefined, 123]) {
        assert.equal(t.verify(bad).ok, false, `debería rechazar: ${bad}`);
    }
});

test('sign rechaza action fuera de allowlist e issue inválido', () => {
    const t = createTokenSigner({ secret: SECRET, nonceFile: tmpNonceFile() });
    assert.throws(() => t.sign({ issue: 1, action: 'pausar' }), /action inválida/);
    assert.throws(() => t.sign({ issue: 0, action: 'unblock' }), /issue inválido/);
    assert.throws(() => t.sign({ issue: 'x', action: 'unblock' }), /issue inválido/);
});

test('ACTION_ALLOWLIST contiene needs-human + firma #4579 + operacional #5458', () => {
    assert.deepEqual([...ACTION_ALLOWLIST].sort(),
        ['adjust-definicion', 'approve', 'devolver-definicion', 'mas-contexto',
         'priorizar', 'reject', 'unblock', 'vault-cut-fallback']);
    assert.equal(isValidIssue(999999), true);
    assert.equal(isValidIssue(1000000), false);
});

// --- #4579: acciones de firma del operador (approve/reject/adjust-definicion) --

test('sign/verify aceptan las nuevas acciones de firma y devuelven el nonce', () => {
    for (const action of ['approve', 'reject', 'adjust-definicion']) {
        const t = createTokenSigner({ secret: SECRET, nonceFile: tmpNonceFile() });
        const token = t.sign({ issue: 4579, action });
        const r = t.verify(token);
        assert.equal(r.ok, true, `debería aceptar ${action}`);
        assert.equal(r.action, action);
        assert.equal(r.issue, 4579);
        // El nonce consumido se devuelve para el audit de #4579 (no el token completo).
        assert.ok(typeof r.nonce === 'string' && r.nonce.length > 0);
    }
});

test('#4579: doble-tap de una firma approve → replayed; token vencido → expired', () => {
    let clock = 2_000_000;
    const t = createTokenSigner({ secret: SECRET, nonceFile: tmpNonceFile(), ttlMs: 1000, now: () => clock });
    // doble-tap
    const token = t.sign({ issue: 4579, action: 'approve' });
    assert.equal(t.verify(token).ok, true);
    assert.equal(t.verify(token).reason, 'replayed');
    // expirado
    const token2 = t.sign({ issue: 4579, action: 'reject' });
    clock += 5000;
    assert.equal(t.verify(token2).reason, 'expired');
});

test('sin secreto inyectado, usa vault aunque TELEGRAM_BOT_TOKEN sea hostil', { concurrency: false }, () => {
    const credentials = require('../credentials');
    const original = credentials.resolveVaultOnly;
    const prev = process.env.TELEGRAM_BOT_TOKEN;
    process.env.TELEGRAM_BOT_TOKEN = 'HOSTILE-ENV-NOT-A-SECRET';
    credentials.resolveVaultOnly = (key) => {
        assert.equal(key, 'telegram.bot_token');
        return 'VAULT-ONLY-TEST-VALUE';
    };
    try {
        const t = createTokenSigner({ nonceFile: tmpNonceFile() });
        const token = t.sign({ issue: 1, action: 'unblock' });
        assert.equal(t.verify(token).ok, true);
        const hostile = createTokenSigner({ secret: process.env.TELEGRAM_BOT_TOKEN, nonceFile: tmpNonceFile() });
        assert.equal(hostile.verify(token).reason, 'invalid');
    } finally {
        credentials.resolveVaultOnly = original;
        if (prev === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
        else process.env.TELEGRAM_BOT_TOKEN = prev;
    }
});

test('vault ausente falla cerrado aunque ambiente tenga valor', { concurrency: false }, () => {
    const credentials = require('../credentials');
    const original = credentials.resolveVaultOnly;
    const prev = process.env.TELEGRAM_BOT_TOKEN;
    process.env.TELEGRAM_BOT_TOKEN = 'HOSTILE-FALLBACK-NOT-A-SECRET';
    credentials.resolveVaultOnly = () => {
        const error = new Error('credentials: VAULT_DISABLED para telegram.bot_token');
        error.code = 'VAULT_DISABLED';
        throw error;
    };
    try {
        assert.throws(() => createTokenSigner({ nonceFile: tmpNonceFile() }), (error) => {
            assert.equal(error.code, 'VAULT_DISABLED');
            assert.match(error.message, /telegram\.bot_token/);
            assert.doesNotMatch(error.message, /HOSTILE-FALLBACK/);
            return true;
        });
    } finally {
        credentials.resolveVaultOnly = original;
        if (prev === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
        else process.env.TELEGRAM_BOT_TOKEN = prev;
    }
});
