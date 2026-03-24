// agent-watcher.js — Watcher externo para promoción automática de agentes
// desde _queue[] cuando agentes en worktrees terminan (#1441, #1522)
//
// Problema que resuelve:
//   agent-concurrency-check.js solo se dispara cuando el hook Stop corre en el
//   proceso que termina (el worktree del agente). Cuando un agente en un worktree
//   termina, su Stop hook no ve los otros agentes ni puede promover de _queue[].
//   Este watcher corre independientemente, monitorea todos los agentes y actúa.
//
// #1522 — Reconciliación atómica:
//   Cada ciclo verifica agentes en status="promoted" sin _pid por más de 60s.
//   Si detecta uno, lo relanza (max 3 reintentos). Si falla, lo mueve a _incomplete.
//   Esto elimina los "agentes fantasma" que aparecen en el plan pero nunca arrancaron.
//
// Ejecución: node agent-watcher.js (proceso background)
// Lanzado por: Start-Agente.ps1 all
// Lock file: .claude/hooks/agent-watcher.pid
// Log: .claude/hooks/agent-watcher.log
// Configuración: WATCHER_POLL_INTERVAL (ms, default 120000)
"use strict";

const fs = require("fs");
const path = require("path");
const { execFile, execSync } = require("child_process");

// ─── Paths ────────────────────────────────────────────────────────────────────

