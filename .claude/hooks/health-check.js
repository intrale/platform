// health-check.js — Verificación periódica de infraestructura operativa
// Hook PostToolUse: se ejecuta en cada tool use pero con cooldown adaptativo (2-10 min)
// Verifica: telegram-commander, approvers huérfanos, bot Telegram, settings, worktrees
// Auto-repara lo que puede, notifica lo que no

const fs = require("fs");
const path = require("path");
const https = require("https");
const { execSync } = require("child_process");

const HOOKS_DIR = __dirname;
const REPO_ROOT = process.env.CLAUDE_PROJECT_DIR || path.resolve(HOOKS_DIR, "..", "..");
const LOG_FILE = path.join(HOOKS_DIR, "hook-debug.log");
const STATE_FILE = path.join(HOOKS_DIR, "health-check-state.json");
const HISTORY_FILE = path.join(HOOKS_DIR, "health-check-history.json");
const CONFIG_FILE = path.join(HOOKS_DIR, "telegram-config.json");
const COMMANDER_LOCK = path.join(HOOKS_DIR, "telegram-commander.lock");
const GH_CLI = "/c/Workspaces/gh-cli/bin/gh.exe";

// Cooldown adaptativo: reduce el intervalo ante problemas para confirmar recuperación más rápido
const MIN_INTERVAL_MS = 2 * 60 * 1000;  // 2 min — modo alerta
const MAX_INTERVAL_MS = 10 * 60 * 1000; // 10 min — modo normal

// Umbrales de escalada
const THRESHOLD_WARN = 3;   // 3-4 ocurrencias → advertencia de recurrencia
const THRESHOLD_ISSUE = 5;  // >=5 ocurrencias → crear issue en GitHub

// Checks que NO deben escalar a issue INICIALMENTE — dead_worktrees escala dinámicamente tras THRESHOLD_ISSUE ciclos
// (dead_worktrees removido: ahora escala si el auto-fix falla persistentemente)
const NO_ESCALATE = new Set([]);

// Deduplicación de alertas: no re-notificar por Telegram si el problema no cambió de estado
const NOTIFICATION_COOLDOWN_MS = 60 * 60 * 1000; // 60 minutos

// Mapeo de check a problema ID y categoría
const CHECK_PROBLEM_MAP = {
    commander: { id: "commander_down", category: "crash", desc: "Telegram Commander caído" },
    approvers: { id: "orphaned_approvers", category: "zombie", desc: "Permission-approver huérfanos acumulados" },
    telegram: { id: "telegram_bot", category: "crash", desc: "Bot Telegram no responde" },
    settings: { id: "settings_corrupt", category: "corrupt_config", desc: "Settings JSON inválidos o faltantes" },
    hooks: { id: null, category: "missing_hook", desc: "Hook crítico ausente" },
    worktrees: { id: "dead_worktrees", category: "dead_worktree", desc: "Worktrees sin contenido" }
};

// P-15: Ops learnings
let opsLearnings;
try { opsLearnings = require("./ops-learnings"); } catch (e) { opsLearnings = null; }

function log(msg) {
    try { fs.appendFileSync(LOG_FILE, "[" + new Date().toISOString() + "] HealthCheck: " + msg + "\n"); } catch (e) {}
}

function readState() {
    try { return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); } catch (e) { return {}; }
}

function writeState(state) {
    try { fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf8"); } catch (e) {}
}

// ─── Historial de problemas ─────────────────────────────────────────────────

function readHistory() {
    try {
        const data = JSON.parse(fs.readFileSync(HISTORY_FILE, "utf8"));
        if (!Array.isArray(data.problems)) data.problems = [];
        return data;
    } catch (e) {
        return { problems: [] };
    }
}

function writeHistory(history) {
    try { fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2), "utf8"); } catch (e) {}
}

function findProblem(history, id) {
    return history.problems.find(p => p.id === id);
}

