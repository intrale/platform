// Monitor v3 -- Activity Logger Hook
// PostToolUse hook: registra actividad en activity-log.jsonl y actualiza sesion en sessions/
// Pure Node.js — sin dependencia de bash
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const REPO_ROOT = process.env.CLAUDE_PROJECT_DIR || "C:\\Workspaces\\Intrale\\platform";
const LOG_FILE = path.join(REPO_ROOT, ".claude", "activity-log.jsonl");
const SESSIONS_DIR = path.join(REPO_ROOT, ".claude", "sessions");
const MAX_LINES = 500;

const AGENT_MAP = {
    "/guru": "Guru",
    "/planner": "Planner",
    "/doc": "Doc",
    "/delivery": "DeliveryManager",
    "/tester": "Tester",
    "/monitor": "Monitor",
    "/auth": "Auth",
    "/refinar": "Doc (refinar)",
    "/priorizar": "Doc (priorizar)",
    "/historia": "Doc (historia)",
    "/builder": "Builder",
    "/review": "Review",
};

// Leer solo los primeros 4KB de stdin
const MAX_READ = 4096;
let input = "";
let done = false;

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
    if (done) return;
    input += chunk;
    if (input.length >= MAX_READ) { done = true; process.stdin.destroy(); handleInput(); }
});
process.stdin.on("end", () => { if (!done) { done = true; handleInput(); } });
process.stdin.on("error", () => { if (!done) { done = true; handleInput(); } });
setTimeout(() => { if (!done) { done = true; try { process.stdin.destroy(); } catch(e) {} handleInput(); } }, 2000);

function getBranch() {
    try {
        return execSync("git branch --show-current", { cwd: REPO_ROOT, timeout: 3000 })
            .toString().trim();
    } catch(e) { return "unknown"; }
}

function handleInput() {
    try {
        let data;
        try { data = JSON.parse(input); } catch(e) {
            const m = input.match(/"tool_name"\s*:\s*"([^"]+)"/);
            if (!m) return;
            data = { tool_name: m[1], tool_input: {} };
            const fm = input.match(/"file_path"\s*:\s*"([^"]+)"/);
            if (fm) data.tool_input = { file_path: fm[1] };
            const cm = input.match(/"command"\s*:\s*"([^"]+)"/);
            if (cm) data.tool_input = { command: cm[1] };
        }

        const toolName = data.tool_name || "";
        if (!toolName) return;

        // Ignorar herramientas de solo lectura (mucho ruido)
        if (["TaskList","TaskGet","Read","Glob","Grep"].includes(toolName)) return;

        const ti = data.tool_input || {};
        let target = "--";

        switch (toolName) {
            case "Edit": case "Write": case "NotebookEdit":
                target = ti.file_path || ti.notebook_path || "--";
                break;
            case "Bash":
                target = (ti.command || "--").substring(0, 80);
                break;
            case "Task":
                target = (ti.description || "--").substring(0, 80);
                break;
            case "Skill":
                target = ti.skill || "--";
                break;
            case "TaskCreate": case "TaskUpdate":
                target = ti.subject || (ti.taskId ? "task #" + ti.taskId : "--");
                break;
            case "WebFetch": case "WebSearch":
                target = ti.url || ti.query || "--";
                break;
        }

        const ts = new Date().toISOString().replace(/\.\d+Z$/, "Z");
        const dir = path.dirname(LOG_FILE);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

        const sessionId = data.session_id || "";
        const entry = JSON.stringify({ ts, session: sessionId.substring(0, 8), tool: toolName, target: target.substring(0, 120) });
        fs.appendFileSync(LOG_FILE, entry + "\n", "utf8");

        // Actualizar archivo de sesion
        if (sessionId) {
            updateSession(sessionId, ts, toolName, target, ti);
        }

        // Rotacion del JSONL
        try {
            const content = fs.readFileSync(LOG_FILE, "utf8").trim();
            const lines = content.split("\n");
            if (lines.length > MAX_LINES) {
                const keep = Math.floor(MAX_LINES / 2);
                fs.writeFileSync(LOG_FILE, lines.slice(-keep).join("\n") + "\n", "utf8");
            }
        } catch(e) {}
    } catch(e) {}
}

function updateSession(sessionId, ts, toolName, target, toolInput) {
    try {
        if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });

        const shortId = sessionId.substring(0, 8);
        const sessionFile = path.join(SESSIONS_DIR, shortId + ".json");

        let session;
        if (fs.existsSync(sessionFile)) {
            try { session = JSON.parse(fs.readFileSync(sessionFile, "utf8")); } catch(e) { session = null; }
        }

        if (!session) {
            session = {
                id: shortId,
                full_id: sessionId,
                type: "parent",
                started_ts: ts,
                last_activity_ts: ts,
                action_count: 0,
                status: "active",
                branch: getBranch(),
                last_tool: toolName,
                last_target: target.substring(0, 120),
                agent_name: null,
                skills_invoked: [],
                sub_count: 0,
                permission_mode: "unknown",
            };
        }

        session.last_activity_ts = ts;
        session.action_count = (session.action_count || 0) + 1;
        session.status = "active";
        session.last_tool = toolName;
        session.last_target = target.substring(0, 120);

        // Detectar skill invocado y mapear a agente
        if (toolName === "Skill") {
            const skillName = "/" + (toolInput.skill || "");
            if (skillName !== "/" && !session.skills_invoked.includes(skillName)) {
                session.skills_invoked.push(skillName);
            }
            if (AGENT_MAP[skillName] && !session.agent_name) {
                session.agent_name = AGENT_MAP[skillName];
            }
        }

        // Detectar sub-agentes (Task tool)
        if (toolName === "Task") {
            session.sub_count = (session.sub_count || 0) + 1;
        }

        fs.writeFileSync(sessionFile, JSON.stringify(session, null, 2) + "\n", "utf8");
    } catch(e) { /* no bloquear hook por error de sesion */ }
}
