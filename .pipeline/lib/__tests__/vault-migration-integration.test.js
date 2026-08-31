// =============================================================================
// vault-migration-integration.test.js — #5453 · migración multi-host end-to-end
// =============================================================================
//
// A diferencia de la suite de unidad, acá el coordinador se cablea contra las
// piezas REALES que consume en producción:
//
//   - `ENV_DESCRIPTORS` de `credentials.js` como denominador (N/N derivado, sin
//     literal congelado);
//   - `vault-shadow-metrics.js` como productor de evidencia (JSONL real en un
//     directorio temporal), para que la matriz de cobertura se arme con las
//     mismas filas que escribe `loadIntoEnv()`;
//   - `vault-cut-fallback.js` (#5452) como ÚNICO ejecutor del corte, con su
//     config.yaml de prueba.
//
// Lo que se prueba: múltiples hosts, respawn, cobertura positiva N/N derivada
// dinámicamente, fuentes legacy, caída de cobertura/allowlist antes del corte y
// delegación ÚNICA al ejecutor de #5452.
// =============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const yaml = require('js-yaml');

const { createVaultMigration, CAUSA, STAGE } = require('../vault-migration');
const { ENV_DESCRIPTORS } = require('../credentials');
const shadowMetrics = require('../vault-shadow-metrics');
const vaultCutFallback = require('../vault-cut-fallback');

// N se DERIVA. Si mañana entra un descriptor nuevo, este número cambia solo y
// los tests siguen siendo verdaderos — que es exactamente el pre-checklist.
const NOMBRES = Object.keys(ENV_DESCRIPTORS);
const N = NOMBRES.length;

const SCOPES_ESPERADOS = [...new Set(
  NOMBRES.filter((n) => ENV_DESCRIPTORS[n].backend !== 'file-only')
    .map((n) => (n.includes('.') ? n.slice(0, n.indexOf('.')) : n)),
)];
const COMPARTIDOS_ESPERADOS = [...new Set(
  NOMBRES.filter((n) => ENV_DESCRIPTORS[n].backend !== 'file-only' && ENV_DESCRIPTORS[n].shared === true)
    .map((n) => (n.includes('.') ? n.slice(0, n.indexOf('.')) : n)),
)];

const HOSTS = ['NOTEBOOK-01', 'NOTEBOOK-02'];

function tmpDir(prefijo) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefijo));
}

function reloj(desdeIso = '2026-08-31T08:00:00Z') {
  let ms = Date.parse(desdeIso);
  const fn = () => { ms += 1000; return ms; };
  fn.actual = () => ms;
  fn.saltar = (segundos) => { ms += segundos * 1000; return ms; };
  return fn;
}

/**
 * Banco de pruebas: coordinador + métricas sombra reales + config.yaml del
 * ejecutor de corte. Las dependencias operacionales (rotar, provisionar,
 * respawnear) se fingen porque tocan AWS y procesos vivos; TODO lo que decide
 * elegibilidad es código real.
 */
