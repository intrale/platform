// telegram-client.js — Módulo compartido para comunicación con Telegram API (P-09)
// Centraliza telegramPost, sendMessage, editMessage, sendPhoto
// Con retry automático, rate limiting y logging unificado
// Pure Node.js — sin dependencias externas

const https = require("https");
const fs = require("fs");
const path = require("path");
const { sanitizeHtml } = require("./telegram-sanitizer");
// #5245 CA-12/CA-12a — chokepoint unico de credenciales Telegram.
// El require cruzado hacia `.pipeline/lib/` es FATAL a proposito: sin try/catch
// ni fallback. Un fallback silencioso acá reproduce exactamente el modo de falla
// que esta historia viene a matar (degradar sin ruido a la lectura in-repo).
const { loadTelegramSecrets } = require("../../.pipeline/lib/telegram-secrets");
const { assertSecretOrigin } = require("../../.pipeline/lib/secrets-guard");

const HOOKS_DIR = __dirname;
const CONFIG_FILE = path.join(HOOKS_DIR, "telegram-config.json");
const LOG_FILE = path.join(HOOKS_DIR, "hook-debug.log");

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1500;
const DEFAULT_TIMEOUT_MS = 8000;
const TG_MSG_MAX = 4096;

// ─── Config (lazy load, cached) ─────────────────────────────────────────────

let _config = null;

// Claves de secreto que todavía viven dentro del archivo in-repo (dual: config
// operativa versionada + credenciales). El dot-path es el del manifiesto
// (#5242), que es lo que le permite al guard distinguir `quiet_hours` (lectura
// in-repo legítima) de `bot_token` (prohibida).
const IN_REPO_SECRET_KEYS = Object.freeze([
    ["bot_token", "telegram.bot_token"],
    ["chat_id", "telegram.chat_id"],
    ["openai_api_key", "providers.openai.api_key"],
    ["anthropic_api_key", "providers.anthropic.api_key"],
]);

/**
 * Config de Telegram.
 *
 * #5245 (D-3): las claves OPERATIVAS se siguen leyendo del archivo in-repo —
 * están versionadas y tienen consumidores vivos— pero los SECRETOS salen
 * siempre del chokepoint, que los pisa en el spread. Así el archivo in-repo no
 * puede volver a ser fuente de `bot_token` ni por accidente.
 *
 * El degradado silencioso se preserva a propósito: `loadTelegramSecrets()`
 * lanza si no encuentra credenciales, y hacer eso fatal convertiría "falta una
 * credencial" en "el pipeline dejó de notificar", que es el riesgo principal
 * declarado de la historia.
 */
function getConfig() {
    if (_config) return _config;

    let operational = {};
    try {
        const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
        // El archivo es dual: si además de la config operativa trae material de
        // secreto, esta lectura se declara al guard (en `warn` avisa y cuenta;
        // en `strict` aborta esta rama y las claves operativas degradan a {},
        // pero los secretos llegan igual por el chokepoint → sigue notificando).
        for (const [fileKey, dotPath] of IN_REPO_SECRET_KEYS) {
            if (typeof raw[fileKey] === "string" && raw[fileKey].trim()) {
                assertSecretOrigin(CONFIG_FILE, {
                    op: "read",
                    secret: dotPath,
                    site: "telegram-client.getConfig",
                });
            }
        }
        operational = raw;
    } catch (e) {
        operational = {};
    }

    let bot_token = "";
    let chat_id = "";
    try {
        const secrets = loadTelegramSecrets({ legacyConfigPath: CONFIG_FILE, log });
        bot_token = secrets.bot_token || "";
        chat_id = secrets.chat_id ? String(secrets.chat_id) : "";
    } catch (e) {
        log("sin credenciales Telegram: " + e.message);
    }

    _config = { ...operational, bot_token, chat_id };
    return _config;
}

function getBotToken() { return getConfig().bot_token; }
function getChatId() { return getConfig().chat_id; }

// ─── Logging ────────────────────────────────────────────────────────────────

function log(msg) {
    try { fs.appendFileSync(LOG_FILE, "[" + new Date().toISOString() + "] TgClient: " + msg + "\n"); } catch (e) {}
}

// ─── Core HTTP ──────────────────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/**
 * Ejecuta un método de la API de Telegram con retry automático.
 * @param {string} method - Método de la API (sendMessage, editMessageText, etc.)
 * @param {object} params - Parámetros del método
 * @param {number} [timeoutMs] - Timeout en ms (default 8000)
 * @returns {Promise<object>} Resultado de la API
 */
