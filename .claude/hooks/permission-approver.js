// permission-approver.js — PoC spike #834
// Hook PermissionRequest v2: aprobación remota vía Telegram inline buttons
// Flujo: envía mensaje con botones → polling callback_query → devuelve decisión via stdout
// Pure Node.js — sin dependencia de bash
//
// Salidas posibles:
//   stdout {"behavior": "allow"}             → Claude aprueba sin mostrar UI local
//   stdout {"behavior": "deny", "message"}   → Claude deniega
//   sin stdout (timeout)                     → Claude muestra prompt local como fallback

const https = require("https");
const querystring = require("querystring");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const BOT_TOKEN = "8403197784:AAG07242gOCKwZ-G-DI8eLC6R1HwfhG6Exk";
const CHAT_ID = "6529617704";
const POLL_TIMEOUT_SEC = 20;   // Telegram long-poll: esperar hasta 20s por update
const MAX_POLL_CYCLES = 15;    // Máximo 15 ciclos = 5 minutos antes de fallback
const ANSWER_TIMEOUT = 5000;   // Timeout para answerCallbackQuery y editMessage

const REPO_ROOT = process.env.CLAUDE_PROJECT_DIR || "C:\\Workspaces\\Intrale\\platform";
const SETTINGS_PATH = path.join(REPO_ROOT, ".claude", "settings.local.json");
const LOG_FILE = path.join(REPO_ROOT, ".claude", "hooks", "hook-debug.log");
const OFFSET_FILE = path.join(REPO_ROOT, ".claude", "hooks", "tg-approver-offset.json");

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

// ─── Formato de acción para el mensaje ────────────────────────────────────────

function escHtml(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function formatAction(toolName, toolInput) {
    switch (toolName) {
        case "Bash": {
            const cmd = (toolInput.command || "").trim();
            const display = cmd.length > 250 ? cmd.substring(0, 250) + "…" : cmd;
            return "$ " + escHtml(display);
        }
        case "Edit":
            return "Edit " + escHtml(toolInput.file_path || "");
        case "Write":
            return "Write " + escHtml(toolInput.file_path || "");
        case "Task":
            return "Task [" + escHtml(toolInput.subagent_type || "?") + "] " + escHtml(toolInput.description || "");
        case "Skill":
            return "/" + escHtml(toolInput.skill || "") + (toolInput.args ? " " + escHtml(toolInput.args) : "");
        case "WebFetch":
            return "fetch " + escHtml(toolInput.url || "");
        case "WebSearch":
            return "search " + escHtml(toolInput.query || "");
        default:
            return escHtml(toolName) + " " + escHtml(JSON.stringify(toolInput).substring(0, 100));
    }
}

// ─── Patrón de permiso para persistencia ("Siempre") ──────────────────────────

function generatePattern(toolName, toolInput) {
    if (toolName === "Bash") {
        const cmd = (toolInput.command || "").trim();
        if (!cmd) return null;
        const parts = cmd.split(/\s+/);
        const first = parts[0];
        if (first === "git" && parts[1]) return "Bash(git " + parts[1] + ":*)";
        if (first.startsWith("./") || first.startsWith("/")) return "Bash(" + first + ":*)";
        return "Bash(" + first + ":*)";
    }
    if (toolName === "WebFetch") {
        try {
            const u = new URL(toolInput.url || "");
            return "WebFetch(domain:" + u.hostname + ")";
        } catch(e) { return null; }
    }
    if (toolName === "Skill") {
        const s = toolInput.skill || "";
        return s ? "Skill(" + s + ")" : null;
    }
    return null;
}

function persistAlways(toolName, toolInput) {
    try {
        const pattern = generatePattern(toolName, toolInput);
        if (!pattern) return;
        if (!fs.existsSync(SETTINGS_PATH)) return;
        const settings = JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf8"));
        const allow = (settings.permissions && settings.permissions.allow) || [];
        if (!allow.includes(pattern)) {
            allow.push(pattern);
            settings.permissions = settings.permissions || {};
            settings.permissions.allow = allow;
            fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2) + "\n", "utf8");
            log("Persistido 'siempre': " + pattern);
        }
    } catch(e) {
        log("Error persistiendo 'siempre': " + e.message);
    }
}

// ─── Offset persistente (compartido entre invocaciones del hook) ──────────────
// Evita que dos hooks corran simultáneamente desde offset=0 o se pisen entre sí

function loadOffset() {
    try {
        const data = JSON.parse(fs.readFileSync(OFFSET_FILE, "utf8"));
        return data.offset || 0;
    } catch(e) { return 0; }
}

function saveOffset(offset) {
    try { fs.writeFileSync(OFFSET_FILE, JSON.stringify({ offset }), "utf8"); } catch(e) {}
}

// ─── Telegram: obtener offset actual (para ignorar updates previos) ────────────

async function getCurrentOffset() {
    // Primero revisar el archivo persistente
    const saved = loadOffset();

    try {
        const updates = await telegramPost("getUpdates", {
            limit: 1,
            timeout: 0,
            allowed_updates: ["callback_query"]
        }, 5000);
        if (updates && updates.length > 0) {
            const fresh = updates[updates.length - 1].update_id + 1;
            // Usar el mayor entre el guardado y el actual (nunca retroceder)
            return Math.max(saved, fresh);
        }
        // Sin updates nuevos: confiar en el guardado (ya está al día)
        return saved;
    } catch(e) {
        log("getCurrentOffset error: " + e.message);
        return saved;
    }
}

// ─── Telegram: poll para nuestro requestId ────────────────────────────────────

