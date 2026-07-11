// =============================================================================
// Tests operator-absence-policy.js — #4632 (política de operador ausente).
//
// Cubre las 4 ramas de decisión + autorización del operador + config parcial:
//   - sin base de confianza vigente => fail-closed para cualquier clase
//   - GATE 1 y GATE 2 nunca auto-proceden aunque estén en allowlist
//   - config parcial (allowlist/kill_switch ausente) => fail-closed
//   - clase en allowlist + índice vigente + kill_switch off => auto-proceed
//   - chat_id no autorizado no ejecuta delegación (validateConfirmer)
//
// Tests puros: la función es sin IO cuando se le pasa `config` explícito.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const policy = require('../operator-absence-policy');

const VIGENTE = Object.freeze({ vigente: true });
const NO_VIGENTE = Object.freeze({ vigente: false });

// Config "habilitada" completa: kill-switch off + clase delegable en allowlist.
function cfgHabilitada() {
    return { kill_switch: false, allowlist: ['low-risk-doc'] };
}

// -----------------------------------------------------------------------------
// Rama 2 — sin base de confianza vigente => fail-closed para cualquier clase.
// -----------------------------------------------------------------------------
test('sin base de confianza vigente => fail-closed para cualquier clase', () => {
    for (const confidenceIndex of [undefined, null, NO_VIGENTE, {}]) {
        const r = policy.resolveAbsenceDecision({
            gate: 'gate3',
            clase: 'low-risk-doc',
            config: cfgHabilitada(),
            confidenceIndex,
            killSwitch: false,
        });
        assert.equal(r.decision, 'fail-closed', `confidenceIndex=${JSON.stringify(confidenceIndex)}`);
        assert.equal(r.reason, policy.REASONS.SIN_BASE_CONFIANZA);
    }
});

// -----------------------------------------------------------------------------
// Rama 1 — GATE 1 y GATE 2 hard-deny, aún con todo lo demás habilitado.
// -----------------------------------------------------------------------------
test('GATE 1 y GATE 2 nunca auto-proceden aunque estén en allowlist', () => {
    for (const gate of ['gate1', 'GATE 1', 'gate-1', 'gate2', 'GATE_2']) {
        const r = policy.resolveAbsenceDecision({
            gate,
            clase: 'gate1', // incluso si la "clase" estuviera allowlisteada
            config: { kill_switch: false, allowlist: ['gate1', 'gate2'] },
            confidenceIndex: VIGENTE,
            killSwitch: false,
        });
        assert.equal(r.decision, 'fail-closed', `gate=${gate}`);
        assert.equal(r.reason, policy.REASONS.GATE_NO_DELEGABLE);
    }
});

// -----------------------------------------------------------------------------
// Rama 3 — config parcial/ausente => fail-closed (default seguro).
// -----------------------------------------------------------------------------
test('config parcial (allowlist/kill_switch ausente) => fail-closed', () => {
    // allowlist ausente
    const sinAllowlist = policy.resolveAbsenceDecision({
        gate: 'gate3',
        clase: 'low-risk-doc',
        config: { kill_switch: false }, // sin allowlist
        confidenceIndex: VIGENTE,
    });
    assert.equal(sinAllowlist.decision, 'fail-closed');
    assert.equal(sinAllowlist.reason, policy.REASONS.KILLSWITCH_O_ALLOWLIST);

    // kill_switch ausente => default true => bloqueado
    const sinKillSwitch = policy.resolveAbsenceDecision({
        gate: 'gate3',
        clase: 'low-risk-doc',
        config: { allowlist: ['low-risk-doc'] }, // sin kill_switch
        confidenceIndex: VIGENTE,
    });
    assert.equal(sinKillSwitch.decision, 'fail-closed');
    assert.equal(sinKillSwitch.reason, policy.REASONS.KILLSWITCH_O_ALLOWLIST);

    // config vacío total => fail-closed
    const vacio = policy.resolveAbsenceDecision({
        gate: 'gate3',
        clase: 'low-risk-doc',
        config: {},
        confidenceIndex: VIGENTE,
    });
    assert.equal(vacio.decision, 'fail-closed');
});

