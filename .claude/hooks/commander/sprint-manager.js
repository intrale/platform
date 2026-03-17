// commander/sprint-manager.js — Ejecución y monitoreo de sprints
// Responsabilidad: cargar plan, ejecutar agentes secuencialmente, monitor periódico
"use strict";

const fs = require("fs");
const http = require("http");

// ─── Constantes ──────────────────────────────────────────────────────────────
const SPRINT_MONITOR_INTERVAL_MS = 5 * 60 * 1000; // 5 minutos
const DASHBOARD_PORT = 3100;

// ─── Estado ──────────────────────────────────────────────────────────────────
let _tgApi = null;
let _cmdContext = null;
let _lockManager = null;
let _sessionManager = null;
let _log = console.log;
let _repoRoot = null;
let _sprintPlanFile = null;
let _skills = [];

let running = true;
let sprintRunning = false;
let sprintMonitorInterval = null;
let monitorBusy = false;
let sprintMonitorIntervalMs = SPRINT_MONITOR_INTERVAL_MS;
let sprintStartTime = null;

function init(config) {
    _tgApi = config.tgApi;
    _cmdContext = config.cmdContext;
    _lockManager = config.lockManager;
    _sessionManager = config.sessionManager;
    _log = config.log || console.log;
    _repoRoot = config.repoRoot;
    _sprintPlanFile = config.sprintPlanFile;
    _skills = config.skills || [];
}

function setRunning(val) { running = val; }
function isSprintRunning() { return sprintRunning; }
function getSprintMonitorIntervalMs() { return sprintMonitorIntervalMs; }
function setSkills(s) { _skills = s; }

// ─── Sprint plan ─────────────────────────────────────────────────────────────

function loadSprintPlan() {
    try {
        return JSON.parse(fs.readFileSync(_sprintPlanFile, "utf8"));
    } catch (e) {
        return null;
    }
}

function formatSprintProgress(agentes, currentIdx, results) {
    let msg = "";
    for (let i = 0; i < agentes.length; i++) {
        const a = agentes[i];
        let icon;
        if (results[i] === "success") icon = "☑";
        else if (results[i] === "failed") icon = "☒";
        else if (i === currentIdx) icon = "☐►";
        else icon = "☐";
        msg += icon + " <b>#" + a.numero + "</b> #" + a.issue + " " + _tgApi.escHtml(a.slug) + " [" + a.size + "]\n";
    }
    return msg;
}

// ─── Monitor periódico ──────────────────────────────────────────────────────

function stopSprintMonitor() {
    if (sprintMonitorInterval) {
        clearInterval(sprintMonitorInterval);
        sprintMonitorInterval = null;
        _log("Monitor periódico detenido");
    }
    monitorBusy = false;
}

function startSprintMonitor() {
    stopSprintMonitor();
    _log("Iniciando monitor periódico cada " + Math.round(sprintMonitorIntervalMs / 60000) + " min");

    sprintMonitorInterval = setInterval(async () => {
        if (monitorBusy) {
            _log("Monitor periódico: ejecución anterior aún en curso, omitiendo ciclo");
            return;
        }
        if (!running || !sprintRunning) {
            stopSprintMonitor();
            return;
        }

        monitorBusy = true;
        try {
            const elapsed = Math.round((Date.now() - sprintStartTime) / 1000);
            const elapsedMins = Math.floor(elapsed / 60);
            const elapsedSecs = elapsed % 60;

            _log("Monitor periódico: ejecutando /monitor");
            const result = await _cmdContext.executeClaudeQueued("/monitor", [
                "--allowedTools", "Bash,Read,Glob,Grep,TaskList",
                "--model", "claude-haiku-4-5-20251001"
            ]);

            if (!running || !sprintRunning) return;

            let monitorOutput = "";
            if (result.code === 0) {
                try {
                    const json = JSON.parse(result.stdout);
                    monitorOutput = json.result || json.text || json.content || result.stdout;
                } catch (e) {
                    monitorOutput = result.stdout;
                }
            } else {
                monitorOutput = "(error ejecutando monitor — exit " + result.code + ")";
            }

            const header = "📊 <b>Monitor — sprint en curso (" + elapsedMins + "m " + elapsedSecs + "s)</b>\n\n";
            await _tgApi.sendLongMessage(header + _tgApi.escHtml(monitorOutput));
        } catch (e) {
            _log("Monitor periódico: error — " + e.message);
        } finally {
            monitorBusy = false;
        }
    }, sprintMonitorIntervalMs);
}

// ─── Dashboard screenshot ────────────────────────────────────────────────────