function banco(opciones = {}) {
  const stateDir = tmpDir('vm-int-state-');
  const auditDir = tmpDir('vm-int-audit-');
  const configDir = tmpDir('vm-int-cfg-');
  const configPath = path.join(configDir, 'config.yaml');
  const now = opciones.now || reloj();

  fs.writeFileSync(configPath, yaml.dump({
    vault: {
      enabled: true,
      bootstrap_fallback: opciones.bootstrapFallback === undefined ? true : opciones.bootstrapFallback,
      cut_fallback: {
        authorization_ttl_seconds: 300,
        operation_timeout_ms: 5000,
        runbook: 'docs/runbooks/credential-rotation.md',
      },
    },
  }));

  const metrics = shadowMetrics.createVaultShadowMetrics({
    auditDir,
    now: () => now.actual(),
    logger: () => {},
  });
  // El evaluador de #5427 persiste su t0 en la PRIMERA evaluación y esa pasada
  // nunca aprueba (por contrato: `t0_reiniciado` ⇒ `no_verificado`). Se ceba acá
  // para que la ventana del banco arranque en el instante inicial del reloj y
  // toda la evidencia posterior caiga adentro.
  metrics.evaluate({ descriptors: ENV_DESCRIPTORS, hostsActivos: HOSTS, durationHours: 0 });

  const llamadas = { rotate: [], provision: [], respawn: [], cutover: [], needsHuman: [], audit: [] };
  const politicas = new Map(HOSTS.map((h) => [h, {
    vaultOnly: true,
    allowlistSize: 1,
    requiredScopes: [...SCOPES_ESPERADOS],
    sharedSecrets: [...COMPARTIDOS_ESPERADOS],
  }]));

  const coordinador = createVaultMigration({
    stateDir,
    now,
    listDescriptors: () => ENV_DESCRIPTORS,
    resolveHostPolicy: (host) => politicas.get(host) || null,
    rotate: (args) => { llamadas.rotate.push(args); return { ok: true, version: `r-${args.host}` }; },
    provision: (args) => { llamadas.provision.push(args); return { ok: true }; },
    respawnConsumers: (args) => {
      llamadas.respawn.push(args);
      // Los consumidores de larga vida declarados en `restart.js`.
      return {
        ok: true,
        consumers: ['pulpo', 'dashboard', 'listener', 'svc-telegram', 'svc-github', 'svc-drive'],
      };
    },
    // Cobertura REAL: el evaluador de #5427 más sus filas crudas.
    readCoverage: () => {
      const evaluacion = metrics.evaluate({
        descriptors: ENV_DESCRIPTORS,
        hostsActivos: HOSTS,
        durationHours: 0,
      });
      return { ...evaluacion, rows: metrics.readRows() };
    },
    // Delegación al ejecutor REAL de #5452. El coordinador no escribe el config.
    requestCutover: async ({ snapshot, authorization }) => {
      llamadas.cutover.push({ snapshot, authorization });
      try {
        const r = await vaultCutFallback.executeVaultCutFallback({
          configPath,
          now: () => new Date(now.actual()),
          validateAllowlist: () => snapshot.hosts.every((h) => h.allowlist >= 1),
          evaluateCoverage: () => ({ ok: snapshot.ok === true }),
          authorization,
        });
        return { ok: true, status: r.alreadyCut ? 'already-cut' : 'cut' };
      } catch (e) {
        return { ok: false, status: 'precondition-failed', code: e.code };
      }
    },
    canPublishEvidence: () => (opciones.canPublish === undefined ? true : opciones.canPublish()),
    signalNeedsHuman: (e) => llamadas.needsHuman.push(e),
    writeAudit: (e) => llamadas.audit.push(e),
    ...(opciones.overrides || {}),
  });

  /**
   * Registra cobertura positiva para `host` con la MISMA API que usa
   * `loadIntoEnv()`: un mapa `env var → vía` más los descriptores y el hostId.
   */
  function cubrir(host, nombres = NOMBRES) {
    const sources = {};
    for (const name of nombres) sources[ENV_DESCRIPTORS[name].env] = 'vault';
    metrics.record(sources, { descriptors: ENV_DESCRIPTORS, hostId: host });
    metrics.flush();
  }

  function registrarNegativo(host, name, via = 'file-bootstrap') {
    metrics.record(
      { [ENV_DESCRIPTORS[name].env]: via },
      { descriptors: ENV_DESCRIPTORS, hostId: host },
    );
  }

  function autorizacionValida() {
    return { issuedAt: new Date(now.actual() - 30_000).toISOString(), consume: () => true };
  }

  function leerConfig() {
    return yaml.load(fs.readFileSync(configPath, 'utf8'));
  }

  return {
    coordinador, metrics, llamadas, politicas, now,
    stateDir, auditDir, configPath,
    cubrir, registrarNegativo, autorizacionValida, leerConfig,
  };
}

