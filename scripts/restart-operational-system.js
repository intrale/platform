#!/usr/bin/env node
// restart-operational-system.js — Reinicio operativo centralizado
// Resetea state files, verifica conectividad y limpia procesos stale
// Pure Node.js — sin dependencias externas
//
// Uso: node scripts/restart-operational-system.js [--notify] [--json]
//   --notify  Enviar reporte a Telegram
//   --json    Salida solo JSON (para integración programática)

const fs = require("fs");
const path = require("path");
const https = require("https");
const { execSync } = require("child_process");

// ─── Paths ──────────────────────────────────────────────────────────────────

const SCRIPT_DIR = __dirname;
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");
const HOOKS_DIR = path.join(REPO_ROOT, ".claude", "hooks");
const CONFIG_FILE = path.join(HOOKS_DIR, "telegram-config.json");
const RESTART_LOG_FILE = path.join(HOOKS_DIR, "restart-log.jsonl");

// State files a resetear (a JSON vacío {})
// Algunos archivos requieren estructura específica (no solo {})
const STATE_FILE_DEFAULTS = {
    "pending-questions.json": '{"questions":[]}\n',
};
const STATE_FILES_TO_RESET = [
    "activity-logger-last.json",
    "health-check-state.json",
    "health-check-history.json",
    "health-check-components.json",
    "agent-progress-state.json",
    "pending-questions.json",
    "telegram-messages.json",
    "tg-session-store.json",
    "tg-commander-offset.json",
    "launcher-last-check.json",
    "agent-metrics.json",
    "worktree-guard-last-alert.json",
];

// ─── Args ───────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const FLAG_NOTIFY = args.includes("--notify");
const FLAG_JSON = args.includes("--json");

// ─── Helpers ────────────────────────────────────────────────────────────────

function loadConfig() {
    try {
        return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
    } catch {
        return null;
    }
}

function telegramSend(botToken, chatId, text) {
    return new Promise((resolve, reject) => {
        const postData = JSON.stringify({
            chat_id: chatId,
            text: text,
            parse_mode: "HTML",
        });
        const req = https.request({
            hostname: "api.telegram.org",
            path: "/bot" + botToken + "/sendMessage",
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(postData),
            },
            timeout: 10000,
        }, (res) => {
            let d = "";
            res.on("data", (c) => d += c);
            res.on("end", () => {
                try {
                    const r = JSON.parse(d);
                    resolve(r.ok === true);
                } catch { resolve(false); }
            });
        });
        req.on("timeout", () => { req.destroy(); resolve(false); });
        req.on("error", () => resolve(false));
        req.write(postData);
        req.end();
    });
}

// Paths nativos del SO (Windows vs Unix)
const isWindows = process.platform === "win32";
const JAVA_HOME_NATIVE = isWindows
    ? "C:\\Users\\Administrator\\.jdks\\temurin-21.0.7"
    : "/c/Users/Administrator/.jdks/temurin-21.0.7";
const GH_CLI_DIR = isWindows
    ? "C:\\Workspaces\\gh-cli\\bin"
    : "/c/Workspaces/gh-cli/bin";
const PATH_SEP = isWindows ? ";" : ":";

// Entorno con JAVA_HOME y gh-cli en PATH
const EXEC_ENV = Object.assign({}, process.env, {
    JAVA_HOME: JAVA_HOME_NATIVE,
    PATH: path.join(JAVA_HOME_NATIVE, "bin") + PATH_SEP + GH_CLI_DIR + PATH_SEP + (process.env.PATH || ""),
});

function execSafe(cmd, timeoutMs = 10000) {
    try {
        return execSync(cmd, { timeout: timeoutMs, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], env: EXEC_ENV }).trim();
    } catch (e) {
        // Capturar stderr si hay output parcial
        if (e.stderr) return e.stderr.toString().trim();
        if (e.stdout) return e.stdout.toString().trim();
        return null;
    }
}

