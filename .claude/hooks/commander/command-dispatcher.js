// commander/command-dispatcher.js — Parsing de comandos y dispatch de handlers
// Responsabilidad: parsear texto → comando, ejecutar handlers de /help, /status, etc.
"use strict";

const fs = require("fs");
const path = require("path");
const { getPendingQuestions, getExpiredQuestions, retryQuestion, resolveQuestion, getQuestionById } = require("../pending-questions");
const { generatePattern, getSettingsPaths, persistPattern } = require("../permission-utils");
const { getStats: getRegistryStats } = require("../telegram-message-registry");
const { cleanup: cleanupMessages } = require("../telegram-cleanup");

// ─── Constantes ──────────────────────────────────────────────────────────────
const CLEANUP_TTL_MS = 4 * 60 * 60 * 1000; // 4 horas

// ─── Dependencias inyectadas ─────────────────────────────────────────────────
let _tgApi = null;
let _cmdContext = null;
let _sessionManager = null;
let _sprintManager = null;
let _log = console.log;
let _repoRoot = null;
let _hooksDir = null;
let _skills = [];

function init(config) {
    _tgApi = config.tgApi;
    _cmdContext = config.cmdContext;
    _sessionManager = config.sessionManager;
    _sprintManager = config.sprintManager;
    _log = config.log || console.log;
    _repoRoot = config.repoRoot;
    _hooksDir = config.hooksDir;
    _skills = config.skills || [];
}

function setSkills(s) { _skills = s; }

// ─── Skill discovery ─────────────────────────────────────────────────────────

function discoverSkills(skillsDir) {
    const discovered = [];
    let dirs;
    try {
        dirs = fs.readdirSync(skillsDir);
    } catch (e) {
        _log("Error leyendo directorio de skills: " + e.message);
        return discovered;
    }

    for (const dir of dirs) {
        const skillFile = path.join(skillsDir, dir, "SKILL.md");
        if (!fs.existsSync(skillFile)) continue;

        try {
            const content = fs.readFileSync(skillFile, "utf8");
            const frontmatter = parseFrontmatter(content);
            if (!frontmatter) continue;
            if (frontmatter["user-invocable"] !== true && frontmatter["user-invocable"] !== "true") continue;

            discovered.push({
                name: dir,
                description: frontmatter.description || dir,
                allowedTools: frontmatter["allowed-tools"] || "",
                argumentHint: frontmatter["argument-hint"] || "",
                model: frontmatter.model || ""
            });
        } catch (e) {
            _log("Error parseando skill " + dir + ": " + e.message);
        }
    }

    return discovered;
}

function parseFrontmatter(content) {
    const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!match) return null;

    const lines = match[1].split(/\r?\n/);
    const result = {};
    for (const line of lines) {
        const idx = line.indexOf(":");
        if (idx <= 0) continue;
        const key = line.substring(0, idx).trim();
        let value = line.substring(idx + 1).trim();
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
            value = value.substring(1, value.length - 1);
        }
        if (value === "true") value = true;
        else if (value === "false") value = false;
        result[key] = value;
    }
    return result;
}

// ─── Command parsing ─────────────────────────────────────────────────────────

