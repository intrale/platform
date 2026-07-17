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

const { createInMemoryDynamoDriver } = require('../provisioner-infra');
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
