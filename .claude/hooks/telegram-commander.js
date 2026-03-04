// telegram-commander.js — Daemon Node.js para recibir comandos via Telegram
// Recibe /skill, texto libre, /help, /status → ejecuta via claude -p
// Pure Node.js — sin dependencias externas
//
// Uso: node telegram-commander.js
// Detener: Ctrl+C o SIGTERM

const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

// ─── Config ──────────────────────────────────────────────────────────────────

const HOOKS_DIR = __dirname;
const REPO_ROOT = path.resolve(HOOKS_DIR, "..", "..");
const CONFIG_FILE = path.join(HOOKS_DIR, "telegram-config.json");
const LOCK_FILE = path.join(HOOKS_DIR, "telegram-commander.lock");
const OFFSET_FILE = path.join(HOOKS_DIR, "tg-commander-offset.json");
const LOG_FILE = path.join(HOOKS_DIR, "hook-debug.log");
const SKILLS_DIR = path.join(REPO_ROOT, ".claude", "skills");
const SPRINT_PLAN_FILE = path.join(REPO_ROOT, "scripts", "sprint-plan.json");
const PROPOSALS_FILE = path.join(HOOKS_DIR, "planner-proposals.json");
const SESSION_STORE_FILE = path.join(HOOKS_DIR, "tg-session-store.json");
const { getPendingQuestions, getExpiredQuestions, retryQuestion, resolveQuestion, getQuestionById, loadQuestions, saveQuestions } = require("./pending-questions");
const { generatePattern, getSettingsPaths, persistPattern, resolveMainRepoRoot } = require("./permission-utils");
const { registerMessage, getStats: getRegistryStats } = require("./telegram-message-registry");
const { cleanup: cleanupMessages } = require("./telegram-cleanup");
const PENDING_QUESTIONS_FILE = path.join(HOOKS_DIR, "pending-questions.json");

const POLL_TIMEOUT_SEC = 30;
const SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutos de inactividad
const POLL_CONFLICT_RETRY_MS = 5000;  // Espera tras error 409 (otro poller activo)
const POLL_CONFLICT_MAX = 8;          // 8 reintentos × 5s = 40s (debe superar POLL_TIMEOUT_SEC=30s para outlast stale connections)
const CONFLICT_COOLDOWN_FILE = path.join(HOOKS_DIR, "telegram-commander.conflict");
const EXEC_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutos
const TG_MSG_MAX = 4096;
const SPRINT_MONITOR_INTERVAL_MS = 5 * 60 * 1000; // 5 minutos
const CLEANUP_TTL_MS = 4 * 60 * 60 * 1000;       // 4 horas
const CLEANUP_INTERVAL_MS = 4 * 60 * 60 * 1000;   // cada 4 horas

let _tgCfg;
try {
    _tgCfg = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
} catch (e) {
    console.error("Error leyendo telegram-config.json:", e.message);
    process.exit(1);
}
const BOT_TOKEN = _tgCfg.bot_token;
const CHAT_ID = _tgCfg.chat_id;

let running = true;
let skills = [];
let sprintRunning = false;  // Evitar lanzar dos sprints simultáneos
let sprintMonitorInterval = null;  // ID del setInterval del monitor periódico
let monitorBusy = false;           // Flag para evitar apilar ejecuciones de monitor
let sprintMonitorIntervalMs = SPRINT_MONITOR_INTERVAL_MS; // Intervalo configurable
let sprintStartTime = null;        // Timestamp de inicio del sprint
let cleanupInterval = null;        // ID del setInterval de limpieza de mensajes
let commandBusy = false;           // Flag para evitar ejecutar dos comandos simultáneos
let commandBusyLabel = "";         // Descripción del comando en ejecución
const PROCESSED_IDS_MAX = 200;     // Máx message_ids en set de deduplicación
const processedMessageIds = new Set(); // Deduplicar mensajes procesados

// ─── Logging ─────────────────────────────────────────────────────────────────

function log(msg) {
    const line = "[" + new Date().toISOString() + "] Commander: " + msg;
    try { fs.appendFileSync(LOG_FILE, line + "\n"); } catch (e) {}
    console.log(line);
}

// ─── Trust pre-registration ──────────────────────────────────────────────────

function preTrustDirectory(absPath) {
    // Claude Code almacena trust en ~/.claude/projects/<path-mangled>/
    // Path mangling: reemplazar :, \, / con -
    const mangled = absPath.replace(/[:\\/]/g, "-");
    const homeDir = process.env.USERPROFILE || process.env.HOME;
    const trustDir = path.join(homeDir, ".claude", "projects", mangled);
    if (!fs.existsSync(trustDir)) {
        fs.mkdirSync(trustDir, { recursive: true });
        log("Trust pre-registrado: " + mangled);
    }
}

// ─── Lockfile ────────────────────────────────────────────────────────────────

const LOCK_STALE_MS = 24 * 60 * 60 * 1000; // 24h — si el lockfile tiene más de esto, es stale seguro

function isProcessAlive(pid) {
    try {
        process.kill(pid, 0); // señal 0 = solo chequear existencia
        return true;
    } catch (e) {
        return false;
    }
}

function isLockStale(data) {
    // Si no tiene PID válido, es stale
    if (!data.pid || typeof data.pid !== "number") return true;
    // Si el proceso no está vivo, es stale
    if (!isProcessAlive(data.pid)) return true;
    // Fallback: si tiene más de 24h, considerarlo stale (protección contra PIDs reciclados)
    if (data.started) {
        const age = Date.now() - new Date(data.started).getTime();
        if (age > LOCK_STALE_MS) return true;
    }
    return false;
}

function acquireLock() {
    if (fs.existsSync(LOCK_FILE)) {
        let data;
        try {
            data = JSON.parse(fs.readFileSync(LOCK_FILE, "utf8"));
        } catch (e) {
            log("Lockfile corrupto. Reemplazando.");
            try { fs.unlinkSync(LOCK_FILE); } catch (e2) {}
            data = null;
        }

        if (data) {
            if (isLockStale(data)) {
                log("Lockfile stale (PID " + data.pid + "). Reemplazando.");
                try { fs.unlinkSync(LOCK_FILE); } catch (e) {}
            } else {
                console.error("Commander ya corriendo (PID " + data.pid + "). Abortando.");
                process.exit(1);
            }
        }
    }
    fs.writeFileSync(LOCK_FILE, JSON.stringify({ pid: process.pid, started: new Date().toISOString() }), "utf8");
    log("Lock adquirido (PID " + process.pid + ")");
}

function releaseLock() {
    try { fs.unlinkSync(LOCK_FILE); } catch (e) {}
}

// ─── Offset persistente ─────────────────────────────────────────────────────

const OFFSET_STALE_GAP_MS = 60 * 1000; // 60 segundos — si el gap es mayor, descartar updates viejos

function loadOffset() {
    try {
        const data = JSON.parse(fs.readFileSync(OFFSET_FILE, "utf8"));
        return { offset: data.offset || 0, timestamp: data.timestamp || null };
    } catch (e) { return { offset: 0, timestamp: null }; }
}

function saveOffset(offset) {
    try {
        fs.writeFileSync(OFFSET_FILE, JSON.stringify({ offset, timestamp: new Date().toISOString() }), "utf8");
    } catch (e) {}
}

/**
 * Detecta si hay un gap temporal grande desde el último offset guardado.
 * Si el gap > 60s, es probable que el commander se cayó y reinició,
 * por lo que los updates intermedios ya fueron consumidos o son stale.
 */
function detectOffsetGap(savedTimestamp) {
    if (!savedTimestamp) return false;
    try {
        const gap = Date.now() - new Date(savedTimestamp).getTime();
        if (gap > OFFSET_STALE_GAP_MS) {
            log("Offset gap detectado: " + Math.round(gap / 1000) + "s desde último save — updates intermedios pueden ser stale");
            return true;
        }
    } catch (e) {}
    return false;
}

// ─── Session store ──────────────────────────────────────────────────────────

function loadSession() {
    try {
        const data = JSON.parse(fs.readFileSync(SESSION_STORE_FILE, "utf8"));
        if (!data.active_session) return null;
        return data.active_session;
    } catch (e) {
        return null;
    }
}

function saveSession(sessionId, skill) {
    const now = new Date().toISOString();
    const session = loadSession();
    const data = {
        active_session: {
            session_id: sessionId,
            last_used: now,
            skill: skill || (session && session.skill) || null,
            created_at: (session && session.session_id === sessionId && session.created_at) || now,
            source: "commander"
        }
    };
    try {
        fs.writeFileSync(SESSION_STORE_FILE, JSON.stringify(data, null, 2), "utf8");
        log("Sesión guardada: " + sessionId + " (skill: " + (data.active_session.skill || "none") + ")");
    } catch (e) {
        log("Error guardando sesión: " + e.message);
    }
}

function clearSessionStore() {
    try {
        fs.writeFileSync(SESSION_STORE_FILE, JSON.stringify({ active_session: null }, null, 2), "utf8");
        log("Sesión limpiada");
    } catch (e) {
        log("Error limpiando sesión: " + e.message);
    }
}

function isSessionExpired(session) {
    if (!session || !session.last_used) return true;
    const elapsed = Date.now() - new Date(session.last_used).getTime();
    return elapsed > SESSION_TTL_MS;
}

function getActiveSessionId() {
    const session = loadSession();
    if (!session || isSessionExpired(session)) return null;
    // Solo resumir sesiones creadas por el commander, nunca sesiones interactivas
    if (session.source !== "commander") {
        log("Sesión " + session.session_id + " ignorada (source: " + (session.source || "unknown") + ", no es del commander)");
        clearSessionStore();
        return null;
    }
    return session.session_id;
}

// ─── HTTP helpers ────────────────────────────────────────────────────────────

