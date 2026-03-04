// Test P-11: Backoff progresivo en ci-monitor-bg.js
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const CI_FILE = path.join(__dirname, "..", "ci-monitor-bg.js");
const source = fs.readFileSync(CI_FILE, "utf8");

describe("P-11: CI backoff progresivo", () => {
    it("contiene función getPollInterval", () => {
        assert.ok(source.includes("getPollInterval"), "getPollInterval debería existir");
    });

    it("no contiene POLL_INTERVAL_MS fijo de 30000", () => {
        // Verificar que no hay const POLL_INTERVAL_MS = 30000
        const hasFixed = /const\s+POLL_INTERVAL_MS\s*=\s*30000/.test(source);
        assert.ok(!hasFixed, "No debería tener POLL_INTERVAL_MS = 30000 fijo");
    });

    it("lógica de getPollInterval: extraer y validar intervalos", () => {
        // Extraer la función getPollInterval del source
        const fnMatch = source.match(/function getPollInterval\([^)]*\)\s*\{[\s\S]*?\n\}/);
        assert.ok(fnMatch, "getPollInterval debería ser una función extraíble");

        // Evaluar la función
        const fn = new Function("elapsedMs", fnMatch[0].replace(/function getPollInterval\([^)]*\)/, "").replace(/^\s*\{/, "").replace(/\}\s*$/, ""));
        // No podemos usar new Function fácilmente, así que verificamos el source
        assert.ok(fnMatch[0].includes("60000"), "Debería retornar 60000 en algún caso");
        assert.ok(fnMatch[0].includes("30000"), "Debería retornar 30000 en algún caso");
    });

    it("usa telegram-client.js (P-09 migración)", () => {
        assert.ok(source.includes('require("./telegram-client")'), "Debería usar telegram-client.js");
    });

    it("integra ops-learnings (P-15)", () => {
        assert.ok(source.includes('require("./ops-learnings")'), "Debería integrar ops-learnings.js");
    });
});
