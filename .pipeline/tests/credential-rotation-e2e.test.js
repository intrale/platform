// =============================================================================
// E2E de rotación de credenciales del vault SIN reiniciar el coordinador (#5802)
// node --test  (entra por el glob existente de `npm run test:pipeline`)
// =============================================================================
//
// Qué demuestra, de punta a punta y en UNA sola operación raíz:
//
//   CA-1  `resetVaultCache(scope)` invalida todas las capas y una generación
//         vieja retenida en vuelo NO repuebla la nueva ni se publica.
//   CA-2  Las solicitudes concurrentes equivalentes comparten UNA sola lectura
//         física, y el vuelo se libera tanto tras éxito como tras error.
//   CA-3  Un lanzamiento posterior usa la nueva versión opaca sin reiniciar el
//         coordinador; el snapshot ya entregado al lanzamiento previo no muta.
//   CA-4  Tras el único retry permitido, otro rechazo impide el lanzamiento de
//         modo fail-closed; las señales que NO son `authentication_rejected`
//         no invalidan ni consumen el presupuesto.
//   CA-5  La evidencia sólo contiene scope lógico, launch/operation id, versión
//         opaca, estado y timestamps — y ni ella, ni los eventos, ni los
//         errores, ni las capturas de stdout/stderr contienen los canarios
//         completos ni fragmentos sensibles.
//
// Este archivo es un HARNESS sobre los contratos públicos que ya mergearon
// (#5791/#5792): no reimplementa caché, generación, clasificador ni presupuesto
// de retry. Todo lo controlable se inyecta por firma (driver, reloj, config):
// no se toca red, ni AWS, ni el `process.env` real, ni el archivo de
// credenciales. Por eso corre en milisegundos y no ensucia la batería.
//
// Sobre la "versión opaca": el módulo NO expone la generación interna de la
// caché (es estado privado, sin getter — a propósito). La versión opaca de la
// evidencia la asigna el ESCENARIO al sembrar cada generación del driver: es un
// identificador lógico y arbitrario (`gen-a1`, `gen-b2`), NO un hash ni nada
// derivado del secreto. Eso es justamente lo que pide el CA: correlacionar
// lanzamientos sin publicar material.
// =============================================================================
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const credentials = require('../lib/credentials');
const {
  createCredentialSnapshot,
  redactSnapshot,
  resetVaultCache,
  resetVaultCacheAll,
  scopesInvalidables,
} = credentials;
const { buildParameterPath, createInMemoryVaultDriver } = require('../lib/secret-vault');
const credentialRetry = require('../lib/credential-auth-retry');
const {
  createOperation,
  runWithCredentialRetry: correrConRetry,
  RETRY_EVENTS,
  CLOSE_REASONS,
  RETRY_ERROR_CODES,
  EVENT_FIELDS,
} = credentialRetry;
const { AUTH_REJECTED_CLASS } = require('../lib/agent-launcher/dispatch-with-fallback');
const { makeAuditEmitter } = require('../lib/credential-retry-wiring');
const buildChildEnvLib = require('../lib/build-child-env');

// -----------------------------------------------------------------------------
// Identidad del escenario. Nada de esto sale de `process.env` ni del disco.
// -----------------------------------------------------------------------------
const PREFIX = '/intrale';
const PROJECT = 'intrale';
const HOST = 'hostTest';
const SCOPE = 'providers';
const PROVIDER = 'anthropic';
const DESTINO = 'agent-child';

// Canarios sintéticos. NO son tokens reales y no tienen el formato de ninguno:
// su único trabajo es aparecer (o no) en la evidencia. Los fragmentos son
// prefijos suficientemente largos como para que un truncado "prudente" de un
// secreto real también los dispare.
const CANARIO_A = 'canario-5802-GEN-A-NO-ES-UN-TOKEN-REAL';
const CANARIO_B = 'canario-5802-GEN-B-NO-ES-UN-TOKEN-REAL';
const FRAGMENTOS = ['canario-5802', 'GEN-A-NO-ES', 'GEN-B-NO-ES'];

// Versiones OPACAS: identificadores lógicos del escenario, sin relación
// computable con el material. Rotar el secreto rota la versión declarada.
const VERSION_A = 'gen-a1';
const VERSION_B = 'gen-b2';

const TTL_SEGUNDOS = 300;

function configVault(over = {}) {
  return {
    enabled: true,
    prefix: PREFIX,
    projectId: PROJECT,
    hostId: HOST,
    cache_ttl_seconds: TTL_SEGUNDOS,
    // `shared_secrets` tiene que ser coherente con `required_scopes`: el
    // validador canónico del vault rechaza una config donde se declara
    // compartido un scope que no se pidió (fail-closed, `VaultConfigError`).
    required_scopes: [SCOPE],
    shared_secrets: [SCOPE],
    bootstrap_fallback: false,
    bootstrap_fallback_until: '',
    region: 'us-east-2',
    ...over,
  };
}

