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

// #5400: "vigente" pasó a significar "reciente". La causa suprime mientras la
// INACTIVIDAD DE DESPACHO está por debajo de `declared_cause_escalate_minutes`
// (45 default). 30 min sin despachar: por encima del umbral normal (20) y por
// debajo del de escalada → sigue mudo, exactamente como en #4708/#4751.
for (const kind of ['human-halt', 'quota', 'night-window', 'blocked-dependencies', 'resource-pressure', 'waiting-operator']) {
  test(`CA-2: causa declarada vigente (${kind}) => skip, NO alerta`, () => {
    const f = stalledFacts({
      state: { lastMovementTs: 70 * MIN, lastSignature: '0:42', lastAlertTs: 0, alertCount: 0 },
      cause: { declared: true, kind, expiresAt: 200 * MIN, readable: true },
    });
    const d = wd.decide(f);
    assert.equal(d.action, 'skip');
    assert.equal(d.reason, `declared-cause:${kind}`);
    assert.equal(d.message, null);
  });
}

test('CA-2: causa sin expiresAt (perpetua vigente) suprime mientras la inactividad es corta', () => {
  const f = stalledFacts({
    state: { lastMovementTs: 70 * MIN, lastSignature: '0:42', lastAlertTs: 0, alertCount: 0 },
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
    progressSeries: [{ ts: 1, waveKey: 7, avancePct: 55 }], // avancePct SUBIÓ → movió ficha
    state: {
      lastMovementTs: 40 * MIN, lastSignature: '0:42', lastAlertTs: 60 * MIN, alertCount: 3,
      lastAvancePct: 42,
    },
  });
  const d = wd.decide(f);
  assert.equal(d.action, 'skip'); // recién movió, reloj reiniciado
  assert.equal(d.nextState.alertCount, 0);
  assert.equal(d.nextState.lastAlertTs, 0);
  assert.equal(d.nextState.lastMovementTs, 100 * MIN);
});

// ─── Definición de "ficha movida" ───────────────────────────────────────────

// rev-6 — Este test AFIRMABA lo contrario ("la firma cambió ⇒ movió ficha ⇒ el
// reloj se reinicia") y por eso el defecto quedó protegido por la suite: el
// conteo de `trabajando/` cambia también cuando los agentes TERMINAN, y tratarlo
// como movimiento reiniciaba el reloj sin que se hubiera despachado nada. Es
// exactamente lo que el propio módulo se prohíbe en su bloque 1b.
test('ficha movida: un cambio de conteo trabajando/ NO reinicia el reloj (avancePct constante)', () => {
  // now=130min contra un reloj fijado en 40min ⇒ 90 min sin despachar. Con 2
  // agentes en curso el umbral es 20 + 60 de gracia = 80 min, así que 90 > 80
  // tiene que alertar. Si el conteo reiniciara el reloj, `stalledMs` volvería a 0
  // y esto sería un `skip` para siempre.
  const f = stalledFacts({
    now: 130 * MIN,
    dispatching: 2,
    progressSeries: [{ ts: 1, waveKey: 7, avancePct: 42 }],
    state: {
      lastMovementTs: 40 * MIN, lastSignature: '0:42', lastAlertTs: 0, alertCount: 0,
      lastDispatching: 0, lastAvancePct: 42,
    },
  });
  const d = wd.decide(f);
  assert.equal(d.nextState.lastMovementTs, 40 * MIN, 'el reloj sigue corriendo desde donde estaba');
  assert.equal(d.stalledMs, 90 * MIN, 'la inactividad se acumula, no se reinicia');
  assert.equal(d.action, 'alert', '90 min sin despachar supera el umbral atenuado (80)');
});

