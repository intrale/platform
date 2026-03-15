// sprint-sync.js — Reconciliación periódica: sprint-plan ↔ roadmap ↔ dashboard ↔ Telegram
// Issue #1417: sincronización automática de las 4 fuentes de verdad del sprint
//
// Responsabilidades:
//   a) sprint-plan.json → realidad GitHub:
//      - Agentes con status "done"/"waiting" y PR mergeada → mover a _completed[]
//      - Issues en _queue[] ya cerrados en GitHub → mover a _completed[]
//   b) roadmap.json ← sprint-plan.json:
//      - _completed[] → status "done" en roadmap
//      - agentes[] → status "in_progress" en roadmap
//   c) Dashboard freshness: actualizar archivo de estado para invalidar cache
//   d) Telegram: alertar cuando se detecta y auto-corrige desincronización
//
// Throttle: máx 1 ejecución cada 2 minutos (salvo --force)
// Idempotente: ejecutar N veces produce el mismo resultado
// Uso manual: node sprint-sync.js [--force]
// Uso como módulo: require('./sprint-sync').runSync([opts])
//
// Pure Node.js — sin dependencias externas

"use strict";

const fs   = require("fs");
const path = require("path");
const https = require("https");
const { execSync } = require("child_process");

// Validación centralizada de completación (#1458)
const { checkPRStatusViaGh } = require("./validation-utils");

// ─── Paths ────────────────────────────────────────────────────────────────────

function resolveMainRepoRoot() {
    const envRoot = process.env.CLAUDE_PROJECT_DIR || "C:\\Workspaces\\Intrale\\platform";
    try {
        const out = execSync("git worktree list", {
            encoding: "utf8", cwd: envRoot, timeout: 5000, windowsHide: true
        });
        const firstLine = out.split("\n")[0] || "";
        const match = firstLine.match(/^(.+?)\s+[0-9a-f]{5,}/);
        if (match) return match[1].trim().replace(/\\/g, "/");
    } catch (e) {}
    return envRoot.replace(/\\/g, "/");
}

const REPO_ROOT        = resolveMainRepoRoot();
const HOOKS_DIR        = path.join(REPO_ROOT, ".claude", "hooks");
const SCRIPTS_DIR      = path.join(REPO_ROOT, "scripts");
const SPRINT_PLAN_FILE = path.join(SCRIPTS_DIR, "sprint-plan.json");
const ROADMAP_FILE     = path.join(SCRIPTS_DIR, "roadmap.json");
const LOG_FILE         = path.join(HOOKS_DIR, "hook-debug.log");
const STATE_FILE       = path.join(HOOKS_DIR, "sprint-sync-state.json");
const LOCK_FILE        = path.join(HOOKS_DIR, "sprint-sync.lock");
const TG_CONFIG_FILE   = path.join(REPO_ROOT, ".claude", "hooks", "telegram-config.json");
const WORKTREES_PARENT = path.dirname(REPO_ROOT);
const REPO_BASE        = path.basename(REPO_ROOT);

const SYNC_INTERVAL_MS = 2 * 60 * 1000; // 2 minutos de throttle
const LOCK_MAX_AGE_MS  = 60 * 1000;     // Lock expirado si tiene >1 minuto

// ─── Logging ──────────────────────────────────────────────────────────────────

function log(msg) {
    try {
        fs.appendFileSync(LOG_FILE, "[" + new Date().toISOString() + "] sprint-sync: " + msg + "\n");
    } catch (e) {}
}

// ─── JSON utils ───────────────────────────────────────────────────────────────

