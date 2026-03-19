#!/usr/bin/env node
// collect-api-usage.js — Extrae métricas reales de consumo de API Anthropic desde logs de agentes
// Uso: node scripts/collect-api-usage.js --log <logFile> --agent <N> --issue <N> --slug <slug> [--sprint <SPR-NNN>]
// Appendea una línea JSON a scripts/logs/api-usage-history.jsonl por cada sesión de agente.
// Issue: #1683

"use strict";
const fs = require("fs");
const path = require("path");

const REPO_ROOT = path.resolve(__dirname, "..");
const LOGS_DIR = path.join(__dirname, "logs");
const HISTORY_FILE = path.join(LOGS_DIR, "api-usage-history.jsonl");
const SPRINT_PLAN_PATH = path.join(__dirname, "sprint-plan.json");

// Precios por modelo (USD por millón de tokens) — actualizado 2026-03
const PRICING = {
    "claude-sonnet-4-6":         { input: 3.00,  output: 15.00, cache_read: 0.30,  cache_write: 3.75  },
    "claude-opus-4-6":           { input: 15.00, output: 75.00, cache_read: 1.50,  cache_write: 18.75 },
    "claude-haiku-4-5-20251001": { input: 0.80,  output: 4.00,  cache_read: 0.08,  cache_write: 1.00  },
};

// --- Parse args ---
function parseArgs() {
    const args = process.argv.slice(2);
    const opts = {};
    for (let i = 0; i < args.length; i++) {
        if (args[i].startsWith("--") && i + 1 < args.length) {
            opts[args[i].substring(2)] = args[++i];
        }
    }
    return {
        logFile: opts.log || "",
        agentNum: parseInt(opts.agent) || 0,
        issue: parseInt(opts.issue) || 0,
        slug: opts.slug || "",
        sprint: opts.sprint || "",
    };
}

// --- Leer sprint desde sprint-plan.json si no se pasó como argumento ---
function resolveSprint(sprintArg) {
    if (sprintArg) return sprintArg;
    try {
        const plan = JSON.parse(fs.readFileSync(SPRINT_PLAN_PATH, "utf8"));
        return plan.sprint_id || "";
    } catch (e) {
        return "";
    }
}

// --- Parsear log de agente ---
function parseAgentLog(logFile) {
    const content = fs.readFileSync(logFile, "utf8");
    const lines = content.split("\n");

    let inputTokens = 0;
    let outputTokens = 0;
    let cacheReadTokens = 0;
    let cacheCreateTokens = 0;
    let apiCalls = 0;
    let toolCalls = 0;
    const modelsBreakdown = {};
    let firstTimestamp = null;
    let lastTimestamp = null;
    let exitCode = null;
    let rateLimitStatus = null;
    let sessionId = null;
    let durationMs = null;

    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        // DEATH_DIAG tiene prefijo "DEATH_DIAG: "
        if (trimmed.startsWith("DEATH_DIAG: ")) {
            try {
                const diag = JSON.parse(trimmed.substring(12));
                exitCode = diag.exitCode != null ? diag.exitCode : null;
                if (diag.timestamp) lastTimestamp = diag.timestamp;
            } catch (e) { /* ignorar */ }
            continue;
        }

        // Intentar parsear como JSON
        let evt;
        try {
            evt = JSON.parse(trimmed);
        } catch (e) {
            continue; // No es JSON, saltar
        }

        // Eventos type: "assistant" con usage
        if (evt.type === "assistant" && evt.message) {
            apiCalls++;
            const msg = evt.message;

            // Modelo
            if (msg.model) {
                modelsBreakdown[msg.model] = (modelsBreakdown[msg.model] || 0) + 1;
            }

            // Usage tokens
            if (msg.usage) {
                inputTokens += msg.usage.input_tokens || 0;
                outputTokens += msg.usage.output_tokens || 0;
                cacheReadTokens += msg.usage.cache_read_input_tokens || 0;
                cacheCreateTokens += msg.usage.cache_creation_input_tokens || 0;
            }

            // Contar tool_use blocks
            if (msg.content && Array.isArray(msg.content)) {
                for (const block of msg.content) {
                    if (block.type === "tool_use") toolCalls++;
                }
            }
        }

        // Eventos type: "result" — duración y session_id
        if (evt.type === "result") {
            if (evt.duration_ms != null) durationMs = evt.duration_ms;
            if (evt.session_id) sessionId = evt.session_id;
        }

        // Eventos con timestamp
        if (evt.timestamp) {
            if (!firstTimestamp) firstTimestamp = evt.timestamp;
            lastTimestamp = evt.timestamp;
        }

        // Rate limit events
        if (evt.type === "rate_limit_event" || (evt.type === "system" && evt.subtype === "rate_limit")) {
            rateLimitStatus = evt.status || evt.subtype || "detected";
        }
    }

    // Fallbacks para timestamps
    if (!firstTimestamp) {
        // Usar fecha de creación del archivo como fallback
        try {
            const stat = fs.statSync(logFile);
            firstTimestamp = stat.birthtime.toISOString();
        } catch (e) {
            firstTimestamp = new Date().toISOString();
        }
    }
    if (!lastTimestamp) {
        try {
            const stat = fs.statSync(logFile);
            lastTimestamp = stat.mtime.toISOString();
        } catch (e) {
            lastTimestamp = new Date().toISOString();
        }
    }

    // Calcular duración
    let durationMin = 0;
    if (durationMs != null) {
        durationMin = Math.round((durationMs / 60000) * 10) / 10;
    } else {
        try {
            const start = new Date(firstTimestamp).getTime();
            const end = new Date(lastTimestamp).getTime();
            if (!isNaN(start) && !isNaN(end) && end > start) {
                durationMin = Math.round(((end - start) / 60000) * 10) / 10;
            }
        } catch (e) { /* ignorar */ }
    }

    // Calcular cache hit rate
    const totalInput = inputTokens + cacheReadTokens + cacheCreateTokens;
    const cacheHitRate = totalInput > 0 ? Math.round((cacheReadTokens / totalInput) * 100) / 100 : 0;

    // Calcular costo estimado
    const primaryModel = Object.entries(modelsBreakdown).sort((a, b) => b[1] - a[1])[0];
    const modelName = primaryModel ? primaryModel[0] : "claude-sonnet-4-6";
    const pricing = PRICING[modelName] || PRICING["claude-sonnet-4-6"];

    const estimatedCostUsd = Math.round((
        (inputTokens * pricing.input) +
        (outputTokens * pricing.output) +
        (cacheReadTokens * pricing.cache_read) +
        (cacheCreateTokens * pricing.cache_write)
    ) / 1000000 * 10000) / 10000; // 4 decimales

    return {
        apiCalls,
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheCreateTokens,
        cacheHitRate,
        toolCalls,
        modelsBreakdown,
        model: modelName,
        startedAt: firstTimestamp,
        endedAt: lastTimestamp,
        durationMin,
        exitCode,
        rateLimitStatus: rateLimitStatus || "none",
        sessionId,
        estimatedCostUsd,
        avgOutputPerCall: apiCalls > 0 ? Math.round(outputTokens / apiCalls) : 0,
    };
}

