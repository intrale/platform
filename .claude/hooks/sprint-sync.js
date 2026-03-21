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

        // Skip stories already terminal (done/failed/moved)
        if (story.status === "done" || story.status === "failed" || story.status === "moved") continue;

        // For planned stories: check if issue was closed in GitHub (completed outside sprint flow)
        if (story.status === "planned") {
            try {
                var issueStateCmd = "\"" + ghCmd + "\" issue view " + story.issue + " --repo intrale/platform --json state --jq '.state'";
                var issueState2 = execSync(issueStateCmd, { encoding: "utf8", timeout: 5000, windowsHide: true }).trim();
                if (issueState2 === "CLOSED") {
                    story.status = "done";
                    if (!story.agent) story.agent = {};
                    story.agent.completed_at = new Date().toISOString();
                    story.agent.result = "ok";
                    changes.push("roadmap: #" + story.issue + " planned -> done (issue cerrado en GitHub)");
                    log("Auto-healed #" + story.issue + " -> done (CLOSED while planned)");
                }
            } catch (e) { /* skip on error */ }
            continue;
        }

        if (story.status !== "in_progress") continue;

        // Auto-heal: stories in_progress sin agent metadata (bug: agent-concurrency-check no las pobló)
        if (!story.agent) {
            log("WARN: Story #" + story.issue + " in_progress SIN campo agent — auto-healing");
            story.agent = { launched_at: null, pid: null, completed_at: null, result: null };
        }

        // Auto-heal: deducir slug del issue number si falta
        if (!story.slug) {
            log("WARN: Story #" + story.issue + " in_progress SIN slug — buscando branch en GitHub");
            try {
                var branchCmd = "\"" + ghCmd + "\" pr list --repo intrale/platform --search \"" + story.issue + "\" --state all --json headRefName --limit 5";
                var branchOut = execSync(branchCmd, { encoding: "utf8", timeout: 10000, windowsHide: true });
                var branchPrs = JSON.parse(branchOut || "[]");
                var match = branchPrs.find(function(p) { return p.headRefName && p.headRefName.indexOf("/" + story.issue + "-") !== -1; });
                if (match) {
                    var slugMatch = match.headRefName.match(/\/\d+-(.+)$/);
                    if (slugMatch) {
                        story.slug = slugMatch[1];
                        log("Auto-healed slug for #" + story.issue + ": " + story.slug);
                        changes.push("auto-heal: #" + story.issue + " slug=" + story.slug);
                    }
                }
            } catch (e) { log("WARN: No se pudo deducir slug para #" + story.issue + ": " + e.message); }

            // Si no encontramos slug, verificar issue state en GitHub para decidir status
            if (!story.slug) {
                try {
                    var issueCmd = "\"" + ghCmd + "\" issue view " + story.issue + " --repo intrale/platform --json state,labels --jq '.state'";
                    var issueState = execSync(issueCmd, { encoding: "utf8", timeout: 5000, windowsHide: true }).trim();
                    if (issueState === "CLOSED") {
                        story.status = "done";
                        story.agent.completed_at = new Date().toISOString();
                        story.agent.result = "ok";
                        changes.push("auto-heal: #" + story.issue + " in_progress -> done (issue cerrado en GitHub)");
                        log("Auto-healed #" + story.issue + " -> done (issue CLOSED)");
                    } else {
                        // Issue abierto, sin slug, sin branch — marcar como planned (no hay agente)
                        story.status = "planned";
                        story.agent = null;
                        changes.push("auto-heal: #" + story.issue + " in_progress -> planned (sin agente ni branch)");
                        log("Auto-healed #" + story.issue + " -> planned (sin agente activo)");
                    }
                } catch (e) { log("WARN: No se pudo verificar issue #" + story.issue + ": " + e.message); }
                continue;
            }
        }

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
        
        // Generar snapshot de sprint con métricas agregadas (#1716)
        var aggregated = {
            sprint_id: sprintId,
            snapshot_at: new Date().toISOString(),
            total_sessions: sprintSessions.length,
            summary: {
                total_duration_min: 0,
                total_tokens_input: 0,
                total_tokens_output: 0,
                total_cost_usd: 0.0,
                total_tool_calls: 0,
                total_modified_files: 0,
                total_tasks_created: 0,
                total_tasks_completed: 0,
                success_rate: 0.0
            },
            sessions_by_agent: {},
            skills_breakdown: {}
        };
        
        // Agregar métricas desde sesiones
        sprintSessions.forEach(function(s) {
            aggregated.summary.total_duration_min += (s.duration_min || 0);
            aggregated.summary.total_tokens_input += (s.tokens_input || 0);
            aggregated.summary.total_tokens_output += (s.tokens_output || 0);
            aggregated.summary.total_tool_calls += (s.total_tool_calls || 0);
            aggregated.summary.total_modified_files += (s.modified_files_count || 0);
            aggregated.summary.total_tasks_created += (s.tasks_created || 0);
            aggregated.summary.total_tasks_completed += (s.tasks_completed || 0);
            var agentName = s.agent_name || "Unknown";
            if (!aggregated.sessions_by_agent[agentName]) {
                aggregated.sessions_by_agent[agentName] = { count: 0, duration_min: 0, tokens_input: 0, tokens_output: 0, tool_calls: 0, skills: [] };
            }
            aggregated.sessions_by_agent[agentName].count++;
            aggregated.sessions_by_agent[agentName].duration_min += (s.duration_min || 0);
            aggregated.sessions_by_agent[agentName].tokens_input += (s.tokens_input || 0);
            aggregated.sessions_by_agent[agentName].tokens_output += (s.tokens_output || 0);
            aggregated.sessions_by_agent[agentName].tool_calls += (s.total_tool_calls || 0);
            if (Array.isArray(s.skills_invoked)) {
                s.skills_invoked.forEach(function(sk) {
                    if (!aggregated.skills_breakdown[sk]) aggregated.skills_breakdown[sk] = { count: 0, duration_min: 0 };
                    aggregated.skills_breakdown[sk].count++;
                    aggregated.skills_breakdown[sk].duration_min += (s.duration_min || 0);
                });
            }
        });
        if (aggregated.summary.total_sessions > 0) {
            var successCount = sprintSessions.filter(function(s) { return (s.tasks_created || 0) > 0 && s.tasks_created === s.tasks_completed; }).length;
            aggregated.summary.success_rate = (successCount / aggregated.summary.total_sessions * 100).toFixed(1);
        }
        
        // Guardar snapshot a docs/sprints/SPR-NNN-metrics.json
        try {
            var snapshotDir = path.join(REPO_ROOT, "docs", "sprints");
            if (!fs.existsSync(snapshotDir)) fs.mkdirSync(snapshotDir, { recursive: true });
            var snapshotFile = path.join(snapshotDir, sprintId + "-metrics.json");
            fs.writeFileSync(snapshotFile, JSON.stringify(aggregated, null, 2) + "\n", "utf8");
        } catch (sse) { /* ignorar errores al guardar snapshot */ }
        return { ok: true, archiveFile: archiveFile, sessionsArchived: sprintSessions.length };
    } catch (e) { return { ok: false, message: e.message }; }
}

