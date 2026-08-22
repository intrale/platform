'use strict';

// =============================================================================
// credentials-vault-5219.test.js — #5899 (parte 2 del split de #5219)
//
// Resolución de secretos POR INSTANCIA contra el vault, con memo multi-tenant
// ACOTADA. Cubre los CA del PO (issuecomment-5282563685):
//
//   CA-5   `opts.projectId` como override explícito; sin él, el camino global
//          de los 13 secretos queda idéntico.
//   CA-6   `projectId` fuera de `^[A-Za-z0-9_-]+$` ⇒ `VaultConfigError` ANTES
//          del path, ANTES de la clave de la memo y con CERO llamadas al driver.
//   CA-7   `opts.requiredScopes` como override simétrico de la allowlist.
//   CA-8   la validación es `validateVaultNamespace`; sin copias del regex.
//   CA-9   tier `host` por default, `shared` sólo si se enumera.
//   CA-10  no-thrash: `A,A,B,A,B` ⇒ `MISS,HIT,MISS,HIT,HIT` contando el driver.
//   CA-11  mismo tenant con conjuntos de scopes distintos ⇒ sin HIT falso.
//   CA-12  cota `vault.max_cached_tenants`: evicta, no crece.
//   CA-13  la evicción emite warn con NOMBRES, sin un solo valor.
//   CA-14  `expiraEn` se fija al escribir y la lectura NO lo refresca.
//   CA-15  el fallo de A no memoiza negativo ni pisa la entrada válida de B.
//   CA-16  las entradas se BORRAN y propagan `clearCache()` a la capa de abajo.
//   CA-18  `vault.enabled` sigue en `false` en config.yaml.
//   CA-21  contención `isSafeId` ⊆ `assertSegment` pinneada sobre un corpus.
//
// CA-22 — el E2E contra el vault REAL queda declarado como PASO DIFERIDO a
// #5339 (encender el vault) + #5393 (poblarlo). Toda la cobertura de esta parte
// corre con `createInMemoryVaultDriver` (secret-vault.js:682) sobre DOS
// `projectId`, sin red y sin cuenta AWS.
//
// ⚠️ El test "proyecto-a y proyecto-b devuelven material distinto" PASA HOY sin
// escribir una línea: vale como no-regresión y NO acredita la parte. Lo que la
// acredita es CA-10 (patrón de llamadas al driver), CA-6 (rechazo con cero
// llamadas) y CA-11 (ausencia de HIT falso).
// =============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const sv = require('../secret-vault');
const { buildParameterPath, createInMemoryVaultDriver } = sv;
const {
  resolveInstanceVault,
  INSTANCE_VAULT_ERROR_CODES,
  DEFAULT_MAX_CACHED_TENANTS,
  resolveVaultOnly,
  _resetVaultCache,
} = require('../credentials');
const { isSafeId } = require('../project-descriptor');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const PREFIX = '/test5219';
const HOST = 'hostDePrueba';

// -----------------------------------------------------------------------------
// Fixtures
// -----------------------------------------------------------------------------

function cfg(over = {}) {
  return {
    enabled: true,
    prefix: PREFIX,
    projectId: 'kernel',            // identidad del kernel; la instancia la pisa
    hostId: HOST,
    cache_ttl_seconds: 300,
    required_scopes: [],            // CA-7: la allowlist global NO autoriza instancias
    shared_secrets: [],
    max_cached_tenants: DEFAULT_MAX_CACHED_TENANTS,
    ...over,
  };
}

// Material por proyecto. Un scope del vault es un OBJETO JSON por contrato
// (`parsearScope` rechaza un string suelto).
const MATERIAL = {
  'proyecto-a': { alpha: { valor: 'FAKE-proy-a-ALPHA' }, beta: { valor: 'FAKE-proy-a-BETA' } },
  'proyecto-b': { alpha: { valor: 'FAKE-proy-b-ALPHA' }, beta: { valor: 'FAKE-proy-b-BETA' } },
};

function driverSembrado({ material = MATERIAL, tierPorScope = () => 'host' } = {}) {
  const parameters = {};
  for (const [projectId, scopes] of Object.entries(material)) {
    for (const [scope, valor] of Object.entries(scopes)) {
      parameters[buildParameterPath({
        prefix: PREFIX, projectId, hostId: HOST, scope, tier: tierPorScope(scope),
      })] = valor;
    }
  }
  return createInMemoryVaultDriver({ parameters });
}

function capturarLogs() {
  const lineas = [];
  const fn = (msg) => lineas.push(String(msg));
  fn.texto = () => lineas.join('\n');
  fn.lineas = lineas;
  return fn;
}

/**
 * Espía sobre `createSecretVault` para poder afirmar que `clearCache()` de la
 * VÍCTIMA fue invocado (CA-16 · G-5). Se parchea el export del módulo porque
 * `credentials.js` resuelve `sv.createSecretVault` en cada llamada (require
 * perezoso por el ciclo `credentials ↔ secret-vault`).
 */
