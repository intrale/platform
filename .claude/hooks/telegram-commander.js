// telegram-commander.js — Daemon Node.js para recibir comandos via Telegram
// Orquestador liviano que delega en módulos especializados:
//   - commander/telegram-api.js      — HTTP helpers y API de Telegram
//   - commander/multimedia-handler.js — audio, vision, TTS
//   - commander/command-dispatcher.js — parsing y dispatch de comandos
//   - commander/sprint-manager.js     — ejecución de sprints y monitor
//   - commander/callback-handler.js   — botones inline (propuestas, permisos, etc.)
//   - commander/session-manager.js    — gestión de sesiones conversacionales
//   - commander/lock-manager.js       — lockfile, offset, procesos zombie
//
// Uso: node telegram-commander.js
// Detener: Ctrl+C o SIGTERM

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const readline = require("readline");

// ─── Módulos del commander ───────────────────────────────────────────────────
const tgApi = require("./commander/telegram-api");
const multimediaHandler = require("./commander/multimedia-handler");
const dispatcher = require("./commander/command-dispatcher");
const sprintManager = require("./commander/sprint-manager");
const callbackHandler = require("./commander/callback-handler");
const sessionManager = require("./commander/session-manager");
const lockManager = require("./commander/lock-manager");

// ─── Resumen inteligente de respuestas (#1681) ────────────────
const responseSummarizer = require("./telegram-response-summarizer");
const lastFullResponse = require("./telegram-last-full-response");

// ─── Dependencias existentes (externas al commander) ─────────────────────────
const { getPendingQuestions, getExpiredQuestions, resolveQuestion, getQuestionById, loadQuestions, saveQuestions } = require("./pending-questions");
const { cleanup: cleanupMessages } = require("./telegram-cleanup");
let outboxModule;
try { outboxModule = require("./telegram-outbox"); } catch (e) { outboxModule = null; }
let opsLearnings;
try { opsLearnings = require("./ops-learnings"); } catch (e) { opsLearnings = null; }
let agentMonitor;
try { agentMonitor = require("./agent-monitor"); } catch (e) { agentMonitor = null; }
let processSupervisor;
try { processSupervisor = require("./process-supervisor"); } catch (e) { processSupervisor = null; }
let permissionSuggester;
try { permissionSuggester = require("./permission-suggester"); } catch (e) { permissionSuggester = null; }

// ─── Config ──────────────────────────────────────────────────────────────────

const HOOKS_DIR = __dirname;
const REPO_ROOT = path.resolve(HOOKS_DIR, "..", "..");
const CONFIG_FILE = path.join(HOOKS_DIR, "telegram-config.json");
const LOCK_FILE = path.join(HOOKS_DIR, "telegram-commander.lock");
const OFFSET_FILE = path.join(HOOKS_DIR, "tg-commander-offset.json");
const LOG_FILE = path.join(HOOKS_DIR, "hook-debug.log");
const SKILLS_DIR = path.join(REPO_ROOT, ".claude", "skills");
const SPRINT_PLAN_FILE = path.join(REPO_ROOT, "scripts", "sprint-plan.json");
const PROPOSALS_FILE = path.join(HOOKS_DIR, "planner-proposals.json");
const SESSION_STORE_FILE = path.join(HOOKS_DIR, "tg-session-store.json");
const PENDING_QUESTIONS_FILE = path.join(HOOKS_DIR, "pending-questions.json");
const CONFLICT_COOLDOWN_FILE = path.join(HOOKS_DIR, "telegram-commander.conflict");

const POLL_TIMEOUT_SEC = 30;
const POLL_CONFLICT_RETRY_MS = 5000;
const POLL_CONFLICT_MAX = 8;
const EXEC_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutos
const CLEANUP_TTL_MS = 4 * 60 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 4 * 60 * 60 * 1000;
const SUGGESTER_INTERVAL_MS = 6 * 60 * 60 * 1000;

let _tgCfg;
try {
    _tgCfg = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
} catch (e) {
    console.error("Error leyendo telegram-config.json:", e.message);
    process.exit(1);
}
const BOT_TOKEN = _tgCfg.bot_token;
const CHAT_ID = _tgCfg.chat_id;

// ─── API Keys Guardian ───────────────────────────────────────────────────────
try {
    const guardian = require("./api-keys-guardian");
    const result = guardian.verify();
    if (result.restored && result.restored.length > 0) {
        _tgCfg = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
        console.log(`[guardian] Auto-restauradas keys: ${result.restored.join(", ")}`);
    }
} catch (e) {
    console.warn("[guardian] No se pudo verificar API keys:", e.message);
}

// ─── Multimedia API keys ─────────────────────────────────────────────────────
const ANTHROPIC_API_KEY = _tgCfg.anthropic_api_key || process.env.ANTHROPIC_API_KEY || null;
const OPENAI_API_KEY = _tgCfg.openai_api_key || process.env.OPENAI_API_KEY || null;
const ELEVENLABS_API_KEY = (_tgCfg.elevenlabs_api_key && _tgCfg.elevenlabs_api_key.trim()) ? _tgCfg.elevenlabs_api_key.trim() : (process.env.ELEVENLABS_API_KEY || null);
const ELEVENLABS_VOICE_ID = (_tgCfg.elevenlabs_voice_id && _tgCfg.elevenlabs_voice_id.trim()) ? _tgCfg.elevenlabs_voice_id.trim() : "pNInz6obpgDQGcFmaJgB";

// ─── Estado global ───────────────────────────────────────────────────────────

let running = true;
let skills = [];
let cleanupInterval = null;
let outboxDrainInterval = null;
let suggesterInterval = null;

