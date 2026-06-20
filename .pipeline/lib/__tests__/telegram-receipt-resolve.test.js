// =============================================================================
// Tests de resolveMessageId — bus de recibos (#4105 · EP2-H5b · CA-6)
//
// El modelo optimista necesita resolver el `message_id` real de entrega para
// editar/seguir un mensaje ya enviado. `message_id` es la ÚNICA prueba de
// entrega (R1 #4082): solo un recibo `enviado` válido resuelve; ausente /
// malformado / forjado / fallido / fuera de orden → null (fail-closed).
//
// Convención: sin credenciales, sin red. Todo en temp dirs.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const rec = require('../telegram-receipt');

function sandbox() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tg-resolve-'));
}

function writeRaw(dir, correlationId, obj) {
  fs.writeFileSync(path.join(dir, `${correlationId}.json`), JSON.stringify(obj));
}

test('resolveMessageId: recibo enviado válido devuelve el primer message_id', () => {
  const dir = sandbox();
  rec.writeReceipt(dir, { correlationId: 'cmd-1750000000-aabbccdd', status: 'enviado', messageIds: [4242] });
  assert.equal(rec.resolveMessageId(dir, 'cmd-1750000000-aabbccdd'), 4242);
});

test('resolveMessageId: idempotente — misma entrada, mismo id, sin mutar', () => {
  const dir = sandbox();
  rec.writeReceipt(dir, { correlationId: 'cmd-1750000000-aabbccdd', status: 'enviado', messageIds: [7] });
  const a = rec.resolveMessageId(dir, 'cmd-1750000000-aabbccdd');
  const b = rec.resolveMessageId(dir, 'cmd-1750000000-aabbccdd');
  assert.equal(a, 7);
  assert.equal(b, 7);
});

test('resolveMessageId: recibo aún no llegado (fuera de orden) ⇒ null, reintentable', () => {
  const dir = sandbox();
  // todavía no se escribió el recibo
  assert.equal(rec.resolveMessageId(dir, 'cmd-1750000000-deadbeef'), null);
  // llega después → resuelve
  rec.writeReceipt(dir, { correlationId: 'cmd-1750000000-deadbeef', status: 'enviado', messageIds: [99] });
  assert.equal(rec.resolveMessageId(dir, 'cmd-1750000000-deadbeef'), 99);
});

test('resolveMessageId: recibo fallido NO resuelve (no hubo entrega)', () => {
  const dir = sandbox();
  rec.writeReceipt(dir, { correlationId: 'cmd-1750000000-aabbccdd', status: 'fallido', messageIds: [] });
  assert.equal(rec.resolveMessageId(dir, 'cmd-1750000000-aabbccdd'), null);
});

test('resolveMessageId: recibo forjado/malformado ⇒ null (cuarentena, R2)', () => {
  const dir = sandbox();
  // enviado sin messageIds (prueba de entrega ausente — R1)
  writeRaw(dir, 'cmd-1750000000-aabbccd1', { correlationId: 'cmd-1750000000-aabbccd1', status: 'enviado', messageIds: [], at: '2026-06-20T00:00:00Z' });
  assert.equal(rec.resolveMessageId(dir, 'cmd-1750000000-aabbccd1'), null);
  // JSON roto
  fs.writeFileSync(path.join(dir, 'cmd-1750000000-aabbccd2.json'), '{roto');
  assert.equal(rec.resolveMessageId(dir, 'cmd-1750000000-aabbccd2'), null);
  // status inválido
  writeRaw(dir, 'cmd-1750000000-aabbccd3', { correlationId: 'cmd-1750000000-aabbccd3', status: 'pwned', messageIds: [1], at: '2026-06-20T00:00:00Z' });
  assert.equal(rec.resolveMessageId(dir, 'cmd-1750000000-aabbccd3'), null);
});

test('resolveMessageId: correlationId inválido (path-traversal) ⇒ null', () => {
  const dir = sandbox();
  assert.equal(rec.resolveMessageId(dir, '../../etc/passwd'), null);
  assert.equal(rec.resolveMessageId(dir, 'x'), null); // muy corto
  assert.equal(rec.resolveMessageId(dir, ''), null);
});

test('resolveMessageId: dir inválido ⇒ null sin lanzar', () => {
  assert.equal(rec.resolveMessageId('', 'cmd-1750000000-aabbccdd'), null);
  assert.equal(rec.resolveMessageId(null, 'cmd-1750000000-aabbccdd'), null);
});
