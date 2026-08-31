// =============================================================================
// Regresiones del hook de la ventana sombra en credentials.js (#5448)
// node --test  (entra por el glob existente de `npm run test:pipeline`)
// =============================================================================
//
// Lo que se protege acá NO es el núcleo (eso está en vault-shadow-metrics.test.js)
// sino el CONTRATO DEL CALL SITE:
//
//   CA-25  con `vault.enabled: false` el hook no corre, no crea un solo
//          artefacto y no cambia ni el resultado ni el camino de boot.
//   CA-14  con el gate abierto corre UNA sola vez por `loadIntoEnv()`, con
//          `result.sources`, el `hostId` de la config y `ENV_DESCRIPTORS`.
//   CA-16  `loadIntoEnv()` sigue siendo sync y sin I/O de red.
//   REQ-SEC-11  un boot REAL contra el vault con un canario adentro no deja el
//          valor en ningún artefacto de auditoría (prueba de punta a punta).
//
// Ningún test escribe en el `.pipeline/audit/` del repo: o se inyecta un doble
// por `opts.shadowMetrics`, o se preconfigura el singleton contra un directorio
// temporal antes de que `loadIntoEnv` lo pida.
// =============================================================================
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const credentials = require('../credentials');
const {
  loadIntoEnv, ENV_MAPPING, ENV_DESCRIPTORS, HYDRATED_DESCRIPTORS, SOURCE, _resetVaultCache,
} = credentials;

// #5217 · CA-6 — el denominador de la ventana sombra es lo HIDRATABLE, no el
// inventario entero. Las 4 claves de `google_drive` siguen en `ENV_DESCRIPTORS`
// (el vault las provisiona y la politica IAM las cubre) pero nunca se inyectan
// en el ambiente, asi que jamas emiten una fila de cobertura: contarlas dejaria
// la ventana permanentemente por debajo del umbral y el fallback a archivo no
// se retiraria nunca.
const { buildParameterPath, createInMemoryVaultDriver } = require('../secret-vault');
const { getVaultShadowMetrics, _resetVaultShadowMetrics, VIA } = require('../vault-shadow-metrics');

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

/**
 * Huella de un artefacto real de auditoría: `null` si no existe, su contenido
 * exacto si existe, y un marcador estable si ni se puede leer.
 *
 * Es lo que permite afirmar "este boot no escribió" sin exigir "el archivo no
 * existe": el JSONL es append-only (escribir lo agranda) y el t0 se reescribe
 * siempre con un timestamp nuevo (reiniciar la ventana cambia el contenido),
 * así que comparar antes/después detecta cualquier escritura. Un `catch` que
 * devolviera `null` haría que "ilegible" se confundiera con "ausente", así que
 * el error se codifica y una lectura que empieza a fallar también rompe.
 */
function huella(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch (e) {
    return e && e.code === 'ENOENT' ? null : `ilegible:${(e && e.code) || (e && e.name) || 'Error'}`;
  }
}

const PREFIX = '/intrale';
const PROJECT = 'intrale';
const HOST = 'hostTest';

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

