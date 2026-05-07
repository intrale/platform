// =============================================================================
// quota-snapshot-alerter.test.js — Tests del alerter Telegram (3 fallos + cuenta).
// Issue #3012 (split de #3008, hija 1).
//
// Cubre CAs:
//   - CA-19: alerta tras 3 fallos consecutivos (anti-spam: una sola hasta
//            recovery).
//   - CA-UX-1.hija1: el microcopy §4.2 se interpola con la categoría
//                    sanitizada (whitelist cerrada). Categoría inventada →
//                    "unknown".
//   - CA-UX-2.hija1: el microcopy §4.3 NO interpola emails (assert binario:
//                    cero "@" en el body). CA-11 implícito.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const alerterMod = require('../quota-snapshot-alerter');

function makeStatePath() {
  const tmp = path.join(os.tmpdir(), `quota-alerter-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  return tmp;
}

function makeAlerter(opts = {}) {
  const sent = [];
  const statePath = makeStatePath();
  const alerter = alerterMod.createAlerter(Object.assign({
    sendMessage: (text) => { sent.push(text); },
    threshold: 3,
    statePath,
  }, opts));
  return { alerter, sent, statePath };
}

test.afterEach(() => {
  // limpieza best-effort de los temp state files; cada test usa su path único.
});

// -----------------------------------------------------------------------------
// CA-19: 3 fallos consecutivos → 1 alerta. Cuarto y quinto fallo NO duplican.
// -----------------------------------------------------------------------------
test('CA-19: 3 fallos consecutivos disparan exactamente 1 alerta', () => {
  const { alerter, sent } = makeAlerter();
  alerter.recordFailure('layout_drift');
  assert.strictEqual(sent.length, 0);
  alerter.recordFailure('layout_drift');
  assert.strictEqual(sent.length, 0);
  alerter.recordFailure('layout_drift');
  assert.strictEqual(sent.length, 1);
});

test('CA-19 anti-spam: 4to y 5to fallo no envían más alertas', () => {
  const { alerter, sent } = makeAlerter();
  for (let i = 0; i < 5; i++) alerter.recordFailure('layout_drift');
  assert.strictEqual(sent.length, 1);
});

test('CA-19 recovery: parser vuelve y un nuevo run de 3 fallos dispara una nueva alerta', () => {
  const { alerter, sent } = makeAlerter();
  alerter.recordFailure('layout_drift');
  alerter.recordFailure('layout_drift');
  alerter.recordFailure('layout_drift');
  assert.strictEqual(sent.length, 1);

  alerter.recordSuccess(); // recovery
  alerter.recordFailure('session_disconnected');
  alerter.recordFailure('session_disconnected');
  alerter.recordFailure('session_disconnected');
  assert.strictEqual(sent.length, 2);
});

// -----------------------------------------------------------------------------
// CA-UX-1.hija1: microcopy §4.2 con whitelist cerrada de categorías.
// -----------------------------------------------------------------------------
test('CA-UX-1.hija1: microcopy §4.2 contiene literal del padre', () => {
  const { alerter, sent } = makeAlerter();
  alerter.recordFailure('layout_drift');
  alerter.recordFailure('layout_drift');
  alerter.recordFailure('layout_drift');
  const body = sent[0];
  assert.match(body, /Lectura del cliente Claude Desktop fallo 3 veces seguidas\./);
  assert.match(body, /Pipeline cae a heuristico para gates de cuota\./);
  assert.match(body, /Causa probable: layout_drift /);
  assert.match(body, /\(layout_drift \| session_disconnected \| account_mismatch \| unknown\)/);
  assert.match(body, /Una sola alerta hasta que vuelva\./);
});

test('CA-UX-1.hija1: categoría inventada se interpola como "unknown"', () => {
  const body = alerterMod.buildParserOfflineMessage('valor_inventado_xyz');
  assert.match(body, /Causa probable: unknown /);
  assert.ok(!body.includes('valor_inventado_xyz'),
    'el valor inventado NO debe aparecer en el body');
});

test('CA-UX-1.hija1: las 4 categorías de la whitelist se interpolan literal', () => {
  for (const cat of alerterMod.FAIL_CATEGORIES) {
    const body = alerterMod.buildParserOfflineMessage(cat);
    assert.ok(body.includes(`Causa probable: ${cat} `),
      `la categoría "${cat}" debe interpolarse literal`);
  }
});

// -----------------------------------------------------------------------------
// CA-UX-2.hija1: microcopy §4.3 no contiene emails ni "@".
// -----------------------------------------------------------------------------
test('CA-UX-2.hija1: alerta de cuenta no esperada no contiene "@" ni emails', () => {
  const { alerter, sent } = makeAlerter();
  alerter.recordAccountMismatch();
  assert.strictEqual(sent.length, 1);
  const body = sent[0];
  assert.ok(!body.includes('@'), 'el body no debe contener "@"');
  assert.ok(!/[a-z0-9._-]+@[a-z0-9.-]+/i.test(body), 'el body no debe contener un email');
  assert.match(body, /Snapshot capturado de una cuenta distinta a la esperada\./);
  assert.match(body, /no se contamina la calibracion/);
  assert.match(body, /Verifica login en Claude Desktop\./);
  assert.match(body, /EXPECTED_CLAUDE_ACCOUNT no coincide con account_handle\./);
});

test('CA-UX-2.hija1: account_mismatch no se duplica (anti-spam)', () => {
  const { alerter, sent } = makeAlerter();
  alerter.recordAccountMismatch();
  alerter.recordAccountMismatch();
  alerter.recordAccountMismatch();
  assert.strictEqual(sent.length, 1);
});

test('CA-UX-2.hija1: account_mismatch se reenvía si recordAccountOk reset', () => {
  const { alerter, sent } = makeAlerter();
  alerter.recordAccountMismatch();
  assert.strictEqual(sent.length, 1);
  alerter.recordAccountOk();
  alerter.recordAccountMismatch();
  assert.strictEqual(sent.length, 2);
});

// -----------------------------------------------------------------------------
// Persistencia del estado en disco.
// -----------------------------------------------------------------------------
test('estado persiste en JSON entre instancias', () => {
  const { alerter: a1, sent: s1, statePath } = makeAlerter();
  a1.recordFailure('layout_drift');
  a1.recordFailure('layout_drift');
  // 2 fallos persistidos; arrancamos un nuevo alerter compartiendo statePath.
  const { alerter: a2, sent: s2 } = makeAlerter({ statePath });
  a2.recordFailure('layout_drift');
  assert.strictEqual(s2.length, 1, 'el 3er fallo dispara la alerta en la nueva instancia');

  const persisted = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  assert.strictEqual(persisted.consecutive_failures, 3);
  assert.strictEqual(persisted.parser_offline_alert_sent, true);
});
