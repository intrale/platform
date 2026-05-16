// scrum-validator.js -- Validacion y correccion unificada del backlog Intrale
// Consolidacion de scrum-consistency-check.js + scrum-auto-corrections.js (#1511)
//
// Este modulo unifica la API publica de ambos scripts de validacion scrum.
// Los archivos originales se mantienen como implementacion interna.
//
// Uso CLI:
//   node scrum-validator.js consistency [--report] [--alert] [--json]
//   node scrum-validator.js corrections [--auto] [--report]
//
// Uso como modulo:
//   const { runConsistencyCheck, runAutoCorrections } = require("./scrum-validator");

"use strict";

const consistency = require("./scrum-consistency-check");
const corrections = require("./scrum-auto-corrections");

// CLI unificado
if (require.main === module) {
    const args = process.argv.slice(2);
    const cmd = args[0] || "";
    if (cmd === "consistency" || cmd === "consistencia") {
        consistency.runConsistencyCheck({
            generateReport: args.includes("--report"),
            sendAlert: args.includes("--alert")
        }).then(r => {
            if (args.includes("--json")) console.log(JSON.stringify(r, null, 2));
            else {
                const s = r.summary || {};
                console.log("Scrum Consistency Check -- " + r.timestamp);
                console.log("Issues: " + (s.totalIssues || 0) + " | Dup: " + (r.duplicates ? r.duplicates.length : 0));
                console.log("Contenidas: " + (r.contained ? r.contained.length : 0) + " | Estado: " + (s.health || "?"));
                if (r.error) console.error("Error:", r.error);
            }
        }).catch(e => { console.error("Error:", e.message); process.exit(1); });
    } else if (cmd === "corrections" || cmd === "correcciones") {
        corrections.runAutoCorrections({
            dryRun: !args.includes("--auto"),
            generateReport: args.includes("--report")
        }).then(r => {
            if (r.ok) console.log(corrections.formatAuditSection(r));
            else { console.error("Error:", r.error); process.exit(1); }
        }).catch(e => { console.error("Error:", e.message); process.exit(1); });
    } else {
        console.log("Uso: node scrum-validator.js <consistency|corrections> [opciones]");
        console.log("  --report --alert --json --auto");
    }
}

module.exports = {
    runConsistencyCheck: consistency.runConsistencyCheck,
    detectDuplicates: consistency.detectDuplicates,
    detectContainedStories: consistency.detectContainedStories,
    computeSimilarity: consistency.computeSimilarity,
    extractAcceptanceCriteria: consistency.extractAcceptanceCriteria,
    jaccardSimilarity: consistency.jaccardSimilarity,
    tokenize: consistency.tokenize,
    generateRecommendations: consistency.generateRecommendations,
    DUPLICATE_THRESHOLD: consistency.DUPLICATE_THRESHOLD,
    CONTAINED_THRESHOLD: consistency.CONTAINED_THRESHOLD,
    runAutoCorrections: corrections.runAutoCorrections,
    formatAuditSection: corrections.formatAuditSection,
    evaluateCoherenceRules: corrections.evaluateCoherenceRules,
    COHERENCE_RULES: corrections.COHERENCE_RULES,
    BACKLOG_COLUMNS: corrections.BACKLOG_COLUMNS,
    isBacklogColumn: corrections.isBacklogColumn
};