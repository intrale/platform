'use strict';

// =============================================================================
// product-isolation-4811.test.js — Evidencia versionada de aislamiento de estado
// por producto (issue #4811 · Ola 8 "Cierre de gestión de producto nuevo").
//
// Historia de VERIFICACIÓN sobre infraestructura ya mergeada (Ola Puente): un
// producto nuevo no debe pisar olas ni worktrees ni el store durable del monorepo
// `intrale-platform`. El entregable es evidencia reproducible + tests `node --test`.
//
// Esta suite es el artefacto de evidencia integrador: un `describe` por criterio
// de aceptación (CA-1..CA-8 del comentario del PO). Reusa el driver in-memory del
// kernel-store (mismo patrón que kernel-store.test.js) — no inventa mocks nuevos.
//
// Mapa de CA:
//   CA-1  Aislamiento de olas: correr la "ola" del producto nuevo no muta el
//         estado durable del monorepo (snapshot tamper-evident, diff vacío).
//   CA-2  Frontera FS/worktrees: el aislamiento del FS del 2º producto es por
//         ROOT/partición separada, NO por namespacing intra-árbol; toda mutación
//         del store cae bajo la partición del producto nuevo.
//   CA-3  kernel-store durable anti-IDOR: leer/operar la partición del monorepo
//         desde el contexto del producto nuevo dispara KernelStoreIsolationError.
//   CA-4  Validación estricta de productId/slug (allowlist + id reservado).
//   CA-5  Caso negativo de path traversal (BLOQUEANTE): productId/paths maliciosos
//         rechazados ANTES de materializar SK o path FS, sin tocar el monorepo.
//   CA-6  Atomicidad del catalog#index bajo concurrencia real (A08) — regresión
//         del last-write-wins arreglado (CA-9).
//   CA-7  Sin fuga de secretos cross-tenant (refs namespaceadas).
//   CA-8  Evidencia tamper-evident: hash del estado del monorepo antes/después.
// =============================================================================

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { createInMemoryDynamoDriver } = require('../provisioner-infra');
const {
  createKernelStore,
  KernelStoreIsolationError,
  KernelStoreValidationError,
} = require('../kernel-store');
const projectDescriptor = require('../project-descriptor');
const { isSafeId, isSafeWorktreePath, collectPathTraversalHits, isReservedProjectId } = projectDescriptor;

const MONOREPO = 'intrale-platform';
const NUEVO = 'producto-nuevo';

// ---------------------------------------------------------------------------
// Helpers de evidencia
// ---------------------------------------------------------------------------

/**
 * Envuelve un driver in-memory registrando toda MUTACIÓN (putItem/deleteItem) con
 * su PK/SK. Es la "cámara" tamper-evident a nivel de frontera del store: permite
 * afirmar que la ola del producto nuevo NO escribió ninguna clave de otro tenant.
 */
function spyDriver(inner) {
  const mutations = [];
  return {
    driver: {
      kind: inner.kind,
      createTable: (...a) => inner.createTable(...a),
      describeTable: (...a) => inner.describeTable(...a),
      getItem: (...a) => inner.getItem(...a),
      async putItem(spec, item, opts) {
        mutations.push({ op: 'put', pk: item.PK, sk: item.SK });
        return inner.putItem(spec, item, opts);
      },
      async deleteItem(spec, key, opts) {
        mutations.push({ op: 'delete', pk: key.PK, sk: key.SK });
        return inner.deleteItem(spec, key, opts);
      },
    },
    mutations,
  };
}

function descriptorFor(projectId, name) {
  return {
    schemaVersion: '1.0',
    identity: { projectId, name },
    repositories: [{ id: 'main', url: `https://github.com/acme/${projectId}`, role: 'primary' }],
    board: {
      ref: 'https://github.com/orgs/acme/projects/1',
      admissionLabels: ['Ready'],
      routing: [{ label: 'area:backend', capability: 'backend' }],
    },
    credentials: [{ ref: `~/.claude/secrets/credentials.json#${projectId}`, scopes: ['github'] }],
    capabilities: [{ interface: 'backend', skills: ['backend-dev'] }],
    authority: { signers: ['leitolarreta'], gates: { gate2: 'enforce' } },
  };
}

