// =============================================================================
// vault-migration.test.js — #5453 · unidad del coordinador de migración
// =============================================================================
//
// Cubre lo que el issue declara obligatorio para esta suite: orden estricto
// rotar→provisionar, preflight vault-only, inventario completo derivado,
// persistencia/reanudación, aislamiento entre hosts, crash entre etapas y
// bloqueo ante evidencia incompleta.
// =============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  createVaultMigration, sanitizeEvidence, STAGES, STAGE, CAUSA,
} = require('../vault-migration');

// -----------------------------------------------------------------------------
// Fixtures
// -----------------------------------------------------------------------------

const DESCRIPTORES = Object.freeze({
  'telegram.bot_token': { env: 'TELEGRAM_BOT_TOKEN', backend: 'ssm', shared: true },
  'telegram.chat_id': { env: 'TELEGRAM_CHAT_ID', backend: 'ssm', shared: true },
  'providers.anthropic.api_key': { env: 'ANTHROPIC_API_KEY', backend: 'ssm', shared: true },
  'google_drive.oauth_refresh_token': { env: 'GOOGLE_OAUTH_REFRESH_TOKEN', backend: 'secretsmanager', shared: true },
});

const SCOPES = ['telegram', 'providers', 'google_drive'];
const NOMBRES = Object.keys(DESCRIPTORES);

function tmpDir(prefijo = 'vault-mig-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefijo));
}

/**
 * Reloj monótono controlado: cada lectura avanza 1 s. Alcanza para que los
 * timestamps de respawn y de las filas de evidencia sean comparables sin
 * depender del reloj real.
 */
function reloj(desdeIso = '2026-08-31T10:00:00Z') {
  let ms = Date.parse(desdeIso);
  const fn = () => { ms += 1000; return ms; };
  fn.actual = () => ms;
  fn.saltar = (segundos) => { ms += segundos * 1000; return ms; };
  return fn;
}

function politicaOk(overrides = {}) {
  return {
    vaultOnly: true,
    allowlistSize: 2,
    requiredScopes: [...SCOPES],
    sharedSecrets: [...SCOPES],
    ...overrides,
  };
}

/** Filas de evidencia con cobertura N/N para `host`, fechadas en `ts`. */
function filasCompletas(host, ts, extra = []) {
  return [
    ...NOMBRES.map((name) => ({ name, host, via: 'vault', count: 3, ts, last_ts: ts })),
    ...extra,
  ];
}

function crear(overrides = {}) {
  const dir = overrides.stateDir || tmpDir();
  const llamadas = { rotate: [], provision: [], respawn: [], cutover: [], audit: [], needsHuman: [] };
  const now = overrides.now || reloj();
  const coordinador = createVaultMigration({
    stateDir: dir,
    now,
    listDescriptors: () => DESCRIPTORES,
    resolveHostPolicy: () => politicaOk(),
    rotate: (args) => { llamadas.rotate.push(args); return { ok: true, version: 'r1' }; },
    provision: (args) => { llamadas.provision.push(args); return { ok: true }; },
    respawnConsumers: (args) => {
      llamadas.respawn.push(args);
      return { ok: true, consumers: ['pulpo', 'dashboard', 'listener', 'svc-telegram', 'svc-drive'] };
    },
    readCoverage: () => ({ estado: 'cumple', rows: [] }),
    requestCutover: (args) => { llamadas.cutover.push(args); return { ok: true, status: 'cut' }; },
    canPublishEvidence: () => true,
    writeAudit: (e) => llamadas.audit.push(e),
    signalNeedsHuman: (e) => llamadas.needsHuman.push(e),
    ...overrides,
  });
  return { coordinador, llamadas, dir, now };
}

// -----------------------------------------------------------------------------
// 1 · Preflight (CA-22 / CA-25)
// -----------------------------------------------------------------------------

