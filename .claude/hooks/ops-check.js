// ops-check.js — Módulo de verificación de entorno operativo
// Exporta: checkEnvironment(), checkHooks(), checkResources(), runAll()
// Retorna objetos { ok: boolean, warnings: [], errors: [], items: [] }
// Fail-open: cualquier error interno no propaga al caller
// Uso CLI: node ops-check.js [--sprint|--env|--hooks|--resources|--fix]

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const HOOKS_DIR = __dirname;
const REPO_ROOT = process.env.CLAUDE_PROJECT_DIR || path.resolve(HOOKS_DIR, "..", "..");
const SETTINGS_FILE = path.join(REPO_ROOT, ".claude", "settings.json");
const CONFIG_FILE = path.join(HOOKS_DIR, "telegram-config.json");
const COMMANDER_LOCK = path.join(HOOKS_DIR, "telegram-commander.lock");

// ─── Utilidades ─────────────────────────────────────────────────────────────

function safeExec(cmd, opts) {
    try {
        return execSync(cmd, { encoding: "utf8", timeout: 10000, windowsHide: true, ...opts }).trim();
    } catch (e) {
        return null;
    }
}

function isProcessAlive(pid) {
    if (!pid) return false;
    try { process.kill(pid, 0); return true; } catch (e) { return false; }
}

function isPidAliveTasklist(pid) {
    if (!pid) return false;
    const out = safeExec('tasklist /FI "PID eq ' + pid + '" /NH');
    return out && out.indexOf("No tasks are running") === -1 && out.indexOf("INFO:") === -1;
}

function formatSize(bytes) {
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
    return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}

function countLines(filePath) {
    try {
        return fs.readFileSync(filePath, "utf8").split("\n").length;
    } catch (e) {
        return 0;
    }
}

// ─── Check: Entorno ─────────────────────────────────────────────────────────

