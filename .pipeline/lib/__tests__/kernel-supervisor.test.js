'use strict';

// =============================================================================
// kernel-supervisor.test.js — Tests del supervisor de instancias (Ola Puente P4 · #4762)
//
// Mapea los criterios de aceptación del issue #4762 (con la store in-memory real,
// offline):
//   CA-1  bootProducts() instancia EXACTAMENTE UNO por producto `active`;
//         onboarding/archived NO se instancian; A no pisa B.
//   CA-2  Aislamiento durable + efímero por projectId:
//           A01 · projectId manipulado → KernelStoreIsolationError (fail-closed).
//           A05 · efímeros de A (cooldowns/offsets/circuit-breaker/rebotes) no
//                 observables ni mutables desde B; cero estado de módulo compartido.
//   CA-3  Aislamiento de fallo/reinicio: restartInstance(A) no toca a B.
//   CA-4  Validación de id fail-closed (isSafeId) anti path-traversal / injection.
//   CA-5  Suite node --test verde + cobertura ≥ 80%.
// =============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');

const { createInMemoryDynamoDriver } = require('../provisioner-infra');
const { createKernelStore, KernelStoreIsolationError } = require('../kernel-store');
const { createKernelSupervisor, resolveProjectId } = require('../kernel-supervisor');
const { isSafeId } = require('../project-descriptor');
const { isSafeProjectId, segmentProductState } = require('../product-state-segment');

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

// Store fake mínimo que sólo expone listProducts() (rol de catálogo/control-plane).
function fakeCatalogStore(products) {
  return { listProducts: async () => products.slice() };
}

// storeFactory fake: crea un store in-memory REAL por projectId (aislamiento
// durable garantizado por kernel-store). Cada llamada obtiene su propio driver,
// de modo que las particiones no se comparten a nivel de driver tampoco.
function realStoreFactory(opts) {
  return createKernelStore({
    driver: createInMemoryDynamoDriver(),
    contextProjectId: opts.contextProjectId,
    allowedNamespaces: opts.allowedNamespaces,
    onAlert: opts.onAlert,
  });
}

// storeFactory fake que registra las llamadas y devuelve un handle liviano.
function recordingStoreFactory(calls) {
  return (opts) => {
    calls.push(opts);
    return { contextProjectId: opts.contextProjectId, getDescriptor: async () => null };
  };
}

const CATALOG_MIXTO = [
  { productId: 'acme', projectId: 'acme', name: 'ACME', status: 'active' },
  { productId: 'globex', projectId: 'globex', name: 'Globex', status: 'active' },
  { productId: 'initech', projectId: 'initech', name: 'Initech', status: 'onboarding' },
  { productId: 'umbrella', projectId: 'umbrella', name: 'Umbrella', status: 'archived' },
];

// -----------------------------------------------------------------------------
// CA-1 · Registro de productos e instanciación exacta
// -----------------------------------------------------------------------------

test('CA-1 · bootProducts instancia exactamente uno por producto active y omite inactivos', async () => {
  const calls = [];
  const supervisor = createKernelSupervisor({
    catalogStore: fakeCatalogStore(CATALOG_MIXTO),
    storeFactory: recordingStoreFactory(calls),
    hydrate: false,
  });

  const res = await supervisor.bootProducts();

  assert.deepEqual(res.spawned.sort(), ['acme', 'globex']);
  assert.equal(supervisor.listInstances().length, 2, 'solo 2 activos instanciados');
  assert.ok(supervisor.getInstance('acme'), 'acme instanciado');
  assert.ok(supervisor.getInstance('globex'), 'globex instanciado');
  assert.equal(supervisor.getInstance('initech'), null, 'onboarding NO instanciado');
  assert.equal(supervisor.getInstance('umbrella'), null, 'archived NO instanciado');
  // cada instancia activa ligó su store a su propio projectId
  assert.deepEqual(calls.map((c) => c.contextProjectId).sort(), ['acme', 'globex']);
  assert.deepEqual(calls.find((c) => c.contextProjectId === 'acme').allowedNamespaces, ['acme']);
});

// #4801 · CA-3 — bootProducts drena la cola de onboarding ANTES de listar.
test('CA-3 · bootProducts invoca el drenador de onboarding antes de listProducts', async () => {
  const order = [];
  const supervisor = createKernelSupervisor({
    catalogStore: { listProducts: async () => { order.push('list'); return []; } },
    drainOnboardQueue: () => { order.push('drain'); },
    hydrate: false,
  });
  await supervisor.bootProducts();
  assert.deepEqual(order, ['drain', 'list'], 'el drenaje corre antes de listar el catálogo');
});

test('CA-3 · un fallo del drenador NO tumba bootProducts (best-effort)', async () => {
  const alerts = [];
  const supervisor = createKernelSupervisor({
    catalogStore: fakeCatalogStore(CATALOG_MIXTO),
    storeFactory: recordingStoreFactory([]),
    hydrate: false,
    drainOnboardQueue: () => { throw new Error('drain boom'); },
    onAlert: (a) => alerts.push(a),
  });
  const res = await supervisor.bootProducts();
  assert.deepEqual(res.spawned.sort(), ['acme', 'globex'], 'los activos igual se instancian');
  assert.ok(alerts.some(a => a.stage === 'drain-onboard'), 'se emitió alerta del fallo de drenaje');
});

test('CA-3 · drainOnboardQueue:false desactiva el drenaje en bootProducts', async () => {
  const supervisor = createKernelSupervisor({
    catalogStore: fakeCatalogStore([]),
    hydrate: false,
    drainOnboardQueue: false,
  });
  const res = await supervisor.bootProducts();
  assert.deepEqual(res.spawned, []);
});

