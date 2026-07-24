// =============================================================================
// Tests `lib/sherlock/request-log.js` (#4335)
//
// Cubre:
//   - buildRequestId sanea con ID_SAFE_RE (SEC-4) y aplica sufijo.
//   - logFileName produce `sherlock-<reqId>.log` saneado.
//   - openRequestLog escribe SÓLO vía el writer sanitizado (SEC-1): un secret
//     inyectado sale redactado del `.log`.
//   - grep estático: el módulo NO usa `appendFileSync` crudo.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const reqLog = require('../request-log');

test('SEC-4: buildRequestId elimina caracteres fuera de [a-zA-Z0-9-]', () => {
    const id = reqLog.buildRequestId('abc/../123 xyz', 'sher lock');
    assert.match(id, /^[a-zA-Z0-9-]+$/);
    // el '/', '.', espacio se eliminan (no se sustituyen)
    assert.equal(id, 'abc123xyz-sherlock');
});

test('buildRequestId tolera null y cae a "unknown"', () => {
    assert.equal(reqLog.buildRequestId(null), 'unknown');
    assert.equal(reqLog.buildRequestId(undefined, 'sherlock'), 'unknown-sherlock');
});

test('logFileName produce sherlock-<reqId>.log saneado', () => {
    assert.equal(reqLog.logFileName('123-sherlock'), 'sherlock-123-sherlock.log');
    assert.equal(reqLog.logFileName('a/b.c'), 'sherlock-abc.log');
});

test('SEC-1: openRequestLog escribe vía writer sanitizado y redacta secrets', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sherlock-reqlog-'));
    const reqId = reqLog.buildRequestId('999', 'sherlock');
    const rl = reqLog.openRequestLog(dir, reqId, { silentFs: true });

    // un AWS access key falso (patrón que el sanitizer redacta)
    rl.stage('provider', { iso: '2026-07-01T00:00:00.000Z', sherlock_provider: 'gemini' });
    rl.line('AKIAIOSFODNN7EXAMPLE es una key que no debe salir en claro');
    await rl.close();

    const content = fs.readFileSync(rl.path, 'utf8');
    assert.ok(content.includes('etapa:provider'), 'debe registrar la etapa');
    assert.ok(content.includes('gemini'), 'debe registrar meta no sensible');
    assert.ok(!content.includes('AKIAIOSFODNN7EXAMPLE'), 'el AWS key debe salir redactado');
});

test('grep estático: el módulo NO usa appendFileSync crudo', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'request-log.js'), 'utf8');
    // Detecta la LLAMADA cruda (con `(`), no la mención en comentarios de seguridad.
    assert.equal(/\.appendFileSync\s*\(/.test(src), false, 'no debe haber llamada appendFileSync cruda');
    assert.ok(/createLogFileWriter/.test(src), 'debe usar createLogFileWriter (SEC-1)');
});
