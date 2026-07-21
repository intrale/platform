'use strict';

// =============================================================================
// durable-cutover.test.js — Alta durable + lectura del catálogo desde el store
// bajo flag `kernel.durable` (#4821 · split de #4804).
//
// Cobertura de los criterios heredados de #4804:
//   - CA-3  : escritura atómica sin estado a medias (producto huérfano invisible).
//   - CA-4  : fail-closed, no a medias — se reporta al operador.
//   - CA-5  : ConditionalCheckFailedException se distingue de fallo de infra.
//   - CA-6  : flag de cutover único (durable:false ⇒ FS sin cambios; durable:true
//             ⇒ lectura Y escritura al store).
//   - CA-9  : contextProjectId deriva de la credencial, no del payload del wizard.
//   - CA-10 : validateDescriptor antes de escribir.
//   - CA-14/15 : errores accionables en español sin ARN/tabla/SK.
//   - security#2 : fallback FS SELECTIVO (sólo infra, nunca KernelStoreValidationError).
//   - security#6 : el alta escribe SIEMPRE por putProduct (nunca driver.putItem directo).
// =============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const b = require('../project-bootstrap');
const pc = require('../product-catalog');
const ks = require('../kernel-store');
const { ConditionalCheckFailedError } = require('../provisioner-infra');

function validDescriptor(overrides = {}) {
  return {
    schemaVersion: '1.0',
    identity: { projectId: 'acme-store', name: 'ACME Store' },
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

// Driver que envuelve al in-memory y falla el putItem de una entidad concreta.
// `skPrefix='catalog#'` simula el fallo del 2º paso de putProduct (CA-3);
// `skPrefix='product#'` simula un fallo condicional que aflora al caller (CA-5).
function makeFailingDriver(baseDriver, skPrefix, failWith) {
  return {
    kind: baseDriver.kind,
    createTable: (...a) => baseDriver.createTable(...a),
    describeTable: (...a) => baseDriver.describeTable(...a),
    getItem: (...a) => baseDriver.getItem(...a),
    deleteItem: (...a) => baseDriver.deleteItem(...a),
    putItem: (spec, item, opts) => {
      if (item && typeof item.SK === 'string' && item.SK.startsWith(skPrefix)) {
        return Promise.reject(failWith());
      }
      return baseDriver.putItem(spec, item, opts);
    },
  };
}

// -----------------------------------------------------------------------------
// CA-6 — coexistencia: con durable:false el comportamiento FS NO cambia.
// -----------------------------------------------------------------------------

test('CA-6: durable:false NO toca el store y registra en FS (registry.json)', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-'));
  const registryPath = path.join(tmp, 'registry.json');
  let storeCalled = false;
  const res = await b.runBootstrapAsync({
    descriptor: validDescriptor(),
    mode: 'full',
    deps: {
      kernelDurable: false,
      registryPath,
      contextProjectId: 'acme-store',
      createStore: () => { storeCalled = true; return null; },
    },
  });
  assert.equal(res.ok, true);
  assert.equal(res.durable, false);
  assert.equal(res.status, 'onboarding');
  assert.equal(storeCalled, false, 'durable:false NUNCA debe instanciar el store');
  assert.ok(fs.existsSync(registryPath), 'FS registry.json debe escribirse igual que hoy');
  const reg = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
  assert.equal(reg.products['acme-store'].status, 'onboarding');
});

test('CA-6: runBootstrap sync (camino FS) sigue funcionando idéntico', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-'));
  const registryPath = path.join(tmp, 'registry.json');
  const res = b.runBootstrap({ descriptor: validDescriptor(), mode: 'full', deps: { registryPath } });
  assert.equal(res.ok, true);
  assert.equal(res.durable, false);
  assert.equal(res.status, 'onboarding');
});

test('CA-6: listProductsResolved con durable:false barre FS (comportamiento actual)', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-'));
  fs.writeFileSync(path.join(tmp, 'p.json'), JSON.stringify({
    identity: { projectId: 'acme-store', name: 'ACME Store' }, status: 'active',
    repositories: [{ id: 'main', role: 'primary' }],
  }));
  const out = await pc.listProductsResolved({ durable: false, descriptorsDir: tmp });
  assert.equal(out.length, 1);
  assert.equal(out[0].projectId, 'acme-store');
  assert.equal(out[0].role, 'primary');
});

// -----------------------------------------------------------------------------
// CA-3 / roundtrip — alta durable escribe y la lectura durable la proyecta.
// -----------------------------------------------------------------------------

test('roundtrip: alta durable → putProduct + listProducts durable devuelve el producto', async () => {
  const store = ks.createKernelStore({ contextProjectId: 'acme-store' });
  const res = await b.runBootstrapAsync({
    descriptor: validDescriptor(),
    mode: 'full',
    deps: { kernelDurable: true, contextProjectId: 'acme-store', createStore: () => store },
  });
  assert.equal(res.ok, true);
  assert.equal(res.durable, true);
  assert.equal(res.status, 'onboarding');

  const list = await pc.listProductsResolved({ durable: true, store });
  assert.equal(list.length, 1);
  assert.equal(list[0].projectId, 'acme-store');
  assert.equal(list[0].status, 'onboarding');

  // El descriptor#self también quedó persistido (CA-3: sin huérfanos).
  const desc = await store.getDescriptor('acme-store');
  assert.ok(desc, 'descriptor#self debe existir tras el alta durable');
});

