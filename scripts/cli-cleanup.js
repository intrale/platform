#!/usr/bin/env node
// cli-cleanup.js — Limpieza de workspace sin necesidad de Claude
// Uso: node scripts/cli-cleanup.js [--all] [--worktrees] [--logs] [--sessions] [--branches] [--dry-run]
// Reemplaza /cleanup para operaciones deterministas (#1661)

"use strict";
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const REPO_ROOT = path.resolve(__dirname, "..");
const HOOKS_DIR = path.join(REPO_ROOT, ".claude", "hooks");
const SESSIONS_DIR = path.join(REPO_ROOT, ".claude", "sessions");
const ARCHIVE_DIR = path.join(SESSIONS_DIR, "archive");

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const cleanAll = args.includes("--all") || args.length === 0;
const cleanWorktrees = cleanAll || args.includes("--worktrees");
const cleanLogs = cleanAll || args.includes("--logs");
const cleanSessions = cleanAll || args.includes("--sessions");
const cleanBranches = cleanAll || args.includes("--branches");

function run(cmd) {
    try {
        return execSync(cmd, { cwd: REPO_ROOT, encoding: "utf8", timeout: 15000, windowsHide: true,
            env: { ...process.env, PATH: "/c/Workspaces/gh-cli/bin:" + process.env.PATH } }).trim();
    } catch (e) { return ""; }
}

let totalCleaned = 0;

// 1. Worktrees huérfanos
if (cleanWorktrees) {
    console.log("\n=== Worktrees ===");
    const wtList = run("git worktree list --porcelain");
    const worktrees = wtList.split("\n\n").filter(w => w.includes("worktree") && !w.includes(REPO_ROOT.replace(/\\/g, "/")));

    if (worktrees.length === 0) {
        console.log("  Sin worktrees huérfanos");
    } else {
        for (const wt of worktrees) {
            const wtMatch = wt.match(/worktree\s+(.+)/);
            if (wtMatch) {
                const wtPath = wtMatch[1];
                console.log(`  ${DRY_RUN ? "[DRY] " : ""}Removing: ${wtPath}`);
                if (!DRY_RUN) {
                    try { run(`git worktree remove "${wtPath}" --force`); totalCleaned++; } catch (e) {}
                }
            }
        }
    }
    // Prunar worktrees con refs rotas
    if (!DRY_RUN) run("git worktree prune");
}

// 2. Logs antiguos
if (cleanLogs) {
    console.log("\n=== Logs ===");
    try {
        const logRotation = require(path.join(HOOKS_DIR, "log-rotation.js"));
        const results = logRotation.rotate({ dryRun: DRY_RUN, verbose: true });
        totalCleaned += results.logs.filter(r => r.rotated).length + results.jsonl.filter(r => r.rotated).length;
    } catch (e) {
        console.log("  Error al rotar logs: " + e.message);
    }

    // Limpiar archivos datados >90 días
    try {
        const now = Date.now();
        const MAX_AGE = 90 * 24 * 60 * 60 * 1000;
        const hooksFiles = fs.readdirSync(HOOKS_DIR);
        for (const f of hooksFiles) {
            if (f.match(/\.\d{4}-\d{2}-\d{2}\.log$/)) {
                const fp = path.join(HOOKS_DIR, f);
                if (now - fs.statSync(fp).mtimeMs > MAX_AGE) {
                    console.log(`  ${DRY_RUN ? "[DRY] " : ""}Eliminando log datado: ${f}`);
                    if (!DRY_RUN) { fs.unlinkSync(fp); totalCleaned++; }
                }
            }
        }
    } catch (e) {}
}

// 3. Sesiones archivadas >30 días
if (cleanSessions) {
    console.log("\n=== Sesiones ===");
    if (fs.existsSync(ARCHIVE_DIR)) {
        const now = Date.now();
        const MAX_AGE = 30 * 24 * 60 * 60 * 1000;
        let archiveDeleted = 0;
        const archiveFiles = fs.readdirSync(ARCHIVE_DIR).filter(f => f.endsWith(".json"));
        for (const f of archiveFiles) {
            const fp = path.join(ARCHIVE_DIR, f);
            if (now - fs.statSync(fp).mtimeMs > MAX_AGE) {
                if (!DRY_RUN) { fs.unlinkSync(fp); }
                archiveDeleted++;
            }
        }
        console.log(`  ${archiveDeleted} sesiones archivadas >30d ${DRY_RUN ? "encontradas" : "eliminadas"}`);
        totalCleaned += archiveDeleted;
    } else {
        console.log("  Sin directorio de archivo");
    }

    // Métricas snapshot markers >60 días
    try {
        const now = Date.now();
        const markers = fs.readdirSync(HOOKS_DIR).filter(f => f.startsWith("metrics-snapshot-") && f.endsWith(".done"));
        let markersCleaned = 0;
        for (const f of markers) {
            const fp = path.join(HOOKS_DIR, f);
            if (now - fs.statSync(fp).mtimeMs > 60 * 24 * 60 * 60 * 1000) {
                if (!DRY_RUN) { fs.unlinkSync(fp); }
                markersCleaned++;
            }
        }
        if (markersCleaned > 0) console.log(`  ${markersCleaned} markers de snapshot >60d eliminados`);
    } catch (e) {}
}

// 4. Ramas remotas mergeadas
if (cleanBranches) {
    console.log("\n=== Ramas remotas mergeadas ===");
    try {
        run("git fetch --prune origin");
        const merged = run('git branch -r --merged origin/main').split("\n")
            .map(b => b.trim())
            .filter(b => b.startsWith("origin/agent/") || b.startsWith("origin/feature/") || b.startsWith("origin/bugfix/"));

        if (merged.length === 0) {
            console.log("  Sin ramas remotas mergeadas para limpiar");
        } else {
            for (const branch of merged) {
                const remoteBranch = branch.replace("origin/", "");
                console.log(`  ${DRY_RUN ? "[DRY] " : ""}Eliminando remota: ${remoteBranch}`);
                if (!DRY_RUN) {
                    try { run(`git push origin --delete "${remoteBranch}"`); totalCleaned++; } catch (e) {}
                }
            }
        }
        // Limpiar ramas locales que ya no tienen remota
        const locals = run("git branch").split("\n").map(b => b.trim().replace("* ", ""))
            .filter(b => b.startsWith("agent/") || b.startsWith("feature/") || b.startsWith("bugfix/"));
        for (const local of locals) {
            try {
                run(`git rev-parse --verify "origin/${local}" 2>/dev/null`);
            } catch (e) {
                console.log(`  ${DRY_RUN ? "[DRY] " : ""}Eliminando local sin remota: ${local}`);
                if (!DRY_RUN) { try { run(`git branch -d "${local}"`); totalCleaned++; } catch (e2) {} }
            }
        }
    } catch (e) {
        console.log("  Error al limpiar ramas: " + e.message);
    }
}

console.log(`\n=== Resumen: ${totalCleaned} items limpiados ${DRY_RUN ? "(dry-run)" : ""} ===`);