function readJson(filePath) {
    try {
        return JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch (e) {
        return null;
    }
}

function writeJson(filePath, obj) {
    fs.writeFileSync(filePath, JSON.stringify(obj, null, 2) + "\n", "utf8");
}

// ─── Lock (mutex simple via archivo) ──────────────────────────────────────────

function acquireLock() {
    try {
        if (fs.existsSync(LOCK_FILE)) {
            const lockTs = parseInt(fs.readFileSync(LOCK_FILE, "utf8").trim(), 10) || 0;
            if (Date.now() - lockTs < LOCK_MAX_AGE_MS) {
                log("Lock activo — omitiendo ejecución");
                return false;
            }
            log("Lock expirado — forzando adquisición");
        }
        fs.writeFileSync(LOCK_FILE, String(Date.now()), "utf8");
        return true;
    } catch (e) {
        log("Error adquiriendo lock: " + e.message);
        return false;
    }
}

function releaseLock() {
    try { fs.unlinkSync(LOCK_FILE); } catch (e) {}
}

// ─── Throttle ─────────────────────────────────────────────────────────────────

function shouldRun(force) {
    if (force) return true;
    try {
        const state = readJson(STATE_FILE) || {};
        const lastRun = state.lastRun || 0;
        if (Date.now() - lastRun < SYNC_INTERVAL_MS) {
            log("Throttle activo — última ejecución hace " + Math.round((Date.now() - lastRun) / 1000) + "s");
            return false;
        }
    } catch (e) {}
    return true;
}

function updateState(info) {
    try {
        const state = readJson(STATE_FILE) || {};
        state.lastRun = Date.now();
        state.lastRunIso = new Date().toISOString();
        if (info) Object.assign(state, info);
        writeJson(STATE_FILE, state);
    } catch (e) {
        log("Error actualizando estado: " + e.message);
    }
}

// ─── Worktree utils ───────────────────────────────────────────────────────────

/**
 * Retorna el path esperado del worktree para un agente dado su issue y slug.
 * Ejemplo: /c/Workspaces/Intrale/platform.agent-1432-sprint-sync-hook
 */
function getWorktreePath(ag) {
    return path.join(WORKTREES_PARENT, REPO_BASE + ".agent-" + ag.issue + "-" + ag.slug);
}

/**
 * Verifica si el worktree de un agente existe en disco.
 * Un worktree inexistente indica que el agente terminó su sesión.
 */
function worktreeExists(ag) {
    return fs.existsSync(getWorktreePath(ag));
}

// ─── GitHub utils ──────────────────────────────────────────────────────────────

function getGhCmd() {
    const candidates = ["C:\\Workspaces\\gh-cli\\bin\\gh.exe", "gh"];
    for (const c of candidates) {
        try {
            execSync(`"${c}" --version`, { encoding: "utf8", timeout: 3000, windowsHide: true });
            return c;
        } catch (e) {}
    }
    return null;
}

/**
 * Verifica el estado del PR de una rama.
 * Retorna: "merged" | "open" | "closed_no_merge" | "none" | "unknown"
 */
function checkPRStatus(branch, ghCmd) {
    if (!ghCmd) return "unknown";
    try {
        const cmd = `"${ghCmd}" pr list --repo intrale/platform --head "${branch}" --state all --json number,state`;
        const out = execSync(cmd, { encoding: "utf8", timeout: 15000, windowsHide: true });
        const prs = JSON.parse(out || "[]");
        if (!Array.isArray(prs) || prs.length === 0) return "none";
        if (prs.find(pr => pr.state === "MERGED")) return "merged";
        if (prs.find(pr => pr.state === "OPEN")) return "open";
        return "closed_no_merge";
    } catch (e) {
        log("checkPRStatus error para " + branch + ": " + e.message);
        return "unknown";
    }
}

/**
 * Verifica si un issue de GitHub está cerrado.
 * Retorna: true si closed, false si open, null si error.
 */
function checkIssueClosed(issueNumber, ghCmd) {
    if (!ghCmd) return null;
    try {
        const cmd = `"${ghCmd}" issue view ${issueNumber} --repo intrale/platform --json state`;
        const out = execSync(cmd, { encoding: "utf8", timeout: 10000, windowsHide: true });
        const data = JSON.parse(out || "{}");
        return data.state === "CLOSED";
    } catch (e) {
        log("checkIssueClosed error para #" + issueNumber + ": " + e.message);
        return null;
    }
}

/**
 * Verifica el número de PR mergeado de una rama (para registrar en _completed).
 */
function getMergedPRNumber(branch, ghCmd) {
    if (!ghCmd) return null;
    try {
        const cmd = `"${ghCmd}" pr list --repo intrale/platform --head "${branch}" --state merged --json number`;
        const out = execSync(cmd, { encoding: "utf8", timeout: 10000, windowsHide: true });
        const prs = JSON.parse(out || "[]");
        if (Array.isArray(prs) && prs.length > 0) return prs[0].number;
    } catch (e) {}
    return null;
}

// ─── Telegram ─────────────────────────────────────────────────────────────────

function sendTelegram(message) {
    try {
        const cfg = readJson(TG_CONFIG_FILE);
        if (!cfg || !cfg.bot_token || !cfg.chat_id) return;
        const postData = JSON.stringify({
            chat_id: cfg.chat_id,
            text: message,
            parse_mode: "HTML",
            disable_notification: false
        });
        const req = https.request({
            hostname: "api.telegram.org",
            path: "/bot" + cfg.bot_token + "/sendMessage",
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(postData)
            },
            timeout: 8000
        }, (res) => {
            let d = "";
            res.on("data", c => d += c);
            res.on("end", () => log("Telegram response: " + d.substring(0, 100)));
        });
        req.on("error", e => log("Telegram error: " + e.message));
        req.write(postData);
        req.end();
    } catch (e) {
        log("sendTelegram error: " + e.message);
    }
}

