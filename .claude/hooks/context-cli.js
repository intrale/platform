#!/usr/bin/env node
// context-cli.js — CLI entry point para el skill /context
// Parsea argumentos, ejecuta operaciones via context-manager, imprime JSON a stdout
//
// Usage: node context-cli.js <subcommand> [args...]
// Subcommands: list, join, leave, history, say, answer, create, status
"use strict";

const path = require("path");
const fs = require("fs");
const contextManager = require("./context-manager");

// ─── Agent Registry ──────────────────────────────────────────────────────────

let agentRegistry = null;
try { agentRegistry = require("./agent-registry"); } catch (e) {}

// ─── Session ID ──────────────────────────────────────────────────────────────

function getSessionId() {
    return (process.env.CLAUDE_SESSION_ID || "").substring(0, 8) || "local";
}

// ─── Active context tracking (per-terminal) ──────────────────────────────────

const ACTIVE_CONTEXT_FILE = path.join(__dirname, "context-active-" + getSessionId() + ".json");

function getActiveContext() {
    try {
        return JSON.parse(fs.readFileSync(ACTIVE_CONTEXT_FILE, "utf8"));
    } catch (e) {
        return null;
    }
}

function setActiveContext(channelId, participantId) {
    const data = { channel_id: channelId, participant_id: participantId, updated_at: new Date().toISOString() };
    fs.writeFileSync(ACTIVE_CONTEXT_FILE, JSON.stringify(data), "utf8");
    return data;
}

function clearActiveContext() {
    try { fs.unlinkSync(ACTIVE_CONTEXT_FILE); } catch (e) {}
}

// ─── Activity log import ─────────────────────────────────────────────────────

function importRecentActivity(sessionId, limit) {
    limit = limit || 15;
    const logFile = path.join(__dirname, "..", "activity-log.jsonl");
    try {
        const content = fs.readFileSync(logFile, "utf8").trim();
        if (!content) return [];
        const lines = content.split("\n");
        const entries = [];
        const shortId = (sessionId || "").substring(0, 8);
        for (let i = lines.length - 1; i >= 0 && entries.length < limit; i--) {
            try {
                const entry = JSON.parse(lines[i]);
                if (!shortId || entry.session === shortId) {
                    entries.unshift(entry);
                }
            } catch (e) {}
        }
        return entries;
    } catch (e) {
        return [];
    }
}

// ─── Telegram history import ─────────────────────────────────────────────────

function importTelegramHistory(limit) {
    limit = limit || 30;
    const histFile = path.join(__dirname, "..", "..", ".pipeline", "commander-history.jsonl");
    try {
        const content = fs.readFileSync(histFile, "utf8").trim();
        if (!content) return [];
        const lines = content.split("\n");
        const entries = [];
        for (let i = lines.length - 1; i >= 0 && entries.length < limit; i--) {
            try {
                entries.unshift(JSON.parse(lines[i]));
            } catch (e) {}
        }
        return entries;
    } catch (e) {
        return [];
    }
}

// ─── Parse agent reference: "android-dev #1913" or "android-dev 1913" ────────

