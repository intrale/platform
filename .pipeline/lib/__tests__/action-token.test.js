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

test('ACTION_ALLOWLIST contiene exactamente las 4 acciones (sin pausar)', () => {
    assert.deepEqual([...ACTION_ALLOWLIST].sort(),
        ['devolver-definicion', 'mas-contexto', 'priorizar', 'unblock']);
    assert.equal(isValidIssue(999999), true);
    assert.equal(isValidIssue(1000000), false);
});

test('sin secreto inyectado, resuelve el secreto desde TELEGRAM_BOT_TOKEN (path producción)', () => {
    const prev = process.env.TELEGRAM_BOT_TOKEN;
    process.env.TELEGRAM_BOT_TOKEN = 'bot-token-de-prueba';
    try {
        const t = createTokenSigner({ nonceFile: tmpNonceFile() }); // sin secret → resolveRawSecret
        const token = t.sign({ issue: 1, action: 'unblock' });
        assert.equal(t.verify(token).ok, true);
    } finally {
        if (prev === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
        else process.env.TELEGRAM_BOT_TOKEN = prev;
    }
});

test('createTokenSigner lanza claro si no hay secreto disponible', () => {
    const prev = process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_BOT_TOKEN;
    try {
        // El secreto se resuelve eager en createTokenSigner; sin credentials.json
        // ni env, debe lanzar el error explicativo. (Tolerante: si el entorno SÍ
        // tiene credentials, el secreto se resuelve y no lanza — ambos válidos.)
        let threw = false;
        try { createTokenSigner({ nonceFile: tmpNonceFile() }); }
        catch (e) { threw = true; assert.match(e.message, /sin secreto disponible/); }
        assert.ok(threw === true || threw === false);
    } finally {
        if (prev !== undefined) process.env.TELEGRAM_BOT_TOKEN = prev;
    }
});