// Paralelismo de comandos (#1279)
const MAX_PARALLEL_COMMANDS = 3;
const activeCommands = new Map();
let _nextCmdNumber = 1;
const PROCESSED_IDS_MAX = 200;
const processedMessageIds = new Set();

// ─── Logging ─────────────────────────────────────────────────────────────────

const COMMANDER_LOG_FILE = path.join(HOOKS_DIR, "telegram-commander.log");
function log(msg) {
    const line = "[" + new Date().toISOString() + "] Commander: " + msg;
    try { fs.appendFileSync(LOG_FILE, line + "\n"); } catch (e) {}
    try { fs.appendFileSync(COMMANDER_LOG_FILE, line + "\n"); } catch (e) {}
    console.log(line);
}

// ─── Inicialización de módulos ───────────────────────────────────────────────

tgApi.init(BOT_TOKEN, CHAT_ID);
lockManager.init(LOCK_FILE, OFFSET_FILE, CONFLICT_COOLDOWN_FILE, log);
sessionManager.init(SESSION_STORE_FILE, log);

// ─── Ejecución de comandos Claude ────────────────────────────────────────────

function isCommandBusy() {
    return activeCommands.size >= MAX_PARALLEL_COMMANDS;
}

function getCommandBusyLabel() {
    if (activeCommands.size === 0) return "";
    return Array.from(activeCommands.values()).map(c => c.label).join(", ");
}

function peekNextCmdNumber() {
    return _nextCmdNumber;
}

function getActiveCount() {
    return activeCommands.size;
}

async function executeClaudeQueued(prompt, extraArgs, options) {
    if (activeCommands.size >= MAX_PARALLEL_COMMANDS) {
        const labels = Array.from(activeCommands.values()).map(c => c.label).join(", ");
        log("executeClaude: límite de " + MAX_PARALLEL_COMMANDS + " comandos paralelos alcanzado — RECHAZANDO (" + labels + ")");
        return { code: -2, stdout: "", stderr: "busy", sessionId: null, cmdId: null };
    }
    const cmdId = _nextCmdNumber++;
    const label = (prompt || "").substring(0, 80);
    const _qOpts = options || {};
    activeCommands.set(cmdId, { label, sessionId: null, startTime: Date.now() });
    log("Comando [Cmd #" + cmdId + "] registrado: " + label + " (activos: " + activeCommands.size + ")");

    // ─── Traza de inicio en terminal ─────────────────────────────────────────
    const _ts0 = new Date().toISOString().substring(11, 19);
    const _displayLabel = _qOpts.cmdLabel || (_qOpts.skill ? "/" + _qOpts.skill : label.substring(0, 60));
    const _fromSuffix = _qOpts.from ? " (from: " + _qOpts.from + ")" : "";
    console.log("[36m[" + _ts0 + "] CMD: " + _displayLabel + _fromSuffix + "[0m");

    const _startMs = Date.now();
    try {
        const result = await executeClaude(prompt, extraArgs, options);
        result.cmdId = cmdId;

        // ─── Traza de fin en terminal ─────────────────────────────────────────
        const _elapsed = ((Date.now() - _startMs) / 1000).toFixed(1);
        const _tsEnd = new Date().toISOString().substring(11, 19);
        if (result.code === 0) {
            console.log("[32m[" + _tsEnd + "] DONE: " + _displayLabel + " (" + _elapsed + "s)[0m");
        } else {
            console.log("[31m[" + _tsEnd + "] ERROR: " + _displayLabel + " (exit " + result.code + ", " + _elapsed + "s)[0m");
        }

        return result;
    } finally {
        activeCommands.delete(cmdId);
        log("Comando [Cmd #" + cmdId + "] finalizado (activos: " + activeCommands.size + ")");
    }
}