/** Namespace completo: los 13 descriptores resueltos por el vault. */
function seedCompleto(botToken = 'VAULT-BOT') {
  return {
    parameters: {
      [rutaScope('telegram')]: { bot_token: botToken, chat_id: '42', leo_operator_chat_id: '111222333' },
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

function driverQueDeniega() {
  const explotar = () => {
    const err = new Error('AccessDenied: no identity-based policy allows ssm:GetParametersByPath');
    err.name = 'VaultCliError';
    err.code = 'VAULT_CLI';
    throw err;
  };
  return {
    kind: 'deniega',
    calls: [],
    getParametersByPathSync: explotar,
    getSecretValueSync: explotar,
    async getParametersByPath() { return explotar(); },
    async getSecretValue() { return explotar(); },
  };
}

/** Doble del núcleo: registra las llamadas sin tocar el filesystem. */
function espiaMetrics() {
  const llamadas = [];
  return {
    llamadas,
    record(sources, meta) { llamadas.push({ sources, meta }); return { registradas: 0, negativas: 0, integridad: 'ok' }; },
    flush() { return { escritas: 0, error: null }; },
  };
}

function conArchivosTmp(fn, { canonical = null, legacy = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cred-shadow-5448-'));
  const canonicalPath = path.join(dir, 'credentials.json');
  const legacyPath = path.join(dir, 'telegram-config.json');
  if (canonical) fs.writeFileSync(canonicalPath, JSON.stringify(canonical, null, 2));
  if (legacy) fs.writeFileSync(legacyPath, legacy === '@invalido' ? '{ roto' : JSON.stringify(legacy, null, 2));
  try { return fn({ canonicalPath, legacyPath, dir }); }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

function sinArchivos() {
  const dir = path.join(os.tmpdir(), 'cred-shadow-5448-inexistente');
  return { canonicalPath: path.join(dir, 'credentials.json'), legacyPath: path.join(dir, 'telegram-config.json') };
}

function capturarLogs() {
  const lineas = [];
  const logger = (m) => lineas.push(String(m));
  logger.texto = () => lineas.join('\n');
  return logger;
}

function cargar(opts) {
  _resetVaultCache();
  return loadIntoEnv(opts);
}

/**
 * Corre `fn` con el núcleo REAL (módulo real, `fs` real) apuntando a un
 * directorio temporal. Se inyecta por `opts.shadowMetrics` a propósito: bajo
 * `node --test` el hook NO usa el singleton por defecto, justamente para que
 * una corrida de la suite no escriba en el `.pipeline/audit/` del repo.
 */
function conNucleoReal(fn) {
  const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'cred-shadow-audit-'));
  const auditDir = path.join(raiz, 'audit');
  _resetVaultShadowMetrics();
  const metrics = getVaultShadowMetrics({ auditDir, logger: () => {}, autoFlushOnExit: false });
  try { return fn({ auditDir, metrics }); }
  finally {
    _resetVaultShadowMetrics();
    fs.rmSync(raiz, { recursive: true, force: true });
  }
}

/** Todos los archivos del directorio de auditoría, concatenados. */
function volcadoAuditoria(auditDir) {
  if (!fs.existsSync(auditDir)) return '';
  return fs.readdirSync(auditDir)
    .map((f) => fs.readFileSync(path.join(auditDir, f), 'utf8'))
    .join('\n');
}

// =============================================================================
// CA-25 — gate cerrado: ni una fila, ni un cambio
// =============================================================================

test('CA-25 · con vault.enabled false el hook no se ejecuta ni una vez', () => {
  const espia = espiaMetrics();
  conArchivosTmp(({ canonicalPath, legacyPath }) => {
    const r = cargar({
      canonicalPath, legacyPath, env: {}, logger: () => {},
      vaultConfig: configVault({ enabled: false }), shadowMetrics: espia,
    });
    assert.equal(r.vault.enabled, false);
    assert.equal(espia.llamadas.length, 0, 'con el gate cerrado no hay dicotomia vault/fallback que registrar');
  }, { canonical: { telegram: { bot_token: 'ARCHIVO-BOT', chat_id: '42' } } });
});

test('CA-25 · las salidas tempranas del gate cerrado siguen sin instrumentar', () => {
  // Sin ningún archivo: `loadIntoEnv` retorna antes del bucle de precedencia.
  const espiaSinArchivo = espiaMetrics();
  cargar({ ...sinArchivos(), env: {}, logger: () => {}, vaultConfig: configVault({ enabled: false }), shadowMetrics: espiaSinArchivo });
  assert.equal(espiaSinArchivo.llamadas.length, 0);

  // Legacy JSON inválido: la otra salida temprana.
  const espiaLegacyRoto = espiaMetrics();
  conArchivosTmp(({ canonicalPath, legacyPath }) => {
    cargar({ canonicalPath, legacyPath, env: {}, logger: () => {}, vaultConfig: configVault({ enabled: false }), shadowMetrics: espiaLegacyRoto });
  }, { legacy: '@invalido' });
  assert.equal(espiaLegacyRoto.llamadas.length, 0);

  // Config del vault ausente (gate cerrado por indeterminación).
  const espiaSinConfig = espiaMetrics();
  cargar({ ...sinArchivos(), env: {}, logger: () => {}, vaultConfig: null, shadowMetrics: espiaSinConfig });
  assert.equal(espiaSinConfig.llamadas.length, 0);
});

test('CA-25 · con el gate cerrado no se crea NINGUN artefacto bajo audit/', () => {
  conNucleoReal(({ auditDir, metrics }) => {
    conArchivosTmp(({ canonicalPath, legacyPath }) => {
      const r = cargar({
        canonicalPath, legacyPath, env: {}, logger: () => {},
        vaultConfig: configVault({ enabled: false }), shadowMetrics: metrics,
      });
      assert.equal(r.source, 'canonical');
      // Camino de producción completo, sin inyectar el doble.
      assert.equal(fs.existsSync(auditDir), false, `se creo ${auditDir} con el gate cerrado`);
    }, { canonical: { telegram: { bot_token: 'ARCHIVO-BOT', chat_id: '42' } } });
  });
});

test('CA-25 · el resultado con el gate cerrado es identico con y sin el nucleo', () => {
  const conHook = conArchivosTmp(({ canonicalPath, legacyPath }) => cargar({
    canonicalPath, legacyPath, env: {}, logger: () => {}, vaultConfig: configVault({ enabled: false }),
  }), { canonical: { telegram: { bot_token: 'ARCHIVO-BOT', chat_id: '42' } } });

  const conEspia = conArchivosTmp(({ canonicalPath, legacyPath }) => cargar({
    canonicalPath, legacyPath, env: {}, logger: () => {}, vaultConfig: configVault({ enabled: false }),
    shadowMetrics: espiaMetrics(),
  }), { canonical: { telegram: { bot_token: 'ARCHIVO-BOT', chat_id: '42' } } });

  assert.deepEqual(conEspia, conHook, 'el hook no puede alterar la forma ni el contenido de `result`');
});

// =============================================================================
// CA-14 — el hook es ÚNICO y recibe exactamente lo que corresponde
// =============================================================================

test('CA-14 · con el gate abierto el hook corre UNA sola vez por loadIntoEnv', () => {
  const espia = espiaMetrics();
  const r = cargar({
    ...sinArchivos(), env: {}, logger: () => {},
    vaultConfig: configVault(), vaultDriver: createInMemoryVaultDriver(seedCompleto()),
    shadowMetrics: espia,
  });

  assert.equal(r.vault.enabled, true);
  assert.equal(espia.llamadas.length, 1, 'un solo call site: dos llamadas serian doble conteo');

  const { sources, meta } = espia.llamadas[0];
  assert.equal(sources, r.sources, 'recibe el MISMO objeto sources que devuelve loadIntoEnv');
  assert.equal(meta.hostId, HOST, 'el host sale de la config del vault, no del ambiente');
  assert.equal(meta.descriptors, HYDRATED_DESCRIPTORS,
    'el denominador es el subconjunto hidratable del descriptor, sin lista duplicada');
  assert.equal(Object.keys(sources).length, Object.keys(ENV_MAPPING).length);
  for (const envVar of Object.values(ENV_MAPPING)) assert.equal(sources[envVar], SOURCE.VAULT);
});

test('CA-14 · el hook ve las vias negativas cuando el vault falla y hay fallback', () => {
  const espia = espiaMetrics();
  conArchivosTmp(({ canonicalPath, legacyPath }) => {
    const r = cargar({
      canonicalPath, legacyPath, env: {}, logger: () => {},
      vaultConfig: configVault({ bootstrap_fallback: true, bootstrap_fallback_until: '2099-01-01' }),
      vaultDriver: driverQueDeniega(), shadowMetrics: espia,
    });

    assert.equal(espia.llamadas.length, 1);
    const vistas = new Set(Object.values(espia.llamadas[0].sources));
    assert.ok(vistas.has(SOURCE.FILE_BOOTSTRAP) || vistas.has(SOURCE.MISSING),
      `el hook tiene que ver la evidencia negativa; vio ${[...vistas].join(', ')}`);
    assert.equal(vistas.has(SOURCE.VAULT), false, 'el vault denegado no puede contar como cobertura');
    assert.equal(r.vault.enabled, true);
  }, { canonical: { telegram: { bot_token: 'ARCHIVO-BOT', chat_id: '42' } } });
});

test('la evidencia negativa de un boot real queda persistida sin esperar el flush', () => {
  conNucleoReal(({ auditDir, metrics }) => {
    conArchivosTmp(({ canonicalPath, legacyPath }) => {
      cargar({
        canonicalPath, legacyPath, env: {}, logger: () => {},
        vaultConfig: configVault({ bootstrap_fallback: true, bootstrap_fallback_until: '2099-01-01' }),
        vaultDriver: driverQueDeniega(), shadowMetrics: metrics,
      });

      // Sin llamar a `flush()`: perder esto sería fail-open (H-2 de #5427).
      const jsonl = path.join(auditDir, 'vault-resolution.jsonl');
      assert.equal(fs.existsSync(jsonl), true, 'la evidencia negativa se appendea inmediato');
      const filas = fs.readFileSync(jsonl, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
      assert.ok(filas.length > 0);
      for (const f of filas) {
        assert.ok(['file-bootstrap', 'missing'].includes(f.via), `via inesperada sin flush: ${f.via}`);
        assert.equal(f.host, HOST);
        assert.ok(Object.prototype.hasOwnProperty.call(ENV_DESCRIPTORS, f.name), `name no es un dot-path: ${f.name}`);
      }
    }, { canonical: { telegram: { bot_token: 'ARCHIVO-BOT', chat_id: '42' } } });
  });
});

test('la cobertura positiva de un boot real se persiste con el flush', () => {
  conNucleoReal(({ auditDir, metrics }) => {
    cargar({
      ...sinArchivos(), env: {}, logger: () => {},
      vaultConfig: configVault(), vaultDriver: createInMemoryVaultDriver(seedCompleto()),
      shadowMetrics: metrics,
    });

    // La vía `vault` se agrega en memoria: nada en disco hasta el flush.
    assert.equal(fs.existsSync(path.join(auditDir, 'vault-resolution.jsonl')), false);
    assert.equal(metrics.flush().escritas, Object.keys(HYDRATED_DESCRIPTORS).length);

    const filas = metrics.readRows();
    assert.equal(filas.length, Object.keys(HYDRATED_DESCRIPTORS).length);
    for (const f of filas) {
      assert.equal(f.via, VIA.VAULT);
      assert.equal(f.host, HOST);
    }
    assert.deepEqual(filas.map((f) => f.name).sort(), Object.keys(HYDRATED_DESCRIPTORS).sort(),
      'un boot completo cubre exactamente los 13 descriptores');
  });
});

// =============================================================================
// REQ-SEC-11 — canario de punta a punta
// =============================================================================

test('un boot real contra el vault no deja el valor del secreto en la auditoria', () => {
  const CANARIO = 'CANARIO-5448-BOT-TOKEN-NO-DEBE-APARECER';
  conNucleoReal(({ auditDir, metrics }) => {
    const logger = capturarLogs();
    const env = {};

    cargar({
      ...sinArchivos(), env, logger,
      vaultConfig: configVault(), vaultDriver: createInMemoryVaultDriver(seedCompleto(CANARIO)),
      shadowMetrics: metrics,
    });
    metrics.flush();

    // El canario SÍ tiene que haber llegado al ambiente: si no, el test no
    // probaría nada (estaríamos buscando un valor que nunca existió).
    assert.equal(env.TELEGRAM_BOT_TOKEN, CANARIO, 'el canario tiene que haber sido hidratado de verdad');

    const volcado = volcadoAuditoria(auditDir);
    assert.ok(volcado.length > 0, 'el barrido tiene que haber mirado artefactos reales');
    assert.equal(volcado.includes(CANARIO), false, 'el valor del secreto aparecio en .pipeline/audit/');
    assert.equal(logger.texto().includes(CANARIO), false, 'el valor del secreto aparecio en los logs');

    // Y tampoco derivados: ni prefijo, ni longitud etiquetada, ni hash.
    assert.equal(volcado.includes(CANARIO.slice(0, 8)), false, 'aparecio un prefijo del valor');
    assert.match(volcado, /"name":"telegram\.bot_token"/, 'el nombre logico si tiene que estar');
  });
});

// =============================================================================
// Integridad de la auditoría — la suite no puede contaminar la evidencia real
// =============================================================================

test('un boot de prueba sin inyeccion NO escribe en el .pipeline/audit/ del repo', () => {
  // Este test existe porque ya pasó: decenas de tests de credenciales bootean
  // con el gate abierto, y sin la guarda le metían filas sintéticas (`hostTest`,
  // `otroHost`) al JSONL real y le reiniciaban el t0 real por evidencia negativa
  // sintética. Es decir: correr la suite volvía IMPOSIBLE que la ventana
  // cerrara, y ensuciaba justo la evidencia sobre la que #5427 decide.
  //
  // Lo que se afirma es "este boot no escribió", y por eso se compara una
  // HUELLA de antes contra una de después (#5453 rev-3). La versión anterior
  // afirmaba "los artefactos no existen", que es una condición distinta y más
  // fuerte: cualquier escritura LEGÍTIMA previa en ese checkout —un boot de
  // producción, `node .pipeline/vault-shadow-status.js`, o el
  // `vault-migration-run.js` que el operador y el QA corren por diseño— dejaba
  // el t0/JSONL creados y este test fallaba culpando a la suite de algo que la
  // suite no hizo. Con la huella la guarda conserva TODOS sus dientes: cualquier
  // append al JSONL lo agranda y cualquier reinicio de ventana reescribe el t0
  // con otro timestamp, así que un boot que escriba sigue rompiendo el test.
  _resetVaultShadowMetrics();
  const real = getVaultShadowMetrics();
  const auditReal = real.paths.auditDir;
  const antes = fs.existsSync(auditReal) ? fs.readdirSync(auditReal).length : null;
  const jsonlReal = path.join(auditReal, 'vault-resolution.jsonl');
  const t0Real = path.join(auditReal, 'vault-resolution.t0.json');
  const jsonlAntes = huella(jsonlReal);
  const t0Antes = huella(t0Real);

  // Gate ABIERTO, driver que falla ⇒ evidencia negativa ⇒ el peor caso: es la
  // vía que appendea inmediato y reinicia t0.
  conArchivosTmp(({ canonicalPath, legacyPath }) => {
    cargar({
      canonicalPath, legacyPath, env: {}, logger: () => {},
      vaultConfig: configVault({ bootstrap_fallback: true, bootstrap_fallback_until: '2099-01-01' }),
      vaultDriver: driverQueDeniega(),
    });
  }, { canonical: { telegram: { bot_token: 'ARCHIVO-BOT', chat_id: '42' } } });

  assert.ok(process.env.NODE_TEST_CONTEXT, 'este test solo tiene sentido bajo `node --test`');
  const despues = fs.existsSync(auditReal) ? fs.readdirSync(auditReal).length : null;
  assert.equal(despues, antes, `la suite modifico ${auditReal}`);
  assert.equal(huella(jsonlReal), jsonlAntes,
    'un boot de prueba no puede dejar evidencia en el JSONL real');
  assert.equal(huella(t0Real), t0Antes,
    'un boot de prueba no puede reiniciar el t0 real');
  _resetVaultShadowMetrics();
});

test('el singleton por defecto apunta al .pipeline/audit/ del repo (cableado de produccion)', () => {
  _resetVaultShadowMetrics();
  const jsonlReal = path.join(path.resolve(__dirname, '..', '..', 'audit'), 'vault-resolution.jsonl');
  // Misma huella que el test de arriba y por la misma razón (#5453 rev-3): lo
  // que se afirma es que PEDIR el singleton no escribe, no que el archivo esté
  // ausente. En un checkout donde ya corrió un boot real el JSONL existe, y eso
  // no dice nada sobre la laziness.
  const jsonlAntes = huella(jsonlReal);
  const real = getVaultShadowMetrics();
  assert.equal(real.paths.auditDir, path.resolve(__dirname, '..', '..', 'audit'));
  assert.equal(real.paths.jsonl, jsonlReal);
  // Pedirlo no crea nada: la laziness es lo que sostiene CA-25.
  assert.equal(huella(jsonlReal), jsonlAntes);
  _resetVaultShadowMetrics();
});

// =============================================================================
// CA-16 — sync, sin red, y la observabilidad nunca tumba el boot
// =============================================================================

test('CA-16 · loadIntoEnv sigue siendo sincrona con el gate abierto y el hook activo', () => {
  const r = cargar({
    ...sinArchivos(), env: {}, logger: () => {},
    vaultConfig: configVault(), vaultDriver: createInMemoryVaultDriver(seedCompleto()),
    shadowMetrics: espiaMetrics(),
  });
  assert.equal(typeof r.then, 'undefined', 'el retorno no puede ser thenable');
  assert.equal(loadIntoEnv.constructor.name, 'Function', 'no puede volverse AsyncFunction');
});

test('un nucleo que explota no tumba el boot ni filtra la excepcion', () => {
  const CANARIO = 'CANARIO-EN-LA-EXCEPCION-DEL-HOOK';
  const logger = capturarLogs();
  const explosivo = {
    record() { const e = new Error(`fallo con ${CANARIO} adentro`); e.name = 'ShadowError'; throw e; },
  };

  const r = cargar({
    ...sinArchivos(), env: {}, logger,
    vaultConfig: configVault(), vaultDriver: createInMemoryVaultDriver(seedCompleto()),
    shadowMetrics: explosivo,
  });

  // El boot terminó bien: la observabilidad es opcional, la hidratación no.
  assert.equal(r.source, SOURCE.VAULT);
  assert.equal(r.hydrated.length, Object.keys(ENV_MAPPING).length);
  assert.deepEqual(r.missing, []);

  assert.match(logger.texto(), /ventana sombra/);
  assert.match(logger.texto(), /ShadowError/, 'solo el nombre del error');
  assert.equal(logger.texto().includes(CANARIO), false, 'el message crudo no se loguea');
});

test('el hook no agrega ninguna dependencia de red al camino de boot', () => {
  // El núcleo sólo puede hablar con `fs` y `path`: cualquier `require` de red
  // metido acá convertiría `loadIntoEnv()` en un punto de falla remoto.
  const fuente = fs.readFileSync(path.join(__dirname, '..', 'vault-shadow-metrics.js'), 'utf8');
  const requires = [...fuente.matchAll(/require\((['"])([^'"]+)\1\)/g)].map((m) => m[2]);
  assert.deepEqual(requires.sort(), ['fs', 'path']);
  for (const prohibido of ['http', 'https', 'net', 'child_process', 'setInterval(', 'setTimeout(']) {
    assert.equal(fuente.includes(prohibido), false, `el nucleo no puede usar ${prohibido}`);
  }
});
