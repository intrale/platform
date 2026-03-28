// Hook Stop: notifica a Telegram (imagen card o mini-reporte) y marca sesion como "done"
// Para ejecuciones individuales: enriquece con datos de sesión (issue, tareas, PR, duración)
// Para ejecuciones de sprint: mantiene comportamiento simple (sprint-report.js cubre)
// Pure Node.js — sin dependencia de bash
const https = require("https");
const querystring = require("querystring");
const fs = require("fs");
const path = require("path");

// Image utils (opcional — fallback a texto si canvas no disponible)
let renderCardAsPng = null;
let sendTelegramPhoto = null;
try {
    const imgUtils = require("./telegram-image-utils");
    renderCardAsPng = imgUtils.renderCardAsPng;
    sendTelegramPhoto = imgUtils.sendTelegramPhoto;
} catch(e) { /* fallback a texto */ }

const { registerMessage } = require("./telegram-message-registry");

// Agent Registry — marcar agente como done al terminar (#1642)
let agentRegistry = null;
try { agentRegistry = require("./agent-registry"); } catch (e) { /* módulo no disponible */ }

const _tgCfg = JSON.parse(require("fs").readFileSync(require("path").join(__dirname, "telegram-config.json"), "utf8"));
const BOT_TOKEN = _tgCfg.bot_token;
const CHAT_ID = _tgCfg.chat_id;
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1500;

const REPO_ROOT = process.env.CLAUDE_PROJECT_DIR || "C:\\Workspaces\\Intrale\\platform";
const LOG_FILE = path.join(REPO_ROOT, ".claude", "hooks", "hook-debug.log");
const SESSIONS_DIR = path.join(REPO_ROOT, ".claude", "sessions");

function log(msg) {
    try { fs.appendFileSync(LOG_FILE, "[" + new Date().toISOString() + "] Stop: " + msg + "\n"); } catch(e) {}
}

function sendTelegram(text, attempt) {
    return new Promise((resolve, reject) => {
        const postData = querystring.stringify({ chat_id: CHAT_ID, text: text, parse_mode: "HTML" });
        const req = https.request({
            hostname: "api.telegram.org",
            path: "/bot" + BOT_TOKEN + "/sendMessage",
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            timeout: 5000
        }, (res) => {
            let d = "";
            res.on("data", (c) => d += c);
            res.on("end", () => {
                try {
                    const r = JSON.parse(d);
                    if (r.ok) { log("OK intento " + attempt + " msg_id=" + r.result.message_id); resolve(r); }
                    else { log("API error intento " + attempt + ": " + d); reject(new Error(d)); }
                } catch(e) { log("Parse error intento " + attempt + ": " + d); reject(e); }
            });
        });
        req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
        req.on("error", (e) => { log("Net error intento " + attempt + ": " + e.message); reject(e); });
        req.write(postData);
        req.end();
    });
}

// Aumentado para capturar usage.input_tokens/output_tokens que puede venir después de last_assistant_message largo
const MAX_READ = 65536;
let rawInput = "";
let done = false;

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
    if (done) return;
    rawInput += chunk;
    if (rawInput.length >= MAX_READ) { done = true; process.stdin.destroy(); processInput(); }
});
process.stdin.on("end", () => { if (!done) { done = true; processInput(); } });
process.stdin.on("error", () => { if (!done) { done = true; processInput(); } });
setTimeout(() => { if (!done) { done = true; try { process.stdin.destroy(); } catch(e) {} processInput(); } }, 3000);

const AGENT_METRICS_FILE = path.join(REPO_ROOT, ".claude", "hooks", "agent-metrics.json");
const SESSIONS_HISTORY_FILE = path.join(REPO_ROOT, ".claude", "hooks", "sessions-history.jsonl");

