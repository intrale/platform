#!/usr/bin/env node
// reset-operations.js — Hard reset completo de operaciones
// Mata TODOS los procesos, limpia TODO el estado, pull de main, reinicia infraestructura
// Pure Node.js — sin dependencias externas
//
// Uso: node scripts/reset-operations.js [--notify] [--json] [--skip-pull]
//   --notify     Enviar reporte a Telegram
//   --json       Salida solo JSON (para integración programática)
//   --skip-pull  No hacer git pull (útil si ya se actualizó)

const fs = require("fs");
const path = require("path");
const https = require("https");
const { execSync, spawn } = require("child_process");

// ─── Paths ──────────────────────────────────────────────────────────────────

const SCRIPT_DIR = __dirname;
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");
const HOOKS_DIR = path.join(REPO_ROOT, ".claude", "hooks");
const CONFIG_FILE = path.join(HOOKS_DIR, "telegram-config.json");

// ─── Args ───────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const FLAG_NOTIFY = args.includes("--notify");
const FLAG_JSON = args.includes("--json");
const FLAG_SKIP_PULL = args.includes("--skip-pull");

// ─── Helpers ────────────────────────────────────────────────────────────────

const isWindows = process.platform === "win32";

function log(msg) {
    if (!FLAG_JSON) console.log("[reset] " + msg);
}

function execSafe(cmd, timeoutMs = 15000) {
    try {
        return execSync(cmd, {
            timeout: timeoutMs, encoding: "utf8",
            stdio: ["pipe", "pipe", "pipe"],
            cwd: REPO_ROOT,
            windowsHide: true,
        }).trim();
    } catch (e) {
        if (e.stdout) return e.stdout.toString().trim();
        return null;
    }
}

function loadConfig() {
    try { return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")); }
    catch { return null; }
}

function telegramSend(text) {
    const config = loadConfig();
    if (!config || !config.bot_token || !config.chat_id) return Promise.resolve(false);
    return new Promise((resolve) => {
        const postData = JSON.stringify({ chat_id: config.chat_id, text, parse_mode: "HTML" });
        const req = https.request({
            hostname: "api.telegram.org",
            path: "/bot" + config.bot_token + "/sendMessage",
            method: "POST",
            headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(postData) },
            timeout: 10000,
        }, (res) => {
            let d = "";
            res.on("data", (c) => d += c);
            res.on("end", () => resolve(true));
        });
        req.on("timeout", () => { req.destroy(); resolve(false); });
        req.on("error", () => resolve(false));
        req.write(postData);
        req.end();
    });
}

function forceKill(pid) {
    if (isWindows) {
        try { execSync("taskkill /PID " + pid + " /F", { timeout: 5000, stdio: "ignore", windowsHide: true }); } catch (_) {}
    } else {
        try { process.kill(pid, "SIGKILL"); } catch (_) {}
    }
}

// ─── Step 1: Kill ALL processes ─────────────────────────────────────────────

