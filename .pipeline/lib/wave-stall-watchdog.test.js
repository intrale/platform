// =============================================================================
// wave-stall-watchdog.test.js — Tests de la lógica de decisión (#4708)
//
// Cobertura objetivo: 100% de ramas de `decide`, `parseStallMinutes`,
// `isCauseValid` y `buildAlertMessage` (fail-closed es crítico).
// =============================================================================

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const wd = require('./wave-stall-watchdog');

const MIN = 60 * 1000;

// Helper: foto base "estancada" (trabajo habilitado, 0 despacho, sin causa).
function stalledFacts(overrides = {}) {
  return {
    now: 100 * MIN,
    waveKey: 7,
    enabledCount: 3,
    dispatching: 0,
    progressSeries: [{ ts: 1, waveKey: 7, avancePct: 42 }],
    cause: null,
    state: { lastMovementTs: 0, lastSignature: '0:42', lastAlertTs: 0, alertCount: 0 },
    stallMinutes: 20,
    cooldownMinutes: 30,
    windowMinutes: 60,
    ...overrides,
  };
}

// ─── CA-1 · Estancamiento inexplicado dispara alerta ────────────────────────

test('CA-1: trabajo habilitado + 0 despacho + avancePct constante > N min + sin causa => alert', () => {
  // Movimiento fijado hace 40 min (> 20 min de umbral), firma sin cambios.
  const f = stalledFacts({
    now: 100 * MIN,
    state: { lastMovementTs: 60 * MIN, lastSignature: '0:42', lastAlertTs: 0, alertCount: 0 },
  });
  const d = wd.decide(f);
  assert.equal(d.action, 'alert');
  assert.equal(d.reason, 'unexplained-stall');
  assert.equal(d.level, 'warn');
  assert.ok(d.message.includes('Ola 7'));
  assert.equal(d.nextState.alertCount, 1);
  assert.equal(d.nextState.lastAlertTs, 100 * MIN);
});

test('CA-1: segundo disparo del mismo episodio (tras cooldown) escala', () => {
  const f = stalledFacts({
    now: 100 * MIN,
    state: { lastMovementTs: 40 * MIN, lastSignature: '0:42', lastAlertTs: 60 * MIN, alertCount: 1 },
  });
  const d = wd.decide(f);
  assert.equal(d.action, 'escalate');
  assert.equal(d.level, 'error');
  assert.equal(d.nextState.alertCount, 2);
});

// ─── CA-2 · Causa declarada legítima ⇒ NO falsa alarma ──────────────────────

for (const kind of ['human-halt', 'quota', 'night-window', 'blocked-dependencies', 'resource-pressure', 'waiting-operator']) {
  test(`CA-2: causa declarada vigente (${kind}) => skip, NO alerta`, () => {
    const f = stalledFacts({
      state: { lastMovementTs: 40 * MIN, lastSignature: '0:42', lastAlertTs: 0, alertCount: 0 },
      cause: { declared: true, kind, expiresAt: 200 * MIN, readable: true },
    });
    const d = wd.decide(f);
    assert.equal(d.action, 'skip');
    assert.equal(d.reason, `declared-cause:${kind}`);
    assert.equal(d.message, null);
  });
}

test('CA-2: causa sin expiresAt (perpetua vigente) suprime', () => {
  const f = stalledFacts({
    state: { lastMovementTs: 40 * MIN, lastSignature: '0:42', lastAlertTs: 0, alertCount: 0 },
    cause: { declared: true, kind: 'human-halt', readable: true },
  });
  assert.equal(wd.decide(f).action, 'skip');
});

// ─── CA-3 · Fail-closed ante causa ausente/ilegible/corrupta/expirada ───────

test('CA-3: causa null => fail-closed => alert', () => {
  const f = stalledFacts({
    state: { lastMovementTs: 40 * MIN, lastSignature: '0:42', lastAlertTs: 0, alertCount: 0 },
    cause: null,
  });
  assert.equal(wd.decide(f).action, 'alert');
});

test('CA-3: causa ilegible (readable:false) => fail-closed => alert', () => {
  const f = stalledFacts({
    state: { lastMovementTs: 40 * MIN, lastSignature: '0:42', lastAlertTs: 0, alertCount: 0 },
    cause: { declared: true, kind: 'quota', readable: false },
  });
  assert.equal(wd.decide(f).action, 'alert');
});