// --- Forward-sync: preservar _pid y _launched_at de agentes activos ---

function saveAgentPidState() {
    var saved = {};
    try {
        var plan = JSON.parse(fs.readFileSync(sprintData.SPRINT_PLAN_FILE, "utf8"));
        if (plan && Array.isArray(plan.agentes)) {
            plan.agentes.forEach(function(ag) {
                if (ag._pid || ag._launched_at) {
                    saved[ag.issue] = { _pid: ag._pid, _launched_at: ag._launched_at, status: ag.status };
                }
            });
        }
    } catch (e) { /* sprint-plan.json may not exist yet */ }
    return saved;
}

function restoreAgentPidState(saved) {
    if (!saved || Object.keys(saved).length === 0) return;
    try {
        var plan = JSON.parse(fs.readFileSync(sprintData.SPRINT_PLAN_FILE, "utf8"));
        var restored = 0;
        (plan.agentes || []).forEach(function(ag) {
            var s = saved[ag.issue];
            if (s) {
                if (s._pid) ag._pid = s._pid;
                if (s._launched_at) ag._launched_at = s._launched_at;
                if (s.status) ag.status = s.status;
                restored++;
            }
        });
        if (restored > 0) {
            // #1736: escribir al roadmap, regenera cache automáticamente
            sprintData.saveRoadmapFromPlan(plan, "sprint-sync-fwd");
            log("Forward-sync: restaurados _pid/_launched_at de " + restored + " agente(s)");
        }
    } catch (e) { log("Forward-sync restore error: " + e.message); }
}

