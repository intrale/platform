// permission-approver.js — PoC spike #834
// Hook PermissionRequest v2: aprobación remota vía Telegram (texto libre)
// Flujo: envía mensaje con instrucciones → usuario responde "si"/"siempre"/"no" →
//        telegram-commander procesa el texto → approver lee la decisión via pending-questions.json
// Pure Node.js — sin dependencia de bash
//
// IMPORTANTE: Este hook NO usa getUpdates de Telegram. El telegram-commander.js
// es el único consumidor de getUpdates, evitando conflictos de offset/409.
//
// Salidas posibles:
//   stdout {"behavior": "allow"}             → Claude aprueba sin mostrar UI local
//   stdout {"behavior": "deny", "message"}   → Claude deniega
//   sin stdout (timeout)                     → Claude muestra prompt local como fallback

const https = require("https");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { generatePattern, getSettingsPaths, persistPattern, resolveMainRepoRoot, isAlreadyCovered, extractFirstCommand, generateBashPattern, splitCompoundCommand, classifySeverity, Severity } = require("./permission-utils");

const { addPendingQuestion, resolveQuestion, getQuestionById, updateQuestionField } = require("./pending-questions");
const { readSessionContext } = require("./context-reader");
const { registerMessage } = require("./telegram-message-registry");
// P-15: Ops learnings
let opsLearnings;
try { opsLearnings = require("./ops-learnings"); } catch (e) { opsLearnings = null; }
const _tgCfg = JSON.parse(require("fs").readFileSync(require("path").join(__dirname, "telegram-config.json"), "utf8"));
const BOT_TOKEN = _tgCfg.bot_token;
const CHAT_ID = _tgCfg.chat_id;
const ANSWER_TIMEOUT = 5000;   // Timeout para editMessage
const POLL_INTERVAL_MS = 150;   // Verificar pending-questions.json cada 150ms (respuesta rápida)

// ─── Retry schedule con urgencia escalada ────────────────────────────────────
// Configurable desde telegram-config.json → retry_intervals_min (array de minutos)
// Default: [30, 15, 10, 10] = 65 min total
// Intento 0: mensaje inicial, espera 30 min
// Intento 1: 🔔 Recordatorio, espera 15 min
// Intento 2: ⚠️ Agente bloqueado, espera 10 min
// Intento 3: 🚨 Último aviso, espera 10 min
// Si no responde → expirado definitivo, fallback a consola

const DEFAULT_RETRY_INTERVALS = [3, 3, 3, 3, 3, 3, 3, 3, 3, 3]; // minutos (30 min total)
const RETRY_INTERVALS = (_tgCfg.retry_intervals_min || DEFAULT_RETRY_INTERVALS)
    .map(m => m * 60 * 1000); // convertir a ms
const TOTAL_TIMEOUT_MS = RETRY_INTERVALS.reduce((a, b) => a + b, 0);

const RETRY_ESCALATION = [
    null, // intento 0: mensaje inicial (sin prefijo de escalada)
    { emoji: "🔔", title: "Recordatorio", desc: "Hay un permiso pendiente desde hace rato" },
    { emoji: "⚠️", title: "Agente bloqueado", desc: "El agente no puede continuar sin tu aprobación" },
    { emoji: "🚨", title: "Último aviso", desc: "Si no respondés, el agente se detendrá" },
    { emoji: "⛔", title: "Crítico", desc: "El agente está completamente bloqueado esperando tu respuesta" },
    { emoji: "⛔", title: "Crítico", desc: "El agente está completamente bloqueado esperando tu respuesta" },
    { emoji: "⛔", title: "Crítico", desc: "El agente está completamente bloqueado esperando tu respuesta" },
    { emoji: "⛔", title: "Crítico", desc: "El agente está completamente bloqueado esperando tu respuesta" },
    { emoji: "⛔", title: "Crítico", desc: "El agente está completamente bloqueado esperando tu respuesta" },
    { emoji: "⛔", title: "Crítico", desc: "El agente está completamente bloqueado esperando tu respuesta" }
];

