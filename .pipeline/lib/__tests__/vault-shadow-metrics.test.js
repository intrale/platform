// =============================================================================
// Tests del núcleo de la ventana sombra del vault (#5448 — split 1/3 de #5427)
// node --test  (entra por el glob existente de `npm run test:pipeline`)
// =============================================================================
//
// Cobertura, por criterio:
//   CA-14/CA-15  contrato de fila cerrado, persistencia asimétrica por vía
//   CA-16        sync, sin red, sin timers
//   CA-18        cobertura POSITIVA por secreto × host, denominador derivado
//   CA-21        `hosts_activos` fail-closed y error que nombra la clave
//   CA-22        t0 persistido, compartido, ilegible y retención acotada por t0
//   CA-23/CA-20  deduplicación persistida por nombre y por ventana
//   REQ-SEC-9/10/11  fila atómica, permisos 0600, cero valores de secretos
//
// Ningún test toca el `.pipeline/audit/` real del repo: cada uno corre contra un
// directorio temporal inyectado, con reloj inyectado. `autoFlushOnExit: false`
// evita además que el hook de salida escriba en directorios ya borrados.
// =============================================================================
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const {
  createVaultShadowMetrics,
  getVaultShadowMetrics,
  normalizarShadowWindow,
  VIA,
  VIAS_REGISTRADAS,
  VIAS_NEGATIVAS,
  ESTADO,
  HOST_RE,
  DEFAULTS,
  _resetVaultShadowMetrics,
} = require('../vault-shadow-metrics');

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

const HOST_A = 'hostAlfa';
const HOST_B = 'host-beta_2';

/** Descriptores de juguete: mismo contrato que `ENV_DESCRIPTORS` (dotPath → {env}). */
const DESCRIPTORES = Object.freeze({
  'telegram.bot_token': { env: 'TELEGRAM_BOT_TOKEN' },
  'telegram.chat_id': { env: 'TELEGRAM_CHAT_ID' },
  'providers.openai.api_key': { env: 'OPENAI_API_KEY' },
});

/** Claves EXACTAS de una fila JSONL (CA-15). Ni una más, ni una menos. */
const CAMPOS_FILA = ['ts', 'name', 'host', 'via', 'count', 'first_ts', 'last_ts'];

const T_BASE = Date.parse('2026-08-01T00:00:00.000Z');
const H = 3600000;
const D = 86400000;

/** Directorio temporal FUERA del árbol del repo. */
function conAuditDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-shadow-5448-'));
  // El núcleo tiene que crear el `audit/` él mismo: se le pasa un subdirectorio
  // que todavía NO existe.
  const auditDir = path.join(dir, 'audit');
  try { return fn(auditDir, dir); }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

function capturarLogs() {
  const lineas = [];
  const logger = (m) => lineas.push(String(m));
  logger.lineas = lineas;
  logger.texto = () => lineas.join('\n');
  return logger;
}

/** Reloj inyectable y movible. */
function reloj(inicio = T_BASE) {
  const r = { ms: inicio };
  r.now = () => r.ms;
  r.avanzar = (delta) => { r.ms += delta; return r.ms; };
  return r;
}

function nuevo(auditDir, over = {}) {
  return createVaultShadowMetrics({
    auditDir,
    logger: () => {},
    autoFlushOnExit: false,
    ...over,
  });
}

/** `sources` (envVar → vía) con la misma vía para todos los descriptores. */
function sourcesTodos(via, descriptors = DESCRIPTORES) {
  const out = {};
  for (const d of Object.values(descriptors)) out[d.env] = via;
  return out;
}

function leerJsonl(auditDir) {
  const p = path.join(auditDir, 'vault-resolution.jsonl');
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
}

/** Cobertura completa de todos los descriptores en todos los hosts dados. */
function cubrirTodo(auditDir, r, hosts, descriptors = DESCRIPTORES) {
  for (const host of hosts) {
    const m = nuevo(auditDir, { now: r.now });
    m.record(sourcesTodos(VIA.VAULT, descriptors), { hostId: host, descriptors });
    m.flush();
  }
}

// =============================================================================
// Superficie del módulo y vocabulario (contrato con #5449/#5450)
// =============================================================================

test('el vocabulario de vias y estados es cerrado y coincide con credentials.js', () => {
  assert.deepEqual(VIA, { VAULT: 'vault', FILE_BOOTSTRAP: 'file-bootstrap', MISSING: 'missing' });
  assert.deepEqual([...VIAS_REGISTRADAS], ['vault', 'file-bootstrap', 'missing']);
  assert.deepEqual([...VIAS_NEGATIVAS], ['file-bootstrap', 'missing']);
  // `no_verificado` es un estado PROPIO: no puede colapsar contra éxito ni
  // contra "no hay datos" (contrato UX de #5448).
  assert.deepEqual(ESTADO, { CUMPLE: 'cumple', NO_CUMPLE: 'no_cumple', NO_VERIFICADO: 'no_verificado' });
  assert.equal(ESTADO.NO_VERIFICADO === ESTADO.CUMPLE, false);
  assert.ok(Object.isFrozen(VIA) && Object.isFrozen(ESTADO) && Object.isFrozen(DEFAULTS));
});

test('getVaultShadowMetrics memoiza por proceso y no toca el filesystem al crearse', () => {
  conAuditDir((auditDir) => {
    _resetVaultShadowMetrics();
    const a = getVaultShadowMetrics({ auditDir, logger: () => {}, autoFlushOnExit: false });
    const b = getVaultShadowMetrics({ auditDir: '/otro/que/se/ignora' });
    assert.equal(a, b, 'la segunda llamada devuelve la MISMA instancia');
    assert.equal(a.paths.auditDir, path.resolve(auditDir));
    // Crear la instancia no puede crear un solo archivo (CA-25).
    assert.equal(fs.existsSync(auditDir), false);
    _resetVaultShadowMetrics();
  });
});

// =============================================================================
// CA-21 — normalización y validación de `vault.shadow_window`
// =============================================================================

test('normalizarShadowWindow rechaza hosts_activos ausente, vacio, no-array o invalido', () => {
  assert.equal(normalizarShadowWindow({}).motivo, 'hosts_activos_no_array');
  assert.equal(normalizarShadowWindow(null).motivo, 'hosts_activos_no_array');
  assert.equal(normalizarShadowWindow({ hosts_activos: 'hostAlfa' }).motivo, 'hosts_activos_no_array');
  assert.equal(normalizarShadowWindow({ hosts_activos: [] }).motivo, 'hosts_activos_vacio');

  // Entrada no confiable (A03): nada que pueda derivar un path o inyectar.
  for (const malo of ['../../etc/passwd', 'host/otro', 'host con espacio', '', 42, null, { a: 1 }]) {
    const out = normalizarShadowWindow({ hosts_activos: [HOST_A, malo] });
    assert.equal(out.valido, false, `deberia rechazar ${JSON.stringify(malo)}`);
    assert.equal(out.motivo, 'hosts_activos_invalido');
    assert.deepEqual(out.hosts_activos, [], 'no devuelve hosts cuando la lista es invalida');
  }

  const ok = normalizarShadowWindow({ hosts_activos: [HOST_A, HOST_B], duration_hours: 6, retention_days: 2 });
  assert.equal(ok.valido, true);
  assert.deepEqual(ok.hosts_activos, [HOST_A, HOST_B]);
  assert.equal(ok.duration_hours, 6);
  assert.equal(ok.retention_days, 2);
});

