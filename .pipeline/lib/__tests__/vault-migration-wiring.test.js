// =============================================================================
// vault-migration-wiring.test.js — #5453 rev-1 · el CAMINO PRODUCTIVO
// =============================================================================
//
// Por qué existe esta suite, además de las otras dos
// --------------------------------------------------
// `vault-migration.test.js` y `vault-migration-integration.test.js` cubren la
// máquina de estados con dependencias inyectadas: todas le pasan un
// `rotate: () => ({ok:true, version:'r1'})` que funciona. Esa cobertura es del
// MÓDULO, no del camino que existe en producción.
//
// La rev-0 de #5453 murió exactamente en ese hueco: el cableado real de
// `pulpo.js` inyectaba `rotate: () => ({ok:false})`, `provision: () =>
// ({ok:false})` y `writeAudit: () => {}`, con lo cual ningún host podía salir
// de `preflight`, el tick del Pulpo era un no-op permanente y la evidencia se
// descartaba. 81 tests en verde y cero recorridos ejercitables.
//
// Esta suite ejercita el cableado PRODUCTIVO (`vault-migration-wiring.js`) y el
// punto de entrada del operador (`vault-migration-cli.js`), inyectando
// únicamente la frontera del sistema operativo: un `pipelineDir` temporal y el
// config. El resto —descriptores, política, allowlist, acreditación, ledger,
// readiness de respawn y auditoría— es el código real.
// =============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const wiring = require('../vault-migration-wiring');
const cli = require('../vault-migration-cli');
const { STAGE, CAUSA, EVIDENCIA_CAMPOS } = require('../vault-migration');
const { createVaultShadowMetrics } = require('../vault-shadow-metrics');
const { CONSUMIDORES } = require('../vault-respawn-readiness');
const { ENV_DESCRIPTORS } = require('../credentials');

const HOST = 'host-alfa';
const VERSION_OK = '2026-08-31-r1';

function tmpPipeline() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'vault-wiring-'));
}

/**
 * Config con la MISMA forma que `.pipeline/config.yaml`. Los scopes se derivan
 * de `ENV_DESCRIPTORS` a propósito: una lista literal se desincronizaría del
 * código en el primer descriptor nuevo, que es justo el fallo que el preflight
 * tiene que atrapar.
 */
function configFake(over = {}) {
  const scopes = [];
  const compartidos = [];
  for (const nombre of Object.keys(ENV_DESCRIPTORS)) {
    const d = ENV_DESCRIPTORS[nombre] || {};
    if (d.backend === 'file-only') continue;
    const scope = nombre.split('.')[0];
    if (!scopes.includes(scope)) scopes.push(scope);
    if (d.shared === true && !compartidos.includes(scope)) compartidos.push(scope);
  }
  return {
    vault: Object.assign({
      enabled: true,
      bootstrap_fallback: false,
      required_scopes: scopes,
      shared_secrets: compartidos,
      shadow_window: { hosts_activos: [HOST], duration_hours: 24, retention_days: 7 },
      migration: { enabled: true, tick_minutes: 15, auto_stages: ['observe'] },
    }, over),
  };
}

/** El evaluador de cobertura REAL, apuntado a un `audit/` descartable. */
function metricsFactoryEn(dir) {
  let inst = null;
  return () => {
    if (!inst) inst = createVaultShadowMetrics({ auditDir: path.join(dir, 'audit'), logger: () => {} });
    return inst;
  };
}

function deps(dir, extra) {
  return Object.assign({
    pipelineDir: dir,
    loadConfig: () => configFake(),
    logger: () => {},
    metricsFactory: metricsFactoryEn(dir),
  }, extra);
}

/** El operador está en la allowlist sólo si hay chat id: el preflight lo exige. */
function conOperador(fn) {
  const previo = process.env.TELEGRAM_LEO_OPERATOR_CHAT_ID;
  process.env.TELEGRAM_LEO_OPERATOR_CHAT_ID = '123456789';
  try { return fn(); } finally {
    if (previo === undefined) delete process.env.TELEGRAM_LEO_OPERATOR_CHAT_ID;
    else process.env.TELEGRAM_LEO_OPERATOR_CHAT_ID = previo;
  }
}

/**
 * Escribe los `.pid` de todos los consumidores como si `restart.js` acabara de
 * correr.
 *
 * El `mtime` se estampa a mano a propósito. `vault-respawn-readiness.js` acredita
 * un consumidor sólo si su `.pid` es POSTERIOR a `rotacion.at`, y compara un
 * `Date.now()` (microsegundos) contra un `mtimeMs` del filesystem, que en Windows
 * viene cuantizado al tick del timer (~15,6 ms). Como este helper corre a pocos
 * milisegundos de `rotate()`, el `.pid` heredaba el mtime del tick ANTERIOR y el
 * respawn fallaba con `respawn_incompleto` de forma intermitente — a veces con
 * acreditación parcial, cuando el tick avanzaba en medio del `for`.
 *
 * Fijar el mtime un segundo adelante saca a la suite de esa lotería sin tocar el
 * ancla de seguridad. En producción no aplica: entre acreditar la rotación y
 * correr `restart.js` pasan segundos o minutos, nunca microsegundos. La
 * granularidad de reloj del verificador es un bug latente propio, reportado
 * aparte (afecta filesystems con mtime de 1-2 s, tipo FAT/SMB).
 */
