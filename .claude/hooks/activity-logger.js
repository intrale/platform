// Monitor v3 -- Activity Logger Hook
// PostToolUse hook: registra actividad en activity-log.jsonl y actualiza sesion en sessions/
// Pure Node.js — sin dependencia de bash
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

// Resolver REPO_ROOT al repo principal (no al worktree)
function resolveMainRepoRoot() {
    const candidate = process.env.CLAUDE_PROJECT_DIR || "C:\\Workspaces\\Intrale\\platform";
    try {
        const gitCommon = execSync("git rev-parse --git-common-dir", { cwd: candidate, timeout: 3000, windowsHide: true })
            .toString().trim().replace(/\\/g, "/");
        // Si retorna ".git" → estamos en el repo principal
        if (gitCommon === ".git") return candidate;
        // Si retorna ruta absoluta (ej: /c/Workspaces/Intrale/platform/.git/worktrees/...)
        // buscar el componente ".git" y tomar su padre
        const gitIdx = gitCommon.indexOf("/.git");
        if (gitIdx !== -1) return gitCommon.substring(0, gitIdx);
        // Fallback: subir desde gitCommon hasta encontrar .git
        return path.resolve(gitCommon, "..");
    } catch(e) { return candidate; }
}

const WORKTREE_ROOT = process.env.CLAUDE_PROJECT_DIR || "C:\\Workspaces\\Intrale\\platform";
const REPO_ROOT = resolveMainRepoRoot();
const LOG_FILE = path.join(REPO_ROOT, ".claude", "activity-log.jsonl");
const SESSIONS_DIR = path.join(REPO_ROOT, ".claude", "sessions");
const MAX_LINES = 500;

const AGENT_MAP = {
    "/guru": "Guru",
    "/planner": "Planner",
    "/doc": "Doc",
    "/delivery": "DeliveryManager",
    "/tester": "Tester",
    "/monitor": "Monitor",
    "/auth": "Auth",
    "/refinar": "Doc (refinar)",
    "/priorizar": "Doc (priorizar)",
    "/historia": "Doc (historia)",
    "/builder": "Builder",
    "/review": "Review",
    "/qa": "QA",
};

// Mapeo de issue number a "Agente N" desde sprint-plan.json
function getSprintAgentName(issueNum) {
    try {
        const planPath = path.join(REPO_ROOT, "scripts", "sprint-plan.json");
        const plan = JSON.parse(fs.readFileSync(planPath, "utf8"));
        if (!Array.isArray(plan.agentes)) return null;
        const entry = plan.agentes.find(a => a.issue === issueNum);
        return entry ? "Agente " + entry.numero : null;
    } catch(e) { return null; }
}

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

