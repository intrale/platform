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
} = svc;
const telegramReceipt = require('../telegram-receipt');

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

test('fallo terminal tras MAX_SEND_RETRIES: mueve a fallido/ y SIEMPRE notifica (CA-3)', () => {
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
  // CA-3: emitió exactamente una alerta a Telegram.
  const alerts = listAlerts();
  assert.equal(alerts.length, 1, 'debe emitir una alerta de fallo');
  assert.match(readAlert(alerts[0]).text, /Fallo terminal al enviar/);
});

test('RS-3: el mensaje de la alerta va redactado (nunca el secreto crudo)', () => {
  resetQueues();
  const file = placeWorkingFile('drop-secret.json', {
    photo: '/tmp/x.png',
    _telegramAttempts: MAX_SEND_RETRIES - 1,
  });
  const trabajandoPath = path.join(TRABAJANDO, file.name);

  const secret = 'AKIAIOSFODNN7EXAMPLE';
  handleSendFailure(file, trabajandoPath, new Error(`subida rechazada, creds ${secret} expuestas`));

  const alerts = listAlerts();
  assert.equal(alerts.length, 1);
  const text = readAlert(alerts[0]).text;
  assert.ok(!text.includes(secret), 'el secreto NO debe aparecer en la alerta');
  assert.match(text, /\[REDACTED\]/, 'el secreto debe quedar redactado');
});

test('archivo malformado: fallo terminal inmediato (no loop infinito) + notifica', () => {
  resetQueues();
  const name = 'drop-malformado.json';
  fs.writeFileSync(path.join(TRABAJANDO, name), '{ esto no es JSON valido');
  const file = { name, path: path.join(PENDIENTE, name) };
  const trabajandoPath = path.join(TRABAJANDO, name);

  const verdict = handleSendFailure(file, trabajandoPath, new Error('parse upstream'));

  assert.equal(verdict, 'failed');
  assert.ok(fs.existsSync(path.join(FALLIDO, name)), 'un archivo ilegible va directo a fallido/');
  assert.equal(listAlerts().length, 1, 'también notifica');
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

test('loadOutboundConfig: defaults seguros sin config.yaml en el sandbox', () => {
  const oc = loadOutboundConfig();
  assert.equal(oc.max_retries, MAX_SEND_RETRIES);
  assert.ok(oc.backoff_base_ms > 0 && oc.backoff_max_ms >= oc.backoff_base_ms);
  assert.ok(oc.stale_ttl_ms > 0);
});
