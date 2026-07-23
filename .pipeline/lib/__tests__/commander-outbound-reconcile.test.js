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
// resolveChatIdForCorrelation (fix rebote rev-2 — cierre del lazo al contexto LLM)
// -----------------------------------------------------------------------------
test('resolveChatIdForCorrelation: hereda chat_id del out por correlation_id', () => {
  const raw = jsonl(
    { direction: 'in', from: 'leo', text: 'hola', chat_id: 999 },
    { direction: 'out', status: 'encolado', correlation_id: 'cmd-c1-abcdef', text: 'respondo', chat_id: 42 },
  );
  assert.equal(resolveChatIdForCorrelation(raw, 'cmd-c1-abcdef'), 42);
});

test('resolveChatIdForCorrelation: sin out para ese correlation_id → null', () => {
  const raw = jsonl({ direction: 'out', status: 'encolado', correlation_id: 'cmd-otro', text: 'x', chat_id: 42 });
  assert.equal(resolveChatIdForCorrelation(raw, 'cmd-c2-abcdef'), null);
  assert.equal(resolveChatIdForCorrelation('', 'cmd-x'), null);
  assert.equal(resolveChatIdForCorrelation('basura\n{no json', 'cmd-x'), null);
});

// -----------------------------------------------------------------------------
// CIERRE DEL LAZO (fix rebote rev-2): la reconcile con chat_id heredado del out
// SOBREVIVE al filtro per-chat y llega al contexto que ve el LLM del Commander.
// Este es el bug del rechazo: antes la reconcile se appendeaba SIN chat_id y
// `commanderEntryBelongsToChat` la descartaba → el estado real de entrega nunca
// fluía al prompt.
// -----------------------------------------------------------------------------
test('reconcile hereda chat_id del out y aparece en selectCommanderHistoryForChat', () => {
  const dir = sandbox();
  const historyFile = path.join(dir, 'commander-history.jsonl');
  // El flujo de envío ya dejó el `out` (encolado) con chat_id del chat activo.
  fs.writeFileSync(historyFile, jsonl(
    { direction: 'out', status: 'encolado', correlation_id: 'cmd-loop-abcdef', text: 'te respondo', chat_id: 7777 },
  ) + '\n');
  // Llega el recibo de entrega confirmada del servicio Telegram.
  rec.writeReceipt(rec.receiptsDir(dir), { correlationId: 'cmd-loop-abcdef', status: 'enviado', messageIds: [11] });

  const res = reconcileTelegramReceipts({ pipelineDir: dir });
  assert.equal(res.reconciled, 1);

  const raw = fs.readFileSync(historyFile, 'utf8');
  const reconcileEntry = raw.trim().split('\n').map(JSON.parse).find(e => e.direction === 'reconcile');
  // La entry reconcile heredó el chat_id del out original.
  assert.equal(reconcileEntry.chat_id, 7777);

  // Y por tanto el selector per-chat del contexto del LLM la incluye para ese chat.
  const visibles = selectCommanderHistoryForChat(raw, { activeChatId: 7777, limit: 50 });
  const reconcileVisible = visibles.map(JSON.parse).find(e => e.direction === 'reconcile');
  assert.ok(reconcileVisible, 'la reconcile con chat_id debe llegar al contexto del LLM para ese chat');
  assert.equal(reconcileVisible.status, 'enviado');
  assert.match(reconcileVisible.text, /entrega confirmada/);

  // Aislamiento: NO se filtra a otro chat (SEC-3).
  const otroChat = selectCommanderHistoryForChat(raw, { activeChatId: 1234, limit: 50 });
  assert.equal(otroChat.map(JSON.parse).some(e => e.direction === 'reconcile'), false);
});

test('reconcile fallido es visible al LLM con aviso de NO entrega', () => {
  const dir = sandbox();
  const historyFile = path.join(dir, 'commander-history.jsonl');
  fs.writeFileSync(historyFile, jsonl(
    { direction: 'out', status: 'encolado', correlation_id: 'cmd-fail-abcdef', text: 'hola', chat_id: 555 },
  ) + '\n');
  rec.writeReceipt(rec.receiptsDir(dir), { correlationId: 'cmd-fail-abcdef', status: 'fallido', messageIds: [] });

  reconcileTelegramReceipts({ pipelineDir: dir });
  const raw = fs.readFileSync(historyFile, 'utf8');
  const visible = selectCommanderHistoryForChat(raw, { activeChatId: 555, limit: 50 })
    .map(JSON.parse).find(e => e.direction === 'reconcile');
  assert.ok(visible, 'reconcile fallido debe llegar al contexto del chat');
  assert.equal(visible.status, 'fallido');
  assert.match(visible.text, /NO llego/);
});

test('reconcile sin out previo NO estampa chat_id (degrada, nunca cross-chat)', () => {
  const dir = sandbox();
  // No hay `out` con este correlation_id en el historial.
  rec.writeReceipt(rec.receiptsDir(dir), { correlationId: 'cmd-huerfano-abcdef', status: 'enviado', messageIds: [3] });

  reconcileTelegramReceipts({ pipelineDir: dir });
  const raw = fs.readFileSync(path.join(dir, 'commander-history.jsonl'), 'utf8');
  const entry = raw.trim().split('\n').map(JSON.parse).find(e => e.direction === 'reconcile');
  // Sin out previo → reconcile queda NO-ASIGNADA (sin chat_id): no se inyecta a
  // ningún chat concreto. El estado sigue disponible vía commanderOutboundStatus.
  assert.equal(entry.chat_id, undefined);
  assert.equal(commanderOutboundStatus(raw, 'cmd-huerfano-abcdef'), 'enviado');
});
