// agent-coordinator.js — Coordinador único event-driven para ciclo de vida de agentes
// Reemplaza agent-watcher.js: elimina polling, centraliza escritura, usa heartbeat files.
//
// Principio: UN SOLO PROCESO escribe sprint-plan/roadmap. Los hooks solo emiten eventos.
//
// Ejecución: node agent-coordinator.js (proceso background, lanzado por Start-Agente.ps1)
// PID file: .claude/hooks/agent-coordinator.pid
// Events: .claude/hooks/agent-events.jsonl (append-only, hooks escriben aquí)
// Log: .claude/hooks/agent-coordinator.log
"use strict";

const fs = require("fs");
const path = require("path");
const { execSync, spawn: nodeSpawn } = require("child_process");

// ─── Paths ────────────────────────────────────────────────────────────────────

function resolveMainRepoRoot() {
    const envRoot = process.env.CLAUDE_PROJECT_DIR || "C:\\Workspaces\\Intrale\\platform";
    try {
        const output = execSync("git worktree list", {
            encoding: "utf8", cwd: envRoot, timeout: 5000, windowsHide: true
        });
        const firstLine = output.split("\n")[0] || "";
        const match = firstLine.match(/^(.+?)\s+[0-9a-f]{5,}/);
        if (match) return match[1].trim().replace(/^\/([a-z])\//, "$1:\\").replace(/\//g, "\\");
    } catch (e) {}
    return envRoot;
}

const REPO_ROOT = resolveMainRepoRoot();
const HOOKS_DIR = path.join(REPO_ROOT, ".claude", "hooks");
const SCRIPTS_DIR = path.join(REPO_ROOT, "scripts");
const PLAN_FILE = path.join(SCRIPTS_DIR, "sprint-plan.json");
const SESSIONS_DIR = path.join(REPO_ROOT, ".claude", "sessions");
const WORKTREES_PARENT = path.dirname(REPO_ROOT);

const PID_FILE = path.join(HOOKS_DIR, "agent-coordinator.pid");
const LOG_FILE = path.join(HOOKS_DIR, "agent-coordinator.log");
const EVENTS_FILE = path.join(HOOKS_DIR, "agent-events.jsonl");
const AGENT_RUNNER = path.join(SCRIPTS_DIR, "pipeline", "agent-runner.js");
const SKILLS_TIMEOUT_FILE = path.join(HOOKS_DIR, "skills-timeout.json");
const GH_CLI_PATH = "C:\\Workspaces\\gh-cli\\bin";
const JAVA_HOME_PATH = "C:\\Users\\Administrator\\.jdks\\temurin-21.0.7";

// ─── Sprint data (fuente de verdad: roadmap.json) ────────────────────────────

let _sprintDataModule = null;
function getSprintData() {
    if (!_sprintDataModule) _sprintDataModule = require("./sprint-data");
    return _sprintDataModule;
}

// ─── Configuración ──────────────────────────────────────────────────────────

const DEFAULT_CONCURRENCY_LIMIT = 3;
const MAX_RETRIES = 3;
const HEARTBEAT_DEAD_THRESHOLD_MS = 3 * 60 * 1000;   // 3 min sin heartbeat → muerto
const GRACE_PERIOD_MIN = 15;                           // grace period antes de evaluar PR
const EVENT_POLL_MS = 5000;                            // fallback polling si fs.watch falla
const RECONCILE_INTERVAL_MS = 60 * 1000;               // reconciliación periódica cada 60s
const SWEEP_INTERVAL_MS = 60 * 1000;                   // sweep de waiting agents
const SENTINEL_INTERVAL_MS = 5 * 60 * 1000;            // sentinel de liveness
const SKILL_TIMEOUT_CHECK_MS = 2 * 60 * 1000;          // check de skills colgados

// Circuit breaker: por issue
const _circuitBreaker = new Map(); // issue → { failures: N, lastFailure: ts, state: "closed"|"open"|"half-open" }
const CB_MAX_FAILURES = 3;
const CB_OPEN_DURATION_MS = 10 * 60 * 1000; // 10 min abierto antes de half-open

// Backoff exponencial: por issue
const _backoff = new Map(); // issue → { retryCount: N, nextRetryAt: ts }
const BACKOFF_BASE_MS = 60 * 1000; // 1 min base
const BACKOFF_MAX_MS = 15 * 60 * 1000; // 15 min max

// ─── Logging ─────────────────────────────────────────────────────────────────

function log(msg) {
    const line = "[" + new Date().toISOString() + "] Coordinator: " + msg + "\n";
    try { fs.appendFileSync(LOG_FILE, line); } catch (e) {}
    process.stdout.write(line);
}

// ─── Singleton check ─────────────────────────────────────────────────────────

function checkSingleInstance() {
    try {
        if (fs.existsSync(PID_FILE)) {
            const existingPid = parseInt(fs.readFileSync(PID_FILE, "utf8").trim(), 10);
            if (existingPid && existingPid !== process.pid && isPidAlive(existingPid)) {
                log("Ya existe un coordinator activo (PID " + existingPid + ") — abortando");
                process.exit(0);
            }
        }
    } catch (e) {}
    try { fs.writeFileSync(PID_FILE, String(process.pid), "utf8"); } catch (e) {}
}

function cleanupPidFile() {
    try {
        const content = fs.readFileSync(PID_FILE, "utf8").trim();
        if (parseInt(content, 10) === process.pid) fs.unlinkSync(PID_FILE);
    } catch (e) {}
}
process.on("exit", cleanupPidFile);

// ─── Telegram ────────────────────────────────────────────────────────────────

let tgClient = null;
try { tgClient = require("./telegram-client"); } catch (e) {}

async function notify(text) {
    if (tgClient) {
        try { await tgClient.sendMessage(text); return; } catch (e) { log("tgClient error: " + e.message); }
    }
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

function escHtml(str) {
    return (str || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ─── Helpers de proceso ──────────────────────────────────────────────────────

function isPidAlive(pid) {
    if (!pid) return false;
    const numPid = parseInt(pid, 10);
    if (!numPid) return false;
    try {
        const out = execSync('tasklist /FI "PID eq ' + numPid + '" /FO CSV /NH', {
            timeout: 3000, windowsHide: true, encoding: "utf8"
        });
        return out.indexOf(String(numPid)) !== -1;
    } catch (e) {
        try { process.kill(numPid, 0); return true; } catch (ke) { return ke.code === "EPERM"; }
    }
}

function isClaudeProcess(pid) {
    if (!pid) return false;
    try {
        const out = execSync('tasklist /FI "PID eq ' + parseInt(pid, 10) + '" /FO CSV /NH', {
            timeout: 3000, windowsHide: true, encoding: "utf8"
        }).toLowerCase();
        return out.includes("claude.exe") || out.includes("node.exe");
    } catch (e) { return false; }
}

function killProcess(pid) {
    try {
        execSync("taskkill /F /PID " + parseInt(pid, 10), { timeout: 5000, windowsHide: true, stdio: "ignore" });
        return true;
    } catch (e) { return !isPidAlive(pid); }
}

// ─── gh CLI ──────────────────────────────────────────────────────────────────

let _ghCmd = null;
function findGhCli() {
    if (_ghCmd) return _ghCmd;
    for (const candidate of [GH_CLI_PATH + "\\gh.exe", "gh"]) {
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
    if (!ghCmd) return { status: "unknown" };
    try {
        const cmd = '"' + ghCmd + '" pr list --repo intrale/platform --head "' + branch + '" --state all --json number,state';
        const output = execSync(cmd, { encoding: "utf8", timeout: 15000, windowsHide: true });
        const prs = JSON.parse(output || "[]");
        if (!Array.isArray(prs) || prs.length === 0) return { status: "none", prs: [] };
        if (prs.find(pr => pr.state === "MERGED")) return { status: "merged", prs };
        if (prs.find(pr => pr.state === "OPEN")) return { status: "open", prs };
        return { status: "closed_no_merge", prs };
    } catch (e) {
        log("checkPRStatus error: " + e.message);
        return { status: "unknown" };
    }
}

// ─── Project V2 ──────────────────────────────────────────────────────────────

let projectUtils = null;
try { projectUtils = require("./project-utils"); } catch (e) {}

async function updateProjectV2(issue, statusName) {
    if (!projectUtils) return;
    try {
        const token = projectUtils.getGitHubToken();
        const statusId = projectUtils.STATUS_OPTIONS[statusName];
        if (!statusId) return;
        await projectUtils.addAndSetStatus(token, issue, statusId);
        log("Project V2: #" + issue + " -> " + statusName);
    } catch (e) { log("updateProjectV2 error: " + e.message); }
}

// ─── Validation utils ────────────────────────────────────────────────────────

const { buildCompletedEntry, validateCompletionCriteria, MIN_DURATION_MINUTES } = require("./validation-utils");

// Agent doctor para diagnóstico de muerte
let agentDoctor = null;
try { agentDoctor = require("./agent-doctor"); } catch (e) {}

let retryDiagnostics = null;
try { retryDiagnostics = require("./agent-retry-diagnostics"); } catch (e) {}

// ─── Plan helpers (UNICO WRITER) ────────────────────────────────────────────

function loadPlan() {
    try {
        if (!fs.existsSync(PLAN_FILE)) {
            try {
                const sd = getSprintData();
                const rm = sd.readRoadmap();
                if (rm) sd.generateSprintPlanCache(rm);
            } catch (e) {}
        }
        if (!fs.existsSync(PLAN_FILE)) return null;
        return JSON.parse(fs.readFileSync(PLAN_FILE, "utf8"));
    } catch (e) {
        log("loadPlan error: " + e.message);
        return null;
    }
}

function savePlan(plan) {
    // Único writer: coordinator. Persiste en roadmap.json y regenera cache.
    try {
        getSprintData().saveRoadmapFromPlan(plan, "agent-coordinator");
    } catch (e) {
        log("savePlan error: " + e.message);
    }
}

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

function generateDefaultPrompt(issue, slug) {
    return (
        "Implementar issue #" + issue + ". " +
        "Leer el issue completo con: gh issue view " + issue + " --repo intrale/platform. " +
        "Al iniciar: invocar /ops para verificar estado del entorno. " +
        "Al iniciar: invocar /po para revisar criterios de aceptacion del issue #" + issue + ". " +
        "Si el issue menciona libs, patrones o frameworks nuevos: invocar /guru para investigacion tecnica. " +
        "Completar los cambios descritos en el body del issue. " +
        "Antes de /delivery: invocar /tester para verificar que los tests pasan. " +
        "Antes de /delivery: invocar /builder para validar que el build no esta roto. " +
        "Antes de /delivery: invocar /security para validar seguridad del diff. " +
        "Antes de /delivery: invocar /review para validar el diff. " +
        "Usar /delivery para commit+PR al terminar. Closes #" + issue
    );
}

// ─── Event log (append-only) ─────────────────────────────────────────────────

function emitEvent(evt) {
    evt.ts = new Date().toISOString();
    try {
        fs.appendFileSync(EVENTS_FILE, JSON.stringify(evt) + "\n", "utf8");
    } catch (e) { log("emitEvent error: " + e.message); }
}

let _lastEventsSize = 0;

function readNewEvents() {
    try {
        if (!fs.existsSync(EVENTS_FILE)) return [];
        const stat = fs.statSync(EVENTS_FILE);
        if (stat.size <= _lastEventsSize) return [];
        const fd = fs.openSync(EVENTS_FILE, "r");
        const buf = Buffer.alloc(stat.size - _lastEventsSize);
        fs.readSync(fd, buf, 0, buf.length, _lastEventsSize);
        fs.closeSync(fd);
        _lastEventsSize = stat.size;
        const lines = buf.toString("utf8").trim().split("\n").filter(l => l.trim());
        return lines.map(l => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean);
    } catch (e) {
        log("readNewEvents error: " + e.message);
        return [];
    }
}

// Rotate events log when it gets too large
function rotateEventsIfNeeded() {
    try {
        const stat = fs.statSync(EVENTS_FILE);
        if (stat.size > 10 * 1024 * 1024) { // 10MB
            const archivePath = EVENTS_FILE.replace(".jsonl", ".archive." + Date.now() + ".jsonl");
            fs.renameSync(EVENTS_FILE, archivePath);
            _lastEventsSize = 0;
            log("Events log rotated to " + path.basename(archivePath));
            // Compress archive
            try {
                const zlib = require("zlib");
                const input = fs.readFileSync(archivePath);
                fs.writeFileSync(archivePath + ".gz", zlib.gzipSync(input));
                fs.unlinkSync(archivePath);
            } catch (e) {}
        }
    } catch (e) {}
}

// ─── Heartbeat-based liveness detection ──────────────────────────────────────

function readHeartbeat(issue) {
    const hbFile = path.join(HOOKS_DIR, "agent-" + issue + ".heartbeat");
    try {
        if (!fs.existsSync(hbFile)) return null;
        return JSON.parse(fs.readFileSync(hbFile, "utf8"));
    } catch (e) { return null; }
}

/**
 * Determina si un agente sigue vivo usando heartbeat files como fuente primaria.
 * Fallback a PID check si no hay heartbeat (compat con agentes pre-heartbeat).
 */
function isAgentAlive(agente) {
    // Método 1: Heartbeat file (preferido — no depende de PIDs)
    const hb = readHeartbeat(agente.issue);
    if (hb && hb.ts) {
        const hbAge = Date.now() - new Date(hb.ts).getTime();
        if (hbAge < HEARTBEAT_DEAD_THRESHOLD_MS) {
            log("isAgentAlive #" + agente.issue + ": heartbeat " + Math.round(hbAge / 1000) + "s ago -> vivo");
            return true;
        }
        log("isAgentAlive #" + agente.issue + ": heartbeat stale (" + Math.round(hbAge / 1000) + "s) -> verificando PID");
    }

    // Método 2: PID check (fallback para agentes sin heartbeat)
    if (agente._pid) {
        const isC = isClaudeProcess(agente._pid);
        log("isAgentAlive #" + agente.issue + ": _pid " + agente._pid + " -> " + (isC ? "vivo" : "muerto"));
        if (isC) return true;
    }

    // Método 3: PID file
    const agentPidFile = path.join(HOOKS_DIR, "agent-" + agente.issue + ".pid");
    try {
        if (fs.existsSync(agentPidFile)) {
            const filePid = parseInt(fs.readFileSync(agentPidFile, "utf8").trim(), 10);
            if (filePid && isClaudeProcess(filePid)) {
                log("isAgentAlive #" + agente.issue + ": PID file " + filePid + " -> vivo");
                agente._pid = filePid;
                return true;
            }
        }
    } catch (e) {}

    // Método 4: Sesión activa
    try {
        if (fs.existsSync(SESSIONS_DIR)) {
            const branch = "agent/" + agente.issue + "-" + agente.slug;
            const files = fs.readdirSync(SESSIONS_DIR).filter(f => f.endsWith(".json"));
            for (const file of files) {
                try {
                    const session = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, file), "utf8"));
                    if (session.branch !== branch) continue;
                    if (session.status === "done") return false;
                    if (session.status === "active") {
                        const sessionPid = session.pid || session.claude_pid;
                        if (sessionPid && isClaudeProcess(sessionPid)) {
                            agente._pid = sessionPid;
                            return true;
                        }
                        if (!sessionPid) return true; // conservador
                        return false;
                    }
                } catch (e) {}
            }
        }
    } catch (e) {}

    // Sin evidencia: verificar worktree
    const worktreePath = getExpectedWorktreePath(agente);
    if (!fs.existsSync(worktreePath)) {
        log("isAgentAlive #" + agente.issue + ": sin heartbeat, sin PID, sin worktree -> muerto");
        return false;
    }

    log("isAgentAlive #" + agente.issue + ": indeterminado (worktree existe) -> asumiendo muerto (coordinator)");
    return false; // Coordinator es más agresivo: si no hay heartbeat ni PID → muerto
}

// ─── Circuit breaker ─────────────────────────────────────────────────────────

function cbCanRelaunch(issue) {
    const key = String(issue);
    const state = _circuitBreaker.get(key);
    if (!state) return { allowed: true };
    if (state.state === "open") {
        if (Date.now() - state.lastFailure > CB_OPEN_DURATION_MS) {
            state.state = "half-open";
            return { allowed: true, reason: "half-open after cooldown" };
        }
        return { allowed: false, reason: "circuit open (" + state.failures + " failures, cooldown " + Math.round((CB_OPEN_DURATION_MS - (Date.now() - state.lastFailure)) / 60000) + "min left)" };
    }
    return { allowed: true };
}

function cbRecordSuccess(issue) {
    _circuitBreaker.delete(String(issue));
}

function cbRecordFailure(issue) {
    const key = String(issue);
    const state = _circuitBreaker.get(key) || { failures: 0, lastFailure: 0, state: "closed" };
    state.failures++;
    state.lastFailure = Date.now();
    if (state.failures >= CB_MAX_FAILURES) state.state = "open";
    _circuitBreaker.set(key, state);
}

// ─── Backoff exponencial ─────────────────────────────────────────────────────

function getBackoffDelay(issue) {
    const key = String(issue);
    const state = _backoff.get(key);
    if (!state) return 0;
    const delay = Math.min(BACKOFF_BASE_MS * Math.pow(2, state.retryCount - 1), BACKOFF_MAX_MS);
    const nextRetryAt = state.lastRetry + delay;
    if (Date.now() >= nextRetryAt) return 0;
    return nextRetryAt - Date.now();
}

function recordBackoff(issue) {
    const key = String(issue);
    const state = _backoff.get(key) || { retryCount: 0, lastRetry: 0 };
    state.retryCount++;
    state.lastRetry = Date.now();
    _backoff.set(key, state);
}

function clearBackoff(issue) {
    _backoff.delete(String(issue));
}

// ─── Worktree setup ──────────────────────────────────────────────────────────

function setupWorktree(agente) {
    const wtName = "platform.agent-" + agente.issue + "-" + agente.slug;
    const wtDir = path.join(path.dirname(REPO_ROOT), wtName);
    const branch = "agent/" + agente.issue + "-" + agente.slug;

    if (fs.existsSync(wtDir)) {
        log("setupWorktree: limpiando worktree existente " + wtName);
        const claudeDir = path.join(wtDir, ".claude");
        if (fs.existsSync(claudeDir)) {
            try { fs.rmSync(claudeDir, { recursive: true, force: true }); } catch (e) {}
        }
        try {
            execSync("git worktree remove " + JSON.stringify(wtDir.replace(/\\/g, "/")) + " --force", {
                encoding: "utf8", timeout: 15000, windowsHide: true
            });
        } catch (e) {}
        if (fs.existsSync(wtDir)) {
            try { fs.rmSync(wtDir, { recursive: true, force: true }); } catch (e) {}
        }
        try { execSync("git worktree prune", { timeout: 5000, windowsHide: true }); } catch (e) {}
    }

    try { execSync("git branch -D " + JSON.stringify(branch), { timeout: 5000, windowsHide: true, stdio: "ignore" }); } catch (e) {}

    const relPath = "../" + wtName;
    log("setupWorktree: git worktree add " + relPath + " -b " + branch);
    execSync("git worktree add " + JSON.stringify(relPath) + " -b " + JSON.stringify(branch) + " origin/main", {
        encoding: "utf8", timeout: 30000, windowsHide: true, cwd: REPO_ROOT
    });

    if (!fs.existsSync(path.join(wtDir, ".git"))) {
        throw new Error("Worktree creado pero .git no existe en " + wtDir);
    }

    const claudeSrc = path.join(REPO_ROOT, ".claude");
    const claudeDst = path.join(wtDir, ".claude");
    fs.cpSync(claudeSrc, claudeDst, { recursive: true, force: true });
    log("setupWorktree: .claude/ copiado");

    const staleFiles = ["agent-done.json", "claude_err.txt", "claude_err2.txt"];
    for (const f of staleFiles) {
        const fp = path.join(wtDir, f);
        if (fs.existsSync(fp)) try { fs.unlinkSync(fp); } catch (e) {}
    }

    return wtDir;
}

// ─── Launch agent (UNICO LANZADOR) ──────────────────────────────────────────

function launchAgent(agente) {
    try {
        // Circuit breaker check
        const cbResult = cbCanRelaunch(agente.issue);
        if (!cbResult.allowed) {
            log("launchAgent: BLOQUEADO por circuit breaker #" + agente.issue + " — " + cbResult.reason);
            return false;
        }

        // Backoff check
        const backoffRemaining = getBackoffDelay(agente.issue);
        if (backoffRemaining > 0) {
            log("launchAgent: BACKOFF activo #" + agente.issue + " — " + Math.round(backoffRemaining / 1000) + "s restantes");
            return false;
        }

        if (!agente.prompt) agente.prompt = generateDefaultPrompt(agente.issue, agente.slug);

        // Setup worktree
        let wtDir;
        if (agente._reuse_worktree) {
            wtDir = getExpectedWorktreePath(agente);
            if (!fs.existsSync(path.join(wtDir, ".git"))) {
                agente._reuse_worktree = false;
            }
        }
        if (!agente._reuse_worktree) {
            try {
                wtDir = setupWorktree(agente);
            } catch (e) {
                log("launchAgent: setupWorktree fallo #" + agente.issue + ": " + e.message);
                cbRecordFailure(agente.issue);
                return false;
            }
        }

        // Write prompt file
        const logsDir = path.join(SCRIPTS_DIR, "logs");
        try { if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true }); } catch (e) {}
        const promptFile = path.join(logsDir, "prompt_" + agente.numero + ".txt");
        fs.writeFileSync(promptFile, agente.prompt, "utf8");

        // Log files
        const spawnLogPath = path.join(logsDir, "coordinator_spawn_" + agente.numero + ".log");
        const spawnErrPath = path.join(logsDir, "coordinator_spawn_" + agente.numero + ".err");
        const logFd = fs.openSync(spawnLogPath, "w");
        const errFd = fs.openSync(spawnErrPath, "w");

        // GH_TOKEN
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

        const envPath = (process.env.PATH || "") + ";" + GH_CLI_PATH + ";" + path.join(JAVA_HOME_PATH, "bin");
        const childEnv = Object.assign({}, process.env, {
            PATH: envPath,
            JAVA_HOME: JAVA_HOME_PATH,
            GH_TOKEN: ghToken,
            CLAUDE_PROJECT_DIR: wtDir,
        });

        log("launchAgent: spawn node agent-runner.js (model=" + agentModel + ", wt=" + path.basename(wtDir) + ")");

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
        log("Agente #" + agente.issue + " lanzado (PID=" + childPid + ")");

        if (childPid) {
            agente._pid = childPid;
            const agentPidFile = path.join(HOOKS_DIR, "agent-" + agente.issue + ".pid");
            try { fs.writeFileSync(agentPidFile, String(childPid), "utf8"); } catch (e) {}
        }

        cbRecordSuccess(agente.issue);
        emitEvent({ type: "launched", issue: agente.issue, pid: childPid, by: "coordinator" });
        return childPid || true;
    } catch (e) {
        log("launchAgent error: " + e.message);
        cbRecordFailure(agente.issue);
        return false;
    }
}

