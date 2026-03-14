// post-tool-orchestrator.js — Orquestador PostToolUse (#1506)
// Fusiona: ensure-permissions + permission-tracker + agent-progress + session-gc
// Reduce 7 hooks PostToolUse[*] a 4 (-40% latencia de hooks).
// Lee stdin UNA SOLA VEZ y distribuye a cada subsistema.
// Pure Node.js — sin dependencias externas salvo permission-utils.js.

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

// ============ CONFIGURACIÓN COMÚN ============================================

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || "C:\\Workspaces\\Intrale\\platform";

function resolveMainRepoRoot(candidate) {
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

const REPO_ROOT = resolveMainRepoRoot(PROJECT_DIR);
const CLAUDE_DIR = path.join(REPO_ROOT, ".claude");
const HOOKS_DIR = path.join(CLAUDE_DIR, "hooks");

// ============ LEER STDIN (UNA SOLA VEZ) =====================================

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

// ============ MAIN ===========================================================

function handleInput() {
    let data = {};
    try { data = JSON.parse(input || "{}"); } catch (e) {}

    const toolName = data.tool_name || "";

    // Ejecutar todos los subsistemas (fail-open: un fallo no bloquea los demás)
    runEnsurePermissions();
    runPermissionTracker(data, toolName);
    runAgentProgress(data, toolName);
    runSessionGC();
}

// ============ 1: ENSURE PERMISSIONS ==========================================
// Lógica de ensure-permissions.js: auto-healing de permisos baseline.
// Fast path: stat() de flag file — si es reciente (<1h), exit inmediato.

function runEnsurePermissions() {
    try {
        const BASELINE_FILE = path.join(CLAUDE_DIR, "permissions-baseline.json");
        const SETTINGS_FILE = path.join(CLAUDE_DIR, "settings.local.json");
        const FLAG_FILE = path.join(CLAUDE_DIR, "tmp", "permissions-last-check");
        const MAX_AGE_MS = 60 * 60 * 1000; // 1 hora

        // Fast path: flag reciente — evitar I/O innecesario
        if (fs.existsSync(FLAG_FILE)) {
            const age = Date.now() - fs.statSync(FLAG_FILE).mtimeMs;
            if (age < MAX_AGE_MS) return;
        }

        // Slow path: validar y reparar permisos
        if (!fs.existsSync(BASELINE_FILE)) return;

        const baseline = JSON.parse(fs.readFileSync(BASELINE_FILE, "utf8"));
        const baseAllow = baseline.allow || [];
        const baseDeny = baseline.deny || [];

        let settings = { permissions: { allow: [], deny: [] } };
        if (fs.existsSync(SETTINGS_FILE)) {
            try { settings = JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8")); } catch (e) {}
        }

        if (!settings.permissions) settings.permissions = {};
        if (!Array.isArray(settings.permissions.allow)) settings.permissions.allow = [];
        if (!Array.isArray(settings.permissions.deny)) settings.permissions.deny = [];

        let modified = false;
        for (const rule of baseAllow) {
            if (!settings.permissions.allow.includes(rule)) {
                settings.permissions.allow.push(rule);
                modified = true;
            }
        }
        for (const rule of baseDeny) {
            if (!settings.permissions.deny.includes(rule)) {
                settings.permissions.deny.push(rule);
                modified = true;
            }
        }

        if (modified) {
            fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2) + "\n", "utf8");
        }

        // Actualizar flag
        const flagDir = path.dirname(FLAG_FILE);
        if (!fs.existsSync(flagDir)) fs.mkdirSync(flagDir, { recursive: true });
        fs.writeFileSync(FLAG_FILE, new Date().toISOString(), "utf8");

    } catch (e) { /* fail-open */ }
}

// ============ 2: PERMISSION TRACKER ==========================================
// Lógica de permission-tracker.js: detecta tools aprobados y los persiste.
// Solo trackea Bash, WebFetch y Skill.

