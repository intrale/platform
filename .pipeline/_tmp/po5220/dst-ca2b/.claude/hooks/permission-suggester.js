// permission-suggester.js — Sugerencias proactivas de auto-aprobación de permisos
// Issue #1280: analiza approval-history.json e identifica patrones repetidos para
// sugerir su conversión a auto-aprobación permanente via Telegram con botones inline.
//
// Uso desde telegram-commander.js:
//   const { analyzeSuggestions, handleSuggestionApprove, handleSuggestionNever } = require("./permission-suggester");
//
// Pure Node.js — sin dependencias externas

const fs = require("fs");
const path = require("path");
const https = require("https");

const HOOKS_DIR = __dirname;
const REPO_ROOT = process.env.CLAUDE_PROJECT_DIR || path.resolve(HOOKS_DIR, "..", "..");
const LOG_FILE = path.join(HOOKS_DIR, "hook-debug.log");
const APPROVAL_HISTORY_FILE = path.join(HOOKS_DIR, "approval-history.json");
const IGNORED_FILE = path.join(HOOKS_DIR, "permission-suggester-ignored.json");
const CONFIG_FILE = path.join(HOOKS_DIR, "telegram-config.json");

const { getSettingsPaths, persistPattern, isAlreadyCovered, resolveMainRepoRoot } = require("./permission-utils");

// ─── Config ──────────────────────────────────────────────────────────────────

function loadConfig() {
    try {
        return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
    } catch (e) {
        return {};
    }
}

function getThreshold() {
    const cfg = loadConfig();
    return (typeof cfg.SUGGESTER_THRESHOLD === "number") ? cfg.SUGGESTER_THRESHOLD : 5;
}

function getWindowHours() {
    const cfg = loadConfig();
    return (typeof cfg.SUGGESTER_WINDOW_HOURS === "number") ? cfg.SUGGESTER_WINDOW_HOURS : 24;
}

function getBotToken() {
    return loadConfig().bot_token || "";
}

function getChatId() {
    return loadConfig().chat_id || "";
}

// ─── Logging ─────────────────────────────────────────────────────────────────

function log(msg) {
    try {
        fs.appendFileSync(LOG_FILE, "[" + new Date().toISOString() + "] Suggester: " + msg + "\n");
    } catch (e) {}
}

// ─── Lista de ignorados ──────────────────────────────────────────────────────

function loadIgnored() {
    try {
        if (!fs.existsSync(IGNORED_FILE)) return [];
        const data = JSON.parse(fs.readFileSync(IGNORED_FILE, "utf8"));
        return Array.isArray(data.ignored) ? data.ignored : [];
    } catch (e) {
        return [];
    }
}

function saveIgnored(ignored) {
    try {
        const data = { ignored, updatedAt: new Date().toISOString() };
        fs.writeFileSync(IGNORED_FILE, JSON.stringify(data, null, 2) + "\n", "utf8");
    } catch (e) {
        log("Error guardando ignored: " + e.message);
    }
}

/**
 * Agrega un patrón a la lista de "nunca sugerir".
 */
function addToIgnored(pattern) {
    const ignored = loadIgnored();
    if (!ignored.includes(pattern)) {
        ignored.push(pattern);
        saveIgnored(ignored);
        log("Agregado a ignorados: " + pattern);
    }
}

// ─── Detección de patrones peligrosos ────────────────────────────────────────

/**
 * Detecta patrones con wildcards demasiado amplios que no deben sugerirse.
 * Ej: Bash(*:*), Bash(:*), etc.
 */