async function pollForDecision(requestId, msgId, offset) {
    let currentOffset = offset;

    for (let cycle = 0; cycle < MAX_POLL_CYCLES; cycle++) {
        log("Ciclo de polling " + (cycle + 1) + "/" + MAX_POLL_CYCLES + " offset=" + currentOffset);

        let updates;
        try {
            updates = await telegramPost("getUpdates", {
                offset: currentOffset,
                timeout: POLL_TIMEOUT_SEC,
                allowed_updates: ["callback_query"]
            }, (POLL_TIMEOUT_SEC + 5) * 1000);
        } catch(e) {
            log("getUpdates error ciclo " + cycle + ": " + e.message);
            continue;
        }

        if (!updates || !Array.isArray(updates)) continue;

        for (const update of updates) {
            if (update.update_id >= currentOffset) {
                currentOffset = update.update_id + 1;
            }

            const cq = update.callback_query;
            if (!cq || !cq.data) continue;

            // Verificar seguridad: solo aceptar del chat correcto
            if (String(cq.message && cq.message.chat && cq.message.chat.id) !== String(CHAT_ID)) {
                log("Callback de chat desconocido: " + JSON.stringify(cq.message && cq.message.chat));
                continue;
            }

            // Verificar que el callback es para NUESTRO mensaje (doble seguridad)
            if (cq.message && cq.message.message_id !== msgId) {
                log("Callback de otro mensaje: " + cq.message.message_id + " (esperaba " + msgId + ")");
                continue;
            }

            // Extraer acción y requestId del callback_data
            const parts = cq.data.split(":");
            if (parts.length < 2) continue;
            const action = parts[0]; // "allow", "always", "deny"
            const cbRequestId = parts.slice(1).join(":"); // el resto es el requestId

            if (cbRequestId !== requestId) {
                log("Callback de otra solicitud: " + cbRequestId + " (esperaba " + requestId + ")");
                continue;
            }

            log("Decisión recibida: " + action + " para " + requestId + " en ciclo " + cycle);
            saveOffset(currentOffset); // persistir el offset al recibir decisión
            return { action, callbackQueryId: cq.id, messageId: cq.message && cq.message.message_id };
        }
    }

    return null; // timeout
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

    const action = formatAction(toolName, toolInput);

    const msgText = "⚠️ <b>" + escHtml(agent) + " — Permiso requerido</b>\n\n"
        + "<code>" + action + "</code>\n\n"
        + "¿Qué hacemos?";

    // 1. Obtener offset actual ANTES de enviar el mensaje
    let offset;
    try {
        offset = await getCurrentOffset();
        log("Offset inicial: " + offset);
    } catch(e) {
        log("Error obteniendo offset: " + e.message);
        process.exit(0);
    }

    // 2. Enviar mensaje con inline buttons
    let sentMsg;
    try {
        sentMsg = await telegramPost("sendMessage", {
            chat_id: CHAT_ID,
            text: msgText,
            parse_mode: "HTML",
            reply_markup: {
                inline_keyboard: [[
                    { text: "✅ Permitir", callback_data: "allow:" + requestId },
                    { text: "✅ Siempre",  callback_data: "always:" + requestId },
                    { text: "❌ Denegar",  callback_data: "deny:" + requestId }
                ]]
            }
        }, 8000);
        log("Mensaje enviado: msg_id=" + sentMsg.message_id + " requestId=" + requestId);
    } catch(e) {
        log("Error enviando mensaje: " + e.message);
        process.exit(0); // fallback: Claude muestra prompt local
    }

    const msgId = sentMsg.message_id;

    // 3. Polling esperando la decisión del usuario
    const decision = await pollForDecision(requestId, msgId, offset);
    const latencyMs = Date.now() - startTime;

    if (!decision) {
        // Timeout: editar mensaje para indicarlo y dejar que Claude muestre UI local
        log("Timeout sin respuesta. Latencia: " + latencyMs + "ms");
        saveOffset(offset); // persistir el offset aunque no hubo respuesta
        try {
            await telegramPost("editMessageText", {
                chat_id: CHAT_ID,
                message_id: msgId,
                text: msgText + "\n\n⏱ <i>Sin respuesta — se muestra el prompt local</i>",
                parse_mode: "HTML"
            }, ANSWER_TIMEOUT);
        } catch(e) { log("Error editando mensaje timeout: " + e.message); }
        process.exit(0); // fallback al prompt local
    }

    // 4. Responder al callback (quitar spinner del botón en Telegram)
    const confirmText = { allow: "✅ Permitido", always: "✅ Permitido siempre", deny: "❌ Denegado" }[decision.action] || "OK";
    try {
        await telegramPost("answerCallbackQuery", {
            callback_query_id: decision.callbackQueryId,
            text: confirmText,
            show_alert: false
        }, ANSWER_TIMEOUT);
    } catch(e) { log("Error en answerCallbackQuery: " + e.message); }

    // 5. Editar mensaje: quitar botones, mostrar decisión tomada
    const emojiDecision = { allow: "✅", always: "✅✅", deny: "❌" }[decision.action] || "•";
    try {
        await telegramPost("editMessageText", {
            chat_id: CHAT_ID,
            message_id: msgId,
            text: msgText + "\n\n" + emojiDecision + " <b>" + confirmText + "</b>"
                + " <i>(" + latencyMs + "ms)</i>",
            parse_mode: "HTML"
        }, ANSWER_TIMEOUT);
    } catch(e) { log("Error editando mensaje con decisión: " + e.message); }

    log("Decisión: " + decision.action + " en " + latencyMs + "ms");

    // 6. Si es "siempre": persistir en settings.local.json
    if (decision.action === "always") {
        persistAlways(toolName, toolInput);
    }

    // 7. Escribir decisión a stdout para Claude Code
    //    Formato requerido: hookSpecificOutput.decision.behavior
    const isAllow = (decision.action === "allow" || decision.action === "always");
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
}
