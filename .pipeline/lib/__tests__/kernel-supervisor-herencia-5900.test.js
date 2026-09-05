'use strict';

// =============================================================================
// #6034 (split de #5900) — herencia de credenciales del kernel: opt-in por
// scope, auditada y fail-closed.
//
// Una fila por caso de la tabla de CA-13, más las tres que salieron del mapeo
// del arquitecto (caso mixto, anti-recursión, placeholder).
//
// NINGÚN test imprime valores de credenciales: todo el material es sintético
// `FAKE-*` sobre un `vaultDriver` in-memory, y varias aserciones verifican
// explícitamente que ese material no aparece ni en los mensajes ni en el audit.
// =============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const supervisorModule = require('../kernel-supervisor');
const { createKernelSupervisor, _herenciaHabilitadaPorCodigo } = supervisorModule;
const { buildParameterPath, createInMemoryVaultDriver } = require('../secret-vault');
const { _resetVaultCache, INSTANCE_VAULT_ERROR_CODES } = require('../credentials');
const { MOTIVOS_HERENCIA, SUBMOTIVOS_M5, evaluarHerenciaScope } = require('../kernel-inheritance');

const PREFIX = '/test6034';
const HOST = 'fake-host';
const KERNEL = 'kernel';            // `vault.projectId`, out-of-band
const HIJO = 'acme';
const VIGENTE = '2999-12-31T00:00:00Z';

function createSupervisor(onAlert = () => {}) {
  return createKernelSupervisor({
    catalogStore: { listProducts: async () => [{ productId: HIJO, projectId: HIJO, status: 'active' }] },
    storeFactory: () => ({ getDescriptor: async () => null }),
    hydrate: false,
    onAlert,
  });
}

function vaultConfig(extra = {}) {
  return {
    enabled: true, prefix: PREFIX, projectId: KERNEL, hostId: HOST,
    cache_ttl_seconds: 300, required_scopes: [], shared_secrets: [], max_cached_tenants: 8,
    ...extra,
  };
}

/** Grant del lado del KERNEL, vigente salvo que el caso diga lo contrario. */
function grants(extra = {}) {
  return {
    grants: [{
      projectId: HIJO, scopes: ['providers:anthropic'], enabled: true, until: VIGENTE, ...extra,
    }],
  };
}

/** Siembra el vault: `[scope, valor, tier?, projectId?]`. */
function driverWith(entries) {
  const parameters = Object.create(null);
  for (const [scope, valor, tier = 'host', projectId = HIJO] of entries) {
    parameters[buildParameterPath({ prefix: PREFIX, projectId, hostId: HOST, scope, tier })] = valor;
  }
  return createInMemoryVaultDriver({ parameters });
}

/**
 * Corre una resolución completa capturando mensajes y auditoría.
 * El `auditImpl` inyectado mantiene el test SIN tocar el filesystem.
 */
async function resolver({ credentials, driver, cfg = {}, inheritance = {}, scopes }) {
  _resetVaultCache();
  const alerts = [];
  const auditEntries = [];
  const supervisor = createSupervisor((a) => alerts.push(a));
  await supervisor.bootProducts();
  const ctx = supervisor.getInstance(HIJO);
  ctx.descriptor = { credentials };
  const opts = {
    vaultConfig: { ...vaultConfig(cfg), inheritance },
    vaultDriver: driver,
    logger: () => {},
    auditImpl: { appendChained: (entrada) => { auditEntries.push(entrada); return { hash_self: 'FAKE-HASH' }; } },
  };
  if (Array.isArray(scopes)) opts.scopes = scopes;
  const result = supervisor.resolveInstanceSecrets(HIJO, opts);
  return { result, ctx, alerts, auditEntries, driver, supervisor };
}

/** Entradas de audit ya desenvueltas (`appendChained` recibe `{file, entry}`). */
const eventos = (auditEntries) => auditEntries.map((a) => a.entry);

// -----------------------------------------------------------------------------
// CA-3 · scope propio: presente ⇒ `project`; vacío o placeholder ⇒ ERROR
// -----------------------------------------------------------------------------

