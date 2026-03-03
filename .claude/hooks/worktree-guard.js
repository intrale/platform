// Hook PreToolUse[Edit,Write,Bash]: alerta cuando se modifica código en main/develop
// Complementa branch-guard.js (que bloquea git push) — este ALERTA sobre escritura directa
// Fail-open: ante cualquier error interno, permite la operación sin bloquear
// Issue #1170
const { execSync } = require("child_process");
const https = require("https");
const fs = require("fs");
const path = require("path");

const REPO_ROOT = process.env.CLAUDE_PROJECT_DIR || "C:\\Workspaces\\Intrale\\platform";
const HOOKS_DIR = path.join(REPO_ROOT, ".claude", "hooks");
const LOG_FILE = path.join(HOOKS_DIR, "hook-debug.log");

// Ramas protegidas: alertar si se trabaja directamente en ellas
const PROTECTED_BRANCHES = ["main", "develop", "master"];

// Ramas seguras: nunca generar ruido
const SAFE_BRANCH_PREFIXES = ["agent/", "feature/", "bugfix/", "docs/", "refactor/", "codex/"];

// Archivos que siempre se pueden editar sin alerta (config, hooks, etc.)
const ALWAYS_ALLOWED_PATHS = [
    ".claude/",
    ".github/",
    "CLAUDE.md",
    "docs/"
];

function log(msg) {
    try {
        fs.appendFileSync(LOG_FILE, "[" + new Date().toISOString() + "] worktree-guard: " + msg + "\n");
    } catch (e) { /* ignore */ }
}

function getCurrentBranch() {
    try {
        return execSync("git branch --show-current", {
            encoding: "utf8",
            timeout: 3000,
            cwd: REPO_ROOT,
            stdio: ["pipe", "pipe", "pipe"]
        }).trim();
    } catch (e) {
        return null;
    }
}

function isProtectedBranch(branch) {
    if (!branch) return false;
    return PROTECTED_BRANCHES.includes(branch);
}

function isSafeBranch(branch) {
    if (!branch) return false;
    return SAFE_BRANCH_PREFIXES.some(prefix => branch.startsWith(prefix));
}

function isAlwaysAllowedPath(filePath) {
    if (!filePath) return false;
    const normalized = filePath.replace(/\\/g, "/");
    return ALWAYS_ALLOWED_PATHS.some(allowed => normalized.includes(allowed));
}

function isGitCommand(command) {
    if (!command) return false;
    const trimmed = command.trim();
    return /^git\s+/.test(trimmed);
}

function loadTelegramConfig() {
    try {
        const cfgPath = path.join(HOOKS_DIR, "telegram-config.json");
        return JSON.parse(fs.readFileSync(cfgPath, "utf8"));
    } catch (e) {
        return null;
    }
}

function sendTelegramAlert(text, config) {
    return new Promise((resolve) => {
        try {
            const postData = JSON.stringify({
                chat_id: config.chat_id,
                text: text,
                parse_mode: "HTML",
                disable_web_page_preview: true
            });
            const req = https.request({
                hostname: "api.telegram.org",
                path: "/bot" + config.bot_token + "/sendMessage",
                method: "POST",
                headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(postData) },
                timeout: 5000
            }, (res) => {
                let d = "";
                res.on("data", (c) => d += c);
                res.on("end", () => {
                    log("Telegram response: " + d.substring(0, 200));
                    resolve(true);
                });
            });
            req.on("timeout", () => { req.destroy(); resolve(false); });
            req.on("error", () => resolve(false));
            req.write(postData);
            req.end();
        } catch (e) {
            resolve(false);
        }
    });
}

// Deduplicación: no alertar más de 1 vez cada 60s por la misma rama
const DEDUP_FILE = path.join(HOOKS_DIR, "worktree-guard-last-alert.json");
const DEDUP_INTERVAL_MS = 60000;