function resolveMainRepoRoot() {
    const envRoot = process.env.CLAUDE_PROJECT_DIR || "C:\\Workspaces\\Intrale\\platform";
    try {
        const output = execSync("git worktree list", {
            encoding: "utf8", cwd: envRoot, timeout: 5000, windowsHide: true
        });
        const firstLine = output.split("\n")[0] || "";
        const match = firstLine.match(/^(.+?)\s+[0-9a-f]{5,}/);
        if (match) {
            return match[1].trim().replace(/^\/([a-z])\//, "$1:\\").replace(/\//g, "\\");
        }
    } catch (e) {}
    return envRoot;
}

const REPO_ROOT = resolveMainRepoRoot();
const HOOKS_DIR = path.join(REPO_ROOT, ".claude", "hooks");
const SCRIPTS_DIR = path.join(REPO_ROOT, "scripts");
const PLAN_FILE = path.join(SCRIPTS_DIR, "sprint-plan.json");
const PIDS_FILE = path.join(SCRIPTS_DIR, "sprint-pids.json");
// LOCK_FILE eliminado: sprint-plan.json es ahora cache read-only (#1736)
const PID_FILE = path.join(HOOKS_DIR, "agent-watcher.pid");
const LOG_FILE = path.join(HOOKS_DIR, "agent-watcher.log");
const START_SCRIPT = path.join(SCRIPTS_DIR, "Start-Agente.ps1");
const SESSIONS_DIR = path.join(REPO_ROOT, ".claude", "sessions");
const WORKTREES_PARENT = path.dirname(REPO_ROOT);
const SKILLS_TIMEOUT_FILE = path.join(HOOKS_DIR, "skills-timeout.json"); // #1753


// Sprint data access (roadmap como fuente de verdad, #1736)
let _sprintDataModule = null;
function getSprintData() {
    if (!_sprintDataModule) _sprintDataModule = require("./sprint-data");
    return _sprintDataModule;
}
const POLL_INTERVAL_MS = parseInt(process.env.WATCHER_POLL_INTERVAL || "120000", 10); // #1522: 2 min para reconciliación
const GRACE_PERIOD_MIN = parseInt(process.env.WATCHER_GRACE_PERIOD_MIN || "15", 10); // #1553: grace period antes de evaluar PR
// LOCK_TIMEOUT_MS eliminado (#1736)
// LOCK_RETRY_MS eliminado (#1736)
const DEFAULT_CONCURRENCY_LIMIT = 3;
const MAX_RETRIES = 3; // Límite de reintentos para agentes que nunca trabajaron (#1498)

// ─── Logging ──────────────────────────────────────────────────────────────────

function log(msg) {
    const line = "[" + new Date().toISOString() + "] Watcher: " + msg + "\n";
    try { fs.appendFileSync(LOG_FILE, line); } catch (e) {}
    process.stdout.write(line);
}

// ─── Lock file (singleton — prevenir watchers duplicados) ─────────────────────

function checkSingleInstance() {
    try {
        if (fs.existsSync(PID_FILE)) {
            const content = fs.readFileSync(PID_FILE, "utf8").trim();
            const existingPid = parseInt(content, 10);
            if (existingPid && existingPid !== process.pid) {
                if (isPidAlive(existingPid)) {
                    log("Ya existe un watcher activo (PID " + existingPid + ") — abortando");
                    process.exit(0);
                }
                log("PID file stale (PID " + existingPid + " muerto) — tomando control");
            }
        }
    } catch (e) {
        log("WARN: Error leyendo PID file: " + e.message);
    }
    try {
        fs.writeFileSync(PID_FILE, String(process.pid), "utf8");
    } catch (e) {
        log("WARN: No se pudo escribir PID file: " + e.message);
    }
}

// Limpiar PID file al salir (solo si es el nuestro)
function cleanupPidFile() {
    try {
        const content = fs.readFileSync(PID_FILE, "utf8").trim();
        if (parseInt(content, 10) === process.pid) {
            fs.unlinkSync(PID_FILE);
        }
    } catch (e) {}
}

process.on("exit", cleanupPidFile);

// ─── Helpers de proceso ───────────────────────────────────────────────────────

/** Verifica si un PID está vivo usando tasklist (más confiable en Windows) */
function isPidAlive(pid) {
    if (!pid) return false;
    const numPid = parseInt(pid, 10);
    if (!numPid) return false;
    try {
        const out = execSync(
            'tasklist /FI "PID eq ' + numPid + '" /FO CSV /NH',
            { timeout: 3000, windowsHide: true, encoding: "utf8" }
        );
        return out.indexOf(String(numPid)) !== -1;
    } catch (e) {
        // Fallback: process.kill con señal 0 (solo para procesos del mismo usuario)
        try { process.kill(numPid, 0); return true; } catch (ke) { return ke.code === "EPERM"; }
    }
}

/**
 * Verifica si un PID corresponde a un proceso claude.exe o node.exe.
 * Previene falsos positivos por reutilización de PIDs en Windows (#1499).
 * En Windows los PIDs se reciclan rápidamente y un PID antiguo de un agente
 * muerto puede ser reasignado a un proceso no relacionado (ej: OpenConsole.exe).
 */
function isClaudeProcess(pid) {
    if (!pid) return false;
    const numPid = parseInt(pid, 10);
    if (!numPid) return false;
    try {
        const out = execSync(
            'tasklist /FI "PID eq ' + numPid + '" /FO CSV /NH',
            { timeout: 3000, windowsHide: true, encoding: "utf8" }
        ).toLowerCase();
        return out.includes("claude.exe") || out.includes("node.exe");
    } catch (e) {
        return false;
    }
}

// ─── Helpers de plan ──────────────────────────────────────────────────────────

function loadPlan() {
    try {
        if (!fs.existsSync(PLAN_FILE)) {
            log("sprint-plan.json no encontrado — regenerando desde roadmap.json (#1736)");
            try {
                var sd = getSprintData();
                var rm = sd.readRoadmap();
                if (rm) sd.generateSprintPlanCache(rm);
            } catch(e) { log("regenerar sprint-plan error: " + e.message); }
        }
        if (!fs.existsSync(PLAN_FILE)) return null;
        return JSON.parse(fs.readFileSync(PLAN_FILE, "utf8"));
    } catch (e) {
        log("loadPlan error: " + e.message);
        return null;
    }
}

function savePlan(plan) {
    // Persistir en roadmap.json — fuente de verdad (#1736)
    // sprint-plan.json se regenera automaticamente por sprint-data.writeRoadmap()
    try {
        getSprintData().saveRoadmapFromPlan(plan, "agent-watcher");
    } catch(e) {
        log("savePlan (roadmap) error: " + e.message);
    }
}

// acquireLock eliminado: sprint-plan.json es cache read-only (#1736)
// releaseLock eliminado: sprint-plan.json es cache read-only (#1736)
function getQueue(plan) {
    if (Array.isArray(plan._queue) && plan._queue.length > 0) return plan._queue;
    if (Array.isArray(plan.cola) && plan.cola.length > 0) return plan.cola;
    return [];
}

function setQueue(plan, newQueue) {
    if (Array.isArray(plan._queue)) plan._queue = newQueue;
    else plan.cola = newQueue;
}

function getExpectedWorktreePath(agente) {
    return path.join(WORKTREES_PARENT, path.basename(REPO_ROOT) + ".agent-" + agente.issue + "-" + agente.slug);
}

function escHtml(str) {
    return (str || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ─── Telegram ─────────────────────────────────────────────────────────────────

let tgClient = null;
try { tgClient = require("./telegram-client"); } catch (e) {}

// Diagnostico de causa de muerte de agentes (#1749)
let retryDiagnostics = null;
try { retryDiagnostics = require("./agent-retry-diagnostics"); } catch (e) { log("agent-retry-diagnostics no disponible: " + e.message); }

// Recovery inteligente: diagnostico + acciones correctivas antes de relanzar
let agentDoctor = null;
try { agentDoctor = require("./agent-doctor"); } catch (e) { log("agent-doctor no disponible: " + e.message); }

// Validación centralizada de completación (#1458)
const { buildCompletedEntry, validateCompletionCriteria, MIN_DURATION_MINUTES } = require("./validation-utils");

async function notify(text) {
    if (tgClient) {
        try { await tgClient.sendMessage(text); return; } catch (e) { log("tgClient error: " + e.message); }
    }
    // Fallback: HTTP directo
    try {
        const cfg = JSON.parse(fs.readFileSync(path.join(HOOKS_DIR, "telegram-config.json"), "utf8"));
        const https = require("https");
        const querystring = require("querystring");
        const postData = querystring.stringify({ chat_id: cfg.chat_id, text, parse_mode: "HTML" });
        await new Promise((resolve) => {
            const req = https.request({
                hostname: "api.telegram.org",
                path: "/bot" + cfg.bot_token + "/sendMessage",
                method: "POST",
                headers: { "Content-Type": "application/x-www-form-urlencoded" },
                timeout: 6000
            }, (res) => { res.resume(); resolve(); });
            req.on("error", resolve);
            req.on("timeout", () => { req.destroy(); resolve(); });
            req.write(postData);
            req.end();
        });
    } catch (e) { log("notify error: " + e.message); }
}

// ─── Verificación de PR ───────────────────────────────────────────────────────

let _ghCmd = null;

function findGhCli() {
    if (_ghCmd) return _ghCmd;
    for (const candidate of ["C:\\Workspaces\\gh-cli\\bin\\gh.exe", "gh"]) {
        try {
            execSync('"' + candidate + '" --version', { encoding: "utf8", timeout: 3000, windowsHide: true });
            _ghCmd = candidate;
            return _ghCmd;
        } catch (e) {}
    }
    return null;
}

function checkPRStatus(branch) {
    const ghCmd = findGhCli();
    if (!ghCmd) {
        log("checkPRStatus: gh CLI no encontrado");
        return { status: "unknown" };
    }
    try {
        const cmd = '"' + ghCmd + '" pr list --repo intrale/platform --head "' + branch + '" --state all --json number,state';
        const output = execSync(cmd, { encoding: "utf8", timeout: 15000, windowsHide: true });
        const prs = JSON.parse(output || "[]");
        if (!Array.isArray(prs) || prs.length === 0) return { status: "none", prs: [] };
        if (prs.find(pr => pr.state === "MERGED")) return { status: "merged", prs };
        if (prs.find(pr => pr.state === "OPEN"))   return { status: "open", prs };
        return { status: "closed_no_merge", prs };
    } catch (e) {
        log("checkPRStatus error: " + e.message);
        return { status: "unknown" };
    }
}

// ─── Detección de liveness de agentes ────────────────────────────────────────

function loadSprintPids() {
    try {
        if (!fs.existsSync(PIDS_FILE)) return {};
        return JSON.parse(fs.readFileSync(PIDS_FILE, "utf8"));
    } catch (e) { return {}; }
}

/**
 * Determina si un agente sigue vivo.
 * Métodos (en orden de prioridad):
 *  0. _pid en sprint-plan.json (co-ubicado con el agente, actualizado en cada relanzamiento)
 *  1. PID file por agente: .claude/hooks/agent-<issue>.pid (#1499)
 *  2. PID en sprint-pids.json → tasklist con verificación de nombre de proceso
 *  3. Sesión activa en .claude/sessions/ con status "active" + PID vivo
 *  4. Sin evidencia de actividad → asumir muerto (fail-safe para promover)
 *
 * La verificación de nombre de proceso (isClaudeProcess) previene falsos positivos
 * causados por la reutilización de PIDs en Windows (#1499).
 */
function isAgentAlive(agente) {
    // Método 0: _pid en el objeto agente (sprint-plan.json)
    if (agente._pid) {
        const isC = isClaudeProcess(agente._pid);
        log("isAgentAlive #" + agente.issue + ": _pid " + agente._pid + " → " + (isC ? "vivo (claude/node)" : "muerto o PID reusado"));
        if (isC) return true;
        // _pid stale o reusado — continuar con siguientes métodos
    }

    // Método 1: PID file por agente (.claude/hooks/agent-<issue>.pid)
    const agentPidFile = path.join(HOOKS_DIR, "agent-" + agente.issue + ".pid");
    if (fs.existsSync(agentPidFile)) {
        try {
            const filePid = parseInt(fs.readFileSync(agentPidFile, "utf8").trim(), 10);
            if (filePid) {
                const isC = isClaudeProcess(filePid);
                log("isAgentAlive #" + agente.issue + ": PID file " + filePid + " → " + (isC ? "vivo (claude/node)" : "muerto o PID reusado"));
                if (isC) {
                    agente._pid = filePid; // sincronizar _pid con valor actual
                    return true;
                }
            }
        } catch (e) { log("isAgentAlive #" + agente.issue + ": error leyendo PID file: " + e.message); }
    }

    // Método 2: PID desde sprint-pids.json con verificación de nombre de proceso
    const pids = loadSprintPids();
    const pidKey = "agente_" + agente.numero;
    const pid = pids[pidKey];
    if (pid) {
        const alive = isPidAlive(pid);
        if (alive) {
            const isC = isClaudeProcess(pid);
            if (isC) {
                log("isAgentAlive #" + agente.issue + ": PID " + pid + " → vivo (claude/node)");
                agente._pid = pid; // sincronizar _pid para futuras consultas
                return true;
            }
            // PID existe pero es otro proceso (Windows PID reuse) → falso positivo
            log("isAgentAlive #" + agente.issue + ": PID " + pid + " vivo pero NO es claude/node (PID reusado) → muerto");
            return false;
        }
        log("isAgentAlive #" + agente.issue + ": PID " + pid + " → muerto");
        return false;
    }

    // Método 3: sesión activa en .claude/sessions/
    try {
        if (fs.existsSync(SESSIONS_DIR)) {
            const branch = "agent/" + agente.issue + "-" + agente.slug;
            const files = fs.readdirSync(SESSIONS_DIR).filter(f => f.endsWith(".json"));
            for (const file of files) {
                try {
                    const session = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, file), "utf8"));
                    if (session.branch !== branch) continue;
                    if (session.status === "done") {
                        log("isAgentAlive #" + agente.issue + ": sesión status=done → muerto");
                        return false;
                    }
                    if (session.status === "active") {
                        const sessionPid = session.pid || session.claude_pid;
                        if (sessionPid) {
                            const isC = isClaudeProcess(sessionPid);
                            log("isAgentAlive #" + agente.issue + ": sesión activa, PID " + sessionPid + " → " + (isC ? "vivo (claude/node)" : "muerto o PID reusado"));
                            if (isC) {
                                agente._pid = sessionPid; // sincronizar _pid
                                return true;
                            }
                            return false;
                        }
                        log("isAgentAlive #" + agente.issue + ": sesión activa sin PID → asumiendo vivo");
                        return true;
                    }
                } catch (e) {}
            }
        }
    } catch (e) { log("isAgentAlive sessions error: " + e.message); }

    // Sin evidencia: no hay PID ni sesión → no podemos confirmar que esté vivo
    // Verificar worktree como última referencia (si ni siquiera existe, definitivamente muerto)
    const worktreePath = getExpectedWorktreePath(agente);
    if (!fs.existsSync(worktreePath)) {
        log("isAgentAlive #" + agente.issue + ": sin PID, sin sesión, sin worktree → muerto");
        return false;
    }

    log("isAgentAlive #" + agente.issue + ": sin PID, sin sesión, worktree existe → indeterminado (asumiendo vivo)");
    return true; // conservador: si el worktree existe pero no tenemos más info, no matar el slot
}

