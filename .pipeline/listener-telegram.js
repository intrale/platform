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
  // #4780 — commander product-aware; override para tests, null → lazy build.
  productCommander: null,
  // #4780 — ejecutor de la acción product-aware ya autorizada+confirmada.
  productExecutor: null,
  // #4802 — router de callbacks inline del Commander; override para tests,
  // null → getCommanderRouter() lazy (init con adapter Telegram + cola).
  commanderRouter: null,
};

async function sendMessage(text) {
  try {
    // Vía `deps.telegramRequest` (no el binding crudo) para inyectabilidad en
    // tests y consistencia con answerCallbackQuery/sendProductConfirmation.
    await deps.telegramRequest('sendMessage', {
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

// =============================================================================
// #4780 — Commander product-aware (Ola Puente P6). Seam de autorización por
// producto para acciones destructivas NL. La lógica sensible (allowlist cerrada,
// authz por `from.id`, confirmación anti-TOCTOU, rechazo uniforme, audit
// tamper-evident) vive en `lib/commander/product-*.js`. Acá sólo construimos el
// registry/commander product-aware (lazy, best-effort) con el binding
// server-side de `config.yaml → commander_products` y el operador único
// histórico (`CHAT_ID`) como default retro-compatible (SR-6).
//
// NO cambia el gate `chat.id` de enqueue (retro-compat exacta): es el punto de
// integración que el handler NL del Commander consume para resolver producto +
// autorizar acciones destructivas sin reinventar authz.
// =============================================================================
let _productCommander = null;
function getProductCommander() {
  if (deps.productCommander) return deps.productCommander; // override de tests
  if (_productCommander === undefined) return null;
  if (_productCommander) return _productCommander;
  try {
    const { loadProductRegistry } = require('./lib/commander/product-registry-loader');
    const { createProductCommander } = require('./lib/commander/product-command');
    const { createProductAudit } = require('./lib/commander/audit-log');
    const registry = loadProductRegistry({ pipelineDir: PIPELINE, defaultOperator: CHAT_ID });
    const audit = createProductAudit({
      file: path.join(PIPELINE, 'audit', 'commander-product-actions.jsonl'),
    });
    _productCommander = createProductCommander({ registry, audit });
    return _productCommander;
  } catch (e) {
    log(`Error cargando commander product-aware: ${e.message}`);
    _productCommander = undefined; // no reintentar — degradar
    return null;
  }
}

// =============================================================================
// #4802 — Ruteo de callbacks inline del Commander desde el listener.
//
// EL GAP QUE CIERRA: el listener (poller único) enrutaba TODO `callback_query`
// no-`pc:`/`pcx:` a `operator-gate` (canal de firma GATE 2). Los botones del
// Commander (propuestas, permisos allow/deny, restart, sprint, reactivación,
// relanzar skill, tts_listen, show_detail) usan namespaces DISJUNTOS, así que
// `operator-gate.resolve()` devolvía null → toast "Acción inválida o expirada".
// `callback-handler.routeCallback` existía exportado pero NINGÚN consumidor lo
// invocaba (el poller lo consumía del getUpdates y lo rechazaba como firma).
//
// POR QUÉ ACÁ (y no un segundo poller): sólo `listener-telegram.js` hace
// `getUpdates` (invariante verificada por `test-p03-no-getupdates.js`). El fix
// reenvía el callback IN-PROCESS al `routeCallback` del Commander.
//
// PROCESO SEPARADO: el listener corre como servicio propio (restart.js) sin el
// dispatcher de pulpo. `callback-handler` exige `init()` con tgApi + dispatcher +
// cmdContext + skills. Acá construimos un adapter: Telegram I/O real (el listener
// tiene token+chatId) para las acciones puramente de mensajería (permisos,
// reactivación, edición de propuestas, restart_log), y un dispatcher/cmdContext
// que ENCOLA el comando equivalente en la cola del Commander para las acciones
// que requieren spawn (propuestas→/historia, restart_retry, relaunch_skill). Sin
// segundo poller, sin tocar pulpo. Lazy + fail-safe: si el init falla, degradamos
// a un toast — el listener NUNCA se cae (rule #1: el pipeline no puede morir).
// =============================================================================
let _commanderRouter = null;

// Reusa la MISMA fuente de allowlist que operator-gate (no inventar segunda
// fuente): `TELEGRAM_LEO_OPERATOR_CHAT_ID`. Fail-closed si no carga.
function resolveCommanderAllowlist() {
  try {
    const { resolveOperatorAllowlist } = require('./lib/operator-gate');
    return resolveOperatorAllowlist();
  } catch (e) {
    log(`No se pudo resolver allowlist del commander: ${e.message}`);
    return new Set();
  }
}

function _escHtmlCommander(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Encola un comando NL/slash en la cola del Commander (mismo mecanismo que
// `enqueueMessage`) para que pulpo lo procese con contexto completo.
function enqueueCommanderCommand(text) {
  try {
    fs.mkdirSync(COMMANDER_QUEUE, { recursive: true });
  } catch { /* best-effort */ }
  const id = `${Date.now()}-cbcmd`;
  const content = {
    message_id: id,
    from: 'commander-callback',
    text: String(text || ''),
    date: Math.floor(Date.now() / 1000),
  };
  fs.writeFileSync(path.join(COMMANDER_QUEUE, `${id}.json`), JSON.stringify(content, null, 2));
  log(`Comando de callback encolado al commander: "${String(text).slice(0, 50)}"`);
}

// Adapter Telegram para callback-handler. Las acciones de mensajería pura
// (answerCallbackQuery, editMessageText/ReplyMarkup, sendMessage) funcionan de
// verdad; las multimedia (voz/foto) degradan a texto (no bloquean el botón).
function buildCommanderTgApi() {
  return {
    getChatId: () => CHAT_ID,
    escHtml: _escHtmlCommander,
    telegramPost: (method, params) => deps.telegramRequest(method, params),
    sendMessage: (html) => deps.telegramRequest('sendMessage', {
      chat_id: CHAT_ID, text: html, parse_mode: 'HTML',
    }),
    sendLongMessage: (html) => deps.telegramRequest('sendMessage', {
      chat_id: CHAT_ID, text: String(html).slice(0, 4096), parse_mode: 'HTML',
    }),
    sendVoiceMessage: async () => {
      log('tts_listen no soportado desde el listener — degradando sin audio');
    },
    sendTelegramPhoto: (img, caption) => deps.telegramRequest('sendMessage', {
      chat_id: CHAT_ID, text: caption || '📋 Detalle', parse_mode: 'HTML',
    }),
  };
}

// Carga best-effort de la metadata de skills (para relaunch_skill / model /
// allowedTools). Si falla, `[]` y relaunch degrada a "skill no encontrado".
function loadCommanderSkills() {
  try {
    const skillsMeta = require('./lib/skills-metadata');
    const skillsRoot = path.join(MAIN_ROOT, '.claude', 'skills');
    const { registry } = skillsMeta.loadAllSkillsMetadata({ skillsRoot });
    return Object.keys(registry || {}).map((name) => {
      const m = registry[name] || {};
      return { name, model: m.model || null, allowedTools: m['allowed-tools'] || m.allowedTools || null };
    });
  } catch (e) {
    log(`No se pudieron cargar skills para el commander: ${e.message}`);
    return [];
  }
}

function getCommanderRouter() {
  if (deps.commanderRouter) return deps.commanderRouter; // override de tests
  if (_commanderRouter === undefined) return null;       // falló antes — no reintentar
  if (_commanderRouter) return _commanderRouter;
  try {
    const mod = require('../.claude/hooks/commander/callback-handler');
    const hooksDir = path.join(MAIN_ROOT, '.claude', 'hooks');
    mod.init({
      tgApi: buildCommanderTgApi(),
      cmdContext: {
        // El /historia de una propuesta se encola como comando del Commander.
        executeClaudeQueued: async (prompt) => { enqueueCommanderCommand(prompt); return { ok: true, queued: true, text: '' }; },
        sendResult: async () => { /* el comando encolado produce su propia salida */ },
      },
      log: (m) => log(`[commander-cb] ${m}`),
      repoRoot: MAIN_ROOT,
      hooksDir,
      proposalsFile: path.join(hooksDir, 'planner-proposals.json'),
      sprintPlanFile: path.join(MAIN_ROOT, 'scripts', 'sprint-plan.json'),
      skills: loadCommanderSkills(),
      dispatcher: {
        handleRestart: async () => { enqueueCommanderCommand('/restart'); },
        handleSkill: async (skill, arg) => { enqueueCommanderCommand('/' + skill.name + (arg ? ' ' + arg : '')); },
      },
      permissionSuggester: null,
    });
    _commanderRouter = mod;
    return _commanderRouter;
  } catch (e) {
    log(`Error cargando commander callback-handler: ${e.message}`);
    _commanderRouter = undefined; // degradar — no reintentar
    return null;
  }
}

// =============================================================================
// #4780 — Pre-handler determinístico de comandos NL destructivos product-aware
//
// EL GAP QUE CIERRA (rechazo PO rev-1): los primitivos product-aware existían
// como biblioteca testeada pero NINGÚN consumidor los invocaba en runtime. El
// NL destructivo ("pausá X") caía al gate global `chat.id` + commander LLM, sin
// authz por `from.id`, sin confirmación anti-TOCTOU, sin audit hash-chain.
//
// POR QUÉ ACÁ (y no en `servicio-telegram.js`): `servicio-telegram.js` es el
// sender OUTBOUND (drena `servicios/telegram/pendiente/`). El NL INBOUND llega
// al listener (long-poll → `enqueueMessage`). El punto de integración
// equivalente para "NL → intent acotado con confirmación" (receta del
// arquitecto) es este pre-handler, hermano del pre-handler `/report` (#2904):
// intercepta ANTES de encolar al commander LLM y de forma DETERMINISTICA
// (SR-3/SR-4 fail-closed, jamás delegado al LLM).
//
// ALCANCE: intercepta sólo control de pipeline product-level (`pause`/`resume`),
// las acciones con ejecución real hoy. `approve`/`reject`/`sign` son por-issue
// (canal `operator-gate` con botones, ya seguro) y NO se interceptan acá. Todo
// el músculo de seguridad (allowlist cerrada, injection, scope-widening, authz,
// rechazo uniforme, audit) vive en `lib/commander/product-command.js`.
// =============================================================================

// Comandos que este pre-handler OWNea en runtime (ejecución real disponible).
const RUNTIME_DESTRUCTIVE = new Set(['pause', 'resume']);

let _productCmdHelpers = null;
function getProductCmdHelpers() {
  if (_productCmdHelpers === undefined) return null;
  if (_productCmdHelpers) return _productCmdHelpers;
  try {
    const pc = require('./lib/commander/product-command');
    const { detectInjection } = require('./lib/handoff');
    _productCmdHelpers = {
      classifyCommand: pc.classifyCommand,
      normalizeText: pc.normalizeText,
      SCOPE_WIDENING_RE: pc.SCOPE_WIDENING_RE,
      UNIFORM_REJECT: pc.UNIFORM_REJECT,
      detectInjection,
    };
    return _productCmdHelpers;
  } catch (e) {
    log(`Error cargando helpers product-command: ${e.message}`);
    _productCmdHelpers = undefined; // no reintentar — degradar al commander
    return null;
  }
}

let _productExecutor = null;
function getProductExecutor() {
  if (deps.productExecutor) return deps.productExecutor; // override de tests
  if (_productExecutor === undefined) return null;
  if (_productExecutor) return _productExecutor;
  try {
    const { createProductExecutor } = require('./lib/commander/product-executor');
    _productExecutor = createProductExecutor({});
    return _productExecutor;
  } catch (e) {
    log(`Error cargando product-executor: ${e.message}`);
    _productExecutor = undefined; // no reintentar — degradar
    return null;
  }
}

// Envía el prompt de confirmación destructiva con botones inline. El `confirmId`
// (nonce opaco con el productId bindeado server-side, SR-2) viaja en el
// `callback_data` — 3+32 = 35 bytes, holgado bajo el límite de 64 de Telegram.
async function sendProductConfirmation(parsed) {
  await deps.telegramRequest('sendMessage', {
    chat_id: CHAT_ID,
    text: parsed.response,
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [[
        { text: '✅ Confirmar', callback_data: `pc:${parsed.confirmId}` },
        { text: '✖️ Cancelar', callback_data: `pcx:${parsed.confirmId}` },
      ]],
    },
  });
}

/**
 * Intenta OWNear el mensaje como comando NL destructivo product-aware. Devuelve
 * `true` si tomó el control (no encolar al commander LLM), `false` para caer al
 * flujo normal. Fail-open a `false` en cualquier error de carga (degradación).
 */
async function maybeHandleProductCommand(msg) {
  const text = (msg && (msg.text || msg.caption)) || '';
  if (!text) return false;

  const helpers = getProductCmdHelpers();
  if (!helpers) return false; // degradar → commander LLM

  // Gate barato: sólo OWNeamos comandos de control con ejecución real. Cualquier
  // otra cosa (conversación, status, ambigüedad) cae al commander LLM.
  let command;
  try { command = helpers.classifyCommand(helpers.normalizeText(text)); }
  catch { return false; }
  if (!command || !RUNTIME_DESTRUCTIVE.has(command)) return false;

  const commander = getProductCommander();
  if (!commander) return false; // degradar → commander LLM

  const fromId = msg.from?.id;
  let parsed;
  try { parsed = commander.parse({ text, fromId }); }
  catch (e) { log(`product-command parse error: ${e.message}`); return false; }

  // Camino limpio: comando destructivo autorizado → confirmación explícita
  // (SR-2, productId bindeado en el nonce).
  if (parsed && parsed.ok && parsed.needsConfirmation && parsed.confirmId) {
    try {
      await sendProductConfirmation(parsed);
    } catch (e) {
      log(`Error enviando confirmación product-aware: ${e.message}`);
      return false; // no pudimos responder → dejar que el commander lo intente
    }
    appendHistory({
      direction: 'in', handler: 'product-command', from: msg.from?.first_name || 'unknown',
      from_id: fromId, command, product: parsed.productId, phase: 'confirm-requested',
    });
    log(`product-command: confirmación pedida (${command} · ${parsed.productId})`);
    return true;
  }

  // Rechazo. Distinguimos bloqueo de SEGURIDAD (injection / scope-widening) —
  // que DEBE cortar el flujo y NO llegar al LLM — de una ambigüedad
  // conversacional (p.ej. "seguí con el issue 42" matchea 'resume'), que cae al
  // LLM para no responder un rechazo espurio.
  let securityBlock = false;
  try {
    const norm = helpers.normalizeText(text);
    const inj = helpers.detectInjection(text);
    securityBlock = !!(inj && inj.hits && inj.hits.length > 0) || helpers.SCOPE_WIDENING_RE.test(norm);
  } catch { securityBlock = false; }

  if (securityBlock) {
    try { await sendMessage((parsed && parsed.response) || helpers.UNIFORM_REJECT); } catch {}
    appendHistory({
      direction: 'in', handler: 'product-command', from: msg.from?.first_name || 'unknown',
      from_id: fromId, command, ok: false, reason: 'security-block',
    });
    log(`product-command: bloqueo de seguridad (${command})`);
    return true;
  }

  // Ambiguo → flujo normal (commander LLM).
  return false;
}

/**
 * Maneja el callback de confirmación/cancelación product-aware (`pc:`/`pcx:`).
 * En confirmación: `product-command.confirm` resuelve el producto DESDE el nonce
 * (SR-2, imposible confused-deputy A→B), re-valida authz (SR-1) y, si OK,
 * EJECUTA el side-effect real vía `product-executor` y audita.
 */
async function handleProductConfirmCallback(cbq) {
  const data = cbq.data || '';
  const isCancel = data.startsWith('pcx:');
  const confirmId = data.slice(isCancel ? 4 : 3);

  if (isCancel) {
    await answerCallbackQuery(cbq.id, 'Cancelado');
    if (cbq.message) await removeInlineKeyboard(cbq.message, '✖️ Acción cancelada');
    return;
  }

  const commander = getProductCommander();
  if (!commander) {
    await answerCallbackQuery(cbq.id, 'Canal product-aware no disponible');
    return;
  }

  const fromId = cbq.from?.id;
  let result;
  try { result = commander.confirm({ fromId, confirmId }); }
  catch (e) {
    log(`Error confirmando acción product-aware: ${e.message}`);
    await answerCallbackQuery(cbq.id, 'No se pudo confirmar');
    return;
  }

  await answerCallbackQuery(cbq.id, result.ok ? 'Confirmado' : 'No válido');

  if (!result.ok) {
    try { await sendMessage(result.response); } catch {}
    return;
  }

  // Autorización + nonce ya validados dentro de confirm(). Ejecutar side-effect.
  const executor = getProductExecutor();
  let execOk = false;
  let outMsg = result.response; // "Pausé *Producto*..." (ya nombra el producto)
  try {
    const exec = executor
      ? executor.execute(result.command, result.productId, result.productName)
      : { executed: false, reason: 'executor-unavailable' };
    execOk = !!exec.executed;
    if (!execOk) {
      outMsg = `No pude ejecutar la acción sobre *${result.productName}* (${exec.reason || 'no soportada'}).`;
    }
  } catch (e) {
    log(`Error ejecutando acción product-aware: ${e.message}`);
    outMsg = `Error ejecutando la acción sobre *${result.productName}*.`;
  }

  try { await sendMessage(outMsg); } catch {}
  if (cbq.message) {
    const actorName = cbq.from?.first_name || cbq.from?.id || 'operador';
    const hora = new Date().toISOString().replace('T', ' ').slice(0, 16);
    await removeInlineKeyboard(
      cbq.message,
      `${execOk ? '✅' : '⚠️'} ${result.command} · ${result.productName} — ${actorName} · ${hora}`
    );
  }
  appendHistory({
    direction: 'in', handler: 'product-command', from: cbq.from?.first_name || 'unknown',
    from_id: fromId, command: result.command, product: result.productId, ok: execOk, phase: 'executed',
  });
  log(`product-command: ejecutado ${result.command} · ${result.productId} (ok=${execOk})`);
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

  // #4780 — confirmación/cancelación de acción product-aware. El `callback_data`
  // `pc:`/`pcx:` lleva el nonce opaco (productId bindeado server-side). Se rutea
  // ANTES del operator-gate (namespace disjunto). La autz por `from.id` se valida
  // DENTRO de product-command.confirm (SR-1) — acá sólo pasamos datos crudos.
  if (typeof cbq.data === 'string' && (cbq.data.startsWith('pc:') || cbq.data.startsWith('pcx:'))) {
    try {
      await handleProductConfirmCallback(cbq);
    } catch (e) {
      log(`Error en handleProductConfirmCallback: ${e.message}`);
      await answerCallbackQuery(cbq.id, 'No se pudo procesar la acción');
    }
    return;
  }

  // #4802 — Ruteo del Commander. Precedencia determinística:
  //   product-aware (pc:/pcx:, arriba) → COMMANDER → firma (operator-gate) → fail-safe.
  // Sólo cae a operator-gate lo que NO matchea ni product ni Commander.
  const cbData = typeof cbq.data === 'string' ? cbq.data : '';
  const router = getCommanderRouter();
  if (router && router.isCommanderNamespace(cbData)) {
    // CA-6: authz por from.id SÓLO para prefijos privilegiados. Fail-closed:
    // allowlist vacío o from.id fuera del allowlist → rechazo uniforme (misma
    // fuente que operator-gate). Nunca fail-open.
    if (router.isPrivilegedNamespace(cbData)) {
      const allow = resolveCommanderAllowlist();
      if (allow.size === 0 || !allow.has(String(cbq.from?.id))) {
        await answerCallbackQuery(cbq.id, 'Acción inválida o expirada');
        try {
          appendHistory({
            direction: 'in', handler: 'commander', from: cbq.from?.first_name || 'unknown',
            from_id: cbq.from?.id, ok: false, reason: 'unauthorized-privileged',
          });
        } catch { /* best-effort */ }
        return;
      }
    }
    let handled = false;
    try {
      handled = await router.routeCallback(cbData, cbq.id, cbq.message, cbq.from?.id);
    } catch (e) {
      log(`Error en routeCallback del commander: ${e.message}`);
      await answerCallbackQuery(cbq.id, 'No se pudo procesar la acción');
      return;
    }
    // Si el router no lo reconoció (p. ej. chat.id no coincide), fail-safe.
    if (!handled) {
      await answerCallbackQuery(cbq.id, 'Acción inválida o expirada');
    }
    try {
      appendHistory({
        direction: 'in', handler: 'commander', from: cbq.from?.first_name || 'unknown',
        from_id: cbq.from?.id, ok: !!handled, action: cbData.split(':')[0],
      });
    } catch { /* best-effort */ }
    return;
  }

  const gate = getOperatorGate();
  if (!gate) {
    // Degradación: cortar el spinner con un toast genérico.
    await answerCallbackQuery(cbq.id, 'Canal de firma no disponible temporalmente');
    return;
  }

  // #5458 — DESPACHO OPERACIONAL AISLADO. Antes del gate de lifecycle, se
  // clasifica el binding server-side: si el `callback_data` corresponde a una
  // acción OPERACIONAL (`vault-cut-fallback`), se deriva a su handler dedicado y
  // se corta el flujo. Esa acción no puede pasar por `handleSignature()` — ahí
  // abajo vive `applyTransition()`, que mueve work-files. La clasificación no
  // consume nada: si el id es desconocido, cae al camino de firma de siempre y
  // éste responde el toast genérico.
  let callbackKind = null;
  try {
    callbackKind = typeof gate.classifyCallback === 'function'
      ? gate.classifyCallback(cbq.data)
      : null;
  } catch (e) {
    log(`Error clasificando callback: ${e.message}`);
    callbackKind = null;
  }

  if (callbackKind === 'operational') {
    let opResult;
    try {
      opResult = gate.handleOperationalCallback({
        operatorId: cbq.from?.id,
        callbackData: cbq.data,
      });
    } catch (e) {
      log(`Error procesando callback operacional: ${e.message}`);
      await answerCallbackQuery(cbq.id, 'No se pudo procesar la acción');
      return;
    }

    // Respuesta TERMINAL en todos los caminos: se corta el spinner y, cuando el
    // resultado es definitivo, se quitan los botones para que un segundo toque
    // no pueda repetir nada (el nonce ya está gastado de todos modos).
    await answerCallbackQuery(cbq.id, opResult.toast);
    if (opResult.editMessage && cbq.message) {
      const actorName = cbq.from?.first_name || cbq.from?.id || 'operador';
      const hora = new Date().toISOString().replace('T', ' ').slice(0, 16);
      await removeInlineKeyboard(
        cbq.message,
        `⚙️ Confirmado por ${actorName} · ${hora} — ${opResult.toast}`
      );
    }
    try {
      appendHistory({
        direction: 'in',
        handler: 'operator-gate-operational',
        from: cbq.from?.first_name || 'unknown',
        from_id: cbq.from?.id,
        ok: !!opResult.ok,
        action: opResult.action || null,
        issue: opResult.issue || null,
        reason: opResult.reason || null,
      });
    } catch { /* best-effort */ }
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

  // #4780 — Pre-handler product-aware: intercepta NL destructivo (pausá/reanudá X)
  // ANTES de encolar al commander LLM, aplicando authz por `from.id` +
  // confirmación anti-TOCTOU + audit. Si no OWNea el mensaje, sigue el flujo
  // normal. Fail-open: cualquier error cae al commander LLM (nunca deja sin
  // respuesta ni bloquea el resto del bot).
  try {
    if (await maybeHandleProductCommand(msg)) {
      log(`product-command procesado inline (message_id=${msg.message_id})`);
      return;
    }
  } catch (e) {
    log(`Error en pre-handler product-command: ${e.message} — cae a flujo normal`);
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
  getProductCommander, // #4780 — seam product-aware para el handler NL
  // #4780 — wiring runtime del commander product-aware (inbound + confirmación).
  maybeHandleProductCommand,
  handleProductConfirmCallback,
  getProductExecutor,
  getCommanderRouter, // #4802 — router de callbacks del Commander
  resolveCommanderAllowlist, // #4802 — allowlist reusada de operator-gate
  deps, // { telegramRequest, operatorGate, productCommander, productExecutor, commanderRouter } — inyectables en tests
};

// --- ARRANQUE (sólo cuando se ejecuta como proceso, no al importar) ---
if (require.main === module) {
  loadSecretsOrExit();

  // --- SINGLETON ---
  require('./singleton')('listener');

  pollLoop().catch(e => { log(`Fatal: ${e.message}`); process.exit(1); });
}