/** Lleva un host de cero a `respawned`. */
function migrar(b, host) {
  assert.equal(b.coordinador.preflight({ host }).ok, true, `preflight de ${host}`);
  assert.equal(b.coordinador.rotate({ host }).ok, true, `rotate de ${host}`);
  assert.equal(b.coordinador.provision({ host }).ok, true, `provision de ${host}`);
  assert.equal(b.coordinador.respawn({ host }).ok, true, `respawn de ${host}`);
}

/** Migra y cubre TODOS los hosts hasta `cutover-ready`. */
function migrarTodos(b) {
  for (const host of HOSTS) migrar(b, host);
  b.now.saltar(60);
  for (const host of HOSTS) b.cubrir(host);
  b.now.saltar(60);
  for (const host of HOSTS) {
    const r = b.coordinador.observeCoverage({ host });
    assert.equal(r.ok, true, `cobertura de ${host}: ${r.causa}`);
  }
}

// -----------------------------------------------------------------------------
// 1 · Inventario derivado — no hay literal congelado ni segunda lista
// -----------------------------------------------------------------------------

test('el denominador N se deriva de ENV_DESCRIPTORS, no de una lista paralela', () => {
  const b = banco();
  const r = b.coordinador.preflight({ host: HOSTS[0] });
  assert.equal(r.ok, true);
  assert.equal(r.evidencia.descriptores, N);
  assert.equal(r.evidencia.scopes, SCOPES_ESPERADOS.length);
  assert.ok(N > 0, 'el inventario real no puede estar vacio');
});

test('el rotador y el provisionador reciben el inventario DERIVADO', () => {
  const b = banco();
  migrar(b, HOSTS[0]);
  assert.deepEqual(b.llamadas.rotate[0].descriptors, NOMBRES);
  assert.deepEqual(b.llamadas.provision[0].scopes, SCOPES_ESPERADOS);
});

// -----------------------------------------------------------------------------
// 2 · Multi-host: cobertura N/N por host, aislada
// -----------------------------------------------------------------------------

test('con N/N por host y cero negativos, todos los hosts llegan a cutover-ready', () => {
  const b = banco();
  migrarTodos(b);
  for (const host of HOSTS) {
    assert.equal(b.coordinador.readState(host).stage, STAGE.CUTOVER_READY);
  }
  const snap = b.coordinador.coverageSnapshot({ hosts: HOSTS });
  assert.equal(snap.ok, true);
  assert.equal(snap.hosts_total, HOSTS.length);
  assert.equal(snap.hosts_listos, HOSTS.length);
  for (const h of snap.hosts) {
    assert.equal(h.cubiertos, N, `${h.host} deberia tener ${N}/${N}`);
    assert.equal(h.pendientes, 0);
  }
});

test('un host cubierto no habilita al otro: la matriz es por host', () => {
  const b = banco();
  for (const host of HOSTS) migrar(b, host);
  b.now.saltar(60);
  b.cubrir(HOSTS[0]);
  b.now.saltar(60);

  assert.equal(b.coordinador.observeCoverage({ host: HOSTS[0] }).ok, true);
  const segundo = b.coordinador.observeCoverage({ host: HOSTS[1] });
  assert.equal(segundo.ok, false);
  assert.equal(segundo.causa, CAUSA.HOST_SILENCIOSO);

  const snap = b.coordinador.coverageSnapshot({ hosts: HOSTS });
  assert.equal(snap.ok, false);
  assert.equal(snap.hosts_listos, 1);
});

test('cobertura parcial de un host reporta el faltante exacto contra N', () => {
  const b = banco();
  migrar(b, HOSTS[0]);
  b.now.saltar(60);
  b.cubrir(HOSTS[0], NOMBRES.slice(0, N - 1));
  b.now.saltar(60);
  const r = b.coordinador.observeCoverage({ host: HOSTS[0] });
  assert.equal(r.causa, CAUSA.COBERTURA_INCOMPLETA);
  assert.equal(r.evidencia.cubiertos, N - 1);
  assert.equal(r.evidencia.pendientes, 1);
});

