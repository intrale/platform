#!/usr/bin/env node
// update-project-board.js — Sincronizar Project V2 con sprint-plan.json
//
// Uso: node update-project-board.js [--dry-run]
//
// Comportamiento:
//   - Lee scripts/sprint-plan.json
//   - Para cada issue en agentes[]: mueve a "In Progress" en Project V2
//   - Para cada issue en _queue[]: deja en su columna actual (no mueve)
//   - Para cada issue en _completed[]: mueve a "Done" en Project V2
//   - Issues del sprint anterior que ya no están en ninguna sección: vuelven a backlog
//
// Invocar desde Start-Agente.ps1 después de lanzar agentes.

"use strict";

const fs = require("fs");
const path = require("path");

const REPO_ROOT = path.resolve(__dirname, "..");
const HOOKS_DIR = path.join(REPO_ROOT, ".claude", "hooks");
const PLAN_FILE = path.join(REPO_ROOT, "scripts", "sprint-plan.json");
const DRY_RUN = process.argv.includes("--dry-run");

// Cargar project-utils
const utils = require(path.join(HOOKS_DIR, "project-utils.js"));

function log(msg) {
    console.log("[update-project-board] " + msg);
}

async function main() {
    if (!fs.existsSync(PLAN_FILE)) {
        log("SKIP: sprint-plan.json no existe en " + PLAN_FILE);
        process.exit(0);
    }

    let plan;
    try {
        plan = JSON.parse(fs.readFileSync(PLAN_FILE, "utf8"));
    } catch (e) {
        log("ERROR leyendo sprint-plan.json: " + e.message);
        process.exit(1);
    }

    const agentes = Array.isArray(plan.agentes) ? plan.agentes : [];
    const completed = Array.isArray(plan._completed) ? plan._completed : [];
    // _queue: no se mueven — permanecen en su columna actual hasta ser promovidos

    if (agentes.length === 0 && completed.length === 0) {
        log("SKIP: No hay issues que sincronizar (agentes y _completed vacíos)");
        process.exit(0);
    }

    let token;
    try {
        token = utils.getGitHubToken();
    } catch (e) {
        log("ERROR obteniendo token GitHub: " + e.message);
        process.exit(1);
    }

    const inProgressId = utils.STATUS_OPTIONS["In Progress"];
    const doneId = utils.STATUS_OPTIONS["Done"];

    const results = { inProgress: [], done: [], errors: [] };

    // Mover agentes activos → In Progress
    for (const ag of agentes) {
        const issue = ag.issue;
        if (!issue) continue;
        log(`Moviendo #${issue} (${ag.slug || ""}) → In Progress${DRY_RUN ? " [DRY-RUN]" : ""}`);
        if (!DRY_RUN) {
            try {
                const itemId = await utils.addAndSetStatus(token, issue, inProgressId);
                results.inProgress.push({ issue, itemId });
                log(`  OK: item ${itemId}`);
            } catch (e) {
                log(`  ERROR: ${e.message}`);
                results.errors.push({ issue, action: "In Progress", error: e.message });
            }
        } else {
            results.inProgress.push({ issue, dry: true });
        }
    }

    // Mover completados → Done
    for (const ag of completed) {
        const issue = ag.issue;
        if (!issue) continue;
        log(`Moviendo #${issue} (${ag.slug || ""}) → Done${DRY_RUN ? " [DRY-RUN]" : ""}`);
        if (!DRY_RUN) {
            try {
                const itemId = await utils.addAndSetStatus(token, issue, doneId);
                results.done.push({ issue, itemId });
                log(`  OK: item ${itemId}`);
            } catch (e) {
                log(`  ERROR: ${e.message}`);
                results.errors.push({ issue, action: "Done", error: e.message });
            }
        } else {
            results.done.push({ issue, dry: true });
        }
    }

    const summary = {
        sprint_id: plan.sprint_id || "desconocido",
        dry_run: DRY_RUN,
        inProgress: results.inProgress.length,
        done: results.done.length,
        errors: results.errors.length,
        details: results
    };

    console.log(JSON.stringify(summary, null, 2));

    if (results.errors.length > 0) {
        log(`WARN: ${results.errors.length} errores al sincronizar. Ver detalles arriba.`);
        process.exit(1);
    }
    log("Sincronización completa.");
    process.exit(0);
}

main().catch(e => {
    console.error("[update-project-board] FATAL: " + e.message);
    process.exit(1);
});
