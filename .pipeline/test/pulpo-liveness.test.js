#!/usr/bin/env node
// =============================================================================
// pulpo-liveness.test.js — Tests del liveness del Pulpo (#4154).
//
// Cubre la decisión (lib/pulpo-liveness.js) y el parser defensivo al 100% de
// ramas:
//   - heartbeat reciente (lag < umbral)             => skip (CA-4, sin falso positivo).
//   - heartbeat vencido + pid cruza con SO          => kill-respawn (CA-2/CA-3).
//   - heartbeat vencido + pid NO cruza / inválido / ausente => skip-log-discrepancy (SEC-1/CA-3.1).
//   - last-tick.json malformado / pid no numérico o negativo => fail-closed (SEC-2/CA-6).
//   - umbral inválido por env => default, nunca "nunca stale" (SEC-2).
//   - sin heartbeat => skip (no inventar kill).
//   - runner end-to-end por env => ACTION:kill-respawn | ACTION:skip.
//
// Ejecución: node --test .pipeline/test/pulpo-liveness.test.js
// Framework: node:test + node:assert (cero deps externas).
// =============================================================================

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const liveness = require('../lib/pulpo-liveness');

const SEC = 1000;
const KILL_MS = 90 * SEC; // umbral default

function baseFacts(over = {}) {
  return Object.assign(
    {
      hbExists: true,
      hbAgeMs: 5 * SEC, // fresco
      hbPidFromContent: 12345,
      soPid: 12345,
      killThresholdMs: KILL_MS,
    },
    over
  );
}

// --- parseKillSeconds (SEC-2) -----------------------------------------------

test('parseKillSeconds — entero positivo válido se respeta', () => {
  assert.strictEqual(liveness.parseKillSeconds('120'), 120);
  assert.strictEqual(liveness.parseKillSeconds(45), 45);
});

test('parseKillSeconds — inválido cae a default, NUNCA a "nunca stale" (SEC-2)', () => {
  for (const bad of ['', 'abc', '-5', '0', '3.5', null, undefined, NaN, {}, '  ', '12x']) {
    assert.strictEqual(
      liveness.parseKillSeconds(bad),
      liveness.DEFAULT_KILL_SECONDS,
      `valor inválido ${JSON.stringify(bad)} debe caer al default`
    );
  }
});

test('parseKillSeconds — fallback inválido se ignora y usa el default seguro', () => {
  assert.strictEqual(liveness.parseKillSeconds('nope', -1), liveness.DEFAULT_KILL_SECONDS);
  assert.strictEqual(liveness.parseKillSeconds('nope', 0), liveness.DEFAULT_KILL_SECONDS);
  assert.strictEqual(liveness.parseKillSeconds('nope', 30), 30);
});

// --- parseHeartbeatPid (SEC-2 / CA-6) ---------------------------------------

test('parseHeartbeatPid — extrae pid entero positivo de JSON válido', () => {
  assert.strictEqual(liveness.parseHeartbeatPid('{"pid":999,"timestamp":"x"}'), 999);
  assert.strictEqual(liveness.parseHeartbeatPid({ pid: 7, timestamp: 'x' }), 7);
});

test('parseHeartbeatPid — JSON malformado => null (fail-closed)', () => {
  assert.strictEqual(liveness.parseHeartbeatPid('{not json'), null);
  assert.strictEqual(liveness.parseHeartbeatPid(''), null);
});

test('parseHeartbeatPid — pid faltante / no numérico / negativo / cero => null', () => {
  assert.strictEqual(liveness.parseHeartbeatPid('{"timestamp":"x"}'), null);
  assert.strictEqual(liveness.parseHeartbeatPid('{"pid":"123"}'), null);
  assert.strictEqual(liveness.parseHeartbeatPid('{"pid":-3}'), null);
  assert.strictEqual(liveness.parseHeartbeatPid('{"pid":0}'), null);
  assert.strictEqual(liveness.parseHeartbeatPid('{"pid":3.5}'), null);
  assert.strictEqual(liveness.parseHeartbeatPid(null), null);
  assert.strictEqual(liveness.parseHeartbeatPid(42), null);
});

// --- decide() ---------------------------------------------------------------

test('decide — heartbeat reciente (lag < umbral) => skip (CA-4)', () => {
  assert.strictEqual(liveness.decide(baseFacts({ hbAgeMs: 10 * SEC })), 'skip');
});

test('decide — lag exactamente igual al umbral => skip (borde, no falso positivo)', () => {
  assert.strictEqual(liveness.decide(baseFacts({ hbAgeMs: KILL_MS })), 'skip');
});

test('decide — heartbeat vencido + pid cruza con SO => kill-respawn (CA-2/CA-3)', () => {
  assert.strictEqual(
    liveness.decide(baseFacts({ hbAgeMs: KILL_MS + 1, hbPidFromContent: 555, soPid: 555 })),
    'kill-respawn'
  );
});

test('decide — vencido + pid del heartbeat != pid del SO => skip-log-discrepancy (SEC-1)', () => {
  assert.strictEqual(
    liveness.decide(baseFacts({ hbAgeMs: KILL_MS + 1, hbPidFromContent: 111, soPid: 222 })),
    'skip-log-discrepancy'
  );
});

