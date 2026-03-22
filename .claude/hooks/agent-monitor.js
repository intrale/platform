// agent-monitor.js — Monitor de agentes unificado (P-08)
// Reemplaza Watch-Agentes.ps1 + Guardian-Sprint.ps1 en Node.js
// Detecta fin de agentes, zombies (CPU estancada), inactividad
// Se integra con Commander: importar y llamar startAgentMonitor(plan)
// Pure Node.js — sin dependencias externas

const fs = require("fs");
const path = require("path");
const { execSync, spawn } = require("child_process");

const HOOKS_DIR = __dirname;

// Bug fix (#1266): Resolver el repo principal desde worktrees.
function resolveMainRepoRoot(hooksDir) {
    const envRoot = process.env.CLAUDE_PROJECT_DIR || path.resolve(hooksDir, "..", "..");
    try {
        const output = execSync("git worktree list", {
            encoding: "utf8",
            cwd: envRoot,
            timeout: 5000,
            windowsHide: true
        });
        const firstLine = output.split("\n")[0] || "";
        const match = firstLine.match(/^(.+?)\s+[0-9a-f]{5,}/);
        if (match) {
            const mainPath = match[1].trim();
            return mainPath.replace(/^\/([a-z])\//, "$1:\\").replace(/\//g, "\\");
        }
    } catch (e) {}
    const planFile = path.join(envRoot, "scripts", "sprint-plan.json");
    if (!fs.existsSync(planFile)) {
        return path.resolve(hooksDir, "..", "..");
    }
    return envRoot;
}

const REPO_ROOT = resolveMainRepoRoot(HOOKS_DIR);
const LOG_FILE = path.join(HOOKS_DIR, "hook-debug.log");
const PLAN_FILE = path.join(REPO_ROOT, "scripts", "sprint-plan.json");
const PIDS_FILE = path.join(REPO_ROOT, "scripts", "sprint-pids.json");
const METRICS_FILE = path.join(HOOKS_DIR, "agent-metrics.json");
const PARTICIPATION_FILE = path.join(HOOKS_DIR, "agent-participation.json");

// Lista canónica de todos los agentes que deben participar proactivamente en el pipeline
// NOTA: /ios-dev y /desktop-dev están congelados en .claude/skills/_frozen/ (issue #1519)
// Para reactivarlos: mover la carpeta de _frozen/ a .claude/skills/ y agregar al array.
const ALL_PIPELINE_AGENTS = [
    "/ops", "/po", "/ux", "/guru",
    "/backend-dev", "/android-dev", "/web-dev",
    "/tester", "/builder", "/security", "/qa", "/review",
    "/delivery", "/scrum", "/cleanup",
    "/planner", "/refinar", "/priorizar", "/historia"
];

// Intervalos y timeouts configurables
const POLL_INTERVAL_MS = 30000;      // 30s — verificar agentes
const GUARDIAN_INTERVAL_MS = 300000; // 5 min — verificar inactividad
const COOLDOWN_MS = 600000;         // 10 min — entre relanzamientos
const FAILSAFE_MS = 4 * 60 * 60 * 1000; // 4 horas
const STALE_MS = 15 * 60 * 1000;    // 15 minutos — agente sin actividad = stale
const FAILED_TOTAL_MS = 45 * 60 * 1000; // 45 minutos — agente sin actividad = failed

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

// Validación centralizada de completación (#1458)
const { validateCompletionCriteria, checkPRStatusViaGh, getDurationFromRegistry } = require("./validation-utils");

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
    // Guard: agentes con status "queued" NUNCA están done (no se han lanzado)
    if (agente.status === "queued") {
        return false;
    }

    const wtDir = getWorktreePath(agente);
    if (!fs.existsSync(wtDir)) {
        // Sin worktree: verificar si tiene PID registrado
        let hasPid = false;
        if (fs.existsSync(PIDS_FILE) && agente.numero) {
            try {
                const pidsData = JSON.parse(fs.readFileSync(PIDS_FILE, "utf8"));
                hasPid = !!pidsData["agente_" + agente.numero];
            } catch (e) {}
        }
        // Sin worktree + sin PID → nunca se lanzó → NOT done
        // Sin worktree + con PID → terminó y se limpió → done
        return hasPid;
    }

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

// ─── Supervisión de PRs de agentes (#1658) ────────────────────────────────────────────────

const GH_CLI_CANDIDATES_AM = [
    "C:\\Workspaces\\gh-cli\\bin\\gh.exe",
    "/c/Workspaces/gh-cli/bin/gh.exe",
    "gh"
];

function findGhCliForMonitor() {
    for (const candidate of GH_CLI_CANDIDATES_AM) {
        try {
            execSync('"' + candidate + '" --version', { encoding: "utf8", timeout: 3000, windowsHide: true });
            return candidate;
        } catch (e) {}
    }
    return null;
}

/**
 * Verifica el estado de CI para un PR dado su número.
 * @returns {"success"|"failure"|"pending"|"unknown"}
 */
function getPRCiStatus(prNumber) {
    const ghCmd = findGhCliForMonitor();
    if (!ghCmd) return "unknown";
    try {
        const out = execSync(
            '"' + ghCmd + '" pr checks ' + prNumber + ' --repo intrale/platform --json name,state,conclusion',
            { encoding: "utf8", timeout: 15000, windowsHide: true }
        );
        const checks = JSON.parse(out || "[]");
        if (!Array.isArray(checks) || checks.length === 0) return "unknown";
        if (checks.some(ch => ch.conclusion === "FAILURE" || ch.conclusion === "CANCELLED")) return "failure";
        if (checks.some(ch => ch.state === "IN_PROGRESS" || ch.state === "QUEUED" || ch.conclusion === null)) return "pending";
        if (checks.every(ch => ch.conclusion === "SUCCESS")) return "success";
        return "unknown";
    } catch (e) {
        return "unknown";
    }
}

/**
 * Obtiene PRs abiertos de ramas agent/* con su estado de CI.
 * @returns {{ prNumber: number, branch: string, ci: string, url: string }[]}
 */
function getOpenAgentPRs() {
    const ghCmd = findGhCliForMonitor();
    if (!ghCmd) return [];
    try {
        const out = execSync(
            '"' + ghCmd + '" pr list --repo intrale/platform --state open --json number,headRefName,url,updatedAt',
            { encoding: "utf8", timeout: 15000, windowsHide: true }
        );
        const prs = JSON.parse(out || "[]");
        return prs
            .filter(pr => pr.headRefName && pr.headRefName.startsWith("agent/"))
            .map(pr => ({
                prNumber: pr.number,
                branch: pr.headRefName,
                url: pr.url,
                updatedAt: pr.updatedAt,
                ci: getPRCiStatus(pr.number)
            }));
    } catch (e) {
        log("getOpenAgentPRs error: " + e.message);
        return [];
    }
}

/**
 * Verifica si un PR tiene label qa:passed o qa:skipped.
 */
function prHasQaLabel(prNumber) {
    const ghCmd = findGhCliForMonitor();
    if (!ghCmd) return false;
    try {
        const out = execSync(
            '"' + ghCmd + '" pr view ' + prNumber + ' --repo intrale/platform --json labels --jq ' + "'" + '.labels[].name' + "'" + '',
            { encoding: "utf8", timeout: 10000, windowsHide: true }
        );
        return out.includes("qa:passed") || out.includes("qa:skipped");
    } catch (e) {
        return false;
    }
}

/**
 * Persiste el estado del ciclo de cierre en sprint-plan.json (#1658).
 * Estados: "activo" | "ci-pending" | "merging" | "closing" | "planificando" | "arrancando" | "finalizado"
 */
function persistCicloEstado(estado, extraFields) {
    try {
        if (!fs.existsSync(PLAN_FILE)) return;
        const plan = JSON.parse(fs.readFileSync(PLAN_FILE, "utf8"));
        plan.estado = estado;
        if (extraFields) Object.assign(plan, extraFields);
        // #1736: escribir al roadmap, no directo al cache
try { require("./sprint-data.js").saveRoadmapFromPlan(plan, "agent-monitor"); } catch(e) {}
        log("persistCicloEstado: " + estado);
    } catch (e) {
        log("persistCicloEstado error: " + e.message);
    }
}

/**
 * Loop de supervisión de PRs abiertos de ramas agent/*.
 * Se ejecuta cada PR_POLL_INTERVAL_MS (5 min) (#1658).
 */
async function supervisePRs() {
    const openPRs = getOpenAgentPRs();
    const ghCmd = findGhCliForMonitor();
    const now = Date.now();

    if (openPRs.length === 0) {
        const plan = loadPlan();
        if (plan) {
            const currentQueue = Array.isArray(plan._queue) ? plan._queue :
                (Array.isArray(plan.cola) ? plan.cola : []);
            const allAgentsDone = (plan.agentes || []).every(ag => isAgentDone(ag));
            const safeToCLose = plan.estado !== "closing" && plan.estado !== "planificando" &&
                plan.estado !== "arrancando" && plan.estado !== "finalizado";
            if (currentQueue.length === 0 && allAgentsDone && safeToCLose) {
                log("supervisePRs: sin PRs abiertos y todos terminados → cerrando sprint");
                const elapsed = _startTime ? Math.round((Date.now() - _startTime) / 60000) : 0;
                await handleAllDone(elapsed);
            }
        }
        return;
    }

    for (const pr of openPRs) {
        const lastNotif = _prLastActivity[pr.prNumber] || 0;
        const staleSince = now - lastNotif;

        if (pr.ci === "failure") {
            if (staleSince > 60000) {
                await notify(
                    "🔴 <b>CI rojo en PR #" + pr.prNumber + "</b>\n" +
                    "Rama: <code>" + pr.branch + "</code>\n" +
                    "URL: " + pr.url + "\n" +
                    "Requiere auto-reparación (#1656)"
                );
                _prLastActivity[pr.prNumber] = now;
                log("supervisePRs: CI rojo PR #" + pr.prNumber);
            }
        } else if (pr.ci === "success") {
            const hasQa = prHasQaLabel(pr.prNumber);
            if (hasQa && ghCmd) {
                try {
                    execSync(
                        '"' + ghCmd + '" pr merge ' + pr.prNumber +
                        ' --repo intrale/platform --squash --auto',
                        { encoding: "utf8", timeout: 30000, windowsHide: true }
                    );
                    await notify(
                        "✅ <b>Auto-merge PR #" + pr.prNumber + "</b>\n" +
                        "Rama: <code>" + pr.branch + "</code>"
                    );
                    _prLastActivity[pr.prNumber] = now;
                    log("supervisePRs: auto-merge PR #" + pr.prNumber);
                } catch (e) {
                    log("supervisePRs: merge PR #" + pr.prNumber + " (ya mergeado o error): " + e.message);
                }
            } else if (!hasQa && staleSince > PR_STALE_MS) {
                await notify(
                    "⚠️ <b>PR #" + pr.prNumber + " CI verde sin label QA</b>\n" +
                    "Rama: <code>" + pr.branch + "</code>\n" +
                    "Pendiente: <code>qa:passed</code> o <code>qa:skipped</code>"
                );
                _prLastActivity[pr.prNumber] = now;
            }
        } else if (pr.ci === "pending" || pr.ci === "unknown") {
            if (staleSince > PR_STALE_MS) {
                await notify(
                    "⏳ <b>PR #" + pr.prNumber + " lleva " + Math.round(staleSince / 60000) + " min en CI</b>\n" +
                    "Rama: <code>" + pr.branch + "</code>\n" +
                    pr.url
                );
                _prLastActivity[pr.prNumber] = now;
            }
        }

        if (!_prLastActivity[pr.prNumber]) {
            _prLastActivity[pr.prNumber] = now;
        }
    }
}


// ─── Watch-Agentes (polling de estado de agentes) ────────────────────────────

function checkAgents() {
    // Delegar a _checkAgentsImpl que incluye lógica de promoción de cola
    _checkAgentsImpl().catch(e => log("checkAgents error: " + e.message));
}

async function handleAllDone(elapsedMin) {
    // Leer ciclo_estado para crash resilience (#1658)
    let cicloEstado = "closing";
    try {
        if (fs.existsSync(PLAN_FILE)) {
            const planSnap = JSON.parse(fs.readFileSync(PLAN_FILE, "utf8"));
            const saved = planSnap.ciclo_estado;
            if (saved && ["closing", "planificando", "arrancando"].includes(saved)) {
                cicloEstado = saved;
                log("handleAllDone: retomando desde estado '" + cicloEstado + "' (crash resilience)");
            }
        }
    } catch (e) {}

    stopAgentMonitor();

    // ── Fase 1: Cierre del sprint ─────────────────────────────────────────────
    if (cicloEstado === "closing") {
        persistCicloEstado("closing", { ciclo_estado: "closing" });
        await notify("🏁 <b>Agentes finalizados</b>\n\nTodos los agentes terminaron (" + elapsedMin + " min).\nEjecutando cierre del sprint...");

        // Stop-Agente.ps1 all
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

        // Reporte de sprint (sprint-report.js)
        const reportScript = path.join(REPO_ROOT, "scripts", "sprint-report.js");
        if (fs.existsSync(reportScript)) {
            try {
                execSync('node "' + reportScript + '" "' + PLAN_FILE + '"', {
                    cwd: REPO_ROOT, timeout: 120000, windowsHide: true, stdio: "ignore"
                });
                log("Reporte de sprint generado");
            } catch (e) {
                log("Error generando reporte: " + e.message);
            }
        }

        // Reporte de costos (cost-report.js --telegram)
        const costScript = path.join(REPO_ROOT, "scripts", "cost-report.js");
        if (fs.existsSync(costScript)) {
            try {
                execSync('node "' + costScript + '" --telegram', {
                    cwd: REPO_ROOT, timeout: 120000, windowsHide: true, stdio: "ignore"
                });
                log("Reporte de costos generado");
            } catch (e) {
                log("Error generando costos: " + e.message);
            }
        }

        // Registrar participación de agentes
        try {
            const participation = recordSprintParticipation();
            if (participation) {
                const semaforo = participation.coveragePct >= 80 ? "🟢" : participation.coveragePct >= 50 ? "🟡" : "🔴";
                await notify(
                    "📊 <b>Cobertura de agentes del sprint</b>\n\n" +
                    semaforo + " " + participation.agentsList.length + "/" + ALL_PIPELINE_AGENTS.length +
                    " agentes (" + participation.coveragePct + "%)\n" +
                    "Participaron: " + participation.agentsList.join(", ")
                );
                await alertInactiveAgents();
            }
        } catch (e) { log("Error en métricas de participación: " + e.message); }

        // Marcar sprint como finalizado en plan
        try {
            if (fs.existsSync(PLAN_FILE)) {
                const planToClose = JSON.parse(fs.readFileSync(PLAN_FILE, "utf8"));
                planToClose.estado = "finalizado";
                planToClose.closed_at = new Date().toISOString();
                planToClose.ciclo_estado = "planificando";
                // #1736: escribir al roadmap, no directo al cache
                try { require("./sprint-data.js").saveRoadmapFromPlan(planToClose, "agent-monitor"); } catch(e) {}
            }
        } catch (e) { log("Error actualizando plan al cerrar: " + e.message); }

        cicloEstado = "planificando";
        log("Fase 1 completada: sprint cerrado");
    }

    // ── Fase 2: Planificar siguiente sprint ───────────────────────────────────
    if (cicloEstado === "planificando") {
        persistCicloEstado("planificando", { ciclo_estado: "planificando" });
        await notify("🗺️ <b>Planificando siguiente sprint...</b>\nEjecutando auto-plan-sprint.js");

        const planScript = path.join(REPO_ROOT, "scripts", "auto-plan-sprint.js");
        let planOk = false;
        if (fs.existsSync(planScript)) {
            try {
                execSync('node "' + planScript + '"', {
                    cwd: REPO_ROOT, timeout: 300000, windowsHide: true, stdio: "ignore"
                });
                planOk = true;
                log("Siguiente sprint planificado");
            } catch (e) {
                log("Error en auto-plan-sprint: " + e.message);
                await notify("⚠️ <b>Error planificando sprint</b>\n" + e.message.substring(0, 200));
            }
        } else {
            log("auto-plan-sprint.js no encontrado");
        }

        if (planOk) {
            cicloEstado = "arrancando";
            // Persistir el avance
            try {
                if (fs.existsSync(PLAN_FILE)) {
                    const planNext = JSON.parse(fs.readFileSync(PLAN_FILE, "utf8"));
                    planNext.ciclo_estado = "arrancando";
                    // #1736: escribir al roadmap, no directo al cache
                    try { require("./sprint-data.js").saveRoadmapFromPlan(planNext, "agent-monitor"); } catch(e) {}
                }
            } catch (e) {}
        } else {
            await notify("🚨 <b>Planificación fallida</b>\nRevisa auto-plan-sprint.log y lanza manualmente.");
            return;
        }
    }

    // ── Fase 3: Arrancar agentes del siguiente sprint ─────────────────────────
    if (cicloEstado === "arrancando") {
        persistCicloEstado("arrancando", { ciclo_estado: "arrancando" });

        const startScript = path.join(REPO_ROOT, "scripts", "Start-Agente.ps1");
        if (fs.existsSync(startScript)) {
            try {
                await notify("🚀 <b>Arrancando siguiente sprint...</b>");
                const child = require("child_process").spawn("powershell.exe", ["-NonInteractive", "-File", startScript, "all"], {
                    detached: true, stdio: "ignore", windowsHide: false, cwd: REPO_ROOT
                });
                child.unref();
                log("Start-Agente.ps1 all lanzado (PID " + child.pid + ")");
                await notify("🏃 <b>Siguiente sprint iniciado</b>\nAgentes arrancando...");
            } catch (e) {
                log("Error arrancando agentes: " + e.message);
                await notify("⚠️ <b>Error arrancando agentes</b>\n" + e.message.substring(0, 200));
            }
        } else {
            log("Start-Agente.ps1 no encontrado");
            await notify("⚠️ <b>Start-Agente.ps1 no encontrado</b>\nLanzar agentes manualmente.");
        }

        // Limpiar ciclo_estado del plan
        try {
            if (fs.existsSync(PLAN_FILE)) {
                const planFinal = JSON.parse(fs.readFileSync(PLAN_FILE, "utf8"));
                delete planFinal.ciclo_estado;
                // #1736: escribir al roadmap, no directo al cache
                try { require("./sprint-data.js").saveRoadmapFromPlan(planFinal, "agent-monitor"); } catch(e) {}
            }
        } catch (e) {}

        log("Fase 3 completada: ciclo sprint→cierre→plan→arranque finalizado");
    }

    // Callback externo (backward compat)
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

// ─── Métricas de participación de agentes ────────────────────────────────────

function loadParticipation() {
    try {
        if (!fs.existsSync(PARTICIPATION_FILE)) return { sprints: [] };
        return JSON.parse(fs.readFileSync(PARTICIPATION_FILE, "utf8"));
    } catch (e) { return { sprints: [] }; }
}

function saveParticipation(data) {
    try { fs.writeFileSync(PARTICIPATION_FILE, JSON.stringify(data, null, 2)); } catch (e) { log("Error saving participation: " + e.message); }
}

/**
 * Registra la participación de agentes del sprint actual en agent-participation.json.
 * Lee agent-metrics.json para ver qué skills fueron invocados en sesiones del sprint.
 * @returns {{ agentsList: string[], coveragePct: number } | null}
 */
function recordSprintParticipation() {
    if (!_plan) return null;

    const sprintId = _plan.sprint_id || ((_plan.started_at || "").split("T")[0]) || new Date().toISOString().split("T")[0];

    // Recopilar skills invocados de todas las sesiones registradas en agent-metrics.json
    const agentsParticipated = new Set();
    try {
        if (fs.existsSync(METRICS_FILE)) {
            const metricsData = JSON.parse(fs.readFileSync(METRICS_FILE, "utf8"));
            for (const sess of (metricsData.sessions || [])) {
                for (const skill of (sess.skills_invoked || [])) {
                    if (ALL_PIPELINE_AGENTS.includes(skill)) {
                        agentsParticipated.add(skill);
                    }
                }
            }
        }
    } catch (e) { log("Error leyendo agent-metrics.json: " + e.message); }

    const agentsList = Array.from(agentsParticipated);
    const coveragePct = Math.round((agentsList.length / ALL_PIPELINE_AGENTS.length) * 100);

    const participation = loadParticipation();
    const existing = participation.sprints.findIndex(s => s.sprint_id === sprintId);
    const record = {
        sprint_id: sprintId,
        fecha_inicio: (_plan.started_at || "").split("T")[0] || null,
        fecha_fin: (_plan.closed_at || "").split("T")[0] || null,
        recorded_at: new Date().toISOString(),
        agents_participated: agentsList,
        agents_total: ALL_PIPELINE_AGENTS.length,
        coverage_pct: coveragePct
    };

    if (existing >= 0) {
        participation.sprints[existing] = record;
    } else {
        participation.sprints.push(record);
    }
    // Mantener solo los últimos 10 sprints
    if (participation.sprints.length > 10) {
        participation.sprints = participation.sprints.slice(-10);
    }

    saveParticipation(participation);
    log("Participación registrada: " + agentsList.length + "/" + ALL_PIPELINE_AGENTS.length + " agentes (" + coveragePct + "%)");
    return { agentsList, coveragePct };
}

/**
 * Alerta via Telegram si algún agente lleva 2+ sprints sin participar.
 */
async function alertInactiveAgents() {
    const participation = loadParticipation();
    if (!participation.sprints || participation.sprints.length < 2) return;

    const lastTwo = participation.sprints.slice(-2);
    const inactiveAgents = ALL_PIPELINE_AGENTS.filter(agent =>
        !lastTwo.some(s => s.agents_participated && s.agents_participated.includes(agent))
    );

    if (inactiveAgents.length > 0) {
        const msg = "⚠️ <b>Agentes inactivos (2+ sprints)</b>\n\n" +
            inactiveAgents.map(a => "• " + a).join("\n") +
            "\n\nEstos agentes no participaron en los últimos 2 sprints. " +
            "Revisar condiciones de activación en el template del Planner.";
        await notify(msg);
        log("Alertados " + inactiveAgents.length + " agentes inactivos: " + inactiveAgents.join(", "));
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

    // Supervisión de PRs: ciclo continuo (#1658)
    _prSupervisionInterval = setInterval(supervisePRs, PR_POLL_INTERVAL_MS);
    _prLastActivity = {};
    log("PR supervision iniciada: polling cada " + (PR_POLL_INTERVAL_MS / 60000) + " min");

    return { watching: !!_pollInterval, guardian: !!_guardianInterval };
}

/**
 * Detener monitoreo.
 */
function stopAgentMonitor() {
    if (_pollInterval) { clearInterval(_pollInterval); _pollInterval = null; }
    if (_guardianInterval) { clearInterval(_guardianInterval); _guardianInterval = null; }
    if (_prSupervisionInterval) { clearInterval(_prSupervisionInterval); _prSupervisionInterval = null; }
    _running = false;
    log("Agent monitor detenido");
}

/**
 * Obtener estado actual.
 */
function getAgentStatus() {
    if (!_plan || !_plan.agentes) return { active: false, agents: [], failed: 0, terminal: 0 };

    const agents = _plan.agentes.map(a => ({
        numero: a.numero,
        issue: a.issue,
        slug: a.slug,
        done: isAgentDone(a),
        status: a.status || "active"  // Campo status: active, stale, failed, queued
    }));

    const elapsed = _startTime ? Math.round((Date.now() - _startTime) / 60000) : 0;
    const doneCount = agents.filter(a => a.done).length;
    const failedCount = agents.filter(a => a.status === "failed").length;
    const terminalCount = failedCount; // Agentes failed se cuentan como terminales

    return {
        active: _running,
        elapsed_min: elapsed,
        total: agents.length,
        done: doneCount,
        agents: agents,
        guardian: !!_guardianInterval,
        watching: !!_pollInterval,
        failed: failedCount,      // Campo failed: número de agentes marcados como failed
        terminal: terminalCount    // Campo terminal: agentes terminales (failed)
    };
}

// ─── Bug 2 fix: promoción automática de _queue (#1266) ───────────────────────

const MAX_CONCURRENT_AGENTS = 2;

/**
 * Cuenta agentes activos en el plan (excluye los con status "queued").
 */
function countActiveAgents(plan) {
    if (!plan || !Array.isArray(plan.agentes)) return 0;
    return plan.agentes.filter(ag => ag.status !== "queued").length;
}

/**
 * Promueve items de _queue (o cola) a agentes respetando MAX_CONCURRENT_AGENTS.
 * Lee el plan fresco del archivo si no se pasa como argumento.
 * Retorna array de agentes promovidos.
 * Persiste los cambios en sprint-plan.json.
 */
function promoteFromQueue(plan) {
    const currentPlan = plan || loadPlan();
    if (!currentPlan) return [];
    const agentes = currentPlan.agentes || [];
    // Usar _queue o cola según cuál esté disponible
    const _queue = Array.isArray(currentPlan._queue) ? currentPlan._queue :
        (Array.isArray(currentPlan.cola) ? currentPlan.cola : []);
    if (_queue.length === 0) return [];

    const activeCount = countActiveAgents(currentPlan);
    const slotsAvailable = Math.max(0, MAX_CONCURRENT_AGENTS - activeCount);
    if (slotsAvailable === 0) return [];

    // Extraer los primeros N items de la cola
    const promoted = _queue.splice(0, slotsAvailable);

    // Actualizar el campo correcto de la cola
    if (Array.isArray(currentPlan._queue)) {
        currentPlan._queue = _queue;
    } else {
        currentPlan.cola = _queue;
    }

    // Asignar número a los promovidos y moverlos a agentes
    const maxNumero = agentes.reduce((m, ag) => Math.max(m, ag.numero || 0), 0);
    promoted.forEach((ag, idx) => {
        ag.numero = maxNumero + idx + 1;
        ag.status = "active";
        agentes.push(ag);
    });
    currentPlan.agentes = agentes;

    // #1736: escribir al roadmap, no directo al cache
    try {
        require("./sprint-data.js").saveRoadmapFromPlan(currentPlan, "agent-monitor");
    } catch (e) {
        log("promoteFromQueue: error escribiendo sprint-plan.json: " + e.message);
    }

    return promoted;
}

/**
 * Mueve un agente del array activo a _completed o _incomplete según validación (#1458).
 * Antes de marcar como completado, verifica PR mergeada y duración mínima.
 * Si la validación falla → marca como "suspicious" en _incomplete[] y NO promueve cola.
 */
function moveToCompleted(plan, issueNumber) {
    if (!plan || !issueNumber) return;
    if (!Array.isArray(plan._completed)) plan._completed = [];
    if (!Array.isArray(plan._incomplete)) plan._incomplete = [];

    const idx = (plan.agentes || []).findIndex(ag => ag.issue === issueNumber);
    if (idx === -1) return;

    const [finished] = plan.agentes.splice(idx, 1);
    finished.completed_at = new Date().toISOString();

    // Validar PR antes de mover a _completed (#1458)
    const branch = "agent/" + finished.issue + "-" + finished.slug;
    let prStatus = { status: "unknown" };
    try { prStatus = checkPRStatusViaGh(branch); } catch (e) {}

    // Calcular duración con cadena de fallbacks (#1779)
    let duracion_min = 0;
    if (finished.started_at) {
        const started = new Date(finished.started_at).getTime();
        if (started && !isNaN(started)) duracion_min = Math.round((Date.now() - started) / 60000);
    }
    // Fallback a agent-registry heartbeat (#1779)
    if (!duracion_min && finished.issue) {
        duracion_min = getDurationFromRegistry(finished.issue);
    }
    // Guard contra NaN (#1779)
    if (isNaN(duracion_min) || duracion_min < 0) duracion_min = 0;

    const validation = validateCompletionCriteria(duracion_min, prStatus, branch);
    if (validation.suspicious) {
        finished.resultado = "suspicious";
        finished.motivo = validation.reason;
        plan._incomplete.push(finished);
        log("moveToCompleted: #" + issueNumber + " → _incomplete SUSPICIOUS: " + validation.reason);
    } else {
        plan._completed.push(finished);
        log("moveToCompleted: #" + issueNumber + " → _completed (PR merged, " + duracion_min + " min)");
    }

    try {
        // #1736: escribir al roadmap, no directo al cache
try { require("./sprint-data.js").saveRoadmapFromPlan(plan, "agent-monitor"); } catch(e) {}
    } catch (e) {
        log("moveToCompleted: error escribiendo sprint-plan.json: " + e.message);
    }
}

/**
 * Lanza agentes promovidos vía Start-Agente.ps1.
 */
function launchAgents(agents) {
    if (!agents || agents.length === 0) return;
    const START_SCRIPT = path.join(REPO_ROOT, "scripts", "Start-Agente.ps1");
    if (!fs.existsSync(START_SCRIPT)) {
        log("launchAgents: Start-Agente.ps1 no encontrado en " + START_SCRIPT);
        return;
    }
    for (const ag of agents) {
        try {
            const ps1 = START_SCRIPT.replace(/\//g, "\\");
            const child = spawn("powershell.exe", ["-NonInteractive", "-File", ps1, String(ag.numero)], {
                detached: true,
                stdio: "ignore",
                windowsHide: false
            });
            child.unref();
            log("launchAgents: lanzado agente #" + ag.issue + " (numero " + ag.numero + ", PID " + child.pid + ")");
        } catch (e) {
            log("launchAgents: error lanzando agente #" + ag.issue + ": " + e.message);
        }
    }
}

/**
 * Lógica principal de chequeo de agentes con promoción automática de cola.
 * Separada de checkAgents para poder ser probada/exportada independientemente.
 */
async function _checkAgentsImpl() {
    const freshPlan = loadPlan();
    if (freshPlan) _plan = freshPlan;

    if (!_plan || !_plan.agentes || _plan.agentes.length === 0) return;

    const agentes = _plan.agentes;
    let doneCount = 0;
    const statusParts = [];

    // Detectar agentes terminados
    const finishedIssues = [];
    for (const a of agentes) {
        if (isAgentDone(a)) {
            doneCount++;
            statusParts.push(a.numero + ":OK");
            finishedIssues.push(a.issue);
        } else {
            statusParts.push(a.numero + ":...");
        }
    }

    const elapsedMin = Math.round((Date.now() - _startTime) / 60000);
    log(doneCount + "/" + agentes.length + " finalizados [" + statusParts.join("  ") + "] (" + elapsedMin + " min)");

    // Mover agentes terminados a _completed y promover cola
    if (finishedIssues.length > 0) {
        const planForMutation = loadPlan();
        if (planForMutation) {
            for (const issue of finishedIssues) {
                moveToCompleted(planForMutation, issue);
            }
            // promoteFromQueue() lee el plan fresco del archivo (ya actualizado por moveToCompleted)
            const promoted = promoteFromQueue();
            _plan = loadPlan() || _plan;

            if (promoted.length > 0) {
                launchAgents(promoted);
                const freshPlanAfter = loadPlan() || _plan;
                const currentQueue = Array.isArray(freshPlanAfter._queue) ? freshPlanAfter._queue :
                    (Array.isArray(freshPlanAfter.cola) ? freshPlanAfter.cola : []);
                const msg = "🚀 <b>Cola de sprint avanzó</b>\n" +
                    "Promovidos: " + promoted.map(ag => "#" + ag.issue + " (" + ag.slug + ")").join(", ") + "\n" +
                    "Cola restante: " + currentQueue.length + "\n" +
                    "Activos: " + countActiveAgents(freshPlanAfter) + "/" + MAX_CONCURRENT_AGENTS;
                await notify(msg);
                return;
            }
        }
    }

    // Verificar si el sprint terminó
    const currentPlan = loadPlan() || _plan;
    const currentQueue = Array.isArray(currentPlan._queue) ? currentPlan._queue :
        (Array.isArray(currentPlan.cola) ? currentPlan.cola : []);
    const allTerminal = (currentPlan.agentes || []).every(ag => isAgentDone(ag));

    if (currentQueue.length === 0 && allTerminal) {
        // Verificar PRs abiertos antes de cerrar el sprint (#1658)
        const openPRs = getOpenAgentPRs();
        const redCIPRs = openPRs.filter(pr => pr.ci === "failure");
        if (redCIPRs.length > 0) {
            persistCicloEstado("ci-pending", {});
            log("_checkAgentsImpl: PRs con CI rojo, esperando auto-reparación: " + redCIPRs.map(p => "#" + p.prNumber).join(", "));
            return;
        }
        if (openPRs.length > 0) {
            persistCicloEstado("merging", {});
            log("_checkAgentsImpl: " + openPRs.length + " PRs abiertos, esperando merge para cerrar sprint");
            return;
        }
        log("Sprint completado: cola vacía y todos los agentes terminados, sin PRs abiertos");
        handleAllDone(elapsedMin);
        return;
    }

    // Failsafe: si pasó mucho tiempo y no hay procesos claude
    if ((Date.now() - _startTime) > FAILSAFE_MS && !isAnyClaude()) {
        const openPRsFail = getOpenAgentPRs();
        if (openPRsFail.length === 0) {
            log("Failsafe: no hay procesos claude activos tras " + elapsedMin + " min. Procediendo.");
            handleAllDone(elapsedMin);
        } else {
            log("Failsafe: no hay procesos claude pero hay " + openPRsFail.length + " PRs abiertos, supervisePRs se encargará");
        }
    }
}

// ─── Detección de timeouts stale/failed (issue #1257) ────────────────────────

/**
 * Obtiene la última actividad registrada para un agente desde activity-log.jsonl.
 */
function getAgentLastActivity(agente) {
    const activityLog = path.join(REPO_ROOT, ".claude", "hooks", "activity-log.jsonl");
    if (!fs.existsSync(activityLog)) return null;

    try {
        const lines = fs.readFileSync(activityLog, "utf8").split("\n").reverse();
        for (const line of lines) {
            if (!line.trim()) continue;
            try {
                const entry = JSON.parse(line);
                // Buscar entry que corresponda al agente (por issue o número)
                if (entry.agent_issue === agente.issue || entry.agent_number === agente.numero) {
                    return entry.timestamp ? new Date(entry.timestamp).getTime() : null;
                }
            } catch (e) {}
        }
    } catch (e) {
        log("Error leyendo activity-log.jsonl: " + e.message);
    }
    return null;
}

/**
 * Verifica si una rama agent/* existe en el repositorio.
 */
function agentBranchExists(agente) {
    try {
        const output = execSync("git branch -a", {
            cwd: REPO_ROOT,
            encoding: "utf8",
            timeout: 5000,
            windowsHide: true
        });
        const branchName = "agent/" + agente.issue + "-" + agente.slug;
        return output.includes(branchName);
    } catch (e) {
        return false;
    }
}

/**
 * Detecta y marca agentes stale/failed basado en inactividad.
 * Retorna objeto { status, staleCount, failedCount }.
 */
async function checkTimeouts(plan) {
    if (!plan || !Array.isArray(plan.agentes)) {
        return { status: null, staleCount: 0, failedCount: 0 };
    }

    const now = Date.now();
    let staleCount = 0;
    let failedCount = 0;
    const changedAgents = [];

    for (const agente of plan.agentes) {
        // Skip agentes que ya son failed
        if (agente.status === "failed") {
            failedCount++;
            continue;
        }

        const lastActivity = getAgentLastActivity(agente);
        const inactiveMs = lastActivity ? (now - lastActivity) : 0;

        // Determinar nuevo status
        const state = { status: agente.status || "active" };
        if (inactiveMs > FAILED_TOTAL_MS) {
            state.status = "failed";
            failedCount++;
            changedAgents.push({ agente, oldStatus: agente.status, newStatus: state.status, inactiveMin: Math.round(inactiveMs / 60000) });
        } else if (inactiveMs > STALE_MS) {
            state.status = "stale";
            staleCount++;
            changedAgents.push({ agente, oldStatus: agente.status, newStatus: state.status, inactiveMin: Math.round(inactiveMs / 60000) });
        }

        // Persistir status en el agente
        agente.status = state.status;
    }

    // Persistir cambios en sprint-plan.json
    if (changedAgents.length > 0) {
        updateSprintPlanStatus(plan);

        // Alertar sobre cambios de status
        for (const change of changedAgents) {
            const msg = (state => {
                if (state.status === "failed") {
                    return "🔴 <b>Agente #" + change.agente.issue + " marcado como FAILED</b>\nInactivo por " + change.inactiveMin + " min";
                }
                return "🟡 <b>Agente #" + change.agente.issue + " marcado como STALE</b>\nInactivo por " + change.inactiveMin + " min";
            })({ status: change.newStatus });
            await notify(msg);
            log("Status change: agente #" + change.agente.issue + " " + change.oldStatus + " → " + change.newStatus);
        }
    }

    return { status: "checked", staleCount, failedCount };
}

/**
 * Persiste los cambios de status de agentes en sprint-plan.json.
 */
function updateSprintPlanStatus(plan) {
    if (!plan || !PLAN_FILE) return;

    try {
        // #1736: escribir al roadmap, no directo al cache
try { require("./sprint-data.js").saveRoadmapFromPlan(plan, "agent-monitor"); } catch(e) {}
        log("Sprint plan status actualizado: " + plan.agentes.map(a => a.numero + ":" + a.status).join(" "));
    } catch (e) {
        log("Error actualizando sprint-plan.json: " + e.message);
    }
}

// ─── API pública (actualizada) ────────────────────────────────────────────────

module.exports = {
    startAgentMonitor, stopAgentMonitor, getAgentStatus,
    recordSprintParticipation, alertInactiveAgents,
    ALL_PIPELINE_AGENTS,
    promoteFromQueue, countActiveAgents, moveToCompleted, launchAgents,
    MAX_CONCURRENT_AGENTS, _checkAgentsImpl,
    checkTimeouts, updateSprintPlanStatus, agentBranchExists,
    STALE_MS, FAILED_TOTAL_MS,
    // #1658 — ciclo continuo
    getOpenAgentPRs, getPRCiStatus, prHasQaLabel,
    persistCicloEstado, supervisePRs
};