test('CA-1 · spawnInstance es idempotente: exactamente una instancia por projectId', async () => {
  const supervisor = createKernelSupervisor({
    catalogStore: fakeCatalogStore([]),
    storeFactory: recordingStoreFactory([]),
    hydrate: false,
  });
  const a1 = supervisor.spawnInstance({ productId: 'acme', projectId: 'acme', status: 'active' });
  const a2 = supervisor.spawnInstance({ productId: 'acme', projectId: 'acme', status: 'active' });
  assert.equal(a1, a2, 'devuelve la MISMA instancia (no duplica)');
  assert.equal(supervisor.listInstances().length, 1);
});

test('CA-1 · A no pisa B: escrituras durables en A no son visibles en B', async () => {
  const supervisor = createKernelSupervisor({
    catalogStore: fakeCatalogStore(CATALOG_MIXTO),
    storeFactory: realStoreFactory,
    hydrate: false,
  });
  await supervisor.bootProducts();
  const a = supervisor.getInstance('acme');
  const b = supervisor.getInstance('globex');

  await a.store.putProduct({ productId: 'secret-a', name: 'Secreto de A', status: 'active' });
  const listedInA = await a.store.listProducts();
  const listedInB = await b.store.listProducts();

  assert.ok(listedInA.some((p) => p.productId === 'secret-a'), 'A ve su propio dato');
  assert.ok(!listedInB.some((p) => p.productId === 'secret-a'), 'B NO ve el dato de A');
});

// -----------------------------------------------------------------------------
// CA-2 · A01 · projectId manipulado → falla cerrado
// -----------------------------------------------------------------------------

test('CA-2/A01 · store de A rechaza operar la partición de B (KernelStoreIsolationError)', async () => {
  const supervisor = createKernelSupervisor({
    catalogStore: fakeCatalogStore(CATALOG_MIXTO),
    storeFactory: realStoreFactory,
    hydrate: false,
  });
  await supervisor.bootProducts();
  const a = supervisor.getInstance('acme');

  // A intenta leer el descriptor de B con un projectId manipulado in-band.
  await assert.rejects(
    () => a.store.getDescriptor('globex'),
    (err) => err instanceof KernelStoreIsolationError,
    'falla cerrado sin fuga de datos de B',
  );
  // el store de A quedó ligado inmutablemente a 'acme'
  assert.equal(a.store.contextProjectId, 'acme');
});

test('CA-2/A01 · buildInstance falla cerrado si el factory devuelve un store de otra partición', () => {
  const supervisor = createKernelSupervisor({
    catalogStore: fakeCatalogStore([]),
    // factory malicioso/roto: devuelve un handle ligado a OTRO projectId
    storeFactory: () => ({ contextProjectId: 'otro-tenant', getDescriptor: async () => null }),
    hydrate: false,
  });
  assert.throws(
    () => supervisor.spawnInstance({ productId: 'acme', projectId: 'acme', status: 'active' }),
    (err) => err instanceof KernelStoreIsolationError,
  );
});

// -----------------------------------------------------------------------------
// CA-2 · A05 · efímeros de A no observables desde B
// -----------------------------------------------------------------------------

test('CA-2/A05 · estado efímero de A (cooldowns/offsets/circuit-breaker) no observable ni mutable desde B', async () => {
  const supervisor = createKernelSupervisor({
    catalogStore: fakeCatalogStore(CATALOG_MIXTO),
    storeFactory: recordingStoreFactory([]),
    hydrate: false,
  });
  await supervisor.bootProducts();
  const a = supervisor.getInstance('acme');
  const b = supervisor.getInstance('globex');

  // A setea todo su estado efímero
  a.cooldowns.set('dev', 12345);
  a.intakeOffsets.set('repo/main', 99);
  a.circuitBreaker.rebotes.set('issue-1', 3);

  // B tiene su propio estado efímero, aislado y vacío
  assert.equal(b.cooldowns.size, 0, 'cooldowns de B vacíos');
  assert.equal(b.intakeOffsets.size, 0, 'offsets de B vacíos');
  assert.equal(b.circuitBreaker.rebotes.size, 0, 'circuit-breaker de B vacío');

  // los Maps no son el mismo objeto (no hay handle compartido)
  assert.notEqual(a.cooldowns, b.cooldowns);
  assert.notEqual(a.circuitBreaker.rebotes, b.circuitBreaker.rebotes);

  // mutar B no toca A
  b.cooldowns.set('dev', 1);
  assert.equal(a.cooldowns.get('dev'), 12345, 'A intacto tras mutar B');
});

test('CA-2/A05 · dos supervisores NO comparten estado de módulo (mismo projectId, ctx distintos)', () => {
  const sup1 = createKernelSupervisor({ catalogStore: fakeCatalogStore([]), storeFactory: recordingStoreFactory([]), hydrate: false });
  const sup2 = createKernelSupervisor({ catalogStore: fakeCatalogStore([]), storeFactory: recordingStoreFactory([]), hydrate: false });

  const a1 = sup1.spawnInstance({ productId: 'acme', projectId: 'acme', status: 'active' });
  const a2 = sup2.spawnInstance({ productId: 'acme', projectId: 'acme', status: 'active' });

  a1.cooldowns.set('dev', 111);
  assert.notEqual(a1, a2, 'instancias de supervisores distintos son objetos distintos');
  assert.equal(a2.cooldowns.size, 0, 'el efímero de sup1 no aparece en sup2 (no hay Map de módulo)');
});

