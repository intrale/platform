// permission-gate.js — Hook PreToolUse para permisos via Telegram
// Reemplaza a permission-approver.js (PermissionRequest) que no dispara de forma confiable
// (bugs conocidos de Claude Code: #12176, #29212)
//
// Flujo PreToolUse:
//   permissionDecision: "allow" → bypass del dialogo de permisos (tool se ejecuta)
//   permissionDecision: "deny"  → bloquear tool
//   Sin output                  → flujo normal de Claude Code (dialogo local)
//
// Maneja TODAS las herramientas que disparan PreToolUse (Bash, Edit, Write, etc.)
//
// IMPORTANTE: Este hook NO usa getUpdates de Telegram. El telegram-commander.js
// es el unico consumidor de getUpdates, evitando conflictos de offset/409.

const https = require("https");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const { generatePattern, generateBashPattern, getSettingsPaths, persistPattern, resolveMainRepoRoot, isAlreadyCovered } = require("./permission-utils");
const { addPendingQuestion, resolveQuestion, getQuestionById, updateQuestionField } = require("./pending-questions");
const { incrementApproval, isPatternPersisted } = require("./approval-history");
const { readSessionContext } = require("./context-reader");
const { registerMessage } = require("./telegram-message-registry");

const _tgCfg = JSON.parse(fs.readFileSync(path.join(__dirname, "telegram-config.json"), "utf8"));
const BOT_TOKEN = _tgCfg.bot_token;
const CHAT_ID = _tgCfg.chat_id;
const ANSWER_TIMEOUT = 5000;
const POLL_INTERVAL_MS = 150;

// ─── Retry schedule con urgencia escalada ────────────────────────────────────
// Default: [15, 8, 5, 2] = 30 min total
// Configurable desde telegram-config.json → gate_retry_intervals_min
const DEFAULT_GATE_RETRY_INTERVALS = [15, 8, 5, 2]; // minutos
const RETRY_INTERVALS = (_tgCfg.gate_retry_intervals_min || DEFAULT_GATE_RETRY_INTERVALS)
    .map(m => m * 60 * 1000);

const RETRY_ESCALATION = [
    { emoji: "\u{1F510}", title: "PERMISO REQUERIDO", desc: "" },
    { emoji: "\u{1F514}", title: "Recordatorio", desc: "Hay un permiso pendiente desde hace rato" },
    { emoji: "\u26A0\uFE0F", title: "Agente bloqueado", desc: "El agente no puede continuar sin tu aprobacion" },
    { emoji: "\u{1F6A8}", title: "Ultimo aviso", desc: "Si no respondes, el agente pedira en consola" }
];

const REPO_ROOT = process.env.CLAUDE_PROJECT_DIR || "C:\\Workspaces\\Intrale\\platform";
const MAIN_REPO_ROOT = resolveMainRepoRoot(REPO_ROOT) || REPO_ROOT;
const LOG_FILE = path.join(MAIN_REPO_ROOT, ".claude", "hooks", "hook-debug.log");
const SESSION_STORE_FILE = path.join(MAIN_REPO_ROOT, ".claude", "hooks", "tg-session-store.json");
const APPROVER_PID_FILE = path.join(MAIN_REPO_ROOT, ".claude", "hooks", "approver-active.pid");

// ─── Helpers ─────────────────────────────────────────────────────────────────

