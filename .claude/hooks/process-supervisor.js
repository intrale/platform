// process-supervisor.js — Supervisor centralizado de procesos (P-14)
// Registry de PIDs con políticas de restart/notify/ignore
// Health loop cada 15s verifica todos los PIDs registrados
// Se integra con Commander: importar y llamar startSupervision()
// Pure Node.js — sin dependencias externas

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const HOOKS_DIR = __dirname;
const LOG_FILE = path.join(HOOKS_DIR, "hook-debug.log");
const REGISTRY_FILE = path.join(HOOKS_DIR, "process-registry.json");
const HEALTH_INTERVAL_MS = 15000; // 15s

let _healthInterval = null;
let _registry = new Map(); // pid → { role, policy, lastHeartbeat, startedAt, restartCmd, restartArgs, cwd }

let tgClient;
try { tgClient = require("./telegram-client"); } catch (e) { tgClient = null; }

let opsLearnings;
try { opsLearnings = require("./ops-learnings"); } catch (e) { opsLearnings = null; }

function log(msg) {
    try { fs.appendFileSync(LOG_FILE, "[" + new Date().toISOString() + "] Supervisor: " + msg + "\n"); } catch (e) {}
}

async function notify(text, silent) {
    if (!tgClient) return;
    try { await tgClient.sendMessage(text, { silent: !!silent }); } catch (e) { log("Notify error: " + e.message); }
}

function isProcessAlive(pid) {
    try { process.kill(pid, 0); return true; } catch (e) { return false; }
}

// ─── Registry ────────────────────────────────────────────────────────────────

/**
 * Registrar un proceso para supervisión.
 * @param {number} pid - PID del proceso
 * @param {string} role - Nombre/rol del proceso (ej: "ci-monitor", "commander")
 * @param {object} [opts] - { policy: "restart"|"notify"|"ignore", restartCmd, restartArgs, cwd }
 */
function register(pid, role, opts) {
    opts = opts || {};
    _registry.set(pid, {
        role: role,
        policy: opts.policy || "notify",
        lastHeartbeat: Date.now(),
        startedAt: Date.now(),
        restartCmd: opts.restartCmd || null,
        restartArgs: opts.restartArgs || [],
        cwd: opts.cwd || HOOKS_DIR
    });
    persistRegistry();
    log("Registrado: PID " + pid + " (" + role + ") policy=" + (opts.policy || "notify"));
}

/**
 * Desregistrar un proceso.
 * @param {number} pid
 */
function unregister(pid) {
    if (_registry.has(pid)) {
        const entry = _registry.get(pid);
        log("Desregistrado: PID " + pid + " (" + entry.role + ")");
        _registry.delete(pid);
        persistRegistry();
    }
}

/**
 * Actualizar heartbeat de un proceso.
 * @param {number} pid
 */
function heartbeat(pid) {
    if (_registry.has(pid)) {
        _registry.get(pid).lastHeartbeat = Date.now();
    }
}

/**
 * Obtener el registry completo.
 * @returns {Array} - Array de { pid, role, policy, alive, lastHeartbeat, startedAt }
 */
function getRegistry() {
    const result = [];
    for (const [pid, entry] of _registry) {
        result.push({
            pid: pid,
            role: entry.role,
            policy: entry.policy,
            alive: isProcessAlive(pid),
            lastHeartbeat: entry.lastHeartbeat,
            startedAt: entry.startedAt,
            uptimeMin: Math.round((Date.now() - entry.startedAt) / 60000)
        });
    }
    return result;
}

function persistRegistry() {
    try {
        const data = {};
        for (const [pid, entry] of _registry) {
            data[pid] = entry;
        }
        fs.writeFileSync(REGISTRY_FILE, JSON.stringify(data, null, 2), "utf8");
    } catch (e) {}
}

function loadRegistry() {
    try {
        if (!fs.existsSync(REGISTRY_FILE)) return;
        const data = JSON.parse(fs.readFileSync(REGISTRY_FILE, "utf8"));
        for (const [pidStr, entry] of Object.entries(data)) {
            const pid = parseInt(pidStr, 10);
            if (!isNaN(pid)) {
                _registry.set(pid, entry);
            }
        }
    } catch (e) {}
}

