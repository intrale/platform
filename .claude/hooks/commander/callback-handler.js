// commander/callback-handler.js — Procesamiento de callbacks inline de Telegram
// Responsabilidad: manejar botones inline (propuestas, permisos, retry, sprint, etc.)
"use strict";

const fs = require("fs");
const path = require("path");
const { getPendingQuestions, getExpiredQuestions, retryQuestion, resolveQuestion, getQuestionById, loadQuestions, saveQuestions } = require("../pending-questions");
const { generatePattern, getSettingsPaths, persistPattern } = require("../permission-utils");
const lastFullResponse = require("../telegram-last-full-response");
const imageUtils = require("../telegram-image-utils");

// ─── Dependencias inyectadas ─────────────────────────────────────────────────
let _tgApi = null;
let _cmdContext = null;
let _log = console.log;
let _repoRoot = null;
let _hooksDir = null;
let _proposalsFile = null;
let _sprintPlanFile = null;
let _skills = [];
let _dispatcher = null;
let _permissionSuggester = null;

function init(config) {
    _tgApi = config.tgApi;
    _cmdContext = config.cmdContext;
    _log = config.log || console.log;
    _repoRoot = config.repoRoot;
    _hooksDir = config.hooksDir;
    _proposalsFile = config.proposalsFile;
    _sprintPlanFile = config.sprintPlanFile;
    _skills = config.skills || [];
    _dispatcher = config.dispatcher;
    _permissionSuggester = config.permissionSuggester;
}

function setSkills(s) { _skills = s; }

// ─── Proposals ───────────────────────────────────────────────────────────────

function loadProposals() {
    try {
        return JSON.parse(fs.readFileSync(_proposalsFile, "utf8"));
    } catch (e) {
        return null;
    }
}

function saveProposals(data) {
    try {
        fs.writeFileSync(_proposalsFile, JSON.stringify(data, null, 2), "utf8");
    } catch (e) {
        _log("Error guardando planner-proposals.json: " + e.message);
    }
}

function buildProposalStatusText(data) {
    const EFFORT_LABELS = { S: "S (1d)", M: "M (2-3d)", L: "L (1sem)", XL: "XL (2+sem)" };
    const STATUS_ICONS = { pending: "⏳", created: "✅", discarded: "❌" };
    let text = "📋 <b>Propuestas del Planner</b>\n";
    text += "<i>Generado: " + _tgApi.escHtml(data.generated_at || "?") + "</i>\n\n";
    for (const p of data.proposals) {
        const icon = STATUS_ICONS[p.status] || "⏳";
        const effort = EFFORT_LABELS[p.effort] || p.effort;
        const statusLabel = p.status === "created" ? " — Creado"
            : p.status === "discarded" ? " — Descartado"
            : "";
        text += icon + " <b>" + (p.index + 1) + ". " + _tgApi.escHtml(p.title) + "</b>" + statusLabel + "\n";
        text += "   📏 " + _tgApi.escHtml(effort) + " · 🏷 " + _tgApi.escHtml((p.labels || []).join(", ")) + "\n";
    }
    return text;
}

function buildRemainingKeyboard(data) {
    const keyboard = [];
    for (const p of data.proposals) {
        if (p.status !== "pending") continue;
        keyboard.push([
            { text: "✅ " + (p.index + 1) + ". Crear", callback_data: "create_proposal:" + p.index },
            { text: "❌ " + (p.index + 1) + ". Descartar", callback_data: "discard_proposal:" + p.index }
        ]);
    }
    const pendingCount = data.proposals.filter(p => p.status === "pending").length;
    if (pendingCount > 1) {
        keyboard.push([
            { text: "✅ Crear todas las propuestas", callback_data: "create_all_proposals" }
        ]);
    }
    return keyboard;
}

