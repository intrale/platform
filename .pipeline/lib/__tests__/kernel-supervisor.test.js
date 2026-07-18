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