// --- Verificar duplicados ---
function isDuplicate(agentNum, startedAt) {
    if (!fs.existsSync(HISTORY_FILE)) return false;
    try {
        const lines = fs.readFileSync(HISTORY_FILE, "utf8").trim().split("\n").filter(Boolean);
        for (const line of lines) {
            try {
                const entry = JSON.parse(line);
                if (entry.agent_num === agentNum && entry.started_at === startedAt) {
                    return true;
                }
            } catch (e) { /* ignorar línea corrupta */ }
        }
    } catch (e) { /* archivo no legible */ }
    return false;
}

// --- Main ---
function main() {
    const config = parseArgs();

    if (!config.logFile || !fs.existsSync(config.logFile)) {
        console.error("Error: archivo de log no encontrado:", config.logFile);
        process.exit(1);
    }

    const sprint = resolveSprint(config.sprint);
    const parsed = parseAgentLog(config.logFile);

    // Verificar duplicados
    if (isDuplicate(config.agentNum, parsed.startedAt)) {
        console.log("Duplicado: agente " + config.agentNum + " ya registrado para " + parsed.startedAt);
        return;
    }

    // Construir entrada
    const entry = {
        agent_num: config.agentNum,
        issue: config.issue,
        slug: config.slug,
        sprint: sprint,
        model: parsed.model,
        started_at: parsed.startedAt,
        ended_at: parsed.endedAt,
        duration_min: parsed.durationMin,
        api_calls: parsed.apiCalls,
        input_tokens: parsed.inputTokens,
        output_tokens: parsed.outputTokens,
        cache_read_tokens: parsed.cacheReadTokens,
        cache_create_tokens: parsed.cacheCreateTokens,
        cache_hit_rate: parsed.cacheHitRate,
        avg_output_per_call: parsed.avgOutputPerCall,
        models_breakdown: parsed.modelsBreakdown,
        tool_calls: parsed.toolCalls,
        rate_limit_status: parsed.rateLimitStatus,
        exit_code: parsed.exitCode,
        estimated_cost_usd: parsed.estimatedCostUsd,
        session_id: parsed.sessionId,
        timestamp: new Date().toISOString(),
    };

    // Crear directorio si no existe
    if (!fs.existsSync(LOGS_DIR)) {
        fs.mkdirSync(LOGS_DIR, { recursive: true });
    }

    // Append al historial
    fs.appendFileSync(HISTORY_FILE, JSON.stringify(entry) + "\n", "utf8");

    // Reporte breve
    const summary = [
        "OK:",
        "agent=" + config.agentNum,
        "issue=#" + config.issue,
        "model=" + parsed.model,
        "calls=" + parsed.apiCalls,
        "out=" + parsed.outputTokens + "tok",
        "cache=" + Math.round(parsed.cacheHitRate * 100) + "%",
        "cost=$" + parsed.estimatedCostUsd.toFixed(4),
        "dur=" + parsed.durationMin + "min",
    ].join(" ");

    console.log(summary);
}

main();
