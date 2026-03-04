// agent-progress.js — PostToolUse hook: progreso visual en terminal de agente (#1206)
// Imprime un bloque compacto de estado a stderr despues de hitos significativos.
// Throttle: maximo 1 impresion cada 30s para no spamear.
// Pure Node.js — sin dependencias externas.

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

// --- Configuracion -----------------------------------------------------------

const THROTTLE_MS = 30000; // 30 segundos entre impresiones
const STATE_FILE = path.join(__dirname, "agent-progress-state.json");

// Herramientas que disparan impresion (hitos significativos)
const TRIGGER_TOOLS = new Set([
    "TaskCreate", "TaskUpdate", "Skill", "Edit", "Write", "Bash"
]);

// --- Resolver rutas ----------------------------------------------------------

function resolveMainRepoRoot() {
    const candidate = process.env.CLAUDE_PROJECT_DIR || "C:\\Workspaces\\Intrale\\platform";
    try {
        const gitCommon = execSync("git rev-parse --git-common-dir", {
            cwd: candidate, timeout: 3000, windowsHide: true
        }).toString().trim().replace(/\\/g, "/");
        if (gitCommon === ".git") return candidate;
        const gitIdx = gitCommon.indexOf("/.git");
        if (gitIdx !== -1) return gitCommon.substring(0, gitIdx);
        return path.resolve(gitCommon, "..");
    } catch (e) { return candidate; }
}

const WORKTREE_ROOT = process.env.CLAUDE_PROJECT_DIR || "C:\\Workspaces\\Intrale\\platform";
const REPO_ROOT = resolveMainRepoRoot();
const SESSIONS_DIR = path.join(REPO_ROOT, ".claude", "sessions");
const PLAN_FILE = path.join(REPO_ROOT, "scripts", "sprint-plan.json");

// --- Leer stdin (hook input) -------------------------------------------------

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
setTimeout(() => {
    if (!done) { done = true; try { process.stdin.destroy(); } catch (e) {} handleInput(); }
}, 2000);

// --- Logica principal --------------------------------------------------------

function handleInput() {
    try {
        let data;
        try { data = JSON.parse(input); } catch (e) {
            // Intento parcial de parseo
            const m = input.match(/"tool_name"\s*:\s*"([^"]+)"/);
            if (!m) return;
            data = { tool_name: m[1], tool_input: {} };
        }

        const toolName = data.tool_name || "";
        if (!toolName) return;

        // Solo disparar en hitos significativos
        if (!TRIGGER_TOOLS.has(toolName)) return;

        // Para Bash, solo disparar en comandos git (push, commit, merge) o gradle
        if (toolName === "Bash") {
            const cmd = (data.tool_input || {}).command || "";
            const isSignificant = /\b(git\s+(push|commit|merge|checkout)|gradlew|gh\s+(pr|issue))\b/.test(cmd);
            if (!isSignificant) return;
        }

        // Throttle: verificar tiempo desde ultima impresion
        const now = Date.now();
        const sessionId = (data.session_id || "").substring(0, 8);
        let state = {};
        try {
            if (fs.existsSync(STATE_FILE)) {
                state = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
            }
        } catch (e) { state = {}; }

        const lastPrint = state[sessionId] || 0;
        if (now - lastPrint < THROTTLE_MS) return;

        // Buscar sesion y datos del agente
        const sessionData = loadSession(sessionId);
        if (!sessionData) return;

        // Obtener info del sprint plan para identificar agente
        const agentInfo = identifyAgent(sessionData);

        // Construir y mostrar bloque de progreso
        const block = buildProgressBlock(sessionData, agentInfo);
        if (!block) return;

        // Imprimir a stderr (visible en terminal del agente)
        process.stderr.write(block);

        // Actualizar timestamp de ultima impresion
        state[sessionId] = now;
        try { fs.writeFileSync(STATE_FILE, JSON.stringify(state), "utf8"); } catch (e) {}

    } catch (e) { /* no bloquear hook */ }
}

// --- Helpers -----------------------------------------------------------------