function killAllProcesses() {
    const killed = [];

    // 1a. Matar agentes claude (buscar por PID files)
    try {
        const pidFiles = fs.readdirSync(HOOKS_DIR).filter(f => f.startsWith("agent-") && f.endsWith(".pid"));
        for (const pf of pidFiles) {
            try {
                const pid = parseInt(fs.readFileSync(path.join(HOOKS_DIR, pf), "utf8").trim(), 10);
                if (pid && !isNaN(pid)) {
                    try {
                        forceKill(pid);
                        killed.push({ type: "agent-pid", file: pf, pid });
                    } catch (_) {} // proceso ya muerto
                }
                fs.unlinkSync(path.join(HOOKS_DIR, pf));
            } catch (_) {}
        }
    } catch (_) {}

    // 1b. Matar telegram-commander (via lockfile)
    try {
        const lockFile = path.join(HOOKS_DIR, "telegram-commander.lock");
        if (fs.existsSync(lockFile)) {
            const content = fs.readFileSync(lockFile, "utf8").trim();
            let pid;
            try { pid = JSON.parse(content).pid; } catch { pid = parseInt(content, 10); }
            if (pid && !isNaN(pid)) {
                try { forceKill(pid); killed.push({ type: "commander", pid }); } catch (_) {}
            }
            fs.unlinkSync(lockFile);
        }
    } catch (_) {}

    // 1c. Matar dashboard server (via pid file)
    try {
        const dashPid = path.join(HOOKS_DIR, "dashboard-server.pid");
        if (fs.existsSync(dashPid)) {
            const pid = parseInt(fs.readFileSync(dashPid, "utf8").trim(), 10);
            if (pid && !isNaN(pid)) {
                try { forceKill(pid); killed.push({ type: "dashboard", pid }); } catch (_) {}
            }
            fs.unlinkSync(dashPid);
        }
    } catch (_) {}

    // 1d. Matar procesos claude huérfanos (Windows: taskkill por nombre)
    if (isWindows) {
        try {
            // Buscar procesos claude.exe que no seamos nosotros
            const myPid = process.pid;
            const tasklist = execSafe('tasklist /FI "IMAGENAME eq claude.exe" /FO CSV /NH', 10000);
            if (tasklist) {
                const lines = tasklist.split("\n").filter(l => l.includes("claude.exe"));
                for (const line of lines) {
                    const match = line.match(/"claude\.exe","(\d+)"/);
                    if (match) {
                        const pid = parseInt(match[1], 10);
                        if (pid !== myPid) {
                            try { forceKill(pid); killed.push({ type: "claude-orphan", pid }); } catch (_) {}
                        }
                    }
                }
            }
        } catch (_) {}
    }

    // 1e. Limpiar lockfiles y conflict files
    const lockFiles = [
        "telegram-commander.lock", "telegram-commander.conflict",
        "ci-monitor.lock", "launcher-launching.flag",
        "circuit-breaker-state.json",
    ];
    for (const lf of lockFiles) {
        try { fs.unlinkSync(path.join(HOOKS_DIR, lf)); killed.push({ type: "lockfile", file: lf }); } catch (_) {}
    }

    return killed;
}

// ─── Step 2: Clean worktrees ────────────────────────────────────────────────

function cleanWorktrees() {
    const cleaned = [];
    try {
        const output = execSafe("git worktree list --porcelain", 10000);
        if (!output) return cleaned;

        const worktrees = [];
        let current = {};
        for (const line of output.split("\n")) {
            if (line.startsWith("worktree ")) {
                if (current.path) worktrees.push(current);
                current = { path: line.substring(9).trim() };
            } else if (line.startsWith("branch ")) {
                current.branch = line.substring(7).trim().replace("refs/heads/", "");
            }
        }
        if (current.path) worktrees.push(current);

        // Solo limpiar worktrees de agentes (no el principal)
        const mainPath = path.resolve(REPO_ROOT).replace(/\\/g, "/");
        for (const wt of worktrees) {
            const wtPath = wt.path.replace(/\\/g, "/");
            if (wtPath === mainPath) continue;
            if (!wt.branch || !wt.branch.startsWith("agent/")) continue;

            try {
                // Desmontar junction .claude/ primero (Windows)
                if (isWindows) {
                    execSafe('cmd /c rmdir "' + wt.path + '\\.claude" 2>NUL', 5000);
                }
                execSafe('git worktree remove "' + wt.path + '" --force', 10000);
                cleaned.push({ path: wt.path, branch: wt.branch });
            } catch (_) {
                cleaned.push({ path: wt.path, branch: wt.branch, error: "no se pudo eliminar" });
            }

            // Eliminar branch local
            try { execSafe('git branch -D "' + wt.branch + '"', 5000); } catch (_) {}
        }
        // Podar referencias huérfanas
        execSafe("git worktree prune", 5000);
    } catch (_) {}
    return cleaned;
}

// ─── Step 2.5: Clean orphan sessions ─────────────────────────────────────────

