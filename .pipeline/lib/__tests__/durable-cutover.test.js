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
  // CA-6 / D-4 — `readKernelConfig({})` lee el config REAL del repo. Lo que el
  // test protege es que el valor salga de ahí y no de un default inventado por
  // el consumidor; el valor concreto es una decisión operativa que cambia.
  //
  // #5208 lo encendió al ejecutar el cutover, así que la aserción se ancla al
  // archivo en vez de a la constante `false`: si alguien cambia el config, el
  // test lo sigue; si alguien rompe la LECTURA (default silencioso), falla.
  const yamlLib = require('js-yaml');
  const durableEnArchivo = yamlLib.load(
    fs.readFileSync(path.join(__dirname, '..', '..', 'config.yaml'), 'utf8'),
  ).kernel.durable;
  assert.equal(b.readKernelConfig({}).durable, durableEnArchivo,
    'readKernelConfig debe reflejar `kernel.durable` del config.yaml real, no un default propio');

  // #5172 — CAMBIO DELIBERADO DE CONTRATO. Antes esta línea afirmaba que un
  // `configPath` inexistente devolvía `durable:false`, y lo llamaba "fail-closed
  // a FS". No lo era: era el fail-OPEN que la historia viene a eliminar. El issue
  // lo cita por nombre como uno de los dos defectos canónicos
  // (`project-bootstrap.js:266-284` → `catch { return { durable: false } }`) y lo
  // pone como criterio de aceptación explícito: *"config ilegible falla
  // fail-closed, no degrada a objeto vacío"*.
  //
  // Por qué importa que sea indistinguible: `durable:false` es TAMBIÉN el valor
  // legítimo del rollout apagado (la aserción de arriba). Con el `catch`, "el
  // kernel durable está apagado porque así se configuró" y "no pude leer la
  // autoridad de la decisión" producían el MISMO valor, sin traza. Ahora sólo el
  // primero devuelve; el segundo lanza.
  assert.throws(
    () => b.readKernelConfig({ configPath: '/no/existe.yaml' }),
    (e) => e && e.name === 'ConfigParseViolation' && e.causa === 'ENOENT',
    'un configPath ilegible debe PROPAGAR el error tipado, no degradar a durable:false',
  );
});

// =============================================================================
// #5135 — Sink fail-loud de la degradación durable, ventana de cutover y
// redacción AWS. Numeración de CA heredada de #5125 (enmendada por el PO en
// `criterios` y consolidada por UX en `validacion`).
//
//   CA-1  · ventana explícita, default OFF, best-effort intacto con `false`.
//   CA-2  · sink fail-loud en los DOS caminos, disparado sólo por la degradación real.
//   CA-3  · el mapeo vive en el borde de salida (kernel-supervisor.test.js sin tocar).
//   CA-4  · enum cerrado de 7 causas por allow-list.
//   CA-5  · las 4 piezas de UX-1, asserteadas UNA POR UNA, en los dos templates.
//   CA-6  · asimetría por frontera de confianza, con el log local también redactado.
//   CA-8  · el test de "sin ARN" tiene dientes (fixture realista + GURU-10).
//   CA-9  · no-regresión de corrupción + test negativo de stages sanos.
//   CA-10 · rate-limit SÓLO sobre el canal, nunca sobre clasificación/log/abort.
//   CA-20 · el abort deja auditoría propia aunque no escriba el marker.
//   UX-6  · renderizabilidad del template en el dialecto declarado.
// =============================================================================

const kda = require('../kernel-degradation-alert');
const supervisor = require('../kernel-supervisor');

// CA-8 · Fixture de stderr de AccessDenied REALISTA y bien formado, con ARN
// sintético y account-id de 12 dígitos. `new Error('no driver')` no tendría
// dientes: el punto es probar que el template NO interpola nada del driver.
const STDERR_ACCESS_DENIED = 'An error occurred (AccessDeniedException) when calling the Query operation: '
  + 'User: arn:aws:sts::000000000000:assumed-role/intrale-pipeline-role/pulpo-session is not authorized to '
  + 'perform: dynamodb:Query on resource: arn:aws:dynamodb:us-east-1:000000000000:table/intrale-kernel-store';

// Arma un sink con dependencias falsas y captura todo lo observable.
function makeSink(overrides = {}) {
  const sent = [];
  const logs = [];
  const halts = [];
  const cutoverWindow = overrides.cutoverWindow === true;
  let clock = 1000000;
  const sink = kda.createDegradationSink({
    config: { kernel: { durable: true, cutover_window: cutoverWindow } },
    sendTelegram: (text, opts) => { sent.push({ text, opts }); return null; },
    log: (m) => logs.push(m),
    halt: overrides.halt || ((info) => { halts.push(info); return { markerWritten: true, preexisting: false }; }),
    redact: require('../redact').redactSecretValue,
    now: () => clock,
    generateCorrelationId: () => 'kdeg-1785269351499-5f0b34f6',
    cooldownMs: overrides.cooldownMs,
  });
  return { sink, sent, logs, halts, advance: (ms) => { clock += ms; } };
}

// -----------------------------------------------------------------------------
// CA-4 — Enum cerrado de 7 causas, allow-list. Tabla de clasificación completa.
// -----------------------------------------------------------------------------

test('CA-4: la tabla de clasificación mapea cada patrón conocido a su causa (7/7 ramas)', () => {
  const tabla = [
    ['access_denied', STDERR_ACCESS_DENIED],
    ['access_denied', 'User: x is not authorized to perform: dynamodb:Query'],
    ['credenciales_ausentes', 'Unable to locate credentials'],
    ['credenciales_ausentes', 'ExpiredToken: the security token included in the request is expired'],
    ['driver_ausente', 'driver AWS no disponible'],
    ['driver_ausente', 'spawn aws ENOENT'],
    ['throttling', 'ProvisionedThroughputExceededException: rate exceeded'],
    ['throttling', 'ThrottlingException: Rate exceeded'],
    ['red', 'connect ETIMEDOUT 52.94.5.1:443'],
    ['red', 'getaddrinfo EAI_AGAIN dynamodb.us-east-1.amazonaws.com'],
    // GURU-8 · el fallo MÁS PROBABLE del primer cutover real (config.yaml tiene
    // hoy tableName:"" y region:""). Con el enum de 6 causas caía en `desconocido`
    // y le daba al operador la acción equivocada.
    ['config_incompleta', 'config.tableName requerido para el driver real: la tabla/naming/región del kernel se define por config, nunca hardcode (A05/CA-9)'],
  ];
  for (const [esperada, raw] of tabla) {
    assert.equal(kda.classifyDegradation(raw), esperada, `"${raw.slice(0, 40)}…" debe clasificar ${esperada}`);
  }
  // Las 7 causas del enum están cubiertas por la tabla + el caso `desconocido`.
  const cubiertas = new Set(tabla.map(([c]) => c));
  cubiertas.add('desconocido');
  assert.deepEqual([...cubiertas].sort(), [...kda.CAUSES].sort(), 'cobertura 7/7 del enum');
});