test('#6034 CA-3 · scope propio presente resuelve con source `project` y no consulta la herencia', async () => {
  const { result, ctx, auditEntries } = await resolver({
    credentials: [{ ref: 'fake', scopes: ['providers:anthropic'], inherit: ['providers:anthropic'] }],
    driver: driverWith([
      ['providers__anthropic', { apiKey: 'FAKE-SECRET-propia' }],
      ['providers__anthropic', { apiKey: 'FAKE-SECRET-kernel' }, 'host', KERNEL],
    ]),
    inheritance: grants(),
  });

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(ctx.secrets['providers:anthropic'], { apiKey: 'FAKE-SECRET-propia' },
    'usa SU credencial, jamás la del kernel, aunque la herencia estuviera concedida');
  assert.deepEqual({ ...result.meta.sources }, { 'providers:anthropic': 'project' });
  assert.deepEqual(auditEntries, [], 'sin decisión de herencia no hay evento que auditar');
});

test('#6034 CA-3 · scope propio con placeholder es ERROR (M1), jamás herencia', async () => {
  const { result, ctx, auditEntries } = await resolver({
    credentials: [{ ref: 'fake', scopes: ['providers:anthropic'], inherit: ['providers:anthropic'] }],
    // El vault lo devuelve como RESUELTO: `finalizarInstancia` sólo clasifica
    // como faltante lo `undefined|null`. Sin el chequeo de placeholder, este
    // caso pasaría verde con una credencial inservible.
    driver: driverWith([
      ['providers__anthropic', { apiKey: 'CHANGE_ME' }],
      ['providers__anthropic', { apiKey: 'FAKE-SECRET-kernel' }, 'host', KERNEL],
    ]),
    inheritance: grants(),
  });

  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(ctx.secrets, null, 'sin secretos parciales en el ctx');
  assert.match(result.error, /providers:anthropic/);
  assert.match(result.error, /vacio o de placeholder/);
  assert.ok(!JSON.stringify({ result, auditEntries }).includes('FAKE-SECRET'),
    'un scope propio roto NO abre la puerta a la credencial del kernel');
});

test('#6034 CA-3 · scope propio vacío tambien es ERROR (M1)', async () => {
  const { result } = await resolver({
    credentials: [{ ref: 'fake', scopes: ['providers:anthropic'], inherit: ['providers:anthropic'] }],
    driver: driverWith([['providers__anthropic', { apiKey: '' }]]),
    inheritance: grants(),
  });

  assert.equal(result.ok, false, JSON.stringify(result));
  assert.match(result.error, /vacio o de placeholder/);
});

// -----------------------------------------------------------------------------
// CA-4 · la autoridad vive del lado del KERNEL (grant), no del descriptor hijo
// -----------------------------------------------------------------------------

test('#6034 CA-4 · scope faltante SIN `inherit` declarado es fail-closed (M2)', async () => {
  const { result, ctx } = await resolver({
    credentials: [{ ref: 'fake', scopes: ['providers:anthropic'] }],
    driver: driverWith([['providers__anthropic', { apiKey: 'FAKE-SECRET-kernel' }, 'host', KERNEL]]),
    inheritance: grants(),
  });

  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(ctx.secrets, null);
  assert.match(result.error, /no lo declara en credentials\[\]\.inherit/);
  assert.deepEqual(result.meta.missing, ['providers:anthropic']);
});

test('#6034 CA-4 · `inherit` declarado SIN grant del kernel es error (M4), aunque el hijo lo pida', async () => {
  const { result, ctx, auditEntries } = await resolver({
    credentials: [{ ref: 'fake', scopes: ['providers:anthropic'], inherit: ['providers:anthropic'] }],
    driver: driverWith([['providers__anthropic', { apiKey: 'FAKE-SECRET-kernel' }, 'host', KERNEL]]),
    inheritance: { grants: [] },              // el kernel no concede nada
  });

  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(ctx.secrets, null, 'el descriptor autoemitido no se autoconcede la credencial del kernel');
  assert.match(result.error, /el kernel no le concedio ese scope/);
  assert.match(result.error, /vault\.inheritance\.grants/, 'nombra dónde se declara el grant');
  // REQ-SEC-3 — la DENEGACIÓN también deja traza: sin ella se puede sondear qué
  // concede el kernel sin dejar huella.
  const denegados = eventos(auditEntries).filter((e) => e.decision === 'denied');
  assert.equal(denegados.length, 1, JSON.stringify(auditEntries));
  assert.equal(denegados[0].motivo, MOTIVOS_HERENCIA.M4);
  assert.equal(denegados[0].projectId, HIJO);
  assert.equal(denegados[0].scope, 'providers:anthropic');
});

