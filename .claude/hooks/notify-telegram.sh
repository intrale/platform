#!/bin/bash
# Hook Notification: reenvia notificaciones de Claude Code a Telegram
# FIX v2: node lee stdin directo (sin cat pipe), con timeout de seguridad

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || echo '.')"
LOG_FILE="$REPO_ROOT/.claude/hooks/hook-debug.log"

node -e '
const https = require("https");
const querystring = require("querystring");
const fs = require("fs");

const BOT_TOKEN = "8403197784:AAG07242gOCKwZ-G-DI8eLC6R1HwfhG6Exk";
const CHAT_ID = "6529617704";
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1500;
const LOG_FILE = process.argv[1] || "hook-debug.log";

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

    const emoji = {
        "permission_prompt": "\u26a0\ufe0f",
        "idle_prompt": "\u2705",
        "auth_success": "\ud83d\udd11",
        "elicitation_dialog": "\u2753"
    }[type] || "\ud83d\udd14";

    const text = emoji + " <b>[Claude Code] " + (title || type) + "</b>\n" + message;

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
' "$LOG_FILE"

exit 0
