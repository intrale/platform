// sprint-manager.js -- Gestion unificada del sprint: sincronizacion y reparacion
// Consolidacion de sprint-sync.js + auto-repair-sprint.js (#1511)
// Issue #1621: roadmap.json es fuente de verdad para composición de sprints
//
// Este modulo unifica la API publica de ambos scripts de gestion del sprint.
// Los archivos originales se mantienen como implementacion interna.
//
// Uso CLI:
//   node sprint-manager.js sync [--force]
//   node sprint-manager.js repair [--auto]
//
// Uso como modulo:
//   const { runSync, syncRoadmapOnly, getSprintComposition, runAutoRepair } = require("./sprint-manager");

"use strict";

const syncModule = require("./sprint-sync");
const repairModule = require("./auto-repair-sprint");

// CLI unificado
if (require.main === module) {
    const args = process.argv.slice(2);
    const cmd = args[0] || "";
    if (cmd === "sync" || cmd === "sincronizar") {
        syncModule.runSync({ force: args.includes("--force"), silent: false }).then(r => {
            if (r.skipped) { console.log("Omitido: " + (r.reason || "throttle")); process.exit(0); }
            if (!r.ok) { console.error("Error:", r.error); process.exit(1); }
            if (r.changes && r.changes.length > 0) r.changes.forEach(c => console.log("  " + c));
            else console.log("Sin desincronizaciones.");
            process.exit(0);
        }).catch(e => { console.error(e.message); process.exit(1); });
    } else if (cmd === "repair" || cmd === "reparar") {
        const { runHealthCheck } = require("./health-check-sprint");
        runHealthCheck().then(d => repairModule.runAutoRepair(d, { dryRun: !args.includes("--auto") }))
            .then(r => { console.log(JSON.stringify(r, null, 2)); process.exit(r.ok ? 0 : 1); })
            .catch(e => { console.error(JSON.stringify({ ok: false, error: e.message })); process.exit(1); });
    } else {
        console.log("Uso: node sprint-manager.js <sync|repair> [--force|--auto]");
    }
}

module.exports = {
    runSync: syncModule.runSync,
    syncRoadmapOnly: syncModule.syncRoadmapOnly,
    archiveSprintMetrics: syncModule.archiveSprintMetrics,
    getSprintComposition: syncModule.getSprintComposition,
    reconcileComposition: syncModule.reconcileComposition,
    runAutoRepair: repairModule.runAutoRepair,
    readAuditHistory: repairModule.readAuditHistory
};