// ─── Prompt por defecto ───────────────────────────────────────────────────────

function generateDefaultPrompt(issue, slug) {
    return (
        "Implementar issue #" + issue + ". " +
        "Leer el issue completo con: gh issue view " + issue + " --repo intrale/platform. " +
        "Al iniciar: invocar /ops para verificar estado del entorno. " +
        "Al iniciar: invocar /po para revisar criterios de aceptación del issue #" + issue + ". " +
        "Si el issue menciona libs, patrones o frameworks nuevos: invocar /guru para investigación técnica. " +
        "Completar los cambios descritos en el body del issue. " +
        "Antes de /delivery: invocar /tester para verificar que los tests pasan. " +
        "Antes de /delivery: invocar /builder para validar que el build no está roto. " +
        "Antes de /delivery: invocar /security para validar seguridad del diff. " +
        "Antes de /delivery: invocar /review para validar el diff. " +
        "Usar /delivery para commit+PR al terminar. Closes #" + issue
    );
}

// ─── Lanzar agente directamente via Node.js (#1756) ─────────────────────────
// Fix: reemplazar cadena execFile(PowerShell) → Start-Agente.ps1 → Start-Process
// por lanzamiento directo: setupWorktree() + spawn(node, agent-runner.js)
// La cadena anterior fallaba silenciosamente porque Start-Agente.ps1 crasheaba
// al no encontrar cmd.exe en el entorno del watcher (ENOENT).

const AGENT_RUNNER = path.join(SCRIPTS_DIR, "pipeline", "agent-runner.js");
const GH_CLI_PATH = "C:\\Workspaces\\gh-cli\\bin";
const JAVA_HOME_PATH = "C:\\Users\\Administrator\\.jdks\\temurin-21.0.7";

function setupWorktree(agente) {
    const wtName = "platform.agent-" + agente.issue + "-" + agente.slug;
    const wtDir = path.join(path.dirname(REPO_ROOT), wtName);
    const branch = "agent/" + agente.issue + "-" + agente.slug;

    // Si worktree existe, limpiar primero
    if (fs.existsSync(wtDir)) {
        log("setupWorktree: limpiando worktree existente " + wtName);
        // Eliminar .claude/ (puede ser directorio real o junction)
        const claudeDir = path.join(wtDir, ".claude");
        if (fs.existsSync(claudeDir)) {
            try { fs.rmSync(claudeDir, { recursive: true, force: true }); } catch (e) {}
        }
        try {
            execSync("git worktree remove " + JSON.stringify(wtDir.replace(/\\/g, "/")) + " --force", {
                encoding: "utf8", timeout: 15000, windowsHide: true
            });
        } catch (e) {}
        // Fallback: eliminar directorio si persiste
        if (fs.existsSync(wtDir)) {
            try { fs.rmSync(wtDir, { recursive: true, force: true }); } catch (e) {}
        }
        try { execSync("git worktree prune", { timeout: 5000, windowsHide: true }); } catch (e) {}
    }

    // Eliminar rama local si existe (para poder recrear desde origin/main)
    try { execSync("git branch -D " + JSON.stringify(branch), { timeout: 5000, windowsHide: true, stdio: "ignore" }); } catch (e) {}

    // Crear worktree desde origin/main
    const relPath = "../" + wtName;
    log("setupWorktree: git worktree add " + relPath + " -b " + branch);
    execSync("git worktree add " + JSON.stringify(relPath) + " -b " + JSON.stringify(branch) + " origin/main", {
        encoding: "utf8", timeout: 30000, windowsHide: true, cwd: REPO_ROOT
    });

    if (!fs.existsSync(path.join(wtDir, ".git"))) {
        throw new Error("Worktree creado pero .git no existe en " + wtDir);
    }

    // Copiar .claude/ del repo principal
    const claudeSrc = path.join(REPO_ROOT, ".claude");
    const claudeDst = path.join(wtDir, ".claude");
    fs.cpSync(claudeSrc, claudeDst, { recursive: true, force: true });
    log("setupWorktree: .claude/ copiado (" + fs.readdirSync(claudeDst).length + " entries)");

    // Limpiar archivos stale del worktree
    const staleFiles = ["agent-done.json", "claude_err.txt", "claude_err2.txt"];
    for (const f of staleFiles) {
        const fp = path.join(wtDir, f);
        if (fs.existsSync(fp)) {
            try { fs.unlinkSync(fp); log("setupWorktree: limpiado " + f); } catch (e) {}
        }
    }

    return wtDir;
}

// S3+S5+S6: Circuit breaker, resource check, git-aware verification
let circuitBreaker;
try { circuitBreaker = require("./circuit-breaker"); } catch (_) { circuitBreaker = null; }
let systemHealth;
try { systemHealth = require("./system-health"); } catch (_) { systemHealth = null; }

function launchAgent(agente) {
    try {
        // S3: Circuit breaker check — prevenir loops de reintento
        if (circuitBreaker) {
            const cbResult = circuitBreaker.canRelaunch(String(agente.issue));
            if (!cbResult.allowed) {
                log("launchAgent: BLOQUEADO por circuit breaker para #" + agente.issue + " — " + cbResult.reason);
                return false;
            }
        }

        // S5: Resource check — verificar recursos disponibles
        if (systemHealth) {
            const resCheck = systemHealth.canLaunchAgent();
            if (!resCheck.canLaunch) {
                log("launchAgent: BLOQUEADO por recursos insuficientes — " + resCheck.issues.join(", "));
                return false;
            }
        }

        // S6: Git-aware check — verificar que REPO_ROOT es un git repo valido
        if (systemHealth && !systemHealth.isValidGitRepo(REPO_ROOT)) {
            log("launchAgent: BLOQUEADO — REPO_ROOT no es un git repo valido: " + REPO_ROOT);
            return false;
        }

        if (!agente.prompt) {
            agente.prompt = generateDefaultPrompt(agente.issue, agente.slug);
        }

        // Paso 1: Setup worktree (o reusar existente si _reuse_worktree=true, #1749)
        let wtDir;
        if (agente._reuse_worktree) {
            wtDir = getExpectedWorktreePath(agente);
            if (!fs.existsSync(path.join(wtDir, ".git"))) {
                log("launchAgent: _reuse_worktree=true pero worktree no existe en " + wtDir + " -- recreando");
                agente._reuse_worktree = false;
            } else {
                log("launchAgent: reutilizando worktree existente " + path.basename(wtDir));
            }
        }
        if (!agente._reuse_worktree) {
            try {
                wtDir = setupWorktree(agente);
            } catch (e) {
                log("launchAgent: setupWorktree fallo para #" + agente.issue + ": " + e.message);
                return false;
            }
        }

        // Paso 2: Escribir prompt
        const logsDir = path.join(SCRIPTS_DIR, "logs");
        try { if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true }); } catch (e) {}
        const promptFile = path.join(logsDir, "prompt_" + agente.numero + ".txt");
        fs.writeFileSync(promptFile, agente.prompt, "utf8");

        // Paso 3: Preparar log files
        const spawnLogPath = path.join(logsDir, "watcher_spawn_" + agente.numero + ".log");
        const spawnErrPath = path.join(logsDir, "watcher_spawn_" + agente.numero + ".err");
        const logFd = fs.openSync(spawnLogPath, "w");
        const errFd = fs.openSync(spawnErrPath, "w");

        // Paso 4: Obtener GH_TOKEN
        let ghToken = process.env.GH_TOKEN || "";
        if (!ghToken || ghToken.length < 10) {
            try {
                const cred = execSync(
                    'printf "protocol=https\\nhost=github.com\\n" | git credential fill',
                    { encoding: "utf8", timeout: 5000, windowsHide: true }
                );
                const match = cred.match(/password=(.+)/);
                if (match) ghToken = match[1].trim();
            } catch (e) {}
        }

        // Paso 5: Lanzar agent-runner.js directamente como proceso Node.js detached
        const agentModel = agente.model || "sonnet";
        const branch = "agent/" + agente.issue + "-" + agente.slug;

        const runnerArgs = [
            AGENT_RUNNER,
            "--workdir", wtDir,
            "--prompt-file", promptFile,
            "--model", agentModel,
            "--issue", String(agente.issue),
            "--agent-num", String(agente.numero),
            "--slug", agente.slug,
            "--branch", branch,
            "--log-file", path.join(logsDir, "agente_" + agente.numero + ".log")
        ];

        // Entorno completo con PATH extendido, JAVA_HOME y GH_TOKEN
        const envPath = (process.env.PATH || "") + ";" + GH_CLI_PATH + ";" + path.join(JAVA_HOME_PATH, "bin");
        const childEnv = Object.assign({}, process.env, {
            PATH: envPath,
            JAVA_HOME: JAVA_HOME_PATH,
            GH_TOKEN: ghToken,
            CLAUDE_PROJECT_DIR: wtDir,
        });

        log("launchAgent: spawn node agent-runner.js (model=" + agentModel + ", worktree=" + path.basename(wtDir) + ")");

        const { spawn: nodeSpawn } = require("child_process");
        const child = nodeSpawn("node", runnerArgs, {
            detached: true,
            stdio: ["ignore", logFd, errFd],
            env: childEnv,
            cwd: wtDir,
            windowsHide: false,
        });
        child.unref();
        fs.closeSync(logFd);
        fs.closeSync(errFd);

        const childPid = child.pid;
        log("Agente #" + agente.issue + " lanzado (PID=" + childPid + ", runner directo)");

        if (childPid) {
            agente._pid = childPid;
            const agentPidFile = path.join(HOOKS_DIR, "agent-" + agente.issue + ".pid");
            try {
                fs.writeFileSync(agentPidFile, String(childPid), "utf8");
                log("PID " + childPid + " guardado en " + path.basename(agentPidFile));
            } catch (pidErr) {
                log("WARN: No se pudo escribir PID file: " + pidErr.message);
            }
        }

        return childPid || true;
    } catch (e) {
        log("launchAgent error: " + e.message);
        return false;
    }
}

