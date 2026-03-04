// agent-monitor.js — Monitor de agentes unificado (P-08)
// Reemplaza Watch-Agentes.ps1 + Guardian-Sprint.ps1 en Node.js
// Detecta fin de agentes, zombies (CPU estancada), inactividad
// Se integra con Commander: importar y llamar startAgentMonitor(plan)
// Pure Node.js — sin dependencias externas

const fs = require("fs");
const path = require("path");
const { execSync, spawn } = require("child_process");

const HOOKS_DIR = __dirname;
const REPO_ROOT = process.env.CLAUDE_PROJECT_DIR || path.resolve(HOOKS_DIR, "..", "..");
const LOG_FILE = path.join(HOOKS_DIR, "hook-debug.log");
const PLAN_FILE = path.join(REPO_ROOT, "scripts", "sprint-plan.json");
const PIDS_FILE = path.join(REPO_ROOT, "scripts", "sprint-pids.json");

// Intervalos configurables
const POLL_INTERVAL_MS = 30000;      // 30s — verificar agentes
const GUARDIAN_INTERVAL_MS = 300000; // 5 min — verificar inactividad
const COOLDOWN_MS = 600000;         // 10 min — entre relanzamientos
const FAILSAFE_MS = 4 * 60 * 60 * 1000; // 4 horas

let _pollInterval = null;
let _guardianInterval = null;
let _running = false;
let _plan = null;
let _startTime = null;
let _lastLaunchTime = 0;
let _prevCpuSnapshot = {};
let _onAllDone = null; // callback cuando todos los agentes terminan

let tgClient;
try { tgClient = require("./telegram-client"); } catch (e) { tgClient = null; }

let opsLearnings;
try { opsLearnings = require("./ops-learnings"); } catch (e) { opsLearnings = null; }

function log(msg) {
    try { fs.appendFileSync(LOG_FILE, "[" + new Date().toISOString() + "] AgentMonitor: " + msg + "\n"); } catch (e) {}
}

async function notify(text, silent) {
    if (!tgClient) return;
    try { await tgClient.sendMessage(text, { silent: !!silent }); } catch (e) { log("Notify error: " + e.message); }
}

// ─── Detección de agentes ────────────────────────────────────────────────────

function loadPlan() {
    try {
        if (!fs.existsSync(PLAN_FILE)) return null;
        return JSON.parse(fs.readFileSync(PLAN_FILE, "utf8"));
    } catch (e) { return null; }
}

function getWorktreePath(agente) {
    return path.resolve(REPO_ROOT, "..", "platform.agent-" + agente.issue + "-" + agente.slug);
}

function isProcessAlive(pid) {
    try { process.kill(pid, 0); return true; } catch (e) { return false; }
}

function isAgentDone(agente) {
    const wtDir = getWorktreePath(agente);

    // Worktree no existe → done
    if (!fs.existsSync(wtDir)) return true;

    // Check PID del agente desde sprint-pids.json
    if (fs.existsSync(PIDS_FILE) && agente.numero) {
        try {
            const pidsData = JSON.parse(fs.readFileSync(PIDS_FILE, "utf8"));
            const pid = pidsData["agente_" + agente.numero];
            if (pid && !isProcessAlive(pid)) return true;
        } catch (e) {}
    }

    // Fallback: buscar session files con status "done"
    const sessionsDir = path.join(wtDir, ".claude", "sessions");
    if (fs.existsSync(sessionsDir)) {
        try {
            const files = fs.readdirSync(sessionsDir).filter(f => f.endsWith(".json"));
            for (const f of files) {
                try {
                    const sess = JSON.parse(fs.readFileSync(path.join(sessionsDir, f), "utf8"));
                    if (sess.status === "done") return true;
                } catch (e) {}
            }
        } catch (e) {}
    }

    return false;
}

// ─── Detección de Claude y zombies ───────────────────────────────────────────

