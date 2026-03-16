// emit-transition.js — Modulo utilitario para emitir transiciones de roles al dashboard
// Los scripts del pipeline usan este modulo para registrar sus roles en la sesion activa,
// de modo que el dashboard muestre nodos e interacciones identicos a cuando los skills eran prompts.
//
// Uso:
//   const { emitTransition, emitSkillInvoked, findActiveSession } = require('./emit-transition');
//   emitTransition('BackendDev', 'Tester');
//   emitSkillInvoked('tester');

const fs = require("fs");
const path = require("path");

// Resolver REPO_ROOT al repo principal (no al worktree)
function resolveMainRepoRoot() {
    const candidate = process.env.CLAUDE_PROJECT_DIR || "C:\\Workspaces\\Intrale\\platform";
    try {
        const { execSync } = require("child_process");
        const gitCommon = execSync("git rev-parse --git-common-dir", { cwd: candidate, timeout: 3000, windowsHide: true })
            .toString().trim().replace(/\\/g, "/");
        if (gitCommon === ".git") return candidate;
        const gitIdx = gitCommon.indexOf("/.git");
        if (gitIdx !== -1) return gitCommon.substring(0, gitIdx);
        return path.resolve(gitCommon, "..");
    } catch (e) { return candidate; }
}

const REPO_ROOT = resolveMainRepoRoot();
const SESSIONS_DIR = path.join(REPO_ROOT, ".claude", "sessions");

// Mapa de skill a nombre canonico de agente (mismo que activity-logger.js)
const AGENT_MAP = {
    "ops": "Ops", "po": "PO", "guru": "Guru", "planner": "Planner",
    "doc": "Doc", "delivery": "DeliveryManager", "tester": "Tester",
    "monitor": "Monitor", "auth": "Auth", "builder": "Builder",
    "review": "Review", "qa": "QA", "security": "Security",
    "ux": "UX Specialist", "scrum": "Scrum Master",
    "backend-dev": "BackendDev", "android-dev": "AndroidDev",
    "ios-dev": "iOSDev", "web-dev": "WebDev", "desktop-dev": "DesktopDev",
    "cleanup": "Cleanup", "branch": "Branch", "hotfix": "Hotfix",
    "perf": "Perf", "cost": "Cost",
};

// Encontrar la sesion activa
// Prioridad: env var AGENT_SESSION_ID > sesion mas reciente con status active
function findActiveSession() {
    const envId = process.env.AGENT_SESSION_ID;
    if (envId) {
        const fp = path.join(SESSIONS_DIR, envId + ".json");
        if (fs.existsSync(fp)) return fp;
        // Probar sin .json extension
        const fp2 = path.join(SESSIONS_DIR, envId);
        if (fs.existsSync(fp2)) return fp2;
    }

    // Buscar sesion activa mas reciente
    if (!fs.existsSync(SESSIONS_DIR)) return null;
    const files = fs.readdirSync(SESSIONS_DIR).filter(f => f.endsWith(".json"));
    let best = null;
    let bestTs = 0;
    for (const f of files) {
        try {
            const fp = path.join(SESSIONS_DIR, f);
            const data = JSON.parse(fs.readFileSync(fp, "utf8"));
            if (data.status !== "active") continue;
            const ts = new Date(data.last_activity_ts || data.started_ts || 0).getTime();
            if (ts > bestTs) { bestTs = ts; best = fp; }
        } catch (e) { /* skip */ }
    }
    return best;
}

// Escribir atomicamente (tmp + rename, mismo patron que activity-logger.js)
function atomicWrite(filePath, data) {
    const tmp = filePath + ".tmp." + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
    fs.renameSync(tmp, filePath);
}

// Emitir una transicion de rol: {from, to, ts}
function emitTransition(from, to) {
    const sessionFile = findActiveSession();
    if (!sessionFile) {
        console.error("[emit-transition] No active session found");
        return false;
    }

    try {
        const data = JSON.parse(fs.readFileSync(sessionFile, "utf8"));
        if (!Array.isArray(data.agent_transitions)) {
            data.agent_transitions = [];
        }

        data.agent_transitions.push({
            from: from || "Claude",
            to: to || "Claude",
            ts: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
        });

        data.last_activity_ts = new Date().toISOString();
        atomicWrite(sessionFile, data);
        return true;
    } catch (e) {
        console.error("[emit-transition] Error:", e.message);
        return false;
    }
}

// Registrar un skill como invocado en la sesion
function emitSkillInvoked(skillName) {
    const sessionFile = findActiveSession();
    if (!sessionFile) return false;

    try {
        const data = JSON.parse(fs.readFileSync(sessionFile, "utf8"));
        if (!Array.isArray(data.skills_invoked)) {
            data.skills_invoked = [];
        }

        const canonical = "/" + skillName.replace(/^\/+/, "").toLowerCase();
        if (!data.skills_invoked.includes(canonical)) {
            data.skills_invoked.push(canonical);
        }

        atomicWrite(sessionFile, data);
        return true;
    } catch (e) {
        console.error("[emit-skill] Error:", e.message);
        return false;
    }
}

// Registrar resultado de un gate (pass/fail) para delivery-gate.js
function emitGateResult(gateName, status, details) {
    const logsDir = path.join(REPO_ROOT, "scripts", "logs");
    if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });

    const result = {
        gate: gateName,
        status: status, // "pass" | "fail"
        timestamp: new Date().toISOString(),
        details: details || {},
    };

    const filePath = path.join(logsDir, gateName + "-result.json");
    fs.writeFileSync(filePath, JSON.stringify(result, null, 2), "utf8");
    return result;
}

// Resolver nombre canonico de agente desde nombre de skill
function resolveAgentName(skillName) {
    if (!skillName) return "Claude";
    const clean = skillName.replace(/^\/+/, "").toLowerCase();
    return AGENT_MAP[clean] || skillName;
}

module.exports = {
    emitTransition,
    emitSkillInvoked,
    emitGateResult,
    findActiveSession,
    resolveAgentName,
    AGENT_MAP,
    REPO_ROOT,
    SESSIONS_DIR,
};