test('el preflight aprueba con ancla vault-only, allowlist no vacia e inventario completo', () => {
  const { coordinador } = crear();
  const r = coordinador.preflight({ host: 'HOST-A' });
  assert.equal(r.ok, true);
  assert.equal(r.stage, STAGE.PREFLIGHT);
  assert.equal(r.evidencia.descriptores, NOMBRES.length);
  assert.equal(r.evidencia.scopes, SCOPES.length);
  assert.equal(r.evidencia.allowlist, 2);
});

test('el preflight rechaza si el ancla no es vault-only (solo el booleano true exacto abre)', () => {
  for (const valor of ['true', 1, undefined, null, false]) {
    const { coordinador } = crear({ resolveHostPolicy: () => politicaOk({ vaultOnly: valor }) });
    const r = coordinador.preflight({ host: 'HOST-A' });
    assert.equal(r.ok, false, `vaultOnly=${JSON.stringify(valor)} no deberia aprobar`);
    assert.equal(r.causa, CAUSA.ANCLA_NO_VAULT_ONLY);
  }
});

test('el preflight rechaza con allowlist vacia y NO persiste etapa', () => {
  const { coordinador } = crear({ resolveHostPolicy: () => politicaOk({ allowlistSize: 0 }) });
  const r = coordinador.preflight({ host: 'HOST-A' });
  assert.equal(r.ok, false);
  assert.equal(r.causa, CAUSA.ALLOWLIST_VACIA);
  assert.equal(coordinador.readState('HOST-A'), null);
});

test('`required_scopes: []` es inventario INCOMPLETO, no "todo declarado" (fail-open cerrado)', () => {
  const { coordinador } = crear({
    resolveHostPolicy: () => politicaOk({ requiredScopes: [], sharedSecrets: [] }),
  });
  const r = coordinador.preflight({ host: 'HOST-A' });
  assert.equal(r.ok, false);
  assert.equal(r.causa, CAUSA.INVENTARIO_INCOMPLETO);
});

test('el preflight rechaza un scope faltante en `required_scopes`', () => {
  const { coordinador } = crear({
    resolveHostPolicy: () => politicaOk({ requiredScopes: ['telegram', 'providers'] }),
  });
  assert.equal(coordinador.preflight({ host: 'HOST-A' }).causa, CAUSA.INVENTARIO_INCOMPLETO);
});

test('el preflight rechaza un scope EXTRA que ningun descriptor pide', () => {
  const { coordinador } = crear({
    resolveHostPolicy: () => politicaOk({ requiredScopes: [...SCOPES, 'multimedia'] }),
  });
  assert.equal(coordinador.preflight({ host: 'HOST-A' }).causa, CAUSA.INVENTARIO_DIVERGENTE);
});

test('el preflight rechaza `shared_secrets` vacia cuando hay descriptores compartidos', () => {
  const { coordinador } = crear({
    resolveHostPolicy: () => politicaOk({ sharedSecrets: [] }),
  });
  assert.equal(coordinador.preflight({ host: 'HOST-A' }).causa, CAUSA.INVENTARIO_INCOMPLETO);
});

test('el preflight rechaza si no hay descriptores (denominador vacio)', () => {
  const { coordinador } = crear({
    listDescriptors: () => ({}),
    resolveHostPolicy: () => politicaOk({ requiredScopes: [], sharedSecrets: [] }),
  });
  assert.equal(coordinador.preflight({ host: 'HOST-A' }).causa, CAUSA.DESCRIPTORES_AUSENTES);
});

test('una politica ilegible NO abre: queda indeterminada y fail-closed', () => {
  const { coordinador } = crear({
    resolveHostPolicy: () => { throw new Error('config ilegible'); },
  });
  assert.equal(coordinador.preflight({ host: 'HOST-A' }).causa, CAUSA.POLITICA_INDETERMINADA);
});

test('un host con nombre invalido se rechaza antes de tocar el filesystem', () => {
  const { coordinador, dir } = crear();
  for (const host of ['', '../escape', 'host con espacios', 'a/b']) {
    const r = coordinador.preflight({ host });
    assert.equal(r.ok, false);
    assert.equal(r.causa, CAUSA.HOST_INVALIDO);
  }
  assert.deepEqual(fs.existsSync(dir) ? fs.readdirSync(dir) : [], []);
});

