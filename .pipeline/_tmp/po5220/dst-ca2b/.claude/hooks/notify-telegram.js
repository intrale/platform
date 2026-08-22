// Hook Notification: reenvia notificaciones de Claude Code a Telegram
// 4 tipos de notificación con urgencia diferenciada:
//   - critical: CI rojo, tarea bloqueada → vibra (disable_notification: false)
//   - heartbeat: estado periódico → silencioso (disable_notification: true)
//   - delivery: PR mergeado, agente terminó → normal
//   - daily: resumen diario → normal
// Enriquecido con contexto de sesión (agente, branch, issue, tarea activa)
// Inline keyboard buttons para acciones rápidas
// Pure Node.js — sin dependencia de bash
const https = require("https");
const querystring = require("querystring");
const fs = require("fs");
const path = require("path");

const { readSessionContext } = require("./context-reader");
const { resolveMainRepoRoot } = require("./permission-utils");
const { registerMessage } = require("./telegram-message-registry");
const { sanitizeHtml } = require("./telegram-sanitizer");

const _tgCfg = JSON.parse(require("fs").readFileSync(require("path").join(__dirname, "telegram-config.json"), "utf8"));
const BOT_TOKEN = _tgCfg.bot_token;
const CHAT_ID = _tgCfg.chat_id;
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1500;
const DASHBOARD_PORT = 3100;

const REPO_ROOT = process.env.CLAUDE_PROJECT_DIR || "C:\\Workspaces\\Intrale\\platform";
const MAIN_REPO_ROOT = resolveMainRepoRoot(REPO_ROOT) || REPO_ROOT;
const LOG_FILE = path.join(MAIN_REPO_ROOT, ".claude", "hooks", "hook-debug.log");

function log(msg) {
    try { fs.appendFileSync(LOG_FILE, "[" + new Date().toISOString() + "] Notification: " + msg + "\n"); } catch(e) {}
}

