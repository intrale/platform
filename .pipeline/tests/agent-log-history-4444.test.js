// =============================================================================
// agent-log-history-4444.test.js — Tests de la persistencia de logs de agente
// por intento y su consulta (#4444).
//
// Cubre:
//   - deriveAttemptNumber: base=1, y max(rebote_numero, _infra, _crossphase)+1.
//   - naming (attemptLogName / aliasLogName).
//   - Persistencia por intento NO trunca: dado attempt-1 existente, una
//     re-ejecución con rebote_numero=1 crea attempt-2 y conserva attempt-1.
//   - listAttempts: deriva del glob de LOG_DIR, ordena ascendente, y NO matchea
//     nombres con path-traversal (regex escapado — REQ-SEC-1).
//   - listExecutions: fallback al alias para issues legacy (sin attempt-N).
//   - resolveRetentionConfig: defaults + overrides.
//   - pruneAttempts: respeta max_attempts_per_agent y TTL, nunca borra el vigente.
//   - readLogCapped: capea bytes servidos con marcador (REQ-SEC-4).
//   - Redacción defensa-en-profundidad: un secret persistido vía
//     createLogFileWriter queda redactado en disco (REQ-SEC-2).
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const H = require('../lib/agent-log-history');
const { createLogFileWriter } = require('../lib/sanitize-log-stream');

function mkTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'loghist-'));
}
function touch(dir, name, content = 'x') {
  fs.writeFileSync(path.join(dir, name), content);
}

// -----------------------------------------------------------------------------
// deriveAttemptNumber
// -----------------------------------------------------------------------------
test('deriveAttemptNumber devuelve 1 sin contadores de rebote', () => {
  assert.equal(H.deriveAttemptNumber(null), 1);
  assert.equal(H.deriveAttemptNumber(undefined), 1);
  assert.equal(H.deriveAttemptNumber({}), 1);
  assert.equal(H.deriveAttemptNumber({ rebote_numero: 0 }), 1);
});

test('deriveAttemptNumber toma el máximo de los tres contadores + 1', () => {
  assert.equal(H.deriveAttemptNumber({ rebote_numero: 1 }), 2);
  assert.equal(H.deriveAttemptNumber({ rebote_numero_infra: 3 }), 4);
  assert.equal(H.deriveAttemptNumber({ rebote_numero_crossphase: 2 }), 3);
  assert.equal(
    H.deriveAttemptNumber({ rebote_numero: 1, rebote_numero_infra: 4, rebote_numero_crossphase: 2 }),
    5,
  );
});

test('deriveAttemptNumber ignora valores no numéricos (defensa)', () => {
  assert.equal(H.deriveAttemptNumber({ rebote_numero: 'x', rebote_numero_infra: null }), 1);
});

// -----------------------------------------------------------------------------
// naming
// -----------------------------------------------------------------------------
test('attemptLogName / aliasLogName generan el naming esperado', () => {
  assert.equal(H.attemptLogName(4444, 'pipeline-dev', 2), '4444-pipeline-dev.attempt-2.log');
  assert.equal(H.aliasLogName(4444, 'pipeline-dev'), '4444-pipeline-dev.log');
});

// -----------------------------------------------------------------------------
// Persistencia por intento NO trunca (CA-F1)
// -----------------------------------------------------------------------------
test('una re-ejecución con rebote_numero=1 crea attempt-2 y conserva attempt-1', () => {
  const dir = mkTmp();
  const issue = 4444;
  const skill = 'pipeline-dev';

  // Intento 1 (sin rebotes).
  const a1 = H.deriveAttemptNumber({});
  assert.equal(a1, 1);
  const f1 = path.join(dir, H.attemptLogName(issue, skill, a1));
  fs.writeFileSync(f1, 'contenido intento 1');

  // Re-ejecución tras rebote (rebote_numero=1) → intento 2.
  const a2 = H.deriveAttemptNumber({ rebote_numero: 1 });
  assert.equal(a2, 2);
  const f2 = path.join(dir, H.attemptLogName(issue, skill, a2));
  fs.writeFileSync(f2, 'contenido intento 2');

  // attempt-1 NO fue truncado ni sobrescrito.
  assert.equal(fs.readFileSync(f1, 'utf8'), 'contenido intento 1');
  assert.equal(fs.readFileSync(f2, 'utf8'), 'contenido intento 2');

  // El listado ve los dos intentos, ordenados.
  const attempts = H.listAttempts(dir, issue, skill);
  assert.deepEqual(attempts.map((a) => a.intento), [1, 2]);
});

