'use strict';

// =============================================================================
// durable-alta-4821.test.js — Alta durable + lectura del catálogo desde el store
// (#4821 · split 2/3 de #4804 · write path + coexistencia bajo flag de cutover).
//
// Cobertura mapeada a los CA heredados de #4804 + requisitos de seguridad:
//   CA-3  · escritura sin estado a medias (orden producto→catálogo; huérfano invisible).
//   CA-4  · fail-closed, no auto-continúa; reporte al operador.
//   CA-5  · distinción de error tipado (ConditionalCheckFailed vs infra genérico).
//   CA-6  · flag de cutover único; con durable:false el FS NO cambia.
//   CA-9  · contextProjectId deriva de la credencial, nunca del descriptor.
//   CA-10 · validación antes de escribir (vía putProduct).
//   CA-14/15 · error accionable en español sin ARN/tabla/SK/partición.
//   security#1 · no coexiste fs.readFileSync(registry.json) + store.putProduct.
//   security#2 · fallback selectivo: infra→FS; validación/onAlert→propaga.
//   security#6 · escritura SIEMPRE por putProduct, nunca driver.putItem directo.
// =============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const bootstrap = require('../project-bootstrap');
const catalog = require('../product-catalog');
const { createInMemoryDynamoDriver, ConditionalCheckFailedError } = require('../provisioner-infra');
const { createKernelStore, KernelStoreValidationError } = require('../kernel-store');

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

const CTX = 'acme-store';

function validDescriptor(overrides = {}) {
  return {
    schemaVersion: '1.0',
    identity: { projectId: CTX, name: 'ACME Store' },
    repositories: [{ id: 'main', url: 'https://github.com/acme/store', role: 'primary' }],
    board: {
      ref: 'https://github.com/orgs/acme/projects/1',
      admissionLabels: ['Ready'],
      routing: [{ label: 'area:backend', capability: 'backend' }],
    },
    capabilities: [{ interface: 'backend', skills: ['backend-dev'] }],
    authority: { signers: ['leitolarreta'], gates: { gate2: 'enforce' } },
    ...overrides,
  };
}

function makeStore(extra = {}) {
  const alerts = [];
  const driver = extra.driver || createInMemoryDynamoDriver();
  const store = createKernelStore({
    driver,
    contextProjectId: extra.contextProjectId || CTX,
    onAlert: (a) => alerts.push(a),
    now: () => 1000,
  });
  return { store, driver, alerts };
}

// Driver que delega en el in-memory pero FALLA el 2º putItem (el del índice de
// catálogo `catalog#index`), simulando el fallo de `addToCatalog` tras escribir
// el producto (CA-3). El producto queda huérfano e invisible a listProducts.
function driverFailingCatalog(failWith) {
  const inner = createInMemoryDynamoDriver();
  return {
    kind: 'in-memory',
    createTable: (...a) => inner.createTable(...a),
    describeTable: (...a) => inner.describeTable(...a),
    getItem: (...a) => inner.getItem(...a),
    deleteItem: (...a) => inner.deleteItem(...a),
    async putItem(spec, item, opts) {
      if (item && item.SK === 'catalog#index') {
        throw failWith || new Error('DynamoDB no disponible (simulado) al indexar catálogo');
      }
      return inner.putItem(spec, item, opts);
    },
  };
}

// =============================================================================
// CA-6 — Coexistencia: con durable:false el comportamiento FS NO cambia.
// =============================================================================

test('CA-6: durable:false ⇒ runBootstrapDurable escribe FS (registry.json) igual que runBootstrap', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'durable-'));
  const registryPath = path.join(tmp, 'registry.json');
  const res = await bootstrap.runBootstrapDurable({
    descriptor: validDescriptor(),
    mode: 'full',
    config: { kernel: { durable: false } },
    deps: { registryPath },
  });
  assert.equal(res.ok, true);
  assert.equal(res.stage, 'registered');
  assert.equal(res.register.backend, 'fs');
  assert.ok(fs.existsSync(registryPath), 'debe escribir el registry FS');
  const reg = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
  assert.equal(reg.products[CTX].status, 'onboarding');
});