function escHtml(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ─── Step 1: Reset state files ──────────────────────────────────────────────

function resetStateFiles() {
    const results = [];
    for (const fileName of STATE_FILES_TO_RESET) {
        const filePath = path.join(HOOKS_DIR, fileName);
        const existed = fs.existsSync(filePath);
        let previousSize = 0;
        try {
            if (existed) {
                const stat = fs.statSync(filePath);
                previousSize = stat.size;
            }
            const defaultContent = STATE_FILE_DEFAULTS[fileName] || "{}\n";
            fs.writeFileSync(filePath, defaultContent, "utf8");
            results.push({ file: fileName, status: "reset", existed, previousSize });
        } catch (e) {
            results.push({ file: fileName, status: "error", error: e.message });
        }
    }
    return results;
}

// ─── Step 2: Verify Telegram connectivity ───────────────────────────────────

async function verifyTelegram() {
    const config = loadConfig();
    if (!config || !config.bot_token || !config.chat_id) {
        return { status: "error", error: "telegram-config.json no encontrado o incompleto" };
    }
    const ok = await telegramSend(
        config.bot_token,
        config.chat_id,
        "🔄 <b>Restart Operativo</b> — Verificación de conectividad OK\n<i>" + new Date().toISOString() + "</i>"
    );
    return { status: ok ? "ok" : "error", error: ok ? null : "No se pudo enviar mensaje de prueba" };
}

// ─── Step 3: Verify GitHub CLI ──────────────────────────────────────────────

function verifyGitHubCLI() {
    const ghBin = path.join(GH_CLI_DIR, isWindows ? "gh.exe" : "gh");
    const output = execSafe("\"" + ghBin + "\" auth status 2>&1");
    if (output && output.includes("Logged in")) {
        const accountMatch = output.match(/account\s+(\S+)/);
        return { status: "ok", account: accountMatch ? accountMatch[1] : "unknown" };
    }
    return { status: "error", error: output || "gh auth status falló" };
}

// ─── Step 4: Verify Java/JAVA_HOME ─────────────────────────────────────────

function verifyJava() {
    const javaBin = path.join(JAVA_HOME_NATIVE, "bin", isWindows ? "java.exe" : "java");
    const output = execSafe("\"" + javaBin + "\" -version 2>&1");
    if (output && output.includes("21")) {
        const versionMatch = output.match(/version\s+"([^"]+)"/);
        return { status: "ok", version: versionMatch ? versionMatch[1] : "21+", javaHome: JAVA_HOME_NATIVE };
    }
    return { status: "error", error: "Java 21+ no encontrado en " + JAVA_HOME_NATIVE };
}

// ─── Step 5: Clean stale Node processes ─────────────────────────────────────

function cleanStaleProcesses() {
    const cleaned = [];
    const isWindows = process.platform === "win32";

    try {
        if (isWindows) {
            // En Windows, buscar procesos node con scripts de hooks específicos
            const tasklist = execSafe("tasklist /FI \"IMAGENAME eq node.exe\" /FO CSV /NH 2>&1", 15000);
            if (!tasklist) return { status: "ok", cleaned: [], message: "No se pudo listar procesos" };

            // Buscar lockfiles stale en vez de matar procesos activos (más seguro)
            const lockFiles = [
                path.join(HOOKS_DIR, "telegram-commander.lock"),
                path.join(HOOKS_DIR, "ci-monitor.lock"),
            ];
            for (const lockFile of lockFiles) {
                if (fs.existsSync(lockFile)) {
                    try {
                        const content = fs.readFileSync(lockFile, "utf8").trim();
                        const pid = parseInt(content, 10);
                        // Verificar si el PID sigue vivo
                        const check = execSafe("tasklist /FI \"PID eq " + pid + "\" /NH 2>&1");
                        if (!check || !check.includes("" + pid)) {
                            // PID muerto — limpiar lockfile
                            fs.unlinkSync(lockFile);
                            cleaned.push({ type: "lockfile", file: path.basename(lockFile), stalePid: pid });
                        }
                    } catch { /* ignorar */ }
                }
            }
        } else {
            // Linux/Mac: buscar lockfiles stale
            const lockFiles = [
                path.join(HOOKS_DIR, "telegram-commander.lock"),
                path.join(HOOKS_DIR, "ci-monitor.lock"),
            ];
            for (const lockFile of lockFiles) {
                if (fs.existsSync(lockFile)) {
                    try {
                        const content = fs.readFileSync(lockFile, "utf8").trim();
                        const pid = parseInt(content, 10);
                        const check = execSafe("kill -0 " + pid + " 2>&1");
                        if (check !== null && check.includes("No such process")) {
                            fs.unlinkSync(lockFile);
                            cleaned.push({ type: "lockfile", file: path.basename(lockFile), stalePid: pid });
                        }
                    } catch { /* ignorar */ }
                }
            }
        }
    } catch (e) {
        return { status: "error", error: e.message, cleaned };
    }

    return { status: "ok", cleaned };
}

// ─── Step 6: Log restart ────────────────────────────────────────────────────