function rutaScope(scope = SCOPE, tier = 'shared') {
  return buildParameterPath({ prefix: PREFIX, projectId: PROJECT, hostId: HOST, scope, tier });
}

/** Namespace del vault con UNA generación del material del provider. */
function seedGeneracion(apiKey) {
  return {
    parameters: { [rutaScope()]: { [PROVIDER]: { api_key: apiKey } } },
    secrets: {},
  };
}

/**
 * Driver del vault controlable: cuenta lecturas FÍSICAS, permite retener una
 * lectura en vuelo (`abrir()`) y rotar la generación sembrada (`reseed()`).
 * El contador es propio (no el del driver in-memory) para que sobreviva al
 * reseed: sin eso, rotar reiniciaría la evidencia de cardinalidad.
 */
function driverControlado(seed = seedGeneracion(CANARIO_A), { abierta = true } = {}) {
  let base = createInMemoryVaultDriver(seed);
  const calls = [];
  let liberar;
  const puerta = new Promise((res) => { liberar = res; });
  if (abierta) liberar();
  return {
    kind: 'controlado',
    calls,
    reseed(nuevo) { base = createInMemoryVaultDriver(nuevo); },
    abrir() { liberar(); },
    getParametersByPathSync(root) {
      calls.push({ op: 'getParametersByPath', root });
      return base.getParametersByPathSync(root);
    },
    getSecretValueSync(name) {
      calls.push({ op: 'getSecretValue', name });
      return base.getSecretValueSync(name);
    },
    async getParametersByPath(root) {
      await puerta;
      calls.push({ op: 'getParametersByPath', root });
      return base.getParametersByPathSync(root);
    },
    async getSecretValue(name) {
      await puerta;
      calls.push({ op: 'getSecretValue', name });
      return base.getSecretValueSync(name);
    },
  };
}

/** Driver que SIEMPRE falla: sirve para ver si el vuelo se libera tras error. */
function driverQueFalla(motivo = 'VAULT_DOWN') {
  const calls = [];
  const romper = () => {
    const err = new Error(`[fake] el vault no contesta (${motivo})`);
    err.code = motivo;
    throw err;
  };
  return {
    kind: 'caido',
    calls,
    getParametersByPathSync() { calls.push({ op: 'getParametersByPath' }); return romper(); },
    getSecretValueSync() { calls.push({ op: 'getSecretValue' }); return romper(); },
    async getParametersByPath() { calls.push({ op: 'getParametersByPath' }); return romper(); },
    async getSecretValue() { calls.push({ op: 'getSecretValue' }); return romper(); },
  };
}

/** Cede el event loop varias veces sin avanzar el reloj del escenario. */
async function tick(n = 10) {
  for (let i = 0; i < n; i += 1) await new Promise((res) => setImmediate(res));
}

/** Un "lanzamiento": resuelve el snapshot del destino contra el driver dado. */
function lanzar(driver, { now, config } = {}) {
  return createCredentialSnapshot({
    destination: DESTINO,
    scopes: [SCOPE],
    provider: PROVIDER,
    namespace: PROJECT,
    vaultConfig: config || configVault(),
    vaultDriver: driver,
    now: typeof now === 'function' ? now : () => 1_000_000,
    logger: () => {},
  });
}

// -----------------------------------------------------------------------------
// Sink de evidencia con ALLOWLIST CERRADA (#5802 · CA-5)
// -----------------------------------------------------------------------------
//
// La evidencia no se "filtra al escribir": se CONSTRUYE desde una allowlist. Un
// campo que no esté en la lista hace fallar el registro en el acto, que es la
// diferencia entre una política y un buen deseo. No se persisten hashes ni
// valores derivados del secreto: un hash estable es un oráculo de igualdad
// entre generaciones.
const CAMPOS_EVIDENCIA = Object.freeze([
  'scope', 'operation_id', 'launch_id', 'opaque_version', 'status', 'ts',
]);

function crearSinkEvidencia() {
  const registros = [];
  return {
    registros,
    escribir(registro) {
      const claves = Object.keys(registro);
      const fuera = claves.filter((k) => !CAMPOS_EVIDENCIA.includes(k));
      if (fuera.length > 0) {
        throw new Error(`[evidencia] campos fuera de la allowlist: ${fuera.join(', ')}`);
      }
      for (const [k, v] of Object.entries(registro)) {
        const escalar = (typeof v === 'string' || typeof v === 'number' || v === null);
        if (!escalar) throw new Error(`[evidencia] "${k}" no es escalar: ${typeof v}`);
      }
      registros.push(Object.freeze({ ...registro }));
      return registros[registros.length - 1];
    },
    serializar() { return JSON.stringify(registros); },
  };
}

/**
 * Busca canarios COMPLETOS y fragmentos en un texto ya serializado. Devuelve
 * los hallazgos por NOMBRE de canario/fragmento: nunca reimprime el material
 * encontrado, porque un assert que filtra el secreto en su mensaje de error es
 * la misma fuga que estaba buscando.
 */