function getClaudeAgentPids() {
    // En Windows, usar wmic/tasklist para obtener PIDs de node.exe con claude-code
    const pids = {};
    try {
        const output = execSync(
            'wmic process where "name=\'node.exe\'" get ProcessId,CommandLine /format:csv',
            { encoding: "utf8", timeout: 5000, windowsHide: true }
        );
        const lines = output.split("\n").filter(l => l.includes("claude-code"));
        for (const line of lines) {
            const parts = line.trim().split(",");
            if (parts.length >= 3) {
                const cmdLine = parts.slice(1, -1).join(",");
                const pid = parseInt(parts[parts.length - 1], 10);
                if (!isNaN(pid) && cmdLine.includes("bypassPermissions")) {
                    pids[pid] = 0; // No podemos obtener UserModeTime fácilmente desde wmic csv
                }
            }
        }
    } catch (e) {}

    // Intentar obtener CPU time via tasklist
    try {
        for (const pid of Object.keys(pids)) {
            const out = execSync('wmic process where "ProcessId=' + pid + '" get UserModeTime /format:csv',
                { encoding: "utf8", timeout: 3000, windowsHide: true });
            const match = out.match(/,(\d+)/);
            if (match) pids[pid] = parseInt(match[1], 10);
        }
    } catch (e) {}

    return pids;
}

function findZombies(prevSnapshot, currSnapshot) {
    const zombies = [];
    for (const pid of Object.keys(currSnapshot)) {
        if (prevSnapshot[pid] !== undefined && currSnapshot[pid] === prevSnapshot[pid] && currSnapshot[pid] > 0) {
            zombies.push(parseInt(pid, 10));
        }
    }
    return zombies;
}

function killZombies(pids) {
    for (const pid of pids) {
        try {
            execSync("taskkill /PID " + pid + " /T /F", { timeout: 5000, windowsHide: true, stdio: "ignore" });
            log("Zombie eliminado: PID " + pid);
        } catch (e) {}
    }
}

function isAnyClaude() {
    try {
        const output = execSync(
            'wmic process where "name=\'node.exe\'" get CommandLine /format:csv',
            { encoding: "utf8", timeout: 5000, windowsHide: true }
        );
        return output.includes("claude-code");
    } catch (e) { return false; }
}

function hasAgentWorktrees() {
    try {
        const output = execSync("git worktree list --porcelain", {
            cwd: REPO_ROOT, encoding: "utf8", timeout: 5000, windowsHide: true
        });
        return output.includes("branch refs/heads/agent/");
    } catch (e) { return false; }
}

// ─── Watch-Agentes (polling de estado de agentes) ────────────────────────────

function checkAgents() {
    if (!_plan || !_plan.agentes || _plan.agentes.length === 0) return;

    const agentes = _plan.agentes;
    let doneCount = 0;
    const statusParts = [];

    for (const a of agentes) {
        if (isAgentDone(a)) {
            doneCount++;
            statusParts.push(a.numero + ":OK");
        } else {
            statusParts.push(a.numero + ":...");
        }
    }

    const elapsedMin = Math.round((Date.now() - _startTime) / 60000);
    log(doneCount + "/" + agentes.length + " finalizados [" + statusParts.join("  ") + "] (" + elapsedMin + " min)");

    if (doneCount >= agentes.length) {
        log("Todos los agentes finalizaron!");
        handleAllDone(elapsedMin);
        return;
    }

    // Failsafe: si paso mucho tiempo y no hay procesos claude
    if ((Date.now() - _startTime) > FAILSAFE_MS && !isAnyClaude()) {
        log("Failsafe: no hay procesos claude activos tras " + elapsedMin + " min. Procediendo.");
        handleAllDone(elapsedMin);
    }
}

