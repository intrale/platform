#!/usr/bin/env node
// =============================================================================
// test-watchdog-supervisor.js — Tests del supervisor del watchdog (#4077).
//
// Cubre la lógica de decisión (lib/watchdog-supervisor.js) + el orquestador
// (watchdog-supervisor-run.js) con cobertura ≥80% de ramas de decisión:
//   - heartbeat fresco (< stale) => no relanza (skip).
//   - heartbeat stale (> stale) => relanza.
//   - heartbeat ausente / ilegible => fail-closed = stale (SEC-1).
//   - cross-check SO: heartbeat fresco pero tarea no viva => relanza (SEC-1).
//   - WATCHDOG_STALE_MINUTES inválido => default, NO "nunca stale" (SEC-2).
//   - cap de reintentos alcanzado => escalate nivel error, NO relanza (SEC-4).
//   - cooldown activo => no relanza dentro de la ventana (SEC-4).
//   - estado corrupto => fail-soft a vacío.
//   - alerta Telegram: drop encolado con shape válido y SIN paths/secrets (SEC-5).
//
// Ejecución: node --test .pipeline/test-watchdog-supervisor.js
// Framework: node:test + node:assert (cero deps externas).
// =============================================================================

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const sup = require('./lib/watchdog-supervisor');

const MIN = 60 * 1000;
const NOW = 1_700_000_000_000;

function baseFacts(over = {}) {
  return Object.assign(
    {
      heartbeatExists: true,
      heartbeatAgeMs: 1 * MIN,
      taskHealthy: true,
      now: NOW,
      state: { relaunches: [], lastRelaunchTs: 0, lastEscalationTs: 0 },
      staleMinutes: 6,
      maxRestarts: 3,
      cooldownSeconds: 90,
      windowMinutes: 60,
    },
    over
  );
}

// --- parseStaleMinutes (SEC-2) ----------------------------------------------

test('parseStaleMinutes — entero positivo válido se respeta', () => {
  assert.strictEqual(sup.parseStaleMinutes('10'), 10);
  assert.strictEqual(sup.parseStaleMinutes(8), 8);
});

test('parseStaleMinutes — inválido cae a default, NUNCA a "nunca stale" (SEC-2)', () => {
  for (const bad of ['', 'abc', '-5', '0', '3.5', null, undefined, NaN, {}, '  ']) {
    const r = sup.parseStaleMinutes(bad);
    assert.strictEqual(r, sup.DEFAULT_STALE_MINUTES, `bad=${JSON.stringify(bad)} => default`);
    assert.ok(r >= 1, 'el default es positivo, nunca degrada a infinito/0');
  }
});

test('parseStaleMinutes — fallback inválido se sanea a DEFAULT', () => {
  assert.strictEqual(sup.parseStaleMinutes('xx', 0), sup.DEFAULT_STALE_MINUTES);
  assert.strictEqual(sup.parseStaleMinutes('xx', -3), sup.DEFAULT_STALE_MINUTES);
});

// --- decide: staleness ------------------------------------------------------

test('decide — heartbeat fresco (< stale) => skip', () => {
  const d = sup.decide(baseFacts({ heartbeatAgeMs: 2 * MIN }));
  assert.strictEqual(d.action, 'skip');
  assert.strictEqual(d.stale, false);
  assert.strictEqual(d.level, 'info');
});

test('decide — heartbeat stale (> stale) => relaunch warn', () => {
  const d = sup.decide(baseFacts({ heartbeatAgeMs: 7 * MIN }));
  assert.strictEqual(d.action, 'relaunch');
  assert.strictEqual(d.stale, true);
  assert.strictEqual(d.staleReason, 'heartbeat-stale');
  assert.strictEqual(d.level, 'warn');
});

test('decide — heartbeat ausente => fail-closed = stale (SEC-1)', () => {
  const d = sup.decide(baseFacts({ heartbeatExists: false, heartbeatAgeMs: null }));
  assert.strictEqual(d.action, 'relaunch');
  assert.strictEqual(d.staleReason, 'heartbeat-missing');
});

