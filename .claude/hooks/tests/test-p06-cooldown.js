// Test P-06: Cooldown 60s en commander-launcher.js
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");

const LAUNCHER_FILE = path.join(__dirname, "..", "commander-launcher.js");
const source = fs.readFileSync(LAUNCHER_FILE, "utf8");

describe("P-06: Cooldown 60s en launcher", () => {
    it("contiene LAUNCHER_COOLDOWN_MS de 60000", () => {
        assert.ok(source.includes("LAUNCHER_COOLDOWN_MS"), "Debería definir LAUNCHER_COOLDOWN_MS");
        assert.ok(source.includes("60000"), "Cooldown debería ser 60000ms");
    });

    it("contiene LAUNCHER_COOLDOWN_FILE referenciando launcher-last-check.json", () => {
        assert.ok(source.includes("launcher-last-check.json"), "Debería usar launcher-last-check.json");
    });

    it("contiene función isLauncherCooldownActive", () => {
        assert.ok(source.includes("isLauncherCooldownActive"), "isLauncherCooldownActive debería existir");
    });

    it("contiene función updateLauncherCooldown", () => {
        assert.ok(source.includes("updateLauncherCooldown"), "updateLauncherCooldown debería existir");
    });

    it("main() verifica cooldown antes de ejecutar", () => {
        // Verificar que main() llama a isLauncherCooldownActive al inicio
        const mainMatch = source.match(/function main\(\)[\s\S]*?^\}/m);
        assert.ok(mainMatch, "main() debería existir");
        assert.ok(mainMatch[0].includes("isLauncherCooldownActive"), "main() debería verificar cooldown");
    });

    it("lógica de cooldown: lee timestamp y compara con LAUNCHER_COOLDOWN_MS", () => {
        const fnMatch = source.match(/function isLauncherCooldownActive[\s\S]*?^\}/m);
        assert.ok(fnMatch, "isLauncherCooldownActive debería existir como función");
        assert.ok(fnMatch[0].includes("Date.now()") || fnMatch[0].includes("LAUNCHER_COOLDOWN_MS"),
            "Debería comparar timestamp con cooldown");
    });
});
