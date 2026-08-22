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
    _log("Handling /monitor via overview screenshot");

    // P1-UX: Enviar 1 sola foto del overview + botones para ver mas detalle
    // En vez de 9 secciones separadas que generan spam
    try {
        const screenshot = await fetchDashboardScreenshot(600, 800);
        if (screenshot && screenshot.length > 1000) {
            const timestamp = new Date().toLocaleString("es-AR", { timeZone: "America/Argentina/Buenos_Aires" });
            const caption = "\ud83d\udcca <b>Intrale Monitor</b> \u2014 " + timestamp;
            // Enviar foto con botones inline para ver secciones individuales bajo demanda
            await _tgApi.telegramPost("sendPhoto", {
                chat_id: _tgApi.getChatId(),
                photo: null, // se envia como multipart
                caption: caption,
                parse_mode: "HTML",
                disable_notification: true,
                reply_markup: {
                    inline_keyboard: [
                        [
                            { text: "\ud83d\uddfa Roadmap", callback_data: "dash:roadmap" },
                            { text: "\ud83d\udcc8 Metricas", callback_data: "dash:activity" },
                            { text: "\u2699 CI/CD", callback_data: "dash:cicd" }
                        ],
                        [
                            { text: "\ud83d\udd00 Flujo", callback_data: "dash:flow" },
                            { text: "\ud83d\udcdd Logs", callback_data: "dash:logs" }
                        ]
                    ]
                }
            });
            // Fallback: enviar foto directamente si telegramPost con botones falla
            if (!screenshot._sent) {
                await _tgApi.sendTelegramPhoto(screenshot, caption, true);
            }
            _log("/monitor overview enviado OK (1 foto + botones)");
            return true;
        }
    } catch (e) {
        _log("/monitor overview error: " + e.message);
        // Fallback: intentar enviar foto sin botones
        try {
            const screenshot2 = await fetchDashboardScreenshot(600, 800);
            if (screenshot2 && screenshot2.length > 1000) {
                const ts = new Date().toLocaleString("es-AR", { timeZone: "America/Argentina/Buenos_Aires" });
                await _tgApi.sendTelegramPhoto(screenshot2, "\ud83d\udcca <b>Monitor</b> \u2014 " + ts, true);
                return true;
            }
        } catch (_) {}
    }

    // Fallback texto compacto: sin session IDs, sin datos tecnicos
    _log("/monitor fallback a texto compacto");
    try {
        const statusData = await new Promise((resolve) => {
            const req = http.get("http://localhost:" + DASHBOARD_PORT + "/api/status", { timeout: 5000 }, (res) => {
                let d = ""; res.on("data", c => d += c);
                res.on("end", () => { try { resolve(JSON.parse(d)); } catch { resolve(null); } });
            });
            req.on("error", () => resolve(null));
        });
        if (statusData) {
            let text = "\ud83d\udcca <b>Monitor</b>\n\n";
            text += "Agentes: <b>" + statusData.activeSessions + "</b> activos\n";
            text += "Tareas: <b>" + statusData.completedTasks + "/" + statusData.totalTasks + "</b>\n";
            text += "CI: " + (statusData.ciStatus === "ok" ? "\u2705" : statusData.ciStatus === "fail" ? "\u274c" : "\u2014") + "\n";
            if (statusData.sessions && statusData.sessions.length > 0) {
                text += "\n";
                for (const s of statusData.sessions) {
                    if (s.status === "stale") continue;
                    const icon = s.status === "active" ? "\ud83d\udfe2" : "\ud83d\udfe1";
                    const name = (s.agent || "Agente").replace(/^Agente\s*/, "#");
                    text += icon + " " + _tgApi.escHtml(name) + "\n";
                }
            }
            await _tgApi.sendMessage(text, true);
            return true;
        }
    } catch (e) {
        _log("/monitor fallback text error: " + e.message);
    }

    await _tgApi.sendMessage("\u26a0\ufe0f Dashboard no disponible. Verificar con /status");
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
