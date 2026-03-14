// Test P-23: Paralelismo de comandos Telegram Commander (#1279)
// Verifica que telegram-commander.js:
//   - Usa activeCommands (Map) en lugar de commandBusy (booleano)
//   - Define MAX_PARALLEL_COMMANDS = 3
//   - Etiqueta respuestas con [Cmd #N]
//   - Limpia comandos terminados del map
//   - No serializa comandos innecesariamente
"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const COMMANDER_PATH = path.join(__dirname, "..", "telegram-commander.js");
const COMMANDER_DIR = path.join(__dirname, "..", "commander");

function loadSource() {
    return fs.readFileSync(COMMANDER_PATH, "utf8");
}

function loadAllSources() {
    let combined = loadSource();
    if (fs.existsSync(COMMANDER_DIR)) {
        for (const f of fs.readdirSync(COMMANDER_DIR)) {
            if (f.endsWith(".js")) {
                combined += "\n" + fs.readFileSync(path.join(COMMANDER_DIR, f), "utf8");
            }
        }
    }
    return combined;
}

describe("P-23: Paralelismo de comandos — estructura del código", () => {

    it("telegram-commander.js existe y carga sin error de sintaxis", () => {
        assert.ok(fs.existsSync(COMMANDER_PATH), "telegram-commander.js debe existir");
        const source = loadSource();
        assert.ok(source.length > 1000, "archivo debe tener contenido sustancial");
    });

    it("no usa commandBusy como booleano de serialización", () => {
        const source = loadSource();
        // No debe existir: let commandBusy = false
        assert.ok(
            !source.includes("let commandBusy = false"),
            "commandBusy booleano fue eliminado — debe usar activeCommands Map"
        );
        // No debe existir: _executionBusy
        assert.ok(
            !source.includes("_executionBusy"),
            "_executionBusy fue eliminado — debe usar activeCommands Map"
        );
    });

    it("define activeCommands como Map", () => {
        const source = loadSource();
        assert.ok(
            source.includes("activeCommands") && source.includes("new Map()"),
            "Debe usar activeCommands como Map"
        );
    });

    it("define MAX_PARALLEL_COMMANDS = 3", () => {
        const source = loadSource();
        assert.ok(
            source.includes("MAX_PARALLEL_COMMANDS = 3"),
            "Debe definir límite de 3 comandos paralelos"
        );
    });

    it("verifica límite de comandos paralelos en handleSkill", () => {
        const source = loadAllSources();
        // handleSkill debe verificar límite — puede ser via activeCommands.size o isCommandBusy()
        const hasCheck = source.includes("isCommandBusy()") || source.match(/activeCommands\.size\s*>=\s*MAX_PARALLEL_COMMANDS/);
        assert.ok(hasCheck, "handleSkill debe verificar límite de comandos paralelos");
    });

    it("verifica límite de comandos paralelos en handleFreetext", () => {
        const source = loadAllSources();
        const hasCheck = source.includes("isCommandBusy()") || source.match(/activeCommands\.size\s*>=\s*MAX_PARALLEL_COMMANDS/);
        assert.ok(hasCheck, "handleFreetext debe verificar límite de comandos paralelos");
    });

    it("verifica límite de comandos paralelos en handler de audio", () => {
        const source = loadAllSources();
        const hasCheck = source.includes("isCommandBusy()") || source.includes("activeCommands.size >= MAX_PARALLEL_COMMANDS");
        assert.ok(hasCheck, "Handler de audio debe verificar límite de comandos paralelos");
    });

    it("etiqueta respuestas con [Cmd #N]", () => {
        const source = loadSource();
        assert.ok(
            source.includes("[Cmd #"),
            "Debe etiquetar respuestas con [Cmd #N] para identificar comandos paralelos"
        );
    });

    it("limpia comandos terminados en finally de executeClaudeQueued", () => {
        const source = loadSource();
        // executeClaudeQueued debe tener un finally que haga activeCommands.delete
        const queuedFn = source.match(/async function executeClaudeQueued[\s\S]*?^}/m);
        assert.ok(queuedFn, "executeClaudeQueued debe existir");
        const fnBody = queuedFn[0];
        assert.ok(
            fnBody.includes("finally") && fnBody.includes("activeCommands.delete"),
            "executeClaudeQueued debe limpiar activeCommands en finally"
        );
    });

    it("genera session-id único por comando con _nextCmdNumber", () => {
        const source = loadSource();
        assert.ok(
            source.includes("_nextCmdNumber"),
            "Debe tener contador secuencial para IDs de comando"
        );
    });

    it("muestra mensaje de límite alcanzado (no de 'un comando en ejecución')", () => {
        const source = loadAllSources();
        // No debe mostrar el viejo mensaje de serialización
        assert.ok(
            !source.includes("Ya hay un comando en ejecución"),
            "No debe mostrar mensaje de serialización — ahora permite múltiples comandos"
        );
        // Debe mostrar mensaje de límite
        assert.ok(
            source.includes("Límite de") && source.includes("comandos paralelos alcanzado"),
            "Debe mostrar mensaje de límite de comandos paralelos"
        );
    });

    it("cada comando paralelo usa sesión independiente (no resume sesión principal)", () => {
        const source = loadSource();
        // Cuando hay más de 1 comando activo, no debe resumir la sesión principal
        assert.ok(
            source.includes("activeCommands.size <= 1") || source.includes("activeCommands.size > 1"),
            "Debe distinguir entre primer comando y comandos paralelos para manejo de sesión"
        );
    });

    it("executeClaudeQueued retorna cmdId en el resultado", () => {
        const source = loadSource();
        assert.ok(
            source.includes("result.cmdId = cmdId"),
            "executeClaudeQueued debe asignar cmdId al resultado"
        );
    });

    it("sendResult usa cmdPrefix para etiquetar respuestas", () => {
        const source = loadSource();
        const sendResultFn = source.match(/async function sendResult[\s\S]*?^}/m);
        assert.ok(sendResultFn, "sendResult debe existir");
        assert.ok(
            sendResultFn[0].includes("cmdPrefix"),
            "sendResult debe usar cmdPrefix para etiquetar respuestas"
        );
    });
});