function executeClaude(prompt, extraArgs, options) {
    const opts = options || {};
    return new Promise((resolve) => {
        const args = ["-p", "--output-format", "stream-json", "--verbose", "--permission-mode", "bypassPermissions"].concat(extraArgs || []);

        let resumedSessionId = null;
        if (opts.useSession && activeCommands.size <= 1) {
            const activeId = sessionManager.getActiveSessionId();
            if (activeId) {
                args.push("--resume", activeId);
                resumedSessionId = activeId;
                log("Resumiendo sesión principal: " + activeId);
            }
        } else if (opts.useSession && activeCommands.size > 1) {
            log("Comando paralelo — sesión independiente (no resume sesión principal)");
        }

        log("Ejecutando: claude " + args.join(" ") + " (prompt via stdin, " + prompt.length + " chars)");

        lockManager.preTrustDirectory(REPO_ROOT);

        const cleanEnv = { ...process.env, CLAUDE_PROJECT_DIR: REPO_ROOT };
        delete cleanEnv.CLAUDECODE;

        const proc = spawn("claude", args, {
            cwd: REPO_ROOT,
            env: cleanEnv,
            stdio: ["pipe", "pipe", "pipe"],
            shell: true,
            timeout: EXEC_TIMEOUT_MS
        });

        proc.stdin.write(prompt);
        proc.stdin.end();

        let stderr = "";
        let _finalResultJson = null;
        let _toolCount = 0;
        let _lastAssistantText = ""; // Fallback: último texto del assistant (para TTS cuando no hay evento result)

        // ─── Procesamiento stream-json en tiempo real ─────────────────────────
        const rl = readline.createInterface({ input: proc.stdout, crlfDelay: Infinity });

        rl.on("line", (line) => {
            if (!line.trim()) return;
            try {
                const evt = JSON.parse(line);
                const ts = new Date().toISOString().substring(11, 19);

                if (evt.type === "assistant" && evt.message && evt.message.content) {
                    const blocks = Array.isArray(evt.message.content) ? evt.message.content : [evt.message.content];
                    for (const block of blocks) {
                        if (block.type === "tool_use") {
                            _toolCount++;
                            let snippet = (block.input && (block.input.command || block.input.pattern || block.input.file_path || block.input.description)) || "";
                            if (snippet.length > 80) snippet = snippet.substring(0, 80);
                            const tLabel = snippet
                                ? "  [" + ts + "] [" + _toolCount + "] " + block.name + ": " + snippet
                                : "  [" + ts + "] [" + _toolCount + "] " + block.name;
                            console.log("\x1b[33m" + tLabel + "\x1b[0m");
                        } else if (block.type === "text" && block.text) {
                            _lastAssistantText = block.text; // Capturar para TTS fallback
                            let preview = block.text;
                            if (preview.length > 120) preview = preview.substring(0, 120) + "...";
                            console.log("\x1b[90m  [" + ts + "] > " + preview + "\x1b[0m");
                        }
                    }
                } else if (evt.type === "result") {
                    _finalResultJson = evt;
                }
            } catch (e) {
                // línea no es JSON válido — ignorar
            }
        });

        proc.stderr.on("data", (d) => { stderr += d.toString(); });

        let resolved = false;
        function finish(code) {
            if (resolved) return;
            resolved = true;
            clearTimeout(timer);
            // Inyectar último texto del assistant si el campo result está vacío
            // Claude stream-json emite result:"" pero el texto real está en bloques text del assistant
            if (_finalResultJson && !_finalResultJson.result && _lastAssistantText) {
                _finalResultJson.result = _lastAssistantText;
            }
            let stdout = _finalResultJson ? JSON.stringify(_finalResultJson) : "";
            if (!stdout && _lastAssistantText) {
                stdout = JSON.stringify({ type: "result", result: _lastAssistantText });
            }
            log("claude terminó con código " + code + " (stdout: " + stdout.length + " bytes, stderr: " + stderr.length + " bytes)");
            if (stderr) log("STDERR: " + stderr.substring(0, 500));

            let sessionId = null;
            if (opts.useSession && code === 0 && _finalResultJson) {
                sessionId = _finalResultJson.session_id || null;
                if (sessionId) {
                    sessionManager.saveSession(sessionId, opts.skill || null);
                }
            }

            if (opts.useSession && resumedSessionId && code !== 0) {
                const stderrLower = (stderr || "").toLowerCase();
                if (stderrLower.includes("session") || stderrLower.includes("invalid") || stderrLower.includes("not found")) {
                    log("Sesión inválida detectada — limpiando y reintentando sin --resume");
                    sessionManager.clearSessionStore();
                    executeClaude(prompt, extraArgs, { useSession: false, skill: opts.skill }).then(resolve);
                    return;
                }
            }

            resolve({ code, stdout, stderr, sessionId });
        }

        const timer = setTimeout(() => {
            log("Timeout ejecutando claude — matando proceso (PID " + proc.pid + ")");
            if (opsLearnings) {
                try {
                    opsLearnings.recordLearning({
                        source: "telegram-commander",
                        category: "exec_timeout",
                        severity: "high",
                        symptom: "Exec timeout: claude process excedió límite",
                        root_cause: "PID " + proc.pid + " no terminó en EXEC_TIMEOUT_MS",
                        affected: ["telegram-commander.js"],
                        auto_detected: true
                    });
                } catch (e2) {}
            }
            try {
                spawn("taskkill", ["/PID", String(proc.pid), "/T", "/F"], { shell: true, stdio: "ignore" });
            } catch (e) {}
            setTimeout(() => finish(-1), 3000);
        }, EXEC_TIMEOUT_MS);

        proc.on("close", (code) => finish(code));
        proc.on("error", (e) => {
            log("Error spawning claude: " + e.message);
            finish(-1);
        });
    });
}

async function sendResult(label, result) {
    let output = "";
    const cmdPrefix = result.cmdId ? "[Cmd #" + result.cmdId + "] " : "";

    if (result.code !== 0) {
        output = cmdPrefix + "❌ <b>Error</b> (exit code " + result.code + ")\n\n";
        let errorDetail = "";
        if (result.stderr) {
            errorDetail = result.stderr.substring(0, 2000);
        }
        if (!errorDetail && result.stdout) {
            try {
                const json = JSON.parse(result.stdout);
                const text = json.result || json.text || json.content || "";
                if (text) errorDetail = text.substring(0, 2000);
            } catch {
                if (result.stdout.includes("API Error: 403") || result.stdout.includes("Cloudflare")) {
                    errorDetail = "API temporalmente no disponible (Cloudflare 403). Reintentar en unos minutos.";
                } else if (result.stdout.includes("API Error")) {
                    const m = result.stdout.match(/API Error: \d+/);
                    errorDetail = m ? m[0] + " — reintentar en unos minutos" : result.stdout.substring(0, 500);
                } else {
                    errorDetail = result.stdout.substring(0, 500);
                }
            }
        }
        if (errorDetail) output += "<pre>" + tgApi.escHtml(errorDetail) + "</pre>";
        else output += "<i>Sin detalle de error disponible</i>";
        await tgApi.sendLongMessage(output);
        return;
    }

    let rawText = "";
    try {
        const json = JSON.parse(result.stdout);
        rawText = json.result || json.text || json.content || result.stdout;
    } catch (e) {
        rawText = result.stdout || "(sin output)";
    }

    // Resumen inteligente (#1681): si la respuesta es larga, resumir y ofrecer detalle
    if (!responseSummarizer.isShort(rawText)) {
        lastFullResponse.save(rawText, label);
        const summary = responseSummarizer.summarize(rawText);
        output = cmdPrefix + "✅ <b>" + tgApi.escHtml(label) + "</b>\n\n" + tgApi.escHtml(summary);
        try {
            const { registerMessage } = require("./telegram-message-registry");
            const r = await tgApi.telegramPost("sendMessage", {
                chat_id: tgApi.getChatId(),
                text: output,
                parse_mode: "HTML",
                reply_markup: { inline_keyboard: [[{ text: "📋 Ver detalle", callback_data: "show_detail" }]] }
            }, 8000);
            if (r && r.message_id) registerMessage(r.message_id, "command");
        } catch (e) {
            log("sendResult: error enviando con boton, fallback: " + e.message);
            await tgApi.sendLongMessage(output);
        }
    } else {
        output = cmdPrefix + "✅ <b>" + tgApi.escHtml(label) + "</b>\n\n" + tgApi.escHtml(rawText);
        await tgApi.sendLongMessage(output);
    }
}

