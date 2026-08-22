'use strict';

// =============================================================================
// kernel-store-migrate.test.js — Tests de la migración de estado de coordinación
// (Ola Puente P3 · #4745). Driver in-memory (offline, determinístico).
//
// Cobertura mapeada a los CA del issue:
//   CA-2  idempotencia: re-run no duplica ni corrompe (conteo por clave estable).
//   CA-3  verificación de integridad detecta pérdida ⇒ integrity_mismatch.
//   CA-4  rollback restaura el estado previo exacto (checksum post == backup).
//   CA-5  no pierde historia de waves/labels/firmas (conteo+contenido; firmas
//         append-only intactas, SKs disjuntos).
//   CA-6/7 dry-run no escribe y reporta conteos+checksums+línea de rollback,
//         sin patrones de secreto.
//   CA-1/A08 backup con permisos restrictivos y sin secretos.
// =============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
  createCoordinationStore,
} = require('../kernel-coordination-store');
const { createKernelStore } = require('../kernel-store');
const { createInMemoryDynamoDriver } = require('../provisioner-infra');

const {
  migrateState,
  rollbackState,
  MIGRATION_KNOWN_KEYS,
  sha256Canonical,
  countRecords,
  compareIntegrity,
  redactSecrets,
  SOURCES,
  createBackup,
  readSources,
  backupDescriptors,
  restoreDescriptors,
} = require('../kernel-store-migrate');

const CTX = 'intrale-platform';
const FIXED_NOW = 1_752_768_000_000; // epoch ms fijo (determinístico)

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

