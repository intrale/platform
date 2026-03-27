#!/usr/bin/env node
// =============================================================================
// Listener Telegram V2 — Long-polling puro, cero tokens
// Recibe mensajes y los encola en servicios/commander/pendiente/
// =============================================================================

const https = require('https');
const fs = require('fs');
const path = require('path');

const PIPELINE = path.resolve(__dirname);
const COMMANDER_QUEUE = path.join(PIPELINE, 'servicios', 'commander', 'pendiente');
const HISTORY_FILE = path.join(PIPELINE, 'commander-history.jsonl');
const OFFSET_FILE = path.join(PIPELINE, 'listener-offset.json');

// Leer config de Telegram
const TELEGRAM_CONFIG = path.join(path.resolve(__dirname, '..'), '.claude', 'hooks', 'telegram-config.json');
let BOT_TOKEN, CHAT_ID;

try {
  const config = JSON.parse(fs.readFileSync(TELEGRAM_CONFIG, 'utf8'));
  BOT_TOKEN = config.bot_token;
  CHAT_ID = config.chat_id;
} catch (e) {
  console.error('Error leyendo telegram-config.json:', e.message);
  process.exit(1);
}

function log(msg) {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  console.log(`[${ts}] [listener] ${msg}`);
}

// --- Offset persistence ---

function loadOffset() {
  try {
    return JSON.parse(fs.readFileSync(OFFSET_FILE, 'utf8')).offset || 0;
  } catch { return 0; }
}

function saveOffset(offset) {
  fs.writeFileSync(OFFSET_FILE, JSON.stringify({ offset }));
}

// --- History ---

function appendHistory(entry) {
  const line = JSON.stringify({ ...entry, timestamp: new Date().toISOString() });
  fs.appendFileSync(HISTORY_FILE, line + '\n');
}

// --- Telegram API ---

function telegramRequest(method, params) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(params);
    const options = {
      hostname: 'api.telegram.org',
      path: `/bot${BOT_TOKEN}/${method}`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch { resolve({ ok: false, error: body }); }
      });
    });

    req.on('error', reject);
    req.setTimeout(60000, () => { req.destroy(); reject(new Error('timeout')); });
    req.write(data);
    req.end();
  });
}

async function sendMessage(text) {
  try {
    await telegramRequest('sendMessage', {
      chat_id: CHAT_ID,
      text,
      parse_mode: 'Markdown'
    });
  } catch (e) {
    log(`Error enviando mensaje: ${e.message}`);
  }
}

// --- Enqueue message for Commander ---

function enqueueMessage(update) {
  const msg = update.message;
  if (!msg) return;

  // Solo procesar mensajes del chat autorizado
  if (String(msg.chat.id) !== String(CHAT_ID)) return;

  const id = `${Date.now()}-${msg.message_id}`;
  const content = {
    message_id: msg.message_id,
    from: msg.from?.first_name || 'unknown',
    text: msg.text || '',
    photo: msg.photo ? msg.photo[msg.photo.length - 1]?.file_id : null,
    voice: msg.voice?.file_id || null,
    date: msg.date
  };

  // Escribir en cola del Commander
  const filePath = path.join(COMMANDER_QUEUE, `${id}.json`);
  fs.writeFileSync(filePath, JSON.stringify(content, null, 2));

  // Registrar en historial
  appendHistory({ direction: 'in', ...content });

  log(`Mensaje encolado: "${(content.text || '').slice(0, 50)}..." → ${filePath}`);
}

// --- Main polling loop ---

async function pollLoop() {
  let offset = loadOffset();
  log(`Listener iniciado — offset: ${offset}`);
  log(`Chat ID: ${CHAT_ID}`);

  await sendMessage('🐙 *Pipeline V2* — Listener activo');

  while (true) {
    try {
      const result = await telegramRequest('getUpdates', {
        offset,
        timeout: 30,
        allowed_updates: ['message']
      });

      if (result.ok && result.result?.length > 0) {
        for (const update of result.result) {
          enqueueMessage(update);
          offset = update.update_id + 1;
        }
        saveOffset(offset);
      }
    } catch (e) {
      log(`Error en polling: ${e.message}`);
      await new Promise(r => setTimeout(r, 5000));
    }
  }
}

// --- PID file ---
fs.writeFileSync(path.join(PIPELINE, 'listener.pid'), String(process.pid));

process.on('SIGINT', () => { log('Cerrando listener'); process.exit(0); });
process.on('SIGTERM', () => { log('Cerrando listener'); process.exit(0); });

pollLoop().catch(e => { log(`Fatal: ${e.message}`); process.exit(1); });
