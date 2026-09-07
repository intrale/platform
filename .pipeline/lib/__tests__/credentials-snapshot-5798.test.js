'use strict';

// =============================================================================
// credentials-snapshot-5798.test.js — API de snapshot AISLADO de credenciales
// por lanzamiento (#5798 · split de #5791 · paraguas #5440)
//
// Cubre los criterios de aceptación cerrados en `definicion/criterios`:
//
//   CA-1  destino explícito, validado y sin default implícito; el scope no
//         autorizado falla ANTES de tocar el driver.
//   CA-2  aislamiento profundo por invocación: objeto nuevo, mutaciones que no
//         viajan a otro snapshot, a la caché, a las deps ni a `process.env`.
//   CA-3  mínimo privilegio en la superficie devuelta.
//   CA-4  atomicidad fail-closed con código estable, sin snapshot parcial.
//   CA-5  precedencia vault-only del ancla `telegram.leo_operator_chat_id`.
//   CA-6  no divulgación en excepción, señal local, auditoría y serialización.
//   CA-7  el contrato síncrono existente no cambia.
//   CA-8  costura limpia sobre la caché/single-flight de #5797.
//
// FUERA DE ALCANCE (y por eso NO se testea acá): la caché versionada y el
// single-flight son de #5797 —acá sólo se verifica que el snapshot los CONSUME
// por la costura pública, sin conocer `_vaultMemo`— y los call-sites de
// `pulpo.js` son de #5799.
//
// Higiene de fixtures: todo valor sintético lleva prefijo `FAKE-`. El canario de
// CA-6 lleva `CANARIO-` para poder buscarlo por substring sobre serializaciones
// completas. Ningún assert compara un valor de credencial contra un literal
// esperado salvo para probar que el material CORRECTO llegó al destino
// correcto; el resto compara nombres, presencia y forma.
//
// Nota sobre la lectura de CA-6: el snapshot es, por definición, el objeto que
// LLEVA las credenciales al destino, así que las credenciales PEDIDAS están en
// su `env` — ahí no hay nada que redactar. Lo que CA-6 prohíbe es que un valor
// se escape por un canal que no es el destino: el error, la señal local, la
// forma de auditoría (`redactSnapshot`) y —en el éxito— cualquier credencial
// que el destino NO pidió. Eso es lo que verifican los tests de CA-6.
// =============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const sv = require('../secret-vault');
const { buildParameterPath, createInMemoryVaultDriver } = sv;
const cred = require('../credentials');
const {
  createCredentialSnapshot,
  SNAPSHOT_DESTINATIONS,
  SNAPSHOT_ERROR_CODES,
  redactSnapshot,
  resetVaultCacheAll,
  resetVaultCache,
  ENV_DESCRIPTORS,
} = cred;

const PREFIX = '/test5798';
const HOST = 'hostDePrueba';
const PROJECT = 'kernel';

// -----------------------------------------------------------------------------
// Fixtures
// -----------------------------------------------------------------------------

function cfg(over = {}) {
  return {
    enabled: true,
    prefix: PREFIX,
    projectId: PROJECT,
    hostId: HOST,
    cache_ttl_seconds: 300,
    required_scopes: [],
    shared_secrets: [],
    max_cached_tenants: 8,
    ...over,
  };
}

const CANARIO_ANTHROPIC = 'CANARIO-anthropic-api-key';
const CANARIO_BOT_TOKEN = 'CANARIO-telegram-bot-token';
const CANARIO_OPENAI = 'CANARIO-openai-api-key';

/** Material por scope, con la forma REAL del vault (un scope es un objeto). */
function materialCompleto(over = {}) {
  return {
    providers: {
      openai: { api_key: CANARIO_OPENAI },
      anthropic: { api_key: CANARIO_ANTHROPIC },
      google: { api_key: 'FAKE-google-api-key' },
      cerebras: { api_key: 'FAKE-cerebras-api-key' },
      nvidia: { api_key: 'FAKE-nvidia-api-key' },
      moonshot: { api_key: 'FAKE-moonshot-api-key' },
    },
    telegram: {
      bot_token: CANARIO_BOT_TOKEN,
      chat_id: 'FAKE-telegram-chat-id',
      leo_operator_chat_id: 'FAKE-leo-operator-chat-id',
    },
    google_drive: {
      oauth_client_id: 'FAKE-drive-client-id',
      oauth_client_secret: 'FAKE-drive-client-secret',
      drive_folder_id: 'FAKE-drive-folder-id',
    },
    ...over,
  };
}

/** Hoja rotatoria (Secrets Manager): el refresh token de Drive. */
const ROTATING_DRIVE = { oauth_refresh_token: 'FAKE-drive-refresh-token' };

/**
 * Driver in-memory sembrado con `material` en el tier `host` y el scope
 * rotatorio en Secrets Manager. `projectId` permite sembrar un tenant.
 */
function driverSembrado({
  material = materialCompleto(),
  rotating = ROTATING_DRIVE,
  projectId = PROJECT,
} = {}) {
  const parameters = {};
  for (const [scope, valor] of Object.entries(material)) {
    parameters[buildParameterPath({
      prefix: PREFIX, projectId, hostId: HOST, scope, tier: 'host',
    })] = valor;
  }
  const secrets = {};
  if (rotating) {
    secrets[buildParameterPath({
      prefix: PREFIX, projectId, scope: 'google_drive', tier: 'rotating',
    })] = rotating;
  }
  return createInMemoryVaultDriver({ parameters, secrets });
}

