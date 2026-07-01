// =============================================================================
// Tests sherlock/request-log.js (#4335) — writer por corrida de Sherlock.
//
// Cubre:
//   - buildRequestId sanea con ID_SAFE_RE (SEC-4): sin traversal ni caracteres
//     que rompan la whitelist del viewer.
//   - logFileName produce `sherlock-<id>.log`.
//   - openRequestLog escribe vía el stream sanitizado (SEC-1): un secret
//     inyectado sale REDACTADO del `.log`.
//   - grep estático: el módulo NO usa `appendFileSync` crudo.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const requestLog = require('../request-log');

test('buildRequestId: sanea caracteres fuera de [a-zA-Z0-9-] (SEC-4)', () => {
    const id = requestLog.buildRequestId('../../etc/passwd', 'sherlock');
    assert.match(id, /^[a-zA-Z0-9-]+$/, 'el id no debe contener separadores de path');
    assert.ok(!id.includes('/') && !id.includes('.'), 'sin / ni . (anti-traversal)');
    assert.ok(id.endsWith('-sherlock'), 'preserva el sufijo saneado');
});

test('buildRequestId: reqId nulo cae a "unknown"', () => {
    assert.equal(requestLog.buildRequestId(null), 'unknown');
    assert.equal(requestLog.buildRequestId(undefined, 'sherlock'), 'unknown-sherlock');
});

test('buildRequestId: preserva el guion del chat_id negativo del turno', () => {
    const id = requestLog.buildRequestId('-100123-1699999999999', 'sherlock');
    assert.equal(id, '-100123-1699999999999-sherlock');
});

test('logFileName: formato sherlock-<id>.log y saneo del id', () => {
    assert.equal(requestLog.logFileName('abc-123'), 'sherlock-abc-123.log');
    assert.equal(requestLog.logFileName('a/b.c'), 'sherlock-abc.log');
});

test('openRequestLog: escribe vía stream sanitizado — secret sale REDACTADO (SEC-1)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sherlock-reqlog-'));
    const reqId = requestLog.buildRequestId('42-1699999999999', 'sherlock');
    const rl = requestLog.openRequestLog(dir, reqId, { silentFs: true });

    rl.stage('provider-resuelto', { provider: 'anthropic', model: 'claude' });
    // Un token con formato de AWS access key debe ser redactado por el sanitizer.
    rl.line('AKIAIOSFODNN7EXAMPLE es una key que NO debe quedar cruda');
    rl.stage('veredicto', { verdict: 'ok', inconsistencias: 0 });
    await rl.close();

    const content = fs.readFileSync(rl.path, 'utf8');
    assert.ok(content.includes('etapa:provider-resuelto'), 'cabecera de etapa presente');
    assert.ok(content.includes('provider: anthropic'), 'meta serializada como string');
    assert.ok(content.includes('etapa:veredicto'), 'segunda etapa presente');
    assert.ok(!content.includes('AKIAIOSFODNN7EXAMPLE'), 'el secret NO debe aparecer crudo (SEC-1)');

    fs.rmSync(dir, { recursive: true, force: true });
});

test('SEC-1 estático: el módulo NO usa appendFileSync crudo', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'request-log.js'), 'utf8');
    // Buscamos una LLAMADA real (`appendFileSync(`), no la mención en el comentario
    // de doc de SEC-1 que explica justamente por qué está prohibida.
    assert.ok(!/appendFileSync\s*\(/.test(src), 'prohibido fs.appendFileSync (saltearía la redacción)');
    assert.ok(/createLogFileWriter/.test(src), 'debe escribir vía createLogFileWriter');
});