function getBranch() {
    try {
        return execSync("git branch --show-current", { cwd: WORKTREE_ROOT, timeout: 3000, windowsHide: true })
            .toString().trim();
    } catch(e) { return "unknown"; }
}

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
            case "Skill":
                target = ti.skill || "--";
                break;
            case "TaskCreate": case "TaskUpdate":
                target = toolName === "TaskCreate"
                    ? "[new pending] " + (ti.subject || "--")
                    : "[#" + (ti.taskId || "?") + " " + (ti.status || "?") + "] " + (ti.subject || "task");
                break;
            case "WebFetch": case "WebSearch":
                target = ti.url || ti.query || "--";
                break;
            case "TodoWrite": {
                // { todos: [{content, status, activeForm}] }
                const todos = Array.isArray(ti.todos) ? ti.todos : [];
                const inP = todos.find(t => t.status === "in_progress");
                target = inP
                    ? (inP.activeForm || inP.content || "--").substring(0, 80)
                    : "todos[" + todos.length + "]";
                break;
            }
        }

        const ts = new Date().toISOString().replace(/\.\d+Z$/, "Z");
        const dir = path.dirname(LOG_FILE);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

        const sessionId = data.session_id || "";
        const logTool = (toolName === "TaskCreate" || toolName === "TaskUpdate") ? "Task" : toolName;
        const entry = JSON.stringify({ ts, session: sessionId.substring(0, 8), tool: logTool, target: target.substring(0, 120) });

        // P-13: Batching — si última escritura fue hace <2s, solo actualizar sesión (skip JSONL append)
        const BATCH_COOLDOWN_MS = 2000;
        const BATCH_STATE_FILE = path.join(path.dirname(LOG_FILE), "hooks", "activity-logger-last.json");
        let skipJsonl = false;
        try {
            if (fs.existsSync(BATCH_STATE_FILE)) {
                const batchState = JSON.parse(fs.readFileSync(BATCH_STATE_FILE, "utf8"));
                if (batchState.ts && (Date.now() - batchState.ts) < BATCH_COOLDOWN_MS) {
                    // Acumular en buffer file
                    const bufferFile = BATCH_STATE_FILE.replace(".json", "-buffer.jsonl");
                    fs.appendFileSync(bufferFile, entry + "\n", "utf8");
                    skipJsonl = true;
                }
            }
        } catch (e) {}

        if (!skipJsonl) {
            // Flush buffer si existe
            const bufferFile = BATCH_STATE_FILE.replace(".json", "-buffer.jsonl");
            try {
                if (fs.existsSync(bufferFile)) {
                    const buffered = fs.readFileSync(bufferFile, "utf8");
                    if (buffered.trim()) {
                        fs.appendFileSync(LOG_FILE, buffered, "utf8");
                    }
                    fs.unlinkSync(bufferFile);
                }
            } catch (e) {}

            fs.appendFileSync(LOG_FILE, entry + "\n", "utf8");

            // Rotacion del JSONL
            try {
                const content = fs.readFileSync(LOG_FILE, "utf8").trim();
                const lines = content.split("\n");
                if (lines.length > MAX_LINES) {
                    const keep = Math.floor(MAX_LINES / 2);
                    fs.writeFileSync(LOG_FILE, lines.slice(-keep).join("\n") + "\n", "utf8");
                }
            } catch(e) {}
        }

        // Actualizar timestamp de batch
        try { fs.writeFileSync(BATCH_STATE_FILE, JSON.stringify({ ts: Date.now() }), "utf8"); } catch (e) {}

        // Actualizar archivo de sesion (siempre — liviano)
        if (sessionId) {
            updateSession(sessionId, ts, toolName, target, ti, data.usage || null);
        }

        // Detectar sesiones stale periódicamente (cada ~10 invocaciones)
        markStaleSessions();

        // Detectar sesiones zombie (PID muerto + >20min inactivas), throttled a 1/min (#1408)
        checkZombieSessions();

        // Auto-iniciar reporter PNG si no esta corriendo
        ensureReporterRunning();
    } catch(e) {}
}

// Marca como "stale" sesiones active con inactividad >2h
// Solo corre 1 de cada 10 veces para no impactar performance
const STALE_CHECK_STATE_FILE = path.join(REPO_ROOT, ".claude", "hooks", "activity-logger-stale-check.json");
const STALE_THRESHOLD_MS = 2 * 60 * 60 * 1000; // 2 horas
const STALE_CHECK_EVERY_N = 10;

const ZOMBIE_THRESHOLD_MS = 20 * 60 * 1000; // 20 minutos (threshold configurable)
const ZOMBIE_CHECK_STATE_FILE = path.join(REPO_ROOT, ".claude", "hooks", "activity-logger-zombie-check.json");
const ZOMBIE_CHECK_THROTTLE_MS = 60 * 1000; // máximo 1 vez por minuto