test('CA-6: durable:false ⇒ NO instancia el store (no toca DynamoDB)', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'durable-'));
  let putCalled = false;
  const spyStore = { putProduct: async () => { putCalled = true; } };
  const res = await bootstrap.runBootstrapDurable({
    descriptor: validDescriptor(),
    mode: 'full',
    config: { kernel: { durable: false } },
    store: spyStore,
    deps: { registryPath: path.join(tmp, 'r.json') },
  });
  assert.equal(res.ok, true);
  assert.equal(putCalled, false, 'con durable:false no debe llamar store.putProduct');
});

test('CA-6: readDurableFlag lee el flag una vez (kernel.durable o plano)', () => {
  assert.equal(bootstrap.readDurableFlag({ kernel: { durable: true } }), true);
  assert.equal(bootstrap.readDurableFlag({ durable: true }), true);
  assert.equal(bootstrap.readDurableFlag({ kernel: { durable: false } }), false);
  assert.equal(bootstrap.readDurableFlag({}), false);
  assert.equal(bootstrap.readDurableFlag(undefined), false);
});

// =============================================================================
// CA-3 / CA-10 — Roundtrip durable: alta → putProduct + listProducts durable.
// =============================================================================

test('CA-3/CA-10: alta durable persiste vía putProduct y listProducts durable lo devuelve', async () => {
  const { store } = makeStore();
  const res = await bootstrap.runBootstrapDurable({
    descriptor: validDescriptor(),
    mode: 'full',
    config: { kernel: { durable: true } },
    store,
  });
  assert.equal(res.ok, true);
  assert.equal(res.stage, 'registered');
  assert.equal(res.backend, 'durable');
  assert.equal(res.status, 'onboarding');

  // Roundtrip: el store lo devuelve.
  const listed = await store.listProducts();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].productId, CTX);
  assert.equal(listed[0].status, 'onboarding');

  // Proyección del catálogo durable (product-catalog).
  const projected = await catalog.listProductsDurable({ store });
  assert.equal(projected.length, 1);
  assert.deepEqual(projected[0], { projectId: CTX, name: 'ACME Store', status: 'onboarding', role: 'primary' });
});

test('CA-14/15: éxito durable confirma persistencia durable en el mensaje al operador', async () => {
  const { store } = makeStore();
  const res = await bootstrap.runBootstrapDurable({
    descriptor: validDescriptor(),
    mode: 'full',
    config: { kernel: { durable: true } },
    store,
  });
  assert.match(res.human, /durable/i);
  assert.match(res.human, /ONBOARDING/);
});

// =============================================================================
// CA-3 / CA-4 — Fallo parcial: addToCatalog falla tras putItem(producto).
// =============================================================================

test('CA-3/CA-4: fallo de addToCatalog ⇒ producto huérfano INVISIBLE a listProducts + reporte al operador', async () => {
  const driver = driverFailingCatalog();
  const { store } = makeStore({ driver });
  const res = await bootstrap.runBootstrapDurable({
    descriptor: validDescriptor(),
    mode: 'full',
    config: { kernel: { durable: true } },
    store,
  });
  // CA-4: fail-closed, se reporta al operador (no auto-continúa como éxito).
  assert.equal(res.ok, false);
  assert.equal(res.stage, 'register:durable');
  assert.ok(res.errors && res.errors.length >= 1);

  // CA-3: el producto huérfano NO aparece (catálogo nunca se indexó).
  const listed = await store.listProducts();
  assert.equal(listed.length, 0, 'el producto huérfano no debe ser visible');
  const projected = await catalog.listProductsDurable({ store });
  assert.equal(projected.length, 0);
});

// =============================================================================
// CA-5 / CA-14 / CA-15 — Distinción de error tipado + sin fugas técnicas.
// =============================================================================

test('CA-5: ConditionalCheckFailed mapea a "estado no quedó a medias" (distinto de infra)', () => {
  const conflict = bootstrap.mapDurableError(new ConditionalCheckFailedError('sk=product#x tabla=kernel-prod-1 partición=acme'));
  assert.equal(conflict.code, 'conflict');
  assert.match(conflict.operator, /no quedó a medias/i);

  const infra = bootstrap.mapDurableError(new Error('ETIMEDOUT connect dynamodb'));
  assert.equal(infra.code, 'infra');
  assert.notEqual(infra.operator, conflict.operator, 'infra genérico ≠ conflicto condicional');
});

