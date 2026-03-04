// commander-launcher.js — Hook PostToolUse que autoarranca telegram-commander.js
// Se ejecuta en cada tool use. Si el Commander no está corriendo, lo lanza en background.
// Diseñado para ser ultra-rápido: solo chequea lockfile + PID y sale.
// Protección contra race conditions: usa un launching flag file para evitar lanzamientos concurrentes.

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const HOOKS_DIR = __dirname;
const LOCK_FILE = path.join(HOOKS_DIR, "telegram-commander.lock");
const LAUNCHING_FILE = path.join(HOOKS_DIR, "telegram-commander.launching");
const CONFLICT_COOLDOWN_FILE = path.join(HOOKS_DIR, "telegram-commander.conflict");
const COMMANDER_SCRIPT = path.join(HOOKS_DIR, "telegram-commander.js");
const LOG_FILE = path.join(HOOKS_DIR, "hook-debug.log");

// P-15: Ops learnings
let opsLearnings;
try { opsLearnings = require("./ops-learnings"); } catch (e) { opsLearnings = null; }

const LAUNCHING_STALE_MS = 30000; // 30s — si el flag de launching tiene más de esto, es stale
const CONFLICT_COOLDOWN_MS = 45000; // 45s — esperar después de un 409 (> POLL_TIMEOUT_SEC=30s)
const LAUNCHER_COOLDOWN_MS = 60000; // 60s — skip verificación si última check fue OK hace <60s
const LAUNCHER_COOLDOWN_FILE = path.join(HOOKS_DIR, "launcher-last-check.json");

function log(msg) {
    const line = "[" + new Date().toISOString() + "] Launcher: " + msg;
    try { fs.appendFileSync(LOG_FILE, line + "\n"); } catch (e) {}
}

function isProcessAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    } catch (e) {
        return false;
    }
}

function checkLockfile() {
    if (!fs.existsSync(LOCK_FILE)) {
        return { running: false, reason: "no lockfile" };
    }

    let data;
    try {
        data = JSON.parse(fs.readFileSync(LOCK_FILE, "utf8"));
    } catch (e) {
        // Lockfile corrupto — limpiarlo
        try { fs.unlinkSync(LOCK_FILE); } catch (e2) {}
        return { running: false, reason: "lockfile corrupto, limpiado" };
    }

    const pid = data.pid;
    if (!pid || typeof pid !== "number") {
        try { fs.unlinkSync(LOCK_FILE); } catch (e2) {}
        return { running: false, reason: "lockfile sin PID válido, limpiado" };
    }

    if (isProcessAlive(pid)) {
        return { running: true, pid: pid };
    }

    // PID muerto — lockfile stale, limpiarlo
    try { fs.unlinkSync(LOCK_FILE); } catch (e2) {}
    return { running: false, reason: "PID " + pid + " muerto, lockfile stale limpiado" };
}

/**
 * Verifica si otro launcher ya está en proceso de arrancar el commander.
 * Usa fs.openSync con flag 'wx' (exclusive create) para mutex atómico en filesystem.
 * Retorna true si es seguro lanzar, false si otro launcher ya está en eso.
 */
function acquireLaunchingFlag() {
    // Verificar si ya existe el flag (stale check)
    if (fs.existsSync(LAUNCHING_FILE)) {
        try {
            const data = JSON.parse(fs.readFileSync(LAUNCHING_FILE, "utf8"));
            const age = Date.now() - (data.ts || 0);
            if (age < LAUNCHING_STALE_MS) {
                // Flag reciente — otro launcher ya está arrancando
                return false;
            }
            // Flag stale — limpiarlo y continuar
            log("Launching flag stale (" + Math.round(age / 1000) + "s). Reemplazando.");
            try { fs.unlinkSync(LAUNCHING_FILE); } catch (e2) {}
        } catch (e) {
            // Flag corrupto — limpiar y continuar
            try { fs.unlinkSync(LAUNCHING_FILE); } catch (e2) {}
        }
    }

    // Atomic exclusive create — falla si otro proceso creó el archivo primero
    try {
        const fd = fs.openSync(LAUNCHING_FILE, "wx");
        fs.writeSync(fd, JSON.stringify({ ts: Date.now(), pid: process.pid }));
        fs.closeSync(fd);
    } catch (e) {
        // EEXIST = otro proceso ganó la carrera — no lanzar
        if (e.code === "EEXIST") return false;
        // Otro error inesperado — no lanzar por seguridad
        log("acquireLaunchingFlag error: " + e.message);
        return false;
    }

    return true;
}

