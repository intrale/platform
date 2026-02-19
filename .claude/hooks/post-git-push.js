// Hook PostToolUse[Bash]: detecta git push y lanza monitoreo CI en background
// Pure Node.js — sin dependencia de bash
const { execSync, spawn } = require("child_process");
const path = require("path");

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();

// Leer stdin
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
        const data = JSON.parse(input || "{}");
        const command = (data.tool_input && data.tool_input.command) || "";
        if (!command.includes("git push")) return;

        // Verificar que no hubo error en stderr
        const stderr = (data.tool_result && data.tool_result.stderr) || "";
        if (/error|rejected|denied|failed/i.test(stderr)) return;

        // Obtener SHA
        let sha;
        try {
            sha = execSync("git rev-parse HEAD", { cwd: PROJECT_DIR, encoding: "utf8" }).trim();
        } catch(e) { return; }
        if (!sha) return;

        // Lanzar monitoreo CI en background
        const ciMonitor = path.join(PROJECT_DIR, ".claude", "hooks", "ci-monitor.sh");
        const child = spawn("node", ["-e", `
            const { execSync } = require("child_process");
            try { execSync("bash " + JSON.stringify(${JSON.stringify(ciMonitor)}) + " " + ${JSON.stringify(sha)} + " " + ${JSON.stringify(PROJECT_DIR)}, { stdio: "ignore" }); } catch(e) {}
        `], { detached: true, stdio: "ignore" });
        child.unref();
    } catch(e) {}
}
