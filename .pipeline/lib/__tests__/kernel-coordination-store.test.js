'use strict';

// =============================================================================
// kernel-coordination-store.test.js — Estado de coordinación del kernel (#4744)
//
// Cobertura (driver in-memory, offline):
//   - create-once: sólo una instancia inicializa el estado (attribute_not_exists).
//   - compareAndSet optimista: versión desactualizada → conflicto; correcta → avanza.
//   - aislamiento por projectId (anti-IDOR) sobre el ítem leído.
//   - allowlist de claves (dato de config, no del ítem).
//   - fail-closed al leer (schema).
// =============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');

const { createInMemoryDynamoDriver, ConditionalCheckFailedError } = require('../provisioner-infra');
const { createCoordinationStore } = require('../kernel-coordination-store');
const { KernelStoreValidationError, KernelStoreIsolationError } = require('../kernel-store');

const CTX = 'acme-store';

function makeStore(extra = {}) {
  const driver = extra.driver || createInMemoryDynamoDriver();
  const store = createCoordinationStore({
    driver,
    contextProjectId: extra.contextProjectId || CTX,
    now: () => 1000,
    ...extra,
  });
  return { store, driver };
}

const specFor = (tableName = 'kernel-coordination-local') => ({
  type: 'dynamodb_table',
  tableName,
  keys: [
    { name: 'PK', attributeType: 'S', keyType: 'HASH' },
    { name: 'SK', attributeType: 'S', keyType: 'RANGE' },
  ],
});

test('create-once: sólo una instancia inicializa el estado', async () => {
  const driver = createInMemoryDynamoDriver();
  const { store: a } = makeStore({ driver });
  const { store: b } = makeStore({ driver });
  const r1 = await a.initState('waves', { active: [] });
  const r2 = await b.initState('waves', { active: ['dup'] });
  assert.equal(r1.ok, true);
  assert.equal(r1.created, true);
  assert.equal(r2.ok, false);
  assert.equal(r2.exists, true);
});

test('getState devuelve valor y versión; null si no existe', async () => {
  const { store } = makeStore();
  assert.equal(await store.getState('health'), null);
  await store.initState('health', { status: 'green' });
  const s = await store.getState('health');
  assert.deepEqual(s.value, { status: 'green' });
  assert.equal(s.version, 1);
});

test('compareAndSet avanza la versión cuando expectedVersion coincide', async () => {
  const { store } = makeStore();
  await store.initState('blocked', { issues: [] });
  const r = await store.compareAndSet('blocked', { issues: [123] }, 1);
  assert.equal(r.ok, true);
  assert.equal(r.version, 2);
  const s = await store.getState('blocked');
  assert.deepEqual(s.value, { issues: [123] });
  assert.equal(s.version, 2);
});

test('compareAndSet con versión desactualizada → conflicto', async () => {
  const { store } = makeStore();
  await store.initState('blocked', { issues: [] });
  await store.compareAndSet('blocked', { issues: [1] }, 1); // ahora v2
  const stale = await store.compareAndSet('blocked', { issues: [2] }, 1); // expectedVersion viejo
  assert.equal(stale.ok, false);
  assert.equal(stale.conflict, true);
  assert.equal(stale.version, 2);
});

test('compareAndSet crea si no existe con expectedVersion 0', async () => {
  const { store } = makeStore();
  const r = await store.compareAndSet('waves', { active: [] }, 0);
  assert.equal(r.ok, true);
  assert.equal(r.version, 1);
});

test('clave fuera de allowlist es rechazada (dato de config, no del ítem)', async () => {
  const { store } = makeStore();
  await assert.rejects(() => store.getState('evil-key'), /allowlist/);
  await assert.rejects(() => store.initState('evil-key', {}), /allowlist/);
});

test('aislamiento: la instancia de A no lee la partición de B', async () => {
  const driver = createInMemoryDynamoDriver();
  const { store: b } = makeStore({ driver, contextProjectId: 'proj-b' });
  await b.initState('waves', { active: ['b-only'] });

  // Inyectamos manualmente un ítem de B con SK compartido pero PK de B; A no
  // debe verlo porque su PK es CTX. getState de A devuelve null (partición propia vacía).
  const { store: a } = makeStore({ driver, contextProjectId: CTX });
  assert.equal(await a.getState('waves'), null);
});

test('fail-closed: ítem de coordinación corrupto al leer lanza', async () => {
  const driver = createInMemoryDynamoDriver();
  await driver.createTable(specFor());
  // Ítem con body inválido (falta version).
  await driver.putItem(specFor(), {
    PK: CTX, SK: 'coord#waves', entityType: 'coordination', projectId: CTX, schemaVersion: '1.0',
    body: { key: 'waves', value: {} },
  });
  const { store } = makeStore({ driver });
  await assert.rejects(() => store.getState('waves'), (e) => e instanceof KernelStoreValidationError);
});