// ─── Event handlers ──────────────────────────────────────────────────────────

async function handleEvent(evt) {
    log("Event: " + evt.type + " " + JSON.stringify(evt));

    switch (evt.type) {
        case "agent-stopped":
            await handleAgentStopped(evt);
            break;
        case "heartbeat":
            // Heartbeat events are informational — liveness handled by reconcile loop
            break;
        default:
            log("Unknown event type: " + evt.type);
    }
}

async function handleAgentStopped(evt) {
    const plan = loadPlan();
    if (!plan) return;

    const session = evt.session_data || {};
    const branch = evt.branch || session.branch || "";

    if (!branch.startsWith("agent/")) return;

    // Find the agent in the plan
    let finishingAgent = null;
    for (const ag of (plan.agentes || [])) {
        if (branch.includes("/" + String(ag.issue) + "-")) {
            finishingAgent = ag;
            break;
        }
    }

    if (!finishingAgent) {
        log("agent-stopped: no matching agent for branch " + branch);
        return;
    }

    const wasWaiting = finishingAgent.status === "waiting";
    log("agent-stopped: #" + finishingAgent.issue + " (" + finishingAgent.slug + ")" + (wasWaiting ? " [waiting]" : ""));

    // Check PR status
    const agentBranch = branch || ("agent/" + finishingAgent.issue + "-" + finishingAgent.slug);
    const prStatus = checkPRStatus(agentBranch);
    log("PR check " + agentBranch + ": " + prStatus.status);

    // Remove from active agents
    plan.agentes = (plan.agentes || []).filter(ag => ag.issue !== finishingAgent.issue);
    if (!Array.isArray(plan._completed)) plan._completed = [];
    if (!Array.isArray(plan._incomplete)) plan._incomplete = [];

    if (prStatus.status === "merged") {
        const entry = buildCompletedEntry(finishingAgent, null, "ok");
        const validation = validateCompletionCriteria(entry.duracion_min, prStatus, agentBranch);
        if (validation.suspicious) {
            entry.resultado = "suspicious";
            entry.motivo = validation.reason;
            plan._incomplete.push(entry);
            await notify("&#x26A0;&#xFE0F; <b>Agente #" + finishingAgent.issue + " SOSPECHOSO</b>\n" + escHtml(validation.reason));
        } else {
            plan._completed.push(entry);
            await updateProjectV2(finishingAgent.issue, "Done");
            clearBackoff(finishingAgent.issue);
            await notify("&#x2705; <b>Agente #" + finishingAgent.issue + " completado</b>\nPR mergeada · " + escHtml(finishingAgent.slug));
        }
        emitEvent({ type: "completed", issue: finishingAgent.issue, result: prStatus.status });
    } else if (prStatus.status === "open") {
        const waitingEntry = Object.assign({}, finishingAgent, { status: "waiting", resultado: "pending_review" });
        plan.agentes.push(waitingEntry);
        await notify("&#x23F3; <b>Agente #" + finishingAgent.issue + " -- PR abierta</b>\nSlot liberado");
    } else {
        // No PR — decide if retry or incomplete
        const actionCount = session.action_count || 0;
        const runtimeMin = session.started_ts ? (Date.now() - session.started_ts) / 60000 : 0;
        const neverWorked = actionCount < 5 && runtimeMin < 2;

        if (neverWorked) {
            const retryCount = (finishingAgent._retry_count || 0) + 1;
            finishingAgent._retry_count = retryCount;
            if (retryCount >= MAX_RETRIES) {
                const entry = buildCompletedEntry(finishingAgent, null, "failed");
                entry.motivo = "Excedio " + MAX_RETRIES + " reintentos sin trabajar";
                plan._incomplete.push(entry);
                await notify("&#x1F6AB; <b>Agente #" + finishingAgent.issue + " descartado</b>\nExcedio reintentos");
            } else {
                const queue = getQueue(plan);
                queue.push(finishingAgent);
                setQueue(plan, queue);
                recordBackoff(finishingAgent.issue);
                await notify("&#x1F504; <b>Agente #" + finishingAgent.issue + " a cola</b>\nReintento " + retryCount + "/" + MAX_RETRIES);
            }
        } else {
            const entry = buildCompletedEntry(finishingAgent, null, "failed");
            entry.motivo = "Sin PR -- el agente no completo /delivery";
            plan._incomplete.push(entry);
            await notify("&#x26A0;&#xFE0F; <b>Agente #" + finishingAgent.issue + " FALLIDO</b>\nSin PR · " + escHtml(finishingAgent.slug));
        }
        emitEvent({ type: "failed", issue: finishingAgent.issue, reason: prStatus.status });
    }

    // Promote from queue if slots available
    await promoteFromQueue(plan);

    // Save plan (UNICO WRITER)
    savePlan(plan);

    // Clean up PID file
    const pidFile = path.join(HOOKS_DIR, "agent-" + finishingAgent.issue + ".pid");
    try { if (fs.existsSync(pidFile)) fs.unlinkSync(pidFile); } catch (e) {}
}

