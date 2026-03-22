#!/usr/bin/env node
// cli-cost.js — Reporte de costo de tokens con datos reales + estimados
// Uso: node scripts/cli-cost.js [--sprint SPR-NNN] [--json]
//      node scripts/cli-cost.js trends [--last N] [--json]   → tendencias cross-sprint (#1807)
// Fuentes: api-usage-history.jsonl (real) + agent-metrics.json (estimado) (#1661, #1683)

"use strict";
const fs = require("fs");
const path = require("path");

const REPO_ROOT = path.resolve(__dirname, "..");
const HOOKS_DIR = path.join(REPO_ROOT, ".claude", "hooks");
const LOGS_DIR = path.join(__dirname, "logs");
const API_HISTORY_FILE = path.join(LOGS_DIR, "api-usage-history.jsonl");

const args = process.argv.slice(2);

// Subcomando "trends": delegar a sprint-trends.js (#1807)
if (args[0] === "trends") {
    const trends = require(path.join(__dirname, "sprint-trends.js"));
    const lastIdx = args.indexOf("--last");
    const nSprints = lastIdx >= 0 && args[lastIdx + 1] ? parseInt(args[lastIdx + 1]) : 10;
    if (args.includes("--json")) {
        const history = trends.loadHistory(nSprints);
        console.log(JSON.stringify(history, null, 2));
    } else {
        console.log(trends.buildTrendsText(nSprints));
    }
    process.exit(0);
}

const JSON_OUTPUT = args.includes("--json");
const sprintArg = args.indexOf("--sprint") !== -1 ? args[args.indexOf("--sprint") + 1] : null;

function readJson(file) {
    try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { return null; }
}

function readJsonl(file) {
    try {
        return fs.readFileSync(file, "utf8").trim().split("\n")
            .filter(l => l.trim())
            .map(l => { try { return JSON.parse(l); } catch (e) { return null; } })
            .filter(Boolean);
    } catch (e) { return []; }
}

// Pricing (USD per million tokens, as of 2026-03)
const PRICING = {
    "claude-opus-4-6":           { input: 15.00, output: 75.00, cache_read: 1.50,  cache_write: 18.75 },
    "claude-sonnet-4-6":         { input: 3.00,  output: 15.00, cache_read: 0.30,  cache_write: 3.75  },
    "claude-haiku-4-5-20251001": { input: 0.80,  output: 4.00,  cache_read: 0.08,  cache_write: 1.00  },
};

// --- Datos reales de api-usage-history.jsonl (#1683) ---
const apiHistory = readJsonl(API_HISTORY_FILE);
const hasRealData = apiHistory.length > 0;

// --- Datos estimados legacy de agent-metrics.json ---
const metrics = readJson(path.join(HOOKS_DIR, "agent-metrics.json"));
const metricsHistory = readJsonl(path.join(HOOKS_DIR, "agent-metrics-history.jsonl"));

// Model assignments (para estimaciones legacy)
const SKILL_MODELS = {
    "BackendDev": "claude-opus-4-6", "AndroidDev": "claude-opus-4-6",
    "WebDev": "claude-opus-4-6", "QA": "claude-opus-4-6",
    "Tester": "claude-opus-4-6", "Review": "claude-opus-4-6",
    "Guru": "claude-sonnet-4-6", "Planner": "claude-sonnet-4-6",
    "PO": "claude-sonnet-4-6", "UX": "claude-sonnet-4-6",
    "Security": "claude-sonnet-4-6", "Hotfix": "claude-sonnet-4-6",
};
const DEFAULT_MODEL = "claude-haiku-4-5-20251001";

function estimateCostLegacy(session) {
    const model = SKILL_MODELS[session.skill || session.agent_name] || DEFAULT_MODEL;
    const pricing = PRICING[model] || PRICING[DEFAULT_MODEL];
    const estInputTokens = (session.tool_calls || 0) * 1500;
    const estOutputTokens = (session.tool_calls || 0) * 500;
    const cost = (estInputTokens * pricing.input + estOutputTokens * pricing.output) / 1000000;
    return { model, cost, input_tokens: estInputTokens, output_tokens: estOutputTokens };
}

function formatNum(n) { return n.toLocaleString("es-AR"); }

