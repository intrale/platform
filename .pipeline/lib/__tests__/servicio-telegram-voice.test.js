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
// #5924 — `PIPELINE_STATE_DIR` sólo movía la cola de TRABAJO del servicio. La
// cola donde `notify-telegram` deposita la ALERTA sale de `PIPELINE_DIR_OVERRIDE`
// y, sin setearlo, este archivo escribía un `alert-svc-telegram-*.json` en la
// cola REAL del repo cada vez que un test provocaba un fallo terminal (verificado
// el 13/08/2026: la suite dejaba un dropfile en `.pipeline/servicios/telegram/
// pendiente/`). Con el override apuntando al sandbox, el servicio detecta que la
// cola quedó fuera de la ruta real y suprime la emisión (R5).
process.env.PIPELINE_DIR_OVERRIDE = SANDBOX;

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

// #5924 — el rechazo de un chunk de voz también preserva el error real de la API.
// Antes todos los fallidos quedaban con el mismo string genérico y era imposible
// distinguir un rechazo del adjunto de un problema de formato del texto.
test('assertDelivered: un chunk de voz rechazado conserva error_code y description', () => {
  let capturado = null;
  try {
    svc.assertDelivered(
      { ok: false, error_code: 413, description: 'Request Entity Too Large' },
      1, 3,
    );
  } catch (e) { capturado = e; }

  assert.ok(capturado, 'debe lanzar');
  // El mensaje histórico sigue identificando el chunk (2/3), y ahora suma la causa.
  assert.match(capturado.message, /chunk 2\/3/);
  assert.match(capturado.message, /error_code=413/);
  assert.match(capturado.message, /Request Entity Too Large/);
  assert.equal(capturado.telegramErrorCode, 413);
});

