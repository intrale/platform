// sprint-sync.js v2 — Reconciliación: roadmap.json (fuente unica) vs GitHub
// Issue #1417, #1660: roadmap.json es la UNICA fuente de verdad.
// sprint-plan.json se genera como cache backward-compat.
//
// Responsabilidades:
//   a) Stories in_progress con PR mergeada -> marcar done en roadmap
//   b) Stories in_progress con PR cerrada sin merge -> marcar failed
//   c) Stories in_progress sin PR + agente muerto -> alerta
//   d) Dashboard freshness + Telegram alerts
//   e) Generar sprint-plan.json (backward-compat)
//
// Throttle: max 1 ejecucion cada 2 minutos (salvo --force)
// Pure Node.js
"use strict";

const fs   = require("fs");
const path = require("path");
const https = require("https");
const { execSync } = require("child_process");

// Sprint-data: fuente de verdad centralizada (#1660)
// Cuando se ejecuta desde hooks/, sprint-data esta en el mismo dir o en scripts/
var sprintData;
try { sprintData = require("./sprint-data"); } catch (e) {
    sprintData = require(path.join(__dirname, "..", "..", "scripts", "sprint-data"));
}

// Validacion centralizada de completacion (#1458)
var checkPRStatusViaGh;
try { checkPRStatusViaGh = require("./validation-utils").checkPRStatusViaGh; } catch (e) {
    try { checkPRStatusViaGh = require(path.join(__dirname, "validation-utils")).checkPRStatusViaGh; } catch (e2) {
        checkPRStatusViaGh = function() { return "unknown"; };
    }
}

const HOOKS_DIR    = sprintData.HOOKS_DIR;
const LOG_FILE     = path.join(HOOKS_DIR, "hook-debug.log");
const STATE_FILE   = path.join(HOOKS_DIR, "sprint-sync-state.json");
const LOCK_FILE    = path.join(HOOKS_DIR, "sprint-sync.lock");
const TG_CONFIG_FILE = path.join(sprintData.REPO_ROOT, ".claude", "hooks", "telegram-config.json");
const WORKTREES_PARENT = path.dirname(sprintData.REPO_ROOT);
const REPO_BASE = path.basename(sprintData.REPO_ROOT);

const SYNC_INTERVAL_MS = 2 * 60 * 1000;
const LOCK_MAX_AGE_MS  = 60 * 1000;
const GRACE_PERIOD_MS  = 15 * 60 * 1000;

// --- PID check ---

function isAgentPidAlive(pid) {
    if (!pid) return false;
    try {
        const out = execSync(
            "tasklist /FI \"PID eq " + parseInt(pid, 10) + "\" /NH",
            { encoding: "utf8", timeout: 3000, windowsHide: true }
        );
        return out.indexOf("No tasks") === -1 && out.trim().length > 0;
    } catch (e) {
        try { process.kill(parseInt(pid, 10), 0); return true; } catch (ke) { return ke.code === "EPERM"; }
    }
}

// --- Logging ---

function log(msg) {
    try { fs.appendFileSync(LOG_FILE, "[" + new Date().toISOString() + "] sprint-sync: " + msg + "\n"); } catch (e) {}
}

// --- Lock & Throttle ---

function acquireLock() {
    try {
        if (fs.existsSync(LOCK_FILE)) {
            var lockTs = parseInt(fs.readFileSync(LOCK_FILE, "utf8").trim(), 10) || 0;
            if (Date.now() - lockTs < LOCK_MAX_AGE_MS) { log("Lock activo"); return false; }
        }
        fs.writeFileSync(LOCK_FILE, String(Date.now()), "utf8");
        return true;
    } catch (e) { return false; }
}

function releaseLock() { try { fs.unlinkSync(LOCK_FILE); } catch (e) {} }

function shouldRun(force) {
    if (force) return true;
    try {
        var state = sprintData.readJson(STATE_FILE) || {};
        if (Date.now() - (state.lastRun || 0) < SYNC_INTERVAL_MS) return false;
    } catch (e) {}
    return true;
}

function updateState(info) {
    try {
        var state = sprintData.readJson(STATE_FILE) || {};
        state.lastRun = Date.now();
        state.lastRunIso = new Date().toISOString();
        if (info) Object.assign(state, info);
        sprintData.writeJson(STATE_FILE, state);
    } catch (e) {}
}

// --- GitHub utils ---