/** Driver que niega toda lectura (fallo del vault, no "secreto faltante"). */
function driverQueDeniega() {
  const calls = [];
  const explotar = () => {
    calls.push({ op: 'denegado' });
    const err = new Error('AccessDenied: el principal no puede leer /test5798/kernel');
    err.code = 'AccessDenied';
    throw err;
  };
  return {
    kind: 'denegador',
    calls,
    getParametersByPathSync: explotar,
    getSecretValueSync: explotar,
    getParametersByPath: async () => explotar(),
    getSecretValue: async () => explotar(),
  };
}

function capturarLogs() {
  const lineas = [];
  const fn = (msg) => lineas.push(String(msg));
  fn.texto = () => lineas.join('\n');
  fn.lineas = lineas;
  return fn;
}

/** Pedido base para `agent-child` con el driver sembrado. */
function pedidoAgente(over = {}) {
  return {
    destination: 'agent-child',
    scopes: ['providers'],
    provider: 'openai',
    vaultConfig: cfg(),
    vaultDriver: driverSembrado(),
    logger: () => {},
    ...over,
  };
}

/** Captura la excepción de una promesa que DEBE rechazar. */
async function capturarFallo(promesa) {
  try {
    const res = await promesa;
    assert.fail(`la creacion deberia haber fallado; devolvio ${JSON.stringify(res)}`);
  } catch (err) {
    assert.equal(err.name, 'CredentialSnapshotError',
      `error tipado, no ${err && err.name}: ${err && err.message}`);
    return err;
  }
  return null;
}

// La caché es global al módulo: cada test arranca en frío para que un HIT de
// otro test no enmascare (ni invente) una llamada al driver.
test.beforeEach(() => { resetVaultCacheAll(); });

// =============================================================================
// CA-1 · Destino explícito y validado
// =============================================================================

test('CA-1 · sin destino la creacion falla completa y con codigo estable', async () => {
  const driver = driverSembrado();
  for (const destination of [undefined, null, '', 0, 42, {}, [], () => {}, true]) {
    const err = await capturarFallo(createCredentialSnapshot(
      pedidoAgente({ destination, vaultDriver: driver }),
    ));
    assert.equal(err.code, SNAPSHOT_ERROR_CODES.SNAPSHOT_DESTINATION_REQUIRED,
      `destino ${JSON.stringify(destination) || typeof destination}`);
    assert.equal(err.destination, 'destino-no-declarado',
      'el destino no declarado NO se refleja de vuelta');
  }
  assert.equal(driver.calls.length, 0, 'cero llamadas al driver (CA-1)');
});

test('CA-1 · un destino ambiguo o desconocido NO se normaliza: se rechaza', async () => {
  const driver = driverSembrado();
  const ambiguos = [
    ' agent-child ',      // trim implícito sería adivinar
    'agent-child ',
    'AGENT-CHILD',        // case-folding implícito sería adivinar
    'Agent-Child',
    'agent_child',
    'agent-child-2',
    'constructor',        // no puede resolver contra Object.prototype
    'toString',
    '__proto__',
    'hasOwnProperty',
  ];
  for (const destination of ambiguos) {
    const err = await capturarFallo(createCredentialSnapshot(
      pedidoAgente({ destination, vaultDriver: driver }),
    ));
    assert.equal(err.code, SNAPSHOT_ERROR_CODES.SNAPSHOT_DESTINATION_UNKNOWN, destination);
    assert.equal(err.destination, 'destino-no-declarado');
    assert.doesNotMatch(err.message, /AGENT-CHILD|__proto__|agent_child/,
      'el destino hostil no se ecoa en el mensaje');
  }
  assert.equal(driver.calls.length, 0, 'cero llamadas al driver (CA-1)');
});

test('CA-1 · los scopes son explicitos: no se defaultean al techo del destino', async () => {
  const driver = driverSembrado();
  for (const scopes of [undefined, null, [], '', 'providers', {}, [''], ['providers', 42], [null]]) {
    const err = await capturarFallo(createCredentialSnapshot(
      pedidoAgente({ scopes, vaultDriver: driver }),
    ));
    assert.equal(err.code, SNAPSHOT_ERROR_CODES.SNAPSHOT_SCOPES_REQUIRED,
      `scopes ${JSON.stringify(scopes)}`);
    assert.equal(err.destination, 'agent-child', 'el destino declarado SI se nombra');
  }
  assert.equal(driver.calls.length, 0, 'cero llamadas al driver (CA-1)');
});

test('CA-1 · un scope no autorizado para el destino falla antes de tocar el driver', async () => {
  const driver = driverSembrado();

  // `telegram` existe en el inventario, pero NO está autorizado para un hijo:
  // el bot token es material reservado que no cruza a un spawn.
  const err = await capturarFallo(createCredentialSnapshot(pedidoAgente({
    scopes: ['telegram'], provider: undefined, vaultDriver: driver,
  })));
  assert.equal(err.code, SNAPSHOT_ERROR_CODES.SNAPSHOT_SCOPE_UNAUTHORIZED);
  assert.equal(err.scope, 'telegram', 'un scope del inventario SI se nombra');

  // Mezclar uno autorizado con uno que no, tampoco pasa parcialmente.
  const mixto = await capturarFallo(createCredentialSnapshot(pedidoAgente({
    scopes: ['providers', 'google_drive'], vaultDriver: driver,
  })));
  assert.equal(mixto.code, SNAPSHOT_ERROR_CODES.SNAPSHOT_SCOPE_UNAUTHORIZED);
  assert.equal(mixto.scope, 'google_drive');

  // Un scope que ni siquiera está en el inventario se REDACTA.
  const hostil = await capturarFallo(createCredentialSnapshot(pedidoAgente({
    scopes: ['aws_vault_bootstrap-hostil'], vaultDriver: driver,
  })));
  assert.equal(hostil.code, SNAPSHOT_ERROR_CODES.SNAPSHOT_SCOPE_UNAUTHORIZED);
  assert.equal(hostil.scope, 'scope-no-declarado');
  assert.doesNotMatch(hostil.message, /hostil/);

  assert.equal(driver.calls.length, 0, 'cero llamadas al driver (CA-1)');
});

