// agent-concurrency-check.js — Hook Stop: valida concurrencia de agentes y auto-lanza siguiente (#1277)
// Se ejecuta al finalizar cualquier sesión Claude.
// Solo actúa si la sesión corresponde a un agente de sprint (rama agent/* en sprint-plan.json).
//
// Lógica:
//   1. Detectar si la sesión que termina es de sprint
//   2. Remover al agente que terminó del array agentes
//   3. Comparar agentes activos restantes vs concurrency_limit
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
            String(agente.numero)
        ];

        log("Lanzando agente " + agente.numero + " (issue #" + agente.issue + ") via PowerShell...");

        const child = spawn("powershell.exe", args, {
            detached: true,
            stdio: "ignore",
            windowsHide: false
        });
        child.unref();

        log("Agente " + agente.numero + " lanzado (PID hijo " + child.pid + ")");
        return true;
    } catch (e) {
        log("launchAgent error: " + e.message);
        return false;
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

    // Adquirir lock antes de leer+modificar
    const locked = acquireLock();
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

        log("Agente que finaliza: #" + finishingAgent.issue + " (" + finishingAgent.slug + ")");

        // Remover al agente que terminó del array agentes
        const prevCount = (plan.agentes || []).length;
        plan.agentes = (plan.agentes || []).filter(ag => ag.issue !== finishingAgent.issue);
        const afterCount = plan.agentes.length;
        log("Agentes activos: " + prevCount + " → " + afterCount + " (límite: " + concurrencyLimit + ")");

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
            log("ANOMALIA: " + afterCount + " agentes > límite " + concurrencyLimit);
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

            // Mover de cola a agentes
            plan.agentes.push(nextAgente);
            setQueue(plan, newQueue);

            savePlan(plan);
            log("Movido issue #" + nextAgente.issue + " de cola a agentes (número " + nextAgente.numero + ")");

            // Lanzar el agente
            const launched = launchAgent(nextAgente);

            const slotsOccupied = plan.agentes.length;
            const remainingQueue = newQueue.length;

            const msg = launched
                ? (
                    "🚀 <b>Auto-lanzado agente para #" + nextAgente.issue + "</b>\n" +
                    "Slug: " + escHtml(nextAgente.slug) + "\n" +
                    "Slots activos: <b>" + slotsOccupied + "/" + concurrencyLimit + "</b>\n" +
                    "Cola restante: " + remainingQueue + " issue(s)\n" +
                    "<i>Agente finalizado: #" + finishingAgent.issue + " (" + escHtml(finishingAgent.slug) + ")</i>"
                )
                : (
                    "⚠️ <b>Cola: issue #" + nextAgente.issue + " movido pero no pudo lanzarse</b>\n" +
                    "Start-Agente.ps1 no disponible o falló. Lanzar manualmente:\n" +
                    "<code>.\\Start-Agente.ps1 " + nextAgente.numero + "</code>\n" +
                    "Slots activos: " + slotsOccupied + "/" + concurrencyLimit
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