function espiarVaults() {
  const original = sv.createSecretVault;
  const creados = [];
  sv.createSecretVault = (args) => {
    const vault = original(args);
    const clearOriginal = vault.clearCache;
    const registro = { projectId: args && args.config && args.config.projectId, limpiezas: 0 };
    vault.clearCache = () => { registro.limpiezas += 1; return clearOriginal(); };
    creados.push(registro);
    return vault;
  };
  return {
    creados,
    restaurar() { sv.createSecretVault = original; },
  };
}

/** Resuelve una instancia y devuelve cuántas llamadas al driver costó. */
function resolverContando(driver, args, opts) {
  const antes = driver.calls.length;
  const res = resolveInstanceVault(args, { vaultConfig: cfg(), vaultDriver: driver, logger: () => {}, ...opts });
  return { res, llamadas: driver.calls.length - antes };
}

// =============================================================================
// CA-10 — no-thrash (EL criterio que acredita la parte)
// =============================================================================

test('CA-10 · la secuencia A,A,B,A,B produce MISS,HIT,MISS,HIT,HIT contando llamadas al driver', () => {
  _resetVaultCache();
  const driver = driverSembrado();
  const pedir = (projectId) => resolverContando(driver, { projectId, scopes: ['alpha'] });

  const patron = [];
  for (const p of ['proyecto-a', 'proyecto-a', 'proyecto-b', 'proyecto-a', 'proyecto-b']) {
    const { res, llamadas } = pedir(p);
    assert.equal(res.ok, true, `${p} resuelve`);
    patron.push(llamadas === 0 ? 'HIT' : 'MISS');
  }

  // Con la memo de UNA entrada esto daba MISS,HIT,MISS,MISS,MISS: cada
  // alternancia entre proyectos desalojaba al otro y pagaba un proceso de la
  // AWS CLI, POR LANZAMIENTO DE AGENTE.
  assert.deepEqual(patron, ['MISS', 'HIT', 'MISS', 'HIT', 'HIT'], `patrón real: ${patron}`);
});

test('no-regresión · proyecto-a y proyecto-b devuelven material distinto (NO acredita la parte)', () => {
  _resetVaultCache();
  const driver = driverSembrado();
  const a = resolveInstanceVault({ projectId: 'proyecto-a', scopes: ['alpha'] },
    { vaultConfig: cfg(), vaultDriver: driver, logger: () => {} });
  const b = resolveInstanceVault({ projectId: 'proyecto-b', scopes: ['alpha'] },
    { vaultConfig: cfg(), vaultDriver: driver, logger: () => {} });

  assert.deepEqual(a.scopes.alpha, { valor: 'FAKE-proy-a-ALPHA' });
  assert.deepEqual(b.scopes.alpha, { valor: 'FAKE-proy-b-ALPHA' });
  assert.equal(a.namespace, `${PREFIX}/proyecto-a#${HOST}`);
  assert.equal(b.namespace, `${PREFIX}/proyecto-b#${HOST}`);
});

// =============================================================================
// CA-11 / G-2 — falso HIT por conjunto de scopes
// =============================================================================

test('CA-11 · el mismo projectId con [a] y después [a,b] NO da HIT y trae los dos scopes', () => {
  _resetVaultCache();
  const driver = driverSembrado();

  const uno = resolverContando(driver, { projectId: 'proyecto-a', scopes: ['alpha'] });
  assert.equal(uno.res.ok, true);
  assert.ok(uno.llamadas > 0, 'el primero es MISS');

  const dos = resolverContando(driver, { projectId: 'proyecto-a', scopes: ['alpha', 'beta'] });
  // Un HIT acá devolvería sólo `alpha` y reportaría `beta` como missing: un
  // fail-closed INDEBIDO sobre un tenant legítimo, peor que el MISS de más.
  assert.ok(dos.llamadas > 0, 'un conjunto de scopes distinto NO puede salir de la memo');
  assert.equal(dos.res.ok, true);
  assert.deepEqual(Object.keys(dos.res.scopes).sort(), ['alpha', 'beta']);
  assert.deepEqual(dos.res.missing, [], 'sin `missing` espurio');

  // Y el conjunto original sigue teniendo su propia entrada viva.
  const tres = resolverContando(driver, { projectId: 'proyecto-a', scopes: ['alpha'] });
  assert.equal(tres.llamadas, 0, 'la entrada del conjunto original no se perdió');
});

