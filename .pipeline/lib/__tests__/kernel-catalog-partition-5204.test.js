'use strict';

// =============================================================================
// kernel-catalog-partition-5204.test.js — El catálogo del kernel se escribe y se
// lee en la MISMA partición (#5204 · bloqueaba el CA-B5 del cutover durable de
// #5126).
//
// EL DEFECTO QUE CUBRE
// --------------------
// (a) `contextProjectId` no se propagaba: el `bootDeps` que arma el drenador de
//     onboarding sólo llevaba `registryPath`/`probeAccess`, así que con
//     `kernel.durable:true` el alta moría en `KernelStoreContextError`.
// (b) El catálogo se escribía en la partición del TENANT (`putProduct` →
//     `addToCatalog` con `PK = contextProjectId`) y el boot lo leía en la del
//     CONTROL-PLANE. Un catálogo poblado desde un tenant era INVISIBLE para
//     `bootProducts()`: `listProducts()` devolvía `[]` y no se instanciaba ningún
//     pipeline.
//
// Los tests recorren el camino REAL en los dos sentidos: escriben por el alta
// (`processOnboard` → `runBootstrapAsync` → `durableRegisterProduct`) y leen por
// el boot (`kernel-supervisor.bootProducts`), sin cortocircuitar ninguno.
// =============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');

const bootstrapLib = require('../project-bootstrap');
const drainLib = require('../product-control-drain');
const ks = require('../kernel-store');
const supervisorLib = require('../kernel-supervisor');
const { CONTROL_PLANE_PROJECT_ID } = require('../project-descriptor');
const { createInMemoryDynamoDriver } = require('../provisioner-infra');

const TENANT = 'acme-store';
const TABLE = 'kernel-store-test';
const SPEC = {
  type: 'dynamodb_table',
  tableName: TABLE,
  keys: [
    { name: 'PK', attributeType: 'S', keyType: 'HASH' },
    { name: 'SK', attributeType: 'S', keyType: 'RANGE' },
  ],
};

function validDescriptor(projectId = TENANT) {
  return {
    schemaVersion: '1.0',
    identity: { projectId, name: 'ACME Store' },
    repositories: [{ id: 'main', url: 'https://github.com/acme/store', role: 'primary' }],
    board: {
      ref: 'https://github.com/orgs/acme/projects/1',
      admissionLabels: ['Ready'],
      routing: [{ label: 'area:backend', capability: 'backend' }],
    },
    capabilities: [{ interface: 'backend', skills: ['backend-dev'] }],
    authority: { signers: ['leitolarreta'], gates: { gate2: 'enforce' } },
  };
}

function onboardRequest(projectId = TENANT) {
  return { type: 'product_onboard_request', projectId, descriptor: validDescriptor(projectId) };
}

// Tabla ÚNICA compartida por todas las particiones (como en producción: una tabla,
// muchas PK). Sin esto el test no podría distinguir "otra partición" de "otra tabla".
function makeWorld() {
  const driver = createInMemoryDynamoDriver();
  const config = { kernel: { tableName: TABLE } };
  const storeFor = (o = {}) => ks.createKernelStore({
    driver,
    config,
    contextProjectId: o.contextProjectId,
    allowedNamespaces: o.allowedNamespaces,
    onAlert: o.onAlert,
  });
  return { driver, config, storeFor };
}

// Lee el ítem CRUDO de una partición concreta (sin pasar por el store, que sólo
// sabe leer la suya). Es lo que permite afirmar DÓNDE quedó escrito el catálogo.
async function rawItem(driver, pk, sk) {
  try {
    const res = await driver.getItem(SPEC, { PK: pk, SK: sk });
    return (res && res.item) || null;
  } catch (e) {
    // El driver in-memory exige la tabla creada; si el alta se cortó fail-closed
    // ANTES de cualquier escritura, la tabla ni existe. Eso ES la ausencia buscada.
    if (/tabla inexistente/i.test(String(e && e.message))) return null;
    throw e;
  }
}

// -----------------------------------------------------------------------------
// CA-1 — el alta real propaga contextProjectId y completa sin KernelStoreContextError
// -----------------------------------------------------------------------------

test('CA-1: alta durable por el camino real del drenador completa sin KernelStoreContextError', async () => {
  const { driver, storeFor } = makeWorld();
  const drain = drainLib.createProductControlDrain({
    // El descriptor es `existing` (trae url): no toca `gh`.
    execFileSync: () => { throw new Error('gh no debe invocarse en este camino'); },
    kernelDurable: true,
    kernelConfig: { durable: true, tableName: TABLE, region: null },
    createStore: storeFor,
    probeAccess: () => true,
  });

  const res = await drain.processOnboard(onboardRequest());
  assert.equal(res.ok, true, `el alta durable debe completar: ${JSON.stringify(res)}`);
  assert.equal(res.stage, 'registered');
  assert.equal(res.projectId, TENANT);

  // Y persistió de verdad: el producto quedó indexado en el control-plane.
  const catalog = await rawItem(driver, CONTROL_PLANE_PROJECT_ID, 'catalog#index');
  assert.ok(catalog, 'el catálogo debe existir tras el alta');
  assert.deepEqual(catalog.body.productIds, [TENANT]);
});