test('normalizarShadowWindow cae a los defaults con duracion o retencion no usables', () => {
  for (const malo of [undefined, null, 0, -1, 'muchas', NaN]) {
    const out = normalizarShadowWindow({ hosts_activos: [HOST_A], duration_hours: malo, retention_days: malo });
    assert.equal(out.duration_hours, DEFAULTS.duration_hours);
    assert.equal(out.retention_days, DEFAULTS.retention_days);
  }
  assert.equal(HOST_RE.test(HOST_A), true);
  assert.equal(HOST_RE.test('../x'), false);
});

test('evaluate con hosts_activos invalido devuelve no_verificado y NOMBRA la clave', () => {
  conAuditDir((auditDir) => {
    for (const [hosts, esperado] of [[undefined, 'hosts_activos_no_array'], [[], 'hosts_activos_vacio'],
      [['host/malo'], 'hosts_activos_invalido']]) {
      const logger = capturarLogs();
      const m = nuevo(auditDir, { logger });
      const out = m.evaluate({ descriptors: DESCRIPTORES, hostsActivos: hosts });

      assert.equal(out.estado, ESTADO.NO_VERIFICADO);
      assert.equal(out.motivo, esperado);
      assert.match(out.error, /vault\.shadow_window\.hosts_activos/);
      assert.match(logger.texto(), /vault\.shadow_window\.hosts_activos/);
      assert.match(logger.texto(), /Impacto:.*Proximo paso:/s, 'el error tiene que ser accionable');
      // Fail-closed ANTES de tocar el filesystem: ni se crea el directorio.
      assert.equal(fs.existsSync(auditDir), false);
    }
  });
});

test('evaluate sin descriptores devuelve no_verificado (denominador vacio no aprueba)', () => {
  conAuditDir((auditDir) => {
    const m = nuevo(auditDir);
    for (const d of [undefined, null, {}, 'ENV_DESCRIPTORS']) {
      const out = m.evaluate({ descriptors: d, hostsActivos: [HOST_A] });
      assert.equal(out.estado, ESTADO.NO_VERIFICADO);
      assert.equal(out.motivo, 'descriptores_ausentes');
      assert.equal(out.secretos, 0);
    }
  });
});

// =============================================================================
// CA-14/CA-15 — contrato de fila y persistencia asimétrica por vía
// =============================================================================

test('la via vault NO se persiste hasta el flush y no crea artefactos antes', () => {
  conAuditDir((auditDir) => {
    const r = reloj();
    const m = nuevo(auditDir, { now: r.now });

    const out = m.record(sourcesTodos(VIA.VAULT), { hostId: HOST_A, descriptors: DESCRIPTORES });
    assert.equal(out.registradas, 3);
    assert.equal(out.negativas, 0);
    assert.equal(out.integridad, 'ok');
    assert.equal(fs.existsSync(auditDir), false, 'el buffer no toca disco');

    assert.deepEqual(m.flush(), { escritas: 3, error: null });
    assert.equal(leerJsonl(auditDir).length, 3);
    // Flush idempotente: el buffer quedó vacío, no se duplican filas.
    assert.deepEqual(m.flush(), { escritas: 0, error: null });
    assert.equal(leerJsonl(auditDir).length, 3);
  });
});

test('la via vault agrega en memoria por name|host|via y conserva first_ts/last_ts', () => {
  conAuditDir((auditDir) => {
    const r = reloj();
    const m = nuevo(auditDir, { now: r.now });

    m.record({ TELEGRAM_BOT_TOKEN: VIA.VAULT }, { hostId: HOST_A, descriptors: DESCRIPTORES });
    r.avanzar(5 * 60000);
    m.record({ TELEGRAM_BOT_TOKEN: VIA.VAULT }, { hostId: HOST_A, descriptors: DESCRIPTORES });
    r.avanzar(5 * 60000);
    m.record({ TELEGRAM_BOT_TOKEN: VIA.VAULT }, { hostId: HOST_B, descriptors: DESCRIPTORES });
    m.flush();

    const filas = leerJsonl(auditDir);
    assert.equal(filas.length, 2, 'un host distinto es OTRA fila, no un incremento');
    const enA = filas.find((f) => f.host === HOST_A);
    assert.equal(enA.count, 3 - 1, 'dos resoluciones en hostAlfa');
    assert.equal(enA.first_ts, new Date(T_BASE).toISOString());
    assert.equal(enA.last_ts, new Date(T_BASE + 5 * 60000).toISOString());
    assert.equal(filas.find((f) => f.host === HOST_B).count, 1);
  });
});

test('cada fila JSONL tiene EXACTAMENTE los 7 campos permitidos (CA-15)', () => {
  conAuditDir((auditDir) => {
    const r = reloj();
    const m = nuevo(auditDir, { now: r.now });
    m.record(sourcesTodos(VIA.VAULT), { hostId: HOST_A, descriptors: DESCRIPTORES });
    m.record({ TELEGRAM_CHAT_ID: VIA.MISSING }, { hostId: HOST_A, descriptors: DESCRIPTORES });
    m.flush();

    const filas = leerJsonl(auditDir);
    assert.ok(filas.length >= 4);
    for (const f of filas) {
      assert.deepEqual(Object.keys(f).sort(), [...CAMPOS_FILA].sort(), `fila con campos fuera del contrato: ${JSON.stringify(f)}`);
      // `name` es el NOMBRE LÓGICO (dot-path), nunca la env var ni el valor.
      assert.ok(Object.prototype.hasOwnProperty.call(DESCRIPTORES, f.name), `name no es un dot-path: ${f.name}`);
      assert.ok(VIAS_REGISTRADAS.includes(f.via));
      assert.equal(typeof f.count, 'number');
    }
  });
});

test('la evidencia negativa se appendea INMEDIATAMENTE, sin flush (H-2)', () => {
  conAuditDir((auditDir) => {
    const r = reloj();
    const m = nuevo(auditDir, { now: r.now });

    const out = m.record(
      { TELEGRAM_BOT_TOKEN: VIA.FILE_BOOTSTRAP, OPENAI_API_KEY: VIA.MISSING },
      { hostId: HOST_A, descriptors: DESCRIPTORES },
    );
    assert.equal(out.negativas, 2);

    // Sin llamar a `flush()`: perder esto sería fail-open.
    const filas = leerJsonl(auditDir);
    assert.equal(filas.length, 2);
    assert.deepEqual(filas.map((f) => f.via).sort(), ['file-bootstrap', 'missing']);
    for (const f of filas) assert.equal(f.count, 1);
  });
});

test('solo se registran vault, file-bootstrap y missing: las demas vias se ignoran', () => {
  conAuditDir((auditDir) => {
    const m = nuevo(auditDir, { now: reloj().now });
    const out = m.record({
      TELEGRAM_BOT_TOKEN: 'env-preexisting',
      TELEGRAM_CHAT_ID: 'canonical',
      OPENAI_API_KEY: 'legacy',
      OTRA_QUE_NO_ES_DESCRIPTOR: VIA.MISSING,
    }, { hostId: HOST_A, descriptors: DESCRIPTORES });

    assert.equal(out.registradas, 0, 'ninguna de esas vias pertenece a la dicotomia vault/fallback');
    m.flush();
    assert.equal(fs.existsSync(auditDir), false);
  });
});