test('#6034 CA-4/CA-9 · `inherit` + grant vigente hereda, con auditoría redactada y source marcado', async () => {
  const { result, ctx, auditEntries } = await resolver({
    credentials: [{ ref: 'fake', scopes: ['providers:anthropic'], inherit: ['providers:anthropic'] }],
    driver: driverWith([['providers__anthropic', { apiKey: 'FAKE-SECRET-kernel' }, 'host', KERNEL]]),
    inheritance: grants(),
  });

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(ctx.secrets['providers:anthropic'], { apiKey: 'FAKE-SECRET-kernel' });
  assert.deepEqual({ ...result.meta.sources }, { 'providers:anthropic': 'kernel-inherited' });

  const concedidos = eventos(auditEntries).filter((e) => e.decision === 'granted');
  assert.equal(concedidos.length, 1, JSON.stringify(auditEntries));
  assert.equal(concedidos[0].event, 'credential-inheritance');
  assert.equal(concedidos[0].projectId, HIJO);
  assert.equal(concedidos[0].scope, 'providers:anthropic');
  assert.equal(concedidos[0].source, 'kernel-inherited');
  // A02 — el evento lleva NOMBRES, jamás el valor.
  assert.ok(!JSON.stringify(auditEntries).includes('FAKE-SECRET'), JSON.stringify(auditEntries));
  assert.ok(!JSON.stringify(result.meta).includes('FAKE-SECRET'));
});

// -----------------------------------------------------------------------------
// CA-5 · el grant es opt-in por booleano exacto y con vencimiento obligatorio
// -----------------------------------------------------------------------------

for (const [etiqueta, extra] of [
  ['flag `"true"` string', { enabled: 'true' }],
  ['flag `1`', { enabled: 1 }],
  ['flag `"si"`', { enabled: 'si' }],
  ['flag ausente', { enabled: undefined }],
  ['`until` ausente', { until: undefined }],
  ['`until` invalido', { until: 'el viernes' }],
  ['`until` vencido', { until: '2020-01-01T00:00:00Z' }],
]) {
  test(`#6034 CA-5 · grant con ${etiqueta} NO habilita la herencia (M5)`, async () => {
    const { result, ctx } = await resolver({
      credentials: [{ ref: 'fake', scopes: ['providers:anthropic'], inherit: ['providers:anthropic'] }],
      driver: driverWith([['providers__anthropic', { apiKey: 'FAKE-SECRET-kernel' }, 'host', KERNEL]]),
      inheritance: grants(extra),
    });

    assert.equal(result.ok, false, JSON.stringify(result));
    assert.equal(ctx.secrets, null);
    assert.match(result.error, /providers:anthropic/);
    assert.match(result.error, /"acme"/);
    assert.ok(!result.error.includes('FAKE-SECRET'));
  });
}

test('#6034 CA-5/UX-OPS-E · los cuatro sub-motivos de M5 remedian distinto', async () => {
  const base = {
    projectId: HIJO, scope: 'providers:anthropic', inherit: ['providers:anthropic'], ahora: Date.parse(VIGENTE) - 1,
  };
  const decision = (extra) => evaluarHerenciaScope({ ...base, grants: grants(extra) });

  const apagado = decision({ enabled: false });
  const sinUntil = decision({ until: undefined });
  const malUntil = decision({ until: 'el viernes' });
  const vencido = evaluarHerenciaScope({ ...base, grants: grants({ until: '2020-01-01T00:00:00Z' }), ahora: Date.now() });

  assert.equal(apagado.submotivo, SUBMOTIVOS_M5.FLAG_APAGADO);
  assert.equal(sinUntil.submotivo, SUBMOTIVOS_M5.UNTIL_AUSENTE);
  assert.equal(malUntil.submotivo, SUBMOTIVOS_M5.UNTIL_INVALIDO);
  assert.equal(vencido.submotivo, SUBMOTIVOS_M5.CADUCADA);

  // Mandar al operador a tocar `until` cuando lo que falta es `enabled: true` es
  // enviarlo a arreglar lo que no está roto: las remediaciones deben diferir.
  assert.match(apagado.mensaje, /"enabled: true"/);
  assert.ok(!apagado.mensaje.includes('ISO-8601'), apagado.mensaje);
  assert.match(sinUntil.mensaje, /ISO-8601/);
  assert.match(malUntil.mensaje, /ISO-8601/);
  assert.match(vencido.mensaje, /vencio el 2020-01-01T00:00:00Z/);
  const remediaciones = new Set([apagado, sinUntil, vencido].map((d) => d.mensaje.split('Proximo paso:')[1]));
  assert.equal(remediaciones.size, 3, 'tres situaciones, tres instrucciones distintas');
});