function telegramPost(method, params, timeoutMs) {
    return new Promise((resolve, reject) => {
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
        chat_id: CHAT_ID,
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
    // Dividir en chunks respetando el limite de Telegram
    const chunks = [];
    let remaining = text;
    while (remaining.length > 0) {
        if (remaining.length <= TG_MSG_MAX) {
            chunks.push(remaining);
            break;
        }
        // Buscar ultimo salto de linea dentro del limite
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

// ─── Dashboard screenshot + Telegram photo ──────────────────────────────────

const DASHBOARD_PORT = 3100;

function fetchDashboardScreenshot(width, height) {
    return new Promise((resolve) => {
        const req = http.get("http://localhost:" + DASHBOARD_PORT + "/screenshot?w=" + width + "&h=" + height, { timeout: 20000 }, (res) => {
            if (res.statusCode !== 200) { resolve(null); return; }
            const chunks = [];
            res.on("data", (c) => chunks.push(c));
            res.on("end", () => resolve(Buffer.concat(chunks)));
        });
        req.on("error", () => resolve(null));
        req.on("timeout", () => { req.destroy(); resolve(null); });
    });
}

function sendTelegramPhoto(photoBuffer, caption, silent) {
    return new Promise((resolve, reject) => {
        const boundary = "----FormBoundary" + Date.now().toString(36);
        let body = "";
        body += "--" + boundary + "\r\nContent-Disposition: form-data; name=\"chat_id\"\r\n\r\n" + CHAT_ID + "\r\n";
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
            path: "/bot" + BOT_TOKEN + "/sendPhoto",
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

async function handleMonitorDashboard() {
    log("Handling /monitor via dashboard screenshot");
    try {
        const screenshot = await fetchDashboardScreenshot(600, 800);
        if (screenshot && screenshot.length > 1000) {
            const caption = "\ud83d\udcca <b>Intrale Monitor</b>\n" +
                new Date().toLocaleString("es-AR", { timeZone: "America/Argentina/Buenos_Aires" });
            await sendTelegramPhoto(screenshot, caption, false);
            log("/monitor screenshot enviado OK");
            return true;
        }
    } catch (e) {
        log("/monitor screenshot error: " + e.message);
    }

    // Fallback: obtener datos JSON y enviar como texto
    log("/monitor fallback a texto");
    try {
        const statusData = await new Promise((resolve) => {
            const req = http.get("http://localhost:" + DASHBOARD_PORT + "/api/status", { timeout: 5000 }, (res) => {
                let d = ""; res.on("data", c => d += c);
                res.on("end", () => { try { resolve(JSON.parse(d)); } catch { resolve(null); } });
            });
            req.on("error", () => resolve(null));
        });
        if (statusData) {
            let text = "\ud83d\udcca <b>Intrale Monitor</b>\n\n";
            text += "\u25cf Agentes: <b>" + statusData.activeSessions + "</b> activos";
            if (statusData.idleSessions > 0) text += ", " + statusData.idleSessions + " idle";
            text += "\n\u25cf Tareas: <b>" + statusData.completedTasks + "/" + statusData.totalTasks + "</b> completadas\n";
            text += "\u25cf CI: <b>" + (statusData.ciStatus === "ok" ? "\u2705 OK" : statusData.ciStatus === "fail" ? "\u274c FAIL" : statusData.ciStatus) + "</b>\n";
            text += "\u25cf Acciones: <b>" + statusData.totalActions + "</b>\n";
            if (statusData.sessions && statusData.sessions.length > 0) {
                text += "\n<b>Sesiones:</b>\n";
                for (const s of statusData.sessions) {
                    const icon = s.status === "active" ? "\ud83d\udfe2" : s.status === "idle" ? "\ud83d\udfe1" : "\u26aa";
                    text += icon + " <b>" + escHtml(s.agent || s.id) + "</b> (" + escHtml(s.branch || "?") + ") " + s.actions + " acciones\n";
                    if (s.tasks && s.tasks.length > 0) {
                        for (const t of s.tasks) {
                            const tIcon = t.status === "completed" ? "\u2611" : t.status === "in_progress" ? "\u25b6\ufe0f" : "\u2610";
                            text += "  " + tIcon + " " + escHtml(t.subject) + (t.progress > 0 ? " (" + t.progress + "%)" : "") + "\n";
                        }
                    }
                }
            }
            text += "\n\ud83d\udcbb " + new Date().toLocaleString("es-AR", { timeZone: "America/Argentina/Buenos_Aires" });
            await sendLongMessage(text);
            return true;
        }
    } catch (e) {
        log("/monitor fallback text error: " + e.message);
    }

    await sendMessage("\u26a0\ufe0f Dashboard no disponible en localhost:" + DASHBOARD_PORT + ". \u00bfEst\u00e1 corriendo el server?");
    return false;
}

// ─── Skill discovery ─────────────────────────────────────────────────────────

function discoverSkills() {
    const discovered = [];
    let dirs;
    try {
        dirs = fs.readdirSync(SKILLS_DIR);
    } catch (e) {
        log("Error leyendo directorio de skills: " + e.message);
        return discovered;
    }

    for (const dir of dirs) {
        const skillFile = path.join(SKILLS_DIR, dir, "SKILL.md");
        if (!fs.existsSync(skillFile)) continue;

        try {
            const content = fs.readFileSync(skillFile, "utf8");
            const frontmatter = parseFrontmatter(content);
            if (!frontmatter) continue;
            if (frontmatter["user-invocable"] !== true && frontmatter["user-invocable"] !== "true") continue;

            discovered.push({
                name: dir,
                description: frontmatter.description || dir,
                allowedTools: frontmatter["allowed-tools"] || "",
                argumentHint: frontmatter["argument-hint"] || "",
                model: frontmatter.model || ""
            });
        } catch (e) {
            log("Error parseando skill " + dir + ": " + e.message);
        }
    }

    return discovered;
}

function parseFrontmatter(content) {
    const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!match) return null;

    const lines = match[1].split(/\r?\n/);
    const result = {};
    for (const line of lines) {
        const idx = line.indexOf(":");
        if (idx <= 0) continue;
        const key = line.substring(0, idx).trim();
        let value = line.substring(idx + 1).trim();
        // Quitar comillas
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
            value = value.substring(1, value.length - 1);
        }
        // Parsear booleanos
        if (value === "true") value = true;
        else if (value === "false") value = false;
        result[key] = value;
    }
    return result;
}

// ─── Command parsing ─────────────────────────────────────────────────────────

function parseCommand(text) {
    if (!text || typeof text !== "string") return null;
    // Normalizar: quitar @BotName que Telegram agrega a los comandos
    const trimmed = text.trim().replace(/@\S+/, "");

    // /help
    if (trimmed === "/help" || trimmed === "/start") {
        return { type: "help" };
    }

    // /status
    if (trimmed === "/status") {
        return { type: "status" };
    }

    // /stop — detener el daemon
    if (trimmed === "/stop") {
        return { type: "stop" };
    }

    // /pendientes — ver preguntas pendientes sin responder
    if (trimmed === "/pendientes") {
        return { type: "pendientes" };
    }

    // /retry — ver y reactivar preguntas expiradas
    if (trimmed === "/retry") {
        return { type: "retry" };
    }

    // /limpiar — limpiar mensajes antiguos de Telegram
    if (trimmed === "/limpiar") {
        return { type: "limpiar" };
    }

    // /session [clear] — gestión de sesión conversacional
    if (trimmed === "/session") {
        return { type: "session" };
    }
    if (trimmed === "/session clear") {
        return { type: "session_clear" };
    }

    // /sprint interval <N> — cambiar intervalo del monitor periódico
    // /sprint [N] — ejecutar sprint completo o un agente específico
    if (trimmed.startsWith("/sprint")) {
        const parts = trimmed.split(/\s+/);
        if (parts[1] === "interval") {
            const mins = parseInt(parts[2], 10);
            return { type: "sprint_interval", minutes: isNaN(mins) ? null : mins };
        }
        const arg = parts[1] || null; // null = todos, N = agente específico
        return { type: "sprint", agentNumber: arg ? parseInt(arg, 10) : null };
    }

    // /skill args — buscar si el primer token es un skill conocido
    if (trimmed.startsWith("/")) {
        const parts = trimmed.substring(1).split(/\s+/);
        const cmd = parts[0].toLowerCase();
        const args = parts.slice(1).join(" ");

        const skill = skills.find(s => s.name === cmd);
        if (skill) {
            return { type: "skill", skill: skill, args: args };
        }

        // Skill no reconocido
        return { type: "unknown_command", command: cmd };
    }

    // Texto libre → prompt directo a claude -p
    if (trimmed.length > 0) {
        return { type: "freetext", text: trimmed };
    }

    return null;
}

// ─── Ejecución de comandos ───────────────────────────────────────────────────

async function handleHelp() {
    let msg = "🤖 <b>Telegram Commander</b>\n\n";
    msg += "<b>Skills disponibles:</b>\n";
    for (const skill of skills) {
        const hint = skill.argumentHint ? " <code>" + escHtml(skill.argumentHint) + "</code>" : "";
        msg += "  /" + escHtml(skill.name) + hint + "\n";
        msg += "    <i>" + escHtml(skill.description) + "</i>\n";
    }
    msg += "\n<b>Comandos especiales:</b>\n";
    msg += "  /sprint — Ejecutar sprint completo (secuencial)\n";
    msg += "  /sprint N — Ejecutar solo agente N del plan\n";
    msg += "  /sprint interval N — Cambiar intervalo del monitor periódico (N minutos)\n";
    msg += "  /session — Estado de la sesión conversacional activa\n";
    msg += "  /session clear — Limpiar sesión e iniciar conversación nueva\n";
    msg += "  /help — Esta lista\n";
    msg += "  /status — Estado del daemon\n";
    msg += "  /stop — Detener el commander\n";
    msg += "  /pendientes — Preguntas pendientes sin responder\n";
    msg += "  /retry — Reactivar permisos expirados\n";
    msg += "  /limpiar — Borrar mensajes con más de 4 horas\n";
    msg += "\n<b>Monitor periódico:</b>\n";
    msg += "  Durante un sprint, se envía automáticamente un dashboard cada " + Math.round(sprintMonitorIntervalMs / 60000) + " min.\n";
    msg += "\n<b>Texto libre:</b> cualquier mensaje sin / se ejecuta como prompt directo.";
    await sendLongMessage(msg);
}

async function handlePendientes() {
    const pending = getPendingQuestions();
    if (pending.length === 0) {
        await sendMessage("✅ No hay preguntas pendientes.");
        return;
    }

    let msg = "📋 <b>Preguntas pendientes (" + pending.length + ")</b>\n\n";
    const keyboard = [];

    for (let i = 0; i < pending.length; i++) {
        const q = pending[i];
        const age = Math.round((Date.now() - new Date(q.timestamp).getTime()) / 60000);
        const typeEmoji = { permission: "🔐", sprint: "🚀", proposal: "💡" }[q.type] || "❓";

        msg += typeEmoji + " <b>" + (i + 1) + ".</b> " + escHtml(q.message).substring(0, 80) + "\n";
        msg += "   <i>" + q.type + " — hace " + age + " min</i>\n\n";

        if (q.type === "sprint") {
            keyboard.push([
                { text: "🚀 " + (i + 1) + ". Planificar sprint", callback_data: "pq_yes:" + q.id },
                { text: "⏹ " + (i + 1) + ". Descartar", callback_data: "pq_dismiss:" + q.id }
            ]);
        } else if (q.type === "permission") {
            keyboard.push([
                { text: "✅ " + (i + 1) + ". Permitir", callback_data: "pq_allow:" + q.id },
                { text: "❌ " + (i + 1) + ". Descartar", callback_data: "pq_dismiss:" + q.id }
            ]);
        } else {
            keyboard.push([
                { text: "▶️ " + (i + 1) + ". Ejecutar", callback_data: "pq_yes:" + q.id },
                { text: "⏹ " + (i + 1) + ". Descartar", callback_data: "pq_dismiss:" + q.id }
            ]);
        }
    }

    await telegramPost("sendMessage", {
        chat_id: CHAT_ID,
        text: msg,
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: keyboard }
    }, 8000);
}

async function handlePendingCallback(callbackData, callbackQueryId) {
    const parts = callbackData.split(":");
    const action = parts[0]; // pq_yes, pq_allow, pq_dismiss
    const questionId = parts.slice(1).join(":");

    const question = getQuestionById(questionId);
    if (!question || question.status !== "pending") {
        await telegramPost("answerCallbackQuery", {
            callback_query_id: callbackQueryId,
            text: "Pregunta ya resuelta o no encontrada",
            show_alert: true
        }, 5000);
        return;
    }

    if (action === "pq_dismiss") {
        resolveQuestion(questionId, "answered");
        await telegramPost("answerCallbackQuery", {
            callback_query_id: callbackQueryId,
            text: "⏹ Descartada",
            show_alert: false
        }, 5000);
        await sendMessage("⏹ Pregunta descartada: <i>" + escHtml(question.message).substring(0, 60) + "</i>");
        return;
    }

    if (action === "pq_yes" && question.type === "sprint") {
        resolveQuestion(questionId, "answered");
        await telegramPost("answerCallbackQuery", {
            callback_query_id: callbackQueryId,
            text: "🚀 Lanzando sprint...",
            show_alert: false
        }, 5000);
        await sendMessage("🚀 Lanzando <code>/planner sprint</code> desde pregunta pendiente...");
        // Ejecutar /planner sprint
        await executeClaudeQueued("/planner sprint", []);
        return;
    }

    if (action === "pq_allow" && question.type === "permission") {
        resolveQuestion(questionId, "answered");
        await telegramPost("answerCallbackQuery", {
            callback_query_id: callbackQueryId,
            text: "✅ Nota: el permiso original ya expiró. Registrado para referencia.",
            show_alert: true
        }, 5000);
        await sendMessage("✅ Pregunta de permiso resuelta. <i>Nota: la sesión original ya terminó, el permiso se aplicará en futuras solicitudes similares.</i>");
        return;
    }

    // Fallback: ejecutar acción genérica
    resolveQuestion(questionId, "answered");
    await telegramPost("answerCallbackQuery", {
        callback_query_id: callbackQueryId,
        text: "✅ Procesado",
        show_alert: false
    }, 5000);
    if (question.action_data && question.action_data.command) {
        await sendMessage("▶️ Ejecutando: <code>" + escHtml(question.action_data.command) + "</code>");
        await executeClaudeQueued(question.action_data.command, []);
    }
}

async function handleRetry() {
    const expired = getExpiredQuestions();
    if (expired.length === 0) {
        await sendMessage("✅ No hay preguntas expiradas en las últimas 24h.");
        return;
    }

    let msg = "⏱ <b>Preguntas expiradas (" + expired.length + ")</b>\n";
    msg += "<i>Reactivar = aprobar siempre para futuras ejecuciones</i>\n\n";
    const keyboard = [];

    for (let i = 0; i < expired.length; i++) {
        const q = expired[i];
        const age = Math.round((Date.now() - new Date(q.timestamp).getTime()) / 60000);
        const ageLabel = age >= 60 ? Math.floor(age / 60) + "h " + (age % 60) + "m" : age + " min";

        msg += "🔐 <b>" + (i + 1) + ".</b> <code>" + escHtml((q.message || "").substring(0, 80)) + "</code>\n";
        msg += "   <i>hace " + ageLabel + "</i>\n\n";

        keyboard.push([
            { text: "🔄 " + (i + 1) + ". Reactivar", callback_data: "reactivate:" + q.id },
            { text: "⏹ " + (i + 1) + ". Descartar", callback_data: "dismiss_expired:" + q.id }
        ]);
    }

    if (expired.length > 1) {
        keyboard.push([
            { text: "🔄 Reactivar todas", callback_data: "reactivate_all" }
        ]);
    }

    await telegramPost("sendMessage", {
        chat_id: CHAT_ID,
        text: msg,
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: keyboard }
    }, 8000);
}

async function handleReactivateCallback(callbackData, callbackQueryId, messageId) {
    if (callbackData === "reactivate_all") {
        const expired = getExpiredQuestions();
        if (expired.length === 0) {
            await telegramPost("answerCallbackQuery", {
                callback_query_id: callbackQueryId,
                text: "No hay preguntas expiradas",
                show_alert: true
            }, 5000);
            return;
        }

        let persisted = 0;
        const skillsToRelaunch = new Set();
        for (const q of expired) {
            const actionData = retryQuestion(q.id);
            if (actionData && actionData.tool_name) {
                persistPermissionFromActionData(actionData);
                persisted++;
            }
            if (q.skill_context) skillsToRelaunch.add(q.skill_context);
        }

        await telegramPost("answerCallbackQuery", {
            callback_query_id: callbackQueryId,
            text: "🔄 " + persisted + " permisos reactivados",
            show_alert: false
        }, 5000);

        // Editar mensaje: quitar botones y ofrecer re-lanzar skills
        const skillList = Array.from(skillsToRelaunch);
        let editText = "✅ <b>" + persisted + " permisos reactivados</b>\n<i>Próximas ejecuciones se aprobarán automáticamente.</i>";
        const relaunchKeyboard = [];
        if (skillList.length > 0) {
            editText += "\n\n🔄 <b>Skills interrumpidos:</b> " + skillList.map(s => "<code>/" + escHtml(s) + "</code>").join(", ");
            editText += "\n<i>¿Relanzar?</i>";
            for (const s of skillList) {
                relaunchKeyboard.push([
                    { text: "🚀 Relanzar /" + s, callback_data: "relaunch_skill:" + s }
                ]);
            }
        }

        try {
            const editParams = {
                chat_id: CHAT_ID,
                message_id: messageId,
                text: editText,
                parse_mode: "HTML"
            };
            if (relaunchKeyboard.length > 0) {
                editParams.reply_markup = { inline_keyboard: relaunchKeyboard };
            }
            await telegramPost("editMessageText", editParams, 8000);
        } catch (e) { log("Error editando mensaje retry: " + e.message); }

        return;
    }

    // reactivate:<id> o dismiss_expired:<id>
    const parts = callbackData.split(":");
    const action = parts[0];
    const questionId = parts.slice(1).join(":");

    const question = getQuestionById(questionId);
    if (!question) {
        await telegramPost("answerCallbackQuery", {
            callback_query_id: callbackQueryId,
            text: "Pregunta no encontrada",
            show_alert: true
        }, 5000);
        return;
    }

    if (action === "dismiss_expired") {
        resolveQuestion(questionId, "answered");
        await telegramPost("answerCallbackQuery", {
            callback_query_id: callbackQueryId,
            text: "⏹ Descartada",
            show_alert: false
        }, 5000);

        // Editar mensaje original para quitar botones
        try {
            await telegramPost("editMessageReplyMarkup", {
                chat_id: CHAT_ID,
                message_id: messageId,
                reply_markup: { inline_keyboard: [] }
            }, 5000);
        } catch (e) { /* puede fallar si ya no hay botones */ }
        return;
    }

    if (action === "reactivate") {
        if (question.status !== "expired") {
            await telegramPost("answerCallbackQuery", {
                callback_query_id: callbackQueryId,
                text: "Pregunta ya procesada: " + question.status,
                show_alert: false
            }, 5000);
            return;
        }

        const actionData = retryQuestion(questionId);
        if (actionData && actionData.tool_name) {
            persistPermissionFromActionData(actionData);
        }

        await telegramPost("answerCallbackQuery", {
            callback_query_id: callbackQueryId,
            text: "🔄 Permiso reactivado — se aprobará automáticamente",
            show_alert: true
        }, 5000);

        // Editar el mensaje original para reflejar la reactivación + ofrecer relanzar skill
        const desc = (question.message || "").substring(0, 80);
        let editText = "🔄 <b>Permiso reactivado</b>\n<code>" + escHtml(desc) + "</code>\n<i>Próximas ejecuciones se aprobarán automáticamente.</i>";
        const relaunchKb = [];
        if (question.skill_context) {
            editText += "\n\n🔄 Skill interrumpido: <code>/" + escHtml(question.skill_context) + "</code>";
            relaunchKb.push([
                { text: "🚀 Relanzar /" + question.skill_context, callback_data: "relaunch_skill:" + question.skill_context }
            ]);
        }
        try {
            const editParams = {
                chat_id: CHAT_ID,
                message_id: messageId,
                text: editText,
                parse_mode: "HTML"
            };
            if (relaunchKb.length > 0) {
                editParams.reply_markup = { inline_keyboard: relaunchKb };
            }
            await telegramPost("editMessageText", editParams, 5000);
        } catch (e) { log("Error editando mensaje reactivado: " + e.message); }
        return;
    }
}

async function handleLimpiar() {
    await sendMessage("🧹 Limpiando mensajes con más de 4 horas...");
    try {
        const result = await cleanupMessages(CLEANUP_TTL_MS);
        let msg = "🧹 <b>Limpieza completada</b>\n\n";
        msg += "🗑 Borrados: " + result.deleted + "\n";
        if (result.failed > 0) msg += "⚠️ Fallidos: " + result.failed + "\n";
        msg += "📊 Total procesados: " + result.total;
        if (result.total === 0) {
            msg = "✅ No hay mensajes con más de 4 horas para limpiar.";
        }
        await sendMessage(msg);
    } catch (e) {
        log("Error en handleLimpiar: " + e.message);
        await sendMessage("⚠️ Error en limpieza: <code>" + escHtml(e.message) + "</code>");
    }
}

function persistPermissionFromActionData(actionData) {
    const toolName = actionData.tool_name;
    const toolInput = actionData.tool_input || {};

    const pattern = generatePattern(toolName, toolInput);
    if (!pattern) {
        log("persistPermissionFromActionData: no se pudo generar patrón para " + toolName);
        return;
    }

    const settingsPaths = getSettingsPaths(REPO_ROOT);
    persistPattern(pattern, settingsPaths, log);
    log("Permiso persistido via retry: " + pattern);
}

// ─── Permisos por texto libre ─────────────────────────────────────────────────
// Reemplaza los botones inline: el usuario escribe "si", "siempre" o "no" en el chat.
// IMPORTANTE: solo intercepta si el texto **trimmed** es EXACTAMENTE la keyword.
// Esto previene falsos positivos como "siempre lo hace bien" que debería ser freetext normal.

function matchPermissionKeyword(text) {
    const t = text.trim().toLowerCase();
    // Solo keywords exactas (después de trim y lowercase)
    if (["si", "sí", "s", "1", "ok", "dale", "allow"].includes(t)) return "allow";
    if (["siempre", "always", "2"].includes(t)) return "always";
    if (["no", "n", "3", "deny", "denegar"].includes(t)) return "deny";
    return null;
}

async function handleTextPermissionReply(question, action, msgChatId) {
    const requestId = question.id;
    log("Permiso por texto: " + action + " para " + requestId);

    // 1. Marcar como respondida en pending-questions.json
    resolveQuestion(requestId, "answered", "telegram", action);

    // 2. Si es "siempre", persistir el patrón en settings
    if (action === "always" && question.action_data) {
        persistPermissionFromActionData(question.action_data);
    }

    // 3. Editar el mensaje original del permiso para mostrar la decisión
    const confirmText = { allow: "✅ Permitido", always: "✅ Permitido siempre", deny: "❌ Denegado" }[action] || "OK";
    const emojiDecision = { allow: "✅", always: "✅✅", deny: "❌" }[action] || "•";
    if (question.telegram_message_id) {
        const originalHtml = question.original_html || escHtml(question.message || "Permiso solicitado");
        // Quitar la línea de instrucciones "📝 ..." y agregar la decisión
        const cleanHtml = originalHtml.replace(/\n📝 (?:Responder|Usar botones).*$/s, "");
        try {
            await telegramPost("editMessageText", {
                chat_id: CHAT_ID,
                message_id: question.telegram_message_id,
                text: cleanHtml + "\n\n" + emojiDecision + " <b>" + confirmText + "</b> <i>(via texto)</i>",
                parse_mode: "HTML",
                reply_markup: { inline_keyboard: [] }
            }, 5000);
        } catch (e) {
            log("Error editando mensaje permiso (texto): " + (e.message || ""));
        }
    }

    // 4. Confirmar al usuario
    await sendMessage(confirmText);
    log("Permiso procesado via texto: " + action + " para " + requestId);
}

async function handleLatePermissionReply(question, action, msgChatId) {
    const requestId = question.id;
    log("Permiso tardío por texto: " + action + " para " + requestId);

    // El hook ya murió (timeout), pero podemos persistir para la próxima vez
    if (action === "always" && question.action_data) {
        persistPermissionFromActionData(question.action_data);
        resolveQuestion(requestId, "answered", "telegram_late", action);
        // Editar el mensaje original si existe
        if (question.telegram_message_id) {
            const originalHtml = question.original_html || escHtml(question.message || "Permiso solicitado");
            const cleanHtml = originalHtml.replace(/\n📝 Responder.*$/s, "").replace(/\n⏱.*$/s, "");
            try {
                await telegramPost("editMessageText", {
                    chat_id: CHAT_ID,
                    message_id: question.telegram_message_id,
                    text: cleanHtml + "\n\n✅✅ <b>Guardado siempre</b> <i>(tardío)</i>",
                    parse_mode: "HTML"
                }, 5000);
            } catch (e) { /* ok — puede fallar si el mensaje es muy viejo */ }
        }
        await sendMessage("⏱ El hook ya expiró, pero guardé el permiso para la próxima vez");
    } else if (action === "allow") {
        // "allow" tardío no tiene efecto real (hook ya murió), pero informar al usuario
        resolveQuestion(requestId, "answered", "telegram_late", action);
        await sendMessage("⏱ El hook ya expiró — el permiso puntual no aplica. Usá <b>siempre</b> para guardarlo.");
    }
}

async function handleStatus() {
    const uptime = process.uptime();
    const hours = Math.floor(uptime / 3600);
    const mins = Math.floor((uptime % 3600) / 60);
    const secs = Math.floor(uptime % 60);

    let msg = "📊 <b>Commander Status</b>\n\n";
    msg += "🟢 Online\n";
    msg += "⏱ Uptime: " + hours + "h " + mins + "m " + secs + "s\n";
    msg += "🔧 Skills: " + skills.length + "\n";
    msg += "🆔 PID: " + process.pid + "\n";
    msg += "📁 Repo: <code>" + escHtml(REPO_ROOT) + "</code>\n";

    // Info de sesión conversacional
    const session = loadSession();
    if (session && !isSessionExpired(session)) {
        const elapsed = Date.now() - new Date(session.last_used).getTime();
        const remainingMins = Math.max(0, Math.floor((SESSION_TTL_MS - elapsed) / 60000));
        msg += "\n🔗 <b>Sesión activa</b>\n";
        msg += "🏷 Skill: " + escHtml(session.skill || "(texto libre)") + "\n";
        msg += "⏳ Expira en: " + remainingMins + " min\n";
    } else {
        msg += "\n💬 Sin sesión activa\n";
    }

    if (sprintRunning) {
        msg += "\n🏃 <b>Sprint en curso</b>\n";
        if (sprintMonitorInterval) {
            msg += "📊 Monitor periódico: activo (cada " + Math.round(sprintMonitorIntervalMs / 60000) + " min)\n";
        } else {
            msg += "📊 Monitor periódico: inactivo\n";
        }
    } else {
        msg += "\n💤 Sin sprint activo\n";
        msg += "📊 Intervalo de monitor: " + Math.round(sprintMonitorIntervalMs / 60000) + " min\n";
    }

    // Message registry stats
    const regStats = getRegistryStats();
    msg += "\n📨 <b>Message registry</b>\n";
    msg += "📊 Total: " + regStats.total + " mensajes\n";
    if (regStats.total > 0) {
        const cats = Object.entries(regStats.byCategory).map(([k, v]) => k + ":" + v).join(", ");
        msg += "🏷 Categorías: " + escHtml(cats) + "\n";
        if (regStats.oldest) {
            const ageH = Math.round((Date.now() - regStats.oldest) / 3600000);
            msg += "🕐 Más antiguo: hace " + ageH + "h\n";
        }
    }

    await sendMessage(msg);
}

async function handleSession() {
    const session = loadSession();
    if (!session || isSessionExpired(session)) {
        await sendMessage("💤 <b>Sin sesión activa</b>\n\nEl próximo mensaje iniciará una sesión nueva.");
        return;
    }
    const elapsed = Date.now() - new Date(session.last_used).getTime();
    const remainingMs = SESSION_TTL_MS - elapsed;
    const remainingMins = Math.max(0, Math.floor(remainingMs / 60000));
    const remainingSecs = Math.max(0, Math.floor((remainingMs % 60000) / 1000));
    const createdAt = session.created_at || "?";
    const lastUsed = session.last_used || "?";

    let msg = "🔗 <b>Sesión activa</b>\n\n";
    msg += "🆔 ID: <code>" + escHtml(session.session_id) + "</code>\n";
    msg += "🏷 Skill: " + escHtml(session.skill || "(texto libre)") + "\n";
    msg += "📅 Creada: " + escHtml(createdAt) + "\n";
    msg += "🕐 Último uso: " + escHtml(lastUsed) + "\n";
    msg += "⏳ Expira en: " + remainingMins + "m " + remainingSecs + "s\n";
    msg += "\nUsá <code>/session clear</code> para iniciar una sesión nueva.";
    await sendMessage(msg);
}

async function handleSessionClear() {
    clearSessionStore();
    await sendMessage("🗑 <b>Sesión limpiada</b>\n\nEl próximo mensaje iniciará una conversación nueva.");
}

async function handleSkill(skill, args) {
    if (commandBusy) {
        const pendingPerms = getPendingQuestions().filter(q => q.type === "permission");
        if (pendingPerms.length > 0) {
            const q = pendingPerms[pendingPerms.length - 1];
            const toolName = q.action_data && q.action_data.tool_name ? escHtml(q.action_data.tool_name) : "un tool";
            await sendMessage("⏳ <b>Hay un permiso bloqueante pendiente</b> para " + toolName + ".\n"
                + "Respondé con: <b>si</b>, <b>siempre</b>, <b>no</b>, o <b>cancelar permiso</b>");
        } else {
            await sendMessage("⏳ Ya hay un comando en ejecución (<code>" + escHtml(commandBusyLabel) + "</code>). Esperá a que termine.");
        }
        return;
    }

    // /monitor sin args: enviar screenshot del dashboard directamente (rápido, sin API call)
    if (skill.name === "monitor" && (!args || !args.trim())) {
        await sendMessage("\ud83d\udcca Capturando dashboard...");
        await handleMonitorDashboard();
        return;
    }

    const skillLabel = "/" + skill.name + (args ? " " + args : "");
    await sendMessage("⚡ Ejecutando <code>" + escHtml(skillLabel) + "</code>...");

    // Construir el prompt para claude -p
    // El Skill tool espera: skill name + args
    const skillInvocation = "/" + skill.name + (args ? " " + args : "");
    const prompt = skillInvocation;

    // Construir allowed-tools: Skill + los tools declarados en el frontmatter
    const toolsList = ["Skill"];
    if (skill.allowedTools) {
        const extras = skill.allowedTools.split(",").map(t => t.trim()).filter(t => t);
        for (const t of extras) {
            if (!toolsList.includes(t)) toolsList.push(t);
        }
    }

    const extraArgs = ["--allowedTools", toolsList.join(",")];
    if (skill.model) {
        extraArgs.push("--model", skill.model);
    }

    const result = await executeClaudeQueued(prompt, extraArgs, { useSession: true, skill: skill.name });
    await sendResult(skillLabel, result);
}

async function handleFreetext(text) {
    if (commandBusy) {
        const pendingPerms = getPendingQuestions().filter(q => q.type === "permission");
        if (pendingPerms.length > 0) {
            const q = pendingPerms[pendingPerms.length - 1];
            const toolName = q.action_data && q.action_data.tool_name ? escHtml(q.action_data.tool_name) : "un tool";
            await sendMessage("⏳ <b>Hay un permiso bloqueante pendiente</b> para " + toolName + ".\n"
                + "Respondé con: <b>si</b>, <b>siempre</b>, <b>no</b>, o <b>cancelar permiso</b>");
        } else {
            await sendMessage("⏳ Ya hay un comando en ejecución (<code>" + escHtml(commandBusyLabel) + "</code>). Esperá a que termine.");
        }
        return;
    }

    await sendMessage("💬 Procesando: <code>" + escHtml(text.substring(0, 100)) + (text.length > 100 ? "…" : "") + "</code>");

    await executeClaudeQueued(text, [], { useSession: true, skill: null });
}

// ─── Sprint execution ────────────────────────────────────────────────────────

function loadSprintPlan() {
    try {
        return JSON.parse(fs.readFileSync(SPRINT_PLAN_FILE, "utf8"));
    } catch (e) {
        return null;
    }
}

function formatSprintProgress(agentes, currentIdx, results) {
    let msg = "";
    for (let i = 0; i < agentes.length; i++) {
        const a = agentes[i];
        let icon;
        if (results[i] === "success") icon = "☑";
        else if (results[i] === "failed") icon = "☒";
        else if (i === currentIdx) icon = "☐►";
        else icon = "☐";
        msg += icon + " <b>#" + a.numero + "</b> #" + a.issue + " " + escHtml(a.slug) + " [" + a.size + "]\n";
    }
    return msg;
}

function stopSprintMonitor() {
    if (sprintMonitorInterval) {
        clearInterval(sprintMonitorInterval);
        sprintMonitorInterval = null;
        log("Monitor periódico detenido");
    }
    monitorBusy = false;
}

function startSprintMonitor() {
    stopSprintMonitor(); // Limpiar cualquier intervalo previo
    log("Iniciando monitor periódico cada " + Math.round(sprintMonitorIntervalMs / 60000) + " min");

    sprintMonitorInterval = setInterval(async () => {
        if (monitorBusy) {
            log("Monitor periódico: ejecución anterior aún en curso, omitiendo ciclo");
            return;
        }
        if (!running || !sprintRunning) {
            stopSprintMonitor();
            return;
        }

        monitorBusy = true;
        try {
            const elapsed = Math.round((Date.now() - sprintStartTime) / 1000);
            const elapsedMins = Math.floor(elapsed / 60);
            const elapsedSecs = elapsed % 60;

            log("Monitor periódico: ejecutando /monitor");
            const result = await executeClaudeQueued("/monitor", [
                "--allowedTools", "Bash,Read,Glob,Grep,TaskList",
                "--model", "claude-haiku-4-5-20251001"
            ]);

            if (!running || !sprintRunning) return; // Sprint terminó mientras corría el monitor

            let monitorOutput = "";
            if (result.code === 0) {
                try {
                    const json = JSON.parse(result.stdout);
                    monitorOutput = json.result || json.text || json.content || result.stdout;
                } catch (e) {
                    monitorOutput = result.stdout;
                }
            } else {
                monitorOutput = "(error ejecutando monitor — exit " + result.code + ")";
            }

            const header = "📊 <b>Monitor — sprint en curso (" + elapsedMins + "m " + elapsedSecs + "s)</b>\n\n";
            await sendLongMessage(header + escHtml(monitorOutput));
        } catch (e) {
            log("Monitor periódico: error — " + e.message);
        } finally {
            monitorBusy = false;
        }
    }, sprintMonitorIntervalMs);
}

async function handleSprintInterval(minutes) {
    if (minutes === null || minutes <= 0) {
        await sendMessage("⚠️ Uso: <code>/sprint interval N</code> (N = minutos, mayor a 0)");
        return;
    }
    sprintMonitorIntervalMs = minutes * 60 * 1000;
    log("Intervalo de monitor cambiado a " + minutes + " min");

    let msg = "✅ Intervalo de monitor cambiado a <b>" + minutes + " min</b>";

    // Si hay un sprint corriendo, reiniciar el intervalo con el nuevo valor
    if (sprintRunning && sprintMonitorInterval) {
        stopSprintMonitor();
        startSprintMonitor();
        msg += "\n📊 Monitor periódico reiniciado con nuevo intervalo.";
    }
    await sendMessage(msg);
}

async function handleSprint(agentNumber) {
    // Sprint siempre inicia sesión nueva (contexto independiente)
    clearSessionStore();

    if (sprintRunning) {
        await sendMessage("⚠️ Ya hay un sprint en ejecución. Esperá a que termine o usá /stop para detener el commander.");
        return;
    }

    const plan = loadSprintPlan();
    if (!plan || !plan.agentes || plan.agentes.length === 0) {
        await sendMessage("❌ No se encontró <code>scripts/sprint-plan.json</code> o está vacío.\nUsá <code>/planner sprint</code> para generar uno.");
        return;
    }

    // Filtrar agentes si se pidió uno específico
    let agentes = plan.agentes;
    if (agentNumber !== null) {
        agentes = agentes.filter(a => a.numero === agentNumber);
        if (agentes.length === 0) {
            const available = plan.agentes.map(a => a.numero).join(", ");
            await sendMessage("❌ Agente #" + agentNumber + " no encontrado en el plan.\nDisponibles: " + available);
            return;
        }
    }

    sprintRunning = true;
    sprintStartTime = Date.now();
    const results = new Array(agentes.length).fill("pending");

    // Mensaje inicial con checklist
    let header = "🏃 <b>Sprint iniciado</b> — " + escHtml(plan.titulo) + "\n";
    header += "📅 " + escHtml(plan.fecha) + " · " + agentes.length + " agente(s)\n";
    header += "📊 Monitor periódico: cada " + Math.round(sprintMonitorIntervalMs / 60000) + " min\n\n";
    header += formatSprintProgress(agentes, 0, results);
    await sendMessage(header);

    // Arrancar monitor periódico
    // Pre-registrar confianza del directorio de trabajo
    preTrustDirectory(REPO_ROOT);

    startSprintMonitor();

    for (let i = 0; i < agentes.length; i++) {
        if (!running) {
            log("Sprint interrumpido por shutdown");
            break;
        }

        const agente = agentes[i];
        log("Sprint: ejecutando agente #" + agente.numero + " (issue #" + agente.issue + " " + agente.slug + ")");

        // Notificar inicio de este agente
        let progressMsg = "⚡ <b>Agente #" + agente.numero + "</b> — " + escHtml(agente.titulo) + "\n";
        progressMsg += "Issue #" + agente.issue + " · Size " + agente.size + "\n\n";
        progressMsg += formatSprintProgress(agentes, i, results);
        await sendMessage(progressMsg);

        // Ejecutar claude -p con el prompt del agente (via stdin)
        const result = await executeClaudeQueued(agente.prompt);

        if (result.code === 0) {
            results[i] = "success";
            log("Sprint: agente #" + agente.numero + " completado OK");

            // Extraer resumen del resultado
            let summary = "";
            try {
                const json = JSON.parse(result.stdout);
                const text = json.result || json.text || json.content || "";
                summary = text.substring(0, 500);
                if (text.length > 500) summary += "…";
            } catch (e) {
                summary = result.stdout.substring(0, 500);
                if (result.stdout.length > 500) summary += "…";
            }

            let doneMsg = "✅ <b>Agente #" + agente.numero + " completado</b> — " + escHtml(agente.slug) + "\n\n";
            if (summary) doneMsg += escHtml(summary) + "\n\n";
            doneMsg += formatSprintProgress(agentes, i + 1, results);
            await sendLongMessage(doneMsg);
        } else {
            results[i] = "failed";
            log("Sprint: agente #" + agente.numero + " falló (exit " + result.code + ")");

            let errMsg = "❌ <b>Agente #" + agente.numero + " falló</b> — " + escHtml(agente.slug) + "\n";
            errMsg += "Exit code: " + result.code + "\n";
            if (result.stderr) {
                errMsg += "<pre>" + escHtml(result.stderr.substring(0, 1000)) + "</pre>\n";
            }
            errMsg += "\n" + formatSprintProgress(agentes, i + 1, results);
            await sendLongMessage(errMsg);
        }
    }

    // Detener monitor periódico
    stopSprintMonitor();

    // Resumen final
    const elapsed = Math.round((Date.now() - sprintStartTime) / 1000);
    const mins = Math.floor(elapsed / 60);
    const secs = elapsed % 60;
    const successCount = results.filter(r => r === "success").length;
    const failCount = results.filter(r => r === "failed").length;

    let finalMsg = "🏁 <b>Sprint finalizado</b>\n\n";
    finalMsg += formatSprintProgress(agentes, -1, results) + "\n";
    finalMsg += "✅ " + successCount + " exitosos · ❌ " + failCount + " fallidos\n";
    finalMsg += "⏱ " + mins + "m " + secs + "s";
    await sendMessage(finalMsg);

    sprintRunning = false;
    sprintStartTime = null;
}

// ─── Execution lock — una sola sesión activa a la vez ────────────────────────

let _executionBusy = false;

function isCommandBusy() {
    return _executionBusy;
}

function getCommandBusyLabel() {
    return commandBusyLabel;
}

async function executeClaudeQueued(prompt, extraArgs, options) {
    if (_executionBusy) {
        log("executeClaude: ya hay una ejecución en curso — RECHAZANDO (no encolar)");
        return { code: -2, stdout: "", stderr: "busy", sessionId: null };
    }
    _executionBusy = true;
    commandBusy = true;
    commandBusyLabel = (prompt || "").substring(0, 80);
    try {
        const result = await executeClaude(prompt, extraArgs, options);
        return result;
    } finally {
        _executionBusy = false;
        commandBusy = false;
        commandBusyLabel = "";
    }
}

// prompt va por stdin para evitar que cmd.exe rompa args con --/espacios
// options: { useSession: bool, skill: string } — si useSession=true, intenta --resume
function executeClaude(prompt, extraArgs, options) {
    const opts = options || {};
    return new Promise((resolve) => {
        // --permission-mode bypassPermissions evita que permission-approver.js
        // active su propio getUpdates, lo cual causa 409 Conflict con nuestro polling.
        // Es seguro porque: tools restringidos via --allowedTools + prompts controlados.
        const args = ["-p", "--output-format", "json", "--permission-mode", "bypassPermissions"].concat(extraArgs || []);

        // Soporte de sesión: agregar --resume si hay sesión activa
        let resumedSessionId = null;
        if (opts.useSession) {
            const activeId = getActiveSessionId();
            if (activeId) {
                args.push("--resume", activeId);
                resumedSessionId = activeId;
                log("Resumiendo sesión: " + activeId);
            }
        }

        log("Ejecutando: claude " + args.join(" ") + " (prompt via stdin, " + prompt.length + " chars)");

        // Pre-registrar confianza del directorio de trabajo
        preTrustDirectory(REPO_ROOT);

        const cleanEnv = { ...process.env, CLAUDE_PROJECT_DIR: REPO_ROOT };
        delete cleanEnv.CLAUDECODE;

        const proc = spawn("claude", args, {
            cwd: REPO_ROOT,
            env: cleanEnv,
            stdio: ["pipe", "pipe", "pipe"],
            shell: true,
            timeout: EXEC_TIMEOUT_MS
        });

        // Enviar prompt via stdin y cerrar
        proc.stdin.write(prompt);
        proc.stdin.end();

        let stdout = "";
        let stderr = "";

        proc.stdout.on("data", (d) => { stdout += d.toString(); });
        proc.stderr.on("data", (d) => { stderr += d.toString(); });

        let resolved = false;
        function finish(code) {
            if (resolved) return;
            resolved = true;
            clearTimeout(timer);
            log("claude terminó con código " + code + " (stdout: " + stdout.length + " bytes, stderr: " + stderr.length + " bytes)");
            if (stderr) log("STDERR: " + stderr.substring(0, 500));

            // Extraer session_id del JSON de respuesta y persistir
            let sessionId = null;
            if (opts.useSession && code === 0) {
                try {
                    const json = JSON.parse(stdout);
                    sessionId = json.session_id || null;
                    if (sessionId) {
                        saveSession(sessionId, opts.skill || null);
                    }
                } catch (e) {
                    log("No se pudo parsear session_id del output: " + e.message);
                }
            }

            // Si resumimos pero claude falló (sesión inválida), reintentar sin --resume
            if (opts.useSession && resumedSessionId && code !== 0) {
                const stderrLower = (stderr || "").toLowerCase();
                if (stderrLower.includes("session") || stderrLower.includes("invalid") || stderrLower.includes("not found")) {
                    log("Sesión inválida detectada — limpiando y reintentando sin --resume");
                    clearSessionStore();
                    // Reintentar sin useSession (evitar recursión infinita)
                    executeClaude(prompt, extraArgs, { useSession: false, skill: opts.skill }).then(resolve);
                    return;
                }
            }

            resolve({ code, stdout, stderr, sessionId });
        }

        const timer = setTimeout(() => {
            log("Timeout ejecutando claude — matando proceso (PID " + proc.pid + ")");
            // En Windows, SIGTERM no mata procesos con shell:true.
            // Usar taskkill /T (tree kill) para matar el árbol completo.
            try {
                spawn("taskkill", ["/PID", String(proc.pid), "/T", "/F"], { shell: true, stdio: "ignore" });
            } catch (e) {}
            // Fallback: resolver después de 3s aunque close no se dispare
            setTimeout(() => finish(-1), 3000);
        }, EXEC_TIMEOUT_MS);

        proc.on("close", (code) => finish(code));

        proc.on("error", (e) => {
            log("Error spawning claude: " + e.message);
            finish(-1);
        });
    });
}

async function sendResult(label, result) {
    let output = "";

    if (result.code !== 0) {
        output = "❌ <b>Error</b> (exit code " + result.code + ")\n\n";
        // Extraer mensaje útil del error
        let errorDetail = "";
        if (result.stderr) {
            errorDetail = result.stderr.substring(0, 2000);
        }
        if (!errorDetail && result.stdout) {
            // Intentar extraer error del JSON de claude
            try {
                const json = JSON.parse(result.stdout);
                const text = json.result || json.text || json.content || "";
                if (text) errorDetail = text.substring(0, 2000);
            } catch {
                // Detectar errores de API comunes
                if (result.stdout.includes("API Error: 403") || result.stdout.includes("Cloudflare")) {
                    errorDetail = "API temporalmente no disponible (Cloudflare 403). Reintentar en unos minutos.";
                } else if (result.stdout.includes("API Error")) {
                    const m = result.stdout.match(/API Error: \d+/);
                    errorDetail = m ? m[0] + " — reintentar en unos minutos" : result.stdout.substring(0, 500);
                } else {
                    errorDetail = result.stdout.substring(0, 500);
                }
            }
        }
        if (errorDetail) output += "<pre>" + escHtml(errorDetail) + "</pre>";
        else output += "<i>Sin detalle de error disponible</i>";
        await sendLongMessage(output);
        return;
    }

    // Intentar parsear JSON de claude --output-format json
    try {
        const json = JSON.parse(result.stdout);
        const text = json.result || json.text || json.content || result.stdout;
        output = "✅ <b>" + escHtml(label) + "</b>\n\n" + escHtml(text);
    } catch (e) {
        // No es JSON — enviar raw
        output = "✅ <b>" + escHtml(label) + "</b>\n\n" + escHtml(result.stdout || "(sin output)");
    }

    await sendLongMessage(output);
}

// ─── Proposal callbacks (planner proponer) ──────────────────────────────────

function loadProposals() {
    try {
        return JSON.parse(fs.readFileSync(PROPOSALS_FILE, "utf8"));
    } catch (e) {
        return null;
    }
}

function saveProposals(data) {
    try {
        fs.writeFileSync(PROPOSALS_FILE, JSON.stringify(data, null, 2), "utf8");
    } catch (e) {
        log("Error guardando planner-proposals.json: " + e.message);
    }
}

function buildProposalStatusText(data) {
    const EFFORT_LABELS = { S: "S (1d)", M: "M (2-3d)", L: "L (1sem)", XL: "XL (2+sem)" };
    const STATUS_ICONS = { pending: "⏳", created: "✅", discarded: "❌" };
    let text = "📋 <b>Propuestas del Planner</b>\n";
    text += "<i>Generado: " + escHtml(data.generated_at || "?") + "</i>\n\n";
    for (const p of data.proposals) {
        const icon = STATUS_ICONS[p.status] || "⏳";
        const effort = EFFORT_LABELS[p.effort] || p.effort;
        const statusLabel = p.status === "created" ? " — Creado"
            : p.status === "discarded" ? " — Descartado"
            : "";
        text += icon + " <b>" + (p.index + 1) + ". " + escHtml(p.title) + "</b>" + statusLabel + "\n";
        text += "   📏 " + escHtml(effort) + " · 🏷 " + escHtml((p.labels || []).join(", ")) + "\n";
    }
    return text;
}

function buildRemainingKeyboard(data) {
    const keyboard = [];
    for (const p of data.proposals) {
        if (p.status !== "pending") continue;
        keyboard.push([
            { text: "✅ " + (p.index + 1) + ". Crear", callback_data: "create_proposal:" + p.index },
            { text: "❌ " + (p.index + 1) + ". Descartar", callback_data: "discard_proposal:" + p.index }
        ]);
    }
    const pendingCount = data.proposals.filter(p => p.status === "pending").length;
    if (pendingCount > 1) {
        keyboard.push([
            { text: "✅ Crear todas las propuestas", callback_data: "create_all_proposals" }
        ]);
    }
    return keyboard;
}

async function handleProposalCallback(callbackData, callbackQueryId) {
    const data = loadProposals();
    if (!data || !data.proposals) {
        await telegramPost("answerCallbackQuery", {
            callback_query_id: callbackQueryId,
            text: "No hay propuestas activas",
            show_alert: true
        }, 5000);
        return;
    }

    const msgId = data.telegram_message_id;

    if (callbackData === "create_all_proposals") {
        // Crear todas las propuestas pendientes
        await telegramPost("answerCallbackQuery", {
            callback_query_id: callbackQueryId,
            text: "Creando todas las propuestas...",
            show_alert: false
        }, 5000);

        const pending = data.proposals.filter(p => p.status === "pending");
        if (pending.length === 0) {
            await sendMessage("⚠️ No hay propuestas pendientes.");
            return;
        }

        // Marcar todas como creadas y actualizar mensaje
        for (const p of pending) {
            p.status = "created";
        }
        saveProposals(data);

        // Editar mensaje: quitar botones, mostrar estado final
        if (msgId) {
            try {
                await telegramPost("editMessageText", {
                    chat_id: CHAT_ID,
                    message_id: msgId,
                    text: buildProposalStatusText(data),
                    parse_mode: "HTML"
                }, 8000);
            } catch (e) { log("Error editando mensaje de propuestas: " + e.message); }
        }

        // Lanzar /historia por cada propuesta (secuencialmente para no saturar)
        for (const p of pending) {
            await launchHistoriaForProposal(p);
        }

        await sendMessage("✅ <b>" + pending.length + " propuesta(s) enviadas a /historia</b>");
        return;
    }

    // create_proposal:<idx> o discard_proposal:<idx>
    const parts = callbackData.split(":");
    const action = parts[0];
    const idx = parseInt(parts[1], 10);

    const proposal = data.proposals.find(p => p.index === idx);
    if (!proposal) {
        await telegramPost("answerCallbackQuery", {
            callback_query_id: callbackQueryId,
            text: "Propuesta no encontrada",
            show_alert: true
        }, 5000);
        return;
    }

    if (proposal.status !== "pending") {
        await telegramPost("answerCallbackQuery", {
            callback_query_id: callbackQueryId,
            text: "Propuesta ya procesada: " + proposal.status,
            show_alert: false
        }, 5000);
        return;
    }

    if (action === "create_proposal") {
        proposal.status = "created";
        saveProposals(data);

        await telegramPost("answerCallbackQuery", {
            callback_query_id: callbackQueryId,
            text: "✅ Creando: " + proposal.title.substring(0, 50),
            show_alert: false
        }, 5000);

        // Editar mensaje con estado actualizado y botones restantes
        if (msgId) {
            try {
                const keyboard = buildRemainingKeyboard(data);
                const editParams = {
                    chat_id: CHAT_ID,
                    message_id: msgId,
                    text: buildProposalStatusText(data),
                    parse_mode: "HTML"
                };
                if (keyboard.length > 0) {
                    editParams.reply_markup = { inline_keyboard: keyboard };
                }
                await telegramPost("editMessageText", editParams, 8000);
            } catch (e) { log("Error editando mensaje de propuestas: " + e.message); }
        }

        // Lanzar /historia
        await launchHistoriaForProposal(proposal);

    } else if (action === "discard_proposal") {
        proposal.status = "discarded";
        saveProposals(data);

        await telegramPost("answerCallbackQuery", {
            callback_query_id: callbackQueryId,
            text: "❌ Descartada: " + proposal.title.substring(0, 50),
            show_alert: false
        }, 5000);

        // Editar mensaje con estado actualizado y botones restantes
        if (msgId) {
            try {
                const keyboard = buildRemainingKeyboard(data);
                const editParams = {
                    chat_id: CHAT_ID,
                    message_id: msgId,
                    text: buildProposalStatusText(data),
                    parse_mode: "HTML"
                };
                if (keyboard.length > 0) {
                    editParams.reply_markup = { inline_keyboard: keyboard };
                }
                await telegramPost("editMessageText", editParams, 8000);
            } catch (e) { log("Error editando mensaje de propuestas: " + e.message); }
        }
    }
}

async function launchHistoriaForProposal(proposal) {
    const labels = (proposal.labels || []).join(", ");
    const deps = (proposal.dependencies || []).length > 0
        ? "Dependencias: " + proposal.dependencies.map(d => "#" + d).join(", ")
        : "";

    // Construir prompt completo para /historia con todo el contexto de la propuesta
    let prompt = "/historia " + proposal.title + "\n\n";
    prompt += "Justificación: " + (proposal.justification || "") + "\n";
    prompt += "Labels: " + labels + "\n";
    prompt += "Esfuerzo estimado: " + (proposal.effort || "M") + "\n";
    prompt += "Stream: " + (proposal.stream || "") + "\n";
    if (deps) prompt += deps + "\n";
    if (proposal.body) prompt += "\nDetalle:\n" + proposal.body + "\n";

    log("Lanzando /historia para propuesta #" + proposal.index + ": " + proposal.title);
    await sendMessage("⚡ Creando issue: <b>" + escHtml(proposal.title) + "</b>...");

    // Buscar skill historia para obtener sus tools y model
    const historiaSkill = skills.find(s => s.name === "historia");
    const toolsList = ["Skill"];
    if (historiaSkill && historiaSkill.allowedTools) {
        const extras = historiaSkill.allowedTools.split(",").map(t => t.trim()).filter(t => t);
        for (const t of extras) {
            if (!toolsList.includes(t)) toolsList.push(t);
        }
    }

    const extraArgs = ["--allowedTools", toolsList.join(",")];
    if (historiaSkill && historiaSkill.model) {
        extraArgs.push("--model", historiaSkill.model);
    }

    const result = await executeClaudeQueued(prompt, extraArgs, { useSession: true, skill: "historia" });
    await sendResult("/historia — " + proposal.title, result);
}

// ─── Polling loop ────────────────────────────────────────────────────────────

async function pollingLoop() {
    const savedOffset = loadOffset();
    let offset = savedOffset.offset;
    const hasGap = detectOffsetGap(savedOffset.timestamp);

    // Si hay gap temporal grande, descartar todos los updates pendientes con offset=-1
    // para evitar procesar callbacks y mensajes stale de sesiones anteriores
    if (hasGap) {
        log("Gap >60s detectado — descartando updates viejos con getUpdates offset=-1");
        try {
            const stale = await telegramPost("getUpdates", {
                offset: -1,
                limit: 1,
                timeout: 0,
                allowed_updates: ["message", "callback_query"]
            }, 5000);
            if (stale && stale.length > 0) {
                offset = stale[stale.length - 1].update_id + 1;
                log("Offset actualizado post-gap: " + offset + " (descartados updates stale)");
            }
        } catch (e) {
            log("Error descartando updates stale: " + e.message);
        }
    }

    // Avanzar offset para ignorar updates anteriores al arranque
    // Reintentar hasta 3 veces si hay conflicto 409 con otro poller
    let startupConflicts = 0;
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            const pending = await telegramPost("getUpdates", {
                limit: 100,
                timeout: 0,
                allowed_updates: ["message", "callback_query"]
            }, 5000);
            if (pending && pending.length > 0) {
                const maxId = pending[pending.length - 1].update_id;
                if (maxId >= offset) {
                    offset = maxId + 1;
                    log("Descartados " + pending.length + " updates previos. Nuevo offset: " + offset);
                }
            }
            startupConflicts = 0; // Éxito — resetear
            break;
        } catch (e) {
            const is409 = (e.message || "").includes("409");
            log("Error obteniendo updates iniciales (intento " + (attempt + 1) + "): " + e.message);
            if (is409) {
                startupConflicts++;
                if (attempt < 2) {
                    await sleep(2000);
                }
            }
        }
    }

    // Si todos los intentos de startup dieron 409, otro commander está activo — SALIR
    if (startupConflicts >= 3) {
        log("FATAL: 3 conflictos 409 en startup — otro Commander ya controla el polling. SALIENDO.");
        // Escribir cooldown para que el launcher NO relance inmediatamente
        try { fs.writeFileSync(CONFLICT_COOLDOWN_FILE, JSON.stringify({ ts: Date.now(), pid: process.pid }), "utf8"); } catch (e2) {}
        releaseLock();
        process.exit(1);
    }

    saveOffset(offset);

    // Startup exitoso — limpiar cooldown si existe
    try { fs.unlinkSync(CONFLICT_COOLDOWN_FILE); } catch (e) {}

    let conflictStreak = 0;  // Contador de 409s consecutivos

    while (running) {
        let updates;
        try {
            updates = await telegramPost("getUpdates", {
                offset: offset,
                timeout: POLL_TIMEOUT_SEC,
                allowed_updates: ["message", "callback_query"]
            }, (POLL_TIMEOUT_SEC + 10) * 1000);
            // Éxito — resetear conflicto
            if (conflictStreak > 0) {
                log("Polling OK — reseteando conflicto streak");
                conflictStreak = 0;
            }
        } catch (e) {
            const errStr = e.message || "";
            const is409 = errStr.includes("409") || errStr.includes("Conflict");
            if (is409) {
                conflictStreak++;
                if (conflictStreak <= POLL_CONFLICT_MAX) {
                    log("Conflicto 409 (" + conflictStreak + "/" + POLL_CONFLICT_MAX + ") — reintentando en " + POLL_CONFLICT_RETRY_MS + "ms");
                    await sleep(POLL_CONFLICT_RETRY_MS);
                } else {
                    // Otro poller activo — este proceso DEBE morir para evitar respuestas duplicadas
                    log("FATAL: Conflicto 409 persistente (" + conflictStreak + " seguidos, " + (conflictStreak * POLL_CONFLICT_RETRY_MS / 1000) + "s) — otro Commander ya controla el polling. SALIENDO.");
                    // Escribir cooldown para que el launcher NO relance inmediatamente
                    try { fs.writeFileSync(CONFLICT_COOLDOWN_FILE, JSON.stringify({ ts: Date.now(), pid: process.pid }), "utf8"); } catch (e2) {}
                    running = false;
                    releaseLock();
                    process.exit(1);
                }
            } else {
                log("Error en polling: " + errStr);
                await sleep(3000);
            }
            continue;
        }

        if (!updates || !Array.isArray(updates) || updates.length === 0) continue;

        for (const update of updates) {
            if (update.update_id >= offset) {
                offset = update.update_id + 1;
                saveOffset(offset);
            }

            // Manejar callback_query (botones inline de propuestas)
            const cq = update.callback_query;
            if (cq && cq.data) {
                const cbChatId = cq.message && cq.message.chat && cq.message.chat.id;
                if (String(cbChatId) === String(CHAT_ID)) {
                    const cbData = cq.data;
                    // Solo manejar callbacks de propuestas — los de permisos (allow:/always:/deny:)
                    // los maneja permission-approver.js
                    if (cbData.startsWith("create_proposal:") || cbData.startsWith("discard_proposal:") || cbData === "create_all_proposals") {
                        log("Callback de propuesta recibido: " + cbData);
                        try {
                            await handleProposalCallback(cbData, cq.id);
                        } catch (e) {
                            log("Error procesando callback de propuesta: " + e.message);
                            try {
                                await telegramPost("answerCallbackQuery", {
                                    callback_query_id: cq.id,
                                    text: "Error: " + e.message.substring(0, 100),
                                    show_alert: true
                                }, 5000);
                            } catch (e2) {}
                        }
                    }
                    // [LEGACY] Callbacks de reactivación de permisos expirados
                    // Ya no se generan botones nuevos (reemplazados por texto libre),
                    // pero se mantiene para mensajes viejos que aún tengan botones inline.
                    else if (cbData.startsWith("reactivate:") || cbData.startsWith("dismiss_expired:") || cbData === "reactivate_all") {
                        log("Callback de reactivación: " + cbData);
                        try {
                            await handleReactivateCallback(cbData, cq.id, cq.message && cq.message.message_id);
                        } catch (e) {
                            log("Error procesando callback de reactivación: " + e.message);
                            try {
                                await telegramPost("answerCallbackQuery", {
                                    callback_query_id: cq.id,
                                    text: "Error: " + e.message.substring(0, 100),
                                    show_alert: true
                                }, 5000);
                            } catch (e2) {}
                        }
                    }
                    // Callbacks de relanzar skill tras retry
                    else if (cbData.startsWith("relaunch_skill:")) {
                        const skillName = cbData.substring("relaunch_skill:".length);
                        log("Callback de relanzar skill: " + skillName);
                        try {
                            await telegramPost("answerCallbackQuery", {
                                callback_query_id: cq.id,
                                text: "🚀 Relanzando /" + skillName + "...",
                                show_alert: false
                            }, 5000);
                            // Quitar botones del mensaje
                            try {
                                await telegramPost("editMessageReplyMarkup", {
                                    chat_id: CHAT_ID,
                                    message_id: cq.message && cq.message.message_id,
                                    reply_markup: { inline_keyboard: [] }
                                }, 5000);
                            } catch (e) { /* ok */ }
                            // Buscar skill y lanzar
                            const skill = skills.find(s => s.name === skillName);
                            if (skill) {
                                await handleSkill(skill, "");
                            } else {
                                await sendMessage("⚠️ Skill <code>/" + escHtml(skillName) + "</code> no encontrado.");
                            }
                        } catch (e) {
                            log("Error relanzando skill: " + e.message);
                            try {
                                await telegramPost("answerCallbackQuery", {
                                    callback_query_id: cq.id,
                                    text: "Error: " + e.message.substring(0, 100),
                                    show_alert: true
                                }, 5000);
                            } catch (e2) {}
                        }
                    }
                    // Callbacks de permisos (allow:/always:/deny:) — botones inline
                    else if (cbData.startsWith("allow:") || cbData.startsWith("always:") || cbData.startsWith("deny:")) {
                        const parts = cbData.split(":");
                        const permAction = parts[0]; // "allow", "always", "deny"
                        const cbRequestId = parts.slice(1).join(":");
                        const cbMsgId = cq.message && cq.message.message_id;
                        log("Callback de permiso: action=" + permAction + " requestId=" + cbRequestId + " msgId=" + cbMsgId + " ts=" + new Date().toISOString());

                        const q = getQuestionById(cbRequestId);
                        const alreadyAnswered = q && (q.status === "answered" || q.status === "expired");
                        if (alreadyAnswered) {
                            log("Callback ignorado: pregunta ya resuelta status=" + q.status + " requestId=" + cbRequestId);
                        }

                        if (alreadyAnswered) {
                            // Ya fue respondido — solo confirmar
                            try {
                                await telegramPost("answerCallbackQuery", {
                                    callback_query_id: cq.id,
                                    text: "Ya fue respondido",
                                    show_alert: false
                                }, 5000);
                            } catch (e2) {}
                        } else if (q && q.status === "pending") {
                            // Procesar la decisión del usuario
                            resolveQuestion(cbRequestId, "answered", "telegram", permAction);

                            // Si es "siempre", persistir el patrón en settings
                            if (permAction === "always" && q.action_data) {
                                persistPermissionFromActionData(q.action_data);
                            }

                            // Responder al callback (quitar spinner del botón)
                            const confirmText = { allow: "✅ Permitido", always: "✅ Permitido siempre", deny: "❌ Denegado" }[permAction] || "OK";
                            try {
                                await telegramPost("answerCallbackQuery", {
                                    callback_query_id: cq.id,
                                    text: confirmText,
                                    show_alert: false
                                }, 5000);
                            } catch (e2) {}

                            // Editar mensaje: quitar botones, mostrar decisión
                            const emojiDecision = { allow: "✅", always: "✅✅", deny: "❌" }[permAction] || "•";
                            const msgId = cq.message && cq.message.message_id;
                            if (msgId) {
                                const originalHtml = q.original_html || escHtml(q.message || "Permiso solicitado");
                                try {
                                    await telegramPost("editMessageText", {
                                        chat_id: CHAT_ID,
                                        message_id: msgId,
                                        text: originalHtml + "\n\n" + emojiDecision + " <b>" + confirmText + "</b>",
                                        parse_mode: "HTML",
                                        reply_markup: { inline_keyboard: [] }
                                    }, 5000);
                                } catch (e2) {
                                    log("Error editando mensaje permiso: " + (e2.message || ""));
                                }
                            }
                            log("Permiso procesado: action=" + permAction + " requestId=" + cbRequestId + " msgId=" + cbMsgId + " ts=" + new Date().toISOString());
                        } else {
                            // Pregunta no encontrada
                            try {
                                await telegramPost("answerCallbackQuery", {
                                    callback_query_id: cq.id,
                                    text: "Solicitud no encontrada",
                                    show_alert: false
                                }, 5000);
                            } catch (e2) {}
                        }
                    }
                    // Callbacks de preguntas pendientes (pq_*)
                    else if (cbData.startsWith("pq_")) {
                        log("Callback de pregunta pendiente: " + cbData);
                        try {
                            await handlePendingCallback(cbData, cq.id);
                        } catch (e) {
                            log("Error procesando callback pendiente: " + e.message);
                            try {
                                await telegramPost("answerCallbackQuery", {
                                    callback_query_id: cq.id,
                                    text: "Error: " + e.message.substring(0, 100),
                                    show_alert: true
                                }, 5000);
                            } catch (e2) {}
                        }
                    }
                }
                continue;
            }

            const msg = update.message;
            if (!msg) continue;

            // Solo aceptar mensajes del chat autorizado
            if (String(msg.chat && msg.chat.id) !== String(CHAT_ID)) {
                log("Mensaje de chat no autorizado: " + (msg.chat && msg.chat.id));
                continue;
            }

            // Deduplicar: no procesar el mismo message_id dos veces
            const msgId = msg.message_id;
            if (msgId && processedMessageIds.has(msgId)) {
                log("Mensaje duplicado ignorado: message_id=" + msgId);
                continue;
            }
            if (msgId) {
                processedMessageIds.add(msgId);
                // Limitar tamaño del set para no consumir memoria indefinidamente
                if (processedMessageIds.size > PROCESSED_IDS_MAX) {
                    const iter = processedMessageIds.values();
                    processedMessageIds.delete(iter.next().value);
                }
            }

            const text = msg.text;
            if (!text) continue;

            log("Mensaje recibido (id=" + msgId + "): " + text.substring(0, 100));

            const cmd = parseCommand(text);
            if (!cmd) continue;

            try {
                switch (cmd.type) {
                    case "help":
                        await handleHelp();
                        break;
                    case "status":
                        await handleStatus();
                        break;
                    case "stop":
                        await sendMessage("🔴 Commander apagándose...");
                        running = false;
                        break;
                    case "session":
                        await handleSession();
                        break;
                    case "session_clear":
                        await handleSessionClear();
                        break;
                    case "skill":
                        await handleSkill(cmd.skill, cmd.args);
                        break;
                    case "freetext": {
                        // Detectar permisos pendientes PRIMERO
                        const pendingPerms = getPendingQuestions().filter(q => q.type === "permission");
                        if (pendingPerms.length > 0) {
                            // Hay permisos bloqueantes pendientes
                            const q = pendingPerms[pendingPerms.length - 1];
                            const trimmedText = cmd.text.trim().toLowerCase();
                            const permAction = matchPermissionKeyword(cmd.text);

                            // Verificar si el usuario quiere cancelar el permiso
                            if (trimmedText === "cancelar permiso" || trimmedText === "cancel" || trimmedText === "cancelar") {
                                resolveQuestion(q.id, "cancelled");
                                await sendMessage("⏹ Permiso cancelado. Claude continuará en consola.");
                                break;
                            }

                            if (permAction) {
                                // El usuario respondió con keyword explícito → procesar
                                await handleTextPermissionReply(q, permAction, CHAT_ID);
                                break;
                            }
                            // No fue respuesta de permiso → informar que hay permiso pendiente
                            const actionStr = q.action_data && q.action_data.tool_name ? escHtml(q.action_data.tool_name) : "un tool";
                            await sendMessage("⚠️ <b>Hay un permiso bloqueante pendiente</b> para " + actionStr + ".\n\n"
                                + "Respondé con:\n"
                                + "• <b>si</b> — permitir solo esta vez\n"
                                + "• <b>siempre</b> — permitir y recordar\n"
                                + "• <b>no</b> — denegar\n"
                                + "• <b>cancelar permiso</b> — cancelar y continuar en consola");
                            break;
                        }

                        // No hay permisos pendientes → procesar normalmente
                        const permAction = matchPermissionKeyword(cmd.text);
                        if (permAction) {
                            // También revisar expiradas recientes (últimos 5 min) para persistir "siempre"
                            const expiredPerms = getExpiredQuestions().filter(q =>
                                q.type === "permission" &&
                                Date.now() - new Date(q.timestamp).getTime() < 5 * 60 * 1000
                            );
                            if (expiredPerms.length > 0 && permAction !== "deny") {
                                const q = expiredPerms[expiredPerms.length - 1];
                                await handleLatePermissionReply(q, permAction, CHAT_ID);
                                break;
                            }
                        }
                        // No es keyword de permiso o no hay preguntas pendientes → freetext normal
                        await handleFreetext(cmd.text);
                        break;
                    }
                    case "sprint":
                        await handleSprint(cmd.agentNumber);
                        break;
                    case "sprint_interval":
                        await handleSprintInterval(cmd.minutes);
                        break;
                    case "pendientes":
                        await handlePendientes();
                        break;
                    case "retry":
                        await handleRetry();
                        break;
                    case "limpiar":
                        await handleLimpiar();
                        break;
                    case "unknown_command":
                        await sendMessage("❓ Comando <code>/" + escHtml(cmd.command) + "</code> no reconocido.\nUsá /help para ver los skills disponibles.");
                        break;
                }
            } catch (e) {
                log("Error procesando comando: " + e.message);
                try {
                    await sendMessage("⚠️ Error: <code>" + escHtml(e.message) + "</code>");
                } catch (e2) {}
            }
        }
    }
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── Pending Questions Watch (sync consola ↔ Telegram) ───────────────────────

let _pqWatcher = null;
let _pqLastSnapshot = {};  // { [id]: answered_via } — para detectar cambios

function takePqSnapshot() {
    try {
        const data = JSON.parse(fs.readFileSync(PENDING_QUESTIONS_FILE, "utf8"));
        const snap = {};
        for (const q of (data.questions || [])) {
            snap[q.id] = { status: q.status, answered_via: q.answered_via || null, msgId: q.telegram_message_id };
        }
        return snap;
    } catch (e) { return {}; }
}

async function onPendingQuestionsChange() {
    const newSnap = takePqSnapshot();
    for (const id of Object.keys(newSnap)) {
        const cur = newSnap[id];
        const prev = _pqLastSnapshot[id];
        // Detectar transición a answered_via:"console"
        if (cur.answered_via === "console" && (!prev || prev.answered_via !== "console") && cur.msgId) {
            log("PQ Watch: pregunta " + id + " respondida en consola — editando mensaje " + cur.msgId);
            try {
                await telegramPost("editMessageText", {
                    chat_id: CHAT_ID,
                    message_id: cur.msgId,
                    text: "⌨️ <b>Respondido en consola</b>\n\n<i>El usuario respondió directamente en la consola de Claude Code.</i>",
                    parse_mode: "HTML",
                    reply_markup: { inline_keyboard: [] }
                }, 8000);
            } catch (e) {
                const errMsg = e.message || "";
                if (!errMsg.includes("message is not modified")) {
                    log("PQ Watch: error editando mensaje " + cur.msgId + ": " + errMsg);
                }
            }
        }
    }
    _pqLastSnapshot = newSnap;
}

function startPendingQuestionsWatch() {
    _pqLastSnapshot = takePqSnapshot();
    try {
        _pqWatcher = fs.watch(PENDING_QUESTIONS_FILE, { persistent: false }, (eventType) => {
            if (eventType === "change") {
                // Debounce: esperar 200ms para evitar lecturas parciales
                setTimeout(() => { onPendingQuestionsChange().catch(e => log("PQ Watch error: " + e.message)); }, 200);
            }
        });
        _pqWatcher.on("error", (e) => {
            log("PQ Watcher error: " + e.message);
            _pqWatcher = null;
        });
        log("PQ Watch iniciado sobre " + PENDING_QUESTIONS_FILE);
    } catch (e) {
        log("No se pudo iniciar PQ Watch: " + e.message);
    }
}

function stopPendingQuestionsWatch() {
    if (_pqWatcher) {
        try { _pqWatcher.close(); } catch (e) {}
        _pqWatcher = null;
        log("PQ Watch detenido");
    }
    if (_pqOrphanInterval) {
        clearInterval(_pqOrphanInterval);
        _pqOrphanInterval = null;
    }
}

// ─── Orphan approver detection (approver killed by Claude → sync Telegram) ──

let _pqOrphanInterval = null;
const PQ_ORPHAN_CHECK_MS = 3000; // Cada 3 segundos

async function checkOrphanedApprovers() {
    try {
        const data = loadQuestions();
        if (!data.questions) return;
        let changed = false;
        for (const q of data.questions) {
            if (q.status !== "pending" || q.type !== "permission") continue;
            if (!q.approver_pid || !q.telegram_message_id) continue;
            // Si el approver ya no está vivo, el usuario respondió en consola
            if (!isProcessAlive(q.approver_pid)) {
                log("Orphan detected: pregunta " + q.id + " approver PID " + q.approver_pid + " muerto — sincronizando");
                q.status = "answered";
                q.answered_at = new Date().toISOString();
                q.answered_via = "console";
                changed = true;
                try {
                    const originalHtml = q.original_html || "";
                    const cleanHtml = originalHtml.replace(/\n📝 (?:Usar botones|Responder).*$/s, "");
                    await telegramPost("editMessageText", {
                        chat_id: CHAT_ID,
                        message_id: q.telegram_message_id,
                        text: (cleanHtml || "⚠️ Permiso solicitado") + "\n\n⌨️ <b>Respondido en consola</b>",
                        parse_mode: "HTML",
                        reply_markup: { inline_keyboard: [] }
                    }, 8000);
                } catch (e) {
                    const errMsg = e.message || "";
                    if (!errMsg.includes("message is not modified")) {
                        log("Orphan: error editando mensaje " + q.telegram_message_id + ": " + errMsg);
                    }
                }
            }
        }
        if (changed) saveQuestions(data);
    } catch (e) {
        log("checkOrphanedApprovers error: " + e.message);
    }
}

function startOrphanDetection() {
    _pqOrphanInterval = setInterval(() => {
        checkOrphanedApprovers().catch(e => log("Orphan check error: " + e.message));
    }, PQ_ORPHAN_CHECK_MS);
    log("Orphan approver detection iniciado (cada " + (PQ_ORPHAN_CHECK_MS / 1000) + "s)");
}

async function cleanStaleQuestionsOnStartup() {
    const data = loadQuestions();
    if (!data.questions || data.questions.length === 0) return;
    const stale = data.questions.filter(q => q.status === "pending" && q.telegram_message_id);
    if (stale.length === 0) return;

    log("Limpiando " + stale.length + " pregunta(s) pendientes de sesiones anteriores");
    for (const q of stale) {
        try {
            await telegramPost("editMessageText", {
                chat_id: CHAT_ID,
                message_id: q.telegram_message_id,
                text: "⌨️ <b>Respondido fuera de Telegram</b>\n\n<i>Esta pregunta fue resuelta en una sesión anterior.</i>",
                parse_mode: "HTML",
                reply_markup: { inline_keyboard: [] }
            }, 8000);
        } catch (e) {
            const errMsg = e.message || "";
            if (!errMsg.includes("message is not modified")) {
                log("Error editando stale msg " + q.telegram_message_id + ": " + errMsg);
            }
        }
        q.status = "answered";
        q.answered_at = new Date().toISOString();
        q.answered_via = "console";
    }
    saveQuestions(data);
}

// ─── Shutdown ────────────────────────────────────────────────────────────────

async function shutdown(signal) {
    if (!running) return;
    running = false;
    log("Shutdown por " + signal);

    // Detener monitor periódico, cleanup periódico y watcher de pending questions
    stopSprintMonitor();
    stopPendingQuestionsWatch();
    if (cleanupInterval) { clearInterval(cleanupInterval); cleanupInterval = null; }

    try {
        await sendMessage("🔴 <b>Commander offline</b> (" + signal + ")");
    } catch (e) {
        log("Error enviando mensaje de shutdown: " + e.message);
    }

    releaseLock();
    process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

// Capturar errores no manejados para limpiar lockfile siempre
process.on("uncaughtException", (e) => {
    log("uncaughtException: " + e.message);
    releaseLock();
    process.exit(1);
});
process.on("unhandledRejection", (reason) => {
    log("unhandledRejection: " + String(reason));
    releaseLock();
    process.exit(1);
});

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
    log("Arrancando Commander...");

    // Lockfile
    acquireLock();

    // Descubrir skills
    skills = discoverSkills();
    log("Skills descubiertos: " + skills.map(s => s.name).join(", ") + " (" + skills.length + ")");

    if (skills.length === 0) {
        log("ADVERTENCIA: no se encontraron skills en " + SKILLS_DIR);
    }

    // Notificar arranque
    try {
        let msg = "🟢 <b>Commander online</b>\n\n";
        msg += "🔧 " + skills.length + " skills disponibles\n";
        msg += "🆔 PID: " + process.pid + "\n";
        msg += "Enviá /help para ver los comandos.";
        await sendMessage(msg);
    } catch (e) {
        log("Error enviando mensaje de arranque: " + e.message);
        console.error("No se pudo enviar mensaje a Telegram:", e.message);
        releaseLock();
        process.exit(1);
    }

    // Limpiar preguntas pendientes de sesiones anteriores
    await cleanStaleQuestionsOnStartup();

    // Cleanup de mensajes antiguos al arranque
    try {
        const startupCleanup = await cleanupMessages(CLEANUP_TTL_MS);
        if (startupCleanup.total > 0) {
            log("Cleanup de arranque: " + startupCleanup.deleted + " borrados, " + startupCleanup.failed + " fallidos");
        }
    } catch (e) {
        log("Error en cleanup de arranque: " + e.message);
    }

    // Cleanup periódico cada 4 horas
    cleanupInterval = setInterval(async () => {
        try {
            const result = await cleanupMessages(CLEANUP_TTL_MS);
            if (result.total > 0) {
                log("Cleanup periódico: " + result.deleted + " borrados, " + result.failed + " fallidos");
            }
        } catch (e) {
            log("Error en cleanup periódico: " + e.message);
        }
    }, CLEANUP_INTERVAL_MS);

    // Iniciar watcher de pending-questions.json (sync consola ↔ Telegram)
    startPendingQuestionsWatch();
    // Nota: orphan detection desactivado — post-console-response.js (Stop hook) se encarga

    // Polling principal
    await pollingLoop();

    // Si salimos del loop (por /stop)
    log("Loop terminado.");
    releaseLock();
    process.exit(0);
}

main().catch((e) => {
    log("Error fatal: " + e.message);
    console.error("Error fatal:", e);
    releaseLock();
    process.exit(1);
});