async function launchHistoriaForProposal(proposal) {
    const labels = (proposal.labels || []).join(", ");
    const deps = (proposal.dependencies || []).length > 0
        ? "Dependencias: " + proposal.dependencies.map(d => "#" + d).join(", ")
        : "";

    let prompt = "/historia " + proposal.title + "\n\n";
    prompt += "Justificación: " + (proposal.justification || "") + "\n";
    prompt += "Labels: " + labels + "\n";
    prompt += "Esfuerzo estimado: " + (proposal.effort || "M") + "\n";
    prompt += "Stream: " + (proposal.stream || "") + "\n";
    if (deps) prompt += deps + "\n";
    if (proposal.body) prompt += "\nDetalle:\n" + proposal.body + "\n";

    _log("Lanzando /historia para propuesta #" + proposal.index + ": " + proposal.title);
    await _tgApi.sendMessage("⚡ Creando issue: <b>" + _tgApi.escHtml(proposal.title) + "</b>...");

    const historiaSkill = _skills.find(s => s.name === "historia");
    const toolsList = ["Skill"];
    if (historiaSkill && historiaSkill.allowedTools) {
        const extras = historiaSkill.allowedTools.split(",").map(t => t.trim()).filter(t => t);
        for (const t of extras) {
            if (!toolsList.includes(t)) toolsList.push(t);
        }
    }

    const extraArgs = ["--allowedTools", toolsList.join(",")];
    if (historiaSkill && historiaSkill.model) {
        extraArgs.push("--model", historiaSkill.model);
    }

    const result = await _cmdContext.executeClaudeQueued(prompt, extraArgs, { useSession: true, skill: "historia" });
    await _cmdContext.sendResult("/historia — " + proposal.title, result);
}

// ─── Proposal callbacks ─────────────────────────────────────────────────────

async function handleProposalCallback(callbackData, callbackQueryId) {
    const data = loadProposals();
    if (!data || !data.proposals) {
        await _tgApi.telegramPost("answerCallbackQuery", {
            callback_query_id: callbackQueryId,
            text: "No hay propuestas activas",
            show_alert: true
        }, 5000);
        return;
    }

    const msgId = data.telegram_message_id;

    if (callbackData === "create_all_proposals") {
        await _tgApi.telegramPost("answerCallbackQuery", {
            callback_query_id: callbackQueryId,
            text: "Creando todas las propuestas...",
            show_alert: false
        }, 5000);

        const pending = data.proposals.filter(p => p.status === "pending");
        if (pending.length === 0) {
            await _tgApi.sendMessage("⚠️ No hay propuestas pendientes.");
            return;
        }

        for (const p of pending) { p.status = "created"; }
        saveProposals(data);

        if (msgId) {
            try {
                await _tgApi.telegramPost("editMessageText", {
                    chat_id: _tgApi.getChatId(),
                    message_id: msgId,
                    text: buildProposalStatusText(data),
                    parse_mode: "HTML"
                }, 8000);
            } catch (e) { _log("Error editando mensaje de propuestas: " + e.message); }
        }

        for (const p of pending) {
            await launchHistoriaForProposal(p);
        }

        await _tgApi.sendMessage("✅ <b>" + pending.length + " propuesta(s) enviadas a /historia</b>");
        return;
    }

    const parts = callbackData.split(":");
    const action = parts[0];
    const idx = parseInt(parts[1], 10);

    const proposal = data.proposals.find(p => p.index === idx);
    if (!proposal) {
        await _tgApi.telegramPost("answerCallbackQuery", {
            callback_query_id: callbackQueryId,
            text: "Propuesta no encontrada",
            show_alert: true
        }, 5000);
        return;
    }

    if (proposal.status !== "pending") {
        await _tgApi.telegramPost("answerCallbackQuery", {
            callback_query_id: callbackQueryId,
            text: "Propuesta ya procesada: " + proposal.status,
            show_alert: false
        }, 5000);
        return;
    }

    if (action === "create_proposal") {
        proposal.status = "created";
        saveProposals(data);

        await _tgApi.telegramPost("answerCallbackQuery", {
            callback_query_id: callbackQueryId,
            text: "✅ Creando: " + proposal.title.substring(0, 50),
            show_alert: false
        }, 5000);

        if (msgId) {
            try {
                const keyboard = buildRemainingKeyboard(data);
                const editParams = {
                    chat_id: _tgApi.getChatId(),
                    message_id: msgId,
                    text: buildProposalStatusText(data),
                    parse_mode: "HTML"
                };
                if (keyboard.length > 0) {
                    editParams.reply_markup = { inline_keyboard: keyboard };
                }
                await _tgApi.telegramPost("editMessageText", editParams, 8000);
            } catch (e) { _log("Error editando mensaje de propuestas: " + e.message); }
        }

        await launchHistoriaForProposal(proposal);

    } else if (action === "discard_proposal") {
        proposal.status = "discarded";
        saveProposals(data);

        await _tgApi.telegramPost("answerCallbackQuery", {
            callback_query_id: callbackQueryId,
            text: "❌ Descartada: " + proposal.title.substring(0, 50),
            show_alert: false
        }, 5000);

        if (msgId) {
            try {
                const keyboard = buildRemainingKeyboard(data);
                const editParams = {
                    chat_id: _tgApi.getChatId(),
                    message_id: msgId,
                    text: buildProposalStatusText(data),
                    parse_mode: "HTML"
                };
                if (keyboard.length > 0) {
                    editParams.reply_markup = { inline_keyboard: keyboard };
                }
                await _tgApi.telegramPost("editMessageText", editParams, 8000);
            } catch (e) { _log("Error editando mensaje de propuestas: " + e.message); }
        }
    }
}