function runPermissionTracker(data, toolName) {
    try {
        if (!["Bash", "WebFetch", "Skill"].includes(toolName)) return;

        const { generatePattern, isAlreadyCovered, collidesWithDeny, getSettingsPaths } = require("./permission-utils");

        const pattern = generatePattern(toolName, data.tool_input || {});
        if (!pattern) return;

        const settingsPaths = getSettingsPaths(PROJECT_DIR);
        let written = false;

        for (const settingsPath of settingsPaths) {
            try {
                let settings;
                try { settings = JSON.parse(fs.readFileSync(settingsPath, "utf8")); } catch (e) { continue; }

                const allow = (settings.permissions && settings.permissions.allow) || [];
                const deny = (settings.permissions && settings.permissions.deny) || [];

                // Si tiene patrones amplios, no auto-aprender (race condition en multi-agente)
                const broadPatterns = allow.filter(p => /^(Read|Glob|Grep|Edit|Write)\(\*\)$/.test(p));
                if (broadPatterns.length >= 3) continue;

                if (isAlreadyCovered(pattern, allow)) continue;
                if (collidesWithDeny(pattern, deny)) continue;

                allow.push(pattern);
                settings.permissions = settings.permissions || {};
                settings.permissions.allow = allow;
                fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf8");
                written = true;
            } catch (e) { /* ignorar errores individuales */ }
        }

        if (!written) return;

        // Log extendido (contexto de rama + approved_by)
        const LOG_PATH = path.join(CLAUDE_DIR, "permissions-log.jsonl");
        const ts = new Date().toISOString().replace(/\.\d+Z$/, "Z");
        const sessionId = data.session_id || "";

        let context = "";
        try { context = execSync("git branch --show-current 2>/dev/null", { cwd: REPO_ROOT, encoding: "utf8", timeout: 2000 }).trim(); } catch (e) {}

        const logEntry = JSON.stringify({ ts, action: "added", tool: toolName, pattern, session: sessionId, context, approved_by: "auto" });
        const logDir = path.dirname(LOG_PATH);
        if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
        fs.appendFileSync(LOG_PATH, logEntry + "\n", "utf8");

        // Rotación: mantener 500 líneas
        try {
            const lines = fs.readFileSync(LOG_PATH, "utf8").trim().split("\n");
            if (lines.length > 600) fs.writeFileSync(LOG_PATH, lines.slice(-500).join("\n") + "\n", "utf8");
        } catch (e) {}
    } catch (e) { /* fail-open */ }
}

// ============ 3: AGENT PROGRESS ==============================================
// Lógica de agent-progress.js: progreso visual en terminal del agente.
// Throttle: máximo 1 impresión cada 30s para no spamear.

const TRIGGER_TOOLS = new Set(["TaskCreate", "TaskUpdate", "Skill", "Edit", "Write", "Bash"]);
const THROTTLE_MS = 30000;
const PROGRESS_STATE_FILE = path.join(HOOKS_DIR, "agent-progress-state.json");

function runAgentProgress(data, toolName) {
    try {
        if (!TRIGGER_TOOLS.has(toolName)) return;

        // Para Bash, solo en hitos significativos (git, gradle, gh)
        if (toolName === "Bash") {
            const cmd = (data.tool_input || {}).command || "";
            const isSignificant = /\b(git\s+(push|commit|merge|checkout)|gradlew|gh\s+(pr|issue))\b/.test(cmd);
            if (!isSignificant) return;
        }

        // Throttle: verificar tiempo desde última impresión
        const now = Date.now();
        const sessionId = (data.session_id || "").substring(0, 8);
        let state = {};
        try {
            if (fs.existsSync(PROGRESS_STATE_FILE)) state = JSON.parse(fs.readFileSync(PROGRESS_STATE_FILE, "utf8"));
        } catch (e) {}

        if (now - (state[sessionId] || 0) < THROTTLE_MS) return;

        // Cargar sesión y mostrar bloque de progreso
        const SESSIONS_DIR = path.join(CLAUDE_DIR, "sessions");
        const sessionData = loadSession(SESSIONS_DIR, sessionId);
        if (!sessionData) return;

        const agentInfo = identifyAgent(sessionData);
        const block = buildProgressBlock(sessionData, agentInfo);
        if (!block) return;

        process.stderr.write(block);

        state[sessionId] = now;
        try { fs.writeFileSync(PROGRESS_STATE_FILE, JSON.stringify(state), "utf8"); } catch (e) {}
    } catch (e) { /* fail-open */ }
}