// -----------------------------------------------------------------------------
// CA-6 / CA-7 · allowlist de heredables y vocabulario cerrado
// -----------------------------------------------------------------------------

for (const scope of ['aws', 'github']) {
  test(`#6034 CA-6 · "${scope}" NUNCA se hereda, aunque haya inherit Y grant`, async () => {
    const { result, ctx } = await resolver({
      credentials: [{ ref: 'fake', scopes: [scope], inherit: [scope] }],
      driver: driverWith([[scope, { token: 'FAKE-SECRET-kernel' }, 'host', KERNEL]]),
      // Grant que intenta conceder explícitamente lo no heredable.
      inheritance: { grants: [{ projectId: HIJO, scopes: [scope], enabled: true, until: VIGENTE }] },
    });

    assert.equal(result.ok, false, JSON.stringify(result));
    assert.equal(ctx.secrets, null);
    assert.match(result.error, /NO se hereda nunca/);
    assert.ok(!JSON.stringify(result).includes('FAKE-SECRET'));
  });
}

test('#6034 CA-6 · un scope inventado no es heredable sin tocar código', async () => {
  const { result, ctx } = await resolver({
    credentials: [{ ref: 'fake', scopes: ['FAKE-scope-nuevo'], inherit: ['FAKE-scope-nuevo'] }],
    driver: driverWith([['FAKE-scope-nuevo', { token: 'FAKE-SECRET-kernel' }, 'host', KERNEL]]),
    inheritance: { grants: [{ projectId: HIJO, scopes: ['FAKE-scope-nuevo'], enabled: true, until: VIGENTE }] },
  });

  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(ctx.secrets, null);
  // Cae por M6 y no por M3 porque CA-7 fija el ORDEN: el vocabulario cerrado se
  // valida ANTES del deny por herencia, así que "no te conozco" gana sobre "no
  // sos heredable". El efecto que CA-6 exige se cumple igual, y con el mensaje
  // más útil: el scope no existe, no alcanza con volverlo heredable.
  assert.match(result.error, /no pertenece al vocabulario/);
});

for (const variante of ['AWS:prod', 'Aws', 'aws ', 'aws:']) {
  test(`#6034 CA-7 · la variante no canonica ${JSON.stringify(variante)} se rechaza (M6)`, () => {
    const decision = evaluarHerenciaScope({
      projectId: HIJO,
      scope: variante,
      inherit: [variante],
      grants: { grants: [{ projectId: HIJO, scopes: [variante], enabled: true, until: VIGENTE }] },
      ahora: Date.now(),
    });

    assert.equal(decision.ok, false, `${variante} NO puede heredarse`);
    assert.equal(decision.motivo, MOTIVOS_HERENCIA.M6, decision.mensaje);
  });
}

test('#6034 CA-7 · el vocabulario se valida antes de derivar la raiz', () => {
  // `aws:` es el caso que demuestra por qué no alcanza con mirar `rootScope`:
  // su raíz ES `aws`, que pertenece a `SECRET_SCOPES`, así que un control por
  // raíz sola lo dejaría pasar la puerta del vocabulario.
  const { rootScope, SECRET_SCOPES } = require('../secret-scopes');
  assert.equal(rootScope('aws:'), 'aws');
  assert.ok(SECRET_SCOPES.includes(rootScope('aws:')), 'la raíz sola no alcanza para rechazarlo');
  assert.equal(
    evaluarHerenciaScope({ projectId: HIJO, scope: 'aws:', inherit: ['aws:'], grants: [], ahora: 0 }).motivo,
    MOTIVOS_HERENCIA.M6,
  );
});

// -----------------------------------------------------------------------------
// CA-1 / REQ-SEC-6 · la puerta única es el CÓDIGO, nunca el vacío
// -----------------------------------------------------------------------------

