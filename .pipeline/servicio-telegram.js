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
const yaml = require('js-yaml');
const httpClient = require('./lib/http-client');
const { ERROR_CODES } = require('./lib/constants');
// #2334 / CA6: patch console.* para que NUNCA se escriba un secreto al
// archivo de log del servicio (los servicios escriben via fd inherited,
// por eso interceptamos dentro del proceso).
require('./lib/sanitize-console').install();
// #2334: sanitización write-time antes de llamar al API de Telegram.
// Aunque el archivo en disco ya venga sanitizado por el productor (pulpo /
// rejection-report), defendemos el último hop: el payload que realmente
// viaja al API externo DEBE ir sanitizado.
const { sanitize } = require('./sanitizer');
const { sanitizeTelegramPayload } = require('./lib/sanitize-payload');
const { splitLongMessage } = require('./lib/split-long-message');
// #3668 — Agrupador de bursts de notificaciones. El drainer aplica
// `groupByBurst` ANTES de mover archivos a trabajando/, así un cascade de
// fallback emite UN mensaje consolidado en vez de N mensajes idénticos
// separados por ~7ms. Ver `.pipeline/lib/telegram-burst-grouper.js`.
const burstGrouper = require('./lib/telegram-burst-grouper');

const PIPELINE = process.env.PIPELINE_STATE_DIR || path.resolve(__dirname);
const QUEUE_DIR = path.join(PIPELINE, 'servicios', 'telegram');
const PENDIENTE = path.join(QUEUE_DIR, 'pendiente');
const TRABAJANDO = path.join(QUEUE_DIR, 'trabajando');
const LISTO = path.join(QUEUE_DIR, 'listo');

const MAIN_ROOT = process.env.PIPELINE_MAIN_ROOT || path.resolve(__dirname, '..');
const TELEGRAM_CONFIG = path.join(MAIN_ROOT, '.claude', 'hooks', 'telegram-config.json');
const CONFIG_PATH = path.join(PIPELINE, 'config.yaml');

// #3668 — config loader best-effort para `telegram_burst_window_ms`. Si el
// YAML no existe o no parsea, el grupo del burst usa el default hardcoded en
// el módulo y NO crashea el drainer (anti-DoS de booting).
function loadPipelineConfig() {
  try {
    return yaml.load(fs.readFileSync(CONFIG_PATH, 'utf8')) || {};
  } catch {
    return {};
  }
}
const { loadTelegramSecrets } = require('./lib/telegram-secrets');
const health = require('./lib/telegram-health');

function log(msg) {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  console.log(`[${ts}] [svc-telegram] ${msg}`);
}