const REPO_ROOT = process.env.CLAUDE_PROJECT_DIR || "C:\\Workspaces\\Intrale\\platform";
const MAIN_REPO_ROOT = resolveMainRepoRoot(REPO_ROOT) || REPO_ROOT;
const LOG_FILE = path.join(MAIN_REPO_ROOT, ".claude", "hooks", "hook-debug.log");
const SESSION_STORE_FILE = path.join(MAIN_REPO_ROOT, ".claude", "hooks", "tg-session-store.json");
const COMMANDER_LOCK_FILE = path.join(MAIN_REPO_ROOT, ".claude", "hooks", "telegram-commander.lock");

function getSkillContext() {
    try {
        const data = JSON.parse(fs.readFileSync(SESSION_STORE_FILE, "utf8"));
        const session = data.active_session;
        if (!session || !session.skill) return null;
        // Verificar que la sesión no esté expirada (30 min)
        const elapsed = Date.now() - new Date(session.last_used).getTime();
        if (elapsed > 30 * 60 * 1000) return null;
        return session.skill;
    } catch (e) {
        return null;
    }
}

function log(msg) {
    try { fs.appendFileSync(LOG_FILE, "[" + new Date().toISOString() + "] Approver: " + msg + "\n"); } catch(e) {}
}

// ─── Helpers HTTP ──────────────────────────────────────────────────────────────

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
                } catch(e) { reject(e); }
            });
        });
        req.on("timeout", () => { req.destroy(); reject(new Error("timeout " + method)); });
        req.on("error", (e) => reject(e));
        req.write(postData);
        req.end();
    });
}

function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

// ─── Commander health check ─────────────────────────────────────────────────
// Verifica que telegram-commander.js esté corriendo antes de enviar el primer mensaje.
// Sin commander, los callbacks de botones se pierden.

function isProcessAlive(pid) {
    try { process.kill(pid, 0); return true; } catch (e) { return false; }
}

function isCommanderRunning() {
    try {
        const data = JSON.parse(fs.readFileSync(COMMANDER_LOCK_FILE, "utf8"));
        if (!data.pid || typeof data.pid !== "number") return false;
        return isProcessAlive(data.pid);
    } catch (e) {
        return false;
    }
}

function launchCommander() {
    const commanderPath = path.join(MAIN_REPO_ROOT, ".claude", "hooks", "telegram-commander.js");
    try {
        const { spawn } = require("child_process");
        const child = spawn("node", [commanderPath], {
            cwd: MAIN_REPO_ROOT,
            detached: true,
            stdio: "ignore",
            env: { ...process.env, CLAUDE_PROJECT_DIR: MAIN_REPO_ROOT }
        });
        child.unref();
        log("Commander lanzado (PID " + child.pid + ")");
        return child.pid;
    } catch (e) {
        log("Error lanzando commander: " + e.message);
        return null;
    }
}

async function ensureCommanderRunning() {
    if (isCommanderRunning()) {
        log("Commander verificado: corriendo");
        return true;
    }
    log("Commander NO está corriendo — lanzando...");
    const pid = launchCommander();
    if (!pid) return false;

    // Esperar hasta 5 segundos a que el commander adquiera su lock
    for (let i = 0; i < 10; i++) {
        await sleep(500);
        if (isCommanderRunning()) {
            log("Commander confirmado corriendo después de " + ((i + 1) * 500) + "ms");
            return true;
        }
    }
    log("Commander lanzado pero no confirmó en 5s — continuando de todos modos");
    return false;
}

// ─── Formato de acción para el mensaje ────────────────────────────────────────