// ─── Health loop ─────────────────────────────────────────────────────────────

async function healthCheck() {
    const deadPids = [];

    for (const [pid, entry] of _registry) {
        if (!isProcessAlive(pid)) {
            deadPids.push({ pid, entry });
        }
    }

    for (const { pid, entry } of deadPids) {
        log("Proceso muerto: PID " + pid + " (" + entry.role + ") policy=" + entry.policy);

        if (entry.policy === "restart" && entry.restartCmd) {
            // Reiniciar proceso
            try {
                const child = spawn(entry.restartCmd, entry.restartArgs, {
                    cwd: entry.cwd,
                    detached: true,
                    stdio: "ignore",
                    windowsHide: true
                });
                child.unref();

                const newPid = child.pid;
                _registry.delete(pid);
                register(newPid, entry.role, {
                    policy: entry.policy,
                    restartCmd: entry.restartCmd,
                    restartArgs: entry.restartArgs,
                    cwd: entry.cwd
                });

                log("Reiniciado: " + entry.role + " PID " + pid + " → " + newPid);
                await notify("🔄 <b>Supervisor: " + entry.role + " reiniciado</b>\nPID " + pid + " → " + newPid, true);

                if (opsLearnings) {
                    try {
                        opsLearnings.recordLearning({
                            source: "process-supervisor",
                            category: "process_restart",
                            severity: "high",
                            symptom: "Proceso reiniciado: " + entry.role + " (PID " + pid + " murió)",
                            root_cause: "Proceso no respondía — política restart aplicada",
                            resolution: "Reiniciado automáticamente como PID " + newPid,
                            affected: ["process-supervisor.js"],
                            auto_detected: true
                        });
                    } catch (e) {}
                }
            } catch (e) {
                log("Error reiniciando " + entry.role + ": " + e.message);
                _registry.delete(pid);
                persistRegistry();
                await notify("❌ <b>Supervisor: " + entry.role + " falló al reiniciar</b>\n" + e.message);
            }
        } else if (entry.policy === "notify") {
            _registry.delete(pid);
            persistRegistry();
            await notify("⚠️ <b>Supervisor: " + entry.role + " murió</b>\nPID " + pid + " no responde.", true);

            if (opsLearnings) {
                try {
                    opsLearnings.recordLearning({
                        source: "process-supervisor",
                        category: "process_death",
                        severity: "high",
                        symptom: "Proceso murió: " + entry.role + " (PID " + pid + ")",
                        root_cause: "Proceso dejó de responder",
                        affected: ["process-supervisor.js"],
                        auto_detected: true
                    });
                } catch (e) {}
            }
        } else {
            // policy === "ignore"
            _registry.delete(pid);
            persistRegistry();
        }
    }
}

// ─── API pública ─────────────────────────────────────────────────────────────

/**
 * Iniciar el loop de supervisión.
 */
function startSupervision() {
    if (_healthInterval) return; // Ya corriendo
    loadRegistry();

    // Limpiar PIDs muertos del registry persistido (stale)
    const stalePids = [];
    for (const [pid] of _registry) {
        if (!isProcessAlive(pid)) stalePids.push(pid);
    }
    for (const pid of stalePids) {
        _registry.delete(pid);
    }
    if (stalePids.length > 0) {
        persistRegistry();
        log("Limpiados " + stalePids.length + " PIDs stale del registry");
    }

    _healthInterval = setInterval(() => {
        healthCheck().catch(e => log("Health check error: " + e.message));
    }, HEALTH_INTERVAL_MS);

    log("Supervisor iniciado (health cada " + (HEALTH_INTERVAL_MS / 1000) + "s)");
}

/**
 * Detener el loop de supervisión.
 */
function stopSupervision() {
    if (_healthInterval) {
        clearInterval(_healthInterval);
        _healthInterval = null;
    }
    log("Supervisor detenido");
}

module.exports = {
    register,
    unregister,
    heartbeat,
    getRegistry,
    startSupervision,
    stopSupervision
};