function parseAgentRef(argsArray) {
    let skill = null;
    let issue = null;

    for (const arg of argsArray) {
        const stripped = arg.replace(/^#/, "");
        if (/^\d+$/.test(stripped)) {
            issue = stripped;
        } else if (!skill) {
            skill = arg;
        }
    }

    return { skill, issue };
}

// ─── Find agent in registry ─────────────────────────────────────────────────

function findAgent(skill, issue) {
    if (!agentRegistry) return null;
    const agents = agentRegistry.getAllAgents ? agentRegistry.getAllAgents() : [];

    return agents.find(a => {
        const agentIssue = String(a.issue || "").replace(/^#/, "");
        const matchIssue = issue && agentIssue === issue;
        const matchSkill = skill && a.skill === skill;

        if (issue && skill) return matchIssue && matchSkill;
        if (issue) return matchIssue;
        if (skill) return matchSkill;
        return false;
    }) || null;
}

// ─── Output helpers ──────────────────────────────────────────────────────────

function output(data) {
    process.stdout.write(JSON.stringify(data, null, 2) + "\n");
}

function outputError(msg) {
    output({ ok: false, error: msg });
    process.exit(1);
}

// ─── Subcommand: list ────────────────────────────────────────────────────────

function cmdList() {
    const channels = contextManager.listChannels();
    output({
        ok: true,
        command: "list",
        channels: channels.map(ch => ({
            id: ch.id,
            name: ch.name,
            origin_type: (ch.origin || {}).type,
            participants: (ch.participants || []).length,
            messages: (ch.messages || []).length,
            pending_questions: (ch.pending_questions || []).filter(q => q.status === "pending").length,
            updated_at: ch.updated_at,
        })),
    });
}

// ─── Subcommand: join ────────────────────────────────────────────────────────

function cmdJoin(args) {
    if (args.length === 0) {
        outputError("Uso: join agent <skill> <issue> | join telegram | join <channel-id>");
    }

    const firstArg = args[0].toLowerCase();

    // /context join telegram
    if (firstArg === "telegram") {
        return cmdJoinTelegram();
    }

    // /context join agent <skill> <issue>
    if (firstArg === "agent") {
        const ref = parseAgentRef(args.slice(1));
        return cmdJoinAgent(ref.skill, ref.issue);
    }

    // /context join <skill> #<issue> (shorthand)
    const ref = parseAgentRef(args);
    if (ref.issue) {
        return cmdJoinAgent(ref.skill, ref.issue);
    }

    // /context join <channel-id>
    const channel = contextManager.getChannel(firstArg);
    if (channel) {
        return joinAndOutput(channel.id);
    }

    // Try as custom name
    const customChannel = contextManager.getChannel("custom-" + firstArg);
    if (customChannel) {
        return joinAndOutput(customChannel.id);
    }

    outputError("Canal no encontrado: " + firstArg + ". Usa 'list' para ver canales activos.");
}

function cmdJoinAgent(skill, issue) {
    if (!issue && !skill) {
        outputError("Especifica al menos un skill o issue. Ej: android-dev #1913");
    }

    // Find agent in registry
    const agent = findAgent(skill, issue);
    let channel;

    if (agent) {
        channel = contextManager.getOrCreateAgentChannel(agent);
    } else {
        // Agent not found in registry — create channel anyway for observation
        const channelId = "agent-" + (issue || skill || "unknown");
        channel = contextManager.getChannel(channelId);
        if (!channel) {
            channel = contextManager.createChannel(channelId, (skill || "agent") + " #" + (issue || "?"), {
                type: "agent",
                issue: issue ? "#" + issue : null,
                skill: skill || null,
            });
        }
    }

    // Import recent activity as retroactive messages
    if (agent && agent.session_id && channel.messages.length === 0) {
        const activity = importRecentActivity(agent.session_id, 20);
        for (const entry of activity) {
            contextManager.postMessage(channel.id, {
                from: "system",
                from_label: agent.agent_name || agent.skill || "Agente",
                type: "activity",
                content: "[" + entry.tool + "] " + (entry.target || "--"),
            });
        }
    }

    joinAndOutput(channel.id);
}

function cmdJoinTelegram() {
    // Find or create telegram channel
    let channel = contextManager.findTelegramChannel();
    const today = new Date().toISOString().substring(0, 10).replace(/-/g, "");

    if (!channel || channel.id !== "telegram-" + today) {
        channel = contextManager.createChannel("telegram-" + today, "Telegram " + today, {
            type: "telegram",
        });

        // Import recent Telegram history
        const history = importTelegramHistory(30);
        for (const entry of history) {
            contextManager.postMessage(channel.id, {
                from: "telegram",
                from_label: entry.from || "Telegram",
                type: "text",
                content: entry.text || entry.message || "(media)",
            });
        }
    }

    // Auto-unir a Telegram como participante para que el bridge retransmita
    contextManager.joinChannel(channel.id, { type: "telegram", label: "Telegram" });

    // Auto-start outbox drain si el Pulpo no está corriendo
    ensureOutboxDrain();

    joinAndOutput(channel.id);
}

function ensureOutboxDrain() {
    try {
        const { spawnSync, spawn } = require("child_process");
        const drainScript = path.join(__dirname, "..", "..", ".pipeline", "outbox-drain.js");
        if (!fs.existsSync(drainScript)) return;

        // Check si ya hay un Pulpo o drain corriendo
        const r = spawnSync("wmic", [
            "process", "where", "name='node.exe'",
            "get", "ProcessId,CommandLine", "/format:csv"
        ], { encoding: "utf8", timeout: 10000, windowsHide: true });
        const stdout = r.stdout || "";
        if (stdout.includes("pulpo.js") || stdout.includes("outbox-drain.js")) return;

        // Lanzar drain en background
        const logPath = path.join(__dirname, "..", "..", ".pipeline", "logs", "outbox-drain.log");
        const logFd = fs.openSync(logPath, "a");
        const child = spawn(process.execPath, [drainScript], {
            detached: true, stdio: ["ignore", logFd, logFd], windowsHide: true
        });
        child.unref();
        fs.closeSync(logFd);
    } catch (e) {
        // Silent fail — no bloquear el join
    }
}

function joinAndOutput(channelId) {
    const sessionId = getSessionId();
    const participant = {
        type: "terminal",
        session_id: sessionId,
        label: "Terminal (" + sessionId + ")",
    };

    const channel = contextManager.joinChannel(channelId, participant);
    if (!channel) {
        outputError("No se pudo unir al canal: " + channelId);
    }

    // Track active context for this terminal
    const me = channel.participants.find(p => p.session_id === sessionId && p.type === "terminal");
    setActiveContext(channelId, me ? me.id : null);

    // Return channel info + recent messages
    output({
        ok: true,
        command: "join",
        channel: {
            id: channel.id,
            name: channel.name,
            origin: channel.origin,
            participants: channel.participants,
            pending_questions: (channel.pending_questions || []).filter(q => q.status === "pending"),
        },
        recent_messages: (channel.messages || []).slice(-20),
    });
}

// ─── Subcommand: leave ───────────────────────────────────────────────────────

function cmdLeave() {
    const active = getActiveContext();
    if (!active) {
        outputError("No estas en ningun canal. Usa 'list' para ver canales activos.");
    }

    if (active.participant_id) {
        contextManager.leaveChannel(active.channel_id, active.participant_id);
    }
    clearActiveContext();

    output({ ok: true, command: "leave", channel_id: active.channel_id });
}

// ─── Subcommand: history ─────────────────────────────────────────────────────

function cmdHistory(args) {
    const active = getActiveContext();
    if (!active) {
        outputError("No estas en ningun canal. Usa 'join' primero.");
    }

    const limit = parseInt(args[0], 10) || 30;
    const messages = contextManager.getMessages(active.channel_id, null, limit);
    const channel = contextManager.getChannel(active.channel_id);

    output({
        ok: true,
        command: "history",
        channel_id: active.channel_id,
        channel_name: channel ? channel.name : active.channel_id,
        messages: messages,
    });
}

// ─── Subcommand: say ─────────────────────────────────────────────────────────

function cmdSay(args) {
    const active = getActiveContext();
    if (!active) {
        outputError("No estas en ningun canal. Usa 'join' primero.");
    }

    const text = args.join(" ");
    if (!text) {
        outputError("Especifica un mensaje. Ej: say Hola equipo");
    }

    const msg = contextManager.postMessage(active.channel_id, {
        from: active.participant_id || "terminal",
        from_label: "Terminal (" + getSessionId() + ")",
        type: "text",
        content: text,
    });

    // Relay inmediato a Telegram si el canal tiene participante telegram
    let relayed = false;
    try {
        const bridge = require("./context-bridge");
        const relayCount = bridge.relayToTelegram(active.channel_id);
        relayed = relayCount > 0;
    } catch (e) {}

    output({ ok: true, command: "say", message: msg, relayed_to_telegram: relayed });
}

// ─── Subcommand: answer ──────────────────────────────────────────────────────

function cmdAnswer(args) {
    const active = getActiveContext();
    if (!active) {
        outputError("No estas en ningun canal. Usa 'join' primero.");
    }

    const text = args.join(" ");
    if (!text) {
        outputError("Especifica una respuesta. Ej: answer Usar DynamoDB");
    }

    // Find the first pending question in the channel
    const pending = contextManager.getPendingChannelQuestions(active.channel_id);
    if (pending.length === 0) {
        outputError("No hay preguntas pendientes en este canal.");
    }

    const question = pending[0]; // Answer the oldest pending question
    const result = contextManager.answerQuestion(
        active.channel_id,
        question.question_id,
        { id: active.participant_id || "terminal", label: "Terminal (" + getSessionId() + ")" },
        text
    );

    output({
        ok: true,
        command: "answer",
        question_id: question.question_id,
        pending_question_id: question.pending_question_id,
        answer: text,
        result: result,
    });
}

// ─── Subcommand: create ──────────────────────────────────────────────────────

function cmdCreate(args) {
    const name = args.join("-").toLowerCase().replace(/[^a-z0-9-]/g, "") || "channel";
    const channelId = "custom-" + name;

    const existing = contextManager.getChannel(channelId);
    if (existing) {
        // Already exists — just join
        return joinAndOutput(channelId);
    }

    contextManager.createChannel(channelId, name, { type: "custom" });
    joinAndOutput(channelId);
}

// ─── Subcommand: status ──────────────────────────────────────────────────────

function cmdStatus() {
    const active = getActiveContext();
    if (!active) {
        // Show overview
        const channels = contextManager.listChannels();
        output({
            ok: true,
            command: "status",
            active_channel: null,
            total_channels: channels.length,
            channels: channels.map(ch => ({
                id: ch.id,
                name: ch.name,
                participants: (ch.participants || []).length,
                pending_questions: (ch.pending_questions || []).filter(q => q.status === "pending").length,
            })),
        });
        return;
    }

    const channel = contextManager.getChannel(active.channel_id);
    if (!channel) {
        clearActiveContext();
        outputError("Canal activo ya no existe: " + active.channel_id);
    }

    const pending = (channel.pending_questions || []).filter(q => q.status === "pending");
    const recentMsgs = (channel.messages || []).slice(-5);

    output({
        ok: true,
        command: "status",
        active_channel: {
            id: channel.id,
            name: channel.name,
            origin: channel.origin,
            participants: channel.participants,
            total_messages: (channel.messages || []).length,
            pending_questions: pending,
            recent_messages: recentMsgs,
        },
    });
}

// ─── Subcommand: cleanup ─────────────────────────────────────────────────────

function cmdCleanup() {
    const removed = contextManager.cleanupStaleChannels();
    output({ ok: true, command: "cleanup", removed: removed });
}

// ─── Main dispatch ───────────────────────────────────────────────────────────

function main() {
    const args = process.argv.slice(2);
    const sub = (args[0] || "status").toLowerCase();
    const rest = args.slice(1);

    switch (sub) {
        case "list":
            return cmdList();
        case "join":
            return cmdJoin(rest);
        case "leave":
            return cmdLeave();
        case "history":
            return cmdHistory(rest);
        case "say":
            return cmdSay(rest);
        case "answer":
            return cmdAnswer(rest);
        case "create":
            return cmdCreate(rest);
        case "status":
            return cmdStatus();
        case "cleanup":
            return cmdCleanup();
        default:
            // Try to interpret as agent reference: "/context android-dev #1913"
            const ref = parseAgentRef(args);
            if (ref.issue || ref.skill) {
                return cmdJoinAgent(ref.skill, ref.issue);
            }
            outputError("Subcomando desconocido: " + sub + ". Usa: list, join, leave, history, say, answer, create, status");
    }
}

main();
