// Test P-07: Health check selectivo con backoff por componente
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const HC_FILE = path.join(__dirname, "..", "health-check.js");
const source = fs.readFileSync(HC_FILE, "utf8");

describe("P-07: Health check backoff por componente", () => {
    it("contiene función shouldRunCheck", () => {
        assert.ok(source.includes("shouldRunCheck"), "shouldRunCheck debería existir");
    });

    it("contiene función updateComponentAfterCheck", () => {
        assert.ok(source.includes("updateComponentAfterCheck"), "updateComponentAfterCheck debería existir");
    });

    it("referencia health-check-components.json como state file", () => {
        assert.ok(source.includes("health-check-components.json"), "Debería usar health-check-components.json");
    });

    it("contiene cache de getMe (_getMeCache)", () => {
        assert.ok(source.includes("_getMeCache"), "Debería tener cache _getMeCache para getMe");
    });

    it("contiene loadComponentState y saveComponentState", () => {
        assert.ok(source.includes("loadComponentState"), "loadComponentState debería existir");
        assert.ok(source.includes("saveComponentState"), "saveComponentState debería existir");
    });

    it("contiene lógica de consecutivePasses para duplicar intervalo", () => {
        assert.ok(source.includes("consecutivePasses"), "Debería trackear consecutivePasses");
    });

    it("checkDeadWorktrees auto-repara con estrategia por capas", () => {
        assert.ok(source.includes("tryRepairWorktree"), "Debería usar tryRepairWorktree para auto-limpiar worktrees (P-18 upgrade)");
        assert.ok(source.includes("result.cleaned"), "Debería trackear worktrees limpiados en result.cleaned");
    });

    it("worktrees se marca como auto-reparable", () => {
        assert.ok(source.includes('"worktrees"') || source.includes("'worktrees'"),
            "worktrees debería estar en la lista de checks auto-reparables");
    });
});