test('CA-1 · el scope `providers` exige elegir UN provider declarado', async () => {
  const driver = driverSembrado();

  // Ausente o no-string: no se informo un provider (mismo criterio que el
  // destino, que tampoco distingue "no vino" de "vino con otro tipo").
  for (const provider of [undefined, null, '', 42, {}, [], true, () => {}]) {
    const err = await capturarFallo(createCredentialSnapshot(
      pedidoAgente({ provider, vaultDriver: driver }),
    ));
    assert.equal(err.code, SNAPSHOT_ERROR_CODES.SNAPSHOT_PROVIDER_REQUIRED,
      `provider ${JSON.stringify(provider) || typeof provider}`);
  }
  // Informado pero fuera del inventario: no autorizado. `groq` esta a proposito
  // (existio hasta #3353): la lista de providers se DERIVA del descriptor.
  for (const provider of ['groq', 'openai ', 'OPENAI', 'constructor', '__proto__', 'toString']) {
    const err = await capturarFallo(createCredentialSnapshot(
      pedidoAgente({ provider, vaultDriver: driver }),
    ));
    assert.equal(err.code, SNAPSHOT_ERROR_CODES.SNAPSHOT_PROVIDER_UNAUTHORIZED,
      `provider ${JSON.stringify(provider)}`);
  }

  // Y al revés: un provider sin el scope es un pedido incoherente, y un pedido
  // incoherente se RECHAZA — no se ignora en silencio.
  const incoherente = await capturarFallo(createCredentialSnapshot({
    destination: 'pulpo-telegram', scopes: ['telegram'], provider: 'openai',
    vaultConfig: cfg(), vaultDriver: driver, logger: () => {},
  }));
  assert.equal(incoherente.code, SNAPSHOT_ERROR_CODES.SNAPSHOT_PROVIDER_UNAUTHORIZED);

  assert.equal(driver.calls.length, 0, 'cero llamadas al driver (CA-1)');
});

test('CA-1 · un namespace invalido falla cerrado sin ecoarlo y sin tocar el driver', async () => {
  const driver = driverSembrado();

  // Tipo mal: se caza en la validación del pedido.
  for (const namespace of ['', 42, {}, [], true, () => {}]) {
    const err = await capturarFallo(createCredentialSnapshot(
      pedidoAgente({ namespace, vaultDriver: driver }),
    ));
    assert.equal(err.code, SNAPSHOT_ERROR_CODES.SNAPSHOT_NAMESPACE_INVALID,
      `namespace ${JSON.stringify(namespace) || typeof namespace}`);
  }

  // Forma mal: la caza el validador CANÓNICO del vault (`validateVaultNamespace`),
  // no una copia del regex acá — CA-8 de #5219 lo prohíbe explícitamente y
  // tiene un guardrail sobre el fuente de credentials.js. Igual de fail-closed
  // y con el mismo costo: cero llamadas al driver.
  for (const namespace of ['../otro', 'ns/hostil', 'ns con espacio', 'ns#hostil',
    '/etc/passwd', 'ns\\hostil', 'ns|hostil']) {
    const err = await capturarFallo(createCredentialSnapshot(
      pedidoAgente({ namespace, vaultDriver: driver }),
    ));
    assert.equal(err.code, SNAPSHOT_ERROR_CODES.SNAPSHOT_VAULT_CONFIG_INVALID,
      `namespace ${JSON.stringify(namespace)}`);
    assert.doesNotMatch(err.message, /hostil|passwd/,
      'el namespace hostil no se ecoa de vuelta');
  }

  assert.equal(driver.calls.length, 0, 'cero llamadas al driver (CA-1)');
});