function buscarMaterial(texto, etiqueta) {
  const s = String(texto == null ? '' : texto);
  const hallazgos = [];
  if (s.includes(CANARIO_A)) hallazgos.push(`${etiqueta}: canario completo A`);
  if (s.includes(CANARIO_B)) hallazgos.push(`${etiqueta}: canario completo B`);
  for (const frag of FRAGMENTOS) {
    if (s.includes(frag)) hallazgos.push(`${etiqueta}: fragmento "${frag}"`);
  }
  return hallazgos;
}

/** Serializa cualquier cosa (incluidos Error) sin perder sus campos propios. */
function serializarProfundo(valor) {
  if (valor instanceof Error) {
    const plano = { name: valor.name, message: valor.message, stack: valor.stack };
    for (const k of Object.getOwnPropertyNames(valor)) {
      try { plano[k] = valor[k]; } catch { /* getter hostil: se ignora */ }
    }
    return JSON.stringify(plano, (_k, v) => (v instanceof Error ? String(v) : v));
  }
  try {
    return JSON.stringify(valor, (_k, v) => (v instanceof Error ? String(v) : v));
  } catch {
    return String(valor);
  }
}

/** Veredicto tipado de rechazo de credencial, tal como lo emite el dispatcher. */
function rechazoAuth({ attempt = 1, code = 'authentication_error', status = 401 } = {}) {
  return Object.freeze({
    errorClass: 'auth',
    authenticationRejection: Object.freeze({
      kind: AUTH_REJECTED_CLASS,
      provider: PROVIDER,
      operationId: 'op-5802',
      path: 'primary',
      attempt,
      signal: Object.freeze({ source: 'cli-stream-json', code, status, type: null }),
    }),
  });
}

/** Veredicto SIN rechazo de credencial (cualquier otra clase de fallo o éxito). */
function veredictoSinAuth(extra = {}) {
  return { errorClass: 'unknown', authenticationRejection: null, ...extra };
}

// =============================================================================
// CA-1 · Invalidación total y generación vieja que no repuebla
// =============================================================================

test('#5802 CA-1 · resetVaultCache invalida la capa del scope y el siguiente lanzamiento relee', async () => {
  resetVaultCacheAll();
  const d = driverControlado(seedGeneracion(CANARIO_A));

  const primero = await lanzar(d);
  assert.equal(primero.env.ANTHROPIC_API_KEY, CANARIO_A);
  assert.equal(d.calls.length, 1, 'primer lanzamiento: una lectura fisica');

  await lanzar(d);
  assert.equal(d.calls.length, 1, 'segundo lanzamiento dentro del TTL: hit de memo, cero lecturas');

  assert.deepEqual(resetVaultCache(SCOPE), { scope: SCOPE, invalidadas: 1 });
  assert.deepEqual(resetVaultCache(SCOPE), { scope: SCOPE, invalidadas: 0 }, 'idempotente');

  d.reseed(seedGeneracion(CANARIO_B));
  const tercero = await lanzar(d);
  assert.equal(d.calls.length, 2, 'tras el reset hubo relectura fisica');
  assert.equal(tercero.env.ANTHROPIC_API_KEY, CANARIO_B, 'el lanzamiento nuevo ve la generacion nueva');

  assert.ok(scopesInvalidables().includes(SCOPE), 'el scope del destino es invalidable por contrato');
});

test('#5802 CA-1 · una lectura de la generacion vieja que aterriza DESPUES del reset no repuebla ni se publica', async () => {
  resetVaultCacheAll();
  const d = driverControlado(seedGeneracion(CANARIO_A), { abierta: false });

  // Generación A sale a leer y queda retenida en la puerta.
  const enVuelo = lanzar(d);
  await tick();
  assert.equal(d.calls.length, 0, 'la puerta sigue cerrada: todavia no leyo nadie');

  // Rotación mientras A está en vuelo: material nuevo + invalidación acotada.
  d.reseed(seedGeneracion(CANARIO_B));
  assert.equal(resetVaultCache(SCOPE).scope, SCOPE);

  d.abrir();
  const resuelto = await enVuelo;

  assert.equal(resuelto.env.ANTHROPIC_API_KEY, CANARIO_B,
    'la publicacion de la generacion vieja quedo vetada: el resultado es el de la generacion nueva');
  assert.equal(d.calls.length, 2, 'el veto obligo a releer en vez de publicar material viejo');

  // Y la memo tampoco quedó envenenada con A.
  const posterior = await lanzar(d);
  assert.equal(posterior.env.ANTHROPIC_API_KEY, CANARIO_B);
  assert.equal(d.calls.length, 2, 'el lanzamiento posterior salio de la memo ya repoblada con la generacion nueva');
});

// =============================================================================
// CA-2 · Single-flight
// =============================================================================

