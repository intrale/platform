// Hook PostToolUse[Bash]: detecta git push y lanza monitoreo CI en background
// Pure Node.js — sin dependencia de bash ni ci-monitor.sh
// Polling: consulta GitHub Actions cada 30s hasta que el workflow concluya, luego notifica via Telegram
const { execSync, spawn } = require("child_process");
const path = require("path");
const fs = require("fs");

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || "C:\\Workspaces\\Intrale\\platform";

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

function markWaitingCi(branch, sha) {
    // Escribir waiting_state en la session activa para la rama
    const waitingState = {
        reason: "ci",
        detail: "Esperando GitHub Actions... (commit " + sha.substring(0, 7) + ")",
        started_at: new Date().toISOString(),
        status: "starting",
        branch: branch
    };
    try {
        const sessionsDir = path.join(PROJECT_DIR, ".claude", "sessions");
        if (!fs.existsSync(sessionsDir)) return null;
        const files = fs.readdirSync(sessionsDir).filter(f => f.endsWith(".json"));
        let updatedFile = null;
        let latestMtime = 0;
        // Buscar la session más reciente con esta rama
        for (const f of files) {
            try {
                const filePath = path.join(sessionsDir, f);
                const session = JSON.parse(fs.readFileSync(filePath, "utf8"));
                if ((session.branch || "") !== branch) continue;
                const mtime = fs.statSync(filePath).mtimeMs;
                if (mtime > latestMtime) {
                    latestMtime = mtime;
                    updatedFile = filePath;
                }
            } catch(e) {}
        }
        if (updatedFile) {
            const session = JSON.parse(fs.readFileSync(updatedFile, "utf8"));
            session.waiting_state = waitingState;
            fs.writeFileSync(updatedFile, JSON.stringify(session, null, 2) + "\n", "utf8");
            return updatedFile;
        }
    } catch(e) {}
    return null;
}

function handleInput() {
    try {
        const data = JSON.parse(input || "{}");
        const command = (data.tool_input && data.tool_input.command) || "";
        if (!command.includes("git push")) return;

        // Verificar que no hubo error en stderr
        const stderr = (data.tool_result && data.tool_result.stderr) || "";
        if (/error|rejected|denied|failed/i.test(stderr)) return;

        // Obtener SHA y branch
        let sha, branch;
        try {
            sha = execSync("git rev-parse HEAD", { cwd: PROJECT_DIR, encoding: "utf8", windowsHide: true }).trim();
            branch = execSync("git branch --show-current", { cwd: PROJECT_DIR, encoding: "utf8", windowsHide: true }).trim();
        } catch(e) { return; }
        if (!sha || !branch) return;

        // Marcar inicio de espera de CI en la session activa
        const sessionFile = markWaitingCi(branch, sha);

        // Lanzar monitoreo CI en background (proceso hijo desacoplado)
        const monitorScript = path.join(__dirname, "ci-monitor-bg.js");
        const args = [monitorScript, sha, branch, PROJECT_DIR];
        if (sessionFile) args.push(sessionFile);
        const child = spawn(process.execPath, args, {
            detached: true,
            stdio: "ignore",
            windowsHide: true,
            env: { ...process.env, CLAUDE_PROJECT_DIR: PROJECT_DIR }
        });
        child.unref();
    } catch(e) {}
}
