// agent-registry.js — Fuente de verdad centralizada para agentes activos (#1642)
// Módulo compartido: lo importan activity-logger.js, stop-notify.js,
// agent-concurrency-check.js y dashboard-server.js.
//
// Estructura de agent-registry.json:
// {
//   "agents": {
//     "<session_id>": {
//       "session_id": "a1b2c3d4",
//       "issue": "#1580",
//       "skill": "backend-dev",
//       "branch": "agent/1580-fix-auth",
//       "worktree": "/path/to/worktree",
//       "pid": 12345,
//       "started_at": "2026-03-17T10:00:00Z",
//       "last_heartbeat": "2026-03-17T10:05:30Z",
//       "status": "active"
//     }
//   },
//   "updated_at": "2026-03-17T10:05:30Z"
// }
//
// Status posibles: "active" | "idle" | "zombie" | "done"
//
// Pure Node.js — sin dependencias externas.
"use strict";

const fs = require("fs");
const path = require("path");

const REGISTRY_FILE = path.join(__dirname, "agent-registry.json");

// Zombie detection: heartbeat > 30 min + PID muerto
const ZOMBIE_THRESHOLD_MS = 30 * 60 * 1000;
// Idle detection: heartbeat > 10 min pero PID vivo
const IDLE_THRESHOLD_MS = 10 * 60 * 1000;
// Limpieza: entradas "done" con > 2h se purgan
const DONE_CLEANUP_MS = 2 * 60 * 60 * 1000;

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Verifica si un PID de proceso sigue vivo (Windows-safe).
 */
function isPidAlive(pid) {
    if (!pid) return false;
    try {
        const { execSync } = require("child_process");
        const output = execSync('tasklist /FI "PID eq ' + parseInt(pid, 10) + '" /NH', {
            timeout: 3000, windowsHide: true, encoding: "utf8"
        });
        return output.indexOf("No tasks") === -1 && output.trim().length > 0;
    } catch (e) {
        // Fallback POSIX: process.kill(pid, 0) solo verifica existencia
        try { process.kill(parseInt(pid, 10), 0); return true; } catch (ke) { return ke.code === "EPERM"; }
    }
}

// ─── Read / Write ────────────────────────────────────────────────────────────

/**
 * Lee el registry. Retorna { agents: {}, updated_at: ... }.
 * Nunca falla: retorna estructura vacía si el archivo no existe o es inválido.
 */
function loadRegistry() {
    try {
        if (!fs.existsSync(REGISTRY_FILE)) return { agents: {}, updated_at: null };
        const raw = fs.readFileSync(REGISTRY_FILE, "utf8");
        const data = JSON.parse(raw);
        if (!data || typeof data.agents !== "object") return { agents: {}, updated_at: null };
        return data;
    } catch (e) {
        return { agents: {}, updated_at: null };
    }
}

/**
 * Escribe el registry de forma atómica (tmp + rename).
 */
function saveRegistry(registry) {
    registry.updated_at = new Date().toISOString().replace(/\.\d+Z$/, "Z");
    const tmpFile = REGISTRY_FILE + ".tmp." + process.pid;
    try {
        fs.writeFileSync(tmpFile, JSON.stringify(registry, null, 2) + "\n", "utf8");
        try {
            if (fs.existsSync(REGISTRY_FILE)) fs.unlinkSync(REGISTRY_FILE);
            fs.renameSync(tmpFile, REGISTRY_FILE);
        } catch (e) {
            // Fallback: escribir directo
            try { fs.unlinkSync(tmpFile); } catch (e2) {}
            fs.writeFileSync(REGISTRY_FILE, JSON.stringify(registry, null, 2) + "\n", "utf8");
        }
    } catch (e) {
        // Último recurso
        try { fs.writeFileSync(REGISTRY_FILE, JSON.stringify(registry, null, 2) + "\n", "utf8"); } catch (e2) {}
    }
}


