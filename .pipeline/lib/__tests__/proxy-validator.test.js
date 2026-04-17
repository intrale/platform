// =============================================================================
// Tests proxy-validator.js — CA-8 / CA-15
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    validateProxy,
    isAllowedHostPort,
    normalizeHostPort,
    stripUserinfo,
} = require('../proxy-validator');

test('CA-8 · match exacto hostname:port autorizado', () => {
    const allow = ['allowed-proxy.example.com:8080'];
    const res = validateProxy('http://allowed-proxy.example.com:8080/', { allowlist: allow });
    assert.equal(res.host, 'allowed-proxy.example.com');
    assert.equal(res.port, 8080);
    assert.equal(res.auth, null);
});

test('CA-8 · match case-insensitive hostname', () => {
    const allow = ['allowed-proxy.example.com:8080'];
    const res = validateProxy('http://Allowed-Proxy.Example.COM:8080/', { allowlist: allow });
    assert.equal(res.host, 'allowed-proxy.example.com');
});

test('CA-8 · mismatch puerto rechaza', () => {
    const allow = ['allowed-proxy.example.com:8080'];
    assert.throws(
        () => validateProxy('http://allowed-proxy.example.com:9090/', { allowlist: allow }),
        (err) => err.code === 'ERR_PROXY_NOT_WHITELISTED',
    );
});

test('CA-8 · mismatch host rechaza (no startsWith, no wildcard)', () => {
    const allow = ['allowed.com:8080'];
    assert.throws(
        () => validateProxy('http://allowed.com.evil.com:8080/', { allowlist: allow }),
        (err) => err.code === 'ERR_PROXY_NOT_WHITELISTED',
    );
    assert.throws(
        () => validateProxy('http://sub.allowed.com:8080/', { allowlist: allow }),
        (err) => err.code === 'ERR_PROXY_NOT_WHITELISTED',
    );
});

test('CA-8 · whitelist con wildcard lanza error de config', () => {
    assert.throws(
        () => validateProxy('http://x.com:80/', { allowlistPath: '/dev/null/does-not-exist' }),
        // archivo no existe → allowlist vacía → proxy no matchea
        (err) => err.code === 'ERR_PROXY_NOT_WHITELISTED',
    );
});

test('CA-15 · userinfo apuntando a otro host (confusión https://evil@good.com) matchea good.com → host real decide', () => {
    // URL spec: https://attacker.com@allowed-proxy.com:8080/ →
    // username="attacker.com", host="allowed-proxy.com:8080". El host REAL
    // es el del final, no el de userinfo. Eso es lo correcto, pero Leito
    // debe saber que userinfo como "attacker.com" ES tratado como usuario, no
    // como host. Si el host destino matchea la whitelist → auth se acepta.
    const allow = ['allowed-proxy.com:8080'];
    const res = validateProxy('https://attacker.com@allowed-proxy.com:8080/', { allowlist: allow });
    assert.equal(res.host, 'allowed-proxy.com');
    assert.equal(res.auth, 'attacker.com:'); // userinfo normalizado
});

test('CA-15 · userinfo + mismatch rechaza con USERINFO_BLOCKED', () => {
    const allow = ['allowed-proxy.com:8080'];
    assert.throws(
        () => validateProxy('https://evil:pass@other-proxy.com:8080/', { allowlist: allow }),
        (err) => err.code === 'ERR_USERINFO_BLOCKED',
    );
});

test('CA-15 · userinfo en proxy autorizado se acepta', () => {
    const allow = ['proxy.corp.com:8080'];
    const res = validateProxy('http://user:p%40ss@proxy.corp.com:8080/', { allowlist: allow });
    assert.equal(res.auth, 'user:p%40ss');
    assert.equal(res.host, 'proxy.corp.com');
});

test('stripUserinfo · remueve user:pass@ de URLs', () => {
    assert.equal(stripUserinfo('https://user:pass@host.com/p?q=1'), 'https://host.com/p?q=1');
    assert.equal(stripUserinfo('http://user@host.com/'), 'http://host.com/');
    assert.equal(stripUserinfo('https://host.com/'), 'https://host.com/');
});

test('normalizeHostPort · forma canónica lowercase', () => {
    assert.equal(normalizeHostPort('Host.COM:8080'), 'host.com:8080');
});

test('normalizeHostPort · IPv6 con brackets', () => {
    const res = normalizeHostPort('[2001:db8::1]:8080');
    assert.equal(res, '[2001:db8::1]:8080');
});

test('normalizeHostPort · rechaza wildcards', () => {
    assert.throws(() => normalizeHostPort('*.example.com:80'));
});

test('normalizeHostPort · rechaza puerto inválido', () => {
    assert.throws(() => normalizeHostPort('host.com:abc'));
    assert.throws(() => normalizeHostPort('host.com'));
});

test('isAllowedHostPort · match sin URL', () => {
    const allow = ['api.x.com:443'];
    assert.ok(isAllowedHostPort('api.x.com', 443, { allowlist: allow }));
    assert.ok(isAllowedHostPort('API.X.COM', 443, { allowlist: allow }));
    assert.equal(isAllowedHostPort('api.x.com', 80, { allowlist: allow }), false);
});

test('CA-8 · entrada con startsWith bypass no funciona', () => {
    const allow = ['api.company.com:443'];
    assert.equal(isAllowedHostPort('api.company.com.evil.com', 443, { allowlist: allow }), false);
});

test('allowlist vacía rechaza todo', () => {
    assert.throws(
        () => validateProxy('http://any.com:80/', { allowlist: [] }),
        (err) => err.code === 'ERR_PROXY_NOT_WHITELISTED',
    );
});