test('CA-4: un error NO reconocido cae en `desconocido` y NO filtra su texto', () => {
  const raro = 'BizarreInternalFailure: arn:aws:kms::000000000000:key/abcd secreto-interno-42';
  assert.equal(kda.classifyDegradation(raro), 'desconocido');
  // "nunca pego lo que vino": el retorno es un token del enum, no el input.
  assert.ok(kda.CAUSES.includes(kda.classifyDegradation(raro)));
  const msg = kda.formatDegradationAlert({ cause: kda.classifyDegradation(raro), aborted: false });
  assert.doesNotMatch(msg, /BizarreInternalFailure|secreto-interno-42|arn:aws/);
});

test('CA-4: entradas basura (null/objeto/número) no rompen ni filtran — caen dentro del enum', () => {
  for (const raw of [null, undefined, 42, {}, []]) {
    const c = kda.classifyDegradation(raw);
    assert.ok(kda.CAUSES.includes(c), `${String(raw)} debe caer dentro del enum`);
  }
  // Un Error real sí se clasifica por su `message`.
  assert.equal(kda.classifyDegradation(new Error('AccessDeniedException')), 'access_denied');
});

test('CA-4: una causa fuera del enum se degrada a `desconocido` en el template (allow-list)', () => {
  const msg = kda.formatDegradationAlert({ cause: 'javascript:alert(1)', aborted: false });
  assert.doesNotMatch(msg, /javascript:alert/);
  assert.match(msg, /`desconocido`/);
});

// -----------------------------------------------------------------------------
// CA-5 — Las 4 piezas de UX-1, asserteadas UNA POR UNA sobre el string que sale
// por `sendTelegram`. No alcanza con assertear que el sink fue invocado.
// -----------------------------------------------------------------------------

test('CA-5 (A) dentro de la ventana: las 4 piezas + el glifo 🛑 salen por sendTelegram', () => {
  const { sink, sent } = makeSink({ cutoverWindow: true });
  sink.onDegraded(STDERR_ACCESS_DENIED);

  // (4) salida EFECTIVA por sendTelegram.
  assert.equal(sent.length, 1, 'debe emitirse exactamente una alerta');
  const t = sent[0].text;

  // (1) severidad con el léxico REAL del repo (D-3: "Pipeline frenado" no existe).
  assert.match(t, /^🛑 \*Pipeline PAUSADO\* — degradación del store durable$/m);
  // (2) consecuencia en criollo, con la redacción literal.
  assert.ok(t.includes('el catálogo durable no se pudo leer: los productos registrados en DynamoDB '
    + 'quedaron invisibles y el pipeline hubiera seguido operando sobre el filesystem — se abortó el '
    + 'encendido para no dejar dos fuentes de verdad activas'), 'consecuencia literal de (A)');
  // (3) acción siguiente concreta, con el MECANISMO de despause (UX-7).
  assert.match(t, /Qué hacer: /);
  assert.match(t, /Volvé `kernel\.durable` a `false` en `\.pipeline\/config\.yaml`/);
  assert.match(t, /\/reanudar/, 'UX-7: debe nombrar el mecanismo, no el verbo "despausar"');
  assert.match(t, /`\.pipeline\/\.paused`/);
  // Causa como TOKEN del enum + glosa en español (UX-8).
  assert.match(t, /Causa: `access_denied` — el rol no tiene permiso sobre la tabla/);
  // El dialecto se declara explícitamente y viaja al caller (UX-6).
  assert.equal(sent[0].opts.parseMode, kda.PARSE_MODE);
});

test('CA-5 (B) fuera de la ventana: las 4 piezas + el glifo ⚠️ (UX-4, NO 🔴)', () => {
  const { sink, sent } = makeSink({ cutoverWindow: false });
  sink.onDegraded(STDERR_ACCESS_DENIED);

  assert.equal(sent.length, 1);
  const t = sent[0].text;

  // (1) UX-4: ⚠️ = "anomalía notificada, el pipeline SIGUE". 🔴 en este repo
  // significa "algo quedó frenado" y borraría la distinción que construye D-4.
  assert.match(t, /^⚠️ \*Degradación del store durable\* — el pipeline sigue por filesystem$/m);
  assert.ok(!t.includes('🔴'), 'UX-4: (B) no debe usar el glifo de "pipeline frenado"');
  assert.ok(!t.includes('🛑'), 'UX-4: (B) no debe usar el glifo de "pipeline pausado"');
  // (2) consecuencia literal de (B) — dice que SIGUE, no que se abortó.
  assert.ok(t.includes('el catálogo durable no se pudo leer: los productos registrados en DynamoDB '
    + 'quedaron invisibles y el pipeline sigue operando sobre el filesystem — hay dos fuentes de verdad activas'));
  // (3) acción de (B): no dice que ya se abortó nada.
  assert.match(t, /volvé `kernel\.durable` a `false` en `\.pipeline\/config\.yaml`, o abrí `kernel\.cutover_window`/);
  assert.doesNotMatch(t, /ya se abortó/);
  // (4)
  assert.equal(sent[0].opts.parseMode, kda.PARSE_MODE);
});

