#!/usr/bin/env node
// cli-ops.js — Health check y diagnóstico operativo sin necesidad de Claude
// Uso: node scripts/cli-ops.js [--fix] [--verbose]
// Reemplaza /ops para operaciones deterministas (#1661)

"use strict";
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const REPO_ROOT = path.resolve(__dirname, "..");
const HOOKS_DIR = path.join(REPO_ROOT, ".claude", "hooks");

const args = process.argv.slice(2);
const AUTO_FIX = args.includes("--fix");
const VERBOSE = args.includes("--verbose");

function run(cmd) {
    try {
        return execSync(cmd, { cwd: REPO_ROOT, encoding: "utf8", timeout: 15000, windowsHide: true,
            env: { ...process.env, PATH: "/c/Workspaces/gh-cli/bin:" + process.env.PATH } }).trim();
    } catch (e) { return null; }
}

function readJson(file) {
    try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { return null; }
}

const checks = [];

function check(name, fn) {
    try {
        const result = fn();
        checks.push({ name, ...result });
        const icon = result.status === "pass" ? "✓" : result.status === "warn" ? "⚠" : "✗";
        console.log(`  ${icon} ${name}: ${result.message}`);
        if (result.fix && AUTO_FIX) {
            console.log(`    → Auto-fix: ${result.fix}`);
        }
    } catch (e) {
        checks.push({ name, status: "fail", message: e.message });
        console.log(`  ✗ ${name}: ERROR — ${e.message}`);
    }
}

console.log("\n=== INTRALE OPS — Health Check ===\n");

// 1. Java
check("Java 21", () => {
    const javaHomePaths = [
        "C:\\Users\\Administrator\\.jdks\\temurin-21.0.7",
        "/c/Users/Administrator/.jdks/temurin-21.0.7"
    ];
    const found = javaHomePaths.some(p => fs.existsSync(p));
    if (!found) {
        return { status: "fail", message: "JAVA_HOME no encontrado" };
    }
    return { status: "pass", message: "Temurin 21.0.7 OK" };
});

// 2. gh CLI
check("GitHub CLI", () => {
    const version = run("gh --version");
    return version ? { status: "pass", message: version.split("\n")[0] } : { status: "fail", message: "gh no encontrado" };
});

// 3. Git status
check("Git clean", () => {
    const status = run("git status --porcelain");
    const lines = (status || "").split("\n").filter(l => l.trim() && !l.includes(".claude/hooks/"));
    return lines.length > 0
        ? { status: "warn", message: `${lines.length} archivos modificados fuera de hooks` }
        : { status: "pass", message: "Working tree limpio" };
});

// 4. Worktrees
check("Worktrees", () => {
    const wtList = run("git worktree list");
    const lines = (wtList || "").split("\n").filter(l => l.trim());
    const dead = lines.filter(l => l.includes("[prunable]") || l.includes("[locked]"));
    if (dead.length > 0) {
        return { status: "warn", message: `${dead.length} worktrees muertos/locked`, fix: "git worktree prune" };
    }
    return { status: "pass", message: `${lines.length} worktrees (incluye principal)` };
});

// 5. Settings
check("Settings", () => {
    const settings = readJson(path.join(REPO_ROOT, ".claude", "settings.local.json"));
    if (!settings) return { status: "fail", message: "settings.local.json no encontrado" };
    const allows = (settings.permissions || {}).allow || [];
    const denies = (settings.permissions || {}).deny || [];
    return { status: "pass", message: `${allows.length} allow + ${denies.length} deny` };
});

// 6. Hooks health
check("Hooks", () => {
    const hookFiles = fs.readdirSync(HOOKS_DIR).filter(f => f.endsWith(".js"));
    return { status: "pass", message: `${hookFiles.length} hooks JavaScript` };
});

// 7. Roadmap consistency
check("Roadmap", () => {
    const sprintData = require(path.join(HOOKS_DIR, "sprint-data"));
    const rm = sprintData.readRoadmap();
    const errors = sprintData.validateRoadmap(rm);
    const active = sprintData.getActiveSprint();
    if (errors.length > 0) {
        return { status: "warn", message: `${errors.length} errores: ${errors[0]}` };
    }
    return { status: "pass", message: `${(rm.sprints || []).length} sprints, activo: ${active ? active.id : "ninguno"}` };
});

// 8. Disk — activity-log size
check("Activity Log", () => {
    const logFile = path.join(REPO_ROOT, ".claude", "activity-log.jsonl");
    try {
        const lines = fs.readFileSync(logFile, "utf8").trim().split("\n").length;
        const archiveFile = logFile.replace(".jsonl", ".archive.jsonl");
        let archiveLines = 0;
        try { archiveLines = fs.readFileSync(archiveFile, "utf8").trim().split("\n").length; } catch (e) {}
        return { status: "pass", message: `${lines} entradas activas, ${archiveLines} archivadas` };
    } catch (e) {
        return { status: "warn", message: "activity-log.jsonl no encontrado" };
    }
});

// 9. Telegram config
check("Telegram", () => {
    const config = readJson(path.join(HOOKS_DIR, "telegram-config.json"));
    if (!config || !config.bot_token) return { status: "fail", message: "telegram-config.json sin bot_token" };
    return { status: "pass", message: "Bot configurado" };
});

// 10. Procesos agente
check("Agent processes", () => {
    const pidsFile = path.join(REPO_ROOT, "scripts", "sprint-pids.json");
    const pids = readJson(pidsFile);
    if (!pids || Object.keys(pids).length === 0) return { status: "pass", message: "Sin PIDs registrados" };
    let alive = 0, dead = 0;
    for (const [key, pid] of Object.entries(pids)) {
        const check = run(`tasklist /FI "PID eq ${pid}" /NH`);
        if (check && check.includes(String(pid))) { alive++; } else { dead++; }
    }
    if (dead > 0) return { status: "warn", message: `${alive} vivos, ${dead} muertos`, fix: "Limpiar sprint-pids.json" };
    return { status: "pass", message: `${alive} procesos vivos` };
});

// Summary
console.log("\n=== Resumen ===");
const passed = checks.filter(c => c.status === "pass").length;
const warned = checks.filter(c => c.status === "warn").length;
const failed = checks.filter(c => c.status === "fail").length;
console.log(`  ${passed} pass, ${warned} warnings, ${failed} failures`);

if (AUTO_FIX && warned > 0) {
    console.log("\n=== Auto-fix ===");
    for (const c of checks.filter(c => c.fix)) {
        console.log(`  Ejecutando: ${c.fix}`);
        run(c.fix);
    }
}

process.exit(failed > 0 ? 1 : 0);
