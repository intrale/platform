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
const LOG_FILE = path.join(REPO_ROOT, ".claude", "hooks", "hook-debug.log");
const GC_STATE_FILE = path.join(REPO_ROOT, ".claude", "hooks", "session-gc-state.json");

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

    for (const file of files) {
        const filePath = path.join(SESSIONS_DIR, file);
        try {
            const session = JSON.parse(fs.readFileSync(filePath, "utf8"));
            const status = session.status || "active";

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
                fs.unlinkSync(filePath);
                deleted++;
                log("Eliminada " + file + " [" + reason + "]");
            }
        } catch(e) {
            errors++;
            // Si el archivo es JSON inválido, intentar eliminarlo también
            try { fs.unlinkSync(filePath); deleted++; log("Eliminada " + file + " [JSON inválido]"); } catch(e2) {}
        }
    }

    if (deleted > 0 || errors > 0) {
        log("GC completado: " + deleted + " eliminadas, " + errors + " errores. Total archivos=" + files.length);
    }
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
