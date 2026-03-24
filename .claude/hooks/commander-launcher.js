// commander-launcher.js — Hook PostToolUse que autoarranca telegram-commander.js y agent-watcher.js
// Se ejecuta en cada tool use. Si el Commander o Watcher no están corriendo, los lanza en background.
// Diseñado para ser ultra-rápido: solo chequea lockfile/pidfile + PID y sale.
// Protección contra race conditions: usa un launching flag file para evitar lanzamientos concurrentes.
// Detecta merges en main y reinicia procesos para cargar código actualizado.

const fs = require("fs");
const path = require("path");
const { spawn, execSync } = require("child_process");

const HOOKS_DIR = __dirname;
const LOCK_FILE = path.join(HOOKS_DIR, "telegram-commander.lock");
const LAUNCHING_FILE = path.join(HOOKS_DIR, "telegram-commander.launching");
const CONFLICT_COOLDOWN_FILE = path.join(HOOKS_DIR, "telegram-commander.conflict");
const COMMANDER_SCRIPT = path.join(HOOKS_DIR, "telegram-commander.js");
const WATCHER_SCRIPT = path.join(HOOKS_DIR, "agent-watcher.js");
const WATCHER_PID_FILE = path.join(HOOKS_DIR, "agent-watcher.pid");
const LAST_HEAD_FILE = path.join(HOOKS_DIR, "launcher-last-head.json");
const LOG_FILE = path.join(HOOKS_DIR, "hook-debug.log");
const REPO_ROOT = path.resolve(HOOKS_DIR, "..", "..");
const PLAN_FILE = path.join(REPO_ROOT, "scripts", "sprint-plan.json");

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

// ─── Watcher auto-relaunch ────────────────────────────────────────────────────

/**
 * Verifica si el agent-watcher está vivo leyendo su PID file.
 * Retorna { running: boolean, pid?: number, reason?: string }
 */
function checkWatcherPid() {
    if (!fs.existsSync(WATCHER_PID_FILE)) {
        return { running: false, reason: "no pid file" };
    }

    let pid;
    try {
        const content = fs.readFileSync(WATCHER_PID_FILE, "utf8").trim();
        pid = parseInt(content, 10);
    } catch (e) {
        return { running: false, reason: "pid file ilegible" };
    }

    if (!pid || isNaN(pid)) {
        return { running: false, reason: "pid file sin PID válido" };
    }

    if (isProcessAlive(pid)) {
        return { running: true, pid: pid };
    }

    // PID muerto — limpiar pid file stale
    try { fs.unlinkSync(WATCHER_PID_FILE); } catch (e) {}
    return { running: false, reason: "PID " + pid + " muerto, pid file stale limpiado" };
}

/**
 * Verifica si hay un sprint activo (agentes o cola con items).
 */
function isSprintActive() {
    try {
        if (!fs.existsSync(PLAN_FILE)) return false;
        const plan = JSON.parse(fs.readFileSync(PLAN_FILE, "utf8"));
        const agentes = Array.isArray(plan.agentes) ? plan.agentes : [];
        const queue = Array.isArray(plan._queue) ? plan._queue :
            (Array.isArray(plan.cola) ? plan.cola : []);
        return agentes.length > 0 || queue.length > 0;
    } catch (e) {
        return false;
    }
}

function launchWatcher() {
    const proc = spawn("node", [WATCHER_SCRIPT], {
        cwd: REPO_ROOT,
        detached: true,
        stdio: "ignore",
        shell: false,
        windowsHide: true
    });
    proc.unref();
    log("Watcher lanzado (PID " + proc.pid + ")");
    return proc.pid;
}

// ─── HEAD change detection (hot-reload de hooks) ─────────────────────────────

/**
 * Obtiene el HEAD actual del repo principal.
 */
function getCurrentHead() {
    try {
        return execSync("git rev-parse HEAD", {
            cwd: REPO_ROOT,
            encoding: "utf8",
            timeout: 5000,
            windowsHide: true
        }).trim();
    } catch (e) {
        return null;
    }
}

/**
 * Lee el último HEAD conocido desde launcher-last-head.json.
 */
function getLastKnownHead() {
    try {
        if (!fs.existsSync(LAST_HEAD_FILE)) return null;
        const data = JSON.parse(fs.readFileSync(LAST_HEAD_FILE, "utf8"));
        return data.head || null;
    } catch (e) { return null; }
}

/**
 * Guarda el HEAD actual en launcher-last-head.json.
 */
function saveCurrentHead(head) {
    try {
        fs.writeFileSync(LAST_HEAD_FILE, JSON.stringify({ head: head, ts: Date.now() }), "utf8");
    } catch (e) {}
}

/**
 * Mata un proceso por PID para forzar reinicio con código nuevo.
 * Usa SIGTERM para un shutdown limpio.
 */
