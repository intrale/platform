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
const COMMANDER_SCRIPT = path.join(HOOKS_DIR, "telegram-commander.js");
const LOG_FILE = path.join(HOOKS_DIR, "hook-debug.log");

const LAUNCHING_STALE_MS = 30000; // 30s — si el flag de launching tiene más de esto, es stale

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
 * Usa un archivo flag con timestamp para detectar concurrencia.
 * Retorna true si es seguro lanzar, false si otro launcher ya está en eso.
 */
function acquireLaunchingFlag() {
    // Verificar si ya existe el flag
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
        } catch (e) {
            // Flag corrupto — continuar
        }
    }

    // Escribir nuestro flag atómicamente (wx = exclusive create falla si existe)
    // Como no podemos garantizar atomicidad con writeFileSync, usamos timestamp
    try {
        fs.writeFileSync(LAUNCHING_FILE, JSON.stringify({ ts: Date.now(), pid: process.pid }), "utf8");
    } catch (e) {
        return false;
    }

    // Re-leer para verificar que somos nosotros (poor man's lock)
    try {
        const data = JSON.parse(fs.readFileSync(LAUNCHING_FILE, "utf8"));
        if (data.pid !== process.pid) {
            return false; // Otro proceso ganó
        }
    } catch (e) {
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

function main() {
    const status = checkLockfile();

    if (status.running) {
        // Commander ya corriendo — nada que hacer
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
    launchCommander();
}

main();
