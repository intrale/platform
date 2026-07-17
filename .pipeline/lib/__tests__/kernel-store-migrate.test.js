'use strict';

// =============================================================================
// kernel-store-migrate.test.js — Migración JSON→DynamoDB del estado de
// coordinación del kernel (Ola Puente P3 · #4745)
//
// Cobertura (driver in-memory + fixtures en tmpdir, offline):
//   - idempotencia: re-run no duplica ni sube versión (conteo por clave estable).
//   - verificación de integridad detecta pérdida (fail-closed).
//   - rollback restaura el estado previo exacto (checksum del backup).
//   - no pierde historia de waves/blocked/health + firmas (conteo).
//   - dry-run no escribe y reporta conteos + checksums + línea de rollback sin
//     secretos.
//   - backup no world-readable, sin secretos y con rutas relativas.
//   - seguridad: rollback rechaza --from fuera del backupRoot y backup corrupto.
// =============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createCoordinationStore } = require('../kernel-coordination-store');
const {
  migrateState,
  verifyIntegrity,
  canonicalChecksum,
  redactSecrets,
  rollbackCommand,
  MIGRATION_PLAN,
} = require('../kernel-store-migrate');

const PROJECT_ID = 'intrale-platform';

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function makeFixtures() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'k45-src-'));
  const backupRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'k45-bak-'));
  fs.writeFileSync(
    path.join(dir, 'waves.json'),
    JSON.stringify({ version: '1.0', active_wave: { number: 7, issues: [{ number: 4745 }] }, integrity_hash: 'deadbeef' }, null, 2),
  );
  fs.writeFileSync(
    path.join(dir, 'blocked-issues.json'),
    JSON.stringify({ blockedBy: { 4688: ['4745'] }, blocks: { 4745: ['4688'] } }, null, 2),
  );
  fs.writeFileSync(
    path.join(dir, 'blocked-by-infra.json'),
    JSON.stringify({ version: 1, issues: [], lastEvent: { type: 'connectivity_restored' } }, null, 2),
  );
  fs.writeFileSync(
    path.join(dir, 'infra-health.json'),
    JSON.stringify({ dns: { status: 'OK' }, retries: { lastHour: 0 }, circuitBreaker: { state: 'closed' } }, null, 2),
  );
  return { dir, backupRoot };
}

function makeStore() {
  return createCoordinationStore({ contextProjectId: PROJECT_ID, now: () => 1000 });
}

const FIXED_NOW = () => 1000;

// -----------------------------------------------------------------------------

test('migración idempotente: re-run no duplica registros', async () => {
  const { dir, backupRoot } = makeFixtures();
  const store = makeStore();

  const r1 = await migrateState({ apply: true, coordinationStore: store, sourcesDir: dir, backupRoot, now: FIXED_NOW });
  assert.equal(r1.ok, true);
  assert.equal(r1.writes.waves.action, 'created');
  assert.equal(r1.writes.blocked.action, 'created');
  assert.equal(r1.writes.health.action, 'created');

  const r2 = await migrateState({ apply: true, coordinationStore: store, sourcesDir: dir, backupRoot, now: FIXED_NOW });
  assert.equal(r2.ok, true);
  // Re-run: contenido idéntico ⇒ no reescribe, versión estable (no duplica).
  for (const { key } of MIGRATION_PLAN) {
    assert.equal(r2.writes[key].action, 'unchanged');
    const st = await store.getState(key);
    assert.equal(st.version, 1, `la versión de "${key}" debe permanecer estable`);
  }
});

test('verificación de integridad detecta pérdida', async () => {
  // Unit: clave faltante en el readback.
  const before = { waves: { checksum: 'aaa' }, blocked: { checksum: 'bbb' } };
  const vMissing = verifyIntegrity(before, { waves: { checksum: 'aaa' } });
  assert.equal(vMissing.ok, false);
  assert.equal(vMissing.code, 'integrity_mismatch');
  assert.ok(vMissing.mismatches.some((m) => m.key === 'blocked' && m.reason === 'missing'));

  // Unit: drift de checksum.
  const vDrift = verifyIntegrity({ waves: { checksum: 'aaa' } }, { waves: { checksum: 'zzz' } });
  assert.equal(vDrift.ok, false);
  assert.equal(vDrift.mismatches[0].reason, 'checksum');

  // Integración: un store que "pierde" la clave `blocked` en el readback debe
  // hacer que la migración falle fail-closed.
  const { dir, backupRoot } = makeFixtures();
  const base = makeStore();
  const lossyStore = {
    ...base,
    getState: async (key) => (key === 'blocked' ? null : base.getState(key)),
  };
  const r = await migrateState({ apply: true, coordinationStore: lossyStore, sourcesDir: dir, backupRoot, now: FIXED_NOW });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'integrity_mismatch');
  assert.ok(r.mismatches.some((m) => m.key === 'blocked'));
  assert.ok(r.rollbackCmd.includes('--rollback --from'));
});

