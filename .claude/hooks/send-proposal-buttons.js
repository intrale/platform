// send-proposal-buttons.js — Envía botones inline de Telegram para propuestas del Planner
// Lee planner-proposals.json y envía un mensaje con botones ✅ Crear / ❌ Descartar por propuesta
// + botón "✅ Crear todas" al final.
// No hace polling — solo envía. El polling lo maneja telegram-commander.js.
//
// Uso: node send-proposal-buttons.js

const https = require("https");
const fs = require("fs");
const path = require("path");

// ─── Config ──────────────────────────────────────────────────────────────────

const HOOKS_DIR = __dirname;
const CONFIG_FILE = path.join(HOOKS_DIR, "telegram-config.json");
const PROPOSALS_FILE = path.join(HOOKS_DIR, "planner-proposals.json");
const LOG_FILE = path.join(HOOKS_DIR, "hook-debug.log");

let _tgCfg;
try {
    _tgCfg = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
} catch (e) {
    console.error("Error leyendo telegram-config.json:", e.message);
    process.exit(1);
}
const BOT_TOKEN = _tgCfg.bot_token;
const CHAT_ID = _tgCfg.chat_id;

// ─── Logging ─────────────────────────────────────────────────────────────────

function log(msg) {
    const line = "[" + new Date().toISOString() + "] ProposalButtons: " + msg;
    try { fs.appendFileSync(LOG_FILE, line + "\n"); } catch (e) {}
    console.log(line);
}

// ─── HTTP helper ─────────────────────────────────────────────────────────────

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
                } catch (e) { reject(e); }
            });
        });
        req.on("timeout", () => { req.destroy(); reject(new Error("timeout " + method)); });
        req.on("error", (e) => reject(e));
        req.write(postData);
        req.end();
    });
}

function escHtml(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ─── Effort/Stream labels ────────────────────────────────────────────────────

const EFFORT_LABELS = { S: "S (1d)", M: "M (2-3d)", L: "L (1sem)", XL: "XL (2+sem)" };
const STREAM_LABELS = { A: "Backend/Infra", B: "App Cliente", C: "App Negocio", D: "App Delivery", E: "Cross-cutting" };

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
    // Leer propuestas
    if (!fs.existsSync(PROPOSALS_FILE)) {
        log("No existe planner-proposals.json — saliendo sin error");
        process.exit(0);
    }

    let data;
    try {
        data = JSON.parse(fs.readFileSync(PROPOSALS_FILE, "utf8"));
    } catch (e) {
        log("Error parseando planner-proposals.json: " + e.message);
        process.exit(0);
    }

    if (!data.proposals || data.proposals.length === 0) {
        log("Sin propuestas en planner-proposals.json — saliendo sin error");
        process.exit(0);
    }

    const proposals = data.proposals.filter(p => p.status === "pending");
    if (proposals.length === 0) {
        log("Todas las propuestas ya fueron procesadas — saliendo");
        process.exit(0);
    }

    // Construir mensaje
    let text = "📋 <b>Propuestas del Planner</b>\n";
    text += "<i>Generado: " + escHtml(data.generated_at || "?") + "</i>\n\n";

    for (const p of proposals) {
        const effort = EFFORT_LABELS[p.effort] || p.effort;
        const stream = STREAM_LABELS[p.stream] || ("Stream " + p.stream);
        const labels = (p.labels || []).join(", ");
        const deps = (p.dependencies || []).length > 0
            ? p.dependencies.map(d => "#" + d).join(", ")
            : "ninguna";

        text += "<b>" + (p.index + 1) + ". " + escHtml(p.title) + "</b>\n";
        text += "   📏 " + escHtml(effort) + " · 🔀 " + escHtml(stream) + "\n";
        text += "   🏷 " + escHtml(labels) + "\n";
        text += "   🔗 Deps: " + escHtml(deps) + "\n";
        text += "   💡 " + escHtml(p.justification || "") + "\n\n";
    }

    // Construir botones inline (2 por fila: Crear / Descartar)
    // callback_data máximo 64 bytes — usamos índice numérico
    const keyboard = [];
    for (const p of proposals) {
        keyboard.push([
            { text: "✅ " + (p.index + 1) + ". Crear", callback_data: "create_proposal:" + p.index },
            { text: "❌ " + (p.index + 1) + ". Descartar", callback_data: "discard_proposal:" + p.index }
        ]);
    }
    // Botón "Crear todas" al final
    keyboard.push([
        { text: "✅ Crear todas las propuestas", callback_data: "create_all_proposals" }
    ]);

    // Enviar mensaje con botones
    try {
        const sent = await telegramPost("sendMessage", {
            chat_id: CHAT_ID,
            text: text,
            parse_mode: "HTML",
            reply_markup: { inline_keyboard: keyboard }
        }, 10000);

        // Guardar message_id en el JSON para que telegram-commander pueda editarlo
        data.telegram_message_id = sent.message_id;
        fs.writeFileSync(PROPOSALS_FILE, JSON.stringify(data, null, 2), "utf8");

        log("Mensaje enviado: msg_id=" + sent.message_id + " con " + proposals.length + " propuestas");
    } catch (e) {
        log("Error enviando mensaje de propuestas: " + e.message);
        process.exit(1);
    }
}

main().catch((e) => {
    log("Error fatal: " + e.message);
    process.exit(1);
});