function acreditarPidsVivos(dir) {
  const futuro = new Date(Date.now() + 1000);
  for (const nombre of CONSUMIDORES) {
    const ruta = path.join(dir, `${nombre}.pid`);
    fs.writeFileSync(ruta, String(process.pid), 'utf8');
    fs.utimesSync(ruta, futuro, futuro);
  }
}

function leerAuditoria(dir) {
  const ruta = path.join(dir, 'audit', wiring.AUDIT_FILE);
  if (!fs.existsSync(ruta)) return [];
  return fs.readFileSync(ruta, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
}

// -----------------------------------------------------------------------------
// Gate
// -----------------------------------------------------------------------------

test('con el gate del vault cerrado no se arma coordinador ni se crea un solo archivo de estado', () => {
  const dir = tmpPipeline();
  const armado = wiring.createProductionVaultMigration(
    deps(dir, { loadConfig: () => configFake({ enabled: false }) }),
  );
  assert.equal(armado.gateAbierto, false);
  assert.equal(armado.gate, wiring.GATE.VAULT_CERRADO);
  assert.equal(armado.coordinador, null);
  assert.equal(fs.existsSync(armado.stateDir), false);
});

test('con `vault.migration.enabled` cerrado el gate distingue la causa', () => {
  const dir = tmpPipeline();
  const armado = wiring.createProductionVaultMigration(
    deps(dir, { loadConfig: () => configFake({ migration: { enabled: false } }) }),
  );
  assert.equal(armado.gate, wiring.GATE.MIGRACION_CERRADA);
  assert.equal(armado.coordinador, null);
});

test('un config ilegible deja el gate cerrado en vez de asumir que esta abierto', () => {
  const dir = tmpPipeline();
  const armado = wiring.createProductionVaultMigration(
    deps(dir, { loadConfig: () => { throw new Error('yaml roto'); } }),
  );
  assert.equal(armado.gate, wiring.GATE.CONFIG_ILEGIBLE);
  assert.equal(armado.coordinador, null);
});

// -----------------------------------------------------------------------------
// El modo del Pulpo: sin acreditación NO se rota (fail-closed conservado)
// -----------------------------------------------------------------------------

test('el cableado del Pulpo (sin acreditacion) pasa el preflight pero NO puede rotar', () => conOperador(() => {
  const dir = tmpPipeline();
  const { coordinador } = wiring.createProductionVaultMigration(deps(dir));

  const pre = coordinador.preflight({ host: HOST });
  assert.equal(pre.ok, true, 'el preflight productivo tiene que pasar con el config real');
  assert.equal(pre.stage, STAGE.PREFLIGHT);

  // Esto es lo que hace el Pulpo si alguien lo llama: rotar emite material
  // irreversible y ningun timer lo dispara.
  const rot = coordinador.rotate({ host: HOST });
  assert.equal(rot.ok, false);
  assert.equal(rot.causa, CAUSA.ROTACION_FALLIDA);
  assert.equal(coordinador.readState(HOST).stage, STAGE.PREFLIGHT);
}));

// -----------------------------------------------------------------------------
// El modo del operador: acreditar lo hecho fuera de banda
// -----------------------------------------------------------------------------

test('con acreditacion del operador el host avanza preflight -> rotated -> provisioned', () => conOperador(() => {
  const dir = tmpPipeline();
  const base = wiring.createProductionVaultMigration(deps(dir));
  assert.equal(base.coordinador.preflight({ host: HOST }).ok, true);

  const rotador = wiring.createProductionVaultMigration(deps(dir, {
    acreditacion: { rotate: { confirmado: true, version: VERSION_OK } },
  }));
  const rot = rotador.coordinador.rotate({ host: HOST });
  assert.equal(rot.ok, true);
  assert.equal(rot.stage, STAGE.ROTATED);
  assert.equal(rotador.coordinador.readState(HOST).rotacion.version, VERSION_OK);

  const provisionador = wiring.createProductionVaultMigration(deps(dir, {
    acreditacion: { provision: { confirmado: true } },
  }));
  const prov = provisionador.coordinador.provision({ host: HOST });
  assert.equal(prov.ok, true);
  assert.equal(prov.stage, STAGE.PROVISIONED);
}));

test('una etiqueta de version invalida NO acredita la rotacion ni ensucia el ledger', () => conOperador(() => {
  const dir = tmpPipeline();
  const base = wiring.createProductionVaultMigration(deps(dir));
  base.coordinador.preflight({ host: HOST });

  const armado = wiring.createProductionVaultMigration(deps(dir, {
    acreditacion: { rotate: { confirmado: true, version: 'version con espacios y $%&' } },
  }));
  const rot = armado.coordinador.rotate({ host: HOST });
  assert.equal(rot.ok, false);
  assert.equal(rot.causa, CAUSA.ROTACION_FALLIDA);
  assert.equal(fs.existsSync(armado.acreditacionesPath), false);
}));

test('el orden rotar->provisionar sigue siendo estricto aun con las dos acreditaciones dadas', () => conOperador(() => {
  const dir = tmpPipeline();
  const armado = wiring.createProductionVaultMigration(deps(dir, {
    acreditacion: {
      rotate: { confirmado: true, version: VERSION_OK },
      provision: { confirmado: true },
    },
  }));
  armado.coordinador.preflight({ host: HOST });
  const prov = armado.coordinador.provision({ host: HOST });
  assert.equal(prov.ok, false);
  assert.equal(prov.causa, CAUSA.ETAPA_FUERA_DE_ORDEN);
}));

// -----------------------------------------------------------------------------
// Idempotencia: reanudar tras un crash NO vuelve a pedir material
// -----------------------------------------------------------------------------

test('reanudar con la MISMA clave de idempotencia reusa la acreditacion y no emite material nuevo', () => conOperador(() => {
  const dir = tmpPipeline();
  const armado = wiring.createProductionVaultMigration(deps(dir, {
    acreditacion: { rotate: { confirmado: true, version: VERSION_OK } },
  }));
  armado.coordinador.preflight({ host: HOST });
  assert.equal(armado.coordinador.rotate({ host: HOST }).ok, true);

  const ledger = fs.readFileSync(armado.acreditacionesPath, 'utf8').split(/\r?\n/).filter(Boolean);
  assert.equal(ledger.length, 1);
  const registro = JSON.parse(ledger[0]);
  assert.equal(registro.op, 'rotate');
  assert.equal(registro.version, VERSION_OK);
  // La clave es `<host>:<op>:<intento>:<nonce-de-ventana>`. Se afirma la FORMA y
  // la ausencia de material, no un literal: el nonce es aleatorio por ventana a
  // propósito (#5453 rev-2). Fijar el literal `<host>:rotate:1` era justamente
  // lo que hacía colisionable la clave entre ventanas.
  assert.match(registro.clave, new RegExp(`^${HOST}:rotate:1:[0-9a-f]{12}$`),
    'la clave es <host>:<op>:<intento>:<nonce>, sin material');
  assert.ok(!registro.clave.includes(VERSION_OK), 'la clave no lleva la etiqueta de version');

  // Simulamos el crash: el operador YA rotó (el ledger lo prueba) pero el
  // avance de etapa no llegó a persistirse; queda el checkpoint pendiente que
  // deja `conCheckpoint()`. El `pendiente` reusa la clave REAL de la ventana:
  // es lo que hace que la reanudación sea distinguible de una ventana nueva.
  const rutaEstado = path.join(armado.stateDir, `host-${HOST}.json`);
  const estado = JSON.parse(fs.readFileSync(rutaEstado, 'utf8'));
  estado.stage = STAGE.PREFLIGHT;
  estado.rotacion = null;
  estado.pendiente = {
    op: 'rotate', clave: registro.clave, intento: 1, at: new Date().toISOString(),
  };
  fs.writeFileSync(rutaEstado, JSON.stringify(estado), 'utf8');

  // Reanudación SIN acreditación nueva: el Pulpo, o el operador que no vuelve a
  // rotar. Tiene que salir bien igual, con la MISMA version.
  const reanudado = wiring.createProductionVaultMigration(deps(dir));
  const rot2 = reanudado.coordinador.rotate({ host: HOST });
  assert.equal(rot2.ok, true);
  assert.equal(reanudado.coordinador.readState(HOST).rotacion.version, VERSION_OK);

  const ledger2 = fs.readFileSync(armado.acreditacionesPath, 'utf8').split(/\r?\n/).filter(Boolean);
  assert.equal(ledger2.length, 1, 'reanudar no registra una acreditacion nueva');
}));

// -----------------------------------------------------------------------------
// #5453 rev-2 · el replay del ledger NO puede sustituir al operador
// -----------------------------------------------------------------------------
//
// Hallazgo de `security` sobre la rev-1 (OWASP A04 Insecure Design + A01 Broken
// Access Control): la frase de confirmación es el único gate fail-closed de las
// dos etapas irreversibles y vivía SÓLO en el dispatch de la CLI. `advance`
// llegaba a las mismas funciones sin pasar por ahí. Y como la clave de
// idempotencia era CONSTANTE por host (`<host>:<op>:1`) contra un ledger
// append-only que nunca se acota a una ventana, el replay del ledger matcheaba
// una acreditación de una ventana ANTERIOR y devolvía `{ok:true}` antes de
// mirar la confirmación: el host cruzaba `rotated` sin que nadie rotara nada.
//
// La cobertura vieja no lo atrapaba porque mide procedencia (`source: vault`),
// no validez, y la auditoría registraba `{"stage":"rotated","ok":true}` como un
// evento legítimo — la atestación falsa era invisible justo en el artefacto que
// se usa para probar CA-23. Estos tests son el candado.

/** Deja el host en ventana NUEVA, con el ledger de la ventana anterior acreditado. */
function conVentanaAnteriorAcreditada(dir) {
  const operador = wiring.createProductionVaultMigration(deps(dir, {
    acreditacion: {
      rotate: { confirmado: true, version: VERSION_OK },
      provision: { confirmado: true },
    },
  }));
  operador.coordinador.preflight({ host: HOST });
  assert.equal(operador.coordinador.rotate({ host: HOST }).ok, true);
  assert.equal(operador.coordinador.provision({ host: HOST }).ok, true);
  // Ventana NUEVA: el estado del host se reinicia (el ciclo de rotación
  // siguiente, o el `reset.js` que limpia `.pipeline/state/`). El ledger, que es
  // append-only, sobrevive — y ésa es exactamente la asimetría explotable.
  fs.unlinkSync(path.join(operador.stateDir, `host-${HOST}.json`));
  return operador;
}

test('CA-23 · en una ventana nueva, `advance` sin acreditacion NO puede cruzar `rotated`', () => conOperador(() => {
  const dir = tmpPipeline();
  const armado = conVentanaAnteriorAcreditada(dir);

  // El modo del Pulpo y el de `advance`: cero acreditación, cero frase, cero humano.
  const auto = wiring.createProductionVaultMigration(deps(dir));
  assert.equal(auto.coordinador.advance({ host: HOST }).ok, true, 'el preflight si puede correr solo');

  const intento = auto.coordinador.advance({ host: HOST });
  assert.equal(intento.ok, false, 'acreditar una rotacion que nunca ocurrio tiene que fallar cerrado');
  assert.equal(intento.causa, CAUSA.ROTACION_FALLIDA);
  assert.equal(auto.coordinador.readState(HOST).stage, STAGE.PREFLIGHT,
    'el host NO puede quedar en `rotated` sin una rotacion real');
  assert.equal(auto.coordinador.readState(HOST).rotacion, null);

  // Y la auditoría no puede contener una atestación falsa: es el artefacto con
  // el que se prueba CA-23.
  const falsa = leerAuditoria(dir).filter((e) => e.stage === STAGE.ROTATED && e.ok === true);
  assert.equal(falsa.length, 1,
    'solo la rotacion REAL de la ventana anterior puede figurar como rotated/ok');
  assert.ok(armado.acreditacionesPath.endsWith(wiring.ACREDITACIONES_FILE));
}));

test('CA-23 · un `pendiente` huerfano de un intento fallido no convierte el tick siguiente en reanudacion', () => conOperador(() => {
  const dir = tmpPipeline();
  conVentanaAnteriorAcreditada(dir);
  const auto = wiring.createProductionVaultMigration(deps(dir));
  auto.coordinador.advance({ host: HOST });

  // Primer intento sin acreditación: falla, pero DEJA el checkpoint escrito
  // (`conCheckpoint()` lo persiste ANTES de invocar). Ese `pendiente` vivo es
  // lo que hacía que el tick siguiente se leyera como "reanudacion de un crash".
  assert.equal(auto.coordinador.advance({ host: HOST }).ok, false);
  const pend = auto.coordinador.readState(HOST).pendiente;
  assert.ok(pend && pend.op === 'rotate', 'el checkpoint queda escrito, como siempre');

  // Segundo tick: sigue sin acreditación ⇒ sigue fallando.
  assert.equal(auto.coordinador.advance({ host: HOST }).ok, false,
    'un checkpoint huerfano no es evidencia de que el operador haya rotado');
  assert.equal(auto.coordinador.readState(HOST).stage, STAGE.PREFLIGHT);
}));

test('CA-23 · `provision` tiene el MISMO gate: no se acredita por replay de otra ventana', () => conOperador(() => {
  const dir = tmpPipeline();
  conVentanaAnteriorAcreditada(dir);

  // Se rota de verdad en la ventana nueva, pero NO se acredita la provisión.
  const soloRotate = wiring.createProductionVaultMigration(deps(dir, {
    acreditacion: { rotate: { confirmado: true, version: '2026-09-01-r2' } },
  }));
  soloRotate.coordinador.preflight({ host: HOST });
  assert.equal(soloRotate.coordinador.rotate({ host: HOST }).ok, true);

  const auto = wiring.createProductionVaultMigration(deps(dir));
  const intento = auto.coordinador.advance({ host: HOST });
  assert.equal(intento.ok, false, 'la provision de la ventana anterior no acredita esta');
  assert.equal(intento.causa, CAUSA.PROVISION_FALLIDA);
  assert.equal(auto.coordinador.readState(HOST).stage, STAGE.ROTATED);
}));

test('CA-23 · dos ventanas nunca comparten clave de idempotencia', () => conOperador(() => {
  const dir = tmpPipeline();
  conVentanaAnteriorAcreditada(dir);
  const segunda = wiring.createProductionVaultMigration(deps(dir, {
    acreditacion: { rotate: { confirmado: true, version: '2026-09-01-r2' } },
  }));
  segunda.coordinador.preflight({ host: HOST });
  assert.equal(segunda.coordinador.rotate({ host: HOST }).ok, true);

  const claves = fs.readFileSync(segunda.acreditacionesPath, 'utf8')
    .split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l))
    .filter((r) => r.op === 'rotate')
    .map((r) => r.clave);
  assert.equal(claves.length, 2, 'la segunda ventana registra una acreditacion PROPIA');
  assert.notEqual(claves[0], claves[1],
    'una clave constante por host es lo que permitia el replay entre ventanas');
  // Y la versión de la ventana nueva es la nueva, no la reciclada del ledger.
  assert.equal(segunda.coordinador.readState(HOST).rotacion.version, '2026-09-01-r2');
}));

