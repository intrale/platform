#!/bin/bash
# El Centinela -- Activity Logger Hook
# PostToolUse hook: registra actividad en activity-log.jsonl
# Usa node con limite de lectura de stdin para evitar timeout en Read/Glob grandes

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || echo '.')"
LOG_FILE="$REPO_ROOT/.claude/activity-log.jsonl"
MAX_LINES=500

node -e '
const fs = require("fs");
const path = require("path");

const logFile = process.argv[1];
const maxLines = parseInt(process.argv[2]) || 500;

// Leer solo los primeros 4KB de stdin — suficiente para tool_name y target
const MAX_READ = 4096;
let input = "";
let done = false;

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
    if (done) return;
    input += chunk;
    if (input.length >= MAX_READ) {
        done = true;
        process.stdin.destroy();
        handleInput();
    }
});
process.stdin.on("end", () => { if (!done) { done = true; handleInput(); } });
process.stdin.on("error", () => { if (!done) { done = true; handleInput(); } });

// Timeout de seguridad: si stdin no cierra en 2s, procesar lo que tengamos
setTimeout(() => { if (!done) { done = true; try { process.stdin.destroy(); } catch(e) {} handleInput(); } }, 2000);

function handleInput() {
    try {
        let data;
        try { data = JSON.parse(input); } catch(e) {
            // Si el JSON esta truncado, extraer tool_name con regex
            const m = input.match(/"tool_name"\s*:\s*"([^"]+)"/);
            if (!m) return;
            data = { tool_name: m[1], tool_input: {} };
            // Intentar extraer tool_input parcialmente
            const fm = input.match(/"file_path"\s*:\s*"([^"]+)"/);
            if (fm) data.tool_input = { file_path: fm[1] };
            const cm = input.match(/"command"\s*:\s*"([^"]+)"/);
            if (cm) data.tool_input = { command: cm[1] };
        }

        const toolName = data.tool_name || "";
        if (!toolName) return;

        // Ignorar herramientas de solo lectura (mucho ruido)
        if (["TaskList","TaskGet","Read","Glob","Grep"].includes(toolName)) return;

        // Extraer target segun herramienta
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

        // Escribir entrada JSONL
        const ts = new Date().toISOString().replace(/\.\d+Z$/, "Z");
        const dir = path.dirname(logFile);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

        const entry = JSON.stringify({ ts, tool: toolName, target: target.substring(0, 120) });
        fs.appendFileSync(logFile, entry + "\n", "utf8");

        // Rotacion
        try {
            const content = fs.readFileSync(logFile, "utf8").trim();
            const lines = content.split("\n");
            if (lines.length > maxLines) {
                const keep = Math.floor(maxLines / 2);
                fs.writeFileSync(logFile, lines.slice(-keep).join("\n") + "\n", "utf8");
            }
        } catch(e) {}
    } catch(e) {}
}
' "$LOG_FILE" "$MAX_LINES" 2>/dev/null

exit 0
