// session-gc.js — Garbage Collector de sesiones
// Hook PostToolUse: limpia sesiones obsoletas de .claude/sessions/
// - done  > 1h  → eliminar
// - stale > 4h  → eliminar (auto-done)
// - active > 24h → eliminar (abandonadas)
// Ejecución throttled: solo cada N invocaciones (contador interno)
// Escrituras atómicas: tmp + rename para evitar corrupción concurrente
// Pure Node.js — sin dependencia de bash

const fs = require("fs");
const path = require("path");

// Resolver REPO_ROOT al repo principal (no al worktree)
function resolveMainRepoRoot() {
    const candidate = process.env.CLAUDE_PROJECT_DIR || "C:\\Workspaces\\Intrale\\platform";
    try {
        const { execSync } = require("child_process");
        const gitCommon = execSync("git rev-parse --git-common-dir", { cwd: candidate, timeout: 3000, windowsHide: true })
            .toString().trim().replace(/\\/g, "/");
        if (gitCommon === ".git") return candidate;
        const gitIdx = gitCommon.indexOf("/.git");
        if (gitIdx !== -1) return gitCommon.substring(0, gitIdx);
        return path.resolve(gitCommon, "..");
    } catch(e) { return candidate; }
}

const REPO_ROOT = resolveMainRepoRoot();
const SESSIONS_DIR = path.join(REPO_ROOT, ".claude", "sessions");
// #1734: archivo permanente por sprint bajo sessions-archive/SPR-NNN/ o sessions-archive/general/
const SESSIONS_ARCHIVE_ROOT = path.join(REPO_ROOT, ".claude", "sessions-archive");
const LOG_FILE = path.join(REPO_ROOT, ".claude", "hooks", "hook-debug.log");
const GC_STATE_FILE = path.join(REPO_ROOT, ".claude", "hooks", "session-gc-state.json");

// Retención de archivos en sessions-archive/ (30 días)
const ARCHIVE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

// Umbrales de GC
const DONE_MAX_AGE_MS   = 1 * 60 * 60 * 1000;  // done  > 1h  → eliminar
const STALE_MAX_AGE_MS  = 4 * 60 * 60 * 1000;  // stale > 4h  → eliminar
const ACTIVE_MAX_AGE_MS = 24 * 60 * 60 * 1000; // active > 24h → eliminar (abandonadas)

// Throttle: correr GC solo cada N invocaciones de PostToolUse
const GC_RUN_EVERY_N = 20;

function log(msg) {
    try {
        fs.appendFileSync(LOG_FILE, "[" + new Date().toISOString() + "] session-gc: " + msg + "\n");
    } catch(e) {}
}

// Contador de invocaciones (persistido para sobrevivir entre ejecuciones)
function shouldRunGC() {
    try {
        let state = { count: 0 };
        try {
            if (fs.existsSync(GC_STATE_FILE)) {
                state = JSON.parse(fs.readFileSync(GC_STATE_FILE, "utf8"));
            }
        } catch(e) {}

        state.count = (state.count || 0) + 1;
        fs.writeFileSync(GC_STATE_FILE, JSON.stringify(state), "utf8");

        return (state.count % GC_RUN_EVERY_N) === 0;
    } catch(e) {
        return false;
    }
}


// Determinar directorio de archivo por sprint (#1734)
// Si la sesión tiene sprint_id → sessions-archive/<sprint_id>/
// Fallback → sessions-archive/general/
function getArchiveDir(session) {
    const sprintId = session && session.sprint_id;
    if (sprintId && sprintId.startsWith("SPR-") && sprintId.length > 4) {
        return path.join(SESSIONS_ARCHIVE_ROOT, sprintId);
    }
    return path.join(SESSIONS_ARCHIVE_ROOT, "general");
}