test('#6034 CA-1 · sólo VAULT_SCOPE_MISSING habilita la herencia (6 codigos del enum + FAKE_CODE)', () => {
  const codigos = Object.values(INSTANCE_VAULT_ERROR_CODES);
  assert.equal(codigos.length, 6, 'el barrido cubre el enum COMPLETO');

  for (const code of codigos) {
    const esperado = code === INSTANCE_VAULT_ERROR_CODES.VAULT_SCOPE_MISSING;
    assert.equal(_herenciaHabilitadaPorCodigo(code), esperado, `codigo ${code}`);
  }
  // Un código que todavía no existe: la regla está escrita en positivo y cerrada,
  // así que lo que se agregue mañana cae del lado del error sin que nadie lo liste.
  assert.equal(_herenciaHabilitadaPorCodigo('FAKE_CODE'), false);
  assert.equal(_herenciaHabilitadaPorCodigo(undefined), false);
  assert.equal(_herenciaHabilitadaPorCodigo(null), false);
});

test('#6034 CA-1 · con el vault APAGADO no hay herencia, aunque haya inherit y grant (M7)', async () => {
  const { result, ctx, auditEntries } = await resolver({
    credentials: [{ ref: 'fake', scopes: ['providers:anthropic'], inherit: ['providers:anthropic'] }],
    driver: driverWith([['providers__anthropic', { apiKey: 'FAKE-SECRET-kernel' }, 'host', KERNEL]]),
    cfg: { enabled: false },
    inheritance: grants(),
  });

  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(ctx.secrets, null);
  assert.equal(result.meta.code, 'VAULT_DISABLED');
  assert.match(result.error, /NO se evalua/, 'dice que la herencia ni se evaluó');
  // El invariante en una línea: apagado NO significa "el producto no lo tiene".
  assert.match(result.error, /nunca significa que el producto no tenga la credencial/);
  // Conserva el diagnóstico del vault, que es la remediación accionable.
  assert.match(result.error, /vault\.enabled/);
  assert.ok(!JSON.stringify({ result, auditEntries }).includes('FAKE-SECRET'));
  assert.equal(eventos(auditEntries).filter((e) => e.decision === 'granted').length, 0);
});

test('#6034 CA-1 · un fallo del driver del vault tampoco abre la herencia (M7)', async () => {
  const explota = {
    getParametersByPath: () => { throw new Error('FAKE-fallo-del-driver'); },
    getParameter: () => { throw new Error('FAKE-fallo-del-driver'); },
  };
  const { result, ctx } = await resolver({
    credentials: [{ ref: 'fake', scopes: ['providers:anthropic'], inherit: ['providers:anthropic'] }],
    driver: explota,
    inheritance: grants(),
  });

  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(ctx.secrets, null);
  assert.notEqual(result.meta.code, INSTANCE_VAULT_ERROR_CODES.VAULT_SCOPE_MISSING);
  assert.match(result.error, /NO se evalua/);
});

// -----------------------------------------------------------------------------
// CA-12 · la traducción del error del vault apunta al DESCRIPTOR
// -----------------------------------------------------------------------------

test('#6034 CA-12 · `VaultConfigError` de `vault.scope` remedia sobre el descriptor, no sobre config.yaml', async () => {
  const { result, ctx } = await resolver({
    // `fake.scope` tiene un punto: el borde del vault lo rechaza como segmento.
    credentials: [{ ref: 'fake', scopes: ['fake.scope'] }],
    driver: driverWith([]),
    inheritance: grants(),
  });

  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(ctx.secrets, null);
  assert.match(result.error, /descriptors\/acme\.json/, 'manda al archivo donde está el defecto real');
  assert.match(result.error, /fake\.scope/, 'nombra el scope del contrato rechazado');
  assert.ok(!/Proximo paso: corregir esa clave en \.pipeline\/config\.yaml/.test(result.error),
    'NO manda al operador a config.yaml a buscar algo que no está ahí');
});

test('#6034 CA-12 · las demas claves del vault conservan la remediacion sobre config.yaml', async () => {
  const { result } = await resolver({
    credentials: [{ ref: 'fake', scopes: ['providers:anthropic'] }],
    driver: driverWith([]),
    cfg: { prefix: 'sin-barra-inicial' },        // `vault.prefix` es dato del HOST
    inheritance: grants(),
  });

  assert.equal(result.ok, false, JSON.stringify(result));
  assert.match(result.error, /\.pipeline\/config\.yaml/);
});

