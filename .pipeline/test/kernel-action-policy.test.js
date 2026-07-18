'use strict';

// =============================================================================
// kernel-action-policy.test.js — GATE 3 (#4577).
//   node --test .pipeline/test/kernel-action-policy.test.js
//
// Cubre CA-4/CA-5/CA-6 + RS-4/RS-5:
//   - resolución de política por-acción (defaults + override desde config).
//   - confirmación no autorizada (chat_id no-allowlisted) → rechazado.
//   - anti-deadlock: fallback por-acción al vencer el timeout.
// =============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');

const policy = require('../lib/kernel-action-policy');

// -----------------------------------------------------------------------------
// CA-4 — resolución de política por-acción (defaults, sin config)
// -----------------------------------------------------------------------------

test('defaults: worktree-reset / quota-flag → notify-and-proceed', () => {
    // Pasamos un config vacío para no depender del config.yaml del repo.
    const opts = { config: {} };
    assert.equal(policy.resolvePolicy('worktree-reset', opts).mode, 'notify-and-proceed');
    assert.equal(policy.resolvePolicy('quota-flag-set', opts).mode, 'notify-and-proceed');
    assert.equal(policy.resolvePolicy('quota-flag-clear', opts).mode, 'notify-and-proceed');
    assert.equal(policy.resolvePolicy('desync-autoresolve', opts).mode, 'notify-and-proceed');
});

test('defaults: realign-allowlist / reseed-wave → wait-confirmation', () => {
    const opts = { config: {} };
    assert.equal(policy.resolvePolicy('realign-allowlist', opts).mode, 'wait-confirmation');
    assert.equal(policy.resolvePolicy('reseed-wave', opts).mode, 'wait-confirmation');
    assert.equal(policy.requiresConfirmation('realign-allowlist', opts), true);
    assert.equal(policy.requiresConfirmation('worktree-reset', opts), false);
});

test('quota-flag-set y quota-flag-clear comparten la clave quota-flag (alias)', () => {
    assert.equal(policy.policyKey('quota-flag-set'), 'quota-flag');
    assert.equal(policy.policyKey('quota-flag-clear'), 'quota-flag');
    assert.equal(policy.policyKey('realign-allowlist'), 'realign-allowlist');
});

test('override desde config.yaml respetado (source=config)', () => {
    const config = { gates: { gate3: { policy: { 'realign-allowlist': 'notify-and-proceed', 'worktree-reset': 'wait-confirmation' } } } };
    const r1 = policy.resolvePolicy('realign-allowlist', { config });
    assert.equal(r1.mode, 'notify-and-proceed');
    assert.equal(r1.source, 'config');
    const r2 = policy.resolvePolicy('worktree-reset', { config });
    assert.equal(r2.mode, 'wait-confirmation');
    assert.equal(r2.source, 'config');
});

test('override con valor inválido cae al default (source=default)', () => {
    const config = { gates: { gate3: { policy: { 'realign-allowlist': 'modo-invalido' } } } };
    const r = policy.resolvePolicy('realign-allowlist', { config });
    assert.equal(r.mode, 'wait-confirmation');
    assert.equal(r.source, 'default');
});

test('acción desconocida cae a notify-and-proceed (fail-open disponibilidad, source=fallback)', () => {
    const r = policy.resolvePolicy('accion-inventada', { config: {} });
    assert.equal(r.mode, 'notify-and-proceed');
    assert.equal(r.source, 'fallback');
});

test('el config.yaml real del repo tiene la política gate3 esperada', () => {
    // Sin config override → lee el config.yaml del repo (o cae a defaults).
    assert.equal(policy.resolvePolicy('realign-allowlist').mode, 'wait-confirmation');
    assert.equal(policy.resolvePolicy('worktree-reset').mode, 'notify-and-proceed');
});

// -----------------------------------------------------------------------------
// #4767 (parte c) — carril paralelo mecánico-vs-decisión (SR-sec-1)
// -----------------------------------------------------------------------------

test('block-autoresolve (mecánico) → notify-and-proceed', () => {
    const opts = { config: {} };
    assert.equal(policy.resolvePolicy('block-autoresolve', opts).mode, 'notify-and-proceed');
    assert.equal(policy.resolvePolicy('block-autoresolve', opts).source, 'default');
    assert.equal(policy.requiresConfirmation('block-autoresolve', opts), false);
});