function makeStore(driver, contextProjectId) {
  const clock = { t: 1000 };
  return createKernelStore({
    driver,
    contextProjectId,
    allowedNamespaces: [contextProjectId],
    now: () => clock.t,
  });
}

// Spec de la tabla in-memory del kernel-store (mismo tableName por defecto que
// `kernel-store.js`: DEFAULT_INMEMORY_TABLE = 'kernel-store-local').
const specFor = (tableName = 'kernel-store-local') => ({
  type: 'dynamodb_table',
  tableName,
  keys: [
    { name: 'PK', attributeType: 'S', keyType: 'HASH' },
    { name: 'SK', attributeType: 'S', keyType: 'RANGE' },
  ],
});

// Ítem crudo con el mismo envelope que produce el kernel-store internamente.
function rawItem(entityType, sk, body, projectId) {
  return { PK: projectId, SK: sk, entityType, projectId, schemaVersion: '1.0', body };
}

/**
 * Siembra un producto como estado durable *legacy* escribiendo directo en el
 * driver, SIN pasar por la ruta pública `store.putProduct(...)`. Necesario para
 * `intrale-platform`: desde #4852 el id reservado del monorepo es rechazado en
 * el alta pública (`stage: 'reserved-id'`), así que simular su estado durable
 * preexistente requiere inyección controlada (misma técnica que el fixture
 * legacy de `kernel-store.test.js`). Escribe `product#<id>` y agrega `<id>` al
 * `catalog#index` para que `listProducts()` lo recupere.
 */
async function seedLegacyProduct(driver, projectId, product) {
  const spec = specFor();
  await driver.createTable(spec); // idempotente
  const body = { productId: product.productId, name: product.name };
  await driver.putItem(spec, rawItem('product', `product#${product.productId}`, body, projectId));
  const cur = await driver.getItem(spec, { PK: projectId, SK: 'catalog#index' });
  const ids = cur && cur.item ? (cur.item.body.productIds || []).slice() : [];
  const version = cur && cur.item && Number.isInteger(cur.item.body.version) ? cur.item.body.version : 0;
  if (!ids.includes(product.productId)) ids.push(product.productId);
  await driver.putItem(spec, rawItem('catalog', 'catalog#index', { productIds: ids, version: version + 1 }, projectId));
}

/**
 * Proyección canónica y determinística del estado durable legible de un producto
 * (descriptor + catálogo de productos). Base del hash tamper-evident (CA-8).
 */
async function snapshotState(store) {
  const descriptor = await store.getDescriptor(store.contextProjectId).catch(() => null);
  const products = await store.listProducts();
  const canonical = JSON.stringify({
    projectId: store.contextProjectId,
    descriptor: descriptor ? descriptor.body : null,
    products: products.slice().sort((a, b) => (a.productId < b.productId ? -1 : 1)),
  });
  return { canonical, hash: crypto.createHash('md5').update(canonical).digest('hex') };
}

/**
 * "Corre la ola" del producto: ciclo de vida durable completo sobre su partición.
 * `driver` habilita la siembra legacy del producto self cuando el contexto es el
 * id reservado del monorepo (`intrale-platform`), que #4852 ya no admite por la
 * ruta pública de alta.
 */
async function runOla(store, driver) {
  await store.putDescriptor(descriptorFor(store.contextProjectId, `Producto ${store.contextProjectId}`));
  if (isReservedProjectId(store.contextProjectId)) {
    // Estado durable preexistente del monorepo: se inyecta como fixture legacy,
    // no por `putProduct` (que rechaza el id reservado desde #4852).
    await seedLegacyProduct(driver, store.contextProjectId, { productId: store.contextProjectId, name: 'Self' });
  } else {
    await store.putProduct({ productId: store.contextProjectId, name: 'Self' });
  }
  await store.putProduct({ productId: `${store.contextProjectId}-svc`, name: 'Servicio' });
  await store.appendAuditEntry({ action: 'wave-started', actor: 'pulpo' });
  await store.putSignature({ signer: 'leitolarreta', target: 'pr-x', checksum: 'a'.repeat(64), algorithm: 'sha256' });
  await store.claim(store.contextProjectId, 'dev');
}

// ---------------------------------------------------------------------------
// CA-1 — Aislamiento de olas
// ---------------------------------------------------------------------------