// -----------------------------------------------------------------------------
// 2 · Orden estricto rotar → provisionar
// -----------------------------------------------------------------------------

test('provisionar ANTES de rotar no llama al provisionador: etapa fuera de orden', () => {
  const { coordinador, llamadas } = crear();
  coordinador.preflight({ host: 'HOST-A' });
  const r = coordinador.provision({ host: 'HOST-A' });
  assert.equal(r.ok, false);
  assert.equal(r.causa, CAUSA.ETAPA_FUERA_DE_ORDEN);
  assert.equal(llamadas.provision.length, 0, 'el provisionador NO puede haberse llamado');
  assert.equal(coordinador.readState('HOST-A').stage, STAGE.PREFLIGHT);
});

test('rotar sin preflight no llama al rotador', () => {
  const { coordinador, llamadas } = crear();
  const r = coordinador.rotate({ host: 'HOST-A' });
  assert.equal(r.ok, false);
  assert.equal(r.causa, CAUSA.ETAPA_FUERA_DE_ORDEN);
  assert.equal(llamadas.rotate.length, 0);
});

test('respawnear sin provisionar no reinicia consumidores', () => {
  const { coordinador, llamadas } = crear();
  coordinador.preflight({ host: 'HOST-A' });
  coordinador.rotate({ host: 'HOST-A' });
  const r = coordinador.respawn({ host: 'HOST-A' });
  assert.equal(r.causa, CAUSA.ETAPA_FUERA_DE_ORDEN);
  assert.equal(llamadas.respawn.length, 0);
});

test('la secuencia completa recorre las etapas en el orden declarado', () => {
  const { coordinador, llamadas } = crear();
  assert.equal(coordinador.preflight({ host: 'HOST-A' }).stage, STAGE.PREFLIGHT);
  assert.equal(coordinador.rotate({ host: 'HOST-A' }).stage, STAGE.ROTATED);
  assert.equal(coordinador.provision({ host: 'HOST-A' }).stage, STAGE.PROVISIONED);
  assert.equal(coordinador.respawn({ host: 'HOST-A' }).stage, STAGE.RESPAWNED);
  const historia = coordinador.readState('HOST-A').historia.map((h) => h.stage);
  assert.deepEqual(historia, [STAGE.PREFLIGHT, STAGE.ROTATED, STAGE.PROVISIONED, STAGE.RESPAWNED]);
  assert.equal(llamadas.rotate.length, 1);
  assert.equal(llamadas.provision.length, 1);
  // El inventario que recibe cada dependiente sale de los descriptores, no de
  // una lista escrita a mano.
  assert.deepEqual(llamadas.rotate[0].descriptors, NOMBRES);
  assert.deepEqual(llamadas.provision[0].scopes, SCOPES);
});

// -----------------------------------------------------------------------------
// 3 · Idempotencia, crash entre etapas y reanudación
// -----------------------------------------------------------------------------

test('rotar dos veces NO emite material nuevo: la segunda llamada no llega al rotador', () => {
  const { coordinador, llamadas } = crear();
  coordinador.preflight({ host: 'HOST-A' });
  coordinador.rotate({ host: 'HOST-A' });
  const segunda = coordinador.rotate({ host: 'HOST-A' });
  assert.equal(segunda.ok, true);
  assert.equal(segunda.stage, STAGE.ROTATED);
  assert.equal(llamadas.rotate.length, 1, 'no puede haber una segunda rotacion');
});