// ─── Reactivation callbacks ─────────────────────────────────────────────────

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

async function handleReactivateCallback(callbackData, callbackQueryId, messageId) {
    if (callbackData === "reactivate_all") {
        const expired = getExpiredQuestions();
        if (expired.length === 0) {
            await _tgApi.telegramPost("answerCallbackQuery", {
                callback_query_id: callbackQueryId,
                text: "No hay preguntas expiradas",
                show_alert: true
            }, 5000);
            return;
        }

        let persisted = 0;
        const skillsToRelaunch = new Set();
        for (const q of expired) {
            const actionData = retryQuestion(q.id);
            if (actionData && actionData.tool_name) {
                persistPermissionFromActionData(actionData);
                persisted++;
            }
            if (q.skill_context) skillsToRelaunch.add(q.skill_context);
        }

        await _tgApi.telegramPost("answerCallbackQuery", {
            callback_query_id: callbackQueryId,
            text: "🔄 " + persisted + " permisos reactivados",
            show_alert: false
        }, 5000);

        const skillList = Array.from(skillsToRelaunch);
        let editText = "✅ <b>" + persisted + " permisos reactivados</b>\n<i>Próximas ejecuciones se aprobarán automáticamente.</i>";
        const relaunchKeyboard = [];
        if (skillList.length > 0) {
            editText += "\n\n🔄 <b>Skills interrumpidos:</b> " + skillList.map(s => "<code>/" + _tgApi.escHtml(s) + "</code>").join(", ");
            editText += "\n<i>¿Relanzar?</i>";
            for (const s of skillList) {
                relaunchKeyboard.push([
                    { text: "🚀 Relanzar /" + s, callback_data: "relaunch_skill:" + s }
                ]);
            }
        }

        try {
            const editParams = {
                chat_id: _tgApi.getChatId(),
                message_id: messageId,
                text: editText,
                parse_mode: "HTML"
            };
            if (relaunchKeyboard.length > 0) {
                editParams.reply_markup = { inline_keyboard: relaunchKeyboard };
            }
            await _tgApi.telegramPost("editMessageText", editParams, 8000);
        } catch (e) { _log("Error editando mensaje retry: " + e.message); }

        return;
    }

    const parts = callbackData.split(":");
    const action = parts[0];
    const questionId = parts.slice(1).join(":");

    const question = getQuestionById(questionId);
    if (!question) {
        await _tgApi.telegramPost("answerCallbackQuery", {
            callback_query_id: callbackQueryId,
            text: "Pregunta no encontrada",
            show_alert: true
        }, 5000);
        return;
    }

    if (action === "dismiss_expired") {
        resolveQuestion(questionId, "answered");
        await _tgApi.telegramPost("answerCallbackQuery", {
            callback_query_id: callbackQueryId,
            text: "⏹ Descartada",
            show_alert: false
        }, 5000);

        try {
            await _tgApi.telegramPost("editMessageReplyMarkup", {
                chat_id: _tgApi.getChatId(),
                message_id: messageId,
                reply_markup: { inline_keyboard: [] }
            }, 5000);
        } catch (e) { /* ok */ }
        return;
    }

    if (action === "reactivate") {
        if (question.status !== "expired") {
            await _tgApi.telegramPost("answerCallbackQuery", {
                callback_query_id: callbackQueryId,
                text: "Pregunta ya procesada: " + question.status,
                show_alert: false
            }, 5000);
            return;
        }

        const actionData = retryQuestion(questionId);
        if (actionData && actionData.tool_name) {
            persistPermissionFromActionData(actionData);
        }

        await _tgApi.telegramPost("answerCallbackQuery", {
            callback_query_id: callbackQueryId,
            text: "🔄 Permiso reactivado — se aprobará automáticamente",
            show_alert: true
        }, 5000);

        const desc = (question.message || "").substring(0, 80);
        let editText = "🔄 <b>Permiso reactivado</b>\n<code>" + _tgApi.escHtml(desc) + "</code>\n<i>Próximas ejecuciones se aprobarán automáticamente.</i>";
        const relaunchKb = [];
        if (question.skill_context) {
            editText += "\n\n🔄 Skill interrumpido: <code>/" + _tgApi.escHtml(question.skill_context) + "</code>";
            relaunchKb.push([
                { text: "🚀 Relanzar /" + question.skill_context, callback_data: "relaunch_skill:" + question.skill_context }
            ]);
        }
        try {
            const editParams = {
                chat_id: _tgApi.getChatId(),
                message_id: messageId,
                text: editText,
                parse_mode: "HTML"
            };
            if (relaunchKb.length > 0) {
                editParams.reply_markup = { inline_keyboard: relaunchKb };
            }
            await _tgApi.telegramPost("editMessageText", editParams, 5000);
        } catch (e) { _log("Error editando mensaje reactivado: " + e.message); }
        return;
    }
}

