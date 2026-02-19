// El Centinela -- Activity Logger Hook
// PostToolUse hook: registra actividad en activity-log.jsonl + mantiene session-state.json
// Pure Node.js — sin dependencia de bash
const fs = require("fs");
const path = require("path");

const REPO_ROOT = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const CLAUDE_DIR = path.join(REPO_ROOT, ".claude");
const LOG_FILE = path.join(CLAUDE_DIR, "activity-log.jsonl");
const SESSION_FILE = path.join(CLAUDE_DIR, "session-state.json");
const MAX_LINES = 500;

// Leer hasta 8KB de stdin (el JSON del evento puede ser grande)
const MAX_READ = 8192;
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

// Derivar categoria del tool_name
function categorize(toolName) {
    switch (toolName) {
        case "Bash": return "bash";
        case "Edit": case "Write": case "Read": case "Glob": case "Grep": case "NotebookEdit": return "file";
        case "Task": return "agent";
        case "Skill": return "skill";
        case "TaskCreate": case "TaskUpdate": case "TaskList": case "TaskGet": return "task";
        case "WebFetch": case "WebSearch": return "web";
        case "AskUserQuestion": return "user";
        case "EnterPlanMode": case "ExitPlanMode": return "meta";
        default: return "other";
    }
}

// Actualizar session-state.json
function updateSessionState(sessionId, ts, toolName, skillName) {
    if (!fs.existsSync(CLAUDE_DIR)) fs.mkdirSync(CLAUDE_DIR, { recursive: true });

    let state = null;
    try { state = JSON.parse(fs.readFileSync(SESSION_FILE, "utf8")); } catch(e) {}

    const isNewSession = !state || state.current_session !== sessionId;

    if (isNewSession) {
        state = {
            current_session: sessionId,
            session_start_ts: ts,
            action_count: 0,
            skills_invoked: [],
            agents_launched: 0,
            last_activity_ts: ts
        };
    }

    state.action_count++;
    state.last_activity_ts = ts;

    if (skillName && !state.skills_invoked.includes("/" + skillName)) {
        state.skills_invoked.push("/" + skillName);
    }

    if (toolName === "Task") {
        state.agents_launched++;
    }

    try {
        fs.writeFileSync(SESSION_FILE, JSON.stringify(state, null, 2) + "\n", "utf8");
    } catch(e) {}
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
            case "TaskCreate": case "TaskUpdate":
                target = ti.subject || (ti.taskId ? "task #" + ti.taskId : "--");
                break;
            case "WebFetch": case "WebSearch":
                target = ti.url || ti.query || "--";
                break;
            case "Skill":
                target = ti.skill || "--";
                break;
            case "AskUserQuestion":
                target = ((ti.questions && ti.questions[0] && ti.questions[0].question) || "--").substring(0, 80);
                break;
        }

        // Campos nuevos
        const sessionId = (data.session_id || "").substring(0, 8);
        const cat = categorize(toolName);
        const skillName = toolName === "Skill" ? (ti.skill || null) : null;
        const agentDesc = toolName === "Task" ? (ti.description || "").substring(0, 40) || null : null;

        const ts = new Date().toISOString().replace(/\.\d+Z$/, "Z");
        const dir = path.dirname(LOG_FILE);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

        const entry = JSON.stringify({
            ts,
            session: sessionId || null,
            tool: toolName,
            cat,
            target: target.substring(0, 120),
            skill: skillName,
            agent: agentDesc
        });
        fs.appendFileSync(LOG_FILE, entry + "\n", "utf8");

        // Actualizar session-state
        if (sessionId) {
            updateSessionState(sessionId, ts, toolName, skillName);
        }

        // Rotacion
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
