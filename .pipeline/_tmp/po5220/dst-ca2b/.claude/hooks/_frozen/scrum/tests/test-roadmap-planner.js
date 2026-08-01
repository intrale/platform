// test-roadmap-planner.js — Tests unitarios de roadmap-planner.js
// Issue #1435: verifica exportación de módulo, retorno esperado y propiedades del resultado
"use strict";

const path = require("path");
const assert = require("assert");

const HOOKS_DIR = path.join(__dirname, "..");
const { planRoadmap } = require(path.join(HOOKS_DIR, "roadmap-planner"));

let passed = 0;
let failed = 0;

function test(label, fn) {
    try {
        fn();
        console.log("  PASS: " + label);
        passed++;
    } catch (e) {
        console.log("  FAIL: " + label + " — " + e.message);
        failed++;
    }
}

console.log("=== roadmap-planner.js — tests unitarios ===\n");

// 1. Exporta planRoadmap como función
test("exporta planRoadmap como función", () => {
    assert.strictEqual(typeof planRoadmap, "function");
});

// 2. Con roadmap actual (7 sprints futuros), no dispara la distribución
test("no rellenar si sprints futuros >= 7", () => {
    const result = planRoadmap({ dryRun: true });
    assert.strictEqual(result.filled, 0, "filled debe ser 0");
    assert.strictEqual(result.skipped, 7, "skipped debe ser 7");
    assert.ok(typeof result.message === "string", "message debe ser string");
});

// 3. El resultado siempre tiene las 4 propiedades esperadas
test("resultado tiene propiedades filled, skipped, remaining, message", () => {
    const result = planRoadmap({ dryRun: true });
    assert.ok("filled"    in result, "falta 'filled'");
    assert.ok("skipped"   in result, "falta 'skipped'");
    assert.ok("remaining" in result, "falta 'remaining'");
    assert.ok("message"   in result, "falta 'message'");
});

// 4. dryRun: no modifica roadmap.json
test("dryRun: no modifica roadmap.json", () => {
    const fs = require("fs");
    const roadmapPath = path.join(__dirname, "../../../scripts/roadmap.json");
    const before = fs.readFileSync(roadmapPath, "utf8");
    planRoadmap({ dryRun: true });
    const after = fs.readFileSync(roadmapPath, "utf8");
    assert.strictEqual(before, after, "roadmap.json no debe modificarse en dry-run");
});

// 5. Idempotencia: dos llamadas con dryRun producen el mismo resultado
test("idempotente: dos llamadas producen el mismo mensaje", () => {
    const r1 = planRoadmap({ dryRun: true });
    const r2 = planRoadmap({ dryRun: true });
    assert.strictEqual(r1.message, r2.message, "mensajes deben coincidir");
    assert.strictEqual(r1.filled,  r2.filled,  "filled debe coincidir");
});

console.log("\n=== Resultado: " + passed + "/" + (passed + failed) + " tests OK ===");
if (failed > 0) {
    console.log("FALLARON " + failed + " tests");
    process.exit(1);
}
process.exit(0);