test('CA-1: sin contextProjectId propagado el alta durable falla fail-closed (regresión del defecto (a))', async () => {
  const { storeFor } = makeWorld();
  const drain = drainLib.createProductControlDrain({
    execFileSync: () => { throw new Error('gh no debe invocarse'); },
    kernelDurable: true,
    kernelConfig: { durable: true, tableName: TABLE, region: null },
    createStore: storeFor,
    probeAccess: () => true,
    // Simula el bug: el resolver no entrega contexto ⇒ el write path corta.
    resolveContextProjectId: () => null,
  });
  const res = await drain.processOnboard(onboardRequest());
  assert.equal(res.ok, false, 'sin contexto el alta NO puede completar en silencio');
  assert.equal(res.stage, 'register-durable');
});

// -----------------------------------------------------------------------------
// CA-2 — lo que escribe el alta es EXACTAMENTE lo que enumera el boot
// -----------------------------------------------------------------------------

test('CA-2: un producto dado de alta queda visible para bootProducts() (escribe alta, lee boot)', async () => {
  const { driver, storeFor } = makeWorld();
  const drain = drainLib.createProductControlDrain({
    execFileSync: () => { throw new Error('gh no debe invocarse'); },
    kernelDurable: true,
    kernelConfig: { durable: true, tableName: TABLE, region: null },
    createStore: storeFor,
    probeAccess: () => true,
  });
  const alta = await drain.processOnboard(onboardRequest());
  assert.equal(alta.ok, true, JSON.stringify(alta));

  // El boot construye SU catálogo como en `pulpo.js`: partición del control-plane.
  const catalogStore = storeFor({
    contextProjectId: CONTROL_PLANE_PROJECT_ID,
    allowedNamespaces: [CONTROL_PLANE_PROJECT_ID],
  });
  const spawned = [];
  const supervisor = supervisorLib.createKernelSupervisor({
    catalogStore,
    storeFactory: storeFor,
    drainOnboardQueue: false,
    spawn: (ctx) => { spawned.push(ctx.projectId); return { pid: 1 }; },
  });

  // El alta deja el producto en `onboarding` (INACTIVO hasta OK humano): el boot
  // lo VE en el catálogo y lo saltea por estado, no por invisibilidad. Ésa es la
  // distinción que el defecto (b) borraba — antes ni siquiera aparecía.
  const visto = await supervisor.bootProducts();
  assert.deepEqual(visto.spawned, []);
  assert.deepEqual(
    visto.skipped.map((s) => `${s.projectId}:${s.reason}`),
    [`${TENANT}:inactivo`],
    'el producto recién dado de alta debe aparecer en el catálogo que lee el boot',
  );

  // Activado (OK humano), el MISMO catálogo lo instancia: roundtrip completo.
  await catalogStore.putProduct({ productId: TENANT, name: 'ACME Store', status: 'active' });
  const boot2 = await supervisor.bootProducts();
  assert.deepEqual(boot2.spawned, [TENANT]);
  assert.deepEqual(spawned, [TENANT]);

  // Y la hidratación por instancia encuentra el descriptor en la partición del
  // TENANT (no en la del control-plane): cada entidad en su namespace.
  const ctx = supervisor.getInstance(TENANT);
  assert.ok(ctx && ctx.descriptor, 'la instancia debe hidratar su descriptor');
  assert.equal(ctx.descriptor.identity.projectId, TENANT);
  assert.ok(await rawItem(driver, TENANT, 'descriptor#self'), 'descriptor#self vive en la partición del tenant');
});

// -----------------------------------------------------------------------------
// CA-4 — regresión de partición: el catálogo NO puede volver a la partición del
// tenant. Este test falla si alguien vuelve a usar un único store para las tres
// entidades.
// -----------------------------------------------------------------------------