test('un respawn nuevo REINICIA la ventana: la cobertura anterior deja de contar', () => {
  const b = banco();
  migrar(b, HOSTS[0]);
  b.now.saltar(60);
  b.cubrir(HOSTS[0]);
  b.now.saltar(60);
  assert.equal(b.coordinador.observeCoverage({ host: HOSTS[0] }).ok, true);

  // Rotación de emergencia ⇒ hay que volver a provisionar y respawnear.
  // El coordinador nunca retrocede solo, así que se simula el ciclo nuevo
  // borrando el estado del host y rehaciendo la máquina desde cero.
  fs.unlinkSync(path.join(b.stateDir, `host-${HOSTS[0]}.json`));
  b.now.saltar(600);
  migrar(b, HOSTS[0]);
  b.now.saltar(60);
  const r = b.coordinador.observeCoverage({ host: HOSTS[0] });
  assert.equal(r.ok, false);
  assert.equal(r.causa, CAUSA.COBERTURA_PREVIA_AL_RESPAWN,
    'la evidencia previa al respawn nuevo no puede acreditar la ventana nueva');
});

// -----------------------------------------------------------------------------
// 3 · Fuentes legacy
// -----------------------------------------------------------------------------

test('una resolucion por file-bootstrap despues del respawn tumba la ventana', () => {
  const b = banco();
  migrarTodos(b);
  b.now.saltar(60);
  b.registrarNegativo(HOSTS[0], NOMBRES[0], 'file-bootstrap');
  const r = b.coordinador.observeCoverage({ host: HOSTS[0] });
  assert.equal(r.ok, false);
  assert.equal(r.causa, CAUSA.FUENTE_LEGACY);
  assert.equal(b.coordinador.readState(HOSTS[0]).stage, STAGE.COEXISTING,
    'la caida de cobertura retrocede a coexisting, nunca por debajo');
});

test('un secreto que no resuelve (`missing`) tambien es evidencia negativa', () => {
  const b = banco();
  migrarTodos(b);
  b.now.saltar(60);
  b.registrarNegativo(HOSTS[1], NOMBRES[0], 'missing');
  assert.equal(b.coordinador.observeCoverage({ host: HOSTS[1] }).causa, CAUSA.FUENTE_LEGACY);
});

// -----------------------------------------------------------------------------
// 4 · Corte: delegación ÚNICA a #5452
// -----------------------------------------------------------------------------

test('el corte se delega al ejecutor de #5452, que es el unico que escribe el config', async () => {
  const b = banco();
  migrarTodos(b);
  assert.equal(b.leerConfig().vault.bootstrap_fallback, true);

  const r = await b.coordinador.cutover({ hosts: HOSTS, authorization: b.autorizacionValida() });
  assert.equal(r.ok, true);
  assert.equal(b.llamadas.cutover.length, 1);
  assert.equal(b.leerConfig().vault.bootstrap_fallback, false,
    'el estado del fallback lo escribe el ejecutor de #5452');
  for (const host of HOSTS) {
    assert.equal(b.coordinador.readState(host).stage, STAGE.VERIFIED);
  }
});

test('el snapshot que viaja al ejecutor es informativo y esta sanitizado', async () => {
  const b = banco();
  migrarTodos(b);
  await b.coordinador.cutover({ hosts: HOSTS, authorization: b.autorizacionValida() });
  const { snapshot } = b.llamadas.cutover[0];
  assert.equal(snapshot.hosts.length, HOSTS.length);
  const permitidas = new Set([
    'host', 'stage', 'listo', 'causa', 'descriptores', 'cubiertos', 'pendientes',
    'negativos', 'resoluciones', 'allowlist', 'respawn_ts', 'rotacion_version',
  ]);
  for (const h of snapshot.hosts) {
    for (const clave of Object.keys(h)) {
      assert.ok(permitidas.has(clave), `el snapshot filtra la clave "${clave}"`);
    }
    assert.equal(typeof h.cubiertos, 'number');
  }
  const serializado = JSON.stringify(snapshot);
  assert.ok(!/credentials\.json|AKIA|sk-ant|\/intrale\//.test(serializado),
    'el snapshot no puede llevar paths, IDs de infraestructura ni material');
});

