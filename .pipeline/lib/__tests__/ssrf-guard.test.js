// =============================================================================
// Tests ssrf-guard.js — CA-9 / CA-13
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    isBlockedIPv4,
    isBlockedIPv6,
    isBlockedLiteral,
    validateHostname,
    parseIPv6,
} = require('../ssrf-guard');

test('CA-9 · IPv4 RFC1918 bloqueado', () => {
    assert.ok(isBlockedIPv4('10.0.0.1'));
    assert.ok(isBlockedIPv4('10.255.255.255'));
    assert.ok(isBlockedIPv4('172.16.0.1'));
    assert.ok(isBlockedIPv4('172.31.255.254'));
    assert.ok(isBlockedIPv4('192.168.1.1'));
});

test('CA-9 · IPv4 loopback, link-local, unspecified bloqueados', () => {
    assert.ok(isBlockedIPv4('127.0.0.1'));
    assert.ok(isBlockedIPv4('127.255.255.254'));
    assert.ok(isBlockedIPv4('169.254.169.254')); // AWS metadata
    assert.ok(isBlockedIPv4('0.0.0.0'));
});

test('CA-9 · IPv4 fuera de rangos privados permitida', () => {
    assert.equal(isBlockedIPv4('8.8.8.8'), false);
    assert.equal(isBlockedIPv4('1.1.1.1'), false);
    assert.equal(isBlockedIPv4('52.1.2.3'), false);
    // 172.15 y 172.32 NO son RFC1918
    assert.equal(isBlockedIPv4('172.15.0.1'), false);
    assert.equal(isBlockedIPv4('172.32.0.1'), false);
});

test('CA-9 · IPv4 broadcast y multicast bloqueados', () => {
    assert.ok(isBlockedIPv4('224.0.0.1'));
    assert.ok(isBlockedIPv4('255.255.255.255'));
});

test('CA-13 · IPv6 loopback ::1 bloqueado', () => {
    assert.ok(isBlockedIPv6('::1'));
});

test('CA-13 · IPv6 unspecified ::', () => {
    assert.ok(isBlockedIPv6('::'));
});

test('CA-13 · IPv6 link-local fe80::/10 bloqueado', () => {
    assert.ok(isBlockedIPv6('fe80::1'));
    assert.ok(isBlockedIPv6('fe80:0:0:0:1:2:3:4'));
    assert.ok(isBlockedIPv6('febf::1')); // final del rango
});

test('CA-13 · IPv6 ULA fc00::/7 bloqueado', () => {
    assert.ok(isBlockedIPv6('fc00::1'));
    assert.ok(isBlockedIPv6('fd00::1'));
    assert.ok(isBlockedIPv6('fdff:ffff:ffff:ffff::'));
});

test('CA-13 · IPv4-mapped IPv6 aplica reglas IPv4', () => {
    assert.ok(isBlockedIPv6('::ffff:127.0.0.1'));
    assert.ok(isBlockedIPv6('::ffff:10.0.0.1'));
    assert.ok(isBlockedIPv6('::ffff:192.168.0.1'));
    // IPv4-mapped a IP pública NO bloquea
    assert.equal(isBlockedIPv6('::ffff:8.8.8.8'), false);
});

test('CA-13 · IPv6 global unicast permitida', () => {
    assert.equal(isBlockedIPv6('2001:4860:4860::8888'), false); // Google DNS
    assert.equal(isBlockedIPv6('2606:4700:4700::1111'), false); // Cloudflare
});

test('isBlockedLiteral · localhost y variantes', () => {
    assert.ok(isBlockedLiteral('localhost'));
    assert.ok(isBlockedLiteral('LOCALHOST'));
    assert.ok(isBlockedLiteral('127.0.0.1'));
    assert.ok(isBlockedLiteral('[::1]'));
});

test('parseIPv6 · parseo de formas canónicas y compactas', () => {
    assert.deepEqual(parseIPv6('::1'), [0, 0, 0, 0, 0, 0, 0, 1]);
    assert.deepEqual(parseIPv6('::'), [0, 0, 0, 0, 0, 0, 0, 0]);
    const g = parseIPv6('2001:db8::1');
    assert.equal(g[0], 0x2001);
    assert.equal(g[1], 0x0db8);
    assert.equal(g[7], 1);
});

test('validateHostname · IP privada lanza ERR_SSRF_BLOCKED', async () => {
    await assert.rejects(
        () => validateHostname('10.0.0.1'),
        (err) => err.code === 'ERR_SSRF_BLOCKED',
    );
    await assert.rejects(
        () => validateHostname('localhost'),
        (err) => err.code === 'ERR_SSRF_BLOCKED',
    );
    await assert.rejects(
        () => validateHostname('[::1]'),
        (err) => err.code === 'ERR_SSRF_BLOCKED',
    );
});

test('validateHostname · DNS rebinding: si alguna IP es privada, rechaza', async () => {
    const fakeResolver = {
        lookup: async (_host, _opts) => ([
            { address: '8.8.8.8', family: 4 },
            { address: '127.0.0.1', family: 4 }, // rebinding!
        ]),
    };
    await assert.rejects(
        () => validateHostname('attacker-rebinder.example', { dnsResolver: fakeResolver }),
        (err) => err.code === 'ERR_SSRF_BLOCKED' && /rebinding/i.test(err.message),
    );
});

test('validateHostname · IP pública pasa y devuelve lista', async () => {
    const fakeResolver = {
        lookup: async () => ([{ address: '8.8.8.8', family: 4 }]),
    };
    const ips = await validateHostname('dns.google', { dnsResolver: fakeResolver });
    assert.equal(ips.length, 1);
    assert.equal(ips[0].address, '8.8.8.8');
});

test('validateHostname · literal IPv4 pública devuelve sin tocar DNS', async () => {
    const ips = await validateHostname('8.8.8.8');
    assert.equal(ips[0].address, '8.8.8.8');
    assert.equal(ips[0].family, 4);
});

test('validateHostname · error DNS es traducido', async () => {
    const fakeResolver = {
        lookup: async () => { const e = new Error('no dns'); e.code = 'ENOTFOUND'; throw e; },
    };
    await assert.rejects(
        () => validateHostname('no-such-host.example', { dnsResolver: fakeResolver }),
        (err) => err.code === 'ENOTFOUND' && /no se pudo resolver/.test(err.message),
    );
});