// ─── Auto-plan callbacks ────────────────────────────────────────────────────

async function handleAutoPlanCallback(callbackData, callbackQueryId, messageId) {
    if (callbackData === "view_sprint_plan") {
        await _tgApi.telegramPost("answerCallbackQuery", {
            callback_query_id: callbackQueryId,
            text: "📋 Mostrando plan...",
            show_alert: false
        }, 5000);

        let planText = "⚠️ No se encontró sprint-plan.json";
        try {
            if (fs.existsSync(_sprintPlanFile)) {
                const plan = JSON.parse(fs.readFileSync(_sprintPlanFile, "utf8"));
                const agentes = plan.agentes || [];
                const cola = plan.cola || [];
                planText = `📋 <b>Sprint plan</b> — ${_tgApi.escHtml(plan.sprint_id || "?")} (${_tgApi.escHtml(plan.size || "?")})\n`;
                planText += `<i>Priorización: ${_tgApi.escHtml(plan.priorization || "N/A")}</i>\n`;
                planText += `<b>Issues seleccionados:</b> ${plan.total_selected || agentes.length + cola.length}/${plan.max_issues || 5}\n\n`;
                planText += `🚀 <b>Agentes simultáneos (${agentes.length}):</b>\n`;
                for (const a of agentes) {
                    planText += `  ${a.numero}. #${a.issue} — ${_tgApi.escHtml(a.slug)}\n`;
                    planText += `     Stream: ${_tgApi.escHtml(a.stream || "?")}\n`;
                    if (a.labels && a.labels.length > 0) planText += `     Labels: ${_tgApi.escHtml(a.labels.join(", "))}\n`;
                }
                if (cola.length > 0) {
                    planText += `\n⏳ <b>Cola (${cola.length} issues en tandas):</b>\n`;
                    for (const a of cola) {
                        planText += `  ${a.numero}. #${a.issue} — ${_tgApi.escHtml(a.slug)}\n`;
                    }
                }
                planText += `\n<i>Para lanzar: ejecutar Start-Agente.ps1 all en PowerShell</i>`;
            }
        } catch (e) {
            _log("Error leyendo sprint-plan.json: " + e.message);
            planText = "❌ Error leyendo sprint-plan.json: " + _tgApi.escHtml(e.message);
        }

        if (messageId) {
            try {
                await _tgApi.telegramPost("editMessageReplyMarkup", {
                    chat_id: _tgApi.getChatId(),
                    message_id: messageId,
                    reply_markup: { inline_keyboard: [] }
                }, 5000);
            } catch (e) { /* ok */ }
        }
        await _tgApi.sendMessage(planText);
        return;
    }

    if (callbackData === "launch_sprint") {
        await _tgApi.telegramPost("answerCallbackQuery", {
            callback_query_id: callbackQueryId,
            text: "🚀 Confirmado — lanzar Start-Agente.ps1 en PowerShell",
            show_alert: false
        }, 5000);

        if (messageId) {
            try {
                await _tgApi.telegramPost("editMessageReplyMarkup", {
                    chat_id: _tgApi.getChatId(),
                    message_id: messageId,
                    reply_markup: { inline_keyboard: [] }
                }, 5000);
            } catch (e) { /* ok */ }
        }

        await _tgApi.sendMessage(
            "🚀 <b>Sprint listo para lanzar</b>\n\n" +
            "El plan fue generado automáticamente.\n" +
            "Para lanzar los agentes, ejecutar en PowerShell:\n\n" +
            "<code>cd C:\\Workspaces\\Intrale\\platform\\scripts\n" +
            ".\\Start-Agente.ps1 all</code>\n\n" +
            "<i>Los primeros 2 agentes arrancarán en paralelo. Los restantes se activarán automáticamente.</i>"
        );
    }
}

