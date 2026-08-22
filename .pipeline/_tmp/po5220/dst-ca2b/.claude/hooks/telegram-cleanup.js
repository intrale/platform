// telegram-cleanup.js — Lógica de borrado de mensajes antiguos de Telegram
// Usa deleteMessage de la API para limpiar mensajes expirados.
// Rate limit: 100ms entre cada delete (respeta límite de 30 ops/seg de Telegram).
// Pure Node.js — sin dependencias externas

const https = require("https");
const fs = require("fs");
const path = require("path");

const { getExpiredMessages, removeMessages } = require("./telegram-message-registry");

const HOOKS_DIR = __dirname;
const CONFIG_FILE = path.join(HOOKS_DIR, "telegram-config.json");
const LOG_FILE = path.join(HOOKS_DIR, "hook-debug.log");

let _tgCfg;
try {
    _tgCfg = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
} catch (e) {
    _tgCfg = { bot_token: "", chat_id: "" };
}

function log(msg) {
    try { fs.appendFileSync(LOG_FILE, "[" + new Date().toISOString() + "] Cleanup: " + msg + "\n"); } catch (e) {}
}

function deleteMessage(botToken, chatId, messageId) {
    return new Promise((resolve, reject) => {
        const postData = JSON.stringify({ chat_id: chatId, message_id: messageId });
        const req = https.request({
            hostname: "api.telegram.org",
            path: "/bot" + botToken + "/deleteMessage",
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(postData)
            },
            timeout: 5000
        }, (res) => {
            let d = "";
            res.on("data", (c) => d += c);
            res.on("end", () => {
                try {
                    const r = JSON.parse(d);
                    if (r.ok) resolve(true);
                    else resolve(false); // No rechazar — mensajes ya borrados o >48h retornan false
                } catch (e) { resolve(false); }
            });
        });
        req.on("timeout", () => { req.destroy(); resolve(false); });
        req.on("error", () => resolve(false));
        req.write(postData);
        req.end();
    });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/**
 * Ejecuta limpieza de mensajes expirados.
 * @param {number} maxAgeMs - Antigüedad máxima en ms (ej: 4 * 60 * 60 * 1000 para 4h)
 * @returns {Promise<{deleted: number, failed: number, total: number}>}
 */
async function cleanup(maxAgeMs) {
    const expired = getExpiredMessages(maxAgeMs);
    if (expired.length === 0) {
        return { deleted: 0, failed: 0, total: 0 };
    }

    log("Iniciando cleanup de " + expired.length + " mensajes expirados (maxAge=" + Math.round(maxAgeMs / 3600000) + "h)");

    let deleted = 0;
    let failed = 0;
    const toRemove = []; // IDs a remover del registry (tanto exitosos como fallidos irrecuperables)

    for (const msg of expired) {
        const ok = await deleteMessage(_tgCfg.bot_token, _tgCfg.chat_id, msg.id);
        if (ok) {
            deleted++;
            toRemove.push(msg.id);
        } else {
            failed++;
            // Si el mensaje tiene >48h, Telegram ya no permite borrarlo — remover del registry igual
            const ageMs = Date.now() - msg.ts;
            if (ageMs > 48 * 60 * 60 * 1000) {
                toRemove.push(msg.id);
            } else {
                toRemove.push(msg.id); // También remover los fallidos recientes para no reintentar infinitamente
            }
        }

        // Rate limit: 100ms entre deletes
        await sleep(100);
    }

    // Remover todos los procesados del registry
    removeMessages(toRemove);

    log("Cleanup completado: " + deleted + " borrados, " + failed + " fallidos, " + expired.length + " total procesados");
    return { deleted, failed, total: expired.length };
}

module.exports = { cleanup };