test('#5802 CA-2 · lanzamientos concurrentes equivalentes comparten UNA sola lectura fisica', async () => {
  resetVaultCacheAll();
  const d = driverControlado(seedGeneracion(CANARIO_A), { abierta: false });

  const vuelos = [lanzar(d), lanzar(d), lanzar(d), lanzar(d)];
  await tick();
  assert.equal(d.calls.length, 0, 'nadie leyo mientras la puerta estaba cerrada');

  d.abrir();
  const snaps = await Promise.all(vuelos);

  assert.equal(d.calls.length, 1, 'los cuatro se colgaron del MISMO vuelo');
  for (const s of snaps) assert.equal(s.env.ANTHROPIC_API_KEY, CANARIO_A);

  // Cada snapshot es material NUEVO: mutar uno no alcanza a los otros ni a la caché.
  snaps[0].env.ANTHROPIC_API_KEY = 'mutado-por-el-test';
  assert.equal(snaps[1].env.ANTHROPIC_API_KEY, CANARIO_A, 'los snapshots no comparten el contenedor');
});

test('#5802 CA-2 · el vuelo se libera tras EXITO y tras ERROR (no queda un single-flight zombi)', async () => {
  resetVaultCacheAll();

  // 1) tras éxito: invalidar y volver a pedir vuelve a leer.
  const ok = driverControlado(seedGeneracion(CANARIO_A));
  await lanzar(ok);
  assert.equal(resetVaultCache(SCOPE).invalidadas, 1);
  await lanzar(ok);
  assert.equal(ok.calls.length, 2, 'el vuelo anterior no bloqueo la relectura');

  // 2) tras error: el primer pedido falla y el segundo NO se cuelga del vuelo muerto.
  resetVaultCacheAll();
  const caido = driverQueFalla();
  await assert.rejects(() => lanzar(caido), (e) => {
    assert.equal(e.name, 'CredentialSnapshotError');
    assert.equal(e.code, credentials.SNAPSHOT_ERROR_CODES.SNAPSHOT_VAULT_FAILURE);
    return true;
  });
  await assert.rejects(() => lanzar(caido), (e) => e.code === credentials.SNAPSHOT_ERROR_CODES.SNAPSHOT_VAULT_FAILURE);
  assert.ok(caido.calls.length >= 2, 'el segundo pedido volvio a intentar: el vuelo fallido se libero');
});

// =============================================================================
// CA-3 · TTL 300 y rotación entre lanzamientos SIN reiniciar el coordinador
// =============================================================================

test('#5802 CA-3 · el TTL de 300 s vence por su cuenta y es ortogonal al reset', async () => {
  resetVaultCacheAll();
  const d = driverControlado(seedGeneracion(CANARIO_A));
  let reloj = 1_000_000;
  const now = () => reloj;

  await lanzar(d, { now });
  assert.equal(d.calls.length, 1);

  reloj += (TTL_SEGUNDOS - 1) * 1000;
  await lanzar(d, { now });
  assert.equal(d.calls.length, 1, 'dentro del TTL: hit');

  reloj += 2_000;
  await lanzar(d, { now });
  assert.equal(d.calls.length, 2, 'vencido el TTL: relee sin que nadie haya invalidado');

  assert.equal(resetVaultCache(SCOPE).invalidadas, 1);
  await lanzar(d, { now });
  assert.equal(d.calls.length, 3, 'el reset invalida aunque el TTL estuviera vigente');
});

test('#5802 CA-3 · un lanzamiento posterior usa la version opaca nueva sin reiniciar el coordinador', async () => {
  resetVaultCacheAll();
  const sink = crearSinkEvidencia();
  const d = driverControlado(seedGeneracion(CANARIO_A));
  let reloj = 1_700_000_000_000;
  const now = () => reloj;
  const marca = () => new Date(reloj).toISOString();

  // Lanzamiento 1 — generación A.
  const launch1 = await lanzar(d, { now });
  sink.escribir({
    scope: SCOPE, launch_id: 'launch-1', operation_id: 'op-5802',
    opaque_version: VERSION_A, status: 'resolved', ts: marca(),
  });
  assert.equal(launch1.env.ANTHROPIC_API_KEY, CANARIO_A);

  // Rotación en caliente: material nuevo + invalidación acotada. Nadie reinicia
  // el proceso, nadie recarga el módulo, nadie toca `process.env`.
  reloj += 5_000;
  d.reseed(seedGeneracion(CANARIO_B));
  const invalidacion = resetVaultCache(SCOPE);
  sink.escribir({
    scope: invalidacion.scope, launch_id: null, operation_id: 'op-5802',
    opaque_version: VERSION_B, status: 'rotated', ts: marca(),
  });

  // Lanzamiento 2 — generación B, mismo proceso.
  reloj += 5_000;
  const launch2 = await lanzar(d, { now });
  sink.escribir({
    scope: SCOPE, launch_id: 'launch-2', operation_id: 'op-5802',
    opaque_version: VERSION_B, status: 'resolved', ts: marca(),
  });

  assert.equal(launch2.env.ANTHROPIC_API_KEY, CANARIO_B, 'el lanzamiento nuevo ya usa la generacion rotada');
  assert.equal(launch1.env.ANTHROPIC_API_KEY, CANARIO_A,
    'el snapshot ya entregado al lanzamiento anterior permanece ESTABLE (no se le rota el piso)');
  assert.equal(d.calls.length, 2, 'exactamente una lectura fisica por generacion');

  // La evidencia correlaciona los dos lanzamientos por versión opaca...
  const versiones = sink.registros.map((r) => r.opaque_version);
  assert.deepEqual(versiones, [VERSION_A, VERSION_B, VERSION_B]);
  // ...y no publica una sola cosa capaz de reconstruir el material.
  assert.deepEqual(buscarMaterial(sink.serializar(), 'evidencia'), []);
});