function escHtml(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function shortenPath(fullPath) {
    if (!fullPath) return "";
    const normalized = fullPath.replace(/\\/g, "/");
    const markers = ["/platform/", "/Intrale/"];
    for (const m of markers) {
        const idx = normalized.indexOf(m);
        if (idx >= 0) return normalized.substring(idx + m.length);
    }
    // Fallback: últimos 3 segmentos
    const parts = normalized.split("/");
    return parts.length > 3 ? "…/" + parts.slice(-3).join("/") : normalized;
}

function abbreviate(str, max) {
    if (!str) return "";
    str = str.trim();
    return str.length > max ? str.substring(0, max) + "…" : str;
}

function formatAction(toolName, toolInput) {
    switch (toolName) {
        case "Bash": {
            const cmd = (toolInput.command || "").trim();
            const desc = (toolInput.description || "").trim();
            const display = cmd.length > 250 ? cmd.substring(0, 250) + "…" : cmd;
            let result = "";
            if (desc) {
                result += "🔧 <b>" + escHtml(abbreviate(desc, 80)) + "</b>\n";
            }
            result += "<code>$ " + escHtml(display) + "</code>";
            return result;
        }
        case "Edit": {
            const shortPath = shortenPath(toolInput.file_path);
            let result = "📝 <b>Editar</b> <code>" + escHtml(shortPath) + "</code>";
            const oldStr = (toolInput.old_string || "").trim();
            const newStr = (toolInput.new_string || "").trim();
            if (oldStr || newStr) {
                result += "\n<pre>";
                if (oldStr) result += "- " + escHtml(abbreviate(oldStr, 120)) + "\n";
                if (newStr) result += "+ " + escHtml(abbreviate(newStr, 120));
                result += "</pre>";
            }
            return result;
        }
        case "Write": {
            const shortPath = shortenPath(toolInput.file_path);
            const content = (toolInput.content || "").trim();
            let result = "📄 <b>Escribir</b> <code>" + escHtml(shortPath) + "</code>";
            if (content) {
                const preview = content.split("\n").slice(0, 3).join("\n");
                result += "\n<pre>" + escHtml(abbreviate(preview, 150)) + "</pre>";
            }
            return result;
        }
        case "Task":
            return "🤖 <b>Subagente</b> [" + escHtml(toolInput.subagent_type || "?") + "] " + escHtml(abbreviate(toolInput.description || "", 80));
        case "Skill":
            return "⚡ <b>Skill</b> /" + escHtml(toolInput.skill || "") + (toolInput.args ? " " + escHtml(abbreviate(toolInput.args, 60)) : "");
        case "WebFetch":
            return "🌐 <b>Fetch</b> " + escHtml(abbreviate(toolInput.url || "", 100));
        case "WebSearch":
            return "🔍 <b>Buscar</b> " + escHtml(abbreviate(toolInput.query || "", 80));
        default:
            return escHtml(toolName) + " " + escHtml(JSON.stringify(toolInput).substring(0, 100));
    }
}

/**
 * Genera la sección de contexto del mensaje (agente, rama, tarea activa).
 */
function formatContext(sessionId, repoRoot) {
    const ctx = readSessionContext(sessionId, repoRoot);
    const lines = [];

    // Agente / skill activo
    if (ctx.agentName) {
        lines.push("🤖 " + escHtml(ctx.agentName));
    } else if (ctx.skill) {
        lines.push("⚡ /" + escHtml(ctx.skill));
    }

    // Rama + issue
    if (ctx.branch && ctx.branch !== "main" && ctx.branch !== "develop") {
        let branchDisplay = escHtml(ctx.branch);
        const issueMatch = ctx.branch.match(/(?:agent|feature|bugfix)\/(\d+)/);
        if (issueMatch) {
            branchDisplay += " (#" + issueMatch[1] + ")";
        }
        lines.push("🔀 " + branchDisplay);
    }

    // Tarea activa
    if (ctx.task) {
        lines.push("📌 " + escHtml(abbreviate(ctx.task, 60)));
    }

    return lines.length > 0 ? lines.join("  ·  ") : "";
}

// ─── Patrón de permiso para persistencia ("Siempre") ──────────────────────────
// generatePattern() y persistPattern() importados de permission-utils.js
// Escriben en AMBOS settings (worktree + repo principal) para persistencia cross-worktree

function persistAlways(toolName, toolInput) {
    const pattern = generatePattern(toolName, toolInput);
    log("persistAlways: tool=" + toolName + " pattern=" + (pattern || "NULL"));
    if (!pattern) {
        log("persistAlways: no se pudo generar patrón para " + toolName);
        return;
    }
    const settingsPaths = getSettingsPaths(REPO_ROOT);
    log("persistAlways: settingsPaths=" + JSON.stringify(settingsPaths));
    persistPattern(pattern, settingsPaths, log);
}

// ─── Polling de pending-questions.json ────────────────────────────────────────
// P-01: Usa fs.watch + fallback polling adaptativo (P-12)
// P-12: Intervalos adaptativos: 150ms (0-1s), 500ms (1-10s), 1000ms (>10s)

// Archivo PID para que otros hooks puedan detectar/matar este approver
const APPROVER_PID_FILE = path.join(MAIN_REPO_ROOT, ".claude", "hooks", "approver-active.pid");
const PQ_FILE = path.join(MAIN_REPO_ROOT, ".claude", "hooks", "pending-questions.json");

// P-12: Polling adaptativo según tiempo transcurrido
function getAdaptivePollMs(elapsedMs) {
    if (elapsedMs < 1000) return 150;    // 0-1s: ultra-responsive (auto-approves)
    if (elapsedMs < 10000) return 500;   // 1-10s: lectura humana
    return 1000;                          // >10s: espera larga
}

/**
 * Polling de pending-questions.json por un período específico.
 * P-01: Usa fs.watch para notificación inmediata + fallback polling adaptativo (P-12).
 * @param {string} requestId - ID de la pregunta
 * @param {number} durationMs - Duración máxima de este polling en ms
 * @param {string} attemptLabel - Etiqueta para logs (ej: "intento 1/4")
 * @param {object} countdownOptions - { msgId, baseText } para actualizar countdown cada 30s
 * @returns {object|null} pregunta respondida o null si timeout
 */
async function pollQuestionStatus(requestId, durationMs, attemptLabel, countdownOptions) {
    const pollStart = Date.now();
    const label = attemptLabel || "";
    let logCounter = 0;
    let countdownCounter = 0;

    // P-01: fs.watch para detección inmediata de cambios
    let fileChanged = true; // empezar con true para check inicial
    let watcher = null;
    try {
        watcher = fs.watch(PQ_FILE, { persistent: false }, () => { fileChanged = true; });
        watcher.on("error", () => { watcher = null; }); // fallback a polling puro
    } catch (e) {
        log("fs.watch no disponible, usando polling puro: " + e.message);
    }

    try {
        while (Date.now() - pollStart < durationMs) {
            // Solo leer archivo si cambió (fs.watch) o polling fallback
            if (fileChanged) {
                fileChanged = false;
                try {
                    const q = getQuestionById(requestId);
                    if (!q) {
                        log("Pregunta " + requestId + " desapareció de pending-questions.json");
                        return null;
                    }
                    if (q.status === "cancelled") {
                        log("Pregunta " + requestId + " fue cancelada externamente");
                        return q;
                    }
                    if (q.status !== "pending") {
                        log("Pregunta " + requestId + " cambió a: " + q.status
                            + " via=" + (q.answered_via || "?")
                            + " action=" + (q.action_result || "?"));
                        return q;
                    }
                } catch(e) {
                    log("Error leyendo pregunta " + requestId + ": " + e.message);
                }
            }

            // Actualizar countdown cada 30s
            const elapsedMs = Date.now() - pollStart;
            countdownCounter++;
            const currentPollMs = getAdaptivePollMs(elapsedMs);
            const countdownInterval = Math.round(30000 / currentPollMs);
            if (countdownOptions && countdownOptions.msgId && countdownCounter % countdownInterval === 0) {
                const remaining = Math.max(0, Math.round((durationMs - elapsedMs) / 1000));
                if (remaining > 0) {
                    const minRemaining = Math.floor(remaining / 60);
                    const secRemaining = remaining % 60;
                    const countdownStr = minRemaining + ":" + (secRemaining < 10 ? "0" : "") + secRemaining;
                    const updatedText = countdownOptions.baseText.replace(/⏳ Expira en \d+:\d+/, "⏳ Expira en " + countdownStr);
                    try {
                        await telegramPost("editMessageText", {
                            chat_id: CHAT_ID,
                            message_id: countdownOptions.msgId,
                            text: updatedText,
                            parse_mode: "HTML",
                            reply_markup: { inline_keyboard: countdownOptions.inlineKeyboard || [] }
                        }, ANSWER_TIMEOUT);
                    } catch(e) {
                        log("Error actualizando countdown: " + e.message);
                    }
                }
            }

            // Log de diagnóstico cada 30s
            logCounter++;
            if (logCounter % Math.round(30000 / currentPollMs) === 0) {
                const elapsed = Math.round(elapsedMs / 1000);
                const remaining = Math.round((durationMs - elapsedMs) / 1000);
                log("Polling " + label + " " + requestId + ": " + elapsed + "s elapsed, " + remaining + "s left, poll=" + currentPollMs + "ms, pid=" + process.pid);
            }

            // P-12: Adaptive sleep — más corto al inicio, más largo después
            await sleep(currentPollMs);
            // Safety net: marcar fileChanged periódicamente para re-check (por si fs.watch pierde eventos)
            if (!watcher) fileChanged = true;
        }
    } finally {
        if (watcher) { try { watcher.close(); } catch (e) {} }
    }
    return null; // timeout de este intento
}

// ─── Main ──────────────────────────────────────────────────────────────────────

const MAX_READ = 8192;
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
setTimeout(() => {
    if (!done) { done = true; try { process.stdin.destroy(); } catch(e) {} processInput(); }
}, 3000);

// ─── Auto-approve: fast-path para comandos ya cubiertos por settings ─────────

function isCommandCoveredByRules(toolName, toolInput) {
    const pattern = generatePattern(toolName, toolInput);
    if (!pattern) return false;

    // Para Bash con comandos compuestos, usar splitCompoundCommand robusto
    if (toolName === "Bash" && toolInput.command) {
        const cmd = toolInput.command.trim();
        const subCmds = splitCompoundCommand(cmd);

        if (subCmds.length > 1) {
            const settingsPaths = getSettingsPaths(REPO_ROOT);
            for (const sp of settingsPaths) {
                try {
                    const s = JSON.parse(fs.readFileSync(sp, "utf8"));
                    const allow = (s.permissions && s.permissions.allow) || [];
                    const deny = (s.permissions && s.permissions.deny) || [];
                    const allCovered = subCmds.every(sub => {
                        const subPattern = generateBashPattern(sub);
                        return subPattern && isAlreadyCovered(subPattern, allow);
                    });
                    const denyMatch = deny.some(d => {
                        const dm = d.match(/^Bash\((.+?):\*\)$/);
                        if (!dm) return false;
                        return subCmds.some(sub => sub.startsWith(dm[1]));
                    });
                    if (allCovered && !denyMatch) return true;
                } catch(e) {}
            }
            return false;
        }
    }

    // Caso simple: un solo comando o tool no-Bash
    const settingsPaths = getSettingsPaths(REPO_ROOT);
    for (const sp of settingsPaths) {
        try {
            const s = JSON.parse(fs.readFileSync(sp, "utf8"));
            const allow = (s.permissions && s.permissions.allow) || [];
            if (isAlreadyCovered(pattern, allow)) return true;
        } catch(e) {}
    }
    return false;
}

async function processInput() {
    const startTime = Date.now();
    log("INPUT: " + rawInput.substring(0, 300));

    let data;
    try { data = JSON.parse(rawInput); } catch(e) {
        log("JSON parse failed: " + rawInput.substring(0, 200));
        process.exit(0); // fallback: Claude muestra prompt local
    }

    const toolName = data.tool_name || data.toolName || "desconocido";
    const toolInput = data.tool_input || data.toolInput || {};
    const agent = process.env.CLAUDE_AGENT_NAME || "Claude Code";
    const requestId = crypto.randomBytes(8).toString("hex");

    log("REPO_ROOT=" + REPO_ROOT + " MAIN=" + MAIN_REPO_ROOT + " tool=" + toolName);

    // Fast-path: auto-aprobar si la severidad es AUTO_ALLOW (directorio seguro / tool interno)
    const severity = classifySeverity(toolName, toolInput, REPO_ROOT);
    log("SEVERITY: " + toolName + " → " + severity);
    if (severity === Severity.AUTO_ALLOW) {
        log("AUTO_ALLOW (PermissionRequest): " + toolName + " auto-aprobado");
        const response = {
            hookSpecificOutput: {
                hookEventName: "PermissionRequest",
                decision: { behavior: "allow" }
            }
        };
        process.stdout.write(JSON.stringify(response) + "\n", () => process.exit(0));
        setTimeout(() => process.exit(0), 500);
        return;
    }

    // Fast-path: auto-aprobar si ya está cubierto por reglas existentes
    if (isCommandCoveredByRules(toolName, toolInput)) {
        log("AUTO-APPROVE: tool=" + toolName + " cubierto por settings rules");
        // Escribir marker para que notify-telegram.js sepa que fue auto-aprobado
        const autoApproveFile = path.join(MAIN_REPO_ROOT, ".claude", "hooks", "approver-last-auto.json");
        try { fs.writeFileSync(autoApproveFile, JSON.stringify({ timestamp: new Date().toISOString(), tool: toolName })); } catch(e) {}
        const response = {
            hookSpecificOutput: {
                hookEventName: "PermissionRequest",
                decision: { behavior: "allow" }
            }
        };
        process.stdout.write(JSON.stringify(response) + "\n", () => process.exit(0));
        setTimeout(() => process.exit(0), 500);
        return;
    }

    const action = formatAction(toolName, toolInput);
    const sessionId = data.session_id || "";
    const contextLine = formatContext(sessionId, MAIN_REPO_ROOT);
    const totalAttempts = RETRY_INTERVALS.length;

    // Verificar que commander esté corriendo antes de enviar el primer mensaje
    log("Verificando commander antes de enviar mensaje (requestId=" + requestId + ")");
    await ensureCommanderRunning();

    const firstWaitMin = Math.round(RETRY_INTERVALS[0] / 60000);
    let msgText = "⚠️ <b>" + escHtml(agent) + " — Permiso requerido</b> <i>(Intento 1/" + totalAttempts + ")</i>\n";
    if (contextLine) {
        msgText += contextLine + "\n";
    }
    msgText += "\n" + action + "\n\n"
        + "⏳ Expira en " + firstWaitMin + ":00\n"
        + "📝 Usar botones o responder: <b>siempre</b> (para persistir)";

    // Array para rastrear todos los messageIds enviados en este ciclo
    const sentMessageIds = [];

    // 1. Enviar mensaje con botones inline + instrucción de texto libre
    let sentMsg;
    try {
        sentMsg = await telegramPost("sendMessage", {
            chat_id: CHAT_ID,
            text: msgText,
            parse_mode: "HTML",
            reply_markup: {
                inline_keyboard: [[
                    { text: "✅ Permitir", callback_data: "allow:" + requestId },
                    { text: "❌ Rechazar", callback_data: "deny:" + requestId }
                ]]
            }
        }, 8000);
        log("Mensaje enviado: msg_id=" + sentMsg.message_id + " requestId=" + requestId + " attempt=1/" + totalAttempts + " ts=" + new Date().toISOString());
        sentMessageIds.push(sentMsg.message_id);
        registerMessage(sentMsg.message_id, "permission");

        // Registrar pregunta pendiente (con HTML original para que el commander lo use al editar)
        addPendingQuestion({
            id: requestId,
            type: "permission",
            message: action,
            original_html: msgText,
            telegram_message_id: sentMsg.message_id,
            options: [
                { label: "Permitir", action: "allow" },
                { label: "Denegar", action: "deny" }
            ],
            action_data: { tool_name: toolName, tool_input: toolInput, agent: agent },
            skill_context: getSkillContext(),
            approver_pid: process.pid
        });
    } catch(e) {
        log("Error enviando mensaje: " + e.message);
        process.exit(0); // fallback: Claude muestra prompt local
    }

    let currentMsgId = sentMsg.message_id;

    // Escribir PID file para que otros hooks puedan detectarnos/matarnos
    try { fs.writeFileSync(APPROVER_PID_FILE, JSON.stringify({ pid: process.pid, requestId, msgId: currentMsgId, timestamp: new Date().toISOString() })); } catch(e) {}
    function cleanupPidFile() { try { fs.unlinkSync(APPROVER_PID_FILE); } catch(e) {} }
    process.on("exit", cleanupPidFile);

    // ─── Retry loop con urgencia escalada ────────────────────────────────────
    // Intento 0: mensaje ya enviado arriba, pollear RETRY_INTERVALS[0]
    // Intentos 1..N: editar msg anterior → enviar nuevo con escalada → pollear

    for (let attempt = 0; attempt < totalAttempts; attempt++) {
        const waitMs = RETRY_INTERVALS[attempt];
        const label = "intento " + (attempt + 1) + "/" + totalAttempts;
        log("Iniciando polling " + label + " para " + requestId
            + " (PID=" + process.pid + ", espera=" + Math.round(waitMs/60000) + "min)");

        // Todos los intentos tienen botones inline activos
        const inlineKeyboard = [[
            { text: "✅ Permitir", callback_data: "allow:" + requestId },
            { text: "❌ Rechazar", callback_data: "deny:" + requestId }
        ]];

        const countdownOpts = {
            msgId: currentMsgId,
            baseText: msgText,
            inlineKeyboard: inlineKeyboard
        };

        const result = await pollQuestionStatus(requestId, waitMs, label, countdownOpts);

        // ── Cancelado externamente ──
        if (result && result.status === "cancelled") {
            log("Permiso cancelado externamente durante " + label);
            try {
                await telegramPost("editMessageText", {
                    chat_id: CHAT_ID,
                    message_id: currentMsgId,
                    text: msgText + "\n\n⏹ <i>Cancelado — respondiendo en consola</i>",
                    parse_mode: "HTML",
                    reply_markup: { inline_keyboard: [] }
                }, ANSWER_TIMEOUT);
            } catch(e) { log("Error editando mensaje cancelado: " + e.message); }
            process.exit(0); // fallback al prompt local
            return;
        }

        // ── Respondido ──
        if (result && result.status === "answered") {
            const actionResult = result.action_result;
            const latencyMs = Date.now() - startTime;

            if (result.answered_via === "console") {
                log("Respondido en consola — requestId=" + requestId + " latency=" + latencyMs + "ms (" + label + ")");
                process.exit(0);
            }

            log("Decisión via Telegram: action=" + actionResult + " requestId=" + requestId + " latency=" + latencyMs + "ms (" + label + ") via=" + (result.answered_via || "?"));

            const isAllow = (actionResult === "allow" || actionResult === "always");
            const response = {
                hookSpecificOutput: {
                    hookEventName: "PermissionRequest",
                    decision: isAllow
                        ? { behavior: "allow" }
                        : { behavior: "deny", message: "Denegado por el usuario vía Telegram" }
                }
            };
            process.stdout.write(JSON.stringify(response) + "\n", () => process.exit(0));
            setTimeout(() => process.exit(0), 2000);
            return;
        }

        // ── Timeout de este intento — ¿hay más reintentos? ──
        const isLastAttempt = (attempt === totalAttempts - 1);
        const elapsedTotal = Math.round((Date.now() - startTime) / 1000);

        if (isLastAttempt) {
            // Sin más reintentos — expirar definitivamente
            log("Todos los reintentos agotados: requestId=" + requestId + " elapsedTotal=" + elapsedTotal + "s attempts=" + totalAttempts + " sentMsgs=" + sentMessageIds.length);
            resolveQuestion(requestId, "expired", null);
            // Invalidar botones de TODOS los mensajes enviados
            for (const oldMsgId of sentMessageIds) {
                try {
                    await telegramPost("editMessageReplyMarkup", {
                        chat_id: CHAT_ID,
                        message_id: oldMsgId,
                        reply_markup: { inline_keyboard: [] }
                    }, ANSWER_TIMEOUT);
                } catch(e) { /* ok — puede fallar si ya fue editado */ }
            }
            try {
                await telegramPost("editMessageText", {
                    chat_id: CHAT_ID,
                    message_id: currentMsgId,
                    text: msgText + "\n\n⏱ <i>Expirado (" + totalAttempts + " intentos, " + elapsedTotal + "s) — respondiendo en consola</i>"
                        + "\n📝 Responder <b>siempre</b> para guardar el permiso",
                    parse_mode: "HTML",
                    reply_markup: { inline_keyboard: [] }
                }, ANSWER_TIMEOUT);
            } catch(e) { log("Error editando mensaje final: " + e.message); }
            process.exit(0); // fallback al prompt local
            return;
        }

        // ── Enviar reintento con urgencia escalada ──
        const nextAttempt = attempt + 1;
        const escalation = RETRY_ESCALATION[nextAttempt] || RETRY_ESCALATION[RETRY_ESCALATION.length - 1];
        const nextWaitMin = Math.round(RETRY_INTERVALS[nextAttempt] / 60000);

        log("Timeout " + label + ": requestId=" + requestId + " elapsedTotal=" + elapsedTotal + "s. Enviando reintento " + (nextAttempt + 1) + "/" + totalAttempts);

        // P-15: Registrar timeout de aprobación en ops-learnings
        if (opsLearnings) {
            try {
                opsLearnings.recordLearning({
                    source: "permission-approver",
                    category: "approval_timeout",
                    severity: nextAttempt >= totalAttempts - 1 ? "high" : "low",
                    symptom: "Timeout de aprobación: sin respuesta en " + elapsedTotal + "s",
                    root_cause: "Usuario no respondió a permiso pendiente (intento " + (nextAttempt + 1) + "/" + totalAttempts + ")",
                    affected: ["permission-approver.js"],
                    auto_detected: true
                });
            } catch (e) {}
        }

        // Invalidar botones de TODOS los mensajes anteriores (no solo el último)
        for (const oldMsgId of sentMessageIds) {
            try {
                await telegramPost("editMessageReplyMarkup", {
                    chat_id: CHAT_ID,
                    message_id: oldMsgId,
                    reply_markup: { inline_keyboard: [] }
                }, ANSWER_TIMEOUT);
            } catch(e) { /* ok — puede fallar si ya fue editado */ }
        }

        // Editar último mensaje: marcar como expirado
        try {
            await telegramPost("editMessageText", {
                chat_id: CHAT_ID,
                message_id: currentMsgId,
                text: msgText + "\n\n⏱ <i>Sin respuesta — reintentando…</i>",
                parse_mode: "HTML",
                reply_markup: { inline_keyboard: [] }
            }, ANSWER_TIMEOUT);
        } catch(e) { log("Error editando mensaje expirado: " + e.message); }

        // Construir mensaje de reintento con escalada
        let retryText = escalation.emoji + " <b>" + escHtml(agent) + " — " + escalation.title + "</b>"
            + " <i>(Intento " + (nextAttempt + 1) + "/" + totalAttempts + ")</i>\n";
        if (contextLine) {
            retryText += contextLine + "\n";
        }
        retryText += "\n" + escalation.desc + "\n\n" + action + "\n\n"
            + "⏳ Expira en " + nextWaitMin + ":00\n"
            + "📝 Usar botones o responder: <b>siempre</b> (para persistir)";

        // Enviar nuevo mensaje (genera nueva notificación en Telegram)
        try {
            const retryMsg = await telegramPost("sendMessage", {
                chat_id: CHAT_ID,
                text: retryText,
                parse_mode: "HTML",
                reply_markup: {
                    inline_keyboard: [[
                        { text: "✅ Permitir", callback_data: "allow:" + requestId },
                        { text: "❌ Rechazar", callback_data: "deny:" + requestId }
                    ]]
                }
            }, 8000);
            currentMsgId = retryMsg.message_id;
            sentMessageIds.push(retryMsg.message_id);
            registerMessage(retryMsg.message_id, "permission");
            // Actualizar message_id en pending question para que el commander lo encuentre
            updateQuestionField(requestId, { telegram_message_id: retryMsg.message_id });
            // Actualizar msgText para que el próximo edit/expire use el texto correcto
            msgText = retryText;
            log("Reintento enviado: msg_id=" + retryMsg.message_id + " requestId=" + requestId + " attempt=" + (nextAttempt + 1) + "/" + totalAttempts + " ts=" + new Date().toISOString());
        } catch(e) {
            log("Error enviando reintento: " + e.message + " — continuando con polling");
        }
    }
}