function parseCommand(text) {
    if (!text || typeof text !== "string") return null;
    const trimmed = text.trim().replace(/@\S+/, "");

    if (trimmed === "/help" || trimmed === "/start") return { type: "help" };
    if (trimmed === "/status") return { type: "status" };
    if (trimmed === "/stop") return { type: "stop" };
    if (trimmed === "/pendientes") return { type: "pendientes" };
    if (trimmed === "/retry") return { type: "retry" };
    if (trimmed === "/limpiar") return { type: "limpiar" };
    if (trimmed === "/restart") return { type: "restart" };
    if (trimmed === "/session") return { type: "session" };
    if (trimmed === "/session clear") return { type: "session_clear" };

    if (trimmed.startsWith("/sprint")) {
        const parts = trimmed.split(/\s+/);
        if (parts[1] === "interval") {
            const mins = parseInt(parts[2], 10);
            return { type: "sprint_interval", minutes: isNaN(mins) ? null : mins };
        }
        const arg = parts[1] || null;
        return { type: "sprint", agentNumber: arg ? parseInt(arg, 10) : null };
    }

    if (trimmed.startsWith("/")) {
        const parts = trimmed.substring(1).split(/\s+/);
        const cmd = parts[0].toLowerCase();
        const args = parts.slice(1).join(" ");

        const skill = _skills.find(s => s.name === cmd);
        if (skill) {
            return { type: "skill", skill: skill, args: args };
        }

        return { type: "unknown_command", command: cmd };
    }

    if (trimmed.length > 0) {
        return { type: "freetext", text: trimmed };
    }

    return null;
}

// ─── Permisos por texto libre ────────────────────────────────────────────────

function matchPermissionKeyword(text) {
    const t = text.trim().toLowerCase();
    if (["si", "sí", "s", "1", "ok", "dale", "allow"].includes(t)) return "allow";
    if (["siempre", "always", "2"].includes(t)) return "always";
    if (["no", "n", "3", "deny", "denegar"].includes(t)) return "deny";
    return null;
}

function persistPermissionFromActionData(actionData) {
    const toolName = actionData.tool_name;
    const toolInput = actionData.tool_input || {};

    const pattern = generatePattern(toolName, toolInput);
    if (!pattern) {
        _log("persistPermissionFromActionData: no se pudo generar patrón para " + toolName);
        return;
    }

    const settingsPaths = getSettingsPaths(_repoRoot);
    persistPattern(pattern, settingsPaths, _log);
    _log("Permiso persistido via retry: " + pattern);
}

async function handleTextPermissionReply(question, action, msgChatId) {
    const requestId = question.id;
    _log("Permiso por texto: " + action + " para " + requestId);

    resolveQuestion(requestId, "answered", "telegram", action);

    if (action === "always" && question.action_data) {
        persistPermissionFromActionData(question.action_data);
    }

    const confirmText = { allow: "✅ Permitido", always: "✅ Permitido siempre", deny: "❌ Denegado" }[action] || "OK";
    const emojiDecision = { allow: "✅", always: "✅✅", deny: "❌" }[action] || "•";
    if (question.telegram_message_id) {
        const originalHtml = question.original_html || _tgApi.escHtml(question.message || "Permiso solicitado");
        const cleanHtml = originalHtml.replace(/\n📝 (?:Responder|Usar botones).*$/s, "");
        try {
            await _tgApi.telegramPost("editMessageText", {
                chat_id: _tgApi.getChatId(),
                message_id: question.telegram_message_id,
                text: cleanHtml + "\n\n" + emojiDecision + " <b>" + confirmText + "</b> <i>(via texto)</i>",
                parse_mode: "HTML",
                reply_markup: { inline_keyboard: [] }
            }, 5000);
        } catch (e) {
            _log("Error editando mensaje permiso (texto): " + (e.message || ""));
        }
    }

    await _tgApi.sendMessage(confirmText);
    _log("Permiso procesado via texto: " + action + " para " + requestId);
}

async function handleLatePermissionReply(question, action, msgChatId) {
    const requestId = question.id;
    _log("Permiso tardío por texto: " + action + " para " + requestId);

    if (action === "always" && question.action_data) {
        persistPermissionFromActionData(question.action_data);
        resolveQuestion(requestId, "answered", "telegram_late", action);
        if (question.telegram_message_id) {
            const originalHtml = question.original_html || _tgApi.escHtml(question.message || "Permiso solicitado");
            const cleanHtml = originalHtml.replace(/\n📝 Responder.*$/s, "").replace(/\n⏱.*$/s, "");
            try {
                await _tgApi.telegramPost("editMessageText", {
                    chat_id: _tgApi.getChatId(),
                    message_id: question.telegram_message_id,
                    text: cleanHtml + "\n\n✅✅ <b>Guardado siempre</b> <i>(tardío)</i>",
                    parse_mode: "HTML"
                }, 5000);
            } catch (e) { /* ok */ }
        }
        await _tgApi.sendMessage("⏱ El hook ya expiró, pero guardé el permiso para la próxima vez");
    } else if (action === "allow") {
        resolveQuestion(requestId, "answered", "telegram_late", action);
        await _tgApi.sendMessage("⏱ El hook ya expiró — el permiso puntual no aplica. Usá <b>siempre</b> para guardarlo.");
    }
}