test('CA-23 · la CLI le dice al operador que `advance` no acredita etapas irreversibles', () => conOperador(() => {
  const dir = tmpPipeline();
  conVentanaAnteriorAcreditada(dir);
  const base = deps(dir);
  cli.runCli({ argv: ['advance', '--host', HOST], deps: base });
  const r = cli.runCli({ argv: ['advance', '--host', HOST], deps: base });
  assert.equal(r.exitCode, cli.EXIT.ETAPA_FALLIDA);
  const texto = r.lines.join('\n');
  assert.match(texto, /no acredita etapas irreversibles/);
  assert.match(texto, new RegExp(cli.CONFIRM.rotate),
    'el mensaje tiene que traer el comando concreto que SI acredita');
}));

// -----------------------------------------------------------------------------
// Respawn (lo que ABRE la ventana de cobertura)
// -----------------------------------------------------------------------------

test('el respawn se acredita contra los `.pid` reales, y sin ellos falla cerrado', () => conOperador(() => {
  const dir = tmpPipeline();
  const armado = wiring.createProductionVaultMigration(deps(dir, {
    acreditacion: {
      rotate: { confirmado: true, version: VERSION_OK },
      provision: { confirmado: true },
    },
  }));
  armado.coordinador.preflight({ host: HOST });
  armado.coordinador.rotate({ host: HOST });
  armado.coordinador.provision({ host: HOST });

  // Sin `.pid` no hay nada que acreditar: los procesos siguen con el material viejo.
  const sinPids = armado.coordinador.respawn({ host: HOST });
  assert.equal(sinPids.ok, false);
  assert.equal(sinPids.causa, CAUSA.RESPAWN_INCOMPLETO);

  acreditarPidsVivos(dir);
  const conPids = armado.coordinador.respawn({ host: HOST });
  assert.equal(conPids.ok, true);
  assert.equal(conPids.stage, STAGE.RESPAWNED);
  assert.equal(armado.coordinador.readState(HOST).respawn.consumidores, CONSUMIDORES.length);
}));

