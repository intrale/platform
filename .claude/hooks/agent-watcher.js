// agent-watcher.js — Watcher externo para promoción automática de agentes
// desde _queue[] cuando agentes en worktrees terminan (#1441)
//
// Problema que resuelve:
//   agent-concurrency-check.js solo se dispara cuando el hook Stop corre en el
//   proceso que termina (el worktree del agente). Cuando un agente en un worktree
//   termina, su Stop hook no ve los otros agentes ni puede promover de _queue[].
//   Este watcher corre independientemente, monitorea todos los agentes y actúa.
//
// Ejecución: node agent-watcher.js (proceso background)
// Lanzado por: Start-Agente.ps1 all
// Lock file: .claude/hooks/agent-watcher.pid
// Log: .claude/hooks/agent-watcher.log
// Configuración: WATCHER_POLL_INTERVAL (ms, default 60000)
"use strict";

const fs = require("fs");
const path = require("path");
const { spawn, execSync } = require("child_process");

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
const LOCK_FILE = PLAN_FILE + ".lock";
const PID_FILE = path.join(HOOKS_DIR, "agent-watcher.pid");
const LOG_FILE = path.join(HOOKS_DIR, "agent-watcher.log");
const START_SCRIPT = path.join(SCRIPTS_DIR, "Start-Agente.ps1");
const SESSIONS_DIR = path.join(REPO_ROOT, ".claude", "sessions");
const WORKTREES_PARENT = path.dirname(REPO_ROOT);

const POLL_INTERVAL_MS = parseInt(process.env.WATCHER_POLL_INTERVAL || "60000", 10);
const LOCK_TIMEOUT_MS = 8000;
const LOCK_RETRY_MS = 300;
const DEFAULT_CONCURRENCY_LIMIT = 3;

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

// ─── Helpers de plan ──────────────────────────────────────────────────────────

function loadPlan() {
    try {
        if (!fs.existsSync(PLAN_FILE)) return null;
        return JSON.parse(fs.readFileSync(PLAN_FILE, "utf8"));
    } catch (e) {
        log("loadPlan error: " + e.message);
        return null;
    }
}

function savePlan(plan) {
    const tmpFile = PLAN_FILE + ".tmp." + process.pid;
    fs.writeFileSync(tmpFile, JSON.stringify(plan, null, 2) + "\n", "utf8");
    try {
        if (fs.existsSync(PLAN_FILE)) fs.unlinkSync(PLAN_FILE);
        fs.renameSync(tmpFile, PLAN_FILE);
    } catch (e) {
        try { fs.unlinkSync(tmpFile); } catch (e2) {}
        fs.writeFileSync(PLAN_FILE, JSON.stringify(plan, null, 2) + "\n", "utf8");
    }
}

function acquireLock() {
    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    while (Date.now() < deadline) {
        try {
            fs.writeFileSync(LOCK_FILE, String(process.pid), { flag: "wx" });
            return true;
        } catch (e) {
            try {
                const lockPid = parseInt(fs.readFileSync(LOCK_FILE, "utf8"), 10);
                if (lockPid && lockPid !== process.pid) {
                    try { process.kill(lockPid, 0); } catch (ke) {
                        fs.writeFileSync(LOCK_FILE, String(process.pid), { flag: "w" });
                        return true;
                    }
                }
            } catch (e2) {}
            const wait = Date.now() + LOCK_RETRY_MS;
            while (Date.now() < wait) {}
        }
    }
    log("acquireLock timeout — procediendo sin lock (fail-open)");
    return false;
}