test('un segundo corte NO vuelve a delegar: la delegacion es unica', async () => {
  const b = banco();
  migrarTodos(b);
  assert.equal((await b.coordinador.cutover({ hosts: HOSTS, authorization: b.autorizacionValida() })).ok, true);
  const segundo = await b.coordinador.cutover({ hosts: HOSTS, authorization: b.autorizacionValida() });
  assert.equal(segundo.ok, false);
  assert.equal(segundo.causa, CAUSA.CORTE_YA_DELEGADO);
  assert.equal(b.llamadas.cutover.length, 1, 'el ejecutor no puede llamarse dos veces');
});

test('un fallback YA cortado resuelve idempotente, sin transicion nueva', async () => {
  const b = banco({ bootstrapFallback: false });
  migrarTodos(b);
  const r = await b.coordinador.cutover({ hosts: HOSTS, authorization: b.autorizacionValida() });
  assert.equal(r.ok, true, 'already-cut es exito, no error');
  assert.equal(b.leerConfig().vault.bootstrap_fallback, false);
});

// -----------------------------------------------------------------------------
// 5 · Caída de criterio ANTES del corte (TOCTOU)
// -----------------------------------------------------------------------------

test('si la cobertura cae entre la ventana y el corte, NO se delega nada', async () => {
  const b = banco();
  migrarTodos(b);
  // Evidencia negativa justo antes de pedir el corte.
  b.now.saltar(60);
  b.registrarNegativo(HOSTS[0], NOMBRES[0], 'file-bootstrap');

  const r = await b.coordinador.cutover({ hosts: HOSTS, authorization: b.autorizacionValida() });
  assert.equal(r.ok, false);
  assert.equal(r.causa, CAUSA.HOST_NO_LISTO);
  assert.equal(b.llamadas.cutover.length, 0, 'el ejecutor no puede haberse invocado');
  assert.equal(b.leerConfig().vault.bootstrap_fallback, true, 'el fallback se CONSERVA');
});

test('si la allowlist se vacia entre la ventana y el corte, NO se delega nada', async () => {
  const b = banco();
  migrarTodos(b);
  b.politicas.set(HOSTS[1], { ...b.politicas.get(HOSTS[1]), allowlistSize: 0 });

  const r = await b.coordinador.cutover({ hosts: HOSTS, authorization: b.autorizacionValida() });
  assert.equal(r.ok, false);
  assert.equal(b.llamadas.cutover.length, 0);
  assert.equal(b.leerConfig().vault.bootstrap_fallback, true);
});

test('un host que nunca migro bloquea el corte de todo el parque', async () => {
  const b = banco();
  migrar(b, HOSTS[0]);
  b.now.saltar(60);
  b.cubrir(HOSTS[0]);
  b.now.saltar(60);
  b.coordinador.observeCoverage({ host: HOSTS[0] });

  const r = await b.coordinador.cutover({ hosts: HOSTS, authorization: b.autorizacionValida() });
  assert.equal(r.ok, false);
  assert.equal(b.llamadas.cutover.length, 0);
});

test('sin hosts declarados el corte es fail-closed, no vacuamente cierto', async () => {
  const b = banco();
  const r = await b.coordinador.cutover({ hosts: [], authorization: b.autorizacionValida() });
  assert.equal(r.ok, false);
  assert.equal(r.causa, CAUSA.HOSTS_AUSENTES);
  assert.equal(b.llamadas.cutover.length, 0);
});

// -----------------------------------------------------------------------------
// 6 · Drive/Telegram ausentes — nunca cortar por silencio
// -----------------------------------------------------------------------------