// ─── Reconciliación: sprint-plan → GitHub ─────────────────────────────────────

/**
 * Comprueba agentes[] y _queue[] contra la realidad de GitHub.
 * Para cada agente verifica:
 *   - PR mergeada → mover a _completed[] con resultado "ok"
 *   - PR cerrada sin merge → mover a _completed[] con resultado "failed" + alerta
 *   - Sin PR + worktree desaparecido → alerta (sesión terminada sin PR)
 * Retorna lista de cambios aplicados.
 */
function reconcileSprintPlan(plan, ghCmd) {
    const changes = [];

    if (!plan) return changes;

    const now = new Date().toISOString();

    // a) agentes[]: verificar TODOS contra GitHub
    const agentes = Array.isArray(plan.agentes) ? [...plan.agentes] : [];

    for (const ag of agentes) {
        const branch = "agent/" + ag.issue + "-" + ag.slug;
        const prStatus = checkPRStatus(branch, ghCmd);
        log("Agente #" + ag.issue + " (status=" + (ag.status || "?") + ") branch=" + branch + " → PR=" + prStatus);

        if (prStatus === "merged") {
            // PR mergeada → mover a _completed[] con resultado "ok"
            plan.agentes = plan.agentes.filter(a => a.issue !== ag.issue);
            if (!Array.isArray(plan._completed)) plan._completed = [];
            const prNum = getMergedPRNumber(branch, ghCmd);
            plan._completed.push({
                issue: ag.issue,
                slug: ag.slug,
                titulo: ag.titulo,
                numero: ag.numero,
                stream: ag.stream,
                size: ag.size,
                resultado: "ok",
                completado_at: now,
                pr: prNum,
                sync_source: "sprint-sync"
            });
            changes.push("sprint-plan: #" + ag.issue + " movido de agentes[] a _completed[] (PR mergeada)");

        } else if (prStatus === "closed_no_merge") {
            // PR cerrada sin merge → mover a _completed[] con resultado "failed"
            plan.agentes = plan.agentes.filter(a => a.issue !== ag.issue);
            if (!Array.isArray(plan._completed)) plan._completed = [];
            plan._completed.push({
                issue: ag.issue,
                slug: ag.slug,
                titulo: ag.titulo,
                numero: ag.numero,
                stream: ag.stream,
                size: ag.size,
                resultado: "failed",
                completado_at: now,
                sync_source: "sprint-sync"
            });
            changes.push("sprint-plan: #" + ag.issue + " movido de agentes[] a _completed[] (PR cerrada sin merge)");

        } else if (prStatus === "none") {
            // Sin PR: detectar si la sesión ya terminó (worktree desaparecido)
            if (!worktreeExists(ag)) {
                changes.push("alerta: #" + ag.issue + " sesión terminada sin PR (worktree " + path.basename(getWorktreePath(ag)) + " no encontrado)");
            }
        }
        // prStatus === "open" o "unknown": agente activo o no verificable — no actuar
    }

    // b) _queue[] con issue cerrado en GitHub — verificar PR antes de marcar completed (#1458)
    const queue = Array.isArray(plan._queue) ? [...plan._queue] : [];
    for (const q of queue) {
        const closed = checkIssueClosed(q.issue, ghCmd);
        if (closed === true) {
            // Verificar si también hay PR mergeada — sin PR = "not_planned", no "ok"
            const qBranch = "agent/" + q.issue + "-" + q.slug;
            let qPrStatus = { status: "unknown" };
            try { qPrStatus = checkPRStatusViaGh(qBranch); } catch (e) {}

            plan._queue = plan._queue.filter(i => i.issue !== q.issue);
            if (!Array.isArray(plan._completed)) plan._completed = [];

            const resultado = qPrStatus.status === "merged" ? "ok" : "not_planned";
            plan._completed.push({
                issue: q.issue,
                slug: q.slug,
                titulo: q.titulo,
                numero: q.numero,
                stream: q.stream,
                size: q.size,
                resultado: resultado,
                completado_at: now,
                sync_source: "sprint-sync",
                pr_status: qPrStatus.status
            });
            changes.push("sprint-plan: #" + q.issue + " movido de _queue[] a _completed[] (issue cerrado, PR=" + qPrStatus.status + ", resultado=" + resultado + ")");
        }
    }

    return changes;
}