// -----------------------------------------------------------------------------
// Riesgos ALTOS del mapeo: caso mixto, anti-recursión, aislamiento del path
// -----------------------------------------------------------------------------

test('#6034 · caso MIXTO: un scope propio y uno heredado conviven en ctx.secrets', async () => {
  // El riesgo que este caso cubre: `failInstancia` devuelve `scopes: {}` cuando
  // hay faltantes, así que la rama de herencia arranca sobre un objeto vacío.
  // Sin re-resolver lo propio, la instancia quedaría con SÓLO lo heredado — y
  // todos los tests de un único scope pasarían verde igual.
  const { result, ctx, auditEntries } = await resolver({
    credentials: [{
      ref: 'fake',
      scopes: ['github', 'providers:anthropic'],
      inherit: ['providers:anthropic'],
    }],
    driver: driverWith([
      ['github', { token: 'FAKE-SECRET-propia-github' }],
      ['providers__anthropic', { apiKey: 'FAKE-SECRET-kernel-anthropic' }, 'host', KERNEL],
    ]),
    inheritance: grants(),
  });

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(Object.keys(ctx.secrets).sort(), ['github', 'providers:anthropic'],
    'el scope propio NO se pierde al heredar el otro');
  assert.deepEqual(ctx.secrets.github, { token: 'FAKE-SECRET-propia-github' });
  assert.deepEqual(ctx.secrets['providers:anthropic'], { apiKey: 'FAKE-SECRET-kernel-anthropic' });
  // CA-10 — el origen por scope distingue uno de otro.
  assert.deepEqual({ ...result.meta.sources }, {
    github: 'project',
    'providers:anthropic': 'kernel-inherited',
  });
  assert.deepEqual(result.meta.scopes.sort(), ['github', 'providers:anthropic']);
  assert.ok(!JSON.stringify({ meta: result.meta, auditEntries }).includes('FAKE-SECRET'));
  // Sólo se auditó la concesión REAL, no el scope propio.
  const concedidos = eventos(auditEntries).filter((e) => e.decision === 'granted');
  assert.deepEqual(concedidos.map((e) => e.scope), ['providers:anthropic']);
});

test('#6034 · anti-recursion: el kernel no hereda de si mismo', async () => {
  // El producto ES el kernel (`vault.projectId === 'acme'`): aun con `inherit` y
  // un grant a su nombre, no hay herencia.
  const { result, ctx } = await resolver({
    credentials: [{ ref: 'fake', scopes: ['providers:anthropic'], inherit: ['providers:anthropic'] }],
    driver: driverWith([['providers__anthropic', { apiKey: 'FAKE-SECRET-kernel' }, 'host', KERNEL]]),
    cfg: { projectId: HIJO },
    inheritance: grants(),
  });

  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(ctx.secrets, null);
  assert.ok(!JSON.stringify(result).includes('FAKE-SECRET'));
});

test('#6034 CA-8 · la herencia lee el path canonico del kernel, nunca el del descriptor hijo', async () => {
  const driver = driverWith([['providers__anthropic', { apiKey: 'FAKE-SECRET-kernel' }, 'host', KERNEL]]);
  const { result } = await resolver({
    // `ref` hostil: apunta a otro archivo/proyecto. No debe influir NINGÚN path.
    credentials: [{
      ref: '../../otro-proyecto/hosts/otro',
      scopes: ['providers:anthropic'],
      inherit: ['providers:anthropic'],
    }],
    driver,
    inheritance: grants(),
  });

  assert.equal(result.ok, true, JSON.stringify(result));
  const raices = driver.calls.map((c) => c.root || c.name || '');
  assert.ok(raices.length > 0, 'hubo lecturas del vault');
  for (const raiz of raices) {
    assert.ok(!raiz.includes('..'), `sin traversal: ${raiz}`);
    assert.ok(!raiz.includes('otro-proyecto'), `el destino hostil no aparece: ${raiz}`);
    assert.ok(
      raiz.startsWith(`${PREFIX}/${HIJO}/`) || raiz.startsWith(`${PREFIX}/${KERNEL}/`),
      `sólo el namespace propio o el canónico del kernel: ${raiz}`,
    );
  }
  // La lectura cross-namespace existió, y fue exactamente la del kernel.
  assert.ok(raices.some((r) => r.startsWith(`${PREFIX}/${KERNEL}/`)), JSON.stringify(raices));
});

