// commander/telegram-api.js — Helpers de bajo nivel para la API de Telegram
// Responsabilidad: HTTP requests, envío de mensajes, fotos, media groups
// Aislado del resto del commander para que un error aquí no tire todo el daemon
"use strict";

const https = require("https");
const { registerMessage } = require("../telegram-message-registry");

// ─── Constantes ──────────────────────────────────────────────────────────────
const TG_MSG_MAX = 4096;

// ─── Estado inyectado desde el orchestrator ──────────────────────────────────
let _botToken = null;
let _chatId = null;

function init(botToken, chatId) {
    _botToken = botToken;
    _chatId = chatId;
}

function getChatId() { return _chatId; }
function getBotToken() { return _botToken; }

// ─── HTTP helpers ────────────────────────────────────────────────────────────

function telegramPost(method, params, timeoutMs) {
    return new Promise((resolve, reject) => {
        const postData = JSON.stringify(params);
        const req = https.request({
            hostname: "api.telegram.org",
            path: "/bot" + _botToken + "/" + method,
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(postData)
            },
            timeout: timeoutMs || 8000
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

function escHtml(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

async function sendMessage(text, parseMode) {
    const result = await telegramPost("sendMessage", {
        chat_id: _chatId,
        text: text,
        parse_mode: parseMode || "HTML"
    }, 8000);
    if (result && result.message_id) {
        registerMessage(result.message_id, "command");
    }
    return result;
}

async function sendLongMessage(text, parseMode) {
    const mode = parseMode || "HTML";
    if (text.length <= TG_MSG_MAX) {
        return sendMessage(text, mode);
    }
    const chunks = [];
    let remaining = text;
    while (remaining.length > 0) {
        if (remaining.length <= TG_MSG_MAX) {
            chunks.push(remaining);
            break;
        }
        let cut = remaining.lastIndexOf("\n", TG_MSG_MAX);
        if (cut <= 0) cut = TG_MSG_MAX;
        chunks.push(remaining.substring(0, cut));
        remaining = remaining.substring(cut);
    }
    let lastMsg;
    for (const chunk of chunks) {
        lastMsg = await sendMessage(chunk, mode);
    }
    return lastMsg;
}

// ─── Descarga de archivos de Telegram ────────────────────────────────────────

async function telegramDownloadFile(fileId) {
    const fileInfo = await telegramPost("getFile", { file_id: fileId }, 10000);
    if (!fileInfo || !fileInfo.file_path) return null;

    return new Promise((resolve, reject) => {
        const url = "https://api.telegram.org/file/bot" + _botToken + "/" + fileInfo.file_path;
        https.get(url, { timeout: 30000 }, (res) => {
            if (res.statusCode !== 200) {
                reject(new Error("Download failed: HTTP " + res.statusCode));
                return;
            }
            const chunks = [];
            res.on("data", (c) => chunks.push(c));
            res.on("end", () => resolve({ buffer: Buffer.concat(chunks), filePath: fileInfo.file_path }));
            res.on("error", reject);
        }).on("error", reject);
    });
}

// ─── Envío de fotos y media groups ───────────────────────────────────────────

function sendTelegramPhoto(photoBuffer, caption, silent) {
    return new Promise((resolve, reject) => {
        const boundary = "----FormBoundary" + Date.now().toString(36);
        let body = "";
        body += "--" + boundary + "\r\nContent-Disposition: form-data; name=\"chat_id\"\r\n\r\n" + _chatId + "\r\n";
        if (caption) {
            body += "--" + boundary + "\r\nContent-Disposition: form-data; name=\"caption\"\r\n\r\n" + caption + "\r\n";
            body += "--" + boundary + "\r\nContent-Disposition: form-data; name=\"parse_mode\"\r\n\r\n" + "HTML" + "\r\n";
        }
        if (silent) {
            body += "--" + boundary + "\r\nContent-Disposition: form-data; name=\"disable_notification\"\r\n\r\n" + "true" + "\r\n";
        }
        const pre = Buffer.from(body + "--" + boundary + "\r\nContent-Disposition: form-data; name=\"photo\"; filename=\"dashboard.png\"\r\nContent-Type: image/png\r\n\r\n");
        const post = Buffer.from("\r\n--" + boundary + "--\r\n");
        const payload = Buffer.concat([pre, photoBuffer, post]);
        const req = https.request({
            hostname: "api.telegram.org",
            path: "/bot" + _botToken + "/sendPhoto",
            method: "POST",
            headers: { "Content-Type": "multipart/form-data; boundary=" + boundary, "Content-Length": payload.length },
            timeout: 15000
        }, (res) => {
            let d = "";
            res.on("data", (c) => d += c);
            res.on("end", () => {
                try {
                    const r = JSON.parse(d);
                    if (r.ok) {
                        registerMessage(r.result.message_id, "command");
                        resolve(r);
                    } else { reject(new Error(d)); }
                } catch(e) { reject(e); }
            });
        });
        req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
        req.on("error", (e) => reject(e));
        req.write(payload);
        req.end();
    });
}

function sendTelegramMediaGroup(photos, caption) {
    return new Promise((resolve, reject) => {
        const boundary = "----FormBoundary" + Date.now().toString(36);
        const media = photos.map((_, i) => ({
            type: "photo",
            media: "attach://photo" + i,
            ...(i === 0 && caption ? { caption, parse_mode: "HTML" } : {})
        }));

        let parts = [];
        parts.push(Buffer.from("--" + boundary + "\r\nContent-Disposition: form-data; name=\"chat_id\"\r\n\r\n" + _chatId + "\r\n"));
        parts.push(Buffer.from("--" + boundary + "\r\nContent-Disposition: form-data; name=\"media\"\r\n\r\n" + JSON.stringify(media) + "\r\n"));
        photos.forEach((buf, i) => {
            parts.push(Buffer.from("--" + boundary + "\r\nContent-Disposition: form-data; name=\"photo" + i + "\"; filename=\"photo" + i + ".png\"\r\nContent-Type: image/png\r\n\r\n"));
            parts.push(buf);
            parts.push(Buffer.from("\r\n"));
        });
        parts.push(Buffer.from("--" + boundary + "--\r\n"));
        const payload = Buffer.concat(parts);

        const req = https.request({
            hostname: "api.telegram.org",
            path: "/bot" + _botToken + "/sendMediaGroup",
            method: "POST",
            headers: { "Content-Type": "multipart/form-data; boundary=" + boundary, "Content-Length": payload.length },
            timeout: 20000
        }, (res) => {
            let d = "";
            res.on("data", (c) => d += c);
            res.on("end", () => {
                try {
                    const r = JSON.parse(d);
                    if (r.ok) {
                        r.result.forEach(m => registerMessage(m.message_id, "command"));
                        resolve(r);
                    } else { reject(new Error(d)); }
                } catch (e) { reject(e); }
            });
        });
        req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
        req.on("error", reject);
        req.write(payload);
        req.end();
    });
}

// ─── Media group with per-photo captions ─────────────────────────────────────

function sendTelegramMediaGroupWithCaptions(photos, captions) {
    return new Promise((resolve, reject) => {
        const boundary = "----FormBoundary" + Date.now().toString(36);
        const media = photos.map((_, i) => ({
            type: "photo",
            media: "attach://photo" + i,
            ...(captions[i] ? { caption: captions[i], parse_mode: "HTML" } : {})
        }));

        let parts = [];
        parts.push(Buffer.from("--" + boundary + "\r\nContent-Disposition: form-data; name=\"chat_id\"\r\n\r\n" + _chatId + "\r\n"));
        parts.push(Buffer.from("--" + boundary + "\r\nContent-Disposition: form-data; name=\"disable_notification\"\r\n\r\ntrue\r\n"));
        parts.push(Buffer.from("--" + boundary + "\r\nContent-Disposition: form-data; name=\"media\"\r\n\r\n" + JSON.stringify(media) + "\r\n"));
        photos.forEach((buf, i) => {
            parts.push(Buffer.from("--" + boundary + "\r\nContent-Disposition: form-data; name=\"photo" + i + "\"; filename=\"photo" + i + ".png\"\r\nContent-Type: image/png\r\n\r\n"));
            parts.push(buf);
            parts.push(Buffer.from("\r\n"));
        });
        parts.push(Buffer.from("--" + boundary + "--\r\n"));
        const payload = Buffer.concat(parts);

        const req = https.request({
            hostname: "api.telegram.org",
            path: "/bot" + _botToken + "/sendMediaGroup",
            method: "POST",
            headers: { "Content-Type": "multipart/form-data; boundary=" + boundary, "Content-Length": payload.length },
            timeout: 30000
        }, (res) => {
            let d = "";
            res.on("data", (c) => d += c);
            res.on("end", () => {
                try {
                    const r = JSON.parse(d);
                    if (r.ok) {
                        r.result.forEach(m => registerMessage(m.message_id, "command"));
                        resolve(r);
                    } else { reject(new Error(d)); }
                } catch (e) { reject(e); }
            });
        });
        req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
        req.on("error", reject);
        req.write(payload);
        req.end();
    });
}

// ─── Voice message ───────────────────────────────────────────────────────────

function sendVoiceMessage(audioBuffer) {
    return new Promise((resolve, reject) => {
        const boundary = "----FormBoundary" + Date.now().toString(36);
        const parts = [];

        parts.push("--" + boundary + "\r\n"
            + "Content-Disposition: form-data; name=\"chat_id\"\r\n\r\n"
            + _chatId + "\r\n");

        parts.push("--" + boundary + "\r\n"
            + "Content-Disposition: form-data; name=\"voice\"; filename=\"response.ogg\"\r\n"
            + "Content-Type: audio/ogg\r\n\r\n");

        const header = Buffer.from(parts.join(""));
        const footer = Buffer.from("\r\n--" + boundary + "--\r\n");
        const body = Buffer.concat([header, audioBuffer, footer]);

        const req = https.request({
            hostname: "api.telegram.org",
            path: "/bot" + _botToken + "/sendVoice",
            method: "POST",
            headers: {
                "Content-Type": "multipart/form-data; boundary=" + boundary,
                "Content-Length": body.length
            },
            timeout: 30000
        }, (res) => {
            let d = "";
            res.on("data", (c) => d += c);
            res.on("end", () => {
                try {
                    const r = JSON.parse(d);
                    if (r.ok) {
                        if (r.result && r.result.message_id) {
                            registerMessage(r.result.message_id, "command");
                        }
                        resolve(r.result);
                    } else reject(new Error("sendVoice: " + JSON.stringify(r)));
                } catch (e) { reject(e); }
            });
        });
        req.on("timeout", () => { req.destroy(); reject(new Error("sendVoice timeout")); });
        req.on("error", reject);
        req.write(body);
        req.end();
    });
}

module.exports = {
    init,
    getChatId,
    getBotToken,
    telegramPost,
    escHtml,
    sendMessage,
    sendLongMessage,
    telegramDownloadFile,
    sendTelegramPhoto,
    sendTelegramMediaGroup,
    sendTelegramMediaGroupWithCaptions,
    sendVoiceMessage,
    TG_MSG_MAX
};
