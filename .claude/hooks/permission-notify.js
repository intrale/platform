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

function getContextDescription(toolName, toolInput) {
    switch (toolName) {
        case "Bash": {
            const cmd = (toolInput.command || "").trim();
            if (cmd.startsWith("git push")) return "Claude quiere subir los commits locales al repositorio remoto para poder abrir el Pull Request.";
            if (cmd.startsWith("git commit")) return "Claude quiere crear un commit con los cambios realizados hasta ahora.";
            if (cmd.startsWith("git checkout") || cmd.startsWith("git switch")) return "Claude quiere cambiar de rama en el repositorio.";
            if (cmd.startsWith("git merge")) return "Claude quiere integrar cambios de otra rama.";
            if (cmd.startsWith("git rebase")) return "Claude quiere reorganizar los commits de la rama actual.";
            if (cmd.startsWith("git stash")) return "Claude quiere guardar temporalmente los cambios en curso.";
            if (cmd.startsWith("git reset")) return "Claude quiere deshacer cambios en el historial de git.";
            if (cmd.startsWith("gh pr create") || cmd.startsWith("gh pr edit")) return "Claude quiere crear un Pull Request en GitHub con los cambios de esta rama.";
            if (cmd.startsWith("gh pr merge") || cmd.startsWith("gh pr close")) return "Claude quiere modificar el estado de un Pull Request en GitHub.";
            if (cmd.startsWith("gh issue")) return "Claude quiere interactuar con un issue en GitHub.";
            if (cmd.startsWith("gh ")) return "Claude quiere ejecutar una operación en GitHub mediante el CLI.";
            if (cmd.startsWith("./gradlew") || cmd.startsWith("gradle")) return "Claude quiere ejecutar una tarea de Gradle para compilar o verificar el proyecto.";
            if (cmd.startsWith("npm ") || cmd.startsWith("npx ")) return "Claude quiere ejecutar un comando de Node.js/npm.";
            if (cmd.startsWith("docker")) return "Claude quiere ejecutar un comando de Docker.";
            if (cmd.startsWith("rm ") || cmd.startsWith("del ")) return "Claude quiere eliminar archivos del sistema.";
            if (cmd.startsWith("mkdir")) return "Claude quiere crear un directorio nuevo.";
            if (cmd.startsWith("curl") || cmd.startsWith("wget")) return "Claude quiere hacer una solicitud HTTP externa.";
            return "Claude quiere ejecutar un comando en la terminal.";
        }
        case "Edit":
            return "Claude necesita modificar este archivo como parte de la implementación en curso.";
        case "Write":
            return "Claude va a crear un archivo nuevo como parte de la implementación solicitada.";
        case "Task": {
            const agent = (toolInput.subagent_type || "").toLowerCase();
            if (agent === "explore") return "Claude quiere lanzar un sub-agente para explorar el codebase en profundidad.";
            if (agent === "bash") return "Claude quiere lanzar un sub-agente para ejecutar comandos en la terminal.";
            if (agent === "plan") return "Claude quiere lanzar un sub-agente para planificar la implementación.";
            return "Claude quiere lanzar un sub-agente para realizar una tarea especializada.";
        }
        case "Skill": {
            const skill = (toolInput.skill || "").toLowerCase();
            if (skill === "mensajero") return "Claude quiere invocar el agente El Mensajero para hacer commit, push y abrir el PR.";
            if (skill === "inquisidor") return "Claude quiere invocar el agente El Inquisidor para ejecutar tests y verificar calidad.";
            if (skill === "sabueso") return "Claude quiere invocar el agente El Sabueso para investigar documentación técnica.";
            if (skill === "pluma") return "Claude quiere invocar el agente La Pluma para gestionar el backlog.";
            if (skill === "refinar") return "Claude quiere invocar el agente de refinamiento para mejorar un issue.";
            if (skill === "triaje") return "Claude quiere invocar el agente de triaje para categorizar issues.";
            return "Claude quiere invocar una skill especializada.";
        }
        case "WebFetch":
            return "Claude necesita consultar documentación externa para continuar con la tarea.";
        case "WebSearch":
            return "Claude necesita buscar información en la web para resolver la tarea.";
        case "NotebookEdit":
            return "Claude necesita modificar un notebook Jupyter.";
        default:
            return "Claude necesita permiso para ejecutar esta acción.";
    }
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
    const description = getContextDescription(toolName, toolInput);

    const text = "\u26a0\ufe0f <b>" + agent + " \u2014 Permiso requerido</b>\n\n"
        + "<code>" + action + "</code>\n\n"
        + description + "\n\n"
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
