// =============================================================================
// Tests del path de fallo terminal de envío de adjuntos/mensajes en
// servicio-telegram.js (#3927 / EP3-H1 — CA-3 / RS-3)
//
// Cubre la mitad de CA-3 que faltaba: "Fallo de envío de CUALQUIER adjunto
// SIEMPRE notifica (nunca más silencio)". Antes el catch del envío individual
// sólo logueaba y devolvía el dropfile a pendiente/ → reintento infinito y
// silencioso. Ahora:
//   - reintento acotado (contador `_telegramAttempts` persistido en el archivo)
//   - al agotarlo → mover a fallido/ + emitir alerta a Telegram (notifyTelegram)
//   - el mensaje pasa por redactSensitive + redactSecretValue (RS-3)
//   - guard anti-recursión: no re-notificar el fallo de una alerta propia
//
// Convención: sin credenciales, sin red. Todo en temp dirs.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// -----------------------------------------------------------------------------
// Sandbox: servicio-telegram computa QUEUE_DIR/FALLIDO a partir de
// PIPELINE_STATE_DIR al requerirse; notify-telegram usa PIPELINE_DIR_OVERRIDE
// para la cola donde deposita el dropfile de alerta. Se setean ANTES del require.
// -----------------------------------------------------------------------------
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'svc-telegram-fail-'));
const PIPELINE_DIR = path.join(SANDBOX, '.pipeline');
process.env.PIPELINE_STATE_DIR = PIPELINE_DIR;
process.env.PIPELINE_DIR_OVERRIDE = PIPELINE_DIR;
fs.mkdirSync(PIPELINE_DIR, { recursive: true });

const QUEUE_DIR = path.join(PIPELINE_DIR, 'servicios', 'telegram');
const PENDIENTE = path.join(QUEUE_DIR, 'pendiente');
const TRABAJANDO = path.join(QUEUE_DIR, 'trabajando');
const FALLIDO = path.join(QUEUE_DIR, 'fallido');
const LISTO = path.join(QUEUE_DIR, 'listo');
const RECIBOS = path.join(QUEUE_DIR, 'recibos');

const svc = require('../../servicio-telegram');
const {
  handleSendFailure, notifyTelegramFailure, MAX_SEND_RETRIES,
  // #4082
  loadOutboundConfig, sweepFallidoOnce, isRetryDeferred, assertDelivered, writeSentReceiptIfAny,
  // #5924
  buildFailureAlert, resolveAlertSuppression, honorsPermanentFlag, outboundKind, safeExcerpt,
  TELEGRAM_DESCRIPTION_MAX, PERSISTED_ERROR_MAX,
} = svc;
const telegramReceipt = require('../telegram-receipt');
const { notifyTelegram } = require('../notify-telegram');

// -----------------------------------------------------------------------------
// helpers
// -----------------------------------------------------------------------------
function resetQueues() {
  for (const d of [PENDIENTE, TRABAJANDO, FALLIDO]) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch {}
    fs.mkdirSync(d, { recursive: true });
  }
}

// Coloca un dropfile en trabajando/ y devuelve el descriptor {name, path} tal
// como lo arma listWorkFiles a partir de pendiente/.
function placeWorkingFile(name, content) {
  fs.writeFileSync(path.join(TRABAJANDO, name), JSON.stringify(content, null, 2));
  return { name, path: path.join(PENDIENTE, name) };
}

function listAlerts() {
  try {
    return fs.readdirSync(PENDIENTE).filter(f => f.startsWith('alert-svc-telegram'));
  } catch { return []; }
}

function readAlert(name) {
  return JSON.parse(fs.readFileSync(path.join(PENDIENTE, name), 'utf8'));
}

// -----------------------------------------------------------------------------
// tests
// -----------------------------------------------------------------------------

test('reintento acotado: el primer fallo reencola a pendiente/ con contador, sin alerta', () => {
  resetQueues();
  const file = placeWorkingFile('drop-1.json', { document: '/tmp/x.pdf' });
  const trabajandoPath = path.join(TRABAJANDO, file.name);

  const verdict = handleSendFailure(file, trabajandoPath, new Error('boom transitorio'));

  assert.equal(verdict, 'retry');
  // Vuelve a pendiente/, NO a fallido/.
  assert.ok(fs.existsSync(file.path), 'el archivo debe volver a pendiente/');
  assert.ok(!fs.existsSync(path.join(FALLIDO, file.name)), 'no debe ir a fallido/ todavía');
  // Contador persistido.
  const reloaded = JSON.parse(fs.readFileSync(file.path, 'utf8'));
  assert.equal(reloaded._telegramAttempts, 1);
  // Sin alerta todavía: el fallo no es terminal.
  assert.equal(listAlerts().length, 0);
});

