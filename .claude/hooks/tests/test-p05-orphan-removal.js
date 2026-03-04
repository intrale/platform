// Test P-05: Eliminación de orphan detection interval de 3s
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const COMMANDER_FILE = path.join(__dirname, "..", "telegram-commander.js");
const source = fs.readFileSync(COMMANDER_FILE, "utf8");

describe("P-05: Orphan interval eliminado", () => {
    it("no contiene PQ_ORPHAN_CHECK_MS", () => {
        assert.ok(!source.includes("PQ_ORPHAN_CHECK_MS"), "PQ_ORPHAN_CHECK_MS debería estar eliminado");
    });

    it("no contiene _pqOrphanInterval como variable activa", () => {
        // Permitir comentarios pero no declaraciones activas
        const lines = source.split("\n").filter(l => !l.trim().startsWith("//") && !l.trim().startsWith("*"));
        const hasActive = lines.some(l => l.includes("_pqOrphanInterval") && !l.includes("// P-05"));
        assert.ok(!hasActive, "_pqOrphanInterval no debería existir como variable activa");
    });

    it("no contiene startOrphanDetection como función", () => {
        assert.ok(!source.includes("function startOrphanDetection"), "startOrphanDetection debería estar eliminado");
    });

    it("checkOrphanedApprovers se llama desde onPendingQuestionsChange", () => {
        // Buscar que checkOrphanedApprovers aparezca dentro de onPendingQuestionsChange
        const fnMatch = source.match(/function onPendingQuestionsChange[\s\S]*?^}/m);
        assert.ok(fnMatch, "onPendingQuestionsChange debería existir");
        assert.ok(fnMatch[0].includes("checkOrphanedApprovers"), "checkOrphanedApprovers debería llamarse desde onPendingQuestionsChange");
    });
});