// ─── Reconciliación: roadmap ← sprint-plan ────────────────────────────────────

/**
 * Actualiza el sprint activo del roadmap a partir del estado de sprint-plan.
 * Retorna lista de cambios aplicados.
 */
function reconcileRoadmap(plan, roadmap) {
    const changes = [];

    if (!plan || !roadmap || !Array.isArray(roadmap.sprints)) return changes;

    // Encontrar sprint activo en roadmap que coincide con sprint-plan
    const activeSprint = roadmap.sprints.find(s => s.id === plan.sprint_id);
    if (!activeSprint) {
        log("Sprint " + plan.sprint_id + " no encontrado en roadmap — omitiendo sync de roadmap");
        return changes;
    }

    const completedIssues = new Set(
        (plan._completed || []).map(c => Number(c.issue))
    );
    const inProgressIssues = new Set(
        (plan.agentes || []).map(a => Number(a.issue))
    );
    const queueIssues = new Set(
        (plan._queue || []).map(q => Number(q.issue))
    );

    let roadmapChanged = false;

    if (!Array.isArray(activeSprint.issues)) activeSprint.issues = [];

    for (const issue of activeSprint.issues) {
        const num = Number(issue.number);
        let newStatus = issue.status;

        if (completedIssues.has(num) && issue.status !== "done") {
            newStatus = "done";
        } else if (inProgressIssues.has(num) && issue.status !== "in_progress" && issue.status !== "done") {
            newStatus = "in_progress";
        } else if (queueIssues.has(num) && issue.status !== "planned" && issue.status !== "done" && issue.status !== "in_progress") {
            newStatus = "planned";
        }

        if (newStatus !== issue.status) {
            log("Roadmap: #" + issue.number + " " + issue.status + " → " + newStatus);
            changes.push("roadmap: #" + issue.number + " " + issue.status + " → " + newStatus);
            issue.status = newStatus;
            roadmapChanged = true;
        }
    }

    // Detectar issues en sprint-plan que no están en roadmap
    const roadmapIssueSet = new Set(activeSprint.issues.map(i => Number(i.number)));
    for (const ag of [...(plan.agentes || []), ...(plan._completed || []), ...(plan._queue || [])]) {
        if (!roadmapIssueSet.has(Number(ag.issue))) {
            log("Desincronización: #" + ag.issue + " en sprint-plan pero no en roadmap." + activeSprint.id);
            changes.push("alerta: #" + ag.issue + " en sprint-plan pero no en roadmap (requiere revisión manual)");
        }
    }

    if (roadmapChanged) {
        roadmap.updated_ts = new Date().toISOString();
        roadmap.updated_by = "sprint-sync";
    }

    // Mantener exactamente 5 sprints: 1 done + actual + 3 futuros
    // Eliminar sprints done antiguos si hay más de 1
    const doneCount = roadmap.sprints.filter(s => s.status === "done").length;
    if (doneCount > 1) {
        // Mantener solo el último done
        const doneSprs = roadmap.sprints.filter(s => s.status === "done");
        const latestDone = doneSprs[doneSprs.length - 1];
        const removed = roadmap.sprints.filter(s => s.status === "done" && s.id !== latestDone.id);
        if (removed.length > 0) {
            roadmap.sprints = roadmap.sprints.filter(s => s.status !== "done" || s.id === latestDone.id);
            roadmap.updated_ts = new Date().toISOString();
            roadmap.updated_by = "sprint-sync";
            for (const r of removed) {
                changes.push("roadmap: sprint " + r.id + " archivado (mantener 5 sprints)");
            }
            log("Roadmap: archivados " + removed.length + " sprint(s) done antiguos");
        }
    }
    roadmap.horizon_sprints = 5;

    return changes;
}