// =============================================================================
// CA-4 · Retry único y fallo cerrado
// =============================================================================

/**
 * Cablea la operación raíz REAL: `createSnapshot` es el snapshot de #5798 sobre
 * el driver fake y `invalidate` es el `resetVaultCache` público. No hay dobles
 * del coordinador: lo único inyectado es el vault.
 */
function cablearOperacion({ driver, operation, ejecuciones, emit, now }) {
  const usados = [...ejecuciones];
  const snapshots = [];
  const invalidaciones = [];
  return {
    snapshots,
    invalidaciones,
    correr: () => correrConRetry({
      operation,
      provider: PROVIDER,
      path: 'primary',
      destination: DESTINO,
      now: typeof now === 'function' ? now : () => 1_700_000_000_000,
      emit,
      createSnapshot: async (ctx) => {
        const snap = await lanzar(driver);
        snapshots.push({ attempt: ctx.attempt, snapshot: snap });
        return snap;
      },
      invalidate: (scope) => {
        const res = resetVaultCache(scope);
        invalidaciones.push(res);
        return res;
      },
      execute: async ({ attempt }) => {
        const siguiente = usados.shift();
        if (typeof siguiente === 'function') return siguiente({ attempt });
        return siguiente;
      },
    }),
  };
}

test('#5802 CA-4 · un rechazo tipado gasta EXACTAMENTE un retry, invalida y re-resuelve contra la generacion nueva', async () => {
  resetVaultCacheAll();
  const d = driverControlado(seedGeneracion(CANARIO_A));
  const op = createOperation({ operationId: 'op-5802' });
  const eventos = [];

  const cableado = cablearOperacion({
    driver: d,
    operation: op,
    emit: (e) => eventos.push(e),
    ejecuciones: [
      // Intento 1: el provider rechaza la credencial. Entre medio, el operador
      // rota el material en el vault (eso es lo que arregla el rechazo).
      () => { d.reseed(seedGeneracion(CANARIO_B)); return rechazoAuth({ attempt: 1 }); },
      // Intento 2: con el material re-resuelto, pasa.
      () => veredictoSinAuth({ ok: true }),
    ],
  });

  const res = await cableado.correr();

  assert.equal(res.ok, true);
  assert.equal(res.attempts, 2);
  assert.equal(res.retryUsed, true);
  assert.equal(op.invalidations, 1, 'exactamente una invalidacion');
  assert.equal(op.reresolutions, 1, 'exactamente una re-resolucion');
  assert.equal(op.retryConsumed, true);

  assert.equal(cableado.snapshots.length, 2);
  assert.equal(cableado.snapshots[0].snapshot.env.ANTHROPIC_API_KEY, CANARIO_A,
    'el intento 1 corrio con la generacion que el provider rechazo');
  assert.equal(cableado.snapshots[1].snapshot.env.ANTHROPIC_API_KEY, CANARIO_B,
    'el intento 2 corrio con la generacion NUEVA: la invalidacion llego hasta la lectura fisica');
  assert.equal(d.calls.length, 2, 'una lectura fisica por generacion, ni una de mas');

  const nombres = eventos.map((e) => e.event);
  assert.deepEqual(nombres, [RETRY_EVENTS.INVALIDATED, RETRY_EVENTS.RERESOLVED]);
});

test('#5802 CA-4 · tras el retry permitido, el segundo rechazo cierra la operacion sin cache vieja ni fallback silencioso', async () => {
  resetVaultCacheAll();
  const d = driverControlado(seedGeneracion(CANARIO_A));
  const op = createOperation({ operationId: 'op-5802-cerrada' });
  const eventos = [];

  const cableado = cablearOperacion({
    driver: d,
    operation: op,
    emit: (e) => eventos.push(e),
    ejecuciones: [
      () => { d.reseed(seedGeneracion(CANARIO_B)); return rechazoAuth({ attempt: 1 }); },
      () => rechazoAuth({ attempt: 2 }),
      // Una tercera ejecución NO debería llegar a usarse nunca.
      () => { throw new Error('[test] hubo un TERCER intento: el presupuesto se rompio'); },
    ],
  });

  let capturado = null;
  await assert.rejects(() => cableado.correr(), (e) => {
    capturado = e;
    assert.equal(e.name, 'CredentialRetryError');
    assert.equal(e.code, RETRY_ERROR_CODES.CLOSED);
    assert.equal(e.reason, CLOSE_REASONS.SECOND_REJECTION);
    assert.equal(e.attempt, 2);
    assert.equal(e.scope, SCOPE);
    return true;
  });

  assert.equal(op.invalidations, 1, 'una sola invalidacion pese a los dos rechazos');
  assert.equal(op.reresolutions, 1, 'una sola re-resolucion');
  assert.equal(cableado.snapshots.length, 2, 'no hubo un tercer snapshot');
  assert.equal(d.calls.length, 2);

  const nombres = eventos.map((e) => e.event);
  assert.deepEqual(nombres, [RETRY_EVENTS.INVALIDATED, RETRY_EVENTS.RERESOLVED, RETRY_EVENTS.RETRY_CLOSED]);

  // Fail-closed de verdad: no se devolvió resultado, y la caché NO conserva la
  // generación que el provider rechazó.
  const posterior = await lanzar(d);
  assert.equal(posterior.env.ANTHROPIC_API_KEY, CANARIO_B,
    'lo que sobrevive en la caché es la generacion nueva, nunca la vieja');

  // Ni el error ni los eventos llevan material.
  assert.deepEqual(buscarMaterial(serializarProfundo(capturado), 'error'), []);
  assert.deepEqual(buscarMaterial(serializarProfundo(eventos), 'eventos'), []);
});