// ─── Promote from queue ──────────────────────────────────────────────────────

async function promoteFromQueue(plan) {
    const concurrencyLimit = plan.concurrency_limit || DEFAULT_CONCURRENCY_LIMIT;
    const activeCount = (plan.agentes || []).filter(ag => ag.status !== "waiting").length;
    const queue = getQueue(plan);
    const slotsLibres = concurrencyLimit - activeCount;

    if (slotsLibres <= 0 || queue.length === 0) return;

    log("Promote: activos=" + activeCount + "/" + concurrencyLimit + " · cola=" + queue.length + " · slots=" + slotsLibres);

    const toPromote = Math.min(slotsLibres, queue.length);
    for (let i = 0; i < toPromote; i++) {
        const nextAgent = queue.shift();
        const maxNumero = (plan.agentes || []).reduce((m, a) => Math.max(m, a.numero || 0), 0);
        nextAgent.numero = maxNumero + 1;
        if (!nextAgent.prompt) nextAgent.prompt = generateDefaultPrompt(nextAgent.issue, nextAgent.slug);
        nextAgent.status = "promoted";
        nextAgent._promoted_at = new Date().toISOString();
        nextAgent._launched_at = new Date().toISOString();
        nextAgent._pid = null;
        plan.agentes.push(nextAgent);

        // Save plan before launching to persist promoted status
        setQueue(plan, queue);
        savePlan(plan);

        await updateProjectV2(nextAgent.issue, "In Progress");
        const launched = launchAgent(nextAgent);

        if (launched) {
            nextAgent.status = "active";
            savePlan(plan); // Persist _pid
            await notify("&#x1F680; <b>Agente #" + nextAgent.issue + " promovido</b>\n" + escHtml(nextAgent.slug) + "\nSlots: " + (activeCount + i + 1) + "/" + concurrencyLimit);
            emitEvent({ type: "promoted", issue: nextAgent.issue, from: "queue", slot: activeCount + i + 1 });
        } else {
            await notify("&#x26A0;&#xFE0F; <b>#" + nextAgent.issue + " promovido pero no se pudo lanzar</b>");
        }
    }
}