// ─── Archivado de métricas por sprint (#1419) ─────────────────────────────────

const AGENT_METRICS_FILE   = path.join(HOOKS_DIR, "agent-metrics.json");
const METRICS_ARCHIVE_DIR  = path.join(HOOKS_DIR, "metrics-archive");

/**
 * Archiva las métricas del sprint cerrado en metrics-archive/agent-metrics-SPR-NNN.json.
 * Solo crea el archivo si no existe ya (idempotente).
 * Mantiene el archivo original intacto — el siguiente sprint lo sigue usando.
 *
 * @param {object} plan - sprint-plan.json actual
 * @returns {{ ok: boolean, archiveFile?: string, message?: string }}
 */
function archiveSprintMetrics(plan) {
    if (!plan || !plan.sprint_id) {
        return { ok: false, message: "sprint_id no disponible en plan" };
    }

    const sprintId = plan.sprint_id;

    // Crear directorio de archivo si no existe
    try {
        if (!fs.existsSync(METRICS_ARCHIVE_DIR)) {
            fs.mkdirSync(METRICS_ARCHIVE_DIR, { recursive: true });
            log("metrics-archive: directorio creado en " + METRICS_ARCHIVE_DIR);
        }
    } catch (e) {
        return { ok: false, message: "Error creando metrics-archive/: " + e.message };
    }

    const archiveFile = path.join(METRICS_ARCHIVE_DIR, "agent-metrics-" + sprintId + ".json");

    // Idempotente: si el archivo ya existe, no sobreescribir
    if (fs.existsSync(archiveFile)) {
        log("metrics-archive: " + sprintId + " ya archivado en " + path.basename(archiveFile));
        return { ok: true, archiveFile, message: "ya archivado (idempotente)" };
    }

    // Leer métricas actuales
    let metricsData;
    try {
        if (!fs.existsSync(AGENT_METRICS_FILE)) {
            return { ok: false, message: "agent-metrics.json no existe — sin datos que archivar" };
        }
        metricsData = JSON.parse(fs.readFileSync(AGENT_METRICS_FILE, "utf8"));
    } catch (e) {
        return { ok: false, message: "Error leyendo agent-metrics.json: " + e.message };
    }

    if (!metricsData || !Array.isArray(metricsData.sessions)) {
        return { ok: false, message: "agent-metrics.json sin sesiones" };
    }

    // Filtrar solo sesiones del sprint actual
    const sprintSessions = metricsData.sessions.filter(s => s.sprint_id === sprintId);

    // Calcular velocity (stories completadas con resultado "ok")
    const completedCount = Array.isArray(plan._completed)
        ? plan._completed.filter(c => c.resultado === "ok").length
        : 0;

    const archivePayload = {
        sprint_id:    sprintId,
        archived_at:  new Date().toISOString().replace(/\.\d+Z$/, "Z"),
        velocity:     plan.velocity || completedCount,
        sessions:     sprintSessions
    };

    try {
        fs.writeFileSync(archiveFile, JSON.stringify(archivePayload, null, 2) + "\n", "utf8");
        log("metrics-archive: " + sprintSessions.length + " sesiones de " + sprintId
            + " archivadas en " + path.basename(archiveFile));
        return { ok: true, archiveFile, sessionsArchived: sprintSessions.length };
    } catch (e) {
        return { ok: false, message: "Error escribiendo archivo de archivo: " + e.message };
    }
}