// ─── Contexto de comandos (compartido entre módulos) ─────────────────────────

const cmdContext = {
    MAX_PARALLEL_COMMANDS,
    isCommandBusy,
    getCommandBusyLabel,
    peekNextCmdNumber,
    getActiveCount,
    executeClaudeQueued,
    sendResult,
    getMultimediaConfig: () => ({
        anthropicApiKey: ANTHROPIC_API_KEY,
        openaiApiKey: OPENAI_API_KEY,
        elevenlabsApiKey: ELEVENLABS_API_KEY,
    }),
};

// ─── Inicializar módulos con dependencias ────────────────────────────────────

multimediaHandler.init({
    anthropicApiKey: ANTHROPIC_API_KEY,
    openaiApiKey: OPENAI_API_KEY,
    elevenlabsApiKey: ELEVENLABS_API_KEY,
    elevenlabsVoiceId: ELEVENLABS_VOICE_ID,
}, tgApi, cmdContext, log);

sprintManager.init({
    tgApi,
    cmdContext,
    lockManager,
    sessionManager,
    log,
    repoRoot: REPO_ROOT,
    sprintPlanFile: SPRINT_PLAN_FILE,
    skills,
});

dispatcher.init({
    tgApi,
    cmdContext,
    sessionManager,
    sprintManager,
    log,
    repoRoot: REPO_ROOT,
    hooksDir: HOOKS_DIR,
    skills,
});

callbackHandler.init({
    tgApi,
    cmdContext,
    log,
    repoRoot: REPO_ROOT,
    hooksDir: HOOKS_DIR,
    proposalsFile: PROPOSALS_FILE,
    sprintPlanFile: SPRINT_PLAN_FILE,
    skills,
    dispatcher,
    permissionSuggester,
});

// ─── Pending Questions Watch (sync consola ↔ Telegram) ───────────────────────

let _pqWatcher = null;
let _pqLastSnapshot = {};

function takePqSnapshot() {
    try {
        const data = JSON.parse(fs.readFileSync(PENDING_QUESTIONS_FILE, "utf8"));
        const snap = {};
        for (const q of (data.questions || [])) {
            snap[q.id] = { status: q.status, answered_via: q.answered_via || null, msgId: q.telegram_message_id, telegram_synced: q.telegram_synced || false };
        }
        return snap;
    } catch (e) { return {}; }
}

async function checkOrphanedApprovers() {
    try {
        const data = loadQuestions();
        if (!data.questions) return;
        let changed = false;
        for (const q of data.questions) {
            if (q.status !== "pending" || q.type !== "permission") continue;
            if (!q.approver_pid || !q.telegram_message_id) continue;
            if (!lockManager.isProcessAlive(q.approver_pid)) {
                log("Orphan detected: pregunta " + q.id + " approver PID " + q.approver_pid + " muerto — sincronizando");
                q.status = "answered";
                q.answered_at = new Date().toISOString();
                q.answered_via = "console";
                changed = true;
                try {
                    const originalHtml = q.original_html || "";
                    const cleanHtml = originalHtml.replace(/\n📝 (?:Usar botones|Responder).*$/s, "");
                    await tgApi.telegramPost("editMessageText", {
                        chat_id: CHAT_ID,
                        message_id: q.telegram_message_id,
                        text: (cleanHtml || "⚠️ Permiso solicitado") + "\n\n⌨️ <b>Respondido en consola</b>",
                        parse_mode: "HTML",
                        reply_markup: { inline_keyboard: [] }
                    }, 8000);
                } catch (e) {
                    const errMsg = e.message || "";
                    if (!errMsg.includes("message is not modified")) {
                        log("Orphan: error editando mensaje " + q.telegram_message_id + ": " + errMsg);
                    }
                }
            }
        }
        if (changed) saveQuestions(data);
    } catch (e) {
        log("checkOrphanedApprovers error: " + e.message);
    }
}

async function onPendingQuestionsChange() {
    const newSnap = takePqSnapshot();
    for (const id of Object.keys(newSnap)) {
        const cur = newSnap[id];
        const prev = _pqLastSnapshot[id];
        if (cur.answered_via === "console" && (!prev || prev.answered_via !== "console") && cur.msgId && !cur.telegram_synced) {
            log("PQ Watch: pregunta " + id + " respondida en consola — editando mensaje " + cur.msgId);
            try {
                await tgApi.telegramPost("editMessageText", {
                    chat_id: CHAT_ID,
                    message_id: cur.msgId,
                    text: "⌨️ <b>Respondido en consola</b>\n\n<i>El usuario respondió directamente en la consola de Claude Code.</i>",
                    parse_mode: "HTML",
                    reply_markup: { inline_keyboard: [] }
                }, 8000);
            } catch (e) {
                const errMsg = e.message || "";
                if (!errMsg.includes("message is not modified")) {
                    log("PQ Watch: error editando mensaje " + cur.msgId + ": " + errMsg);
                }
            }
        }
    }
    _pqLastSnapshot = newSnap;

    checkOrphanedApprovers().catch(e => log("Orphan check (on-demand) error: " + e.message));
}