function checkEnvironment() {
    const result = { ok: true, warnings: [], errors: [], items: [] };

    try {
        // JAVA_HOME
        const expectedJavaMsys = "/c/Users/Administrator/.jdks/temurin-21.0.7";
        const expectedJavaWin = "C:\\Users\\Administrator\\.jdks\\temurin-21.0.7";
        const javaHome = process.env.JAVA_HOME || "";
        const javaHomeNorm = javaHome.replace(/\\/g, "/").replace(/^([A-Z]):/i, (_, d) => "/" + d.toLowerCase());
        const javaBin = path.join(expectedJavaWin, "bin", "java.exe");

        if (javaHomeNorm === expectedJavaMsys) {
            const binExists = fs.existsSync(javaBin);
            if (binExists) {
                const ver = safeExec('"' + javaBin + '" -version 2>&1') || "";
                const verMatch = ver.match(/version "([^"]+)"/);
                result.items.push({ name: "JAVA_HOME", status: "ok", detail: "temurin-" + (verMatch ? verMatch[1] : "21") });
            } else {
                result.ok = false;
                result.errors.push("JAVA_HOME apunta a path correcto pero binario java no existe");
                result.items.push({ name: "JAVA_HOME", status: "error", detail: "binario no encontrado en " + expectedJavaWin });
            }
        } else if (javaHome) {
            result.warnings.push("JAVA_HOME apunta a " + javaHome + " (esperado: " + expectedJavaWin + ")");
            result.items.push({ name: "JAVA_HOME", status: "warn", detail: javaHome + " (incorrecto)" });
        } else {
            result.warnings.push("JAVA_HOME no definido");
            result.items.push({ name: "JAVA_HOME", status: "warn", detail: "no definido" });
        }

        // gh CLI
        const ghPath = "/c/Workspaces/gh-cli/bin/gh.exe";
        const ghPathWin = "C:\\Workspaces\\gh-cli\\bin\\gh.exe";
        if (fs.existsSync(ghPathWin)) {
            const ghVer = safeExec('"' + ghPathWin + '" --version 2>&1');
            const ghVerMatch = ghVer ? ghVer.match(/gh version ([\d.]+)/) : null;
            const ghAuth = safeExec('"' + ghPathWin + '" auth status 2>&1');
            const isAuthed = ghAuth && (ghAuth.indexOf("Logged in") !== -1 || ghAuth.indexOf("intrale") !== -1);
            if (isAuthed) {
                result.items.push({ name: "gh CLI", status: "ok", detail: "v" + (ghVerMatch ? ghVerMatch[1] : "?") + " · autenticado" });
            } else {
                result.warnings.push("gh CLI no autenticado");
                result.items.push({ name: "gh CLI", status: "warn", detail: "v" + (ghVerMatch ? ghVerMatch[1] : "?") + " · NO autenticado" });
            }
        } else {
            result.ok = false;
            result.errors.push("gh CLI no encontrado en " + ghPath);
            result.items.push({ name: "gh CLI", status: "error", detail: "no encontrado" });
        }

        // Node.js
        const nodeVer = safeExec("node --version 2>&1");
        if (nodeVer && nodeVer.startsWith("v")) {
            const major = parseInt(nodeVer.substring(1));
            if (major >= 18) {
                result.items.push({ name: "Node.js", status: "ok", detail: nodeVer });
            } else {
                result.warnings.push("Node.js " + nodeVer + " (se recomienda v18+)");
                result.items.push({ name: "Node.js", status: "warn", detail: nodeVer + " (< v18)" });
            }
        } else {
            result.ok = false;
            result.errors.push("Node.js no disponible");
            result.items.push({ name: "Node.js", status: "error", detail: "no encontrado" });
        }

        // git
        const gitVer = safeExec("git --version 2>&1");
        if (gitVer && gitVer.indexOf("git version") !== -1) {
            const gv = gitVer.replace("git version ", "").trim();
            // Verificar que es un repo válido
            const isRepo = safeExec("git -C \"" + REPO_ROOT.replace(/\\/g, "/") + "\" rev-parse --is-inside-work-tree 2>&1");
            if (isRepo === "true") {
                result.items.push({ name: "git", status: "ok", detail: gv + " · repo válido" });
            } else {
                result.warnings.push("git disponible pero directorio actual no es un repo");
                result.items.push({ name: "git", status: "warn", detail: gv + " · NO es repo" });
            }
        } else {
            result.ok = false;
            result.errors.push("git no disponible");
            result.items.push({ name: "git", status: "error", detail: "no encontrado" });
        }

        // Android AVD
        const avdDir = path.join(process.env.USERPROFILE || process.env.HOME || "", ".android", "avd");
        const avdExists = fs.existsSync(path.join(avdDir, "virtualAndroid.avd"));
        const snapshotDir = path.join(avdDir, "virtualAndroid.avd", "snapshots", "qa-ready");
        const snapshotExists = fs.existsSync(snapshotDir);
        if (avdExists && snapshotExists) {
            result.items.push({ name: "Android AVD", status: "ok", detail: "virtualAndroid + snapshot qa-ready" });
        } else if (avdExists) {
            result.warnings.push("AVD virtualAndroid existe pero snapshot qa-ready no encontrado");
            result.items.push({ name: "Android AVD", status: "warn", detail: "snapshot qa-ready no encontrado" });
        } else {
            result.warnings.push("AVD virtualAndroid no registrado");
            result.items.push({ name: "Android AVD", status: "warn", detail: "AVD no encontrado" });
        }
    } catch (e) {
        // Fail-open
        result.items.push({ name: "env-check", status: "error", detail: "Error interno: " + e.message });
    }

    return result;
}

// ─── Check: Hooks ───────────────────────────────────────────────────────────