// ─── Project V2 ──────────────────────────────────────────────────────────────

let projectUtils = null;
try { projectUtils = require("./project-utils"); } catch (e) {
    log("project-utils no disponible (Project V2 updates deshabilitados)");
}

async function updateProjectV2(issue, statusName) {
    if (!projectUtils) return;
    try {
        const token = projectUtils.getGitHubToken();
        const statusId = projectUtils.STATUS_OPTIONS[statusName];
        if (!statusId) { log("Status V2 desconocido: " + statusName); return; }
        await projectUtils.addAndSetStatus(token, issue, statusId);
        log("Project V2: #" + issue + " → " + statusName);
    } catch (e) {
        log("updateProjectV2 error para #" + issue + ": " + e.message);
    }
}

// buildCompletedEntry: importado desde validation-utils (#1458)
// La versión local fue eliminada — usar buildCompletedEntry(agente, null, resultado) desde el módulo compartido.


// ─── Skill Timeout Detection (#1753) ─────────────────────────────────────────
//
// Detecta agentes con PID vivo pero heartbeat estancado (skill colgado).
// Carga la configuracion desde skills-timeout.json y mata el proceso si el
// agente supera el timeout del skill activo. El ciclo siguiente de reconciliacion
// detecta el PID muerto y aplica la logica de retry existente (MAX_RETRIES).

function loadSkillsTimeout() {
    try {
        if (fs.existsSync(SKILLS_TIMEOUT_FILE)) {
            const cfg = JSON.parse(fs.readFileSync(SKILLS_TIMEOUT_FILE, "utf8"));
            return cfg;
        }
    } catch (e) {
        log("loadSkillsTimeout: error leyendo config — usando defaults: " + e.message);
    }
    return { default: 10, qa: 30 };
}

function getCurrentSkillFromSession(agente) {
    try {
        if (!fs.existsSync(SESSIONS_DIR)) return null;
        const branch = "agent/" + agente.issue + "-" + (agente.slug || "");
        const files = fs.readdirSync(SESSIONS_DIR).filter(function(f) { return f.endsWith(".json"); });
        for (const file of files) {
            try {
                const session = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, file), "utf8"));
                if (session.branch !== branch) continue;
                if (session.status === "done") continue;
                const skills = session.skills_invoked || [];
                if (skills.length === 0) return null;
                const lastSkill = skills[skills.length - 1];
                return lastSkill.replace(/^\//, "");
            } catch (e) {}
        }
    } catch (e) {
        log("getCurrentSkillFromSession #" + agente.issue + ": " + e.message);
    }
    return null;
}

function killProcess(pid) {
    try {
        execSync("taskkill /F /PID " + parseInt(pid, 10), { timeout: 5000, windowsHide: true, stdio: "ignore" });
        return true;
    } catch (e) {
        return !isPidAlive(pid);
    }
}

const _timeoutAlertedAt = new Map();
const TIMEOUT_ALERT_COOLDOWN_MS = 5 * 60 * 1000;

async function runSkillTimeoutCheck() {
    const plan = loadPlan();
    if (!plan) return;
    if (plan.sprint_cerrado) return;
    const estado = plan.estado || plan.status;
    if (estado && estado !== "activo" && estado !== "active") return;

    const activeAgents = (plan.agentes || []).filter(function(ag) {
        return ag.status !== "waiting" && ag.status !== "promoted";
    });
    if (activeAgents.length === 0) return;

    let registry = { agents: {} };
    try {
        const regFile = path.join(HOOKS_DIR, "agent-registry.json");
        if (fs.existsSync(regFile)) {
            registry = JSON.parse(fs.readFileSync(regFile, "utf8"));
        }
    } catch (e) {
        log("runSkillTimeoutCheck: error leyendo registry: " + e.message);
        return;
    }

    const timeoutCfg = loadSkillsTimeout();
    const DEFAULT_TIMEOUT_MIN = timeoutCfg.default || 10;
    const now = Date.now();

    for (const ag of activeAgents) {
        const pid = ag._pid;
        if (!pid || !isClaudeProcess(pid)) continue;

        const branch = "agent/" + ag.issue + "-" + (ag.slug || "");
        let registryEntry = null;
        for (const entry of Object.values(registry.agents || {})) {
            if (entry.branch === branch && entry.status === "active") {
                registryEntry = entry;
                break;
            }
        }
        if (!registryEntry || !registryEntry.last_heartbeat) continue;

        const lastHb = new Date(registryEntry.last_heartbeat).getTime();
        if (isNaN(lastHb)) continue;

        const currentSkill = getCurrentSkillFromSession(ag);
        if (!currentSkill) continue;

        const timeoutMin = timeoutCfg[currentSkill] !== undefined
            ? timeoutCfg[currentSkill]
            : DEFAULT_TIMEOUT_MIN;
        const elapsedMin = (now - lastHb) / 60000;

        if (elapsedMin < timeoutMin) continue;

        const lastAlert = _timeoutAlertedAt.get(ag.issue) || 0;
        if (now - lastAlert < TIMEOUT_ALERT_COOLDOWN_MS) {
            log("SkillTimeout: #" + ag.issue + " colgado en " + currentSkill + " (cooldown activo)");
            continue;
        }
        _timeoutAlertedAt.set(ag.issue, now);

        const retryCount = ag._retry_count || 0;
        log("SkillTimeout: #" + ag.issue + " — skill=" + currentSkill +
            " · elapsed=" + Math.round(elapsedMin) + "min" +
            " · timeout=" + timeoutMin + "min" +
            " · retry=" + retryCount + "/" + MAX_RETRIES +
            " — matando PID " + pid);

        const killed = killProcess(pid);
        log("SkillTimeout: #" + ag.issue + " PID " + pid + " → " + (killed ? "terminado" : "no se pudo terminar"));

        try {
            const freshPlan = loadPlan();
            if (freshPlan && Array.isArray(freshPlan.agentes)) {
                const planAg = freshPlan.agentes.find(function(a) { return a.issue === ag.issue; });
                if (planAg) {
                    planAg._skill_at_timeout = currentSkill;
                    planAg._timeout_elapsed_min = Math.round(elapsedMin);
                    planAg._pid = null;
                    savePlan(freshPlan);
                    log("SkillTimeout: plan actualizado para #" + ag.issue + " (_skill_at_timeout=" + currentSkill + ")");
                }
            }
        } catch (e) {
            log("SkillTimeout: error actualizando plan: " + e.message);
        }

        await notify(
            "⏱️ <b>Agente #" + ag.issue + ": skill colgado — timeout</b>\n" +
            "Skill: <code>" + currentSkill + "</code> · Inactivo: " + Math.round(elapsedMin) + " min\n" +
            "Timeout configurado: " + timeoutMin + " min\n" +
            "PID " + pid + " terminado · Reintento " + (retryCount + 1) + "/" + MAX_RETRIES + " en próximo ciclo"
        );
    }
}