// ─── Zombie session cleanup ──────────────────────────────────────────────────

function markZombieSessions() {
    const ZOMBIE_THRESHOLD_MS = 30 * 60 * 1000;
    try {
        if (!fs.existsSync(SESSIONS_DIR)) return;
        const now = Date.now();
        const files = fs.readdirSync(SESSIONS_DIR).filter(f => f.endsWith(".json"));
        for (const file of files) {
            try {
                const filePath = path.join(SESSIONS_DIR, file);
                const session = JSON.parse(fs.readFileSync(filePath, "utf8"));
                if (session.status !== "active") continue;
                const age = now - new Date(session.last_activity_ts || 0).getTime();
                if (age > ZOMBIE_THRESHOLD_MS && session.pid && !isPidAlive(session.pid)) {
                    session.status = "done";
                    session.completed_at = session.last_activity_ts;
                    fs.writeFileSync(filePath, JSON.stringify(session, null, 2) + "\n", "utf8");
                    log("Zombie: session " + (session.id || file) + " (branch=" + session.branch + ") -> done");
                }
            } catch (e) {}
        }
    } catch (e) {}
}

// ─── Skill timeout detection ─────────────────────────────────────────────────

function loadSkillsTimeout() {
    try {
        if (fs.existsSync(SKILLS_TIMEOUT_FILE))
            return JSON.parse(fs.readFileSync(SKILLS_TIMEOUT_FILE, "utf8"));
    } catch (e) {}
    return { default: 10, qa: 30 };
}