describe('#4811 CA-1 · aislamiento de olas (estado durable del monorepo intacto)', () => {
  test('correr la ola del producto nuevo no muta el estado durable del monorepo', async () => {
    const base = createInMemoryDynamoDriver();
    const { driver, mutations } = spyDriver(base);

    // El monorepo ya tiene su estado (su "ola" corrida).
    const mono = makeStore(driver, MONOREPO);
    await runOla(mono, driver);
    const before = await snapshotState(mono);

    // Alta + ola del producto nuevo sobre el MISMO driver (mismo host/tabla).
    const nuevo = makeStore(driver, NUEVO);
    mutations.length = 0; // sólo observamos las mutaciones de la ola del producto nuevo
    await runOla(nuevo, driver);

    // El snapshot durable del monorepo no cambió (hash idéntico = diff vacío).
    const after = await snapshotState(mono);
    assert.equal(after.hash, before.hash, 'el estado durable del monorepo cambió (fuga CA-1)');

    // Y ninguna mutación de la ola del producto nuevo tocó la partición del monorepo.
    const tocaronMonorepo = mutations.filter((m) => m.pk === MONOREPO);
    assert.deepEqual(tocaronMonorepo, [], 'la ola del producto nuevo escribió en la partición del monorepo (fuga CA-1)');
    assert.ok(mutations.length > 0, 'la ola del producto nuevo sí produjo mutaciones (en su propia partición)');
  });
});

// ---------------------------------------------------------------------------
// CA-2 — Frontera FS / worktrees
// ---------------------------------------------------------------------------

describe('#4811 CA-2 · frontera FS/worktrees por partición separada, no namespacing intra-árbol', () => {
  test('toda mutación durable de un producto cae bajo su propia partición (PK)', async () => {
    const base = createInMemoryDynamoDriver();
    const { driver, mutations } = spyDriver(base);
    const nuevo = makeStore(driver, NUEVO);
    await runOla(nuevo, driver);
    // Frontera durable: el 100% de las mutaciones del producto nuevo llevan PK=NUEVO.
    const fuera = mutations.filter((m) => m.pk !== NUEVO);
    assert.deepEqual(fuera, [], 'hubo mutaciones fuera de la partición del producto (frontera rota)');
  });

  test('la ruta de worktree del descriptor rechaza traversal / absoluta / ~ (aislamiento FS)', () => {
    // La frontera FS real del 2º producto es ROOT/clon separado (provisioner); el
    // descriptor sólo admite subpaths relativos seguros para su worktreeRoot.
    for (const bad of ['../fuera', 'sub/../../fuera', '/abs', 'C:\\win', '~/home', 'a\0b']) {
      assert.equal(isSafeWorktreePath(bad), false, `worktreeRoot inseguro aceptado: ${JSON.stringify(bad)}`);
      const hits = collectPathTraversalHits({ identity: { projectId: NUEVO }, thresholds: { worktreeRoot: bad } });
      assert.ok(
        hits.some((h) => h.path === 'thresholds.worktreeRoot'),
        `collectPathTraversalHits no marcó el worktreeRoot inseguro ${JSON.stringify(bad)}`,
      );
    }
    // Un subpath relativo seguro sí se acepta (namespacing legítimo dentro del ROOT).
    assert.equal(isSafeWorktreePath('worktrees/producto-nuevo'), true);
  });
});

// ---------------------------------------------------------------------------
// CA-3 — kernel-store durable anti-IDOR
// ---------------------------------------------------------------------------

