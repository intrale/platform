// Hook PreToolUse[Edit|Write|Bash]: bloquea ediciones de código fuera de un worktree dedicado
// Complemento:
//   - Edit/Write: BLOQUEA ediciones de código (.kt, .gradle, etc) fuera del worktree
//   - Bash: ALERTA sobre comandos git en ramas protegidas (main/develop) sin bloquear
// Garantiza que toda implementación se realice en un worktree (platform.agent-<issue>-<slug>)
// Fail-open: ante cualquier error interno, permite la operación sin bloquear
// Issue #1170 + #1175
const fs = require("fs");
const path = require("path");
const https = require("https");
const { execSync } = require("child_process");

const REPO_ROOT = process.env.CLAUDE_PROJECT_DIR || "C:\\Workspaces\\Intrale\\platform";
const HOOKS_DIR = path.join(REPO_ROOT, ".claude", "hooks");
const LOG_FILE = path.join(HOOKS_DIR, "hook-debug.log");

// Ramas protegidas: alertar en Bash, bloquear en Edit/Write
const PROTECTED_BRANCHES = ["main", "develop", "master"];

// Ramas seguras: nunca generar ruido
const SAFE_BRANCH_PREFIXES = ["agent/", "feature/", "bugfix/", "docs/", "refactor/", "codex/"];

function log(msg) {
    try {
        const ts = new Date().toISOString();
        fs.appendFileSync(LOG_FILE, `[${ts}] WorktreeGuard: ${msg}\n`);
    } catch (_) { /* ignore logging errors */ }
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
                    log("Telegram alert sent: " + d.substring(0, 100));
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

// Deduplicación: no alertar más de 1 vez cada 60s por rama
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

const MAX_READ = 8192;
let input = "";
let done = false;

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
    if (done) return;
    input += chunk;
    if (input.length >= MAX_READ) { done = true; process.stdin.destroy(); handleInput().catch(() => {}); }
});
process.stdin.on("end", () => { if (!done) { done = true; handleInput().catch(() => {}); } });
process.stdin.on("error", () => { if (!done) { done = true; handleInput().catch(() => {}); } });
setTimeout(() => { if (!done) { done = true; try { process.stdin.destroy(); } catch (_) {} handleInput().catch(() => {}); } }, 3000);

async function handleInput() {
    try {
        const data = JSON.parse(input || "{}");
        const toolName = data.tool_name || "";
        const toolInput = data.tool_input || {};

        // ─── CASO 1: Edit/Write — BLOQUEAR edición de código fuera del worktree ───────────────

        if (toolName === "Edit" || toolName === "Write") {
            const filePath = toolInput.file_path || "";
            const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
            const dirName = path.basename(projectDir);
            const isWorktree = dirName.includes("platform.agent-");

            log(`${toolName} file=${filePath} isWorktree=${isWorktree}`);

            // Si estamos en un worktree, permitir todo
            if (isWorktree) {
                log("allow: en worktree");
                process.exit(0);
                return;
            }

            // Verificar excepciones: archivos que siempre se pueden editar desde main
            if (filePath) {
                const normalized = filePath.replace(/\\/g, "/");

                // Excepciones: .claude/, .pipeline/, docs/, scripts/, CLAUDE.md
                if (normalized.includes("/.claude/") || normalized.includes("\\.claude\\") ||
                    normalized.includes("/.pipeline/") || normalized.includes("\\.pipeline\\") ||
                    normalized.includes("/docs/") || normalized.includes("\\docs\\") ||
                    normalized.includes("/scripts/") || normalized.includes("\\scripts\\") ||
                    path.basename(normalized) === "CLAUDE.md") {
                    log(`allow: excepción → ${filePath}`);
                    process.exit(0);
                    return;
                }
            }

            // BLOQUEAR: edición de código fuera de worktree
            log(`BLOCK: ${toolName} de código fuera del worktree → ${filePath}`);
            const msg = JSON.stringify({
                decision: "block",
                reason: "BLOQUEADO: intentás editar código fuera de un worktree dedicado.\n\nPara crear un worktree:\n  dev <issue> <slug>       (desde terminal bash)\n  /branch <issue> [slug]   (desde Claude Code)\n\nConvención: platform.agent-<issue>-<slug>"
            });
            process.stdout.write(msg);
            process.exit(0);
            return;
        }

        // ─── CASO 2: Bash — ALERTAR sobre git commands en ramas protegidas ─────────────────

        if (toolName === "Bash") {
            const command = toolInput.command || "";

            // Solo interceptar comandos que comienzan con "git"
            if (!command.trim().match(/^git\s+/)) {
                process.exit(0);
                return;
            }

            // Obtener rama actual
            const branch = getCurrentBranch();
            log(`git command en rama: ${branch} → ${command.substring(0, 100)}`);

            // Ramas seguras: no alertar
            if (branch && SAFE_BRANCH_PREFIXES.some(prefix => branch.startsWith(prefix))) {
                log(`rama segura: ${branch}, permitiendo`);
                process.exit(0);
                return;
            }

            // Ramas protegidas: alertar
            if (branch && PROTECTED_BRANCHES.includes(branch)) {
                if (!shouldAlert(branch)) {
                    // Ya alertamos recientemente
                    process.exit(0);
                    return;
                }

                log(`ALERTA: git command en rama protegida '${branch}'`);

                // Enviar alerta a Telegram en background
                const tgConfig = loadTelegramConfig();
                if (tgConfig) {
                    const agent = process.env.CLAUDE_AGENT_NAME || "Claude Code";
                    const text = "\u26a0\ufe0f <b>Worktree Guard</b>\n"
                        + "\ud83e\udd16 " + agent + "\n"
                        + "\ud83d\udd00 Rama: <code>" + branch + "</code>\n"
                        + "\ud83d\udee0 Tool: Bash\n"
                        + "Comando: <code>" + command.substring(0, 100).replace(/[<>&]/g, "") + "</code>\n"
                        + "\n\u26a0\ufe0f Operación git en rama protegida. "
                        + "Considerar usar worktree aislado (<code>/branch</code>).";

                    sendTelegramAlert(text, tgConfig);
                    markAlerted(branch);
                }

                // NO bloquear — solo alertar (fail-open)
                process.exit(0);
                return;
            }

            // Rama desconocida o sin rama: permitir
            process.exit(0);
            return;
        }

        // Otros tools: permitir
        process.exit(0);
    } catch (e) {
        // Fail-open: ante cualquier error, permitir
        log(`error (fail-open): ${e.message}`);
        process.exit(0);
    }
}
