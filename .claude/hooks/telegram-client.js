// telegram-client.js — Módulo compartido para comunicación con Telegram API (P-09)
// Centraliza telegramPost, sendMessage, editMessage, sendPhoto
// Con retry automático, rate limiting y logging unificado
// Pure Node.js — sin dependencias externas

const https = require("https");
const fs = require("fs");
const path = require("path");

const HOOKS_DIR = __dirname;
const CONFIG_FILE = path.join(HOOKS_DIR, "telegram-config.json");
const LOG_FILE = path.join(HOOKS_DIR, "hook-debug.log");

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1500;
const DEFAULT_TIMEOUT_MS = 8000;
const TG_MSG_MAX = 4096;

// ─── Config (lazy load, cached) ─────────────────────────────────────────────

let _config = null;

function getConfig() {
    if (_config) return _config;
    try {
        _config = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
    } catch (e) {
        _config = { bot_token: "", chat_id: "" };
    }
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
async function sendMessage(text, opts) {
    opts = opts || {};
    const chatId = opts.chatId || getChatId();
    if (!chatId) throw new Error("No chat_id configured");

    // Truncar si excede límite de Telegram
    const safeText = text.length > TG_MSG_MAX ? text.substring(0, TG_MSG_MAX - 20) + "\n\n…(truncado)" : text;

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
        text: text,
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

    return new Promise((resolve, reject) => {
        const boundary = "----TgClient" + Date.now();
        let body = "";
        body += "--" + boundary + "\r\n";
        body += "Content-Disposition: form-data; name=\"chat_id\"\r\n\r\n" + chatId + "\r\n";
        if (caption) {
            body += "--" + boundary + "\r\n";
            body += "Content-Disposition: form-data; name=\"caption\"\r\n\r\n" + caption + "\r\n";
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

    return new Promise((resolve, reject) => {
        const boundary = "----TgClient" + Date.now();
        let body = "";
        body += "--" + boundary + "\r\n";
        body += "Content-Disposition: form-data; name=\"chat_id\"\r\n\r\n" + chatId + "\r\n";
        if (caption) {
            body += "--" + boundary + "\r\n";
            body += "Content-Disposition: form-data; name=\"caption\"\r\n\r\n" + caption + "\r\n";
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
    TG_MSG_MAX
};
