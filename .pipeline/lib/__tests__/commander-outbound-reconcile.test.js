// =============================================================================
// Tests de la confirmación de entrega real de salientes Telegram en el lado
// Commander (#4082): reconciliación de recibos + estado de entrega por
// correlation_id (CA-A3 / CA-A4 / SEC-2).
//
// Convención: sin credenciales, sin red. `PULPO_NO_AUTOSTART=1` permite requerir
// pulpo.js sin arrancar el singleton ni el main loop. La reconciliación se
// ejerce contra un `pipelineDir` de sandbox inyectado (no toca estado real).
// =============================================================================
'use strict';

process.env.PULPO_NO_AUTOSTART = '1';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const pulpo = require('../../pulpo');
const rec = require('../telegram-receipt');
const {
  commanderOutboundStatus,
  reconcileTelegramReceipts,
  resolveChatIdForCorrelation,
  selectCommanderHistoryForChat,
} = pulpo;

function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmd-reconcile-'));
  fs.mkdirSync(rec.receiptsDir(dir), { recursive: true });
  return dir;
}
function jsonl(...entries) {
  return entries.map(e => JSON.stringify(e)).join('\n');
}

// -----------------------------------------------------------------------------
// commanderOutboundStatus (CA-A4 — base honesta de "ya te respondí")
// -----------------------------------------------------------------------------
test('commanderOutboundStatus: encolado mientras no hay recibo', () => {
  const raw = jsonl(
    { direction: 'out', status: 'encolado', correlation_id: 'cmd-1-abcdef', text: 'hola' },
  );
  assert.equal(commanderOutboundStatus(raw, 'cmd-1-abcdef'), 'encolado');
});

test('commanderOutboundStatus: enviado solo tras reconcile confirmado', () => {
  const raw = jsonl(
    { direction: 'out', status: 'encolado', correlation_id: 'cmd-2-abcdef', text: 'hola' },
    { direction: 'reconcile', status: 'enviado', correlation_id: 'cmd-2-abcdef', message_ids: [5] },
  );
  assert.equal(commanderOutboundStatus(raw, 'cmd-2-abcdef'), 'enviado');
});

test('commanderOutboundStatus: fallido NO se reporta como entregado', () => {
  const raw = jsonl(
    { direction: 'out', status: 'encolado', correlation_id: 'cmd-3-abcdef', text: 'hola' },
    { direction: 'reconcile', status: 'fallido', correlation_id: 'cmd-3-abcdef', message_ids: [] },
  );
  assert.equal(commanderOutboundStatus(raw, 'cmd-3-abcdef'), 'fallido');
});

test('commanderOutboundStatus: la última reconcile gana (reintentos)', () => {
  const raw = jsonl(
    { direction: 'out', status: 'encolado', correlation_id: 'cmd-4-abcdef', text: 'hola' },
    { direction: 'reconcile', status: 'fallido', correlation_id: 'cmd-4-abcdef', message_ids: [] },
    { direction: 'reconcile', status: 'enviado', correlation_id: 'cmd-4-abcdef', message_ids: [9] },
  );
  assert.equal(commanderOutboundStatus(raw, 'cmd-4-abcdef'), 'enviado');
});

test('commanderOutboundStatus: correlation_id desconocido → unknown', () => {
  assert.equal(commanderOutboundStatus(jsonl({ direction: 'in', text: 'x' }), 'cmd-x-abcdef'), 'unknown');
  assert.equal(commanderOutboundStatus('', 'cmd-x'), 'unknown');
  assert.equal(commanderOutboundStatus('basura\n{no json', 'cmd-x'), 'unknown');
});

// -----------------------------------------------------------------------------
// reconcileTelegramReceipts (CA-A3 — append-only + archivado + SEC-2 cuarentena)
// -----------------------------------------------------------------------------
test('reconcileTelegramReceipts: recibo válido → entry reconcile append-only + archiva', () => {
  const dir = sandbox();
  rec.writeReceipt(rec.receiptsDir(dir), { correlationId: 'cmd-r1-abcdef', status: 'enviado', messageIds: [7, 8] });

  const res = reconcileTelegramReceipts({ pipelineDir: dir });
  assert.equal(res.reconciled, 1);
  assert.equal(res.quarantined, 0);

  // El historial recibió una entry reconcile ligada por correlation_id.
  const raw = fs.readFileSync(path.join(dir, 'commander-history.jsonl'), 'utf8');
  assert.equal(commanderOutboundStatus(raw, 'cmd-r1-abcdef'), 'enviado');
  const entry = raw.trim().split('\n').map(JSON.parse).find(e => e.direction === 'reconcile');
  assert.deepEqual(entry.message_ids, [7, 8]);

  // El recibo consumido se archivó (no queda en recibos/).
  assert.equal(rec.listReceiptFiles(rec.receiptsDir(dir)).length, 0);
  assert.ok(fs.existsSync(path.join(rec.archivedReceiptsDir(dir), 'cmd-r1-abcdef.json')));
});

