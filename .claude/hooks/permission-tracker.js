<<<<<<< docs/agents-automation
// El Portero 🚪 — Permission Tracker Hook v2
// PostToolUse hook: detecta tools aprobados y los persiste en settings.local.json
// Maneja: Bash, WebFetch, Skill
=======
// El Portero -- Permission Tracker Hook
// PostToolUse hook: detecta comandos Bash aprobados y los persiste en settings.local.json
>>>>>>> main
// Pure Node.js — sin dependencia de bash
const fs = require("fs");
const path = require("path");

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();
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

<<<<<<< docs/agents-automation
// --- Generadores de patrones por tipo de tool ---

function generateBashPattern(cmd) {
    if (!cmd) return null;

    // Comando entre comillas (paths con espacios)
=======
function generatePattern(cmd) {
>>>>>>> main
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

<<<<<<< docs/agents-automation
    // Git: generalizar por subcomando
=======
>>>>>>> main
    if (first === "git") {
        const sub = parts[1];
        if (sub === "credential" && parts.length > 2) return "Bash(git credential " + parts[2] + ":*)";
        if (sub === "-C") return "Bash(git -C:*)";
        return "Bash(git " + sub + ":*)";
    }

<<<<<<< docs/agents-automation
    // Export: generalizar por nombre de variable
=======
>>>>>>> main
    if (first === "export") {
        const rest = parts.slice(1).join(" ");
        const eqIdx = rest.indexOf("=");
        if (eqIdx > 0) {
            const varname = rest.substring(0, eqIdx);
            return "Bash(export " + varname + "=*)";
        }
        return "Bash(export " + parts[1] + ":*)";
    }

<<<<<<< docs/agents-automation
    // Paths absolutos o relativos
    if (first.startsWith("./") || first.startsWith("/")) return "Bash(" + first + ":*)";

    // Variable assignment (VAR=value command)
=======
    if (first.startsWith("./") || first.startsWith("/")) return "Bash(" + first + ":*)";
>>>>>>> main
    if (first.includes("=")) {
        const varname = first.substring(0, first.indexOf("="));
        return "Bash(" + varname + "=*)";
    }

<<<<<<< docs/agents-automation
    // Generico: primer token como prefijo
    return "Bash(" + first + ":*)";
}

function generateWebFetchPattern(toolInput) {
    const url = toolInput && toolInput.url;
    if (!url) return null;
    try {
        const parsed = new URL(url);
        return "WebFetch(domain:" + parsed.hostname + ")";
    } catch(e) {
        return null;
    }
}

function generateSkillPattern(toolInput) {
    const skill = toolInput && toolInput.skill;
    if (!skill) return null;
    return "Skill(" + skill + ")";
}

// --- Logica de deduplicacion inteligente ---

function isAlreadyCovered(pattern, allowList) {
    if (allowList.includes(pattern)) return true;

    // Para Bash patterns: verificar si existe un patron mas amplio
    const bashMatch = pattern.match(/^Bash\((.+?):\*\)$/);
    if (bashMatch) {
        const newCmd = bashMatch[1];
        for (const existing of allowList) {
            const existMatch = existing.match(/^Bash\((.+?):\*\)$/);
            if (!existMatch) continue;
            const existCmd = existMatch[1];
            // Si el patron existente es un prefijo del nuevo, ya esta cubierto
            // ej: "node" cubre "node -e"
            if (newCmd.startsWith(existCmd + " ") || newCmd.startsWith(existCmd + ":")) return true;
            if (newCmd === existCmd) return true;
        }
    }

    // Para WebSearch: es un singleton, verificar directo
    if (pattern === "WebSearch") return allowList.includes("WebSearch");

    return false;
}

function conflictsWithDeny(pattern, denyList) {
    const bashMatch = pattern.match(/^Bash\((.+?):\*\)$/);
    if (!bashMatch) return false;

    const newCmd = bashMatch[1];
    for (const d of denyList) {
        const dm = d.match(/^Bash\((.+?):\*\)$/);
        if (!dm) continue;
        const denyCmd = dm[1];
        // Conflicto si el deny es prefijo del nuevo o viceversa
        if (denyCmd.startsWith(newCmd) || newCmd.startsWith(denyCmd)) return true;
    }
    return false;
}

// --- Handler principal ---

function handleInput() {
    try {
        const data = JSON.parse(input || "{}");
        const toolName = data.tool_name;
        const toolInput = data.tool_input || {};

        // Generar patron segun tipo de tool
        let pattern = null;
        let description = "";

        switch (toolName) {
            case "Bash":
                pattern = generateBashPattern((toolInput.command || "").trim());
                description = toolInput.command || "";
                break;
            case "WebFetch":
                pattern = generateWebFetchPattern(toolInput);
                description = toolInput.url || "";
                break;
            case "Skill":
                pattern = generateSkillPattern(toolInput);
                description = toolInput.skill || "";
                break;
            case "WebSearch":
                pattern = "WebSearch";
                description = toolInput.query || "";
                break;
            default:
                // Tool no trackeable (Read, Write, Edit, Grep, Glob, Task, etc.)
                process.exit(0);
        }

        if (!pattern) process.exit(0);

        // Leer settings
=======
    return "Bash(" + first + ":*)";
}

function handleInput() {
    try {
        const data = JSON.parse(input || "{}");

        if (data.tool_name !== "Bash") process.exit(0);

        const command = (data.tool_input && data.tool_input.command) || "";
        if (!command) process.exit(0);

        const pattern = generatePattern(command.trim());
        if (!pattern) process.exit(0);

>>>>>>> main
        let settings;
        try { settings = JSON.parse(fs.readFileSync(SETTINGS, "utf8")); } catch(e) { process.exit(0); }

        const allow = (settings.permissions && settings.permissions.allow) || [];
        const deny = (settings.permissions && settings.permissions.deny) || [];

<<<<<<< docs/agents-automation
        // Verificar si ya esta cubierto por un patron existente
        if (isAlreadyCovered(pattern, allow)) process.exit(0);

        // Verificar conflicto con deny
        if (conflictsWithDeny(pattern, deny)) process.exit(0);

        // Agregar nuevo patron
=======
        if (allow.includes(pattern)) process.exit(0);

        // Matchea deny?
        const newMatch = pattern.match(/^Bash\((.+?):\*\)$/);
        if (newMatch) {
            const newCmd = newMatch[1];
            for (const d of deny) {
                const dm = d.match(/^Bash\((.+?):\*\)$/);
                if (!dm) continue;
                const denyCmd = dm[1];
                if (denyCmd.startsWith(newCmd) || newCmd.startsWith(denyCmd)) process.exit(0);
            }
        }

>>>>>>> main
        allow.push(pattern);
        settings.permissions = settings.permissions || {};
        settings.permissions.allow = allow;
        fs.writeFileSync(SETTINGS, JSON.stringify(settings, null, 2) + "\n", "utf8");

        // Log
        const ts = new Date().toISOString().replace(/\.\d+Z$/, "Z");
        const sessionId = data.session_id || "";
<<<<<<< docs/agents-automation
        const logEntry = JSON.stringify({
            ts,
            action: "added",
            tool: toolName,
            pattern,
            description: description.substring(0, 200),
            session: sessionId
        });
=======
        const logEntry = JSON.stringify({ ts, action: "added", pattern, command, session: sessionId });
>>>>>>> main

        const logDir = path.dirname(LOG_PATH);
        if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
        fs.appendFileSync(LOG_PATH, logEntry + "\n", "utf8");

<<<<<<< docs/agents-automation
        // Rotacion del log
=======
        // Rotacion
>>>>>>> main
        try {
            const lines = fs.readFileSync(LOG_PATH, "utf8").trim().split("\n");
            if (lines.length > 200) fs.writeFileSync(LOG_PATH, lines.slice(-100).join("\n") + "\n", "utf8");
        } catch(e) {}
    } catch(e) {
        process.exit(0);
    }
}