function shouldAlert(branch) {
    try {
        if (fs.existsSync(DEDUP_FILE)) {
            const data = JSON.parse(fs.readFileSync(DEDUP_FILE, "utf8"));
            if (data.branch === branch) {
                const age = Date.now() - (data.timestamp || 0);
                if (age < DEDUP_INTERVAL_MS) {
                    log("Dedup: alerta para '" + branch + "' enviada hace " + Math.round(age / 1000) + "s, omitiendo");
                    return false;
                }
            }
        }
    } catch (e) { /* ignore */ }
    return true;
}

function markAlerted(branch) {
    try {
        fs.writeFileSync(DEDUP_FILE, JSON.stringify({ branch, timestamp: Date.now() }), "utf8");
    } catch (e) { /* ignore */ }
}

// ─── Stdin handling (patrón estándar del proyecto) ──────────────────────────

const MAX_READ = 8192;
let input = "";
let done = false;

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
    if (done) return;
    input += chunk;
    if (input.length >= MAX_READ) { done = true; process.stdin.destroy(); handleInput(); }
});
process.stdin.on("end", () => { if (!done) { done = true; handleInput(); } });
process.stdin.on("error", () => { if (!done) { done = true; handleInput(); } });
setTimeout(() => { if (!done) { done = true; try { process.stdin.destroy(); } catch (e) {} handleInput(); } }, 3000);

async function handleInput() {
    try {
        const data = JSON.parse(input || "{}");
        const toolName = data.tool_name || "";
        const toolInput = data.tool_input || {};

        // Determinar rama actual
        const branch = getCurrentBranch();

        // Ramas seguras: salir inmediatamente sin ruido
        if (!branch || isSafeBranch(branch)) {
            process.exit(0);
            return;
        }

        // Solo alertar en ramas protegidas
        if (!isProtectedBranch(branch)) {
            process.exit(0);
            return;
        }

        // Para Edit/Write: verificar si el archivo es siempre permitido
        if (toolName === "Edit" || toolName === "Write") {
            const filePath = toolInput.file_path || "";
            if (isAlwaysAllowedPath(filePath)) {
                log("Permitido sin alerta: " + filePath + " (always-allowed path)");
                process.exit(0);
                return;
            }
        }

        // Para Bash: solo alertar en comandos git (no en cualquier bash)
        if (toolName === "Bash") {
            const command = toolInput.command || "";
            if (!isGitCommand(command)) {
                process.exit(0);
                return;
            }
            log("Comando git en rama protegida '" + branch + "': " + command.substring(0, 100));
        }

        // Llegamos aquí: operación de escritura en rama protegida
        log("ALERTA: " + toolName + " en rama protegida '" + branch + "'");

        // Deduplicación
        if (!shouldAlert(branch)) {
            process.exit(0);
            return;
        }

        // Contexto del archivo/comando
        let context = "";
        if (toolName === "Edit" || toolName === "Write") {
            const fp = toolInput.file_path || "desconocido";
            context = "Archivo: <code>" + fp.replace(/[<>&]/g, "") + "</code>";
        } else if (toolName === "Bash") {
            const cmd = (toolInput.command || "").substring(0, 120);
            context = "Comando: <code>" + cmd.replace(/[<>&]/g, "") + "</code>";
        }

        // Enviar alerta a Telegram (no bloquear)
        const tgConfig = loadTelegramConfig();
        if (tgConfig) {
            const agent = process.env.CLAUDE_AGENT_NAME || "Claude Code";
            const text = "\u26a0\ufe0f <b>Worktree Guard</b>\n"
                + "\ud83e\udd16 " + agent + "\n"
                + "\ud83d\udd00 Rama: <code>" + branch + "</code>\n"
                + "\ud83d\udee0 Tool: <code>" + toolName + "</code>\n"
                + (context ? context + "\n" : "")
                + "\n\u26a0\ufe0f Modificaci\u00f3n directa en rama protegida. "
                + "Considerar usar worktree aislado (<code>/branch</code>).";

            await sendTelegramAlert(text, tgConfig);
            markAlerted(branch);
        }

        // NUNCA bloquear — solo alertar (fail-open)
        process.exit(0);
    } catch (e) {
        // Fail-open: ante cualquier error, permitir la operación
        log("Error (fail-open): " + (e.message || e));
        process.exit(0);
    }
}