function loadSession(sessionsDir, sessionId) {
    if (!sessionId) return null;
    const sessionFile = path.join(sessionsDir, sessionId + ".json");
    try {
        if (!fs.existsSync(sessionFile)) return null;
        return JSON.parse(fs.readFileSync(sessionFile, "utf8"));
    } catch (e) { return null; }
}

function identifyAgent(session) {
    const info = { numero: "?", issue: "?", slug: "" };
    try {
        const planFile = path.join(REPO_ROOT, "scripts", "sprint-plan.json");
        if (!fs.existsSync(planFile)) return info;
        const plan = JSON.parse(fs.readFileSync(planFile, "utf8"));
        if (!plan.agentes || !Array.isArray(plan.agentes)) return info;

        const branch = session.branch || "";
        const branchMatch = branch.match(/^agent\/(\d+)-(.+)$/);
        if (!branchMatch) return info;

        const issueNum = parseInt(branchMatch[1], 10);
        info.issue = String(issueNum);
        info.slug = branchMatch[2];

        const agente = plan.agentes.find(a => a.issue === issueNum);
        if (agente) { info.numero = String(agente.numero); info.slug = agente.slug; }
    } catch (e) {}
    return info;
}

function buildProgressBlock(session, agentInfo) {
    const tasks = session.current_tasks || [];
    const elapsed = getElapsed(session.started_ts);
    const headerLine = " Agente " + agentInfo.numero + " \u00B7 #" + agentInfo.issue + " \u00B7 " + agentInfo.slug;
    const sep = "\u2500".repeat(45);
    const lines = ["\n" + sep, headerLine];

    if (tasks.length === 0) {
        const currentTask = session.current_task;
        if (currentTask) {
            lines.push(" \u25B6 " + currentTask);
        } else {
            lines.push(" " + (session.action_count || 0) + " acciones \u00B7 ultimo: " + (session.last_tool || "?") + " \u00B7 " + elapsed);
        }
    } else {
        let completedCount = 0;
        for (const task of tasks) {
            const status = task.status || "pending";
            let icon;
            if (status === "completed") { icon = " \u2611"; completedCount++; }
            else if (status === "in_progress") { icon = " \u2610\u25BA"; }
            else { icon = " \u2610"; }

            let taskLine = icon + " " + task.subject;
            if (Array.isArray(task.steps) && task.steps.length > 0 && status === "in_progress") {
                const completedSteps = Array.isArray(task.completed_steps) ? task.completed_steps : [];
                const pct = task.progress || 0;
                taskLine += " (" + completedSteps.length + "/" + task.steps.length + " \u00B7 " + pct + "%)";
            }
            lines.push(taskLine);
        }

        const pct = tasks.length > 0 ? Math.round((completedCount / tasks.length) * 100) : 0;
        const barWidth = 20;
        const filled = Math.round(barWidth * pct / 100);
        const bar = "\u2588".repeat(filled) + "\u2591".repeat(barWidth - filled);
        lines.push(" \u2500\u2500 " + bar + " " + completedCount + "/" + tasks.length + " \u00B7 " + pct + "% \u00B7 " + elapsed + " \u2500\u2500");
    }

    lines.push(sep + "\n");
    return lines.join("\n");
}