function telegramPost(method, params, timeoutMs) {
    return new Promise((resolve, reject) => {
        const token = getBotToken();
        if (!token) { reject(new Error("No bot_token configured")); return; }
        const postData = JSON.stringify(params);
        const req = https.request({
            hostname: "api.telegram.org",
            path: "/bot" + token + "/" + method,
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(postData)
            },
            timeout: timeoutMs || DEFAULT_TIMEOUT_MS
        }, (res) => {
            let d = "";
            res.on("data", (c) => d += c);
            res.on("end", () => {
                try {
                    const r = JSON.parse(d);
                    if (r.ok) resolve(r.result);
                    else reject(new Error(JSON.stringify(r)));
                } catch (e) { reject(e); }
            });
        });
        req.on("timeout", () => { req.destroy(); reject(new Error("timeout " + method)); });
        req.on("error", (e) => reject(e));
        req.write(postData);
        req.end();
    });
}

/**
 * telegramPost con retry automático (hasta MAX_RETRIES intentos).
 */
async function telegramPostRetry(method, params, timeoutMs) {
    let lastErr;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        try {
            return await telegramPost(method, params, timeoutMs);
        } catch (e) {
            lastErr = e;
            const errMsg = e.message || "";
            // No reintentar errores 4xx (excepto 429 rate limit)
            if (errMsg.includes('"error_code":4') && !errMsg.includes('"error_code":429')) throw e;
            if (attempt < MAX_RETRIES - 1) await sleep(RETRY_DELAY_MS * (attempt + 1));
        }
    }
    throw lastErr;
}

// ─── High-level helpers ─────────────────────────────────────────────────────

/**
 * Envía un mensaje de texto a Telegram.
 * @param {string} text - Texto del mensaje (HTML)
 * @param {object} [opts] - Opciones: { silent, replyMarkup, chatId }
 * @returns {Promise<object>} Mensaje enviado
 */
// ─── Command-in-progress guard ───────────────────────────────────────────────
// Cuando el usuario envía un mensaje (texto o audio), se activa un flag que
// bloquea mensajes automáticos de otros hooks hasta que la respuesta se envíe.
// Solo mensajes marcados con opts.isResponse=true pasan durante el bloqueo.

const COMMAND_FLAG = path.join(HOOKS_DIR, "command-in-progress.flag");

function isCommandInProgress() {
    try {
        if (!fs.existsSync(COMMAND_FLAG)) return false;
        const age = Date.now() - fs.statSync(COMMAND_FLAG).mtimeMs;
        if (age > 180000) { // 3 min max — cleanup stale flags
            try { fs.unlinkSync(COMMAND_FLAG); } catch (e) {}
            return false;
        }
        return true;
    } catch (e) { return false; }
}

function setCommandInProgress(active) {
    try {
        if (active) {
            fs.writeFileSync(COMMAND_FLAG, String(Date.now()), "utf8");
        } else {
            if (fs.existsSync(COMMAND_FLAG)) fs.unlinkSync(COMMAND_FLAG);
        }
    } catch (e) {}
}

async function sendMessage(text, opts) {
    opts = opts || {};

    const chatId = opts.chatId || getChatId();
    if (!chatId) throw new Error("No chat_id configured");

    // Sanitizar UTF-8 y truncar si excede límite de Telegram
    const sanitized = sanitizeHtml(text);
    const safeText = sanitized.length > TG_MSG_MAX ? sanitized.substring(0, TG_MSG_MAX - 20) + "\n\n…(truncado)" : sanitized;

    const params = {
        chat_id: chatId,
        text: safeText,
        parse_mode: "HTML"
    };
    if (opts.silent) params.disable_notification = true;
    if (opts.replyMarkup) params.reply_markup = opts.replyMarkup;

    return telegramPostRetry("sendMessage", params);
}

/**
 * Edita un mensaje existente.
 * @param {number} messageId - ID del mensaje a editar
 * @param {string} text - Nuevo texto (HTML)
 * @param {object} [opts] - Opciones: { replyMarkup, chatId }
 * @returns {Promise<object>}
 */
async function editMessage(messageId, text, opts) {
    opts = opts || {};
    const chatId = opts.chatId || getChatId();
    const params = {
        chat_id: chatId,
        message_id: messageId,
        text: sanitizeHtml(text),
        parse_mode: "HTML"
    };
    if (opts.replyMarkup) params.reply_markup = opts.replyMarkup;
    return telegramPost("editMessageText", params);
}

/**
 * Envía una foto a Telegram (multipart form-data).
 * @param {Buffer} imageBuffer - PNG/JPG buffer
 * @param {string} caption - Caption (HTML)
 * @param {object} [opts] - Opciones: { silent, chatId }
 * @returns {Promise<object>}
 */