test('CA-5 (A) y (B) se distinguen a simple vista: glifo + primera línea distintos (D-4/UX-4)', () => {
  const a = kda.formatDegradationAlert({ cause: 'access_denied', aborted: true });
  const bb = kda.formatDegradationAlert({ cause: 'access_denied', aborted: false });
  assert.ok(a.startsWith('🛑'), '(A) abre con 🛑');
  assert.ok(bb.startsWith('⚠️'), '(B) abre con ⚠️');
  assert.notEqual(a.split('\n')[0], bb.split('\n')[0]);
});

test('CA-5: con `config_incompleta` la acción NO manda a apagar el cutover (excepción del PO)', () => {
  for (const aborted of [true, false]) {
    const t = kda.formatDegradationAlert({ cause: 'config_incompleta', aborted });
    assert.ok(t.includes('completá `kernel.tableName` y `kernel.region` en `.pipeline/config.yaml`'),
      `(${aborted ? 'A' : 'B'}) debe pedir completar la config`);
    assert.doesNotMatch(t, /volvé `kernel\.durable` a `false`/i,
      'decirle "volvé durable a false" a quien sólo tiene que llenar la config es la acción equivocada');
    assert.match(t, /Causa: `config_incompleta` — falta completar la configuración del store durable/);
  }
});

test('CA-5/UX-8: la tabla CAUSA_GLOSA cubre las 7 causas con glosa fija en español', () => {
  assert.deepEqual(Object.keys(kda.CAUSA_GLOSA).sort(), [...kda.CAUSES].sort());
  for (const c of kda.CAUSES) {
    assert.equal(typeof kda.CAUSA_GLOSA[c], 'string');
    assert.ok(kda.CAUSA_GLOSA[c].length > 10, `glosa de ${c} debe ser legible`);
    // El TOKEN del enum no se traduce; la glosa lo acompaña.
    assert.match(kda.formatDegradationAlert({ cause: c, aborted: false }),
      new RegExp('Causa: `' + c + '` — '));
  }
});

test('R7: el template tolera `correlationId` ausente (sendTelegram puede devolver null)', () => {
  const sin = kda.formatDegradationAlert({ cause: 'red', aborted: false, correlationId: null });
  assert.doesNotMatch(sin, /^id:/m);
  const con = kda.formatDegradationAlert({ cause: 'red', aborted: false, correlationId: 'kdeg-1-a' });
  assert.match(con, /^id: kdeg-1-a$/m);
});

// -----------------------------------------------------------------------------
// CA-8 — El test de "sin ARN" tiene dientes (+ GURU-10).
// -----------------------------------------------------------------------------

test('CA-8: el payload de Telegram no lleva ARN ni account-id (fixture AccessDenied realista)', () => {
  const { sink, sent } = makeSink({ cutoverWindow: true });
  sink.onDegraded(STDERR_ACCESS_DENIED);
  const t = sent[0].text;
  assert.doesNotMatch(t, /arn:aws:/, 'no debe filtrar topología AWS');
  // UX-5 · ANCLADO: `/\d{12}/` reprobaría una implementación correcta, porque el
  // correlationId real es `kdeg-<epoch 13 díg>-<hex>`. `\b\d{12}\b` conserva los
  // dientes contra la fuga real sin castigar al correlationId.
  assert.doesNotMatch(t, /\b\d{12}\b/, 'no debe filtrar el account-id');
  assert.match(t, /^id: kdeg-1785269351499-5f0b34f6$/m, 'el correlationId SÍ debe viajar (CA-6)');
});

test('CA-8/GURU-10: el payload no contiene NINGUNA subcadena de ≥12 chars del stderr', () => {
  const { sink, sent } = makeSink({ cutoverWindow: true });
  sink.onDegraded(STDERR_ACCESS_DENIED);
  const t = sent[0].text;
  // Éste es el assert que prueba de verdad que el template es FIJO y no interpola
  // "sólo para debug": ninguna capa de redacción ataja una interpolación creativa.
  const fugas = [];
  for (let i = 0; i + 12 <= STDERR_ACCESS_DENIED.length; i++) {
    const sub = STDERR_ACCESS_DENIED.slice(i, i + 12);
    if (t.includes(sub)) fugas.push(sub);
  }
  assert.deepEqual(fugas, [], `el template no debe interpolar el stderr (fugas: ${fugas.slice(0, 3).join(' | ')})`);
});

// -----------------------------------------------------------------------------
// CA-6 — Asimetría por frontera de confianza, con el log local TAMBIÉN redactado
// (D-5/SEC-10: `pulpo.log` está en TAIL_ALLOWED_FILES y sale por /tail y /salud).
// -----------------------------------------------------------------------------

test('CA-6: (a) Telegram sin detalle · (b) log local diagnóstico · (c) log local sin topología AWS', () => {
  const { sink, sent, logs } = makeSink({ cutoverWindow: false });
  sink.onDegraded(STDERR_ACCESS_DENIED, { stage: 'boot-durable' });

  // (a) el payload de Telegram NO lleva el detalle del driver.
  const t = sent[0].text;
  assert.doesNotMatch(t, /AccessDeniedException|dynamodb:Query|assumed-role/);

  // (b) el log local SÍ conserva el mensaje diagnóstico: stage, causa y texto del
  // error (lo que sirve para diagnosticar), más el correlationId que liga las dos
  // mitades.
  const linea = logs.find((l) => l.includes('degradación del store durable'));
  assert.ok(linea, 'debe haber una línea de log local');
  assert.match(linea, /stage boot-durable/);
  assert.match(linea, /causa access_denied/);
  assert.match(linea, /id kdeg-1785269351499-5f0b34f6/);
  assert.match(linea, /AccessDeniedException/, 'el texto del error se conserva para diagnóstico');
  assert.match(linea, /dynamodb:Query/, 'la operación se conserva para diagnóstico');

  // (c) …pero SIN topología AWS: lo que se pierde son los tokens que no aportan
  // al diagnóstico del operador.
  assert.doesNotMatch(linea, /arn:aws/i, 'SEC-10: el log local tampoco puede filtrar el ARN');
  assert.doesNotMatch(linea, /\b\d{12}\b/, 'SEC-10: ni el account-id');
});

// -----------------------------------------------------------------------------
// CA-2 — Sink fail-loud en los DOS caminos.
// Camino 1: `product-catalog.listProductsResolved`.
// -----------------------------------------------------------------------------