// ─── Health Check (lectura pura, ignora _lock_until) ──────────────
//
// FASE 1 del ciclo: verifica PIDs de agentes activos y alerta por Telegram si
// alguno murió, SIN modificar el plan en disco. Ignora completamente _lock_until
// porque no escribe nada.
//
// Garantiza detección temprana incluso cuando Start-Agente.ps1 tiene el plan
// bloqueado (SPR-044/SPR-045: agentes murieron sin detección durante _lock_until).

const _healthAlertedAt = new Map(); // issue → timestamp ms (cooldown anti-spam)
const HEALTH_ALERT_COOLDOWN_MS = 10 * 60 * 1000; // 10 min entre alertas por agente

async function runHealthCheck() {
    const plan = loadPlan();
    if (!plan) return;
    if (plan.sprint_cerrado) return;
    const estado = plan.estado || plan.status;
    if (estado && estado !== "activo" && estado !== "active") return;

    const activeAgents = (plan.agentes || []).filter(ag => ag.status !== "waiting");
    if (activeAgents.length === 0) return;

    const now = Date.now();
    for (const ag of activeAgents) {
        let alive;
        try { alive = isAgentAlive(ag); } catch (e) {
            log("HealthCheck: error verificando #" + ag.issue + ": " + e.message);
            continue;
        }
        if (alive) continue;

        // Cooldown: no spamear Telegram si ya alertamos recientemente
        const lastAlert = _healthAlertedAt.get(ag.issue) || 0;
        if (now - lastAlert < HEALTH_ALERT_COOLDOWN_MS) {
            log("HealthCheck: #" + ag.issue + " muerto (alerta enviada hace " +
                Math.round((now - lastAlert) / 60000) + " min — cooldown activo)");
            continue;
        }

        _healthAlertedAt.set(ag.issue, now);
        log("HealthCheck: agente #" + ag.issue + " muerto — enviando alerta (read-only, sin modificar plan)");
        await notify(
            "💀 <b>Agente #" + ag.issue + " muerto (health check)</b>\n" +
            "Slug: " + escHtml(ag.slug) + "\n" +
            "<i>Reconciliación pendiente en próximo ciclo…</i>"
        );
    }
}

// ─── Ciclo principal ──────────────────────────────────────────────────────────