async function handleAllDone(elapsedMin) {
    stopAgentMonitor();

    await notify("🏁 <b>Agentes finalizados</b>\n\nTodos los agentes terminaron (" + elapsedMin + " min).\nEjecutando cleanup...");

    // Ejecutar Stop-Agente.ps1 all
    const stopScript = path.join(REPO_ROOT, "scripts", "Stop-Agente.ps1");
    if (fs.existsSync(stopScript)) {
        try {
            execSync('powershell -File "' + stopScript + '" all', {
                cwd: REPO_ROOT, timeout: 120000, windowsHide: true, stdio: "ignore"
            });
            log("Stop-Agente.ps1 finalizado");
        } catch (e) {
            log("Error en Stop-Agente: " + e.message);
        }
    }

    // Generar reporte de sprint
    const reportScript = path.join(REPO_ROOT, "scripts", "sprint-report.js");
    if (fs.existsSync(reportScript)) {
        try {
            execSync('node "' + reportScript + '" "' + PLAN_FILE + '"', {
                cwd: REPO_ROOT, timeout: 60000, windowsHide: true, stdio: "ignore"
            });
            log("Reporte de sprint generado");
        } catch (e) {
            log("Error generando reporte: " + e.message);
        }
    }

    // Callback externo
    if (_onAllDone) {
        try { await _onAllDone(); } catch (e) { log("onAllDone callback error: " + e.message); }
    }
}

// ─── Guardian (detección de inactividad + zombies) ───────────────────────────

function guardianCheck() {
    // Detección dinámica de sprint: si no estamos en watch y existe sprint-plan.json, activar watch
    if (!_pollInterval && fs.existsSync(PLAN_FILE)) {
        const freshPlan = loadPlan();
        if (freshPlan && freshPlan.agentes && freshPlan.agentes.length > 0) {
            _plan = freshPlan;
            _startTime = Date.now();
            _pollInterval = setInterval(checkAgents, POLL_INTERVAL_MS);
            log("Watch activado dinámicamente: " + _plan.agentes.length + " agente(s) detectado(s) en sprint-plan.json");
            notify("👁️ <b>Monitor activado</b>\nDetectado sprint con " + _plan.agentes.length + " agente(s). Monitoreando...");
            return; // Salir de guardian esta iteración, próxima vez se ejecutará checkAgents
        }
    }

    // Detección de zombies
    const currCpuSnapshot = getClaudeAgentPids();
    if (Object.keys(_prevCpuSnapshot).length > 0 && Object.keys(currCpuSnapshot).length > 0) {
        const zombies = findZombies(_prevCpuSnapshot, currCpuSnapshot);
        if (zombies.length > 0) {
            log("ZOMBIE detectado: PID " + zombies.join(", ") + " — CPU inactiva entre ciclos");
            notify("🛡️ <b>Guardian: zombie(s) detectado(s)</b>\nPID: " + zombies.join(", ") + "\nEliminando procesos...");
            killZombies(zombies);

            if (opsLearnings) {
                try {
                    opsLearnings.recordLearning({
                        source: "agent-monitor",
                        category: "zombie_agent",
                        severity: "high",
                        symptom: "Zombie agent detectado: PID " + zombies.join(", "),
                        root_cause: "CPU inactiva entre ciclos de monitoreo",
                        resolution: "Kill automático aplicado",
                        affected: ["agent-monitor.js"],
                        auto_detected: true
                    });
                } catch (e) {}
            }
        }
    }
    _prevCpuSnapshot = currCpuSnapshot;

    // Detección de inactividad (solo si no hay watch activo)
    if (_pollInterval) return; // Watch-Agentes activo, no verificar inactividad

    const claudeRunning = isAnyClaude();
    const worktrees = hasAgentWorktrees();
    const isActive = claudeRunning || worktrees;

    if (!isActive) {
        const sinceLastLaunch = Date.now() - _lastLaunchTime;
        if (sinceLastLaunch < COOLDOWN_MS) {
            const remaining = Math.round((COOLDOWN_MS - sinceLastLaunch) / 60000);
            log("Inactivo pero cooldown activo: " + remaining + " min restantes");
            return;
        }

        log("Inactividad detectada. Relanzando ciclo...");
        notify("🛡️ <b>Guardian: inactividad detectada</b>\nNo hay agentes ni worktrees activos.\nRelanzando <code>/planner sprint</code>...");

        // Actualizar main
        try {
            execSync("git fetch origin main --quiet && git pull origin main --quiet", {
                cwd: REPO_ROOT, timeout: 30000, windowsHide: true, stdio: "ignore"
            });
        } catch (e) { log("Error actualizando main: " + e.message); }

        // Lanzar nueva terminal con /planner sprint
        try {
            const command = 'Remove-Item Env:CLAUDECODE -ErrorAction SilentlyContinue; '
                + "Set-Location '" + REPO_ROOT + "'; "
                + "claude '/planner sprint'";
            spawn("powershell", ["-NoExit", "-Command", command], {
                detached: true, stdio: "ignore", windowsHide: false
            }).unref();

            _lastLaunchTime = Date.now();
            log("Nuevo ciclo lanzado en terminal independiente");

            if (opsLearnings) {
                try {
                    opsLearnings.recordLearning({
                        source: "agent-monitor",
                        category: "guardian_relaunch",
                        severity: "low",
                        symptom: "Guardian: relanzamiento por inactividad",
                        root_cause: "No hay agentes, worktrees ni watcher activos",
                        resolution: "Relanzado /planner sprint automáticamente",
                        affected: ["agent-monitor.js"],
                        auto_detected: true
                    });
                } catch (e) {}
            }
        } catch (e) {
            log("Error relanzando: " + e.message);
        }
    }
}