function killProcess(pid, name) {
    try {
        process.kill(pid, "SIGTERM");
        log("Enviado SIGTERM a " + name + " (PID " + pid + ") por cambio de HEAD");
        return true;
    } catch (e) {
        // ESRCH = proceso ya no existe — OK
        if (e.code !== "ESRCH") {
            log("Error matando " + name + " (PID " + pid + "): " + e.message);
        }
        return false;
    }
}

/**
 * Detecta si HEAD cambió (merge en main) y reinicia commander + watcher
 * para que carguen código actualizado de hooks.
 * Retorna true si se reiniciaron procesos (el caller debe salir para que
 * el relanzamiento normal los levante con código fresco).
 */
function checkHeadChangeAndRestart() {
    const currentHead = getCurrentHead();
    if (!currentHead) return false;

    const lastHead = getLastKnownHead();
    saveCurrentHead(currentHead);

    // Primera ejecución o HEAD no cambió
    if (!lastHead || lastHead === currentHead) return false;

    log("HEAD cambió: " + lastHead.substring(0, 8) + " → " + currentHead.substring(0, 8) + " — reiniciando procesos");

    let restarted = false;

    // Matar commander si está corriendo
    const cmdStatus = checkLockfile();
    if (cmdStatus.running && cmdStatus.pid) {
        killProcess(cmdStatus.pid, "Commander");
        // Limpiar lockfile para que el relanzamiento normal lo detecte
        try { fs.unlinkSync(LOCK_FILE); } catch (e) {}
        restarted = true;
    }

    // S1-FIX: Proteger watcher durante hot-reload si hay agentes activos
    const sprintActive = isSprintActive();
    const wtStatus = checkWatcherPid();
    if (wtStatus.running && wtStatus.pid) {
        if (sprintActive) {
            log("Hot-reload PARCIAL: watcher preservado (sprint activo con agentes corriendo)");
        } else {
            killProcess(wtStatus.pid, "Watcher");
            restarted = true;
        }
    }

    if (restarted) {
        // P-15: Registrar hot-reload en ops-learnings
        const affected = ["commander-launcher.js", "telegram-commander.js"];
        if (!sprintActive) affected.push("agent-watcher.js");
        if (opsLearnings) {
            try {
                opsLearnings.recordLearning({
                    source: "commander-launcher",
                    category: "hot-reload",
                    severity: "low",
                    symptom: sprintActive
                        ? "HEAD cambió, reiniciando commander (watcher preservado — sprint activo)"
                        : "HEAD cambió, reiniciando commander/watcher para cargar hooks actualizados",
                    root_cause: "merge en main: " + lastHead.substring(0, 8) + " → " + currentHead.substring(0, 8),
                    affected: affected,
                    auto_detected: true
                });
            } catch (e) {}
        }
    }

    return restarted;
}

// ─── Main ────────────────────────────────────────────────────────────────────

function main() {
    // S2-FIX: Verificar watcher ANTES del cooldown — es critico que el supervisor
    // de agentes esté vivo siempre que haya sprint activo, independiente del estado del commander
    checkAndLaunchWatcher();

    // P-06: Skip si última verificación exitosa fue hace <60s
    if (isLauncherCooldownActive()) return;

    // Problema 3: Detectar merge en main y reiniciar procesos con código nuevo
    // Si se reiniciaron, no actualizar cooldown — dejar que la próxima ejecución
    // los relance naturalmente con el código fresco.
    const headChanged = checkHeadChangeAndRestart();

    const status = checkLockfile();

    if (status.running && !headChanged) {
        // Commander ya corriendo — watcher ya verificado arriba
        updateLauncherCooldown();
        return;
    }

    // Verificar cooldown por 409 — el commander anterior murió por conflicto,
    // esperar a que Telegram libere la conexión vieja (POLL_TIMEOUT_SEC + margen)
    if (isConflictCooldownActive()) {
        // NO logear — esto se ejecuta en cada tool use y llenaría el log
        // Watcher ya verificado al inicio de main()
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
        // Watcher ya verificado al inicio de main()
        updateLauncherCooldown();
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
    // Watcher ya verificado al inicio de main()
}

/**
 * Verifica si el watcher está vivo; si no, y hay sprint activo, lo relanza.
 */
function checkAndLaunchWatcher() {
    const wtStatus = checkWatcherPid();
    if (wtStatus.running) return;

    // Solo relanzar si hay sprint activo
    if (!isSprintActive()) return;

    log("Watcher no activo (" + wtStatus.reason + ") con sprint activo. Relanzando...");

    // P-15: Registrar relanzamiento del watcher
    if (opsLearnings) {
        try {
            opsLearnings.recordLearning({
                source: "commander-launcher",
                category: "relaunch",
                severity: "low",
                symptom: "Watcher relanzado: " + wtStatus.reason,
                root_cause: wtStatus.reason,
                affected: ["commander-launcher.js", "agent-watcher.js"],
                auto_detected: true
            });
        } catch (e) {}
    }

    launchWatcher();
}

main();