function escHtml(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function abbreviate(str, max) {
    if (!str) return "";
    str = str.trim();
    return str.length > max ? str.substring(0, max) + "\u2026" : str;
}

/**
 * Genera la sección de contexto del mensaje (agente, rama, issue, tarea activa).
 * Reutiliza la misma lógica que permission-gate.js.
 */
function formatContext(sessionId, repoRoot) {
    const ctx = readSessionContext(sessionId, repoRoot);
    const lines = [];

    // Agente / skill activo
    if (ctx.agentName) {
        lines.push("\ud83e\udd16 " + escHtml(ctx.agentName));
    } else if (ctx.skill) {
        lines.push("\u26a1 /" + escHtml(ctx.skill));
    }

    // Rama + issue
    if (ctx.branch && ctx.branch !== "main" && ctx.branch !== "develop") {
        let branchDisplay = escHtml(ctx.branch);
        const issueMatch = ctx.branch.match(/(?:agent|feature|bugfix)\/(\d+)/);
        if (issueMatch) {
            branchDisplay += " (<a href=\"https://github.com/intrale/platform/issues/" + issueMatch[1] + "\">#" + issueMatch[1] + "</a>)";
        }
        lines.push("\ud83d\udd00 " + branchDisplay);
    }

    // Tarea activa
    if (ctx.task) {
        lines.push("\ud83d\udccc " + escHtml(abbreviate(ctx.task, 60)));
    }

    return lines.length > 0 ? lines.join("\n") : "";
}

/**
 * Clasifica el tipo de notificación en una de las 4 categorías de urgencia.
 * Retorna: { category, silent, emoji, inlineKeyboard }
 */
function classifyNotification(type, message, title) {
    const msg = (message || "").toLowerCase();
    const ttl = (title || "").toLowerCase();

    // CRITICAL: CI rojo, tarea bloqueada, errores graves
    if (msg.includes("ci") && (msg.includes("fail") || msg.includes("rojo") || msg.includes("error"))) {
        return {
            category: "critical",
            silent: false,
            emoji: "\ud83d\udea8",
            inlineKeyboard: [[
                { text: "\ud83d\udd0d Ver logs", callback_data: "view_ci_logs" },
                { text: "\ud83d\udcca Dashboard", callback_data: "view_dashboard" }
            ]]
        };
    }
    if (msg.includes("bloqueada") || msg.includes("blocked") || msg.includes("error critico")) {
        return {
            category: "critical",
            silent: false,
            emoji: "\ud83d\udea8",
            inlineKeyboard: [[
                { text: "\u270b Asignar", callback_data: "assign_task" },
                { text: "\ud83d\udcca Dashboard", callback_data: "view_dashboard" }
            ]]
        };
    }

    // DELIVERY: PR mergeado, agente terminó, push completado
    if (type === "stop" || msg.includes("merge") || msg.includes("pr creado") || msg.includes("push")) {
        return {
            category: "delivery",
            silent: false,
            emoji: "\ud83d\udce6",
            inlineKeyboard: [[
                { text: "\ud83d\udc41 Ver PR", callback_data: "view_pr" },
                { text: "\ud83d\udcca Dashboard", callback_data: "view_dashboard" }
            ]]
        };
    }

    // HEARTBEAT: estado periódico (reportes programados)
    if (type === "heartbeat" || msg.includes("heartbeat") || msg.includes("reporte peri")) {
        return {
            category: "heartbeat",
            silent: true,
            emoji: "\ud83d\udc9a",
            inlineKeyboard: null
        };
    }

    // DAILY: resumen diario
    if (type === "daily_summary" || msg.includes("resumen diario") || msg.includes("daily")) {
        return {
            category: "daily",
            silent: false,
            emoji: "\ud83d\udcca",
            inlineKeyboard: [[
                { text: "\ud83d\udcca Dashboard", callback_data: "view_dashboard" },
                { text: "\ud83d\udccb Ver issues", callback_data: "view_issues" }
            ]]
        };
    }

    // Default: notificación normal
    return {
        category: "normal",
        silent: false,
        emoji: {
            "permission_prompt": "\u26a0\ufe0f",
            "idle_prompt": "\u2705",
            "auth_success": "\ud83d\udd11",
            "elicitation_dialog": "\u2753"
        }[type] || "\ud83d\udd14",
        inlineKeyboard: null
    };
}

function sendTelegram(text, attempt, options) {
    // Solo loguear — no enviar a Telegram. Las notificaciones automáticas de hooks
    // no requieren acción del usuario. La info está en dashboard y logs.
    const clean = (text || "").replace(/<[^>]+>/g, "").substring(0, 200);
    log("(sendTelegram→log) " + clean);
    return Promise.resolve({ ok: true, result: { message_id: 0 } });
    const silent = options && options.silent;
    const inlineKeyboard = options && options.inlineKeyboard;

    return new Promise((resolve, reject) => {
        const params = {
            chat_id: CHAT_ID,
            text: sanitizeHtml(text),
            parse_mode: "HTML",
            disable_web_page_preview: true
        };
        if (silent) {
            params.disable_notification = true;
        }
        if (inlineKeyboard) {
            params.reply_markup = JSON.stringify({ inline_keyboard: inlineKeyboard });
        }
        const postData = JSON.stringify(params);
        const req = https.request({
            hostname: "api.telegram.org",
            path: "/bot" + BOT_TOKEN + "/sendMessage",
            method: "POST",
            headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(postData) },
            timeout: 5000
        }, (res) => {
            let d = "";
            res.on("data", (c) => d += c);
            res.on("end", () => {
                try {
                    const r = JSON.parse(d);
                    if (r.ok) { log("OK intento " + attempt + " msg_id=" + r.result.message_id + " cat=" + (options && options.category || "?")); resolve(r); }
                    else { log("API error intento " + attempt + ": " + d); reject(new Error(d)); }
                } catch(e) { log("Parse error intento " + attempt + ": " + d); reject(e); }
            });
        });
        req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
        req.on("error", (e) => { log("Net error intento " + attempt + ": " + e.message); reject(e); });
        req.write(postData);
        req.end();
    });
}

/**
 * Envía una foto (screenshot del dashboard) via Telegram.
 * Se usa para heartbeat y resumen diario.
 */
