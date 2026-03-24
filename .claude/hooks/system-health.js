// system-health.js — Soluciones S5, S6 y S7 del reporte operativo 2026-03-24
// S5: Validacion de recursos del sistema (canLaunchAgent)
// S6: Verificacion de git repo valido (isValidGitRepo)
// S7: Metricas de sistema (getSystemMetrics)
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execSync } = require("child_process");

const HOOKS_DIR = __dirname;
const METRICS_FILE = path.join(HOOKS_DIR, "system-health-metrics.json");

let atomicWrite;
try { atomicWrite = require("./atomic-write"); } catch (_) { atomicWrite = null; }

// --- S7: Metricas de sistema ---

function getSystemMetrics() {
  const totalMem = Math.round(os.totalmem() / (1024 * 1024));
  const freeMem = Math.round(os.freemem() / (1024 * 1024));
  const usedPct = Math.round((1 - os.freemem() / os.totalmem()) * 100);

  let nodeProcs = 0, claudeProcs = 0, totalProcs = 0, stashCount = 0;

  try {
    const out = execSync('tasklist /FI "IMAGENAME eq node.exe" /FO CSV /NH', { encoding: "utf8", timeout: 5000, windowsHide: true });
    nodeProcs = out.split("\n").filter(l => l.includes("node.exe")).length;
  } catch (_) {}

  try {
    const out = execSync('tasklist /FI "IMAGENAME eq claude.exe" /FO CSV /NH', { encoding: "utf8", timeout: 5000, windowsHide: true });
    claudeProcs = out.split("\n").filter(l => l.includes("claude.exe")).length;
  } catch (_) {}

  try {
    const out = execSync("tasklist /FO CSV /NH", { encoding: "utf8", timeout: 10000, windowsHide: true });
    totalProcs = out.split("\n").filter(l => l.trim()).length;
  } catch (_) {}

  try {
    const repoRoot = path.resolve(HOOKS_DIR, "..", "..");
    const out = execSync("git stash list", { cwd: repoRoot, encoding: "utf8", timeout: 5000, windowsHide: true });
    stashCount = out.split("\n").filter(l => l.trim()).length;
  } catch (_) {}

  const metrics = {
    ts: new Date().toISOString(),
    ram: { totalMb: totalMem, freeMb: freeMem, usedPct: usedPct },
    procs: { node: nodeProcs, claude: claudeProcs, total: totalProcs },
    stashCount: stashCount
  };

  // Persistir metricas
  if (atomicWrite) {
    try { atomicWrite.writeJsonAtomic(METRICS_FILE, metrics); } catch (_) {}
  } else {
    try { fs.writeFileSync(METRICS_FILE, JSON.stringify(metrics, null, 2), "utf8"); } catch (_) {}
  }

  return metrics;
}

// --- S5: Validacion de recursos ---

const THRESHOLDS = {
  MIN_FREE_RAM_MB: 1500,
  MAX_NODE_PROCS: 25,
  MAX_TOTAL_PROCS: 400,
  MAX_STASH_ENTRIES: 20
};

function canLaunchAgent() {
  const m = getSystemMetrics();
  const issues = [];

  if (m.ram.freeMb < THRESHOLDS.MIN_FREE_RAM_MB) {
    issues.push("RAM insuficiente: " + m.ram.freeMb + "MB libre (minimo " + THRESHOLDS.MIN_FREE_RAM_MB + "MB)");
  }
  if (m.procs.node > THRESHOLDS.MAX_NODE_PROCS) {
    issues.push("Demasiados procesos Node: " + m.procs.node + " (max " + THRESHOLDS.MAX_NODE_PROCS + ")");
  }
  if (m.procs.total > THRESHOLDS.MAX_TOTAL_PROCS) {
    issues.push("Demasiados procesos totales: " + m.procs.total + " (max " + THRESHOLDS.MAX_TOTAL_PROCS + ")");
  }
  if (m.stashCount > THRESHOLDS.MAX_STASH_ENTRIES) {
    issues.push("Demasiados stash entries: " + m.stashCount + " (max " + THRESHOLDS.MAX_STASH_ENTRIES + ")");
  }

  return {
    canLaunch: issues.length === 0,
    metrics: m,
    issues: issues
  };
}

// --- S6: Git-aware verification ---

function isValidGitRepo(dir) {
  if (!dir) return false;
  try {
    // Paso 1: Directorio existe?
    if (!fs.existsSync(dir)) return false;

    // Paso 2: .git existe?
    const gitPath = path.join(dir, ".git");
    if (!fs.existsSync(gitPath)) return false;

    // Paso 3: git status funciona?
    execSync("git status --porcelain", { cwd: dir, timeout: 5000, windowsHide: true, stdio: "pipe" });
    return true;
  } catch (_) {
    return false;
  }
}

module.exports = {
  getSystemMetrics,
  canLaunchAgent,
  isValidGitRepo,
  THRESHOLDS
};