function log(msg) {
    try { fs.appendFileSync(LOG_FILE, "[" + new Date().toISOString() + "] Gate: " + msg + "\n"); } catch(e) {}
}

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

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function escHtml(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function abbreviate(str, max) {
    if (!str) return "";
    str = str.trim();
    return str.length > max ? str.substring(0, max) + "\u2026" : str;
}

function getSkillContext() {
    try {
        const data = JSON.parse(fs.readFileSync(SESSION_STORE_FILE, "utf8"));
        const session = data.active_session;
        if (!session || !session.skill) return null;
        const elapsed = Date.now() - new Date(session.last_used).getTime();
        if (elapsed > 30 * 60 * 1000) return null;
        return session.skill;
    } catch (e) {
        return null;
    }
}

// ─── Formato de accion para el mensaje ────────────────────────────────────────

function shortenPath(filePath) {
    if (!filePath) return "";
    const normalized = filePath.replace(/\\/g, "/");
    const markers = ["/platform/", "/Intrale/"];
    for (const m of markers) {
        const idx = normalized.indexOf(m);
        if (idx >= 0) return normalized.substring(idx + m.length);
    }
    const parts = normalized.split("/");
    return parts.length > 3 ? "\u2026/" + parts.slice(-3).join("/") : normalized;
}

function formatAction(toolName, toolInput) {
    switch (toolName) {
        case "Bash": {
            const cmd = (toolInput.command || "").trim();
            const desc = (toolInput.description || "").trim();
            const display = cmd.length > 250 ? cmd.substring(0, 250) + "\u2026" : cmd;
            let result = "";
            if (desc) {
                result += "\u{1F527} <b>" + escHtml(abbreviate(desc, 80)) + "</b>\n";
            }
            result += "<code>$ " + escHtml(display) + "</code>";
            return result;
        }
        case "Edit": {
            const shortPath = shortenPath(toolInput.file_path);
            let result = "\u{1F4DD} <b>Editar</b> <code>" + escHtml(shortPath) + "</code>";
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
            let result = "\u{1F4C4} <b>Escribir</b> <code>" + escHtml(shortPath) + "</code>";
            if (content) {
                const preview = content.split("\n").slice(0, 3).join("\n");
                result += "\n<pre>" + escHtml(abbreviate(preview, 150)) + "</pre>";
            }
            return result;
        }
        case "Task":
            return "\u{1F916} <b>Subagente</b> [" + escHtml(toolInput.subagent_type || "?") + "] " + escHtml(abbreviate(toolInput.description || "", 80));
        case "TaskUpdate":
        case "Update":
            return "\u{1F4CB} <b>TaskUpdate</b> #" + escHtml(toolInput.taskId || "?") + " \u2192 " + escHtml(toolInput.status || toolInput.subject || JSON.stringify(toolInput).substring(0, 80));
        case "TaskCreate":
        case "Create":
            return "\u{1F4CB} <b>TaskCreate</b> " + escHtml(abbreviate(toolInput.subject || "", 80));
        case "Skill":
            return "\u26A1 <b>Skill</b> /" + escHtml(toolInput.skill || "") + (toolInput.args ? " " + escHtml(abbreviate(toolInput.args, 60)) : "");
        case "WebFetch":
            return "\u{1F310} <b>Fetch</b> " + escHtml(abbreviate(toolInput.url || "", 100));
        case "WebSearch":
            return "\u{1F50D} <b>Buscar</b> " + escHtml(abbreviate(toolInput.query || "", 80));
        case "NotebookEdit":
            return "\u{1F4D3} <b>NotebookEdit</b> " + escHtml(abbreviate(toolInput.notebook_path || "", 80));
        default:
            return "\u{1F6E0} <b>" + escHtml(toolName) + "</b> " + escHtml(abbreviate(JSON.stringify(toolInput), 120));
    }
}

function formatContext(sessionId, repoRoot) {
    const ctx = readSessionContext(sessionId, repoRoot);
    const lines = [];
    if (ctx.agentName) {
        lines.push("\u{1F916} " + escHtml(ctx.agentName));
    } else if (ctx.skill) {
        lines.push("\u26A1 /" + escHtml(ctx.skill));
    }
    if (ctx.branch && ctx.branch !== "main" && ctx.branch !== "develop") {
        let branchDisplay = escHtml(ctx.branch);
        const issueMatch = ctx.branch.match(/(?:agent|feature|bugfix)\/(\d+)/);
        if (issueMatch) branchDisplay += " (#" + issueMatch[1] + ")";
        lines.push("\u{1F500} " + branchDisplay);
    }
    if (ctx.task) {
        lines.push("\u{1F4CC} " + escHtml(abbreviate(ctx.task, 60)));
    }
    return lines.length > 0 ? lines.join("  \u00B7  ") : "";
}

// ─── Auto-approve: fast-path para comandos ya cubiertos ─────────────────────

function isToolCoveredByRules(toolName, toolInput) {
    const pattern = generatePattern(toolName, toolInput);
    if (!pattern) return false;

    // Para Bash con comandos compuestos (;, &&, |), verificar cada sub-comando
    if (toolName === "Bash" && toolInput.command) {
        const cmd = (toolInput.command || "").trim();
        const separators = /;|&&/;

        if (separators.test(cmd)) {
            const subCmds = cmd.split(separators).map(s => s.trim()).filter(Boolean);
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

// ─── Polling ──────────────────────────────────────────────────────────────────

async function pollQuestionStatus(requestId, durationMs, attemptLabel) {
    const pollStart = Date.now();
    let logCounter = 0;
    while (Date.now() - pollStart < durationMs) {
        try {
            const q = getQuestionById(requestId);
            if (!q) {
                log("Pregunta " + requestId + " desaparecio");
                return null;
            }
            if (q.status !== "pending") {
                log("Pregunta " + requestId + " cambio a: " + q.status
                    + " via=" + (q.answered_via || "?")
                    + " action=" + (q.action_result || "?"));
                return q;
            }
        } catch(e) {
            log("Error leyendo pregunta " + requestId + ": " + e.message);
        }
        logCounter++;
        if (logCounter % 200 === 0) {
            const elapsed = Math.round((Date.now() - pollStart) / 1000);
            log("Polling " + attemptLabel + " " + requestId + ": " + elapsed + "s elapsed, pid=" + process.pid);
        }
        await sleep(POLL_INTERVAL_MS);
    }
    return null;
}

// ─── PreToolUse response helpers ──────────────────────────────────────────────

function outputAllow(reason) {
    const response = JSON.stringify({
        hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "allow",
            permissionDecisionReason: reason || "Aprobado via Telegram"
        }
    });
    process.stdout.write(response + "\n", () => process.exit(0));
    setTimeout(() => process.exit(0), 500);
}

function outputDeny(reason) {
    const response = JSON.stringify({
        hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason: reason || "Denegado por el usuario via Telegram"
        }
    });
    process.stdout.write(response + "\n", () => process.exit(0));
    setTimeout(() => process.exit(0), 500);
}

function exitSilent() {
    process.exit(0);
}

// ─── Smart suggestion (tras 3ra aprobacion del mismo patron) ──────────────────

async function maybeSuggestPersistence(toolName, toolInput) {
    try {
        const pattern = generatePattern(toolName, toolInput);
        if (!pattern || isPatternPersisted(pattern)) return;

        const { count, shouldSuggest } = incrementApproval(pattern);
        if (!shouldSuggest) return;

        const encodedPattern = Buffer.from(pattern).toString("base64url");
        const suggestionText = "\u{1F4A1} Has aprobado <code>" + escHtml(pattern) + "</code> " + count + " veces.\n"
            + "\u00BFGuardar como regla permanente?";

        const msg = await telegramPost("sendMessage", {
            chat_id: CHAT_ID,
            text: suggestionText,
            parse_mode: "HTML",
            reply_markup: {
                inline_keyboard: [[
                    { text: "\u2705 Guardar", callback_data: "persist:" + encodedPattern },
                    { text: "\u274C No", callback_data: "dismiss:" + encodedPattern }
                ]]
            }
        }, 8000);
        registerMessage(msg.message_id, "permission");
        log("Smart suggestion enviada para " + pattern + " (count=" + count + ")");
    } catch(e) {
        log("Error en smart suggestion: " + e.message);
    }
}

// ─── Persist "always" ─────────────────────────────────────────────────────────

function persistAlways(toolName, toolInput) {
    const pattern = generatePattern(toolName, toolInput);
    log("persistAlways: pattern=" + (pattern || "NULL"));
    if (!pattern) return;
    const settingsPaths = getSettingsPaths(REPO_ROOT);
    persistPattern(pattern, settingsPaths, log);
}

// ─── Stdin reader ─────────────────────────────────────────────────────────────

const MAX_READ = 8192;
let rawInput = "";
let done = false;

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
    if (done) return;
    rawInput += chunk;
    if (rawInput.length >= MAX_READ) {
        done = true;
        process.stdin.destroy();
        processInput().catch(fatalExit);
    }
});
process.stdin.on("end", () => {
    if (!done) { done = true; processInput().catch(fatalExit); }
});
process.stdin.on("error", () => {
    if (!done) { done = true; processInput().catch(fatalExit); }
});
setTimeout(() => {
    if (!done) {
        done = true;
        try { process.stdin.destroy(); } catch(e) {}
        processInput().catch(fatalExit);
    }
}, 3000);

