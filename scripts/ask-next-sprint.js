// ask-next-sprint.js — Confirmacion via Telegram para siguiente sprint
// Envia mensaje con botones inline (Si/No) y espera respuesta via polling.
// Salida stdout: { "confirmed": true/false }
// Sigue patron de permission-approver.js
//
// Uso: node ask-next-sprint.js
//   stdout → {"confirmed":true}   si el usuario acepta
//   stdout → {"confirmed":false}  si el usuario rechaza o timeout

const https = require("https");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const BOT_TOKEN = "8403197784:AAG07242gOCKwZ-G-DI8eLC6R1HwfhG6Exk";
const CHAT_ID = "6529617704";
const POLL_TIMEOUT_SEC = 20;   // Telegram long-poll: esperar hasta 20s por update
const MAX_POLL_CYCLES = 15;    // 15 ciclos × 20s = ~5 minutos antes de timeout
const ANSWER_TIMEOUT = 5000;   // Timeout para answerCallbackQuery y editMessage

const REPO_ROOT = "C:\\Workspaces\\Intrale\\platform";
const LOG_FILE = path.join(REPO_ROOT, ".claude", "hooks", "hook-debug.log");
const OFFSET_FILE = path.join(REPO_ROOT, ".claude", "hooks", "tg-approver-offset.json");

function log(msg) {
    try { fs.appendFileSync(LOG_FILE, "[" + new Date().toISOString() + "] NextSprint: " + msg + "\n"); } catch(e) {}
}

// --- Helpers HTTP (misma API que permission-approver.js) ---

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

// --- Offset persistente (compartido con permission-approver.js) ---

function loadOffset() {
    try {
        const data = JSON.parse(fs.readFileSync(OFFSET_FILE, "utf8"));
        return data.offset || 0;
    } catch(e) { return 0; }
}

function saveOffset(offset) {
    try { fs.writeFileSync(OFFSET_FILE, JSON.stringify({ offset }), "utf8"); } catch(e) {}
}

async function getCurrentOffset() {
    const saved = loadOffset();
    try {
        const updates = await telegramPost("getUpdates", {
            limit: 1,
            timeout: 0,
            allowed_updates: ["callback_query"]
        }, 5000);
        if (updates && updates.length > 0) {
            const fresh = updates[updates.length - 1].update_id + 1;
            return Math.max(saved, fresh);
        }
        return saved;
    } catch(e) {
        log("getCurrentOffset error: " + e.message);
        return saved;
    }
}

// --- Polling para nuestra solicitud ---

async function pollForDecision(requestId, msgId, offset) {
    let currentOffset = offset;

    for (let cycle = 0; cycle < MAX_POLL_CYCLES; cycle++) {
        log("Poll ciclo " + (cycle + 1) + "/" + MAX_POLL_CYCLES + " offset=" + currentOffset);

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

            // Seguridad: solo aceptar del chat correcto
            if (String(cq.message && cq.message.chat && cq.message.chat.id) !== String(CHAT_ID)) {
                log("Callback de chat desconocido: " + JSON.stringify(cq.message && cq.message.chat));
                continue;
            }

            // Verificar que el callback es para NUESTRO mensaje
            if (cq.message && cq.message.message_id !== msgId) {
                log("Callback de otro mensaje: " + cq.message.message_id + " (esperaba " + msgId + ")");
                continue;
            }

            // Extraer accion y requestId del callback_data
            const parts = cq.data.split(":");
            if (parts.length < 2) continue;
            const action = parts[0];
            const cbRequestId = parts.slice(1).join(":");

            if (cbRequestId !== requestId) {
                log("Callback de otra solicitud: " + cbRequestId + " (esperaba " + requestId + ")");
                continue;
            }

            log("Decision recibida: " + action + " en ciclo " + cycle);
            saveOffset(currentOffset);
            return { action, callbackQueryId: cq.id, messageId: cq.message.message_id };
        }
    }

    return null; // timeout
}

// --- Main ---

