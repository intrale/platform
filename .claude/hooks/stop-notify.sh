#!/bin/bash
# Hook Stop: notifica a Telegram cuando Claude termina su respuesta
# Verifica stop_hook_active para evitar loops infinitos

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

        // Evitar loop: si ya estamos en un stop hook, no reenviar
        if (data.stop_hook_active) process.exit(0);

        // Resumen breve del ultimo mensaje (primeros 150 chars)
        let summary = (data.last_assistant_message || "").trim();
        if (summary.length > 150) summary = summary.substring(0, 150) + "...";

        const text = "\u2705 [Claude Code] Listo" + (summary ? " — " + summary : " — esperando tu siguiente instruccion");

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
