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
// #5172 — punto único de lectura/validación de `config.yaml`. Este servicio ya
// no hace su propio `yaml.load` ni degrada a `{}` en silencio.
const configResolver = require('./lib/config-resolver');
const configSchema = require('./lib/config-schema');
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
// #5172 — la ruta de `config.yaml` ya no se arma acá: la resuelve el punto único
// a partir de `pipelineDir` (misma raíz `PIPELINE` que usaba este archivo).

// #5172 — Lectura de config por el punto único.
//
// ANTES: `catch { return {} }`. Ese `{}` era indistinguible de una config válida
// sin sección `telegram_*`: el drainer aplicaba defaults sin que NADIE se
// enterara de que el archivo estaba corrupto. Eso es lo que se elimina.
//
// AHORA: el fallo se loguea RUIDOSO (una línea grep-friendly por fallo distinto,
// con detalle y acción ya redactados) y se devuelve `null` — que significa "no
// hay config", NO "config vacía". Los dos consumidores (`resolveOutboundConfig`
// y `burst-grouper`) aplican su default DOCUMENTADO ante `null`.
//
// Por qué acá el fail-closed es LOGUEAR y no propagar (ni `process.exit`): este
// servicio es el ÚNICO transporte por el que el operador se entera de que la
// config está inválida (`#5171` publica esa alerta por esta misma cola). Un
// drainer que se niega a drenar por config inválida se lleva puesto el aviso de
// que la config es inválida. Además lo que este servicio lee del YAML son
// perillas de reintento/burst — no hay ningún gate que se pueda abrir por acá.
let _lastConfigFailureDetail = null;

function loadPipelineConfig() {
  try {
    return configResolver.resolve({ pipelineDir: PIPELINE });
  } catch (e) {
    const estado = configSchema.describeConfigFailure(e, { archivo: e && e.archivo });
    // Anti-spam: el drainer poletea cada 5s; una línea por fallo DISTINTO.
    if (_lastConfigFailureDetail !== estado.detalle) {
      _lastConfigFailureDetail = estado.detalle;
      log(configSchema.formatConfigFailureLog(estado, {
        titulo: 'CONFIG INVÁLIDA — el servicio sigue drenando con los defaults de reintento/burst',
      }));
    }
    return null;
  }
}
const { loadTelegramSecrets } = require('./lib/telegram-secrets');
const health = require('./lib/telegram-health');
// CA-3 / RS-3 (#3927): "fallo de envío de CUALQUIER adjunto SIEMPRE notifica".
// Antes el catch del envío individual sólo logueaba y devolvía el archivo a
// pendiente/ → reintento infinito y silencioso. Ahora acotamos los reintentos,
// movemos a fallido/ y emitimos una alerta a Telegram con el error redactado
// (espeja `notifyDriveFailure` de servicio-drive.js).
const { notifyTelegram, _internal: notifyTelegramInternal } = require('./lib/notify-telegram');
const { redactSensitive, redactSecretValue } = require('./lib/redact');
// #4082 — Bus de recibos cross-proceso. svc-telegram escribe un recibo `enviado`
// (con los message_id que prueban la entrega) o `fallido` ligado por
// `correlationId`; el Commander lo lee y reconcilia el historial. Módulo puro.
const telegramReceipt = require('./lib/telegram-receipt');

const FALLIDO = path.join(QUEUE_DIR, 'fallido');
// #4082 — Carpeta del bus de recibos (servicios/telegram/recibos/).
const RECIBOS = telegramReceipt.receiptsDir(PIPELINE);
// Máximo de intentos de envío antes de mover un dropfile a fallido/. El contador
// se persiste en el propio archivo (`_telegramAttempts`) porque cada fallo lo
// devuelve a pendiente/ y se reprocesa en un ciclo de poll posterior. Margen para
// tolerar fallos transitorios (red/rate-limit) sin loopear para siempre.
// #4082 — Es el DEFAULT/fallback; el valor efectivo sale de `loadOutboundConfig()`
// (config.yaml → telegram_outbound.max_retries). Se mantiene exportado por
// back-compat con tests existentes.
const MAX_SEND_RETRIES = 5;

// #4082 / #4750 — Config de reintentos de SALIENTES (cola lógica), NO confundir
// con los reintentos de RED de una sola request del http-client. La política
// (defaults + clamping) vive ahora en un módulo puro compartido para que el
// sweep de chunks de audio del Commander (#4750) use EXACTAMENTE los mismos
// valores (SEC-R4: no inventar valores nuevos, alinear con #4082).
const { OUTBOUND_DEFAULTS, resolveOutboundConfig } = require('./lib/telegram-outbound-config');
// #5573 — traza append-only de entrega de partes de voz (duplicados + latencia).
const voiceDeliveryAudit = require('./lib/voice-delivery-audit');
function loadOutboundConfig() {
  return resolveOutboundConfig(loadPipelineConfig());
}

function resolvePrivateDestination(requested) {
  return notifyTelegramInternal.resolvePrivateChatId(requested);
}

// #4082 — SEC-2 fail-closed: sin prueba de entrega (`ok:true` + `message_id`) un
// saliente NO se marca enviado. Lanza para caer en `handleSendFailure` (reintento).
function assertDelivered(body, idx, total) {
  if (!body || body.ok !== true || !body.result || body.result.message_id == null) {
    throw new Error(`Telegram respondio ok:false o sin message_id (chunk ${idx + 1}/${total})`);
  }
}

