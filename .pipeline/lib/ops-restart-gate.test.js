'use strict';

// Tests del gate de seguridad del restart operativo (#4460, REQ-SEC-4460-1).
// node --test .pipeline/lib/ops-restart-gate.test.js

const { test } = require('node:test');
const assert = require('node:assert');

const gate = require('./ops-restart-gate');

function req({ method = 'POST', remote = '127.0.0.1', headers = {} } = {}) {
    // Normalizar headers a lowercase (como los entrega Node).
    const h = {};
    for (const k of Object.keys(headers)) h[k.toLowerCase()] = headers[k];
    return { method, headers: h, socket: { remoteAddress: remote } };
}

const JSON_CT = { 'content-type': 'application/json' };

test('acepta POST loopback con Content-Type application/json y sin Origin (curl/local)', () => {
    const r = gate.checkGate(req({ headers: JSON_CT }));
    assert.strictEqual(r.ok, true);
});

test('acepta Origin permitido (localhost:3200 / 127.0.0.1:3200)', () => {
    assert.strictEqual(gate.checkGate(req({ headers: { ...JSON_CT, origin: 'http://localhost:3200' } })).ok, true);
    assert.strictEqual(gate.checkGate(req({ headers: { ...JSON_CT, origin: 'http://127.0.0.1:3200' } })).ok, true);
});

test('rechaza request NO loopback → 403 not_loopback', () => {
    const r = gate.checkGate(req({ remote: '10.0.0.5', headers: JSON_CT }));
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.status, 403);
    assert.strictEqual(r.code, 'not_loopback');
});

test('rechaza Origin cross-site → 403 bad_origin (anti-CSRF)', () => {
    const r = gate.checkGate(req({ headers: { ...JSON_CT, origin: 'http://evil.example.com' } }));
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.status, 403);
    assert.strictEqual(r.code, 'bad_origin');
});

test('rechaza Referer cross-site → 403 bad_origin', () => {
    const r = gate.checkGate(req({ headers: { ...JSON_CT, referer: 'http://evil.example.com/x' } }));
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.code, 'bad_origin');
});

test('rechaza Content-Type no-json → 415 bad_content_type', () => {
    const r = gate.checkGate(req({ headers: { 'content-type': 'text/plain' } }));
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.status, 415);
    assert.strictEqual(r.code, 'bad_content_type');
});

test('rechaza POST sin Content-Type → 415', () => {
    const r = gate.checkGate(req({ headers: {} }));
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.status, 415);
});

test('acepta ::1 y ::ffff:127.0.0.1 como loopback', () => {
    assert.strictEqual(gate._isLoopback('::1'), true);
    assert.strictEqual(gate._isLoopback('::ffff:127.0.0.1'), true);
    assert.strictEqual(gate._isLoopback('127.0.0.1'), true);
    assert.strictEqual(gate._isLoopback('192.168.1.1'), false);
});

test('GET (no mutación) loopback pasa sin exigir Content-Type', () => {
    const r = gate.checkGate(req({ method: 'GET', headers: {} }));
    assert.strictEqual(r.ok, true);
});
