// Test P-12: Polling adaptativo en permission-approver.js
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const PA_FILE = path.join(__dirname, "..", "permission-approver.js");
const source = fs.readFileSync(PA_FILE, "utf8");

describe("P-12: Polling adaptativo en permission-approver", () => {
    it("contiene función getAdaptivePollMs", () => {
        assert.ok(source.includes("getAdaptivePollMs"), "getAdaptivePollMs debería existir");
    });

    it("usa fs.watch para detectar cambios en PQ file", () => {
        assert.ok(source.includes("fs.watch"), "Debería usar fs.watch");
    });

    it("tiene intervalos adaptativos (150, 500, 1000)", () => {
        assert.ok(source.includes("150"), "Debería tener intervalo de 150ms");
        assert.ok(source.includes("500"), "Debería tener intervalo de 500ms");
        assert.ok(source.includes("1000"), "Debería tener intervalo de 1000ms");
    });

    it("integra ops-learnings (P-15) para timeout de aprobación", () => {
        assert.ok(source.includes('require("./ops-learnings")'), "Debería integrar ops-learnings.js");
    });

    it("registra timeout de aprobación en ops-learnings", () => {
        assert.ok(source.includes("approval_timeout"), "Debería registrar categoría approval_timeout");
    });
});