function getCurrentSkillFromSession(agente) {
    try {
        if (!fs.existsSync(SESSIONS_DIR)) return null;
        const branch = "agent/" + agente.issue + "-" + (agente.slug || "");
        const files = fs.readdirSync(SESSIONS_DIR).filter(f => f.endsWith(".json"));
        for (const file of files) {
            try {
                const session = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, file), "utf8"));
                if (session.branch !== branch || session.status === "done") continue;
                const skills = session.skills_invoked || [];
                if (skills.length === 0) return null;
                return skills[skills.length - 1].replace(/^\//, "");
            } catch (e) {}
        }
    } catch (e) {}
    return null;
}

const _timeoutAlertedAt = new Map();

async function checkSkillTimeouts(plan) {
    if (!plan || plan.sprint_cerrado) return;
    const estado = plan.estado || plan.status;
    if (estado && estado !== "activo" && estado !== "active") return;

    const activeAgents = (plan.agentes || []).filter(ag => ag.status !== "waiting" && ag.status !== "promoted");
    if (activeAgents.length === 0) return;

    let registry = { agents: {} };
    try {
        const regFile = path.join(HOOKS_DIR, "agent-registry.json");
        if (fs.existsSync(regFile)) registry = JSON.parse(fs.readFileSync(regFile, "utf8"));
    } catch (e) { return; }

    const timeoutCfg = loadSkillsTimeout();
    const DEFAULT_TIMEOUT_MIN = timeoutCfg.default || 10;
    const now = Date.now();

    for (const ag of activeAgents) {
        const pid = ag._pid;
        if (!pid || !isClaudeProcess(pid)) continue;

        const branch = "agent/" + ag.issue + "-" + (ag.slug || "");
        let registryEntry = null;
        for (const entry of Object.values(registry.agents || {})) {
            if (entry.branch === branch && entry.status === "active") { registryEntry = entry; break; }
        }
        if (!registryEntry || !registryEntry.last_heartbeat) continue;

        const lastHb = new Date(registryEntry.last_heartbeat).getTime();
        if (isNaN(lastHb)) continue;

        const currentSkill = getCurrentSkillFromSession(ag);
        if (!currentSkill) continue;

        const timeoutMin = timeoutCfg[currentSkill] !== undefined ? timeoutCfg[currentSkill] : DEFAULT_TIMEOUT_MIN;
        const elapsedMin = (now - lastHb) / 60000;
        if (elapsedMin < timeoutMin) continue;

        const lastAlert = _timeoutAlertedAt.get(ag.issue) || 0;
        if (now - lastAlert < 5 * 60 * 1000) continue;
        _timeoutAlertedAt.set(ag.issue, now);

        log("SkillTimeout: #" + ag.issue + " skill=" + currentSkill + " elapsed=" + Math.round(elapsedMin) + "min — killing PID " + pid);
        killProcess(pid);

        emitEvent({ type: "skill-timeout", issue: ag.issue, skill: currentSkill, elapsed_min: Math.round(elapsedMin) });

        await notify(
            "&#x23F1;&#xFE0F; <b>Agente #" + ag.issue + ": skill colgado</b>\n" +
            "Skill: <code>" + currentSkill + "</code> · Inactivo: " + Math.round(elapsedMin) + " min\n" +
            "PID " + pid + " terminado"
        );
    }
}