test('record es defensivo con sources o descriptores inutilizables', () => {
  conAuditDir((auditDir) => {
    const m = nuevo(auditDir, { now: reloj().now });
    for (const sources of [undefined, null, 'sources', 42]) {
      assert.deepEqual(m.record(sources, { hostId: HOST_A, descriptors: DESCRIPTORES }),
        { registradas: 0, negativas: 0, integridad: 'ok' });
    }
    assert.deepEqual(m.record({ TELEGRAM_BOT_TOKEN: VIA.MISSING }, {}),
      { registradas: 0, negativas: 0, integridad: 'ok' }, 'sin descriptores no hay nombre logico que registrar');
    assert.equal(fs.existsSync(auditDir), false);
  });
});

test('un hostId invalido no se atribuye a ningun host activo y bloquea la ventana', () => {
  conAuditDir((auditDir) => {
    const logger = capturarLogs();
    const r = reloj();
    const m = nuevo(auditDir, { now: r.now, logger });

    m.record(sourcesTodos(VIA.VAULT), { hostId: '../escape', descriptors: DESCRIPTORES });
    m.flush();

    const filas = leerJsonl(auditDir);
    assert.equal(filas.length, 3);
    for (const f of filas) {
      assert.equal(f.host, '?desconocido');
      assert.equal(HOST_RE.test(f.host), false, 'no puede coincidir con ningun hosts_activos valido');
    }
    assert.match(logger.texto(), /vault\.hostId/);
  });
});

// =============================================================================
// REQ-SEC-11 — cero valores de secretos en artefactos ni logs (canario)
// =============================================================================

test('ni los artefactos ni los logs contienen valores de secretos (canario)', () => {
  conAuditDir((auditDir, raiz) => {
    const CANARIO = 'CANARIO-5448-xyzzy-NO-DEBE-APARECER';
    const logger = capturarLogs();
    const r = reloj();
    const m = nuevo(auditDir, { now: r.now, logger });

    // El canario se cuela por TODAS las puertas por las que podría entrar un
    // VALOR: campos extra del descriptor y metadatos sueltos. `host` no entra
    // acá a propósito: es configuración del operador, no un secreto, y CA-15 lo
    // persiste por contrato.
    const descriptoresConCanario = {
      'telegram.bot_token': { env: 'TELEGRAM_BOT_TOKEN', value: CANARIO, default: CANARIO },
      'providers.openai.api_key': { env: 'OPENAI_API_KEY', value: CANARIO, sample: CANARIO },
    };
    m.record({ TELEGRAM_BOT_TOKEN: VIA.VAULT, OPENAI_API_KEY: VIA.MISSING },
      { hostId: HOST_A, descriptors: descriptoresConCanario, valor: CANARIO, env: { X: CANARIO } });
    m.flush();
    m.shouldNotifyFallback('providers.openai.api_key');
    m.evaluate({ descriptors: descriptoresConCanario, hostsActivos: [HOST_A] });

    // Barrido de TODO el árbol de artefactos, no sólo del JSONL.
    const vistos = [];
    for (const f of fs.readdirSync(auditDir)) {
      const contenido = fs.readFileSync(path.join(auditDir, f), 'utf8');
      if (contenido.includes(CANARIO)) vistos.push(f);
    }
    assert.deepEqual(vistos, [], `el canario aparecio en ${vistos.join(', ')}`);
    assert.equal(logger.texto().includes(CANARIO), false, 'el canario aparecio en los logs');
    assert.ok(fs.readdirSync(auditDir).length > 0, 'el barrido tiene que haber mirado archivos reales');
    assert.ok(raiz);
  });
});

test('un append fallido no serializa la excepcion ni el valor, solo el nombre logico', () => {
  conAuditDir((auditDir) => {
    const CANARIO = 'CANARIO-EN-LA-EXCEPCION-5448';
    const logger = capturarLogs();
    const fsFake = {
      ...fs,
      mkdirSync: () => {},
      appendFileSync: () => { const e = new Error(`falla con ${CANARIO} adentro`); e.code = 'EACCES'; throw e; },
    };
    const m = nuevo(auditDir, { now: reloj().now, logger, fs: fsFake });
    m.record({ TELEGRAM_BOT_TOKEN: VIA.MISSING }, { hostId: HOST_A, descriptors: DESCRIPTORES });

    assert.match(logger.texto(), /telegram\.bot_token/, 'el ERROR nombra el secreto');
    assert.match(logger.texto(), /Error\/EACCES/, 'solo nombre y codigo del error');
    assert.equal(logger.texto().includes(CANARIO), false, 'el message crudo no se loguea');
  });
});

// =============================================================================
// REQ-SEC-10 — permisos de los artefactos
// =============================================================================

test('los artefactos se crean con modo 0600 en POSIX', { skip: process.platform === 'win32' ? 'solo POSIX' : false }, () => {
  conAuditDir((auditDir) => {
    const m = nuevo(auditDir, { now: reloj().now });
    m.record({ TELEGRAM_BOT_TOKEN: VIA.MISSING }, { hostId: HOST_A, descriptors: DESCRIPTORES });
    m.evaluate({ descriptors: DESCRIPTORES, hostsActivos: [HOST_A] });

    assert.equal(fs.statSync(auditDir).mode & 0o777, 0o700, 'el directorio no puede ser legible por otros');
    for (const f of fs.readdirSync(auditDir)) {
      assert.equal(fs.statSync(path.join(auditDir, f)).mode & 0o777, 0o600, `${f} no es 0600`);
    }
  });
});

// =============================================================================
// Integridad — sidecar fail-closed
// =============================================================================

test('si falla el append de evidencia negativa se escribe el sidecar y la evaluacion no verifica', () => {
  conAuditDir((auditDir) => {
    const logger = capturarLogs();
    const r = reloj();
    const integrityPath = path.join(auditDir, 'vault-resolution.integrity');

    // Falla SÓLO el JSONL: el sidecar sí se tiene que poder escribir.
    const fsFake = {
      ...fs,
      appendFileSync: (p, data, o) => {
        if (String(p).endsWith('.jsonl')) { const e = new Error('sin permiso'); e.code = 'EACCES'; throw e; }
        return fs.appendFileSync(p, data, o);
      },
    };
    const m = nuevo(auditDir, { now: r.now, logger, fs: fsFake });
    const out = m.record({ TELEGRAM_BOT_TOKEN: VIA.FILE_BOOTSTRAP }, { hostId: HOST_A, descriptors: DESCRIPTORES });

    assert.equal(out.integridad, ESTADO.NO_VERIFICADO);
    assert.equal(fs.existsSync(integrityPath), true, 'el sidecar es la unica huella de la evidencia perdida');
    assert.match(fs.readFileSync(integrityPath, 'utf8'), /append_fallido:file-bootstrap/);

    // Y bloquea la evaluación aunque todo lo demás esté impecable.
    const m2 = nuevo(auditDir, { now: r.now });
    cubrirTodo(auditDir, r, [HOST_A]);
    r.avanzar(30 * H);
    const ev = m2.evaluate({ descriptors: DESCRIPTORES, hostsActivos: [HOST_A] });
    assert.equal(ev.estado, ESTADO.NO_VERIFICADO);
    assert.equal(ev.motivo, 'integridad_comprometida');
  });
});

