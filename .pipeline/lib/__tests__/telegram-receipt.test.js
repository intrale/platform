// =============================================================================
// Tests del bus de recibos de entrega Telegram (#4082)
//
// Cubre el corazón fail-closed (SEC-2) del bus cross-proceso: un recibo SOLO es
// válido si lleva `correlationId` válido + `status` ∈ {enviado, fallido} +
// `messageIds` (no vacío cuando `enviado`) + `at`. Cualquier recibo
// malformado/forjado/parcial → `parseReceipt` devuelve null, NUNCA `enviado`.
//
// Convención: sin credenciales, sin red. Todo en temp dirs.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const rec = require('../telegram-receipt');

function sandbox() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tg-receipt-'));
}

// -----------------------------------------------------------------------------
// correlationId
// -----------------------------------------------------------------------------
test('generateCorrelationId produce ids válidos y únicos', () => {
  const a = rec.generateCorrelationId('cmd');
  const b = rec.generateCorrelationId('cmd');
  assert.ok(rec.isValidCorrelationId(a), 'a debe ser válido');
  assert.ok(rec.isValidCorrelationId(b), 'b debe ser válido');
  assert.notEqual(a, b, 'ids consecutivos deben diferir');
  assert.match(a, /^cmd-\d+-[0-9a-f]{8}$/);
});

test('isValidCorrelationId rechaza path-traversal y chars inseguros', () => {
  assert.equal(rec.isValidCorrelationId('../../etc/passwd'), false);
  assert.equal(rec.isValidCorrelationId('a/b'), false);
  assert.equal(rec.isValidCorrelationId('a\\b'), false);
  assert.equal(rec.isValidCorrelationId('cmd..123456'), false, '".." rechazado aun con chars válidos');
  assert.equal(rec.isValidCorrelationId('abc'), false, 'muy corto (<6)');
  assert.equal(rec.isValidCorrelationId(''), false);
  assert.equal(rec.isValidCorrelationId(null), false);
  assert.equal(rec.isValidCorrelationId('cmd-123-abcd'), true);
});

// -----------------------------------------------------------------------------
// buildReceipt / parseReceipt — round-trip válido
// -----------------------------------------------------------------------------
test('buildReceipt + parseReceipt: round-trip válido (enviado)', () => {
  const built = rec.buildReceipt({ correlationId: 'cmd-1-abcdef', status: 'enviado', messageIds: [10, 11] });
  assert.equal(built.status, 'enviado');
  assert.deepEqual(built.messageIds, [10, 11]);
  assert.ok(built.at, 'estampa at');

  const parsed = rec.parseReceipt(JSON.stringify(built));
  assert.deepEqual(parsed, built, 'round-trip preserva el recibo');
});

test('buildReceipt: fallido acepta messageIds vacío', () => {
  const built = rec.buildReceipt({ correlationId: 'cmd-2-abcdef', status: 'fallido', messageIds: [] });
  assert.equal(built.status, 'fallido');
  assert.deepEqual(built.messageIds, []);
  assert.ok(rec.isValidReceipt(built));
});

test('buildReceipt: respeta `at` provisto', () => {
  const at = '2026-06-18T00:00:00.000Z';
  const built = rec.buildReceipt({ correlationId: 'cmd-3-abcdef', status: 'enviado', messageIds: [1], at });
  assert.equal(built.at, at);
});

// -----------------------------------------------------------------------------
// buildReceipt — fail-closed del PRODUCTOR (lanza)
// -----------------------------------------------------------------------------
test('buildReceipt: lanza ante enviado SIN messageIds (R1 — message_id es la prueba)', () => {
  assert.throws(() => rec.buildReceipt({ correlationId: 'cmd-4-abcdef', status: 'enviado', messageIds: [] }));
  assert.throws(() => rec.buildReceipt({ correlationId: 'cmd-4-abcdef', status: 'enviado' }));
});

test('buildReceipt: lanza ante correlationId inválido / status inválido / ids no numéricos', () => {
  assert.throws(() => rec.buildReceipt({ correlationId: '../x', status: 'enviado', messageIds: [1] }));
  assert.throws(() => rec.buildReceipt({ correlationId: 'cmd-5-abcdef', status: 'entregado', messageIds: [1] }));
  assert.throws(() => rec.buildReceipt({ correlationId: 'cmd-5-abcdef', status: 'enviado', messageIds: ['x'] }));
  assert.throws(() => rec.buildReceipt({ correlationId: 'cmd-5-abcdef', status: 'enviado', messageIds: [NaN] }));
});

// -----------------------------------------------------------------------------
// parseReceipt — fail-closed del CONSUMIDOR (devuelve null, NUNCA enviado)
// -----------------------------------------------------------------------------
test('parseReceipt: JSON roto → null (nunca enviado)', () => {
  assert.equal(rec.parseReceipt('{ no es json'), null);
});