test('block-escalate (decisión) → wait-confirmation con fallback abort (SR-sec-1)', () => {
    const opts = { config: {} };
    // El path decisión rutea por acción REGISTRADA (no cae al fallback fail-open).
    const r = policy.resolvePolicy('block-escalate', opts);
    assert.equal(r.mode, 'wait-confirmation');
    assert.equal(r.source, 'default');
    assert.equal(policy.requiresConfirmation('block-escalate', opts), true);
    // Fallback al vencer el timeout SIN respuesta → abort (NUNCA proceed sobre main).
    const fb = policy.resolveTimeoutFallback('block-escalate', opts);
    assert.equal(fb.fallback, 'abort');
});

test('block-autoresolve fallback al timeout → proceed (mecánico ya resuelto)', () => {
    const fb = policy.resolveTimeoutFallback('block-autoresolve', { config: {} });
    assert.equal(fb.fallback, 'proceed');
});

test('acción NO registrada del path de bloqueo resuelve abort, JAMÁS proceed (SR-sec-1)', () => {
    // Una acción de bloqueo no mapeada NO debe auto-aprobarse: el fallback de
    // timeout es abort por default (conservador), nunca proceed.
    const fb = policy.resolveTimeoutFallback('block-unregistered-xyz', { config: {} });
    assert.equal(fb.fallback, 'abort');
    assert.notEqual(fb.fallback, 'proceed');
});

test('copy de block-autoresolve/block-escalate: ASCII-safe y diferenciados (UX #4767)', () => {
    const auto = policy.describeAction('block-autoresolve');
    const esc = policy.describeAction('block-escalate');
    // ASCII-safe: sin tildes/ñ ni caracteres fuera de ASCII imprimible.
    const isAscii = (s) => /^[\x20-\x7E]*$/.test(s);
    for (const c of [auto, esc]) {
        assert.ok(isAscii(c.gerund), `gerund ASCII-safe: ${c.gerund}`);
        assert.ok(isAscii(c.what), `what ASCII-safe: ${c.what}`);
    }
    // Diferenciados: no comparten copy (tono mecánico vs tono decisión).
    assert.notEqual(auto.gerund, esc.gerund);
    assert.notEqual(auto.what, esc.what);
});

test('mensaje operador: block-autoresolve informa sin CTA; block-escalate pide OK', () => {
    const infoMsg = policy.buildOperatorMessage({ action: 'block-autoresolve', mode: 'notify-and-proceed' });
    // Sin CTA: no pide OK ni confirmación.
    assert.ok(!/Necesito tu OK/.test(infoMsg));
    assert.ok(/no hace falta que hagas nada|Resolvi esto solo/.test(infoMsg));
    const askMsg = policy.buildOperatorMessage({ action: 'block-escalate', mode: 'wait-confirmation' });
    assert.ok(/Necesito tu OK/.test(askMsg));
});

// -----------------------------------------------------------------------------
// CA-5 / RS-4 — autenticación del confirmador
// -----------------------------------------------------------------------------

test('validateConfirmer autoriza chat_id en la allowlist', () => {
    const r = policy.validateConfirmer('12345', ['12345', '67890']);
    assert.equal(r.authorized, true);
    assert.equal(r.chatId, '12345');
});

test('validateConfirmer rechaza chat_id no-allowlisted', () => {
    const r = policy.validateConfirmer('999', ['12345']);
    assert.equal(r.authorized, false);
    assert.equal(r.reason, 'chat_id_not_in_operator_allowlist');
});

test('validateConfirmer normaliza number vs string', () => {
    assert.equal(policy.validateConfirmer(12345, ['12345']).authorized, true);
    assert.equal(policy.validateConfirmer('12345', [12345]).authorized, true);
});

test('validateConfirmer acepta allowlist como valor único (un operador)', () => {
    assert.equal(policy.validateConfirmer('12345', '12345').authorized, true);
    assert.equal(policy.validateConfirmer('999', '12345').authorized, false);
});

test('validateConfirmer fail-closed: allowlist vacía → no autoriza (RS-4)', () => {
    const r = policy.validateConfirmer('12345', []);
    assert.equal(r.authorized, false);
    assert.equal(r.reason, 'empty_operator_allowlist');
});

test('validateConfirmer rechaza chat_id inválido/ausente', () => {
    assert.equal(policy.validateConfirmer(null, ['12345']).authorized, false);
    assert.equal(policy.validateConfirmer(undefined, ['12345']).authorized, false);
    assert.equal(policy.validateConfirmer('', ['12345']).authorized, false);
});

