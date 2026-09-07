'use strict';

// =============================================================================
// kernel-cutover-probe.test.js — Sonda POSITIVA del cutover durable (#5208)
//
// Lo que estos tests protegen es UN invariante: que la sonda no pueda dar verde
// sin evidencia NO VACÍA comparada entre la API del kernel y una lectura
// consistente. El falso verde de "dos conjuntos vacíos" es el modo de falla que
// la historia existe para evitar, así que tiene test propio y explícito.
// =============================================================================

const test = require('node:test');
const assert = require('node:assert');

const probe = require('../kernel-cutover-probe');
const { createInMemoryDynamoDriver } = require('../provisioner-infra');
const { CONTROL_PLANE_PROJECT_ID } = require('../project-descriptor');

const TENANT = 'sonda-cutover-5208';
const TABLE = 'kernel-store-local';
const KERNEL_CFG = { tableName: TABLE, region: 'us-east-2', runtimePrincipal: 'intrale-kernel-runtime' };

// Identidad efectiva OK — el paso 1 se cubre aparte con sus propios tests.
const identidadOk = () => ({ ok: true, principal: 'intrale-kernel-runtime', arn: 'arn:aws:iam::<ACCT>:user/intrale-kernel-runtime' });

// Lector "crudo" de la sonda, servido por el MISMO driver in-memory que usó el
// alta. Es un doble del `aws dynamodb get-item --consistent-read`: acá no hay
// AWS, pero el contrato de entrada/salida es idéntico.
function fakeConsistentReader(driver) {
  return ({ pk, sk }) => {
    const found = driver.__items ? driver.__items.get(`${pk}|${sk}`) : null;
    return { ok: true, item: found || null };
  };
}

// Driver in-memory instrumentado: espeja los `putItem` en un índice plano para
// que el lector crudo pueda resolver por (PK, SK) sin depender de internals.
function makeDriver() {
  const driver = createInMemoryDynamoDriver();
  const items = new Map();
  const origPut = driver.putItem.bind(driver);
  driver.__items = items;
  driver.putItem = async (spec, item, opts) => {
    const res = await origPut(spec, item, opts);
    items.set(`${item.PK}|${item.SK}`, JSON.parse(JSON.stringify(item)));
    return res;
  };
  return driver;
}

async function correrSonda(overrides = {}) {
  const driver = overrides.driver || makeDriver();
  return {
    driver,
    res: await probe.runCutoverProbe({
      contextProjectId: overrides.contextProjectId || TENANT,
      kernelConfig: overrides.kernelConfig || KERNEL_CFG,
      deps: {
        verifyRuntimeIdentity: overrides.verifyRuntimeIdentity || identidadOk,
        storeDriver: driver,
        getItemConsistent: overrides.getItemConsistent || fakeConsistentReader(driver),
        ...(overrides.deps || {}),
      },
    }),
  };
}

// -----------------------------------------------------------------------------
// Camino feliz: evidencia positiva no vacía
// -----------------------------------------------------------------------------

test('la sonda da verde comparando una entidad NO VACIA entre la API y la lectura consistente', async () => {
  const { res } = await correrSonda();
  assert.equal(res.ok, true, `la sonda debería pasar; falló en ${res.failedStage}: ${res.error}`);

  // La comparación tiene que haber mirado las TRES entidades del alcance, no una.
  const entidades = res.comparaciones.map((c) => c.entity);
  assert.ok(entidades.some((e) => e.startsWith('descriptor#self')), 'debe comparar descriptor#self');
  assert.ok(entidades.some((e) => e.startsWith(`product#${TENANT}`)), 'debe comparar product#<id>');
  assert.ok(entidades.some((e) => e.startsWith('catalog#index')), 'debe comparar catalog#index');

  // Y tiene que haber comparado PK, SK, versión y contenido — no sólo presencia.
  const campos = res.comparaciones.flatMap((c) => c.checks.map((k) => k.campo));
  assert.ok(campos.includes('PK'), 'debe comparar PK');
  assert.ok(campos.includes('SK'), 'debe comparar SK');
  assert.ok(campos.some((c) => /version/i.test(c)), 'debe comparar la versión');
  assert.ok(campos.some((c) => /contenido|indexa el alta/.test(c)), 'debe comparar el contenido');

  assert.equal(res.degradations.length, 0, 'no puede haber eventos de degradación en el camino feliz');
});