test('fail-closed: ítem de otra partición inyectado en la propia PK es rechazado', async () => {
  const driver = createInMemoryDynamoDriver();
  await driver.createTable(specFor());
  await driver.putItem(specFor(), {
    PK: CTX, SK: 'coord#waves', entityType: 'coordination', projectId: 'proj-b', schemaVersion: '1.0',
    body: { key: 'waves', value: {}, version: 1 },
  });
  const { store } = makeStore({ driver });
  await assert.rejects(() => store.getState('waves'), (e) => e instanceof KernelStoreIsolationError);
});

test('driver real sin coordinationTableName falla (no hardcode)', () => {
  const fakeAws = { kind: 'aws-cli', createTable: async () => {}, getItem: async () => ({ item: null }), putItem: async () => ({}) };
  assert.throws(
    () => createCoordinationStore({ driver: fakeAws, contextProjectId: CTX }),
    /coordinationTableName requerido/,
  );
});

// =============================================================================
// #4777 · CA-1 débito de cuota de pagos central y atómico
//   (ruta atómica REAL: atomicUpdate=true — el driver in-memory evalúa la
//    condición CAS `#b.#v = :ev`, no da falso verde como advierte R1/SEC-2).
// =============================================================================

// Lee el ítem persistido crudo (sin pasar por la allowlist de getState) para
// inspeccionar el estado real del store.
async function rawItem(driver, key, ctx = CTX, table = 'kernel-coordination-local') {
  const res = await driver.getItem(specFor(table), { PK: ctx, SK: `coord#${key}` });
  return res && res.item;
}

test('CA-1 · debitPaid: la condición atómica evita el lost-update en la ruta real', async () => {
  const driver = createInMemoryDynamoDriver();
  const { store: a } = makeStore({ driver, atomicUpdate: true });
  const { store: b } = makeStore({ driver, atomicUpdate: true, instanceId: 'inst-b' });

  await a.debitPaid('quota-anthropic', 10); // consumed=10, v1

  // Inyectamos un débito concurrente de B EXACTAMENTE en la ventana entre la
  // lectura y la escritura condicional de A (el TOCTOU clásico).
  const orig = driver.putItem.bind(driver);
  let fired = false;
  driver.putItem = async (spec, item, opts) => {
    if (!fired && opts && opts.conditionExpression && opts.conditionExpression.includes('=')) {
      fired = true;
      driver.putItem = orig; // restaurar para no reentrar en el débito de B
      await b.debitPaid('quota-anthropic', 5); // B commitea primero: consumed=15, v2
    }
    return orig(spec, item, opts);
  };

  const res = await a.debitPaid('quota-anthropic', 100);
  assert.equal(res.ok, true);
  // A leyó base=10@v1; B bumpeó a v2; el put condicional de A (#b.#v=1) falla,
  // A reintenta sobre v2 (base=15) → total EXACTO = 10 + 5 + 100 = 115.
  assert.equal(res.consumed, 115);
  const item = await rawItem(driver, 'quota-anthropic');
  assert.equal(item.body.value.consumed, 115);
});

test('CA-1 · guard R1/SEC-2: sin atomicUpdate el MISMO interleaving pierde el débito', async () => {
  // Demuestra por qué el test debe correr la ruta atómica: con read-then-write
  // (atomicUpdate=false) el mismo escenario subcontabiliza (falso verde).
  const driver = createInMemoryDynamoDriver();
  const { store: a } = makeStore({ driver, atomicUpdate: false });
  const { store: b } = makeStore({ driver, atomicUpdate: false, instanceId: 'inst-b' });

  await a.debitPaid('quota-anthropic', 10); // consumed=10, v1

  const orig = driver.putItem.bind(driver);
  let fired = false;
  driver.putItem = async (spec, item, opts) => {
    if (!fired) {
      fired = true;
      driver.putItem = orig;
      await b.debitPaid('quota-anthropic', 5); // B: consumed=15, v2
    }
    return orig(spec, item, opts);
  };

  const res = await a.debitPaid('quota-anthropic', 100);
  assert.equal(res.ok, true);
  // Sin condición atómica A pisa el commit de B: total ERRÓNEO = 110 (perdió 5).
  const item = await rawItem(driver, 'quota-anthropic');
  assert.equal(item.body.value.consumed, 110);
  assert.notEqual(item.body.value.consumed, 115); // el atómico habría dado 115
});

test('CA-1 · N débitos concurrentes: total exacto (uno gana, el resto reintenta)', async () => {
  const driver = createInMemoryDynamoDriver();
  const stores = Array.from({ length: 12 }, (_, i) =>
    makeStore({ driver, atomicUpdate: true, instanceId: `inst-${i}` }).store);
  const N = 12;
  const DELTA = 7;
  await Promise.all(stores.map((s) => s.debitPaid('quota-openai-codex', DELTA, { maxRetries: 200 })));
  const item = await rawItem(driver, 'quota-openai-codex');
  assert.equal(item.body.value.consumed, N * DELTA); // 84, sin pérdidas
});

test('CA-1 · debitPaid rechaza clave reservada de coordinación y delta inválido', async () => {
  const { store } = makeStore({ atomicUpdate: true });
  await assert.rejects(() => store.debitPaid('waves', 10), /reservada de coordinación/);
  await assert.rejects(() => store.debitPaid('quota-anthropic', -1), /deltaTokens/);
  await assert.rejects(() => store.debitPaid('BAD KEY', 10), /isSafeId/);
});