// -----------------------------------------------------------------------------
// CA-11 · ocho mensajes fail-closed distinguibles
// -----------------------------------------------------------------------------

/** Provoca las ocho situaciones END-TO-END y devuelve el mensaje de cada una. */
async function losOchoMensajes() {
  const kernelSembrado = [['providers__anthropic', { apiKey: 'FAKE-SECRET-kernel' }, 'host', KERNEL]];
  const casos = {
    M1: {
      credentials: [{ ref: 'fake', scopes: ['providers:anthropic'], inherit: ['providers:anthropic'] }],
      driver: driverWith([['providers__anthropic', { apiKey: 'CHANGE_ME' }], ...kernelSembrado]),
      inheritance: grants(),
    },
    M2: {
      credentials: [{ ref: 'fake', scopes: ['providers:anthropic'] }],
      driver: driverWith(kernelSembrado),
      inheritance: grants(),
    },
    M3: {
      credentials: [{ ref: 'fake', scopes: ['aws'], inherit: ['aws'] }],
      driver: driverWith([['aws', { key: 'FAKE-SECRET-kernel' }, 'host', KERNEL]]),
      inheritance: { grants: [{ projectId: HIJO, scopes: ['aws'], enabled: true, until: VIGENTE }] },
    },
    M4: {
      credentials: [{ ref: 'fake', scopes: ['providers:anthropic'], inherit: ['providers:anthropic'] }],
      driver: driverWith(kernelSembrado),
      inheritance: { grants: [] },
    },
    M5: {
      credentials: [{ ref: 'fake', scopes: ['providers:anthropic'], inherit: ['providers:anthropic'] }],
      driver: driverWith(kernelSembrado),
      inheritance: grants({ enabled: false }),
    },
    M6: {
      credentials: [{ ref: 'fake', scopes: ['FAKE-scope-nuevo'], inherit: ['FAKE-scope-nuevo'] }],
      driver: driverWith(kernelSembrado),
      inheritance: grants(),
    },
    M7: {
      credentials: [{ ref: 'fake', scopes: ['providers:anthropic'], inherit: ['providers:anthropic'] }],
      driver: driverWith(kernelSembrado),
      cfg: { enabled: false },
      inheritance: grants(),
    },
    M8: {
      credentials: [{ ref: 'fake', scopes: ['fake.scope'], inherit: ['providers:anthropic'] }],
      driver: driverWith(kernelSembrado),
      inheritance: grants(),
    },
  };

  const mensajes = {};
  for (const [motivo, caso] of Object.entries(casos)) {
    const { result } = await resolver(caso);
    assert.equal(result.ok, false, `${motivo} tiene que fallar: ${JSON.stringify(result)}`);
    mensajes[motivo] = result.error;
  }
  return mensajes;
}

test('#6034 CA-11 · los ocho mensajes son distintos dos a dos, tambien sin el sujeto', async () => {
  const mensajes = await losOchoMensajes();
  const lista = Object.values(mensajes);
  assert.equal(lista.length, 8);
  assert.equal(new Set(lista).size, 8, 'ocho textos distintos');

  // UX-OPS-F — la comparación cruda pasaría verde aunque los ocho fueran la
  // misma frase con distinto scope interpolado. Se normalizan las variables
  // antes de contar: lo que tiene que diferir es la INSTRUCCIÓN, no el sujeto.
  const normalizar = (m) => m
    .replace(/"[^"]*"/g, '"X"')
    .replace(/\b(providers|telegram|r2|aws|github|multimedia|google_drive)[:\w]*/g, 'SCOPE');
  assert.equal(new Set(lista.map(normalizar)).size, 8, JSON.stringify(lista.map(normalizar), null, 1));
});