function releaseLaunchingFlag() {
    try { fs.unlinkSync(LAUNCHING_FILE); } catch (e) {}
}

function launchCommander() {
    // Lanzar detached para que sobreviva al proceso padre (el hook)
    const proc = spawn("node", [COMMANDER_SCRIPT], {
        cwd: path.resolve(HOOKS_DIR, "..", ".."),
        detached: true,
        stdio: "ignore",
        shell: false,
        windowsHide: true
    });

    // Desvincular del proceso padre para que no bloquee
    proc.unref();

    log("Commander lanzado (PID " + proc.pid + ")");

    // Liberar flag después de un delay para dar tiempo al commander de crear su lockfile
    setTimeout(() => releaseLaunchingFlag(), 5000);

    return proc.pid;
}

// ─── Main ────────────────────────────────────────────────────────────────────

function isConflictCooldownActive() {
    if (!fs.existsSync(CONFLICT_COOLDOWN_FILE)) return false;
    try {
        const data = JSON.parse(fs.readFileSync(CONFLICT_COOLDOWN_FILE, "utf8"));
        const age = Date.now() - (data.ts || 0);
        if (age < CONFLICT_COOLDOWN_MS) {
            return true; // Cooldown activo — no relanzar aún
        }
        // Cooldown expirado — limpiar y continuar
        try { fs.unlinkSync(CONFLICT_COOLDOWN_FILE); } catch (e2) {}
    } catch (e) {
        // Archivo corrupto — limpiar
        try { fs.unlinkSync(CONFLICT_COOLDOWN_FILE); } catch (e2) {}
    }
    return false;
}

function isLauncherCooldownActive() {
    try {
        if (!fs.existsSync(LAUNCHER_COOLDOWN_FILE)) return false;
        const data = JSON.parse(fs.readFileSync(LAUNCHER_COOLDOWN_FILE, "utf8"));
        return (Date.now() - (data.ts || 0)) < LAUNCHER_COOLDOWN_MS;
    } catch (e) { return false; }
}

function updateLauncherCooldown() {
    try { fs.writeFileSync(LAUNCHER_COOLDOWN_FILE, JSON.stringify({ ts: Date.now() }), "utf8"); } catch (e) {}
}

function main() {
    // P-06: Skip si última verificación exitosa fue hace <60s
    if (isLauncherCooldownActive()) return;

    const status = checkLockfile();

    if (status.running) {
        // Commander ya corriendo — actualizar cooldown y salir
        updateLauncherCooldown();
        return;
    }

    // Verificar cooldown por 409 — el commander anterior murió por conflicto,
    // esperar a que Telegram libere la conexión vieja (POLL_TIMEOUT_SEC + margen)
    if (isConflictCooldownActive()) {
        // NO logear — esto se ejecuta en cada tool use y llenaría el log
        return;
    }

    // Verificar que no haya otro launcher arrancando concurrentemente
    if (!acquireLaunchingFlag()) {
        log("Otro launcher ya está arrancando el Commander. Ignorando.");
        return;
    }

    // Re-verificar lockfile después de adquirir el flag (podría haber aparecido)
    const recheck = checkLockfile();
    if (recheck.running) {
        releaseLaunchingFlag();
        return;
    }

    // No está corriendo — lanzarlo
    log("Commander no activo (" + status.reason + "). Lanzando...");

    // P-15: Registrar relanzamiento en ops-learnings
    if (opsLearnings) {
        try {
            opsLearnings.recordLearning({
                source: "commander-launcher",
                category: "relaunch",
                severity: "low",
                symptom: "Commander relanzado: " + status.reason,
                root_cause: status.reason,
                affected: ["commander-launcher.js", "telegram-commander.js"],
                auto_detected: true
            });
        } catch (e) {}
    }

    launchCommander();
}

main();