test('CA-14/15: el mensaje al operador NUNCA expone ARN/tableName/SK/partición', () => {
  const leaky = 'arn:aws:dynamodb:us-east-1:123:table/kernel-prod-1 SK=product#x PK=acme-tenant partición';
  for (const err of [
    new ConditionalCheckFailedError(leaky),
    Object.assign(new Error(leaky), { name: 'KernelStoreValidationError' }),
    new Error(leaky),
  ]) {
    const mapped = bootstrap.mapDurableError(err);
    for (const forbidden of ['arn:', 'kernel-prod-1', 'SK=', 'PK=', 'product#', 'partición', 'table/']) {
      assert.ok(!mapped.operator.includes(forbidden), `operator no debe incluir "${forbidden}": ${mapped.operator}`);
    }
    // El detalle crudo queda sólo en internal (para logs).
    assert.ok(mapped.internal.includes(leaky) || mapped.internal.length > 0);
  }
});

test('CA-5/CA-14: run durable con ConditionalCheckFailed del store ⇒ errorCode conflict + mensaje sin fugas', async () => {
  // El store real absorbe ConditionalCheckFailed en el CAS de addToCatalog; para
  // ejercitar el mapeo integrado se inyecta un store que lo propaga crudo.
  const store = { putProduct: async () => { throw new ConditionalCheckFailedError('sk=product#x tabla=kernel-prod partición=acme'); } };
  const res = await bootstrap.runBootstrapDurable({
    descriptor: validDescriptor(),
    mode: 'full',
    config: { kernel: { durable: true } },
    store,
  });
  assert.equal(res.ok, false);
  assert.equal(res.errorCode, 'conflict');
  assert.match(res.errors[0].detail, /no quedó a medias/i);
  assert.ok(!res.errors[0].detail.includes('kernel-prod'));
  assert.ok(!res.human.includes('product#x'));
  assert.ok(!res.human.includes('kernel-prod'));
});

test('CA-4/infra: run durable con contención persistente de CAS ⇒ fail-closed, huérfano invisible', async () => {
  // Un ConditionalCheckFailed persistente en el índice agota los reintentos de
  // CAS y el store lanza KernelStoreError base → mapeo a infra (reintentar luego).
  const driver = driverFailingCatalog(new ConditionalCheckFailedError('sk=catalog#index'));
  const { store } = makeStore({ driver });
  const res = await bootstrap.runBootstrapDurable({
    descriptor: validDescriptor(),
    mode: 'full',
    config: { kernel: { durable: true } },
    store,
  });
  assert.equal(res.ok, false);
  assert.equal(res.errorCode, 'infra');
  const listed = await store.listProducts();
  assert.equal(listed.length, 0, 'producto huérfano invisible tras contención persistente');
});

// =============================================================================
// CA-9 — contextProjectId deriva de la credencial, NUNCA del descriptor.
// =============================================================================

test('CA-9: registerProductDurable sin store ni contextProjectId ⇒ fail-closed (no deriva del payload)', async () => {
  await assert.rejects(
    () => bootstrap.registerProductDurable({ projectId: 'evil-tenant', name: 'X' }, {}),
    (e) => {
      assert.equal(e.name, 'KernelStoreValidationError');
      assert.match(e.message, /contextProjectId/);
      assert.match(e.message, /credencial/i);
      return true;
    },
  );
});

test('CA-9: el producto se persiste en la partición del contexto de credencial, no la del descriptor', async () => {
  // contexto (credencial) ≠ projectId del descriptor: el store escribe en la
  // partición del contexto — el payload no puede saltar de tenant.
  const { store, driver } = makeStore({ contextProjectId: 'tenant-real' });
  await bootstrap.registerProductDurable(
    { projectId: 'acme-store', name: 'ACME Store' },
    { store },
  );
  // El ítem del producto vive bajo PK=tenant-real (contexto), no bajo acme-store.
  const spec = { type: 'dynamodb_table', tableName: 'kernel-store-local', keys: [
    { name: 'PK', attributeType: 'S', keyType: 'HASH' },
    { name: 'SK', attributeType: 'S', keyType: 'RANGE' },
  ] };
  const got = await driver.getItem(spec, { PK: 'tenant-real', SK: 'product#acme-store' });
  assert.ok(got.item, 'el producto debe vivir en la partición del contexto de credencial');
  assert.equal(got.item.PK, 'tenant-real');
});

// =============================================================================
// security#2 — Fallback selectivo en la lectura durable.
// =============================================================================

