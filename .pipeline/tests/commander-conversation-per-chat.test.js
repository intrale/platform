'use strict';

// #3934 (EP4-H1) — Conversación estructurada user/assistant persistida POR CHAT.
//
// Cubre los criterios verificables sobre los helpers del Commander:
//   CA-1  → la conversación sobrevive reinicios (releer el JSONL desde cero
//           reconstruye el contexto del chat).
//   CA-3  → sanitización fail-closed por VALOR (entropía Shannon ≥4.5) antes de
//           persistir: un secreto sintético queda redactado en disco.
//   CA-4  → persistencia con `chat_id` + aislamiento ESTRICTO en la lectura.
//   CA-4 legacy → entrada sin `chat_id` = no-asignada (no se inyecta cross-chat).
//   CA-6  → frescura preservada al rehidratar (una confirmación vencida no se
//           resucita como fresca) + aislamiento de la confirmación por chat.
//   CA-8  → retención (30 días) + tope por chat con escritura atómica.

process.env.PULPO_NO_AUTOSTART = '1';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const pulpo = require('../pulpo.js');
const {
  appendCommanderHistory,
  sanitizeCommanderTurnText,
  selectCommanderHistoryForChat,
  commanderEntryBelongsToChat,
  pruneCommanderHistory,
  readPendingConfirmation,
  COMMANDER_HISTORY_RETENTION_DAYS,
  COMMANDER_HISTORY_MAX_PER_CHAT,
} = pulpo;

// --- helpers de test ---------------------------------------------------------

function tmpHistoryFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmd-hist-'));
  return path.join(dir, 'commander-history.jsonl');
}