function isDangerouslyBroad(pattern) {
    if (pattern === "Bash(*:*)" || pattern === "Bash(:*)") return true;
    if (/^Bash\(\*/.test(pattern)) return true;
    if (/^Bash\(:\*\)$/.test(pattern)) return true;
    return false;
}

// ─── Análisis de historial ───────────────────────────────────────────────────

/**
 * Lee approval-history.json y devuelve patrones candidatos a auto-aprobación.
 * @returns {{ pattern: string, count: number, last: string }[]} candidatos ordenados por count desc
 */
function getCandidates() {
    const threshold = getThreshold();
    const windowHours = getWindowHours();
    const windowMs = windowHours * 60 * 60 * 1000;
    const cutoff = Date.now() - windowMs;

    let history = {};
    try {
        if (!fs.existsSync(APPROVAL_HISTORY_FILE)) return [];
        const data = JSON.parse(fs.readFileSync(APPROVAL_HISTORY_FILE, "utf8"));
        history = data.patterns || {};
    } catch (e) {
        log("Error leyendo approval-history.json: " + e.message);
        return [];
    }

    const candidates = [];
    for (const [pattern, info] of Object.entries(history)) {
        if (typeof info.count !== "number" || info.count < threshold) continue;
        // Verificar que la última aprobación esté dentro de la ventana de tiempo
        if (!info.last || new Date(info.last).getTime() < cutoff) continue;
        if (isDangerouslyBroad(pattern)) {
            log("Patrón descartado (peligroso): " + pattern);
            continue;
        }
        candidates.push({ pattern, count: info.count, last: info.last });
    }

    // Ordenar por count descendente (más frecuentes primero)
    candidates.sort((a, b) => b.count - a.count);
    return candidates;
}

/**
 * Filtra candidatos excluyendo los ya cubiertos en settings y los ignorados.
 */
function filterCandidates(candidates) {
    // Leer allow list de settings.local.json
    let allowList = [];
    try {
        const mainRoot = resolveMainRepoRoot(REPO_ROOT) || REPO_ROOT;
        const settingsPaths = getSettingsPaths(mainRoot);
        for (const sp of settingsPaths) {
            try {
                if (!fs.existsSync(sp)) continue;
                const s = JSON.parse(fs.readFileSync(sp, "utf8"));
                const allow = (s.permissions && s.permissions.allow) || [];
                allowList = allowList.concat(allow);
            } catch (e) {}
        }
    } catch (e) {
        log("Error leyendo settings.local.json: " + e.message);
    }

    // Deduplicar
    allowList = [...new Set(allowList)];

    const ignored = loadIgnored();

    return candidates.filter(c => {
        if (isAlreadyCovered(c.pattern, allowList)) {
            log("Patrón ya cubierto en settings: " + c.pattern);
            return false;
        }
        if (ignored.includes(c.pattern)) {
            log("Patrón en lista de ignorados: " + c.pattern);
            return false;
        }
        return true;
    });
}

// ─── Envío de mensaje Telegram ────────────────────────────────────────────────

function telegramPost(method, params, timeoutMs) {
    return new Promise((resolve, reject) => {
        const BOT_TOKEN = getBotToken();
        const postData = JSON.stringify(params);
        const req = https.request({
            hostname: "api.telegram.org",
            path: "/bot" + BOT_TOKEN + "/" + method,
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
                    if (r.ok) resolve(r);
                    else reject(new Error("TG error: " + d));
                } catch (e) {
                    reject(new Error("JSON parse: " + d.substring(0, 200)));
                }
            });
        });
        req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
        req.on("error", reject);
        req.write(postData);
        req.end();
    });
}

function escHtml(str) {
    return String(str)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
}

/**
 * Envía un mensaje de sugerencia por Telegram con 3 botones inline.
 * Usa base64url para codificar el patrón en callback_data (safe para Telegram).
 */
async function sendSuggestion(candidate) {
    const CHAT_ID = getChatId();
    const { pattern, count } = candidate;
    const encodedPattern = Buffer.from(pattern).toString("base64url");

    const text = [
        "🤖 <b>Sugerencia de auto-aprobación</b>",
        "",
        "Aprobaste <b>" + count + " veces</b> el patrón:",
        "<code>" + escHtml(pattern) + "</code>",
        "",
        "¿Querés que lo agregue a auto-aprobación permanente?"
    ].join("\n");

    const keyboard = [[
        { text: "✅ Aprobar siempre", callback_data: "ps_approve:" + encodedPattern },
        { text: "🚫 Ignorar",         callback_data: "ps_ignore:"  + encodedPattern },
        { text: "⛔ Nunca sugerir",   callback_data: "ps_never:"   + encodedPattern }
    ]];

    try {
        const result = await telegramPost("sendMessage", {
            chat_id: CHAT_ID,
            text,
            parse_mode: "HTML",
            reply_markup: { inline_keyboard: keyboard }
        }, 8000);
        log("Sugerencia enviada: " + pattern + " (count=" + count + ") msg_id=" + (result.result && result.result.message_id));
        return true;
    } catch (e) {
        log("Error enviando sugerencia para " + pattern + ": " + e.message);
        return false;
    }
}