// -----------------------------------------------------------------------------
// listAttempts — glob, orden, y seguridad (REQ-SEC-1)
// -----------------------------------------------------------------------------
test('listAttempts deriva del glob y ordena ascendente por intento', () => {
  const dir = mkTmp();
  touch(dir, '10-guru.attempt-3.log');
  touch(dir, '10-guru.attempt-1.log');
  touch(dir, '10-guru.attempt-2.log');
  touch(dir, '10-guru.log'); // alias, no debe contarse como intento
  touch(dir, '11-guru.attempt-1.log'); // otro issue, no debe mezclarse
  touch(dir, '10-security.attempt-1.log'); // otro skill, no debe mezclarse

  const items = H.listAttempts(dir, 10, 'guru');
  assert.deepEqual(items.map((i) => i.intento), [1, 2, 3]);
  assert.ok(items.every((i) => /^10-guru\.attempt-\d+\.log$/.test(i.file)));
  assert.ok(items.every((i) => typeof i.bytes === 'number' && typeof i.mtime === 'number'));
});

test('listAttempts con skill malicioso (path traversal) no escapa del glob', () => {
  const dir = mkTmp();
  touch(dir, '10-guru.attempt-1.log');
  // Un skill con metacaracteres/patrones de traversal no debe matchear nada:
  assert.deepEqual(H.listAttempts(dir, 10, '../etc/passwd'), []);
  assert.deepEqual(H.listAttempts(dir, 10, '.*'), []);
  assert.deepEqual(H.listAttempts(dir, '..', 'guru'), []);
});

test('listAttempts devuelve [] si el directorio no existe', () => {
  assert.deepEqual(H.listAttempts(path.join(os.tmpdir(), 'no-existe-loghist-xyz'), 1, 'guru'), []);
});

// -----------------------------------------------------------------------------
// listExecutions — fallback legacy al alias (CA-F6)
// -----------------------------------------------------------------------------
test('listExecutions cae al alias legacy cuando no hay archivos attempt-N', () => {
  const dir = mkTmp();
  touch(dir, '99-backend-dev.log', 'log legacy sin per-intento');
  const items = H.listExecutions(dir, 99, 'backend-dev');
  assert.equal(items.length, 1);
  assert.equal(items[0].intento, 1);
  assert.equal(items[0].file, '99-backend-dev.log');
  assert.equal(items[0].legacy, true);
});

test('listExecutions prefiere los attempt-N sobre el alias cuando existen', () => {
  const dir = mkTmp();
  touch(dir, '99-backend-dev.log');
  touch(dir, '99-backend-dev.attempt-1.log');
  touch(dir, '99-backend-dev.attempt-2.log');
  const items = H.listExecutions(dir, 99, 'backend-dev');
  assert.deepEqual(items.map((i) => i.intento), [1, 2]);
  assert.ok(items.every((i) => !i.legacy));
});

test('listExecutions devuelve [] cuando no hay ni attempt-N ni alias', () => {
  const dir = mkTmp();
  assert.deepEqual(H.listExecutions(dir, 1234, 'guru'), []);
});

// -----------------------------------------------------------------------------
// resolveRetentionConfig
// -----------------------------------------------------------------------------
test('resolveRetentionConfig aplica defaults conservadores', () => {
  const c = H.resolveRetentionConfig(undefined);
  assert.equal(c.enabled, true);
  assert.equal(c.max_attempts_per_agent, 20);
  assert.equal(c.max_bytes_per_log, 5 * 1024 * 1024);
  assert.equal(c.retention_days, 30);
});

test('resolveRetentionConfig respeta overrides y enabled:false', () => {
  const c = H.resolveRetentionConfig({ enabled: false, max_attempts_per_agent: 3, max_bytes_per_log: 100, retention_days: 7 });
  assert.equal(c.enabled, false);
  assert.equal(c.max_attempts_per_agent, 3);
  assert.equal(c.max_bytes_per_log, 100);
  assert.equal(c.retention_days, 7);
});

