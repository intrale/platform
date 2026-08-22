// =============================================================================
// process-liveness.test.js — Tests del helper de liveness + identidad (#4622).
// Reproduce los escenarios de seguridad: pid vivo/muerto, identidad por marca de
// creación, y reuso de PID (SEC-1). Todo con inyectables — CERO OS/shell real.
// =============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const liveness = require('../process-liveness');

test('isValidPid: rechaza no-enteros, negativos, cero, strings sucias', () => {
    assert.equal(liveness.isValidPid(1234), 1234);
    assert.equal(liveness.isValidPid('1234'), 1234);
    assert.equal(liveness.isValidPid(0), null);
    assert.equal(liveness.isValidPid(-5), null);
    assert.equal(liveness.isValidPid(3.14), null);
    assert.equal(liveness.isValidPid('5; rm -rf'), null);
    assert.equal(liveness.isValidPid(null), null);
    assert.equal(liveness.isValidPid(undefined), null);
});

test('isProcessAlive: pid válido y processCheck true → vivo', () => {
    assert.equal(liveness.isProcessAlive(4321, { processCheck: () => true }), true);
});

test('isProcessAlive: pid válido pero processCheck false → muerto', () => {
    assert.equal(liveness.isProcessAlive(4321, { processCheck: () => false }), false);
});

test('isProcessAlive: pid inválido → muerto sin llamar al OS', () => {
    let called = false;
    assert.equal(liveness.isProcessAlive('bad', { processCheck: () => { called = true; return true; } }), false);
    assert.equal(called, false);
});

test('isProcessAlive: posix killImpl que tira ESRCH → muerto', () => {
    const killImpl = () => { const e = new Error('no such'); e.code = 'ESRCH'; throw e; };
    assert.equal(liveness.isProcessAlive(999, { platform: 'linux', killImpl }), false);
});

test('isProcessAlive: posix killImpl que tira EPERM → vivo (proceso ajeno)', () => {
    const killImpl = () => { const e = new Error('perm'); e.code = 'EPERM'; throw e; };
    assert.equal(liveness.isProcessAlive(999, { platform: 'linux', killImpl }), true);
});

test('isProcessAlive: win32 tasklist con el pid en el CSV → vivo', () => {
    const spawnImpl = () => ({ stdout: '"claude.exe","1234","Console","1","50.000 K"\r\n' });
    assert.equal(liveness.isProcessAlive(1234, { platform: 'win32', spawnImpl }), true);
});

test('isProcessAlive: win32 tasklist sin match → muerto', () => {
    const spawnImpl = () => ({ stdout: 'INFO: No tasks are running which match the specified criteria.\r\n' });
    assert.equal(liveness.isProcessAlive(1234, { platform: 'win32', spawnImpl }), false);
});

test('getProcessStartTime: win32 wmic CreationDate → 14 dígitos', () => {
    const spawnImpl = () => ({ status: 0, stdout: '\r\r\nCreationDate=20260709224800.139030-180\r\r\n\r\r\n' });
    assert.equal(liveness.getProcessStartTime(1234, { platform: 'win32', spawnImpl }), '20260709224800');
});

test('getProcessStartTime: startTimeProbe inyectado tiene prioridad', () => {
    assert.equal(liveness.getProcessStartTime(1234, { startTimeProbe: () => 'CREATED-XYZ' }), 'CREATED-XYZ');
});

test('getProcessStartTime: pid inválido → null', () => {
    assert.equal(liveness.getProcessStartTime(0), null);
});

test('processIdentityMatches: sin token de identidad → null (no verificable)', () => {
    assert.equal(liveness.processIdentityMatches(1234, {}, { startTimeProbe: () => 'A' }), null);
});

test('processIdentityMatches: start-time recordado == actual → true', () => {
    const r = liveness.processIdentityMatches(1234, { startedAt: 'A' }, { startTimeProbe: () => 'A' });
    assert.equal(r, true);
});

test('SEC-1 · processIdentityMatches: start-time distinto (PID reuse) → false', () => {
    const r = liveness.processIdentityMatches(1234, { startedAt: 'A' }, { startTimeProbe: () => 'B' });
    assert.equal(r, false);
});

test('processIdentityMatches: pid vivo sin start-time legible → false (fail-safe)', () => {
    const r = liveness.processIdentityMatches(1234, { startedAt: 'A' }, { startTimeProbe: () => null });
    assert.equal(r, false);
});

test('processIdentityMatches: acepta alias pid_started_at', () => {
    const r = liveness.processIdentityMatches(1234, { pid_started_at: 'X' }, { startTimeProbe: () => 'X' });
    assert.equal(r, true);
});

// -----------------------------------------------------------------------------
// isAgentAlive — veredicto combinado (Gherkin A + SEC-1).
// -----------------------------------------------------------------------------
test('Gherkin A · isAgentAlive: pid inexistente pese a ts fresco → NO vivo', () => {
    const r = liveness.isAgentAlive(9999, { startedAt: 'A' }, { processCheck: () => false });
    assert.equal(r, false);
});

test('isAgentAlive: pid vivo + identidad matchea → vivo', () => {
    const r = liveness.isAgentAlive(1234, { startedAt: 'A' }, {
        processCheck: () => true, startTimeProbe: () => 'A',
    });
    assert.equal(r, true);
});

test('SEC-1 · isAgentAlive: pid vivo pero identidad NO matchea (reuse) → NO vivo', () => {
    const r = liveness.isAgentAlive(1234, { startedAt: 'A' }, {
        processCheck: () => true, startTimeProbe: () => 'B',
    });
    assert.equal(r, false);
});

test('isAgentAlive: latido legacy (sin token) + pid vivo → vivo por compat', () => {
    const r = liveness.isAgentAlive(1234, {}, { processCheck: () => true });
    assert.equal(r, true);
});

test('isAgentAlive: latido legacy + requireIdentity=true → NO vivo (fail-safe estricto)', () => {
    const r = liveness.isAgentAlive(1234, {}, { processCheck: () => true, requireIdentity: true });
    assert.equal(r, false);
});

// -----------------------------------------------------------------------------
// resolveHeartbeatOwner — Gherkin B (escritor huérfano #4622, CA-2).
// -----------------------------------------------------------------------------
test('Gherkin B · resolveHeartbeatOwner: pid dueño MUERTO y proceso actual muerto → null (no refresca)', () => {
    const owner = liveness.resolveHeartbeatOwner(22472, 9999, { processCheck: () => false });
    assert.equal(owner, null);
});

test('resolveHeartbeatOwner: pid dueño vivo → se refresca con él', () => {
    const owner = liveness.resolveHeartbeatOwner(1234, 5678, { processCheck: (p) => p === 1234 });
    assert.equal(owner, 1234);
});

test('resolveHeartbeatOwner: dueño muerto pero proceso actual vivo → cae al actual (sesión reanudada)', () => {
    const owner = liveness.resolveHeartbeatOwner(22472, 5678, { processCheck: (p) => p === 5678 });
    assert.equal(owner, 5678);
});

test('resolveHeartbeatOwner: sin pid grabado, proceso actual vivo → usa el actual', () => {
    const owner = liveness.resolveHeartbeatOwner(null, 5678, { processCheck: () => true });
    assert.equal(owner, 5678);
});