// -----------------------------------------------------------------------------
// #4776 · Circuit-breaker por producto (aislamiento de fallos · CA-1..CA-6)
//   CA-1/CA-3  A abre su breaker → B sigue closed e intacto (sin efecto cruzado).
//   CA-2       dos supervisores con el mismo projectId → breakers independientes.
//   CA-3       máquina de estados closed → open → half-open → closed (deps.now).
//   CA-4/CA-5  acceso fail-closed por projectId inseguro/inexistente (isSafeId).
//   CA-6       getBreakerState devuelve copia solo-lectura (no la ref viva).
//   A09        apertura del breaker propagada por onAlert con projectId de origen.
// -----------------------------------------------------------------------------

// Reloj controlado: los tests de ventana/cooldown son deterministas sin Date.now().
function fakeClock(start = 0) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

// Supervisor con umbrales chicos e inyectados para ejercitar el breaker rápido.
function breakerSupervisor(clock, over = {}) {
  return createKernelSupervisor({
    catalogStore: fakeCatalogStore([]),
    storeFactory: recordingStoreFactory([]),
    hydrate: false,
    now: clock.now,
    breakerThreshold: 3,
    breakerWindowMs: 1000,
    breakerCooldownMs: 500,
    breakerRecoveryMs: 500,
    ...over,
  });
}

test('CA-1/CA-3 · A abre su breaker por rebotes y B sigue closed e intacto (aislamiento de fallos)', () => {
  const clock = fakeClock();
  const sup = breakerSupervisor(clock);
  const a = sup.spawnInstance({ productId: 'acme', projectId: 'acme', status: 'active' });
  const b = sup.spawnInstance({ productId: 'globex', projectId: 'globex', status: 'active' });

  // A acumula fallos hasta superar el umbral (3) → open
  sup.recordBreakerFailure('acme');
  sup.recordBreakerFailure('acme');
  const st = sup.recordBreakerFailure('acme');
  assert.equal(st.state, 'open', 'A abre su breaker al 3er fallo');
  assert.equal(st.failureCount, 3);
  assert.equal(sup.getBreakerState('acme').state, 'open');

  // B no fue tocado: sigue closed, sin fallos, con su rebotes intacto
  const stB = sup.getBreakerState('globex');
  assert.equal(stB.state, 'closed', 'B sigue closed pese a que A abrió');
  assert.equal(stB.failureCount, 0, 'B sin fallos');
  assert.equal(b.circuitBreaker.rebotes.size, 0, 'rebotes de B intacto');

  // los objetos circuitBreaker de A y B son distintos y no observables entre sí
  assert.notEqual(a.circuitBreaker, b.circuitBreaker);
  assert.notEqual(a.circuitBreaker.rebotes, b.circuitBreaker.rebotes);
});

test('CA-3 · máquina de estados closed → open → half-open → closed con reloj inyectado', () => {
  const clock = fakeClock();
  const sup = breakerSupervisor(clock);
  sup.spawnInstance({ productId: 'acme', projectId: 'acme', status: 'active' });

  // closed → open (supera umbral en ventana)
  sup.recordBreakerFailure('acme');
  sup.recordBreakerFailure('acme');
  sup.recordBreakerFailure('acme');
  assert.equal(sup.getBreakerState('acme').state, 'open', 'closed → open al superar el umbral');

  // open → half-open tras cooldown (500ms)
  clock.advance(500);
  assert.equal(sup.getBreakerState('acme').state, 'half-open', 'open → half-open tras cooldown');

  // half-open → closed tras recovery (otros 500ms) sin nuevos fallos
  clock.advance(500);
  assert.equal(sup.getBreakerState('acme').state, 'closed', 'half-open → closed al recuperarse');
});

test('CA-3 · un fallo en half-open re-abre el breaker inmediatamente y reescribe openedAt', () => {
  const clock = fakeClock();
  const sup = breakerSupervisor(clock);
  sup.spawnInstance({ productId: 'acme', projectId: 'acme', status: 'active' });

  sup.recordBreakerFailure('acme');
  sup.recordBreakerFailure('acme');
  sup.recordBreakerFailure('acme');            // open
  clock.advance(500);                            // → half-open
  assert.equal(sup.getBreakerState('acme').state, 'half-open');

  const st = sup.recordBreakerFailure('acme');  // fallo en la prueba → open de nuevo
  assert.equal(st.state, 'open', 'un fallo en half-open re-abre');
  assert.equal(st.openedAt, clock.now(), 'openedAt reescrito al re-abrir');
});

test('CA-3 · la ventana deslizante resetea el contador de fallos si expira sin abrir', () => {
  const clock = fakeClock();
  const sup = breakerSupervisor(clock);
  sup.spawnInstance({ productId: 'acme', projectId: 'acme', status: 'active' });

  sup.recordBreakerFailure('acme');
  sup.recordBreakerFailure('acme');
  assert.equal(sup.getBreakerState('acme').failureCount, 2, 'dos fallos en la ventana');

  clock.advance(1000);                           // la ventana (1000ms) expira
  const st = sup.recordBreakerFailure('acme');   // este fallo arranca ventana nueva
  assert.equal(st.state, 'closed', 'no abre: la ventana se reseteó');
  assert.equal(st.failureCount, 1, 'contador reiniciado tras expirar la ventana');
});