// ─── runSync: función principal exportada ─────────────────────────────────────

/**
 * Ejecuta la reconciliación completa.
 * @param {object} opts - Opciones
 * @param {boolean} opts.force - Omitir throttle y lock
 * @param {boolean} opts.silent - No enviar Telegram si no hay cambios
 */
async function runSync(opts) {
    const force = opts && opts.force;
    const silent = opts && opts.silent;

    if (!shouldRun(force)) return { skipped: true };
    if (!acquireLock()) return { skipped: true, reason: "lock" };

    log("Iniciando reconciliación" + (force ? " (forzada)" : ""));

    const allChanges = [];
    let sprintPlanChanged = false;
    let roadmapChanged = false;

    try {
        const ghCmd = getGhCmd();
        if (!ghCmd) {
            log("gh CLI no encontrado — omitiendo verificación de PRs/issues");
        }

        // 1. Leer estado actual
        const plan = readJson(SPRINT_PLAN_FILE);
        const roadmap = readJson(ROADMAP_FILE);

        if (!plan) {
            log("sprint-plan.json no encontrado — abortando");
            return { skipped: true, reason: "no sprint-plan" };
        }

        // 2. Reconciliar sprint-plan vs GitHub (solo si hay gh)
        if (ghCmd) {
            const spChanges = reconcileSprintPlan(plan, ghCmd);
            allChanges.push(...spChanges);
            if (spChanges.length > 0) sprintPlanChanged = true;
        }

        // 3. Reconciliar roadmap ← sprint-plan
        if (roadmap) {
            const rmChanges = reconcileRoadmap(plan, roadmap);
            allChanges.push(...rmChanges);
            if (rmChanges.some(c => c.startsWith("roadmap:"))) roadmapChanged = true;
        }

        // 4. Persistir cambios
        if (sprintPlanChanged) {
            writeJson(SPRINT_PLAN_FILE, plan);
            log("sprint-plan.json actualizado (" + allChanges.filter(c => c.startsWith("sprint-plan:")).length + " cambios)");
        }

        if (roadmapChanged && roadmap) {
            writeJson(ROADMAP_FILE, roadmap);
            log("roadmap.json actualizado (" + allChanges.filter(c => c.startsWith("roadmap:")).length + " cambios)");
        }

        // 5. Actualizar estado (toca el archivo → invalida cache del dashboard)
        const syncState = {
            lastRun: Date.now(),
            lastRunIso: new Date().toISOString(),
            changes: allChanges,
            sprintId: plan && plan.sprint_id,
            sprintPlanChanged,
            roadmapChanged
        };
        updateState(syncState);

        // 6. Notificar via Telegram solo si hay cambios relevantes
        const realChanges = allChanges.filter(c => c.startsWith("sprint-plan:") || c.startsWith("roadmap:"));
        const alerts      = allChanges.filter(c => c.startsWith("alerta:"));

        if (realChanges.length > 0) {
            const lines = realChanges.slice(0, 8).map(c => "• " + c).join("\n");
            sendTelegram("🔄 <b>Sprint Sync</b> — " + realChanges.length + " corrección(es) automática(s):\n" + lines);
            log("Telegram: " + realChanges.length + " cambios notificados");
        }

        if (alerts.length > 0) {
            const alertLines = alerts.map(c => "⚠️ " + c.replace("alerta: ", "")).join("\n");
            sendTelegram("⚠️ <b>Sprint Sync — Alerta</b>:\n" + alertLines + "\n\nSe requiere revisión manual.");
            log("Telegram: " + alerts.length + " alertas de desincronización");
        }

        if (!silent && realChanges.length === 0 && alerts.length === 0) {
            log("Sin desincronizaciones detectadas — todo coherente");
        }

        return { ok: true, changes: allChanges };

    } catch (e) {
        log("Error en runSync: " + e.message + "\n" + (e.stack || ""));
        return { ok: false, error: e.message };
    } finally {
        releaseLock();
    }
}