// --- JSON output ---
if (JSON_OUTPUT) {
    const filteredHistory = sprintArg ? apiHistory.filter(e => e.sprint === sprintArg) : apiHistory;
    const realTotal = filteredHistory.reduce((sum, e) => sum + (e.estimated_cost_usd || 0), 0);
    const realTokens = {
        input: filteredHistory.reduce((sum, e) => sum + (e.input_tokens || 0), 0),
        output: filteredHistory.reduce((sum, e) => sum + (e.output_tokens || 0), 0),
        cache_read: filteredHistory.reduce((sum, e) => sum + (e.cache_read_tokens || 0), 0),
        cache_create: filteredHistory.reduce((sum, e) => sum + (e.cache_create_tokens || 0), 0),
    };
    console.log(JSON.stringify({
        source: hasRealData ? "api-usage-history" : "agent-metrics-estimated",
        real: { sessions: filteredHistory, total_cost_usd: realTotal, tokens: realTokens },
        estimated: {
            sessions: ((metrics && metrics.sessions) || []).map(s => ({ ...s, ...estimateCostLegacy(s) })),
        },
    }, null, 2));
    process.exit(0);
}

// --- Text output ---
console.log("\n=== INTRALE — Token Cost Report ===\n");

// Sección 1: Datos reales (si existen)
if (hasRealData) {
    const filtered = sprintArg ? apiHistory.filter(e => e.sprint === sprintArg) : apiHistory;
    const sprintLabel = sprintArg || "Todas las sesiones";

    console.log("Consumo Real de API (" + sprintLabel + "):");
    console.log("═══════════════════════════════════════════════════════════════════════════════════════");
    console.log(
        "Ag#".padEnd(5) +
        "Issue".padEnd(8) +
        "Slug".padEnd(22) +
        "Modelo".padEnd(22) +
        "Calls".padStart(6) +
        "Input".padStart(10) +
        "Output".padStart(10) +
        "Cache%".padStart(8) +
        "Costo".padStart(10) +
        "Dur".padStart(7)
    );
    console.log("─".repeat(88));

    let totalCost = 0;
    let totalInput = 0;
    let totalOutput = 0;
    let totalCacheRead = 0;
    let totalCacheCreate = 0;
    let totalCalls = 0;

    for (const e of filtered) {
        totalCost += e.estimated_cost_usd || 0;
        totalInput += e.input_tokens || 0;
        totalOutput += e.output_tokens || 0;
        totalCacheRead += e.cache_read_tokens || 0;
        totalCacheCreate += e.cache_create_tokens || 0;
        totalCalls += e.api_calls || 0;

        const cacheStr = Math.round((e.cache_hit_rate || 0) * 100) + "%";
        console.log(
            String(e.agent_num || "?").padEnd(5) +
            ("#" + (e.issue || "?")).padEnd(8) +
            (e.slug || "?").substring(0, 20).padEnd(22) +
            (e.model || "?").substring(0, 20).padEnd(22) +
            String(e.api_calls || 0).padStart(6) +
            formatNum(e.input_tokens || 0).padStart(10) +
            formatNum(e.output_tokens || 0).padStart(10) +
            cacheStr.padStart(8) +
            ("$" + (e.estimated_cost_usd || 0).toFixed(4)).padStart(10) +
            ((e.duration_min || 0) + "m").padStart(7)
        );
    }

    console.log("─".repeat(88));
    const totalAllInput = totalInput + totalCacheRead + totalCacheCreate;
    const avgCache = totalAllInput > 0 ? Math.round(totalCacheRead / totalAllInput * 100) : 0;
    console.log(
        "TOTAL".padEnd(5) +
        "".padEnd(8) +
        (filtered.length + " sesiones").padEnd(22) +
        "".padEnd(22) +
        String(totalCalls).padStart(6) +
        formatNum(totalInput).padStart(10) +
        formatNum(totalOutput).padStart(10) +
        (avgCache + "%").padStart(8) +
        ("$" + totalCost.toFixed(4)).padStart(10) +
        "".padStart(7)
    );

    // Top métricas
    if (filtered.length > 1) {
        const sorted = [...filtered].sort((a, b) => (b.estimated_cost_usd || 0) - (a.estimated_cost_usd || 0));
        const bestCache = [...filtered].sort((a, b) => (b.cache_hit_rate || 0) - (a.cache_hit_rate || 0));
        const worstCache = [...filtered].sort((a, b) => (a.cache_hit_rate || 0) - (b.cache_hit_rate || 0));

        console.log("\nTop Métricas:");
        console.log("  Más costoso:  #" + sorted[0].issue + " (" + sorted[0].slug + ") — $" + (sorted[0].estimated_cost_usd || 0).toFixed(4));
        console.log("  Mejor cache:  #" + bestCache[0].issue + " (" + bestCache[0].slug + ") — " + Math.round((bestCache[0].cache_hit_rate || 0) * 100) + "%");
        console.log("  Peor cache:   #" + worstCache[0].issue + " (" + worstCache[0].slug + ") — " + Math.round((worstCache[0].cache_hit_rate || 0) * 100) + "%");
    }

    // Desglose por sprint si no se filtró
    if (!sprintArg && filtered.length > 0) {
        const sprints = {};
        for (const e of filtered) {
            const s = e.sprint || "sin-sprint";
            if (!sprints[s]) sprints[s] = { count: 0, cost: 0, calls: 0 };
            sprints[s].count++;
            sprints[s].cost += e.estimated_cost_usd || 0;
            sprints[s].calls += e.api_calls || 0;
        }
        console.log("\nPor Sprint:");
        console.log("  " + "Sprint".padEnd(15) + "Sesiones".padStart(10) + "Calls".padStart(8) + "Costo".padStart(12));
        console.log("  " + "─".repeat(45));
        for (const [sid, data] of Object.entries(sprints).sort()) {
            console.log("  " + sid.padEnd(15) + String(data.count).padStart(10) + String(data.calls).padStart(8) + ("$" + data.cost.toFixed(4)).padStart(12));
        }
    }

    console.log("\nPricing real: cache_read incluido en cálculo de costo.");
    console.log("Opus=$15/$75/$1.50/$18.75, Sonnet=$3/$15/$0.30/$3.75, Haiku=$0.80/$4/$0.08/$1 (in/out/cache_r/cache_w per 1M tok)");
}

