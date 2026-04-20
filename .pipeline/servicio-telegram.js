#!/usr/bin/env node
// =============================================================================
// Servicio Telegram — Fire-and-forget message sender
// Procesa cola de servicios/telegram/pendiente/
// =============================================================================

const https = require('https');
const fs = require('fs');
const path = require('path');

const PIPELINE = process.env.PIPELINE_STATE_DIR || path.resolve(__dirname);
const QUEUE_DIR = path.join(PIPELINE, 'servicios', 'telegram');
const PENDIENTE = path.join(QUEUE_DIR, 'pendiente');
const TRABAJANDO = path.join(QUEUE_DIR, 'trabajando');
const LISTO = path.join(QUEUE_DIR, 'listo');

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
  console.log(`[${ts}] [svc-telegram] ${msg}`);
}

function telegramSend(method, params) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({ chat_id: CHAT_ID, ...params });
    const options = {
      hostname: 'api.telegram.org',
      path: `/bot${BOT_TOKEN}/${method}`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
    };
    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', (c) => body += c);
      res.on('end', () => resolve(JSON.parse(body)));
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('timeout')); });
    req.write(data);
    req.end();
  });
}

/** Enviar documento/foto via multipart form-data */
function telegramSendMultipart(method, fieldName, filePath, extra = {}) {
  return new Promise((resolve, reject) => {
    const boundary = '----PipelineV2' + Date.now();
    const filename = path.basename(filePath);
    const fileData = fs.readFileSync(filePath);

    let body = '';
    // chat_id field
    body += `--${boundary}\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n${CHAT_ID}\r\n`;
    // extra fields (caption, parse_mode, etc.)
    for (const [key, val] of Object.entries(extra)) {
      body += `--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${val}\r\n`;
    }
    // file field
    const fileHeader = `--${boundary}\r\nContent-Disposition: form-data; name="${fieldName}"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`;
    const fileFooter = `\r\n--${boundary}--\r\n`;

    const bodyBuf = Buffer.concat([
      Buffer.from(body + fileHeader),
      fileData,
      Buffer.from(fileFooter)
    ]);

    const options = {
      hostname: 'api.telegram.org',
      path: `/bot${BOT_TOKEN}/${method}`,
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': bodyBuf.length
      }
    };
    const req = https.request(options, (res) => {
      let resp = '';
      res.on('data', (c) => resp += c);
      res.on('end', () => {
        try { resolve(JSON.parse(resp)); } catch { resolve({ ok: false, description: resp }); }
      });
    });
    req.on('error', reject);
    req.setTimeout(60000, () => { req.destroy(); reject(new Error('timeout')); });
    req.write(bodyBuf);
    req.end();
  });
}

function listWorkFiles(dir) {
  try {
    return fs.readdirSync(dir)
      .filter(f => !f.startsWith('.') && f.endsWith('.json'))
      .map(f => ({ name: f, path: path.join(dir, f) }));
  } catch { return []; }
}

async function processQueue() {
  const files = listWorkFiles(PENDIENTE);
  if (files.length === 0) return;

  for (const file of files) {
    const trabajandoPath = path.join(TRABAJANDO, file.name);
    try {
      fs.renameSync(file.path, trabajandoPath);
    } catch { continue; } // otro proceso lo tomó

    try {
      const data = JSON.parse(fs.readFileSync(trabajandoPath, 'utf8'));

      if (data.document && fs.existsSync(data.document)) {
        // Enviar documento real via multipart
        const extra = {};
        if (data.caption) extra.caption = data.caption;
        if (data.parse_mode) extra.parse_mode = data.parse_mode;
        await telegramSendMultipart('sendDocument', 'document', data.document, extra);
      } else if (data.photo && fs.existsSync(data.photo)) {
        // Enviar foto real via multipart
        const extra = {};
        if (data.caption) extra.caption = data.caption;
        if (data.parse_mode) extra.parse_mode = data.parse_mode;
        await telegramSendMultipart('sendPhoto', 'photo', data.photo, extra);
      } else if (data.text) {
        await telegramSend('sendMessage', { text: data.text, parse_mode: data.parse_mode || 'Markdown' });
      }

      const listoPath = path.join(LISTO, file.name);
      fs.renameSync(trabajandoPath, listoPath);
      log(`Enviado: ${file.name}`);
    } catch (e) {
      log(`Error procesando ${file.name}: ${e.message}`);
      // Devolver a pendiente para reintento
      try { fs.renameSync(trabajandoPath, file.path); } catch {}
    }
  }
}

// Main loop
async function main() {
  log('Servicio Telegram iniciado');
  try { require('./lib/ready-marker').signalReady('svc-telegram'); } catch {}
  while (true) {
    try { await processQueue(); } catch (e) { log(`Error: ${e.message}`); }
    await new Promise(r => setTimeout(r, 5000)); // Poll cada 5 seg
  }
}

// Crash handlers — loguear antes de morir para diagnóstico
const LOG_DIR = path.join(PIPELINE, 'logs');
process.on('uncaughtException', (err) => {
  const msg = `[${new Date().toISOString()}] [svc-telegram] CRASH uncaughtException: ${err.stack || err.message}\n`;
  try { fs.appendFileSync(path.join(LOG_DIR, 'svc-telegram.log'), msg); } catch {}
  console.error(msg);
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  const msg = `[${new Date().toISOString()}] [svc-telegram] CRASH unhandledRejection: ${reason?.stack || reason}\n`;
  try { fs.appendFileSync(path.join(LOG_DIR, 'svc-telegram.log'), msg); } catch {}
  console.error(msg);
  process.exit(1);
});

// --- SINGLETON ---
require('./singleton')('svc-telegram');
main();
