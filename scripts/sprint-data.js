// sprint-data.js - Fuente de verdad unica: roadmap.json (#1660)
// Pure Node.js - sin dependencias externas
"use strict";

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

function resolveMainRepoRoot() {
    const envRoot = process.env.CLAUDE_PROJECT_DIR || "C:\\Workspaces\\Intrale\\platform";
    try {
        const out = execSync("git worktree list", { encoding: "utf8", cwd: envRoot, timeout: 5000, windowsHide: true });
        const m = out.split("\n")[0].match(/^(.+?)\s+[0-9a-f]{5,}/);
        if (m) return m[1].trim().replace(/\\/g, "/");
    } catch (e) {}
    return envRoot.replace(/\\/g, "/");
}

const REPO_ROOT = resolveMainRepoRoot();
const SCRIPTS_DIR = path.join(REPO_ROOT, "scripts");
const HOOKS_DIR = path.join(REPO_ROOT, ".claude", "hooks");
const ROADMAP_FILE = path.join(SCRIPTS_DIR, "roadmap.json");
const SPRINT_PLAN_FILE = path.join(SCRIPTS_DIR, "sprint-plan.json");
const LOG_FILE = path.join(HOOKS_DIR, "hook-debug.log");
const LOCK_FILE = ROADMAP_FILE + ".lock";
const LOCK_STALE_MS = 30000; // lock expira despues de 30s (proceso muerto)
const LOCK_RETRY_MS = 100;   // espera entre reintentos
const LOCK_TIMEOUT_MS = 10000; // maximo tiempo esperando lock

function log(msg) {
    try { fs.appendFileSync(LOG_FILE, "[" + new Date().toISOString() + "] sprint-data: " + msg + "\n"); } catch (e) {}
}

function readJson(p) {
    try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch (e) { return null; }
}

function writeJson(p, o) {
    fs.writeFileSync(p, JSON.stringify(o, null, 2) + "\n", "utf8");
}

// --- File lock para escritura serializada de roadmap.json ---

function acquireLock(caller) {
    var start = Date.now();
    while (true) {
        try {
            // O_EXCL falla si el archivo ya existe (atomic create)
            var fd = fs.openSync(LOCK_FILE, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY);
            var lockData = JSON.stringify({ pid: process.pid, caller: caller || "unknown", ts: new Date().toISOString() });
            fs.writeSync(fd, lockData);
            fs.closeSync(fd);
            return true;
        } catch (e) {
            if (e.code !== "EEXIST") { log("lock error: " + e.message); return false; }
            // Lock existe — verificar si es stale
            try {
                var stat = fs.statSync(LOCK_FILE);
                if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
                    var staleInfo = "";
                    try { staleInfo = fs.readFileSync(LOCK_FILE, "utf8"); } catch (e2) {}
                    log("lock stale detectado (" + staleInfo + "), removiendo");
                    try { fs.unlinkSync(LOCK_FILE); } catch (e2) {}
                    continue; // reintentar inmediatamente
                }
            } catch (e2) {
                // stat fallo = lock desaparecio, reintentar
                continue;
            }
            // Lock es valido — esperar
            if (Date.now() - start > LOCK_TIMEOUT_MS) {
                log("lock timeout despues de " + LOCK_TIMEOUT_MS + "ms (caller: " + caller + ")");
                return false;
            }
            // Busy-wait sincronico (hooks son sincronicos)
            var busyEnd = Date.now() + LOCK_RETRY_MS;
            while (Date.now() < busyEnd) {} // spin
        }
    }
}

function releaseLock() {
    try { fs.unlinkSync(LOCK_FILE); } catch (e) {}
}

// --- Validacion pre-write ---

var VALID_STORY_STATUSES = { planned: 1, in_progress: 1, done: 1, failed: 1 };
var VALID_SPRINT_STATUSES = { active: 1, planned: 1, done: 1 };