function readEntries(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

const CHAT_A = '111';
const CHAT_B = '-222'; // los grupos de Telegram son negativos
const SECRET = 'sk-' + 'aB3xQ9pLm2VnT7zRk4Wd8Bc1Hj6Yf3Gs0Aa5kZ7Wn2Pq9Lx4Tv'; // token opaco alta entropía

// --- CA-3 · Sanitización por valor antes de persistir ------------------------

test('CA-3: sanitizeCommanderTurnText redacta un secreto opaco de alta entropía embebido en texto libre', () => {
  const out = sanitizeCommanderTurnText(`la clave es ${SECRET} guardala bien`);
  assert.ok(!out.includes(SECRET), 'el secreto no debe quedar en claro');
  assert.match(out, /\[REDACTED/, 'debe haber un marcador de redacción');
  // El texto no sensible se preserva.
  assert.match(out, /la clave es/);
  assert.match(out, /guardala bien/);
});

test('CA-3: appendCommanderHistory NO escribe el secreto en claro en disco', () => {
  const file = tmpHistoryFile();
  appendCommanderHistory(file, { direction: 'in', from: 'Leo', text: `mi token ${SECRET}`, chat_id: CHAT_A });
  const raw = fs.readFileSync(file, 'utf8');
  assert.ok(!raw.includes(SECRET), 'el JSONL en disco no debe contener el secreto');
  assert.match(raw, /\[REDACTED/);
});

test('CA-3: texto conversacional normal no se ve afectado por la sanitización', () => {
  const out = sanitizeCommanderTurnText('hola, ¿cómo viene el pipeline hoy? todo bien gracias');
  assert.equal(out, 'hola, ¿cómo viene el pipeline hoy? todo bien gracias');
});

// --- CA-4 · Persistencia con chat_id + aislamiento estricto ------------------

test('CA-4: cada turno se persiste con su chat_id', () => {
  const file = tmpHistoryFile();
  appendCommanderHistory(file, { direction: 'in', from: 'Leo', text: 'hola', chat_id: CHAT_A });
  const [entry] = readEntries(file);
  assert.equal(String(entry.chat_id), CHAT_A);
  assert.ok(entry.timestamp, 'el helper completa timestamp por default');
});

test('CA-4 / SEC-3: los turnos del chat A nunca aparecen en el contexto leído para el chat B', () => {
  const file = tmpHistoryFile();
  appendCommanderHistory(file, { direction: 'in', from: 'Leo', text: 'secreto del chat A', chat_id: CHAT_A });
  appendCommanderHistory(file, { direction: 'out', text: 'respuesta a chat A', chat_id: CHAT_A });
  appendCommanderHistory(file, { direction: 'in', from: 'Ana', text: 'mensaje del chat B', chat_id: CHAT_B });

  const raw = fs.readFileSync(file, 'utf8');
  const forB = selectCommanderHistoryForChat(raw, { activeChatId: CHAT_B });
  const forA = selectCommanderHistoryForChat(raw, { activeChatId: CHAT_A });

  assert.equal(forB.length, 1, 'el chat B sólo ve su propio turno');
  assert.match(forB[0], /mensaje del chat B/);
  assert.ok(!forB.join('').includes('chat A'), 'ningún turno del chat A se filtra al chat B');

  assert.equal(forA.length, 2, 'el chat A ve sus dos turnos');
  assert.ok(!forA.join('').includes('chat B'));
});

test('CA-4 legacy: una entrada sin chat_id se trata como no-asignada (no se inyecta a ningún chat)', () => {
  assert.equal(commanderEntryBelongsToChat({ text: 'legacy' }, CHAT_A), false);
  assert.equal(commanderEntryBelongsToChat({ chat_id: null, text: 'legacy' }, CHAT_A), false);

  const file = tmpHistoryFile();
  // Entrada legacy escrita a mano (sin chat_id), como las previas a #3934.
  fs.writeFileSync(file, JSON.stringify({ direction: 'in', text: 'turno legacy', timestamp: new Date().toISOString() }) + '\n');
  const forA = selectCommanderHistoryForChat(fs.readFileSync(file, 'utf8'), { activeChatId: CHAT_A });
  assert.equal(forA.length, 0, 'la entrada legacy no se inyecta a un chat concreto');
});

test('CA-4: selectCommanderHistoryForChat respeta la ventana temporal (cutoffIso)', () => {
  const file = tmpHistoryFile();
  const viejo = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
  const nuevo = new Date().toISOString();
  fs.writeFileSync(file,
    JSON.stringify({ direction: 'in', text: 'viejo', chat_id: CHAT_A, timestamp: viejo }) + '\n' +
    JSON.stringify({ direction: 'in', text: 'nuevo', chat_id: CHAT_A, timestamp: nuevo }) + '\n');
  const cutoff24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const recientes = selectCommanderHistoryForChat(fs.readFileSync(file, 'utf8'), { activeChatId: CHAT_A, cutoffIso: cutoff24h });
  assert.equal(recientes.length, 1);
  assert.match(recientes[0], /nuevo/);
});

// --- CA-1 · La conversación sobrevive reinicios ------------------------------

test('CA-1: tras un "reinicio" (releer el JSONL desde cero) el contexto del chat se reconstruye', () => {
  const file = tmpHistoryFile();
  appendCommanderHistory(file, { direction: 'in', from: 'Leo', text: 'primer turno', chat_id: CHAT_A });
  appendCommanderHistory(file, { direction: 'out', text: 'respuesta', chat_id: CHAT_A });

  // "Reinicio": no hay estado en memoria, releemos el archivo desde disco.
  const reconstruido = selectCommanderHistoryForChat(fs.readFileSync(file, 'utf8'), { activeChatId: CHAT_A });
  assert.equal(reconstruido.length, 2);
  assert.match(reconstruido.join('\n'), /primer turno/);
  assert.match(reconstruido.join('\n'), /respuesta/);
});

// --- CA-6 · Frescura preservada al rehidratar --------------------------------

test('CA-6: una confirmación pendiente vencida (> TTL) no se rehidrata como fresca', () => {
  const file = tmpHistoryFile();
  const viejo = new Date(Date.now() - 10 * 60 * 1000).toISOString(); // 10 min > TTL de 5 min
  appendCommanderHistory(file, {
    direction: 'in_pending_confirmation', action: 'issue_creation', text: 'crear issue X', chat_id: CHAT_A, timestamp: viejo,
  });
  assert.equal(readPendingConfirmation(file, { chatId: CHAT_A }), null, 'la confirmación vencida no debe recuperarse');
});

test('CA-6: una confirmación pendiente fresca se rehidrata sólo para su propio chat', () => {
  const file = tmpHistoryFile();
  appendCommanderHistory(file, {
    direction: 'in_pending_confirmation', action: 'issue_creation', text: 'crear issue Y', chat_id: CHAT_A,
  });
  const paraA = readPendingConfirmation(file, { chatId: CHAT_A });
  assert.ok(paraA, 'el chat A recupera su confirmación fresca');
  assert.equal(paraA.action, 'issue_creation');
  // SEC-3: la confirmación del chat A no debe replayarse en el chat B.
  assert.equal(readPendingConfirmation(file, { chatId: CHAT_B }), null);
});

// --- CA-8 · Retención + tope por chat ----------------------------------------

test('CA-8: pruneCommanderHistory poda entradas fuera de la ventana de retención', () => {
  const file = tmpHistoryFile();
  const muyViejo = new Date(Date.now() - (COMMANDER_HISTORY_RETENTION_DAYS + 5) * 24 * 60 * 60 * 1000).toISOString();
  const reciente = new Date().toISOString();
  fs.writeFileSync(file,
    JSON.stringify({ direction: 'in', text: 'antiguo', chat_id: CHAT_A, timestamp: muyViejo }) + '\n' +
    JSON.stringify({ direction: 'in', text: 'reciente', chat_id: CHAT_A, timestamp: reciente }) + '\n');
  const res = pruneCommanderHistory(file);
  assert.equal(res.pruned, 1);
  const entries = readEntries(file);
  assert.equal(entries.length, 1);
  assert.match(entries[0].text, /reciente/);
});

test('CA-8: pruneCommanderHistory aplica un tope por chat conservando las más nuevas', () => {
  const file = tmpHistoryFile();
  const total = COMMANDER_HISTORY_MAX_PER_CHAT + 10;
  const lines = [];
  for (let i = 0; i < total; i++) {
    // timestamps crecientes para que las últimas sean las más nuevas.
    const ts = new Date(Date.now() - (total - i) * 1000).toISOString();
    lines.push(JSON.stringify({ direction: 'in', text: `turno ${i}`, chat_id: CHAT_A, timestamp: ts }));
  }
  fs.writeFileSync(file, lines.join('\n') + '\n');
  const res = pruneCommanderHistory(file);
  assert.equal(res.kept, COMMANDER_HISTORY_MAX_PER_CHAT);
  const entries = readEntries(file);
  assert.equal(entries.length, COMMANDER_HISTORY_MAX_PER_CHAT);
  // Conserva la más nueva (turno total-1) y descarta las más viejas (turno 0).
  assert.equal(entries[entries.length - 1].text, `turno ${total - 1}`);
  assert.equal(entries[0].text, `turno ${total - COMMANDER_HISTORY_MAX_PER_CHAT}`);
});

test('CA-8: prune es fail-open ante archivo inexistente (no rompe el commander)', () => {
  const res = pruneCommanderHistory(path.join(os.tmpdir(), 'no-existe-' + process.pid + '.jsonl'));
  assert.deepEqual(res, { pruned: 0, kept: 0 });
});
