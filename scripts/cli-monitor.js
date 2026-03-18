#!/usr/bin/env node
// cli-monitor.js — Dashboard de estado operativo sin necesidad de Claude
// Uso: node scripts/cli-monitor.js [--json] [--compact]
// Reemplaza /monitor para lectura de estado determinista (#1661)

"use strict";
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const REPO_ROOT = path.resolve(__dirname, "..");
const HOOKS_DIR = path.join(REPO_ROOT, ".claude", "hooks");
const SESSIONS_DIR = path.join(REPO_ROOT, ".claude", "sessions");

const args = process.argv.slice(2);
const JSON_OUTPUT = args.includes("--json");
const COMPACT = args.includes("--compact");

function readJson(file) {
    try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { return null; }
}

function readJsonl(file, limit = 20) {
    try {
        const lines = fs.readFileSync(file, "utf8").trim().split("\n").filter(l => l.trim());
        return lines.slice(-limit).map(l => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean);
    } catch (e) { return []; }
}

function timeSince(ts) {
    if (!ts) return "?";
    const ms = Date.now() - new Date(ts).getTime();
    if (ms < 60000) return Math.floor(ms / 1000) + "s";
    if (ms < 3600000) return Math.floor(ms / 60000) + "m";
    if (ms < 86400000) return Math.floor(ms / 3600000) + "h";
    return Math.floor(ms / 86400000) + "d";
}

// === Collect Data ===

// 1. Sprint
const sprintData = require(path.join(HOOKS_DIR, "sprint-data"));
const roadmap = sprintData.readRoadmap();
const activeSprint = sprintData.getActiveSprint();

// 2. Agent Registry
const registry = readJson(path.join(HOOKS_DIR, "agent-registry.json")) || {};

// 3. Health
const health = readJson(path.join(HOOKS_DIR, "health-check-state.json")) || {};
const components = readJson(path.join(HOOKS_DIR, "health-check-components.json")) || {};

// 4. Metrics
const metrics = readJson(path.join(HOOKS_DIR, "agent-metrics.json")) || {};

// 5. Sessions
let activeSessions = [];
try {
    const files = fs.readdirSync(SESSIONS_DIR).filter(f => f.endsWith(".json") && f !== "archive");
    activeSessions = files.map(f => readJson(path.join(SESSIONS_DIR, f))).filter(Boolean);
} catch (e) {}

// 6. Scrum Health History (last 5)
const scrumHistory = readJsonl(path.join(HOOKS_DIR, "scrum-health-history.jsonl"), 5);

// 7. Recent ops learnings
const opsLearnings = readJsonl(path.join(HOOKS_DIR, "ops-learnings.jsonl"), 5);

// 8. Metrics history
const metricsHistory = readJsonl(path.join(HOOKS_DIR, "agent-metrics-history.jsonl"), 5);

// === JSON Output ===
if (JSON_OUTPUT) {
    console.log(JSON.stringify({
        sprint: activeSprint,
        agents: registry,
        health,
        components,
        metrics: metrics.sessions || [],
        metricsHistory,
        sessions: activeSessions,
        scrumHistory,
        opsLearnings,
        roadmap: (roadmap.sprints || []).map(s => ({ id: s.id, tema: s.tema, status: s.status, stories: (s.stories || []).length }))
    }, null, 2));
    process.exit(0);
}

// === Text Output ===

console.log("╔══════════════════════════════════════════════════════════════╗");
console.log("║          INTRALE PLATFORM — MONITOR OPERATIVO              ║");
console.log("╚══════════════════════════════════════════════════════════════╝");
console.log(`  Fecha: ${new Date().toISOString().slice(0, 19)}`);