// ─── Handlers de comandos ────────────────────────────────────────────────────

async function handleHelp() {
    let msg = "🤖 <b>Telegram Commander</b>\n\n";
    msg += "<b>Skills disponibles:</b>\n";
    for (const skill of _skills) {
        const hint = skill.argumentHint ? " <code>" + _tgApi.escHtml(skill.argumentHint) + "</code>" : "";
        msg += "  /" + _tgApi.escHtml(skill.name) + hint + "\n";
        msg += "    <i>" + _tgApi.escHtml(skill.description) + "</i>\n";
    }
    msg += "\n<b>Comandos especiales:</b>\n";
    msg += "  /sprint — Ejecutar sprint completo (secuencial)\n";
    msg += "  /sprint N — Ejecutar solo agente N del plan\n";
    msg += "  /sprint interval N — Cambiar intervalo del monitor periódico (N minutos)\n";
    msg += "  /session — Estado de la sesión conversacional activa\n";
    msg += "  /session clear — Limpiar sesión e iniciar conversación nueva\n";
    msg += "  /help — Esta lista\n";
    msg += "  /status — Estado del daemon\n";
    msg += "  /stop — Detener el commander\n";
    msg += "  /pendientes — Preguntas pendientes sin responder\n";
    msg += "  /retry — Reactivar permisos expirados\n";
    msg += "  /limpiar — Borrar mensajes con más de 4 horas\n";
    msg += "  /restart — Reinicio operativo completo (state files + verificaciones)\n";
    const monIntervalMin = Math.round(_sprintManager.getSprintMonitorIntervalMs() / 60000);
    msg += "\n<b>Monitor periódico:</b>\n";
    msg += "  Durante un sprint, se envía automáticamente un dashboard cada " + monIntervalMin + " min.\n";
    msg += "\n<b>Multimedia:</b>\n";
    msg += "  📷 Foto → Claude analiza (vision)\n";
    msg += "  🎤 Audio/voz → transcripción + Claude responde";
    // Accedemos a multimedia config a través del contexto
    const mmConfig = _cmdContext.getMultimediaConfig ? _cmdContext.getMultimediaConfig() : {};
    if (mmConfig.elevenlabsApiKey) msg += " + TTS (ElevenLabs)";
    else if (mmConfig.openaiApiKey) msg += " + TTS (OpenAI)";
    msg += "\n";
    if (!mmConfig.anthropicApiKey) msg += "  <i>⚠️ Imágenes: falta anthropic_api_key</i>\n";
    if (!mmConfig.elevenlabsApiKey && !mmConfig.openaiApiKey) msg += "  <i>⚠️ Audio TTS: falta elevenlabs_api_key u openai_api_key</i>\n";
    msg += "\n<b>Texto libre:</b> cualquier mensaje sin / se ejecuta como prompt directo.";
    await _tgApi.sendLongMessage(msg);
}