// -----------------------------------------------------------------------------
// Rama 3b — kill_switch explícito activo bloquea aunque la clase esté allowlisteada.
// -----------------------------------------------------------------------------
test('kill_switch activo => fail-closed aunque la clase esté en allowlist', () => {
    const r = policy.resolveAbsenceDecision({
        gate: 'gate3',
        clase: 'low-risk-doc',
        config: { kill_switch: true, allowlist: ['low-risk-doc'] },
        confidenceIndex: VIGENTE,
    });
    assert.equal(r.decision, 'fail-closed');
    assert.equal(r.reason, policy.REASONS.KILLSWITCH_O_ALLOWLIST);
});

// -----------------------------------------------------------------------------
// Rama 4 — todas las condiciones simultáneas => auto-proceed dentro del scope.
// -----------------------------------------------------------------------------
test('clase en allowlist + índice vigente + kill_switch off => auto-proceed dentro del scope', () => {
    const r = policy.resolveAbsenceDecision({
        gate: 'gate3',
        clase: 'low-risk-doc',
        config: cfgHabilitada(),
        confidenceIndex: VIGENTE,
        killSwitch: false,
    });
    assert.equal(r.decision, 'auto-proceed');
    assert.equal(r.reason, policy.REASONS.AUTO_PROCEED);
    assert.equal(r.scope, 'low-risk-doc');
});

// -----------------------------------------------------------------------------
// Autorización del operador (OWASP A07) — chat_id no autorizado no delega.
// -----------------------------------------------------------------------------
test('chat_id no autorizado no ejecuta delegación (validateConfirmer)', () => {
    const allowlist = ['123456'];
    const noAuth = policy.authorizeOperator('999999', allowlist);
    assert.equal(noAuth.authorized, false);
    assert.equal(noAuth.reason, 'chat_id_not_in_operator_allowlist');

    // allowlist vacía => fail-closed en auth
    const vacia = policy.authorizeOperator('123456', []);
    assert.equal(vacia.authorized, false);
    assert.equal(vacia.reason, 'empty_operator_allowlist');

    // operador correcto => autorizado
    const ok = policy.authorizeOperator('123456', allowlist);
    assert.equal(ok.authorized, true);
    assert.equal(ok.chatId, '123456');
});

// -----------------------------------------------------------------------------
// Mensajería — fail-closed comunica "por diseño"; delegación es escaneable.
// -----------------------------------------------------------------------------
test('el mensaje fail-closed comunica que la espera es por diseño', () => {
    const msg = policy.buildFailClosedMessage({
        issue: 4632, gate: 'gate3', clase: 'low-risk-doc', reason: policy.REASONS.SIN_BASE_CONFIANZA,
    });
    assert.match(msg, /por diseño/i);
    assert.match(msg, /Nada avanzo sin vos/);
    assert.match(msg, /base de confianza vigente/i);
});

test('el mensaje de delegación incluye qué/quién/cuándo/scope/base y acción de revocación', () => {
    const msg = policy.buildDelegationMessage({
        issue: 4632, gate: 'gate3', actor: 'kernel:absence-policy',
        clase: 'low-risk-doc', scope: 'low-risk-doc',
        confidenceBase: 'indice #4576 vigente', timestamp: '2026-07-11T00:00:00.000Z',
        reason: policy.REASONS.AUTO_PROCEED,
    });
    assert.match(msg, /AUTO_?PROCEDIO|AUTO-PROCEDIO/i);
    assert.match(msg, /kernel:absence-policy/);
    assert.match(msg, /low-risk-doc/);
    assert.match(msg, /2026-07-11T00:00:00\.000Z/);
    assert.match(msg, /Revisar\/Revocar/);
    assert.match(msg, /operator-absence\.jsonl/);
});

// -----------------------------------------------------------------------------
// GATE 1/GATE 2 no reusan copy que sugiera delegación (UX #4632).
// -----------------------------------------------------------------------------
test('mensaje fail-closed de gate no delegable indica firma humana explícita', () => {
    const msg = policy.buildFailClosedMessage({
        issue: 4632, gate: 'gate1', clase: 'firma', reason: policy.REASONS.GATE_NO_DELEGABLE,
    });
    assert.match(msg, /FIRMA HUMANA/i);
    assert.doesNotMatch(msg, /auto-proceder|delegaci/i);
});