test('el sidecar bloquea antes de mirar t0: su sola presencia alcanza', () => {
  conAuditDir((auditDir) => {
    fs.mkdirSync(auditDir, { recursive: true });
    fs.writeFileSync(path.join(auditDir, 'vault-resolution.integrity'), '{"ts":"x","motivo":"manual"}\n');
    const m = nuevo(auditDir, { now: reloj().now });
    const ev = m.evaluate({ descriptors: DESCRIPTORES, hostsActivos: [HOST_A] });
    assert.equal(ev.estado, ESTADO.NO_VERIFICADO);
    assert.equal(ev.motivo, 'integridad_comprometida');
    assert.equal(ev.t0, null, 'no llega ni a crear t0');
  });
});

test('no poder mirar el sidecar tambien es no verificable', () => {
  conAuditDir((auditDir) => {
    const fsFake = { ...fs, existsSync: (p) => { if (String(p).endsWith('.integrity')) throw new Error('EIO'); return fs.existsSync(p); } };
    const m = nuevo(auditDir, { now: reloj().now, fs: fsFake });
    const ev = m.evaluate({ descriptors: DESCRIPTORES, hostsActivos: [HOST_A] });
    assert.equal(ev.estado, ESTADO.NO_VERIFICADO);
    assert.equal(ev.motivo, 'integridad_comprometida');
  });
});

// =============================================================================
// CA-22 — t0 persistido, compartido y fail-closed
// =============================================================================

test('t0 ausente se crea y esa evaluacion NUNCA aprueba', () => {
  conAuditDir((auditDir) => {
    const r = reloj();
    const m = nuevo(auditDir, { now: r.now });
    const ev = m.evaluate({ descriptors: DESCRIPTORES, hostsActivos: [HOST_A] });

    assert.equal(ev.estado, ESTADO.NO_VERIFICADO);
    assert.equal(ev.motivo, 't0_reiniciado');
    assert.equal(ev.t0, new Date(T_BASE).toISOString());
    assert.equal(fs.existsSync(path.join(auditDir, 'vault-resolution.t0.json')), true);
  });
});

test('procesos sucesivos comparten el mismo t0 persistido', () => {
  conAuditDir((auditDir) => {
    const r = reloj();
    nuevo(auditDir, { now: r.now }).evaluate({ descriptors: DESCRIPTORES, hostsActivos: [HOST_A] });
    const t0Inicial = JSON.parse(fs.readFileSync(path.join(auditDir, 'vault-resolution.t0.json'), 'utf8')).t0;

    r.avanzar(3 * H);
    const ev = nuevo(auditDir, { now: r.now }).evaluate({ descriptors: DESCRIPTORES, hostsActivos: [HOST_A] });
    assert.equal(ev.t0, t0Inicial, 'una instancia nueva NO reinicia la ventana');
    assert.notEqual(ev.motivo, 't0_reiniciado');
    assert.ok(Math.abs(ev.horas_transcurridas - 3) < 1e-9);
  });
});

test('t0 ilegible se reinicia desde ahora y esa evaluacion no aprueba', () => {
  conAuditDir((auditDir) => {
    const r = reloj();
    // Cobertura completa y ventana vencida: sin el t0 roto, esto sería `cumple`.
    cubrirTodo(auditDir, r, [HOST_A]);
    fs.writeFileSync(path.join(auditDir, 'vault-resolution.t0.json'), '{ esto no es JSON');
    r.avanzar(50 * H);

    const ev = nuevo(auditDir, { now: r.now }).evaluate({ descriptors: DESCRIPTORES, hostsActivos: [HOST_A] });
    assert.equal(ev.estado, ESTADO.NO_VERIFICADO);
    assert.equal(ev.motivo, 't0_reiniciado');
    assert.equal(ev.t0, new Date(r.ms).toISOString());
    // Y quedó reparado para la próxima, con el motivo auditable. "ilegible" y
    // "ausente" no se colapsan: mandan al operador a lugares distintos.
    const st = JSON.parse(fs.readFileSync(path.join(auditDir, 'vault-resolution.t0.json'), 'utf8'));
    assert.equal(st.motivo, 't0_ilegible');
    assert.match(ev.error, /existe pero no se puede leer/);
  });
});

test('t0 ausente e ilegible se distinguen en el motivo persistido', () => {
  conAuditDir((auditDir) => {
    const r = reloj();
    const ev = nuevo(auditDir, { now: r.now }).evaluate({ descriptors: DESCRIPTORES, hostsActivos: [HOST_A] });
    assert.equal(ev.motivo, 't0_reiniciado');
    assert.match(ev.error, /no habia inicio de ventana persistido/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(auditDir, 'vault-resolution.t0.json'), 'utf8')).motivo, 't0_ausente');
  });
});

test('la evidencia negativa reinicia la ventana justo despues de la fila que la causo', () => {
  conAuditDir((auditDir) => {
    const r = reloj();
    nuevo(auditDir, { now: r.now }).evaluate({ descriptors: DESCRIPTORES, hostsActivos: [HOST_A] });

    r.avanzar(2 * H);
    const m = nuevo(auditDir, { now: r.now });
    m.record({ TELEGRAM_BOT_TOKEN: VIA.FILE_BOOTSTRAP }, { hostId: HOST_A, descriptors: DESCRIPTORES });

    const st = JSON.parse(fs.readFileSync(path.join(auditDir, 'vault-resolution.t0.json'), 'utf8'));
    assert.equal(st.motivo, 'evidencia_negativa');
    // 1 ms DESPUÉS de la fila: si no, esa misma fila quedaría dentro de la
    // ventana nueva y la ventana no volvería a cerrar jamás.
    assert.equal(st.t0, new Date(r.ms + 1).toISOString());

    // La cobertura previa al fallback ya no cuenta.
    const ev = nuevo(auditDir, { now: r.now }).evaluate({ descriptors: DESCRIPTORES, hostsActivos: [HOST_A] });
    assert.equal(ev.estado, ESTADO.NO_CUMPLE);
    assert.equal(ev.motivo, 'cobertura_incompleta');
  });
});

// -----------------------------------------------------------------------------
// Sellado temporal de la cobertura bufferada — regresión de rev-1 de #5448.
//
// La vía `vault` se agrega en memoria y se vuelca al SALIR el proceso. Entre la
// resolución y el volcado pueden pasar horas, y en el medio la ventana puede
// haberse reiniciado por evidencia negativa (CA-20). Si la fila volcada se
// fecha con el instante del VOLCADO, esa cobertura vieja entra en la ventana
// nueva y la cierra con `cumple` sin una sola resolución por vault posterior al
// reinicio: fail-open que habilita retirar el fallback de credenciales.
// -----------------------------------------------------------------------------

