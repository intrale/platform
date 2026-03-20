#!/usr/bin/env node
// pre-launch-validation.js — Validación pre-lanzamiento de agentes (#SPR-044-fix)
// Ejecutado por Start-Agente.ps1 antes de lanzar. Detecta:
// - Agentes zombie (status=active pero PID muerto)
// - Sprint en estado inválido
// - Worktrees huérfanos
// Exit 0 = OK, Exit 1 = errores bloqueantes
"use strict";

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const PLAN_FILE = path.join(REPO_ROOT, "scripts", "sprint-plan.json");

function isPidAlive(pid) {
    if (!pid) return false;
    try {
        const out = execSync('tasklist /FI "PID eq ' + parseInt(pid, 10) + '" /NH', {
            timeout: 3000, windowsHide: true, encoding: "utf8"
        });
        return out.indexOf("No tasks") === -1 && out.indexOf("no hay tareas") === -1;
    } catch (e) { return false; }
}

function validate() {
    const errors = [];
    const warnings = [];

    // 1. Sprint plan existe
    if (!fs.existsSync(PLAN_FILE)) {
        errors.push("sprint-plan.json no encontrado");
        return { ok: false, errors, warnings };
    }

    let plan;
    try { plan = JSON.parse(fs.readFileSync(PLAN_FILE, "utf8")); } catch(e) {
        errors.push("sprint-plan.json no es JSON válido: " + e.message);
        return { ok: false, errors, warnings };
    }

    // 2. Sprint activo
    if (!plan.sprint_id) {
        errors.push("sprint-plan.json sin sprint_id");
    }

    // 3. Detectar agentes zombie
    const zombies = [];
    for (const ag of (plan.agentes || [])) {
        if (ag.status === "active" && ag._pid) {
            if (!isPidAlive(ag._pid)) {
                zombies.push({ issue: ag.issue, numero: ag.numero, pid: ag._pid, launched: ag._launched_at });
            }
        }
        // Agente "active" sin PID = probablemente plan corrupto
        if (ag.status === "active" && !ag._pid && ag._launched_at) {
            warnings.push("Agente " + ag.numero + " #" + ag.issue + ": status=active pero sin _pid (plan posiblemente corrupto)");
        }
    }

    if (zombies.length > 0) {
        warnings.push(zombies.length + " agente(s) zombie detectado(s):");
        zombies.forEach(z => {
            warnings.push("  Agente " + z.numero + " #" + z.issue + " PID " + z.pid + " (lanzado " + (z.launched || "?") + ") - MUERTO");
        });
    }

    // 4. Verificar worktrees huérfanos
    try {
        const wtOut = execSync("git worktree list", { cwd: REPO_ROOT, timeout: 5000, encoding: "utf8" });
        const lines = wtOut.trim().split("\n").filter(l => l.includes("agent/"));
        const planIssues = new Set([...(plan.agentes||[]), ...(plan._queue||[])].map(a => String(a.issue)));
        for (const line of lines) {
            const m = line.match(/agent\/(\d+)/);
            if (m && !planIssues.has(m[1])) {
                warnings.push("Worktree huérfano: " + line.trim().split(/\s+/)[0] + " (issue #" + m[1] + " no está en el plan)");
            }
        }
    } catch(e) {}

    return { ok: errors.length === 0, errors, warnings, zombies: zombies.length > 0 ? zombies : undefined };
}

// CLI mode
if (require.main === module) {
    const result = validate();
    console.log(JSON.stringify(result));
    process.exit(result.ok ? 0 : 1);
}

module.exports = { validate };
