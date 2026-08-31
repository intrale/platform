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

/** Escribe los `.pid` de todos los consumidores como si `restart.js` acabara de correr. */
function acreditarPidsVivos(dir) {
  for (const nombre of CONSUMIDORES) {
    fs.writeFileSync(path.join(dir, `${nombre}.pid`), String(process.pid), 'utf8');
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
  assert.equal(registro.clave, `${HOST}:rotate:1`, 'la clave es <host>:<op>:<intento>, sin material');

  // Simulamos el crash: el operador YA rotó (el ledger lo prueba) pero el
  // avance de etapa no llegó a persistirse; queda el checkpoint pendiente que
  // deja `conCheckpoint()`.
  const rutaEstado = path.join(armado.stateDir, `host-${HOST}.json`);
  const estado = JSON.parse(fs.readFileSync(rutaEstado, 'utf8'));
  estado.stage = STAGE.PREFLIGHT;
  estado.rotacion = null;
  estado.pendiente = {
    op: 'rotate', clave: `${HOST}:rotate:1`, intento: 1, at: new Date().toISOString(),
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
  const res = pulpo.coordinador.observeCoverage({ host: HOST });
  assert.equal(typeof res.ok, 'boolean', 'el tick evalua de verdad, ya no es un no-op');
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