function getElapsed(startedTs) {
    if (!startedTs) return "?m";
    try {
        const diffMin = Math.round((Date.now() - new Date(startedTs).getTime()) / 60000);
        if (diffMin < 60) return diffMin + "m";
        const h = Math.floor(diffMin / 60);
        const m = diffMin % 60;
        return h + "h" + (m > 0 ? m + "m" : "");
    } catch (e) { return "?m"; }
}

// ============ 4: SESSION GC ==================================================
// Lógica de session-gc.js: limpia sesiones obsoletas de .claude/sessions/.
// Throttle: solo corre cada GC_RUN_EVERY_N invocaciones de PostToolUse.

const GC_STATE_FILE = path.join(HOOKS_DIR, "session-gc-state.json");
const GC_LOG_FILE = path.join(HOOKS_DIR, "hook-debug.log");
const GC_RUN_EVERY_N = 20;
const DONE_MAX_AGE_MS = 1 * 60 * 60 * 1000;   // done  > 1h  → eliminar
const STALE_MAX_AGE_MS = 4 * 60 * 60 * 1000;  // stale > 4h  → eliminar
const ACTIVE_MAX_AGE_MS = 24 * 60 * 60 * 1000; // active > 24h → eliminar

function gcLog(msg) {
    try { fs.appendFileSync(GC_LOG_FILE, "[" + new Date().toISOString() + "] session-gc: " + msg + "\n"); } catch (e) {}
}

function runSessionGC() {
    try {
        // Throttle: solo cada N invocaciones
        let state = { count: 0 };
        try {
            if (fs.existsSync(GC_STATE_FILE)) state = JSON.parse(fs.readFileSync(GC_STATE_FILE, "utf8"));
        } catch (e) {}

        state.count = (state.count || 0) + 1;
        fs.writeFileSync(GC_STATE_FILE, JSON.stringify(state), "utf8");

        if ((state.count % GC_RUN_EVERY_N) !== 0) return;

        // Ejecutar GC
        const SESSIONS_DIR = path.join(CLAUDE_DIR, "sessions");
        if (!fs.existsSync(SESSIONS_DIR)) return;

        const now = Date.now();
        let deleted = 0, errors = 0;
        const files = fs.readdirSync(SESSIONS_DIR).filter(f => f.endsWith(".json"));

        for (const file of files) {
            const filePath = path.join(SESSIONS_DIR, file);
            try {
                const session = JSON.parse(fs.readFileSync(filePath, "utf8"));
                const status = session.status || "active";
                const refTs = session.completed_at || session.last_activity_ts || session.started_ts;
                if (!refTs) continue;
                const age = now - new Date(refTs).getTime();

                let shouldDelete = false;
                let reason = "";

                if (status === "done" && age > DONE_MAX_AGE_MS) {
                    shouldDelete = true; reason = "done>" + Math.floor(age / 3600000) + "h";
                } else if (status === "stale" && age > STALE_MAX_AGE_MS) {
                    shouldDelete = true; reason = "stale>" + Math.floor(age / 3600000) + "h";
                } else if (status === "active" && age > ACTIVE_MAX_AGE_MS) {
                    shouldDelete = true; reason = "active>" + Math.floor(age / 3600000) + "h (abandonada)";
                }

                if (shouldDelete) {
                    fs.unlinkSync(filePath);
                    deleted++;
                    gcLog("Eliminada " + file + " [" + reason + "]");
                }
            } catch (e) {
                errors++;
                try { fs.unlinkSync(filePath); deleted++; gcLog("Eliminada " + file + " [JSON inválido]"); } catch (e2) {}
            }
        }

        if (deleted > 0 || errors > 0) {
            gcLog("GC completado: " + deleted + " eliminadas, " + errors + " errores. Total=" + files.length);
        }
    } catch (e) { /* fail-open */ }
}