test('CA-11 · el orden y los duplicados del pedido no cambian la clave de la memo', () => {
  _resetVaultCache();
  const driver = driverSembrado();
  const uno = resolverContando(driver, { projectId: 'proyecto-a', scopes: ['alpha', 'beta'] });
  assert.ok(uno.llamadas > 0);
  const dos = resolverContando(driver, { projectId: 'proyecto-a', scopes: ['beta', 'alpha', 'beta'] });
  assert.equal(dos.llamadas, 0, 'mismo CONJUNTO de scopes ⇒ misma entrada');
  assert.equal(dos.res.ok, true);
});

// =============================================================================
// CA-6 / REQ-SEC-2 — gate de seguridad 1: validar antes de todo
// =============================================================================

const PROJECT_IDS_HOSTILES = [
  '../otro-proyecto', 'a/b', 'a\\b', 'proy.a', '/etc/passwd', '..', '',
  'con espacio', 'proy#a', 'proy|a', null, undefined, 42, {},
];

test('CA-6/REQ-SEC-2 · un projectId fuera del criterio de segmento falla con VaultConfigError y CERO llamadas al driver', () => {
  for (const malo of PROJECT_IDS_HOSTILES) {
    _resetVaultCache();
    const driver = driverSembrado();
    assert.throws(
      () => resolveInstanceVault({ projectId: malo, scopes: ['alpha'] },
        { vaultConfig: cfg(), vaultDriver: driver, logger: () => {} }),
      (err) => err && err.name === 'VaultConfigError' && err.code === 'VAULT_CONFIG_INVALID',
      `projectId hostil rechazado: ${JSON.stringify(malo)}`,
    );
    assert.equal(driver.calls.length, 0,
      `cero llamadas al driver para ${JSON.stringify(malo)}: la validación corre ANTES`);
  }
});