function getGhCmd() {
    var candidates = ["C:\\Workspaces\\gh-cli\\bin\\gh.exe", "gh"];
    for (var i = 0; i < candidates.length; i++) {
        try {
            execSync("\"" + candidates[i] + "\" --version", { encoding: "utf8", timeout: 3000, windowsHide: true });
            return candidates[i];
        } catch (e) {}
    }
    return null;
}

function checkPRStatus(branch, ghCmd) {
    if (!ghCmd) return "unknown";
    try {
        var cmd = "\"" + ghCmd + "\" pr list --repo intrale/platform --head \"" + branch + "\" --state all --json number,state";
        var out = execSync(cmd, { encoding: "utf8", timeout: 15000, windowsHide: true });
        var prs = JSON.parse(out || "[]");
        if (!Array.isArray(prs) || prs.length === 0) return "none";
        if (prs.find(function(pr) { return pr.state === "MERGED"; })) return "merged";
        if (prs.find(function(pr) { return pr.state === "OPEN"; })) return "open";
        return "closed_no_merge";
    } catch (e) { return "unknown"; }
}

function getMergedPRTimestamp(branch, ghCmd) {
    if (!ghCmd) return null;
    try {
        var cmd = "\"" + ghCmd + "\" pr list --repo intrale/platform --head \"" + branch + "\" --state merged --json mergedAt";
        var out = execSync(cmd, { encoding: "utf8", timeout: 10000, windowsHide: true });
        var prs = JSON.parse(out || "[]");
        if (Array.isArray(prs) && prs.length > 0 && prs[0].mergedAt) return new Date(prs[0].mergedAt).getTime();
    } catch (e) {}
    return null;
}

function getMergedPRNumber(branch, ghCmd) {
    if (!ghCmd) return null;
    try {
        var cmd = "\"" + ghCmd + "\" pr list --repo intrale/platform --head \"" + branch + "\" --state merged --json number";
        var out = execSync(cmd, { encoding: "utf8", timeout: 10000, windowsHide: true });
        var prs = JSON.parse(out || "[]");
        if (Array.isArray(prs) && prs.length > 0) return prs[0].number;
    } catch (e) {}
    return null;
}

// --- Telegram ---

function sendTelegram(message) {
    try {
        var cfg = sprintData.readJson(TG_CONFIG_FILE);
        if (!cfg || !cfg.bot_token || !cfg.chat_id) return;
        var postData = JSON.stringify({ chat_id: cfg.chat_id, text: message, parse_mode: "HTML", disable_notification: false });
        var req = https.request({
            hostname: "api.telegram.org",
            path: "/bot" + cfg.bot_token + "/sendMessage",
            method: "POST",
            headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(postData) },
            timeout: 8000
        }, function(res) { var d = ""; res.on("data", function(c) { d += c; }); });
        req.on("error", function() {});
        req.write(postData);
        req.end();
    } catch (e) {}
}

// --- Reconciliacion: roadmap stories vs GitHub ---

function reconcileRoadmapVsGithub(roadmap, ghCmd) {
    var changes = [];
    var sprint = sprintData.getActiveSprint(roadmap);
    if (!sprint || !Array.isArray(sprint.stories)) return changes;

    var nowMs = Date.now();
    var now = new Date().toISOString();

    for (var i = 0; i < sprint.stories.length; i++) {
        var story = sprint.stories[i];

        // Solo procesar stories in_progress con agent info
        if (story.status !== "in_progress" || !story.agent || !story.slug) continue;

        // Grace period: no tocar agentes lanzados hace menos de 15 min
        var launchedAt = story.agent.launched_at ? new Date(story.agent.launched_at).getTime() : 0;
        if (launchedAt && (nowMs - launchedAt) < GRACE_PERIOD_MS) {
            log("Story #" + story.issue + " en grace period — skip");
            continue;
        }

        var branch = sprintData.getStoryBranch(story);
        var prStatus = checkPRStatus(branch, ghCmd);
        log("Story #" + story.issue + " branch=" + branch + " PR=" + prStatus);

        if (prStatus === "merged") {
            // Verificar que PR fue mergeada DESPUES del lanzamiento
            var prMergedAt = getMergedPRTimestamp(branch, ghCmd);
            if (launchedAt && prMergedAt && prMergedAt < launchedAt) {
                log("Story #" + story.issue + " — PR mergeada ANTES del lanzamiento — skip");
                continue;
            }

            var prNum = getMergedPRNumber(branch, ghCmd);
            story.status = "done";
            story.agent.completed_at = now;
            story.agent.result = "ok";
            story.agent.pr = prNum;
            changes.push("roadmap: #" + story.issue + " in_progress -> done (PR mergeada)");

        } else if (prStatus === "closed_no_merge") {
            var pidAlive = isAgentPidAlive(story.agent.pid);
            if (pidAlive) { log("Story #" + story.issue + " — PR cerrada pero PID vivo — skip"); continue; }

            story.status = "failed";
            story.agent.completed_at = now;
            story.agent.result = "failed";
            story.agent.failure_reason = "PR cerrada sin merge";
            changes.push("roadmap: #" + story.issue + " in_progress -> failed (PR cerrada sin merge)");

        } else if (prStatus === "none") {
            var pidAlive2 = isAgentPidAlive(story.agent.pid);
            if (pidAlive2) { log("Story #" + story.issue + " — sin PR pero PID vivo — skip"); continue; }

            // Agente muerto sin PR = zombie
            var wtPath = path.join(WORKTREES_PARENT, REPO_BASE + ".agent-" + story.issue + "-" + story.slug);
            if (!fs.existsSync(wtPath)) {
                changes.push("alerta: #" + story.issue + " agente muerto sin PR ni worktree");
            }
        }
    }

    return changes;
}