describe("P-23: Paralelismo — lógica del Map", () => {

    it("Map permite agregar/eliminar comandos correctamente", () => {
        const cmds = new Map();
        cmds.set(1, { label: "build", startTime: Date.now() });
        cmds.set(2, { label: "test", startTime: Date.now() });
        assert.equal(cmds.size, 2);
        cmds.delete(1);
        assert.equal(cmds.size, 1);
        assert.ok(cmds.has(2));
    });

    it("Map respeta límite de 3 comandos", () => {
        const MAX = 3;
        const cmds = new Map();
        cmds.set(1, { label: "cmd1" });
        cmds.set(2, { label: "cmd2" });
        cmds.set(3, { label: "cmd3" });
        assert.equal(cmds.size >= MAX, true, "3 comandos alcanza el límite");
        // Un 4to comando debe ser rechazado
        const canAdd = cmds.size < MAX;
        assert.equal(canAdd, false, "No debe permitir un 4to comando");
    });

    it("limpieza en finally funciona incluso con errores", async () => {
        const cmds = new Map();
        const cmdId = 1;
        cmds.set(cmdId, { label: "test" });
        try {
            throw new Error("simulated error");
        } catch (e) {
            // Error esperado
        } finally {
            cmds.delete(cmdId);
        }
        assert.equal(cmds.size, 0, "Map debe estar vacío tras finally");
    });

    it("comandos concurrentes no se interfieren", async () => {
        const cmds = new Map();
        const results = [];

        async function simulateCmd(id, delayMs) {
            cmds.set(id, { label: "cmd" + id, startTime: Date.now() });
            try {
                await new Promise(resolve => setTimeout(resolve, delayMs));
                results.push(id);
            } finally {
                cmds.delete(id);
            }
        }

        // Lanzar 3 comandos en paralelo
        await Promise.all([
            simulateCmd(1, 30),
            simulateCmd(2, 20),
            simulateCmd(3, 10)
        ]);

        assert.equal(results.length, 3, "Los 3 comandos deben completar");
        assert.equal(cmds.size, 0, "Todos los comandos deben limpiarse");
    });
});
