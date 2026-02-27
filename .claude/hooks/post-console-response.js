// post-console-response.js — Hook PostToolUse
// Detecta preguntas Telegram pendientes que fueron respondidas localmente en consola
// y actualiza el mensaje de Telegram para reflejar el estado "Respondido en consola".
//
// Lógica:
//   - Lee pending-questions.json buscando preguntas con status:"pending" y telegram_message_id
//   - Verifica si el timestamp de la pregunta es anterior al arranque de Claude Code
//     (indicando que el hook permission-approver.js ya no está en polling)
//   - Para cada una, llama editMessageText en Telegram con "Respondido en consola" y sin botones
//   - Marca la pregunta como resolveQuestion(id, "answered", "console")
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

// Tiempo máximo desde que se creó la pregunta para considerarla "activa en polling"
// Si PERMISSION_TIMEOUT_MIN está configurado, usarlo; de lo contrario usar 60 min
const APPROVER_TIMEOUT_MIN = _tgCfg.permission_timeout_min || 60;
const APPROVER_TIMEOUT_MS = APPROVER_TIMEOUT_MIN * 60 * 1000;

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

function resolveAsConsole(data, q) {
    q.status = "answered";
    q.answered_at = new Date().toISOString();
    q.answered_via = "console";
    saveQuestions(data);
}

async function processStaleQuestion(data, q) {
    const msgId = q.telegram_message_id;
    if (!msgId) {
        log("Pregunta " + q.id + " sin telegram_message_id — marcando como consola sin editar");
        resolveAsConsole(data, q);
        return;
    }

    // Preparar texto del mensaje original (máx 200 chars)
    const originalMsg = (q.message || "").substring(0, 200);
    const newText = "⌨️ <b>Respondido en consola</b>\n\n"
        + "<code>" + originalMsg.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;") + "</code>\n\n"
        + "<i>El usuario respondió directamente en la consola de Claude Code.</i>";

    try {
        await telegramPost("editMessageText", {
            chat_id: CHAT_ID,
            message_id: msgId,
            text: newText,
            parse_mode: "HTML"
            // Sin reply_markup: elimina los botones inline
        }, 8000);
        log("Mensaje " + msgId + " editado: respondido en consola (pregunta " + q.id + ")");
    } catch (e) {
        const errMsg = e.message || "";
        // "message is not modified" es OK — el mensaje ya tenía ese texto
        if (errMsg.includes("message is not modified")) {
            log("Mensaje " + msgId + " sin cambios (ya tenía el texto correcto)");
        } else {
            log("Error editando mensaje " + msgId + ": " + errMsg);
        }
    }

    resolveAsConsole(data, q);
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

    log("Activado (input: " + rawInput.substring(0, 100) + ")");

    const data = loadQuestions();
    if (!data.questions || data.questions.length === 0) {
        log("Sin preguntas registradas — saliendo");
        process.exit(0);
        return;
    }

    const now = Date.now();

    // Buscar preguntas pending cuyo tiempo de polling ya expiró
    // (es decir, permission-approver.js ya no debería estar en polling)
    const stale = data.questions.filter(q => {
        if (q.status !== "pending") return false;
        if (!q.telegram_message_id) return false;
        const age = now - new Date(q.timestamp).getTime();
        // Si la pregunta tiene más tiempo que el timeout del approver, ya no está siendo polleada
        return age > APPROVER_TIMEOUT_MS;
    });

    if (stale.length === 0) {
        log("Sin preguntas pendientes expiradas — saliendo");
        process.exit(0);
        return;
    }

    log("Encontradas " + stale.length + " pregunta(s) pendientes expiradas — actualizando Telegram");

    for (const q of stale) {
        try {
            await processStaleQuestion(data, q);
        } catch (e) {
            log("Error procesando pregunta " + q.id + ": " + e.message);
        }
    }

    log("Procesamiento completado");
    process.exit(0);
}

main().catch((e) => {
    log("Error fatal: " + e.message);
    process.exit(0); // Salir sin error para no bloquear Claude Code
});