// Sprint
console.log("\n┌─ SPRINT ─────────────────────────────────────────────────────");
if (activeSprint) {
    console.log(`│ ${activeSprint.id} — ${activeSprint.tema || "sin tema"}`);
    console.log(`│ Status: ${activeSprint.status} | Size: ${activeSprint.size || "?"}`);
    const stories = activeSprint.stories || [];
    const done = stories.filter(s => s.status === "done").length;
    const inProgress = stories.filter(s => s.status === "in_progress").length;
    const planned = stories.filter(s => s.status === "planned").length;
    console.log(`│ Stories: ${done}✓ ${inProgress}► ${planned}○ (${stories.length} total)`);
    if (!COMPACT) {
        for (const s of stories) {
            const icon = s.status === "done" ? "✓" : s.status === "in_progress" ? "►" : "○";
            console.log(`│   ${icon} #${s.issue} ${(s.title || "").substring(0, 50)} [${s.effort || "?"}]`);
        }
    }
} else {
    console.log("│ Sin sprint activo");
}

// Agents
console.log("├─ AGENTES ────────────────────────────────────────────────────");
const agents = Object.values(registry);
const activeAgents = agents.filter(a => a.status === "active" || a.status === "idle");
if (activeAgents.length === 0) {
    console.log("│ Sin agentes activos");
} else {
    for (const a of activeAgents) {
        const alive = timeSince(a.last_heartbeat);
        console.log(`│ ${a.status === "active" ? "●" : "◐"} #${a.issue || "?"} [${a.skill || "?"}] PID:${a.pid || "?"} heartbeat:${alive} ago`);
    }
}

// Health
console.log("├─ HEALTH ─────────────────────────────────────────────────────");
const healthLevel = health.health_level || "unknown";
const healthIcon = healthLevel === "healthy" ? "✓" : healthLevel === "warning" ? "⚠" : "✗";
console.log(`│ ${healthIcon} ${healthLevel.toUpperCase()} — last check: ${timeSince(health.last_check_ts)} ago`);
if (!COMPACT && components) {
    for (const [name, comp] of Object.entries(components)) {
        const icon = comp.status === "pass" ? "✓" : "✗";
        console.log(`│   ${icon} ${name} (${comp.consecutive_passes || 0}x pass)`);
    }
}

// Metrics
console.log("├─ METRICAS ───────────────────────────────────────────────────");
const sessions = metrics.sessions || [];
if (sessions.length > 0) {
    const totalTools = sessions.reduce((a, s) => a + (s.tool_calls || 0), 0);
    const totalFiles = sessions.reduce((a, s) => a + (s.modified_files_count || 0), 0);
    const totalDuration = sessions.reduce((a, s) => a + (s.duration_min || 0), 0);
    console.log(`│ Sesiones: ${sessions.length} | Tools: ${totalTools} | Files: ${totalFiles} | Duracion: ${totalDuration}min`);
}

// Metrics History (sprint trends)
if (metricsHistory.length > 0) {
    console.log("├─ HISTORIAL DE SPRINTS ────────────────────────────────────────");
    for (const mh of metricsHistory) {
        const s = mh.summary || {};
        console.log(`│ ${mh.sprint_id}: ${s.total_sessions || 0} sesiones, ${s.total_tool_calls || 0} tools, ${s.total_duration_min || 0}min`);
    }
}

// Roadmap
console.log("├─ ROADMAP ────────────────────────────────────────────────────");
for (const sp of (roadmap.sprints || []).slice(0, 5)) {
    const icon = sp.status === "done" ? "✓" : sp.status === "active" ? "►" : "○";
    const storyCount = (sp.stories || []).length;
    console.log(`│ ${icon} ${sp.id} [${sp.status}] ${(sp.tema || "").substring(0, 40)} (${storyCount} stories, ${sp.size || "?"})`);
}

// Recent Ops Issues
if (opsLearnings.length > 0 && !COMPACT) {
    console.log("├─ OPS RECIENTES ──────────────────────────────────────────────");
    for (const ol of opsLearnings) {
        console.log(`│ ${ol.category || "?"}: ${(ol.symptom || "").substring(0, 60)} [${ol.severity || "?"}]`);
    }
}

console.log("└──────────────────────────────────────────────────────────────");