test('#5802 CA-4 · ningun fallback reinicia el presupuesto: N rechazos en la MISMA operacion raiz = 1 invalidacion', async () => {
  resetVaultCacheAll();
  const op = createOperation({ operationId: 'op-5802-cadena' });
  let invalidaciones = 0;
  let snapshots = 0;

  // Cinco eslabones de la cadena (primario + fallbacks) que rechazan siempre.
  for (let n = 0; n < 5; n += 1) {
    await assert.rejects(() => correrConRetry({
      operation: op,
      provider: `provider-${n}`,
      path: n === 0 ? 'primary' : `fallback:${n}`,
      destination: DESTINO,
      now: () => 1_700_000_000_000,
      createSnapshot: async () => { snapshots += 1; return { destination: DESTINO, keys: [], env: {} }; },
      invalidate: (scope) => { invalidaciones += 1; return { scope, invalidadas: 1 }; },
      execute: async ({ attempt }) => rechazoAuth({ attempt }),
    }), (e) => e.name === 'CredentialRetryError');
  }

  assert.equal(invalidaciones, 1, 'el presupuesto es de la OPERACION RAIZ, no del eslabon');
  assert.equal(op.invalidations, 1);
  assert.equal(op.reresolutions, 1);
  // 2 snapshots del primer eslabón (intento 1 + re-resolución) + 1 por eslabón
  // restante, que se cierra por presupuesto agotado antes de re-resolver.
  assert.equal(snapshots, 6);
});

test('#5802 CA-4 · las senales que NO son authentication_rejected no invalidan, no reintentan y no gastan presupuesto', async () => {
  const senales = [
    ['timeout', () => { const e = new Error('[fake] timeout del provider'); e.code = 'ETIMEDOUT'; throw e; }],
    ['5xx', () => veredictoSinAuth({ errorClass: 'server', status: 503 })],
    ['cuota', () => veredictoSinAuth({ errorClass: 'quota', status: 429 })],
    ['permisos', () => veredictoSinAuth({ errorClass: 'authorization', status: 403 })],
    ['configuracion', () => veredictoSinAuth({ errorClass: 'config' })],
    ['texto libre', () => veredictoSinAuth({ errorClass: 'unknown', stderr: 'authentication error (texto libre, sin senal tipada)' })],
  ];

  for (const [etiqueta, ejecucion] of senales) {
    const op = createOperation({ operationId: `op-5802-${etiqueta.replace(/\s+/g, '-')}` });
    let invalidaciones = 0;
    const eventos = [];

    const correr = () => correrConRetry({
      operation: op,
      provider: PROVIDER,
      path: 'primary',
      destination: DESTINO,
      now: () => 1_700_000_000_000,
      emit: (e) => eventos.push(e),
      createSnapshot: async () => ({ destination: DESTINO, keys: [], env: {} }),
      invalidate: (scope) => { invalidaciones += 1; return { scope, invalidadas: 1 }; },
      execute: async () => ejecucion(),
    });

    if (etiqueta === 'timeout') {
      await assert.rejects(correr, (e) => e.code === 'ETIMEDOUT');
    } else {
      const res = await correr();
      assert.equal(res.ok, true, `${etiqueta}: sale como resultado, no como rechazo de credencial`);
      assert.equal(res.attempts, 1, `${etiqueta}: no hubo reintento`);
      assert.equal(res.retryUsed, false);
    }

    assert.equal(invalidaciones, 0, `${etiqueta}: no invalido nada`);
    assert.equal(op.retryConsumed, false, `${etiqueta}: el presupuesto sigue intacto`);
    assert.equal(op.invalidations, 0);
    assert.deepEqual(eventos, [], `${etiqueta}: no emitio un solo evento de credencial`);
  }
});