function startPendingQuestionsWatch() {
    _pqLastSnapshot = takePqSnapshot();
    try {
        _pqWatcher = fs.watch(PENDING_QUESTIONS_FILE, { persistent: false }, (eventType) => {
            if (eventType === "change") {
                setTimeout(() => { onPendingQuestionsChange().catch(e => log("PQ Watch error: " + e.message)); }, 200);
            }
        });
        _pqWatcher.on("error", (e) => {
            log("PQ Watcher error: " + e.message);
            _pqWatcher = null;
        });
        log("PQ Watch iniciado sobre " + PENDING_QUESTIONS_FILE);
    } catch (e) {
        log("No se pudo iniciar PQ Watch: " + e.message);
    }
}

function stopPendingQuestionsWatch() {
    if (_pqWatcher) {
        try { _pqWatcher.close(); } catch (e) {}
        _pqWatcher = null;
        log("PQ Watch detenido");
    }
}

async function cleanStaleQuestionsOnStartup() {
    const data = loadQuestions();
    if (!data.questions || data.questions.length === 0) return;
    const stale = data.questions.filter(q => q.status === "pending" && q.telegram_message_id);
    if (stale.length === 0) return;

    log("Limpiando " + stale.length + " pregunta(s) pendientes de sesiones anteriores");
    for (const q of stale) {
        try {
            await tgApi.telegramPost("editMessageText", {
                chat_id: CHAT_ID,
                message_id: q.telegram_message_id,
                text: "⌨️ <b>Respondido fuera de Telegram</b>\n\n<i>Esta pregunta fue resuelta en una sesión anterior.</i>",
                parse_mode: "HTML",
                reply_markup: { inline_keyboard: [] }
            }, 8000);
        } catch (e) {
            const errMsg = e.message || "";
            if (!errMsg.includes("message is not modified")) {
                log("Error editando stale msg " + q.telegram_message_id + ": " + errMsg);
            }
        }
        q.status = "answered";
        q.answered_at = new Date().toISOString();
        q.answered_via = "console";
    }
    saveQuestions(data);
}

