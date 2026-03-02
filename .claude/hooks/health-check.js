// health-check.js — Verificación periódica de infraestructura operativa
// Hook PostToolUse: se ejecuta en cada tool use pero con cooldown interno (10 min)
// Verifica: telegram-commander, approvers huérfanos, bot Telegram, settings, worktrees
// Auto-repara lo que puede, notifica lo que no

const fs = require("fs");
const path = require("path");
const https = require("https");
const { execSync } = require("child_process");

const HOOKS_DIR = __dirname;
const REPO_ROOT = process.env.CLAUDE_PROJECT_DIR || path.resolve(HOOKS_DIR, "..", "..");
const LOG_FILE = path.join(HOOKS_DIR, "hook-debug.log");
const STATE_FILE = path.join(HOOKS_DIR, "health-check-state.json");
const CONFIG_FILE = path.join(HOOKS_DIR, "telegram-config.json");
const COMMANDER_LOCK = path.join(HOOKS_DIR, "telegram-commander.lock");

// Cooldown: solo ejecutar cada 10 minutos
const CHECK_INTERVAL_MS = 10 * 60 * 1000;

function log(msg) {
    try { fs.appendFileSync(LOG_FILE, "[" + new Date().toISOString() + "] HealthCheck: " + msg + "\n"); } catch (e) {}
}

function readState() {
    try { return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); } catch (e) { return {}; }
}

function writeState(state) {
    try { fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf8"); } catch (e) {}
}

function isProcessAlive(pid) {
    try { process.kill(pid, 0); return true; } catch (e) { return false; }
}

// ─── Check 1: telegram-commander vivo ──────────────────────────────────────

function checkCommander() {
    const result = { ok: true, detail: "" };
    try {
        if (!fs.existsSync(COMMANDER_LOCK)) {
            result.ok = false;
            result.detail = "No hay lockfile — commander no activo";
            return result;
        }
        const data = JSON.parse(fs.readFileSync(COMMANDER_LOCK, "utf8"));
        if (!data.pid || !isProcessAlive(data.pid)) {
            result.ok = false;
            result.detail = "PID " + (data.pid || "?") + " muerto — commander caído";
            // Auto-fix: limpiar lockfile para que commander-launcher.js lo relance
            try { fs.unlinkSync(COMMANDER_LOCK); } catch (e) {}
            result.detail += " (lockfile limpiado, se relanzará automáticamente)";
            return result;
        }
        result.detail = "PID " + data.pid + " activo";
    } catch (e) {
        result.ok = false;
        result.detail = "Error leyendo lockfile: " + e.message;
    }
    return result;
}

// ─── Check 2: permission-approver huérfanos ────────────────────────────────

function checkOrphanedApprovers() {
    const result = { ok: true, detail: "", fixed: 0 };
    try {
        // Contar procesos permission-approver.js
        const output = execSync('tasklist /FI "IMAGENAME eq node.exe" /FO CSV /NH 2>NUL', {
            encoding: "utf8", timeout: 5000, windowsHide: true
        });

        // Obtener PIDs de todos los node.exe
        const wmicOutput = execSync(
            'wmic process where "name=\'node.exe\' and commandline like \'%permission-approver%\'" get ProcessId /FORMAT:LIST 2>NUL',
            { encoding: "utf8", timeout: 5000, windowsHide: true }
        );

        const pids = [];
        wmicOutput.split("\n").forEach(line => {
            const m = line.trim().match(/^ProcessId=(\d+)$/);
            if (m) pids.push(parseInt(m[1]));
        });

        // Máximo 2 approvers simultáneos es normal (sesión principal puede tener 1-2)
        // Más de 3 indica huérfanos
        const MAX_HEALTHY = 3;
        if (pids.length > MAX_HEALTHY) {
            result.ok = false;
            const orphanCount = pids.length - 1; // quedarnos con al menos 1
            result.detail = pids.length + " approvers activos (máximo saludable: " + MAX_HEALTHY + ")";

            // Auto-fix: matar los más viejos (PIDs más bajos = más viejos)
            const toKill = pids.sort((a, b) => a - b).slice(0, pids.length - 1);
            for (const pid of toKill) {
                try {
                    execSync("taskkill /PID " + pid + " /F 2>NUL", {
                        timeout: 3000, windowsHide: true
                    });
                    result.fixed++;
                } catch (e) {}
            }
            result.detail += " → " + result.fixed + " eliminados";
        } else {
            result.detail = pids.length + " approver(s) activo(s)";
        }
    } catch (e) {
        // No es crítico si falla el check
        result.detail = "No se pudo verificar: " + e.message;
    }
    return result;
}

// ─── Check 3: Bot Telegram responde ────────────────────────────────────────

function checkTelegramBot() {
    return new Promise((resolve) => {
        try {
            const config = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
            const url = "/bot" + config.bot_token + "/getMe";
            const req = https.get({
                hostname: "api.telegram.org", path: url, timeout: 5000
            }, (res) => {
                let d = "";
                res.on("data", c => d += c);
                res.on("end", () => {
                    try {
                        const r = JSON.parse(d);
                        resolve({ ok: r.ok === true, detail: r.ok ? "Bot responde (@" + r.result.username + ")" : "Bot error: " + d });
                    } catch (e) {
                        resolve({ ok: false, detail: "Respuesta inválida" });
                    }
                });
            });
            req.on("timeout", () => { req.destroy(); resolve({ ok: false, detail: "Timeout 5s" }); });
            req.on("error", e => resolve({ ok: false, detail: "Error: " + e.message }));
        } catch (e) {
            resolve({ ok: false, detail: "Config no legible: " + e.message });
        }
    });
}

// ─── Check 4: Settings intactos ────────────────────────────────────────────

function checkSettings() {
    const result = { ok: true, details: [] };
    const files = [
        path.join(REPO_ROOT, ".claude", "settings.json"),
        path.join(REPO_ROOT, ".claude", "settings.local.json"),
        CONFIG_FILE
    ];
    for (const f of files) {
        const name = path.basename(f);
        try {
            const content = fs.readFileSync(f, "utf8");
            JSON.parse(content);
        } catch (e) {
            result.ok = false;
            result.details.push(name + ": " + (e.code === "ENOENT" ? "FALTA" : "JSON inválido"));
        }
    }
    if (result.ok) result.details.push("Todos los settings válidos");
    return result;
}

// ─── Check 5: Hooks críticos presentes ─────────────────────────────────────

function checkCriticalHooks() {
    const result = { ok: true, missing: [] };
    const critical = [
        "permission-approver.js", "notify-telegram.js", "stop-notify.js",
        "branch-guard.js", "activity-logger.js", "commander-launcher.js",
        "telegram-commander.js", "permission-tracker.js", "permission-utils.js",
        "telegram-config.json"
    ];
    for (const f of critical) {
        if (!fs.existsSync(path.join(HOOKS_DIR, f))) {
            result.ok = false;
            result.missing.push(f);
        }
    }
    return result;
}

// ─── Check 6: Worktrees muertos ───────────────────────────────────────────

function checkDeadWorktrees() {
    const result = { ok: true, dead: [] };
    try {
        const parentDir = path.resolve(REPO_ROOT, "..");
        const entries = fs.readdirSync(parentDir);
        const repoName = path.basename(REPO_ROOT);
        for (const entry of entries) {
            if (entry.startsWith(repoName + ".agent-")) {
                const fullPath = path.join(parentDir, entry);
                try {
                    const stat = fs.statSync(fullPath);
                    if (stat.isDirectory()) {
                        // Verificar si tiene contenido real (más de solo . y ..)
                        const contents = fs.readdirSync(fullPath);
                        if (contents.length <= 1) {
                            result.dead.push(entry);
                        }
                    }
                } catch (e) {}
            }
        }
        if (result.dead.length > 0) result.ok = false;
    } catch (e) {}
    return result;
}

// ─── Notificación a Telegram ───────────────────────────────────────────────

function sendAlert(text) {
    return new Promise((resolve) => {
        try {
            const config = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
            const postData = JSON.stringify({
                chat_id: config.chat_id, text: text, parse_mode: "HTML"
            });
            const req = https.request({
                hostname: "api.telegram.org",
                path: "/bot" + config.bot_token + "/sendMessage",
                method: "POST",
                headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(postData) },
                timeout: 8000
            }, (res) => {
                let d = "";
                res.on("data", c => d += c);
                res.on("end", () => resolve(true));
            });
            req.on("error", () => resolve(false));
            req.on("timeout", () => { req.destroy(); resolve(false); });
            req.write(postData);
            req.end();
        } catch (e) { resolve(false); }
    });
}

