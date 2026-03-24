// agent-concurrency-check.js — Hook Stop: emite evento agent-stopped para el coordinator
// Versión simplificada: ya NO promueve ni lanza agentes. Solo emite eventos.
// El agent-coordinator.js es el único que decide y actúa.
//
// Se ejecuta al finalizar cualquier sesión Claude.
// Solo actúa si la sesión corresponde a un agente de sprint (rama agent/*).
"use strict";

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

// ─── Resolve repo root ──────────────────────────────────────────────────────

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
    const planFile = path.join(envRoot, "scripts", "sprint-plan.json");
    if (!fs.existsSync(planFile)) return "C:\\Workspaces\\Intrale\\platform";
    return envRoot;
}

const REPO_ROOT = resolveMainRepoRoot();
const HOOKS_DIR = path.join(REPO_ROOT, ".claude", "hooks");
const LOG_FILE = path.join(HOOKS_DIR, "hook-debug.log");
const SESSIONS_DIR = path.join(REPO_ROOT, ".claude", "sessions");
const EVENTS_FILE = path.join(HOOKS_DIR, "agent-events.jsonl");

// ─── Logging ────────────────────────────────────────────────────────────────

function log(msg) {
    try {
        fs.appendFileSync(LOG_FILE, "[" + new Date().toISOString() + "] ConcurrencyCheck: " + msg + "\n");
    } catch (e) {}
}

// ─── Event emitter ──────────────────────────────────────────────────────────

function emitEvent(evt) {
    evt.ts = new Date().toISOString();
    try {
        fs.appendFileSync(EVENTS_FILE, JSON.stringify(evt) + "\n", "utf8");
        log("Event emitted: " + evt.type + " issue=" + (evt.issue || "?"));
    } catch (e) {
        log("emitEvent error: " + e.message);
    }
}

// ─── Session helpers ─────────────────────────────────────────────────────────

function loadSession(sessionId) {
    if (!sessionId) return null;
    try {
        const shortId = sessionId.substring(0, 8);
        const sessionFile = path.join(SESSIONS_DIR, shortId + ".json");
        if (!fs.existsSync(sessionFile)) return null;
        return JSON.parse(fs.readFileSync(sessionFile, "utf8"));
    } catch (e) { return null; }
}

// ─── Zombie session cleanup (lightweight — no plan writes) ───────────────────

function isPidAlive(pid) {
    if (!pid) return false;
    try {
        const output = execSync('tasklist /FI "PID eq ' + parseInt(pid, 10) + '" /NH', {
            timeout: 3000, windowsHide: true, encoding: "utf8"
        });
        return output.indexOf("No tasks") === -1 && output.trim().length > 0;
    } catch (e) {
        try { process.kill(parseInt(pid, 10), 0); return true; } catch (ke) { return ke.code === "EPERM"; }
    }
}

const ZOMBIE_THRESHOLD_MS = 30 * 60 * 1000;

function markZombieSessions() {
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
                    log("Zombie: " + (session.id || file) + " branch=" + session.branch + " -> done");
                }
            } catch (e) {}
        }
    } catch (e) {}
}

// ─── Agent Registry sweep ────────────────────────────────────────────────────

let agentRegistry = null;
try { agentRegistry = require("./agent-registry"); } catch (e) {}

// ─── Read stdin (Stop event from Claude) ─────────────────────────────────────

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
setTimeout(() => { if (!done) { done = true; try { process.stdin.destroy(); } catch(e) {} processInput(); } }, 3000);

// ─── Main logic ──────────────────────────────────────────────────────────────

async function processInput() {
    log("Stop hook disparado...");

    let data;
    try { data = JSON.parse(rawInput); } catch (e) {
        log("JSON parse failed — abortando");
        return;
    }

    if (data.stop_hook_active) {
        log("stop_hook_active=true — abortando recursion");
        return;
    }

    const sessionId = data.session_id || "";
    let session = loadSession(sessionId);

    // Buscar sesion en worktree si no se encontro en repo principal
    if (!session || !session.branch) {
        const worktreeSessionsDir = path.join(
            process.env.CLAUDE_PROJECT_DIR || "",
            ".claude", "sessions"
        );
        if (worktreeSessionsDir !== SESSIONS_DIR) {
            try {
                const shortId = sessionId.substring(0, 8);
                const wFile = path.join(worktreeSessionsDir, shortId + ".json");
                if (fs.existsSync(wFile)) {
                    const wSession = JSON.parse(fs.readFileSync(wFile, "utf8"));
                    if (wSession && wSession.branch) session = wSession;
                }
            } catch (e) {}
        }
    }

    // Fallback: inferir branch desde worktree path
    if (!session || !session.branch) {
        const projectDir = process.env.CLAUDE_PROJECT_DIR || "";
        const wtMatch = projectDir.replace(/\\/g, "/").match(/platform\.agent-(\d+)-([^/]+)$/);
        if (wtMatch) {
            const inferredBranch = "agent/" + wtMatch[1] + "-" + wtMatch[2];
            log("Branch inferido: " + inferredBranch);
            if (!session) session = {};
            session.branch = inferredBranch;
        }
    }

    if (!session || !session.branch) {
        log("No branch — no es sesion de sprint");
        return;
    }

    if (!session.branch.startsWith("agent/")) {
        log("Branch no es agent/* (" + session.branch + ") — skip");
        return;
    }

    log("Sesion de agente terminada: branch=" + session.branch + " session=" + sessionId.substring(0, 8));

    // Clean zombie sessions
    markZombieSessions();

    // Sweep agent registry
    if (agentRegistry) {
        try { agentRegistry.sweepRegistry(); } catch (e) {}
    }

    // Extract issue number from branch
    const branchMatch = session.branch.match(/\/(\d+)-/);
    const issueNum = branchMatch ? parseInt(branchMatch[1], 10) : null;

    // === EMIT EVENT — Coordinator decides what to do ===
    emitEvent({
        type: "agent-stopped",
        issue: issueNum,
        branch: session.branch,
        session_id: sessionId.substring(0, 8),
        exit_code: data.exit_code || 0,
        session_data: {
            action_count: session.action_count || 0,
            started_ts: session.started_ts || null,
            last_activity_ts: session.last_activity_ts || null,
            branch: session.branch,
            pid: session.pid || session.claude_pid || null
        }
    });

    log("Evento agent-stopped emitido para #" + (issueNum || "?") + " — coordinator se encarga de promocion/lanzamiento");
}