// ⚠️ #5924 — Este sandbox corre con `PIPELINE_DIR_OVERRIDE` a un temp dir, o sea
// FUERA de la cola real de Telegram. Desde #5924 eso activa la supresión de
// emisión (R5): la alerta se construye igual pero no se deposita en ninguna cola.
// Por eso los asserts sobre el CONTENIDO de la alerta pasaron a hacerse sobre
// `buildFailureAlert` (función pura) y los de "no contamina" sobre `listAlerts()`.
// Verificar el contenido emitiendo a una cola real sería justamente lo que el
// CA-7 prohíbe.

test('fallo terminal tras MAX_SEND_RETRIES: mueve a fallido/ y construye la alerta (CA-3)', () => {
  resetQueues();
  // Ya consumió MAX-1 intentos previos: este fallo es el que agota el presupuesto.
  const file = placeWorkingFile('drop-term.json', {
    document: '/tmp/x.pdf',
    _telegramAttempts: MAX_SEND_RETRIES - 1,
  });
  const trabajandoPath = path.join(TRABAJANDO, file.name);

  const verdict = handleSendFailure(file, trabajandoPath, new Error('rechazo permanente de Telegram'));

  assert.equal(verdict, 'failed');
  // Movido a fallido/, ya NO en pendiente/ ni trabajando/.
  assert.ok(fs.existsSync(path.join(FALLIDO, file.name)), 'debe quedar en fallido/');
  assert.ok(!fs.existsSync(file.path), 'no debe quedar en pendiente/');
  assert.ok(!fs.existsSync(trabajandoPath), 'no debe quedar en trabajando/');
  // Metadata de fallo persistida.
  const failed = JSON.parse(fs.readFileSync(path.join(FALLIDO, file.name), 'utf8'));
  assert.equal(failed._telegramAttempts, MAX_SEND_RETRIES);
  assert.ok(failed._error, 'debe registrar _error');
  assert.ok(failed._failedAt, 'debe registrar _failedAt');
  // CA-3 sigue vigente: hay una alerta construida para ese fallo, con el tipo real.
  const alerta = buildFailureAlert(file.name, 'rechazo permanente de Telegram', MAX_SEND_RETRIES, {
    data: failed,
  });
  assert.match(alerta.message, /No se pudo enviar documento/);
  assert.equal(alerta.context.tipo, 'documento');
});

test('RS-3: el mensaje de la alerta va redactado (nunca el secreto crudo)', () => {
  const secret = 'AKIAIOSFODNN7EXAMPLE';
  const alerta = buildFailureAlert('drop-secret.json', `subida rechazada, creds ${secret} expuestas`, 5, {
    data: { photo: '/tmp/x.png' },
  });
  const serialized = JSON.stringify(alerta);
  assert.ok(!serialized.includes(secret), 'el secreto NO debe aparecer en la alerta');
  assert.match(serialized, /\[REDACTED\]/, 'el secreto debe quedar redactado');
});

test('archivo malformado: fallo terminal inmediato (no loop infinito)', () => {
  resetQueues();
  const name = 'drop-malformado.json';
  fs.writeFileSync(path.join(TRABAJANDO, name), '{ esto no es JSON valido');
  const file = { name, path: path.join(PENDIENTE, name) };
  const trabajandoPath = path.join(TRABAJANDO, name);

  const verdict = handleSendFailure(file, trabajandoPath, new Error('parse upstream'));

  assert.equal(verdict, 'failed');
  assert.ok(fs.existsSync(path.join(FALLIDO, name)), 'un archivo ilegible va directo a fallido/');
  // CA-7: la suite no deposita nada en ninguna cola de Telegram.
  assert.equal(listAlerts().length, 0, 'la emisión está suprimida en sandbox');
});

test('anti-recursión: no se re-notifica el fallo de una alerta propia', () => {
  resetQueues();
  const ok = notifyTelegramFailure('alert-svc-telegram-12345-1.json', 'outage del API');
  assert.equal(ok, false, 'debe abstenerse de notificar una alerta propia');
  assert.equal(listAlerts().length, 0, 'no debe escribir ninguna alerta nueva');
});

// =============================================================================
// #4082 — Confirmación de entrega real + backoff + recibos + barredor de fallido/
// =============================================================================