async function handleStatus() {
    const uptime = process.uptime();
    const hours = Math.floor(uptime / 3600);
    const mins = Math.floor((uptime % 3600) / 60);
    const secs = Math.floor(uptime % 60);

    let msg = "📊 <b>Commander Status</b>\n\n";
    msg += "🟢 Online\n";
    msg += "⏱ Uptime: " + hours + "h " + mins + "m " + secs + "s\n";
    msg += "🔧 Skills: " + _skills.length + "\n";
    msg += "🆔 PID: " + process.pid + "\n";
    msg += "📁 Repo: <code>" + _tgApi.escHtml(_repoRoot) + "</code>\n";

    const session = _sessionManager.loadSession();
    if (session && !_sessionManager.isSessionExpired(session)) {
        const elapsed = Date.now() - new Date(session.last_used).getTime();
        const remainingMins = Math.max(0, Math.floor((_sessionManager.SESSION_TTL_MS - elapsed) / 60000));
        msg += "\n🔗 <b>Sesión activa</b>\n";
        msg += "🏷 Skill: " + _tgApi.escHtml(session.skill || "(texto libre)") + "\n";
        msg += "⏳ Expira en: " + remainingMins + " min\n";
    } else {
        msg += "\n💬 Sin sesión activa\n";
    }

    if (_sprintManager.isSprintRunning()) {
        msg += "\n🏃 <b>Sprint en curso</b>\n";
        msg += "📊 Monitor periódico: activo (cada " + Math.round(_sprintManager.getSprintMonitorIntervalMs() / 60000) + " min)\n";
    } else {
        msg += "\n💤 Sin sprint activo\n";
        msg += "📊 Intervalo de monitor: " + Math.round(_sprintManager.getSprintMonitorIntervalMs() / 60000) + " min\n";
    }

    const regStats = getRegistryStats();
    msg += "\n📨 <b>Message registry</b>\n";
    msg += "📊 Total: " + regStats.total + " mensajes\n";
    if (regStats.total > 0) {
        const cats = Object.entries(regStats.byCategory).map(([k, v]) => k + ":" + v).join(", ");
        msg += "🏷 Categorías: " + _tgApi.escHtml(cats) + "\n";
        if (regStats.oldest) {
            const ageH = Math.round((Date.now() - regStats.oldest) / 3600000);
            msg += "🕐 Más antiguo: hace " + ageH + "h\n";
        }
    }

    await _tgApi.sendMessage(msg);
}

async function handleSession() {
    const session = _sessionManager.loadSession();
    if (!session || _sessionManager.isSessionExpired(session)) {
        await _tgApi.sendMessage("💤 <b>Sin sesión activa</b>\n\nEl próximo mensaje iniciará una sesión nueva.");
        return;
    }
    const elapsed = Date.now() - new Date(session.last_used).getTime();
    const remainingMs = _sessionManager.SESSION_TTL_MS - elapsed;
    const remainingMins = Math.max(0, Math.floor(remainingMs / 60000));
    const remainingSecs = Math.max(0, Math.floor((remainingMs % 60000) / 1000));

    let msg = "🔗 <b>Sesión activa</b>\n\n";
    msg += "🆔 ID: <code>" + _tgApi.escHtml(session.session_id) + "</code>\n";
    msg += "🏷 Skill: " + _tgApi.escHtml(session.skill || "(texto libre)") + "\n";
    msg += "📅 Creada: " + _tgApi.escHtml(session.created_at || "?") + "\n";
    msg += "🕐 Último uso: " + _tgApi.escHtml(session.last_used || "?") + "\n";
    msg += "⏳ Expira en: " + remainingMins + "m " + remainingSecs + "s\n";
    msg += "\nUsá <code>/session clear</code> para iniciar una sesión nueva.";
    await _tgApi.sendMessage(msg);
}

async function handleSessionClear() {
    _sessionManager.clearSessionStore();
    await _tgApi.sendMessage("🗑 <b>Sesión limpiada</b>\n\nEl próximo mensaje iniciará una conversación nueva.");
}

