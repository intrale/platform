// Auth v2 -- Permission Tracker Hook
// PostToolUse hook: detecta tools aprobados (Bash, WebFetch, Skill) y los persiste en settings.local.json
// Pure Node.js — sin dependencia de bash
// Usa permission-utils.js para generación de patrones y persistencia (compartido con permission-approver.js)
const fs = require("fs");
const path = require("path");
const { generatePattern, isAlreadyCovered, collidesWithDeny, getSettingsPaths, resolveMainRepoRoot } = require("./permission-utils");

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || "C:\\Workspaces\\Intrale\\platform";
const MAIN_REPO = resolveMainRepoRoot(PROJECT_DIR) || PROJECT_DIR;
const LOG_PATH = path.join(MAIN_REPO, ".claude", "permissions-log.jsonl");

// Verificar que settings existe en al menos un path antes de gastar CPU
const settingsPaths = getSettingsPaths(PROJECT_DIR);
if (!settingsPaths.some(p => fs.existsSync(p))) process.exit(0);

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

        // Escribir en todos los settings paths (worktree + main repo)
        let written = false;
        for (const settingsPath of settingsPaths) {
            try {
                let settings;
                try { settings = JSON.parse(fs.readFileSync(settingsPath, "utf8")); } catch(e) { continue; }

                const allow = (settings.permissions && settings.permissions.allow) || [];
                const deny = (settings.permissions && settings.permissions.deny) || [];

                // Ya cubierto?
                if (isAlreadyCovered(pattern, allow)) continue;

                // Colisiona con deny?
                if (collidesWithDeny(pattern, deny)) continue;

                // Agregar
                allow.push(pattern);
                settings.permissions = settings.permissions || {};
                settings.permissions.allow = allow;
                fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf8");
                written = true;
            } catch(e) { /* ignorar errores individuales */ }
        }

        if (!written) process.exit(0);

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