test('la cobertura bufferada ANTES del reinicio de la ventana no cuenta aunque se vuelque despues', () => {
  conAuditDir((auditDir) => {
    const r = reloj();
    nuevo(auditDir, { now: r.now }).evaluate({ descriptors: DESCRIPTORES, hostsActivos: [HOST_A] });

    // Proceso largo (el pulpo): resuelve TODO por vault y lo deja en el buffer.
    const procesoLargo = nuevo(auditDir, { now: r.now });
    procesoLargo.record(sourcesTodos(VIA.VAULT), { hostId: HOST_A, descriptors: DESCRIPTORES });
    assert.deepEqual(leerJsonl(auditDir), [], 'la via vault todavia no se persistio');

    // Tres horas después OTRO proceso cae al fallback: la ventana reinicia.
    r.avanzar(3 * H);
    nuevo(auditDir, { now: r.now })
      .record({ TELEGRAM_BOT_TOKEN: VIA.FILE_BOOTSTRAP }, { hostId: HOST_A, descriptors: DESCRIPTORES });
    const t0 = JSON.parse(fs.readFileSync(path.join(auditDir, 'vault-resolution.t0.json'), 'utf8')).t0;
    assert.equal(t0, new Date(r.ms + 1).toISOString());

    // Y RECIÉN AHÍ el proceso largo termina y vuelca su buffer.
    r.avanzar(H);
    procesoLargo.flush();

    // La fila quedó sellada con la resolución real, no con el volcado.
    const positivas = leerJsonl(auditDir).filter((f) => f.via === VIA.VAULT);
    assert.equal(positivas.length, 3);
    for (const f of positivas) {
      assert.equal(f.ts, f.last_ts, 'la fila se fecha con la ultima resolucion, no con el volcado');
      assert.ok(Date.parse(f.ts) < Date.parse(t0), 'la cobertura es anterior al reinicio de la ventana');
    }

    // Con la ventana cumplida de sobra, sigue sin cerrar: no hubo NI UNA
    // resolución por vault después del reinicio.
    r.avanzar(30 * H);
    const ev = nuevo(auditDir, { now: r.now }).evaluate({ descriptors: DESCRIPTORES, hostsActivos: [HOST_A] });
    assert.equal(ev.estado, ESTADO.NO_CUMPLE);
    assert.equal(ev.motivo, 'cobertura_incompleta');
    assert.equal(ev.no_verificados.length, 3, 'ningun par (secreto, host) quedo verificado');
    assert.equal(ev.t0, t0, 'la evaluacion no movio la ventana');
    assert.ok(ev.horas_transcurridas >= 24);
  });
});

test('una fila vieja fechada con el volcado se ubica igual por last_ts (compat)', () => {
  conAuditDir((auditDir) => {
    const r = reloj();
    nuevo(auditDir, { now: r.now }).evaluate({ descriptors: DESCRIPTORES, hostsActivos: [HOST_A] });
    r.avanzar(3 * H);
    nuevo(auditDir, { now: r.now })
      .record({ TELEGRAM_BOT_TOKEN: VIA.FILE_BOOTSTRAP }, { hostId: HOST_A, descriptors: DESCRIPTORES });
    const t0 = JSON.parse(fs.readFileSync(path.join(auditDir, 'vault-resolution.t0.json'), 'utf8')).t0;

    // Formato previo al fix: `ts` = volcado (posterior a t0), `last_ts` = la
    // resolución real (anterior). Estas filas ya existen en disco.
    for (const name of Object.keys(DESCRIPTORES)) {
      fs.appendFileSync(path.join(auditDir, 'vault-resolution.jsonl'), JSON.stringify({
        ts: new Date(r.ms + H).toISOString(),
        name,
        host: HOST_A,
        via: VIA.VAULT,
        count: 4,
        first_ts: new Date(T_BASE).toISOString(),
        last_ts: new Date(T_BASE).toISOString(),
      }) + '\n');
    }

    r.avanzar(30 * H);
    const ev = nuevo(auditDir, { now: r.now }).evaluate({ descriptors: DESCRIPTORES, hostsActivos: [HOST_A] });
    assert.equal(ev.estado, ESTADO.NO_CUMPLE);
    assert.equal(ev.motivo, 'cobertura_incompleta');
    assert.equal(ev.no_verificados.length, 3);
    assert.equal(ev.t0, t0);
  });
});

test('la cobertura resuelta DESPUES del reinicio si cierra la ventana aunque se vuelque mas tarde', () => {
  conAuditDir((auditDir) => {
    const r = reloj();
    nuevo(auditDir, { now: r.now }).evaluate({ descriptors: DESCRIPTORES, hostsActivos: [HOST_A] });
    nuevo(auditDir, { now: r.now })
      .record({ TELEGRAM_BOT_TOKEN: VIA.FILE_BOOTSTRAP }, { hostId: HOST_A, descriptors: DESCRIPTORES });

    // Resolución posterior al reinicio, volcada recién horas después.
    r.avanzar(2 * H);
    const procesoLargo = nuevo(auditDir, { now: r.now });
    procesoLargo.record(sourcesTodos(VIA.VAULT), { hostId: HOST_A, descriptors: DESCRIPTORES });
    r.avanzar(5 * H);
    procesoLargo.flush();

    r.avanzar(30 * H);
    const ev = nuevo(auditDir, { now: r.now }).evaluate({ descriptors: DESCRIPTORES, hostsActivos: [HOST_A] });
    assert.equal(ev.estado, ESTADO.CUMPLE, 'el sellado por last_ts no puede volverse fail-closed de mas');
    assert.equal(ev.motivo, 'cobertura_completa');
    assert.deepEqual(ev.no_verificados, []);
  });
});

test('evidencia negativa dentro de la ventana vigente devuelve no_cumple', () => {
  conAuditDir((auditDir) => {
    const r = reloj();
    nuevo(auditDir, { now: r.now }).evaluate({ descriptors: DESCRIPTORES, hostsActivos: [HOST_A] });
    r.avanzar(H);
    cubrirTodo(auditDir, r, [HOST_A]);

    // Fila negativa cuyo reinicio de t0 se perdió (otro proceso, disco lleno).
    // El evaluador tiene que bloquear igual, sin depender del t0.
    const fila = {
      ts: new Date(r.ms).toISOString(), name: 'telegram.chat_id', host: HOST_A,
      via: VIA.MISSING, count: 1, first_ts: new Date(r.ms).toISOString(), last_ts: new Date(r.ms).toISOString(),
    };
    fs.appendFileSync(path.join(auditDir, 'vault-resolution.jsonl'), JSON.stringify(fila) + '\n');

    r.avanzar(40 * H);
    const ev = nuevo(auditDir, { now: r.now }).evaluate({ descriptors: DESCRIPTORES, hostsActivos: [HOST_A] });
    assert.equal(ev.estado, ESTADO.NO_CUMPLE);
    assert.equal(ev.motivo, 'evidencia_negativa');
    assert.equal(ev.negativos.length, 1);
    assert.deepEqual(Object.keys(ev.negativos[0]).sort(), ['host', 'name', 'ts', 'via']);
  });
});

// =============================================================================
// CA-18 — cobertura POSITIVA por secreto × host
// =============================================================================

test('la ventana cumple recien con cobertura completa y tiempo cumplido', () => {
  conAuditDir((auditDir) => {
    const r = reloj();
    nuevo(auditDir, { now: r.now }).evaluate({ descriptors: DESCRIPTORES, hostsActivos: [HOST_A, HOST_B] });

    r.avanzar(H);
    cubrirTodo(auditDir, r, [HOST_A, HOST_B]);

    // Cobertura completa pero la ventana todavía corre.
    r.avanzar(2 * H);
    const enCurso = nuevo(auditDir, { now: r.now }).evaluate({ descriptors: DESCRIPTORES, hostsActivos: [HOST_A, HOST_B] });
    assert.equal(enCurso.estado, ESTADO.NO_CUMPLE);
    assert.equal(enCurso.motivo, 'ventana_en_curso');
    assert.deepEqual(enCurso.no_verificados, []);

    r.avanzar(22 * H);
    const ev = nuevo(auditDir, { now: r.now }).evaluate({ descriptors: DESCRIPTORES, hostsActivos: [HOST_A, HOST_B] });
    assert.equal(ev.estado, ESTADO.CUMPLE);
    assert.equal(ev.motivo, 'cobertura_completa');
    assert.equal(ev.secretos, 3);
    assert.deepEqual(ev.hosts, [HOST_A, HOST_B]);
    assert.deepEqual(ev.negativos, []);
    assert.ok(ev.horas_transcurridas >= 24);
  });
});