// Detecta si el proceso corre en un worktree sibling (no es el repo principal)
function detectWorktreeRoot() {
    try {
        const { execSync } = require("child_process");
        const currentDir = process.env.CLAUDE_PROJECT_DIR || __dirname;
        const output = execSync("git worktree list", {
            encoding: "utf8",
            cwd: currentDir,
            timeout: 5000,
            windowsHide: true
        });
        const lines = output.split("\n").filter(l => l.trim());
        if (lines.length === 0) return null;
        const firstLine = lines[0];
        const match = firstLine.match(/^(.+?)\s+[0-9a-f]{5,}/);
        if (!match) return null;
        const mainPath = match[1].trim()
            .replace(/^\/([a-z])\//, "$1:\\").replace(/\//g, "\\");
        const currentNorm = (currentDir || "").replace(/\//g, "\\").toLowerCase();
        const mainNorm = mainPath.toLowerCase();
        // Si el repo principal difiere del directorio actual, estamos en worktree
        if (currentNorm && mainNorm && currentNorm !== mainNorm) {
            return mainPath; // retorna la ruta del repo principal
        }
    } catch (e) { /* fall through */ }
    return null;
}

// Consolida sesiones del worktree actual al archivo de métricas del repo principal (#1419)
// Solo fusiona sesiones que no existan aún en el principal (por session id).
function consolidateWorktreeMetrics(worktreeMetricsFile, mainRepoRoot) {
    try {
        if (!fs.existsSync(worktreeMetricsFile)) return;
        const mainMetricsFile = path.join(mainRepoRoot, ".claude", "hooks", "agent-metrics.json");
        const wtData = JSON.parse(fs.readFileSync(worktreeMetricsFile, "utf8"));
        if (!wtData || !Array.isArray(wtData.sessions) || wtData.sessions.length === 0) return;

        let mainData = { updated_ts: new Date().toISOString(), sessions: [] };
        try {
            if (fs.existsSync(mainMetricsFile)) {
                const existing = JSON.parse(fs.readFileSync(mainMetricsFile, "utf8"));
                if (existing && Array.isArray(existing.sessions)) mainData = existing;
            }
        } catch (e) {}

        const existingIds = new Set(mainData.sessions.map(s => s.id));
        let merged = 0;
        for (const session of wtData.sessions) {
            if (!existingIds.has(session.id)) {
                mainData.sessions.push(session);
                existingIds.add(session.id);
                merged++;
            }
        }
        if (merged > 0) {
            mainData.updated_ts = new Date().toISOString().replace(/\.\d+Z$/, "Z");
            fs.writeFileSync(mainMetricsFile, JSON.stringify(mainData, null, 2) + "\n", "utf8");
            log("Worktree consolidation: " + merged + " sesion(es) mergeadas al repo principal");
        }
    } catch (e) { log("Error en consolidateWorktreeMetrics: " + e.message); }
}

// Leer sprint_id activo desde sprint-plan.json para correlación histórica
function getActiveSprintId() {
    try {
        const planPath = path.join(REPO_ROOT, "scripts", "sprint-plan.json");
        if (!fs.existsSync(planPath)) return null;
        const plan = JSON.parse(fs.readFileSync(planPath, "utf8"));
        return plan.sprint_id || plan.id || null;
    } catch(e) { return null; }
}

function flushMetrics(sessionId) {
    try {
        if (!sessionId) return;
        const shortId = sessionId.substring(0, 8);
        const sessionFile = path.join(SESSIONS_DIR, shortId + ".json");
        if (!fs.existsSync(sessionFile)) return;

        const session = JSON.parse(fs.readFileSync(sessionFile, "utf8"));

        const endedTs = new Date().toISOString().replace(/\.\d+Z$/, "Z");
        const startMs = new Date(session.started_ts || endedTs).getTime();
        const endMs = new Date(endedTs).getTime();
        const durationMin = Math.round((endMs - startMs) / 60000);

        const toolCounts = session.tool_counts || {};
        const totalToolCalls = Object.values(toolCounts).reduce((a, b) => a + b, 0);

        // Tokens acumulados por activity-logger (PostToolUse) o Stop event
        const tokensInput = session.tokens_input || null;
        const tokensOutput = session.tokens_output || null;
        const tokensTotal = (tokensInput !== null || tokensOutput !== null)
            ? (tokensInput || 0) + (tokensOutput || 0)
            : null;

        // Estimación de tokens por proxy (#1518): tokens_estimated = (duracion_seg * 15) + (tool_count * 500)
        // Calibrar contra dashboard de Anthropic. Se usa cuando tokens reales no están disponibles.
        const duracionSeg = Math.max(0, Math.round((endMs - startMs) / 1000));
        const tokensEstimated = (duracionSeg * 15) + (totalToolCalls * 500);

        const entry = {
            id: shortId,
            sprint_id: getActiveSprintId(),
            agent_name: session.agent_name || null,
            branch: session.branch || null,
            started_ts: session.started_ts || endedTs,
            ended_ts: endedTs,
            duration_min: durationMin,
            tool_counts: toolCounts,
            total_tool_calls: totalToolCalls,
            modified_files_count: Array.isArray(session.modified_files) ? session.modified_files.length : 0,
            tasks_created: session.tasks_created || 0,
            tasks_completed: session.tasks_completed || 0,
            skills_invoked: session.skills_invoked || [],
            tokens_input: tokensInput,
            tokens_output: tokensOutput,
            tokens_total: tokensTotal,
            tokens_estimated: tokensEstimated,
        };

        // Append-only: leer el archivo existente y agregar el nuevo registro.
        // NUNCA regenerar desde cero ni eliminar registros históricos.
        // Solo evitar duplicados exactos por session id (re-flush de la misma sesión).
        let metrics = { updated_ts: endedTs, sessions: [] };
        try {
            if (fs.existsSync(AGENT_METRICS_FILE)) {
                const existing = JSON.parse(fs.readFileSync(AGENT_METRICS_FILE, "utf8"));
                if (existing && Array.isArray(existing.sessions)) {
                    metrics = existing;
                }
            }
        } catch(e) {}

        // Evitar duplicados por session id (re-flush de la misma sesión)
        metrics.sessions = metrics.sessions.filter(s => s.id !== shortId);
        metrics.sessions.push(entry);

        // No hay rotación FIFO — agent-metrics.json es append-only.
        // Las métricas históricas se preservan siempre, independientemente de limpiezas de sesiones.

        metrics.updated_ts = endedTs;
        fs.writeFileSync(AGENT_METRICS_FILE, JSON.stringify(metrics, null, 2) + "\n", "utf8");
        log("Metricas flushed para sesion " + shortId + " (sprint: " + (entry.sprint_id || "unknown") + ")");


        // Persistir sesión en historial inmutable sessions-history.jsonl (#1716)
        try {
            const historyRecord = {
                session_id: shortId,
                sprint_id: entry.sprint_id || null,
                agent_name: entry.agent_name || null,
                issue: (() => {
                    const m = (entry.branch || "").match(/^agent\/(\d+)/);
                    return m ? parseInt(m[1], 10) : null;
                })(),
                branch: entry.branch || null,
                started_at: entry.started_ts || endedTs,
                completed_at: endedTs,
                duration_min: entry.duration_min || 0,
                result: entry.tasks_created > 0 && entry.tasks_created === entry.tasks_completed ? "ok" : (entry.tasks_created === 0 ? "ok" : "partial"),
                pr: null,  // TODO: extract from session or sprint-plan
                transitions: session.agent_transitions || [],
                skills_invoked: entry.skills_invoked || [],
                tokens: {
                    input: entry.tokens_input || 0,
                    output: entry.tokens_output || 0,
                    cache_read: 0  // Not tracked yet
                },
                cost_usd: (() => {
                    const total = (entry.tokens_input || 0) + (entry.tokens_output || 0);
                    // Claude API pricing estimate: ~$3 per 1M input tokens, ~$15 per 1M output tokens
                    return (total > 0 ? ((entry.tokens_input || 0) * 0.000003 + (entry.tokens_output || 0) * 0.000015) : (entry.tokens_estimated || 0) * 0.000001).toFixed(4);
                })(),
                model_usage: { tool_calls: entry.total_tool_calls, modified_files: entry.modified_files_count }
            };
            fs.appendFileSync(SESSIONS_HISTORY_FILE, JSON.stringify(historyRecord) + "\n", "utf8");
            log("Session " + shortId + " persistida a sessions-history.jsonl");
        } catch (e) { log("Error persistiendo sesión a history: " + e.message); }

        // Consolidar al repo principal si estamos en un worktree (#1419)
        const mainRepoRoot = detectWorktreeRoot();
        if (mainRepoRoot) {
            consolidateWorktreeMetrics(AGENT_METRICS_FILE, mainRepoRoot);
        }
    } catch(e) { log("Error en flushMetrics: " + e.message); }
}

function markSessionDone(sessionId) {
    try {
        if (!sessionId) return;
        const shortId = sessionId.substring(0, 8);
        const sessionFile = path.join(SESSIONS_DIR, shortId + ".json");
        if (!fs.existsSync(sessionFile)) return;

        const session = JSON.parse(fs.readFileSync(sessionFile, "utf8"));
        const completedAt = new Date().toISOString().replace(/\.\d+Z$/, "Z");
        session.status = "done";
        session.completed_at = completedAt;
        session.last_activity_ts = completedAt;
        fs.writeFileSync(sessionFile, JSON.stringify(session, null, 2) + "\n", "utf8");
        log("Sesion " + shortId + " marcada como done con completed_at=" + completedAt);

        // Marcar agente como done en el registry centralizado (#1642)
        if (agentRegistry) {
            try { agentRegistry.markDone(shortId); } catch (e) { log("agentRegistry.markDone error: " + e.message); }
        }
    } catch(e) { log("Error marcando sesion done: " + e.message); }
}

// Verifica si un PID de proceso sigue vivo en Windows
function isPidAlive(pid) {
    if (!pid) return false;
    try {
        const { execSync } = require("child_process");
        const output = execSync('tasklist /FI "PID eq ' + parseInt(pid, 10) + '" /NH', {
            timeout: 3000, windowsHide: true, encoding: "utf8"
        });
        return output.indexOf("No tasks") === -1 && output.trim().length > 0;
    } catch (e) {
        try { process.kill(parseInt(pid, 10), 0); return true; } catch (ke) { return ke.code === "EPERM"; }
    }
}

function cleanOldSessions() {
    try {
        if (!fs.existsSync(SESSIONS_DIR)) return;
        const files = fs.readdirSync(SESSIONS_DIR).filter(f => f.endsWith(".json"));
        const now = Date.now();
        const MAX_AGE_MS = 2 * 60 * 60 * 1000; // 2 horas (safety net — dashboard ya filtra a 15min)
        const ZOMBIE_THRESHOLD_MS = 20 * 60 * 1000; // 20 minutos (threshold configurable, #1408)
        let cleaned = 0;
        let zombies = 0;

        for (const file of files) {
            try {
                const filePath = path.join(SESSIONS_DIR, file);
                const session = JSON.parse(fs.readFileSync(filePath, "utf8"));

                // GC periódico: marcar sesiones activas con PID muerto como done (#1408)
                // Solo actualiza el status — NO mata procesos. Idempotente.
                if (session.status === "active" && session.pid) {
                    const age = now - new Date(session.last_activity_ts || 0).getTime();
                    if (age > ZOMBIE_THRESHOLD_MS && !isPidAlive(session.pid)) {
                        session.status = "done";
                        session.completed_at = session.last_activity_ts;
                        fs.writeFileSync(filePath, JSON.stringify(session, null, 2) + "\n", "utf8");
                        log("GC zombie: sesion " + (session.id || file) + " marcada done (PID=" + session.pid + " muerto, edad=" + Math.round(age / 60000) + "min)");
                        zombies++;
                    }
                }

                // Solo limpiar sessions terminadas con más de 2h de antigüedad
                if (session.status !== "done") continue;

                const lastActivity = new Date(session.last_activity_ts || 0).getTime();
                if (now - lastActivity > MAX_AGE_MS) {
                    fs.unlinkSync(filePath);
                    cleaned++;
                }
            } catch(e) {
                // Si el archivo es invalido (ej: test-ses.json), eliminarlo
                try { fs.unlinkSync(path.join(SESSIONS_DIR, file)); cleaned++; } catch(e2) {}
            }
        }

        if (zombies > 0) log("GC: " + zombies + " sesion(es) zombie marcadas done");
        if (cleaned > 0) log("Rotacion: " + cleaned + " session(s) antiguas eliminadas");

        // Sweep del agent registry: purgar entradas done/zombie viejas (#1642)
        if (agentRegistry) {
            try { agentRegistry.sweepRegistry(); } catch (e) { /* no bloquear */ }
        }
    } catch(e) { log("Error en rotacion de sessions: " + e.message); }
}

function stripMarkdown(raw) {
    let t = raw.trim();
    t = t.replace(/```[\s\S]*?```/g, "");
    t = t.replace(/^#{1,6}\s+/gm, "");
    t = t.replace(/\*{1,3}([^*]+)\*{1,3}/g, "$1");
    t = t.replace(/_{1,3}([^_\s][^_]*[^_\s])_{1,3}/g, "$1");
    t = t.replace(/`([^`]+)`/g, "$1");
    t = t.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
    t = t.replace(/^[\s]*[-*+]\s+/gm, "\u2022 ");
    t = t.replace(/\n{2,}/g, "\n");
    t = t.replace(/  +/g, " ");
    return t.trim();
}

function truncateSmart(text, maxLen) {
    if (text.length <= maxLen) return text;
    const sub = text.substring(0, maxLen);
    const lastSentence = Math.max(
        sub.lastIndexOf(". "), sub.lastIndexOf(".\n"),
        sub.lastIndexOf("! "), sub.lastIndexOf("? ")
    );
    if (lastSentence > maxLen * 0.4) return sub.substring(0, lastSentence + 1);
    const lastSpace = sub.lastIndexOf(" ");
    if (lastSpace > maxLen * 0.6) return sub.substring(0, lastSpace) + "\u2026";
    return sub + "\u2026";
}

function escapeHtml(text) {
    return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Detecta si la sesión actual es parte de un sprint (PID en sprint-pids.json).
 */
function isSprintSession(sessionId) {
    try {
        const pidsFile = path.join(REPO_ROOT, "scripts", "sprint-pids.json");
        if (!fs.existsSync(pidsFile)) return false;
        const pidsData = JSON.parse(fs.readFileSync(pidsFile, "utf8"));
        // sprint-pids.json tiene: { "agente_1": PID, "agente_2": PID }
        // Verificar si el PID actual coincide con alguno del sprint
        const currentPid = process.ppid || process.pid;
        for (const key of Object.keys(pidsData)) {
            if (pidsData[key] === currentPid) return true;
        }
        // También verificar por sessionId en las sesiones del sprint
        // Buscar en sessions/ alguna sesión que matchee las ramas del sprint plan
        const planFile = path.join(REPO_ROOT, "scripts", "sprint-plan.json");
        if (!fs.existsSync(planFile)) return false;
        const plan = JSON.parse(fs.readFileSync(planFile, "utf8"));
        const shortId = (sessionId || "").substring(0, 8);
        const sessionFile = path.join(SESSIONS_DIR, shortId + ".json");
        if (!fs.existsSync(sessionFile)) return false;
        const session = JSON.parse(fs.readFileSync(sessionFile, "utf8"));
        if (!session.branch) return false;
        // Si la rama de la sesión matchea un agente del plan, es sprint
        for (const ag of (plan.agentes || [])) {
            if (session.branch.includes(String(ag.issue))) return true;
        }
        return false;
    } catch(e) {
        log("isSprintSession error: " + e.message);
        return false;
    }
}

/**
 * Intenta construir un mini-reporte enriquecido para ejecuciones individuales.
 */
function buildMiniReport(sessionId) {
    try {
        const executionReport = require(path.join(REPO_ROOT, "scripts", "execution-report.js"));
        const shortId = (sessionId || "").substring(0, 8);
        const summary = executionReport.buildExecutionSummary(shortId, REPO_ROOT);
        if (!summary || !summary.found) return null;
        return executionReport.formatTelegramHtml(summary);
    } catch(e) {
        log("buildMiniReport error: " + e.message);
        return null;
    }
}

async function processInput() {
    log("INPUT: " + rawInput.substring(0, 300));

    let data;
    try { data = JSON.parse(rawInput); } catch(e) { log("JSON parse failed: " + rawInput.substring(0, 200)); data = {}; }

    if (data.stop_hook_active) return;

    const sessionId = data.session_id || "";

    // Capturar tokens del evento Stop si la API los expone (#1244)
    if (data.usage && sessionId) {
        try {
            const shortId = sessionId.substring(0, 8);
            const sessionFile = path.join(SESSIONS_DIR, shortId + ".json");
            if (fs.existsSync(sessionFile)) {
                const session = JSON.parse(fs.readFileSync(sessionFile, "utf8"));
                if (data.usage.input_tokens) {
                    session.tokens_input = (session.tokens_input || 0) + (Number(data.usage.input_tokens) || 0);
                }
                if (data.usage.output_tokens) {
                    session.tokens_output = (session.tokens_output || 0) + (Number(data.usage.output_tokens) || 0);
                }
                fs.writeFileSync(sessionFile, JSON.stringify(session, null, 2) + "\n", "utf8");
                log("Tokens capturados del Stop event: in=" + data.usage.input_tokens + " out=" + data.usage.output_tokens);
            }
        } catch(e) { log("Error capturando tokens del Stop event: " + e.message); }
    }

    // Persistir métricas antes de marcar como done (#1226)
    flushMetrics(sessionId);

    // Marcar sesion como terminada
    markSessionDone(sessionId);

    // Rotacion: limpiar sessions "done" con mas de 2h de antiguedad
    cleanOldSessions();

    // Detectar si el commander está procesando un comando del usuario.
    // Cuando el commander maneja un mensaje (texto o audio), stop-notify NO debe
    // enviar nada — el commander ya se encarga de la respuesta.
    try {
        const cmdFlagFile = path.join(__dirname, "command-in-progress.flag");
        if (fs.existsSync(cmdFlagFile)) {
            const flagAge = Date.now() - fs.statSync(cmdFlagFile).mtimeMs;
            if (flagAge < 180000) { // 3 min
                log("Comando del commander en progreso — omitiendo stop-notify (commander responde)");
                return;
            }
            try { fs.unlinkSync(cmdFlagFile); } catch (e) {}
        }
        const voiceFlagFile = path.join(__dirname, "voice-response-active.flag");
        if (fs.existsSync(voiceFlagFile)) {
            const flagAge = Date.now() - fs.statSync(voiceFlagFile).mtimeMs;
            if (flagAge < 120000) {
                log("Respuesta de voz activa — omitiendo stop-notify (TTS ya enviado)");
                try { fs.unlinkSync(voiceFlagFile); } catch (e) {}
                return;
            }
            try { fs.unlinkSync(voiceFlagFile); } catch (e) {}
        }
    } catch (e) {}

    // Detectar si es ejecución de sprint
    const isSprint = isSprintSession(sessionId);

    if (!isSprint) {
        // Ejecución individual: intentar mini-reporte enriquecido
        const miniReport = buildMiniReport(sessionId);
        if (miniReport) {
            log("Enviando mini-reporte enriquecido (individual)");
            // Agregar último mensaje truncado al final
            const raw = (data.last_assistant_message || "").trim();
            const clean = stripMarkdown(raw);
            const lastMsg = clean.length > 0 ? "\n\n💬 " + escapeHtml(truncateSmart(clean, 200)) : "";
            const fullText = miniReport + lastMsg;

            for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
                try {
                    const r = await sendTelegram(fullText, attempt);
                    try { if (r && r.result && r.result.message_id) registerMessage(r.result.message_id, "stop"); } catch(re) { log("registerMessage error (ignorado): " + re.message); }
                    return;
                } catch(e) {
                    if (attempt < MAX_RETRIES) {
                        log("Mini-reporte reintentando en " + RETRY_DELAY_MS + "ms...");
                        await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
                    } else {
                        log("Mini-reporte FALLO, fallback a texto simple");
                    }
                }
            }
            // Si falla el mini-reporte, caer al texto simple (abajo)
        }
    } else {
        log("Ejecución de sprint detectada — omitiendo mini-reporte (sprint-report.js lo cubre)");
    }

    const raw = (data.last_assistant_message || "").trim();
    const clean = stripMarkdown(raw);

    // Intentar enviar como imagen card
    if (renderCardAsPng && sendTelegramPhoto && clean.length > 0) {
        const cardBody = truncateSmart(clean, 800);
        try {
            const png = renderCardAsPng("\u2705 Claude Code \u2014 Listo", cardBody);
            if (png) {
                const caption = truncateSmart(clean, 150);
                for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
                    try {
                        const photoResult = await sendTelegramPhoto(BOT_TOKEN, CHAT_ID, png, caption);
                        try { if (photoResult && photoResult.result && photoResult.result.message_id) registerMessage(photoResult.result.message_id, "stop"); } catch(re) { log("registerMessage error (ignorado): " + re.message); }
                        log("Imagen enviada OK intento " + attempt);
                        return;
                    } catch(e) {
                        log("Imagen fallo intento " + attempt + ": " + e.message);
                        if (attempt < MAX_RETRIES) await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
                    }
                }
                log("Imagen fallo todos los intentos, fallback a texto");
            }
        } catch(e) { log("Error generando card: " + e.message); }
    }

    // Fallback: texto plano
    const summary = escapeHtml(truncateSmart(clean, 300));
    const text = "\u2705 <b>[Claude Code] Listo</b>" + (summary ? " \u2014 " + summary : " \u2014 esperando tu siguiente instruccion");

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            const r = await sendTelegram(text, attempt);
            try { if (r && r.result && r.result.message_id) registerMessage(r.result.message_id, "stop"); } catch(re) { log("registerMessage error (ignorado): " + re.message); }
            return;
        } catch(e) {
            if (attempt < MAX_RETRIES) {
                log("Reintentando en " + RETRY_DELAY_MS + "ms...");
                await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
            } else {
                log("FALLO despues de " + MAX_RETRIES + " intentos");
            }
        }
    }
}