test('el descriptor#self queda en la particion del TENANT y product#/catalog# en la del control-plane', async () => {
  const { res, driver } = await correrSonda();
  assert.equal(res.ok, true);

  assert.ok(driver.__items.has(`${TENANT}|descriptor#self`), 'descriptor#self debe vivir en la partición del tenant');
  assert.ok(driver.__items.has(`${CONTROL_PLANE_PROJECT_ID}|product#${TENANT}`), 'product# debe vivir en la partición del control-plane');
  assert.ok(driver.__items.has(`${CONTROL_PLANE_PROJECT_ID}|catalog#index`), 'catalog#index debe vivir en la partición del control-plane');

  // El inverso también importa: nada del catálogo global puede haber caído en la
  // partición del tenant (era el defecto (b) que cerró #5204).
  assert.ok(!driver.__items.has(`${TENANT}|catalog#index`), 'catalog#index NO puede escribirse en la partición del tenant');
});

// -----------------------------------------------------------------------------
// El falso verde: dos conjuntos vacíos
// -----------------------------------------------------------------------------

test('dos conjuntos vacios NO pueden dar verde: un item ausente del lado crudo es rojo', async () => {
  const { res } = await correrSonda({ getItemConsistent: () => ({ ok: true, item: null }) });
  assert.equal(res.ok, false, 'con la lectura consistente vacía la sonda NO puede aprobar');
  assert.match(res.failedStage, /comparación/);
});

test('compareEntity marca rojo si el contenido es un objeto vacio de los dos lados', () => {
  const c = probe.compareEntity({
    entity: 'descriptor#self',
    expectedPK: 'x', expectedSK: 'descriptor#self',
    apiBody: {},
    dynamoItem: { PK: 'x', SK: 'descriptor#self', schemaVersion: '1.0', body: {} },
  });
  assert.equal(c.ok, false, 'un body vacío de ambos lados es paridad de la nada, no evidencia');
  const noVacio = c.checks.find((k) => k.campo === 'no-vacío');
  assert.equal(noVacio.ok, false);
});

test('compareEntity detecta contenido distinto aunque PK y SK coincidan', () => {
  const c = probe.compareEntity({
    entity: 'descriptor#self',
    expectedPK: 'x', expectedSK: 'descriptor#self',
    apiBody: { identity: { projectId: 'x' } },
    dynamoItem: { PK: 'x', SK: 'descriptor#self', schemaVersion: '1.0', body: { identity: { projectId: 'OTRO' } } },
  });
  assert.equal(c.ok, false, 'mismo PK/SK con contenido distinto tiene que ser rojo');
  const contenido = c.checks.find((k) => /contenido/.test(k.campo));
  assert.equal(contenido.ok, false);
});

// -----------------------------------------------------------------------------
// Contexto fuera de banda (A01 · SEC-1)
// -----------------------------------------------------------------------------

test('un contextProjectId RESERVADO se rechaza antes de escribir nada', async () => {
  const driver = makeDriver();
  const { res } = await correrSonda({ contextProjectId: 'intrale-platform', driver });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'contexto_reservado');
  assert.equal(driver.__items.size, 0, 'un contexto reservado no puede haber escrito un solo ítem');
  assert.match(res.error, /intrale-platform/, 'el error debe nombrar el id reservado para que el operador entienda');
});

test('un contextProjectId con forma insegura se rechaza antes de escribir nada', async () => {
  const driver = makeDriver();
  const { res } = await correrSonda({ contextProjectId: '../escape', driver });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'contexto_invalido');
  assert.equal(driver.__items.size, 0);
});

test('la sonda negativa cross-tenant es obligatoria: un contexto ajeno no lee la particion sondeada', async () => {
  const { res } = await correrSonda();
  assert.equal(res.ok, true);
  const paso = res.steps.find((s) => s.etapa === 'negativa cross-tenant');
  assert.ok(paso, 'el reporte debe incluir la sonda negativa');
  assert.equal(paso.ok, true);
  assert.match(paso.detalle, /RECHAZADO/);
});

// -----------------------------------------------------------------------------
// Identidad efectiva (SEC-6)
// -----------------------------------------------------------------------------

test('sin kernel.runtimePrincipal declarado la verificacion de identidad falla fail-closed', () => {
  const r = probe.verifyRuntimeIdentity({ expectedPrincipal: null });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'runtime_principal_ausente');
});