function markStaleSessions() {
    try {
        // Throttle: solo correr cada N invocaciones
        let count = 0;
        try {
            if (fs.existsSync(STALE_CHECK_STATE_FILE)) {
                const s = JSON.parse(fs.readFileSync(STALE_CHECK_STATE_FILE, "utf8"));
                count = (s.count || 0) + 1;
            } else {
                count = 1;
            }
        } catch(e) { count = 1; }

        fs.writeFileSync(STALE_CHECK_STATE_FILE, JSON.stringify({ count }), "utf8");
        if (count % STALE_CHECK_EVERY_N !== 0) return;

        if (!fs.existsSync(SESSIONS_DIR)) return;
        const now = Date.now();
        const files = fs.readdirSync(SESSIONS_DIR).filter(f => f.endsWith(".json"));
        let staleCount = 0;
        for (const file of files) {
            try {
                const filePath = path.join(SESSIONS_DIR, file);
                const session = JSON.parse(fs.readFileSync(filePath, "utf8"));
                if (session.status !== "active") continue;
                const lastActivity = new Date(session.last_activity_ts || 0).getTime();
                if (now - lastActivity > STALE_THRESHOLD_MS) {
                    // Escritura atómica: tmp + rename
                    session.status = "stale";
                    const tmpPath = filePath + ".tmp";
                    fs.writeFileSync(tmpPath, JSON.stringify(session, null, 2) + "\n", "utf8");
                    fs.renameSync(tmpPath, filePath);
                    staleCount++;
                }
            } catch(e) { /* ignorar errores por archivo */ }
        }
        if (staleCount > 0) {
            const logFile = path.join(REPO_ROOT, ".claude", "hooks", "hook-debug.log");
            try { fs.appendFileSync(logFile, "[" + new Date().toISOString() + "] activity-logger: " + staleCount + " sesion(es) marcadas stale\n"); } catch(e) {}
        }
    } catch(e) { /* no bloquear hook */ }
}

// Verifica si un PID de proceso sigue vivo en Windows
function isPidAlive(pid) {
    if (!pid) return false;
    try {
        const output = execSync('tasklist /FI "PID eq ' + parseInt(pid, 10) + '" /NH', {
            timeout: 3000, windowsHide: true, encoding: "utf8"
        });
        // Si el PID existe, la salida contiene una línea con el nombre del proceso
        // Si no existe: "No tasks are running which match the specified criteria"
        return output.indexOf("No tasks") === -1 && output.trim().length > 0;
    } catch (e) {
        // Fallback: process.kill(pid, 0) solo verifica existencia sin matar
        try { process.kill(parseInt(pid, 10), 0); return true; } catch (ke) { return ke.code === "EPERM"; }
    }
}

// Detecta sesiones zombie: status "active" + last_activity_ts >20min + PID muerto
// Throttled: corre como máximo 1 vez por minuto (#1408)
function checkZombieSessions() {
    try {
        // Throttle: solo correr cada ZOMBIE_CHECK_THROTTLE_MS
        try {
            if (fs.existsSync(ZOMBIE_CHECK_STATE_FILE)) {
                const s = JSON.parse(fs.readFileSync(ZOMBIE_CHECK_STATE_FILE, "utf8"));
                if (s.last_check && (Date.now() - s.last_check) < ZOMBIE_CHECK_THROTTLE_MS) return;
            }
        } catch(e) { /* si falla leer el state, continuar */ }
        fs.writeFileSync(ZOMBIE_CHECK_STATE_FILE, JSON.stringify({ last_check: Date.now() }), "utf8");

        if (!fs.existsSync(SESSIONS_DIR)) return;
        const now = Date.now();
        const files = fs.readdirSync(SESSIONS_DIR).filter(f => f.endsWith(".json"));
        let zombieCount = 0;
        for (const file of files) {
            try {
                const filePath = path.join(SESSIONS_DIR, file);
                const session = JSON.parse(fs.readFileSync(filePath, "utf8"));
                if (session.status !== "active") continue;
                const age = now - new Date(session.last_activity_ts || 0).getTime();
                if (age > ZOMBIE_THRESHOLD_MS && session.pid) {
                    if (!isPidAlive(session.pid)) {
                        session.status = "done";
                        session.completed_at = session.last_activity_ts;
                        // Escritura atómica: tmp + rename
                        const tmpPath = filePath + ".tmp";
                        fs.writeFileSync(tmpPath, JSON.stringify(session, null, 2) + "\n", "utf8");
                        fs.renameSync(tmpPath, filePath);
                        zombieCount++;
                    }
                }
            } catch(e) { /* ignorar errores por archivo */ }
        }
        if (zombieCount > 0) {
            const logFile = path.join(REPO_ROOT, ".claude", "hooks", "hook-debug.log");
            try { fs.appendFileSync(logFile, "[" + new Date().toISOString() + "] activity-logger: " + zombieCount + " sesion(es) zombie marcadas done (PID muerto)\n"); } catch(e) {}
        }
    } catch(e) { /* no bloquear hook */ }
}