test('#5924: el tipo real de un dropfile de voz es "audio", no "adjunto"', () => {
  assert.equal(svc.outboundKind({ voice: '/tmp/parte-1.ogg' }), 'audio');
  const alerta = svc.buildFailureAlert('voz-1.json', 'rechazo', 5, {
    data: { voice: '/tmp/parte-1.ogg', _partIndex: 1, _partTotal: 3 },
    errorCode: 413,
  });
  assert.match(alerta.message, /No se pudo enviar audio/);
  assert.equal(alerta.context.tipo, 'audio');
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

// -----------------------------------------------------------------------------
// #4796 — Normalización de ruta de adjunto + guarda fail-closed del solo-audio +
// canonical-prefix allowlist (seguridad). Incidente 2026-07-19: audios TTS
// marcados "Enviado" sin llegar por ruta `.ogg` con separadores Windows corruptos.
// -----------------------------------------------------------------------------

// CA-1 / CA-4 (path feliz) — la normalización resuelve al archivo real y lo deja
// listo para `sendVoice` (dentro del allowlist).
test('#4796 resolveAttachmentPath: ruta de voz con separadores redundantes se normaliza y resuelve al .ogg real', () => {
  const media = svc.mediaBaseDir();
  fs.mkdirSync(media, { recursive: true });
  const real = path.join(media, 'tts-happy.ogg');
  fs.writeFileSync(real, Buffer.from('OggS-fake-audio'));

  // Ruta "sucia" con separadores redundantes (`//` y `/./`) que `path.normalize`
  // colapsa de forma determinística en cualquier plataforma.
  const dirty = `${media}//./tts-happy.ogg`;
  const resolved = svc.resolveAttachmentPath('voice', dirty);
  assert.ok(resolved, 'una ruta normalizable resuelve a un path no nulo');
  assert.equal(fs.realpathSync(resolved), fs.realpathSync(real), 'apunta al .ogg real');

  // En Windows, además, el caso exacto del incidente: separadores backslash.
  if (process.platform === 'win32') {
    const withBackslashes = real.replace(/\//g, '\\');
    assert.ok(
      svc.resolveAttachmentPath('voice', withBackslashes),
      'ruta con backslashes de Windows también resuelve al archivo real',
    );
  }
});

// CA-2 / CA-3 (fail-closed decisión) — solo-audio con archivo inexistente NO
// resuelve y dispara la guarda; los caminos con respaldo (texto/edición) o sin
// adjunto declarado NO se bloquean (sin regresión del cierre optimista legítimo).
test('#4796 solo-audio inexistente: no resuelve y shouldFailClosed=true; respaldos no se bloquean', () => {
  const missing = path.join(svc.mediaBaseDir(), 'no-existe-tts.ogg');
  assert.equal(svc.resolveAttachmentPath('voice', missing), null, 'archivo inexistente → null');

  // Ruta corrupta del incidente (separadores perdidos): no existe → null.
  assert.equal(
    svc.resolveAttachmentPath('voice', 'C:WorkspacesIntraleplatformlogsmediatts.ogg'),
    null,
    'ruta con separadores perdidos no se "reconstruye" a ciegas → null (fail-closed)',
  );

  // multipartType null (no resolvió) + sin texto → fail-closed (throw → fallido/).
  assert.equal(svc.shouldFailClosed({ voice: missing }, null), true);
  // Con texto de respaldo NO se bloquea (se envía por sendMessage).
  assert.equal(svc.shouldFailClosed({ voice: missing, text: 'hola' }, null), false);
  // Edición NO se bloquea.
  assert.equal(svc.shouldFailClosed({ method: 'editMessageText', message_id: 5 }, null), false);
  // Dropfile sin adjunto declarado NO se bloquea (cierre optimista legítimo intacto).
  assert.equal(svc.shouldFailClosed({}, null), false);
  // Si el adjunto SÍ resolvió (multipartType presente) NO se bloquea.
  assert.equal(svc.shouldFailClosed({ voice: missing }, 'voice'), false);
});

// CA-2 / CA-3 (end-to-end del ruteo) — un solo-audio con archivo inexistente,
// enrutado a `handleSendFailure`, termina en `fallido/` y NUNCA en `listo/`
// (nunca se marca "Enviado").
test('#4796 fail-closed enruta a handleSendFailure → fallido/, nunca listo/', () => {
  const svcDir = path.join(SANDBOX, 'servicios', 'telegram');
  const pendiente = path.join(svcDir, 'pendiente');
  const trabajando = path.join(svcDir, 'trabajando');
  const fallido = path.join(svcDir, 'fallido');
  const listo = path.join(svcDir, 'listo');
  for (const d of [pendiente, trabajando, fallido, listo]) fs.mkdirSync(d, { recursive: true });

  const name = 'voice-broken-4796.json';
  const wp = path.join(trabajando, name);
  const missing = path.join(svc.mediaBaseDir(), 'nope-4796.ogg');
  const payload = {
    voice: missing,
    _correlationId: rec.generateCorrelationId('voice'),
    _partIndex: 0,
    _partTotal: 1,
  };
  // La decisión de processQueue: como no resuelve y no hay texto → fail-closed.
  assert.equal(svc.shouldFailClosed(payload, null), true);

  const err = new Error(`Adjunto declarado sin archivo resoluble (voice=${missing})`);
  const file = { name, path: path.join(pendiente, name) };
  fs.writeFileSync(wp, JSON.stringify(payload));

  // Iterar hasta el fallo terminal (el contador de intentos se persiste en el
  // archivo; cada 'retry' lo devuelve a pendiente/ con backoff).
  let res;
  for (let i = 0; i < 20; i++) {
    res = svc.handleSendFailure(file, wp, err);
    if (res === 'failed') break;
    // 'retry' → el archivo quedó en pendiente/; devolverlo a trabajando/ para el
    // próximo intento (simula el poll de selección tras vencer el backoff).
    fs.renameSync(file.path, wp);
  }
  assert.equal(res, 'failed', 'agota reintentos y termina en fallo terminal');
  assert.ok(fs.existsSync(path.join(fallido, name)), 'el dropfile queda en fallido/');
  assert.equal(fs.existsSync(path.join(listo, name)), false, 'NUNCA se movió a listo/ (no "Enviado")');
});

// CA-4 (seguridad) — una ruta de voz que resuelve FUERA del dir base allowlisted
// es rechazada (LANZA), nunca se lee ni se envía (anti-exfiltración OWASP A01/A08).
test('#4796 [seguridad] ruta de voz fuera del dir base allowlisted → rechazada (nunca enviada)', () => {
  fs.mkdirSync(svc.mediaBaseDir(), { recursive: true });
  // Archivo "sensible" simulado fuera de logs/media (raíz del sandbox).
  const outside = path.join(SANDBOX, 'application.conf');
  fs.writeFileSync(outside, 'BOT_TOKEN=super-secreto-no-exfiltrar');

  assert.throws(
    () => svc.resolveAttachmentPath('voice', outside),
    /fuera del dir permitido|seguridad/,
    'voice fuera del allowlist LANZA (fail-closed) → se enruta a handleSendFailure',
  );

  // El allowlist estricto aplica SOLO a `voice` (productor con dir base fijo). Los
  // otros adjuntos (rutas de otros flujos: PDFs de rejection, screenshots) no se
  // restringen a media/ y conservan el comportamiento previo.
  assert.doesNotThrow(() => svc.resolveAttachmentPath('document', outside));
});
