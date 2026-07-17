// =============================================================================
// Tests de la rama `voice` de la cola de Telegram (#4750)
//
// Cubre la extensión de #4082 a la dimensión de chunk de audio:
//   - `assertDelivered` fail-closed: sin `message_id` NO se da por entregado (SEC-R1).
//   - `writeSentReceiptIfAny` propaga `partIndex`/`partTotal` al recibo por-parte.
//   - `buildMultipartBody` declara `Content-Type: audio/ogg` para voz (Telegram lo
//     exige para `sendVoice`) y mantiene el default para el resto (retrocompat).
//
// Convención: sin credenciales, sin red. `PIPELINE_STATE_DIR` apunta a un temp
// ANTES de requerir el módulo para que `RECIBOS` caiga en el sandbox.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'svc-tg-voice-'));
process.env.PIPELINE_STATE_DIR = SANDBOX;

const svc = require('../../servicio-telegram');
const rec = require('../telegram-receipt');

// -----------------------------------------------------------------------------
// assertDelivered — fail-closed (SEC-R1)
// -----------------------------------------------------------------------------
test('assertDelivered: lanza sin message_id (fail-closed, chunk de voz)', () => {
  assert.throws(() => svc.assertDelivered({ ok: true, result: {} }, 0, 3), /message_id/);
  assert.throws(() => svc.assertDelivered({ ok: false }, 0, 3), /ok:false|message_id/);
  assert.throws(() => svc.assertDelivered(null, 0, 3));
  // Con message_id real NO lanza.
  assert.doesNotThrow(() => svc.assertDelivered({ ok: true, result: { message_id: 42 } }, 0, 3));
});

// -----------------------------------------------------------------------------
// writeSentReceiptIfAny — propaga la dimensión de chunk
// -----------------------------------------------------------------------------
test('writeSentReceiptIfAny: recibo de chunk incluye partIndex/partTotal', () => {
  const cid = rec.generateCorrelationId('voice');
  svc.writeSentReceiptIfAny({ _correlationId: cid, _partIndex: 1, _partTotal: 3 }, [55]);
  const receiptPath = path.join(svc.RECIBOS, `${cid}-p1.json`);
  assert.ok(fs.existsSync(receiptPath), 'escribe recibo por-parte <cid>-p1.json');
  const parsed = rec.parseReceipt(fs.readFileSync(receiptPath, 'utf8'));
  assert.equal(parsed.status, 'enviado');
  assert.deepEqual(parsed.messageIds, [55]);
  assert.equal(parsed.partIndex, 1);
  assert.equal(parsed.partTotal, 3);
});

test('writeSentReceiptIfAny: dims inválidas → NO escribe recibo (fail-closed)', () => {
  const cid = rec.generateCorrelationId('voice');
  // partIndex >= partTotal es inválido → no debe escribirse ningún recibo.
  svc.writeSentReceiptIfAny({ _correlationId: cid, _partIndex: 3, _partTotal: 2 }, [9]);
  assert.equal(fs.existsSync(path.join(svc.RECIBOS, `${cid}-p3.json`)), false);
  assert.equal(fs.existsSync(path.join(svc.RECIBOS, `${cid}.json`)), false);
});

test('writeSentReceiptIfAny: sin dims conserva el recibo de texto legacy', () => {
  const cid = rec.generateCorrelationId('cmd');
  svc.writeSentReceiptIfAny({ _correlationId: cid }, [1, 2]);
  const receiptPath = path.join(svc.RECIBOS, `${cid}.json`);
  assert.ok(fs.existsSync(receiptPath), 'nombre legacy <cid>.json');
  const parsed = rec.parseReceipt(fs.readFileSync(receiptPath, 'utf8'));
  assert.equal(parsed.partIndex, undefined);
});

// -----------------------------------------------------------------------------
// buildMultipartBody — Content-Type parametrizado
// -----------------------------------------------------------------------------
test('buildMultipartBody: usa Content-Type audio/ogg para voz', () => {
  const { body } = svc.buildMultipartBody({
    chatId: '123',
    fieldName: 'voice',
    rawFilename: 'response.ogg',
    fileData: Buffer.from('fake-ogg-bytes'),
    extraFields: {},
    contentType: 'audio/ogg',
  });
  const s = body.toString('utf8');
  assert.ok(s.includes('Content-Type: audio/ogg'), 'declara audio/ogg');
  assert.ok(s.includes('name="voice"; filename="response.ogg"'));
  assert.ok(s.includes('name="chat_id"'));
});

test('buildMultipartBody: default octet-stream (retrocompat document/photo)', () => {
  const { body } = svc.buildMultipartBody({
    chatId: '123',
    fieldName: 'document',
    rawFilename: 'report.pdf',
    fileData: Buffer.from('%PDF'),
  });
  const s = body.toString('utf8');
  assert.ok(s.includes('Content-Type: application/octet-stream'), 'default octet-stream');
});

test('buildMultipartBody: Content-Type con CRLF cae al default (defensa inyección)', () => {
  const { body } = svc.buildMultipartBody({
    chatId: '123',
    fieldName: 'voice',
    rawFilename: 'x.ogg',
    fileData: Buffer.from('a'),
    contentType: 'audio/ogg\r\nX-Injected: 1',
  });
  const s = body.toString('utf8');
  assert.ok(!s.includes('X-Injected'), 'header inyectado no viaja');
  assert.ok(s.includes('Content-Type: application/octet-stream'), 'cae al default seguro');
});
