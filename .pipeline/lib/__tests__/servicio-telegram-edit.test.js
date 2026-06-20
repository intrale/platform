// =============================================================================
// Tests de editMessageText — servicio-telegram (#4105 · EP2-H5b · CA-5/CA-8)
//
// editMessageText edita el texto de un mensaje ya enviado (corrección del modelo
// optimista para el canal de TEXTO). Debe despachar vía
// telegramSend('editMessageText', …) y estar exportado.
//
// Convención: sin credenciales, sin red. Se mockea http-client vía require.cache
// ANTES de requerir el servicio para capturar el dispatch sin tocar la API.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Sandbox de estado (servicio-telegram computa dirs desde PIPELINE_STATE_DIR).
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'svc-telegram-edit-'));
const PIPELINE_DIR = path.join(SANDBOX, '.pipeline');
process.env.PIPELINE_STATE_DIR = PIPELINE_DIR;
process.env.PIPELINE_DIR_OVERRIDE = PIPELINE_DIR;
fs.mkdirSync(PIPELINE_DIR, { recursive: true });

// Mock de http-client: registra la última llamada y responde ok.
const calls = [];
const httpClientPath = require.resolve('../http-client');
require.cache[httpClientPath] = {
  id: httpClientPath,
  filename: httpClientPath,
  loaded: true,
  exports: {
    async postJson(url, body) {
      calls.push({ url, body });
      return { body: { ok: true, result: { message_id: body.message_id } } };
    },
    async request() {
      return { statusCode: 200, body: '{}' };
    },
  },
};

const svc = require('../../servicio-telegram');

test('editMessageText está exportado', () => {
  assert.equal(typeof svc.editMessageText, 'function');
});

test('editMessageText despacha vía telegramSend(editMessageText, …) con los params correctos', async () => {
  calls.length = 0;
  const res = await svc.editMessageText(555, 4242, 'texto corregido', { parse_mode: 'Markdown' });
  assert.equal(calls.length, 1);
  assert.ok(calls[0].url.endsWith('/editMessageText'), `url fue ${calls[0].url}`);
  assert.equal(calls[0].body.chat_id, 555);
  assert.equal(calls[0].body.message_id, 4242);
  assert.equal(calls[0].body.text, 'texto corregido');
  assert.equal(calls[0].body.parse_mode, 'Markdown');
  assert.equal(res.ok, true);
});

test('editMessageText funciona sin extra (default {})', async () => {
  calls.length = 0;
  await svc.editMessageText(1, 2, 'hola');
  assert.equal(calls[0].body.text, 'hola');
  assert.equal(calls[0].body.message_id, 2);
});