let BOT_TOKEN, CHAT_ID;
try {
  const sec = loadTelegramSecrets({ legacyConfigPath: TELEGRAM_CONFIG, log });
  BOT_TOKEN = sec.bot_token;
  CHAT_ID = sec.chat_id;
  log(`Secrets cargados desde: ${sec.source}`);
} catch (e) {
  console.error('FATAL: ' + e.message);
  health.markError(PIPELINE, { code: e.code || 'NO_SECRETS', description: e.message, source: 'startup' });
  process.exit(1);
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

/** Enviar documento/foto/video/animation via multipart form-data usando http-client seguro.
 *
 * #3540 (CA-UX-EXT-3): el caller puede pasar `extra.filename` para sobreescribir
 * el filename que ve el usuario en Telegram (default: basename del path en disco).
 * El filename declarado por el caller NUNCA se inyecta crudo — se sanitiza
 * `[^A-Za-z0-9._-]+ → '-'` para evitar CRLF injection en el header HTTP.
 */
async function telegramSendMultipart(method, fieldName, filePath, extra = {}) {
  const boundary = '----PipelineV2' + Date.now();
  // CA-UX-EXT-3 + defensa CRLF: si el caller pasó `filename`, lo usamos
  // sanitizado; si no, basename del path en disco.
  const rawFilename = (typeof extra.filename === 'string' && extra.filename.length > 0)
    ? extra.filename
    : path.basename(filePath);
  const filename = rawFilename.replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 80) || path.basename(filePath);
  const fileData = fs.readFileSync(filePath);

  // `filename` NO debe viajar como form-field aparte: ya está en el Content-Disposition.
  const extraFields = { ...extra };
  delete extraFields.filename;

  let prologue = '';
  // chat_id field
  prologue += `--${boundary}\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n${CHAT_ID}\r\n`;
  // extra fields (caption, parse_mode, etc.)
  for (const [key, val] of Object.entries(extraFields)) {
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

// Recovery al arrancar: los archivos en trabajando/ son huérfanos de un proceso
// que murió antes de completar. Si son recientes (<15 min), reencolar a pendiente.
// Si son viejos (>15 min), descartar a listo/ con marcador — reprocesar un mensaje
// de Telegram de hace horas/días no tiene sentido (incidente 2026-04-24: zombie de 3 días).
const ORPHAN_MAX_AGE_MS = 15 * 60 * 1000;
function recoverOrphans() {
  const orphans = listWorkFiles(TRABAJANDO);
  if (orphans.length === 0) return;
  const now = Date.now();
  let recovered = 0, discarded = 0;
  for (const file of orphans) {
    try {
      const mtime = fs.statSync(file.path).mtimeMs;
      if (now - mtime < ORPHAN_MAX_AGE_MS) {
        fs.renameSync(file.path, path.join(PENDIENTE, file.name));
        recovered++;
      } else {
        const destName = file.name.replace(/\.json$/, '-zombie-descartado.json');
        fs.renameSync(file.path, path.join(LISTO, destName));
        discarded++;
      }
    } catch {}
  }
  if (recovered > 0) log(`Recovery: ${recovered} orphans recientes reencolados a pendiente/`);
  if (discarded > 0) log(`Recovery: ${discarded} zombies viejos (>${ORPHAN_MAX_AGE_MS/60000}min) movidos a listo/ (no se reintentan)`);
}

// #3668 — Procesa un grupo de burst (N>=2 archivos del mismo skill+issue+pid+type
// dentro de la ventana). Mueve cada archivo a trabajando/, manda 1 solo mensaje
// consolidado, y archiva todos los demás a listo/ con suffix
// `-bursted-consolidated.json` para trazabilidad (auditoría no se agrupa, CA-5
// — cada emisor ya escribió su entry JSONL antes de encolar el archivo).
async function processBurstGroup(group, consolidatedText) {
  if (!group || !group.files || group.files.length === 0) return;
  // 1) Mover TODOS los archivos del burst a trabajando/. Lo hacemos primero
  //    para que otro proceso no los tome mientras procesamos el consolidado.
  const trabajandoPaths = [];
  for (const f of group.files) {
    const trabajandoPath = path.join(TRABAJANDO, f.file);
    try {
      fs.renameSync(f.filePath, trabajandoPath);
      trabajandoPaths.push({ name: f.file, path: trabajandoPath });
    } catch {
      // Si otro proceso lo tomó, lo saltamos — el burst queda parcialmente
      // consolidado. NO es ideal pero es mejor que duplicar mensajes.
    }
  }
  if (trabajandoPaths.length === 0) return;

  // 2) Mandar 1 solo mensaje consolidado.
  try {
    const params = { text: consolidatedText, parse_mode: 'MarkdownV2' };
    const chunks = splitLongMessage(consolidatedText);
    for (let i = 0; i < chunks.length; i++) {
      await telegramSend('sendMessage', { ...params, text: chunks[i] });
    }
  } catch (e) {
    log(`Error enviando consolidado de burst (${trabajandoPaths.length} archivos, key=${group.key}): ${e.message}`);
    // Devolver el primer archivo a pendiente/ para reintento; los demás
    // quedan en trabajando/ y los recogerá `recoverOrphans` si pasan >15min.
    if (trabajandoPaths[0]) {
      try { fs.renameSync(trabajandoPaths[0].path, path.join(PENDIENTE, trabajandoPaths[0].name)); } catch {}
    }
    return;
  }

  // 3) Archivar todos los archivos del burst en listo/ con marcador.
  for (let i = 0; i < trabajandoPaths.length; i++) {
    const entry = trabajandoPaths[i];
    const tag = i === 0 ? '-bursted-leader' : '-bursted-consolidated';
    const listoName = entry.name.replace(/\.json$/, `${tag}.json`);
    const listoPath = path.join(LISTO, listoName);
    try { fs.renameSync(entry.path, listoPath); } catch {}
  }
  log(`Consolidado: ${trabajandoPaths.length} mensajes en burst (key=${group.key.split('|').slice(1).join('|')})`);
}

async function processQueue() {
  const files = listWorkFiles(PENDIENTE);
  if (files.length === 0) return;

  // #3668 — Burst grouping previo al sendMessage. Cargamos config + agrupamos.
  // Los grupos de tamaño 1 caen al loop legacy de abajo (envío individual).
  // Los grupos de tamaño >=2 se procesan en `processBurstGroup`.
  const cfgRes = burstGrouper.loadBurstConfig({
    configLoader: loadPipelineConfig,
    log: (_tag, msg) => log(msg),
  });
  const groups = burstGrouper.groupByBurst({
    fileEntries: files,
    windowMs: cfgRes.windowMs,
  });

  const singletonFiles = [];
  for (const g of groups) {
    if (g.key === '__unparseable__' || g.files.length < 2) {
      // 1 archivo o malformado → flujo legacy individual.
      const f = g.files[0];
      if (f && f.filePath) {
        singletonFiles.push({ name: f.file, path: f.filePath });
      }
      continue;
    }
    // Burst real (N>=2) → consolidar.
    const consolidated = burstGrouper.formatConsolidatedMessage(g);
    if (!consolidated) {
      // Defensive: si el formateador devolvió null por algún motivo, caemos
      // al flujo legacy para no perder el mensaje.
      for (const f of g.files) {
        if (f && f.filePath) singletonFiles.push({ name: f.file, path: f.filePath });
      }
      continue;
    }
    await processBurstGroup(g, consolidated);
  }

  for (const file of singletonFiles) {
    const trabajandoPath = path.join(TRABAJANDO, file.name);
    try {
      fs.renameSync(file.path, trabajandoPath);
    } catch { continue; } // otro proceso lo tomó

    try {
      const rawData = JSON.parse(fs.readFileSync(trabajandoPath, 'utf8'));
      // #2334: sanitizar text/caption ANTES de llegar al API de Telegram.
      const data = sanitizeTelegramPayload(rawData);

      // #3540 — multimedia attachments: document/photo/video/animation.
      // Cada rama es estructuralmente idéntica salvo el método Telegram y el
      // nombre del field multipart. CA-UX-EXT-3: pasamos `filename` (si el
      // dropfile lo trae) para que el usuario vea un nombre legible.
      const multipartType = data.document && fs.existsSync(data.document) ? 'document'
        : data.photo && fs.existsSync(data.photo) ? 'photo'
        : data.video && fs.existsSync(data.video) ? 'video'
        : data.animation && fs.existsSync(data.animation) ? 'animation'
        : null;

      if (multipartType) {
        const methodByType = {
          document:  'sendDocument',
          photo:     'sendPhoto',
          video:     'sendVideo',
          animation: 'sendAnimation',
        };
        const extra = {};
        if (data.caption) extra.caption = data.caption;
        if (data.parse_mode) extra.parse_mode = data.parse_mode;
        if (data.filename) extra.filename = data.filename;
        await telegramSendMultipart(
          methodByType[multipartType],
          multipartType,
          data[multipartType],
          extra,
        );
        // CA-SEC-EXT-5 — Telegram bot rate limit por chat ~20 msg/min.
        // Sleep conservador entre envíos de adjuntos para no superar.
        // Solo aplica a multimedia (texto puro queda con la velocidad histórica).
        await new Promise((r) => setTimeout(r, 1200));
      } else if (data.text) {
        // #2921: partir mensajes largos en chunks <= 3500 chars con prefijo (i/N).
        // Telegram API limita sendMessage a 4096; antes se truncaba silenciosamente.
        // #2893: passthrough opcional de reply_markup (inline_keyboard / url buttons)
        // — se adjunta solo al último chunk para que los botones queden al final.
        const parseMode = data.parse_mode || 'Markdown';
        const chunks = splitLongMessage(data.text);
        const hasReplyMarkup = data.reply_markup && typeof data.reply_markup === 'object';
        for (let i = 0; i < chunks.length; i++) {
          const params = { text: chunks[i], parse_mode: parseMode };
          if (hasReplyMarkup && i === chunks.length - 1) {
            params.reply_markup = data.reply_markup;
          }
          await telegramSend('sendMessage', params);
        }
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
  recoverOrphans();
  try { require('./lib/ready-marker').signalReady('svc-telegram'); } catch {}
  while (true) {
    try { await processQueue(); } catch (e) { log(`Error: ${e.message}`); }
    await new Promise(r => setTimeout(r, 5000)); // Poll cada 5 seg
  }
}

// Crash handlers — loguear antes de morir para diagnóstico
const LOG_DIR = path.join(PIPELINE, 'logs');
process.on('uncaughtException', (err) => {
  // #2334: sanitizar antes de persistir el stack a disco (CA6/CA7).
  const msg = sanitize(`[${new Date().toISOString()}] [svc-telegram] CRASH uncaughtException: ${err.stack || err.message}\n`);
  try { fs.appendFileSync(path.join(LOG_DIR, 'svc-telegram.log'), msg); } catch {}
  console.error(msg);
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  const msg = sanitize(`[${new Date().toISOString()}] [svc-telegram] CRASH unhandledRejection: ${reason?.stack || reason}\n`);
  try { fs.appendFileSync(path.join(LOG_DIR, 'svc-telegram.log'), msg); } catch {}
  console.error(msg);
  process.exit(1);
});

// --- SINGLETON ---
require('./singleton')('svc-telegram');
main();