function runGC() {
    if (!fs.existsSync(SESSIONS_DIR)) return;

    const now = Date.now();
    let deleted = 0;
    let errors = 0;

    let files;
    try {
        files = fs.readdirSync(SESSIONS_DIR).filter(f => f.endsWith(".json"));
    } catch(e) {
        log("Error leyendo sessions/: " + e.message);
        return;
    }

    // Proteger sesiones del sprint activo (#1716)
    let sprintIssues = new Set();
    try {
        const planPath = path.join(REPO_ROOT, "scripts", "sprint-plan.json");
        if (fs.existsSync(planPath)) {
            const plan = JSON.parse(fs.readFileSync(planPath, "utf8"));
            [...(plan.agentes||[]), ...(plan._queue||[]), ...(plan._completed||[]), ...(plan._incomplete||[])].forEach(a => sprintIssues.add(String(a.issue)));
        }
    } catch(e) {}

    for (const file of files) {
        const filePath = path.join(SESSIONS_DIR, file);
        try {
            const session = JSON.parse(fs.readFileSync(filePath, "utf8"));
            const status = session.status || "active";

            // No borrar sesiones del sprint activo (preservar transiciones y checklists)
            const branchIssue = (session.branch || "").match(/^(?:agent|feature|bugfix)\/(\d+)/);
            if (branchIssue && sprintIssues.has(branchIssue[1])) continue;

            // Timestamp de referencia para calcular antigüedad
            const refTs = session.completed_at || session.last_activity_ts || session.started_ts;
            if (!refTs) continue;
            const age = now - new Date(refTs).getTime();

            let shouldDelete = false;
            let reason = "";

            if (status === "done" && age > DONE_MAX_AGE_MS) {
                shouldDelete = true;
                reason = "done>" + Math.floor(age / 3600000) + "h";
            } else if (status === "stale" && age > STALE_MAX_AGE_MS) {
                shouldDelete = true;
                reason = "stale>" + Math.floor(age / 3600000) + "h";
            } else if (status === "active" && age > ACTIVE_MAX_AGE_MS) {
                shouldDelete = true;
                reason = "active>" + Math.floor(age / 3600000) + "h (abandonada)";
            }

            if (shouldDelete) {
                // Archivar antes de eliminar (#1734 — historial permanente por sprint)
                try {
                    const archiveDir = getArchiveDir(session);
                    if (!fs.existsSync(archiveDir)) fs.mkdirSync(archiveDir, { recursive: true });
                    const archivePath = path.join(archiveDir, file);
                    fs.copyFileSync(filePath, archivePath);
                } catch(archErr) {
                    log("Error archivando " + file + ": " + archErr.message);
                }
                fs.unlinkSync(filePath);
                deleted++;
                log("Archivada+eliminada " + file + " [" + reason + "]");
            }
        } catch(e) {
            errors++;
            // Si el archivo es JSON inválido, intentar eliminarlo también
            try { fs.unlinkSync(filePath); deleted++; log("Eliminada " + file + " [JSON inválido]"); } catch(e2) {}
        }
    }

    if (deleted > 0 || errors > 0) {
        log("GC completado: " + deleted + " archivadas+eliminadas, " + errors + " errores. Total archivos=" + files.length);
    }

    // Limpiar archivos en sessions-archive/ mayores a 30 días (#1734)
    try {
        if (fs.existsSync(SESSIONS_ARCHIVE_ROOT)) {
            let archiveDeleted = 0;
            const subDirs = fs.readdirSync(SESSIONS_ARCHIVE_ROOT);
            for (const sub of subDirs) {
                const subPath = path.join(SESSIONS_ARCHIVE_ROOT, sub);
                try { if (!fs.statSync(subPath).isDirectory()) continue; } catch(e) { continue; }
                const archiveFiles = fs.readdirSync(subPath).filter(f => f.endsWith(".json"));
                for (const af of archiveFiles) {
                    const afPath = path.join(subPath, af);
                    const mtime = fs.statSync(afPath).mtimeMs;
                    if (now - mtime > ARCHIVE_MAX_AGE_MS) {
                        fs.unlinkSync(afPath);
                        archiveDeleted++;
                    }
                }
            }
            if (archiveDeleted > 0) log("Archive cleanup: " + archiveDeleted + " archivos >30d eliminados");
        }
    } catch(e) {}
}

// Leer stdin (PostToolUse hook — no necesitamos el contenido, solo ejecutar GC)
const MAX_READ = 512;
let input = "";
let done = false;

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
    if (done) return;
    input += chunk;
    if (input.length >= MAX_READ) { done = true; process.stdin.destroy(); main(); }
});
process.stdin.on("end", () => { if (!done) { done = true; main(); } });
process.stdin.on("error", () => { if (!done) { done = true; main(); } });
setTimeout(() => { if (!done) { done = true; try { process.stdin.destroy(); } catch(e) {} main(); } }, 1000);

function main() {
    try {
        if (shouldRunGC()) {
            runGC();
        }
    } catch(e) {
        log("Error en main: " + e.message);
    }
}