test('CA-2 (camino product-catalog): con failLoud NO hay fallback a FS — propaga', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-'));
  // Descriptor VÁLIDO: si hubiera fallback, el barrido FS devolvería 1 producto.
  // Que el test falle por "devolvió 1" y no por "no alertó" es el punto de R2.
  fs.writeFileSync(path.join(tmp, 'p.json'), JSON.stringify({
    identity: { projectId: 'acme-store', name: 'ACME Store' }, status: 'active',
  }));
  let degraded = null;
  await assert.rejects(
    () => pc.listProductsResolved({
      durable: true, descriptorsDir: tmp, failLoud: true,
      store: { listProducts: async () => { throw new Error(STDERR_ACCESS_DENIED); } },
      onDegraded: (r) => { degraded = r; },
    }),
    (e) => e.name === 'KernelDegradedError',
    'con failLoud la degradación propaga en vez de enmascararse con el barrido FS',
  );
  assert.ok(degraded, 'el sink corre IGUAL: primero se alerta, después se corta');
});

test('CA-2/R2: los TRES puntos de degradación respetan failLoud', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-'));
  fs.writeFileSync(path.join(tmp, 'p.json'), JSON.stringify({ identity: { projectId: 'acme-store', name: 'A' } }));
  const casos = [
    ['store no instanciable', { createStore: () => { throw new Error('no driver'); } }],
    ['store ausente', { createStore: () => null }],
    ['fallo de infra en listProducts', { store: { listProducts: async () => { throw new Error('infra down'); } } }],
  ];
  for (const [nombre, extra] of casos) {
    await assert.rejects(
      () => pc.listProductsResolved({ durable: true, descriptorsDir: tmp, failLoud: true, onDegraded: () => {}, ...extra }),
      (e) => e.name === 'KernelDegradedError',
      `${nombre}: debe propagar con failLoud`,
    );
  }
});

test('CA-2/R2: un sink que LANZA no alcanza — `logDegraded` lo silencia (por eso existe failLoud)', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-'));
  fs.writeFileSync(path.join(tmp, 'p.json'), JSON.stringify({
    identity: { projectId: 'acme-store', name: 'A' }, status: 'active',
  }));
  // Sin `failLoud`, inyectar un `onDegraded` que lanza NO impide el fallback:
  // ése era el falso verde que CA-2 tenía que evitar.
  const out = await pc.listProductsResolved({
    durable: true, descriptorsDir: tmp,
    store: { listProducts: async () => { throw new Error('AccessDenied'); } },
    onDegraded: () => { throw new Error('FAIL-LOUD ABORT'); },
  });
  assert.equal(out.length, 1, 'documenta el comportamiento que motiva `opts.failLoud`');
});

test('CA-2: el sink expone `failLoud` ligado a la ventana, para cablearlo al camino product-catalog', () => {
  assert.equal(makeSink({ cutoverWindow: true }).sink.failLoud, true);
  assert.equal(makeSink({ cutoverWindow: false }).sink.failLoud, false);
});

// -----------------------------------------------------------------------------
// CA-1 / CA-2 — dentro vs fuera de la ventana.
// -----------------------------------------------------------------------------

test('CA-2 (dentro de la ventana): la degradación ABORTA el encendido', () => {
  const { sink, sent, halts } = makeSink({ cutoverWindow: true });
  const r = sink.onDegraded(STDERR_ACCESS_DENIED);
  assert.equal(r.aborted, true);
  assert.equal(sink.aborted, true);
  assert.equal(halts.length, 1, 'el abort es una llamada explícita al halt (R1: nunca throw/exit)');
  assert.equal(halts[0].cause, 'access_denied');
  assert.match(sent[0].text, /Pipeline PAUSADO/);
});

test('CA-1/CA-2 (fuera de la ventana): alerta fuerte y el pipeline SIGUE por FS', async () => {
  const { sink, sent, halts } = makeSink({ cutoverWindow: false });
  const r = sink.onDegraded(STDERR_ACCESS_DENIED);
  assert.equal(r.aborted, false);
  assert.equal(sink.aborted, false);
  assert.equal(halts.length, 0, 'fuera de la ventana NUNCA se pausa el pipeline');
  assert.equal(sent.length, 1, 'pero la alerta fuerte se emite igual');
  assert.match(sent[0].text, /el pipeline sigue por filesystem/);

  // No-regresión del best-effort: el camino de lectura sigue devolviendo el barrido FS.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-'));
  fs.writeFileSync(path.join(tmp, 'p.json'), JSON.stringify({
    identity: { projectId: 'acme-store', name: 'A' }, status: 'active',
  }));
  const out = await pc.listProductsResolved({
    durable: true, descriptorsDir: tmp, failLoud: sink.failLoud,
    store: { listProducts: async () => { throw new Error(STDERR_ACCESS_DENIED); } },
    onDegraded: (rr) => sink.onDegraded(rr),
  });
  assert.equal(out.length, 1, 'con la ventana cerrada el barrido FS sigue siendo el resultado');
});

test('CA-1: la ventana es fail-closed — sólo el booleano `true` exacto la abre', () => {
  for (const valor of [undefined, null, false, 'true', 1, {}, 'yes']) {
    const sink = kda.createDegradationSink({ config: { kernel: { durable: true, cutover_window: valor } } });
    assert.equal(sink.cutoverWindow, false, `cutover_window=${JSON.stringify(valor)} NO debe abrir la ventana`);
  }
  assert.equal(kda.createDegradationSink({ config: { kernel: { cutover_window: true } } }).cutoverWindow, true);
  // Sin bloque `kernel` tampoco explota.
  assert.equal(kda.createDegradationSink({}).cutoverWindow, false);
});

test('CA-1: `.pipeline/config.yaml` declara `cutover_window` con default false y comentario', () => {
  const raw = fs.readFileSync(path.join(__dirname, '..', '..', 'config.yaml'), 'utf8');
  assert.match(raw, /^\s*cutover_window: false\s*$/m, 'la clave debe existir con default OFF');
  const bloque = raw.slice(raw.indexOf('\nkernel:'), raw.indexOf('cutover_window: false'));
  assert.match(bloque, /operador/i, 'el comentario debe decir QUIÉN la abre/cierra');
  assert.match(bloque, /cutover/i, 'y QUÉ habilita');
});