test('CA-2 · dos supervisores con el mismo projectId tienen breakers independientes (cero estado de módulo)', () => {
  const clock = fakeClock();
  const sup1 = breakerSupervisor(clock);
  const sup2 = breakerSupervisor(clock);
  sup1.spawnInstance({ productId: 'acme', projectId: 'acme', status: 'active' });
  sup2.spawnInstance({ productId: 'acme', projectId: 'acme', status: 'active' });

  sup1.recordBreakerFailure('acme');
  sup1.recordBreakerFailure('acme');
  sup1.recordBreakerFailure('acme');

  assert.equal(sup1.getBreakerState('acme').state, 'open', 'sup1 abrió su breaker');
  assert.equal(sup2.getBreakerState('acme').state, 'closed', 'sup2 intacto: no hay contador de módulo compartido');
  assert.equal(sup2.getBreakerState('acme').failureCount, 0);
});

test('CA-4/CA-5 · breaker fail-closed: projectId inseguro/inexistente → null sin derivación', () => {
  const clock = fakeClock();
  const sup = breakerSupervisor(clock);
  sup.spawnInstance({ productId: 'acme', projectId: 'acme', status: 'active' });

  // ids maliciosos rechazados por isSafeId (vía getInstance) antes de tocar estado
  for (const bad of ['../evil', 'a/b', 'a\\b', '..', '', null, undefined]) {
    assert.equal(sup.recordBreakerFailure(bad), null, `recordBreakerFailure fail-closed para ${String(bad)}`);
    assert.equal(sup.getBreakerState(bad), null, `getBreakerState fail-closed para ${String(bad)}`);
  }
  // instancia inexistente (id seguro pero sin instancia) → null idempotente
  assert.equal(sup.recordBreakerFailure('globex'), null, 'inexistente → null idempotente');
  assert.equal(sup.getBreakerState('globex'), null);
});

test('CA-6 · getBreakerState devuelve copia: mutar el retorno no altera el estado interno', () => {
  const clock = fakeClock();
  const sup = breakerSupervisor(clock);
  const a = sup.spawnInstance({ productId: 'acme', projectId: 'acme', status: 'active' });
  sup.recordBreakerFailure('acme');

  const snap = sup.getBreakerState('acme');
  snap.state = 'open';
  snap.failureCount = 999;
  snap.openedAt = 123456;

  assert.equal(a.circuitBreaker.state, 'closed', 'estado interno intacto tras mutar la copia');
  assert.equal(a.circuitBreaker.failureCount, 1);
  assert.equal(a.circuitBreaker.openedAt, null);
  assert.notEqual(snap, sup.getBreakerState('acme'), 'cada lectura es una copia nueva');
});

test('A09 · la apertura del breaker se propaga por onAlert con el projectId de origen', () => {
  const clock = fakeClock();
  const alerts = [];
  const sup = breakerSupervisor(clock, { onAlert: (a) => alerts.push(a) });
  sup.spawnInstance({ productId: 'acme', projectId: 'acme', status: 'active' });

  sup.recordBreakerFailure('acme');
  sup.recordBreakerFailure('acme');
  sup.recordBreakerFailure('acme');

  const open = alerts.filter((a) => a.stage === 'breaker-open');
  assert.ok(open.length >= 1, 'la apertura del breaker se alerta (A09)');
  assert.equal(open[0].projectId, 'acme', 'con projectId de origen, sin fuga de otro tenant');
});

// -----------------------------------------------------------------------------
// CA-3 · Aislamiento de fallo / reinicio
// -----------------------------------------------------------------------------

test('CA-3 · restartInstance(A) recrea sólo A y no altera el estado de B', async () => {
  const stopped = [];
  const supervisor = createKernelSupervisor({
    catalogStore: fakeCatalogStore(CATALOG_MIXTO),
    storeFactory: recordingStoreFactory([]),
    stop: (ctx) => stopped.push(ctx.projectId),
    hydrate: false,
  });
  await supervisor.bootProducts();
  const aOld = supervisor.getInstance('acme');
  const b = supervisor.getInstance('globex');
  aOld.cooldowns.set('dev', 500);
  b.cooldowns.set('dev', 700);

  const aNew = supervisor.restartInstance('acme');

  assert.notEqual(aNew, aOld, 'A fue recreada (ctx nuevo)');
  assert.equal(aNew.health.restarts, 1, 'contador de restarts preservado/incrementado');
  assert.equal(aNew.cooldowns.size, 0, 'estado efímero de A reseteado');
  assert.deepEqual(stopped, ['acme'], 'sólo se detuvo A');
  // B intacto
  assert.equal(supervisor.getInstance('globex'), b, 'B es la MISMA instancia');
  assert.equal(b.cooldowns.get('dev'), 700, 'estado efímero de B intacto');
});

test('CA-3 · restartInstance sobre projectId inexistente devuelve null', () => {
  const supervisor = createKernelSupervisor({ catalogStore: fakeCatalogStore([]), storeFactory: recordingStoreFactory([]), hydrate: false });
  assert.equal(supervisor.restartInstance('nadie'), null);
});

test('CA-3 · healthcheck con autoRestart reinicia sólo las instancias caídas', async () => {
  let health = { acme: true, globex: true };
  const supervisor = createKernelSupervisor({
    catalogStore: fakeCatalogStore(CATALOG_MIXTO),
    storeFactory: recordingStoreFactory([]),
    healthProbe: (ctx) => health[ctx.projectId],
    hydrate: false,
  });
  await supervisor.bootProducts();

  // A cae, B sigue viva
  health.acme = false;
  const report = supervisor.healthcheck({ autoRestart: true });

  assert.equal(report.acme.restarted, true, 'A reiniciada');
  assert.equal(report.acme.restarts, 1);
  assert.notEqual(report.globex.restarted, true, 'B no reiniciada');
  assert.equal(report.globex.restarts, 0, 'B sin restarts');
});

