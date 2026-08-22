// =============================================================================
// __tests__/spawn-failure-classifier.test.js — #4052 CA-1/CA-3/SEC-3.
//
// Cobertura del predicado puro fail-closed que distingue una muerte de
// spawn-failure del provider (infra) de un fallo legítimo del issue.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { classifySpawnFailure } = require('../spawn-failure-classifier');

test('clasifica exit code 127 como spawn-failure (command not found)', () => {
    const r = classifySpawnFailure({ exitCode: 127, durationMs: 30, firstByteAt: null });
    assert.equal(r.isSpawnFailure, true);
    assert.match(r.signature, /exit_code:127/);
});

test('clasifica child.on error ENOENT como spawn-failure', () => {
    const r = classifySpawnFailure({ errorCode: 'ENOENT', exitCode: null });
    assert.equal(r.isSpawnFailure, true);
    assert.match(r.signature, /ENOENT/);
});

test('clasifica EACCES (case-insensitive) como spawn-failure', () => {
    const r = classifySpawnFailure({ errorCode: 'eacces', exitCode: null });
    assert.equal(r.isSpawnFailure, true);
    assert.match(r.signature, /EACCES/);
});

test('clasifica exit antes del primer byte muy temprano como spawn-failure (con opt-in)', () => {
    const r = classifySpawnFailure({ exitCode: 1, durationMs: 120, firstByteAt: null, spawnInstrumented: true });
    assert.equal(r.isSpawnFailure, true);
    assert.match(r.signature, /early_exit/);
});

test('FAIL-CLOSED: firma 3 NO aplica sin spawnInstrumented (caller post-exit legacy)', () => {
    // Mismo input que el caso anterior pero SIN opt-in → no debe clasificar.
    const r = classifySpawnFailure({ exitCode: 1, durationMs: 120, firstByteAt: null });
    assert.equal(r.isSpawnFailure, false);
    assert.equal(r.signature, null);
});

test('FAIL-CLOSED: muerte ambigua con output presente NO es spawn-failure', () => {
    const r = classifySpawnFailure({ exitCode: 1, durationMs: 120, firstByteAt: Date.now(), spawnInstrumented: true });
    assert.equal(r.isSpawnFailure, false);
    assert.equal(r.signature, null);
});

test('FAIL-CLOSED: exit no-cero tardío sin firstByte NO es spawn-failure', () => {
    const r = classifySpawnFailure({ exitCode: 1, durationMs: 600000, firstByteAt: null, spawnInstrumented: true });
    assert.equal(r.isSpawnFailure, false);
});

test('FAIL-CLOSED: exit 0 nunca es spawn-failure', () => {
    const r = classifySpawnFailure({ exitCode: 0, durationMs: 10, firstByteAt: null });
    assert.equal(r.isSpawnFailure, false);
});

test('FAIL-CLOSED: contexto vacío NO es spawn-failure', () => {
    const r = classifySpawnFailure({});
    assert.equal(r.isSpawnFailure, false);
});
