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

// ─── Namespaces del Commander (single source of truth, #4802) ─────────────────
//
// Whitelist ÚNICA de prefijos/exactos que pertenecen al Commander (botones inline
// de propuestas, permisos, restart, sprint, reactivación, etc.). El listener
// (`.pipeline/listener-telegram.js`) importa estas constantes para rutear por
// prefijo SIN hardcodear la lista dos veces (CA-7). Antes de #4802 el listener
// mandaba TODO callback no-`pc:`/`pcx:` a `operator-gate` (firma), y estos
// callbacks caían al fail-safe "Acción inválida o expirada" porque `routeCallback`
// estaba exportado pero nunca se invocaba.
//
// PRIVILEGED_NAMESPACES ⊂ COMMANDER_NAMESPACES: subconjunto que exige authz por
// `from.id` (fail-closed) porque dispara acciones sensibles (persistir permisos,
// restart, relanzar skill, lanzar sprint). El resto son idempotentes/consultivos.
const COMMANDER_NAMESPACES = [
    'create_all_proposals', 'create_proposal:', 'discard_proposal:',
    'launch_sprint', 'view_sprint_plan',
    'reactivate:', 'dismiss_expired:', 'reactivate_all',
    'restart_retry', 'restart_log',
    'relaunch_skill:',
    'allow:', 'always:', 'deny:',
    'persist:', 'dismiss:',
    'ps_approve:', 'ps_ignore:', 'ps_never:',
    'pq_',
    'tts_listen', 'show_detail',
    // #5923 — botones degradados de `url` a `callback_data`.
    'hb:', 'pp:',
];
const PRIVILEGED_NAMESPACES = [
    'launch_sprint',
    'restart_retry', 'restart_log',
    'relaunch_skill:',
    'allow:', 'always:', 'deny:',
    'persist:', 'dismiss:',
    'pq_',
    // #5923 — `hb:` destraba el pipeline (unblock / devolver a definición) y
    // `pp:` muta el allowlist de la pausa parcial ⇒ ambos son privilegiados.
    // Con esto el listener aplica authz fail-closed por `from.id` ANTES de
    // invocar el handler; NO se duplica esa verificación acá adentro (fuente
    // única: listener-telegram.js).
    'hb:', 'pp:',
];

// Membresía por prefijo: los tokens que terminan en `:` o `_` matchean por
// `startsWith`; el resto exige igualdad exacta (evita que `restart_log` matchee
// `restart_logXYZ` inesperado, y que `launch_sprint` no matchee un exacto ajeno).
function _matchesNamespace(data, namespaces) {
    const d = typeof data === 'string' ? data : '';
    return namespaces.some(p =>
        (p.endsWith(':') || p.endsWith('_')) ? d.startsWith(p) : d === p);
}

function isCommanderNamespace(data) {
    return _matchesNamespace(data, COMMANDER_NAMESPACES);
}

function isPrivilegedNamespace(data) {
    return _matchesNamespace(data, PRIVILEGED_NAMESPACES);
}

// ─── #5923 · Botones degradados (`hb:` / `pp:`) ──────────────────────────────
//
// Cuando el dashboard no es público (el caso normal: `localhost:3200`), los
// botones de acción se emiten como `callback_data` en vez de `url`. Sin una
// rama acá, esa degradación entregaría BOTONES MUERTOS, que es peor que el
// estado actual. Este bloque es el otro extremo del cable.
//
// Formas de `callback_data` (todas ≤ 64 bytes, ver telegram-button-url.js):
//   <ns>:<action>[:<issue>]        → tap directo (o 1er tap si es destructiva)
//   <ns>:c:<action>[:<issue>]      → confirmación del 2do tap
//   <ns>:x:<action>[:<issue>]      → cancelar la confirmación
//
// AUTHZ: no se verifica acá. El listener ya rechazó fail-closed por `from.id`
// contra la allowlist de operadores ANTES de invocar `routeCallback` (fuente
// única, `listener-telegram.js`). Duplicarlo sería una segunda fuente de verdad.
//
// TOAST: lo emite ESTE handler en TODOS sus caminos, incluido el fail-closed.
// El listener sólo emite toast cuando `routeCallback` devuelve `false` o tira;
// como acá siempre devolvemos `true`, si no respondiéramos nosotros el operador
// se quedaría con el spinner girando y sin saber si su decisión se aplicó.