function validateRoadmap(rm) {
    var errors = [];
    if (!rm || !Array.isArray(rm.sprints)) {
        errors.push("roadmap sin array sprints");
        return errors;
    }
    var activeCount = 0;
    var allIssues = {};
    for (var i = 0; i < rm.sprints.length; i++) {
        var sp = rm.sprints[i];
        if (!sp.id) errors.push("sprint[" + i + "] sin id");
        if (!VALID_SPRINT_STATUSES[sp.status]) errors.push("sprint " + sp.id + " status invalido: " + sp.status);
        if (sp.status === "active") activeCount++;
        if (!Array.isArray(sp.stories)) continue;
        for (var j = 0; j < sp.stories.length; j++) {
            var st = sp.stories[j];
            if (!st.issue) { errors.push("sprint " + sp.id + " story[" + j + "] sin issue"); continue; }
            if (!VALID_STORY_STATUSES[st.status]) errors.push("story #" + st.issue + " status invalido: " + st.status);
            // Detectar stories duplicadas dentro del mismo sprint
            var key = sp.id + ":" + st.issue;
            if (allIssues[key]) errors.push("story #" + st.issue + " duplicada en sprint " + sp.id);
            allIssues[key] = true;
            // Detectar PIDs fantasma (in_progress con PID que ya no existe)
            if (st.status === "in_progress" && st.agent && st.agent.pid && !st.agent.waiting_since) {
                try {
                    execSync("tasklist /FI \"PID eq " + st.agent.pid + "\" /NH", { encoding: "utf8", timeout: 3000, windowsHide: true });
                } catch (e) {
                    // tasklist falla = PID no existe, marcar warning (no error bloqueante)
                    log("WARNING: story #" + st.issue + " PID " + st.agent.pid + " no encontrado");
                }
            }
        }
    }
    if (activeCount > 1) errors.push("hay " + activeCount + " sprints activos (maximo 1)");
    return errors;
}

function readRoadmap() { return readJson(ROADMAP_FILE); }

function writeRoadmap(rm, caller) {
    // 1. Validar antes de escribir
    var errors = validateRoadmap(rm);
    if (errors.length > 0) {
        log("VALIDACION FALLIDA (caller: " + (caller || "unknown") + "): " + errors.join("; "));
        // Errores criticos bloquean la escritura
        var critical = errors.filter(function (e) { return e.indexOf("sin array sprints") >= 0 || e.indexOf("sin id") >= 0; });
        if (critical.length > 0) {
            log("ESCRITURA BLOQUEADA por errores criticos");
            return false;
        }
        // Warnings se loguean pero no bloquean
    }
    // 2. Adquirir lock
    if (!acquireLock(caller)) {
        log("ESCRITURA ABORTADA: no se pudo adquirir lock (caller: " + (caller || "unknown") + ")");
        return false;
    }
    try {
        // 3. Re-leer y merge (read-modify-write atomico)
        rm.updated_ts = new Date().toISOString();
        rm.updated_by = caller || rm.updated_by || "unknown";
        // 4. Escribir a tmp + rename (atomic en NTFS)
        var tmpFile = ROADMAP_FILE + ".tmp." + process.pid;
        writeJson(tmpFile, rm);
        fs.renameSync(tmpFile, ROADMAP_FILE);
        // 5. Regenerar cache
        generateSprintPlanCache(rm);
        log("writeRoadmap OK (caller: " + (caller || "unknown") + ")");
        return true;
    } catch (e) {
        log("writeRoadmap ERROR: " + e.message);
        // Limpiar tmp si quedo
        try { fs.unlinkSync(ROADMAP_FILE + ".tmp." + process.pid); } catch (e2) {}
        return false;
    } finally {
        releaseLock();
    }
}

function getActiveSprint(rm) {
    var r = rm || readRoadmap();
    if (!r || !Array.isArray(r.sprints)) return null;
    return r.sprints.find(function (s) { return s.status === "active"; }) || null;
}

function findStory(sp, n) {
    if (!sp || !Array.isArray(sp.stories)) return null;
    return sp.stories.find(function (s) { return Number(s.issue) === Number(n); }) || null;
}

function updateStoryStatus(rm, sid, n, ns, au) {
    var sp = rm.sprints.find(function (s) { return s.id === sid; });
    if (!sp) return false;
    var st = findStory(sp, n);
    if (!st) return false;
    var old = st.status;
    st.status = ns;
    if (au) { if (!st.agent) st.agent = {}; Object.assign(st.agent, au); }
    if (old !== ns) log("Story #" + n + ": " + old + " -> " + ns);
    return true;
}

function getStoriesByStatus(sp, s) {
    if (!sp || !Array.isArray(sp.stories)) return [];
    return sp.stories.filter(function (x) { return x.status === s; });
}