test('crash DESPUES de rotar y ANTES de persistir: la reanudacion reusa la MISMA clave', () => {
  const dir = tmpDir();
  const now = reloj();
  const clavesVistas = [];
  let muerto = false;

  const primero = createVaultMigration({
    stateDir: dir,
    now,
    listDescriptors: () => DESCRIPTORES,
    resolveHostPolicy: () => politicaOk(),
    rotate: ({ idempotencyKey }) => {
      clavesVistas.push(idempotencyKey);
      // El material YA se emitió; el proceso muere antes del checkpoint final.
      muerto = true;
      throw new Error('proceso muerto entre etapas');
    },
    provision: () => ({ ok: true }),
    respawnConsumers: () => ({ ok: true, consumers: ['pulpo'] }),
    readCoverage: () => ({ estado: 'cumple', rows: [] }),
  });
  primero.preflight({ host: 'HOST-A' });
  const fallido = primero.rotate({ host: 'HOST-A' });
  assert.equal(muerto, true);
  assert.equal(fallido.ok, false);
  assert.equal(fallido.causa, CAUSA.ROTACION_FALLIDA);
  // El checkpoint quedó persistido ANTES de la llamada.
  const intermedio = primero.readState('HOST-A');
  assert.equal(intermedio.stage, STAGE.PREFLIGHT);
  assert.equal(intermedio.pendiente.op, 'rotate');
  assert.equal(intermedio.pendiente.clave, clavesVistas[0]);

  // Proceso nuevo sobre el MISMO estado persistido.
  const segundo = createVaultMigration({
    stateDir: dir,
    now,
    listDescriptors: () => DESCRIPTORES,
    resolveHostPolicy: () => politicaOk(),
    rotate: ({ idempotencyKey }) => { clavesVistas.push(idempotencyKey); return { ok: true, version: 'r1' }; },
    provision: () => ({ ok: true }),
    respawnConsumers: () => ({ ok: true, consumers: ['pulpo'] }),
    readCoverage: () => ({ estado: 'cumple', rows: [] }),
  });
  const reanudado = segundo.rotate({ host: 'HOST-A' });
  assert.equal(reanudado.ok, true);
  assert.equal(clavesVistas.length, 2);
  assert.equal(clavesVistas[0], clavesVistas[1],
    'la reanudacion DEBE reusar la clave de idempotencia: una clave nueva emitiria material nuevo');
  assert.equal(segundo.readState('HOST-A').pendiente, null);
});

test('el checkpoint se escribe ANTES de llamar al dependiente', () => {
  const dir = tmpDir();
  let estadoDuranteLlamada = null;
  const c = createVaultMigration({
    stateDir: dir,
    now: reloj(),
    listDescriptors: () => DESCRIPTORES,
    resolveHostPolicy: () => politicaOk(),
    rotate: () => {
      estadoDuranteLlamada = JSON.parse(fs.readFileSync(path.join(dir, 'host-HOST-A.json'), 'utf8'));
      return { ok: true, version: 'r1' };
    },
    provision: () => ({ ok: true }),
    respawnConsumers: () => ({ ok: true, consumers: ['pulpo'] }),
    readCoverage: () => ({ estado: 'cumple', rows: [] }),
  });
  c.preflight({ host: 'HOST-A' });
  c.rotate({ host: 'HOST-A' });
  assert.ok(estadoDuranteLlamada, 'el estado debia existir en disco durante la llamada');
  assert.equal(estadoDuranteLlamada.pendiente.op, 'rotate');
  assert.equal(estadoDuranteLlamada.stage, STAGE.PREFLIGHT,
    'la etapa NO puede haber avanzado antes de que el dependiente confirme');
});

test('un rechazo explicito del rotador deja la etapa donde estaba y no avanza', () => {
  const { coordinador } = crear({ rotate: () => ({ ok: false }) });
  coordinador.preflight({ host: 'HOST-A' });
  const r = coordinador.rotate({ host: 'HOST-A' });
  assert.equal(r.ok, false);
  assert.equal(r.causa, CAUSA.ROTACION_FALLIDA);
  assert.equal(coordinador.readState('HOST-A').stage, STAGE.PREFLIGHT);
});