// -----------------------------------------------------------------------------
// Auditoría: el sink productivo persiste, y persiste SANITIZADO
// -----------------------------------------------------------------------------

test('la evidencia se persiste en JSONL append-only y solo con campos del modelo cerrado', () => conOperador(() => {
  const dir = tmpPipeline();
  const armado = wiring.createProductionVaultMigration(deps(dir, {
    acreditacion: { rotate: { confirmado: true, version: VERSION_OK } },
  }));
  armado.coordinador.preflight({ host: HOST });
  armado.coordinador.rotate({ host: HOST });

  const registros = leerAuditoria(dir);
  assert.ok(registros.length >= 2, 'preflight y rotate tienen que dejar rastro');
  const permitidos = new Set(Object.keys(EVIDENCIA_CAMPOS));
  for (const r of registros) {
    assert.ok(typeof r.ts === 'string' && r.ts.endsWith('Z'), 'cada registro lleva timestamp ISO');
    for (const clave of Object.keys(r)) {
      assert.ok(permitidos.has(clave), `campo fuera del modelo cerrado de evidencia: ${clave}`);
    }
  }
  // Append-only: una segunda operación agrega, nunca reescribe.
  const antes = registros.length;
  armado.coordinador.provision({ host: HOST });
  assert.ok(leerAuditoria(dir).length > antes);
}));