test('CA-3 · markInstanceUnhealthy marca A caída sin tocar B', async () => {
  const alerts = [];
  const supervisor = createKernelSupervisor({
    catalogStore: fakeCatalogStore(CATALOG_MIXTO),
    storeFactory: recordingStoreFactory([]),
    onAlert: (a) => alerts.push(a),
    hydrate: false,
  });
  await supervisor.bootProducts();

  assert.equal(supervisor.markInstanceUnhealthy('acme', new Error('boom')), true);
  assert.equal(supervisor.getInstance('acme').health.alive, false);
  assert.equal(supervisor.getInstance('globex').health.alive, true, 'B sigue viva');
  assert.equal(supervisor.markInstanceUnhealthy('nadie'), false, 'inexistente → false');
  assert.ok(alerts.some((a) => a.stage === 'crash'), 'A09: crash alertado');
});

test('CA-3 · superviseInstance actualiza salud vía probe y aísla el fallo del probe', async () => {
  const supervisor = createKernelSupervisor({
    catalogStore: fakeCatalogStore(CATALOG_MIXTO),
    storeFactory: recordingStoreFactory([]),
    healthProbe: (ctx) => { if (ctx.projectId === 'acme') throw new Error('probe roto'); return true; },
    hydrate: false,
  });
  await supervisor.bootProducts();
  const snapA = supervisor.superviseInstance('acme');
  const snapB = supervisor.superviseInstance('globex');
  assert.equal(snapA.alive, false, 'probe que lanza → caída fail-closed');
  assert.equal(snapB.alive, true, 'B sana');
  assert.equal(supervisor.superviseInstance('nadie'), null);
});

// -----------------------------------------------------------------------------
// CA-4 · Validación de id fail-closed (anti path-traversal / injection)
// -----------------------------------------------------------------------------

test('CA-4 · bootProducts descarta projectId inseguro sin abortar el resto', async () => {
  const alerts = [];
  const catalog = [
    { productId: '../evil', projectId: '../evil', name: 'Path traversal', status: 'active' },
    { productId: 'a/b', projectId: 'a/b', name: 'Slash', status: 'active' },
    { productId: 'goodco', projectId: 'goodco', name: 'OK', status: 'active' },
  ];
  const supervisor = createKernelSupervisor({
    catalogStore: fakeCatalogStore(catalog),
    storeFactory: recordingStoreFactory([]),
    onAlert: (a) => alerts.push(a),
    hydrate: false,
  });
  const res = await supervisor.bootProducts();
  assert.deepEqual(res.spawned, ['goodco'], 'sólo el id seguro se instancia');
  assert.equal(res.skipped.filter((s) => s.reason === 'projectId inseguro').length, 2);
  assert.ok(alerts.some((a) => a.stage === 'isSafeId'), 'A09: id inseguro alertado');
});

test('CA-4 · spawnInstance lanza fail-closed ante projectId inseguro', () => {
  const supervisor = createKernelSupervisor({ catalogStore: fakeCatalogStore([]), storeFactory: recordingStoreFactory([]), hydrate: false });
  assert.throws(
    () => supervisor.spawnInstance({ productId: '../../etc/passwd', projectId: '../../etc/passwd', status: 'active' }),
    (err) => err instanceof KernelStoreIsolationError,
  );
});

test('CA-4 · getInstance/restartInstance fail-closed sobre id inseguro', () => {
  const supervisor = createKernelSupervisor({ catalogStore: fakeCatalogStore([]), storeFactory: recordingStoreFactory([]), hydrate: false });
  assert.equal(supervisor.getInstance('bad/id'), null);
  assert.throws(() => supervisor.restartInstance('bad/id'), (err) => err instanceof KernelStoreIsolationError);
});

// -----------------------------------------------------------------------------
// Reuso de derivers + hidratación aislada (fault isolation en boot)
// -----------------------------------------------------------------------------

test('hydrate deriva routing/concurrencia/particiones del descriptor de la instancia', async () => {
  const descByPid = {
    acme: {
      identity: { projectId: 'acme', name: 'ACME' },
      board: { routing: [{ label: 'area:backend', capability: 'backend' }] },
      thresholds: { concurrency: { 'backend-dev': 2 } },
      capabilities: [{ interface: 'backend', skills: ['backend-dev'] }],
    },
  };
  const storeFactory = (opts) => ({
    contextProjectId: opts.contextProjectId,
    getDescriptor: async () => {
      const body = descByPid[opts.contextProjectId];
      return body ? { body } : null;
    },
  });
  const supervisor = createKernelSupervisor({
    catalogStore: fakeCatalogStore([{ productId: 'acme', projectId: 'acme', name: 'ACME', status: 'active' }]),
    storeFactory,
    hydrate: true,
  });
  await supervisor.bootProducts();
  const a = supervisor.getInstance('acme');
  assert.equal(a.routing.get('area:backend'), 'backend');
  assert.deepEqual(a.concurrency, { 'backend-dev': 2 });
  assert.deepEqual(a.partitions, { backend: ['backend-dev'] });
});

test('hydrate aislado: descriptor corrupto de A no aborta el boot de B (A04)', async () => {
  const alerts = [];
  const storeFactory = (opts) => ({
    contextProjectId: opts.contextProjectId,
    getDescriptor: async () => {
      if (opts.contextProjectId === 'acme') throw new Error('descriptor corrupto');
      return { body: { identity: { projectId: opts.contextProjectId } } };
    },
  });
  const supervisor = createKernelSupervisor({
    catalogStore: fakeCatalogStore(CATALOG_MIXTO),
    storeFactory,
    onAlert: (a) => alerts.push(a),
    hydrate: true,
  });
  const res = await supervisor.bootProducts();
  assert.deepEqual(res.spawned.sort(), ['acme', 'globex'], 'ambos instanciados pese al fallo de hidratación de A');
  assert.ok(supervisor.getInstance('acme').health.lastError, 'A registró su error de hidratación');
  assert.ok(alerts.some((a) => a.stage === 'hydrate'), 'A09: fallo de hidratación alertado');
});