// -----------------------------------------------------------------------------
// CA-3 / CA-4 — fallo parcial: addToCatalog falla tras putItem(producto) ⇒
// producto NO aparece en listProducts (huérfano invisible) y el alta se reporta
// al operador (no auto-continúa).
// -----------------------------------------------------------------------------

test('CA-3/CA-4: fallo parcial deja el producto invisible y reporta al operador', async () => {
  const base = require('../provisioner-infra').createInMemoryDynamoDriver();
  const faulty = makeFailingDriver(base, 'catalog#', () => new Error('infra: catalog write down'));
  const store = ks.createKernelStore({ contextProjectId: 'acme-store', driver: faulty });

  const res = await b.runBootstrapAsync({
    descriptor: validDescriptor(),
    mode: 'full',
    deps: { kernelDurable: true, contextProjectId: 'acme-store', createStore: () => store },
  });
  // CA-4: fail-closed, se reporta al operador.
  assert.equal(res.ok, false);
  assert.equal(res.stage, 'register-durable');
  assert.equal(res.durable, true);

  // CA-3: el producto quedó huérfano INVISIBLE — no aparece en el catálogo.
  const list = await store.listProducts();
  assert.equal(list.length, 0, 'producto huérfano no indexado no debe listarse');
});

// -----------------------------------------------------------------------------
// CA-5 / CA-14 / CA-15 — distinción de error tipado + sanitización.
// -----------------------------------------------------------------------------

test('CA-5: ConditionalCheckFailedException mapea a "no quedó a medias"', async () => {
  const base = require('../provisioner-infra').createInMemoryDynamoDriver();
  const faulty = makeFailingDriver(base, 'product#', () => new ConditionalCheckFailedError('cond'));
  const store = ks.createKernelStore({ contextProjectId: 'acme-store', driver: faulty });

  const res = await b.runBootstrapAsync({
    descriptor: validDescriptor(),
    mode: 'full',
    deps: { kernelDurable: true, contextProjectId: 'acme-store', createStore: () => store },
  });
  assert.equal(res.ok, false);
  assert.equal(res.errorClass, 'conditional');
  assert.match(res.errors[0].detail, /no quedó a medias|no quedo a medias/i);
});

test('CA-5: classifyStoreError distingue conditional / validation / infra', () => {
  assert.equal(b.classifyStoreError(new ConditionalCheckFailedError('x')), 'conditional');
  assert.equal(b.classifyStoreError(new ks.KernelStoreValidationError('x', {})), 'validation');
  assert.equal(b.classifyStoreError(new ks.KernelStoreIsolationError('x', {})), 'validation');
  assert.equal(b.classifyStoreError(new Error('boom')), 'infra');
});