test('parseReceipt: recibo enviado SIN messageIds → null (fail-closed)', () => {
  const forged = JSON.stringify({ correlationId: 'cmd-6-abcdef', status: 'enviado', messageIds: [], at: '2026-06-18T00:00:00Z' });
  assert.equal(rec.parseReceipt(forged), null, 'sin prueba de entrega no se acepta');
});

test('parseReceipt: recibo SIN correlationId → null', () => {
  const forged = JSON.stringify({ status: 'enviado', messageIds: [1], at: '2026-06-18T00:00:00Z' });
  assert.equal(rec.parseReceipt(forged), null);
});

test('parseReceipt: recibo SIN at → null', () => {
  const forged = JSON.stringify({ correlationId: 'cmd-7-abcdef', status: 'enviado', messageIds: [1] });
  assert.equal(rec.parseReceipt(forged), null);
});

test('parseReceipt: status arbitrario → null (no default a enviado)', () => {
  const forged = JSON.stringify({ correlationId: 'cmd-8-abcdef', status: 'enviado_forzado', messageIds: [1], at: '2026-06-18T00:00:00Z' });
  const parsed = rec.parseReceipt(forged);
  assert.equal(parsed, null);
});

test('parseReceipt: descarta payload extra de un recibo forjado (normaliza)', () => {
  const forged = JSON.stringify({
    correlationId: 'cmd-9-abcdef', status: 'enviado', messageIds: [42], at: '2026-06-18T00:00:00Z',
    extra: 'inyectado', __proto__hack: true,
  });
  const parsed = rec.parseReceipt(forged);
  assert.deepEqual(Object.keys(parsed).sort(), ['at', 'correlationId', 'messageIds', 'status']);
  assert.equal(parsed.extra, undefined);
});

// -----------------------------------------------------------------------------
// writeReceipt / listReceiptFiles / readReceiptFile / archiveReceipt
// -----------------------------------------------------------------------------
test('writeReceipt persiste con nombre <correlationId>.json y readReceiptFile lo recupera', () => {
  const dir = path.join(sandbox(), 'recibos');
  const p = rec.writeReceipt(dir, { correlationId: 'cmd-w1-abcdef', status: 'enviado', messageIds: [7] });
  assert.ok(fs.existsSync(p));
  assert.equal(path.basename(p), 'cmd-w1-abcdef.json');

  const files = rec.listReceiptFiles(dir);
  assert.equal(files.length, 1);

  const loaded = rec.readReceiptFile(p);
  assert.equal(loaded.status, 'enviado');
  assert.deepEqual(loaded.messageIds, [7]);
});

test('writeReceipt: lanza ante recibo inválido y NO deja archivo a medias', () => {
  const dir = path.join(sandbox(), 'recibos');
  assert.throws(() => rec.writeReceipt(dir, { correlationId: 'cmd-w2-abcdef', status: 'enviado', messageIds: [] }));
  // No quedó ningún .json (ni tmp) en el dir.
  const leftovers = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.endsWith('.json')) : [];
  assert.equal(leftovers.length, 0);
});

test('readReceiptFile: archivo inválido en disco → null (fail-closed)', () => {
  const dir = path.join(sandbox(), 'recibos');
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, 'cmd-bad-abcdef.json');
  fs.writeFileSync(p, JSON.stringify({ correlationId: 'cmd-bad-abcdef', status: 'enviado', messageIds: [], at: 'x' }));
  assert.equal(rec.readReceiptFile(p), null);
});

test('archiveReceipt mueve el recibo consumido a archivado/', () => {
  const base = sandbox();
  const dir = path.join(base, 'recibos');
  const archived = path.join(dir, 'archivado');
  const p = rec.writeReceipt(dir, { correlationId: 'cmd-arch-abcdef', status: 'fallido', messageIds: [] });
  const ok = rec.archiveReceipt(p, archived);
  assert.equal(ok, true);
  assert.ok(!fs.existsSync(p), 'ya no está en recibos/');
  assert.ok(fs.existsSync(path.join(archived, 'cmd-arch-abcdef.json')), 'está en archivado/');
});

test('listReceiptFiles: dir inexistente → [] (no lanza)', () => {
  assert.deepEqual(rec.listReceiptFiles('/no/existe/recibos'), []);
});

test('readReceiptFile: path inexistente → null (no lanza)', () => {
  assert.equal(rec.readReceiptFile('/no/existe/recibos/x.json'), null);
});

test('archiveReceipt: origen inexistente → false (best-effort, no lanza)', () => {
  const base = sandbox();
  assert.equal(rec.archiveReceipt(path.join(base, 'noexiste.json'), path.join(base, 'arch')), false);
});

test('receiptsDir / archivedReceiptsDir resuelven bajo servicios/telegram', () => {
  const d = rec.receiptsDir('/x/.pipeline');
  assert.ok(d.endsWith(path.join('servicios', 'telegram', 'recibos')));
  const a = rec.archivedReceiptsDir('/x/.pipeline');
  assert.ok(a.endsWith(path.join('recibos', 'archivado')));
});