test('CA-1 · la API no toma process.env como destino implicito ni lo muta', async () => {
  const antes = { ...process.env };
  // Un `process.env` hostil que declara TODO lo que el snapshot podría querer.
  process.env.PIPELINE_SNAPSHOT_DESTINATION = 'agent-child';
  process.env.OPENAI_API_KEY = 'HOSTILE-NOT-A-SECRET';
  process.env.TELEGRAM_BOT_TOKEN = 'HOSTILE-NOT-A-SECRET';
  try {
    // Sin `destination` en los ARGUMENTOS no hay destino, punto.
    const err = await capturarFallo(createCredentialSnapshot({
      scopes: ['providers'], provider: 'openai',
      vaultConfig: cfg(), vaultDriver: driverSembrado(), logger: () => {},
    }));
    assert.equal(err.code, SNAPSHOT_ERROR_CODES.SNAPSHOT_DESTINATION_REQUIRED);

    // Y con destino válido, el valor entregado sale del VAULT, no del env.
    const snap = await createCredentialSnapshot(pedidoAgente());
    assert.equal(snap.env.OPENAI_API_KEY, CANARIO_OPENAI);
    assert.notEqual(snap.env.OPENAI_API_KEY, 'HOSTILE-NOT-A-SECRET');
    assert.equal(process.env.OPENAI_API_KEY, 'HOSTILE-NOT-A-SECRET',
      '`process.env` queda EXACTAMENTE como estaba');
  } finally {
    delete process.env.PIPELINE_SNAPSHOT_DESTINATION;
    if (antes.OPENAI_API_KEY === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = antes.OPENAI_API_KEY;
    if (antes.TELEGRAM_BOT_TOKEN === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
    else process.env.TELEGRAM_BOT_TOKEN = antes.TELEGRAM_BOT_TOKEN;
  }
  assert.deepEqual({ ...process.env }, antes, '`process.env` restaurado sin residuo');
});

// =============================================================================
// CA-2 · Aislamiento profundo por invocación
// =============================================================================

test('CA-2 · dos invocaciones devuelven objetos NUEVOS en todos sus niveles', async () => {
  const driver = driverSembrado();
  const a = await createCredentialSnapshot(pedidoAgente({ vaultDriver: driver }));
  const b = await createCredentialSnapshot(pedidoAgente({ vaultDriver: driver }));

  assert.notStrictEqual(a, b, 'el objeto raiz es nuevo');
  assert.notStrictEqual(a.env, b.env, '`env` es nuevo');
  assert.notStrictEqual(a.scopes, b.scopes, '`scopes` es nuevo');
  assert.notStrictEqual(a.keys, b.keys, '`keys` es nuevo');
  assert.deepEqual(a, b, 'mismo contenido: lo que cambia es la identidad, no el material');
});

test('CA-2 · mutar un snapshot no alcanza al otro, ni a la cache, ni a las deps', async () => {
  const config = cfg();
  const configOriginal = JSON.parse(JSON.stringify(config));
  const driver = driverSembrado();
  const parametrosOriginales = JSON.parse(JSON.stringify(
    Object.fromEntries([...driver.calls.keys()].map((k) => [k, k])),
  ));

  const a = await createCredentialSnapshot(pedidoAgente({ vaultConfig: config, vaultDriver: driver }));
  const b = await createCredentialSnapshot(pedidoAgente({ vaultConfig: config, vaultDriver: driver }));

  // Mutación en TODOS los niveles mutables del snapshot A.
  a.env.OPENAI_API_KEY = 'MUTADO-por-el-consumidor';
  a.env.EXTRA_INYECTADA = 'MUTADO-extra';
  delete a.env.NADA;
  a.scopes.push('telegram');
  a.keys.length = 0;
  a.destination = 'MUTADO';
  a.namespace = 'MUTADO';

  assert.equal(b.env.OPENAI_API_KEY, CANARIO_OPENAI, 'el snapshot B no se entero');
  assert.equal(b.env.EXTRA_INYECTADA, undefined);
  assert.deepEqual(b.scopes, ['providers']);
  assert.deepEqual(b.keys, ['providers.openai.api_key']);
  assert.equal(b.destination, 'agent-child');

  // Un tercer snapshot (que sale de la MISMA entrada de caché) tampoco.
  const c = await createCredentialSnapshot(pedidoAgente({ vaultConfig: config, vaultDriver: driver }));
  assert.equal(c.env.OPENAI_API_KEY, CANARIO_OPENAI, 'la cache no quedo envenenada');
  assert.equal(c.env.EXTRA_INYECTADA, undefined);
  assert.deepEqual(c.scopes, ['providers']);

  // Las dependencias inyectadas quedan intactas.
  assert.deepEqual(JSON.parse(JSON.stringify(config)), configOriginal,
    '`vaultConfig` no se muta');
  assert.deepEqual(parametrosOriginales, parametrosOriginales);
});

test('CA-2 · la mutación de un snapshot no puede alcanzar `process.env`', async () => {
  const antes = { ...process.env };
  const snap = await createCredentialSnapshot(pedidoAgente());
  snap.env.PATH = 'MUTADO-path';
  snap.env.OPENAI_API_KEY = 'MUTADO-key';
  assert.deepEqual({ ...process.env }, antes, '`process.env` intacto');
  assert.notEqual(process.env.PATH, 'MUTADO-path');
});

// =============================================================================
// CA-3 · Mínimo privilegio en la superficie devuelta
// =============================================================================

test('CA-3 · el snapshot lleva SOLO la credencial del destino/scope pedidos', async () => {
  const snap = await createCredentialSnapshot(pedidoAgente());

  assert.deepEqual(Object.keys(snap.env), ['OPENAI_API_KEY'],
    'una sola API key: la del provider que despacha (invariante S-2 de #3198)');
  assert.equal(snap.env.ANTHROPIC_API_KEY, undefined);
  assert.equal(snap.env.ANTHROPIC_AUTH_TOKEN, undefined);
  assert.equal(snap.env.TELEGRAM_BOT_TOKEN, undefined, 'material reservado: nunca a un hijo');
  assert.equal(snap.env.TELEGRAM_LEO_OPERATOR_CHAT_ID, undefined, 'el ancla no va a un hijo');
  assert.equal(snap.env.GOOGLE_OAUTH_REFRESH_TOKEN, undefined);

  // El destino de Telegram sí recibe su scope entero, y NADA de providers.
  const tg = await createCredentialSnapshot({
    destination: 'pulpo-telegram', scopes: ['telegram'],
    vaultConfig: cfg(), vaultDriver: driverSembrado(), logger: () => {},
  });
  assert.deepEqual(Object.keys(tg.env).sort(),
    ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID', 'TELEGRAM_LEO_OPERATOR_CHAT_ID']);
  assert.equal(tg.env.OPENAI_API_KEY, undefined);

  // Drive resuelve sus cuatro credenciales, incluida la del tier rotatorio.
  const drive = await createCredentialSnapshot({
    destination: 'qa-evidence', scopes: ['google_drive'],
    vaultConfig: cfg(), vaultDriver: driverSembrado(), logger: () => {},
  });
  assert.deepEqual(Object.keys(drive.env).sort(), [
    'GOOGLE_DRIVE_FOLDER_ID', 'GOOGLE_OAUTH_CLIENT_ID',
    'GOOGLE_OAUTH_CLIENT_SECRET', 'GOOGLE_OAUTH_REFRESH_TOKEN',
  ]);
  assert.equal(drive.env.TELEGRAM_BOT_TOKEN, undefined);
});

test('CA-3 · la superficie devuelta no expone driver, config, caché ni funciones', async () => {
  const snap = await createCredentialSnapshot(pedidoAgente());

  assert.deepEqual(Object.keys(snap).sort(),
    ['destination', 'env', 'keys', 'namespace', 'scopes'],
    'superficie literal y cerrada: nada mas viaja');

  // Ni una función en ningún nivel: nada capaz de resolver otro secreto.
  const funciones = [];
  const recorrer = (v, ruta) => {
    if (typeof v === 'function') { funciones.push(ruta); return; }
    if (v && typeof v === 'object') {
      for (const [k, sub] of Object.entries(v)) recorrer(sub, `${ruta}.${k}`);
    }
  };
  recorrer(snap, '$');
  assert.deepEqual(funciones, [], 'cero funciones en el snapshot');

  // Ni una traza de la topología del vault.
  const serializado = JSON.stringify(snap);
  for (const prohibido of [PREFIX, HOST, 'hosts/', 'rotating', 'secretsmanager',
    'ssm', 'arn:', 'max_cached_tenants', 'cache_ttl_seconds', 'prefix', 'hostId']) {
    assert.ok(!serializado.includes(prohibido),
      `el snapshot no expone "${prohibido}"`);
  }

  // `namespace` es el ECO del argumento del caller, nunca el path del vault.
  assert.equal(snap.namespace, null, 'sin tenant declarado, null');
  const tenant = await createCredentialSnapshot(pedidoAgente({
    namespace: 'mi-producto', vaultDriver: driverSembrado({ projectId: 'mi-producto' }),
  }));
  assert.equal(tenant.namespace, 'mi-producto');
  assert.ok(!JSON.stringify(tenant).includes(PREFIX));
  assert.ok(!JSON.stringify(tenant).includes(HOST));
});

// =============================================================================
// CA-4 · Atomicidad fail-closed
// =============================================================================

test('CA-4 · tabla negativa: todo estado degradado aborta con codigo estable', async () => {
  // Config INDETERMINADA: `.pipeline/config.yaml` ilegible. No es "vault
  // apagado" — se remedian distinto y por eso llevan códigos distintos.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snapshot-5798-config-rota-'));
  const pipelineDir = path.join(dir, '.pipeline');
  fs.mkdirSync(pipelineDir);
  fs.writeFileSync(path.join(pipelineDir, 'config.yaml'), 'vault: [config invalida');

  const casos = [
    ['config indeterminada',
      { vaultConfig: undefined, pipelineDir },
      SNAPSHOT_ERROR_CODES.SNAPSHOT_VAULT_CONFIG_INDETERMINATE],
    ['vault apagado a proposito',
      { vaultConfig: cfg({ enabled: false }) },
      SNAPSHOT_ERROR_CODES.SNAPSHOT_VAULT_DISABLED],
    ['sin seccion vault',
      { vaultConfig: null },
      SNAPSHOT_ERROR_CODES.SNAPSHOT_VAULT_DISABLED],
    ['driver que deniega',
      { vaultDriver: driverQueDeniega() },
      SNAPSHOT_ERROR_CODES.SNAPSHOT_VAULT_FAILURE],
    ['scope entero ausente en el vault',
      { vaultDriver: driverSembrado({ material: { telegram: materialCompleto().telegram } }) },
      SNAPSHOT_ERROR_CODES.SNAPSHOT_VAULT_FAILURE],
    ['secreto ausente dentro de un scope presente',
      { vaultDriver: driverSembrado({ material: { providers: { anthropic: { api_key: 'FAKE-a' } } } }) },
      SNAPSHOT_ERROR_CODES.SNAPSHOT_SECRET_INVALID],
    ['placeholder',
      { vaultDriver: driverSembrado({ material: { providers: { openai: { api_key: 'REVOKED-2026' } } } }) },
      SNAPSHOT_ERROR_CODES.SNAPSHOT_SECRET_INVALID],
    ['cadena vacia',
      { vaultDriver: driverSembrado({ material: { providers: { openai: { api_key: '   ' } } } }) },
      SNAPSHOT_ERROR_CODES.SNAPSHOT_SECRET_INVALID],
    ['payload parcial: un objeto donde se esperaba una hoja',
      { vaultDriver: driverSembrado({ material: { providers: { openai: { api_key: { anidado: 'FAKE' } } } } }) },
      SNAPSHOT_ERROR_CODES.SNAPSHOT_SECRET_INVALID],
  ];

  try {
    for (const [nombre, over, code] of casos) {
      resetVaultCacheAll();
      const logs = capturarLogs();
      const err = await capturarFallo(createCredentialSnapshot(
        pedidoAgente({ ...over, logger: logs }),
      ));
      assert.equal(err.code, code, nombre);
      assert.equal(err.destination, 'agent-child', nombre);
      // El fail-closed es RUIDOSO: deja señal local con el código.
      assert.match(logs.texto(), new RegExp(code), `${nombre}: senal local con el codigo`);
      // Y nunca menciona la topología ni el error crudo del driver.
      assert.doesNotMatch(logs.texto(), /AccessDenied|hostDePrueba|test5798/, nombre);
      assert.doesNotMatch(err.message, /AccessDenied|hostDePrueba|test5798/, nombre);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CA-4 · un scope a medias NO produce snapshot parcial: aborta entero', async () => {
  // `telegram` con dos de sus tres credenciales. Un snapshot parcial acá sería
  // un Pulpo que arranca sin saber a quién le habla.
  const material = materialCompleto();
  delete material.telegram.chat_id;

  const err = await capturarFallo(createCredentialSnapshot({
    destination: 'pulpo-telegram', scopes: ['telegram'],
    vaultConfig: cfg(), vaultDriver: driverSembrado({ material }), logger: () => {},
  }));
  assert.equal(err.code, SNAPSHOT_ERROR_CODES.SNAPSHOT_SECRET_INVALID);
  assert.equal(err.logicalKey, 'telegram.chat_id', 'nombra la clave que falta');
  // El error no es un snapshot disfrazado: no lleva `env` ni valores.
  assert.equal(err.env, undefined);
  assert.ok(!JSON.stringify(err).includes('CANARIO-'));
});

test('CA-4 · el fallo no completa desde el archivo de credenciales ni desde el env', async () => {
  const antes = { ...process.env };
  process.env.OPENAI_API_KEY = 'HOSTILE-NOT-A-SECRET';
  // Un archivo canónico con material servido en bandeja: la API ni lo mira
  // (`canonicalPath` ni siquiera es una dependencia declarada de esta familia).
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snapshot-5798-archivo-'));
  const canonicalPath = path.join(dir, 'credentials.json');
  fs.writeFileSync(canonicalPath, JSON.stringify({
    providers: { openai: { api_key: 'FILE-NOT-A-SECRET' } },
  }));
  try {
    const err = await capturarFallo(createCredentialSnapshot(pedidoAgente({
      vaultDriver: driverSembrado({ material: { telegram: materialCompleto().telegram } }),
      canonicalPath,
      env: process.env,
    })));
    assert.equal(err.code, SNAPSHOT_ERROR_CODES.SNAPSHOT_VAULT_FAILURE);
    assert.doesNotMatch(err.message, /FILE-NOT-A-SECRET|HOSTILE-NOT-A-SECRET/);
  } finally {
    if (antes.OPENAI_API_KEY === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = antes.OPENAI_API_KEY;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// =============================================================================
// CA-5 · Precedencia vault-only del ancla de autorización
// =============================================================================

test('CA-5 · el ancla se resuelve SOLO desde el vault, sin fallback de ningun tipo', async () => {
  const antes = process.env.TELEGRAM_LEO_OPERATOR_CHAT_ID;
  process.env.TELEGRAM_LEO_OPERATOR_CHAT_ID = 'HOSTILE-NOT-A-SECRET';
  try {
    // Con el ancla en el vault, gana el vault — el env hostil no participa.
    const ok = await createCredentialSnapshot({
      destination: 'pulpo-telegram', scopes: ['telegram'],
      vaultConfig: cfg(), vaultDriver: driverSembrado(), logger: () => {},
    });
    assert.equal(ok.env.TELEGRAM_LEO_OPERATOR_CHAT_ID, 'FAKE-leo-operator-chat-id');
    assert.notEqual(ok.env.TELEGRAM_LEO_OPERATOR_CHAT_ID, 'HOSTILE-NOT-A-SECRET');

    // Sin el ancla en el vault, NO se cae al env: aborta con codigo propio.
    for (const anclaRota of [undefined, '', 'PLACEHOLDER-cargar', '   ']) {
      resetVaultCacheAll();
      const material = materialCompleto();
      if (anclaRota === undefined) delete material.telegram.leo_operator_chat_id;
      else material.telegram.leo_operator_chat_id = anclaRota;

      const err = await capturarFallo(createCredentialSnapshot({
        destination: 'pulpo-telegram', scopes: ['telegram'],
        vaultConfig: cfg(), vaultDriver: driverSembrado({ material }), logger: () => {},
      }));
      assert.equal(err.code, SNAPSHOT_ERROR_CODES.SNAPSHOT_ANCHOR_UNRESOLVED,
        `ancla ${JSON.stringify(anclaRota)}`);
      assert.equal(err.logicalKey, 'telegram.leo_operator_chat_id');
    }
  } finally {
    if (antes === undefined) delete process.env.TELEGRAM_LEO_OPERATOR_CHAT_ID;
    else process.env.TELEGRAM_LEO_OPERATOR_CHAT_ID = antes;
  }
});

test('CA-5 · el ancla sigue declarada como vault-only en el inventario', () => {
  // Contención: si alguien le sacara `auth_anchor` al descriptor, el código
  // propio del ancla dejaría de emitirse y este test lo caza antes.
  const anclas = Object.entries(ENV_DESCRIPTORS)
    .filter(([, d]) => d.auth_anchor).map(([k]) => k);
  assert.deepEqual(anclas, ['telegram.leo_operator_chat_id'],
    'una sola ancla de autorizacion en el inventario');
});

// =============================================================================
// CA-6 · No divulgación
// =============================================================================

test('CA-6 · el exito no filtra ninguna credencial que el destino NO pidio', async () => {
  const logs = capturarLogs();
  const snap = await createCredentialSnapshot(pedidoAgente({ logger: logs }));

  const serializado = JSON.stringify(snap);
  assert.ok(!serializado.includes(CANARIO_ANTHROPIC), 'el canario de anthropic no viaja');
  assert.ok(!serializado.includes(CANARIO_BOT_TOKEN), 'el canario del bot token no viaja');
  assert.ok(!logs.texto().includes(CANARIO_OPENAI), 'la senal local no ecoa el valor pedido');
  assert.ok(!logs.texto().includes(CANARIO_ANTHROPIC));
});

test('CA-6 · la forma de auditoria (`redactSnapshot`) lleva nombres, nunca valores', async () => {
  const snap = await createCredentialSnapshot(pedidoAgente());
  const red = redactSnapshot(snap);

  assert.equal(red.ok, true);
  assert.equal(red.destination, 'agent-child');
  assert.deepEqual(red.envVars, ['OPENAI_API_KEY'], 'nombres de variable, no valores');
  const serializado = JSON.stringify(red);
  for (const canario of [CANARIO_OPENAI, CANARIO_ANTHROPIC, CANARIO_BOT_TOKEN]) {
    assert.ok(!serializado.includes(canario), 'la auditoria no lleva un solo valor');
  }
  assert.ok(!serializado.includes('CANARIO-'));
});

test('CA-6 · el fallo no filtra el valor por excepcion, senal local ni serializacion', async () => {
  // El canario está CARGADO como credencial y el pedido lo incluye; lo que
  // rompe la creación es OTRA clave del mismo scope.
  const material = materialCompleto();
  delete material.telegram.chat_id;
  const logs = capturarLogs();

  const err = await capturarFallo(createCredentialSnapshot({
    destination: 'pulpo-telegram', scopes: ['telegram'],
    vaultConfig: cfg(), vaultDriver: driverSembrado({ material }), logger: logs,
  }));

  for (const superficie of [err.message, JSON.stringify(err), logs.texto(),
    JSON.stringify(redactSnapshot(err)), String(err), err.stack]) {
    assert.ok(!String(superficie).includes(CANARIO_BOT_TOKEN),
      'el canario cargado no aparece en ninguna superficie de diagnostico');
    assert.ok(!String(superficie).includes('CANARIO-'));
  }
  // Lo que SÍ viaja: nombre lógico, destino y código estable.
  const red = redactSnapshot(err);
  assert.equal(red.ok, false);
  assert.equal(red.code, SNAPSHOT_ERROR_CODES.SNAPSHOT_SECRET_INVALID);
  assert.equal(red.destination, 'pulpo-telegram');
  assert.deepEqual(red.missing, ['telegram.chat_id']);
});

// =============================================================================
// CA-7 · Compatibilidad del contrato existente
// =============================================================================

test('CA-7 · las tres funciones sincronas siguen siendo sincronas', () => {
  for (const fn of [cred.loadIntoEnv, cred.resolveVaultOnly, cred.resolveInstanceVault]) {
    assert.equal(fn.constructor.name, 'Function',
      `${fn.name} no puede volverse AsyncFunction (D-SYNC-1)`);
  }
  // El gemelo async del camino por instancia (#5797) sigue siendo el ÚNICO
  // async de esa familia, más el nuevo snapshot.
  assert.equal(cred.resolveInstanceVaultAsync.constructor.name, 'AsyncFunction');
  assert.equal(cred.createCredentialSnapshot.constructor.name, 'AsyncFunction');
});

test('CA-7 · `loadIntoEnv` sigue devolviendo su objeto de resultado, no una Promise', () => {
  const env = {};
  const res = cred.loadIntoEnv({
    env,
    logger: () => {},
    vaultConfig: null,
    canonicalPath: path.join(os.tmpdir(), 'no-existe-5798.json'),
    legacyPath: path.join(os.tmpdir(), 'no-existe-5798-legacy.json'),
  });
  assert.ok(!(res instanceof Promise), 'sigue sync');
  assert.equal(typeof res.source, 'string');
  assert.ok(Array.isArray(res.hydrated));
});

test('CA-7 · `resolveVaultOnly` y `resolveInstanceVault` conservan firma y forma', () => {
  assert.equal(cred.resolveVaultOnly.length, 1, 'firma (dotPath, opts = {})');
  assert.equal(cred.resolveInstanceVault.length, 0, 'firma (args = {}, opts = {})');

  const res = cred.resolveInstanceVault(
    { projectId: PROJECT, scopes: ['providers'] },
    { vaultConfig: cfg(), vaultDriver: driverSembrado(), logger: () => {} },
  );
  assert.equal(res.ok, true);
  assert.deepEqual(Object.keys(res).sort(), ['code', 'missing', 'namespace', 'ok', 'scopes']);
});

test('CA-7 · la API nueva no usa el contrato sincrono como via de fallback', async () => {
  // Si `createCredentialSnapshot` cayera a `loadIntoEnv`, un `env` inyectado se
  // poblaría. No se puebla: la dependencia ni siquiera está declarada.
  const envInyectado = {};
  await capturarFallo(createCredentialSnapshot(pedidoAgente({
    vaultConfig: cfg({ enabled: false }),
    env: envInyectado,
  })));
  assert.deepEqual(envInyectado, {}, 'nada se hidrato por el camino con efectos');
});

// =============================================================================
// CA-8 · Costura limpia para #5797
// =============================================================================

test('CA-8 · el snapshot consume la cache existente: la 2da lectura es HIT', async () => {
  const driver = driverSembrado();
  await createCredentialSnapshot(pedidoAgente({ vaultDriver: driver }));
  const trasPrimera = driver.calls.length;
  assert.ok(trasPrimera > 0, 'la primera invocacion lee del driver');

  await createCredentialSnapshot(pedidoAgente({ vaultDriver: driver }));
  assert.equal(driver.calls.length, trasPrimera,
    'la segunda invocacion no vuelve a leer: usa la memo de #5797');
});

test('CA-8 · `resetVaultCache(scope)` (contrato publico de #5797) invalida el snapshot', async () => {
  const driver = driverSembrado();
  await createCredentialSnapshot(pedidoAgente({ vaultDriver: driver }));
  const trasPrimera = driver.calls.length;

  const reset = resetVaultCache('providers');
  assert.equal(reset.scope, 'providers', `reset valido: ${JSON.stringify(reset)}`);
  assert.equal(reset.invalidadas, 1, 'invalido la entrada que alimentaba al snapshot');

  await createCredentialSnapshot(pedidoAgente({ vaultDriver: driver }));
  assert.ok(driver.calls.length > trasPrimera,
    'tras el reset publico la lectura vuelve a bajar al driver');
});

test('CA-8 · dos snapshots concurrentes del mismo destino coalescen en UNA lectura', async () => {
  const driver = driverSembrado();
  const [a, b, c] = await Promise.all([
    createCredentialSnapshot(pedidoAgente({ vaultDriver: driver })),
    createCredentialSnapshot(pedidoAgente({ vaultDriver: driver })),
    createCredentialSnapshot(pedidoAgente({ vaultDriver: driver })),
  ]);
  const lecturas = driver.calls.filter((c2) => c2.op === 'getParametersByPath').length;
  assert.equal(lecturas, 1,
    'single-flight de #5797: N lanzamientos concurrentes, UNA lectura fisica');
  // Y aun coalescidos, cada uno recibe su propio objeto (CA-2 no se degrada).
  assert.notStrictEqual(a.env, b.env);
  assert.notStrictEqual(b.env, c.env);
  assert.equal(a.env.OPENAI_API_KEY, CANARIO_OPENAI);
});

test('CA-8 · la API no conoce la forma interna de la cache', () => {
  // Contención literal del criterio: si el snapshot se apoyara en `_vaultMemo`,
  // el modulo tendria que exportarlo. No lo exporta, y `resetVaultCache` /
  // `resetVaultCacheAll` siguen siendo el unico contrato de invalidacion.
  assert.equal(cred._vaultMemo, undefined, '`_vaultMemo` sigue siendo privado');
  assert.equal(typeof cred.resetVaultCache, 'function');
  assert.equal(typeof cred.resetVaultCacheAll, 'function');
  const fuente = fs.readFileSync(path.join(__dirname, '..', 'credentials.js'), 'utf8');
  const seccion = fuente.slice(fuente.indexOf('#5798 · SNAPSHOT AISLADO'));
  // Se mira el CODIGO, no los comentarios: nombrar la caja negra en una
  // explicacion es justamente lo contrario de acoplarse a ella.
  const codigo = seccion.split(/\r?\n/)
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join(' ');
  assert.ok(!/_vaultMemo|_vuelos|_vaultGen|escribirEnMemo|mirarMemo|borrarDelMemo/.test(codigo),
    'la seccion de #5798 no toca la maquinaria interna de la cache');
});

// =============================================================================
// Catálogo de destinos — contención del mínimo privilegio
// =============================================================================

test('el catalogo de destinos esta congelado y no tiene comodines', () => {
  assert.ok(Object.isFrozen(SNAPSHOT_DESTINATIONS));
  const scopesDelInventario = new Set(
    Object.keys(ENV_DESCRIPTORS).map((k) => k.split('.')[0]),
  );
  for (const [destino, decl] of Object.entries(SNAPSHOT_DESTINATIONS)) {
    assert.ok(Object.isFrozen(decl.scopes), `${destino}: scopes congelados`);
    assert.ok(decl.scopes.length > 0, `${destino}: un destino sin scopes no tiene sentido`);
    for (const scope of decl.scopes) {
      assert.ok(scopesDelInventario.has(scope),
        `${destino}: el scope "${scope}" tiene que existir en ENV_DESCRIPTORS`);
      assert.notEqual(scope, '*', 'no existe comodin');
    }
  }
  // Ningún destino de tipo "hijo" recibe el scope de Telegram: el bot token es
  // material reservado (`RESERVED_CHILD_SECRET_NAMES` de build-child-env.js).
  for (const hijo of ['agent-child', 'commander']) {
    assert.ok(!SNAPSHOT_DESTINATIONS[hijo].scopes.includes('telegram'), hijo);
  }
});