function resetAll() {
  for (const d of [PENDIENTE, TRABAJANDO, FALLIDO, LISTO, RECIBOS]) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch {}
    fs.mkdirSync(d, { recursive: true });
  }
}
function listReceipts() {
  try { return fs.readdirSync(RECIBOS).filter(f => f.endsWith('.json')); } catch { return []; }
}
function readReceipt(name) {
  return telegramReceipt.parseReceipt(fs.readFileSync(path.join(RECIBOS, name), 'utf8'));
}

// -----------------------------------------------------------------------------
// assertDelivered (SEC-2 fail-closed: sin ok:true + message_id NO hay entrega)
// -----------------------------------------------------------------------------
test('assertDelivered: lanza ante ok:false o sin message_id; pasa con ok:true', () => {
  assert.throws(() => assertDelivered({ ok: false }, 0, 1));
  assert.throws(() => assertDelivered({ ok: true, result: {} }, 0, 1), /sin message_id|ok:false/);
  assert.throws(() => assertDelivered(null, 0, 1));
  assert.throws(() => assertDelivered({ ok: true }, 0, 1));
  // ok:true con message_id → no lanza
  assert.doesNotThrow(() => assertDelivered({ ok: true, result: { message_id: 99 } }, 0, 1));
});

// -----------------------------------------------------------------------------
// #5924 — assertDelivered preserva el error REAL de la API
// -----------------------------------------------------------------------------
test('#5924 assertDelivered: propaga error_code y description en el mensaje y como dato', () => {
  let capturado = null;
  try {
    assertDelivered(
      { ok: false, error_code: 400, description: "Bad Request: can't parse entities" },
      0, 1,
    );
  } catch (e) { capturado = e; }

  assert.ok(capturado, 'debe lanzar');
  assert.match(capturado.message, /error_code=400/);
  assert.match(capturado.message, /can't parse entities/);
  // Dato ESTRUCTURADO acotado, separado del texto remoto (R4.1).
  assert.equal(capturado.telegramErrorCode, 400);
  assert.match(capturado.telegramDescription, /can't parse entities/);
});

test('#5924 assertDelivered: sin error_code el mensaje no inventa uno', () => {
  let capturado = null;
  try { assertDelivered({ ok: false }, 0, 1); } catch (e) { capturado = e; }
  assert.equal(capturado.telegramErrorCode, null);
  assert.equal(capturado.telegramDescription, '');
  assert.doesNotMatch(capturado.message, /error_code=/);
});

test('#5924 assertDelivered: description remoto truncado a 500 chars', () => {
  let capturado = null;
  try {
    assertDelivered({ ok: false, error_code: 400, description: 'D'.repeat(5000) }, 0, 1);
  } catch (e) { capturado = e; }
  assert.equal(capturado.telegramDescription.length, TELEGRAM_DESCRIPTION_MAX);
});

test('#5924 SEC-B: se redacta ANTES de truncar, si no la redacción se desactiva sola', () => {
  // El patrón de `redact.js` para el token del bot exige 20+ chars opacos
  // después de `/bot`. Si se trunca PRIMERO, el corte deja un prefijo demasiado
  // corto, ningún patrón matchea y el prefijo del secreto se persiste igual.
  // Este caso está construido justo sobre esa frontera: el `/bot` cae en el
  // char 480, así que un truncado previo dejaría sólo 16 chars del token.
  const token = '123456789:AAHabcdefghijklmnopqrstuvwxyz0123456789';
  const prefijo = 'E'.repeat(480);
  const description = `${prefijo}/bot${token}/sendMessage rechazado`;

  let capturado = null;
  try {
    assertDelivered({ ok: false, error_code: 401, description }, 0, 1);
  } catch (e) { capturado = e; }

  const salida = capturado.telegramDescription;
  assert.equal(salida.length, TELEGRAM_DESCRIPTION_MAX, 'sigue acotado a 500');
  assert.ok(!salida.includes(token), 'el token NO puede sobrevivir');
  // Ni siquiera el prefijo que un truncado-primero habría dejado pasar.
  assert.ok(!salida.includes(token.slice(0, 16)), 'ni el prefijo que el corte habría dejado');
  assert.match(salida, /\/bot\[REDACTED\]/, 'el token quedó tachado por patrón');
});

// -----------------------------------------------------------------------------
// #5924 — handleSendFailure persiste el error REDACTADO + datos estructurados
// -----------------------------------------------------------------------------
test('#5924 R2: _error se persiste redactado y truncado (contenido remoto en la escritura)', () => {
  resetQueues();
  const secret = 'AKIAIOSFODNN7EXAMPLE';
  const file = placeWorkingFile('drop-remoto.json', {
    text: 'hola',
    _telegramAttempts: MAX_SEND_RETRIES - 1,
  });
  const err = new Error(`Telegram respondio ok:false description=creds ${secret} ${'X'.repeat(2000)}`);
  err.telegramErrorCode = 400;
  err.telegramDescription = 'Bad Request';

  handleSendFailure(file, path.join(TRABAJANDO, file.name), err);

  const failed = JSON.parse(fs.readFileSync(path.join(FALLIDO, file.name), 'utf8'));
  assert.ok(!failed._error.includes(secret), '_error NO puede persistir el secreto crudo');
  assert.match(failed._error, /\[REDACTED\]/, '_error queda redactado en disco');
  assert.equal(failed._error.length, PERSISTED_ERROR_MAX, '_error truncado a 500');
  // Dato acotado que debe sobrevivir al sweep.
  assert.equal(failed._telegramErrorCode, 400);
  assert.equal(failed._telegramPermanentFailure, true, '400 es no reintentable');
});

test('#5924: un 429 (rate limit) NO se marca como fallo permanente', () => {
  resetQueues();
  const file = placeWorkingFile('drop-429.json', {
    text: 'hola', _telegramAttempts: MAX_SEND_RETRIES - 1,
  });
  const err = new Error('Too Many Requests');
  err.telegramErrorCode = 429;

  handleSendFailure(file, path.join(TRABAJANDO, file.name), err);

  const failed = JSON.parse(fs.readFileSync(path.join(FALLIDO, file.name), 'utf8'));
  assert.equal(failed._telegramErrorCode, 429);
  assert.equal(failed._telegramPermanentFailure, undefined, 'transitorio: se sigue reintentando');
});

// -----------------------------------------------------------------------------
// #5924 — la alerta nombra el TIPO REAL y no filtra la URL del botón (SEC-A)
// -----------------------------------------------------------------------------
test('#5924 outboundKind: deriva el tipo real del dropfile, no "adjunto" para todo', () => {
  assert.equal(outboundKind({ voice: '/x.ogg' }), 'audio');
  assert.equal(outboundKind({ document: '/x.pdf' }), 'documento');
  assert.equal(outboundKind({ photo: '/x.png' }), 'imagen');
  assert.equal(outboundKind({ text: 'hola' }), 'mensaje de texto');
  assert.equal(outboundKind({ text: 'hola', reply_markup: { inline_keyboard: [] } }), 'notificacion con botones');
  assert.equal(outboundKind(null), 'desconocido');
});

test('#5924: la alerta de un mensaje de texto NO dice "adjunto"', () => {
  const alerta = buildFailureAlert('drop-texto.json', 'Telegram respondio ok:false', 5, {
    data: { text: 'Pipeline parado por cuota' },
    errorCode: 400,
    description: "Bad Request: can't parse entities at byte 42",
  });
  assert.match(alerta.message, /mensaje de texto/);
  assert.doesNotMatch(alerta.message, /adjunto/i, 'no puede sugerir un problema de archivos inexistente');
  assert.match(alerta.message, /error_code 400/);
  assert.equal(alerta.context.tipo, 'mensaje de texto');
  assert.equal(alerta.context.error_code, '400');
  // Identifica el envío perdido POR CONTENIDO, no sólo por nombre de archivo.
  assert.match(alerta.context.extracto, /Pipeline parado por cuota/);
  // El description remoto va al bloque de código.
  assert.match(alerta.codeBlock, /can't parse entities/);
});

test('#5924 SEC-A: la alerta NUNCA filtra la URL del botón del dropfile', () => {
  const url = 'https://intrale.example.com/accion?token=CAPABILITY-SECRETA-123';
  const alerta = buildFailureAlert('drop-boton.json', 'Telegram respondio ok:false', 5, {
    data: {
      text: 'Aprobar el issue 5924',
      reply_markup: { inline_keyboard: [[{ text: 'Aprobar', url }]] },
    },
    errorCode: 400,
    description: 'Bad Request: BUTTON_URL_INVALID',
  });
  const serialized = JSON.stringify(alerta);
  assert.ok(!serialized.includes(url), 'la URL de la capability no puede aparecer');
  assert.ok(!serialized.includes('CAPABILITY-SECRETA-123'), 'ni el token');
  // Pero sí nombra el tipo real, que es lo que el operador necesita.
  assert.equal(alerta.context.tipo, 'notificacion con botones');
});

test('#5924: safeExcerpt sólo mira campos de texto, nunca markup', () => {
  const e = safeExcerpt({
    reply_markup: { inline_keyboard: [[{ text: 'x', url: 'https://malo/token=Z' }]] },
  });
  assert.equal(e, '', 'sin campo de texto no hay extracto');
  const largo = safeExcerpt({ text: 'A'.repeat(1000) });
  assert.ok(largo.length <= 200, 'el extracto queda acotado a 200 chars');
});

test('#5924 R4.2: el conteo va SIEMPRE en el contexto de la alerta', () => {
  const sola = buildFailureAlert('a.json', 'x', 5, { data: { text: 'y' } });
  assert.equal(sola.context.envios, '1');
  const agrupada = buildFailureAlert('a.json', 'x', 5, { data: { text: 'y' }, count: 17 });
  assert.equal(agrupada.context.envios, '17');
});

test('#5924 R6: el description se emite dentro de un bloque de código en el dropfile', () => {
  resetQueues();
  const alerta = buildFailureAlert('drop-md.json', 'rechazo', 5, {
    data: { text: 'hola' },
    errorCode: 400,
    description: "Bad Request: can't parse entities: unbalanced _ and * at byte 9",
  });
  // Emitimos con notifyTelegram directo (el sandbox tiene la cola en tmp) para
  // ver el dropfile REAL que viajaría a Telegram.
  const { _dedupKey, _kind, _excerpt, ...clean } = alerta;
  const res = notifyTelegram(clean);
  assert.equal(res.ok, true);
  const drop = JSON.parse(fs.readFileSync(res.dropPath, 'utf8'));
  assert.match(drop.text, /```\n[^`]*unbalanced/, 'el description va dentro de un fence');
  // Y el resto del mensaje sigue escapado (no puede romper el parseo).
  assert.equal(drop.parse_mode, 'Markdown');
  fs.unlinkSync(res.dropPath);
});

test('#5924 R6: un description con backticks o saltos no puede cerrar el bloque', () => {
  resetQueues();
  const alerta = buildFailureAlert('drop-evil.json', 'rechazo', 5, {
    data: { text: 'hola' },
    errorCode: 400,
    description: 'malicioso ``` \n``` fuera del bloque *negrita*',
  });
  const { _dedupKey, _kind, _excerpt, ...clean } = alerta;
  const res = notifyTelegram(clean);
  const drop = JSON.parse(fs.readFileSync(res.dropPath, 'utf8'));
  // Exactamente dos fences: el de apertura y el de cierre que ponemos nosotros.
  const fences = drop.text.match(/```/g) || [];
  assert.equal(fences.length, 2, 'el contenido remoto no puede inyectar fences');
  fs.unlinkSync(res.dropPath);
});

// -----------------------------------------------------------------------------
// #5924 / R5 — Aislamiento derivado del PATH, no de una env var de modo
// -----------------------------------------------------------------------------
test('#5924 R5: con la cola fuera de la ruta real, la emisión se suprime', () => {
  resetQueues();
  const supp = resolveAlertSuppression();
  assert.equal(supp.suppress, true, 'el sandbox está fuera de la cola real');
  assert.equal(supp.reason, 'cola_fuera_de_la_ruta_real');

  const emitido = notifyTelegramFailure('drop-supr.json', 'boom', 5, { data: { text: 'x' } });
  assert.equal(emitido, false, 'no emite');
  assert.equal(listAlerts().length, 0, 'no deja archivos en ninguna cola');
});

test('#5924 R5: producción NO se puede silenciar con una env var', () => {
  const previo = process.env.PIPELINE_DIR_OVERRIDE;
  const previoNodeEnv = process.env.NODE_ENV;
  try {
    // Sin override, la cola resuelve a la ruta REAL → NO se suprime.
    delete process.env.PIPELINE_DIR_OVERRIDE;
    // Y NODE_ENV=test tampoco silencia: la supresión no se deriva del modo.
    process.env.NODE_ENV = 'test';
    const supp = resolveAlertSuppression();
    assert.equal(supp.suppress, false, 'sin override la alerta se emite igual');
    assert.equal(supp.reason, 'cola_real');
  } finally {
    if (previo === undefined) delete process.env.PIPELINE_DIR_OVERRIDE;
    else process.env.PIPELINE_DIR_OVERRIDE = previo;
    if (previoNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previoNodeEnv;
  }
});

test('#5924: el guard anti-recursión corre ANTES de la dedup (no hay segunda vía)', () => {
  resetQueues();
  // Varias alertas propias seguidas: ninguna entra al buffer ni emite consolidado.
  for (let i = 0; i < 10; i++) {
    assert.equal(notifyTelegramFailure(`alert-svc-telegram-${i}.json`, 'outage', 5), false);
  }
  assert.equal(svc.flushAlertBuffer(Date.now() + 3600000), 0, 'nada consolidado por alertas propias');
  assert.equal(listAlerts().length, 0);
});

// -----------------------------------------------------------------------------
// writeSentReceiptIfAny (recibo enviado solo si hay correlationId válido)
// -----------------------------------------------------------------------------
test('writeSentReceiptIfAny: escribe recibo enviado con message_ids cuando hay correlationId', () => {
  resetAll();
  writeSentReceiptIfAny({ _correlationId: 'cmd-okx-abcdef', text: 'hola' }, [101, 102]);
  const recibos = listReceipts();
  assert.equal(recibos.length, 1);
  const r = readReceipt(recibos[0]);
  assert.equal(r.status, 'enviado');
  assert.deepEqual(r.messageIds, [101, 102]);
});

test('writeSentReceiptIfAny: no-op si el saliente no trae correlationId (notif interna)', () => {
  resetAll();
  writeSentReceiptIfAny({ text: 'notif sin correlation' }, [1]);
  assert.equal(listReceipts().length, 0, 'sin correlationId no se escribe recibo');
});

// -----------------------------------------------------------------------------
// Backoff: handleSendFailure estampa _nextRetryAt creciente
// -----------------------------------------------------------------------------
test('handleSendFailure: reintento estampa _nextRetryAt futuro y creciente entre intentos', () => {
  resetAll();
  // 1er fallo (attempts 0 → 1): backoff_base * 2^0
  const f1 = placeWorkingFile('bk-1.json', { text: 'x', _correlationId: 'cmd-bk1-abcdef' });
  handleSendFailure(f1, path.join(TRABAJANDO, f1.name), new Error('boom'));
  const r1 = JSON.parse(fs.readFileSync(f1.path, 'utf8'));
  assert.equal(r1._telegramAttempts, 1);
  assert.ok(r1._nextRetryAt, 'debe estampar _nextRetryAt');
  const delay1 = Date.parse(r1._nextRetryAt) - Date.now();
  assert.ok(delay1 > 0, 'el reintento debe ser futuro');

  // 3er fallo (attempts 2 → 3): backoff_base * 2^2 > el de attempts=1
  const f3 = placeWorkingFile('bk-3.json', { text: 'x', _correlationId: 'cmd-bk3-abcdef', _telegramAttempts: 2 });
  handleSendFailure(f3, path.join(TRABAJANDO, f3.name), new Error('boom'));
  const r3 = JSON.parse(fs.readFileSync(f3.path, 'utf8'));
  const delay3 = Date.parse(r3._nextRetryAt) - Date.now();
  assert.ok(delay3 > delay1, 'el backoff debe crecer con el nº de intento');
});

// -----------------------------------------------------------------------------
// Terminal con correlationId → recibo fallido (sin texto de error: SEC-1)
// -----------------------------------------------------------------------------
test('handleSendFailure terminal con correlationId: escribe recibo fallido (CA-A3/B4)', () => {
  resetAll();
  const file = placeWorkingFile('term-cid.json', {
    text: 'respuesta perdida',
    _correlationId: 'cmd-term-abcdef',
    _telegramAttempts: MAX_SEND_RETRIES - 1,
  });
  const verdict = handleSendFailure(file, path.join(TRABAJANDO, file.name), new Error('ENOTFOUND host'));
  assert.equal(verdict, 'failed');
  const recibos = listReceipts();
  assert.equal(recibos.length, 1, 'debe escribir un recibo fallido');
  const r = readReceipt(recibos[0]);
  assert.equal(r.status, 'fallido');
  assert.deepEqual(r.messageIds, []);
  // SEC-1: el recibo no contiene texto de error ni la URL del token.
  const raw = fs.readFileSync(path.join(RECIBOS, recibos[0]), 'utf8');
  assert.ok(!/ENOTFOUND|bot\d|api\.telegram/.test(raw), 'el recibo no filtra error ni URL');
});

// -----------------------------------------------------------------------------
// isRetryDeferred: respeta la ventana de backoff
// -----------------------------------------------------------------------------
test('isRetryDeferred: difiere si _nextRetryAt es futuro, no difiere si venció o falta', () => {
  resetAll();
  const future = path.join(PENDIENTE, 'fut.json');
  fs.writeFileSync(future, JSON.stringify({ text: 'x', _nextRetryAt: new Date(Date.now() + 60000).toISOString() }));
  assert.equal(isRetryDeferred(future), true);

  const past = path.join(PENDIENTE, 'past.json');
  fs.writeFileSync(past, JSON.stringify({ text: 'x', _nextRetryAt: new Date(Date.now() - 60000).toISOString() }));
  assert.equal(isRetryDeferred(past), false);

  const none = path.join(PENDIENTE, 'none.json');
  fs.writeFileSync(none, JSON.stringify({ text: 'x' }));
  assert.equal(isRetryDeferred(none), false);

  assert.equal(isRetryDeferred(path.join(PENDIENTE, 'noexiste.json')), false, 'ilegible → no diferir');
});

// -----------------------------------------------------------------------------
// Barredor de fallido/ (CA-B5 + SEC-3 + SEC-4)
// -----------------------------------------------------------------------------
test('sweepFallidoOnce: reencola con _nextRetryAt escalonado y presupuesto reseteado (SEC-3)', () => {
  resetAll();
  // 3 fallidos recientes (no stale), con attempts agotados de la lógica vieja.
  for (let i = 0; i < 3; i++) {
    fs.writeFileSync(path.join(FALLIDO, `f-${i}-cmd.json`), JSON.stringify({
      text: `m${i}`, _telegramAttempts: 9, _error: 'viejo', _failedAt: new Date().toISOString(),
    }));
  }
  const res = sweepFallidoOnce();
  assert.equal(res.requeued, 3);
  assert.equal(res.discarded, 0);
  assert.equal(fs.readdirSync(FALLIDO).length, 0, 'fallido/ vacío tras barrer');

  const requeued = fs.readdirSync(PENDIENTE).filter(f => f.endsWith('.json'));
  assert.equal(requeued.length, 3);
  const delays = requeued.map(name => {
    const d = JSON.parse(fs.readFileSync(path.join(PENDIENTE, name), 'utf8'));
    assert.equal(d._telegramAttempts, 0, 'presupuesto reseteado');
    assert.equal(d._error, undefined, 'limpia _error');
    return Date.parse(d._nextRetryAt);
  });
  // Escalonado: hay al menos 2 valores distintos de _nextRetryAt (no todos de golpe).
  assert.ok(new Set(delays).size >= 2, 'los reintentos están escalonados, no todos al mismo instante');
});

test('sweepFallidoOnce: descarta -cmd.json más viejos que stale_ttl_ms a listo/ (SEC-4)', () => {
  resetAll();
  const oc = loadOutboundConfig();
  const old = new Date(Date.now() - oc.stale_ttl_ms - 60000).toISOString();
  fs.writeFileSync(path.join(FALLIDO, 'stale-cmd.json'), JSON.stringify({ text: 'viejo', _failedAt: old }));
  const res = sweepFallidoOnce();
  assert.equal(res.discarded, 1);
  assert.equal(res.requeued, 0);
  const listo = fs.readdirSync(LISTO).filter(f => f.includes('stale-descartado'));
  assert.equal(listo.length, 1, 'el stale va a listo/ con marcador, no se reenvía');
});

// -----------------------------------------------------------------------------
// #5924 — el sweep deja de reciclar la cola (el amplificador real)
// -----------------------------------------------------------------------------

/** Escribe un fallido con evidencia COHERENTE de fallo permanente. */
function placePermanentFailure(name, extra = {}) {
  fs.writeFileSync(path.join(FALLIDO, name), JSON.stringify({
    text: 'aviso perdido',
    _telegramAttempts: 5,
    _telegramErrorCode: 400,
    _telegramPermanentFailure: true,
    _failedAt: new Date().toISOString(),
    ...extra,
  }, null, 2));
}

test('#5924 honorsPermanentFlag: sólo con evidencia coherente (SEC-C)', () => {
  const base = {
    _telegramPermanentFailure: true,
    _telegramAttempts: 5,
    _telegramErrorCode: 400,
    _failedAt: new Date().toISOString(),
  };
  assert.equal(honorsPermanentFlag(base), true);
  // Sin flag → nunca.
  assert.equal(honorsPermanentFlag({ ...base, _telegramPermanentFailure: undefined }), false);
  // Flag preseteado por un productor, sin evidencia de intento real.
  assert.equal(honorsPermanentFlag({ _telegramPermanentFailure: true }), false);
  assert.equal(honorsPermanentFlag({ ...base, _telegramAttempts: 0 }), false);
  assert.equal(honorsPermanentFlag({ ...base, _failedAt: 'no-es-fecha' }), false);
  assert.equal(honorsPermanentFlag({ ...base, _telegramErrorCode: 500 }), false, '5xx no es permanente');
  assert.equal(honorsPermanentFlag({ ...base, _telegramErrorCode: 'basura' }), false);
  assert.equal(honorsPermanentFlag(null), false);
});

test('#5924: sweepFallidoOnce NO reencola un fallo permanente validado', () => {
  resetAll();
  placePermanentFailure('perm-1.json');
  const res = sweepFallidoOnce();
  assert.equal(res.requeued, 0, 'no se reencola');
  assert.equal(res.permanent, 1);
  assert.equal(fs.readdirSync(PENDIENTE).length, 0, 'la cola de pendientes no se vuelve a llenar');
  const marcados = fs.readdirSync(LISTO).filter(f => f.includes('permanente-descartado'));
  assert.equal(marcados.length, 1, 'va a listo/ con marcador');
});

test('#5924: el flag y el _telegramErrorCode SOBREVIVEN al sweep', () => {
  resetAll();
  placePermanentFailure('perm-survive.json');
  sweepFallidoOnce();
  const dest = fs.readdirSync(LISTO).find(f => f.includes('permanente-descartado'));
  const d = JSON.parse(fs.readFileSync(path.join(LISTO, dest), 'utf8'));
  assert.equal(d._telegramPermanentFailure, true, 'el flag sobrevive');
  assert.equal(d._telegramErrorCode, 400, 'la causa acotada sobrevive');
});

test('#5924: DOS pasadas del sweep no reciclan ni alertan de nuevo (el amplificador)', () => {
  resetAll();
  // Simula el estado tras un fallo terminal real: el saliente queda en fallido/
  // con el flag. El servicio arranca (watchdog) y barre. Y arranca de nuevo.
  placePermanentFailure('perm-2pasadas.json');

  const p1 = sweepFallidoOnce();
  assert.equal(p1.requeued, 0);
  assert.equal(p1.permanent, 1);

  // 2ª pasada: fallido/ ya está vacío y nada volvió a pendiente/.
  const p2 = sweepFallidoOnce();
  assert.equal(p2.requeued, 0, 'la segunda pasada tampoco reencola');
  assert.equal(fs.readdirSync(FALLIDO).length, 0, 'fallido/ sigue en cero');
  assert.equal(fs.readdirSync(PENDIENTE).length, 0, 'pendiente/ sigue en cero');
  // Ninguna alerta nueva por ese saliente.
  assert.equal(listAlerts().length, 0);
});

test('#5924 SEC-C: flag sin evidencia coherente → se reencola (no es canal de supresión)', () => {
  resetAll();
  // Un productor cualquiera preseteó el flag sin haber intentado nada.
  fs.writeFileSync(path.join(FALLIDO, 'flag-falso.json'), JSON.stringify({
    text: 'aviso importante',
    _telegramPermanentFailure: true,
  }));
  const res = sweepFallidoOnce();
  assert.equal(res.requeued, 1, 'sin evidencia el flag se ignora y el saliente se reencola');
  assert.equal(res.permanent, 0);
  assert.ok(fs.existsSync(path.join(PENDIENTE, 'flag-falso.json')));
});

test('#5924: sin regresión del descarte stale de -cmd.json ni del reencolado normal', () => {
  resetAll();
  const oc = loadOutboundConfig();
  const old = new Date(Date.now() - oc.stale_ttl_ms - 60000).toISOString();
  fs.writeFileSync(path.join(FALLIDO, 'viejo-cmd.json'), JSON.stringify({ text: 'v', _failedAt: old }));
  fs.writeFileSync(path.join(FALLIDO, 'normal.json'), JSON.stringify({
    text: 'n', _failedAt: new Date().toISOString(), _telegramAttempts: 9,
  }));
  const res = sweepFallidoOnce();
  assert.equal(res.discarded, 1, 'el -cmd.json stale se sigue descartando');
  assert.equal(res.requeued, 1, 'el fallido sin causa permanente se sigue reencolando');
  assert.equal(res.permanent, 0);
});

test('loadOutboundConfig: defaults seguros sin config.yaml en el sandbox', () => {
  const oc = loadOutboundConfig();
  assert.equal(oc.max_retries, MAX_SEND_RETRIES);
  assert.ok(oc.backoff_base_ms > 0 && oc.backoff_max_ms >= oc.backoff_base_ms);
  assert.ok(oc.stale_ttl_ms > 0);
});
