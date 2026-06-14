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

const svc = require('../../servicio-telegram');
const { handleSendFailure, notifyTelegramFailure, MAX_SEND_RETRIES } = svc;

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