function sendTelegramPhoto(photoBuffer, caption, attempt, options) {
    log("(sendTelegramPhoto→log) foto omitida — ver dashboard web");
    return Promise.resolve({ ok: true, result: { message_id: 0 } });
    const silent = options && options.silent;
    const inlineKeyboard = options && options.inlineKeyboard;

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
        if (inlineKeyboard) {
            body += "--" + boundary + "\r\nContent-Disposition: form-data; name=\"reply_markup\"\r\n\r\n" + JSON.stringify({ inline_keyboard: inlineKeyboard }) + "\r\n";
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
                    if (r.ok) { log("Photo OK intento " + attempt + " msg_id=" + r.result.message_id); resolve(r); }
                    else { log("Photo API error intento " + attempt + ": " + d); reject(new Error(d)); }
                } catch(e) { reject(e); }
            });
        });
        req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
        req.on("error", (e) => reject(e));
        req.write(payload);
        req.end();
    });
}

/**
 * Intenta obtener screenshot del dashboard web server (localhost:3100).
 * Retorna Buffer con PNG o null si el server no está corriendo.
 */
function fetchDashboardScreenshot(width, height) {
    return new Promise((resolve) => {
        const req = require("http").get("http://localhost:" + DASHBOARD_PORT + "/screenshot?w=" + width + "&h=" + height, { timeout: 12000 }, (res) => {
            if (res.statusCode !== 200) { resolve(null); return; }
            const chunks = [];
            res.on("data", (c) => chunks.push(c));
            res.on("end", () => resolve(Buffer.concat(chunks)));
        });
        req.on("error", () => resolve(null));
        req.on("timeout", () => { req.destroy(); resolve(null); });
    });
}

const MAX_READ = 4096;
let rawInput = "";
let done = false;

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
    if (done) return;
    rawInput += chunk;
    if (rawInput.length >= MAX_READ) { done = true; process.stdin.destroy(); processInput(); }
});
process.stdin.on("end", () => { if (!done) { done = true; processInput(); } });
process.stdin.on("error", () => { if (!done) { done = true; processInput(); } });
setTimeout(() => { if (!done) { done = true; try { process.stdin.destroy(); } catch(e) {} processInput(); } }, 3000);

