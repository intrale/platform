#!/usr/bin/env node
// pre-flight.js — Verificacion de entorno pre-Claude (reemplaza parte mecanica de /ops)
// Ejecuta ops-check.js y emite transicion "Ops" al dashboard.
// Exit 0 = OK, Exit 1 = errores criticos (abortar agente)

const path = require("path");
const { emitTransition, emitSkillInvoked, emitGateResult, REPO_ROOT } = require("./emit-transition");

const OPS_CHECK_PATH = path.join(REPO_ROOT, ".claude", "hooks", "ops-check.js");

function main() {
    const prevRole = process.argv[2] || "Claude";

    // Emitir transicion al dashboard
    emitTransition(prevRole, "Ops");
    emitSkillInvoked("ops");

    console.log("[pre-flight] Verificando entorno operativo...");

    let opsCheck;
    try {
        opsCheck = require(OPS_CHECK_PATH);
    } catch (e) {
        console.error("[pre-flight] No se pudo cargar ops-check.js:", e.message);
        emitGateResult("pre-flight", "fail", { error: "ops-check.js not found" });
        process.exit(1);
    }

    const result = opsCheck.runAll({ fix: false });

    // Mostrar resumen
    const s = result.summary;
    if (s.errors > 0) {
        console.log("[pre-flight] " + s.errors + " error(es), " + s.warnings + " warning(s)");
    } else if (s.warnings > 0) {
        console.log("[pre-flight] OK con " + s.warnings + " warning(s)");
    } else {
        console.log("[pre-flight] Entorno saludable");
    }

    // Detallar errores y warnings
    for (const [section, check] of Object.entries(result.results)) {
        if (!check || !check.items) continue;
        for (const item of check.items) {
            if (item.status === "error") {
                console.log("  [ERROR] " + item.label + ": " + (item.detail || ""));
            } else if (item.status === "warning") {
                console.log("  [WARN]  " + item.label + ": " + (item.detail || ""));
            }
        }
    }

    // Guardar resultado
    emitGateResult("pre-flight", s.critical ? "fail" : "pass", {
        errors: s.errors,
        warnings: s.warnings,
        sections: Object.keys(result.results),
    });

    // Solo abortar en errores criticos (JAVA_HOME, git, node)
    if (s.critical) {
        console.error("[pre-flight] CRITICO: entorno no apto para ejecucion");
        process.exit(1);
    }

    console.log("[pre-flight] OK");
    process.exit(0);
}

main();
