#!/usr/bin/env node
// cli-branch.js — Gestión de ramas sin necesidad de Claude
// Uso: node scripts/cli-branch.js <issue-number> [slug]
// Reemplaza /branch para operaciones deterministas (#1661)

"use strict";
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const REPO_ROOT = path.resolve(__dirname, "..");
const args = process.argv.slice(2);

if (args.length === 0 || args[0] === "--help") {
    console.log(`
Uso: node scripts/cli-branch.js <issue-number> [slug]

Ejemplos:
  node scripts/cli-branch.js 1234 mi-feature
  node scripts/cli-branch.js 1234              # slug auto-generado desde título del issue

Opciones:
  --worktree    Crear worktree aislado (para agentes)
  --help        Mostrar esta ayuda
`);
    process.exit(0);
}

const issueNumber = args[0].replace("#", "");
const useWorktree = args.includes("--worktree");
const slugArg = args.filter(a => !a.startsWith("--") && a !== issueNumber)[0];

function run(cmd, opts = {}) {
    return execSync(cmd, {
        cwd: opts.cwd || REPO_ROOT,
        encoding: "utf8",
        timeout: 15000,
        windowsHide: true,
        env: { ...process.env, PATH: "/c/Workspaces/gh-cli/bin:" + process.env.PATH }
    }).trim();
}

function getIssueTitle(num) {
    try {
        return run(`gh issue view ${num} --json title --jq .title`);
    } catch (e) {
        return "issue-" + num;
    }
}

function slugify(text) {
    return text.toLowerCase()
        .replace(/[áàäâ]/g, "a").replace(/[éèëê]/g, "e").replace(/[íìïî]/g, "i")
        .replace(/[óòöô]/g, "o").replace(/[úùüû]/g, "u").replace(/ñ/g, "n")
        .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")
        .substring(0, 50);
}

// Main
const currentBranch = run("git branch --show-current");
if (currentBranch !== "main") {
    console.error(`ERROR: Debes estar en main para crear una rama. Estás en: ${currentBranch}`);
    process.exit(1);
}

// Actualizar main
console.log("Actualizando main...");
try { run("git pull origin main --ff-only"); } catch (e) { /* puede fallar offline */ }

const slug = slugArg || slugify(getIssueTitle(issueNumber));
const branchName = `agent/${issueNumber}-${slug}`;

if (useWorktree) {
    const wtPath = path.resolve(REPO_ROOT, `../platform.agent-${issueNumber}-${slug}`);
    console.log(`Creando worktree: ${wtPath}`);
    run(`git worktree add "${wtPath}" -b "${branchName}"`);
    // Copiar .claude/ al worktree
    const claudeSrc = path.join(REPO_ROOT, ".claude");
    const claudeDst = path.join(wtPath, ".claude");
    if (!fs.existsSync(claudeDst)) {
        fs.cpSync(claudeSrc, claudeDst, { recursive: true });
    }
    console.log(`✓ Worktree creado: ${wtPath}`);
    console.log(`✓ Rama: ${branchName}`);
} else {
    console.log(`Creando rama: ${branchName}`);
    run(`git checkout -b "${branchName}"`);
    console.log(`✓ Rama creada: ${branchName}`);
}

console.log(`✓ Listo para trabajar en issue #${issueNumber}`);