test('la reanudacion desde disco no repite etapas ya cumplidas', () => {
  const dir = tmpDir();
  const now = reloj();
  const a = crear({ stateDir: dir, now });
  a.coordinador.preflight({ host: 'HOST-A' });
  a.coordinador.rotate({ host: 'HOST-A' });
  a.coordinador.provision({ host: 'HOST-A' });

  const b = crear({ stateDir: dir, now });
  assert.equal(b.coordinador.readState('HOST-A').stage, STAGE.PROVISIONED);
  b.coordinador.preflight({ host: 'HOST-A' });
  b.coordinador.rotate({ host: 'HOST-A' });
  b.coordinador.provision({ host: 'HOST-A' });
  assert.equal(b.llamadas.rotate.length, 0, 'no puede re-rotar');
  assert.equal(b.llamadas.provision.length, 0, 'no puede re-provisionar');
  assert.equal(b.coordinador.readState('HOST-A').stage, STAGE.PROVISIONED);
});

test('un estado corrupto en disco se lee como "sin checkpoint", nunca como etapa cumplida', () => {
  const { coordinador, dir } = crear();
  coordinador.preflight({ host: 'HOST-A' });
  fs.writeFileSync(path.join(dir, 'host-HOST-A.json'), '{ esto no es json');
  assert.equal(coordinador.readState('HOST-A'), null);
  // Y provisionar sobre ese estado NO avanza.
  assert.equal(coordinador.provision({ host: 'HOST-A' }).causa, CAUSA.ETAPA_FUERA_DE_ORDEN);
});

test('un estado con `stage` fuera del vocabulario se descarta', () => {
  const { coordinador, dir } = crear();
  coordinador.preflight({ host: 'HOST-A' });
  const ruta = path.join(dir, 'host-HOST-A.json');
  const st = JSON.parse(fs.readFileSync(ruta, 'utf8'));
  fs.writeFileSync(ruta, JSON.stringify({ ...st, stage: 'cortado-y-listo' }));
  assert.equal(coordinador.readState('HOST-A'), null);
});

// -----------------------------------------------------------------------------
// 4 · Aislamiento entre hosts
// -----------------------------------------------------------------------------

test('cada host persiste en su propio archivo y avanza de forma independiente', () => {
  const { coordinador, dir } = crear();
  coordinador.preflight({ host: 'HOST-A' });
  coordinador.rotate({ host: 'HOST-A' });
  coordinador.preflight({ host: 'HOST-B' });

  assert.equal(coordinador.readState('HOST-A').stage, STAGE.ROTATED);
  assert.equal(coordinador.readState('HOST-B').stage, STAGE.PREFLIGHT);
  assert.deepEqual(coordinador.listHosts(), ['HOST-A', 'HOST-B']);
  assert.ok(fs.existsSync(path.join(dir, 'host-HOST-A.json')));
  assert.ok(fs.existsSync(path.join(dir, 'host-HOST-B.json')));
});

test('un host con estado corrupto NO arrastra a los demas', () => {
  const { coordinador, dir } = crear();
  coordinador.preflight({ host: 'HOST-A' });
  coordinador.rotate({ host: 'HOST-A' });
  coordinador.preflight({ host: 'HOST-B' });
  coordinador.rotate({ host: 'HOST-B' });

  fs.writeFileSync(path.join(dir, 'host-HOST-A.json'), 'corrupto');
  assert.equal(coordinador.readState('HOST-A'), null);
  assert.equal(coordinador.readState('HOST-B').stage, STAGE.ROTATED);
  assert.equal(coordinador.provision({ host: 'HOST-B' }).ok, true);
});

test('una rotacion fallida en un host no bloquea el avance de otro', () => {
  const { coordinador } = crear({
    rotate: ({ host }) => (host === 'HOST-A' ? { ok: false } : { ok: true, version: 'r1' }),
  });
  coordinador.preflight({ host: 'HOST-A' });
  coordinador.preflight({ host: 'HOST-B' });
  assert.equal(coordinador.rotate({ host: 'HOST-A' }).ok, false);
  assert.equal(coordinador.rotate({ host: 'HOST-B' }).ok, true);
  assert.equal(coordinador.readState('HOST-A').stage, STAGE.PREFLIGHT);
  assert.equal(coordinador.readState('HOST-B').stage, STAGE.ROTATED);
});

// -----------------------------------------------------------------------------
// 5 · Respawn y ventana de cobertura
// -----------------------------------------------------------------------------