function loadSession(sessionId) {
    if (!sessionId) return null;
    const sessionFile = path.join(SESSIONS_DIR, sessionId + ".json");
    try {
        if (!fs.existsSync(sessionFile)) return null;
        return JSON.parse(fs.readFileSync(sessionFile, "utf8"));
    } catch (e) { return null; }
}

function identifyAgent(session) {
    // Intentar match por branch contra sprint-plan.json
    const info = { numero: "?", issue: "?", slug: "" };

    try {
        if (!fs.existsSync(PLAN_FILE)) return info;
        const plan = JSON.parse(fs.readFileSync(PLAN_FILE, "utf8"));
        if (!plan.agentes || !Array.isArray(plan.agentes)) return info;

        const branch = session.branch || "";
        const branchMatch = branch.match(/^agent\/(\d+)-(.+)$/);
        if (!branchMatch) return info;

        const issueNum = parseInt(branchMatch[1], 10);
        info.issue = String(issueNum);
        info.slug = branchMatch[2];

        const agente = plan.agentes.find(a => a.issue === issueNum);
        if (agente) {
            info.numero = String(agente.numero);
            info.slug = agente.slug;
        }
    } catch (e) {}

    return info;
}

function buildProgressBlock(session, agentInfo) {
    const tasks = session.current_tasks || [];
    const agentName = session.agent_name || "Agente " + agentInfo.numero;
    const elapsed = getElapsed(session.started_ts);

    // Linea de encabezado
    const headerLine = " Agente " + agentInfo.numero + " \u00B7 #" + agentInfo.issue + " \u00B7 " + agentInfo.slug;

    const lines = [];
    lines.push("\n\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500");
    lines.push(headerLine);

    if (tasks.length === 0) {
        // No hay tareas trackeadas -- mostrar actividad general
        const actionCount = session.action_count || 0;
        const lastTool = session.last_tool || "?";
        const currentTask = session.current_task;
        if (currentTask) {
            lines.push(" \u25B6 " + currentTask);
        } else {
            lines.push(" " + actionCount + " acciones \u00B7 ultimo: " + lastTool + " \u00B7 " + elapsed);
        }
    } else {
        // Hay tareas -- mostrar progreso con checkboxes
        let completedCount = 0;
        let totalCount = tasks.length;

        for (const task of tasks) {
            const status = task.status || "pending";
            let icon;
            if (status === "completed") {
                icon = " \u2611";  // checked box
                completedCount++;
            } else if (status === "in_progress") {
                icon = " \u2610\u25BA"; // unchecked box + arrow
            } else {
                icon = " \u2610";  // unchecked box
            }

            let taskLine = icon + " " + task.subject;

            // Sub-pasos si existen
            if (Array.isArray(task.steps) && task.steps.length > 0 && status === "in_progress") {
                const completedSteps = Array.isArray(task.completed_steps) ? task.completed_steps : [];
                const currentStep = task.current_step || 0;
                const pct = task.progress || 0;
                taskLine += " (" + completedSteps.length + "/" + task.steps.length + " \u00B7 " + pct + "%)";
            }

            lines.push(taskLine);
        }

        // Barra de progreso
        const pct = totalCount > 0 ? Math.round((completedCount / totalCount) * 100) : 0;
        const barWidth = 20;
        const filled = Math.round(barWidth * pct / 100);
        const empty = barWidth - filled;
        const bar = "\u2588".repeat(filled) + "\u2591".repeat(empty);
        lines.push(" \u2500\u2500 " + bar + " " + completedCount + "/" + totalCount + " \u00B7 " + pct + "% \u00B7 " + elapsed + " \u2500\u2500");
    }

    lines.push("\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n");

    return lines.join("\n");
}

function getElapsed(startedTs) {
    if (!startedTs) return "?m";
    try {
        const started = new Date(startedTs).getTime();
        const now = Date.now();
        const diffMin = Math.round((now - started) / 60000);
        if (diffMin < 60) return diffMin + "m";
        const h = Math.floor(diffMin / 60);
        const m = diffMin % 60;
        return h + "h" + (m > 0 ? m + "m" : "");
    } catch (e) { return "?m"; }
}