// Mapa CONGELADO acción → path. El `action` viene del cliente, así que jamás se
// interpola en la URL: se busca en el mapa y sin match no sale ningún request
// (`pp:../kill-agent:1` muere en el lookup).
const PP_ROUTES = Object.freeze({
    'include-deps':         '/api/partial-pause/include-deps',
    'keep-original':        '/api/partial-pause/keep-original',
    'cancel-partial-pause': '/api/partial-pause/cancel-partial-pause',
    // #5978 — silenciar la re-alerta de ESTE caso. Alta de una clave más en el
    // mapa congelado: sin superficie nueva, el `action` sigue sin interpolarse.
    'mute-case':            '/api/partial-pause/mute-case',
});

const PP_META = Object.freeze({
    'include-deps': {
        text: '✅ Sí, incluir las deps',
        highImpact: false,
        consequence: 'Vas a sumar las issues de las que depende al allowlist de la pausa parcial.',
    },
    'keep-original': {
        text: '🎯 Seguir sólo con el issue original',
        highImpact: false,
        // #5978 — la consecuencia dice explícitamente que el aviso SIGUE: antes
        // esta acción era indistinguible de "no me avises más", y ahora que
        // `mute-case` existe la diferencia tiene que leerse en el propio botón.
        consequence: 'Vas a dejar el allowlist como está; las deps abiertas quedan asumidas como riesgo. El aviso va a seguir saliendo.',
    },
    'mute-case': {
        text: '🔕 No avisar más por este caso',
        highImpact: false,
        consequence: 'Vas a silenciar la re-alerta de este issue con estas dependencias exactas. No cambia la lista de trabajo. Si cambian las deps, el aviso vuelve.',
    },
    'cancel-partial-pause': {
        text: '🔓 Levantar la pausa parcial',
        highImpact: true,
        consequence: 'Vas a levantar la pausa parcial: el pipeline vuelve a tomar TODO el backlog, no sólo el allowlist actual.',
    },
});

// Separador determinístico entre el texto original del mensaje y el bloque de
// confirmación. Lo escribimos y lo leemos nosotros, así que cancelar puede
// restaurar el texto original con un `split` exacto (CA-UX-3).
const DEGRADED_CONFIRM_MARKER = "\n\n⚠️ ";

/** Toast al operador. Nunca tira: un toast fallido no puede romper la acción. */
async function _degradedToast(callbackQueryId, text, showAlert) {
    try {
        await _tgApi.telegramPost("answerCallbackQuery", {
            callback_query_id: callbackQueryId,
            text: String(text || "").slice(0, 190),
            show_alert: !!showAlert,
        }, 5000);
    } catch (e) { _log("#5923 toast falló: " + e.message); }
}

/**
 * Edita el mensaje original. Deliberadamente SIN `parse_mode`: el `text` que
 * nos devuelve Telegram ya viene renderizado (sin entities), así que
 * re-mandarlo como Markdown puede fallar por asteriscos/guiones bajos
 * desbalanceados y hacer que el edit se pierda justo cuando dejamos constancia.
 */
async function _degradedEdit(messageId, text, keyboard) {
    if (!messageId) return;
    try {
        const params = {
            chat_id: _tgApi.getChatId(),
            message_id: messageId,
            text: String(text || "").slice(0, 4000),
        };
        params.reply_markup = { inline_keyboard: Array.isArray(keyboard) ? keyboard : [] };
        await _tgApi.telegramPost("editMessageText", params, 8000);
    } catch (e) { _log("#5923 edit falló: " + e.message); }
}

/** Saca el emoji del label y arranca en minúscula, para meterlo en "Sí, <x>". */
function _degradedActionPhrase(text) {
    const sinEmoji = String(text || "").replace(/^\S+\s+/, "").trim();
    return sinEmoji.charAt(0).toLowerCase() + sinEmoji.slice(1);
}

/** Acceso al helper de botones. Fuente ÚNICA del formato de `callback_data`. */
function _btnUrl() {
    return require(path.join(_repoRoot, ".pipeline", "lib", "telegram-button-url.js"));
}

/**
 * Teclado de confirmación. Positivo a la izquierda (igual que `pc:`/`pcx:`).
 *
 * El `callback_data` se arma con `buildCallbackData` y pasa por el assert
 * `fitsCallbackData` del helper, en vez de concatenarse a mano: ese assert es
 * precisamente el guard que CA-6 pidió centralizar, y saltearlo dejaba un
 * segundo formato de `callback_data` fuera de control. Si un botón no entra en
 * los 64 bytes de la Bot API se cae ese botón, no el envío entero.
 */