describe('#4811 CA-3 · kernel-store anti-IDOR (partición por projectId)', () => {
  test('leer la partición del monorepo desde el contexto del producto nuevo lanza KernelStoreIsolationError', async () => {
    const base = createInMemoryDynamoDriver();
    const mono = makeStore(base, MONOREPO);
    await mono.putDescriptor(descriptorFor(MONOREPO, 'Monorepo'));

    const nuevo = makeStore(base, NUEVO);
    await assert.rejects(
      () => nuevo.getDescriptor(MONOREPO),
      (e) => e instanceof KernelStoreIsolationError,
      'el producto nuevo pudo pedir la partición del monorepo (anti-IDOR roto)',
    );
    // Sobre su propia partición no ve nada del monorepo (ausencia legítima).
    assert.equal(await nuevo.getDescriptor(NUEVO), null);
  });

  test('validateItemOnRead rechaza (stage isolation) un ítem cuyo projectId/PK es de otra partición', () => {
    const nuevo = makeStore(createInMemoryDynamoDriver(), NUEVO);
    const foreign = { PK: MONOREPO, SK: 'product#p1', entityType: 'product', projectId: MONOREPO, schemaVersion: '1.0', body: { productId: 'p1', name: 'X' } };
    const v = nuevo.validateItemOnRead(foreign);
    assert.equal(v.valid, false);
    assert.equal(v.stage, 'isolation');
  });

  test('un descriptor que reclama el projectId reservado del monorepo desde otra instancia es rechazado (isolation)', async () => {
    // El contextProjectId deriva out-of-band de la credencial; un descriptor en
    // banda que reclame `intrale-platform` no puede escribir esa partición.
    const nuevo = makeStore(createInMemoryDynamoDriver(), NUEVO);
    await assert.rejects(
      () => nuevo.putDescriptor(descriptorFor(MONOREPO, 'Impostor')),
      (e) => e instanceof KernelStoreIsolationError,
    );
  });
});

// ---------------------------------------------------------------------------
// CA-4 — Validación estricta de productId / slug
// ---------------------------------------------------------------------------

describe('#4811 CA-4 · validación estricta de productId/slug', () => {
  test('isSafeId acepta ids de la allowlist y rechaza formas peligrosas', () => {
    for (const ok of ['producto-nuevo', 'p1', 'a-b-c', 'x0']) assert.equal(isSafeId(ok), true, `id válido rechazado: ${ok}`);
    for (const bad of ['..', '../x', 'x/../y', 'a/b', 'a\\b', '/abs', 'C:\\x', 'MAYUS', '-leading', 'a', '', null, 'a'.repeat(65)]) {
      assert.equal(isSafeId(bad), false, `id peligroso aceptado: ${JSON.stringify(bad)}`);
    }
  });

  test('el id reservado del monorepo matchea el patrón pero la selección de partición es out-of-band', () => {
    // Grounding del riesgo del arquitecto: isSafeId NO filtra el id reservado por
    // sí solo. La protección real no es una allowlist de reservados en isSafeId,
    // sino que el contextProjectId (partición) deriva de la credencial, nunca del
    // input en banda — verificado en CA-3 (descriptor impostor → isolation).
    assert.equal(isSafeId(MONOREPO), true);
  });
});

// ---------------------------------------------------------------------------
// CA-5 — Caso negativo de path traversal (BLOQUEANTE)
// ---------------------------------------------------------------------------

describe('#4811 CA-5 · caso negativo de path traversal (bloqueante)', () => {
  const TRAVERSAL_IDS = ['../intrale-platform', 'intrale-platform/../otro', '/abs', 'C:\\x', 'a\\b', '..', '~'];

  test('productId malicioso es rechazado antes de materializar SK, sin tocar el estado del monorepo', async () => {
    const base = createInMemoryDynamoDriver();
    const { driver, mutations } = spyDriver(base);

    const mono = makeStore(driver, MONOREPO);
    await runOla(mono, driver);
    const before = await snapshotState(mono);

    const nuevo = makeStore(driver, NUEVO);
    mutations.length = 0;
    for (const bad of TRAVERSAL_IDS) {
      await assert.rejects(
        () => nuevo.putProduct({ productId: bad, name: 'x' }),
        (e) => e instanceof KernelStoreValidationError,
        `productId traversal NO rechazado: ${JSON.stringify(bad)}`,
      );
    }
    // Ninguna escritura se materializó por los intentos maliciosos…
    assert.deepEqual(mutations, [], 'un productId traversal materializó una escritura (fuga CA-5)');
    // …y el snapshot del monorepo quedó idéntico.
    const after = await snapshotState(mono);
    assert.equal(after.hash, before.hash, 'el estado del monorepo cambió tras intentos de traversal (fuga CA-5)');
  });

  test('los ids de traversal fallan la sanitización de project-descriptor (isSafeId + collectPathTraversalHits)', () => {
    for (const bad of TRAVERSAL_IDS) {
      assert.equal(isSafeId(bad), false, `isSafeId aceptó ${JSON.stringify(bad)}`);
    }
    // collectPathTraversalHits marca un projectId inseguro en el descriptor.
    const hits = collectPathTraversalHits({ identity: { projectId: '../intrale-platform' }, repositories: [] });
    assert.ok(hits.some((h) => h.path === 'identity.projectId'), 'no marcó el projectId traversal');
  });
});