// =============================================================================
// #4777 · CA-2 claim cloud-ready · CA-3 release ownership · CA-4 lease/TTL
// =============================================================================

test('CA-2 · claim concurrente elige un único ganador', async () => {
  const driver = createInMemoryDynamoDriver();
  const { store: a } = makeStore({ driver, atomicUpdate: true, instanceId: 'inst-a' });
  const { store: b } = makeStore({ driver, atomicUpdate: true, instanceId: 'inst-b' });

  const [ra, rb] = await Promise.all([
    a.claim('job-42', { owner: 'worker-a', leaseMs: 10000 }),
    b.claim('job-42', { owner: 'worker-b', leaseMs: 10000 }),
  ]);
  const winners = [ra, rb].filter((r) => r.ok);
  assert.equal(winners.length, 1); // exactamente uno gana, cero doble ejecución
  const loser = [ra, rb].find((r) => !r.ok);
  assert.equal(loser.exists, true);
});

test('CA-3 · release valida ownership: B no libera el claim de A', async () => {
  const { store } = makeStore({ atomicUpdate: true });
  const claimed = await store.claim('job-7', { owner: 'worker-a', leaseMs: 10000 });
  assert.equal(claimed.ok, true);

  const foreign = await store.release('job-7', { expectedOwner: 'worker-b' });
  assert.equal(foreign.ok, false);
  assert.equal(foreign.released, false);
  assert.equal(foreign.reason, 'not-owner');

  const own = await store.release('job-7', { expectedOwner: 'worker-a' });
  assert.equal(own.ok, true);
  assert.equal(own.released, true);

  // Tras liberar, el trabajo vuelve a estar claimable (item borrado).
  const reclaim = await store.claim('job-7', { owner: 'worker-c', leaseMs: 10000 });
  assert.equal(reclaim.ok, true);
  assert.equal(reclaim.reclaimed, false); // create-once fresco
});

test('CA-3 · release de clave ausente es no-op seguro', async () => {
  const { store } = makeStore({ atomicUpdate: true });
  const r = await store.release('job-absent', { expectedOwner: 'worker-a' });
  assert.equal(r.ok, true);
  assert.equal(r.released, false);
  assert.equal(r.reason, 'absent');
});

test('CA-3 · release detecta conflicto atómico si el owner cambia bajo el delete', async () => {
  const driver = createInMemoryDynamoDriver();
  const { store } = makeStore({ driver, atomicUpdate: true });
  await store.claim('job-9', { owner: 'worker-a', leaseMs: 10000 });

  // Simula que entre la lectura de ownership y el delete condicional, el estado
  // cambió (otra instancia ganó una carrera) → CCFE → reason 'conflict'.
  const orig = driver.deleteItem.bind(driver);
  driver.deleteItem = async () => { driver.deleteItem = orig; throw new ConditionalCheckFailedError('carrera'); };
  const r = await store.release('job-9', { expectedOwner: 'worker-a' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'conflict');
});

test('CA-4 · lease vencido libera lock huérfano; reclamo posterior sin doble ejecución', async () => {
  const driver = createInMemoryDynamoDriver();
  const clock = { t: 1000 };
  const nowFn = () => clock.t;
  const { store: a } = makeStore({ driver, atomicUpdate: true, instanceId: 'inst-a', now: nowFn });
  const { store: b } = makeStore({ driver, atomicUpdate: true, instanceId: 'inst-b', now: nowFn });

  const held = await a.claim('job-lease', { owner: 'worker-a', leaseMs: 5000 }); // expira en 6000
  assert.equal(held.ok, true);
  assert.equal(held.expiresAt, 6000);

  // Antes de vencer: B no puede robar el claim vigente.
  const blocked = await b.claim('job-lease', { owner: 'worker-b', leaseMs: 5000 });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.owner, 'worker-a');

  // Instancia A "murió"; el lease vence.
  clock.t = 7000;

  // Dos reclamos concurrentes tras el vencimiento → un solo ganador (sin doble
  // ejecución en la ventana de solapamiento).
  const { store: c } = makeStore({ driver, atomicUpdate: true, instanceId: 'inst-c', now: nowFn });
  const [rb, rc] = await Promise.all([
    b.claim('job-lease', { owner: 'worker-b', leaseMs: 5000 }),
    c.claim('job-lease', { owner: 'worker-c', leaseMs: 5000 }),
  ]);
  const winners = [rb, rc].filter((r) => r.ok);
  assert.equal(winners.length, 1);
  assert.equal(winners[0].reclaimed, true); // takeover del lock huérfano
});

test('CA-4 · claim exige owner seguro y leaseMs > 0', async () => {
  const { store } = makeStore({ atomicUpdate: true });
  await assert.rejects(() => store.claim('job-x', { owner: 'BAD OWNER', leaseMs: 1000 }), /owner válido/);
  await assert.rejects(() => store.claim('job-x', { owner: 'worker-a', leaseMs: 0 }), /leaseMs/);
});
