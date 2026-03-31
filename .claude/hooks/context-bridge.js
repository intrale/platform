// context-bridge.js — Puente entre Context Channels, Pending Questions y Telegram
// Sincroniza preguntas pendientes de agentes con sus canales de contexto,
// retransmite respuestas, y envía mensajes nuevos a Telegram
"use strict";

const fs = require("fs");
const path = require("path");
const contextManager = require("./context-manager");
const { getPendingQuestions, resolveQuestion, getQuestionsByChannel } = require("./pending-questions");

// Telegram outbox — fire-and-forget via archivo, el Commander drena
let tgOutbox = null;
function getTgOutbox() {
    if (tgOutbox) return tgOutbox;
    try { tgOutbox = require("./telegram-outbox"); } catch (e) {}
    return tgOutbox;
}

// Agent registry — carga lazy
let agentRegistry = null;
function getAgentRegistry() {
    if (agentRegistry) return agentRegistry;
    try { agentRegistry = require("./agent-registry"); } catch (e) {}
    return agentRegistry;
}

// ─── State: track last synced timestamps to avoid re-processing ──────────────

const BRIDGE_STATE_FILE = path.join(__dirname, "context-bridge-state.json");

function loadBridgeState() {
    try {
        return JSON.parse(fs.readFileSync(BRIDGE_STATE_FILE, "utf8"));
    } catch (e) {
        return { last_question_sync: null, last_telegram_relay: {} };
    }
}

function saveBridgeState(state) {
    try {
        fs.writeFileSync(BRIDGE_STATE_FILE, JSON.stringify(state, null, 2), "utf8");
    } catch (e) {}
}

// ─── Sync: Pending Questions → Context Channels ─────────────────────────────
// Detecta preguntas nuevas de agentes que tienen un canal de contexto
// y las postea al canal como mensajes tipo "question"

function syncPendingQuestionsToChannels() {
    const state = loadBridgeState();
    const pendingQuestions = getPendingQuestions();
    const registry = getAgentRegistry();
    let synced = 0;

    for (const q of pendingQuestions) {
        // Skip if already has channel_id (already synced)
        if (q.channel_id) continue;

        // Skip if already processed (check by timestamp)
        if (state.last_question_sync && q.timestamp <= state.last_question_sync) continue;

        // Try to find a context channel for this question's agent
        // Use action_data to identify the agent (has session info, tool context)
        const actionData = q.action_data || {};

        // Try to match by session — find the agent's issue from registry
        if (!registry) continue;
        const agents = registry.getAllAgents ? registry.getAllAgents() : [];

        // Look for an agent whose session matches the approver_pid or skill_context
        let matchedChannel = null;

        for (const agent of agents) {
            if (agent.status !== "active" && agent.status !== "idle") continue;

            // Check if there's a context channel for this agent
            const channel = contextManager.findChannelByIssue(agent.issue);
            if (!channel) continue;

            // Check if this question could belong to this agent
            // Heuristic: if the question's skill_context matches the agent's skill
            if (q.skill_context && agent.skill && q.skill_context.includes(agent.skill)) {
                matchedChannel = channel;
                break;
            }

            // Or if any channel has a participant with matching PID
            if (q.approver_pid && agent.pid === q.approver_pid) {
                matchedChannel = channel;
                break;
            }
        }

        if (matchedChannel) {
            // Post the question to the channel
            const hasTelegramParticipant = matchedChannel.participants.some(p => p.type === "telegram");

            contextManager.postQuestion(
                matchedChannel.id,
                { id: "system", label: "Sistema (permiso)" },
                q.message || "(pregunta de permiso)",
                q.id // link back to pending question ID
            );

            synced++;
        }
    }

    // Update sync timestamp
    if (pendingQuestions.length > 0) {
        state.last_question_sync = new Date().toISOString();
        saveBridgeState(state);
    }

    return synced;
}

// ─── Relay: Context Channel Answer → Pending Questions ───────────────────────
// When someone answers a question in a context channel, resolve the original
// pending question so the agent unblocks