async function handlePendientes() {
    const pending = getPendingQuestions();
    if (pending.length === 0) {
        await _tgApi.sendMessage("✅ No hay preguntas pendientes.");
        return;
    }

    let msg = "📋 <b>Preguntas pendientes (" + pending.length + ")</b>\n\n";
    const keyboard = [];

    for (let i = 0; i < pending.length; i++) {
        const q = pending[i];
        const age = Math.round((Date.now() - new Date(q.timestamp).getTime()) / 60000);
        const typeEmoji = { permission: "🔐", sprint: "🚀", proposal: "💡" }[q.type] || "❓";

        msg += typeEmoji + " <b>" + (i + 1) + ".</b> " + _tgApi.escHtml(q.message).substring(0, 80) + "\n";
        msg += "   <i>" + q.type + " — hace " + age + " min</i>\n\n";

        if (q.type === "sprint") {
            keyboard.push([
                { text: "🚀 " + (i + 1) + ". Planificar sprint", callback_data: "pq_yes:" + q.id },
                { text: "⏹ " + (i + 1) + ". Descartar", callback_data: "pq_dismiss:" + q.id }
            ]);
        } else if (q.type === "permission") {
            keyboard.push([
                { text: "✅ " + (i + 1) + ". Permitir", callback_data: "pq_allow:" + q.id },
                { text: "❌ " + (i + 1) + ". Descartar", callback_data: "pq_dismiss:" + q.id }
            ]);
        } else {
            keyboard.push([
                { text: "▶️ " + (i + 1) + ". Ejecutar", callback_data: "pq_yes:" + q.id },
                { text: "⏹ " + (i + 1) + ". Descartar", callback_data: "pq_dismiss:" + q.id }
            ]);
        }
    }

    await _tgApi.telegramPost("sendMessage", {
        chat_id: _tgApi.getChatId(),
        text: msg,
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: keyboard }
    }, 8000);
}

async function handleRetry() {
    const expired = getExpiredQuestions();
    if (expired.length === 0) {
        await _tgApi.sendMessage("✅ No hay preguntas expiradas en las últimas 24h.");
        return;
    }

    let msg = "⏱ <b>Preguntas expiradas (" + expired.length + ")</b>\n";
    msg += "<i>Reactivar = aprobar siempre para futuras ejecuciones</i>\n\n";
    const keyboard = [];

    for (let i = 0; i < expired.length; i++) {
        const q = expired[i];
        const age = Math.round((Date.now() - new Date(q.timestamp).getTime()) / 60000);
        const ageLabel = age >= 60 ? Math.floor(age / 60) + "h " + (age % 60) + "m" : age + " min";

        msg += "🔐 <b>" + (i + 1) + ".</b> <code>" + _tgApi.escHtml((q.message || "").substring(0, 80)) + "</code>\n";
        msg += "   <i>hace " + ageLabel + "</i>\n\n";

        keyboard.push([
            { text: "🔄 " + (i + 1) + ". Reactivar", callback_data: "reactivate:" + q.id },
            { text: "⏹ " + (i + 1) + ". Descartar", callback_data: "dismiss_expired:" + q.id }
        ]);
    }

    if (expired.length > 1) {
        keyboard.push([
            { text: "🔄 Reactivar todas", callback_data: "reactivate_all" }
        ]);
    }

    await _tgApi.telegramPost("sendMessage", {
        chat_id: _tgApi.getChatId(),
        text: msg,
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: keyboard }
    }, 8000);
}

async function handleLimpiar() {
    await _tgApi.sendMessage("🧹 Limpiando mensajes con más de 4 horas...");
    try {
        const result = await cleanupMessages(CLEANUP_TTL_MS);
        let msg = "🧹 <b>Limpieza completada</b>\n\n";
        msg += "🗑 Borrados: " + result.deleted + "\n";
        if (result.failed > 0) msg += "⚠️ Fallidos: " + result.failed + "\n";
        msg += "📊 Total procesados: " + result.total;
        if (result.total === 0) {
            msg = "✅ No hay mensajes con más de 4 horas para limpiar.";
        }
        await _tgApi.sendMessage(msg);
    } catch (e) {
        _log("Error en handleLimpiar: " + e.message);
        await _tgApi.sendMessage("⚠️ Error en limpieza: <code>" + _tgApi.escHtml(e.message) + "</code>");
    }
}

