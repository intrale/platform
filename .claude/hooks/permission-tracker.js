// Auth v2 -- Permission Tracker Hook
// PostToolUse hook: detecta tools aprobados (Bash, WebFetch, Skill) y los persiste en settings.local.json
// Pure Node.js — sin dependencia de bash
const fs = require("fs");
const path = require("path");
const url = require("url");

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || "C:\\Workspaces\\Intrale\\platform";
const SETTINGS = path.join(PROJECT_DIR, ".claude", "settings.local.json");
const LOG_PATH = path.join(PROJECT_DIR, ".claude", "permissions-log.jsonl");

// Verificar que settings existe antes de gastar CPU
if (!fs.existsSync(SETTINGS)) process.exit(0);

// Leer stdin con limite y timeout
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

// --- Generadores de patron por tipo de tool ---

function generateBashPattern(command) {
    const cmd = command.trim();
    if (!cmd) return null;

    if (cmd.startsWith("\"")) {
        const end = cmd.indexOf("\"", 1);
        if (end > 0) {
            const quoted = cmd.substring(1, end);
            return "Bash(\"" + quoted + "\":*)";
        }
    }

    const parts = cmd.split(/\s+/);
    const first = parts[0];

    if (parts.length === 1) return "Bash(" + first + ":*)";

    if (first === "git") {
        const sub = parts[1];
        if (sub === "credential" && parts.length > 2) return "Bash(git credential " + parts[2] + ":*)";
        if (sub === "-C") return "Bash(git -C:*)";
        return "Bash(git " + sub + ":*)";
    }

    if (first === "export") {
        const rest = parts.slice(1).join(" ");
        const eqIdx = rest.indexOf("=");
        if (eqIdx > 0) {
            const varname = rest.substring(0, eqIdx);
            return "Bash(export " + varname + "=*)";
        }
        return "Bash(export " + parts[1] + ":*)";
    }

    if (first.startsWith("./") || first.startsWith("/")) return "Bash(" + first + ":*)";
    if (first.includes("=")) {
        const varname = first.substring(0, first.indexOf("="));
        return "Bash(" + varname + "=*)";
    }

    return "Bash(" + first + ":*)";
}

function generateWebFetchPattern(toolInput) {
    const fetchUrl = toolInput.url || "";
    if (!fetchUrl) return null;
    try {
        const parsed = new URL(fetchUrl);
        const domain = parsed.hostname;
        if (!domain) return null;
        return "WebFetch(domain:" + domain + ")";
    } catch(e) {
        return null;
    }
}

function generateSkillPattern(toolInput) {
    const skill = toolInput.skill || "";
    if (!skill) return null;
    return "Skill(" + skill + ")";
}

function generatePattern(toolName, toolInput) {
    switch (toolName) {
        case "Bash":
            return generateBashPattern((toolInput && toolInput.command) || "");
        case "WebFetch":
            return generateWebFetchPattern(toolInput || {});
        case "Skill":
            return generateSkillPattern(toolInput || {});
        default:
            return null;
    }
}

// --- Verificar si un patron ya esta cubierto ---

function isAlreadyCovered(pattern, allowList) {
    // Exacto
    if (allowList.includes(pattern)) return true;

    // Si es WebFetch(domain:X), verificar si "WebFetch" bare esta en la lista
    if (pattern.startsWith("WebFetch(") && allowList.includes("WebFetch")) return true;

    // Si es Bash(X:*), verificar si algun patron mas amplio lo cubre
    const m = pattern.match(/^Bash\((.+?):\*\)$/);
    if (m) {
        const cmd = m[1];
        for (const p of allowList) {
            const pm = p.match(/^Bash\((.+?):\*\)$/);
            if (pm && cmd.startsWith(pm[1])) return true;
        }
    }

    return false;
}

function collidesWithDeny(pattern, denyList) {
    const m = pattern.match(/^Bash\((.+?):\*\)$/);
    if (!m) return false;
    const cmd = m[1];
    for (const d of denyList) {
        const dm = d.match(/^Bash\((.+?):\*\)$/);
        if (!dm) continue;
        const denyCmd = dm[1];
        if (denyCmd.startsWith(cmd) || cmd.startsWith(denyCmd)) return true;
    }
    return false;
}

// --- Main ---

function handleInput() {
    try {
        const data = JSON.parse(input || "{}");
        const toolName = data.tool_name || "";

        // Solo trackeamos Bash, WebFetch y Skill
        if (!["Bash", "WebFetch", "Skill"].includes(toolName)) process.exit(0);

        const toolInput = data.tool_input || {};
        const pattern = generatePattern(toolName, toolInput);
        if (!pattern) process.exit(0);

        let settings;
        try { settings = JSON.parse(fs.readFileSync(SETTINGS, "utf8")); } catch(e) { process.exit(0); }

        const allow = (settings.permissions && settings.permissions.allow) || [];
        const deny = (settings.permissions && settings.permissions.deny) || [];

        // Ya cubierto?
        if (isAlreadyCovered(pattern, allow)) process.exit(0);

        // Colisiona con deny?
        if (collidesWithDeny(pattern, deny)) process.exit(0);

        // Agregar
        allow.push(pattern);
        settings.permissions = settings.permissions || {};
        settings.permissions.allow = allow;
        fs.writeFileSync(SETTINGS, JSON.stringify(settings, null, 2) + "\n", "utf8");

        // Log
        const ts = new Date().toISOString().replace(/\.\d+Z$/, "Z");
        const sessionId = data.session_id || "";
        const logEntry = JSON.stringify({ ts, action: "added", tool: toolName, pattern, session: sessionId });

        const logDir = path.dirname(LOG_PATH);
        if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
        fs.appendFileSync(LOG_PATH, logEntry + "\n", "utf8");

        // Rotacion
        try {
            const lines = fs.readFileSync(LOG_PATH, "utf8").trim().split("\n");
            if (lines.length > 200) fs.writeFileSync(LOG_PATH, lines.slice(-100).join("\n") + "\n", "utf8");
        } catch(e) {}
    } catch(e) {
        process.exit(0);
    }
}