// -----------------------------------------------------------------------------
// CA-9 — No-regresión de corrupción + test NEGATIVO de stages sanos (D-6).
// -----------------------------------------------------------------------------

test('CA-9: KernelStoreValidationError sigue escalando y NO cae al camino degradado (ni con failLoud)', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-'));
  fs.writeFileSync(path.join(tmp, 'p.json'), JSON.stringify({
    identity: { projectId: 'acme-store', name: 'A' }, status: 'active',
  }));
  for (const failLoud of [false, true]) {
    let degraded = false;
    await assert.rejects(
      () => pc.listProductsResolved({
        durable: true, descriptorsDir: tmp, failLoud,
        store: { listProducts: async () => { throw new ks.KernelStoreValidationError('catálogo corrupto', { stage: 'schema' }); } },
        onDegraded: () => { degraded = true; },
      }),
      (e) => e.name === 'KernelStoreValidationError',
      `failLoud=${failLoud}: la corrupción escala por su propio camino, no como degradación`,
    );
    assert.equal(degraded, false, 'validación ≠ degradación: el sink NO debe dispararse');
  }
});

test('CA-9/D-6: un boot EXITOSO con stages sanos (cap / isSafeId) NO alerta ni aborta', async () => {
  // `onAlert` es MULTIPLEXADO: 11 stages heterogéneos. `cap` se dispara en el
  // escenario NORMAL de un cutover (3 activos contra max_concurrent_instances: 2)
  // y `isSafeId` es el control fail-closed FUNCIONANDO. Sin el filtro por stage,
  // un solo registro envenenado en el catálogo pausaría el pipeline (SEC-12).
  const { sink, sent, halts } = makeSink({ cutoverWindow: true });
  const productos = [
    { productId: 'uno', name: 'Uno', status: 'active' },
    { productId: 'dos', name: 'Dos', status: 'active' },
    { productId: 'tres', name: 'Tres', status: 'active' },
    { productId: '../evil', name: 'Evil', status: 'active' },
  ];
  const stages = [];
  const res = await supervisor.bootKernelDurable({
    // #5214 — `tableName` cargado: sin él, el guard fail-closed de config durable
    // aborta el boot antes de que este escenario pueda producir un solo stage.
    config: { kernel: { durable: true, tableName: 'durable-cutover-test-table', max_concurrent_instances: 2 } },
    buildCatalogStore: () => ({ listProducts: async () => productos }),
    buildStoreFactory: () => () => ({}),
    spawn: () => null,
    // MISMA regla de cableado que `pulpo.js`: sólo `boot-durable` alimenta el sink.
    onAlert: (a) => {
      stages.push(a && a.stage);
      if (a && a.stage === 'boot-durable') sink.onDegraded((a.errors && a.errors[0] && a.errors[0].detail) || '', { stage: a.stage });
    },
  });

  assert.equal(res.ran, true, 'el boot fue EXITOSO');
  assert.notEqual(res.reason, 'error');
  assert.ok(stages.some((s) => s === 'cap' || s === 'isSafeId'),
    'el escenario debe producir stages sanos (si no, el test no prueba nada)');
  assert.ok(!stages.includes('boot-durable'), 'un boot exitoso no emite boot-durable');
  assert.equal(sent.length, 0, 'SEC-12: un control fail-closed sano NO puede alertar al operador');
  assert.equal(halts.length, 0, 'SEC-12: …ni pausar el pipeline');
  assert.equal(sink.aborted, false);
});

// -----------------------------------------------------------------------------
// CA-10 — Rate-limit SÓLO sobre el canal (SEC-13: gatear el abort sería
// fail-open por throttling).
// -----------------------------------------------------------------------------

test('CA-10: dos degradaciones de la misma causa dentro del cooldown ⇒ UN solo sendTelegram', () => {
  const { sink, sent, logs, halts } = makeSink({ cutoverWindow: true, cooldownMs: 600000 });
  const r1 = sink.onDegraded(STDERR_ACCESS_DENIED);
  const r2 = sink.onDegraded(STDERR_ACCESS_DENIED);

  assert.equal(sent.length, 1, 'un driver flapeando no inunda el canal');
  // …pero clasificación, log y ABORT corren SIEMPRE (SEC-13).
  assert.equal(r1.aborted, true);
  assert.equal(r2.aborted, true, 'la segunda degradación DEBE seguir abortando (nada de fail-open)');
  assert.deepEqual(sink.causes, ['access_denied', 'access_denied'], 'la clasificación nunca se gatea');
  assert.equal(halts.length, 2, 'el abort nunca se gatea');
  assert.equal(logs.filter((l) => l.includes('degradación del store durable')).length, 2,
    'el log local nunca se gatea');
});

test('CA-10: el contador de repeticiones viaja al template cuando vence el cooldown', () => {
  const { sink, sent, advance } = makeSink({ cutoverWindow: false, cooldownMs: 600000 });
  sink.onDegraded(STDERR_ACCESS_DENIED);            // envía, repeats=1
  assert.equal(sent.length, 1);
  assert.doesNotMatch(sent[0].text, /se repitió/, 'con una sola vez no se muestra el contador');

  sink.onDegraded(STDERR_ACCESS_DENIED);            // suprimida
  sink.onDegraded(STDERR_ACCESS_DENIED);            // suprimida
  assert.equal(sent.length, 1);

  advance(600001);
  sink.onDegraded(STDERR_ACCESS_DENIED);            // vence: acumuló 3
  assert.equal(sent.length, 2);
  assert.match(sent[1].text, /\(se repitió 3 veces en esta ventana\)/);
});

test('CA-10: el rate-limit es POR CAUSA — una causa distinta alerta igual', () => {
  const { sink, sent } = makeSink({ cutoverWindow: false, cooldownMs: 600000 });
  sink.onDegraded(STDERR_ACCESS_DENIED);                       // access_denied
  sink.onDegraded('Unable to locate credentials');             // credenciales_ausentes
  sink.onDegraded(STDERR_ACCESS_DENIED);                       // access_denied (suprimida)
  assert.equal(sent.length, 2, 'una alerta por causa del enum por ventana');
  assert.match(sent[0].text, /`access_denied`/);
  assert.match(sent[1].text, /`credenciales_ausentes`/);
});