test('security#2: store no disponible (infra) ⇒ fallback FS loggeado', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'durable-fb-'));
  fs.writeFileSync(path.join(tmp, 'acme.json'), JSON.stringify({
    identity: { projectId: 'acme-store', name: 'ACME' },
    status: 'active',
    repositories: [{ id: 'main', role: 'primary' }],
  }));
  const failingStore = { listProducts: async () => { throw new Error('ECONNREFUSED dynamodb'); } };
  let degraded = null;
  const out = await catalog.listProductsDurable({
    store: failingStore,
    fsFallbackDir: tmp,
    onDegraded: (info) => { degraded = info; },
  });
  assert.equal(out.length, 1, 'debe caer a FS fallback');
  assert.equal(out[0].projectId, 'acme-store');
  assert.ok(degraded && /respaldo local|store no disponible/i.test(degraded.reason), 'debe loggear el degradado');
});

test('security#2: KernelStoreValidationError (integridad) ⇒ NO cae a FS, propaga', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'durable-tamper-'));
  fs.writeFileSync(path.join(tmp, 'acme.json'), JSON.stringify({
    identity: { projectId: 'acme-store', name: 'ACME' }, status: 'active',
  }));
  const tamperStore = { listProducts: async () => { throw new KernelStoreValidationError('catálogo corrupto', { stage: 'schema' }); } };
  let degraded = false;
  await assert.rejects(
    () => catalog.listProductsDurable({ store: tamperStore, fsFallbackDir: tmp, onDegraded: () => { degraded = true; } }),
    (e) => e.name === 'KernelStoreValidationError',
  );
  assert.equal(degraded, false, 'NO debe caer a FS ante tampering (fallback ciego enmascararía el ataque)');
});

test('security#2: isIntegrityError distingue validación/aislamiento de infra', () => {
  assert.equal(catalog.isIntegrityError({ name: 'KernelStoreValidationError' }), true);
  assert.equal(catalog.isIntegrityError({ name: 'KernelStoreIsolationError' }), true);
  assert.equal(catalog.isIntegrityError(new Error('ETIMEDOUT')), false);
  assert.equal(catalog.isIntegrityError(null), false);
});

// =============================================================================
// CA-6 — listProductsResolved gobernado por el flag.
// =============================================================================

test('CA-6: listProductsResolved(durable:false) barre FS; (durable:true) proyecta store', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'durable-res-'));
  fs.writeFileSync(path.join(tmp, 'acme.json'), JSON.stringify({
    identity: { projectId: 'acme-store', name: 'ACME' }, status: 'active',
    repositories: [{ id: 'main', role: 'primary' }],
  }));
  const fsOut = await catalog.listProductsResolved({ durable: false, descriptorsDir: tmp });
  assert.equal(fsOut.length, 1);
  assert.equal(fsOut[0].projectId, 'acme-store');

  const { store } = makeStore();
  await store.putProduct({ productId: CTX, name: 'ACME Store', status: 'onboarding' });
  const durOut = await catalog.listProductsResolved({ durable: true, store, descriptorsDir: tmp });
  assert.equal(durOut.length, 1);
  assert.equal(durOut[0].projectId, CTX);
});

// =============================================================================
// GUARDS ESTÁTICOS — security#1 / security#6.
// =============================================================================

test('security#6: el path del alta NO usa driver.putItem directo (sólo store.putProduct)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'project-bootstrap.js'), 'utf8');
  // Matchea una LLAMADA real `driver.putItem(...)`, no la prosa de los comentarios.
  assert.ok(!/driver\.putItem\s*\(/.test(src), 'project-bootstrap no debe llamar driver.putItem directo');
  assert.ok(/store\.putProduct/.test(src), 'el alta durable debe escribir vía store.putProduct');
});

test('security#1: el registrador durable NO combina fs.readFileSync(registry) + putProduct', () => {
  const durableSrc = bootstrap.registerProductDurable.toString();
  assert.ok(/putProduct/.test(durableSrc), 'registerProductDurable usa putProduct');
  assert.ok(!/readFileSync/.test(durableSrc), 'registerProductDurable NO debe leer registry.json (anti split-brain)');

  const fsSrc = bootstrap.defaultRegisterProduct.toString();
  assert.ok(/writeFileSync/.test(fsSrc), 'defaultRegisterProduct escribe FS');
  assert.ok(!/putProduct/.test(fsSrc), 'defaultRegisterProduct NO debe tocar el store');
});
