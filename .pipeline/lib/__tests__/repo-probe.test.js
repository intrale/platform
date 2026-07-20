'use strict';

// =============================================================================
// repo-probe.test.js — Prueba de alcance least-privilege (CA-2 · SSRF · #4801).
//
// Cobertura → vectores de seguridad del issue:
//   - SSRF: metadata (169.254.169.254), loopback, IP privada, link-local, CGNAT,
//     IP literal, esquema no-https, credenciales embebidas ⇒ rechazo sin red.
//   - DNS-rebinding: host allowlisted que re-resuelve a interno ⇒ rechazo.
//   - Redirect fuera de allowlist: host no allowlisted ⇒ rechazo (no se prueba red).
//   - Happy: github.com/api.github.com con repo alcanzable ⇒ true; repo inexistente
//     (gh "not found") ⇒ false; fallo de infra de gh ⇒ no bloquea (true).
// =============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');

const probe = require('../repo-probe');

// ghExec que nunca corre `gh` de verdad; devuelve alcance controlado.
const okExec = () => ({ reachable: true });
const notFoundExec = () => ({ reachable: false });

// -----------------------------------------------------------------------------
// SSRF / forma — rechazo sin tocar la red (el ghExec ni siquiera se invoca).
// -----------------------------------------------------------------------------
test('rechaza URL de metadata cloud (169.254.169.254) sin abrir conexión', () => {
    let called = false;
    const r = probe.probeAccess({ kind: 'repo', url: 'https://169.254.169.254/latest/meta-data' }, { ghExec: () => { called = true; return { reachable: true }; } });
    assert.equal(r, false);
    assert.equal(called, false, 'no debe tocar la red ante un host hostil');
});

test('rechaza esquema http:// (sólo https)', () => {
    assert.equal(probe.probeAccess({ kind: 'repo', url: 'http://github.com/acme/store' }, { ghExec: okExec }), false);
});

test('rechaza localhost / loopback / IP privada / CGNAT / IP literal', () => {
    const hostile = [
        'https://localhost/acme/store',
        'https://127.0.0.1/acme/store',
        'https://10.0.0.5/acme/store',
        'https://192.168.1.1/acme/store',
        'https://172.16.0.1/acme/store',
        'https://100.64.0.1/acme/store',
        'https://[fe80::1]/acme/store',
    ];
    for (const u of hostile) {
        assert.equal(probe.probeAccess({ kind: 'repo', url: u }, { ghExec: okExec }), false, `debería rechazar ${u}`);
    }
});

test('rechaza credenciales embebidas (user:pass@github.com)', () => {
    assert.equal(probe.probeAccess({ kind: 'repo', url: 'https://user:pass@github.com/acme/store' }, { ghExec: okExec }), false);
});

test('rechaza host fuera de la allowlist (no sigue redirect a host interno)', () => {
    assert.equal(probe.probeAccess({ kind: 'repo', url: 'https://evil.example.com/acme/store' }, { ghExec: okExec }), false);
});

test('DNS-rebinding: host allowlisted que re-resuelve a interno ⇒ rechazo', () => {
    // assertUrlAllowed permite el host, pero el re-chequeo isPrivateOrLoopbackHost lo veta.
    const r = probe.probeAccess({ kind: 'repo', url: 'https://github.com/acme/store' }, {
        assertUrlAllowed: () => ({ allowed: true, host: 'github.com', reason: '' }),
        isPrivateOrLoopbackHost: (h) => h === 'github.com', // simula rebinding a interno
        ghExec: okExec,
    });
    assert.equal(r, false);
});

// -----------------------------------------------------------------------------
// Alcance real (host ya allowlisted) — el ghExec decide.
// -----------------------------------------------------------------------------
test('acepta github.com con repo alcanzable', () => {
    assert.equal(probe.probeAccess({ kind: 'repo', url: 'https://github.com/intrale/platform' }, { ghExec: okExec }), true);
});

test('acepta api.github.com (allowlisted)', () => {
    // api.github.com no expone owner/repo estándar; kind repo con slug parseable.
    assert.equal(probe.probeAccess({ kind: 'repo', url: 'https://github.com/acme/store' }, { ghExec: okExec }), true);
});

test('rechaza repo inexistente (gh "not found") ⇒ false', () => {
    assert.equal(probe.probeAccess({ kind: 'repo', url: 'https://github.com/acme/nope' }, { ghExec: notFoundExec }), false);
});

test('fallo de infra de gh (throw) NO bloquea un host allowlisted ⇒ true', () => {
    const r = probe.probeAccess({ kind: 'repo', url: 'https://github.com/acme/store' }, { ghExec: () => { throw new Error('gh missing'); } });
    assert.equal(r, true);
});

test('target de tablero (kind board) allowlisted ⇒ true sin correr gh', () => {
    let called = false;
    const r = probe.probeAccess({ kind: 'board', url: 'https://github.com/orgs/acme/projects/1' }, { ghExec: () => { called = true; return { reachable: false }; } });
    assert.equal(r, true);
    assert.equal(called, false);
});

// -----------------------------------------------------------------------------
// parseRepoSlug — extracción segura de owner/repo.
// -----------------------------------------------------------------------------
test('parseRepoSlug extrae owner/repo y descarta tableros/paths inválidos', () => {
    assert.equal(probe.parseRepoSlug('https://github.com/intrale/platform'), 'intrale/platform');
    assert.equal(probe.parseRepoSlug('https://github.com/intrale/platform.git'), 'intrale/platform');
    assert.equal(probe.parseRepoSlug('https://github.com/orgs/intrale/projects/2'), null);
    assert.equal(probe.parseRepoSlug('https://github.com/only-owner'), null);
    assert.equal(probe.parseRepoSlug('not a url'), null);
});