// ─── Sweep waiting agents ────────────────────────────────────────────────────

async function sweepWaitingAgents(plan) {
    const waitingAgents = (plan.agentes || []).filter(ag => ag.status === "waiting");
    if (waitingAgents.length === 0) return 0;
    let freed = 0;

    for (const ag of waitingAgents) {
        const branch = "agent/" + ag.issue + "-" + ag.slug;
        const prStatus = checkPRStatus(branch);

        if (prStatus.status === "merged") {
            plan.agentes = (plan.agentes || []).filter(a => a.issue !== ag.issue);
            if (!Array.isArray(plan._completed)) plan._completed = [];
            plan._completed.push(buildCompletedEntry(ag, null, "ok"));
            freed++;
            await notify("&#x2705; <b>Agente #" + ag.issue + " completado (sweep)</b>\nPR mergeada");
        } else if (prStatus.status === "closed_no_merge") {
            plan.agentes = (plan.agentes || []).filter(a => a.issue !== ag.issue);
            if (!Array.isArray(plan._incomplete)) plan._incomplete = [];
            const entry = buildCompletedEntry(ag, null, "failed");
            entry.motivo = "PR cerrada sin merge";
            plan._incomplete.push(entry);
            freed++;
        }
    }
    return freed;
}

// ─── Main reconciliation cycle ───────────────────────────────────────────────

