#!/usr/bin/env node
// =============================================================================
// Listener Telegram V2 — Long-polling puro, cero tokens
// Recibe mensajes y los encola en servicios/commander/pendiente/
// =============================================================================

const https = require('https');
const fs = require('fs');
const path = require('path');

const PIPELINE = process.env.PIPELINE_STATE_DIR || path.resolve(__dirname);
const COMMANDER_QUEUE = path.join(PIPELINE, 'servicios', 'commander', 'pendiente');
const HISTORY_FILE = path.join(PIPELINE, 'commander-history.jsonl');
const OFFSET_FILE = path.join(PIPELINE, 'listener-offset.json');

// Leer config de Telegram
const MAIN_ROOT = process.env.PIPELINE_MAIN_ROOT || path.resolve(__dirname, '..');
const TELEGRAM_CONFIG = path.join(MAIN_ROOT, '.claude', 'hooks', 'telegram-config.json');
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

// --- Download Telegram files ---

const MEDIA_DIR = path.join(PIPELINE, 'logs', 'media');
try { fs.mkdirSync(MEDIA_DIR, { recursive: true }); } catch {}

async function downloadTelegramFile(fileId, ext) {
  try {
    // Get file path from Telegram API
    const fileInfo = await telegramRequest('getFile', { file_id: fileId });
    if (!fileInfo.ok || !fileInfo.result?.file_path) return null;

    const remotePath = fileInfo.result.file_path;
    const localName = `${Date.now()}-${fileId.slice(-8)}.${ext}`;
    const localPath = path.join(MEDIA_DIR, localName);

    // Download file
    return new Promise((resolve, reject) => {
      const url = `https://api.telegram.org/file/bot${BOT_TOKEN}/${remotePath}`;
      https.get(url, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          fs.writeFileSync(localPath, Buffer.concat(chunks));
          log(`Descargado: ${localName} (${Buffer.concat(chunks).length} bytes)`);
          resolve(localPath);
        });
      }).on('error', (e) => { log(`Error descargando: ${e.message}`); resolve(null); });
    });
  } catch (e) {
    log(`Error en downloadTelegramFile: ${e.message}`);
    return null;
  }
}

// --- Enqueue message for Commander ---

// Deduplicación: trackear últimos message_id procesados
const processedMessageIds = new Set();

async function enqueueMessage(update) {
  const msg = update.message;
  if (!msg) return;

  // Solo procesar mensajes del chat autorizado
  if (String(msg.chat.id) !== String(CHAT_ID)) return;

  // Deduplicar: no procesar el mismo message_id dos veces
  if (processedMessageIds.has(msg.message_id)) {
    log(`Duplicado ignorado: message_id=${msg.message_id}`);
    return;
  }
  processedMessageIds.add(msg.message_id);
  // Limpiar set si crece mucho (mantener últimos 100)
  if (processedMessageIds.size > 100) {
    const arr = [...processedMessageIds];
    arr.slice(0, arr.length - 100).forEach(id => processedMessageIds.delete(id));
  }

  const id = `${Date.now()}-${msg.message_id}`;

  // Descargar multimedia si existe
  let photoPath = null;
  let voicePath = null;
  let caption = msg.caption || '';

  if (msg.photo && msg.photo.length > 0) {
    const bestPhoto = msg.photo[msg.photo.length - 1];
    photoPath = await downloadTelegramFile(bestPhoto.file_id, 'jpg');
  }

  if (msg.voice) {
    voicePath = await downloadTelegramFile(msg.voice.file_id, 'ogg');
  }

  if (msg.audio) {
    voicePath = await downloadTelegramFile(msg.audio.file_id, 'mp3');
  }

  const content = {
    message_id: msg.message_id,
    from: msg.from?.first_name || 'unknown',
    text: msg.text || caption || '',
    photo: msg.photo ? msg.photo[msg.photo.length - 1]?.file_id : null,
    photo_path: photoPath,
    voice: msg.voice?.file_id || msg.audio?.file_id || null,
    voice_path: voicePath,
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
  try { require('./lib/ready-marker').signalReady('listener', { offset }); } catch {}

  while (true) {
    try {
      const result = await telegramRequest('getUpdates', {
        offset,
        timeout: 30,
        allowed_updates: ['message']
      });

      if (result.ok && result.result?.length > 0) {
        for (const update of result.result) {
          try {
            await enqueueMessage(update);
          } catch (e) {
            log(`Error procesando update ${update.update_id}: ${e.message}`);
          }
          offset = update.update_id + 1;
        }
        saveOffset(offset);
        log(`Procesados ${result.result.length} update(s), offset → ${offset}`);
      }
    } catch (e) {
      log(`Error en polling: ${e.message}`);
      await new Promise(r => setTimeout(r, 5000));
    }
  }
}

// --- SINGLETON ---
require('./singleton')('listener');

pollLoop().catch(e => { log(`Fatal: ${e.message}`); process.exit(1); });