// --- Metrics archive (kept for backward compat) ---

var AGENT_METRICS_FILE  = path.join(HOOKS_DIR, "agent-metrics.json");
var METRICS_ARCHIVE_DIR = path.join(HOOKS_DIR, "metrics-archive");

function archiveSprintMetrics(sprintId, velocity) {
    try {
        if (!fs.existsSync(METRICS_ARCHIVE_DIR)) fs.mkdirSync(METRICS_ARCHIVE_DIR, { recursive: true });
        var archiveFile = path.join(METRICS_ARCHIVE_DIR, "agent-metrics-" + sprintId + ".json");
        if (fs.existsSync(archiveFile)) return { ok: true, message: "ya archivado" };
        var metricsData = sprintData.readJson(AGENT_METRICS_FILE);
        if (!metricsData || !Array.isArray(metricsData.sessions)) return { ok: false, message: "sin datos" };
        var sprintSessions = metricsData.sessions.filter(function(s) { return s.sprint_id === sprintId; });
        var payload = { sprint_id: sprintId, archived_at: new Date().toISOString(), velocity: velocity || 0, sessions: sprintSessions };
        sprintData.writeJson(archiveFile, payload);
        return { ok: true, archiveFile: archiveFile, sessionsArchived: sprintSessions.length };
    } catch (e) { return { ok: false, message: e.message }; }
}

// --- runSync: funcion principal ---