function relayAnswerToPendingQuestions(channelId, questionId, answer, answeredBy) {
    const channel = contextManager.getChannel(channelId);
    if (!channel) return false;

    // Find the pending question in the channel
    const pq = (channel.pending_questions || []).find(q => q.question_id === questionId);
    if (!pq || !pq.pending_question_id) return false;

    // Resolve the original pending question
    // Map the answer to an action: if it looks like permission response, use that
    let action = "allow"; // default for permission questions
    const lower = (answer || "").toLowerCase().trim();
    if (["no", "deny", "denegar", "n"].includes(lower)) {
        action = "deny";
    } else if (["siempre", "always"].includes(lower)) {
        action = "always";
    }

    const via = answeredBy === "telegram" ? "telegram" : "context_channel";
    resolveQuestion(pq.pending_question_id, "answered", via, action);

    return true;
}

// ─── Relay: Context Channel Messages → Telegram ──────────────────────────────
// Send new messages from channels with Telegram participants to Telegram

function relayToTelegram(channelId, sinceTimestamp) {
    const outbox = getTgOutbox();
    if (!outbox) return 0;

    const channel = contextManager.getChannel(channelId);
    if (!channel) return 0;

    // Check if Telegram is a participant
    const hasTg = channel.participants.some(p => p.type === "telegram");
    if (!hasTg) return 0;

    // Get messages since last relay
    const state = loadBridgeState();
    const lastRelay = sinceTimestamp || (state.last_telegram_relay || {})[channelId] || null;
    const messages = contextManager.getMessages(channelId, lastRelay);

    // Filter out messages FROM telegram (avoid echo)
    const toRelay = messages.filter(m => m.from !== "telegram" && m.from !== "p-tg");

    let sent = 0;
    for (const msg of toRelay) {
        let prefix = "";
        switch (msg.type) {
            case "question": prefix = "\u2753 "; break;  // ❓
            case "answer": prefix = "\u2705 "; break;    // ✅
            case "activity": prefix = "\ud83d\udd27 "; break;  // 🔧
            case "system": prefix = "\ud83d\udccb "; break;    // 📋
            default: prefix = ""; break;
        }

        const text = "<b>[" + (channel.name || channelId) + "]</b>\n"
            + "<i>" + (msg.from_label || "?") + ":</i> "
            + prefix + (msg.content || "").substring(0, 3000);

        try {
            outbox.enqueue(text, { silent: msg.type === "activity", category: "context-relay" });
            sent++;
        } catch (e) {}
    }

    // Update last relay timestamp
    if (messages.length > 0) {
        if (!state.last_telegram_relay) state.last_telegram_relay = {};
        state.last_telegram_relay[channelId] = messages[messages.length - 1].timestamp;
        saveBridgeState(state);
    }

    return sent;
}

// ─── Tick: Main sync loop ────────────────────────────────────────────────────
// Called periodically by the commander or via CLI

function tick() {
    const results = {
        questions_synced: 0,
        telegram_relayed: 0,
        channels_cleaned: 0,
    };

    try {
        // 1. Sync pending questions to channels
        results.questions_synced = syncPendingQuestionsToChannels();
    } catch (e) {}

    try {
        // 2. Relay messages to Telegram for all channels with Telegram participants
        const channels = contextManager.listChannels();
        for (const ch of channels) {
            const hasTg = (ch.participants || []).some(p => p.type === "telegram");
            if (hasTg) {
                results.telegram_relayed += relayToTelegram(ch.id);
            }
        }
    } catch (e) {}

    try {
        // 3. Cleanup stale channels (> 24h)
        const removed = contextManager.cleanupStaleChannels();
        results.channels_cleaned = removed.length;
    } catch (e) {}

    return results;
}

// ─── Exports ─────────────────────────────────────────────────────────────────

module.exports = {
    syncPendingQuestionsToChannels,
    relayAnswerToPendingQuestions,
    relayToTelegram,
    tick,
    loadBridgeState,
    saveBridgeState,
};
