// Hook PostToolUse[Bash]: detecta git push y lanza monitoreo CI en background
// Pure Node.js — sin dependencia de bash ni ci-monitor.sh
// Polling: consulta GitHub Actions cada 30s hasta que el workflow concluya, luego notifica via Telegram
// #1356: al detectar git push, marca el agente como "waiting" en sprint-plan.json y promueve siguiente de cola
const { execSync, spawn } = require("child_process");
const path = require("path");
const fs = require("fs");

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || "C:\\Workspaces\\Intrale\\platform";
const HOOKS_DIR = path.join(PROJECT_DIR, ".claude", "hooks");
const LOG_FILE = path.join(HOOKS_DIR, "hook-debug.log");
const PLAN_FILE = path.join(PROJECT_DIR, "scripts", "sprint-plan.json");
const START_SCRIPT = path.join(PROJECT_DIR, "scripts", "Start-Agente.ps1");

function logHook(msg) {
    try { fs.appendFileSync(LOG_FILE, "[" + new Date().toISOString() + "] PostGitPush: " + msg + "\n"); } catch(e) {}
}

function escHtml(str) {
    return (str || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

async function notifyTelegram(text) {
    try {
        const cfg = JSON.parse(fs.readFileSync(path.join(HOOKS_DIR, "telegram-config.json"), "utf8"));
        const https = require("https");
        const querystring = require("querystring");
        const postData = querystring.stringify({ chat_id: cfg.chat_id, text: text, parse_mode: "HTML" });
        await new Promise((resolve) => {
            const req = https.request({
                hostname: "api.telegram.org",
                path: "/bot" + cfg.bot_token + "/sendMessage",
                method: "POST",
                headers: { "Content-Type": "application/x-www-form-urlencoded" },
                timeout: 6000
            }, (res) => { res.resume(); resolve(); });
            req.on("error", resolve);
            req.on("timeout", () => { req.destroy(); resolve(); });
            req.write(postData);
            req.end();
        });
    } catch(e) { logHook("notifyTelegram error: " + e.message); }
}

function launchAgentFromPlan(agente) {
    try {
        if (!fs.existsSync(START_SCRIPT)) { logHook("Start-Agente.ps1 no encontrado"); return false; }
        const ps1 = START_SCRIPT.replace(/\//g, "\\");
        const child = spawn("powershell.exe", ["-NonInteractive", "-File", ps1, String(agente.numero)], {
            detached: true, stdio: "ignore", windowsHide: false
        });
        child.unref();
        logHook("Agente " + agente.numero + " (issue #" + agente.issue + ") lanzado desde cola (PID " + child.pid + ")");
        return true;
    } catch(e) { logHook("launchAgentFromPlan error: " + e.message); return false; }
}

// Marca el agente como "waiting" en sprint-plan.json y promueve el siguiente de la cola (#1356)
async function markAgentWaitingInPlan(branch) {
    if (!fs.existsSync(PLAN_FILE)) return;
    let plan;
    try { plan = JSON.parse(fs.readFileSync(PLAN_FILE, "utf8")); } catch(e) { return; }
    if (!Array.isArray(plan.agentes)) return;

    // Encontrar el agente por branch
    const agent = plan.agentes.find(ag =>
        branch.includes("/" + String(ag.issue) + "-") ||
        branch === "agent/" + ag.issue + "-" + (ag.slug || "")
    );
    if (!agent) { logHook("markAgentWaitingInPlan: sin coincidencia para branch " + branch); return; }
    if (agent.status === "waiting") { logHook("Agente #" + agent.issue + " ya está en waiting — sin cambios"); return; }

    // Marcar como waiting
    agent.status = "waiting";
    agent.waiting_since = new Date().toISOString();
    agent.waiting_reason = "ci";

    const concurrencyLimit = plan.concurrency_limit || 3;
    // Contar solo agentes activos (no-waiting): este agente ahora libera su slot
    const activeCount = plan.agentes.filter(ag => ag.status !== "waiting").length;
    const queue = Array.isArray(plan._queue) ? plan._queue : (Array.isArray(plan.cola) ? plan.cola : []);

    logHook("Agente #" + agent.issue + " en waiting (CI) — activos no-waiting: " + activeCount + "/" + concurrencyLimit + " — cola: " + queue.length);

    if (activeCount < concurrencyLimit && queue.length > 0) {
        // Promover siguiente de la cola
        const nextAgent = queue[0];
        const newQueue = queue.slice(1);
        const maxNumero = plan.agentes.reduce((m, ag) => Math.max(m, ag.numero || 0), 0);
        nextAgent.numero = maxNumero + 1;
        plan.agentes.push(nextAgent);
        if (Array.isArray(plan._queue)) plan._queue = newQueue;
        else plan.cola = newQueue;

        // #1736: escribir al roadmap (fuente de verdad), no directo al cache
        try {
            const sd = require(path.join(PROJECT_DIR, ".claude", "hooks", "sprint-data.js"));
            sd.saveRoadmapFromPlan(plan, "post-git-push");
        } catch(e) { logHook("saveRoadmapFromPlan error: " + e.message); }
        logHook("Agente #" + agent.issue + " en waiting (CI) — slot liberado, promoviendo #" + nextAgent.issue + " de cola");

        const launched = launchAgentFromPlan(nextAgent);
        const waitingTotal = plan.agentes.filter(ag => ag.status === "waiting").length;
        const activeNow = plan.agentes.filter(ag => ag.status !== "waiting").length;

        await notifyTelegram(
            "⏳ <b>Slot liberado — Agente #" + agent.issue + " en espera de CI</b>\n" +
            (launched
                ? "🚀 Promovido #" + nextAgent.issue + " (" + escHtml(nextAgent.slug || "") + ") de la cola\n"
                : "⚠️ Issue #" + nextAgent.issue + " movido a agentes pero sin lanzar automáticamente\n") +
            "Slots activos: <b>" + activeNow + "/" + concurrencyLimit + "</b>" +
            (waitingTotal > 0 ? " (+ " + waitingTotal + " en waiting)" : "") + "\n" +
            "Cola restante: " + newQueue.length + " issue(s)"
        );
    } else {
        // #1736: escribir al roadmap (fuente de verdad), no directo al cache
        try {
            const sd = require(path.join(PROJECT_DIR, ".claude", "hooks", "sprint-data.js"));
            sd.saveRoadmapFromPlan(plan, "post-git-push");
        } catch(e) { logHook("saveRoadmapFromPlan error: " + e.message); }
        if (queue.length === 0) {
            logHook("Agente #" + agent.issue + " en waiting (CI) — cola vacía, sin promoción");
        } else {
            logHook("Agente #" + agent.issue + " en waiting (CI) — slots llenos (" + activeCount + "/" + concurrencyLimit + "), sin promoción");
        }
    }
}

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

async function handleInput() {
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

        // Marcar agente como waiting en sprint-plan.json y promover siguiente de cola (#1356)
        if (branch.startsWith("agent/")) {
            await markAgentWaitingInPlan(branch);
        }

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
