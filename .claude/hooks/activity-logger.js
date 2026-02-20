// El Centinela -- Activity Logger Hook
// PostToolUse hook: registra actividad en activity-log.jsonl
// Pure Node.js — sin dependencia de bash
const fs = require("fs");
const path = require("path");

const REPO_ROOT = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const LOG_FILE = path.join(REPO_ROOT, ".claude", "activity-log.jsonl");
const MAX_LINES = 500;

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
        }

        const ts = new Date().toISOString().replace(/\.\d+Z$/, "Z");
        const dir = path.dirname(LOG_FILE);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

        const entry = JSON.stringify({ ts, tool: toolName, target: target.substring(0, 120) });
        fs.appendFileSync(LOG_FILE, entry + "\n", "utf8");

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