async function processInput() {
    log("INPUT: " + rawInput.substring(0, 300));

    let data;
    try { data = JSON.parse(rawInput); } catch(e) { log("JSON parse failed: " + rawInput.substring(0, 200)); data = {}; }

    const message = data.message || "";
    const title = data.title || "";
    const type = data.notification_type || "notification";

    const agent = process.env.CLAUDE_AGENT_NAME || "Claude Code";

    const TIPO_TITULO = {
        "permission_prompt":   "Aprobaci\u00f3n requerida",
        "idle_prompt":         "Claude est\u00e1 esperando",
        "auth_success":        "Autenticaci\u00f3n exitosa",
        "elicitation_dialog":  "Informaci\u00f3n requerida"
    };

    // permission_prompt: decidir si notificar o ignorar
    // Solo IGNORAR si: approver activo (PID vivo) O auto-approve reciente (<10s)
    // En cualquier otro caso: NOTIFICAR (el usuario tiene un prompt esperando en consola)
    if (type === "permission_prompt") {
        const approverPidFile = path.join(MAIN_REPO_ROOT, ".claude", "hooks", "approver-active.pid");
        const autoApproveFile = path.join(MAIN_REPO_ROOT, ".claude", "hooks", "approver-last-auto.json");

        // Check 1: approver activo con botones en Telegram
        try {
            if (fs.existsSync(approverPidFile)) {
                const pidData = JSON.parse(fs.readFileSync(approverPidFile, "utf8"));
                try {
                    process.kill(pidData.pid, 0);
                    log("Ignorado permission_prompt: approver PID " + pidData.pid + " activo (Telegram buttons)");
                    return;
                } catch(e) { /* PID muerto, continuar */ }
            }
        } catch(e) { /* error leyendo PID, continuar */ }

        // Check 2: auto-approve reciente (el approver resolvió silenciosamente)
        try {
            if (fs.existsSync(autoApproveFile)) {
                const autoData = JSON.parse(fs.readFileSync(autoApproveFile, "utf8"));
                const age = Date.now() - new Date(autoData.timestamp).getTime();
                if (age < 10000) {
                    log("Ignorado permission_prompt: auto-aprobado hace " + Math.round(age/1000) + "s");
                    return;
                }
            }
        } catch(e) { /* error leyendo auto-approve, continuar */ }

        // Ningún mecanismo lo manejó → hay un prompt esperando en consola → NOTIFICAR
        log("permission_prompt: sin approver ni auto-approve reciente, notificando al usuario");
    }

    // Clasificar urgencia y tipo de notificación
    const classification = classifyNotification(type, message, title);
    // Para permission_prompt que llega aquí (approver crasheó), usar título de fallback
    const displayTitle = (type === "permission_prompt")
        ? "Permiso pendiente en consola"
        : (TIPO_TITULO[type] || title || type);

    let displayMessage = message;

    // P10-UX: Quiet hours — solo mensajes críticos fuera de horario
    try {
        const qh = config.quiet_hours;
        if (qh && qh.start && qh.end && classification.category !== "critical") {
            const nowLocal = new Date().toLocaleString("en-US", { timeZone: qh.timezone || "America/Argentina/Buenos_Aires", hour12: false });
            const hourNow = parseInt(nowLocal.split(" ")[1].split(":")[0], 10);
            const startH = parseInt(qh.start.split(":")[0], 10);
            const endH = parseInt(qh.end.split(":")[0], 10);
            const inQuietHours = startH > endH
                ? (hourNow >= startH || hourNow < endH) // ej: 23-08 cruza medianoche
                : (hourNow >= startH && hourNow < endH);
            if (inQuietHours) {
                log("Quiet hours activo — suprimiendo " + classification.category + ": " + (title || "").substring(0, 50));
                return;
            }
        }
    } catch (_) {}

    // Enriquecer con contexto de sesión
    const sessionId = data.session_id || "";
    const contextLine = formatContext(sessionId, MAIN_REPO_ROOT);

    // P8-UX: Heartbeat solo si el estado cambió (hash comparison)
    if (classification.category === "heartbeat") {
        const crypto = require("crypto");
        const hashFile = path.join(__dirname, "heartbeat-state.json");
        const stateKey = (sessionId || "") + "|" + (data.message || "");
        const currentHash = crypto.createHash("md5").update(stateKey).digest("hex").substring(0, 12);
        try {
            const prev = JSON.parse(fs.readFileSync(hashFile, "utf8"));
            if (prev.hash === currentHash) {
                // Estado no cambió — suprimir heartbeat
                return;
            }
        } catch (_) {}
        try { fs.writeFileSync(hashFile, JSON.stringify({ hash: currentHash, ts: new Date().toISOString() }), "utf8"); } catch (_) {}
    }

    // Para heartbeat y daily, intentar enviar screenshot del dashboard
    if (classification.category === "heartbeat" || classification.category === "daily") {
        const screenshot = await fetchDashboardScreenshot(375, 640);
        if (screenshot && screenshot.length > 1000) {
            let caption = classification.emoji + " <b>" + escHtml(agent) + " \u2014 " + escHtml(displayTitle) + "</b>";
            if (contextLine) caption += "\n" + contextLine;
            caption = sanitizeHtml(caption);

            for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
                try {
                    const r = await sendTelegramPhoto(screenshot, caption, attempt, {
                        silent: classification.silent,
                        inlineKeyboard: classification.inlineKeyboard,
                        category: classification.category
                    });
                    try { if (r && r.result && r.result.message_id) registerMessage(r.result.message_id, classification.category); } catch(re) { log("registerMessage error (ignorado): " + re.message); }
                    return;
                } catch(e) {
                    if (attempt < MAX_RETRIES) {
                        await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
                    } else {
                        log("Photo FALLO, fallback a texto");
                    }
                }
            }
            // Fallback: enviar como texto si la foto falla
        }
    }

    // Construir mensaje de texto (default o fallback)
    let text = classification.emoji + " <b>" + escHtml(agent) + " \u2014 " + escHtml(displayTitle) + "</b>\n";
    if (contextLine) {
        text += contextLine + "\n";
    }
    if (displayMessage) {
        text += "\n" + escHtml(displayMessage);
    }

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            const r = await sendTelegram(text, attempt, {
                silent: classification.silent,
                inlineKeyboard: classification.inlineKeyboard,
                category: classification.category
            });
            try { if (r && r.result && r.result.message_id) registerMessage(r.result.message_id, classification.category); } catch(re) { log("registerMessage error (ignorado): " + re.message); }
            return;
        } catch(e) {
            if (attempt < MAX_RETRIES) {
                log("Reintentando en " + RETRY_DELAY_MS + "ms...");
                await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
            } else {
                log("FALLO despues de " + MAX_RETRIES + " intentos");
            }
        }
    }
}
