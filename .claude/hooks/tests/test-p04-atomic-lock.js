// Test P-04: Lock atómico en commander-launcher.js
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const LAUNCHER_FILE = path.join(__dirname, "..", "commander-launcher.js");
const source = fs.readFileSync(LAUNCHER_FILE, "utf8");

describe("P-04: Lock atómico en commander-launcher", () => {
    it("usa fs.openSync con flag wx para exclusión mutua", () => {
        assert.ok(source.includes('"wx"') || source.includes("'wx'"), "Debería usar flag 'wx' para atomic create");
    });

    it("maneja EEXIST como señal de lock existente", () => {
        assert.ok(source.includes("EEXIST"), "Debería manejar error EEXIST");
    });

    it("tiene stale detection para flags viejos (>30s)", () => {
        assert.ok(source.includes("LAUNCHING_STALE_MS"), "Debería tener LAUNCHING_STALE_MS");
        assert.ok(source.includes("30000"), "Stale debería ser 30000ms (30s)");
    });

    it("acquireLaunchingFlag retorna boolean", () => {
        // Verificar que la función retorna true/false
        assert.ok(source.includes("return true"), "Debería retornar true al adquirir");
        assert.ok(source.includes("return false"), "Debería retornar false si ya existe");
    });

    it("escribe PID y timestamp en el flag file", () => {
        assert.ok(source.includes("process.pid"), "Debería escribir PID");
        assert.ok(source.includes("Date.now()"), "Debería escribir timestamp");
    });

    it("no usa el patrón viejo de writeFileSync + reread", () => {
        // El patrón viejo era: writeFileSync → sleep → readFileSync → comparar
        // El nuevo usa openSync('wx') directamente
        const fnMatch = source.match(/function acquireLaunchingFlag[\s\S]*?^\}/m);
        assert.ok(fnMatch, "acquireLaunchingFlag debería existir");
        // No debería tener setTimeout/sleep dentro de acquireLaunchingFlag
        assert.ok(!fnMatch[0].includes("setTimeout"), "No debería usar setTimeout dentro de acquire");
    });

    it("integra ops-learnings (P-15)", () => {
        assert.ok(source.includes('require("./ops-learnings")'), "Debería integrar ops-learnings");
    });
});
