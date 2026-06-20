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
// CA-3 / RS-3 (#3927): "fallo de envío de CUALQUIER adjunto SIEMPRE notifica".
// Antes el catch del envío individual sólo logueaba y devolvía el archivo a
// pendiente/ → reintento infinito y silencioso. Ahora acotamos los reintentos,
// movemos a fallido/ y emitimos una alerta a Telegram con el error redactado
// (espeja `notifyDriveFailure` de servicio-drive.js).
const { notifyTelegram } = require('./lib/notify-telegram');
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

// #4082 — Config de reintentos de SALIENTES (cola lógica), NO confundir con los
// reintentos de RED de una sola request del http-client. Defaults seguros +
// clamping defensivo: config inválida/ausente nunca rompe el servicio.
const OUTBOUND_DEFAULTS = {
  max_retries: MAX_SEND_RETRIES,
  backoff_base_ms: 5000,
  backoff_max_ms: 300000,
  stale_ttl_ms: 86400000,
  sweep_stagger_ms: 3000,
};
function loadOutboundConfig() {
  const cfg = (loadPipelineConfig() || {}).telegram_outbound || {};
  const num = (v, def, min, max) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n < min || n > max) return def;
    return n;
  };
  return {
    max_retries: num(cfg.max_retries, OUTBOUND_DEFAULTS.max_retries, 1, 100),
    backoff_base_ms: num(cfg.backoff_base_ms, OUTBOUND_DEFAULTS.backoff_base_ms, 100, 600000),
    backoff_max_ms: num(cfg.backoff_max_ms, OUTBOUND_DEFAULTS.backoff_max_ms, 1000, 3600000),
    stale_ttl_ms: num(cfg.stale_ttl_ms, OUTBOUND_DEFAULTS.stale_ttl_ms, 60000, 30 * 86400000),
    sweep_stagger_ms: num(cfg.sweep_stagger_ms, OUTBOUND_DEFAULTS.sweep_stagger_ms, 0, 600000),
  };
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
  try {
    telegramReceipt.writeReceipt(RECIBOS, {
      correlationId: data._correlationId,
      status: telegramReceipt.STATUS_ENVIADO,
      messageIds,
    });
  } catch (e) {
    log(`No se pudo escribir recibo enviado (${data._correlationId}): ${e.message}`);
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
 * Editar el texto de un mensaje ya enviado (#4105 · CA-5). Despacha vía
 * `telegramSend('editMessageText', …)` — mismo patrón seguro que `sendMessage`.
 * Lo usa el camino optimista de Sherlock para CORREGIR una respuesta de TEXTO ya
 * entregada cuando el veredicto background difiere. Un voice note NO es editable:
 * su corrección es siempre un follow-up (ver sherlock-optimistic.decideCorrection).
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
          telegramReceipt.writeReceipt(RECIBOS, {
            correlationId: cur._correlationId,
            status: telegramReceipt.STATUS_FALLIDO,
            messageIds: [],
          });
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
  for (const entry of trabajandoPaths) {
    try {
      const d = JSON.parse(fs.readFileSync(entry.path, 'utf8'));
      if (telegramReceipt.isValidCorrelationId(d._correlationId)) correlationIds.push(d._correlationId);
    } catch { /* ilegible: sin correlationId, sin recibo */ }
  }

  // 2) Mandar 1 solo mensaje consolidado.
  try {
    const params = { text: consolidatedText, parse_mode: 'MarkdownV2' };
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
        const mpBody = await telegramSendMultipart(
          methodByType[multipartType],
          multipartType,
          data[multipartType],
          extra,
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
        const parseMode = data.parse_mode || 'Markdown';
        const chunks = splitLongMessage(data.text);
        const hasReplyMarkup = data.reply_markup && typeof data.reply_markup === 'object';
        // #4082 — SEC-2 fail-closed: validar ok:true + message_id por chunk y
        // acumular los ids (multi-chunk → N ids). Si algún chunk no confirma,
        // `assertDelivered` lanza → cae a handleSendFailure (entrega parcial =
        // fallido, se reintenta el dropfile completo).
        const messageIds = [];
        for (let i = 0; i < chunks.length; i++) {
          const params = { text: chunks[i], parse_mode: parseMode };
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
        // #4105 (CA-5) — corrección de TEXTO del camino optimista de Sherlock:
        // editar un mensaje ya enviado. El payload trae `message_id` + `text`.
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
  // #4105 — wrapper de edición para el camino optimista de Sherlock (CA-5).
  // Exportado para tests `node --test` (dispatch vía telegramSend; no arranca
  // el servicio ni toca red en el test, que inyecta un fake de telegramSend).
  editMessageText,
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