test('CA-6 · el error nombra la CLAVE de config, nunca el regex, y no sanitiza en silencio', () => {
  _resetVaultCache();
  const driver = driverSembrado();
  try {
    resolveInstanceVault({ projectId: '../fuga', scopes: ['alpha'] },
      { vaultConfig: cfg(), vaultDriver: driver, logger: () => {} });
    assert.fail('debió lanzar');
  } catch (err) {
    assert.equal(err.clave, 'vault.projectId', 'nombra la clave, no el regex');
    assert.ok(!/\^\[A-Za-z0-9/.test(err.message), 'el mensaje no escupe el regex');
  }
});

test('CA-6 · un scope hostil también se rechaza antes de tocar el driver', () => {
  for (const scope of ['../otro', 'a/b', 'con espacio', 'sc.ope']) {
    _resetVaultCache();
    const driver = driverSembrado();
    assert.throws(
      () => resolveInstanceVault({ projectId: 'proyecto-a', scopes: [scope] },
        { vaultConfig: cfg(), vaultDriver: driver, logger: () => {} }),
      (err) => err && err.name === 'VaultConfigError',
      `scope hostil rechazado: ${scope}`,
    );
    assert.equal(driver.calls.length, 0, `cero llamadas al driver para el scope ${scope}`);
  }
});

test('CA-6 · un projectId inválido NO deja rastro en la memo (no envenena la clave de nadie)', () => {
  _resetVaultCache();
  const driver = driverSembrado();
  const bueno = resolverContando(driver, { projectId: 'proyecto-a', scopes: ['alpha'] });
  assert.ok(bueno.llamadas > 0);

  assert.throws(() => resolveInstanceVault({ projectId: 'proy/a', scopes: ['alpha'] },
    { vaultConfig: cfg(), vaultDriver: driver, logger: () => {} }));

  const despues = resolverContando(driver, { projectId: 'proyecto-a', scopes: ['alpha'] });
  assert.equal(despues.llamadas, 0, 'la entrada válida sobrevivió al rechazo');
});

// =============================================================================
// CA-8 — sin copias del regex de segmento
// =============================================================================

test('CA-8 · ni credentials.js ni kernel-supervisor.js reimplementan el regex de segmento', () => {
  for (const rel of ['.pipeline/lib/credentials.js', '.pipeline/lib/kernel-supervisor.js']) {
    const src = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
    assert.ok(!src.includes('A-Za-z0-9_-'),
      `${rel} copia el criterio de segmento; el punto de entrada es validateVaultNamespace`);
    assert.ok(!/\bassertSegment\s*\(/.test(src),
      `${rel} reimplementa assertSegment (no se exporta a propósito)`);
  }
  // Y el camino canónico SÍ está cableado.
  const cred = fs.readFileSync(path.join(REPO_ROOT, '.pipeline/lib/credentials.js'), 'utf8');
  assert.ok(cred.includes('validateVaultNamespace'), 'credentials.js valida con el validador canónico');
});

// =============================================================================
// CA-21 / REQ-SEC-4 — contención isSafeId ⊆ assertSegment
// =============================================================================

const CORPUS_IDS = [
  'acme', 'globex', 'proyecto-a', 'proyecto-b', 'a1', 'x-y-z', 'a'.repeat(64),
  '../evil', '..', 'a/b', 'a\\b', '/etc/passwd', 'ACME', 'a b', '', 'x'.repeat(80),
  'a.b', 'a_b', '-arranca-con-guion', '1', 'a#b', 'a|b', 'a:b', 'a,b', 'a%2e%2e',
];

test('CA-21/REQ-SEC-4 · todo id que acepta isSafeId lo acepta también el validador del vault', () => {
  let aceptadosPorAmbos = 0;
  for (const id of CORPUS_IDS) {
    if (!isSafeId(id)) continue;
    // Si `SAFE_ID_RE` se afloja (agregar `.` o `/`), esto rompe la suite en vez
    // de abrir traversal hacia el vault en silencio.
    assert.doesNotThrow(
      () => sv.validateVaultNamespace({
        prefix: PREFIX, projectId: id, hostId: HOST, tier: 'host', root: true,
      }),
      `isSafeId acepta "${id}" pero el validador del vault lo rechaza: contención rota`,
    );
    aceptadosPorAmbos += 1;
  }
  assert.ok(aceptadosPorAmbos >= 6, `el corpus tiene que ejercer ids válidos (fueron ${aceptadosPorAmbos})`);
});

// =============================================================================
// CA-12 / CA-13 / CA-16 — cota, evicción y propagación de clearCache
// =============================================================================

test('CA-12/CA-16 · superar max_cached_tenants EVICTA la entrada más vieja en vez de crecer', () => {
  _resetVaultCache();
  const espia = espiarVaults();
  const logger = capturarLogs();
  try {
    const material = {};
    for (let i = 0; i < 4; i += 1) material[`proy-${i}`] = { alpha: { valor: `FAKE-${i}` } };
    const driver = driverSembrado({ material });
    const opts = { vaultConfig: cfg({ max_cached_tenants: 2 }), vaultDriver: driver, logger };

    const pedir = (projectId) => {
      const antes = driver.calls.length;
      const res = resolveInstanceVault({ projectId, scopes: ['alpha'] }, opts);
      return { res, llamadas: driver.calls.length - antes };
    };

    pedir('proy-0');                       // memo: [0]
    pedir('proy-1');                       // memo: [0,1]

    // El pedido que DISPARA la evicción tiene que devolver su propio material.
    // Afirmar sólo sobre efectos colaterales (llamadas al driver, clearCache)
    // deja pasar una evicción que revienta DESPUÉS de leer el secreto y ANTES
    // de guardarlo: el driver se llamó, la víctima se limpió, y aun así el
    // producto se queda sin credenciales. Por eso se chequea `res.ok` y el
    // valor devuelto, no el rastro que dejó el camino.
    const evictor = pedir('proy-2');       // cota 2 ⇒ evicta 0, memo: [1,2]
    assert.equal(evictor.res.ok, true,
      `el pedido que evicta devuelve ok:true (code=${evictor.res && evictor.res.code}, `
      + `error=${evictor.res && evictor.res.error})`);
    assert.deepEqual(evictor.res.scopes, { alpha: { valor: 'FAKE-2' } },
      'el pedido que evicta trae SU PROPIO material, no el de la víctima ni vacío');

    assert.equal(pedir('proy-1').llamadas, 0, 'proy-1 sigue cacheado');
    assert.ok(pedir('proy-0').llamadas > 0, 'proy-0 fue evictado: paga MISS');

    // CA-16 / G-5 — `clearCache()` de la VÍCTIMA fue invocado: si no, la capa
    // de abajo (`createSecretVault`) retendría plaintext más allá de la cota y
    // el límite sería una falsa sensación de acotamiento.
    const victima = espia.creados.find((v) => v.projectId === 'proy-0');
    assert.ok(victima, 'se creó un vault para proy-0');
    assert.ok(victima.limpiezas >= 1, 'clearCache() de la víctima fue invocado');
  } finally {
    espia.restaurar();
  }
});

test('CA-12 · superada la cota, el namespace EVICTOR queda cacheado (2da resolución = 0 llamadas)', () => {
  _resetVaultCache();
  const logger = capturarLogs();
  const material = {};
  for (let i = 0; i < 3; i += 1) material[`proy-${i}`] = { alpha: { valor: `FAKE-${i}` } };
  const driver = driverSembrado({ material });
  const opts = { vaultConfig: cfg({ max_cached_tenants: 2 }), vaultDriver: driver, logger };

  const pedir = (projectId) => {
    const antes = driver.calls.length;
    const res = resolveInstanceVault({ projectId, scopes: ['alpha'] }, opts);
    return { res, llamadas: driver.calls.length - antes };
  };

  pedir('proy-0');
  pedir('proy-1');
  pedir('proy-2');   // evicta a proy-0 y debe QUEDAR en la memo

  // El corazón de CA-12: evictar es hacerle lugar a la entrada nueva. Si la
  // escritura del evictor no llega a la memo, tras cada evicción el mapa queda
  // POR DEBAJO de la cota y el thrash que CA-10 acredita con 2 tenants vuelve
  // entero apenas se supera la cota — la evicción sería pura pérdida.
  const repetido = pedir('proy-2');
  assert.equal(repetido.res.ok, true, 'la 2da resolución del evictor sigue siendo ok');
  assert.equal(repetido.llamadas, 0,
    'el namespace que disparó la evicción quedó cacheado: 0 llamadas al driver');
  assert.deepEqual(repetido.res.scopes, { alpha: { valor: 'FAKE-2' } },
    'y devuelve su propio material desde la memo');
});

test('CA-13 · la evicción emite un warn con NOMBRES, la cota y el impacto — sin un solo valor', () => {
  _resetVaultCache();
  const logger = capturarLogs();
  const material = {
    'proyecto-a': { alpha: { valor: 'FAKE-proy-a-ALPHA' } },
    'proyecto-b': { alpha: { valor: 'FAKE-proy-b-ALPHA' } },
  };
  const driver = driverSembrado({ material });
  const opts = { vaultConfig: cfg({ max_cached_tenants: 1 }), vaultDriver: driver, logger };

  resolveInstanceVault({ projectId: 'proyecto-a', scopes: ['alpha'] }, opts);
  resolveInstanceVault({ projectId: 'proyecto-b', scopes: ['alpha'] }, opts);

  const texto = logger.texto();
  assert.match(texto, /eviccion del namespace del vault/i, 'hay warn de evicción');
  assert.match(texto, /proyecto-a/, 'nombra el namespace evictado');
  assert.match(texto, /max_cached_tenants` = 1/, 'nombra la palanca CON su valor actual');
  assert.match(texto, /AWS CLI/, 'nombra el impacto: el próximo acceso paga un MISS');
  // CA-13 — nombres, jamás valores.
  assert.ok(!texto.includes('FAKE-proy-a-ALPHA') && !texto.includes('FAKE-proy-b-ALPHA'),
    'el warn no lleva un solo valor de secreto');
});

test('UX-OPS-1 · el warn de evicción tiene cooldown por namespace y acumula el contador', () => {
  _resetVaultCache();
  const logger = capturarLogs();
  let ahora = 1_000_000;
  const material = {
    'proyecto-a': { alpha: { valor: 'FAKE-A' } },
    'proyecto-b': { alpha: { valor: 'FAKE-B' } },
  };
  const driver = driverSembrado({ material });
  const opts = {
    vaultConfig: cfg({ max_cached_tenants: 1 }), vaultDriver: driver, logger, now: () => ahora,
  };

  // Thrash deliberado: la cota corta evicta en cada alternancia. `loadIntoEnv`
  // corre por lanzamiento de agente, así que sin cooldown esto inunda pulpo.log.
  for (let i = 0; i < 6; i += 1) {
    ahora += 1_000;
    resolveInstanceVault({ projectId: i % 2 === 0 ? 'proyecto-a' : 'proyecto-b', scopes: ['alpha'] }, opts);
  }
  const avisosA = logger.lineas.filter((l) => /eviccion/i.test(l) && l.includes('proyecto-a')).length;
  assert.equal(avisosA, 1, `un aviso por namespace por ventana (fueron ${avisosA})`);

  // Pasada la ventana vuelve a sonar, y arrastra el contador acumulado: si no,
  // la señal de "la cota quedó corta" se pierde.
  ahora += 6 * 60 * 1000;
  resolveInstanceVault({ projectId: 'proyecto-a', scopes: ['alpha'] }, opts);
  resolveInstanceVault({ projectId: 'proyecto-b', scopes: ['alpha'] }, opts);
  const conContador = logger.lineas.filter((l) => /eviccion/i.test(l) && /eviccion\/es mas/.test(l));
  assert.ok(conContador.length >= 1, 'el aviso siguiente reporta las evicciones acumuladas de la ventana');
});

test('CA-16 · _resetVaultCache vacía el Map Y propaga clearCache a cada vault memoizado', () => {
  _resetVaultCache();
  const espia = espiarVaults();
  try {
    const driver = driverSembrado();
    const opts = { vaultConfig: cfg(), vaultDriver: driver, logger: () => {} };
    resolveInstanceVault({ projectId: 'proyecto-a', scopes: ['alpha'] }, opts);
    resolveInstanceVault({ projectId: 'proyecto-b', scopes: ['alpha'] }, opts);

    _resetVaultCache();
    for (const v of espia.creados) {
      assert.ok(v.limpiezas >= 1, `clearCache() propagado a ${v.projectId}`);
    }

    // Y la memo quedó vacía de verdad: los dos vuelven a pagar MISS.
    const antes = driver.calls.length;
    resolveInstanceVault({ projectId: 'proyecto-a', scopes: ['alpha'] }, opts);
    assert.ok(driver.calls.length > antes, 'después del reset se vuelve a resolver');
  } finally {
    espia.restaurar();
  }
});

// =============================================================================
// CA-14 / REQ-SEC-5 — el TTL no se refresca en la lectura
// =============================================================================

test('CA-14/REQ-SEC-5 · N lecturas dentro de la ventana NO corren `expiraEn`', () => {
  _resetVaultCache();
  let ahora = 1_000_000;
  const driver = driverSembrado();
  const opts = {
    vaultConfig: cfg({ cache_ttl_seconds: 60 }), vaultDriver: driver, logger: () => {}, now: () => ahora,
  };
  const pedir = (projectId) => {
    const antes = driver.calls.length;
    resolveInstanceVault({ projectId, scopes: ['alpha'] }, opts);
    return driver.calls.length - antes;
  };

  assert.ok(pedir('proyecto-a') > 0, 'MISS inicial');
  // Diez lecturas repartidas dentro de la ventana: si la lectura refrescara el
  // vencimiento, la entrada nunca vencería y la revocación no surtiría efecto.
  for (let i = 0; i < 10; i += 1) {
    ahora += 5_000;
    assert.equal(pedir('proyecto-a'), 0, `lectura ${i} sale de la memo`);
  }
  assert.ok(ahora >= 1_050_000, 'las lecturas cubrieron casi toda la ventana');

  ahora += 11_000;   // total > 60 s desde la ESCRITURA
  assert.ok(pedir('proyecto-a') > 0, 'vencido el TTL se vuelve a resolver, sin importar el tráfico');
});

test('CA-14 · el tráfico de un tenant no prolonga la vigencia del material de otro', () => {
  _resetVaultCache();
  let ahora = 1_000_000;
  const driver = driverSembrado();
  const opts = {
    vaultConfig: cfg({ cache_ttl_seconds: 60 }), vaultDriver: driver, logger: () => {}, now: () => ahora,
  };
  const pedir = (projectId) => {
    const antes = driver.calls.length;
    resolveInstanceVault({ projectId, scopes: ['alpha'] }, opts);
    return driver.calls.length - antes;
  };

  pedir('proyecto-a');
  ahora += 30_000;
  pedir('proyecto-b');
  // 40 s de tráfico intenso de B...
  for (let i = 0; i < 4; i += 1) { ahora += 10_000; pedir('proyecto-b'); }
  // ...no le regalan a A un solo segundo: A escribió en t0 y ya pasaron 70 s.
  assert.ok(pedir('proyecto-a') > 0, 'la entrada de A venció en su propio horario');
});

// =============================================================================
// CA-15 / REQ-SEC-7 — fallo aislado por entrada
// =============================================================================

test('CA-15/REQ-SEC-7 · un fallo del tenant A no memoiza negativo, no evicta y no pisa la entrada de B', () => {
  _resetVaultCache();
  const driver = driverSembrado();   // sembrado sólo con alpha/beta de a y b
  const opts = { vaultConfig: cfg(), vaultDriver: driver, logger: () => {} };

  // B resuelve bien y queda memoizado.
  const b1 = resolveInstanceVault({ projectId: 'proyecto-b', scopes: ['alpha'] }, opts);
  assert.equal(b1.ok, true);
  const trasB = driver.calls.length;

  // A pide un scope que NO está en el vault ⇒ fail-closed para A solamente.
  const a1 = resolveInstanceVault({ projectId: 'proyecto-a', scopes: ['inexistente'] }, opts);
  assert.equal(a1.ok, false);
  assert.equal(a1.code, INSTANCE_VAULT_ERROR_CODES.VAULT_SCOPE_MISSING);

  // B sigue dando HIT: el fallo de A no lo evictó ni lo pisó.
  const antesB2 = driver.calls.length;
  const b2 = resolveInstanceVault({ projectId: 'proyecto-b', scopes: ['alpha'] }, opts);
  assert.equal(b2.ok, true);
  assert.equal(driver.calls.length, antesB2, 'la entrada válida de B sobrevivió al fallo de A');
  assert.ok(driver.calls.length > trasB - 1);

  // Y el fallo de A NO se memoizó negativo: se reintenta (así `aws login` o un
  // secreto recién cargado surten efecto sin reiniciar el Pulpo).
  const antesA2 = driver.calls.length;
  resolveInstanceVault({ projectId: 'proyecto-a', scopes: ['inexistente'] }, opts);
  assert.ok(driver.calls.length > antesA2, 'sin negative caching: el fallo se reintenta');
});

// =============================================================================
// CA-9 / G-3 — tier host por default, shared enumerado
// =============================================================================

test('CA-9/G-3 · el tier de un scope de instancia es `host` por default', () => {
  _resetVaultCache();
  const driver = driverSembrado();
  const r = resolveInstanceVault({ projectId: 'proyecto-a', scopes: ['alpha'] },
    { vaultConfig: cfg(), vaultDriver: driver, logger: () => {} });
  assert.equal(r.ok, true);
  assert.deepEqual(driver.calls.map((c) => c.root), [`${PREFIX}/proyecto-a/hosts/${HOST}/`]);
});

test('CA-9/G-3 · `shared` sólo si la instancia lo ENUMERA; nunca se infiere', () => {
  _resetVaultCache();
  // Material sembrado bajo `shared/` para el scope enumerado.
  const parameters = {
    [buildParameterPath({ prefix: PREFIX, projectId: 'proyecto-a', scope: 'alpha', tier: 'shared' })]:
      { valor: 'FAKE-compartido' },
    [buildParameterPath({ prefix: PREFIX, projectId: 'proyecto-a', hostId: HOST, scope: 'beta', tier: 'host' })]:
      { valor: 'FAKE-del-host' },
  };
  const driver = createInMemoryVaultDriver({ parameters });

  const r = resolveInstanceVault(
    { projectId: 'proyecto-a', scopes: ['alpha', 'beta'], sharedScopes: ['alpha'] },
    { vaultConfig: cfg(), vaultDriver: driver, logger: () => {} },
  );
  assert.equal(r.ok, true);
  assert.deepEqual(r.scopes.alpha, { valor: 'FAKE-compartido' });
  assert.deepEqual(r.scopes.beta, { valor: 'FAKE-del-host' });

  const raices = driver.calls.map((c) => c.root).sort();
  assert.deepEqual(raices, [`${PREFIX}/proyecto-a/hosts/${HOST}/`, `${PREFIX}/proyecto-a/shared/`]);

  // Sin enumerarlo, el mismo scope se busca en el namespace del host y NO se
  // encuentra: el aislamiento entre hosts es el default.
  _resetVaultCache();
  const driver2 = createInMemoryVaultDriver({ parameters });
  const sinEnumerar = resolveInstanceVault({ projectId: 'proyecto-a', scopes: ['alpha'] },
    { vaultConfig: cfg(), vaultDriver: driver2, logger: () => {} });
  assert.equal(sinEnumerar.ok, false, '`shared/` NO es el default');
  assert.equal(sinEnumerar.code, INSTANCE_VAULT_ERROR_CODES.VAULT_SCOPE_MISSING);
});

test('CA-9 · el tier participa de la clave de la memo: mismo scope, distinto tier ⇒ sin HIT falso', () => {
  _resetVaultCache();
  const parameters = {
    [buildParameterPath({ prefix: PREFIX, projectId: 'proyecto-a', scope: 'alpha', tier: 'shared' })]:
      { valor: 'FAKE-compartido' },
    [buildParameterPath({ prefix: PREFIX, projectId: 'proyecto-a', hostId: HOST, scope: 'alpha', tier: 'host' })]:
      { valor: 'FAKE-del-host' },
  };
  const driver = createInMemoryVaultDriver({ parameters });
  const opts = { vaultConfig: cfg(), vaultDriver: driver, logger: () => {} };

  const host = resolveInstanceVault({ projectId: 'proyecto-a', scopes: ['alpha'] }, opts);
  const compartido = resolveInstanceVault(
    { projectId: 'proyecto-a', scopes: ['alpha'], sharedScopes: ['alpha'] }, opts,
  );
  assert.deepEqual(host.scopes.alpha, { valor: 'FAKE-del-host' });
  assert.deepEqual(compartido.scopes.alpha, { valor: 'FAKE-compartido' },
    'el pedido `shared` no salió de la entrada `host` memoizada');
});

// =============================================================================
// CA-3 / REQ-SEC-10 — familia sin efectos sobre el ambiente
// =============================================================================

test('CA-3/REQ-SEC-10 · resolveInstanceVault no toca process.env (jamás pasa por loadIntoEnv)', () => {
  _resetVaultCache();
  const antes = JSON.stringify(process.env);
  const driver = driverSembrado();
  const r = resolveInstanceVault({ projectId: 'proyecto-a', scopes: ['alpha', 'beta'] },
    { vaultConfig: cfg(), vaultDriver: driver, logger: () => {} });
  assert.equal(r.ok, true);
  assert.equal(JSON.stringify(process.env), antes, 'process.env intacto, clave por clave');
});

// =============================================================================
// CA-17 / G-4 — gate cerrado ⇒ fail-closed diferenciado (UX-OPS-3)
// =============================================================================

test('CA-17/G-4 · con el gate cerrado se falla CERRADO y el texto distingue la causa', () => {
  _resetVaultCache();
  const driver = driverSembrado();
  const r = resolveInstanceVault({ projectId: 'proyecto-a', scopes: ['alpha'] },
    { vaultConfig: cfg({ enabled: false }), vaultDriver: driver, logger: () => {} });

  assert.equal(r.ok, false);
  assert.equal(r.code, INSTANCE_VAULT_ERROR_CODES.VAULT_DISABLED);
  assert.deepEqual(r.scopes, {}, 'nunca material parcial');
  assert.equal(driver.calls.length, 0, 'con el gate cerrado no se toca el driver');
  assert.match(r.error, /vault\.enabled/);
  assert.match(r.error, /NO es un problema de credenciales/,
    'UX-OPS-3: se remedia encendiendo el vault, no cargando un secreto');
});

test('CA-17 · sin scopes declarados se falla cerrado con causa propia', () => {
  _resetVaultCache();
  const driver = driverSembrado();
  const r = resolveInstanceVault({ projectId: 'proyecto-a', scopes: [] },
    { vaultConfig: cfg(), vaultDriver: driver, logger: () => {} });
  assert.equal(r.ok, false);
  assert.equal(r.code, INSTANCE_VAULT_ERROR_CODES.VAULT_SCOPES_REQUIRED);
  assert.equal(driver.calls.length, 0);
});

// =============================================================================
// CA-5 / CA-7 — overrides simétricos sobre el camino global
// =============================================================================

test('CA-5 · sin override, el camino global usa la identidad del kernel; con override, la de la instancia', () => {
  const parameters = {
    [buildParameterPath({ prefix: PREFIX, projectId: 'kernel', hostId: HOST, scope: 'providers', tier: 'host' })]:
      { openai: { api_key: 'FAKE-kernel-OPENAI' } },
    [buildParameterPath({ prefix: PREFIX, projectId: 'proyecto-b', hostId: HOST, scope: 'providers', tier: 'host' })]:
      { openai: { api_key: 'FAKE-proy-b-OPENAI' } },
  };
  const base = {
    vaultConfig: cfg({ required_scopes: ['providers'] }),
    vaultPlan: { ssm: ['providers'], secretsmanager: [] },
  };

  _resetVaultCache();
  assert.equal(
    resolveVaultOnly('providers.openai.api_key',
      { ...base, vaultDriver: createInMemoryVaultDriver({ parameters }) }),
    'FAKE-kernel-OPENAI', 'default = `cfg.projectId` (identidad del kernel)');

  _resetVaultCache();
  assert.equal(
    resolveVaultOnly('providers.openai.api_key',
      { ...base, projectId: 'proyecto-b', vaultDriver: createInMemoryVaultDriver({ parameters }) }),
    'FAKE-proy-b-OPENAI', 'con `opts.projectId` resuelve contra el namespace de la instancia');
});

test('CA-7 · la allowlist es por instancia: un scope no autorizado PARA ESA instancia falla, aunque otra lo tenga', () => {
  _resetVaultCache();
  const driver = driverSembrado();

  // `proyecto-a` autoriza sólo `alpha`; pedir `beta` con esa allowlist falla
  // aunque el material exista y aunque otra instancia sí tenga `beta`.
  const r = resolveInstanceVault({ projectId: 'proyecto-a', scopes: ['alpha'] },
    { vaultConfig: cfg(), vaultDriver: driver, logger: () => {} });
  assert.equal(r.ok, true);
  assert.deepEqual(Object.keys(r.scopes), ['alpha'], 'sólo lo que la instancia declaró');
  assert.equal(r.scopes.beta, undefined, 'el scope no pedido no se materializa');

  // Y la allowlist GLOBAL sigue vacía: si el camino de instancia se apoyara en
  // `vault.required_scopes` en vez de en la suya, nada de esto resolvería.
  assert.deepEqual(cfg().required_scopes, []);
});

// =============================================================================
// CA-12 / CA-18 — config.yaml
// =============================================================================

test('CA-12/CA-18 · config.yaml declara max_cached_tenants documentada y deja vault.enabled en false', () => {
  const yaml = fs.readFileSync(path.join(REPO_ROOT, '.pipeline/config.yaml'), 'utf8');
  const bloque = yaml.slice(yaml.indexOf('\nvault:'));

  assert.match(bloque, /^\s{2}max_cached_tenants:\s*\d+\s*$/m, 'la clave existe con un entero');
  // UX-OPS-4 — el comentario responde "¿qué número pongo?", no "¿qué es esto?".
  assert.match(bloque, /instancias.*(concurrentes|paralelo)/i,
    'documenta la relación con el máximo de instancias concurrentes');
  assert.match(bloque, /thrash/i, 'nombra el síntoma a buscar cuando la cota queda corta');
  // CA-18 — esta parte NO enciende nada.
  assert.match(bloque, /^\s{2}enabled:\s*false\s*$/m, 'vault.enabled sigue en false');
});