test('decide — heartbeat con edad ilegible (null/NaN/neg) => fail-closed (SEC-1)', () => {
  for (const bad of [null, NaN, -10, undefined]) {
    const d = sup.decide(baseFacts({ heartbeatExists: true, heartbeatAgeMs: bad }));
    assert.strictEqual(d.action, 'relaunch', `age=${bad}`);
    assert.strictEqual(d.staleReason, 'heartbeat-missing');
  }
});

test('decide — cross-check SO: heartbeat fresco pero tarea NO viva => relaunch (SEC-1)', () => {
  const d = sup.decide(baseFacts({ heartbeatAgeMs: 1 * MIN, taskHealthy: false }));
  assert.strictEqual(d.action, 'relaunch');
  assert.strictEqual(d.staleReason, 'os-mismatch');
});

test('decide — taskHealthy desconocido (null) no fuerza relaunch si heartbeat fresco', () => {
  const d = sup.decide(baseFacts({ heartbeatAgeMs: 1 * MIN, taskHealthy: null }));
  assert.strictEqual(d.action, 'skip');
});

test('decide — staleMinutes inválido no degrada a "nunca stale" (SEC-2)', () => {
  // Con umbral inválido cae a default 6; un heartbeat de 7 min sigue siendo stale.
  const d = sup.decide(baseFacts({ heartbeatAgeMs: 7 * MIN, staleMinutes: '0' }));
  assert.strictEqual(d.action, 'relaunch');
});

// --- decide: cap y cooldown (SEC-4) -----------------------------------------

test('decide — cap alcanzado => escalate error, NO relaunch (SEC-4)', () => {
  const state = {
    relaunches: [NOW - 5 * MIN, NOW - 10 * MIN, NOW - 15 * MIN],
    lastRelaunchTs: NOW - 5 * MIN,
  };
  const d = sup.decide(baseFacts({ heartbeatAgeMs: 7 * MIN, state }));
  assert.strictEqual(d.action, 'escalate');
  assert.strictEqual(d.level, 'error');
  assert.strictEqual(d.reason, 'cap-reached');
  assert.strictEqual(d.restartsInWindow, 3);
});

test('decide — relanzamientos viejos fuera de ventana NO cuentan para el cap', () => {
  const state = {
    relaunches: [NOW - 90 * MIN, NOW - 120 * MIN, NOW - 200 * MIN],
    lastRelaunchTs: NOW - 90 * MIN,
  };
  const d = sup.decide(baseFacts({ heartbeatAgeMs: 7 * MIN, state }));
  assert.strictEqual(d.action, 'relaunch', 'fuera de ventana de 60 min => no cuentan');
});

test('decide — cooldown activo => skip (SEC-4)', () => {
  const state = { relaunches: [NOW - 30 * 1000], lastRelaunchTs: NOW - 30 * 1000 };
  const d = sup.decide(baseFacts({ heartbeatAgeMs: 7 * MIN, state }));
  assert.strictEqual(d.action, 'skip');
  assert.strictEqual(d.reason, 'cooldown');
});

test('decide — pasado el cooldown => relaunch', () => {
  const state = { relaunches: [NOW - 120 * 1000], lastRelaunchTs: NOW - 120 * 1000 };
  const d = sup.decide(baseFacts({ heartbeatAgeMs: 7 * MIN, state }));
  assert.strictEqual(d.action, 'relaunch');
});

// --- estado: fail-soft / atómico --------------------------------------------

test('loadState — archivo ausente => estado vacío', () => {
  const s = sup.loadState(path.join(os.tmpdir(), 'no-existe-wds-' + NOW + '.json'));
  assert.deepStrictEqual(s.relaunches, []);
  assert.strictEqual(s.lastRelaunchTs, 0);
});