function countActiveAgents(sp) {
    if (!sp || !Array.isArray(sp.stories)) return 0;
    return sp.stories.filter(function (s) {
        return s.status === "in_progress" && s.agent && s.agent.waiting_since == null;
    }).length;
}

function getNextInQueue(sp) {
    if (!sp || !Array.isArray(sp.stories)) return null;
    return sp.stories.find(function (s) { return s.status === "planned" && s.slug; }) || null;
}

function getStoryBranch(s) {
    if (!s || !s.slug) return null;
    return "agent/" + s.issue + "-" + s.slug;
}

function ensureExecution(sp) {
    if (!sp.execution) {
        sp.execution = { concurrency_limit: 3, pipeline_mode: "scripts", waiting_sweep_ts: null, sentinel_ts: null };
    }
    return sp.execution;
}

function getConcurrencyLimit(sp) {
    if (sp && sp.execution && sp.execution.concurrency_limit) return sp.execution.concurrency_limit;
    return 3;
}

// --- Backward-compat: generar sprint-plan.json desde roadmap.json ---

function generateSprintPlanCache(rm) {
    var sp = getActiveSprint(rm);
    if (!sp) return;
    var stories = sp.stories || [], exec = sp.execution || {};
    var agentes = [], _queue = [], _completed = [], _incomplete = [];

    for (var i = 0; i < stories.length; i++) {
        var story = stories[i];
        var entry = {
            issue: story.issue, slug: story.slug || null, titulo: story.title,
            stream: story.stream,
            size: story.effort === "simple" ? "S" : story.effort === "medio" ? "M" : "L"
        };

        if (story.status === "in_progress" && story.agent) {
            agentes.push(Object.assign({}, entry, {
                numero: i + 1, prompt: story.agent.prompt || "",
                status: story.agent.waiting_since ? "waiting" : "active",
                _promoted_at: story.agent.promoted_at || null,
                _launched_at: story.agent.launched_at || null,
                _pid: story.agent.pid || null,
                _retry_count: story.agent.retry_count || 0,
                waiting_since: story.agent.waiting_since || undefined,
                waiting_reason: story.agent.waiting_reason || undefined
            }));
        } else if (story.status === "planned" && story.slug) {
            _queue.push(Object.assign({}, entry, { numero: i + 1 }));
        } else if (story.status === "done" && story.agent) {
            _completed.push(Object.assign({}, entry, {
                numero: i + 1, resultado: story.agent.result || "ok",
                duracion_min: story.agent.duration_min || 0,
                completado_at: story.agent.completed_at || null,
                pr: story.agent.pr || null
            }));
        } else if (story.status === "failed" && story.agent) {
            _incomplete.push(Object.assign({}, entry, {
                numero: i + 1, resultado: "failed",
                duracion_min: story.agent.duration_min || 0,
                completado_at: story.agent.completed_at || null,
                detectado_por: story.agent.detected_by || null,
                motivo: story.agent.failure_reason || null,
                issue_reabierto: null
            }));
        }
    }

    var plan = {
        sprint_id: sp.id, size: sp.size, tema: sp.tema,
        estado: sp.status === "active" ? "activo" : sp.status,
        started_at: sp.started_at || "",
        concurrency_limit: exec.concurrency_limit || 3,
        pipeline_mode: exec.pipeline_mode || "scripts",
        total_stories: stories.length,
        agentes: agentes, _queue: _queue, _completed: _completed, _incomplete: _incomplete,
        _waiting_sweep_ts: exec.waiting_sweep_ts || null,
        _sentinel_ts: exec.sentinel_ts || null,
        _generated_from: "roadmap.json",
        _generated_at: new Date().toISOString()
    };
    try { writeJson(SPRINT_PLAN_FILE, plan); } catch (e) { log("Error generando sprint-plan.json: " + e.message); }
}

// --- Migration: importar sprint-plan.json existente al roadmap.json ---

