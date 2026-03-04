// Test P-10: Eliminar token hardcodeado en Watch-Agentes.ps1
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const WA_FILE = path.join(__dirname, "..", "..", "..", "scripts", "Watch-Agentes.ps1");
const source = fs.readFileSync(WA_FILE, "utf8");

describe("P-10: Sin token hardcodeado en Watch-Agentes.ps1", () => {
    it("no contiene token de bot hardcodeado (pattern bot\\d{10}:)", () => {
        const hasToken = /bot\d{8,}:[A-Za-z0-9_-]{30,}/.test(source);
        assert.ok(!hasToken, "No debería contener token de bot hardcodeado");
    });

    it("no contiene chatId hardcodeado como variable directa", () => {
        // Verificar que no hay $ChatId = "numero" directo
        const hasHardcodedChat = /\$(?:ChatId|CHAT_ID)\s*=\s*["']\d{5,}["']/.test(source);
        assert.ok(!hasHardcodedChat, "No debería contener chatId hardcodeado");
    });

    it("referencia telegram-config.json para obtener credenciales", () => {
        assert.ok(source.includes("telegram-config.json"), "Debería leer de telegram-config.json");
    });

    it("usa ConvertFrom-Json para parsear config", () => {
        assert.ok(source.includes("ConvertFrom-Json"), "Debería parsear JSON de config");
    });
});