// ─── Pending question callbacks ──────────────────────────────────────────────

async function handlePendingCallback(callbackData, callbackQueryId) {
    const parts = callbackData.split(":");
    const action = parts[0];
    const questionId = parts.slice(1).join(":");

    const question = getQuestionById(questionId);
    if (!question || question.status !== "pending") {
        await _tgApi.telegramPost("answerCallbackQuery", {
            callback_query_id: callbackQueryId,
            text: "Pregunta ya resuelta o no encontrada",
            show_alert: true
        }, 5000);
        return;
    }

    if (action === "pq_dismiss") {
        resolveQuestion(questionId, "answered");
        await _tgApi.telegramPost("answerCallbackQuery", {
            callback_query_id: callbackQueryId,
            text: "⏹ Descartada",
            show_alert: false
        }, 5000);
        await _tgApi.sendMessage("⏹ Pregunta descartada: <i>" + _tgApi.escHtml(question.message).substring(0, 60) + "</i>");
        return;
    }

    if (action === "pq_yes" && question.type === "sprint") {
        resolveQuestion(questionId, "answered");
        await _tgApi.telegramPost("answerCallbackQuery", {
            callback_query_id: callbackQueryId,
            text: "🚀 Lanzando sprint...",
            show_alert: false
        }, 5000);
        await _tgApi.sendMessage("🚀 Lanzando <code>/planner sprint</code> desde pregunta pendiente...");
        await _cmdContext.executeClaudeQueued("/planner sprint", []);
        return;
    }

    if (action === "pq_allow" && question.type === "permission") {
        resolveQuestion(questionId, "answered");
        await _tgApi.telegramPost("answerCallbackQuery", {
            callback_query_id: callbackQueryId,
            text: "✅ Nota: el permiso original ya expiró. Registrado para referencia.",
            show_alert: true
        }, 5000);
        await _tgApi.sendMessage("✅ Pregunta de permiso resuelta. <i>Nota: la sesión original ya terminó, el permiso se aplicará en futuras solicitudes similares.</i>");
        return;
    }

    // Fallback
    resolveQuestion(questionId, "answered");
    await _tgApi.telegramPost("answerCallbackQuery", {
        callback_query_id: callbackQueryId,
        text: "✅ Procesado",
        show_alert: false
    }, 5000);
    if (question.action_data && question.action_data.command) {
        await _tgApi.sendMessage("▶️ Ejecutando: <code>" + _tgApi.escHtml(question.action_data.command) + "</code>");
        await _cmdContext.executeClaudeQueued(question.action_data.command, []);
    }
}

// ─── Router principal de callbacks ───────────────────────────────────────────

