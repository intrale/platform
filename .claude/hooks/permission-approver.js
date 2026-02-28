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
const { generatePattern, getSettingsPaths, persistPattern, resolveMainRepoRoot, isAlreadyCovered, extractFirstCommand, generateBashPattern } = require("./permission-utils");

const { addPendingQuestion, resolveQuestion, getQuestionById } = require("./pending-questions");
const { readSessionContext } = require("./context-reader");
const { registerMessage } = require("./telegram-message-registry");
const _tgCfg = JSON.parse(require("fs").readFileSync(require("path").join(__dirname, "telegram-config.json"), "utf8"));
const BOT_TOKEN = _tgCfg.bot_token;
const CHAT_ID = _tgCfg.chat_id;
const ANSWER_TIMEOUT = 5000;   // Timeout para editMessage

// Tiempos de polling: el hook tiene timeout de 615s en settings.json
// Salir 15s antes para poder hacer cleanup (marcar expired, editar mensaje)
const HOOK_TIMEOUT_MS = 600000;   // 10 min — margen de 15s antes del kill
const POLL_INTERVAL_MS = 500;    // Verificar pending-questions.json cada 0.5s

const REPO_ROOT = process.env.CLAUDE_PROJECT_DIR || "C:\\Workspaces\\Intrale\\platform";
const MAIN_REPO_ROOT = resolveMainRepoRoot(REPO_ROOT) || REPO_ROOT;
const LOG_FILE = path.join(MAIN_REPO_ROOT, ".claude", "hooks", "hook-debug.log");
const SESSION_STORE_FILE = path.join(MAIN_REPO_ROOT, ".claude", "hooks", "tg-session-store.json");

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
// Lee el archivo cada POLL_INTERVAL_MS para detectar cuando el commander
// procesó el callback del botón y escribió la decisión.

// Archivo PID para que otros hooks puedan detectar/matar este approver
const APPROVER_PID_FILE = path.join(MAIN_REPO_ROOT, ".claude", "hooks", "approver-active.pid");

async function pollQuestionStatus(requestId, startTime) {
    while (Date.now() - startTime < HOOK_TIMEOUT_MS) {
        try {
            const q = getQuestionById(requestId);
            if (!q) {
                log("Pregunta " + requestId + " desapareció de pending-questions.json");
                return null;
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
        // Log de diagnóstico cada 10 ciclos (~15s)
        const elapsed = Date.now() - startTime;
        if (Math.floor(elapsed / POLL_INTERVAL_MS) % 10 === 0) {
            log("Polling " + requestId + ": " + Math.round(elapsed/1000) + "s, aún pending, pid=" + process.pid);
        }
        await sleep(POLL_INTERVAL_MS);
    }
    return null; // timeout — el hook se va a morir pronto
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

    // Para Bash con comandos compuestos (;, &&, |), verificar cada sub-comando
    if (toolName === "Bash" && toolInput.command) {
        const cmd = toolInput.command.trim();
        const separators = /;|&&/;
        if (separators.test(cmd)) {
            // Extraer todos los sub-comandos y verificar cada uno
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
                    // Verificar que el patrón principal no colisione con deny
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

    // Fast-path: auto-aprobar si ya está cubierto por reglas existentes
    if (isCommandCoveredByRules(toolName, toolInput)) {
        log("AUTO-APPROVE: tool=" + toolName + " cubierto por settings rules");
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

    let msgText = "⚠️ <b>" + escHtml(agent) + " — Permiso requerido</b>\n";
    if (contextLine) {
        msgText += contextLine + "\n";
    }
    msgText += "\n" + action + "\n\n"
        + "📝 Usar botones o responder: <b>siempre</b> (para persistir)";

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
        log("Mensaje enviado: msg_id=" + sentMsg.message_id + " requestId=" + requestId);
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

    const msgId = sentMsg.message_id;

    // Escribir PID file para que otros hooks puedan detectarnos/matarnos
    try { fs.writeFileSync(APPROVER_PID_FILE, JSON.stringify({ pid: process.pid, requestId, msgId, timestamp: new Date().toISOString() })); } catch(e) {}
    function cleanupPidFile() { try { fs.unlinkSync(APPROVER_PID_FILE); } catch(e) {} }
    process.on("exit", cleanupPidFile);

    // 2. Polling de pending-questions.json esperando que el commander procese el callback
    //    El commander es el único consumidor de getUpdates — no hay conflicto de offsets
    log("Iniciando polling para " + requestId + " (PID=" + process.pid + ", timeout=" + HOOK_TIMEOUT_MS + "ms)");
    const result = await pollQuestionStatus(requestId, startTime);
    const latencyMs = Date.now() - startTime;

    // 3. Manejar resultado
    if (result && result.status === "answered") {
        const actionResult = result.action_result;

        if (result.answered_via === "console") {
            // Respondido en consola — no necesitamos hacer nada, salir sin stdout
            log("Respondido en consola — saliendo sin stdout (" + latencyMs + "ms)");
            process.exit(0);
        }

        // Respondido via Telegram (el commander ya editó el mensaje y persistió si era "always")
        log("Decisión via Telegram: " + actionResult + " en " + latencyMs + "ms");

        const isAllow = (actionResult === "allow" || actionResult === "always");
        const response = {
            hookSpecificOutput: {
                hookEventName: "PermissionRequest",
                decision: isAllow
                    ? { behavior: "allow" }
                    : { behavior: "deny", message: "Denegado por el usuario vía Telegram" }
            }
        };

        process.stdout.write(JSON.stringify(response) + "\n", () => {
            process.exit(0);
        });
        // Fallback: si el callback nunca se invoca, salir después de 2s
        setTimeout(() => process.exit(0), 2000);
        return;
    }

    // 4. Timeout — el usuario no respondió dentro de los ~50s
    //    Marcar como expired y editar mensaje ANTES de que Claude nos mate a los 55s
    log("Timeout sin respuesta (" + latencyMs + "ms). Editando mensaje a expirado.");
    resolveQuestion(requestId, "expired", null);
    try {
        await telegramPost("editMessageText", {
            chat_id: CHAT_ID,
            message_id: msgId,
            text: msgText + "\n\n⏱ <i>Expirado — respondiendo en consola</i>\n📝 Responder <b>siempre</b> para guardar el permiso",
            parse_mode: "HTML",
            reply_markup: { inline_keyboard: [] }
        }, ANSWER_TIMEOUT);
    } catch(e) { log("Error editando mensaje timeout: " + e.message); }
    process.exit(0); // fallback al prompt local
}