async function main() {
    const requestId = crypto.randomBytes(8).toString("hex");
    const startTime = Date.now();
    log("Iniciando consulta next-sprint requestId=" + requestId);

    // Leer info del plan para contexto en el mensaje
    let planInfo = "";
    try {
        const planPath = path.join(path.dirname(process.argv[1] || __filename), "sprint-plan.json");
        if (fs.existsSync(planPath)) {
            const plan = JSON.parse(fs.readFileSync(planPath, "utf8"));
            const count = plan.agentes ? plan.agentes.length : "?";
            planInfo = "\n\n\uD83D\uDCCB Sprint " + (plan.fecha || "?") + " \u2014 " + count + " agente(s)";
        }
    } catch(e) {}

    const msgText = "\u2705 <b>Sprint completado</b>\n\n"
        + "Todos los agentes finalizaron y los worktrees estan limpios."
        + planInfo + "\n\n"
        + "\u00BFPlanificar el siguiente sprint ahora?";

    // 1. Obtener offset actual ANTES de enviar el mensaje
    let offset;
    try {
        offset = await getCurrentOffset();
        log("Offset inicial: " + offset);
    } catch(e) {
        log("Error obteniendo offset: " + e.message);
        process.stdout.write(JSON.stringify({ confirmed: false, error: "offset" }) + "\n");
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
                    { text: "\uD83D\uDE80 Si, planificar", callback_data: "yes:" + requestId },
                    { text: "\u23F9 No, terminar",         callback_data: "no:" + requestId }
                ]]
            }
        }, 8000);
        log("Mensaje enviado msg_id=" + sentMsg.message_id + " requestId=" + requestId);
    } catch(e) {
        log("Error enviando mensaje: " + e.message);
        process.stdout.write(JSON.stringify({ confirmed: false, error: "send" }) + "\n");
        process.exit(0);
    }

    const msgId = sentMsg.message_id;

    // 3. Polling esperando la decision del usuario
    const decision = await pollForDecision(requestId, msgId, offset);
    const latencyMs = Date.now() - startTime;

    if (!decision) {
        // Timeout: editar mensaje y salir
        log("Timeout sin respuesta. Latencia: " + latencyMs + "ms");
        saveOffset(offset);
        try {
            await telegramPost("editMessageText", {
                chat_id: CHAT_ID,
                message_id: msgId,
                text: msgText + "\n\n\u23F1 <i>Sin respuesta \u2014 ciclo finalizado</i>",
                parse_mode: "HTML"
            }, ANSWER_TIMEOUT);
        } catch(e) { log("Error editando mensaje timeout: " + e.message); }
        process.stdout.write(JSON.stringify({ confirmed: false, timeout: true }) + "\n");
        process.exit(0);
    }

    // 4. Responder al callback (quitar spinner del boton en Telegram)
    const isYes = decision.action === "yes";
    const confirmText = isYes ? "\uD83D\uDE80 Planificando siguiente sprint..." : "\u23F9 Ciclo finalizado";
    try {
        await telegramPost("answerCallbackQuery", {
            callback_query_id: decision.callbackQueryId,
            text: confirmText,
            show_alert: false
        }, ANSWER_TIMEOUT);
    } catch(e) { log("Error en answerCallbackQuery: " + e.message); }

    // 5. Editar mensaje: quitar botones, mostrar decision tomada
    const emoji = isYes ? "\uD83D\uDE80" : "\u23F9";
    try {
        await telegramPost("editMessageText", {
            chat_id: CHAT_ID,
            message_id: msgId,
            text: msgText + "\n\n" + emoji + " <b>" + confirmText + "</b>"
                + " <i>(" + latencyMs + "ms)</i>",
            parse_mode: "HTML"
        }, ANSWER_TIMEOUT);
    } catch(e) { log("Error editando mensaje con decision: " + e.message); }

    log("Resultado: " + (isYes ? "confirmed" : "rejected") + " en " + latencyMs + "ms");
    process.stdout.write(JSON.stringify({ confirmed: isYes }) + "\n");
    process.exit(0);
}

main().catch((e) => {
    log("Error fatal: " + e.message);
    process.stdout.write(JSON.stringify({ confirmed: false, error: e.message }) + "\n");
    process.exit(0);
});