// ─── Polling loop ────────────────────────────────────────────────────────────

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function pollingLoop() {
    const savedOffset = lockManager.loadOffset();
    let offset = savedOffset.offset;
    const hasGap = lockManager.detectOffsetGap(savedOffset.timestamp);

    if (hasGap) {
        log("Gap >60s detectado — descartando updates viejos con getUpdates offset=-1");
        try {
            const stale = await tgApi.telegramPost("getUpdates", {
                offset: -1,
                limit: 1,
                timeout: 0,
                allowed_updates: ["message", "callback_query"]
            }, 5000);
            if (stale && stale.length > 0) {
                offset = stale[stale.length - 1].update_id + 1;
                log("Offset actualizado post-gap: " + offset + " (descartados updates stale)");
            }
        } catch (e) {
            log("Error descartando updates stale: " + e.message);
        }
    }

    // Avanzar offset para ignorar updates anteriores al arranque
    let startupConflicts = 0;
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            const pending = await tgApi.telegramPost("getUpdates", {
                limit: 100,
                timeout: 0,
                allowed_updates: ["message", "callback_query"]
            }, 5000);
            if (pending && pending.length > 0) {
                const maxId = pending[pending.length - 1].update_id;
                if (maxId >= offset) {
                    offset = maxId + 1;
                    log("Descartados " + pending.length + " updates previos. Nuevo offset: " + offset);
                }
            }
            startupConflicts = 0;
            break;
        } catch (e) {
            const is409 = (e.message || "").includes("409");
            log("Error obteniendo updates iniciales (intento " + (attempt + 1) + "): " + e.message);
            if (is409) {
                startupConflicts++;
                if (attempt < 2) await sleep(2000);
            }
        }
    }

    if (startupConflicts >= 3) {
        log("FATAL: 3 conflictos 409 en startup — otro Commander ya controla el polling. SALIENDO.");
        lockManager.writeConflictCooldown();
        lockManager.releaseLock();
        process.exit(1);
    }

    lockManager.saveOffset(offset);
    lockManager.clearConflictCooldown();

    let conflictStreak = 0;

    while (running) {
        let updates;
        try {
            updates = await tgApi.telegramPost("getUpdates", {
                offset: offset,
                timeout: POLL_TIMEOUT_SEC,
                allowed_updates: ["message", "callback_query"]
            }, (POLL_TIMEOUT_SEC + 10) * 1000);
            if (conflictStreak > 0) {
                log("Polling OK — reseteando conflicto streak");
                conflictStreak = 0;
            }
        } catch (e) {
            const errStr = e.message || "";
            const is409 = errStr.includes("409") || errStr.includes("Conflict");
            if (is409) {
                conflictStreak++;
                if (opsLearnings) {
                    try {
                        opsLearnings.recordLearning({
                            source: "telegram-commander",
                            category: "telegram_conflict",
                            severity: conflictStreak >= POLL_CONFLICT_MAX ? "critical" : "low",
                            symptom: "409 Conflict en getUpdates (streak: " + conflictStreak + ")",
                            root_cause: "Otro poller activo compitiendo por getUpdates",
                            affected: ["telegram-commander.js"],
                            auto_detected: true
                        });
                    } catch (e2) {}
                }
                if (conflictStreak <= POLL_CONFLICT_MAX) {
                    log("Conflicto 409 (" + conflictStreak + "/" + POLL_CONFLICT_MAX + ") — reintentando en " + POLL_CONFLICT_RETRY_MS + "ms");
                    await sleep(POLL_CONFLICT_RETRY_MS);
                } else {
                    log("FATAL: Conflicto 409 persistente (" + conflictStreak + " seguidos) — otro Commander ya controla el polling. SALIENDO.");
                    lockManager.writeConflictCooldown();
                    running = false;
                    lockManager.releaseLock();
                    process.exit(1);
                }
            } else {
                log("Error en polling: " + errStr);
                await sleep(3000);
            }
            continue;
        }

        if (!updates || !Array.isArray(updates) || updates.length === 0) continue;

        for (const update of updates) {
            if (update.update_id >= offset) {
                offset = update.update_id + 1;
                lockManager.saveOffset(offset);
            }

            // ─── Callback queries (botones inline) ───────────────────────
            const cq = update.callback_query;
            if (cq && cq.data) {
                const handled = await callbackHandler.routeCallback(cq.data, cq.id, cq.message);
                if (handled) continue;
            }

            const msg = update.message;
            if (!msg) continue;

            // Solo aceptar mensajes del chat autorizado
            if (String(msg.chat && msg.chat.id) !== String(CHAT_ID)) {
                log("Mensaje de chat no autorizado: " + (msg.chat && msg.chat.id));
                continue;
            }

            // Deduplicar
            const msgId = msg.message_id;
            if (msgId && processedMessageIds.has(msgId)) {
                log("Mensaje duplicado ignorado: message_id=" + msgId);
                continue;
            }
            if (msgId) {
                processedMessageIds.add(msgId);
                if (processedMessageIds.size > PROCESSED_IDS_MAX) {
                    const iter = processedMessageIds.values();
                    processedMessageIds.delete(iter.next().value);
                }
            }

            // ─── Multimedia ──────────────────────────────────────────────
            if (msg.photo && msg.photo.length > 0) {
                log("Foto recibida (id=" + msgId + ", sizes=" + msg.photo.length + ")");
                multimediaHandler.handlePhoto(msg).catch(e => {
                    log("Error en handlePhoto: " + e.message);
                    tgApi.sendMessage("❌ Error procesando foto: <code>" + tgApi.escHtml(e.message) + "</code>").catch(() => {});
                });
                continue;
            }

            if (msg.document && multimediaHandler.isDocumentImage(msg.document)) {
                log("Documento-imagen recibido (id=" + msgId + ", mime=" + msg.document.mime_type + ")");
                msg.photo = [{ file_id: msg.document.file_id, file_unique_id: msg.document.file_unique_id }];
                multimediaHandler.handlePhoto(msg).catch(e => {
                    log("Error en handlePhoto (documento): " + e.message);
                    tgApi.sendMessage("❌ Error procesando imagen: <code>" + tgApi.escHtml(e.message) + "</code>").catch(() => {});
                });
                continue;
            }

            if (msg.voice || msg.audio) {
                const mediaType = msg.voice ? "voice" : "audio";
                const duration = (msg.voice || msg.audio).duration || 0;
                log("Audio recibido (id=" + msgId + ", type=" + mediaType + ", duration=" + duration + "s)");
                multimediaHandler.handleVoiceOrAudio(msg).catch(e => {
                    log("Error en handleVoiceOrAudio: " + e.message);
                    tgApi.sendMessage("❌ Error procesando audio: <code>" + tgApi.escHtml(e.message) + "</code>").catch(() => {});
                });
                continue;
            }

            // ─── Texto ───────────────────────────────────────────────────
            const text = msg.text;
            if (!text) continue;

            log("Mensaje recibido (id=" + msgId + "): " + text.substring(0, 100));

            const cmd = dispatcher.parseCommand(text);
            if (!cmd) continue;

            try {
                switch (cmd.type) {
                    case "help":
                        await dispatcher.handleHelp();
                        break;
                    case "status":
                        await dispatcher.handleStatus();
                        break;
                    case "stop":
                        await tgApi.sendMessage("🔴 Commander apagándose...");
                        running = false;
                        break;
                    case "session":
                        await dispatcher.handleSession();
                        break;
                    case "session_clear":
                        await dispatcher.handleSessionClear();
                        break;
                    case "skill":
                        dispatcher.handleSkill(cmd.skill, cmd.args).catch(e => {
                            log("Error en handleSkill: " + e.message);
                            tgApi.sendMessage("❌ Error: <code>" + tgApi.escHtml(e.message) + "</code>").catch(() => {});
                        });
                        break;
                    case "freetext": {
                        const pendingPerms = getPendingQuestions().filter(q => q.type === "permission");
                        if (pendingPerms.length > 0) {
                            const q = pendingPerms[pendingPerms.length - 1];
                            const trimmedText = cmd.text.trim().toLowerCase();
                            const permAction = dispatcher.matchPermissionKeyword(cmd.text);

                            if (trimmedText === "cancelar permiso" || trimmedText === "cancel" || trimmedText === "cancelar") {
                                resolveQuestion(q.id, "cancelled");
                                await tgApi.sendMessage("⏹ Permiso cancelado. Claude continuará en consola.");
                                break;
                            }

                            if (permAction) {
                                await dispatcher.handleTextPermissionReply(q, permAction, CHAT_ID);
                                break;
                            }
                            const actionStr = q.action_data && q.action_data.tool_name ? tgApi.escHtml(q.action_data.tool_name) : "un tool";
                            await tgApi.sendMessage("⚠️ <b>Hay un permiso bloqueante pendiente</b> para " + actionStr + ".\n\n"
                                + "Respondé con:\n"
                                + "• <b>si</b> — permitir solo esta vez\n"
                                + "• <b>siempre</b> — permitir y recordar\n"
                                + "• <b>no</b> — denegar\n"
                                + "• <b>cancelar permiso</b> — cancelar y continuar en consola");
                            break;
                        }

                        const permAction = dispatcher.matchPermissionKeyword(cmd.text);
                        if (permAction) {
                            const expiredPerms = getExpiredQuestions().filter(q =>
                                q.type === "permission" &&
                                Date.now() - new Date(q.timestamp).getTime() < 5 * 60 * 1000
                            );
                            if (expiredPerms.length > 0 && permAction !== "deny") {
                                const q = expiredPerms[expiredPerms.length - 1];
                                await dispatcher.handleLatePermissionReply(q, permAction, CHAT_ID);
                                break;
                            }
                        }
                        dispatcher.handleFreetext(cmd.text).catch(e => {
                            log("Error en handleFreetext: " + e.message);
                            tgApi.sendMessage("❌ Error: <code>" + tgApi.escHtml(e.message) + "</code>").catch(() => {});
                        });
                        break;
                    }
                    case "sprint":
                        sprintManager.handleSprint(cmd.agentNumber).catch(e => {
                            log("Error en handleSprint: " + e.message);
                            tgApi.sendMessage("❌ Error sprint: <code>" + tgApi.escHtml(e.message) + "</code>").catch(() => {});
                        });
                        break;
                    case "sprint_interval":
                        await sprintManager.handleSprintInterval(cmd.minutes);
                        break;
                    case "pendientes":
                        await dispatcher.handlePendientes();
                        break;
                    case "retry":
                        await dispatcher.handleRetry();
                        break;
                    case "limpiar":
                        await dispatcher.handleLimpiar();
                        break;
                    case "reset":
                        dispatcher.handleReset(cmd.confirmed).catch(e => {
                            log("Error en handleReset: " + e.message);
                            tgApi.sendMessage("❌ Error en reset: <code>" + tgApi.escHtml(e.message) + "</code>").catch(() => {});
                        });
                        break;
                    case "restart":
                        await dispatcher.handleRestart();
                        break;
                    case "detalle":
                        dispatcher.handleDetalle().catch(e => {
                            log("Error en handleDetalle: " + e.message);
                            tgApi.sendMessage("❌ Error: <code>" + tgApi.escHtml(e.message) + "</code>").catch(() => {});
                        });
                        break;
                    case "reset_sprint":
                        dispatcher.handleResetSprint(cmd.confirmed).catch(e => {
                            log("Error en handleResetSprint: " + e.message);
                            tgApi.sendMessage("❌ Error: <code>" + tgApi.escHtml(e.message) + "</code>").catch(() => {});
                        });
                        break;
                    case "dash_section":
                        // Comandos /dash-* — screenshot de sección del dashboard (#1765)
                        dispatcher.handleDashSection(cmd.section).catch(e => {
                            log("Error en handleDashSection: " + e.message);
                            tgApi.sendMessage("❌ Error capturando sección: <code>" + tgApi.escHtml(e.message) + "</code>").catch(() => {});
                        });
                        break;
                    case "unknown_command":
                        await tgApi.sendMessage("❓ Comando <code>/" + tgApi.escHtml(cmd.command) + "</code> no reconocido.\nUsá /help para ver los skills disponibles.");
                        break;
                }
            } catch (e) {
                log("Error procesando comando: " + e.message);
                try {
                    await tgApi.sendMessage("⚠️ Error: <code>" + tgApi.escHtml(e.message) + "</code>");
                } catch (e2) {}
            }
        }
    }
}