test('sin canal para publicar evidencia se conserva el fallback y se pide humano', async () => {
  const b = banco({ canPublish: () => false });
  migrarTodos(b);
  const r = await b.coordinador.cutover({ hosts: HOSTS, authorization: b.autorizacionValida() });
  assert.equal(r.ok, false);
  assert.equal(r.causa, CAUSA.EVIDENCIA_NO_PUBLICABLE);
  assert.equal(b.llamadas.cutover.length, 0);
  assert.equal(b.leerConfig().vault.bootstrap_fallback, true);
  assert.equal(b.llamadas.needsHuman.length, 1);
  // La señal local que ve el humano tampoco puede llevar material.
  assert.deepEqual(
    Object.keys(b.llamadas.needsHuman[0]).sort(),
    ['causa', 'event', 'hosts', 'hosts_listos', 'ok', 'ts'],
  );
});

test('un detector de canal que explota se lee como canal ausente', async () => {
  const b = banco({ canPublish: () => { throw new Error('telegram caido'); } });
  migrarTodos(b);
  const r = await b.coordinador.cutover({ hosts: HOSTS, authorization: b.autorizacionValida() });
  assert.equal(r.causa, CAUSA.EVIDENCIA_NO_PUBLICABLE);
  assert.equal(b.leerConfig().vault.bootstrap_fallback, true);
});

// -----------------------------------------------------------------------------
// 7 · Autorización — la valida #5452, no este módulo
// -----------------------------------------------------------------------------

test('una autorizacion expirada la rechaza el ejecutor de #5452, no el coordinador', async () => {
  const b = banco();
  migrarTodos(b);
  const vencida = { issuedAt: new Date(b.now.actual() - 3_600_000).toISOString(), consume: () => true };
  const r = await b.coordinador.cutover({ hosts: HOSTS, authorization: vencida });
  assert.equal(r.ok, false);
  assert.equal(r.causa, CAUSA.CORTE_RECHAZADO);
  assert.equal(b.llamadas.cutover.length, 1, 'el coordinador SI delega: la decision es del ejecutor');
  assert.equal(b.leerConfig().vault.bootstrap_fallback, true);
});

test('tras un rechazo del ejecutor se puede reintentar: no queda trabado', async () => {
  const b = banco();
  migrarTodos(b);
  const vencida = { issuedAt: new Date(b.now.actual() - 3_600_000).toISOString(), consume: () => true };
  assert.equal((await b.coordinador.cutover({ hosts: HOSTS, authorization: vencida })).ok, false);
  const r = await b.coordinador.cutover({ hosts: HOSTS, authorization: b.autorizacionValida() });
  assert.equal(r.ok, true);
  assert.equal(b.leerConfig().vault.bootstrap_fallback, false);
});

// -----------------------------------------------------------------------------
// 8 · Reanudación multi-host desde disco
// -----------------------------------------------------------------------------

test('un proceso nuevo reanuda el parque sin repetir rotaciones', () => {
  const b = banco();
  migrar(b, HOSTS[0]);
  b.coordinador.preflight({ host: HOSTS[1] });
  b.coordinador.rotate({ host: HOSTS[1] });
  const rotacionesPrimeraPasada = b.llamadas.rotate.length;
  assert.equal(rotacionesPrimeraPasada, 2);

  const rotacionesSegundaPasada = [];
  const segundo = createVaultMigration({
    stateDir: b.stateDir,
    now: b.now,
    listDescriptors: () => ENV_DESCRIPTORS,
    resolveHostPolicy: (host) => b.politicas.get(host) || null,
    rotate: (args) => { rotacionesSegundaPasada.push(args); return { ok: true, version: 'x' }; },
    provision: () => ({ ok: true }),
    respawnConsumers: () => ({ ok: true, consumers: ['pulpo'] }),
    readCoverage: () => ({ estado: 'cumple', rows: [] }),
  });
  assert.deepEqual(segundo.listHosts(), [...HOSTS].sort());
  for (const host of HOSTS) {
    segundo.preflight({ host });
    segundo.rotate({ host });
  }
  assert.equal(rotacionesSegundaPasada.length, 0,
    'reanudar no puede emitir material nuevo en ningun host');
  assert.equal(segundo.readState(HOSTS[0]).stage, STAGE.RESPAWNED);
  assert.equal(segundo.readState(HOSTS[1]).stage, STAGE.ROTATED);
});

