// scrum-monitor-bg.js — Monitor periódico de salud del sprint (background)
// Ejecuta health-check-sprint.js cada 30 minutos
// Auto-repara inconsistencias menores automáticamente
// Alerta a Telegram si encuentra inconsistencias críticas
// Persiste historial en health-check-sprint-history.jsonl

const fs = require("fs");
const path = require("path");
const https = require("https");

const HOOKS_DIR = __dirname;
const REPO_ROOT = process.env.CLAUDE_PROJECT_DIR || path.resolve(HOOKS_DIR, "..", "..");
const LOG_FILE = path.join(HOOKS_DIR, "hook-debug.log");
const HISTORY_FILE = path.join(HOOKS_DIR, "scrum-health-history.jsonl");
const STATE_FILE = path.join(HOOKS_DIR, "scrum-monitor-state.json");
const CONFIG_FILE = path.join(HOOKS_DIR, "telegram-config.json");
const PID_FILE = path.join(HOOKS_DIR, "scrum-monitor-bg.pid");

// Intervalo de chequeo: 30 minutos
const CHECK_INTERVAL_MS = 30 * 60 * 1000;
// Auto-reparación automática para inconsistencias menores (sin --auto)
const AUTO_REPAIR_TYPES = ["pr_merged_issue_open", "closed_issue_wrong_status", "roadmap_zombie"];

function log(msg) {
    try {
        fs.appendFileSync(LOG_FILE, "[" + new Date().toISOString() + "] ScrumMonitorBg: " + msg + "\n");
    } catch (e) {}
}

function readState() {
    try { return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); } catch (e) { return {}; }
}