test('reconcileTelegramReceipts: recibo forjado/parcial → cuarentena, NUNCA enviado (SEC-2)', () => {
  const dir = sandbox();
  // Recibo `enviado` SIN messageIds escrito a mano (forjado, salta buildReceipt).
  const forgedPath = path.join(rec.receiptsDir(dir), 'cmd-forged-abcdef.json');
  fs.writeFileSync(forgedPath, JSON.stringify({
    correlationId: 'cmd-forged-abcdef', status: 'enviado', messageIds: [], at: '2026-06-18T00:00:00Z',
  }));

  const res = reconcileTelegramReceipts({ pipelineDir: dir });
  assert.equal(res.reconciled, 0);
  assert.equal(res.quarantined, 1);

  // No se escribió NINGUNA entry de historial (no se reconcilió como enviado).
  assert.equal(fs.existsSync(path.join(dir, 'commander-history.jsonl')), false);
  // El recibo forjado fue puesto en cuarentena (archivado con marcador -invalid).
  assert.equal(rec.listReceiptFiles(rec.receiptsDir(dir)).length, 0);
  const archived = fs.readdirSync(rec.archivedReceiptsDir(dir));
  assert.ok(archived.some(n => n.includes('-invalid')), 'el forjado va a cuarentena con marcador');
});

test('reconcileTelegramReceipts: sin recibos → no-op', () => {
  const dir = sandbox();
  const res = reconcileTelegramReceipts({ pipelineDir: dir });
  assert.deepEqual(res, { reconciled: 0, quarantined: 0 });
});

// -----------------------------------------------------------------------------
// resolveChatIdForCorrelation (CA-A4 — base del estampado de chat_id en reconcile)
// -----------------------------------------------------------------------------
test('resolveChatIdForCorrelation: toma el chat_id de la entry out previa', () => {
  const raw = jsonl(
    { direction: 'in', text: 'hola', chat_id: 42 },
    { direction: 'out', status: 'encolado', correlation_id: 'cmd-5-abcdef', text: 'chau', chat_id: 42 },
  );
  assert.equal(resolveChatIdForCorrelation(raw, 'cmd-5-abcdef'), 42);
});

test('resolveChatIdForCorrelation: correlation_id desconocido / out sin chat_id → null', () => {
  assert.equal(resolveChatIdForCorrelation(jsonl({ direction: 'out', correlation_id: 'cmd-6-abcdef' }), 'cmd-6-abcdef'), null);
  assert.equal(resolveChatIdForCorrelation(jsonl({ direction: 'in', text: 'x', chat_id: 9 }), 'cmd-x'), null);
  assert.equal(resolveChatIdForCorrelation('', 'cmd-x'), null);
  assert.equal(resolveChatIdForCorrelation('basura\n{no json', 'cmd-x'), null);
});

// -----------------------------------------------------------------------------
// CA-A4 END-TO-END: la entry `reconcile` lleva chat_id y SOBREVIVE al filtro
// per-chat → llega al contexto del Commander (causa raíz cerrada).
// -----------------------------------------------------------------------------
test('reconcileTelegramReceipts: estampa chat_id resuelto del out previo en la reconcile', () => {
  const dir = sandbox();
  const historyFile = path.join(dir, 'commander-history.jsonl');
  // Saliente ya encolado y registrado con su chat_id (como en runtime real).
  fs.writeFileSync(historyFile, jsonl(
    { direction: 'out', status: 'encolado', correlation_id: 'cmd-e2e-abcdef', text: 'respuesta', chat_id: 777 },
  ) + '\n');

  rec.writeReceipt(rec.receiptsDir(dir), { correlationId: 'cmd-e2e-abcdef', status: 'enviado', messageIds: [11] });
  const res = reconcileTelegramReceipts({ pipelineDir: dir });
  assert.equal(res.reconciled, 1);

  const raw = fs.readFileSync(historyFile, 'utf8');
  const reconcileEntry = raw.trim().split('\n').map(JSON.parse).find(e => e.direction === 'reconcile');
  assert.equal(reconcileEntry.chat_id, 777, 'la reconcile hereda el chat_id del out');

  // CA-A4: el selector per-chat (el que arma el contexto del Commander) AHORA
  // incluye la reconcile → el LLM ve el estado de entrega real, no solo el
  // `encolado`. Esto es lo que cierra el falso "ya te respondí".
  const visibles = selectCommanderHistoryForChat(raw, { activeChatId: 777, limit: 50 });
  const entries = visibles.map(JSON.parse);
  assert.ok(entries.some(e => e.direction === 'reconcile' && e.status === 'enviado'),
    'la reconcile enviada llega al contexto del chat activo');
  assert.equal(commanderOutboundStatus(raw, 'cmd-e2e-abcdef'), 'enviado');
});

test('reconcileTelegramReceipts: sin out previo, reconcile queda no-asignada (sin chat_id)', () => {
  const dir = sandbox();
  rec.writeReceipt(rec.receiptsDir(dir), { correlationId: 'cmd-orf-abcdef', status: 'fallido', messageIds: [] });
  reconcileTelegramReceipts({ pipelineDir: dir });

  const raw = fs.readFileSync(path.join(dir, 'commander-history.jsonl'), 'utf8');
  const reconcileEntry = raw.trim().split('\n').map(JSON.parse).find(e => e.direction === 'reconcile');
  assert.ok(!('chat_id' in reconcileEntry), 'sin out previo no se inventa chat_id');
  // No-asignada → no se filtra cross-chat hacia ningún chat concreto.
  assert.equal(selectCommanderHistoryForChat(raw, { activeChatId: 1 }).length, 0);
});
