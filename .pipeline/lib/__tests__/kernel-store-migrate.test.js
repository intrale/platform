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

  const r1 = await migrateState({ apply: true, store, sourceDir, backupRoot, now: FIXED_NOW });
  assert.equal(r1.ok, true, r1.error);

  // Conteo por clave tras la 1ra corrida.
  const waves1 = await store.getState('waves');
  const blocked1 = await store.getState('blocked');
  assert.equal(waves1.version, 1);
  assert.equal(countRecords(waves1.value), countRecords(src.waves));

  // 2da corrida idéntica: no debe duplicar ni bumpear versión (noop).
  const r2 = await migrateState({ apply: true, store, sourceDir, backupRoot, now: FIXED_NOW + 1000 });
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

  const res = await migrateState({ apply: true, store: lossyStore, sourceDir, backupRoot, now: FIXED_NOW });
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
  const res = await migrateState({ apply: true, store: coord, sourceDir, backupRoot, now: FIXED_NOW });
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
  const res = await migrateState({ apply: true, sourceDir, backupRoot, now: FIXED_NOW });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'store_required');
  // el backup se hizo igual (antes de intentar escribir).
  assert.ok(res.backupDir && fs.existsSync(res.backupDir));
});
