// =============================================================================
// jsonl-rotation.test.js — Tests del helper genérico de rotación de JSONL.
// Issue #4174 (split de #3946, EP6-H4, parte 2).
//
// Cubre CAs:
//   - CA-2: rotación by-size a *.YYYY-MM-DD.jsonl.gz (round-trip gunzip OK).
//   - CA-2: NO rota bajo umbral.
//   - CA-2: sufijo .N anti-colisión.
//   - CA-2: cleanupOldArchives borra .gz > 30d, preserva recientes, glob acotado.
//   - CA-2 (seguridad, OWASP A09): redacción de secrets ANTES del gzip.
//   - CA-1: now inyectable (determinismo).
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const zlib = require('node:zlib');

const rot = require('../jsonl-rotation');

const TMP_ROOT = path.join(os.tmpdir(), `jsonl-rotation-tests-${process.pid}`);

test.beforeEach(() => {
  if (fs.existsSync(TMP_ROOT)) fs.rmSync(TMP_ROOT, { recursive: true, force: true });
  fs.mkdirSync(TMP_ROOT, { recursive: true });
});

test.after(() => {
  if (fs.existsSync(TMP_ROOT)) fs.rmSync(TMP_ROOT, { recursive: true, force: true });
});

const FIXED_NOW = () => new Date('2026-06-25T12:00:00Z').getTime();

// ─── rotateIfNeeded ──────────────────────────────────────────────────────────

test('rotateIfNeeded: archivo > umbral se rota a .YYYY-MM-DD.jsonl.gz y queda vacío', () => {
  const target = path.join(TMP_ROOT, 'metrics-history.jsonl');
  // 1.1 MB de líneas JSON válidas + límite 1MB.
  const lines = [];
  let bytes = 0;
  let i = 0;
  while (bytes < 1024 * 1024 + 1000) {
    const line = JSON.stringify({ type: 'm', n: i++, pad: 'y'.repeat(100) }) + '\n';
    lines.push(line);
    bytes += line.length;
  }
  fs.writeFileSync(target, lines.join(''));

  const r = rot.rotateIfNeeded({ path: target, limitMb: 1, now: FIXED_NOW });
  assert.strictEqual(r.rotated, true);
  assert.ok(/metrics-history\.2026-06-25\.jsonl\.gz$/.test(r.archivePath), `path inesperado: ${r.archivePath}`);

  // El JSONL activo queda vacío.
  assert.strictEqual(fs.readFileSync(target, 'utf8'), '');

  // Round-trip: el .gz descomprime a JSON válido con las mismas entradas.
  const dec = zlib.gunzipSync(fs.readFileSync(r.archivePath)).toString('utf8');
  const decLines = dec.split('\n').filter(Boolean);
  assert.strictEqual(decLines.length, lines.length);
  assert.strictEqual(JSON.parse(decLines[0]).type, 'm');
});

test('rotateIfNeeded: archivo bajo el umbral NO se toca', () => {
  const target = path.join(TMP_ROOT, 'history.jsonl');
  fs.writeFileSync(target, '{"a":1}\n{"a":2}\n');
  const before = fs.statSync(target).size;
  const r = rot.rotateIfNeeded({ path: target, limitMb: 5, now: FIXED_NOW });
  assert.strictEqual(r.rotated, false);
  assert.strictEqual(fs.statSync(target).size, before);
});

test('rotateIfNeeded: path inexistente devuelve rotated:false sin error', () => {
  const r = rot.rotateIfNeeded({ path: path.join(TMP_ROOT, 'no-existe.jsonl') });
  assert.strictEqual(r.rotated, false);
});

test('rotateIfNeeded: sin path devuelve rotated:false', () => {
  assert.strictEqual(rot.rotateIfNeeded({}).rotated, false);
  assert.strictEqual(rot.rotateIfNeeded().rotated, false);
});

