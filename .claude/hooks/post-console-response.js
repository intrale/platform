// post-console-response.js — Hook PostToolUse (Stop)
// Detecta preguntas Telegram pendientes que fueron respondidas localmente en consola
// y actualiza el mensaje de Telegram para reflejar el estado.
//
// Casos que maneja:
//   1. Preguntas "pending" con más de 60s de antigüedad → el approver ya murió
//      (el hook tiene timeout de 55s). Marca como "answered via console" y edita Telegram.
//   2. Preguntas "answered" via "console" sin sincronizar → actualiza Telegram.
//      (para edge cases donde el approver marcó la pregunta pero no pudo editar Telegram)
//
// Pure Node.js — sin dependencias externas

const https = require("https");
const fs = require("fs");
const path = require("path");

const HOOKS_DIR = path.resolve(__dirname);
const MAIN_REPO_HOOKS_DIR = (function() {
    // Resolver el directorio hooks del repo principal desde un worktree
    // __dirname puede ser: .../platform/.claude/hooks (principal)
    //                   o: .../platform/.claude/worktrees/<id>/.claude/hooks (worktree)
    const candidate = path.resolve(HOOKS_DIR, "..", "..", "..", "..", ".claude", "hooks");
    if (fs.existsSync(candidate)) return candidate;
    return HOOKS_DIR;
})();

const PENDING_FILE = path.join(MAIN_REPO_HOOKS_DIR, "pending-questions.json");
const LOG_FILE = path.join(MAIN_REPO_HOOKS_DIR, "hook-debug.log");

const _tgCfg = JSON.parse(fs.readFileSync(path.join(MAIN_REPO_HOOKS_DIR, "telegram-config.json"), "utf8"));
const BOT_TOKEN = _tgCfg.bot_token;
const CHAT_ID = _tgCfg.chat_id;

// El approver tiene timeout de 600s internamente (615s de hook timeout en settings.json)
// Si una pregunta tiene más de 660s y sigue "pending", el approver está muerto
const APPROVER_DEAD_THRESHOLD_MS = 660000; // 11 minutos

function log(msg) {
    try { fs.appendFileSync(LOG_FILE, "[" + new Date().toISOString() + "] PostConsole: " + msg + "\n"); } catch (e) {}
}

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

function loadQuestions() {
    try {
        return JSON.parse(fs.readFileSync(PENDING_FILE, "utf8"));
    } catch (e) {
        return { questions: [] };
    }
}

function saveQuestions(data) {
    try {
        fs.writeFileSync(PENDING_FILE, JSON.stringify(data, null, 2), "utf8");
    } catch (e) { log("Error guardando pending-questions.json: " + e.message); }
}