test('un respawn sin consumidores es incompleto y no abre la ventana', () => {
  for (const r of [{ ok: true, consumers: [] }, { ok: false, consumers: ['pulpo'] }, null]) {
    const { coordinador } = crear({ respawnConsumers: () => r });
    coordinador.preflight({ host: 'HOST-A' });
    coordinador.rotate({ host: 'HOST-A' });
    coordinador.provision({ host: 'HOST-A' });
    const res = coordinador.respawn({ host: 'HOST-A' });
    assert.equal(res.ok, false);
    assert.equal(res.causa, CAUSA.RESPAWN_INCOMPLETO);
    assert.equal(coordinador.readState('HOST-A').stage, STAGE.PROVISIONED);
  }
});

test('el verificador de respawn recibe el instante de la rotacion', () => {
  const { coordinador, llamadas } = crear();
  coordinador.preflight({ host: 'HOST-A' });
  coordinador.rotate({ host: 'HOST-A' });
  coordinador.provision({ host: 'HOST-A' });
  coordinador.respawn({ host: 'HOST-A' });
  const rotadoEn = coordinador.readState('HOST-A').rotacion.at;
  assert.equal(llamadas.respawn[0].rotatedAt, rotadoEn,
    'sin el instante de rotacion no se puede distinguir "volvio" de "nunca se fue"');
});

test('el respawn registra el instante que abre la ventana de cobertura', () => {
  const { coordinador } = crear();
  coordinador.preflight({ host: 'HOST-A' });
  coordinador.rotate({ host: 'HOST-A' });
  coordinador.provision({ host: 'HOST-A' });
  const r = coordinador.respawn({ host: 'HOST-A' });
  assert.equal(r.ok, true);
  assert.equal(r.evidencia.consumidores, 5);
  assert.ok(Date.parse(coordinador.readState('HOST-A').respawn.at) > 0);
});

// -----------------------------------------------------------------------------
// 6 · Bloqueo ante evidencia incompleta (CA-26)
// -----------------------------------------------------------------------------

function hastaRespawn(overrides = {}) {
  const ctx = crear(overrides);
  ctx.coordinador.preflight({ host: 'HOST-A' });
  ctx.coordinador.rotate({ host: 'HOST-A' });
  ctx.coordinador.provision({ host: 'HOST-A' });
  ctx.coordinador.respawn({ host: 'HOST-A' });
  ctx.respawnAt = ctx.coordinador.readState('HOST-A').respawn.at;
  return ctx;
}

test('CERO ERRORES sin lecturas positivas NO es exito: es host silencioso', () => {
  const ctx = hastaRespawn({ readCoverage: () => ({ estado: 'cumple', rows: [] }) });
  const r = ctx.coordinador.observeCoverage({ host: 'HOST-A' });
  assert.equal(r.ok, false);
  assert.equal(r.causa, CAUSA.HOST_SILENCIOSO);
  assert.equal(ctx.coordinador.readState('HOST-A').stage, STAGE.COEXISTING);
});

test('cobertura parcial bloquea con `cobertura_incompleta` y reporta el faltante', () => {
  const ctx = hastaRespawn();
  const ts = new Date(ctx.now.actual() + 1000).toISOString();
  const parcial = NOMBRES.slice(0, 2).map((name) => ({ name, host: 'HOST-A', via: 'vault', count: 1, ts, last_ts: ts }));
  const c = crear({ stateDir: ctx.dir, now: ctx.now, readCoverage: () => ({ estado: 'cumple', rows: parcial }) });
  const r = c.coordinador.observeCoverage({ host: 'HOST-A' });
  assert.equal(r.causa, CAUSA.COBERTURA_INCOMPLETA);
  assert.equal(r.evidencia.cubiertos, 2);
  assert.equal(r.evidencia.pendientes, NOMBRES.length - 2);
});