async function reconcile() {
    const plan = loadPlan();
    if (!plan) return;

    const estado = plan.estado || plan.status;
    if (plan.sprint_cerrado || (estado && estado !== "activo" && estado !== "active" && estado !== "cancelado")) {
        log("Sprint no activo (estado=" + estado + ") — skip");
        return;
    }

    // Sprint cancelado → auto-terminate
    if (estado === "cancelado") {
        log("Sprint cancelado — auto-terminando coordinator");
        await notify("<b>Coordinator: sprint cancelado</b>\nAuto-terminando.");
        process.exit(0);
    }

    if (!Array.isArray(plan._completed)) plan._completed = [];
    if (!Array.isArray(plan._incomplete)) plan._incomplete = [];

    const concurrencyLimit = plan.concurrency_limit || DEFAULT_CONCURRENCY_LIMIT;
    let planDirty = false;

    // 1. Check skill timeouts
    try { await checkSkillTimeouts(plan); } catch (e) { log("checkSkillTimeouts error: " + e.message); }

    // 2. Clean zombie sessions
    markZombieSessions();

    // 3. For each active agent, check liveness
    const activeAgents = (plan.agentes || []).filter(ag => ag.status !== "waiting");
    for (const ag of activeAgents) {
        let alive;
        try { alive = isAgentAlive(ag); } catch (e) { continue; }
        if (alive) continue;

        // Grace period
        if (ag._launched_at) {
            const elapsedMin = (Date.now() - new Date(ag._launched_at).getTime()) / 60000;
            if (elapsedMin < GRACE_PERIOD_MIN) {
                log("Agente #" + ag.issue + ": muerto pero grace period (" + Math.round(elapsedMin) + "/" + GRACE_PERIOD_MIN + " min)");
                continue;
            }
        }

        // Agent is dead — check PR
        const branch = "agent/" + ag.issue + "-" + ag.slug;
        const prStatus = checkPRStatus(branch);
        log("Agente #" + ag.issue + " muerto — PR: " + prStatus.status);

        plan.agentes = (plan.agentes || []).filter(a => a.issue !== ag.issue);
        planDirty = true;

        // Cleanup PID file
        try { if (fs.existsSync(path.join(HOOKS_DIR, "agent-" + ag.issue + ".pid"))) fs.unlinkSync(path.join(HOOKS_DIR, "agent-" + ag.issue + ".pid")); } catch (e) {}

        if (prStatus.status === "merged") {
            const entry = buildCompletedEntry(ag, null, "ok");
            entry.detectado_por = "coordinator";
            const validation = validateCompletionCriteria(entry.duracion_min, prStatus, branch);
            if (validation.suspicious) {
                entry.resultado = "suspicious";
                entry.motivo = validation.reason;
                plan._incomplete.push(entry);
            } else {
                plan._completed.push(entry);
                await updateProjectV2(ag.issue, "Done");
                clearBackoff(ag.issue);
                await notify("&#x2705; <b>Agente #" + ag.issue + " completado (coordinator)</b>\nPR mergeada · " + escHtml(ag.slug));
            }
            emitEvent({ type: "completed", issue: ag.issue, result: "merged", detected_by: "coordinator" });
        } else if (prStatus.status === "open") {
            const waitingEntry = Object.assign({}, ag, { status: "waiting", resultado: "pending_review" });
            plan.agentes.push(waitingEntry);
            await notify("&#x23F3; <b>Agente #" + ag.issue + " — PR abierta (coordinator)</b>\nSlot liberado");
        } else {
            // No PR — retry or incomplete
            const retryCount = ag._retry_count || 0;
            const worktreePath = getExpectedWorktreePath(ag);
            const hasWorktree = fs.existsSync(worktreePath);
            const entry = buildCompletedEntry(ag, null, "failed");
            const runtimeMin = entry.duracion_min || 0;
            const neverWorked = !hasWorktree && runtimeMin < 2;

            if (retryCount < MAX_RETRIES) {
                // Retry with backoff
                ag._retry_count = retryCount + 1;
                ag.status = "promoted";
                ag._promoted_at = new Date().toISOString();
                ag._launched_at = new Date().toISOString();
                ag._pid = null;

                // Agent doctor diagnosis
                if (agentDoctor) {
                    try {
                        const doctorResult = agentDoctor.handleDeadAgent(ag, REPO_ROOT, HOOKS_DIR);
                        if (doctorResult.recovery.success && !doctorResult.shouldRelaunch) {
                            plan._completed.push(buildCompletedEntry(ag, null, "completed"));
                            savePlan(plan);
                            await notify(agentDoctor.buildDiagnosisNotification(ag, doctorResult.diagnosis, doctorResult.recovery));
                            continue;
                        }
                        ag.prompt = agentDoctor.buildDoctorRetryPrompt(ag.prompt || generateDefaultPrompt(ag.issue, ag.slug), ag, doctorResult.diagnosis);
                        if (doctorResult.diagnosis.localCommitCount > 0 && doctorResult.diagnosis.worktreeExists) {
                            ag._reuse_worktree = true;
                        }
                    } catch (e) { log("agent-doctor error: " + e.message); }
                }

                plan.agentes.push(ag);
                recordBackoff(ag.issue);
                savePlan(plan);
                planDirty = false;

                const launched = launchAgent(ag);
                if (ag._pid) savePlan(plan);

                await notify(
                    "&#x1F504; <b>Agente #" + ag.issue + " relanzado (intento " + ag._retry_count + "/" + MAX_RETRIES + ")</b>\n" +
                    escHtml(ag.slug) + " · " + (launched ? "spawn ok" : "spawn fallido")
                );
                emitEvent({ type: "relaunched", issue: ag.issue, retry: ag._retry_count });
            } else {
                // Max retries exceeded
                entry.detectado_por = "coordinator";
                entry.motivo = neverWorked
                    ? "Excedio " + MAX_RETRIES + " reintentos sin trabajar"
                    : "Sin PR tras " + MAX_RETRIES + " reintentos";
                plan._incomplete.push(entry);
                await notify("&#x1F6AB; <b>Agente #" + ag.issue + " descartado</b>\n" + escHtml(entry.motivo));
                emitEvent({ type: "exhausted", issue: ag.issue, retries: MAX_RETRIES });
            }
        }
    }

    // 4. Reconcile promoted agents without PID
    const PROMOTED_TIMEOUT_MS = 5 * 60 * 1000;
    const promotedAgents = (plan.agentes || []).filter(ag => ag.status === "promoted" && !ag._pid);
    for (const ag of promotedAgents) {
        const promotedAt = ag._promoted_at ? new Date(ag._promoted_at).getTime() : 0;
        if (Date.now() - promotedAt < PROMOTED_TIMEOUT_MS) continue;

        const retryCount = ag._retry_count || 0;
        if (retryCount >= MAX_RETRIES) {
            plan.agentes = plan.agentes.filter(a => a.issue !== ag.issue);
            plan._incomplete.push(Object.assign(buildCompletedEntry(ag, null, "failed"), {
                detectado_por: "coordinator", motivo: "Promoted sin lanzamiento tras " + MAX_RETRIES + " reintentos"
            }));
            planDirty = true;
            continue;
        }

        ag._retry_count = retryCount + 1;
        ag._promoted_at = new Date().toISOString();
        planDirty = true;
        savePlan(plan);
        const launched = launchAgent(ag);
        if (ag._pid) savePlan(plan);
    }

    // 5. Sweep waiting agents periodically
    const sweepFreed = await sweepWaitingAgents(plan);
    if (sweepFreed > 0) planDirty = true;

    // 6. Promote from queue
    await promoteFromQueue(plan);

    // 7. Save if dirty
    if (planDirty) savePlan(plan);

    // 8. Check sprint completion
    const remainingActive = (plan.agentes || []).filter(ag => ag.status !== "waiting").length;
    const remainingQueue = getQueue(plan).length;
    const waitingCount = (plan.agentes || []).filter(ag => ag.status === "waiting").length;

    if (remainingActive === 0 && remainingQueue === 0 && waitingCount === 0) {
        log("Sprint completado — todos los agentes terminaron");
        await notify(
            "&#x2705; <b>Sprint completado (coordinator)</b>\n" +
            "Completados: " + (plan._completed || []).length + " · Incompletos: " + (plan._incomplete || []).length
        );
        process.exit(0);
    }

    // Auto-shutdown if only waiting agents remain for too long
    if (remainingActive === 0 && remainingQueue === 0 && waitingCount > 0) {
        if (!global._idleSince) global._idleSince = Date.now();
        const idleMin = Math.round((Date.now() - global._idleSince) / 60000);
        if (idleMin > 15) {
            await notify("&#x23F9;&#xFE0F; <b>Coordinator auto-shutdown (idle " + idleMin + " min)</b>\n" + waitingCount + " agente(s) en waiting");
            process.exit(0);
        }
    } else {
        global._idleSince = null;
    }

    // Rotate events log
    rotateEventsIfNeeded();
}