test('rollback restaura el estado previo exacto', async () => {
  const { dir, backupRoot } = makeFixtures();
  const store = makeStore();

  const r = await migrateState({ apply: true, coordinationStore: store, sourcesDir: dir, backupRoot, now: FIXED_NOW });
  assert.equal(r.ok, true);

  const wavesPath = path.join(dir, 'waves.json');
  const original = fs.readFileSync(wavesPath, 'utf8');
  // El operador corrompe el estado local después de migrar.
  fs.writeFileSync(wavesPath, JSON.stringify({ tampered: true }));
  assert.notEqual(fs.readFileSync(wavesPath, 'utf8'), original);

  const rb = await migrateState({ rollback: true, from: r.backup, backupRoot, sourcesDir: dir });
  assert.equal(rb.ok, true);
  assert.equal(fs.readFileSync(wavesPath, 'utf8'), original, 'el rollback restaura byte a byte');
});

test('no pierde historia de waves/labels/firmas', async () => {
  const { dir, backupRoot } = makeFixtures();
  const store = makeStore();

  const r = await migrateState({
    apply: true, coordinationStore: store, sourcesDir: dir, backupRoot, now: FIXED_NOW,
    countSignatures: async () => 3,
  });
  assert.equal(r.ok, true);
  assert.equal(r.verify.ok, true);

  // waves: contenido preservado idéntico a la fuente.
  const waves = await store.getState('waves');
  assert.deepEqual(
    waves.value.sources['waves.json'],
    JSON.parse(fs.readFileSync(path.join(dir, 'waves.json'), 'utf8')),
  );
  // blocked: AMBAS fuentes de bloqueo preservadas bajo la misma clave.
  const blocked = await store.getState('blocked');
  assert.ok(blocked.value.sources['blocked-issues.json']);
  assert.ok(blocked.value.sources['blocked-by-infra.json']);

  // Firmas: si el conteo cambia durante la migración ⇒ fail-closed (no-repudiación).
  const store2 = makeStore();
  let call = 0;
  const r2 = await migrateState({
    apply: true, coordinationStore: store2, sourcesDir: dir, backupRoot, now: FIXED_NOW,
    countSignatures: async () => (call++ === 0 ? 5 : 4),
  });
  assert.equal(r2.ok, false);
  assert.equal(r2.code, 'integrity_mismatch');
  assert.ok(r2.mismatches.some((m) => m.key === 'signatures'));
});

test('dry-run no escribe y reporta conteos+checksums+línea de rollback', async () => {
  const { dir, backupRoot } = makeFixtures();
  const store = makeStore();

  const r = await migrateState({
    coordinationStore: store, sourcesDir: dir, backupRoot, now: FIXED_NOW,
    countSignatures: async () => 2,
  });
  assert.equal(r.ok, true);
  assert.equal(r.mode, 'dry-run');

  // (a) NO escribió al store.
  for (const { key } of MIGRATION_PLAN) {
    assert.equal(await store.getState(key), null, `dry-run no debe escribir "${key}"`);
  }

  const report = r.report;
  // (b) conteo por clave.
  assert.ok(report.includes('waves'));
  assert.ok(report.includes('blocked'));
  assert.ok(report.includes('health'));
  // (c) checksum antes/después.
  assert.ok(/checksum/i.test(report));
  // (d) banner dry-run + línea de rollback literal.
  assert.ok(report.includes('[DRY-RUN]'));
  assert.ok(report.includes('Para revertir: node .pipeline/lib/kernel-store-migrate.js --rollback --from'));
  // (e) ningún patrón de secreto (AWS key / JWT).
  assert.ok(!/AKIA[0-9A-Z]{16}/.test(report));
  assert.ok(!/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./.test(report));
});