function releaseLock() {
    try { fs.unlinkSync(LOCK_FILE); } catch (e) {}
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

function escHtml(str) {
    return (str || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ─── Telegram ─────────────────────────────────────────────────────────────────

let tgClient = null;
try { tgClient = require("./telegram-client"); } catch (e) {}

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
 *  1. PID en sprint-pids.json → tasklist
 *  2. Sesión activa en .claude/sessions/ con status "active" + PID vivo
 *  3. Sin evidencia de actividad → asumir muerto (fail-safe para promover)
 */
function isAgentAlive(agente) {
    // Método 1: PID desde sprint-pids.json
    const pids = loadSprintPids();
    const pidKey = "agente_" + agente.numero;
    const pid = pids[pidKey];
    if (pid) {
        const alive = isPidAlive(pid);
        log("isAgentAlive #" + agente.issue + ": PID " + pid + " → " + (alive ? "vivo" : "muerto"));
        return alive;
    }

    // Método 2: sesión activa en .claude/sessions/
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
                            const alive = isPidAlive(sessionPid);
                            log("isAgentAlive #" + agente.issue + ": sesión activa, PID " + sessionPid + " → " + (alive ? "vivo" : "muerto"));
                            return alive;
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

// ─── Lanzar agente via Start-Agente.ps1 ──────────────────────────────────────

function launchAgent(agente) {
    try {
        if (!fs.existsSync(START_SCRIPT)) {
            log("Start-Agente.ps1 no encontrado: " + START_SCRIPT);
            return false;
        }
        if (!agente.prompt) {
            agente.prompt = generateDefaultPrompt(agente.issue, agente.slug);
        }

        const ps1 = START_SCRIPT.replace(/\//g, "\\");
        const args = ["-NonInteractive", "-File", ps1, String(agente.numero), "-Force"];

        const logsDir = path.join(SCRIPTS_DIR, "logs");
        try { if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true }); } catch (e) {}

        const spawnLogPath = path.join(logsDir, "watcher_spawn_" + agente.numero + ".log");
        const spawnErrPath = path.join(logsDir, "watcher_spawn_" + agente.numero + ".err");
        let logFd, errFd, stdio = "ignore";
        try {
            logFd = fs.openSync(spawnLogPath, "w");
            errFd = fs.openSync(spawnErrPath, "w");
            stdio = ["ignore", logFd, errFd];
        } catch (e) {
            log("WARN: No se pudo abrir logs de spawn: " + e.message);
        }

        const child = spawn("powershell.exe", args, { detached: true, stdio, windowsHide: false });
        child.unref();
        if (logFd !== undefined) { try { fs.closeSync(logFd); } catch (e) {} }
        if (errFd !== undefined) { try { fs.closeSync(errFd); } catch (e) {} }

        log("Agente #" + agente.issue + " lanzado (numero=" + agente.numero + ", PID hijo=" + child.pid + ")");
        log("  stdout → " + spawnLogPath);
        return true;
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

// ─── buildCompletedEntry ──────────────────────────────────────────────────────

function buildCompletedEntry(agente, resultado) {
    return {
        issue: agente.issue,
        slug: agente.slug,
        titulo: agente.titulo || "",
        numero: agente.numero,
        stream: agente.stream || "",
        size: agente.size || "",
        resultado: resultado,
        duracion_min: 0,
        issue_reabierto: null,
        completado_at: new Date().toISOString(),
        detectado_por: "agent-watcher"
    };
}

// ─── Ciclo principal ──────────────────────────────────────────────────────────

async function runCycle() {
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
    const locked = acquireLock();
    try {
        // Releer dentro del lock para consistencia
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

            // Agente muerto: verificar PR
            const branch = "agent/" + ag.issue + "-" + ag.slug;
            const prStatus = checkPRStatus(branch);
            log("Agente #" + ag.issue + " muerto — PR status: " + prStatus.status);

            // Remover del array agentes
            freshPlan.agentes = (freshPlan.agentes || []).filter(a => a.issue !== ag.issue);
            planDirty = true;

            if (prStatus.status === "merged" || prStatus.status === "open") {
                // PR mergeada o abierta → completado (ok)
                const entry = buildCompletedEntry(ag, "ok");
                freshPlan._completed.push(entry);
                log("Agente #" + ag.issue + " → _completed (PR " + prStatus.status + ")");

                await updateProjectV2(ag.issue, "Done");
                await notify(
                    "✅ <b>Agente #" + ag.issue + " completado (watcher)</b>\n" +
                    "PR: " + prStatus.status + " · Slug: " + escHtml(ag.slug) + "\n" +
                    "<i>Slot liberado · verificando cola...</i>"
                );
            } else {
                // Sin PR o cerrada sin merge → incompleto
                const motivo = prStatus.status === "unknown"
                    ? "No se pudo verificar PR (gh CLI falló)"
                    : prStatus.status === "closed_no_merge"
                        ? "PR cerrada sin merge"
                        : "Sin PR — el agente no completó /delivery";
                const entry = buildCompletedEntry(ag, "failed");
                entry.motivo = motivo;
                freshPlan._incomplete.push(entry);
                log("Agente #" + ag.issue + " → _incomplete (" + prStatus.status + "): " + motivo);

                await notify(
                    "⚠️ <b>Agente #" + ag.issue + " terminó sin PR (watcher)</b>\n" +
                    "Slug: " + escHtml(ag.slug) + " · PR: " + prStatus.status + "\n" +
                    "Motivo: " + escHtml(motivo)
                );
            }
        }

        // 4. Contar slots disponibles y promover desde cola
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
                freshPlan.agentes.push(nextAgent);
            }

            savePlan(freshPlan);
            planDirty = false;
            log("Plan guardado con " + toPromote.length + " agente(s) promovido(s)");

            // Lanzar cada agente promovido
            for (const nextAgent of toPromote) {
                await updateProjectV2(nextAgent.issue, "In Progress");
                const launched = launchAgent(nextAgent);
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

    } finally {
        if (locked) releaseLock();
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
