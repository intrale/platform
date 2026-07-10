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

// Issue #3310 CA-1: sanitizar TODO texto entrante antes de:
//   - escribir el drop a la cola del commander
//   - appendear al historial
//   - loggear en stdout
// Si alguien pega una API key por Telegram, el sanitizer la convierte en
// `[REDACTED:<TIPO>]` antes de que toque disco. Fail-closed: si el sanitizer
// rompe devuelve `[SANITIZER_ERROR:...]`, NUNCA el input original.
const { sanitize } = require('./sanitizer');

// Secrets fuera del repo (ver lib/telegram-secrets.js)
const MAIN_ROOT = process.env.PIPELINE_MAIN_ROOT || path.resolve(__dirname, '..');
const TELEGRAM_CONFIG = path.join(MAIN_ROOT, '.claude', 'hooks', 'telegram-config.json');
const { loadTelegramSecrets } = require('./lib/telegram-secrets');
const health = require('./lib/telegram-health');

function log(msg) {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  console.log(`[${ts}] [listener] ${msg}`);
}

let BOT_TOKEN, CHAT_ID, SECRETS_SOURCE;

// #4579 — Carga de secrets separada del top-level para que el módulo sea
// importable en tests (require() sin arrancar el polling ni salir por falta de
// secrets). En producción se invoca desde el bloque `require.main === module`.
function loadSecretsOrExit() {
  try {
    const sec = loadTelegramSecrets({ legacyConfigPath: TELEGRAM_CONFIG, log });
    BOT_TOKEN = sec.bot_token;
    CHAT_ID = sec.chat_id;
    SECRETS_SOURCE = sec.source;
    log(`Secrets cargados desde: ${SECRETS_SOURCE}`);
  } catch (e) {
    console.error('FATAL: ' + e.message);
    health.markError(PIPELINE, { code: e.code || 'NO_SECRETS', description: e.message, source: 'startup' });
    process.exit(1);
  }
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

// #4579 — Indirección inyectable del transporte Telegram + del operator-gate,
// para poder testear el dispatch de callbacks sin red ni secrets reales. En
// producción apuntan al transporte HTTPS y al singleton del módulo.
const deps = {
  telegramRequest,
  operatorGate: null, // override para tests; null → getDefault() lazy.
};

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

// =============================================================================
// Issue #2904 — /report <seccion>
//
// Pre-handler que intercepta `^/report` ANTES de encolar al Commander. Esto
// nos permite responder en <3s sin pagar la ventana de consolidación de 5s
// del brazoCommander, y disparar `sendChatAction('typing')` apenas llega el
// mensaje (UX-3) para que Leo vea feedback inmediato en el celular.
//
// El módulo `lib/report.js` genera el cuerpo MarkdownV2 (wrapper CLI/in-proc,
// NO skill del Pulpo — vive en `lib/` porque se invoca acá en el mismo proceso
// del listener, no spawneado por el dispatcher de fases).
// Acá nos limitamos a:
//   1. Re-validar autorización chat_id (SR-5 — defense in depth)
//   2. sendChatAction('typing')         (UX-3)
//   3. runReport(section)               (logica deterministica del reporte)
//   4. sendMessage(...) por cada chunk  (CA-7: split a >15 lineas)
//   5. Fallback HTML si MarkdownV2 falla (TR-4)
//   6. Log de auditoria en history      (SR-4)
//
// Carga lazy: el require ocurre la primera vez que un `/report` llega.
// Si el módulo falla al cargar (caso muy borde), degradamos a "encolar al
// commander" — el resto del bot sigue funcionando.
// =============================================================================

let _reportModule = null;
function getReportModule() {
  if (_reportModule === undefined) return null;
  if (_reportModule) return _reportModule;
  try {
    _reportModule = require('./lib/report');
    return _reportModule;
  } catch (e) {
    log(`Error cargando módulo report: ${e.message}`);
    _reportModule = undefined; // no reintentar — degradar al commander
    return null;
  }
}

// Captura `/report` (con o sin argumento). El argumento se limita a chars de
// palabra para evitar ruido — el dispatcher después valida que esté en la
// whitelist (CA-3: subcomando inválido cae al menú de ayuda).
const REPORT_REGEX = /^\s*\/report(?:\s+(\S+))?(?:\s.*)?$/i;

async function sendChatActionTyping() {
  try {
    await telegramRequest('sendChatAction', { chat_id: CHAT_ID, action: 'typing' });
  } catch { /* best-effort — no bloqueante */ }
}

async function sendReportMessage(text) {
  // Intento primario: MarkdownV2.
  try {
    const res = await telegramRequest('sendMessage', {
      chat_id: CHAT_ID,
      text,
      parse_mode: 'MarkdownV2',
      disable_web_page_preview: true,
    });
    if (res && res.ok) return true;
    if (res && !res.ok) {
      log(`MarkdownV2 rechazado por Telegram: ${res.description || 'unknown'} — fallback HTML`);
    }
  } catch (e) {
    log(`Error MarkdownV2: ${e.message} — fallback HTML`);
  }
  // Fallback HTML con <pre>: el report ya viene escapado MD, lo
  // desescapamos y re-envolvemos en <pre> con escape HTML estricto.
  try {
    const reports = require('./lib/telegram-reports');
    const mod = getReportModule();
    if (!mod) throw new Error('report module unavailable for fallback');
    const { html } = mod.buildFallbacks(text);
    await telegramRequest('sendMessage', {
      chat_id: CHAT_ID,
      text: html,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    });
    return true;
  } catch (e) {
    log(`Error fallback HTML: ${e.message}`);
    return false;
  }
}

/**
 * Intenta interceptar el mensaje como `/report`. Devuelve `true` si la
 * intercepción tomó el control (no encolar al Commander), `false` si el
 * mensaje no era un `/report` y debe seguir el flujo normal.
 */
async function maybeHandleReportCommand(msg) {
  const text = (msg && msg.text) || '';
  const match = text.match(REPORT_REGEX);
  if (!match) return false;

  const mod = getReportModule();
  if (!mod) {
    // Degradación: si el skill no carga, dejamos que el commander lo procese
    // como mensaje normal (mejor a no responder).
    return false;
  }

  // SR-5: re-verificar chat autorizado (el caller ya lo hizo en enqueueMessage
  // pero acá agregamos defensa en profundidad).
  if (String(msg.chat?.id) !== String(CHAT_ID)) return true;

  const section = match[1] || '';

  // UX-3: typing indicator inmediato para que Leo vea feedback en mobile.
  await sendChatActionTyping();

  // SR-4: auditoria del comando en history (mismo formato que enqueueMessage).
  appendHistory({
    direction: 'in',
    from: msg.from?.first_name || 'unknown',
    text: `/report ${section}`,
    chat_id: msg.chat.id,
    section,
    handler: 'report',
  });

  try {
    const result = await mod.runReport(section);
    // CA-7: enviar cada chunk como un mensaje separado. Re-emitir typing
    // entre chunks largos (UX-3: refresca el indicador cada ~4s).
    for (let i = 0; i < result.messages.length; i++) {
      if (i > 0) await sendChatActionTyping();
      await sendReportMessage(result.messages[i]);
    }
    // SR-4: registrar la salida.
    appendHistory({
      direction: 'out',
      to: 'telegram',
      handler: 'report',
      section,
      status: result.status,
      chunks: result.messages.length,
    });
  } catch (e) {
    log(`Error procesando /report: ${e.message}`);
    // Si todo falla, mandamos un mensaje plano (sin MD) para que Leo sepa
    // que algo se rompió y no quede esperando.
    try {
      await telegramRequest('sendMessage', {
        chat_id: CHAT_ID,
        text: 'No pude generar el reporte — revisá los logs del listener.',
      });
    } catch { /* best-effort */ }
  }
  return true;
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

// =============================================================================
// #4579 — Canal de firma del operador (callback_query)
//
// El operador toca ✅ Aprobar / ❌ Rechazar / ✏️ Ajustar en Telegram y el
// kernel transiciona el gate `waiting-operator`. Toda la lógica sensible
// (autorización por `from.id`, verificación del token HMAC single-use,
// transición del estado, audit inmutable hash-chained) vive en
// `lib/operator-gate.js` — acá sólo hacemos la I/O de Telegram: responder el
// `answerCallbackQuery` (cortar spinner) y, tras firma exitosa, editar el
// mensaje para quitar los botones consumidos (anti doble-tap visual, CA-10).
//
// Carga lazy: si el módulo no cargara (caso borde), degradamos respondiendo un
// toast genérico — nunca dejamos el spinner colgado ni el bot caído.
// =============================================================================

let _operatorGate = null;
function getOperatorGate() {
  if (deps.operatorGate) return deps.operatorGate; // override de tests
  if (_operatorGate === undefined) return null;
  if (_operatorGate) return _operatorGate;
  try {
    _operatorGate = require('./lib/operator-gate').getDefault();
    return _operatorGate;
  } catch (e) {
    log(`Error cargando operator-gate: ${e.message}`);
    _operatorGate = undefined; // no reintentar
    return null;
  }
}

async function answerCallbackQuery(callbackQueryId, text) {
  try {
    await deps.telegramRequest('answerCallbackQuery', {
      callback_query_id: callbackQueryId,
      // Telegram trunca el toast a ~200 chars; nuestros mensajes son cortos.
      text: (text || '').slice(0, 200),
    });
  } catch (e) {
    log(`Error en answerCallbackQuery: ${e.message}`);
  }
}

async function removeInlineKeyboard(message, footer) {
  const chatId = message?.chat?.id;
  const messageId = message?.message_id;
  const originalText = typeof message?.text === 'string' ? message.text : null;
  const originalCaption = typeof message?.caption === 'string' ? message.caption : null;
  const signedText = footer
    ? `${(originalText || originalCaption || '').trim()}\n\n${footer}`.trim().slice(0, 4096)
    : null;

  // CA-10: tras firma exitosa, quitar los botones y dejar constancia editando el
  // mensaje original. No publicamos un mensaje nuevo para la constancia.
  if (signedText && originalText) {
    try {
      await deps.telegramRequest('editMessageText', {
        chat_id: chatId,
        message_id: messageId,
        text: signedText,
        reply_markup: { inline_keyboard: [] },
      });
      return;
    } catch (e) {
      log(`Error en editMessageText: ${e.message}`);
    }
  }

  if (signedText && originalCaption) {
    try {
      await deps.telegramRequest('editMessageCaption', {
        chat_id: chatId,
        message_id: messageId,
        caption: signedText.slice(0, 1024),
        reply_markup: { inline_keyboard: [] },
      });
      return;
    } catch (e) {
      log(`Error en editMessageCaption: ${e.message}`);
    }
  }

  // Fallback para mensajes sin texto/caption o si Telegram rechaza la edición:
  // al menos deshabilitamos los botones consumidos.
  try {
    await deps.telegramRequest('editMessageReplyMarkup', {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: { inline_keyboard: [] },
    });
  } catch (e) {
    log(`Error en editMessageReplyMarkup: ${e.message}`);
  }
}

async function handleCallbackQuery(cbq) {
  if (!cbq || !cbq.id) return;

  const gate = getOperatorGate();
  if (!gate) {
    // Degradación: cortar el spinner con un toast genérico.
    await answerCallbackQuery(cbq.id, 'Canal de firma no disponible temporalmente');
    return;
  }

  // A01/A07: la autorización se valida DENTRO de operator-gate contra `from.id`
  // (no `chat.id`) + binding tenant→operador server-side. Acá sólo pasamos los
  // datos crudos del callback (tratados como no confiables).
  let result;
  try {
    result = gate.handleSignature({
      operatorId: cbq.from?.id,
      callbackData: cbq.data,
    });
  } catch (e) {
    log(`Error procesando firma: ${e.message}`);
    await answerCallbackQuery(cbq.id, 'No se pudo procesar la firma');
    return;
  }

  // CA-9: answerCallbackQuery en TODOS los caminos (éxito y cada rechazo).
  await answerCallbackQuery(cbq.id, result.toast);

  // CA-10: tras transición exitosa, remover botones y dejar constancia.
  if (result.ok && result.editMessage && cbq.message) {
    const actorName = cbq.from?.first_name || cbq.from?.id || 'operador';
    const hora = new Date().toISOString().replace('T', ' ').slice(0, 16);
    await removeInlineKeyboard(
      cbq.message,
      `🖊️ Firmado por ${actorName} · ${hora} — ${result.toast}`
    );
  }

  // SR-4: auditoría operativa en el history del listener (el audit inmutable
  // hash-chained ya lo hace operator-gate; esto es sólo traza local).
  try {
    appendHistory({
      direction: 'in',
      handler: 'operator-gate',
      from: cbq.from?.first_name || 'unknown',
      from_id: cbq.from?.id,
      ok: !!result.ok,
      action: result.action || null,
      issue: result.issue || null,
      reason: result.reason || null,
    });
  } catch { /* best-effort */ }
}

// --- Enqueue message for Commander ---

// Deduplicación: trackear últimos message_id procesados
const processedMessageIds = new Set();

async function enqueueMessage(update) {
  // #4579 — Canal de firma del operador. Un `callback_query` (toque de botón)
  // NO trae `update.message`, así que sin esta rama caería silenciosamente.
  // Se deriva al handler dedicado y se corta el flujo normal.
  if (update.callback_query) {
    await handleCallbackQuery(update.callback_query);
    return;
  }

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

  // Issue #2904 — Pre-handler `/report`: intercepta antes de encolar al
  // commander para responder en <3s sin ventana de consolidación de 5s.
  // Si el mensaje no es `/report`, sigue el flujo normal.
  try {
    if (await maybeHandleReportCommand(msg)) {
      log(`/report procesado inline (message_id=${msg.message_id})`);
      return;
    }
  } catch (e) {
    log(`Error en pre-handler /report: ${e.message} — cae a flujo normal`);
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

  // Issue #3310 CA-1: sanitizar TEXT y CAPTION antes de persistir. Si el
  // usuario pegó por error una API key (incidente Groq 2026-05-17), acá la
  // redactamos antes de que toque disco — ni cola, ni historial, ni log.
  const rawText = msg.text || caption || '';
  const sanitizedText = sanitize(rawText);

  // Issue #3415 / CA-13 — capturar metadata de voice (file_size, duration)
  // para que el handler de `/rechazar` aplique límites de tamaño/duración
  // ANTES de invocar a whisper-local. Sin estos campos el handler no tiene
  // forma de gatear el audio sin descargarlo primero.
  const voiceMeta = msg.voice || msg.audio || null;
  const content = {
    message_id: msg.message_id,
    from: msg.from?.first_name || 'unknown',
    text: sanitizedText,
    photo: msg.photo ? msg.photo[msg.photo.length - 1]?.file_id : null,
    photo_path: photoPath,
    voice: msg.voice?.file_id || msg.audio?.file_id || null,
    voice_path: voicePath,
    voice_file_size: voiceMeta?.file_size || null,
    voice_duration: voiceMeta?.duration || null,
    date: msg.date
  };

  // Escribir en cola del Commander (texto ya sanitizado).
  const filePath = path.join(COMMANDER_QUEUE, `${id}.json`);
  fs.writeFileSync(filePath, JSON.stringify(content, null, 2));

  // Registrar en historial (texto ya sanitizado).
  appendHistory({ direction: 'in', ...content });

  log(`Mensaje encolado: "${(sanitizedText || '').slice(0, 50)}..." → ${filePath}`);
}

// --- Main polling loop ---

async function pollLoop() {
  let offset = loadOffset();
  log(`Listener iniciado — offset: ${offset}`);
  log(`Chat ID: ${CHAT_ID}`);

  // Probe inicial: getMe valida que el token siga siendo aceptado por Telegram.
  // Si no, marcamos health=error con descripcion para que /ops lo muestre y
  // hacemos backoff hasta que el operador rote el token (no spammear la API).
  try {
    const me = await telegramRequest('getMe', {});
    if (!me.ok) {
      const desc = me.description || 'unknown';
      log(`Telegram getMe RECHAZADO (${me.error_code || '-'}): ${desc}`);
      health.markError(PIPELINE, { code: me.error_code, description: desc, source: 'getMe' });
    } else {
      log(`Bot OK: @${me.result?.username} id=${me.result?.id}`);
      health.markOk(PIPELINE, { bot: me.result?.username, source: SECRETS_SOURCE });
    }
  } catch (e) { log(`Error en getMe inicial: ${e.message}`); }

  await sendMessage('🐙 *Pipeline V2* — Listener activo');
  try { require('./lib/ready-marker').signalReady('listener', { offset }); } catch {}

  // Backoff exponencial cuando Telegram rechaza el token: empieza 5s, hasta 5min.
  let backoffMs = 0;
  let lastErrCode = null;

  while (true) {
    try {
      const result = await telegramRequest('getUpdates', {
        offset,
        timeout: 30,
        // #4579: habilitar `callback_query` para el canal de firma del operador
        // (botones ✅/❌/✏️). Amplía superficie → los callbacks de usuarios/chats
        // no autorizados se descartan en handleCallbackQuery ANTES de procesar.
        allowed_updates: ['message', 'callback_query']
      });

      if (result.ok) {
        if (backoffMs > 0) log(`Telegram OK de nuevo, reseteo backoff`);
        backoffMs = 0;
        lastErrCode = null;
        health.markOk(PIPELINE, { bot: 'reachable', source: SECRETS_SOURCE });
        if (result.result?.length > 0) {
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
      } else {
        // Telegram respondio JSON con ok:false → token rechazado o config invalido.
        // El bug previo era ignorar este path silenciosamente y spammear la API.
        const desc = result.description || 'unknown';
        const code = result.error_code || null;
        if (code !== lastErrCode) {
          log(`Telegram API RECHAZA getUpdates (${code || '-'}): ${desc}`);
          lastErrCode = code;
        }
        health.markError(PIPELINE, { code, description: desc, source: 'getUpdates' });
        backoffMs = Math.min(Math.max(backoffMs * 2, 5000), 5 * 60 * 1000);
        await new Promise(r => setTimeout(r, backoffMs));
      }
    } catch (e) {
      log(`Error en polling: ${e.message}`);
      health.markError(PIPELINE, { code: 'NETWORK', description: e.message, source: 'getUpdates' });
      backoffMs = Math.min(Math.max(backoffMs * 2, 5000), 5 * 60 * 1000);
      await new Promise(r => setTimeout(r, backoffMs));
    }
  }
}

// #4579 — Exports para tests herméticos (dispatch de callbacks sin red). El
// arranque real queda guardado bajo `require.main === module` para no ejecutar
// polling/singleton/secrets al importar el módulo desde un test.
module.exports = {
  enqueueMessage,
  handleCallbackQuery,
  answerCallbackQuery,
  removeInlineKeyboard,
  getOperatorGate,
  deps, // { telegramRequest, operatorGate } — inyectables en tests
};

// --- ARRANQUE (sólo cuando se ejecuta como proceso, no al importar) ---
if (require.main === module) {
  loadSecretsOrExit();

  // --- SINGLETON ---
  require('./singleton')('listener');

  pollLoop().catch(e => { log(`Fatal: ${e.message}`); process.exit(1); });
}