function _degradedConfirmKeyboard(ns, action, issue, label) {
    const btnUrl = _btnUrl();
    const row = [
        { text: "⚠️ Sí, " + label, data: btnUrl.buildCallbackData(ns + ":c", action, issue) },
        { text: "✖️ Cancelar",     data: btnUrl.buildCallbackData(ns + ":x", action, issue) },
    ].filter(b => btnUrl.fitsCallbackData(b.data));
    if (row.length < 2) {
        // Sin confirmación completa no se ofrece media confirmación.
        _log("#5923 callback_data de confirmación excede el límite: " + ns + "/" + action);
        return [];
    }
    return [row.map(b => ({ text: b.text, callback_data: b.data }))];
}

/**
 * Rearma el teclado ORIGINAL (siempre en modo degradado) para el cancel.
 * Devuelve `null` si el rearmado FALLÓ, para distinguirlo de "no hay botones"
 * (`[]`): el caller decide si deja constancia del fallo.
 */
function _degradedOriginalKeyboard(ns, issue) {
    try {
        const btnUrl = _btnUrl();
        if (ns === "pp") {
            return _rowsOf(btnUrl.buildActionKeyboard([
                [
                    { action: "include-deps",  text: PP_META["include-deps"].text,  issue },
                    { action: "keep-original", text: PP_META["keep-original"].text, issue },
                ],
                // #5978 — mismo layout que emite el barrido del Pulpo. Si acá
                // faltara la fila, cancelar una confirmación restauraría un
                // teclado SIN el botón de silenciar: el operador perdería la
                // acción por haber dudado una vez.
                [{ action: "mute-case", text: PP_META["mute-case"].text, issue }],
                [{ action: "cancel-partial-pause", text: PP_META["cancel-partial-pause"].text }],
            ], { callbackPrefix: "pp" }));
        }
        const hb = require(path.join(_repoRoot, ".pipeline", "lib", "human-block.js"));
        const rows = hb.ACTION_KEYBOARD_ROWS.map(row => row.map(a => ({
            action: a, text: hb.ACTION_META[a].emoji + " " + hb.ACTION_META[a].label, issue,
        })));
        return _rowsOf(btnUrl.buildActionKeyboard(rows, { callbackPrefix: "hb" }));
    } catch (e) {
        _log("#5923 no se pudo rearmar el teclado original: " + e.message);
        return null;   // FALLÓ ≠ "sin botones"
    }
}

/**
 * Filas de un resultado de `buildActionKeyboard`. `markup` es `undefined`
 * cuando no quedó ningún botón emitible (contrato CA-UX-7), así que acceder
 * directo a `.markup.inline_keyboard` tiraba y el `try/catch` lo enmascaraba
 * como "falló el rearmado".
 */
function _rowsOf(built) {
    return (built && built.markup && Array.isArray(built.markup.inline_keyboard))
        ? built.markup.inline_keyboard
        : [];
}

/** Metadata de la acción (label + consequence + highImpact) por namespace. */
function _degradedMeta(ns, action) {
    if (ns === "pp") return PP_META[action] || null;
    try {
        const hb = require(path.join(_repoRoot, ".pipeline", "lib", "human-block.js"));
        const m = hb.ACTION_META[action];
        if (!m || !hb.isQuickAction(action)) return null;
        return { text: m.emoji + " " + m.label, highImpact: !!m.highImpact, consequence: m.consequence };
    } catch { return null; }
}

/**
 * Ejecuta `hb:<action>:<issue>`. Devuelve el texto concreto para el toast.
 *
 * R-SEC-9.b — este es el TERCER canal que llega a `executeQuickAction`, y los
 * otros dos ya dejan rastro de autor (`human-block-action-handler.js:154` para
 * el camino HTTP, `commander-deterministic.js:1535-1544` para el comando de
 * texto). Sin `operator` en el audit, apretar `hb:devolver-definicion` —la
 * acción que DESCARTA el trabajo de desarrollo en curso— quedaba sin ninguna
 * anotación de quién fue: con varios operadores en la allowlist, reconstruir un
 * incidente se volvía imposible. El `operator` NO es opcional: lo garantiza el
 * guard fail-closed de `handleDegradedActionCallback`.
 */