function recordProblem(history, id, category, detail, autoFixed) {
    const now = new Date().toISOString();
    let problem = findProblem(history, id);
    if (problem) {
        if (problem.resolved_at) {
            problem.occurrences = 1;
            problem.first_seen = now;
            problem.resolved_at = null;
            problem.github_issue = null;
        } else {
            problem.occurrences++;
        }
        problem.last_seen = now;
        problem.auto_fixed = autoFixed;
        problem.last_detail = detail;
    } else {
        problem = {
            id: id,
            category: category,
            occurrences: 1,
            first_seen: now,
            last_seen: now,
            resolved_at: null,
            auto_fixed: autoFixed,
            github_issue: null,
            last_detail: detail,
            last_notified_at: null
        };
        history.problems.push(problem);
    }
    return problem;
}

function markResolved(history, id) {
    const problem = findProblem(history, id);
    if (problem && !problem.resolved_at) {
        problem.resolved_at = new Date().toISOString();
        return problem;
    }
    return null;
}

// ─── Creación de issues en GitHub ───────────────────────────────────────────

function createGitHubIssue(problem) {
    try {
        const title = "fix(hooks): " + problem.last_detail.substring(0, 80);
        const body = [
            "## Problema recurrente detectado por Health Check",
            "",
            "| Campo | Valor |",
            "|-------|-------|",
            "| **ID** | `" + problem.id + "` |",
            "| **Categoría** | `" + problem.category + "` |",
            "| **Ocurrencias** | " + problem.occurrences + " |",
            "| **Primera vez** | " + problem.first_seen + " |",
            "| **Última vez** | " + problem.last_seen + " |",
            "| **Auto-reparado** | " + (problem.auto_fixed ? "Sí" : "No") + " |",
            "",
            "### Detalle técnico",
            problem.last_detail,
            "",
            "### Comportamiento observado",
            "El health check detectó este problema " + problem.occurrences + " veces desde " + problem.first_seen + ".",
            problem.auto_fixed
                ? "Se aplicaron auto-reparaciones pero el problema persiste, lo que indica un fallo estructural."
                : "No se pudo auto-reparar — requiere intervención manual.",
            "",
            "### Comportamiento esperado",
            "El check `" + problem.id + "` debería pasar sin errores de forma estable.",
            "",
            "---",
            "_Issue creado automáticamente por `health-check.js` (umbral: >=" + THRESHOLD_ISSUE + " ocurrencias)._"
        ].join("\n");

        const result = execSync(
            GH_CLI + ' issue create --repo intrale/platform'
            + ' --title "' + title.replace(/"/g, '\\\\"') + '"'
            + ' --body "' + body.replace(/"/g, '\\\\"').replace(/\n/g, '\\\\n') + '"'
            + ' --label "bug,area:infra,tipo:infra"'
            + ' --assignee leitolarreta',
            { encoding: "utf8", timeout: 15000, windowsHide: true }
        );

        const match = result.trim().match(/\/issues\/(\d+)/);
        if (match) {
            const issueNumber = parseInt(match[1]);
            log("Issue #" + issueNumber + " creado para problema recurrente: " + problem.id);
            return issueNumber;
        }
    } catch (e) {
        log("Error creando issue GitHub: " + e.message);
    }
    return null;
}

function commentOnIssue(issueNumber, message) {
    try {
        execSync(
            GH_CLI + ' issue comment ' + issueNumber + ' --repo intrale/platform'
            + ' --body "' + message.replace(/"/g, '\\\\"') + '"',
            { encoding: "utf8", timeout: 10000, windowsHide: true }
        );
        log("Comentario agregado al issue #" + issueNumber);
    } catch (e) {
        log("Error comentando issue #" + issueNumber + ": " + e.message);
    }
}

// ─── Procesamiento de problemas con historial ───────────────────────────────

function processCheckResult(history, checkName, checkResult, detail) {
    const mapping = CHECK_PROBLEM_MAP[checkName];
    if (!mapping) return [];

    const results = [];

    if (!checkResult.ok) {
        let problemIds;
        if (checkName === "hooks" && checkResult.missing) {
            problemIds = checkResult.missing.map(h => "missing_hook_" + h.replace(/\./g, "_"));
        } else {
            problemIds = [mapping.id];
        }

        for (const id of problemIds) {
            const autoFixed = checkName === "commander" || checkName === "approvers" || checkName === "worktrees";
            const problem = recordProblem(history, id, mapping.category, detail, autoFixed);
            const canEscalate = !NO_ESCALATE.has(id);

            // P-15: Registrar en ops-learnings para bitácora operativa
            if (opsLearnings) {
                try {
                    opsLearnings.recordLearning({
                        source: "health-check",
                        category: mapping.category,
                        severity: problem.occurrences >= THRESHOLD_ISSUE ? "critical" : problem.occurrences >= THRESHOLD_WARN ? "high" : "low",
                        symptom: id + ": " + (detail || mapping.desc),
                        root_cause: autoFixed ? "Auto-reparado" : "",
                        resolution: autoFixed ? "Auto-fix aplicado por health-check" : "",
                        affected: ["health-check.js"],
                        auto_detected: true
                    });
                } catch (e) { log("ops-learnings error: " + e.message); }
            }

            results.push({
                id: id,
                problem: problem,
                isNew: problem.occurrences === 1,
                isRecurrent: problem.occurrences >= THRESHOLD_WARN,
                needsIssue: canEscalate && problem.occurrences >= THRESHOLD_ISSUE && !problem.github_issue,
                canEscalate: canEscalate
            });
        }
    } else {
        let problemIds;
        if (checkName === "hooks") {
            problemIds = history.problems
                .filter(p => p.category === "missing_hook" && !p.resolved_at)
                .map(p => p.id);
        } else if (mapping.id) {
            problemIds = [mapping.id];
        } else {
            problemIds = [];
        }

        for (const id of problemIds) {
            const resolved = markResolved(history, id);
            if (resolved) {
                results.push({
                    id: id,
                    problem: resolved,
                    resolved: true
                });
            }
        }
    }

    return results;
}

function isProcessAlive(pid) {
    try { process.kill(pid, 0); return true; } catch (e) { return false; }
}

// ─── Check 1: telegram-commander vivo ──────────────────────────────────────

function checkCommander() {
    const result = { ok: true, detail: "" };
    try {
        if (!fs.existsSync(COMMANDER_LOCK)) {
            result.ok = false;
            result.detail = "No hay lockfile — commander no activo";
            return result;
        }
        const data = JSON.parse(fs.readFileSync(COMMANDER_LOCK, "utf8"));
        if (!data.pid || !isProcessAlive(data.pid)) {
            result.ok = false;
            result.detail = "PID " + (data.pid || "?") + " muerto — commander caído";
            // Auto-fix: limpiar lockfile para que commander-launcher.js lo relance
            try { fs.unlinkSync(COMMANDER_LOCK); } catch (e) {}
            result.detail += " (lockfile limpiado, se relanzará automáticamente)";
            return result;
        }
        result.detail = "PID " + data.pid + " activo";
    } catch (e) {
        result.ok = false;
        result.detail = "Error leyendo lockfile: " + e.message;
    }
    return result;
}

// ─── Check 2: permission-approver huérfanos ────────────────────────────────

function checkOrphanedApprovers() {
    const result = { ok: true, detail: "", fixed: 0 };
    try {
        // Contar procesos permission-approver.js
        const output = execSync('tasklist /FI "IMAGENAME eq node.exe" /FO CSV /NH 2>NUL', {
            encoding: "utf8", timeout: 5000, windowsHide: true
        });

        // Obtener PIDs de todos los node.exe
        const wmicOutput = execSync(
            'wmic process where "name=\'node.exe\' and commandline like \'%permission-approver%\'" get ProcessId /FORMAT:LIST 2>NUL',
            { encoding: "utf8", timeout: 5000, windowsHide: true }
        );

        const pids = [];
        wmicOutput.split("\n").forEach(line => {
            const m = line.trim().match(/^ProcessId=(\d+)$/);
            if (m) pids.push(parseInt(m[1]));
        });

        // Máximo 2 approvers simultáneos es normal (sesión principal puede tener 1-2)
        // Más de 3 indica huérfanos
        const MAX_HEALTHY = 3;
        if (pids.length > MAX_HEALTHY) {
            result.ok = false;
            const orphanCount = pids.length - 1; // quedarnos con al menos 1
            result.detail = pids.length + " approvers activos (máximo saludable: " + MAX_HEALTHY + ")";

            // Auto-fix: matar los más viejos (PIDs más bajos = más viejos)
            const toKill = pids.sort((a, b) => a - b).slice(0, pids.length - 1);
            for (const pid of toKill) {
                try {
                    execSync("taskkill /PID " + pid + " /F 2>NUL", {
                        timeout: 3000, windowsHide: true
                    });
                    result.fixed++;
                } catch (e) {}
            }
            result.detail += " → " + result.fixed + " eliminados";
        } else {
            result.detail = pids.length + " approver(s) activo(s)";
        }
    } catch (e) {
        // No es crítico si falla el check
        result.detail = "No se pudo verificar: " + e.message;
    }
    return result;
}

// ─── Check 3: Bot Telegram responde ────────────────────────────────────────

function checkTelegramBot() {
    return new Promise((resolve) => {
        try {
            const config = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
            const url = "/bot" + config.bot_token + "/getMe";
            const req = https.get({
                hostname: "api.telegram.org", path: url, timeout: 5000
            }, (res) => {
                let d = "";
                res.on("data", c => d += c);
                res.on("end", () => {
                    try {
                        const r = JSON.parse(d);
                        resolve({ ok: r.ok === true, detail: r.ok ? "Bot responde (@" + r.result.username + ")" : "Bot error: " + d });
                    } catch (e) {
                        resolve({ ok: false, detail: "Respuesta inválida" });
                    }
                });
            });
            req.on("timeout", () => { req.destroy(); resolve({ ok: false, detail: "Timeout 5s" }); });
            req.on("error", e => resolve({ ok: false, detail: "Error: " + e.message }));
        } catch (e) {
            resolve({ ok: false, detail: "Config no legible: " + e.message });
        }
    });
}

// ─── Check 4: Settings intactos ────────────────────────────────────────────

function checkSettings() {
    const result = { ok: true, details: [] };
    const files = [
        path.join(REPO_ROOT, ".claude", "settings.json"),
        path.join(REPO_ROOT, ".claude", "settings.local.json"),
        CONFIG_FILE
    ];
    for (const f of files) {
        const name = path.basename(f);
        try {
            const content = fs.readFileSync(f, "utf8");
            JSON.parse(content);
        } catch (e) {
            result.ok = false;
            result.details.push(name + ": " + (e.code === "ENOENT" ? "FALTA" : "JSON inválido"));
        }
    }
    if (result.ok) result.details.push("Todos los settings válidos");
    return result;
}

// ─── Check 5: Hooks críticos presentes ─────────────────────────────────────

function checkCriticalHooks() {
    const result = { ok: true, missing: [] };
    const critical = [
        "permission-approver.js", "notify-telegram.js", "stop-notify.js",
        "branch-guard.js", "activity-logger.js", "commander-launcher.js",
        "telegram-commander.js", "permission-tracker.js", "permission-utils.js",
        "telegram-config.json"
    ];
    for (const f of critical) {
        if (!fs.existsSync(path.join(HOOKS_DIR, f))) {
            result.ok = false;
            result.missing.push(f);
        }
    }
    return result;
}

// ─── Check 6: Worktrees muertos — detección git + filesystem, reparación por capas ──

function parseGitWorktreeList(cwd) {
    try {
        const output = execSync("git worktree list --porcelain", {
            cwd: cwd, encoding: "utf8", timeout: 10000, windowsHide: true
        });
        const worktrees = [];
        let current = {};
        for (const line of output.split("\n")) {
            if (line.startsWith("worktree ")) {
                if (current.path) worktrees.push(current);
                current = { path: line.substring(9).trim() };
            } else if (line.startsWith("branch ")) {
                current.branch = line.substring(7).trim();
            } else if (line.trim() === "bare") {
                current.bare = true;
            } else if (line.trim() === "") {
                if (current.path) worktrees.push(current);
                current = {};
            }
        }
        if (current.path) worktrees.push(current);
        return worktrees;
    } catch (e) {
        log("Error parseando git worktree list: " + e.message);
        return [];
    }
}

function tryRepairWorktree(wtPath, entry) {
    // Estrategia de reparación por capas (NUNCA rm -rf — protección junctions NTFS)

    // Capa 1: git worktree remove --force
    try {
        execSync('git worktree remove "' + wtPath + '" --force', {
            cwd: REPO_ROOT, encoding: "utf8", timeout: 15000, windowsHide: true
        });
        log("Worktree reparado (capa 1 — git worktree remove --force): " + entry);
        return { success: true, strategy: "git worktree remove --force" };
    } catch (e) {
        log("Capa 1 falló para " + entry + ": " + e.message);
    }

    // Capa 2: desmontar junction NTFS .claude/ y reintentar
    const claudeJunction = path.join(wtPath, ".claude");
    try {
        if (fs.existsSync(claudeJunction)) {
            execSync('cmd /c rmdir "' + claudeJunction.replace(/\//g, "\\") + '"', {
                timeout: 5000, windowsHide: true
            });
            log("Junction .claude/ desmontada para: " + entry);
        }
        // Reintentar git worktree remove tras desmontar junction
        execSync('git worktree remove "' + wtPath + '" --force', {
            cwd: REPO_ROOT, encoding: "utf8", timeout: 15000, windowsHide: true
        });
        log("Worktree reparado (capa 2 — rmdir junction + git remove): " + entry);
        return { success: true, strategy: "rmdir junction + git worktree remove" };
    } catch (e) {
        log("Capa 2 falló para " + entry + ": " + e.message);
    }

    // Capa 3: git worktree prune (para limpiar referencia huérfana)
    try {
        execSync("git worktree prune", { cwd: REPO_ROOT, timeout: 5000, windowsHide: true });
        // Verificar si git ya no lo conoce
        const remaining = parseGitWorktreeList(REPO_ROOT);
        const stillExists = remaining.some(w => w.path === wtPath || w.path === wtPath.replace(/\\/g, "/"));
        if (!stillExists) {
            log("Worktree reparado (capa 3 — git worktree prune): " + entry);
            return { success: true, strategy: "git worktree prune" };
        }
    } catch (e) {
        log("Capa 3 falló para " + entry + ": " + e.message);
    }

    return { success: false, strategy: "todas las capas fallaron" };
}

function checkDeadWorktrees() {
    const result = { ok: true, dead: [], cleaned: [], strategies: {} };
    try {
        // Fuente de verdad: git worktree list --porcelain
        const gitWorktrees = parseGitWorktreeList(REPO_ROOT);
        const repoName = path.basename(REPO_ROOT);
        const mainWorktreePath = REPO_ROOT.replace(/\\/g, "/");

        // 1. Worktrees "fantasma": registrados en git pero sin directorio
        for (const wt of gitWorktrees) {
            const wtNorm = (wt.path || "").replace(/\\/g, "/");
            if (wtNorm === mainWorktreePath || wt.bare) continue;
            if (!fs.existsSync(wt.path)) {
                // Directorio inexistente — git worktree prune es suficiente
                try {
                    execSync("git worktree prune", { cwd: REPO_ROOT, timeout: 5000, windowsHide: true });
                    const entry = path.basename(wt.path);
                    result.cleaned.push(entry);
                    result.strategies[entry] = "git worktree prune (fantasma)";
                    log("Worktree fantasma podado: " + entry);
                } catch (e) {
                    const entry = path.basename(wt.path);
                    result.dead.push(entry);
                    log("No se pudo podar worktree fantasma: " + entry);
                }
            }
        }

        // 2. Worktrees en filesystem vacíos o casi vacíos (detección original mejorada)
        const parentDir = path.resolve(REPO_ROOT, "..");
        const entries = fs.readdirSync(parentDir);
        for (const entry of entries) {
            if (!entry.startsWith(repoName + ".agent-")) continue;
            const fullPath = path.join(parentDir, entry);
            try {
                const stat = fs.statSync(fullPath);
                if (!stat.isDirectory()) continue;
                const contents = fs.readdirSync(fullPath);
                if (contents.length > 1) continue; // Tiene contenido, probablemente activo

                // Directorio vacío o con solo 1 archivo residual — intentar reparar
                const repair = tryRepairWorktree(fullPath, entry);
                if (repair.success) {
                    result.cleaned.push(entry);
                    result.strategies[entry] = repair.strategy;
                } else {
                    if (!result.dead.includes(entry)) {
                        result.dead.push(entry);
                    }
                }
            } catch (e) {}
        }

        // 3. Prune final si se limpió algo
        if (result.cleaned.length > 0) {
            try { execSync("git worktree prune", { cwd: REPO_ROOT, timeout: 5000, windowsHide: true }); } catch (e) {}
        }

        if (result.dead.length > 0) result.ok = false;
    } catch (e) {
        log("Error en checkDeadWorktrees: " + e.message);
    }
    return result;
}

// ─── Notificación a Telegram ───────────────────────────────────────────────

function sendAlert(text) {
    return new Promise((resolve) => {
        try {
            const config = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
            const postData = JSON.stringify({
                chat_id: config.chat_id, text: text, parse_mode: "HTML"
            });
            const req = https.request({
                hostname: "api.telegram.org",
                path: "/bot" + config.bot_token + "/sendMessage",
                method: "POST",
                headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(postData) },
                timeout: 8000
            }, (res) => {
                let d = "";
                res.on("data", c => d += c);
                res.on("end", () => resolve(true));
            });
            req.on("error", () => resolve(false));
            req.on("timeout", () => { req.destroy(); resolve(false); });
            req.write(postData);
            req.end();
        } catch (e) { resolve(false); }
    });
}

// ─── Formateo de mensaje con contexto de recurrencia ────────────────────────

function shouldNotifyProblem(problem) {
    // Deduplicación: si el problema tiene >5 ocurrencias, no fue auto-reparado,
    // y ya se notificó hace menos de NOTIFICATION_COOLDOWN_MS → suprimir
    if (problem.occurrences > 5 && !problem.auto_fixed && problem.last_notified_at) {
        const lastNotified = new Date(problem.last_notified_at).getTime();
        if ((Date.now() - lastNotified) < NOTIFICATION_COOLDOWN_MS) {
            return false;
        }
    }
    return true;
}

function formatIssueWithRecurrence(baseMsg, problemResult) {
    if (!problemResult || !problemResult.problem) return baseMsg;

    const p = problemResult.problem;
    let suffix = "";

    if (problemResult.isRecurrent) {
        suffix = " 🔁 " + p.occurrences + "ª vez";
        if (p.github_issue) {
            suffix += " (#" + p.github_issue + ")";
        }
    }

    if (problemResult.isRecurrent) {
        return baseMsg.replace(/^🟡|^🔴/, "🔴") + suffix;
    }
    return baseMsg;
}

// ─── P-07: Per-component backoff state ──────────────────────────────────────

const COMPONENT_STATE_FILE = path.join(HOOKS_DIR, "health-check-components.json");
const TELEGRAM_GETME_CACHE_TTL = 30 * 60 * 1000; // 30 min cache for getMe
let _getMeCache = null;
let _getMeCacheTs = 0;

function loadComponentState() {
    try { return JSON.parse(fs.readFileSync(COMPONENT_STATE_FILE, "utf8")); } catch (e) { return {}; }
}

function saveComponentState(cs) {
    try { fs.writeFileSync(COMPONENT_STATE_FILE, JSON.stringify(cs, null, 2), "utf8"); } catch (e) {}
}

function shouldRunCheck(componentState, checkName, now) {
    const cs = componentState[checkName];
    if (!cs) return true;
    const interval = cs.currentInterval || MIN_INTERVAL_MS;
    return (now - (cs.lastRun || 0)) >= interval;
}

function updateComponentAfterCheck(componentState, checkName, passed, now) {
    if (!componentState[checkName]) {
        componentState[checkName] = { consecutivePasses: 0, currentInterval: MIN_INTERVAL_MS, lastRun: now };
    }
    const cs = componentState[checkName];
    cs.lastRun = now;
    if (passed) {
        cs.consecutivePasses = (cs.consecutivePasses || 0) + 1;
        // P-07: Si pasa 3x consecutivas, duplicar intervalo (hasta MAX)
        if (cs.consecutivePasses >= 3) {
            cs.currentInterval = Math.min((cs.currentInterval || MIN_INTERVAL_MS) * 2, MAX_INTERVAL_MS);
        }
    } else {
        // Fallo: resetear solo ESTE check a MIN
        cs.consecutivePasses = 0;
        cs.currentInterval = MIN_INTERVAL_MS;
    }
}

// ─── Main ──────────────────────────────────────────────────────────────────

async function main() {
    const state = readState();
    const now = Date.now();
    const effectiveInterval = state.next_interval_ms || MAX_INTERVAL_MS;
    if (state.last_check && (now - state.last_check) < effectiveInterval) {
        return;
    }

    log("Iniciando verificación periódica...");

    const history = readHistory();
    const componentState = loadComponentState();

    // P-07: Solo ejecutar checks cuyo intervalo individual haya vencido
    const checks = {};
    if (shouldRunCheck(componentState, "commander", now)) {
        checks.commander = checkCommander();
    } else {
        checks.commander = { ok: true, detail: "skipped (backoff)" };
    }
    if (shouldRunCheck(componentState, "approvers", now)) {
        checks.approvers = checkOrphanedApprovers();
    } else {
        checks.approvers = { ok: true, detail: "skipped (backoff)" };
    }
    if (shouldRunCheck(componentState, "telegram", now)) {
        // P-07: Cache getMe por 30 min
        if (_getMeCache && (now - _getMeCacheTs) < TELEGRAM_GETME_CACHE_TTL) {
            checks.telegram = _getMeCache;
        } else {
            checks.telegram = await checkTelegramBot();
            if (checks.telegram.ok) { _getMeCache = checks.telegram; _getMeCacheTs = now; }
        }
    } else {
        checks.telegram = { ok: true, detail: "skipped (backoff)" };
    }
    if (shouldRunCheck(componentState, "settings", now)) {
        checks.settings = checkSettings();
    } else {
        checks.settings = { ok: true, details: ["skipped (backoff)"] };
    }
    if (shouldRunCheck(componentState, "hooks", now)) {
        checks.hooks = checkCriticalHooks();
    } else {
        checks.hooks = { ok: true, missing: [] };
    }
    if (shouldRunCheck(componentState, "worktrees", now)) {
        checks.worktrees = checkDeadWorktrees();
    } else {
        checks.worktrees = { ok: true, dead: [] };
    }

    // P-07: Actualizar estado por componente
    for (const [name, result] of Object.entries(checks)) {
        if (result.detail !== "skipped (backoff)" && !(result.details && result.details[0] === "skipped (backoff)")) {
            updateComponentAfterCheck(componentState, name, result.ok, now);
        }
    }
    saveComponentState(componentState);

    const checkDetails = {
        commander: checks.commander.detail,
        approvers: checks.approvers.detail,
        telegram: checks.telegram.detail,
        settings: checks.settings.details.join(", "),
        hooks: checks.hooks.missing.length > 0 ? "Faltantes: " + checks.hooks.missing.join(", ") : "Todos presentes",
        worktrees: checks.worktrees.dead.length > 0
            ? checks.worktrees.dead.length + " muertos [" + checks.worktrees.dead.join(", ") + "]"
                + (checks.worktrees.cleaned.length > 0 ? " (" + checks.worktrees.cleaned.length + " limpiados)" : "")
            : checks.worktrees.cleaned.length > 0
                ? checks.worktrees.cleaned.length + " limpiados ✅"
                    + (Object.keys(checks.worktrees.strategies || {}).length > 0
                        ? " (" + Object.values(checks.worktrees.strategies).join(", ") + ")"
                        : "")
                : "OK"
    };

    const allResults = {};
    const issuesCreated = [];
    const problemsResolved = [];

    for (const [checkName, checkResult] of Object.entries(checks)) {
        const results = processCheckResult(history, checkName, checkResult, checkDetails[checkName]);
        allResults[checkName] = results;

        for (const r of results) {
            if (r.needsIssue) {
                const issueNum = createGitHubIssue(r.problem);
                if (issueNum) {
                    r.problem.github_issue = issueNum;
                    issuesCreated.push({ id: r.id, issue: issueNum });
                }
            }

            if (r.resolved) {
                problemsResolved.push(r);
                if (r.problem.github_issue) {
                    commentOnIssue(
                        r.problem.github_issue,
                        "✅ **Auto-resuelto** — El health check confirma que `" + r.id
                        + "` pasó correctamente en " + new Date().toISOString()
                        + ".\n\nEl problema se resolvió tras " + r.problem.occurrences + " ocurrencia(s)."
                    );
                }
            }
        }
    }

    writeHistory(history);

    const issues = [];
    const rawIssues = [];

    if (!checks.commander.ok) rawIssues.push({ msg: "🔴 Commander: " + checks.commander.detail, check: "commander" });
    if (!checks.approvers.ok) rawIssues.push({ msg: "🟡 Approvers: " + checks.approvers.detail, check: "approvers" });
    if (!checks.telegram.ok) rawIssues.push({ msg: "🔴 Telegram Bot: " + checks.telegram.detail, check: "telegram" });
    if (!checks.settings.ok) rawIssues.push({ msg: "🔴 Settings: " + checks.settings.details.join(", "), check: "settings" });
    if (!checks.hooks.ok) rawIssues.push({ msg: "🔴 Hooks faltantes: " + checks.hooks.missing.join(", "), check: "hooks" });
    if (!checks.worktrees.ok) rawIssues.push({ msg: "🟡 Worktrees muertos: " + checks.worktrees.dead.length, check: "worktrees" });

    for (const ri of rawIssues) {
        const results = allResults[ri.check] || [];
        const firstResult = results.find(r => !r.resolved);
        // Deduplicación: suprimir notificación si el problema es persistente y ya se notificó recientemente
        if (firstResult && firstResult.problem && !shouldNotifyProblem(firstResult.problem)) {
            log("Suprimiendo alerta duplicada para " + firstResult.id + " (cooldown activo)");
            continue;
        }
        issues.push(formatIssueWithRecurrence(ri.msg, firstResult));
        // Marcar last_notified_at para deduplicación futura
        if (firstResult && firstResult.problem) {
            firstResult.problem.last_notified_at = new Date().toISOString();
        }
    }

    const nextInterval = issues.length > 0 ? MIN_INTERVAL_MS : MAX_INTERVAL_MS;

    const newState = {
        last_check: now,
        last_check_iso: new Date(now).toISOString(),
        all_ok: issues.length === 0,
        issues_found: issues.length,
        next_interval_ms: nextInterval,
        checks: {
            commander: checks.commander.ok,
            approvers: checks.approvers.ok,
            telegram: checks.telegram.ok,
            settings: checks.settings.ok,
            hooks: checks.hooks.ok,
            worktrees: checks.worktrees.ok
        }
    };
    writeState(newState);

    if (issues.length > 0 || issuesCreated.length > 0) {
        let msg = "🏥 <b>Health Check — Problemas detectados</b>\n\n";
        msg += issues.map(i => "• " + i).join("\n");

        if (issuesCreated.length > 0) {
            msg += "\n\n📋 <b>Issues creados en GitHub:</b>\n";
            msg += issuesCreated.map(ic => "• #" + ic.issue + " (" + ic.id + ")").join("\n");
        }

        if (problemsResolved.length > 0) {
            msg += "\n\n✅ <b>Problemas resueltos:</b>\n";
            msg += problemsResolved.map(pr =>
                "• " + pr.id + " (tras " + pr.problem.occurrences + " ocurrencia(s))"
            ).join("\n");
        }

        msg += "\n\n<i>Auto-reparaciones aplicadas donde fue posible.</i>";
        msg += "\n<i>⚡ Próximo check en " + Math.round(nextInterval / 60000) + " min (modo alerta)</i>";

        await sendAlert(msg);
        log("ALERTA: " + issues.length + " problema(s), " + issuesCreated.length + " issue(s) creado(s), " + problemsResolved.length + " resuelto(s)");
    } else if (problemsResolved.length > 0) {
        let msg = "🏥 <b>Health Check — Todo OK</b>\n\n";
        msg += "✅ <b>Problemas resueltos:</b>\n";
        msg += problemsResolved.map(pr =>
            "• " + pr.id + " (tras " + pr.problem.occurrences + " ocurrencia(s))"
        ).join("\n");
        msg += "\n\n<i>⏱ Próximo check en " + Math.round(nextInterval / 60000) + " min</i>";

        await sendAlert(msg);
        log("RESOLUCIÓN: " + problemsResolved.length + " problema(s) resuelto(s)");
    } else {
        log("OK: todos los checks pasaron");
    }
}

main().catch(e => log("Error en health-check: " + e.message));