function logRestart(report) {
    const entry = {
        timestamp: new Date().toISOString(),
        status: report.status,
        components: {
            stateFiles: report.stateFiles.filter(f => f.status === "error").length === 0 ? "ok" : "partial",
            telegram: report.telegram.status,
            github: report.github.status,
            java: report.java.status,
            processes: report.processes.status,
        },
        errors: [
            ...report.stateFiles.filter(f => f.status === "error").map(f => "state:" + f.file + " " + f.error),
            report.telegram.status === "error" ? "telegram:" + report.telegram.error : null,
            report.github.status === "error" ? "github:" + report.github.error : null,
            report.java.status === "error" ? "java:" + report.java.error : null,
            report.processes.status === "error" ? "processes:" + report.processes.error : null,
        ].filter(Boolean),
    };

    try {
        fs.appendFileSync(RESTART_LOG_FILE, JSON.stringify(entry) + "\n", "utf8");
    } catch { /* ignorar */ }

    return entry;
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
    const startTime = Date.now();
    const report = {
        status: "ok",
        timestamp: new Date().toISOString(),
        durationMs: 0,
        stateFiles: [],
        telegram: {},
        github: {},
        java: {},
        processes: {},
    };

    // Step 1: Reset state files
    report.stateFiles = resetStateFiles();

    // Step 2: Verify Telegram
    report.telegram = await verifyTelegram();

    // Step 3: Verify GitHub CLI
    report.github = verifyGitHubCLI();

    // Step 4: Verify Java
    report.java = verifyJava();

    // Step 5: Clean stale processes
    report.processes = cleanStaleProcesses();

    // Determine overall status
    const hasErrors = [
        report.stateFiles.some(f => f.status === "error"),
        report.telegram.status === "error",
        report.github.status === "error",
        report.java.status === "error",
        report.processes.status === "error",
    ];
    const errorCount = hasErrors.filter(Boolean).length;
    if (errorCount === 0) report.status = "ok";
    else if (errorCount <= 2) report.status = "partial";
    else report.status = "error";

    report.durationMs = Date.now() - startTime;

    // Log restart
    logRestart(report);

    // Output
    if (FLAG_JSON) {
        process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    } else {
        // Human-readable output
        const icon = { ok: "✓", partial: "⚠", error: "✗" };
        const stateResetCount = report.stateFiles.filter(f => f.status === "reset").length;
        const stateErrorCount = report.stateFiles.filter(f => f.status === "error").length;

        console.log("┌─ RESTART OPERATIVO ─────────────────────────────────────────────┐");
        console.log("├─ STATE FILES ───────────────────────────────────────────────────┤");
        console.log("│ " + (stateErrorCount === 0 ? icon.ok : icon.error) + " Reseteados: " + stateResetCount + "/" + STATE_FILES_TO_RESET.length + " archivos");
        if (stateErrorCount > 0) {
            for (const f of report.stateFiles.filter(f => f.status === "error")) {
                console.log("│   ✗ " + f.file + ": " + f.error);
            }
        }
        console.log("├─ CONECTIVIDAD ─────────────────────────────────────────────────┤");
        console.log("│ " + icon[report.telegram.status] + " Telegram     " + (report.telegram.status === "ok" ? "Mensaje de prueba enviado" : report.telegram.error));
        console.log("│ " + icon[report.github.status] + " GitHub CLI   " + (report.github.status === "ok" ? "Autenticado (" + report.github.account + ")" : report.github.error));
        console.log("│ " + icon[report.java.status] + " Java         " + (report.java.status === "ok" ? "v" + report.java.version : report.java.error));
        console.log("├─ PROCESOS ─────────────────────────────────────────────────────┤");
        const cleanedCount = (report.processes.cleaned || []).length;
        console.log("│ " + icon[report.processes.status] + " Lockfiles limpiados: " + cleanedCount);
        if (cleanedCount > 0) {
            for (const c of report.processes.cleaned) {
                console.log("│   ✓ " + c.file + " (PID " + c.stalePid + " stale)");
            }
        }
        console.log("├─ RESULTADO ────────────────────────────────────────────────────┤");
        const statusLabel = { ok: "OK — Sistema reiniciado correctamente", partial: "PARCIAL — Algunos componentes con errores", error: "ERROR — Reinicio con fallos" };
        console.log("│ " + icon[report.status] + " " + statusLabel[report.status]);
        console.log("│   Duración: " + report.durationMs + "ms");
        console.log("└────────────────────────────────────────────────────────────────┘");
    }

    // Notify Telegram if requested (and different from verification message)
    if (FLAG_NOTIFY && report.telegram.status === "ok") {
        const config = loadConfig();
        if (config) {
            const stateResetCount = report.stateFiles.filter(f => f.status === "reset").length;
            const cleanedCount = (report.processes.cleaned || []).length;
            let msg = "🔄 <b>Restart Operativo Completado</b>\n\n";
            msg += "Estado: <b>" + report.status.toUpperCase() + "</b>\n";
            msg += "State files reseteados: " + stateResetCount + "/" + STATE_FILES_TO_RESET.length + "\n";
            msg += "GitHub CLI: " + (report.github.status === "ok" ? "✓" : "✗") + "\n";
            msg += "Java: " + (report.java.status === "ok" ? "✓ v" + report.java.version : "✗") + "\n";
            msg += "Lockfiles limpiados: " + cleanedCount + "\n";
            msg += "Duración: " + report.durationMs + "ms\n";
            msg += "<i>" + report.timestamp + "</i>";
            await telegramSend(config.bot_token, config.chat_id, msg);
        }
    }

    // Exit code
    process.exit(report.status === "error" ? 1 : 0);
}

main().catch((e) => {
    console.error("Error fatal en restart-operational-system:", e.message);
    process.exit(2);
});