function writeState(state) {
    try { fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf8"); } catch (e) {}
}

function appendHistory(entry) {
    try {
        fs.appendFileSync(HISTORY_FILE, JSON.stringify(entry) + "\n");
    } catch (e) {
        log("Error escribiendo historial: " + e.message);
    }
}

function sendTelegram(text) {
    return new Promise((resolve) => {
        try {
            const config = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
            const postData = JSON.stringify({
                chat_id: config.chat_id,
                text,
                parse_mode: "HTML"
            });
            const req = https.request({
                hostname: "api.telegram.org",
                path: "/bot" + config.bot_token + "/sendMessage",
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Content-Length": Buffer.byteLength(postData)
                },
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
        } catch (e) {
            log("Error enviando Telegram: " + e.message);
            resolve(false);
        }
    });
}

function formatHealthIcon(level) {
    if (level === "critical") return "🔴";
    if (level === "warning") return "🟡";
    return "🟢";
}

function buildAlertMessage(diagnosis, repairResult) {
    const icon = formatHealthIcon(diagnosis.health_level);
    const sprint = diagnosis.sprint_id || "N/A";
    const metrics = diagnosis.metrics || {};

    let msg = `${icon} <b>Monitor Sprint — ${sprint}</b>\n`;
    msg += `<i>${new Date().toLocaleString("es-AR", { timeZone: "America/Argentina/Buenos_Aires" })}</i>\n\n`;

    msg += `📊 <b>Progreso:</b> ${metrics.completed || 0}/${metrics.total_issues || 0} completadas\n`;
    if (metrics.in_progress > 0) msg += `🔄 En progreso: ${metrics.in_progress}\n`;
    if (metrics.blocked > 0) msg += `🚫 Bloqueadas: ${metrics.blocked}\n`;

    if (diagnosis.inconsistencias && diagnosis.inconsistencias.length > 0) {
        msg += `\n⚠️ <b>Inconsistencias detectadas (${diagnosis.inconsistencias.length}):</b>\n`;
        for (const inc of diagnosis.inconsistencias.slice(0, 5)) {
            const sevIcon = inc.severity === "critical" ? "🔴" : inc.severity === "high" ? "🟠" : "🟡";
            msg += `${sevIcon} ${inc.message}\n`;
        }
        if (diagnosis.inconsistencias.length > 5) {
            msg += `  ... y ${diagnosis.inconsistencias.length - 5} más\n`;
        }
    }

    if (repairResult && repairResult.repairs && repairResult.repairs.length > 0) {
        const okRepairs = repairResult.repairs.filter(r => r.status === "ok");
        if (okRepairs.length > 0) {
            msg += `\n✅ <b>Auto-reparaciones (${okRepairs.length}):</b>\n`;
            for (const r of okRepairs) {
                msg += `  • Issue #${r.issue || "?"}: ${r.inconsistencia}\n`;
            }
        }
    }

    if (diagnosis.sprint_status && diagnosis.sprint_status !== "active") {
        if (diagnosis.sprint_status === "overdue_critical") {
            msg += `\n🚨 <b>Sprint vencido hace ${(diagnosis.sprint_overdue || {}).days_overdue || "?"} días</b>\n`;
        } else if (diagnosis.sprint_status === "overdue") {
            msg += `\n⏰ Sprint pasó su fecha de fin\n`;
        } else if (diagnosis.sprint_status === "closed") {
            msg += `\n✅ Sprint cerrado\n`;
        }
    }

    msg += `\n<i>Próximo check en 30 min</i>`;
    return msg;
}

async function runCheck() {
    const state = readState();
    const now = Date.now();

    // Verificar cooldown
    if (state.last_check && (now - state.last_check) < CHECK_INTERVAL_MS) {
        log("Cooldown activo, próximo check en " +
            Math.round((CHECK_INTERVAL_MS - (now - state.last_check)) / 60000) + " min");
        return;
    }

    log("Ejecutando check periódico del sprint...");

    let diagnosis;
    let repairResult = null;
    let error = null;

    try {
        const { runHealthCheck } = require("./health-check-sprint");
        diagnosis = await runHealthCheck();
    } catch (e) {
        error = e.message;
        log("Error en health check: " + e.message);
        writeState({ last_check: now, last_error: e.message });
        return;
    }

    // Auto-reparar inconsistencias menores automáticamente
    if (diagnosis.inconsistencias && diagnosis.inconsistencias.length > 0) {
        const autoRepairInconsistencias = diagnosis.inconsistencias.filter(inc =>
            AUTO_REPAIR_TYPES.includes(inc.type)
        );

        if (autoRepairInconsistencias.length > 0) {
            try {
                const { runAutoRepair } = require("./sprint-manager");
                repairResult = await runAutoRepair(
                    { inconsistencias: autoRepairInconsistencias },
                    { dryRun: false, onlyTypes: AUTO_REPAIR_TYPES }
                );
                log("Auto-reparación completada: " +
                    (repairResult.ok_count || 0) + " OK, " +
                    (repairResult.error_count || 0) + " errores");
            } catch (e) {
                log("Error en auto-reparación: " + e.message);
            }
        }
    }

    // Persistir historial
    appendHistory({
        timestamp: new Date().toISOString(),
        sprint_id: diagnosis.sprint_id,
        health_level: diagnosis.health_level,
        inconsistencias_count: (diagnosis.inconsistencias || []).length,
        repairs_count: repairResult ? (repairResult.ok_count || 0) : 0,
        metrics: diagnosis.metrics
    });

    // Actualizar estado
    writeState({
        last_check: now,
        last_check_iso: new Date(now).toISOString(),
        last_health_level: diagnosis.health_level,
        last_inconsistencias: (diagnosis.inconsistencias || []).length,
        sprint_id: diagnosis.sprint_id,
        sprint_status: diagnosis.sprint_status
    });

    // Alertar a Telegram si hay inconsistencias
    const shouldAlert = diagnosis.health_level !== "healthy" ||
        (repairResult && repairResult.ok_count > 0);

    if (shouldAlert) {
        const msg = buildAlertMessage(diagnosis, repairResult);
        await sendTelegram(msg);
        log("Alerta Telegram enviada (nivel: " + diagnosis.health_level + ")");
    } else {
        log("Sprint saludable — sin alertas");
    }
}

// ─── Modo daemon (si se llama con --daemon) ───────────────────────────────────

function isDaemonRunning() {
    try {
        if (!fs.existsSync(PID_FILE)) return false;
        const pid = parseInt(fs.readFileSync(PID_FILE, "utf8").trim());
        if (!pid) return false;
        process.kill(pid, 0);
        return true;
    } catch (e) {
        return false;
    }
}

function writePidFile() {
    try {
        fs.writeFileSync(PID_FILE, String(process.pid), "utf8");
    } catch (e) {}
}

function removePidFile() {
    try {
        if (fs.existsSync(PID_FILE)) fs.unlinkSync(PID_FILE);
    } catch (e) {}
}

// ─── Main ─────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const daemonMode = args.includes("--daemon");
const onceMode = args.includes("--once");

if (onceMode) {
    // Ejecutar una sola vez (para comandos manuales)
    runCheck().then(() => {
        log("Check único completado");
    }).catch(e => {
        log("Error en check único: " + e.message);
    });
} else if (daemonMode) {
    // Modo daemon: ejecutar periódicamente
    if (isDaemonRunning()) {
        log("Ya hay un daemon corriendo, saliendo");
        process.exit(0);
    }

    writePidFile();
    log("Daemon iniciado (PID " + process.pid + ", intervalo: " + (CHECK_INTERVAL_MS / 60000) + " min)");

    process.on("exit", removePidFile);
    process.on("SIGINT", () => { removePidFile(); process.exit(0); });
    process.on("SIGTERM", () => { removePidFile(); process.exit(0); });

    // Ejecutar inmediatamente y luego de forma periódica
    runCheck().catch(e => log("Error en primer check: " + e.message));

    setInterval(() => {
        runCheck().catch(e => log("Error en check periódico: " + e.message));
    }, CHECK_INTERVAL_MS);
} else {
    // Invocado desde hook sin argumento → ejecutar una sola vez con cooldown
    runCheck().catch(e => log("Error: " + e.message));
}

module.exports = { runCheck };