// -----------------------------------------------------------------------------
// CA-20 — El abort deja auditoría propia aunque no escriba el marker.
// -----------------------------------------------------------------------------

test('CA-20 (rama A): el halt escribe su marker ⇒ la alerta y el log lo dicen', () => {
  const { sink, sent, logs } = makeSink({
    cutoverWindow: true,
    halt: () => ({ markerWritten: true, preexisting: false }),
  });
  sink.onDegraded(STDERR_ACCESS_DENIED);
  const auditoria = logs.find((l) => l.includes('ABORTADO'));
  assert.ok(auditoria, 'el abort deja auditoría propia en el log local');
  assert.match(auditoria, /marker `\.paused` escrito/);
  assert.match(auditoria, /kernel-cutover-degraded-halt/, 'con el source propio, para que #5131 tenga de dónde leer');
  assert.doesNotMatch(sent[0].text, /ya había una pausa activa/);
});

test('CA-20 (rama B): con una pausa PREEXISTENTE el abort no la pisa pero deja rastro igual', () => {
  const { sink, sent, logs } = makeSink({
    cutoverWindow: true,
    halt: () => ({ markerWritten: false, preexisting: true }),
  });
  const r = sink.onDegraded(STDERR_ACCESS_DENIED);

  assert.equal(r.aborted, true, 'el encendido se aborta igual');
  // Sin esto el operador levanta la pausa que ve y el cutover abortado desaparece
  // del registro (SEC-15 · pérdida de evidencia en la operación más sensible).
  const auditoria = logs.find((l) => l.includes('ABORTADO'));
  assert.ok(auditoria, 'la auditoría del abort NO depende de haber escrito el marker');
  assert.match(auditoria, /ya había una pausa activa de otro origen — NO se pisó/);
  assert.match(sent[0].text, /Ojo: ya había una pausa activa de otro origen/);
  assert.match(sent[0].text, /No la levantes sin revisar antes este cutover/);
});

test('CA-20: si el halt explota, el sink no propaga y la auditoría sale igual', () => {
  const { sink, sent, logs } = makeSink({
    cutoverWindow: true,
    halt: () => { throw new Error('EACCES .paused'); },
  });
  assert.doesNotThrow(() => sink.onDegraded(STDERR_ACCESS_DENIED),
    'R1: el sink NUNCA propaga — el catch del bloque de pulpo.js se la tragaría');
  assert.equal(sink.aborted, true);
  assert.ok(logs.some((l) => l.includes('ABORTADO')), 'la auditoría del abort sale igual');
  assert.equal(sent.length, 1, 'y la alerta también');
});

// -----------------------------------------------------------------------------
// UX-6 — Renderizabilidad. Una alerta que no renderiza es una alerta que no
// llega: un 400 de Telegram por parseo NO se recupera con reintentos
// (`servicio-telegram.js` agota el contador y manda el saliente a `fallido/`).
// -----------------------------------------------------------------------------