function _execHumanBlock(action, issue, operator, chatId, messageId) {
    const hb = require(path.join(_repoRoot, ".pipeline", "lib", "human-block.js"));
    const i = Number(issue);
    // La entry se emite en TODOS los caminos —OK y fail-closed—, igual que
    // `commander-deterministic.js`: un rechazo sin registrar es justamente el
    // intento que más interesa reconstruir después. `auditQuickAction` nunca
    // lanza, pero el try/catch deja explícito que el audit no puede tumbar la
    // operación (regla "el pipeline no puede morir").
    const audit = (result_status) => {
        try {
            hb.auditQuickAction({
                issue: i, action, from: operator, chat_id: chatId,
                message_id: messageId, result_status,
            });
        } catch (e) { _log("#5923 audit de hb: falló: " + e.message); }
    };
    if (!hb.isQuickAction(action)) {
        audit("rejected");
        return { ok: false, msg: "Acción no reconocida." };
    }
    // Mismo guard que buildBlockedActionMarkup: entero 1..999999.
    if (!Number.isInteger(i) || i <= 0 || i > 999999) {
        audit("rejected");
        return { ok: false, msg: "Issue inválido." };
    }
    // Entry point EXPORTADO. NO se pasa por `human-block-action-handler.handle`:
    // ese valida token HMAC + ALLOWED_ORIGINS porque su input viene de HTTP; acá
    // el input ya lo autorizó el listener y no hay token que validar.
    // Es idempotente ⇒ cubre el anti-replay que el `callback_data` no tiene.
    let r;
    try {
        r = hb.executeQuickAction({ issue: i, action });
    } catch (e) {
        audit("error");
        throw e;   // lo reporta el caller; el audit ya quedó asentado
    }
    if (!r || r.ok !== true) {
        audit("error");
        return { ok: false, msg: (r && r.error) || "No se pudo aplicar la acción." };
    }
    audit("authorized");
    return { ok: true, msg: r.msg || ("Acción aplicada sobre #" + i + ".") };
}

/**
 * Ejecuta `pp:<action>` posteando al dashboard en el host propio.
 * `operator` es el `from.id` REAL, ya validado como no vacío por el guard
 * fail-closed del caller: acá no hay ningún fallback a literal (R-SEC-9.a).
 */
async function _execPartialPause(action, operator, issue) {
    const route = PP_ROUTES[action];
    if (!route) return { ok: false, msg: "Acción no reconocida." };
    // Loopback explícito: el dashboard corre en esta misma máquina. No se usa
    // DASHBOARD_URL para no volver client/env-controlable el destino del POST.
    const port = Number(process.env.DASHBOARD_PORT) || 3200;
    const url = "http://127.0.0.1:" + port + route;
    try {
        const resp = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            // `authorizedBy` es la CLASE de origen registrada en el enum cerrado
            // de #3625 (`telegram:operator`); el `from.id` concreto viaja en
            // `operatorRef` para la trazabilidad fina. Mandar `telegram:<from.id>`
            // dejaba el valor fuera del enum: funcionaba sólo por el grace period
            // y con el gate estricto activo el botón habría dado 403 para siempre.
            //
            // R-SEC-9.a — sin fallback a literal: un `operatorRef: "desconocido"`
            // sobre `cancel-partial-pause` (la acción que libera TODO el backlog)
            // es peor que no registrar nada, porque el log AFIRMA algo falso. Si
            // la identidad no llega, no se llega hasta acá.
            // #5978 — `issue` viaja para las acciones que son POR CASO
            // (`mute-case`). Las otras tres lo ignoran server-side: el endpoint
            // sólo lo lee cuando la acción lo necesita, así que mandarlo
            // siempre no les cambia nada. Las DEPS no viajan desde acá: las
            // resuelve el dashboard desde `partial-pause-deps-state.json` al
            // momento del click, porque el `callback_data` de Telegram (≤64
            // bytes) transporta sólo el issue y ese contrato no se toca.
            body: JSON.stringify({
                authorizedBy: "telegram:operator",
                operatorRef: operator,
                issue: issue || undefined,
            }),
            signal: AbortSignal.timeout(10000),
        });
        let data = null;
        try { data = await resp.json(); } catch { /* body no-JSON */ }
        if (resp.status === 409) {
            return { ok: false, msg: (data && data.msg) || "Esa decisión ya no aplica: el pipeline cambió de modo." };
        }
        if (!resp.ok || !data || data.ok !== true) {
            return { ok: false, msg: (data && data.msg) || ("El dashboard respondió " + resp.status + ".") };
        }
        return { ok: true, msg: data.msg || "Listo." };
    } catch (e) {
        return { ok: false, msg: "No se pudo contactar al dashboard: " + e.message };
    }
}