async function runCycle() {
    // FASE 1.5: Skill timeout check (#1753)
    try { await runSkillTimeoutCheck(); } catch (e) {
        log("SkillTimeoutCheck error (no fatal): " + e.message);
    }

    // FASE 1: Health check (lectura pura, ignora _lock_until)
    // Permite detección y alerta temprana aunque el plan esté bloqueado (#1732)
    try { await runHealthCheck(); } catch (e) {
        log("HealthCheck error (no fatal): " + e.message);
    }

    // FASE 2: Reconciliación (persiste en roadmap.json via saveRoadmapFromPlan, #1736)
    // 1. Leer sprint-plan.json
    const plan = loadPlan();
    if (!plan) {
        log("sprint-plan.json no encontrado o inválido — esperando próximo ciclo");
        return;
    }

    // 2. Verificar sprint activo
    if (plan.sprint_cerrado) {
        log("Sprint marcado como cerrado — auto-terminando watcher");
        await notify("🏁 <b>Agent Watcher: sprint cerrado</b>\nAuto-terminando.");
        process.exit(0);
    }
    const estado = plan.estado || plan.status;
    if (estado && estado !== "activo" && estado !== "active") {
        log("Sprint no activo (estado=" + estado + ") — skip ciclo");
        return;
    }

    const concurrencyLimit = plan.concurrency_limit || DEFAULT_CONCURRENCY_LIMIT;
    // Lock eliminado: sprint-data.js maneja concurrencia del roadmap (#1736)
    {
        // Releer para consistencia (sprint-plan.json es cache regenerado desde roadmap, #1736)
        const freshPlan = loadPlan();
        if (!freshPlan) { log("Plan inválido después de adquirir lock"); return; }

        if (!Array.isArray(freshPlan._completed)) freshPlan._completed = [];
        if (!Array.isArray(freshPlan._incomplete)) freshPlan._incomplete = [];

        // 3. Para cada agente activo, verificar si sigue vivo
        const activeAgents = (freshPlan.agentes || []).filter(ag => ag.status !== "waiting");
        let planDirty = false;

        for (const ag of activeAgents) {
            let alive;
            try { alive = isAgentAlive(ag); } catch (e) {
                log("isAgentAlive error para #" + ag.issue + ": " + e.message + " — skip");
                continue;
            }

            if (alive) continue;

            // #1553: Grace period — no evaluar agentes lanzados hace menos de GRACE_PERIOD_MIN minutos.
            // Evita falsos "failed" cuando el agente aún no tuvo tiempo de crear la PR.
            if (ag._launched_at) {
                const launchedAtMs = new Date(ag._launched_at).getTime();
                if (!isNaN(launchedAtMs)) {
                    const elapsedMin = (Date.now() - launchedAtMs) / 60000;
                    if (elapsedMin < GRACE_PERIOD_MIN) {
                        log("Agente #" + ag.issue + ": PID muerto pero dentro de grace period (" +
                            Math.round(elapsedMin * 10) / 10 + "/" + GRACE_PERIOD_MIN + " min) — skip");
                        continue;
                    }
                }
            }

            // Agente muerto: verificar PR
            const branch = "agent/" + ag.issue + "-" + ag.slug;
            const prStatus = checkPRStatus(branch);
            log("Agente #" + ag.issue + " muerto — PR status: " + prStatus.status);

            // Remover del array agentes
            freshPlan.agentes = (freshPlan.agentes || []).filter(a => a.issue !== ag.issue);
            planDirty = true;

            // Limpiar PID file del agente muerto (#1499)
            const deadAgentPidFile = path.join(HOOKS_DIR, "agent-" + ag.issue + ".pid");
            try { if (fs.existsSync(deadAgentPidFile)) fs.unlinkSync(deadAgentPidFile); } catch (e) {}

            if (prStatus.status === "merged") {
                // PR mergeada → validar criterios antes de marcar completado (#1458)
                const entry = buildCompletedEntry(ag, null, "ok");
                entry.detectado_por = "agent-watcher";
                const validation = validateCompletionCriteria(entry.duracion_min, prStatus, branch);
                if (validation.suspicious) {
                    // Validación fallida → marcar como suspicious, NO promover de cola
                    entry.resultado = "suspicious";
                    entry.motivo = validation.reason;
                    freshPlan._incomplete.push(entry);
                    log("Agente #" + ag.issue + " → _incomplete SUSPICIOUS: " + validation.reason);
                    await notify(
                        "⚠️ <b>Agente #" + ag.issue + " SOSPECHOSO (watcher)</b>\n" +
                        "PR mergeada pero validación fallida.\n" +
                        "Motivo: " + escHtml(validation.reason) + "\n" +
                        "<i>Acción requerida: revisar manualmente</i>"
                    );
                } else {
                    freshPlan._completed.push(entry);
                    log("Agente #" + ag.issue + " → _completed (PR merged, " + entry.duracion_min + " min)");
                    await updateProjectV2(ag.issue, "Done");
                    await notify(
                        "✅ <b>Agente #" + ag.issue + " completado (watcher)</b>\n" +
                        "PR mergeada · Slug: " + escHtml(ag.slug) + "\n" +
                        "Duración: " + entry.duracion_min + " min\n" +
                        "<i>Slot liberado · verificando cola...</i>"
                    );
                }
            } else if (prStatus.status === "open") {
                // PR abierta → mantener en agentes[] con status "waiting" (slot liberado) (#1458)
                const waitingEntry = Object.assign({}, ag, { status: "waiting", resultado: "pending_review" });
                freshPlan.agentes.push(waitingEntry);
                log("Agente #" + ag.issue + " → agentes[waiting] (PR abierta — pendiente review)");
                await notify(
                    "⏳ <b>Agente #" + ag.issue + " terminó — PR abierta (watcher)</b>\n" +
                    "Rama: " + escHtml(branch) + "\n" +
                    "Estado: pendiente de review · slot liberado"
                );
            } else {
                // Sin PR o cerrada sin merge
                // Fix: si el agente nunca trabajó (sin worktree, sin sesión real),
                // devolverlo a _queue en vez de _incomplete (#queue-cascade-fix)
                const worktreePath = path.join(WORKTREES_PARENT, "platform.agent-" + ag.issue + "-" + ag.slug);
                const hasWorktree = fs.existsSync(worktreePath);
                const entry = buildCompletedEntry(ag, null, "failed");
                const runtimeMin = entry.duracion_min || 0;
                const neverWorked = !hasWorktree && runtimeMin < 2;

                if (neverWorked) {
                    // Agente que nunca trabajó → verificar límite de reintentos (#1498)
                    const retryCount = (ag._retry_count || 0) + 1;

                    if (retryCount >= MAX_RETRIES) {
                        // Excedió reintentos → _incomplete definitivo
                        entry.detectado_por = "agent-watcher";
                        entry.motivo = "Excedió " + MAX_RETRIES + " reintentos desde watcher (nunca trabajó)";
                        entry._retry_count = retryCount;
                        freshPlan._incomplete.push(entry);
                        log("Agente #" + ag.issue + " → _incomplete DEFINITIVO: excedió " + MAX_RETRIES + " reintentos (nunca trabajó)");
                        await notify(
                            "🚫 <b>Agente #" + ag.issue + " descartado (watcher)</b>\n" +
                            "Excedió " + MAX_RETRIES + " reintentos sin trabajar.\n" +
                            "Slug: " + escHtml(ag.slug) + "\n" +
                            "<i>Acción: revisar issue manualmente y relanzar si es necesario</i>"
                        );
                    } else {
                        // Aún tiene reintentos → devolver a _queue con contador
                        const queue = getQueue(freshPlan);
                        delete ag.status;
                        delete ag.waiting_since;
                        delete ag.waiting_reason;
                        ag._retry_count = retryCount;
                        queue.push(ag);
                        setQueue(freshPlan, queue);
                        log("Agente #" + ag.issue + " → devuelto a _queue (reintento " + retryCount + "/" + MAX_RETRIES + ", sin worktree, " + runtimeMin + " min)");
                        await notify(
                            "🔄 <b>Agente #" + ag.issue + " devuelto a cola (watcher)</b>\n" +
                            "Reintento " + retryCount + "/" + MAX_RETRIES + " · Sin worktree ni sesión real\n" +
                            "<i>Será relanzado cuando haya slot</i>"
                        );
                    }
                } else {
                    // Retry automático antes de _incomplete (#1732):
                    // Agentes que sí trabajaron (worktree + tiempo > 2 min) pero murieron sin PR.
                    // Se relanzan hasta MAX_RETRIES veces antes de marcar como _incomplete.
                    const retryCount = ag._retry_count || 0;

                    if (retryCount < MAX_RETRIES) {
                        // === Agent Doctor: diagnostico + recovery ANTES de relanzar ===
                        let doctorResult = null;
                        if (agentDoctor) {
                            try {
                                doctorResult = agentDoctor.handleDeadAgent(ag, REPO_ROOT, HOOKS_DIR);
                                log("Doctor #" + ag.issue + ": causa=" + doctorResult.diagnosis.cause +
                                    " action=" + doctorResult.recovery.action +
                                    " success=" + doctorResult.recovery.success +
                                    " shouldRelaunch=" + doctorResult.shouldRelaunch);

                                // Si el doctor recupero el trabajo (ej: push + PR exitoso), no relanzar
                                if (doctorResult.recovery.success && !doctorResult.shouldRelaunch) {
                                    log("Doctor #" + ag.issue + ": recovery exitoso -- NO relanzar");
                                    const successEntry = buildCompletedEntry(ag, null, "completed");
                                    successEntry.detectado_por = "agent-doctor";
                                    successEntry.motivo = "Recovery automatico: " + doctorResult.recovery.details;
                                    successEntry._doctor_diagnosis = doctorResult.logEntry;
                                    if (!Array.isArray(freshPlan._completed)) freshPlan._completed = [];
                                    freshPlan._completed.push(successEntry);
                                    planDirty = true;
                                    savePlan(freshPlan);
                                    planDirty = false;
                                    await notify(agentDoctor.buildDiagnosisNotification(ag, doctorResult.diagnosis, doctorResult.recovery));
                                    continue; // No relanzar -- recovery exitoso
                                }

                                // Aplicar prompt enriquecido del doctor
                                const basePromptDoc = ag.prompt || generateDefaultPrompt(ag.issue, ag.slug);
                                ag.prompt = agentDoctor.buildDoctorRetryPrompt(basePromptDoc, ag, doctorResult.diagnosis);

                                // Reutilizar worktree si hay commits locales
                                if (doctorResult.diagnosis.localCommitCount > 0 && doctorResult.diagnosis.worktreeExists) {
                                    ag._reuse_worktree = true;
                                    log("Doctor #" + ag.issue + ": reutilizar worktree (" + doctorResult.diagnosis.localCommitCount + " commits)");
                                }

                                // Notificar diagnostico via Telegram
                                await notify(agentDoctor.buildDiagnosisNotification(ag, doctorResult.diagnosis, doctorResult.recovery));
                            } catch (e) {
                                log("WARN: agent-doctor error: " + e.message);
                            }
                        }

                        // Fallback: diagnostico basico si el doctor no esta disponible
                        if (!doctorResult && retryDiagnostics) {
                            try {
                                const diagnosis = retryDiagnostics.analyzeDeath(ag, REPO_ROOT, HOOKS_DIR);
                                log("Diagnostico #" + ag.issue + ": causa=" + diagnosis.cause + " localCommits=" + diagnosis.localCommitCount + " remoteBranch=" + diagnosis.hasRemoteBranch);
                                const basePrompt = ag.prompt || generateDefaultPrompt(ag.issue, ag.slug);
                                ag.prompt = retryDiagnostics.buildRetryPrompt(basePrompt, ag, diagnosis);
                                if (retryDiagnostics.shouldReuseWorktree(diagnosis)) {
                                    ag._reuse_worktree = true;
                                    log("Diagnostico #" + ag.issue + ": se reutilizara worktree (" + diagnosis.localCommitCount + " commits)");
                                }
                                const diagEntry = retryDiagnostics.buildDiagnosticsEntry(ag, diagnosis);
                                if (!Array.isArray(ag._retry_diagnostics)) ag._retry_diagnostics = [];
                                ag._retry_diagnostics.push(diagEntry);
                            } catch (e) {
                                log("WARN: agent-retry-diagnostics error: " + e.message);
                            }
                        }

                        // Persistir diagnostico del doctor en historial del agente
                        if (doctorResult) {
                            if (!Array.isArray(ag._retry_diagnostics)) ag._retry_diagnostics = [];
                            ag._retry_diagnostics.push(doctorResult.logEntry);
                        }

                        // Aplicar cooldown si el doctor lo recomienda (ej: rate limit)
                        const cooldownMs = doctorResult ? doctorResult.cooldownMs : 0;
                        if (cooldownMs > 60000) {
                            log("Doctor #" + ag.issue + ": cooldown de " + Math.round(cooldownMs / 60000) + " min antes de relanzar");
                            ag._doctor_cooldown_until = new Date(Date.now() + cooldownMs).toISOString();
                            ag._retry_count = retryCount + 1;
                            const queue = getQueue(freshPlan);
                            queue.push(ag);
                            setQueue(freshPlan, queue);
                            planDirty = true;
                            savePlan(freshPlan);
                            planDirty = false;
                            await notify(
                                "\u23F3 <b>Agente #" + ag.issue + " en cooldown</b>\n" +
                                "Causa: " + escHtml(doctorResult.diagnosis.cause) + "\n" +
                                "Cooldown: " + Math.round(cooldownMs / 60000) + " min\n" +
                                "Sera relanzado automaticamente"
                            );
                            continue; // No relanzar ahora -- cooldown activo
                        }

                        // Relanzar: re-agregar al plan como "promoted" con contador actualizado
                        ag._retry_count = retryCount + 1;
                        ag.status = "promoted";
                        ag._promoted_at = new Date().toISOString();
                        ag._launched_at = new Date().toISOString();
                        ag._pid = null;
                        freshPlan.agentes.push(ag);
                        planDirty = true;

                        log("Reconciliacion: agente #" + ag.issue + " muerto sin PR -- relanzando (intento " +
                            ag._retry_count + "/" + MAX_RETRIES + ")");
                        savePlan(freshPlan);
                        planDirty = false;

                        const relaunchResult = launchAgent(ag);
                        // S3: Registrar resultado en circuit breaker
                        if (circuitBreaker) {
                            if (relaunchResult) circuitBreaker.recordSuccess(String(ag.issue));
                            else circuitBreaker.recordFailure(String(ag.issue));
                        }
                        // Persistir el _pid asignado por launchAgent
                        if (ag._pid) savePlan(freshPlan);

                        const diagCause = (doctorResult && doctorResult.diagnosis)
                            ? doctorResult.diagnosis.cause
                            : (ag._retry_diagnostics && ag._retry_diagnostics.length > 0)
                                ? ag._retry_diagnostics[ag._retry_diagnostics.length - 1].cause
                                : "unknown";
                        await notify(
                            "\uD83D\uDD04 <b>Agente #" + ag.issue + " relanzado (intento " + ag._retry_count + "/" + MAX_RETRIES + ")</b>\n" +
                            "Sin PR detectada \u00B7 Slug: " + escHtml(ag.slug) + "\n" +
                            "Causa: " + escHtml(diagCause) + "\n" +
                            "Resultado: " + (relaunchResult ? "spawn exitoso" : "spawn fallido") +
                            (ag._reuse_worktree ? " \u00B7 Worktree reutilizado" : "")
                        )
                    } else {
                        // Excedió reintentos: verificar si el issue fue cerrado en GitHub
                        let issueAlreadyClosed = false;
                        const ghCmd = findGhCli();
                        if (ghCmd) {
                            try {
                                const issueState = execSync(
                                    '"' + ghCmd + '" issue view ' + ag.issue + ' --repo intrale/platform --json state --jq .state',
                                    { encoding: "utf8", timeout: 15000, windowsHide: true }
                                ).trim();
                                issueAlreadyClosed = (issueState === "CLOSED");
                            } catch (e) {
                                log("WARN: No se pudo verificar estado del issue #" + ag.issue + ": " + e.message);
                            }
                        }

                        if (issueAlreadyClosed) {
                            // Issue cerrado → completado exitosamente por otra vía
                            const successEntry = buildCompletedEntry(ag, null, "completed");
                            successEntry.detectado_por = "agent-watcher";
                            successEntry.motivo = "Issue cerrado en GitHub — trabajo exitoso";
                            freshPlan._completed.push(successEntry);
                            log("Agente #" + ag.issue + " → _completed (issue cerrado en GitHub)");
                            await notify(
                                "✅ <b>Agente #" + ag.issue + " completado (watcher)</b>\n" +
                                "Issue cerrado en GitHub — trabajo exitoso\n" +
                                "Slug: " + escHtml(ag.slug)
                            );
                        } else {
                            const motivo = prStatus.status === "unknown"
                                ? "No se pudo verificar PR (gh CLI falló)"
                                : prStatus.status === "closed_no_merge"
                                    ? "PR cerrada sin merge"
                                    : "Sin PR tras " + MAX_RETRIES + " reintentos — el agente no completó /delivery";
                            entry.detectado_por = "agent-watcher";
                            entry.motivo = motivo;
                            if (ag._retry_diagnostics) entry._retry_diagnostics = ag._retry_diagnostics;
                            freshPlan._incomplete.push(entry);
                            log("Agente #" + ag.issue + " → _incomplete (" + prStatus.status + "): " + motivo);

                            const exhaustedMsg = (retryDiagnostics && ag._retry_diagnostics && ag._retry_diagnostics.length > 0)
                                ? retryDiagnostics.buildExhaustedSummary(ag, ag._retry_diagnostics)
                                : "&#x26A0;&#xFE0F; <b>Agente #" + ag.issue + " termino sin PR (watcher)</b>\n" +
                                  "Slug: " + escHtml(ag.slug) + " · PR: " + prStatus.status + "\n" +
                                  "Motivo: " + escHtml(motivo);
                            await notify(exhaustedMsg)
                        }
                    }
                }
            }
        }

        // 4. Reconciliation: detectar agentes "promoted" sin _pid por >60s (#1522)
        const PROMOTED_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutos (#fix: 60s era demasiado corto)
        const MAX_RETRY_COUNT = 3;
        const promotedAgents = (freshPlan.agentes || []).filter(ag => ag.status === "promoted" && !ag._pid);

        for (const ag of promotedAgents) {
            const promotedAt = ag._promoted_at ? new Date(ag._promoted_at).getTime() : 0;
            const elapsedMs = Date.now() - promotedAt;

            if (elapsedMs < PROMOTED_TIMEOUT_MS) {
                log("Agente #" + ag.issue + " promoted hace " + Math.round(elapsedMs / 1000) + "s — esperando (timeout: " + (PROMOTED_TIMEOUT_MS / 1000) + "s)");
                continue;
            }

            const retryCount = ag._retry_count || 0;

            if (retryCount >= MAX_RETRY_COUNT) {
                // Máximo de reintentos alcanzado → mover a _incomplete
                freshPlan.agentes = (freshPlan.agentes || []).filter(a => a.issue !== ag.issue);
                const entry = buildCompletedEntry(ag, null, "failed");
                entry.detectado_por = "agent-watcher-reconciliation";
                entry.motivo = "Promoted sin lanzamiento exitoso tras " + MAX_RETRY_COUNT + " reintentos";
                freshPlan._incomplete.push(entry);
                planDirty = true;

                log("Agente #" + ag.issue + " → _incomplete (promoted sin _pid, " + MAX_RETRY_COUNT + " reintentos agotados)");
                await notify(
                    "🔴 <b>Agente #" + ag.issue + " falló al lanzar (reconciliación)</b>\n" +
                    "Promoted sin terminal real tras " + MAX_RETRY_COUNT + " reintentos.\n" +
                    "Slug: " + escHtml(ag.slug) + "\n" +
                    "<i>Movido a _incomplete. Intervención manual requerida.</i>"
                );
                continue;
            }

            // Reintento: relanzar con Start-Agente.ps1
            ag._retry_count = retryCount + 1;
            ag._promoted_at = new Date().toISOString(); // reset timer para siguiente intento
            planDirty = true;

            log("Reconciliación: agente #" + ag.issue + " promoted sin _pid por " + Math.round(elapsedMs / 1000) + "s — reintento " + ag._retry_count + "/" + MAX_RETRY_COUNT);
            savePlan(freshPlan);
            planDirty = false;

            const launched = launchAgent(ag);
            await notify(
                "🔄 <b>Reconciliación: relanzando agente #" + ag.issue + "</b>\n" +
                "Promoted sin terminal detectado (" + Math.round(elapsedMs / 1000) + "s).\n" +
                "Reintento: " + ag._retry_count + "/" + MAX_RETRY_COUNT + "\n" +
                "Resultado: " + (launched ? "spawn exitoso" : "spawn fallido") + "\n" +
                "Slug: " + escHtml(ag.slug)
            );
        }

        // 4b. Verificar agentes "active" con _pid muerto (#1522)
        const activeWithPid = (freshPlan.agentes || []).filter(ag => ag.status === "active" && ag._pid);
        for (const ag of activeWithPid) {
            if (!isPidAlive(ag._pid)) {
                log("Agente #" + ag.issue + " status=active pero _pid=" + ag._pid + " muerto — marcando para evaluación normal");
                // Dejar que la lógica existente de isAgentAlive lo maneje en el paso 3
                // Solo limpiar el _pid inválido para que no bloquee detección
                ag._pid = null;
                planDirty = true;
            }
        }

        // 5. Contar slots disponibles y promover desde cola
        // Excluir "promoted" del conteo de slots libres — ya ocupan slot (#1522)
        const afterCount = (freshPlan.agentes || []).filter(ag => ag.status !== "waiting").length;
        const queue = getQueue(freshPlan);
        const slotsLibres = concurrencyLimit - afterCount;

        log("Estado: activos=" + afterCount + "/" + concurrencyLimit + " · cola=" + queue.length + " · slots libres=" + slotsLibres);

        if (slotsLibres > 0 && queue.length > 0) {
            const toPromote = queue.slice(0, slotsLibres);
            const remaining = queue.slice(slotsLibres);
            setQueue(freshPlan, remaining);

            // Calcular números y asignar prompts antes de guardar
            for (const nextAgent of toPromote) {
                const maxNumero = (freshPlan.agentes || []).reduce((m, a) => Math.max(m, a.numero || 0), 0);
                nextAgent.numero = maxNumero + 1;
                if (!nextAgent.prompt) nextAgent.prompt = generateDefaultPrompt(nextAgent.issue, nextAgent.slug);
                // #1522: marcar como promoted hasta que Start-Agente.ps1 confirme con _pid
                nextAgent.status = "promoted";
                nextAgent._promoted_at = new Date().toISOString();
                nextAgent._pid = null;
                nextAgent._retry_count = 0;
                freshPlan.agentes.push(nextAgent);
            }

            // Lanzar cada agente promovido y capturar PIDs antes de guardar el plan.
            // Guardar DESPUÉS del lanzamiento para persistir _pid en sprint-plan.json (#1499).
            for (const nextAgent of toPromote) {
                await updateProjectV2(nextAgent.issue, "In Progress");
                const launched = launchAgent(nextAgent); // también actualiza nextAgent._pid
                const newCount = (freshPlan.agentes || []).filter(ag => ag.status !== "waiting").length;

                await notify(launched
                    ? (
                        "🚀 <b>Agente #" + nextAgent.issue + " promovido desde cola (watcher)</b>\n" +
                        "Slug: " + escHtml(nextAgent.slug) + "\n" +
                        "Slots: " + newCount + "/" + concurrencyLimit + " · Cola restante: " + remaining.length
                    )
                    : (
                        "⚠️ <b>#" + nextAgent.issue + " promovido pero no pudo lanzarse (watcher)</b>\n" +
                        "Lanzar manualmente: <code>.\\scripts\\Start-Agente.ps1 " + nextAgent.numero + "</code>"
                    )
                );
            }

            // Guardar plan después de lanzar para incluir _pid de cada agente (#1499)
            savePlan(freshPlan);
            planDirty = false;
            log("Plan guardado con " + toPromote.length + " agente(s) promovido(s) (incluye _pid)");
        } else if (planDirty) {
            // Solo guardar si hubo cambios (agentes removidos) aunque no haya promoción
            savePlan(freshPlan);
        }

        // 5. Verificar si el sprint completó
        const remainingActive = (freshPlan.agentes || []).filter(ag => ag.status !== "waiting").length;
        const remainingQueue = getQueue(freshPlan).length;
        const waitingCount = (freshPlan.agentes || []).filter(ag => ag.status === "waiting").length;

        if (remainingActive === 0 && remainingQueue === 0 && waitingCount === 0) {
            const completados = (freshPlan._completed || []).length;
            const incompletos = (freshPlan._incomplete || []).length;
            log("Sprint completado — agentes activos=0, cola=0, waiting=0");
            await notify(
                "✅ <b>Sprint completado (watcher)</b>\n" +
                "Todos los agentes terminaron y la cola está vacía.\n" +
                "Completados: " + completados + " · Incompletos: " + incompletos + "\n" +
                "<i>Agent Watcher auto-terminando.</i>"
            );
            process.exit(0);
        }

        // Auto-shutdown si solo quedan agentes en "waiting" (PR abierta) sin trabajo real
        // Evita que el watcher corra indefinidamente esperando reviews manuales
        if (remainingActive === 0 && remainingQueue === 0 && waitingCount > 0) {
            if (!global._idleSince) {
                global._idleSince = Date.now();
                log("Watcher idle: solo quedan " + waitingCount + " agente(s) en waiting (PR abierta). Timer de 15 min iniciado.");
            }
            const IDLE_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutos
            const idleMin = Math.round((Date.now() - global._idleSince) / 60000);
            if (Date.now() - global._idleSince > IDLE_TIMEOUT_MS) {
                log("Watcher idle timeout: " + idleMin + " min sin trabajo real. Auto-terminando.");
                await notify(
                    "⏹️ <b>Agent Watcher auto-shutdown (idle " + idleMin + " min)</b>\n" +
                    waitingCount + " agente(s) en waiting (PR abierta) — requieren review manual.\n" +
                    "<i>Watcher se detiene. Mergear PRs manualmente o relanzar sprint.</i>"
                );
                process.exit(0);
            }
        } else {
            // Reset idle timer si hay trabajo activo
            global._idleSince = null;
        }

    }
}

// ─── Inicio ───────────────────────────────────────────────────────────────────

async function main() {
    log("========================================================");
    log("Agent Watcher iniciando (PID " + process.pid + ")");
    log("Repo: " + REPO_ROOT);
    log("Poll interval: " + (POLL_INTERVAL_MS / 1000) + "s");
    log("Plan: " + PLAN_FILE);
    log("========================================================");

    // Verificar instancia única (lock file)
    checkSingleInstance();

    await notify(
        "👁️ <b>Agent Watcher iniciado</b>\n" +
        "PID: " + process.pid + " · Intervalo: " + (POLL_INTERVAL_MS / 1000) + "s\n" +
        "Monitoreando worktrees para promoción automática desde _queue[]"
    );

    // Primer ciclo inmediato
    try { await runCycle(); } catch (e) { log("Error en ciclo inicial: " + e.message); }

    // Ciclos periódicos con setInterval
    const interval = setInterval(async () => {
        try {
            await runCycle();
        } catch (e) {
            // Un error en un ciclo no mata el watcher — solo se loguea
            log("Error en ciclo periódico (no fatal): " + e.message);
        }
        // Cleanup de terminales zombie cada ciclo (best-effort)
        if (agentDoctor && agentDoctor.cleanupZombieTerminals) {
            try {
                const cleanup = agentDoctor.cleanupZombieTerminals(REPO_ROOT);
                if (cleanup.killed > 0) {
                    log("Zombie cleanup: " + cleanup.killed + " procesos terminados");
                    cleanup.details.forEach(d => log("  " + d));
                }
            } catch (e) {}
        }
    }, POLL_INTERVAL_MS);

    // Señales de terminación
    async function shutdown(signal) {
        log(signal + " recibido — terminando watcher");
        clearInterval(interval);
        try { await notify("🔴 <b>Agent Watcher detenido</b>\nRecibió señal: " + signal); } catch (e) {}
        process.exit(0);
    }

    process.on("SIGINT",  () => shutdown("SIGINT"));
    process.on("SIGTERM", () => shutdown("SIGTERM"));

    log("Watcher activo. Próximo ciclo en " + (POLL_INTERVAL_MS / 1000) + "s.");
}

main().catch(e => {
    log("Error fatal: " + e.message);
    process.exit(1);
});