// ─── syncRoadmapOnly: actualiza roadmap sin llamadas a GitHub ─────────────────

/**
 * Actualiza roadmap.json a partir del estado actual de sprint-plan.json.
 * No realiza llamadas a GitHub — solo sincronización local.
 * Útil para llamar inmediatamente después de modificar sprint-plan.json.
 * @param {object} [planOverride] - Si se pasa, usa este plan en lugar de leer el archivo
 */
function syncRoadmapOnly(planOverride) {
    try {
        const plan = planOverride || readJson(SPRINT_PLAN_FILE);
        const roadmap = readJson(ROADMAP_FILE);

        if (!plan || !roadmap) return;

        const changes = reconcileRoadmap(plan, roadmap);
        const realChanges = changes.filter(c => c.startsWith("roadmap:"));

        if (realChanges.length > 0) {
            writeJson(ROADMAP_FILE, roadmap);
            log("syncRoadmapOnly: roadmap.json actualizado (" + realChanges.length + " cambios)");
        }
    } catch (e) {
        log("syncRoadmapOnly error: " + e.message);
    }
}

// ─── Ejecución directa (CLI) ──────────────────────────────────────────────────

if (require.main === module) {
    const force = process.argv.includes("--force");
    runSync({ force, silent: false }).then(result => {
        if (result.skipped) {
            log("Ejecución omitida: " + (result.reason || "throttle"));
            process.exit(0);
        }
        if (!result.ok) {
            process.exit(1);
        }
        process.exit(0);
    }).catch(e => {
        log("Error fatal: " + e.message);
        process.exit(1);
    });
} else {
    // Hook PostToolUse: leer stdin y ejecutar con throttle
    let input = "";
    let done = false;
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", c => { if (!done) input += c; });
    process.stdin.on("end", () => {
        if (done) return;
        done = true;
        runSync({ force: false, silent: true }).catch(e => {
            log("Error en hook PostToolUse: " + e.message);
        });
    });
    process.stdin.on("error", () => {
        if (!done) { done = true; runSync({ force: false, silent: true }).catch(() => {}); }
    });
    setTimeout(() => {
        if (!done) {
            done = true;
            try { process.stdin.destroy(); } catch (e) {}
            runSync({ force: false, silent: true }).catch(() => {});
        }
    }, 2000);
}

module.exports = { runSync, syncRoadmapOnly, archiveSprintMetrics };
