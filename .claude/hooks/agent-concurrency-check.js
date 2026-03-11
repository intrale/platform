// agent-concurrency-check.js — Hook Stop: valida concurrencia de agentes y auto-lanza siguiente (#1277, #1356)
// Se ejecuta al finalizar cualquier sesión Claude.
// Solo actúa si la sesión corresponde a un agente de sprint (rama agent/* en sprint-plan.json).
//
// Lógica:
//   1. Detectar si la sesión que termina es de sprint
//   2. Remover al agente que terminó del array agentes
//   3. Comparar agentes ACTIVOS (no-waiting) restantes vs concurrency_limit
//      Los agentes en status="waiting" no cuentan contra el límite (#1356)
//   4. Si hay espacio Y hay items en cola: mover primero de cola a agentes + lanzar
//   5. Si se excede el límite: alerta crítica a Telegram
//   6. Siempre: log detallado en hook-debug.log
//
// Pure Node.js — sin dependencia de bash
"use strict";

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

// Bug fix (#1266): Resolver el repo principal desde worktrees.
// Cuando el hook se ejecuta en un worktree (agent/*), CLAUDE_PROJECT_DIR
// puede apuntar al worktree vacío. Usamos git worktree list para encontrar
// el repo principal (siempre el primer item de la lista).
function resolveMainRepoRoot() {
    const envRoot = process.env.CLAUDE_PROJECT_DIR || "C:\\Workspaces\\Intrale\\platform";
    try {
        const { execSync } = require("child_process");
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
            // Convertir path POSIX a Windows si aplica
            return mainPath.replace(/^\/([a-z])\//, "$1:\\").replace(/\//g, "\\");
        }
    } catch (e) {
        // Si git falla (ej: directorio vacío sin .git), usar el fallback
    }
    // Fallback: si el repo apunta al worktree vacío, usar el repo por defecto
    const planFile = path.join(envRoot, "scripts", "sprint-plan.json");
    if (!fs.existsSync(planFile)) {
        return "C:\\Workspaces\\Intrale\\platform";
    }
    return envRoot;
}

const REPO_ROOT = resolveMainRepoRoot();
const HOOKS_DIR = path.join(REPO_ROOT, ".claude", "hooks");
const LOG_FILE = path.join(HOOKS_DIR, "hook-debug.log");
const SESSIONS_DIR = path.join(REPO_ROOT, ".claude", "sessions");
const PLAN_FILE = path.join(REPO_ROOT, "scripts", "sprint-plan.json");
const LOCK_FILE = PLAN_FILE + ".lock";
const START_SCRIPT = path.join(REPO_ROOT, "scripts", "Start-Agente.ps1");

const DEFAULT_CONCURRENCY_LIMIT = 3;
const LOCK_TIMEOUT_MS = 8000;
const LOCK_RETRY_MS = 300;

// ─── Logging ────────────────────────────────────────────────────────────────

function log(msg) {
    try {
        fs.appendFileSync(LOG_FILE, "[" + new Date().toISOString() + "] ConcurrencyCheck: " + msg + "\n");
    } catch (e) {}
}

// ─── Telegram (via telegram-client.js si disponible, fallback directo) ──────

let tgClient = null;
try { tgClient = require("./telegram-client"); } catch (e) { tgClient = null; }

async function notify(text) {
    if (tgClient) {
        try { await tgClient.sendMessage(text); return; } catch (e) { log("tgClient.sendMessage error: " + e.message); }
    }
    // Fallback: HTTP directo
    try {
        const cfg = JSON.parse(fs.readFileSync(path.join(HOOKS_DIR, "telegram-config.json"), "utf8"));
        const https = require("https");
        const querystring = require("querystring");
        const postData = querystring.stringify({ chat_id: cfg.chat_id, text: text, parse_mode: "HTML" });
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
    } catch (e) { log("notify fallback error: " + e.message); }
}

