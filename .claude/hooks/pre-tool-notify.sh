#!/bin/bash
# PreToolUse hook: notifica a Telegram cuando un tool use va a pedir permiso
# Cubre TODOS los tools — filtra auto-aprobados para no spammear
# FIX v2: node lee stdin directo (sin cat pipe), con timeout de seguridad

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || echo '.')"
LOG_FILE="$REPO_ROOT/.claude/hooks/hook-debug.log"

node -e '
const https = require("https");
const querystring = require("querystring");
const fs = require("fs");
const path = require("path");

const BOT_TOKEN = "8403197784:AAG07242gOCKwZ-G-DI8eLC6R1HwfhG6Exk";
const CHAT_ID = "6529617704";
const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 1000;
const LOG_FILE = process.argv[1] || "hook-debug.log";
const REPO_ROOT = process.argv[2] || ".";

function log(msg) {
    try { fs.appendFileSync(LOG_FILE, "[" + new Date().toISOString() + "] PreToolUse: " + msg + "\n"); } catch(e) {}
}

// Tools que NUNCA piden permiso (read-only, siempre auto-aprobados)
const ALWAYS_SAFE_TOOLS = [
    "Read", "Glob", "Grep", "TodoRead", "TaskList", "TaskGet",
    "AskUserQuestion", "EnterPlanMode", "ExitPlanMode",
    "TaskCreate", "TaskUpdate",
];

// Bash: comandos safe que Claude Code auto-aprueba
const SAFE_BASH_PREFIXES = [
    "git status", "git diff", "git log", "git branch", "git rev-parse",
    "git show", "git remote", "git fetch", "git tag", "git config",
    "git ls-", "git describe", "git shortlog", "git blame",
    "ls", "dir", "pwd", "whoami", "hostname", "uname", "date",
    "cat ", "head ", "tail ", "wc ", "sort ", "uniq ", "file ",
    "which ", "type ", "where ", "env", "set ",
    "node -e", "node -p", "npm list", "npm ls", "npm view", "npm info",
    "npx ",
];

function isSafeBashCommand(command) {
    const cmd = command.trim();
    for (const prefix of SAFE_BASH_PREFIXES) {
        if (cmd === prefix.trim() || cmd.startsWith(prefix)) return true;
    }
    return false;
}

function loadAllowPatterns() {
    const patterns = [];
    const files = [
        path.join(REPO_ROOT, ".claude", "settings.json"),
        path.join(REPO_ROOT, ".claude", "settings.local.json"),
    ];
    const home = process.env.HOME || process.env.USERPROFILE || "";
    if (home) files.push(path.join(home, ".claude", "settings.json"));
    for (const f of files) {
        try {
            const data = JSON.parse(fs.readFileSync(f, "utf8"));
            const allow = (data.permissions && data.permissions.allow) || [];
            patterns.push(...allow);
        } catch(e) {}
    }
    return patterns;
}

function isAllowed(toolName, toolInput, patterns) {
    for (const p of patterns) {
        if (p === toolName) return true;
        const m = p.match(/^(\w+)\((.+?):\*\)$/);
        if (m && m[1] === toolName) {
            let prefix = m[2];
            if (prefix.startsWith("\"") && prefix.endsWith("\"")) prefix = prefix.slice(1, -1);
            if (toolName === "Bash") {
                const cmd = (toolInput.command || "").trim();
                if (cmd.startsWith(prefix)) return true;
            }
            if (toolName === "Skill") {
                const skill = toolInput.skill || "";
                if (skill === prefix || skill.startsWith(prefix)) return true;
            }
        }
        const mExact = p.match(/^(\w+)\((.+?)\)$/);
        if (mExact && mExact[1] === toolName && !p.includes(":*")) {
            const exact = mExact[2];
            if (toolName === "Bash" && (toolInput.command || "").trim() === exact) return true;
            if (toolName === "Skill" && (toolInput.skill || "") === exact) return true;
        }
    }
    return false;
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
                } catch(e) { reject(e); }
            });
        });
        req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
        req.on("error", (e) => { log("Net error intento " + attempt + ": " + e.message); reject(e); });
        req.write(postData);
        req.end();
    });
}

function getDetail(toolName, toolInput) {
    switch (toolName) {
        case "Bash": {
            const cmd = toolInput.command || "";
            return cmd.length > 150 ? cmd.substring(0, 150) + "..." : cmd;
        }
        case "Edit": case "Write":
            return toolInput.file_path || toolInput.filePath || "";
        case "Task":
            return (toolInput.description || "") + " (" + (toolInput.subagent_type || "?") + ")";
        case "Skill":
            return toolInput.skill || "";
        case "WebFetch":
            return toolInput.url || "";
        case "WebSearch":
            return toolInput.query || "";
        default:
            return JSON.stringify(toolInput).substring(0, 120);
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
    let data;
    try { data = JSON.parse(rawInput); } catch(e) { return; }

    const toolName = data.tool_name || "";
    if (!toolName) return;

    // Skip tools que siempre son auto-aprobados
    if (ALWAYS_SAFE_TOOLS.includes(toolName)) return;

    const toolInput = data.tool_input || {};

    // Para Bash, skip comandos safe
    if (toolName === "Bash" && isSafeBashCommand(toolInput.command || "")) return;

    // Verificar allow list
    const patterns = loadAllowPatterns();
    if (isAllowed(toolName, toolInput, patterns)) return;

    // No auto-aprobado → notificar
    const detail = getDetail(toolName, toolInput);
    log("Tool no permitido: " + toolName + " — " + detail.substring(0, 120));

    const escapedDetail = detail.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
    const text = "\u26a0\ufe0f <b>[Claude Code] Permiso inminente</b>\n"
        + "<b>Tool:</b> " + toolName + "\n"
        + "<b>Detalle:</b> <code>" + escapedDetail + "</code>\n\n"
        + "Revis\u00e1 la terminal para aprobar o rechazar.";

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            await sendTelegram(text, attempt);
            return;
        } catch(e) {
            if (attempt < MAX_RETRIES) {
                await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
            } else {
                log("FALLO despues de " + MAX_RETRIES + " intentos");
            }
        }
    }
}
' "$LOG_FILE" "$REPO_ROOT"

exit 0