let tmpCounter = 0;
function freshTmp(label) {
  tmpCounter += 1;
  const dir = path.join(os.tmpdir(), `ksm-${label}-${process.pid}-${tmpCounter}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// Contenido de las 4 fuentes (forma heterogénea: objeto/grafo/lista/objeto).
function writeSources(dir) {
  const waves = {
    version: 1,
    active_wave: { id: 'ola-8', labels: ['Ready', 'priority:high'] },
    planned_waves: [{ id: 'ola-9' }],
    archived_waves: [{ id: 'ola-7' }],
    integrity_hash: 'abc123',
  };
  const blocked = { blockedBy: { 4688: ['4745'] }, blocks: { 4745: ['4688'] } };
  const blockedInfra = { version: 1, issues: [], lastEvent: { type: 'connectivity_restored' } };
  const health = { dns: { ok: true }, retries: 0, circuitBreaker: { open: false } };
  fs.writeFileSync(path.join(dir, 'waves.json'), JSON.stringify(waves, null, 2));
  fs.writeFileSync(path.join(dir, 'blocked-issues.json'), JSON.stringify(blocked, null, 2));
  fs.writeFileSync(path.join(dir, 'blocked-by-infra.json'), JSON.stringify(blockedInfra, null, 2));
  fs.writeFileSync(path.join(dir, 'infra-health.json'), JSON.stringify(health, null, 2));
  return { waves, blocked, blockedInfra, health };
}

function makeStore(driver) {
  return createCoordinationStore({
    driver: driver || createInMemoryDynamoDriver(),
    contextProjectId: CTX,
    knownKeys: MIGRATION_KNOWN_KEYS,
  });
}

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

test('migración idempotente: re-run no duplica registros', async () => {
  const sourceDir = freshTmp('idem-src');
  const backupRoot = freshTmp('idem-bak');
  const src = writeSources(sourceDir);
  const store = makeStore();

  const r1 = await migrateState({ apply: true, sources: SOURCES, store, sourceDir, backupRoot, now: FIXED_NOW });
  assert.equal(r1.ok, true, r1.error);

  // Conteo por clave tras la 1ra corrida.
  const waves1 = await store.getState('waves');
  const blocked1 = await store.getState('blocked');
  assert.equal(waves1.version, 1);
  assert.equal(countRecords(waves1.value), countRecords(src.waves));

  // 2da corrida idéntica: no debe duplicar ni bumpear versión (noop).
  const r2 = await migrateState({ apply: true, sources: SOURCES, store, sourceDir, backupRoot, now: FIXED_NOW + 1000 });
  assert.equal(r2.ok, true, r2.error);
  assert.equal(r2.actions.waves, 'noop');
  assert.equal(r2.actions.blocked, 'noop');

  const waves2 = await store.getState('waves');
  assert.equal(waves2.version, 1, 'la versión no debe cambiar en re-run idéntico');
  assert.equal(countRecords(waves2.value), countRecords(src.waves), 'el conteo debe ser estable');
});

test('verificación de integridad detecta pérdida', () => {
  // compareIntegrity es fail-closed: falta de clave o checksum distinto ⇒ mismatch.
  const before = {
    waves: { checksum: 'aaa', records: 5 },
    blocked: { checksum: 'bbb', records: 2 },
  };
  // "después" pierde 'blocked' y cambia el checksum de 'waves'.
  const afterMissing = { waves: { checksum: 'ZZZ', records: 5 } };
  const res = compareIntegrity(before, afterMissing);
  assert.equal(res.ok, false);
  const reasons = res.mismatches.map((m) => `${m.key}:${m.reason}`);
  assert.ok(reasons.some((r) => r.startsWith('blocked:') && r.includes('ausente')));
  assert.ok(reasons.some((r) => r.startsWith('waves:') && r.includes('checksum')));

  // Igualdad exacta ⇒ ok.
  const same = compareIntegrity(before, before);
  assert.equal(same.ok, true);
});

test('verificación de integridad fail-closed: store que pierde un registro rechaza la migración', async () => {
  const sourceDir = freshTmp('lossy-src');
  const backupRoot = freshTmp('lossy-bak');
  writeSources(sourceDir);

  // Store adversario: al releer 'health' devuelve contenido mutilado (pérdida).
  const real = makeStore();
  const lossyStore = {
    getState: async (key) => {
      const s = await real.getState(key);
      if (s && key === 'health') {
        return { ...s, value: {} }; // droppea todo el contenido
      }
      return s;
    },
    initState: real.initState,
    compareAndSet: real.compareAndSet,
  };

  const res = await migrateState({ apply: true, sources: SOURCES, store: lossyStore, sourceDir, backupRoot, now: FIXED_NOW });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'integrity_mismatch');
  assert.ok(res.rollbackCmd && res.rollbackCmd.includes('--rollback'));
});

test('rollback restaura el estado previo exacto', async () => {
  const sourceDir = freshTmp('rb-src');
  const backupRoot = freshTmp('rb-bak');
  const src = writeSources(sourceDir);

  // Dry-run genera backup sin escribir.
  const dry = await migrateState({ apply: false, sourceDir, backupRoot, now: FIXED_NOW });
  assert.equal(dry.ok, true, dry.error);
  const backupDir = dry.backupDir;
  assert.ok(fs.existsSync(path.join(backupDir, 'waves.json')));

  // Corromper las fuentes en disco (simula pérdida/edición dañina).
  fs.writeFileSync(path.join(sourceDir, 'waves.json'), JSON.stringify({ version: 999, corrupt: true }, null, 2));
  fs.writeFileSync(path.join(sourceDir, 'infra-health.json'), '{}');

  // Rollback restaura desde el backup.
  const rb = rollbackState({ fromDir: backupDir, targetDir: sourceDir, backupRoot });
  assert.equal(rb.ok, true, rb.error);
  assert.ok(rb.restored.includes('waves.json'));

  // El checksum post-rollback == checksum del contenido original.
  const restoredWaves = JSON.parse(fs.readFileSync(path.join(sourceDir, 'waves.json'), 'utf8'));
  assert.equal(sha256Canonical(restoredWaves), sha256Canonical(src.waves));
});

test('rollback rechaza backup corrupto (no reintroduce estado dañado)', async () => {
  const sourceDir = freshTmp('rbc-src');
  const backupRoot = freshTmp('rbc-bak');
  writeSources(sourceDir);
  const dry = await migrateState({ apply: false, sourceDir, backupRoot, now: FIXED_NOW });
  const backupDir = dry.backupDir;

  // Alterar el archivo de backup SIN actualizar el manifest ⇒ checksum no coincide.
  fs.writeFileSync(path.join(backupDir, 'waves.json'), JSON.stringify({ tampered: true }, null, 2));

  const rb = rollbackState({ fromDir: backupDir, targetDir: sourceDir, backupRoot });
  assert.equal(rb.ok, false);
  assert.equal(rb.code, 'backup_corrupt');
});

test('rollback rechaza --from fuera de la raíz de backups (anti path-traversal)', () => {
  const backupRoot = freshTmp('pt-bak');
  const evil = path.join(backupRoot, '..', '..', 'etc');
  const rb = rollbackState({ fromDir: evil, backupRoot });
  assert.equal(rb.ok, false);
  assert.equal(rb.code, 'from_out_of_root');
});

test('rollback rechaza entrada de manifest con path-traversal (Zip-Slip) y no escribe fuera de targetDir', () => {
  const backupRoot = freshTmp('zs-bak');
  const targetDir = freshTmp('zs-tgt');
  const backupDir = path.join(backupRoot, 'backup-zs');
  fs.mkdirSync(backupDir, { recursive: true });

  // Backup atacante: clave de manifest que escapa del contenedor con '..'.
  // El atacante controla contenido Y checksum, por eso la verificación de
  // integridad (checksum recalculado sobre el value) NO frena el Zip-Slip.
  const evilKey = '../evil-escape.json';
  const payload = { pwned: true };
  const checksum = sha256Canonical(payload);

  // Se ubica el archivo malicioso donde la LECTURA resolvería, de modo que si
  // el fix no existiera la restauración procedería y escaparía en la ESCRITURA.
  const readTarget = path.resolve(backupDir, evilKey);
  fs.writeFileSync(readTarget, JSON.stringify(payload));
  const manifest = { files: { [evilKey]: { present: true, checksum } } };
  fs.writeFileSync(path.join(backupDir, 'manifest.json'), JSON.stringify(manifest));

  // Path donde escaparía la ESCRITURA (fuera de targetDir) si no hubiese fix.
  const escapedWrite = path.resolve(targetDir, evilKey);
  const existedBefore = fs.existsSync(escapedWrite);

  const rb = rollbackState({ fromDir: backupDir, targetDir, backupRoot });

  // Limpieza del artefacto de lectura antes de aserciones.
  try { fs.unlinkSync(readTarget); } catch { /* noop */ }

  assert.equal(rb.ok, false);
  assert.equal(rb.code, 'unsafe_backup_entry');
  // Garantía fuerte: NO se escribió nada fuera de targetDir.
  if (!existedBefore) {
    assert.equal(fs.existsSync(escapedWrite), false, 'no debe escribir fuera de targetDir');
  }
});

test('no pierde historia de waves/labels/firmas', async () => {
  const sourceDir = freshTmp('hist-src');
  const backupRoot = freshTmp('hist-bak');
  const src = writeSources(sourceDir);

  // Firmas GATE 2: viven append-only en el store durable (#4744), NO en los 4
  // JSON. Sembrar una firma sobre el MISMO driver para probar que la migración
  // de coordinación NO la toca (SKs disjuntos: signature# vs coord#).
  const driver = createInMemoryDynamoDriver();
  const durable = createKernelStore({ driver, contextProjectId: CTX, config: { kernel: { tableName: 't' } } });
  const sig = await durable.putSignature({
    signer: 'leitolarreta',
    target: 'wave:ola-8',
    checksum: 'a'.repeat(64),
    algorithm: 'sha256',
  });
  assert.equal(sig.ok, true);
  const sigId = sig.signatureId;

  const coord = createCoordinationStore({ driver, contextProjectId: CTX, knownKeys: MIGRATION_KNOWN_KEYS, config: { kernel: { tableName: 't' } } });
  const res = await migrateState({ apply: true, sources: SOURCES, store: coord, sourceDir, backupRoot, now: FIXED_NOW });
  assert.equal(res.ok, true, res.error);

  // waves + labels preservados con contenido idéntico.
  const waves = await coord.getState('waves');
  assert.deepEqual(waves.value.active_wave.labels, src.waves.active_wave.labels);
  assert.equal(sha256Canonical(waves.value), sha256Canonical(src.waves));

  // La firma sigue intacta tras la migración (no se perdió ni sobrescribió).
  const stillThere = await durable.getSignature(sigId);
  assert.ok(stillThere, 'la firma GATE 2 debe seguir presente tras la migración');
  assert.equal(stillThere.body.signer, 'leitolarreta');
});

test('dry-run no escribe y reporta conteos+checksums+línea de rollback sin secretos', async () => {
  const sourceDir = freshTmp('dry-src');
  const backupRoot = freshTmp('dry-bak');
  writeSources(sourceDir);
  const store = makeStore();

  const res = await migrateState({ apply: false, sourceDir, backupRoot, now: FIXED_NOW, store });
  assert.equal(res.ok, true, res.error);
  assert.equal(res.dryRun, true);

  // (a) NO escribió en el store.
  assert.equal(await store.getState('waves'), null, 'dry-run no debe escribir en el store');

  // (b) reporte con conteo por clave, checksum y línea de rollback.
  const rep = res.report;
  assert.ok(rep.includes('[DRY-RUN]'));
  assert.ok(rep.includes('VERIFICACIÓN'));
  assert.ok(/ROLLBACK: node .*--rollback --from/.test(rep));
  for (const s of SOURCES) assert.ok(rep.includes(s.key), `reporte debe mencionar la clave ${s.key}`);

  // (c) sin patrones de secreto (AWS key / JWT).
  assert.ok(!/AKIA[0-9A-Z]{16}/.test(rep));
  assert.ok(!/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/.test(rep));

  // (d) regresión: los checksums sha256 (hex) NO deben ser redactados — son
  // dato público de integridad, no secreto. El reporte debe mostrar hex real.
  assert.ok(/[a-f0-9]{64}/.test(rep), 'el reporte debe mostrar checksums sha256 en hex, no [REDACTED]');
  assert.ok(!rep.includes('[REDACTED]'), 'ningún checksum debe salir enmascarado');
});

test('backup no world-readable y sin secretos', async () => {
  const sourceDir = freshTmp('perm-src');
  const backupRoot = freshTmp('perm-bak');
  writeSources(sourceDir);

  const res = await migrateState({ apply: false, sourceDir, backupRoot, now: FIXED_NOW });
  assert.equal(res.ok, true, res.error);
  const backupDir = res.backupDir;

  // Permisos restrictivos (POSIX). En Windows el bit de modo no aplica igual;
  // se verifica sólo cuando la plataforma lo soporta.
  if (process.platform !== 'win32') {
    const dirMode = fs.statSync(backupDir).mode & 0o777;
    assert.equal(dirMode & 0o077, 0, `dir de backup no debe ser accesible por grupo/otros (mode=${dirMode.toString(8)})`);
    const fileMode = fs.statSync(path.join(backupDir, 'waves.json')).mode & 0o777;
    assert.equal(fileMode & 0o077, 0, `archivo de backup no debe ser accesible por grupo/otros (mode=${fileMode.toString(8)})`);
  }

  // Grep anti-secreto sobre todo el backup.
  for (const file of fs.readdirSync(backupDir)) {
    const content = fs.readFileSync(path.join(backupDir, file), 'utf8');
    assert.ok(!/AKIA[0-9A-Z]{16}/.test(content), `backup ${file} no debe contener AWS keys`);
    assert.ok(!/-----BEGIN [A-Z ]+PRIVATE KEY-----/.test(content), `backup ${file} no debe contener claves privadas`);
  }
});

test('redactSecrets enmascara AWS keys, JWT y tokens', () => {
  const dirty = 'clave AKIAIOSFODNN7EXAMPLE y token=super-secreto123 y jwt eyJabc.def123.ghi456';
  const clean = redactSecrets(dirty);
  assert.ok(!clean.includes('AKIAIOSFODNN7EXAMPLE'));
  assert.ok(clean.includes('[REDACTED]'));
  assert.ok(!/token=super-secreto123/.test(clean));
});

test('migrateState falla fail-closed cuando no hay ninguna fuente', async () => {
  const sourceDir = freshTmp('empty-src'); // vacío
  const backupRoot = freshTmp('empty-bak');
  const res = await migrateState({ apply: false, sourceDir, backupRoot, now: FIXED_NOW });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'no_sources');
});

test('migrateState --apply sin store devuelve error como dato (no throw)', async () => {
  const sourceDir = freshTmp('nostore-src');
  const backupRoot = freshTmp('nostore-bak');
  writeSources(sourceDir);
  const res = await migrateState({ apply: true, sources: SOURCES, sourceDir, backupRoot, now: FIXED_NOW });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'store_required');
  // el backup se hizo igual (antes de intentar escribir).
  assert.ok(res.backupDir && fs.existsSync(res.backupDir));
});

// =============================================================================
// #5136 — Alcance del migrador, backup de descriptores y runbook
// =============================================================================

// -----------------------------------------------------------------------------
// CA-11′ · `sources` distingue TRES casos (undefined / array incl. vacío / otra cosa)
// -----------------------------------------------------------------------------

test('CA-11′: sources vacío NO migra ninguna fuente (no cae al default SOURCES)', async () => {
  const sourceDir = freshTmp('src-empty-arr-src');
  const backupRoot = freshTmp('src-empty-arr-bak');
  writeSources(sourceDir); // las 4 fuentes prohibidas EXISTEN en disco
  const store = makeStore();

  const res = await migrateState({ apply: true, sources: [], store, sourceDir, backupRoot, now: FIXED_NOW });

  // `[]` llega tal cual a readSources ⇒ items = [] ⇒ `no_sources`, que es la
  // semántica correcta de "no migres nada". La trampa vieja (`&& .length`) hacía
  // que esto cayera al default y migrara las 4 fuentes prohibidas.
  assert.equal(res.ok, false);
  assert.equal(res.code, 'no_sources');

  // Garantía dura de CA-11′/CA-19: NINGUNA de las 4 fuentes prohibidas se migró.
  for (const key of ['waves', 'blocked', 'blocked-by-infra', 'health']) {
    assert.equal(await store.getState(key), null, `sources: [] no debe migrar la clave ${key}`);
  }
});

test('CA-11′: sources no-array devuelve sources_invalidas como dato (nunca throw)', async () => {
  const sourceDir = freshTmp('src-bad-src');
  const backupRoot = freshTmp('src-bad-bak');
  writeSources(sourceDir);
  const store = makeStore();

  for (const bad of [null, {}, 'waves', 3, true]) {
    let res;
    // "como dato, no throw": si lanzara, este await explotaría y el test falla.
    await assert.doesNotReject(async () => {
      res = await migrateState({ apply: true, sources: bad, store, sourceDir, backupRoot, now: FIXED_NOW });
    }, `sources: ${JSON.stringify(bad)} no debe lanzar excepción`);
    assert.equal(res.ok, false, `sources: ${JSON.stringify(bad)} debe fallar`);
    assert.equal(res.code, 'sources_invalidas', `sources: ${JSON.stringify(bad)} ⇒ sources_invalidas`);
  }

  // Y no migró nada ni escribió backup (el guard corre antes que todo).
  for (const key of ['waves', 'blocked', 'blocked-by-infra', 'health']) {
    assert.equal(await store.getState(key), null);
  }
  assert.deepEqual(fs.readdirSync(backupRoot), [], 'sources_invalidas no debe crear backup');
});

// -----------------------------------------------------------------------------
// CA-12′ · `apply: true` exige `sources` explícitas; dry-run conserva el default
// -----------------------------------------------------------------------------

test('CA-12′: apply sin sources explícitas falla cerrado con sources_no_explicitas', async () => {
  const sourceDir = freshTmp('noexp-src');
  const backupRoot = freshTmp('noexp-bak');
  writeSources(sourceDir);
  const store = makeStore();

  const res = await migrateState({ apply: true, store, sourceDir, backupRoot, now: FIXED_NOW });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'sources_no_explicitas');

  // El guard va ARRIBA del backup: no muta nada, ni siquiera el filesystem.
  assert.deepEqual(fs.readdirSync(backupRoot), [], 'sources_no_explicitas no debe crear backup');
  for (const key of ['waves', 'blocked', 'blocked-by-infra', 'health']) {
    assert.equal(await store.getState(key), null);
  }
});

test('CA-12′: dry-run sin sources conserva el default SOURCES y no muta nada', async () => {
  const sourceDir = freshTmp('dryok-src');
  const backupRoot = freshTmp('dryok-bak');
  writeSources(sourceDir);
  const store = makeStore();

  const res = await migrateState({ apply: false, store, sourceDir, backupRoot, now: FIXED_NOW });
  assert.equal(res.ok, true, res.error);
  assert.equal(res.dryRun, true);

  // El default se conserva: las 4 claves de SOURCES están en el snapshot previo.
  assert.deepEqual(Object.keys(res.before).sort(), SOURCES.map((s) => s.key).sort());
  // Y sigue sin escribir en el store.
  assert.equal(await store.getState('waves'), null);
});

// -----------------------------------------------------------------------------
// CA-12b · El CLI `--apply` falla cerrado y no migra estado prohibido (D-4/AD-2)
// -----------------------------------------------------------------------------

test('CA-12b: el CLI --apply falla cerrado, no escribe fuentes prohibidas ni crea backup', () => {
  const migratePath = path.resolve(__dirname, '..', 'kernel-store-migrate.js');
  const pipelineDir = path.resolve(__dirname, '..', '..'); // `.pipeline/` REAL
  const backupDir = path.join(pipelineDir, 'backup');

  // Huella ANTES: existencia+contenido de `.pipeline/backup/` y estado (mtime+
  // size) de las 4 fuentes operativas reales que #5112 prohíbe migrar.
  const backupExistedBefore = fs.existsSync(backupDir);
  const backupListBefore = backupExistedBefore ? fs.readdirSync(backupDir).sort() : null;
  const stamp = () => SOURCES.map((s) => {
    const full = path.join(pipelineDir, s.file);
    if (!fs.existsSync(full)) return `${s.file}:absent`;
    const st = fs.statSync(full);
    return `${s.file}:${st.size}:${st.mtimeMs}`;
  }).join('|');
  const sourcesBefore = stamp();

  // Corre SIN credenciales AWS: por AD-2 el guard está antes de instanciar el
  // store. Si este test pidiera credenciales, el guard quedó mal ubicado.
  const run = spawnSync(process.execPath, [migratePath, '--apply'], {
    encoding: 'utf8',
    cwd: pipelineDir,
    timeout: 30_000,
  });

  // (a) sale con código ≠ 0
  assert.notEqual(run.status, 0, `--apply debe salir con código ≠ 0 (status=${run.status})`);
  // (b) imprime el código de error y qué SÍ puebla los descriptores
  assert.match(run.stdout, /alcance_no_implementado/, 'stdout debe nombrar alcance_no_implementado');
  assert.match(run.stdout, /durableRegisterProduct/, 'stdout debe nombrar durableRegisterProduct');
  // (c) NO creó ningún directorio de backup
  assert.equal(fs.existsSync(backupDir), backupExistedBefore, '--apply no debe crear .pipeline/backup/');
  if (backupExistedBefore) {
    assert.deepEqual(fs.readdirSync(backupDir).sort(), backupListBefore, '--apply no debe agregar backups');
  }
  // (d) NO tocó ninguna de las 4 fuentes prohibidas
  assert.equal(stamp(), sourcesBefore, '--apply no debe escribir las 4 fuentes operativas prohibidas');
});

// Nota: no se testea el dry-run del CLI por spawn a propósito. `defaultPipelineDir()`
// resuelve al `.pipeline/` REAL (no depende del cwd), así que un spawn sin flags
// escribiría un backup de verdad en `.pipeline/backup/` — un efecto de filesystem
// que la suite no tenía. La no-interferencia del guard sobre el camino dry-run
// queda cubierta por el test de función «CA-12′: dry-run sin sources conserva el
// default SOURCES», y se verifica a mano en la pre-checklist del issue.

test('CA-12b: el guard del CLI corre ANTES de instanciar el store (AD-2)', () => {
  // Si el guard estuviera después del `require('./kernel-coordination-store')`,
  // --apply fallaría por credenciales/instanciación en vez de por alcance, y el
  // mensaje sería otro. Que salga EXACTAMENTE `alcance_no_implementado` —y no
  // `[FALLA] no se pudo instanciar el store`— es la prueba de la ubicación.
  const migratePath = path.resolve(__dirname, '..', 'kernel-store-migrate.js');
  const run = spawnSync(process.execPath, [migratePath, '--apply'], {
    encoding: 'utf8',
    timeout: 30_000,
    // Entorno sin credenciales AWS: por AD-2 el comando no las necesita.
    env: { ...process.env, AWS_ACCESS_KEY_ID: '', AWS_SECRET_ACCESS_KEY: '', AWS_PROFILE: '' },
  });
  assert.match(run.stdout, /alcance_no_implementado/);
  assert.doesNotMatch(run.stdout, /no se pudo instanciar el store/, 'el guard debe cortar ANTES del store (AD-2)');
});

// -----------------------------------------------------------------------------
// CA-13′ · Backup de descriptores con destino y manifest propios
// -----------------------------------------------------------------------------

// Escribe N descriptores de forma determinística. Indentación 2 == la que usa
// `backupDescriptors`, para poder comparar byte a byte en la restauración.
function writeDescriptors(dir) {
  const primary = { schemaVersion: '1.0', identity: { projectId: 'intrale-platform', primary: true } };
  const second = { schemaVersion: '1.0', identity: { projectId: 'otro-producto', primary: false } };
  fs.writeFileSync(path.join(dir, 'intrale-platform.json'), JSON.stringify(primary, null, 2));
  fs.writeFileSync(path.join(dir, 'otro-producto.json'), JSON.stringify(second, null, 2));
  return { primary, second };
}

test('CA-13′: backupDescriptors produce manifest con checksum sha256 canónico', () => {
  const descriptorsDir = freshTmp('desc-src');
  const backupRoot = freshTmp('desc-bak');
  const d = writeDescriptors(descriptorsDir);

  const res = backupDescriptors({ descriptorsDir, backupRoot, epochMs: FIXED_NOW });
  assert.equal(res.ok, true, res.error);
  assert.equal(res.count, 2);

  // Destino bajo la raíz de backups (gitignoreada) y en subdirectorio propio.
  assert.equal(path.basename(res.dir), 'descriptors');
  assert.ok(res.dir.startsWith(path.resolve(backupRoot)), 'el destino debe caer dentro de backupRoot');

  // Manifest propio con checksum canónico y conteo.
  const manifest = JSON.parse(fs.readFileSync(path.join(res.dir, 'manifest.json'), 'utf8'));
  assert.equal(manifest.kind, 'descriptors');
  assert.equal(manifest.files['intrale-platform.json'].checksum, sha256Canonical(d.primary));
  assert.equal(manifest.files['otro-producto.json'].checksum, sha256Canonical(d.second));
  assert.equal(manifest.files['intrale-platform.json'].records, countRecords(d.primary));
  assert.match(manifest.files['intrale-platform.json'].checksum, /^[a-f0-9]{64}$/);
});

test('CA-13′: los dos backups del MISMO epoch no se pisan (manifests separados e íntegros)', () => {
  const sourceDir = freshTmp('two-src');
  const descriptorsDir = freshTmp('two-desc');
  const backupRoot = freshTmp('two-bak');
  const src = writeSources(sourceDir);
  const d = writeDescriptors(descriptorsDir);

  // MISMO epochMs para los dos artefactos: `backupDirName` es puro ⇒ mismo <ts>.
  const items = readSources(sourceDir, SOURCES);
  const coordBk = createBackup(items, backupRoot, FIXED_NOW);
  const descBk = backupDescriptors({ descriptorsDir, backupRoot, epochMs: FIXED_NOW });

  assert.equal(coordBk.ok, true, coordBk.error);
  assert.equal(descBk.ok, true, descBk.error);

  // El de descriptores vive UN NIVEL ABAJO del de coordinación ⇒ imposible pisar
  // el manifest.json del otro.
  assert.equal(descBk.dir, path.join(coordBk.dir, 'descriptors'));

  // Los DOS manifests quedan legibles e íntegros, y cada uno declara SU conjunto.
  const coordManifest = JSON.parse(fs.readFileSync(path.join(coordBk.dir, 'manifest.json'), 'utf8'));
  const descManifest = JSON.parse(fs.readFileSync(path.join(descBk.dir, 'manifest.json'), 'utf8'));

  assert.deepEqual(Object.keys(coordManifest.files).sort(), SOURCES.map((s) => s.file).sort());
  assert.deepEqual(Object.keys(descManifest.files).sort(), ['intrale-platform.json', 'otro-producto.json']);
  assert.equal(coordManifest.files['waves.json'].checksum, sha256Canonical(src.waves));
  assert.equal(descManifest.files['otro-producto.json'].checksum, sha256Canonical(d.second));
  // Ningún archivo de descriptores se coló en el manifest de coordinación.
  assert.equal(coordManifest.files['intrale-platform.json'], undefined);
});

test('CA-13′: el backup de descriptores no es world-readable (POSIX)', () => {
  const descriptorsDir = freshTmp('descperm-src');
  const backupRoot = freshTmp('descperm-bak');
  writeDescriptors(descriptorsDir);

  const res = backupDescriptors({ descriptorsDir, backupRoot, epochMs: FIXED_NOW });
  assert.equal(res.ok, true, res.error);

  // Mismo patrón de skip que ya usa la suite: en Windows el bit de modo no aplica.
  if (process.platform !== 'win32') {
    const dirMode = fs.statSync(res.dir).mode & 0o777;
    assert.equal(dirMode & 0o077, 0, `dir de backup no debe ser accesible por grupo/otros (mode=${dirMode.toString(8)})`);
    for (const f of ['intrale-platform.json', 'manifest.json']) {
      const fileMode = fs.statSync(path.join(res.dir, f)).mode & 0o777;
      assert.equal(fileMode & 0o077, 0, `${f} no debe ser accesible por grupo/otros (mode=${fileMode.toString(8)})`);
    }
  }
});

test('CA-13′: sin descriptores falla cerrado (un backup vacío no es un backup)', () => {
  const descriptorsDir = freshTmp('descempty-src'); // vacío
  const backupRoot = freshTmp('descempty-bak');
  const res = backupDescriptors({ descriptorsDir, backupRoot, epochMs: FIXED_NOW });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'descriptors_absent');
  assert.match(res.error, /durableRegisterProduct/, 'debe decir qué SÍ puebla los descriptores');
});

// -----------------------------------------------------------------------------
// CA-13b · El backup de descriptores se puede RESTAURAR (D-5 / AD-3)
// -----------------------------------------------------------------------------

test('CA-13b: backup → restore devuelve los descriptores íntegros byte a byte', () => {
  const descriptorsDir = freshTmp('rt-desc');
  const backupRoot = freshTmp('rt-bak');
  const d = writeDescriptors(descriptorsDir);
  const originalBytes = fs.readFileSync(path.join(descriptorsDir, 'intrale-platform.json'));

  const bk = backupDescriptors({ descriptorsDir, backupRoot, epochMs: FIXED_NOW });
  assert.equal(bk.ok, true, bk.error);

  // Destruir/corromper los descriptores en disco (simula el cutover salido mal).
  fs.writeFileSync(path.join(descriptorsDir, 'intrale-platform.json'), JSON.stringify({ pwned: true }, null, 2));
  fs.unlinkSync(path.join(descriptorsDir, 'otro-producto.json'));

  const rs = restoreDescriptors({ fromDir: bk.dir, targetDir: descriptorsDir, backupRoot });
  assert.equal(rs.ok, true, rs.error);
  assert.deepEqual(rs.restored.sort(), ['intrale-platform.json', 'otro-producto.json']);

  // Íntegros: byte a byte y por checksum canónico.
  assert.deepEqual(fs.readFileSync(path.join(descriptorsDir, 'intrale-platform.json')), originalBytes);
  const back = JSON.parse(fs.readFileSync(path.join(descriptorsDir, 'otro-producto.json'), 'utf8'));
  assert.equal(sha256Canonical(back), sha256Canonical(d.second));
});

test('CA-13b: el round-trip preserva los bytes exactos (CRLF e indentación original)', () => {
  // Los descriptores están VERSIONADOS en git y en Windows vienen con CRLF. Si el
  // backup/restore re-serializara con JSON.stringify, devolvería un archivo
  // semánticamente igual pero byte-distinto, ensuciando el `git diff` justo
  // cuando el operador está tratando de volver atrás del cutover.
  const descriptorsDir = freshTmp('bytes-desc');
  const backupRoot = freshTmp('bytes-bak');

  // Formato deliberadamente NO canónico: CRLF, indentación de 4 y newline final.
  const exotic = '{\r\n    "schemaVersion": "1.0",\r\n    "identity": { "projectId": "intrale-platform" }\r\n}\r\n';
  const target = path.join(descriptorsDir, 'intrale-platform.json');
  fs.writeFileSync(target, exotic);
  const originalBytes = fs.readFileSync(target);

  const bk = backupDescriptors({ descriptorsDir, backupRoot, epochMs: FIXED_NOW });
  assert.equal(bk.ok, true, bk.error);
  // El backup ya guarda los bytes crudos, no una re-serialización.
  assert.deepEqual(fs.readFileSync(path.join(bk.dir, 'intrale-platform.json')), originalBytes);

  fs.writeFileSync(target, JSON.stringify({ pwned: true }, null, 2));
  const rs = restoreDescriptors({ fromDir: bk.dir, targetDir: descriptorsDir, backupRoot });
  assert.equal(rs.ok, true, rs.error);

  assert.deepEqual(fs.readFileSync(target), originalBytes, 'la restauración debe devolver los bytes EXACTOS');
  // Y el checksum del manifest sigue siendo canónico (indiferente al formato).
  const manifest = JSON.parse(fs.readFileSync(path.join(bk.dir, 'manifest.json'), 'utf8'));
  assert.equal(
    manifest.files['intrale-platform.json'].checksum,
    sha256Canonical(JSON.parse(exotic)),
    'el checksum es canónico, no un hash de los bytes',
  );
});

test('CA-13b: entradas fuera del conjunto cerrado se rechazan fail-closed y no escriben nada', () => {
  const backupRoot = freshTmp('zsd-bak');
  const targetDir = freshTmp('zsd-tgt');

  // Cada entrada ataca una contención distinta: '..' (identidad de basename),
  // subdirectorio (separador de ruta), extensión ajena (gramática cerrada).
  for (const evilKey of ['../evil.json', 'sub/dir.json', 'x.txt']) {
    const fromDir = path.join(backupRoot, `bk-${evilKey.replace(/[^a-z0-9]/gi, '_')}`, 'descriptors');
    fs.mkdirSync(fromDir, { recursive: true });

    // El atacante controla contenido Y checksum: por eso el checksum NO frena un
    // Zip-Slip, y la gramática cerrada es lo único que contiene.
    const payload = { pwned: true };
    const checksum = sha256Canonical(payload);
    const readTarget = path.resolve(fromDir, evilKey);
    fs.mkdirSync(path.dirname(readTarget), { recursive: true });
    fs.writeFileSync(readTarget, JSON.stringify(payload));
    fs.writeFileSync(
      path.join(fromDir, 'manifest.json'),
      JSON.stringify({ schemaVersion: '1.0', kind: 'descriptors', files: { [evilKey]: { present: true, checksum } } }),
    );

    const escapedWrite = path.resolve(targetDir, evilKey);
    const existedBefore = fs.existsSync(escapedWrite);
    const targetBefore = fs.readdirSync(targetDir).sort();

    const rs = restoreDescriptors({ fromDir, targetDir, backupRoot });

    try { fs.unlinkSync(readTarget); } catch { /* noop */ }

    assert.equal(rs.ok, false, `"${evilKey}" debe ser rechazada`);
    assert.equal(rs.code, 'unsafe_descriptor_entry', `"${evilKey}" ⇒ unsafe_descriptor_entry`);
    // No escribió NADA: ni fuera de targetDir ni adentro.
    if (!existedBefore) {
      assert.equal(fs.existsSync(escapedWrite), false, `"${evilKey}" no debe escribir fuera de targetDir`);
    }
    assert.deepEqual(fs.readdirSync(targetDir).sort(), targetBefore, `"${evilKey}" no debe escribir dentro de targetDir`);
  }
});

test('CA-13b: backup de descriptores corrupto se rechaza (no reintroduce estado dañado)', () => {
  const descriptorsDir = freshTmp('dcorrupt-src');
  const backupRoot = freshTmp('dcorrupt-bak');
  writeDescriptors(descriptorsDir);
  const bk = backupDescriptors({ descriptorsDir, backupRoot, epochMs: FIXED_NOW });
  assert.equal(bk.ok, true, bk.error);

  // Alterar el archivo del backup SIN actualizar el manifest ⇒ checksum no coincide.
  fs.writeFileSync(path.join(bk.dir, 'intrale-platform.json'), JSON.stringify({ tampered: true }, null, 2));
  const before = fs.readFileSync(path.join(descriptorsDir, 'intrale-platform.json'));

  const rs = restoreDescriptors({ fromDir: bk.dir, targetDir: descriptorsDir, backupRoot });
  assert.equal(rs.ok, false);
  assert.equal(rs.code, 'descriptors_backup_corrupt');
  // Validación en dos pasos: si UNA entrada falla, no se escribió NINGUNA.
  assert.deepEqual(fs.readFileSync(path.join(descriptorsDir, 'intrale-platform.json')), before);
});

test('CA-13b: restore fuera de la raíz de backups se rechaza (anti path-traversal)', () => {
  const backupRoot = freshTmp('drt-bak');
  const evil = path.join(backupRoot, '..', '..', 'etc');
  const rs = restoreDescriptors({ fromDir: evil, backupRoot });
  assert.equal(rs.ok, false);
  assert.equal(rs.code, 'descriptors_from_out_of_root');
});

// -----------------------------------------------------------------------------
// CA-23 · Los mensajes de error nuevos dicen causa + acción + la trampa (UX-7)
// -----------------------------------------------------------------------------

test('CA-23: sources_invalidas y sources_no_explicitas dicen causa, acción y la trampa', async () => {
  const sourceDir = freshTmp('copy-src');
  const backupRoot = freshTmp('copy-bak');
  writeSources(sourceDir);

  const invalid = await migrateState({ apply: true, sources: null, sourceDir, backupRoot, now: FIXED_NOW });
  assert.equal(invalid.code, 'sources_invalidas');
  assert.match(invalid.error, /debe ser un array/, 'causa');
  assert.match(invalid.error, /Omitilo|pasá \[\]/, 'acción siguiente');
  assert.match(invalid.error, /trampa/i, 'la trampa: [] no es "usar el default"');

  const noExp = await migrateState({ apply: true, sourceDir, backupRoot, now: FIXED_NOW });
  assert.equal(noExp.code, 'sources_no_explicitas');
  assert.match(noExp.error, /requiere declarar 'sources' explícitamente/, 'causa');
  assert.match(noExp.error, /apply: false/, 'acción siguiente');
  assert.match(noExp.error, /No pases SOURCES/, 'la trampa, nombrada explícitamente');
  assert.match(noExp.error, /waves, blocked, blocked-by-infra, health/, 'nombra las 4 fuentes prohibidas');
  // AD-1: el flag `--sources` NO existe; el copy no puede mandar a un camino inexistente.
  assert.doesNotMatch(noExp.error, /--sources/, 'no debe mencionar un flag --sources (AD-1)');
  assert.doesNotMatch(noExp.error, /--apply/, 'no debe mandar a reintentar --apply de otra forma (AD-1)');
});

test('CA-23: alcance_no_implementado dice causa, acción y la trampa', () => {
  const migratePath = path.resolve(__dirname, '..', 'kernel-store-migrate.js');
  const run = spawnSync(process.execPath, [migratePath, '--apply'], { encoding: 'utf8', timeout: 30_000 });
  const out = run.stdout;
  assert.match(out, /Qué pasó:/, 'causa');
  assert.match(out, /Qué hacer ahora:/, 'acción siguiente');
  assert.match(out, /La trampa:/, 'la trampa');
  assert.match(out, /SOURCES/, 'nombra la trampa concreta: pasar SOURCES');
  assert.match(out, /durableRegisterProduct/, 'nombra lo que SÍ puebla descriptores/catálogo');
});

// -----------------------------------------------------------------------------
// CA-24 · Un solo léxico: nunca `descriptor#*`, siempre las claves reales
// -----------------------------------------------------------------------------

test('CA-24: el migrador y el runbook usan las claves reales, nunca descriptor#*', () => {
  const repoRoot = path.resolve(__dirname, '..', '..', '..');
  const targets = [
    path.join(repoRoot, '.pipeline', 'lib', 'kernel-store-migrate.js'),
    path.join(repoRoot, 'docs', 'pipeline', 'runbook-cutover-durable.md'),
  ];
  for (const f of targets) {
    assert.ok(fs.existsSync(f), `debe existir ${f}`);
    const content = fs.readFileSync(f, 'utf8');
    assert.equal(content.includes('descriptor#*'), false, `${path.basename(f)} no debe usar descriptor#* (CA-24)`);
    assert.ok(content.includes('descriptor#self'), `${path.basename(f)} debe usar la clave real descriptor#self`);
    assert.ok(content.includes('catalog#index'), `${path.basename(f)} debe usar la clave real catalog#index`);
  }
});

// -----------------------------------------------------------------------------
// CA-17′ · Cero datos reales en el runbook (vive en git)
// -----------------------------------------------------------------------------

test('CA-17′: el runbook no filtra ARNs, account-ids ni access key ids', () => {
  const repoRoot = path.resolve(__dirname, '..', '..', '..');
  const runbook = path.join(repoRoot, 'docs', 'pipeline', 'runbook-cutover-durable.md');
  const content = fs.readFileSync(runbook, 'utf8');
  const leaks = content.split('\n')
    .map((line, i) => ({ line, n: i + 1 }))
    .filter(({ line }) => /arn:aws|[0-9]{12}|AKIA[0-9A-Z]{16}/.test(line));
  assert.deepEqual(leaks, [], `el runbook no debe contener datos reales: ${JSON.stringify(leaks)}`);
});
