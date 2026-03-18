#!/usr/bin/env node
// cli-scrum.js — Validación de salud del sprint sin necesidad de Claude
// Uso: node scripts/cli-scrum.js [--fix] [--json]
// Reemplaza /scrum para validación determinista (#1661)

"use strict";
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const REPO_ROOT = path.resolve(__dirname, "..");
const HOOKS_DIR = path.join(REPO_ROOT, ".claude", "hooks");

const args = process.argv.slice(2);
const AUTO_FIX = args.includes("--fix");
const JSON_OUTPUT = args.includes("--json");

function run(cmd) {
    try {
        return execSync(cmd, { cwd: REPO_ROOT, encoding: "utf8", timeout: 15000, windowsHide: true,
            env: { ...process.env, PATH: "/c/Workspaces/gh-cli/bin:" + process.env.PATH } }).trim();
    } catch (e) { return null; }
}

function readJson(file) {
    try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { return null; }
}

const sprintData = require(path.join(HOOKS_DIR, "sprint-data"));
const rm = sprintData.readRoadmap();
const active = sprintData.getActiveSprint();
const registry = readJson(path.join(HOOKS_DIR, "agent-registry.json")) || {};

const issues = [];

if (!active) {
    issues.push({ severity: "info", message: "Sin sprint activo" });
} else {
    const stories = active.stories || [];

    // 1. Validar consistencia roadmap
    const errors = sprintData.validateRoadmap(rm);
    for (const e of errors) {
        issues.push({ severity: "error", message: "Roadmap: " + e });
    }

    // 2. Cruzar in_progress con agent-registry
    const inProgress = stories.filter(s => s.status === "in_progress");
    const activeAgents = Object.values(registry).filter(a => a.status === "active" || a.status === "idle");

    for (const story of inProgress) {
        const hasAgent = activeAgents.some(a => String(a.issue) === String(story.issue));
        if (!hasAgent) {
            issues.push({
                severity: "warn",
                message: `#${story.issue} está in_progress pero NO tiene agente activo en registry`,
                fix: AUTO_FIX ? "revert-to-planned" : null
            });
            if (AUTO_FIX) {
                sprintData.updateStoryStatus(story.issue, "planned", "cli-scrum-fix");
            }
        }
    }

    // 3. Agentes activos sin story in_progress
    for (const agent of activeAgents) {
        const hasStory = inProgress.some(s => String(s.issue) === String(agent.issue));
        if (!hasStory && agent.issue) {
            issues.push({
                severity: "warn",
                message: `Agente activo para #${agent.issue} pero story no está in_progress`
            });
        }
    }

    // 4. Verificar GitHub issues
    for (const story of stories.filter(s => s.status === "done")) {
        try {
            const ghState = run(`gh issue view ${story.issue} --json state --jq .state`);
            if (ghState && ghState !== "CLOSED") {
                issues.push({
                    severity: "warn",
                    message: `#${story.issue} marcado done en roadmap pero OPEN en GitHub`
                });
            }
        } catch (e) {}
    }

    // 5. Carry-over check
    for (const story of stories) {
        if (story.moved_from && story.status !== "done") {
            issues.push({
                severity: "info",
                message: `#${story.issue} es carry-over desde ${story.moved_from}`
            });
        }
    }

    // 6. Concurrency check
    const concLimit = (active.execution || {}).concurrency_limit || 3;
    if (inProgress.length > concLimit) {
        issues.push({
            severity: "error",
            message: `${inProgress.length} stories in_progress excede límite de ${concLimit}`
        });
    }
}

// Output
if (JSON_OUTPUT) {
    console.log(JSON.stringify({
        sprint: active ? active.id : null,
        health: issues.filter(i => i.severity === "error").length > 0 ? "unhealthy" :
                issues.filter(i => i.severity === "warn").length > 0 ? "warning" : "healthy",
        issues,
        fixes_applied: AUTO_FIX ? issues.filter(i => i.fix).length : 0
    }, null, 2));
} else {
    console.log("\n=== SCRUM — Sprint Health ===\n");
    if (active) {
        console.log(`Sprint: ${active.id} — ${active.tema || ""}`);
        const stories = active.stories || [];
        const done = stories.filter(s => s.status === "done").length;
        const ip = stories.filter(s => s.status === "in_progress").length;
        console.log(`Progress: ${done}/${stories.length} done, ${ip} in_progress\n`);
    }

    if (issues.length === 0) {
        console.log("  ✓ Todo OK — sin inconsistencias");
    } else {
        for (const i of issues) {
            const icon = i.severity === "error" ? "✗" : i.severity === "warn" ? "⚠" : "ℹ";
            console.log(`  ${icon} [${i.severity.toUpperCase()}] ${i.message}`);
            if (i.fix && AUTO_FIX) console.log(`    → Fix aplicado: ${i.fix}`);
        }
    }

    const errs = issues.filter(i => i.severity === "error").length;
    const warns = issues.filter(i => i.severity === "warn").length;
    console.log(`\nResumen: ${errs} errores, ${warns} warnings, ${issues.length} total`);
}