async function runSync(opts) {
    var force = opts && opts.force;
    var silent = opts && opts.silent;

    if (!shouldRun(force)) return { skipped: true };
    if (!acquireLock()) return { skipped: true, reason: "lock" };

    log("Iniciando reconciliacion" + (force ? " (forzada)" : ""));

    var allChanges = [];

    try {
        var ghCmd = getGhCmd();
        if (!ghCmd) log("gh CLI no encontrado — omitiendo verificacion de PRs");

        // 1. Leer roadmap (fuente unica de verdad)
        var roadmap = sprintData.readRoadmap();
        if (!roadmap) { log("roadmap.json no encontrado — abortando"); return { skipped: true, reason: "no roadmap" }; }

        var sprint = sprintData.getActiveSprint(roadmap);
        if (!sprint) { log("Sin sprint activo — nada que sincronizar"); return { skipped: true, reason: "no active sprint" }; }

        // 1b. Reverse-sync: propagar cambios de hooks viejos (sprint-plan.json -> roadmap)
        // Los hooks que aun escriben a sprint-plan.json directamente necesitan que sus
        // cambios se propaguen al roadmap antes de regenerar el cache.
        var currentPlan = sprintData.readJson(sprintData.SPRINT_PLAN_FILE);
        if (currentPlan && currentPlan._generated_from !== "roadmap.json") {
            // sprint-plan.json fue modificado por un hook viejo (no tiene _generated_from)
            log("Reverse-sync: sprint-plan.json modificado por hook legacy — propagando al roadmap");
            var migrated = sprintData.migrateFromSprintPlan();
            if (migrated) {
                roadmap = migrated;
                sprint = sprintData.getActiveSprint(roadmap);
                allChanges.push("roadmap: reverse-sync desde sprint-plan.json legacy");
            }
        } else if (currentPlan && currentPlan._generated_from === "roadmap.json") {
            // Es nuestro cache — verificar si algun hook viejo lo modifico despues de la generacion
            var genAt = currentPlan._generated_at ? new Date(currentPlan._generated_at).getTime() : 0;
            try {
                var planStat = fs.statSync(sprintData.SPRINT_PLAN_FILE);
                var planMtime = planStat.mtimeMs || planStat.mtime.getTime();
                if (genAt > 0 && planMtime > genAt + 5000) {
                    // El archivo fue modificado despues de que lo generamos — reverse sync
                    log("Reverse-sync: sprint-plan.json cache modificado post-generacion — reimportando");
                    // Quitar el flag para que migrateFromSprintPlan lo procese
                    delete currentPlan._generated_from;
                    sprintData.writeJson(sprintData.SPRINT_PLAN_FILE, currentPlan);
                    var migrated2 = sprintData.migrateFromSprintPlan();
                    if (migrated2) {
                        roadmap = migrated2;
                        sprint = sprintData.getActiveSprint(roadmap);
                        allChanges.push("roadmap: reverse-sync desde sprint-plan.json modificado");
                    }
                }
            } catch (e) { log("Reverse-sync stat error: " + e.message); }
        }

        // 2. Reconciliar stories in_progress vs GitHub
        if (ghCmd) {
            var changes = reconcileRoadmapVsGithub(roadmap, ghCmd);
            allChanges.push.apply(allChanges, changes);
        }

        // 3. Persistir si hubo cambios
        var realChanges = allChanges.filter(function(c) { return c.indexOf("roadmap:") === 0; });
        if (realChanges.length > 0) {
            sprintData.writeRoadmap(roadmap); // Esto tambien regenera sprint-plan.json
            log("roadmap.json actualizado (" + realChanges.length + " cambios)");
        } else {
            // Regenerar sprint-plan.json por si acaso (sin tocar roadmap)
            sprintData.generateSprintPlanCache(roadmap);
        }

        // 4. Actualizar estado
        updateState({ changes: allChanges, sprintId: sprint.id, roadmapChanged: realChanges.length > 0 });

        // 5. Telegram
        if (realChanges.length > 0) {
            var lines = realChanges.slice(0, 8).map(function(c) { return "\u2022 " + c; }).join("\n");
            sendTelegram("\ud83d\udd04 <b>Sprint Sync</b> \u2014 " + realChanges.length + " correccion(es):\n" + lines);
        }
        var alerts = allChanges.filter(function(c) { return c.indexOf("alerta:") === 0; });
        if (alerts.length > 0) {
            var alertLines = alerts.map(function(c) { return "\u26a0\ufe0f " + c.replace("alerta: ", ""); }).join("\n");
            sendTelegram("\u26a0\ufe0f <b>Sprint Sync \u2014 Alerta</b>:\n" + alertLines);
        }

        return { ok: true, changes: allChanges };

    } catch (e) {
        log("Error en runSync: " + e.message + "\n" + (e.stack || ""));
        return { ok: false, error: e.message };
    } finally {
        releaseLock();
    }
}

// --- syncRoadmapOnly: backward-compat (ahora regenera sprint-plan.json desde roadmap) ---

function syncRoadmapOnly(planOverride) {
    try {
        var roadmap = sprintData.readRoadmap();
        if (roadmap) sprintData.generateSprintPlanCache(roadmap);
    } catch (e) { log("syncRoadmapOnly error: " + e.message); }
}

// --- Ejecucion directa (CLI) ---

if (require.main === module) {
    var force = process.argv.includes("--force");
    runSync({ force: force, silent: false }).then(function(result) {
        if (result.skipped) { process.exit(0); }
        if (!result.ok) { process.exit(1); }
        process.exit(0);
    }).catch(function(e) { log("Error fatal: " + e.message); process.exit(1); });
} else {
    // Hook PostToolUse
    var input = "";
    var done = false;
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", function(c) { if (!done) input += c; });
    process.stdin.on("end", function() {
        if (done) return; done = true;
        runSync({ force: false, silent: true }).catch(function(e) { log("Error en hook: " + e.message); });
    });
    process.stdin.on("error", function() {
        if (!done) { done = true; runSync({ force: false, silent: true }).catch(function() {}); }
    });
    setTimeout(function() {
        if (!done) { done = true; try { process.stdin.destroy(); } catch (e) {}
            runSync({ force: false, silent: true }).catch(function() {}); }
    }, 2000);
}

module.exports = { runSync: runSync, syncRoadmapOnly: syncRoadmapOnly, archiveSprintMetrics: archiveSprintMetrics };
