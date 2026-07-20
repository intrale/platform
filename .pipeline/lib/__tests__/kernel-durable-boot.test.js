'use strict';

// =============================================================================
// kernel-durable-boot.test.js — Boot durable del supervisor (Split 3/3 · #4822)
//
// Mapea los criterios del issue #4822 sobre la lógica de wiring extraída del
// pulpo (lib/kernel-durable-boot.js):
//   CA-6/CA-SEC-1  flag OFF/ausente ⇒ el boot durable NO corre (fail-closed).
//   CA-1/CA-2      flag ON ⇒ instancia el supervisor y carga los `active` del store.
//   CA-SEC-4       la cota (config.kernel.max_concurrent_instances) se propaga al
//                  supervisor y limita los spawns.
//   best-effort    fallo al construir el store (infra) ⇒ omitido sin throw;
//                  catálogo corrupto (listProducts throw) ⇒ se propaga (fail-closed).
// =============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  runDurableBoot,
  resolveCap,
  DEFAULT_MAX_CONCURRENT_INSTANCES,
} = require('../kernel-durable-boot');

// Catálogo fake mínimo (rol control-plane): sólo expone listProducts().
function fakeCatalogStore(products) {
  return { listProducts: async () => products.slice() };
}

// storeFactory liviano por instancia (no toca red).
function recordingStoreFactory() {
  return (opts) => ({ contextProjectId: opts.contextProjectId, getDescriptor: async () => null });
}

const CATALOG = [
  { productId: 'acme', projectId: 'acme', name: 'ACME', status: 'active' },
  { productId: 'globex', projectId: 'globex', name: 'Globex', status: 'active' },
  { productId: 'initech', projectId: 'initech', name: 'Initech', status: 'onboarding' },
];

// -----------------------------------------------------------------------------
// CA-6 / CA-SEC-1 · Gate fail-closed del flag
// -----------------------------------------------------------------------------

test('CA-6 · con kernel.durable:false el boot durable NO corre', async () => {
  let supervisorBuilt = false;
  const res = await runDurableBoot({
    config: { kernel: { durable: false } },
    createSupervisor: () => { supervisorBuilt = true; return {}; },
    buildCatalogStore: () => { throw new Error('no debería construirse'); },
  });
  assert.equal(res.ran, false, 'boot durable omitido');
  assert.equal(supervisorBuilt, false, 'el supervisor NO se instancia con flag OFF');
});

test('CA-SEC-1 · flag ausente (sin bloque kernel) ⇒ boot durable NO corre', async () => {
  let built = false;
  const res = await runDurableBoot({
    config: {},
    buildCatalogStore: () => { built = true; return fakeCatalogStore(CATALOG); },
  });
  assert.equal(res.ran, false);
  assert.equal(built, false, 'ni siquiera se intenta construir el store');
});

test('CA-SEC-1 · durable sólo activa con boolean true, no con truthy ("true"/1)', async () => {
  for (const val of ['true', 1, {}, 'yes']) {
    const res = await runDurableBoot({
      config: { kernel: { durable: val } },
      buildCatalogStore: () => fakeCatalogStore(CATALOG),
    });
    assert.equal(res.ran, false, `durable=${JSON.stringify(val)} NO debe activar el boot`);
  }
});

// -----------------------------------------------------------------------------
// CA-1 / CA-2 · Wiring con flag ON (integración con el supervisor real)
// -----------------------------------------------------------------------------

test('CA-1/CA-2 · flag ON ⇒ instancia el supervisor y carga los active del store', async () => {
  const spawns = [];
  const res = await runDurableBoot({
    config: { kernel: { durable: true } },
    catalogStore: fakeCatalogStore(CATALOG),
    storeFactory: recordingStoreFactory(),
    spawn: (ctx) => { spawns.push(ctx.projectId); return { projectId: ctx.projectId }; },
  });
  assert.equal(res.ran, true, 'boot durable corrió');
  assert.deepEqual(res.spawned.sort(), ['acme', 'globex'], 'sólo los active se instancian');
  assert.deepEqual(spawns.sort(), ['acme', 'globex'], 'spawn invocado por cada active');
  // onboarding salteado como inactivo.
  assert.ok(res.skipped.some((s) => s.projectId === 'initech' && s.reason === 'inactivo'));
});