test('CA-4: catalog#index y product# se escriben en el control-plane, NUNCA en la partición del tenant', async () => {
  const { driver, storeFor } = makeWorld();
  const res = await bootstrapLib.runBootstrapAsync({
    descriptor: validDescriptor(),
    mode: 'full',
    deps: {
      kernelDurable: true,
      kernelConfig: { durable: true, tableName: TABLE, region: null },
      contextProjectId: TENANT,
      createStore: storeFor,
      probeAccess: () => true,
    },
  });
  assert.equal(res.ok, true, JSON.stringify(res.errors || res));
  assert.equal(res.register.catalogProjectId, CONTROL_PLANE_PROJECT_ID);

  // Partición del CONTROL-PLANE: catálogo + producto (lo que enumera el boot).
  assert.ok(await rawItem(driver, CONTROL_PLANE_PROJECT_ID, 'catalog#index'), 'catalog#index en el control-plane');
  assert.ok(await rawItem(driver, CONTROL_PLANE_PROJECT_ID, `product#${TENANT}`), `product#${TENANT} en el control-plane`);

  // Partición del TENANT: SÓLO el descriptor. Si el catálogo reaparece acá, el
  // boot vuelve a leer `[]` y ningún pipeline se instancia.
  assert.ok(await rawItem(driver, TENANT, 'descriptor#self'), 'descriptor#self en la partición del tenant');
  assert.equal(await rawItem(driver, TENANT, 'catalog#index'), null, 'el catálogo NO puede vivir en la partición del tenant');
  assert.equal(await rawItem(driver, TENANT, `product#${TENANT}`), null, 'el producto NO puede vivir en la partición del tenant');
});

// -----------------------------------------------------------------------------
// CA-3 — el aislamiento por tenant se mantiene
// -----------------------------------------------------------------------------

test('CA-3: un contexto ajeno no puede registrar el producto de otro (ni ensuciar el catálogo global)', async () => {
  const { driver, storeFor } = makeWorld();
  const res = await bootstrapLib.runBootstrapAsync({
    descriptor: validDescriptor(TENANT),          // identidad: acme-store
    mode: 'full',
    deps: {
      kernelDurable: true,
      kernelConfig: { durable: true, tableName: TABLE, region: null },
      contextProjectId: 'other-tenant',           // credencial: otro tenant
      createStore: storeFor,
      probeAccess: () => true,
    },
  });
  assert.equal(res.ok, false, 'un contexto ajeno no debe poder registrar el producto');
  assert.equal(res.stage, 'register-durable');
  // Fail-closed ANTES de escribir: el catálogo global queda intacto (si el corte
  // ocurriera recién en putDescriptor, acá habría una entrada huérfana).
  assert.equal(await rawItem(driver, CONTROL_PLANE_PROJECT_ID, 'catalog#index'), null, 'el catálogo global no debe ensuciarse');
  assert.equal(await rawItem(driver, TENANT, 'descriptor#self'), null, 'no debe escribirse el descriptor del tenant ajeno');
});

test('CA-3: el control-plane es un id reservado — no puede darse de alta como producto', async () => {
  const { storeFor } = makeWorld();
  const res = await bootstrapLib.runBootstrapAsync({
    descriptor: validDescriptor(CONTROL_PLANE_PROJECT_ID),
    mode: 'full',
    deps: {
      kernelDurable: true,
      kernelConfig: { durable: true, tableName: TABLE, region: null },
      contextProjectId: CONTROL_PLANE_PROJECT_ID,
      createStore: storeFor,
      probeAccess: () => true,
    },
  });
  assert.equal(res.ok, false, 'la partición del kernel no es un tenant');
  assert.equal(res.stage, 'register-durable');
});

test('CA-3: el alta no sobreescribe el descriptor de un producto ya registrado', async () => {
  const { storeFor } = makeWorld();
  const deps = {
    kernelDurable: true,
    kernelConfig: { durable: true, tableName: TABLE, region: null },
    contextProjectId: TENANT,
    createStore: storeFor,
    probeAccess: () => true,
  };
  const first = await bootstrapLib.runBootstrapAsync({ descriptor: validDescriptor(), mode: 'full', deps });
  assert.equal(first.ok, true, JSON.stringify(first.errors || first));
  const second = await bootstrapLib.runBootstrapAsync({ descriptor: validDescriptor(), mode: 'full', deps });
  assert.equal(second.ok, false, 'un alta repetida no puede pisar el descriptor existente');
  assert.equal(second.stage, 'register-durable');
});

// -----------------------------------------------------------------------------
// Fail-closed de cableado: un alta "durable" sin store real no puede reportar OK
// escribiendo a un store efímero que muere con el proceso.
// -----------------------------------------------------------------------------

test('sin store durable inyectado el alta NO reporta éxito (nada de escribir a un store efímero)', async () => {
  const res = await bootstrapLib.runBootstrapAsync({
    descriptor: validDescriptor(),
    mode: 'full',
    deps: {
      kernelDurable: true,
      kernelConfig: { durable: true, tableName: TABLE, region: null },
      contextProjectId: TENANT,
      probeAccess: () => true,
    },
  });
  assert.equal(res.ok, false);
  assert.equal(res.stage, 'register-durable');
});