function checkHooks() {
    const result = { ok: true, warnings: [], errors: [], items: [] };

    try {
        // Leer settings.json para obtener hooks registrados
        let settings;
        try {
            settings = JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8"));
        } catch (e) {
            result.ok = false;
            result.errors.push("No se pudo leer settings.json: " + e.message);
            result.items.push({ name: "settings.json", status: "error", detail: "no legible" });
            return result;
        }

        const hooks = settings.hooks || {};
        const checkedScripts = new Set();

        for (const [event, matchers] of Object.entries(hooks)) {
            if (!Array.isArray(matchers)) continue;
            for (const matcher of matchers) {
                if (!matcher.hooks || !Array.isArray(matcher.hooks)) continue;
                for (const hook of matcher.hooks) {
                    if (!hook.command) continue;
                    // Extraer path del script .js
                    const match = hook.command.match(/node\s+(.+\.js)/);
                    if (!match) continue;
                    const scriptPath = match[1].trim();
                    const scriptName = path.basename(scriptPath);

                    if (checkedScripts.has(scriptName)) continue;
                    checkedScripts.add(scriptName);

                    // Convertir MSYS2 path (/c/...) a Windows path (C:\...)
                    const fullPath = scriptPath.replace(/^\/([a-zA-Z])\//, "$1:\\").replace(/\//g, "\\");
                    const exists = fs.existsSync(fullPath);
                    const matcherLabel = matcher.matcher ? event + "[" + matcher.matcher + "]" : event;

                    if (exists) {
                        result.items.push({ name: scriptName, status: "ok", detail: matcherLabel });
                    } else {
                        result.ok = false;
                        result.errors.push(scriptName + " registrado en " + matcherLabel + " pero archivo no existe");
                        result.items.push({ name: scriptName, status: "error", detail: matcherLabel + " · FALTA archivo" });
                    }
                }
            }
        }

        // telegram-config.json
        try {
            const config = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
            if (config.bot_token && config.chat_id) {
                result.items.push({ name: "telegram-config.json", status: "ok", detail: "bot_token + chat_id presentes" });
            } else {
                result.warnings.push("telegram-config.json incompleto");
                result.items.push({ name: "telegram-config.json", status: "warn", detail: "faltan campos" });
            }
        } catch (e) {
            result.ok = false;
            result.errors.push("telegram-config.json no legible");
            result.items.push({ name: "telegram-config.json", status: "error", detail: "no legible" });
        }

        // telegram-commander activo
        try {
            if (fs.existsSync(COMMANDER_LOCK)) {
                const lockData = JSON.parse(fs.readFileSync(COMMANDER_LOCK, "utf8"));
                if (lockData.pid && isProcessAlive(lockData.pid)) {
                    result.items.push({ name: "telegram-commander", status: "ok", detail: "activo (PID " + lockData.pid + ")" });
                } else {
                    result.warnings.push("telegram-commander lock existe pero PID muerto");
                    result.items.push({ name: "telegram-commander", status: "warn", detail: "PID " + (lockData.pid || "?") + " muerto" });
                }
            } else {
                result.warnings.push("telegram-commander no activo (sin lockfile)");
                result.items.push({ name: "telegram-commander", status: "warn", detail: "no activo" });
            }
        } catch (e) {
            result.items.push({ name: "telegram-commander", status: "warn", detail: "error verificando: " + e.message });
        }

        // Lockfiles stale de permission-approver
        const approverLocks = ["permission-approver.lock", "reporter.pid"];
        for (const lockName of approverLocks) {
            const lockPath = path.join(HOOKS_DIR, lockName);
            if (fs.existsSync(lockPath)) {
                try {
                    const content = fs.readFileSync(lockPath, "utf8").trim();
                    const pid = parseInt(content) || parseInt(content.split("\n")[0]);
                    if (pid && isPidAliveTasklist(pid)) {
                        result.items.push({ name: lockName, status: "ok", detail: "PID " + pid + " vivo" });
                    } else {
                        result.warnings.push(lockName + " con PID muerto");
                        result.items.push({ name: lockName, status: "warn", detail: "PID " + (pid || "?") + " stale" });
                    }
                } catch (e) {}
            }
        }
    } catch (e) {
        result.items.push({ name: "hooks-check", status: "error", detail: "Error interno: " + e.message });
    }

    return result;
}

// ─── Check: Recursos ────────────────────────────────────────────────────────

function checkResources() {
    const result = { ok: true, warnings: [], errors: [], items: [] };

    try {
        // Espacio en disco
        const dfOutput = safeExec('df -BG /c/Workspaces/ 2>&1') || safeExec('df -k /c/Workspaces/ 2>&1');
        if (dfOutput) {
            const lines = dfOutput.split("\n");
            if (lines.length >= 2) {
                const parts = lines[1].split(/\s+/);
                // df -BG: Available es columna 3
                let availGB = 0;
                for (const p of parts) {
                    const gMatch = p.match(/^(\d+)G$/);
                    if (gMatch) { availGB = parseInt(gMatch[1]); break; }
                }
                if (availGB === 0) {
                    // df -k fallback
                    const avail = parseInt(parts[3]);
                    if (avail) availGB = Math.round(avail / (1024 * 1024));
                }
                if (availGB > 0) {
                    if (availGB < 2) {
                        result.ok = false;
                        result.errors.push("Disco CRITICO: " + availGB + " GB libres");
                        result.items.push({ name: "Disco", status: "error", detail: availGB + " GB libres (< 2 GB)" });
                    } else if (availGB < 5) {
                        result.warnings.push("Disco bajo: " + availGB + " GB libres");
                        result.items.push({ name: "Disco", status: "warn", detail: availGB + " GB libres (< 5 GB)" });
                    } else {
                        result.items.push({ name: "Disco", status: "ok", detail: availGB + " GB libres" });
                    }
                } else {
                    result.items.push({ name: "Disco", status: "ok", detail: "no se pudo determinar espacio" });
                }
            }
        }

        // Worktrees huérfanos
        const parentDir = path.resolve(REPO_ROOT, "..");
        const repoName = path.basename(REPO_ROOT);
        let orphanWorktrees = [];
        try {
            const entries = fs.readdirSync(parentDir);
            for (const entry of entries) {
                if (entry.startsWith("platform.agent-") || entry.startsWith("platform.codex-")) {
                    const fullPath = path.join(parentDir, entry);
                    try {
                        if (fs.statSync(fullPath).isDirectory()) {
                            orphanWorktrees.push(entry);
                        }
                    } catch (e) {}
                }
            }
        } catch (e) {}

        if (orphanWorktrees.length > 0) {
            result.warnings.push(orphanWorktrees.length + " worktrees huérfanos detectados");
            result.items.push({ name: "Worktrees", status: "warn", detail: orphanWorktrees.length + " huérfanos → /cleanup", worktrees: orphanWorktrees });
        } else {
            result.items.push({ name: "Worktrees", status: "ok", detail: "sin huérfanos" });
        }

        // Procesos zombie
        let zombieCount = 0;
        try {
            const out = safeExec('tasklist /FI "IMAGENAME eq claude.exe" /FO CSV /NH');
            if (out) {
                const lines = out.split("\n").filter(l => l.includes("claude"));
                for (const line of lines) {
                    const parts = line.match(/"([^"]+)"/g);
                    if (!parts || parts.length < 2) continue;
                    const pid = parseInt(parts[1].replace(/"/g, ""));
                    if (!pid || pid === process.ppid || pid === process.pid) continue;
                    // Verificar edad
                    const wmic = safeExec('wmic process where "ProcessId=' + pid + '" get CreationDate /FORMAT:VALUE');
                    if (wmic) {
                        const m = wmic.match(/CreationDate=(\d{14})/);
                        if (m) {
                            const d = m[1];
                            const created = new Date(d.substring(0, 4) + "-" + d.substring(4, 6) + "-" + d.substring(6, 8) + "T" + d.substring(8, 10) + ":" + d.substring(10, 12) + ":" + d.substring(12, 14)).getTime();
                            const ageMin = Math.round((Date.now() - created) / 60000);
                            if (ageMin > 30) zombieCount++;
                        }
                    }
                }
            }
        } catch (e) {}

        if (zombieCount > 0) {
            result.warnings.push(zombieCount + " procesos claude.exe zombie (>30 min)");
            result.items.push({ name: "Procesos", status: "warn", detail: zombieCount + " zombies" });
        } else {
            result.items.push({ name: "Procesos", status: "ok", detail: "sin zombies" });
        }

        // PIDs stale en sprint-pids.json
        const pidsFile = path.join(REPO_ROOT, "scripts", "sprint-pids.json");
        if (fs.existsSync(pidsFile)) {
            try {
                const pids = JSON.parse(fs.readFileSync(pidsFile, "utf8"));
                let staleCount = 0;
                for (const [key, pid] of Object.entries(pids)) {
                    if (!isPidAliveTasklist(pid)) staleCount++;
                }
                if (staleCount > 0) {
                    result.warnings.push(staleCount + " PIDs stale en sprint-pids.json");
                    result.items.push({ name: "Sprint PIDs", status: "warn", detail: staleCount + " stale" });
                }
            } catch (e) {}
        }

        // Logs excedidos
        const hookLog = path.join(HOOKS_DIR, "hook-debug.log");
        const activityLog = path.join(REPO_ROOT, ".claude", "activity-log.jsonl");
        const hookLines = countLines(hookLog);
        const activityLines = countLines(activityLog);

        if (hookLines > 1000) {
            result.warnings.push("hook-debug.log: " + hookLines + " líneas (> 1000)");
            result.items.push({ name: "hook-debug.log", status: "warn", detail: hookLines + " líneas → recortar" });
        }
        if (activityLines > 400) {
            result.warnings.push("activity-log.jsonl: " + activityLines + " entradas (> 400)");
            result.items.push({ name: "activity-log.jsonl", status: "warn", detail: activityLines + " entradas → recortar" });
        }
    } catch (e) {
        result.items.push({ name: "resources-check", status: "error", detail: "Error interno: " + e.message });
    }

    return result;
}

// ─── Auto-reparación ────────────────────────────────────────────────────────

function autoFix() {
    const fixes = [];

    try {
        // 1. Limpiar lockfiles con PID muerto
        const lockFiles = ["telegram-commander.lock", "reporter.pid", "permission-approver.lock"];
        for (const lockName of lockFiles) {
            const lockPath = path.join(HOOKS_DIR, lockName);
            if (fs.existsSync(lockPath)) {
                try {
                    const content = fs.readFileSync(lockPath, "utf8").trim();
                    let pid;
                    try { pid = JSON.parse(content).pid; } catch (e) { pid = parseInt(content) || parseInt(content.split("\n")[0]); }
                    if (pid && !isProcessAlive(pid) && !isPidAliveTasklist(pid)) {
                        fs.unlinkSync(lockPath);
                        fixes.push({ action: "Lockfile eliminado", target: lockName, detail: "PID " + pid + " muerto" });
                    }
                } catch (e) {}
            }
        }

        // 2. git worktree prune
        const pruneOut = safeExec("git worktree prune -v 2>&1", { cwd: REPO_ROOT });
        if (pruneOut && pruneOut.trim()) {
            fixes.push({ action: "Worktree prune", target: "git", detail: pruneOut.substring(0, 100) });
        }

        // 3. Recortar logs excedidos
        const hookLog = path.join(HOOKS_DIR, "hook-debug.log");
        if (fs.existsSync(hookLog)) {
            const lines = fs.readFileSync(hookLog, "utf8").split("\n");
            if (lines.length > 1000) {
                const trimmed = lines.slice(-500).join("\n");
                fs.writeFileSync(hookLog, trimmed);
                fixes.push({ action: "Log recortado", target: "hook-debug.log", detail: lines.length + " → 500 líneas" });
            }
        }

        const activityLog = path.join(REPO_ROOT, ".claude", "activity-log.jsonl");
        if (fs.existsSync(activityLog)) {
            const lines = fs.readFileSync(activityLog, "utf8").trim().split("\n").filter(l => l.trim());
            if (lines.length > 400) {
                const trimmed = lines.slice(-200).join("\n") + "\n";
                fs.writeFileSync(activityLog, trimmed);
                fixes.push({ action: "Log recortado", target: "activity-log.jsonl", detail: lines.length + " → 200 entradas" });
            }
        }

        // 4. Limpiar PIDs stale en sprint-pids.json
        const pidsFile = path.join(REPO_ROOT, "scripts", "sprint-pids.json");
        if (fs.existsSync(pidsFile)) {
            try {
                const pids = JSON.parse(fs.readFileSync(pidsFile, "utf8"));
                const alive = {};
                let removed = 0;
                for (const [key, pid] of Object.entries(pids)) {
                    if (isPidAliveTasklist(pid)) {
                        alive[key] = pid;
                    } else {
                        removed++;
                    }
                }
                if (removed > 0) {
                    fs.writeFileSync(pidsFile, JSON.stringify(alive, null, 2));
                    fixes.push({ action: "PIDs limpiados", target: "sprint-pids.json", detail: removed + " stale eliminados" });
                }
            } catch (e) {}
        }
    } catch (e) {
        fixes.push({ action: "Error", target: "autoFix", detail: e.message });
    }

    return fixes;
}

// ─── Run All ────────────────────────────────────────────────────────────────

function runAll(options) {
    const opts = options || {};
    const results = {};

    if (!opts.onlyHooks && !opts.onlyResources) {
        results.environment = checkEnvironment();
    }
    if (!opts.onlyEnv && !opts.onlyResources) {
        results.hooks = checkHooks();
    }
    if (!opts.onlyEnv && !opts.onlyHooks) {
        results.resources = checkResources();
    }
    if (opts.fix) {
        results.fixes = autoFix();
    }

    // Calcular veredicto global
    let totalErrors = 0;
    let totalWarnings = 0;
    let critical = false;

    for (const [key, check] of Object.entries(results)) {
        if (key === "fixes") continue;
        if (check.errors) totalErrors += check.errors.length;
        if (check.warnings) totalWarnings += check.warnings.length;
        if (check.ok === false) critical = true;
    }

    return {
        results,
        summary: { errors: totalErrors, warnings: totalWarnings, critical },
        timestamp: new Date().toISOString()
    };
}

// ─── Exports ────────────────────────────────────────────────────────────────

module.exports = { checkEnvironment, checkHooks, checkResources, autoFix, runAll };

// ─── CLI ────────────────────────────────────────────────────────────────────

if (require.main === module) {
    const args = process.argv.slice(2);
    const options = {
        fix: args.includes("--fix"),
        onlyEnv: args.includes("--env"),
        onlyHooks: args.includes("--hooks"),
        onlyResources: args.includes("--resources"),
        sprint: args.includes("--sprint")
    };

    // --sprint = env + hooks (sin resources detallado)
    if (options.sprint) {
        options.onlyResources = false;
    }

    try {
        const report = runAll(options);
        console.log(JSON.stringify(report, null, 2));
    } catch (e) {
        // Fail-open: no propagar errores
        console.log(JSON.stringify({ results: {}, summary: { errors: 0, warnings: 0, critical: false }, error: e.message }));
    }
}