function fatalExit(e) {
    log("Fatal error: " + (e && e.message || e));
    process.exit(0); // fallback a dialogo local
}

// ─── Main ──────────────────────────────────────────────────────────────────────

async function processInput() {
    const startTime = Date.now();
    log("INPUT: " + rawInput.substring(0, 300));

    let data;
    try { data = JSON.parse(rawInput); } catch(e) {
        log("JSON parse failed: " + rawInput.substring(0, 200));
        exitSilent();
        return;
    }

    const toolName = data.tool_name || data.toolName || "";
    const toolInput = data.tool_input || data.toolInput || {};

    // Tools que nunca necesitan aprobacion remota (read-only, internas)
    const SKIP_TOOLS = ["Read", "Glob", "Grep", "TodoRead", "TaskList", "TaskGet"];
    if (SKIP_TOOLS.includes(toolName)) {
        exitSilent();
        return;
    }

    const agent = process.env.CLAUDE_AGENT_NAME || "Claude Code";
    const requestId = crypto.randomBytes(8).toString("hex");

    log("REPO_ROOT=" + REPO_ROOT + " MAIN=" + MAIN_REPO_ROOT + " tool=" + toolName);

    // Fast-path: auto-allow si esta cubierto por reglas existentes
    if (isToolCoveredByRules(toolName, toolInput)) {
        log("COVERED: " + toolName + " ya cubierto por settings rules — saliendo sin output");
        exitSilent(); // Claude Code lo aprobara via su propia logica
        return;
    }

    // ─── Necesita permiso → Enviar a Telegram ────────────────────────────────
    const action = formatAction(toolName, toolInput);
    const sessionId = data.session_id || "";
    const contextLine = formatContext(sessionId, MAIN_REPO_ROOT);
    const waitMin = Math.round(RETRY_INTERVALS[0] / 60000);

    let msgText = "\u{1F510} <b>" + escHtml(agent) + " \u2014 PERMISO REQUERIDO</b>\n";
    if (contextLine) msgText += contextLine + "\n";
    msgText += "\n" + action + "\n\n"
        + "\u23F3 Expira en " + waitMin + " min"
        + "\n\u{1F4DD} Usar botones o responder: <b>siempre</b> (para persistir)";

    let sentMsg;
    try {
        sentMsg = await telegramPost("sendMessage", {
            chat_id: CHAT_ID,
            text: msgText,
            parse_mode: "HTML",
            reply_markup: {
                inline_keyboard: [[
                    { text: "\u2705 Permitir", callback_data: "allow:" + requestId },
                    { text: "\u274C Rechazar", callback_data: "deny:" + requestId }
                ]]
            }
        }, 8000);
        log("Mensaje enviado: msg_id=" + sentMsg.message_id + " requestId=" + requestId);
        registerMessage(sentMsg.message_id, "permission");

        addPendingQuestion({
            id: requestId,
            type: "permission",
            message: action,
            original_html: msgText,
            telegram_message_id: sentMsg.message_id,
            options: [
                { label: "Permitir", action: "allow" },
                { label: "Rechazar", action: "deny" }
            ],
            action_data: { tool_name: toolName, tool_input: toolInput, agent: agent },
            skill_context: getSkillContext(),
            approver_pid: process.pid
        });
    } catch(e) {
        log("Error enviando mensaje: " + e.message);
        exitSilent(); // fallback a dialogo local
        return;
    }

    let currentMsgId = sentMsg.message_id;

    // PID file para deteccion por otros hooks
    try {
        fs.writeFileSync(APPROVER_PID_FILE, JSON.stringify({
            pid: process.pid,
            requestId,
            msgId: currentMsgId,
            timestamp: new Date().toISOString()
        }));
    } catch(e) {}
    function cleanupPidFile() { try { fs.unlinkSync(APPROVER_PID_FILE); } catch(e) {} }
    process.on("exit", cleanupPidFile);

    // ─── Retry loop con urgencia escalada ────────────────────────────────────
    const totalAttempts = RETRY_INTERVALS.length;

    for (let attempt = 0; attempt < totalAttempts; attempt++) {
        const waitMs = RETRY_INTERVALS[attempt];
        const label = "intento " + (attempt + 1) + "/" + totalAttempts;
        log("Polling " + label + " para " + requestId
            + " (PID=" + process.pid + ", espera=" + Math.round(waitMs / 60000) + "min)");

        const result = await pollQuestionStatus(requestId, waitMs, label);

        // ── Respondido ──
        if (result && result.status === "answered") {
            const actionResult = result.action_result;
            const latencyMs = Date.now() - startTime;

            log("Decision via Telegram: " + actionResult + " en " + latencyMs + "ms (" + label + ")");

            const isAllow = (actionResult === "allow" || actionResult === "always");

            if (isAllow) {
                // Track approval + smart suggestion (no bloquea la respuesta)
                maybeSuggestPersistence(toolName, toolInput).catch(e => log("Suggestion error: " + e.message));

                if (actionResult === "always") {
                    persistAlways(toolName, toolInput);
                }

                outputAllow("Aprobado via Telegram por el usuario (" + latencyMs + "ms)");
            } else {
                outputDeny("Denegado por el usuario via Telegram (" + latencyMs + "ms)");
            }
            return;
        }

        // ── Timeout de este intento ──
        const isLastAttempt = (attempt === totalAttempts - 1);
        const elapsedTotal = Math.round((Date.now() - startTime) / 1000);

        if (isLastAttempt) {
            log("Todos los reintentos agotados (" + elapsedTotal + "s total). Fallback a consola.");
            resolveQuestion(requestId, "expired", null);
            try {
                await telegramPost("editMessageText", {
                    chat_id: CHAT_ID,
                    message_id: currentMsgId,
                    text: msgText + "\n\n\u23F1 <i>Expirado (" + totalAttempts + " intentos) \u2014 respondiendo en consola</i>",
                    parse_mode: "HTML",
                    reply_markup: { inline_keyboard: [] }
                }, ANSWER_TIMEOUT);
            } catch(e) { log("Error editando mensaje final: " + e.message); }
            exitSilent(); // fallback a dialogo local
            return;
        }

        // ── Enviar reintento con urgencia escalada ──
        const nextAttempt = attempt + 1;
        const escalation = RETRY_ESCALATION[nextAttempt] || RETRY_ESCALATION[RETRY_ESCALATION.length - 1];
        const nextWaitMin = Math.round(RETRY_INTERVALS[nextAttempt] / 60000);

        log("Timeout " + label + " (" + elapsedTotal + "s). Enviando reintento " + (nextAttempt + 1) + "/" + totalAttempts);

        // Editar mensaje anterior: quitar botones, marcar como expirado
        try {
            await telegramPost("editMessageText", {
                chat_id: CHAT_ID,
                message_id: currentMsgId,
                text: msgText + "\n\n\u23F1 <i>Sin respuesta \u2014 reintentando\u2026</i>",
                parse_mode: "HTML",
                reply_markup: { inline_keyboard: [] }
            }, ANSWER_TIMEOUT);
        } catch(e) { log("Error editando mensaje expirado: " + e.message); }

        // Construir mensaje de reintento
        let retryText = escalation.emoji + " <b>" + escHtml(agent) + " \u2014 " + escalation.title + "</b>"
            + "  <i>(" + (nextAttempt + 1) + "/" + totalAttempts + ")</i>\n";
        if (contextLine) retryText += contextLine + "\n";
        if (escalation.desc) retryText += "\n" + escalation.desc + "\n";
        retryText += "\n" + action + "\n\n"
            + "\u23F3 Expira en " + nextWaitMin + " min"
            + "\n\u{1F4DD} Usar botones o responder: <b>siempre</b> (para persistir)";

        try {
            const retryMsg = await telegramPost("sendMessage", {
                chat_id: CHAT_ID,
                text: retryText,
                parse_mode: "HTML",
                reply_markup: {
                    inline_keyboard: [[
                        { text: "\u2705 Permitir", callback_data: "allow:" + requestId },
                        { text: "\u274C Rechazar", callback_data: "deny:" + requestId }
                    ]]
                }
            }, 8000);
            currentMsgId = retryMsg.message_id;
            registerMessage(retryMsg.message_id, "permission");
            updateQuestionField(requestId, { telegram_message_id: retryMsg.message_id });
            msgText = retryText;
            log("Reintento " + (nextAttempt + 1) + "/" + totalAttempts + " enviado: msg_id=" + retryMsg.message_id);
        } catch(e) {
            log("Error enviando reintento: " + e.message);
        }
    }
}