async function routeCallback(cbData, callbackQueryId, message) {
    const chatId = message && message.chat && message.chat.id;
    const messageId = message && message.message_id;

    if (String(chatId) !== String(_tgApi.getChatId())) return false;

    try {
        // Propuestas
        if (cbData.startsWith("create_proposal:") || cbData.startsWith("discard_proposal:") || cbData === "create_all_proposals") {
            _log("Callback de propuesta recibido: " + cbData);
            await handleProposalCallback(cbData, callbackQueryId);
            return true;
        }

        // Auto-plan
        if (cbData === "launch_sprint" || cbData === "view_sprint_plan") {
            _log("Callback de auto-plan: " + cbData);
            await handleAutoPlanCallback(cbData, callbackQueryId, messageId);
            return true;
        }

        // Reactivación (legacy)
        if (cbData.startsWith("reactivate:") || cbData.startsWith("dismiss_expired:") || cbData === "reactivate_all") {
            _log("Callback de reactivación: " + cbData);
            await handleReactivateCallback(cbData, callbackQueryId, messageId);
            return true;
        }

        // Restart
        if (cbData === "restart_retry" || cbData === "restart_log") {
            await _tgApi.telegramPost("answerCallbackQuery", {
                callback_query_id: callbackQueryId,
                text: cbData === "restart_retry" ? "Reintentando..." : "Leyendo log...",
                show_alert: false
            }, 5000);
            try {
                await _tgApi.telegramPost("editMessageReplyMarkup", {
                    chat_id: _tgApi.getChatId(),
                    message_id: messageId,
                    reply_markup: { inline_keyboard: [] }
                }, 5000);
            } catch (e) { /* ok */ }

            if (cbData === "restart_retry") {
                await _dispatcher.handleRestart();
            } else {
                const logPath = path.join(_hooksDir, "restart-log.jsonl");
                try {
                    const lines = fs.readFileSync(logPath, "utf8").trim().split("\n").slice(-5);
                    let msg = "📋 <b>Últimos reinicios:</b>\n\n";
                    for (const line of lines) {
                        try {
                            const entry = JSON.parse(line);
                            const icon = { ok: "✅", partial: "⚠️", error: "❌" }[entry.status] || "❓";
                            msg += icon + " " + entry.timestamp;
                            if (entry.errors && entry.errors.length > 0) {
                                msg += " — " + entry.errors.length + " error(es)";
                            }
                            msg += "\n";
                        } catch { msg += "• (entrada inválida)\n"; }
                    }
                    await _tgApi.sendLongMessage(msg);
                } catch (e) {
                    await _tgApi.sendMessage("📋 No hay log de reinicios aún.");
                }
            }
            return true;
        }

        // Relanzar skill
        if (cbData.startsWith("relaunch_skill:")) {
            const skillName = cbData.substring("relaunch_skill:".length);
            _log("Callback de relanzar skill: " + skillName);
            await _tgApi.telegramPost("answerCallbackQuery", {
                callback_query_id: callbackQueryId,
                text: "🚀 Relanzando /" + skillName + "...",
                show_alert: false
            }, 5000);
            try {
                await _tgApi.telegramPost("editMessageReplyMarkup", {
                    chat_id: _tgApi.getChatId(),
                    message_id: messageId,
                    reply_markup: { inline_keyboard: [] }
                }, 5000);
            } catch (e) { /* ok */ }
            const skill = _skills.find(s => s.name === skillName);
            if (skill) {
                await _dispatcher.handleSkill(skill, "");
            } else {
                await _tgApi.sendMessage("⚠️ Skill <code>/" + _tgApi.escHtml(skillName) + "</code> no encontrado.");
            }
            return true;
        }

        // Permisos (botones inline)
        if (cbData.startsWith("allow:") || cbData.startsWith("always:") || cbData.startsWith("deny:")) {
            const parts = cbData.split(":");
            const permAction = parts[0];
            const cbRequestId = parts.slice(1).join(":");
            _log("Callback de permiso: action=" + permAction + " requestId=" + cbRequestId + " msgId=" + messageId + " ts=" + new Date().toISOString());

            const q = getQuestionById(cbRequestId);
            const alreadyAnswered = q && (q.status === "answered" || q.status === "expired");

            if (alreadyAnswered) {
                _log("Callback ignorado: pregunta ya resuelta status=" + q.status + " requestId=" + cbRequestId);
                try {
                    await _tgApi.telegramPost("answerCallbackQuery", {
                        callback_query_id: callbackQueryId,
                        text: "Ya fue respondido",
                        show_alert: false
                    }, 5000);
                } catch (e2) {}
            } else if (q && q.status === "pending") {
                resolveQuestion(cbRequestId, "answered", "telegram", permAction);

                if (permAction === "always" && q.action_data) {
                    persistPermissionFromActionData(q.action_data);
                }

                const confirmText = { allow: "✅ Permitido", always: "✅ Permitido siempre", deny: "❌ Denegado" }[permAction] || "OK";
                try {
                    await _tgApi.telegramPost("answerCallbackQuery", {
                        callback_query_id: callbackQueryId,
                        text: confirmText,
                        show_alert: false
                    }, 5000);
                } catch (e2) {}

                const emojiDecision = { allow: "✅", always: "✅✅", deny: "❌" }[permAction] || "•";
                if (messageId) {
                    const originalHtml = q.original_html || _tgApi.escHtml(q.message || "Permiso solicitado");
                    try {
                        await _tgApi.telegramPost("editMessageText", {
                            chat_id: _tgApi.getChatId(),
                            message_id: messageId,
                            text: originalHtml + "\n\n" + emojiDecision + " <b>" + confirmText + "</b>",
                            parse_mode: "HTML",
                            reply_markup: { inline_keyboard: [] }
                        }, 5000);
                    } catch (e2) {
                        _log("Error editando mensaje permiso: " + (e2.message || ""));
                    }
                }
                _log("Permiso procesado: action=" + permAction + " requestId=" + cbRequestId + " msgId=" + messageId + " ts=" + new Date().toISOString());
            } else {
                const fileSnapshot = (() => {
                    try { return JSON.stringify(loadQuestions()).substring(0, 500); } catch (e) { return "error: " + e.message; }
                })();
                _log("Pregunta no encontrada: requestId=" + cbRequestId + " estado_q=" + (q ? q.status : "null") + " archivo=" + fileSnapshot);
                try {
                    await _tgApi.telegramPost("answerCallbackQuery", {
                        callback_query_id: callbackQueryId,
                        text: "Solicitud no encontrada",
                        show_alert: false
                    }, 5000);
                } catch (e2) {}
            }
            return true;
        }

        // Smart-suggestion
        if (cbData.startsWith("persist:") || cbData.startsWith("dismiss:")) {
            const action = cbData.startsWith("persist:") ? "persist" : "dismiss";
            const encodedPattern = cbData.substring(action.length + 1);
            _log("Callback smart-suggestion: action=" + action + " pattern(b64)=" + encodedPattern);
            if (action === "persist") {
                const pattern = Buffer.from(encodedPattern, "base64url").toString("utf8");
                const settingsPaths = getSettingsPaths(_repoRoot);
                persistPattern(pattern, settingsPaths, _log);
                await _tgApi.telegramPost("answerCallbackQuery", {
                    callback_query_id: callbackQueryId,
                    text: "Guardado: " + pattern,
                    show_alert: false
                }, 5000);
                try {
                    await _tgApi.telegramPost("editMessageText", {
                        chat_id: _tgApi.getChatId(),
                        message_id: messageId,
                        text: "✅ <b>Regla guardada</b>\n<code>" + pattern.replace(/</g, "&lt;") + "</code>\n<i>Próximas ejecuciones se aprobarán automáticamente.</i>",
                        parse_mode: "HTML"
                    }, 5000);
                } catch (e) { /* ok */ }
            } else {
                await _tgApi.telegramPost("answerCallbackQuery", {
                    callback_query_id: callbackQueryId,
                    text: "Descartado",
                    show_alert: false
                }, 5000);
                try {
                    await _tgApi.telegramPost("editMessageReplyMarkup", {
                        chat_id: _tgApi.getChatId(),
                        message_id: messageId,
                        reply_markup: { inline_keyboard: [] }
                    }, 5000);
                } catch (e) { /* ok */ }
            }
            return true;
        }

        // Permission-suggester (#1280)
        if (cbData.startsWith("ps_approve:") || cbData.startsWith("ps_ignore:") || cbData.startsWith("ps_never:")) {
            const parts = cbData.split(":");
            const action = parts[0];
            const encodedPattern = parts.slice(1).join(":");
            _log("Callback permission-suggester: action=" + action + " pattern(b64)=" + encodedPattern);

            if (action === "ps_approve" && _permissionSuggester) {
                const result = _permissionSuggester.handleSuggestionApprove(encodedPattern);
                await _tgApi.telegramPost("answerCallbackQuery", {
                    callback_query_id: callbackQueryId,
                    text: result.ok ? "Guardado: " + result.pattern : "Error",
                    show_alert: false
                }, 5000);
                try {
                    await _tgApi.telegramPost("editMessageText", {
                        chat_id: _tgApi.getChatId(),
                        message_id: messageId,
                        text: result.message,
                        parse_mode: "HTML",
                        reply_markup: { inline_keyboard: [] }
                    }, 5000);
                } catch (e) { /* ok */ }
            } else if (action === "ps_ignore") {
                await _tgApi.telegramPost("answerCallbackQuery", {
                    callback_query_id: callbackQueryId,
                    text: "Ignorado — puede volver a sugerirse",
                    show_alert: false
                }, 5000);
                try {
                    await _tgApi.telegramPost("editMessageReplyMarkup", {
                        chat_id: _tgApi.getChatId(),
                        message_id: messageId,
                        reply_markup: { inline_keyboard: [] }
                    }, 5000);
                } catch (e) { /* ok */ }
            } else if (action === "ps_never" && _permissionSuggester) {
                const result = _permissionSuggester.handleSuggestionNever(encodedPattern);
                const pattern = result.ok ? result.pattern : "?";
                await _tgApi.telegramPost("answerCallbackQuery", {
                    callback_query_id: callbackQueryId,
                    text: "No se volverá a sugerir",
                    show_alert: false
                }, 5000);
                try {
                    await _tgApi.telegramPost("editMessageText", {
                        chat_id: _tgApi.getChatId(),
                        message_id: messageId,
                        text: "⛔ <b>Nunca sugerir</b>\n<code>" + (pattern || "").replace(/</g, "&lt;") + "</code>\n<i>No se volverá a sugerir este patrón.</i>",
                        parse_mode: "HTML",
                        reply_markup: { inline_keyboard: [] }
                    }, 5000);
                } catch (e) { /* ok */ }
            } else {
                await _tgApi.telegramPost("answerCallbackQuery", {
                    callback_query_id: callbackQueryId,
                    text: "Módulo no disponible",
                    show_alert: true
                }, 5000);
            }
            return true;
        }

        // Preguntas pendientes
        if (cbData.startsWith("pq_")) {
            _log("Callback de pregunta pendiente: " + cbData);
            await handlePendingCallback(cbData, callbackQueryId);
            return true;
        }

    } catch (e) {
        _log("Error procesando callback: " + e.message);
        try {
            await _tgApi.telegramPost("answerCallbackQuery", {
                callback_query_id: callbackQueryId,
                text: "Error: " + e.message.substring(0, 100),
                show_alert: true
            }, 5000);
        } catch (e2) {}
        return true;
    }

    // Detalle bajo demanda (#1681)
    if (cbData === "tts_listen") {
        _log("Callback tts_listen recibido — generando audio de la respuesta");
        try {
            await _tgApi.telegramPost("answerCallbackQuery", {
                callback_query_id: callbackQueryId,
                text: "Generando audio...",
                show_alert: false
            }, 5000);
        } catch (e) {}

        const stored = lastFullResponse.load();
        if (!stored || !stored.text) {
            await _tgApi.sendMessage("⏱ La respuesta expiró (TTL: 10 min). Ejecutá el comando nuevamente.");
            return true;
        }

        // Activar command-in-progress para silenciar otros mensajes
        try { require("../telegram-client").setCommandInProgress(true); } catch (e) {}

        // Escribir voice flag para que stop-notify no envíe imagen
        try {
            const flagPath = path.join(_hooksDir || __dirname + "/..", "voice-response-active.flag");
            require("fs").writeFileSync(flagPath, String(Date.now()), "utf8");
        } catch (e) {}

        try {
            const multimediaHandler = require("./multimedia-handler");
            const text = stored.text.substring(0, 2000); // Límite TTS
            const audioBuffer = await multimediaHandler.callTTS(text);
            await _tgApi.sendVoiceMessage(audioBuffer);
            _log("TTS bajo demanda enviado: " + audioBuffer.length + " bytes");
        } catch (ttsErr) {
            _log("Error TTS bajo demanda: " + ttsErr.message);
            await _tgApi.sendMessage("❌ Error generando audio: <code>" + _tgApi.escHtml(ttsErr.message) + "</code>");
        } finally {
            try { require("../telegram-client").setCommandInProgress(false); } catch (e) {}
        }
        return true;
    }

    if (cbData === "show_detail") {
        _log("Callback show_detail recibido");
        try {
            await _tgApi.telegramPost("answerCallbackQuery", {
                callback_query_id: callbackQueryId,
                text: "Generando detalle...",
                show_alert: false
            }, 5000);
        } catch (e) {}

        const stored = lastFullResponse.load();
        if (!stored) {
            await _tgApi.sendMessage("⏱ El detalle expiró (TTL: 10 min). Ejecutá el skill nuevamente.");
            return true;
        }

        const caption = "📋 <b>" + _tgApi.escHtml(stored.label || "Detalle completo") + "</b>";
        const img = imageUtils.renderTextAsPng(stored.text);
        if (img) {
            await _tgApi.sendTelegramPhoto(img, caption, false);
        } else {
            await _tgApi.sendLongMessage(caption + "\n\n" + _tgApi.escHtml(stored.text));
        }
        return true;
    }

    return false; // No reconocido
}

module.exports = {
    init,
    setSkills,
    routeCallback,
    handleProposalCallback,
    handleReactivateCallback,
    handleAutoPlanCallback,
    handlePendingCallback,
    persistPermissionFromActionData,
};
