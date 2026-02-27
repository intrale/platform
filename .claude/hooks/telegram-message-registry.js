// telegram-message-registry.js — Registro centralizado de message_ids enviados a Telegram
// Mantiene telegram-messages.json con todos los mensajes enviados por hooks.
// Auto-rotación: cap de 500 entries, recorta a 400 al superar.
// Pure Node.js — sin dependencias externas

const fs = require("fs");
const path = require("path");

const HOOKS_DIR = __dirname;
const REGISTRY_FILE = path.join(HOOKS_DIR, "telegram-messages.json");
const LOG_FILE = path.join(HOOKS_DIR, "hook-debug.log");

const MAX_ENTRIES = 500;
const TRIM_TO = 400;

function log(msg) {
    try { fs.appendFileSync(LOG_FILE, "[" + new Date().toISOString() + "] MsgRegistry: " + msg + "\n"); } catch (e) {}
}

function loadRegistry() {
    try {
        if (!fs.existsSync(REGISTRY_FILE)) return { messages: [] };
        return JSON.parse(fs.readFileSync(REGISTRY_FILE, "utf8"));
    } catch (e) {
        log("Error leyendo registry: " + e.message);
        return { messages: [] };
    }
}

function saveRegistry(data) {
    try {
        fs.writeFileSync(REGISTRY_FILE, JSON.stringify(data), "utf8");
    } catch (e) {
        log("Error guardando registry: " + e.message);
    }
}

/**
 * Registra un message_id enviado a Telegram.
 * @param {number} messageId - message_id devuelto por la API de Telegram
 * @param {string} category - notification | permission | stop | ci | command | proposal
 */
function registerMessage(messageId, category) {
    if (!messageId) return;
    const data = loadRegistry();
    data.messages.push({
        id: messageId,
        cat: category || "unknown",
        ts: Date.now()
    });

    // Auto-rotación: si supera el cap, recortar a TRIM_TO (los más recientes)
    if (data.messages.length > MAX_ENTRIES) {
        data.messages = data.messages.slice(-TRIM_TO);
        log("Auto-rotación: recortado de " + MAX_ENTRIES + "+ a " + TRIM_TO + " entries");
    }

    saveRegistry(data);
}

/**
 * Obtiene mensajes expirados (más viejos que maxAgeMs).
 * @param {number} maxAgeMs - Antigüedad máxima en ms
 * @returns {Array<{id: number, cat: string, ts: number}>}
 */
function getExpiredMessages(maxAgeMs) {
    const data = loadRegistry();
    const cutoff = Date.now() - maxAgeMs;
    return data.messages.filter(m => m.ts < cutoff);
}

/**
 * Remueve mensajes del registry por sus IDs.
 * @param {number[]} messageIds - Lista de message_ids a remover
 */
function removeMessages(messageIds) {
    if (!messageIds || messageIds.length === 0) return;
    const idSet = new Set(messageIds);
    const data = loadRegistry();
    const before = data.messages.length;
    data.messages = data.messages.filter(m => !idSet.has(m.id));
    saveRegistry(data);
    log("Removidos " + (before - data.messages.length) + " mensajes del registry");
}

/**
 * Estadísticas del registry.
 * @returns {{ total: number, byCategory: Object<string,number>, oldest: number|null, newest: number|null }}
 */
function getStats() {
    const data = loadRegistry();
    const msgs = data.messages;
    const byCategory = {};
    for (const m of msgs) {
        byCategory[m.cat] = (byCategory[m.cat] || 0) + 1;
    }
    return {
        total: msgs.length,
        byCategory,
        oldest: msgs.length > 0 ? msgs[0].ts : null,
        newest: msgs.length > 0 ? msgs[msgs.length - 1].ts : null
    };
}

module.exports = { registerMessage, getExpiredMessages, removeMessages, getStats };