test('ficha movida: avancePct cambió (promovió ficha) => reloj reiniciado', () => {
  const f = stalledFacts({
    now: 100 * MIN,
    dispatching: 0,
    progressSeries: [{ ts: 1, waveKey: 7, avancePct: 99 }],
    state: {
      lastMovementTs: 40 * MIN, lastSignature: '0:42', lastAlertTs: 0, alertCount: 0,
      lastAvancePct: 42,
    },
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

// #5400 (rev-1): `dispatching > 0` dejó de ser un skip incondicional — con eso,
// un agente clavado congelaba la vigilancia para siempre (G-3). Ahora es una
// GRACIA que se suma a los umbrales: con agentes en curso hay que estar mucho
// más tiempo sin despachar para que se declare estancamiento.
test('guard: dispatching>0 atenúa el umbral en vez de apagar el control', () => {
  const f = stalledFacts({
    dispatching: 1,
    state: { lastMovementTs: 40 * MIN, lastSignature: '1:42', lastAlertTs: 0, alertCount: 0 },
  });
  // 60 min sin despachar: pasa el umbral normal (20) pero no el atenuado (80).
  const d = wd.decide(f);
  assert.equal(d.action, 'skip');
  assert.equal(d.reason, 'within-threshold');
  assert.equal(d.dispatching, 1);

  // Sin agentes en curso, la MISMA foto sí dispara: la diferencia es la gracia.
  const sinAgentes = wd.decide(stalledFacts({
    dispatching: 0,
    state: { lastMovementTs: 40 * MIN, lastSignature: '0:42', lastAlertTs: 0, alertCount: 0 },
  }));
  assert.equal(sinAgentes.action, 'alert');
});

test('guard: la gracia por agentes en curso NO es un cheque en blanco', () => {
  // Mismo escenario que arriba pero con 3 h sin despachar: la gracia se agota.
  const d = wd.decide(stalledFacts({
    now: 200 * MIN,
    dispatching: 3,
    state: { lastMovementTs: 20 * MIN, lastSignature: '3:42', lastAlertTs: 0, alertCount: 0 },
  }));
  assert.equal(d.action, 'alert');
  assert.equal(d.reason, 'unexplained-stall');
  // El aviso dice que hay agentes corriendo: cambia el diagnóstico por completo.
  assert.ok(d.message.includes('3 agente(s) en curso'), d.message);
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

// #5400 — el estado creció con `lastStampTs` (última estampa de despacho
// OBSERVADA). Es ADITIVO y opcional: un archivo escrito por la versión #4708
// carga sin migración, con el campo nuevo en su default.
// rev-1: `causeKind`/`causeSinceTs` fueron eliminados (eran el reloj de la causa,
// que dejaba al watchdog mudo ante causas alternantes — B1). Un estado viejo que
// todavía los traiga se carga igual: simplemente se descartan.
const EMPTY_STATE = {
  lastMovementTs: 0, lastSignature: null, lastAlertTs: 0, alertCount: 0,
  lastStampTs: 0,
  // rev-6 — aditivos: últimos valores OBSERVADOS. `null` = todavía no observado.
  lastDispatching: null, lastAvancePct: null,
};

test('normalizeState: tolera basura y campos ausentes', () => {
  assert.deepEqual(wd.normalizeState(null), EMPTY_STATE);
  assert.deepEqual(
    wd.normalizeState({ lastMovementTs: -1, lastSignature: 5, lastAlertTs: 'x', alertCount: -2, lastStampTs: -3 }),
    EMPTY_STATE
  );
  assert.deepEqual(wd.normalizeState({ lastMovementTs: 10, lastSignature: '0:1', lastAlertTs: 20, alertCount: 3 }), {
    ...EMPTY_STATE, lastMovementTs: 10, lastSignature: '0:1', lastAlertTs: 20, alertCount: 3,
  });
  assert.deepEqual(wd.normalizeState({ lastStampTs: 42 }), { ...EMPTY_STATE, lastStampTs: 42 });
});

test('normalizeState: un estado viejo (#4708) sin los campos nuevos carga sin migración', () => {
  const viejo = { lastMovementTs: 10, lastSignature: '0:1', lastAlertTs: 20, alertCount: 3 };
  const out = wd.normalizeState(viejo);
  assert.equal(out.lastMovementTs, 10);
  assert.equal(out.lastStampTs, 0);
});

test('normalizeState: un estado de rev-0 con el reloj de causa se carga descartándolo', () => {
  const rev0 = {
    lastMovementTs: 10, lastSignature: '0:1', lastAlertTs: 20, alertCount: 3,
    causeKind: 'human-halt', causeSinceTs: 999,
  };
  const out = wd.normalizeState(rev0);
  assert.deepEqual(out, { ...EMPTY_STATE, lastMovementTs: 10, lastSignature: '0:1', lastAlertTs: 20, alertCount: 3 });
  assert.equal('causeSinceTs' in out, false, 'el reloj de la causa ya no existe');
});

test('loadState/saveStateAtomic round-trip + fail-soft ante archivo ausente', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wave-wd-'));
  const file = path.join(dir, 'state.json');
  // Ausente → default
  assert.deepEqual(wd.loadState(file), EMPTY_STATE);
  assert.equal(wd.saveStateAtomic(file, {
    lastMovementTs: 5, lastSignature: '2:9', lastAlertTs: 7, alertCount: 1, lastStampTs: 3,
  }), true, 'saveStateAtomic reporta si pudo persistir');
  assert.deepEqual(wd.loadState(file), {
    ...EMPTY_STATE,
    lastMovementTs: 5, lastSignature: '2:9', lastAlertTs: 7, alertCount: 1, lastStampTs: 3,
  });
  // Corrupto → default (fail-soft)
  fs.writeFileSync(file, '{no json');
  assert.deepEqual(wd.loadState(file), EMPTY_STATE);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ─── SEC-4 (rev-5) · el cooldown no puede apagar el control ─────────────────
//
// `parsePositiveMinutes` gobierna `alert_cooldown_minutes` y no tenía cota superior:
// `999999` desactivaba el watchdog de hecho (30 días sin despachar y 5 elegibles
// daban `skip cooldown`) — un control apagado indistinguible de "todo OK", que
// es el meta-bug de este mismo issue. El backoff exponencial lo amplifica hasta
// MAX_ALERT_BACKOFF_FACTOR (16x). Mismo tope y mismo fail-closed que
// `parseStallMinutes`.

test('un cooldown absurdo cae al default y NO desactiva el control', () => {
  assert.equal(wd.parsePositiveMinutes(999999, 30), 30, 'fuera de rango => default');
  assert.equal(wd.parsePositiveMinutes('999999', 30), 30, 'string fuera de rango => default');
  assert.equal(wd.parsePositiveMinutes(wd.MAX_STALL_MINUTES, 30), wd.MAX_STALL_MINUTES, 'el tope es válido');
  assert.equal(wd.parsePositiveMinutes(wd.MAX_STALL_MINUTES + 1, 30), 30, 'un minuto más ya cae al default');
  assert.equal(wd.parsePositiveMinutes(45, 30), 45, 'un valor legítimo se respeta');
  assert.equal(wd.parsePositiveMinutes(0, 30), 30, 'cero => default (no desactiva)');
  assert.equal(wd.parsePositiveMinutes(-5, 30), 30, 'negativo => default');
  assert.equal(wd.parsePositiveMinutes(null, 30), 30, 'null => default');
});

// ─── rev-7 (BLOQUEANTE) · el tick está en MILISEGUNDOS ─────────────────────
//
// El parser de minutos ([1, 1440]) se estaba usando para `tick_ms`: con el
// `tick_ms: 60000` de config.yaml devolvía 1, y el `setInterval` del brazo
// corría cada 1 ms en vez de cada 60 s (log de arranque: "iniciado: cada 0s").
// Como el cuerpo del tick tarda más que eso, el callback se re-encolaba sin
// pausa y ocupaba el event loop del Pulpo. La suite pasaba en verde porque
// consagraba el clamp de minutos en vez de detectar el choque de unidades.

test('tick_ms 60000 arranca el brazo cada 60 s, no cada 1 ms', () => {
  const tickMs = wd.parseTickMs(60000, wd.DEFAULT_TICK_MS);
  assert.equal(tickMs, 60000, 'el valor de config.yaml se respeta tal cual, en ms');
  assert.equal(Math.round(tickMs / 1000), 60, 'el log de arranque debe decir 60s, no 0s');
  // El parser de minutos es justamente el que NO sirve acá: se deja asertado
  // para que quede explícito por qué son dos helpers y no uno.
  assert.equal(wd.parsePositiveMinutes(60000, 60000), 1, 'el parser de minutos degradaba 60000 a 1');
});

test('el período del brazo nunca satura el event loop ni apaga el control', () => {
  assert.equal(wd.parseTickMs(1, wd.DEFAULT_TICK_MS), wd.DEFAULT_TICK_MS,
    '1 ms está por debajo del piso => default (no satura el loop)');
  assert.equal(wd.parseTickMs(wd.MIN_TICK_MS - 1, wd.DEFAULT_TICK_MS), wd.DEFAULT_TICK_MS,
    'un ms por debajo del piso ya cae al default');
  assert.equal(wd.parseTickMs(wd.MIN_TICK_MS, wd.DEFAULT_TICK_MS), wd.MIN_TICK_MS,
    'el piso exacto es válido');
  assert.equal(wd.parseTickMs(wd.MAX_TICK_MS, wd.DEFAULT_TICK_MS), wd.MAX_TICK_MS,
    'el techo exacto es válido');
  assert.equal(wd.parseTickMs(wd.MAX_TICK_MS + 1, wd.DEFAULT_TICK_MS), wd.DEFAULT_TICK_MS,
    'por encima del techo => default (el control no queda de facto apagado)');
  assert.equal(wd.parseTickMs('30000', wd.DEFAULT_TICK_MS), 30000, 'string numérico válido se respeta');
  assert.equal(wd.parseTickMs(0, wd.DEFAULT_TICK_MS), wd.DEFAULT_TICK_MS, 'cero => default');
  assert.equal(wd.parseTickMs(-5, wd.DEFAULT_TICK_MS), wd.DEFAULT_TICK_MS, 'negativo => default');
  assert.equal(wd.parseTickMs(null, wd.DEFAULT_TICK_MS), wd.DEFAULT_TICK_MS, 'null => default');
  assert.equal(wd.parseTickMs('abc', wd.DEFAULT_TICK_MS), wd.DEFAULT_TICK_MS, 'no numérico => default');
  assert.equal(wd.parseTickMs(1.5, wd.DEFAULT_TICK_MS), wd.DEFAULT_TICK_MS, 'no entero => default');
  // Fallback inválido: no puede propagar el bug por la puerta de atrás.
  assert.equal(wd.parseTickMs(null, 1), wd.DEFAULT_TICK_MS, 'fallback fuera de rango => DEFAULT_TICK_MS');
});

test('el tick_ms real de config.yaml da un intervalo sano', () => {
  // Lee el config de verdad: si alguien vuelve a poner un valor patológico,
  // este test lo levanta antes de que el Pulpo lo cargue en producción.
  const fsReal = require('fs');
  const pathReal = require('path');
  const cfgPath = pathReal.join(__dirname, '..', 'config.yaml');
  const raw = fsReal.readFileSync(cfgPath, 'utf8');
  // Acotado al bloque `wave_watchdog:` — hay otros `tick_ms` en config.yaml
  // (p.ej. `credential_rotation`, 1800000) y un match global agarraría el
  // primero, testeando una clave que no es la de este brazo.
  const bloque = raw.split(/^wave_watchdog:\s*$/m)[1];
  assert.ok(bloque, 'el bloque wave_watchdog debe existir en config.yaml');
  const soloBloque = bloque.split(/^[a-z_]+:/m)[0];  // corta en la próxima clave top-level
  const m = soloBloque.match(/^\s{2}tick_ms:\s*(\d+)/m);
  assert.ok(m, 'wave_watchdog.tick_ms debe existir en config.yaml');
  const efectivo = wd.parseTickMs(parseInt(m[1], 10), wd.DEFAULT_TICK_MS);
  assert.equal(efectivo, parseInt(m[1], 10), 'el valor de config no debe ser degradado por el parser');
  assert.ok(efectivo >= wd.MIN_TICK_MS, `el intervalo efectivo (${efectivo}ms) no puede saturar el event loop`);
});

test('con cooldown absurdo el watchdog sigue alertando tras 30 días sin despachar', () => {
  // Reproducción del hallazgo: antes daba `skip cooldown` para siempre.
  const treintaDias = 30 * 24 * 60;
  const f = stalledFacts({
    now: (treintaDias + 100) * MIN,
    enabledCount: 5,
    cooldownMinutes: 999999,
    state: { lastMovementTs: 100 * MIN, lastSignature: '0:42', lastAlertTs: 100 * MIN, alertCount: 1 },
  });
  const d = wd.decide(f);
  assert.notEqual(d.action, 'skip', `30 días sin despachar con 5 elegibles no puede ser skip (${d.reason})`);
  assert.ok(['alert', 'escalate'].includes(d.action), `debe avisar; dio ${d.action}`);
});

// ─── #5400 (rev-8) · Episodio y backoff OBSERVABLES ────────────────────────
//
// El QA visual contra el mockup 47 encontró que CA-4 ("el aviso no se repite en
// cada ciclo: hay backoff verificable") sólo era verificable leyendo el código:
// `decide()` no devolvía ni el id del episodio, ni cuántos avisos van, ni cuándo
// puede salir el próximo, así que el dashboard no tenía con qué mostrarlo.

test('#5400 la decisión expone el episodio y el backoff proyectado', () => {
  const f = stalledFacts({
    now: 100 * MIN,
    state: { lastMovementTs: 60 * MIN, lastSignature: '0:42', lastAlertTs: 0, alertCount: 0 },
  });
  const d = wd.decide(f);
  assert.equal(d.action, 'alert');
  assert.equal(d.alertCount, 1, 'el aviso recién emitido tiene que contarse ya');
  assert.equal(d.lastAlertTs, 100 * MIN);
  // Primer aviso => backoff x1 => próximo recién tras el cooldown completo.
  assert.equal(d.nextAlertTs, 100 * MIN + 30 * MIN);
  assert.equal(d.alertEtaTs, null, 'ya se avisó: la ETA del primer aviso no aplica');
  assert.ok(d.episodeId, 'el episodio tiene que tener id');
  assert.match(d.episodeId, /^[0-9a-z]{4}$/);
});

test('#5400 el backoff proyectado duplica la espera igual que el paso que lo aplica', () => {
  // 3 avisos emitidos => el 4to espera cooldown * 2^(4-1)... el proyectado usa el
  // contador YA actualizado, o sea 2^(alertCount-1) sobre el nuevo valor.
  const f = stalledFacts({
    now: 200 * MIN,
    state: { lastMovementTs: 60 * MIN, lastSignature: '0:42', lastAlertTs: 100 * MIN, alertCount: 2 },
  });
  const d = wd.decide(f);
  assert.equal(d.action, 'escalate');
  assert.equal(d.alertCount, 3);
  // 2^(3-1) = 4 => 30 min * 4 = 120 min de espera antes del próximo.
  assert.equal(d.nextAlertTs, 200 * MIN + 120 * MIN);
});

test('#5400 sin avisos emitidos la decisión dice CUÁNDO avisaría y con qué umbral', () => {
  const f = stalledFacts({
    now: 70 * MIN,
    stallMinutes: 20,
    state: { lastMovementTs: 60 * MIN, lastSignature: '0:42', lastAlertTs: 0, alertCount: 0 },
  });
  const d = wd.decide(f);
  assert.equal(d.action, 'skip');
  assert.equal(d.reason, 'within-threshold');
  assert.equal(d.alertCount, 0);
  assert.equal(d.nextAlertTs, null);
  // Arrancó a los 60 min, umbral 20 => avisaría a los 80 min.
  assert.equal(d.alertEtaTs, 80 * MIN);
  assert.equal(d.alertThresholdMinutes, 20);
});

test('#5400 con causa declarada vigente el umbral anunciado es el de ESCALADA', () => {
  const f = stalledFacts({
    now: 70 * MIN,
    stallMinutes: 20,
    declaredCauseEscalateMinutes: 45,
    cause: { declared: true, kind: 'human-halt', readable: true },
    state: { lastMovementTs: 60 * MIN, lastSignature: '0:42', lastAlertTs: 0, alertCount: 0 },
  });
  const d = wd.decide(f);
  assert.equal(d.alertThresholdMinutes, 45,
    'con causa declarada el operador espera el aviso a los 45, no a los 20');
  assert.equal(d.alertEtaTs, 60 * MIN + 45 * MIN);
});

// Regla de copy 7 del mockup 47: un episodio, una conversación.
test('#5400 aviso, re-aviso y recuperación llevan el MISMO id de episodio', () => {
  const inicio = 60 * MIN;
  const primero = wd.decide(stalledFacts({
    now: 100 * MIN,
    state: { lastMovementTs: inicio, lastSignature: '0:42', lastAlertTs: 0, alertCount: 0 },
  }));
  const segundo = wd.decide(stalledFacts({
    now: 200 * MIN,
    state: { lastMovementTs: inicio, lastSignature: '0:42', lastAlertTs: 100 * MIN, alertCount: 1 },
  }));
  assert.equal(primero.episodeId, segundo.episodeId, 'el episodio no cambió: el id tampoco');
  assert.ok(primero.message.includes(`Episodio ${primero.episodeId}`));
  assert.ok(primero.message.includes('aviso 1'));
  assert.ok(segundo.message.includes(`Episodio ${segundo.episodeId}`));
  assert.ok(segundo.message.includes('aviso 2'));

  // Y la recuperación cierra ESE episodio, no el reloj ya reiniciado.
  const reanuda = wd.decide(stalledFacts({
    now: 210 * MIN,
    lastDispatchTs: 205 * MIN,
    state: {
      lastMovementTs: inicio, lastSignature: '0:42', lastAlertTs: 200 * MIN,
      alertCount: 2, lastStampTs: inicio,
    },
  }));
  assert.ok(reanuda.recovery, 'tiene que haber aviso de recuperación');
  assert.equal(reanuda.recovery.episodeId, primero.episodeId);
  assert.ok(reanuda.recovery.message.includes(`Episodio ${primero.episodeId}`));
  assert.ok(reanuda.recovery.message.includes('2 aviso(s) emitido(s)'));

  // SEC-1 — el sufijo de episodio NO puede introducir metacaracteres: un `[`
  // suelto tumba el parseo de Markdown legacy y el aviso muere en `fallido/`.
  // Mismo set que el resto de la suite (`_` lo cubre `escapeMarkdownLegacy` en
  // la capa de emisión; el `needs_attention` del cierre lo prueba).
  for (const m of [primero.message, segundo.message, reanuda.recovery.message]) {
    assert.ok(!/[*`[\]]/.test(m), m);
  }
});

test('#5400 el id de episodio es determinístico y cambia cuando cambia el episodio', () => {
  assert.equal(wd.episodeId(60 * MIN), wd.episodeId(60 * MIN), 'misma entrada, mismo id');
  assert.notEqual(wd.episodeId(60 * MIN), wd.episodeId(600 * MIN));
  assert.equal(wd.episodeId(0), null, 'sin episodio no se inventa un id');
  assert.equal(wd.episodeId(null), null);
  assert.equal(wd.episodeId(-5), null);
});

// El bug que originó el rechazo, visto desde el emisor: la duración del canal.
test('#5400 el aviso de Telegram expresa 1h33 en dos unidades, nunca redondeado', () => {
  assert.equal(wd.formatDurationEs(93 * 60 * 1000), '1 h 33 min');
  const d = wd.decide(stalledFacts({
    now: 153 * MIN,
    state: { lastMovementTs: 60 * MIN, lastSignature: '0:42', lastAlertTs: 0, alertCount: 0 },
  }));
  assert.ok(d.message.includes('1 h 33 min'), d.message);
});