/**
 * Normaliza el `from.id` de Telegram a la referencia de operador que se asienta
 * en el audit. Devuelve `null` cuando no hay identidad utilizable — el caller
 * traduce ese `null` en fail-closed.
 */
function _operatorRef(fromId) {
    // Falsy (undefined, null, "", 0, false) ⇒ no hay identidad. El `0` importa:
    // no existe usuario de Telegram con id 0, así que aceptarlo sería tomar un
    // centinela por un operador.
    if (!fromId) return null;
    const s = String(fromId).trim();
    // Estos literales aparecen cuando alguien interpola un valor ausente antes
    // de llegar acá: son tan poco identidad como el vacío.
    if (!s || s === "undefined" || s === "null" || s === "0") return null;
    return s;
}

/**
 * Punto de entrada de los callbacks degradados. SIEMPRE devuelve `true` (el
 * namespace es nuestro) y SIEMPRE emite toast, incluso en los fail-closed.
 */
async function handleDegradedActionCallback(cbData, callbackQueryId, message, fromId) {
    const messageId = message && message.message_id;
    const chatId = message && message.chat && message.chat.id;
    const baseText = String((message && message.text) || "").split(DEGRADED_CONFIRM_MARKER)[0];

    // R-SEC-9.a — FAIL-CLOSED por identidad, antes de cualquier otra cosa.
    //
    // Todo lo que se ejecuta por acá es privilegiado (destraba el pipeline, muta
    // el allowlist, descarta trabajo en curso), así que sin `from.id` no se
    // ejecuta: ni request saliente, ni entry de audit, ni mutación. Hoy el
    // listener ya rechaza antes (`listener-telegram.js:833`), pero ese gate vive
    // en otro archivo: si mañana cambia, este guard es lo que evita que la
    // acción corra igual y el audit quede afirmando un autor inventado.
    //
    // El toast es el MISMO texto que el fail-safe del listener, a propósito: no
    // le confirma a quien lo aprieta si el callback existía o no.
    const operator = _operatorRef(fromId);
    if (!operator) {
        _log("#5923 callback degradado SIN from.id — fail-closed: " + cbData);
        await _degradedToast(callbackQueryId, "Acción inválida o expirada");
        return true;
    }

    // `_repoRoot` es lo único que nos deja cruzar a `.pipeline/`. Sin él,
    // fail-closed con toast — nunca throw (el pipeline no puede morir).
    if (!_repoRoot) {
        await _degradedToast(callbackQueryId, "⚠️ No se pudo resolver el repo; probá desde el dashboard.");
        return true;
    }

    // Parseo por el MISMO helper que emitió el dato (`telegram-button-url`), no
    // por slices a mano: dos fuentes de verdad para un formato es como se
    // desincronizan emisor y router.
    const ns = cbData.startsWith("pp:") ? "pp" : "hb";
    let parsed;
    try { parsed = _btnUrl().parseCallbackData(cbData, ns); }
    catch (e) {
        _log("#5923 no se pudo parsear el callback: " + e.message);
        await _degradedToast(callbackQueryId, "⚠️ No se pudo interpretar la acción.");
        return true;
    }
    if (!parsed) {
        await _degradedToast(callbackQueryId, "⚠️ Acción no reconocida o ya no disponible.");
        return true;
    }
    // `c` / `x` son etapas de confirmación, no acciones: se pelan re-parseando
    // con el prefijo extendido, siempre por el helper.
    let stage = "run";
    let action = parsed.action;
    let issue = parsed.issue || "";
    if (action === "c" || action === "x") {
        stage = action;
        const inner = _btnUrl().parseCallbackData(cbData, ns + ":" + stage);
        if (!inner) {
            await _degradedToast(callbackQueryId, "⚠️ Acción no reconocida o ya no disponible.");
            return true;
        }
        action = inner.action;
        issue = inner.issue || "";
    }

    // El issue, si viene, tiene que ser un entero pelado. Cualquier otra cosa
    // (path traversal, encoding raro) muere acá sin tocar nada.
    if (issue && !/^\d{1,6}$/.test(issue)) {
        await _degradedToast(callbackQueryId, "⚠️ Referencia de issue inválida.");
        return true;
    }

    const meta = _degradedMeta(ns, action);
    if (!meta) {
        _log("#5923 callback con acción desconocida: " + cbData);
        await _degradedToast(callbackQueryId, "⚠️ Acción no reconocida o ya no disponible.");
        return true;
    }

    // --- Cancelar la confirmación: restaurar texto Y teclado originales. ---
    if (stage === "x") {
        const restored = _degradedOriginalKeyboard(ns, issue);
        await _degradedToast(callbackQueryId, restored === null
            ? "Cancelado. No se aplicó nada (no se pudo restaurar el teclado; usá el dashboard)."
            : "Cancelado. No se aplicó nada.");
        await _degradedEdit(messageId, baseText, restored || []);
        return true;
    }

    // --- 1er tap de una acción destructiva: pedir confirmación explícita. ---
    if (stage === "run" && meta.highImpact) {
        await _degradedToast(callbackQueryId, meta.consequence, true);
        await _degradedEdit(
            messageId,
            baseText + DEGRADED_CONFIRM_MARKER + meta.consequence,
            _degradedConfirmKeyboard(ns, action, issue, _degradedActionPhrase(meta.text)),
        );
        return true;
    }

    // --- Ejecutar. ---
    let result;
    try {
        result = ns === "pp"
            ? await _execPartialPause(action, operator, issue)
            : _execHumanBlock(action, issue, operator, chatId, messageId);
    } catch (e) {
        _log("#5923 error ejecutando " + cbData + ": " + e.message);
        result = { ok: false, msg: "Error ejecutando la acción: " + e.message };
    }

    // Toast con el resultado CONCRETO (no un ack vacío).
    await _degradedToast(callbackQueryId, (result.ok ? "✅ " : "⚠️ ") + result.msg, !result.ok);

    if (!result.ok) {
        // Falló: se deja el teclado puesto para que pueda reintentar.
        await _degradedEdit(messageId, baseText, _degradedOriginalKeyboard(ns, issue) || []);
        return true;
    }

    // Constancia + retiro del teclado (best-effort anti doble ejecución; el
    // anti-replay real es server-side: idempotencia en `hb:`, 409 en `pp:`).
    const stamp = new Date().toISOString().slice(0, 16).replace("T", " ");
    const constancia = meta.text + (issue ? " · #" + issue : "")
        + " — operador " + operator + " · " + stamp + "\n" + result.msg;
    await _degradedEdit(messageId, baseText + "\n\n✅ " + constancia, []);
    return true;
}