function escHtml(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Editar mensaje de Telegram para indicar que fue respondido en consola.
 * Elimina los botones inline.
 */
async function syncToTelegram(q) {
    const msgId = q.telegram_message_id;
    if (!msgId) return;

    const originalMsg = (q.message || "").substring(0, 200);
    const newText = "⌨️ <b>Respondido en consola</b>\n\n"
        + "<code>" + escHtml(originalMsg) + "</code>\n\n"
        + "<i>El usuario respondió directamente en la consola de Claude Code.</i>";

    try {
        await telegramPost("editMessageText", {
            chat_id: CHAT_ID,
            message_id: msgId,
            text: newText,
            parse_mode: "HTML",
            reply_markup: { inline_keyboard: [] }
        }, 8000);
        log("Mensaje " + msgId + " sincronizado: respondido en consola (pregunta " + q.id + ")");
    } catch (e) {
        const errMsg = e.message || "";
        if (errMsg.includes("message is not modified")) {
            log("Mensaje " + msgId + " sin cambios (ya actualizado)");
        } else {
            log("Error editando mensaje " + msgId + ": " + errMsg);
        }
    }
}

async function main() {
    // Leer stdin para consumirlo (requerido para hooks PostToolUse)
    let rawInput = "";
    process.stdin.setEncoding("utf8");
    await new Promise((resolve) => {
        const timeout = setTimeout(resolve, 2000);
        process.stdin.on("data", (c) => { rawInput += c; });
        process.stdin.on("end", () => { clearTimeout(timeout); resolve(); });
        process.stdin.on("error", () => { clearTimeout(timeout); resolve(); });
    });

    // Caso 0: Matar approver activo si existe (el usuario respondió en consola)
    const APPROVER_PID_FILE = path.join(MAIN_REPO_HOOKS_DIR, "approver-active.pid");
    try {
        if (fs.existsSync(APPROVER_PID_FILE)) {
            const pidData = JSON.parse(fs.readFileSync(APPROVER_PID_FILE, "utf8"));
            log("Approver activo detectado: PID " + pidData.pid + " requestId=" + pidData.requestId);
            // Matar al approver zombi
            try { process.kill(pidData.pid, "SIGTERM"); } catch (e) {}
            // Limpiar el PID file
            try { fs.unlinkSync(APPROVER_PID_FILE); } catch (e) {}
        }
    } catch (e) {
        log("Error leyendo approver PID file: " + e.message);
    }

    const data = loadQuestions();
    if (!data.questions || data.questions.length === 0) {
        process.exit(0);
        return;
    }

    const now = Date.now();
    let changed = false;

    // Caso 1: Preguntas "pending" cuyo approver ya no está vivo
    // Verificar por PID si disponible, o por antigüedad como fallback
    const orphaned = data.questions.filter(q => {
        if (q.status !== "pending") return false;
        if (q.type !== "permission") return false;
        if (!q.telegram_message_id) return false;
        // Si tiene approver_pid, verificar si el proceso sigue vivo
        if (q.approver_pid) {
            try { process.kill(q.approver_pid, 0); return false; } catch (e) { return true; }
        }
        // Sin PID: verificar si ALGÚN approver está corriendo
        // Si no hay approver-active.pid, el approver ya murió
        try {
            if (fs.existsSync(APPROVER_PID_FILE)) {
                const pidData = JSON.parse(fs.readFileSync(APPROVER_PID_FILE, "utf8"));
                try { process.kill(pidData.pid, 0); return false; } catch (e) { /* pid muerto */ }
            }
        } catch (e) {}
        // No hay approver vivo → es huérfana (con mínimo 5s para evitar race conditions)
        const age = now - new Date(q.timestamp).getTime();
        return age > 5000;
    });

    // Caso 2: Preguntas answered via console pero sin sincronizar a Telegram
    const unsyncedConsole = data.questions.filter(q => {
        if (q.status !== "answered") return false;
        if (q.answered_via !== "console") return false;
        if (q.telegram_synced) return false;
        if (!q.telegram_message_id) return false;
        return true;
    });

    const toProcess = orphaned.length + unsyncedConsole.length;
    if (toProcess === 0) {
        process.exit(0);
        return;
    }

    log("Encontradas " + orphaned.length + " huérfana(s) + " + unsyncedConsole.length + " sin sincronizar");

    // Procesar huérfanas: marcar como respondido en consola + sincronizar Telegram
    for (const q of orphaned) {
        try {
            q.status = "answered";
            q.answered_at = new Date().toISOString();
            q.answered_via = "console";
            q.telegram_synced = true;
            changed = true;
            await syncToTelegram(q);
        } catch (e) {
            log("Error procesando huérfana " + q.id + ": " + e.message);
        }
    }

    // Procesar no sincronizadas: solo actualizar Telegram
    for (const q of unsyncedConsole) {
        try {
            q.telegram_synced = true;
            changed = true;
            await syncToTelegram(q);
        } catch (e) {
            log("Error sincronizando " + q.id + ": " + e.message);
        }
    }

    if (changed) {
        saveQuestions(data);
    }

    process.exit(0);
}

main().catch((e) => {
    log("Error fatal: " + e.message);
    process.exit(0); // Salir sin error para no bloquear Claude Code
});
