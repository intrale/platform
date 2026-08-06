// =============================================================================
// Tests de la integración del vault en credentials.js (#5353 — split 3/3 de #5338)
// node --test  (entra por el glob existente de `npm run test:pipeline`)
// =============================================================================
//
// Cobertura, por CA:
//   B1.1–B1.8  semántica de la ventana de bootstrap y del fail-closed
//   B2.1–B2.6  precedencia de las anclas de autorización
//   B3-A.1/.3  namespace desde config y `hostId` inválido nombrado
//   D-SYNC-1/7/8  sync, memoización por namespace, gate cerrado
//   UX-2/UX-3/UX-6  origen por variable, dry-run legible, contrato de QA
//   SEC-2      los hijos no ganan el scope `aws` para hablar con el vault
//   Gherkin 1/2/3 de #5338, con el 1 reescrito según B1.8
//
// Ningún test toca red, AWS ni `process.env` real: el driver se inyecta y el
// ambiente destino es siempre un objeto scratch.
// =============================================================================
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const credentials = require('../credentials');
const {
  loadIntoEnv,
  ENV_MAPPING,
  ENV_DESCRIPTORS,
  VAULT_BACKENDS,
  SOURCE,
  vaultScopePlan,
  _resetVaultCache,
  _readVaultConfig,
  resolveVaultOnly,
  VAULT_ONLY_ERROR_CODES,
} = credentials;
const { buildParameterPath, createInMemoryVaultDriver } = require('../secret-vault');
const { resolveOperatorAllowlist } = require('../operator-gate');

// -----------------------------------------------------------------------------
// #5217 · CA-6 — el inventario y lo que se hidrata dejaron de ser el mismo set
// -----------------------------------------------------------------------------
//
// Hasta #5217, `ENV_DESCRIPTORS` y `ENV_MAPPING` tenían las mismas 13 claves y
// los asserts de abajo hardcodeaban ese 13. Ahora las 4 de `google_drive` están
// en el inventario del vault (se provisionan, se rotan, la política IAM las
// cubre) pero NO se inyectan en el `process.env` global: su único consumidor
// las resuelve bajo demanda por namespace.
//
// Los conteos se DERIVAN para que sumar un secreto al inventario no obligue a
// tocar ocho asserts — que es exactamente cómo un número mágico se convierte en
// un test que se actualiza sin leerlo.
const HIDRATADAS = Object.keys(ENV_MAPPING).length;
const NO_HIDRATADAS = Object.keys(ENV_DESCRIPTORS).length - HIDRATADAS;
const NO_ANCLA = HIDRATADAS - 1;

test('CA-6 (#5217) · las credenciales de Drive estan en el inventario pero NO se hidratan', () => {
  const drive = Object.keys(ENV_DESCRIPTORS).filter((k) => k.startsWith('google_drive.'));
  assert.equal(drive.length, 4, 'las 4 siguen en el inventario del vault');
  assert.equal(NO_HIDRATADAS, 4, 'y son exactamente las que no se hidratan');

  for (const dotPath of drive) {
    assert.equal(ENV_DESCRIPTORS[dotPath].hydrate, false, `${dotPath} deberia declarar hydrate:false`);
    assert.equal(ENV_MAPPING[dotPath], undefined, `${dotPath} NO puede estar en ENV_MAPPING`);
  }

  // El inventario del vault no se toca: la tabla firmada de #5351 y la política
  // IAM siguen valiendo, incluido el único ocupante de Secrets Manager.
  assert.deepEqual(vaultScopePlan(ENV_DESCRIPTORS), {
    ssm: ['telegram', 'providers', 'google_drive'],
    secretsmanager: ['google_drive'],
  });
});

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

const PREFIX = '/intrale';
const PROJECT = 'intrale';
const HOST = 'hostTest';

const ANCLA_DOTPATH = 'telegram.leo_operator_chat_id';
const ANCLA_ENV = ENV_MAPPING[ANCLA_DOTPATH];
const CHAT_ID_DEL_VAULT = '111222333';

function configVault(over = {}) {
  return {
    enabled: true,
    prefix: PREFIX,
    projectId: PROJECT,
    hostId: HOST,
    cache_ttl_seconds: 300,
    required_scopes: ['telegram', 'providers', 'google_drive'],
    shared_secrets: ['telegram', 'providers', 'google_drive'],
    bootstrap_fallback: false,
    bootstrap_fallback_until: '',
    region: 'us-east-2',
    ...over,
  };
}

function rutaScope(scope, tier = 'shared') {
  return buildParameterPath({ prefix: PREFIX, projectId: PROJECT, hostId: HOST, scope, tier });
}

/**
 * Namespace completo: los 13 valores del descriptor repartidos por scope y
 * backend, tal como los provisionaría #5338.
 */
function seedCompleto({ conAncla = true } = {}) {
  const telegram = { bot_token: 'VAULT-BOT', chat_id: '42' };
  if (conAncla) telegram.leo_operator_chat_id = CHAT_ID_DEL_VAULT;
  return {
    parameters: {
      [rutaScope('telegram')]: telegram,
      [rutaScope('providers')]: {
        openai: { api_key: 'VAULT-OPENAI' },
        anthropic: { api_key: 'VAULT-ANTHROPIC' },
        google: { api_key: 'VAULT-GEMINI' },
        cerebras: { api_key: 'VAULT-CEREBRAS' },
        nvidia: { api_key: 'VAULT-NVIDIA' },
        moonshot: { api_key: 'VAULT-MOONSHOT' },
      },
      [rutaScope('google_drive')]: {
        oauth_client_id: 'VAULT-GD-ID',
        oauth_client_secret: 'VAULT-GD-SECRET',
        drive_folder_id: 'VAULT-GD-FOLDER',
      },
    },
    secrets: {
      [buildParameterPath({ prefix: PREFIX, projectId: PROJECT, scope: 'google_drive', tier: 'rotating' })]:
        { oauth_refresh_token: 'VAULT-GD-REFRESH' },
    },
  };
}

/** Driver in-memory con contador de invocaciones. */
function driverConSeed(seed = seedCompleto()) {
  return createInMemoryVaultDriver(seed);
}