test('CA-3: causa expirada (causa zombi) => fail-closed => alert', () => {
  const f = stalledFacts({
    now: 100 * MIN,
    state: { lastMovementTs: 40 * MIN, lastSignature: '0:42', lastAlertTs: 0, alertCount: 0 },
    cause: { declared: true, kind: 'quota', expiresAt: 50 * MIN, readable: true },
  });
  assert.equal(wd.decide(f).action, 'alert');
});

test('CA-3: causa con expiresAt ilegible => fail-closed => alert', () => {
  const f = stalledFacts({
    state: { lastMovementTs: 40 * MIN, lastSignature: '0:42', lastAlertTs: 0, alertCount: 0 },
    cause: { declared: true, kind: 'quota', expiresAt: 'nunca', readable: true },
  });
  assert.equal(wd.decide(f).action, 'alert');
});

test('CA-3: causa con declared !== true => fail-closed => alert', () => {
  const f = stalledFacts({
    state: { lastMovementTs: 40 * MIN, lastSignature: '0:42', lastAlertTs: 0, alertCount: 0 },
    cause: { declared: false, kind: 'quota', readable: true },
  });
  assert.equal(wd.decide(f).action, 'alert');
});

test('isCauseValid: matriz de validez', () => {
  const now = 100 * MIN;
  assert.equal(wd.isCauseValid(null, now), false);
  assert.equal(wd.isCauseValid(undefined, now), false);
  assert.equal(wd.isCauseValid('paused', now), false);
  assert.equal(wd.isCauseValid({ declared: true, readable: true }, now), true);
  assert.equal(wd.isCauseValid({ declared: true, readable: false }, now), false);
  assert.equal(wd.isCauseValid({ declared: true, expiresAt: 200 * MIN }, now), true);
  assert.equal(wd.isCauseValid({ declared: true, expiresAt: 50 * MIN }, now), false);
});

// ─── CA-4 · parseStallMinutes con clamp (SEC-3) ─────────────────────────────

test('CA-4: parseStallMinutes cae al default en valores inválidos', () => {
  assert.equal(wd.parseStallMinutes(0), wd.DEFAULT_STALL_MINUTES);
  assert.equal(wd.parseStallMinutes(-5), wd.DEFAULT_STALL_MINUTES);
  assert.equal(wd.parseStallMinutes('abc'), wd.DEFAULT_STALL_MINUTES);
  assert.equal(wd.parseStallMinutes(999999), wd.DEFAULT_STALL_MINUTES); // gigante → default
  assert.equal(wd.parseStallMinutes(null), wd.DEFAULT_STALL_MINUTES);
  assert.equal(wd.parseStallMinutes(3.5), wd.DEFAULT_STALL_MINUTES);
});

test('CA-4: parseStallMinutes acepta valores válidos', () => {
  assert.equal(wd.parseStallMinutes(20), 20);
  assert.equal(wd.parseStallMinutes('45'), 45);
  assert.equal(wd.parseStallMinutes(wd.MAX_STALL_MINUTES), wd.MAX_STALL_MINUTES);
});

test('CA-4: parseStallMinutes con fallback inválido usa el default duro', () => {
  assert.equal(wd.parseStallMinutes('x', 0), wd.DEFAULT_STALL_MINUTES);
  assert.equal(wd.parseStallMinutes('x', 9999999), wd.DEFAULT_STALL_MINUTES);
  assert.equal(wd.parseStallMinutes('x', 15), 15);
});

test('CA-4: un N gigante NO deshabilita de facto (no cae en "nunca stall")', () => {
  // Con stallMinutes gigante, el clamp lo lleva al default (20 min); un
  // estancamiento de 40 min DEBE disparar igual.
  const f = stalledFacts({
    stallMinutes: 999999,
    state: { lastMovementTs: 60 * MIN, lastSignature: '0:42', lastAlertTs: 0, alertCount: 0 },
  });
  assert.equal(wd.decide(f).action, 'alert');
});

// ─── CA-5 · Mensaje sin datos sensibles (SEC-2) ─────────────────────────────