function cleanOrphanSessions() {
    const cleaned = [];
    const sessDir = path.join(REPO_ROOT, ".claude", "sessions");
    try {
        if (!fs.existsSync(sessDir)) return cleaned;
        const files = fs.readdirSync(sessDir).filter(f => f.endsWith(".json"));
        for (const f of files) {
            try {
                const fp = path.join(sessDir, f);
                const s = JSON.parse(fs.readFileSync(fp, "utf8"));
                // Eliminar sesiones de agentes — son huérfanas si llegamos al reset
                // No solo marcar done (el dashboard las retiene 30min), eliminar directamente
                if (s.branch && s.branch.startsWith("agent/")) {
                    fs.unlinkSync(fp);
                    cleaned.push(f);
                }
            } catch (_) {}
        }
    } catch (_) {}
    return cleaned;
}

// ─── Step 3: Reset state files ──────────────────────────────────────────────

function resetStateFiles() {
    const reset = [];
    const STATE_FILE_DEFAULTS = {
        "pending-questions.json": '{"questions":[]}\n',
        "health-check-history.json": '{"problems":[]}\n',
        "telegram-messages.json": '{"messages":[]}\n',
        "agent-registry.json": '{"agents":{},"updated_at":"' + new Date().toISOString() + '"}\n',
    };
    const FILES = [
        "activity-logger-last.json", "activity-logger-zombie-check.json",
        "health-check-state.json", "health-check-history.json", "health-check-components.json",
        "agent-progress-state.json", "agent-metrics.json", "agent-registry.json",
        "pending-questions.json", "telegram-messages.json",
        "tg-session-store.json", "tg-commander-offset.json",
        "launcher-last-check.json", "launcher-last-head.json",
        "worktree-guard-last-alert.json", "auto-review-state.json",
        "scrum-monitor-state.json", "process-registry.json",
    ];
    for (const f of FILES) {
        try {
            const fp = path.join(HOOKS_DIR, f);
            const defaultContent = STATE_FILE_DEFAULTS[f] || "{}\n";
            fs.writeFileSync(fp, defaultContent, "utf8");
            reset.push(f);
        } catch (_) {}
    }
    return reset;
}

// ─── Step 4: Git pull main ──────────────────────────────────────────────────

function gitPullMain() {
    if (FLAG_SKIP_PULL) return { status: "skipped" };
    try {
        // Asegurar que estamos en main
        const currentBranch = execSafe("git branch --show-current", 5000);
        if (currentBranch !== "main") {
            execSafe("git checkout main", 10000);
        }
        // Fetch + reset a origin/main (confiamos en remote)
        execSafe("git fetch origin main", 30000);
        const behind = execSafe("git rev-list --count HEAD..origin/main", 5000);
        if (behind && parseInt(behind, 10) > 0) {
            execSafe("git checkout -- .", 10000);
            execSafe("git merge origin/main --ff-only", 15000);
            return { status: "updated", commits: parseInt(behind, 10) };
        }
        return { status: "up-to-date" };
    } catch (e) {
        return { status: "error", error: e.message };
    }
}

// ─── Step 5: Restart infrastructure ─────────────────────────────────────────

