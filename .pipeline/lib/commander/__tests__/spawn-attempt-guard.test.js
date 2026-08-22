// =============================================================================
// spawn-attempt-guard.test.js — Tests del guard síncrono del intento de spawn
// no-Anthropic del Commander (#4318).
//
// El guard es la unidad pura que captura la esencia del fix: si el cuerpo
// SÍNCRONO del intento de spawn lanza (Windows: launcher ENOENT / cmd inválido,
// sin `proc.on('error')`), NO propaga la excepción — la enruta a `onSyncThrow`
// para que el caller degrade vía advanceOrGiveUp (resolve canned, NUNCA reject).
//
// Cobertura de los escenarios Gherkin del issue (a nivel del seam testeable):
//   - CA-1/CA-4: throw síncrono → NO se propaga; se invoca el degradado con
//                reason 'spawn_throw'; el Promise del turno resolvería (canned).
//   - CA-1/CA-2: camino feliz → el guard devuelve el valor del intento sin
//                invocar el degradado (Codex se invoca de verdad, async).
//   - CA-3/SR-D: el degradado recibe el provider EFECTIVO del reemplazo para que
//                el caller lo use como atribución (no 'anthropic').
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const guard = require('../spawn-attempt-guard');

// ---------------------------------------------------------------------------
// CA-1 / CA-4 — Throw SÍNCRONO del intento: NO se propaga, se degrada.
// ---------------------------------------------------------------------------
test('CA-1/CA-4 — attempt lanza síncrono → onSyncThrow, NO rethrow', () => {
  const calls = [];
  const boom = new Error('spawn openai-codex ENOENT');

  // El guard NO debe propagar: si lo hiciera, este assert.doesNotThrow falla.
  let ret;
  assert.doesNotThrow(() => {
    ret = guard.runGuardedSpawnAttempt({
      provider: 'openai-codex',
      attempt: () => { throw boom; },
      onSyncThrow: (provider, reason, err) => {
        calls.push({ provider, reason, err });
        return 'CANNED_DEGRADED'; // simula el retorno de advanceOrGiveUp (resolve)
      },
    });
  });

  // El valor de retorno es el del degradado (el caller lo propaga como resolve).
  assert.equal(ret, 'CANNED_DEGRADED');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].provider, 'openai-codex');
  assert.equal(calls[0].reason, 'spawn_throw'); // reason por defecto
  assert.equal(calls[0].err, boom); // la causa real llega al caller (para audit)
});

// ---------------------------------------------------------------------------
// CA-1 / CA-2 — Camino feliz: el intento no lanza → se invoca de verdad y su
// valor de retorno se propaga; el degradado NUNCA se llama.
// ---------------------------------------------------------------------------
test('CA-1/CA-2 — attempt no lanza → devuelve su valor, sin degradado', () => {
  let degraded = false;
  let attemptRan = false;

  const ret = guard.runGuardedSpawnAttempt({
    provider: 'openai-codex',
    attempt: () => { attemptRan = true; return 'ATTEMPT_RESULT'; },
    onSyncThrow: () => { degraded = true; return 'SHOULD_NOT_HAPPEN'; },
  });

  assert.equal(attemptRan, true);
  assert.equal(ret, 'ATTEMPT_RESULT');
  assert.equal(degraded, false);
});

// ---------------------------------------------------------------------------
// CA-3 / SR-D — La razón del degradado es configurable y se propaga tal cual al
// degradado (para que el caller la use como errorCode del audit / atribución).
// ---------------------------------------------------------------------------
test('CA-3/SR-D — reason custom se propaga al degradado', () => {
  let seenReason = null;
  guard.runGuardedSpawnAttempt({
    provider: 'gemini-google',
    reason: 'custom_reason',
    attempt: () => { throw new Error('x'); },
    onSyncThrow: (_p, reason) => { seenReason = reason; },
  });
  assert.equal(seenReason, 'custom_reason');
});

test('CA-3/SR-D — reason por defecto es DEFAULT_SYNC_THROW_REASON', () => {
  assert.equal(guard.DEFAULT_SYNC_THROW_REASON, 'spawn_throw');
});

// ---------------------------------------------------------------------------
// Robustez — el degradado también puede lanzar como último recurso; el guard NO
// lo enmascara (es responsabilidad del caller que advanceOrGiveUp no lance). El
// comportamiento esperado es que se propague ese error del degradado (no el del
// attempt), documentando el contrato.
// ---------------------------------------------------------------------------
test('Robustez — si onSyncThrow lanza, se propaga su error (no el del attempt)', () => {
  const degradeErr = new Error('advanceOrGiveUp roto');
  assert.throws(
    () => guard.runGuardedSpawnAttempt({
      provider: 'openai-codex',
      attempt: () => { throw new Error('attempt error'); },
      onSyncThrow: () => { throw degradeErr; },
    }),
    /advanceOrGiveUp roto/,
  );
});

// ---------------------------------------------------------------------------
// Contrato de tipos — argumentos inválidos fallan rápido (fail-fast) para no
// enmascarar un cableado incorrecto del caller.
// ---------------------------------------------------------------------------
test('Contrato — attempt no-función lanza TypeError', () => {
  assert.throws(
    () => guard.runGuardedSpawnAttempt({ provider: 'x', attempt: null, onSyncThrow: () => {} }),
    /TypeError|attempt/,
  );
});

test('Contrato — onSyncThrow no-función lanza TypeError', () => {
  assert.throws(
    () => guard.runGuardedSpawnAttempt({ provider: 'x', attempt: () => {}, onSyncThrow: 'nope' }),
    /TypeError|onSyncThrow/,
  );
});

test('Contrato — args ausente lanza TypeError (no crash silencioso)', () => {
  assert.throws(() => guard.runGuardedSpawnAttempt(), /TypeError/);
});