// ─── Función principal ────────────────────────────────────────────────────────

const MAX_SUGGESTIONS_PER_CYCLE = 5;

/**
 * Analiza las métricas de aprobación y envía sugerencias de auto-aprobación.
 * Se llama periódicamente desde telegram-commander.js (cada 6 horas).
 */
async function analyzeSuggestions() {
    log("Iniciando análisis de sugerencias (threshold=" + getThreshold() + ", window=" + getWindowHours() + "h)");

    try {
        const allCandidates = getCandidates();
        const filtered = filterCandidates(allCandidates);

        if (filtered.length === 0) {
            log("No hay candidatos para sugerir en este ciclo");
            return { sent: 0, skipped: allCandidates.length };
        }

        // Limitar a MAX_SUGGESTIONS_PER_CYCLE para evitar flood
        const toSuggest = filtered.slice(0, MAX_SUGGESTIONS_PER_CYCLE);
        log("Candidatos: " + filtered.length + " filtrados, enviando " + toSuggest.length + " sugerencias");

        let sent = 0;
        for (const candidate of toSuggest) {
            const ok = await sendSuggestion(candidate);
            if (ok) sent++;
            // Pequeña pausa entre mensajes para no saturar la API de Telegram
            if (sent < toSuggest.length) {
                await new Promise(r => setTimeout(r, 500));
            }
        }

        log("Análisis completado: " + sent + " sugerencias enviadas");
        return { sent, skipped: allCandidates.length - sent };
    } catch (e) {
        log("Error en analyzeSuggestions: " + e.message);
        return { sent: 0, error: e.message };
    }
}

// ─── Handlers de respuesta ────────────────────────────────────────────────────

/**
 * Maneja "Aprobar siempre": persiste el patrón en settings.local.json.
 * @param {string} encodedPattern - patrón en base64url
 * @returns {{ ok: boolean, pattern: string, message: string }}
 */
function handleSuggestionApprove(encodedPattern) {
    try {
        const pattern = Buffer.from(encodedPattern, "base64url").toString("utf8");
        const mainRoot = resolveMainRepoRoot(REPO_ROOT) || REPO_ROOT;
        const settingsPaths = getSettingsPaths(mainRoot);
        const persisted = persistPattern(pattern, settingsPaths, log);
        if (persisted) {
            log("Auto-aprobación persistida: " + pattern);
            return { ok: true, pattern, message: "✅ Guardado: auto-aprobación activada para <code>" + escHtml(pattern) + "</code>" };
        } else {
            log("Patrón ya cubierto o error al persistir: " + pattern);
            return { ok: true, pattern, message: "ℹ️ Patrón ya estaba cubierto: <code>" + escHtml(pattern) + "</code>" };
        }
    } catch (e) {
        log("Error en handleSuggestionApprove: " + e.message);
        return { ok: false, pattern: encodedPattern, message: "Error: " + e.message };
    }
}

/**
 * Maneja "Nunca sugerir": agrega el patrón a ignored.json.
 * @param {string} encodedPattern - patrón en base64url
 * @returns {{ ok: boolean, pattern: string }}
 */
function handleSuggestionNever(encodedPattern) {
    try {
        const pattern = Buffer.from(encodedPattern, "base64url").toString("utf8");
        addToIgnored(pattern);
        return { ok: true, pattern };
    } catch (e) {
        log("Error en handleSuggestionNever: " + e.message);
        return { ok: false, pattern: encodedPattern };
    }
}

module.exports = {
    analyzeSuggestions,
    handleSuggestionApprove,
    handleSuggestionNever,
    addToIgnored,
    loadIgnored,
    getCandidates,
    filterCandidates
};
