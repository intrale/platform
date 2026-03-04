// ask-next-sprint.js — Confirmacion via Telegram para siguiente sprint
// P-03: Usa pending-questions.json + fs.watch (NO getUpdates directo)
// El Commander procesa callbacks de Telegram y escribe en PQ — este script solo observa PQ.
// Salida stdout: { "confirmed": true/false }
//
// Uso: node ask-next-sprint.js
//   stdout → {"confirmed":true}   si el usuario acepta
//   stdout → {"confirmed":false}  si el usuario rechaza o timeout

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const REPO_ROOT = "C:\\Workspaces\\Intrale\\platform";
const HOOKS_DIR = path.join(REPO_ROOT, ".claude", "hooks");
const LOG_FILE = path.join(HOOKS_DIR, "hook-debug.log");
const PQ_FILE = path.join(HOOKS_DIR, "pending-questions.json");
const TOTAL_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutos antes de timeout
const POLL_INTERVAL_MS = 1000;           // Fallback polling cada 1s (fs.watch es primary)

// P-09: Usar telegram-client.js compartido
let tgClient;
try { tgClient = require(path.join(HOOKS_DIR, "telegram-client")); } catch (e) { tgClient = null; }

const { addPendingQuestion, resolveQuestion, getQuestionById } = require(path.join(HOOKS_DIR, "pending-questions"));

function log(msg) {
    try { fs.appendFileSync(LOG_FILE, "[" + new Date().toISOString() + "] NextSprint: " + msg + "\n"); } catch(e) {}
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// --- Esperar respuesta via pending-questions.json (fs.watch + fallback polling) ---

async function waitForAnswer(requestId, durationMs) {
    const start = Date.now();
    let fileChanged = true; // check inmediato al inicio
    let watcher = null;

    try {
        watcher = fs.watch(PQ_FILE, { persistent: false }, () => { fileChanged = true; });
        watcher.on("error", () => { watcher = null; });
    } catch (e) {
        log("fs.watch no disponible: " + e.message);
    }

    try {
        while (Date.now() - start < durationMs) {
            if (fileChanged) {
                fileChanged = false;
                try {
                    const q = getQuestionById(requestId);
                    if (!q) { log("Pregunta desapareció"); return null; }
                    if (q.status === "cancelled") return q;
                    if (q.status !== "pending") {
                        log("Pregunta " + requestId + " cambió a: " + q.status + " action=" + (q.action_result || "?"));
                        return q;
                    }
                } catch (e) {
                    log("Error leyendo PQ: " + e.message);
                }
            }
            await sleep(POLL_INTERVAL_MS);
            // Si no hay watcher, forzar re-check
            if (!watcher) fileChanged = true;
        }
    } finally {
        if (watcher) { try { watcher.close(); } catch (e) {} }
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
        const planPath = path.join(__dirname, "sprint-plan.json");
        if (fs.existsSync(planPath)) {
            const plan = JSON.parse(fs.readFileSync(planPath, "utf8"));
            const count = plan.agentes ? plan.agentes.length : "?";
            planInfo = "\n\n\uD83D\uDCCB Sprint " + (plan.fecha || "?") + " \u2014 " + count + " agente(s)";
        }
    } catch(e) {}

    const msgText = "\u2705 <b>Sprint completado</b>\n\n"
        + "Todos los agentes finalizaron y los worktrees estan limpios."
        + planInfo + "\n\n"
        + "\u00BFPlanificar el siguiente sprint y proponer nuevas historias ahora?";

    // 1. Enviar mensaje con inline buttons via telegram-client.js
    let sentMsg;
    try {
        if (!tgClient) throw new Error("telegram-client.js no disponible");
        sentMsg = await tgClient.telegramPost("sendMessage", {
            chat_id: tgClient.getChatId(),
            text: msgText,
            parse_mode: "HTML",
            reply_markup: {
                inline_keyboard: [[
                    { text: "\uD83D\uDE80 Si, planificar + proponer", callback_data: "yes:" + requestId },
                    { text: "\u23F9 No, terminar",                    callback_data: "no:" + requestId }
                ]]
            }
        }, 8000);
        log("Mensaje enviado msg_id=" + sentMsg.message_id + " requestId=" + requestId);
    } catch(e) {
        log("Error enviando mensaje: " + e.message);
        process.stdout.write(JSON.stringify({ confirmed: false, error: "send" }) + "\n");
        process.exit(0);
    }

    // 2. Registrar pregunta pendiente — el Commander procesará el callback
    addPendingQuestion({
        id: requestId,
        type: "sprint",
        message: "¿Planificar siguiente sprint?",
        telegram_message_id: sentMsg.message_id,
        options: [
            { label: "Si, planificar", action: "yes" },
            { label: "No, terminar", action: "no" }
        ],
        action_data: { command: "/planner sprint" }
    });

    // 3. Esperar respuesta via PQ (fs.watch + fallback polling) — NO getUpdates
    const answer = await waitForAnswer(requestId, TOTAL_TIMEOUT_MS);
    const latencyMs = Date.now() - startTime;

    if (!answer || answer.status === "pending") {
        // Timeout
        log("Timeout sin respuesta. Latencia: " + latencyMs + "ms");
        resolveQuestion(requestId, "expired");
        try {
            await tgClient.editMessage(sentMsg.message_id,
                msgText + "\n\n\u23F1 <i>Sin respuesta \u2014 ciclo finalizado</i>",
                { replyMarkup: { inline_keyboard: [] } });
        } catch(e) { log("Error editando mensaje timeout: " + e.message); }
        process.stdout.write(JSON.stringify({ confirmed: false, timeout: true }) + "\n");
        process.exit(0);
    }

    // 4. Interpretar respuesta
    const isYes = answer.action_result === "yes" || answer.action_result === "allow";
    const confirmText = isYes
        ? "\uD83D\uDE80 Planificando sprint + generando propuestas..."
        : "\u23F9 Ciclo finalizado";
    const emoji = isYes ? "\uD83D\uDE80" : "\u23F9";

    // 5. Editar mensaje: quitar botones, mostrar decision
    try {
        await tgClient.editMessage(sentMsg.message_id,
            msgText + "\n\n" + emoji + " <b>" + confirmText + "</b>"
                + " <i>(" + latencyMs + "ms)</i>",
            { replyMarkup: { inline_keyboard: [] } });
    } catch(e) { log("Error editando mensaje: " + e.message); }

    log("Resultado: " + (isYes ? "confirmed" : "rejected") + " en " + latencyMs + "ms");
    if (answer.status !== "answered") resolveQuestion(requestId, "answered");
    process.stdout.write(JSON.stringify({ confirmed: isYes }) + "\n");
    process.exit(0);
}

main().catch((e) => {
    log("Error fatal: " + e.message);
    process.stdout.write(JSON.stringify({ confirmed: false, error: e.message }) + "\n");
    process.exit(0);
});
