// El Portero -- Permission Tracker Hook
// PostToolUse hook: detecta comandos Bash aprobados y los persiste en settings.local.json
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

function generatePattern(cmd) {
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

function handleInput() {
    try {
        const data = JSON.parse(input || "{}");

        if (data.tool_name !== "Bash") process.exit(0);

        const command = (data.tool_input && data.tool_input.command) || "";
        if (!command) process.exit(0);

        const pattern = generatePattern(command.trim());
        if (!pattern) process.exit(0);

        let settings;
        try { settings = JSON.parse(fs.readFileSync(SETTINGS, "utf8")); } catch(e) { process.exit(0); }

        const allow = (settings.permissions && settings.permissions.allow) || [];
        const deny = (settings.permissions && settings.permissions.deny) || [];

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

        allow.push(pattern);
        settings.permissions = settings.permissions || {};
        settings.permissions.allow = allow;
        fs.writeFileSync(SETTINGS, JSON.stringify(settings, null, 2) + "\n", "utf8");

        // Log
        const ts = new Date().toISOString().replace(/\.\d+Z$/, "Z");
        const sessionId = data.session_id || "";
        const logEntry = JSON.stringify({ ts, action: "added", pattern, command, session: sessionId });

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