// -----------------------------------------------------------------------------
// pruneAttempts — retención acotada (REQ-SEC-4), nunca el vigente
// -----------------------------------------------------------------------------
test('pruneAttempts poda por overflow de cantidad y conserva el vigente', () => {
  const dir = mkTmp();
  for (let n = 1; n <= 5; n++) touch(dir, `7-guru.attempt-${n}.log`);
  const removed = H.pruneAttempts(dir, 7, 'guru', { max_attempts_per_agent: 2, retention_days: 0 });
  // 5 intentos, tope 2 → se borran los 3 más viejos (1,2,3), quedan 4 y 5.
  assert.equal(removed.length, 3);
  const rest = H.listAttempts(dir, 7, 'guru').map((i) => i.intento);
  assert.deepEqual(rest, [4, 5]);
  // El vigente (5) sigue presente.
  assert.ok(fs.existsSync(path.join(dir, '7-guru.attempt-5.log')));
});

test('pruneAttempts con TTL borra intentos viejos pero nunca el vigente', () => {
  const dir = mkTmp();
  touch(dir, '8-guru.attempt-1.log');
  touch(dir, '8-guru.attempt-2.log');
  const now = 10_000_000_000; // referencia fija
  const old = now - 40 * 24 * 60 * 60 * 1000; // 40 días atrás
  fs.utimesSync(path.join(dir, '8-guru.attempt-1.log'), new Date(old), new Date(old));
  fs.utimesSync(path.join(dir, '8-guru.attempt-2.log'), new Date(old), new Date(old));
  const removed = H.pruneAttempts(dir, 8, 'guru', { max_attempts_per_agent: 100, retention_days: 30 }, now);
  // attempt-1 viejo se borra; attempt-2 (vigente) se conserva aunque también sea viejo.
  assert.deepEqual(removed, ['8-guru.attempt-1.log']);
  assert.ok(fs.existsSync(path.join(dir, '8-guru.attempt-2.log')));
});

test('pruneAttempts no borra nada con enabled:false', () => {
  const dir = mkTmp();
  for (let n = 1; n <= 5; n++) touch(dir, `9-guru.attempt-${n}.log`);
  const removed = H.pruneAttempts(dir, 9, 'guru', { enabled: false, max_attempts_per_agent: 1 });
  assert.deepEqual(removed, []);
  assert.equal(H.listAttempts(dir, 9, 'guru').length, 5);
});

// -----------------------------------------------------------------------------
// readLogCapped — tope de bytes por request (REQ-SEC-4)
// -----------------------------------------------------------------------------
test('readLogCapped devuelve el archivo completo si está bajo el tope', () => {
  const dir = mkTmp();
  const p = path.join(dir, 'chico.log');
  fs.writeFileSync(p, 'hola mundo');
  const r = H.readLogCapped(p, 1024);
  assert.equal(r.truncated, false);
  assert.equal(r.text, 'hola mundo');
  assert.equal(r.totalBytes, 10);
});

test('readLogCapped capea la cola y antepone un marcador cuando excede el tope', () => {
  const dir = mkTmp();
  const p = path.join(dir, 'grande.log');
  // 1000 bytes de 'A' seguidos de 'FIN'.
  fs.writeFileSync(p, 'A'.repeat(1000) + 'FIN');
  const r = H.readLogCapped(p, 100);
  assert.equal(r.truncated, true);
  assert.equal(r.totalBytes, 1003);
  assert.match(r.text, /log recortado/);
  // Debe contener la cola (FIN), no el principio.
  assert.match(r.text, /FIN$/);
});

// -----------------------------------------------------------------------------
// Redacción defensa-en-profundidad al persistir (REQ-SEC-2)
// -----------------------------------------------------------------------------
test('un secret persistido vía createLogFileWriter queda redactado en disco', async () => {
  const dir = mkTmp();
  const p = path.join(dir, '4444-pipeline-dev.attempt-1.log');
  const writer = createLogFileWriter(p, { silentFs: true });
  writer.writable.write('token ghp_1234567890abcdefABCDEF1234567890abcdef fin\n');
  await writer.close();
  const onDisk = fs.readFileSync(p, 'utf8');
  assert.doesNotMatch(onDisk, /ghp_1234567890abcdefABCDEF1234567890abcdef/);
  assert.match(onDisk, /REDACTED/);
});