// ─── Shutdown ────────────────────────────────────────────────────────────────

async function shutdown(signal) {
    if (!running) return;
    running = false;
    sprintManager.setRunning(false);
    log("Shutdown por " + signal);

    sprintManager.stopSprintMonitor();
    stopPendingQuestionsWatch();
    if (cleanupInterval) { clearInterval(cleanupInterval); cleanupInterval = null; }
    if (outboxDrainInterval) { clearInterval(outboxDrainInterval); outboxDrainInterval = null; }
    if (suggesterInterval) { clearInterval(suggesterInterval); suggesterInterval = null; }
    if (agentMonitor) { try { agentMonitor.stopAgentMonitor(); } catch (e) {} }
    if (processSupervisor) { try { processSupervisor.stopSupervision(); } catch (e) {} }

    try {
        await tgApi.sendMessage("🔴 <b>Commander offline</b> (" + signal + ")");
    } catch (e) {
        log("Error enviando mensaje de shutdown: " + e.message);
    }

    lockManager.releaseLock();
    process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

// Capturar errores no manejados
let _uncaughtErrorCount = 0;
const UNCAUGHT_THRESHOLD = 3;
const UNCAUGHT_RESET_MS = 60000;
let _uncaughtResetTimer = null;

process.on("uncaughtException", (e) => {
    _uncaughtErrorCount++;
    log("uncaughtException (" + _uncaughtErrorCount + "/" + UNCAUGHT_THRESHOLD + "): " + e.message + (e.stack ? "\n" + e.stack : ""));
    if (_uncaughtErrorCount >= UNCAUGHT_THRESHOLD) {
        log("Demasiados errores no manejados — cerrando commander");
        lockManager.releaseLock();
        process.exit(1);
    }
    clearTimeout(_uncaughtResetTimer);
    _uncaughtResetTimer = setTimeout(() => { _uncaughtErrorCount = 0; }, UNCAUGHT_RESET_MS);
});
process.on("unhandledRejection", (reason) => {
    _uncaughtErrorCount++;
    log("unhandledRejection (" + _uncaughtErrorCount + "/" + UNCAUGHT_THRESHOLD + "): " + String(reason));
    if (_uncaughtErrorCount >= UNCAUGHT_THRESHOLD) {
        log("Demasiados rejections no manejadas — cerrando commander");
        lockManager.releaseLock();
        process.exit(1);
    }
    clearTimeout(_uncaughtResetTimer);
    _uncaughtResetTimer = setTimeout(() => { _uncaughtErrorCount = 0; }, UNCAUGHT_RESET_MS);
});

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
    log("Arrancando Commander...");

    lockManager.acquireLock();

    // Descubrir skills
    skills = dispatcher.discoverSkills(SKILLS_DIR);
    dispatcher.setSkills(skills);
    sprintManager.setSkills(skills);
    callbackHandler.setSkills(skills);
    log("Skills descubiertos: " + skills.map(s => s.name).join(", ") + " (" + skills.length + ")");

    if (skills.length === 0) {
        log("ADVERTENCIA: no se encontraron skills en " + SKILLS_DIR);
    }

    // Backup de API keys
    try {
        const guardian = require("./api-keys-guardian");
        guardian.backup();
    } catch (e) {
        log("[guardian] No se pudo hacer backup de keys: " + e.message);
    }

    // Notificar arranque
    try {
        let msg = "🟢 <b>Commander online</b>\n\n";
        msg += "🔧 " + skills.length + " skills disponibles\n";
        msg += "🆔 PID: " + process.pid + "\n";
        msg += "Enviá /help para ver los comandos.";
        await tgApi.sendMessage(msg);
    } catch (e) {
        log("Error enviando mensaje de arranque: " + e.message);
        console.error("No se pudo enviar mensaje a Telegram:", e.message);
        lockManager.releaseLock();
        process.exit(1);
    }

    // Limpiar preguntas pendientes de sesiones anteriores
    await cleanStaleQuestionsOnStartup();

    // Cleanup de mensajes antiguos al arranque
    try {
        const startupCleanup = await cleanupMessages(CLEANUP_TTL_MS);
        if (startupCleanup.total > 0) {
            log("Cleanup de arranque: " + startupCleanup.deleted + " borrados, " + startupCleanup.failed + " fallidos");
        }
    } catch (e) {
        log("Error en cleanup de arranque: " + e.message);
    }

    // Cleanup periódico
    cleanupInterval = setInterval(async () => {
        try {
            const result = await cleanupMessages(CLEANUP_TTL_MS);
            if (result.total > 0) {
                log("Cleanup periódico: " + result.deleted + " borrados, " + result.failed + " fallidos");
            }
        } catch (e) {
            log("Error en cleanup periódico: " + e.message);
        }
    }, CLEANUP_INTERVAL_MS);

    // Permission suggester (#1280)
    if (permissionSuggester) {
        setTimeout(async () => {
            try {
                const result = await permissionSuggester.analyzeSuggestions();
                log("Permission suggester startup: " + result.sent + " sugerencias enviadas");
            } catch (e) {
                log("Error en permission suggester startup: " + e.message);
            }
        }, 30000);

        suggesterInterval = setInterval(async () => {
            try {
                const result = await permissionSuggester.analyzeSuggestions();
                if (result.sent > 0) {
                    log("Permission suggester periódico: " + result.sent + " sugerencias enviadas");
                }
            } catch (e) {
                log("Error en permission suggester periódico: " + e.message);
            }
        }, SUGGESTER_INTERVAL_MS);
        log("Permission suggester iniciado (cada " + Math.round(SUGGESTER_INTERVAL_MS / 3600000) + "h)");
    }

    // PQ Watch
    startPendingQuestionsWatch();

    // Outbox drain
    if (outboxModule) {
        outboxDrainInterval = outboxModule.startDrainLoop();
        log("Outbox drain iniciado (cada " + outboxModule.DRAIN_INTERVAL_MS + "ms)");
    }

    // Ops learnings
    if (opsLearnings) {
        try {
            const mitigated = opsLearnings.autoMitigate();
            const archived = opsLearnings.archiveOld();
            if (mitigated > 0 || archived > 0) {
                log("Ops learnings: " + mitigated + " mitigados, " + archived + " archivados");
            }
            if (opsLearnings.shouldSendDigest()) {
                const digest = opsLearnings.getDigest();
                if (digest) {
                    await tgApi.sendMessage(digest, { silent: true });
                    opsLearnings.markDigestSent();
                    log("Ops learnings digest semanal enviado");
                }
            }
        } catch (e) {
            log("Error en ops-learnings startup: " + e.message);
        }
    }

    // Process supervisor
    if (processSupervisor) {
        processSupervisor.startSupervision();
        processSupervisor.register(process.pid, "commander", { policy: "ignore" });
        log("Process supervisor iniciado");
    }

    // Agent monitor
    if (agentMonitor) {
        const amStatus = agentMonitor.startAgentMonitor(null, {
            onAllDone: async () => {
                log("Sprint finalizado — reporte generado automáticamente por agent-monitor.js");
            }
        });
        log("Agent monitor iniciado" + (amStatus.watching ? " (watch + guardian)" : " (guardian only)"));
    }

    // Polling principal
    await pollingLoop();

    log("Loop terminado.");
    lockManager.releaseLock();
    process.exit(0);
}

main().catch((e) => {
    log("Error fatal: " + e.message);
    console.error("Error fatal:", e);
    lockManager.releaseLock();
    process.exit(1);
});