test('una sola fila con fuente legacy tumba una cobertura N/N', () => {
  const ctx = hastaRespawn();
  const ts = new Date(ctx.now.actual() + 1000).toISOString();
  for (const via of ['file-bootstrap', 'missing', 'env', 'canonical']) {
    const rows = filasCompletas('HOST-A', ts, [
      { name: NOMBRES[0], host: 'HOST-A', via, count: 1, ts, last_ts: ts },
    ]);
    const c = crear({ stateDir: ctx.dir, now: ctx.now, readCoverage: () => ({ estado: 'cumple', rows }) });
    const r = c.coordinador.observeCoverage({ host: 'HOST-A' });
    assert.equal(r.causa, CAUSA.FUENTE_LEGACY, `via=${via} deberia bloquear`);
  }
});

test('la cobertura ANTERIOR al respawn no cuenta: un proceso vivo conserva el material viejo', () => {
  const ctx = hastaRespawn();
  const antes = new Date(Date.parse(ctx.respawnAt) - 60_000).toISOString();
  const rows = filasCompletas('HOST-A', antes);
  const c = crear({ stateDir: ctx.dir, now: ctx.now, readCoverage: () => ({ estado: 'cumple', rows }) });
  const r = c.coordinador.observeCoverage({ host: 'HOST-A' });
  assert.equal(r.causa, CAUSA.COBERTURA_PREVIA_AL_RESPAWN);
  assert.equal(r.evidencia.cubiertos, 0);
});

test('cobertura N/N posterior al respawn habilita `cutover-ready`', () => {
  const ctx = hastaRespawn();
  const ts = new Date(ctx.now.actual() + 1000).toISOString();
  const c = crear({
    stateDir: ctx.dir, now: ctx.now,
    readCoverage: () => ({ estado: 'cumple', rows: filasCompletas('HOST-A', ts) }),
  });
  const r = c.coordinador.observeCoverage({ host: 'HOST-A' });
  assert.equal(r.ok, true);
  assert.equal(r.stage, STAGE.CUTOVER_READY);
  assert.equal(r.evidencia.cubiertos, NOMBRES.length);
  assert.equal(r.evidencia.pendientes, 0);
  assert.equal(r.evidencia.negativos, 0);
});

test('el evaluador global en `no_verificado` gana sobre cualquier cuenta local', () => {
  const ctx = hastaRespawn();
  const ts = new Date(ctx.now.actual() + 1000).toISOString();
  const c = crear({
    stateDir: ctx.dir, now: ctx.now,
    readCoverage: () => ({ estado: 'no_verificado', motivo: 'integridad_comprometida', rows: filasCompletas('HOST-A', ts) }),
  });
  assert.equal(c.coordinador.observeCoverage({ host: 'HOST-A' }).causa, CAUSA.ESTADO_INDETERMINADO);
});

test('una fila con un derivado del valor invalida la evidencia entera', () => {
  const ctx = hastaRespawn();
  const ts = new Date(ctx.now.actual() + 1000).toISOString();
  const rows = filasCompletas('HOST-A', ts);
  rows[0] = { ...rows[0], hash: 'ab12cd34' };
  const c = crear({ stateDir: ctx.dir, now: ctx.now, readCoverage: () => ({ estado: 'cumple', rows }) });
  assert.equal(c.coordinador.observeCoverage({ host: 'HOST-A' }).causa, CAUSA.EVIDENCIA_CORRUPTA);
});

test('un lector de cobertura que explota deja el estado indeterminado, no aprobado', () => {
  const ctx = hastaRespawn();
  const c = crear({
    stateDir: ctx.dir, now: ctx.now,
    readCoverage: () => { throw new Error('jsonl ilegible'); },
  });
  assert.equal(c.coordinador.observeCoverage({ host: 'HOST-A' }).causa, CAUSA.ESTADO_INDETERMINADO);
});

test('la allowlist se REVALIDA en la ventana: si cae, la cobertura N/N no alcanza', () => {
  const ctx = hastaRespawn();
  const ts = new Date(ctx.now.actual() + 1000).toISOString();
  const c = crear({
    stateDir: ctx.dir, now: ctx.now,
    resolveHostPolicy: () => politicaOk({ allowlistSize: 0 }),
    readCoverage: () => ({ estado: 'cumple', rows: filasCompletas('HOST-A', ts) }),
  });
  assert.equal(c.coordinador.observeCoverage({ host: 'HOST-A' }).causa, CAUSA.ALLOWLIST_VACIA);
});

