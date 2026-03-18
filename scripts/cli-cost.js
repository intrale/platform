#!/usr/bin/env node
// cli-cost.js — Reporte de costo de tokens sin necesidad de Claude
// Uso: node scripts/cli-cost.js [--sprint SPR-NNN] [--json]
// Reemplaza /cost para cálculo de métricas determinista (#1661)

"use strict";
const fs = require("fs");
const path = require("path");

const REPO_ROOT = path.resolve(__dirname, "..");
const HOOKS_DIR = path.join(REPO_ROOT, ".claude", "hooks");

const args = process.argv.slice(2);
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
    "claude-opus-4-6":           { input: 15.00, output: 75.00 },
    "claude-sonnet-4-6":         { input: 3.00,  output: 15.00 },
    "claude-haiku-4-5-20251001": { input: 0.80,  output: 4.00 },
};

// Current metrics
const metrics = readJson(path.join(HOOKS_DIR, "agent-metrics.json"));
const metricsHistory = readJsonl(path.join(HOOKS_DIR, "agent-metrics-history.jsonl"));

// Model assignments
const SKILL_MODELS = {
    "BackendDev": "claude-opus-4-6", "AndroidDev": "claude-opus-4-6",
    "WebDev": "claude-opus-4-6", "QA": "claude-opus-4-6",
    "Tester": "claude-opus-4-6", "Review": "claude-opus-4-6",
    "Guru": "claude-sonnet-4-6", "Planner": "claude-sonnet-4-6",
    "PO": "claude-sonnet-4-6", "UX": "claude-sonnet-4-6",
    "Security": "claude-sonnet-4-6", "Hotfix": "claude-sonnet-4-6",
};
const DEFAULT_MODEL = "claude-haiku-4-5-20251001";

function estimateCost(session) {
    const model = SKILL_MODELS[session.skill || session.agent_name] || DEFAULT_MODEL;
    const pricing = PRICING[model] || PRICING[DEFAULT_MODEL];
    // Estimate: ~2K tokens per tool call (avg input+output)
    const estInputTokens = (session.tool_calls || 0) * 1500;
    const estOutputTokens = (session.tool_calls || 0) * 500;
    const cost = (estInputTokens * pricing.input + estOutputTokens * pricing.output) / 1000000;
    return { model, cost, input_tokens: estInputTokens, output_tokens: estOutputTokens };
}

// Current sprint
const currentSessions = (metrics && metrics.sessions) || [];
let currentTotal = 0;
const sessionCosts = currentSessions.map(s => {
    const est = estimateCost(s);
    currentTotal += est.cost;
    return { ...s, ...est };
});

if (JSON_OUTPUT) {
    console.log(JSON.stringify({
        current: { sessions: sessionCosts, total_cost_usd: currentTotal },
        history: metricsHistory.map(h => ({
            sprint_id: h.sprint_id,
            ts: h.ts,
            summary: h.summary,
            estimated_cost_usd: (h.summary || { total_tool_calls: 0 }).total_tool_calls * 2000 * 3 / 1000000 // rough average
        }))
    }, null, 2));
    process.exit(0);
}

// Text output
console.log("\n=== INTRALE — Token Cost Report ===\n");

console.log("Sprint Actual:");
console.log("─────────────────────────────────────────────────────");
console.log(`${"Sesión".padEnd(12)} ${"Skill".padEnd(15)} ${"Model".padEnd(25)} ${"Tools".padStart(6)} ${"Est.USD".padStart(10)}`);
console.log("─────────────────────────────────────────────────────");
for (const s of sessionCosts) {
    console.log(`${(s.session_id || "?").substring(0, 10).padEnd(12)} ${(s.skill || s.agent_name || "?").padEnd(15)} ${s.model.padEnd(25)} ${String(s.tool_calls || 0).padStart(6)} $${s.cost.toFixed(4).padStart(9)}`);
}
console.log("─────────────────────────────────────────────────────");
console.log(`${"TOTAL".padEnd(12)} ${"".padEnd(15)} ${"".padEnd(25)} ${"".padStart(6)} $${currentTotal.toFixed(4).padStart(9)}`);

// History
if (metricsHistory.length > 0) {
    console.log("\n\nHistorial de Sprints:");
    console.log("─────────────────────────────────────────────────────");
    console.log(`${"Sprint".padEnd(12)} ${"Sesiones".padStart(10)} ${"Tools".padStart(8)} ${"Duración".padStart(10)} ${"Fecha".padEnd(12)}`);
    console.log("─────────────────────────────────────────────────────");
    for (const h of metricsHistory) {
        const s = h.summary || {};
        console.log(`${(h.sprint_id || "?").padEnd(12)} ${String(s.total_sessions || 0).padStart(10)} ${String(s.total_tool_calls || 0).padStart(8)} ${String((s.total_duration_min || 0) + "min").padStart(10)} ${(h.ts || "?").substring(0, 10).padEnd(12)}`);
    }
}

console.log("\n\nNota: Costos estimados basados en ~2K tokens por tool call.");
console.log("Pricing: Opus=$15/$75, Sonnet=$3/$15, Haiku=$0.80/$4 (per 1M tokens)");