// Sección 2: Datos estimados legacy (si no hay datos reales o como complemento)
const currentSessions = (metrics && metrics.sessions) || [];
if (currentSessions.length > 0) {
    if (hasRealData) console.log("\n");
    console.log((hasRealData ? "Sesiones Estimadas (legacy, agent-metrics.json):" : "Sprint Actual (estimado):"));
    console.log("─────────────────────────────────────────────────────");
    console.log(`${"Sesión".padEnd(12)} ${"Skill".padEnd(15)} ${"Model".padEnd(25)} ${"Tools".padStart(6)} ${"Est.USD".padStart(10)}`);
    console.log("─────────────────────────────────────────────────────");

    let currentTotal = 0;
    for (const s of currentSessions) {
        const est = estimateCostLegacy(s);
        currentTotal += est.cost;
        console.log(`${(s.session_id || "?").substring(0, 10).padEnd(12)} ${(s.skill || s.agent_name || "?").padEnd(15)} ${est.model.padEnd(25)} ${String(s.tool_calls || 0).padStart(6)} $${est.cost.toFixed(4).padStart(9)}`);
    }
    console.log("─────────────────────────────────────────────────────");
    console.log(`${"TOTAL".padEnd(12)} ${"".padEnd(15)} ${"".padEnd(25)} ${"".padStart(6)} $${currentTotal.toFixed(4).padStart(9)}`);

    if (!hasRealData) {
        console.log("\nNota: Costos estimados basados en ~2K tokens por tool call.");
        console.log("Para datos reales, actualizar a collect-api-usage.js (#1683).");
    }
}

// History legacy
if (metricsHistory.length > 0 && !hasRealData) {
    console.log("\n\nHistorial de Sprints (estimado):");
    console.log("─────────────────────────────────────────────────────");
    console.log(`${"Sprint".padEnd(12)} ${"Sesiones".padStart(10)} ${"Tools".padStart(8)} ${"Duración".padStart(10)} ${"Fecha".padEnd(12)}`);
    console.log("─────────────────────────────────────────────────────");
    for (const h of metricsHistory) {
        const s = h.summary || {};
        console.log(`${(h.sprint_id || "?").padEnd(12)} ${String(s.total_sessions || 0).padStart(10)} ${String(s.total_tool_calls || 0).padStart(8)} ${String((s.total_duration_min || 0) + "min").padStart(10)} ${(h.ts || "?").substring(0, 10).padEnd(12)}`);
    }
}

if (!hasRealData && currentSessions.length === 0) {
    console.log("Sin métricas registradas.");
    console.log("Los datos reales se registran automáticamente al finalizar cada agente.");
}

console.log("");