test('un secreto o un host sin cobertura bloquea el cierre (nada se cumple por vacuidad)', () => {
  conAuditDir((auditDir) => {
    const r = reloj();
    nuevo(auditDir, { now: r.now }).evaluate({ descriptors: DESCRIPTORES, hostsActivos: [HOST_A, HOST_B] });
    r.avanzar(H);

    // Todo en hostAlfa, pero a hostBeta le falta un secreto.
    cubrirTodo(auditDir, r, [HOST_A]);
    const parcial = nuevo(auditDir, { now: r.now });
    parcial.record({ TELEGRAM_BOT_TOKEN: VIA.VAULT, TELEGRAM_CHAT_ID: VIA.VAULT }, { hostId: HOST_B, descriptors: DESCRIPTORES });
    parcial.flush();

    r.avanzar(40 * H);
    const ev = nuevo(auditDir, { now: r.now }).evaluate({ descriptors: DESCRIPTORES, hostsActivos: [HOST_A, HOST_B] });
    assert.equal(ev.estado, ESTADO.NO_CUMPLE);
    assert.equal(ev.motivo, 'cobertura_incompleta');
    assert.deepEqual(ev.no_verificados, [{ name: 'providers.openai.api_key', host: HOST_B }]);

    // Un host que jamás booteó deja TODOS los secretos sin verificar.
    const conTercero = nuevo(auditDir, { now: r.now })
      .evaluate({ descriptors: DESCRIPTORES, hostsActivos: [HOST_A, 'hostFantasma'] });
    assert.equal(conTercero.estado, ESTADO.NO_CUMPLE);
    assert.equal(conTercero.no_verificados.length, 3);
    assert.ok(conTercero.no_verificados.every((x) => x.host === 'hostFantasma'));
  });
});

test('el denominador sale de los descriptores: agregar uno reabre la ventana', () => {
  conAuditDir((auditDir) => {
    const r = reloj();
    nuevo(auditDir, { now: r.now }).evaluate({ descriptors: DESCRIPTORES, hostsActivos: [HOST_A] });
    r.avanzar(H);
    cubrirTodo(auditDir, r, [HOST_A]);
    r.avanzar(40 * H);

    assert.equal(nuevo(auditDir, { now: r.now })
      .evaluate({ descriptors: DESCRIPTORES, hostsActivos: [HOST_A] }).estado, ESTADO.CUMPLE);

    const ampliado = { ...DESCRIPTORES, 'google_drive.oauth_client_id': { env: 'GD_ID' } };
    const ev = nuevo(auditDir, { now: r.now }).evaluate({ descriptors: ampliado, hostsActivos: [HOST_A] });
    assert.equal(ev.estado, ESTADO.NO_CUMPLE);
    assert.equal(ev.secretos, 4);
    assert.deepEqual(ev.no_verificados, [{ name: 'google_drive.oauth_client_id', host: HOST_A }]);
  });
});

test('la cobertura se mide contra ENV_DESCRIPTORS real sin duplicar la lista', () => {
  const { ENV_DESCRIPTORS } = require('../credentials');
  conAuditDir((auditDir) => {
    const r = reloj();
    nuevo(auditDir, { now: r.now }).evaluate({ descriptors: ENV_DESCRIPTORS, hostsActivos: [HOST_A] });
    r.avanzar(H);
    cubrirTodo(auditDir, r, [HOST_A], ENV_DESCRIPTORS);
    r.avanzar(40 * H);

    const ev = nuevo(auditDir, { now: r.now }).evaluate({ descriptors: ENV_DESCRIPTORS, hostsActivos: [HOST_A] });
    assert.equal(ev.secretos, Object.keys(ENV_DESCRIPTORS).length);
    assert.equal(ev.estado, ESTADO.CUMPLE);

    // Y los nombres persistidos son los dot-path del descriptor, no env vars.
    const nombres = new Set(leerJsonl(auditDir).map((f) => f.name));
    for (const dotPath of Object.keys(ENV_DESCRIPTORS)) assert.ok(nombres.has(dotPath), `falta ${dotPath}`);
  });
});

// =============================================================================
// CA-22d — retención acotada por t0
// =============================================================================

test('la retencion purga lo viejo pero no toca la ventana vigente ni mueve t0', () => {
  conAuditDir((auditDir) => {
    const r = reloj();
    // Evidencia de hace 5 días, muy anterior a t0.
    cubrirTodo(auditDir, r, [HOST_A]);
    const viejas = leerJsonl(auditDir).length;
    assert.equal(viejas, 3);

    r.avanzar(5 * D);
    nuevo(auditDir, { now: r.now }).evaluate({ descriptors: DESCRIPTORES, hostsActivos: [HOST_A], retentionDays: 1 });
    const t0Antes = fs.readFileSync(path.join(auditDir, 'vault-resolution.t0.json'), 'utf8');

    r.avanzar(H);
    cubrirTodo(auditDir, r, [HOST_A]);
    r.avanzar(40 * H);

    const ev = nuevo(auditDir, { now: r.now })
      .evaluate({ descriptors: DESCRIPTORES, hostsActivos: [HOST_A], retentionDays: 1 });

    assert.equal(ev.estado, ESTADO.CUMPLE);
    const quedan = leerJsonl(auditDir);
    assert.equal(quedan.length, 3, 'las 3 filas viejas se purgaron');
    for (const f of quedan) assert.ok(Date.parse(f.ts) >= Date.parse(ev.t0), 'no se purgo nada de la ventana vigente');
    assert.equal(fs.readFileSync(path.join(auditDir, 'vault-resolution.t0.json'), 'utf8'), t0Antes,
      'la purga NO puede mover t0');
  });
});

test('la retencion nunca borra por debajo de t0 aunque la ventana sea mas larga que la retencion', () => {
  conAuditDir((auditDir) => {
    const r = reloj();
    nuevo(auditDir, { now: r.now }).evaluate({ descriptors: DESCRIPTORES, hostsActivos: [HOST_A], retentionDays: 1 });
    r.avanzar(H);
    cubrirTodo(auditDir, r, [HOST_A]);

    // 10 días después: por retención pura (1 día) esa evidencia se borraría,
    // pero sigue siendo la evidencia de la ventana vigente.
    r.avanzar(10 * D);
    const ev = nuevo(auditDir, { now: r.now })
      .evaluate({ descriptors: DESCRIPTORES, hostsActivos: [HOST_A], retentionDays: 1, durationHours: 24 });
    assert.equal(ev.estado, ESTADO.CUMPLE);
    assert.equal(leerJsonl(auditDir).length, 3);
  });
});