// ─── Main loop ───────────────────────────────────────────────────────────────

async function main() {
    checkSingleInstance();
    log("Coordinator iniciado (PID=" + process.pid + ", repo=" + REPO_ROOT + ")");

    // Initialize events file
    if (!fs.existsSync(EVENTS_FILE)) {
        fs.writeFileSync(EVENTS_FILE, "", "utf8");
    }
    _lastEventsSize = fs.statSync(EVENTS_FILE).size;

    // Kill old watcher if running
    const oldWatcherPid = path.join(HOOKS_DIR, "agent-watcher.pid");
    try {
        if (fs.existsSync(oldWatcherPid)) {
            const pid = parseInt(fs.readFileSync(oldWatcherPid, "utf8").trim(), 10);
            if (pid && isPidAlive(pid)) {
                log("Matando watcher legacy (PID " + pid + ")");
                killProcess(pid);
            }
            fs.unlinkSync(oldWatcherPid);
        }
    } catch (e) {}

    await notify("<b>Agent Coordinator iniciado</b>\nPID: " + process.pid + "\nEvent-driven · Heartbeat-based · Circuit breaker activo");

    // Initial reconciliation
    await reconcile();

    // Watch for new events (event-driven)
    let watcher = null;
    try {
        watcher = fs.watch(EVENTS_FILE, { persistent: true }, async (eventType) => {
            if (eventType === "change") {
                const events = readNewEvents();
                for (const evt of events) {
                    try { await handleEvent(evt); } catch (e) { log("handleEvent error: " + e.message); }
                }
            }
        });
        log("fs.watch activo sobre agent-events.jsonl");
    } catch (e) {
        log("fs.watch no disponible — usando fallback polling cada " + EVENT_POLL_MS + "ms");
    }

    // Fallback event polling (also catches events missed by fs.watch)
    setInterval(async () => {
        const events = readNewEvents();
        for (const evt of events) {
            try { await handleEvent(evt); } catch (e) { log("handleEvent error: " + e.message); }
        }
    }, EVENT_POLL_MS);

    // Periodic reconciliation (catch-all for anything events miss)
    setInterval(async () => {
        try { await reconcile(); } catch (e) { log("reconcile error: " + e.message); }
    }, RECONCILE_INTERVAL_MS);

    // Graceful shutdown
    process.on("SIGINT", async () => {
        log("SIGINT recibido — cerrando coordinator");
        if (watcher) watcher.close();
        await notify("<b>Coordinator detenido</b> (SIGINT)");
        process.exit(0);
    });
    process.on("SIGTERM", async () => {
        log("SIGTERM recibido — cerrando coordinator");
        if (watcher) watcher.close();
        process.exit(0);
    });
}

main().catch(e => {
    log("FATAL: " + e.message + "\n" + e.stack);
    process.exit(1);
});
