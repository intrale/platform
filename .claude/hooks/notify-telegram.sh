#!/bin/bash
# Hook: reenvia notificaciones de Claude Code a Telegram
# Evento: Notification (permission_prompt, idle_prompt, auth_success, elicitation_dialog)

BOT_TOKEN="8403197784:AAG07242gOCKwZ-G-DI8eLC6R1HwfhG6Exk"
CHAT_ID="6529617704"

cat | node -e '
const https = require("https");
const querystring = require("querystring");

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => { input += c; });
process.stdin.on("end", () => {
    try {
        const data = JSON.parse(input);
        const message = data.message || "";
        const title = data.title || "";
        const type = data.notification_type || "notification";

        // Emoji segun tipo
        const emoji = {
            "permission_prompt": "\u26a0\ufe0f",
            "idle_prompt": "\u2705",
            "auth_success": "\ud83d\udd11",
            "elicitation_dialog": "\u2753"
        }[type] || "\ud83d\udd14";

        const text = emoji + " [Claude Code] " + (title || type) + ": " + message;

        const postData = querystring.stringify({
            chat_id: process.argv[1],
            text: text
        });

        const req = https.request({
            hostname: "api.telegram.org",
            path: "/bot" + process.argv[2] + "/sendMessage",
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" }
        });
        req.on("error", () => {});
        req.write(postData);
        req.end();
    } catch(e) {}
});
' "$CHAT_ID" "$BOT_TOKEN" 2>/dev/null

exit 0