// -----------------------------------------------------------------------------
// La purga es la ÚNICA operación que no es append-only: lee el JSONL entero y lo
// reemplaza. Un append de otro proceso dentro de esa ventana desaparecería sin
// dejar señal (el append tuvo éxito, así que tampoco hay sidecar `.integrity`) y
// si la fila perdida es NEGATIVA, `evaluate()` pasa de `no_cumple` a `cumple` y
// habilita retirar el fallback: fail-open, justo lo que [H-2 de #5427] evita.
// -----------------------------------------------------------------------------

/**
 * `fs` inyectable que simula a otro proceso appendeando `filaAInyectar` DENTRO
 * de la ventana de la purga: el hook cuelga de la escritura del temporal, que
 * ocurre después de que la purga leyó el JSONL y antes de que lo reemplace.
 */
function fsConAppendConcurrente(jsonlPath, filaAInyectar) {
  const proxy = Object.create(fs);
  proxy.inyectada = false;
  proxy.writeFileSync = (p, data, o) => {
    if (String(p).startsWith(jsonlPath) && String(p).endsWith('.tmp') && !proxy.inyectada) {
      proxy.inyectada = true;
      fs.appendFileSync(jsonlPath, JSON.stringify(filaAInyectar) + '\n');
    }
    return fs.writeFileSync(p, data, o);
  };
  return proxy;
}

/** Escenario compartido: cobertura positiva completa + filas viejas purgables. */
function escenarioPurgaConCoberturaCompleta(auditDir) {
  const r = reloj();
  cubrirTodo(auditDir, r, [HOST_A]);            // evidencia vieja → se va a purgar
  r.avanzar(5 * D);
  nuevo(auditDir, { now: r.now }).evaluate({ descriptors: DESCRIPTORES, hostsActivos: [HOST_A], retentionDays: 1 });
  r.avanzar(H);
  cubrirTodo(auditDir, r, [HOST_A]);            // cobertura positiva COMPLETA en ventana
  r.avanzar(40 * H);
  return r;
}

test('un append concurrente durante la purga no puede perder evidencia negativa', () => {
  conAuditDir((auditDir) => {
    const r = escenarioPurgaConCoberturaCompleta(auditDir);
    const jsonlPath = path.join(auditDir, 'vault-resolution.jsonl');
    const ts = new Date(r.ms).toISOString();
    const negativa = {
      ts, name: 'telegram.bot_token', host: HOST_A, via: VIA.MISSING, count: 1, first_ts: ts, last_ts: ts,
    };

    const fsProxy = fsConAppendConcurrente(jsonlPath, negativa);
    const logger = capturarLogs();
    const ev = nuevo(auditDir, { now: r.now, fs: fsProxy, logger })
      .evaluate({ descriptors: DESCRIPTORES, hostsActivos: [HOST_A], retentionDays: 1 });

    assert.equal(fsProxy.inyectada, true, 'el escenario tiene que haber ejercitado la ventana de la purga');

    // 1 · la fila negativa SOBREVIVE en el archivo.
    const negativasEnDisco = leerJsonl(auditDir).filter((f) => f.via === VIA.MISSING);
    assert.equal(negativasEnDisco.length, 1, 'la purga se comio la evidencia negativa appendeada');

    // 2 · y por lo tanto la evaluación NO aprueba (sin la carrera daria `cumple`).
    assert.equal(ev.estado, ESTADO.NO_CUMPLE);
    assert.equal(ev.motivo, 'evidencia_negativa');

    // 3 · la purga se abortó con un WARN explicito y sin dejar temporales.
    assert.match(logger.texto(), /se aborto la purga/i);
    assert.equal(fs.readdirSync(auditDir).some((f) => f.endsWith('.tmp')), false, 'quedo un temporal colgado');
  });
});

test('un append concurrente POSITIVO durante la purga tampoco se pierde', () => {
  conAuditDir((auditDir) => {
    const r = escenarioPurgaConCoberturaCompleta(auditDir);
    const jsonlPath = path.join(auditDir, 'vault-resolution.jsonl');
    const ts = new Date(r.ms).toISOString();
    const fila = {
      ts, name: 'telegram.chat_id', host: HOST_B, via: VIA.VAULT, count: 9, first_ts: ts, last_ts: ts,
    };

    const fsProxy = fsConAppendConcurrente(jsonlPath, fila);
    const antes = leerJsonl(auditDir).length;
    nuevo(auditDir, { now: r.now, fs: fsProxy })
      .evaluate({ descriptors: DESCRIPTORES, hostsActivos: [HOST_A], retentionDays: 1 });

    assert.equal(fsProxy.inyectada, true);
    const despues = leerJsonl(auditDir);
    // Se aborta la purga entera: no se pierde NADA, ni lo viejo ni lo appendeado.
    assert.equal(despues.length, antes + 1, 'la purga no puede perder filas appendeadas en su ventana');
    assert.equal(despues.filter((f) => f.count === 9).length, 1);
  });
});

test('sin concurrencia la purga sigue reemplazando el archivo por rename y sin temporales', () => {
  conAuditDir((auditDir) => {
    const r = escenarioPurgaConCoberturaCompleta(auditDir);
    const logger = capturarLogs();
    const ev = nuevo(auditDir, { now: r.now, logger })
      .evaluate({ descriptors: DESCRIPTORES, hostsActivos: [HOST_A], retentionDays: 1 });

    assert.equal(ev.estado, ESTADO.CUMPLE, 'el camino feliz no puede haberse roto');
    assert.equal(leerJsonl(auditDir).length, 3, 'las 3 filas viejas se purgaron');
    assert.equal(fs.readdirSync(auditDir).some((f) => f.endsWith('.tmp')), false, 'el temporal no se limpio');
    assert.doesNotMatch(logger.texto(), /se aborto la purga/i, 'no hubo concurrencia: no corresponde abortar');
    // El JSONL conserva permisos restrictivos despues del rename (REQ-SEC-10).
    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(path.join(auditDir, 'vault-resolution.jsonl')).mode & 0o777, 0o600);
    }
  });
});

test('si no se puede determinar el tamano del JSONL la purga aborta en vez de reescribir', () => {
  conAuditDir((auditDir) => {
    const r = escenarioPurgaConCoberturaCompleta(auditDir);
    const antes = leerJsonl(auditDir).length;

    // `statSync` roto ⇒ no hay con qué comparar ⇒ fail-closed: no se purga nada.
    const fsProxy = Object.create(fs);
    fsProxy.statSync = (p) => {
      if (String(p).endsWith('vault-resolution.jsonl')) throw Object.assign(new Error('boom'), { code: 'EIO' });
      return fs.statSync(p);
    };

    nuevo(auditDir, { now: r.now, fs: fsProxy })
      .evaluate({ descriptors: DESCRIPTORES, hostsActivos: [HOST_A], retentionDays: 1 });

    assert.equal(leerJsonl(auditDir).length, antes, 'sin tamano verificable no se puede tocar el archivo');
    assert.equal(fs.readdirSync(auditDir).some((f) => f.endsWith('.tmp')), false);
  });
});

// =============================================================================
// Lectura tolerante y concurrencia
// =============================================================================

