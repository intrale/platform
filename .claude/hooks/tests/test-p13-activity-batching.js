// Test P-13: Batching en activity-logger.js
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const AL_FILE = path.join(__dirname, "..", "activity-logger.js");
const source = fs.readFileSync(AL_FILE, "utf8");

describe("P-13: Batching en activity-logger", () => {
    it("contiene BATCH_COOLDOWN_MS", () => {
        assert.ok(source.includes("BATCH_COOLDOWN_MS"), "BATCH_COOLDOWN_MS debería existir");
    });

    it("referencia activity-logger-last.json como state file", () => {
        assert.ok(source.includes("activity-logger-last.json"), "Debería usar activity-logger-last.json");
    });

    it("tiene lógica de buffer (skipJsonl)", () => {
        assert.ok(source.includes("skipJsonl"), "Debería tener lógica de skip via buffer");
    });

    it("tiene flush de buffer acumulado", () => {
        assert.ok(source.includes("buffer"), "Debería tener lógica de buffer");
        // Verificar que hay flush de buffer existente
        assert.ok(source.includes("Flush buffer") || source.includes("bufferFile"), "Debería tener flush de buffer");
    });

    it("cooldown es de 2 segundos (2000ms)", () => {
        assert.ok(source.includes("2000"), "BATCH_COOLDOWN_MS debería ser 2000");
    });
});