function migrateFromSprintPlan() {
    var plan = readJson(SPRINT_PLAN_FILE), rm = readRoadmap();
    if (!plan || !rm) { log("migrate: no files"); return null; }
    if (plan._generated_from === "roadmap.json") return rm;
    log("migrate: " + plan.sprint_id);

    var sp = rm.sprints.find(function (s) { return s.id === plan.sprint_id; });
    if (!sp) {
        sp = {
            id: plan.sprint_id, tema: plan.tema || "", status: "active",
            size: plan.size || "medio",
            started_at: plan.started_at || new Date().toISOString(),
            stories: []
        };
        rm.sprints.unshift(sp);
    }

    // Desactivar otros sprints activos
    for (var i = 0; i < rm.sprints.length; i++) {
        var s = rm.sprints[i];
        if (s.id !== plan.sprint_id && s.status === "active") {
            s.status = (s.stories || []).every(function (st) { return st.status === "done"; }) ? "done" : "planned";
        }
    }
    sp.status = "active";
    sp.execution = {
        concurrency_limit: plan.concurrency_limit || 3,
        pipeline_mode: plan.pipeline_mode || "scripts",
        waiting_sweep_ts: plan._waiting_sweep_ts || null,
        sentinel_ts: plan._sentinel_ts || null
    };

    // Indexar stories existentes por issue number
    var ex = {};
    (sp.stories || []).forEach(function (st) { ex[Number(st.issue)] = st; });

    function goc(it) {
        var n = Number(it.issue);
        if (ex[n]) return ex[n];
        var ns = {
            issue: it.issue,
            title: it.titulo || "Issue #" + it.issue,
            effort: it.size === "S" ? "simple" : it.size === "M" ? "medio" : "grande",
            stream: it.stream || "E"
        };
        sp.stories.push(ns);
        ex[n] = ns;
        return ns;
    }

    // Procesar agentes activos
    (plan.agentes || []).forEach(function (ag) {
        var st = goc(ag);
        st.status = "in_progress";
        st.slug = ag.slug;
        st.agent = {
            prompt: ag.prompt || null, pid: ag._pid || null,
            promoted_at: ag._promoted_at || null, launched_at: ag._launched_at || null,
            completed_at: null, result: null, pr: null,
            retry_count: ag._retry_count || 0, duration_min: null,
            detected_by: null, failure_reason: null,
            waiting_since: ag.waiting_since || null, waiting_reason: ag.waiting_reason || null
        };
    });

    // Procesar queue
    (plan._queue || []).forEach(function (q) {
        var st = goc(q);
        if (st.status !== "done" && st.status !== "in_progress") st.status = "planned";
        st.slug = st.slug || q.slug;
    });

    // Procesar completed
    (plan._completed || []).forEach(function (c) {
        var st = goc(c);
        st.status = "done";
        st.slug = st.slug || c.slug;
        st.agent = {
            prompt: null, pid: null, promoted_at: null, launched_at: null,
            completed_at: c.completado_at || null, result: c.resultado || "ok",
            pr: c.pr || null, retry_count: 0, duration_min: c.duracion_min || 0,
            detected_by: c.sync_source || null, failure_reason: null,
            waiting_since: null, waiting_reason: null
        };
    });

    // Procesar incomplete (failed)
    (plan._incomplete || []).forEach(function (inc) {
        var st = goc(inc);
        st.status = "failed";
        st.slug = st.slug || inc.slug;
        st.agent = {
            prompt: null, pid: null, promoted_at: null, launched_at: null,
            completed_at: inc.completado_at || null, result: "failed",
            pr: null, retry_count: 0, duration_min: inc.duracion_min || 0,
            detected_by: inc.detectado_por || null, failure_reason: inc.motivo || null,
            waiting_since: null, waiting_reason: null
        };
    });

    rm.updated_ts = new Date().toISOString();
    rm.updated_by = "sprint-data-migration";
    return rm;
}

module.exports = {
    ROADMAP_FILE: ROADMAP_FILE, SPRINT_PLAN_FILE: SPRINT_PLAN_FILE,
    REPO_ROOT: REPO_ROOT, SCRIPTS_DIR: SCRIPTS_DIR, HOOKS_DIR: HOOKS_DIR,
    readRoadmap: readRoadmap, writeRoadmap: writeRoadmap, getActiveSprint: getActiveSprint,
    findStory: findStory, updateStoryStatus: updateStoryStatus,
    getStoriesByStatus: getStoriesByStatus, countActiveAgents: countActiveAgents,
    getNextInQueue: getNextInQueue, getStoryBranch: getStoryBranch,
    ensureExecution: ensureExecution, getConcurrencyLimit: getConcurrencyLimit,
    generateSprintPlanCache: generateSprintPlanCache, migrateFromSprintPlan: migrateFromSprintPlan,
    validateRoadmap: validateRoadmap, acquireLock: acquireLock, releaseLock: releaseLock,
    readJson: readJson, writeJson: writeJson, log: log
};
