#!/usr/bin/env node
// pre-sprint-cleanup.js — S4 del reporte operativo 2026-03-24
// Limpieza de recursos pre-sprint: stashes, temps, state files corruptos
// Ejecutado por Start-Agente.ps1 antes de lanzar agentes
"use strict";

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const HOOKS_DIR = __dirname;
const REPO_ROOT = path.resolve(HOOKS_DIR, "..", "..");

let atomicWrite;
try { atomicWrite = require("./atomic-write"); } catch (_) { atomicWrite = null; }

let circuitBreaker;
try { circuitBreaker = require("./circuit-breaker"); } catch (_) { circuitBreaker = null; }

const results = { steps: [], errors: [], cleaned: 0 };

function log(msg) { results.steps.push(msg); }
function err(msg) { results.errors.push(msg); }

// Paso 1: Stash cleanup — mantener solo las 5 mas recientes
try {
  const stashList = execSync("git stash list", { cwd: REPO_ROOT, encoding: "utf8", timeout: 5000, windowsHide: true });
  const stashCount = stashList.split("\n").filter(l => l.trim()).length;
  if (stashCount > 5) {
    // Borrar las mas antiguas (de la 5 en adelante)
    for (let i = stashCount - 1; i >= 5; i--) {
      try { execSync("git stash drop stash@{" + i + "}", { cwd: REPO_ROOT, timeout: 5000, windowsHide: true }); } catch (_) {}
    }
    log("Stash: " + (stashCount - 5) + " entradas eliminadas (quedan 5)");
    results.cleaned += stashCount - 5;
  } else {
    log("Stash: OK (" + stashCount + " entradas)");
  }
} catch (e) { err("Stash cleanup: " + e.message); }

// Paso 2: Worktree prune
try {
  execSync("git worktree prune", { cwd: REPO_ROOT, timeout: 5000, windowsHide: true });
  log("Worktree prune: OK");
} catch (e) { err("Worktree prune: " + e.message); }

// Paso 3: Settings validation
const settingsFiles = [
  path.join(REPO_ROOT, ".claude", "settings.json"),
  path.join(REPO_ROOT, ".claude", "settings.local.json")
];
for (const sf of settingsFiles) {
  try {
    if (fs.existsSync(sf)) {
      JSON.parse(fs.readFileSync(sf, "utf8"));
      log("Settings " + path.basename(sf) + ": valido");
    } else {
      log("Settings " + path.basename(sf) + ": no existe (OK si es local)");
    }
  } catch (e) {
    err("Settings " + path.basename(sf) + ": CORRUPTO — " + e.message);
  }
}

// Paso 4: State file sanitization
if (atomicWrite) {
  const jsonlFiles = [
    "sessions-history.jsonl", "scrum-health-history.jsonl", "ops-learnings.jsonl",
    "sprint-audit.jsonl", "delivery-gate-audit.jsonl"
  ];
  for (const f of jsonlFiles) {
    const fp = path.join(HOOKS_DIR, f);
    if (fs.existsSync(fp)) {
      const entries = atomicWrite.readJsonlSafe(fp);
      log("JSONL " + f + ": " + entries.length + " entradas validas");
    }
  }

  const jsonFiles = [
    "health-check-state.json", "agent-registry.json",
    "heartbeat-state.json", "agent-progress-state.json"
  ];
  for (const f of jsonFiles) {
    const fp = path.join(HOOKS_DIR, f);
    if (fs.existsSync(fp)) {
      atomicWrite.readJsonSafe(fp, {});
      log("JSON " + f + ": sanitizado");
    }
  }
} else {
  log("State sanitization: atomic-write no disponible (skip)");
}

// Paso 5: Temp file cleanup
if (atomicWrite) {
  const cleaned = atomicWrite.cleanStaleTempFiles(HOOKS_DIR, 60000);
  if (cleaned > 0) {
    log("Temp files: " + cleaned + " archivos .tmp-* eliminados");
    results.cleaned += cleaned;
  } else {
    log("Temp files: OK (sin stale)");
  }
} else {
  log("Temp cleanup: atomic-write no disponible (skip)");
}

// Paso 6: Circuit breaker reset
if (circuitBreaker) {
  circuitBreaker.reset();
  log("Circuit breaker: reseteado para nuevo sprint");
} else {
  log("Circuit breaker: no disponible (skip)");
}

// Paso 7: Recovery log rotation
const recoveryLog = path.join(HOOKS_DIR, "agent-recovery.jsonl");
try {
  if (fs.existsSync(recoveryLog)) {
    const content = fs.readFileSync(recoveryLog, "utf8");
    const lines = content.split("\n").filter(l => l.trim());
    if (lines.length > 500) {
      const archived = lines.slice(0, lines.length - 500).join("\n") + "\n";
      const kept = lines.slice(lines.length - 500).join("\n") + "\n";
      fs.appendFileSync(recoveryLog + ".archive", archived, "utf8");
      fs.writeFileSync(recoveryLog, kept, "utf8");
      log("Recovery log: archivadas " + (lines.length - 500) + " lineas (quedan 500)");
    } else {
      log("Recovery log: OK (" + lines.length + " lineas)");
    }
  }
} catch (e) { err("Recovery log rotation: " + e.message); }

// Output JSON para Start-Agente.ps1
const output = {
  ok: results.errors.length === 0,
  steps: results.steps,
  errors: results.errors,
  cleaned: results.cleaned
};

console.log(JSON.stringify(output));
