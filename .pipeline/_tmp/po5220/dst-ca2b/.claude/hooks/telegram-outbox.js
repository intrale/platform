// telegram-outbox.js — Message broker centralizado para Telegram (P-02)
// Los procesos satelite escriben a telegram-outbox.jsonl via enqueue()
// El Commander drena la cola cada 500ms con rate limiting
// Excepción: permission-gate.js mantiene envío directo (time-critical)
// Pure Node.js — sin dependencias externas

const fs = require("fs");
const path = require("path");

const HOOKS_DIR = __dirname;
const OUTBOX_FILE = path.join(HOOKS_DIR, "telegram-outbox.jsonl");
const LOG_FILE = path.join(HOOKS_DIR, "hook-debug.log");
const MAX_ENTRIES = 200;
const MAX_PER_DRAIN = 5; // Máximo mensajes por ciclo de drain
const DRAIN_INTERVAL_MS = 500;

let tgClient;
try { tgClient = require("./telegram-client"); } catch (e) { tgClient = null; }

function log(msg) {
    try { fs.appendFileSync(LOG_FILE, "[" + new Date().toISOString() + "] Outbox: " + msg + "\n"); } catch (e) {}
}

/**
 * Encolar un mensaje para envío asíncrono via el Commander.
 * @param {string} text - Texto HTML del mensaje
 * @param {object} [opts] - { silent, replyMarkup, chatId, category }
 */
function enqueue(text, opts) {
    opts = opts || {};
    const entry = {
        ts: Date.now(),
        text: text,
        silent: opts.silent || false,
        replyMarkup: opts.replyMarkup || null,
        chatId: opts.chatId || null,
        category: opts.category || "normal",
        status: "pending"
    };
    try {
        fs.appendFileSync(OUTBOX_FILE, JSON.stringify(entry) + "\n", "utf8");
    } catch (e) {
        log("Error encolando: " + e.message);
    }
}

/**
 * Drena la cola y envía hasta MAX_PER_DRAIN mensajes.
 * Llamado periódicamente por el Commander.
 * @returns {Promise<{sent: number, failed: number}>}
 */
async function drainQueue() {
    if (!tgClient) return { sent: 0, failed: 0 };

    let lines;
    try {
        if (!fs.existsSync(OUTBOX_FILE)) return { sent: 0, failed: 0 };
        const raw = fs.readFileSync(OUTBOX_FILE, "utf8").trim();
        if (!raw) return { sent: 0, failed: 0 };
        lines = raw.split("\n");
    } catch (e) {
        return { sent: 0, failed: 0 };
    }

    // Parsear entries pendientes
    const entries = [];
    const kept = [];
    for (const line of lines) {
        try {
            const entry = JSON.parse(line);
            if (entry.status === "pending") {
                entries.push(entry);
            } else {
                // Mantener entries no-pending (sent/failed) para rotación
                kept.push(line);
            }
        } catch (e) {
            // Línea corrupta — descartar
        }
    }

    if (entries.length === 0) {
        // Limpiar archivo si solo quedan entries procesados
        if (kept.length > MAX_ENTRIES) {
            const trimmed = kept.slice(-Math.floor(MAX_ENTRIES * 0.8));
            try { fs.writeFileSync(OUTBOX_FILE, trimmed.join("\n") + "\n", "utf8"); } catch (e) {}
        }
        return { sent: 0, failed: 0 };
    }

    // Procesar hasta MAX_PER_DRAIN entries
    let sent = 0;
    let failed = 0;
    const toProcess = entries.slice(0, MAX_PER_DRAIN);
    const remaining = entries.slice(MAX_PER_DRAIN);

    for (const entry of toProcess) {
        try {
            await tgClient.sendMessage(entry.text, {
                silent: entry.silent,
                replyMarkup: entry.replyMarkup,
                chatId: entry.chatId
            });
            entry.status = "sent";
            sent++;
        } catch (e) {
            entry.status = "failed";
            entry.error = e.message;
            failed++;
            log("Error enviando desde outbox: " + e.message);
        }
    }

    // Reescribir archivo con entries actualizados
    try {
        const allLines = [];
        for (const e of toProcess) allLines.push(JSON.stringify(e));
        for (const e of remaining) allLines.push(JSON.stringify(e));
        for (const l of kept) allLines.push(l);

        // Rotación: mantener últimas MAX_ENTRIES líneas
        const finalLines = allLines.length > MAX_ENTRIES
            ? allLines.slice(-Math.floor(MAX_ENTRIES * 0.8))
            : allLines;

        fs.writeFileSync(OUTBOX_FILE, finalLines.join("\n") + "\n", "utf8");
    } catch (e) {
        log("Error reescribiendo outbox: " + e.message);
    }

    if (sent > 0 || failed > 0) {
        log("Drain: " + sent + " enviados, " + failed + " fallidos, " + remaining.length + " pendientes");
    }
    return { sent, failed };
}

/**
 * Inicia el drain periódico (para usar dentro del Commander).
 * @returns {NodeJS.Timeout} ID del interval para poder detenerlo
 */
function startDrainLoop() {
    return setInterval(() => {
        drainQueue().catch(e => log("drainQueue error: " + e.message));
    }, DRAIN_INTERVAL_MS);
}

module.exports = { enqueue, drainQueue, startDrainLoop, DRAIN_INTERVAL_MS };
