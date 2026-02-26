// commander-launcher.js — Hook PostToolUse que autoarranca telegram-commander.js
// Se ejecuta en cada tool use. Si el Commander no está corriendo, lo lanza en background.
// Diseñado para ser ultra-rápido: solo chequea lockfile + PID y sale.

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const HOOKS_DIR = __dirname;
const LOCK_FILE = path.join(HOOKS_DIR, "telegram-commander.lock");
const COMMANDER_SCRIPT = path.join(HOOKS_DIR, "telegram-commander.js");
const LOG_FILE = path.join(HOOKS_DIR, "hook-debug.log");

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
    return proc.pid;
}

// ─── Main ────────────────────────────────────────────────────────────────────

function main() {
    const status = checkLockfile();

    if (status.running) {
        // Commander ya corriendo — nada que hacer
        return;
    }

    // No está corriendo — lanzarlo
    log("Commander no activo (" + status.reason + "). Lanzando...");
    launchCommander();
}

main();
