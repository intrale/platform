// =============================================================================
// Tests de editMessageText en servicio-telegram.js (#4105 · CA-5)
//
// El camino optimista de Sherlock CORRIGE una respuesta de TEXTO ya entregada
// editándola vía `telegramSend('editMessageText', …)`. Acá verificamos el
// dispatch (método + params) inyectando un fake de `telegramSend` (el 5º arg
// `_send`), sin tocar red, y que la función está exportada.
//
// Convención: sin credenciales, sin red. Sandbox env antes del require.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'svc-telegram-edit-'));
const PIPELINE_DIR = path.join(SANDBOX, '.pipeline');
process.env.PIPELINE_STATE_DIR = PIPELINE_DIR;
process.env.PIPELINE_DIR_OVERRIDE = PIPELINE_DIR;
fs.mkdirSync(PIPELINE_DIR, { recursive: true });

const svc = require('../../servicio-telegram');

test('editMessageText está exportado y es una función', () => {
  assert.equal(typeof svc.editMessageText, 'function');
});

test('editMessageText despacha vía telegramSend("editMessageText", …) con chat_id/message_id/text', async () => {
  const calls = [];
  const fakeSend = async (method, params) => { calls.push({ method, params }); return { ok: true, result: { message_id: 42 } }; };
  const res = await svc.editMessageText(12345, 678, 'texto corregido', {}, fakeSend);

  assert.equal(calls.length, 1, 'debe despachar exactamente una vez');
  assert.equal(calls[0].method, 'editMessageText', 'método correcto del API');
  assert.equal(calls[0].params.chat_id, 12345);
  assert.equal(calls[0].params.message_id, 678);
  assert.equal(calls[0].params.text, 'texto corregido');
  assert.deepEqual(res, { ok: true, result: { message_id: 42 } }, 'devuelve el body del API');
});

test('editMessageText propaga campos extra (ej. parse_mode) al payload', async () => {
  let seen = null;
  const fakeSend = async (method, params) => { seen = params; return { ok: true }; };
  await svc.editMessageText(1, 2, 'x', { parse_mode: 'Markdown' }, fakeSend);
  assert.equal(seen.parse_mode, 'Markdown');
  assert.equal(seen.message_id, 2);
});