// --- runSync: funcion principal ---

async function runSync(opts) {
    var force = opts && opts.force;
    var silent = opts && opts.silent;

    if (!shouldRun(force)) return { skipped: true };
    if (!acquireLock()) return { skipped: true, reason: "lock" };

    

    // Si sprint-plan.json no existe, regenerar desde roadmap antes de sincronizar (#1651)
    if (!fs.existsSync(sprintData.SPRINT_PLAN_FILE)) {
        var rmForRegen = sprintData.readRoadmap();
        if (rmForRegen) {
            sprintData.generateSprintPlanCache(rmForRegen);
            log("sprint-plan.json regenerado desde roadmap (no existia)");
        }
    }

    log("Iniciando reconciliacion" + (force ? " (forzada)" : ""));

    var allChanges = [];
    // Forward-sync: capturar _pid/_launched_at ANTES de cualquier regeneracion
    var savedPidState = saveAgentPidState();

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
            sprintData.writeRoadmap(roadmap, "sprint-sync"); // Esto tambien regenera sprint-plan.json
            restoreAgentPidState(savedPidState);
            log("roadmap.json actualizado (" + realChanges.length + " cambios)");
        } else {
            // Regenerar sprint-plan.json por si acaso (sin tocar roadmap)
            sprintData.generateSprintPlanCache(roadmap);
            restoreAgentPidState(savedPidState);
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

        // 6. Auto-detect sprint completion: all stories terminal (done/failed/moved)
        var freshSprint = sprintData.getActiveSprint(roadmap);
        if (freshSprint && Array.isArray(freshSprint.stories) && freshSprint.stories.length > 0) {
            var terminalStatuses = { done: true, failed: true, moved: true };
            var allTerminal = freshSprint.stories.every(function(s) { return terminalStatuses[s.status]; });
            var doneCount = freshSprint.stories.filter(function(s) { return s.status === "done"; }).length;
            var totalCount = freshSprint.stories.length;

            if (allTerminal) {
                log("Sprint " + freshSprint.id + " COMPLETO: " + doneCount + "/" + totalCount + " done — cerrando automaticamente");

                // Mark sprint as done in roadmap
                freshSprint.status = "done";
                freshSprint.closed_at = new Date().toISOString().replace(/\.\d+Z$/, "Z");
                freshSprint.velocity = doneCount;
                sprintData.writeRoadmap(roadmap, "sprint-sync (auto-close)");

                // #1734: archivar sesiones del sprint en sessions-archive/SPR-NNN/
                var sprintIssueNums = (freshSprint.stories || []).map(function(s) { return s.issue || s.number; }).filter(Boolean);
                archiveSprintSessions(freshSprint.id, sprintIssueNums);
                restoreAgentPidState(savedPidState);

                // Generate sprint report PDF + send to Telegram
                var reportScript = path.join(__dirname, "..", "..", "scripts", "sprint-report.js");
                var planFile = path.join(__dirname, "..", "..", "scripts", "sprint-plan.json");
                if (fs.existsSync(reportScript)) {
                    try {
                        execSync('node "' + reportScript + '" "' + planFile + '"', {
                            cwd: path.join(__dirname, "..", ".."), timeout: 60000, windowsHide: true
                        });
                        log("Reporte de sprint generado y enviado");
                    } catch (e) {
                        log("Error generando reporte de sprint: " + e.message);
                    }
                }

                sendTelegram(
                    "\ud83c\udfc1 <b>Sprint " + freshSprint.id + " FINALIZADO</b>\n\n" +
                    "\u2705 Completados: " + doneCount + "/" + totalCount + "\n" +
                    "Velocity: " + doneCount + "\n\n" +
                    "Roadmap actualizado automaticamente."
                );

                allChanges.push("roadmap: sprint " + freshSprint.id + " cerrado automaticamente (all terminal)");
            }
        }

        return { ok: true, changes: allChanges };

    } catch (e) {
        log("Error en runSync: " + e.message + "\n" + (e.stack || ""));
        return { ok: false, error: e.message };
    } finally {
        releaseLock();
    }
}