// --- Auto-inicio del dashboard web server + reporter ---
const DASHBOARD_SERVER_PID_FILE = path.join(REPO_ROOT, ".claude", "hooks", "dashboard-server.pid");
const REPORTER_PID_FILE = path.join(REPO_ROOT, ".claude", "tmp", "reporter.pid");
const REPORTER_INTERVAL = (() => {
    try {
        const cfg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, ".claude", "hooks", "telegram-config.json"), "utf8"));
        const val = parseInt(cfg.task_report_interval_min, 10);
        return isNaN(val) || val <= 0 ? 5 : val;
    } catch(e) { return 5; }
})();

// El heartbeat de Telegram ahora está integrado en dashboard-server.js.
// Este hook solo necesita asegurar que el dashboard server esté corriendo.
// En worktrees, .git es un archivo (no directorio), por lo que .git/HEAD no existe como ruta.
// Los worktrees NUNCA lanzan dashboard-server — usan la instancia del repo principal via HTTP (#1429).
function ensureReporterRunning() {
    // Detectar si estamos en un worktree: los worktrees tienen .git como archivo, no directorio.
    // En el repo principal, .git es un directorio y .git/HEAD existe.
    // En un worktree, .git es un archivo plano → .git/HEAD no existe como ruta.
    if (!fs.existsSync(path.join(WORKTREE_ROOT, ".git", "HEAD"))) return;
    ensureDashboardServerRunning();
}

function ensureDashboardServerRunning() {
    try {
        // 1. Verificar PID file del dashboard web server usando isPidAlive() (Windows-safe) (#1428)
        if (fs.existsSync(DASHBOARD_SERVER_PID_FILE)) {
            const pid = parseInt(fs.readFileSync(DASHBOARD_SERVER_PID_FILE, "utf8").trim(), 10);
            if (!isNaN(pid) && isPidAlive(pid)) {
                return; // Proceso vivo — no arrancar otra instancia (#1412)
            }
            // PID muerto — limpiar PID file stale antes de continuar (#1428)
            try { fs.unlinkSync(DASHBOARD_SERVER_PID_FILE); } catch(e) {}
        }

        // 2. HTTP health check: TCP connect check en puerto 3100 (#1428)
        try {
            execSync('node -e "const r=require(\'http\').get(\'http://localhost:3100/health\',{timeout:2000},s=>{process.exit(s.statusCode===200?0:1)});r.on(\'error\',()=>process.exit(1))"', { timeout: 4000, windowsHide: true, stdio: "ignore" });
            return; // Server responde, no arrancar otro
        } catch(e) { /* server no responde, arrancar */ }

        // 3. Arrancar dashboard-server.js
        const dashboardServer = path.join(REPO_ROOT, ".claude", "dashboard-server.js");
        if (!fs.existsSync(dashboardServer)) return;

        const { spawn } = require("child_process");
        const child = spawn(process.execPath, [dashboardServer], {
            detached: true,
            stdio: "ignore",
            windowsHide: true,
            cwd: path.dirname(dashboardServer),
        });
        child.on("error", () => {});
        // Escribir PID inmediatamente para prevenir lanzamientos concurrentes (#1428)
        if (child.pid) {
            try {
                fs.writeFileSync(DASHBOARD_SERVER_PID_FILE, String(child.pid), "utf8");
            } catch(e) {}
        }
        child.unref();
    } catch(e) { /* no bloquear hook */ }
}