function sendPhoto(imageBuffer, caption, opts) {
    opts = opts || {};
    const chatId = opts.chatId || getChatId();
    const token = getBotToken();
    if (!token || !chatId) return Promise.reject(new Error("No bot_token or chat_id"));
    const safeCaption = caption ? sanitizeHtml(caption) : caption;

    return new Promise((resolve, reject) => {
        const boundary = "----TgClient" + Date.now();
        let body = "";
        body += "--" + boundary + "\r\n";
        body += "Content-Disposition: form-data; name=\"chat_id\"\r\n\r\n" + chatId + "\r\n";
        if (safeCaption) {
            body += "--" + boundary + "\r\n";
            body += "Content-Disposition: form-data; name=\"caption\"\r\n\r\n" + safeCaption + "\r\n";
            body += "--" + boundary + "\r\n";
            body += "Content-Disposition: form-data; name=\"parse_mode\"\r\n\r\nHTML\r\n";
        }
        if (opts.silent) {
            body += "--" + boundary + "\r\n";
            body += "Content-Disposition: form-data; name=\"disable_notification\"\r\n\r\ntrue\r\n";
        }
        body += "--" + boundary + "\r\n";
        body += "Content-Disposition: form-data; name=\"photo\"; filename=\"image.png\"\r\nContent-Type: image/png\r\n\r\n";
        const end = "\r\n--" + boundary + "--\r\n";
        const bodyBuf = Buffer.concat([Buffer.from(body), imageBuffer, Buffer.from(end)]);

        const req = https.request({
            hostname: "api.telegram.org",
            path: "/bot" + token + "/sendPhoto",
            method: "POST",
            headers: {
                "Content-Type": "multipart/form-data; boundary=" + boundary,
                "Content-Length": bodyBuf.length
            },
            timeout: 15000
        }, (res) => {
            let d = "";
            res.on("data", (c) => d += c);
            res.on("end", () => {
                try {
                    const r = JSON.parse(d);
                    if (r.ok) resolve(r.result);
                    else reject(new Error(JSON.stringify(r)));
                } catch (e) { reject(e); }
            });
        });
        req.on("timeout", () => { req.destroy(); reject(new Error("timeout sendPhoto")); });
        req.on("error", (e) => reject(e));
        req.write(bodyBuf);
        req.end();
    });
}

/**
 * Envía un documento a Telegram (multipart form-data).
 * @param {Buffer} fileBuffer - File buffer
 * @param {string} filename - Nombre del archivo
 * @param {string} caption - Caption
 * @param {object} [opts] - Opciones: { chatId }
 * @returns {Promise<object>}
 */
function sendDocument(fileBuffer, filename, caption, opts) {
    opts = opts || {};
    const chatId = opts.chatId || getChatId();
    const token = getBotToken();
    if (!token || !chatId) return Promise.reject(new Error("No bot_token or chat_id"));
    const safeCaption = caption ? sanitizeHtml(caption) : caption;

    return new Promise((resolve, reject) => {
        const boundary = "----TgClient" + Date.now();
        let body = "";
        body += "--" + boundary + "\r\n";
        body += "Content-Disposition: form-data; name=\"chat_id\"\r\n\r\n" + chatId + "\r\n";
        if (safeCaption) {
            body += "--" + boundary + "\r\n";
            body += "Content-Disposition: form-data; name=\"caption\"\r\n\r\n" + safeCaption + "\r\n";
        }
        body += "--" + boundary + "\r\n";
        body += "Content-Disposition: form-data; name=\"document\"; filename=\"" + filename + "\"\r\nContent-Type: application/octet-stream\r\n\r\n";
        const end = "\r\n--" + boundary + "--\r\n";
        const bodyBuf = Buffer.concat([Buffer.from(body), fileBuffer, Buffer.from(end)]);

        const req = https.request({
            hostname: "api.telegram.org",
            path: "/bot" + token + "/sendDocument",
            method: "POST",
            headers: {
                "Content-Type": "multipart/form-data; boundary=" + boundary,
                "Content-Length": bodyBuf.length
            },
            timeout: 15000
        }, (res) => {
            let d = "";
            res.on("data", (c) => d += c);
            res.on("end", () => {
                try {
                    const r = JSON.parse(d);
                    if (r.ok) resolve(r.result);
                    else reject(new Error(JSON.stringify(r)));
                } catch (e) { reject(e); }
            });
        });
        req.on("timeout", () => { req.destroy(); reject(new Error("timeout sendDocument")); });
        req.on("error", (e) => reject(e));
        req.write(bodyBuf);
        req.end();
    });
}

// ─── Exports ────────────────────────────────────────────────────────────────

module.exports = {
    telegramPost,
    telegramPostRetry,
    sendMessage,
    editMessage,
    sendPhoto,
    sendDocument,
    getConfig,
    getBotToken,
    getChatId,
    TG_MSG_MAX,
    setCommandInProgress,
    isCommandInProgress
};