// ---------------------------------------------------------------------------
// CA-6 — Atomicidad del catalog#index bajo concurrencia (A08 · regresión CA-9)
// ---------------------------------------------------------------------------

describe('#4811 CA-6 · atomicidad del catalog#index bajo concurrencia', () => {
  test('altas concurrentes de productos distintos no pierden entradas del índice', async () => {
    const driver = createInMemoryDynamoDriver();
    const store = makeStore(driver, MONOREPO);
    // Fixture legacy controlado: la entrada del monorepo ya existe en el catálogo;
    // el id reservado no admite alta por la ruta pública (#4852).
    await seedLegacyProduct(driver, MONOREPO, { productId: MONOREPO, name: 'Monorepo' });
    await Promise.all([
      store.putProduct({ productId: 'producto-alfa', name: 'Alfa' }),
      store.putProduct({ productId: 'producto-beta', name: 'Beta' }),
    ]);
    const ids = (await store.listProducts()).map((p) => p.productId).sort();
    assert.deepEqual(ids, ['intrale-platform', 'producto-alfa', 'producto-beta']);
  });
});

// ---------------------------------------------------------------------------
// CA-7 — Sin fuga de secretos cross-tenant
// ---------------------------------------------------------------------------

describe('#4811 CA-7 · sin fuga de secretos cross-tenant (refs namespaceadas)', () => {
  test('un descriptor cuya credencial apunta a un namespace ajeno es rechazado (stage ref)', async () => {
    const nuevo = makeStore(createInMemoryDynamoDriver(), NUEVO);
    const desc = descriptorFor(NUEVO, 'Nuevo');
    desc.credentials = [{ ref: `~/.claude/secrets/credentials.json#${MONOREPO}`, scopes: ['github'] }];
    await assert.rejects(
      () => nuevo.putDescriptor(desc),
      (e) => e instanceof KernelStoreValidationError && e.stage === 'ref',
      'el producto nuevo pudo referenciar credenciales del monorepo (fuga CA-7)',
    );
  });

  test('validateItemOnRead rechaza (stage ref) un descriptor con ref a namespace fuera de allowlist', () => {
    const nuevo = makeStore(createInMemoryDynamoDriver(), NUEVO);
    const desc = descriptorFor(NUEVO, 'Nuevo');
    desc.credentials = [{ ref: `~/.claude/secrets/credentials.json#${MONOREPO}`, scopes: ['github'] }];
    const item = { PK: NUEVO, SK: 'descriptor#self', entityType: 'descriptor', projectId: NUEVO, schemaVersion: '1.0', body: desc };
    const v = nuevo.validateItemOnRead(item, { entityType: 'descriptor' });
    assert.equal(v.valid, false);
    assert.equal(v.stage, 'ref');
  });
});

// ---------------------------------------------------------------------------
// CA-8 — Evidencia tamper-evident y reproducible
// ---------------------------------------------------------------------------

describe('#4811 CA-8 · evidencia tamper-evident del estado del monorepo', () => {
  test('el hash del estado durable del monorepo es estable ante toda la actividad del producto nuevo', async () => {
    const base = createInMemoryDynamoDriver();
    const mono = makeStore(base, MONOREPO);
    await runOla(mono, base);
    const h0 = (await snapshotState(mono)).hash;

    // Actividad intensa del producto nuevo: descriptor, N productos, audit, firmas.
    const nuevo = makeStore(base, NUEVO);
    await nuevo.putDescriptor(descriptorFor(NUEVO, 'Nuevo'));
    await Promise.all(Array.from({ length: 6 }, (_, i) => nuevo.putProduct({ productId: `svc-${i}`, name: `S${i}` })));
    await nuevo.appendAuditEntry({ action: 'stress', actor: 'pulpo' });

    const h1 = (await snapshotState(mono)).hash;
    assert.equal(h1, h0, 'el hash del monorepo cambió: evidencia de fuga de estado');
    // El hash es reproducible (md5 estable de una proyección canónica).
    assert.match(h0, /^[a-f0-9]{32}$/);
  });
});