function restartInfrastructure() {
    const started = [];

    // 5a. Lanzar telegram-commander
    try {
        const cmdScript = path.join(HOOKS_DIR, "telegram-commander.js");
        if (fs.existsSync(cmdScript)) {
            const proc = spawn("node", [cmdScript], {
                cwd: REPO_ROOT, detached: true, stdio: "ignore", windowsHide: true,
            });
            proc.unref();
            started.push({ type: "commander", pid: proc.pid });
        }
    } catch (e) {
        started.push({ type: "commander", error: e.message });
    }

    // 5b. Lanzar dashboard server
    try {
        const dashScript = path.join(REPO_ROOT, ".claude", "dashboard-server.js");
        if (fs.existsSync(dashScript)) {
            const proc = spawn("node", [dashScript], {
                cwd: REPO_ROOT, detached: true, stdio: "ignore", windowsHide: true,
            });
            proc.unref();
            started.push({ type: "dashboard", pid: proc.pid });
        }
    } catch (e) {
        started.push({ type: "dashboard", error: e.message });
    }

    // Nota: el watcher NO se lanza aquí — se lanza automáticamente con Start-Agente.ps1
    // cuando se inicia un sprint

    return started;
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
    const startTime = Date.now();
    log("═══ RESET COMPLETO DE OPERACIONES ═══");

    // Step 1
    log("Paso 1/5: Matando todos los procesos...");
    const killed = killAllProcesses();
    log("  → " + killed.length + " procesos/archivos limpiados");

    // Esperar 2s para que los procesos terminen
    await new Promise(r => setTimeout(r, 2000));

    // Step 2
    log("Paso 2/5: Limpiando worktrees...");
    const worktrees = cleanWorktrees();
    log("  → " + worktrees.length + " worktrees eliminados");

    // Step 2.5
    log("Paso 2.5/5: Limpiando sesiones huérfanas...");
    const orphanSessions = cleanOrphanSessions();
    log("  → " + orphanSessions.length + " sesiones marcadas done");

    // Step 3
    log("Paso 3/5: Reseteando state files...");
    const stateFiles = resetStateFiles();
    log("  → " + stateFiles.length + " archivos reseteados");

    // Step 4
    log("Paso 4/5: Actualizando desde main...");
    const gitResult = gitPullMain();
    log("  → " + gitResult.status + (gitResult.commits ? " (" + gitResult.commits + " commits)" : ""));

    // Step 5
    log("Paso 5/5: Reiniciando infraestructura...");
    const infra = restartInfrastructure();
    log("  → " + infra.filter(i => !i.error).length + "/" + infra.length + " servicios iniciados");

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const report = {
        status: "ok",
        timestamp: new Date().toISOString(),
        elapsed_seconds: parseFloat(elapsed),
        killed: killed.length,
        worktrees_cleaned: worktrees.length,
        orphan_sessions: orphanSessions.length,
        state_files_reset: stateFiles.length,
        git: gitResult,
        infra_started: infra,
    };

    // Verificar errores
    if (gitResult.status === "error") report.status = "partial";
    if (infra.some(i => i.error)) report.status = "partial";

    if (FLAG_JSON) {
        console.log(JSON.stringify(report));
    } else {
        log("");
        log("═══ RESULTADO ═══");
        log("Estado: " + report.status.toUpperCase());
        log("Tiempo: " + elapsed + "s");
        log("Procesos matados: " + killed.length);
        log("Worktrees limpiados: " + worktrees.length);
        log("State files reseteados: " + stateFiles.length);
        log("Git: " + gitResult.status);
        log("Infra: " + infra.map(i => i.type + (i.error ? " ❌" : " ✅")).join(", "));
    }

    // Telegram notification
    if (FLAG_NOTIFY) {
        const icon = report.status === "ok" ? "✅" : "⚠️";
        let msg = icon + " <b>RESET COMPLETO</b> — " + elapsed + "s\n\n";
        msg += "🔪 Procesos: " + killed.length + " matados\n";
        msg += "📁 Worktrees: " + worktrees.length + " limpiados\n";
        msg += "🗂 State: " + stateFiles.length + " reseteados\n";
        msg += "📥 Git: " + gitResult.status;
        if (gitResult.commits) msg += " (" + gitResult.commits + " commits)";
        msg += "\n";
        for (const i of infra) {
            msg += (i.error ? "❌" : "✅") + " " + i.type;
            if (i.pid) msg += " (PID " + i.pid + ")";
            if (i.error) msg += ": " + i.error;
            msg += "\n";
        }
        msg += "\n🟢 Sistema listo para operar";
        await telegramSend(msg);
    }

    // Log to restart log
    try {
        const logEntry = JSON.stringify({ ...report, source: "reset-operations" }) + "\n";
        fs.appendFileSync(path.join(HOOKS_DIR, "restart-log.jsonl"), logEntry, "utf8");
    } catch (_) {}

    process.exit(report.status === "ok" ? 0 : 1);
}

main().catch(e => {
    if (FLAG_JSON) {
        console.log(JSON.stringify({ status: "error", error: e.message }));
    } else {
        console.error("[reset] ERROR FATAL: " + e.message);
    }
    process.exit(2);
});