/** Driver que siempre deniega (simula AccessDenied de IAM). */
function driverQueDeniega(mensaje = 'AccessDenied: no identity-based policy allows ssm:GetParametersByPath') {
  const calls = [];
  const explotar = () => {
    calls.push({ op: 'deny' });
    const err = new Error(mensaje);
    err.name = 'VaultCliError';
    err.code = 'VAULT_CLI';
    throw err;
  };
  return {
    kind: 'deniega',
    calls,
    getParametersByPathSync: explotar,
    getSecretValueSync: explotar,
    async getParametersByPath() { return explotar(); },
    async getSecretValue() { return explotar(); },
  };
}

/** Directorio temporal FUERA del árbol del repo, con archivos de credenciales. */
function conArchivosTmp(fn, { canonical = null, legacy = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cred-vault-5353-'));
  const canonicalPath = path.join(dir, 'credentials.json');
  const legacyPath = path.join(dir, 'telegram-config.json');
  if (canonical) fs.writeFileSync(canonicalPath, JSON.stringify(canonical, null, 2));
  if (legacy) fs.writeFileSync(legacyPath, JSON.stringify(legacy, null, 2));
  try { return fn({ canonicalPath, legacyPath, dir }); }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

/** Paths inexistentes (fuera del repo) para los casos "sin ningún archivo". */
function sinArchivos() {
  const dir = path.join(os.tmpdir(), 'cred-vault-5353-inexistente');
  return {
    canonicalPath: path.join(dir, 'credentials.json'),
    legacyPath: path.join(dir, 'telegram-config.json'),
  };
}

function capturarLogs() {
  const lineas = [];
  const logger = (m) => lineas.push(String(m));
  logger.lineas = lineas;
  logger.texto = () => lineas.join('\n');
  return logger;
}

/** Envoltorio: siempre invalida la memoización de módulo antes de correr. */
function cargar(opts) {
  _resetVaultCache();
  return loadIntoEnv(opts);
}

function resolverSolo(dotPath, opts) {
  _resetVaultCache();
  return resolveVaultOnly(dotPath, opts);
}

test('vault-only resuelve las dos claves lógicas sin hidratar ambiente', () => {
  const envHostil = { TELEGRAM_BOT_TOKEN: 'HOSTILE-NOT-A-SECRET' };
  const opts = { vaultConfig: configVault(), vaultDriver: driverConSeed(), logger: () => {}, env: envHostil };
  assert.equal(resolverSolo('telegram.bot_token', opts), 'VAULT-BOT');
  assert.equal(resolverSolo('telegram.leo_operator_chat_id', opts), CHAT_ID_DEL_VAULT);
  assert.deepEqual(envHostil, { TELEGRAM_BOT_TOKEN: 'HOSTILE-NOT-A-SECRET' });
});

test('vault-only distingue gate ausente, fallo y valor inválido', () => {
  const casos = [
    [{ vaultConfig: null }, VAULT_ONLY_ERROR_CODES.VAULT_DISABLED],
    [{ vaultConfig: configVault(), vaultDriver: driverQueDeniega() }, VAULT_ONLY_ERROR_CODES.VAULT_FAILURE],
    [{ vaultConfig: configVault(), vaultDriver: driverConSeed(seedCompleto({ conAncla: false })) }, VAULT_ONLY_ERROR_CODES.VAULT_SECRET_INVALID],
  ];
  for (const [opts, code] of casos) {
    const logs = capturarLogs();
    assert.throws(() => resolverSolo('telegram.leo_operator_chat_id', { ...opts, logger: logs }), (error) => {
      assert.equal(error.code, code);
      assert.equal(error.logicalKey, 'telegram.leo_operator_chat_id');
      assert.doesNotMatch(error.message, /AccessDenied|hostTest|us-east/);
      return true;
    });
    assert.match(logs.texto(), new RegExp(code));
    assert.doesNotMatch(logs.texto(), /AccessDenied|hostTest|us-east/);
  }
});

test('vault-only distingue configuración indeterminada sin exponer el path físico', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-only-config-rota-'));
  const pipelineDir = path.join(dir, '.pipeline');
  fs.mkdirSync(pipelineDir);
  fs.writeFileSync(path.join(pipelineDir, 'config.yaml'), 'vault: [config inválida');
  const logs = capturarLogs();
  try {
    assert.throws(() => resolverSolo('telegram.bot_token', { pipelineDir, logger: logs }), (error) => {
      assert.equal(error.code, VAULT_ONLY_ERROR_CODES.VAULT_CONFIG_INDETERMINATE);
      assert.doesNotMatch(error.message, new RegExp(dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      return true;
    });
    assert.equal(logs.texto(), '[credentials] VAULT_CONFIG_INDETERMINATE: operacion segura no ejecutada para telegram.bot_token');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('vault-only rechaza vacío y placeholder sin usar fallback legacy', () => {
  for (const bot_token of ['', 'CHANGE_ME']) {
    const seed = seedCompleto();
    seed.parameters[rutaScope('telegram')].bot_token = bot_token;
    assert.throws(() => resolverSolo('telegram.bot_token', {
      vaultConfig: configVault({ bootstrap_fallback: true, bootstrap_fallback_until: '2099-01-01T00:00:00Z' }),
      vaultDriver: driverConSeed(seed),
      canonicalPath: 'fallback-que-no-debe-leerse.json',
      logger: () => {},
    }), (error) => error.code === VAULT_ONLY_ERROR_CODES.VAULT_SECRET_INVALID);
  }
});

test('vault-only no refleja una clave arbitraria en error ni señal local', () => {
  const logs = capturarLogs();
  assert.throws(() => resolverSolo('valor-hostil-no-declarado', { logger: logs }), (error) => {
    assert.equal(error.code, VAULT_ONLY_ERROR_CODES.VAULT_KEY_UNKNOWN);
    assert.equal(error.logicalKey, 'clave-no-declarada');
    assert.doesNotMatch(error.message, /valor-hostil/);
    return true;
  });
  assert.doesNotMatch(logs.texto(), /valor-hostil/);
});

// =============================================================================
// Retrocompat del descriptor (G1) y superficie de exports
// =============================================================================

test('ENV_MAPPING sigue siendo el mapa plano dotPath -> envVar tras introducir el descriptor', () => {
  assert.equal(typeof ENV_MAPPING, 'object');
  assert.ok(Object.isFrozen(ENV_MAPPING), 'sigue congelado');
  assert.equal(Object.keys(ENV_MAPPING).length, HIDRATADAS,
    'solo las que se hidratan: el inventario completo es ENV_DESCRIPTORS (CA-6 de #5217)');

  // Plano de verdad: `Object.entries` devuelve strings, no descriptores. Es lo
  // que rompería `listProviders()` (wizards/providers/index.js:73) en silencio.
  for (const [dotPath, envVar] of Object.entries(ENV_MAPPING)) {
    assert.equal(typeof envVar, 'string', `${dotPath} no es string`);
    assert.equal(envVar, ENV_DESCRIPTORS[dotPath].env, `${dotPath} no deriva del descriptor`);
  }

  // Ni `Proxy` ni getter lazy: los consumidores lo recorren directo.
  for (const dotPath of Object.keys(ENV_MAPPING)) {
    const d = Object.getOwnPropertyDescriptor(ENV_MAPPING, dotPath);
    assert.equal(typeof d.get, 'undefined', `${dotPath} está detrás de un getter`);
    assert.equal(d.enumerable, true);
  }
  // Deriva del descriptor, pero SOLO de la parte hidratable (CA-6 de #5217):
  // el inventario completo incluye claves que a propósito no llegan al env.
  assert.deepEqual(Object.values(ENV_MAPPING).sort(),
    Object.values(ENV_DESCRIPTORS).filter(credentials.seHidrata).map((d) => d.env).sort());
});

test('los 10 simbolos historicos siguen exportados y loadIntoEnv sigue sync (D-SYNC-1)', () => {
  for (const simbolo of ['loadIntoEnv', 'CANONICAL_PATH', 'LEGACY_PATH', 'ENV_MAPPING',
    'LEGACY_MAPPING', 'isPlaceholderOrEmpty', 'getNested', 'parseSecretRef',
    'resolveScopedRefs', 'redactScoped']) {
    assert.ok(simbolo in credentials, `falta el export histórico ${simbolo}`);
  }
  assert.equal(loadIntoEnv.constructor.name, 'Function');
  const r = cargar({ ...sinArchivos(), env: {}, logger: () => {}, vaultConfig: null });
  assert.equal(typeof r.then, 'undefined', 'el retorno no puede ser thenable');
});

test('todo descriptor declara backend valido, env, shared y auth_anchor', () => {
  for (const [dotPath, d] of Object.entries(ENV_DESCRIPTORS)) {
    assert.ok(VAULT_BACKENDS.includes(d.backend), `${dotPath}: backend inválido "${d.backend}"`);
    assert.equal(typeof d.env, 'string');
    assert.equal(typeof d.shared, 'boolean');
    assert.equal(typeof d.auth_anchor, 'boolean');
  }
  // El plan de scopes agrupa por backend y no pide una llamada por variable.
  assert.deepEqual(vaultScopePlan(), {
    ssm: ['telegram', 'providers', 'google_drive'],
    secretsmanager: ['google_drive'],
  });
  // `file-only` es un backend soportado: quien lo declare no va al vault.
  assert.deepEqual(
    vaultScopePlan({ 'x.y': { env: 'X', backend: 'file-only', shared: true, auth_anchor: false } }),
    { ssm: [], secretsmanager: [] },
  );
});

test('B2.1 · el inventario de anclas de autorizacion es exactamente una', () => {
  const anclas = Object.entries(ENV_DESCRIPTORS)
    .filter(([, d]) => d.auth_anchor)
    .map(([dotPath]) => dotPath);

  // Este test rompe A PROPÓSITO si alguien agrega un ancla nueva: cambiar la
  // precedencia de una variable que decide autorización no puede pasar sin que
  // alguien lo mire.
  assert.deepEqual(anclas, [ANCLA_DOTPATH]);
  assert.equal(ENV_DESCRIPTORS[ANCLA_DOTPATH].env, 'TELEGRAM_LEO_OPERATOR_CHAT_ID');
});

// =============================================================================
// D-SYNC-8 — gate cerrado: comportamiento IDÉNTICO al de antes de #5353
// =============================================================================

test('D-SYNC-8 · con vault.enabled false el driver no se invoca ni una vez y el resultado es identico al actual', () => {
  const driver = driverConSeed();
  conArchivosTmp(({ canonicalPath, legacyPath }) => {
    const env = {};
    const r = cargar({
      canonicalPath, legacyPath, env, logger: () => {},
      vaultConfig: configVault({ enabled: false }), vaultDriver: driver,
    });

    assert.equal(driver.calls.length, 0, 'ni una invocación al driver');
    assert.equal(r.source, 'canonical');
    assert.equal(r.vault.enabled, false);
    assert.deepEqual(r.missing, []);
    assert.equal(env.TELEGRAM_BOT_TOKEN, 'ARCHIVO-BOT', 'el valor sale del archivo, no del vault');
    assert.deepEqual(r.hydrated.sort(), ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID'].sort());
    // Las arrays históricas no cambian de forma.
    for (const k of ['hydrated', 'skipped_existing', 'skipped_empty']) {
      assert.ok(Array.isArray(r[k]));
      for (const v of r[k]) assert.equal(typeof v, 'string');
    }
  }, { canonical: { telegram: { bot_token: 'ARCHIVO-BOT', chat_id: '42' } } });
});

test('D-SYNC-8 · con la config del vault ausente tampoco se toca el driver', () => {
  const driver = driverConSeed();
  const r = cargar({
    ...sinArchivos(), env: {}, logger: () => {}, vaultConfig: null, vaultDriver: driver,
  });
  assert.equal(driver.calls.length, 0);
  assert.equal(r.source, 'none');
  assert.equal(r.vault.enabled, false);
});

// =============================================================================
// Escenarios Gherkin de #5338
// =============================================================================

test('Gherkin 1 · en configuracion por defecto el arranque no depende de ningun archivo, dentro ni fuera del repo', () => {
  // B1.8 — redacción vigente: la ventana de bootstrap es una excepción
  // explícita, flagueada y caducable; el default es "vault y nada más".
  const env = {};
  const driver = driverConSeed();
  const r = cargar({
    ...sinArchivos(), env, logger: () => {},
    vaultConfig: configVault(), vaultDriver: driver,
  });

  assert.equal(r.vault.enabled, true);
  assert.equal(r.source, SOURCE.VAULT);
  assert.equal(r.hydrated.length, HIDRATADAS, 'las hidratables salieron del vault, sin ningún archivo');
  assert.deepEqual(r.missing, []);
  for (const envVar of Object.values(ENV_MAPPING)) {
    assert.equal(r.sources[envVar], SOURCE.VAULT, `${envVar} no vino del vault`);
  }
  assert.equal(env.TELEGRAM_BOT_TOKEN, 'VAULT-BOT');
  // #5217 · CA-6: el tier rotating SE LEE del vault (el plan de scopes lo sigue
  // incluyendo), pero su valor NO se escribe en el ambiente. Se verifica contra
  // el driver, no contra `env`: comprobarlo por la hidratación era justamente lo
  // que ataba el camino de Secrets Manager al `process.env` global.
  assert.equal(env.GOOGLE_OAUTH_REFRESH_TOKEN, undefined,
    'el refresh token de Drive no se hidrata: lo resuelve su consumidor bajo demanda');
  assert.ok(
    driver.calls.some((c) => JSON.stringify(c).includes('rotating')),
    'el tier rotating igual se consultó al vault',
  );
});

test('Gherkin 2 · acceso cruzado denegado se propaga como fallo, jamas como valor vacio', () => {
  const env = {};
  const driver = driverQueDeniega();
  const logger = capturarLogs();

  conArchivosTmp(({ canonicalPath, legacyPath }) => {
    const r = cargar({
      canonicalPath, legacyPath, env, logger,
      vaultConfig: configVault(), vaultDriver: driver,
    });

    assert.ok(driver.calls.length > 0, 'se intentó leer');
    assert.equal(r.vault.error.code, 'VAULT_CLI');
    assert.equal(r.missing.length, HIDRATADAS, 'las hidratables quedan fail-closed');
    assert.equal(r.hydrated.length, 0);
    // CA-22 / B1.2 — el fallo NO degrada al archivo, aunque el archivo exista y
    // tenga los valores. La denegación queda registrada.
    assert.equal(env.TELEGRAM_BOT_TOKEN, undefined, 'ni cadena vacía ni valor del archivo');
    assert.ok(!('TELEGRAM_BOT_TOKEN' in env), 'la var queda SIN SETEAR, no en ""');
    assert.match(logger.texto(), /el vault no pudo resolverse/);
    assert.match(logger.texto(), /NO se cae al archivo/);
  }, { canonical: { telegram: { bot_token: 'ARCHIVO-BOT' } } });
});

test('Gherkin 3 · secreto faltante falla cerrado nombrando el secreto, sin valor vacio ni default', () => {
  const env = {};
  const logger = capturarLogs();
  // El scope `providers` existe pero le falta la entrada de openai.
  const seed = seedCompleto();
  delete seed.parameters[rutaScope('providers')].openai;

  const r = cargar({
    ...sinArchivos(), env, logger,
    vaultConfig: configVault(), vaultDriver: driverConSeed(seed),
  });

  assert.deepEqual(r.missing, ['OPENAI_API_KEY']);
  assert.equal(r.sources.OPENAI_API_KEY, SOURCE.MISSING);
  assert.ok(!('OPENAI_API_KEY' in env), 'sin setear: ni "" ni un default');
  assert.match(logger.texto(), /falta el secreto "providers\/openai\/api_key"/,
    'el error nombra el path lógico del secreto');
  assert.match(logger.texto(), /Proximo paso/, 'UX-1: nombra la remediación');
  // SEC-5 — el mensaje no filtra valores del vault.
  assert.ok(!logger.texto().includes('VAULT-ANTHROPIC'));
  // Y el resto sí se hidrató: el fail-closed es por variable, no global.
  assert.equal(env.ANTHROPIC_API_KEY, 'VAULT-ANTHROPIC');
});

// =============================================================================
// D-SYNC-7 — memoización por namespace
// =============================================================================

test('D-SYNC-7 · N llamadas consecutivas pagan una sola resolucion del vault', () => {
  const driver = driverConSeed();
  const base = {
    ...sinArchivos(), logger: () => {},
    vaultConfig: configVault(), vaultDriver: driver,
  };

  _resetVaultCache();
  loadIntoEnv({ ...base, env: {} });
  const trasLaPrimera = driver.calls.length;
  assert.ok(trasLaPrimera > 0);

  // `cerebras-runner.js:96` y `nvidia-nim-runner.js:90` llaman a esto POR
  // LANZAMIENTO DE AGENTE: sin memoización cada launch pagaría la AWS CLI.
  for (let i = 0; i < 5; i += 1) loadIntoEnv({ ...base, env: {} });
  assert.equal(driver.calls.length, trasLaPrimera, '5 llamadas más, cero invocaciones más');

  // Presupuesto: una batch por tier de SSM (SEC-3) + una por scope rotating.
  assert.ok(trasLaPrimera <= 3, `presupuesto excedido: ${trasLaPrimera} invocaciones`);
});

test('D-SYNC-7 · la memoizacion tiene TTL: vencido, se vuelve a resolver', () => {
  const driver = driverConSeed();
  let ahora = 1_000_000;
  const base = {
    ...sinArchivos(), logger: () => {}, env: {},
    vaultConfig: configVault({ cache_ttl_seconds: 60 }), vaultDriver: driver,
    now: () => ahora,
  };

  _resetVaultCache();
  loadIntoEnv({ ...base, env: {} });
  const trasLaPrimera = driver.calls.length;

  ahora += 59_000;
  loadIntoEnv({ ...base, env: {} });
  assert.equal(driver.calls.length, trasLaPrimera, 'dentro del TTL sale de la memo');

  // Sin TTL, revocar un secreto en el vault no surtiría efecto hasta el
  // restart — y para el ancla eso es seguir aceptando a un firmante removido.
  ahora += 2_000;
  loadIntoEnv({ ...base, env: {} });
  assert.ok(driver.calls.length > trasLaPrimera, 'vencido el TTL vuelve a leer');
});

test('D-SYNC-7 · un fallo del vault NO se memoiza (se puede recuperar sin reiniciar)', () => {
  const driver = driverQueDeniega();
  const base = {
    ...sinArchivos(), logger: () => {}, vaultConfig: configVault(), vaultDriver: driver,
  };
  _resetVaultCache();
  loadIntoEnv({ ...base, env: {} });
  const tras1 = driver.calls.length;
  loadIntoEnv({ ...base, env: {} });
  assert.ok(driver.calls.length > tras1, 'el fallo se reintenta: `aws login` surte efecto sin restart');
});

// =============================================================================
// B1 — la ventana de bootstrap
// =============================================================================

test('B1.3 · sin el flag no hay fallback: lo que falta en el vault queda sin setear aunque este en el archivo', () => {
  const env = {};
  const seed = seedCompleto();
  delete seed.parameters[rutaScope('providers')].cerebras;

  conArchivosTmp(({ canonicalPath, legacyPath }) => {
    const r = cargar({
      canonicalPath, legacyPath, env, logger: () => {},
      vaultConfig: configVault(), vaultDriver: driverConSeed(seed),
    });
    assert.deepEqual(r.missing, ['CEREBRAS_API_KEY']);
    assert.ok(!('CEREBRAS_API_KEY' in env), 'el archivo lo tenía y NO se usó');
  }, { canonical: { providers: { cerebras: { api_key: 'ARCHIVO-CEREBRAS' } } } });
});

test('B1.5/B1.6 · con la ventana ACTIVA el valor sale del archivo, con WARN y source file-bootstrap', () => {
  const env = {};
  const logger = capturarLogs();
  const seed = seedCompleto();
  delete seed.parameters[rutaScope('providers')].cerebras;
  const ahora = Date.parse('2026-08-01T00:00:00Z');

  conArchivosTmp(({ canonicalPath, legacyPath }) => {
    const r = cargar({
      canonicalPath, legacyPath, env, logger, now: () => ahora,
      vaultConfig: configVault({
        bootstrap_fallback: true,
        bootstrap_fallback_until: '2026-09-01T00:00:00Z',
      }),
      vaultDriver: driverConSeed(seed),
    });

    assert.equal(env.CEREBRAS_API_KEY, 'ARCHIVO-CEREBRAS');
    assert.equal(r.sources.CEREBRAS_API_KEY, SOURCE.FILE_BOOTSTRAP,
      'B1.6: el source del fallback NUNCA es `vault`');
    assert.deepEqual(r.missing, []);
    // El resto sigue viniendo del vault.
    assert.equal(r.sources.ANTHROPIC_API_KEY, SOURCE.VAULT);
    // UX-4 — avisa mientras está activa, nombrando la variable y jamás el valor.
    assert.match(logger.texto(), /ventana de bootstrap del vault ACTIVA hasta 2026-09-01/);
    assert.match(logger.texto(), /CEREBRAS_API_KEY se resolvio por la ventana de bootstrap/);
    assert.ok(!logger.texto().includes('ARCHIVO-CEREBRAS'), 'el valor nunca se loguea');
  }, { canonical: { providers: { cerebras: { api_key: 'ARCHIVO-CEREBRAS' } } } });
});

test('B1.5 · la ventana caducada no se aplica aunque el flag siga en true', () => {
  const seed = seedCompleto();
  delete seed.parameters[rutaScope('providers')].cerebras;
  const cfg = configVault({
    bootstrap_fallback: true,
    bootstrap_fallback_until: '2026-09-01T00:00:00Z',
  });

  conArchivosTmp(({ canonicalPath, legacyPath }) => {
    // Un día ANTES del vencimiento: aplica.
    const antes = {};
    cargar({
      canonicalPath, legacyPath, env: antes, logger: () => {},
      now: () => Date.parse('2026-08-31T00:00:00Z'),
      vaultConfig: cfg, vaultDriver: driverConSeed(seed),
    });
    assert.equal(antes.CEREBRAS_API_KEY, 'ARCHIVO-CEREBRAS');

    // Un día DESPUÉS: no aplica, con el mismo flag encendido.
    const despues = {};
    const logger = capturarLogs();
    const r = cargar({
      canonicalPath, legacyPath, env: despues, logger,
      now: () => Date.parse('2026-09-02T00:00:00Z'),
      vaultConfig: cfg, vaultDriver: driverConSeed(seed),
    });
    assert.ok(!('CEREBRAS_API_KEY' in despues), '"bootstrap temporal" no puede volverse permanente');
    assert.deepEqual(r.missing, ['CEREBRAS_API_KEY']);
    assert.match(logger.texto(), /ventana de bootstrap del vault CADUCO/);
  }, { canonical: { providers: { cerebras: { api_key: 'ARCHIVO-CEREBRAS' } } } });
});

test('B1.5 · el flag encendido sin fecha de caducidad NO abre la ventana', () => {
  const seed = seedCompleto();
  delete seed.parameters[rutaScope('providers')].cerebras;
  const logger = capturarLogs();

  conArchivosTmp(({ canonicalPath, legacyPath }) => {
    const env = {};
    const r = cargar({
      canonicalPath, legacyPath, env, logger,
      vaultConfig: configVault({ bootstrap_fallback: true, bootstrap_fallback_until: '' }),
      vaultDriver: driverConSeed(seed),
    });
    assert.deepEqual(r.missing, ['CEREBRAS_API_KEY']);
    assert.match(logger.texto(), /sin `vault.bootstrap_fallback_until`/);
  }, { canonical: { providers: { cerebras: { api_key: 'ARCHIVO-CEREBRAS' } } } });
});

test('B1.4 · un archivo DENTRO del arbol del repo rechaza la ventana aunque el flag este encendido', () => {
  const seed = seedCompleto();
  delete seed.parameters[rutaScope('providers')].cerebras;
  const logger = capturarLogs();
  const env = {};

  // Path dentro del repo: no hace falta que exista, la validación es del path.
  const dentro = path.join(__dirname, '..', '..', '_tmp', 'credentials-5353.json');
  const r = cargar({
    canonicalPath: dentro, legacyPath: dentro, env, logger,
    vaultConfig: configVault({
      bootstrap_fallback: true,
      bootstrap_fallback_until: '2099-01-01T00:00:00Z',
    }),
    vaultDriver: driverConSeed(seed),
  });

  assert.deepEqual(r.missing, ['CEREBRAS_API_KEY']);
  assert.match(logger.texto(), /DENTRO del arbol del repo/);
  assert.match(logger.texto(), /5218/, 'la razón nombra el guardrail que no se relaja');
});

test('B1.2 · un error del driver NUNCA habilita el fallback a archivo, ni con la ventana abierta', () => {
  const env = {};
  const logger = capturarLogs();

  conArchivosTmp(({ canonicalPath, legacyPath }) => {
    const r = cargar({
      canonicalPath, legacyPath, env, logger,
      vaultConfig: configVault({
        bootstrap_fallback: true,
        bootstrap_fallback_until: '2099-01-01T00:00:00Z',
      }),
      vaultDriver: driverQueDeniega('ExpiredToken: the security token included in the request is expired'),
    });

    // Un fallback disparado por error de red o de sesión es fail-open
    // disfrazado: cualquiera que degrade la red desactiva el control entero.
    assert.equal(r.missing.length, HIDRATADAS);
    assert.equal(r.hydrated.length, 0);
    assert.ok(!('TELEGRAM_BOT_TOKEN' in env));
    assert.ok(!logger.texto().includes('ventana de bootstrap del vault ACTIVA'),
      'la ventana ni siquiera se evalúa cuando el vault falló');
  }, { canonical: { telegram: { bot_token: 'ARCHIVO-BOT', chat_id: '42' } } });
});

test('B1.7 · la ventana de bootstrap nunca alcanza al ancla de autorizacion', () => {
  const env = {};
  const seed = seedCompleto({ conAncla: false });

  conArchivosTmp(({ canonicalPath, legacyPath }) => {
    const r = cargar({
      canonicalPath, legacyPath, env, logger: () => {},
      vaultConfig: configVault({
        bootstrap_fallback: true,
        bootstrap_fallback_until: '2099-01-01T00:00:00Z',
      }),
      vaultDriver: driverConSeed(seed),
    });

    assert.ok(r.missing.includes(ANCLA_ENV), 'el ancla queda fail-closed');
    assert.ok(!(ANCLA_ENV in env), 'aunque el archivo la tuviera y la ventana estuviera abierta');
    assert.equal(resolveOperatorAllowlist(env).size, 0);
  }, { canonical: { telegram: { leo_operator_chat_id: 'ARCHIVO-ANCLA' } } });
});

// =============================================================================
// B2 — anclas de autorización
// =============================================================================

test('B2.2/B2.3 · el ancla se resuelve solo desde el vault y el shadowing se loguea sin el valor', () => {
  const env = { [ANCLA_ENV]: '999999999' };   // valor preseteado en el ambiente
  const logger = capturarLogs();

  const r = cargar({
    ...sinArchivos(), env, logger,
    vaultConfig: configVault(), vaultDriver: driverConSeed(),
  });

  assert.equal(env[ANCLA_ENV], CHAT_ID_DEL_VAULT, 'el vault gana, sin excepción');
  assert.equal(r.sources[ANCLA_ENV], SOURCE.VAULT);
  assert.ok(!r.skipped_existing.includes(ANCLA_ENV), 'la rama skipped_existing se invierte para el ancla');
  assert.match(logger.texto(), new RegExp(`${ANCLA_ENV}.*SOBRESCRITA`));
  // Prohibido loguear el valor, un prefijo, un sufijo o un hash: el espacio de
  // valores de un chat_id es chico y un hash se revierte por fuerza bruta.
  assert.ok(!logger.texto().includes('999999999'), 'no se loguea el valor preexistente');
  assert.ok(!logger.texto().includes(CHAT_ID_DEL_VAULT), 'ni el del vault');
});

test('B2.3 · si el valor preexistente COINCIDE con el del vault no se emite warning de shadowing', () => {
  const env = { [ANCLA_ENV]: CHAT_ID_DEL_VAULT };
  const logger = capturarLogs();
  cargar({ ...sinArchivos(), env, logger, vaultConfig: configVault(), vaultDriver: driverConSeed() });
  assert.ok(!logger.texto().includes('SOBRESCRITA'));
});

test('B2.4/B2.5a · sin el ancla en el vault la var queda sin setear y la allowlist de firmantes es vacia', () => {
  const env = { [ANCLA_ENV]: '999999999' };
  const logger = capturarLogs();

  const r = cargar({
    ...sinArchivos(), env, logger,
    vaultConfig: configVault(), vaultDriver: driverConSeed(seedCompleto({ conAncla: false })),
  });

  assert.ok(r.missing.includes(ANCLA_ENV));
  assert.ok(!(ANCLA_ENV in env), 'el valor del ambiente se DESCARTA: si no, el shadowing seguiría vivo');
  assert.equal(resolveOperatorAllowlist(env).size, 0, 'fail-closed correcto del gate del operador');
  assert.match(logger.texto(), /falta el ancla de autorizacion "telegram\/leo_operator_chat_id"/);
});

test('B2.5a · con el ancla en el vault la allowlist de firmantes tiene exactamente un miembro', () => {
  const env = {};
  cargar({ ...sinArchivos(), env, logger: () => {}, vaultConfig: configVault(), vaultDriver: driverConSeed() });
  // Se reporta el TAMAÑO, jamás el contenido.
  assert.equal(resolveOperatorAllowlist(env).size, 1);
});

test('B2.6 · para las 12 no-ancla la precedencia de process.env NO cambia', () => {
  const env = {};
  for (const [dotPath, envVar] of Object.entries(ENV_MAPPING)) {
    if (dotPath !== ANCLA_DOTPATH) env[envVar] = `AMBIENTE-${envVar}`;
  }

  const r = cargar({
    ...sinArchivos(), env, logger: () => {}, vaultConfig: configVault(), vaultDriver: driverConSeed(),
  });

  assert.equal(r.skipped_existing.length, NO_ANCLA, 'las no-ancla siguen ganando por ambiente');
  assert.equal(env.OPENAI_API_KEY, 'AMBIENTE-OPENAI_API_KEY');
  assert.equal(r.sources.OPENAI_API_KEY, SOURCE.ENV_PREEXISTING);
  // La única que cambia de régimen es el ancla.
  assert.deepEqual(r.hydrated, [ANCLA_ENV]);
});

// =============================================================================
// B2.7 (rev-1) — el ENTORNO no puede desactivar el régimen del ancla
//
// Vector cerrado: `readVaultConfig` resolvía con `resolve({})`, así que
// `PIPELINE_REPO_ROOT` / `PIPELINE_DIR_OVERRIDE` / `PIPELINE_STATE_DIR` elegían
// qué config.yaml era la autoridad. Quien puede escribir el ancla en el ambiente
// puede escribir ESAS, desviar la lectura a una carpeta vacía (o propia), dejar
// el gate en "apagado" y quedarse como firmante del gate del operador.
// =============================================================================

/** Corre `fn` con las tres env vars de raíz apuntando a `valor`, y las restaura. */
function conRaizDesviadaPorEntorno(valor, fn) {
  const VARS = ['PIPELINE_DIR_OVERRIDE', 'PIPELINE_STATE_DIR', 'PIPELINE_REPO_ROOT'];
  const previas = VARS.map((v) => [v, process.env[v]]);
  for (const v of VARS) process.env[v] = valor;
  try { return fn(); } finally {
    for (const [v, prev] of previas) {
      if (prev === undefined) delete process.env[v]; else process.env[v] = prev;
    }
  }
}

test('B2.7 · con vault.enabled true en la config real, una raiz de config desviada por entorno NO devuelve el ancla al regimen de process.env', () => {
  const repoRoot = path.resolve(__dirname, '..', '..', '..');
  const real = require('../config-resolver').resolve({
    pipelineDir: path.join(repoRoot, '.pipeline'),
  });

  const leido = conRaizDesviadaPorEntorno(
    path.join(os.tmpdir(), 'cred-vault-5353-raiz-del-atacante-inexistente'),
    () => _readVaultConfig({}, capturarLogs()),
  );

  // La desviación NO tuvo efecto: se leyó la config real del checkout. Antes del
  // fix esto tiraba ConfigParseViolation, el catch devolvía null, `resolverVault`
  // lo colapsaba con "vault apagado" y el ancla preseteada sobrevivía.
  assert.equal(leido.indeterminado, false,
    'la raiz la fija el codigo: la desviacion por entorno no eligio la autoridad');
  assert.ok(leido.cfg, 'se leyo la seccion vault: de la config REAL');
  assert.equal(leido.cfg.enabled, real.vault.enabled,
    'el gate resuelto es el que dice la config commiteada, no el que dice el entorno');
  assert.equal(leido.cfg.prefix, real.vault.prefix);
  assert.equal(leido.cfg.projectId, real.vault.projectId);
});

test('B2.7 · una config ilegible NO se colapsa con "vault apagado": el ancla falla CERRADA y las 12 no-ancla quedan identicas', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cred-vault-5353-cfg-rota-'));
  const pipelineDir = path.join(dir, '.pipeline');
  fs.mkdirSync(pipelineDir);
  fs.writeFileSync(path.join(pipelineDir, 'config.yaml'), 'esto: [no es yaml\n  valido: {{{\n');

  // El atacante dejó su chat id preseteado, y una API key cualquiera también.
  const env = { [ANCLA_ENV]: '666666666', OPENAI_API_KEY: 'AMBIENTE-OPENAI' };
  const logger = capturarLogs();
  const driver = driverConSeed();

  try {
    // Con archivo presente para que el loop de precedencia corra completo: así
    // se ve que el ancla tampoco sale del ARCHIVO, y que las no-ancla resuelven
    // exactamente como con el gate cerrado.
    const r = conArchivosTmp(({ canonicalPath, legacyPath }) => cargar({
      canonicalPath, legacyPath, env, logger, pipelineDir, vaultDriver: driver,
    }), {
      canonical: {
        telegram: { bot_token: 'ARCHIVO-BOT', chat_id: '42', leo_operator_chat_id: '777777777' },
      },
    });

    assert.equal(driver.calls.length, 0, 'sin config legible no se abre el gate ni se toca el driver');
    assert.equal(r.vault.enabled, false);
    assert.equal(r.vault.indeterminado, true,
      '"no pude leer la config" es un estado propio, distinto de "el operador apago el vault"');

    // El ancla: fail-closed, igual que cuando el gate está abierto y falta (B2.4).
    assert.ok(!(ANCLA_ENV in env),
      'un error de lectura de config no puede devolverle el ancla al ambiente');
    assert.ok(r.missing.includes(ANCLA_ENV));
    assert.equal(r.sources[ANCLA_ENV], SOURCE.MISSING);
    assert.ok(!r.hydrated.includes(ANCLA_ENV), 'ni del ambiente ni del archivo');
    assert.equal(resolveOperatorAllowlist(env).size, 0, 'cero firmantes: el gate del operador no autoriza a nadie');
    assert.match(logger.texto(), /no se pudo leer config\.yaml para el vault/);
    // El WARN nombra la variable, nunca el valor (B2.3).
    assert.ok(!logger.texto().includes('666666666'), 'el log jamas lleva el valor del ancla');
    assert.ok(!logger.texto().includes('777777777'));

    // Las no-ancla: camino IDÉNTICO al del gate cerrado.
    assert.equal(env.OPENAI_API_KEY, 'AMBIENTE-OPENAI', 'process.env preseteado sigue ganando');
    assert.equal(r.sources.OPENAI_API_KEY, SOURCE.ENV_PREEXISTING);
    assert.ok(r.skipped_existing.includes('OPENAI_API_KEY'));
    assert.ok(!r.missing.includes('OPENAI_API_KEY'));
    assert.equal(env.TELEGRAM_BOT_TOKEN, 'ARCHIVO-BOT', 'las no-ancla siguen resolviendo del archivo');
    assert.equal(r.sources.TELEGRAM_BOT_TOKEN, 'canonical');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('B2.7 · con la config LEGIBLE el estado nunca es indeterminado (vault.enabled false sigue siendo identico al actual)', () => {
  const r = cargar({
    ...sinArchivos(), env: {}, logger: () => {},
    vaultConfig: configVault({ enabled: false }), vaultDriver: driverConSeed(),
  });
  assert.equal(r.vault.enabled, false);
  assert.equal(r.vault.indeterminado, false,
    'apagar el vault a proposito NO activa el fail-closed del ancla');
});

// =============================================================================
// B3-A — namespace y hostId (lado código, sin AWS)
// =============================================================================

test('B3-A.1 · el namespace se construye desde config y no hay camino fuera del propio', () => {
  const r = cargar({
    ...sinArchivos(), env: {}, logger: () => {},
    vaultConfig: configVault(), vaultDriver: driverConSeed(),
  });
  assert.equal(r.vault.namespace, `${PREFIX}/${PROJECT}#${HOST}`);

  // El seed del host A no alimenta al host B: cambia el namespace, cambia el path.
  const otro = cargar({
    ...sinArchivos(), env: {}, logger: () => {},
    vaultConfig: configVault({ hostId: 'otroHost' }), vaultDriver: driverConSeed(),
  });
  assert.equal(otro.vault.namespace, `${PREFIX}/${PROJECT}#otroHost`);
  assert.equal(otro.hydrated.length, HIDRATADAS,
    'los scopes de este inventario son shared: el aislamiento por host lo prueba secret-vault.test.js');
});

test('B3-A.3 · hostId vacio con el gate abierto falla nombrando vault.hostId', () => {
  const logger = capturarLogs();
  const r = cargar({
    ...sinArchivos(), env: {}, logger,
    vaultConfig: configVault({ hostId: '' }), vaultDriver: driverConSeed(),
  });
  assert.equal(r.vault.error.code, 'VAULT_CONFIG_INVALID');
  assert.match(logger.texto(), /vault\.hostId/, 'el mensaje nombra la CLAVE de config, no el regex');
  assert.equal(r.hydrated.length, 0, 'fail-closed: no se hidrata nada con config inválida');
});

// =============================================================================
// UX / contrato de QA / seguridad
// =============================================================================

test('UX-6 · loadIntoEnv({env: scratch}) no escribe en process.env y tolera el fallo', () => {
  // Contrato vivo de `qa/scripts/qa-narration.js:78` y `qa-video-share.js:119`:
  // compartir el video de QA no puede pasar a depender de AWS.
  // Se compara contra el snapshot previo, no contra `undefined`: en el host del
  // pipeline el ambiente real YA viene hidratado, y afirmar `undefined` haría
  // pasar el test por la razón equivocada en un entorno limpio.
  const antes = Object.fromEntries(
    Object.values(ENV_MAPPING).map((v) => [v, process.env[v]]),
  );

  const scratch = {};
  const r = cargar({
    ...sinArchivos(), env: scratch, logger: () => {},
    vaultConfig: configVault(), vaultDriver: driverConSeed(),
  });
  assert.equal(scratch.TELEGRAM_BOT_TOKEN, 'VAULT-BOT');
  for (const envVar of Object.values(ENV_MAPPING)) {
    assert.equal(process.env[envVar], antes[envVar],
      `el ambiente real del proceso cambió en ${envVar}`);
  }
  assert.notEqual(process.env.TELEGRAM_BOT_TOKEN, 'VAULT-BOT',
    'ningún valor del vault se filtró a process.env');
  assert.equal(r.hydrated.length, HIDRATADAS);

  // Y con el vault caído tampoco lanza: devuelve el resultado degradado.
  const scratch2 = {};
  assert.doesNotThrow(() => cargar({
    ...sinArchivos(), env: scratch2, logger: () => {},
    vaultConfig: configVault(), vaultDriver: driverQueDeniega(),
  }));
  assert.deepEqual(scratch2, {});
});

test('UX-3 · el resultado distingue "no configurada" de "vacia a proposito" y nunca lleva valores', () => {
  conArchivosTmp(({ canonicalPath, legacyPath }) => {
    const r = cargar({
      canonicalPath, legacyPath, env: {}, logger: () => {}, vaultConfig: null,
    });
    assert.equal(r.sources.TELEGRAM_BOT_TOKEN, SOURCE.CANONICAL);
    assert.equal(r.sources.TELEGRAM_CHAT_ID, SOURCE.EMPTY, 'presente pero vacía a propósito');
    assert.equal(r.sources.OPENAI_API_KEY, SOURCE.MISSING, 'no configurada');
    // Las dos siguen cayendo en `skipped_empty`: la forma histórica no cambia.
    assert.ok(r.skipped_empty.includes('TELEGRAM_CHAT_ID'));
    assert.ok(r.skipped_empty.includes('OPENAI_API_KEY'));

    // El objeto de resultado es 100% nombres: se puede loguear entero.
    const serializado = JSON.stringify(r);
    assert.ok(!serializado.includes('ARCHIVO-BOT'), 'ningún valor en el resultado');
  }, { canonical: { telegram: { bot_token: 'ARCHIVO-BOT', chat_id: '   ' } } });
});

test('SEC-2 · ningun skill gana el scope `aws` para resolver el vault por su cuenta', () => {
  // La resolución vive en el proceso padre; los hijos reciben valores ya
  // filtrados por `build-child-env.js`. Si un skill ganara el scope `aws`,
  // podría leer el namespace entero salteándose el scoping por capability.
  const modelos = require('../../agent-models.json');
  const conAws = Object.entries(modelos.skills || {})
    .filter(([, cfg]) => Array.isArray(cfg.requires_credentials) && cfg.requires_credentials.includes('aws'))
    .map(([skill]) => skill);
  assert.deepEqual(conAws, []);

  // Y `credentials.js` no propaga credenciales AWS al ambiente destino.
  const env = {};
  cargar({ ...sinArchivos(), env, logger: () => {}, vaultConfig: configVault(), vaultDriver: driverConSeed() });
  for (const k of ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'AWS_PROFILE']) {
    assert.ok(!(k in env), `${k} no puede llegar al ambiente hidratado`);
  }
});

test('config.yaml trae las dos claves de la ventana de bootstrap, apagadas', () => {
  const yaml = require('js-yaml');
  const cfg = yaml.load(fs.readFileSync(path.join(__dirname, '..', '..', 'config.yaml'), 'utf8'));
  assert.equal(cfg.vault.enabled, false, 'el gate se commitea CERRADO');
  assert.equal(cfg.vault.bootstrap_fallback, false, 'la ventana se commitea CERRADA');
  assert.equal(cfg.vault.bootstrap_fallback_until, '');
});