test('el JSONL de auditoria no contiene ningun valor de credencial (canario)', () => conOperador(() => {
  const dir = tmpPipeline();
  const CANARIO = 'sk-ant-CANARIO-NO-DEBE-APARECER-0000';
  const previo = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = CANARIO;
  try {
    const armado = wiring.createProductionVaultMigration(deps(dir, {
      acreditacion: { rotate: { confirmado: true, version: VERSION_OK } },
    }));
    armado.coordinador.preflight({ host: HOST });
    armado.coordinador.rotate({ host: HOST });
    const crudo = fs.readFileSync(path.join(dir, 'audit', wiring.AUDIT_FILE), 'utf8');
    assert.equal(crudo.includes(CANARIO), false);
    assert.equal(crudo.includes('sk-ant'), false);
  } finally {
    if (previo === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = previo;
  }
}));

// -----------------------------------------------------------------------------
// CLI del operador — el punto de entrada que no existía
// -----------------------------------------------------------------------------

test('la CLI expone las etapas que el runbook le pide al operador', () => {
  for (const c of ['status', 'preflight', 'rotate', 'provision', 'respawn', 'observe']) {
    assert.ok(cli.COMANDOS.includes(c), `falta el comando ${c}`);
  }
});

test('la CLI reporta el gate cerrado con su propio codigo de salida', () => {
  const dir = tmpPipeline();
  const r = cli.runCli({
    argv: ['status'],
    deps: deps(dir, { loadConfig: () => configFake({ enabled: false }) }),
  });
  assert.equal(r.exitCode, cli.EXIT.GATE_CERRADO);
  assert.match(r.lines.join('\n'), /vault\.enabled/);
});

test('la CLI no acredita una rotacion sin la frase por STDIN', () => conOperador(() => {
  const dir = tmpPipeline();
  const r = cli.runCli({
    argv: ['rotate', '--host', HOST, '--version', VERSION_OK],
    confirmation: 'dale',
    deps: deps(dir),
  });
  assert.equal(r.exitCode, cli.EXIT.NO_CONFIRMADO);
  // Fail-closed de verdad: no se creó ni el directorio de estado.
  assert.equal(fs.existsSync(path.join(dir, 'state', 'vault-migration')), false);
}));

test('la CLI rechaza `rotate` sin etiqueta de version aunque la frase sea correcta', () => conOperador(() => {
  const dir = tmpPipeline();
  const r = cli.runCli({
    argv: ['rotate', '--host', HOST],
    confirmation: cli.CONFIRM.rotate,
    deps: deps(dir),
  });
  assert.equal(r.exitCode, cli.EXIT.USO_INVALIDO);
}));

test('la CLI exige --host: ninguna etapa se acredita en lote', () => {
  const r = cli.runCli({ argv: ['preflight'], deps: deps(tmpPipeline()) });
  assert.equal(r.exitCode, cli.EXIT.USO_INVALIDO);
  assert.match(r.lines.join('\n'), /falta --host/);
});

test('recorrido completo del operador por CLI: preflight, rotate, provision, respawn y status', () => conOperador(() => {
  const dir = tmpPipeline();
  const base = deps(dir);

  const pre = cli.runCli({ argv: ['preflight', '--host', HOST], deps: base });
  assert.equal(pre.exitCode, cli.EXIT.OK, pre.lines.join('\n'));

  const rot = cli.runCli({
    argv: ['rotate', '--host', HOST, '--version', VERSION_OK],
    // La frase llega con el CRLF que mete Windows: tiene que normalizarse.
    confirmation: `${cli.CONFIRM.rotate}\r\n`,
    deps: base,
  });
  assert.equal(rot.exitCode, cli.EXIT.OK, rot.lines.join('\n'));

  const prov = cli.runCli({
    argv: ['provision', '--host', HOST],
    confirmation: cli.CONFIRM.provision,
    deps: base,
  });
  assert.equal(prov.exitCode, cli.EXIT.OK, prov.lines.join('\n'));

  acreditarPidsVivos(dir);
  const resp = cli.runCli({ argv: ['respawn', '--host', HOST], deps: base });
  assert.equal(resp.exitCode, cli.EXIT.OK, resp.lines.join('\n'));

  // Esta es la condición que la rev-0 no podía alcanzar por ningún camino: un
  // host en `respawned`, que es el único estado que el tick del Pulpo procesa.
  const armado = wiring.createProductionVaultMigration(base);
  assert.equal(armado.coordinador.readState(HOST).stage, STAGE.RESPAWNED);

  const st = cli.runCli({ argv: ['status'], deps: base });
  assert.equal(st.exitCode, cli.EXIT.OK);
  assert.match(st.lines.join('\n'), /etapa: respawned/);

  // Sin resoluciones reales `via: vault` posteriores al respawn, la cobertura NO
  // cierra: cero errores no es éxito.
  const obs = cli.runCli({ argv: ['observe', '--host', HOST], deps: base });
  assert.equal(obs.exitCode, cli.EXIT.ETAPA_FALLIDA, obs.lines.join('\n'));
}));

test('el tick del Pulpo, con el mismo cableado y sin acreditacion, puede observar un host respawneado', () => conOperador(() => {
  const dir = tmpPipeline();
  const operador = wiring.createProductionVaultMigration(deps(dir, {
    acreditacion: {
      rotate: { confirmado: true, version: VERSION_OK },
      provision: { confirmado: true },
    },
  }));
  operador.coordinador.preflight({ host: HOST });
  operador.coordinador.rotate({ host: HOST });
  operador.coordinador.provision({ host: HOST });
  acreditarPidsVivos(dir);
  operador.coordinador.respawn({ host: HOST });

  // El Pulpo arma el coordinador SIN acreditación, exactamente como en pulpo.js.
  const pulpo = wiring.createProductionVaultMigration(deps(dir));
  const st = pulpo.coordinador.readState(HOST);
  assert.equal(st.stage, STAGE.RESPAWNED);
  assert.ok(['respawned', 'coexisting', 'cutover-ready'].includes(st.stage),
    'el filtro del tick de pulpo.js tiene que dar verdadero sobre este estado');
  // #5453 rev-4 — acá había un `assert.equal(typeof res.ok, 'boolean')` con el
  // mensaje "el tick evalúa de verdad, ya no es un no-op". `observeCoverage()`
  // devuelve SIEMPRE un `ok` booleano, así que esa aserción no podía fallar
  // por ninguna vía: era el único ejercicio del `readCoverage` productivo y
  // dejó pasar en verde los cinco defectos que encontró el review de rev-3.
  // Un test que no puede fallar no cubre nada; mide que el código existe.
  //
  // Ahora se afirma el VEREDICTO concreto: sin una sola fila `via: vault`
  // posterior al respawn, el tick del Pulpo tiene que rechazar con una causa
  // nombrada y dejar al host conviviendo — nunca listo para cortar.
  // Primer tick: el evaluador de #5427 todavia no tiene ventana persistida, la
  // arranca ahora y por contrato NO aprueba. El coordinador lo traduce a
  // `estado_indeterminado`, que es el fail-closed correcto: "no se pudo
  // determinar" nunca puede leerse como "esta cubierto".
  const primero = pulpo.coordinador.observeCoverage({ host: HOST });
  assert.equal(primero.ok, false, 'la primera evaluacion arranca la ventana, no la aprueba');
  assert.equal(primero.causa, CAUSA.ESTADO_INDETERMINADO);

  // Segundo tick, ya con el t0 persistido: ahora la ventana es evaluable y el
  // veredicto es sustantivo. Sin una sola fila `via: vault` posterior al
  // respawn, el host esta SILENCIOSO — cero errores no es exito.
  const res = pulpo.coordinador.observeCoverage({ host: HOST });
  assert.equal(res.ok, false, 'sin evidencia positiva el tick no puede aprobar nada');
  assert.equal(res.causa, CAUSA.HOST_SILENCIOSO,
    'un host que no resolvio nada esta silencioso, no cubierto');
  assert.equal(pulpo.coordinador.readState(HOST).stage, STAGE.COEXISTING,
    'observar sin cobertura deja al host en convivencia, no en cutover-ready');
  assert.notEqual(pulpo.coordinador.readState(HOST).stage, STAGE.CUTOVER_READY);

  // Y la evidencia de esa evaluación llegó a la auditoría: un `writeAudit`
  // mudo fue exactamente el fallo de la rev-0.
  const auditoria = leerAuditoria(dir);
  assert.ok(auditoria.length > 0, 'el tick tiene que dejar evidencia sanitizada');
  assert.ok(
    auditoria.some((e) => e.causa === CAUSA.HOST_SILENCIOSO),
    'la causa del rechazo tiene que quedar registrada, no solo el rechazo',
  );
}));

// -----------------------------------------------------------------------------
// Fuente cruzada — que el cableado no se vuelva a desconectar en silencio
// -----------------------------------------------------------------------------
//
// Los tests de arriba prueban que el cableado FUNCIONA. Estos prueban que es el
// que efectivamente corre: la rev-0 tenía un módulo impecable y un `pulpo.js`
// que lo instanciaba con stubs muertos, y ninguna suite lo notaba.

test('pulpo.js usa el cableado compartido y ya no inyecta stubs muertos', () => {
  const fuente = fs.readFileSync(path.join(__dirname, '..', '..', 'pulpo.js'), 'utf8');
  assert.ok(
    fuente.includes("require('./lib/vault-migration-wiring').createProductionVaultMigration"),
    'pulpo.js tiene que armar el coordinador con el cableado productivo compartido',
  );
  assert.equal(
    /rotate:\s*\(\)\s*=>\s*\(\{\s*ok:\s*false/.test(fuente), false,
    'un `rotate` que rechaza incondicionalmente deja la maquina de estados inalcanzable',
  );
  assert.equal(
    /provision:\s*\(\)\s*=>\s*\(\{\s*ok:\s*false/.test(fuente), false,
    'un `provision` que rechaza incondicionalmente deja la maquina de estados inalcanzable',
  );
  assert.equal(
    /writeAudit:\s*\(\)\s*=>\s*\{\s*\}/.test(fuente), false,
    'un `writeAudit` vacio descarta la evidencia sanitizada que el issue pide adjuntar',
  );
});

test('existe el ejecutable del operador y delega en la logica testeada', () => {
  const ruta = path.join(__dirname, '..', '..', 'vault-migration-run.js');
  assert.ok(fs.existsSync(ruta), 'sin ejecutable el operador no tiene como acreditar nada');
  const fuente = fs.readFileSync(ruta, 'utf8');
  assert.ok(fuente.includes("require('./lib/vault-migration-cli')"));
});

test('el runbook documenta un comando concreto para cada etapa que acredita el operador', () => {
  const runbook = fs.readFileSync(
    path.join(__dirname, '..', '..', '..', 'docs', 'runbooks', 'credential-rotation.md'), 'utf8',
  );
  for (const etapa of ['preflight', 'rotate', 'provision', 'respawn', 'observe']) {
    assert.ok(
      runbook.includes(`vault-migration-run.js ${etapa}`),
      `el runbook no dice que correr para la etapa "${etapa}"`,
    );
  }
  assert.ok(runbook.includes(cli.CONFIRM.rotate), 'la frase de confirmacion tiene que estar en el runbook');
  assert.ok(runbook.includes(cli.CONFIRM.provision), 'la frase de confirmacion tiene que estar en el runbook');
});

// -----------------------------------------------------------------------------
// Procedencia del config — el estado y la política tienen que salir del MISMO árbol
// -----------------------------------------------------------------------------
//
// #5453 rev-4. Hasta rev-3, `cargarConfig()` caía a
// `config-resolver.resolve()` SIN argumentos aunque el llamador hubiera pasado
// `pipelineDir`. El resolver entonces se guiaba por `REPO_ROOT` /
// `PIPELINE_REPO_ROOT` del ambiente —que el pipeline setea al repo principal—
// así que la CLI del operador corriendo dentro de un worktree escribía estado y
// auditoría en el worktree, pero leía el gate, `hosts_activos`,
// `required_scopes` y el ancla `vaultOnly` de OTRO repo.
//
// Decidir un corte irreversible con la política de un árbol y el estado de otro
// es el fail-open más caro que este módulo puede tener, y no lo cubría ninguna
// suite porque TODAS inyectaban `loadConfig`. Estos tests corren justamente el
// camino sin inyección.

/** Repo descartable con la forma que exige `config-resolver`. */
function repoFalso(overVault) {
  const yaml = require('js-yaml');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-repo-'));
  const pipelineDir = path.join(root, '.pipeline');
  fs.mkdirSync(pipelineDir);
  const real = yaml.load(fs.readFileSync(
    path.join(__dirname, '..', '..', 'config.yaml'), 'utf8',
  ));
  real.vault = Object.assign({}, real.vault, overVault);
  fs.writeFileSync(path.join(pipelineDir, 'config.yaml'), yaml.dump(real));
  fs.copyFileSync(
    path.join(__dirname, '..', '..', '..', 'pipeline.config.json'),
    path.join(root, 'pipeline.config.json'),
  );
  return { root, pipelineDir };
}

/** Apunta el ambiente a un repo DISTINTO del `pipelineDir` que se va a pasar. */
function conRepoRootAjeno(ajeno, fn) {
  const previos = {};
  for (const k of ['REPO_ROOT', 'PIPELINE_REPO_ROOT']) {
    previos[k] = process.env[k];
    process.env[k] = ajeno;
  }
  try { return fn(); } finally {
    for (const k of Object.keys(previos)) {
      if (previos[k] === undefined) delete process.env[k];
      else process.env[k] = previos[k];
    }
  }
}

test('sin `loadConfig` inyectado, el cableado lee el config del `pipelineDir` que se le paso', () => {
  // Árbol A: el que el operador está usando. Gate ABIERTO.
  const propio = repoFalso({
    enabled: true,
    migration: { enabled: true, tick_minutes: 15, auto_stages: ['observe'] },
  });
  // Árbol B: el que el ambiente anuncia por `REPO_ROOT`. Gate CERRADO.
  const ajeno = repoFalso({ enabled: false, migration: { enabled: false } });

  const armado = conRepoRootAjeno(ajeno.root, () => wiring.createProductionVaultMigration({
    pipelineDir: propio.pipelineDir,
    logger: () => {},
    metricsFactory: metricsFactoryEn(propio.pipelineDir),
  }));

  assert.equal(armado.gateAbierto, true,
    'el gate tiene que salir del arbol cuyo estado se va a mutar, no del que anuncia el ambiente');
  assert.equal(armado.gate, wiring.GATE.ABIERTO);
  assert.ok(armado.stateDir.startsWith(path.resolve(propio.pipelineDir)),
    'el estado ya vivia en el arbol propio: es la politica la que tenia que acompañarlo');
});

test('el `pipelineDir` manda tambien para CERRAR: un ambiente permisivo no abre un arbol cerrado', () => {
  const propio = repoFalso({ enabled: false, migration: { enabled: false } });
  const ajeno = repoFalso({
    enabled: true,
    migration: { enabled: true, tick_minutes: 15, auto_stages: ['observe'] },
  });

  const armado = conRepoRootAjeno(ajeno.root, () => wiring.createProductionVaultMigration({
    pipelineDir: propio.pipelineDir,
    logger: () => {},
    metricsFactory: metricsFactoryEn(propio.pipelineDir),
  }));

  assert.equal(armado.gateAbierto, false);
  assert.equal(armado.coordinador, null);
  assert.equal(fs.existsSync(armado.stateDir), false,
    'con el gate cerrado no se crea un solo archivo de estado');
});

// -----------------------------------------------------------------------------
// El gate del tick del Pulpo se reevalúa EN CALIENTE
// -----------------------------------------------------------------------------
//
// #5453 rev-4. El tick congelaba `etapasAuto` y el doble gate al arranque y sólo
// releía `hosts_activos`: poner `vault.enabled: false` o
// `vault.migration.enabled: false` en el config NO detenía nada hasta el
// próximo respawn del Pulpo, en contra de lo que promete `config.yaml`. Un gate
// que sólo se puede cerrar reiniciando el proceso no es un gate — y este apaga
// un flujo que toca material irreversible.

test('el tick de pulpo.js relee el doble gate y `auto_stages` en cada corrida, no al arrancar', () => {
  const fuente = fs.readFileSync(path.join(__dirname, '..', '..', 'pulpo.js'), 'utf8');
  const inicio = fuente.indexOf('const runMigrationTick = () =>');
  assert.ok(inicio > 0, 'no se encontro el tick de migracion en pulpo.js');
  const cuerpo = fuente.slice(inicio, inicio + 2600);

  assert.ok(/gateAbiertoEnCaliente\(fresh\)/.test(cuerpo),
    'el tick tiene que reevaluar el doble gate contra el config fresco de esta corrida');
  assert.ok(/auto_stages/.test(cuerpo),
    '`auto_stages` es politica, no configuracion de arranque: se relee con el resto');
  assert.equal(
    /const etapasAuto[\s\S]{0,400}const runMigrationTick/.test(fuente), false,
    'si `etapasAuto` se calcula ANTES del tick vuelve a quedar congelado al arranque',
  );
});

test('la reevaluacion del gate en caliente exige AMBOS booleanos exactos', () => {
  const fuente = fs.readFileSync(path.join(__dirname, '..', '..', 'pulpo.js'), 'utf8');
  const i = fuente.indexOf('const gateAbiertoEnCaliente');
  assert.ok(i > 0);
  const cuerpo = fuente.slice(i, i + 500);
  assert.ok(/v\.enabled === true && m\.enabled === true/.test(cuerpo),
    'fail-closed: `"true"`, `1` o `undefined` no pueden abrir el gate en caliente');
});