// --- Archivar sesiones del sprint al cerrar (#1734) ---
// Mueve sesiones del sprint desde sessions/ a sessions-archive/SPR-NNN/
function archiveSprintSessions(sprintId, sprintIssueNumbers) {
    try {
        if (!sprintId) return { ok: false, reason: "sin sprintId" };
        var REPO_ROOT = sprintData.REPO_ROOT;
        var archiveDir = path.join(REPO_ROOT, ".claude", "sessions-archive", sprintId);
        var issueSet = new Set((sprintIssueNumbers || []).map(String));
        var moved = 0;
        var errors = 0;
        var sessionsDirs = [path.join(REPO_ROOT, ".claude", "sessions")];
        try {
            var parent = path.dirname(REPO_ROOT);
            var base = path.basename(REPO_ROOT);
            fs.readdirSync(parent).filter(function(d) {
                return d.startsWith(base + ".agent-") || d.startsWith(base + ".codex-");
            }).forEach(function(wt) {
                var wtDir = path.join(parent, wt, ".claude", "sessions");
                if (fs.existsSync(wtDir)) sessionsDirs.push(wtDir);
            });
        } catch(e) {}
        for (var i = 0; i < sessionsDirs.length; i++) {
            var sessDir = sessionsDirs[i];
            if (!fs.existsSync(sessDir)) continue;
            var files;
            try { files = fs.readdirSync(sessDir).filter(function(f) { return f.endsWith(".json"); }); }
            catch(e) { continue; }
            for (var j = 0; j < files.length; j++) {
                var sFile = files[j];
                var sPath = path.join(sessDir, sFile);
                try {
                    var sess = JSON.parse(fs.readFileSync(sPath, "utf8"));
                    var bmParts = (sess.branch || "").split("/"); var bm = (bmParts.length >= 2 && ["agent","feature","bugfix"].indexOf(bmParts[0]) >= 0) ? bmParts : null;
                    if (!((sess.sprint_id === sprintId) || (bm && issueSet.has(bm[1].split("-")[0])))) continue;
                    if (!fs.existsSync(archiveDir)) fs.mkdirSync(archiveDir, { recursive: true });
                    var dest = path.join(archiveDir, sFile);
                    if (!fs.existsSync(dest)) fs.copyFileSync(sPath, dest);
                    fs.unlinkSync(sPath);
                    moved++;
                } catch(e) { errors++; }
            }
        }
        log("archiveSprintSessions " + sprintId + ": " + moved + " sesiones archivadas, " + errors + " errores");
        return { ok: true, moved: moved, errors: errors };
    } catch(e) {
        log("archiveSprintSessions error: " + e.message);
        return { ok: false, error: e.message };
    }
}
// --- syncRoadmapOnly: backward-compat (ahora regenera sprint-plan.json desde roadmap) ---

function syncRoadmapOnly(planOverride) {
    try {
        var saved = saveAgentPidState();
        var roadmap = sprintData.readRoadmap();
        if (roadmap) {
            sprintData.generateSprintPlanCache(roadmap);
            restoreAgentPidState(saved);
        }
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