test('rotateIfNeeded: colisión de nombre se resuelve con sufijo .N', () => {
  const target = path.join(TMP_ROOT, 'history.jsonl');
  fs.writeFileSync(target, 'x'.repeat(1024 * 1024 + 100));
  // Pre-existente con la misma fecha.
  fs.writeFileSync(path.join(TMP_ROOT, 'history.2026-06-25.jsonl.gz'), Buffer.from([1, 2, 3]));
  const r = rot.rotateIfNeeded({ path: target, limitMb: 1, now: FIXED_NOW });
  assert.strictEqual(r.rotated, true);
  assert.match(r.archivePath, /history\.2026-06-25\.\d+\.jsonl\.gz$/);
});

// ─── Seguridad (OWASP A09): redacción pre-gzip ───────────────────────────────

test('rotateIfNeeded: redacta AWS key y JWT ANTES del gzip (round-trip enmascarado)', () => {
  const target = path.join(TMP_ROOT, 'secrets-history.jsonl');
  const awsKey = 'AKIAIOSFODNN7EXAMPLE';
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
  const lines = [
    JSON.stringify({ type: 'event', aws_access_key: awsKey, note: 'login' }),
    JSON.stringify({ type: 'event', token: jwt }),
    `linea cruda no-json con AKIAIOSFODNN7EXAMPLE adentro`,
  ];
  // Rellenar para superar el umbral de 1MB.
  const pad = JSON.stringify({ type: 'pad', data: 'z'.repeat(200) }) + '\n';
  let body = lines.join('\n') + '\n';
  while (body.length < 1024 * 1024 + 100) body += pad;
  fs.writeFileSync(target, body);

  const r = rot.rotateIfNeeded({ path: target, limitMb: 1, redact: true, now: FIXED_NOW });
  assert.strictEqual(r.rotated, true);

  const dec = zlib.gunzipSync(fs.readFileSync(r.archivePath)).toString('utf8');
  // Round-trip OK + secrets NO presentes en claro.
  assert.ok(!dec.includes(awsKey), 'AWS key debe quedar enmascarada en el .gz');
  assert.ok(!dec.includes(jwt), 'JWT debe quedar enmascarado en el .gz');
  // El contenido sigue siendo recuperable (no se corrompió).
  assert.ok(dec.split('\n').filter(Boolean).length >= 3);
});

test('rotateIfNeeded: redact:false NO redacta (compat opt-out)', () => {
  const target = path.join(TMP_ROOT, 'raw-history.jsonl');
  const awsKey = 'AKIAIOSFODNN7EXAMPLE';
  let body = JSON.stringify({ k: awsKey }) + '\n';
  while (body.length < 1024 * 1024 + 100) body += JSON.stringify({ pad: 'q'.repeat(200) }) + '\n';
  fs.writeFileSync(target, body);

  const r = rot.rotateIfNeeded({ path: target, limitMb: 1, redact: false, now: FIXED_NOW });
  assert.strictEqual(r.rotated, true);
  const dec = zlib.gunzipSync(fs.readFileSync(r.archivePath)).toString('utf8');
  assert.ok(dec.includes(awsKey), 'con redact:false el secret NO se enmascara');
});

test('redactJsonlBuffer: maneja líneas vacías, JSON y crudas sin romper', () => {
  const input = `\n{"aws_access_key":"AKIAIOSFODNN7EXAMPLE"}\nplano AKIAIOSFODNN7EXAMPLE\n`;
  const out = rot.redactJsonlBuffer(Buffer.from(input, 'utf8'));
  assert.ok(!out.includes('AKIAIOSFODNN7EXAMPLE'));
  // Preserva el conteo de líneas (estructura intacta).
  assert.strictEqual(out.split('\n').length, input.split('\n').length);
});

// ─── cleanupOldArchives ──────────────────────────────────────────────────────