async function handleRestart() {
    await _tgApi.sendMessage("🔄 <b>Reinicio operativo</b> en progreso...");
    try {
        const scriptPath = path.join(_repoRoot, "scripts", "restart-operational-system.js");
        if (!fs.existsSync(scriptPath)) {
            await _tgApi.sendMessage("❌ Script no encontrado: <code>scripts/restart-operational-system.js</code>");
            return;
        }
        const { execSync } = require("child_process");
        const output = execSync("node \"" + scriptPath + "\" --json --notify", {
            timeout: 30000,
            encoding: "utf8",
            stdio: ["pipe", "pipe", "pipe"],
        });
        const report = JSON.parse(output);
        const icon = { ok: "✅", partial: "⚠️", error: "❌" };
        const stateResetOk = report.stateFiles.filter(f => f.status === "reset").length;
        const stateTotal = report.stateFiles.length;
        const cleanedCount = (report.processes.cleaned || []).length;

        let msg = "🔄 <b>Restart Operativo Completado</b>\n\n";
        msg += "Estado: " + (icon[report.status] || "❓") + " <b>" + report.status.toUpperCase() + "</b>\n\n";
        msg += "📁 State files: " + stateResetOk + "/" + stateTotal + " reseteados\n";
        msg += (report.telegram.status === "ok" ? "✅" : "❌") + " Telegram\n";
        msg += (report.github.status === "ok" ? "✅" : "❌") + " GitHub CLI" + (report.github.account ? " (" + _tgApi.escHtml(report.github.account) + ")" : "") + "\n";
        msg += (report.java.status === "ok" ? "✅" : "❌") + " Java" + (report.java.version ? " v" + _tgApi.escHtml(report.java.version) : "") + "\n";
        msg += "🧹 Lockfiles limpiados: " + cleanedCount + "\n";
        msg += "⏱ Duración: " + report.durationMs + "ms";

        if (report.status !== "ok") {
            msg += "\n\n<b>Errores:</b>\n";
            if (report.telegram.status === "error") msg += "• Telegram: " + _tgApi.escHtml(report.telegram.error) + "\n";
            if (report.github.status === "error") msg += "• GitHub: " + _tgApi.escHtml(report.github.error) + "\n";
            if (report.java.status === "error") msg += "• Java: " + _tgApi.escHtml(report.java.error) + "\n";
        }

        await _tgApi.sendLongMessage(msg);

        if (report.status !== "ok") {
            await _tgApi.telegramPost("sendMessage", {
                chat_id: _tgApi.getChatId(),
                text: "¿Qué hacer?",
                parse_mode: "HTML",
                reply_markup: {
                    inline_keyboard: [
                        [{ text: "🔄 Reintentar", callback_data: "restart_retry" }],
                        [{ text: "📋 Ver log", callback_data: "restart_log" }],
                    ]
                }
            });
        }
    } catch (e) {
        _log("Error en handleRestart: " + e.message);
        await _tgApi.sendMessage("❌ Error en reinicio: <code>" + _tgApi.escHtml(e.message) + "</code>\n\nIntentar manualmente:\n<code>node scripts/restart-operational-system.js --notify</code>");
    }
}