// -----------------------------------------------------------------------------
// Lifecycle y guardas varias
// -----------------------------------------------------------------------------

test('spawn que lanza no tumba al supervisor (fault isolation A04)', () => {
  const alerts = [];
  const supervisor = createKernelSupervisor({
    catalogStore: fakeCatalogStore([]),
    storeFactory: recordingStoreFactory([]),
    spawn: () => { throw new Error('spawn falló'); },
    onAlert: (a) => alerts.push(a),
    hydrate: false,
  });
  const ctx = supervisor.spawnInstance({ productId: 'acme', projectId: 'acme', status: 'active' });
  assert.equal(ctx.handle, null);
  assert.equal(ctx.health.alive, false);
  assert.ok(alerts.some((a) => a.stage === 'spawn'));
});

test('spawn recibe el ctx propio y guarda el handle en la instancia', () => {
  const handles = {};
  const supervisor = createKernelSupervisor({
    catalogStore: fakeCatalogStore([]),
    storeFactory: recordingStoreFactory([]),
    spawn: (ctx) => { handles[ctx.projectId] = { pid: ctx.projectId }; return handles[ctx.projectId]; },
    hydrate: false,
  });
  const ctx = supervisor.spawnInstance({ productId: 'acme', projectId: 'acme', status: 'active' });
  assert.equal(ctx.handle, handles.acme);
});

test('stopInstance detiene y remueve; inexistente → false', async () => {
  const stopped = [];
  const supervisor = createKernelSupervisor({
    catalogStore: fakeCatalogStore(CATALOG_MIXTO),
    storeFactory: recordingStoreFactory([]),
    stop: (ctx) => stopped.push(ctx.projectId),
    hydrate: false,
  });
  await supervisor.bootProducts();
  assert.equal(supervisor.stopInstance('acme'), true);
  assert.equal(supervisor.getInstance('acme'), null);
  assert.deepEqual(stopped, ['acme']);
  assert.equal(supervisor.stopInstance('acme'), false, 'ya removida → false');
});

test('bootProducts sin catalogStore válido lanza error claro', async () => {
  const supervisor = createKernelSupervisor({ storeFactory: recordingStoreFactory([]), hydrate: false });
  await assert.rejects(() => supervisor.bootProducts(), /catalogStore/);
});

test('bootProducts tolera catálogo no-array y productos nulos', async () => {
  const supervisor = createKernelSupervisor({
    catalogStore: { listProducts: async () => null },
    storeFactory: recordingStoreFactory([]),
    hydrate: false,
  });
  const res = await supervisor.bootProducts();
  assert.deepEqual(res.spawned, []);
});

test('resolveProjectId: projectId explícito, fallback a productId, null si falta', () => {
  assert.equal(resolveProjectId({ projectId: 'a', productId: 'b' }), 'a');
  assert.equal(resolveProjectId({ productId: 'b' }), 'b');
  assert.equal(resolveProjectId({}), null);
  assert.equal(resolveProjectId(null), null);
});

// =============================================================================
// #4764 (split 3/3 de #4689) — Estado segmentado por producto + aislamiento de
// secretos. Requisitos de seguridad A01 (cross-tenant/IDOR), A02 (secretos) y
// A03 (path traversal) del análisis de definición.
// =============================================================================

function bootedSupervisor(catalog = CATALOG_MIXTO) {
  const supervisor = createKernelSupervisor({
    catalogStore: fakeCatalogStore(catalog),
    storeFactory: recordingStoreFactory([]),
    hydrate: false,
  });
  return supervisor;
}

// -----------------------------------------------------------------------------
// A01 · Aislamiento cross-tenant en la exposición de estado (CA-4)
// -----------------------------------------------------------------------------

test('A01 · getSegmentedState devuelve SÓLO los datos del projectId consultado (no filtra B)', async () => {
  const supervisor = bootedSupervisor();
  await supervisor.bootProducts();

  supervisor.recordInstanceState('acme', { metrics: { rebotes: 1 }, tokens: { in: 100, out: 50 }, times: { p50: 30 }, phase: 'dev' });
  supervisor.appendInstanceAudit('acme', { action: 'boot', actor: 'acme' });
  supervisor.recordInstanceState('globex', { metrics: { rebotes: 9 }, tokens: { in: 999, out: 999 }, phase: 'qa' });
  supervisor.appendInstanceAudit('globex', { action: 'boot', actor: 'globex' });

  const res = supervisor.getSegmentedState('acme', { authorizedProjectId: 'acme' });
  assert.equal(res.status, 200);
  assert.equal(res.payload.projectId, 'acme');
  assert.deepEqual(res.payload.tokens, { in: 100, out: 50 });
  assert.deepEqual(res.payload.metrics, { rebotes: 1 });
  assert.deepEqual(res.payload.audit, [{ action: 'boot', actor: 'acme' }]);
  // Ningún dato/métrica/token/tiempo/audit de B en la respuesta de A.
  const serialized = JSON.stringify(res.payload);
  assert.ok(!serialized.includes('999'), 'no filtra tokens de B');
  assert.ok(!serialized.includes('globex'), 'no filtra ni el id de B');
});

