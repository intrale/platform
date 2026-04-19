#!/usr/bin/env node
// =============================================================================
// Servicio Telegram — Fire-and-forget message sender
// Procesa cola de servicios/telegram/pendiente/
//
// Migrado a http-client seguro (issue #2332):
//   - SSRF guard sobre api.telegram.org (CA-9/CA-13)
//   - TLS estricto, timeouts escalonados, body cap, CRLF protect
//   - Denials loggeados estructuradamente (CA-11)
// =============================================================================

const fs = require('fs');
const path = require('path');
const httpClient = require('./lib/http-client');
const { ERROR_CODES } = require('./lib/constants');

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

// Tag fijo para logs del http-client — permite filtrar denials del servicio.
const AGENT_TAG = 'svc-telegram';

/**
 * Logging estructurado de denial SSRF/proxy (CA-11 del #2332).
 * El http-client ya logea internamente, pero replicamos al log persistente
 * del servicio para trazabilidad post-mortem (crash-handlers escriben acá).
 */
function logDenialIfAny(method, err) {
  if (!err) return;
  const code = err.code;
  if (code === ERROR_CODES.SSRF_BLOCKED || code === ERROR_CODES.PROXY_NOT_WHITELISTED) {
    log(`DENIAL ${code} method=${method} razon=${err.message}`);
  }
}

/**
 * Envío JSON a la API de Telegram vía http-client seguro.
 * POST con `retryable:true` porque sendMessage de Telegram tolera duplicados
 * con el mismo texto (Telegram de-dupea por chat_id + text cuando llega rápido).
 */
async function telegramSend(method, params) {
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/${method}`;
  const body = { chat_id: CHAT_ID, ...params };
  try {
    const res = await httpClient.postJson(url, body, {
      agentTag: AGENT_TAG,
      timeout: 30000,
      retryable: true, // idempotente en la práctica para sendMessage
    });
    return res.body;
  } catch (err) {
    logDenialIfAny(method, err);
    throw err;
  }
}

/** Enviar documento/foto via multipart form-data usando http-client seguro. */
async function telegramSendMultipart(method, fieldName, filePath, extra = {}) {
  const boundary = '----PipelineV2' + Date.now();
  const filename = path.basename(filePath);
  const fileData = fs.readFileSync(filePath);

  let prologue = '';
  // chat_id field
  prologue += `--${boundary}\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n${CHAT_ID}\r\n`;
  // extra fields (caption, parse_mode, etc.)
  for (const [key, val] of Object.entries(extra)) {
    prologue += `--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${val}\r\n`;
  }
  // file field header
  const fileHeader = `--${boundary}\r\nContent-Disposition: form-data; name="${fieldName}"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`;
  const fileFooter = `\r\n--${boundary}--\r\n`;

  const bodyBuf = Buffer.concat([
    Buffer.from(prologue + fileHeader),
    fileData,
    Buffer.from(fileFooter),
  ]);

  const url = `https://api.telegram.org/bot${BOT_TOKEN}/${method}`;
  try {
    const res = await httpClient.request(url, {
      method: 'POST',
      body: bodyBuf,
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
      },
      agentTag: AGENT_TAG,
      timeout: 60000,
      // Envíos de archivo NO son idempotentes por lado de Telegram: NO retry automático.
      // Cap de respuesta por default (10 MB) alcanza para la respuesta JSON del send.
    });
    // La API devuelve JSON; si el parser del http-client no pudo parsearlo
    // (p.ej. content-type no json), devolvemos estructura similar al código previo.
    if (typeof res.body === 'string') {
      try { return JSON.parse(res.body); } catch { return { ok: false, description: res.body }; }
    }
    if (Buffer.isBuffer(res.body)) {
      const s = res.body.toString('utf8');
      try { return JSON.parse(s); } catch { return { ok: false, description: s }; }
    }
    return res.body;
  } catch (err) {
    logDenialIfAny(method, err);
    throw err;
  }
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
