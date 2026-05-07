// =============================================================================
// quota-snapshot-persist.test.js — Tests de persistencia + rotación + retención.
// Issue #3012 (split de #3008, hija 1).
//
// Cubre CAs:
//   - CA-3: persistencia append-only en JSONL.
//   - CA-17: rotación a *.YYYY-MM-DD.jsonl.gz cuando supera el umbral.
//   - CA-17: retención automática de PNG > N días.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const zlib = require('node:zlib');

const persist = require('../quota-snapshot-persist');

const TMP_ROOT = path.join(os.tmpdir(), `quota-snapshot-persist-tests-${process.pid}`);

test.beforeEach(() => {
  if (fs.existsSync(TMP_ROOT)) fs.rmSync(TMP_ROOT, { recursive: true, force: true });
  fs.mkdirSync(TMP_ROOT, { recursive: true });
});

test.after(() => {
  if (fs.existsSync(TMP_ROOT)) fs.rmSync(TMP_ROOT, { recursive: true, force: true });
});

function readLines(p) {
  return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean);
}

// CA-3
test('appendSnapshot: 3 entradas → JSONL con 3 líneas válidas', () => {
  const target = path.join(TMP_ROOT, 'history.jsonl');
  for (let i = 1; i <= 3; i++) {
    persist.appendSnapshot({ ts: '2026-05-07', n: i }, { historyPath: target });
  }
  const lines = readLines(target);
  assert.strictEqual(lines.length, 3);
  for (const l of lines) {
    const obj = JSON.parse(l); // cada línea es JSON parseable
    assert.ok(obj.n >= 1 && obj.n <= 3);
  }
});

// CA-17 rotación
test('rotateIfNeeded: archivo > umbral se rota a .YYYY-MM-DD.jsonl.gz', () => {
  const target = path.join(TMP_ROOT, 'history.jsonl');
  // 1.2 MB de data garbage + límite 1MB.
  const blob = 'x'.repeat(1024 * 1024 + 100);
  fs.writeFileSync(target, blob);
  const r = persist.rotateIfNeeded({
    historyPath: target,
    limitMb: 1,
    now: () => new Date('2026-05-07T12:00:00Z').getTime(),
  });
  assert.strictEqual(r.rotated, true);
  assert.ok(r.archivePath, 'archivePath debe ser devuelto');
  assert.ok(/\.2026-05-07\.jsonl\.gz$/.test(r.archivePath), `path debe terminar con fecha y .gz: ${r.archivePath}`);

  // El JSONL queda vacío.
  assert.strictEqual(fs.readFileSync(target, 'utf8'), '');

  // El gz se puede descomprimir y contiene los datos originales.
  const gz = fs.readFileSync(r.archivePath);
  const dec = zlib.gunzipSync(gz).toString('utf8');
  assert.strictEqual(dec.length, blob.length);
});

test('rotateIfNeeded: archivo bajo el umbral no se toca', () => {
  const target = path.join(TMP_ROOT, 'history.jsonl');
  fs.writeFileSync(target, '{"a":1}\n{"a":2}\n');
  const before = fs.statSync(target).size;
  const r = persist.rotateIfNeeded({ historyPath: target, limitMb: 5 });
  assert.strictEqual(r.rotated, false);
  assert.strictEqual(fs.statSync(target).size, before);
});

test('rotateIfNeeded: si ya hay archivo .gz para el día, sufija con N', () => {
  const target = path.join(TMP_ROOT, 'history.jsonl');
  const blob = 'x'.repeat(1024 * 1024 + 100);
  fs.writeFileSync(target, blob);
  // Pre-existente con la misma fecha.
  fs.writeFileSync(path.join(TMP_ROOT, 'history.2026-05-07.jsonl.gz'), Buffer.from([1, 2, 3]));
  const r = persist.rotateIfNeeded({
    historyPath: target,
    limitMb: 1,
    now: () => new Date('2026-05-07T12:00:00Z').getTime(),
  });
  assert.strictEqual(r.rotated, true);
  assert.match(r.archivePath, /history\.2026-05-07\.\d+\.jsonl\.gz$/);
});

// CA-17 retención de PNG
test('cleanupOldPngs: borra PNG con mtime > retentionDays', () => {
  const dir = path.join(TMP_ROOT, 'pngs');
  fs.mkdirSync(dir, { recursive: true });
  const fresh = path.join(dir, 'quota-fresh.png');
  const stale = path.join(dir, 'quota-stale.png');
  fs.writeFileSync(fresh, 'x');
  fs.writeFileSync(stale, 'x');
  // Forzamos mtime del stale a -40 días.
  const past = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
  fs.utimesSync(stale, past, past);

  const r = persist.cleanupOldPngs({
    pngDir: dir,
    retentionDays: 30,
  });
  assert.strictEqual(r.deleted, 1);
  assert.strictEqual(fs.existsSync(fresh), true);
  assert.strictEqual(fs.existsSync(stale), false);
});

test('cleanupOldPngs: ignora archivos no-PNG', () => {
  const dir = path.join(TMP_ROOT, 'mixed');
  fs.mkdirSync(dir, { recursive: true });
  const txt = path.join(dir, 'quota-old.txt');
  fs.writeFileSync(txt, 'x');
  const past = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
  fs.utimesSync(txt, past, past);
  const r = persist.cleanupOldPngs({ pngDir: dir, retentionDays: 30 });
  assert.strictEqual(r.deleted, 0);
  assert.strictEqual(fs.existsSync(txt), true);
});

test('cleanupOldPngs: ignora directorio inexistente', () => {
  const r = persist.cleanupOldPngs({
    pngDir: path.join(TMP_ROOT, 'no-existe'),
    retentionDays: 30,
  });
  assert.strictEqual(r.deleted, 0);
});