test('#5802 CA-4 · una senal ruidosa NO desarma el retry: el rechazo tipado posterior todavia tiene su presupuesto', async () => {
  const op = createOperation({ operationId: 'op-5802-mixta' });
  let invalidaciones = 0;

  // Primero, un 5xx: no consume presupuesto.
  const ruido = await correrConRetry({
    operation: op, provider: PROVIDER, path: 'primary', destination: DESTINO,
    now: () => 1_700_000_000_000,
    createSnapshot: async () => ({ destination: DESTINO, keys: [], env: {} }),
    invalidate: (scope) => { invalidaciones += 1; return { scope, invalidadas: 1 }; },
    execute: async () => veredictoSinAuth({ errorClass: 'server', status: 503 }),
  });
  assert.equal(ruido.ok, true);
  assert.equal(op.retryConsumed, false);

  // Después, el rechazo real: todavía le queda su único retry.
  const real = await correrConRetry({
    operation: op, provider: PROVIDER, path: 'primary', destination: DESTINO,
    now: () => 1_700_000_000_000,
    createSnapshot: async () => ({ destination: DESTINO, keys: [], env: {} }),
    invalidate: (scope) => { invalidaciones += 1; return { scope, invalidadas: 1 }; },
    execute: async ({ attempt }) => (attempt === 1 ? rechazoAuth({ attempt }) : veredictoSinAuth({ ok: true })),
  });

  assert.equal(real.ok, true);
  assert.equal(real.retryUsed, true);
  assert.equal(invalidaciones, 1);
});

// =============================================================================
// CA-5 · Evidencia allowlisted y ausencia de material en TODOS los canales
// =============================================================================

test('#5802 CA-5 · la evidencia se construye desde una allowlist cerrada y rechaza cualquier campo extra', () => {
  const sink = crearSinkEvidencia();
  const ok = sink.escribir({
    scope: SCOPE, operation_id: 'op-5802', launch_id: 'launch-1',
    opaque_version: VERSION_A, status: 'resolved', ts: '2026-09-05T00:00:00.000Z',
  });
  assert.deepEqual(Object.keys(ok).sort(), [...CAMPOS_EVIDENCIA].sort());

  // Un campo con material NO se redacta: se rechaza. La allowlist es la política.
  assert.throws(
    () => sink.escribir({ scope: SCOPE, api_key: CANARIO_A, status: 'resolved', ts: 'x' }),
    /campos fuera de la allowlist: api_key/,
  );
  // Tampoco entra un objeto anidado, que es por donde se cuela un payload entero.
  assert.throws(
    () => sink.escribir({ scope: SCOPE, status: { nested: CANARIO_A }, ts: 'x' }),
    /no es escalar/,
  );
  assert.equal(sink.registros.length, 1, 'los rechazados no quedaron persistidos');
  assert.deepEqual(buscarMaterial(sink.serializar(), 'evidencia'), []);
});

test('#5802 CA-5 · ni la evidencia, ni los eventos, ni los errores, ni las capturas de stdout/stderr contienen material', async () => {
  resetVaultCacheAll();
  const sink = crearSinkEvidencia();
  const d = driverControlado(seedGeneracion(CANARIO_A));
  const op = createOperation({ operationId: 'op-5802-evidencia' });
  const eventos = [];
  // Captura de los canales de proceso: el harness escribe acá lo que un runner
  // real volcaría a stdout/stderr, y después se audita entero.
  const capturas = [];
  const logger = (msg) => capturas.push(msg);

  let cerrado = null;
  const cableado = cablearOperacion({
    driver: d,
    operation: op,
    emit: (e) => { eventos.push(e); logger(`[retry] ${JSON.stringify(e)}`); },
    ejecuciones: [
      () => { d.reseed(seedGeneracion(CANARIO_B)); return rechazoAuth({ attempt: 1 }); },
      () => rechazoAuth({ attempt: 2 }),
    ],
  });

  await assert.rejects(() => cableado.correr(), (e) => { cerrado = e; return true; });

  // La evidencia del ciclo, construida desde la allowlist.
  sink.escribir({ scope: SCOPE, operation_id: op.operationId, launch_id: 'launch-1', opaque_version: VERSION_A, status: 'rejected', ts: '2026-09-05T00:00:00.000Z' });
  sink.escribir({ scope: SCOPE, operation_id: op.operationId, launch_id: null, opaque_version: VERSION_B, status: 'rotated', ts: '2026-09-05T00:00:01.000Z' });
  sink.escribir({ scope: SCOPE, operation_id: op.operationId, launch_id: 'launch-2', opaque_version: VERSION_B, status: 'closed', ts: '2026-09-05T00:00:02.000Z' });

  // Lo que un log SÍ puede llevar de un snapshot: la forma redactada.
  for (const { snapshot } of cableado.snapshots) {
    const red = redactSnapshot(snapshot);
    assert.equal(red.ok, true);
    assert.deepEqual(red.envVars, ['ANTHROPIC_API_KEY'], 'nombres de variable, nunca valores');
    logger(`[snapshot] ${JSON.stringify(red)}`);
  }
  logger(`[error] ${serializarProfundo(cerrado)}`);

  const canales = [
    ['evidencia', sink.serializar()],
    ['eventos', serializarProfundo(eventos)],
    ['error', serializarProfundo(cerrado)],
    ['capturas', capturas.join('\n')],
  ];

  const fugas = canales.flatMap(([etiqueta, texto]) => buscarMaterial(texto, etiqueta));
  assert.deepEqual(fugas, [], `hay material en canales auditados: ${fugas.join(' · ')}`);

  // Los eventos, además, sólo usan el vocabulario declarado del coordinador.
  for (const e of eventos) {
    const fuera = Object.keys(e).filter((k) => !EVENT_FIELDS.includes(k));
    assert.deepEqual(fuera, [], `evento con campos no declarados: ${fuera.join(', ')}`);
  }

  // Y la evidencia no persiste hashes ni nada derivable del secreto: las
  // versiones opacas son los identificadores lógicos que sembró el escenario.
  const versiones = new Set(sink.registros.map((r) => r.opaque_version));
  assert.deepEqual([...versiones].sort(), [VERSION_A, VERSION_B].sort());
});