test('CA-1 · buildCatalogStore recibe el kernelCfg y su resultado se usa como catálogo', async () => {
  let receivedCfg = null;
  const res = await runDurableBoot({
    config: { kernel: { durable: true, tableName: 'T', region: 'R' } },
    buildCatalogStore: (cfg) => { receivedCfg = cfg; return fakeCatalogStore(CATALOG); },
    storeFactory: recordingStoreFactory(),
    spawn: (ctx) => ({ projectId: ctx.projectId }),
  });
  assert.equal(res.ran, true);
  assert.equal(receivedCfg.tableName, 'T', 'el builder recibe la config kernel out-of-band');
  assert.equal(receivedCfg.region, 'R');
  assert.deepEqual(res.spawned.sort(), ['acme', 'globex']);
});

// -----------------------------------------------------------------------------
// CA-SEC-4 · La cota de config se propaga al supervisor
// -----------------------------------------------------------------------------

test('CA-SEC-4 · max_concurrent_instances de config limita los spawns al boot', async () => {
  const bigCatalog = ['pa', 'pb', 'pc', 'pd'].map((id) => ({ productId: id, projectId: id, name: id, status: 'active' }));
  const alerts = [];
  const res = await runDurableBoot({
    config: { kernel: { durable: true, max_concurrent_instances: 2 } },
    catalogStore: fakeCatalogStore(bigCatalog),
    storeFactory: recordingStoreFactory(),
    spawn: (ctx) => ({ projectId: ctx.projectId }),
    onAlert: (a) => alerts.push(a),
  });
  assert.equal(res.ran, true);
  assert.equal(res.cap, 2, 'el cap efectivo viene de config');
  assert.equal(res.spawned.length, 2, 'sólo `cap` instancias spawneadas');
  assert.equal(res.skipped.filter((s) => s.reason === 'cap de instancias alcanzado').length, 2);
  assert.equal(alerts.filter((a) => a.stage === 'cap').length, 2, 'A09: rechazo por cap auditado');
});

test('resolveCap · default conservador ante ausencia/valor inválido', () => {
  assert.equal(resolveCap({}), DEFAULT_MAX_CONCURRENT_INSTANCES);
  assert.equal(resolveCap({ max_concurrent_instances: 0 }), DEFAULT_MAX_CONCURRENT_INSTANCES);
  assert.equal(resolveCap({ max_concurrent_instances: -3 }), DEFAULT_MAX_CONCURRENT_INSTANCES);
  assert.equal(resolveCap({ max_concurrent_instances: 1.5 }), DEFAULT_MAX_CONCURRENT_INSTANCES);
  assert.equal(resolveCap({ max_concurrent_instances: 'x' }), DEFAULT_MAX_CONCURRENT_INSTANCES);
  assert.equal(resolveCap({ max_concurrent_instances: 5 }), 5, 'valor válido respetado');
});

// -----------------------------------------------------------------------------
// Best-effort · robustez del boot
// -----------------------------------------------------------------------------

test('best-effort · fallo al construir el store (infra) ⇒ boot omitido SIN throw', async () => {
  const logs = [];
  const res = await runDurableBoot({
    config: { kernel: { durable: true } },
    buildCatalogStore: () => { throw new Error('DynamoDB no disponible'); },
    log: (m) => logs.push(m),
  });
  assert.equal(res.ran, false, 'no corre pero tampoco lanza');
  assert.ok(logs.some((m) => /catalogStore durable/i.test(m)), 'se loguea el modo degradado');
});

test('best-effort · buildCatalogStore devuelve algo sin listProducts ⇒ boot omitido', async () => {
  const res = await runDurableBoot({
    config: { kernel: { durable: true } },
    buildCatalogStore: () => ({ nope: true }),
  });
  assert.equal(res.ran, false);
});

test('fail-closed · catálogo corrupto (listProducts throw) se propaga, no se enmascara', async () => {
  const corruptStore = { listProducts: async () => { throw new Error('KernelStoreValidationError: catálogo corrupto'); } };
  await assert.rejects(
    () => runDurableBoot({
      config: { kernel: { durable: true } },
      catalogStore: corruptStore,
      storeFactory: recordingStoreFactory(),
      spawn: () => ({}),
    }),
    /corrupto/,
    'un catálogo corrupto NO se traga: se propaga para que el caller lo audite',
  );
});
