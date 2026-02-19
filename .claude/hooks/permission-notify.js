// Hook PermissionRequest: notifica a Telegram cuando Claude pide permisos
// Formato terminal: muestra la acción exacta y opciones como en consola
// Pure Node.js — sin dependencia de bash
const https = require("https");
const querystring = require("querystring");
const fs = require("fs");
const path = require("path");

const BOT_TOKEN = "8403197784:AAG07242gOCKwZ-G-DI8eLC6R1HwfhG6Exk";
const CHAT_ID = "6529617704";
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1500;

const REPO_ROOT = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const LOG_FILE = path.join(REPO_ROOT, ".claude", "hooks", "hook-debug.log");

function log(msg) {
    try { fs.appendFileSync(LOG_FILE, "[" + new Date().toISOString() + "] PermissionRequest: " + msg + "\n"); } catch(e) {}
}

function getAgentName() {
    return process.env.CLAUDE_AGENT_NAME || "Claude Code";
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

function escHtml(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function formatTerminalAction(toolName, toolInput) {
    switch (toolName) {
        case "Bash": {
            const cmd = toolInput.command || "";
            const display = cmd.length > 200 ? cmd.substring(0, 200) + "..." : cmd;
            return "$ " + escHtml(display);
        }
        case "Edit": {
            const fp = toolInput.file_path || toolInput.filePath || "";
            const oldStr = toolInput.old_string || "";
            const preview = oldStr.length > 80 ? oldStr.substring(0, 80) + "..." : oldStr;
            return "Edit " + escHtml(fp) + (preview ? "\n" + escHtml(preview) : "");
        }
        case "Write": {
            const fp = toolInput.file_path || toolInput.filePath || "";
            return "Write " + escHtml(fp);
        }
        case "Task": {
            const desc = toolInput.description || "";
            const agent = toolInput.subagent_type || "?";
            return "Task [" + agent + "] " + escHtml(desc);
        }
        case "Skill": {
            const skill = toolInput.skill || "";
            const args = toolInput.args || "";
            return "/" + escHtml(skill) + (args ? " " + escHtml(args) : "");
        }
        case "WebFetch":
            return "fetch " + escHtml(toolInput.url || "");
        case "WebSearch":
            return "search " + escHtml(toolInput.query || "");
        case "NotebookEdit":
            return "NotebookEdit " + escHtml(toolInput.notebook_path || "");
        default: {
            const raw = JSON.stringify(toolInput);
            return escHtml(toolName) + " " + escHtml(raw.length > 120 ? raw.substring(0, 120) + "..." : raw);
        }
    }
}

// Leer stdin con limite y timeout de seguridad
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
setTimeout(() => { if (!done) { done = true; try { process.stdin.destroy(); } catch(e) {} processInput(); } }, 3000);

async function processInput() {
    log("INPUT: " + rawInput.substring(0, 300));

    let data;
    try { data = JSON.parse(rawInput); } catch(e) {
        log("JSON parse failed, raw: " + rawInput.substring(0, 200));
        data = {};
    }

    const toolName = data.tool_name || data.toolName || "desconocido";
    const toolInput = data.tool_input || data.toolInput || {};
    const agent = getAgentName();
    const action = formatTerminalAction(toolName, toolInput);

    const text = "\u26a0\ufe0f <b>" + agent + " — Permiso requerido</b>\n\n"
        + "<code>" + action + "</code>\n\n"
        + "  y) Permitir una vez\n"
        + "  a) Permitir siempre\n"
        + "  n) Denegar";

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