test('backup no world-readable y sin secretos', async () => {
  const { dir, backupRoot } = makeFixtures();
  const store = makeStore();

  const r = await migrateState({ apply: true, coordinationStore: store, sourcesDir: dir, backupRoot, now: FIXED_NOW });
  assert.equal(r.ok, true);

  const files = fs.readdirSync(r.backup);
  assert.ok(files.includes('manifest.json'));
  assert.ok(files.includes('waves.json'));

  // Sin secretos en ningún artefacto del backup.
  for (const f of files) {
    const content = fs.readFileSync(path.join(r.backup, f), 'utf8');
    assert.ok(!/AKIA[0-9A-Z]{16}/.test(content), `backup ${f} no debe contener AWS keys`);
    assert.ok(!/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./.test(content), `backup ${f} no debe contener JWT`);
  }

  // Manifest: rutas RELATIVAS (no filtran el path absoluto del usuario, A02).
  const manifest = JSON.parse(fs.readFileSync(path.join(r.backup, 'manifest.json'), 'utf8'));
  assert.ok(Array.isArray(manifest.files) && manifest.files.length === 4);
  for (const f of manifest.files) {
    assert.ok(!path.isAbsolute(f.relPath), 'relPath no debe ser absoluto');
    assert.ok(!f.relPath.includes('..'), 'relPath no debe escapar');
  }

  // Permisos restrictivos (POSIX). En Windows los bits no aplican igual.
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(r.backup).mode & 0o077, 0, 'el dir de backup no debe ser world/group-readable');
    assert.equal(fs.statSync(path.join(r.backup, 'waves.json')).mode & 0o077, 0, 'el archivo de backup no debe ser world/group-readable');
  }
});

test('rollback rechaza --from fuera del backupRoot (anti path-traversal)', async () => {
  const { dir, backupRoot } = makeFixtures();
  const evil = fs.mkdtempSync(path.join(os.tmpdir(), 'k45-evil-'));

  const rb = await migrateState({ rollback: true, from: evil, backupRoot, sourcesDir: dir });
  assert.equal(rb.ok, false);
  assert.equal(rb.code, 'rollback_path');
});

test('rollback aborta ante un backup corrupto (A05)', async () => {
  const { dir, backupRoot } = makeFixtures();
  const store = makeStore();

  const r = await migrateState({ apply: true, coordinationStore: store, sourcesDir: dir, backupRoot, now: FIXED_NOW });
  assert.equal(r.ok, true);

  // Corromper un archivo del backup DESPUÉS de crearlo.
  fs.writeFileSync(path.join(r.backup, 'waves.json'), JSON.stringify({ corrupted: true }));

  const rb = await migrateState({ rollback: true, from: r.backup, backupRoot, sourcesDir: dir });
  assert.equal(rb.ok, false);
  assert.equal(rb.code, 'backup_corrupt');
});

test('fuente ausente ⇒ fail-closed (errores como dato, no throw)', async () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'k45-empty-'));
  const backupRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'k45-bak-'));

  const r = await migrateState({ sourcesDir: empty, backupRoot });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'source_read');
  assert.ok(typeof r.report === 'string' && r.report.includes('[FALLA]'));
});

test('redactSecrets enmascara AWS keys y JWT; rollbackCommand emite comando literal', () => {
  const dirty = 'clave AKIAIOSFODNN7EXAMPLE y token eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payloadpart.signaturepart';
  const clean = redactSecrets(dirty);
  assert.ok(!clean.includes('AKIAIOSFODNN7EXAMPLE'));
  assert.ok(!/eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9\.payloadpart\./.test(clean));
  assert.ok(clean.includes('[REDACTED]'));

  const cmd = rollbackCommand('/tmp/whatever/backup/ts');
  assert.ok(cmd.startsWith('node .pipeline/lib/kernel-store-migrate.js --rollback --from '));
});

test('checksum canónico es estable ante reordenamiento de claves', () => {
  const a = { x: 1, y: { b: 2, a: 3 } };
  const b = { y: { a: 3, b: 2 }, x: 1 };
  assert.equal(canonicalChecksum(a), canonicalChecksum(b));
});