test('CA-14/15: el mensaje al operador NO expone ARN/tabla/SK/partición', async () => {
  const base = require('../provisioner-infra').createInMemoryDynamoDriver();
  const faulty = makeFailingDriver(base, 'catalog#', () => new Error('table arn:aws:dynamodb:us-east-1:123:table/kernel-store SK=catalog#index PK=acme'));
  const store = ks.createKernelStore({ contextProjectId: 'acme-store', driver: faulty });

  const res = await b.runBootstrapAsync({
    descriptor: validDescriptor(),
    mode: 'full',
    deps: { kernelDurable: true, contextProjectId: 'acme-store', createStore: () => store },
  });
  assert.equal(res.ok, false);
  const visible = res.human + ' ' + JSON.stringify(res.errors);
  assert.doesNotMatch(visible, /arn:aws/i, 'no debe exponer ARN');
  assert.doesNotMatch(visible, /kernel-store/i, 'no debe exponer tableName');
  assert.doesNotMatch(visible, /catalog#index|SK=|PK=/i, 'no debe exponer SK/PK/partición');
});

// -----------------------------------------------------------------------------
// CA-9 — contextProjectId deriva de la credencial, no del descriptor.
// -----------------------------------------------------------------------------

test('CA-9: contextProjectId ≠ descriptor.projectId ⇒ el store rechaza (anti tenant-hopping)', async () => {
  // La credencial de la instancia es "other-tenant"; el wizard trae "acme-store".
  const store = ks.createKernelStore({ contextProjectId: 'other-tenant' });
  const res = await b.runBootstrapAsync({
    descriptor: validDescriptor(), // identity.projectId = acme-store
    mode: 'full',
    deps: { kernelDurable: true, contextProjectId: 'other-tenant', createStore: () => store },
  });
  assert.equal(res.ok, false, 'el store no debe permitir escribir en otra partición');
  assert.equal(res.stage, 'register-durable');
});

test('CA-9: sin contextProjectId el write path durable falla fail-closed', async () => {
  const store = ks.createKernelStore({ contextProjectId: 'acme-store' });
  const res = await b.runBootstrapAsync({
    descriptor: validDescriptor(),
    mode: 'full',
    deps: { kernelDurable: true, createStore: () => store }, // sin contextProjectId
  });
  assert.equal(res.ok, false);
  assert.equal(res.stage, 'register-durable');
});

// -----------------------------------------------------------------------------
// CA-10 — validateDescriptor antes de escribir.
// -----------------------------------------------------------------------------

test('CA-10: descriptor inválido no llega a persistirse (fail-closed antes del store)', async () => {
  // Descriptor inválido nunca pasa `prepareBootstrap` → ni se instancia el store.
  let storeCalled = false;
  const res = await b.runBootstrapAsync({
    descriptor: { schemaVersion: '1.0' },
    mode: 'full',
    deps: { kernelDurable: true, contextProjectId: 'acme-store', createStore: () => { storeCalled = true; return null; } },
  });
  assert.equal(res.ok, false);
  assert.match(res.stage, /^validation:/);
  assert.equal(storeCalled, false);
});

// -----------------------------------------------------------------------------
// security#2 — fallback FS SELECTIVO en la lectura del catálogo.
// -----------------------------------------------------------------------------

test('security#2: store no disponible (infra) ⇒ fallback FS loggeado', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-'));
  fs.writeFileSync(path.join(tmp, 'p.json'), JSON.stringify({
    identity: { projectId: 'acme-store', name: 'ACME Store' }, status: 'active',
  }));
  let degraded = null;
  const fakeStore = { listProducts: async () => { throw new Error('infra down'); } };
  const out = await pc.listProductsResolved({
    durable: true, descriptorsDir: tmp, store: fakeStore, onDegraded: (r) => { degraded = r; },
  });
  assert.equal(out.length, 1, 'debe caer a FS ante fallo de infra');
  assert.ok(degraded, 'debe loggear el modo degradado');
});

test('security#2: KernelStoreValidationError NO cae a FS — propaga/escala', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-'));
  fs.writeFileSync(path.join(tmp, 'p.json'), JSON.stringify({
    identity: { projectId: 'acme-store', name: 'ACME Store' }, status: 'active',
  }));
  let degraded = false;
  const fakeStore = { listProducts: async () => { throw new ks.KernelStoreValidationError('catálogo corrupto', { stage: 'schema' }); } };
  await assert.rejects(
    () => pc.listProductsResolved({ durable: true, descriptorsDir: tmp, store: fakeStore, onDegraded: () => { degraded = true; } }),
    /catálogo corrupto|KernelStoreValidationError/,
  );
  assert.equal(degraded, false, 'ante tampering NO debe degradar a FS');
});

test('security#2: store no instanciable ⇒ fallback FS', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-'));
  fs.writeFileSync(path.join(tmp, 'p.json'), JSON.stringify({ identity: { projectId: 'acme-store', name: 'A' } }));
  let degraded = null;
  const out = await pc.listProductsResolved({
    durable: true, descriptorsDir: tmp, createStore: () => { throw new Error('no driver'); }, onDegraded: (r) => { degraded = r; },
  });
  assert.equal(out.length, 1);
  assert.ok(degraded);
});

// -----------------------------------------------------------------------------
// security#6 / guard estático — el alta escribe SIEMPRE por putProduct; el write
// path durable NUNCA usa driver.putItem directo ni fs.readFileSync(registry.json).
// -----------------------------------------------------------------------------

test('security#6: el write path durable no usa driver.putItem directo ni registry.json', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'project-bootstrap.js'), 'utf8');
  const durableFn = src.slice(src.indexOf('async function durableRegisterProduct'), src.indexOf('// Error interno del write path durable'));
  assert.ok(durableFn.length > 0, 'debe existir durableRegisterProduct');
  assert.doesNotMatch(durableFn, /driver\.putItem/, 'el alta durable no debe llamar driver.putItem directo (security#6)');
  assert.doesNotMatch(durableFn, /readFileSync/, 'el alta durable no debe leer registry.json (split-brain security#1)');
  assert.match(durableFn, /putProduct/, 'el alta durable debe pasar por putProduct');
});

// -----------------------------------------------------------------------------
// CA-6 — el flag se lee UNA sola vez (readKernelConfig honra el override inyectado).
// -----------------------------------------------------------------------------

test('CA-6: readKernelConfig honra kernelDurable inyectado y default fail-closed', () => {
  assert.equal(b.readKernelConfig({ kernelDurable: true }).durable, true);
  assert.equal(b.readKernelConfig({ kernelDurable: false }).durable, false);
  // config.yaml del repo: default OFF.
  assert.equal(b.readKernelConfig({}).durable, false, 'config.yaml default debe ser durable:false');
  // path inexistente ⇒ fail-closed a FS.
  assert.equal(b.readKernelConfig({ configPath: '/no/existe.yaml' }).durable, false);
});