test('cleanupOldArchives: borra .gz > retentionDays y preserva recientes', () => {
  const dir = path.join(TMP_ROOT, 'arch');
  fs.mkdirSync(dir, { recursive: true });
  const fresh = path.join(dir, 'metrics-history.2026-06-20.jsonl.gz');
  const stale = path.join(dir, 'metrics-history.2026-05-01.jsonl.gz');
  fs.writeFileSync(fresh, zlib.gzipSync('a'));
  fs.writeFileSync(stale, zlib.gzipSync('b'));
  const past = new Date(FIXED_NOW() - 40 * 24 * 60 * 60 * 1000);
  fs.utimesSync(stale, past, past);

  const r = rot.cleanupOldArchives({
    dir, basename: 'metrics-history', retentionDays: 30, now: FIXED_NOW,
  });
  assert.strictEqual(r.deleted, 1);
  assert.strictEqual(fs.existsSync(fresh), true);
  assert.strictEqual(fs.existsSync(stale), false);
});

test('cleanupOldArchives: glob acotado — no borra otros basenames ni otras extensiones', () => {
  const dir = path.join(TMP_ROOT, 'arch2');
  fs.mkdirSync(dir, { recursive: true });
  const mine = path.join(dir, 'metrics-history.2026-05-01.jsonl.gz');
  const other = path.join(dir, 'sessions-history.2026-05-01.jsonl.gz'); // otro basename
  const png = path.join(dir, 'metrics-history.2026-05-01.png');          // otra extensión
  const plain = path.join(dir, 'metrics-history.jsonl');                  // activo, no .gz
  for (const f of [mine, other, png, plain]) fs.writeFileSync(f, 'x');
  const past = new Date(FIXED_NOW() - 40 * 24 * 60 * 60 * 1000);
  for (const f of [mine, other, png, plain]) fs.utimesSync(f, past, past);

  const r = rot.cleanupOldArchives({
    dir, basename: 'metrics-history', retentionDays: 30, now: FIXED_NOW,
  });
  assert.strictEqual(r.deleted, 1);
  assert.strictEqual(fs.existsSync(mine), false, 'el mío sí se borra');
  assert.strictEqual(fs.existsSync(other), true, 'otro basename intacto');
  assert.strictEqual(fs.existsSync(png), true, 'otra extensión intacta');
  assert.strictEqual(fs.existsSync(plain), true, 'el .jsonl activo intacto');
});

test('cleanupOldArchives: directorio inexistente o args faltantes → deleted:0', () => {
  assert.strictEqual(rot.cleanupOldArchives({ dir: path.join(TMP_ROOT, 'nope'), basename: 'x' }).deleted, 0);
  assert.strictEqual(rot.cleanupOldArchives({ basename: 'x' }).deleted, 0);
  assert.strictEqual(rot.cleanupOldArchives({ dir: TMP_ROOT }).deleted, 0);
  assert.strictEqual(rot.cleanupOldArchives().deleted, 0);
});

test('cleanupOldArchives: basename con metacaracteres regex se escapa (no over-match)', () => {
  const dir = path.join(TMP_ROOT, 'arch3');
  fs.mkdirSync(dir, { recursive: true });
  // basename literal "a.b" no debe matchear "axb..."
  const literal = path.join(dir, 'a.b.2026-05-01.jsonl.gz');
  const tricky = path.join(dir, 'axb.2026-05-01.jsonl.gz');
  fs.writeFileSync(literal, 'x');
  fs.writeFileSync(tricky, 'x');
  const past = new Date(FIXED_NOW() - 40 * 24 * 60 * 60 * 1000);
  fs.utimesSync(literal, past, past);
  fs.utimesSync(tricky, past, past);

  const r = rot.cleanupOldArchives({ dir, basename: 'a.b', retentionDays: 30, now: FIXED_NOW });
  assert.strictEqual(r.deleted, 1);
  assert.strictEqual(fs.existsSync(literal), false);
  assert.strictEqual(fs.existsSync(tricky), true, 'el "." no debe actuar como comodín');
});