// -----------------------------------------------------------------------------
// CA-6 / RS-5 — anti-deadlock / timeout fallback
// -----------------------------------------------------------------------------

test('timeout fallback default: electivas abortan, recovery procede', () => {
    const opts = { config: {} };
    assert.equal(policy.resolveTimeoutFallback('realign-allowlist', opts).fallback, 'abort');
    assert.equal(policy.resolveTimeoutFallback('reseed-wave', opts).fallback, 'abort');
    assert.equal(policy.resolveTimeoutFallback('worktree-reset', opts).fallback, 'proceed');
    assert.equal(policy.resolveTimeoutFallback('quota-flag-set', opts).fallback, 'proceed');
});

test('timeout fallback override desde config', () => {
    const config = { gates: { gate3: { timeout_fallback: { 'realign-allowlist': 'proceed' }, timeout_ms: { 'realign-allowlist': 60000 } } } };
    const r = policy.resolveTimeoutFallback('realign-allowlist', { config });
    assert.equal(r.fallback, 'proceed');
    assert.equal(r.source, 'config');
    assert.equal(r.timeoutMs, 60000);
});

test('timeout default es un número positivo', () => {
    const r = policy.resolveTimeoutFallback('reseed-wave', { config: {} });
    assert.ok(Number.isFinite(r.timeoutMs) && r.timeoutMs > 0);
    assert.equal(r.timeoutMs, policy.DEFAULT_TIMEOUT_MS);
});

test('timeout global (gate3.timeout_ms escalar) aplica cuando no hay override por-acción', () => {
    const config = { gates: { gate3: { timeout_ms: 120000 } } };
    const r = policy.resolveTimeoutFallback('reseed-wave', { config });
    assert.equal(r.timeoutMs, 120000);
});

// -----------------------------------------------------------------------------
// Robustez: config ausente/corrupta nunca lanza
// -----------------------------------------------------------------------------

test('config null/no-objeto no rompe la resolución', () => {
    assert.equal(policy.resolvePolicy('worktree-reset', { config: null }).mode, 'notify-and-proceed');
    assert.doesNotThrow(() => policy.resolvePolicy('reseed-wave', { config: 'basura' }));
});
// -----------------------------------------------------------------------------
// Integracion de caller: la politica se ejerce, no queda como codigo muerto.
// -----------------------------------------------------------------------------

test('enforceActionPolicy notify-and-proceed dispara notificacion y permite mutar', () => {
    const sent = [];
    const r = policy.enforceActionPolicy('quota-flag-set', {
        config: {},
        impact: 'alto',
        reason: 'fixture #4565',
        notify: (payload) => {
            sent.push(payload);
            return { ok: true, mocked: true };
        },
    });
    assert.equal(r.proceed, true);
    assert.equal(r.mode, 'notify-and-proceed');
    assert.equal(sent.length, 1);
    assert.equal(sent[0].action, 'quota-flag-set');
});

test('enforceActionPolicy wait-confirmation NO permite mutar sin confirmacion valida', () => {
    const rejected = [];
    const sent = [];
    const r = policy.enforceActionPolicy('realign-allowlist', {
        config: {},
        impact: 'alto',
        reason: 'fixture #4566',
        operatorAllowlist: ['12345'],
        notify: (payload) => {
            sent.push(payload);
            return { ok: true, mocked: true };
        },
        appendConfirmationRejected: (entry) => {
            rejected.push(entry);
            return { ok: true, mocked: true };
        },
    });
    assert.equal(r.proceed, false);
    assert.equal(r.mode, 'wait-confirmation');
    assert.equal(r.reason, 'confirmation-required');
    assert.equal(rejected.length, 1);
    assert.equal(rejected[0].action, 'realign-allowlist');
    assert.equal(sent.length, 1);
});

test('enforceActionPolicy wait-confirmation permite mutar con confirmador allowlisted', () => {
    const r = policy.enforceActionPolicy('reseed-wave', {
        config: {},
        impact: 'alto',
        reason: 'reseed confirmado',
        confirmerChatId: '12345',
        operatorAllowlist: ['12345'],
        notify: () => ({ ok: true, mocked: true }),
        appendConfirmationRejected: () => {
            throw new Error('no debe registrar rechazo');
        },
    });
    assert.equal(r.proceed, true);
    assert.equal(r.mode, 'wait-confirmation');
    assert.equal(r.reason, 'confirmed');
    assert.equal(r.confirmation.authorized, true);
});