async function handleSkill(skill, args) {
    if (_cmdContext.isCommandBusy()) {
        const pendingPerms = getPendingQuestions().filter(q => q.type === "permission");
        if (pendingPerms.length > 0) {
            const q = pendingPerms[pendingPerms.length - 1];
            const toolName = q.action_data && q.action_data.tool_name ? _tgApi.escHtml(q.action_data.tool_name) : "un tool";
            await _tgApi.sendMessage("⏳ <b>Hay un permiso bloqueante pendiente</b> para " + toolName + ".\n"
                + "Respondé con: <b>si</b>, <b>siempre</b>, <b>no</b>, o <b>cancelar permiso</b>");
        } else {
            const labels = _cmdContext.getCommandBusyLabel();
            await _tgApi.sendMessage("⏳ Límite de " + _cmdContext.MAX_PARALLEL_COMMANDS + " comandos paralelos alcanzado. Esperá que termine alguno.\nActivos: <code>" + _tgApi.escHtml(labels) + "</code>");
        }
        return;
    }

    // /monitor sin args: screenshot directo
    if (skill.name === "monitor" && (!args || !args.trim())) {
        await _tgApi.sendMessage("\ud83d\udcca Capturando dashboard...");
        await _sprintManager.handleMonitorDashboard();
        return;
    }

    const skillLabel = "/" + skill.name + (args ? " " + args : "");
    const cmdNum = _cmdContext.peekNextCmdNumber();
    const parallelTag = _cmdContext.getActiveCount() > 0 ? " [Cmd #" + cmdNum + "]" : "";
    await _tgApi.sendMessage("⚡" + parallelTag + " Ejecutando <code>" + _tgApi.escHtml(skillLabel) + "</code>...");

    const prompt = "/" + skill.name + (args ? " " + args : "");

    const toolsList = ["Skill"];
    if (skill.allowedTools) {
        const extras = skill.allowedTools.split(",").map(t => t.trim()).filter(t => t);
        for (const t of extras) {
            if (!toolsList.includes(t)) toolsList.push(t);
        }
    }

    const extraArgs = ["--allowedTools", toolsList.join(",")];
    if (skill.model) {
        extraArgs.push("--model", skill.model);
    }

    const result = await _cmdContext.executeClaudeQueued(prompt, extraArgs, { useSession: true, skill: skill.name });
    await _cmdContext.sendResult(skillLabel, result);
}

async function handleFreetext(text) {
    if (_cmdContext.isCommandBusy()) {
        const pendingPerms = getPendingQuestions().filter(q => q.type === "permission");
        if (pendingPerms.length > 0) {
            const q = pendingPerms[pendingPerms.length - 1];
            const toolName = q.action_data && q.action_data.tool_name ? _tgApi.escHtml(q.action_data.tool_name) : "un tool";
            await _tgApi.sendMessage("⏳ <b>Hay un permiso bloqueante pendiente</b> para " + toolName + ".\n"
                + "Respondé con: <b>si</b>, <b>siempre</b>, <b>no</b>, o <b>cancelar permiso</b>");
        } else {
            const labels = _cmdContext.getCommandBusyLabel();
            await _tgApi.sendMessage("⏳ Límite de " + _cmdContext.MAX_PARALLEL_COMMANDS + " comandos paralelos alcanzado. Esperá que termine alguno.\nActivos: <code>" + _tgApi.escHtml(labels) + "</code>");
        }
        return;
    }

    const cmdNum = _cmdContext.peekNextCmdNumber();
    const parallelTag = _cmdContext.getActiveCount() > 0 ? " [Cmd #" + cmdNum + "]" : "";
    await _tgApi.sendMessage("💬" + parallelTag + " Procesando: <code>" + _tgApi.escHtml(text.substring(0, 100)) + (text.length > 100 ? "…" : "") + "</code>");

    await _cmdContext.executeClaudeQueued(text, [], { useSession: true, skill: null });
}

module.exports = {
    init,
    setSkills,
    discoverSkills,
    parseFrontmatter,
    parseCommand,
    matchPermissionKeyword,
    persistPermissionFromActionData,
    handleTextPermissionReply,
    handleLatePermissionReply,
    handleHelp,
    handleStatus,
    handleSession,
    handleSessionClear,
    handlePendientes,
    handleRetry,
    handleLimpiar,
    handleRestart,
    handleSkill,
    handleFreetext,
    CLEANUP_TTL_MS,
};