// ─── Router principal de callbacks ───────────────────────────────────────────

// #4802 — `fromId` (id de Telegram del que tocó el botón) se agrega como 4to
// parámetro para trazabilidad y defense-in-depth. La authz PRIMARIA (fail-closed
// para prefijos privilegiados) la aplica el listener ANTES de invocar acá,
// reusando la misma fuente de allowlist que `operator-gate` (no duplicar fuente).
// Se mantiene el guard histórico de `chat.id`. Un `cbData` que no pertenezca al
// Commander devuelve `false` para que el listener caiga al fail-safe.
async function routeCallback(cbData, callbackQueryId, message, fromId) {
    const chatId = message && message.chat && message.chat.id;
    const messageId = message && message.message_id;

    if (String(chatId) !== String(_tgApi.getChatId())) return false;

    try {
        // #5923 — botones degradados de `url` a `callback_data` (human-block y
        // pausa parcial trabada). Va primero: es la rama más barata de descartar
        // y la única cuyo namespace no existía antes de esta issue.
        if (cbData.startsWith("hb:") || cbData.startsWith("pp:")) {
            _log("Callback degradado recibido: " + cbData);
            return await handleDegradedActionCallback(cbData, callbackQueryId, message, fromId);
        }

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
            const TTS_CHUNK_SIZE = 3800;
            const chunks = multimediaHandler.splitTextForTTS(stored.text, TTS_CHUNK_SIZE);
            _log("TTS bajo demanda: " + stored.text.length + " chars, " + chunks.length + " parte(s)");
            for (let i = 0; i < chunks.length; i++) {
                const chunkText = chunks.length > 1
                    ? "Parte " + (i + 1) + " de " + chunks.length + ". " + chunks[i]
                    : chunks[i];
                const audioBuffer = await multimediaHandler.callTTS(chunkText);
                await _tgApi.sendVoiceMessage(audioBuffer);
                _log("TTS bajo demanda parte " + (i + 1) + "/" + chunks.length + " enviada: " + audioBuffer.length + " bytes");
            }
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
    // #4802 — single source of truth de namespaces + helpers de membresía.
    COMMANDER_NAMESPACES,
    PRIVILEGED_NAMESPACES,
    isCommanderNamespace,
    isPrivilegedNamespace,
    // #5923 — ruteo de los botones degradados a `callback_data`.
    handleDegradedActionCallback,
    PP_ROUTES,
    PP_META,
};