function fetchDashboardScreenshot(width, height) {
    return new Promise((resolve) => {
        const req = http.get("http://localhost:" + DASHBOARD_PORT + "/screenshot?w=" + width + "&h=" + height, { timeout: 20000 }, (res) => {
            if (res.statusCode !== 200) { resolve(null); return; }
            const chunks = [];
            res.on("data", (c) => chunks.push(c));
            res.on("end", () => resolve(Buffer.concat(chunks)));
        });
        req.on("error", () => resolve(null));
        req.on("timeout", () => { req.destroy(); resolve(null); });
    });
}

function fetchDashboardScreenshots(width, height) {
    return new Promise((resolve) => {
        const req = http.get("http://localhost:" + DASHBOARD_PORT + "/screenshots?w=" + width + "&h=" + height, { timeout: 25000 }, (res) => {
            if (res.statusCode !== 200) { resolve(null); return; }
            let d = "";
            res.on("data", (c) => d += c);
            res.on("end", () => {
                try {
                    const json = JSON.parse(d);
                    resolve({
                        top: Buffer.from(json.top, "base64"),
                        bottom: Buffer.from(json.bottom, "base64")
                    });
                } catch { resolve(null); }
            });
        });
        req.on("error", () => resolve(null));
        req.on("timeout", () => { req.destroy(); resolve(null); });
    });
}

function fetchDashboardSections(width) {
    return new Promise((resolve) => {
        const req = http.get("http://localhost:" + DASHBOARD_PORT + "/screenshots/sections?w=" + width, { timeout: 30000 }, (res) => {
            if (res.statusCode !== 200) { resolve(null); return; }
            let d = "";
            res.on("data", (c) => d += c);
            res.on("end", () => {
                try {
                    const sections = JSON.parse(d);
                    const valid = sections.filter(s => s.image && Buffer.from(s.image, "base64").length > 500);
                    resolve(valid.length > 0 ? valid : null);
                } catch { resolve(null); }
            });
        });
        req.on("error", () => resolve(null));
        req.on("timeout", () => { req.destroy(); resolve(null); });
    });
}

