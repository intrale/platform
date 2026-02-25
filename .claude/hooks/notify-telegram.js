// Hook Notification: reenvia notificaciones de Claude Code a Telegram
// Pure Node.js — sin dependencia de bash
const https = require("https");
const querystring = require("querystring");
const fs = require("fs");
const path = require("path");

const _tgCfg = JSON.parse(require("fs").readFileSync(require("path").join(__dirname, "telegram-config.json"), "utf8"));
const BOT_TOKEN = _tgCfg.bot_token;
const CHAT_ID = _tgCfg.chat_id;
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1500;

const REPO_ROOT = process.env.CLAUDE_PROJECT_DIR || "C:\\Workspaces\\Intrale\\platform";
const LOG_FILE = path.join(REPO_ROOT, ".claude", "hooks", "hook-debug.log");

function log(msg) {
    try { fs.appendFileSync(LOG_FILE, "[" + new Date().toISOString() + "] Notification: " + msg + "\n"); } catch(e) {}
}

function sendTelegram(text, attempt) {
    return new Promise((resolve, reject) => {
        const postData = querystring.stringify({ chat_id: CHAT_ID, text: text, parse_mode: "HTML" });
        const req = https.request({
            hostname: "api.telegram.org",
            path: "/bot" + BOT_TOKEN + "/sendMessage",
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            timeout: 5000
        }, (res) => {
            let d = "";
            res.on("data", (c) => d += c);
            res.on("end", () => {
                try {
                    const r = JSON.parse(d);
                    if (r.ok) { log("OK intento " + attempt + " msg_id=" + r.result.message_id); resolve(r); }
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

    const emoji = {
        "permission_prompt": "\u26a0\ufe0f",
        "idle_prompt": "\u2705",
        "auth_success": "\ud83d\udd11",
        "elicitation_dialog": "\u2753"
    }[type] || "\ud83d\udd14";

    // Ignorar permission_prompt: ya lo maneja permission-approver.js con botones inline
    if (type === "permission_prompt") {
        log("Ignorado permission_prompt (manejado por permission-approver.js)");
        return;
    }

    const displayTitle = TIPO_TITULO[type] || title || type;

    let displayMessage = message;
    if (type === "permission_prompt" && message === "Claude Code needs your approval for the plan") {
        displayMessage = "Claude Code requiere tu aprobaci\u00f3n para continuar con el plan de trabajo. Revis\u00e1 la terminal para ver el detalle y confirmar o cancelar.";
    }

    const text = emoji + " <b>" + agent + " \u2014 " + displayTitle + "</b>\n" + displayMessage;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            await sendTelegram(text, attempt);
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