// ─── Main ──────────────────────────────────────────────────────────────────

async function main() {
    // Cooldown: no ejecutar si se verificó recientemente
    const state = readState();
    const now = Date.now();
    if (state.last_check && (now - state.last_check) < CHECK_INTERVAL_MS) {
        return; // Todavía no es momento de verificar
    }

    log("Iniciando verificación periódica...");

    const checks = {};
    checks.commander = checkCommander();
    checks.approvers = checkOrphanedApprovers();
    checks.telegram = await checkTelegramBot();
    checks.settings = checkSettings();
    checks.hooks = checkCriticalHooks();
    checks.worktrees = checkDeadWorktrees();

    // Evaluar resultados
    const issues = [];
    if (!checks.commander.ok) issues.push("🔴 Commander: " + checks.commander.detail);
    if (!checks.approvers.ok) issues.push("🟡 Approvers: " + checks.approvers.detail);
    if (!checks.telegram.ok) issues.push("🔴 Telegram Bot: " + checks.telegram.detail);
    if (!checks.settings.ok) issues.push("🔴 Settings: " + checks.settings.details.join(", "));
    if (!checks.hooks.ok) issues.push("🔴 Hooks faltantes: " + checks.hooks.missing.join(", "));
    if (!checks.worktrees.ok) issues.push("🟡 Worktrees muertos: " + checks.worktrees.dead.length);

    // Actualizar estado
    const newState = {
        last_check: now,
        last_check_iso: new Date(now).toISOString(),
        all_ok: issues.length === 0,
        issues_found: issues.length,
        checks: {
            commander: checks.commander.ok,
            approvers: checks.approvers.ok,
            telegram: checks.telegram.ok,
            settings: checks.settings.ok,
            hooks: checks.hooks.ok,
            worktrees: checks.worktrees.ok
        }
    };
    writeState(newState);

    if (issues.length > 0) {
        // Enviar alerta a Telegram
        let msg = "🏥 <b>Health Check — Problemas detectados</b>\n\n";
        msg += issues.map(i => "• " + i).join("\n");
        msg += "\n\n<i>Auto-reparaciones aplicadas donde fue posible.</i>";
        msg += "\n<i>Próximo check en " + Math.round(CHECK_INTERVAL_MS / 60000) + " min.</i>";

        await sendAlert(msg);
        log("ALERTA: " + issues.length + " problema(s) detectado(s) → notificado");
    } else {
        log("OK: todos los checks pasaron");
    }
}

main().catch(e => log("Error en health-check: " + e.message));