// Resuelve el nombre canónico del agente desde sprint-plan.json dado un issue string (#1733)
// Retorna "Agente N" (posición en el sprint) o null si no se encuentra.
function resolveAgentName(issueStr) {
    try {
        const issueNum = parseInt(String(issueStr).replace(/^#/, ""), 10);
        if (isNaN(issueNum)) return null;
        // Resolver el repo root (main repo, no worktree)
        let repoRoot = null;
        try {
            const { execSync } = require("child_process");
            const gitCommon = execSync("git rev-parse --git-common-dir", { timeout: 3000, windowsHide: true })
                .toString().trim().split(String.fromCharCode(92)).join("/");
            if (gitCommon === ".git") {
                repoRoot = process.cwd();
            } else {
                const gitIdx = gitCommon.indexOf("/.git");
                if (gitIdx !== -1) repoRoot = gitCommon.substring(0, gitIdx);
            }
        } catch(e) {}
        const sprintPlanPaths = [
            repoRoot ? path.join(repoRoot, "scripts", "sprint-plan.json") : null,
            path.join(__dirname, "..", "..", "scripts", "sprint-plan.json"),
            "C:/Workspaces/Intrale/platform/scripts/sprint-plan.json",
        ].filter(Boolean);
        for (const p of sprintPlanPaths) {
            if (!fs.existsSync(p)) continue;
            const plan = JSON.parse(fs.readFileSync(p, "utf8"));
            const all = [
                ...(Array.isArray(plan.agentes) ? plan.agentes : []),
                ...(Array.isArray(plan._queue) ? plan._queue : []),
                ...(Array.isArray(plan._completed) ? plan._completed : []),
                ...(Array.isArray(plan._incomplete) ? plan._incomplete : []),
            ];
            const match = all.find(a => a.issue === issueNum);
            if (match && match.numero) return "Agente " + match.numero;
        }
        return null;
    } catch(e) { return null; }
}
// ─── CRUD ────────────────────────────────────────────────────────────────────

/**
 * Registra un agente nuevo o actualiza uno existente.
 * @param {object} entry — campos del agente (session_id requerido)
 */
function registerAgent(entry) {
    if (!entry || !entry.session_id) return;
    const registry = loadRegistry();
    const now = new Date().toISOString().replace(/\.\d+Z$/, "Z");
    const existing = registry.agents[entry.session_id];

    if (existing) {
        // Actualizar campos (merge)
        Object.assign(existing, entry);
        existing.last_heartbeat = now;
    } else {
        // Nueva entrada
        registry.agents[entry.session_id] = {
            session_id: entry.session_id,
            issue: entry.issue || null,
            skill: entry.skill || null,
            agent_name: entry.agent_name || (entry.issue ? resolveAgentName(entry.issue) : null) || null,
            branch: entry.branch || null,
            worktree: entry.worktree || null,
            pid: entry.pid || null,
            started_at: entry.started_at || now,
            last_heartbeat: now,
            status: entry.status || "active",
        };
    }
    saveRegistry(registry);
}

/**
 * Actualiza el heartbeat de un agente existente.
 * Si el agente no existe, no hace nada (no auto-registra).
 * @param {string} sessionId
 * @param {object} [extra] — campos adicionales a actualizar (ej: skill, current_task)
 */
function updateHeartbeat(sessionId, extra) {
    if (!sessionId) return;
    const registry = loadRegistry();
    const agent = registry.agents[sessionId];
    if (!agent) return;
    const now = new Date().toISOString().replace(/\.\d+Z$/, "Z");
    agent.last_heartbeat = now;
    // Restaurar a active si estaba idle (el agente volvió a trabajar)
    if (agent.status === "idle") agent.status = "active";
    if (extra && typeof extra === "object") {
        for (const [k, v] of Object.entries(extra)) {
            if (k !== "session_id" && k !== "started_at") agent[k] = v;
        }
    }
    saveRegistry(registry);
}

/**
 * Marca un agente como "done" (baja).
 * @param {string} sessionId
 */
function markDone(sessionId) {
    if (!sessionId) return;
    const registry = loadRegistry();
    const agent = registry.agents[sessionId];
    if (!agent) return;
    agent.status = "done";
    agent.completed_at = new Date().toISOString().replace(/\.\d+Z$/, "Z");
    saveRegistry(registry);
}

/**
 * Retorna la lista de agentes activos (status === "active" o "idle").
 * @returns {object[]}
 */
function getActiveAgents() {
    const registry = loadRegistry();
    return Object.values(registry.agents).filter(a => a.status === "active" || a.status === "idle");
}

/**
 * Retorna todos los agentes del registry (cualquier status).
 * @returns {object[]}
 */
function getAllAgents() {
    const registry = loadRegistry();
    return Object.values(registry.agents);
}

/**
 * Cuenta agentes activos (no idle, no zombie, no done).
 * Para validación de concurrencia.
 * @returns {number}
 */
function countActiveAgents() {
    const registry = loadRegistry();
    return Object.values(registry.agents).filter(a => a.status === "active").length;
}

// ─── Zombie & Idle Detection ─────────────────────────────────────────────────

/**
 * Detecta y marca agentes zombie/idle:
 * - heartbeat > ZOMBIE_THRESHOLD_MS + PID muerto → status: "zombie"
 * - heartbeat > IDLE_THRESHOLD_MS + PID vivo → status: "idle"
 * También purga entradas "done" con > DONE_CLEANUP_MS.
 *
 * @returns {{ zombies: string[], idled: string[], purged: string[] }}
 */
function sweepRegistry() {
    const registry = loadRegistry();
    const now = Date.now();
    const result = { zombies: [], idled: [], purged: [] };
    let changed = false;

    for (const [sid, agent] of Object.entries(registry.agents)) {
        // Purgar entradas done con antigüedad > 2h
        if (agent.status === "done" || agent.status === "zombie") {
            const completedAt = agent.completed_at || agent.last_heartbeat || agent.started_at;
            const age = now - new Date(completedAt || 0).getTime();
            if (age > DONE_CLEANUP_MS) {
                delete registry.agents[sid];
                result.purged.push(sid);
                changed = true;
                continue;
            }
        }

        // Solo evaluar agentes active/idle
        if (agent.status !== "active" && agent.status !== "idle") continue;

        const lastHb = new Date(agent.last_heartbeat || agent.started_at || 0).getTime();
        const elapsed = now - lastHb;

        if (elapsed > ZOMBIE_THRESHOLD_MS) {
            // Heartbeat muy viejo — verificar PID
            if (!isPidAlive(agent.pid)) {
                agent.status = "zombie";
                agent.completed_at = new Date().toISOString().replace(/\.\d+Z$/, "Z");
                result.zombies.push(sid);
                changed = true;
            } else {
                // PID vivo pero sin heartbeat → idle
                if (agent.status !== "idle") {
                    agent.status = "idle";
                    result.idled.push(sid);
                    changed = true;
                }
            }
        } else if (elapsed > IDLE_THRESHOLD_MS) {
            // Heartbeat moderadamente viejo + PID vivo → idle
            if (agent.status !== "idle" && isPidAlive(agent.pid)) {
                agent.status = "idle";
                result.idled.push(sid);
                changed = true;
            } else if (!isPidAlive(agent.pid)) {
                // PID muerto incluso con heartbeat reciente-ish → zombie
                agent.status = "zombie";
                agent.completed_at = new Date().toISOString().replace(/\.\d+Z$/, "Z");
                result.zombies.push(sid);
                changed = true;
            }
        }
    }

    if (changed) saveRegistry(registry);
    return result;
}

// ─── Exports ─────────────────────────────────────────────────────────────────

module.exports = {
    resolveAgentName,
    REGISTRY_FILE,
    ZOMBIE_THRESHOLD_MS,
    IDLE_THRESHOLD_MS,
    isPidAlive,
    loadRegistry,
    saveRegistry,
    registerAgent,
    updateHeartbeat,
    markDone,
    getActiveAgents,
    getAllAgents,
    countActiveAgents,
    sweepRegistry,
};