test('decide — vencido + pid del heartbeat inválido/ausente => skip-log-discrepancy (CA-6)', () => {
  for (const badPid of [null, 0, -1, 3.5, undefined]) {
    assert.strictEqual(
      liveness.decide(baseFacts({ hbAgeMs: KILL_MS + 1, hbPidFromContent: badPid, soPid: 222 })),
      'skip-log-discrepancy',
      `pid inválido ${JSON.stringify(badPid)} no debe confirmar kill`
    );
  }
});

test('decide — vencido + soPid inválido => skip-log-discrepancy (no matar sin SO confiable)', () => {
  for (const badSo of [null, 0, -1, undefined]) {
    assert.strictEqual(
      liveness.decide(baseFacts({ hbAgeMs: KILL_MS + 1, hbPidFromContent: 555, soPid: badSo })),
      'skip-log-discrepancy'
    );
  }
});

test('decide — sin heartbeat => skip (no inventar kill, lo cubre el spawn normal)', () => {
  assert.strictEqual(liveness.decide(baseFacts({ hbExists: false })), 'skip');
});

test('decide — heartbeat existe pero edad ilegible => skip (fail-closed, no matar)', () => {
  for (const badAge of [null, undefined, NaN, Infinity, -10]) {
    assert.strictEqual(liveness.decide(baseFacts({ hbAgeMs: badAge })), 'skip');
  }
});

test('decide — umbral inválido => skip (nunca matar por umbral degradado, SEC-2)', () => {
  for (const badThreshold of [null, undefined, NaN, 0, -5, Infinity]) {
    assert.strictEqual(
      liveness.decide(baseFacts({ hbAgeMs: 10 * 60 * SEC, killThresholdMs: badThreshold })),
      'skip'
    );
  }
});

test('decide — facts ausente/no objeto => skip (defensivo)', () => {
  assert.strictEqual(liveness.decide(undefined), 'skip');
  assert.strictEqual(liveness.decide(null), 'skip');
});

// --- runner end-to-end (pulpo-liveness-run.js) ------------------------------

const RUNNER = path.join(__dirname, '..', 'pulpo-liveness-run.js');

function runRunner(env) {
  // Usar process.execPath (ruta absoluta al binario node en ejecución) en vez
  // del literal 'node'. El runner del tester spawnea este test en un contexto
  // donde 'node' no está en PATH → execFileSync('node', ...) tira ENOENT.
  // process.execPath siempre resuelve al mismo node que corre los tests.
  const out = execFileSync(process.execPath, [RUNNER], {
    env: Object.assign({}, process.env, env),
    encoding: 'utf8',
  });
  return out.trim();
}

test('runner — zombi confirmado (vencido + pid cruza) => ACTION:kill-respawn', () => {
  const out = runRunner({
    PLV_HB_EXISTS: '1',
    PLV_HB_AGE_MS: String(KILL_MS + 5000),
    PLV_HB_CONTENT: '{"pid":34567,"timestamp":"2020-01-01T00:00:00.000Z"}',
    PLV_SO_PID: '34567',
    PULPO_LIVENESS_KILL_SECONDS: '90',
    PLV_LOG_DIR: require('node:os').tmpdir(),
  });
  assert.strictEqual(out, 'ACTION:kill-respawn');
});

test('runner — heartbeat fresco => ACTION:skip', () => {
  const out = runRunner({
    PLV_HB_EXISTS: '1',
    PLV_HB_AGE_MS: '5000',
    PLV_HB_CONTENT: '{"pid":34567,"timestamp":"x"}',
    PLV_SO_PID: '34567',
    PLV_LOG_DIR: require('node:os').tmpdir(),
  });
  assert.strictEqual(out, 'ACTION:skip');
});

test('runner — discrepancia de PID => ACTION:skip (no mata, SEC-1)', () => {
  const out = runRunner({
    PLV_HB_EXISTS: '1',
    PLV_HB_AGE_MS: String(KILL_MS + 5000),
    PLV_HB_CONTENT: '{"pid":111,"timestamp":"x"}',
    PLV_SO_PID: '222',
    PLV_LOG_DIR: require('node:os').tmpdir(),
  });
  assert.strictEqual(out, 'ACTION:skip');
});

test('runner — sin heartbeat => ACTION:skip', () => {
  const out = runRunner({
    PLV_HB_EXISTS: '0',
    PLV_HB_AGE_MS: '',
    PLV_HB_CONTENT: '',
    PLV_SO_PID: '222',
    PLV_LOG_DIR: require('node:os').tmpdir(),
  });
  assert.strictEqual(out, 'ACTION:skip');
});

test('runner — umbral inválido por env => default, no falso kill con lag moderado (SEC-2)', () => {
  // lag 60s: con default 90s NO es zombi. Umbral inválido no debe volverlo "nunca stale"
  // ni "siempre stale": cae al default 90s => skip.
  const out = runRunner({
    PLV_HB_EXISTS: '1',
    PLV_HB_AGE_MS: '60000',
    PLV_HB_CONTENT: '{"pid":99,"timestamp":"x"}',
    PLV_SO_PID: '99',
    PULPO_LIVENESS_KILL_SECONDS: 'abc',
    PLV_LOG_DIR: require('node:os').tmpdir(),
  });
  assert.strictEqual(out, 'ACTION:skip');
});