// #4082 — Escribe recibo `enviado` con los message_id que prueban la entrega,
// pero SOLO si el dropfile trae un `_correlationId` válido (los salientes del
// Commander lo traen; las notificaciones internas no — para esas es no-op).
// El recibo NO contiene texto de error ni la URL → no hay superficie de leak
// de BOT_TOKEN (SEC-1). Best-effort: un fallo de escritura del recibo no debe
// revertir una entrega ya confirmada.
function writeSentReceiptIfAny(data, messageIds) {
  if (!data || !telegramReceipt.isValidCorrelationId(data._correlationId)) return;
  const fields = {
    correlationId: data._correlationId,
    status: telegramReceipt.STATUS_ENVIADO,
    messageIds,
  };
  // #4750 — dimensión de CHUNK de audio: si el dropfile trae `_partIndex`/
  // `_partTotal`, se propagan al recibo (nombre `<cid>-p<idx>.json`). Se
  // coercionan/acotan fail-closed (SEC-R2): dims corruptas → NO se escribe el
  // recibo (jamás se deriva un nombre de archivo de un valor sin acotar).
  if (telegramReceipt.hasPartDims({ partIndex: data._partIndex, partTotal: data._partTotal })) {
    if (!telegramReceipt.isValidPartDims(data._partIndex, data._partTotal)) {
      log(`Recibo de chunk con dims inválidas (${data._correlationId}); no se escribe recibo`);
      return;
    }
    fields.partIndex = telegramReceipt.coercePartInt(data._partIndex);
    fields.partTotal = telegramReceipt.coercePartInt(data._partTotal);
  }
  try {
    telegramReceipt.writeReceipt(RECIBOS, fields);
  } catch (e) {
    log(`No se pudo escribir recibo enviado (${data._correlationId}): ${e.message}`);
  }
  // #5573 — traza APPEND-ONLY del envío del chunk. El recibo `<cid>-p<idx>.json`
  // se SOBRESCRIBE en cada envío, así que un reenvío duplicado no dejaba ninguna
  // huella (sólo sobrevivía el último message_id). Acá cada envío suma una línea:
  // más de un evento `sent` para el mismo (correlationId, partIndex) ES un audio
  // que el operador recibió repetido. Best-effort: auditar no rompe la entrega.
  if (fields.partIndex != null) {
    voiceDeliveryAudit.appendVoiceDeliveryEvent(PIPELINE, {
      event: voiceDeliveryAudit.EVENT_SENT,
      correlationId: fields.correlationId,
      partIndex: fields.partIndex,
      partTotal: fields.partTotal,
      messageId: Array.isArray(messageIds) && Number.isFinite(messageIds[0]) ? messageIds[0] : undefined,
      attempt: telegramReceipt.coercePartInt(data._telegramAttempts),
    });
  }
}

function log(msg) {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  console.log(`[${ts}] [svc-telegram] ${msg}`);
}

// #3927: la carga de secrets se hace al arrancar el servicio (no al requerir el
// módulo) para que los tests `node --test` puedan importar las funciones puras
// sin necesitar credenciales ni disparar `process.exit(1)`.
let BOT_TOKEN, CHAT_ID;
function loadSecretsOrExit() {
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
}

// Tag fijo para logs del http-client — permite filtrar denials del servicio.
const AGENT_TAG = 'svc-telegram';

/**
 * #4586 (Palanca 2a) — Normaliza un `message_thread_id` a entero positivo o
 * `null`. Un valor ausente/inválido (0, negativo, NaN, no numérico) devuelve
 * `null` → el mensaje va al General (comportamiento histórico). Defensivo:
 * nunca tira.
 *
 * @param {*} raw
 * @returns {number|null}
 */
function normalizeThreadId(raw) {
  if (raw == null) return null;
  const n = typeof raw === 'number' ? raw : parseInt(String(raw), 10);
  return Number.isInteger(n) && n > 0 ? n : null;
}

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

/**
 * Editar el texto de un mensaje ya enviado. Despacha vía
 * `telegramSend('editMessageText', …)` — mismo patrón seguro que `sendMessage`.
 * Primitiva de transporte genérica. #4139 — el camino optimista de Sherlock que
 * la consumía (corrección diferida de respuestas ya entregadas) fue removido al
 * pasar al flujo síncrono consolidado; la primitiva se conserva como capacidad
 * reutilizable (con su propio test), sin productor activo en el Commander.
 *
 * @param {number|string} chatId   chat destino (Telegram exige chat_id explícito
 *                                  en editMessageText; `telegramSend` ya inyecta
 *                                  el default, pero acá lo pasamos explícito).
 * @param {number}        messageId message_id del mensaje a editar (única prueba
 *                                  de entrega — R1 del bus de recibos #4082).
 * @param {string}        text      nuevo texto (ya saneado por el caller).
 * @param {object}        [extra]   campos extra del API (parse_mode, etc.).
 */
async function editMessageText(chatId, messageId, text, extra = {}, _send = telegramSend) {
  return _send('editMessageText', {
    chat_id: chatId,
    message_id: messageId,
    text,
    ...extra,
  });
}