test('#6034 CA-11 · cada mensaje nombra el producto y el scope, y ninguno filtra un secreto', async () => {
  const mensajes = await losOchoMensajes();
  for (const [motivo, mensaje] of Object.entries(mensajes)) {
    assert.ok(mensaje.includes(`"${HIJO}"`), `${motivo} nombra el producto: ${mensaje}`);
    assert.ok(/providers:anthropic|aws|FAKE-scope-nuevo|fake\.scope/.test(mensaje),
      `${motivo} nombra el scope: ${mensaje}`);
    assert.ok(mensaje.includes('Proximo paso:'), `${motivo} trae remediación: ${mensaje}`);
    assert.ok(!mensaje.includes('FAKE-SECRET'), `${motivo} NO filtra el valor: ${mensaje}`);
  }
});

test('#6034 UX-OPS-B/G · los mensajes son ASCII-safe y sin texto terminal vacio', async () => {
  const mensajes = await losOchoMensajes();
  for (const [motivo, mensaje] of Object.entries(mensajes)) {
    // Van a consola de Windows (cp1252) y a Telegram: sin tildes ni rayas.
    // eslint-disable-next-line no-control-regex
    assert.ok(!/[^\x00-\x7F]/.test(mensaje), `${motivo} es ASCII-safe: ${mensaje}`);
    assert.ok(!/undefined|null|\[object Object\]|NaN/.test(mensaje), `${motivo} sin terminal vacío: ${mensaje}`);
    assert.ok(!/(—|scopes faltantes|missing: )/.test(mensaje), `${motivo} sin texto terminal prohibido: ${mensaje}`);
    // UX-OPS-C — vocabulario de CONTRATO, nunca el segmento interno del vault.
    assert.ok(!mensaje.includes('__'), `${motivo} no muestra plomería del vault: ${mensaje}`);
  }
});

// -----------------------------------------------------------------------------
// CA-9 · la auditoría es encadenada y no se rompe en silencio
// -----------------------------------------------------------------------------

test('#6034 CA-9 · si no se puede auditar la concesion, NO se hereda', async () => {
  _resetVaultCache();
  const supervisor = createSupervisor();
  await supervisor.bootProducts();
  const ctx = supervisor.getInstance(HIJO);
  ctx.descriptor = {
    credentials: [{ ref: 'fake', scopes: ['providers:anthropic'], inherit: ['providers:anthropic'] }],
  };

  const result = supervisor.resolveInstanceSecrets(HIJO, {
    vaultConfig: { ...vaultConfig(), inheritance: grants() },
    vaultDriver: driverWith([['providers__anthropic', { apiKey: 'FAKE-SECRET-kernel' }, 'host', KERNEL]]),
    logger: () => {},
    auditImpl: { appendChained: () => { throw new Error('FAKE-audit-caido'); } },
  });

  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(ctx.secrets, null, 'una credencial del kernel no se entrega sin registro no repudiable');
  assert.match(result.error, /no se pudo dejar traza/);
  assert.ok(!result.error.includes('FAKE-SECRET'));
});

test('#6034 CA-9 · una auditoria caida NO tumba la denegacion (el pipeline sigue vivo)', async () => {
  _resetVaultCache();
  const supervisor = createSupervisor();
  await supervisor.bootProducts();
  const ctx = supervisor.getInstance(HIJO);
  ctx.descriptor = {
    credentials: [{ ref: 'fake', scopes: ['providers:anthropic'], inherit: ['providers:anthropic'] }],
  };
  const logs = [];

  const result = supervisor.resolveInstanceSecrets(HIJO, {
    vaultConfig: { ...vaultConfig(), inheritance: { grants: [] } },
    vaultDriver: driverWith([]),
    logger: (line) => logs.push(line),
    auditImpl: { appendChained: () => { throw new Error('FAKE-audit-caido'); } },
  });

  assert.equal(result.ok, false, 'la denegación sigue en pie');
  assert.equal(ctx.secrets, null);
  assert.ok(logs.some((l) => l.includes('no se pudo auditar la denegacion')), JSON.stringify(logs));
});

// -----------------------------------------------------------------------------
// Arquitectura: el módulo de decisión es HOJA
// -----------------------------------------------------------------------------

test('#6034 · kernel-inheritance.js es hoja: solo depende de secret-scopes', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const fuente = fs.readFileSync(path.join(__dirname, '..', 'kernel-inheritance.js'), 'utf8');
  const locales = [...fuente.matchAll(/require\('(\.[^']+)'\)/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(locales)], ['./secret-scopes'],
    'un require de credentials/kernel-supervisor/audit-log reintroduce el ciclo que el corte evita');
});