test('A01/CA-4.2 · anti-IDOR: consultar B desde contexto autorizado sólo para A → fail-closed', async () => {
  const supervisor = bootedSupervisor();
  await supervisor.bootProducts();
  supervisor.recordInstanceState('globex', { metrics: { secreto: 'de B' } });

  const res = supervisor.getSegmentedState('globex', { authorizedProjectId: 'acme' });
  assert.equal(res.status, 403, 'B no autorizado desde contexto de A');
  assert.equal(res.payload.error, 'forbidden');
  assert.equal(res.payload.metrics, undefined, 'no hay payload de datos');
});

test('A01/CA-4.3 · sin projectId → 403, NUNCA el agregado global', () => {
  const res = segmentProductState({
    stateByProjectId: { acme: { metrics: { a: 1 } }, globex: { metrics: { b: 2 } } },
  });
  assert.equal(res.status, 403);
  assert.equal(res.payload.error, 'forbidden');
  // Fail-closed: el payload no contiene ninguno de los productos.
  const s = JSON.stringify(res.payload);
  assert.ok(!s.includes('acme') && !s.includes('globex'), 'no devuelve el agregado');
});

test('A01/CA-4.3 · projectId inexistente → 403 (no fallback al agregado)', async () => {
  const supervisor = bootedSupervisor();
  await supervisor.bootProducts();
  const res = supervisor.getSegmentedState('no-existe', { authorizedProjectId: 'no-existe' });
  assert.equal(res.status, 403);
});

test('A01/CA-4.4 · audit# namespaceado: la consulta de A nunca devuelve auditoría de B', async () => {
  const supervisor = bootedSupervisor();
  await supervisor.bootProducts();
  supervisor.appendInstanceAudit('acme', { action: 'a-only' });
  supervisor.appendInstanceAudit('globex', { action: 'b-only' });
  const res = supervisor.getSegmentedState('acme', { authorizedProjectId: 'acme' });
  assert.deepEqual(res.payload.audit, [{ action: 'a-only' }]);
});

test('A01 · segmentProductState hace whitelist de campos (no passthrough del objeto crudo)', () => {
  const res = segmentProductState({
    requestedProjectId: 'acme',
    authorizedProjectIds: ['acme'],
    stateByProjectId: { acme: { metrics: { ok: 1 }, __internal: 'no-exponer', handle: { pid: 1 } } },
  });
  assert.equal(res.status, 200);
  assert.equal(res.payload.__internal, undefined, 'campo interno omitido');
  assert.equal(res.payload.handle, undefined, 'handle interno omitido');
  assert.deepEqual(res.payload.metrics, { ok: 1 });
});

// -----------------------------------------------------------------------------
// A02 · Aislamiento de secretos (CA-6 · CRÍTICO)
// -----------------------------------------------------------------------------

const CREDS_MULTI = {
  namespaces: {
    acme: { githubToken: 'ghp_acme_SECRET', anthropicKey: 'sk-acme-SECRET' },
    globex: { githubToken: 'ghp_globex_SECRET', anthropicKey: 'sk-globex-SECRET' },
  },
};

test('A02 · cada instancia resuelve SÓLO sus refs scoped (resolveScopedRefs, no el namespace de otro)', async () => {
  const supervisor = bootedSupervisor();
  await supervisor.bootProducts();

  const rA = supervisor.resolveInstanceSecrets('acme', { scopes: ['githubToken'], data: CREDS_MULTI });
  assert.equal(rA.ok, true);
  const a = supervisor.getInstance('acme');
  assert.deepEqual(a.secrets, { githubToken: 'ghp_acme_SECRET' }, 'A resuelve su propio scope');
  // El scope no pedido no se materializa; el secreto de B jamás aparece en A.
  assert.equal(a.secrets.anthropicKey, undefined, 'sólo el scope declarado');
  assert.ok(!JSON.stringify(a.secrets).includes('globex'), 'ningún secreto de B en A');

  const b = supervisor.getInstance('globex');
  assert.equal(b.secrets, null, 'B no resolvió nada todavía → sin secretos');
});

test('A02/CA-6.2 · el supervisor NO carga credenciales en process.env global', async () => {
  const before = { ...process.env };
  const supervisor = bootedSupervisor();
  await supervisor.bootProducts();
  supervisor.resolveInstanceSecrets('acme', { scopes: ['githubToken', 'anthropicKey'], data: CREDS_MULTI });

  // Ninguna key secreta terminó en process.env (no se llamó loadIntoEnv).
  const envDump = JSON.stringify(process.env);
  assert.ok(!envDump.includes('ghp_acme_SECRET'), 'token de A no está en process.env');
  assert.ok(!envDump.includes('sk-acme-SECRET'), 'key de A no está en process.env');
  // process.env intacto (mismas claves que antes; el supervisor no lo toca).
  assert.deepEqual(Object.keys(process.env).sort(), Object.keys(before).sort());
});

test('A02/CA-6.3 · redacción: meta expone sólo nombres de scope, nunca valores', async () => {
  const supervisor = bootedSupervisor();
  await supervisor.bootProducts();
  const r = supervisor.resolveInstanceSecrets('acme', { scopes: ['githubToken', 'anthropicKey'], data: CREDS_MULTI });
  assert.equal(r.ok, true);
  const metaDump = JSON.stringify(r.meta);
  assert.ok(!metaDump.includes('ghp_acme_SECRET') && !metaDump.includes('sk-acme-SECRET'), 'meta sin valores');
  assert.deepEqual(r.meta.scopes.sort(), ['anthropicKey', 'githubToken'], 'meta lista sólo nombres');
  // getInstance().secretsMeta también redactado (para logging seguro).
  const a = supervisor.getInstance('acme');
  assert.ok(!JSON.stringify(a.secretsMeta).includes('SECRET'), 'secretsMeta redactado');
});