// -----------------------------------------------------------------------------
// 9 · Coherencia de fuente cruzada con el config.yaml COMMITEADO (CA-25)
// -----------------------------------------------------------------------------
//
// Este bloque no ejercita el coordinador con fixtures: mira el config REAL del
// repo. Es lo que impide que el inventario se separe del código en silencio —
// exactamente el riesgo "inventario manual diverge de código/config".

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

function configCommiteado() {
  return yaml.load(fs.readFileSync(path.join(REPO_ROOT, '.pipeline', 'config.yaml'), 'utf8'));
}

test('CA-25 · `vault.required_scopes` del repo coincide con lo DERIVADO de ENV_DESCRIPTORS', () => {
  const { required_scopes: declarados } = configCommiteado().vault;
  assert.ok(Array.isArray(declarados) && declarados.length > 0,
    'una lista vacia se cumpliria vacuamente: es `inventario_incompleto`, no "todo declarado"');
  assert.deepEqual([...declarados].sort(), [...SCOPES_ESPERADOS].sort(),
    'El inventario del vault se separo del codigo. Al agregar un descriptor hay que '
    + 'actualizar `vault.required_scopes` en el MISMO commit: si falta, ese secreto '
    + 'cae al archivo sin que nadie lo note.');
});

test('CA-25 · `vault.shared_secrets` coincide con los descriptores `shared: true`', () => {
  const { shared_secrets: compartidos } = configCommiteado().vault;
  assert.deepEqual([...compartidos].sort(), [...COMPARTIDOS_ESPERADOS].sort(),
    'Un scope compartido sin descriptor que lo respalde saca material del namespace '
    + 'del host al comun sin que el codigo lo pida.');
});

test('CA-25 · el config commiteado PASA el preflight del coordinador', () => {
  const vault = configCommiteado().vault;
  const stateDir = tmpDir('vm-cfg-real-');
  const c = createVaultMigration({
    stateDir,
    now: reloj(),
    listDescriptors: () => ENV_DESCRIPTORS,
    resolveHostPolicy: () => ({
      // Se fuerzan los dos ejes que NO son del inventario (el gate del vault se
      // commitea cerrado y la allowlist depende del entorno vivo), para que el
      // test mida exactamente lo que le toca: el inventario.
      vaultOnly: true,
      allowlistSize: 1,
      requiredScopes: vault.required_scopes,
      sharedSecrets: vault.shared_secrets,
    }),
  });
  const r = c.evaluatePreflight('NOTEBOOK-01');
  assert.equal(r.ok, true, `el config commiteado no pasa el preflight: ${r.causa}`);
  assert.equal(r.descriptores, N);
});

test('el gate de rollout del coordinador se commitea CERRADO', () => {
  const vault = configCommiteado().vault;
  assert.equal(vault.enabled, false, '`vault.enabled` debe commitearse cerrado');
  assert.equal(vault.migration.enabled, false,
    '`vault.migration.enabled` debe commitearse cerrado: el rollout es gradual');
  assert.equal(vault.migration.auto_cutover, false,
    'el corte NUNCA se automatiza: exige capability firmada por el operador');
  assert.deepEqual(vault.migration.auto_stages, ['observe'],
    'rotate/provision/respawn NO se automatizan: emiten material irreversible o '
    + 'bajan al propio Pulpo (bucle de muerte de 2026-07)');
});

test('el config conserva UNA sola ventana `bootstrap_fallback`', () => {
  const texto = fs.readFileSync(path.join(REPO_ROOT, '.pipeline', 'config.yaml'), 'utf8');
  const ocurrencias = texto.match(/^ {2}bootstrap_fallback:/gm) || [];
  assert.equal(ocurrencias.length, 1,
    'con mas de una ventana, `renderCutDocument()` de #5452 no sabe cual cortar y falla');
});