test('observar cobertura antes del respawn es etapa fuera de orden', () => {
  const { coordinador } = crear();
  coordinador.preflight({ host: 'HOST-A' });
  coordinador.rotate({ host: 'HOST-A' });
  assert.equal(coordinador.observeCoverage({ host: 'HOST-A' }).causa, CAUSA.ETAPA_FUERA_DE_ORDEN);
});

// -----------------------------------------------------------------------------
// 7 · Evidencia sanitizada (modelo cerrado)
// -----------------------------------------------------------------------------

test('la evidencia descarta cualquier clave fuera del vocabulario', () => {
  const limpia = sanitizeEvidence({
    host: 'HOST-A',
    descriptores: 13,
    // Todo lo de abajo NO pertenece al modelo cerrado.
    path: 'C:/Users/Administrator/.claude/secrets/credentials.json',
    account_id: '123456789012',
    namespace: '/intrale/intrale#NOTEBOOK-01',
    valor: 'sk-ant-api03-abcdef',
    env: 'TELEGRAM_BOT_TOKEN',
  });
  assert.deepEqual(Object.keys(limpia).sort(), ['descriptores', 'host']);
});

test('la evidencia rechaza valores con forma incorrecta en vez de recortarlos', () => {
  const limpia = sanitizeEvidence({
    host: 'host con espacios',
    descriptores: '13',
    ts: 'ayer',
    ok: 'true',
    stage: 'inventado',
    causa: 'me_lo_invente',
  });
  assert.deepEqual(limpia, {});
});

test('un `rotacion_version` con pinta de material se reemplaza por el marcador', () => {
  const limpia = sanitizeEvidence({ rotacion_version: 'sk-ant-api03-0123456789abcdefghijKLMNOPQR' });
  assert.notEqual(limpia.rotacion_version, 'sk-ant-api03-0123456789abcdefghijKLMNOPQR');
});

test('toda la auditoria emitida por el coordinador pasa por el modelo cerrado', () => {
  const { coordinador, llamadas } = crear({ rotate: () => ({ ok: true, version: 'r1' }) });
  coordinador.preflight({ host: 'HOST-A' });
  coordinador.rotate({ host: 'HOST-A' });
  assert.ok(llamadas.audit.length >= 2);
  const permitidas = new Set(Object.keys(require('../vault-migration').EVIDENCIA_CAMPOS));
  for (const evento of llamadas.audit) {
    for (const clave of Object.keys(evento)) {
      assert.ok(permitidas.has(clave), `la auditoria emitio la clave no declarada "${clave}"`);
    }
  }
});

// -----------------------------------------------------------------------------
// 8 · `advance` / `run`
// -----------------------------------------------------------------------------

test('`advance` ejecuta exactamente una transicion por llamada', () => {
  const { coordinador } = crear();
  const vistos = [];
  for (let i = 0; i < 4; i += 1) {
    coordinador.advance({ host: 'HOST-A' });
    vistos.push(coordinador.readState('HOST-A').stage);
  }
  assert.deepEqual(vistos, [STAGE.PREFLIGHT, STAGE.ROTATED, STAGE.PROVISIONED, STAGE.RESPAWNED]);
});

test('`run` tiene cota dura y se detiene sin cobertura, no cicla', () => {
  const { coordinador } = crear();
  const r = coordinador.run({ host: 'HOST-A' });
  assert.equal(r.ok, false);
  assert.equal(r.causa, CAUSA.HOST_SILENCIOSO);
  assert.equal(coordinador.readState('HOST-A').stage, STAGE.COEXISTING);
});

test('las etapas declaradas coinciden EXACTAMENTE con la maquina del issue', () => {
  assert.deepEqual(STAGES, [
    'preflight', 'rotated', 'provisioned', 'respawned',
    'coexisting', 'cutover-ready', 'verified',
  ]);
});