test('loadState — archivo corrupto => fail-soft a vacío', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wds-'));
  try {
    const f = path.join(dir, 'state.json');
    fs.writeFileSync(f, '{no es json');
    const s = sup.loadState(f);
    assert.deepStrictEqual(s.relaunches, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('normalizeState — descarta timestamps inválidos', () => {
  const s = sup.normalizeState({
    relaunches: ['x', -1, NaN, NOW],
    lastRelaunchTs: -5,
    lastEscalationTs: 'y',
  });
  assert.deepStrictEqual(s.relaunches, [NOW]);
  assert.strictEqual(s.lastRelaunchTs, 0);
  assert.strictEqual(s.lastEscalationTs, 0);
});

test('saveStateAtomic + loadState — round-trip', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wds-'));
  try {
    const f = path.join(dir, 'state.json');
    sup.saveStateAtomic(f, { relaunches: [NOW], lastRelaunchTs: NOW });
    assert.ok(!fs.existsSync(f + '.tmp'), 'no quedan .tmp huérfanos');
    const s = sup.loadState(f);
    assert.deepStrictEqual(s.relaunches, [NOW]);
    assert.strictEqual(s.lastRelaunchTs, NOW);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('recordRelaunch — agrega ts y poda fuera de ventana', () => {
  const state = { relaunches: [NOW - 200 * MIN], lastRelaunchTs: NOW - 200 * MIN };
  const s = sup.recordRelaunch(state, NOW, 60);
  assert.deepStrictEqual(s.relaunches, [NOW], 'el viejo se podó, queda el nuevo');
  assert.strictEqual(s.lastRelaunchTs, NOW);
});

// --- integración: runner Node (stdout + estado + alerta Telegram SEC-5) -----

function runRunner(env, tmp) {
  const queueDir = path.join(tmp, 'servicios', 'telegram', 'pendiente');
  const out = execFileSync('node', [path.join(__dirname, 'watchdog-supervisor-run.js')], {
    env: Object.assign({}, process.env, {
      WDS_LOG_DIR: path.join(tmp, 'logs'),
      WDS_STATE_FILE: path.join(tmp, 'logs', 'state.json'),
      PIPELINE_DIR_OVERRIDE: tmp,
      WATCHDOG_STALE_MINUTES: '', // usar default/config
    }, env),
    encoding: 'utf8',
  });
  return { out, queueDir };
}

function readDrops(queueDir) {
  if (!fs.existsSync(queueDir)) return [];
  return fs
    .readdirSync(queueDir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(fs.readFileSync(path.join(queueDir, f), 'utf8')));
}

test('runner — heartbeat stale => ACTION:relaunch + drop Telegram válido sin paths/secrets (SEC-5)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wds-run-'));
  try {
    const { out, queueDir } = runRunner(
      { WDS_HB_EXISTS: '1', WDS_HB_AGE_MS: String(20 * MIN), WDS_TASK_HEALTHY: '1' },
      tmp
    );
    assert.match(out, /ACTION:relaunch/);

    const drops = readDrops(queueDir);
    assert.strictEqual(drops.length, 1, 'se encoló exactamente 1 alerta');
    const drop = drops[0];
    assert.strictEqual(typeof drop.text, 'string');
    assert.ok(drop.parse_mode, 'tiene parse_mode');
    // SEC-5: sin paths absolutos ni secrets en el cuerpo.
    assert.ok(!/[A-Za-z]:\\/.test(drop.text), `no debe filtrar paths absolutos: ${drop.text}`);
    assert.ok(!/[A-Za-z]:\//.test(drop.text), 'no debe filtrar paths absolutos (forward)');
    assert.ok(!/token|secret|password|api[_-]?key/i.test(drop.text), 'no debe filtrar secrets');
    assert.ok(/watchdog-supervisor/.test(drop.text), 'identifica el componente');

    // estado persistido con el relaunch
    const state = JSON.parse(fs.readFileSync(path.join(tmp, 'logs', 'state.json'), 'utf8'));
    assert.strictEqual(state.relaunches.length, 1);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('runner — heartbeat fresco => ACTION:skip sin alerta', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wds-run-'));
  try {
    const { out, queueDir } = runRunner(
      { WDS_HB_EXISTS: '1', WDS_HB_AGE_MS: String(1 * MIN), WDS_TASK_HEALTHY: '1' },
      tmp
    );
    assert.match(out, /ACTION:skip/);
    assert.strictEqual(readDrops(queueDir).length, 0, 'no encola alertas cuando está fresco');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('runner — heartbeat ausente => ACTION:relaunch (fail-closed SEC-1)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wds-run-'));
  try {
    const { out } = runRunner(
      { WDS_HB_EXISTS: '0', WDS_HB_AGE_MS: '', WDS_TASK_HEALTHY: '1' },
      tmp
    );
    assert.match(out, /ACTION:relaunch/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