test('#5802 CA-5 · el sink de auditoria REAL escribe JSONL sin material (no un doble del test)', async () => {
  resetVaultCacheAll();
  const d = driverControlado(seedGeneracion(CANARIO_A));
  const op = createOperation({ operationId: 'op-5802-auditoria' });

  // `fs` fake: capturamos exactamente los bytes que el emisor de PRODUCCIÓN
  // habría escrito en `.pipeline/logs/credential-retry-<fecha>.jsonl`.
  const escrituras = [];
  const fsFake = {
    mkdirSync: () => {},
    appendFileSync: (file, contenido) => { escrituras.push({ file, contenido }); },
  };
  const emitirAuditoria = makeAuditEmitter({
    pipelineDir: '/tmp/pipeline-inexistente-5802',
    fsImpl: fsFake,
    now: () => 1_700_000_000_000,
    logger: () => {},
  });

  const cableado = cablearOperacion({
    driver: d,
    operation: op,
    emit: emitirAuditoria,
    ejecuciones: [
      () => { d.reseed(seedGeneracion(CANARIO_B)); return rechazoAuth({ attempt: 1 }); },
      () => rechazoAuth({ attempt: 2 }),
    ],
  });

  await assert.rejects(() => cableado.correr(), (e) => e.name === 'CredentialRetryError');

  assert.equal(escrituras.length, 3, 'los tres eventos del ciclo llegaron al JSONL');
  assert.ok(escrituras.every((w) => w.file.endsWith('.jsonl')), 'el destino es el JSONL de auditoria');

  const jsonl = escrituras.map((w) => w.contenido).join('');
  assert.deepEqual(buscarMaterial(jsonl, 'jsonl'), [], 'la auditoria persistida no lleva material');

  // Cada línea es un JSON válido y su vocabulario es el declarado.
  const lineas = jsonl.trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(lineas.map((l) => l.event),
    [RETRY_EVENTS.INVALIDATED, RETRY_EVENTS.RERESOLVED, RETRY_EVENTS.RETRY_CLOSED]);
  for (const l of lineas) {
    const fuera = Object.keys(l).filter((k) => !EVENT_FIELDS.includes(k));
    assert.deepEqual(fuera, [], `linea de auditoria con campos no declarados: ${fuera.join(', ')}`);
    assert.equal(l.scope, SCOPE, 'la auditoria nombra el SCOPE logico, no el path fisico del vault');
    assert.equal(l.operation_id, op.operationId);
  }
});

test('#5802 CA-5 · buildChildEnv sigue siendo la frontera final: el child no recibe el material del vault ni el token reservado', () => {
  const operatorEnv = {
    PATH: process.env.PATH || '',
    TELEGRAM_BOT_TOKEN: CANARIO_A,
    ALGUNA_COPIA: CANARIO_A,
    OTRA: 'valor-inocuo',
  };

  const filtrado = buildChildEnvLib.stripReservedChildSecrets({ ...operatorEnv }, operatorEnv);

  assert.equal(Object.prototype.hasOwnProperty.call(filtrado, 'TELEGRAM_BOT_TOKEN'), false,
    'la reservada se cae por NOMBRE');
  assert.equal(Object.prototype.hasOwnProperty.call(filtrado, 'ALGUNA_COPIA'), false,
    'un alias con el MISMO valor se cae por VALOR');
  assert.equal(filtrado.OTRA, 'valor-inocuo', 'lo que no es material sigue viajando');

  const fugas = Object.entries(filtrado)
    .filter(([, v]) => String(v) === CANARIO_A)
    .map(([k]) => k);
  assert.deepEqual(fugas, [], 'ninguna variable del child lleva el canario por valor');

  // La auditoría de lo descartado nombra claves, nunca valores.
  const auditado = buildChildEnvLib.auditDroppedEnvVars(operatorEnv);
  assert.deepEqual(buscarMaterial(serializarProfundo(auditado), 'auditoria'), []);
});