async function handleMonitorDashboard() {
    _log("Handling /monitor via dashboard sections");

    const sectionLabels = {
        kpis: "\ud83d\udcca <b>KPIs</b> \u2014 Agentes, permisos, CI/CD, acciones, alertas",
        ejecucion: "\ud83d\ude80 <b>Ejecuci\u00f3n & Agentes</b> \u2014 Estado del sprint activo",
        flujo: "\ud83d\udd00 <b>Flujo de Agentes</b> \u2014 Interacciones entre agentes",
        feed: "\ud83d\udce1 <b>Feed</b> \u2014 \u00daltimas acciones en tiempo real",
        permisos: "\ud83d\udd10 <b>Permisos</b> \u2014 Solicitudes pendientes y recientes",
        metricas: "\ud83d\udcc8 <b>M\u00e9tricas</b> \u2014 Rendimiento de agentes",
        roadmap: "\ud83d\uddfa\ufe0f <b>Roadmap</b> \u2014 Sprints planificados y progreso",
        standalone: "\ud83e\udde9 <b>Standalone</b> \u2014 Sesiones fuera del sprint",
        ci: "\u2699\ufe0f <b>CI/CD</b> \u2014 Estado de GitHub Actions"
    };

    try {
        const sections = await fetchDashboardSections(600);
        if (sections && sections.length > 0) {
            const timestamp = new Date().toLocaleString("es-AR", { timeZone: "America/Argentina/Buenos_Aires" });
            const headerCaption = "\ud83d\udcca <b>Intrale Monitor</b>\n" + timestamp;
            const photos = sections.map(s => Buffer.from(s.image, "base64"));
            const captions = sections.map((s, i) => i === 0 ? headerCaption : (sectionLabels[s.id] || s.id));
            for (let i = 0; i < photos.length; i += 10) {
                const batch = photos.slice(i, i + 10);
                const batchCaptions = captions.slice(i, i + 10);
                await _tgApi.sendTelegramMediaGroupWithCaptions(batch, batchCaptions);
            }
            _log("/monitor sections enviadas: " + sections.length + " [" + sections.map(s => s.id).join(", ") + "]");
            return true;
        }
    } catch (e) {
        _log("/monitor sections error: " + e.message);
    }

    try {
        const screenshot = await fetchDashboardScreenshot(600, 800);
        if (screenshot && screenshot.length > 1000) {
            const caption = "\ud83d\udcca <b>Intrale Monitor</b>\n" +
                new Date().toLocaleString("es-AR", { timeZone: "America/Argentina/Buenos_Aires" });
            await _tgApi.sendTelegramPhoto(screenshot, caption, false);
            _log("/monitor screenshot single fallback enviado OK");
            return true;
        }
    } catch (e) {
        _log("/monitor screenshot fallback error: " + e.message);
    }

    // Fallback: obtener datos JSON y enviar como texto
    _log("/monitor fallback a texto");
    try {
        const statusData = await new Promise((resolve) => {
            const req = http.get("http://localhost:" + DASHBOARD_PORT + "/api/status", { timeout: 5000 }, (res) => {
                let d = ""; res.on("data", c => d += c);
                res.on("end", () => { try { resolve(JSON.parse(d)); } catch { resolve(null); } });
            });
            req.on("error", () => resolve(null));
        });
        if (statusData) {
            let text = "\ud83d\udcca <b>Intrale Monitor</b>\n\n";
            text += "\u25cf Agentes: <b>" + statusData.activeSessions + "</b> activos";
            if (statusData.idleSessions > 0) text += ", " + statusData.idleSessions + " idle";
            text += "\n\u25cf Tareas: <b>" + statusData.completedTasks + "/" + statusData.totalTasks + "</b> completadas\n";
            text += "\u25cf CI: <b>" + (statusData.ciStatus === "ok" ? "\u2705 OK" : statusData.ciStatus === "fail" ? "\u274c FAIL" : statusData.ciStatus) + "</b>\n";
            text += "\u25cf Acciones: <b>" + statusData.totalActions + "</b>\n";
            if (statusData.sessions && statusData.sessions.length > 0) {
                text += "\n<b>Sesiones:</b>\n";
                for (const s of statusData.sessions) {
                    const icon = s.status === "active" ? "\ud83d\udfe2" : s.status === "idle" ? "\ud83d\udfe1" : "\u26aa";
                    text += icon + " <b>" + _tgApi.escHtml(s.agent || s.id) + "</b> (" + _tgApi.escHtml(s.branch || "?") + ") " + s.actions + " acciones\n";
                    if (s.tasks && s.tasks.length > 0) {
                        for (const t of s.tasks) {
                            const tIcon = t.status === "completed" ? "\u2611" : t.status === "in_progress" ? "\u25b6\ufe0f" : "\u2610";
                            text += "  " + tIcon + " " + _tgApi.escHtml(t.subject) + (t.progress > 0 ? " (" + t.progress + "%)" : "") + "\n";
                        }
                    }
                }
            }
            text += "\n\ud83d\udcbb " + new Date().toLocaleString("es-AR", { timeZone: "America/Argentina/Buenos_Aires" });
            await _tgApi.sendLongMessage(text);
            return true;
        }
    } catch (e) {
        _log("/monitor fallback text error: " + e.message);
    }

    await _tgApi.sendMessage("\u26a0\ufe0f Dashboard no disponible en localhost:" + DASHBOARD_PORT + ". \u00bfEst\u00e1 corriendo el server?");
    return false;
}

// ─── Sprint interval ─────────────────────────────────────────────────────────

async function handleSprintInterval(minutes) {
    if (minutes === null || minutes <= 0) {
        await _tgApi.sendMessage("⚠️ Uso: <code>/sprint interval N</code> (N = minutos, mayor a 0)");
        return;
    }
    sprintMonitorIntervalMs = minutes * 60 * 1000;
    _log("Intervalo de monitor cambiado a " + minutes + " min");

    let msg = "✅ Intervalo de monitor cambiado a <b>" + minutes + " min</b>";

    if (sprintRunning && sprintMonitorInterval) {
        stopSprintMonitor();
        startSprintMonitor();
        msg += "\n📊 Monitor periódico reiniciado con nuevo intervalo.";
    }
    await _tgApi.sendMessage(msg);
}

// ─── Sprint execution ────────────────────────────────────────────────────────