// Detectar si un tool use indica inicio de una espera legítima
// Retorna { reason, detail, started_at } o null
function detectWaitingState(toolName, toolInput, ts) {
    if (toolName !== "Bash" && toolName !== "Skill") return null;

    if (toolName === "Bash") {
        const cmd = (toolInput.command || "").trim();

        // Esperando CI: git push
        if (/^git push(\s|$)/.test(cmd) || /\bgit push\b/.test(cmd)) {
            return { reason: "ci", detail: "Esperando GitHub Actions...", started_at: ts, status: "starting" };
        }

        // Esperando merge: gh pr merge
        if (/gh\s+pr\s+merge/.test(cmd)) {
            return { reason: "merge", detail: "Esperando merge del PR...", started_at: ts, status: "in_progress" };
        }

        // PR creado, esperando checks
        if (/gh\s+pr\s+create/.test(cmd)) {
            return { reason: "merge_pending", detail: "PR creado, esperando revisión/checks...", started_at: ts, status: "in_progress" };
        }

        // Build Gradle en curso
        if (/gradlew\b/.test(cmd) && !/^#/.test(cmd)) {
            const taskMatch = cmd.match(/gradlew\s+([^\s]+)/);
            const task = taskMatch ? taskMatch[1] : "build";
            return { reason: "build", detail: "Build Gradle: " + task, started_at: ts, status: "in_progress" };
        }
    }

    if (toolName === "Skill") {
        const skill = toolInput.skill || "";
        // /delivery invoca git push + pr create → inicia ciclo CI
        if (skill === "delivery") {
            return { reason: "ci", detail: "Ejecutando /delivery (commit+push+PR)...", started_at: ts, status: "starting" };
        }
    }

    return null;
}

// Sincroniza el estado waiting del agente en sprint-plan.json (#1356).
// Solo actualiza el status — la promoción de cola la maneja post-git-push.js.
// Es idempotente: si el agente ya está en waiting, no hace nada.
function syncWaitingToSprintPlan(branch, reason) {
    try {
        const planPath = path.join(REPO_ROOT, "scripts", "sprint-plan.json");
        if (!fs.existsSync(planPath)) return;
        const plan = JSON.parse(fs.readFileSync(planPath, "utf8"));
        if (!Array.isArray(plan.agentes)) return;
        const agent = plan.agentes.find(ag =>
            branch.includes("/" + String(ag.issue) + "-") ||
            branch === "agent/" + ag.issue + "-" + (ag.slug || "")
        );
        if (!agent || agent.status === "waiting") return;
        agent.status = "waiting";
        agent.waiting_since = new Date().toISOString();
        agent.waiting_reason = reason || "unknown";
        fs.writeFileSync(planPath, JSON.stringify(plan, null, 2) + "\n", "utf8");
    } catch(e) { /* no bloquear hook */ }
}