test('readRows descarta lineas rotas o ajenas sin romper la lectura', () => {
  conAuditDir((auditDir) => {
    const r = reloj();
    const m = nuevo(auditDir, { now: r.now });
    m.record({ TELEGRAM_BOT_TOKEN: VIA.MISSING }, { hostId: HOST_A, descriptors: DESCRIPTORES });

    fs.appendFileSync(path.join(auditDir, 'vault-resolution.jsonl'),
      '{"ts":"2026-08-01T00:00:00.000Z","name":"a.b","via":"vau\n'   // fila partida
      + 'esto no es json\n'
      + '\n'
      + '{"ts":"no-es-fecha","name":"a.b","via":"vault"}\n'
      + '{"name":"sin-ts","via":"vault"}\n');

    const rows = m.readRows();
    assert.equal(rows.length, 1, 'solo sobrevive la fila completa y valida');
    assert.equal(rows[0].name, 'telegram.bot_token');
  });
});

test('varios procesos appendeando el mismo JSONL dejan solo filas completas', async () => {
  await new Promise((resolve, reject) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-shadow-conc-'));
    const auditDir = path.join(dir, 'audit');
    const worker = path.join(__dirname, '_vault-shadow-concurrent-worker.js');
    const PROCESOS = 4;
    const FILAS = 25;

    Promise.all(Array.from({ length: PROCESOS }, (_, i) => new Promise((ok, ko) => {
      const p = spawn(process.execPath, [worker, auditDir, `w${i}`, String(FILAS)], { stdio: 'ignore' });
      p.on('error', ko);
      p.on('exit', (code) => (code === 0 ? ok() : ko(new Error(`worker ${i} salio con ${code}`))));
    }))).then(() => {
      const texto = fs.readFileSync(path.join(auditDir, 'vault-resolution.jsonl'), 'utf8');
      const lineas = texto.split('\n').filter((l) => l.trim());

      // Ni una sola línea partida: cada fila entró con UN appendFileSync.
      for (const l of lineas) {
        const fila = JSON.parse(l);   // tira si quedó a medias
        assert.deepEqual(Object.keys(fila).sort(), [...CAMPOS_FILA].sort());
      }
      assert.equal(lineas.length, PROCESOS * FILAS, 'no se perdio ni se duplico ninguna fila');
      assert.equal(texto.endsWith('\n'), true);
      fs.rmSync(dir, { recursive: true, force: true });
      resolve();
    }).catch((e) => {
      fs.rmSync(dir, { recursive: true, force: true });
      reject(e);
    });
  });
});

// =============================================================================
// CA-20/CA-23 — deduplicación persistida
// =============================================================================

test('el aviso de fallback se dedupe por nombre logico y sobrevive al proceso', () => {
  conAuditDir((auditDir) => {
    const r = reloj();
    const m = nuevo(auditDir, { now: r.now });

    assert.equal(m.shouldNotifyFallback('telegram.bot_token'), true);
    assert.equal(m.shouldNotifyFallback('telegram.bot_token'), false);
    assert.equal(m.shouldNotifyFallback('providers.openai.api_key'), true, 'otro secreto avisa aparte');

    // Otra instancia (otro proceso) lee el mismo estado persistido.
    assert.equal(nuevo(auditDir, { now: r.now }).shouldNotifyFallback('telegram.bot_token'), false);
    assert.equal(m.shouldNotifyFallback(''), false);
    assert.equal(m.shouldNotifyFallback(null), false);

    const st = JSON.parse(fs.readFileSync(path.join(auditDir, 'vault-resolution.dedupe.json'), 'utf8'));
    assert.deepEqual(Object.keys(st.fallback).sort(), ['providers.openai.api_key', 'telegram.bot_token']);
  });
});

test('el dedupe ilegible REPITE el aviso, nunca lo silencia', () => {
  conAuditDir((auditDir) => {
    const r = reloj();
    const m = nuevo(auditDir, { now: r.now });
    m.shouldNotifyFallback('telegram.bot_token');

    fs.writeFileSync(path.join(auditDir, 'vault-resolution.dedupe.json'), 'roto{');
    assert.equal(nuevo(auditDir, { now: r.now }).shouldNotifyFallback('telegram.bot_token'), true,
      'perder el estado de dedupe tiene que ser ruidoso, no silencioso');
  });
});

test('el aviso de cumplimiento se dedupe por t0 y se re-arma cuando la ventana reinicia', () => {
  conAuditDir((auditDir) => {
    const r = reloj();
    const m = nuevo(auditDir, { now: r.now });
    const t0Uno = new Date(T_BASE).toISOString();

    assert.equal(m.shouldNotifyCumplimiento(t0Uno), true);
    assert.equal(m.shouldNotifyCumplimiento(t0Uno), false);
    assert.equal(nuevo(auditDir, { now: r.now }).shouldNotifyCumplimiento(t0Uno), false);

    // Ventana reiniciada ⇒ t0 nuevo ⇒ vuelve a avisar, sin limpiar nada a mano.
    assert.equal(m.shouldNotifyCumplimiento(new Date(T_BASE + D).toISOString()), true);
    assert.equal(m.shouldNotifyCumplimiento(''), false);
  });
});

// =============================================================================
// flush best-effort — perder cobertura positiva sólo puede fallar CERRADO
// =============================================================================

test('un flush que falla no tira, avisa WARN y deja el gate cerrado', () => {
  conAuditDir((auditDir) => {
    const logger = capturarLogs();
    const fsFake = { ...fs, mkdirSync: () => {}, appendFileSync: () => { const e = new Error('disco lleno'); e.code = 'ENOSPC'; throw e; } };
    const m = nuevo(auditDir, { now: reloj().now, logger, fs: fsFake });

    m.record(sourcesTodos(VIA.VAULT), { hostId: HOST_A, descriptors: DESCRIPTORES });
    const out = m.flush();

    assert.equal(out.escritas, 0);
    assert.equal(out.error, 'Error/ENOSPC');
    assert.match(logger.texto(), /WARN/);
    assert.match(logger.texto(), /fail-closed/);
    // No hay sidecar: perder cobertura POSITIVA no es corrupción de evidencia.
    assert.equal(fs.existsSync(path.join(auditDir, 'vault-resolution.integrity')), false);
  });
});

test('evaluate no lanza cuando el JSONL no existe todavia', () => {
  conAuditDir((auditDir) => {
    const r = reloj();
    nuevo(auditDir, { now: r.now }).evaluate({ descriptors: DESCRIPTORES, hostsActivos: [HOST_A] });
    r.avanzar(40 * H);
    const ev = nuevo(auditDir, { now: r.now }).evaluate({ descriptors: DESCRIPTORES, hostsActivos: [HOST_A] });
    assert.equal(ev.estado, ESTADO.NO_CUMPLE);
    assert.equal(ev.motivo, 'cobertura_incompleta');
    assert.equal(ev.no_verificados.length, 3);
  });
});

// =============================================================================
// CA-16 — el núcleo no puede volver async ni mantener vivo el proceso
// =============================================================================

test('la API es sincrona: nada devuelve un thenable', () => {
  conAuditDir((auditDir) => {
    const m = nuevo(auditDir, { now: reloj().now });
    const salidas = [
      m.record({ TELEGRAM_BOT_TOKEN: VIA.MISSING }, { hostId: HOST_A, descriptors: DESCRIPTORES }),
      m.flush(),
      m.evaluate({ descriptors: DESCRIPTORES, hostsActivos: [HOST_A] }),
      m.readRows(),
    ];
    for (const s of salidas) assert.equal(typeof (s && s.then), 'undefined');
    for (const fn of [m.record, m.flush, m.evaluate, m.readRows]) {
      assert.equal(fn.constructor.name, 'Function', 'ninguna puede ser AsyncFunction');
    }
  });
});