async function handleSprint(agentNumber) {
    _sessionManager.clearSessionStore();

    if (sprintRunning) {
        await _tgApi.sendMessage("⚠️ Ya hay un sprint en ejecución. Esperá a que termine o usá /stop para detener el commander.");
        return;
    }

    const plan = loadSprintPlan();
    if (!plan || !plan.agentes || plan.agentes.length === 0) {
        await _tgApi.sendMessage("❌ No se encontró <code>scripts/sprint-plan.json</code> o está vacío.\nUsá <code>/planner sprint</code> para generar uno.");
        return;
    }

    let agentes = plan.agentes;
    if (agentNumber !== null) {
        agentes = agentes.filter(a => a.numero === agentNumber);
        if (agentes.length === 0) {
            const available = plan.agentes.map(a => a.numero).join(", ");
            await _tgApi.sendMessage("❌ Agente #" + agentNumber + " no encontrado en el plan.\nDisponibles: " + available);
            return;
        }
    }

    sprintRunning = true;
    sprintStartTime = Date.now();
    const results = new Array(agentes.length).fill("pending");

    let header = "🏃 <b>Sprint iniciado</b> — " + _tgApi.escHtml(plan.titulo) + "\n";
    header += "📋 " + _tgApi.escHtml(plan.sprint_id || "Sprint") + " (" + _tgApi.escHtml(plan.size || "?") + ") · " + agentes.length + " agente(s)\n";
    header += "📊 Monitor periódico: cada " + Math.round(sprintMonitorIntervalMs / 60000) + " min\n\n";
    header += formatSprintProgress(agentes, 0, results);
    await _tgApi.sendMessage(header);

    _lockManager.preTrustDirectory(_repoRoot);
    startSprintMonitor();

    for (let i = 0; i < agentes.length; i++) {
        if (!running) {
            _log("Sprint interrumpido por shutdown");
            break;
        }

        const agente = agentes[i];
        _log("Sprint: ejecutando agente #" + agente.numero + " (issue #" + agente.issue + " " + agente.slug + ")");

        let progressMsg = "⚡ <b>Agente #" + agente.numero + "</b> — " + _tgApi.escHtml(agente.titulo) + "\n";
        progressMsg += "Issue #" + agente.issue + " · Size " + agente.size + "\n\n";
        progressMsg += formatSprintProgress(agentes, i, results);
        await _tgApi.sendMessage(progressMsg);

        const result = await _cmdContext.executeClaudeQueued(agente.prompt);

        if (result.code === 0) {
            results[i] = "success";
            _log("Sprint: agente #" + agente.numero + " completado OK");

            let summary = "";
            try {
                const json = JSON.parse(result.stdout);
                const text = json.result || json.text || json.content || "";
                summary = text.substring(0, 500);
                if (text.length > 500) summary += "…";
            } catch (e) {
                summary = result.stdout.substring(0, 500);
                if (result.stdout.length > 500) summary += "…";
            }

            let doneMsg = "✅ <b>Agente #" + agente.numero + " completado</b> — " + _tgApi.escHtml(agente.slug) + "\n\n";
            if (summary) doneMsg += _tgApi.escHtml(summary) + "\n\n";
            doneMsg += formatSprintProgress(agentes, i + 1, results);
            await _tgApi.sendLongMessage(doneMsg);
        } else {
            results[i] = "failed";
            _log("Sprint: agente #" + agente.numero + " falló (exit " + result.code + ")");

            let errMsg = "❌ <b>Agente #" + agente.numero + " falló</b> — " + _tgApi.escHtml(agente.slug) + "\n";
            errMsg += "Exit code: " + result.code + "\n";
            if (result.stderr) {
                errMsg += "<pre>" + _tgApi.escHtml(result.stderr.substring(0, 1000)) + "</pre>\n";
            }
            errMsg += "\n" + formatSprintProgress(agentes, i + 1, results);
            await _tgApi.sendLongMessage(errMsg);
        }
    }

    stopSprintMonitor();

    const elapsed = Math.round((Date.now() - sprintStartTime) / 1000);
    const mins = Math.floor(elapsed / 60);
    const secs = elapsed % 60;
    const successCount = results.filter(r => r === "success").length;
    const failCount = results.filter(r => r === "failed").length;

    let finalMsg = "🏁 <b>Sprint finalizado</b>\n\n";
    finalMsg += formatSprintProgress(agentes, -1, results) + "\n";
    finalMsg += "✅ " + successCount + " exitosos · ❌ " + failCount + " fallidos\n";
    finalMsg += "⏱ " + mins + "m " + secs + "s";
    await _tgApi.sendMessage(finalMsg);

    sprintRunning = false;
    sprintStartTime = null;
}

module.exports = {
    init,
    setRunning,
    isSprintRunning,
    getSprintMonitorIntervalMs,
    setSkills,
    loadSprintPlan,
    formatSprintProgress,
    stopSprintMonitor,
    startSprintMonitor,
    handleMonitorDashboard,
    handleSprintInterval,
    handleSprint,
    fetchDashboardScreenshot,
    fetchDashboardScreenshots,
    DASHBOARD_PORT,
};