test('A02 · fail-closed: scope faltante → no deja secretos parciales en el ctx + alerta', async () => {
  const alerts = [];
  const supervisor = createKernelSupervisor({
    catalogStore: fakeCatalogStore(CATALOG_MIXTO),
    storeFactory: recordingStoreFactory([]),
    onAlert: (a) => alerts.push(a),
    hydrate: false,
  });
  await supervisor.bootProducts();
  const r = supervisor.resolveInstanceSecrets('acme', { scopes: ['githubToken', 'noExiste'], data: CREDS_MULTI });
  assert.equal(r.ok, false, 'missing scope → fail-closed');
  assert.equal(supervisor.getInstance('acme').secrets, null, 'sin secretos parciales');
  assert.ok(alerts.some((a) => a.stage === 'secrets'), 'A09: fallo de resolución alertado');
});

// -----------------------------------------------------------------------------
// A03 · Path traversal / injection en id de producto y refs de secretos
// -----------------------------------------------------------------------------

const UNSAFE_IDS = ['../evil', '..', 'a/b', 'a\\b', '/etc/passwd', 'ACME', 'a b', '', 'x'.repeat(80)];

test('A03 · getSegmentedState rechaza projectId con traversal/separadores/patrón inválido', async () => {
  const supervisor = bootedSupervisor();
  await supervisor.bootProducts();
  for (const bad of UNSAFE_IDS) {
    const res = supervisor.getSegmentedState(bad, { authorizedProjectId: bad });
    assert.equal(res.status, 403, `id inseguro rechazado: ${JSON.stringify(bad)}`);
  }
});

test('A03 · resolveInstanceSecrets lanza fail-closed ante projectId inseguro (antes de derivar ref)', () => {
  const supervisor = bootedSupervisor();
  for (const bad of ['../otro', 'a/b', 'x\\y', '..']) {
    assert.throws(
      () => supervisor.resolveInstanceSecrets(bad, { scopes: ['x'], data: CREDS_MULTI }),
      (err) => err instanceof KernelStoreIsolationError,
      `id inseguro rechazado en secretos: ${bad}`,
    );
  }
});

test('A03 · segmentProductState no indexa el store con un id inseguro (no lee fuera del namespace)', () => {
  // Aunque el store tuviera una clave con nombre peligroso, el guard fail-closed
  // corta ANTES de indexar: nunca se resuelve.
  const stateByProjectId = { '../evil': { metrics: { leak: true } }, acme: { metrics: { ok: 1 } } };
  const res = segmentProductState({ requestedProjectId: '../evil', stateByProjectId });
  assert.equal(res.status, 403);
  assert.equal(res.payload.metrics, undefined);
});

test('A03 · isSafeProjectId espeja isSafeId de project-descriptor (anti-drift)', () => {
  const battery = [
    'acme', 'globex', 'a1', 'x-y-z', 'ab',
    ...UNSAFE_IDS, 'A', '1', 'a_b', 'a.b', 'a:b', 'con espacio', '..%2f', 'a'.repeat(64), 'a'.repeat(65),
    null, undefined, 123, {},
  ];
  for (const v of battery) {
    assert.equal(isSafeProjectId(v), isSafeId(v), `desacuerdo con isSafeId para ${JSON.stringify(v)}`);
  }
});

// -----------------------------------------------------------------------------
// #4805 CA-8 · Entrada automática al supervisor de un producto RECIÉN activado.
// Simula el flip onboarding→active entre dos reconciliaciones (bootProducts):
// el producto queda instanciado EXACTAMENTE una vez y la reconciliación es
// idempotente; onboarding/archived siguen omitidos.
// -----------------------------------------------------------------------------
test('#4805 CA-8 · bootProducts instancia el producto recién activado (idempotente)', async () => {
  // Catálogo mutable: initech arranca en onboarding y luego pasa a active.
  const catalog = [
    { productId: 'acme', projectId: 'acme', name: 'ACME', status: 'active' },
    { productId: 'initech', projectId: 'initech', name: 'Initech', status: 'onboarding' },
  ];
  const supervisor = createKernelSupervisor({
    catalogStore: { listProducts: async () => catalog.map((p) => ({ ...p })) },
    storeFactory: recordingStoreFactory([]),
    hydrate: false,
  });

  // 1ra reconciliación: initech (onboarding) NO se instancia.
  const first = await supervisor.bootProducts();
  assert.deepEqual(first.spawned.sort(), ['acme']);
  assert.equal(supervisor.getInstance('initech'), null, 'onboarding aún no instanciado');
  const acmeCtx1 = supervisor.getInstance('acme');

  // El kernel persiste la activación (project-descriptor.transitionStatus) ⇒ el
  // catálogo ahora reporta initech como active.
  catalog.find((p) => p.projectId === 'initech').status = 'active';

  // 2da reconciliación: initech entra al supervisor; acme NO se re-instancia
  // (spawnInstance es idempotente: devuelve la MISMA instancia, no duplica).
  const second = await supervisor.bootProducts();
  assert.ok(second.spawned.includes('initech'), 'el producto activado entra al supervisor');
  assert.ok(supervisor.getInstance('initech'), 'initech instanciado exactamente una vez');
  assert.equal(supervisor.getInstance('acme'), acmeCtx1, 'acme conserva la MISMA instancia (no re-spawnea)');
  assert.equal(supervisor.listInstances().length, 2, 'exactamente 2 instancias');

  // 3ra reconciliación idempotente: no cambia el conteo.
  await supervisor.bootProducts();
  assert.equal(supervisor.listInstances().length, 2, 'idempotente: sin duplicados');
});
