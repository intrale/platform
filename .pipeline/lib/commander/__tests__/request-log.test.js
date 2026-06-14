// =============================================================================
// request-log.test.js — Cobertura del helper de log por petición del Commander
// (#3949 / EP7-H2).
//
// Estructura:
//   T-1  buildRequestId → string filename-safe `^[a-zA-Z0-9-]+$` (incl. chat_id
//        negativo de grupos Telegram) + sufijo + sin colisión entre ms distintos.
//   T-2  redacción efectiva: un secreto inyectado en una etapa NO aparece en el
//        archivo (la escritura hereda el stream sanitizado — SEC-1/SEC-2).
//   T-3  las 4 cabeceras de etapa (transcripción / dispatch / Sherlock / envío)
//        están presentes y en orden.
//   T-4  close() cierra el fd sin error (idempotencia del flush).
//   T-5  logFileName produce `commander-<id>.log`.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const mod = require('../request-log');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'reqlog-'));
}

// --- T-1 ---------------------------------------------------------------------
test('buildRequestId produce un id filename-safe (^[a-zA-Z0-9-]+$)', () => {
  const id = mod.buildRequestId(123456, 1718000000000);
  assert.match(id, /^[a-zA-Z0-9-]+$/);
  assert.equal(id, '123456-1718000000000');
});

test('buildRequestId acepta chat_id negativo (grupos Telegram) sin deformarlo', () => {
  const id = mod.buildRequestId(-1001234567890, 1718000000000);
  assert.match(id, /^[a-zA-Z0-9-]+$/);
  assert.equal(id, '-1001234567890-1718000000000');
});

test('buildRequestId elimina caracteres no permitidos (`:`, `/`, espacios)', () => {
  const id = mod.buildRequestId('ab:cd/ef gh', 1718000000000);
  assert.match(id, /^[a-zA-Z0-9-]+$/);
  assert.equal(id, 'abcdefgh-1718000000000');
});

test('buildRequestId con sufijo (turnId) rompe empate sin perder safety', () => {
  const a = mod.buildRequestId(-100, 1718000000000, 'a1b2c3d4');
  const b = mod.buildRequestId(-100, 1718000000000, 'deadbeef');
  assert.match(a, /^[a-zA-Z0-9-]+$/);
  assert.notEqual(a, b);
  assert.equal(a, '-100-1718000000000-a1b2c3d4');
});

test('buildRequestId distintos ms → ids distintos (anti-colisión)', () => {
  const a = mod.buildRequestId(-100, 1718000000000);
  const b = mod.buildRequestId(-100, 1718000000001);
  assert.notEqual(a, b);
});

test('buildRequestId tolera chatId/nowMs nulos sin romper', () => {
  const id = mod.buildRequestId(null, null);
  assert.match(id, /^[a-zA-Z0-9-]+$/);
  assert.equal(id, 'unknown-0');
});

// --- T-5 ---------------------------------------------------------------------
test('logFileName produce commander-<id>.log', () => {
  assert.equal(mod.logFileName('-100-1718000000000'), 'commander--100-1718000000000.log');
});

// --- T-2 ---------------------------------------------------------------------
test('un secreto inyectado en una etapa NO aparece en texto plano (redacción)', async () => {
  const dir = tmpDir();
  const reqId = mod.buildRequestId(-100, 1718000000001);
  const rl = mod.openRequestLog(dir, reqId, { silentFs: true });

  // Secretos representativos cubiertos por el sanitizer (JWT / password=).
  const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
  rl.stage('transcripción', { audios: 1 });
  rl.line(`texto: Authorization: Bearer ${jwt}`);
  rl.line('texto: mi password=supersecreto123 va acá');
  rl.stage('envío', { chars: 10 });
  await rl.close();

  const content = fs.readFileSync(rl.path, 'utf8');
  assert.ok(!content.includes(jwt), 'el JWT no debe aparecer en plano');
  assert.ok(!content.includes('supersecreto123'), 'el password no debe aparecer en plano');
  assert.match(content, /REDACTED/, 'debe haber al menos un placeholder de redacción');
});

// --- T-3 ---------------------------------------------------------------------
test('las 4 cabeceras de etapa están presentes y en orden', async () => {
  const dir = tmpDir();
  const reqId = mod.buildRequestId(42, 1718000000002);
  const rl = mod.openRequestLog(dir, reqId, { silentFs: true });

  rl.stage('transcripción', { audios: 0 });
  rl.line('texto: hola');
  rl.stage('dispatch', { intent_class: 'llm', provider: 'anthropic', model: 'claude-cli' });
  rl.stage('Sherlock', { veredicto: 'ok', provider: 'anthropic-haiku', duration_ms: 1234 });
  rl.stage('envío', { canal: 'texto', chars: 4 });
  await rl.close();

  const content = fs.readFileSync(rl.path, 'utf8');
  const idxTrans = content.indexOf('etapa:transcripción');
  const idxDisp = content.indexOf('etapa:dispatch');
  const idxSher = content.indexOf('etapa:Sherlock');
  const idxEnv = content.indexOf('etapa:envío');

  assert.ok(idxTrans >= 0, 'falta etapa transcripción');
  assert.ok(idxDisp >= 0, 'falta etapa dispatch');
  assert.ok(idxSher >= 0, 'falta etapa Sherlock');
  assert.ok(idxEnv >= 0, 'falta etapa envío');
  assert.ok(idxTrans < idxDisp && idxDisp < idxSher && idxSher < idxEnv, 'las etapas deben estar en orden');

  // El req:<id> debe aparecer en cada cabecera.
  assert.match(content, new RegExp(`req:${reqId}`));
  // La metadata de dispatch debe estar presente (SEC-3: solo strings).
  assert.match(content, /provider: anthropic/);
  assert.match(content, /veredicto: ok/);
});

// --- T-4 ---------------------------------------------------------------------
test('close() cierra el writer sin error y es seguro de awaitear', async () => {
  const dir = tmpDir();
  const reqId = mod.buildRequestId(7, 1718000000003);
  const rl = mod.openRequestLog(dir, reqId, { silentFs: true });
  rl.stage('transcripción', {});
  rl.line('contenido');
  await assert.doesNotReject(() => rl.close());
  assert.ok(fs.existsSync(rl.path), 'el archivo debe existir tras close()');
});

test('openRequestLog expone path/fileName/reqId correctos', () => {
  const dir = tmpDir();
  const reqId = mod.buildRequestId(-1, 1718000000004);
  const rl = mod.openRequestLog(dir, reqId, { silentFs: true });
  assert.equal(rl.reqId, reqId);
  assert.equal(rl.fileName, `commander-${reqId}.log`);
  assert.equal(rl.path, path.join(dir, `commander-${reqId}.log`));
  return rl.close();
});