// ─── API pública ─────────────────────────────────────────────────────────────

/**
 * Iniciar monitoreo de agentes del sprint actual.
 * @param {object} [plan] - Plan del sprint (si null, lee de sprint-plan.json)
 * @param {object} [opts] - { onAllDone: Function, guardianOnly: boolean }
 */
function startAgentMonitor(plan, opts) {
    opts = opts || {};
    _plan = plan || loadPlan();
    _startTime = Date.now();
    _running = true;
    _onAllDone = opts.onAllDone || null;
    _prevCpuSnapshot = {};

    if (_plan && _plan.agentes && _plan.agentes.length > 0 && !opts.guardianOnly) {
        // Watch mode: monitorear agentes específicos del sprint
        _pollInterval = setInterval(checkAgents, POLL_INTERVAL_MS);
        log("Watch iniciado: " + _plan.agentes.length + " agente(s) cada " + (POLL_INTERVAL_MS / 1000) + "s");
    }

    // Guardian mode: siempre activo para detectar inactividad y zombies
    _guardianInterval = setInterval(guardianCheck, GUARDIAN_INTERVAL_MS);
    log("Guardian iniciado: polling cada " + (GUARDIAN_INTERVAL_MS / 60000) + " min");

    return { watching: !!_pollInterval, guardian: !!_guardianInterval };
}

/**
 * Detener monitoreo.
 */
function stopAgentMonitor() {
    if (_pollInterval) { clearInterval(_pollInterval); _pollInterval = null; }
    if (_guardianInterval) { clearInterval(_guardianInterval); _guardianInterval = null; }
    _running = false;
    log("Agent monitor detenido");
}

/**
 * Obtener estado actual.
 */
function getAgentStatus() {
    if (!_plan || !_plan.agentes) return { active: false, agents: [] };

    const agents = _plan.agentes.map(a => ({
        numero: a.numero,
        issue: a.issue,
        slug: a.slug,
        done: isAgentDone(a)
    }));

    const elapsed = _startTime ? Math.round((Date.now() - _startTime) / 60000) : 0;
    const doneCount = agents.filter(a => a.done).length;

    return {
        active: _running,
        elapsed_min: elapsed,
        total: agents.length,
        done: doneCount,
        agents: agents,
        guardian: !!_guardianInterval,
        watching: !!_pollInterval
    };
}

module.exports = { startAgentMonitor, stopAgentMonitor, getAgentStatus };