/** Enviar documento/foto/video/animation via multipart form-data usando http-client seguro.
 *
 * #3540 (CA-UX-EXT-3): el caller puede pasar `extra.filename` para sobreescribir
 * el filename que ve el usuario en Telegram (default: basename del path en disco).
 * El filename declarado por el caller NUNCA se inyecta crudo — se sanitiza
 * `[^A-Za-z0-9._-]+ → '-'` para evitar CRLF injection en el header HTTP.
 */
// #4750 — Constructor PURO del body multipart. Extraído de `telegramSendMultipart`
// para testear la selección de `Content-Type` (voz exige `audio/ogg`) sin red.
// `contentType` se acota a un charset seguro para el header HTTP (defensa CRLF —
// SEC-R2): un valor con caracteres fuera del set cae al octet-stream por default.
function buildMultipartBody({ chatId, fieldName, rawFilename, fileData, extraFields = {}, contentType = 'application/octet-stream' }) {
  const boundary = '----PipelineV2' + Date.now();
  const filename = String(rawFilename || '').replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 80) || 'file';
  const safeContentType = /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/.test(String(contentType))
    ? contentType
    : 'application/octet-stream';

  let prologue = '';
  // chat_id field
  prologue += `--${boundary}\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n${chatId}\r\n`;
  // extra fields (caption, parse_mode, etc.)
  for (const [key, val] of Object.entries(extraFields)) {
    prologue += `--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${val}\r\n`;
  }
  // file field header — Content-Type parametrizado (audio/ogg para voz).
  const fileHeader = `--${boundary}\r\nContent-Disposition: form-data; name="${fieldName}"; filename="${filename}"\r\nContent-Type: ${safeContentType}\r\n\r\n`;
  const fileFooter = `\r\n--${boundary}--\r\n`;

  const body = Buffer.concat([
    Buffer.from(prologue + fileHeader),
    fileData,
    Buffer.from(fileFooter),
  ]);
  return { boundary, body };
}

