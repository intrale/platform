// Test P-03: ask-next-sprint.js sin getUpdates directo
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const ASK_FILE = path.join(__dirname, "..", "..", "..", "scripts", "ask-next-sprint.js");
const source = fs.readFileSync(ASK_FILE, "utf8");

describe("P-03: ask-next-sprint sin getUpdates", () => {
    it("no llama a getUpdates como API (eliminado para evitar 409)", () => {
        // Puede tener "getUpdates" en comentarios explicativos, pero no como llamada real
        const codeLines = source.split("\n").filter(l => {
            const trimmed = l.trim();
            return !trimmed.startsWith("//") && !trimmed.startsWith("*") && !trimmed.startsWith("/*");
        });
        const codeOnly = codeLines.join("\n");
        assert.ok(!codeOnly.includes("getUpdates"), "No debería llamar a getUpdates en código activo");
    });

    it("no contiene loadOffset / saveOffset", () => {
        assert.ok(!source.includes("loadOffset"), "loadOffset debería estar eliminado");
        assert.ok(!source.includes("saveOffset"), "saveOffset debería estar eliminado");
    });

    it("no contiene pollForDecision", () => {
        assert.ok(!source.includes("pollForDecision"), "pollForDecision debería estar eliminado");
    });

    it("usa pending-questions para comunicarse con Commander", () => {
        assert.ok(source.includes("pending-questions") || source.includes("addPendingQuestion"),
            "Debería usar pending-questions");
    });

    it("usa telegram-client.js para enviar mensajes", () => {
        assert.ok(source.includes("telegram-client"), "Debería usar telegram-client.js");
    });

    it("usa fs.watch o polling sobre pending-questions.json", () => {
        assert.ok(source.includes("fs.watch") || source.includes("watchFile"),
            "Debería observar cambios en pending-questions.json");
    });
});