test('un principal distinto del declarado aborta la sonda y lo dice sin ambiguedad', async () => {
  const driver = makeDriver();
  const { res } = await correrSonda({
    driver,
    verifyRuntimeIdentity: () => probe.verifyRuntimeIdentity({
      expectedPrincipal: 'intrale-kernel-runtime',
      spawnSync: () => ({ status: 0, stdout: JSON.stringify({ Arn: 'arn:aws:iam::123456789012:user/admin-suelto' }) }),
    }),
  });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'identidad_inesperada');
  assert.equal(driver.__items.size, 0, 'con identidad equivocada no se escribe nada');
  assert.match(res.error, /admin-suelto/);
});

test('la identidad efectiva coincidente habilita la sonda', () => {
  const r = probe.verifyRuntimeIdentity({
    expectedPrincipal: 'intrale-kernel-runtime',
    spawnSync: () => ({ status: 0, stdout: JSON.stringify({ Arn: 'arn:aws:iam::123456789012:user/intrale-kernel-runtime' }) }),
  });
  assert.equal(r.ok, true);
  assert.equal(r.principal, 'intrale-kernel-runtime');
});

// -----------------------------------------------------------------------------
// Redacción (A02 · SEC-2)
// -----------------------------------------------------------------------------

test('el reporte no filtra account-id de AWS', async () => {
  const r = probe.verifyRuntimeIdentity({
    expectedPrincipal: 'intrale-kernel-runtime',
    spawnSync: () => ({ status: 0, stdout: JSON.stringify({ Arn: 'arn:aws:iam::123456789012:user/intrale-kernel-runtime' }) }),
  });
  assert.ok(!r.arn.includes('123456789012'), 'el account-id no puede salir en claro');
  assert.match(r.arn, /<ACCT>/);
});

test('redactAccountIds reemplaza cualquier secuencia de 12 digitos', () => {
  assert.equal(probe.redactAccountIds('arn:aws:dynamodb:us-east-2:210987654321:table/x'), 'arn:aws:dynamodb:us-east-2:<ACCT>:table/x');
});

// -----------------------------------------------------------------------------
// Fail-loud (SEC-3 / SEC-5)
// -----------------------------------------------------------------------------

test('cualquier evento de degradacion observado invalida el verde de la sonda', async () => {
  const driver = makeDriver();
  const res = await probe.runCutoverProbe({
    contextProjectId: TENANT,
    kernelConfig: KERNEL_CFG,
    deps: {
      verifyRuntimeIdentity: identidadOk,
      storeDriver: driver,
      getItemConsistent: fakeConsistentReader(driver),
      // El alta reporta una degradación por `onAlert`; todo lo demás sale bien.
      durableRegisterProduct: async (entry, descriptor, deps) => {
        const real = require('../project-bootstrap').durableRegisterProduct;
        const out = await real(entry, descriptor, deps);
        deps.onAlert({ stage: 'boot-durable', errors: [{ detail: 'degradó a filesystem' }] });
        return out;
      },
    },
  });
  assert.equal(res.ok, false, 'con una degradación observada la sonda NO puede aprobar');
  assert.equal(res.code, 'degradacion_observada');
  assert.match(res.report, /NO cierres la ventana/);
});

// -----------------------------------------------------------------------------
// Config incompleta (SEC-3)
// -----------------------------------------------------------------------------

test('sin tableName o region la sonda aborta antes de tocar AWS', async () => {
  const { res } = await correrSonda({ kernelConfig: { region: 'us-east-2', runtimePrincipal: 'x' } });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'config_incompleta');
});

// -----------------------------------------------------------------------------
// Decodificación de AttributeValue (el puente entre los dos caminos de lectura)
// -----------------------------------------------------------------------------

test('fromAttrItem desenvuelve el formato AttributeValue de DynamoDB', () => {
  const item = probe.fromAttrItem({
    PK: { S: 'acme' },
    SK: { S: 'catalog#index' },
    body: { M: { version: { N: '3' }, products: { L: [{ S: 'acme' }] }, activo: { BOOL: true } } },
  });
  assert.deepEqual(item, { PK: 'acme', SK: 'catalog#index', body: { version: 3, products: ['acme'], activo: true } });
});

test('parseArgs del CLI lee --project-id y --profile', () => {
  assert.deepEqual(probe.parseArgs(['--project-id', 'acme', '--profile', 'runtime']), { projectId: 'acme', profile: 'runtime' });
});