test('CA-5: buildAlertMessage NO contiene paths absolutos ni tokens', () => {
  const msg = wd.buildAlertMessage({ waveKey: 7, stallMinutes: 20, enabledCount: 3 });
  assert.ok(msg.includes('Ola 7'));
  assert.ok(msg.includes('20 min'));
  // Sin rutas absolutas (Windows o POSIX)
  assert.ok(!/[A-Za-z]:\\/.test(msg), 'no debe tener path Windows');
  assert.ok(!/\/(home|c|Workspaces|Users|pipeline)\//i.test(msg), 'no debe tener path POSIX');
  // Sin tokens/secrets típicos
  assert.ok(!/[0-9]{6,}:[A-Za-z0-9_-]{20,}/.test(msg), 'no debe tener bot token');
  assert.ok(!/AKIA[0-9A-Z]{16}/.test(msg), 'no debe tener AWS key');
  assert.ok(!/eyJ[A-Za-z0-9_-]+\./.test(msg), 'no debe tener JWT');
});

test('CA-5: el message de una decisión de alerta es sanitizado', () => {
  const f = stalledFacts({
    state: { lastMovementTs: 60 * MIN, lastSignature: '0:42', lastAlertTs: 0, alertCount: 0 },
  });
  const d = wd.decide(f);
  assert.ok(!/[A-Za-z]:\\/.test(d.message));
  assert.ok(d.message.includes('Ola 7'));
});

// ─── CA-6 · Anti-flooding: dedup por cooldown ───────────────────────────────

test('CA-6: dentro del cooldown desde lastAlertTs => skip (no re-alerta)', () => {
  const f = stalledFacts({
    now: 100 * MIN,
    // alertó hace 10 min, cooldown 30 min → todavía en cooldown
    state: { lastMovementTs: 40 * MIN, lastSignature: '0:42', lastAlertTs: 90 * MIN, alertCount: 1 },
  });
  const d = wd.decide(f);
  assert.equal(d.action, 'skip');
  assert.equal(d.reason, 'cooldown');
});

test('CA-6: pasado el cooldown en el MISMO episodio => re-dispara (escalate)', () => {
  const f = stalledFacts({
    now: 100 * MIN,
    // alertó hace 40 min, cooldown 30 min → ya pasó
    state: { lastMovementTs: 40 * MIN, lastSignature: '0:42', lastAlertTs: 60 * MIN, alertCount: 1 },
  });
  const d = wd.decide(f);
  assert.equal(d.action, 'escalate');
});

test('CA-6: un episodio NUEVO (movió ficha y volvió a estancarse) re-alerta como alert', () => {
  // La firma cambió respecto de la persistida → resetea episodio (alertCount=0)
  // y el reloj de movimiento a `now`. NO dispara en la misma foto (recién movió).
  const f = stalledFacts({
    now: 100 * MIN,
    dispatching: 0,
    progressSeries: [{ ts: 1, waveKey: 7, avancePct: 55 }], // avancePct distinto → firma nueva
    state: { lastMovementTs: 40 * MIN, lastSignature: '0:42', lastAlertTs: 60 * MIN, alertCount: 3 },
  });
  const d = wd.decide(f);
  assert.equal(d.action, 'skip'); // recién movió, reloj reiniciado
  assert.equal(d.nextState.alertCount, 0);
  assert.equal(d.nextState.lastAlertTs, 0);
  assert.equal(d.nextState.lastMovementTs, 100 * MIN);
});

// ─── Definición de "ficha movida" ───────────────────────────────────────────

test('ficha movida: cambia conteo trabajando/ con avancePct constante => NO estancada', () => {
  // Firma persistida "0:42"; ahora hay 2 en trabajando/ → firma "2:42" (nueva).
  // dispatching>0 además corta antes: skip 'dispatching'.
  const f = stalledFacts({
    dispatching: 2,
    progressSeries: [{ ts: 1, waveKey: 7, avancePct: 42 }],
    state: { lastMovementTs: 40 * MIN, lastSignature: '0:42', lastAlertTs: 0, alertCount: 0 },
  });
  const d = wd.decide(f);
  assert.equal(d.action, 'skip');
  assert.equal(d.reason, 'dispatching');
});

test('ficha movida: avancePct cambió (promovió ficha) => reloj reiniciado', () => {
  const f = stalledFacts({
    now: 100 * MIN,
    dispatching: 0,
    progressSeries: [{ ts: 1, waveKey: 7, avancePct: 99 }],
    state: { lastMovementTs: 40 * MIN, lastSignature: '0:42', lastAlertTs: 0, alertCount: 0 },
  });
  const d = wd.decide(f);
  assert.equal(d.nextState.lastMovementTs, 100 * MIN);
});

test('movementSignature: primera foto (sin firma previa) reinicia el reloj', () => {
  const f = stalledFacts({
    now: 100 * MIN,
    state: { lastMovementTs: 0, lastSignature: null, lastAlertTs: 0, alertCount: 0 },
  });
  const d = wd.decide(f);
  // Primera foto: movedFicha=true → lastMovementTs=now → stalledMs=0 < umbral → skip
  assert.equal(d.action, 'skip');
  assert.equal(d.reason, 'within-threshold');
  assert.equal(d.nextState.lastMovementTs, 100 * MIN);
});

// ─── Ramas de guarda ────────────────────────────────────────────────────────

test('guard: sin trabajo habilitado => skip no-enabled-work', () => {
  const f = stalledFacts({
    enabledCount: 0,
    state: { lastMovementTs: 40 * MIN, lastSignature: '0:42', lastAlertTs: 0, alertCount: 0 },
  });
  const d = wd.decide(f);
  assert.equal(d.action, 'skip');
  assert.equal(d.reason, 'no-enabled-work');
});

test('guard: dispatching>0 => skip dispatching', () => {
  const f = stalledFacts({
    dispatching: 1,
    state: { lastMovementTs: 40 * MIN, lastSignature: '1:42', lastAlertTs: 0, alertCount: 0 },
  });
  const d = wd.decide(f);
  assert.equal(d.action, 'skip');
  assert.equal(d.reason, 'dispatching');
});

test('guard: dentro del umbral (< N min) => skip within-threshold', () => {
  const f = stalledFacts({
    now: 100 * MIN,
    state: { lastMovementTs: 90 * MIN, lastSignature: '0:42', lastAlertTs: 0, alertCount: 0 },
  });
  const d = wd.decide(f);
  assert.equal(d.action, 'skip');
  assert.equal(d.reason, 'within-threshold');
});

test('guard: now no finito se trata como 0 sin romper', () => {
  const f = stalledFacts({ now: NaN });
  const d = wd.decide(f);
  assert.ok(['skip', 'alert'].includes(d.action));
});

test('movementSignature: serie vacía o inválida => avance "na"', () => {
  assert.equal(wd.movementSignature(0, []), '0:na');
  assert.equal(wd.movementSignature(3, null), '3:na');
  assert.equal(wd.movementSignature(0, [{ ts: 1, waveKey: 7, avancePct: 'x' }]), '0:na');
});

// ─── Estado: load/save/normalize ────────────────────────────────────────────

test('normalizeState: tolera basura y campos ausentes', () => {
  assert.deepEqual(wd.normalizeState(null), {
    lastMovementTs: 0, lastSignature: null, lastAlertTs: 0, alertCount: 0,
  });
  assert.deepEqual(wd.normalizeState({ lastMovementTs: -1, lastSignature: 5, lastAlertTs: 'x', alertCount: -2 }), {
    lastMovementTs: 0, lastSignature: null, lastAlertTs: 0, alertCount: 0,
  });
  assert.deepEqual(wd.normalizeState({ lastMovementTs: 10, lastSignature: '0:1', lastAlertTs: 20, alertCount: 3 }), {
    lastMovementTs: 10, lastSignature: '0:1', lastAlertTs: 20, alertCount: 3,
  });
});

test('loadState/saveStateAtomic round-trip + fail-soft ante archivo ausente', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wave-wd-'));
  const file = path.join(dir, 'state.json');
  // Ausente → default
  assert.deepEqual(wd.loadState(file), {
    lastMovementTs: 0, lastSignature: null, lastAlertTs: 0, alertCount: 0,
  });
  wd.saveStateAtomic(file, { lastMovementTs: 5, lastSignature: '2:9', lastAlertTs: 7, alertCount: 1 });
  assert.deepEqual(wd.loadState(file), {
    lastMovementTs: 5, lastSignature: '2:9', lastAlertTs: 7, alertCount: 1,
  });
  // Corrupto → default (fail-soft)
  fs.writeFileSync(file, '{no json');
  assert.deepEqual(wd.loadState(file), {
    lastMovementTs: 0, lastSignature: null, lastAlertTs: 0, alertCount: 0,
  });
  fs.rmSync(dir, { recursive: true, force: true });
});