function escHtml(str) {
    return (str || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ─── Lock file para escritura atómica de sprint-plan.json ───────────────────

function acquireLock() {
    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    while (Date.now() < deadline) {
        try {
            fs.writeFileSync(LOCK_FILE, String(process.pid), { flag: "wx" });
            return true;
        } catch (e) {
            // Verificar si el lock es de un proceso muerto
            try {
                const lockPid = parseInt(fs.readFileSync(LOCK_FILE, "utf8"), 10);
                if (lockPid && lockPid !== process.pid) {
                    try { process.kill(lockPid, 0); } catch (killErr) {
                        // Proceso muerto — robar el lock
                        fs.writeFileSync(LOCK_FILE, String(process.pid), { flag: "w" });
                        return true;
                    }
                }
            } catch (e2) {}
            // Esperar antes de reintentar (sync spin — el hook es corto)
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

// ─── Detección de sesiones zombie (#1408) ────────────────────────────────────

const ZOMBIE_THRESHOLD_MS = 20 * 60 * 1000; // 20 minutos (threshold configurable)

// Verifica si un PID de proceso sigue vivo en Windows
function isPidAlive(pid) {
    if (!pid) return false;
    try {
        const { execSync } = require("child_process");
        const output = execSync('tasklist /FI "PID eq ' + parseInt(pid, 10) + '" /NH', {
            timeout: 3000, windowsHide: true, encoding: "utf8"
        });
        return output.indexOf("No tasks") === -1 && output.trim().length > 0;
    } catch (e) {
        try { process.kill(parseInt(pid, 10), 0); return true; } catch (ke) { return ke.code === "EPERM"; }
    }
}

/**
 * Marca sesiones zombie como done y retorna el Set de issue numbers afectados.
 * Idempotente: ejecutar 2 veces no causa problemas.
 * Solo actualiza status — NO mata procesos.
 */
function markZombieSessions() {
    const zombieIssues = new Set();
    try {
        if (!fs.existsSync(SESSIONS_DIR)) return zombieIssues;
        const now = Date.now();
        const files = fs.readdirSync(SESSIONS_DIR).filter(f => f.endsWith(".json"));
        for (const file of files) {
            try {
                const filePath = path.join(SESSIONS_DIR, file);
                const session = JSON.parse(fs.readFileSync(filePath, "utf8"));
                if (session.status !== "active") continue;
                const age = now - new Date(session.last_activity_ts || 0).getTime();
                if (age > ZOMBIE_THRESHOLD_MS && session.pid) {
                    if (!isPidAlive(session.pid)) {
                        session.status = "done";
                        session.completed_at = session.last_activity_ts;
                        fs.writeFileSync(filePath, JSON.stringify(session, null, 2) + "\n", "utf8");
                        // Extraer issue number del branch para excluirlo del conteo de slots
                        const branchMatch = (session.branch || "").match(/\/(\d+)-/);
                        if (branchMatch) zombieIssues.add(parseInt(branchMatch[1], 10));
                        log("Zombie detectado: sesion " + (session.id || file) + " (branch=" + session.branch + ", PID=" + session.pid + " muerto) → done");
                    }
                }
            } catch(e) { /* ignorar errores por archivo */ }
        }
    } catch(e) { log("markZombieSessions error: " + e.message); }
    return zombieIssues;
}

// ─── Leer/escribir sprint-plan.json ─────────────────────────────────────────

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
    // Escribir a archivo temporal, luego renombrar (atómico en NTFS best-effort)
    const tmpFile = PLAN_FILE + ".tmp." + process.pid;
    fs.writeFileSync(tmpFile, JSON.stringify(plan, null, 2) + "\n", "utf8");
    try {
        // En Windows, rename falla si el destino existe — borrar primero
        if (fs.existsSync(PLAN_FILE)) fs.unlinkSync(PLAN_FILE);
        fs.renameSync(tmpFile, PLAN_FILE);
    } catch (e) {
        // Fallback: sobrescribir directamente
        try { fs.unlinkSync(tmpFile); } catch (e2) {}
        fs.writeFileSync(PLAN_FILE, JSON.stringify(plan, null, 2) + "\n", "utf8");
    }
}

// ─── Detectar sesión de sprint ───────────────────────────────────────────────

function loadSession(sessionId) {
    if (!sessionId) return null;
    try {
        const shortId = sessionId.substring(0, 8);
        const sessionFile = path.join(SESSIONS_DIR, shortId + ".json");
        if (!fs.existsSync(sessionFile)) return null;
        return JSON.parse(fs.readFileSync(sessionFile, "utf8"));
    } catch (e) { return null; }
}

/**
 * Encuentra el agente del plan que corresponde a la sesión que termina.
 * Usa coincidencia exacta de issue# en el branch: /1277-
 */
function findFinishingAgent(plan, session) {
    if (!session || !session.branch) return null;
    const branch = session.branch;
    for (const ag of (plan.agentes || [])) {
        // Coincidencia exacta: "/<issue>-" para evitar falsos positivos (ej: 12 dentro de 1234)
        if (branch.includes("/" + String(ag.issue) + "-") || branch === "agent/" + ag.issue + "-" + ag.slug) {
            return ag;
        }
    }
    return null;
}

/**
 * Retorna la cola de agentes pendientes.
 * Soporta campo 'cola' (generado por auto-plan-sprint.js) y '_queue' (alias alternativo).
 */
function getQueue(plan) {
    if (Array.isArray(plan._queue) && plan._queue.length > 0) return plan._queue;
    if (Array.isArray(plan.cola) && plan.cola.length > 0) return plan.cola;
    return [];
}

function setQueue(plan, newQueue) {
    if (Array.isArray(plan._queue)) {
        plan._queue = newQueue;
    } else {
        plan.cola = newQueue;
    }
}

// ─── Actualizar Project V2 via project-utils.js ─────────────────────────────

let projectUtils = null;
try { projectUtils = require("./project-utils"); } catch (e) { log("project-utils no disponible: " + e.message); }

async function updateProjectV2(issue, statusName) {
    if (!projectUtils) {
        log("project-utils no cargado — skip Project V2 update para #" + issue);
        return;
    }
    try {
        const token = projectUtils.getGitHubToken();
        const statusId = projectUtils.STATUS_OPTIONS[statusName];
        if (!statusId) {
            log("Status desconocido: " + statusName + " — skip Project V2 update para #" + issue);
            return;
        }
        const itemId = await projectUtils.addAndSetStatus(token, issue, statusId);
        log("Project V2 actualizado: #" + issue + " → " + statusName + " (item " + itemId + ")");
    } catch (e) {
        log("updateProjectV2 error para #" + issue + ": " + e.message);
    }
}

// ─── Lanzar agente via Start-Agente.ps1 (detached) ──────────────────────────

function generateDefaultPrompt(issue, slug) {
    return (
        `Implementar issue #${issue}. ` +
        `Leer el issue completo con: gh issue view ${issue} --repo intrale/platform. ` +
        `Al iniciar: invocar /po para revisar criterios de aceptación del issue #${issue}. ` +
        `Si el issue menciona libs, patrones o frameworks nuevos: invocar /guru para investigación técnica. ` +
        `Completar los cambios descritos en el body del issue. ` +
        `Antes de /delivery: invocar /tester para verificar que los tests pasan. ` +
        `Antes de /delivery: invocar /security para validar seguridad del diff. ` +
        `Usar /delivery para commit+PR al terminar. Closes #${issue}`
    );
}

function launchAgent(agente) {
    try {
        if (!fs.existsSync(START_SCRIPT)) {
            log("Start-Agente.ps1 no encontrado en: " + START_SCRIPT);
            return false;
        }

        // Asegurar que el agente tiene prompt
        if (!agente.prompt) {
            agente.prompt = generateDefaultPrompt(agente.issue, agente.slug);
        }

        const ps1 = START_SCRIPT.replace(/\//g, "\\");
        const args = [
            "-NonInteractive",
            "-File", ps1,
            String(agente.numero),
            "-Force"  // #1399: forzar worktree fresco desde origin/main para agentes promovidos
        ];

        log("Lanzando agente " + agente.numero + " (issue #" + agente.issue + ") via PowerShell...");

        // Bug 2: Redirigir stdout+stderr a archivo de log para capturar errores del spawn (#1345)
        // Antes: stdio: "ignore" — descartaba toda salida y no había forma de diagnosticar fallos
        const logsDir = path.join(REPO_ROOT, "scripts", "logs");
        try { if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true }); } catch (e) {}
        const spawnLogPath = path.join(logsDir, "spawn_agente_" + agente.numero + ".log");
        let logFd;
        let stdio = "ignore";
        try {
            logFd = fs.openSync(spawnLogPath, "w");
            stdio = ["ignore", logFd, logFd];
        } catch (e) {
            log("No se pudo abrir log de spawn: " + e.message + " — usando stdio:ignore");
        }

        const child = spawn("powershell.exe", args, {
            detached: true,
            stdio: stdio,
            windowsHide: false
        });
        child.unref();
        // Cerrar el fd del padre — el hijo ya tiene su copia duplicada
        if (logFd !== undefined) { try { fs.closeSync(logFd); } catch (e) {} }

        log("Agente " + agente.numero + " lanzado (PID hijo " + child.pid + ") — log: " + spawnLogPath);
        return true;
    } catch (e) {
        log("launchAgent error: " + e.message);
        return false;
    }
}

// ─── Construir entrada enriquecida para _completed ──────────────────────────

/**
 * Construye el objeto que se agrega a plan._completed / plan._incomplete cuando un agente termina.
 * Calcula duración a partir de los datos de la sesión.
 *
 * @param {object} agente - Agente del plan
 * @param {object|null} session - Sesión de Claude (puede ser null)
 * @param {string} resultado - "ok" | "failed" | "pending_review" | "not_planned"
 * duracion_min: duración en minutos (started_ts → last_activity_ts), 0 si no disponible
 * issue_reabierto: nulo siempre aquí (se actualiza por post-issue-close.js si aplica)
 */
function buildCompletedEntry(agente, session, resultado) {
    let duracion_min = 0;
    if (!resultado) resultado = session ? "ok" : "not_planned";

    if (session) {
        const started = session.started_ts || 0;
        const last = session.last_activity_ts || 0;
        if (started && last && last > started) {
            duracion_min = Math.round((last - started) / 60000);
        }
    }

    return {
        issue: agente.issue,
        slug: agente.slug,
        titulo: agente.titulo || "",
        numero: agente.numero,
        stream: agente.stream || "",
        size: agente.size || "",
        resultado: resultado,
        duracion_min: duracion_min,
        issue_reabierto: null,
        completado_at: new Date().toISOString()
    };
}

/**
 * Verifica el estado de la PR para una rama usando gh CLI.
 * Retorna: { status: "merged" | "open" | "closed_no_merge" | "none" | "unknown" }
 * - "merged"         : PR existe y fue mergeada
 * - "open"           : PR existe y está abierta (pendiente de review)
 * - "closed_no_merge": PR existe pero fue cerrada sin merge
 * - "none"           : no existe ninguna PR para la rama
 * - "unknown"        : error al consultar (gh CLI no disponible, timeout, etc.)
 */
function checkPRStatus(branch) {
    try {
        const { execSync } = require("child_process");
        // Buscar gh en múltiples ubicaciones
        const ghCandidates = [
            "C:\\Workspaces\\gh-cli\\bin\\gh.exe",
            "gh"
        ];
        let ghCmd = null;
        for (const candidate of ghCandidates) {
            try {
                execSync(`"${candidate}" --version`, { encoding: "utf8", timeout: 3000, windowsHide: true });
                ghCmd = candidate;
                break;
            } catch (e) {}
        }
        if (!ghCmd) {
            log("checkPRStatus: gh CLI no encontrado");
            return { status: "unknown" };
        }
        const cmd = `"${ghCmd}" pr list --repo intrale/platform --head "${branch}" --state all --json number,state`;
        const output = execSync(cmd, {
            encoding: "utf8",
            timeout: 15000,
            windowsHide: true
        });
        const prs = JSON.parse(output || "[]");
        if (!Array.isArray(prs) || prs.length === 0) return { status: "none", prs: [] };
        const merged = prs.find(pr => pr.state === "MERGED");
        if (merged) return { status: "merged", prs };
        const open = prs.find(pr => pr.state === "OPEN");
        if (open) return { status: "open", prs };
        // PR existe pero fue cerrada sin merge
        return { status: "closed_no_merge", prs };
    } catch (e) {
        log("checkPRStatus error: " + e.message);
        return { status: "unknown" };
    }
}

// ─── Leer stdin (evento Stop de Claude) ─────────────────────────────────────

const MAX_READ = 4096;
let rawInput = "";
let done = false;

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
    if (done) return;
    rawInput += chunk;
    if (rawInput.length >= MAX_READ) { done = true; process.stdin.destroy(); processInput(); }
});
process.stdin.on("end", () => { if (!done) { done = true; processInput(); } });
process.stdin.on("error", () => { if (!done) { done = true; processInput(); } });
setTimeout(() => { if (!done) { done = true; try { process.stdin.destroy(); } catch (e) {} processInput(); } }, 3000);

// ─── Lógica principal ────────────────────────────────────────────────────────

async function processInput() {
    log("Iniciando check de concurrencia...");

    let data;
    try { data = JSON.parse(rawInput); } catch (e) {
        log("JSON parse failed — abortando");
        return;
    }

    if (data.stop_hook_active) {
        log("stop_hook_active=true — abortando para evitar recursión");
        return;
    }

    const sessionId = data.session_id || "";
    const session = loadSession(sessionId);

    // Verificar si es sesión de sprint antes de cargar el plan
    if (!session || !session.branch) {
        log("No hay branch en la sesión — no es sesión de sprint");
        return;
    }

    if (!session.branch.startsWith("agent/")) {
        log("Branch no es agent/* (" + session.branch + ") — no es sesión de sprint");
        return;
    }

    // Cargar plan
    if (!fs.existsSync(PLAN_FILE)) {
        log("sprint-plan.json no existe — nada que hacer");
        return;
    }

    // Bug 4: Adquirir lock ANTES de leer+modificar para prevenir race conditions (#1345)
    // Si dos agentes terminan simultáneamente, el segundo espera al primero.
    // fail-open: si el lock no se puede adquirir (timeout), se continúa con advertencia.
    const locked = acquireLock();
    if (!locked) {
        log("ADVERTENCIA: Operando sin lock — posible race condition si otro hook terminó simultáneamente");
    }
    let plan;
    try {
        plan = loadPlan();
        if (!plan) {
            log("No se pudo cargar sprint-plan.json");
            return;
        }

        const concurrencyLimit = plan.concurrency_limit || DEFAULT_CONCURRENCY_LIMIT;
        const finishingAgent = findFinishingAgent(plan, session);

        if (!finishingAgent) {
            log("Sesión branch=" + session.branch + " no coincide con ningún agente del plan — omitiendo");
            return;
        }

        const wasWaiting = finishingAgent.status === "waiting";
        log(
            "Agente que finaliza: #" + finishingAgent.issue + " (" + finishingAgent.slug + ")" +
            (wasWaiting ? " [estaba en waiting]" : "")
        );

        // ── Verificar PR del agente que terminó (#1399) ──────────────────────
        const agentBranch = session.branch || ("agent/" + finishingAgent.issue + "-" + finishingAgent.slug);
        const prStatus = checkPRStatus(agentBranch);
        log("PR check para " + agentBranch + ": " + prStatus.status);

        // Remover al agente que terminó del array agentes
        plan.agentes = (plan.agentes || []).filter(ag => ag.issue !== finishingAgent.issue);

        // ── Decidir destino según PR status ──────────────────────────────────
        if (!Array.isArray(plan._completed)) plan._completed = [];
        if (!Array.isArray(plan._incomplete)) plan._incomplete = [];

        if (prStatus.status === "merged") {
            // PR mergeada → _completed con resultado "ok"
            const completedEntry = buildCompletedEntry(finishingAgent, session, "ok");
            plan._completed.push(completedEntry);
            log("Agente #" + finishingAgent.issue + " → _completed (PR mergeada, duracion=" + completedEntry.duracion_min + "m)");
            await notify(
                "✅ <b>Agente #" + finishingAgent.issue + " completado</b>\n" +
                "PR mergeada · Slug: " + escHtml(finishingAgent.slug) + "\n" +
                "Duración: " + completedEntry.duracion_min + " min"
            );
        } else if (prStatus.status === "open") {
            // PR abierta → mantener en agentes[] con status "waiting" (slot liberado)
            const waitingEntry = Object.assign({}, finishingAgent, { status: "waiting", resultado: "pending_review" });
            plan.agentes.push(waitingEntry);
            log("Agente #" + finishingAgent.issue + " → agentes[waiting] (PR abierta, pendiente review)");
            await notify(
                "⏳ <b>Agente #" + finishingAgent.issue + " terminó — PR abierta</b>\n" +
                "Rama: " + escHtml(agentBranch) + "\n" +
                "Estado: pendiente de review · slot liberado"
            );
        } else {
            // Sin PR (none, closed_no_merge, unknown) → _incomplete con resultado "failed"
            const motivo = prStatus.status === "unknown"
                ? "No se pudo verificar PR (gh CLI falló)"
                : "Sin PR — el agente no completó /delivery";
            const incompleteEntry = buildCompletedEntry(finishingAgent, session, "failed");
            incompleteEntry.motivo = motivo;
            plan._incomplete.push(incompleteEntry);
            log("Agente #" + finishingAgent.issue + " → _incomplete (sin PR): " + motivo);
            await notify(
                "⚠️ <b>Agente #" + finishingAgent.issue + " FALLIDO</b>\n" +
                "Rama: " + escHtml(agentBranch) + "\n" +
                "Motivo: " + escHtml(motivo) + "\n" +
                "<i>Acción: revisar worktree y relanzar si es necesario</i>"
            );
        }

        // Actualizar Project V2: issue completado → Done
        await updateProjectV2(finishingAgent.issue, "Done");

        // Actualizar total_stories si no está definido (retrocompatibilidad)
        if (!plan.total_stories) {
            const queueLen = getQueue(plan).length;
            plan.total_stories = (plan.agentes || []).length + queueLen + plan._completed.length + plan._incomplete.length;
            log("total_stories calculado: " + plan.total_stories);
        }

        // Verificar y marcar sesiones zombie antes de evaluar slots disponibles (#1408)
        // Garantiza conteo correcto cuando Stop no se disparó en sesiones anteriores
        const zombieIssues = markZombieSessions();
        if (zombieIssues.size > 0) {
            log("Sesiones zombie marcadas: issues " + Array.from(zombieIssues).join(", ") + " → excluidos del conteo de slots");
        }

        // Contar solo agentes no-waiting: los waiting ya liberaron su slot al entrar en espera (#1356)
        // Excluir agentes cuya sesión es zombie (PID muerto, slot ya no está ocupado) (#1408)
        const afterCount = plan.agentes.filter(ag => ag.status !== "waiting" && !zombieIssues.has(ag.issue)).length;
        const waitingCount = plan.agentes.filter(ag => ag.status === "waiting").length;
        log(
            "Agentes activos (no-waiting): " + afterCount + "/" + concurrencyLimit +
            (waitingCount > 0 ? " (+ " + waitingCount + " en waiting)" : "") +
            (wasWaiting ? " — terminó desde estado waiting (slot ya estaba liberado)" : "")
        );

        const queue = getQueue(plan);

        // ── Caso 1: EXCESO de concurrencia (anomalía) ───────────────────────
        if (afterCount > concurrencyLimit) {
            const alertMsg = (
                "⚠️ <b>ALERTA: Anomalía de concurrencia en sprint</b>\n" +
                "Agentes activos: <b>" + afterCount + "/" + concurrencyLimit + "</b>\n" +
                "Se excedió el límite configurado.\n" +
                "Agente que terminó: #" + finishingAgent.issue + " (" + escHtml(finishingAgent.slug) + ")\n" +
                "Revisar sprint-plan.json manualmente."
            );
            log("ANOMALIA: " + afterCount + " agentes no-waiting > límite " + concurrencyLimit);
            savePlan(plan);
            await notify(alertMsg);
            return;
        }

        // ── Caso 2: Hay espacio Y hay cola → auto-lanzar siguiente ──────────
        if (afterCount < concurrencyLimit && queue.length > 0) {
            const nextAgente = queue[0];
            const newQueue = queue.slice(1);

            // Asignar número al nuevo agente (máx actual + 1, o 1 si vacío)
            const maxNumero = plan.agentes.reduce((m, ag) => Math.max(m, ag.numero || 0), 0);
            nextAgente.numero = maxNumero + 1;

            // Asegurar que el prompt está asignado ANTES de guardar el plan (#1399)
            // Start-Agente.ps1 lee el plan del disco para obtener el prompt
            if (!nextAgente.prompt) {
                nextAgente.prompt = generateDefaultPrompt(nextAgente.issue, nextAgente.slug);
            }

            // Mover de cola a agentes
            plan.agentes.push(nextAgente);
            setQueue(plan, newQueue);

            savePlan(plan);
            log("Movido issue #" + nextAgente.issue + " de cola a agentes (número " + nextAgente.numero + ")");

            // Actualizar Project V2: issue promovido → In Progress
            await updateProjectV2(nextAgente.issue, "In Progress");

            // Lanzar el agente
            const launched = launchAgent(nextAgente);

            const slotsOccupied = plan.agentes.filter(ag => ag.status !== "waiting").length;
            const remainingQueue = newQueue.length;
            const stillWaiting = plan.agentes.filter(ag => ag.status === "waiting").length;
            const waitingSuffix = stillWaiting > 0 ? " (+ " + stillWaiting + " en waiting)" : "";

            const msg = launched
                ? (
                    "🚀 <b>Agente #" + nextAgente.issue + " lanzado desde cola</b>\n" +
                    "Slug: " + escHtml(nextAgente.slug || "") + "\n" +
                    "Slots activos: <b>" + slotsOccupied + "/" + concurrencyLimit + "</b>" + waitingSuffix + "\n" +
                    "Cola restante: " + remainingQueue + " issue(s)"
                )
                : (
                    "⚠️ <b>Cola: issue #" + nextAgente.issue + " movido pero no pudo lanzarse</b>\n" +
                    "Start-Agente.ps1 no disponible o falló. Lanzar manualmente:\n" +
                    "<code>.\\scripts\\Start-Agente.ps1 " + nextAgente.numero + "</code>\n" +
                    "Slots activos: " + slotsOccupied + "/" + concurrencyLimit + waitingSuffix
                );

            await notify(msg);
            return;
        }

        // ── Caso 3: Límite alcanzado O cola vacía → log informativo ─────────
        if (afterCount >= concurrencyLimit) {
            log("Slots llenos (" + afterCount + "/" + concurrencyLimit + ") — no se lanza siguiente");
        } else {
            log("Cola vacía y slots disponibles (" + afterCount + "/" + concurrencyLimit + ") — sprint terminado");
        }

        savePlan(plan);

        if (queue.length === 0 && afterCount === 0) {
            // Todos los agentes finalizaron y no hay cola — sprint completo
            await notify(
                "✅ <b>Sprint completado</b>\n" +
                "Todos los agentes finalizaron. Cola vacía.\n" +
                "<i>Agente finalizado: #" + finishingAgent.issue + " (" + escHtml(finishingAgent.slug) + ")</i>"
            );
        }

    } finally {
        if (locked) releaseLock();
    }
}