async function telegramSendMultipart(method, fieldName, filePath, extra = {}, contentType = 'application/octet-stream') {
  // CA-UX-EXT-3 + defensa CRLF: si el caller pasó `filename`, lo usamos
  // sanitizado; si no, basename del path en disco.
  const rawFilename = (typeof extra.filename === 'string' && extra.filename.length > 0)
    ? extra.filename
    : path.basename(filePath);
  const fileData = fs.readFileSync(filePath);

  // `filename` NO debe viajar como form-field aparte: ya está en el Content-Disposition.
  const extraFields = { ...extra };
  delete extraFields.filename;

  const { boundary, body: bodyBuf } = buildMultipartBody({
    chatId: CHAT_ID,
    fieldName,
    rawFilename,
    fileData,
    extraFields,
    contentType,
  });

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

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// #4082 — ¿el dropfile está en período de backoff? Lee `_nextRetryAt` (ISO) y
// devuelve true si todavía no venció. Un archivo ilegible NO se difiere (false):
// el flujo normal lo tomará y lo mandará a fallido/ por malformado. Lectura
// best-effort — cualquier error es "no diferir".
function isRetryDeferred(filePath) {
  try {
    const d = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (d && typeof d._nextRetryAt === 'string') {
      const t = Date.parse(d._nextRetryAt);
      if (Number.isFinite(t) && t > Date.now()) return true;
    }
  } catch { /* ilegible → no diferir */ }
  return false;
}

// CA-3 / RS-3 (#3927): "fallo de envío de CUALQUIER adjunto SIEMPRE notifica
// (nunca más silencio)". Emite una alerta a Telegram cuando un dropfile no se
// pudo enviar de forma terminal. El texto pasa SIEMPRE por `redactSensitive`
// + `redactSecretValue` (RS-3) — nunca volcamos `err.message`/`err.stack` crudo
// al usuario. Espeja `notifyDriveFailure` de servicio-drive.js.
function notifyTelegramFailure(fileName, reason, maxRetries = MAX_SEND_RETRIES) {
  // Guard anti-recursión: el propio `notifyTelegram` escribe un dropfile de texto
  // en esta MISMA cola (`alert-svc-telegram-*.json`). Si esa alerta fallara de
  // forma terminal (p.ej. outage del API de Telegram), notificar de nuevo crearía
  // una cadena infinita de archivos de alerta. Por eso NO re-notificamos el fallo
  // de una alerta generada por nosotros mismos.
  if (typeof fileName === 'string' && fileName.startsWith('alert-svc-telegram')) {
    log(`Fallo terminal de alerta propia ${fileName}; no se re-notifica (anti-recursión)`);
    return false;
  }
  try {
    const safeReason = redactSecretValue(
      redactSensitive(String(reason == null ? 'error desconocido' : reason)),
    );
    notifyTelegram({
      level: 'error',
      component: 'svc-telegram',
      message: `Fallo terminal al enviar un adjunto/mensaje (${fileName}) tras ${maxRetries} intentos: ${safeReason}`,
      context: { archivo: fileName },
    });
    return true;
  } catch (e) {
    log(`No se pudo notificar fallo a Telegram: ${e.message}`);
    return false;
  }
}

// CA-3 (#3927): maneja el fallo de envío de un dropfile individual. Acota los
// reintentos (contador persistido en `_telegramAttempts` dentro del propio
// archivo, porque cada fallo lo devuelve a pendiente/ y se reprocesa en un poll
// posterior) y, al agotarlos —o si el archivo es ilegible/malformado y nunca
// podrá enviarse—, lo mueve a fallido/ y notifica. Retorna 'failed' | 'retry'.
function handleSendFailure(file, trabajandoPath, err) {
  const oc = loadOutboundConfig();
  const maxRetries = oc.max_retries;
  let attempts = 0;
  let cur = null;
  let parsedOk = false;
  try {
    cur = JSON.parse(fs.readFileSync(trabajandoPath, 'utf8'));
    attempts = Number(cur._telegramAttempts) || 0;
    parsedOk = true;
  } catch { /* archivo ilegible o JSON malformado → fallo terminal */ }
  attempts += 1;

  const errMsg = err && err.message ? err.message : String(err);
  // Terminal si agotó los reintentos o si el archivo no se puede ni parsear
  // (reintentarlo infinitamente nunca lo haría enviable).
  const terminal = !parsedOk || attempts >= maxRetries;

  if (terminal) {
    log(`Fallo terminal enviando ${file.name} (intento ${attempts}/${maxRetries}): ${errMsg}`);
    if (parsedOk && cur) {
      try {
        cur._error = errMsg;
        cur._failedAt = new Date().toISOString();
        cur._telegramAttempts = attempts;
        delete cur._nextRetryAt;
        fs.writeFileSync(trabajandoPath, JSON.stringify(cur, null, 2));
      } catch {}
      // #4082 — Recibo `fallido` ligado por correlationId para que el Commander
      // reconcilie el historial a `fallido` (la lógica "ya te respondí" no debe
      // contar un saliente que nunca se entregó). El recibo NO lleva texto de
      // error → cero superficie de leak de BOT_TOKEN (SEC-1).
      if (telegramReceipt.isValidCorrelationId(cur._correlationId)) {
        try {
          const failFields = {
            correlationId: cur._correlationId,
            status: telegramReceipt.STATUS_FALLIDO,
            messageIds: [],
          };
          // #5573 — propagar la dimensión de CHUNK también al recibo `fallido`.
          // Hasta acá el fallo de una parte de audio aterrizaba como `<cid>.json`
          // (nombre de recibo de TEXTO) en vez de `<cid>-p<idx>.json`, así que el
          // reconciliador lo metía en el historial conversacional en lugar de
          // tratarlo como chunk. Misma validación fail-closed que
          // `writeSentReceiptIfAny` (SEC-R2): dims corruptas → se escribe el
          // recibo SIN dims (comportamiento previo), nunca con un valor sin acotar
          // del que se derive un nombre de archivo.
          if (telegramReceipt.hasPartDims({ partIndex: cur._partIndex, partTotal: cur._partTotal })
            && telegramReceipt.isValidPartDims(cur._partIndex, cur._partTotal)) {
            failFields.partIndex = telegramReceipt.coercePartInt(cur._partIndex);
            failFields.partTotal = telegramReceipt.coercePartInt(cur._partTotal);
          }
          telegramReceipt.writeReceipt(RECIBOS, failFields);
        } catch (e) {
          log(`No se pudo escribir recibo fallido (${cur._correlationId}): ${e.message}`);
        }
      }
    }
    ensureDir(FALLIDO);
    try {
      fs.renameSync(trabajandoPath, path.join(FALLIDO, file.name));
    } catch {
      // No se pudo mover a fallido/ — devolver a pendiente para no perder el archivo.
      try { fs.renameSync(trabajandoPath, file.path); } catch {}
    }
    // CA-3: fallo de envío de CUALQUIER adjunto SIEMPRE notifica.
    notifyTelegramFailure(file.name, errMsg, maxRetries);
    return 'failed';
  }

  // #4082 — Reintento con BACKOFF (no reencolado inmediato): el dropfile vuelve a
  // pendiente/ con `_nextRetryAt` futuro; el poll de selección lo saltea hasta
  // que venza. Backoff exponencial escalonado a partir del nº de intento.
  const backoffMs = Math.min(oc.backoff_base_ms * 2 ** (attempts - 1), oc.backoff_max_ms);
  const nextRetryAt = new Date(Date.now() + backoffMs).toISOString();
  log(`Error procesando ${file.name} (intento ${attempts}/${maxRetries}), reintento en ${Math.round(backoffMs / 1000)}s: ${errMsg}`);
  try {
    cur._telegramAttempts = attempts;
    cur._nextRetryAt = nextRetryAt;
    fs.writeFileSync(trabajandoPath, JSON.stringify(cur, null, 2));
  } catch {}
  try { fs.renameSync(trabajandoPath, file.path); } catch {}
  return 'retry';
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

// #4082 (CA-B5) — Barredor one-shot de fallido/ al boot. Los salientes que
// fallaron bajo la lógica vieja (sin backoff, sin confirmación de entrega) se
// reprocesan con la nueva: se reencolan a pendiente/ con `_nextRetryAt`
// ESCALONADO (SEC-3 anti retry-storm → no gatillar HTTP 429) y el contador de
// intentos reseteado para darles un presupuesto limpio. Los `-cmd.json` más
// viejos que `stale_ttl_ms` se DESCARTAN a listo/ con marcador en vez de
// reenviarse fuera de contexto (SEC-4). Best-effort: nunca rompe el arranque.
function sweepFallidoOnce() {
  const oc = loadOutboundConfig();
  const failed = listWorkFiles(FALLIDO);
  if (failed.length === 0) return { requeued: 0, discarded: 0 };
  const now = Date.now();
  let requeued = 0, discarded = 0, idx = 0;
  for (const file of failed) {
    let cur;
    try {
      cur = JSON.parse(fs.readFileSync(file.path, 'utf8'));
    } catch {
      // Ilegible: no se puede reprocesar ni decidir staleness — dejar en fallido/.
      continue;
    }
    // staleness: preferir `_failedAt`, fallback a mtime del archivo.
    let failedAtMs = Date.parse(cur._failedAt || '');
    if (!Number.isFinite(failedAtMs)) {
      try { failedAtMs = fs.statSync(file.path).mtimeMs; } catch { failedAtMs = now; }
    }
    const isCmd = /-cmd\.json$/.test(file.name);
    if (isCmd && (now - failedAtMs) > oc.stale_ttl_ms) {
      // SEC-4: saliente del Commander demasiado viejo → descartar, no reenviar.
      const destName = file.name.replace(/\.json$/, '-stale-descartado.json');
      try { fs.renameSync(file.path, path.join(LISTO, destName)); discarded++; } catch {}
      continue;
    }
    // SEC-3: reencolar con backoff escalonado (idx creciente) y presupuesto limpio.
    cur._telegramAttempts = 0;
    cur._nextRetryAt = new Date(now + (idx + 1) * oc.sweep_stagger_ms).toISOString();
    delete cur._error;
    delete cur._failedAt;
    try {
      fs.writeFileSync(file.path, JSON.stringify(cur, null, 2));
      fs.renameSync(file.path, path.join(PENDIENTE, file.name));
      requeued++;
      idx++;
    } catch { /* no se pudo mover — dejar en fallido/ */ }
  }
  if (requeued > 0) log(`Barredor fallido/: ${requeued} reencolados con backoff escalonado (cada ${oc.sweep_stagger_ms}ms)`);
  if (discarded > 0) log(`Barredor fallido/: ${discarded} salientes stale descartados a listo/ (>${oc.stale_ttl_ms}ms)`);
  return { requeued, discarded };
}

/**
 * #5421 — Resuelve el dialecto de parseo de un saliente de TEXTO.
 *
 * **Por qué existe (y por qué `data.parse_mode || 'Markdown'` era un bug).**
 * El productor (`pulpo.js::sendTelegramWithMarkup`) y este servicio son procesos
 * distintos: el único canal entre ellos es el JSON del dropfile. Cuando el
 * caller pedía texto plano (`opts.plain`), el productor expresaba esa intención
 * OMITIENDO `parse_mode` del payload. Pero "campo ausente" es indistinguible de
 * "el emisor no opinó", y el default de este lado lo reinyectaba como
 * `'Markdown'`. Resultado: `plain:true` no tenía ningún efecto observable — el
 * mensaje se enviaba parseado igual.
 *
 * Eso hacía que un aviso crítico con markup desbalanceado (un `_` de un path, un
 * backtick de un email hostil) se perdiera con HTTP 400, y como el saliente es
 * fire-and-forget el emisor nunca se enteraba. También dejaba sin efecto la
 * defensa anti-inyección del canned de cuota (#2975 CA-13), que dependía del
 * mismo flag.
 *
 * El fix es hacer la intención EXPLÍCITA en el payload (`plain: true`) para que
 * sobreviva el cruce de proceso, en vez de codificarla como una ausencia.
 * Retrocompatible: un dropfile viejo sin `plain` conserva el default histórico.
 *
 * @param {object} data — payload del dropfile.
 * @returns {string|null} dialecto, o `null` si el mensaje va SIN `parse_mode`.
 */
function resolveOutboundParseMode(data) {
  if (!data || typeof data !== 'object') return 'Markdown';
  // Declaración explícita de texto plano: gana sobre cualquier otra cosa.
  if (data.plain === true) return null;
  return data.parse_mode || 'Markdown';
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

  // #4082 — Recolectar correlationIds del grupo: un burst consolida N salientes,
  // y cada uno puede traer su `_correlationId`. Al confirmar la entrega del
  // consolidado emitimos un recibo `enviado` por cada uno.
  const correlationIds = [];
  // #4586 (Palanca 2a) — thread/topic del burst consolidado. Solo se aplica si
  // TODOS los archivos del grupo comparten el mismo `message_thread_id` (los
  // entregables comparten el mismo hilo configurado). Si el grupo mezcla hilos
  // distintos o alguno no tiene hilo, se omite (va al General) — nunca postea un
  // consolidado en un hilo ajeno.
  const threadIds = new Set();
  for (const entry of trabajandoPaths) {
    try {
      const d = JSON.parse(fs.readFileSync(entry.path, 'utf8'));
      if (telegramReceipt.isValidCorrelationId(d._correlationId)) correlationIds.push(d._correlationId);
      threadIds.add(normalizeThreadId(d.message_thread_id));
    } catch { /* ilegible: sin correlationId, sin recibo */ }
  }
  const burstThreadId = (threadIds.size === 1) ? [...threadIds][0] : null;

  // 2) Mandar 1 solo mensaje consolidado.
  try {
    const params = { text: consolidatedText, parse_mode: 'MarkdownV2' };
    if (burstThreadId != null) params.message_thread_id = burstThreadId;
    const chunks = splitLongMessage(consolidatedText);
    // #4082 — SEC-2 fail-closed: validar ok:true + message_id por chunk.
    const messageIds = [];
    for (let i = 0; i < chunks.length; i++) {
      const body = await telegramSend('sendMessage', { ...params, text: chunks[i] });
      assertDelivered(body, i, chunks.length);
      messageIds.push(body.result.message_id);
    }
    // #4082 — Entrega confirmada: recibo `enviado` por cada correlationId del grupo.
    for (const cid of correlationIds) {
      try {
        telegramReceipt.writeReceipt(RECIBOS, {
          correlationId: cid,
          status: telegramReceipt.STATUS_ENVIADO,
          messageIds,
        });
      } catch (e) {
        log(`No se pudo escribir recibo enviado de burst (${cid}): ${e.message}`);
      }
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

// #4796 — Tipos de adjunto que se envían por multipart (ruta a un archivo en
// disco). El orden fija la precedencia de resolución (document > … > voice),
// igual que la cadena ternaria histórica.
const ATTACHMENT_TYPES = ['document', 'photo', 'video', 'animation', 'voice'];

// #4796 — Directorio base allowlisted para adjuntos de tipo `voice` (audio TTS).
// El productor (`pulpo.dispatchVoiceParts`) genera los `.ogg` en `logs/media/`
// (`path.join(LOG_DIR, 'media')`, con `LOG_DIR = path.join(PIPELINE, 'logs')`).
// Cualquier ruta de voz que tras normalizar/canonizar NO caiga bajo este dir se
// rechaza (fail-closed) para no leer/exfiltrar archivos arbitrarios — un path
// "reconstruido" jamás debe resolver a `~/.claude/secrets/*` o `application.conf`
// y terminar subido a Telegram (OWASP A01/A08).
function mediaBaseDir() {
  return path.join(PIPELINE, 'logs', 'media');
}

// #4796 — ¿`target` (canónico) cae bajo `base` (canónico)? Usa path.relative:
// si el relativo empieza con `..` o es absoluto, target está FUERA de base.
// `''` (target === base, o sea el propio dir) también se considera fuera (un
// adjunto nunca es el directorio base).
function isUnderBase(base, target) {
  const rel = path.relative(base, target);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

// #4796 — Devuelve los tipos de adjunto DECLARADOS en el dropfile (key presente),
// sin importar si la ruta resuelve. Sirve para la guarda fail-closed: un dropfile
// que declara `voice` pero cuyo archivo no existe NO debe caer al cierre optimista.
function declaredAttachmentTypes(data) {
  if (!data || typeof data !== 'object') return [];
  return ATTACHMENT_TYPES.filter((t) => data[t] != null);
}

// #4796 — Normaliza la ruta de un adjunto y, SOLO para `voice`, valida
// canonical-prefix contra el dir base allowlisted antes de tocar el archivo.
//
// Normalización: unifica separadores `\` → `/` y colapsa con `path.normalize`.
// NO reinserta separadores perdidos (imposible sin heurística que podría resolver
// a un archivo distinto — vector de exfiltración): una ruta cuyos separadores ya
// se perdieron (`C:WorkspacesIntrale…ogg`) simplemente NO existirá → se devuelve
// null → la guarda fail-closed la enruta a `handleSendFailure` (nunca silencio).
//
// Retorno:
//   - string  → ruta canónica segura y existente (usar ESTA para enviar).
//   - null    → la ruta no resuelve a un archivo existente.
//   - LANZA   → (voice) la ruta resuelve FUERA del allowlist → exfiltración; el
//               caller la enruta a `handleSendFailure` (fallo explícito).
function resolveAttachmentPath(type, rawPath) {
  if (typeof rawPath !== 'string' || rawPath.length === 0) return null;
  const normalized = path.normalize(rawPath.replace(/\\/g, '/'));
  if (!fs.existsSync(normalized)) return null;
  if (type === 'voice') {
    // Canonizar ambos lados (resuelve symlinks/`..`) y comparar prefijo.
    const base = fs.realpathSync(mediaBaseDir());
    const real = fs.realpathSync(normalized);
    if (!isUnderBase(base, real)) {
      throw new Error(
        `Ruta de adjunto voice fuera del dir permitido (rechazada por seguridad); esperada bajo ${base}`,
      );
    }
    return real;
  }
  return normalized;
}

// #4796 — Decisión pura fail-closed: ¿debe LANZARSE el envío porque el dropfile
// declaró un adjunto pero ninguno resolvió a un archivo real y no hay respaldo
// (texto / edición)? Cierra el hueco del solo-audio: antes, `multipartType===null`
// sin `data.text` caía al cierre optimista (`renameSync → listo/` + log "Enviado")
// sin haber enviado nada. Ahora → throw → `handleSendFailure`.
function shouldFailClosed(data, multipartType) {
  if (multipartType) return false;                 // se resolvió y se envía
  if (!data || typeof data !== 'object') return false;
  if (data.text) return false;                     // hay texto de respaldo (sendMessage)
  if (data.method === 'editMessageText' && Number.isFinite(data.message_id)) return false;
  return declaredAttachmentTypes(data).length > 0; // adjunto declarado sin archivo
}

async function processQueue() {
  const allFiles = listWorkFiles(PENDIENTE);
  if (allFiles.length === 0) return;

  // #4082 — Backoff: excluir dropfiles cuyo `_nextRetryAt` sea futuro ANTES de
  // agrupar/procesar. Se filtra acá (no sólo en el loop de singletons) porque dos
  // `-cmd.json` reencolados podrían compartir clave de burst (`unknown|...`) y un
  // burst-group bypassearía la ventana de reintento.
  const files = allFiles.filter((f) => !isRetryDeferred(f.path));
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
      // #4750 — rama `voice`: el audio TTS se enruta por la cola (Opción A) para
      // heredar `assertDelivered` (fail-closed) + `writeSentReceiptIfAny` con la
      // dimensión de chunk. Telegram exige OGG/OPUS para `sendVoice`.
      // #4796 — Normalización de separadores + canonical-prefix allowlist (voice)
      // ANTES del envío. Resolvemos la ruta REAL (canónica) del primer adjunto
      // declarado que exista; se envía ESA, no la cruda del dropfile. Una ruta
      // de voz que resuelve fuera del allowlist LANZA → cae a handleSendFailure.
      const declaredAttach = declaredAttachmentTypes(data);
      let multipartType = null;
      let resolvedAttachPath = null;
      for (const t of declaredAttach) {
        const resolved = resolveAttachmentPath(t, data[t]); // lanza si voice fuera de allowlist
        if (resolved) { multipartType = t; resolvedAttachPath = resolved; break; }
      }

      if (multipartType) {
        const methodByType = {
          document:  'sendDocument',
          photo:     'sendPhoto',
          video:     'sendVideo',
          animation: 'sendAnimation',
          voice:     'sendVoice',
        };
        // #4750 — Content-Type por tipo: `sendVoice` requiere `audio/ogg`
        // declarado; el resto conserva el default `application/octet-stream`
        // (retrocompatible con document/photo/video/animation).
        const contentTypeByType = { voice: 'audio/ogg' };
        const extra = {};
        if (data.caption) extra.caption = data.caption;
        if (data.parse_mode) extra.parse_mode = data.parse_mode;
        if (data.filename) extra.filename = data.filename;
        // #4586 (Palanca 2a) — hilo/topic separado para el firehose de
        // entregables. Solo se adjunta si el dropfile lo trae y es entero>0.
        const mpThreadId = normalizeThreadId(data.message_thread_id);
        if (mpThreadId != null) extra.message_thread_id = mpThreadId;
        const mpBody = await telegramSendMultipart(
          methodByType[multipartType],
          multipartType,
          resolvedAttachPath, // #4796 — ruta canónica resuelta (no la cruda del dropfile)
          extra,
          contentTypeByType[multipartType] || 'application/octet-stream',
        );
        // #4082 — SEC-2 fail-closed: el multipart también valida ok:true antes de
        // dar por entregado (antes aceptaba cualquier respuesta sin excepción).
        assertDelivered(mpBody, 0, 1);
        writeSentReceiptIfAny(data, [mpBody.result.message_id]);
        // CA-SEC-EXT-5 — Telegram bot rate limit por chat ~20 msg/min.
        // Sleep conservador entre envíos de adjuntos para no superar.
        // Solo aplica a multimedia (texto puro queda con la velocidad histórica).
        await new Promise((r) => setTimeout(r, 1200));
      } else if (data.text) {
        // #2921: partir mensajes largos en chunks <= 3500 chars con prefijo (i/N).
        // Telegram API limita sendMessage a 4096; antes se truncaba silenciosamente.
        // #2893: passthrough opcional de reply_markup (inline_keyboard / url buttons)
        // — se adjunta solo al último chunk para que los botones queden al final.
        // #5421 — `null` ⇒ el saliente va SIN `parse_mode` (texto plano).
        const parseMode = resolveOutboundParseMode(data);
        const chunks = splitLongMessage(data.text);
        const hasReplyMarkup = data.reply_markup && typeof data.reply_markup === 'object';
        // #4586 (Palanca 2a) — hilo/topic separado para el firehose de
        // entregables. Se aplica a todos los chunks del mismo mensaje.
        const textThreadId = normalizeThreadId(data.message_thread_id);
        const privateDestination = resolvePrivateDestination(data.chat_id);
        if (!privateDestination.ok) {
          log(`Aviso privado omitido: ${privateDestination.reason}`);
          fs.renameSync(trabajandoPath, path.join(LISTO, file.name));
          continue;
        }
        // #4082 — SEC-2 fail-closed: validar ok:true + message_id por chunk y
        // acumular los ids (multi-chunk → N ids). Si algún chunk no confirma,
        // `assertDelivered` lanza → cae a handleSendFailure (entrega parcial =
        // fallido, se reintenta el dropfile completo).
        const messageIds = [];
        for (let i = 0; i < chunks.length; i++) {
          // #5421 — sólo se adjunta `parse_mode` si hay dialecto. En texto plano
          // el campo NO viaja, así que no hay nada que Telegram pueda rechazar.
          const params = { text: chunks[i] };
          if (parseMode) params.parse_mode = parseMode;
          if (privateDestination.chatId != null) params.chat_id = privateDestination.chatId;
          if (textThreadId != null) params.message_thread_id = textThreadId;
          if (hasReplyMarkup && i === chunks.length - 1) {
            params.reply_markup = data.reply_markup;
          }
          const body = await telegramSend('sendMessage', params);
          assertDelivered(body, i, chunks.length);
          messageIds.push(body.result.message_id);
        }
        // #4082 — Entrega confirmada: recibo `enviado` si el saliente trae
        // correlationId (los del Commander lo traen).
        writeSentReceiptIfAny(data, messageIds);
      } else if (data.method === 'editMessageText' && Number.isFinite(data.message_id)) {
        // #4139 — rama de edición genérica de un mensaje ya enviado (payload con
        // `message_id` + `text`). El productor del camino optimista de Sherlock fue
        // removido; la rama se conserva como capacidad de transporte reutilizable.
        // SEC-2 fail-closed: validar ok:true antes de dar por hecha la edición.
        const editBody = await editMessageText(
          CHAT_ID,
          data.message_id,
          data.text,
          data.parse_mode ? { parse_mode: data.parse_mode } : {},
        );
        assertDelivered(editBody, 0, 1);
        // El edit devuelve el mismo message_id; escribimos recibo `enviado` para
        // que el reconciliador del Commander cierre el correlationId del edit.
        writeSentReceiptIfAny(data, [editBody.result.message_id]);
      } else if (shouldFailClosed(data, multipartType)) {
        // #4796 — Guarda fail-closed: el dropfile DECLARÓ un adjunto (p.ej.
        // solo-audio `voice`) pero ninguno resolvió a un archivo real y no hay
        // texto/edición de respaldo. Antes esto caía al cierre optimista de abajo
        // (`renameSync → listo/` + log "Enviado") sin haber enviado NADA a Telegram
        // — descarte silencioso (incidente 2026-07-19). Ahora lanzamos para caer en
        // el `catch` → `handleSendFailure` (reintento acotado → fallido/ → alerta).
        // Log con ruta esperada + motivo (sin volcar contenido ni secrets — CA-3).
        const declaredPaths = declaredAttach.map((t) => `${t}=${data[t]}`).join(', ');
        throw new Error(
          `Adjunto declarado sin archivo resoluble (${declaredPaths}); no se marca "Enviado"`,
        );
      }

      const listoPath = path.join(LISTO, file.name);
      fs.renameSync(trabajandoPath, listoPath);
      log(`Enviado: ${file.name}`);
    } catch (e) {
      // CA-3 (#3927): reintento acotado; al agotarlo el adjunto/mensaje se mueve
      // a fallido/ y se notifica (nunca más silencio ni loop infinito).
      handleSendFailure(file, trabajandoPath, e);
    }
  }
}

// Main loop
async function main() {
  log('Servicio Telegram iniciado');
  recoverOrphans();
  // #4082 (CA-B5) — reprocesar los fallidos heredados con la nueva lógica
  // (backoff escalonado + descarte de stale). One-shot al boot.
  try { sweepFallidoOnce(); } catch (e) { log(`Barredor fallido/ falló (best-effort): ${e.message}`); }
  try { require('./lib/ready-marker').signalReady('svc-telegram'); } catch {}
  while (true) {
    try { await processQueue(); } catch (e) { log(`Error: ${e.message}`); }
    await new Promise(r => setTimeout(r, 5000)); // Poll cada 5 seg
  }
}

// #3927: exportamos las funciones puras del path de fallo para el test
// `node --test`. Sin esto, requerir el módulo arrancaría el servicio (carga de
// secrets con `process.exit` si faltan, singleton + loop infinito), colgando o
// matando el runner. Espeja el patrón ya aplicado a servicio-drive.js.
module.exports = {
  handleSendFailure,
  notifyTelegramFailure,
  MAX_SEND_RETRIES,
  // #4082 — expuestos para tests `node --test` (funciones puras del path de
  // reintento/barredor; no arrancan el servicio ni tocan red).
  loadOutboundConfig,
  sweepFallidoOnce,
  isRetryDeferred,
  assertDelivered,
  writeSentReceiptIfAny,
  RECIBOS,
  // #4750 — constructor puro del body multipart (test de Content-Type audio/ogg).
  buildMultipartBody,
  // #4139 — wrapper de edición de mensajes (primitiva genérica). Exportado para
  // tests `node --test` (dispatch vía telegramSend; no arranca el servicio ni
  // toca red en el test, que inyecta un fake de telegramSend).
  editMessageText,
  // #4586 (Palanca 2a) — normalizador de message_thread_id, expuesto para tests.
  normalizeThreadId,
  // #5421 — resolutor del dialecto del saliente (puro). Expuesto para el test
  // que fija que `plain:true` produce envío SIN `parse_mode`.
  resolveOutboundParseMode,
  resolvePrivateDestination,
  // #4796 — helpers de normalización/allowlist de rutas de adjunto + guarda
  // fail-closed del solo-audio. Puros (o I/O acotado sobre disco); no arrancan el
  // servicio ni tocan red. Expuestos para `node --test`.
  resolveAttachmentPath,
  declaredAttachmentTypes,
  shouldFailClosed,
  isUnderBase,
  mediaBaseDir,
};

// Arranque del servicio: SOLO cuando se ejecuta directamente (`node servicio-telegram.js`),
// nunca al ser requerido como módulo desde un test.
if (require.main === module) {
  loadSecretsOrExit();

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
}