function updateSession(sessionId, ts, toolName, target, toolInput, usage) {
    try {
        if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });

        const shortId = sessionId.substring(0, 8);
        const sessionFile = path.join(SESSIONS_DIR, shortId + ".json");

        let session;
        if (fs.existsSync(sessionFile)) {
            try { session = JSON.parse(fs.readFileSync(sessionFile, "utf8")); } catch(e) { session = null; }
        }

        if (!session) {
            session = {
                id: shortId,
                full_id: sessionId,
                type: "parent",
                started_ts: ts,
                last_activity_ts: ts,
                action_count: 0,
                status: "active",
                branch: getBranch(),
                pid: process.ppid,
                last_tool: toolName,
                last_target: target.substring(0, 120),
                agent_name: null,
                skills_invoked: [],
                sub_count: 0,
                permission_mode: "unknown",
                current_task: null,
                current_tasks: [],
            };
        }

        session.last_activity_ts = ts;
        session.action_count = (session.action_count || 0) + 1;
        // No sobreescribir status "done" — la sesión puede haber terminado (hook Stop ya corrió)
        if (session.status !== "done") session.status = "active";
        session.last_tool = toolName;
        session.last_target = target.substring(0, 120);

        // Métricas cuantitativas (#1226)
        if (!session.tool_counts) session.tool_counts = {};
        const tcKey = (toolName === "TaskCreate" || toolName === "TaskUpdate") ? "Task" : toolName;
        session.tool_counts[tcKey] = (session.tool_counts[tcKey] || 0) + 1;

        if ((toolName === "Edit" || toolName === "Write" || toolName === "NotebookEdit") && toolInput.file_path) {
            if (!session.modified_files) session.modified_files = [];
            const normalized = toolInput.file_path.replace(/\\/g, "/").toLowerCase();
            if (!session.modified_files.includes(normalized)) {
                session.modified_files.push(normalized);
            }
        }

        if (toolName === "TaskCreate") {
            session.tasks_created = (session.tasks_created || 0) + 1;
        }
        if (toolName === "TaskUpdate" && toolInput.status === "completed") {
            session.tasks_completed = (session.tasks_completed || 0) + 1;
        }

        // Detectar skill invocado y mapear a agente
        if (toolName === "Skill") {
            const skillName = "/" + (toolInput.skill || "");
            if (skillName !== "/" && !session.skills_invoked.includes(skillName)) {
                // Registrar transición entre agentes
                if (!session.agent_transitions) session.agent_transitions = [];
                const prevAgent = session.skills_invoked.length > 0
                    ? (AGENT_MAP[session.skills_invoked[session.skills_invoked.length - 1]] || session.skills_invoked[session.skills_invoked.length - 1])
                    : (session.agent_name || "Claude");
                const nextAgent = AGENT_MAP[skillName] || skillName;
                session.agent_transitions.push({ from: prevAgent, to: nextAgent, ts });

                session.skills_invoked.push(skillName);
            }
            if (AGENT_MAP[skillName] && !session.agent_name) {
                session.agent_name = AGENT_MAP[skillName];
            }
        }

        // Fallback agent_name desde branch (solo si aún es null y tiene >2 acciones)
        if (!session.agent_name && session.action_count > 2 && session.branch) {
            const branchMatch = session.branch.match(/^agent\/(\d+)/);
            if (branchMatch) {
                const issueNum = parseInt(branchMatch[1], 10);
                const sprintName = getSprintAgentName(issueNum);
                session.agent_name = sprintName || ("Agente (#" + issueNum + ")");
            } else if (session.branch !== "main" && session.branch !== "develop" && session.branch !== "unknown") {
                const slug = session.branch.replace(/^[^/]+\//, "").substring(0, 20);
                session.agent_name = "Agente (" + slug + ")";
            }
        }

        // Tracking de tareas para visibilidad cross-session
        if (toolName === "TaskCreate") {
            if (!session.current_tasks) session.current_tasks = [];
            const nextId = String(session.current_tasks.length + 1);
            const meta = toolInput.metadata || {};
            const taskEntry = {
                id: nextId,
                subject: (toolInput.subject || "--").substring(0, 120),
                status: "pending"
            };
            // Sub-pasos: persistir steps si vienen en metadata
            if (Array.isArray(meta.steps) && meta.steps.length > 0) {
                taskEntry.steps = meta.steps.map(s => String(s).substring(0, 80));
                taskEntry.completed_steps = [];
                taskEntry.current_step = 0;
                taskEntry.progress = 0;
            }
            session.current_tasks.push(taskEntry);
        }

        if (toolName === "TaskUpdate" && toolInput.taskId) {
            if (!session.current_tasks) session.current_tasks = [];
            const task = session.current_tasks.find(t => t.id === toolInput.taskId);
            const meta = toolInput.metadata || {};
            if (task) {
                if (toolInput.status) task.status = toolInput.status;
                if (toolInput.subject) task.subject = toolInput.subject.substring(0, 120);
                // Sub-pasos: actualizar progreso desde metadata
                if (meta.current_step != null) task.current_step = Number(meta.current_step);
                if (Array.isArray(meta.completed_steps)) {
                    task.completed_steps = meta.completed_steps.map(s => String(s).substring(0, 80));
                }
                // Calcular progress automáticamente
                if (Array.isArray(task.steps) && task.steps.length > 0) {
                    const done = Array.isArray(task.completed_steps) ? task.completed_steps.length : 0;
                    task.progress = Math.round((done / task.steps.length) * 100);
                } else if (meta.current_step != null && meta.total_steps != null) {
                    task.progress = Math.round((Number(meta.current_step) / Number(meta.total_steps)) * 100);
                }
                // Marcar 100% al completar
                if (toolInput.status === "completed" && Array.isArray(task.steps)) {
                    task.progress = 100;
                    task.current_step = task.steps.length;
                    task.completed_steps = task.steps.slice();
                }
            } else {
                // Tarea no trackeada previamente — agregar con los datos disponibles
                const newTask = {
                    id: toolInput.taskId,
                    subject: (toolInput.subject || "task #" + toolInput.taskId).substring(0, 120),
                    status: toolInput.status || "pending"
                };
                if (Array.isArray(meta.steps) && meta.steps.length > 0) {
                    newTask.steps = meta.steps.map(s => String(s).substring(0, 80));
                    newTask.completed_steps = Array.isArray(meta.completed_steps) ? meta.completed_steps : [];
                    newTask.current_step = meta.current_step != null ? Number(meta.current_step) : 0;
                    newTask.progress = Math.round((newTask.completed_steps.length / newTask.steps.length) * 100);
                }
                session.current_tasks.push(newTask);
            }
        }

        // Sincronizar current_tasks[] y current_task desde TodoWrite
        if (toolName === "TodoWrite" && Array.isArray(toolInput.todos)) {
            const todos = toolInput.todos;
            // Reemplazar current_tasks con el estado completo del array de todos
            session.current_tasks = todos.map((todo, idx) => ({
                id: String(idx + 1),
                subject: (todo.content || "--").substring(0, 120),
                status: todo.status || "pending",
                activeForm: todo.activeForm || null,
            }));
            // Actualizar current_task con la tarea en progreso
            const inProgressTodo = todos.find(t => t.status === "in_progress");
            session.current_task = inProgressTodo
                ? (inProgressTodo.activeForm || inProgressTodo.content || null)
                : null;
            // Contar completadas
            const completedCount = todos.filter(t => t.status === "completed").length;
            session.tasks_completed = completedCount;
            session.tasks_created = todos.length;
        }

        // Mantener current_task (singular) para activeForm en panel SESIONES
        if (toolName === "TaskUpdate") {
            if (toolInput.status === "in_progress" && toolInput.activeForm) {
                session.current_task = toolInput.activeForm;
            } else if (toolInput.status === "completed") {
                session.current_task = null;
            }
        }

        // Detectar y registrar estado de espera legítima
        const waitingState = detectWaitingState(toolName, toolInput, ts);
        if (waitingState) {
            const wasAlreadyWaiting = !!session.waiting_state;
            session.waiting_state = waitingState;
            // Si es la primera vez que entra en waiting, sincronizar sprint-plan.json (#1356)
            // post-git-push.js ya maneja el caso "git push" con promoción de cola.
            // Aquí cubrimos otros signals (gh pr create, /delivery) — solo actualizamos el estado.
            if (!wasAlreadyWaiting && session.branch && session.branch.startsWith("agent/")) {
                syncWaitingToSprintPlan(session.branch, waitingState.reason);
            }
        } else if (session.waiting_state) {
            // Si hay actividad real (no Bash trivial) después de espera → limpiar
            const clearOnTools = ["Edit", "Write", "NotebookEdit", "TaskCreate"];
            if (clearOnTools.includes(toolName)) {
                session.waiting_state = null;
            }
        }

        // Detectar sub-agentes (Task tool)
        if (toolName === "Task") {
            session.sub_count = (session.sub_count || 0) + 1;
        }

        // Tracking de tokens por sesión (si la API de Claude Code los expone en PostToolUse)
        if (usage && typeof usage === "object") {
            session.tokens_input = (session.tokens_input || 0) + (Number(usage.input_tokens) || 0);
            session.tokens_output = (session.tokens_output || 0) + (Number(usage.output_tokens) || 0);
        }

        fs.writeFileSync(sessionFile, JSON.stringify(session, null, 2) + "\n", "utf8");
    } catch(e) { /* no bloquear hook por error de sesion */ }
}