test('UX-6: los 2 templates × 7 causas × (con/sin id) × (repeats 1 y >1) renderizan en el dialecto declarado', () => {
  assert.equal(kda.PARSE_MODE, 'Markdown', 'el módulo declara su dialecto explícitamente');
  let combos = 0;
  let maxLen = 0;
  for (const aborted of [true, false]) {
    for (const cause of kda.CAUSES) {
      for (const correlationId of ['kdeg-1785269351499-5f0b34f6', null]) {
        for (const repeats of [1, 3]) {
          const t = kda.formatDegradationAlert({ cause, correlationId, repeats, aborted });
          combos += 1;
          maxLen = Math.max(maxLen, t.length);
          const etiqueta = `${aborted ? 'A' : 'B'}/${cause}/${correlationId ? 'cid' : 'sin-cid'}/r${repeats}`;
          assert.equal((t.match(/\*/g) || []).length % 2, 0, `${etiqueta}: '*' debe quedar balanceado`);
          assert.equal((t.match(/`/g) || []).length % 2, 0, `${etiqueta}: backticks balanceados`);
          // >4000 `sendTelegram` trunca con slice y puede cortar una entidad al medio.
          assert.ok(t.length <= 4000, `${etiqueta}: largo ${t.length} supera el truncado de sendTelegram`);
          // Los `_` de los tokens del enum y de `kernel.cutover_window` deben vivir
          // DENTRO de un span de backticks: sueltos, legacy Markdown los toma como
          // itálicas y desbalancean la entidad.
          const fueraDeCode = t.split('`').filter((_, i) => i % 2 === 0).join('');
          assert.doesNotMatch(fueraDeCode, /_/, `${etiqueta}: '_' fuera de un span de código`);
        }
      }
    }
  }
  assert.equal(combos, 56, 'la matriz debe cubrir las 56 combinaciones');
  assert.ok(maxLen < 1000, `margen holgado contra el truncado (max ${maxLen})`);
});

// -----------------------------------------------------------------------------
// CA-2/CA-3/CA-6/R1/R9 — Guard estático sobre el cableado de `pulpo.js`.
// El bloque no es requerible sin arrancar el pulpo, así que los invariantes de
// cableado se custodian leyendo la fuente (mismo patrón que el guard de security#6).
// -----------------------------------------------------------------------------

test('CA-2/CA-3: el cableado de pulpo.js filtra por stage, redacta el log y NO aborta con throw/exit', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'pulpo.js'), 'utf8');
  const ini = src.indexOf('// #4822 (Split 3/3 de #4804) — Boot durable del supervisor multi-producto.');
  const fin = src.indexOf('WARN [kernel-durable] boot hook falló', ini);
  assert.ok(ini > 0 && fin > ini, 'debe existir el bloque del boot durable');
  const bloque = src.slice(ini, fin);
  // Sólo CÓDIGO: los comentarios del bloque nombran `process.exit` justamente para
  // explicar por qué NO se usa, así que el guard tiene que mirar debajo de ellos.
  const codigo = bloque.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

  // D-6/SEC-12 — el sink SÓLO se alimenta con la degradación real del catálogo.
  assert.match(codigo, /if \(stage === 'boot-durable'\) degradationSink\.onDegraded\(/,
    'el sink debe estar gateado por stage === boot-durable');
  // CA-6/D-5 — el log local va redactado (pulpo.log sale por /tail y /salud).
  assert.match(codigo, /redactSecretValue\(det\)/, 'el detalle del log local debe pasar por redactSecretValue');
  // R1 — el abort POR DEGRADACIÓN es una llamada explícita, nunca throw ni exit:
  // el `catch (e)` que cierra el bloque se tragaría un throw y matar el proceso
  // violaría la invariante "el pipeline no puede morir".
  //
  // #5214 introdujo la ÚNICA terminación admitida en este bloque, y es de otra
  // clase de fallo: configuración durable inválida (`kernel.tableName`
  // ausente/vacío/whitespace con el flag encendido). Ahí no hay operación válida
  // que sostener — no es un servicio degradado, es una config que el operador
  // todavía no terminó de escribir — y el CA-1 de #5214 exige código no-cero.
  //
  // La distinción se custodia acá: el bloque no puede tener un `process.exit`
  // suelto (que sería el abort por degradación matando el proceso), y la única
  // terminación permitida entra por el helper del guard, que sólo se alcanza
  // cuando `inspectDurableKernelConfig` rechaza.
  assert.doesNotMatch(codigo, /process\.exit/,
    'R1: la degradación del catálogo NO puede matar el proceso');
  const terminaciones = codigo.match(/abortOnInvalidDurableConfig\(/g) || [];
  assert.equal(terminaciones.length, 2,
    '#5214: la única terminación del bloque es el guard de config inválida ' +
    '(entrypoint + defensa en profundidad sobre result.fatal)');
  assert.match(codigo, /durableConfigGuard\.inspectDurableKernelConfig\(cfg\)/,
    '#5214: el guard corre sobre la config, y antes que el require del store');
  assert.doesNotMatch(codigo, /throw new KernelDegraded|throw new Error/,
    'R1: el abort no se propaga como excepción dentro del bloque');

  // #5214 CA-4 — ORDEN: el guard tiene que estar ANTES del require lazy del
  // store. De ahí para abajo el bloque carga Ajv, el driver DynamoDB y el runner
  // del AWS CLI; validar después sería validar con la maquinaria ya en pie.
  // Sobre `codigo`, no sobre `bloque`: los comentarios del guard nombran el
  // require del store justamente para explicar por qué van antes, y esa mención
  // adelantaría la posición medida.
  const posGuard = codigo.indexOf('inspectDurableKernelConfig');
  const posStore = codigo.indexOf("require('./lib/kernel-store')");
  assert.ok(posGuard > 0 && posStore > 0, 'deben existir ambas sentencias en el bloque');
  assert.ok(posGuard < posStore,
    '#5214 CA-4: el guard de config debe correr ANTES de cargar el store durable');
  assert.match(codigo, /source: 'kernel-cutover-degraded-halt'/, 'el marker nace con su source propio');
  // CA-20 — el halt informa si escribió el marker o encontró una pausa previa.
  assert.match(codigo, /markerWritten/);
  assert.match(codigo, /preexisting/);
  // GURU-9 — idempotencia: nunca se pisa una pausa preexistente.
  assert.match(codigo, /if \(fs\.existsSync\(PAUSE_FILE\)\)/, 'el halt debe ser idempotente');
  // CA-3 — el mapeo NO vive en el supervisor.
  const supervisorSrc = fs.readFileSync(path.join(__dirname, '..', 'kernel-supervisor.js'), 'utf8');
  assert.doesNotMatch(supervisorSrc, /kernel-degradation-alert|classifyDegradation/,
    'CA-3/D-2: el mapeo vive en el borde de salida, no en kernel-supervisor.js');
});

// =============================================================================
// #5209 — Máquina de estados del ROLLBACK durable → filesystem.
//
// El cutover de ida ya está cubierto arriba. Esto modela la vuelta, que es donde
// se pierde evidencia en silencio: apagar `kernel.durable` sin reintegrar deja
// las firmas de la ventana sólo en DynamoDB y nadie se entera.
//
// Secuencia obligatoria:
//   ventana durable NO vacía → freeze → export → validate → reintegrate
//   → reread filesystem → exact parity → durable:false → restart → fase completa
//
// Invariante transversal: CUALQUIER discrepancia conserva DynamoDB como fuente
// efectiva (el flag no se apaga) y audita el aborto.
// =============================================================================

const reconcile = require('../kernel-append-only-reconcile');

function tmpDirCutover(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cutover-5209-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Ventana durable con al menos una firma y una entrada de audit (sonda positiva). */
async function ventanaDurableNoVacia({ signatures = 2, audits = 2 } = {}) {
  let clock = 1700000000000;
  const store = ks.createKernelStore({ contextProjectId: 'acme-store', now: () => (clock += 1) });
  for (let i = 0; i < signatures; i += 1) {
    await store.putSignature({ signer: 'leitolarreta', target: `pr-${i}`, checksum: 'c'.repeat(64) });
  }
  for (let i = 0; i < audits; i += 1) {
    await store.appendAuditEntry({ action: 'gate2.sign', actor: 'leitolarreta', detail: `firma ${i}` });
  }
  return store;
}

/** Mundo operativo observable: flag durable, reinicios y fases completadas. */
function mundoOperativo() {
  const w = { durable: true, reinicios: 0, fasesCompletadas: 0, r8: null, lecturas: [] };
  return {
    w,
    disableDurable: async () => { w.durable = false; return { ok: true }; },
    restart: async () => { w.reinicios += 1; return { ok: true }; },
    completePhase: async ({ reconciliacion }) => {
      // La fase sólo se puede completar leyendo del FILESYSTEM. Si el flag sigue
      // encendido, seguiríamos leyendo de DynamoDB y no habríamos probado nada.
      if (w.durable !== false) return { ok: false, error: 'el flag durable sigue encendido' };
      const enDisco = reconcile.readFilesystemRecords(reconciliacion.reconcileDir);
      if (!enDisco.ok || enDisco.records.length === 0) return { ok: false, error: 'no hay evidencia en filesystem' };
      w.lecturas.push(enDisco.records.length);
      w.fasesCompletadas += 1;
      return { ok: true };
    },
    recordR8: async ({ r8Ms }) => { w.r8 = r8Ms; },
  };
}

test('#5209: la secuencia completa del rollback llega a fase completa desde filesystem', async (t) => {
  const root = tmpDirCutover(t);
  const store = await ventanaDurableNoVacia({ signatures: 3, audits: 2 });
  const op = mundoOperativo();
  let reloj = 0;

  const res = await reconcile.runDurableRollbackDrill({
    store,
    reconcileDir: path.join(root, 'kernel-reconcile'),
    allowedRoot: root,
    frozen: true,
    clock: () => (reloj += 3000),
    disableDurable: op.disableDurable,
    restart: op.restart,
    completePhase: op.completePhase,
    recordR8: op.recordR8,
  });

  assert.equal(res.ok, true, res.error);
  assert.equal(res.state, 'record-R8');
  // El orden importa: el flag se apagó DESPUÉS de la paridad, no antes.
  assert.deepEqual(res.completados, ['disable-durable', 'restart', 'complete-phase', 'record-R8']);
  assert.equal(op.w.durable, false);
  assert.equal(op.w.reinicios, 1);
  assert.equal(op.w.fasesCompletadas, 1);
  assert.deepEqual(op.w.lecturas, [5], 'la fase leyó los 5 registros reintegrados desde filesystem');
  assert.equal(op.w.r8, 3000, 'R8 quedó registrado');
});

test('#5209: ventana durable VACÍA nunca llega a apagar el flag', async (t) => {
  const root = tmpDirCutover(t);
  const store = ks.createKernelStore({ contextProjectId: 'acme-store', now: () => 1 });
  const op = mundoOperativo();

  const res = await reconcile.runDurableRollbackDrill({
    store,
    reconcileDir: path.join(root, 'kernel-reconcile'),
    allowedRoot: root,
    frozen: true,
    disableDurable: op.disableDurable,
    restart: op.restart,
    completePhase: op.completePhase,
  });

  assert.equal(res.ok, false);
  assert.equal(res.code, 'conjunto_vacio');
  assert.equal(op.w.durable, true, 'DynamoDB sigue siendo la fuente efectiva');
  assert.equal(op.w.reinicios, 0);
});

test('#5209: una discrepancia de paridad conserva DynamoDB como fuente y audita el aborto', async (t) => {
  const root = tmpDirCutover(t);
  const store = await ventanaDurableNoVacia();
  const op = mundoOperativo();
  const auditsAntes = (await store.listAuditEntries()).length;

  // El filesystem ya tiene un registro con el MISMO id y contenido distinto:
  // discrepancia irreconciliable, porque un append-only jamás se pisa.
  const dir = path.join(root, 'kernel-reconcile');
  fs.mkdirSync(dir, { recursive: true });
  const durables = await store.listSignatures();
  const impostor = reconcile.toRecord('signature', {
    SK: durables[0].SK, projectId: 'acme-store', body: { signer: 'impostor', target: 'x', checksum: 'z' },
  });
  fs.writeFileSync(path.join(dir, 'signatures.jsonl'), `${JSON.stringify(impostor)}\n`);

  const res = await reconcile.runDurableRollbackDrill({
    store,
    reconcileDir: dir,
    allowedRoot: root,
    frozen: true,
    disableDurable: op.disableDurable,
    restart: op.restart,
    completePhase: op.completePhase,
  });

  assert.equal(res.ok, false);
  assert.equal(res.code, 'conflicto_id');
  assert.equal(op.w.durable, true);
  assert.equal(res.abortAudit.emitted, true, 'el aborto tiene que quedar auditado');

  const auditsDespues = await store.listAuditEntries();
  assert.equal(auditsDespues.length, auditsAntes + 1);
  assert.match(auditsDespues[auditsDespues.length - 1].body.detail, /conflicto_id/);
});

test('#5209: el rollback no borra nada de DynamoDB — el append-only queda intacto', async (t) => {
  const root = tmpDirCutover(t);
  const store = await ventanaDurableNoVacia({ signatures: 4, audits: 3 });
  const op = mundoOperativo();
  const sksAntes = (await store.listSignatures()).map((i) => i.SK);

  const res = await reconcile.runDurableRollbackDrill({
    store,
    reconcileDir: path.join(root, 'kernel-reconcile'),
    allowedRoot: root,
    frozen: true,
    disableDurable: op.disableDurable,
    restart: op.restart,
    completePhase: op.completePhase,
    recordR8: op.recordR8,
  });
  assert.equal(res.ok, true, res.error);

  const sksDespues = (await store.listSignatures()).map((i) => i.SK);
  assert.deepEqual(sksDespues, sksAntes, 'reconciliar copia, no mueve: DynamoDB conserva todo');
});

test('#5209: reintegrar es aditivo — una segunda ventana no pisa lo reconciliado antes', async (t) => {
  const root = tmpDirCutover(t);
  const dir = path.join(root, 'kernel-reconcile');
  let clock = 1700000000000;
  const store = ks.createKernelStore({ contextProjectId: 'acme-store', now: () => (clock += 1) });

  await store.putSignature({ signer: 'leitolarreta', target: 'pr-1', checksum: 'c'.repeat(64) });
  await store.appendAuditEntry({ action: 'gate2.sign', actor: 'leitolarreta' });
  const primera = await reconcile.reconcileDurableToFilesystem({ store, reconcileDir: dir, allowedRoot: root, frozen: true });
  assert.equal(primera.ok, true, primera.error);
  assert.equal(primera.counts.total, 2);

  // Segunda ventana: entra una firma más. Lo anterior tiene que seguir estando.
  await store.putSignature({ signer: 'leitolarreta', target: 'pr-2', checksum: 'd'.repeat(64) });
  const segunda = await reconcile.reconcileDurableToFilesystem({ store, reconcileDir: dir, allowedRoot: root, frozen: true });

  assert.equal(segunda.ok, true, segunda.error);
  assert.equal(segunda.counts.signature, 2);
  assert.equal(segunda.added.length, 1, 'sólo la firma nueva se agrega');
  assert.equal(segunda.idempotent.length, 2, 'las dos previas se reconocen como ya presentes');
});
